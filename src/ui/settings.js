import { el, clear, field, textInput, toast, debounce } from './dom.js';
import * as settings from '../settings.js';
import * as db from '../db.js';
import { formatBytes, downloadBlob } from '../photos.js';
import { buildBackup, backupFilename } from '../backup.js';
import * as supabase from '../supabase.js';
import { syncJobs, syncPhotos } from '../sync.js';
import { jobsRemote, photosRemote } from '../remote.js';

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

  // --- Account and sync ---
  //
  // Deliberately a card in Setup and not a gate in front of the app. Signing in
  // adds the server; it does not become a condition of working. A phone in a
  // yard with no signal, or one whose session has lapsed, still scans plates and
  // records tests exactly as before.

  const accountCard = el('div', { class: 'card' });

  const renderAccount = () => {
    clear(accountCard);
    accountCard.append(el('h2', { text: 'Account' }));

    if (!supabase.isSignedIn()) {
      const email = el('input', { type: 'email', autocomplete: 'username', placeholder: 'you@example.com', spellcheck: 'false' });
      // autocomplete set so the password manager fills this. The password is
      // typed here and goes straight to Supabase; nothing else ever holds it.
      const password = el('input', { type: 'password', autocomplete: 'current-password' });
      const status = el('p', { class: 'hint', text: 'Sign in to keep jobs on the server and on both devices.' });
      const button = el('button', { class: 'primary wide', type: 'button', text: 'Sign in' });

      const attempt = async () => {
        if (!email.value.trim() || !password.value) {
          status.className = 'hint error';
          status.textContent = 'Email and password, please.';
          return;
        }
        button.disabled = true;
        status.className = 'hint working';
        status.textContent = 'Signing in…';
        try {
          await supabase.signIn(email.value.trim(), password.value);
          toast('Signed in');
          renderAccount();
        } catch (err) {
          status.className = 'hint error';
          status.textContent = err.message;
          button.disabled = false;
        }
      };

      button.addEventListener('click', attempt);
      password.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });

      accountCard.append(field('Email', email), field('Password', password), button, status);
      return;
    }

    const status = el('p', { class: 'hint', text: 'Signed in. Jobs sync when you tap below.' });
    const syncButton = el('button', { class: 'primary wide', type: 'button', text: 'Sync now' });

    syncButton.addEventListener('click', async () => {
      syncButton.disabled = true;
      status.className = 'hint working';
      status.textContent = 'Syncing…';
      try {
        const jobs = await syncJobs(jobsRemote);

        // Photos are the slow half - megabytes rather than kilobytes - so the
        // line changes before they start. A button that sits still for a minute
        // reads as broken.
        status.textContent = 'Syncing photos…';
        const photos = await syncPhotos(photosRemote);

        status.className = 'hint';
        const held = jobs.pushed.deferred ? `, ${jobs.pushed.deferred} held over` : '';
        const trouble = photos.pushed.failed
          ? ` ${photos.pushed.failed} photo${photos.pushed.failed === 1 ? '' : 's'} would not upload — they stay queued.`
          : '';

        status.textContent =
          `Jobs: sent ${jobs.pushed.sent}, received ${jobs.pulled.applied}${held}. ` +
          `Photos: sent ${photos.pushed.sent}, received ${photos.pulled.applied}.${trouble}`;

        if (photos.pushed.failed) status.className = 'hint error';
        await updateBadges?.();
        toast('Synced');
      } catch (err) {
        console.error('Sync failed', err);
        status.className = 'hint error';
        // A failed sync is "not now", never "the row is gone". Nothing local
        // has been touched, so saying so plainly matters.
        status.textContent = `${err.message} Nothing was lost — your jobs are still on this device.`;
      } finally {
        syncButton.disabled = false;
      }
    });

    accountCard.append(
      el('div', { class: 'callout ok', text: `Signed in as ${supabase.currentEmail() ?? 'this account'}.` }),
      syncButton,
      status,
      el('div', { class: 'row end', style: 'margin-top:10px' }, [
        el('button', {
          class: 'small',
          type: 'button',
          text: 'Sign out',
          onClick: async () => {
            await supabase.signOut();
            toast('Signed out');
            renderAccount();
          },
        }),
      ])
    );
  };

  renderAccount();
  root.append(accountCard);

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

  // --- Backup ---

  const backupNote = el('p', {
    class: 'hint',
    text: 'One zip holding every job, every photo and your setup details.',
  });

  const backupButton = el('button', {
    class: 'primary wide',
    type: 'button',
    text: 'Export everything',
  });

  backupButton.addEventListener('click', async () => {
    backupButton.disabled = true;
    backupNote.className = 'hint working';
    backupNote.textContent = 'Building the backup…';

    // Zipping is synchronous and holds the thread for a few seconds on a phone
    // with a lot of photos, so yield first and let the line above paint.
    // Deliberately setTimeout and not requestAnimationFrame: rAF does not fire
    // while the page is not painting, so a screen that locks mid-export would
    // leave this waiting forever with the button stuck disabled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const { bytes, jobCount, photoCount, madeAt } = await buildBackup();
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), backupFilename(madeAt));

      backupNote.className = 'hint';
      backupNote.textContent =
        `${jobCount} job${jobCount === 1 ? '' : 's'} and ${photoCount} photo${photoCount === 1 ? '' : 's'} — ${formatBytes(bytes.length)}.`;
      toast('Backup downloaded');
    } catch (err) {
      console.error('Could not build the backup', err);
      backupNote.className = 'hint error';
      backupNote.textContent = `Could not build the backup: ${err.message}`;
      toast('Backup failed', 'bad');
    } finally {
      backupButton.disabled = false;
    }
  });

  root.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Backup' }),
      el('p', {
        class: 'hint',
        text: 'Everything is held in this browser. Take a copy off the phone regularly — a cleared browser or a lost phone takes the jobs with it.',
      }),
      backupButton,
      backupNote,
    ])
  );

  // --- Storage ---

  const storageLine = el('p', { class: 'hint', text: 'Checking storage…' });

  root.append(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Storage' }),
      storageLine,
      el('p', { class: 'hint', text: 'Jobs and photos live in this browser on this phone. Export everything above to keep a copy elsewhere.' }),
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
