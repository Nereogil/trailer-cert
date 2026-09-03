// IndexedDB, hand-wrapped. Three stores: jobs; photos, kept separately so a job
// can be read and written without dragging several megabytes of image blobs
// through every save; and sync, which holds the cursors the server exchange
// needs.
//
// Deletes are soft. A job removed on the phone has to stay removed when the
// laptop next syncs, and a hard delete cannot be told apart from "this row has
// not arrived yet" - the other device would helpfully push it back. So a delete
// sets deletedAt and the row stays as a tombstone. The photo blob is dropped at
// the same time, because the tombstone is what sync needs and the megabytes are
// not.

const DB_NAME = 'trailer-cert';
const DB_VERSION = 2;

let dbPromise = null;

// Everything already on this device predates the server, so all of it is unsent.
// Marking it here is what makes the first sync upload the whole logbook rather
// than quietly ignoring every job recorded before today.
function markExistingUnsent(transaction) {
  transaction.objectStore('jobs').openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;
    const job = cursor.value;
    if (job.dirty === undefined) {
      job.dirty = true;
      job.syncedAt = null;
      job.deletedAt = job.deletedAt ?? null;
      cursor.update(job);
    }
    cursor.continue();
  };

  transaction.objectStore('photos').openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;
    const photo = cursor.value;
    if (photo.uploaded === undefined) {
      photo.uploaded = false;
      photo.deletedAt = photo.deletedAt ?? null;
      cursor.update(photo);
    }
    cursor.continue();
  };
}

function open() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;

      if (!db.objectStoreNames.contains('jobs')) {
        db.createObjectStore('jobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' });
        store.createIndex('jobId', 'jobId', { unique: false });
      }

      if (event.oldVersion < 2) {
        if (!db.objectStoreNames.contains('sync')) {
          db.createObjectStore('sync', { keyPath: 'key' });
        }
        // oldVersion 0 is a brand new database, with nothing in it to mark.
        if (event.oldVersion >= 1) markExistingUnsent(request.transaction);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Another tab is holding the database open.'));
  });

  return dbPromise;
}

function run(storeName, mode, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = work(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function emptyJob() {
  const now = new Date().toISOString();
  return {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    vin: '',
    vinValid: false,
    vinSource: 'manual',
    plate: {
      manufacturer: null, bodySizeCm: null, totalSizeCm: null,
      mm: null, yy: null, maxSpeedKmh: null,
      atmKg: null, gtmKg: null, tareKg: null, axleCapacityKg: null,
      rawText: '',
    },
    power: { inverterW: null, batteryAh: null },
    tests: {
      date: '', rcdTripMs: null, rcdTripCurrentMa: null,
      insulationMohm: null, earthContinuityOhm: null,
      polarity: '', performed: [], notes: '',
    },
    equipment: [],
    ccew: { certificateNo: '', submissionDate: '', testCompletedDate: '', sourceFile: '' },
    installType: '',
    ecert: 'N',
    status: 'draft',
    // Sync bookkeeping. dirty means "this device has changes the server has not
    // seen yet"; syncedAt is the server clock value the row was last seen at.
    dirty: true,
    syncedAt: null,
    deletedAt: null,
  };
}

const live = (rows) => rows.filter((row) => !row.deletedAt);

// Every local edit marks the row unsent. Rows arriving from the server go
// through putJobFromServer instead, or one would immediately look like a local
// change and be pushed straight back up again.
export const putJob = (job) =>
  run('jobs', 'readwrite', (store) =>
    store.put({ ...job, updatedAt: new Date().toISOString(), dirty: true })
  );

export const putJobFromServer = (job) =>
  run('jobs', 'readwrite', (store) => store.put({ ...job, dirty: false }));

export const getJob = (id) => run('jobs', 'readonly', (store) => store.get(id));

export const allJobs = () =>
  run('jobs', 'readonly', (store) => store.getAll()).then(live);

// Tombstones included. Sync needs them; nothing else does.
export const allJobsWithDeleted = () => run('jobs', 'readonly', (store) => store.getAll());

export const dirtyJobs = () =>
  run('jobs', 'readonly', (store) => store.getAll()).then((rows) => rows.filter((r) => r.dirty));

export const putPhoto = (photo) =>
  run('photos', 'readwrite', (store) => store.put({ uploaded: false, deletedAt: null, ...photo }));

export const putPhotoFromServer = (photo) =>
  run('photos', 'readwrite', (store) => store.put({ ...photo, uploaded: true }));

export const photosFor = (jobId) =>
  run('photos', 'readonly', (store) =>
    store.index('jobId').getAll(IDBKeyRange.only(jobId))
  ).then(live);

export const allPhotos = () =>
  run('photos', 'readonly', (store) => store.getAll()).then(live);

export const allPhotosWithDeleted = () => run('photos', 'readonly', (store) => store.getAll());

// Photos still waiting to go up. One with no blob cannot be uploaded - that is
// a tombstone whose image has already been dropped - so it stays out of the queue.
export const pendingPhotos = () =>
  run('photos', 'readonly', (store) => store.getAll()).then((rows) =>
    rows.filter((r) => !r.uploaded && !r.deletedAt && r.blob)
  );

async function softDelete(storeName, id, extra = {}) {
  const row = await run(storeName, 'readonly', (store) => store.get(id));
  if (!row) return;
  await run(storeName, 'readwrite', (store) =>
    store.put({ ...row, ...extra, deletedAt: new Date().toISOString(), dirty: true })
  );
}

// The blob goes now rather than at some later tidy-up: the tombstone is the part
// sync needs, and on a phone the megabytes are the part worth reclaiming.
export const deletePhoto = (id) => softDelete('photos', id, { blob: null });
export const deleteJob = (id) => softDelete('jobs', id);

export async function deleteJobWithPhotos(jobId) {
  const photos = await photosFor(jobId);
  await Promise.all(photos.map((p) => deletePhoto(p.id)));
  await deleteJob(jobId);
}

// ------------------------------------------------------------------- sync

export const getSyncState = (key) =>
  run('sync', 'readonly', (store) => store.get(key)).then((row) => row?.value ?? null);

export const setSyncState = (key, value) =>
  run('sync', 'readwrite', (store) => store.put({ key, value }));

// ------------------------------------------------------------------ storage

export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage: usage ?? 0, quota: quota ?? 0 };
}

// Ask the browser not to evict this origin's data when storage runs low. The
// answer is advisory and often "no" without an install, so nothing depends on it.
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
