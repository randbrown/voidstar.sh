// Looper input recorder — AudioWorklet processor.
//
// While armed (`{cmd:'start'}` / `{cmd:'stop'}` over the port) it copies each
// input render quantum (mono — first channel) back to the main thread, where
// looper-audio.js accumulates the Float32 chunks into an AudioBuffer. Running
// on the audio render thread keeps capture off the main thread (which the
// Strudel cyclist competes for) and gives sample-accurate, 128-frame quanta so
// loop IN/OUT points can be pinned to Strudel cycle boundaries.

class LooperRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.sendStart = false;
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === 'start') { this.armed = true; this.sendStart = true; }
      else if (cmd === 'stop') this.armed = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch0 = input && input[0];
    if (this.armed && ch0 && ch0.length) {
      if (this.sendStart) {
        // Stamp the precise ctx time of the first armed quantum (frame 0) so the
        // main thread can anchor the recording without arm-latency jitter.
        this.sendStart = false;
        this.port.postMessage({ t0: currentTime });
      }
      // The host reuses the input buffer across quanta, so copy before
      // transferring ownership to the main thread.
      const copy = new Float32Array(ch0.length);
      copy.set(ch0);
      this.port.postMessage(copy, [copy.buffer]);
    }
    // Keep the processor alive even when idle (returning false would let the
    // browser garbage-collect it once it has no references).
    return true;
  }
}

registerProcessor('looper-recorder', LooperRecorderProcessor);
