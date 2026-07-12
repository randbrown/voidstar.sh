# mind — local-first second-brain notes app (`/lab/mind`)

A standalone lab app (like `/lab/setlist`): quick note capture, a pinned TODO
framework, folders, voice notes, image OCR, stylus annotation, and cross-device
sync through the user's own Google Drive. Everything lives in the browser
(IndexedDB `voidstar.mind`); no server. Inspired by early Evernote — capture
first, zero bloat.

Source: `src/lib/mind/` · page: `src/pages/lab/mind.astro` · manifest:
`public/manifest-mind.webmanifest` (installable PWA, own start_url/scope).

## Architecture

| Piece | File(s) | Notes |
|---|---|---|
| Store | `store.js` | Raw IndexedDB, forked from `setlist/store.js`. Stores: notes, folders, tasks, tasklists, attachments (metadata), blobs (local-only binaries), annotations, snapshots. Soft-delete tombstones everywhere (`deletedAt`, 30-day TTL) so deletions propagate through sync. `setOnWrite` hook drives search invalidation + debounced Drive push. |
| Editor | `editor/{schema,markdown,nodeviews,setup}.js` | ProseMirror with a markdown-constrained schema. **The note body markdown string is canonical**; the editor is a surface. Custom nodes: `task_item` (interactive checkbox, stable id), `image` (`mn-attach://<id>` resolves from IDB). Round-trips via `prosemirror-markdown` + a doc-walk that lifts `- [ ] text <!--t:id-->` into task items. |
| Tasks-in-notes | `tasks-sync.js` | Note body is canonical for note-sourced tasks; records (id = the `<!--t:id-->` marker) are a materialized index reconciled on save. Checking from a list view rewrites the body line first (`setTaskDoneEverywhere`). Completed tasks strike through for 24 h, then archive (`rollOffCompletedTasks`). |
| Folders | in `store.js` + `views/home.js` | Surrogate-keyed hierarchy (`{id, name, parentId}`); notes/tasklists carry `folderId`. Soft filter: out-of-scope content renders dimmed ("elsewhere"), never hidden. Per-folder TODO lists are lazy with deterministic ids (`todo-<folderId>`) so devices converge. |
| Search | `search.js` | In-memory index over title/body/OCR text/transcripts/tags + task text; token AND-match + kind/tag filters behind `query(q, filters)`. Rebuilt lazily after writes. |
| Voice | `voice.js`, `voice-capture.js`, `audio-out.js` | Web Speech dictation (continuous, restart loop, final dedupe) + MediaRecorder on the same mic; keep-audio / insert-transcript toggles; record-only fallback on contention. An **inline mic picker** (`qualia/devices.js` `wirePicker`) sits on **every** voice-recorder surface — the in-note voice bar (`editor.js`) and the hands-free capture view (`capture.js`) — so the input is chosen in place, never via settings; it persists to `voidstar.mind.micId`, refreshes device labels once permission is granted, shows only when >1 mic exists (the capture view; the voice bar always shows), and **switching mid-recording restarts on the new device** (the editor commits the in-progress segment first so nothing is lost). Speaker via `setSinkId` (hidden on Safari). |
| OCR | `ocr.js` | tesseract.js lazy-loaded from CDN on first image; serial idle queue over `ocrStatus='pending'`; text stored on the attachment (searchable, rides sync so other devices never re-OCR). Settings → *images & text recognition* is a status panel: counts (recognized / queued-here / **awaiting-download** / failed), live drain progress, process-now + retry-failed — so a large "N pending" that's really waiting on binaries to sync down from Drive isn't a mystery (`ocrStatusReport`/`retryFailedOcr`). |
| Annotation | `annotation.js`, `views/annotate.js` | Forked from `setlist/annotation.js`: pen (with stylus pressure), highlighter, arrow, rect, ellipse, text, eraser, select, pan; shared palette/size scale; two-finger scroll; autosaves; flatten-to-copy export. Keyed `attachmentId[:page]` (page reserved for PDFs). |
| Drive sync | `gdrive-sync.js`, `shard.js`, `attachments-drive.js` | GIS auth, drive.file scope, **app-owned OAuth client id** ("Sign in with Google", user override in Settings → advanced). **Incremental sharded sync**: `shard.js` (pure bucketing/hash/merge core, tested by `scripts/check-mind-shard.mjs`) + a `gdrive-sync.js` client that pushes/pulls only changed shards. Also: peek freshness gate, persisted dirty flag, **conflict copies**, **attachment binaries** (below), and duplicate-file/folder healing (below). |
| Import/export | `import-doc.js`, `dates.js`, `export.js`, `views/import-doc-modal.js`, `gdrive-picker.js` | Whole-document import (split into notes) + single-doc markdown export + JSON/zip. See the import/export section below. |

## Sync model

- Everything lives under **one top-level `voidstar_mind/` folder** in My Drive
  (created/discovered via `getRootFolderId`; `drive.file` scope, so the app only
  sees files it made). Inside it:
  - `index.json` — the small, global part: `folders`, `tasklists`, `settings`,
    plus `schema` + shard count `N`.
  - `shards/shard-000.json … shard-(N-1).json` — the parts that scale: `notes`,
    `tasks`, attachment *metadata*, `annotations`, bucketed by
    `bucket(key) = fnv1a(key) % N` (N=64; notes/tasks/attachments by `id`,
    annotations by `key`). **Empty buckets are never materialized.**
  - `attachments/` — attachment binaries (below).
  - `backups/` — consolidated restore points, now written only on a manual/forced
    sync (Drive keeps native per-file revisions on each shard for the rest).
- **Sharded sync** (`shard.js` pure core + `gdrive-sync.js` client) — an edit
  re-uploads one small shard, not the whole corpus:
  - `push` re-hashes only the shards a write actually touched (see dirty-tracking
    below), comparing each shard's *canonical* JSON hash (key- and array-sorted,
    so two devices agree byte-for-byte) to the last-known-remote hash and
    uploading only the divergent ones; each file's `{id, mtime, hash}` is
    persisted the instant its own upload succeeds.
  - `pull` downloads only shards whose `modifiedTime` advanced past our stamp and
    returns a **partial** remote; the cycle merges **full local ⋈ partial remote**
    (unchanged buckets are already fully local, so this is equivalent to a full
    merge — and keeps the conflict-copy dedup corpus complete), imports only the
    delta, then `commit()`s the pulled stamps *after* the import (crash-safe).
  - `peek` compares shard/index/monolith `modifiedTime`s in one listing.
  - Per-device state lives in `voidstar.mind.gdrive.shardState`
    (`{ files: { name → {id,mtime,hash} }, foldStamp }`).
  - **Dirty-shard tracking**: the store write hook passes `{store,key}` to
    `markShardDirty`, which records the touched bucket(s) (or `index`, or `all`
    for a blanket write like a tombstone purge / snapshot restore) in
    `voidstar.mind.gdrive.dirtyShards`. `push` drains that set and re-hashes only
    those buckets — so a one-note edit hashes one shard, not the whole corpus.
    First run on this version (absent key) defaults to `all` (a one-time full
    re-hash); the set is requeued on a failed push so nothing is lost.
- Attachment *binaries* are individual files in the `attachments/` subfolder,
  uploaded serially (pending = `driveFileId:''`, so queue state survives tab
  death and rides the JSON); other devices lazy-download on first render
  (`setBlobFetcher` in `attachments.js`).
- **Dead inline-image self-heal** (`attach-heal.js`, pure, tested by
  `scripts/check-mind-attach-heal.mjs`): a note whose body `mn-attach://<id>`
  points at a *trashed/duplicated* attachment still renders on the device that
  made the edit (the trashed blob outlives the tombstone locally) but shows
  "image unavailable" everywhere else. On note open, `healBodyAttachmentRefs`
  repoints such a dead reference to the note's live same-image survivor (matched
  by name+kind, or a sole spare live image — never an ambiguous guess) and the
  corrected body syncs out. Trashing an attachment via the chip `×` now also
  strips its inline image (`editor.removeImage`) so no new dead refs are minted.
- **Migration** — two one-time, guarded steps that lose no data:
  - *Consolidation* (`migrateToRootFolder`): the earliest layout scattered a loose
    `voidstar-mind-data.json` + `voidstar mind attachments/` + `voidstar mind
    backups/` at the Drive root; they're re-parented into `voidstar_mind/` and the
    folders renamed `attachments/` / `backups/`.
  - *Monolith → shards* (dual-**read**, never dual-write): while the single
    `voidstar-mind-data.json` still exists, `readMonolithIfAdvanced` folds it into
    local each time an old-code device advances it; the next `push` writes the
    sharded layout. The monolith is left **frozen** as a pre-migration backup
    (retired manually/by TTL later), so a device still on old code stays visible.
    Fresh installs just create `index.json` + `shards/` directly.
- **Duplicate-file/folder healing**: `pull()` dedups duplicate `index.json` /
  `shard-NNN.json` files by name (merge records → keep one → trash the rest), and
  `getShardsFolderId` folds duplicate `shards/` folders into the oldest — the
  same convergence story as the root-folder heal below.
- **Duplicate root-folder healing** (`getRootFolderId` + `mergeFolderInto`):
  the sync cycle and the attachment-upload queue run under separate locks, so a
  cold id cache let both create their own top-level `voidstar_mind/` (one ended
  up with the data file, the other with `attachments/` + `backups/`). Now folder
  resolution is serialized per cache key by an in-flight promise, and a cold
  `getRootFolderId` lists ALL `voidstar_mind` folders: >1 → keep the oldest
  (deterministic, so devices converge) and fold the rest in (children
  re-parented, same-named subfolders merged, empties trashed — recoverable).
  `healRootFoldersOnce` forces this one merge pass on existing split installs
  (whose warm cache would otherwise never re-scan). Duplicate *data files* that
  land side by side are still healed by `pull()` (merge + trash).
- Merge: per-record newer-wins with fill-fields (blank never erases content;
  `ATTACHMENT_FILL_FIELDS` protects OCR text/transcripts/driveFileId).
  Tombstones propagate deletes; latest timestamp wins.
- **Conflict copies**: a note edited on both sides since this device's last
  completed cycle (`lastCycleAt` stamp) with differing bodies resolves
  last-write-wins, and the losing body is preserved as a new
  `Conflicted copy of <title> (<device>, <time>)` note (`conflictOf` set,
  amber badge, deduped so both devices don't mint twins). First-ever sync is
  plain LWW — no baseline, no copy spam. Tapping the badge (or Settings → data →
  "resolve conflicts") opens the **merge tool** (`merge.js` pure LCS diff, tested
  by `scripts/check-mind-merge.mjs`, + `views/conflict-modal.js`): a hunk-by-hunk
  diff of the live note vs the copy with per-change *keep current / use copy /
  keep both* choices, which writes the merged body back to the live note and
  trashes the copy. An orphaned copy (base deleted) can be kept as its own note.
- Auto-sync: pull on load/refocus (`watchFocusSync`, silent, 30 s throttle,
  peek-gated), debounced push 3 s after any write, offline flush on reconnect,
  status pill on the home header.
- **Local snapshots** (`putSnapshot`, IDB, restore in Settings → data) are full
  copies, so the frequent auto `'pre-sync'` one is **size-gated**
  (`SNAPSHOT_MAX_NOTES`): above it, undo-last-sync is unavailable, but explicit
  `'pre-import'` / `'pre-doc-import'` snapshots are always kept.
- **Accepted v1 limits**: no cross-shard atomicity (a partial push can transiently
  expose a note before its folder/attachment shard lands — self-heals next cycle;
  the UI already tolerates it). The pure core is covered by
  `node scripts/check-mind-shard.mjs` (`npm run check`).

## Conventions

- Class prefix `mn-`, theme via `src/styles/themes.css` custom props only.
- Auto-titles are sortable ISO local time (`2026-07-08 14:32`; seconds on
  same-minute collision). Generated filenames use `fileStamp()`
  (`20260708-143207-…`). Rename prefills the first body line (`autoTitle` flag).
- Note links are ordinary markdown links to `#note/<id>` (id-based —
  rename-proof). Backlinks are computed by scan (`backlinksTo`).
- localStorage namespace `voidstar.mind.*`.

## External tasks (setlist todo bridge)

Other same-origin apps can own tasks in mind. Today that's the setlist app:
its `todo` practice-status chip mirrors to task id `sl:<songId>` in the
deterministic tasklist `external-setlist` (named "setlist"), with a
`sourceUrl` field (`/lab/setlist#song/<id>`) that task rows render as an
`↗ open in setlist` link (the non-note sibling of `sourceNoteId`). Completing
or trashing such a task is picked up by setlist's reconciler and clears the
chip; the reverse flows too (see `docs/setlist-app.md` for the decision
table). `tasks-sync.js` never touches these tasks (it only reconciles
`sourceNoteId` tasks), and quick-added tasks without the `sl:` prefix in that
list are left alone by the bridge.

**External-writer contract** (`external-tasks.js` — the only sanctioned write
surface): mind's sharded Drive push uploads **only dirty-flagged shards**
(`pushSharded` drains `voidstar.mind.gdrive.dirtyShards`), and
`pullMergePushIfStale` skips the whole cycle unless `…gdrive.dirtyAt` is set.
Those flags are normally maintained by the store write hook wired in
`initMindApp` — which is NOT active on other apps' pages. Any module writing
mind's store from outside the mind app must therefore call
`markShardDirty(info)` + `markLocalDirty()` (`gdrive-sync.js`) after every
write, or the change sits in IndexedDB forever and silently never reaches
Drive. Never register `store.setOnWrite` from an external page — it would
clobber mind's own hook. Corollary: an externally written task reaches Drive
only when the mind app next runs on that device.

## P4 additions

- **Dock**: the main menu (notes / new note / tasks / settings) is a floating
  dock placeable top/bottom/left/right — a per-device preference
  (`voidstar.mind.dockPos`, default bottom), set in settings. `app.js`
  renders it; `body[data-mn-dock]` drives the CSS.
- **PDF** (`pdf.js`): pdfjs-dist **legacy build** (the modern build needs
  bleeding-edge JS like `Map.getOrInsertComputed`), dynamically imported.
  PDFs annotate one rasterized page at a time (strokes keyed `attId:page`,
  pager in the annotate top bar). Text extraction reads the real text layer
  first; only scanned PDFs pay for rasterize+tesseract (capped
  `OCR_MAX_PAGES`).
- **Whisper** (`whisper.js`): on-device re-transcribe of kept audio —
  transformers.js from CDN at first use, `whisper-tiny.en` q8 (~40 MB,
  browser-cached). Buttons on every audio chip: transcribe/re-transcribe +
  insert-into-note. `transcriptSource` becomes `'whisper'`.
- **Share target**: `manifest-mind.webmanifest` registers a GET
  `share_target`; `app.js` turns `?title/text/url` into a new note on launch
  (Android "share to mind" once installed). Shared *files* are not handled
  (would need a SW POST handler).
- **Daily note**: "today" button on home — one note per calendar day, found
  by `meta.daily = 'YYYY-MM-DD'`, created in the current folder.
- **Templates**: tag any note `#template`; "＋ from template" (chips row)
  copies its body/tags into a fresh note.

## Reminders & hands-free capture (Phase A — client-only)

- **Task reminder fields** (`store.js` `createTask`): `remindAt` (epoch ms, 0 =
  none), `remindPlace` (`{lat,lng,radius,label}` | null), `remindStatus`
  (`''|scheduled|notified|snoozed|dismissed`), `snoozedUntil`. They ride the
  normal task shard sync; **`TASK_FILL_FIELDS`** protects them in `mergeRecord`
  so a stale device (e.g. one that just ticks a checkbox) can't blank a reminder
  set elsewhere — clearing is an explicit `markCleared` tombstone. For
  note-sourced tasks the reminder lives on the record only (it does not
  round-trip into the note markdown); `tasks-sync.js` preserves it on re-parse.
- **"When" parsing** (`dates.js` `parseWhen` + `capture.js` `parseCapture`):
  turns "pick up prescription after 5pm" / "call Jay after 6pm tonight" / "buy
  milk tomorrow 9am" / "in 2 hours" / "next monday" into `{ text, remindAt }`.
  Pure, `now`-injectable, covered by `scripts/check-mind-capture.mjs`
  (`npm run check`). Wired into both the voice capture and the typed task
  quick-adds (home + tasks views).
- **Hands-free voice capture**: `manifest-mind.webmanifest` `shortcuts` add
  "voice todo" / "voice note" launchers → hash routes `#capture/voice/task|note`
  (`views/capture.js`) that auto-start the existing Web Speech dictation
  (`voice.js`) and commit a task (with parsed reminder) or note on stop.
  (Google shut down third-party Assistant actions and there is no server, so a
  true "Hey Google, add note X" isn't possible from a PWA — this app-shortcut is
  the one-gesture equivalent.)
- **Local scheduler** (`reminders.js`): a 60s scan (mirrors the housekeeping
  cadence) fires due `remindAt`/`snoozedUntil` reminders via
  `registration.showNotification`, and a foreground `watchPosition` geofence
  fires `remindPlace` reminders while the app is open. `sw.js` (v12) gains a
  `notificationclick` handler that deep-links to `#task/<id>` and relays
  Done/Snooze actions to an open client. Permission is requested only inside the
  gesture that arms a reminder. **Bell button + badge** on every task row
  (`reminderSheet` / `reminderBadge`) set a date/time or a place.
- **Accepted Phase-A limits** (see `plans/voidstar-mind-lab-feature-*.md`):
  nothing fires while the app is fully closed (that needs Web Push + a Worker —
  Phase B roadmap), two open devices can each fire once, and closed-app
  **location** triggers are impossible on web (need an OS automation — Phase C).
  iOS needs an installed PWA (16.4+) for notifications; the app degrades
  gracefully where `Notification` is unavailable (reminder still stored/synced).

## Import / export

Beyond the existing whole-dataset JSON/zip (`store.exportAll`/`importAll`,
`export.js` `buildExportZip`), Settings → data offers document-level I/O:

- **`import document…`** (`views/import-doc-modal.js`) — split a document
  (a Google-Docs export, an Obsidian-style `.md`, freeform daily-notes text)
  into individual notes. Source: paste, upload (`.md`/`.txt`), **pick from
  Drive**, or **pick multiple from Drive** (`gdrive-picker.js`, shown only when a
  Picker key is configured; the Picker opens in **list/details** view). Best
  source: Google Docs → File → Download → **Markdown (.md)** (keeps date headings
  as `#`/`##`).
  - **Batch import** (`parseBatchIntoNotes`, pure): "pick multiple from Drive…"
    loads several docs at once. Each is split **independently with the current
    split settings** and the results concatenated (a descending timestamp cursor
    keeps them in a stable newest-first order across docs; the daily key is deduped
    across the whole batch). A **"combine whole batch into one note"** toggle
    instead merges every doc into a single note (split settings bypassed). The
    batch bar shows the loaded-doc count and a *clear* button; "pick from Drive…"
    or typing/uploading reverts to single-source.
  - `parseDocIntoNotes(text, opts)` (`import-doc.js`, pure/deterministic) splits
    on markdown headings (auto-picking the level that carries the most dates) or,
    for plain text, on **date-dominant lines** (a date + ≤2 other words, so a
    `6/14` mid-sentence never splits). A date line only splits when it's set off
    by a **blank line above** (or opens the doc), so a date embedded in a
    paragraph/table row is never a false boundary. `mode:'single'` ("split: none
    (one note)" in the modal) imports the whole document as a single note.
    Dates parse via `dates.js` `extractDate` (ported from `setlist/import.js`);
    it accepts `M/D`, `M-D`, `M.D` with an optional `/·.·-` year (`6/14`, `6-14`,
    `6/14/26`, `6-14-2026`) and, with `rejectTimeSignatures` (which import
    passes), skips a bare slash `N/D` whose denominator is a power of two so a
    musical **time signature** (`4/4`, `6/8`, `12/8`) never mints a spurious
    date. Timestamps descend strictly in document order (dated sections anchored
    to their day at local noon, dateless ones stepping down 1 min), so a
    newest-at-top doc lands newest-first in the list.
  - A header that is **essentially just a date** becomes a **daily note**
    (`meta.daily`), deduped within the batch and against existing dailies
    (a collision demotes it to a plain dated note rather than shadowing "today").
  - **Filesystem-style upsert** (`markDuplicates`, opt-in via *update matching
    notes*, on by default): a note's identity is its **(folder, title)** — or its
    daily date. On import, a section matching an existing note's path **updates it
    in place** (keeps id/backlinks/attachments) instead of inserting a twin, so
    re-importing the same Doc *refreshes* rather than piling up. Match tiers, in
    order: mind-export `id=` round-trip → byte-identical (skip) → path/daily
    upsert → new. **Newer-detection**: when the source is Drive, the file's real
    last-edit time (`LAST_EDITED_UTC` from the Picker, `srcModified` on each
    section) is compared to the matched note's `updatedAt`; if the **mind copy is
    newer**, the row is flagged amber-pink ("mind is newer") and left **unchecked**
    so fresher local edits aren't clobbered (a per-row checkbox still lets you
    force it). `commitDocImport` stamps the Drive edit time as the note's
    `updatedAt` so repeat imports converge. (Reverse sync is detect-and-warn only;
    writing back into the original Doc is out of scope.)
  - The modal previews the N would-be notes (title · date badge · update/dup badge
    · "mind is newer" badge · snippet), lets you pick folder/tag/heading options,
    and `commitDocImport` snapshots (`pre-doc-import`, undoable in Settings →
    snapshots) before creating/updating notes with `putNoteRaw` (parsed timestamps
    preserved).
- **`export .md (doc)`** (`export.js` `buildNotesMarkdownDoc`) — one readable
  markdown file, each note a `## <title> — <date>` heading + a lossless
  `<!-- mind date=… tags=… daily id=… -->` comment + body. It **round-trips**:
  re-importing recognizes its own header and comment markers (so `##` inside a
  note body never over-splits, and `id=` upserts the same note). `includeComment:false` gives a clean human doc (no exact round-trip).
- **`import Evernote (.enex)…`** (`enex.js` pure core + `enex-import.js` browser
  commit + `views/import-enex-modal.js`) — bulk-import Evernote exports. `enex.js`
  is dependency-free and node-testable: a lenient XML parser, `md5Hex` (so each
  `<resource>`'s bytes hash to the MD5 that inline `<en-media hash=…>` references
  — the correct media→attachment mapping), `parseEvernoteTime`, and a pragmatic
  `enmlToMarkdown` (headings, lists, bold/italic/strike/code, links,
  `en-todo`→`- [ ]/[x]`, `en-media`→image with a `mn-attach://ENEXHASH:<md5>`
  sentinel; unknown markup degrades to text). `commitEnexImport` snapshots
  (`pre-enex-import`), creates notes via `putNoteRaw` (Evernote created/updated
  preserved), turns each resource into an attachment (`addAttachmentFromBlob`;
  images resolve their sentinel to the real id, others become chips, all queue
  OCR), and runs **chunked with a progress readout** so a decade-scale import
  stays responsive. Fidelity is best-effort (text-first); import notebooks one
  `.enex` at a time if a single one is very large.
- Pure parser/exporter functions are covered by `scripts/check-import-doc.mjs`
  and `scripts/check-mind-enex.mjs` (`npm run check`).

## Google sign-in (app-owned client id)

Drive uses an **app-owned** OAuth client id (`src/lib/qualia/google-config.js`,
from `PUBLIC_GOOGLE_CLIENT_ID`), so the user just taps **"Sign in with Google"**
— no client-id entry. `getClientId()` prefers a user override
(`voidstar.mind.gdrive.clientId`, Settings → advanced, still rides the backup)
and otherwise uses the app id; empty app id (e.g. a build without the env var)
falls back to requiring the override, so the flow is unchanged for self-hosts.
The Drive **Picker** additionally needs `PUBLIC_GOOGLE_PICKER_API_KEY`
(origin/referrer-restricted); without it the "pick from Drive" button is hidden.
Both keys are public identifiers protected by Cloud-console restrictions, not
secrecy. The same change is mirrored in `setlist/gdrive-backup.js`.

**Silent token renewal.** GIS issues ~1h access tokens with no browser refresh
token, so the background sync path (`getAccessToken({interactive:false})`) renews
via `requestAccessToken({prompt:'none'})` — a hidden-iframe grant with no popup
or gesture — whenever the Google session + prior consent still exist. Only a
genuinely impossible silent grant (signed out, consent revoked, third-party
cookies blocked) falls through to the "reconnect" pill; the interactive path uses
`prompt:''` (silent when it can, consent when it must, in one gesture). Mirrored
in `setlist/gdrive-backup.js` and `qualia/gdrive.js` (qualia stays manual/
gesture-only — the silent path just spares its Save/Load taps a re-consent and
never surfaces UI mid-performance).

**Sync diagnostics.** Each app's Drive settings has a read-only *diagnostics*
troubleshooter (Settings → google drive sync → *diagnostics*; qualia: inside the
Drive modal). `gatherDiagnostics({live})` in each gdrive module reports identity/
token/sync state, and — with `live` — does a silent-token + peek round-trip to
prove Drive is reachable. The shared formatter/panel live in
`src/lib/qualia/gdrive-diag.js`.
