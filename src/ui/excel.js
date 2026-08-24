import { el, clear, toast, formatDate } from './dom.js';
import { readWorkbook, existingVins } from '../xlsx-read.js';
import { appendRows, jobToRow } from '../xlsx-write.js';
import { downloadBlob } from '../photos.js';
import * as db from '../db.js';

// Load the register, show exactly what would be added, then hand back a new
// copy. The file on disk is never modified: it is read, and a fresh one is
// downloaded, so a mistake here costs nothing but a discarded download.

let container = null;
let context = null;

export function mountExcel(root, ctx) {
  container = root;
  context = ctx;
  render();
}

export function refreshExcel() {
  if (container && !container.dataset.loaded) render();
}

function render() {
  clear(container);
  delete container.dataset.loaded;

  const fileInput = el('input', {
    type: 'file',
    accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    hidden: true,
  });

  const status = el('p', { class: 'hint', text: 'Pick Trailers.xlsx and it will show what is new.' });
  const result = el('div');

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';
    clear(result);

    status.className = 'hint working';
    status.textContent = 'Reading the workbook…';

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const workbook = readWorkbook(bytes);
      status.className = 'hint';
      status.textContent = `${file.name} — ${workbook.rows.length} rows, last row ${workbook.lastRow}.`;
      await showDelta(result, bytes, workbook, file.name);
      container.dataset.loaded = '1';
    } catch (err) {
      status.className = 'hint error';
      status.textContent = err.message;
    }
  });

  container.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Trailer register' }),
      el('label', { class: 'capture' }, [
        fileInput,
        el('span', { class: 'big-button', text: 'Choose Trailers.xlsx' }),
      ]),
      status,
    ]),
    result
  );
}

async function showDelta(mount, bytes, workbook, filename) {
  const jobs = await db.allJobs();
  const already = existingVins(workbook);

  const candidates = jobs
    .filter((job) => job.vin)
    .filter((job) => !already.has(job.vin.toUpperCase()))
    .filter((job) => job.status !== 'in-sheet')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  if (candidates.length === 0) {
    mount.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'callout ok', text: 'Nothing new to add — every job is already in this workbook.' }),
      ])
    );
    return;
  }

  // A job missing its VIN check or its test date is still writable, but it is
  // unticked so it takes a deliberate tap rather than slipping in.
  const chosen = new Map();

  const rows = candidates.map((job) => {
    const problems = [];
    if (!job.vinValid) problems.push('VIN not verified');
    if (!job.tests?.date) problems.push('no test date');

    const ok = problems.length === 0;
    chosen.set(job.id, ok);

    const box = el('input', { type: 'checkbox' });
    box.checked = ok;
    box.addEventListener('change', () => {
      chosen.set(job.id, box.checked);
      updateButton();
    });

    return el('tr', {}, [
      el('td', {}, [box]),
      el('td', {}, [
        el('div', { class: 'vin', style: 'font-family:ui-monospace,monospace;font-size:13px', text: job.vin }),
        problems.length
          ? el('div', { class: 'badge warn', style: 'margin-top:4px', text: problems.join(', ') })
          : null,
      ]),
      el('td', { text: job.power?.inverterW ? `${job.power.inverterW}W` : '—' }),
      el('td', { text: job.power?.batteryAh ?? '—' }),
      el('td', { text: formatDate(job.tests?.date) || '—' }),
      el('td', { text: job.ecert ?? 'N' }),
      el('td', { text: job.ccew?.certificateNo || '—' }),
    ]);
  });

  const button = el('button', { class: 'primary wide', type: 'button' });

  const updateButton = () => {
    const count = [...chosen.values()].filter(Boolean).length;
    button.textContent = count === 0
      ? 'Nothing selected'
      : `Add ${count} row${count === 1 ? '' : 's'} and download`;
    button.disabled = count === 0;
  };

  button.addEventListener('click', async () => {
    const selected = candidates.filter((job) => chosen.get(job.id));
    if (selected.length === 0) return;

    button.disabled = true;
    try {
      const out = appendRows(bytes, selected.map(jobToRow));
      downloadBlob(new Blob([out], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }), filename);

      for (const job of selected) {
        job.status = 'in-sheet';
        job.writtenAt = new Date().toISOString();
        await db.putJob(job);
      }

      await context.updateBadges();
      toast(`Added ${selected.length} row${selected.length === 1 ? '' : 's'}`);
      render();
    } catch (err) {
      console.error(err);
      toast(`Could not write the workbook: ${err.message}`, 'bad');
      button.disabled = false;
    }
  });

  updateButton();

  mount.append(
    el('div', { class: 'card' }, [
      el('h2', { text: `${candidates.length} job${candidates.length === 1 ? '' : 's'} not in the file` }),
      el('div', { class: 'scroll-x' }, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: '' }),
              el('th', { text: 'VIN' }),
              el('th', { text: 'Power' }),
              el('th', { text: 'Battery' }),
              el('th', { text: 'Date' }),
              el('th', { text: 'Ecert' }),
              el('th', { text: 'CCEW' }),
            ]),
          ]),
          el('tbody', {}, rows),
        ]),
      ]),
      el('div', { style: 'margin-top:14px' }, [button]),
      el('p', { class: 'hint', text: 'Your original file is not touched. A new copy downloads with the rows added — put that one back in the CCEW’S folder.' }),
    ])
  );
}
