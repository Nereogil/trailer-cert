-- Trailer Cert - photo storage
--
-- Run after 0002_rls.sql.
--
-- Photos are evidence attached to a certificate, so the bucket is private. A
-- public bucket would mean anyone holding a URL could read a customer's
-- compliance plate, and those URLs end up in caches, chat apps and browser
-- history. The app fetches images with the signed-in session instead, or asks
-- for a short-lived signed URL when it needs one for an <img> tag.
--
-- Paths are <owner_id>/<job_id>/<photo_id>.jpg. Leading with the owner id is
-- what makes the policies below cheap and total: the first path segment is the
-- account, so a single comparison fences the whole subtree.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-photos',
  'job-photos',
  false,
  -- The app downscales to 1600px at quality 0.8, which lands around 300 KB. Ten
  -- megabytes is far above anything it should ever send, and still low enough
  -- that a bug uploading the original camera file gets rejected rather than
  -- quietly eating the storage quota.
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------- policies

-- storage.foldername(name) splits the object path; element 1 is the first
-- folder, which by our convention is the owner's user id.

drop policy if exists job_photos_read_own on storage.objects;
create policy job_photos_read_own
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'job-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists job_photos_insert_own on storage.objects;
create policy job_photos_insert_own
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'job-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Update is allowed so an interrupted upload can be retried onto the same path
-- rather than leaving an orphan beside it. A photo is never edited otherwise.
drop policy if exists job_photos_update_own on storage.objects;
create policy job_photos_update_own
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'job-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'job-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Deliberately no delete policy, matching the tables: the photos row carries a
-- deleted_at tombstone and the file stays put. Storage is the cheap part, and a
-- photo destroyed because two devices disagreed about a sync is not recoverable
-- from anywhere. Clearing out genuinely dead files is a maintenance job.
