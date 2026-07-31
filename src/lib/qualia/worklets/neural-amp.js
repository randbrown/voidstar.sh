// Neural amp — AudioWorklet inference for neural "capture" models, with two
// backends behind one processor:
//
//   lstm     — single-layer LSTM (input_size 1) + dense head, in plain JS.
//              GuitarML/Proteus, AIDA-X, and NAM's LSTM exports.
//   wavenet  — NAM's standard architecture, run by the WASM SIMD kernel in
//              wasm/nam-wavenet.c. Scalar JS costs ~100% of a core for a typical
//              WaveNet at 48 kHz, which the audio thread cannot afford; the
//              kernel is ~4x faster. The compiled WebAssembly.Module arrives
//              over the port (worklets can't fetch), already compiled on the
//              main thread by nam-wasm.js.
//
// Both run allocation-free in process(). All parsing, validation and weight
// packing happens on the main thread (neural-amp-model.js, nam-wavenet.js);
// this file only places buffers and runs.
//
// LSTM weights (normalised by neural-amp-model.js):
//   Wih : Float32Array[4H]        input→gate    (gate order i,f,g,o, PyTorch)
//   Whh : Float32Array[4H*H]      hidden→gate   (row-major, row r = Whh[r*H+j])
//   b   : Float32Array[4H]        combined bias (bias_ih + bias_hh)
//   Wd  : Float32Array[H]         dense head
//   bd  : number                  dense bias

// Plan word counts — must match the #defines in wasm/nam-wavenet.c.
const AH = 4, AW = 23, LW = 11;
const NAM_ABI = 1;                 // must match nam_abi() in wasm/nam-wavenet.c
const QUANTUM = 128;               // Web Audio render quantum; buffers size to it

class NeuralAmpProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.bypass = false;
    this.disposed = false;
    this.kind = 'lstm';
    this.H = 0;
    this.Wih = this.Whh = this.b = this.Wd = null;
    this.bd = 0;
    this.h = this.c = this.pre = null;
    // wavenet backend
    this.wn = null;
    this.port.onmessage = (e) => {
      const d = e.data; if (!d) return;
      if (d.cmd === 'load') this.load(d.model, d.wasm);
      else if (d.cmd === 'bypass') this.bypass = !!d.on;
      // Drop the WASM instance too — it owns a megabyte of linear memory, and
      // the strip is rebuilt on every capture open.
      else if (d.cmd === 'clear') { this.ready = false; this.wn = null; }
      // Let the node be torn down: returning false from process() ends the
      // processor so it (and its weight buffers) can be GC'd. Without this a
      // disconnected node keeps running for the life of the AudioContext —
      // and the strip is rebuilt on every capture open, so they pile up.
      else if (d.cmd === 'dispose') this.disposed = true;
    };
  }

  load(m, wasm) {
    try {
      if (m && m.type === 'wavenet') {
        this.wn = this.buildWaveNet(m, wasm);
        this.kind = 'wavenet';
        this.ready = !!this.wn;
        this.port.postMessage(this.wn ? { loaded: 'wavenet' } : { error: 'WaveNet backend unavailable' });
        return;
      }
      const H = m.hidden | 0;
      if (!(H > 0) || !m.Wih || !m.Whh || !m.Wd) {
        this.ready = false;
        this.port.postMessage({ error: 'LSTM weights missing or malformed' });
        return;
      }
      this.kind = 'lstm';
      this.wn = null;                    // release any previous WaveNet instance
      this.H = H;
      this.Wih = m.Wih; this.Whh = m.Whh; this.b = m.b; this.Wd = m.Wd; this.bd = m.bd || 0;
      this.h = new Float32Array(H);
      this.c = new Float32Array(H);
      this.pre = new Float32Array(4 * H);
      this.ready = true;
      this.port.postMessage({ loaded: 'lstm' });
    } catch (err) {
      this.ready = false;
      this.port.postMessage({ error: String(err) });
    }
  }

  // Instantiate the kernel and lay every buffer out in its linear memory. Runs
  // once per model load (never in process()); a fresh instance means the model's
  // recurrent history starts zeroed, since WASM memory is born zeroed.
  buildWaveNet(m, wasmBytes) {
    if (!wasmBytes || typeof WebAssembly === 'undefined') return null;
    // Compiled here, not on the main thread: a WebAssembly.Module can't cross
    // into an AudioWorklet's agent cluster (the message is silently dropped), so
    // the bytes come over the port and are compiled synchronously off-thread.
    const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
    const fn = inst.exports.nam_process;
    const mem = inst.exports.memory;
    if (typeof fn !== 'function' || !mem || typeof inst.exports.nam_abi !== 'function') return null;
    if (inst.exports.nam_abi() !== NAM_ABI) return null;
    const heapBase = inst.exports.nam_heap_base();
    if (heapBase & 3) return null;

    const Q = QUANTUM;
    // Pass 1 — offsets. Everything is a float index from the kernel's arena, and
    // each block is 16-byte aligned so the v128 loads stay aligned.
    let cur = 0;
    const alloc = (n) => { const o = cur; cur = (cur + n + 3) & ~3; return o; };

    let planWords = AH;
    for (const a of m.arrays) planWords += AW + a.layers.length * LW;
    const planOff = alloc(planWords);
    const headScaleOff = alloc(1);
    const condOff = alloc(Q);
    const outOff = alloc(Q);

    const A = [];
    for (let ai = 0; ai < m.arrays.length; ai++) {
      const a = m.arrays[ai];
      const d = {
        rech: alloc(a.IN * a.Cp),
        hw: alloc(a.hk * a.Cp * a.houtp),
        hb: alloc(a.houtp),
        headAcc: alloc((a.hk - 1 + Q) * a.Cp),
        headOut: alloc(Q * a.houtp),
        sigA: alloc(Q * a.Cp),
        sigB: alloc(Q * a.Cp),
        z: alloc(Q * a.Bp),
        arrOut: alloc(Q * a.Cp),
        layers: [],
      };
      for (const l of a.layers) {
        d.layers.push({
          cw: alloc(l.k * a.Cp * a.Bp),
          cb: alloc(a.Bp),
          mw: alloc(a.COND * a.Bp),
          ow: l.ow ? alloc(a.B * a.Cp) : -1,
          ob: alloc(a.Cp),
          buf: alloc((l.rf + Q) * a.Cp),
          slope: alloc(1),
        });
      }
      A.push(d);
    }

    // Grow to fit, THEN take views — growing detaches the old buffer.
    const need = heapBase + cur * 4;
    if (mem.buffer.byteLength < need) {
      const pages = Math.ceil((need - mem.buffer.byteLength) / 65536);
      try { mem.grow(pages); } catch { return null; }
      if (mem.buffer.byteLength < need) return null;
    }
    const F = new Float32Array(mem.buffer);
    const I = new Int32Array(mem.buffer);
    const base = heapBase >> 2;

    // Pass 2 — write weights and the plan the kernel walks.
    F[base + headScaleOff] = m.headScale;
    I[base + planOff] = m.arrays.length;
    I[base + planOff + 1] = headScaleOff;
    I[base + planOff + 2] = condOff;
    I[base + planOff + 3] = outOff;

    let w = base + planOff + AH;
    for (let ai = 0; ai < m.arrays.length; ai++) {
      const a = m.arrays[ai], d = A[ai], prev = ai > 0 ? m.arrays[ai - 1] : null;
      F.set(a.rech, base + d.rech);
      F.set(a.hw, base + d.hw);
      F.set(a.hb, base + d.hb);
      I[w++] = a.C; I[w++] = a.Cp; I[w++] = a.B; I[w++] = a.Bp;
      I[w++] = a.IN; I[w++] = a.COND; I[w++] = a.layers.length;
      I[w++] = a.hk; I[w++] = a.hout; I[w++] = a.houtp; I[w++] = a.gated;
      I[w++] = ai === 0 ? condOff : A[ai - 1].arrOut;
      I[w++] = ai === 0 ? 1 : prev.Cp;              // per-sample stride of the input
      I[w++] = d.rech; I[w++] = d.hw; I[w++] = d.hb;
      I[w++] = d.headAcc; I[w++] = d.headOut;
      I[w++] = d.sigA; I[w++] = d.sigB; I[w++] = d.z; I[w++] = d.arrOut;
      I[w++] = ai === 0 ? -1 : A[ai - 1].headOut;
      for (let li = 0; li < a.layers.length; li++) {
        const l = a.layers[li], ld = d.layers[li];
        F.set(l.cw, base + ld.cw);
        F.set(l.cb, base + ld.cb);
        F.set(l.mw, base + ld.mw);
        if (l.ow) F.set(l.ow, base + ld.ow);
        if (l.ob) F.set(l.ob, base + ld.ob);
        F[base + ld.slope] = l.slope;
        I[w++] = l.k; I[w++] = l.d; I[w++] = l.rf;
        I[w++] = ld.cw; I[w++] = ld.cb; I[w++] = ld.mw; I[w++] = ld.ow; I[w++] = ld.ob;
        I[w++] = ld.buf; I[w++] = l.act; I[w++] = ld.slope;
      }
    }
    return { fn, F, base, plan: planOff, cond: base + condOff, out: base + outOff, q: Q };
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

    if (this.kind === 'wavenet') { this.processWaveNet(i0, inp, o0); for (let ch = 1; ch < out.length; ch++) out[ch].set(o0); return true; }

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

  // WaveNet: hand the block to the kernel through its linear memory. The kernel
  // is block-size agnostic (it rewinds history at the end of each block), so an
  // oversized quantum just runs as several chunks.
  processWaveNet(i0, inp, o0) {
    const wn = this.wn;
    const F = wn.F, cond = wn.cond, outOff = wn.out, q = wn.q;
    const stereo = inp.length > 1 ? inp[1] : null;
    const N = i0.length;
    for (let off = 0; off < N; off += q) {
      const n = Math.min(q, N - off);
      for (let i = 0; i < n; i++) {
        const x = stereo ? (i0[off + i] + stereo[off + i]) * 0.5 : i0[off + i];
        F[cond + i] = (x * 0 === 0) ? x : 0;       // finite guard on input
      }
      wn.fn(wn.plan, n);
      for (let i = 0; i < n; i++) {
        const y = F[outOff + i];
        o0[off + i] = (y * 0 === 0) ? y : 0;
      }
    }
  }
}

registerProcessor('neural-amp', NeuralAmpProcessor);
