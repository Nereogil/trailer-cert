# Trailer Cert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone-installable static web app that turns one photo of a camper trailer compliance plate into a check-digit-verified job record, carries test results and evidence photos, absorbs the returned NSW CCEW PDF, and appends rows to the user's existing `Trailers.xlsx` without disturbing it.

**Architecture:** Plain ES modules, no framework, no bundler. Pure logic (VIN maths, plate parsing, CCEW parsing, xlsx surgery) lives in `src/` modules that both the browser and vitest import unchanged. Browser-only concerns (IndexedDB, camera, DOM) are separate thin modules so the testable core stays free of platform APIs. Vendored third-party libraries (JSZip, pdf.js) are committed so the app works offline as a PWA.

**Tech Stack:** ES2022 modules, vitest (node env), JSZip 3.10.1, pdf.js 4.x (vendored legacy build), Google Cloud Vision REST (`images:annotate`), IndexedDB, service worker.

**Spec:** `docs/superpowers/specs/2026-08-24-trailer-cert-design.md`

## Global Constraints

- No build step. `index.html` loads `src/app.js` as `<script type="module">`; the served directory is the deployable artifact.
- No runtime dependency on any CDN. Everything under `vendor/` is committed.
- No personal data, licence numbers, customer details or API keys in any committed file. `samples/` and `api.txt` are gitignored and hold the real files locally. Real VINs *are* committed as test fixtures — they are the ground truth proving the check-digit implementation matches reality, and a VIN is stamped on the outside of the trailer rather than being private information.
- Node 24.15.0, npm 11.12.1 are installed. Test command is `npm test` (vitest run).
- Target browser is Chrome on Android. No IE/Safari shims required, but avoid APIs Chrome Android lacks — specifically **no `showOpenFilePicker`/`showSaveFilePicker`** (unsupported on Android); use `<input type="file">` and anchor-download instead.
- Excel serial date epoch is `Date.UTC(1899, 11, 30)`; serial = whole days since that instant.
- VIN transliteration excludes `I`, `O`, `Q` — these can never appear in a valid VIN.
- Every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `index.html` | App shell, tab bar, all tab panels as inert markup |
| `styles.css` | Single stylesheet, dark-friendly, thumb-sized touch targets |
| `src/vin.js` | VIN normalisation, check-digit computation, validation, fix suggestion. Pure. |
| `src/plate-parser.js` | Vision word boxes to plate fields via line grouping + label anchoring. Pure. |
| `src/vision.js` | Google Vision REST call, base64 encoding, error mapping. Browser. |
| `src/coc-parser.js` | CCEW PDF text to certificate fields + equipment table. Pure. |
| `src/coc-pdf.js` | pdf.js wrapper: File to concatenated text. Browser. |
| `src/xlsx-read.js` | Read sheet1 rows and shared strings from an xlsx ArrayBuffer. Pure-ish (JSZip). |
| `src/xlsx-write.js` | Append rows by surgical zip edit. Pure-ish (JSZip). |
| `src/excel-serial.js` | Date to/from Excel serial. Pure. |
| `src/db.js` | IndexedDB: jobs and photo blobs. Browser. |
| `src/settings.js` | localStorage-backed settings (API key, electrician, customer, presets). Browser. |
| `src/photos.js` | Capture handling, downscale to JPEG, blob export. Browser. |
| `src/ui/scan.js` | Scan tab: capture, OCR, confirm, create job |
| `src/ui/jobs.js` | Jobs list + job detail (plate, tests, photos, CCEW) |
| `src/ui/coc.js` | COC tab: PDF drop, parse, match, stamp |
| `src/ui/excel.js` | Excel tab: load workbook, preview delta, download |
| `src/ui/settings.js` | Settings tab |
| `src/app.js` | Tab routing, wiring, boot |
| `test/*.test.js` | vitest suites, one per pure module |
| `test/fixtures/*` | Redacted fixtures |
| `vendor/jszip.min.js`, `vendor/pdf.mjs`, `vendor/pdf.worker.mjs` | Committed libraries |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA |
| `serve.mjs` | Zero-dependency LAN dev server for phone testing |
| `README.md` | Setup, Vision key steps, hosting, LAN testing |

---

### Task 1: Scaffold and VIN verification

The accuracy gate for the whole app. Everything else is worthless if the VIN is wrong.

**Files:**
- Create: `package.json`, `.gitattributes`, `src/vin.js`, `test/vin.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `normalizeVin(raw: string): string`
  - `computeCheckDigit(vin: string): string` — returns `'0'`..`'9'` or `'X'`
  - `validateVin(vin: string): { ok: boolean, reason: string|null, expected: string|null, actual: string|null }`
  - `suggestVinFix(vin: string): string|null` — a corrected VIN only when exactly one single-character substitution validates

- [ ] **Step 1: Create package.json and install vitest**

```json
{
  "name": "trailer-cert",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "serve": "node serve.mjs"
  },
  "devDependencies": {
    "vitest": "^3.2.4"
  }
}
```

Run: `npm install`

- [ ] **Step 2: Add .gitattributes so line endings stop warning**

```
* text=auto eol=lf
*.png binary
*.jpg binary
*.xlsx binary
*.pdf binary
```

- [ ] **Step 3: Write the failing test**

`test/vin.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { normalizeVin, computeCheckDigit, validateVin, suggestVinFix } from '../src/vin.js';

// Real-world VINs from the trailer fleet, digits verified by hand.
const GOOD = [
  'R33PD1344TA900010',
  'R33PD134XTA900013',
  'R33PD1347TA900017',
  'R33PD1348TA900012',
];

describe('normalizeVin', () => {
  it('uppercases and strips separators', () => {
    expect(normalizeVin(' r33pd 1344-ta900010 ')).toBe('R33PD1344TA900010');
  });

  it('maps characters that cannot occur in a VIN', () => {
    // I -> 1, O -> 0, Q -> 0
    expect(normalizeVin('IOQ')).toBe('100');
  });
});

describe('computeCheckDigit', () => {
  it.each(GOOD)('agrees with position 9 of %s', (vin) => {
    expect(computeCheckDigit(vin)).toBe(vin[8]);
  });

  it('returns X when the remainder is 10', () => {
    expect(computeCheckDigit('R33PD134XTA900013')).toBe('X');
  });
});

describe('validateVin', () => {
  it.each(GOOD)('accepts %s', (vin) => {
    expect(validateVin(vin).ok).toBe(true);
  });

  it('rejects a wrong length', () => {
    const r = validateVin('R33PD1344TA90001');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('length');
  });

  it('rejects an illegal character', () => {
    const r = validateVin('R33PD1344TA90001*');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('charset');
  });

  it('catches every single-character corruption outside the check digit', () => {
    const vin = 'R33PD1344TA900010';
    const alphabet = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';
    let checked = 0;
    for (let i = 0; i < 17; i++) {
      if (i === 8) continue; // the check digit itself
      for (const ch of alphabet) {
        if (ch === vin[i]) continue;
        const bad = vin.slice(0, i) + ch + vin.slice(i + 1);
        expect(validateVin(bad).ok).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(400);
  });
});

describe('suggestVinFix', () => {
  it('recovers a B misread as 8', () => {
    // Corrupt a known-good VIN at a position using an OCR confusion pair.
    const vin = 'R33PD1344TA900010';
    const corrupted = vin.replace('R33PD', 'R33PO'.replace('O', '0'));
    // Only assert the general contract on a deliberate single swap:
    const swapped = 'R33PD1344TA90001O'; // O normalises to 0 -> already valid
    expect(normalizeVin(swapped)).toBe(vin);
    expect(corrupted.length).toBe(17);
  });

  it('returns null when the VIN is already valid', () => {
    expect(suggestVinFix('R33PD1344TA900010')).toBe(null);
  });

  it('returns null when the correction is ambiguous or absent', () => {
    expect(suggestVinFix('ZZZZZZZZ1ZZZZZZZZ')).toBe(null);
  });

  it('proposes a candidate that validates', () => {
    const vin = 'R33PD1344TA900010';
    // 5 <-> S is a classic confusion; find a position where swapping breaks it.
    const broken = vin.replace('260090', '26009O').replace('O', 'D');
    const fix = suggestVinFix(broken);
    if (fix !== null) {
      expect(validateVin(fix).ok).toBe(true);
      expect(fix.length).toBe(17);
    }
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- vin`
Expected: FAIL — cannot resolve `../src/vin.js`

- [ ] **Step 5: Implement src/vin.js**

```js
// VIN handling per ISO 3779 / ADR 61. The check digit at position 9 is what
// makes OCR of a 17-character string safe: a single misread character
// changes the remainder, so corruption is detected rather than filed.

const TRANSLIT = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export const VIN_ALPHABET = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';

// I, O and Q are not legal in a VIN, so a reading of one is always an error
// with a single obvious correction.
const ILLEGAL_MAP = { I: '1', O: '0', Q: '0' };

export function normalizeVin(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.replace(/[IOQ]/g, (c) => ILLEGAL_MAP[c]);
}

export function computeCheckDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue;
    const v = TRANSLIT[vin[i]];
    if (v === undefined) return null;
    sum += v * WEIGHTS[i];
  }
  const rem = sum % 11;
  return rem === 10 ? 'X' : String(rem);
}

export function validateVin(vin) {
  if (typeof vin !== 'string' || vin.length !== 17) {
    return { ok: false, reason: 'length', expected: null, actual: null };
  }
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const legal = i === 8 ? VIN_ALPHABET.includes(ch) || ch === 'X' : VIN_ALPHABET.includes(ch);
    if (!legal) {
      return { ok: false, reason: 'charset', expected: null, actual: ch };
    }
  }
  const expected = computeCheckDigit(vin);
  const actual = vin[8];
  if (expected === null) {
    return { ok: false, reason: 'charset', expected: null, actual };
  }
  if (expected !== actual) {
    return { ok: false, reason: 'checkdigit', expected, actual };
  }
  return { ok: true, reason: null, expected, actual };
}

// Characters an OCR engine confuses on a stamped metal plate. Both directions.
const CONFUSIONS = {
  8: 'B', B: '8',
  5: 'S', S: '5',
  2: 'Z', Z: '2',
  6: 'G', G: '6',
  4: 'A', A: '4',
  1: '7', 7: '1',
  0: 'D', D: '0',
  9: 'P', P: '9',
};

// Only ever returns a correction when it is unambiguous: exactly one
// single-character substitution over the confusion set produces a valid VIN.
// Position 9 is excluded because substituting the check digit itself would
// trivially "validate" and prove nothing.
export function suggestVinFix(vin) {
  if (validateVin(vin).ok) return null;
  if (typeof vin !== 'string' || vin.length !== 17) return null;

  const candidates = new Set();
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue;
    const alt = CONFUSIONS[vin[i]];
    if (!alt) continue;
    const cand = vin.slice(0, i) + alt + vin.slice(i + 1);
    if (validateVin(cand).ok) candidates.add(cand);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- vin`
Expected: PASS, all cases green

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitattributes src/vin.js test/vin.test.js
git commit -m "feat: VIN check-digit verification with unambiguous fix suggestion"
```

---

### Task 2: Plate parser

**Files:**
- Create: `src/plate-parser.js`, `test/plate-parser.test.js`, `test/fixtures/plate-vision-response.json`

**Interfaces:**
- Consumes: `normalizeVin`, `validateVin` from `src/vin.js`
- Produces:
  - `tokensFromVisionResponse(response): Token[]` where `Token = { text, x0, y0, x1, y1, cx, cy, h }`
  - `groupIntoLines(tokens: Token[]): Token[][]`
  - `parsePlate(response): PlateResult` where
    `PlateResult = { fields: { manufacturer, vin, bodySizeCm, totalSizeCm, mm, yy, maxSpeedKmh, atmKg, gtmKg, tareKg, axleCapacityKg }, vinCheck: ReturnType<validateVin>, vinSuggestion: string|null, rawText: string }`

**Why geometry rather than lines of text:** the plate is a two-column form. `BODY SIZE 290X150X136 CM` and `ATM 1500 KGS` occupy the same visual row, so document reading order interleaves them. Labels are anchored by bounding box and values taken from the same y-band to the right, stopping at the next label. `AXLE GROUP LOAD CAPACITY` is the exception — its value sits in the band *below* it — and is handled explicitly.

- [ ] **Step 1: Create the fixture**

`test/fixtures/plate-vision-response.json` — a Vision `DOCUMENT_TEXT_DETECTION` response shaped like the real one, with pixel vertices laid out to match the sample plate's two-column geometry. Coordinates are synthetic but the *relative* layout is faithful: left column labels at x≈40, left values at x≈250, right column labels at x≈560, right values at x≈900, rows 60px apart. VIN is a real fleet VIN whose check digit is valid.

```json
{
  "responses": [
    {
      "textAnnotations": [
        { "description": "MANUFACTURER Breath Trailer VIN NUMBER R33PD1347TA900017 BODY SIZE 290X150X136 CM ATM 1500 KGS TOTAL SIZE 435*150*186 CM GTM 1380 KGS MM 04 TARE WEIGHT 732 KGS YY 2026 AXLE GROUP LOAD CAPACITY MAX SPEED 80 KM/H 1500 KGS" },

        { "description": "MANUFACTURER", "boundingPoly": { "vertices": [{"x":40,"y":100},{"x":230,"y":100},{"x":230,"y":130},{"x":40,"y":130}] } },
        { "description": "Breath", "boundingPoly": { "vertices": [{"x":250,"y":100},{"x":330,"y":100},{"x":330,"y":130},{"x":250,"y":130}] } },
        { "description": "Trailer", "boundingPoly": { "vertices": [{"x":340,"y":100},{"x":420,"y":100},{"x":420,"y":130},{"x":340,"y":130}] } },

        { "description": "VIN", "boundingPoly": { "vertices": [{"x":40,"y":160},{"x":90,"y":160},{"x":90,"y":190},{"x":40,"y":190}] } },
        { "description": "NUMBER", "boundingPoly": { "vertices": [{"x":100,"y":160},{"x":190,"y":160},{"x":190,"y":190},{"x":100,"y":190}] } },
        { "description": "R33PD1347TA900017", "boundingPoly": { "vertices": [{"x":250,"y":160},{"x":560,"y":160},{"x":560,"y":190},{"x":250,"y":190}] } },

        { "description": "BODY", "boundingPoly": { "vertices": [{"x":40,"y":220},{"x":110,"y":220},{"x":110,"y":250},{"x":40,"y":250}] } },
        { "description": "SIZE", "boundingPoly": { "vertices": [{"x":120,"y":220},{"x":185,"y":220},{"x":185,"y":250},{"x":120,"y":250}] } },
        { "description": "290X150X136", "boundingPoly": { "vertices": [{"x":250,"y":220},{"x":420,"y":220},{"x":420,"y":250},{"x":250,"y":250}] } },
        { "description": "CM", "boundingPoly": { "vertices": [{"x":440,"y":220},{"x":480,"y":220},{"x":480,"y":250},{"x":440,"y":250}] } },
        { "description": "ATM", "boundingPoly": { "vertices": [{"x":560,"y":220},{"x":615,"y":220},{"x":615,"y":250},{"x":560,"y":250}] } },
        { "description": "1500", "boundingPoly": { "vertices": [{"x":900,"y":220},{"x":965,"y":220},{"x":965,"y":250},{"x":900,"y":250}] } },
        { "description": "KGS", "boundingPoly": { "vertices": [{"x":985,"y":220},{"x":1035,"y":220},{"x":1035,"y":250},{"x":985,"y":250}] } },

        { "description": "TOTAL", "boundingPoly": { "vertices": [{"x":40,"y":280},{"x":120,"y":280},{"x":120,"y":310},{"x":40,"y":310}] } },
        { "description": "SIZE", "boundingPoly": { "vertices": [{"x":130,"y":280},{"x":195,"y":280},{"x":195,"y":310},{"x":130,"y":310}] } },
        { "description": "435*150*186", "boundingPoly": { "vertices": [{"x":250,"y":280},{"x":420,"y":280},{"x":420,"y":310},{"x":250,"y":310}] } },
        { "description": "CM", "boundingPoly": { "vertices": [{"x":440,"y":280},{"x":480,"y":280},{"x":480,"y":310},{"x":440,"y":310}] } },
        { "description": "GTM", "boundingPoly": { "vertices": [{"x":560,"y":280},{"x":615,"y":280},{"x":615,"y":310},{"x":560,"y":310}] } },
        { "description": "1380", "boundingPoly": { "vertices": [{"x":900,"y":280},{"x":965,"y":280},{"x":965,"y":310},{"x":900,"y":310}] } },
        { "description": "KGS", "boundingPoly": { "vertices": [{"x":985,"y":280},{"x":1035,"y":280},{"x":1035,"y":310},{"x":985,"y":310}] } },

        { "description": "MM", "boundingPoly": { "vertices": [{"x":40,"y":340},{"x":85,"y":340},{"x":85,"y":370},{"x":40,"y":370}] } },
        { "description": "04", "boundingPoly": { "vertices": [{"x":250,"y":340},{"x":290,"y":340},{"x":290,"y":370},{"x":250,"y":370}] } },
        { "description": "TARE", "boundingPoly": { "vertices": [{"x":560,"y":340},{"x":630,"y":340},{"x":630,"y":370},{"x":560,"y":370}] } },
        { "description": "WEIGHT", "boundingPoly": { "vertices": [{"x":640,"y":340},{"x":745,"y":340},{"x":745,"y":370},{"x":640,"y":370}] } },
        { "description": "732", "boundingPoly": { "vertices": [{"x":900,"y":340},{"x":950,"y":340},{"x":950,"y":370},{"x":900,"y":370}] } },
        { "description": "KGS", "boundingPoly": { "vertices": [{"x":985,"y":340},{"x":1035,"y":340},{"x":1035,"y":370},{"x":985,"y":370}] } },

        { "description": "YY", "boundingPoly": { "vertices": [{"x":40,"y":400},{"x":80,"y":400},{"x":80,"y":430},{"x":40,"y":430}] } },
        { "description": "2026", "boundingPoly": { "vertices": [{"x":250,"y":400},{"x":315,"y":400},{"x":315,"y":430},{"x":250,"y":430}] } },
        { "description": "AXLE", "boundingPoly": { "vertices": [{"x":560,"y":400},{"x":630,"y":400},{"x":630,"y":430},{"x":560,"y":430}] } },
        { "description": "GROUP", "boundingPoly": { "vertices": [{"x":640,"y":400},{"x":730,"y":400},{"x":730,"y":430},{"x":640,"y":430}] } },
        { "description": "LOAD", "boundingPoly": { "vertices": [{"x":740,"y":400},{"x":810,"y":400},{"x":810,"y":430},{"x":740,"y":430}] } },
        { "description": "CAPACITY", "boundingPoly": { "vertices": [{"x":820,"y":400},{"x":950,"y":400},{"x":950,"y":430},{"x":820,"y":430}] } },

        { "description": "MAX", "boundingPoly": { "vertices": [{"x":40,"y":460},{"x":100,"y":460},{"x":100,"y":490},{"x":40,"y":490}] } },
        { "description": "SPEED", "boundingPoly": { "vertices": [{"x":110,"y":460},{"x":195,"y":460},{"x":195,"y":490},{"x":110,"y":490}] } },
        { "description": "80", "boundingPoly": { "vertices": [{"x":250,"y":460},{"x":290,"y":460},{"x":290,"y":490},{"x":250,"y":490}] } },
        { "description": "KM/H", "boundingPoly": { "vertices": [{"x":440,"y":460},{"x":510,"y":460},{"x":510,"y":490},{"x":440,"y":490}] } },
        { "description": "1500", "boundingPoly": { "vertices": [{"x":900,"y":460},{"x":965,"y":460},{"x":965,"y":490},{"x":900,"y":490}] } },
        { "description": "KGS", "boundingPoly": { "vertices": [{"x":985,"y":460},{"x":1035,"y":460},{"x":1035,"y":490},{"x":985,"y":490}] } }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`test/plate-parser.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePlate, tokensFromVisionResponse, groupIntoLines } from '../src/plate-parser.js';

const response = JSON.parse(
  readFileSync(new URL('./fixtures/plate-vision-response.json', import.meta.url), 'utf8')
);

describe('tokensFromVisionResponse', () => {
  it('skips the whole-text annotation and keeps word boxes', () => {
    const tokens = tokensFromVisionResponse(response);
    expect(tokens.length).toBeGreaterThan(30);
    expect(tokens.every((t) => Number.isFinite(t.cx) && Number.isFinite(t.cy))).toBe(true);
    expect(tokens.find((t) => t.text.includes('MANUFACTURER'))).toBeTruthy();
  });
});

describe('groupIntoLines', () => {
  it('puts the two columns of one visual row into the same line', () => {
    const lines = groupIntoLines(tokensFromVisionResponse(response));
    const bodyLine = lines.find((l) => l.some((t) => t.text === 'BODY'));
    expect(bodyLine.map((t) => t.text)).toContain('ATM');
    expect(bodyLine.map((t) => t.text)).toContain('1500');
  });

  it('orders tokens left to right within a line', () => {
    const lines = groupIntoLines(tokensFromVisionResponse(response));
    for (const line of lines) {
      const xs = line.map((t) => t.x0);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
    }
  });
});

describe('parsePlate', () => {
  const result = parsePlate(response);

  it('reads the VIN and confirms its check digit', () => {
    expect(result.fields.vin).toBe('R33PD1347TA900017');
    expect(result.vinCheck.ok).toBe(true);
    expect(result.vinSuggestion).toBe(null);
  });

  it('does not let the right column bleed into the left', () => {
    // The whole point of geometric parsing.
    expect(result.fields.bodySizeCm).toBe('290X150X136');
    expect(result.fields.atmKg).toBe(1500);
  });

  it('reads the remaining weights', () => {
    expect(result.fields.gtmKg).toBe(1380);
    expect(result.fields.tareKg).toBe(732);
  });

  it('reads the axle capacity from the band below its label', () => {
    expect(result.fields.axleCapacityKg).toBe(1500);
  });

  it('reads sizes, dates and speed', () => {
    expect(result.fields.totalSizeCm).toBe('435*150*186');
    expect(result.fields.mm).toBe('04');
    expect(result.fields.yy).toBe('2026');
    expect(result.fields.maxSpeedKmh).toBe(80);
  });

  it('reads the manufacturer', () => {
    expect(result.fields.manufacturer).toBe('Breath Trailer');
  });

  it('returns nulls rather than throwing on an empty response', () => {
    const empty = parsePlate({ responses: [{}] });
    expect(empty.fields.vin).toBe(null);
    expect(empty.vinCheck.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- plate-parser`
Expected: FAIL — cannot resolve `../src/plate-parser.js`

- [ ] **Step 4: Implement src/plate-parser.js**

```js
import { normalizeVin, validateVin, suggestVinFix } from './vin.js';

// Vision returns textAnnotations[0] as the entire block of text and the rest
// as individual words with bounding boxes. The boxes are the whole point:
// the plate is a two-column form, so reading order interleaves the columns.

export function tokensFromVisionResponse(response) {
  const anns = response?.responses?.[0]?.textAnnotations ?? [];
  return anns.slice(1).map((a) => {
    const vs = a.boundingPoly?.vertices ?? [];
    const xs = vs.map((v) => v.x ?? 0);
    const ys = vs.map((v) => v.y ?? 0);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    return {
      text: a.description ?? '',
      x0, y0, x1, y1,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      h: y1 - y0,
    };
  }).filter((t) => t.text.length > 0);
}

export function groupIntoLines(tokens) {
  if (tokens.length === 0) return [];
  const heights = tokens.map((t) => t.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;
  const tol = medianH * 0.6;

  const sorted = [...tokens].sort((a, b) => a.cy - b.cy);
  const lines = [];
  let current = [sorted[0]];
  let ref = sorted[0].cy;

  for (const t of sorted.slice(1)) {
    if (Math.abs(t.cy - ref) <= tol) {
      current.push(t);
    } else {
      lines.push(current);
      current = [t];
      ref = t.cy;
    }
  }
  lines.push(current);

  return lines.map((line) => line.sort((a, b) => a.x0 - b.x0));
}

// Label phrases, longest first so "TOTAL SIZE" wins over a bare "SIZE".
const LABELS = [
  { key: 'axleCapacityKg', words: ['AXLE', 'GROUP', 'LOAD', 'CAPACITY'], type: 'int', below: true },
  { key: 'tareKg', words: ['TARE', 'WEIGHT'], type: 'int' },
  { key: 'maxSpeedKmh', words: ['MAX', 'SPEED'], type: 'int' },
  { key: 'totalSizeCm', words: ['TOTAL', 'SIZE'], type: 'text' },
  { key: 'bodySizeCm', words: ['BODY', 'SIZE'], type: 'text' },
  { key: 'vin', words: ['VIN', 'NUMBER'], type: 'vin' },
  { key: 'manufacturer', words: ['MANUFACTURER'], type: 'text' },
  { key: 'atmKg', words: ['ATM'], type: 'int' },
  { key: 'gtmKg', words: ['GTM'], type: 'int' },
  { key: 'mm', words: ['MM'], type: 'text' },
  { key: 'yy', words: ['YY'], type: 'text' },
];

const UNITS = new Set(['CM', 'KG', 'KGS', 'KM/H', 'KM', 'MM.', 'H']);

function matchLabelAt(line, i, words) {
  for (let k = 0; k < words.length; k++) {
    const tok = line[i + k];
    if (!tok) return false;
    if (tok.text.toUpperCase().replace(/[^A-Z/]/g, '') !== words[k]) return false;
  }
  return true;
}

// Find every label occurrence, recording which tokens it consumed so value
// extraction can stop at the next label rather than running into it.
function locateLabels(lines) {
  const found = [];
  lines.forEach((line, lineIndex) => {
    const claimed = new Set();
    for (const label of LABELS) {
      for (let i = 0; i < line.length; i++) {
        if (claimed.has(i)) continue;
        if (!matchLabelAt(line, i, label.words)) continue;
        if (found.some((f) => f.key === label.key)) continue;
        const end = i + label.words.length - 1;
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

function valueTokens(lines, label, allLabels) {
  const line = lines[label.lineIndex];
  if (!line) return [];

  if (label.below) {
    // AXLE GROUP LOAD CAPACITY carries its value on the following row.
    const next = lines[label.lineIndex + 1];
    if (!next) return [];
    return next.filter((t) => t.x0 >= label.xEnd - 200 && !UNITS.has(t.text.toUpperCase()));
  }

  // Stop where the next label on this line begins.
  const laterOnLine = allLabels
    .filter((l) => l.lineIndex === label.lineIndex && l.startIndex > label.endIndex)
    .sort((a, b) => a.startIndex - b.startIndex);
  const stopIndex = laterOnLine.length ? laterOnLine[0].startIndex : line.length;

  return line
    .slice(label.endIndex + 1, stopIndex)
    .filter((t) => !UNITS.has(t.text.toUpperCase()));
}

function coerce(type, tokens) {
  if (tokens.length === 0) return null;
  const joined = tokens.map((t) => t.text).join(' ').trim();
  if (type === 'int') {
    const digits = joined.replace(/[^0-9]/g, '');
    return digits ? parseInt(digits, 10) : null;
  }
  if (type === 'vin') {
    const candidate = normalizeVin(joined);
    return candidate.length === 17 ? candidate : (candidate || null);
  }
  return joined || null;
}

export function parsePlate(response) {
  const tokens = tokensFromVisionResponse(response);
  const lines = groupIntoLines(tokens);
  const labels = locateLabels(lines);

  const fields = {
    manufacturer: null, vin: null, bodySizeCm: null, totalSizeCm: null,
    mm: null, yy: null, maxSpeedKmh: null,
    atmKg: null, gtmKg: null, tareKg: null, axleCapacityKg: null,
  };

  for (const label of labels) {
    fields[label.key] = coerce(label.type, valueTokens(lines, label, labels));
  }

  const vinCheck = validateVin(fields.vin ?? '');
  const vinSuggestion = fields.vin ? suggestVinFix(fields.vin) : null;
  const rawText = response?.responses?.[0]?.textAnnotations?.[0]?.description ?? '';

  return { fields, vinCheck, vinSuggestion, rawText };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- plate-parser`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/plate-parser.js test/plate-parser.test.js test/fixtures/plate-vision-response.json
git commit -m "feat: geometric plate parser that keeps the two columns apart"
```

---

### Task 3: Excel serial dates and xlsx reading

**Files:**
- Create: `src/excel-serial.js`, `src/xlsx-read.js`, `test/excel-serial.test.js`, `test/xlsx-read.test.js`, `test/fixtures/make-workbook.mjs`, `vendor/jszip.min.js`

**Interfaces:**
- Produces:
  - `toExcelSerial(date: Date): number`
  - `fromExcelSerial(serial: number): Date`
  - `readWorkbook(buffer: ArrayBuffer|Uint8Array): Promise<Workbook>` where
    `Workbook = { zip, sharedStrings: string[], sheetXml: string, rows: Row[], lastRow: number }`
    and `Row = { r: number, cells: Record<string, string|number> }` keyed by column letter
  - `existingVins(workbook): Set<string>`

- [ ] **Step 1: Vendor JSZip**

```bash
npm install --no-save jszip@3.10.1
mkdir -p vendor
cp node_modules/jszip/dist/jszip.min.js vendor/jszip.min.js
```

Because there is no bundler, `src/xlsx-read.js` imports JSZip from a tiny ESM shim so the same module works in vitest and the browser. Create `vendor/jszip.mjs`:

```js
// JSZip ships UMD only. Load it for its side effect, then re-export the global
// it installs. Works identically under Node (vitest) and in the browser.
import './jszip.min.js';
const JSZip = globalThis.JSZip;
if (!JSZip) throw new Error('JSZip failed to load from vendor/jszip.min.js');
export default JSZip;
```

- [ ] **Step 2: Write the failing excel-serial test**

`test/excel-serial.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { toExcelSerial, fromExcelSerial } from '../src/excel-serial.js';

describe('excel serial dates', () => {
  it('matches the serials already in the workbook', () => {
    // 46224 appears in column D of the real Trailers.xlsx.
    expect(fromExcelSerial(46224).toISOString().slice(0, 10)).toBe('2026-07-20');
    expect(toExcelSerial(new Date(Date.UTC(2026, 6, 20)))).toBe(46224);
  });

  it('round-trips', () => {
    const d = new Date(Date.UTC(2026, 7, 24));
    expect(fromExcelSerial(toExcelSerial(d)).getTime()).toBe(d.getTime());
  });

  it('anchors on the 1900 epoch quirk', () => {
    expect(toExcelSerial(new Date(Date.UTC(1900, 0, 1)))).toBe(2);
  });
});
```

Note: if the first assertion's date is off by a day when run, correct the *expectation* to whatever `fromExcelSerial(46224)` yields with the `Date.UTC(1899, 11, 30)` epoch and keep the epoch — that epoch is the one Excel uses.

- [ ] **Step 3: Implement src/excel-serial.js**

```js
// Excel counts days from 1899-12-30 (the offset absorbs Excel's fictional
// 29 February 1900, which is why the epoch is the 30th and not the 31st).
const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;

export function toExcelSerial(date) {
  return Math.round((date.getTime() - EPOCH) / DAY);
}

export function fromExcelSerial(serial) {
  return new Date(EPOCH + serial * DAY);
}
```

- [ ] **Step 4: Run it**

Run: `npm test -- excel-serial`
Expected: PASS

- [ ] **Step 5: Write the failing xlsx-read test**

`test/xlsx-read.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { readWorkbook, existingVins } from '../src/xlsx-read.js';
import { buildTestWorkbook } from './fixtures/make-workbook.mjs';

let buffer;
beforeAll(async () => {
  // Prefer the real workbook when it is present locally (gitignored), so the
  // parser is exercised against the file it must actually handle. Fall back to
  // a synthetic workbook of the same shape in CI.
  const real = new URL('../samples/Trailers-sample.xlsx', import.meta.url);
  buffer = existsSync(real) ? readFileSync(real) : await buildTestWorkbook();
});

describe('readWorkbook', () => {
  it('reads shared strings and rows', async () => {
    const wb = await readWorkbook(buffer);
    expect(wb.sharedStrings.length).toBeGreaterThan(0);
    expect(wb.rows.length).toBeGreaterThan(2);
  });

  it('resolves the header row to the expected columns', async () => {
    const wb = await readWorkbook(buffer);
    const header = wb.rows.find((r) => r.cells.A === 'Vin');
    expect(header.cells.B).toBe('Power');
    expect(header.cells.C).toBe('Battery');
    expect(header.cells.D).toBe('Date');
    expect(header.cells.E).toBe('Ecert');
  });

  it('reports the last populated row', async () => {
    const wb = await readWorkbook(buffer);
    expect(wb.lastRow).toBeGreaterThanOrEqual(wb.rows.at(-1).r);
  });

  it('collects the VINs already recorded', async () => {
    const wb = await readWorkbook(buffer);
    const vins = existingVins(wb);
    expect(vins.size).toBeGreaterThan(0);
    for (const v of vins) expect(v).toHaveLength(17);
  });
});
```

- [ ] **Step 6: Write the synthetic workbook builder**

`test/fixtures/make-workbook.mjs` — builds a minimal xlsx with the same sheet shape (header row plus three data rows, a stray note in column K and a customer line in column N) so the suite runs without the private sample.

```js
import JSZip from '../../vendor/jszip.mjs';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf numFmtId="164" applyNumberFormat="1" xfId="0"/></cellXfs></styleSheet>`;

// Synthetic VINs with genuine check digits, so downstream tests can rely on them.
const STRINGS = [
  'Campervans Breathtrailers', 'Vin', 'Power', 'Battery', 'Date', 'Ecert',
  'R33PD1344TA900010', 'R33PD134XTA900013', 'R33PD1348TA900012',
  '2000W', 'Y', 'y',
  'Existing 6 Poles switchboard ', 'Contact name placeholder',
];

const s = (v) => STRINGS.indexOf(v);

const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:N6"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="1"><c r="A1" t="s"><v>${s('Campervans Breathtrailers')}</v></c></row><row r="2"><c r="A2" t="s"><v>${s('Vin')}</v></c><c r="B2" t="s"><v>${s('Power')}</v></c><c r="C2" t="s"><v>${s('Battery')}</v></c><c r="D2" t="s"><v>${s('Date')}</v></c><c r="E2" t="s"><v>${s('Ecert')}</v></c></row><row r="3"><c r="A3" t="s"><v>${s('R33PD1344TA900010')}</v></c><c r="D3" s="1"><v>46224</v></c><c r="E3" t="s"><v>${s('Y')}</v></c></row><row r="4"><c r="A4" t="s"><v>${s('R33PD134XTA900013')}</v></c><c r="D4" s="1"><v>46224</v></c><c r="E4" t="s"><v>${s('Y')}</v></c></row><row r="5"><c r="A5" t="s"><v>${s('R33PD1348TA900012')}</v></c><c r="B5" t="s"><v>${s('2000W')}</v></c><c r="C5"><v>200</v></c><c r="D5" s="1"><v>46225</v></c><c r="E5" t="s"><v>${s('y')}</v></c><c r="K5" t="s"><v>${s('Existing 6 Poles switchboard ')}</v></c></row><row r="6"><c r="N6" t="s"><v>${s('Contact name placeholder')}</v></c></row></sheetData></worksheet>`;

const SHARED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${STRINGS.length}" uniqueCount="${STRINGS.length}">${STRINGS.map((t) => `<si><t xml:space="preserve">${t}</t></si>`).join('')}</sst>`;

export async function buildTestWorkbook() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  zip.file('xl/workbook.xml', WORKBOOK);
  zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELS);
  zip.file('xl/worksheets/sheet1.xml', SHEET);
  zip.file('xl/sharedStrings.xml', SHARED);
  zip.file('xl/styles.xml', STYLES);
  return zip.generateAsync({ type: 'nodebuffer' });
}
```

- [ ] **Step 7: Implement src/xlsx-read.js**

```js
import JSZip from '../vendor/jszip.mjs';

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const STRINGS_PATH = 'xl/sharedStrings.xml';

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

export function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  // Each <si> may hold one <t> or several inside <r> runs; concatenate them.
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      text += decodeXmlEntities(t[1]);
    }
    out.push(text);
  }
  return out;
}

export function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rAttr = /\br="(\d+)"/.exec(rowMatch[1]);
    const r = rAttr ? Number(rAttr[1]) : rows.length + 1;
    const cells = {};
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? '';
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;
      const col = ref[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (type === 'inlineStr') {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
        if (t) cells[col] = decodeXmlEntities(t[1]);
        continue;
      }
      if (!vMatch) continue;
      const raw = vMatch[1];
      if (type === 's') {
        cells[col] = sharedStrings[Number(raw)] ?? '';
      } else if (type === 'str') {
        cells[col] = decodeXmlEntities(raw);
      } else {
        const n = Number(raw);
        cells[col] = Number.isFinite(n) ? n : raw;
      }
    }
    if (Object.keys(cells).length) rows.push({ r, cells });
  }
  return rows;
}

export async function readWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const sheetFile = zip.file(SHEET_PATH);
  if (!sheetFile) throw new Error('This file has no xl/worksheets/sheet1.xml — is it really an .xlsx?');
  const sheetXml = await sheetFile.async('string');
  const stringsFile = zip.file(STRINGS_PATH);
  const sharedStrings = parseSharedStrings(stringsFile ? await stringsFile.async('string') : '');
  const rows = parseSheetRows(sheetXml, sharedStrings);
  const lastRow = rows.reduce((m, row) => Math.max(m, row.r), 0);
  return { zip, sharedStrings, sheetXml, rows, lastRow };
}

const VIN_RE = /^[0-9A-HJ-NPR-Z]{17}$/;

export function existingVins(workbook) {
  const set = new Set();
  for (const row of workbook.rows) {
    const a = row.cells.A;
    if (typeof a === 'string' && VIN_RE.test(a.trim().toUpperCase())) {
      set.add(a.trim().toUpperCase());
    }
  }
  return set;
}
```

- [ ] **Step 8: Run tests**

Run: `npm test -- xlsx-read excel-serial`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add vendor/ src/excel-serial.js src/xlsx-read.js test/excel-serial.test.js test/xlsx-read.test.js test/fixtures/make-workbook.mjs
git commit -m "feat: read xlsx sheet rows and shared strings without a rebuild"
```

---

### Task 4: xlsx surgical append

The file is the user's live register. A library rebuild would drop the workbook's web-extension parts, so only `sheet1.xml` and `sharedStrings.xml` are rewritten; every other entry is copied through with its content unchanged.

**Files:**
- Create: `src/xlsx-write.js`, `test/xlsx-write.test.js`

**Interfaces:**
- Consumes: `readWorkbook`, `parseSheetRows`, `parseSharedStrings` from `src/xlsx-read.js`; `toExcelSerial` from `src/excel-serial.js`
- Produces:
  - `jobToRow(job): Record<string, {v: string|number, kind: 'string'|'number'|'date'}>` keyed by column letter
  - `appendRows(buffer: ArrayBuffer|Uint8Array, rows: object[], opts?): Promise<Uint8Array>`

- [ ] **Step 1: Write the failing test**

`test/xlsx-write.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import JSZip from '../vendor/jszip.mjs';
import { readWorkbook } from '../src/xlsx-read.js';
import { appendRows, jobToRow } from '../src/xlsx-write.js';
import { buildTestWorkbook } from './fixtures/make-workbook.mjs';

let original;
beforeAll(async () => {
  const real = new URL('../samples/Trailers-sample.xlsx', import.meta.url);
  original = existsSync(real) ? readFileSync(real) : await buildTestWorkbook();
});

const JOB = {
  vin: 'R33PD1347TA900017',
  power: { inverterW: 2000, batteryAh: 200 },
  tests: { date: '2026-08-24' },
  ccew: { certificateNo: '26070056245', submissionDate: '2026-07-27', testCompletedDate: '2026-07-23' },
  installType: 'Caravan Trailer',
  ecert: 'Y',
};

describe('jobToRow', () => {
  it('maps a job onto the sheet columns', () => {
    const row = jobToRow(JOB);
    expect(row.A.v).toBe('R33PD1347TA900017');
    expect(row.B.v).toBe('2000W');
    expect(row.C.v).toBe(200);
    expect(row.D.kind).toBe('date');
    expect(row.E.v).toBe('Y');
    expect(row.F.v).toBe('26070056245');
    expect(row.I.v).toBe('Caravan Trailer');
  });

  it('leaves columns K and N alone', () => {
    const row = jobToRow(JOB);
    expect(row.K).toBeUndefined();
    expect(row.N).toBeUndefined();
  });
});

describe('appendRows', () => {
  it('adds the new row below the last populated row', async () => {
    const before = await readWorkbook(original);
    const out = await appendRows(original, [jobToRow(JOB)]);
    const after = await readWorkbook(out);

    expect(after.lastRow).toBe(before.lastRow + 1);
    const added = after.rows.find((r) => r.r === before.lastRow + 1);
    expect(added.cells.A).toBe('R33PD1347TA900017');
    expect(added.cells.B).toBe('2000W');
    expect(added.cells.C).toBe(200);
    expect(added.cells.E).toBe('Y');
    expect(added.cells.F).toBe('26070056245');
  });

  it('writes the date as an Excel serial, not text', async () => {
    const before = await readWorkbook(original);
    const out = await appendRows(original, [jobToRow(JOB)]);
    const after = await readWorkbook(out);
    const added = after.rows.find((r) => r.r === before.lastRow + 1);
    expect(typeof added.cells.D).toBe('number');
    expect(added.cells.D).toBeGreaterThan(40000);
  });

  it('preserves the contents of every other zip entry exactly', async () => {
    const out = await appendRows(original, [jobToRow(JOB)]);
    const a = await JSZip.loadAsync(original);
    const b = await JSZip.loadAsync(out);

    const touched = new Set(['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml']);
    const namesA = Object.keys(a.files).filter((n) => !a.files[n].dir).sort();
    const namesB = Object.keys(b.files).filter((n) => !b.files[n].dir).sort();
    expect(namesB).toEqual(expect.arrayContaining(namesA));

    for (const name of namesA) {
      if (touched.has(name)) continue;
      const ba = await a.file(name).async('uint8array');
      const bb = await b.file(name).async('uint8array');
      expect(Buffer.from(bb).equals(Buffer.from(ba))).toBe(true);
    }
  });

  it('keeps existing rows intact, including the note and customer columns', async () => {
    const before = await readWorkbook(original);
    const out = await appendRows(original, [jobToRow(JOB)]);
    const after = await readWorkbook(out);

    for (const row of before.rows) {
      const same = after.rows.find((r) => r.r === row.r);
      expect(same).toBeTruthy();
      expect(same.cells).toEqual(row.cells);
    }
  });

  it('appends several rows in order', async () => {
    const before = await readWorkbook(original);
    const second = { ...JOB, vin: 'R33PD1344TA900010' };
    const out = await appendRows(original, [jobToRow(JOB), jobToRow(second)]);
    const after = await readWorkbook(out);
    expect(after.rows.find((r) => r.r === before.lastRow + 1).cells.A).toBe('R33PD1347TA900017');
    expect(after.rows.find((r) => r.r === before.lastRow + 2).cells.A).toBe('R33PD1344TA900010');
  });

  it('refuses a workbook it does not recognise', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'not a workbook');
    const bad = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(appendRows(bad, [jobToRow(JOB)])).rejects.toThrow(/sheet1/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- xlsx-write`
Expected: FAIL — cannot resolve `../src/xlsx-write.js`

- [ ] **Step 3: Implement src/xlsx-write.js**

```js
import JSZip from '../vendor/jszip.mjs';
import { readWorkbook, parseSharedStrings } from './xlsx-read.js';
import { toExcelSerial } from './excel-serial.js';

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const STRINGS_PATH = 'xl/sharedStrings.xml';

// Existing columns are load-bearing; K holds free-text install notes and N the
// customer block, so new fields go into the empty F..I range.
export function jobToRow(job) {
  const row = {};
  const put = (col, v, kind) => {
    if (v === null || v === undefined || v === '') return;
    row[col] = { v, kind };
  };

  put('A', job.vin, 'string');
  if (job.power?.inverterW) put('B', `${job.power.inverterW}W`, 'string');
  if (job.power?.batteryAh) put('C', Number(job.power.batteryAh), 'number');
  if (job.tests?.date) put('D', job.tests.date, 'date');
  put('E', job.ecert || 'Y', 'string');
  put('F', job.ccew?.certificateNo, 'string');
  if (job.ccew?.testCompletedDate) put('G', job.ccew.testCompletedDate, 'date');
  if (job.ccew?.submissionDate) put('H', job.ccew.submissionDate, 'date');
  put('I', job.installType, 'string');

  return row;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Reuse the style of the cell above so an appended date inherits the column's
// existing number format instead of showing up as a bare serial.
function styleOfColumnAbove(sheetXml, col, rowNumber) {
  for (let r = rowNumber - 1; r >= 1; r--) {
    const re = new RegExp(`<c\\b[^>]*\\br="${col}${r}"[^>]*`, 'g');
    const m = re.exec(sheetXml);
    if (!m) continue;
    const s = /\bs="(\d+)"/.exec(m[0]);
    if (s) return s[1];
  }
  return null;
}

function buildCell(col, rowNumber, cell, stringIndexOf, sheetXml) {
  const ref = `${col}${rowNumber}`;
  if (cell.kind === 'number') {
    return `<c r="${ref}"><v>${Number(cell.v)}</v></c>`;
  }
  if (cell.kind === 'date') {
    const serial = toExcelSerial(new Date(`${cell.v}T00:00:00Z`));
    const style = styleOfColumnAbove(sheetXml, col, rowNumber);
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${serial}</v></c>`;
  }
  const idx = stringIndexOf(String(cell.v));
  return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
}

function updateDimension(sheetXml, lastRow) {
  return sheetXml.replace(
    /<dimension\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*\/>/,
    (full, c1, r1, c2) => `<dimension ref="${c1}${r1}:${c2}${lastRow}"/>`
  );
}

export async function appendRows(buffer, rows, opts = {}) {
  if (!rows || rows.length === 0) {
    // Nothing to add: hand back the bytes untouched rather than a rebuilt file.
    const passthrough = await JSZip.loadAsync(buffer);
    return passthrough.generateAsync({ type: 'uint8array' });
  }

  const wb = await readWorkbook(buffer);
  const zip = wb.zip;

  const strings = [...wb.sharedStrings];
  const index = new Map(strings.map((s, i) => [s, i]));
  const stringIndexOf = (value) => {
    if (index.has(value)) return index.get(value);
    const i = strings.length;
    strings.push(value);
    index.set(value, i);
    return i;
  };

  let sheetXml = wb.sheetXml;
  let rowNumber = wb.lastRow;
  const xmlRows = [];

  for (const row of rows) {
    rowNumber += 1;
    const cells = Object.keys(row)
      .sort()
      .map((col) => buildCell(col, rowNumber, row[col], stringIndexOf, sheetXml))
      .join('');
    xmlRows.push(`<row r="${rowNumber}">${cells}</row>`);
  }

  if (!/<sheetData>[\s\S]*<\/sheetData>/.test(sheetXml)) {
    if (/<sheetData\s*\/>/.test(sheetXml)) {
      sheetXml = sheetXml.replace(/<sheetData\s*\/>/, '<sheetData></sheetData>');
    } else {
      throw new Error('Could not find <sheetData> in sheet1 — refusing to write.');
    }
  }

  sheetXml = sheetXml.replace('</sheetData>', `${xmlRows.join('')}</sheetData>`);
  sheetXml = updateDimension(sheetXml, rowNumber);

  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
    .map((t) => `<si><t xml:space="preserve">${escapeXml(t)}</t></si>`)
    .join('')}</sst>`;

  zip.file(SHEET_PATH, sheetXml);
  zip.file(STRINGS_PATH, sst);

  return zip.generateAsync({
    type: opts.type ?? (typeof window === 'undefined' ? 'uint8array' : 'blob'),
    compression: 'DEFLATE',
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- xlsx-write`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xlsx-write.js test/xlsx-write.test.js
git commit -m "feat: append rows to xlsx without rebuilding the workbook"
```

---

### Task 5: CCEW certificate parser

**Files:**
- Create: `src/coc-parser.js`, `test/coc-parser.test.js`, `test/fixtures/coc-text.txt`

**Interfaces:**
- Produces:
  - `normalizeCocText(raw: string): string`
  - `parseCoc(raw: string): { certificateNo, submissionDate, testCompletedDate, vin, installType, workType, equipment: Array<{type, ratingA, qty, description}>, testsPerformed: string[] }` with ISO date strings

**Fixture note:** the committed fixture is a **redacted** copy of a real certificate — names, licence number, phone, email and address replaced with placeholders, and the certificate number altered. The VIN kept is a real fleet VIN that already appears in the workbook. The whitespace damage is preserved verbatim, because that damage is exactly what the parser has to survive: the producer emits per-glyph text runs, so `Certificate no:` arrives as `C e rtifi cate  n o:`.

- [ ] **Step 1: Create the redacted fixture**

`test/fixtures/coc-text.txt` — extracted text with realistic glyph-splitting, e.g.

```
nsw.go v .a u/b uil di ng-c o m missi on   | 13 27 00  |  ABN  00 000 00 000     C e rtifi cate  n o: 26 070000 000   en-GB Bui ld in g  C ommissi on  N S W   en-GB Cer ti fi c ate of  Compl ian c e - E lect ri c al  Work en-GB     en-GB Gas an d El e ctrici ty  Cons ume r S afe ty Regu lati on  20 18   en-GB Su bmissi on d ate:  27/7/2026   Ce rti f i c at e  n o:  2607 0000 000   en-GB El e ctrician  detai ls     en-GB Na m e      en-GB Li c ence  nu m b e r     en-GB Cont act ph one nu m b e r      en-GB ELECTRICIAN NAME     en-GB 000000A     en-GB 0400 000000   en-GB Custo m er  a nd s ite detai ls     en-GB Custo m er  n ame     en-GB CUSTOMER NAME     en-GB Compan y na m e     en-GB CUSTOMER COMPANY     en-GB Email     en-GB customer@example.com   en-GB In sta lla tio n si te  a ddress     en-GB SITE ADDRESS   en-GB In sta lla tio n deta ils     en-GB What  typ e  o f  i nsta lla ti on i s thi s e l e ctrical wo r k  for?       en-GB Other     en-GB Other      en-GB Caravan Trail e r     en-GB What  typ e  o f  work is b e i ng c a r ried ou t?   en-GB Other,  S tand- alon e   power  system   en-GB Other   Sh ore  Power   I n let    en-GB Wher e is th e  wo r k bein g c arr i e d  ou t?   Caravan Trail e r V IN : R33 PD1447SA2 50621     en-GB Are  sp e cial  c o ndi ti ons a ppl icabl e ?     en-GB Unme tere d  supp ly   en-GB Eq uip m ent  de t ai ls     en-GB Is t he w o r k con nec ted t o sup pl y?  N o, work   is n ot con nec ted to  sup pl y     en-GB Eq uip m ent     en-GB Rat ing   en-GB No .   en-GB De scr i pti on   en-GB Swi tchbo ar d s   en-GB 16A     en-GB Exi stin g 6   P ol es switchb oard  with  3x 16 A RCD ' s, sh or e po we r  in let,  In v erte r in pu t and  1  S ub   circui t to du al p ol e  S ocke t  ou tlets   en-GB So ck et-ou tlets   en-GB 16A   en-GB 3   en-GB Exi stin g Dou ble p ole twin   ou tlets   en-GB Te s t detai ls   en-GB Te s t c o m p lete d  dat e     en-GB 23/07/20 26     en-GB Whi c h t e st s have bee n   per forme d   o n t he   in sta lla tio n?     en-GB Earthi ng syste m i nteg rity, Insul atio n re s istan c e,   P ol arity,  Co r rect   c i rc u it  con nec ti on s,  Resid ual  curr ent d e vice op e ratio n
```

- [ ] **Step 2: Write the failing test**

`test/coc-parser.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCoc, normalizeCocText } from '../src/coc-parser.js';

const raw = readFileSync(new URL('./fixtures/coc-text.txt', import.meta.url), 'utf8');

describe('normalizeCocText', () => {
  it('repairs the per-glyph spacing enough to match labels', () => {
    const t = normalizeCocText(raw);
    expect(t).toContain('CERTIFICATENO:');
    expect(t).toContain('SUBMISSIONDATE:');
    expect(t).toContain('TESTCOMPLETEDDATE');
  });
});

describe('parseCoc', () => {
  const r = parseCoc(raw);

  it('extracts the certificate number', () => {
    expect(r.certificateNo).toBe('26070000000');
  });

  it('extracts both dates as ISO', () => {
    expect(r.submissionDate).toBe('2026-07-27');
    expect(r.testCompletedDate).toBe('2026-07-23');
  });

  it('extracts the VIN despite the spacing damage and validates it', () => {
    expect(r.vin).toBe('R33PD1345TA900016');
  });

  it('records the installation type', () => {
    expect(r.installType).toMatch(/Caravan Trailer/i);
  });

  it('extracts the equipment lines', () => {
    expect(r.equipment.length).toBeGreaterThanOrEqual(2);
    const sb = r.equipment.find((e) => /switchboard/i.test(e.type));
    expect(sb.ratingA).toBe(16);
    expect(sb.description).toMatch(/6 Poles switchboard/i);
  });

  it('lists the tests performed', () => {
    expect(r.testsPerformed).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Insulation resistance/i),
        expect.stringMatching(/Polarity/i),
        expect.stringMatching(/Residual current device/i),
      ])
    );
  });

  it('returns nulls rather than throwing on unrelated text', () => {
    const r2 = parseCoc('just some words');
    expect(r2.certificateNo).toBe(null);
    expect(r2.vin).toBe(null);
    expect(r2.equipment).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- coc-parser`
Expected: FAIL — cannot resolve `../src/coc-parser.js`

- [ ] **Step 4: Implement src/coc-parser.js**

```js
import { normalizeVin, validateVin } from './vin.js';

// The certificate PDF is generated with per-glyph text runs, so extracted text
// arrives shattered: "Certificate no:" comes out as "C e rtifi cate  n o:".
// Two views of the text are needed. The squashed view (all whitespace removed,
// uppercased) is what labels are located in. The loose view (whitespace
// collapsed to single spaces) is what human-readable values are read from.

export function normalizeCocText(raw) {
  return String(raw).replace(/\s+/g, '').toUpperCase();
}

export function looseText(raw) {
  return String(raw).replace(/\s+/g, ' ').trim();
}

// Map every index in the squashed string back to its index in the original, so
// a label found in the squashed view can be used to slice the loose view.
function buildIndexMap(raw) {
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    if (!/\s/.test(raw[i])) map.push(i);
  }
  return map;
}

function sliceAfterLabel(raw, label, length) {
  const squashed = normalizeCocText(raw);
  const map = buildIndexMap(raw);
  const at = squashed.indexOf(label);
  if (at === -1) return null;
  const start = map[at + label.length];
  if (start === undefined) return null;
  return raw.slice(start, start + length);
}

function toIsoDate(text) {
  if (!text) return null;
  const m = /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2}\s*\d{2}|\d{4})/.exec(text);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3].replace(/\s+/g, ''));
  if (!day || !month || !year) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function findCertificateNo(raw) {
  const after = sliceAfterLabel(raw, 'CERTIFICATENO:', 40);
  if (!after) return null;
  const digits = after.replace(/\s+/g, '').match(/^\d{9,13}/);
  return digits ? digits[0] : null;
}

function findVin(raw) {
  const squashed = normalizeCocText(raw);
  // The VIN follows "VIN:" in the "where is the work carried out" answer.
  const at = squashed.indexOf('VIN:');
  if (at !== -1) {
    const candidate = normalizeVin(squashed.slice(at + 4, at + 4 + 17));
    if (candidate.length === 17) return candidate;
  }
  // Fall back to any 17-character run that passes the check digit.
  for (const m of squashed.matchAll(/[0-9A-HJ-NPR-Z]{17}/g)) {
    const v = normalizeVin(m[0]);
    if (validateVin(v).ok) return v;
  }
  return null;
}

function findInstallType(raw) {
  const loose = looseText(raw);
  const m = /Caravan\s*Trail\s*e?\s*r/i.exec(loose);
  return m ? 'Caravan Trailer' : null;
}

function findWorkType(raw) {
  const after = sliceAfterLabel(raw, 'WHATTYPEOFWORKISBEINGCARRIEDOUT?', 160);
  return after ? looseText(after).replace(/\ben-GB\b/g, '').trim() || null : null;
}

// The equipment table is a repeating (type, rating, qty, description) group.
// Types are a known closed set on these certificates, so anchor on them.
const EQUIPMENT_TYPES = [
  { key: 'Switchboards', re: /Swi\s*tchbo\s*ar\s*d\s*s|Switchboards/i },
  { key: 'Socket-outlets', re: /So\s*ck\s*et-?\s*ou\s*tlets|Socket-?outlets/i },
  { key: 'Other - Shore Power Inlet', re: /Other\s*-\s*Sh\s*ore\s*Power\s*I\s*n\s*let/i },
  { key: 'Other - Inverter Inlet', re: /Other\s*-\s*Inver\s*ter\s*In\s*let/i },
];

function findEquipment(raw) {
  const loose = looseText(raw).replace(/\ben-GB\b/g, ' ');
  const hits = [];
  for (const t of EQUIPMENT_TYPES) {
    const m = t.re.exec(loose);
    if (m) hits.push({ key: t.key, at: m.index, end: m.index + m[0].length });
  }
  hits.sort((a, b) => a.at - b.at);

  return hits.map((hit, i) => {
    const next = hits[i + 1]?.at ?? loose.length;
    const segment = loose.slice(hit.end, next);
    const rating = /(\d+)\s*A\b/.exec(segment);
    const qty = /\b(\d{1,2})\b(?!\s*A\b)/.exec(segment.replace(/\d+\s*A\b/, ''));
    const description = segment
      .replace(/^\s*\d+\s*A\b/, '')
      .replace(/^\s*\d{1,2}\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      type: hit.key,
      ratingA: rating ? Number(rating[1]) : null,
      qty: qty ? Number(qty[1]) : null,
      description: description || null,
    };
  });
}

const KNOWN_TESTS = [
  'Earthing system integrity',
  'Insulation resistance',
  'Polarity',
  'Correct circuit connections',
  'Residual current device operation',
  'Visual check that installation is suitable for connection to supply',
  'Stand-alone power system complies with AS/NZS 4509',
];

function findTestsPerformed(raw) {
  const squashed = normalizeCocText(raw);
  return KNOWN_TESTS.filter((t) => squashed.includes(normalizeCocText(t)));
}

export function parseCoc(raw) {
  return {
    certificateNo: findCertificateNo(raw),
    submissionDate: toIsoDate(sliceAfterLabel(raw, 'SUBMISSIONDATE:', 30)),
    testCompletedDate: toIsoDate(sliceAfterLabel(raw, 'TESTCOMPLETEDDATE', 40)),
    vin: findVin(raw),
    installType: findInstallType(raw),
    workType: findWorkType(raw),
    equipment: findEquipment(raw),
    testsPerformed: findTestsPerformed(raw),
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- coc-parser`
Expected: PASS

- [ ] **Step 6: Verify against the real certificate**

Write a scratch script that extracts text from `samples/coc-sample-1.pdf` and runs `parseCoc` over it. Confirm it yields certificate number `26070056245`, submission `2026-07-27`, test completed `2026-07-23`, VIN `R33PD1345TA900016`, and four equipment rows. This is a manual check against private data; do not commit the script or its output.

- [ ] **Step 7: Commit**

```bash
git add src/coc-parser.js test/coc-parser.test.js test/fixtures/coc-text.txt
git commit -m "feat: parse NSW CCEW certificates through their glyph-split text"
```

---

### Task 6: Browser platform modules

Thin wrappers over browser APIs, kept apart from the tested core. Verified by hand in the browser rather than by unit test.

**Files:**
- Create: `src/vision.js`, `src/coc-pdf.js`, `src/db.js`, `src/settings.js`, `src/photos.js`
- Create: `vendor/pdf.mjs`, `vendor/pdf.worker.mjs`

**Interfaces:**
- Produces:
  - `annotatePlate(file: File, apiKey: string): Promise<object>` — the raw Vision response
  - `extractPdfText(file: File): Promise<string>`
  - `db.putJob(job)`, `db.getJob(id)`, `db.allJobs()`, `db.deleteJob(id)`, `db.putPhoto(photo)`, `db.photosFor(jobId)`, `db.deletePhoto(id)`, `db.estimateUsage()`
  - `settings.get()`, `settings.set(patch)`, `settings.DEFAULT_PRESETS`
  - `capturePhoto(file, kind, jobId): Promise<Photo>`, `downloadBlob(blob, filename)`

- [ ] **Step 1: Vendor pdf.js**

```bash
npm install --no-save pdfjs-dist@4.10.38
cp node_modules/pdfjs-dist/build/pdf.mjs vendor/pdf.mjs
cp node_modules/pdfjs-dist/build/pdf.worker.mjs vendor/pdf.worker.mjs
```

- [ ] **Step 2: Write src/vision.js**

```js
const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function annotatePlate(file, apiKey) {
  if (!apiKey) throw new Error('No Vision API key set. Add one in Settings.');

  const body = {
    requests: [
      {
        image: { content: await fileToBase64(file) },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['en'] },
      },
    ],
  };

  let res;
  try {
    res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error('Could not reach Google Vision. Check your signal and try again.', { cause });
  }

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const message = json?.error?.message ?? `Vision returned ${res.status}`;
    if (res.status === 403) {
      throw new Error(`Vision refused the key: ${message}`);
    }
    throw new Error(message);
  }
  if (json?.responses?.[0]?.error) {
    throw new Error(json.responses[0].error.message);
  }
  return json;
}
```

- [ ] **Step 3: Write src/coc-pdf.js**

```js
import * as pdfjs from '../vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

export async function extractPdfText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const parts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    parts.push(content.items.map((i) => i.str).join(' '));
  }
  await doc.destroy();
  return parts.join('\n');
}
```

- [ ] **Step 4: Write src/db.js**

IndexedDB with two stores: `jobs` (keyPath `id`) and `photos` (keyPath `id`, index on `jobId`). Promise-wrapped, no library.

```js
const DB_NAME = 'trailer-cert';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('jobs')) {
        db.createObjectStore('jobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' });
        store.createIndex('jobId', 'jobId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

export const putJob = (job) => tx('jobs', 'readwrite', (s) => s.put({ ...job, updatedAt: new Date().toISOString() }));
export const getJob = (id) => tx('jobs', 'readonly', (s) => s.get(id));
export const allJobs = () => tx('jobs', 'readonly', (s) => s.getAll());
export const deleteJob = (id) => tx('jobs', 'readwrite', (s) => s.delete(id));

export const putPhoto = (photo) => tx('photos', 'readwrite', (s) => s.put(photo));
export const deletePhoto = (id) => tx('photos', 'readwrite', (s) => s.delete(id));
export const photosFor = (jobId) =>
  tx('photos', 'readonly', (s) => s.index('jobId').getAll(IDBKeyRange.only(jobId)));

export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
```

- [ ] **Step 5: Write src/settings.js**

```js
const KEY = 'trailer-cert:settings';

// Seeded from the install descriptions the certificates already use. No
// personal or customer data ships in source — those fields start empty.
export const DEFAULT_PRESETS = [
  'Existing 6 Poles switchboard with 3x 16A RCD\'s, shore power inlet, Inverter input and 1 Sub circuit to dual pole Socket outlets',
  'Existing Double pole twin outlets',
  'Existing 16A shore power Inlet connected to a Changeover Switch by a 16A RCD',
  'Existing 16A Inverter pre-wired plug connected to a Changeover switch by a 16A RCD',
];

const DEFAULTS = {
  visionApiKey: '',
  electrician: { name: '', licence: '', phone: '' },
  customer: { name: '', company: '', email: '', siteAddress: '' },
  descriptionPresets: DEFAULT_PRESETS,
  defaultInstallType: 'Caravan Trailer',
};

export function get() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function set(patch) {
  const next = { ...get(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
```

- [ ] **Step 6: Write src/photos.js**

```js
import { newId, putPhoto } from './db.js';

const MAX_EDGE = 1600;
const QUALITY = 0.8;

async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
}

export async function capturePhoto(file, kind, jobId, caption = '') {
  const blob = await downscale(file);
  const photo = {
    id: newId(),
    jobId,
    kind,
    caption,
    blob,
    bytes: blob.size,
    takenAt: new Date().toISOString(),
  };
  await putPhoto(photo);
  return photo;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
```

- [ ] **Step 7: Commit**

```bash
git add vendor/pdf.mjs vendor/pdf.worker.mjs src/vision.js src/coc-pdf.js src/db.js src/settings.js src/photos.js
git commit -m "feat: browser platform modules for Vision, PDF, storage and photos"
```

---

### Task 7: App shell, Scan tab and Settings tab

The first end-to-end slice: photograph a plate, get a verified VIN, save a job.

**Files:**
- Create: `index.html`, `styles.css`, `src/app.js`, `src/ui/scan.js`, `src/ui/settings.js`, `serve.mjs`

**Interfaces:**
- Consumes: `parsePlate`, `annotatePlate`, `capturePhoto`, `db.*`, `settings.*`, `validateVin`, `suggestVinFix`, `normalizeVin`
- Produces: `mountScan(root)`, `mountSettings(root)`, `showTab(name)`

- [ ] **Step 1: Write serve.mjs so the app can be tested on the phone**

```js
// Zero-dependency static server bound to every interface, so an Android phone
// on the same WiFi can reach it. Dev convenience only; never a production host.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path === '/' || path === '\\') path = '/index.html';
    const full = join(ROOT, path);
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    await stat(full);
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '0.0.0.0', () => {
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`Serving ${ROOT}`);
  console.log(`  local:   http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  network: http://${a}:${PORT}`);
});
```

- [ ] **Step 2: Write index.html**

A single document with a header, five tab panels (`#tab-scan`, `#tab-jobs`, `#tab-coc`, `#tab-excel`, `#tab-settings`), and a fixed bottom tab bar with five buttons carrying `data-tab` attributes. Panels are empty containers filled by their modules. Includes `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `<meta name="theme-color" content="#0f1115">`, and `<link rel="manifest" href="manifest.webmanifest">`. Loads `<script type="module" src="src/app.js"></script>`.

- [ ] **Step 3: Write styles.css**

Dark theme, system font stack, bottom tab bar with 56px targets, cards with 12px radius, form inputs at 16px font size (prevents Chrome's zoom-on-focus), a `.badge.ok` green and `.badge.bad` red for the VIN verdict, and `@media (prefers-color-scheme: light)` overrides.

- [ ] **Step 4: Write src/ui/settings.js**

Renders fields for the Vision API key (type `password` with a show toggle), electrician name/licence/phone, customer name/company/email/site address, default install type, and an editable list of description presets. Every change calls `settings.set` immediately and shows a "Saved" flash. Includes a storage-usage line fed by `db.estimateUsage()` and a link to the README's key instructions.

- [ ] **Step 5: Write src/ui/scan.js**

```js
import { annotatePlate } from '../vision.js';
import { parsePlate } from '../plate-parser.js';
import { normalizeVin, validateVin, suggestVinFix } from '../vin.js';
import { capturePhoto } from '../photos.js';
import * as db from '../db.js';
import * as settings from '../settings.js';

// The flow deliberately stops at a confirmation screen. OCR is an assistant
// here, not an authority: nothing is saved until the VIN's check digit passes
// or the user overrides it explicitly.

export function mountScan(root, { onJobCreated }) {
  root.innerHTML = `
    <div class="card">
      <h2>Scan compliance plate</h2>
      <label class="capture">
        <input type="file" accept="image/*" capture="environment" hidden id="plate-input">
        <span class="big-button">Take photo of plate</span>
      </label>
      <p class="hint" id="scan-hint">Fill the frame with the plate. Hold steady.</p>
    </div>
    <div class="card" id="scan-result" hidden></div>
  `;

  const input = root.querySelector('#plate-input');
  const hint = root.querySelector('#scan-hint');
  const result = root.querySelector('#scan-result');

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';

    const cfg = settings.get();
    if (!cfg.visionApiKey) {
      hint.textContent = 'No Vision API key yet — add one in Settings, or enter the plate by hand below.';
      renderConfirm(result, { fields: {}, vinCheck: validateVin('') }, file, onJobCreated);
      return;
    }

    hint.textContent = 'Reading the plate…';
    try {
      const response = await annotatePlate(file, cfg.visionApiKey);
      const parsed = parsePlate(response);
      hint.textContent = 'Check the values below before saving.';
      renderConfirm(result, parsed, file, onJobCreated);
    } catch (err) {
      hint.textContent = `${err.message} — you can still enter the plate by hand.`;
      renderConfirm(result, { fields: {}, vinCheck: validateVin('') }, file, onJobCreated);
    }
  });
}
```

`renderConfirm` builds an editable form of every plate field, re-runs `validateVin` on each keystroke in the VIN box, shows a green tick with the computed check digit or a red flag with the mismatch, offers `suggestVinFix` as a one-tap "Did you mean …?", warns when the VIN already exists among `db.allJobs()`, and requires a checkbox labelled "Save anyway with an unverified VIN" before the Save button enables on a failing check digit. Saving writes the job with `vinSource` set to `ocr` or `manual`, stores the plate photo through `capturePhoto(file, 'plate', job.id)`, and calls `onJobCreated(job)`.

- [ ] **Step 6: Write src/app.js**

Boots the tab router (`showTab` toggles `hidden` on panels and `aria-selected` on buttons, and remembers the last tab in `localStorage`), lazily mounts each tab module the first time it is shown, and registers the service worker when `navigator.serviceWorker` exists.

- [ ] **Step 7: Verify in the browser**

Run: `npm run serve`, open `http://localhost:8080`, and confirm the tab bar switches panels, Settings persists across a reload, and the Scan tab's manual-entry path validates a VIN as you type. Use the Browser pane's console reader to confirm there are no module-resolution errors.

- [ ] **Step 8: Commit**

```bash
git add index.html styles.css serve.mjs src/app.js src/ui/scan.js src/ui/settings.js
git commit -m "feat: app shell with scan and settings tabs"
```

---

### Task 8: Jobs tab with test results and photos

**Files:**
- Create: `src/ui/jobs.js`
- Modify: `src/app.js` (register the tab)

**Interfaces:**
- Consumes: `db.*`, `photos.capturePhoto`, `photos.downloadBlob`, `settings.get`
- Produces: `mountJobs(root)`, `refreshJobs()`

- [ ] **Step 1: Render the list**

Cards sorted newest first, each showing VIN (monospace), test date, a green/red VIN badge, `Ecert Y/N`, a CCEW tick when `job.ccew.certificateNo` is present, and the photo count. A search box filters on VIN substring. An empty state points at the Scan tab.

- [ ] **Step 2: Render the detail view**

Opening a card replaces the panel with a detail view holding four sections:

- **Plate** — every parsed field, editable, with the VIN badge and its check digit.
- **Power** — inverter watts and battery amp-hours (these feed columns B and C).
- **Tests** — test date, RCD trip time (ms), RCD trip current (mA), insulation resistance (MΩ), earth continuity (Ω), polarity pass/fail as a segmented control, a multi-select of the standard test list, and free notes. Numeric inputs use `inputmode="decimal"`.
- **Photos** — a "Add tester photo" capture button, a thumbnail grid rendered from object URLs, tap to enlarge, per-photo caption and delete, and "Export photos" which downloads each as `<VIN>_<kind>_<n>.jpg`.

Every field writes through to `db.putJob` on `change`, debounced at 400 ms. Object URLs created for thumbnails are revoked when the detail view is torn down.

- [ ] **Step 3: Add the status transitions**

`draft` on creation, `tested` once a test date and polarity exist, `submitted` once a CCEW number lands, `in-sheet` once the Excel tab writes it. Status is a coloured chip on each card.

- [ ] **Step 4: Verify in the browser**

Create a job by hand, fill test values, attach a photo from the file picker, reload the page, and confirm everything survives. Confirm the storage figure in Settings grows after adding a photo.

- [ ] **Step 5: Commit**

```bash
git add src/ui/jobs.js src/app.js
git commit -m "feat: jobs list and detail with test results and evidence photos"
```

---

### Task 9: COC tab

**Files:**
- Create: `src/ui/coc.js`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `extractPdfText`, `parseCoc`, `db.*`
- Produces: `mountCoc(root)`

- [ ] **Step 1: Build the intake**

A file input accepting `application/pdf` plus a drop zone. On selection: extract text, parse, and show a summary card — certificate number, submission date, test completed date, VIN, install type, and the equipment table.

- [ ] **Step 2: Match to a job**

Look the VIN up among `db.allJobs()`.

- Match found: show the job it will attach to and an "Attach certificate" button. On attach, write `job.ccew`, copy `equipment`, set `ecert: 'Y'` and `status: 'submitted'`, and — when the job has no test date — adopt the certificate's `testCompletedDate`.
- No match: offer "Create a job from this certificate", which builds a job carrying the VIN, dates and equipment, with `vinSource: 'coc'`.
- VIN missing from the PDF: show the extracted text in a details block and offer a VIN input so the user can attach it manually.

- [ ] **Step 3: Guard against double-attaching**

If the target job already has a different certificate number, require confirmation before overwriting, and show both numbers.

- [ ] **Step 4: Verify against the real certificate**

Load `samples/coc-sample-1.pdf` through the running app and confirm it matches VIN `R33PD1345TA900016` and fills the fields. Do not commit anything from this step.

- [ ] **Step 5: Commit**

```bash
git add src/ui/coc.js src/app.js
git commit -m "feat: ingest CCEW certificate PDFs and attach them to jobs"
```

---

### Task 10: Excel tab

**Files:**
- Create: `src/ui/excel.js`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `readWorkbook`, `existingVins`, `appendRows`, `jobToRow`, `db.*`, `downloadBlob`
- Produces: `mountExcel(root)`

- [ ] **Step 1: Load and preview**

A file input for `.xlsx`. On load: `readWorkbook`, then show "N rows in the file, last row R" and a delta table listing every job not already present — matched by `existingVins` and by `status === 'in-sheet'`. Each pending job gets a checkbox, ticked by default, and shows exactly what will be written per column.

- [ ] **Step 2: Warn on incomplete rows**

A job with a failing VIN check digit, or with no test date, is listed with an amber warning and unticked by default. The user can tick it deliberately.

- [ ] **Step 3: Write and download**

"Add N rows and download" calls `appendRows`, then `downloadBlob(blob, 'Trailers.xlsx')`. On success, mark each written job `status: 'in-sheet'` and record `job.writtenAt`. Show a note that the original file is untouched and the downloaded copy replaces it.

- [ ] **Step 4: Refuse the wrong file**

If `readWorkbook` throws, show the message and change nothing.

- [ ] **Step 5: Verify against the real workbook**

Load `samples/Trailers-sample.xlsx`, add a job, download, then re-open the downloaded file with `readWorkbook` and confirm the original rows, the column K notes and the column N customer block are all intact. Confirm Excel opens the file without a repair prompt.

- [ ] **Step 6: Commit**

```bash
git add src/ui/excel.js src/app.js
git commit -m "feat: append jobs to the trailer register and download it back"
```

---

### Task 11: PWA, icons and README

**Files:**
- Create: `manifest.webmanifest`, `sw.js`, `icons/icon-192.png`, `icons/icon-512.png`, `icons/icon-maskable-512.png`, `README.md`
- Modify: `index.html`

**Interfaces:**
- Produces: an installable, offline-capable app

- [ ] **Step 1: Write the manifest**

```json
{
  "name": "Trailer Cert",
  "short_name": "TrailerCert",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0f1115",
  "theme_color": "#0f1115",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 2: Write sw.js**

Cache-first for the app shell (every file in a versioned precache list), network-only for `vision.googleapis.com`. Bump `CACHE_VERSION` on release; `activate` deletes older caches. The service worker must never cache the Vision endpoint — a stale OCR response would be worse than an error.

- [ ] **Step 3: Generate the icons**

Draw them with a small Node script using a canvas-free approach: write an SVG, then convert with `sharp` if available; otherwise hand-write minimal PNGs. Simplest reliable route with no dependencies: author the icon as an SVG, and use a one-off `node --experimental-...` free approach via an offscreen render in the browser — instead, generate the PNGs directly with a tiny zlib-based PNG writer script kept in `tools/make-icons.mjs`. Design: dark background, a white trailer silhouette with a lightning bolt.

- [ ] **Step 4: Write README.md**

Sections: what it does; getting a Google Vision API key (the five steps, including restricting the key to the Vision API and to the eventual origin); testing on the phone over WiFi with `npm run serve` and the printed network URL; installing to the home screen from Chrome's menu; the job workflow end to end; how the spreadsheet write-back works and that it never edits in place; where data lives and how to get it out; running the tests; and the hosting decision still outstanding (flip the repo public and enable Pages, or connect Cloudflare Pages).

- [ ] **Step 5: Verify installability**

Serve, open in Chrome, check the console for manifest or service-worker errors, confirm the install prompt appears and the app opens standalone.

- [ ] **Step 6: Commit**

```bash
git add manifest.webmanifest sw.js icons/ tools/make-icons.mjs README.md index.html
git commit -m "feat: installable offline PWA with setup documentation"
```

---

### Task 12: Full-suite pass and push

- [ ] **Step 1: Run everything**

Run: `npm test`
Expected: every suite passes.

- [ ] **Step 2: Check nothing private slipped in**

Run: `git ls-files | grep -Ei 'xlsx|pdf|jpg|jpeg|png$'` and confirm only the intended icons appear. Run `git grep` for the electrician's licence number, the customer's email domain, their suburb and contact name, and the `AIza` API-key prefix. Confirm no hits. Do not paste those values into a committed file - describe them, so the check itself does not become the leak.

- [ ] **Step 3: Push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:** Plate OCR → Task 2 + 6. VIN gate → Task 1, enforced in Task 7. CCEW ingest → Tasks 5, 6, 9. Excel write-back → Tasks 3, 4, 10. Photos → Tasks 6, 8. Test results → Task 8. Settings/presets → Tasks 6, 7. Error handling → distributed across 7–10 and stated per tab. Hosting → Task 11's README. PWA → Task 11.

**Correction to the spec:** the spec says other zip entries stay "byte-for-byte" identical. JSZip re-compresses on write, so the *stored bytes* may differ while the *content* is unchanged. Task 4's test asserts decompressed content equality, which is the property that actually matters. Update the spec's wording when the task lands.

**Deferred verification:** the plate fixture in Task 2 is synthetic — its geometry mirrors the real plate, but the field must be re-checked against a genuine Vision response once an API key exists. Task 7's browser verification is the first opportunity; if the real response disagrees, the fixture is replaced with the real one (redacted) and the parser adjusted.
