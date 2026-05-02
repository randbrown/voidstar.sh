# Plan: `qualia` — pluggable lab harness for voidstar visualizers

## Context

`voidstar.sh` is a live-performance Astro app with three working lab pages: **cymatics** (audio-reactive Chladni patterns, ~2781 lines), **spectrum-pose** (FFT + MediaPipe pose, ~1711 lines), and **pose-particles**. Each is a self-contained Astro page with all logic inline. Cymatics has the richest feature set — Strudel REPL, Hydra layer, mic/cam pickers, localStorage presets, zen mode — but its visualizer modes (`chladni`, `radial`, `interference`, `lissajous`, `ripples`, `field`) are **hardcoded `switch` cases** sharing global state. Adding a new mode means editing the file in 5 places. Sliders, presets, and beat-detection are also bespoke per file, duplicated between cymatics and spectrum-pose.

The user wants to add a new family of "voidstar art" effects (Gargantua-style black holes, neural filaments, spacetime warps, plasma ribbons, electric hourglasses, wormhole tunnels) and use this as the moment to build a **permanent, pluggable foundation**. Theme is "qualia" — design components named with that prefix where it reads naturally.

A second source proposed a Three.js + TypeScript + monolithic `VoidstarCosmicSimFX` class with seven baked-in presets. The plugin-contract idea (init/resize/update/render/dispose, normalized audio + pose inputs, audio→uniform mapping table) is good and is incorporated below. The Three.js dependency, the monolithic class, and the absence of Strudel/Hydra/device-picker integration are not — they conflict with the existing "vanilla JS, no VDOM, close to the metal" stack and ignore features the user explicitly wants kept.

**Decisions (confirmed):**
- New page **alongside** cymatics — `src/pages/lab/qualia.astro`. Cymatics stays untouched.
- **Mix render stack**: each plugin picks its own context — Canvas2D for 2D/particle fx, raw WebGL2 for shader fx. **No Three.js, no twgl** — minimal helpers in-tree.

**Outcome:** a harness where adding a new `voidstar art` effect is one new file in `src/lib/qualia/fx/` exporting a small module — no edits to the page, no global state, audio + pose + params delivered as a single `QualiaField` per frame.

---

## Architecture

```
QualiaCore (host)
  ├── audio pipeline   →  AudioFrame   (bands, beat, transient, RMS, FFT/waveform bufs)
  ├── pose pipeline    →  PoseFrame    (normalized {head, hands, shoulders, …} per person)
  ├── device pickers   (mic, camera — enumerate + persist + hot-swap)
  ├── strudel + hydra  (canvas stacking, eval-clear hooks, globalThis.a)
  ├── ui builder       (renders sliders/toggles/dropdowns from plugin's params schema)
  ├── preset store     (localStorage; per-plugin namespaced)
  ├── plugin registry  ← QualiaMesh
  └── render loop      (rAF, dt-clamped, FPS readout, DPR cap, zen mode)
            │
            ▼
        QualiaFX plugin (one of N)
            ├── id, name, contextType: 'canvas2d' | 'webgl2'
            ├── params: ParamSchema[]        ← UI is generated from this
            ├── presets?: Record<name, paramValues>
            ├── create(canvas, opts) → instance
            └── instance: { resize, update(field), render, dispose }
```

**Per-frame data delivered to `update(field)`:**
```js
field = {
  dt, time,
  audio: { bands:{bass,mids,highs,total}, beat:{active,pulse}, highs:{active,pulse},
           rms, spectrum: Uint8Array, waveform: Uint8Array },
  pose:  { people: [{ head, neck, shoulders:{l,r}, elbows, wrists, hips, knees, ankles, confidence }],
           timestamp },
  params: { ...currentSliderValues }
}
```

Plugins do **not** read globals. The `QualiaField` is the only input. This is what makes them swappable and Strudel-pattern-driveable later.

---

## File layout

```
src/pages/lab/qualia.astro             # UI shell only — topbar, picker dropdowns, panel mount, CSS tokens
src/lib/qualia/
  core.js          # QualiaCore: lifecycle, registry, render loop, dispatches QualiaField
  audio.js         # AnalyserNode + bands + beat (extracted from cymatics:lines 688–752, 1701–1734)
  pose.js          # MediaPipe wrapper → PoseFrame (extracted from spectrum-pose:1234–1279)
  devices.js       # mic/cam enumerate + persist + change handler (cymatics:1556–1779)
  presets.js       # localStorage namespacing + AUDIO_PRESETS (cymatics:494–536)
  ui.js            # Generic builder: param schema → DOM controls + label updates
  strudel-hydra.js # Embed Strudel, patch evaluate/stop, expose globalThis.a (cymatics:1899–2070)
  webgl.js         # ~80 lines: compileProgram, fullscreenTri, uploadAudioUniforms
  registry.js      # QualiaMesh: register(plugin), get(id), list()
  field.js         # QualiaField factory + smoothing helpers
  fx/
    _template.js          # boilerplate any new fx copies from
    chladni.js            # PORT of cymatics chladni mode (Canvas2D)  — proves Canvas2D path
    singularity-lens.js   # NEW black-hole shader (WebGL2 fragment)   — proves WebGL2 path
    neural-field.js       # NEW filament network (Canvas2D + audio firing pulses)
src/lib/qualia/README.md  # short authoring guide for new fx (request from user before writing)
```

Astro page imports only `core.js` + the registry; plugins are registered there. Adding a new fx = one file + one line in the registry.

---

## Plugin contract (in JS w/ JSDoc; no .ts files)

```js
// src/lib/qualia/fx/_template.js
/** @type {import('../types.js').QualiaFXModule} */
export default {
  id: 'singularity_lens',
  name: 'Singularity Lens',
  contextType: 'webgl2',          // 'canvas2d' | 'webgl2'
  params: [
    { id: 'horizon',  label: 'Horizon r_s',     type: 'range', min: 0.05, max: 0.4,  step: 0.005, default: 0.16 },
    { id: 'spin',     label: 'Disk spin',       type: 'range', min: 0,    max: 1,    step: 0.01,  default: 0.4 },
    { id: 'palette',  label: 'Palette',         type: 'select', options: ['accretionGold','voidblue','neuralMagenta','plasmaOrange'], default: 'accretionGold' },
    { id: 'audioBindBass', label: 'Bass→pulse', type: 'toggle', default: true },
  ],
  presets: {
    default:   { horizon: 0.16, spin: 0.4 },
    interstellar: { horizon: 0.20, spin: 0.55, palette: 'accretionGold' },
  },
  async create(canvas, { gl }) {
    // compile shaders, set up fullscreen triangle…
    return {
      resize(w, h, dpr) { /* gl.viewport, FBO realloc */ },
      update(field) { /* collect uniforms from field.audio + field.pose + field.params */ },
      render() { /* gl.drawArrays */ },
      dispose() { /* delete program, buffers */ },
    };
  },
};
```

`core.js` walks `params` to build the slider/toggle/select UI and to build the `field.params` object — same loop handles everything, no hand-coded controls per fx.

---

## Reference fx implementations (initial three)

1. **`chladni.js` (Canvas2D)** — port of cymatics' Chladni mode. Validates that the contract supports the existing app's needs: particle buffer, gradient field, audio modulation. ~250 lines. Compare frame-for-frame against cymatics to confirm parity.
2. **`singularity-lens.js` (WebGL2)** — fullscreen-triangle fragment shader doing analytic Schwarzschild lensing over a procedural starfield + thin accretion disk. Audio map: `bass → horizon_pulse`, `mid → spin`, `treble → ring_brightness`, `beat → ring_shockwave`. Pose map: head landmark biases the singularity center; hands inject perturbation. ~150 lines JS + ~120 lines GLSL.
3. **`neural-field.js` (Canvas2D)** — graph of soma nodes connected by curved filaments; beat triggers traveling pulses along edges. Audio map: `bass → soma glow`, `mid → branch density`, `beat → fire pulse`. Pose-aware: hand near node = local stimulus. ~300 lines.

Three plugins is enough to validate: (a) Canvas2D path, (b) WebGL2 path, (c) pose + audio binding shape, (d) preset round-trip. Further fx from the mood board (`golden_data_spires`, `wormhole_tunnel`, `electric_hourglass`, `plasma_ribbons`, `voidstar_kaleido`) are then one-file-per-fx adds.

---

## Reused patterns from existing code (verbatim or near-)

| Pattern | Source | Target |
|---|---|---|
| AnalyserNode setup, band extraction, beat detection | `cymatics.astro:688–752, 1701–1734` | `qualia/audio.js` |
| MediaPipe PoseLandmarker lifecycle | `spectrum-pose.astro:1234–1279` | `qualia/pose.js` |
| Mic/cam enumeration + persistence + hot-swap | `cymatics.astro:1556–1779` | `qualia/devices.js` |
| AUDIO_PRESETS table + applyPreset | `cymatics.astro:494–536` | `qualia/presets.js` |
| Strudel embed + Hydra canvas stacking + evaluate/stop hooks | `cymatics.astro:1899–2070` | `qualia/strudel-hydra.js` |
| CSS design tokens (`--accent`, `--cyan`, `--void`, `--surface`, …) | `cymatics.astro:42–56` | `qualia.astro` `:root` |
| Topbar layout, zen mode, video PIP sizing | `cymatics.astro:82–100, 2350–2357` + `spectrum-pose.astro:1431–1568` | `qualia.astro` |
| rAF loop with dt clamp + FPS sampler | `cymatics.astro:1660–1693` | `qualia/core.js` |

Cymatics is **not modified** — code is copied/adapted into `src/lib/qualia/`, then refined. Tradeoff: short-term duplication; we accept it because the user does not want to risk breaking cymatics.

---

## What's improved vs cymatics

- **Pluggable**: new fx = one file, no `switch` edits, no global mutation.
- **UI generated from schema**: no more `document.getElementById('ap-foo').addEventListener('input', …)` stanzas per slider — `ui.js` walks `params` and emits the DOM + listeners + label updates uniformly.
- **DPR cap**: `min(devicePixelRatio, 1.5)` by default (cymatics renders 1:1, missing the cap; spectrum-pose has none either). Reduces fragment cost on Retina.
- **Per-plugin presets**: each fx gets its own preset namespace in localStorage (`qualia.<fxId>.presets`), so switching fx doesn't lose params; AUDIO_PRESETS stay global.
- **Pose data normalized**: `{head, leftHand, rightHand, …}` instead of raw 33-element arrays — fx code is shorter and more readable.
- **Strudel-driveable**: `globalThis.qualia = { setParam(fxId, paramId, value), getField() }` so live-coded patterns can modulate params during performance. (Same idea as `globalThis.a` in cymatics, generalized.)

## What's intentionally **not** done (aligned with user's brief)

- No Three.js. No TypeScript files (JSDoc gives types in editors without build changes).
- No bundler or Vite plugin work — Astro's existing pipeline handles ESM imports.
- No new framework dependencies. `webgl.js` is ~80 lines hand-rolled.
- No 3D model loading.
- No telemetry, no tests for the visual fx (manual perf sanity in browser only — these are art pieces).

---

## Files to create / modify

**Create:**
- `src/pages/lab/qualia.astro` (UI shell, ~400 lines — much smaller than cymatics because logic is in `src/lib/qualia/`)
- `src/lib/qualia/core.js`
- `src/lib/qualia/audio.js`
- `src/lib/qualia/pose.js`
- `src/lib/qualia/devices.js`
- `src/lib/qualia/presets.js`
- `src/lib/qualia/ui.js`
- `src/lib/qualia/strudel-hydra.js`
- `src/lib/qualia/webgl.js`
- `src/lib/qualia/registry.js`
- `src/lib/qualia/field.js`
- `src/lib/qualia/types.js` (JSDoc typedefs only)
- `src/lib/qualia/fx/_template.js`
- `src/lib/qualia/fx/chladni.js`
- `src/lib/qualia/fx/singularity-lens.js`
- `src/lib/qualia/fx/neural-field.js`

**Modify:**
- `src/pages/lab.astro` — add a new entry to the `experiments` array for `qualia` with status `live`.

**Untouched:** `cymatics.astro`, `spectrum-pose.astro`, `pose-particles.astro`, all other pages.

---

## Naming (Qualia theme, used judiciously)

- `QualiaCore` — host class in `core.js` (registry + render loop + lifecycle)
- `QualiaField` — per-frame data object (audio + pose + params + dt + time)
- `QualiaFX` — plugin contract (the `QualiaFXModule` JSDoc typedef)
- `QualiaMesh` — registry that wires plugins to UI + presets
- Plugin ids stay descriptive (`singularity_lens`, `neural_field`) — no Qualia prefix on user-facing names.

`Qualion`, `Qualium`, `QualiaFlow` are reserved for future internals (e.g., `Qualion` = a single particle in particle-fx, `QualiaFlow` = chained post-FX pipeline if/when that lands).

---

## Verification (end-to-end)

1. `npm run dev` → open `http://localhost:4321/lab/qualia`.
2. Confirm topbar matches cymatics look-and-feel: FPS, mode select, levels readout, mic/cam pickers, audio panel, zen toggle.
3. **Audio**: enable mic; speak/clap/play → bass/mids/highs bars move; beat indicator pulses on transients.
4. **Pose**: enable camera; confirm landmarks visible (debug overlay); switch cameras with picker → no crash, no audio glitch.
5. **Plugin switch**: dropdown switches between `chladni` / `singularity_lens` / `neural_field` live, no reload, no leaks (DevTools memory snapshot stable across 10 swaps).
6. **Chladni parity**: side-by-side with `/lab/cymatics` on `chladni` mode — same particle behavior at the same audio.
7. **Singularity Lens**: 30+ fps at 1080p on integrated GPU; audio modulation visibly affects horizon/disk; bass beat triggers a ring shockwave.
8. **Neural Field**: filaments fire on beats; soma glow tracks bass; hand near a node creates a local stimulus.
9. **Presets**: change params, save preset, switch fx, switch back → params restored. Reload page → params restored.
10. **Strudel**: open REPL, eval a pattern, confirm Hydra canvas appears under viz, `globalThis.a.fft` populated; `globalThis.qualia.setParam('singularity_lens','horizon',0.25)` from REPL changes the visual live.
11. **Zen mode**: hides topbar, ESC restores. Video PIP sizes (small/large/full/hidden) cycle correctly.

---

## Out of scope for this plan

- Implementing more than the three reference fx. Once the harness is in place, additional fx (`golden_data_spires`, `wormhole_tunnel`, `electric_hourglass`, `plasma_ribbons`, `voidstar_kaleido`) each become one new `src/lib/qualia/fx/<name>.js` + one `register()` call.
- Migrating cymatics' modes (`radial`, `interference`, `lissajous`, `ripples`, `field`) into qualia. Worth doing later but not blocking — chladni alone validates the Canvas2D port.
- Authoring `src/lib/qualia/README.md` (deferred until the contract is final).
- WebGPU path. Stay on WebGL2 + Canvas2D until there's a concrete reason to upgrade.
- Worker / OffscreenCanvas. Try in-thread first; revisit only if profiling shows main-thread starvation.

---

## Risks & mitigations

- **Cymatics is 2781 lines of intertwined globals; extraction may miss subtle coupling.** Mitigation: port chladni first and A/B against `/lab/cymatics` — visual diff is the contract.
- **Astro inline-script + ESM-import pattern can be finicky with `import()` of CDN modules (MediaPipe, Strudel).** Mitigation: keep the same `await import('https://cdn.jsdelivr.net/...')` pattern that cymatics already uses; don't try to bundle them.
- **Hydra canvas stacking depends on z-index ordering of multiple `<canvas>` elements.** Mitigation: copy cymatics' z-index map verbatim (`#hydra-canvas` z:1, `#canvas` z:2, `#test-canvas` z:5, `#video` z:10, `#topbar` z:20).
- **Strudel patches `evaluate()` / `stop()` — patching twice if user navigates back to qualia could double-clear.** Mitigation: `ensureStrudelEvalPatch()` already guards with idempotent assignment; preserve.
