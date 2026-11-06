// Checks the lookahead brickwall limiter (src/lib/qualia/worklets/lookahead-limiter.js):
//   node scripts/check-qualia-limiter.mjs
//
// Drives the REAL worklet DSP (LookaheadLimiterCore, plus the registered
// processor through a stubbed AudioWorklet scope) in node:
// - brickwall: no output sample ever exceeds the ceiling, on sines, bursts,
//   kicks and noise driven up to +24 dB over it, at the rig and bus lookaheads;
// - transparent below the ceiling: output is the input, bit-exact, delayed by
//   exactly the reported latency;
// - disengaged: a hot signal passes untouched (same delay — toggling never
//   shifts timing);
// - clean: a 100 Hz sine driven +6 dB into the limiter comes out with far less
//   harmonic distortion than the old soft-clip WaveShaper curve produces;
// - NaN/Inf input can't poison the gain envelope.

let Processor = null;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { postMessage() {}, onmessage: null }; }
};
globalThis.registerProcessor = (_name, cls) => { Processor = cls; };
globalThis.sampleRate = 48000;
await import('../src/lib/qualia/worklets/lookahead-limiter.js');
if (!Processor) { console.error('check-qualia-limiter: worklet did not registerProcessor'); process.exit(1); }
const LookaheadLimiterCore = new Processor({}).core.constructor;

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SR = 48000;
const dbToLin = (db) => Math.pow(10, db / 20);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
}

/** Run `chans` (Float32Array[]) through a core in 128-frame quanta. */
function run(core, chans) {
  const N = chans[0].length, C = chans.length;
  const out = chans.map(() => new Float32Array(N));
  for (let off = 0; off < N; off += 128) {
    const f = Math.min(128, N - off);
    const inp = chans.map((ch) => ch.slice(off, off + f));
    const o = chans.map(() => new Float32Array(f));
    core.process(inp, o, f);
    for (let c = 0; c < C; c++) out[c].set(o[c], off);
  }
  return out;
}

const peakOf = (a) => { let p = 0; for (const x of a) { const v = Math.abs(x); if (v > p) p = v; } return p; };

// ── test signals ──
function sine(freq, amp, sec, phase = 0) {
  const n = Math.round(sec * SR), a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * freq * i / SR + phase);
  return a;
}
function kicks(amp, sec) {
  const n = Math.round(sec * SR), a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i % (SR / 2)) / SR;               // a kick every 500 ms
    a[i] = amp * Math.exp(-t * 18) * Math.sin(2 * Math.PI * (45 + 120 * Math.exp(-t * 40)) * t);
  }
  return a;
}
function bursts(amp, sec, seed) {
  const r = rng(seed), n = Math.round(sec * SR), a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (Math.floor(i / 2400) % 3 === 0 ? amp : amp * 0.05) * r();
  return a;
}

// ── 1. brickwall ──
for (const la of [1.5, 5]) {
  const ceilDb = -1;
  const ceil = dbToLin(ceilDb);
  let worst = 0;
  for (const overDb of [0.5, 6, 12, 24]) {
    const amp = ceil * dbToLin(overDb);
    const sigs = [
      [sine(60, amp, 1), sine(60, amp * 0.7, 1, 1)],
      [kicks(amp, 1.5), kicks(amp, 1.5)],
      [bursts(amp, 1, 7), bursts(amp, 1, 11)],
      [sine(3500, amp, 0.5), sine(17, amp, 0.5)],
    ];
    for (const s of sigs) {
      const core = new LookaheadLimiterCore(SR, { lookaheadMs: la, ceilingDb: ceilDb });
      const out = run(core, s);
      worst = Math.max(worst, peakOf(out[0]), peakOf(out[1]));
    }
  }
  check(`brickwall @ ${la} ms lookahead`, worst <= ceil + 1e-6,
    `worst peak ${(20 * Math.log10(worst)).toFixed(3)} dBFS vs ceiling ${ceilDb}`);
}

// And WITHOUT the final safety clamp doing the work: the gain envelope alone
// must already hold the ceiling (the clamp is float-rounding insurance only).
{
  const ceil = dbToLin(-1);
  const core = new LookaheadLimiterCore(SR, { lookaheadMs: 1.5, safetyClamp: false });
  const s = [kicks(ceil * dbToLin(18), 1.5), bursts(ceil * dbToLin(18), 1.5, 3)];
  const out = run(core, s);
  const worstRaw = Math.max(peakOf(out[0]), peakOf(out[1]));
  check('envelope alone holds the ceiling (no safety clamp)', worstRaw <= ceil * (1 + 1e-6),
    `${(20 * Math.log10(worstRaw)).toFixed(4)} dBFS`);
}

// ── 2. transparent below the ceiling, exact latency ──
for (const la of [1.5, 5]) {
  const core = new LookaheadLimiterCore(SR, { lookaheadMs: la });
  const D = core.latency;
  check(`latency @ ${la} ms`, D === Math.round(la / 1000 * SR), `${D} samples`);
  const r = rng(42);
  const s = [new Float32Array(SR), new Float32Array(SR)];
  for (let i = 0; i < SR; i++) { s[0][i] = 0.6 * r(); s[1][i] = 0.6 * r(); }
  const out = run(core, s);
  let exact = true;
  for (let i = D; i < SR && exact; i++) if (out[0][i] !== s[0][i - D] || out[1][i] !== s[1][i - D]) exact = false;
  for (let i = 0; i < D; i++) if (out[0][i] !== 0) exact = false;
  check(`bit-exact delayed passthrough below ceiling @ ${la} ms`, exact);
}

// ── 3. disengaged = untouched (same delay) ──
{
  const core = new LookaheadLimiterCore(SR, { lookaheadMs: 5, engaged: false });
  const D = core.latency;
  const hot = sine(220, 1.8, 0.5);
  const out = run(core, [hot, hot]);
  let same = true;
  for (let i = D; i < hot.length; i++) if (out[0][i] !== hot[i - D]) { same = false; break; }
  check('disengaged passes a +5 dBFS signal untouched', same);
}

// ── 4. distortion vs the old soft-clip curve ──
// THD of a steady 100 Hz sine, +6 dB over the ceiling, measured over a whole
// number of cycles after the envelope settles.
function thd(sig, f0) {
  const n = sig.length;
  const mag = (k) => {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const ph = 2 * Math.PI * k * f0 * i / SR; re += sig[i] * Math.cos(ph); im -= sig[i] * Math.sin(ph); }
    return Math.hypot(re, im);
  };
  const fund = mag(1);
  let h = 0;
  for (let k = 2; k <= 15; k++) h += mag(k) ** 2;
  return Math.sqrt(h) / fund;
}
{
  const ceil = dbToLin(-1);
  const amp = ceil * dbToLin(6);
  const core = new LookaheadLimiterCore(SR, { lookaheadMs: 1.5, releaseMs: 100 });
  const s = sine(100, amp, 3);
  const out = run(core, [s, s])[0];
  const tail = out.slice(SR * 2, SR * 2 + SR / 2);   // 50 whole cycles, settled
  const thdLim = thd(tail, 100);

  // The old rig limiter: soft-clip curve (identity to -6 dBFS, tanh into -1).
  const KNEE = 0.5, span = ceil - KNEE;
  const clip = (x) => { const a = Math.min(1, Math.abs(x)); return a <= KNEE ? x : Math.sign(x) * (KNEE + span * Math.tanh((a - KNEE) / span)); };
  const old = s.slice(SR * 2, SR * 2 + SR / 2).map(clip);
  const thdOld = thd(old, 100);
  check('cleaner than the soft-clip limiter at +6 dB drive', thdLim < thdOld / 3,
    `THD ${(thdLim * 100).toFixed(2)}% vs soft-clip ${(thdOld * 100).toFixed(2)}%`);
}

// ── 5. NaN/Inf guard ──
{
  const core = new LookaheadLimiterCore(SR, { lookaheadMs: 5 });
  const s = sine(440, 0.3, 0.2);
  s[1000] = NaN; s[2000] = Infinity;
  const out = run(core, [s, s]);
  check('NaN/Inf input does not poison the output', out[0].every(Number.isFinite) && peakOf(out[0].slice(SR * 0.1)) > 0.29);
}

// ── 6. the registered processor wires the same core ──
{
  check('worklet registers its processor', !!Processor);
  const posted = [];
  const p = new Processor({ outputChannelCount: [2], processorOptions: { lookaheadMs: 5 } });
  p.port.postMessage = (m) => posted.push(m);
  const hot = sine(80, 2, 0.25);
  let maxOut = 0;
  for (let off = 0; off + 128 <= hot.length; off += 128) {
    const inp = [hot.slice(off, off + 128)];            // mono in → stereo out
    const outs = [[new Float32Array(128), new Float32Array(128)]];
    p.process([inp], outs);
    maxOut = Math.max(maxOut, peakOf(outs[0][0]));
  }
  check('processor limits a mono input', maxOut <= dbToLin(-1) + 1e-6);
  check('processor reports gain reduction', posted.some((m) => m.gr > 6), `max ${Math.max(...posted.map((m) => m.gr)).toFixed(1)} dB`);
  p.port.onmessage({ data: { engaged: false } });
  check('processor accepts engage toggle', p.core.engaged === false);
}

if (failed) { console.error(`check-qualia-limiter: ${failed} failed`); process.exit(1); }
console.log('check-qualia-limiter: all ok');
