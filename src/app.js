import { toast } from './ui/dom.js';
import * as db from './db.js';
import * as settings from './settings.js';

import { mountScan } from './ui/scan.js';
import { mountJobs, refreshJobs } from './ui/jobs.js';
import { mountCoc } from './ui/coc.js';
import { mountExcel, refreshExcel } from './ui/excel.js';
import { mountSettings } from './ui/settings.js';

const TABS = {
  scan: { title: 'Scan', mount: mountScan },
  jobs: { title: 'Jobs', mount: mountJobs, refresh: refreshJobs },
  coc: { title: 'CCEW certificate', mount: mountCoc },
  excel: { title: 'Spreadsheet', mount: mountExcel, refresh: refreshExcel },
  settings: { title: 'Setup', mount: mountSettings },
};

const LAST_TAB_KEY = 'trailer-cert:last-tab';
const mounted = new Set();

export function showTab(name) {
  const tab = TABS[name];
  if (!tab) return;

  for (const key of Object.keys(TABS)) {
    document.getElementById(`tab-${key}`).hidden = key !== name;
    document.getElementById(`tabbtn-${key}`).setAttribute('aria-selected', String(key === name));
  }

  document.getElementById('page-title').textContent = tab.title;
  localStorage.setItem(LAST_TAB_KEY, name);

  const root = document.getElementById(`tab-${name}`);
  if (!mounted.has(name)) {
    mounted.add(name);
    // Mount lazily so a tab the user never opens costs nothing, and so a
    // failure in one screen cannot stop the rest of the app from working.
    Promise.resolve(tab.mount(root, { showTab, updateBadges })).catch((err) => {
      console.error(`Failed to mount the ${name} tab`, err);
      toast(`Could not open ${tab.title}: ${err.message}`, 'bad');
    });
  } else if (tab.refresh) {
    Promise.resolve(tab.refresh()).catch((err) => console.error(err));
  }
}

// The tab bar carries two counts: jobs not yet written to the spreadsheet, and
// a warning pip on Setup until the Vision key is in place.
export async function updateBadges() {
  try {
    const jobs = await db.allJobs();
    const pending = jobs.filter((job) => job.status !== 'in-sheet').length;

    const excelPip = document.getElementById('excel-pip');
    excelPip.textContent = String(pending);
    excelPip.hidden = pending === 0;

    const jobsPip = document.getElementById('jobs-pip');
    jobsPip.textContent = String(jobs.length);
    jobsPip.hidden = jobs.length === 0;

    const settingsPip = document.getElementById('settings-pip');
    settingsPip.textContent = '!';
    settingsPip.hidden = settings.hasApiKey();
  } catch (err) {
    console.error('Could not update the tab counts', err);
  }
}

function boot() {
  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }

  const remembered = localStorage.getItem(LAST_TAB_KEY);
  showTab(TABS[remembered] ? remembered : 'scan');

  updateBadges();
  db.requestPersistence().catch(() => {});

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker did not register; the app will still work online.', err);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
