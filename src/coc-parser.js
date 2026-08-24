import { normalizeVin, validateVin } from './vin.js';

// Reads a NSW Building Commission "Certificate of Compliance - Electrical Work"
// once pdf.js has turned it into text.
//
// The text comes out clean — words intact, fields separated by runs of spaces —
// so this is label-and-regex work rather than reconstruction. The one nuisance
// is that the page header, the security banner and the equipment table's column
// headings repeat on every page and land in the middle of the content. They are
// stripped first, otherwise they end up glued to the last description on a page.

const PAGE_HEADER = /nsw\.gov\.au\/building-commission\s*\|[^|]*\|\s*ABN[\d\s]*/g;
const SECURITY_BANNER = /OFFICIAL:\s*Sensitive\s*-\s*Personal/g;
const TABLE_HEADING = /Equipment\s+Rating\s+No\.\s+Description/g;
const CERTIFICATE_LINE = /Certificate no:\s*\d{9,13}/g;

// The certificate number is read from the raw text before this runs, so every
// occurrence can go — including the one stamped into each page header, which
// otherwise glues itself to the last equipment description on the page.
export function stripBoilerplate(text) {
  return String(text ?? '')
    .replace(PAGE_HEADER, ' ')
    .replace(CERTIFICATE_LINE, ' ')
    .replace(SECURITY_BANNER, ' ')
    .replace(TABLE_HEADING, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function afterLabel(text, label, length = 120) {
  const at = text.indexOf(label);
  if (at === -1) return null;
  return text.slice(at + label.length, at + label.length + length);
}

// The form is inconsistent: submission dates print as 27/7/2026 and test dates
// as 23/07/2026, so both are handled.
function toIsoDate(text) {
  if (!text) return null;
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (!m) return null;
  const [, day, month, year] = m;
  return `${year}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
}

function findCertificateNo(text) {
  const after = afterLabel(text, 'Certificate no:', 30);
  const m = after && /\d{9,13}/.exec(after);
  return m ? m[0] : null;
}

function findVin(text) {
  // The VIN follows "VIN:" in the answer to where the work was carried out.
  const after = afterLabel(text, 'VIN:', 40);
  if (after) {
    const candidate = normalizeVin(after.trim().split(/\s+/)[0] ?? '');
    if (candidate.length === 17) return candidate;
  }
  // Failing that, take any 17-character run whose check digit holds.
  for (const m of text.matchAll(/\b[0-9A-HJ-NPR-Z]{17}\b/g)) {
    const v = normalizeVin(m[0]);
    if (validateVin(v).ok) return v;
  }
  return null;
}

function findInstallType(text) {
  const after = afterLabel(text, 'What type of installation is this electrical work for?', 80);
  if (!after) return null;
  // The answer arrives as "Other Other Caravan Trailer": a category, a
  // sub-category, then the free-text value that is the part worth keeping.
  const cleaned = after.replace(/^\s*(Other\s+)+/i, '').trim();
  const stop = cleaned.search(/What type of work|Are special conditions/i);
  const value = (stop === -1 ? cleaned : cleaned.slice(0, stop)).trim();
  return value || null;
}

function findWorkType(text) {
  const after = afterLabel(text, 'What type of work is being carried out?', 140);
  if (!after) return null;
  const stop = after.search(/Where is the work being carried out\?/i);
  const value = (stop === -1 ? after : after.slice(0, stop)).trim();
  return value || null;
}

// Equipment rows are "<type> <rating>A [<qty>] <description>" repeated. Anchor
// on the type-plus-rating pair, then take everything up to the next anchor.
const EQUIPMENT_ANCHOR =
  /(Switchboards|Socket-outlets|Socket outlets|Lighting points|Cooking appliances|Water heaters|Air conditioning|Other\s*-\s*[A-Za-z][A-Za-z\- ]*?)\s+(\d+)\s*A(?=\s)/g;

const EQUIPMENT_SECTION_END = /Tester details|Test details|Declaration and privacy/i;

function findEquipment(text) {
  const anchors = [...text.matchAll(EQUIPMENT_ANCHOR)];
  if (anchors.length === 0) return [];

  return anchors.map((anchor, i) => {
    const from = anchor.index + anchor[0].length;
    const to = anchors[i + 1]?.index ?? text.length;
    let segment = text.slice(from, to);

    const end = segment.search(EQUIPMENT_SECTION_END);
    if (end !== -1) segment = segment.slice(0, end);

    // A leading bare number is the quantity column; the form leaves it empty
    // for switchboards, in which case the description starts straight away.
    const qtyMatch = /^\s*(\d{1,3})\s+(?=[A-Za-z])/.exec(segment);
    const qty = qtyMatch ? Number(qtyMatch[1]) : null;
    if (qtyMatch) segment = segment.slice(qtyMatch[0].length);

    return {
      // Only the "Other - X" family gets its spacing normalised; hyphenated
      // type names like "Socket-outlets" must be left exactly as printed.
      type: anchor[1].trim().replace(/^Other\s*-\s*/, 'Other - '),
      ratingA: Number(anchor[2]),
      qty,
      description: segment.trim() || null,
    };
  });
}

function findTestsPerformed(text) {
  const after = afterLabel(text, 'Which tests have been performed on the installation?', 400);
  if (!after) return [];
  const stop = after.search(/Who is the network provider|Would you like to send|Declaration and privacy/i);
  const list = stop === -1 ? after : after.slice(0, stop);
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseCoc(rawText) {
  // Read the certificate number first: stripping the boilerplate removes every
  // occurrence of it, header and body alike.
  const certificateNo = findCertificateNo(String(rawText ?? '').replace(/\s+/g, ' '));
  const text = stripBoilerplate(rawText);
  const vin = findVin(text);

  return {
    certificateNo,
    submissionDate: toIsoDate(afterLabel(text, 'Submission date:', 30)),
    testCompletedDate: toIsoDate(afterLabel(text, 'Test completed date', 30)),
    vin,
    vinValid: vin ? validateVin(vin).ok : false,
    installType: findInstallType(text),
    workType: findWorkType(text),
    equipment: findEquipment(text),
    testsPerformed: findTestsPerformed(text),
  };
}
