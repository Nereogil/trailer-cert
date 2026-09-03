-- Trailer Cert - row level security
--
-- Run after 0001_schema.sql.
--
-- The anon key that ships inside the app is public by design - it is in the
-- JavaScript, and anyone who opens the page has it. That is how Supabase is
-- meant to work, and it is not the thing keeping anyone out. These policies
-- are. Every row is fenced to the signed-in user at the database, so the anon
-- key on its own opens nothing: without a session, auth.uid() is null and every
-- policy below is false.
--
-- One deliberate omission: there is no DELETE policy anywhere. Deletes are soft
-- everywhere in this app, because a hard delete on one device cannot be told
-- apart from "this row has not synced yet" on another, and the other device
-- would push the job back up. Refusing DELETE at the database means that can
-- never happen by accident. Genuine purging is a maintenance job, done from the
-- SQL editor on purpose, not something the app can do at three in the morning
-- on a phone with one bar of signal.

alter table public.jobs          enable row level security;
alter table public.photos        enable row level security;
alter table public.user_settings enable row level security;

-- Force RLS so that even a table owner connecting directly is subject to it.
alter table public.jobs          force row level security;
alter table public.photos        force row level security;
alter table public.user_settings force row level security;

-- ---------------------------------------------------------------- jobs

drop policy if exists jobs_select_own on public.jobs;
create policy jobs_select_own
  on public.jobs for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists jobs_insert_own on public.jobs;
create policy jobs_insert_own
  on public.jobs for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists jobs_update_own on public.jobs;
create policy jobs_update_own
  on public.jobs for update
  to authenticated
  using (owner_id = (select auth.uid()))
  -- WITH CHECK as well as USING, or a row could be updated into someone else's
  -- account: USING decides what may be read for the update, WITH CHECK decides
  -- what the result is allowed to look like.
  with check (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------- photos

drop policy if exists photos_select_own on public.photos;
create policy photos_select_own
  on public.photos for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists photos_insert_own on public.photos;
create policy photos_insert_own
  on public.photos for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists photos_update_own on public.photos;
create policy photos_update_own
  on public.photos for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------- settings

drop policy if exists settings_select_own on public.user_settings;
create policy settings_select_own
  on public.user_settings for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists settings_insert_own on public.user_settings;
create policy settings_insert_own
  on public.user_settings for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists settings_update_own on public.user_settings;
create policy settings_update_own
  on public.user_settings for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
