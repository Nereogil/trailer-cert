-- Trailer Cert - post-migration check
--
-- Paste into the Supabase SQL editor after running the three migrations. Every
-- row should say PASS. Anything else means the app would either fail to sync or,
-- worse, sync into a table that is not actually fenced.

with checks as (

  select 'tables exist' as check,
         case when count(*) = 3 then 'PASS' else 'FAIL - found ' || count(*) || ' of 3' end as result
  from information_schema.tables
  where table_schema = 'public' and table_name in ('jobs', 'photos', 'user_settings')

  union all
  -- The important one. A table with policies but RLS switched off is wide open,
  -- and it looks completely fine in the dashboard.
  select 'row level security is on',
         case when count(*) = 3 then 'PASS' else 'FAIL - RLS off on some tables' end
  from pg_tables
  where schemaname = 'public'
    and tablename in ('jobs', 'photos', 'user_settings')
    and rowsecurity = true

  union all
  select 'policies present',
         case when count(*) = 9 then 'PASS' else 'FAIL - found ' || count(*) || ' of 9' end
  from pg_policies
  where schemaname = 'public' and tablename in ('jobs', 'photos', 'user_settings')

  union all
  -- No DELETE policy anywhere is deliberate: deletes are soft, so a hard delete
  -- must be impossible from the app.
  select 'no delete policy exists',
         case when count(*) = 0 then 'PASS' else 'FAIL - a delete policy was added' end
  from pg_policies
  where schemaname = 'public'
    and tablename in ('jobs', 'photos', 'user_settings')
    and cmd = 'DELETE'

  union all
  select 'sync cursor triggers present',
         case when count(*) = 3 then 'PASS' else 'FAIL - found ' || count(*) || ' of 3' end
  from pg_trigger
  where not tgisinternal
    and tgname in ('jobs_touch_server', 'photos_touch_server', 'user_settings_touch_server')

  union all
  select 'photo bucket exists',
         case when count(*) = 1 then 'PASS' else 'FAIL - bucket missing' end
  from storage.buckets where id = 'job-photos'

  union all
  -- A public bucket would hand out customer plates to anyone with a URL.
  select 'photo bucket is private',
         case when count(*) = 1 then 'PASS' else 'FAIL - bucket is PUBLIC' end
  from storage.buckets where id = 'job-photos' and public = false

  union all
  select 'storage policies present',
         case when count(*) = 3 then 'PASS' else 'FAIL - found ' || count(*) || ' of 3' end
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname like 'job_photos_%'
)
select check, result from checks order by (result <> 'PASS') desc, check;
