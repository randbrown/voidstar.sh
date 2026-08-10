// Set-level fade — the slow open / slow close of a set, as one call.
//
// There is deliberately no master audio bus (each engine writes to its own
// AudioContext's destination — see architecture §5), so a fade can't be one
// gain node. Instead every engine exposes `fadeTo(scale, seconds)`: a
// NON-persisted multiplier folded into its existing output-gain target and
// ramped natively (linearRampToValueAtTime) in that engine's own context.
// One call here fans out once; the fades themselves then run entirely on the
// audio threads — zero main-thread work for their whole duration, however
// long. Because the multiplier is never persisted, a mid-fade reload comes
// back at full level, and the mixer's stored levels/mutes are untouched (the
// fade multiplies them, it doesn't move the faders).
//
// Visuals ride a fade-to-black scrim (#stage-fade): a fixed black layer over
// the whole stage (under the panels/topbar) whose opacity runs on a CSS
// transition — compositor-only, no per-frame JS. The recorder's composite
// canvas can't see DOM layers, so page-init mirrors the same level into the
// composite via `visualLevel()` — recordings fade exactly like the room.
//
// Interaction rule (documented, deliberate): touching a fader / mute during
// a fade re-applies that channel at the fade's TARGET scale — the engines'
// own setters always compute `base × fadeScale` with the stored (target)
// scale. A 30 s fade-out interrupted by a fader move snaps that channel to
// its end level; fadeIn() un-does everything.

/**
 * @param {Object} deps  Engine handles (each optional; missing ones skip):
 *   audio (mic monitor), strudel, sequencer, looper (rig+loops+freeze), vocoder.
 * @returns {{ fade, fadeOut, fadeIn, level, visualLevel }}
 */
export function createFader({ audio, strudel, sequencer, looper, vocoder } = {}) {
  const scrim = document.getElementById('stage-fade');
  const engines = [audio, strudel, sequencer, looper, vocoder];

  // Both sides tracked as {from, to, t0, dur} so level()/visualLevel() can
  // report the interpolated value without polling any audio graph or forcing
  // a style read — the CSS transition and the native ramps are linear over
  // the same window, so this computed value matches what's heard/seen.
  const now = () => performance.now() / 1000;
  let aF = { from: 1, to: 1, t0: 0, dur: 0 };   // audio scale (1 = full)
  let vF = { from: 0, to: 0, t0: 0, dur: 0 };   // scrim opacity (1 = black)
  const levelOf = (f) => {
    if (f.dur <= 0) return f.to;
    const p = Math.min(1, Math.max(0, (now() - f.t0) / f.dur));
    return f.from + (f.to - f.from) * p;
  };

  /**
   * Fade everything to `target` (0 = silent/black … 1 = full) over `seconds`.
   * opts: {audio: false} or {visuals: false} to fade only one side.
   */
  function fade(target, seconds = 10, opts = {}) {
    const t = Math.min(1, Math.max(0, Number(target) || 0));
    const sec = Math.max(0, Number(seconds) || 0);
    if (opts.audio !== false) {
      aF = { from: levelOf(aF), to: t, t0: now(), dur: sec };
      for (const eng of engines) {
        try { eng?.fadeTo?.(t, sec); }
        catch (e) { console.warn('[qualia] fade engine failed:', e); }
      }
    }
    if (opts.visuals !== false && scrim) {
      vF = { from: levelOf(vF), to: 1 - t, t0: now(), dur: sec };
      // Restate the current opacity with the transition off, force a style
      // flush, then arm the transition to the new target — so an interrupted
      // fade re-ramps from wherever it visibly is. One layout read per fade
      // call, never per frame.
      scrim.style.transition = 'none';
      scrim.style.opacity = String(vF.from);
      void scrim.offsetWidth;
      scrim.style.transition = sec > 0 ? `opacity ${sec}s linear` : 'none';
      scrim.style.opacity = String(vF.to);
    }
    return { level: t, seconds: sec };
  }

  return {
    fade,
    /** Fade out to silence + black. Default 10 s. */
    fadeOut: (seconds = 10, opts) => fade(0, seconds, opts),
    /** Fade back in to full level. Default 10 s. */
    fadeIn: (seconds = 10, opts) => fade(1, seconds, opts),
    /** Current audio fade level, 0..1 (1 = full, interpolated mid-fade). */
    level: () => levelOf(aF),
    /** Current visual fade (scrim opacity 0..1) — recorder composite mirror. */
    visualLevel: () => levelOf(vF),
  };
}
