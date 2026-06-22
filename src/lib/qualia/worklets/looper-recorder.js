// Looper input recorder — AudioWorklet processor.
//
// Two jobs, both on the audio render thread (off the main thread, which the
// Strudel cyclist competes for):
//
//   1. Armed real-time capture. While armed (`{cmd:'start'}` / `{cmd:'stop'}`)
//      it copies each input render quantum (ALL channels) back to the main
//      thread, where looper-audio.js accumulates the per-channel Float32 chunks
//      into an AudioBuffer. Sample-accurate 128-frame quanta let loop IN/OUT
//      points pin to Strudel cycle boundaries.
//
//   2. Always-on ring buffer (retroactive looping). Every quantum is also
//      written into a fixed circular buffer of the last RING_SECONDS, so the
//      performer can retroactively grab the last N cycles of something they
//      just played WITHOUT having armed record first. The ring lives here, on
//      the audio thread — we post a slice only on `{cmd:'grab'}`, never per
//      quantum, so the lookback costs nothing on the main thread until used.
//
// `sampleRate` and `currentTime` are globals in AudioWorkletGlobalScope; the
// looper's ctx and this scope share the same clock, so the timestamps we stamp
// (t0 for armed capture, tStart/tEnd for a grab) are directly comparable to the
// main thread's ctx.currentTime — that's how grabbed audio is mapped onto the
// Strudel grid retroactively.

// ~40 s lookback. Stereo @ 48 kHz ≈ 40·48000·2·4 B ≈ 15 MB — trivial, and the
// ring is allocated once (lazily, at the input's real channel count).
const RING_SECONDS = 40;

class LooperRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.sendStart = false;
    // ring state
    this.ring = null;            // Float32Array[] per channel
    this.ringLen = 0;
    this.ringChannels = 0;
    this.writeHead = 0;          // next write index (circular)
    this.framesWritten = 0;      // total frames ever written (monotonic)
    this.lastBlockTime = 0;      // ctx time at the start of the latest quantum
    this.port.onmessage = (e) => {
      const d = e.data; const cmd = d && d.cmd;
      if (cmd === 'start') { this.armed = true; this.sendStart = true; }
      else if (cmd === 'stop') this.armed = false;
      else if (cmd === 'grab') this.grab(d.seconds, d.id);
    };
  }

  ensureRing(channels) {
    if (this.ring && this.ringChannels === channels) return;
    this.ringLen = Math.max(1, Math.round(RING_SECONDS * sampleRate));
    this.ringChannels = channels;
    this.ring = [];
    for (let c = 0; c < channels; c++) this.ring.push(new Float32Array(this.ringLen));
    this.writeHead = 0;
    this.framesWritten = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch0 = input && input[0];
    if (ch0 && ch0.length) {
      const channels = input.length;
      const len = ch0.length;
      this.ensureRing(channels);

      // Write the quantum into the ring (block copy, wrapping at the end).
      const ringLen = this.ringLen;
      const head = this.writeHead;
      const firstLen = Math.min(len, ringLen - head);
      for (let c = 0; c < channels; c++) {
        const dst = this.ring[c], src = input[c];
        dst.set(firstLen === len ? src : src.subarray(0, firstLen), head);
        if (firstLen < len) dst.set(src.subarray(firstLen), 0);
      }
      this.writeHead = (head + len) % ringLen;
      this.framesWritten += len;
      this.lastBlockTime = currentTime;

      // Armed real-time capture — copy + transfer each quantum to the main
      // thread (the host reuses the input buffer across quanta, so copy first).
      if (this.armed) {
        if (this.sendStart) {
          this.sendStart = false;
          this.port.postMessage({ t0: currentTime });
        }
        const chans = [];
        const transfer = [];
        for (let c = 0; c < channels; c++) {
          const copy = new Float32Array(len);
          copy.set(input[c]);
          chans.push(copy);
          transfer.push(copy.buffer);
        }
        this.port.postMessage({ chans }, transfer);
      }
    }
    // Keep the processor alive even when idle (returning false lets the browser
    // GC it once it has no references — we want the ring to keep filling).
    return true;
  }

  // Post the most recent `seconds` of the ring as per-channel Float32Arrays,
  // with the absolute ctx times of the slice's first (tStart) and last (tEnd)
  // samples so the main thread can map it onto the Strudel grid.
  grab(seconds, id) {
    if (!this.ring || this.framesWritten <= 0) {
      this.port.postMessage({ grab: id, chans: null });
      return;
    }
    const want = Math.min(
      this.framesWritten,
      this.ringLen,
      Math.max(0, Math.round(seconds * sampleRate)),
    );
    if (want <= 0) { this.port.postMessage({ grab: id, chans: null }); return; }

    let startIdx = (this.writeHead - want) % this.ringLen;
    if (startIdx < 0) startIdx += this.ringLen;
    const chans = [];
    const transfer = [];
    for (let c = 0; c < this.ringChannels; c++) {
      const out = new Float32Array(want);
      const ring = this.ring[c];
      const first = Math.min(want, this.ringLen - startIdx);
      out.set(ring.subarray(startIdx, startIdx + first), 0);
      if (first < want) out.set(ring.subarray(0, want - first), first);
      chans.push(out);
      transfer.push(out.buffer);
    }
    const tEnd = this.lastBlockTime;          // ≈ ctx time of the newest sample
    const tStart = tEnd - want / sampleRate;  // ctx time of the slice's frame 0
    this.port.postMessage({ grab: id, chans, frames: want, tStart, tEnd, sampleRate }, transfer);
  }
}

registerProcessor('looper-recorder', LooperRecorderProcessor);
