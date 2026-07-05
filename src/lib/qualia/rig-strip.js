// Rig channel strip — a native Web Audio signal chain for the rig's live
// instrument signal. Runs in the looper's OWN AudioContext (native nodes only —
// Tone's wrapped context can't host the recorder worklet, and these nodes don't
// need it). Fixed-order series chain with parallel send-style time fx:
//
//   in → HPF → earth → metal → comp → amp → cab → EQ(lo/mid/hi) → ┬→ dry ─────┐
//                                                         ├→ delay (ping-pong) ┤→ pan → out
//                                                         └→ reverb (convolver)┘
//
// EQ sits POST amp+cab on purpose: the neural amp captures bake in the amp's own
// tone stack (the model has no live EQ of its own), so a post-cab EQ is the only
// place to shape the final amp'd + cab'd tone — it acts as a true output tone
// control rather than a pre-amp stack.
//
// Every stage BYPASSES to a clean pass-through (neutral params / zero wet), so
// toggling a stage never re-wires the graph or interrupts audio — with one
// deliberate exception: the comp HARD-bypasses (rewired around, under a short
// gain dip), because a "transparent" DynamicsCompressor still delays the signal
// by its ~6 ms lookahead. Same reasoning drops the drives' 4x oversampling when
// they're off (the resamplers add ~4 ms group delay per shaper). A rig with
// everything off now adds no latency beyond the browser's capture/render/output
// floor. The strip is rebuilt whenever the rig capture (re)opens; looper.js
// owns the persisted config and re-applies it via setConfig().

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

// ── Earth/Metal output trims ──────────────────────────────────────────────
// Both drives run hot: heavy pre-gain pushes a unity-peak-normalised waveshaper,
// so saturation inflates loudness while `level` adds no compensating makeup.
// Measured AC-RMS gain at noon (drive 0.5, level 0.5, ref -12 dBFS sine) vs the
// dry/bypass path: Earth ~+18.7 dB, Metal ~+9.0 dB. (Earth's asymmetric JFET
// curve also injects a large DC offset, excluded here as inaudible.) These
// post-shaper trims pull noon back to ~unity — so the modelled drives match the
// reference hardware (a Sarno Earth sits at unity at noon) instead of jumping in
// level when engaged; the `level` knob then rides ~unity..+6 dB. Tune by ear if a
// given rig's input level differs.
const EARTH_OUT_TRIM = 0.12;   // -18.4 dB
const METAL_OUT_TRIM = 0.35;   // -9.1 dB

// ── Latency bookkeeping ───────────────────────────────────────────────────
// Two node types in this chain add REAL signal delay (group delay / lookahead),
// and both used to sit in the path even when bypassed. They're now taken out of
// the path when off (oversample dropped / comp hard-bypassed), so a clean rig
// only pays the browser's capture+render+output floor. These constants estimate
// what each stage adds when ON, for the UI latency readout + enable-time notes.
//
// - Oversampled WaveShaper: the 4x anti-alias resamplers are FIR filters with
//   ~192 frames of combined group delay in Chromium (two cascaded 2x stages,
//   ~half a 128-tap kernel per direction per stage). ~4 ms at 48 kHz.
// - DynamicsCompressor: Chromium runs a fixed ~6 ms lookahead pre-delay, even
//   when "transparent" (ratio 1 / threshold 0) — hence the hard bypass below.
const OS4X_LATENCY_FRAMES = 192;
const COMP_LOOKAHEAD_SEC  = 0.006;

/** Estimated added latency (seconds) for one strip stage when enabled. */
export function stageLatencySeconds(stage, sampleRate = 48000) {
  switch (stage) {
    case 'earth': return OS4X_LATENCY_FRAMES / sampleRate;        // 1 shaper
    case 'metal': return (2 * OS4X_LATENCY_FRAMES) / sampleRate;  // 2 cascaded shapers
    case 'comp':  return COMP_LOOKAHEAD_SEC;
    default:      return 0;
  }
}

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
  // Oversampling is set per-state in applyEarth/applyMetal: '4x' only while the
  // drive is ON. The 4x resamplers add ~4 ms of real group delay per shaper, so
  // a bypassed drive must not keep them in the path (bypass keeps the identity
  // curve, which needs no anti-aliasing anyway).
  const earthPre   = ctx.createGain();
  const earthShaper = ctx.createWaveShaper();
  const earthTone  = ctx.createBiquadFilter(); earthTone.type = 'lowpass'; earthTone.Q.value = 0.707;
  const earthPost  = ctx.createGain();

  // Metal Zone — cascaded waveshapers (hard symmetric clip) + 3-band parametric
  // EQ (the MT-2's active EQ with sweepable mid) + level.
  const metalPre    = ctx.createGain();
  const metalShaper1 = ctx.createWaveShaper();
  const metalStage  = ctx.createGain();
  const metalShaper2 = ctx.createWaveShaper();
  const mLow  = ctx.createBiquadFilter(); mLow.type = 'lowshelf';  mLow.frequency.value = 100;
  const mMid  = ctx.createBiquadFilter(); mMid.type = 'peaking';   mMid.frequency.value = 600; mMid.Q.value = 0.7;
  const mHigh = ctx.createBiquadFilter(); mHigh.type = 'highshelf'; mHigh.frequency.value = 3500;
  const metalPost   = ctx.createGain();

  // Compressor. Unlike the other stages this one HARD-bypasses (rewired out of
  // the path, not set transparent): Chromium's DynamicsCompressor imposes its
  // ~6 ms lookahead pre-delay even at ratio 1 / threshold 0, so "transparent"
  // still costs monitoring latency. `compIn` is the routing point — it feeds
  // either comp or ampIn directly — and its gain doubles as the click-masking
  // dip around the rewire (see routeComp).
  const compIn = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();

  // EQ: low shelf · mid peak · high shelf — now POST amp+cab (output tone stack).
  // The "hi" shelf corners at 3.2 kHz, the presence/treble band where guitar +
  // pedal-steel brightness lives; sitting after the cab it shapes the final mic'd
  // tone directly (a boost here adds audible air rather than feeding the amp).
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
  // comp → amp (EQ moved downstream of the cab; see chain diagram above).
  // metalPost → compIn → (comp | direct) → ampIn; routeComp() owns the fork.
  metalPost.connect(compIn);
  comp.connect(ampIn);
  ampIn.connect(ampDry); ampDry.connect(ampSum);
  // Drive only feeds the wet (model) path — the dry blend stays unity so `mix`
  // crossfades cleanly and bypass is exactly the input.
  if (neural) { ampIn.connect(ampDrive); ampDrive.connect(neural); neural.connect(ampWet); ampWet.connect(ampSum); }
  ampSum.connect(cabIn);
  cabIn.connect(cabDry); cabDry.connect(cabSum);
  cabIn.connect(cabConv); cabConv.connect(cabWet); cabWet.connect(cabSum);
  // Post-cab EQ → time-fx split.
  cabSum.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(fxIn);

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
  // Oversample only while a drive is ON (its resamplers add real group delay —
  // see OS4X_LATENCY_FRAMES). Guarded so knob drags (which re-run apply) don't
  // rebuild the resampler kernels on every tick.
  const setOversample = (node, want) => { if (node.oversample !== want) node.oversample = want; };
  function applyHpf() {
    hpf.frequency.setTargetAtTime(state.hpf.on ? clamp(state.hpf.freq, 20, 1000) : 10, ctx.currentTime, 0.01);
  }
  function applyEarth() {
    const d = state.earth;
    setOversample(earthShaper, d.on ? '4x' : 'none');
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
    earthPost.gain.value = level * EARTH_OUT_TRIM;   // makeup, calibrated to ~unity at noon
  }
  function applyMetal() {
    const d = state.metal;
    setOversample(metalShaper1, d.on ? '4x' : 'none');
    setOversample(metalShaper2, d.on ? '4x' : 'none');
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
    metalPost.gain.value = level * METAL_OUT_TRIM;   // makeup, calibrated to ~unity at noon
  }
  // Route compIn → comp (on) or compIn → ampIn (off). Rewiring the graph live
  // can click, so the swap happens inside a short gain dip on compIn (~6 ms
  // down, rewire, ~6 ms up — well under audibility as a gap). The dip also
  // masks the ~6 ms timeline jump from the comp's lookahead entering/leaving
  // the path. First call (build time) wires directly, no dip.
  const COMP_DIP_SEC = 0.006;
  let compRouted = null;   // null until first route; then boolean
  function routeComp(useComp) {
    if (compRouted === useComp) return;
    if (compRouted === null) {
      compRouted = useComp;
      compIn.connect(useComp ? comp : ampIn);
      return;
    }
    compRouted = useComp;
    const t = ctx.currentTime;
    compIn.gain.cancelScheduledValues(t);
    compIn.gain.setValueAtTime(compIn.gain.value, t);
    compIn.gain.linearRampToValueAtTime(0, t + COMP_DIP_SEC);
    setTimeout(() => {
      try { compIn.disconnect(); } catch {}
      // Re-check state: a fast double-toggle may have re-routed meanwhile.
      compIn.connect(compRouted ? comp : ampIn);
      const t2 = ctx.currentTime;
      compIn.gain.cancelScheduledValues(t2);
      compIn.gain.setValueAtTime(0, t2);
      compIn.gain.linearRampToValueAtTime(1, t2 + COMP_DIP_SEC);
    }, COMP_DIP_SEC * 1000 + 5);
  }
  function applyComp() {
    const t = ctx.currentTime;
    if (state.comp.on) {
      comp.threshold.setTargetAtTime(clamp(state.comp.threshold, -60, 0), t, 0.01);
      comp.ratio.setTargetAtTime(clamp(state.comp.ratio, 1, 20), t, 0.01);
      comp.attack.setTargetAtTime(clamp(state.comp.attack, 0, 1), t, 0.01);
      comp.release.setTargetAtTime(clamp(state.comp.release, 0, 1), t, 0.01);
      comp.knee.value = 6;
    }
    routeComp(!!state.comp.on);
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

  // Estimated latency this strip currently ADDS to the signal path (seconds),
  // from the stages that carry real delay when enabled (drive oversampling,
  // comp lookahead). Everything else in the chain is zero-latency: convolvers
  // (spec-mandated direct head), biquads, gains, the LSTM worklet (causal,
  // sample-by-sample). Feeds the rig panel's latency readout.
  function getLatencySeconds() {
    const sr = ctx.sampleRate || 48000;
    let s = 0;
    if (state.earth.on) s += stageLatencySeconds('earth', sr);
    if (state.metal.on) s += stageLatencySeconds('metal', sr);
    if (state.comp.on)  s += stageLatencySeconds('comp', sr);
    return s;
  }

  function dispose() {
    for (const n of [input, hpf,
                     earthPre, earthShaper, earthTone, earthPost,
                     metalPre, metalShaper1, metalStage, metalShaper2,
                     mLow, mMid, mHigh, metalPost, compIn, comp,
                     eqLow, eqMid, eqHigh, ampIn, ampDrive, ampDry, ampWet, ampSum,
                     cabIn, cabConv, cabDry, cabWet, cabSum,
                     fxIn, dry, sum, delaySend, delayL, delayR, delayFb, merger,
                     delayWet, reverbSend, convolver, reverbWet, panner, output]) {
      try { n.disconnect(); } catch {}
    }
    try { neural?.disconnect(); } catch {}
  }

  return { input, output, setParam, setEnabled, setConfig, getConfig, getLatencySeconds, setCabBuffer, setAmpModel, dispose };
}
