import { describe, it, expect } from 'vitest';
import { normalizeVin, computeCheckDigit, validateVin, suggestVinFix, VIN_ALPHABET } from '../src/vin.js';

// Real VINs from the trailer fleet. Their position-9 check digits were verified
// by hand before being used as fixtures, so a failure here means the algorithm
// broke, not the data.
const GOOD = [
  'R33PD1344TA900010',
  'R33PD134XTA900013',
  'R33PD1347TA900017',
  'R33PD1348TA900012',
  'R33PD1341TA900014',
  'R33PD1343TA900015',
  'R33PD1345TA900016',
];

describe('normalizeVin', () => {
  it('uppercases and strips separators', () => {
    expect(normalizeVin(' r33pd 1344-ta900010 ')).toBe('R33PD1344TA900010');
  });

  it('maps the characters that cannot occur in a VIN', () => {
    expect(normalizeVin('IOQ')).toBe('100');
  });

  it('survives junk input', () => {
    expect(normalizeVin(null)).toBe('');
    expect(normalizeVin(undefined)).toBe('');
    expect(normalizeVin(42)).toBe('');
  });
});

describe('computeCheckDigit', () => {
  it.each(GOOD)('agrees with position 9 of %s', (vin) => {
    expect(computeCheckDigit(vin)).toBe(vin[8]);
  });

  it('returns X when the remainder is 10', () => {
    expect(computeCheckDigit('R33PD134XTA900013')).toBe('X');
  });

  it('returns null when a character has no transliteration', () => {
    expect(computeCheckDigit('R33PD134*TA90001*')).toBe(null);
  });
});

describe('validateVin', () => {
  it.each(GOOD)('accepts %s', (vin) => {
    const r = validateVin(vin);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe(null);
  });

  it('rejects the wrong length', () => {
    expect(validateVin('R33PD1344TA90001').reason).toBe('length');
    expect(validateVin('R33PD1344TA9000100').reason).toBe('length');
    expect(validateVin('').reason).toBe('length');
    expect(validateVin(null).reason).toBe('length');
  });

  it('rejects illegal characters', () => {
    expect(validateVin('R33PD1344TA90001*').reason).toBe('charset');
    // I, O and Q are illegal in a VIN even though they are letters.
    expect(validateVin('R33PD1344TA90001O').reason).toBe('charset');
  });

  it('reports the expected and actual check digit on a mismatch', () => {
    // Same VIN body, check digit tampered with: 4 becomes 1.
    const r = validateVin('R33PD1341TA900010');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('checkdigit');
    expect(r.expected).toBe('4');
    expect(r.actual).toBe('1');
  });

  // Characters sharing a transliteration value are invisible to the check
  // digit: swapping A for J changes nothing in the weighted sum. That is a
  // property of ISO 3779 itself, not of this implementation.
  const VALUE_GROUPS = ['1AJ', '2BKS', '3CLT', '4DMU', '5ENV', '6FW', '7GPX', '8HY', '9RZ'];
  const sameValueAs = (ch) => VALUE_GROUPS.find((g) => g.includes(ch)) ?? ch;

  it('catches every single-character corruption except transliteration twins', () => {
    // The property the whole app leans on: a misread character in a
    // 17-character string must not pass silently.
    let caught = 0;
    for (const vin of GOOD) {
      for (let i = 0; i < 17; i++) {
        if (i === 8) continue;
        for (const ch of VIN_ALPHABET) {
          if (ch === vin[i]) continue;
          if (sameValueAs(ch) === sameValueAs(vin[i])) continue;
          const corrupted = vin.slice(0, i) + ch + vin.slice(i + 1);
          expect(validateVin(corrupted).ok).toBe(false);
          caught++;
        }
      }
    }
    expect(caught).toBeGreaterThan(3000);
  });

  it('catches every OCR confusion pair, which is what actually matters', () => {
    // None of the character pairs an OCR engine mixes up on a metal plate are
    // transliteration twins, so all of them are detected.
    const OCR_PAIRS = [['8', 'B'], ['5', 'S'], ['2', 'Z'], ['6', 'G'], ['4', 'A'], ['1', '7'], ['0', 'D'], ['9', 'P']];
    for (const [a, b] of OCR_PAIRS) {
      expect(sameValueAs(a)).not.toBe(sameValueAs(b));
    }

    let checked = 0;
    for (const vin of GOOD) {
      for (let i = 0; i < 17; i++) {
        if (i === 8) continue;
        for (const [a, b] of OCR_PAIRS) {
          for (const [from, to] of [[a, b], [b, a]]) {
            if (vin[i] !== from) continue;
            expect(validateVin(vin.slice(0, i) + to + vin.slice(i + 1)).ok).toBe(false);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('suggestVinFix', () => {
  it('returns null when the VIN is already valid', () => {
    for (const vin of GOOD) expect(suggestVinFix(vin)).toBe(null);
  });

  it('returns null for input that is not a VIN at all', () => {
    expect(suggestVinFix('nonsense')).toBe(null);
    expect(suggestVinFix(null)).toBe(null);
  });

  it('recovers a P misread as 9', () => {
    const original = 'R33PD1344TA900010';
    const misread = 'R339D1344TA900010'; // P at index 3 read as 9
    expect(validateVin(misread).ok).toBe(false);
    expect(suggestVinFix(misread)).toBe(original);
  });

  it('never returns a candidate that fails validation', () => {
    // Sweep every confusion-pair corruption of every known VIN. Whenever a fix
    // is offered it must be a genuinely valid VIN.
    const pairs = [['8', 'B'], ['5', 'S'], ['2', 'Z'], ['6', 'G'], ['4', 'A'], ['1', '7'], ['0', 'D'], ['9', 'P']];
    let offered = 0;
    for (const vin of GOOD) {
      for (let i = 0; i < 17; i++) {
        if (i === 8) continue;
        for (const [a, b] of pairs) {
          for (const [from, to] of [[a, b], [b, a]]) {
            if (vin[i] !== from) continue;
            const corrupted = vin.slice(0, i) + to + vin.slice(i + 1);
            const fix = suggestVinFix(corrupted);
            if (fix !== null) {
              expect(validateVin(fix).ok).toBe(true);
              offered++;
            }
          }
        }
      }
    }
    expect(offered).toBeGreaterThan(0);
  });

  it('stays silent when two different corrections would both validate', () => {
    // Ambiguity must produce no suggestion rather than a coin flip.
    const ambiguous = findAmbiguousCase();
    if (ambiguous) expect(suggestVinFix(ambiguous)).toBe(null);
  });
});

// Search the fleet VINs for a corruption that two distinct confusion-pair
// substitutions can both repair. Returns null if none exists, in which case the
// ambiguity test is vacuous but harmless.
function findAmbiguousCase() {
  const CONFUSIONS = { 8: 'B', B: '8', 5: 'S', S: '5', 2: 'Z', Z: '2', 6: 'G', G: '6', 4: 'A', A: '4', 1: '7', 7: '1', 0: 'D', D: '0', 9: 'P', P: '9' };
  for (const vin of GOOD) {
    for (let i = 0; i < 17; i++) {
      if (i === 8) continue;
      const alt = CONFUSIONS[vin[i]];
      if (!alt) continue;
      const corrupted = vin.slice(0, i) + alt + vin.slice(i + 1);
      let valid = 0;
      for (let j = 0; j < 17; j++) {
        if (j === 8) continue;
        const a2 = CONFUSIONS[corrupted[j]];
        if (!a2) continue;
        if (validateVin(corrupted.slice(0, j) + a2 + corrupted.slice(j + 1)).ok) valid++;
      }
      if (valid > 1) return corrupted;
    }
  }
  return null;
}
