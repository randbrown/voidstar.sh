// Rig channel strip — a native Web Audio signal chain for the rig's live
// instrument signal. Runs in the looper's OWN AudioContext (native nodes only —
// Tone's wrapped context can't host the recorder worklet, and these nodes don't
// need it). Fixed-order series chain with parallel send-style time fx:
//
//   in → HPF → drive → comp → EQ(lo/mid/hi) → ┬→ dry ───────────────┐
//                                              ├→ delay (ping-pong) ──┤→ pan → out
//                                              └→ reverb (convolver) ─┘
//
// Every stage BYPASSES to a clean pass-through (neutral params / zero wet), so
// toggling a stage never re-wires the graph or interrupts audio. The strip is
// rebuilt whenever the rig capture (re)opens; looper.js owns the persisted
// config and re-applies it via setConfig().

export const STRIP_DEFAULTS = {
  hpf:    { on: false, freq: 80 },
  drive:  { on: false, drive: 0.35, tone: 0.6, level: 1.0 },
  comp:   { on: false, threshold: -18, ratio: 3, attack: 0.003, release: 0.25 },
  eq:     { on: false, low: 0, mid: 0, high: 0 },
  cab:    { on: false, mix: 1, level: 1 },
  delay:  { on: false, time: 0.3, feedback: 0.35, mix: 0.25 },
  reverb: { on: false, decay: 2.0, mix: 0.25 },
  pan:    { pan: 0 },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

// Identity shaper curve (pass-through) — used when drive is off.
const IDENTITY_CURVE = (() => {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = (i / (n - 1)) * 2 - 1;
  return c;
})();

// Soft-clip (tanh) curve, normalised so the peak stays ~unity. `amount` 0..1.
function makeDriveCurve(amount) {
  const n = 2048, c = new Float32Array(n);
  const drive = 1 + clamp(amount, 0, 1) * 24;
  const norm = Math.tanh(drive) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / norm;
  }
  return c;
}

function deepMerge(base, over) {
  const out = {};
  for (const k of Object.keys(base)) {
    out[k] = (over && typeof over[k] === 'object' && over[k])
      ? { ...base[k], ...over[k] }
      : { ...base[k] };
  }
  return out;
}

export function createRigStrip(ctx, cfg) {
  const state = deepMerge(STRIP_DEFAULTS, cfg);

  const input  = ctx.createGain();
  const output = ctx.createGain();

  // HPF
  const hpf = ctx.createBiquadFilter();
  hpf.type = 'highpass'; hpf.Q.value = 0.707;

  // Drive: pre-gain → waveshaper (4× oversample) → tone LPF → post-gain
  const drivePre  = ctx.createGain();
  const shaper    = ctx.createWaveShaper(); shaper.oversample = '4x';
  const driveTone = ctx.createBiquadFilter(); driveTone.type = 'lowpass'; driveTone.Q.value = 0.707;
  const drivePost = ctx.createGain();

  // Compressor
  const comp = ctx.createDynamicsCompressor();

  // EQ: low shelf · mid peak · high shelf
  const eqLow  = ctx.createBiquadFilter(); eqLow.type  = 'lowshelf';  eqLow.frequency.value  = 180;
  const eqMid  = ctx.createBiquadFilter(); eqMid.type  = 'peaking';   eqMid.frequency.value  = 1000; eqMid.Q.value = 0.9;
  const eqHigh = ctx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4500;

  // Cab / IR loader — convolution insert after EQ (dry/wet so bypass = dry, and
  // it's transparent until an IR is loaded). Sits before the time fx so delay /
  // reverb sit on the cab'd tone.
  const cabIn  = ctx.createGain();
  const cabConv = ctx.createConvolver();
  const cabDry = ctx.createGain();
  const cabWet = ctx.createGain();
  const cabSum = ctx.createGain();
  let cabBuf = null;

  // Time-fx split: post-cab fans to dry + delay send + reverb send, summed pre-pan.
  const fxIn = ctx.createGain();
  const dry  = ctx.createGain();
  const sum  = ctx.createGain();

  // Stereo ping-pong delay: send → delayL → [L], delayL → delayR → [R],
  // delayR → feedback → delayL.
  const delaySend = ctx.createGain();
  const delayL    = ctx.createDelay(5.0);
  const delayR    = ctx.createDelay(5.0);
  const delayFb   = ctx.createGain();
  const merger    = ctx.createChannelMerger(2);
  const delayWet  = ctx.createGain();

  // Convolution reverb (generated decaying-noise IR).
  const reverbSend = ctx.createGain();
  const convolver  = ctx.createConvolver();
  const reverbWet  = ctx.createGain();

  // Pan
  const panner = ctx.createStereoPanner();

  // ── wire the graph ──
  input.connect(hpf);
  hpf.connect(drivePre);
  drivePre.connect(shaper);
  shaper.connect(driveTone);
  driveTone.connect(drivePost);
  drivePost.connect(comp);
  comp.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);

  eqHigh.connect(cabIn);
  cabIn.connect(cabDry); cabDry.connect(cabSum);
  cabIn.connect(cabConv); cabConv.connect(cabWet); cabWet.connect(cabSum);
  cabSum.connect(fxIn);

  fxIn.connect(dry); dry.connect(sum);

  fxIn.connect(delaySend);
  delaySend.connect(delayL);
  delayL.connect(merger, 0, 0);
  delayL.connect(delayR);
  delayR.connect(merger, 0, 1);
  delayR.connect(delayFb);
  delayFb.connect(delayL);
  merger.connect(delayWet);
  delayWet.connect(sum);

  fxIn.connect(reverbSend);
  reverbSend.connect(convolver);
  convolver.connect(reverbWet);
  reverbWet.connect(sum);

  sum.connect(panner);
  panner.connect(output);

  dry.gain.value = 1;

  // ── IR generation (debounced rebuild when decay changes) ──
  let irDecay = -1;
  function buildIR(decay) {
    const d = clamp(decay, 0.1, 8);
    if (d === irDecay) return;
    irDecay = d;
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * d));
    const ir = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
      }
    }
    try { convolver.buffer = ir; } catch {}
  }

  // ── per-stage apply (bypass = neutral) ──
  function applyHpf() {
    hpf.frequency.setTargetAtTime(state.hpf.on ? clamp(state.hpf.freq, 20, 1000) : 10, ctx.currentTime, 0.01);
  }
  function applyDrive() {
    if (state.drive.on) {
      shaper.curve = makeDriveCurve(state.drive.drive);
      drivePre.gain.value = 1;
      driveTone.frequency.value = 800 * Math.pow(2, clamp(state.drive.tone, 0, 1) * 4); // 800Hz..12.8kHz
      drivePost.gain.value = clamp(state.drive.level, 0, 1);
    } else {
      shaper.curve = IDENTITY_CURVE;
      drivePre.gain.value = 1;
      driveTone.frequency.value = 20000;
      drivePost.gain.value = 1;
    }
  }
  function applyComp() {
    const t = ctx.currentTime;
    if (state.comp.on) {
      comp.threshold.setTargetAtTime(clamp(state.comp.threshold, -60, 0), t, 0.01);
      comp.ratio.setTargetAtTime(clamp(state.comp.ratio, 1, 20), t, 0.01);
      comp.attack.setTargetAtTime(clamp(state.comp.attack, 0, 1), t, 0.01);
      comp.release.setTargetAtTime(clamp(state.comp.release, 0, 1), t, 0.01);
      comp.knee.value = 6;
    } else {
      comp.threshold.setTargetAtTime(0, t, 0.01);
      comp.ratio.setTargetAtTime(1, t, 0.01);   // ratio 1 = no compression
    }
  }
  function applyEq() {
    const on = state.eq.on;
    eqLow.gain.value  = on ? clamp(state.eq.low,  -15, 15) : 0;
    eqMid.gain.value  = on ? clamp(state.eq.mid,  -15, 15) : 0;
    eqHigh.gain.value = on ? clamp(state.eq.high, -15, 15) : 0;
  }
  function applyDelay() {
    const on = state.delay.on;
    const t = clamp(state.delay.time, 0.01, 2);
    delayL.delayTime.setTargetAtTime(t, ctx.currentTime, 0.02);
    delayR.delayTime.setTargetAtTime(t, ctx.currentTime, 0.02);
    delayFb.gain.value = on ? clamp(state.delay.feedback, 0, 0.95) : 0;
    delayWet.gain.value = on ? clamp(state.delay.mix, 0, 1) : 0;
  }
  function applyReverb() {
    buildIR(state.reverb.decay);
    reverbWet.gain.value = state.reverb.on ? clamp(state.reverb.mix, 0, 1) : 0;
  }
  function applyCab() {
    // Transparent until an IR is loaded; bypass (or no IR) = full dry, no wet.
    const active = state.cab.on && !!cabBuf;
    const mix = clamp(state.cab.mix, 0, 1);
    cabDry.gain.value = active ? (1 - mix) : 1;
    cabWet.gain.value = active ? mix * clamp(state.cab.level, 0, 2) : 0;
  }
  function setCabBuffer(buf) {
    cabBuf = buf || null;
    try { cabConv.buffer = cabBuf; } catch {}
    applyCab();
  }
  function applyPan() {
    panner.pan.setTargetAtTime(clamp(state.pan.pan, -1, 1), ctx.currentTime, 0.01);
  }
  function applyAll() { applyHpf(); applyDrive(); applyComp(); applyEq(); applyCab(); applyDelay(); applyReverb(); applyPan(); }

  const APPLY = { hpf: applyHpf, drive: applyDrive, comp: applyComp, eq: applyEq, cab: applyCab, delay: applyDelay, reverb: applyReverb, pan: applyPan };

  applyAll();

  function setParam(stage, param, value) {
    if (!state[stage]) return;
    state[stage][param] = value;
    (APPLY[stage] || applyAll)();
  }
  function setEnabled(stage, on) {
    if (!state[stage]) return;
    state[stage].on = !!on;
    (APPLY[stage] || applyAll)();
  }
  function setConfig(cfg) {
    if (!cfg) return;
    for (const k of Object.keys(state)) if (cfg[k]) Object.assign(state[k], cfg[k]);
    applyAll();
  }
  function getConfig() { return deepMerge(state, null); }

  function dispose() {
    for (const n of [input, hpf, drivePre, shaper, driveTone, drivePost, comp,
                     eqLow, eqMid, eqHigh, cabIn, cabConv, cabDry, cabWet, cabSum,
                     fxIn, dry, sum, delaySend, delayL, delayR, delayFb, merger,
                     delayWet, reverbSend, convolver, reverbWet, panner, output]) {
      try { n.disconnect(); } catch {}
    }
  }

  return { input, output, setParam, setEnabled, setConfig, getConfig, setCabBuffer, dispose };
}
