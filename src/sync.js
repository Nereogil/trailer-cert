// The reconciliation itself, deliberately knowing nothing about Supabase.
//
// It talks to a `remote` with two methods and a `local` with the shape of
// db.js, which means the whole push/pull cycle - the part where the
// interesting failures live - can be exercised without a network, a database
// or an account. The Supabase-flavoured `remote` is built elsewhere.

import * as realDb from './db.js';
import { jobToRow, rowToJob, serverWins } from './sync-mapping.js';

const JOBS_CURSOR = 'jobs';

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
