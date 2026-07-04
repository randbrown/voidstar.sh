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
| `songs` | `id` | `{id, title, artist, key, bpm, capo, keyChanges, steelEntry, spotifyUri, chartUrl, lyrics, syncedLyrics, genre, year, durationSec, artworkUrl, statuses, createdAt, updatedAt}` — `statuses` is an array of practice-status keys (`todo`/`needsWork`/`ok`/`goodToGo`/`steelLead`), toggled on the song page and badged on setlist/library rows. `bpm`/`capo` stay in the model (chart-doc headers and "read chart" still read/write them) but have **no edit UI** — the song form is key + key changes only. `syncedLyrics` is LRC text; `genre`/`year`/`durationSec`/`artworkUrl` come from "fetch info" (iTunes via the worker) |
| `notes` | `id` | `{id, songId, text, source, createdAt, updatedAt}` |
| `setlists` | `id` | `{id, name, sets:[{name, songIds[]}], gigDate, venue, spotifyUrl, vocalistLegend, songOverrides, createdAt, updatedAt}` |
| `annotations` | `songId` | `{songId, strokes[], aspect, updatedAt}` — hand-drawn chart markup (pen/highlighter/text/arrow), one per song |
| `charts` | `songId` | `{songId, blob, sourceUrl, mimeType, size, fetchedAt}` — cached chart for offline perform mode (plain text for Google-Doc charts, image bytes otherwise) |
| `snapshots` | `ts` | `{ts, label, data}` — rolling safety snapshots of the whole dataset (last 10), taken before a restore/sync/import so it can be undone |

`charts` and `snapshots` are intentionally **local-only** and excluded from
`exportAll()` (the Drive backup payload): `charts` is derivable from `chartUrl`,
and including `snapshots` would recurse the whole backup into every snapshot.
Everything else round-trips through backup — including `annotations`.

### Local state outside IndexedDB

App state that isn't song/setlist data lives in web storage. **Identity/config
that should follow the user across devices rides the Drive backup** — the
payload's `sources` and `settings` sections, merged *fill-empty* (a value the
device already has always wins; only blanks fill from the backup, so a new
device bootstraps itself but a fresh install can never clobber the fleet's
config). Tokens and per-device display prefs never ride it:

| Key | Store | Backed up? | What |
|---|---|---|---|
| `voidstar.setlist.sources` | localStorage | ✓ `sources` | worker URL + personal/community Drive chart-folder ids (Settings → "sources & auto-link") |
| `voidstar.setlist.gdrive.clientId` | localStorage | ✓ `settings.gdriveClientId` | Google OAuth client id (public identifier, not a secret) |
| `voidstar.setlist.spotify.clientId` | localStorage | ✓ `settings.spotifyClientId` | Spotify client id — shared by the worker and the PKCE login |
| `voidstar.setlist.gdrive.token` | localStorage | ✗ | cached OAuth access token (~1 h) |
| `voidstar.setlist.gdrive.lastBackupAt` / `.lastHistoryAt` | localStorage | ✗ | backup + history-rotation throttle timestamps |
| `voidstar.setlist.gdrive.backupsFolderId` / `.chartsFolderId` | localStorage | ✗ | cached Drive folder ids ("voidstar backups" / "voidstar charts") |
| `voidstar.setlist.chartAppearance.detail` / `.perform` | localStorage | ✗ | per-mode chart look, `'dark'` \| `'light'` (see the chart-appearance section); legacy `voidstar.setlist.invertChartDetail` / `.invertChart` migrate `1`→dark, `0`→light |
| `voidstar.setlist.chartEnhance` | localStorage | ✗ | "✦ enhance" auto-levels for cached image charts, `'1'` (default, on) \| `'0'` (see the chart-appearance section) |
| `voidstar.setlist.spotify.token` | localStorage | ✗ | Spotify user login (PKCE): `{accessToken, refreshToken, expiresAt}` (see the Spotify-links section) |
| `voidstar.setlist.spotify.pkce` | sessionStorage | ✗ | PKCE verifier + return hash, alive only during the login redirect round-trip |
| `voidstar.setlist.noteDraft.<songId>` | sessionStorage | ✗ | uncommitted note-composer draft (survives focus-driven `refresh()` and app-switching; cleared on save) |

### Practice statuses

`song.statuses` holds zero or more keys from `SONG_STATUSES` (`views.js`):
`todo` / `needsWork` / `ok` / `goodToGo` / `steelLead`, in that display
order, labeled `todo`/`work`/`ok`/`good`/`steel lead` and badged
`todo`/`work`/`ok`/`good`/`steel`, with per-status colors
keyed by the `data-s` attribute (`--st` rules in `setlist.astro`). They're
toggled as chips on the song page and rendered as small badges
(`statusBadges()`) on setlist and library rows — **not** in perform mode.
The library view has matching filter chips with AND semantics (selecting
`needsWork` + `steelLead` shows songs carrying both). Toggling goes through
`store.putSong`, which bumps `updatedAt`, so statuses merge correctly
through Drive backup.

## Re-rendering: `refresh()` vs `navigate()`

`navigate(hash)` only sets `location.hash`; the router (`route()`) re-renders
on `hashchange`. Assigning `location.hash` its **current** value fires no
`hashchange`, so a handler that "navigates" to the page it's already on is a
silent no-op. To re-render the current view in place (after an in-page edit
like add/remove song, reorder-undo, or a per-song scrape/search), call
`refresh()` (`app.js`) instead — it re-runs `route()` directly. Only use
`navigate()` when actually going to a *different* hash.

Per-setlist overrides live in `setlist.songOverrides[songId]` (key/steel
entry only — title, artist, key changes, chartUrl, and spotifyUri always live
on the base song). `store.mergedSong(song, setlist)` applies overrides for
display.

### Key: parsed from the chart, and the key-change callout

A song with a linked text chart should never sit at "no key":
`chart-key.js` (`extractKeyFromChartText`) reads the key out of a chart
header ("Key: A", "Key of G", or the key alone in the top corner), and an
empty `song.key` is auto-filled wherever that text is already in hand — on
the song page render (`maybeFillKeyFromChart`, which also patches the "no
key" badge in place) and when a text chart is offline-cached
(`cacheChartForSong`, so bulk "download all charts" populates keys
library-wide). The worker's `extractFromText` keeps matching patterns for
the song page's "read chart" button (formerly "scrape"). Scanned/image
charts have no text to parse — for those, "read chart" falls through to the
worker's **vision route** (`POST /ai/chart-read`): the chart image
(offline-cached, or fetched on demand via `cacheChartForSong` when no
cache pass has run yet) is downscaled client-side (`readChartImage` in
`sync.js`, white-filled before JPEG re-encode so transparent PNGs don't
go black-on-black) and a vision model transcribes what's actually written
on the page — key, BPM, capo, modulation notes — with a read-only prompt
(no invention), confidence-gated and normalized server-side like the
drafting route. Reading is transcription, not drafting, so it defaults to
the cheap model tier (`ANTHROPIC_READ_MODEL`, default Haiku). Because the
button is an explicit user action, failures are loud: when nothing was
pulled *and* something went wrong (no worker URL, no AI key on the worker,
chart fetch/decode error, low vision confidence), the button alerts the
collected reasons instead of shrugging "no new data".

`song.keyChanges` ("mod up to A, last chorus") renders as a **pulsing amber
badge right next to the key** (`.sl-keychange-badge`) on the song page,
setlist rows, and perform mode — a mid-song modulation must grab the eye,
so never restyle it into a dim secondary badge.

### "fetch info" — metadata + lyrics in one tap

The song page's "fetch info" button fills **empty** fields only (never
overwrites hand-set values) from two sources:

- **`GET /meta/song`** (worker): BPM/key/time as before, plus keyless
  **iTunes Search** for canonical artist, genre, release year, track length,
  and album artwork (600px, https-only). Artwork shows as a small square on
  the song page (`.sl-focus-art`); genre/year/length are dim badges. Perform
  mode deliberately shows none of this — key + key changes are the stage
  info.
- **LRCLIB** (`lyrics.js`, straight from the browser — lrclib.net is keyless
  and CORS-open): plain lyrics into `song.lyrics`, LRC synced lyrics into
  `song.syncedLyrics`. Exact `/api/get` lookup first (title + artist +
  duration), then `/api/search` ranked with the app's own match scoring
  (≥ 0.7 to accept). Synced-only tracks derive plain text from the LRC.

Lyrics render via `textContent` only (external data). When `syncedLyrics`
exists, the lyrics section becomes a scrolling box whose active line
highlights and centers as the **timecode timer** runs (the `onTimecodeTick`
hook in `renderSongFocus`) — start the timer with the Spotify embed and the
lyrics follow.

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
  - All paths — **including the debounced auto-push** — go through
    `pullMergePushCycle()`, which always pulls, merges by "newer wins"
    (`updatedAt`/`createdAt`, per-record; `sources`/`settings` merge
    fill-empty), writes the merge back locally, then pushes it — so no path
    can blindly clobber either side. (The auto-push used to push blind;
    with two devices open, each push overwrote the other's changes in
    Drive.) The local import + pre-import snapshot are **skipped when the
    remote has nothing new** (`remoteHasNews`) — otherwise every cycle
    would re-import identical data, fire the write hook, and schedule the
    next push forever. An `isSyncing()` flag serializes cycles so manual,
    auto-push, and focus-pull can't overlap.
  - `pull()` self-heals **duplicate data files** (two devices' first backups
    racing used to split the dataset — each device read/wrote its own copy
    and "missed" the other's edits): the file list is ordered newest-first
    so every device picks the same file, and any duplicates are merged in
    and trashed.
  - **Making it intuitive.** A shared `runManualSync()` backs a "⟲ drive
    backup" button on the song and setlist-edit pages, plus the Settings
    buttons. (UI labels deliberately say "backup", never "sync" — see the
    naming note below.) The
    dashboard status pill is tappable (sync now; or `↻ reconnect` when a
    client is configured but the OAuth token lapsed — a silent refresh is
    impossible, GIS needs a gesture). The app also auto-pulls when it regains
    focus/visibility (`watchFocusSync()` in `app.js`, silent-only, debounced
    30 s, app-wide) so opening it on another device shows the latest without
    hunting for a button.
  - **Reversibility (undo a bad sync/import).** Every operation that overwrites
    local data snapshots the prior state first (`store.putSnapshot`, into the
    local `snapshots` store) — Settings → "undo last merge/restore" restores
    the newest snapshot. Snapshot/version restores use `store.replaceAll()` (a full
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

**UI naming rule:** user-facing labels never say a bare "sync". The
Drive-backup feature presents as "drive backup" / "backing up" / "backed up"
(dashboard pill, "⟲ drive backup" buttons, Settings' "back up now" /
"restore from drive" / "undo last merge/restore"); the matching feature
presents as "auto-link" ("auto-link now" in Settings, "auto-link" on the
setlist page, "matching songs…" in the progress overlay). Internal
identifiers (`sync.js`, `runManualSync`, `sl-sync-*` CSS) keep their names.

### Spotify links: auto-link never overwrites — "relink" fixes a bad match

Auto-link fills `spotifyUri` only when it's empty, so a wrong link (early
versions fell back to a global title search on playlist-fetch failure,
which loved karaoke covers) sticks until fixed by hand. The song page's
"relink spotify" button opens a picker over the *reference playlists'
actual tracks*: `getReferencePlaylistTracks(setlist)` (`sync.js`) fetches
every setlist's `spotifyUrl` playlist through the worker and returns
`{tracks, problems}` — `problems` carries the real reason whenever tracks
come back empty (no worker URL configured, no playlist URL set on any
setlist, a share short-link or album URL where a playlist link is needed,
or the worker's actual Spotify error), because silently saying "no playlist
tracks" about a playlist the user is looking at in Spotify reads as data
loss. `renderSpotifyPicker` (`views.js`) ranks rows by title match score,
has a filter input, caps rendering at 100 rows, and writes titles via
`textContent` (playlist data is untrusted).

**Playlist reads prefer the user's own Spotify session.** The worker's
client-credentials token gets `403 Forbidden` on playlist reads for newer
Spotify app registrations (observed in prod), and could never see
private/collaborative playlists. `src/lib/setlist/spotify-auth.js`
implements Authorization Code + PKCE entirely in the browser (Spotify's
token endpoint and Web API are CORS-enabled; no client secret involved —
the same client id the worker uses goes in Settings → "spotify account").
Login is a full-page redirect, not a popup, so it needs no mobile gesture
gymnastics: `beginSpotifyLogin()` navigates to Spotify,
`completeSpotifyLogin()` (called once in `initSetlistApp` before the first
route) exchanges the `?code=`, cleans the URL, and restores the saved
hash. `fetchSpotifyTracks` (`sync.js`) tries the user token first
(`fetchPlaylistTracksAsUser`, same `{title, artist, spotifyUrl}` shape as
the worker route) and falls back to the worker; worker 403/404 errors
append a "connect spotify in Settings" hint when no user session exists.
Setup gotchas: the redirect URI registered in the Spotify dashboard must
match **exactly** (Settings shows the computed value to paste).
`spotifyRedirectUri()` normalizes away the trailing slash — the page is
served at both `/lab/setlist` and `/lab/setlist/`, and deriving the URI
from the raw pathname made the sent value depend on which form loaded the
page (Spotify then 400s with "redirect_uri: Not matching configuration").
Register the no-slash form: `https://voidstar.sh/lab/setlist`. Spotify
requires HTTPS redirect URIs, and for local dev the loopback exception
demands the IP literal (`http://127.0.0.1:4321/lab/setlist`) — a
`localhost` URI is rejected. Search (`/spotify/search*`) still rides the
worker's client credentials, which work fine for that endpoint.

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
   image"; `getOfflineChart` now self-heals such poisoned entries). When neither AI nor a chord source delivers, it falls back to a
   structured fill-in template — still carrying any derived key/BPM/time —
   rather than a blank page. It's a Doc (not a Drawing) so
   the worker's existing plain-text scraping (`handleDriveFileMeta`) works
   on it unmodified — the generated header (`Key:`/`Time:`/`BPM:`/`Capo:`)
   intentionally matches what `extractFromText` parses; for freeform
   hand-drawn charts, the in-app annotation canvas already draws on top of
   any linked document. The song page's "rebuild doc" button re-runs this
   same ladder for a song that already has a chart, replacing the link and
   trashing the old doc when this app created it (`trashChartDoc` —
   drive.file scope can't touch community charts, so those just unlink).

Tiers 1–3 are available per-song via `searchChartForSong()` in `sync.js`
(the "search for chart" button, which reports its stage and returns
`{found, tier, candidates, providerDown}`); tiers 1+2 also run in the bulk
"auto-link now" action in Settings.

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

Text-chart typography is deterministic on purpose: `.sl-text-chart` metrics
are container-relative (`cqw`) and the stack pins `'JetBrains Mono'` at
weight 500 — a weight the site's Google Fonts import actually ships.
Requesting an unshipped weight would synthesize differently per OS, change
line wrapping, and move annotations between devices.

The same rule governs **text annotations** (`annotation.js`): the canvas
font is a pinned stack sized relative to `canvas.width` (`size 4` ≈ 2% of
the box width), because stroke coordinates are normalized to that box — a
fixed pixel size would give the text a different normalized footprint on
every device. (Also: `var(--font-mono)` is invalid inside a canvas font
string and gets silently ignored — that once left all text annotations at
the canvas default 10px sans-serif, immune to the size picker.) Selected
text elements get a bottom-right corner handle for continuous drag-resize;
`stroke.size` stays the single source of scale and may be fractional.

## Chart rendering on the song page (and how "appearance" works)

`renderInlineChart()` (song page) and perform mode pick a chart rendering
in this order:

1. **Offline cache** — `getOfflineChart(songId, song.chartUrl)`
   (`chart-cache.js`) returns a typed result: `{kind:'text', text}` for
   Google-Doc charts (cached as plain text), `{kind:'image', url}` (an
   object URL the caller must revoke) for everything else. Passing the
   current `chartUrl` invalidates a stale blob after a relink, and
   unrenderable blobs (HTML login pages cached before validation existed)
   self-heal by deletion.
2. **Live text export** — Google-Doc charts fetch
   `GET /drive/file/:id/text` (`fetchChartText`) and mount flat via
   `mountTextChart`.
3. **`mountRemoteChartInto()`** for everything else: the flattened Drive
   thumbnail image first (aligned and annotatable), the Docs/Drive preview
   iframe only as a last resort (its internal scroll breaks annotation
   alignment, and Google may CSP-block the frame entirely on devices not
   signed in — visible as `frame-ancestors` console errors), and a bare
   `<img>` for direct image links. It also warms this device's offline
   cache in the background (`cacheChartForSong`) so any iframe fallback is
   a first-visit-only experience.

**Chart appearance is a per-mode target look, not an invert toggle.** The
"◐ dark charts / ◐ light charts" button stores `'dark'` or `'light'`
separately for the detail and perform views (keys in the state table
above; default `'dark'`). It's a *target* because the two document types
start from opposite places: scans/PDFs are natively white, so "dark"
inverts them (`filter: invert(1) hue-rotate(180deg)`), while generated
text charts are natively dark, so "light" restyles them to paper
(`#f4f1e8` background, dark text) with no filter at all. A single shared
invert switch did opposite things to the two types — don't reintroduce
one. The CSS classes are `.sl-charts-dark` / `.sl-charts-light` on the
stage box (rules in `setlist.astro`, applied by `applyChartAppearance` in
`views.js`). Annotation ink keeps a subtle dark halo (`drop-shadow` on the
canvases) so strokes stay readable on both light and dark grounds.

**"✦ enhance" — auto-levels for scanned charts.** The invert filter
*preserves* a source's contrast, and hand-drawn charts are photos/scans
(gray pencil, off-white paper, uneven exposure) — so dark mode alone renders
them gray-on-gray, with quality varying per scan. `chart-enhance.js` fixes
this before display: a luminance histogram finds the ink point and the
dominant "ground" lobe (paper — or the background of a native-dark image),
a levels stretch pins them to true black/white, and a midtone gamma pulls
faint strokes toward the ink end. It's self-calibrating: a clean chart maps
to a near-identity curve, so it's safe on by default (one shared
localStorage key, toggles on the song page's "✦ enhance" button and the
`✦` glyph in perform's control strip; toggling re-renders — pixels change,
not classes). Constraints to preserve:

- Enhancement runs only on **cached blobs** (`getOfflineChart`'s
  `{kind:'image', url, blob}`) — a live `drive.google.com` `<img>` is
  cross-origin without CORS headers and would taint the canvas. First-visit
  live renders stay raw until the background cache warm-up lands.
- `chartDisplayUrl(cached)` (`views.js`) returns **exactly one object URL**
  (revoking the raw one when enhancement wins), so every mount site keeps
  its existing single revoke-on-navigate path.
- Pixel processing keeps dimensions/aspect (a >3000px source downscales
  proportionally), so the annotation-alignment invariant is untouched.

## Mobile & gesture rules (learned the hard way)

- **OAuth needs the tap.** GIS token popups are popup-blocked unless
  requested synchronously inside the user gesture. Any handler that might
  need Drive access (create doc, rebuild doc, backup) must call
  `ensureDriveAccess()` *first*, before any `await` — an async hop first
  means a blocked popup and a silent `error_callback` rejection on
  Android.
- **`window.open` after async work is blocked too.** When a long flow ends
  by opening the new doc, `window.open` can return `null` on mobile;
  `showLinkToast()` (`views.js`) is the fallback — a toast holding a real
  `<a>` the user taps.
- **Typed-but-uncommitted input must survive re-renders.** The app-wide
  focus pull (`watchFocusSync`) calls `refresh()`, which rebuilds the
  view — classic Android flow: type half a note, check something in
  another app, come back to an empty box. The note composer mirrors every
  keystroke to `sessionStorage` (`noteDraft.<songId>`) and restores it on
  render; saving clears it.
- **Swipe-to-navigate lives only in perform mode.** The song page had it
  and lost it — dragging a text selection in the notes field reads as a
  swipe. Song-page navigation is the prev/next buttons only.
- **Never open a modal inside a pointer gesture.** A `prompt()` fired from
  `pointerdown` wedges Android Chrome: the dialog interrupts the touch
  sequence before `pointerup`, the canvas keeps its implicit pointer
  capture, and every later tap — even on toolbar buttons — routes back into
  the canvas handler (the text tool re-prompting forever, Save unreachable).
  The annotation text tool arms on `pointerdown` and prompts in a
  `setTimeout(0)` after `pointerup` + `releasePointerCapture`; a
  `pointercancel` listener resets all gesture state without committing.

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
`GET /meta/song?title=&artist=&spotifyId=` (BPM/key/time + iTunes
artist/genre/year/artwork/duration),
`GET /ai/chart?title=&artist=&key=`,
`POST /ai/chart-read` (vision read of a scanned chart image;
`ANTHROPIC_READ_MODEL` overrides the default Haiku), `GET /health`.
