import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePlate, tokensFromVisionResponse, groupIntoLines, plateWarnings, textAngle } from '../src/plate-parser.js';

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

// A phone held sideways puts the plate's text running vertically down the
// image. Vision still reads it, but every bounding box arrives rotated, and
// row-grouping on raw coordinates finds columns instead of rows.
describe('parsePlate on a rotated photo', () => {
  const rotate = (json, degrees) => {
    const rad = (degrees * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
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

  const upright = parsePlate(response);

  it.each([90, -90, 180, 7, -12])('reads the same fields at %s degrees', (deg) => {
    const turned = parsePlate(rotate(response, deg));
    expect(turned.fields).toEqual(upright.fields);
    expect(turned.vinCheck.ok).toBe(true);
  });

  it('still keeps the two columns apart when sideways', () => {
    // The failure this guards against: at 90 degrees, "ATM 1500" and
    // "BODY SIZE 290X150X136" stop sharing a row and the values swap around.
    const turned = parsePlate(rotate(response, 90));
    expect(turned.fields.bodySizeCm).toBe('290X150X136');
    expect(turned.fields.atmKg).toBe(1500);
    expect(turned.fields.gtmKg).toBe(1380);
    expect(turned.fields.tareKg).toBe(732);
  });

  it('reports the dominant text angle', () => {
    const tokens = tokensFromVisionResponse(response);
    expect(tokens.length).toBeGreaterThan(0);
    // Already upright, so nothing should have been rotated.
    expect(Math.abs(textAngle(tokens.map((t) => ({
      vertices: [{ x: t.x0, y: t.y0 }, { x: t.x1, y: t.y0 }, { x: t.x1, y: t.y1 }, { x: t.x0, y: t.y1 }],
    })))) ).toBeLessThan(0.01);
  });
});

// Drawn from the second real scan, which was a photo of a screen: several
// figures lost a digit rather than failing outright.
describe('plateWarnings on dropped digits', () => {
  const CLEAN2 = {
    vin: 'R33PD1347TA900017', manufacturer: 'Breath Trailer',
    atmKg: 1500, gtmKg: 1380, tareKg: 730, axleCapacityKg: 1500,
    mm: '12', yy: '2025', maxSpeedKmh: 80,
    bodySizeCm: '290X150X136', totalSizeCm: '435*150*186',
  };

  it('catches a tare that lost its trailing zero', () => {
    // The real scan read 730 as 73. On its own 73 looks like a number.
    expect(plateWarnings({ ...CLEAN2, tareKg: 73 }).join(' '))
      .toMatch(/Tare \(73\) is very light for a GTM of 1380/);
  });

  it('catches a body size that lost digits', () => {
    // The real scan read 290X150X136 as 20X50X36.
    expect(plateWarnings({ ...CLEAN2, bodySizeCm: '20X50X36' }).join(' '))
      .toMatch(/Body size reads "20X50X36" .* dropped digit/);
  });

  it('accepts the hyphen separator the OCR sometimes returns', () => {
    expect(plateWarnings({ ...CLEAN2, totalSizeCm: '435-150-186' })).toEqual([]);
  });

  it('flags a size that is not three measurements', () => {
    expect(plateWarnings({ ...CLEAN2, totalSizeCm: '435-150' }).join(' '))
      .toMatch(/not three measurements/);
  });

  it('stays quiet on a plate that read correctly', () => {
    expect(plateWarnings(CLEAN2)).toEqual([]);
  });

  it('still cannot catch 1380 misread as 1300', () => {
    // Both are ordinary numbers in an ordinary relationship. Only the person
    // holding the plate can catch this one.
    expect(plateWarnings({ ...CLEAN2, gtmKg: 1300 })).toEqual([]);
  });
});

// The VIN is the one field that matters, so it is found by what it is rather
// than by where it sits: the only 17-character run on the plate whose check
// digit holds. That survives a mangled label, a rotated photo, and a value that
// landed nowhere near where it should have.
describe('finding the VIN without trusting its label', () => {
  const mangleLabel = (json) => {
    const out = structuredClone(json);
    for (const a of out.responses[0].textAnnotations) {
      if (a.description === 'VIN') a.description = 'VlN';
      if (a.description === 'NUMBER') a.description = 'NUMBFR';
    }
    return out;
  };

  it('still finds the VIN when the label is unreadable', () => {
    const r = parsePlate(mangleLabel(response));
    expect(r.fields.vin).toBe('R33PD1347TA900017');
    expect(r.vinCheck.ok).toBe(true);
  });

  it('prefers a check-digit-valid VIN over whatever sat beside the label', () => {
    // Put a plausible-looking but invalid 17-character run where the label
    // points, and the real VIN elsewhere on the plate.
    const out = structuredClone(response);
    const anns = out.responses[0].textAnnotations;
    anns.find((a) => a.description === 'R33PD1347TA900017').description = 'R33PD1341TA900017';
    anns.push({
      description: 'R33PD1347TA900017',
      boundingPoly: { vertices: [{x:40,y:600},{x:350,y:600},{x:350,y:630},{x:40,y:630}] },
    });

    const r = parsePlate(out);
    expect(r.fields.vin).toBe('R33PD1347TA900017');
    expect(r.vinCheck.ok).toBe(true);
  });

  it('assembles a VIN split across neighbouring tokens', () => {
    const out = structuredClone(response);
    const anns = out.responses[0].textAnnotations;
    const whole = anns.find((a) => a.description === 'R33PD1347TA900017');
    const y = whole.boundingPoly.vertices[0].y;
    whole.description = 'R33PD1347';
    whole.boundingPoly.vertices = [{x:250,y},{x:400,y},{x:400,y:y+30},{x:250,y:y+30}];
    anns.push({
      description: 'TA900017',
      boundingPoly: { vertices: [{x:410,y},{x:560,y},{x:560,y:y+30},{x:410,y:y+30}] },
    });

    const r = parsePlate(out);
    expect(r.fields.vin).toBe('R33PD1347TA900017');
    expect(r.vinCheck.ok).toBe(true);
  });

  it('hands back a well-formed but unverified candidate rather than nothing', () => {
    const out = structuredClone(response);
    // Corrupt a data character, not the check digit: the P at index 3 read
    // as a 9, which is the classic misread on an engraved plate.
    out.responses[0].textAnnotations.find(
      (a) => a.description === 'R33PD1347TA900017'
    ).description = 'R339D1347TA900017';

    const r = parsePlate(out);
    expect(r.fields.vin).toBe('R339D1347TA900017');
    expect(r.vinCheck.ok).toBe(false);
    // and the user gets offered the repair
    expect(r.vinSuggestion).toBe('R33PD1347TA900017');
  });

  it('does not try to repair the check digit itself', () => {
    // If the check digit is what was misread, changing a data character to
    // match it would produce a different, wrong VIN that happens to validate.
    // suggestVinFix never touches position 9, so any repair it offers is a
    // repair to the VIN body - and the user still has to confirm it.
    const out = structuredClone(response);
    out.responses[0].textAnnotations.find(
      (a) => a.description === 'R33PD1347TA900017'
    ).description = 'R33PD1341TA900017'; // only the check digit changed

    const r = parsePlate(out);
    expect(r.vinCheck.ok).toBe(false);
    if (r.vinSuggestion !== null) {
      expect(r.vinSuggestion).not.toBe('R33PD1347TA900017');
      expect(r.vinSuggestion[8]).toBe('1'); // the check digit is left as read
    }
  });

  it('returns null when there is no VIN-shaped run at all', () => {
    const r = parsePlate({ responses: [{ textAnnotations: [
      { description: 'MANUFACTURER Breath Trailer' },
      { description: 'MANUFACTURER', boundingPoly: { vertices: [{x:40,y:100},{x:230,y:100},{x:230,y:130},{x:40,y:130}] } },
      { description: 'Breath', boundingPoly: { vertices: [{x:250,y:100},{x:330,y:100},{x:330,y:130},{x:250,y:130}] } },
    ] }] });
    expect(r.fields.vin).toBe(null);
    expect(r.fields.manufacturer).toBe('Breath');
  });
});

// The reported failure: a plate photographed with the phone turned sideways
// left the confirm screen's VIN and Manufacturer boxes empty. Grouping rows off
// raw image coordinates found a COLUMN of labels - VIN, MM, MAX, BODY, TOTAL -
// so no label ever shared a row with its value.
describe('the sideways scan that came back blank', () => {
  const degraded = JSON.parse(
    readFileSync(new URL('./fixtures/plate-vision-degraded.json', import.meta.url), 'utf8')
  );

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

  it.each([90, -90, 180])('fills VIN and manufacturer at %s degrees', (deg) => {
    const r = parsePlate(rotate(degraded, deg));
    expect(r.fields.vin).toBe('R33PD1349TA260019');
    expect(r.vinCheck.ok).toBe(true);
    expect(r.fields.manufacturer).toBe('Breath Trailer');
  });

  it('finds the VIN even if the rotation logic itself were to fail', () => {
    // Belt and braces: the check-digit search does not use geometry at all, so
    // it still finds the VIN in a response with no usable boxes whatsoever.
    const flat = {
      responses: [{ textAnnotations: [
        { description: 'whole text' },
        ...degraded.responses[0].textAnnotations.slice(1).map((a) => ({
          description: a.description,
          boundingPoly: { vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
        })),
      ] }],
    };
    expect(parsePlate(flat).fields.vin).toBe('R33PD1349TA260019');
  });
});
