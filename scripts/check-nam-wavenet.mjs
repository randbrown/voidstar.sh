// Validates the NAM WaveNet path end to end: the parser/packer
// (src/lib/qualia/nam-wavenet.js) + the WASM SIMD kernel (public/wasm/nam-wavenet.wasm)
// driven through the REAL worklet code (worklets/neural-amp.js), against a naive
// reference forward pass written here straight from the architecture spec.
//
// The reference shares no code with the implementation — it walks the raw NAM
// weight vector in file order and does one sample at a time with plain arrays.
// If the packing, the plan layout, or the kernel drifts, ESR blows up here.
//
// Covers both config schemas (classic ≤0.6 and extended 0.7+), a chained
// two-layer-array model, gated layers, per-layer kernel sizes, and a Conv1D head.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWaveNet, unwrapContainer } from '../src/lib/qualia/nam-wavenet.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error(`check-nam-wavenet: ${msg}`); process.exitCode = 1; };

// ---------------------------------------------------------------------------
// deterministic pseudo-random weights (no Math.random — the test must be stable)
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
}

// ---------------------------------------------------------------------------
// reference forward pass — reads the raw NAM weight vector in file order
// ---------------------------------------------------------------------------
const ACTS = {
  Tanh: (x) => Math.tanh(x),
  ReLU: (x) => (x > 0 ? x : 0),
  Sigmoid: (x) => 1 / (1 + Math.exp(-x)),
  ELU: (x) => (x > 0 ? x : Math.exp(x) - 1),
  SiLU: (x) => x / (1 + Math.exp(-x)),
};
const actFn = (a) => {
  if (a && typeof a === 'object') {
    if (a.type === 'LeakyReLU') { const s = a.negative_slope ?? 0.01; return (x) => (x > 0 ? x : x * s); }
    return ACTS[a.type];
  }
  return ACTS[a];
};

function reference(cfg, weights) {
  const w = weights; let p = 0;
  const arrays = cfg.layers.map((la) => {
    const C = la.channels, IN = la.input_size, COND = la.condition_size;
    const extended = Array.isArray(la.kernel_sizes) || la.head != null || la.bottleneck != null;
    const gated = !!la.gated;
    const B = extended ? (la.bottleneck ?? C) : (gated ? 2 * C : C);
    const oneIn = extended ? B : C;
    const ks = Array.isArray(la.kernel_sizes) ? la.kernel_sizes : la.dilations.map(() => la.kernel_size);
    const head = la.head
      ? { out: la.head.out_channels, k: la.head.kernel_size, bias: !!la.head.bias }
      : { out: la.head_size ?? 1, k: 1, bias: !!la.head_bias };
    const one = extended ? !!la.layer1x1?.active : true;

    const rech = w.slice(p, p += C * IN);                 // [C][IN]
    const layers = la.dilations.map((d, i) => {
      const k = ks[i];
      const cw = w.slice(p, p += B * C * k);              // [B][C][k]
      const cb = w.slice(p, p += B);
      const mw = w.slice(p, p += B * COND);               // [B][COND]
      let ow = null, ob = null;
      if (one) { ow = w.slice(p, p += C * oneIn); ob = w.slice(p, p += C); }
      const act = actFn(Array.isArray(la.activation) ? la.activation[i] : la.activation);
      return { k, d, cw, cb, mw, ow, ob, act, hist: [], len: (k - 1) * d + 1 };
    });
    const hw = w.slice(p, p += head.out * C * head.k);    // [out][C][hk]
    const hb = head.bias ? w.slice(p, p += head.out) : new Array(head.out).fill(0);
    return { C, B, IN, COND, gated, oneIn, one, head, rech, layers, hw, hb, accHist: [] };
  });
  const headScale = w[p++];
  if (p !== w.length) throw new Error(`reference cursor ${p} != ${w.length}`);

  const at = (hist, back, C) => (hist.length > back ? hist[hist.length - 1 - back] : new Float64Array(C));

  return function step(x) {
    let arrIn = [x], headPrev = null, last = 0, lastOut = 1;
    for (const A of arrays) {
      const C = A.C, B = A.B;
      let sig = new Float64Array(C);
      for (let o = 0; o < C; o++) { let s = 0; for (let i = 0; i < A.IN; i++) s += A.rech[o * A.IN + i] * arrIn[i]; sig[o] = s; }
      const acc = new Float64Array(C);
      if (headPrev) for (let c = 0; c < C; c++) acc[c] = headPrev[c];

      for (const L of A.layers) {
        L.hist.push(sig.slice());
        if (L.hist.length > L.len) L.hist.shift();
        const z = new Float64Array(B);
        for (let o = 0; o < B; o++) {
          let s = L.cb[o];
          for (let i = 0; i < C; i++) {
            const base = o * C * L.k + i * L.k;
            for (let kk = 0; kk < L.k; kk++) s += L.cw[base + kk] * at(L.hist, (L.k - 1 - kk) * L.d, C)[i];
          }
          s += L.mw[o] * x;                                // COND == 1 in every real capture
          z[o] = L.act(s);
        }
        let zv = z;
        if (A.gated) {
          zv = new Float64Array(C);
          for (let c = 0; c < C; c++) zv[c] = z[c] * (1 / (1 + Math.exp(-z[C + c])));
        }
        for (let c = 0; c < C; c++) acc[c] += zv[c];
        const nxt = new Float64Array(C);
        for (let c = 0; c < C; c++) {
          let s = A.one ? L.ob[c] : 0;
          if (A.one) for (let i = 0; i < A.oneIn; i++) s += L.ow[c * A.oneIn + i] * zv[i];
          else s = zv[c];
          nxt[c] = sig[c] + s;
        }
        sig = nxt;
      }
      A.accHist.push(acc);
      if (A.accHist.length > A.head.k) A.accHist.shift();
      const ho = new Float64Array(A.head.out);
      for (let o = 0; o < A.head.out; o++) {
        let s = A.hb[o];
        for (let i = 0; i < C; i++) {
          const base = o * C * A.head.k + i * A.head.k;
          for (let kk = 0; kk < A.head.k; kk++) s += A.hw[base + kk] * at(A.accHist, A.head.k - 1 - kk, C)[i];
        }
        ho[o] = s;
      }
      headPrev = ho; arrIn = Array.from(sig); last = ho[0]; lastOut = A.head.out;
    }
    void lastOut;
    return last * headScale;
  };
}

// ---------------------------------------------------------------------------
// load the worklet class (it registers itself; capture it via the stub)
// ---------------------------------------------------------------------------
let Processor = null;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { postMessage() {}, set onmessage(_) {}, get onmessage() { return null; } }; }
};
globalThis.registerProcessor = (_name, cls) => { Processor = cls; };
globalThis.sampleRate = 48000;
await import('../src/lib/qualia/worklets/neural-amp.js');
if (!Processor) fail('worklet did not registerProcessor');

const wasmPath = path.join(root, 'public/wasm/nam-wavenet.wasm');
if (!fs.existsSync(wasmPath)) {
  fail('public/wasm/nam-wavenet.wasm is missing — run src/lib/qualia/wasm/build.sh');
  process.exit(1);
}
// The worklet compiles the raw bytes itself (a Module can't cross into an
// AudioWorkletGlobalScope), so hand it exactly what nam-wasm.js would.
const wasmBytes = fs.readFileSync(wasmPath);

// ---------------------------------------------------------------------------
// test models
// ---------------------------------------------------------------------------
function weightCount(cfg) {
  let n = 0;
  for (const la of cfg.layers) {
    const C = la.channels, IN = la.input_size, COND = la.condition_size;
    const extended = Array.isArray(la.kernel_sizes) || la.head != null || la.bottleneck != null;
    const gated = !!la.gated;
    const B = extended ? (la.bottleneck ?? C) : (gated ? 2 * C : C);
    const oneIn = extended ? B : C;
    const one = extended ? !!la.layer1x1?.active : true;
    const ks = Array.isArray(la.kernel_sizes) ? la.kernel_sizes : la.dilations.map(() => la.kernel_size);
    n += C * IN;
    for (let i = 0; i < la.dilations.length; i++) {
      n += B * C * ks[i] + B + B * COND;
      if (one) n += C * oneIn + C;
    }
    const head = la.head ? la.head : { out_channels: la.head_size ?? 1, kernel_size: 1, bias: !!la.head_bias };
    n += head.out_channels * C * head.kernel_size + (head.bias ? head.out_channels : 0);
  }
  return n + 1;
}

// Weights are kept small so the deep residual stack stays in a sane numeric range.
function makeWeights(cfg, seed) {
  const r = rng(seed), n = weightCount(cfg);
  const w = new Array(n);
  for (let i = 0; i < n; i++) w[i] = r() * 0.25;
  w[n - 1] = 0.05;                                        // head_scale
  return w;
}

const CLASSIC = {                                          // NAM ≤0.6 "standard"-shaped, shortened
  layers: [
    { input_size: 1, condition_size: 1, channels: 8, head_size: 4, kernel_size: 3,
      dilations: [1, 2, 4, 8], activation: 'Tanh', gated: false, head_bias: false },
    { input_size: 8, condition_size: 1, channels: 4, head_size: 1, kernel_size: 3,
      dilations: [1, 2, 4], activation: 'Tanh', gated: false, head_bias: true },
  ],
  head: null, head_scale: 0.02,
};

const GATED = {                                            // gated layers, non-multiple-of-4 head
  layers: [
    { input_size: 1, condition_size: 1, channels: 4, head_size: 1, kernel_size: 3,
      dilations: [1, 2, 4], activation: 'Tanh', gated: true, head_bias: true },
  ],
  head: null, head_scale: 0.03,
};

const EXTENDED = {                                         // NAM 0.7 shape (as in real 0.7 captures)
  layers: [
    { input_size: 1, condition_size: 1, channels: 6, bottleneck: 6,
      kernel_sizes: [6, 6, 15, 6], dilations: [1, 3, 13, 41],
      activation: [{ type: 'LeakyReLU', negative_slope: 0.01 }, { type: 'LeakyReLU', negative_slope: 0.01 },
                   { type: 'LeakyReLU', negative_slope: 0.01 }, { type: 'LeakyReLU', negative_slope: 0.01 }],
      head: { out_channels: 1, kernel_size: 16, bias: true },
      head1x1: { active: false }, layer1x1: { active: true, groups: 1 },
      groups_input: 1, groups_input_mixin: 1,
      gating_mode: ['none', 'none', 'none', 'none'],
      secondary_activation: [null, null, null, null], slimmable: null },
  ],
  head: null, head_scale: 0.0095,
};

const ODD = {                                              // channel counts that need padding
  layers: [
    { input_size: 1, condition_size: 1, channels: 3, bottleneck: 3,
      kernel_sizes: [6, 6], dilations: [1, 7],
      activation: [{ type: 'LeakyReLU', negative_slope: 0.01 }, { type: 'LeakyReLU', negative_slope: 0.01 }],
      head: { out_channels: 1, kernel_size: 4, bias: true },
      layer1x1: { active: true }, gating_mode: ['none', 'none'], secondary_activation: [null, null] },
  ],
  head: null, head_scale: 0.01,
};

const CASES = [
  ['classic 2-array Tanh', CLASSIC, 11],
  ['classic gated', GATED, 22],
  ['extended 0.7 LeakyReLU + conv head', EXTENDED, 33],
  ['extended, padded channels (3)', ODD, 44],
];

const N = 512;
const input = new Float32Array(N);
for (let i = 0; i < N; i++) input[i] = 0.4 * Math.sin(i * 0.07) + 0.2 * Math.sin(i * 0.31);

for (const [name, cfg, seed] of CASES) {
  const weights = makeWeights(cfg, seed);
  const model = { version: '0.7.0', architecture: 'WaveNet', config: cfg, weights, sample_rate: 48000 };

  const parsed = parseWaveNet(model);
  if (!parsed.ok) { fail(`${name}: parse failed — ${parsed.reason}`); continue; }

  const proc = new Processor();
  proc.load(parsed, wasmBytes);
  if (!proc.ready || proc.kind !== 'wavenet') { fail(`${name}: worklet did not load the wavenet backend`); continue; }

  const got = new Float32Array(N);
  for (let off = 0; off < N; off += 128) {
    const n = Math.min(128, N - off);
    proc.processWaveNet(input.subarray(off, off + n), [input.subarray(off, off + n)], got.subarray(off, off + n));
  }

  const step = reference(cfg, weights);
  let err = 0, pow = 0;
  for (let i = 0; i < N; i++) { const r = step(input[i]); err += (got[i] - r) ** 2; pow += r * r; }
  const esr = pow > 0 ? err / pow : err;
  if (!(esr < 1e-8)) fail(`${name}: ESR ${esr.toExponential(2)} vs reference (expected < 1e-8)`);
  else console.log(`check-nam-wavenet: ${name} — ESR ${esr.toExponential(2)} ok`);
}

// ---------------------------------------------------------------------------
// container unwrapping + refusals
// ---------------------------------------------------------------------------
{
  const sub = (ch, mv) => ({ max_value: mv, model: { architecture: 'WaveNet', config: ODD, weights: makeWeights(ODD, ch), sample_rate: 48000 } });
  const container = { architecture: 'SlimmableContainer', config: { submodels: [sub(3, 0.5), sub(9, 1)] }, weights: [], metadata: { loudness: -21 } };
  const u = unwrapContainer(container);
  if (u.arch !== 'WaveNet') fail('container: did not unwrap to WaveNet');
  if (u.picked?.maxValue !== 1) fail(`container: picked max_value ${u.picked?.maxValue}, expected the widest (1)`);
  if (!parseWaveNet(u.model).ok) fail('container: unwrapped model failed to parse');
  else console.log('check-nam-wavenet: SlimmableContainer unwrap ok');
}
{
  const bad = JSON.parse(JSON.stringify(EXTENDED));
  bad.layers[0].conv_pre_film = { active: true, shift: true, groups: 1 };
  const r = parseWaveNet({ config: bad, weights: makeWeights(EXTENDED, 5) });
  if (r.ok || !/FiLM/.test(r.reason)) fail('an active FiLM block must be refused by name');
  else console.log('check-nam-wavenet: refuses unsupported FiLM block');
}
{
  const w = makeWeights(EXTENDED, 6); w.push(1.5);        // one weight too many
  const r = parseWaveNet({ config: EXTENDED, weights: w });
  if (r.ok || !/weight count mismatch/.test(r.reason)) fail('a wrong weight count must be refused');
  else console.log('check-nam-wavenet: refuses a weight-count mismatch');
}

// ---------------------------------------------------------------------------
// capture normalisation trim
// ---------------------------------------------------------------------------
{
  const { normTrimFor } = await import('../src/lib/qualia/neural-amp-model.js');
  const db = (t) => 20 * Math.log10(t);
  // A capture quieter than the target gets boosted by exactly the difference.
  if (Math.abs(db(normTrimFor(-21.3)) - 3.3) > 0.01) fail(`normTrim(-21.3) should be +3.3 dB, got ${db(normTrimFor(-21.3)).toFixed(2)}`);
  // ...and a hot one gets cut.
  if (Math.abs(db(normTrimFor(-12)) - -6) > 0.01) fail(`normTrim(-12) should be -6 dB, got ${db(normTrimFor(-12)).toFixed(2)}`);
  // Clamped both ways, so a bogus loudness can't hand the PA a huge boost.
  if (Math.abs(db(normTrimFor(-99)) - 12) > 0.01) fail('normTrim must clamp to +12 dB');
  if (Math.abs(db(normTrimFor(+40)) - -12) > 0.01) fail('normTrim must clamp to -12 dB');
  // No declared loudness (GuitarML / AIDA-X) → no trim at all, never a guess.
  for (const v of [null, undefined, NaN, 'loud']) {
    if (normTrimFor(v) !== 1) fail(`normTrim(${String(v)}) must be exactly 1`);
  }
  if (!process.exitCode) console.log('check-nam-wavenet: normalisation trim ok');
}

if (!process.exitCode) console.log('check-nam-wavenet: all good');
