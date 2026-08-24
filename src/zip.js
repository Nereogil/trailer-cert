import { unzipSync, zipSync, strFromU8, strToU8 } from '../vendor/fflate.mjs';

// A thin, explicit layer over fflate so the rest of the app talks about
// workbook entries rather than byte arrays. fflate is used instead of JSZip
// because it ships a real ES module: the same import works under vitest and in
// the browser with no UMD shim and no bundler.

export function toUint8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Expected an ArrayBuffer or a typed array');
}

// Returns a plain object of entry path to raw bytes. Entry order is preserved
// by insertion, which matters because a rewritten workbook should look as much
// like the original as possible.
export function readEntries(input) {
  return unzipSync(toUint8(input));
}

export function writeEntries(entries) {
  // Level 6 is the usual zip default and what Excel itself produces.
  return zipSync(entries, { level: 6 });
}

export const entryToString = (bytes) => strFromU8(bytes);
export const stringToEntry = (text) => strToU8(text);
