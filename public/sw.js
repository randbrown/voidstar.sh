// voidstar service worker — minimal app-shell cache for standalone PWA mode.
//
// Strategy:
//   - HTML pages: network-first with cache fallback. Users see fresh content
//     on every visit when online; offline they get the last-seen version of
//     the page they're loading (or the homepage as ultimate fallback).
//   - Same-origin static assets (JS, CSS, images, manifest, icons): stale-
//     while-revalidate. The cache returns instantly; a background fetch
//     freshens it for next load. Astro hashes its `_astro/*.js` filenames,
//     so cache hits are always content-correct.
//   - Cross-origin requests (Strudel CDN, MediaPipe models, fonts.gstatic):
//     pass through completely — let the browser HTTP cache handle them.
//     Caching opaque cross-origin responses fills storage with junk and
//     can break responses we don't control the headers for.
//
// Versioning: the CACHE name carries a SW_VERSION constant. Bumping it
// (or just shipping a different SW body) triggers install + activate +
// purge-old-caches on the next page load. clients.claim() makes the new
// SW take over immediately so users don't need a hard reload.

const SW_VERSION = 'v2';
const CACHE      = `voidstar-${SW_VERSION}`;

// Things we want available immediately on first install — the app shell.
// Hashed JS chunks aren't listed; they get picked up by stale-while-
// revalidate as the page references them.
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/manifest-qualia.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
  // Don't sit in the "waiting" state — take over right after install so
  // first-deploy users get the new SW without a manual refresh.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin requests; cross-origin gets the browser's
  // default network behaviour (no caching here, no proxying).
  if (url.origin !== self.location.origin) return;

  // HTML pages → network-first with cache fallback.
  const accept = req.headers.get('accept') || '';
  const isHtml = req.mode === 'navigate' || accept.includes('text/html');
  if (isHtml) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((c) => c || caches.match('/'))
        )
    );
    return;
  }

  // Everything else (assets) → stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
