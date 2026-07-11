# Qualia Google Drive sync

The qualia workstation (`/qualia`) can log in with Google Drive and push/pull
the whole qualia world to the performer's own Drive. It's the qualia sibling of
the setlist app's Backup/Restore and the mind app's sharded sync — it **forks
their proven GIS auth pattern** rather than sharing code, because the data
shapes and UX differ.

Module: `src/lib/qualia/gdrive.js` · UI wiring: `src/lib/qualia/page-init.js`
(the qualem card) + `src/lib/qualia/fx/video.js` (video-clip save/load) · HTML:
`src/pages/qualia.astro` (the qualem card's `#qualem-drive-row` + the
`#qualem-drive` browse modal).

## Auth

- **App-owned OAuth client id** (`src/lib/qualia/google-config.js`,
  `PUBLIC_GOOGLE_CLIENT_ID`) — "connect drive" works with zero setup. A
  user-entered override (`voidstar.qualia.gdrive.clientId`) is honored for
  self-hosts, same as setlist/mind.
- **`drive.file` scope** — the app only ever sees files it created; the user's
  other Drive files stay invisible.
- Google Identity Services, browser-only. The token (~1 h) caches in
  `voidstar.qualia.gdrive.token`. A silent refresh is impossible (GIS needs a
  gesture), so a lapsed token shows **"reconnect drive"** — but only once the
  user has connected before (`voidstar.qualia.gdrive.everConnected`), so a
  first-time visitor reads as "connect drive", not "token expired".
- **`gdrive.ensureAccess()` must be called first thing in a tap handler**,
  before any `await`, or mobile browsers block the consent popup (the same rule
  the setlist app documents). Handlers whose payload needs `await` *before* the
  upload (the `.zip` bundle, video-clip reads) call `ensureAccess()` explicitly
  up front; handlers whose capture is synchronous (a plain qualem) let
  `saveJson`'s own first-await token request open the popup.

## Folder layout

Everything lives under one top-level **`voidstar_qualia`** folder in My Drive,
with **each sub-component in its own subfolder**:

```
voidstar_qualia/
  qualems/     — full qualem JSON snapshots            (<name>.qualem.json)
  bundles/     — .qualem.zip bundles                    (qualem + loop WAVs + cab/amp + video)
  video/       — video-quale clip files                 (mp4/webm)
  rig/ fx/ overlay/ camWalk/ audio/ pose/ camera/
  sequencer/ strudel/ vocoder/ auto/  — per-panel qualem sections
```

The section subfolders mirror the `QUALEM_SECTIONS` keys in `page-init.js`, so
saving "just the strudel panel" to Drive lands in `voidstar_qualia/strudel/`.

Folder resolution is **serialized per name by an in-flight promise** (and picks
the oldest folder if two exist) so two concurrent saves can't race into
duplicate `voidstar_qualia` / subfolders — the failure the mind app had to heal.

## What the module exposes

`gdrive.js` is deliberately generic — folder-scoped file ops, leaving *what* to
store to the callers that own each component's live state:

- `ensureAccess()` / `signOut()` / `isConnected()` / `needsReconnect()`
- `onState(fn)` / `getState()` — pill states `idle|connecting|connected|busy|error`
- `saveJson(sub, name, obj)` / `saveBlob(sub, name, blob, mime)` — **upsert by
  name** (re-saving overwrites in place, never piles up duplicates)
- `listFiles(sub)` — newest-first; returns `[]` for a not-yet-created subfolder
  (never creates one just to list it)
- `listPopulatedSubfolders()` — `{ sub: count }`, drives the browse modal
- `readJson(id)` / `readBlob(id)` / `trashFile(id)` / `safeName(s)`

## UI

The qualem card's **drive row**:

- **connect drive / reconnect drive / sign out** + a status pill.
- **save to drive** — the current live state as a full qualem →
  `qualems/`.
- **bundle → drive** — a full `.qualem.zip` (loops, cabs, amps, video) →
  `bundles/`.
- **browse drive** — a modal listing the populated subfolders as chips; picking
  one lists its files, each **load**able back into the live state. Load routing
  by subfolder: `qualems` → add to the library + apply; a section folder →
  apply just that section (partial qualem); `bundles` → run the `.zip` importer;
  `video` → drop the clip into the Video quale's playlist (via the bridge
  below).
- **→ drive** on the panel-I/O row — save just the selected panel's section to
  its own subfolder.

The **Video quale** (`fx/video.js`) has its own drive row ("⤓ clips → drive" /
"⤒ drive clips") because dropped-file clips can't be persisted to localStorage
(a `File` is unrecoverable across reloads) — Drive is how they survive across
machines. It also registers `globalThis.__qualiaVideoAddBlob(name, blob)` while
active so the qualem-card browse modal can drop a Drive clip straight into the
playlist (mirrors the existing `__qualiaVideoFiles` bundler bridge; both are
cleared on dispose).

## Constraints preserved

- **Static-host / serverless.** Drive sync is an optional convenience, never a
  performance dependency — a solo set runs fully offline; nothing here touches
  the render or audio threads.
- Uploads are user-initiated (no auto-push loop), so a live set never blocks on
  the network. Auto-sync could be layered on later using the same module.
