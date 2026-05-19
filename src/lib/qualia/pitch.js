// Monophonic pitch detector — time-domain autocorrelation.
//
// Used by the vocoder's harmonizer "track" mode (the Prismizer / extreme-
// autotune effect): the singer's fundamental is detected every frame, snapped
// to the chosen key, and the carrier chord is voiced around it.
//
// The lag search is bounded to a vocal range so the O(n·lag) inner loop stays
// cheap enough to run ~30×/sec on a phone. A short-lag bias guards against the
// classic autocorrelation octave-down error (a strong peak also sits at twice
// the true period).

/**
 * @param {Float32Array} buf  time-domain samples (−1..1)
 * @param {number} sampleRate
 * @param {number} fMin  lowest fundamental to consider (Hz)
 * @param {number} fMax  highest fundamental to consider (Hz)
 * @returns {number} fundamental frequency in Hz, or -1 if unvoiced/too quiet
 */
export function autoCorrelate(buf, sampleRate, fMin = 70, fMax = 1100) {
  const SIZE = buf.length;

  // Mean square — the voiced-signal floor AND the normalisation reference.
  let ms = 0;
  for (let i = 0; i < SIZE; i++) ms += buf[i] * buf[i];
  ms /= SIZE;
  if (ms < 2.5e-5) return -1;            // ≈ rms < 0.005: silence / unvoiced

  const minLag = Math.max(2, Math.floor(sampleRate / fMax));
  const maxLag = Math.min(SIZE - 1, Math.ceil(sampleRate / fMin));
  if (maxLag <= minLag) return -1;

  // Normalised autocorrelation: each lag's MEAN product divided by the mean
  // square, so the values sit near [-1, 1] regardless of input LEVEL — the
  // confidence test below is then meaningful for a quiet mic too. (Comparing
  // the raw, un-normalised sum against an absolute threshold only ever
  // cleared for a very loud signal, so the tracker produced no pitch.)
  const corr = new Float32Array(maxLag + 2);
  let best = -1, bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const n = SIZE - lag;
    for (let i = 0; i < n; i++) sum += buf[i] * buf[i + lag];
    const c = (sum / n) / ms;
    corr[lag] = c;
    if (c > bestVal) { bestVal = c; best = lag; }
  }
  if (best < 0 || bestVal < 0.4) return -1;   // not periodic enough to call

  // Octave-error guard: prefer the first solid local maximum (shortest lag =
  // highest pitch) within 90% of the global best, rather than a sub-octave
  // peak that happens to edge it out.
  const thresh = bestVal * 0.9;
  for (let lag = minLag + 1; lag < best; lag++) {
    if (corr[lag] >= thresh && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      best = lag;
      break;
    }
  }

  // Parabolic interpolation around the chosen peak for sub-sample accuracy.
  let T0 = best;
  const x1 = corr[best - 1] || bestVal;
  const x2 = corr[best];
  const x3 = corr[best + 1] || bestVal;
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = best - b / (2 * a);

  return sampleRate / T0;
}
