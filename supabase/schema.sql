create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text default 'parent',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.libraries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  name text not null,
  description text,
  visibility text default 'private',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.words (
  id uuid primary key default gen_random_uuid(),
  library_id uuid references public.libraries(id) on delete cascade,
  original_no integer,
  entry_text text not null,
  meaning text,
  sort_order integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.user_library_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  library_id uuid references public.libraries(id) on delete cascade,
  daily_target_words integer default 30,
  daily_review_words integer default 30,
  review_delay_days integer default 15,
  pause_new_words boolean default false,
  speech_rate numeric default 0.9,
  speech_voice text,
  settings_json jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  unique (user_id, library_id)
);

create table if not exists public.dictation_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  library_id uuid references public.libraries(id) on delete cascade,
  day_number integer not null,
  record_date date,
  task_word_ids uuid[] default '{}',
  new_word_ids uuid[] default '{}',
  pending_wrong_word_ids uuid[] default '{}',
  review_word_ids uuid[] default '{}',
  wrong_word_ids uuid[] default '{}',
  total_count integer default 0,
  wrong_count integer default 0,
  accuracy numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.user_word_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  library_id uuid references public.libraries(id) on delete cascade,
  word_id uuid references public.words(id) on delete cascade,
  first_learn_day integer,
  wrong_count integer default 0,
  is_pending_wrong boolean default false,
  correct_streak integer default 0,
  wrong_review_due_day integer,
  wrong_review_stage integer default 0,
  last_exited_wrong_pool_day integer,
  manual_focus boolean,
  manual_stubborn boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, library_id, word_id)
);

create table if not exists public.draft_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  library_id uuid references public.libraries(id) on delete cascade,
  day_number integer,
  record_date date,
  task_data jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, library_id)
);

alter table public.profiles enable row level security;
alter table public.libraries enable row level security;
alter table public.words enable row level security;
alter table public.user_library_settings enable row level security;
alter table public.dictation_sessions enable row level security;
alter table public.user_word_progress enable row level security;
alter table public.draft_tasks enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "libraries_select_own" on public.libraries;
create policy "libraries_select_own" on public.libraries
  for select to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "libraries_insert_own" on public.libraries;
create policy "libraries_insert_own" on public.libraries
  for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "libraries_update_own" on public.libraries;
create policy "libraries_update_own" on public.libraries
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "libraries_delete_own" on public.libraries;
create policy "libraries_delete_own" on public.libraries
  for delete to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "words_select_owned_library" on public.words;
create policy "words_select_owned_library" on public.words
  for select to authenticated
  using (exists (
    select 1 from public.libraries
    where libraries.id = words.library_id
      and libraries.owner_id = (select auth.uid())
  ));

drop policy if exists "words_insert_owned_library" on public.words;
create policy "words_insert_owned_library" on public.words
  for insert to authenticated
  with check (exists (
    select 1 from public.libraries
    where libraries.id = words.library_id
      and libraries.owner_id = (select auth.uid())
  ));

drop policy if exists "words_update_owned_library" on public.words;
create policy "words_update_owned_library" on public.words
  for update to authenticated
  using (exists (
    select 1 from public.libraries
    where libraries.id = words.library_id
      and libraries.owner_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.libraries
    where libraries.id = words.library_id
      and libraries.owner_id = (select auth.uid())
  ));

drop policy if exists "words_delete_owned_library" on public.words;
create policy "words_delete_owned_library" on public.words
  for delete to authenticated
  using (exists (
    select 1 from public.libraries
    where libraries.id = words.library_id
      and libraries.owner_id = (select auth.uid())
  ));

drop policy if exists "settings_access_own" on public.user_library_settings;
create policy "settings_access_own" on public.user_library_settings
  for all to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.libraries
      where libraries.id = user_library_settings.library_id
        and libraries.owner_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.libraries
      where libraries.id = user_library_settings.library_id
        and libraries.owner_id = (select auth.uid())
    )
  );

drop policy if exists "sessions_access_own" on public.dictation_sessions;
create policy "sessions_access_own" on public.dictation_sessions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "progress_access_own" on public.user_word_progress;
create policy "progress_access_own" on public.user_word_progress
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "drafts_access_own" on public.draft_tasks;
create policy "drafts_access_own" on public.draft_tasks
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.libraries to authenticated;
grant select, insert, update, delete on public.words to authenticated;
grant select, insert, update, delete on public.user_library_settings to authenticated;
grant select, insert, update, delete on public.dictation_sessions to authenticated;
grant select, insert, update, delete on public.user_word_progress to authenticated;
grant select, insert, update, delete on public.draft_tasks to authenticated;
