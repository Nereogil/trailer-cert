# Supabase setup

Everything needed to stand the backend up. Roughly fifteen minutes, all in the
browser. Nothing here touches the phone, and nothing here is reversible-by-
accident: the app carries on working entirely offline until it is pointed at a
project.

## 1. Create the project

1. <https://supabase.com> → sign in → **New project**
2. Name it `trailer-cert`
3. **Choose a region close to you** — Sydney (`ap-southeast-2`) for Australia.
   Every sync round trip pays this latency, and a phone on mobile data in a yard
   feels the difference between Sydney and Virginia.
4. Set a database password and put it in your password manager. It is not needed
   day to day, but it is the only way back into the database directly.
5. Free tier is correct to start. See *Cost* below.

## 2. Run the migrations

**SQL Editor** → **New query**, then paste and run each file in order. Order
matters — the policies in `0002` reference tables made in `0001`.

| Order | File | What it does |
|---|---|---|
| 1 | `migrations/0001_schema.sql` | Tables, indexes, triggers |
| 2 | `migrations/0002_rls.sql` | Locks every row to its owner |
| 3 | `migrations/0003_storage.sql` | Private photo bucket and its policies |

## 3. Check it

Paste `verify.sql` into the SQL editor and run it. **Every row must say PASS.**

The one that matters most is `row level security is on`. A table with policies
but RLS switched off is completely open, and the dashboard gives no hint that
anything is wrong.

## 4. Make your account

**Authentication** → **Users** → **Add user** → **Create new user**.

Use a real email and a strong password from your password manager. This is the
account both the phone and the computer sign into.

## 5. Close the door behind you — do not skip this

**Authentication** → **Sign In / Providers** → **Email** → turn **off**
**"Allow new users to sign up"**.

Until this is off, anyone who finds the app can create themselves an account.
They would not see your jobs — the policies in `0002` prevent that — but they
would have a login on your project and be able to consume your quota. There is
one user needed here, and it now exists.

While in that area, confirm **"Confirm email"** is on.

## 6. Wire the app up

**Project Settings** → **API**, and copy two values:

- **Project URL** — `https://<something>.supabase.co`
- **anon / public key** — a long `eyJ...` string

These go in `src/supabase-config.js` (not yet written — that comes with the
client work).

**The anon key is meant to be public.** It ships inside the JavaScript and
anyone opening the page can read it. That is how Supabase is designed. It is not
what keeps people out — the row level security policies in `0002` are. Without a
signed-in session, `auth.uid()` is null and every policy evaluates false, so the
key on its own opens nothing.

This is a genuinely different situation from the Google Vision key, which *is*
secret and must not be committed. Do not let the two get filed together.

## Cost

Free tier: 500 MB database, 1 GB file storage, 5 GB bandwidth per month.

Photos are downscaled to 1600 px at quality 0.8 before they are ever stored,
which lands around 300 KB. At roughly 30 trailers a month and four photos each:

- about **36 MB a month**
- so the free 1 GB is around **two years** of work
- the job rows themselves are negligible — a few MB over the same period

When it does fill up, the choices are Pro at US$25/month for 100 GB, or pruning
photos for jobs that are long since certified and in the spreadsheet. There is
no cliff — Supabase will tell you well before anything stops.

## What is deliberately not here

**The Google Vision API key is not synced.** It is left out of the backup zip for
the same reason: it is a billable Google credential, and the fewer copies of it
in the fewer places, the better. It gets typed once per device in Setup. That is
a decision, not an oversight — reverse it on purpose or not at all.

**No delete policies.** Deletes are soft everywhere. A hard delete on one device
is indistinguishable from "not synced yet" on the other, and the other device
would cheerfully push the row back. Refusing DELETE at the database means that
cannot happen. Real purging is a maintenance job, run by hand, on purpose.
