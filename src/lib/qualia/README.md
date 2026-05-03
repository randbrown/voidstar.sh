# Authoring qualia fx

This guide is for writing a new visualizer ("fx") for the qualia harness in this directory. It is intended to be self-contained — an agent or human author should be able to ship a working fx by reading only this file plus one or two of the reference fx in [`./fx/`](./fx).

## Terminology

| Term | Meaning |
|---|---|
| **fx** (or **fx module**) | A single visualizer plugin. One file at `src/lib/qualia/fx/<kebab-name>.js`, `default export` conforming to `QFXModule`. |
| **QualiaCore** | The host. Owns the canvas, render loop, fx instance, and DPR. Source: [`core.js`](./core.js). |
| **QualiaField** | The per-frame data object passed to `update(field)`. Audio + pose + params + dt + time. The *only* state an fx may read. |
| **QualiaMesh** | The fx registry. Source: [`registry.js`](./registry.js). |
| **Overlay** | The cross-fx Canvas2D layer that composites skeleton, sparks, aura, ripples, and ASCII post on top of the active fx. fx authors don't render any of those. Source: [`overlay.js`](./overlay.js). |

Don't call them "shaders" (a fragment shader is an *implementation detail* of fx that happen to use WebGL2). Don't call them "plugins" (too generic). The codebase says **fx**.

Plugin ids stay descriptive snake_case (`singularity_lens`, `neural_field`). Plugin display names are Title Case ("Singularity Lens"). User-facing names don't get a `Qualia` prefix.

---

## The contract

```js
// src/lib/qualia/fx/_template.js — copy this to start.

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'my_fx',                 // snake_case, used as localStorage key + Strudel hook
  name: 'My Fx',               // Title Case, shown in topbar
  contextType: 'canvas2d',     // 'canvas2d' | 'webgl2'

  params: [/* ParamSpec[] — see below */],
  presets: { default: { /* required */ } },

  async create(canvas, { ctx /* if canvas2d */, gl /* if webgl2 */ }) {
    // Allocate buffers, compile shaders, build initial state HERE.
    // create() is called once per fx-switch.

    return {
      resize(w, h, dpr) { /* re-allocate buffers tied to canvas size */ },
      update(field)     { /* read field, advance state */ },
      render()          { /* draw, no field reads here */ },
      dispose()         { /* release GL programs, buffers, refs */ },
    };
  },
};
```

Then register in [`page-init.js`](./page-init.js):
```js
import myFx from './fx/my-fx.js';
mesh.register(myFx);
```

That's it. UI controls are generated from `params`. Persistence is automatic. The Strudel hook (`globalThis.qualia.setParam('my_fx', 'thickness', 0.7)`) just works.

---

## QualiaField — the only input

```js
field = {
  dt,        // seconds since last frame, clamped to 0.05
  time,      // seconds since core.start()
  audio: {
    bands: { bass, mids, highs, total },   // each in [0,1], EMA-smoothed
    beat:  { active, pulse },              // active=true on hit; pulse=1→0 envelope (~180ms half-life)
    highs: { active, pulse },              // same shape, for hat/cymbal hits
    rms,                                   // time-domain energy [0,1]
    spectrum,                              // Uint8Array of FFT bins, or null when audio is off
    waveform,                              // Uint8Array of time-domain samples, or null when off
  },
  pose: {
    people: [{
      head, neck,                          // each is a Landmark
      shoulders: { l, r },
      elbows:    { l, r },
      wrists:    { l, r },
      hips:      { l, r },
      knees:     { l, r },
      ankles:    { l, r },
      raw,                                 // original 33-element MediaPipe array
      confidence,                          // mean visibility over named joints
    }],
    timestamp,                             // performance.now() at last detection
  },
  params: { /* current values keyed by your param ids */ },
};

// Landmark = { x, y, z, visibility }, x,y in [0,1] camera-frame coords.
```

### Idle behavior matters

`audio.spectrum` is `null` when the user hasn't enabled audio yet. **Test your fx with audio off** — it should still feel alive. Use `field.time` for slow drift, or fall back to gentle randomness. Reference: [`fx/chladni.js`](./fx/chladni.js) lissajous mode draws a slowly-rotating ideal Lissajous when no waveform is available.

### Beat sharpness is everything

`audio.bands.bass` is *smooth* (EMA), so it slowly pumps. `audio.beat.active` and `audio.beat.pulse` are *sharp* — that's what makes percussive elements read as percussive. The pattern that works:

```js
const radius = base + bands.bass * 1.4 + beat.pulse * 0.6 + spike * 1.8;
//                    ^ slow pump        ^ percussive flash    ^ extra envelope
```

Reference: [`fx/neural-field.js`](./fx/neural-field.js) `sSpike[i]` per-soma envelope.

### Pose coordinates are camera-frame

`person.head.x` is in the raw camera frame, NOT the screen-rotated/mirrored space. If you want the landmark to align with what the user sees on the (mirrored, rotated) `<video>` preview, use `lmToCanvas` from [`video.js`](./video.js):

```js
import { lmToCanvas } from '../video.js';
const [x, y] = lmToCanvas(person.head.x, person.head.y, W, H);
```

If you're using the landmark just as a positional input (not visually overlaying it on the user), the raw `(x, y)` is fine — apply your own mirror as needed.

---

## ParamSpec

Three types only. Keep the schema small — 4–8 params is the sweet spot.

```js
// range  — slider
{ id: 'thickness', label: 'thickness', type: 'range',
  min: 0, max: 4, step: 0.05, default: 1.0 }

// toggle — on/off button
{ id: 'audioBindBass', label: 'bass→pulse', type: 'toggle',
  default: true }

// select — dropdown
{ id: 'palette', label: 'palette', type: 'select',
  options: ['violet', 'cyan', 'magenta', 'amber'], default: 'violet' }
```

Param `id`s become localStorage keys *and* the public Strudel hook surface (`qualia.setParam(fxId, paramId, value)`). Choose them like you would a small public API — clear, stable, lowercase camelCase.

Read params via `field.params.thickness` inside `update`. Don't cache them across frames; the harness mutates them in place when sliders move or Strudel sets values.

---

## Presets

```js
presets: {
  default: { thickness: 1.0, palette: 'violet' },   // REQUIRED
  drift:   { thickness: 0.6, palette: 'cyan' },
  punchy:  { thickness: 1.8 },                      // partial OK; missing keys keep default
}
```

`default` is required. The Reset button calls `applyFxPreset('default')`. Auto-cycle's chapter style returns to `default` when starting a fresh chapter. `default` doubles as the canonical "this is what the fx looks like out of the box."

User-saved presets (the live-set workflow) are a separate localStorage namespace — your fx doesn't need to handle them.

---

## What you DON'T render

The overlay composites these on top of every fx. Don't render them in your fx:

- **Pose skeleton** (bones + joints + halo)
- **Sparks** (beat-driven, joint-emitted particles)
- **Aura** (centroid halo, bass-driven)
- **Ripples** (beat-driven concentric rings)
- **ASCII post-process**

If you want pose-driven *content* in your fx (e.g., singularity_lens uses head as the lensing centre), read `field.pose.people` directly — the overlay's rendering is independent of any fx using pose data internally.

---

## Helpers

### WebGL2 (`./webgl.js`)

```js
import {
  compileProgram,        // (gl, vertSrc, fragSrc) → program
  makeFullscreenTri,     // (gl) → vao for the fullscreen-triangle trick
  FULLSCREEN_VERT,       // standard vert shader src using gl_VertexID
  makeUniformGetter,     // (gl, prog) → name → location, with caching
  uploadAudioUniforms,   // (gl, U, audio) — uploads uBands/uBeat/uHighs/uRms
} from '../webgl.js';
```

The fullscreen-triangle pattern is the right starting point for fragment-shader fx — see [`fx/singularity-lens.js`](./fx/singularity-lens.js).

`uploadAudioUniforms` uploads four standard uniforms (`uBands` vec4, `uBeat` vec2, `uHighs` vec2, `uRms` float). Your shader can declare them and use them for free; add your own custom uniforms on top.

If your shader needs to read pixels back from its own output (rare, but e.g. for a feedback effect), the WebGL2 context is created with `preserveDrawingBuffer: true` so this works.

### Video transforms (`./video.js`)

```js
import { lmToCanvas, getMirror, getRotation } from '../video.js';
```

`lmToCanvas(lmx, lmy, W, H)` applies the user's current camera rotation + mirror to a normalized landmark, returning canvas pixel coords that align with the on-screen `<video>` preview. Use this if your fx draws something *positionally tied to the user's body* (skeleton, hand-particle attractor). Reference: [`overlay.js`](./overlay.js) skeleton render uses this.

### What's already handled by the harness

| Concern | Owner |
|---|---|
| DPR scaling (cap 1.5×) | `core.js` — `resize(w, h, dpr)` is called with backing-buffer pixels already scaled |
| Param UI generation | `ui.js` — built from your `params` schema |
| Param persistence | `presets.js` + `core.js` — saved per-fx in localStorage automatically |
| FX switching / canvas recreation | `core.js` — calls your `dispose()` then a fresh `create()` |
| Audio + pose pipelines | `audio.js`, `pose.js` — populate `field.audio` / `field.pose` |
| Strudel `setParam` hook | `strudel-hydra.js` + `core.js` — you don't wire anything |
| Skeleton / sparks / aura / ripples / ASCII | `overlay.js` — composes ABOVE your render |

---

## Performance budget

- **Target:** 30+ fps at 1080p on integrated GPU. Stretch: 60 fps.
- DPR is capped at 1.5× by core, so a 1920×1080 viewport gets a 2880×1620 backing buffer max.
- `canvas.width` / `canvas.height` in `resize()` are the *backing-buffer* dimensions — already DPR-scaled. Use them directly for `gl.viewport(0,0,W,H)` and Canvas2D draw coords.

### Allocation discipline

```js
// BAD — allocates Float32Array every frame
function update(field) {
  const positions = new Float32Array(N);     // ← garbage
  ...
}

// GOOD — pre-allocate in create(), reuse forever
async create(canvas, opts) {
  const positions = new Float32Array(N);     // allocated once
  function update(field) { /* fill positions */ }
  function render()      { /* read positions */ }
  function dispose()     { /* GC handles it */ }
  return { resize, update, render, dispose };
}
```

Reuse buffers. Reuse imageData backing arrays. Reuse Path2D objects when possible. The hot path (`update` + `render`) should allocate **zero** per-frame.

### Render-update split

`update(field)` advances state. `render()` draws. The split lets `core.js` skip render under certain pause states without breaking simulation. But more importantly: it means render() should not read `field` directly — instead, stash whatever `render()` needs into closure-scope scratch variables during `update`. Reference pattern in [`fx/chladni.js`](./fx/chladni.js):

```js
let scratch = { audioOn: false, bass: 0, /* ... */ };

function update(field) {
  scratch.audioOn = !!field.audio.spectrum;
  scratch.bass    = field.audio.bands.bass;
  // advance simulation using field
}
function render() {
  // draw using scratch — never read field here
}
```

### Disposal

WebGL2 fx must release GPU resources:
```js
dispose() {
  gl.deleteProgram(prog);
  gl.deleteVertexArray(vao);
  gl.deleteBuffer(buf);   // any buffers you allocated
  gl.deleteTexture(tex);  // any textures
}
```

Canvas2D fx with only typed arrays can leave `dispose()` empty — GC handles it.

---

## Layering (z-index)

Your fx canvas sits at z:2. Hydra is at z:1 underneath; overlay is at z:3 above; the Strudel scope is at z:5; video preview at z:10; topbar at z:20. The viz canvas's CSS uses `mix-blend-mode: screen` so its dark fills become effectively transparent over Hydra. Keep your background near `#05050d` (the page bg color) so the blend reads cleanly.

---

## The brief, when commissioning a new fx

This is the prompt structure to hand to an agent. Fill in the bracketed parts.

```
Build a qualia fx.

Concept: <2-4 sentences — the visual idea + mood + references>
File: src/lib/qualia/fx/<kebab-name>.js
Display name: <Title Case>
Render path: <canvas2d | webgl2>

Audio bindings:
  - bass        → <what>
  - mids        → <what>
  - highs       → <what>
  - beat.pulse  → <what>
  - highs.pulse → <what>
  - <other: total, rms, spectrum[], waveform[]>

Pose bindings (optional):
  - <joint> → <effect>
  Use lmToCanvas() from ../video.js if you need screen-aligned coords.

Params (4-8):
  - <id> (range|toggle|select) <min..max step | options> default <v> — <label>
  ...

Presets:
  - default: { ... }   (required)
  - <name>:  { ... }
  ...

Read src/lib/qualia/README.md before writing code. Reference fx for style:
  - fx/chladni.js          (canvas2d, particles + audio)
  - fx/neural-field.js     (canvas2d, graph + 3D drift + comet pulses)
  - fx/singularity-lens.js (webgl2, fullscreen fragment shader)

Verify:
  - npm run build is clean
  - boots in /lab/qualia
  - swaps cleanly to/from chladni and singularity_lens 5x without errors
  - params persist across reload
  - default audio bindings visibly track a kick beat without sliders
  - 30+ fps at 1080p
```

---

## Verification checklist

Before declaring an fx done:

- [ ] `npm run build` passes
- [ ] fx appears in the dropdown and selecting it boots without console errors
- [ ] All params have working sliders/toggles/selects with sensible labels
- [ ] `default` preset matches the visual you want as the canonical look
- [ ] Reset button restores `default`
- [ ] Reloading the page restores the fx as last-active and its tweaked params
- [ ] Switching to and from this fx 5× shows no JS errors and no canvas leaks (DevTools memory snapshot stable)
- [ ] With audio off, the fx still looks alive (idle state has motion)
- [ ] With audio on (mic or Strudel), bass / beat / highs are visibly distinguishable
- [ ] Pose bindings (if any) feel responsive and don't snap when a person briefly leaves frame
- [ ] 30+ fps at 1080p on the dev machine
- [ ] `dispose()` releases GL programs/buffers (WebGL2 fx)

---

## Common pitfalls

- **Reading `field` in `render()`** — split into update/render and stash into scratch.
- **Allocating in the hot path** — pre-allocate in `create()`, reuse forever.
- **Assuming `audio.spectrum` exists** — it's `null` when audio is off.
- **Drawing a fully opaque background that's not near `#05050d`** — fights the screen blend with Hydra.
- **Magic 33-element pose indices in fx** — use the named joints (`person.head`, `person.wrists.l`). The `raw` array is for fx that genuinely need a non-named landmark (use `LM_WEIGHT` constants in [`overlay.js`](./overlay.js) for indices).
- **Forgetting `dispose()` on WebGL fx** — leaks GPU memory across fx swaps.
- **Reinventing skeleton/sparks/ripples/ASCII** — those are overlay layers; just enable the appropriate toggles.
- **Hard-coding canvas dimensions in `create()`** — they may be 0 before the first `resize()`. Use `canvas.width`/`canvas.height` lazily inside `update`/`render`, or rely on the `resize(w, h, dpr)` callback.

---

## Reference fx, ranked by complexity

1. **`fx/_template.js`** — minimal Canvas2D skeleton. Start here.
2. **`fx/chladni.js`** — Canvas2D, multi-mode select, particle simulation, audio-modulated wave field. Read for: param schema, mode-switching within one fx, `update`/`render` scratch pattern.
3. **`fx/neural-field.js`** — Canvas2D, 3D motion + perspective projection, comet-trail pulses, beat-spike envelope. Read for: 3D drift via per-axis sines, depth-fade, comet rendering, back-to-front sort.
4. **`fx/singularity-lens.js`** — WebGL2, fullscreen fragment shader, audio uniforms, pose-biased centre. Read for: shader compile + fullscreen-tri pattern, uniform getter, pose-driven uniform updates.

If you're writing your first fx, copy `_template.js` and gradually pull in patterns from chladni or neural-field as you need them.
