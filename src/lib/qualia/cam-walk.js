// Cam walk — a virtual camera drifting over the whole scene stack, the
// After-Effects "camera on an animated null" trick: pan in a random
// direction + zoom + rotation, each axis walking on its own segment.
//
// Beat response is PER-AXIS: each gated hard beat re-aims ONE axis (pan /
// rotation / zoom, round-robin) — and sometimes a second — so the walk
// keeps evolving without ever feeling like a hard cut. Only the very
// hardest kicks (the page's shared hard-kick detector: sub-bass dominant,
// near the rolling peak, ~10s cooldown) re-aim ALL THREE at once, with a
// zoom punch. With no qualifying beats (or no audio) an idle fallback
// re-aims the next axis every maxGapS so the walk never parks.
//
// The axes can go far: zoom travels exponentially up to 20× at full
// slider, pan wanders up to ±60% of the stage, and rotation is an
// UNBOUNDED spin — a segment is an angular velocity, not an angle range,
// so between its re-aims the frame can roll fully upside down or through
// several complete revolutions.
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
// margin — computed from the ACTUAL current angle and offset each tick — so
// the (viewport-sized) layers always cover the viewport; no background ever
// peeks in at the edges regardless of where the walk has wandered or how
// far it has rolled.
//
// Driven from core.onTick (the reactivity cadence, never gated by the viz
// frame cap) so beat edges aren't missed at low render fps and the drift
// stays smooth even when the fx itself renders slowly. Paused core stops
// ticks, which freezes the walk — intended.

/** Baseline tunables — the walk card's slider defaults. */
export const CAM_WALK_DEFAULTS = {
  drift:   0.35,   // [0,1] pan speed + wander range (1 → ±60% of the stage)
  zoom:    0.40,   // [0,1] zoom travel depth, exponential (1 → up to 20×)
  rotate:  0.35,   // [0,1] spin speed ceiling (1 → up to 60°/s, unbounded angle)
  punch:   0.30,   // [0,1] zoom-punch strength on beat re-aims (0 = off)
  minGapS: 2.0,    // gate: at most one beat re-aim per this many seconds
  maxGapS: 9.0,    // gate: at least one re-aim per this many seconds (idle fallback)
};

// Motion constants. Velocities ease toward per-segment targets with this
// time constant, so a re-aim reads as a camera operator changing the move,
// not a cut.
const EASE_TAU_S      = 1.2;
const PUNCH_TAU_S     = 0.15;  // beat zoom-punch decay (~sharp like beat.pulse)
const ZOOM_FACTOR_MAX = 20;    // zoom slider at 1 → travel tops out at 20×
const SPIN_SPEED_MAX  = 60 * Math.PI / 180;  // rotate slider at 1 → up to 60°/s
const PAN_RANGE_MAX   = 0.60;  // drift slider at 1 → wander up to ±60% of stage
const PAN_SPEED_MAX   = 0.22;  // ...at up to 0.22 stage-fractions/s
const PUNCH_GAIN      = 0.15;  // punch slider at 1 → +15% multiplicative zoom kick
// Chance a re-aimed axis instead goes nearly still for a segment — moments
// of rest so the walk isn't perpetual all-axis motion.
const CALM_CHANCE     = 0.3;
// Chance a regular (non-hard-kick) beat re-aim grabs a second axis too.
const SECOND_AXIS_CHANCE = 0.3;

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
 * @param {() => number} [opts.getHardKickAt]
 *   performance.now() timestamp of the page's last shared hard-kick (the
 *   strict sub-bass detector glitch blips also listen to). Hard kicks
 *   re-aim all three axes at once; without the hook the walk just never
 *   takes the all-three path.
 */
export function createCamWalk({ getLayers, getStageSize, getHardKickAt } = {}) {
  const cfg = { ...CAM_WALK_DEFAULTS };
  let enabled = false;

  // Camera state. Pan is in fractions of the stage box (mapped to CSS
  // translate %, so no pixel-size reads are needed); zoom01 is the position
  // along the exponential zoom travel; rot is UNBOUNDED (wrapped by 2π when
  // far out — visually identical, keeps the float healthy).
  let px = 0, py = 0, rot = 0, zoom01 = 0.35;
  // Current velocities + the per-segment targets they ease toward.
  let vx = 0, vy = 0, vr = 0, vz = 0;
  let tvx = 0, tvy = 0, tvr = 0, tvz = 0;

  let punchEnv = 0;
  let lastRetargetMs = 0;
  let lastKickConsumedMs = 0;
  let prevBeatActive = false;
  // Round-robin cursor over the beat-targetable axes.
  const AXES = ['pan', 'rot', 'zoom'];
  let axisCursor = 0;
  /** Elements currently carrying our transform (for cleanup on change). */
  let applied = new Set();

  // Per-config speed/range derivations, kept as functions so live slider
  // moves take effect immediately.
  const maxPan    = () => 0.04 + (PAN_RANGE_MAX - 0.04) * cfg.drift;
  const panSpeed  = () => 0.01 + (PAN_SPEED_MAX - 0.01) * cfg.drift;   // frac/s
  const spinSpeed = () => SPIN_SPEED_MAX * cfg.rotate;                 // rad/s ceiling
  // Zoom is exponential: scale = ZOOM_FACTOR_MAX^(zoom01 · cfg.zoom), so the
  // perceived zoom rate is constant along the whole travel.
  const zoomLogTop = () => Math.log(ZOOM_FACTOR_MAX) * cfg.zoom;
  const zoomSpeed  = () => 0.02 + 0.16 * cfg.zoom;                     // zoom01/s

  const jitter = () => 0.6 + Math.random() * 0.8;            // ±: 0.6..1.4×
  const calm   = () => Math.random() < CALM_CHANCE;

  // Per-axis re-aims. Each picks a fresh segment target for ONE axis and
  // leaves the others walking their current segments — that's what lets a
  // spin carry on through several pan/zoom re-aims ("it can spin for a
  // while") before the rotation axis comes up again.
  function retargetPan() {
    const ang = Math.random() * Math.PI * 2;
    const sp  = panSpeed() * jitter() * (calm() ? 0.1 : 1);
    tvx = Math.cos(ang) * sp;
    tvy = Math.sin(ang) * sp;
  }
  function retargetRot() {
    // A rotation segment is an angular VELOCITY — no angle bound, so a hot
    // segment can roll the frame upside down or through >360° before the
    // round-robin comes back around. Magnitude 15–100% of the ceiling.
    const mag = spinSpeed() * (0.15 + Math.random() * 0.85);
    tvr = (Math.random() < 0.5 ? -1 : 1) * mag * (calm() ? 0.05 : 1);
  }
  function retargetZoom() {
    // Bias the direction toward the far end of the travel near the rails so
    // zoom never parks against a bound; free choice mid-travel.
    const dir = zoom01 > 0.65 ? -1 : zoom01 < 0.35 ? 1
              : (Math.random() < 0.5 ? -1 : 1);
    tvz = dir * zoomSpeed() * jitter() * (calm() ? 0.15 : 1);
  }
  const RETARGET_BY_AXIS = { pan: retargetPan, rot: retargetRot, zoom: retargetZoom };

  /** Re-aim the next axis in the round-robin (advancing the cursor). */
  function retargetNextAxis() {
    RETARGET_BY_AXIS[AXES[axisCursor]]();
    axisCursor = (axisCursor + 1) % AXES.length;
  }
  function retargetAll() {
    retargetPan(); retargetRot(); retargetZoom();
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
    const z = Math.exp(zoom01 * zoomLogTop())
            * (1 + punchEnv * PUNCH_GAIN * cfg.punch);
    // Cover scale: a rotated stage-sized rect needs this much extra to still
    // cover the stage (valid at ANY angle — only |cos|/|sin| enter); the pan
    // margin covers the translation on top of it.
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

    // ── Beat-gated re-aims ──────────────────────────────────────────────
    // Hardest first: a fresh shared hard-kick re-aims ALL THREE axes with a
    // punch (the detector's own ~10s cooldown is the gate). Then a regular
    // rising beat edge re-aims the next axis round-robin — sometimes two —
    // at most once per minGapS. With no qualifying beat (or no audio at
    // all) the maxGapS fallback keeps the walk wandering, one axis at a
    // time, punch-free.
    const beatActive = !!field?.audio?.beat?.active;
    const rising = beatActive && !prevBeatActive;
    prevBeatActive = beatActive;
    const minMs = cfg.minGapS * 1000;
    const maxMs = Math.max(cfg.maxGapS, cfg.minGapS) * 1000;
    const kickAt = getHardKickAt?.() || 0;
    if (kickAt > lastKickConsumedMs) {
      lastKickConsumedMs = kickAt;
      retargetAll();
      punchEnv = 1;
      lastRetargetMs = now;
    } else if (rising && now - lastRetargetMs >= minMs) {
      retargetNextAxis();
      if (Math.random() < SECOND_AXIS_CHANCE) retargetNextAxis();
      punchEnv = Math.max(punchEnv, 0.6);
      lastRetargetMs = now;
    } else if (now - lastRetargetMs >= maxMs) {
      retargetNextAxis();
      lastRetargetMs = now;
    }

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
    // the bound so a long segment can't run away while turning. Rotation is
    // deliberately unbounded — just re-wrapped far out so the float stays
    // healthy (rotate(θ) and rotate(θ±2π) render identically).
    const mp = maxPan();
    if (px >  mp && tvx > 0) tvx = -Math.abs(tvx);
    if (px < -mp && tvx < 0) tvx =  Math.abs(tvx);
    if (py >  mp && tvy > 0) tvy = -Math.abs(tvy);
    if (py < -mp && tvy < 0) tvy =  Math.abs(tvy);
    if (zoom01 >= 1 && tvz > 0) tvz = -Math.abs(tvz);
    if (zoom01 <= 0 && tvz < 0) tvz =  Math.abs(tvz);
    px  = Math.max(-mp * 1.25, Math.min(mp * 1.25, px));
    py  = Math.max(-mp * 1.25, Math.min(mp * 1.25, py));
    // Hard floor at 0: zoom01 below the track start would push the base
    // scale under 1×, which the cover math doesn't compensate — edges would
    // peek in when rotation + pan happen to sit near zero.
    zoom01 = Math.max(0, Math.min(1, zoom01));
    if (rot >  Math.PI * 4) rot -= Math.PI * 2;
    if (rot < -Math.PI * 4) rot += Math.PI * 2;

    punchEnv *= Math.exp(-dt / PUNCH_TAU_S);

    applyToLayers(computeTransform());
  }

  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    if (enabled) {
      // Start walking immediately on every axis — don't wait maxGapS for
      // the first segments — and don't fire on a hard-kick that happened
      // before the walk was switched on.
      axisCursor = (Math.random() * AXES.length) | 0;
      retargetAll();
      lastRetargetMs = performance.now();
      lastKickConsumedMs = performance.now();
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
