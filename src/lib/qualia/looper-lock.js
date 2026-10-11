// Pure phrase-lock math for the looper's Strudel sync (no audio, no DOM — so
// scripts/check-qualia-looper-lock.mjs can exercise it under plain node).
//
// The model: every synced take remembers the Strudel cycle its head was
// captured on (`anchor`, an absolute cycle number). A loop spanning Lc cycles
// is "in lock" when, at Strudel cycle `pos`, it is playing loop phase
//   ((pos − anchor) mod Lc) / Lc.
// Strudel's cycle counter restarts at 0 on every ▶, but the PATTERN repeats on
// that same counter, so anchoring to the absolute cycle (mod the loop length)
// keeps a take on the same bar of the phrase across any stop/start on either
// side. Inputs are relative (pos/cps read "now"), so the math is portable
// between the looper's and Strudel's AudioContexts.

const EPS = 1e-6;

export function mod(a, m) {
  const r = a % m;
  return r < 0 ? r + m : r;
}

// Loop period in cycles. Snaps to an integer when it's within a hair of one
// (a "once" take at the cps it was recorded at is exactly N cycles, give or
// take float error), so the phase math doesn't creep.
export function loopCycles(loopDurSec, cps) {
  const lc = loopDurSec * cps;
  const r = Math.round(lc);
  return (r > 0 && Math.abs(lc - r) < 1e-3) ? r : lc;
}

// When to start a voice and at what phase. `pos`/`cps` are Strudel's audible
// cycle clock read now; `margin` is the scheduling lookahead (seconds).
//   immediate → start `margin` from now, dropped in mid-loop at the locked phase
//   otherwise → start on the next grid boundary (≡ 0 mod grid), at the phase the
//               loop should be at on that boundary (not always the head — that
//               was what landed takes a bar off the phrase after a restart)
// Returns { aheadSec, phase } with phase in [0, 1).
export function planLock({ pos, cps, anchor = 0, loopDurSec, grid = 1, immediate = false, margin = 0 }) {
  const N = grid > 0 ? grid : 1;
  let cycleAt;
  if (immediate) cycleAt = pos + margin * cps;
  else cycleAt = Math.ceil((pos + margin * cps) / N - EPS) * N;
  const aheadSec = (cycleAt - pos) / cps;
  const Lc = loopCycles(loopDurSec, cps);
  let phase = Lc > EPS ? mod(cycleAt - (anchor || 0), Lc) / Lc : 0;
  if (phase >= 1 - 1e-9) phase = 0;
  return { aheadSec, phase };
}

// Signed lock error in seconds (+ = the voice is AHEAD of where Strudel says it
// should be), wrapped to ±half a loop. `sinceStartSec` is how long ago the
// voice's phase-0 instant was (now − playStartAbs, in the looper's clock).
export function lockErrorSec({ pos, cps, anchor = 0, loopDurSec, sinceStartSec }) {
  if (!(loopDurSec > 0) || !(cps > 0)) return 0;
  const Lc = loopCycles(loopDurSec, cps);
  const expected = mod(pos - (anchor || 0), Lc) / Lc;
  const actual = mod(sinceStartSec, loopDurSec) / loopDurSec;
  let e = actual - expected;
  e -= Math.round(e);
  return e * loopDurSec;
}

// Retro grab OUT point: the NEAREST grid boundary (like stop-record), which can
// be a little in the future when grab is pressed just before the downbeat —
// the caller waits for it instead of dropping back a whole grid unit (which
// threw away the phrase that was just played).
export function retroOutCycle(pos, grid = 1) {
  const N = grid > 0 ? grid : 1;
  return Math.round(pos / N) * N;
}
