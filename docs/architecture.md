# Architecture, tech stack & realtime budgets

The technical companion to [`AGENTS.md`](../AGENTS.md). This is the *why* behind the stack and the
hard numbers a realtime instrument has to hit. For per-subsystem detail, follow the links in
`AGENTS.md`.

---

## 1. What kind of software this is

voidstar.sh is a **browser-native audiovisual live-coding instrument** (a "performance
workstation"). It sits at the intersection of three established traditions, and it helps to know
the vocabulary when reading/writing code and docs:

- **Live coding** (TOPLAP / algorave lineage) — the audio side is **Strudel** (the JS port of
  TidalCycles); the visual side bridges to **Hydra**, a live-coding *visual synthesizer*. Our fx
  engine is, in industry terms, a visual synth; a "quale"/"qfx" is one of its patches/generators.
- **VJ / visualist tooling** — comparable products are TouchDesigner, Resolume, VDMX, MadMapper,
  Notch. The "active fx + overlay post-FX + projector/OBS output" model is the VJ "media server"
  pattern.
- **Digital musical instruments (DMI / NIME)** — the rig, looper, and vox stack are software
  analogues of an amp modeler (cf. **NAM** neural amp modeling), a loop station, and a vocal
  processor (cf. TC-Helicon VoiceLive, Eventide Harmonizer). The audience layer is "networked /
  participatory performance."

Use these terms in docs and commit messages; keep the project's own coinages (qualia, quale,
entanglement, Ramblin' Visioneer) for product/brand surfaces.

---

## 2. Stack at a glance

| Layer | Choice | Notes |
|---|---|---|
| Site framework | **Astro 6** (static output, no SSR adapter) | `astro.config.mjs`, `site: https://voidstar.sh`, mdx + sitemap |
| Language | **Vanilla JS + JSDoc types** | No TypeScript build, no VDOM/React. JSDoc typedefs in `src/lib/qualia/types.js` give editor IntelliSense without a TS toolchain. |
| Hosting | **Cloudflare Pages** | `wrangler.toml`; auto-deploy on push to `main`, no CI. Output `dist/`, Node 22. |
| Audience signaling | **Cloudflare Worker + Durable Object** | `workers/entangle-signal/` — deployed separately. SQLite-backed DO, WebSocket Hibernation API. |
| Large media | **Cloudflare R2** | `voidstar-media` bucket for the Video quale's source clips (CORS in `infra/r2/`). Not where recordings go. |
| Audio | **Web Audio API** (native) + **Tone.js 15** (sequencer only) | Multi-context by design — see §5. |
| DSP | Custom **AudioWorklets** + **signalsmith-stretch** (WASM) | Neural amp LSTM, formant phase-vocoder, looper recorder; time-stretch via signalsmith. |
| Visuals | **Canvas2D + raw WebGL2 + Three.js 0.165** | Each fx picks its `contextType`. Three renderer is core-owned and shared. |
| Live coding | **Strudel** (CDN) + **Hydra** (CDN page globals) | Loaded at runtime, not bundled. |
| Pose / vision | **MediaPipe Tasks-Vision** (CDN) | `pose_landmarker_lite`, run in a worker. |
| Persistence | **localStorage** (params/presets) · **IndexedDB** (loop PCM) · **OPFS + File System Access** (recordings) | |

Heavy third-party libs (Strudel, Hydra, MediaPipe, qrcode, Trystero) are **lazy-imported from
CDN ESM at runtime**, never bundled — this keeps the static build tiny and lets the app degrade if
a CDN is unavailable. Bundled npm deps are deliberately few: `astro`, `three`, `tone`,
`signalsmith-stretch`, `fix-webm-duration` (+ astro integrations).

---

## 3. Page topology

- **`/qualia`** (`src/pages/qualia.astro`, the standalone workstation shell) — the instrument.
  Has its own PWA manifest, service worker, build-stamp, and Eruda debug overlay. It does **not**
  wrap `BaseLayout`. All behavior is wired in `src/lib/qualia/page-init.js`.
- **`/lab/entangle`** (`src/pages/lab/entangle.astro`) — the audience-participant phone page.
  Deliberately lightweight: no viz engine, just `entangle-client.js`. Reached by scanning the QR.
- **`/lab/cymatics`, `/lab/spectrum-pose`, `/lab/pose-particles`** — legacy standalone experiments
  (each is a self-contained Astro page with all logic inline). The qualia harness was extracted
  from these. Keep them working; don't extend them.
- **`/lab/qualia`** — a permanent meta-refresh **redirect to `/qualia`** (promoted out of the lab).
- Marketing/content: `/`, `/about`, `/videos`, `/posts/*`, `/lab`.

`page-init.js` (~5,100 lines) is the imperative integration layer that assembles `core` + `mesh` +
`audio` + `pose` + the panels + the keymap/MIDI handlers + export/import. It is the largest single
file and the primary structural refactor target (see `plans/maintenance-backlog.md`).

---

## 4. The qualia render core

`core.js` (`createCore`) is the host: it owns the viz `<canvas>`, **one** `requestAnimationFrame`
loop, the DPR cap, and exactly one active fx instance (switching tears down then rebuilds). It is
deliberately ignorant of audio/pose/strudel internals — they're injected — and it is the strongest,
cleanest module in the tree. Treat its design as the reference.

**The single most important realtime decision: three decoupled cadences in one rAF loop.**

| Cadence | Default | Drives | Why decoupled |
|---|---|---|---|
| **rAF tick** | display refresh | the whole loop; `dt` clamped to 0.05s | — |
| **Reactivity tick** | ~60 Hz (`setReactFps`) | `audio.tick`, band smoothing, beat/edge detectors (`onTick`) | A 120/144 Hz panel must not run audio analysis 144×/s and starve the **Strudel cyclist** (which schedules audio events ahead of time). Audio reactivity is pinned to a sane rate independent of display refresh. |
| **Viz render** | ≤ display, raised when editors open (`setAuxFps`) | `computeChannels → resolveParams → fx.update → fx.render → onFrame` (overlay, recorder) | When the Strudel/sequencer/vocoder editors are open, the page *lowers* the viz framerate to give the main thread back to live coding. |

The frame-cap uses **slop scaled to real tick length** so a 60-cap actually hits 60 on a 60 Hz
panel but can't overshoot on 144 Hz. The `update`/`render` split lets the loop skip render under
pause without breaking simulation.

**Per-frame data — `QualiaField`** (`field.js`, typed in `types.js`): `{ dt, reactDt, renderDt,
fps, time, audio, pose, crowd, params, channels }`. Plugins read state **only** through this object
— never globals — which is what makes them swappable and live-codeable.

**Modulation** (`modulation.js`) is the system's best abstraction: named scalar *channels* derived
from the field — `audio.*` (8), `pose.*` (8), `crowd.*` (8, the audience), `time.*` (6 LFOs with
incommensurate periods so auto-pilot visuals don't visibly loop). An fx declares `modulators` on a
numeric param; `resolveParams` bakes `base ⊕ source*amount` into `field.params` each frame, scaled
by the fx's `reactivity` / `poseReactivity` masters and the user's per-modulator weight. The result
is discoverable in the UI (a pill with a live meter) and targetable from Strudel.

**Three.js ownership:** the `WebGLRenderer` is created once per canvas by core and **shared** across
all `three` quales — quales must not dispose it (see `three-host.js`). This fixed a real
lost-context bug. WebGL2 contexts are created with `preserveDrawingBuffer: true` so the overlay's
post-FX (ASCII/mosh/edge) can read pixels back from any fx.

**Cam walk** (`cam-walk.js`) is a top-level virtual-camera drift over the whole scene stack (Hydra +
fx canvas + transition freeze-frame + overlay — never the camera panel or UI): slow random pan +
zoom + rotation that re-aims on gated hard beats, applied as a compositor-only CSS transform (zero
pixel cost) with an auto cover-zoom so edges never show. The recorder composite mirrors the same
matrix so recordings match the live view. Toggled by the topbar `walk` button (hotkey `U`), tuned
in the walk card, persisted in settings and qualems.

---

## 5. Why audio runs in multiple AudioContexts

There is **no single master bus.** Each sound-making subsystem runs in its own `AudioContext` and
writes to `ctx.destination`; the OS sums them at the device. This is intentional, and unifying them
would break things:

- **The rig + looper need a *native* `AudioContext`** because the native `AudioWorkletNode`
  constructor rejects Tone's wrapped (standardized-audio-context) nodes — the looper-recorder and
  neural-amp worklets simply won't instantiate in Tone's context.
- **The sequencer uses Tone's context** for sample-accurate `Transport.scheduleRepeat`.
- **The vocoder owns a private context** so it can't be caught by Strudel's destination mute or the
  sequencer's Tone master.
- **Strudel** mutes globally via `Tone.Destination.mute` and monkey-patches `AudioNode.connect`;
  the sequencer/looper tag their output nodes `__qualiaBypassMute` so Strudel's mute-gate leaves
  them alone.

Because there's no master bus, **every track hangs its own brickwall limiter** (`limiter.js`,
ceiling −1 dB) just before its destination. The **mixer** (`mixer.js`) is therefore a *surface*
over scattered per-subsystem controls, not a real summing node — each channel adapter calls into
the owning module.

Cross-context audio is bridged for two consumers:
- **Visual reactivity:** each source's analyser is `adopt`ed into `audio.js`, which merges them into
  the single `AudioFrame`.
- **Recording:** a lazily-created recordable-mix `AudioContext` re-sources adopted analysers via
  `MediaStreamAudioDestinationNode` so the screen recorder captures everything.

---

## 6. Realtime performance budget (the hard numbers)

**Visuals**
- Target **30+ fps at 1080p on an integrated GPU**; stretch 60.
- Global DPR cap **1.5×** (a 1920×1080 viewport → ≤ 2880×1620 backing buffer). Heavy fragment
  shaders may declare `maxDpr: 1.0` to halve fragment work on hi-DPI screens.
- The hot path (`update` + `render`) must allocate **zero** per frame. Pre-allocate in `create()`,
  reuse buffers/Path2D/ImageData forever. (Current allocation hotspots are tracked in the backlog.)

**Audio (stricter — this is non-negotiable)**
- Worklet `process()` must be **allocation-free and lock-free**. The neural-amp LSTM is the hottest
  loop in the app (O(4·H²) mul-adds + transcendentals per sample); treat any work there as
  expensive and prefer lookup tables / WASM-SIMD over naive scalar JS.
- Never rebuild large buffers (waveshaper curves, IRs, noise) on the audio thread or on every
  knob tick — quantize/cache by value and rebuild only on meaningful change.
- The reactivity tick is decoupled (§4) specifically to protect the Strudel cyclist's lookahead.
  Anything you add to `onTick`/`onFrame` runs every cadence — keep it cheap and `try/catch`-guarded.

**Memory / lifecycle**
- WebGL/Three fx must release GPU resources in `dispose()`. Canvas2D-only fx can no-op.
- Long sets toggle cameras, fx, and panels repeatedly — disposal leaks compound. Several modules
  currently lack teardown (tracked in the backlog); new code should ship a `dispose()`.

**Degradation ladder** (apply in order under load): lower DPR → fewer particles → drop optional
overlay passes → idle mode. A feature that can't degrade isn't done.

---

## 7. Recording & export

Two unrelated pipelines:

- **Screen recorder** (`recorder.js`): composites fx + overlay into one canvas, `captureStream(30)`
  + the recordable audio mix → **MediaRecorder**. Prefers MP4 (H.264+AAC) with a carefully ordered
  codec candidate list (high profiles first, because Chrome Android *reports* Baseline support then
  throws `EncodingError` on large canvases). Sinks in priority order: File System Access
  direct-to-disk → OPFS → in-memory blob, with belt-and-braces recovery copies. Post-processing
  fixes MediaRecorder's missing-duration bug (`fix-webm-duration` / `fixMp4Duration`) and appends a
  **SMPTE `tmcd` timecode track** + wall-clock `creation_time` (`mp4-timecode.js`) so clips align
  on an NLE timeline. Output is variable-frame-rate; the CFR-normalization ffmpeg recipe is in the
  root `README.md`.
- **Set/loop export** (`zip.js` + `wav.js`): a dependency-free store-only ZIP bundles a `.qualem.zip`
  — a qualem JSON snapshot plus loop WAVs (32-bit float, bit-exact) and cab/amp captures. This is
  the round-trip for the looper's IndexedDB PCM, orchestrated in `page-init.js`.

`qualem.js` encodes the **whole-experience snapshot** (all params/presets, sparse-diffed against
schema defaults, gzip + base64url, device-fingerprinted) — the basis for shareable scene URLs.

---

## 8. Control surface

The **DOIO KB16-01** macro pad runs a Keychron-Launcher keymap that sends *plain keystrokes* the
page already listens for (no custom firmware). Knob encoders are matched by physical `e.code` so
layout/NumLock can't break them. Hotkeys are suppressed only while a code editor or text field has
focus — the rig panel's sliders stay live so knobs nudge them. Both the keystroke path and a
**full MIDI path** (buttons→Note-On, knobs→CC1/2/7, Chromium only) dispatch through one shared
`padActions` map in `page-init.js`, so they never drift. MIDI matters for lid-shut / screen-off
gigs: notes reach a backgrounded/occluded window and don't wake a sleeping display, unlike
keystrokes. `H` (topbar ☾) is an **in-app blackout** — `core.setRenderSuspended` stops the fx
render to free the GPU while audio keeps playing (a web page can't power down the backlight; sleep
the real display at the OS level for that). Full mapping:
[`docs/doio-kb16-qualia-keymap.md`](doio-kb16-qualia-keymap.md); lid-shut / screen-off playbook:
[`docs/headless-and-screen-off.md`](headless-and-screen-off.md).
