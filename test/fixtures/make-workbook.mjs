import { writeEntries, stringToEntry } from '../../src/zip.js';

// A minimal workbook shaped like the real trailer register: a title row, a
// header row, data rows, a free-text note in column K and a contact line in
// column N. The last two exist so tests can prove an append never disturbs
// them. No real customer data appears here.

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

// A part with no analogue in the spreadsheet spec, standing in for the web
// extension parts the real workbook carries. Tests assert it survives a write.
const EXTRA_PART = '<?xml version="1.0" encoding="UTF-8"?><webextension xmlns="http://example.invalid/we" id="stand-in"/>';

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

export function buildTestWorkbook() {
  return writeEntries({
    '[Content_Types].xml': stringToEntry(CONTENT_TYPES),
    '_rels/.rels': stringToEntry(RELS),
    'xl/workbook.xml': stringToEntry(WORKBOOK),
    'xl/_rels/workbook.xml.rels': stringToEntry(WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': stringToEntry(SHEET),
    'xl/sharedStrings.xml': stringToEntry(SHARED),
    'xl/styles.xml': stringToEntry(STYLES),
    'xl/webextensions/webextension1.xml': stringToEntry(EXTRA_PART),
  });
}
