# voidstar.sh — full site & apps review (2026-07)

A six-pass review of the whole tree: qualia (visuals/core and audio engine as separate
passes), mind, setlist + its worker, the Google Drive/OAuth integrations as a
cross-cutting pass, and the site shell / workers / infra. Focus per the owner's
priorities: **realtime performance + A/V quality + public-display UI** for qualia;
**data integrity, security, UX, low friction** for setlist and mind.

How to read this:

- Severity is relative to *this* project's stakes (a live set that can't stop; a
  primary notes system).
- **(known)** = already tracked in [`maintenance-backlog.md`](maintenance-backlog.md);
  listed only when the review found the item is *wider or hotter* than the backlog entry.
- **(verified)** = the claim was independently re-checked in source during synthesis,
  not just reported by a single review pass. All CRITICAL/HIGH items below are verified.
- File:line references are as of this review's commit.

---

## 0. The short list — fix these first

Ordered by (stakes × likelihood), across the whole site:

1. **Setlist: deletions resurrect through Drive backup — even single-device.** (CRITICAL, new, verified) → §3.1
2. **Mind: an open editor can silently overwrite a newer synced edit; "clear to empty" (folder/tags) never sticks across devices.** (HIGH ×2, new, verified) → §2.1, §2.2
3. **Setlist worker has no auth; setlist views have stored-XSS sinks that can exfiltrate the Drive token *and* the long-lived Spotify refresh token.** (HIGH, known G1/G2 — but the refresh token and the open Drive-proxy behavior raise the stakes beyond the backlog wording) → §3.3, §3.4
4. **Qualia long-set degradation cluster:** formant-shift phase never wraps (harmonies rot mid-set); `setParam` does synchronous localStorage writes on the Strudel/MIDI hot path; WebGL contexts and worklet processors leak on churn; "bypassed" drives hard-clip hot signals. (HIGH/MEDIUM, new, verified) → §1
5. **Entangle worker: role spoof + no rate/size limits, live on a public workers.dev URL; no security headers on Pages.** (known D1, escalated + one new gap) → §5

Everything below is the detail; §6 is the feature/value-add menu.

---

## 1. Qualia — the instrument

### 1.1 Realtime / hot-path (visuals & core)

| Sev | Finding | Where |
|---|---|---|
| HIGH (verified) | `core.setParam` does a **synchronous `JSON.stringify` + `localStorage.setItem` + DOM write per call** — and it's the documented Strudel/MIDI hot path. A pattern driving `qualia.setParam` per event or a CC knob ride (~50–100 msg/s) lands a storage write per message, exactly the jank the aux-fps machinery exists to prevent. Fix pattern is already in-file: `makeSettingsStore` debounces 200 ms; give `saveFxParams` the same treatment (write-through memory, debounced flush). | `core.js:366-373` → `presets.js:47-49`, `ui.js:292-345` |
| MEDIUM | **Camera-mode pose drops people on a single empty detection** — `lingerMs` grace only exists in the `'canvas'` branch; one missed inference (hand over lens, occlusion behind the steel) blanks skeleton/aura for a frame burst. Violates the AGENTS.md "never snap on a tracking dropout" non-negotiable. | `pose.js:167-183`, `601-615`, `233-236` |
| MEDIUM | **Discarded WebGL canvases never release their contexts** — zero `WEBGL_lose_context` calls in the tree (Three path does `forceContextLoss`; raw webgl2 doesn't). Long auto-cycling sets accumulate contexts toward Chrome's ~16 cap; the browser then kills the oldest (possibly Hydra's or the mosh post's) → black layer mid-set. One line before `canvas.remove()`. | `core.js:194-214` |
| MEDIUM | **MediaPipe CDN + model URL unpinned** (`tasks-vision` unversioned, model at `.../latest/`), contradicting the project's own pin-the-CDN policy (Strudel pinned 1.3.0 for exactly this; qrcode pinned). A breaking upstream release changes pose behavior between soundcheck and the set. | `vision-loader.js:12-13`, `pose-worker.js:21-23`, `pose.js:15` |
| MEDIUM | **dark-space cosmic-web allocates ~4–8k objects/frame** at default density (`transformXY` returns a fresh array per galaxy/flow-point + per-galaxy `rgba()` strings) — the heaviest allocation hot path in the fx tree. Out-params + quantized color cache fix it with no visual change. | `dark-space.js:358-366, 389-440, 607-623` |
| MEDIUM | **Recording bitrate too low for the pixels encoded**: fixed 4 Mb/s while compositing up to 2880×1620@30 ≈ 0.03 bpp — H.264 visibly smears exactly this content (particles, starfields, ASCII, mosh noise). Scale bitrate with resolution (~0.08 bpp ≈ 11 Mb/s at full size) or cap the recording composite at 1920-wide. | `recorder.js:93, 604`, `page-init.js:2892-2906` |
| MED (known C6, wider) | Per-frame canvas gradients confirmed beyond the backlog's two sites: also `dark-space.js:592,682`, `chaos.js:958,972`, `spectrum.js:272`, `synthwave.js:459`, `vintage-analog.js:320,548-562`. The planned `fx-helpers.js` (B3) should own a cache-by-quantized-(hue,radius) helper. | — |
| MED-LOW | Edge-detect post allocates a ~3.7 MB `ImageData` per frame (~220 MB/s garbage at 60 fps) + JS Sobel over ~0.9 Mpx. post-mosh already solved this class on the GPU; Sobel is a trivial fragment shader. | `overlay.js:670, 687-719` |
| LOW | Recorder keeps a **full in-memory duplicate of every take** (`memChunks`) even on healthy FSA/OPFS sinks — ~1.8 GB of Blob refs per hour at 4 Mb/s. Cap as a ring once the sink verifies healthy. | `recorder.js:510-531` |
| LOW | `setActive` failure leaves core state torn (old fx disposed, `activeMod` stale → `setParam` writes cross-fx). Null `activeMod` before `create()` or roll back on throw. | `core.js:243-363` |
| LOW | A persistently-throwing fx logs at render rate forever and never recovers — count consecutive failures, then quiet + auto-fallback to a known-good canvas2d fx. | `core.js:582-585` |
| LOW | Pose detect rAF loop never parks after `stopCamera` (extends known D4); param-panel modulator meters run their own uncapped rAF; sparks/ASCII per-frame string churn; code.js per-line `ctx.font` + shadowBlur. | `pose.js:619-638`, `ui.js:275-290`, `overlay.js:304-315, 573-599`, `code.js:574-588` |

**Verified healthy:** the three-cadence loop, frame-cap slop, update/render split, and
`audio.js tick()` are allocation-clean as documented; `scaleAudio`/`resolveParams`/
`computeChannels` reuse scratch; post-mosh, cam-walk, ghost-machine, singularity-lens,
video quale, arcade engine/input, and the entangle host's O(N) `reduceInto` are all
model realtime citizens. `core.js`/`modulation.js`/`field.js` remain the reference standard.

### 1.2 Audio engine

| Sev | Finding | Where |
|---|---|---|
| HIGH (verified) | **Phase-vocoder synthesis phase never wraps.** `sumPhase[k] +=` accumulates unbounded in Float32 for all bins at ~94 hops/s; after tens of minutes of continuous vox, float32 ULP exceeds the per-hop increment and harmony voices decay into metallic garbage, silently, mid-set. One-line fix — `wrapPhase()` already exists at `:77`. | `worklets/formant-shift.js:217` |
| MED-HIGH (verified) | **"Bypassed" drives hard-clip at 0 dBFS.** Bypass installs `IDENTITY_CURVE`, but a WaveShaper clamps outside [-1,1], and pre-drive stages can exceed 1.0 (geq ±15 dB + level ±15 dB, comp makeup, un-trimmed mono L+R sum). An "off" Earth/Metal silently clips the live monitoring path. Fix: `curve = null` on bypass (the spec-defined identity, already used in `limiter.js:87-89`). | `rig-strip.js:151-155, 439, 457, 524-527`; `looper-audio.js:261-265` |
| MEDIUM | **Multi-MB allocations inside worklet `process()`**: the ~15 MB capture ring allocates lazily on the first quantum (and re-allocates on channel change); `grab()` allocates+copies up to another ~15 MB on the audio thread mid-jam. Move ring alloc to the constructor (`processorOptions`), chunk grab posts. (C14 covers only the main-thread concat.) | `worklets/looper-recorder.js:49-57, 106-134` |
| MEDIUM | **Zombie worklet processors**: teardown only disconnects; `process()` returns `true` unconditionally, so recorder + neural-amp processors stay live (pinning their rings) across every capture reopen — a 2-hour set leaks processors. Fix: a `{cmd:'dispose'}` flag → `return false`. | `looper-audio.js:380-401`, `worklets/looper-recorder.js:100`, `worklets/neural-amp.js:94`, `rig-strip.js:640-655` |
| MEDIUM | **No loop-seam crossfade** — `once`/`fit` voices click on every wrap (IN/OUT land mid-waveform); `tile`'s zero-cross snap reads channel 0 only and never snaps the START. Bake a 3–10 ms equal-power crossfade at track creation. | `looper-audio.js:936-947, 780-783` |
| MEDIUM | **Reverb IR rebuilt per slider tick** (≤768k samples on the main thread, convolver state reset = tail cut per tick). Quantize decay + debounce; ideally crossfade two convolvers. (C2 covers shaper curves, not the IR.) | `rig-strip.js:410-425, 562-565` |
| MEDIUM | **Inconsistent smoothing**: direct `.gain.value =` writes on Earth/Metal pre/stage/post, EQ shelves, delay feedback/wet (bypass kills tails instantly), reverb/amp/cab wet — while geq/peq/hpf/pan correctly use `setTargetAtTime`. Neural-amp bypass flips per-block with no ramp. | `rig-strip.js:446-472, 514-518, 559-586`; `worklets/neural-amp.js:30` |
| MEDIUM | **Vox pitch tracking is rAF-driven** → freezes in the lid-shut/screen-off gig mode the project explicitly supports (`docs/headless-and-screen-off.md`), while audio keeps flowing. Needs a `setInterval`/worklet-clocked fallback. | `vocoder.js:903-931` |
| LOW-prob / HIGH-impact | **NaN latch in the LSTM**: no finiteness guard; one non-finite sample poisons `h`/`c` until model reload, and NaN passes the soft-clip shaper to the destination. A per-block `!(y === y)` reset+bypass is nearly free. | `worklets/neural-amp.js:70-91` |
| MEDIUM | **`.aidax` accepted but not parsed** (only GuitarML `state_dict` + NAM JSON paths exist; RTNeural keras-style JSON has no path). Also **no sample-rate handling**: a 48 kHz capture in a 44.1 kHz context shifts amp voicing ~9 % silently (model metadata carries the rate — at least warn). | `neural-amp-model.js:8,38`, `looper.js:2023` |
| MEDIUM | **Stretch playback ignores buffer sample rate** (fit+preserve-pitch path only) — a loop recorded at 48 k restored into a 44.1 k context plays mispitched with wrong loop length; varispeed path is safe. Resample or fall back to varispeed on mismatch. | `looper-audio.js:918-927` |
| MEDIUM | **Per-tweak full-PCM IndexedDB rewrites** — every volume/mute/grid nudge re-serializes the whole take (~15 MB) after a 250 ms debounce. Split settings row from PCM row (written once). | `looper.js:413-424, 677-722` |
| LOW | **24-bit WAV imports as silence** (no 24-bit branch; falls through to `v = 0`) — the most common DAW export depth. | `wav.js:95-99` |
| LOW | Armed-capture posts 375 msg/s with fresh arrays from the audio thread — batch 8–16 quanta/message (~10×). Vocoder preset load rebuilds the graph up to 3× (`carrierType`/`bands`/`voices` each trigger `rebuildGraph`). | `worklets/looper-recorder.js:83-95`, `vocoder.js:1307-1331` |

Hygiene: `voice-shifter.js:20` uses `?url` (not the documented `?url&no-inline`) and only
works because the worklet exceeds Vite's inline limit; duplicated `midiToHz`/`RING_SECONDS`/
`MIC_CONSTRAINTS`; `sequencer.js:1742` iterator helpers break older Safari. Known items
confirmed in place, no drift: D6, C14, B4, C2, B6, D4, C12, A2.

**Verified healthy:** the LSTM math (gate order, combined bias, causal zero-latency)
checks out against the parser; grid-snap math, IndexedDB persistence integrity, vocoder
band design, and the sequencer's cycle-lock scheduling all survived scrutiny.

---

## 2. Mind — data integrity first

The sharded Drive sync is genuinely strong (canonical hashing, dirty-bucket tracking,
commit-stamps-after-import crash safety, dup healing, conflict copies + merge UI, node-
tested pure cores). The residual risk sits at the seam between the live editor and
background sync. *(The backlog has no mind section — all items below are new.)*

### 2.1 HIGH (verified) — Editor writes through a stale snapshot; sync imports can be silently overwritten

`views/editor.js:27` loads `note` once; every `save()` (`:166-174`) writes
`{...note, ...patch, body}` with a fresh `updatedAt` and never re-reads IDB. Meanwhile
`watchFocusSync` (`app.js:168-199`) imports remote changes even while typing (the
`typing` guard only skips the re-render). Scenario: phone edits note N, syncs; desktop
has N open, user refocuses and types; the focus pull imports the phone's newer body;
the 800 ms autosave overwrites it with the pre-pull body. For the first keystrokes of a
session (local `updatedAt < lastCycleAt`) **no conflict copy is minted — the phone's
edit is lost everywhere**. The stale spread also clobbers remote title/tags/folderId/
pinned changes on any local save (no conflict copies exist for non-body fields).
**Fix:** before writing, re-read the record; if `updatedAt` advanced past this session's
last write, rebase (or mint a local conflict copy) and refresh metadata fields from IDB.

### 2.2 HIGH (verified) — "Clear to empty" never sticks: folder moves to root and last-tag removal revert

`NOTE_FILL_FIELDS = ['tags','meta','sourceDevice','folderId']` (`store.js:523`) refills
`''`/`[]` from the older copy unless a `clearedFields` tombstone exists — and
`markCleared` is called **only** for task reminders (`reminders.js:295-311`), never by
bulk move (`views/home.js:188-197`), the editor folder select (`views/editor.js:112-115`),
tag removal (`:125-128`), or `deleteFolderAndReparent` (`store.js:260-274`). Two-device
trace: A moves note to root → B's merge fill-restores the old `folderId` onto the newer
record → propagates back to A. The move never sticks; folder deletions leave notes
pointing at tombstoned folders. **Fix:** `markCleared(note,'folderId'/'tags')` on
explicit clears, mirroring the reminder pattern.

### 2.3 MEDIUM

- **No compare-and-swap on shard push** (`gdrive-sync.js:556-565`): concurrent pushes
  can drop a record from Drive until the victim's next cycle; permanent loss if that
  device's IDB is evicted first (iOS). Cheap hardening: re-list the shard's
  `modifiedTime` immediately before each upload; abort/re-pull on advance.
- **Copy-pasting a task item duplicates its `taskId`** — records "stolen" between notes,
  reminder fields destroyed by re-create (`tasks-sync.js:25-38, 71-79`). Dedupe in
  `ensureTaskIds`. (Also: marker ids generate 6 chars, comment says 8, `:17-21`.)
- **Editing a note-sourced task's text from the tasks view silently reverts** — the body
  line isn't rewritten (`views/tasks.js:129-139` vs `setTaskDoneEverywhere`).
- **The 3 s auto-push cycle never takes the `pre-sync` snapshot** (`gdrive-sync.js:
  1174-1186`) — "undo last sync" is unavailable for most merges. Pass the size-gated
  `snapshotFn` into the debounced path.
- **Tombstone TTL (30 d) resurrection** by a long-offline device — inherent to TTL
  tombstones; document it and guard with `lastCycleAt` ("device offline > TTL → review").

### 2.4 LOW

Delete-note vs pending-autosave race can resurrect a note (`flushPending` doesn't await;
`views/editor.js:181-186, 74-83`); one corrupted shard JSON bricks all sync (no per-file
catch in `pullSharded`'s main loop, `gdrive-sync.js:642-653`); `mergeFolderInto` depth cap
can trash unmoved children (`:832-845`); forced "mind is newer" doc-import undone by next
merge (`import-doc.js:515-523`); annotation initial-load race (`annotation.js:664-669`);
route error message into `innerHTML` unescaped (`app.js:150`); pasted `javascript:` hrefs
clickable in-session (`editor/setup.js:233-241` — whitelist protocols at click time).

### 2.5 Scale & UX

Home render does ~8 full-store scans and renders every note as a DOM card (no
pagination/virtualization); `buildIndex` re-derives text for the whole corpus after any
write; `uniqueAutoTitle` is O(N) per new note. Fine at 1–2 k notes, sluggish at
Evernote-scale 10–20 k. Also: an edit made while a cycle is in flight can strand
`_pendingPush`; sync state is invisible outside home; attachment failures (quota/decode)
are silent; export-zip loads every blob into memory; `onSyncState` listener leaks per
home render.

**Security posture otherwise solid:** `markdown-it` with `html:false`, disciplined
`esc()`/`markText()` in all checked views, ENEX entity-decode → markdown-escape, OCR/
transcripts rendered as text.

---

## 3. Setlist — data integrity & the worker

### 3.1 CRITICAL (verified, new) — Deletions resurrect through the Drive backup cycle

There is **no record-level deletion tombstone** anywhere: `exportAll()` (`store.js:399`)
emits only surviving records; `mergeById` (`gdrive-backup.js:666-675`) is an additive
union; `importAll` (`store.js:417-424`) upserts. So `pullMergePushCycle`: delete a song/
setlist/note → `_onWrite` → debounced push → pull returns Drive data still containing
the record → merge re-adds it → import writes it back into IDB **and re-uploads it**.
The record reappears on the next render/refocus and is effectively un-deletable while
backup is connected — **including on a single device**. Not covered by backlog G4
(field-level LWW only). **Fix:** a deletions ledger (`{id, deletedAt}` per store) in the
backup payload; merge suppresses re-add when `deletedAt` > the remote record's
`updatedAt`. Then surface it as a "deleted items" trash view (see §6.2).

### 3.2 CRITICAL-adjacent (verified, new) — Restore/undo is defeated by the next cycle

`replaceAll` (`store.js:430-436`) reproduces an older state and fires `_onWrite`; the
ensuing cycle pulls Drive's *newer* copy and newer-wins merges the just-undone data
straight back (deletions from the restore also resurrect per §3.1). "undo last
merge/restore" only holds while offline. Same root cause; the deletions ledger plus a
"restore epoch" stamp (treat restored state as authoritative until pushed) fixes both.

### 3.3 HIGH (known G2, stakes raised) — Worker has no auth on any route

`workers/setlist-sync/index.js:2400-2497` dispatches with zero auth; CORS only gates
browsers. Anyone with the URL (discoverable from shipped JS/DevTools; it also rides the
Drive backup) can burn `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` via
`/ai/*`, run 100-search batches via `/spotify/search-batch` (`:391`), and — beyond the
backlog wording — use `/drive/file/:id/{text,image}` (`:772, :807`) as an **open read
proxy for any link-shared Drive file on the platform** on the owner's `GOOGLE_API_KEY`.
No rate limiting compounds it. **Fix:** `WORKER_TOKEN` secret checked on every route +
a per-caller token bucket; use the Cache API so repeat AI chart calls are free (per G2).

*Verified contained:* SSRF (hostname-validated bandcamp/soundcloud, id-constrained Drive
routes, provider-returned-URLs-only web search); image proxy content-type validation;
AI output schema-clamped server-side and fill-empty-only client-side (blunts prompt
injection to low impact).

### 3.4 HIGH (known G1, verified + widened) — Stored XSS → token theft

`esc()` exists (`views.js:77`) but is applied only to `steelSummary`/`genre`. Still raw
into `innerHTML`: `s.title`/`s.artist` in library rows (`views.js:550-551`), setlist
cards (`:947`), edit rows (`:1181`), song focus (`:1876-1877`), perform mode
(`:3465-3466`); `keyChanges` via `keyChangeBadge` (`:190`) — which the **AI vision read
populates from arbitrary text on a scanned chart image**; note text (`:2547`, `:3480`);
source URLs (`:891`, `:2891`). These fields carry external data (Spotify track names,
Drive filenames, web-search candidates). A hostile name exfiltrates the Drive token
**and the long-lived Spotify refresh token** (`spotify-auth.js:23,69-77` — localStorage;
the refresh token is the underweighted asset here). **Fix:** `esc()` at every non-local
`${}` (or DOM builders, as the pickers already do).

### 3.5 MEDIUM / LOW

- `mergeConfig` treats an empty array as unset — emptying the whole drive-folder list
  resurrects from Drive (`gdrive-backup.js:682-689`).
- (known G5) Direct-linked `.pdf` charts cache but render in an `<img>` — broken.
- `buildAiChartText` credits OpenAI drafts to "Gemini" (`chart-build.js:165`).
- Dead `sources.driveCharts` read (`sync.js:455`, G7 half); prod CORS allows localhost;
  reflected-origin responses with `Cache-Control: public` lack `Vary: Origin`.

---

## 4. Google Drive / OAuth — cross-cutting

Strong overall posture: `drive.file` scope everywhere, no secrets in the repo (client id
+ Picker key are restriction-protected public identifiers), pull-merge-push, tombstones
(mind), trash-not-delete, dup healing, shared diagnostics. The structural risk is
**fork drift**: the three GIS auth stacks are ~350 near-identical lines each, and every
fix so far landed in only one or two copies.

| Sev | Finding | Where |
|---|---|---|
| P2 | **Token frozen in a closure** (setlist + mind): a continuously-visible tab silently stops syncing after ~1 h; only blur/refocus re-inits. Qualia does it right (per-op token resolve). | `setlist/gdrive-backup.js:375-427`, `mind/gdrive-sync.js:939-986` vs `qualia/gdrive.js:308-321` |
| P2 | **No 401 handling anywhere** — a revoked-but-unexpired token wedges all three apps up to an hour; the silent-renew capability already exists to retry with. | all three modules |
| P2 | **Disconnect doesn't clear per-account caches** (mind worst: stale `shardState` hashes make a different-account reconnect silently push nothing). | `mind/gdrive-sync.js:183`, `setlist/gdrive-backup.js:437-465` |
| P2 | **Zero backoff on 403/429/5xx**, and error paths discard the response body — quota-full Drive presents as an eternal "push pending". Mind's first sharded push (~65 serial uploads + attachment queue) is exactly the shape that trips per-user write throttling. | all three |
| P3 | **Qualia truncates listings at 100 files** (no `nextPageToken` loop; the 101st qualem silently disappears from browse) and `listPopulatedSubfolders` is a 15-request N+1. Mind paginates correctly — fix not shared back. | `qualia/gdrive.js:337-363` |
| P3 | **Multipart-only uploads for the large payloads** (video clips, bundles, attachments) — Google documents multipart for ≤5 MB; no resumability/progress on stage Wi-Fi. | `fx/video.js:838`, `qualia/gdrive.js:269-294`, `mind/gdrive-sync.js:957-971` |
| P3 | **`loadGis` race in all three forks** — "script tag exists" ≠ loaded; racing token requests hit `google is not defined`. Store a module-level load promise. | `setlist/gdrive-backup.js:166-168`, `mind/gdrive-sync.js:261-263`, `qualia/gdrive.js:108-111` |
| P3 | **Mind multi-tab dirty-shard drain race** (read-then-clear on localStorage) can strand an edited bucket un-pushed indefinitely (stale hash suppresses upload every later cycle). | `mind/gdrive-sync.js:141-145` |
| P3 | **First-time visitors read "reconnect"** in setlist/mind (the `everConnected` gate exists only in qualia). | `setlist/gdrive-backup.js:86-88`, `mind/gdrive-sync.js:182` vs `qualia/gdrive.js:86-88` |
| P3 | **Qualia lacks the duplicate healing the other two grew** — two devices cold-creating `voidstar_qualia` mint twins; files in the newer twin become permanently invisible (browse resolves only the oldest; diagnostics detects, nothing folds). Same-named duplicate files never healed. | `qualia/gdrive.js:239-243, 260-267, 435` |
| P3 (accept + document) | Pushes are blind overwrites (Drive v3 has no content precondition); the pull-merge architecture compensates — loss only if the losing device never syncs again. | — |

Doc drift noted: `docs/qualia-drive-sync.md` still says "a silent refresh is impossible
(GIS needs a gesture)" while `docs/mind-app.md` documents the silent-renewal path as
mirrored into qualia.

**Recommended consolidation (one pass fixes most of the table):** extract a shared
`gdrive-core.js` (token cache + silent renew + per-request resolve + 401-retry-once,
fetch wrapper with `Retry-After`-honoring backoff + real error reasons, paginated list,
serialized folder resolution with mind-grade dup healing), parameterized by namespace —
`gdrive-diag.js` already proves cross-app sharing works. Then: resumable uploads >4 MB,
account pinning (`login_hint` + per-account cache keys), and consider the Drive Changes
API (`changes.list` + `startPageToken`) for the freshness peek.

---

## 5. Site shell, workers, infra, labs

| Sev | Finding | Where |
|---|---|---|
| HIGH (known D1, escalated) | **Entangle worker: `role=host` from a query param, no auth/size-cap/rate-limit, client-supplied peer id with evict-on-reconnect, arbitrary `target` routing** — and it's live on a public workers.dev URL (`wrangler.toml:17`), so "do before any public deployment" has effectively already happened. A heckler can join as host and drive the projection, or flood the room. | `workers/entangle-signal/index.js:30-80` |
| MEDIUM (new) | **No Origin check on the WS upgrade** — any third-party site can open sockets into a room; the only gate is the 50-bit room id. Add to the D1 hardening pass. | `index.js:30` |
| MEDIUM | **No security headers on Pages** — `public/_headers` sets only `Cache-Control`. Missing `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (lock `camera`/`microphone` to self), and `X-Frame-Options`/`frame-ancestors` — the token-bearing setlist/mind apps are currently framable (clickjacking). **Do NOT add COOP/COEP**: no `SharedArrayBuffer` use anywhere, and they'd break the CDN-loaded Strudel/Hydra/MediaPipe. | `public/_headers` |
| LOW-MED | `npm audit`: 5 advisories (3 high) — astro/esbuild/vite/devalue/js-yaml. Practical exposure low (static output, no SSR), but `npm audit fix` is cheap. No secrets in git history. | `package.json` |
| LOW | Render-blocking Google Fonts `@import` inside inlined CSS (can't preload; pulls 3 font families on every page). Use `<link>` or self-host woff2. | `themes.css:14` |
| LOW | Undeclared `sharp` dependency — icon scripts fail on fresh `npm ci`; no `devDependencies` block exists. | `scripts/gen-app-icons.mjs:20` |
| LOW | Dead 2.5 MB `public/images/ramblin-visioneer-v0.png` (only v1 referenced). No `robots.txt` (sitemap generated but unreferenced; lab PWA routes indexable). | — |
| INFO | **No CI** — `npm run check` (the mind pure-core test suite) never runs anywhere automated; Cloudflare deploys `main` unconditionally. A minimal Action (`npm ci && npm run build && npm run check`) is cheap insurance. | `.github/workflows/` |

Legacy labs (`/lab/cymatics`, `/lab/spectrum-pose`, `/lab/pose-particles`): no security
issues found; leave as-is per policy.

---

## 6. Feature recommendations

Curated from the six passes; grounded in what the stack already has. Roughly ordered by
value-for-effort within each app.

### 6.1 Qualia (performance / A/V / public display)

1. **Pitch-as-modulation channels** — expose `audio.pitch` + `audio.pitchClass` from the
   existing tuner as modulation channels; hue-by-pitch-class makes visuals track *what
   note the steel plays*. Registry + pill UI already exist; near-zero cost, deeply musical.
2. **Cycle-quantized scene changes** — gate auto-cycle/phase/quale switches to the next
   Strudel cycle boundary (`getSecondsUntilNextStrudelBoundary()` + `core.beginTransition`
   both exist) so every scene change lands on the downbeat.
3. **Automatic degradation governor** — the documented ladder (DPR → particles → passes →
   idle) is manual today; `core.onFps` + `setDprCap` exist. If fps < 24 for 5 s, step down
   and toast; restore on recovery. A performer mid-song cannot debug.
4. **Clean projector/OBS output window** — the recorder composite already builds a UI-free,
   walk/transition-correct frame; a popup rendering it gives a chrome-free projector feed
   while the laptop keeps panels (the VJ media-server pattern).
5. **Freeze / infinite-sustain pedal + loop-seam crossfades + per-track reverse &
   half/double speed** — the ambient pedal-steel trifecta; all cheap against the existing
   worklet ring + varispeed voices (reverse is a one-time channel flip).
6. **Sound-on-sound / overdub-decay (Frippertronics) mode** — loop bus back through the
   recorder with per-pass decay; the ring + strip topology already support the wiring.
7. **Tempo-synced delay + delay/reverb trails on bypass** — divisions driven by `cps`;
   ramp wet instead of hard-muting the feedback path.
8. **Automatic latency calibration** — click out the rig master, capture in the recorder
   worklet, measure, set `_offsetMs`; removes the per-venue manual dial-in.
9. **Hydra feedback of the fx canvas** — register the active fx canvas as `s0` on quale
   switch (`preserveDrawingBuffer` already on): `src(s0).modulate(...)` from the REPL
   makes the whole layer stack one live-codeable instrument.
10. **Crowd-constellation quale** — render entangled audience skeletons as drifting
    star-constellations (`packSkeleton`/`getSkeletons()` already deliver the data);
    makes participation visible instead of only nudging knobs.
11. **Beat-source toggle + confidence HUD** (detector vs Strudel clock) for quiet ambient
    passages; **per-quale fps badge** in the picker (rolling median per quale id) so
    "which quale is safe on this venue's laptop" is UI, not memory.
12. **Recorder chapter markers** (known F) — SMPTE track already written; hotkey drops
    named markers for post. Pair with the bitrate fix (§1.1).

### 6.2 Setlist (gigging)

1. **Set timer / pacing HUD in perform mode** — elapsed vs sum of `song.durationSec`
   (already fetched from iTunes): "running 4 min long" at a glance. Wake lock exists.
2. **Foot-pedal page turns** — Web MIDI / BLE-MIDI driving `go(dir)` (`views.js:3596`,
   the single nav entry point). Hands never leave the instrument.
3. **"Deleted items" trash view** — the user-facing face of the §3.1 deletions ledger;
   accidental deletes at rehearsal become recoverable.
4. **Per-band filtering** — a `band` tag on setlists + a library filter chip (status
   chips already exist); cuts cross-band noise for a multi-band player.
5. **Capo-aware chord display** — `song.capo` is in the model with no UI; render played
   shapes alongside Nashville numbers.
6. **Practice mode: loop-a-section** — `syncedLyrics` + the timecode timer exist; loop
   verse/chorus ranges (note `timecode`s) to drill hard spots.
7. **Chart transpose export** — "transpose to X" rewriting header + legend via the
   existing `chordLegend`; **auto-scroll** for long text charts tied to `song.bpm`.

### 6.3 Mind (second brain)

1. **Quick-switcher / command palette (Ctrl+K)** — fuzzy title jump + actions over the
   existing `query()`; the single biggest daily-driver win.
2. **Per-note version history** — Drive already keeps per-file revisions on every shard;
   surface a timeline and diff with the existing `merge.js` LCS UI. Also the safety net
   for §2.1 until rebase-on-save lands.
3. **Inline `[[wikilink]]` autocomplete** — id-based `#note/<id>` links + backlinks
   already exist; an input rule makes linking keyboard-native.
4. **Agenda / today view** — daily note + `remindAt` tasks (overdue/today/upcoming) +
   recently edited, one screen; all fields already sync.
5. **Search operators** — `tag:` `kind:` `in:` `before:/after:` mapped onto the already-
   structured `query(q, filters)`; badge hits that matched via OCR/transcript.
6. **Share-target POST for files** — SW POST handler so "share screenshot to mind"
   works on Android, feeding the existing attachment + OCR pipeline.
7. **Locked notes (encryption at rest)** — WebCrypto AES-GCM for a `#locked` tag,
   passphrase-derived key; ciphertext rides the existing shards/attachment files
   unchanged. Meaningful differentiator for a primary notes system.
8. **Corpus integrity check in Settings** — run `healBodyAttachmentRefs` + orphan/
   stale-conflict detection corpus-wide with one-tap fixes (today it heals only on
   note-open).
9. **Publish note → site post** — it's an Astro blog: emit front-matter `.md` into
   `src/content/` from a note (reuse `noteToDocBlock`).
10. **Task snooze from list rows + overdue section** — `snoozedUntil`/`remindStatus`
    already sync; expose without the reminder sheet.

### 6.4 Cross-app

- **Shared `gdrive-core.js`** (§4) — the highest-leverage single refactor in the repo.
- **Setlist ↔ mind bridge** — link a setlist/song to a mind note (`#note/<id>` is
  rename-proof): rehearsal notes, arrangement ideas, and gig retros live in mind but
  are one tap from the song page.
- **Sync-status pill on every page** (both apps) — the G3 class of issue: failures are
  currently invisible outside home/dashboard.

---

## 7. Suggested sequencing

1. **Data-integrity trio** (small, mechanical, highest stakes):
   setlist deletions ledger (§3.1/3.2) · mind rebase-on-save (§2.1) · mind
   `markCleared` for folder/tags (§2.2). Add the mind pre-sync snapshot to the
   debounced path while in there.
2. **Security pair:** `WORKER_TOKEN` + rate limit on setlist-sync (§3.3) · `esc()`
   sweep in `views.js` (§3.4) · `_headers` block (§5). Entangle hardening (D1 + Origin
   check) before the next audience-participation show.
3. **Qualia long-set pass:** formant phase wrap (one line) · `saveFxParams` debounce ·
   `loseContext` on canvas swap · worklet dispose flags · `curve = null` bypass ·
   MediaPipe pin. Each is small; together they're the difference for a 2-hour set.
4. **Drive consolidation:** `gdrive-core.js` with 401-retry + backoff + pagination +
   dup healing (§4), then resumable uploads.
5. **Feature picks** from §6 as appetite allows — the top two in each app list are the
   highest value-for-effort.
