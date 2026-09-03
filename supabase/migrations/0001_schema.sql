-- Trailer Cert - tables
--
-- Run this first, then 0002_rls.sql, then 0003_storage.sql.
--
-- Shape notes, because a few choices here are deliberate and would be easy to
-- "tidy" into something that breaks the phone:
--
-- 1. Ids are text, not uuid. The app generates its own ids offline, before the
--    server has ever seen the record, and its fallback for a browser without
--    crypto.randomUUID is "<timestamp>-<random>", which is not a uuid. A uuid
--    column would reject those rows at the moment the phone finally got signal.
--
-- 2. The nested groups - plate, power, tests, equipment, ccew - stay as jsonb
--    in exactly the shape the app already holds them. Flattening them into
--    columns would mean a migration on both sides for every field added to a
--    form, and none of them are searched on their own.
--
-- 3. There are two timestamps, and they do different jobs:
--      updated_at         when the phone last edited the row. Used to decide
--                         who wins when both devices touched the same job.
--      server_updated_at  when the server last wrote the row, set by trigger.
--                         Used as the "give me everything since X" cursor.
--    They must not be collapsed into one. A phone with a wrong clock - which
--    happens, especially after a flat battery - would otherwise hand out a
--    cursor from the future and silently stop pulling anything at all.
--
-- 4. Deletes are soft. A job deleted on the phone has to stay deleted when the
--    laptop next syncs; without a tombstone the laptop would helpfully push it
--    back up and it would reappear on the phone.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- jobs

create table if not exists public.jobs (
  id                text primary key,
  owner_id          uuid not null references auth.users (id) on delete cascade,

  vin               text not null default '',
  vin_valid         boolean not null default false,
  vin_source        text not null default 'manual',

  plate             jsonb not null default '{}'::jsonb,
  power             jsonb not null default '{}'::jsonb,
  tests             jsonb not null default '{}'::jsonb,
  equipment         jsonb not null default '[]'::jsonb,
  ccew              jsonb not null default '{}'::jsonb,

  install_type      text not null default '',
  ecert             text not null default 'N',
  status            text not null default 'draft',

  written_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  deleted_at        timestamptz,

  constraint jobs_status_known check (status in ('draft', 'tested', 'submitted', 'in-sheet')),
  constraint jobs_ecert_known  check (ecert in ('Y', 'N'))
);

comment on column public.jobs.updated_at is
  'Client edit time. Decides the winner when both devices edited the same job.';
comment on column public.jobs.server_updated_at is
  'Server write time, set by trigger. The sync cursor. Never set this from the client.';
comment on column public.jobs.deleted_at is
  'Tombstone. Rows are never hard deleted, or a deleted job returns on the next sync.';

-- ---------------------------------------------------------------- photos

-- The image itself lives in Storage; this table is the index. Splitting them
-- keeps a job list cheap to pull over a phone connection - the app can show the
-- whole logbook without dragging tens of megabytes of JPEG down with it.

create table if not exists public.photos (
  id                text primary key,
  job_id            text not null references public.jobs (id) on delete cascade,
  owner_id          uuid not null references auth.users (id) on delete cascade,

  kind              text not null,
  caption           text not null default '',
  bytes             integer not null default 0,
  content_type      text not null default 'image/jpeg',

  -- <owner_id>/<job_id>/<photo_id>.jpg, matching the Storage policies in 0003.
  storage_path      text not null,

  taken_at          timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  deleted_at        timestamptz
);

-- ---------------------------------------------------------------- settings

-- Electrician details, customer defaults and the install description presets,
-- so a second device does not start blank.
--
-- The Vision API key is deliberately NOT synced. It is left out of the backup
-- zip for the same reason, and the two decisions should stay together: it is a
-- billable Google credential, and the fewer places it is copied to the better.
-- It is typed once per device in Setup. Revisit only on purpose.

create table if not exists public.user_settings (
  owner_id          uuid primary key references auth.users (id) on delete cascade,
  settings          jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- indexes

-- The sync pull is always "my rows, changed since this cursor", so the index
-- has to lead with owner and then the server clock.
create index if not exists jobs_sync_idx    on public.jobs   (owner_id, server_updated_at);
create index if not exists photos_sync_idx  on public.photos (owner_id, server_updated_at);

create index if not exists photos_job_idx   on public.photos (job_id);

-- Finding a trailer by plate is the one lookup done by hand.
create index if not exists jobs_vin_idx     on public.jobs   (owner_id, vin) where vin <> '';

-- Live rows only, for the job list.
create index if not exists jobs_live_idx    on public.jobs   (owner_id, created_at) where deleted_at is null;

-- ---------------------------------------------------------------- triggers

-- server_updated_at is the sync cursor, so it must be the server's opinion and
-- never the client's. Forcing it in a BEFORE trigger means a client that sends
-- its own value - or an old value, or none - cannot corrupt the cursor.
create or replace function public.touch_server_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := now();
  return new;
end;
$$;

drop trigger if exists jobs_touch_server on public.jobs;
create trigger jobs_touch_server
  before insert or update on public.jobs
  for each row execute function public.touch_server_updated_at();

drop trigger if exists photos_touch_server on public.photos;
create trigger photos_touch_server
  before insert or update on public.photos
  for each row execute function public.touch_server_updated_at();

drop trigger if exists user_settings_touch_server on public.user_settings;
create trigger user_settings_touch_server
  before insert or update on public.user_settings
  for each row execute function public.touch_server_updated_at();

-- owner_id is never sent by the client either. Defaulting it from the JWT means
-- a row cannot be written into someone else's account even by mistake, and the
-- insert policy in 0002 then has nothing to disagree with.
create or replace function public.set_owner_from_jwt()
returns trigger
language plpgsql
as $$
begin
  if new.owner_id is null then
    new.owner_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_set_owner on public.jobs;
create trigger jobs_set_owner
  before insert on public.jobs
  for each row execute function public.set_owner_from_jwt();

drop trigger if exists photos_set_owner on public.photos;
create trigger photos_set_owner
  before insert on public.photos
  for each row execute function public.set_owner_from_jwt();
