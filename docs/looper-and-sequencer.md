# The looper, the sequencer & recording/export

Two programmable sound sources that sit alongside Strudel, plus the capture pipelines. Both adopt
their output analysers into `audio.js`, so they drive visuals and land in recordings automatically.
Read [`architecture.md`](architecture.md) §5 and §7 first.

All paths under `src/lib/qualia/`.

---

## Looper — a grid-locked multi-track live-looping pedal

A Reaper-style multi-track looper built into the rig panel. Captures the instrument and **snaps each
take to the Strudel cycle grid**: the IN point locks to the next grid downbeat, OUT rounds to the
nearest boundary, so every loop is an integer number of cycles and plays back phase-locked. Supports
multiple tracks (one "armed"), per-track grid/length/volume/mute/fit/stretch, a retroactive **grab**
(pull the last N cycles from an always-on ~40 s lookback ring without having armed record), the full
guitar channel strip, a tuner, and a rig master with limiter. Loops persist to IndexedDB and
round-trip through `.qualem.zip`.

**Record is additive by default** (like grab): hitting ● while the armed track already holds a take
lands the new recording in a **fresh track** that becomes the armed one — a still-blank armed track
is reused, so record never strands an empty lane. The `rec → new` checkbox in the props row
(persisted at `voidstar.qualia.looper.recordNewTrack`, default on; also part of the qualem config)
turns this off for the old replace-the-armed-take behavior.

**Module split (clean — preserve it):**

| File | Responsibility |
|---|---|
| `looper.js` | Orchestrator: track model, all DOM/UI (incl. the strip's geq/peq editors), persistence, the qualem surface. (~3,500 lines — should shed the strip UI, tuner, and cab/amp library; see backlog.) |
| `looper-audio.js` | The capture + playback engine. Owns its **own native `AudioContext`** (worklets reject Tone's wrapped context). Hosts the rig strip and rig master. |
| `looper-render.js` | Pure canvas waveform renderer, one per track ("takes in lanes" + sweeping playhead), with cached min/max peaks. |
| `looper-store.js` | Minimal IndexedDB store (`tracks` + `misc`). |
| `looper-stretch.js` | Lazy loader for **signalsmith-stretch** (WASM + worklet, pitch-preserving time-stretch). |
| `worklets/looper-recorder.js` | The audio-thread processor: armed real-time capture (posts 128-frame quanta) **and** the always-on ~40 s ring for retro grabs (slice posted only on `{cmd:'grab'}`, so lookback is free until used). |

**Data flow.** Record: mic → strip → recorder worklet → per-channel `Float32` chunks on the main
thread → on stop, sliced to the grid-snapped region with 0.5 s headroom → `AudioBuffer`. The
recorder taps the strip **output** (post-StereoPanner), so takes — and retro grabs from the ring —
are **always stereo**, carrying the strip's ping-pong delay / pan / stereo reverb; the rig
mono/stereo toggle is an *input*-routing mode only (mono = sum a single-input instrument to
centre). Playback:
per-track channel (gain + optional stretch node) + transient voice (looping `BufferSource` for
varispeed, or stretch node for fit + preserve-pitch) → loop master → rig master → limiter →
destination, with the analyser adopted into `audio.js` as `'looper'`. Sync uses only **relative**
durations `(boundary − pos)/cps`, so it's portable across the two AudioContexts.

**Loop-seam crossfade.** Grid-snapped IN/OUT land mid-waveform, so a raw wrap is an amplitude step
(a click every pass). `playVoice` bakes an 8 ms equal-power crossfade at the region tail into the
audio immediately *before* the loop start (real recorded continuity from the take's pre-roll; a
micro fade-out/in when there's none), holds it for the voice's lifetime, and restores the pristine
samples on stop — so persisted PCM stays exact and a re-lock re-bakes at the new nudge position.
The stretch path applies the same crossfade to its region copies.

**Freeze / infinite-sustain STACK** (`frz` button next to strip/tune, hotkey `;`,
`padActions.freeze`): grabs the newest moment from the recorder ring (post-strip, so a pad carries
the amp/cab/verb that were on), loops it with a 25 % equal-power seam, and **layers** it onto a
stack — the Frippertronics move. Each `frz` tap **pushes another pad** over the last; `'` (button
*pop*) removes the top with a release fade; `\` (button *re-grab*) replaces the top with a fresh
grab; *clear* releases the whole stack. The `frz` button shows the depth (`frz²`, `frz³`…).

**Constant-loudness bus.** All pads sum through one gain node scaled `level / √N` — incoherent
layers add ~√N in RMS, so the total loudness stays roughly steady as you stack (pop and the
remaining layers swell back up) — then a zero-latency **soft-clip limiter** on the bus catches
coherent overshoot so a deep stack can never clip the rig sum (`makeSoftLimiter`, always engaged
on the freeze bus). Graph: `pad.source → pad.gain (fade) → freezeBus (level/√N) → freezeLimiter →
rigMaster`.

The **▾ settings row** holds *level* (live, whole stack), *grain* (loop length grabbed, 0.5–4 s;
applies on the next grab), *release* (0.3–8 s, default 2 s), plus *pop* / *re-grab* / *clear*.
Settings persist (`voidstar.qualia.looper.freeze`). Needs the capture ring, so a grab opens
capture if the signal fader is up.

**Loaded via `?url&no-inline`** so Vite doesn't inline the worklet as a data URL that `addModule()`
can't reliably load.

**Known sharp edges (backlog):** record keeps every 128-frame quantum as a separate array then
concatenates (GC pressure on long takes — pre-grow a single buffer); `stopRecording` waits for the
OUT boundary with `setTimeout` (fragile under tab-throttling — the worklet already has sample-
accurate timing); `teardownCapture` rebuilds the whole strip on every capture open.

---

## Sequencer — a cycle-locked Tone.js drum machine

A custom step/pattern drum machine, the second programmable source beside Strudel. Design rule
(from Rhythm Rascal): a pattern is just `beats × steps` integers — triplets/quintuplets are just
different `steps`, not special cases. Plays sample-accurately locked to the Strudel cycle, with a
`cycles` control for half/double-time feels without dragging Strudel's CPS.

| File | Responsibility |
|---|---|
| `sequencer.js` | Orchestrator + UI + transport + Tone scheduling + Strudel sync + kit selection/swap. |
| `sequencer-voices.js` | Kit builders, all sharing one `{ output, trigger, has, dispose }` interface: `createKit()` (default 808/909 synth), `createLofiKit()` (warm tape-flavoured synth), `createSampleKit()` (plays decoded samples from a shared `strudel.json`). Phone-speaker-tuned, stable trigger thunks. |
| `sequencer-kits.js` | The kit **catalog** — kits as a genre × source grid (source = `synth` or a sample collection), kit-id parsing/migration, and voice-id → sample-name maps. |
| `sequencer-patterns.js` | JSON pattern **model** storage/validation/CRUD + `VOICES` catalog (localStorage). Stores models, not code strings. |

**Kits.** A kit is the instrument the pads play through — a **genre × source**
pair (source = `synth` or a sample collection); all kits speak the same voice ids
so a groove re-voices onto any kit without touching the grid. The choice persists
(`voidstar.qualia.sequencer.kit`) and is swapped live from the settings-pane
**genre** and **source** dropdowns — `setKit()` builds + wires the new kit, then
disposes the old (no silent gap). **Sample kits** load one-shots from the same Strudel
`strudel.json` packs Strudel uses, so both engines share sounds — see
[`samples.md`](samples.md). Synth kits are offline/always-available; sample kits
load async and a not-yet-loaded voice is simply silent.

**Scheduling.** `kit.output → seqLimiter → rawCtx.destination`, deliberately **bypassing
`Tone.getDestination()`** (both nodes tagged `__qualiaBypassMute`) because Strudel mutes via
`Tone.Destination.mute`. A pre-limiter analyser is adopted into `audio.js` as `'sequencer'`.
`Transport.scheduleRepeat` at `cellDuration = cycles / (cps·beats·steps)`; `computeAlignedStart`
anchors cell 0 to a cycle that's a multiple of `model.cycles`; `armAutoResync` polls until the
Strudel scheduler is "fresh" then resyncs once.

> **Note the parallel pattern stores:** `patterns.js` holds **Strudel** patterns (code strings +
> `@title` + random generator); `sequencer-patterns.js` holds **sequencer** models. Same CRUD
> shape, different payloads — keep them distinct.

**Known sharp edges (backlog):** the audio callback uses `for…of` (allocates an iterator per tick
on the audio thread — switch to indexed); heavy localStorage boilerplate (shared `prefs` helper
wanted); `newBlank`/`newRandom`/`applyModel` share a skeleton (extract `swapModel`); no `dispose()`
(listeners/observers/Tone nodes leak if ever re-created). The playhead repaint is already optimized
(`colCells` caches column→cell refs) — follow that model.

---

## Recording & export

Two **unrelated** pipelines (see architecture §7 for the full rationale):

### Screen recorder (`recorder.js`)
MediaRecorder over a composited fx+overlay canvas + the recordable audio mix.
- **Backends:** `viewport` (default — composites in-page, no screen-share dialog), `tab`
  (`getDisplayMedia`, captures the whole tab including panels), `tab-ext` (same full-tab
  pixels via a `chrome.tabCapture` stream ID minted by the companion extension in
  `extras/capture-extension`), and `obs` (see below — not a capture backend at all).
  Mobile browsers (Chrome Android,
  iOS Safari, Samsung Internet) have no working `getDisplayMedia` and no web API to launch the OS
  screen recorder, so there the tab menu item is repurposed as a **sys rec** helper: it enters
  fullscreen (hides browser chrome) and toasts instructions to start the system screen recorder —
  the only panel-inclusive capture path on phones. Stored/imported `captureMode: 'tab'` is coerced
  back to `viewport` on those devices.
- **The "Sharing this tab" banner:** Chrome pins it over the page for every `getDisplayMedia`
  tab capture — fullscreen included, in tabs and installed-PWA windows alike — and no flag/policy
  hides it. It's browser chrome, so it never lands in the saved file; it only pollutes what a live
  audience sees. `tab-ext` exists for exactly this: the extension path's only indicator is the
  tab-strip badge. Trigger is the extension hotkey/icon (the tabCapture API requires user
  invocation, so the in-page rec button can stop, but never start, these takes). See
  `extras/capture-extension/README.md` for install + use.
- **Window Controls Overlay:** the qualia manifest declares
  `display_override: ["window-controls-overlay"]`, so the installed PWA can collapse its OS title
  bar (chevron in the title bar; Chrome remembers) — the topbar then becomes the de-facto title
  bar (drag region + `titlebar-area-*` padding in `qualia.astro`), reclaiming a strip of vertical
  space during performances.
- **Codec:** MP4 (H.264+AAC) preferred, with an explicitly-ordered candidate list (high profiles
  first — Chrome Android falsely reports Baseline support then throws `EncodingError` on big
  canvases). A per-device `voidstar.recorder.skipMp4` flag falls back to WebM permanently on
  failure.
- **Sinks (priority):** File System Access direct-to-disk (with a post-close re-read because
  Chrome-on-Windows sometimes resolves `close()` with nothing on disk) → OPFS → in-memory blob,
  always keeping a belt-and-braces `memChunks` recovery copy.
- **Duration fixes:** MediaRecorder emits no duration tag (Android rejects these). WebM →
  `fix-webm-duration`; MP4 → `fixMp4Duration` then `addTimecodeTrack` (a hand-rolled ISOBMFF
  injector adding a **SMPTE `tmcd`** track + wall-clock `creation_time`). Timecode remux is skipped
  for tab/auto-save takes (it restructures the MP4 in a way QuickTime refuses).
- Output is VFR; the **CFR-normalization ffmpeg recipe** for multi-camera sync lives in the root
  `README.md` (preserves the `tmcd` track and `creation_time`).
- Backlog: `addTimecodeTrack` does a full second copy of the (multi-GB) file via `concat` — pass
  subarray views to `new Blob([...])`.

### OBS capture mode (`obs.js`)
The `obs` item in the rec menu is **not a capture backend** — it captures nothing and touches
neither the composite canvas nor MediaRecorder. It is a remote control for OBS Studio over
[obs-websocket 5.x](https://github.com/obsproject/obs-websocket), and OBS does the recording.

It exists because **qualia is meant to be recorded in its entirety.** For a live-coding set the
strudel REPL, the panels, the QR interject popups and the theme *are* the show, not chrome around
it — which is exactly what `viewport` structurally cannot capture (it composites fx + overlay only)
and what `tab` can only capture with Chrome's "Sharing this tab" banner pinned over the page. So
`obs` is the primary mode for a performance capture, and `viewport` is the fallback for when the
clean fx output is what you want.

- **Transport.** `ws://127.0.0.1:4455` by default. An insecure `ws://` to a *loopback* host is not
  mixed-content-blocked from an https page (loopback counts as potentially trustworthy) — verified
  on Chromium 141 from a non-loopback https origin. Auth is obs-websocket's challenge/response
  (`base64(sha256(base64(sha256(pw+salt)) + challenge))`) via WebCrypto. Only the `Outputs` event
  category is subscribed, which is what carries `RecordStateChanged`.
- **What the rec button does:** connect if needed → optional `SetCurrentProgramScene` →
  `StartRecord`. **Nothing that reconfigures OBS runs at showtime** — see the canvas warning
  below for why that rule exists. The button label, timer and toast are driven from OBS's own
  `RecordStateChanged`, and `GetRecordStatus` syncs on connect so attaching to an
  already-recording OBS doesn't show "stopped".
- ⚠️ **`SetVideoSettings` crashes OBS.** It makes OBS run `obs_reset_video()`, tearing down and
  rebuilding the whole video pipeline; driven from the WebSocket (a pooled request thread, not the
  UI thread) it's a known upstream crasher, notably on macOS —
  [obsproject/obs-studio#10946](https://github.com/obsproject/obs-studio/issues/10946). The first
  version of this mode applied it on every rec press to match the canvas to the display, and it
  took OBS down (`SIGABRT` on the pooled thread, main thread parked in
  `obs_wait_for_destroy_queue`). It is now a manual `match ⚠` button in the `obs…` dialog that
  confirms first, no-ops when the size already matches, and refuses while any output
  (record / stream / virtual cam) is live. The legacy `matchResolution` / `fps` config keys are
  **dropped on load** so an old profile can't reintroduce the crash. Setting the canvas by hand in
  *OBS → Settings → Video* remains the safe route.
- **Modifiers:** `auto-⛶` applies (a fullscreen window makes a clean display capture, and hides no
  panels). `auto-zen` and `auto-save` read **n/a** and are ignored — zen hides the HUD, which is the
  reason to use this mode at all, and OBS owns its own output file.
- **Scene setup lives in OBS**, deliberately: *Display Capture* of the screen the app is
  fullscreened on is the most faithful (it catches native `<select>` dropdowns and OS menus that
  window capture can miss); *Window Capture* of the installed PWA window when you want the app
  without the rest of the desktop. Audio comes from OBS's per-app capture (Windows *Application
  Audio Capture*; macOS 13+ *macOS Screen Capture* app audio; Linux PipeWire) or a virtual device —
  the in-page mix bus is not involved.
- **Failure is a toast, never an `alert()`** — a modal you must dismiss mid-set is worse than a
  failed take. There is no way to launch OBS from a page, so "OBS isn't running with its WebSocket
  server enabled" is the message. Selecting the mode (and opening `obs…`) warms the connection so
  that surfaces before showtime rather than on the first rec press.
- Config (address / password / scene) persists under `voidstar.qualia.obs.config`
  and is machine-local — it deliberately does **not** travel in a qualem, though `captureMode: 'obs'`
  does.
- **Watch item:** Chrome 141+ ships the Local Network Access permission prompt for
  public-origin → loopback requests. WebSockets aren't covered yet but are on the roadmap, so expect
  a one-time "voidstar.sh wants to access your local network" grant at some point.

### Set/loop export (`zip.js` + `wav.js`)
- `zip.js` — dependency-free **store-only ZIP** (CRC32 + local/central/EOCD), bundles `.qualem.zip`:
  a qualem JSON + loop WAVs + cab/amp captures + video clips.
- `wav.js` — minimal WAV codec: writes **32-bit IEEE float** (bit-exact round-trip for looper PCM
  in IndexedDB), reads float/16/32/8-bit. Backlog: mono fast-path for export speed.
- Orchestrated by `exportBundle`/`importBundle` in `page-init.js` via `looper.collectAssets()` /
  `installAssets()`.

> R2 (`infra/r2/`) is **not** where recordings go — it hosts large source clips for the Video quale
> (`fx/video.js`), which needs a CORS policy so `<video crossOrigin>` frames can be read into a
> WebGL texture.
