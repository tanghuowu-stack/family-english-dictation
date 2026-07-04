-- Run this file manually in Supabase SQL Editor.
-- Fix R10: skipDelayedReviewSchedule（R2 里让"跳过延迟复查"真正生效用到的标记）和
-- delayedReviewPostponed（错词本里"已顺延到期"展示用的标记）之前完全没有云端列，
-- 会在跨设备同步/恢复时丢失。
-- This migration only adds nullable columns. It does not delete, truncate, or overwrite existing rows.

alter table public.user_word_progress
  add column if not exists skip_delayed_review_schedule boolean;

alter table public.user_word_progress
  add column if not exists delayed_review_postponed boolean;

comment on column public.user_word_progress.skip_delayed_review_schedule is
  '该词退出错词池、准备安排 15 天后复查时，是否跳过本次安排（由快速校准/补录时勾选"跳过延迟复查"产生）。';

comment on column public.user_word_progress.delayed_review_postponed is
  '该词到期错词复查是否因为当天名额已满被顺延到后续（仅用于错词本页面展示"已顺延到期"标签）。';
