// Spring reverb impulse response — a synthesized two-spring tank (the long-decay
// Type 4 pan a Twin Reverb carries), built once per decay setting and played by
// a ConvolverNode in the rig strip's `spring` stage (pre-amp, like the real amp).
//
// Why synthesize instead of reusing the room reverb's decaying noise: a spring's
// voice is its DISPERSION. Below the spring's transition frequency, low
// frequencies travel more slowly along the helix than highs, so every arrival is
// a descending chirp (the "pew" you hear tapping a tank), and every round trip
// smears it further. White noise has none of that — it's a plate/hall wash.
//
// Model (per spring), built in the frequency domain and inverse-FFT'd:
//   - one traversal of the spring = a dispersive delay: group delay
//       τ(f) = tHi + D · f0 / (f + f0)
//     (longest at DC, settling to tHi up top), so the phase is the integral
//       φ(f) = −2π [ tHi·f + D·f0·ln(1 + f/f0) ]
//   - per-traversal loss |L(f)| = 10^(−3·τ(f) / RT60(f)), with highs dying
//     faster (RT60 falls with frequency) — that sets the decay knob exactly
//   - transducer → spring → pickup: the first arrival is one traversal, then a
//     reflection every round trip (two traversals). The whole echo train is a
//     geometric series, summed in closed form:
//       H(f) = E(f) / (1 − E(f)²),   E(f) = L(f)·e^{jφ(f)}
//   - the pan's band limit: a ~110 Hz high-pass and a steep ~4.6 kHz low-pass
//     (magnitude only), the range a real tank actually passes.
// Two springs with different lengths (and opposite polarity, so their low-end
// modes don't stack) are summed. The FFT is sized at ≥2× the RT60, so the
// closed-form's infinite tail wraps around below −120 dB before it's truncated.
//
// Pure math, no Web Audio — so scripts/check-qualia-spring.mjs can verify it in
// node (decay rate, chirp direction, band limit, determinism).

export const SPRING_DECAY_MIN = 0.5;
export const SPRING_DECAY_MAX = 5;

// The two springs: first-arrival (one traversal) delay in seconds, relative
// dispersion depth, and mix weight/polarity. Delays match the spec-sheet
// delay times of a long two-spring pan (≈33 ms / ≈41 ms).
const SPRINGS = [
  { t1: 0.0335, disp: 0.42, w:  0.55 },
  { t1: 0.0412, disp: 0.36, w: -0.45 },
];
const F0 = 650;          // Hz — dispersion knee (where the chirp sweeps hardest)
const HP_HZ = 110;       // transducer/pickup low cut
const LP_HZ = 4600;      // spring transition — almost nothing passes above
const HF_DAMP_HZ = 2600; // RT60 halves here: highs decay faster than lows

const clampDecay = (d) => Math.max(SPRING_DECAY_MIN, Math.min(SPRING_DECAY_MAX, Number(d) || 0));

/** IR length in samples for a decay — exposed so the check can assert it. */
export function springIRLength(sampleRate, decay) {
  return Math.ceil(sampleRate * (clampDecay(decay) * 1.1 + 0.1));
}

/**
 * Build the spring IR as a mono Float32Array at `sampleRate`.
 * Deterministic (no randomness) — the same decay always gives the same tank.
 */
export function buildSpringIR(sampleRate, decay) {
  const sr = sampleRate > 0 ? sampleRate : 48000;
  const rt60 = clampDecay(decay);
  // ≥ 2·RT60 of headroom (plus the dispersion's extra low-frequency delay) so
  // the circular wrap of the closed-form series sits under −120 dB.
  let N = 1;
  while (N < sr * (2 * rt60 + 0.4)) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const half = N >> 1;
  const df = sr / N;

  for (let k = 0; k <= half; k++) {
    const f = k * df;
    // Band limit of the pan (zero-phase magnitude): 2nd-order HP, 8th-order LP.
    const hp = (f * f) / Math.sqrt(f ** 4 + HP_HZ ** 4 || 1);
    const lp = 1 / Math.sqrt(1 + (f / LP_HZ) ** 16);
    const band = hp * lp;
    const rtF = rt60 / (1 + (f / HF_DAMP_HZ) ** 2);
    let hr = 0, hi = 0;
    for (const s of SPRINGS) {
      const D = s.t1 * s.disp;
      const tHi = s.t1 - D * F0 / (1000 + F0);   // τ(1 kHz) = t1, the spec delay
      const tau = tHi + D * F0 / (f + F0);
      const phi = -2 * Math.PI * (tHi * f + D * F0 * Math.log1p(f / F0));
      const mag = Math.pow(10, -3 * tau / rtF);
      // E = mag·e^{jφ};  H = E / (1 − E²)
      const er = mag * Math.cos(phi), ei = mag * Math.sin(phi);
      const e2r = er * er - ei * ei, e2i = 2 * er * ei;
      const dr = 1 - e2r, di = -e2i;
      const den = dr * dr + di * di || 1e-30;
      hr += s.w * (er * dr + ei * di) / den;
      hi += s.w * (ei * dr - er * di) / den;
    }
    re[k] = hr * band; im[k] = hi * band;
  }
  // Hermitian mirror → real time-domain response.
  im[0] = 0; im[half] = 0;
  for (let k = 1; k < half; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
  fft(re, im, true);

  const len = Math.min(N, springIRLength(sr, rt60));
  const out = new Float32Array(len);
  // Cosine fade over the last 15% so truncation never clicks.
  const fadeStart = Math.floor(len * 0.85);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    let v = re[i];
    if (i >= fadeStart) v *= 0.5 * (1 + Math.cos(Math.PI * (i - fadeStart) / (len - fadeStart)));
    out[i] = v;
    const a = Math.abs(v); if (a > peak) peak = a;
  }
  // Peak-normalise. The ConvolverNode's own normalisation then sets the level;
  // this just keeps the buffer in a sane float range.
  if (peak > 0) for (let i = 0; i < len; i++) out[i] /= peak;
  return out;
}

// In-place iterative radix-2 FFT. `inverse` scales by 1/N.
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const ang = sign * 2 * Math.PI / size;
    const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
    for (let start = 0; start < n; start += size) {
      let wr = 1, wi = 0;
      for (let k = 0; k < halfSize; k++) {
        const a = start + k, b = a + halfSize;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0; wr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
