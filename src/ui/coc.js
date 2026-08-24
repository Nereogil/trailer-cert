import { el, clear, toast, formatDate } from './dom.js';
import { extractPdfText } from '../coc-pdf.js';
import { parseCoc } from '../coc-parser.js';
import { normalizeVin, validateVin } from '../vin.js';
import * as db from '../db.js';

// The certificate comes back from the NSW portal as a PDF with a text layer, so
// it can be read directly rather than retyped. It carries the VIN, which is
// what lets it find its own job.

export function mountCoc(root, ctx) {
  render(root, ctx);
}

function render(root, ctx) {
  clear(root);

  const fileInput = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
  const status = el('p', { class: 'hint', text: 'Download the certificate from the portal, then pick it here.' });
  const result = el('div');

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';
    clear(result);

    status.className = 'hint working';
    status.textContent = 'Reading the certificate…';

    try {
      const text = await extractPdfText(file);
      const parsed = parseCoc(text);
      status.className = 'hint';
      status.textContent = 'Check the details before attaching.';
      await showParsed(result, parsed, file.name, text, ctx);
    } catch (err) {
      status.className = 'hint error';
      status.textContent = err.message;
    }
  });

  root.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Certificate of Compliance' }),
      el('label', { class: 'capture' }, [
        fileInput,
        el('span', { class: 'big-button', text: 'Choose the CCEW PDF' }),
      ]),
      status,
    ]),
    result
  );
}

async function showParsed(container, parsed, filename, rawText, ctx) {
  clear(container);

  const facts = el('dl', { class: 'facts' }, [
    el('dt', { text: 'Certificate' }), el('dd', { text: parsed.certificateNo ?? 'not found' }),
    el('dt', { text: 'Submitted' }), el('dd', { text: formatDate(parsed.submissionDate) || 'not found' }),
    el('dt', { text: 'Test completed' }), el('dd', { text: formatDate(parsed.testCompletedDate) || 'not found' }),
    el('dt', { text: 'VIN' }), el('dd', { class: 'vin-display', text: parsed.vin ?? 'not found' }),
    el('dt', { text: 'Installation' }), el('dd', { text: parsed.installType ?? '—' }),
  ]);

  const card = el('div', { class: 'card' }, [
    el('h2', { text: 'What the certificate says' }),
    facts,
    parsed.vin
      ? el('div', {
          class: `callout ${parsed.vinValid ? 'ok' : 'bad'}`,
          text: parsed.vinValid
            ? 'VIN check digit valid.'
            : 'The VIN on this certificate does not pass its check digit.',
        })
      : null,
  ]);

  if (parsed.equipment.length) {
    card.append(
      el('h3', { text: 'Equipment' }),
      el('div', { class: 'scroll-x' }, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Type' }),
              el('th', { text: 'Rating' }),
              el('th', { text: 'No.' }),
              el('th', { text: 'Description' }),
            ]),
          ]),
          el('tbody', {}, parsed.equipment.map((e) =>
            el('tr', {}, [
              el('td', { text: e.type }),
              el('td', { text: e.ratingA ? `${e.ratingA}A` : '—' }),
              el('td', { text: e.qty ?? '—' }),
              el('td', { text: e.description ?? '—' }),
            ])
          )),
        ]),
      ])
    );
  }

  if (parsed.testsPerformed.length) {
    card.append(
      el('h3', { text: 'Tests performed' }),
      el('ul', {}, parsed.testsPerformed.map((t) => el('li', { text: t })))
    );
  }

  card.append(
    el('details', { class: 'raw' }, [
      el('summary', { text: 'Raw text from the PDF' }),
      el('pre', { text: rawText }),
    ])
  );

  container.append(card);
  container.append(await matchCard(parsed, filename, ctx));
}

async function matchCard(parsed, filename, ctx) {
  const card = el('div', { class: 'card' });
  const jobs = await db.allJobs();

  // No VIN in the PDF: let the user say which trailer it belongs to.
  if (!parsed.vin) {
    const input = el('input', {
      type: 'text',
      class: 'mono',
      placeholder: 'Type the VIN',
      autocapitalize: 'characters',
    });

    card.append(
      el('h2', { text: 'Which trailer?' }),
      el('p', { class: 'hint', text: 'No VIN was found in the certificate.' }),
      el('label', { class: 'field' }, [el('span', { text: 'VIN' }), input]),
      el('button', {
        class: 'primary wide',
        type: 'button',
        text: 'Find the job',
        onClick: async () => {
          const vin = normalizeVin(input.value);
          if (validateVin(vin).ok === false && vin.length !== 17) {
            toast('That does not look like a complete VIN', 'bad');
            return;
          }
          const next = { ...parsed, vin, vinValid: validateVin(vin).ok };
          const replacement = await matchCard(next, filename, ctx);
          card.replaceWith(replacement);
        },
      })
    );
    return card;
  }

  const match = jobs.find((job) => job.vin === parsed.vin);

  if (!match) {
    card.append(
      el('h2', { text: 'No matching job' }),
      el('p', { class: 'hint', text: `Nothing recorded under ${parsed.vin} yet.` }),
      el('button', {
        class: 'primary wide',
        type: 'button',
        text: 'Create a job from this certificate',
        onClick: async () => {
          const job = db.emptyJob();
          applyCertificate(job, parsed, filename);
          job.vinSource = 'coc';
          await db.putJob(job);
          await ctx.updateBadges();
          toast('Job created from the certificate');
          ctx.showTab('jobs');
        },
      })
    );
    return card;
  }

  const alreadyDifferent =
    match.ccew?.certificateNo && match.ccew.certificateNo !== parsed.certificateNo;

  card.append(
    el('h2', { text: 'Matching job found' }),
    el('div', { class: 'callout ok' }, [
      el('div', { class: 'vin-display', text: match.vin }),
      match.tests?.date ? el('div', { text: `Tested ${formatDate(match.tests.date)}` }) : null,
    ]),
    alreadyDifferent
      ? el('div', { class: 'callout warn' }, [
          el('div', { text: `This job already carries certificate ${match.ccew.certificateNo}.` }),
          el('div', { text: `Attaching will replace it with ${parsed.certificateNo}.` }),
        ])
      : null,
    el('button', {
      class: 'primary wide',
      type: 'button',
      text: alreadyDifferent ? 'Replace the certificate' : 'Attach certificate',
      onClick: async () => {
        if (alreadyDifferent && !confirm(`Replace certificate ${match.ccew.certificateNo} with ${parsed.certificateNo}?`)) {
          return;
        }
        applyCertificate(match, parsed, filename);
        await db.putJob(match);
        await ctx.updateBadges();
        toast('Certificate attached');
        ctx.showTab('jobs');
      },
    })
  );

  return card;
}

function applyCertificate(job, parsed, filename) {
  job.vin = parsed.vin ?? job.vin;
  job.vinValid = job.vin ? validateVin(job.vin).ok : false;

  job.ccew = {
    certificateNo: parsed.certificateNo ?? '',
    submissionDate: parsed.submissionDate ?? '',
    testCompletedDate: parsed.testCompletedDate ?? '',
    sourceFile: filename,
  };

  if (parsed.equipment.length) job.equipment = parsed.equipment;
  if (parsed.testsPerformed.length) job.tests.performed = parsed.testsPerformed;
  if (parsed.installType) job.installType = parsed.installType;

  // The certificate's test date is authoritative; adopt it when the job has
  // none, and leave a date the user typed alone.
  if (!job.tests.date && parsed.testCompletedDate) {
    job.tests.date = parsed.testCompletedDate;
  }

  job.ecert = 'Y';
  job.status = 'submitted';
}
