// QualiaCore — host class. Owns:
//   - the QualiaField (per-frame audio + pose + params + dt + time)
//   - the rAF loop (dt-clamped, FPS readout)
//   - the active fx instance (one at a time; switch tears down + rebuilds)
//   - the viz canvas + DPR cap (min(devicePixelRatio, 1.5) by default)
//
// The page wires QualiaCore to the audio pipeline, pose pipeline, UI builder,
// presets store, and Strudel/Hydra; the core itself doesn't know about any
// of those — they're handed in via the constructor and the caller updates
// the field's audio/pose objects via the returned references.
//
// Canvas ownership note: a single <canvas> can only ever bind one context
// type (2D or WebGL2). To support fx that pick different context types,
// QualiaCore creates a fresh <canvas> inside a host <div> on every fx
// switch when the type changes. The host div carries the CSS (position,
// blend mode, z-index) so the inner canvas inherits the slot.

import { makeField } from './field.js';
import { buildParamPanel } from './ui.js';
import { loadFxParams, saveFxParams, loadFxModWeights, saveFxModWeights } from './presets.js';
import { computeChannels, resolveParams, makeChannelSnapshot, modWeightKey } from './modulation.js';
// Three.js — used by 'three' contextType quales. Static + named imports:
// the Three quale modules also static-import Three, so a dynamic import
// here would be no-op (Vite warns and merges chunks). All lab visualizers
// ship together in one page bundle either way. Named imports keep
// tree-shaking honest.
import { WebGLRenderer, LinearSRGBColorSpace } from 'three';

const DEFAULT_DPR_CAP = 1.5;
// Tolerance subtracted from the viz frame-cap interval so a cap set to the
// panel's own refresh (e.g. 60 on a 60Hz display) isn't silently halved when
// rAF delivers a frame a hair early. Scaled down to the actual tick length in
// frame() so it stays a hair on a 60Hz panel but can't sneak a whole extra
// render through on a 120/144Hz one (which would overshoot the cap). This is
// the ceiling — never large enough to double-render within one tick.
const FRAME_SLOP_MS = 3;

// Default reactivity cadence (Hz). Audio sampling (audio.tick) + the audio-
// reactive tick listeners are gated to this rate, decoupled from the display
// refresh, so a 120/144Hz panel doesn't run that (viz-cap-exempt) work 2.4×
// more per second than a 60Hz one — the extra main-thread load is what starves
// Strudel's cyclist into `skip query: too late`. Pinning it also keeps the
// frame-count-tuned beat EMAs behaving the same regardless of monitor.
const REACT_FPS = 60;

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.host                 The element that contains the viz canvas.
 *                                                Core will (re)create a <canvas> inside it.
 * @param {ReturnType<import('./registry.js').createMesh>} opts.mesh
 * @param {ReturnType<import('./audio.js').createAudio>} opts.audio
 * @param {ReturnType<import('./pose.js').createPose>}  opts.pose
 * @param {HTMLElement} opts.paramsContainer       Where the active fx's UI mounts.
 * @param {(fxId: string|null) => void} [opts.onFxChange]
 */
export function createCore({ host, mesh, audio, pose, paramsContainer, onFxChange }) {
  const field = makeField();
  // Wire the live audio/pose frames into the field. They're objects, so the
  // references stay valid even as their internals are mutated each tick.
  field.audio = audio.frame;
  field.pose  = pose.frame;
  // Channel snapshot — refreshed each frame; UI + frame listeners can read.
  field.channels = makeChannelSnapshot();
  // Base (UI-set) params, distinct from `field.params` which the engine
  // re-resolves each frame as base + active modulators.
  let baseParams = {};
  // Per-modulator user weights, keyed by `${paramId}.${modIdx}`. Multiplies
  // the spec's declared amount. Default 1 (= use spec amount as-is).
  let modWeights = {};

  // ── Global "react smooth" de-jitter ──────────────────────────────────────
  // A dt-aware one-pole low-pass on the sustained reactive signals, so every
  // quale inherits it without per-fx code. amount 0 ⇒ passthrough (legacy).
  // Two insertion points, because quales read reactivity two ways:
  //   1. field.audio.bands.* — smoothed IN PLACE after audio.tick (most quales
  //      read these directly in update(), bypassing the channel system). This
  //      also feeds computeChannels, so the audio.* channels come out smoothed.
  //   2. pose.* channels — smoothed after computeChannels (pose has no
  //      equivalent "bands" object; the channels are the shared surface).
  // Left sharp on purpose: transient pulses (beat/snare/hat — both the
  // field.audio.*.pulse values and the *Pulse channels) and the time LFOs, so
  // hits stay punchy and LFOs don't phase-lag. Beat DETECTION is unaffected —
  // audio.js runs it off raw pre-EMA values, not field.audio.bands.
  let reactSmoothAmt = 0;                       // [0,1] user amount
  let reactSmoothTau = 0;                       // derived time constant (s)
  const smoothedChannels = makeChannelSnapshot();
  let smoothPrimed = false;
  const smBands = { bass: 0, mids: 0, highs: 0, total: 0, rms: 0 };
  let smBandsPrimed = false;
  /** Low-pass field.audio.bands (+ rms) in place. Pulses are left untouched. */
  function smoothAudioBands(a, dt) {
    const b = a.bands;
    if (!smBandsPrimed) {
      smBands.bass = b.bass; smBands.mids = b.mids; smBands.highs = b.highs;
      smBands.total = b.total; smBands.rms = a.rms;
      smBandsPrimed = true;
      return;
    }
    const k = 1 - Math.exp(-dt / reactSmoothTau);
    smBands.bass  += (b.bass  - smBands.bass)  * k; b.bass  = smBands.bass;
    smBands.mids  += (b.mids  - smBands.mids)  * k; b.mids  = smBands.mids;
    smBands.highs += (b.highs - smBands.highs) * k; b.highs = smBands.highs;
    smBands.total += (b.total - smBands.total) * k; b.total = smBands.total;
    smBands.rms   += (a.rms   - smBands.rms)   * k; a.rms   = smBands.rms;
  }
  /** Smooth the pose.* channels only — audio.* is already done at the band
   *  source above; pulses + time LFOs stay sharp. */
  function smoothChannels(ch, dt) {
    if (!smoothPrimed) {
      for (const id in ch) smoothedChannels[id] = ch[id];
      smoothPrimed = true;
      return;
    }
    const k = 1 - Math.exp(-dt / reactSmoothTau);
    for (const id in ch) {
      if (id.charCodeAt(0) !== 112 /* 'p' → pose.* */) { smoothedChannels[id] = ch[id]; continue; }
      const s = smoothedChannels[id] + (ch[id] - smoothedChannels[id]) * k;
      smoothedChannels[id] = s;
      ch[id] = s;
    }
  }

  let dprCap   = DEFAULT_DPR_CAP;
  let zen      = false;
  let paused   = false;
  let startMs  = performance.now();
  let lastMs   = startMs;
  let frames      = 0;     // renders counted in the current fps window
  let fpsWindowMs = startMs; // wall-clock start of the current fps window
  let lastFps     = 0;

  // Viz frame-rate cap. maxFps 0 = uncapped (render every rAF tick — the
  // default + legacy behavior). When set, the heavy fx render + visual frame
  // listeners gate on elapsed wall time. Audio sampling + reactivity gate
  // separately on reactFrameMs (see below), not on this. Doubles as a Windows
  // perf lever and a low-fps aesthetic knob (down to 1fps strobe).
  let maxFps       = 0;
  let minFrameMs   = 0;
  let lastRenderMs = startMs;

  // Reactivity cadence cap — audio.tick + the audio-reactive tick listeners run
  // at most this often, independent of both the viz cap and the display refresh
  // (see REACT_FPS). lastReactMs tracks the last reactivity step; it's reset in
  // start() to the first rAF timestamp. 0 = uncapped (every rAF tick).
  let reactFrameMs = 1000 / REACT_FPS;
  let lastReactMs  = startMs;

  // Smoothed rAF interval (ms). Tracked so the frame-cap slop can scale to the
  // real tick length — a fixed 3ms is harmless on a 16.7ms (60Hz) tick but a
  // big enough fraction of a 6.9ms (144Hz) tick to overshoot the cap.
  let tickMsEma = 1000 / 60;

  // Auxiliary viz cap — a secondary frame cap that LAYERS on top of the user's
  // maxFps via max(interval), so it never overwrites their render-cap setting
  // (the slider keeps working) and the stricter of the two wins. The page
  // drives this to free main-thread budget while the Strudel/sequencer editor
  // panels are open, so the main-thread cyclist stops dropping notes while the
  // user is live-coding (see setAuxFps()).
  let auxFrameMs = 0;        // 0 = no aux cap active

  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  /** @type {'canvas2d'|'webgl2'|'three'|null} */
  let canvasType = null;
  /** Single Three.js renderer reused across all 'three' quales — Three's
   *  WebGLRenderer owns the canvas's GL context exclusively, and disposing
   *  one then constructing another on the same canvas leaves the second in
   *  a lost-context state. So core owns the renderer; quales borrow it.
   *  @type {import('three').WebGLRenderer|null} */
  let threeRenderer = null;

  /** @type {import('./types.js').QFXModule|null} */
  let activeMod  = null;
  /** @type {import('./types.js').QFXInstance|null} */
  let activeInst = null;
  /** @type {ReturnType<typeof buildParamPanel>|null} */
  let activePanel = null;

  /** Listeners notified on FPS update so the page can paint a HUD. */
  const fpsListeners = new Set();
  /** Listeners notified after each canvas (re)creation. */
  const canvasListeners = new Set();
  /** Listeners notified every frame AFTER fx render — used by the overlay
   *  layer (skeleton, sparks, ASCII post) so it composites on top. Gated by
   *  the viz frame cap (these are visual). */
  const frameListeners = new Set();
  /** Listeners notified every rAF tick (NOT gated by the viz frame cap),
   *  right after audio.tick(). Audio-reactive bookkeeping (beat counting,
   *  hard-kick detection, glitch triggers) lives here so it never misses a
   *  transient edge when the visual render is throttled to a low fps. */
  const tickListeners = new Set();

  function ensureCanvas(forType) {
    if (canvas && canvasType === forType) return canvas;
    if (canvas) {
      // Tear down the Three renderer BEFORE removing the canvas so the GL
      // context dies cleanly. forceContextLoss + dispose silences Three's
      // "context lost during teardown" warnings.
      if (threeRenderer) {
        try { threeRenderer.forceContextLoss(); } catch {}
        try { threeRenderer.dispose(); } catch {}
        threeRenderer = null;
      }
      canvas.remove();
    }
    const c = document.createElement('canvas');
    c.id = 'qualia-canvas';
    host.appendChild(c);
    canvas = c;
    canvasType = forType;
    canvasListeners.forEach(fn => { try { fn(c, forType); } catch {} });
    return c;
  }

  function getCssSize() {
    if (!canvas) return [window.innerWidth, window.innerHeight];
    const r = canvas.getBoundingClientRect();
    return [r.width || window.innerWidth, r.height || window.innerHeight];
  }

  function applyDpr() {
    if (!canvas) return;
    const [w, h] = getCssSize();
    // Quale-declared maxDpr (heavy raymarchers etc) clamps further on top of
    // the global cap. Lower wins.
    const fxCap = activeMod?.maxDpr;
    const effectiveCap = (typeof fxCap === 'number') ? Math.min(dprCap, fxCap) : dprCap;
    const dpr = Math.min(window.devicePixelRatio || 1, effectiveCap);
    canvas.width  = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    if (activeInst) {
      try { activeInst.resize(canvas.width, canvas.height, dpr); } catch (e) { console.warn('[qualia] resize failed:', e); }
    }
  }
  // ResizeObserver on the host keeps the backing buffer in sync with the
  // layout. Watching the host instead of the canvas means re-creating the
  // canvas doesn't lose the observation.
  const ro = new ResizeObserver(applyDpr);
  ro.observe(host);
  window.addEventListener('orientationchange', applyDpr);

  async function setActive(fxId) {
    const mod = mesh.get(fxId);
    if (!mod) throw new Error(`unknown fx: ${fxId}`);

    // Tear down any existing instance + UI.
    if (activeInst) {
      try { activeInst.dispose(); } catch (e) { console.warn('[qualia] dispose failed:', e); }
      activeInst = null;
    }
    if (activePanel) { activePanel.destroy(); activePanel = null; }

    // (Re)create canvas of the right type.
    const c = ensureCanvas(mod.contextType);
    // Passed to every fx's create() so quales that want a custom panel
    // (e.g. the video qfx's playlist editor) can mount DOM alongside the
    // auto-generated param panel without reaching into the page globals.
    // `applyPreset` is the same path as the page's reset button — quales
    // that expose a "preset" select can drive named-preset application by
    // calling it from their update() loop when the chosen name changes.
    const fxOptsBase = {
      paramsContainer,
      applyPreset: (name) => applyFxPreset(name),
    };
    let opts;
    if (mod.contextType === 'webgl2') {
      // preserveDrawingBuffer:true so the overlay's ASCII post-process can
      // drawImage() from this canvas later in the same frame.
      const gl = c.getContext('webgl2', {
        alpha: true, premultipliedAlpha: false, antialias: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error('webgl2 not available');
      opts = { ...fxOptsBase, gl };
    } else if (mod.contextType === 'three') {
      // Three.js owns the canvas GL context exclusively. We build the
      // renderer once per canvas and hand the same instance to every
      // 'three' quale that activates while this canvas is alive — switching
      // between two 'three' quales keeps the renderer + GL context, only
      // the scene graph turns over. Quales' dispose() must NOT touch the
      // renderer; ensureCanvas owns its lifecycle.
      if (!threeRenderer) {
        threeRenderer = new WebGLRenderer({
          canvas: c,
          alpha: true,
          antialias: false,
          // Overlay (ASCII post / drawImage feedback) reads from the canvas
          // mid-frame — must keep the framebuffer around.
          preserveDrawingBuffer: true,
          // Match the existing webgl2 quales so mix-blend-mode: screen behaves
          // consistently across all WebGL backends.
          premultipliedAlpha: false,
        });
        // Core has already DPR-scaled canvas.width/height; tell Three to leave
        // pixel ratio at 1 so it doesn't multiply on top of that.
        threeRenderer.setPixelRatio(1);
        // Opaque black clear so screen-blend with Hydra below behaves like the
        // shader quales (fullscreen-tri ones fill the frame; transparent
        // backgrounds would let Hydra dominate the gaps for point clouds).
        threeRenderer.setClearColor(0x000000, 1);
        // Avoid double gamma vs Hydra under mix-blend-mode: screen. The
        // existing webgl2 quales write linear-sRGB without tonemap.
        threeRenderer.outputColorSpace = LinearSRGBColorSpace;
      }
      opts = { ...fxOptsBase, renderer: threeRenderer };
    } else {
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('canvas2d not available');
      opts = { ...fxOptsBase, ctx };
    }

    // Init mod weights from the schema (default 1 each), overlay any
    // persisted user overrides. Built BEFORE the panel so initial slider
    // positions are correct.
    modWeights = {};
    for (const spec of mod.params) {
      if (!Array.isArray(spec.modulators)) continue;
      for (let i = 0; i < spec.modulators.length; i++) {
        modWeights[modWeightKey(spec.id, i)] = 1;
      }
    }
    const persistedMods = loadFxModWeights(mod.id);
    if (persistedMods) {
      for (const k in persistedMods) {
        if (k in modWeights) modWeights[k] = persistedMods[k];
      }
    }

    // Build UI from schema BEFORE create() so initial params land in field.params.
    activePanel = buildParamPanel({
      container: paramsContainer,
      params: mod.params,
      getChannels: () => field.channels,
      getModWeight: (paramId, modIdx) => modWeights[modWeightKey(paramId, modIdx)] ?? 1,
      onModWeightChange: (paramId, modIdx, value) => {
        modWeights[modWeightKey(paramId, modIdx)] = value;
        saveFxModWeights(mod.id, modWeights);
      },
      onChange: (id, value) => {
        baseParams[id] = value;
        field.params[id] = value;
        saveFxParams(mod.id, activePanel.values());
      },
    });
    baseParams = activePanel.values();
    field.params = { ...baseParams };

    // Apply persisted params (overrides defaults).
    const persisted = loadFxParams(mod.id);
    if (persisted) {
      activePanel.applyValues(persisted);
      baseParams = activePanel.values();
      field.params = { ...baseParams };
    }

    // Create the fx instance. May be async (e.g. shader compile).
    const inst = await mod.create(c, opts);
    activeMod  = mod;
    activeInst = inst;
    applyDpr(); // first sizing pass
    onFxChange?.(mod.id);
  }

  /** Programmatic param set — used by Strudel live-coding hook. */
  function setParam(fxId, paramId, value) {
    if (!activeMod || activeMod.id !== fxId || !activePanel) return false;
    activePanel.setValue(paramId, value);
    baseParams[paramId] = value;
    field.params[paramId] = value;
    saveFxParams(fxId, activePanel.values());
    return true;
  }

  function applyFxPreset(presetName) {
    if (!activeMod || !activePanel) return false;
    const p = activeMod.presets?.[presetName];
    if (!p) return false;
    // A preset may carry per-modulator reaction weights under a reserved
    // `modWeights` key (flat dict keyed `${paramId}.${modIdx}`). Pull it aside
    // so it isn't fed to the panel as a bogus param value.
    const presetMods = (p.modWeights && typeof p.modWeights === 'object') ? p.modWeights : null;
    let paramValues = p;
    if (presetMods) { const { modWeights: _omit, ...rest } = p; paramValues = rest; }
    activePanel.applyValues(paramValues);
    baseParams = activePanel.values();
    field.params = { ...baseParams };
    saveFxParams(activeMod.id, activePanel.values());
    // Modulator weights define each param's reaction strength. Reset every
    // weight to the spec baseline (1), then overlay any the preset specifies —
    // so a preset fully determines per-param reactivity. The global reactivity
    // / poseReactivity sliders are NOT preset-set; they multiply on top, so a
    // live "tamp" persists across preset / auto-phase changes.
    for (const k in modWeights) {
      const w = (presetMods && k in presetMods) ? presetMods[k] : 1;
      modWeights[k] = w;
      const dot = k.lastIndexOf('.');
      activePanel.setModWeight(k.slice(0, dot), Number(k.slice(dot + 1)), w);
    }
    saveFxModWeights(activeMod.id, modWeights);
    return true;
  }

  // ── Scene transitions (dissolve / wipe) ──────────────────────────────────
  // A freeze-frame of the OUTGOING scene, layered just above the viz canvas
  // and faded out while the incoming scene renders underneath. One primitive
  // serves every scene change — auto-phase steps, auto-cycle swaps, manual
  // switches, swipes, qualem recalls — so transitions look uniform regardless
  // of what triggered them. The snapshot is copied off the live viz canvas
  // (works for canvas2d / webgl2 / three — the GL contexts run with
  // preserveDrawingBuffer), so it survives the canvas teardown an fx switch
  // performs and keeps showing the old look until the new one has rendered.
  /** @type {HTMLCanvasElement|null} */
  let transCanvas = null;
  let transCtx    = null;
  let transActive = false;
  let transStartMs = 0;
  let transDurMs   = 0;
  let transStyle   = 'dissolve';  // 'dissolve' | 'wipe'
  let transAlpha   = 0;           // current element opacity (for the recorder composite)

  function ensureTransCanvas() {
    if (transCanvas) return transCanvas;
    const t = document.createElement('canvas');
    t.id = 'qualia-transition';
    // Inherits the `#qualia-host > canvas` slot (fixed full-viewport, screen
    // blend). Override only what the slot doesn't: sit one above the viz
    // canvas (z:2) so a freshly-created incoming canvas paints UNDER the
    // freeze-frame, and never eat pointer input during the fade.
    t.style.zIndex = '3';
    t.style.pointerEvents = 'none';
    t.style.opacity = '0';
    t.style.display = 'none';
    host.appendChild(t);
    transCanvas = t;
    transCtx = t.getContext('2d');
    return t;
  }

  /**
   * Freeze the current scene and start a transition into whatever renders
   * next. Call BEFORE the state change (setActive / phase step) so the
   * snapshot captures the OUTGOING look. style 'cut' (or durationMs <= 0) is
   * a no-op = instant change. Safe with no active canvas (no-ops).
   * @param {{ style?: 'cut'|'dissolve'|'wipe', durationMs?: number }} [opts]
   */
  function beginTransition({ style = 'dissolve', durationMs = 600 } = {}) {
    if (!canvas || style === 'cut' || !(durationMs > 0)) return;
    const w = canvas.width, h = canvas.height;
    if (w <= 0 || h <= 0) return;
    const t = ensureTransCanvas();
    if (t.width !== w || t.height !== h) { t.width = w; t.height = h; }
    transCtx.clearRect(0, 0, w, h);
    // A lost/tainted source just skips the visual — the scene change still
    // happens, it's only the freeze-frame that's lost.
    try { transCtx.drawImage(canvas, 0, 0); } catch { return; }
    transStyle   = (style === 'wipe') ? 'wipe' : 'dissolve';
    transDurMs   = durationMs;
    transStartMs = performance.now();
    transActive  = true;
    transAlpha   = 1;
    t.style.display = 'block';
    t.style.opacity = '1';
  }

  function tickTransition(now) {
    if (!transActive) return;
    const p = Math.min(1, (now - transStartMs) / transDurMs);
    if (transStyle === 'wipe') {
      // Hold full opacity; erase a growing left-to-right band so the incoming
      // scene is revealed through the moving wipe edge. Clearing the whole
      // 0→x span each tick is cheap and keeps the edge crisp.
      transCtx.clearRect(0, 0, Math.round(p * transCanvas.width), transCanvas.height);
      transAlpha = 1;
    } else {
      // Dissolve — ease-out opacity so the outgoing scene lingers, then drops.
      const a = 1 - p;
      transAlpha = a * a;
      transCanvas.style.opacity = String(transAlpha);
    }
    if (p >= 1) {
      transActive = false;
      transAlpha  = 0;
      transCanvas.style.display = 'none';
      transCanvas.style.opacity = '0';
    }
  }

  // Render loop — single rAF. Audio + reactivity run on their own cadence
  // (reactFrameMs, default 60Hz); the fx render is gated separately by the viz
  // frame cap (maxFps). Both intervals are decoupled from the display refresh.
  // dt is clamped so a long pause + resume (or a low cap) can't fast-forward.
  function frame(now) {
    requestAnimationFrame(frame);
    const dtRaw = (now - lastMs) / 1000;
    const dt = Math.min(dtRaw, 0.05);
    lastMs = now;
    // Smoothed rAF interval — feeds the adaptive frame-cap slop below.
    tickMsEma += (dt * 1000 - tickMsEma) * 0.1;
    // FPS over real wall-clock time: `frames` counts rendered frames (below),
    // divided by the true elapsed window — NOT by accumulated dt, whose 50ms
    // clamp would floor the readout at 20fps and hide any slower (GPU-bound)
    // rate. field.fps mirrors it so fx (e.g. telemetry) can read the same number.
    const fpsWin = now - fpsWindowMs;
    if (fpsWin >= 200) {
      lastFps = Math.round((frames * 1000) / fpsWin);
      field.fps = lastFps;
      fpsListeners.forEach(fn => { try { fn(lastFps, field); } catch {} });
      frames = 0; fpsWindowMs = now;
    }
    // Advance any running scene transition before the pause gate so a freeze
    // frame can't get stuck on screen if a switch lands while paused.
    tickTransition(now);
    if (paused) return;

    field.time = (now - startMs) / 1000;

    // Slop scaled to the real tick length: ~3ms on a 60Hz panel (so a 60 cap
    // still hits 60), but a small fraction of a 144Hz tick (so it can't let a
    // gate fire a whole tick early and overshoot the cap). Shared by the
    // reactivity gate and the viz-cap gate below.
    const slop = Math.min(FRAME_SLOP_MS, tickMsEma * 0.25);

    // Reactivity step — audio sampling + audio-reactive tick listeners. Gated
    // to reactFrameMs (default 60Hz), NOT to the viz cap: beat/onset detection
    // and the hard-kick / glitch edge detectors must keep running when the
    // visual render is throttled low. But running them at full rAF rate would
    // make a 144Hz panel do 2.4× the per-second work of a 60Hz one (ungated by
    // the viz cap, so it starves the Strudel cyclist) and would skew the
    // frame-count-tuned beat EMAs by monitor. rdt is the real time since the
    // last reactivity step (not since the last rAF) so dt-based decays stay
    // wall-clock-correct.
    if (reactFrameMs <= 0 || (now - lastReactMs) >= reactFrameMs - slop) {
      const rdt = Math.min((now - lastReactMs) / 1000, 0.05);
      lastReactMs = now;
      field.reactDt = rdt;
      audio.tick(rdt);
      // De-jitter the bands in place (most quales read field.audio.bands.*
      // directly, not via the channel system) — at the reactivity cadence so
      // the time constant is wall-clock-correct regardless of the viz cap.
      if (reactSmoothTau > 0) smoothAudioBands(field.audio, rdt);
      // pose runs its own detect rAF (separately throttled); nothing to tick here.
      tickListeners.forEach(fn => { try { fn(field); } catch (e) { console.error('[qualia] tick listener error:', e); } });
    }

    // Effective frame cap = the stricter (longer interval) of the user's cap
    // and any auxiliary cap (set while the editor panels are open). 0 = uncapped.
    const gateMs = Math.max(minFrameMs, auxFrameMs);
    // Viz frame-rate cap. gateMs === 0 → render every tick (default,
    // byte-for-byte the legacy path since lastRenderMs then tracks `now`).
    // Otherwise skip rendering until the chosen interval has elapsed since the
    // last *rendered* frame.
    if (gateMs > 0 && (now - lastRenderMs) < gateMs - slop) return;
    // field.dt is the real elapsed time since the last render so motion stays
    // wall-clock-correct at any cap; the clamp guards tab-switch fast-forward
    // and scales with the cap so 1–5fps aesthetic rates still advance at true
    // speed instead of slewing into slow motion. Floor is 0.1s (10fps) so a
    // GPU-bound viz running 12–20fps stays wall-correct instead of slow-mo'ing
    // against the old 0.05s (20fps) clamp. field.renderDt is the SAME interval
    // unclamped — fx that display fps (telemetry) read it for a true reading.
    const renderDt = (now - lastRenderMs) / 1000;
    const maxStep = Math.max(0.1, (gateMs / 1000) * 1.5);
    field.dt = Math.min(renderDt, maxStep);
    field.renderDt = renderDt;
    lastRenderMs = now;
    frames++;

    if (activeInst && activeMod) {
      try {
        // Refresh channels + resolve modulated params for this frame.
        computeChannels(field, field.channels);
        if (reactSmoothTau > 0) smoothChannels(field.channels, field.dt);
        resolveParams(field.params, baseParams, activeMod.params, field.channels, modWeights);
        activeInst.update(field);
        activeInst.render();
      } catch (e) {
        console.error('[qualia] fx error:', e);
      }
    }

    // Visual frame listeners (overlay, recording composite) fire AFTER fx
    // render so they composite on top — gated by the viz cap alongside render.
    frameListeners.forEach(fn => { try { fn(field); } catch (e) { console.error('[qualia] frame listener error:', e); } });
  }

  function start() {
    requestAnimationFrame(now => { startMs = now; lastMs = now; lastRenderMs = now; lastReactMs = now; fpsWindowMs = now; requestAnimationFrame(frame); });
  }

  function setPaused(v) { paused = !!v; }
  function setZen(v)    { zen    = !!v; }
  function isPaused()   { return paused; }
  function isZen()      { return zen; }
  function setDprCap(v) { dprCap = Math.max(0.5, v); applyDpr(); }
  function getDprCap()  { return dprCap; }
  /** Cap the visual frame rate. fps 0 (or falsy) = uncapped. Audio sampling +
   *  reactivity are unaffected — only the fx render + overlay composite
   *  throttle. Windows perf lever; also a low-fps aesthetic (down to 1fps). */
  function setMaxFps(v) {
    maxFps = Math.max(0, v | 0);
    minFrameMs = maxFps > 0 ? 1000 / maxFps : 0;
  }
  function getMaxFps()  { return maxFps; }
  /** Auxiliary viz cap, layered ON TOP of the user's maxFps (the stricter wins)
   *  without touching it. The page drives this to free main-thread budget while
   *  the Strudel/sequencer editor panels are open, so the main-thread cyclist
   *  stops dropping notes during live-coding. fps<=0 clears it. */
  function setAuxFps(fps) {
    auxFrameMs = (fps > 0) ? 1000 / fps : 0;
  }
  /** Cap the reactivity cadence — how often audio.tick + the audio-reactive
   *  tick listeners run, independent of display refresh. Defaults to REACT_FPS
   *  (60). Lower trims main-thread load on high-refresh panels; fps<=0 reverts
   *  to running every rAF tick. */
  function setReactFps(fps) {
    reactFrameMs = (fps > 0) ? 1000 / fps : 0;
  }
  function getReactFps() { return reactFrameMs > 0 ? Math.round(1000 / reactFrameMs) : 0; }
  /** Global reactive de-jitter amount [0,1]. 0 = off (passthrough). Maps,
   *  with a slight ease so the low end stays gentle, to a time constant up to
   *  ~0.6s for the band + pose low-pass (smoothAudioBands / smoothChannels). */
  function setReactSmoothing(v) {
    reactSmoothAmt = Math.max(0, Math.min(1, Number(v) || 0));
    // Quadratic-ish ease: 0.5 → ~0.21s, 1.0 → 0.6s. Gentle to start, clearly
    // heavy at the top so the full sweep reads as a real change.
    reactSmoothTau = reactSmoothAmt * (0.15 + 0.45 * reactSmoothAmt);
    smoothPrimed = false;      // re-seed so toggling on doesn't lerp from stale state
    smBandsPrimed = false;
  }
  function getReactSmoothing() { return reactSmoothAmt; }
  function onFps(fn)    { fpsListeners.add(fn); return () => fpsListeners.delete(fn); }
  function onFrame(fn)  { frameListeners.add(fn); return () => frameListeners.delete(fn); }
  function onTick(fn)   { tickListeners.add(fn);  return () => tickListeners.delete(fn); }
  function onCanvas(fn) {
    canvasListeners.add(fn);
    if (canvas) { try { fn(canvas, canvasType); } catch {} }
    return () => canvasListeners.delete(fn);
  }

  return {
    field,
    start,
    setActive,
    beginTransition,
    // The live freeze-frame canvas while a transition runs (else null), plus
    // its current opacity — the recorder composite layers it over the fx so
    // transitions land in recordings too.
    getTransitionCanvas: () => (transActive ? transCanvas : null),
    getTransitionAlpha:  () => transAlpha,
    activeId: () => activeMod?.id ?? null,
    setParam,
    applyFxPreset,
    setPaused,
    setZen,
    isPaused,
    isZen,
    setDprCap,
    getDprCap,
    // Force a sizing pass against the canvas's current CSS box. The
    // ResizeObserver only watches the host (full-width block), so a layout
    // change that resizes the fixed canvas WITHOUT changing the host —
    // e.g. toggling the split-screen stage — wouldn't otherwise re-sync the
    // backing buffer. Callers invoke this after such a change.
    refreshSize: () => applyDpr(),
    setMaxFps,
    getMaxFps,
    setAuxFps,
    setReactFps,
    getReactFps,
    setReactSmoothing,
    getReactSmoothing,
    onFps,
    onFrame,
    onTick,
    onCanvas,
    getCanvas: () => canvas,
    getActiveContextType: () => canvasType,
    getBaseParams: () => ({ ...baseParams }),
    getChannels: () => field.channels,
  };
}
