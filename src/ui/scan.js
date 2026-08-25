import { el, clear, field, textInput, numberInput, toast, todayIso } from './dom.js';
import { annotatePlate } from '../vision.js';
import { parsePlate } from '../plate-parser.js';
import { normalizeVin, validateVin, suggestVinFix } from '../vin.js';
import { capturePhoto } from '../photos.js';
import * as db from '../db.js';
import * as settings from '../settings.js';

// The flow deliberately stops at a confirmation screen. OCR is an assistant
// here, not an authority: nothing is saved until the VIN's check digit passes,
// or the user overrides it on purpose.

export function mountScan(root, { showTab, updateBadges }) {
  render(root, { showTab, updateBadges });
}

function render(root, ctx) {
  clear(root);

  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    hidden: true,
    id: 'plate-input',
  });

  const hint = el('p', { class: 'hint', text: 'Fill the frame with the plate. Hold steady.' });
  const result = el('div');

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';

    const config = settings.get();

    if (!config.visionApiKey) {
      hint.className = 'hint';
      hint.textContent = 'No Vision API key yet — enter the plate by hand below, or add a key in Setup.';
      showConfirm(result, blankParse(), file, ctx);
      return;
    }

    hint.className = 'hint working';
    hint.textContent = 'Reading the plate…';
    clear(result);

    try {
      const response = await annotatePlate(file, config.visionApiKey);
      const parsed = parsePlate(response);
      parsed.fields.rawText = parsed.rawText;
      hint.className = 'hint';
      hint.textContent = 'Check the values before saving.';
      showConfirm(result, parsed, file, ctx);
    } catch (err) {
      hint.className = 'hint error';
      hint.textContent = `${err.message} You can still enter the plate by hand.`;
      showConfirm(result, blankParse(), file, ctx);
    }
  });

  root.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Scan compliance plate' }),
      el('label', { class: 'capture' }, [
        fileInput,
        el('span', { class: 'big-button', text: 'Take photo of plate' }),
      ]),
      hint,
      el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('button', {
          type: 'button',
          class: 'small',
          text: 'Enter a plate by hand',
          onClick: () => {
            hint.className = 'hint';
            hint.textContent = 'Type what the plate says.';
            showConfirm(result, blankParse(), null, ctx);
          },
        }),
      ]),
    ]),
    result
  );
}

function blankParse() {
  return {
    fields: {
      manufacturer: null, vin: null, bodySizeCm: null, totalSizeCm: null,
      mm: null, yy: null, maxSpeedKmh: null,
      atmKg: null, gtmKg: null, tareKg: null, axleCapacityKg: null, rawText: '',
    },
    vinCheck: validateVin(''),
    vinSuggestion: null,
    warnings: [],
    rawText: '',
  };
}

function showConfirm(container, parsed, file, ctx) {
  clear(container);

  const fields = { ...parsed.fields };
  let vin = fields.vin ?? '';
  let overridden = false;

  const vinInput = el('input', {
    type: 'text',
    class: 'mono',
    value: vin,
    maxlength: '25',
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
    inputmode: 'text',
    'aria-describedby': 'vin-verdict',
  });

  const verdict = el('div', { id: 'vin-verdict' });
  const overrideWrap = el('div');
  const duplicateWarning = el('div');
  const saveButton = el('button', { class: 'primary wide', type: 'button', text: 'Save job' });

  async function checkDuplicate(candidate) {
    clear(duplicateWarning);
    if (candidate.length !== 17) return;
    const jobs = await db.allJobs();
    const existing = jobs.find((j) => j.vin === candidate);
    if (!existing) return;

    duplicateWarning.append(
      el('div', { class: 'callout warn' }, [
        el('div', { text: 'This VIN is already recorded.' }),
        el('button', {
          class: 'small',
          type: 'button',
          style: 'margin-top:8px',
          text: 'Open the existing job instead',
          onClick: () => ctx.showTab('jobs'),
        }),
      ])
    );
  }

  function refreshVerdict() {
    vin = normalizeVin(vinInput.value);
    if (vinInput.value !== vin) {
      const at = vinInput.selectionStart;
      vinInput.value = vin;
      vinInput.setSelectionRange(at, at);
    }

    const check = validateVin(vin);
    const suggestion = vin ? suggestVinFix(vin) : null;

    clear(verdict);
    clear(overrideWrap);
    overridden = false;

    if (check.ok) {
      verdict.append(
        el('div', { class: 'callout ok' }, [
          el('span', { class: 'badge ok', text: '✓ Check digit valid' }),
        ])
      );
      saveButton.disabled = false;
    } else {
      const reason =
        check.reason === 'length'
          ? `${vin.length} of 17 characters`
          : check.reason === 'charset'
            ? 'Contains a character that cannot appear in a VIN'
            : `Check digit should be ${check.expected}, the plate reads ${check.actual}`;

      verdict.append(
        el('div', { class: 'callout bad' }, [
          el('span', { class: 'badge bad', text: '✗ Not verified' }),
          el('div', { style: 'margin-top:6px', text: reason }),
        ])
      );

      if (suggestion) {
        verdict.append(
          el('div', { class: 'callout' }, [
            el('div', { text: 'Did you mean:' }),
            el('div', { class: 'vin-display', style: 'margin:6px 0', text: suggestion }),
            el('button', {
              class: 'small primary',
              type: 'button',
              text: 'Use this VIN',
              onClick: () => {
                vinInput.value = suggestion;
                refreshVerdict();
              },
            }),
          ])
        );
      }

      // An unverified VIN can still be saved, but only on purpose.
      const overrideBox = el('input', { type: 'checkbox' });
      overrideBox.addEventListener('change', () => {
        overridden = overrideBox.checked;
        saveButton.disabled = !overridden;
      });

      overrideWrap.append(
        el('div', { class: 'checks' }, [
          el('label', {}, [overrideBox, el('span', { text: 'Save anyway with an unverified VIN' })]),
        ])
      );

      saveButton.disabled = true;
    }

    checkDuplicate(vin);
  }

  vinInput.addEventListener('input', refreshVerdict);

  const inverterInput = numberInput(null, { placeholder: 'e.g. 2000', min: '0' });
  const batteryInput = numberInput(null, { placeholder: 'e.g. 200', min: '0' });
  const dateInput = el('input', { type: 'date', value: todayIso() });

  const plateField = (label, key, props = {}) =>
    field(label, textInput(fields[key] ?? '', {
      ...props,
      onInput: (e) => {
        fields[key] = e.target.value || null;
      },
    }));

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    try {
      const config = settings.get();
      const job = db.emptyJob();

      job.vin = vin;
      job.vinValid = validateVin(vin).ok;
      job.vinSource = overridden || !parsed.fields.vin ? 'manual' : 'ocr';
      job.plate = {
        manufacturer: fields.manufacturer ?? null,
        bodySizeCm: fields.bodySizeCm ?? null,
        totalSizeCm: fields.totalSizeCm ?? null,
        mm: fields.mm ?? null,
        yy: fields.yy ?? null,
        maxSpeedKmh: toNumber(fields.maxSpeedKmh),
        atmKg: toNumber(fields.atmKg),
        gtmKg: toNumber(fields.gtmKg),
        tareKg: toNumber(fields.tareKg),
        axleCapacityKg: toNumber(fields.axleCapacityKg),
        rawText: parsed.rawText ?? '',
      };
      job.power = {
        inverterW: toNumber(inverterInput.value),
        batteryAh: toNumber(batteryInput.value),
      };
      job.tests.date = dateInput.value;
      job.tests.performed = [...config.defaultTests];
      job.installType = config.defaultInstallType;

      await db.putJob(job);

      if (file) {
        try {
          await capturePhoto(file, 'plate', job.id, 'Compliance plate');
        } catch (err) {
          console.error('Could not store the plate photo', err);
          toast('Job saved, but the photo could not be stored.', 'bad');
        }
      }

      await ctx.updateBadges();
      toast('Job saved');
      ctx.showTab('jobs');
    } catch (err) {
      console.error(err);
      toast(`Could not save: ${err.message}`, 'bad');
      saveButton.disabled = false;
    }
  });

  container.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Confirm the plate' }),
      field('VIN', vinInput),
      verdict,
      overrideWrap,
      duplicateWarning,

      ...(parsed.warnings?.length
        ? [el('div', { class: 'callout warn' }, [
            el('div', { text: 'Check these before saving:' }),
            el('ul', { style: 'margin:6px 0 0;padding-left:18px' },
              parsed.warnings.map((w) => el('li', { text: w }))),
          ])]
        : []),

      el('h3', { text: 'Plate details' }),
      el('p', { class: 'hint', style: 'margin-top:0' , text: 'The camera misses figures on a shiny plate. Compare these against the plate itself.' }),
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
      plateField('Max speed (km/h)', 'maxSpeedKmh', { inputmode: 'numeric' }),

      el('h3', { text: 'Installation' }),
      el('div', { class: 'grid-2' }, [
        field('Inverter (W)', inverterInput),
        field('Battery (Ah)', batteryInput),
      ]),
      field('Test date', dateInput),

      parsed.rawText
        ? el('details', { class: 'raw' }, [
            el('summary', { text: 'What the camera read' }),
            el('pre', { text: parsed.rawText }),
          ])
        : null,

      el('div', { style: 'margin-top:14px' }, [saveButton]),
    ])
  );

  refreshVerdict();
  vinInput.focus();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
