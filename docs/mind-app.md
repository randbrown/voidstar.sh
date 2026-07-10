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
| Voice | `voice.js`, `voice-capture.js`, `audio-out.js` | Web Speech dictation (continuous, restart loop, final dedupe) + MediaRecorder on the same mic; keep-audio / insert-transcript toggles; record-only fallback on contention. Mic picker reuses `qualia/devices.js`; speaker via `setSinkId` (hidden on Safari). |
| OCR | `ocr.js` | tesseract.js lazy-loaded from CDN on first image; serial idle queue over `ocrStatus='pending'`; text stored on the attachment (searchable, rides sync so other devices never re-OCR). |
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
  plain LWW — no baseline, no copy spam.
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

## Import / export

Beyond the existing whole-dataset JSON/zip (`store.exportAll`/`importAll`,
`export.js` `buildExportZip`), Settings → data offers document-level I/O:

- **`import document…`** (`views/import-doc-modal.js`) — split ONE document
  (a Google-Docs export, an Obsidian-style `.md`, freeform daily-notes text)
  into individual notes. Source: paste, upload (`.md`/`.txt`), or **pick from
  Drive** (`gdrive-picker.js`, shown only when a Picker key is configured).
  Best source: Google Docs → File → Download → **Markdown (.md)** (keeps date
  headings as `#`/`##`).
  - `parseDocIntoNotes(text, opts)` (`import-doc.js`, pure/deterministic) splits
    on markdown headings (auto-picking the level that carries the most dates) or,
    for plain text, on **date-dominant lines** (a date + ≤2 other words, so a
    `6/14` mid-sentence never splits). Dates parse via `dates.js` `extractDate`
    (ported from `setlist/import.js`). Timestamps descend strictly in document
    order (dated sections anchored to their day at local noon, dateless ones
    stepping down 1 min), so a newest-at-top doc lands newest-first in the list.
  - A header that is **essentially just a date** becomes a **daily note**
    (`meta.daily`), deduped within the batch and against existing dailies
    (a collision demotes it to a plain dated note rather than shadowing "today").
  - The modal previews the N would-be notes (title · date badge · dup badge ·
    snippet), lets you pick folder/tag/heading options, and `commitDocImport`
    snapshots (`pre-doc-import`, undoable in Settings → snapshots) before
    creating notes with `putNoteRaw` (parsed timestamps preserved).
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
