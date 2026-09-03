import { describe, it, expect } from 'vitest';
import { syncJobs, pushJobs, pullJobs } from '../src/sync.js';

// Stand-ins for db.js and the Supabase side. Between them they let the whole
// cycle run in memory, which is the only way to reach the cases that matter -
// a row edited mid-push, a clock that disagrees, a conflict - reliably.

function fakeLocal(jobs = [], cursor = null) {
  const store = new Map(jobs.map((j) => [j.id, structuredClone(j)]));
  const sync = new Map(cursor ? [['jobs', cursor]] : []);

  return {
    store,
    sync,
    dirtyJobs: async () => [...store.values()].filter((j) => j.dirty).map((j) => structuredClone(j)),
    getJob: async (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),
    putJobFromServer: async (job) => { store.set(job.id, { ...structuredClone(job), dirty: false }); },
    getSyncState: async (key) => sync.get(key) ?? null,
    setSyncState: async (key, value) => { sync.set(key, value); },
  };
}

// Backed by an actual table, because a fake that forgets what it was just sent
// invents conflicts that could never happen: after a push, the server holds your
// row, so the pull that follows returns your row and not the copy it had before.
function fakeRemote({ rows = [], stampedAt = '2026-09-04T10:00:00.000Z', onUpsert } = {}) {
  const calls = [];
  const table = new Map(rows.map((r) => [r.id, { ...r }]));

  return {
    calls,
    table,
    sentRows: [],
    async upsertJobs(sent) {
      calls.push('push');
      this.sentRows.push(...sent);
      if (onUpsert) await onUpsert(sent);
      return sent.map((row) => {
        const stored = { ...row, server_updated_at: stampedAt };
        table.set(row.id, stored);
        return stored;
      });
    },
    async fetchJobsSince(cursor) {
      calls.push('pull');
      const all = [...table.values()];
      if (!cursor) return all;
      return all.filter((r) => Date.parse(r.server_updated_at) > Date.parse(cursor));
    },
  };
}

const job = (over = {}) => ({
  id: 'j1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  vin: 'R33PD1347TA900017',
  vinValid: true, vinSource: 'scan',
  plate: {}, power: {}, tests: {}, equipment: [], ccew: {},
  installType: 'Caravan Trailer', ecert: 'Y', status: 'draft',
  dirty: false, syncedAt: null, deletedAt: null,
  ...over,
});

const serverRow = (over = {}) => ({
  id: 'j1',
  vin: 'R33PD1347TA900017',
  vin_valid: true, vin_source: 'scan',
  plate: {}, power: {}, tests: {}, equipment: [], ccew: {},
  install_type: 'Caravan Trailer', ecert: 'Y', status: 'draft',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  server_updated_at: '2026-09-01T00:00:01.000Z',
  written_at: null, deleted_at: null,
  ...over,
});

describe('pushing', () => {
  it('sends only the rows this device changed', async () => {
    const local = fakeLocal([
      job({ id: 'j1', dirty: true }),
      job({ id: 'j2', dirty: false }),
      job({ id: 'j3', dirty: true }),
    ]);
    const remote = fakeRemote();

    const result = await pushJobs(remote, local);

    expect(result.sent).toBe(2);
    expect(remote.sentRows.map((r) => r.id).sort()).toEqual(['j1', 'j3']);
  });

  it('clears the flag and records the server clock', async () => {
    const local = fakeLocal([job({ dirty: true })]);
    await pushJobs(fakeRemote({ stampedAt: '2026-09-04T10:00:00.000Z' }), local);

    expect(local.store.get('j1').dirty).toBe(false);
    expect(local.store.get('j1').syncedAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('leaves a job dirty if it was edited while the push was in flight', async () => {
    // The race that quietly loses work: the flag is cleared for a version the
    // server never received, and the edit never leaves the device.
    const local = fakeLocal([job({ dirty: true })]);
    const remote = fakeRemote({
      onUpsert: async () => {
        const row = local.store.get('j1');
        row.updatedAt = '2026-09-04T09:59:59.000Z';
        row.vin = 'CHANGEDMIDFLIGHT1';
      },
    });

    const result = await pushJobs(remote, local);

    expect(result.sent).toBe(0);
    expect(result.deferred).toBe(1);
    expect(local.store.get('j1').dirty).toBe(true);
    expect(local.store.get('j1').vin).toBe('CHANGEDMIDFLIGHT1');
  });

  it('sends a tombstone like any other change', async () => {
    const local = fakeLocal([job({ dirty: true, deletedAt: '2026-09-04T08:00:00.000Z' })]);
    const remote = fakeRemote();
    await pushJobs(remote, local);
    expect(remote.sentRows[0].deleted_at).toBe('2026-09-04T08:00:00.000Z');
  });

  it('does nothing, and calls nothing, when there is nothing to send', async () => {
    const remote = fakeRemote();
    const result = await pushJobs(remote, fakeLocal([job({ dirty: false })]));
    expect(result.sent).toBe(0);
    expect(remote.calls).toEqual([]);
  });
});

describe('pulling', () => {
  it('writes a row this device has never seen', async () => {
    const local = fakeLocal([]);
    const result = await pullJobs(fakeRemote({ rows: [serverRow({ id: 'new' })] }), local);

    expect(result.applied).toBe(1);
    expect(local.store.get('new').vin).toBe('R33PD1347TA900017');
    expect(local.store.get('new').dirty).toBe(false);
  });

  it('keeps an unsent local edit that is newer than the server copy', async () => {
    const local = fakeLocal([job({ dirty: true, updatedAt: '2026-09-05T00:00:00.000Z', vin: 'LOCALWINS12345678' })]);
    const result = await pullJobs(fakeRemote({ rows: [serverRow({ updated_at: '2026-09-01T00:00:00.000Z' })] }), local);

    expect(result.keptLocal).toBe(1);
    expect(result.applied).toBe(0);
    expect(local.store.get('j1').vin).toBe('LOCALWINS12345678');
    expect(local.store.get('j1').dirty).toBe(true);
  });

  it('takes the server copy when the other device edited later', async () => {
    const local = fakeLocal([job({ dirty: true, updatedAt: '2026-09-01T00:00:00.000Z' })]);
    await pullJobs(fakeRemote({ rows: [serverRow({ updated_at: '2026-09-05T00:00:00.000Z', vin: 'SERVERWINS1234567' })] }), local);

    expect(local.store.get('j1').vin).toBe('SERVERWINS1234567');
  });

  it('advances the cursor past a row it held back', async () => {
    // Otherwise that row is fetched again on every single sync, for ever.
    const local = fakeLocal([job({ dirty: true, updatedAt: '2026-09-09T00:00:00.000Z' })]);
    await pullJobs(
      fakeRemote({ rows: [serverRow({ server_updated_at: '2026-09-02T00:00:00.000Z' })] }),
      local
    );
    expect(local.sync.get('jobs')).toBe('2026-09-02T00:00:00.000Z');
  });

  it('advances the cursor to the newest row seen, not the last one listed', async () => {
    const local = fakeLocal([]);
    await pullJobs(fakeRemote({ rows: [
      serverRow({ id: 'a', server_updated_at: '2026-09-03T00:00:00.000Z' }),
      serverRow({ id: 'b', server_updated_at: '2026-09-01T00:00:00.000Z' }),
    ] }), local);
    expect(local.sync.get('jobs')).toBe('2026-09-03T00:00:00.000Z');
  });

  it('asks only for what changed once it has a cursor', async () => {
    const local = fakeLocal([], '2026-09-02T00:00:00.000Z');
    const result = await pullJobs(fakeRemote({ rows: [
      serverRow({ id: 'old', server_updated_at: '2026-09-01T00:00:00.000Z' }),
      serverRow({ id: 'new', server_updated_at: '2026-09-03T00:00:00.000Z' }),
    ] }), local);

    expect(result.applied).toBe(1);
    expect(local.store.has('new')).toBe(true);
    expect(local.store.has('old')).toBe(false);
  });

  it('brings a deletion down as a tombstone', async () => {
    const local = fakeLocal([job({})]);
    await pullJobs(fakeRemote({ rows: [serverRow({ deleted_at: '2026-09-04T08:00:00.000Z', updated_at: '2026-09-04T08:00:00.000Z' })] }), local);
    expect(local.store.get('j1').deletedAt).toBe('2026-09-04T08:00:00.000Z');
  });

  it('leaves the cursor alone when nothing came back', async () => {
    const local = fakeLocal([], '2026-09-02T00:00:00.000Z');
    await pullJobs(fakeRemote({ rows: [] }), local);
    expect(local.sync.get('jobs')).toBe('2026-09-02T00:00:00.000Z');
  });
});

describe('a full cycle', () => {
  it('pushes before it pulls', async () => {
    // The other order overwrites an unsent local edit with an older server copy
    // and the edit is gone with nothing to show it ever existed.
    const local = fakeLocal([job({ dirty: true })]);
    const remote = fakeRemote({ rows: [] });
    await syncJobs(remote, local);
    expect(remote.calls).toEqual(['push', 'pull']);
  });

  it('leaves a device that sent a change holding the same row it sent', async () => {
    const local = fakeLocal([job({ dirty: true, vin: 'MINEWINS123456789', updatedAt: '2026-09-06T00:00:00.000Z' })]);
    const remote = fakeRemote({
      rows: [serverRow({ updated_at: '2026-09-01T00:00:00.000Z', vin: 'STALECOPY12345678', server_updated_at: '2026-09-06T00:00:05.000Z' })],
    });

    await syncJobs(remote, local);

    const after = local.store.get('j1');
    expect(after.vin).toBe('MINEWINS123456789');
    expect(after.dirty).toBe(false);
  });
});
