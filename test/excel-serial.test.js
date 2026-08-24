import { describe, it, expect } from 'vitest';
import { toExcelSerial, fromExcelSerial } from '../src/excel-serial.js';

describe('excel serial dates', () => {
  it('round-trips a date', () => {
    const d = new Date(Date.UTC(2026, 7, 24));
    expect(fromExcelSerial(toExcelSerial(d)).getTime()).toBe(d.getTime());
  });

  it('anchors on the 1900 epoch quirk', () => {
    // Excel believes 1900 was a leap year, so 1 January 1900 is serial 2 when
    // counted from 1899-12-30.
    expect(toExcelSerial(new Date(Date.UTC(1900, 0, 1)))).toBe(2);
  });

  it('decodes the serials already sitting in the register', () => {
    // 46224 and 46226 appear in column D of the real Trailers.xlsx. The second
    // one corroborates the epoch independently: the row carrying serial 46226
    // is the trailer whose certificate records a test completed date of
    // 23/07/2026, and 46226 decodes to exactly that day.
    expect(fromExcelSerial(46224).toISOString().slice(0, 10)).toBe('2026-07-21');
    expect(fromExcelSerial(46226).toISOString().slice(0, 10)).toBe('2026-07-23');
  });

  it('encodes back to the same serials', () => {
    expect(toExcelSerial(new Date('2026-07-21T00:00:00Z'))).toBe(46224);
    expect(toExcelSerial(new Date('2026-07-23T00:00:00Z'))).toBe(46226);
  });

  it('ignores the time of day', () => {
    expect(toExcelSerial(new Date('2026-07-21T23:59:00Z'))).toBe(46224);
  });
});
