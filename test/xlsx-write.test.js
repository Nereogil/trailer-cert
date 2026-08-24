import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { readEntries, entryToString } from '../src/zip.js';
import { readWorkbook } from '../src/xlsx-read.js';
import { appendRows, jobToRow } from '../src/xlsx-write.js';
import { buildTestWorkbook } from './fixtures/make-workbook.mjs';

const REAL = new URL('../samples/Trailers-sample.xlsx', import.meta.url);

let original;
beforeAll(() => {
  original = existsSync(REAL) ? readFileSync(REAL) : buildTestWorkbook();
});

const JOB = {
  vin: 'R33PD1347TA900017',
  power: { inverterW: 2000, batteryAh: 200 },
  tests: { date: '2026-08-24' },
  ccew: {
    certificateNo: '26070056245',
    submissionDate: '2026-07-27',
    testCompletedDate: '2026-07-23',
  },
  installType: 'Caravan Trailer',
  ecert: 'Y',
};

describe('jobToRow', () => {
  it('maps a job onto the register columns', () => {
    const row = jobToRow(JOB);
    expect(row.A.v).toBe('R33PD1347TA900017');
    expect(row.B.v).toBe('2000W');
    expect(row.C.v).toBe(200);
    expect(row.D.kind).toBe('date');
    expect(row.E.v).toBe('Y');
    expect(row.F.v).toBe('26070056245');
    expect(row.I.v).toBe('Caravan Trailer');
  });

  it('leaves the note and contact columns alone', () => {
    const row = jobToRow(JOB);
    expect(row.K).toBeUndefined();
    expect(row.N).toBeUndefined();
  });

  it('omits columns with nothing to say', () => {
    const bare = jobToRow({ vin: 'R33PD1347TA900017' });
    expect(bare.A.v).toBe('R33PD1347TA900017');
    expect(bare.B).toBeUndefined();
    expect(bare.C).toBeUndefined();
    expect(bare.F).toBeUndefined();
  });
});

describe('appendRows', () => {
  it('adds the new row below the last populated row', () => {
    const before = readWorkbook(original);
    const after = readWorkbook(appendRows(original, [jobToRow(JOB)]));

    expect(after.lastRow).toBe(before.lastRow + 1);
    const added = after.rows.find((r) => r.r === before.lastRow + 1);
    expect(added.cells.A).toBe('R33PD1347TA900017');
    expect(added.cells.B).toBe('2000W');
    expect(added.cells.C).toBe(200);
    expect(added.cells.E).toBe('Y');
    expect(added.cells.F).toBe('26070056245');
    expect(added.cells.I).toBe('Caravan Trailer');
  });

  it('writes dates as Excel serials, not text', () => {
    const before = readWorkbook(original);
    const after = readWorkbook(appendRows(original, [jobToRow(JOB)]));
    const added = after.rows.find((r) => r.r === before.lastRow + 1);

    expect(typeof added.cells.D).toBe('number');
    // 2026-08-24
    expect(added.cells.D).toBe(46258);
    expect(added.cells.G).toBe(46226);
  });

  it('gives the date cell the same style as the column above', () => {
    const before = readWorkbook(original);
    const out = appendRows(original, [jobToRow(JOB)]);
    const sheet = entryToString(readEntries(out)['xl/worksheets/sheet1.xml']);

    const newCell = new RegExp(`<c r="D${before.lastRow + 1}"[^>]*`).exec(sheet)[0];
    expect(newCell).toMatch(/\bs="\d+"/);
  });

  it('formats the new CCEW date columns too, not just the existing one', () => {
    // G and H are empty columns, so there is no cell above to inherit from.
    // Without a fallback they would display in Excel as bare serial numbers.
    const before = readWorkbook(original);
    const out = appendRows(original, [jobToRow(JOB)]);
    const sheet = entryToString(readEntries(out)['xl/worksheets/sheet1.xml']);
    const row = before.lastRow + 1;

    const dStyle = /\bs="(\d+)"/.exec(new RegExp(`<c r="D${row}"[^>]*`).exec(sheet)[0])[1];
    for (const col of ['G', 'H']) {
      const cell = new RegExp(`<c r="${col}${row}"[^>]*`).exec(sheet)[0];
      expect(cell, `${col}${row} has no number format`).toMatch(/\bs="\d+"/);
      expect(/\bs="(\d+)"/.exec(cell)[1]).toBe(dStyle);
    }
  });

  it('leaves non-date cells unstyled', () => {
    const before = readWorkbook(original);
    const out = appendRows(original, [jobToRow(JOB)]);
    const sheet = entryToString(readEntries(out)['xl/worksheets/sheet1.xml']);
    const cell = new RegExp(`<c r="C${before.lastRow + 1}"[^>]*`).exec(sheet)[0];
    expect(cell).not.toMatch(/\bs="\d+"/);
  });

  it('preserves the contents of every other zip entry exactly', () => {
    const before = readEntries(original);
    const after = readEntries(appendRows(original, [jobToRow(JOB)]));

    const rewritten = new Set(['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml']);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());

    for (const name of Object.keys(before)) {
      if (rewritten.has(name)) continue;
      expect(Buffer.from(after[name]).equals(Buffer.from(before[name]))).toBe(true);
    }
  });

  it('keeps every existing row byte-for-byte identical in meaning', () => {
    const before = readWorkbook(original);
    const after = readWorkbook(appendRows(original, [jobToRow(JOB)]));

    for (const row of before.rows) {
      const same = after.rows.find((r) => r.r === row.r);
      expect(same, `row ${row.r} vanished`).toBeTruthy();
      expect(same.cells).toEqual(row.cells);
    }
  });

  it('appends several rows in order', () => {
    const before = readWorkbook(original);
    const second = { ...JOB, vin: 'R33PD1344TA900010' };
    const after = readWorkbook(appendRows(original, [jobToRow(JOB), jobToRow(second)]));

    expect(after.rows.find((r) => r.r === before.lastRow + 1).cells.A).toBe('R33PD1347TA900017');
    expect(after.rows.find((r) => r.r === before.lastRow + 2).cells.A).toBe('R33PD1344TA900010');
    expect(after.lastRow).toBe(before.lastRow + 2);
  });

  it('reuses an existing shared string rather than duplicating it', () => {
    const before = readWorkbook(original);
    const after = readWorkbook(appendRows(original, [jobToRow(JOB)]));
    // 'Y' is already in the table; only the new VIN and certificate number are new.
    const added = after.sharedStrings.length - before.sharedStrings.length;
    expect(added).toBeLessThanOrEqual(4);
    expect(new Set(after.sharedStrings).size).toBe(after.sharedStrings.length);
  });

  it('widens the declared dimension to cover the new rows', () => {
    const before = readWorkbook(original);
    const out = appendRows(original, [jobToRow(JOB)]);
    const sheet = entryToString(readEntries(out)['xl/worksheets/sheet1.xml']);
    const dim = /<dimension ref="[A-Z]+\d+:([A-Z]+)(\d+)"/.exec(sheet);
    expect(Number(dim[2])).toBeGreaterThanOrEqual(before.lastRow + 1);
  });

  it('returns the original bytes untouched when there is nothing to add', () => {
    const out = appendRows(original, []);
    expect(Buffer.from(out).equals(Buffer.from(original))).toBe(true);
  });

  it('escapes characters that would break the XML', () => {
    const before = readWorkbook(original);
    const awkward = jobToRow({
      vin: 'R33PD1347TA900017',
      installType: 'Trailer & <Caravan> "special"',
    });
    const after = readWorkbook(appendRows(original, [awkward]));
    const added = after.rows.find((r) => r.r === before.lastRow + 1);
    expect(added.cells.I).toBe('Trailer & <Caravan> "special"');
  });

  it('refuses a workbook it does not recognise', () => {
    expect(() => appendRows(new Uint8Array([1, 2, 3]), [jobToRow(JOB)])).toThrow();
  });
});
