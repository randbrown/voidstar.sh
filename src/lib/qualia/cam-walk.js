// Cam walk — a virtual camera drifting over the whole scene stack, the
// After-Effects "camera on an animated null" trick: slow pan in a random
// direction + slow zoom + slow rotation, and on each (gated) hard beat the
// walk re-aims — new pan heading, new rotation direction, new zoom
// direction — with an optional quick zoom punch so the hit reads.
//
// This is a TOP-LEVEL effect over any quale, not an fx module: it CSS-
// transforms the scene layers (Hydra canvas, fx canvas, transition freeze-
// frame, overlay) as a group. The camera panel (#video), pose pipeline, and
// all UI above the scene stack are untouched. Because it's a compositor-only
// transform there's zero per-frame pixel cost; the recorder mirrors the same
// matrix into its composite so recordings match the live view (see
// page-init.js recordCompositeUpdate).
//
// Frame-cover guarantee: the applied scale is zoom × rotation-cover × pan
// margin, so the (viewport-sized) layers always cover the viewport — no
// background ever peeks in at the edges regardless of where the walk has
// wandered.
//
// Driven from core.onTick (the reactivity cadence, never gated by the viz
// frame cap) so beat edges aren't missed at low render fps and the drift
// stays smooth even when the fx itself renders slowly. Paused core stops
// ticks, which freezes the walk — intended.

/** Baseline tunables — the walk card's slider defaults. */
export const CAM_WALK_DEFAULTS = {
  drift:   0.35,   // [0,1] pan speed + wander range
  zoom:    0.40,   // [0,1] zoom travel depth (0 = no zoom axis)
  rotate:  0.35,   // [0,1] rotation range + speed (0 = no rotation axis)
  punch:   0.30,   // [0,1] beat zoom-punch strength (0 = off)
  minGapS: 2.0,    // gate: at most one beat re-aim per this many seconds
  maxGapS: 9.0,    // gate: at least one re-aim per this many seconds (idle fallback)
};

// Motion constants. Velocities ease toward per-segment targets with this
// time constant, so a re-aim reads as a camera operator changing the move,
// not a cut.
const EASE_TAU_S     = 1.2;
const PUNCH_TAU_S    = 0.15;   // beat zoom-punch decay (~sharp like beat.pulse)
const ZOOM_DEPTH_MAX = 0.45;   // zoom slider at 1 → travel up to 1.45×
const ROT_RANGE_RAD  = 12 * Math.PI / 180;  // rotate slider at 1 → ±12°
const ROT_SPEED_RAD  = 1.8 * Math.PI / 180; // ...at up to 1.8°/s
const PUNCH_SCALE    = 0.09;   // punch slider at 1 → +0.09 scale kick

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/**
 * @param {Object}   opts
 * @param {() => (HTMLElement|null)[]} opts.getLayers
 *   The scene elements to transform, looked up fresh each tick (the fx
 *   canvas is recreated on every quale switch, and the Hydra / transition
 *   canvases are created lazily). Null entries are skipped; elements that
 *   drop out of the list get their transform cleared.
 * @param {() => [number, number]} [opts.getStageSize]
 *   Stage pixel size (only the aspect ratio is used, for rotation cover).
 *   Defaults to the window size.
 */
export function createCamWalk({ getLayers, getStageSize } = {}) {
  const cfg = { ...CAM_WALK_DEFAULTS };
  let enabled = false;

  // Camera state. Pan is in fractions of the stage box (mapped to CSS
  // translate %, so no pixel-size reads are needed); zoom01 is the position
  // along the configured zoom travel.
  let px = 0, py = 0, rot = 0, zoom01 = 0.35;
  // Current velocities + the per-segment targets they ease toward.
  let vx = 0, vy = 0, vr = 0, vz = 0;
  let tvx = 0, tvy = 0, tvr = 0, tvz = 0;

  let punchEnv = 0;
  let lastRetargetMs = 0;
  let prevBeatActive = false;
  /** Elements currently carrying our transform (for cleanup on change). */
  let applied = new Set();

  // Per-config speed/range derivations, kept as functions so live slider
  // moves take effect immediately.
  const maxPan   = () => 0.03 + 0.09 * cfg.drift;
  const panSpeed = () => 0.006 + 0.030 * cfg.drift;          // frac/s
  const maxRot   = () => ROT_RANGE_RAD * cfg.rotate;
  const rotSpeed = () => ROT_SPEED_RAD * cfg.rotate;
  const zoomSpeed = () => 0.03 + 0.09 * cfg.zoom;            // zoom01/s

  const jitter = () => 0.6 + Math.random() * 0.8;            // ±: 0.6..1.4×

  /** Pick a fresh walk segment: new pan heading, rotation + zoom direction. */
  function retarget(nowMs, onBeat) {
    const ang = Math.random() * Math.PI * 2;
    const sp  = panSpeed() * jitter();
    tvx = Math.cos(ang) * sp;
    tvy = Math.sin(ang) * sp;
    tvr = (Math.random() < 0.5 ? -1 : 1) * rotSpeed() * jitter();
    // Zoom heads toward the far end of its travel so it never parks.
    tvz = (zoom01 > 0.5 ? -1 : 1) * zoomSpeed() * jitter();
    if (onBeat) punchEnv = 1;
    lastRetargetMs = nowMs;
  }

  /** Reset the camera to identity and clear transforms off every layer. */
  function reset() {
    px = 0; py = 0; rot = 0; zoom01 = 0.35;
    vx = vy = vr = vz = 0;
    tvx = tvy = tvr = tvz = 0;
    punchEnv = 0;
    prevBeatActive = false;
    for (const el of applied) { try { el.style.transform = ''; } catch {} }
    applied = new Set();
  }

  function computeTransform() {
    const [w, h] = getStageSize?.() || [window.innerWidth, window.innerHeight];
    const asp = Math.max(0.1, w / Math.max(1, h));
    const z = 1 + zoom01 * ZOOM_DEPTH_MAX * cfg.zoom
                + punchEnv * PUNCH_SCALE * cfg.punch;
    // Cover scale: a rotated stage-sized rect needs this much extra to still
    // cover the stage; the pan margin covers the translation on top of it.
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    const sRot = Math.max((asp * c + s) / asp, asp * s + c);
    const pad  = 1 + 2 * Math.max(Math.abs(px), Math.abs(py));
    return { x: px, y: py, rot, scale: z * sRot * pad };
  }

  function applyToLayers(t) {
    const css = t
      ? `translate(${(t.x * 100).toFixed(3)}%, ${(t.y * 100).toFixed(3)}%) ` +
        `rotate(${t.rot.toFixed(5)}rad) scale(${t.scale.toFixed(4)})`
      : '';
    const next = new Set();
    for (const el of (getLayers?.() || [])) {
      if (!el) continue;
      next.add(el);
      if (el.style.transform !== css) el.style.transform = css;
    }
    // Clear anything we transformed before that's no longer in the list
    // (e.g. the fx canvas torn down by a quale switch — usually gone from
    // the DOM already, but clearing is free and keeps re-adds clean).
    for (const el of applied) {
      if (!next.has(el)) { try { el.style.transform = ''; } catch {} }
    }
    applied = next;
  }

  /**
   * Advance the walk one reactivity tick. Reads field.audio.beat for the
   * re-aim trigger; field.reactDt for wall-clock-correct motion.
   */
  function tick(field) {
    if (!enabled) return;
    const now = performance.now();
    const dt = Math.min(field?.reactDt ?? 0.016, 0.05);

    // Beat-gated re-aim: a rising beat edge re-aims at most once per
    // minGapS; with no qualifying beat (or no audio at all) the maxGapS
    // fallback keeps the walk wandering.
    const beatActive = !!field?.audio?.beat?.active;
    const rising = beatActive && !prevBeatActive;
    prevBeatActive = beatActive;
    const minMs = cfg.minGapS * 1000;
    const maxMs = Math.max(cfg.maxGapS, cfg.minGapS) * 1000;
    if (rising && now - lastRetargetMs >= minMs) retarget(now, true);
    else if (now - lastRetargetMs >= maxMs)      retarget(now, false);

    // Ease velocities toward the segment targets, then integrate.
    const k = 1 - Math.exp(-dt / EASE_TAU_S);
    vx += (tvx - vx) * k;
    vy += (tvy - vy) * k;
    vr += (tvr - vr) * k;
    vz += (tvz - vz) * k;
    px += vx * dt;
    py += vy * dt;
    rot += vr * dt;
    zoom01 += vz * dt;

    // Soft boundary steering: past a bound, aim the segment target back
    // inward (the ease turns it around smoothly); hard-clamp a little past
    // the bound so a long segment can't run away while turning.
    const mp = maxPan(), mr = maxRot();
    if (px >  mp && tvx > 0) tvx = -Math.abs(tvx);
    if (px < -mp && tvx < 0) tvx =  Math.abs(tvx);
    if (py >  mp && tvy > 0) tvy = -Math.abs(tvy);
    if (py < -mp && tvy < 0) tvy =  Math.abs(tvy);
    if (rot >  mr && tvr > 0) tvr = -Math.abs(tvr);
    if (rot < -mr && tvr < 0) tvr =  Math.abs(tvr);
    if (zoom01 >= 1 && tvz > 0) tvz = -Math.abs(tvz);
    if (zoom01 <= 0 && tvz < 0) tvz =  Math.abs(tvz);
    px  = Math.max(-mp * 1.25, Math.min(mp * 1.25, px));
    py  = Math.max(-mp * 1.25, Math.min(mp * 1.25, py));
    rot = Math.max(-mr * 1.25, Math.min(mr * 1.25, rot));
    // Hard floor at 0: zoom01 below the track start would push the base
    // scale under 1×, which the cover math doesn't compensate — edges would
    // peek in when rotation + pan happen to sit near zero.
    zoom01 = Math.max(0, Math.min(1, zoom01));

    punchEnv *= Math.exp(-dt / PUNCH_TAU_S);

    applyToLayers(computeTransform());
  }

  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    if (enabled) {
      // Start walking immediately — don't wait maxGapS for the first segment.
      retarget(performance.now(), false);
    } else {
      reset();
    }
  }

  function setConfig(patch) {
    if (!patch || typeof patch !== 'object') return;
    if ('drift'  in patch) cfg.drift  = clamp01(patch.drift);
    if ('zoom'   in patch) cfg.zoom   = clamp01(patch.zoom);
    if ('rotate' in patch) cfg.rotate = clamp01(patch.rotate);
    if ('punch'  in patch) cfg.punch  = clamp01(patch.punch);
    if ('minGapS' in patch) cfg.minGapS = Math.max(0.5, Math.min(30, Number(patch.minGapS) || CAM_WALK_DEFAULTS.minGapS));
    if ('maxGapS' in patch) cfg.maxGapS = Math.max(1,   Math.min(60, Number(patch.maxGapS) || CAM_WALK_DEFAULTS.maxGapS));
  }

  return {
    tick,
    setEnabled,
    isEnabled: () => enabled,
    setConfig,
    getConfig: () => ({ ...cfg }),
    /** Current transform for the recorder composite; null when off. */
    getTransform: () => (enabled ? computeTransform() : null),
  };
}
