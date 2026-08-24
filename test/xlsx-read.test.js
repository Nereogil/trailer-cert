import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { readWorkbook, existingVins, parseSharedStrings } from '../src/xlsx-read.js';
import { buildTestWorkbook } from './fixtures/make-workbook.mjs';

// Prefer the real register when it is present locally (it is gitignored), so
// the parser is exercised against the file it must actually handle. Fall back
// to a synthetic workbook of the same shape everywhere else.
const REAL = new URL('../samples/Trailers-sample.xlsx', import.meta.url);
const usingReal = existsSync(REAL);

let buffer;
beforeAll(() => {
  buffer = usingReal ? readFileSync(REAL) : buildTestWorkbook();
});

describe('parseSharedStrings', () => {
  it('concatenates the runs inside one string entry', () => {
    const xml = '<sst><si><r><t>Existing </t></r><r><t>switchboard</t></r></si><si><t>Vin</t></si></sst>';
    expect(parseSharedStrings(xml)).toEqual(['Existing switchboard', 'Vin']);
  });

  it('decodes XML entities', () => {
    const xml = '<sst><si><t>3x 16A RCD&apos;s &amp; inlet</t></si></sst>';
    expect(parseSharedStrings(xml)).toEqual(["3x 16A RCD's & inlet"]);
  });

  it('returns an empty list when there are no shared strings', () => {
    expect(parseSharedStrings('')).toEqual([]);
  });
});

describe('readWorkbook', () => {
  it('reads shared strings and rows', () => {
    const wb = readWorkbook(buffer);
    expect(wb.sharedStrings.length).toBeGreaterThan(0);
    expect(wb.rows.length).toBeGreaterThan(2);
  });

  it('resolves the header row to the expected columns', () => {
    const wb = readWorkbook(buffer);
    const header = wb.rows.find((r) => r.cells.A === 'Vin');
    expect(header).toBeTruthy();
    expect(header.cells.B).toBe('Power');
    expect(header.cells.C).toBe('Battery');
    expect(header.cells.D).toBe('Date');
    expect(header.cells.E).toBe('Ecert');
  });

  it('keeps dates as numbers, not strings', () => {
    const wb = readWorkbook(buffer);
    const dated = wb.rows.find((r) => typeof r.cells.D === 'number');
    expect(dated.cells.D).toBeGreaterThan(40000);
  });

  it('reads the note and contact columns that sit apart from the table', () => {
    const wb = readWorkbook(buffer);
    const values = wb.rows.flatMap((r) => Object.values(r.cells));
    expect(values.some((v) => typeof v === 'string' && /switchboard/i.test(v))).toBe(true);
  });

  it('reports the last populated row', () => {
    const wb = readWorkbook(buffer);
    expect(wb.lastRow).toBe(Math.max(...wb.rows.map((r) => r.r)));
  });

  it('collects the VINs already recorded', () => {
    const wb = readWorkbook(buffer);
    const vins = existingVins(wb);
    expect(vins.size).toBeGreaterThan(0);
    for (const v of vins) expect(v).toHaveLength(17);
  });

  it('refuses a zip that is not a workbook', async () => {
    const { writeEntries, stringToEntry } = await import('../src/zip.js');
    const bad = writeEntries({ 'hello.txt': stringToEntry('not a workbook') });
    expect(() => readWorkbook(bad)).toThrow(/sheet1/);
  });

  it('refuses a file that is not a zip at all', () => {
    expect(() => readWorkbook(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a readable/i);
  });
});
