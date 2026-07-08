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
| Drive sync | `gdrive-sync.js`, `attachments-drive.js` | Forked from `setlist/gdrive-backup.js` (GIS auth, drive.file scope, user's own OAuth client id, pull→merge→push cycle, peek freshness gate, persisted dirty flag, duplicate-file healing, rotating 10-copy history). Additions: **conflict copies** and **attachment binaries** (below). |

## Sync model

- One JSON data file (`voidstar-mind-data.json`) at Drive root: notes, folders,
  tasks, tasklists, attachment *metadata*, annotations, settings.
- Attachment *binaries* are individual files in `voidstar mind attachments/`,
  uploaded serially (pending = `driveFileId:''`, so queue state survives tab
  death and rides the JSON); other devices lazy-download on first render
  (`setBlobFetcher` in `attachments.js`).
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

## Not built yet (planned P4)

PDF rasterize/annotate/OCR (pdfjs-dist), Whisper WASM re-transcribe of kept
audio (attachments already store `transcript`/`transcriptSource`), Android PWA
share-target, note templates / daily note.
