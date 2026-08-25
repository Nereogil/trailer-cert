// The app shell is precached so the whole thing opens with no signal, and
// served stale-while-revalidate: the cached copy answers immediately, and a
// fresh copy is fetched in the background for next time.
//
// The first version of this was plain cache-first, which meant an installed
// phone kept serving the same code forever - a fix could be deployed and never
// arrive. Stale-while-revalidate keeps the instant, offline-capable open while
// letting updates land on their own, one launch behind.
//
// The only outbound call the app makes is to Google Vision, and that must never
// be cached: a stale OCR result would be worse than an honest error.

const CACHE_VERSION = 'trailer-cert-v4';

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
  './src/tester-parser.js',
  './src/vision-geometry.js',
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
    caches.open(CACHE_VERSION).then(async (cache) => {
      const hit = await cache.match(event.request);

      // Refresh in the background whether or not the cache had an answer, so a
      // deployed fix reaches an installed phone without anyone reinstalling.
      const fresh = fetch(event.request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      if (hit) {
        event.waitUntil(fresh);
        return hit;
      }

      const response = await fresh;
      return response ?? (await cache.match('./index.html')) ?? Response.error();
    })
  );
});
