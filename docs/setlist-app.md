# Setlist app

`/lab/setlist` is a live-performance setlist/chart/annotation tool: songs,
setlists, chart links, and hand-drawn markup, usable on stage from a phone or
tablet. It's built as plain Astro + vanilla JS — no framework, no client-side
state library.

- Entry point: `src/pages/lab/setlist.astro`
- Hash-based router: `src/lib/setlist/app.js` (`#home`, `#library`,
  `#settings`, `#setlist/:id[/edit]`,
  `#song/:id[/:setlistId][/chart|/annotate[/scratch]]`,
  `#perform/:id/:songId`). The song page renders the chart (with read-only
  annotations) inline; `/annotate` opens the full-screen annotation editor
  straight in draw mode (a blank scratch page when no chart is linked —
  `/annotate/scratch` forces that even with one), and `/chart` is a legacy
  alias for the song page.
- Views are built with small DOM-builder helpers (`el()`/`btn()`) in
  `src/lib/setlist/views.js` — no JSX/templates.

## Data model

IndexedDB database `voidstar.setlist` (see `src/lib/setlist/store.js`), version 5:

| Store | Key | Shape |
|---|---|---|
| `songs` | `id` | `{id, title, artist, key, bpm, capo, keyChanges, steelEntry, steelSummary, spotifyUri, bandcampUrl, bandcampEmbedUrl, soundcloudUrl, chartUrl, altCharts, lyrics, syncedLyrics, genre, year, durationSec, artworkUrl, statuses, clearedFields, createdAt, updatedAt}` — `statuses` is an array of practice-status keys (`todo`/`needsWork`/`ok`/`goodToGo`/`steelLead`), toggled on the song page and badged on setlist/library rows. `bpm`/`capo` stay in the model (chart-doc headers and "read chart" still read/write them) but have **no edit UI** — the song form is key + key changes only. `syncedLyrics` is LRC text; `genre`/`year`/`durationSec`/`artworkUrl` come from "fetch info" (iTunes via the worker); `steelSummary` is the AI-drafted (hand-editable) steel direction — see the steel-summary section. `clearedFields` (`{field: timestamp}`, usually absent) tombstones **explicit deletes** (the summary block's delete button, emptying a field in the edit form) so the fill-empty backup merge doesn't resurrect them — see the merge section. `altCharts` (`[{id, url, label, addedAt}]`, lazy — usually absent) is the song's **alternate charts** (see the multiple-charts section): `chartUrl` stays the primary that perform mode / key-fill / health checks use |
| `notes` | `id` | `{id, songId, text, source, createdAt, updatedAt}` |
| `setlists` | `id` | `{id, name, sets:[{name, songIds[]}], gigDate, venue, spotifyUrl, bandcampUrl, soundcloudUrl, vocalistLegend, songOverrides, createdAt, updatedAt}` — the three media URLs are the setlist's *reference sources* for auto-link (Spotify playlist; Bandcamp band page, `/music`, or album link; SoundCloud profile or `/sets/` playlist) |
| `annotations` | `songId` | `{songId, strokes[], aspect, updatedAt}` — hand-drawn chart markup (pen/highlighter/text/arrow). The key is the bare `songId` for the **primary** chart's layer, or the composite `` `${songId}::${altId}` `` (`store.altChartKey`) for an alternate chart's — every chart has its own layer, no schema migration needed since the keyPath is a plain string |
| `charts` | `songId` | `{songId, blob, sourceUrl, mimeType, size, fetchedAt}` — cached chart for offline perform mode (plain text for Google-Doc charts, image bytes otherwise). Same key scheme as `annotations`: bare `songId` = primary, `` `${songId}::${altId}` `` = alternate |
| `snapshots` | `ts` | `{ts, label, data}` — rolling safety snapshots of the whole dataset (last 10), taken before a restore/sync/import so it can be undone |
| `deletions` | `key` (`${store}:${id}`) | `{key, store, id, deletedAt}` — record-level deletion tombstones; ride `exportAll()` so deletes propagate through the backup merge instead of resurrecting (180-day TTL, see the merge section) |

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
| `voidstar.setlist.sources` | localStorage | ✓ `sources` | worker URL + optional worker access token + personal/community Drive chart-folder ids (Settings) |
| `voidstar.setlist.gdrive.clientId` | localStorage | ✓ `settings.gdriveClientId` | Google OAuth client id — now an **optional override** (Settings → advanced): sign-in defaults to the app-owned client id (`src/lib/qualia/google-config.js`, `PUBLIC_GOOGLE_CLIENT_ID`); this key only overrides it for a self-host. Public identifier, not a secret |
| `voidstar.setlist.spotify.clientId` | localStorage | ✓ `settings.spotifyClientId` | Spotify client id — shared by the worker and the PKCE login |
| `voidstar.setlist.gdrive.token` | localStorage | ✗ | cached OAuth access token (~1 h) |
| `voidstar.setlist.gdrive.lastBackupAt` / `.lastHistoryAt` | localStorage | ✗ | backup + history-rotation throttle timestamps |
| `voidstar.setlist.gdrive.remoteModifiedTime` | localStorage | ✗ | the Drive data file's `modifiedTime` as of this device's last completed cycle — the load/refocus freshness check compares one cheap `files.list` against it and skips the full pull when nothing moved |
| `voidstar.setlist.gdrive.dirtyAt` | localStorage | ✗ | "local is ahead of Drive": set the instant a write schedules the debounced push, cleared when a cycle confirms Drive caught up — persisted so closing the tab inside the 3 s debounce can't strand an edit locally (the freshness skip is bypassed while it's set) |
| `voidstar.setlist.gdrive.backupsFolderId` / `.chartsFolderId` | localStorage | ✗ | cached Drive folder ids ("voidstar backups" / "voidstar charts") |
| `voidstar.setlist.chartAppearance.detail` / `.perform` | localStorage | ✗ | per-mode chart look, `'dark'` \| `'light'` (see the chart-appearance section); legacy `voidstar.setlist.invertChartDetail` / `.invertChart` migrate `1`→dark, `0`→light |
| `voidstar.setlist.chartEnhance` | localStorage | ✗ | "✦ enhance" auto-levels for cached image charts, `'1'` (default, on) \| `'0'` (see the chart-appearance section) |
| `voidstar.setlist.spotify.token` | localStorage | ✗ | Spotify user login (PKCE): `{accessToken, refreshToken, expiresAt}` (see the Spotify-links section) |
| `voidstar.setlist.spotify.pkce` | sessionStorage | ✗ | PKCE verifier + return hash, alive only during the login redirect round-trip |
| `voidstar.setlist.noteDraft.<songId>` | sessionStorage | ✗ | uncommitted note-composer draft (survives focus-driven `refresh()` and app-switching; cleared on save) |
| `voidstar.setlist.chartTab.<songId>` | sessionStorage | ✗ | which chart the song page shows: an `altCharts` entry id, absent = the primary (survives focus-driven `refresh()`; per-device on purpose) |

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

### todo ↔ mind tasks bridge

The `todo` chip (only that one) mirrors into a real task in the mind app,
two-way: chip on ⇒ task `sl:<songId>` appears in mind's `external-setlist`
tasklist (named "setlist", created lazily); completing or trashing that task
in mind clears the chip on the next reconcile; re-toggling the chip reopens
the task. Same-origin, direct IndexedDB — no queue, no shared Drive file.

- **Modules**: `todo-sync-core.js` (pure decision table, node-tested by
  `scripts/check-tasks-bridge.mjs`) + `mind-todo.js` (glue; the only setlist
  module that imports mind code) + `mind/external-tasks.js` (mind's write
  surface — see the external-writer contract in `docs/mind-app.md`).
- **Tie-breaker**: `song.todoStatusAt` (epoch ms), stamped on every todo-chip
  change. Like `statuses` itself it is deliberately **not** in
  `SONG_FILL_FIELDS`, so it always travels with the record under LWW merge.
  Reconciliation compares it against the task's `completedAt` / `deletedAt` /
  `updatedAt` — a pure function of the two synced records, no per-device
  state, so every device picks the same direction (no ping-pong). Records
  missing the stamp (pre-bridge) converge to *cleared*.
- **Task text** (`practice: <title>`) is bridge-owned: title edits re-canonicalize
  it on reconcile, and mind-side text edits get overwritten.
- **Reconcile triggers**: setlist boot, tab refocus (10 s min interval),
  after a Drive pull that changed records, and inline after a chip toggle or
  song delete (hard delete ⇒ task is tombstoned). All entry points are
  fire-and-forget behind try/catch — the bridge can never break setlist.
- **Cross-device latency**: the task reaches Drive only when the mind app
  next runs on that device (the bridge marks mind's dirty-shard flags but
  never drives mind's Drive client); same-device mind sees it instantly via
  the shared IndexedDB.

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

### "steel summary (AI)" — the steel direction for a song

`song.steelSummary` is a few concise sentences on what the steel guitar does
in the recording — presence/intensity, where it enters, style lineage ("heavy
honky-tonk a la Buddy Emmons"), signature moments — for quick reference while
studying and on stage. The song page's "steel summary (AI)" button calls the
worker's **`GET /ai/steel-summary`** (same provider chain, grounding, and
hallucination guards as `/ai/chart`: web search, `found:false` over invention,
`AI_MIN_CONFIDENCE` gate, server-side length clamp, 7-day response cache).
"No steel on the recording — fiddle covers that space" is a *valid, useful*
answer; `found:false` is only for a song the model can't verify at all.
Regenerating overwrites the previous summary (the tap is the consent), and the
edit-details form has a Steel Summary textarea for hand-tweaking the wording —
hand edits are just the field's value, so nothing distinguishes them from AI
text afterward. The summary renders as a cyan quick-reference block on the
song page (`.sl-steel-summary`) and in perform mode
(`.sl-perform-steel-summary`), always via `textContent`/`esc()` — it's model
output, never trusted HTML.

The summary is an AI **claim about a recording, so it can be wrong** — the
song page's block carries its own verdict controls
(`.sl-steel-summary-actions`): **✎ edit** (opens the edit form at the
textarea), **↻ redo** (regenerate — passes `fresh` to `fetchSteelSummary`,
which cache-busts the worker's 7-day response cache; a redo that replays the
cached answer looks like a dead button), **✗ wrong — retry** (passes
`retry`, which also tells the worker the previous summary was judged
inaccurate: the prompt demands deeper research and cross-checking, with a
bigger search budget, and the response is `no-store`), and **delete**
(confirms, then clears the field *and* writes a `clearedFields` tombstone so
the backup merge propagates the deletion instead of resurrecting the summary
from another device). The bulk missing-only pass passes neither flag and
keeps the cache's cost savings.

### Library tools — whole-library administrative passes

Library page → **"library tools"** (a collapsed panel, `buildLibraryTools` in
`views.js`; the passes live in `src/lib/setlist/bulk.js`) runs the song
page's per-song buttons across every song that still needs them, so keeping
the library filled in doesn't require opening songs one by one. The rule that
splits the two pages: Settings holds **config** (worker URL, chart-folder
sources, Spotify/Google accounts, Drive backup); anything that **operates on
song data** lives with the songs on the library page — and every library-wide
tool has a "this song only" counterpart on the song page. Every pass is
**fill-empty** (hand-set values are never overwritten), runs sequentially with
per-song progress in a status line, and lists failures as tappable rows that
open the song:

- **check library health** — read-only report of what's missing per dimension
  (no key / no chart / no lyrics / no Spotify link / no artist / no steel
  summary), each expandable into the actual songs. Start here. Per-song
  counterpart: the song page's **"checkup"** button, same dimensions via the
  shared `songHealth()`/`HEALTH_CHECKS` in `bulk.js`.
- **re-scan all charts** — `readChartFields()` per charted song: the "read
  chart" ladder (doc-text scrape → cache the chart bytes, which fills keys
  from text-chart headers → AI vision read of a scanned image) extracted from
  the song-page button so both run identical logic. The expensive vision rung
  only fires for songs still missing a key, so re-running the pass on an
  already-filled library is cheap. Per-song counterpart: **"read chart"**.
- **fetch info & lyrics** — "fetch info" library-wide: `/meta/song` metadata
  plus LRCLIB lyrics for every song missing any of it. Lyrics come straight
  from the browser, so this pass works even with no worker configured.
  Per-song counterpart: **"fetch info"**.
- **AI steel summaries** — drafts `steelSummary` for every song without one
  (missing-only: at ~15–30 s of grounded LLM per song, regeneration stays on
  the song page). Confirms with a song count before starting; a config
  problem (`no-ai-key`, outdated worker) aborts the pass with one message
  instead of failing N times — and so does any error that repeats on 3
  consecutive songs (an exhausted API credit balance surfaces as a 400 on
  every call, not as `no-ai-key`). Per-song counterpart: **"steel summary
  (AI)"** / "redo steel summary".
- **verify spotify links** — checks every linked song's Spotify track
  against its setlists' reference playlists and repairs the ones pointing
  elsewhere (see the Spotify-links section for the exact rules; this is the
  one pass that may *overwrite* a filled field, which is its whole point —
  it confirms before running). Per-song counterpart: **"relink spotify"**.

The panel also carries the other library-wide actions, each likewise paired
with a per-song tool: **auto-link now** (↔ "search for chart" + "relink
spotify"/"pick spotify track"), **download all charts** (↔ "cache offline"),
**batch link charts** (↔ the edit-details Chart URL field), and **spotify
quick-link**'s unlinked-songs list (↔ "spotify search" on songs without a
link). After a pass finishes, the library list re-pulls in place
(`onSongsChanged`) so new keys/artists/badges show without wiping the pass's
status line.

## Importing a pasted setlist (`import.js`)

The setlist-edit page's "Import Songs" textarea accepts freeform text-message
setlists. `parseTextList(text, {defaultArtist})` is deliberately **local and
rule-based** — no model call, works offline, deterministic:

- **Header lines.** The first one or two non-empty lines become setlist
  metadata instead of songs when they carry a positive signal: a date in any
  common shape (`6/14`, `12/31/26`, `2026-06-14`, `June 14`), a venue-ish
  word (bar/hall/brewery/…, or `setlist`/`gig`/`show`/`live at`), or an `@`
  ("nightjar @ the odditorium"). Two weaker corroborations also promote a
  signal-less first line: a blank line setting it off from the songs, or a
  date-dominant second line (`Moose Lodge` ⏎ `June 14`). A first line with
  none of that is just a song, so a bare song list loses nothing. Parsed
  metadata **fills empty setlist fields only** (venue ← header name when no
  separate venue was found, gigDate) and the import alert reports what was
  applied.
- **Track numbers** are stripped only when the paste is *mostly* a numbered
  list (≥ 60% of lines, min 2) — per-line stripping used to eat the 9 off an
  unnumbered "9 To 5".
- **Per-song artist/cover**: `Title (Artist cover)`, `(cover of Artist)`,
  `(by Artist)`, a bare 1–4-word parenthetical that isn't a performance note
  (`(acoustic)`, `(x2)`, `(capo 2)`… stay in the title), or a spaced-dash
  `Title - Artist`. A bare `(cover)` marks the song a cover with no artist.
- **Default artist** (input above the textarea, remembered in
  `voidstar.setlist.importArtist`): applied to every song with no explicit
  artist that isn't marked as a cover — pasting an originals set means typing
  the band name once. Existing library songs get it fill-empty only.
- The trailing single capital letter is still the **vocalist code**
  (per-setlist override), parsed before artist extraction.
- **Additive by default.** Importing adds the paste's songs to the existing
  sets (paste's Nth set → setlist's Nth set, extra sets appended; a song
  already anywhere on the setlist stays where it is and is counted in the
  report, so re-importing an updated text just adds what's new). The
  **"replace current sets" checkbox** opts into the old wipe-and-replace
  behavior. Both modes push the edit page's undo stack first, and vocalist
  codes apply either way.

Next to the import button, **"set artist on all songs…"** bulk-fills an
artist across every song already in the setlist — fill-empty like every
other bulk pass (songs that have an artist are skipped and counted in the
report).

## Scrape playlist → update setlist (`playlist-diff.js`)

The setlist-edit page's **"Scrape Playlist"** section treats the setlist's
Spotify reference playlist as the source of truth and applies what changed
to the sets — the counterpart to the song page's per-song "scrape playlist"
relink button, but for the whole setlist's membership and order. The button
reads the playlist via `getReferencePlaylistTracks` (user session → worker
API → public-page scrape fallback, same ladder and error reporting as
auto-link), diffs it against the sets, previews the changes in a confirm,
then applies:

- **Matching** is two-pass in `diffPlaylistAgainstSets`
  (`src/lib/setlist/playlist-diff.js`, pure data-in/data-out — node-tested
  by `scripts/check-setlist-playlist-diff.mjs` via `npm run check`): exact
  Spotify track-id first (a retitled-but-linked song must not read as
  deleted + added), then the same fuzzy title/artist matcher auto-link uses
  (`match.js`, threshold 0.7, artist mismatch sinks a candidate). Each track
  claims at most one setlist song.
- **Inserts** — playlist tracks not on the setlist are added right after the
  song of their nearest preceding playlist neighbor (consecutive new tracks
  chain in playlist order; no placed neighbor → top of the first set). New
  songs reuse an exact-titled library song when one exists, else are created
  with the track's artist + spotify link.
- **Removals** — setlist songs not matched by any track are offered in a
  **separate confirm** (never silent: an original that was never on Spotify
  looks identical to a deleted track, so the performer decides). Removed
  songs stay in the library. When the playlist was read by a **truncated**
  page scrape, removal detection is skipped entirely — a half-rendered page
  must not read as "the tail was deleted".
- **Re-ordering** — within each set, matched songs re-sort into playlist
  order; unmatched songs hold their exact positions, and set boundaries are
  never crossed (a playlist is one flat list — which set a song is in stays
  the performer's call).
- **Updates** — matched songs get artist / `spotifyUri` filled from the
  track, empty fields only, per the auto-link-never-overwrites rule.

The apply pushes the edit page's **↶ undo** stack first (sets membership and
order restore; created songs stay in the library, same as import undo), and
every failure path lands its real reason in the section's status line.

## Backup/Restore vs. Sync — these are different features

This codebase intentionally keeps two similarly-named ideas separate:

- **Backup / Restore** (`src/lib/setlist/gdrive-backup.js`) — pushes/pulls a
  single JSON file (`voidstar-setlist-data.json`) containing your entire
  local dataset to/from the user's own Google Drive (OAuth via Google
  Identity Services, `drive.file` scope). This is about **not losing your
  data** and having it available across devices (Android/Mac/Windows).
  Auth uses an **app-owned OAuth client id** ("Sign in with Google";
  `src/lib/qualia/google-config.js`), with the Settings → advanced client-id
  field as an optional self-host override — mirrors the mind app's change.
  - Auto-backup: every local write is debounced and pushed automatically
    once connected.
  - Manual: "back up now" / "restore from drive" buttons in Settings.
  - All paths — **including the debounced auto-push** — go through
    `pullMergePushCycle()`, which always pulls, merges, writes the merge
    back locally, then pushes it — so no path can blindly clobber either
    side. (The auto-push used to push blind; with two devices open, each
    push overwrote the other's changes in Drive.) The local import +
    pre-import snapshot are **skipped when the merge wouldn't change local
    state** (`mergeChangesLocal`, compared on the merged result) —
    otherwise every cycle would re-import identical data, fire the write
    hook, and schedule the next push forever. An `isSyncing()` flag
    serializes cycles so manual, auto-push, and focus-pull can't overlap.
  - **Merge semantics: newer wins per record, but a blank never beats
    content.** Records merge by `updatedAt`/`createdAt` (`mergeRecord` in
    `store.js`), and for songs/setlists the winner's **empty content
    fields fill from the loser** (`SONG_FILL_FIELDS` /
    `SETLIST_FILL_FIELDS`). Pure record-level newer-wins used to lose
    data across devices: a stale copy of a song that later got any small
    touch (a status toggle bumps `updatedAt`) replaced the whole record
    and wiped the steel summary / lyrics / chart link only the other
    device had. The exception is an **explicit delete**: the summary
    delete button and the edit form (emptying a previously-filled field)
    write a `clearedFields[field]` timestamp tombstone, and the fill only
    resurrects content *written after* the delete. `statuses` is
    deliberately not fill-protected (toggling one off is a routine
    intentional clear). The same merge-aware upsert backs
    `store.importAll` (and the setlist/song file imports), so importing a
    stale export file can't regress newer local records either.
  - **Record deletions carry tombstones.** Deleting a song/setlist/note/
    annotation writes a `{store, id, deletedAt}` tombstone into the local
    `deletions` store (same IDB transaction as the delete) and the ledger
    rides `exportAll()`. `mergeData` drops any record whose tombstone is at
    least as new as its last edit — so a delete survives the pull-merge-push
    cycle instead of being resurrected out of the Drive file by the additive
    record merge (which used to happen even single-device: delete → auto-push
    → pull re-added it). A record *edited after* its deletion beats the
    tombstone, which is then retired everywhere. Tombstones TTL out after
    180 days (`purgeExpiredDeletions`, run each boot); a device offline
    longer than that can still resurrect — same accepted limit as the mind
    app's tombstones. Covered by `scripts/check-setlist-merge.mjs`
    (`npm run check`).
  - **Restores are authoritative.** `replaceAll` (snapshot undo, Drive
    version restore) bumps every restored record's `updatedAt` to the
    restore time and mints tombstones for records the restore removes — so
    the restored state *wins* the next pull-merge-push instead of being
    newer-wins-reverted by the copies still in Drive (which is what used to
    happen: "undo last merge" only held until the next auto-push).
  - **Trash view (`#trash`, Settings → version safeguards → 🗑 trash).**
    Deletion tombstones snapshot the deleted record + a display label, so a
    deleted song/setlist/note is restorable for the tombstone's 180-day TTL
    — on any synced device (the merge preserves the snapshot). Restore
    re-inserts the record with a fresh `updatedAt` (authoritative) and drops
    the tombstone; "empty trash" forgets the stored payloads while keeping
    the bare tombstones so the deletes still propagate.
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
    client is configured but the OAuth token lapsed and no renewal has
    landed yet). The app also auto-pulls **on every fresh page load and
    whenever it regains focus/visibility** (`watchFocusSync()` in `app.js`,
    silent-only, throttled to one **attempt** per 30 s, app-wide, any hash —
    the load-time pull used to run only when the app opened on the
    dashboard) so opening it on another device always starts from the
    latest backup, never a stale local copy.
  - **Per-record "updated" stamps.** Dashboard setlist cards, the setlist
    view meta line, the setlist edit page, and the song page's badge row
    each show the record's `updatedAt` as a relative stamp
    (`updatedStamp()` in `views.js`, buckets shared with the backup pill
    via `formatRelativeTime`; exact local save time in the tooltip, and
    printed inline on the edit page). Comparing the stamp for the same
    record across two devices is the at-a-glance check for a backup that
    hasn't propagated. Deliberately absent from perform mode — the stage
    view stays clean.
  - **Token renewal is popup-bound** (the GIS token client has no iframe
    path — even `prompt:'none'` rides a popup window), so the backup module
    uses the same renewal machinery the mind app landed on: a single-flight
    `prompt:'none'` attempt with 5-minute failure throttles, plus
    `armGestureRenewal()` — a capture-phase pointerdown/keydown listener
    that renews the lapsed token synchronously inside the user's next real
    tap, then re-kicks the auto-pull. Controls that run their own
    interactive auth carry `data-sl-auth` so the gesture renewal never
    spends their tap's popup allowance. The focus pull arms its throttle
    *before* the token work and is in-flight-guarded: a failing renewal
    popup's open/close bounces focus back to the app window, and arming
    only on success used to turn that into an endless sign-in popup loop
    on the installed desktop app (where popups from the app window aren't
    blocked).
  - **Freshness is checked cheaply, so the automatic pulls cost almost
    nothing.** The load/refocus path goes through `pullMergePushIfStale()`:
    one Drive `files.list` metadata request compares the data file's
    `modifiedTime` against the stamp recorded at this device's last completed
    cycle, and only a mismatch (or a locally-dirty flag — see the state
    table) pays for the full pull→merge→push. Two supporting rules keep the
    stamps meaningful: the cycle **skips the push when Drive already holds
    exactly the merged data** (pushing identical bytes would bump
    `modifiedTime` and make every other device re-download for nothing), and
    every local write persists a **dirty flag** before the 3 s push debounce
    so an edit made just before the tab closes still gets pushed by the next
    load's cycle instead of being skipped as "remote unchanged". Manual
    buttons never take the shortcut — they always run the full cycle.
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
presents as "auto-link" ("auto-link now" in the library tools, "auto-link" on the
setlist page, "matching songs…" in the progress overlay). Internal
identifiers (`sync.js`, `runManualSync`, `sl-sync-*` CSS) keep their names.

### Streaming links: reference-only matching — auto-link never overwrites

Songs carry up to three independent listening links — `spotifyUri`,
`bandcampUrl`, `soundcloudUrl` — filled by auto-link from the matching
reference URL on the song's setlists (`setlist.spotifyUrl` /
`.bandcampUrl` / `.soundcloudUrl`). Bandcamp and SoundCloud exist because a
band's catalog often lives there and not on Spotify (nightjar being the
motivating case); the same fuzzy matcher, per-song scoping, and
cross-reference rules below apply to all three services. Neither Bandcamp
nor SoundCloud has an open API, so the worker scrapes what the pages
themselves embed: Bandcamp's `data-tralbum` JSON (`GET /media/bandcamp` —
a band page walks the `/music` discography grid, capped at 12 releases,
`truncated:true` past the cap) and SoundCloud's `window.__sc_hydration`
plus api-v2 with the site's own anonymous `client_id` scraped from its JS
bundles (`GET /media/soundcloud`). The Bandcamp scrape also returns each
track's `EmbeddedPlayer` URL (the numeric ids only exist in page markup) —
auto-link stores it in `song.bandcampEmbedUrl` so the song page can embed
the player without re-scraping; a hand-pasted Bandcamp link resolves it
lazily via `resolveBandcampEmbed` (plain link offline). SoundCloud's widget
takes the raw track URL, no lookup needed (`media.js`). The song page
embeds the first available player (Spotify → Bandcamp → SoundCloud), and
any of them arms the timecode timer for synced lyrics. The health check's
"no listen link" dimension counts any of the three.

### Spotify links: playlist-only matching — auto-link never overwrites

**Matching is playlist-only, and playlist scope is per song.** Auto-link
matches a song against the playlists of the setlists it actually appears in
(threshold 0.7, `findBestMatch`/`findBestMatchWithArtist` in `match.js`);
other setlists' playlists are only a near-exact-title fallback
(`CROSS_PLAYLIST_MIN_SCORE` 0.95 in `sync.js`), because a 0.9-scoring
containment match from an unrelated playlist is exactly how "Bye-Bye"
(Jo Dee Messina) used to grab "Bye Bye Bye" (*NSYNC). A clear **artist
mismatch sinks a candidate below the acceptance bar** (the `artistAdj`
penalty in `findBestMatchWithArtist`) instead of merely earning no bonus.
There is deliberately **no fallback to a global Spotify search** — an early
version searched by title when the playlist fetch failed, and the most
popular same-titled track (karaoke covers included) read as data
corruption. When a playlist can't be read, its songs stay unlinked and the
sync results say why; the song page's "spotify search" button (opens
Spotify search in a tab) is the explicit manual escape hatch for songs not
on any reference playlist.

Auto-link fills `spotifyUri` only when it's empty, so a wrong link sticks
until something explicitly checks it. Two fixes exist: the song page's
"relink spotify", and the library tools' **"verify spotify links"** pass
(`verifySpotifyLinks` in `bulk.js`) — for every linked song that appears in
a playlist-carrying setlist, a link that's already in the playlist passes;
a link pointing elsewhere is re-linked to the playlist's same-title track
when there's exactly one whose artist doesn't disagree; anything ambiguous
is flagged as a tappable row for a manual pick. The pass never guesses.

The song page's
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

**Playlist reads prefer the user's own Spotify session — since Spotify's
February 2026 Web API migration, it's the only API path that works.** That
migration (enforced 2026-03-09 for existing apps) renamed the
playlist-contents endpoint `GET /v1/playlists/{id}/tracks` →
`…/items` (the old path 403s for every development-mode app, no matter the
token type or the playlist being public), renamed each element's `track`
field to `item`, and made contents **owner-only**: Spotify returns a
playlist's items only to a user token whose account owns or collaborates
on the playlist — a client-credentials token (no user) gets metadata with
no items at all. Both `fetchPlaylistTracksAsUser` (`sync.js`) and the
worker's `/spotify/playlist/:id` route call `/items` and parse
`item.item || item.track` (the latter for extended-quota apps, which kept
the old shape); a 200 whose first page has no `items` array is the
"metadata only" non-owner answer and raises an explanatory error instead
of reading as an empty playlist. `src/lib/setlist/spotify-auth.js`
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
append a "connect spotify in Settings" hint when no user session exists —
and when a session DOES exist but its read failed, the error includes that
failure too ("Reading it as your connected Spotify account also failed:
…"), because the user-token error carries the actionable half (e.g. the
owner-only rule) and swallowing it used to leave a dead-end message.

**Public-page scrape — the escape hatch for playlists the API won't
serve.** The owner-only rule leaves a public playlist owned by someone
else (the bandmate's-reference-playlist case) unreadable by ANY token this
app can hold, but the public `open.spotify.com` pages still render it for
anonymous visitors, track list included. The worker's
`GET /spotify/playlist/:id/scrape` fetches the embed page
(`open.spotify.com/embed/playlist/:id`, historically the richest anonymous
render) then the full playlist page, harvests every JSON blob in the HTML
(plain `<script>` JSON, the legacy percent-encoded `resource` blob,
base64-wrapped JSON), and deep-scans for arrays of track-shaped objects
(`scrapedSpotifyTrack` tolerates embed `{uri, title, subtitle}`, API-style
`{track:{…}}`/`{item:{…}}`, and web-player GraphQL shapes) rather than
trusting one fixed path — Spotify reshuffles page internals without
notice, same defensive posture as the Bandcamp/SoundCloud/UG scrapers. The
response carries `{tracks, total, truncated, source}`; `total` comes from a
`trackCount`-style field or `music:song_count` meta so a partial render is
reported instead of passing as the whole playlist. Client side,
`fetchSpotifyTracks` calls the scrape automatically as a last resort when
both API reads fail (so bulk auto-link recovers on its own, with a note in
the sync warnings), and the song page has an explicit "scrape playlist"
button (`{forceScrape: true}` → `getReferencePlaylistTracks`) that skips
the doomed API attempts and feeds the same relink picker. Scraping only
sees PUBLIC playlists — a private one fails both paths, and the API errors
remain the explanation shown.
Settings also live-checks the session on render (`checkSpotifyConnection`
→ `GET /v1/me`) and shows "Connected as <name>" or the actual rejection —
a token can be present yet revoked (e.g. the account was removed from a
development-mode app's User Management), and that must surface in
Settings, not as a cryptic auto-link failure later.
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
worker's client credentials, which the Feb 2026 migration left working
for that endpoint (dev-mode search is capped at 10 results per request;
the worker asks for 1).

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
     sections, split bars, and playing notes. Providers form a failover
     chain — Claude (`ANTHROPIC_API_KEY`, `web_search` server tool, default
     model `claude-opus-4-8`), then OpenAI (`OPENAI_API_KEY`, Responses API
     `web_search` tool, default `gpt-5-mini`), then Gemini
     (`GEMINI_API_KEY`, Google Search grounding, default `gemini-2.5-flash`,
     free tier at aistudio.google.com/apikey) — whichever are configured. A
     provider that **errors** (rate limit, exhausted credits) or can't
     verify the song falls through to the next; when all fail, the `reason`
     lists each provider's actual failure plus which providers were skipped
     for having no key, so "why didn't it fail over?" is answerable from
     the client. Hallucination guards, in layers: search grounding, a
     prompt contract that demands `found:false` over invention, a numeric
     confidence gate (`AI_MIN_CONFIDENCE`), server-side
     normalization/clamping of the JSON (`normalizeAiChart`), source URLs +
     confidence printed in the doc footer, and a verify-by-ear note.
     Responses cache for 7 days; `retry=1` (sent by "rebuild doc" and the
     mark-wrong flows) cache-busts, tells the model the previous answer was
     judged inaccurate, raises the search budget, and returns `no-store`.
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
   same ladder for a song that already has a chart (with `retry=1`, so the
   AI tier re-researches instead of replaying its 7-day cache) and replaces
   the link — but **never discards the old doc without an explicit choice**:
   the user picks trash (`trashChartDoc` — Drive's trash, recoverable for
   ~30 days, never a hard delete) or keep (`archiveChartDoc`, which renames
   it "(replaced <date>)" so it doesn't shadow the new doc in the charts
   folder). Both only touch app-created docs — drive.file scope can't reach
   community charts, so those just unlink.

Tiers 1–3 are available per-song via `searchChartForSong()` in `sync.js`
(the "search for chart" button, which reports its stage and returns
`{found, tier, candidates, providerDown}`); tiers 1+2 also run in the bulk
"auto-link now" action in the library tools panel.

**Tier 5, by hand — scratch charts.** For originals (or anything research
can't find), "draw chart" on a chartless song opens the annotation editor
in **scratch mode**: instead of a chart, the stage is a blank paper page
(`.sl-scratch-stage`, US-letter aspect, dark default ink) drawn/typed with
the normal annotation tools. A chartless song's `/annotate` route enters
scratch mode implicitly; `/annotate/scratch` forces it even with a doc
linked ("scratch chart" on the song page — confirmed first, since a song
has ONE annotation layer and saving the scratch page replaces the linked
chart's annotations). "+ page" grows the page a letter-height at a time
(existing ink's normalized `y` is rescaled by oldHeight/newHeight so
nothing stretches). "make doc" renders the page to a PNG
(`renderStrokesToPngBlob` in `annotation.js` — WYSIWYG paper background;
text sizes are width-relative and follow the export width by themselves,
pen/arrow widths scale by exportWidth/authoringWidth), uploads it into the
same "voidstar charts" folder (`createChartImageFile`, link-shared like
`createChartDoc`), then offers: **link it as the song's chart and clear
the ink** (the PNG blob also primes the offline cache directly, and the
song's annotation record is deleted — the drawing now lives in the doc,
which rides the normal scanned-image pipeline and can be annotated afresh
on top), or **keep it as a Drive export** with the drawing still editable.
Deliberately a PNG, not a Docs conversion: the content is ink. A scratch
WIP that hasn't been exported yet still shows on the song page via
`renderInlineScratch` (read-only paper preview); perform mode only shows
charts, so exporting+linking is what makes a scratch chart stage-ready.

**Diagnosability:** every "found nothing" path says why instead of failing
silently — a bot-blocked keyless search engine surfaces as `providerDown`
("web search blocked — add search key" on the button; fix by setting
`GOOGLE_CSE_ID` or `BRAVE_SEARCH_API_KEY` on the worker), an old worker
deploy missing the `/web/*` routes shows "worker outdated", and
`/web/chart-data` responses list the URLs `tried`. The client logs details
to the console with a `[setlist]` prefix.

## Multiple charts per song — primary + alternates

A song can carry more than one chart (different arrangements, NNS vs. lyric
sheet, a bandmate's copy). `song.chartUrl` remains the **primary** and is the
only chart the single-chart machinery ever touches — perform mode, key
auto-fill (`maybeFillKeyFromChart`, `cacheChartForSong`'s header parse),
"read chart", health checks, bulk offline counts, "rebuild doc", and scratch
export are all primary-only by design. **Alternates** live in
`song.altCharts: [{id, url, label, addedAt}]` (lazy field; protected by
`SONG_FILL_FIELDS` like `chartUrl`) and are a song-page feature:

- **Adding:** the charted song page's **"find alt chart"** button runs the
  same Drive + web search as "search for chart" but *collect-only*
  (`searchChartForSong(song, cb, {collectOnly: true})` in `sync.js`): the
  Drive folder tiers return ranked candidates instead of auto-applying
  (`applyDriveMatchToSong` refuses charted songs anyway), and the ≥ 0.85 web
  auto-link is bypassed — a confident hit must not silently overwrite the
  primary. Every candidate lands in the picker with **"add alt"** (append,
  label defaulted from the file/candidate name) and **"make primary"**
  (demotes the current primary to an alternate — never discards it — moving
  its annotation layer and cached blob to the alternate's composite key,
  then links the candidate via `linkChartCandidate`).
- **Switching:** with alternates present the song page shows a chip row
  (`.sl-chart-tabs`); the selection lives in sessionStorage
  (`chartTab.<songId>`, see the state table). The selected alternate gets an
  action strip: annotate / open doc / rename / cache offline / make primary
  (`swapPrimaryWithAlt` — URLs, annotation layers, and cached blobs all
  swap) / remove (deletes the alternate's annotation + blob records; the
  Drive doc itself is untouched).
- **Per-chart annotations:** every chart has its own full annotation layer.
  Alternates key theirs (and their offline blobs) by
  `store.altChartKey(songId, altId)` = `` `${songId}::${altId}` `` in the
  existing `annotations`/`charts` stores — no DB migration, and composite
  records ride the Drive backup automatically (the merge is key-generic).
  The editor route is `#song/:id/:setlistId/annotate/alt:<altId>` (the same
  `extra3` slot `scratch` uses); a stale alt id bails back to the song page.
  Alt-annotate never enters scratch mode (an alternate always has a URL).
- **Offline:** alternates warm the cache lazily when viewed, plus a per-alt
  "cache offline" button (`cacheChartByUrl` — deliberately **no key
  auto-fill**: an alternate may be a different arrangement in a different
  key, and filling `song.key` from it would poison the primary's data).
  Bulk "download all charts" and the offline N/M counts deliberately ignore
  alternates (they count real song ids only).
- **Old clients** ignore `altCharts` and the composite-key records safely.
  Known accepted edge: an old client whose newer song copy predates the
  alternates can transiently drop `altCharts` on that device — the next
  merge against a new client fill-restores it. Removing an alternate doesn't
  tombstone its annotation record, so a harmless orphan can linger in Drive
  backups (annotation deletion has never propagated through the merge).

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
font is a pinned stack sized relative to `canvas.width` (a stroke's `size`
is in width/200 units), because stroke coordinates are normalized to that
box — a fixed pixel size would give the text a different normalized
footprint on every device. New text strokes map the shared Fine/Medium/Thick
pen widths up through `textSizeForWidth` (2/4/8 → 8/14/22, i.e. 4%/7%/11%
of chart width): as raw pen widths the font came out ≈2% of width,
illegible next to the chart's own 3.4%-of-width body type. The mapped value
is stored per stroke, so pre-mapping annotations render at their authored
size. (Also: `var(--font-mono)` is invalid inside a canvas font string and
gets silently ignored — that once left all text annotations at the canvas
default 10px sans-serif, immune to the size picker.) Selected text elements
get a bottom-right corner handle for continuous drag-resize; `stroke.size`
stays the single source of scale and may be fractional.

## Chart rendering on the song page (and how "appearance" works)

`renderInlineChart()` (song page) and perform mode pick a chart rendering
in this order (the song page renders whichever chart the chip row selects —
primary or an alternate, each with its own annotation layer and cache key;
perform mode always renders the primary):

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
  Android. Mark such controls with `data-sl-auth` so the app-wide
  gesture-renewal listener (`armGestureRenewal`) leaves their tap's popup
  allowance alone.
- **Background renewals must be throttled and single-flight.** Even
  `prompt:'none'` opens a popup (no iframe path in the GIS token client).
  Where popups are *allowed* — the installed desktop app window — an
  unthrottled retry loop becomes a visible popup blitz: the popup's
  open/close bounces focus back to the window, refires the focus pull,
  and spawns the next popup. Throttle attempts (not successes) and
  collapse concurrent callers onto one in-flight renewal
  (`renewSilentlyOnce` in `gdrive-backup.js`).
- **`window.open` after async work is blocked too.** When a long flow ends
  by opening the new doc, `window.open` can return `null` on mobile;
  `showLinkToast()` (`views.js`) is the fallback — a toast holding a real
  `<a>` the user taps.
- **Typed-but-uncommitted input must survive re-renders.** The app-wide
  focus pull (`watchFocusSync`) calls `refresh()`, which rebuilds the
  view — classic Android flow: type half a note, check something in
  another app, come back to an empty box. The note composer mirrors every
  keystroke to `sessionStorage` (`noteDraft.<songId>`) and restores it on
  render; saving clears it. The same guard covers ink: `refresh()` is
  skipped while `uiBusyEditing()` (`app.js`) is true — mid-typing, or the
  annotation editor in draw mode (its canvas carries `data-drawing`),
  whose unsaved strokes live only in that canvas.
- **Swipe-to-navigate lives only in perform mode.** The song page had it
  and lost it — dragging a text selection in the notes field reads as a
  swipe. Song-page navigation is the prev/next buttons only.
- **One finger draws, two fingers scroll.** The annotation canvas spans the
  whole chart with `touch-action: none`, so with a drawing tool active no
  single-finger touch can ever scroll a long document. `annotation.js`
  tracks active pointers: a second finger landing cancels the first
  finger's half-drawn stroke (it was scroll intent, not ink) and pans the
  `.sl-annotation-wrap` scroll viewport by the gesture's centroid delta;
  the gesture stays a scroll until every finger lifts. The 🖐 pan tool
  remains for one-finger momentum scrolling, and the wrap sets
  `overscroll-behavior: contain` so a scroll ending at the top edge can't
  chain into Android Chrome's pull-to-refresh and reload away unsaved ink
  (the page's `html, body` additionally set `overscroll-behavior: none` —
  the app never wants pull-to-refresh or the browser's swipe-back history
  gesture).
- **An edge swipe while inking must not eat unsaved strokes.** Drawing in
  a chart's margins is easily read by the browser/OS as the back gesture,
  which pops the hash route and used to tear the editor down with all
  unsaved ink. `annotation.js` tracks a dirty flag (every committed
  mutation sets it, save clears it; exposed as `isDirty()`/`save()` on the
  controller) and `renderAnnotation` layers three defenses: entering draw
  mode pushes a same-hash **history guard entry**, so a back gesture pops
  the guard instead of the route — with unsaved ink it auto-saves, re-arms
  the guard, and toasts ("swipe back again to leave"); with nothing
  unsaved it's honored as a real exit. Any other teardown (hashchange
  while drawing) auto-saves dirty ink on the way out, and `beforeunload`
  warns + best-effort-saves on reload/close.
- **Pen color is remembered.** The color picker defaults to the last-used
  ink (`voidstar.setlist.annColor`; scratch mode has its own
  `…annColorScratch` memory, falling back to near-black — on paper, dark
  ink is the chart, not markup), so a performer who always marks charts in
  one color isn't re-picking it on every song.
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
DuckDuckGo HTML scrape. Optional, for the `/ai/*` routes: any of
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (+
`ANTHROPIC_MODEL`/`OPENAI_MODEL`/`GEMINI_MODEL` overrides) — they form the
Claude → OpenAI → Gemini failover chain, so setting more than one keeps AI
features alive when one account hits its usage limit.
Also `ALLOWED_ORIGIN` (plain var in `wrangler.toml`).

The worker imports `@anthropic-ai/sdk`, so run `npm ci` at the repo root
before `wrangler deploy` (wrangler bundles it from `node_modules`).

**Deploys are automated**: `.github/workflows/deploy-setlist-sync.yml`
runs `wrangler deploy` on every push to `main` that touches
`workers/setlist-sync/**` (or the lockfile/workflow itself), using the
`CLOUDFLARE_API_TOKEN` repo Actions secret. It pushes the three required
worker secrets from same-named repo secrets on every deploy, and the
optional ones (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`GOOGLE_CSE_ID`, `BRAVE_SEARCH_API_KEY`) only when set in the repo — an
unset optional secret is skipped, never overwritten with an empty value. To enable AI
chart reading/drafting, add one of the AI keys under GitHub → Settings →
Secrets and variables → Actions and re-run the workflow. Manual
`npx wrangler deploy -c workers/setlist-sync/wrangler.toml` still works
for one-offs. The app's Settings "worker URL" must point at the worker
this workflow deploys (`voidstar-setlist-sync.<subdomain>.workers.dev`) —
a stale URL to an older, differently-named worker surfaces as
"worker outdated" on routes added since.

Routes: `GET /spotify/playlist/:id`, `GET /spotify/search`,
`POST /spotify/search-batch`,
`GET /media/bandcamp?url=` / `GET /media/soundcloud?url=` (track lists
scraped from Bandcamp/SoundCloud pages for auto-link —
`{tracks:[{title, artist, url, embedUrl}], truncated}`),
`GET /drive/folder/:id`,
`GET /drive/folder/:id/recursive`, `GET /drive/file/:id/meta`,
`GET /drive/file/:id/text`, `GET /drive/file/:id/image`,
`GET /web/chart-search?title=&artist=`,
`GET /web/chart-data?title=&artist=`,
`GET /meta/song?title=&artist=&spotifyId=` (BPM/key/time + iTunes
artist/genre/year/artwork/duration),
`GET /ai/chart?title=&artist=&key=[&retry=1]`,
`POST /ai/chart-read` (vision read of a scanned chart image;
`ANTHROPIC_READ_MODEL` overrides the default Haiku),
`GET /ai/steel-summary?title=&artist=[&retry=1]` (concise steel-direction
summary, same provider chain and guards as `/ai/chart`; `retry=1` on both
`/ai/*` GET routes = "previous answer was wrong, research harder, don't
cache"), `GET /health`.

**Access control.** CORS is not access control (a non-browser client ignores
it), so a public worker's AI/Spotify/Drive quota is spendable by anyone who
learns the URL. Set a `WORKER_TOKEN` secret (`wrangler secret put
WORKER_TOKEN`) and the same value in the app (Settings → sync worker → access
token, which rides the Drive backup to every device): every route except `/`
and `/health` then requires a matching `X-Worker-Token` header (constant-time
compare) and returns `401` otherwise. When the secret is unset the worker
stays open for back-compat, so protection is opt-in. A best-effort per-IP
token bucket (60 req/min, in-memory, per-colo) also throttles a single client
hammering the expensive routes — it's a cost blunt, not a hard global limit;
the token is the real gate.
