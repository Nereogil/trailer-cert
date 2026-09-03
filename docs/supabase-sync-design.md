# Sync and sign-in design

Written 2026-09-03, before any client code exists. The schema in `supabase/` is
built to this plan; changing the plan probably means changing the schema.

## What this has to solve

1. Jobs recorded on the phone are visible on the computer, and editable there,
   because the CCEW paperwork gets done at a desk.
2. Nothing is lost when Android wipes site storage after an update. This has
   already happened, so it is a requirement and not a worry.
3. The phone keeps working with no signal. Testing happens in yards and under
   trailers. An app that needs a server round trip to save a job would be worse
   than what exists today, and today's version is genuinely good at this.

(3) is the constraint that shapes everything else. It rules out treating the
server as the source of truth and the phone as a thin client.

## The shape

IndexedDB stays exactly where it is, as the working copy. Every save is local
and instant, online or not. A sync layer sits beside it and reconciles with
Supabase whenever there is a connection.

```
  phone  ──save──►  IndexedDB  ──push/pull──►  Supabase  ◄──push/pull──►  IndexedDB  ◄──save──  computer
                   (works offline)              (truth)                  (works offline)
```

## Signing in

### The base: email and password

Supabase Auth, one account, signups turned off after it is created (see
`supabase/README.md` step 5). This is what actually authenticates against the
database — the session it returns is what makes `auth.uid()` non-null and the
row policies pass.

### The passkey / fingerprint layer

Supabase Auth has **no native passkey support**. A passkey therefore cannot be
the thing that signs you in to Supabase, not without standing up server-side
WebAuthn verification in an Edge Function and minting custom JWTs — a large,
security-critical build for a single user.

The practical design instead: **the passkey unlocks a stored session.**

1. First run on a device: sign in with email and password. Supabase returns an
   access token (short lived) and a refresh token (long lived).
2. The app offers *"Unlock with fingerprint next time"*.
3. `navigator.credentials.create()` with a platform authenticator, user
   verification required, and the **PRF extension** requested.
4. PRF hands back a stable 32-byte secret bound to that credential. Run it
   through HKDF, get an AES-GCM key, encrypt the refresh token with it, store
   only the ciphertext and the credential id in IndexedDB.
5. Every later open: `navigator.credentials.get()` with the same PRF salt →
   same secret → decrypt the refresh token → `supabase.auth.setSession()`.

Windows Hello and Android fingerprint both drive this through the same API, so
one implementation covers both.

**Why PRF and not just "the fingerprint check passed":** without PRF, WebAuthn
tells you a verification succeeded but gives you no key material. The refresh
token would have to sit in IndexedDB in the clear, with the app merely choosing
to ask for a fingerprint first — which anyone with the unlocked device bypasses
by reading IndexedDB directly. PRF makes the lock real: the token is
cryptographically unreadable without the biometric.

**Needs verifying at build time.** PRF support is good in Chrome with Windows
Hello and on Android with Google Password Manager passkeys, but it is the one
part of this design I would not commit to without testing on both your actual
devices first. If PRF turns out to be unavailable, the honest fallback is
password entry each time rather than a fingerprint prompt that only pretends to
protect anything.

## Sync

### Tracking what changed

Two fields added to each local job record:

- `dirty` — set true on every local save, cleared once the server has it
- `syncedAt` — the `server_updated_at` the server reported

Plus a small `sync` store holding one cursor per table.

### The cycle

**Push first, then pull.** In that order, always: pushing first means local
edits get their server timestamp before the pull runs, so the pull cannot
clobber a change that had not been sent yet.

**Push** — every dirty row is upserted. The server's `BEFORE` trigger stamps
`server_updated_at`; the client never sends it.

**Pull** — `where server_updated_at > cursor order by server_updated_at`. RLS
already limits this to your rows, so the query does not mention the owner.

For each row that comes back:

- local row is dirty **and** its `updated_at` is newer → keep local, it will win
  on the next push
- otherwise → overwrite local

Then advance the cursor to the highest `server_updated_at` seen.

### Conflicts

Last write wins on `updated_at`. For one person with two devices this is right;
anything cleverer is a lot of machinery for a case that will essentially never
occur. It **can** drop an edit if the same job is genuinely edited on both
devices while both are offline. That is a real limitation and it is accepted
knowingly, not overlooked.

### Deletes

Soft, everywhere. Setting `deleted_at` is just another update and syncs like
one. The database refuses hard deletes outright (no DELETE policy), because a
hard delete on one device is indistinguishable from "hasn't synced yet" on the
other, and the other device would push the row straight back.

### Why two timestamps

`updated_at` is the phone's opinion and decides conflicts. `server_updated_at`
is the server's and drives the cursor. Collapsing them would mean a device with
a wrong clock — common after a flat battery — could hand out a cursor from the
future and silently stop pulling anything ever again. Silently is the problem:
it would look exactly like "no new jobs".

## Photos

Photos are immutable once taken, which makes them far easier than jobs: no
conflicts, ever.

- **Upload** on capture when online; otherwise queued and retried. The queue is
  just photos with `uploaded: false`.
- Storage path `<owner_id>/<job_id>/<photo_id>.jpg`, matching the bucket policies.
- **Download lazily.** A new device pulls photo *rows* immediately but fetches
  the images only when a job is opened, then caches them. Signing in on the
  computer must not start a 40 MB download.

The phone already holds the images it took, so lazy fetching costs it nothing.

## Getting the existing jobs up there

Everything currently on the phone predates all of this and needs a one-time
upload: mark every existing job dirty, and queue every existing photo.

This should be a **deliberate screen with progress**, not something that happens
quietly on first launch. It is roughly 40 MB of photos and it should not be
spent on mobile data without being asked. Run it on WiFi.

The backup zip is the safety net here — the upload changes nothing locally, and
if anything goes wrong the phone still holds everything.

## Build order

Each step leaves the app working:

1. Config and client; sign-in screen; session handling. No sync yet.
2. Jobs push and pull, with the cursor and conflict rules.
3. Photo upload queue.
4. Lazy photo download.
5. The one-time upload screen for existing data.
6. Passkey unlock, once PRF is confirmed on both devices.

## The account page

Settled 2026-09-04: this is a personal account screen, not a multi-user admin
console. One person, one account. It holds:

- Change password (Supabase `auth.updateUser`)
- Change email (goes through a confirmation mail to the new address)
- Electrician details — name, licence number, contact phone
- Customer and site defaults
- Which devices have a passkey enrolled, and a way to remove one

The electrician and customer details already exist in Setup and live in
`localStorage` per device. They move to the `user_settings` table so both
devices agree, and Setup becomes the local view of that synced row.

The Vision API key stays out of it, and stays per-device. Same reasoning as the
backup zip: it is a billable Google credential and copies of it should be few.

Removing a passkey matters more than it looks. A lost phone is the one case
where an enrolled passkey is a liability, and revoking it from the laptop needs
to be possible without a factory reset of anything.

## Settled

- **Windows Hello is available**, so passkeys are enrolled per device, both
  Windows and Android. PRF still needs verifying on the real hardware before it
  is relied on — see the passkey section above.
- **The computer can create jobs**, not just edit them. Sync is symmetric.
- **Region: Sydney (`ap-southeast-2`).**
- **Photos can come from the camera or the file picker** on both devices. Done
  already, ahead of any sync work.

## Open questions

- **How long should photos stay on the phone?** Once a job is in the spreadsheet
  and its photos are on the server, the phone could drop the local copies and
  free storage. Not needed now; worth knowing it is available.
- **What happens to a job created on the computer with no photos?** Nothing
  technically, but it is worth deciding whether that should be flagged in the
  list, since a certificate without plate evidence is unusual.
