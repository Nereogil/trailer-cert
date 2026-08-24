import { readEntries, writeEntries, entryToString, stringToEntry, toUint8 } from './zip.js';
import { readWorkbook } from './xlsx-read.js';
import { toExcelSerial } from './excel-serial.js';

// Appends rows to the trailer register without rebuilding the workbook.
//
// The register is a live working file that carries parts no spreadsheet library
// round-trips faithfully — web extension entries among them. Loading it into a
// library and writing it back would silently drop those. So only the two parts
// that actually change are rewritten (the sheet and the shared string table)
// and every other entry is copied through with its bytes untouched.

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const STRINGS_PATH = 'xl/sharedStrings.xml';

// Columns A..E are the register's existing table. K holds free-text install
// notes and N the customer block, both written by hand over the years, so new
// fields go into the empty F..I range and nothing else is touched.
export function jobToRow(job) {
  const row = {};
  const put = (col, value, kind) => {
    if (value === null || value === undefined || value === '') return;
    row[col] = { v: value, kind };
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

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Reuse the style of the nearest cell above in the same column, so an appended
// date inherits the column's number format instead of showing as a bare serial.
function styleOfColumnAbove(sheetXml, col, rowNumber) {
  for (let r = rowNumber - 1; r >= 1; r--) {
    const match = new RegExp(`<c\\b[^>]*\\br="${col}${r}"[^>]*`).exec(sheetXml);
    if (!match) continue;
    const style = /\bs="(\d+)"/.exec(match[0]);
    if (style) return style[1];
  }
  return null;
}

// The new CCEW date columns are empty, so there is no cell above them to copy a
// style from and their dates would display as bare serials. Borrow the style
// the register already uses for column D, which is the one column known to hold
// dates. Falls back to no style if the workbook has never formatted a date.
const DATE_COLUMN = 'D';

function dateStyle(sheetXml, col, rowNumber) {
  return (
    styleOfColumnAbove(sheetXml, col, rowNumber) ??
    styleOfColumnAbove(sheetXml, DATE_COLUMN, rowNumber)
  );
}

function buildCell(col, rowNumber, cell, internString, sheetXml) {
  const ref = `${col}${rowNumber}`;

  if (cell.kind === 'number') {
    return `<c r="${ref}"><v>${Number(cell.v)}</v></c>`;
  }

  if (cell.kind === 'date') {
    const serial = toExcelSerial(new Date(`${cell.v}T00:00:00Z`));
    const style = dateStyle(sheetXml, col, rowNumber);
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${serial}</v></c>`;
  }

  return `<c r="${ref}" t="s"><v>${internString(String(cell.v))}</v></c>`;
}

function updateDimension(sheetXml, lastRow) {
  return sheetXml.replace(
    /<dimension\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*\/>/,
    (_full, firstCol, firstRow, lastCol) =>
      `<dimension ref="${firstCol}${firstRow}:${lastCol}${lastRow}"/>`
  );
}

export function appendRows(buffer, rows) {
  // Nothing to add: hand back the original bytes rather than a re-zipped copy,
  // so a no-op download is genuinely the same file.
  if (!rows || rows.length === 0) return toUint8(buffer);

  const workbook = readWorkbook(buffer);
  const entries = { ...readEntries(buffer) };

  const strings = [...workbook.sharedStrings];
  const seen = new Map(strings.map((s, i) => [s, i]));
  const internString = (value) => {
    if (seen.has(value)) return seen.get(value);
    const i = strings.length;
    strings.push(value);
    seen.set(value, i);
    return i;
  };

  let sheetXml = workbook.sheetXml;

  if (/<sheetData\s*\/>/.test(sheetXml)) {
    sheetXml = sheetXml.replace(/<sheetData\s*\/>/, '<sheetData></sheetData>');
  }
  if (!sheetXml.includes('</sheetData>')) {
    throw new Error('Could not find <sheetData> in the worksheet — refusing to write.');
  }

  let rowNumber = workbook.lastRow;
  const xmlRows = rows.map((row) => {
    rowNumber += 1;
    const cells = Object.keys(row)
      .sort()
      .map((col) => buildCell(col, rowNumber, row[col], internString, sheetXml))
      .join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  });

  sheetXml = sheetXml.replace('</sheetData>', `${xmlRows.join('')}</sheetData>`);
  sheetXml = updateDimension(sheetXml, rowNumber);

  const sharedStringsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((t) => `<si><t xml:space="preserve">${escapeXml(t)}</t></si>`).join('') +
    '</sst>';

  entries[SHEET_PATH] = stringToEntry(sheetXml);
  entries[STRINGS_PATH] = stringToEntry(sharedStringsXml);

  return writeEntries(entries);
}

// Convenience for the UI: which of these jobs is not already in the workbook.
export function pendingJobs(workbook, jobs, existingVinSet) {
  return jobs.filter((job) => job.vin && !existingVinSet.has(job.vin.toUpperCase()));
}

export { entryToString };
