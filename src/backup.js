import { allJobs, allPhotos } from './db.js';
import { writeEntries, stringToEntry } from './zip.js';
import { get as getSettings } from './settings.js';

// Everything this phone knows, in one zip. The spreadsheet screen deliberately
// skips jobs already marked in-sheet, and photos come out a job at a time, so
// before this there was no way to get a finished job back off the phone at all.

const shortId = (id) => String(id ?? 'unknown').slice(0, 8);

// <VIN>-<short id> rather than the VIN alone: two trailers can carry the same
// plate text, and a job entered by hand may have no VIN yet.
const folderFor = (job) => `${job.vin || 'no-vin'}-${shortId(job.id)}`;

function readme(jobCount, photoCount, madeAt) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    'Trailer Cert backup',
    `Taken ${madeAt}`,
    '',
    `${plural(jobCount, 'job')}, ${plural(photoCount, 'photo')}.`,
    '',
    'jobs.json      Every job in full, including the ones already written to',
    '               the spreadsheet. This is the complete record.',
    'photos.json    Which photo belongs to which job.',
    'settings.json  Electrician, customer and install descriptions.',
    '               The Google Vision API key is NOT in here - retype it in Setup.',
    'photos/        One folder per job, named <VIN>-<short job id>.',
    '',
    'Keep this somewhere off the phone. The app holds everything in the browser,',
    'so a cleared browser or a lost phone takes the lot with it.',
  ].join('\n');
}

export function backupFilename(madeAt = new Date().toISOString()) {
  return `trailer-cert-backup-${madeAt.slice(0, 10)}.zip`;
}

// Split from buildBackup so the zip layout can be tested without standing up an
// IndexedDB: this half is handed plain arrays and gives back zip entries.
export async function assembleBackup({ jobs, photos, settings, madeAt = new Date().toISOString() }) {
  // The key is left out on purpose: a backup gets copied to a laptop and mailed
  // around, and a Google key riding along in a shared zip is a key on someone
  // else's machine. Everything else restores; the key is retyped once.
  const { visionApiKey, ...safeSettings } = settings;

  const byJob = new Map(jobs.map((job) => [job.id, job]));
  const counters = new Map();
  const index = [];
  const entries = {};

  for (const photo of photos) {
    const job = byJob.get(photo.jobId);
    // A photo whose job was deleted still goes in rather than being dropped on
    // the floor; orphans/ makes that obvious when the zip is opened.
    const folder = job ? folderFor(job) : `orphans/${shortId(photo.jobId)}`;

    const key = `${folder}/${photo.kind}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);

    const path = `photos/${folder}/${photo.kind}${n > 1 ? `-${n}` : ''}.jpg`;
    const bytes = new Uint8Array(await photo.blob.arrayBuffer());

    // Stored, not deflated. A JPEG is already compressed, so level 6 here would
    // burn seconds of phone CPU across a hundred photos to save nothing.
    entries[path] = [bytes, { level: 0 }];

    index.push({
      path,
      photoId: photo.id,
      jobId: photo.jobId,
      vin: job?.vin ?? '',
      kind: photo.kind,
      caption: photo.caption ?? '',
      takenAt: photo.takenAt ?? '',
      bytes: photo.bytes ?? bytes.length,
    });
  }

  entries['jobs.json'] = stringToEntry(JSON.stringify(jobs, null, 2));
  entries['photos.json'] = stringToEntry(JSON.stringify(index, null, 2));
  entries['settings.json'] = stringToEntry(JSON.stringify(safeSettings, null, 2));
  entries['README.txt'] = stringToEntry(readme(jobs.length, index.length, madeAt));

  return { entries, jobCount: jobs.length, photoCount: index.length, madeAt };
}

export async function buildBackup() {
  const [jobs, photos] = await Promise.all([allJobs(), allPhotos()]);
  const { entries, jobCount, photoCount, madeAt } = await assembleBackup({
    jobs,
    photos,
    settings: getSettings(),
  });

  return { bytes: writeEntries(entries), jobCount, photoCount, madeAt };
}
