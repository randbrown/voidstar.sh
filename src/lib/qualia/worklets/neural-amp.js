// Neural amp — AudioWorklet inference for small LSTM "capture" models
// (GuitarML/Proteus, AIDA-X, and NAM's LSTM exports). A single-layer LSTM
// (input_size 1) followed by a dense head — the architecture behind most
// realtime-feasible neural captures. Runs sample-by-sample on the audio thread,
// allocation-free in process().
//
// NAM's *standard* (WaveNet) models are heavier and want the NeuralAmpModelerCore
// compiled to WASM; this processor is the LSTM backend. A future WASM backend can
// register under a different name and swap in behind the same strip node.
//
// Weights (from the main thread, normalised by neural-amp-model.js):
//   Wih : Float32Array[4H]        input→gate    (gate order i,f,g,o, PyTorch)
//   Whh : Float32Array[4H*H]      hidden→gate   (row-major, row r = Whh[r*H+j])
//   b   : Float32Array[4H]        combined bias (bias_ih + bias_hh)
//   Wd  : Float32Array[H]         dense head
//   bd  : number                  dense bias

class NeuralAmpProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.bypass = false;
    this.disposed = false;
    this.H = 0;
    this.Wih = this.Whh = this.b = this.Wd = null;
    this.bd = 0;
    this.h = this.c = this.pre = null;
    this.port.onmessage = (e) => {
      const d = e.data; if (!d) return;
      if (d.cmd === 'load') this.load(d.model);
      else if (d.cmd === 'bypass') this.bypass = !!d.on;
      else if (d.cmd === 'clear') this.ready = false;
      // Let the node be torn down: returning false from process() ends the
      // processor so it (and its weight buffers) can be GC'd. Without this a
      // disconnected node keeps running for the life of the AudioContext —
      // and the strip is rebuilt on every capture open, so they pile up.
      else if (d.cmd === 'dispose') this.disposed = true;
    };
  }

  load(m) {
    try {
      const H = m.hidden | 0;
      if (!(H > 0) || !m.Wih || !m.Whh || !m.Wd) { this.ready = false; return; }
      this.H = H;
      this.Wih = m.Wih; this.Whh = m.Whh; this.b = m.b; this.Wd = m.Wd; this.bd = m.bd || 0;
      this.h = new Float32Array(H);
      this.c = new Float32Array(H);
      this.pre = new Float32Array(4 * H);
      this.ready = true;
    } catch (err) {
      this.ready = false;
      this.port.postMessage({ error: String(err) });
    }
  }

  process(inputs, outputs) {
    if (this.disposed) return false;   // ends the processor so it can be GC'd
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const o0 = out[0];
    const inp = inputs[0];
    const i0 = inp && inp[0] ? inp[0] : null;

    if (!this.ready || this.bypass || !i0) {
      if (i0) o0.set(i0); else o0.fill(0);
      for (let ch = 1; ch < out.length; ch++) out[ch].set(o0);
      return true;
    }

    const H = this.H, H2 = 2 * H, H3 = 3 * H, H4 = 4 * H;
    const Wih = this.Wih, Whh = this.Whh, b = this.b, Wd = this.Wd, bd = this.bd;
    const h = this.h, c = this.c, pre = this.pre;
    const stereo = inp.length > 1 ? inp[1] : null;
    const N = i0.length;

    for (let n = 0; n < N; n++) {
      let xin = stereo ? (i0[n] + stereo[n]) * 0.5 : i0[n];   // downmix to mono
      const x = (xin * 0 === 0) ? xin : 0;                    // finite guard on input
      // gate pre-activations: Wih·x + b + Whh·h
      for (let r = 0; r < H4; r++) {
        let s = Wih[r] * x + b[r];
        const base = r * H;
        for (let j = 0; j < H; j++) s += Whh[base + j] * h[j];
        pre[r] = s;
      }
      let y = bd;
      for (let j = 0; j < H; j++) {
        const ig = 1 / (1 + Math.exp(-pre[j]));
        const fg = 1 / (1 + Math.exp(-pre[H + j]));
        const gg = Math.tanh(pre[H2 + j]);
        const og = 1 / (1 + Math.exp(-pre[H3 + j]));
        const cj = fg * c[j] + ig * gg;
        c[j] = cj;
        const hj = og * Math.tanh(cj);
        h[j] = hj;
        y += Wd[j] * hj;
      }
      // A single non-finite value (bad sample or a NaN weight) would otherwise
      // latch into h/c and output NaN until a model reload. Reset the recurrent
      // state and pass the dry sample so the amp self-heals in one block.
      if (y * 0 === 0) {
        o0[n] = y;
      } else {
        h.fill(0); c.fill(0);
        o0[n] = x;
      }
    }
    for (let ch = 1; ch < out.length; ch++) out[ch].set(o0);
    return true;
  }
}

registerProcessor('neural-amp', NeuralAmpProcessor);
