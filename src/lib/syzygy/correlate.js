// syzygy — transient cross-correlation ("align by matching sound").
//
// Pure DSP, no ffmpeg, no DOM — node-testable like plan.js/meta.js. The
// pipeline: mono PCM → onset-novelty envelope (half-rectified log-energy
// difference, the thing that spikes on transients and ignores steady tone)
// → FFT cross-correlation → peak with parabolic sub-frame interpolation and
// a robust z-score confidence (peak height vs the median/MAD of the whole
// correlation function).
//
// Sign convention, used everywhere: `lagSec` is where the signal's t=0 sits
// on the reference's timeline — an event at sig time t appears in ref at
// t + lag. With ref = the video's own audio and sig = the replacement
// recording, lag IS the app's alignment offset.

/**
 * Onset-novelty envelope of mono PCM.
 * @param {Float32Array} pcm
 * @param {number} pcmRate
 * @param {number} envRate  target envelope rate (Hz); actual is returned
 * @returns {{env: Float64Array, rate: number}}
 */
export function onsetEnvelope(pcm, pcmRate, envRate) {
  const frame = Math.max(1, Math.round(pcmRate / envRate));
  const n = Math.floor(pcm.length / frame);
  const env = new Float64Array(n);
  let prev = null; // frame 0 has no predecessor → no novelty (a fake spike
                   // there would correlate every pair of tracks at lag 0)
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const base = i * frame;
    for (let j = 0; j < frame; j++) {
      const v = pcm[base + j];
      acc += v * v;
    }
    const e = Math.log10(Math.sqrt(acc / frame) + 1e-6);
    env[i] = prev === null ? 0 : Math.max(0, e - prev); // half-rectified: onsets only
    prev = e;
  }
  // z-normalize (also removes the mean so the FFT correlation is unbiased)
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n || 1;
  let varAcc = 0;
  for (let i = 0; i < n; i++) { const d = env[i] - mean; varAcc += d * d; }
  const std = Math.sqrt(varAcc / (n || 1));
  if (std > 1e-9) {
    for (let i = 0; i < n; i++) env[i] = (env[i] - mean) / std;
  } else {
    env.fill(0); // silence — caller sees a flat correlation and low z
  }
  return { env, rate: pcmRate / frame };
}

/** In-place iterative radix-2 FFT (sign=-1) / IFFT (sign=+1, unscaled). */
function fft(re, im, sign) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = sign * 2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = i + j + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Cross-correlate two envelopes and find the best lag.
 * c[ℓ] = Σ ref[i]·sig[i−ℓ], ℓ ∈ [−(m−1), n−1], computed via FFT.
 *
 * @param {Float64Array} ref
 * @param {Float64Array} sig
 * @param {number} rate     envelope rate (Hz)
 * @param {{minLagSec?:number, maxLagSec?:number}} [opts]  restrict the search
 * @returns {{lagSec:number, z:number}}
 */
export function estimateLag(ref, sig, rate, opts = {}) {
  const n = ref.length, m = sig.length;
  if (!n || !m) return { lagSec: 0, z: 0 };
  let N = 1;
  while (N < n + m) N <<= 1;
  const are = new Float64Array(N), aim = new Float64Array(N);
  const bre = new Float64Array(N), bim = new Float64Array(N);
  are.set(ref); bre.set(sig);
  fft(are, aim, -1);
  fft(bre, bim, -1);
  for (let i = 0; i < N; i++) { // A · conj(B)
    const rr = are[i] * bre[i] + aim[i] * bim[i];
    const ii = aim[i] * bre[i] - are[i] * bim[i];
    are[i] = rr; aim[i] = ii;
  }
  fft(are, aim, 1); // unscaled inverse; scale is irrelevant for peak/z

  // circular index k ↔ lag ℓ: ℓ = k for k ≤ n−1, ℓ = k − N for k ≥ N−(m−1)
  const lo = opts.minLagSec !== undefined ? Math.ceil(opts.minLagSec * rate) : -(m - 1);
  const hi = opts.maxLagSec !== undefined ? Math.floor(opts.maxLagSec * rate) : n - 1;
  const c = (lag) => are[(lag + N) % N];

  const loLag = Math.max(lo, -(m - 1));
  const hiLag = Math.min(hi, n - 1);
  let peakLag = 0, peakVal = -Infinity;
  const vals = [];
  for (let lag = loLag; lag <= hiLag; lag++) {
    const v = c(lag);
    vals.push(v);
    if (v > peakVal) { peakVal = v; peakLag = lag; }
  }
  if (!vals.length) return { lagSec: 0, z: 0, ratio: 0 };

  // robust confidence: peak height in MAD units above the median
  const sorted = Float64Array.from(vals).sort();
  const median = sorted[sorted.length >> 1];
  const devs = Float64Array.from(vals, (v) => Math.abs(v - median)).sort();
  const mad = devs[devs.length >> 1] || 1e-12;
  const z = (peakVal - median) / (1.4826 * mad);

  // MAD-z alone over-trusts sparse envelopes (one chance coincidence towers
  // over a near-zero MAD), so also demand the peak dominate the SECOND best
  // peak outside a ±1s exclusion zone. A real alignment stacks every
  // transient at one lag; chance alignments have rivals of similar height.
  const excl = Math.ceil(rate * 1.0);
  let second = -Infinity;
  for (let lag = loLag; lag <= hiLag; lag++) {
    if (Math.abs(lag - peakLag) <= excl) continue;
    const v = c(lag);
    if (v > second) second = v;
  }
  const ratio = Number.isFinite(second) && second > median
    ? (peakVal - median) / (second - median)
    : (Number.isFinite(second) ? 99 : 0);

  // parabolic interpolation for sub-frame precision
  let frac = 0;
  const cm = c(peakLag - 1), cp = c(peakLag + 1);
  const denom = cm - 2 * peakVal + cp;
  if (peakLag > -(m - 1) && peakLag < n - 1 && Math.abs(denom) > 1e-12) {
    frac = Math.max(-0.5, Math.min(0.5, 0.5 * (cm - cp) / denom));
  }
  return { lagSec: (peakLag + frac) / rate, z, ratio };
}

/**
 * Convenience: PCM in, lag out.
 * @param {Float32Array} refPcm  reference (the video's own audio)
 * @param {Float32Array} sigPcm  signal (the replacement recording)
 * @param {number} pcmRate
 * @param {{envRate?:number, minLagSec?:number, maxLagSec?:number}} [opts]
 * @returns {{lagSec:number, z:number}}
 */
export function correlatePcm(refPcm, sigPcm, pcmRate, opts = {}) {
  const envRate = opts.envRate || 50;
  const a = onsetEnvelope(refPcm, pcmRate, envRate);
  const b = onsetEnvelope(sigPcm, pcmRate, envRate);
  return estimateLag(a.env, b.env, a.rate, opts);
}

/** Human label for a match, from both confidence metrics. */
export function confidenceLabel(z, ratio) {
  if (z >= 10 && ratio >= 2) return 'strong';
  if (z >= 6 && ratio >= 1.5) return 'ok';
  return 'weak';
}

/** Below these the match is considered noise, not a real alignment. */
export const MIN_COARSE_Z = 4.5;
export const MIN_PEAK_RATIO = 1.3;
