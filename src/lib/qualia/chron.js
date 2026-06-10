// chron.js — "chron": the qualia lab's session stopwatch / set-timer.
//
// Vocabulary (the panel + HUD stick to the metaphor):
//   τ        — the elapsed readout, e.g. "τ 23:41" in the topbar HUD
//   pulse    — the soft periodic nudge (pulsar concept): in zen mode a
//              minute count fades in at the edge of the screen every
//              `zen.pulseEvery` minutes for ~`zen.pulseDuration`s,
//              non-interactive
//   horizon  — the hard set-limit in minutes (0 = none). Crossing
//              `horizon.warnAt`·`horizon.at` and then `horizon.at` fires
//              bigger, longer, red-tinted nudges — in any mode, not just zen
//   redshift — the τ readout + soft pulses tint blue → white → amber → red
//              as elapsed/horizon → 1 (only when a horizon is set)
//
// The stopwatch is wall-clock and starts on the first tick (i.e. with
// core.start() — the session). It keeps counting through pause: it measures
// the session, not the transport. reset() (the card's "reset τ" button)
// rezeroes it.
//
// 'cycles' format ("τ ⟳128") integrates the LIVE cps each tick
// (cycles += dt·cps) instead of multiplying the final cps by total elapsed
// time, so mid-set tempo changes don't rewrite history.
//
// Driving cadence: page-init registers tick() on core.onFps, which fires
// every ~200ms even while paused — cheap, and plenty for a seconds readout.

export const CHRON_DEFAULTS = {
  enabled: true,
  hud: true,                  // show the τ readout in the topbar
  format: 'mm:ss',            // 'mm' | 'mm:ss' | 'hh:mm:ss' | 'cycles'
  zen: {
    pulseEvery: 5,            // minutes between zen pulses (0 = off)
    pulseFormat: 'mm',        // format for the pulse text
    pulseDuration: 3,         // seconds a soft pulse stays visible
    position: 'bottom',       // 'bottom' | 'top'
  },
  horizon: {
    at: 0,                    // minutes (0 = no horizon)
    warnAt: 0.9,              // fraction of `at` for the early warning
    redshift: true,           // tint τ + pulses by elapsed/horizon
  },
};

const FORMATS   = ['mm', 'mm:ss', 'hh:mm:ss', 'cycles'];
const POSITIONS = ['bottom', 'top'];

// Redshift gradient stops — elapsed/horizon 0→1 walks blue → white →
// amber → red, clamping at the ends. Piecewise RGB lerp, sampled only
// when the readout repaints.
const REDSHIFT_STOPS = [
  [0.00, [0x7c, 0xb8, 0xff]],   // blue
  [0.50, [0xe8, 0xec, 0xf8]],   // white (≈ --text)
  [0.85, [0xfb, 0xbf, 0x24]],   // amber (--amber)
  [1.00, [0xf8, 0x71, 0x71]],   // red
];

export function redshiftColor(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  let lo = REDSHIFT_STOPS[0];
  let hi = REDSHIFT_STOPS[REDSHIFT_STOPS.length - 1];
  for (let i = 0; i < REDSHIFT_STOPS.length - 1; i++) {
    if (r >= REDSHIFT_STOPS[i][0] && r <= REDSHIFT_STOPS[i + 1][0]) {
      lo = REDSHIFT_STOPS[i];
      hi = REDSHIFT_STOPS[i + 1];
      break;
    }
  }
  const f = (r - lo[0]) / ((hi[0] - lo[0]) || 1);
  const c = lo[1].map((a, i) => Math.round(a + (hi[1][i] - a) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * @param {object} opts
 * @param {HTMLElement} opts.hudEl    topbar τ readout span
 * @param {HTMLElement} opts.pulseEl  fixed bottom-center pulse element
 * @param {() => boolean} opts.isZen  live zen-mode state
 * @param {() => number}  opts.getCps live Strudel cps (cycles/sec) for the
 *                                    'cycles' format integration
 */
export function createChron({ hudEl, pulseEl, isZen = () => false, getCps = () => 0 } = {}) {
  const cfg = JSON.parse(JSON.stringify(CHRON_DEFAULTS));

  let startMs = null;        // lazy — set on the first tick (session start)
  let lastMs  = null;
  let cycles  = 0;           // ∫ cps dt — the 'cycles' format readout
  let lastPulseIdx = 0;      // which pulseEvery-mark fired last
  let warnFired = false, horizonFired = false;
  let pulseHideAt = 0;       // performance.now() deadline; 0 = no pulse up
  let lastHudText = null, lastHudTint = null;

  function fmt(tSec, format) {
    const s = Math.max(0, Math.floor(tSec));
    switch (format) {
      case 'mm':       return `${Math.floor(s / 60)}m`;
      case 'hh:mm:ss': return `${Math.floor(s / 3600)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
      case 'cycles':   return `⟳${Math.floor(cycles)}`;
      default:         return `${Math.floor(s / 60)}:${pad2(s % 60)}`;   // mm:ss
    }
  }

  // Sync the static chrome (HUD visibility, pulse anchor edge) to cfg —
  // called after every setConfig so toggles land without waiting on a tick.
  function applyChrome() {
    if (hudEl) hudEl.style.display = (cfg.enabled && cfg.hud) ? '' : 'none';
    if (pulseEl) pulseEl.classList.toggle('top', cfg.zen.position === 'top');
  }

  function firePulse(text, kind, tint) {
    if (!pulseEl) return;
    pulseEl.textContent = text;
    pulseEl.classList.toggle('warn',    kind === 'warn');
    pulseEl.classList.toggle('horizon', kind === 'horizon');
    // Soft pulses carry the redshift tint; warn/horizon keep their CSS
    // class colors (red-tinted by design, redshift or not).
    pulseEl.style.color = kind === 'soft' ? (tint || '') : '';
    pulseEl.classList.add('visible');
    const dur = kind === 'soft' ? cfg.zen.pulseDuration
              : kind === 'warn' ? Math.max(6, cfg.zen.pulseDuration)
              :                   Math.max(8, cfg.zen.pulseDuration);
    pulseHideAt = performance.now() + dur * 1000;
  }

  function tick() {
    const now = performance.now();
    if (startMs == null) { startMs = now; lastMs = now; }
    const dt = (now - lastMs) / 1000;
    lastMs = now;
    let cps = 0;
    try { cps = getCps() || 0; } catch {}
    cycles += dt * Math.max(0, cps);

    const t = (now - startMs) / 1000;
    const minutes = t / 60;
    const zen = isZen();

    // Expire a visible pulse — the fade-out is the CSS opacity transition.
    if (pulseHideAt && now >= pulseHideAt) {
      pulseEl?.classList.remove('visible');
      pulseHideAt = 0;
    }

    const horizonMin = cfg.horizon.at;
    const tint = (cfg.horizon.redshift && horizonMin > 0)
      ? redshiftColor(minutes / horizonMin) : '';

    // HUD readout — repaint only on change so the topbar doesn't churn.
    if (hudEl && cfg.enabled && cfg.hud) {
      const text = `τ ${fmt(t, cfg.format)}`;
      if (text !== lastHudText) { hudEl.textContent = text; lastHudText = text; }
      if (tint !== lastHudTint) { hudEl.style.color = tint; lastHudTint = tint; }
    }

    // Zen pulse marks. The index tracks in EVERY mode so entering zen
    // mid-interval waits for the next mark instead of replaying old ones.
    const every = cfg.zen.pulseEvery;
    if (every > 0) {
      const idx = Math.floor(minutes / every);
      if (idx !== lastPulseIdx) {
        const crossed = idx > lastPulseIdx;
        lastPulseIdx = idx;
        if (crossed && zen && cfg.enabled) {
          firePulse(`τ ${fmt(t, cfg.zen.pulseFormat)}`, 'soft', tint);
        }
      }
    }

    // Horizon nudges — any mode, not just zen. If the session is already
    // past the horizon when it crosses (e.g. horizon just lowered), the
    // hard nudge fires alone and swallows the warn.
    if (cfg.enabled && horizonMin > 0) {
      if (!horizonFired && minutes >= horizonMin) {
        warnFired = horizonFired = true;
        firePulse(`τ horizon · ${Math.round(horizonMin)}m`, 'horizon', '');
      } else if (!warnFired && minutes >= horizonMin * cfg.horizon.warnAt) {
        warnFired = true;
        const remain = Math.max(1, Math.round(horizonMin - minutes));
        firePulse(`τ horizon −${remain}m`, 'warn', '');
      }
    }
  }

  function reset() {
    const now = performance.now();
    startMs = now; lastMs = now;
    cycles = 0; lastPulseIdx = 0;
    warnFired = false; horizonFired = false;
    lastHudText = null; lastHudTint = null;   // force a HUD repaint
    pulseEl?.classList.remove('visible');
    pulseHideAt = 0;
  }

  /** Deep-merge a partial config (the persisted settings shape). Unknown
   *  keys are ignored; numbers are clamped to sane ranges. Changing the
   *  horizon re-arms the warn/horizon nudges against the new limit. */
  function setConfig(patch) {
    if (!patch || typeof patch !== 'object') return;
    const prevHorizonAt = cfg.horizon.at;
    if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
    if (typeof patch.hud     === 'boolean') cfg.hud     = patch.hud;
    if (FORMATS.includes(patch.format))     cfg.format  = patch.format;
    if (patch.zen && typeof patch.zen === 'object') {
      const z = patch.zen;
      if (Number.isFinite(z.pulseEvery))    cfg.zen.pulseEvery    = Math.max(0, z.pulseEvery);
      if (FORMATS.includes(z.pulseFormat))  cfg.zen.pulseFormat   = z.pulseFormat;
      if (Number.isFinite(z.pulseDuration)) cfg.zen.pulseDuration = Math.min(30, Math.max(0.5, z.pulseDuration));
      if (POSITIONS.includes(z.position))   cfg.zen.position      = z.position;
    }
    if (patch.horizon && typeof patch.horizon === 'object') {
      const h = patch.horizon;
      if (Number.isFinite(h.at))            cfg.horizon.at       = Math.max(0, h.at);
      if (Number.isFinite(h.warnAt))        cfg.horizon.warnAt   = Math.min(0.99, Math.max(0.1, h.warnAt));
      if (typeof h.redshift === 'boolean')  cfg.horizon.redshift = h.redshift;
    }
    if (cfg.horizon.at !== prevHorizonAt) { warnFired = false; horizonFired = false; }
    if (!cfg.horizon.redshift && hudEl) { hudEl.style.color = ''; lastHudTint = null; }
    applyChrome();
  }

  applyChrome();

  return {
    tick,
    reset,
    setConfig,
    getConfig: () => JSON.parse(JSON.stringify(cfg)),
    getElapsedSec: () => (startMs == null ? 0 : (performance.now() - startMs) / 1000),
    getCycles: () => cycles,
  };
}
