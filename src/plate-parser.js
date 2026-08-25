import { normalizeVin, validateVin, suggestVinFix } from './vin.js';

// Turns a Google Vision DOCUMENT_TEXT_DETECTION response into the fields
// printed on a trailer compliance plate.
//
// The plate is a two-column form: "BODY SIZE 290X150X136 CM" and
// "ATM 1500 KGS" occupy the same printed row. Reading Vision's text in
// document order interleaves the two columns, so values end up attached to the
// wrong labels. Everything here works from the bounding boxes instead: group
// tokens into visual rows, find each label's box, then take the value boxes
// that sit to its right within the same row and stop at the next label.

export function tokensFromVisionResponse(response) {
  const annotations = response?.responses?.[0]?.textAnnotations ?? [];
  // annotations[0] is the entire block of text; the rest are individual words.
  const raw = annotations
    .slice(1)
    .map((a) => {
      const vertices = (a.boundingPoly?.vertices ?? []).map((v) => ({ x: v.x ?? 0, y: v.y ?? 0 }));
      if (vertices.length < 4) return null;
      return { text: a.description ?? '', vertices };
    })
    .filter((t) => t && t.text.length > 0);

  return boundsFromVertices(rotateUpright(raw));
}

// A photo taken with the phone turned sideways puts the plate's text running
// vertically down the image. Vision reads it perfectly well, but every box
// comes back in image coordinates, so grouping "words that share a y" finds
// columns instead of rows and the whole two-column layout falls apart.
//
// The fix is to measure how the text is actually lying and rotate the
// coordinates flat before any of the row logic runs. Each box's first two
// vertices are its top-left and top-right corners, so the vector between them
// is the direction the text runs.
export function textAngle(tokens) {
  const angles = tokens
    .map(({ vertices }) => {
      const [tl, tr] = vertices;
      const dx = tr.x - tl.x;
      const dy = tr.y - tl.y;
      return Math.hypot(dx, dy) < 1 ? null : Math.atan2(dy, dx);
    })
    .filter((a) => a !== null)
    .sort((a, b) => a - b);

  if (angles.length === 0) return 0;
  return angles[Math.floor(angles.length / 2)];
}

function rotateUpright(tokens) {
  const angle = textAngle(tokens);
  // Leave a nearly-straight photo alone; rotating it would only add rounding
  // noise to coordinates that are already fine.
  if (Math.abs(angle) < 0.09) return tokens; // about 5 degrees

  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  return tokens.map((token) => ({
    ...token,
    vertices: token.vertices.map(({ x, y }) => ({
      x: x * cos - y * sin,
      y: x * sin + y * cos,
    })),
  }));
}

function boundsFromVertices(tokens) {
  return tokens.map(({ text, vertices }) => {
    const xs = vertices.map((v) => v.x);
    const ys = vertices.map((v) => v.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    return {
      text,
      x0, y0, x1, y1,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      h: y1 - y0,
    };
  });
}

export function groupIntoLines(tokens) {
  if (tokens.length === 0) return [];

  // Tolerance scales with the type size so the same code copes with a photo
  // taken close up or from arm's length.
  const heights = tokens.map((t) => t.h).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  const tolerance = medianHeight * 0.6;

  const sorted = [...tokens].sort((a, b) => a.cy - b.cy);
  const lines = [];
  let current = [sorted[0]];
  let reference = sorted[0].cy;

  for (const token of sorted.slice(1)) {
    if (Math.abs(token.cy - reference) <= tolerance) {
      current.push(token);
    } else {
      lines.push(current);
      current = [token];
      reference = token.cy;
    }
  }
  lines.push(current);

  return lines.map((line) => line.sort((a, b) => a.x0 - b.x0));
}

// Longest phrases first so "TOTAL SIZE" is claimed before a bare "SIZE" can be.
//
// `alts` holds label spellings seen coming back from real scans of an engraved,
// glossy plate. The first live scan returned GTM as "GL", which an exact match
// missed entirely. Aliases are listed explicitly rather than matched by edit
// distance, because ATM and GTM are one character apart and a fuzzy match would
// happily swap the two weights.
const LABELS = [
  { key: 'axleCapacityKg', words: ['AXLE', 'GROUP', 'LOAD', 'CAPACITY'], type: 'int', below: true },
  { key: 'tareKg', words: ['TARE', 'WEIGHT'], type: 'int', alts: [['TARE', 'WEICHT'], ['TARE', 'WEIGH']] },
  { key: 'maxSpeedKmh', words: ['MAX', 'SPEED'], type: 'int', alts: [['MAX', 'SPEEO'], ['MAX', 'SPFED']] },
  { key: 'totalSizeCm', words: ['TOTAL', 'SIZE'], type: 'text' },
  { key: 'bodySizeCm', words: ['BODY', 'SIZE'], type: 'text' },
  { key: 'vin', words: ['VIN', 'NUMBER'], type: 'vin', alts: [['VIN', 'NUMBFR'], ['VIN', 'NO']] },
  { key: 'manufacturer', words: ['MANUFACTURER'], type: 'text' },
  { key: 'atmKg', words: ['ATM'], type: 'int', alts: [['ATN'], ['AIM'], ['A1M']] },
  { key: 'gtmKg', words: ['GTM'], type: 'int', alts: [['GL'], ['GTN'], ['G1M'], ['GIM'], ['CTM'], ['6TM'], ['GTIM']] },
  { key: 'mm', words: ['MM'], type: 'text' },
  { key: 'yy', words: ['YY'], type: 'text' },
];

const UNITS = new Set(['CM', 'KG', 'KGS', 'KM/H', 'KM', 'H', 'MM']);

// Marks printed on the plate that are never a field value: the maker's web
// address and the CE / ISO certification stamps, which sit near the top and can
// otherwise be swallowed into the manufacturer field.
//
// Deliberately narrow. An earlier attempt also blacklisted the words in the
// compliance paragraph along the bottom ("THE TRAILER IS MANUFACTURED TO
// COMPLY WITH..."), which promptly ate the "Trailer" out of "Breath Trailer".
// The paragraph needs no special handling anyway: it sits on its own lines with
// no labels, so no value run ever reaches it.
const NOISE = [
  /^[A-Z0-9-]+\.(COM|COM\.AU|NET|ORG)$/,
  /^ISO\d/,
  /^CE$/,
];

const cleanWord = (text) => text.toUpperCase().replace(/[^A-Z/]/g, '');

function isNoise(token) {
  const raw = token.text.toUpperCase();
  return NOISE.some((re) => re.test(raw));
}

function matchesWords(line, index, words) {
  for (let k = 0; k < words.length; k++) {
    const token = line[index + k];
    if (!token || cleanWord(token.text) !== words[k]) return false;
  }
  return true;
}

function matchesLabelAt(line, index, label) {
  if (matchesWords(line, index, label.words)) return label.words.length;
  for (const alt of label.alts ?? []) {
    if (matchesWords(line, index, alt)) return alt.length;
  }
  return 0;
}

// Record every label with the token span it consumed, so value extraction can
// stop at the next label instead of running into it.
function locateLabels(lines) {
  const found = [];

  lines.forEach((line, lineIndex) => {
    const claimed = new Set();
    for (const label of LABELS) {
      if (found.some((f) => f.key === label.key)) continue;
      for (let i = 0; i < line.length; i++) {
        if (claimed.has(i)) continue;
        const matchedLength = matchesLabelAt(line, i, label);
        if (matchedLength === 0) continue;

        const end = i + matchedLength - 1;
        for (let k = i; k <= end; k++) claimed.add(k);
        found.push({
          key: label.key,
          type: label.type,
          below: !!label.below,
          lineIndex,
          startIndex: i,
          endIndex: end,
          xEnd: line[end].x1,
        });
        break;
      }
    }
  });

  return found;
}

// A value run stops at the next label on the same row — but the bottom row has
// "MAX SPEED 80 KM/H" on the left and the axle capacity's stray "1500 KGS" on
// the right, with no label in between to stop it. So each label also claims the
// tokens it consumes, and a claimed token ends any later run that reaches it.
function valueTokens(lines, label, allLabels, claimed) {
  const line = lines[label.lineIndex];
  if (!line) return [];

  const usable = (token) =>
    !claimed.has(token) && !UNITS.has(cleanWord(token.text)) && !isNoise(token);

  if (label.below) {
    // AXLE GROUP LOAD CAPACITY is the one label whose value is printed on the
    // row beneath it rather than beside it.
    const next = lines[label.lineIndex + 1];
    if (!next) return [];
    const leftEdge = label.xEnd - 400;
    return next.filter((t) => t.x0 >= leftEdge && usable(t) && /\d/.test(t.text));
  }

  const nextLabelOnLine = allLabels
    .filter((l) => l.lineIndex === label.lineIndex && l.startIndex > label.endIndex)
    .sort((a, b) => a.startIndex - b.startIndex)[0];
  const stopIndex = nextLabelOnLine ? nextLabelOnLine.startIndex : line.length;

  const run = [];
  for (const token of line.slice(label.endIndex + 1, stopIndex)) {
    if (claimed.has(token)) break;
    if (UNITS.has(cleanWord(token.text))) continue;
    if (isNoise(token)) continue;
    run.push(token);
  }
  return run;
}

function coerce(type, tokens) {
  if (tokens.length === 0) return null;

  if (type === 'int') {
    // Every numeric field on the plate is a single figure. Concatenating
    // several tokens would silently invent a number, so take the first one
    // carrying digits and ignore whatever follows.
    const first = tokens.find((t) => /\d/.test(t.text));
    if (!first) return null;
    const digits = first.text.replace(/[^0-9]/g, '');
    return digits ? parseInt(digits, 10) : null;
  }

  const joined = tokens.map((t) => t.text).join(' ').trim();
  if (type === 'vin') {
    return normalizeVin(joined) || null;
  }
  return joined || null;
}

export function parsePlate(response) {
  const tokens = tokensFromVisionResponse(response);
  const lines = groupIntoLines(tokens);
  const labels = locateLabels(lines);

  const fields = {
    manufacturer: null,
    vin: null,
    bodySizeCm: null,
    totalSizeCm: null,
    mm: null,
    yy: null,
    maxSpeedKmh: null,
    atmKg: null,
    gtmKg: null,
    tareKg: null,
    axleCapacityKg: null,
  };

  // Resolve in LABELS order so the "value on the row below" label claims its
  // number before a neighbouring label's run can reach across and take it.
  const claimed = new Set();
  const byDeclarationOrder = LABELS.map((l) => labels.find((f) => f.key === l.key)).filter(Boolean);

  for (const label of byDeclarationOrder) {
    const tokens = valueTokens(lines, label, labels, claimed);
    for (const token of tokens) claimed.add(token);
    fields[label.key] = coerce(label.type, tokens);
  }

  return {
    fields,
    vinCheck: validateVin(fields.vin ?? ''),
    vinSuggestion: fields.vin ? suggestVinFix(fields.vin) : null,
    warnings: plateWarnings(fields),
    rawText: response?.responses?.[0]?.textAnnotations?.[0]?.description ?? '',
  };
}

// A compliance plate's weights are related, so some misreads are catchable even
// though the figure itself looks perfectly ordinary. The first live scan read
// GTM as 1300 when the plate says 1380 - nothing here would catch that, which is
// exactly why these are warnings on a form the user confirms rather than
// anything automatic.
export function plateWarnings(fields) {
  const warnings = [];
  const { atmKg, gtmKg, tareKg, axleCapacityKg, mm, yy, maxSpeedKmh, vin, manufacturer } = fields;

  const missing = [
    ['VIN', vin], ['Manufacturer', manufacturer],
    ['ATM', atmKg], ['GTM', gtmKg], ['Tare', tareKg], ['Axle capacity', axleCapacityKg],
    ['Month', mm], ['Year', yy], ['Max speed', maxSpeedKmh],
  ].filter(([, v]) => v === null || v === undefined || v === '').map(([n]) => n);

  if (missing.length) {
    warnings.push(`Not read from the plate: ${missing.join(', ')}. Type these in.`);
  }

  if (atmKg && gtmKg && gtmKg > atmKg) {
    warnings.push(`GTM (${gtmKg}) is above ATM (${atmKg}), which should not happen. Check both.`);
  }
  if (gtmKg && tareKg && tareKg > gtmKg) {
    warnings.push(`Tare (${tareKg}) is above GTM (${gtmKg}), which should not happen. Check both.`);
  }
  for (const [name, value] of [['ATM', atmKg], ['GTM', gtmKg], ['Tare', tareKg], ['Axle capacity', axleCapacityKg]]) {
    if (value !== null && value !== undefined && (value < 50 || value > 10000)) {
      warnings.push(`${name} reads ${value} kg, which is outside the range a camper trailer plate should show.`);
    }
  }
  // A dropped trailing digit turns 730 into 73, which passes every check above
  // on its own. It only looks wrong next to the GTM.
  if (gtmKg && tareKg && tareKg < gtmKg * 0.15) {
    warnings.push(`Tare (${tareKg}) is very light for a GTM of ${gtmKg} — check for a dropped digit.`);
  }

  for (const [name, value] of [['Body size', fields.bodySizeCm], ['Total size', fields.totalSizeCm]]) {
    if (!value) continue;
    const parts = String(value).split(/[X*\-x]/).map((p) => parseInt(p, 10)).filter(Number.isFinite);
    if (parts.length !== 3) {
      warnings.push(`${name} reads "${value}", which is not three measurements.`);
    } else if (parts.some((p) => p < 50)) {
      warnings.push(`${name} reads "${value}" — a figure under 50 cm suggests a dropped digit.`);
    }
  }

  if (yy && !/^(19|20)\d{2}$/.test(String(yy))) {
    warnings.push(`Year reads "${yy}", which is not a four-digit year.`);
  }

  return warnings;
}
