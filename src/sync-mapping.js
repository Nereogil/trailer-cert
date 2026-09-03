// Translating between the shape the app holds a job in and the shape the
// database stores it as. Kept apart from the sync itself so the mapping can be
// tested without a network, a database or a signed-in user - which is most of
// what can quietly go wrong when a field is added to a form and forgotten
// everywhere else.
//
// Two things are deliberately never sent to the server:
//
//   owner_id           a BEFORE trigger fills it from the JWT. A client that
//                      cannot name an owner cannot write into someone else's.
//   server_updated_at  the sync cursor. It is the server's opinion of when the
//                      row was written, and a client that could set it could
//                      make itself invisible to its own next pull.

import { emptyJob } from './db.js';

// Local field -> column, for the flat ones. The nested groups (plate, power,
// tests, equipment, ccew) are stored as jsonb under their own names and need no
// translation, which is exactly why they were left nested.
const SCALARS = [
  ['vin', 'vin'],
  ['vinValid', 'vin_valid'],
  ['vinSource', 'vin_source'],
  ['installType', 'install_type'],
  ['ecert', 'ecert'],
  ['status', 'status'],
];

const GROUPS = ['plate', 'power', 'tests', 'equipment', 'ccew'];

const TIMES = [
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['writtenAt', 'written_at'],
  ['deletedAt', 'deleted_at'],
];

// A timestamp that never happened is null in the database, not an empty string:
// '' is not a timestamptz and the insert would be rejected outright.
const timeOut = (value) => (value ? value : null);
const timeIn = (value) => value ?? null;

export function jobToRow(job) {
  const row = { id: job.id };

  for (const [local, column] of SCALARS) row[column] = job[local] ?? null;
  for (const group of GROUPS) row[group] = job[group] ?? (group === 'equipment' ? [] : {});
  for (const [local, column] of TIMES) row[column] = timeOut(job[local]);

  return row;
}

export function rowToJob(row) {
  // Start from the current empty job so a column the server has not heard of
  // yet - an older row, written before a field was added - still arrives with
  // that field present and at its default, rather than undefined.
  const job = emptyJob();
  job.id = row.id;

  for (const [local, column] of SCALARS) {
    if (row[column] !== null && row[column] !== undefined) job[local] = row[column];
  }
  for (const group of GROUPS) {
    if (row[group] !== null && row[group] !== undefined) job[group] = row[group];
  }
  for (const [local, column] of TIMES) job[local] = timeIn(row[column]);

  // Book-keeping the server owns. syncedAt is the cursor value this row was
  // seen at; dirty is false because it has just come from the server.
  job.syncedAt = row.server_updated_at ?? null;
  job.dirty = false;

  return job;
}

// ------------------------------------------------------------------ photos

// The image itself goes to Storage, never into a column, so the blob is absent
// from the row on purpose.
export function storagePathFor(ownerId, jobId, photoId) {
  return `${ownerId}/${jobId}/${photoId}.jpg`;
}

export function photoToRow(photo, ownerId) {
  return {
    id: photo.id,
    job_id: photo.jobId,
    kind: photo.kind,
    caption: photo.caption ?? '',
    bytes: photo.bytes ?? photo.blob?.size ?? 0,
    content_type: photo.blob?.type || 'image/jpeg',
    storage_path: photo.storagePath ?? storagePathFor(ownerId, photo.jobId, photo.id),
    taken_at: timeOut(photo.takenAt),
    deleted_at: timeOut(photo.deletedAt),
  };
}

export function rowToPhoto(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    caption: row.caption ?? '',
    bytes: row.bytes ?? 0,
    contentType: row.content_type ?? 'image/jpeg',
    storagePath: row.storage_path,
    takenAt: timeIn(row.taken_at),
    deletedAt: timeIn(row.deleted_at),
    syncedAt: row.server_updated_at ?? null,
    // No blob. A device that did not take this photo fetches the image only
    // when the job is opened, so signing in on the laptop does not start a
    // forty megabyte download.
    blob: null,
    uploaded: true,
  };
}

// ------------------------------------------------------------------ conflict

// Last write wins on the client's own updated_at. The server clock is not used
// here: it records when a row was *received*, which on a phone that spent the
// afternoon out of signal has nothing to do with when the work was done.
//
// A tie keeps the local copy. Ties happen when the same row comes back
// unchanged, and rewriting it would only clear a dirty flag that may still be
// needed.
export function serverWins(localJob, serverRow) {
  if (!localJob) return true;
  if (!localJob.dirty) return true;

  const local = Date.parse(localJob.updatedAt ?? '') || 0;
  const server = Date.parse(serverRow.updated_at ?? '') || 0;
  return server > local;
}
