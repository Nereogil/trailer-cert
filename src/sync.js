// The reconciliation itself, deliberately knowing nothing about Supabase.
//
// It talks to a `remote` with two methods and a `local` with the shape of
// db.js, which means the whole push/pull cycle - the part where the
// interesting failures live - can be exercised without a network, a database
// or an account. The Supabase-flavoured `remote` is built elsewhere.

import * as realDb from './db.js';
import { jobToRow, rowToJob, rowToPhoto, serverWins } from './sync-mapping.js';

const JOBS_CURSOR = 'jobs';
const PHOTOS_CURSOR = 'photos';

const time = (value) => Date.parse(value ?? '') || 0;

// Push before pull, always.
//
// A local edit that has not been sent yet has to get its server timestamp
// before the pull runs. The other way round, the pull would find an older
// server copy of the same row, decide it was authoritative, and overwrite an
// edit that had never left the device.
export async function syncJobs(remote, local = realDb) {
  const pushed = await pushJobs(remote, local);
  const pulled = await pullJobs(remote, local);
  return { pushed, pulled };
}

export async function pushJobs(remote, local = realDb) {
  const dirty = await local.dirtyJobs();
  if (dirty.length === 0) return { sent: 0, deferred: 0 };

  const saved = await remote.upsertJobs(dirty.map(jobToRow));
  const byId = new Map(saved.map((row) => [row.id, row]));

  let sent = 0;
  let deferred = 0;

  for (const job of dirty) {
    const row = byId.get(job.id);
    if (!row) continue;

    const current = await local.getJob(job.id);
    if (!current) continue;

    // Edited again while the push was in flight. Clearing the flag now would
    // stranded that edit on this device for good, so leave it dirty and let the
    // next cycle carry it.
    if (current.updatedAt !== job.updatedAt) {
      deferred++;
      continue;
    }

    await local.putJobFromServer({ ...current, syncedAt: row.server_updated_at });
    sent++;
  }

  return { sent, deferred };
}

export async function pullJobs(remote, local = realDb) {
  const cursor = await local.getSyncState(JOBS_CURSOR);
  const rows = await remote.fetchJobsSince(cursor);

  let applied = 0;
  let keptLocal = 0;
  let echoed = 0;
  let newest = cursor;

  for (const row of rows) {
    // The cursor advances past every row that arrives, including ones this
    // device wins. A row held back is still dirty and goes up on the next push;
    // not advancing would mean fetching it again on every sync, for ever.
    if (time(row.server_updated_at) > time(newest)) newest = row.server_updated_at;

    const localJob = await local.getJob(row.id);

    // A row this device sent moments ago, coming straight back. The push
    // already recorded the stamp the server gave it, so an identical stamp
    // means this is our own write returning - there is nothing to learn from
    // it, and rewriting the local copy would put real data through a needless
    // round trip. It matters most on a first sync, where the whole logbook goes
    // up and would otherwise all come back down again.
    if (localJob?.syncedAt && localJob.syncedAt === row.server_updated_at) {
      echoed++;
      continue;
    }

    if (!serverWins(localJob, row)) {
      keptLocal++;
      continue;
    }

    await local.putJobFromServer(rowToJob(row));
    applied++;
  }

  if (newest && newest !== cursor) await local.setSyncState(JOBS_CURSOR, newest);

  return { applied, keptLocal, echoed, cursor: newest };
}

// ------------------------------------------------------------------- photos

// Photos are immutable once taken, so there is no conflict to resolve - only
// the question of whether the bytes have made it up yet, and whether this
// device happens to hold them.
export async function syncPhotos(remote, local = realDb) {
  const pushed = await pushPhotos(remote, local);
  const pulled = await pullPhotos(remote, local);
  return { pushed, pulled };
}

export async function pushPhotos(remote, local = realDb) {
  const pending = await local.pendingPhotos();

  let sent = 0;
  let failed = 0;

  for (const photo of pending) {
    try {
      // The file goes up before the row that points at it. The other order
      // leaves a row on the server referring to an image that does not exist,
      // and the laptop then fails every time it opens that job. This order's
      // worst case is an uploaded file nobody references yet, which costs a
      // few hundred kilobytes and nothing else.
      const stored = await remote.uploadPhoto(photo);

      await local.putPhotoFromServer({
        ...photo,
        storagePath: stored.storage_path,
        syncedAt: stored.server_updated_at,
        uploaded: true,
      });
      sent++;
    } catch (err) {
      // One photo that will not go up must not strand the rest of the queue
      // behind it - a single corrupt image would otherwise stop the whole
      // logbook backing up, quietly, for ever.
      console.error(`Photo ${photo.id} did not upload`, err);
      failed++;
    }
  }

  return { sent, failed };
}

export async function pullPhotos(remote, local = realDb) {
  const cursor = await local.getSyncState(PHOTOS_CURSOR);
  const rows = await remote.fetchPhotosSince(cursor);

  let applied = 0;
  let echoed = 0;
  let newest = cursor;

  for (const row of rows) {
    if (time(row.server_updated_at) > time(newest)) newest = row.server_updated_at;

    const existing = await local.getPhoto(row.id);
    if (existing?.syncedAt && existing.syncedAt === row.server_updated_at) {
      echoed++;
      continue;
    }

    // Rows arrive without an image - that is deliberate, so signing in on the
    // laptop does not pull forty megabytes down before showing anything. But
    // the phone that took the photo already holds the bytes, and writing the
    // incoming null over them would destroy the only copy that has not been
    // uploaded yet. Keep whatever this device already has.
    await local.putPhotoFromServer({
      ...rowToPhoto(row),
      blob: existing?.blob ?? null,
    });
    applied++;
  }

  if (newest && newest !== cursor) await local.setSyncState(PHOTOS_CURSOR, newest);

  return { applied, echoed, cursor: newest };
}

// Fetch the image for a photo this device knows about but has never held. Used
// when a job is opened on a device that did not take its photos.
export async function ensurePhotoBlob(photo, remote, local = realDb) {
  if (photo.blob) return photo.blob;
  if (!photo.storagePath) return null;

  const blob = await remote.downloadPhoto(photo.storagePath);
  await local.putPhotoFromServer({ ...photo, blob });
  return blob;
}
