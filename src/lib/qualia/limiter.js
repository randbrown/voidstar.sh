// Shared brickwall limiter — clip insurance for each audio track's output bus.
//
// Why this exists: the qualia app has no single master bus. Each track (vox,
// rig+loops, strudel, seq, mic) lives in its OWN AudioContext and writes
// straight to that context's destination, and the browser/OS sums those
// streams at the device — downstream of anything Web Audio can touch. So there
// is nowhere to hang one global limiter. Instead every track owns one of these
// on its own output, just before `ctx.destination`, so no single track can
// shove a full-scale signal into that device-level sum.
//
// Implementation: a DynamicsCompressor tuned as a fast, hard brickwall. The
// vocoder already hand-rolls an identical node (vocoder.js postLimiter); this
// is that pattern, shared, for the four tracks that lacked one.
//
// Toggle by transparency, not by reconnecting: "off" sets ratio 1 / threshold
// 0 so the node passes audio through unchanged. Rerouting the graph live to
// bypass would risk clicks mid-performance; flipping two AudioParams doesn't.

export const LIMITER_CEILING_DB = -1.0;   // ceiling when engaged — just under 0 dBFS

/** Create a brickwall limiter in `ctx`, engaged per the optional `on` flag. */
export function makeLimiter(ctx, on = true) {
  const node = ctx.createDynamicsCompressor();
  node.knee.value    = 0;        // hard knee — a wall, not a slope
  node.attack.value  = 0.003;    // catch transients fast
  node.release.value = 0.10;     // recover gently so it doesn't pump
  setLimiterEngaged(node, on);
  return node;
}

/** Flip a limiter node between brickwall (on) and transparent passthrough (off). */
export function setLimiterEngaged(node, on) {
  if (!node) return;
  try {
    if (on) {
      node.threshold.value = LIMITER_CEILING_DB;
      node.ratio.value     = 20;   // ≈ ∞:1 above the ceiling
    } else {
      node.threshold.value = 0;    // nothing to act on below 0 dBFS …
      node.ratio.value     = 1;    // … and ratio 1 means no reduction anyway
    }
  } catch {}
}
