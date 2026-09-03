import { el, clear, field, textInput, numberInput, toast, debounce, formatDate, photoInput } from './dom.js';
import { validateVin, normalizeVin } from '../vin.js';
import { parseTesterScreen } from '../tester-parser.js';
import { annotatePlate } from '../vision.js';
import { capturePhoto, downloadBlob, photoFilename, formatBytes } from '../photos.js';
import * as db from '../db.js';
import * as settings from '../settings.js';

let container = null;
let context = null;
let objectUrls = [];

export function mountJobs(root, ctx) {
  container = root;
  context = ctx;
  return renderList();
}

export function refreshJobs() {
  if (!container) return;
  return renderList();
}

// Thumbnails hand out object URLs; they are revoked whenever the screen is
// replaced, otherwise a long session slowly leaks the whole photo library.
function releaseUrls() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
}

function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

const STATUS_LABEL = {
  draft: 'Draft',
  tested: 'Tested',
  submitted: 'Submitted',
  'in-sheet': 'In spreadsheet',
};

const STATUS_CLASS = {
  draft: '',
  tested: 'warn',
  submitted: 'ok',
  'in-sheet': 'ok',
};

// A job earns its status from what it actually holds, so the chip never lies
// because a field was edited after the fact.
function deriveStatus(job) {
  if (job.status === 'in-sheet') return 'in-sheet';
  if (job.ccew?.certificateNo) return 'submitted';
  if (job.tests?.date && job.tests?.polarity) return 'tested';
  return 'draft';
}

async function renderList() {
  releaseUrls();
  clear(container);

  const jobs = (await db.allJobs()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  if (jobs.length === 0) {
    container.append(
      el('div', { class: 'empty' }, [
        el('p', { text: 'No trailers yet.' }),
        el('button', {
          class: 'primary',
          type: 'button',
          text: 'Scan a plate',
          onClick: () => context.showTab('scan'),
        }),
      ])
    );
    return;
  }

  const list = el('div');

  const search = el('input', {
    type: 'search',
    placeholder: 'Search VIN',
    autocapitalize: 'characters',
    onInput: (e) => {
      const needle = normalizeVin(e.target.value);
      for (const card of list.children) {
        card.hidden = Boolean(needle) && !card.dataset.vin.includes(needle);
      }
    },
  });

  const photoCounts = new Map();
  for (const photo of await db.allPhotos()) {
    photoCounts.set(photo.jobId, (photoCounts.get(photo.jobId) ?? 0) + 1);
  }

  for (const job of jobs) {
    const status = deriveStatus(job);
    const photos = photoCounts.get(job.id) ?? 0;

    list.append(
      el('button', {
        class: 'job-card',
        type: 'button',
        dataset: { vin: job.vin ?? '' },
        onClick: () => renderDetail(job.id),
      }, [
        el('div', { class: 'vin', text: job.vin || '(no VIN)' }),
        el('div', { class: 'meta' }, [
          el('span', {
            class: `badge ${job.vinValid ? 'ok' : 'bad'}`,
            text: job.vinValid ? '✓ VIN' : '✗ VIN',
          }),
          el('span', { class: `badge ${STATUS_CLASS[status]}`, text: STATUS_LABEL[status] }),
          job.tests?.date ? el('span', { text: formatDate(job.tests.date) }) : null,
          photos ? el('span', { text: `${photos} photo${photos === 1 ? '' : 's'}` }) : null,
        ]),
      ])
    );
  }

  container.append(
    el('div', { class: 'card' }, [
      field(`${jobs.length} trailer${jobs.length === 1 ? '' : 's'}`, search),
    ]),
    list
  );
}

async function renderDetail(jobId) {
  releaseUrls();
  const job = await db.getJob(jobId);
  if (!job) return renderList();

  clear(container);

  const save = debounce(async () => {
    job.status = deriveStatus(job);
    await db.putJob(job);
    await context.updateBadges();
  }, 400);

  const saveNow = async () => {
    job.status = deriveStatus(job);
    await db.putJob(job);
    await context.updateBadges();
  };

  container.append(
    el('div', { class: 'detail-head' }, [
      el('button', { type: 'button', text: '← Jobs', onClick: () => renderList() }),
      el('span', { class: 'spacer' }),
      el('span', {
        class: `badge ${job.vinValid ? 'ok' : 'bad'}`,
        text: job.vinValid ? '✓ VIN verified' : '✗ VIN unverified',
      }),
    ])
  );

  // --- Plate ---

  const vinInput = el('input', {
    type: 'text',
    class: 'mono',
    value: job.vin ?? '',
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const vinNote = el('div', { class: 'hint' });

  const refreshVin = () => {
    const normalized = normalizeVin(vinInput.value);
    if (vinInput.value !== normalized) vinInput.value = normalized;
    job.vin = normalized;
    const check = validateVin(normalized);
    job.vinValid = check.ok;
    vinNote.textContent = check.ok
      ? 'Check digit valid.'
      : check.reason === 'length'
        ? `${normalized.length} of 17 characters.`
        : check.reason === 'charset'
          ? 'Contains a character a VIN cannot hold.'
          : `Check digit should be ${check.expected}, this reads ${check.actual}.`;
    vinNote.className = check.ok ? 'hint' : 'hint error';
    save();
  };

  vinInput.addEventListener('input', refreshVin);

  const plateField = (label, key, props = {}) =>
    field(label, textInput(job.plate?.[key] ?? '', {
      ...props,
      onInput: (e) => {
        job.plate[key] = e.target.value || null;
        save();
      },
    }));

  container.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Plate' }),
      field('VIN', vinInput),
      vinNote,
      plateField('Manufacturer', 'manufacturer'),
      el('div', { class: 'grid-2' }, [
        plateField('ATM (kg)', 'atmKg', { inputmode: 'numeric' }),
        plateField('GTM (kg)', 'gtmKg', { inputmode: 'numeric' }),
      ]),
      el('div', { class: 'grid-2' }, [
        plateField('Tare (kg)', 'tareKg', { inputmode: 'numeric' }),
        plateField('Axle capacity (kg)', 'axleCapacityKg', { inputmode: 'numeric' }),
      ]),
      plateField('Body size (cm)', 'bodySizeCm'),
      plateField('Total size (cm)', 'totalSizeCm'),
      el('div', { class: 'grid-2' }, [
        plateField('Month', 'mm', { inputmode: 'numeric' }),
        plateField('Year', 'yy', { inputmode: 'numeric' }),
      ]),
    ])
  );

  // --- Power (columns B and C) ---

  container.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Installation' }),
      el('div', { class: 'grid-2' }, [
        field('Inverter (W)', numberInput(job.power?.inverterW, {
          onInput: (e) => { job.power.inverterW = numeric(e.target.value); save(); },
        })),
        field('Battery (Ah)', numberInput(job.power?.batteryAh, {
          onInput: (e) => { job.power.batteryAh = numeric(e.target.value); save(); },
        })),
      ]),
      field('Installation type', textInput(job.installType, {
        onInput: (e) => { job.installType = e.target.value; save(); },
      })),
      descriptionPicker(job, save),
    ])
  );

  // --- Tests ---

  const polarityButtons = ['pass', 'fail'].map((value) =>
    el('button', {
      type: 'button',
      text: value === 'pass' ? 'Pass' : 'Fail',
      'aria-pressed': String(job.tests.polarity === value),
      onClick: (e) => {
        job.tests.polarity = job.tests.polarity === value ? '' : value;
        for (const b of e.target.parentElement.children) {
          b.setAttribute('aria-pressed', String(b.textContent.toLowerCase() === job.tests.polarity));
        }
        saveNow();
      },
    })
  );

  const testChecks = el('div', { class: 'checks' },
    settings.TEST_OPTIONS.map((option) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = job.tests.performed?.includes(option) ?? false;
      box.addEventListener('change', () => {
        const set = new Set(job.tests.performed ?? []);
        if (box.checked) set.add(option); else set.delete(option);
        job.tests.performed = settings.TEST_OPTIONS.filter((o) => set.has(o));
        save();
      });
      return el('label', {}, [box, el('span', { text: option })]);
    })
  );

  container.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Test results' }),
      field('Test completed date', el('input', {
        type: 'date',
        value: job.tests.date ?? '',
        onChange: (e) => { job.tests.date = e.target.value; saveNow(); },
      })),
      testerScanner(job, saveNow),
      el('div', { class: 'grid-2' }, [
        field('RCD trip current (mA)', numberInput(job.tests.rcdTripCurrentMa, {
          id: 'f-rcd-ma',
          onInput: (e) => { job.tests.rcdTripCurrentMa = numeric(e.target.value); save(); },
        })),
        field('RCD trip time (ms)', numberInput(job.tests.rcdTripMs, {
          id: 'f-rcd-ms',
          onInput: (e) => { job.tests.rcdTripMs = numeric(e.target.value); save(); },
        })),
      ]),
      el('div', { class: 'grid-2' }, [
        field('Insulation (MΩ)', numberInput(job.tests.insulationMohm, {
          step: '0.01',
          onInput: (e) => { job.tests.insulationMohm = numeric(e.target.value); save(); },
        })),
        field('Earth continuity (Ω)', numberInput(job.tests.earthContinuityOhm, {
          step: '0.001',
          id: 'f-continuity',
          onInput: (e) => { job.tests.earthContinuityOhm = numeric(e.target.value); save(); },
        })),
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: 'Polarity' }),
        el('div', { class: 'segmented' }, polarityButtons),
      ]),
      el('h3', { text: 'Tests performed' }),
      testChecks,
      field('Notes', el('textarea', {
        onInput: (e) => { job.tests.notes = e.target.value; save(); },
      }, job.tests.notes ?? '')),
    ])
  );

  // --- CCEW ---

  container.append(ccewCard(job, saveNow, context));

  // --- Photos ---

  container.append(await photoCard(job));

  // --- Danger zone ---

  container.append(
    el('div', { class: 'card' }, [
      el('button', {
        class: 'danger wide',
        type: 'button',
        text: 'Delete this job and its photos',
        onClick: async () => {
          if (!confirm(`Delete ${job.vin || 'this job'} and every photo attached to it? This cannot be undone.`)) return;
          await db.deleteJobWithPhotos(job.id);
          await context.updateBadges();
          toast('Deleted');
          renderList();
        },
      }),
    ])
  );

  refreshVin();
}


// Photograph the tester's screen and let it fill the numbers in. Same discipline
// as the plate: the reading lands in the form, and the electrician confirms it.
// Only the RCD auto table and the low-ohm continuity screen are read.
function testerScanner(job, saveNow) {
  const status = el('p', { class: 'hint' });
  const warnBox = el('div');

  const setField = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.value = value ?? '';
  };

  const showWarnings = (list) => {
    clear(warnBox);
    if (!list?.length) return;
    warnBox.append(
      el('div', { class: 'callout warn' }, [
        el('ul', { style: 'margin:0;padding-left:18px' }, list.map((w) => el('li', { text: w }))),
      ])
    );
  };

  const readTester = async (file) => {
    clear(warnBox);

    const config = settings.get();
    if (!config.visionApiKey) {
      status.className = 'hint error';
      status.textContent = 'No Vision API key set. Add one in Setup, or type the values in.';
      return;
    }

    status.className = 'hint working';
    status.textContent = 'Reading the tester…';

    try {
      const reading = parseTesterScreen(await annotatePlate(file, config.visionApiKey));

      if (reading.kind === 'rcd') {
        if (reading.tripCurrentMa !== null) {
          job.tests.rcdTripCurrentMa = reading.tripCurrentMa;
          setField('f-rcd-ma', reading.tripCurrentMa);
        }
        if (reading.tripTimeMs !== null) {
          job.tests.rcdTripMs = reading.tripTimeMs;
          setField('f-rcd-ms', reading.tripTimeMs);
        }

        // Say what it saw, so the figure in the form can be checked against the
        // table on the screen without opening the photo. The 180 degree reading
        // is shown but named as unused, so a mismatch with the form is not read
        // as a mistake.
        status.className = 'hint';
        if (reading.tripTimeMs !== null) {
          const cross = reading.x1OneEighty !== null
            ? `; 180° read ${reading.x1OneEighty} ms, not used`
            : '';
          status.textContent = `×1 at 0° read ${reading.tripTimeMs} ms${cross}. Check against the screen.`;
        } else if (reading.x1OneEighty !== null) {
          status.className = 'hint error';
          status.textContent =
            `Only the 180° row read (${reading.x1OneEighty} ms). The certificate takes the 0° figure — type it in.`;
        } else {
          status.className = 'hint error';
          status.textContent = 'Could not read the ×1 row.';
        }
      } else if (reading.kind === 'continuity') {
        if (reading.ohms !== null) {
          job.tests.earthContinuityOhm = reading.ohms;
          setField('f-continuity', reading.ohms);
        }
        status.className = 'hint';
        status.textContent = reading.ohms !== null
          ? `Read ${reading.ohms} Ω. Check against the screen.`
          : 'Could not read a value.';
      } else {
        status.className = 'hint error';
        status.textContent = 'That screen is not one I read.';
      }

      showWarnings(reading.warnings);
      await saveNow();

      // Keep the photo as evidence regardless of how well it read.
      try {
        await capturePhoto(file, 'tester', job.id, reading.kind);
      } catch (err) {
        console.error('Could not store the tester photo', err);
      }
    } catch (err) {
      status.className = 'hint error';
      status.textContent = `${err.message} You can type the values in instead.`;
    }
  };

  return el('div', { style: 'margin-bottom:10px' }, [
    photoInput({
      label: 'Scan tester screen',
      buttonStyle: 'min-height:56px;font-size:15px',
      onFile: readTester,
    }),
    status,
    warnBox,
  ]);
}

function descriptionPicker(job, save) {
  const presets = settings.get().descriptionPresets;
  const area = el('textarea', {
    onInput: (e) => {
      job.equipment = [{ type: 'Description', description: e.target.value }];
      save();
    },
  }, job.equipment?.map((e) => e.description).filter(Boolean).join('\n') ?? '');

  const picker = el('select', {
    onChange: (e) => {
      if (!e.target.value) return;
      area.value = area.value ? `${area.value}\n${e.target.value}` : e.target.value;
      job.equipment = [{ type: 'Description', description: area.value }];
      save();
      e.target.value = '';
    },
  }, [
    el('option', { value: '', text: 'Add a saved description…' }),
    ...presets.map((p) => el('option', { value: p, text: p.slice(0, 60) + (p.length > 60 ? '…' : '') })),
  ]);

  return el('div', {}, [
    field('Install description', area),
    picker,
  ]);
}

function ccewCard(job, saveNow, ctx) {
  const certInput = textInput(job.ccew?.certificateNo ?? '', {
    inputmode: 'numeric',
    onChange: (e) => { job.ccew.certificateNo = e.target.value.trim(); saveNow(); },
  });

  return el('div', { class: 'card' }, [
    el('h2', { text: 'CCEW' }),
    job.ccew?.certificateNo
      ? el('div', { class: 'callout ok', text: `Certificate ${job.ccew.certificateNo}` })
      : el('div', { class: 'callout', text: 'No certificate attached yet. Drop the CCEW PDF into the CCEW tab and it will fill this in.' }),
    field('Certificate number', certInput),
    el('div', { class: 'grid-2' }, [
      field('Submitted', el('input', {
        type: 'date',
        value: job.ccew?.submissionDate ?? '',
        onChange: (e) => { job.ccew.submissionDate = e.target.value; saveNow(); },
      })),
      field('Test completed', el('input', {
        type: 'date',
        value: job.ccew?.testCompletedDate ?? '',
        onChange: (e) => { job.ccew.testCompletedDate = e.target.value; saveNow(); },
      })),
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: 'Ecert' }),
      el('div', { class: 'segmented' }, ['Y', 'N'].map((value) =>
        el('button', {
          type: 'button',
          text: value,
          'aria-pressed': String((job.ecert ?? 'N') === value),
          onClick: (e) => {
            job.ecert = value;
            for (const b of e.target.parentElement.children) {
              b.setAttribute('aria-pressed', String(b.textContent === value));
            }
            saveNow();
          },
        })
      )),
    ]),
    el('button', {
      class: 'small',
      type: 'button',
      text: 'Open the CCEW tab',
      onClick: () => ctx.showTab('coc'),
    }),
  ]);
}

async function photoCard(job) {
  const photos = (await db.photosFor(job.id)).sort((a, b) => (a.takenAt < b.takenAt ? -1 : 1));
  const grid = el('div', { class: 'thumbs' });
  const card = el('div', { class: 'card' });

  const drawThumbs = (list) => {
    clear(grid);
    for (const photo of list) {
      grid.append(
        el('div', { class: 'thumb' }, [
          el('img', {
            src: objectUrl(photo.blob),
            alt: photo.caption || photo.kind,
            loading: 'lazy',
            onClick: () => window.open(objectUrl(photo.blob), '_blank'),
          }),
          el('span', { class: 'kind', text: photo.kind }),
        ])
      );
    }
  };

  drawThumbs(photos);

  const makeCapture = (kind, label) =>
    photoInput({
      label,
      style: 'flex:1',
      buttonStyle: 'min-height:56px;font-size:15px',
      chooseLabel: 'Choose a file',
      onFile: async (file) => {
        try {
          await capturePhoto(file, kind, job.id);
          const fresh = (await db.photosFor(job.id)).sort((a, b) => (a.takenAt < b.takenAt ? -1 : 1));
          drawThumbs(fresh);
          toast('Photo added');
        } catch (err) {
          toast(`Could not save the photo: ${err.message}`, 'bad');
        }
      },
    });

  const totalBytes = photos.reduce((sum, p) => sum + (p.bytes ?? 0), 0);

  card.append(
    el('h2', { text: 'Photos' }),
    el('div', { class: 'row' }, [
      makeCapture('tester', 'Tester reading'),
      makeCapture('other', 'Other photo'),
    ]),
    grid,
    el('p', { class: 'hint', text: `${photos.length} photo${photos.length === 1 ? '' : 's'}, ${formatBytes(totalBytes)}` }),
    photos.length
      ? el('button', {
          class: 'small wide',
          type: 'button',
          text: 'Export photos',
          onClick: async () => {
            const list = await db.photosFor(job.id);
            const counters = {};
            for (const photo of list) {
              counters[photo.kind] = (counters[photo.kind] ?? 0) + 1;
              downloadBlob(photo.blob, photoFilename(job.vin, photo.kind, counters[photo.kind]));
              // Chrome throttles a burst of downloads; a small gap keeps them all.
              await new Promise((r) => setTimeout(r, 400));
            }
            toast(`Exported ${list.length} photo${list.length === 1 ? '' : 's'}`);
          },
        })
      : null
  );

  return card;
}

function numeric(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
