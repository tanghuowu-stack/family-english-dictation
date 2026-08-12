import { cloudConfigurationMessage, isCloudConfigured, supabase } from "./supabaseClient.js";
import {
  deleteCloudSessionBySourceLocalId,
  downloadCloudDataForLocalStorage,
  getCloudDataSummary,
  getCloudFreshnessSignals,
  getCurrentUser,
  getCurrentUserFromSession,
  uploadLocalDataToCloud
} from "./cloudRepository.js";

let authListenerBound = false;
let lastAutoUploadMessage = "";
let lastAutoUploadIsError = false;

function getCloudElements() {
  return {
    panel: document.getElementById("cloudSyncPanel"),
    mode: document.getElementById("cloudModeText"),
    user: document.getElementById("cloudUserText"),
    email: document.getElementById("cloudEmailInput"),
    password: document.getElementById("cloudPasswordInput"),
    login: document.getElementById("cloudLoginBtn"),
    logout: document.getElementById("cloudLogoutBtn"),
    message: document.getElementById("cloudSyncMessage"),
    upload: document.getElementById("cloudUploadBtn"),
    summary: document.getElementById("cloudSummaryBtn"),
    diagnose: document.getElementById("cloudDiagnoseBtn"),
    download: document.getElementById("cloudDownloadBtn"),
    reload: document.getElementById("cloudReloadBtn"),
    summaryPanel: document.getElementById("cloudDataSummary"),
    libraryCount: document.getElementById("cloudLibraryCount"),
    wordCount: document.getElementById("cloudWordCount"),
    sessionCount: document.getElementById("cloudSessionCount"),
    progressCount: document.getElementById("cloudProgressCount"),
    diagnosticOutput: document.getElementById("cloudDiagnosticOutput"),
    actionMessage: document.getElementById("cloudActionMessage")
  };
}

function setMessage(element, text, isError = false) {
  if (!element) return;
  element.textContent = text || "";
  element.classList.toggle("danger-text", isError);
  element.classList.toggle("ok-text", Boolean(text) && !isError);
}

function setAutoUploadStatus(text, isError = false, isSuccess = false) {
  lastAutoUploadMessage = text;
  lastAutoUploadIsError = isError;
  const element = document.getElementById("autoCloudUploadStatus");
  if (!element) return;
  element.textContent = text;
  element.className = isSuccess ? "success small" : "notice small" + (isError ? " danger-text" : "");
}

async function refreshCloudStatus(elements) {
  if (!elements.panel) return;
  if (!isCloudConfigured) {
    elements.mode.textContent = "本地模式";
    elements.user.textContent = "未登录";
    elements.email.disabled = true;
    elements.password.disabled = true;
    elements.login.disabled = true;
    elements.login.hidden = false;
    elements.logout.hidden = true;
    elements.upload.disabled = true;
    elements.summary.disabled = true;
    elements.diagnose.disabled = true;
    elements.download.disabled = true;
    elements.reload.hidden = true;
    elements.summaryPanel.hidden = true;
    setMessage(elements.message, cloudConfigurationMessage, true);
    return;
  }

  try {
    const user = await getCurrentUser();
    elements.mode.textContent = user ? "已登录云端" : "云端已配置";
    elements.user.textContent = user?.email || "未登录";
    elements.email.disabled = Boolean(user);
    elements.password.disabled = Boolean(user);
    elements.login.hidden = Boolean(user);
    elements.login.disabled = false;
    elements.logout.hidden = !user;
    elements.upload.disabled = !user;
    elements.summary.disabled = !user;
    elements.diagnose.disabled = !user;
    elements.download.disabled = !user;
    if (!user) {
      elements.summaryPanel.hidden = true;
      elements.reload.hidden = true;
    }
    if (user) setMessage(elements.message, "已登录云端；数据变更后会自动上传，切回前台/刷新时会自动检查云端并同步。", false);
    else setMessage(elements.message, "未登录时仍可继续使用全部本地功能。", false);
  } catch (error) {
    elements.mode.textContent = "云端已配置";
    elements.user.textContent = "状态读取失败";
    elements.upload.disabled = true;
    elements.summary.disabled = true;
    elements.diagnose.disabled = true;
    elements.download.disabled = true;
    setMessage(elements.message, error.message || "云端状态读取失败", true);
  }
}

function replaceLocalData(restoredData) {
  if (typeof window.replaceLocalDictationDataFromCloud !== "function") {
    throw new Error("当前页面无法写入恢复数据");
  }
  window.replaceLocalDictationDataFromCloud(restoredData);
}

function validateRestoredData(restoredData, cloudCounts) {
  if (typeof window.validateCloudRestoredDataForImport !== "function") {
    return { valid: false, reasons: ["当前页面缺少恢复结构校验函数"] };
  }
  return window.validateCloudRestoredDataForImport(restoredData, cloudCounts);
}

function getLocalDataSnapshot() {
  if (typeof window.getLocalDictationDataForCloudUpload !== "function") {
    throw new Error("无法读取本地听写数据");
  }
  return window.getLocalDictationDataForCloudUpload();
}

function validateLocalDataForAutoUpload(localData) {
  const reasons = [];
  const libraries = Array.isArray(localData?.libraries) ? localData.libraries : [];
  const activeLibrary = libraries.find(library => library.libraryId === localData?.activeLibraryId);
  if (!localData?.activeLibraryId || !activeLibrary) {
    reasons.push("缺少有效的 activeLibraryId");
    return { valid: false, reasons };
  }
  const summary = summarizeLibrary(activeLibrary);
  if (summary.total <= 0) reasons.push("当前词库没有单词");
  // Fix R6：阈值判断统一读取 index.html 里定义的共享函数，避免两处各写一份、条件不一致
  if (
    typeof window.isSuspiciousAllWordsLearnedState === "function"
      ? window.isSuspiciousAllWordsLearnedState(summary.currentDay, summary.total, summary.learned)
      : (summary.currentDay <= 20 && summary.total === 595 && summary.learned === 595)
  ) {
    reasons.push("检测到低 Day 下 595 个词全部已学的异常状态");
  }
  return { valid: reasons.length === 0, reasons, summary };
}

async function autoUploadAfterDictation() {
  _autoUploadInProgress = true;
  if (typeof window.markPendingCloudUpload === "function") window.markPendingCloudUpload();
  setAutoUploadStatus("本次听写已保存到本机，正在自动上传云端...", false, false);
  try {
    const user = await getCurrentUser();
    if (!user) {
      setAutoUploadStatus("本次听写已保存到本机。当前未登录云端，未自动上传。", false, false);
      return;
    }
    const localData = getLocalDataSnapshot();
    const validation = validateLocalDataForAutoUpload(localData);
    if (!validation.valid) {
      setAutoUploadStatus("本地数据结构异常，已阻止自动上传云端，请先检查数据。", true, false);
      return;
    }
    const result = await uploadLocalDataToCloud(localData);
    if (result.blockedOlderData) {
      setAutoUploadStatus("本机数据较旧，已阻止自动上传，避免覆盖云端最新数据。请先从云端下载最新数据。", true, false);
      return;
    }
    if (result.failed > 0) {
      const reason = result.failureReasons.join("；") || "未知错误";
      setAutoUploadStatus(
        "本次听写已保存到本机，但自动上传云端失败：" + reason + "。请稍后在工具页手动上传。",
        true,
        false
      );
      return;
    }
    if (typeof window.updateLocalLibraryUpdatedAt === "function") {
      window.updateLocalLibraryUpdatedAt(new Date().toISOString());
    }
    if (typeof window.clearPendingCloudUpload === "function") window.clearPendingCloudUpload();
    setAutoUploadStatus("本次听写已保存到本机，并已自动上传到云端。", false, true);
  } catch (error) {
    setAutoUploadStatus(
      "本次听写已保存到本机，但自动上传云端失败：" + (error.message || "网络错误") + "。请稍后在工具页手动上传。",
      true,
      false
    );
  } finally {
    _autoUploadInProgress = false;
  }
}

// ── 词库/单词变更后统一自动上传入口（带 1000ms debounce 防抖）──────────────────────
let _autoUploadTimer = null;

async function _doAutoUploadForDataChange(reason) {
  _autoUploadInProgress = true;
  const prefix = "词库变更已保存到本机";
  setAutoUploadStatus(prefix + "，正在自动上传云端...", false, false);
  try {
    const user = await getCurrentUser();
    if (!user) {
      setAutoUploadStatus(prefix + "。当前未登录云端，未自动上传。", false, false);
      return;
    }
    const localData = getLocalDataSnapshot();
    const validation = validateLocalDataForAutoUpload(localData);
    if (!validation.valid) {
      const reasons = validation.reasons.join("；");
      setAutoUploadStatus(
        prefix + "，但本地数据结构异常，已阻止自动上传：" + reasons + "。请先检查数据。",
        true, false
      );
      return;
    }
    const result = await uploadLocalDataToCloud(localData);
    if (result.blockedOlderData) {
      setAutoUploadStatus(
        "本机数据较旧，已阻止自动上传，避免覆盖云端最新数据。请先从云端下载最新数据。",
        true, false
      );
      return;
    }
    if (result.failed > 0) {
      const failReason = result.failureReasons.join("；") || "未知错误";
      setAutoUploadStatus(
        prefix + "，但自动上传云端失败：" + failReason + "。请稍后在工具页手动上传。",
        true, false
      );
      return;
    }
    if (typeof window.updateLocalLibraryUpdatedAt === "function") {
      window.updateLocalLibraryUpdatedAt(new Date().toISOString());
    }
    if (typeof window.clearPendingCloudUpload === "function") window.clearPendingCloudUpload();
    setAutoUploadStatus(prefix + "，并已自动上传到云端。", false, true);
  } catch (error) {
    setAutoUploadStatus(
      prefix + "，但自动上传云端失败：" + (error.message || "网络错误") + "。请稍后在工具页手动上传。",
      true, false
    );
  } finally {
    _autoUploadInProgress = false;
  }
}

function requestAutoUploadLocalData(reason) {
  // 立即标记"待上传"，即使页面在防抖计时器触发前被关闭，重新打开后这个标记仍会保留
  if (typeof window.markPendingCloudUpload === "function") window.markPendingCloudUpload();
  if (_autoUploadTimer !== null) {
    clearTimeout(_autoUploadTimer);
    _autoUploadTimer = null;
  }
  _autoUploadTimer = setTimeout(() => {
    _autoUploadTimer = null;
    if (reason === "dictation-complete") {
      autoUploadAfterDictation();
    } else {
      _doAutoUploadForDataChange(reason || "data-changed");
    }
  }, 1000);
}

// ── 撤销听写记录专用：先删云端对应 session，再上传本机最新快照 ────────────────────
// Fix R5：参照 iPad 同步失败重试的思路，失败后 5 秒自动重试一次，而不是直接放弃、
// 只能靠用户去工具页手动补传。
const DELETE_SESSION_RETRY_DELAY_MS = 5000;

async function deleteSessionAndSync(libraryLocalId, sessionSourceLocalId, isRetry = false) {
  setAutoUploadStatus(
    isRetry ? "正在重试将撤销的记录同步到云端..." : "记录已在本机删除，正在同步到云端...",
    false, false
  );
  try {
    const user = await getCurrentUser();
    if (!user) {
      setAutoUploadStatus("记录已在本机删除。当前未登录云端，未自动同步。", false, false);
      return;
    }
    await deleteCloudSessionBySourceLocalId(libraryLocalId, sessionSourceLocalId);
    requestAutoUploadLocalData("undo-record");
  } catch (error) {
    if (!isRetry) {
      console.warn("[cloudSync] 撤销记录同步云端失败，5 秒后自动重试一次：", error?.message || error);
      setAutoUploadStatus("本机记录已删除，云端同步失败，5 秒后自动重试...", true, false);
      setTimeout(() => deleteSessionAndSync(libraryLocalId, sessionSourceLocalId, true), DELETE_SESSION_RETRY_DELAY_MS);
      return;
    }
    setAutoUploadStatus(
      "本机记录已删除，但云端同步失败：" + (error.message || "网络错误") + "。请稍后在工具页手动上传。",
      true, false
    );
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function summarizeLibrary(library) {
  if (!library) {
    return { currentDay: 1, total: 0, learned: 0, unlearned: 0, pending: 0, records: 0, id: "-", name: "-" };
  }
  const records = Array.isArray(library.dailyRecords) ? library.dailyRecords : [];
  const words = Array.isArray(library.words) ? library.words : [];
  const taskWordIds = new Set(records.flatMap(record => record.taskWordIds || []));
  const learned = words.filter(word => {
    const day = Number(word.firstLearnDay);
    return (word.firstLearnDay != null && Number.isFinite(day) && day > 0) || taskWordIds.has(word.id);
  }).length;
  return {
    currentDay: records.length ? Math.max(...records.map(record => Number(record.dayNumber || 0))) + 1 : 1,
    total: words.length,
    learned,
    unlearned: Math.max(0, words.length - learned),
    pending: words.filter(word => word.isPendingWrong).length,
    records: records.length,
    id: library.libraryId || "-",
    name: library.libraryName || "未命名词库"
  };
}

function activeLibraryFromData(localData) {
  const libraries = Array.isArray(localData?.libraries) ? localData.libraries : [];
  return libraries.find(library => library.libraryId === localData.activeLibraryId) || libraries[0] || null;
}

function formatDiagnosticReport(localData, restoreResult, validation) {
  const local = summarizeLibrary(activeLibraryFromData(localData));
  const restored = summarizeLibrary(activeLibraryFromData(restoreResult.restoredData));
  const cloud = restoreResult.cloudCounts || {};
  const lines = [
    "本机摘要：",
    "当前 Day：" + local.currentDay,
    "总词数：" + local.total,
    "已学词数：" + local.learned,
    "未学词数：" + local.unlearned,
    "当前错词池数量：" + local.pending,
    "dailyRecords 数量：" + local.records,
    "当前词库：" + local.id + " / " + local.name,
    "",
    "云端摘要：",
    "words 总数：" + Number(cloud.words || 0),
    "dictation_sessions 数量：" + Number(cloud.sessions || 0),
    "最大 day_number：" + Number(cloud.maxDayNumber || 0),
    "user_word_progress 总数：" + Number(cloud.progress || 0),
    "first_learn_day 非空数量：" + Number(cloud.firstLearnDayNonNullProgress || 0),
    "first_learn_day 有效数量：" + Number(cloud.firstLearnDayValidProgress || 0),
    "is_pending_wrong = true 数量：" + Number(cloud.pendingWrongProgress || 0),
    "当前用户 id：" + (cloud.userId || "-"),
    "当前词库数量：" + Number(cloud.libraries || 0),
    // Fix S3：upload_complete === false 说明上一次上传中途失败/被打断过，云端可能停留在
    // 不完整的中间状态；这里明确列出，提醒用户去发起那次上传的设备重新点一次上传。
    "上次上传是否有未完整跑完的词库：" + (cloud.hasIncompleteUpload
      ? "是（" + (cloud.incompleteUploadLibraryNames || []).join("、") + "）"
      : "否"),
    // Fix S6：因引用缺失单词/词库被跳过的听写记录数量，跳过原因已在 console.warn 中给出。
    "因引用缺失数据被跳过的听写记录数：" + Number(cloud.skippedSessionCount || 0),
    "",
    "恢复预览摘要：",
    "restoredData 当前 Day：" + restored.currentDay,
    "restoredData 总词数：" + restored.total,
    "restoredData 已学词数：" + restored.learned,
    "restoredData 未学词数：" + restored.unlearned,
    "restoredData 错词池数量：" + restored.pending,
    "restoredData dailyRecords 数量：" + restored.records,
    "是否通过结构校验：" + (validation.valid ? "是" : "否")
  ];
  if (!validation.valid) {
    lines.push("校验失败原因：");
    validation.reasons.forEach(reason => lines.push("- " + reason));
  }
  return lines.join("\n");
}

function formatUploadResult(result) {
  const lines = [
    "上传完成。",
    "词库数量：" + result.libraries,
    "单词数量：" + result.words,
    "听写记录数量：" + result.sessions,
    "学习进度数量：" + result.progress,
    "失败数量：" + result.failed
  ];
  if (result.failureReasons.length) {
    lines.push("失败原因：");
    result.failureReasons.forEach(reason => lines.push("- " + reason));
  } else {
    lines.push("失败原因：无");
  }
  return lines.join("\n");
}

async function uploadLocalData(elements) {
  const confirmUpload = window.requestAppConfirmation || (message => Promise.resolve(window.confirm(message)));
  const confirmed = await confirmUpload(
    "上传前请先导出本地 JSON 备份。本操作会把当前浏览器里的词库、单词、听写记录、错词进度上传到当前登录的云端账号。不会清空本地数据，也不会从云端下载覆盖本机数据。确定继续吗？",
    "上传本地数据"
  );
  if (!confirmed) return;

  elements.upload.disabled = true;
  elements.summary.disabled = true;
  elements.diagnose.disabled = true;
  setMessage(elements.actionMessage, "正在上传本地数据，请不要关闭页面...", false);
  try {
    const result = await uploadLocalDataToCloud(getLocalDataSnapshot());
    setMessage(elements.actionMessage, formatUploadResult(result), result.failed > 0);
  } catch (error) {
    setMessage(elements.actionMessage, "上传失败：" + (error.message || "网络错误"), true);
  } finally {
    await refreshCloudStatus(elements);
  }
}

async function showCloudSummary(elements) {
  elements.upload.disabled = true;
  elements.summary.disabled = true;
  elements.diagnose.disabled = true;
  setMessage(elements.actionMessage, "正在读取云端数据摘要...", false);
  try {
    const summary = await getCloudDataSummary();
    elements.libraryCount.textContent = summary.libraries;
    elements.wordCount.textContent = summary.words;
    elements.sessionCount.textContent = summary.sessions;
    elements.progressCount.textContent = summary.progress;
    elements.summaryPanel.hidden = false;
    setMessage(elements.actionMessage, "云端数据摘要已更新。此操作没有修改本地数据。", false);
  } catch (error) {
    setMessage(elements.actionMessage, "读取失败：" + (error.message || "网络错误"), true);
  } finally {
    await refreshCloudStatus(elements);
  }
}

async function diagnoseLocalAndCloudData(elements) {
  elements.upload.disabled = true;
  elements.summary.disabled = true;
  elements.diagnose.disabled = true;
  elements.download.disabled = true;
  elements.diagnosticOutput.hidden = true;
  setMessage(elements.actionMessage, "正在执行只读诊断...", false);
  try {
    const localData = getLocalDataSnapshot();
    const result = await downloadCloudDataForLocalStorage(localData?.version || "1.0.0", localData?.activeLibraryId || null);
    const validation = validateRestoredData(result.restoredData, result.cloudCounts || {});
    elements.diagnosticOutput.textContent = formatDiagnosticReport(localData, result, validation);
    elements.diagnosticOutput.hidden = false;
    setMessage(elements.actionMessage, "诊断完成。本次操作只读取数据，没有上传、下载覆盖或修改本机数据。", false);
  } catch (error) {
    setMessage(elements.actionMessage, "诊断失败：" + (error.message || "网络错误"), true);
  } finally {
    await refreshCloudStatus(elements);
  }
}

function formatRestoreResult(result) {
  const lines = [
    result.failed > 0 ? "恢复完成，但有部分项目未恢复。" : "恢复成功。",
    "词库数量：" + result.libraries,
    "单词数量：" + result.words,
    "听写记录数量：" + result.sessions,
    "学习/错词进度数量：" + result.progress,
    "是否有跳过项目：" + (result.skipped > 0 ? "是（" + result.skipped + "）" : "否"),
    "失败数量：" + result.failed
  ];
  if (result.failureReasons.length) {
    lines.push("失败原因：");
    result.failureReasons.forEach(reason => lines.push("- " + reason));
  } else {
    lines.push("失败原因：无");
  }
  lines.push("恢复已写入本机 localStorage。请刷新页面检查词库和记录。");
  return lines.join("\n");
}

async function downloadCloudData(elements) {
  const confirmDownload = window.requestAppConfirmation || (message => Promise.resolve(window.confirm(message)));
  const confirmed = await confirmDownload(
    "请先在当前设备导出本地 JSON 备份。本操作会把云端数据下载到当前浏览器，并覆盖当前浏览器 localStorage。不会删除云端数据。确定继续吗？",
    "从云端恢复数据"
  );
  if (!confirmed) return;

  elements.upload.disabled = true;
  elements.summary.disabled = true;
  elements.diagnose.disabled = true;
  elements.download.disabled = true;
  elements.reload.hidden = true;
  setMessage(elements.actionMessage, "正在读取并还原云端数据，请不要关闭页面...", false);
  try {
    const currentLocalData = getLocalDataSnapshot();
    const result = await downloadCloudDataForLocalStorage(currentLocalData?.version || "1.0.0", currentLocalData?.activeLibraryId || null);
    const validation = validateRestoredData(result.restoredData, result.cloudCounts || {});
    if (!validation.valid) {
      setMessage(
        elements.actionMessage,
        "云端数据已下载，但已学/未学状态校验失败，未覆盖本机数据。\n失败原因：\n- " + validation.reasons.join("\n- "),
        true
      );
      return;
    }
    replaceLocalData(result.restoredData);
    setMessage(elements.actionMessage, formatRestoreResult(result), result.failed > 0);
    elements.reload.hidden = false;
  } catch (error) {
    setMessage(
      elements.actionMessage,
      "恢复失败：" + (error.message || "网络错误") + "。本地数据没有被覆盖。",
      true
    );
  } finally {
    await refreshCloudStatus(elements);
  }
}

async function signInWithEmailPassword(elements) {
  const email = String(elements.email.value || "").trim();
  const password = String(elements.password.value || "");
  if (!email) {
    setMessage(elements.message, "请输入邮箱。", true);
    elements.email.focus();
    return;
  }
  if (!password) {
    setMessage(elements.message, "请输入密码。", true);
    elements.password.focus();
    return;
  }

  elements.login.disabled = true;
  setMessage(elements.message, "正在登录...", false);
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    elements.password.value = "";
    await refreshCloudStatus(elements);
    setMessage(elements.message, "登录成功，正在检查云端数据是否更新...", false);
  } catch (error) {
    setMessage(elements.message, "登录失败：" + (error.message || "网络错误"), true);
  } finally {
    elements.login.disabled = false;
  }
}

async function signOut(elements) {
  elements.logout.disabled = true;
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setMessage(elements.message, "已退出云端，当前继续使用本地模式。", false);
    await refreshCloudStatus(elements);
  } catch (error) {
    setMessage(elements.message, error.message || "退出登录失败", true);
  } finally {
    elements.logout.disabled = false;
  }
}

// ── 自动双向同步：检查云端是否比本机新 ──────────────────────────────────────────
let _autoSyncInProgress = false;
// 上传期间屏蔽拉取，防止读到云端中间状态（库行已更新但 user_word_progress 还未写入）
let _autoUploadInProgress = false;
// iOS PWA 下 visibilitychange 极其频繁，60 秒内不重复发起 freshness 检查
let _lastAutoSyncCheckTime = 0;
const AUTO_SYNC_MIN_INTERVAL_MS = 60 * 1000;
// Fix iPad：检查因网络/认证未就绪失败时，不消耗冷却时间，改为短延迟后自动重试一次
let _autoSyncRetryTimer = null;
const AUTO_SYNC_RETRY_DELAY_MS = 5000;
// Fix S4 兜底：pendingCloudUpload 卡住超过这个时长，强制清除，避免因未预料到的失败路径
// （或未来类似 bug）导致这个标记永久卡死后续所有自动同步
const PENDING_UPLOAD_STUCK_TIMEOUT_MS = 60 * 60 * 1000;

async function checkCloudFreshness() {
  // Fix iPad：优先用本地会话（不发网络请求）判断登录状态，减少这个高频检查对网络状态的依赖
  const user = await getCurrentUserFromSession();
  if (!user) return false;

  const localData = getLocalDataSnapshot();
  if (!localData || !Array.isArray(localData.libraries)) return false;

  const libraries = localData.libraries;
  if (!libraries.length) return false;

  // Fix S1：getCloudFreshnessSignals 是按 user_id 聚合"该用户全部词库"的计数，
  // 本地对比基准如果只统计 activeLibrary 一个词库，多词库账号下云端计数必然更大，
  // 会被恒判为"云端更新"，触发下载+reload 死循环。这里改为本地也聚合全部词库，
  // 与云端口径保持一致。
  const localSessionCount = libraries.reduce((sum, lib) => {
    return sum + (Array.isArray(lib.dailyRecords) ? lib.dailyRecords.length : 0);
  }, 0);
  const localMaxDay = libraries.reduce((max, lib) => {
    const records = Array.isArray(lib.dailyRecords) ? lib.dailyRecords : [];
    const libMax = records.length ? Math.max(...records.map(r => Number(r.dayNumber || 0))) : 0;
    return Math.max(max, libMax);
  }, 0);
  const localLearnedCount = libraries.reduce((sum, lib) => {
    return sum + (lib.words || []).filter(word => {
      const day = Number(word.firstLearnDay);
      return word.firstLearnDay != null && Number.isFinite(day) && day > 0;
    }).length;
  }, 0);

  const signals = await getCloudFreshnessSignals();
  if (!signals) return false;

  if (signals.sessionCount > localSessionCount) return true;
  if (signals.maxDayNumber > localMaxDay) return true;
  if (signals.learnedCount > localLearnedCount) return true;

  // 第四个信号：用 user_word_progress.updated_at 捕获"删除/撤销"等让数量减少的操作。
  // 该字段在 uploadLocalDataToCloud 最后一步（Step5）才写入，不会在上传中途触发误判。
  // 本机对比基准用 lib.updatedAt，它在 updateLocalLibraryUpdatedAt() 里与 Step5 同步更新。
  if (signals.maxProgressUpdatedAt) {
    const localMaxUpdatedAt = libraries.reduce((max, lib) => {
      const ts = lib.updatedAt || "";
      return ts > max ? ts : max;
    }, "");
    if (localMaxUpdatedAt && signals.maxProgressUpdatedAt > localMaxUpdatedAt) return true;
  }

  return false;
}

function showSyncToast(message) {
  let toast = document.getElementById("autoSyncToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "autoSyncToast";
    Object.assign(toast.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#eefaf5",
      border: "1px solid #8dc7b2",
      color: "#0d5d45",
      padding: "8px 18px",
      borderRadius: "8px",
      fontSize: "14px",
      zIndex: "9999",
      boxShadow: "0 2px 8px rgba(0,0,0,.12)",
      transition: "opacity .3s ease",
      pointerEvents: "none"
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = "1";
  clearTimeout(toast._autoSyncTimer);
  toast._autoSyncTimer = setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  }, 1800);
}

// Fix S4：自动拉取覆盖本机前，如果本机还有未确认上传成功的变更，先尝试补传一次。
// 补传成功后本机数据已经等于（或不落后于）云端，避免被随后的下载覆盖丢失；
// 补传因网络等原因失败则放弃本次拉取，宁可这次不同步，也不覆盖本机未上传的变更。
//
// 但补传失败还有另一种情况：blockedOlderData —— uploadLocalDataToCloud 判断"本机数据本来就比
// 云端旧"而主动拒绝上传。这种失败不是"本机有价值的新数据没传上去"，而是"本机数据确实过时"，
// 覆盖它是安全、符合预期的。如果把这种失败也当成"跳过下载"处理，会导致一旦 pendingCloudUpload
// 在本机落后于云端时被设为 true，就永远清不掉、永远补传失败、永远跳过下载 —— 一个自锁死循环
// （这正是本机 Day 落后云端时实际发生过的问题）。所以这里返回结构化结果，让调用方能区分这两种
// 失败原因，分别处理。
async function tryUploadPendingLocalChanges() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      console.warn("[cloudSync] 待上传变更补传跳过：当前未登录云端");
      return { uploaded: false, blockedOlderData: false };
    }
    const localData = getLocalDataSnapshot();
    const validation = validateLocalDataForAutoUpload(localData);
    if (!validation.valid) {
      console.warn("[cloudSync] 待上传变更补传跳过：本地数据结构校验未通过：", validation.reasons);
      return { uploaded: false, blockedOlderData: false };
    }
    const result = await uploadLocalDataToCloud(localData);
    if (result.blockedOlderData) {
      console.warn(
        "[cloudSync] 待上传变更补传被阻止：本机数据确实比云端旧，视为正常情况（不是数据丢失风险）：",
        result.failureReasons
      );
      return { uploaded: false, blockedOlderData: true };
    }
    if (result.failed > 0) {
      console.warn("[cloudSync] 待上传变更补传失败：", result.failureReasons);
      return { uploaded: false, blockedOlderData: false };
    }
    if (typeof window.clearPendingCloudUpload === "function") window.clearPendingCloudUpload();
    if (typeof window.updateLocalLibraryUpdatedAt === "function") {
      window.updateLocalLibraryUpdatedAt(new Date().toISOString());
    }
    return { uploaded: true, blockedOlderData: false };
  } catch (error) {
    console.warn("[cloudSync] 待上传变更补传时发生异常：", error?.message || error);
    return { uploaded: false, blockedOlderData: false };
  }
}

async function autoSyncCloudToLocalIfNewer() {
  if (_autoSyncInProgress) return;
  if (_autoUploadInProgress) return;
  // Fix2: iOS PWA visibilitychange 高频触发保护，60 秒内不重复发起网络检查
  const now = Date.now();
  if (now - _lastAutoSyncCheckTime < AUTO_SYNC_MIN_INTERVAL_MS) return;
  _autoSyncInProgress = true;
  // Fix iPad：只有确认本次检查真正跑完（没有因网络/认证异常报错）才消耗冷却时间，
  // 否则 iOS 从后台恢复瞬间的一次失败检查会白白占用 60 秒冷却窗口，只能等 3 分钟定时器
  let checkSucceeded = false;
  try {
    const isFresh = await checkCloudFreshness();
    checkSucceeded = true;
    if (!isFresh) return;

    const currentLocalData = getLocalDataSnapshot();
    // Fix3: 用户正在听写中（currentDraftTask 存在），跳过覆盖和刷新，不打断听写进度
    const activeLib = (currentLocalData?.libraries || []).find(
      lib => lib.libraryId === currentLocalData?.activeLibraryId
    ) || (currentLocalData?.libraries || [])[0];
    if (activeLib?.currentDraftTask) return;

    // Fix S4：本机存在未确认上传成功的变更时，先尝试补传，避免被本次下载覆盖丢失
    if (currentLocalData?.pendingCloudUpload) {
      // 兜底：标记卡住超过 1 小时还没清除，视为异常状态（例如未预料到的失败路径），强制清除，
      // 避免这个标记以后再以别的形式变成永久死锁——只能靠开发者读代码才能发现
      const since = currentLocalData.pendingCloudUploadSince
        ? new Date(currentLocalData.pendingCloudUploadSince).getTime()
        : 0;
      const stuckMs = since ? Date.now() - since : Infinity;
      if (stuckMs > PENDING_UPLOAD_STUCK_TIMEOUT_MS) {
        console.warn(
          "[cloudSync] pendingCloudUpload 标记已卡住超过 1 小时，视为异常状态，强制清除：",
          { pendingCloudUploadSince: currentLocalData.pendingCloudUploadSince, stuckMinutes: Math.round(stuckMs / 60000) }
        );
        if (typeof window.clearPendingCloudUpload === "function") window.clearPendingCloudUpload();
      } else {
        const uploadOutcome = await tryUploadPendingLocalChanges();
        if (uploadOutcome.uploaded) {
          const stillFresh = await checkCloudFreshness();
          if (!stillFresh) return;
        } else if (uploadOutcome.blockedOlderData) {
          // 本机数据确认比云端旧：这不是"本地新数据没传上去"，覆盖是安全、符合预期的。
          // 清掉标记后继续往下走下载覆盖，不能在这里 return，否则会永远卡在这个分支。
          console.warn("[cloudSync] 本机数据确认落后于云端，清除 pendingCloudUpload 标记并继续执行下载覆盖");
          if (typeof window.clearPendingCloudUpload === "function") window.clearPendingCloudUpload();
        } else {
          // 真正的失败原因（网络错误等），本地可能确实有未同步的新变更，保守起见跳过本次下载
          console.warn("[cloudSync] 本地待上传变更补传失败（非本机数据过时），本次跳过下载覆盖以保护本地数据");
          return;
        }
      }
    }

    const result = await downloadCloudDataForLocalStorage(currentLocalData?.version || "1.0.0", currentLocalData?.activeLibraryId || null);
    const validation = validateRestoredData(result.restoredData, result.cloudCounts || {});
    if (!validation.valid) {
      console.warn("[cloudSync] 自动同步下载的数据未通过校验，已跳过本次覆盖：", validation.reasons);
      return;
    }

    // Fix R9：downloadCloudDataForLocalStorage 是一系列 await 网络请求，耗时较长。
    // 如果用户恰好在这段时间内完成并提交了一次听写，_autoUploadInProgress 会在这期间被置 true。
    // 顶部的前置检查发生在下载开始之前，读不到这个后来才出现的状态，这里在真正覆盖本机数据前
    // 再检查一次，避免用刚下载的（可能还不包含这次听写的）云端数据覆盖掉本机刚提交的新记录。
    if (_autoUploadInProgress) {
      console.warn("[cloudSync] 拉取完成时检测到本机正在上传（提交了新的听写记录），放弃本次覆盖以避免冲突");
      return;
    }

    replaceLocalData(result.restoredData);
    // Fix1: 更新本机 lib.updatedAt 到当前时刻，使其 ≥ 云端 user_word_progress.updated_at，
    // 防止下次 checkCloudFreshness 的第4信号（时间戳比较）再次误判为"云端更新"而触发死循环
    if (typeof window.updateLocalLibraryUpdatedAt === "function") {
      window.updateLocalLibraryUpdatedAt(new Date().toISOString());
    }
    // Fix S6/S3：数据已经正常同步下载，但云端存在被跳过的坏记录，或者有词库上次上传未完整跑完——
    // 不阻塞本次同步，只用一个不打断使用的 toast 提示用户，技术细节已经在 console.warn 里了。
    const cloudCounts = result.cloudCounts || {};
    if (Number(cloudCounts.skippedSessionCount || 0) > 0 || cloudCounts.hasIncompleteUpload) {
      showSyncToast("已同步最新数据，但部分历史数据可能不完整，建议手动检查");
    } else {
      showSyncToast("已同步最新数据");
    }
    setTimeout(() => window.location.reload(), 500);
  } catch (error) {
    // Fix iPad：不再完全静默，留一条 console.warn 方便以后排查"为什么没自动同步"
    console.warn("[cloudSync] 自动同步检查失败，稍后会自动重试：", error?.message || error);
  } finally {
    _autoSyncInProgress = false;
    if (checkSucceeded) {
      _lastAutoSyncCheckTime = Date.now();
      if (_autoSyncRetryTimer !== null) {
        clearTimeout(_autoSyncRetryTimer);
        _autoSyncRetryTimer = null;
      }
    } else if (_autoSyncRetryTimer === null) {
      // Fix iPad：检查失败（多半是网络栈/token 还没就绪），5 秒后自动重试一次，
      // 不必等到下一次 visibilitychange 或 3 分钟定时器
      _autoSyncRetryTimer = setTimeout(() => {
        _autoSyncRetryTimer = null;
        autoSyncCloudToLocalIfNewer();
      }, AUTO_SYNC_RETRY_DELAY_MS);
    }
  }
}

// ── 独立的 PWA 代码版本检查（与上面的云端数据同步逻辑完全独立，不共用任何状态）─────────
// 背景：iOS "添加到主屏幕" 的独立 PWA 窗口用的是一套和普通 Safari 标签页不同的页面缓存/
// 快照机制，不完全受 Cache-Control 约束——曾出现过服务器和代码都已经更新，但主屏幕图标
// 打开的窗口仍在跑旧版 JS 的情况。这里用"版本号轮询 + 不一致就强制刷新"来兜底，而不是
// 引入 Service Worker。
//
// __APP_BUILD_VERSION__ 由 vite.config.js 在构建时注入，是"当前这份正在运行的代码是哪次
// 构建"的编译期常量，随 JS bundle 一起打包，不会因为重新请求而变化。
// /version.json 是每次构建都会重新生成的静态文件，代表"服务器当前最新是哪次构建"，请求时
// 用 no-store + 时间戳参数双重绕开缓存。
// 只要 PWA 窗口卡在旧代码上，这两个值就会不一致，从而检测出"该刷新了"。
const CURRENT_APP_BUILD_VERSION =
  typeof __APP_BUILD_VERSION__ !== "undefined" ? __APP_BUILD_VERSION__ : null;
let _versionCheckInProgress = false;

async function fetchLatestAppVersion() {
  const response = await fetch("/version.json?_=" + Date.now(), { cache: "no-store" });
  if (!response.ok) throw new Error("version.json 请求失败，HTTP " + response.status);
  const payload = await response.json();
  return String(payload?.version || "");
}

function forceReloadWithCacheBust() {
  const url = new URL(window.location.href);
  url.searchParams.set("_app_refresh", String(Date.now()));
  window.location.replace(url.toString());
}

async function checkAppVersionAndReloadIfStale() {
  if (_versionCheckInProgress) return;
  if (!CURRENT_APP_BUILD_VERSION) return;
  _versionCheckInProgress = true;
  try {
    const latestVersion = await fetchLatestAppVersion();
    if (latestVersion && latestVersion !== CURRENT_APP_BUILD_VERSION) {
      console.warn(
        "[versionCheck] 检测到新版本，当前页面代码已过期，即将自动刷新：",
        { running: CURRENT_APP_BUILD_VERSION, latest: latestVersion }
      );
      showSyncToast("发现新版本，正在更新...");
      setTimeout(() => forceReloadWithCacheBust(), 800);
    }
  } catch (error) {
    console.warn("[versionCheck] 版本检查失败：", error?.message || error);
  } finally {
    _versionCheckInProgress = false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── 低频定时自动同步（每3分钟，后台时暂停）──────────────────────────────────────
let _periodicSyncTimer = null;
const PERIODIC_SYNC_INTERVAL_MS = 3 * 60 * 1000;

function startPeriodicSync() {
  if (_periodicSyncTimer !== null) return;
  _periodicSyncTimer = setInterval(() => {
    autoSyncCloudToLocalIfNewer();
    checkAppVersionAndReloadIfStale();
  }, PERIODIC_SYNC_INTERVAL_MS);
}

function stopPeriodicSync() {
  if (_periodicSyncTimer !== null) {
    clearInterval(_periodicSyncTimer);
    _periodicSyncTimer = null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

async function mount() {
  const elements = getCloudElements();
  if (!elements.panel) return;
  elements.login.onclick = () => signInWithEmailPassword(elements);
  elements.logout.onclick = () => signOut(elements);
  elements.upload.onclick = () => uploadLocalData(elements);
  elements.summary.onclick = () => showCloudSummary(elements);
  elements.diagnose.onclick = () => diagnoseLocalAndCloudData(elements);
  elements.download.onclick = () => downloadCloudData(elements);
  elements.reload.onclick = () => window.location.reload();
  if (lastAutoUploadMessage && !elements.actionMessage.textContent) {
    setMessage(elements.actionMessage, "最近一次自动上传：" + lastAutoUploadMessage, lastAutoUploadIsError);
  }
  [elements.email, elements.password].forEach(input => {
    input.onkeydown = event => {
      if (event.key === "Enter") {
        event.preventDefault();
        signInWithEmailPassword(elements);
      }
    };
  });
  await refreshCloudStatus(elements);
}

window.cloudSync = {
  mount,
  autoUploadAfterDictation,
  requestAutoUploadLocalData,
  autoSyncCloudToLocalIfNewer,
  deleteSessionAndSync,
  startPeriodicSync,
  stopPeriodicSync,
  checkAppVersionAndReloadIfStale
};

if (supabase && !authListenerBound) {
  authListenerBound = true;
  supabase.auth.onAuthStateChange((event) => {
    window.setTimeout(() => mount(), 0);
    if (event === "SIGNED_IN") {
      window.setTimeout(() => autoSyncCloudToLocalIfNewer(), 0);
    }
  });
}

mount();
