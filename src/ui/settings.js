import { el, clear, field, textInput, toast, debounce } from './dom.js';
import * as settings from '../settings.js';
import * as db from '../db.js';
import { formatBytes } from '../photos.js';

// Everything identifying — licence number, customer details, the API key —
// is typed in here and stays on this phone. None of it is in the repo.

export function mountSettings(root, { updateBadges }) {
  render(root, updateBadges);
}

function render(root, updateBadges) {
  const config = settings.get();
  clear(root);

  const save = debounce((patch) => {
    settings.set(patch);
    updateBadges?.();
    toast('Saved');
  }, 500);

  // --- Vision API key ---

  const keyInput = el('input', {
    type: 'password',
    value: config.visionApiKey,
    placeholder: 'AIza…',
    autocomplete: 'off',
    spellcheck: 'false',
    onInput: (e) => save({ visionApiKey: e.target.value.trim() }),
  });

  const revealButton = el('button', {
    class: 'small',
    type: 'button',
    text: 'Show',
    onClick: () => {
      const hidden = keyInput.type === 'password';
      keyInput.type = hidden ? 'text' : 'password';
      revealButton.textContent = hidden ? 'Hide' : 'Show';
    },
  });

  root.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Google Vision API key' }),
      config.visionApiKey
        ? el('div', { class: 'callout ok', text: 'Key set. Plate scanning is available.' })
        : el('div', {
            class: 'callout warn',
            text: 'No key yet. You can still enter plates by hand; scanning needs a key.',
          }),
      field('API key', keyInput),
      el('div', { class: 'row' }, [revealButton, el('span', { class: 'spacer' })]),
      el('details', { class: 'raw' }, [
        el('summary', { text: 'How to get a key' }),
        el('pre', {
          text: [
            '1. console.cloud.google.com  ->  create a project',
            '2. APIs & Services -> Library -> "Cloud Vision API" -> Enable',
            '3. APIs & Services -> Credentials -> Create credentials -> API key',
            '4. Edit the key -> API restrictions -> Restrict to Cloud Vision API',
            '5. Paste it above',
            '',
            'Billing must be on, but the first 1,000 images each month are free.',
            'At roughly 30 trailers a month you will not be charged.',
          ].join('\n'),
        }),
      ]),
    ])
  );

  // --- Electrician ---

  root.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Electrician' }),
      el('p', { class: 'hint', text: 'Copied onto each job so it is to hand when filling the CCEW.' }),
      field('Name', textInput(config.electrician.name, {
        onInput: (e) => save({ electrician: { ...settings.get().electrician, name: e.target.value } }),
      })),
      el('div', { class: 'grid-2' }, [
        field('Licence number', textInput(config.electrician.licence, {
          onInput: (e) => save({ electrician: { ...settings.get().electrician, licence: e.target.value } }),
        })),
        field('Contact phone', textInput(config.electrician.phone, {
          inputmode: 'tel',
          onInput: (e) => save({ electrician: { ...settings.get().electrician, phone: e.target.value } }),
        })),
      ]),
    ])
  );

  // --- Customer ---

  root.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Customer and site' }),
      field('Customer name', textInput(config.customer.name, {
        onInput: (e) => save({ customer: { ...settings.get().customer, name: e.target.value } }),
      })),
      field('Company', textInput(config.customer.company, {
        onInput: (e) => save({ customer: { ...settings.get().customer, company: e.target.value } }),
      })),
      field('Email', el('input', {
        type: 'email',
        value: config.customer.email,
        autocomplete: 'off',
        onInput: (e) => save({ customer: { ...settings.get().customer, email: e.target.value } }),
      })),
      field('Installation site address', el('textarea', {
        onInput: (e) => save({ customer: { ...settings.get().customer, siteAddress: e.target.value } }),
      }, config.customer.siteAddress)),
      field('Default installation type', textInput(config.defaultInstallType, {
        onInput: (e) => save({ defaultInstallType: e.target.value }),
      })),
    ])
  );

  // --- Description presets ---

  const presetList = el('div');

  const renderPresets = () => {
    clear(presetList);
    const current = settings.get().descriptionPresets;

    current.forEach((preset, index) => {
      presetList.append(
        el('div', { class: 'card', style: 'padding:10px;margin-bottom:8px' }, [
          el('textarea', {
            onChange: (e) => {
              const next = [...settings.get().descriptionPresets];
              next[index] = e.target.value;
              settings.set({ descriptionPresets: next });
              toast('Saved');
            },
          }, preset),
          el('div', { class: 'row end' }, [
            el('button', {
              class: 'small danger',
              type: 'button',
              text: 'Remove',
              onClick: () => {
                const next = settings.get().descriptionPresets.filter((_, i) => i !== index);
                settings.set({ descriptionPresets: next });
                renderPresets();
                toast('Removed');
              },
            }),
          ]),
        ])
      );
    });

    presetList.append(
      el('button', {
        class: 'wide',
        type: 'button',
        text: 'Add a description',
        onClick: () => {
          settings.set({ descriptionPresets: [...settings.get().descriptionPresets, ''] });
          renderPresets();
        },
      })
    );
  };

  renderPresets();

  root.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Install descriptions' }),
      el('p', { class: 'hint', text: 'Pick these on a job instead of retyping them.' }),
      presetList,
    ])
  );

  // --- Storage ---

  const storageLine = el('p', { class: 'hint', text: 'Checking storage…' });

  root.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Storage' }),
      storageLine,
      el('p', { class: 'hint', text: 'Jobs and photos live in this browser on this phone. Export the spreadsheet and the photos to keep a copy elsewhere.' }),
    ])
  );

  Promise.all([db.estimateUsage(), db.allPhotos()])
    .then(([usage, photos]) => {
      const photoBytes = photos.reduce((sum, p) => sum + (p.bytes ?? 0), 0);
      storageLine.textContent = usage
        ? `${photos.length} photos, ${formatBytes(photoBytes)} — ${formatBytes(usage.usage)} of ${formatBytes(usage.quota)} used by this app.`
        : `${photos.length} photos, ${formatBytes(photoBytes)}.`;
    })
    .catch(() => {
      storageLine.textContent = 'Could not read the storage figures.';
    });
}
