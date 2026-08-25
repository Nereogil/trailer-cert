import { tokensFromVisionResponse, groupIntoLines } from './vision-geometry.js';

// Reads the two screens of an RS PRO MT-6600 that matter for a camper trailer
// certification: the RCD auto-test table and the low-ohm continuity reading.
//
// A backlit LCD is a far kinder subject than an engraved plate - clean glyphs,
// high contrast, no glare on metal - so this is mostly a matter of finding the
// right row rather than fighting the OCR.
//
// Scope is deliberately narrow. The auto test reports six trip times (x1/2, x1
// and x5, each at 0 and 180 degrees); only the x1 pair is kept, because that is
// what goes on the certificate. The others are still visible in the photo
// attached to the job.

const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

const toNumber = (text) => {
  const cleaned = String(text).replace(/[^\d.,-]/g, '').replace(',', '.');
  if (!NUMBER.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

const flat = (response) =>
  (response?.responses?.[0]?.textAnnotations?.[0]?.description ?? '').replace(/\s+/g, ' ');

export function detectScreen(response) {
  const text = flat(response).toUpperCase();
  if (/CONTINUITY/.test(text)) return 'continuity';
  if (/\bRCD\b/.test(text) || /TRIP\s*C/.test(text)) return 'rcd';
  if (/INSULATION/.test(text)) return 'insulation';
  return 'unknown';
}

// The multiplier column reads "x1/2", "x1", "x5" - and the OCR may render the
// x as a multiplication sign, or split "x1/2" across tokens. Matching has to be
// exact about x1 versus x1/2, because taking the wrong row would put a
// half-current result on the certificate as if it were the rated-current one.
// The multiplier is not necessarily the first thing on the row. The tester's
// left sidebar - "Trip C.. / 30mA / Type Of.." - is printed at the same heights
// as the table, so those labels land in the same visual row and arrive ahead of
// the multiplier.
//
// So: look for the multiplier as a standalone token anywhere on the row, and
// report where it sits, because everything else worth reading is to its right.
function findMultiplier(line) {
  const clean = (s) => s.replace(/[×✕✖]/g, 'x').toUpperCase().replace(/[^X0-9/]/g, '');

  for (let i = 0; i < line.length; i++) {
    // Longest first, because "x1/2" can arrive as one token or as three, and a
    // bare "x1" prefix must not win over the "x1/2" it is part of.
    for (let n = Math.min(3, line.length - i); n >= 1; n--) {
      const joined = clean(line.slice(i, i + n).map((t) => t.text).join(''));
      const kind = /^X1\/2$/.test(joined) ? 'half'
        : /^X5$/.test(joined) ? 'five'
        : /^X1$/.test(joined) ? 'one'
        : null;
      if (kind) return { kind, startIndex: i, endIndex: i + n - 1 };
    }
  }
  return null;
}

// The angle sits in the column immediately after the multiplier, so only that
// column is examined.
//
// Scanning the rest of the row instead looks fine until a trip time of 180 ms
// turns up on the 0-degree row: the search finds the "180" of the reading
// before the "0" of the angle, and files a real result against the wrong phase.
function angleOf(line, fromIndex = 0) {
  for (const token of line.slice(fromIndex, fromIndex + 2)) {
    const digits = token.text.replace(/[^\d]/g, '');
    if (digits === '180') return 180;
    if (digits === '0') return 0;
  }
  return null;
}

// The trip time is the last number on the row, sitting before "ms". A row that
// did not trip reads ">2000".
function tripTimeOf(line, fromIndex = 0) {
  // Only what sits to the right of the multiplier counts, so a number in the
  // tester's left sidebar can never be mistaken for a trip time.
  const row = line.slice(fromIndex);
  const joined = row.map((t) => t.text).join(' ');
  if (/>\s*\d/.test(joined)) return { ms: null, noTrip: true };

  const msIndex = row.findIndex((t) => /^MS$/i.test(t.text.replace(/[^A-Za-z]/g, '')));
  const candidates = msIndex > 0 ? row.slice(0, msIndex) : row;

  // The angle column also holds numbers, so the value is picked by position:
  // it is the rightmost number on the row, just before the "ms".
  //
  // Position rather than value, deliberately. Discarding 0 and 180 as "that is
  // the angle" would also discard a genuine 180 ms trip time, which is a
  // perfectly ordinary reading for a 30 mA RCD at rated current.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const text = candidates[i].text;
    if (/°/.test(text)) continue;
    const n = toNumber(text);
    if (n !== null) return { ms: n, noTrip: false };
  }
  return { ms: null, noTrip: false };
}

function tripCurrentOf(response) {
  const text = flat(response);
  const m = /(\d+(?:[.,]\d+)?)\s*mA/i.exec(text);
  return m ? toNumber(m[1]) : null;
}

export function parseRcdScreen(response) {
  const lines = groupIntoLines(tokensFromVisionResponse(response));

  const result = {
    kind: 'rcd',
    tripCurrentMa: tripCurrentOf(response),
    x1Zero: null,
    x1OneEighty: null,
    halfTripped: null,
    warnings: [],
  };

  let sawHalf = false;
  let halfTripped = false;

  for (const line of lines) {
    const found = findMultiplier(line);
    if (!found) continue;
    const multiplier = found.kind;
    const after = found.endIndex + 1;
    const angle = angleOf(line, after);
    const { ms, noTrip } = tripTimeOf(line, after);

    if (multiplier === 'half') {
      sawHalf = true;
      // At half the rated current the RCD is supposed NOT to trip, so a time
      // here is a fail, and ">2000" is the healthy answer.
      if (!noTrip && ms !== null) halfTripped = true;
      continue;
    }

    if (multiplier !== 'one') continue;
    if (noTrip) {
      result.warnings.push(`The x1 test at ${angle ?? '?'} degrees did not trip.`);
      continue;
    }
    if (ms === null) continue;
    if (angle === 180) result.x1OneEighty = ms;
    else if (angle === 0) result.x1Zero = ms;
  }

  if (sawHalf) result.halfTripped = halfTripped;

  if (result.x1Zero === null && result.x1OneEighty === null) {
    result.warnings.push('No x1 trip time was read. Check the photo shows the whole table.');
  }
  if (result.tripCurrentMa === null) {
    result.warnings.push('The rated trip current was not read. Type it in.');
  }
  if (halfTripped) {
    result.warnings.push('The RCD tripped at half its rated current, which is a fail.');
  }

  return result;
}

// On the continuity screen the reading is set in a much larger font than
// anything else, so the tallest numeric box is the measurement. That beats
// pattern-matching, which would have to tell the reading apart from the limit
// sitting in the corner.
export function parseContinuityScreen(response) {
  const tokens = tokensFromVisionResponse(response);

  const numeric = tokens
    .map((t) => ({ token: t, value: toNumber(t.text) }))
    .filter((t) => t.value !== null && t.value >= 0);

  const result = { kind: 'continuity', ohms: null, limitOhms: null, warnings: [] };

  if (numeric.length === 0) {
    result.warnings.push('No reading was found on that photo.');
    return result;
  }

  const biggest = numeric.reduce((a, b) => (b.token.h > a.token.h ? b : a));
  result.ohms = biggest.value;

  // The limit is printed next to the word "Continuity" as e.g. "0.5Ω".
  const text = flat(response);
  const limit = /Continuity\s*([\d.,]+)\s*(?:Ω|OHM)?/i.exec(text);
  if (limit) result.limitOhms = toNumber(limit[1]);

  if (result.limitOhms !== null && result.ohms !== null && result.ohms > result.limitOhms) {
    result.warnings.push(
      `The reading ${result.ohms} is above the ${result.limitOhms} limit set on the tester.`
    );
  }

  // A tester left on a stale reading is easy to photograph by mistake.
  if (result.ohms === 0) {
    result.warnings.push('The reading is exactly zero. Check the leads were on the point.');
  }

  return result;
}

export function parseTesterScreen(response) {
  const kind = detectScreen(response);

  if (kind === 'rcd') return parseRcdScreen(response);
  if (kind === 'continuity') return parseContinuityScreen(response);

  return {
    kind,
    warnings: [
      kind === 'insulation'
        ? 'That looks like the insulation screen, which is not read yet. Type the value in.'
        : 'That photo does not look like the RCD or continuity screen.',
    ],
  };
}
