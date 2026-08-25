import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  detectScreen,
  parseRcdScreen,
  parseContinuityScreen,
  parseTesterScreen,
} from '../src/tester-parser.js';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const RCD = load('tester-rcd.json');
const CONTINUITY = load('tester-continuity.json');

// Rebuild a fixture with one row's values changed, so a test about a failing
// RCD is not also a test about everything else.
function withRow(json, multiplier, angle, value) {
  const out = structuredClone(json);
  const anns = out.responses[0].textAnnotations;
  const rowY = { 'x1/2': { 0: 300, 180: 350 }, x1: { 0: 400, 180: 450 }, x5: { 0: 500, 180: 550 } };
  const y = rowY[multiplier][angle];
  const cell = anns.find(
    (a) => a.boundingPoly && a.boundingPoly.vertices[0].y === y && a.boundingPoly.vertices[0].x === 690
  );
  cell.description = value;
  return out;
}

describe('detectScreen', () => {
  it('tells the two screens apart', () => {
    expect(detectScreen(RCD)).toBe('rcd');
    expect(detectScreen(CONTINUITY)).toBe('continuity');
  });

  it('names the insulation screen even though it is not read yet', () => {
    expect(detectScreen({ responses: [{ textAnnotations: [{ description: 'Insulation 500V 1.2 GΩ' }] }] }))
      .toBe('insulation');
  });

  it('does not guess at an unrelated photo', () => {
    expect(detectScreen({ responses: [{ textAnnotations: [{ description: 'a cat' }] }] })).toBe('unknown');
    expect(detectScreen({})).toBe('unknown');
  });
});

describe('parseRcdScreen', () => {
  const r = parseRcdScreen(RCD);

  it('reads the rated trip current', () => {
    expect(r.tripCurrentMa).toBe(30);
  });

  it('reads only the x1 pair, not the half or five times', () => {
    expect(r.x1Zero).toBe(25);
    expect(r.x1OneEighty).toBe(15);
    // The x5 row reads 7 and 11 ms; neither should have leaked in.
    expect(r.x1Zero).not.toBe(7);
    expect(r.x1OneEighty).not.toBe(11);
  });

  it('does not mistake the angle column for a trip time', () => {
    expect(r.x1Zero).not.toBe(0);
    expect(r.x1OneEighty).not.toBe(180);
  });

  it('treats no-trip at half current as healthy', () => {
    expect(r.halfTripped).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('flags an RCD that tripped at half its rated current', () => {
    // A time instead of ">2000" at x1/2 means it tripped, which is a fail.
    const failed = parseRcdScreen(withRow(RCD, 'x1/2', 0, '180'));
    expect(failed.halfTripped).toBe(true);
    expect(failed.warnings.join(' ')).toMatch(/tripped at half its rated current/i);
  });

  it('flags an x1 test that did not trip at all', () => {
    const stuck = parseRcdScreen(withRow(RCD, 'x1', 0, '>2000'));
    expect(stuck.warnings.join(' ')).toMatch(/did not trip/i);
    expect(stuck.x1Zero).toBe(null);
    // The other half of the pair still reads.
    expect(stuck.x1OneEighty).toBe(15);
  });

  it('warns when no x1 row was read at all', () => {
    const empty = parseRcdScreen({ responses: [{ textAnnotations: [{ description: 'RCD Auto 30mA' }] }] });
    expect(empty.x1Zero).toBe(null);
    expect(empty.warnings.join(' ')).toMatch(/No x1 trip time/);
  });

  it('warns when the trip current is missing', () => {
    const noCurrent = structuredClone(RCD);
    const anns = noCurrent.responses[0].textAnnotations;
    anns[0].description = anns[0].description.replace('30mA', '');
    anns.splice(anns.findIndex((a) => a.description === '30mA'), 1);
    expect(parseRcdScreen(noCurrent).warnings.join(' ')).toMatch(/rated trip current was not read/);
  });
});

describe('parseContinuityScreen', () => {
  const r = parseContinuityScreen(CONTINUITY);

  it('reads the measurement, not the limit in the corner', () => {
    // Both 0.065 and 0.5 are on screen; the reading is the one in the big font.
    expect(r.ohms).toBe(0.065);
    expect(r.limitOhms).toBe(0.5);
  });

  it('is quiet when the reading is inside the limit', () => {
    expect(r.warnings).toEqual([]);
  });

  it('flags a reading above the limit set on the tester', () => {
    const over = structuredClone(CONTINUITY);
    const anns = over.responses[0].textAnnotations;
    anns.find((a) => a.description === '0.065').description = '0.812';
    anns[0].description = anns[0].description.replace('0.065', '0.812');
    const parsed = parseContinuityScreen(over);
    expect(parsed.ohms).toBe(0.812);
    expect(parsed.warnings.join(' ')).toMatch(/above the 0.5 limit/);
  });

  it('flags an exactly-zero reading as a likely lead problem', () => {
    const zero = structuredClone(CONTINUITY);
    zero.responses[0].textAnnotations.find((a) => a.description === '0.065').description = '0.000';
    expect(parseContinuityScreen(zero).warnings.join(' ')).toMatch(/exactly zero/i);
  });

  it('says so when there is no reading to find', () => {
    const blank = parseContinuityScreen({ responses: [{ textAnnotations: [{ description: 'Continuity' }] }] });
    expect(blank.ohms).toBe(null);
    expect(blank.warnings.join(' ')).toMatch(/No reading/);
  });

  it('accepts a comma decimal separator', () => {
    const comma = structuredClone(CONTINUITY);
    comma.responses[0].textAnnotations.find((a) => a.description === '0.065').description = '0,065';
    expect(parseContinuityScreen(comma).ohms).toBe(0.065);
  });
});

describe('parseTesterScreen', () => {
  it('routes each screen to its reader', () => {
    expect(parseTesterScreen(RCD).kind).toBe('rcd');
    expect(parseTesterScreen(CONTINUITY).kind).toBe('continuity');
  });

  it('explains itself on a screen it cannot read', () => {
    const ins = parseTesterScreen({ responses: [{ textAnnotations: [{ description: 'Insulation 500V' }] }] });
    expect(ins.kind).toBe('insulation');
    expect(ins.warnings.join(' ')).toMatch(/not read yet/);
  });

  it('does not pretend to understand an unrelated photo', () => {
    const other = parseTesterScreen({ responses: [{ textAnnotations: [{ description: 'a trailer' }] }] });
    expect(other.warnings.join(' ')).toMatch(/does not look like/);
  });
});

// A tester photographed with the phone turned should read the same. The shared
// geometry rotates boxes flat before any row logic runs.
describe('a tester photographed sideways', () => {
  const rotate = (json, deg) => {
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const out = structuredClone(json);
    for (const a of out.responses[0].textAnnotations) {
      if (!a.boundingPoly) continue;
      a.boundingPoly.vertices = a.boundingPoly.vertices.map(({ x, y }) => ({
        x: Math.round(x * cos - y * sin),
        y: Math.round(x * sin + y * cos),
      }));
    }
    return out;
  };

  it.each([90, -90, 180])('reads the RCD table at %s degrees', (deg) => {
    const r = parseRcdScreen(rotate(RCD, deg));
    expect(r.x1Zero).toBe(25);
    expect(r.x1OneEighty).toBe(15);
    expect(r.tripCurrentMa).toBe(30);
  });

  it.each([90, -90])('reads the continuity value at %s degrees', (deg) => {
    expect(parseContinuityScreen(rotate(CONTINUITY, deg)).ohms).toBe(0.065);
  });
});

describe('a genuine 180 ms trip time', () => {
  it('is read as a trip time, not discarded as the angle column', () => {
    // 180 ms at rated current is an ordinary reading. An earlier version threw
    // away any value of 0 or 180 on the assumption it was the angle, which
    // silently lost real results.
    const slow = structuredClone(RCD);
    const anns = slow.responses[0].textAnnotations;
    anns.find(
      (a) => a.boundingPoly && a.boundingPoly.vertices[0].y === 400 && a.boundingPoly.vertices[0].x === 690
    ).description = '180';

    const r = parseRcdScreen(slow);
    expect(r.x1Zero).toBe(180);
    expect(r.x1OneEighty).toBe(15);
  });
});

describe('a 180 ms reading on the 0 degree row', () => {
  it('is filed against 0 degrees, not 180', () => {
    // Scanning the whole row for the angle finds the "180" of the reading
    // before the "0" of the angle column, and files a real result against the
    // wrong phase. The angle is read from its own column only.
    const slow = structuredClone(RCD);
    slow.responses[0].textAnnotations.find(
      (a) => a.boundingPoly && a.boundingPoly.vertices[0].y === 400 && a.boundingPoly.vertices[0].x === 690
    ).description = '180';

    const r = parseRcdScreen(slow);
    expect(r.x1Zero).toBe(180);        // the 0 degree row
    expect(r.x1OneEighty).toBe(15);    // untouched
  });
});

describe('the single figure the certificate wants', () => {
  it('is the slower of the x1 pair', () => {
    // 25 ms at 0 degrees, 15 ms at 180. The slower one has to meet the limit.
    expect(parseRcdScreen(RCD).tripTimeMs).toBe(25);
  });

  it('falls back to whichever half of the pair was read', () => {
    const one = parseRcdScreen(withRow(RCD, 'x1', 0, '>2000'));
    expect(one.tripTimeMs).toBe(15);
  });

  it('is null when no x1 row was read', () => {
    const none = parseRcdScreen({ responses: [{ textAnnotations: [{ description: 'RCD Auto 30mA' }] }] });
    expect(none.tripTimeMs).toBe(null);
  });
});

describe('reading the rated trip current from the sidebar', () => {
  const withCurrentToken = (text) => {
    const out = structuredClone(RCD);
    const anns = out.responses[0].textAnnotations;
    anns.find((a) => a.description === '30mA').description = text;
    anns[0].description = anns[0].description.replace('30mA', text);
    return out;
  };

  it('reads it as a single token', () => {
    expect(parseRcdScreen(RCD).tripCurrentMa).toBe(30);
  });

  it('reads a zero that came back as the letter O', () => {
    expect(parseRcdScreen(withCurrentToken('3OmA')).tripCurrentMa).toBe(30);
  });

  it('reads it with a space before the unit', () => {
    expect(parseRcdScreen(withCurrentToken('30 mA')).tripCurrentMa).toBe(30);
  });

  it('reads the number when it is split from the unit', () => {
    const split = structuredClone(RCD);
    const anns = split.responses[0].textAnnotations;
    const cell = anns.find((a) => a.description === '30mA');
    const [tl] = cell.boundingPoly.vertices;
    cell.description = '30';
    cell.boundingPoly.vertices = [
      { x: tl.x, y: tl.y }, { x: tl.x + 40, y: tl.y },
      { x: tl.x + 40, y: tl.y + 25 }, { x: tl.x, y: tl.y + 25 },
    ];
    anns.push({
      description: 'mA',
      boundingPoly: { vertices: [
        { x: tl.x + 48, y: tl.y }, { x: tl.x + 90, y: tl.y },
        { x: tl.x + 90, y: tl.y + 25 }, { x: tl.x + 48, y: tl.y + 25 },
      ] },
    });
    expect(parseRcdScreen(split).tripCurrentMa).toBe(30);
  });

  it('flags a current that is not a standard rating', () => {
    const odd = parseRcdScreen(withCurrentToken('35mA'));
    expect(odd.tripCurrentMa).toBe(35);
    expect(odd.warnings.join(' ')).toMatch(/not a standard rating/);
  });

  it('stays quiet on the standard ratings', () => {
    for (const ma of ['10mA', '30mA', '100mA', '300mA']) {
      const r = parseRcdScreen(withCurrentToken(ma));
      expect(r.warnings.join(' ')).not.toMatch(/standard rating/);
    }
  });
});
