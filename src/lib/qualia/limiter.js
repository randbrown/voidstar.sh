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
// Implementation: a LOOKAHEAD brickwall (worklets/lookahead-limiter.js) — the
// LoudMax recipe: delay the audio a few ms, see the peak coming, and ride a
// smooth gain envelope so the peak lands exactly on the ceiling. It never
// reshapes the waveform, so it stays transparent even when driven hard (the
// rig at boost lives in limiting). The two older designs it replaces both
// distorted audibly under load:
//   • DynamicsCompressor (ratio 20, 1 ms attack, 100 ms release) — gain moves
//     inside a bass cycle, overshoots on fast transients, ~6 ms lookahead anyway;
//   • soft-clip WaveShaper (rig) — memoryless tanh from -6 dBFS up, i.e. the
//     rig was being SATURATED whenever it ran hot, with no oversampling.
// Both survive here only as fallbacks while the worklet module loads (a few
// ms at context start) or where AudioWorklet isn't available.
//
// The node `makeLimiter` returns is a composite that quacks like an AudioNode:
// `src.connect(lim)`, `lim.connect(dest)`, `lim.disconnect()`, and the
// `__qualiaBypassMute` flag all behave as they did on the old single node.
// When the worklet comes up it is crossfaded in over the fallback (no click).
//
// Toggle by transparency, not by reconnecting: "off" lets the gain envelope
// release to unity (the delay stays, so latency never jumps). Rerouting the
// graph live to bypass would risk clicks mid-performance.

import limiterWorkletUrl from './worklets/lookahead-limiter.js?url&no-inline';

export const LIMITER_CEILING_DB = -1.0;   // ceiling when engaged — just under 0 dBFS

// Rig master fader ceiling. 1.0 is nominal (reference-trimmed source); the
// span above it is BOOST — up to +6 dB of makeup so the rig can hold its own
// against hotter tracks (strudel/seq buses, music playing from another app).
// Boost is only safe because it drives the limiter below (gain into a
// brickwall = a loudness maximizer), so looper.js force-engages the rig
// limiter whenever the level sits above 1.0.
export const RIG_LEVEL_MAX = 2;

// Defaults for playback buses (strudel / seq / file / vox / mic monitor). 5 ms
// lookahead is no more latency than the DynamicsCompressor's built-in ~6 ms
// pre-delay it replaces.
export const BUS_LOOKAHEAD_MS = 5;
export const BUS_RELEASE_MS   = 120;
// Rig: the live instrument monitor runs through it, so keep the lookahead
// short. 1.5 ms is ~50 cm of air — a fraction of the strip's own latency —
// and still spans most of a cycle at 700 Hz, so the gain ramp is gentle.
export const RIG_LOOKAHEAD_MS = 1.5;
export const RIG_RELEASE_MS   = 100;

const XFADE_SEC = 0.05;   // fallback → worklet crossfade when the module lands

// ── worklet module loading (once per context) ────────────────────────────────
const moduleReady = new WeakMap();   // ctx -> Promise<boolean>
let warned = false;
function ensureModule(ctx) {
  if (!ctx?.audioWorklet?.addModule) return Promise.resolve(false);
  let p = moduleReady.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(limiterWorkletUrl).then(() => true).catch((err) => {
      if (!warned) { warned = true; console.warn('[qualia] lookahead-limiter worklet failed to load — using fallback limiter:', err); }
      return false;
    });
    moduleReady.set(ctx, p);
  }
  return p;
}

// Call the node's REAL connect/disconnect (looked up per call, so Strudel's
// late AudioNode.prototype.connect patch still applies to what we wire).
const rawConnect    = (n, ...a) => Object.getPrototypeOf(n).connect.call(n, ...a);
const rawDisconnect = (n, ...a) => { try { Object.getPrototypeOf(n).disconnect.call(n, ...a); } catch {} };

// ── legacy DynamicsCompressor brickwall (fallback) ───────────────────────────
function makeCompressorLimiter(ctx, on, ceilingDb) {
  const node = ctx.createDynamicsCompressor();
  node.knee.value    = 0;        // hard knee — a wall, not a slope
  node.attack.value  = 0.001;    // 1 ms: catches the front of a kick
  node.release.value = 0.10;
  node.__ceilingDb   = ceilingDb;
  setCompressorEngaged(node, on);
  return node;
}
function setCompressorEngaged(node, on) {
  try {
    if (on) {
      node.threshold.value = node.__ceilingDb ?? LIMITER_CEILING_DB;
      node.ratio.value     = 20;   // ≈ ∞:1 above the ceiling
    } else {
      node.threshold.value = 0;    // nothing to act on below 0 dBFS …
      node.ratio.value     = 1;    // … and ratio 1 means no reduction anyway
    }
  } catch {}
}

/**
 * Create a brickwall limiter in `ctx`, engaged per `on`.
 * @param {object} [opts]
 * @param {number} [opts.lookaheadMs=BUS_LOOKAHEAD_MS]
 * @param {number} [opts.releaseMs=BUS_RELEASE_MS]
 * @param {number} [opts.ceilingDb=LIMITER_CEILING_DB]
 * @param {'compressor'|'softclip'} [opts.fallback='compressor']  what runs
 *   until (or instead of, if AudioWorklet is unavailable) the lookahead worklet
 * @param {(name: string, options: object) => AudioNode} [opts.createNode]
 *   AudioWorkletNode factory for wrapped contexts (Tone's standardized-audio-
 *   context can't take a native `new AudioWorkletNode`)
 */
export function makeLimiter(ctx, on = true, opts = {}) {
  const lookaheadMs = opts.lookaheadMs ?? BUS_LOOKAHEAD_MS;
  const releaseMs   = opts.releaseMs ?? BUS_RELEASE_MS;
  const ceilingDb   = opts.ceilingDb ?? LIMITER_CEILING_DB;
  const softFallback = opts.fallback === 'softclip';

  const input  = ctx.createGain();
  const output = ctx.createGain();
  output.__qualiaBypassMute = true;
  const fbGain = ctx.createGain();
  const fb = softFallback ? makeSoftLimiter(ctx, on) : makeCompressorLimiter(ctx, on, ceilingDb);
  rawConnect(input, fbGain); rawConnect(fbGain, fb); rawConnect(fb, output);

  let engaged = !!on;
  let worklet = null, wGain = null, fbLive = true, grDb = 0, disposed = false;

  // Mirror the Strudel mute-patch opt-out onto the node that actually reaches
  // the destination.
  let bypass = true;   // a limiter is always the last hop before destination
  Object.defineProperty(input, '__qualiaBypassMute', {
    configurable: true,
    get: () => bypass,
    set: (v) => { bypass = !!v; output.__qualiaBypassMute = bypass; },
  });
  // Outward-facing connect/disconnect act on the composite's OUTPUT.
  input.connect    = (...a) => rawConnect(output, ...a);
  input.disconnect = (...a) => rawDisconnect(output, ...a);

  input.__lookahead = true;
  input.setEngaged = (v) => {
    engaged = !!v;
    if (fbLive) (softFallback ? setSoftLimiterEngaged : setCompressorEngaged)(fb, engaged);
    try { worklet?.port.postMessage({ engaged }); } catch {}
    if (!engaged) grDb = 0;
  };
  input.isEngaged = () => engaged;
  /** True once the lookahead worklet carries the audio (false = fallback). */
  input.isLookahead = () => !!worklet && !fbLive;
  /** Current gain reduction in dB (≥ 0), or null when the soft-clip fallback
   *  is live (memoryless — the caller derives it from its pre-limiter peak). */
  input.getReductionDb = () => {
    if (!engaged) return 0;
    if (worklet) return grDb;
    if (softFallback) return null;
    const r = Number(fb.reduction);   // DynamicsCompressor: ≤ 0 dB
    return Number.isFinite(r) ? Math.max(0, -r) : 0;
  };
  /** Audio delay this limiter adds, in seconds (rig latency readout). */
  input.getLatencySeconds = () => {
    if (worklet) return Math.max(2, Math.round((lookaheadMs / 1000) * ctx.sampleRate)) / ctx.sampleRate;
    return softFallback ? 0 : 0.006;   // Chromium compressor's fixed pre-delay
  };
  input.dispose = () => {
    disposed = true;
    try { worklet?.port.postMessage({ cmd: 'dispose' }); } catch {}
    rawDisconnect(input); rawDisconnect(output);
    rawDisconnect(fbGain); rawDisconnect(fb);
    if (worklet) { rawDisconnect(worklet); rawDisconnect(wGain); }
  };

  ensureModule(ctx).then((ok) => {
    if (!ok || disposed) return;
    const options = {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { lookaheadMs, releaseMs, ceilingDb, engaged },
    };
    let node;
    try {
      node = opts.createNode ? opts.createNode('lookahead-limiter', options)
                             : new AudioWorkletNode(ctx, 'lookahead-limiter', options);
    } catch (err) {
      if (!warned) { warned = true; console.warn('[qualia] lookahead limiter unavailable on this context — using fallback limiter:', err); }
      return;
    }
    worklet = node;
    worklet.port.onmessage = (e) => { const g = e.data?.gr; if (typeof g === 'number') grDb = engaged ? g : 0; };
    worklet.port.postMessage({ engaged });   // catch a toggle that raced the load
    wGain = ctx.createGain();
    wGain.gain.value = 0;
    rawConnect(input, worklet); rawConnect(worklet, wGain); rawConnect(wGain, output);
    // Crossfade fallback → worklet. Both paths are limited, so the brief
    // overlap can't clip; the comb from their different delays lasts 50 ms.
    try {
      const t = ctx.currentTime;
      wGain.gain.setValueAtTime(0, t);  wGain.gain.linearRampToValueAtTime(1, t + XFADE_SEC);
      fbGain.gain.setValueAtTime(1, t); fbGain.gain.linearRampToValueAtTime(0, t + XFADE_SEC);
    } catch { wGain.gain.value = 1; fbGain.gain.value = 0; }
    setTimeout(() => {
      fbLive = false;
      rawDisconnect(input, fbGain); rawDisconnect(fbGain); rawDisconnect(fb);
    }, XFADE_SEC * 1000 + 150);
  });

  return input;
}

/** The rig master's limiter: short lookahead (live monitor path), soft-clip
 *  fallback so it's zero-latency until the worklet lands. */
export function makeRigLimiter(ctx, on = true, opts = {}) {
  return makeLimiter(ctx, on, { lookaheadMs: RIG_LOOKAHEAD_MS, releaseMs: RIG_RELEASE_MS, fallback: 'softclip', ...opts });
}

/** Flip a limiter between brickwall (on) and transparent passthrough (off).
 *  Accepts a makeLimiter composite or a bare DynamicsCompressor. */
export function setLimiterEngaged(node, on) {
  if (!node) return;
  if (node.__lookahead) { node.setEngaged(on); return; }
  setCompressorEngaged(node, on);
}

/** Gain reduction (dB, ≥ 0) a makeLimiter composite is applying right now;
 *  null when unknown (soft-clip fallback live — see softLimiterReductionDb). */
export function limiterReductionDb(node) {
  return node?.getReductionDb ? node.getReductionDb() : 0;
}

// ── Zero-latency soft-clip WaveShaper (rig fallback) ────────────────────────
// Was the rig's limiter before the lookahead worklet; now only the rig
// limiter's fallback (makeRigLimiter, while the module loads / without
// AudioWorklet). A memoryless soft clipper: bit-exact identity below the
// -6 dBFS knee, then a tanh ease into the -1 dB ceiling; WaveShaper input
// beyond the curve domain clamps to the end value, so it is a true brickwall
// with ZERO added latency. The catch, and the reason it was replaced: it
// clips the waveform rather than riding a gain envelope, so anything hot
// enough to touch the knee is audibly saturated (and un-oversampled, so it
// aliases) — and a boosted rig touches the knee constantly.

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

/** dB of gain reduction the soft-clip curve applies at linear peak `peak`.
 *  Exact math, not measurement: the clipper is memoryless, so reduction is a
 *  pure function of the instantaneous input level — feed it the peak of a
 *  pre-limiter analyser window and you get the GR meter reading for free.
 *  Input beyond the curve domain (|x| > 1) clamps to the curve's end value
 *  (WaveShaper spec), so reduction keeps growing with the input level. */
export function softLimiterReductionDb(peak) {
  const p = Math.abs(Number(peak) || 0);
  if (p <= SOFT_KNEE) return 0;
  const span = SOFT_CEIL - SOFT_KNEE;
  const out = SOFT_KNEE + span * Math.tanh((Math.min(p, 1) - SOFT_KNEE) / span);
  return 20 * Math.log10(p / out);
}
