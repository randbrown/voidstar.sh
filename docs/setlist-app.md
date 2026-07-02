# Setlist app

`/lab/setlist` is a live-performance setlist/chart/annotation tool: songs,
setlists, chart links, and hand-drawn markup, usable on stage from a phone or
tablet. It's built as plain Astro + vanilla JS — no framework, no client-side
state library.

- Entry point: `src/pages/lab/setlist.astro`
- Hash-based router: `src/lib/setlist/app.js` (`#home`, `#library`,
  `#settings`, `#setlist/:id[/edit]`, `#song/:id[/:setlistId][/chart|/annotate]`,
  `#perform/:id/:songId`). The song page renders the chart (with read-only
  annotations) inline; `/annotate` opens the full-screen annotation editor
  straight in draw mode, and `/chart` is a legacy alias for the song page.
- Views are built with small DOM-builder helpers (`el()`/`btn()`) in
  `src/lib/setlist/views.js` — no JSX/templates.

## Data model

IndexedDB database `voidstar.setlist` (see `src/lib/setlist/store.js`), version 4:

| Store | Key | Shape |
|---|---|---|
| `songs` | `id` | `{id, title, artist, key, bpm, capo, keyChanges, steelEntry, spotifyUri, chartUrl, lyrics, createdAt, updatedAt}` |
| `notes` | `id` | `{id, songId, text, source, createdAt, updatedAt}` |
| `setlists` | `id` | `{id, name, sets:[{name, songIds[]}], gigDate, venue, spotifyUrl, vocalistLegend, songOverrides, createdAt, updatedAt}` |
| `annotations` | `songId` | `{songId, strokes[], aspect, updatedAt}` — hand-drawn chart markup (pen/highlighter/text/arrow), one per song |
| `charts` | `songId` | `{songId, blob, sourceUrl, mimeType, size, fetchedAt}` — cached chart for offline perform mode (plain text for Google-Doc charts, image bytes otherwise) |
| `snapshots` | `ts` | `{ts, label, data}` — rolling safety snapshots of the whole dataset (last 10), taken before a restore/sync/import so it can be undone |

`charts` and `snapshots` are intentionally **local-only** and excluded from
`exportAll()` (the Drive backup payload): `charts` is derivable from `chartUrl`,
and including `snapshots` would recurse the whole backup into every snapshot.
Everything else round-trips through backup — including `annotations`.

## Re-rendering: `refresh()` vs `navigate()`

`navigate(hash)` only sets `location.hash`; the router (`route()`) re-renders
on `hashchange`. Assigning `location.hash` its **current** value fires no
`hashchange`, so a handler that "navigates" to the page it's already on is a
silent no-op. To re-render the current view in place (after an in-page edit
like add/remove song, reorder-undo, or a per-song scrape/search), call
`refresh()` (`app.js`) instead — it re-runs `route()` directly. Only use
`navigate()` when actually going to a *different* hash.

Per-setlist overrides live in `setlist.songOverrides[songId]` (key/capo/steel
entry only — title, artist, chartUrl, and spotifyUri always live on the base
song). `store.mergedSong(song, setlist)` applies overrides for display.

## Backup/Restore vs. Sync — these are different features

This codebase intentionally keeps two similarly-named ideas separate:

- **Backup / Restore** (`src/lib/setlist/gdrive-backup.js`) — pushes/pulls a
  single JSON file (`voidstar-setlist-data.json`) containing your entire
  local dataset to/from the user's own Google Drive (OAuth via Google
  Identity Services, `drive.file` scope). This is about **not losing your
  data** and having it available across devices (Android/Mac/Windows).
  - Auto-backup: every local write is debounced and pushed automatically
    once connected.
  - Manual: "back up now" / "restore from drive" buttons in Settings.
  - All paths go through `pullMergePushCycle()`, which always pulls, merges by
    "newer wins" (`updatedAt`/`createdAt`, per-record), writes the merge back
    locally, then pushes it — so no path can blindly clobber either side. An
    `isSyncing()` flag serializes cycles so manual, auto-push, and focus-pull
    can't overlap.
  - **Making it intuitive.** A shared `runManualSync()` backs a "sync now"
    button on the song and setlist-edit pages, plus the Settings buttons. The
    dashboard status pill is tappable (sync now; or `↻ reconnect` when a
    client is configured but the OAuth token lapsed — a silent refresh is
    impossible, GIS needs a gesture). The app also auto-pulls when it regains
    focus/visibility (`watchFocusSync()` in `app.js`, silent-only, debounced
    30 s, app-wide) so opening it on another device shows the latest without
    hunting for a button.
  - **Reversibility (undo a bad sync/import).** Every operation that overwrites
    local data snapshots the prior state first (`store.putSnapshot`, into the
    local `snapshots` store) — Settings → "undo last sync" restores the newest
    snapshot. Snapshot/version restores use `store.replaceAll()` (a full
    replace incl. deletions), *not* the additive `importAll()`. Separately, each
    push also rotates a timestamped copy into a "voidstar backups" Drive folder
    (last 10, throttled to ≤ once / 10 min for auto-syncs; manual actions force
    one); Settings → "restore a version…" lists these for cross-device rollback.
- **Sync** (`src/lib/setlist/sync.js`, `match.js`, the Cloudflare Worker) —
  matching an imported setlist's song titles against a Spotify reference
  playlist and Google Drive chart folders, to auto-fill `spotifyUri` and
  `chartUrl`. This is about **finding the right chart/track for a song**,
  not about data durability.

If you're adding a feature and reaching for the word "sync," check which of
these two you mean — and if it's the Drive-backup one, call it Backup/Restore
instead to keep this distinction intact.

## Chart-fallback ladder

When a song has no chart linked yet, `renderSongFocus()` in `views.js` offers
four tiers, in order:

1. **Personal Drive folders** — `sources.driveFolders`, direct children only,
   via the worker's `GET /drive/folder/:id`.
2. **Community/shared chart folders** — `sources.communityFolders`, walked
   **recursively** via `GET /drive/folder/:id/recursive`, since archives in
   circulation among musicians (e.g. Nashville Number Chart repos) are
   commonly nested by artist/album. Capped (`RECURSIVE_MAX_DEPTH`/
   `MAX_FOLDERS`/`MAX_FILES` in the worker) to protect the Drive API and the
   worker's execution time; a capped walk returns `truncated: true` rather
   than failing, and that surfaces as a warning in sync results.
3. **Web search for shared charts** — the worker's `GET /web/chart-search`
   web-searches for the song's chart in shared collections in the wild (NNS
   chart repos passed around as Drive/Dropbox links). Search runs through a
   provider chain (Google Programmable Search if `GOOGLE_CSE_ID` is set →
   Brave if `BRAVE_SEARCH_API_KEY` is set → keyless DuckDuckGo HTML).
   Drive hits are verified via the Drive API (reachable with the API key ⇒
   link-shared ⇒ scrape/offline-cache will work too) and scored on the real
   filename; shared *folders* surfaced by the search get a bounded recursive
   walk. A verified candidate scoring ≥ `WEB_AUTO_LINK_SCORE` (0.85) is
   auto-linked; weaker candidates appear in a picker under the action bar
   ("open" to preview, "use" to link). Dropbox links can't be verified
   without OAuth, so they're always picker-only, marked `unverified`.
4. **Create a chart doc** — no longer a *blank* doc. The button walks a
   best-first ladder of worker calls (audio-analysis metadata fetches in
   parallel and improves whichever tier lands):
   - `GET /ai/chart` (strongest tier, needs an AI key on the worker) — an
     LLM with web-search grounding drafts the actual chart the way a session
     leader would: key, tempo, time, feel, song form, **bar-accurate**
     sections, split bars, and playing notes. Providers form a chain —
     Claude (`ANTHROPIC_API_KEY`, `web_search` server tool, default model
     `claude-opus-4-8`) first, Gemini (`GEMINI_API_KEY`, Google Search
     grounding, default `gemini-2.5-flash`, free tier at
     aistudio.google.com/apikey) as fallback — whichever is configured; with
     both set, a song one can't verify falls through to the other.
     Hallucination guards, in layers: search grounding, a prompt contract
     that demands `found:false` over invention, a numeric confidence gate
     (`AI_MIN_CONFIDENCE`), server-side normalization/clamping of the JSON
     (`normalizeAiChart`), source URLs + confidence printed in the doc
     footer, and a verify-by-ear note. Responses cache for 7 days.
   - `GET /web/chart-data` (fallback) finds a community chord sheet —
     Ultimate Guitar first (its search page + the tab page's embedded
     `js-store` JSON gives sections, tonality, and capo), then a web-search
     sweep over any chord site using a **generic extractor** (chord sheets
     are plain text, usually in a `<pre>`; strip markup, detect chord-only
     lines and section headers in any style — `[Verse]`, `Chorus:`,
     `VERSE 2`). No single blocked or redesigned site kills the feature.
     Chords are converted to Nashville numbers (key from the source's
     tonality, else inferred from the chords; `keyInferred: true` flags the
     guess). Unlike the AI tier this can't know bar counts — one number line
     per source chord line.
   - `GET /meta/song` derives BPM / key / time signature from music APIs:
     Spotify audio-features when the song has a linked track (only works for
     client-credential apps created before the Nov 2024 deprecation — a 403
     is skipped quietly), keyless Deezer as the BPM fallback.
   `chart-build.js` then formats a chart in the working NNS-chart layout —
   key/time/BPM/feel header, title + artist, a number→chord legend, sections
   (AI tier: one number per bar, four bars per line, via
   `buildAiChartText`; scrape tier: one line of numbers per source line with
   chord names in parens beneath, via `buildChartText`), repeated sections
   referenced by name. Derived BPM/time fill header gaps; a derived key
   never overrides the chart source's key (the numbers were computed
   against it) — a mismatch becomes a "check which is right" note.
   `createChartDoc()` in `gdrive-backup.js` uploads it as `text/plain`
   converted into a Google Doc inside the dedicated "voidstar charts" Drive
   folder (created once, reused after), using the same OAuth token as
   backup — and immediately link-shares the doc (anyone-with-link, reader),
   because the worker reaches chart files with an API key: scrape,
   thumbnail rasterizing, and offline caching all fail on a private doc
   (Drive's thumbnail endpoint even answers one with a login page — which,
   before blob validation in `chart-cache.js` and the content-type check on
   `/drive/file/:id/image`, could get cached as a permanently broken "chart
   image"; `getOfflineChartUrl` now self-heals such poisoned entries). When neither AI nor a chord source delivers, it falls back to a
   structured fill-in template — still carrying any derived key/BPM/time —
   rather than a blank page. It's a Doc (not a Drawing) so
   the worker's existing plain-text scraping (`handleDriveFileMeta`) works
   on it unmodified — the generated header (`Key:`/`Time:`/`BPM:`/`Capo:`)
   intentionally matches what `extractFromText` parses; for freeform
   hand-drawn charts, the in-app annotation canvas already draws on top of
   any linked document.

Tiers 1–3 are available per-song via `searchChartForSong()` in `sync.js`
(the "search for chart" button, which reports its stage and returns
`{found, tier, candidates, providerDown}`); tiers 1+2 also run in the bulk
"sync now" action in Settings.

**Diagnosability:** every "found nothing" path says why instead of failing
silently — a bot-blocked keyless search engine surfaces as `providerDown`
("web search blocked — add search key" on the button; fix by setting
`GOOGLE_CSE_ID` or `BRAVE_SEARCH_API_KEY` on the worker), an old worker
deploy missing the `/web/*` routes shows "worker outdated", and
`/web/chart-data` responses list the URLs `tried`. The client logs details
to the console with a `[setlist]` prefix.

## Annotation alignment invariant

Annotation strokes are stored normalized (x/y in 0..1) against the authoring
canvas's `aspect` (width/height). For them to line up, **the rendered chart
rectangle must equal the canvas rectangle**, and both must equal an
aspect-locked box whose ratio is that stored `aspect`. A corollary: the chart
must be **flat** (an element the page scrolls) — an embedded Docs/Drive
preview iframe scrolls its content *internally*, which the overlay can't
follow. That's why Google-Doc charts render from their plain-text export
(`mountTextChart` in `views.js`, fed by the worker's
`GET /drive/file/:id/text` or the text-cached blob): an in-flow block whose
type metrics are container-relative (`cqw`), so the layout scales uniformly
with box width and the box's natural aspect is device-independent. The annotate/detail
views achieve this with `.sl-annotation-stage` (chart + canvas both
`inset:0; 100%/100%` inside a box whose `aspect-ratio` = stored `aspect`).
Perform mode uses `.sl-perform-chart-wrap` the same way, but its flattened
chart image (`.sl-chart-flat`) is normally natural-aspect/fit-to-width — so
when a song has annotations it gets `.sl-has-annotations` (set in
`renderPerformMode`), whose CSS makes the image fill the box like the canvas.
If you touch perform-mode chart layout, preserve this: chart rect == canvas
rect == the `aspect` box, or annotations drift.

## Cloudflare Worker (`workers/setlist-sync/index.js`)

Proxies Spotify (client-credentials) and Google Drive (API key) so the
browser-only app can read Spotify playlists/tracks and list/scrape
link-shared Drive files without exposing credentials client-side.

Env vars (`wrangler secret put`): `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`,
`GOOGLE_API_KEY`. Optional, for better `/web/*` search: `GOOGLE_CSE_ID`
(Programmable Search Engine id, pairs with `GOOGLE_API_KEY`),
`BRAVE_SEARCH_API_KEY` — without either, web search falls back to a keyless
DuckDuckGo HTML scrape. Optional, for `/ai/chart`: `ANTHROPIC_API_KEY`
and/or `GEMINI_API_KEY` (+ `ANTHROPIC_MODEL`/`GEMINI_MODEL` overrides).
Also `ALLOWED_ORIGIN` (plain var in `wrangler.toml`).

The worker imports `@anthropic-ai/sdk`, so run `npm ci` at the repo root
before `wrangler deploy` (wrangler bundles it from `node_modules`).

Routes: `GET /spotify/playlist/:id`, `GET /spotify/search`,
`POST /spotify/search-batch`, `GET /drive/folder/:id`,
`GET /drive/folder/:id/recursive`, `GET /drive/file/:id/meta`,
`GET /drive/file/:id/text`, `GET /drive/file/:id/image`,
`GET /web/chart-search?title=&artist=`,
`GET /web/chart-data?title=&artist=`,
`GET /meta/song?title=&artist=&spotifyId=`,
`GET /ai/chart?title=&artist=&key=`, `GET /health`.
