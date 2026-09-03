import { tokensFromVisionResponse, groupIntoLines } from './vision-geometry.js';

// Reads the two screens of an RS PRO MT-6600 that matter for a camper trailer
// certification: the RCD auto-test table and the low-ohm continuity reading.
//
// A backlit LCD is a far kinder subject than an engraved plate - clean glyphs,
// high contrast, no glare on metal - so this is mostly a matter of finding the
// right row rather than fighting the OCR.
//
// Scope is deliberately narrow. The auto test reports six trip times (x1/2, x1
// and x5, each at 0 and 180 degrees); only the x1 pair is kept, and of those
// the 0 degree reading is the one that goes on the certificate. The 180 degree
// row inverts phase against neutral, which these installations never see, so it
// is read for cross-checking only. The rest stay visible in the photo attached
// to the job.

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
//
// The zero of "0°" comes back as a letter O often enough to matter, and the
// degree sign itself is sometimes read as another zero, so "O°", "0", "00" and
// "18O°" all have to land on the right angle. Requiring an exact "0" or "180"
// threw the whole row away for want of a label - the trip time beside it had
// read perfectly - and said nothing, so the certificate quietly took the other
// row's figure instead.
function angleOf(line, fromIndex = 0) {
  for (const token of line.slice(fromIndex, fromIndex + 2)) {
    const digits = fixDigits(token.text).replace(/[^\d]/g, '');
    if (/^180/.test(digits)) return 180;
    if (/^0+$/.test(digits)) return 0;
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

// The rated trip current is printed in the left sidebar under "Trip C..", as
// "30mA". It can arrive as one token or as "30" then "mA", and a zero is easily
// read back as a letter O, so all three are handled.
const RATED_CURRENTS = [6, 10, 30, 100, 300, 500, 1000];

function fixDigits(text) {
  return String(text).replace(/[Oo]/g, '0').replace(/[lI]/g, '1');
}

function tripCurrentOf(response) {
  const tokens = tokensFromVisionResponse(response);
  const lines = groupIntoLines(tokens);

  // "30mA" as a single token.
  for (const token of tokens) {
    const m = /^(\d{1,4})m\s?A$/i.exec(fixDigits(token.text).replace(/\s+/g, ''));
    if (m) return Number(m[1]);
  }

  // "30" sitting just left of a bare "mA".
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      if (!/^m\s?A$/i.test(line[i].text.replace(/\s+/g, ''))) continue;
      for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
        const n = toNumber(fixDigits(line[j].text));
        if (n !== null) return n;
      }
    }
  }

  const m = /(\d+(?:[.,]\d+)?)\s*m\s?A/i.exec(fixDigits(flat(response)));
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
  // x1 rows whose angle column would not read, in the order they appear.
  const unlabelled = [];

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
    else unlabelled.push(ms);
  }

  // A trip time whose label would not read is still a real measurement. The
  // tester prints 0 above 180 for a given multiplier and groupIntoLines returns
  // rows top to bottom, so the empty half of the pair can be filled from the
  // order the rows arrived in. Inferred rather than read, so it is called out.
  for (const ms of unlabelled) {
    if (result.x1Zero === null) {
      result.x1Zero = ms;
      result.warnings.push(
        `The angle column did not read on an x1 row; ${ms} ms was taken as the 0 degree test. Check it against the photo.`
      );
    } else if (result.x1OneEighty === null) {
      result.x1OneEighty = ms;
    }
  }

  if (sawHalf) result.halfTripped = halfTripped;

  if (result.x1Zero === null && result.x1OneEighty === null) {
    result.warnings.push('No x1 trip time was read. Check the photo shows the whole table.');
  }
  if (result.tripCurrentMa === null) {
    result.warnings.push('The rated trip current was not read. Type it in.');
  } else if (!RATED_CURRENTS.includes(result.tripCurrentMa)) {
    result.warnings.push(
      `The trip current read as ${result.tripCurrentMa} mA, which is not a standard rating. Check it.`
    );
  }

  // The single figure the certificate wants is the x1 test at 0 degrees.
  //
  // The 180 degree row inverts phase against neutral, a condition these
  // installations never see, so it is read for reference and deliberately kept
  // off the certificate. This used to take the slower of the pair, which put
  // the 180 figure in the form whenever it read slower and left it to be
  // corrected by hand on every job.
  result.tripTimeMs = result.x1Zero;

  if (result.x1Zero === null && result.x1OneEighty !== null) {
    result.warnings.push(
      `Only the 180 degree row was read (${result.x1OneEighty} ms). The certificate takes the 0 degree figure, so check the photo and type it in.`
    );
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
