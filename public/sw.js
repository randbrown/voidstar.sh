// voidstar service worker — minimal app-shell cache for standalone PWA mode.
//
// Strategy:
//   - HTML pages: network-first with cache fallback. Users see fresh content
//     on every visit when online; offline they get the last-seen version of
//     the page they're loading (or the homepage as ultimate fallback).
//   - Web app manifests (`*.webmanifest`): network-first with cache fallback,
//     same as HTML. The browser re-reads the manifest for PWA install/update
//     checks; a stale-while-revalidate copy could hand those checks an
//     out-of-date app identity (old icons/id) right after a deploy, making
//     Chrome rewrite the installed app's OS shortcuts — which broke Windows
//     taskbar pins for mind after the per-app manifest split.
//   - Same-origin static assets (JS, CSS, images, icons): stale-
//     while-revalidate — except content-hashed `/_astro/*` files, which are
//     immutable and served cache-first with no revalidation fetch. Only
//     `res.ok` responses are ever cached. A miss + network failure OR a non-ok
//     response (404/redirect — whose body is HTML) answers with a cached copy
//     or `Response.error()`, never the HTML body, so a subresource request
//     fails cleanly as a script error instead of a text/html-typed module load
//     failure. For a hashed `/_astro/*` file, a non-ok response also triggers a
//     one-shot cache-busting retry that self-heals a poisoned edge cache (see
//     `retryOnce`) — so a pinned cross-deploy 404 no longer needs a manual purge.
//   - Cross-origin requests: an ALLOWLIST (see `runtimePolicy`) is cached so
//     qualia runs offline the way the Strudel REPL PWA does: anything played
//     while online (Strudel bundle, sample maps, samples, soundfonts, MediaPipe
//     models, fonts) keeps working offline; only never-fetched things fail.
//     These live in long-lived runtime caches that a SW version bump does NOT
//     purge. Only CORS (non-opaque) `ok` responses are stored — a no-cors
//     request (a <script>/<link> tag) is re-issued as CORS to an allowlisted
//     host, which all serve CORS. Everything else cross-origin (Google APIs,
//     Drive, Spotify, the entangle relay, …) passes through untouched.
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
// v13: serve `*.webmanifest` network-first (was stale-while-revalidate). The
//     manifest is the app's identity for PWA install/update checks; serving a
//     stale copy right after a manifest-changing deploy makes the browser see
//     flip-flopping icons/id and rewrite the installed app's OS shortcuts,
//     which orphaned Windows taskbar pins for mind. Fresh-first means those
//     checks always read the deployed identity; the cached copy remains as an
//     offline fallback. (App-shell change → version bumped per the rule above.)
// v14: precache the tether remote's app shell (/lab/tether + its manifest and
//     icons). Tether was installable but had no precache entry, so a
//     first-launch on flaky venue wifi could open to a network error instead
//     of the cached remote. (App-shell change → version bumped per the rule.)
// Bumping the version also purges the old cache on every client so no one stays
// pinned to a stale app-shell.
// v15: catch-up bump. The OBS capture-mode work (#219, #220, #221) changed the
//     app shell — `src/pages/qualia.astro` gained the obs menu item, the obs…
//     dialog and its styles — across three deploys without touching this file,
//     so the "bump on any app-shell change" rule above was missed each time.
//     That left every client pinned to the v14 cache with no install → activate
//     → purge-old-caches → clients.claim() cycle to clear a poisoned entry, and
//     prod surfaced the familiar "Failed to load module script: … MIME type of
//     text/html" for a hashed `/_astro/*` script. Bumping re-triggers that cycle
//     on every client's next load. NOTE: this only heals clients the SW actually
//     controls — a page served over http:// has no service worker at all
//     (secure-context only), and a 404 pinned in Cloudflare's edge cache under
//     the `immutable, max-age=1y` header still needs a dashboard purge.
// v16: app icons are identity, not assets. The per-app icon redesigns (#237,
//     #239) shipped without touching this file, so every client stayed pinned
//     to the v15 cache's OLD icon bytes — and stale-while-revalidate couldn't
//     self-heal, because its revalidation `fetch(req)` reads the browser HTTP
//     cache (icons carry a 1h edge default), which kept re-storing the stale
//     bytes; even a fresh PWA reinstall re-read them. Three changes: `/icon-*`
//     now rides the manifest's network-first branch (the v13 rationale applies
//     verbatim — install/update checks must read the deployed identity);
//     precache requests use `cache: 'reload'` so a new SW version can never
//     re-precache stale HTTP-cache bytes; and the version bump purges v15 on
//     every client's next load.
// v17: offline-first boot on "lie-fi". On a plane / captive-portal wifi the
//     device reports online but requests hang rather than fail, so the
//     network-first navigation sat on fetch() until the browser's connect
//     timeout (tens of seconds to minutes) before falling back — an installed
//     setlist app looked frozen at launch. HTML navigations now race the
//     network against NAV_TIMEOUT_MS: if a cached copy exists and the network
//     hasn't answered by then, the cached shell is served and the network
//     response (if it ever lands) still refreshes the cache for next time.
//     With no cached copy we keep waiting on the network as before.
//     /qualia joins the precache so its shell survives a first offline launch.
// v18: offline Strudel, like the Strudel REPL PWA. Cross-origin runtime
//     caching for an allowlist (`runtimePolicy`): the pinned @strudel/repl
//     bundle, hydra, sample maps + samples (GitHub raw, freesound, shabda),
//     soundfonts, MediaPipe wasm/models and Google Fonts. Samples go in a
//     MEDIA cache and code/models/fonts in a CDN cache; both survive SW
//     version bumps (only the shell cache is versioned), so a deploy no longer
//     throws away the samples a set depends on. voidstar's own /samples/ moved
//     into the media cache for the same reason.
const SW_VERSION = 'v18';
const CACHE      = `voidstar-${SW_VERSION}`;

// Runtime caches — deliberately NOT versioned (see v18). Names must not start
// with `voidstar-v`: StyleGuard's self-heal only clears versioned shell caches.
const CDN_CACHE   = 'voidstar-cdn-1';    // code, wasm, models, fonts
const MEDIA_CACHE = 'voidstar-media-1';  // samples, sample maps, soundfonts
const KEEP_CACHES = new Set([CACHE, CDN_CACHE, MEDIA_CACHE]);
// Media is LRU-trimmed to this many entries (a hit is re-put, moving it to the
// back of the key order). Dirt-Samples one-shots are ~10–100 KB each.
const MEDIA_MAX_ENTRIES = 4000;

// How long a page navigation waits on the network before serving the cached
// shell instead (v17). Short enough that a hung connection feels like a normal
// launch; long enough that a slow-but-working connection still gets fresh HTML.
const NAV_TIMEOUT_MS = 3000;

// Things we want available immediately on first install — the app shell.
// Hashed JS chunks aren't listed; they get picked up by stale-while-
// revalidate as the page references them.
const PRECACHE = [
  '/',
  '/qualia',
  '/lab/setlist',
  '/lab/mind',
  '/lab/tether',
  '/manifest.webmanifest',
  '/manifest-qualia.webmanifest',
  '/manifest-setlist.webmanifest',
  '/manifest-mind.webmanifest',
  '/manifest-tether.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/icon-tether-192.png',
  '/icon-tether-512.png',
  '/icon-tether-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Cache precache entries individually rather than via cache.addAll(),
    // which is atomic — a single 404/redirect (e.g. a route path that a host
    // serves only with a trailing slash) would otherwise reject the whole
    // install and leave users with no SW at all. Per-item with catch means a
    // stray miss just skips that one entry. `cache: 'reload'` bypasses the
    // browser HTTP cache: a version bump exists to pick up CHANGED shell
    // files, and plain cache.add() could re-precache the very stale bytes
    // the bump is trying to flush (the v16 icon incident).
    caches.open(CACHE).then((cache) =>
      Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})))
    )
  );
  // Don't sit in the "waiting" state — take over right after install so
  // first-deploy users get the new SW without a manual refresh.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KEEP_CACHES.has(k)).map((k) => caches.delete(k)))
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

// Network-first with a deadline: answer with the network if it lands within
// NAV_TIMEOUT_MS, else with `fallback()` (a cached copy) if there is one. A
// network error answers with the fallback or Response.error(). A late network
// response is still returned to the caller of `network` (which caches it).
function networkFirstWithDeadline(network, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (res) => { if (!settled && res) { settled = true; resolve(res); } };
    const timer = setTimeout(() => { fallback().then(done, () => {}); }, NAV_TIMEOUT_MS);
    network
      .then((res) => { clearTimeout(timer); done(res); })
      .catch(() => {
        clearTimeout(timer);
        fallback().then((c) => done(c || Response.error()), () => done(Response.error()));
      });
  });
}

// ── cross-origin runtime caching (v18) ──
const AUDIO_EXT = /\.(wav|mp3|ogg|flac|m4a|aac|opus|aiff?)$/i;
// Sample hosts Strudel's prebake / samples() / soundfonts / speech use.
const SAMPLE_HOSTS = new Set([
  'raw.githubusercontent.com',  // dough-samples, Dirt-Samples, uzu-drumkit, github: packs
  'felixroos.github.io',        // webaudiofontdata soundfonts (gm_* sounds)
  'cdn.freesound.org',
  'shabda.ndre.gr',             // shabda speech/sample TTS
]);
const CODE_CDNS = new Set(['unpkg.com', 'cdn.jsdelivr.net', 'esm.sh']);
// `pkg@1.2.3` in the path = an exact pinned version, immutable by contract.
const PINNED = /@\d+\.\d+\.\d+/;

// → { cache, mode: 'cache-first' | 'network-first' } or null (pass through).
function runtimePolicy(url) {
  const host = url.hostname;
  const path = url.pathname;
  if (AUDIO_EXT.test(path)) return { cache: MEDIA_CACHE, mode: 'cache-first' };
  if (SAMPLE_HOSTS.has(host)) {
    // Sample maps can be edited upstream — fresh when online, cached offline.
    return path.endsWith('.json')
      ? { cache: MEDIA_CACHE, mode: 'network-first' }
      : { cache: MEDIA_CACHE, mode: 'cache-first' };
  }
  if (CODE_CDNS.has(host)) {
    return { cache: CDN_CACHE, mode: PINNED.test(path) ? 'cache-first' : 'network-first' };
  }
  if (host === 'storage.googleapis.com' && path.startsWith('/mediapipe-models/')) {
    return { cache: CDN_CACHE, mode: 'cache-first' };  // versioned path (…/float16/1/…)
  }
  if (host === 'fonts.gstatic.com') return { cache: CDN_CACHE, mode: 'cache-first' };
  if (host === 'fonts.googleapis.com') return { cache: CDN_CACHE, mode: 'network-first' };
  return null;
}

let _mediaPuts = 0;
function trimMedia() {
  return caches.open(MEDIA_CACHE).then((c) => c.keys().then((keys) => {
    const extra = keys.length - MEDIA_MAX_ENTRIES;
    if (extra <= 0) return;
    return Promise.all(keys.slice(0, extra).map((k) => c.delete(k)));
  })).catch(() => {});
}

function putRuntime(cacheName, key, res) {
  return caches.open(cacheName).then((c) => c.put(key, res)).then(() => {
    if (cacheName === MEDIA_CACHE && ++_mediaPuts % 50 === 0) return trimMedia();
  }).catch(() => {});
}

function handleRuntime(event, req, policy) {
  // A <script>/<link> tag fetches no-cors → an opaque, uncacheable response.
  // Every allowlisted host serves CORS, so re-issue those as CORS; a CORS
  // response is a valid answer to a no-cors request.
  const netReq = req.mode === 'no-cors'
    ? new Request(req.url, { mode: 'cors', credentials: 'omit' })
    : req;
  // If the CORS retry itself fails (offline, or a host that dropped CORS),
  // a no-cors request falls back to its original form — uncached, as before.
  const fetchNet = () => fetch(netReq)
    .catch(() => (req.mode === 'no-cors' ? fetch(req) : Promise.reject(new Error('offline'))))
    .then((res) => {
      if (res && res.ok && res.type !== 'opaque') {
        event.waitUntil(putRuntime(policy.cache, req.url, res.clone()));
      }
      return res;
    });
  const cached = () => caches.open(policy.cache)
    .then((c) => c.match(req.url, { ignoreVary: true }))
    .then((hit) => hit || null);

  if (policy.mode === 'network-first') {
    const network = fetchNet();
    event.respondWith(networkFirstWithDeadline(network, cached));
    event.waitUntil(network.catch(() => {}));
    return;
  }
  // cache-first: an immutable/pinned resource never needs a revalidation.
  event.respondWith(cached().then((hit) => {
    if (!hit) return fetchNet().catch(() => Response.error());
    // LRU bump for media so the samples a set actually uses survive trimming.
    if (policy.cache === MEDIA_CACHE) event.waitUntil(putRuntime(MEDIA_CACHE, req.url, hit.clone()));
    return hit;
  }));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Range requests (media elements seeking) can't be answered from a whole
  // cached body without slicing — runtime caching leaves them to the network.
  const ranged = req.headers.has('range');
  // Cross-origin: only the allowlist in runtimePolicy is cached; everything
  // else gets the browser's default network behaviour (no proxying).
  if (url.origin !== self.location.origin) {
    const policy = ranged ? null : runtimePolicy(url);
    if (policy) handleRuntime(event, req, policy);
    return;
  }
  // voidstar's bundled sample packs (/samples/…): same treatment as Strudel's
  // samples, so a SW version bump doesn't drop them from offline use. Sample
  // maps stay fresh-first (packs get edited); audio is cache-first.
  if (!ranged && url.pathname.startsWith('/samples/')) {
    handleRuntime(event, req, url.pathname.endsWith('.json')
      ? { cache: MEDIA_CACHE, mode: 'network-first' }
      : { cache: MEDIA_CACHE, mode: 'cache-first' });
    return;
  }

  // HTML pages, web app manifests, and app icons → network-first with cache
  // fallback. Manifests and icons must be fresh-first: the browser's PWA
  // install/update checks read them, and a stale copy after a deploy changes
  // the app's identity (icons/id) out from under the installed app — see the
  // v13 and v16 notes above. Icons are requested rarely (install checks,
  // favicon), so fresh-first costs almost nothing.
  const accept = req.headers.get('accept') || '';
  const isHtml = req.mode === 'navigate' || accept.includes('text/html');
  const isManifest = url.pathname.endsWith('.webmanifest');
  const isAppIcon = /^\/(icon-[\w.-]+\.png|favicon\.(svg|ico))$/.test(url.pathname);
  if (isHtml || isManifest || isAppIcon) {
    // Icons revalidate past the browser HTTP cache (conditional request →
    // cheap 304 when unchanged): a warm 1h cache would otherwise keep
    // answering this "network-first" fetch with the very bytes we're
    // trying to replace. HTML/manifests keep the default (their edge
    // cache is already short).
    const network = fetch(isAppIcon ? new Request(req, { cache: 'no-cache' }) : req)
      .then((res) => {
        // Only cache good responses — a transient 5xx/404 must not
        // poison the offline fallback for this route.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    // The homepage fallback is for page navigations only — handing its
    // HTML body to a manifest request would be worse than failing.
    const fallback = () =>
      caches.match(req).then((c) => c || (isHtml ? caches.match('/') : null));
    if (!isHtml) {
      event.respondWith(network.catch(() => fallback().then((c) => c || Response.error())));
      return;
    }
    // Navigations: network-first, but a hung network (lie-fi) must not hold
    // the app hostage — after NAV_TIMEOUT_MS serve the cached shell if there
    // is one. A late network response still lands in the cache (above).
    event.respondWith(networkFirstWithDeadline(network, fallback));
    // Keep the SW alive until the background refresh settles.
    event.waitUntil(network.catch(() => {}));
    return;
  }

  // Everything else (assets). Astro content-hashes /_astro/* filenames, so
  // a cache hit there is immutable — serve it without a revalidation fetch.
  // Other assets (icons, sw-adjacent files) stay stale-while-revalidate.
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
