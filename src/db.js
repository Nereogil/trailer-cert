// IndexedDB, hand-wrapped. Two stores: jobs, and photos kept separately so a
// job can be read and written without dragging several megabytes of image
// blobs through every save.

const DB_NAME = 'trailer-cert';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('jobs')) {
        db.createObjectStore('jobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' });
        store.createIndex('jobId', 'jobId', { unique: false });
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
  };
}

export const putJob = (job) =>
  run('jobs', 'readwrite', (store) => store.put({ ...job, updatedAt: new Date().toISOString() }));

export const getJob = (id) => run('jobs', 'readonly', (store) => store.get(id));
export const allJobs = () => run('jobs', 'readonly', (store) => store.getAll());
export const deleteJob = (id) => run('jobs', 'readwrite', (store) => store.delete(id));

export const putPhoto = (photo) => run('photos', 'readwrite', (store) => store.put(photo));
export const deletePhoto = (id) => run('photos', 'readwrite', (store) => store.delete(id));
export const photosFor = (jobId) =>
  run('photos', 'readonly', (store) => store.index('jobId').getAll(IDBKeyRange.only(jobId)));
export const allPhotos = () => run('photos', 'readonly', (store) => store.getAll());

export async function deleteJobWithPhotos(jobId) {
  const photos = await photosFor(jobId);
  await Promise.all(photos.map((p) => deletePhoto(p.id)));
  await deleteJob(jobId);
}

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
