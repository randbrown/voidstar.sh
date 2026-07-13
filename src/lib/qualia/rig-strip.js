// Rig channel strip — a native Web Audio signal chain for the rig's live
// instrument signal. Runs in the looper's OWN AudioContext (native nodes only —
// Tone's wrapped context can't host the recorder worklet, and these nodes don't
// need it). Fixed-order series chain, laid out like a physical pedalboard:
//
//   in → GEQ(7-band) → comp → earth → metal → amp → EQ(lo/mid/hi) → cab
//      → HPF → delay (p-pong) → reverb (conv.) → PEQ(8-band) → pan → out
//
// The three EQs are deliberately SPREAD along the chain, one job each:
// - geq (GE-7-style graphic) sits at the FRONT, shaping the instrument before
//   the comp and drives — pre-drive EQ changes what the distortion chews on.
// - eq (broad 3-knob tone) sits BETWEEN amp and cab, like an FX-loop tone
//   stack: the neural amp captures bake in the amp's own tone stack, so this
//   shapes the amp'd tone before the speaker rolls it off.
// - peq (ReaEQ-style surgical parametric) sits at the OUTPUT, after the time
//   fx — the place to notch ringing / feedback / room resonances on the full
//   wet signal actually leaving the rig.
// Nonlinear stages (drives, amp) and the cab sit between them, so their
// positions are genuinely audible — this is not the old adjacent-series
// arrangement where relative EQ order was inaudible.
//
// The HPF sits POST-cab: its job is de-woofing the cab'd tone (low buildup /
// proximity mud), not protecting the drives — and it keeps that mud out of the
// delay/reverb wash. Delay feeds reverb IN SERIES (not parallel sends), so the
// echoes get reverberated too: repeats and dry share the same room, and the
// two mixes ride together naturally. Comp sits up front as an instrument
// compressor (clarity / attack / bringing up low notes into the drives);
// output limiting deliberately stays at the mixer (see limiter.js) — a second
// in-strip limiter would double-process and add lookahead latency here.
// All EQ stages live permanently in the path, bypassing to bit-transparent
// neutral (gain 0 peaking) — zero added latency and no graph rewiring on
// toggle.
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

// ── Graphic EQ (geq) — Boss GE-7 voicing ─────────────────────────────────
// Seven octave-spaced peaking bands (100 Hz…6.4 kHz, ±15 dB) + an overall
// level (±15 dB), matching the pedal's sliders. Fixed Q ≈ octave bandwidth so
// adjacent sliders sum smoothly like the hardware.
export const GEQ_FREQS = [100, 200, 400, 800, 1600, 3200, 6400];
const GEQ_Q = 1.7;

// ── Parametric EQ (peq) — ReaEQ-style surgical bands ─────────────────────
// Eight fully parametric bands, each with its own enable, filter type, freq,
// gain, and Q. Bands 1–4 default ON at gain 0 (a flat, ready-to-grab curve à la
// ReaEQ's four starter bands); 5–8 sit dormant at surgical-notch Q for cuts.
export const PEQ_BAND_COUNT = 8;
// UI type id → BiquadFilterNode type. (Shelves ignore Q per the Web Audio
// spec; lopass/hipass interpret Q in dB of corner resonance.)
export const PEQ_TYPES = {
  peak:    'peaking',
  loshelf: 'lowshelf',
  hishelf: 'highshelf',
  lopass:  'lowpass',
  hipass:  'highpass',
  notch:   'notch',
};
export function defaultPeqBands() {
  return [
    { on: true,  type: 'loshelf', freq: 120,   gain: 0, q: 0.71 },
    { on: true,  type: 'peak',    freq: 500,   gain: 0, q: 1.4  },
    { on: true,  type: 'peak',    freq: 2000,  gain: 0, q: 1.4  },
    { on: true,  type: 'hishelf', freq: 8000,  gain: 0, q: 0.71 },
    { on: false, type: 'peak',    freq: 160,   gain: 0, q: 4    },
    { on: false, type: 'peak',    freq: 1000,  gain: 0, q: 4    },
    { on: false, type: 'peak',    freq: 4000,  gain: 0, q: 4    },
    { on: false, type: 'peak',    freq: 12000, gain: 0, q: 4    },
  ];
}
/** Normalize a persisted/foreign bands array to PEQ_BAND_COUNT fresh, clamped
 *  band objects (never aliases the input or the defaults — safe to mutate). */
export function sanitizePeqBands(bands) {
  const defs = defaultPeqBands();
  const src = Array.isArray(bands) ? bands : [];
  return defs.map((d, i) => {
    const b = (src[i] && typeof src[i] === 'object') ? src[i] : {};
    return {
      on:   b.on != null ? !!b.on : d.on,
      type: PEQ_TYPES[b.type] ? b.type : d.type,
      freq: clamp(b.freq != null ? b.freq : d.freq, 20, 20000),
      gain: clamp(b.gain != null ? b.gain : d.gain, -24, 24),
      q:    clamp(b.q != null ? b.q : d.q, 0.1, 36),
    };
  });
}

export const STRIP_DEFAULTS = {   // listed in chain order
  geq:    { on: false, b100: 0, b200: 0, b400: 0, b800: 0, b1600: 0, b3200: 0, b6400: 0, level: 0 },
  comp:   { on: false, threshold: -18, ratio: 3, attack: 0.003, release: 0.25 },
  earth:  { on: false, drive: 0.35, tone: 0.6, level: 1.0 },
  metal:  { on: false, drive: 0.35, low: 0, mid: 0, midFreq: 600, high: 0, level: 1.0 },
  amp:    { on: false, gain: 1, mix: 1, level: 1 },
  eq:     { on: false, low: 0, mid: 0, high: 0 },
  cab:    { on: false, mix: 1, level: 1 },
  hpf:    { on: false, freq: 80 },
  delay:  { on: false, time: 0.3, feedback: 0.35, mix: 0.25 },
  reverb: { on: false, decay: 2.0, mix: 0.25 },
  peq:    { on: false, bands: defaultPeqBands() },
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
  // deepMerge is shallow per-stage — re-materialize the peq band array so the
  // strip never aliases (or mutates) STRIP_DEFAULTS or the caller's config.
  state.peq.bands = sanitizePeqBands(state.peq.bands);

  const input  = ctx.createGain();
  const output = ctx.createGain();

  // HPF — post-cab: attenuates cab woof / low buildup before the time fx.
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

  // Compressor — up front (post-geq, pre-drives) as an instrument compressor:
  // evens picking dynamics, brings up low notes / attack into the drives.
  // Unlike the other stages this one HARD-bypasses (rewired out of
  // the path, not set transparent): Chromium's DynamicsCompressor imposes its
  // ~6 ms lookahead pre-delay even at ratio 1 / threshold 0, so "transparent"
  // still costs monitoring latency. `compIn` is the routing point — it feeds
  // either comp or earthPre directly — and its gain doubles as the click-masking
  // dip around the rewire (see routeComp).
  const compIn = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();

  // EQ: low shelf · mid peak · high shelf — BETWEEN amp and cab, an FX-loop
  // tone stack on the amp'd signal. The "hi" shelf corners at 3.2 kHz, the
  // presence/treble band where guitar + pedal-steel brightness lives.
  const eqLow  = ctx.createBiquadFilter(); eqLow.type  = 'lowshelf';  eqLow.frequency.value  = 180;
  const eqMid  = ctx.createBiquadFilter(); eqMid.type  = 'peaking';   eqMid.frequency.value  = 1000; eqMid.Q.value = 0.9;
  const eqHigh = ctx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3200;

  // Graphic EQ (geq): 7 fixed peaking bands + level — the FRONT of the chain,
  // shaping the raw instrument before comp and drives. Parametric EQ (peq):
  // 8 configurable bands — the OUTPUT end, after the time fx. Both live
  // permanently in the series chain — biquads are native and effectively
  // free — and bypass to bit-transparent neutral (peaking @ gain 0), so
  // toggling never re-wires the graph. IIR biquads are causal: neither stage
  // adds ANY latency, on or off.
  const geqFilters = GEQ_FREQS.map((f) => {
    const n = ctx.createBiquadFilter();
    n.type = 'peaking'; n.frequency.value = f; n.Q.value = GEQ_Q; n.gain.value = 0;
    return n;
  });
  const geqLevel = ctx.createGain();
  const peqFilters = [];
  for (let i = 0; i < PEQ_BAND_COUNT; i++) {
    const n = ctx.createBiquadFilter();
    n.type = 'peaking'; n.gain.value = 0;
    peqFilters.push(n);
  }
  // Spectrum taps for the peq editor: pre = the signal entering the peq (the
  // full post-reverb wet mix), post = the signal leaving it (what actually
  // reaches pan → out). Analysers are pure sinks — the FFT only runs when the
  // editor actually reads them, so they're free while the panel is closed.
  const peqPreTap  = ctx.createAnalyser();
  const peqPostTap = ctx.createAnalyser();
  for (const a of [peqPreTap, peqPostTap]) {
    a.fftSize = 8192;                 // ~5.9 Hz/bin at 48 kHz — enough for the low octaves
    a.smoothingTimeConstant = 0.8;    // ReaEQ-ish easing on the display
  }

  // Neural amp — LSTM capture inference in an AudioWorklet, as a dry/wet insert
  // after the drives (transparent until a model is loaded; never blocks the
  // graph if the worklet isn't available). amp → eq → cab is the natural order.
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

  // Cab / IR loader — convolution insert after amp + tone-stack eq (dry/wet so
  // bypass = dry, and it's transparent until an IR is loaded). Sits before the
  // time fx so delay / reverb sit on the cab'd tone.
  const cabIn  = ctx.createGain();
  const cabConv = ctx.createConvolver();
  const cabDry = ctx.createGain();
  const cabWet = ctx.createGain();
  const cabSum = ctx.createGain();
  let cabBuf = null;

  // Time fx — two SERIES inserts (each dry + wet, wet gain = mix), delay first:
  // the delay's output (dry + repeats) feeds the reverb, so echoes get
  // reverberated too — repeats and dry share the same room, like a pedalboard.

  // Stereo ping-pong delay insert: in → delayL → [L], delayL → delayR → [R],
  // delayR → feedback → delayL; merged wet sums with the dry pass-through.
  const delayIn   = ctx.createGain();
  const delayDry  = ctx.createGain();
  const delaySum  = ctx.createGain();
  const delayL    = ctx.createDelay(5.0);
  const delayR    = ctx.createDelay(5.0);
  const delayFb   = ctx.createGain();
  const merger    = ctx.createChannelMerger(2);
  const delayWet  = ctx.createGain();

  // Convolution reverb insert (generated decaying-noise IR).
  const reverbIn  = ctx.createGain();
  const reverbDry = ctx.createGain();
  const reverbSum = ctx.createGain();
  const convolver  = ctx.createConvolver();
  const reverbWet  = ctx.createGain();

  // Pan
  const panner = ctx.createStereoPanner();

  // ── wire the graph ──
  // Front-of-chain graphic EQ: input → 7 peaking bands → level trim.
  let geqTail = input;
  for (const n of geqFilters) { geqTail.connect(n); geqTail = n; }
  geqTail.connect(geqLevel);
  // Comp fork: geqLevel → compIn → (comp | direct) → earthPre; routeComp()
  // owns the fork.
  geqLevel.connect(compIn);
  comp.connect(earthPre);
  // Earth stage: earthPre → shaper → tone LPF → earthPost
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
  metalPost.connect(ampIn);
  ampIn.connect(ampDry); ampDry.connect(ampSum);
  // Drive only feeds the wet (model) path — the dry blend stays unity so `mix`
  // crossfades cleanly and bypass is exactly the input.
  if (neural) { ampIn.connect(ampDrive); ampDrive.connect(neural); neural.connect(ampWet); ampWet.connect(ampSum); }
  // Tone-stack EQ between amp and cab.
  ampSum.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(cabIn);
  cabIn.connect(cabDry); cabDry.connect(cabSum);
  cabIn.connect(cabConv); cabConv.connect(cabWet); cabWet.connect(cabSum);
  // Post-cab HPF → time fx in series: delay insert, then reverb insert.
  cabSum.connect(hpf);
  hpf.connect(delayIn);
  delayIn.connect(delayDry); delayDry.connect(delaySum);
  delayIn.connect(delayL);
  delayL.connect(merger, 0, 0);
  delayL.connect(delayR);
  delayR.connect(merger, 0, 1);
  delayR.connect(delayFb);
  delayFb.connect(delayL);
  merger.connect(delayWet);
  delayWet.connect(delaySum);

  delaySum.connect(reverbIn);
  reverbIn.connect(reverbDry); reverbDry.connect(reverbSum);
  reverbIn.connect(convolver);
  convolver.connect(reverbWet);
  reverbWet.connect(reverbSum);

  // Output surgical EQ: reverbSum → 8 parametric bands → pan → out.
  let peqTail = reverbSum;
  for (const n of peqFilters) { peqTail.connect(n); peqTail = n; }
  peqTail.connect(panner);
  reverbSum.connect(peqPreTap);   // spectrum taps (sinks) for the peq editor
  peqTail.connect(peqPostTap);

  panner.connect(output);

  delayDry.gain.value = 1;
  reverbDry.gain.value = 1;

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
      // curve = null is the spec's true bypass. IDENTITY_CURVE clamps its input
      // to [-1,1], so an "off" drive would still hard-clip hot signals at
      // 0 dBFS (the pre-drive geq/level stages can exceed unity).
      earthShaper.curve = null;
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
      // curve = null (true bypass) — see applyEarth; IDENTITY_CURVE clamps at
      // 0 dBFS and would clip a hot input through an "off" stage.
      metalShaper1.curve = null; metalShaper2.curve = null;
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
  // Route compIn → comp (on) or compIn → earthPre (off). Rewiring the graph live
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
      compIn.connect(useComp ? comp : earthPre);
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
      compIn.connect(compRouted ? comp : earthPre);
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
  function applyGeq() {
    const on = state.geq.on;
    const t = ctx.currentTime;
    for (let i = 0; i < GEQ_FREQS.length; i++) {
      const g = on ? clamp(state.geq['b' + GEQ_FREQS[i]], -15, 15) : 0;
      geqFilters[i].gain.setTargetAtTime(g, t, 0.01);
    }
    const lvl = on ? Math.pow(10, clamp(state.geq.level, -15, 15) / 20) : 1;
    geqLevel.gain.setTargetAtTime(lvl, t, 0.01);
  }
  function applyPeq() {
    // Re-normalize only when the array shape is off (fresh load / foreign
    // config) — per-knob calls stay allocation-free.
    if (!Array.isArray(state.peq.bands) || state.peq.bands.length !== PEQ_BAND_COUNT) {
      state.peq.bands = sanitizePeqBands(state.peq.bands);
    }
    const on = state.peq.on;
    const t = ctx.currentTime;
    for (let i = 0; i < PEQ_BAND_COUNT; i++) {
      const node = peqFilters[i];
      const b = state.peq.bands[i];
      if (!on || !b || !b.on) {
        // Bit-transparent neutral: a peaking band at gain 0 is an exact
        // pass-through, so a disabled band (or stage) costs nothing audible.
        node.type = 'peaking';
        node.gain.setTargetAtTime(0, t, 0.01);
        continue;
      }
      node.type = PEQ_TYPES[b.type] || 'peaking';
      node.frequency.setTargetAtTime(clamp(b.freq, 20, 20000), t, 0.01);
      node.Q.setTargetAtTime(clamp(b.q, 0.1, 36), t, 0.01);
      node.gain.setTargetAtTime(clamp(b.gain, -24, 24), t, 0.01);
    }
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
  function applyAll() { applyGeq(); applyComp(); applyEarth(); applyMetal(); applyAmp(); applyEq(); applyCab(); applyHpf(); applyDelay(); applyReverb(); applyPeq(); applyPan(); }

  const APPLY = { hpf: applyHpf, earth: applyEarth, metal: applyMetal, comp: applyComp, eq: applyEq, geq: applyGeq, peq: applyPeq, amp: applyAmp, cab: applyCab, delay: applyDelay, reverb: applyReverb, pan: applyPan };

  applyAll();

  function setParam(stage, param, value) {
    if (!state[stage]) return;
    // The peq bands array arrives whole (the panel editor mutates band objects
    // then re-sends the array) — take a normalized copy, never the caller's ref.
    state[stage][param] = (stage === 'peq' && param === 'bands') ? sanitizePeqBands(value) : value;
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
    state.peq.bands = sanitizePeqBands(state.peq.bands);
    applyAll();
  }
  function getConfig() {
    const out = deepMerge(state, null);
    out.peq.bands = sanitizePeqBands(state.peq.bands);   // fresh copy, no aliasing
    return out;
  }

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
    for (const n of [input, ...geqFilters, geqLevel, compIn, comp,
                     earthPre, earthShaper, earthTone, earthPost,
                     metalPre, metalShaper1, metalStage, metalShaper2,
                     mLow, mMid, mHigh, metalPost,
                     ampIn, ampDrive, ampDry, ampWet, ampSum,
                     eqLow, eqMid, eqHigh,
                     cabIn, cabConv, cabDry, cabWet, cabSum, hpf,
                     delayIn, delayDry, delayL, delayR, delayFb, merger,
                     delayWet, delaySum,
                     reverbIn, reverbDry, convolver, reverbWet, reverbSum,
                     ...peqFilters, peqPreTap, peqPostTap, panner, output]) {
      try { n.disconnect(); } catch {}
    }
    // Tell the neural-amp worklet to end its processor (returns false) so its
    // weight buffers GC instead of running for the AudioContext's lifetime —
    // the strip is rebuilt on every capture reopen.
    try { neural?.port?.postMessage({ cmd: 'dispose' }); } catch {}
    try { neural?.disconnect(); } catch {}
  }

  function getPeqAnalysers() { return { pre: peqPreTap, post: peqPostTap }; }

  return { input, output, setParam, setEnabled, setConfig, getConfig, getLatencySeconds, getPeqAnalysers, setCabBuffer, setAmpModel, dispose };
}
