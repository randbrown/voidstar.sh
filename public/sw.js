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
//     fails cleanly as a script error instead of a text/html-typed module load
//     failure. For a hashed `/_astro/*` file, a non-ok response also triggers a
//     one-shot cache-busting retry that self-heals a poisoned edge cache (see
//     `retryOnce`) — so a pinned cross-deploy 404 no longer needs a manual purge.
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
//     whose body is HTML) is never handed back to a module/style request — that
//     surfaced as "Failed to load module script: … MIME type of text/html".
// v10: self-heal a poisoned edge cache. A transient cross-deploy 404 for a
//     hashed `/_astro/*` file can get pinned in Cloudflare's CDN under the
//     `immutable, max-age=1y` header, so the canonical URL keeps serving that
//     404 to everyone until a manual purge. On a non-ok `/_astro/*` response we
//     now retry once with a cache-busting query — a fresh edge key that dodges
//     the poisoned entry and fetches the real bytes — and cache the result
//     under the canonical key so later loads never need the retry.
// v11: purge poisoned caches after the unstyled-prod incident. `/_astro/*.css`
//     is served cache-first (immutable), so a bad cached stylesheet — or a
//     stale cache left behind when an app-shell change didn't touch this file —
//     serves a broken/unstyled page indefinitely without revalidating. Bumping
//     the version re-triggers install → activate → purge-old-caches →
//     clients.claim() on every client's next load, clearing the poisoned cache.
//     (Paired with build.inlineStylesheets:'always', which stops CSS from being
//     a separately-fetched asset that can fail on its own in the first place.)
//     Bump this on any deploy that changes the app shell.
// v12: add mind reminder notifications. `notificationclick` deep-links into the
//     mind task (`/lab/mind#task/<id>`), focusing an existing tab if one is open
//     and otherwise opening a new window; Done/Snooze action buttons post a
//     message back to the client so it can update the task. (App-shell change →
//     version bumped per the rule above.)
// Bumping the version also purges the old cache on every client so no one stays
// pinned to a stale app-shell.
const SW_VERSION = 'v12';
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

// ── mind reminder notifications ──
// A tapped reminder deep-links into its task; a tapped Done/Snooze action posts
// a message to an open mind client (which updates the task) and, for the plain
// tap, focuses/opens the mind window at the task's hash. Notification `data`
// carries `{ taskId, listId, url }` (set in src/lib/mind/reminders.js).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/lab/mind';
  const action = event.action; // 'done' | 'snooze' | '' (body tap)

  event.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mindClient = clientsArr.find((c) => c.url.includes('/lab/mind'));

    if (action === 'done' || action === 'snooze') {
      // Let an open client mutate the task; if none is open, open the task so
      // the user can act manually (the action is best-effort).
      if (mindClient) {
        mindClient.postMessage({ type: 'mind-reminder-action', action, taskId: data.taskId });
        return mindClient.focus();
      }
      return self.clients.openWindow(url);
    }

    // Plain tap → focus an existing mind tab and navigate it, else open one.
    if (mindClient) {
      try { await mindClient.focus(); } catch {}
      if ('navigate' in mindClient) { try { return await mindClient.navigate(url); } catch {} }
      mindClient.postMessage({ type: 'mind-navigate', url });
      return;
    }
    return self.clients.openWindow(url);
  })());
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
  //     prod error. For a content-hashed `/_astro/*` file, a non-ok response is
  //     almost always a poisoned edge cache (a transient cross-deploy 404 pinned
  //     under the `immutable` header), so we retry once with a cache-busting
  //     query (`retryOnce` below) before giving up. For anything else, treat a
  //     non-ok response as a failure: prefer any cached copy, else fail cleanly
  //     so the load errors as a script error (recoverable with a reload) rather
  //     than a bogus HTML document.
  const immutable = url.pathname.startsWith('/_astro/');

  // Persist a good response under the ORIGINAL request key (no cache-buster) so
  // later loads are served from the SW cache and never need the retry again.
  const store = (res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    return res;
  };

  // A hashed /_astro/* file is immutable, so a cache-busting query returns the
  // identical bytes from a fresh edge key — this is what dodges a poisoned 404.
  const retryOnce = (cached) => {
    if (!immutable) return cached || Response.error();
    const bust = new URL(req.url);
    bust.searchParams.set('swcb', Date.now().toString(36));
    return fetch(bust.href, { cache: 'reload' })
      .then((r2) => (r2 && r2.ok ? store(r2) : (cached || Response.error())))
      .catch(() => cached || Response.error());
  };

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached && immutable) return cached;
      const fetchPromise = fetch(req)
        .then((res) => (res && res.ok ? store(res) : retryOnce(cached)))
        .catch(() => cached || Response.error());
      return cached || fetchPromise;
    })
  );
});
