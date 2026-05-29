// Slurm chopper — rhythmic granular stutter AudioWorklet processor for the
// slurmcore qfx. This is the DSP heart of the first audio-EFFECTING quale:
// it turns whatever's playing in the lab into chopped, repeating "Slurms".
//
// Model (deliberately simple + robust, tuned for the slurmcore aesthetic):
//   - We keep a rolling ring buffer of the most recent input samples.
//   - The main thread's lookahead scheduler posts a sample-accurate `trigger`
//     for each beat-grid slot: { frame, grainFrames, rate, gate }.
//   - On reaching `frame` (compared against the AudioWorkletGlobalScope
//     `currentFrame` clock, so lookahead-posted triggers fire at the RIGHT
//     time, not on message arrival), we freeze the most-recent `grainFrames`
//     samples into a grain and loop it continuously until the next trigger.
//   - A short grain looped many times within one grid slot = stutter; a grain
//     as long as the whole slot = a clean time-quantised chop. `grainFrames`
//     is derived on the main thread from the `stutter` param.
//   - `rate` is the read-pointer speed = 2^(pitch/12): the slurm's pitch.
//   - `gate` is an RMS floor — grains quieter than it stay silent, so silence
//     between phrases doesn't get chopped into buzzing.
//
// Mono in / mono out (downmixes by processing channel 0 and fanning the
// result to any extra output channels). The dry/wet blend lives in GainNodes
// outside the worklet, mirroring how voice-shifter keeps mixing in WebAudio.

// Seconds of input history to retain. Two seconds is comfortably longer than
// any plausible grid slot, so a grain capture never underflows.
const RING_SECONDS = 2;

class SlurmChopProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringLen  = Math.max(1, Math.ceil(sampleRate * RING_SECONDS));
    this.ring     = new Float32Array(this.ringLen);
    this.writePos = 0;

    // Frozen grain currently looping. Sized to the ring so a full-slot grain
    // (stutter = 0) always fits.
    this.grain    = new Float32Array(this.ringLen);
    this.grainLen = 0;
    this.readPos  = 0;

    this.rate       = 1;
    this.gateThresh = 0;
    this.playing    = false;

    // Pending triggers, in monotonically increasing `frame` order (the
    // scheduler only ever posts forward in time).
    this.pending = [];

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'trigger') {
        this.pending.push({
          frame:      d.frame | 0,
          grainFrames: Math.max(1, d.grainFrames | 0),
          rate:       (+d.rate  > 0 && isFinite(+d.rate)) ? +d.rate : 1,
          gate:        +d.gate || 0,
        });
      } else if (d.type === 'reset') {
        this.pending.length = 0;
        this.playing = false;
        this.grainLen = 0;
      }
    };
  }

  // Freeze the most-recent `grainFrames` samples (ending at the current write
  // head) into the grain buffer, and decide whether the slot is loud enough
  // to sound (gate).
  captureGrain(grainFrames) {
    const gl = Math.min(grainFrames, this.ringLen);
    let start = this.writePos - gl;
    while (start < 0) start += this.ringLen;
    let sumSq = 0;
    for (let i = 0; i < gl; i++) {
      const v = this.ring[(start + i) % this.ringLen];
      this.grain[i] = v;
      sumSq += v * v;
    }
    this.grainLen = gl;
    this.readPos  = 0;
    const rms = Math.sqrt(sumSq / Math.max(1, gl));
    this.playing = rms >= this.gateThresh;
  }

  process(inputs, outputs) {
    const inCh  = inputs[0] && inputs[0][0];
    const out   = outputs[0];
    const outCh = out && out[0];
    const n     = outCh ? outCh.length : 128;
    const base  = currentFrame; // global sample clock for this render block

    for (let i = 0; i < n; i++) {
      // Always record input into the ring so a future grain can grab it.
      this.ring[this.writePos] = inCh ? inCh[i] : 0;
      this.writePos = (this.writePos + 1) % this.ringLen;

      // Fire any trigger whose target frame we've now reached. Sample-accurate
      // because we compare against base + i, not message-arrival time.
      const fi = base + i;
      while (this.pending.length && fi >= this.pending[0].frame) {
        const t = this.pending.shift();
        this.rate       = t.rate;
        this.gateThresh = t.gate;
        this.captureGrain(t.grainFrames);
      }

      let y = 0;
      if (this.playing && this.grainLen > 0) {
        const ip = this.readPos | 0;
        const f  = this.readPos - ip;
        const a  = this.grain[ip % this.grainLen];
        const b  = this.grain[(ip + 1) % this.grainLen];
        y = a + (b - a) * f; // linear interp for the pitch read
        this.readPos += this.rate;
        if (this.readPos >= this.grainLen) this.readPos -= this.grainLen;
      }
      if (outCh) outCh[i] = y;
    }

    // Fan mono result out to any extra channels (stereo file input, etc).
    if (out && outCh) {
      for (let c = 1; c < out.length; c++) if (out[c]) out[c].set(outCh);
    }
    return true;
  }
}

registerProcessor('slurm-chop', SlurmChopProcessor);
