# Trailer Cert

Photograph a camper trailer's compliance plate, get a check-digit-verified VIN,
record the test results and evidence photos on the spot, drop in the CCEW when
it comes back, and append it all to `Trailers.xlsx` without disturbing the file.

Built for one job: NSW electrical certification of Breath Trailer campers.

---

## Getting it running

```bash
npm install
npm run serve
```

The server prints a local address and a network one:

```
local:   http://localhost:8080
network: http://192.168.x.x:8080   <- open this on the phone
```

Open the network address on a phone connected to the same WiFi. To install it
to the home screen: Chrome menu → **Add to Home screen**.

This server is for testing only — no TLS, and it stops when the terminal closes.
See [Hosting](#hosting) for putting it somewhere permanent.

## The Google Vision API key

Plate scanning calls Google Cloud Vision. Without a key the app still works;
you just type the plate in by hand.

1. **console.cloud.google.com** → create a project
2. **APIs & Services → Library** → search "Cloud Vision API" → **Enable**
3. **APIs & Services → Credentials → Create credentials → API key** → copy it
4. Edit the key → **API restrictions → Restrict key → Cloud Vision API**
5. Paste it into the app's **Setup** tab

**Billing must be enabled on the project or Vision refuses to answer at all** —
even for the free allowance. This is the first wall a new key hits; the error
reads `PERMISSION_DENIED ... requires billing to be enabled`. Enable it at
**Billing** in the Cloud console and attach a payment method.

Once it is on, the first **1,000 images each month are free**. At thirty-odd
trailers a month you will not be charged.

Once the app is hosted at a fixed address, add an **Application restriction →
HTTP referrers** for that address. The key lives in the phone's local storage
and is never committed to this repository.

## How a job goes

**Scan** → photograph the plate. Vision reads it, and the VIN is checked
against its ISO-3779 check digit before anything is saved. A VIN that fails is
shown in red and cannot be saved without ticking an explicit override; where the
failure has exactly one plausible single-character fix, the app offers it.

**Jobs** → the trailer's record: plate figures, inverter and battery, test
results (RCD trip time and current, insulation resistance, earth continuity,
polarity, the CCEW test list), install description, and photos. Add a photo of
the tester's display and it stays attached to the trailer.

**CCEW** → when the certificate PDF comes back from the portal, pick it here.
The app reads the certificate number, submission date, test completed date, the
VIN and the whole equipment table, finds the matching job by VIN, and fills it
in. If no job matches it offers to create one from the certificate alone.

**Excel** → pick `Trailers.xlsx`. The app lists every job not already in the
file, you tick what to write, and a new copy downloads with the rows added.

## What it writes to the spreadsheet

Existing columns are used exactly as they are:

| A | B | C | D | E |
|---|---|---|---|---|
| Vin | Power | Battery | Date | Ecert |

New fields go into the empty range, avoiding **K** (install notes) and **N**
(customer block):

| F | G | H | I |
|---|---|---|---|
| CCEW No | Test date | Submitted | Install type |

**Your file is never modified in place.** It is read, and a new copy is
downloaded — put that one back in the `CCEW'S` folder. Only the worksheet and
the shared-string table are rewritten; every other part of the workbook,
including the web-extension parts Excel keeps in there, is copied through
untouched. A job already present in the file is never written twice.

## Where the data lives

Jobs and photos are in this browser's IndexedDB, on this phone. Nothing is
uploaded anywhere except the single plate photo sent to Google Vision for OCR.

That means: **clearing the browser's site data deletes the jobs.** Export the
spreadsheet regularly, and use each job's *Export photos* button to pull the
evidence out as `<VIN>_plate.jpg`, `<VIN>_tester_1.jpg` and so on. Setup shows
how much storage is in use.

## Tests

```bash
npm test
```

Covers the parts where a mistake would be silent: the VIN check digit, the plate
parser's two-column geometry, the certificate parser, Excel's date serials, and
the workbook writer — including a check that every untouched zip entry comes out
byte-identical.

The suite prefers the real `Trailers.xlsx` when a copy sits in `samples/`
(gitignored) and falls back to an equivalent synthetic workbook otherwise, so it
runs anywhere without carrying real data.

## Hosting

The repository is private, so free GitHub Pages is not available. Two ways
forward:

- **Flip the repo public and enable Pages.** Check first: the code holds no API
  key and no personal details, but the test fixtures do contain **real trailer
  VINs** from the register, used as ground truth for the check-digit tests. A VIN
  is stamped on the outside of the trailer rather than being private
  information, but swap them for synthetic ones before going public if you would
  rather not publish the customer's fleet. Settings → Pages → deploy from `main`.
- **Cloudflare Pages**, which serves private repos on the free tier. Connect the
  repo, set the build command to none and the output directory to `/`.

Either way the whole repository *is* the deployable site — there is no build
step. Once it has a fixed address, restrict the Vision key to it.

## Layout

```
index.html            shell and tab bar
styles.css
src/vin.js            check digit, normalisation, fix suggestion
src/plate-parser.js   Vision word boxes -> plate fields
src/coc-parser.js     certificate text -> CCEW fields
src/xlsx-read.js      read the register
src/xlsx-write.js     append rows without rebuilding it
src/zip.js            fflate wrapper
src/vision.js         Google Vision call
src/coc-pdf.js        pdf.js wrapper
src/db.js             IndexedDB
src/settings.js       local settings
src/photos.js         capture, downscale, export
src/ui/*.js           one module per tab
tools/                icon generator, certificate text dumper
test/                 vitest suites and redacted fixtures
vendor/               fflate and pdf.js, committed so the app works offline
```

## Keys and data in this repo

No API key and no personal details (names, licence numbers, addresses, emails)
are committed. The Vision key lives in the phone's local storage; `api.txt` and
`samples/` are gitignored.

The committed test fixtures do contain **real VINs** from the register. They earn
their place: they are the evidence that the check-digit implementation agrees
with the real world. The redacted certificate fixture uses a synthetic VIN.

## Known gaps

- **The plate parser has not been checked against a real Vision response.** Its
  fixture is synthetic: the geometry mirrors the real plate, but a live call was
  not possible because billing was not yet enabled on the Cloud project. Do this
  on the first real scan. If the fields land in the wrong slots, dump the response
  and compare it with `test/fixtures/plate-vision-response.json`; the two-column
  handling in `src/plate-parser.js` is the part most likely to need adjusting.
- Offline caching via the service worker has not been verified on a real phone.
  If it fails, the app still works with a signal.
- The certificate parser knows the equipment types these certificates use. A
  type it has not seen will be skipped rather than misread; add it to
  `EQUIPMENT_ANCHOR` in `src/coc-parser.js`.
