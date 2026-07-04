-- Run this file manually in Supabase SQL Editor.
-- Fix S5: 手动标记的"重点/顽固"状态之前完全没有云端列，会在跨设备同步中丢失。
-- This migration only adds nullable columns. It does not delete, truncate, or overwrite existing rows.
-- null 表示用户没有手动覆盖过，沿用 wrongCount 阈值推导；true/false 表示用户手动设置过。

alter table public.user_word_progress
  add column if not exists manual_focus boolean;

alter table public.user_word_progress
  add column if not exists manual_stubborn boolean;

comment on column public.user_word_progress.manual_focus is
  '用户手动设置的"重点"标记：null=未手动设置（按 wrong_count>=2 推导），true/false=手动覆盖。';

comment on column public.user_word_progress.manual_stubborn is
  '用户手动设置的"顽固"标记：null=未手动设置（按 wrong_count>=3 推导），true/false=手动覆盖。';
