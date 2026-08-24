import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCoc, stripBoilerplate } from '../src/coc-parser.js';

// A real certificate with the personal details replaced. The spacing is
// untouched, because the spacing is what the parser has to cope with.
const raw = readFileSync(new URL('./fixtures/coc-text.txt', import.meta.url), 'utf8');

describe('stripBoilerplate', () => {
  it('removes the repeated page header and security banner', () => {
    const clean = stripBoilerplate(raw);
    expect(clean).not.toMatch(/nsw\.gov\.au\/building-commission/);
    expect(clean).not.toMatch(/OFFICIAL: Sensitive/);
  });

  it('removes the repeated equipment table header', () => {
    const clean = stripBoilerplate(raw);
    expect(clean).not.toMatch(/Equipment\s+Rating\s+No\.\s+Description/);
  });

  it('keeps the content', () => {
    const clean = stripBoilerplate(raw);
    expect(clean).toMatch(/Switchboards/);
    expect(clean).toMatch(/Test completed date/);
  });
});

describe('parseCoc', () => {
  const r = parseCoc(raw);

  it('extracts the certificate number', () => {
    expect(r.certificateNo).toBe('26070000000');
  });

  it('extracts both dates as ISO, despite the two different formats', () => {
    // The document writes submission as 27/7/2026 and test completed as 23/07/2026.
    expect(r.submissionDate).toBe('2026-07-27');
    expect(r.testCompletedDate).toBe('2026-07-23');
  });

  it('extracts the VIN and confirms its check digit', () => {
    expect(r.vin).toBe('R33PD1442SA259999');
    expect(r.vinValid).toBe(true);
  });

  it('records the installation type', () => {
    expect(r.installType).toBe('Caravan Trailer');
  });

  it('records what work was carried out', () => {
    expect(r.workType).toMatch(/Stand-alone power system/i);
  });

  it('extracts all four equipment rows across both pages', () => {
    expect(r.equipment).toHaveLength(4);
    expect(r.equipment.map((e) => e.type)).toEqual([
      'Switchboards',
      'Socket-outlets',
      'Other - Shore Power Inlet',
      'Other - Inverter Inlet',
    ]);
  });

  it('reads rating, quantity and description per equipment row', () => {
    const [switchboard, sockets, shore] = r.equipment;

    expect(switchboard.ratingA).toBe(16);
    expect(switchboard.qty).toBe(null); // the form leaves this blank
    expect(switchboard.description).toBe(
      "Existing 6 Poles switchboard with 3x 16A RCD's, shore power inlet, Inverter input and 1 Sub circuit to dual pole Socket outlets"
    );

    expect(sockets.ratingA).toBe(16);
    expect(sockets.qty).toBe(3);
    expect(sockets.description).toBe('Existing Double pole twin outlets');

    expect(shore.qty).toBe(1);
    expect(shore.description).toMatch(/^Existing 16A shore power Inlet connected/);
  });

  it('does not let the page header leak into a description', () => {
    for (const e of r.equipment) {
      expect(e.description).not.toMatch(/nsw\.gov\.au|OFFICIAL|Certificate no/);
    }
  });

  it('lists the tests performed', () => {
    expect(r.testsPerformed).toEqual([
      'Earthing system integrity',
      'Insulation resistance',
      'Polarity',
      'Correct circuit connections',
      'Residual current device operation',
      'Visual check that installation is suitable for connection to supply',
      'Stand-alone power system complies with AS/NZS 4509',
    ]);
  });

  it('does not swallow the following question into the test list', () => {
    for (const t of r.testsPerformed) {
      expect(t).not.toMatch(/network provider/i);
    }
  });

  it('returns nulls rather than throwing on unrelated text', () => {
    const empty = parseCoc('just some words');
    expect(empty.certificateNo).toBe(null);
    expect(empty.vin).toBe(null);
    expect(empty.vinValid).toBe(false);
    expect(empty.equipment).toEqual([]);
    expect(empty.testsPerformed).toEqual([]);
  });

  it('survives empty input', () => {
    expect(() => parseCoc('')).not.toThrow();
    expect(() => parseCoc(null)).not.toThrow();
  });

  it('flags a VIN whose check digit does not hold', () => {
    const damaged = raw.replace('R33PD1442SA259999', 'R33PD1442SA259998');
    const d = parseCoc(damaged);
    expect(d.vin).toBe('R33PD1442SA259998');
    expect(d.vinValid).toBe(false);
  });
});
