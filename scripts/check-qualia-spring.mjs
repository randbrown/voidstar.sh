// Checks for the rig's pre-amp spring tank and NAM input calibration:
//   node scripts/check-qualia-spring.mjs
//
// - spring-reverb.js: the synthesized two-spring IR is finite, deterministic,
//   silent before the first arrival, band-limited like a real pan, decays at
//   the requested rate, and — the thing that makes it a SPRING — every arrival
//   is a descending chirp (lows reach the pickup after the highs).
// - neural-amp-model.js: calTrimFor() is interface dBu − capture dBu (clamped,
//   1 when undeclared), and parseAmpModel() carries `input_level_dbu` and
//   `gear_type` through.
// - rig-strip.js: the spring stage sits between the drives and the amp in
//   chain-ordered STRIP_DEFAULTS, and calibration defaults ON.
// The Web Audio wiring itself only runs in a browser.

import { buildSpringIR, springIRLength, SPRING_DECAY_MIN, SPRING_DECAY_MAX } from '../src/lib/qualia/spring-reverb.js';
import { calTrimFor, CAL_DEFAULT_INTERFACE_DBU, CAL_MAX_DB, parseAmpModel, isFullRigGearType } from '../src/lib/qualia/neural-amp-model.js';
import { STRIP_DEFAULTS } from '../src/lib/qualia/rig-strip.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const dB = (x) => 20 * Math.log10(x);

// ── spring IR ────────────────────────────────────────────────────────────────
const SR = 48000;
section('spring IR — shape');
{
  const ir = buildSpringIR(SR, 2.5);
  check('length matches springIRLength', ir.length === springIRLength(SR, 2.5), `${ir.length}`);
  check('all samples finite', ir.every(Number.isFinite));
  let peak = 0; for (const v of ir) peak = Math.max(peak, Math.abs(v));
  check('peak-normalised to 1', near(peak, 1, 1e-6), `${peak}`);
  const again = buildSpringIR(SR, 2.5);
  check('deterministic (same decay → same tank)', again.every((v, i) => v === ir[i]));

  // Nothing (beyond numerical dust) before the first traversal arrives.
  let pre = 0; for (let i = 0; i < SR * 0.02; i++) pre = Math.max(pre, Math.abs(ir[i]));
  check('silent before the first arrival (< −60 dB in the first 20 ms)', dB(pre + 1e-12) < -60, `${dB(pre).toFixed(1)} dB`);
  let first = 0; while (first < ir.length && Math.abs(ir[first]) < 0.05) first++;
  const firstMs = first / SR * 1000;
  check('first arrival lands at a tank-like 25–40 ms', firstMs > 25 && firstMs < 40, `${firstMs.toFixed(1)} ms`);
}

section('spring IR — decay');
for (const d of [0.5, 2.5, 5]) {
  const ir = buildSpringIR(SR, d);
  // Energy of a 300–700 Hz band (where the decay knob is defined) in 50 ms
  // windows: the slope between −5 and −25 dB should match RT60 = d.
  const band = bandEnvelope(ir, 500, SR);
  const win = Math.floor(SR * 0.05), E = [];
  for (let i = 0; i + win <= band.length; i += win) { let s = 0; for (let j = 0; j < win; j++) s += band[i + j]; E.push(s); }
  const mx = Math.max(...E), lev = E.map((e) => 10 * Math.log10(e / mx + 1e-30));
  const iMax = lev.indexOf(0);
  const tAt = (thr) => { for (let i = iMax; i < lev.length; i++) if (lev[i] < thr) return i * 0.05; return null; };
  const t5 = tAt(-5), t25 = tAt(-25);
  const rt = t5 != null && t25 != null ? (t25 - t5) * 3 : NaN;   // 20 dB span × 3 = 60 dB
  check(`decay ${d}s → measured low-mid RT60 within ±30%`, Math.abs(rt - d) / d < 0.3, `${rt.toFixed(2)} s`);
}
check('decay is clamped to the knob range', buildSpringIR(SR, 99).length === springIRLength(SR, SPRING_DECAY_MAX)
  && buildSpringIR(SR, 0).length === springIRLength(SR, SPRING_DECAY_MIN));

section('spring IR — dispersion + band limit');
{
  const ir = buildSpringIR(SR, 2.5);
  // Arrival time (energy centroid) of the first traversal per band.
  const arr = (fc) => {
    const env = bandEnvelope(ir, fc, SR);
    let num = 0, den = 0;
    for (let i = Math.floor(SR * 0.02); i < Math.floor(SR * 0.07); i++) { num += env[i] * i; den += env[i]; }
    return num / den / SR * 1000;
  };
  const t = [200, 500, 1000, 2000, 3500].map(arr);
  const descending = t.every((v, i) => i === 0 || v < t[i - 1]);
  check('descending chirp: each higher band arrives earlier', descending, t.map((v) => v.toFixed(1)).join(' > ') + ' ms');
  check('chirp spread 200 Hz → 3.5 kHz is audible (> 4 ms)', t[0] - t[4] > 4, `${(t[0] - t[4]).toFixed(1)} ms`);

  // A real pan passes almost nothing above its transition (~4.6 kHz).
  const spec = powerSpectrum(ir.subarray(0, 1 << 16));
  const bin = (f) => Math.round(f / SR * (1 << 16));
  const sum = (a, b) => { let s = 0; for (let k = bin(a); k < bin(b); k++) s += spec[k]; return s / (bin(b) - bin(a)); };
  const pass = sum(800, 2500), stop = sum(8000, 16000), low = sum(20, 50);
  check('band-limited: 8–16 kHz ≥ 40 dB under the 0.8–2.5 kHz passband', 10 * Math.log10(stop / pass) < -40, `${(10 * Math.log10(stop / pass)).toFixed(1)} dB`);
  check('low cut: 20–50 Hz ≥ 15 dB under the passband', 10 * Math.log10(low / pass) < -15, `${(10 * Math.log10(low / pass)).toFixed(1)} dB`);
}

// ── input calibration ────────────────────────────────────────────────────────
section('calTrimFor');
check('default interface is +12 dBu (the NAM plugin default)', CAL_DEFAULT_INTERFACE_DBU === 12);
check('+12 dBu interface, +6 dBu capture → +6 dB into the model', near(dB(calTrimFor(6, 12)), 6, 1e-9));
check('hotter capture than interface → cut', near(dB(calTrimFor(18, 12)), -6, 1e-9));
check('matched levels → unity', calTrimFor(12, 12) === 1);
check('undeclared capture level → exactly 1', calTrimFor(null, 12) === 1 && calTrimFor(undefined, 12) === 1 && calTrimFor(NaN, 12) === 1);
check(`clamped to ±${CAL_MAX_DB} dB`, near(dB(calTrimFor(-40, 12)), CAL_MAX_DB, 1e-9) && near(dB(calTrimFor(80, 12)), -CAL_MAX_DB, 1e-9));

section('parseAmpModel — calibration + gear metadata');
{
  // Smallest valid NAM LSTM (hidden 2): 4H(1+H) + 4H + H + 1 weights.
  const H = 2, need = 4 * H * (1 + H) + 4 * H + H + 1;
  const mk = (metadata) => ({ architecture: 'LSTM', config: { hidden_size: H, input_size: 1, num_layers: 1 },
    weights: Array.from({ length: need }, (_, i) => ((i * 37) % 11) / 50 - 0.1), metadata });
  const a = parseAmpModel(mk({ input_level_dbu: 6.5, gear_type: 'amp_cab', loudness: -20 }));
  check('NAM capture parses', a.ok, a.reason);
  check('input_level_dbu carried through', a.inputLevelDbu === 6.5, `${a.inputLevelDbu}`);
  check('gear_type amp_cab is a full rig (cab auto-bypass)', a.gearType === 'amp_cab' && isFullRigGearType(a.gearType));
  const b = parseAmpModel(mk({ input_level_dbu: '9' }));
  check('numeric-string input level accepted', b.inputLevelDbu === 9, `${b.inputLevelDbu}`);
  const c = parseAmpModel(mk({ gear_type: 'amp' }));
  check('no declared input level → null (uncalibrated, never guessed)', c.inputLevelDbu === null);
  check('gear_type amp is not a full rig', !isFullRigGearType(c.gearType));
  const d = parseAmpModel(mk(undefined));
  check('no metadata at all → null level, null gear type', d.ok && d.inputLevelDbu === null && d.gearType === null);
}

// ── strip defaults ───────────────────────────────────────────────────────────
section('rig-strip defaults');
{
  const order = Object.keys(STRIP_DEFAULTS);
  check('spring stage exists, off by default', STRIP_DEFAULTS.spring && STRIP_DEFAULTS.spring.on === false);
  check('spring sits between the drives and the amp (chain order)',
    order.indexOf('metalGate') < order.indexOf('spring') && order.indexOf('spring') < order.indexOf('amp'), order.join(' → '));
  check('room reverb stays post-cab', order.indexOf('cab') < order.indexOf('reverb'));
  check('input calibration defaults ON', STRIP_DEFAULTS.amp.cal === true);
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exitCode = 1; }
else console.log('\nall spring + calibration checks passed');

// ── helpers ──────────────────────────────────────────────────────────────────
// Squared output of a 2nd-order band-pass (RBJ, Q≈2.9 ≈ half-octave) — a band
// energy envelope, enough to time arrivals and measure decay per band.
function bandEnvelope(x, fc, sr) {
  const w0 = 2 * Math.PI * fc / sr, Q = 2.9, alpha = Math.sin(w0) / (2 * Q), cs = Math.cos(w0);
  const a0 = 1 + alpha, b0 = alpha / a0, b2 = -alpha / a0, a1 = -2 * cs / a0, a2 = (1 - alpha) / a0;
  const out = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    out[i] = y * y;
  }
  return out;
}
// |X(k)|² via a plain radix-2 FFT (length must be a power of two).
function powerSpectrum(x) {
  const n = x.length, re = Float64Array.from(x), im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const h = size >> 1, ang = -2 * Math.PI / size;
    for (let s = 0; s < n; s += size) for (let k = 0; k < h; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = s + k, b = a + h;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  const p = new Float64Array(n >> 1);
  for (let k = 0; k < p.length; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}
