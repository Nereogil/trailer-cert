// Cache-first for the app shell so the whole thing opens with no signal. The
// only network call the app makes is to Google Vision, and that must never be
// cached: a stale OCR result would be worse than an honest error.

const CACHE_VERSION = 'trailer-cert-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './src/app.js',
  './src/vin.js',
  './src/plate-parser.js',
  './src/vision.js',
  './src/coc-parser.js',
  './src/coc-pdf.js',
  './src/xlsx-read.js',
  './src/xlsx-write.js',
  './src/excel-serial.js',
  './src/zip.js',
  './src/db.js',
  './src/settings.js',
  './src/photos.js',
  './src/ui/dom.js',
  './src/ui/scan.js',
  './src/ui/jobs.js',
  './src/ui/coc.js',
  './src/ui/excel.js',
  './src/ui/settings.js',
  './vendor/fflate.mjs',
  './vendor/pdf.mjs',
  './vendor/pdf.worker.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (url.hostname.endsWith('googleapis.com')) return; // always live
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request)
        .then((response) => {
          // Keep anything else the app pulls from its own origin.
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
