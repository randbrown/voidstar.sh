// Rig channel strip — a native Web Audio signal chain for the rig's live
// instrument signal. Runs in the looper's OWN AudioContext (native nodes only —
// Tone's wrapped context can't host the recorder worklet, and these nodes don't
// need it). Fixed-order series chain with parallel send-style time fx:
//
//   in → HPF → earth → metal → comp → EQ(lo/mid/hi) → ┬→ dry ───────────────┐
//                                              ├→ delay (ping-pong) ──┤→ pan → out
//                                              └→ reverb (convolver) ─┘
//
// Every stage BYPASSES to a clean pass-through (neutral params / zero wet), so
// toggling a stage never re-wires the graph or interrupts audio. The strip is
// rebuilt whenever the rig capture (re)opens; looper.js owns the persisted
// config and re-applies it via setConfig().

export const STRIP_DEFAULTS = {
  hpf:    { on: false, freq: 80 },
  earth:  { on: false, drive: 0.35, tone: 0.6, level: 1.0 },
  metal:  { on: false, drive: 0.35, low: 0, mid: 0, midFreq: 600, high: 0, level: 1.0 },
  comp:   { on: false, threshold: -18, ratio: 3, attack: 0.003, release: 0.25 },
  eq:     { on: false, low: 0, mid: 0, high: 0 },
  amp:    { on: false, gain: 1, mix: 1, level: 1 },
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

// Earth Drive-voiced curve: lower gain, ASYMMETRIC soft clip (a DC bias before
// the tanh adds the even harmonics of a JFET stage), so it stays transparent
// and touch-dynamic rather than fuzzy.
function makeEarthCurve(amount) {
  const n = 2048, c = new Float32Array(n);
  const g = 1 + clamp(amount, 0, 1) * 12;
  const bias = 0.12;
  const off = Math.tanh(g * bias);
  const norm = Math.tanh(g * (1 + bias)) - off || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh(g * (x + bias)) - off) / norm;
  }
  return c;
}

// Metal Zone-voiced curve: high gain, harder (near-square) symmetric clip; two
// of these cascade for the MT-2's saturation wall.
function makeMetalCurve(amount) {
  const n = 2048, c = new Float32Array(n);
  const g = 2 + clamp(amount, 0, 1) * 30;
  const norm = Math.tanh(g) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(g * x) / norm;
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

  // Earth Drive — single waveshaper (asymmetric JFET curve) + tone LPF + level.
  const earthPre   = ctx.createGain();
  const earthShaper = ctx.createWaveShaper(); earthShaper.oversample = '4x';
  const earthTone  = ctx.createBiquadFilter(); earthTone.type = 'lowpass'; earthTone.Q.value = 0.707;
  const earthPost  = ctx.createGain();

  // Metal Zone — cascaded waveshapers (hard symmetric clip) + 3-band parametric
  // EQ (the MT-2's active EQ with sweepable mid) + level.
  const metalPre    = ctx.createGain();
  const metalShaper1 = ctx.createWaveShaper(); metalShaper1.oversample = '4x';
  const metalStage  = ctx.createGain();
  const metalShaper2 = ctx.createWaveShaper(); metalShaper2.oversample = '4x';
  const mLow  = ctx.createBiquadFilter(); mLow.type = 'lowshelf';  mLow.frequency.value = 100;
  const mMid  = ctx.createBiquadFilter(); mMid.type = 'peaking';   mMid.frequency.value = 600; mMid.Q.value = 0.7;
  const mHigh = ctx.createBiquadFilter(); mHigh.type = 'highshelf'; mHigh.frequency.value = 3500;
  const metalPost   = ctx.createGain();

  // Compressor
  const comp = ctx.createDynamicsCompressor();

  // EQ: low shelf · mid peak · high shelf. The "hi" shelf corners at 3.2 kHz —
  // the presence/treble band where guitar + pedal-steel brightness actually
  // lives. (A 4.5 kHz corner sat in the cab's rolloff, so boosting it was nearly
  // inaudible once an IR was loaded; 3.2 kHz makes the control clearly do work.)
  const eqLow  = ctx.createBiquadFilter(); eqLow.type  = 'lowshelf';  eqLow.frequency.value  = 180;
  const eqMid  = ctx.createBiquadFilter(); eqMid.type  = 'peaking';   eqMid.frequency.value  = 1000; eqMid.Q.value = 0.9;
  const eqHigh = ctx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3200;

  // Neural amp — LSTM capture inference in an AudioWorklet, as a dry/wet insert
  // after the EQ (transparent until a model is loaded; never blocks the graph if
  // the worklet isn't available). amp → cab is the natural order.
  const ampIn  = ctx.createGain();
  const ampDrive = ctx.createGain();   // input drive INTO the model — how hard you
                                       // hit the (nonlinear) capture, like a real
                                       // amp's gain knob; output `level` is makeup.
  const ampDry = ctx.createGain();
  const ampWet = ctx.createGain();
  const ampSum = ctx.createGain();
  let neural = null, ampLoaded = false;
  try {
    neural = new AudioWorkletNode(ctx, 'neural-amp', {
      numberOfInputs: 1, numberOfOutputs: 1,
      channelCountMode: 'explicit', channelCount: 1, outputChannelCount: [1],
    });
  } catch { neural = null; }

  // Cab / IR loader — convolution insert after the amp (dry/wet so bypass = dry,
  // and it's transparent until an IR is loaded). Sits before the time fx so
  // delay / reverb sit on the cab'd tone.
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
  // Earth stage: HPF → earthPre → shaper → tone LPF → earthPost
  hpf.connect(earthPre);
  earthPre.connect(earthShaper);
  earthShaper.connect(earthTone);
  earthTone.connect(earthPost);
  // Metal stage: earthPost → metalPre → shaper1 → stage gain → shaper2 → 3-band EQ → metalPost
  earthPost.connect(metalPre);
  metalPre.connect(metalShaper1);
  metalShaper1.connect(metalStage);
  metalStage.connect(metalShaper2);
  metalShaper2.connect(mLow);
  mLow.connect(mMid);
  mMid.connect(mHigh);
  mHigh.connect(metalPost);
  metalPost.connect(comp);
  comp.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);

  eqHigh.connect(ampIn);
  ampIn.connect(ampDry); ampDry.connect(ampSum);
  // Drive only feeds the wet (model) path — the dry blend stays unity so `mix`
  // crossfades cleanly and bypass is exactly the input.
  if (neural) { ampIn.connect(ampDrive); ampDrive.connect(neural); neural.connect(ampWet); ampWet.connect(ampSum); }
  ampSum.connect(cabIn);
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
  function applyEarth() {
    const d = state.earth;
    if (!d.on) {
      earthShaper.curve = IDENTITY_CURVE;
      earthPre.gain.value = 1; earthPost.gain.value = 1;
      earthTone.frequency.value = 20000;
      return;
    }
    const drive = clamp(d.drive, 0, 1), level = clamp(d.level, 0, 1), tone = clamp(d.tone, 0, 1);
    // Earth Drive — asymmetric JFET soft clip, transparent and touch-dynamic.
    earthPre.gain.value = 1 + drive * 8;
    earthShaper.curve = makeEarthCurve(drive);
    earthTone.frequency.value = 1200 * Math.pow(2, tone * 3.2);   // ~1.2k..11k
    earthPost.gain.value = level;
  }
  function applyMetal() {
    const d = state.metal;
    mLow.gain.value = 0; mMid.gain.value = 0; mHigh.gain.value = 0;
    if (!d.on) {
      metalShaper1.curve = IDENTITY_CURVE; metalShaper2.curve = IDENTITY_CURVE;
      metalPre.gain.value = 1; metalStage.gain.value = 1; metalPost.gain.value = 1;
      return;
    }
    const drive = clamp(d.drive, 0, 1), level = clamp(d.level, 0, 1);
    // Metal Zone — cascaded high-gain clipping + active 3-band EQ with a
    // sweepable parametric mid (the heart of the MT-2's voice).
    metalPre.gain.value = 1 + drive * 16;
    metalShaper1.curve = makeMetalCurve(0.55 + drive * 0.45);
    metalStage.gain.value = 1 + drive * 6;
    metalShaper2.curve = makeMetalCurve(0.6 + drive * 0.4);
    mLow.gain.value  = clamp(d.low, -15, 15);
    mMid.frequency.value = clamp(d.midFreq, 200, 5000);
    mMid.gain.value  = clamp(d.mid, -15, 15);
    mHigh.gain.value = clamp(d.high, -15, 15);
    metalPost.gain.value = level;
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
  function applyAmp() {
    const active = state.amp.on && ampLoaded && !!neural;
    if (neural) { try { neural.port.postMessage({ cmd: 'bypass', on: !active }); } catch {} }
    const mix = clamp(state.amp.mix, 0, 1);
    ampDrive.gain.value = clamp(state.amp.gain, 0, 4);   // input drive into the model
    ampDry.gain.value = active ? (1 - mix) : 1;
    ampWet.gain.value = active ? mix * clamp(state.amp.level, 0, 2) : 0;
  }
  function setAmpModel(model) {
    if (!neural) return false;
    if (!model) { ampLoaded = false; try { neural.port.postMessage({ cmd: 'clear' }); } catch {} applyAmp(); return false; }
    try { neural.port.postMessage({ cmd: 'load', model }); ampLoaded = true; } catch { ampLoaded = false; }
    applyAmp();
    return ampLoaded;
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
  function applyAll() { applyHpf(); applyEarth(); applyMetal(); applyComp(); applyEq(); applyAmp(); applyCab(); applyDelay(); applyReverb(); applyPan(); }

  const APPLY = { hpf: applyHpf, earth: applyEarth, metal: applyMetal, comp: applyComp, eq: applyEq, amp: applyAmp, cab: applyCab, delay: applyDelay, reverb: applyReverb, pan: applyPan };

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
    for (const n of [input, hpf,
                     earthPre, earthShaper, earthTone, earthPost,
                     metalPre, metalShaper1, metalStage, metalShaper2,
                     mLow, mMid, mHigh, metalPost, comp,
                     eqLow, eqMid, eqHigh, ampIn, ampDrive, ampDry, ampWet, ampSum,
                     cabIn, cabConv, cabDry, cabWet, cabSum,
                     fxIn, dry, sum, delaySend, delayL, delayR, delayFb, merger,
                     delayWet, reverbSend, convolver, reverbWet, panner, output]) {
      try { n.disconnect(); } catch {}
    }
    try { neural?.disconnect(); } catch {}
  }

  return { input, output, setParam, setEnabled, setConfig, getConfig, setCabBuffer, setAmpModel, dispose };
}
