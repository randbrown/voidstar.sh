// Lookahead brickwall limiter — AudioWorklet processor (LoudMax-style).
//
// Why: the old limiters bent the WAVEFORM. The rig's soft-clip WaveShaper is a
// memoryless tanh curve that starts shaping at -6 dBFS, so a boosted rig spent
// most of its time being saturated (harmonics + intermod, un-oversampled so it
// aliases too). The bus DynamicsCompressors run a 1 ms attack / 100 ms release
// at ratio 20 with no true hold, so on bass the gain wobbles inside a single
// cycle (= distortion) and fast transients still overshoot the ceiling.
//
// This one never touches the waveform shape. It delays the audio by a few ms,
// looks at what's coming, and rides a smooth GAIN envelope so the peak lands
// exactly on the ceiling. Pipeline per sample (stereo-linked):
//
//   need[n] = min(1, ceiling / peak(x[n]))         gain this sample needs
//   hold[n] = min(need[n-L+1 .. n])                sliding-window minimum
//   rel[n]  = hold < rel ? hold : rel → hold (1-pole release, smooth recovery)
//   g[n]    = box(L1) ∘ box(L2) of rel             S-curve attack ramp
//   y[n]    = x[n-(L-1)] · g[n]                    audio delayed by L-1
//
// The two boxes span L1+L2-1 = L samples, so every term averaged into g[n] is
// a hold value whose window contains input sample n-L+1 — i.e. g[n] is never
// above the gain that sample needs. That makes it a TRUE (sample-peak)
// brickwall with zero clipping, while the gain itself only ever moves along a
// smooth ramp spread over the lookahead window (no in-cycle modulation).
//
// "Off" is transparent by envelope, not rerouting: need[] goes to 1, the gain
// releases smoothly back to unity, and the delay stays constant — so toggling
// never clicks and the latency never jumps.
//
// Messages in  (port): { engaged?: bool, ceilingDb?: number, releaseMs?: number }
// Messages out (port): { gr: dB }  — peak gain reduction over the last ~20 ms,
//                      posted only while reducing (plus one 0 when it stops).
//
// The DSP lives in LookaheadLimiterCore (no worklet globals) so
// scripts/check-qualia-limiter.mjs can drive the real code in node (it reaches
// the class through the registered processor's `.core`). No `export`s: Tone's
// standardized-audio-context loads worklet modules as classic scripts.

const DEFAULT_CEILING_DB = -1.0;

class LookaheadLimiterCore {
  /**
   * @param {number} sr          sample rate
   * @param {object} [o]
   * @param {number} [o.lookaheadMs=5]   lookahead (= added latency)
   * @param {number} [o.releaseMs=120]   release time constant
   * @param {number} [o.ceilingDb=-1]    output ceiling (sample peak)
   * @param {boolean} [o.engaged=true]
   * @param {number} [o.channels=2]
   */
  constructor(sr, o = {}) {
    this.sr = sr;
    this.channels = Math.max(1, o.channels | 0 || 2);
    const la = Math.max(0.1, Math.min(20, Number(o.lookaheadMs ?? 5)));
    // L ≥ 3 so both boxes have length ≥ 1 and there's a real ramp.
    this.L = Math.max(3, Math.round((la / 1000) * sr) + 1);
    this.latency = this.L - 1;                      // samples of audio delay
    this.L1 = Math.max(1, (this.L + 1) >> 1);
    this.L2 = this.L + 1 - this.L1;                 // L1 + L2 - 1 === L

    // audio delay lines (ring of L-1 samples, per channel)
    this.dl = [];
    for (let c = 0; c < this.channels; c++) this.dl.push(new Float32Array(this.latency));
    this.dlPos = 0;

    // sliding-min deque over `need` (monotonic: values increasing front→back)
    this.qCap = this.L + 1;
    this.qVal = new Float64Array(this.qCap);
    this.qIdx = new Float64Array(this.qCap);
    this.qHead = 0; this.qLen = 0;
    this.n = 0;                                     // running sample counter

    // two cascaded moving averages (rings + running sums)
    this.b1 = new Float64Array(this.L1).fill(1); this.b1Pos = 0; this.b1Sum = this.L1;
    this.b2 = new Float64Array(this.L2).fill(1); this.b2Pos = 0; this.b2Sum = this.L2;

    this.rel = 1;
    this.setRelease(o.releaseMs ?? 120);
    this.setCeilingDb(o.ceilingDb ?? DEFAULT_CEILING_DB);
    this.engaged = o.engaged !== false;
    this.safetyClamp = o.safetyClamp !== false;     // float-rounding insurance (tests turn it off)
    this.minGain = 1;                               // lowest gain since last read (meter)
  }

  setRelease(ms) {
    const t = Math.max(1, Number(ms) || 120) / 1000;
    this.relCoef = 1 - Math.exp(-1 / (t * this.sr));
  }
  setCeilingDb(db) {
    const d = Math.min(0, Number.isFinite(Number(db)) ? Number(db) : DEFAULT_CEILING_DB);
    this.ceiling = Math.pow(10, d / 20);
  }
  setEngaged(on) { this.engaged = !!on; }

  /** Take (and reset) the peak gain reduction in dB since the last call. */
  takeReductionDb() {
    const g = this.minGain;
    this.minGain = 1;
    return g < 1 ? -20 * Math.log10(g) : 0;
  }

  /**
   * Process one block. `inp`/`out` are arrays of Float32Array channel buffers
   * (a missing / short input channel reads as silence; mono input is
   * duplicated across outputs by the caller via channelInterpretation).
   */
  process(inp, out, frames) {
    const C = this.channels, L = this.L, ceil = this.ceiling, eng = this.engaged;
    const D = this.latency, dl = this.dl;
    const qVal = this.qVal, qIdx = this.qIdx, qCap = this.qCap;
    const b1 = this.b1, b2 = this.b2, L1 = this.L1, L2 = this.L2;
    const relCoef = this.relCoef, clamp = eng && this.safetyClamp;
    let { dlPos, qHead, qLen, n, b1Pos, b1Sum, b2Pos, b2Sum, rel, minGain } = this;

    for (let i = 0; i < frames; i++, n++) {
      // ── detect (stereo-linked sample peak) ──
      let peak = 0;
      for (let c = 0; c < C; c++) {
        const ch = inp[c];
        let x = ch && i < ch.length ? ch[i] : 0;
        if (x !== x || x === Infinity || x === -Infinity) { x = 0; if (ch) ch[i] = 0; } // NaN/Inf guard
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
      }
      const need = (eng && peak > ceil) ? ceil / peak : 1;

      // ── sliding minimum over the last L `need` values ──
      while (qLen > 0 && qVal[(qHead + qLen - 1) % qCap] >= need) qLen--;
      const tail = (qHead + qLen) % qCap;
      qVal[tail] = need; qIdx[tail] = n; qLen++;
      if (qIdx[qHead] <= n - L) { qHead = (qHead + 1) % qCap; qLen--; }
      const hold = qVal[qHead];

      // ── release (instant down, smooth 1-pole up) ──
      rel = hold < rel ? hold : rel + (hold - rel) * relCoef;

      // ── two moving averages = S-curve attack across the lookahead ──
      b1Sum += rel - b1[b1Pos]; b1[b1Pos] = rel;
      if (++b1Pos === L1) { b1Pos = 0; b1Sum = 0; for (let k = 0; k < L1; k++) b1Sum += b1[k]; }
      const s1 = b1Sum / L1;
      b2Sum += s1 - b2[b2Pos]; b2[b2Pos] = s1;
      if (++b2Pos === L2) { b2Pos = 0; b2Sum = 0; for (let k = 0; k < L2; k++) b2Sum += b2[k]; }
      let g = b2Sum / L2;
      if (g > 1) g = 1;
      if (g < minGain) minGain = g;

      // ── delay + apply (final clamp is float-rounding insurance only) ──
      for (let c = 0; c < C; c++) {
        const ch = inp[c];
        const x = ch && i < ch.length ? ch[i] : 0;
        const line = dl[c];
        let d;
        if (D > 0) { d = line[dlPos]; line[dlPos] = x; } else d = x;
        let y = d * g;
        if (clamp) { if (y > ceil) y = ceil; else if (y < -ceil) y = -ceil; }
        const o = out[c];
        if (o) o[i] = y;
      }
      if (D > 0 && ++dlPos === D) dlPos = 0;
    }

    Object.assign(this, { dlPos, qHead, qLen, n, b1Pos, b1Sum, b2Pos, b2Sum, rel, minGain });
  }
}

const REPORT_FRAMES = 1024;   // ~21 ms @ 48 kHz between GR posts

class LookaheadLimiterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = (options && options.processorOptions) || {};
    const ch = (options && options.outputChannelCount && options.outputChannelCount[0]) || 2;
    this.core = new LookaheadLimiterCore(sampleRate, { ...po, channels: ch });
    this.sinceReport = 0;
    this.reporting = false;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if ('engaged' in m) this.core.setEngaged(m.engaged);
      if ('ceilingDb' in m) this.core.setCeilingDb(m.ceilingDb);
      if ('releaseMs' in m) this.core.setRelease(m.releaseMs);
      if (m.cmd === 'dispose') this.dead = true;
    };
  }

  process(inputs, outputs) {
    if (this.dead) return false;
    const out = outputs[0];
    const inp = inputs[0] || [];
    const frames = (out && out[0] && out[0].length) || 128;
    this.core.process(inp, out, frames);
    this.sinceReport += frames;
    if (this.sinceReport >= REPORT_FRAMES) {
      this.sinceReport = 0;
      const gr = this.core.takeReductionDb();
      if (gr > 0.01) { this.port.postMessage({ gr }); this.reporting = true; }
      else if (this.reporting) { this.port.postMessage({ gr: 0 }); this.reporting = false; }
    }
    return true;   // keep running: the delay line must keep flushing
  }
}

registerProcessor('lookahead-limiter', LookaheadLimiterProcessor);
