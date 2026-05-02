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
import { loadFxParams, saveFxParams } from './presets.js';

const DEFAULT_DPR_CAP = 1.5;

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

  let dprCap   = DEFAULT_DPR_CAP;
  let zen      = false;
  let paused   = false;
  let startMs  = performance.now();
  let lastMs   = startMs;
  let frames   = 0;
  let fpsTimer = 0;
  let lastFps  = 0;

  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  /** @type {'canvas2d'|'webgl2'|null} */
  let canvasType = null;

  /** @type {import('./types.js').QualiaFXModule|null} */
  let activeMod  = null;
  /** @type {import('./types.js').QualiaFXInstance|null} */
  let activeInst = null;
  /** @type {ReturnType<typeof buildParamPanel>|null} */
  let activePanel = null;

  /** Listeners notified on FPS update so the page can paint a HUD. */
  const fpsListeners = new Set();
  /** Listeners notified after each canvas (re)creation. */
  const canvasListeners = new Set();

  function ensureCanvas(forType) {
    if (canvas && canvasType === forType) return canvas;
    if (canvas) canvas.remove();
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
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
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
    let opts;
    if (mod.contextType === 'webgl2') {
      const gl = c.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
      if (!gl) throw new Error('webgl2 not available');
      opts = { gl };
    } else {
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('canvas2d not available');
      opts = { ctx };
    }

    // Build UI from schema BEFORE create() so initial params land in field.params.
    activePanel = buildParamPanel({
      container: paramsContainer,
      params: mod.params,
      onChange: (id, value) => {
        field.params[id] = value;
        saveFxParams(mod.id, activePanel.values());
      },
    });
    field.params = activePanel.values();

    // Apply persisted params (overrides defaults).
    const persisted = loadFxParams(mod.id);
    if (persisted) {
      activePanel.applyValues(persisted);
      field.params = activePanel.values();
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
    field.params[paramId] = value;
    saveFxParams(fxId, activePanel.values());
    return true;
  }

  function applyFxPreset(presetName) {
    if (!activeMod || !activePanel) return false;
    const p = activeMod.presets?.[presetName];
    if (!p) return false;
    activePanel.applyValues(p);
    field.params = activePanel.values();
    saveFxParams(activeMod.id, activePanel.values());
    return true;
  }

  // Render loop — single rAF, dt-clamped to 50ms so a long pause + resume
  // can't fast-forward the fx.
  function frame(now) {
    requestAnimationFrame(frame);
    const dtRaw = (now - lastMs) / 1000;
    const dt = Math.min(dtRaw, 0.05);
    lastMs = now;
    frames++; fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      lastFps = Math.round(frames / fpsTimer);
      fpsListeners.forEach(fn => { try { fn(lastFps, field); } catch {} });
      frames = 0; fpsTimer = 0;
    }
    if (paused) return;

    field.dt   = dt;
    field.time = (now - startMs) / 1000;

    audio.tick(dt);
    // pose runs its own detect rAF; nothing to tick here.

    if (activeInst) {
      try {
        activeInst.update(field);
        activeInst.render();
      } catch (e) {
        console.error('[qualia] fx error:', e);
      }
    }
  }

  function start() {
    requestAnimationFrame(now => { startMs = now; lastMs = now; requestAnimationFrame(frame); });
  }

  function setPaused(v) { paused = !!v; }
  function setZen(v)    { zen    = !!v; }
  function isPaused()   { return paused; }
  function isZen()      { return zen; }
  function setDprCap(v) { dprCap = Math.max(0.5, v); applyDpr(); }
  function onFps(fn)    { fpsListeners.add(fn); return () => fpsListeners.delete(fn); }
  function onCanvas(fn) {
    canvasListeners.add(fn);
    if (canvas) { try { fn(canvas, canvasType); } catch {} }
    return () => canvasListeners.delete(fn);
  }

  return {
    field,
    start,
    setActive,
    activeId: () => activeMod?.id ?? null,
    setParam,
    applyFxPreset,
    setPaused,
    setZen,
    isPaused,
    isZen,
    setDprCap,
    onFps,
    onCanvas,
    getCanvas: () => canvas,
    getActiveContextType: () => canvasType,
  };
}
