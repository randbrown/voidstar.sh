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

**Module split (clean — preserve it):**

| File | Responsibility |
|---|---|
| `looper.js` | Orchestrator: track model, all DOM/UI, persistence, the qualem surface. (~2,765 lines — should shed the strip UI, tuner, and cab/amp library; see backlog.) |
| `looper-audio.js` | The capture + playback engine. Owns its **own native `AudioContext`** (worklets reject Tone's wrapped context). Hosts the rig strip and rig master. |
| `looper-render.js` | Pure canvas waveform renderer, one per track ("takes in lanes" + sweeping playhead), with cached min/max peaks. |
| `looper-store.js` | Minimal IndexedDB store (`tracks` + `misc`). |
| `looper-stretch.js` | Lazy loader for **signalsmith-stretch** (WASM + worklet, pitch-preserving time-stretch). |
| `worklets/looper-recorder.js` | The audio-thread processor: armed real-time capture (posts 128-frame quanta) **and** the always-on ~40 s ring for retro grabs (slice posted only on `{cmd:'grab'}`, so lookback is free until used). |

**Data flow.** Record: mic → strip → recorder worklet → per-channel `Float32` chunks on the main
thread → on stop, sliced to the grid-snapped region with 0.5 s headroom → `AudioBuffer`. Playback:
per-track channel (gain + optional stretch node) + transient voice (looping `BufferSource` for
varispeed, or stretch node for fit + preserve-pitch) → loop master → rig master → limiter →
destination, with the analyser adopted into `audio.js` as `'looper'`. Sync uses only **relative**
durations `(boundary − pos)/cps`, so it's portable across the two AudioContexts.

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
- **Backends:** `viewport` (default — composites in-page, no screen-share dialog) and `tab`
  (`getDisplayMedia`, captures the whole tab including panels).
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
