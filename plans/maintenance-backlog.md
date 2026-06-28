# Maintenance backlog — refactors, perf wins, tech debt

A living, prioritized record of code-health findings from a full-codebase review (2026-06). These
are **identified, not yet done** — pick from here when you have cleanup budget. Nothing here is a
correctness emergency; the instrument works. Items are grouped and roughly ordered by leverage.

Companion reading: [`../docs/architecture.md`](../docs/architecture.md) (perf budgets),
[`../docs/audio-engine.md`](../docs/audio-engine.md), [`../docs/looper-and-sequencer.md`](../docs/looper-and-sequencer.md),
[`../docs/livecoding.md`](../docs/livecoding.md), [`../docs/entanglement.md`](../docs/entanglement.md).

---

## A. Structural refactors (highest leverage)

1. **Split `page-init.js` (~5,100 lines).** The entire imperative integration layer is one file.
   Extract, in rough order of independence: the fx registration list; the export/import
   `.qualem.zip` bundle (`exportBundle`/`importBundle`); the DOIO keymap + MIDI handlers (already
   spec'd in `docs/doio-kb16-qualia-keymap.md`); per-panel wiring. `core.js` is already cleanly
   injectable — this is pure mechanical decomposition.
2. **Harden + decompose `strudel-hydra.js` (~1,636 lines).**
   - ✅ **Pin the Strudel CDN version** — *done:* pinned to `@1.3.0` (was `@latest`) via a
     `STRUDEL_VERSION` const with a bump note.
   - Add a real `dispose()`: the global `AudioNode.connect` patch, two ResizeObservers, two
     intervals, window/document listeners, and audio nodes all leak.
   - Split into transport / audio-tap / cycle-clock / editor-settings / pattern-API.
3. **Shed UI from the large audio files:** `looper.js` (~2,765), `vocoder.js` (~1,557),
   `sequencer.js`. Each mixes engine + DOM; extract the panel UI (and the shared drag block, B2).
4. **Split `overlay.js` (~803 lines)** into pose-visuals / ripples / post-process (ASCII, mosh,
   edge) — three independent units.

## B. Cross-cutting duplication → shared utilities

1. ✅ **`prefs.js` (`getRaw`/`setRaw`/`getBool`/`setBool`/`getNum`/`getJSON`/`setJSON`/`clamp01`).**
   *Done:* added the module and migrated `sequencer.js`, `sequencer-patterns.js`, `patterns.js`
   (behavior-preserving — same keys, defaults, and post-parse validation) and pointed `looper.js`'s
   `lsGet`/`lsSet`/`clamp01` at it. Remaining inline localStorage lives in `looper.js`'s larger
   config blob and `strudel-hydra.js`/`vocoder.js` panel state — migrate opportunistically.
2. ✅ **`makeDraggablePanel(id, panel)`.** *Done:* the verbatim drag/reposition/ResizeObserver
   block (~70 lines × 4) now lives in `panel-pos.js`; `mixer.js`, `sequencer.js`, `vocoder.js`, and
   `strudel-hydra.js` each call `makeDraggablePanel('<id>', panel)` (grip derived as `${id}-header`,
   returns `reposition` for their `open()`). **Needs a smoke test** (UI, not build-checkable): open
   each panel, drag it by the header, confirm it moves and clamps to the viewport, resize via the
   corner, reload → position persists, and each panel still tucks under the topbar on open.
   *Remaining:* `entangle-ui.js` and `looper.js`/`page-init.js` have their own drag variants — fold
   in opportunistically if they match.
3. **`fx-helpers.js`.** `ema`/`damp`/`decay`, idle-spectrum sine fallback, fade-fill,
   smoothed-pose-target, `hslToRgb`, `drawFullscreen` (webgl) are reinvented across nearly every fx
   (~6 hand-rolled EMA variants). Centralizing also kills per-fx allocation drift.
4. **Reuse `limiter.js` in the vocoder** (it reimplements `makeLimiter`/`setLimiterEngaged` with a
   −1.5 dB ceiling) — parameterize the ceiling.
5. ✅ **Move the `getUserMedia` ladder into `devices.js`** — *done:* `openMicStream(deviceId, base)`
   holds the try-exact-then-default fallback ladder; `audio.js` and `vocoder.js` each keep their own
   `MIC_CONSTRAINTS` (stereo vs low-latency hint) and pass it in. **Needs a mic smoke test:** mic
   input still drives visuals/monitor (audio.js) and the vocoder still captures; switching the mic
   picker to a now-unplugged device falls back to default rather than erroring.
6. **Array-based disposal** for `rig-strip.js` and `vocoder.js` — both hand-list ~40 nodes in
   teardown (drift risk). Push nodes into an array at creation; iterate on dispose.
7. ✅ **Share the cycle-pool / phase-pool predicate** — *done:* `isStepInPhase` now delegates to
   `isInCycle`; both pool files + `panel-pos.js` also moved their raw localStorage onto `prefs.js`.
8. **Unify the audio-uniform upload** shape (`webgl.js` vs `three-host.js`).

## C. Realtime performance wins (ranked)

1. **Neural amp LSTM worklet (`worklets/neural-amp.js`)** — hottest loop in the app (O(4·H²)
   mul-adds + 4 `exp`/`tanh` per hidden unit per sample). tanh/sigmoid **lookup table** (or the
   tanh-based sigmoid identity to share one call); a WASM/SIMD backend is the bigger lever; add
   **denormal flushing** for silent-decay state.
2. **Waveshaper curve churn on knob drags** — rig Earth/Metal and vocoder gate/de-ess rebuild
   1–2K-float arrays on every slider tick. Quantize/cache by amount, rebuild on epsilon change.
3. ✅ **`pinkNoiseBuffer` generated 2× per vocoder build** — *done:* memoized per (ctx, seconds).
4. ✅ **`pitch.js` allocates a `Float32Array` per call**, called per frame — *done:* hoisted to a
   reused module scratch (guard cells zeroed to preserve fresh-alloc semantics).
5. ✅ **`field.js scaleAudio` allocates a nested frame object** every frame for every fx with
   reactivity ≠ 1 — *done:* writes into a reused module scratch.
6. **Per-frame canvas2d gradients** — `overlay.js` creates a linear gradient *per bone per person*;
   `neural-field.js` a radial gradient *per soma*. Cache by quantized hue.
7. ✅ **`sequencer.js` audio callback uses `for…of`** (iterator alloc per tick on the audio thread)
   — *done:* indexed loop.
8. **`chladni.js evalField` returns 3-tuple arrays per particle** (~6,000 allocs/frame) + a
   `createImageData` every frame in field mode — return via out-params, reuse the ImageData.
9. **Strudel editor "perf mode" default-on** in performance contexts (disable per-frame pattern
   highlighting) — the biggest single main-thread lever during a set.
10. **Fix/clarify `strudel.perFrame` wired to `core.onFps` (~5 Hz)** — Hydra `a.fft` visuals update
    at ~5 fps despite the name. Rename or rewire.
11. **`mp4-timecode.addTimecodeTrack` full second copy** of a multi-GB file via `concat` — pass
    subarray views to `new Blob([...])`. (Auto-save already skips this pass.)
12. **`recMixCtx` (recordable-mix AudioContext) is never closed** — persistent extra audio graph
    after the first recording; notable on mobile. Close on recorder teardown.
13. **Pose:** downscale the source before `createImageBitmap` (landmarks don't need 1920px) to cut
    copy + inference cost, especially on phones.
14. **Looper record** keeps every 128-frame quantum as a separate array then concatenates — pre-grow
    a single buffer (the live-view ring already does this).
15. **Overlay sparks** loop iterates the full 2,400-slot ring every frame regardless of live count —
    track a live-count cursor.

## D. Correctness / robustness

1. **Entangle Worker/DO has no validation, rate-limiting, size-cap, or auth** — bandwidth flood +
   `role`/`target` spoof are possible. Add a per-socket token bucket, message-size cap, drop unknown
   topics. (Low-stakes for an intimate set; do before any public deployment.)
2. ✅ **Delete or honestly relabel `entangle-transport.js`** — *done (relabeled):* banner on the
   file + corrected the `entangle.js` comment so it's marked research-only, not a drop-in fallback.
3. **Smooth direct audience param control** — add a per-param slew so phone-driven sliders don't
   step on the projection.
4. **Add `dispose()` paths** where missing: `strudel-hydra.js` (worst), `sequencer.js`,
   `entangle-ui.js` (intervals + perpetual skeleton rAF), and terminate the **pose worker** on
   `stopCamera`.
5. ✅ **`entangle.js`** — *done:* `modes.skeleton` now initialized to `false` explicitly.
6. **`looper-audio.js stopRecording`** uses `setTimeout` to wait for the OUT boundary — fragile
   under tab-throttling; the worklet has sample-accurate timing it could use.

## E. Documentation drifts (most fixed in this pass — keep them fixed)

- `agent-reference.md` said "GitLab Pages" → it's **Cloudflare Pages**. *(fixed)*
- `/lab/qualia` is a redirect to `/qualia`; AGENTS.md / THEMES.md / fx-contract README referenced
  the old path. *(fixed)*
- `lab.astro` card + `qualia-plan.md` said "3 reference fx" → there are **22 + arcade**.
  *(lab.astro fixed; plan files carry a historical-doc banner)*
- `qualia-plan.md` "no Three.js" is reversed → Three.js is a dependency. *(banner added)*
- `src/lib/qualia/README.md` (fx contract) predated `types.js`: missing `'three'` context, `text`/
  `file` param types, `autoPhase`, `maxDpr`, `crowd.*` channels. *(fixed)*
- `_synthwave.md` said "not yet implemented" → `synthwave.js` ships. *(banner added)*
- Root `README.md` was the Astro starter boilerplate. *(rewritten)*
- GitHub handle drift: `lab.astro` linked `github.com/voidstar` vs `randbrown` elsewhere. *(fixed)*

## F. Easy value-adds (low cost, existing infra)

- **`ParamText`/`ParamFile` already exist** in `types.js` — synthwave's deferred custom text and any
  title/label/cue text is now trivial.
- **MIDI-learn for any param** — the MIDI CC path + the modulation channel registry already exist;
  generalize beyond the three hard-coded CCs.
- **Recorder chapter markers** — a SMPTE timecode track is already written; add a hotkey to drop
  named markers for post.
- **Visual metronome / click** bound to `cps` (the tuner + cps clock already exist).
- **Scene crossfade** between two `qualem` snapshots (whole-experience state already encodes).
- **Shared offscreen-canvas pool** for the overlay post-FX (each currently keeps its own).
