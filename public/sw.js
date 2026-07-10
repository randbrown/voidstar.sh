// voidstar service worker — minimal app-shell cache for standalone PWA mode.
//
// Strategy:
//   - HTML pages: network-first with cache fallback. Users see fresh content
//     on every visit when online; offline they get the last-seen version of
//     the page they're loading (or the homepage as ultimate fallback).
//   - Same-origin static assets (JS, CSS, images, manifest, icons): stale-
//     while-revalidate — except content-hashed `/_astro/*` files, which are
//     immutable and served cache-first with no revalidation fetch. Only
//     `res.ok` responses are ever cached. A miss + network failure OR a non-ok
//     response (404/redirect — whose body is HTML) answers with a cached copy
//     or `Response.error()`, never the HTML body, so a subresource request
//     fails cleanly as a script error (which the page can recover from with a
//     one-shot reload) instead of a text/html-typed module load failure.
//   - Cross-origin requests (Strudel CDN, MediaPipe models, fonts.gstatic):
//     pass through completely — let the browser HTTP cache handle them.
//     Caching opaque cross-origin responses fills storage with junk and
//     can break responses we don't control the headers for.
//
// Versioning: the CACHE name carries a SW_VERSION constant. Bumping it
// (or just shipping a different SW body) triggers install + activate +
// purge-old-caches on the next page load. clients.claim() makes the new
// SW take over immediately so users don't need a hard reload.

// v9: harden the asset path so a non-ok subresource response (a 404/redirect
// whose body is HTML) is never handed back to a module/style request — that
// surfaced as "Failed to load module script: … MIME type of text/html" after a
// deploy. Bumping the version also purges the old cache on every client so no
// one stays pinned to a stale app-shell.
const SW_VERSION = 'v9';
const CACHE      = `voidstar-${SW_VERSION}`;

// Things we want available immediately on first install — the app shell.
// Hashed JS chunks aren't listed; they get picked up by stale-while-
// revalidate as the page references them.
const PRECACHE = [
  '/',
  '/lab/setlist',
  '/lab/mind',
  '/manifest.webmanifest',
  '/manifest-qualia.webmanifest',
  '/manifest-setlist.webmanifest',
  '/manifest-mind.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Cache precache entries individually rather than via cache.addAll(),
    // which is atomic — a single 404/redirect (e.g. a route path that a host
    // serves only with a trailing slash) would otherwise reject the whole
    // install and leave users with no SW at all. Per-item with catch means a
    // stray miss just skips that one entry.
    caches.open(CACHE).then((cache) =>
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})))
    )
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
          // Only cache good responses — a transient 5xx/404 must not
          // poison the offline fallback for this route.
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((c) => c || caches.match('/'))
        )
    );
    return;
  }

  // Everything else (assets). Astro content-hashes /_astro/* filenames, so
  // a cache hit there is immutable — serve it without a revalidation fetch.
  // Other assets (manifest, icons, sw-adjacent files) stay stale-while-
  // revalidate.
  //
  // Two failure modes must never reach the page as content:
  //   - network failure (offline / DNS): the .catch below answers with a
  //     cached copy or an explicit network-error Response, not `undefined`
  //     (which would reject respondWith and log a TypeError on the failed load).
  //   - a NON-OK response (404/redirect): on Cloudflare Pages a 404 body is the
  //     site's HTML error page. Handing that back for a `/_astro/*.js` request
  //     makes the browser reject the module with "expected a JavaScript module
  //     but the server responded with a MIME type of text/html" — the reported
  //     prod error, seen when a client requests a hashed chunk the edge is
  //     momentarily 404ing (deploy propagation) or an old SW mis-serves. Treat
  //     a non-ok subresource response the same as a failure: prefer any cached
  //     copy, else fail cleanly so the load errors as a script error (which the
  //     page can recover from with a reload) rather than a bogus HTML document.
  const immutable = url.pathname.startsWith('/_astro/');
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached && immutable) return cached;
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          }
          return cached || Response.error();
        })
        .catch(() => cached || Response.error());
      return cached || fetchPromise;
    })
  );
});
