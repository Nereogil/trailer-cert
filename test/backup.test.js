import { describe, it, expect, beforeAll } from 'vitest';
import { readEntries, entryToString } from '../src/zip.js';
import { writeEntries } from '../src/zip.js';
import { assembleBackup, backupFilename } from '../src/backup.js';

const blobOf = (size) => new Blob([new Uint8Array(Array.from({ length: size }, (_, i) => i & 0xff))]);

const JOBS = [
  {
    id: 'aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa',
    vin: 'R33PD1347TA900017',
    status: 'in-sheet',
    tests: { date: '2026-08-24' },
  },
  {
    id: 'bbbbbbbb-2222-4444-8888-bbbbbbbbbbbb',
    vin: '',
    status: 'draft',
    tests: { date: '' },
  },
];

const PHOTOS = [
  { id: 'p1', jobId: JOBS[0].id, kind: 'plate', caption: '', takenAt: '2026-08-24T01:00:00.000Z', bytes: 4, blob: blobOf(4) },
  { id: 'p2', jobId: JOBS[0].id, kind: 'plate', caption: 'second angle', takenAt: '2026-08-24T01:01:00.000Z', bytes: 5, blob: blobOf(5) },
  { id: 'p3', jobId: JOBS[1].id, kind: 'tester', caption: '', takenAt: '2026-08-24T02:00:00.000Z', bytes: 6, blob: blobOf(6) },
  { id: 'p4', jobId: 'deleted-job-9999', kind: 'plate', caption: '', takenAt: '2026-08-24T03:00:00.000Z', bytes: 7, blob: blobOf(7) },
];

const API_KEY = 'AIzaSyTOPSECRETKEYVALUE';

const SETTINGS = {
  visionApiKey: API_KEY,
  electrician: { name: 'Nereo', licence: '12345', phone: '0400000000' },
  customer: { name: 'Acme Campers', company: 'Acme', email: 'a@b.c', siteAddress: '1 Test St' },
  descriptionPresets: ['Existing Double pole twin outlets'],
};

let entries;
let unzipped;

beforeAll(async () => {
  const built = await assembleBackup({
    jobs: JOBS,
    photos: PHOTOS,
    settings: SETTINGS,
    madeAt: '2026-09-03T04:05:06.000Z',
  });
  entries = built.entries;
  unzipped = readEntries(writeEntries(built.entries));
});

describe('assembleBackup', () => {
  it('keeps every job, including ones already written to the spreadsheet', () => {
    const jobs = JSON.parse(entryToString(unzipped['jobs.json']));
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.id)).toEqual(JOBS.map((j) => j.id));
    // The spreadsheet screen skips in-sheet jobs on purpose; the backup must not.
    expect(jobs.some((j) => j.status === 'in-sheet')).toBe(true);
  });

  it('never lets the Vision API key into the zip', () => {
    const stored = JSON.parse(entryToString(unzipped['settings.json']));
    expect(stored).not.toHaveProperty('visionApiKey');
    expect(stored.electrician.licence).toBe('12345');

    // Belt and braces: no entry anywhere carries the key once decompressed.
    for (const [path, bytes] of Object.entries(unzipped)) {
      expect(entryToString(bytes), `${path} leaked the key`).not.toContain(API_KEY);
    }
  });

  it('folders photos by VIN and short job id, numbering repeats of a kind', () => {
    expect(unzipped).toHaveProperty('photos/R33PD1347TA900017-aaaaaaaa/plate.jpg');
    expect(unzipped).toHaveProperty('photos/R33PD1347TA900017-aaaaaaaa/plate-2.jpg');
    expect(unzipped['photos/R33PD1347TA900017-aaaaaaaa/plate.jpg']).toHaveLength(4);
    expect(unzipped['photos/R33PD1347TA900017-aaaaaaaa/plate-2.jpg']).toHaveLength(5);
  });

  it('still files a photo whose job has no VIN', () => {
    expect(unzipped).toHaveProperty('photos/no-vin-bbbbbbbb/tester.jpg');
  });

  it('keeps a photo whose job was deleted rather than dropping it', () => {
    expect(unzipped).toHaveProperty('photos/orphans/deleted-/plate.jpg');
  });

  it('indexes each photo back to its job', () => {
    const index = JSON.parse(entryToString(unzipped['photos.json']));
    expect(index).toHaveLength(4);

    const first = index.find((p) => p.photoId === 'p1');
    expect(first.jobId).toBe(JOBS[0].id);
    expect(first.vin).toBe('R33PD1347TA900017');
    expect(first.path).toBe('photos/R33PD1347TA900017-aaaaaaaa/plate.jpg');

    const orphan = index.find((p) => p.photoId === 'p4');
    expect(orphan.vin).toBe('');
  });

  it('counts what it packed', async () => {
    const built = await assembleBackup({ jobs: JOBS, photos: PHOTOS, settings: SETTINGS });
    expect(built.jobCount).toBe(2);
    expect(built.photoCount).toBe(4);
  });

  it('survives a phone with nothing on it yet', async () => {
    const built = await assembleBackup({ jobs: [], photos: [], settings: SETTINGS });
    const empty = readEntries(writeEntries(built.entries));
    expect(JSON.parse(entryToString(empty['jobs.json']))).toEqual([]);
    expect(built.photoCount).toBe(0);
  });
});

describe('backupFilename', () => {
  it('names the file for the day it was taken', () => {
    expect(backupFilename('2026-09-03T04:05:06.000Z')).toBe('trailer-cert-backup-2026-09-03.zip');
  });
});

describe('a backup taken on a device that did not take the photos', () => {
  // Since sync arrived a photo can be known about without being held: the row
  // came down but the image is still on the server. The backup is what you
  // reach for when everything else has gone wrong, so a missing image must not
  // be able to take the whole thing down with it.
  const NO_IMAGE = { ...PHOTOS[0], id: 'remote-1', blob: null, storagePath: 'user-9/j/remote-1.jpg' };

  it('does not throw on a photo it has no image for', async () => {
    await expect(
      assembleBackup({ jobs: JOBS, photos: [NO_IMAGE], settings: SETTINGS })
    ).resolves.toBeTruthy();
  });

  it('still packs every image it does hold', async () => {
    const built = await assembleBackup({
      jobs: JOBS,
      photos: [...PHOTOS, NO_IMAGE],
      settings: SETTINGS,
    });
    expect(built.photoCount).toBe(PHOTOS.length);
    expect(built.missingImages).toBe(1);
  });

  it('says so in the readme rather than quietly leaving them out', async () => {
    const built = await assembleBackup({ jobs: JOBS, photos: [NO_IMAGE], settings: SETTINGS });
    const readme = entryToString(readEntries(writeEntries(built.entries))['README.txt']);
    expect(readme).toMatch(/had no image/i);
    expect(readme).toMatch(/1 photo/);
  });

  it('says nothing when every image was present', async () => {
    const built = await assembleBackup({ jobs: JOBS, photos: PHOTOS, settings: SETTINGS });
    const readme = entryToString(readEntries(writeEntries(built.entries))['README.txt']);
    expect(readme).not.toMatch(/had no image/i);
  });
});
