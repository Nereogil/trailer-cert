import { describe, it, expect } from 'vitest';
import {
  jobToRow,
  rowToJob,
  photoToRow,
  rowToPhoto,
  storagePathFor,
  serverWins,
} from '../src/sync-mapping.js';

const JOB = {
  id: 'job-1',
  createdAt: '2026-08-24T01:00:00.000Z',
  updatedAt: '2026-08-24T02:00:00.000Z',
  vin: 'R33PD1347TA900017',
  vinValid: true,
  vinSource: 'scan',
  plate: { manufacturer: 'Acme', atmKg: 2000, rawText: 'ACME 2000' },
  power: { inverterW: 2000, batteryAh: 200 },
  tests: {
    date: '2026-08-24',
    rcdTripMs: 25,
    rcdTripCurrentMa: 30,
    polarity: 'Correct',
    performed: ['Polarity', 'Insulation resistance'],
    notes: 'all good',
  },
  equipment: [{ type: 'RCD', ratingA: 16, qty: 3, description: 'dual pole' }],
  ccew: { certificateNo: '26070056245', submissionDate: '2026-07-27' },
  installType: 'Caravan Trailer',
  ecert: 'Y',
  status: 'in-sheet',
  writtenAt: '2026-08-25T00:00:00.000Z',
};

describe('jobToRow', () => {
  const row = jobToRow(JOB);

  it('never sends owner_id - the trigger fills it from the token', () => {
    // A client that cannot name an owner cannot write into someone else's account.
    expect(row).not.toHaveProperty('owner_id');
  });

  it('never sends server_updated_at - that is the sync cursor', () => {
    // A client that could set the cursor could make its own rows invisible to
    // its next pull, and the loss would look exactly like "no new jobs".
    expect(row).not.toHaveProperty('server_updated_at');
  });

  it('renames the flat fields to their columns', () => {
    expect(row.vin_valid).toBe(true);
    expect(row.vin_source).toBe('scan');
    expect(row.install_type).toBe('Caravan Trailer');
    expect(row.written_at).toBe('2026-08-25T00:00:00.000Z');
  });

  it('passes the nested groups through untouched', () => {
    expect(row.tests.rcdTripMs).toBe(25);
    expect(row.tests.performed).toEqual(['Polarity', 'Insulation resistance']);
    expect(row.equipment[0].ratingA).toBe(16);
    expect(row.plate.atmKg).toBe(2000);
  });

  it('turns an absent timestamp into null, not an empty string', () => {
    // '' is not a timestamptz; the insert would be rejected outright.
    const fresh = jobToRow({ ...JOB, writtenAt: '', deletedAt: undefined });
    expect(fresh.written_at).toBe(null);
    expect(fresh.deleted_at).toBe(null);
  });

  it('sends a soft delete as a timestamp like any other update', () => {
    const gone = jobToRow({ ...JOB, deletedAt: '2026-09-01T00:00:00.000Z' });
    expect(gone.deleted_at).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('a job that goes to the server and comes back', () => {
  const round = rowToJob({ ...jobToRow(JOB), server_updated_at: '2026-08-24T02:00:05.000Z' });

  it('survives the trip unchanged', () => {
    for (const key of Object.keys(JOB)) {
      expect(round[key], `${key} did not survive the round trip`).toEqual(JOB[key]);
    }
  });

  it('comes back clean, carrying the cursor it was seen at', () => {
    expect(round.dirty).toBe(false);
    expect(round.syncedAt).toBe('2026-08-24T02:00:05.000Z');
  });

  it('fills in a field the stored row predates', () => {
    // An old row written before a form field existed must still arrive with
    // that field present at its default, never undefined.
    const old = jobToRow(JOB);
    delete old.power;
    delete old.ccew;
    const job = rowToJob(old);
    expect(job.power).toEqual({ inverterW: null, batteryAh: null });
    expect(job.ccew.certificateNo).toBe('');
  });
});

describe('photos', () => {
  const PHOTO = {
    id: 'ph-1',
    jobId: 'job-1',
    kind: 'plate',
    caption: 'second angle',
    bytes: 301244,
    takenAt: '2026-08-24T01:05:00.000Z',
    blob: { size: 301244, type: 'image/jpeg' },
  };

  it('files the image under the owner, then the job', () => {
    // The bucket policies fence on the first path segment, so the owner has to
    // lead or the whole storage rule stops working.
    expect(storagePathFor('user-9', 'job-1', 'ph-1')).toBe('user-9/job-1/ph-1.jpg');
  });

  it('keeps the blob out of the row', () => {
    const row = photoToRow(PHOTO, 'user-9');
    expect(row).not.toHaveProperty('blob');
    expect(row.storage_path).toBe('user-9/job-1/ph-1.jpg');
    expect(row.job_id).toBe('job-1');
    expect(row.bytes).toBe(301244);
  });

  it('comes back without an image, to be fetched when the job is opened', () => {
    // Signing in on the laptop must not start a forty megabyte download.
    const photo = rowToPhoto({
      id: 'ph-1', job_id: 'job-1', kind: 'plate', caption: '',
      bytes: 301244, content_type: 'image/jpeg',
      storage_path: 'user-9/job-1/ph-1.jpg',
      taken_at: '2026-08-24T01:05:00.000Z',
      server_updated_at: '2026-08-24T01:06:00.000Z',
    });
    expect(photo.blob).toBe(null);
    expect(photo.uploaded).toBe(true);
    expect(photo.jobId).toBe('job-1');
  });
});

describe('deciding who wins', () => {
  const local = (updatedAt, dirty = true) => ({ updatedAt, dirty });

  it('takes the server copy when nothing local changed', () => {
    expect(serverWins(local('2026-08-24T05:00:00.000Z', false), { updated_at: '2026-08-24T01:00:00.000Z' }))
      .toBe(true);
  });

  it('keeps an unsent local edit that is newer', () => {
    expect(serverWins(local('2026-08-24T05:00:00.000Z'), { updated_at: '2026-08-24T01:00:00.000Z' }))
      .toBe(false);
  });

  it('takes the server copy when the other device edited later', () => {
    expect(serverWins(local('2026-08-24T01:00:00.000Z'), { updated_at: '2026-08-24T05:00:00.000Z' }))
      .toBe(true);
  });

  it('keeps the local copy on a tie', () => {
    // The same row coming back unchanged. Rewriting it would clear a dirty flag
    // that may still be needed.
    const same = '2026-08-24T05:00:00.000Z';
    expect(serverWins(local(same), { updated_at: same })).toBe(false);
  });

  it('takes the server copy for a row this device has never seen', () => {
    expect(serverWins(undefined, { updated_at: '2026-08-24T05:00:00.000Z' })).toBe(true);
  });
});
