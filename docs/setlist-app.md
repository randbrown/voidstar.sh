# Setlist app

`/lab/setlist` is a live-performance setlist/chart/annotation tool: songs,
setlists, chart links, and hand-drawn markup, usable on stage from a phone or
tablet. It's built as plain Astro + vanilla JS — no framework, no client-side
state library.

- Entry point: `src/pages/lab/setlist.astro`
- Hash-based router: `src/lib/setlist/app.js` (`#home`, `#library`,
  `#settings`, `#setlist/:id[/edit]`, `#song/:id[/:setlistId][/chart|/annotate]`,
  `#perform/:id/:songId`)
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
| `charts` | `songId` | `{songId, blob, sourceUrl, mimeType, size, fetchedAt}` — cached chart image for offline perform mode |
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
three tiers, in order:

1. **Personal Drive folders** — `sources.driveFolders`, direct children only,
   via the worker's `GET /drive/folder/:id`.
2. **Community/shared chart folders** — `sources.communityFolders`, walked
   **recursively** via `GET /drive/folder/:id/recursive`, since archives in
   circulation among musicians (e.g. Nashville Number Chart repos) are
   commonly nested by artist/album. Capped (`RECURSIVE_MAX_DEPTH`/
   `MAX_FOLDERS`/`MAX_FILES` in the worker) to protect the Drive API and the
   worker's execution time; a capped walk returns `truncated: true` rather
   than failing, and that surfaces as a warning in sync results.
3. **Create a blank chart doc** — `createBlankChartDoc()` in
   `gdrive-backup.js` creates a Google Doc inside a dedicated "voidstar
   charts" Drive folder (created once, reused after) using the same OAuth
   token as backup, and opens it for the user to type/paste a chart into.
   It's a Doc (not a Drawing) so the worker's existing plain-text scraping
   (`handleDriveFileMeta`) works on it unmodified once filled in; for
   freeform hand-drawn charts, the in-app annotation canvas already draws on
   top of any linked document.

Tiers 1+2 are also available per-song via `searchChartForSong()` in
`sync.js` (the "search for chart" button), not just as the bulk "sync now"
action in Settings.

## Annotation alignment invariant

Annotation strokes are stored normalized (x/y in 0..1) against the authoring
canvas's `aspect` (width/height). For them to line up, **the rendered chart
rectangle must equal the canvas rectangle**, and both must equal an
aspect-locked box whose ratio is that stored `aspect`. The annotate/detail
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
`GOOGLE_API_KEY`. Also `ALLOWED_ORIGIN` (plain var in `wrangler.toml`).

Routes: `GET /spotify/playlist/:id`, `GET /spotify/search`,
`POST /spotify/search-batch`, `GET /drive/folder/:id`,
`GET /drive/folder/:id/recursive`, `GET /drive/file/:id/meta`,
`GET /drive/file/:id/image`, `GET /health`.
