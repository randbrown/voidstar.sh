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
  // 1 ms attack. The old 3 ms let the leading edge of a low-frequency
  // transient (a kick is ~30 ms per cycle) pass before the gain reduction
  // engaged, so peaks slipped through several dB above the ceiling and
  // clipped the device DAC anyway. 1 ms catches the front of the wave while
  // still being slow enough not to distort sustained mids/highs.
  node.attack.value  = 0.001;
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

// ── Zero-latency variant — soft-clip WaveShaper ─────────────────────────────
// The DynamicsCompressor limiter above carries Chromium's fixed ~6 ms lookahead
// pre-delay even when transparent, which is fine for playback-only buses but
// directly audible as monitoring latency on the rig's live-instrument path. This
// variant is a memoryless soft clipper: dead-transparent (bit-exact identity)
// below the -6 dBFS knee, then a tanh ease into the -1 dB ceiling; WaveShaper
// input beyond the curve domain clamps to the end value, so it is a true
// brickwall with ZERO added latency. Trade-offs vs the lookahead limiter: no
// gain-reduction memory (it clips the waveform rather than riding a gain
// envelope) and no oversampling (that would reintroduce the group delay we're
// removing), so hard overs alias a little — acceptable for clip *insurance*
// that only engages on true overs.

const SOFT_KNEE   = 0.5;                                  // -6 dBFS — identity below here
const SOFT_CEIL   = Math.pow(10, LIMITER_CEILING_DB / 20); // ≈ 0.891 (-1 dBFS asymptote)
const SOFT_CURVE_N = 4096;

const softClipCurve = (() => {
  const c = new Float32Array(SOFT_CURVE_N);
  const span = SOFT_CEIL - SOFT_KNEE;
  for (let i = 0; i < SOFT_CURVE_N; i++) {
    const x = (i / (SOFT_CURVE_N - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = a <= SOFT_KNEE ? x : Math.sign(x) * (SOFT_KNEE + span * Math.tanh((a - SOFT_KNEE) / span));
  }
  return c;
})();

/** Create a zero-latency soft-clip brickwall in `ctx`, engaged per `on`. */
export function makeSoftLimiter(ctx, on = true) {
  const node = ctx.createWaveShaper();   // oversample stays 'none' — see above
  setSoftLimiterEngaged(node, on);
  return node;
}

/** Flip a soft limiter between clip curve (on) and passthrough (off).
 *  A null curve is the spec-defined identity — a true unclamped passthrough. */
export function setSoftLimiterEngaged(node, on) {
  if (!node) return;
  try { node.curve = on ? softClipCurve : null; } catch {}
}
