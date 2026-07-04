import { supabase } from "./supabaseClient.js";

function requireCloudClient() {
  if (!supabase) throw new Error("云端未配置，当前使用本地模式");
  return supabase;
}

export async function getCurrentUser() {
  if (!supabase) return null;
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user || null;
}

// 只读本地会话（getSession 不发起网络请求验证 token），用于高频的 freshness 轮询场景。
// iOS PWA 从后台恢复的瞬间调用 auth.getUser() 的网络请求经常还没就绪就失败，
// 这里用更轻量的本地会话判断代替，减少这类检查对网络状态的依赖。
export async function getCurrentUserFromSession() {
  if (!supabase) return null;
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  return sessionData.session?.user || null;
}

export async function ensureProfile(profile = {}) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");

  const payload = {
    id: user.id,
    display_name: profile.displayName ?? user.user_metadata?.display_name ?? null,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await client
    .from("profiles")
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listCloudLibraries() {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await client
    .from("libraries")
    .select("id, owner_id, name, description, visibility, created_at, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function uploadLibrarySkeleton(library) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");
  if (!library || !String(library.name || "").trim()) throw new Error("词库名称不能为空");

  const payload = {
    owner_id: user.id,
    name: String(library.name).trim(),
    description: library.description || null,
    visibility: "private"
  };
  const { data, error } = await client.from("libraries").insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function downloadLibrarySkeleton(libraryId) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");
  const { data, error } = await client
    .from("libraries")
    .select("id, owner_id, name, description, visibility, created_at, updated_at")
    .eq("id", libraryId)
    .single();
  if (error) throw error;
  return data;
}

const CLOUD_BATCH_SIZE = 200;

function chunkRows(rows, size = CLOUD_BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function uniqueIds(ids) {
  return Array.from(new Set((ids || []).filter(Boolean).map(String)));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveDayOrNull(value) {
  const number = numberOrNull(value);
  return number != null && number > 0 ? number : null;
}

function booleanOrNull(value) {
  return value === null || value === undefined ? null : Boolean(value);
}

// Fix S3：上传批次标记，用于检测"这批数据是否完整跑完"，而不是简单地认为
// 只要 sessions 表有记录就是完整的。真正的跨表事务需要 Postgres RPC 函数改动量较大，
// 这里用轻量的"开始置 false，核心步骤全部成功后置 true"来做完整性检测+自愈。
function generateUploadBatchId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
    const random = Math.random() * 16 | 0;
    const value = char === "x" ? random : (random & 0x3 | 0x8);
    return value.toString(16);
  });
}

function validTimestamp(value, fallback = null) {
  if (!value) return fallback;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

function recordSourceLocalId(record) {
  if (record?.recordId) return String(record.recordId);
  return "day:" + String(record?.dayNumber ?? "unknown");
}

function addFailure(result, count, context, error) {
  const amount = Math.max(1, Number(count || 1));
  result.failed += amount;
  const message = error?.message || String(error || "未知错误");
  result.failureReasons.push(context + "：" + message);
}

function mapRecordWordIds(record, wordIdMap) {
  const keys = [
    "taskWordIds",
    "newWordIds",
    "pendingWrongWordIds",
    "delayedReviewWordIds",
    "wrongReviewWordIds",
    "reviewWordIds",
    "wrongWordIds"
  ];
  const mapped = {};
  const missing = new Set();
  keys.forEach(key => {
    mapped[key] = [];
    uniqueIds(record?.[key]).forEach(localWordId => {
      const cloudWordId = wordIdMap.get(localWordId);
      if (cloudWordId) mapped[key].push(cloudWordId);
      else missing.add(localWordId);
    });
  });
  mapped.reviewWordIds = uniqueIds([
    ...mapped.reviewWordIds,
    ...mapped.delayedReviewWordIds,
    ...mapped.wrongReviewWordIds
  ]);
  return { mapped, missing: Array.from(missing) };
}

async function upsertRows(client, table, rows, onConflict, selectColumns = "") {
  const returnedRows = [];
  for (const batch of chunkRows(rows)) {
    let query = client.from(table).upsert(batch, { onConflict });
    if (selectColumns) query = query.select(selectColumns);
    const { data, error } = await query;
    if (error) throw error;
    if (Array.isArray(data)) returnedRows.push(...data);
  }
  return returnedRows;
}

export async function uploadLocalDataToCloud(localData) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");
  if (!localData || !Array.isArray(localData.libraries)) {
    throw new Error("没有读取到有效的本地听写数据");
  }

  const result = {
    libraries: 0,
    words: 0,
    sessions: 0,
    progress: 0,
    failed: 0,
    blockedOlderData: false,
    failureReasons: []
  };

  try {
    await ensureProfile();
  } catch (error) {
    addFailure(result, 1, "用户资料", error);
  }

  for (const library of localData.libraries) {
    const localLibraryId = String(library.libraryId || "").trim();
    if (!localLibraryId) {
      addFailure(result, 1, "词库", new Error("缺少本地 libraryId"));
      continue;
    }

    let cloudLibrary;
    try {
      const { data: existingLibraries, error: existingLibraryError } = await client
        .from("libraries")
        .select("id")
        .eq("owner_id", user.id)
        .eq("source_local_id", localLibraryId)
        .limit(1);
      if (existingLibraryError) throw existingLibraryError;
      const existingCloudLibrary = existingLibraries?.[0];
      if (existingCloudLibrary) {
        const localRecords = Array.isArray(library.dailyRecords) ? library.dailyRecords : [];
        const localMaxDay = localRecords.length
          ? Math.max(...localRecords.map(record => Number(record.dayNumber || 0)))
          : 0;
        const existingCloudSessions = await fetchAllCloudRows(
          client,
          "dictation_sessions",
          "id,source_local_id,day_number",
          query => query
            .eq("user_id", user.id)
            .eq("library_id", existingCloudLibrary.id)
        );
        const cloudMaxDay = existingCloudSessions.length
          ? Math.max(...existingCloudSessions.map(session => Number(session.day_number || 0)))
          : 0;
        const localRecordByDay = new Map(
          localRecords.map(record => [Number(record.dayNumber || 0), recordSourceLocalId(record)])
        );
        const conflictingDay = existingCloudSessions.find(session => {
          const localSourceId = localRecordByDay.get(Number(session.day_number || 0));
          return localSourceId && session.source_local_id && localSourceId !== String(session.source_local_id);
        });
        const cloudSessionCount = existingCloudSessions.length;
        if (conflictingDay) {
          result.blockedOlderData = true;
          addFailure(
            result,
            1,
            "词库“" + (library.libraryName || localLibraryId) + "”",
            new Error("Day " + conflictingDay.day_number + " 的本机记录与云端记录来源不一致，已阻止覆盖")
          );
          continue;
        }
        if (cloudMaxDay > localMaxDay || cloudSessionCount > localRecords.length) {
          result.blockedOlderData = true;
          addFailure(
            result,
            1,
            "词库“" + (library.libraryName || localLibraryId) + "”",
            new Error(
              "本机记录较旧（本机最大 Day " + localMaxDay + "，云端最大 Day " + cloudMaxDay +
              "），已阻止旧数据覆盖云端"
            )
          );
          continue;
        }
      }
    } catch (error) {
      addFailure(result, 1, "上传前进度检查", error);
      continue;
    }

    const uploadBatchId = generateUploadBatchId();
    try {
      const { data, error } = await client
        .from("libraries")
        .upsert({
          owner_id: user.id,
          source_local_id: localLibraryId,
          name: String(library.libraryName || "未命名词库"),
          description: null,
          visibility: "private",
          upload_batch_id: uploadBatchId,
          upload_complete: false,
          updated_at: new Date().toISOString()
        }, { onConflict: "owner_id,source_local_id" })
        .select("id,source_local_id")
        .single();
      if (error) throw error;
      cloudLibrary = data;
      result.libraries += 1;
    } catch (error) {
      addFailure(result, 1, "词库“" + (library.libraryName || localLibraryId) + "”", error);
      continue;
    }

    try {
      const settings = library.settings || {};
      const { error } = await client.from("user_library_settings").upsert({
        user_id: user.id,
        library_id: cloudLibrary.id,
        daily_target_words: numberOrNull(settings.dailyTargetWords) ?? 30,
        daily_review_words: numberOrNull(settings.dailyReviewWords) ?? 30,
        review_delay_days: numberOrNull(settings.reviewDelayDays) ?? 15,
        pause_new_words: Boolean(settings.pauseNewWords),
        speech_rate: numberOrNull(settings.speechRate) ?? 0.9,
        speech_voice: settings.speechVoiceName || null,
        settings_json: settings,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,library_id" });
      if (error) throw error;
    } catch (error) {
      addFailure(result, 1, "词库设置“" + (library.libraryName || localLibraryId) + "”", error);
    }

    // Fix S3：从这里开始到 user_word_progress 写完为止的三步是本次上传批次的核心内容，
    // 记录写入前的失败计数，写完后对比，用来判断这批数据是否完整跑完。
    const coreStepsFailedBefore = result.failed;

    const localWords = Array.isArray(library.words) ? library.words : [];
    const wordRows = localWords.map((word, index) => ({
      library_id: cloudLibrary.id,
      source_local_id: String(word.id),
      original_no: numberOrNull(word.originalNo) ?? index + 1,
      entry_text: String(word.word || word.entryText || word.id || ""),
      meaning: word.meaning || null,
      sort_order: numberOrNull(word.index) ?? index,
      updated_at: new Date().toISOString()
    }));
    const wordIdMap = new Map();
    for (const batch of chunkRows(wordRows)) {
      try {
        const uploaded = await upsertRows(
          client,
          "words",
          batch,
          "library_id,source_local_id",
          "id,source_local_id"
        );
        uploaded.forEach(word => wordIdMap.set(String(word.source_local_id), word.id));
        result.words += batch.length;
      } catch (error) {
        addFailure(result, batch.length, "词库“" + (library.libraryName || localLibraryId) + "”的单词", error);
      }
    }

    const sessionRows = [];
    (library.dailyRecords || []).forEach(record => {
      const { mapped, missing } = mapRecordWordIds(record, wordIdMap);
      if (missing.length) {
        addFailure(
          result,
          1,
          "词库“" + (library.libraryName || localLibraryId) + "” Day " + record.dayNumber,
          new Error("找不到 " + missing.length + " 个单词的云端 ID")
        );
        return;
      }
      const totalCount = mapped.taskWordIds.length;
      const wrongCount = mapped.wrongWordIds.length;
      sessionRows.push({
        user_id: user.id,
        library_id: cloudLibrary.id,
        source_local_id: recordSourceLocalId(record),
        day_number: positiveDayOrNull(record.dayNumber) ?? 0,
        record_date: record.date || null,
        task_word_ids: mapped.taskWordIds,
        new_word_ids: mapped.newWordIds,
        pending_wrong_word_ids: mapped.pendingWrongWordIds,
        review_word_ids: mapped.reviewWordIds,
        wrong_word_ids: mapped.wrongWordIds,
        total_count: totalCount,
        wrong_count: wrongCount,
        accuracy: totalCount ? Math.round(((totalCount - wrongCount) / totalCount) * 10000) / 100 : null,
        created_at: validTimestamp(record.completedAt || record.createdAt, new Date().toISOString()),
        updated_at: new Date().toISOString()
      });
    });
    for (const batch of chunkRows(sessionRows)) {
      try {
        await upsertRows(client, "dictation_sessions", batch, "user_id,library_id,source_local_id");
        result.sessions += batch.length;
      } catch (error) {
        addFailure(result, batch.length, "词库“" + (library.libraryName || localLibraryId) + "”的听写记录", error);
      }
    }

    const progressRows = localWords.flatMap(word => {
      const cloudWordId = wordIdMap.get(String(word.id));
      if (!cloudWordId) return [];
      return [{
        user_id: user.id,
        library_id: cloudLibrary.id,
        word_id: cloudWordId,
        first_learn_day: positiveDayOrNull(word.firstLearnDay),
        wrong_count: numberOrNull(word.wrongCount) ?? 0,
        is_pending_wrong: Boolean(word.isPendingWrong),
        correct_streak: numberOrNull(word.correctStreakInWrongPool) ?? 0,
        wrong_review_due_day: positiveDayOrNull(word.wrongReviewDueDay ?? word.delayedReviewDay),
        wrong_review_stage: numberOrNull(word.wrongReviewStage) ?? 0,
        last_exited_wrong_pool_day: positiveDayOrNull(word.lastExitedWrongPoolDay),
        manual_focus: booleanOrNull(word.manualFocus),
        manual_stubborn: booleanOrNull(word.manualStubborn),
        updated_at: new Date().toISOString()
      }];
    });
    for (const batch of chunkRows(progressRows)) {
      try {
        await upsertRows(client, "user_word_progress", batch, "user_id,library_id,word_id");
        result.progress += batch.length;
      } catch (error) {
        addFailure(result, batch.length, "词库“" + (library.libraryName || localLibraryId) + "”的学习进度", error);
      }
    }

    // Fix S3：words/sessions/progress 三步核心写入全部无失败，才把这批标记为完整；
    // 只在 upload_batch_id 仍等于本次批次时才更新，避免覆盖一个更晚发起的上传批次的状态。
    if (result.failed === coreStepsFailedBefore) {
      try {
        const { error: markCompleteError } = await client
          .from("libraries")
          .update({ upload_complete: true, updated_at: new Date().toISOString() })
          .eq("id", cloudLibrary.id)
          .eq("upload_batch_id", uploadBatchId);
        if (markCompleteError) throw markCompleteError;
      } catch (error) {
        console.warn(
          "[cloudSync] 上传批次完整性标记写入失败（不影响本次已上传的数据，但下次检测可能误判为不完整）：",
          library.libraryName || localLibraryId, error?.message || error
        );
      }
    } else {
      console.warn(
        "[cloudSync] 词库“" + (library.libraryName || localLibraryId) + "”本次上传核心步骤（单词/听写记录/学习进度）" +
        "存在失败，upload_complete 保持 false，等待下次成功上传后自动补全：",
        result.failureReasons.slice(-3)
      );
    }

    // ── 安全清理云端本词库中已被本地删除的单词和听写记录 ──────────────────────────
    // 前置条件：本词库 upsert 已成功（cloudLibrary 存在），旧窗口保护已在上方通过，
    // 且本地旧窗口校验显示本机数据不旧于云端（才能走到这里）。
    if (cloudLibrary) {
      // 1. 清理已删除单词（只删有 source_local_id 的行，不触碰没有 source_local_id 的云端数据）
      try {
        const localWordSourceIds = new Set(localWords.map(w => String(w.id)));
        const cloudWordsAll = await fetchAllCloudRows(
          client, "words", "id,source_local_id",
          q => q.eq("library_id", cloudLibrary.id).not("source_local_id", "is", null)
        );
        const wordsToDelete = cloudWordsAll.filter(cw => !localWordSourceIds.has(String(cw.source_local_id)));
        if (wordsToDelete.length > 0) {
          const deleteWordIds = wordsToDelete.map(cw => cw.id);
          // 先删 user_word_progress（外键依赖）
          for (const batch of chunkRows(deleteWordIds)) {
            const { error: progDeleteError } = await client
              .from("user_word_progress")
              .delete()
              .eq("user_id", user.id)
              .eq("library_id", cloudLibrary.id)
              .in("word_id", batch);
            if (progDeleteError) throw progDeleteError;
          }
          // 再删 words
          for (const batch of chunkRows(deleteWordIds)) {
            const { error: wordDeleteError } = await client
              .from("words")
              .delete()
              .eq("library_id", cloudLibrary.id)
              .in("id", batch);
            if (wordDeleteError) throw wordDeleteError;
          }
          result.deletedWords = (result.deletedWords || 0) + wordsToDelete.length;
        }
      } catch (error) {
        addFailure(result, 1, "词库“" + (library.libraryName || localLibraryId) + "”的删除单词同步", error);
      }

      // 2. 清理已删除听写记录（只删有 source_local_id 的行）
      try {
        const localSessionSourceIds = new Set(
          (library.dailyRecords || []).map(r => recordSourceLocalId(r))
        );
        const cloudSessionsAll = await fetchAllCloudRows(
          client, "dictation_sessions", "id,source_local_id",
          q => q.eq("user_id", user.id).eq("library_id", cloudLibrary.id).not("source_local_id", "is", null)
        );
        const sessionsToDelete = cloudSessionsAll.filter(cs => !localSessionSourceIds.has(String(cs.source_local_id)));
        if (sessionsToDelete.length > 0) {
          const deleteSessionIds = sessionsToDelete.map(cs => cs.id);
          for (const batch of chunkRows(deleteSessionIds)) {
            const { error: sessionDeleteError } = await client
              .from("dictation_sessions")
              .delete()
              .eq("user_id", user.id)
              .in("id", batch);
            if (sessionDeleteError) throw sessionDeleteError;
          }
          result.deletedSessions = (result.deletedSessions || 0) + sessionsToDelete.length;
        }
      } catch (error) {
        addFailure(result, 1, "词库“" + (library.libraryName || localLibraryId) + "”的删除记录同步", error);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────────
  }

  // ── 安全清理云端本用户已被本地删除的词库 ─────────────────────────────────────────
  // 只清理有 source_local_id、且本地已不存在的词库行；不碰没有 source_local_id 的数据。
  // 只在旧窗口保护已全部通过（blockedOlderData === false）时才执行。
  if (!result.blockedOlderData) {
    try {
      const localLibrarySourceIds = new Set(
        localData.libraries.map(lib => String(lib.libraryId || "").trim()).filter(Boolean)
      );
      const cloudLibrariesAll = await fetchAllCloudRows(
        client, "libraries", "id,source_local_id",
        q => q.eq("owner_id", user.id).not("source_local_id", "is", null)
      );
      const librariesToDelete = cloudLibrariesAll.filter(
        cl => !localLibrarySourceIds.has(String(cl.source_local_id))
      );
      for (const cloudLib of librariesToDelete) {
        try {
          // 依次级联删除：进度 → 听写记录 → 单词 → 词库设置 → 词库
          const cloudLibWords = await fetchAllCloudRows(
            client, "words", "id",
            q => q.eq("library_id", cloudLib.id)
          );
          if (cloudLibWords.length > 0) {
            const allWordIds = cloudLibWords.map(w => w.id);
            for (const batch of chunkRows(allWordIds)) {
              await client.from("user_word_progress").delete()
                .eq("user_id", user.id).eq("library_id", cloudLib.id).in("word_id", batch);
            }
            for (const batch of chunkRows(allWordIds)) {
              await client.from("words").delete().eq("library_id", cloudLib.id).in("id", batch);
            }
          }
          await client.from("dictation_sessions").delete()
            .eq("user_id", user.id).eq("library_id", cloudLib.id);
          await client.from("user_library_settings").delete()
            .eq("user_id", user.id).eq("library_id", cloudLib.id);
          await client.from("libraries").delete()
            .eq("owner_id", user.id).eq("id", cloudLib.id);
          result.deletedLibraries = (result.deletedLibraries || 0) + 1;
        } catch (error) {
          addFailure(result, 1, "云端词库残留清理（id=" + cloudLib.id + "）", error);
        }
      }
    } catch (error) {
      addFailure(result, 1, "云端词库残留清理列表获取", error);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  return result;
}

async function getExactCount(query) {
  const { count, error } = await query;
  if (error) throw error;
  return Number(count || 0);
}

export async function getCloudDataSummary() {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");

  const { data: libraries, count: libraryCount, error: librariesError } = await client
    .from("libraries")
    .select("id", { count: "exact" })
    .eq("owner_id", user.id);
  if (librariesError) throw librariesError;
  const libraryIds = (libraries || []).map(library => library.id);

  const words = libraryIds.length
    ? await getExactCount(client.from("words").select("id", { count: "exact", head: true }).in("library_id", libraryIds))
    : 0;
  const sessions = await getExactCount(
    client.from("dictation_sessions").select("id", { count: "exact", head: true }).eq("user_id", user.id)
  );
  const progress = await getExactCount(
    client.from("user_word_progress").select("id", { count: "exact", head: true }).eq("user_id", user.id)
  );

  return {
    libraries: Number(libraryCount || 0),
    words,
    sessions,
    progress
  };
}

const CLOUD_PAGE_SIZE = 1000;

async function fetchAllCloudRows(client, table, columns, applyFilters) {
  const rows = [];
  let from = 0;
  while (true) {
    let query = client
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(from, from + CLOUD_PAGE_SIZE - 1);
    if (applyFilters) query = applyFilters(query);
    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < CLOUD_PAGE_SIZE) break;
    from += CLOUD_PAGE_SIZE;
  }
  return rows;
}

function datePart(value, fallback = null) {
  if (!value) return fallback;
  return String(value).slice(0, 10);
}

function cloudFallbackId(prefix, cloudId) {
  return prefix + "_cloud_" + String(cloudId).replaceAll("-", "");
}

function makeUniqueRestoredId(preferredId, usedIds, fallbackPrefix, cloudId) {
  const base = String(preferredId || cloudFallbackId(fallbackPrefix, cloudId));
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = base + "_" + suffix;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function makeRestoredSourceMap(record) {
  const sourceMap = {};
  const addSource = (ids, source) => {
    (ids || []).forEach(id => {
      sourceMap[id] = sourceMap[id] || [];
      if (!sourceMap[id].includes(source)) sourceMap[id].push(source);
    });
  };
  addSource(record.newWordIds, "new");
  addSource(record.pendingWrongWordIds, "wrong");
  addSource(record.delayedReviewWordIds, "review");
  return sourceMap;
}

function restoreCloudWordIds(cloudIds, cloudWordToLocalId) {
  const restored = [];
  const missing = [];
  uniqueIds(cloudIds).forEach(cloudWordId => {
    const localWordId = cloudWordToLocalId.get(cloudWordId);
    if (localWordId) restored.push(localWordId);
    else missing.push(cloudWordId);
  });
  return { restored: uniqueIds(restored), missing };
}

function restoredSettings(settingsRow) {
  if (!settingsRow) return {};
  const settings = {
    ...(settingsRow.settings_json && typeof settingsRow.settings_json === "object"
      ? settingsRow.settings_json
      : {})
  };
  if (settingsRow.daily_target_words != null) settings.dailyTargetWords = settingsRow.daily_target_words;
  if (settingsRow.daily_review_words != null) settings.dailyReviewWords = settingsRow.daily_review_words;
  if (settingsRow.review_delay_days != null) settings.reviewDelayDays = settingsRow.review_delay_days;
  if (settingsRow.pause_new_words != null) settings.pauseNewWords = settingsRow.pause_new_words;
  if (settingsRow.speech_rate != null) settings.speechRate = settingsRow.speech_rate;
  if (settingsRow.speech_voice != null) settings.speechVoiceName = settingsRow.speech_voice;
  return settings;
}

function restoreProgressOnWord(word, progress) {
  if (!progress) return;
  word.firstLearnDay = positiveDayOrNull(progress.first_learn_day);
  word.wrongCount = Number(progress.wrong_count || 0);
  word.isPendingWrong = Boolean(progress.is_pending_wrong);
  word.correctStreakInWrongPool = Number(progress.correct_streak || 0);
  word.wrongReviewDueDay = positiveDayOrNull(progress.wrong_review_due_day);
  word.delayedReviewDay = positiveDayOrNull(progress.wrong_review_due_day);
  word.wrongReviewStage = Number(progress.wrong_review_stage || 0);
  word.wrongReviewCompletedCount = Math.max(0, word.wrongReviewStage - 1);
  word.lastExitedWrongPoolDay = positiveDayOrNull(progress.last_exited_wrong_pool_day);
  word.delayedReviewCompleted = word.wrongReviewDueDay == null && !word.isPendingWrong && word.wrongCount > 0;
  word.manualFocus = booleanOrNull(progress.manual_focus);
  word.manualStubborn = booleanOrNull(progress.manual_stubborn);
  word.isFocus = word.manualFocus == null ? word.wrongCount >= 2 : word.manualFocus;
  word.isStubborn = word.manualStubborn == null ? word.wrongCount >= 3 : word.manualStubborn;
}

export async function downloadCloudDataForLocalStorage(appVersion = "1.0.0") {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");

  const result = {
    libraries: 0,
    words: 0,
    sessions: 0,
    progress: 0,
    skipped: 0,
    failed: 0,
    failureReasons: [],
    cloudCounts: null,
    restoredData: null
  };

  const cloudLibraries = await fetchAllCloudRows(
    client,
    "libraries",
    "id,source_local_id,name,description,visibility,upload_complete,created_at,updated_at",
    query => query.eq("owner_id", user.id)
  );
  if (!cloudLibraries.length) throw new Error("云端没有可恢复的词库，本地数据未被覆盖");

  // Fix S3：upload_complete === false 说明这个词库上一次上传中途失败/被打断过。
  // 不阻止本次下载（云端现有数据仍然是目前能拿到的最好数据），但要清楚地记录下来，
  // 方便用户/开发者判断"要不要回那台设备重新点一次上传"。
  const incompleteUploadLibraries = cloudLibraries.filter(library => library.upload_complete === false);
  if (incompleteUploadLibraries.length) {
    console.warn(
      "[cloudSync] 检测到以下词库的上一次云端上传未完整跑完（可能中途网络中断或应用被杀死）：",
      incompleteUploadLibraries.map(library => library.name || library.id)
    );
  }

  const cloudLibraryIds = cloudLibraries.map(library => library.id);
  const cloudWords = [];
  for (const cloudLibraryId of cloudLibraryIds) {
    cloudWords.push(...await fetchAllCloudRows(
      client,
      "words",
      "id,library_id,source_local_id,original_no,entry_text,meaning,sort_order,created_at,updated_at",
      query => query.eq("library_id", cloudLibraryId)
    ));
  }
  const cloudSettings = await fetchAllCloudRows(
    client,
    "user_library_settings",
    "id,user_id,library_id,daily_target_words,daily_review_words,review_delay_days,pause_new_words,speech_rate,speech_voice,settings_json,updated_at",
    query => query.eq("user_id", user.id)
  );
  const cloudSessions = await fetchAllCloudRows(
    client,
    "dictation_sessions",
    "id,user_id,library_id,source_local_id,day_number,record_date,task_word_ids,new_word_ids,pending_wrong_word_ids,review_word_ids,wrong_word_ids,total_count,wrong_count,accuracy,created_at,updated_at",
    query => query.eq("user_id", user.id)
  );
  const cloudProgress = await fetchAllCloudRows(
    client,
    "user_word_progress",
    "id,user_id,library_id,word_id,first_learn_day,wrong_count,is_pending_wrong,correct_streak,wrong_review_due_day,wrong_review_stage,last_exited_wrong_pool_day,manual_focus,manual_stubborn,created_at,updated_at",
    query => query.eq("user_id", user.id)
  );
  result.cloudCounts = {
    libraries: cloudLibraries.length,
    words: cloudWords.length,
    sessions: cloudSessions.length,
    maxDayNumber: cloudSessions.length
      ? Math.max(...cloudSessions.map(session => Number(session.day_number || 0)))
      : 0,
    progress: cloudProgress.length,
    firstLearnDayNonNullProgress: cloudProgress.filter(progress => progress.first_learn_day != null).length,
    firstLearnDayValidProgress: cloudProgress.filter(progress => positiveDayOrNull(progress.first_learn_day) != null).length,
    pendingWrongProgress: cloudProgress.filter(progress => progress.is_pending_wrong === true).length,
    userId: user.id,
    hasIncompleteUpload: incompleteUploadLibraries.length > 0,
    incompleteUploadLibraryNames: incompleteUploadLibraries.map(library => library.name || library.id)
  };
  const knownCloudWordIds = new Set(cloudWords.map(word => word.id));
  const derivedLearnedCloudWordIds = new Set();
  cloudProgress.forEach(progress => {
    if (positiveDayOrNull(progress.first_learn_day) != null && knownCloudWordIds.has(progress.word_id)) {
      derivedLearnedCloudWordIds.add(progress.word_id);
    }
  });
  cloudSessions.forEach(session => {
    uniqueIds(session.task_word_ids).forEach(wordId => {
      if (knownCloudWordIds.has(wordId)) derivedLearnedCloudWordIds.add(wordId);
    });
  });
  result.cloudCounts.derivedLearned = derivedLearnedCloudWordIds.size;

  const usedLibraryIds = new Set();
  const cloudLibraryToLocalId = new Map();
  cloudLibraries.forEach(library => {
    cloudLibraryToLocalId.set(
      library.id,
      makeUniqueRestoredId(library.source_local_id, usedLibraryIds, "lib", library.id)
    );
  });

  const cloudWordToLocalId = new Map();
  const localWordsByLibrary = new Map();
  cloudLibraries.forEach(library => localWordsByLibrary.set(library.id, []));
  cloudLibraries.forEach(library => {
    const usedWordIds = new Set();
    cloudWords
      .filter(word => word.library_id === library.id)
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .forEach((cloudWord, index) => {
        const localWordId = makeUniqueRestoredId(
          cloudWord.source_local_id,
          usedWordIds,
          "word",
          cloudWord.id
        );
        cloudWordToLocalId.set(cloudWord.id, localWordId);
        localWordsByLibrary.get(library.id).push({
          id: localWordId,
          word: String(cloudWord.entry_text || localWordId),
          meaning: cloudWord.meaning || "",
          index: numberOrNull(cloudWord.sort_order) ?? index,
          originalNo: numberOrNull(cloudWord.original_no) ?? index + 1,
          firstLearnDay: null,
          delayedReviewDay: null,
          delayedReviewCompleted: false,
          delayedReviewPostponed: false,
          wrongReviewDueDay: null,
          wrongReviewStage: 0,
          wrongReviewCompletedCount: 0,
          lastExitedWrongPoolDay: null,
          wrongCount: 0,
          lastWrongDay: null,
          lastWrongDate: null,
          isPendingWrong: false,
          correctStreakInWrongPool: 0,
          isFocus: false,
          isStubborn: false,
          manualFocus: null,
          manualStubborn: null
        });
      });
  });

  const progressByCloudWordId = new Map();
  cloudProgress.forEach(progress => {
    if (!cloudWordToLocalId.has(progress.word_id)) {
      result.skipped += 1;
      result.failed += 1;
      const reason = "学习进度引用了不存在的云端单词：" + progress.word_id;
      result.failureReasons.push(reason);
      // Fix S6：只跳过这一条坏的 progress 记录，不影响其余数据继续正常恢复；
      // 必须留下明确日志，避免以后再遇到类似问题只能靠人工推理代码定位。
      console.warn("[cloudSync] 已跳过一条学习进度记录（不影响其余数据恢复）：", reason);
      return;
    }
    progressByCloudWordId.set(progress.word_id, progress);
    result.progress += 1;
  });
  cloudWords.forEach(cloudWord => {
    const localWordId = cloudWordToLocalId.get(cloudWord.id);
    const localWord = (localWordsByLibrary.get(cloudWord.library_id) || [])
      .find(word => word.id === localWordId);
    if (localWord) restoreProgressOnWord(localWord, progressByCloudWordId.get(cloudWord.id));
  });

  const settingsByLibraryId = new Map(cloudSettings.map(settings => [settings.library_id, settings]));
  const sessionsByLibraryId = new Map();
  cloudLibraries.forEach(library => sessionsByLibraryId.set(library.id, []));
  // Fix S6：单条听写记录因为引用了缺失的词库/单词而无法还原时，只跳过这一条，
  // 其余记录和数据仍然正常同步下载。这里额外记录"跳过了多少条、影响了多少个单词"，
  // 供 validateCloudRestoredDataForImport 在做数量核对时把这部分正常跳过的差异排除掉，
  // 而不是因为一条坏记录就把整批恢复数据判定为 invalid、导致自动同步永久静默失效。
  let skippedSessionCount = 0;
  let skippedSessionAffectedWordCount = 0;
  cloudSessions.forEach(session => {
    if (!sessionsByLibraryId.has(session.library_id)) {
      result.skipped += 1;
      result.failed += 1;
      skippedSessionCount += 1;
      skippedSessionAffectedWordCount += uniqueIds(session.task_word_ids).length;
      const reason = "听写记录引用了不存在的云端词库：" + session.id;
      result.failureReasons.push(reason);
      console.warn("[cloudSync] 已跳过一条听写记录（其余记录仍正常恢复）：", reason);
      return;
    }

    const restoredArrays = {};
    const arrayFields = {
      taskWordIds: session.task_word_ids,
      newWordIds: session.new_word_ids,
      pendingWrongWordIds: session.pending_wrong_word_ids,
      delayedReviewWordIds: session.review_word_ids,
      wrongWordIds: session.wrong_word_ids
    };
    const missing = new Set();
    Object.entries(arrayFields).forEach(([localKey, cloudIds]) => {
      const restored = restoreCloudWordIds(cloudIds, cloudWordToLocalId);
      restoredArrays[localKey] = restored.restored;
      restored.missing.forEach(id => missing.add(id));
    });
    if (missing.size) {
      result.skipped += 1;
      result.failed += 1;
      skippedSessionCount += 1;
      skippedSessionAffectedWordCount += uniqueIds(session.task_word_ids).length;
      const reason =
        "Day " + session.day_number + " 有 " + missing.size + " 个单词无法还原（可能是单词已被删除但记录还在），已跳过该听写记录：" +
        Array.from(missing).join(",");
      result.failureReasons.push(reason);
      console.warn("[cloudSync] 已跳过一条听写记录（其余记录仍正常恢复）：", reason);
      return;
    }

    const record = {
      recordId: String(session.source_local_id || cloudFallbackId("rec", session.id)),
      dayNumber: Number(session.day_number),
      date: session.record_date || datePart(session.created_at),
      taskWordIds: restoredArrays.taskWordIds,
      newWordIds: restoredArrays.newWordIds,
      pendingWrongWordIds: restoredArrays.pendingWrongWordIds,
      delayedReviewWordIds: restoredArrays.delayedReviewWordIds,
      postponedReviewWordIds: [],
      wrongWordIds: restoredArrays.wrongWordIds,
      completedAt: session.created_at || session.updated_at || new Date().toISOString(),
      source: "cloud-restored",
      plannedNewCount: restoredArrays.newWordIds.length,
      actualNewCount: restoredArrays.newWordIds.length
    };
    record.sourceMap = makeRestoredSourceMap(record);
    sessionsByLibraryId.get(session.library_id).push(record);
    result.sessions += 1;
  });
  result.cloudCounts.skippedSessionCount = skippedSessionCount;
  result.cloudCounts.skippedSessionAffectedWordCount = skippedSessionAffectedWordCount;

  const restoredLibraries = cloudLibraries.map(cloudLibrary => {
    const words = localWordsByLibrary.get(cloudLibrary.id) || [];
    const dailyRecords = (sessionsByLibraryId.get(cloudLibrary.id) || [])
      .sort((a, b) => Number(a.dayNumber) - Number(b.dayNumber));
    const wordById = new Map(words.map(word => [word.id, word]));
    dailyRecords.forEach(record => {
      record.taskWordIds.forEach(wordId => {
        const word = wordById.get(wordId);
        if (!word) return;
        const dayNumber = positiveDayOrNull(record.dayNumber);
        if (dayNumber != null && (word.firstLearnDay == null || dayNumber < Number(word.firstLearnDay))) {
          word.firstLearnDay = dayNumber;
        }
      });
      record.wrongWordIds.forEach(wordId => {
        const word = wordById.get(wordId);
        if (!word) return;
        if (word.lastWrongDay == null || Number(record.dayNumber) >= Number(word.lastWrongDay)) {
          word.lastWrongDay = Number(record.dayNumber);
          word.lastWrongDate = record.date || null;
        }
      });
    });
    result.words += words.length;
    return {
      libraryId: cloudLibraryToLocalId.get(cloudLibrary.id),
      libraryName: cloudLibrary.name || "未命名词库",
      createdAt: datePart(cloudLibrary.created_at, new Date().toISOString().slice(0, 10)),
      // 用恢复时刻（而非 libraries 表的 Step1 时间戳）写入 updatedAt，
      // 确保它 ≥ 云端 user_word_progress.updated_at（Step5），从根源上防止时间戳误判死循环。
      updatedAt: new Date().toISOString(),
      settings: restoredSettings(settingsByLibraryId.get(cloudLibrary.id)),
      words,
      dailyRecords,
      currentDraftTask: null,
      reviewRuleVersion: "wrong-only-review-v1"
    };
  });

  result.libraries = restoredLibraries.length;
  result.restoredData = {
    version: appVersion || "1.0.0",
    activeLibraryId: restoredLibraries[0]?.libraryId || null,
    libraries: restoredLibraries
  };
  return result;
}

export async function deleteCloudSessionBySourceLocalId(libraryLocalId, sessionSourceLocalId) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) return { deleted: false, reason: "未登录" };

  const { data: libs, error: libError } = await client
    .from("libraries")
    .select("id")
    .eq("owner_id", user.id)
    .eq("source_local_id", String(libraryLocalId))
    .limit(1);
  if (libError) throw libError;
  if (!libs?.length) return { deleted: false, reason: "云端没有找到对应词库" };

  const { error } = await client
    .from("dictation_sessions")
    .delete()
    .eq("user_id", user.id)
    .eq("library_id", libs[0].id)
    .eq("source_local_id", String(sessionSourceLocalId));
  if (error) throw error;
  return { deleted: true };
}

export async function getCloudFreshnessSignals() {
  const client = requireCloudClient();
  const user = await getCurrentUserFromSession();
  if (!user) return null;

  const { count: sessionCount, error: sessionCountError } = await client
    .from("dictation_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (sessionCountError) throw sessionCountError;

  const { data: maxDayRows, error: maxDayError } = await client
    .from("dictation_sessions")
    .select("day_number")
    .eq("user_id", user.id)
    .order("day_number", { ascending: false })
    .limit(1);
  if (maxDayError) throw maxDayError;

  const { count: learnedCount, error: learnedError } = await client
    .from("user_word_progress")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .not("first_learn_day", "is", null)
    .gt("first_learn_day", 0);
  if (learnedError) throw learnedError;

  // 用 user_word_progress.updated_at 而非 libraries.updated_at：
  // libraries 在上传 Step1 就被写入，而 user_word_progress 是上传最后一步（Step5），
  // 用后者可以避免"Step1写入→freshness命中→拉取→读到还没写完的进度"的竞态。
  const { data: maxProgressRows, error: maxProgressError } = await client
    .from("user_word_progress")
    .select("updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (maxProgressError) throw maxProgressError;

  return {
    sessionCount: Number(sessionCount || 0),
    maxDayNumber: Number(maxDayRows?.[0]?.day_number ?? 0),
    learnedCount: Number(learnedCount || 0),
    maxProgressUpdatedAt: maxProgressRows?.[0]?.updated_at || null
  };
}
