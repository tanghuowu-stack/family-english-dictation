-- Run this file manually in Supabase SQL Editor.
-- Fix S3: uploadLocalDataToCloud 是 libraries → user_library_settings → words →
-- dictation_sessions → user_word_progress 五步串行写入，不是数据库事务。
-- 这两个字段不改变写入方式本身，而是让"这批数据是否完整跑完"变得可检测——
-- 而不是像之前那样，简单地认为"只要 sessions 表有记录就是完整的"。
-- default true 是为了不把迁移前已经存在的旧数据误判为"不完整"。

alter table public.libraries
  add column if not exists upload_batch_id uuid;

alter table public.libraries
  add column if not exists upload_complete boolean default true;

comment on column public.libraries.upload_batch_id is
  '最近一次 uploadLocalDataToCloud 对该词库发起的上传批次 id，配合 upload_complete 判断该批次是否完整跑完。';

comment on column public.libraries.upload_complete is
  '本次上传批次（words/sessions/user_word_progress 全部写完）是否完整；上传开始时置 false，三步全部无失败后置 true。';
