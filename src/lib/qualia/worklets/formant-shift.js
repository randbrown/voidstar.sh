// Formant-preserving polyphonic pitch shifter — AudioWorklet processor.
//
// One mono voice in, N pitch-shifted voices out (one per output channel).
// The harmonizer's "voice" engine uses this so a harmony stack keeps the
// singer's vocal identity instead of turning into chipmunk / monster — the
// failure mode of the plain granular shifter (pitch-shift.js), which is kept
// as the fallback when this worklet can't load.
//
// Algorithm — STFT phase vocoder with a stationary formant envelope:
//   1. Window + FFT one analysis frame (75 %-overlap, hop = N/4).
//   2. Per bin, recover the TRUE frequency from the inter-frame phase
//      advance (the phase-vocoder step — this is what keeps it from sounding
//      granular/warbly).
//   3. Estimate the spectral envelope (formants) by box-smoothing the
//      magnitude spectrum, and flatten it out: excitation = |X| / envelope.
//   4. Per output voice, pitch-shift the EXCITATION by remapping bin k → k·r,
//      then re-apply the envelope read at its ORIGINAL place. The harmonic
//      structure moves with the pitch; the formants stay put → preserved
//      vocal identity. A global `formant` control resamples the envelope on
//      re-apply so the timbre can be shifted independently of pitch.
//   5. Accumulate synthesis phase from the shifted true frequency, IFFT,
//      window, overlap-add.
//
// Quality is "good harmony layer", not "studio" — the box-smoothed envelope
// is coarser than a cepstral/LPC one, and very large shifts still colour the
// tone. Latency ≈ one FFT frame (~43 ms @ 48 kHz).
//
// Messages (port): { ratios:[r,...] } per-voice pitch ratio (≤0 = voice off,
// skipped for CPU); { formant:semitones } global formant shift (−12..+12).

const FFT_SIZE = 2048;             // analysis/synthesis frame
const HOP      = FFT_SIZE / 4;     // 75 % overlap
const BINS     = FFT_SIZE / 2 + 1; // half spectrum (+ Nyquist)
const RING     = FFT_SIZE * 2;     // per-voice output ring buffer
// Hann² overlap-added at hop = N/4 sums to a constant 1.5 — undo it so the
// shifter is unity-gain at ratio 1.
const COLA_SCALE = 1 / 1.5;
const ENV_HALF = 12;               // formant-envelope box-smoothing half-width (bins)

// In-place iterative radix-2 Cooley–Tukey FFT over separate re/im arrays.
// `inverse` also applies the 1/n normalisation.
function fft(re, im, inverse) {
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
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr;        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// Wrap a phase to (−π, π].
function wrapPhase(p) {
  return p - 2 * Math.PI * Math.round(p / (2 * Math.PI));
}

class FormantShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = options?.processorOptions || {};
    this.voices = Math.max(1, Math.min(8, opt.voices | 0 || 5));

    // Hann window, shared by analysis and synthesis.
    this.win = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_SIZE);
    }
    // Expected per-hop phase advance for each bin (the bin's own frequency).
    this.binOmega = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) {
      this.binOmega[k] = 2 * Math.PI * HOP * k / FFT_SIZE;
    }

    // Rolling input window — always the latest FFT_SIZE samples.
    this.inBuf = new Float32Array(FFT_SIZE);
    this.sinceFrame = 0;

    // FFT scratch + analysis results.
    this.fr = new Float32Array(FFT_SIZE);
    this.fi = new Float32Array(FFT_SIZE);
    this.mag = new Float32Array(BINS);
    this.trueFreq = new Float32Array(BINS);   // per-bin true frequency, in bins
    this.lastPhase = new Float32Array(BINS);
    this.env = new Float32Array(BINS);        // formant envelope
    this.excite = new Float32Array(BINS);     // envelope-flattened magnitude
    this.envCdf = new Float32Array(BINS + 1); // prefix sum for box smoothing

    // Per-voice synthesis state.
    this.ratios   = new Float32Array(this.voices).fill(1);
    this.active   = new Array(this.voices).fill(false);
    this.sumPhase = [];   // accumulated synthesis phase per bin
    this.oAcc     = [];   // overlap-add accumulator (FFT_SIZE)
    this.outRing  = [];   // emitted-sample ring buffer
    for (let v = 0; v < this.voices; v++) {
      this.sumPhase.push(new Float32Array(BINS));
      this.oAcc.push(new Float32Array(FFT_SIZE));
      this.outRing.push(new Float32Array(RING));
    }
    this.outRead = 0; this.outWrite = 0; this.outAvail = 0;

    this.formantRatio = 1;   // 2^(semitones/12)

    this.synMag  = new Float32Array(BINS);
    this.synFreq = new Float32Array(BINS);

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (Array.isArray(d.ratios)) {
        for (let v = 0; v < this.voices; v++) {
          const r = +d.ratios[v];
          if (r > 0 && isFinite(r)) { this.ratios[v] = r; this.active[v] = true; }
          else                     { this.active[v] = false; }
        }
      }
      if (typeof d.formant === 'number' && isFinite(d.formant)) {
        this.formantRatio = Math.pow(2, Math.max(-12, Math.min(12, d.formant)) / 12);
      }
    };
  }

  // Estimate the formant envelope: box-smooth the magnitude spectrum over a
  // window wide enough to bridge the harmonic ripple but keep the formant
  // peaks. Prefix-sum so it stays O(bins).
  computeEnvelope() {
    const cdf = this.envCdf, mag = this.mag, env = this.env;
    cdf[0] = 0;
    for (let k = 0; k < BINS; k++) cdf[k + 1] = cdf[k] + mag[k];
    for (let k = 0; k < BINS; k++) {
      const lo = Math.max(0, k - ENV_HALF);
      const hi = Math.min(BINS - 1, k + ENV_HALF);
      env[k] = (cdf[hi + 1] - cdf[lo]) / (hi - lo + 1) + 1e-6;
      this.excite[k] = mag[k] / env[k];
    }
  }

  // Sample the envelope at fractional bin `pos`, with linear interpolation.
  envAt(pos) {
    if (pos <= 0) return this.env[0];
    if (pos >= BINS - 1) return this.env[BINS - 1];
    const i = pos | 0, f = pos - i;
    return this.env[i] * (1 - f) + this.env[i + 1] * f;
  }

  // One STFT hop: analyse the current input window, synthesise every active
  // voice, and push HOP output samples per voice into the ring.
  runFrame() {
    const { fr, fi, win, mag, trueFreq, lastPhase, binOmega } = this;

    // ── Analysis ──────────────────────────────────────────────────────
    for (let i = 0; i < FFT_SIZE; i++) { fr[i] = this.inBuf[i] * win[i]; fi[i] = 0; }
    fft(fr, fi, false);
    for (let k = 0; k < BINS; k++) {
      const re = fr[k], im = fi[k];
      mag[k] = Math.sqrt(re * re + im * im);
      const phase = Math.atan2(im, re);
      // True frequency (in bins) from the deviation of the measured phase
      // advance off the bin's expected advance.
      const dev = wrapPhase(phase - lastPhase[k] - binOmega[k]);
      trueFreq[k] = k + dev * FFT_SIZE / (2 * Math.PI * HOP);
      lastPhase[k] = phase;
    }
    this.computeEnvelope();

    // ── Synthesis, per voice ──────────────────────────────────────────
    const { synMag, synFreq, excite } = this;
    for (let v = 0; v < this.voices; v++) {
      const oAcc = this.oAcc[v];
      if (!this.active[v]) {
        // Voice off — still advance the overlap-add buffer so re-enabling it
        // doesn't replay stale tail samples.
        oAcc.copyWithin(0, HOP);
        oAcc.fill(0, FFT_SIZE - HOP);
        this.writeRing(v, oAcc, true);
        continue;
      }
      const r = this.ratios[v];
      const sumPhase = this.sumPhase[v];
      synMag.fill(0);
      for (let k = 0; k < BINS; k++) synFreq[k] = k;   // empty bins keep natural freq

      // Pitch-shift the excitation: bin k of the source maps to bin k·r.
      for (let k = 0; k < BINS; k++) {
        const k2 = Math.round(k * r);
        if (k2 < 0 || k2 >= BINS) continue;
        synMag[k2] += excite[k];
        synFreq[k2] = trueFreq[k] * r;
      }

      // Re-apply the (optionally formant-shifted) envelope, accumulate the
      // synthesis phase, and build the complex spectrum.
      fr.fill(0); fi.fill(0);
      for (let k = 0; k < BINS; k++) {
        // Wrap the accumulator every hop. cos/sin are periodic so the wrap is
        // exact, but an unbounded float32 sum (~10^4/s at high bins) loses ULP
        // precision after tens of minutes and rots the harmonies mid-set.
        sumPhase[k] = wrapPhase(sumPhase[k] + 2 * Math.PI * HOP * synFreq[k] / FFT_SIZE);
        if (synMag[k] <= 0) continue;
        const amp = synMag[k] * this.envAt(k / this.formantRatio);
        const ph = sumPhase[k];
        fr[k] = amp * Math.cos(ph);
        fi[k] = amp * Math.sin(ph);
        if (k > 0 && k < FFT_SIZE - k) {       // mirror for a real IFFT
          fr[FFT_SIZE - k] = fr[k];
          fi[FFT_SIZE - k] = -fi[k];
        }
      }
      fft(fr, fi, true);

      // Window + overlap-add, then emit the leading HOP samples.
      for (let i = 0; i < FFT_SIZE; i++) oAcc[i] += fr[i] * win[i] * COLA_SCALE;
      this.writeRing(v, oAcc, false);
      oAcc.copyWithin(0, HOP);
      oAcc.fill(0, FFT_SIZE - HOP);
    }
    // Every voice emitted HOP samples in lockstep.
    this.outWrite = (this.outWrite + HOP) % RING;
    this.outAvail += HOP;
  }

  // Copy the leading HOP samples of a voice's overlap-add buffer into its
  // ring (silence when the voice is off). The shared write pointer is only
  // advanced once per frame by runFrame().
  writeRing(v, oAcc, silent) {
    const ring = this.outRing[v];
    let w = this.outWrite;
    for (let i = 0; i < HOP; i++) {
      ring[w] = silent ? 0 : oAcc[i];
      w = (w + 1) % RING;
    }
  }

  process(inputs, outputs) {
    const inCh = inputs[0] && inputs[0][0];
    const out = outputs[0];
    const n = out[0] ? out[0].length : 128;

    // Roll the newest n samples into the analysis window.
    this.inBuf.copyWithin(0, n);
    if (inCh) {
      this.inBuf.set(inCh, FFT_SIZE - n);
    } else {
      this.inBuf.fill(0, FFT_SIZE - n);
    }

    // A frame becomes due every HOP samples (HOP is a multiple of the 128
    // render quantum, so this fires cleanly).
    this.sinceFrame += n;
    while (this.sinceFrame >= HOP) {
      this.sinceFrame -= HOP;
      this.runFrame();
    }

    // Drain n samples per voice from the rings (zeros during the initial
    // one-frame fill latency).
    if (this.outAvail >= n) {
      for (let v = 0; v < this.voices; v++) {
        const ring = this.outRing[v];
        const ch = out[v];
        if (!ch) continue;
        let rd = this.outRead;
        for (let i = 0; i < n; i++) { ch[i] = ring[rd]; rd = (rd + 1) % RING; }
      }
      this.outRead = (this.outRead + n) % RING;
      this.outAvail -= n;
    } else {
      for (let v = 0; v < this.voices; v++) if (out[v]) out[v].fill(0);
    }
    return true;
  }
}

registerProcessor('formant-shift', FormantShiftProcessor);
