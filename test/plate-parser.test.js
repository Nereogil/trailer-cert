import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePlate, tokensFromVisionResponse, groupIntoLines, plateWarnings } from '../src/plate-parser.js';

const response = JSON.parse(
  readFileSync(new URL('./fixtures/plate-vision-response.json', import.meta.url), 'utf8')
);

describe('tokensFromVisionResponse', () => {
  it('skips the whole-text annotation and keeps the word boxes', () => {
    const tokens = tokensFromVisionResponse(response);
    expect(tokens.length).toBeGreaterThan(30);
    expect(tokens.every((t) => Number.isFinite(t.cx) && Number.isFinite(t.cy))).toBe(true);
    // The whole-text annotation would show up as one enormous token.
    expect(tokens.some((t) => t.text.includes('MANUFACTURER Breath'))).toBe(false);
  });

  it('returns an empty list rather than throwing on a bare response', () => {
    expect(tokensFromVisionResponse({ responses: [{}] })).toEqual([]);
    expect(tokensFromVisionResponse({})).toEqual([]);
    expect(tokensFromVisionResponse(null)).toEqual([]);
  });
});

describe('groupIntoLines', () => {
  const lines = groupIntoLines(tokensFromVisionResponse(response));

  it('puts both columns of one visual row into the same line', () => {
    const bodyLine = lines.find((l) => l.some((t) => t.text === 'BODY'));
    const texts = bodyLine.map((t) => t.text);
    expect(texts).toContain('ATM');
    expect(texts).toContain('1500');
  });

  it('orders tokens left to right within a line', () => {
    for (const line of lines) {
      const xs = line.map((t) => t.x0);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
    }
  });

  it('finds one line per printed row', () => {
    expect(lines).toHaveLength(7);
  });
});

describe('parsePlate', () => {
  const result = parsePlate(response);

  it('reads the VIN and confirms its check digit', () => {
    expect(result.fields.vin).toBe('R33PD1347TA900017');
    expect(result.vinCheck.ok).toBe(true);
    expect(result.vinSuggestion).toBe(null);
  });

  it('keeps the right column out of the left', () => {
    // The entire reason parsing is geometric rather than text-order.
    expect(result.fields.bodySizeCm).toBe('290X150X136');
    expect(result.fields.atmKg).toBe(1500);
  });

  it('reads the remaining weights', () => {
    expect(result.fields.gtmKg).toBe(1380);
    expect(result.fields.tareKg).toBe(732);
  });

  it('reads the axle capacity from the row below its label', () => {
    expect(result.fields.axleCapacityKg).toBe(1500);
  });

  it('reads sizes, build date and speed', () => {
    expect(result.fields.totalSizeCm).toBe('435*150*186');
    expect(result.fields.mm).toBe('04');
    expect(result.fields.yy).toBe('2026');
    expect(result.fields.maxSpeedKmh).toBe(80);
  });

  it('reads the manufacturer', () => {
    expect(result.fields.manufacturer).toBe('Breath Trailer');
  });

  it('does not mistake a unit for a value', () => {
    expect(result.fields.bodySizeCm).not.toMatch(/CM/);
    expect(result.fields.maxSpeedKmh).toBe(80);
  });

  it('does not let the axle capacity leak into max speed', () => {
    // The bottom row prints "MAX SPEED 80 KM/H" on the left and the axle
    // capacity's value "1500 KGS" on the right, with no label between them.
    // Without token claiming the speed field became 801500.
    expect(result.fields.maxSpeedKmh).toBe(80);
    expect(result.fields.axleCapacityKg).toBe(1500);
  });

  it('keeps the raw text for manual reference', () => {
    expect(result.rawText).toContain('MANUFACTURER');
  });

  it('returns nulls rather than throwing on an empty response', () => {
    const empty = parsePlate({ responses: [{}] });
    expect(empty.fields.vin).toBe(null);
    expect(empty.fields.atmKg).toBe(null);
    expect(empty.vinCheck.ok).toBe(false);
    expect(empty.vinSuggestion).toBe(null);
  });

  it('flags a misread VIN and offers the unambiguous correction', () => {
    // Simulate the OCR reading the P in position 4 as a 9.
    const damaged = structuredClone(response);
    const vinToken = damaged.responses[0].textAnnotations.find(
      (a) => a.description === 'R33PD1347TA900017'
    );
    vinToken.description = 'R339D1347TA900017';

    const r = parsePlate(damaged);
    expect(r.fields.vin).toBe('R339D1347TA900017');
    expect(r.vinCheck.ok).toBe(false);
    expect(r.vinCheck.reason).toBe('checkdigit');
    expect(r.vinSuggestion).toBe('R33PD1347TA900017');
  });
});

// Modelled on the first real scan, which was markedly worse than the clean
// fixture. The point of these is not that the parser recovers everything - it
// cannot - but that it degrades honestly: right values or nothing, never a
// confident wrong one, and always a warning naming what is missing.
describe('parsePlate on a degraded real-world scan', () => {
  const degraded = JSON.parse(
    readFileSync(new URL('./fixtures/plate-vision-degraded.json', import.meta.url), 'utf8')
  );
  const r = parsePlate(degraded);

  it('still reads the VIN correctly and verifies it', () => {
    expect(r.fields.vin).toBe('R33PD1349TA260019');
    expect(r.vinCheck.ok).toBe(true);
  });

  it('recovers GTM even though its label was read as "GL"', () => {
    expect(r.fields.gtmKg).toBe(1300);
  });

  it('keeps the fields that did survive', () => {
    expect(r.fields.atmKg).toBe(1500);
    expect(r.fields.tareKg).toBe(732);
    expect(r.fields.axleCapacityKg).toBe(1500);
    expect(r.fields.bodySizeCm).toBe('290X150X136');
    expect(r.fields.totalSizeCm).toBe('435*150*186');
    expect(r.fields.manufacturer).toBe('Breath Trailer');
  });

  it('leaves undetected fields null rather than inventing them', () => {
    // The values for these were never detected by the OCR at all.
    expect(r.fields.yy).toBe(null);
    expect(r.fields.maxSpeedKmh).toBe(null);
  });

  it('does not swallow the maker web address or the compliance paragraph', () => {
    const values = Object.values(r.fields).filter((v) => typeof v === 'string');
    for (const v of values) {
      expect(v).not.toMatch(/breathtrailer\.com|ISO9001|MANUFACTURED|STANDARDS|ADRs/i);
    }
    expect(r.fields.manufacturer).toBe('Breath Trailer');
  });

  it('does not let the compliance paragraph year become the build year', () => {
    // "ACT 2018" sits on the plate; YY must not pick it up.
    expect(r.fields.yy).not.toBe('2018');
  });

  it('warns about every field it could not read', () => {
    const joined = r.warnings.join(' ');
    expect(joined).toMatch(/Year/);
    expect(joined).toMatch(/Month/);
    expect(joined).toMatch(/Type these in/);
  });
});

describe('plateWarnings', () => {
  // A plate that read perfectly. Each case below changes one thing, so a test
  // about ordering is not also a test about missing fields.
  const CLEAN = {
    vin: 'R33PD1347TA900017', manufacturer: 'Breath Trailer',
    atmKg: 1500, gtmKg: 1380, tareKg: 732, axleCapacityKg: 1500,
    mm: '04', yy: '2026', maxSpeedKmh: 80,
  };

  it('flags GTM above ATM', () => {
    const w = plateWarnings({ ...CLEAN, gtmKg: 1600 });
    expect(w.join(' ')).toMatch(/GTM \(1600\) is above ATM/);
  });

  it('flags tare above GTM', () => {
    const w = plateWarnings({ ...CLEAN, tareKg: 1400 });
    expect(w.join(' ')).toMatch(/Tare \(1400\) is above GTM/);
  });

  it('flags a weight outside a believable range', () => {
    const w = plateWarnings({ ...CLEAN, atmKg: 150000 });
    expect(w.join(' ')).toMatch(/outside the range/);
  });

  it('flags a year that is not a year', () => {
    const w = plateWarnings({ ...CLEAN, yy: '20' });
    expect(w.join(' ')).toMatch(/not a four-digit year/);
  });

  it('says nothing when the plate reads cleanly', () => {
    expect(plateWarnings(CLEAN)).toEqual([]);
  });

  it('cannot catch a plausible-but-wrong figure, and does not pretend to', () => {
    // The real scan read GTM as 1300 when the plate says 1380. Nothing about
    // 1300 is suspicious, which is why the confirm screen exists.
    expect(plateWarnings({ ...CLEAN, gtmKg: 1300 })).toEqual([]);
  });
});
