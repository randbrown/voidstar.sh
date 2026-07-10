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
| Drive sync | `gdrive-sync.js`, `attachments-drive.js` | Forked from `setlist/gdrive-backup.js` (GIS auth, drive.file scope, **app-owned OAuth client id** — "Sign in with Google", with a user override in Settings → advanced; see the sign-in note below — pull→merge→push cycle, peek freshness gate, persisted dirty flag, duplicate-file healing, rotating 10-copy history). Additions: **conflict copies** and **attachment binaries** (below). |
| Import/export | `import-doc.js`, `dates.js`, `export.js`, `views/import-doc-modal.js`, `gdrive-picker.js` | Whole-document import (split into notes) + single-doc markdown export + JSON/zip. See the import/export section below. |

## Sync model

- Everything lives under **one top-level `voidstar_mind/` folder** in My Drive
  (created/discovered via `getRootFolderId`; `drive.file` scope, so the app only
  sees files it made). Inside it:
  - One JSON data file (`voidstar-mind-data.json`): notes, folders, tasks,
    tasklists, attachment *metadata*, annotations, settings.
  - `attachments/` — attachment binaries (below).
  - `backups/` — rotating timestamped history copies.
- Attachment *binaries* are individual files in the `attachments/` subfolder,
  uploaded serially (pending = `driveFileId:''`, so queue state survives tab
  death and rides the JSON); other devices lazy-download on first render
  (`setBlobFetcher` in `attachments.js`).
- **Consolidation migration** (`migrateToRootFolder`, one-time, flag-guarded):
  the earlier layout scattered three items at the Drive root (loose
  `voidstar-mind-data.json` + `voidstar mind attachments/` +
  `voidstar mind backups/`). On the first sync after upgrade the data file is
  re-parented into `voidstar_mind/` and the two legacy folders are moved in and
  renamed to `attachments/` / `backups/` (re-parenting works under `drive.file`
  since the app owns them). Fresh installs just create everything nested.
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
- Pure parser/exporter functions are covered by `scripts/check-import-doc.mjs`
  (`node scripts/check-import-doc.mjs`).

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
