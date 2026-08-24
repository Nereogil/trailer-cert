// VIN handling per ISO 3779 / ADR 61.
//
// The check digit at position 9 is what makes OCR of a 17-character string safe
// to rely on. Every character contributes to a weighted sum, so a single
// misread character changes the remainder and the VIN is rejected rather than
// quietly filed against the wrong trailer.
//
// One limit worth knowing: characters that share a transliteration value are
// invisible to the check digit — swapping A for J, or B for K, leaves the sum
// untouched. That is ISO 3779's design, not a bug here. It costs us nothing in
// practice, because none of the character pairs an OCR engine confuses on a
// metal plate (8/B, 5/S, 2/Z, 6/G, 4/A, 1/7, 0/D, 9/P) are twins, so every
// realistic misread is caught. See test/vin.test.js for the sweep that proves it.

const TRANSLIT = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export const VIN_ALPHABET = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';

// I, O and Q are not legal in a VIN, so reading one is always an error with a
// single obvious correction.
const ILLEGAL_MAP = { I: '1', O: '0', Q: '0' };

export function normalizeVin(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[IOQ]/g, (c) => ILLEGAL_MAP[c]);
}

export function computeCheckDigit(vin) {
  if (typeof vin !== 'string' || vin.length !== 17) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue;
    const value = TRANSLIT[vin[i]];
    if (value === undefined) return null;
    sum += value * WEIGHTS[i];
  }
  const remainder = sum % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

export function validateVin(vin) {
  if (typeof vin !== 'string' || vin.length !== 17) {
    return { ok: false, reason: 'length', expected: null, actual: null };
  }

  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    // X is legal at position 9 only, where it stands for a check digit of 10.
    const legal = VIN_ALPHABET.includes(ch);
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

// Characters an OCR engine confuses on a stamped or engraved metal plate,
// in both directions.
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
//
// Position 9 is excluded from the search because substituting the check digit
// itself would make any VIN "valid" and prove nothing.
export function suggestVinFix(vin) {
  if (typeof vin !== 'string' || vin.length !== 17) return null;
  if (validateVin(vin).ok) return null;

  const candidates = new Set();
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue;
    const alternative = CONFUSIONS[vin[i]];
    if (!alternative) continue;
    const candidate = vin.slice(0, i) + alternative + vin.slice(i + 1);
    if (validateVin(candidate).ok) candidates.add(candidate);
  }

  return candidates.size === 1 ? [...candidates][0] : null;
}
