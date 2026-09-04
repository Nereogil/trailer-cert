// The project this app talks to.
//
// The anon key is public by design. It ships inside the page and anyone who
// opens the app can read it - that is how Supabase works, and it is not what
// keeps anyone out. The row level security policies in supabase/0002_rls.sql
// are. Without a signed-in session auth.uid() is null, every policy evaluates
// false, and this key on its own opens nothing. Verified: an anonymous insert
// against this project is refused with 42501.
//
// The service_role key is a completely different animal - it bypasses RLS
// entirely. It must never appear in this file, this repo, or any browser.

export const SUPABASE_URL = 'https://ehvhbwyymuqmkzrjzwhp.supabase.co';

export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVodmhid3l5bXVxbWt6cmp6d2hwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0Njk2ODEsImV4cCI6MjEwNDA0NTY4MX0.A3r8toTA0t0TEs6rt24QgbN4gcR5wxATRTdgNj7YJmQ';

// Photos bucket, created by supabase/migrations/0003_storage.sql. Private.
export const PHOTO_BUCKET = 'job-photos';
