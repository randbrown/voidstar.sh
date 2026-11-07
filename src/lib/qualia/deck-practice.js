// deck-practice.js — pure math behind the deck's lick-practice tools.
//
// No DOM, no Web Audio: just the numbers audio-file.js needs to loop a region,
// slow it down, and ramp the speed back up. Kept pure so
// scripts/check-qualia-deck-practice.mjs can pin the edge cases (wrap, clamp,
// seam crossfade, trainer steps) without a browser.

/** Slowest / fastest playback rate the deck offers. */
export const RATE_MIN = 0.25;
export const RATE_MAX = 1.5;
/** Transpose range, semitones. */
export const TRANSPOSE_MAX = 12;
/** Shortest loop region we accept, seconds (anything tighter is a mis-click). */
export const MIN_REGION_SEC = 0.05;
/** Seam crossfade at a loop region's wrap, seconds (same as the looper's). */
export const SEAM_FADE_SEC = 0.008;

export function clampRate(r) {
  const v = Number(r);
  if (!Number.isFinite(v)) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(v * 100) / 100));
}

export function clampTranspose(st) {
  const v = Math.round(Number(st) || 0);
  return Math.min(TRANSPOSE_MAX, Math.max(-TRANSPOSE_MAX, v));
}

/** Resolve the A/B markers (either may be unset, i.e. < 0) against the track
 *  length into a concrete `{ lo, hi }`, or null when there's no usable region.
 *  An unset A means "from the top", an unset B "to the end". */
export function resolveRegion(a, b, duration) {
  const dur = Number(duration) || 0;
  if (dur <= 0) return null;
  const hasA = Number.isFinite(a) && a >= 0;
  const hasB = Number.isFinite(b) && b >= 0;
  if (!hasA && !hasB) return null;
  const lo = hasA ? Math.min(a, dur) : 0;
  const hi = hasB ? Math.min(b, dur) : dur;
  if (hi - lo < MIN_REGION_SEC) return null;
  return { lo, hi };
}

/** Where the head is, given where it was anchored (`anchorPos` seconds into
 *  the track at `elapsed` = 0) and how far the clock has moved since, at
 *  `rate`. When `loop` is a `{ lo, hi }` window the head wraps inside it. */
export function headPosition(anchorPos, elapsed, rate, duration, loop) {
  let p = anchorPos + Math.max(0, elapsed) * rate;
  if (loop && loop.hi > loop.lo && p >= loop.hi) {
    const len = loop.hi - loop.lo;
    p = loop.lo + ((p - loop.lo) % len);
  }
  return Math.min(Math.max(0, p), Math.max(0, duration));
}

/** Where playback should start for a requested offset: inside a loop region
 *  it must land in [lo, hi) (else it snaps to A); otherwise a head parked at
 *  the very end goes back to the top. */
export function startOffset(offset, duration, region) {
  const t = Math.min(Math.max(0, Number(offset) || 0), duration);
  if (region) return (t < region.lo || t >= region.hi - 0.01) ? region.lo : t;
  return t >= duration ? 0 : t;
}

/** Pitch shift to hand the stretcher: the transpose, plus — with pitch lock
 *  off — the drop varispeed would have given at this rate (so "lock off" sounds
 *  the same on both playback paths). */
export function stretchSemitones(rate, pitchLock, transpose) {
  return (transpose || 0) + (pitchLock ? 0 : 12 * Math.log2(rate));
}

/** True when the stretcher has to run: any transpose, or a locked pitch at a
 *  rate other than 1. Everything else is a plain (varispeed) buffer source. */
export function needsStretch(rate, pitchLock, transpose) {
  return (transpose | 0) !== 0 || (pitchLock && Math.abs(rate - 1) > 1e-3);
}

/** Bake an equal-power crossfade into the TAIL of per-channel region copies so
 *  the loop wrap (last sample → first) is continuous. `pre` holds the audio
 *  just before A (one Float32Array per channel, same length as the fade), so
 *  the tail fades into what really preceded the region's first sample. With no
 *  pre-roll it falls back to a micro fade-out (tail) + fade-in (head). Mutates
 *  `regions` in place. */
export function bakeRegionSeam(regions, pre, sampleRate) {
  if (!regions?.length) return;
  const len = regions[0].length;
  const n = Math.min(Math.round(SEAM_FADE_SEC * sampleRate), len >> 1);
  if (n < 2) return;
  for (let c = 0; c < regions.length; c++) {
    const r = regions[c];
    const p = pre && pre[c] && pre[c].length >= n ? pre[c] : null;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const fadeOut = Math.cos(t * Math.PI / 2), fadeIn = Math.sin(t * Math.PI / 2);
      const k = len - n + i;
      if (p) {
        r[k] = r[k] * fadeOut + p[p.length - n + i] * fadeIn;
      } else {
        r[k] *= fadeOut;
        r[i] *= fadeIn;
      }
    }
  }
}

/** Speed-trainer step: after `every` passes, add `step` up to `target`.
 *  Returns `{ rate, passes, done }` for the pass that just completed. */
export function trainerAdvance(rate, passes, cfg) {
  const every = Math.max(1, cfg.every | 0);
  const n = passes + 1;
  if (n < every) return { rate, passes: n, done: false };
  const next = Math.min(cfg.target, clampRate(rate + cfg.step));
  const done = next >= cfg.target - 1e-6;
  return { rate: Math.max(rate, next), passes: 0, done };
}
