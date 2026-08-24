import { readEntries, entryToString } from './zip.js';

// Reads just enough of an xlsx to know what is already in the register.
// Deliberately hand-rolled rather than library-driven: the writer alongside
// this file has to put rows back without rebuilding the workbook, so both
// halves work on the same raw XML.

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const STRINGS_PATH = 'xl/sharedStrings.xml';

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

export function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  // An <si> holds either one <t> or several inside <r> runs, which is how
  // Excel stores a string whose formatting changes mid-way.
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
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

      if (type === 'inlineStr') {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
        if (t) cells[col] = decodeXmlEntities(t[1]);
        continue;
      }

      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (!v) continue;
      const raw = v[1];

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

export function readWorkbook(buffer) {
  let entries;
  try {
    entries = readEntries(buffer);
  } catch (cause) {
    throw new Error('That file is not a readable .xlsx workbook.', { cause });
  }

  if (!entries[SHEET_PATH]) {
    throw new Error(`This file has no ${SHEET_PATH} — is it really an .xlsx workbook?`);
  }

  const sheetXml = entryToString(entries[SHEET_PATH]);
  const sharedStrings = parseSharedStrings(
    entries[STRINGS_PATH] ? entryToString(entries[STRINGS_PATH]) : ''
  );
  const rows = parseSheetRows(sheetXml, sharedStrings);
  const lastRow = rows.reduce((max, row) => Math.max(max, row.r), 0);

  return { entries, sharedStrings, sheetXml, rows, lastRow };
}

const VIN_SHAPED = /^[0-9A-HJ-NPR-Z]{17}$/;

export function existingVins(workbook) {
  const set = new Set();
  for (const row of workbook.rows) {
    const a = row.cells.A;
    if (typeof a !== 'string') continue;
    const candidate = a.trim().toUpperCase();
    if (VIN_SHAPED.test(candidate)) set.add(candidate);
  }
  return set;
}
