// PCM tap — AudioWorklet processor that copies its input (all channels) back to
// the main thread while armed, so a source (the rig) can be captured to raw
// Float32 PCM off the main thread. Deliberately tiny next to looper-recorder:
// no ring buffer, no retro grab — just an armed passthrough tap the stem
// recorder assembles into a WAV (and, optionally, transcodes to MP3).
//
// Batched: quanta accumulate into a fixed block and post ~7×/s (not per
// 128-frame quantum), so a multi-minute stem doesn't flood the message port or
// allocate on the audio thread every render quantum. `pause`/`stop` flush the
// partial block so nothing is dropped; a paused span simply isn't captured, so
// the stem stays gap-free and lines up with the (also-frozen) video take.

const BLOCK_FRAMES = 8192;   // ~170 ms @ 48 kHz per posted block

class PcmTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.channels = 0;
    this.buf = null;    // Float32Array[] accumulator (one per channel)
    this.fill = 0;      // frames written into the current block
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === 'start' || cmd === 'resume') this.armed = true;
      else if (cmd === 'pause') { this.flush(); this.armed = false; }
      // 'stop' flushes the tail then signals completion so the main thread can
      // finalize once it has received every posted block (port order is FIFO).
      else if (cmd === 'stop') { this.flush(); this.armed = false; this.port.postMessage({ done: true }); }
    };
  }

  ensure(ch) {
    if (this.buf && this.channels === ch) return;
    this.channels = ch;
    this.buf = Array.from({ length: ch }, () => new Float32Array(BLOCK_FRAMES));
    this.fill = 0;
  }

  flush() {
    if (!this.buf || this.fill === 0) return;
    // Post trimmed copies; the accumulator buffers are reused after.
    const chans = this.buf.map((c) => c.slice(0, this.fill));
    this.port.postMessage({ chans });
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.armed || !input || input.length === 0 || !input[0]) return true;
    const ch = input.length;
    const n = input[0].length;
    this.ensure(ch);
    let src = 0;
    while (src < n) {
      const take = Math.min(BLOCK_FRAMES - this.fill, n - src);
      for (let c = 0; c < ch; c++) {
        this.buf[c].set(input[c].subarray(src, src + take), this.fill);
      }
      this.fill += take;
      src += take;
      if (this.fill === BLOCK_FRAMES) this.flush();
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);
