# Trailer Cert — design

**Date:** 2026-08-24
**Status:** approved, ready for implementation plan

## Problem

Electrical certification of camper trailers (Breath Trailer, NSW) currently means
hand-copying a 17-character VIN and a set of plate figures off a metal compliance
plate into `Trailers.xlsx`, then re-typing the same details into the NSW Building
Commission CCEW portal, then hand-updating the spreadsheet again once the
certificate comes back. The transcription is slow, error-prone, and happens while
standing next to the trailer with a tester in one hand.

## Goal

A phone app that turns one photo of the compliance plate into a verified trailer
record, carries the test results and evidence photos taken during the job, absorbs
the returned CCEW PDF, and writes the result back into the existing
`Trailers.xlsx` without disturbing it.

## Non-goals

- Mail-server OAuth (Gmail/M365 inbox reading)
- Submitting the CCEW to the NSW portal automatically
- Multi-user accounts or server-side sync
- Generating our own certificate PDF

## Shape

A single static page, no backend. Installed to the Android home screen as a PWA.
Everything is local to the phone except one outbound call to Google Cloud Vision.

```
[ Scan ] --photo--> Vision OCR --> plate parse --> VIN check-digit gate --> Job
[ Jobs ] --------> job detail: plate data | tests | photos | CCEW
[ COC  ] --PDF---> parse cert no + dates + VIN --> match job --> stamp CCEW
[ Excel] --xlsx--> append new rows --> download updated Trailers.xlsx
[ Setup] --------> Vision key, electrician + customer defaults, description presets
```

## Data model

One `job` per trailer, stored in IndexedDB.

```
job {
  id, createdAt, updatedAt,
  vin, vinValid, vinSource: 'ocr' | 'manual',
  plate: { manufacturer, bodySizeCm, totalSizeCm, mm, yy,
           maxSpeedKmh, atmKg, gtmKg, tareKg, axleCapacityKg, rawText },
  power: { inverterW, batteryAh },
  tests: { date, rcdTripMs, rcdTripCurrentMa, insulationMohm,
           earthContinuityOhm, polarity, performed[], notes },
  equipment: [ { type, ratingA, qty, description } ],
  ccew: { certificateNo, submissionDate, testCompletedDate, sourceFile },
  photos: [ { id, kind, blob, caption, takenAt } ],
  ecert: 'Y' | 'N',
  status: 'draft' | 'tested' | 'submitted' | 'in-sheet'
}
```

Electrician details, customer block and description presets live in Settings, not
in source — the repo carries no personal or licence data.

## Plate OCR

Google Cloud Vision `DOCUMENT_TEXT_DETECTION`, API key supplied by the user at
runtime and kept in `localStorage`.

The plate is a **two-column form**: `BODY SIZE | 290X150X136 | CM` sits on the same
visual row as `ATM | 1500 | KGS`. Reading Vision's text in document order
interleaves the columns and scrambles the values. So parsing is **label-anchored
by geometry**: locate each label's bounding box, then take the value box whose
vertical centre falls inside the label's y-band and whose x-origin is to the
right, stopping at the next label box. Labels handled: MANUFACTURER, VIN NUMBER,
BODY SIZE, TOTAL SIZE, MM, YY, MAX SPEED, ATM, GTM, TARE WEIGHT, AXLE GROUP LOAD
CAPACITY.

## VIN verification (the accuracy gate)

These VINs carry a real ISO-3779 check digit at position 9 — verified against
three known-good rows of the existing spreadsheet plus the sample plate
(`R33PD1347TA900017` gives computed check digit 9; `R33PD134XTA900013` gives X).

Pipeline:

1. Uppercase, strip whitespace and punctuation.
2. Map characters that cannot legally occur in a VIN: `I` to `1`, `O` to `0`, `Q` to `0`.
3. Reject unless exactly 17 characters.
4. Compute the check digit (weights 8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2;
   transliteration A=1..Z=9 skipping I/O/Q; remainder mod 11, 10 becomes `X`).
5. On failure, try single-character substitutions over the known OCR confusion
   pairs (8/B, 5/S, 2/Z, 6/G, 4/A, 1/7, 0/D). If **exactly one** candidate passes,
   offer it as a suggestion — never apply silently.
6. Display the result beside a crop of the plate photo for visual confirmation.

**A VIN that fails the check digit cannot be written to the spreadsheet** without
an explicit manual override, which records `vinSource: 'manual'`.

## CCEW PDF ingest

The returned certificate is a text-layer PDF from Building Commission NSW. Parse
client-side with a vendored pdf.js. Extract:

- `Certificate no:` followed by 11 digits
- `Submission date:` followed by a d/m/yyyy date
- `Test completed date:` followed by a dd/mm/yyyy date
- the 17-character VIN from the "Where is the work being carried out?" answer
- the equipment table rows (type, rating, qty, description)

Match on VIN to an existing job; if no job matches, offer to create one. The
extracted text is whitespace-noisy (the producer emits per-glyph runs), so all
matching normalises whitespace before applying patterns.

## Excel write-back

`Trailers.xlsx` is a live working file containing web-extension parts that a
library rebuild would silently drop. So the app **edits the xlsx zip surgically**
with JSZip: rewrite only `xl/worksheets/sheet1.xml` and `xl/sharedStrings.xml`,
copy every other entry through byte-for-byte.

Existing columns are preserved exactly:

| A | B | C | D | E |
|---|---|---|---|---|
| Vin | Power | Battery | Date | Ecert |

New columns are appended in the empty range, avoiding K (install notes) and N
(customer block), both of which hold existing content:

| F | G | H | I |
|---|---|---|---|
| CCEW No | Test date | Submitted | Install type |

Dates are written as Excel serials carrying the style index copied from the cell
above, so column D keeps its existing date formatting. Rows append below the last
populated row. A job already written is marked `status: 'in-sheet'` and is not
written twice; the app shows how many rows are in the file and how many are new
before writing.

## Photos

Captured via `<input type="file" accept="image/*" capture="environment">`,
downscaled to 1600px longest edge at JPEG q0.8 (about 300 KB), stored as blobs in
IndexedDB. Per-job export names files `<VIN>_plate.jpg`, `<VIN>_tester_1.jpg`.
A storage meter and a purge-after-export action keep the phone from filling up.

## Error handling

- No API key set: Scan tab explains and links to Settings; manual entry stays open.
- Vision call fails or times out: keep the photo, allow manual entry, offer retry.
- Check-digit failure: red state, suggestion if unambiguous, override requires a tap.
- Duplicate VIN: warn and offer to open the existing job instead of creating one.
- Wrong file type on the Excel tab: reject before touching anything.
- The xlsx write is never in-place: the original is read, a new file is downloaded.

## Testing

- **VIN check digit**: the known-good VINs from the existing spreadsheet as fixtures,
  plus mutation tests asserting single-character corruptions are caught.
- **Plate parser**: the sample plate's Vision response saved as a fixture; asserts
  every field lands in the right slot, especially the two-column ATM/BODY SIZE pair.
- **COC parser**: the sample certificate's extracted text as a fixture.
- **xlsx writer**: append into a copy of the real workbook, then assert the
  untouched zip entries are byte-identical and the new rows read back correctly.

## Hosting

The repo is private, so free GitHub Pages is unavailable. The build stays a single
static directory deployable anywhere. Two paths, decided later: flip the repo
public and enable Pages, or connect Cloudflare Pages. For testing before that
decision, the app is served over LAN from the laptop.

The Vision API key must be restricted to the eventual origin (HTTP referrer) and
to the Vision API only.
