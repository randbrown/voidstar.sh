// Channel vocoder panel — mic input is the modulator, an internal sustained
// oscillator (or noise) is the carrier. Voice band envelopes shape matching
// carrier bands; the sum is what reaches the speakers.
//
// Design priority is intelligibility for live narration over a "creative"
// timbre — robotic but understandable. Intelligibility levers:
//   1. Dual carrier — the pitched carrier (saw/drone/...) voices vowels, but
//      fricatives ("s", "sh", "f") are noise: a pitched carrier turns them
//      into a tonal whistle. A pink-noise carrier is crossfaded in for the
//      high bands (the `consonant` control) so consonants read as noise.
//   2. Per-band envelope timing — high bands follow the voice fast enough to
//      catch consonant transients; low bands stay slow for smooth vowels.
//   3. Input conditioning — a high-pass + compressor before the filterbank
//      keep the modulator's dynamics even, so envelope following is stable.
//   4. Master post chain — clarity EQ (mud dip + presence lift), a
//      compressor and a limiter after the effect, so quiet syllables stay
//      audible and fat chords don't clip.
//   5. HF sibilance passthrough + optional dry mix — small amounts of raw
//      voice as extra intelligibility helpers.
//
// Architecture seam for 3rd-party Web Audio fx:
//   getInputNode()  — the GainNode immediately downstream of the mic source.
//                     Insert pre-vocoder fx (eq, gate, etc.) here.
//   getOutputNode() — the post-vocoder bus before output gain + mute gate.
//                     Insert post-fx (reverb, delay, ...) here.
//   getContext()    — the vocoder's own AudioContext. The whole graph runs in
//                     a private context so it can't accidentally route
//                     through the strudel mute-patch or the sequencer's
//                     Tone.js master.
//
// Mic device selection: the vocoder has its own picker on the panel. Its
// default — "same as main mic" — follows the page's topbar selector (via the
// getDeviceId callback); choosing a specific device pins the vocoder to a
// dedicated input independent of the visualizer's mic. The vocoder opens its
// own getUserMedia stream either way, so two captures of one physical mic can
// coexist when audio analysis is also on; modern browsers handle this fine.
//
// Feed-to-modulation: when the panel's "feed" toggle is on, the vocoded
// output is tapped (post output-gain, post-mute) by an AnalyserNode exposed
// via getFeedAnalyser(). page-init adopts it as the 'vocoder' audio source so
// it can drive audio-reactive fx and flow into recordings. onFeedChange()
// fires whenever that analyser appears, disappears, or is rebuilt.

import { getStoredDeviceId, wirePicker } from './devices.js';
import { autoCorrelate } from './pitch.js';
import { createVoiceShifter } from './voice-shifter.js';
import { VOX_PRESETS } from './vox-presets.js';
import { savePanelPos, restorePanelPos } from './panel-pos.js';

const NS              = 'voidstar.qualia.vocoder';
const PANEL_OPEN_KEY  = `${NS}.panelOpen`;
const CONFIG_KEY      = `${NS}.config`;

const DEFAULT_CONFIG = {
  carrierType: 'drone', // sawtooth | square | triangle | drone | noise
  pitch:       110,     // Hz — fundamental for tonal carriers
  bands:       24,      // BPF count across the formant range
  sibilance:   0.40,    // HF voice passthrough mix (0..1)
  dry:         0.0,     // dry voice passthrough mix (0..1) — inside the vocoder bus
  rawVoice:    0.0,     // raw mic → master, INDEPENDENT of the vocoder on/off (0..1)
  output:      0.9,     // master output gain (0..2)
  limiter:     true,    // master brickwall limiter (clip insurance) on/off
  gate:        0.04,    // carrier noise gate — mutes the carrier below this voice level
  voices:      3,       // detuned unison oscillators per carrier partial (1 = off)
  consonant:   0.6,     // HF pink-noise carrier blend (0..1) — fricative clarity
  presence:    3.5,     // master presence EQ lift at ~3 kHz, in dB (0..12)
  compress:    0.45,    // master compression macro (0..1)
  deess:       0.30,    // master de-esser depth (0..1) — tames loud sibilance
  micId:       '',      // '' = follow main mic; else a pinned input deviceId
  feedMix:     false,   // route vocoded output into audio-reactive modulation
  vocoderEnabled: true, // vocoder effect on/off (the mic + harmonizer stay live when off)
};

const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl:  false,
  // Advisory hint — ask the browser for the smallest input buffer it can
  // give. Helps live monitoring + pitch-tracking latency where supported.
  latency: 0,
};

// Carrier voice-pool size when the harmonizer is engaged — one slot per chord
// tone. Keep in sync with MAX_NOTES in harmonizer.js.
const CARRIER_POOL = 6;

// Granular pitch-shifters for the harmonizer's "voice" engine — one per
// harmony tone (the lead is the dry voice, so pool = MAX_NOTES − 1).
const HARM_SHIFTERS = 5;

function loadPanelOpen() {
  try { return localStorage.getItem(PANEL_OPEN_KEY) === '1'; } catch { return false; }
}
function savePanelOpen(v) {
  try { localStorage.setItem(PANEL_OPEN_KEY, v ? '1' : '0'); } catch {}
}
function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch {}
}

// Logarithmic frequencies between 80 Hz and 8 kHz — covers the formant
// region where speech intelligibility lives. F1/F2/F3 (≈500/1500/2500 Hz)
// fall inside this range; lower bands carry voicing energy and higher bands
// pick up consonant noise structure.
function bandFrequencies(n) {
  const fLow = 80, fHigh = 8000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = fLow * Math.pow(fHigh / fLow, n === 1 ? 0 : i / (n - 1));
  }
  return out;
}

// Full-wave rectifier curve for WaveShaperNode — turns a band's bipolar
// signal into |x|, which is then lowpassed into an envelope. The length is
// ODD so input 0 lands exactly on a sample (|0| = 0); an even-length curve
// straddles 0 and interpolates to a tiny positive DC, which leaks through as
// a constant carrier bleed even when the mic is silent.
function rectifierCurve(len = 1025) {
  const c = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1;
    c[i] = Math.abs(x);
  }
  return c;
}

// BPF Q that makes N log-spaced bands across 80–8000 Hz tile with a little
// overlap instead of leaving gaps. A fixed Q (too high for a low band count)
// drops the voice energy falling between band centres — the hollow/thin
// vocoder sound. Derived from the per-band octave width, clamped so extreme
// band counts still ring sanely.
function bandQ(n) {
  const octaves = Math.log2(8000 / 80);
  const perBand = octaves / Math.max(1, n - 1);
  const twoP    = Math.pow(2, perBand);
  const q       = 0.85 * Math.sqrt(twoP) / (twoP - 1);
  return Math.max(2.5, Math.min(q, 14));
}

// Per-band envelope-follower cutoff (Hz). Low formant bands get a slow
// envelope (~12 Hz) so vowels stay smooth; high bands get a fast one
// (~55 Hz) so consonant transients survive instead of being averaged away.
// Replaces the old single fixed 25 Hz lowpass shared by every band.
function bandEnvHz(f) {
  const u = Math.min(1, Math.max(0, Math.log2(Math.max(1, f) / 80) / Math.log2(8000 / 80)));
  return 12 + (55 - 12) * u;
}

// Smoothstep 0→1 across the consonant crossover (~1.8–4.5 kHz). A band's
// noise-carrier fraction is this × the `consonant` amount: below the
// crossover the carrier is purely the pitched synth, above it pink noise
// takes over so fricatives (/s/ /sh/ /f/) read as noise rather than a
// pitched whistle.
const NOISE_LO = 1800, NOISE_HI = 4500;
function noiseBlend(f) {
  const span = Math.log2(NOISE_HI) - Math.log2(NOISE_LO);
  const u = (Math.log2(Math.max(1, f)) - Math.log2(NOISE_LO)) / span;
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
}

// Noise-gate transfer curve for a WaveShaperNode: maps the voice-level
// envelope on the input to a 0..1 carrier-gate signal on the output. `t` is
// the slider value (0..1); 0 disables the gate (flat 1). A soft knee around
// the threshold makes it an expander rather than a chattery hard gate.
function gateCurve(t, len = 1025) {
  const c = new Float32Array(len);
  if (t <= 0) { c.fill(1); return c; }
  // Voice-band envelopes after rectify+LPF sit roughly in 0..0.2, so a
  // modest ceiling keeps the slider usable across its whole travel.
  const thresh = t * 0.18;
  const knee   = Math.max(0.01, thresh * 0.8);
  const lo = thresh - knee, hi = thresh + knee;
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1;   // input domain −1..1; envelope is ≥0
    if      (x <= lo) c[i] = 0;
    else if (x >= hi) c[i] = 1;
    else { const u = (x - lo) / (hi - lo); c[i] = u * u * (3 - 2 * u); } // smoothstep
  }
  return c;
}

// De-esser transfer curve for a WaveShaperNode: maps the sibilance-band
// level envelope on the input to a high-shelf gain reduction (dB, ≤ 0) on the
// output. `amount` (0..1) scales how deep the cut goes; 0 disables it (a flat
// all-zero curve). Below a small threshold the curve stays 0 so ordinary
// speech HF passes untouched — only loud "sss" spikes duck the shelf.
function deessCurve(amount, len = 1025) {
  const c = new Float32Array(len);
  if (amount <= 0) return c;          // all-zero — the shelf never moves
  const maxCut = amount * 14;         // dB pulled off the shelf at full sibilance
  const thresh = 0.04, span = 0.16;   // sibilance-envelope domain (≥ 0)
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1;
    if (x <= thresh) continue;        // c[i] already 0
    const u = Math.min(1, (x - thresh) / span);
    c[i] = -maxCut * u;
  }
  return c;
}

// Voss–McCartney pink noise — a closer match to vocal spectral tilt than
// white noise, which makes the noise carrier still feel "speech-shaped"
// rather than hissy.
function pinkNoiseBuffer(ctx, seconds = 2) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

export function createVocoder({ getDeviceId, onFeedChange, harmonizer } = {}) {
  const wasOpenLastSession = loadPanelOpen();
  const cfg = loadConfig();

  // ── DOM refs ───────────────────────────────────────────────────────────
  const panel     = document.getElementById('vocoder-panel');
  const btnToggle = document.getElementById('btn-vocoder');
  const btnClose  = document.getElementById('btn-vocoder-close');
  const btnPlay   = document.getElementById('btn-vocoder-play');
  const btnStop   = document.getElementById('btn-vocoder-stop');
  const btnMute   = document.getElementById('btn-vocoder-mute');
  const status    = document.getElementById('vocoder-status');
  const elCarrier = document.getElementById('voc-carrier');
  const elPitch   = document.getElementById('voc-pitch');
  const elBands   = document.getElementById('voc-bands');
  const elSib     = document.getElementById('voc-sibilance');
  const elSibVal  = document.getElementById('voc-sibilance-val');
  const elDry     = document.getElementById('voc-dry');
  const elDryVal  = document.getElementById('voc-dry-val');
  const elRaw     = document.getElementById('voc-raw');
  const elRawVal  = document.getElementById('voc-raw-val');
  const elOut     = document.getElementById('voc-output');
  const elOutVal  = document.getElementById('voc-output-val');
  const elGate    = document.getElementById('voc-gate');
  const elGateVal = document.getElementById('voc-gate-val');
  const elVoices  = document.getElementById('voc-voices');
  const elConsonant    = document.getElementById('voc-consonant');
  const elConsonantVal = document.getElementById('voc-consonant-val');
  const elPresence     = document.getElementById('voc-presence');
  const elPresenceVal  = document.getElementById('voc-presence-val');
  const elCompress     = document.getElementById('voc-compress');
  const elCompressVal  = document.getElementById('voc-compress-val');
  const elDeess        = document.getElementById('voc-deess');
  const elDeessVal     = document.getElementById('voc-deess-val');
  const elPreset       = document.getElementById('voc-preset');
  const elMic     = document.getElementById('voc-mic');
  const btnFeed   = document.getElementById('btn-vocoder-feed');
  const btnVocFx  = document.getElementById('btn-voc-fx');
  const elVocSection = document.getElementById('voc-section');

  // ── Audio state ────────────────────────────────────────────────────────
  let ctx        = null;
  let stream     = null;
  let active     = false;
  let muted      = false;
  let carrierIsHarmonized = false;  // whether the current pool was built for a chord

  // Graph nodes — reset on every (re)build.
  let micSource    = null;
  let inputGate    = null;
  let outBus       = null;
  let outputGain   = null;
  let muteGate     = null;
  let dryGain      = null;
  let rawGain      = null;     // raw mic → outBus, independent of the vocoder (clean voice)
  let sibChain     = null;     // {hpf, lpf, gain}
  let carrierBus   = null;
  let carrierVoices = [];      // [{ sources: [{node, ratio}], outGain }]
  let modBPFs      = [];
  let carrierBPFs  = [];
  let envFollowers = [];       // [{ rect, lpf, depth }]
  let bandVCAs     = [];
  let feedAnalyser = null;     // output tap adopted as the 'vocoder' audio source
  let carrierTilt  = null;     // high-shelf — lifts HF carrier energy for clearer consonants
  let gatePitched  = null;     // pitched-carrier VCA closed by the noise gate
  let gateNoise    = null;     // noise-carrier VCA closed by the noise gate
  let gateChain    = null;     // {hpf,rect,lpf,shaper} — voice level → gate signal
  let voiceHPF     = null;     // input conditioning — high-pass (rumble/handling)
  let voiceComp    = null;     // input conditioning — compressor (steady envelopes)
  let voiceCond    = null;     // conditioned modulator bus feeding the band filterbank
  let noiseCarrier = null;     // pink-noise carrier source (HF consonant carrier)
  let noiseGain    = null;     // noise-carrier level into the gate
  let carrierTaps  = [];       // [{ pGain, nGain, f }] per-band pitched/noise blend gains
  let postLowcut   = null;     // master EQ — rumble high-pass
  let postMud      = null;     // master EQ — low-mid mud dip
  let postPresence = null;     // master EQ — presence lift (~3 kHz) for word clarity
  let deEsser      = null;     // master de-esser — dynamic ~6 kHz high-shelf
  let deessChain   = null;     // {hpf,rect,env,shaper} — sibilance level → shelf cut
  let postComp     = null;     // master compressor — keeps quiet syllables audible
  let postLimiter  = null;     // master brickwall limiter — clip insurance
  let pitchAnalyser = null;    // voice tap for the harmonizer's pitch tracker
  let pitchBuf      = null;
  let trackingRAF   = null;    // rAF handle for the track-mode pitch loop
  let vocoderMix   = null;     // vocoder-effect bus → outBus (the vocoder on/off)
  let harmonyGate  = null;     // gated harmonizer voice-engine sum bus → outBus
  let harmonyHPF   = null;     // high-pass on the harmony path — kills hum/rumble
  let dryLead      = null;     // unshifted voice (the intelligible lead)
  let voiceShifter = null;     // formant-preserving (worklet) / granular pitch-shift back-end
  let shifterPool  = [];       // [{ gain }] per-voice output gains for harmony tones
  let harmonyBuilt = false;

  // ── Persistence ────────────────────────────────────────────────────────
  let saveT = null;
  function persistSoon() {
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(() => { saveConfig(cfg); saveT = null; }, 400);
  }

  // Fire onFeedChange so page-init can (re)adopt or release our output
  // analyser as an audio source. Called whenever the analyser instance or
  // the feed-enabled state changes — start, stop, graph rebuild, toggle.
  function notifyFeed() {
    try { onFeedChange?.(); } catch {}
  }

  // ── UI sync ────────────────────────────────────────────────────────────
  function syncPropsFromCfg() {
    if (elCarrier)   elCarrier.value   = cfg.carrierType;
    if (elPitch)     elPitch.value     = String(cfg.pitch);
    if (elBands)     elBands.value     = String(cfg.bands);
    if (elSib)       elSib.value       = String(cfg.sibilance);
    if (elDry)       elDry.value       = String(cfg.dry);
    if (elRaw)       elRaw.value       = String(cfg.rawVoice);
    if (elOut)       elOut.value       = String(cfg.output);
    if (elGate)      elGate.value      = String(cfg.gate);
    if (elVoices)    elVoices.value    = String(cfg.voices);
    if (elConsonant) elConsonant.value = String(cfg.consonant);
    if (elPresence)  elPresence.value  = String(cfg.presence);
    if (elCompress)  elCompress.value  = String(cfg.compress);
    if (elDeess)     elDeess.value     = String(cfg.deess);
    paintRanges();
    refreshVocFxBtn();
  }
  function refreshVocFxBtn() {
    if (elVocSection) elVocSection.classList.toggle('voc-disabled', !cfg.vocoderEnabled);
    if (!btnVocFx) return;
    btnVocFx.classList.toggle('active', cfg.vocoderEnabled);
    btnVocFx.textContent = cfg.vocoderEnabled ? 'on' : 'off';
    btnVocFx.title = cfg.vocoderEnabled
      ? 'Vocoder effect on — click to bypass (mic + harmonizer stay live)'
      : 'Vocoder effect off — click to enable the robot voice';
  }
  function paintRanges() {
    if (elSibVal)       elSibVal.textContent       = cfg.sibilance.toFixed(2);
    if (elDryVal)       elDryVal.textContent       = cfg.dry.toFixed(2);
    if (elRawVal)       elRawVal.textContent       = cfg.rawVoice.toFixed(2);
    if (elOutVal)       elOutVal.textContent       = cfg.output.toFixed(2);
    if (elGateVal)      elGateVal.textContent      = cfg.gate.toFixed(2);
    if (elConsonantVal) elConsonantVal.textContent = cfg.consonant.toFixed(2);
    if (elPresenceVal)  elPresenceVal.textContent  = `${cfg.presence.toFixed(1)} dB`;
    if (elCompressVal)  elCompressVal.textContent  = cfg.compress.toFixed(2);
    if (elDeessVal)     elDeessVal.textContent     = cfg.deess.toFixed(2);
  }
  function refreshButton() {
    if (!btnToggle) return;
    btnToggle.classList.remove('active', 'active-audio');
    const open = panel?.style.display !== 'none';
    if (open) btnToggle.classList.add('active');
    btnToggle.textContent = active ? 'vox ●' : 'vox';
    if (status) {
      if (active)    status.textContent = muted ? 'live · muted' : 'live';
      else if (open) status.textContent = 'click ▶ to start';
    }
  }
  function refreshMuteBtn() {
    if (!btnMute) return;
    btnMute.classList.toggle('muted', muted);
    btnMute.textContent = muted ? 'mute' : 'live';
    btnMute.title = muted ? 'Unmute output' : 'Mute output (mic stays open)';
  }
  function refreshPlayBtn() {
    if (!btnPlay) return;
    btnPlay.classList.toggle('playing', active);
  }
  function refreshFeedBtn() {
    if (!btnFeed) return;
    btnFeed.classList.toggle('active', cfg.feedMix);
    btnFeed.textContent = cfg.feedMix ? 'on' : 'off';
    btnFeed.title = cfg.feedMix
      ? 'Vocoder output feeds audio-reactive modulation — click to stop'
      : 'Feed vocoder output into audio-reactive modulation (heard by fx in the mix / all audio modes)';
  }

  // ── Audio graph ────────────────────────────────────────────────────────
  function ensureContext() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  async function openMic(deviceId) {
    // Same fallback ladder as audio.js: try the requested device, then any
    // default — a stale stored deviceId shouldn't block startup.
    const attempts = deviceId
      ? [{ ...MIC_CONSTRAINTS, deviceId: { exact: deviceId } }, { ...MIC_CONSTRAINTS }]
      : [{ ...MIC_CONSTRAINTS }];
    let s = null, lastErr = null;
    for (const constraints of attempts) {
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
        break;
      } catch (err) {
        lastErr = err;
        if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') break;
      }
    }
    if (!s) throw lastErr || new Error('getUserMedia failed');
    return s;
  }

  // True when the harmonizer should drive the vocoder carrier into a chord —
  // i.e. it's engaged AND in the "synth" engine. The "voice" engine harmonizes
  // by pitch-shifting the voice instead, leaving the carrier mono.
  function harmonizeOn() {
    return !!(harmonizer && harmonizer.isEnabled && harmonizer.isEnabled()
      && harmonizer.getEngine && harmonizer.getEngine() === 'synth');
  }
  // True when the harmonizer's voice (pitch-shift) engine is engaged.
  function harmonyVoiceOn() {
    return !!(harmonizer && harmonizer.isEnabled && harmonizer.isEnabled()
      && harmonizer.getEngine && harmonizer.getEngine() === 'voice');
  }

  // Unison detune offsets (cents) for an n-voice stack — a symmetric spread
  // that fills the spectral gaps between a single oscillator's harmonics, so
  // every analysis band finds carrier energy and the tone reads fuller and
  // less hollow. 1 voice = no detune.
  function unisonDetune(n) {
    if (n <= 1) return [0];
    const spread = 16;  // cents at the edges of the stack
    const out = [];
    for (let i = 0; i < n; i++) out.push(-spread + (2 * spread) * (i / (n - 1)));
    return out;
  }

  // Build one carrier "note" at `freq` Hz: a detuned-unison stack per partial,
  // summed into an outGain. Returned in the {sources,outGain} shape that
  // teardownGraph and setPitch already understand — `ratio` is the harmonic
  // multiple of the note's fundamental, while the unison spread rides on each
  // oscillator's own `detune` AudioParam so a pitch change leaves it intact.
  function buildCarrierNote(c, type, freq, voices) {
    const out = c.createGain();
    out.gain.value = 0;   // applyCarrierChord ramps active slots up to baseNorm
    const sources = [];
    if (type === 'noise') {
      const src = c.createBufferSource();
      src.buffer = pinkNoiseBuffer(c, 2);
      src.loop = true;
      src.connect(out); src.start();
      sources.push({ node: src, ratio: 1, isOsc: false });
      return { sources, outGain: out, baseNorm: 1 };
    }
    // drone = sawtooth fundamental + sub-octave (chest); others = one partial.
    const partials = type === 'drone'
      ? [{ wave: 'sawtooth', ratio: 1.0 }, { wave: 'sawtooth', ratio: 0.5 }]
      : [{ wave: type, ratio: 1.0 }];
    const det = unisonDetune(voices);
    // Detuned voices sum incoherently (~√n); normalise the slot's target
    // level by √count so a wider stack isn't louder.
    const baseNorm = (type === 'drone' ? 0.7 : 1.0) / Math.sqrt(det.length);
    for (const p of partials) {
      for (const cents of det) {
        const o = c.createOscillator();
        o.type = p.wave;
        o.frequency.value = freq * p.ratio;
        o.detune.value = cents;
        o.connect(out); o.start();
        sources.push({ node: o, ratio: p.ratio, isOsc: true });
      }
    }
    return { sources, outGain: out, baseNorm };
  }

  // The carrier voice pool. With the harmonizer off it's a single slot at
  // cfg.pitch; with it on, a fixed CARRIER_POOL of slots — applyCarrierChord
  // tunes and gates them to the current chord without a graph rebuild.
  function makeCarrier(c, type, pitch) {
    carrierIsHarmonized = harmonizeOn();
    const slots = carrierIsHarmonized ? CARRIER_POOL : 1;
    const pool = [];
    for (let i = 0; i < slots; i++) pool.push(buildCarrierNote(c, type, pitch, cfg.voices));
    return pool;
  }

  // MIDI note number → frequency (A4 = note 69 = 440 Hz).
  function midiToHz(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  // The frequencies the carrier pool should currently sound: the harmonizer's
  // chord when engaged (capped to the pool), otherwise the mono cfg.pitch.
  function currentCarrierFreqs() {
    if (harmonizeOn() && harmonizer) {
      return (harmonizer.getChord() || [])
        .slice(0, carrierVoices.length)
        .map(midiToHz);
    }
    return [cfg.pitch];
  }

  // Tune + gate the carrier voice pool to the current note set: one frequency
  // per active slot, unused slots ramped silent. Click-free — a chord change
  // retunes oscillators in place instead of rebuilding the graph.
  function applyCarrierChord() {
    if (!ctx || !carrierVoices.length) return;
    const t = ctx.currentTime;
    const freqs = currentCarrierFreqs();
    const k = Math.max(1, freqs.length);
    for (let i = 0; i < carrierVoices.length; i++) {
      const slot = carrierVoices[i];
      const on = i < freqs.length;
      // Active slots share level ~1/√k so a fat chord doesn't clip the sum.
      const g = on ? slot.baseNorm / Math.sqrt(k) : 0;
      try {
        slot.outGain.gain.cancelScheduledValues(t);
        slot.outGain.gain.linearRampToValueAtTime(g, t + 0.012);
      } catch {}
      if (!on) continue;
      for (const s of slot.sources) {
        if (!s.isOsc) continue;
        try {
          s.node.frequency.cancelScheduledValues(t);
          // Short ramp — long enough to stay click-free, short enough that
          // the pitch snap still reads as "instant" auto-tune.
          s.node.frequency.linearRampToValueAtTime(freqs[i] * s.ratio, t + 0.012);
        } catch {}
      }
    }
  }

  // Map the 0..1 compress macro onto the master compressor's threshold +
  // ratio: gentle and near-transparent at 0, heavy at 1.
  function applyCompressMacro(node, amt) {
    if (!node) return;
    const a = Math.max(0, Math.min(1, amt));
    const t = ctx ? ctx.currentTime : 0;
    try {
      node.threshold.setTargetAtTime(-8 - a * 22, t, 0.05);  // 0:−8 dB → 1:−30 dB
      node.ratio.setTargetAtTime(1.5 + a * 6.5, t, 0.05);    // 0:1.5:1 → 1:8:1
    } catch {}
  }

  function buildGraph() {
    const c = ensureContext();
    const N = cfg.bands;
    const freqs = bandFrequencies(N);
    // BPF selectivity scaled to the band count so the bands tile with light
    // overlap — a fixed Q leaves audible gaps at low band counts.
    const Q = bandQ(N);

    // ── Master output chain ────────────────────────────────────────────
    // outBus → clarity EQ → compressor → output gain → limiter → mute.
    // muteGate is tagged so the strudel mute-patch (if it ever shares this
    // ctx) leaves it alone — the vocoder owns its own mute via `muted`.
    outBus     = c.createGain(); outBus.gain.value = 1;
    outputGain = c.createGain(); outputGain.gain.value = cfg.output;
    muteGate   = c.createGain(); muteGate.gain.value = muted ? 0 : 1;
    muteGate.__qualiaBypassMute = true;

    // Clarity EQ — a rumble high-pass, a gentle low-mid dip to clear "mud",
    // and a presence lift around 3 kHz where word recognition lives.
    postLowcut = c.createBiquadFilter();
    postLowcut.type = 'highpass'; postLowcut.frequency.value = 80; postLowcut.Q.value = 0.7;
    postMud = c.createBiquadFilter();
    postMud.type = 'peaking'; postMud.frequency.value = 300; postMud.Q.value = 0.8;
    postMud.gain.value = -3;
    postPresence = c.createBiquadFilter();
    postPresence.type = 'peaking'; postPresence.frequency.value = 3000; postPresence.Q.value = 0.9;
    postPresence.gain.value = cfg.presence;
    // De-esser — a 6 kHz high-shelf whose gain is pulled down by a sibilance
    // sidechain (built below), taming loud "sss" without dulling speech.
    deEsser = c.createBiquadFilter();
    deEsser.type = 'highshelf'; deEsser.frequency.value = 6000; deEsser.gain.value = 0;
    // Master compressor (macro-controlled) then a fast brickwall limiter so
    // a fat chord or a loud syllable can't clip the output.
    postComp = c.createDynamicsCompressor();
    postComp.knee.value = 8; postComp.attack.value = 0.006; postComp.release.value = 0.15;
    applyCompressMacro(postComp, cfg.compress);
    postLimiter = c.createDynamicsCompressor();
    postLimiter.threshold.value = -1.5; postLimiter.knee.value = 0;
    postLimiter.ratio.value = 20; postLimiter.attack.value = 0.002; postLimiter.release.value = 0.05;
    applyVoxLimiter();   // honor cfg.limiter (transparent when the user bypassed it)

    outBus.connect(postLowcut);
    postLowcut.connect(postMud);
    postMud.connect(postPresence);
    postPresence.connect(deEsser);
    deEsser.connect(postComp);
    postComp.connect(outputGain);
    outputGain.connect(postLimiter);
    postLimiter.connect(muteGate);
    muteGate.connect(c.destination);

    // De-esser sidechain: a sibilance-band level envelope drives deEsser.gain
    // (the high-shelf's gain AudioParam sums this signal in), so the shelf
    // only cuts when sibilance is loud. Taps outBus — the pre-master signal.
    {
      const hpf = c.createBiquadFilter();
      hpf.type = 'highpass'; hpf.frequency.value = 5500; hpf.Q.value = 0.7;
      const rect = c.createWaveShaper(); rect.curve = rectifierCurve();
      const env = c.createBiquadFilter();
      env.type = 'lowpass'; env.frequency.value = 20; env.Q.value = 0.707;
      const shaper = c.createWaveShaper(); shaper.curve = deessCurve(cfg.deess);
      outBus.connect(hpf); hpf.connect(rect); rect.connect(env);
      env.connect(shaper); shaper.connect(deEsser.gain);
      deessChain = { hpf, rect, env, shaper };
    }

    // The vocoder DSP (carrier-bands + sibilance + dry) sums into vocoderMix
    // — whose gain IS the vocoder on/off, so the mic and the harmonizer's
    // voice path stay live when the vocoder is off. (The harmonizer's voice
    // engine builds its own gated bus, harmonyGate, in buildHarmonyVoice.)
    vocoderMix = c.createGain(); vocoderMix.gain.value = cfg.vocoderEnabled ? 1 : 0;
    vocoderMix.connect(outBus);

    // Output tap for audio-reactive modulation. Sits post-limiter and
    // post-mute so "what you hear is what modulates" — a muted or silenced
    // vocoder contributes nothing. page-init adopts this analyser as the
    // 'vocoder' audio source when the feed toggle is on; AnalyserNode is a
    // transparent passthrough, so audio.js can also route it into the
    // recordable mix.
    feedAnalyser = c.createAnalyser();
    feedAnalyser.fftSize = 1024;
    feedAnalyser.smoothingTimeConstant = 0.40;
    muteGate.connect(feedAnalyser);

    // Mic input.
    inputGate = c.createGain(); inputGate.gain.value = 1;
    micSource = c.createMediaStreamSource(stream);
    micSource.connect(inputGate);

    // Input conditioning for the modulator — a high-pass drops rumble and
    // handling noise, a compressor evens out the voice's dynamics so the
    // per-band envelope followers track a steady signal. voiceCond is the
    // conditioned bus the band filterbank reads; the gate sidechain and the
    // pitch tracker stay on the raw inputGate by design.
    voiceHPF = c.createBiquadFilter();
    voiceHPF.type = 'highpass'; voiceHPF.frequency.value = 90; voiceHPF.Q.value = 0.7;
    voiceComp = c.createDynamicsCompressor();
    voiceComp.threshold.value = -24; voiceComp.knee.value = 12;
    voiceComp.ratio.value = 3; voiceComp.attack.value = 0.005; voiceComp.release.value = 0.12;
    voiceCond = c.createGain(); voiceCond.gain.value = 1;
    inputGate.connect(voiceHPF);
    voiceHPF.connect(voiceComp);
    voiceComp.connect(voiceCond);

    // HF sibilance passthrough — band-limited to 3.5–9 kHz so we get the
    // crispness of "s/sh/t" without dragging in low-frequency room rumble or
    // ultrasonic mic noise.
    {
      const hpf = c.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 3500; hpf.Q.value = 0.7;
      const lpf = c.createBiquadFilter(); lpf.type = 'lowpass';  lpf.frequency.value = 9000; lpf.Q.value = 0.7;
      const g   = c.createGain(); g.gain.value = cfg.sibilance;
      inputGate.connect(hpf); hpf.connect(lpf); lpf.connect(g); g.connect(vocoderMix);
      sibChain = { hpf, lpf, gain: g };
    }

    // Dry passthrough — a touch of raw voice summed INSIDE the vocoder bus, so
    // it tracks the vocoder on/off (an intelligibility helper for the robot).
    {
      const g = c.createGain(); g.gain.value = cfg.dry;
      inputGate.connect(g); g.connect(vocoderMix);
      dryGain = g;
    }

    // Raw-voice passthrough — the "clean" / plain-speech path. Taps the mic
    // straight off inputGate and sums into outBus AFTER vocoderMix, so it is
    // INDEPENDENT of the vocoder on/off: the performer can bypass the robot
    // (vocoder off, harmonizer off) and still be heard, level-conditioned by
    // the shared master chain (clarity EQ + compressor + limiter). 0 by
    // default; the "Clean · raw voice" preset opens it.
    rawGain = c.createGain(); rawGain.gain.value = cfg.rawVoice;
    inputGate.connect(rawGain); rawGain.connect(outBus);

    // ── Carrier — pitched synth + pink noise ────────────────────────────
    // The pitched carrier voices vowels; the noise carrier voices the
    // fricative high bands. Each is gated independently (one shared
    // sidechain) and then crossfaded per band by carrierTaps.
    carrierVoices = makeCarrier(c, cfg.carrierType, cfg.pitch);
    carrierBus = c.createGain(); carrierBus.gain.value = 1;
    for (const v of carrierVoices) v.outGain.connect(carrierBus);

    // HF tilt — a sawtooth carrier rolls off ~6 dB/oct, starving the high
    // formant bands that carry consonant detail. A high-shelf lift puts
    // energy back where "s/t/k/f" live so the robot voice stays intelligible.
    carrierTilt = c.createBiquadFilter();
    carrierTilt.type = 'highshelf';
    carrierTilt.frequency.value = 1600;
    carrierTilt.gain.value = 6;
    carrierBus.connect(carrierTilt);

    // Pink-noise carrier — speech-shaped spectral tilt, looped.
    noiseCarrier = c.createBufferSource();
    noiseCarrier.buffer = pinkNoiseBuffer(c, 2);
    noiseCarrier.loop = true;
    noiseGain = c.createGain(); noiseGain.gain.value = 2.5;  // rough match to the pitched carrier level
    noiseCarrier.connect(noiseGain);
    noiseCarrier.start();

    // Carrier noise gates — gatePitched/gateNoise start closed (0); the
    // sidechain below drives them open with the voice level so neither
    // carrier drones on through room tone and mic hiss between phrases.
    gatePitched = c.createGain(); gatePitched.gain.value = 0;
    gateNoise   = c.createGain(); gateNoise.gain.value = 0;
    carrierTilt.connect(gatePitched);
    noiseGain.connect(gateNoise);

    // Gate sidechain: voice level → gate signal. HPF drops rumble/handling
    // noise that would false-open the gate; rectify + slow LPF make a smooth
    // level envelope; the WaveShaper maps that level through the threshold
    // curve into the 0..1 signal driving both carrier gates.
    {
      const hpf = c.createBiquadFilter();
      hpf.type = 'highpass'; hpf.frequency.value = 120; hpf.Q.value = 0.7;
      const rect = c.createWaveShaper(); rect.curve = rectifierCurve();
      const lpf = c.createBiquadFilter();
      lpf.type = 'lowpass'; lpf.frequency.value = 14; lpf.Q.value = 0.707;
      const shaper = c.createWaveShaper(); shaper.curve = gateCurve(cfg.gate);
      inputGate.connect(hpf); hpf.connect(rect); rect.connect(lpf);
      lpf.connect(shaper);
      shaper.connect(gatePitched.gain);
      shaper.connect(gateNoise.gain);
      gateChain = { hpf, rect, lpf, shaper };
    }

    // Voice tap for the harmonizer's pitch tracker (track / Prismizer mode).
    // Reads inputGate — the raw voice, before conditioning — so
    // autocorrelation sees a clean fundamental. fftSize 1024 (~21 ms @
    // 48 kHz) keeps the analysis window — and the tracking latency — short.
    pitchAnalyser = c.createAnalyser();
    pitchAnalyser.fftSize = 1024;
    pitchBuf = new Float32Array(pitchAnalyser.fftSize);
    inputGate.connect(pitchAnalyser);

    // Per-band: BPF(modulator) → rectify → LPF (envelope) → depthScale → vca.gain
    //           [pitched·(1−nf) + noise·nf] → BPF(carrier) → vca → vocoderMix
    // The rectified+lowpassed envelope drives the VCA's gain AudioParam; the
    // depth gain scales the 0..1 envelope so the carrier band punches
    // through. nf is the band's noise fraction (see carrierTaps); the
    // envelope LPF cutoff is per-band (bandEnvHz) — fast up high for
    // consonants, slow down low for smooth vowels.
    const rectCurve = rectifierCurve();
    for (let i = 0; i < N; i++) {
      const f = freqs[i];

      const modBPF = c.createBiquadFilter();
      modBPF.type = 'bandpass'; modBPF.frequency.value = f; modBPF.Q.value = Q;
      voiceCond.connect(modBPF);

      const rect = c.createWaveShaper(); rect.curve = rectCurve;
      modBPF.connect(rect);

      const env = c.createBiquadFilter();
      env.type = 'lowpass'; env.frequency.value = bandEnvHz(f); env.Q.value = 0.707;
      rect.connect(env);

      const depth = c.createGain(); depth.gain.value = 5;
      env.connect(depth);

      // Per-band carrier blend: the pitched and noise carriers crossfaded by
      // the band's noise fraction, summed into one bandpass.
      const nf = cfg.consonant * noiseBlend(f);
      const pGain = c.createGain(); pGain.gain.value = 1 - nf;
      const nGain = c.createGain(); nGain.gain.value = nf;
      gatePitched.connect(pGain);
      gateNoise.connect(nGain);

      const carBPF = c.createBiquadFilter();
      carBPF.type = 'bandpass'; carBPF.frequency.value = f; carBPF.Q.value = Q;
      pGain.connect(carBPF);
      nGain.connect(carBPF);

      // Start with vca.gain.value = 0 so silence in (no envelope) → silence out.
      const vca = c.createGain(); vca.gain.value = 0;
      depth.connect(vca.gain);
      carBPF.connect(vca);
      vca.connect(vocoderMix);

      modBPFs.push(modBPF);
      carrierBPFs.push(carBPF);
      carrierTaps.push({ pGain, nGain, f });
      envFollowers.push({ rect, lpf: env, depth });
      bandVCAs.push(vca);
    }

    // Tune + gate the freshly-built carrier pool to the current chord (or
    // the mono pitch when the harmonizer is off).
    applyCarrierChord();
  }

  function teardownGraph() {
    const stopSafe = (n) => { try { n.stop(); } catch {} };
    const disc = (n) => { try { n.disconnect(); } catch {} };

    teardownHarmonyVoice();
    for (const v of carrierVoices) {
      for (const s of v.sources) stopSafe(s.node);
      disc(v.outGain);
    }
    carrierVoices = [];
    for (const n of bandVCAs)    disc(n);  bandVCAs = [];
    for (const n of modBPFs)     disc(n);  modBPFs = [];
    for (const n of carrierBPFs) disc(n);  carrierBPFs = [];
    for (const e of envFollowers) { disc(e.rect); disc(e.lpf); disc(e.depth); }
    envFollowers = [];
    for (const t of carrierTaps) { disc(t.pGain); disc(t.nGain); }
    carrierTaps = [];
    if (sibChain)  { disc(sibChain.hpf); disc(sibChain.lpf); disc(sibChain.gain); sibChain = null; }
    if (dryGain)   { disc(dryGain);   dryGain   = null; }
    if (rawGain)   { disc(rawGain);   rawGain   = null; }
    if (carrierBus){ disc(carrierBus); carrierBus = null; }
    if (carrierTilt){ disc(carrierTilt); carrierTilt = null; }
    if (noiseCarrier) { stopSafe(noiseCarrier); disc(noiseCarrier); noiseCarrier = null; }
    if (noiseGain) { disc(noiseGain); noiseGain = null; }
    if (gatePitched) { disc(gatePitched); gatePitched = null; }
    if (gateNoise)   { disc(gateNoise);   gateNoise   = null; }
    if (gateChain) {
      disc(gateChain.hpf); disc(gateChain.rect); disc(gateChain.lpf); disc(gateChain.shaper);
      gateChain = null;
    }
    if (micSource) { disc(micSource); micSource = null; }
    if (inputGate) { disc(inputGate); inputGate = null; }
    if (voiceHPF)  { disc(voiceHPF);  voiceHPF  = null; }
    if (voiceComp) { disc(voiceComp); voiceComp = null; }
    if (voiceCond) { disc(voiceCond); voiceCond = null; }
    if (outBus)    { disc(outBus);    outBus    = null; }
    if (postLowcut)  { disc(postLowcut);   postLowcut   = null; }
    if (postMud)     { disc(postMud);      postMud      = null; }
    if (postPresence){ disc(postPresence); postPresence = null; }
    if (deEsser)   { disc(deEsser); deEsser = null; }
    if (deessChain) {
      disc(deessChain.hpf); disc(deessChain.rect); disc(deessChain.env); disc(deessChain.shaper);
      deessChain = null;
    }
    if (postComp)    { disc(postComp);     postComp     = null; }
    if (outputGain){ disc(outputGain); outputGain= null; }
    if (postLimiter) { disc(postLimiter);  postLimiter  = null; }
    if (muteGate)  { disc(muteGate);  muteGate  = null; }
    if (vocoderMix){ disc(vocoderMix); vocoderMix = null; }
    if (feedAnalyser){ disc(feedAnalyser); feedAnalyser = null; }
    if (pitchAnalyser){ disc(pitchAnalyser); pitchAnalyser = null; }
    pitchBuf = null;
  }

  // Rebuild the graph in place — used when the user changes carrier type or
  // band count while running. The mic stream is preserved so the user
  // doesn't have to re-grant permission or hear a glitch from the OS-level
  // capture restart.
  function rebuildGraph() {
    if (!active) return;
    teardownGraph();
    buildGraph();
    // buildGraph minted a fresh feedAnalyser — page-init must re-adopt it.
    notifyFeed();
    // inputGate is fresh — re-tap the harmonizer voice path off it.
    syncHarmonyVoice();
  }

  // Harmonizer changed. A change in synth-engaged state resizes the carrier
  // pool (1 ↔ CARRIER_POOL) so the graph rebuilds; otherwise just retune.
  // The voice-engine path is (re)built/torn-down to match independently.
  function onHarmonizerChange() {
    if (!active) return;
    // Synth-engine harmony is realized by the vocoder carrier — engaging it
    // with the vocoder effect off would be silent, so switch the vocoder on.
    if (harmonizeOn() && !cfg.vocoderEnabled) setVocoderEnabled(true);
    if (harmonizeOn() !== carrierIsHarmonized) rebuildGraph();
    else applyCarrierChord();
    syncHarmonyVoice();
    // Push the current formant shift to the (possibly freshly built) shifter.
    if (voiceShifter && harmonizer?.getFormant) voiceShifter.setFormant(harmonizer.getFormant());
    // With autotune on, the pitch loop refreshes the voice harmony every
    // frame; otherwise apply it once here for this config change.
    if (harmonyBuilt && !harmonizer?.isTuned?.()) applyVoiceHarmony();
    syncPitchTracker();
  }

  // ── Pitch tracking ─────────────────────────────────────────────────────
  // A rAF loop samples the voice every frame, detects the fundamental, and
  // hands it to the harmonizer. The synth engine's track mode retunes the
  // carrier pool; the voice engine retunes the granular shifters.
  function shouldTrack() {
    if (!active || !harmonizer || !harmonizer.isEnabled?.()) return false;
    // The voice engine always needs pitch; the synth engine only in track mode.
    if (harmonizer.getEngine?.() === 'voice') return true;
    return harmonizer.getMode?.() === 'track';
  }
  function pitchTick() {
    if (!shouldTrack()) { trackingRAF = null; return; }
    // Detect every animation frame — autocorrelation on a 1024-sample buffer
    // is cheap (~25M mul-adds/sec at 60 fps), and the old 32 ms throttle was
    // pure added latency.
    if (pitchAnalyser && pitchBuf && ctx) {
      pitchAnalyser.getFloatTimeDomainData(pitchBuf);
      const hz = autoCorrelate(pitchBuf, ctx.sampleRate);
      if (hz > 0) {
        const moved = harmonizer.updatePitch(hz);
        if (harmonyVoiceOn()) {
          // Autotune chases the live pitch every frame; parallel harmony
          // only needs a refresh when the snapped lead actually moves.
          if (harmonizer.isTuned?.()) applyVoiceHarmony(hz);
          else if (moved)             applyVoiceHarmony();
        } else if (moved) {
          applyCarrierChord();
        }
      }
    }
    trackingRAF = requestAnimationFrame(pitchTick);
  }
  function syncPitchTracker() {
    if (shouldTrack()) {
      if (trackingRAF == null) trackingRAF = requestAnimationFrame(pitchTick);
    } else if (trackingRAF != null) {
      cancelAnimationFrame(trackingRAF);
      trackingRAF = null;
    }
  }

  // ── Harmonizer "voice" engine — pitch-shifted natural-voice harmony ─────
  // A dry lead (the voice unshifted, intelligible) plus a voice shifter — a
  // formant-preserving worklet (granular fallback) with one output per
  // harmony tone — summed through a gated bus. Independent of the vocoder
  // effect but sharing its gate sidechain.
  function buildHarmonyVoice() {
    if (harmonyBuilt || !ctx || !inputGate || !outBus) return;
    // High-pass the voice before harmonizing — keeps mains hum and rumble
    // out of the pitch shifters (where they'd shift into worse artifacts).
    harmonyHPF = ctx.createBiquadFilter();
    harmonyHPF.type = 'highpass'; harmonyHPF.frequency.value = 75; harmonyHPF.Q.value = 0.7;
    inputGate.connect(harmonyHPF);
    // Gated sum bus — shares the vocoder's gate sidechain, so the harmony
    // path is silenced between phrases and can't self-excite into acoustic
    // feedback at rest. With the gate disabled the shaper outputs a flat 1,
    // leaving harmonyGate fully open.
    harmonyGate = ctx.createGain();
    harmonyGate.gain.value = gateChain ? 0 : 1;
    if (gateChain) gateChain.shaper.connect(harmonyGate.gain);
    harmonyGate.connect(outBus);
    // Dry lead — the voice unshifted (the intelligible anchor).
    dryLead = ctx.createGain(); dryLead.gain.value = 0;
    harmonyHPF.connect(dryLead);
    dryLead.connect(harmonyGate);
    // Voice shifter — one back-end, HARM_SHIFTERS outputs; a per-voice gain
    // on each output is the harmony-tone level (set by applyVoiceHarmony).
    voiceShifter = createVoiceShifter(ctx, HARM_SHIFTERS);
    harmonyHPF.connect(voiceShifter.input);
    shifterPool = [];
    for (let i = 0; i < HARM_SHIFTERS; i++) {
      const g = ctx.createGain(); g.gain.value = 0;
      voiceShifter.outputs[i].connect(g);
      g.connect(harmonyGate);
      shifterPool.push({ gain: g });
    }
    if (harmonizer?.getFormant) voiceShifter.setFormant(harmonizer.getFormant());
    harmonyBuilt = true;
    applyVoiceHarmony();
  }
  function teardownHarmonyVoice() {
    if (!harmonyBuilt) return;
    const disc = (n) => { try { n.disconnect(); } catch {} };
    if (gateChain && harmonyGate) {
      try { gateChain.shaper.disconnect(harmonyGate.gain); } catch {}
    }
    if (dryLead) { disc(dryLead); dryLead = null; }
    for (const s of shifterPool) disc(s.gain);
    shifterPool = [];
    if (voiceShifter) { try { voiceShifter.dispose(); } catch {} voiceShifter = null; }
    if (harmonyHPF)  { disc(harmonyHPF);  harmonyHPF  = null; }
    if (harmonyGate) { disc(harmonyGate); harmonyGate = null; }
    harmonyBuilt = false;
  }
  function syncHarmonyVoice() {
    const want = active && harmonyVoiceOn();
    if (want && !harmonyBuilt) buildHarmonyVoice();
    else if (!want && harmonyBuilt) teardownHarmonyVoice();
  }
  // Point the dry lead + shifter pool at the current harmony.
  //   autotune off — the dry voice is the lead; harmonies are the voice
  //     shifted by the diatonic interval from the snapped lead, so they
  //     track your expression (and sit off-grid if you sing off-grid).
  //   autotune on  — every voice (lead included) is the source resampled
  //     onto an EXACT scale note: ratio = targetHz / detectedHz, no dry lead.
  function applyVoiceHarmony(hz) {
    if (!harmonyBuilt || !ctx || !voiceShifter) return;
    const t = ctx.currentTime;
    const ramp = (param, v) => {
      try { param.cancelScheduledValues(t); param.linearRampToValueAtTime(v, t + 0.03); } catch {}
    };
    const tuned = !!(harmonizer?.isTuned?.()) && hz > 0;
    const N = shifterPool.length;
    const ratios = new Array(N).fill(0);   // 0 = voice unused

    if (tuned) {
      const chord = (harmonizer.getChord?.() || []).slice(0, N);
      const lvl = 1 / Math.sqrt(Math.max(1, chord.length));
      ramp(dryLead.gain, 0);
      for (let i = 0; i < N; i++) {
        if (i < chord.length) {
          ratios[i] = midiToHz(chord[i]) / hz;
          ramp(shifterPool[i].gain.gain, lvl);
        } else {
          ramp(shifterPool[i].gain.gain, 0);
        }
      }
      voiceShifter.setRatios(ratios);
      return;
    }

    const shifts = (harmonizer?.getShifts?.() || []).filter(s => Math.abs(s) >= 0.5);
    const used = Math.min(shifts.length, N);
    const lvl  = 1 / Math.sqrt(1 + used);   // dry + harmonies share headroom
    ramp(dryLead.gain, lvl);
    for (let i = 0; i < N; i++) {
      if (i < used) {
        ratios[i] = Math.pow(2, shifts[i] / 12);
        ramp(shifterPool[i].gain.gain, lvl);
      } else {
        ramp(shifterPool[i].gain.gain, 0);
      }
    }
    voiceShifter.setRatios(ratios);
  }

  // The device our getUserMedia capture should target: an explicit pinned
  // selection wins; otherwise follow the main mic (resolved live via
  // getDeviceId), then the last stored main-mic id so a returning user with
  // no live main mic still gets a sensible default.
  function resolveDeviceId() {
    if (cfg.micId) return cfg.micId;
    const main = (typeof getDeviceId === 'function' && getDeviceId()) || null;
    return main || getStoredDeviceId('mic');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  async function start() {
    if (active) return true;
    try {
      stream = await openMic(resolveDeviceId());
    } catch (err) {
      console.warn('[qualia] vocoder mic open failed:', err);
      if (status) status.textContent = `mic error: ${err.message || err}`;
      return false;
    }
    ensureContext();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch {}
    }
    try { buildGraph(); }
    catch (err) {
      console.warn('[qualia] vocoder buildGraph failed:', err);
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      stream = null;
      return false;
    }
    active = true;
    refreshPlayBtn();
    refreshButton();
    // The graph (and its feedAnalyser) now exists — let page-init adopt it.
    notifyFeed();
    // Mic permission is granted now, so enumerateDevices() returns labels —
    // repopulate our picker so device names replace the generic "Mic N".
    micPicker.populate();
    // A pre-engaged synth-engine harmonizer needs the vocoder audible.
    if (harmonizeOn() && !cfg.vocoderEnabled) setVocoderEnabled(true);
    // Build the voice-harmony path / start the pitch tracker if the
    // harmonizer is already engaged.
    syncHarmonyVoice();
    syncPitchTracker();
    return true;
  }

  function stop() {
    if (!active) return;
    teardownGraph();
    if (stream) {
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      stream = null;
    }
    active = false;
    refreshPlayBtn();
    refreshButton();
    // feedAnalyser is gone — page-init releases the 'vocoder' audio source.
    notifyFeed();
    // Stop the pitch-tracking loop.
    syncPitchTracker();
  }

  function setMuted(on) {
    muted = !!on;
    if (muteGate && ctx) {
      try {
        const t = ctx.currentTime;
        muteGate.gain.cancelScheduledValues(t);
        muteGate.gain.linearRampToValueAtTime(muted ? 0 : 1, t + 0.04);
      } catch {
        try { muteGate.gain.value = muted ? 0 : 1; } catch {}
      }
    }
    refreshMuteBtn();
    refreshButton();
    notifyMix();
  }

  // External hook used by page-init when the user changes the topbar mic
  // selection. Only follow it when we're in "same as main mic" mode — an
  // explicit per-vocoder pin stays put regardless of the topbar.
  async function setDevice(_id) {
    if (cfg.micId) return;
    if (!active) return;
    stop();
    await start();
  }

  // Mic selection for the vocoder's own capture. '' means "follow the main
  // mic" (resolved live in resolveDeviceId); any other value pins a device.
  async function applyMicId(id) {
    const v = id || '';
    if (cfg.micId === v) return;
    cfg.micId = v;
    persistSoon();
    // Re-open the capture on the new device if we're already running.
    if (active) { stop(); await start(); }
  }

  // Toggle whether the vocoded output feeds audio-reactive modulation. The
  // actual adopt/release is page-init's job — notifyFeed pokes it.
  function setFeedMix(on) {
    const v = !!on;
    if (cfg.feedMix === v) { refreshFeedBtn(); return; }
    cfg.feedMix = v;
    persistSoon();
    refreshFeedBtn();
    notifyFeed();
  }

  // ── Param handlers ─────────────────────────────────────────────────────
  function setCarrierType(t) {
    if (cfg.carrierType === t) return;
    cfg.carrierType = t;
    persistSoon();
    rebuildGraph();
  }
  function setPitch(hz) {
    const v = Math.max(40, Math.min(500, +hz || 0));
    cfg.pitch = v;
    persistSoon();
    // The mono carrier follows cfg.pitch; a harmonized carrier ignores it
    // (the chord rules). applyCarrierChord covers both and is a no-op when
    // stopped — the next start() rebuilds at the new pitch.
    applyCarrierChord();
  }
  function setBandCount(n) {
    const v = Math.max(4, Math.min(48, +n | 0));
    if (cfg.bands === v) return;
    cfg.bands = v;
    persistSoon();
    rebuildGraph();
  }
  function setSibilance(v) {
    cfg.sibilance = Math.max(0, Math.min(1, +v || 0));
    persistSoon();
    paintRanges();
    if (sibChain && ctx) {
      try { sibChain.gain.gain.linearRampToValueAtTime(cfg.sibilance, ctx.currentTime + 0.05); } catch {}
    }
  }
  function setDry(v) {
    cfg.dry = Math.max(0, Math.min(1, +v || 0));
    persistSoon();
    paintRanges();
    if (dryGain && ctx) {
      try { dryGain.gain.linearRampToValueAtTime(cfg.dry, ctx.currentTime + 0.05); } catch {}
    }
  }
  function setRawVoice(v) {
    cfg.rawVoice = Math.max(0, Math.min(1, +v || 0));
    persistSoon();
    paintRanges();
    if (rawGain && ctx) {
      try { rawGain.gain.linearRampToValueAtTime(cfg.rawVoice, ctx.currentTime + 0.05); } catch {}
    }
  }
  function setOutput(v) {
    cfg.output = Math.max(0, Math.min(2, +v || 0));
    persistSoon();
    paintRanges();
    if (outputGain && ctx) {
      try { outputGain.gain.linearRampToValueAtTime(cfg.output, ctx.currentTime + 0.05); } catch {}
    }
    notifyMix();
  }
  // Master brickwall limiter (postLimiter) bypass — "off" makes it transparent
  // (ratio 1) rather than rerouting the graph, so toggling never clicks. The
  // ceiling stays at -1.5 dBFS when engaged (vox's hand-tuned value).
  function applyVoxLimiter() {
    if (!postLimiter) return;
    try {
      postLimiter.ratio.value     = cfg.limiter === false ? 1 : 20;
      postLimiter.threshold.value = cfg.limiter === false ? 0 : -1.5;
    } catch {}
  }
  function setLimiter(on) {
    cfg.limiter = !!on;
    persistSoon();
    applyVoxLimiter();
    notifyMix();
  }
  function getLimiter() { return cfg.limiter !== false; }

  // Mix-change listeners — fire on output/mute/limiter change so the mixer
  // panel's vox channel and this panel's own controls stay in sync.
  const mixListeners = new Set();
  function onChange(fn) { mixListeners.add(fn); return () => mixListeners.delete(fn); }
  function notifyMix() {
    const snap = { output: cfg.output, muted, limiter: cfg.limiter !== false };
    mixListeners.forEach(fn => { try { fn(snap); } catch {} });
  }
  function setGate(v) {
    cfg.gate = Math.max(0, Math.min(1, +v || 0));
    persistSoon();
    paintRanges();
    // The gate threshold lives in the sidechain WaveShaper's curve — swap it
    // live; no graph rebuild needed.
    if (gateChain) {
      try { gateChain.shaper.curve = gateCurve(cfg.gate); } catch {}
    }
  }
  function setVoices(n) {
    const v = Math.max(1, Math.min(7, +n | 0));
    if (cfg.voices === v) return;
    cfg.voices = v;
    persistSoon();
    rebuildGraph();  // oscillator count changed — rebuild the carrier
  }
  function setVocoderEnabled(on) {
    cfg.vocoderEnabled = !!on;
    persistSoon();
    refreshVocFxBtn();
    if (vocoderMix && ctx) {
      try {
        const t = ctx.currentTime;
        vocoderMix.gain.cancelScheduledValues(t);
        vocoderMix.gain.linearRampToValueAtTime(cfg.vocoderEnabled ? 1 : 0, t + 0.04);
      } catch {}
    }
  }
  function setConsonant(v) {
    cfg.consonant = Math.max(0, Math.min(1, +v || 0));
    persistSoon();
    paintRanges();
    // Re-crossfade every band's pitched/noise carrier blend — live, no rebuild.
    if (ctx && carrierTaps.length) {
      const t = ctx.currentTime;
      for (const tap of carrierTaps) {
        const nf = cfg.consonant * noiseBlend(tap.f);
        try {
          tap.pGain.gain.linearRampToValueAtTime(1 - nf, t + 0.05);
          tap.nGain.gain.linearRampToValueAtTime(nf, t + 0.05);
        } catch {}
      }
    }
  }
  function setPresence(v) {
    cfg.presence = Math.max(0, Math.min(12, +v || 0));
    persistSoon();
    paintRanges();
    if (postPresence && ctx) {
      try { postPresence.gain.linearRampToValueAtTime(cfg.presence, ctx.currentTime + 0.05); } catch {}
    }
  }
  function setCompress(v) {
    cfg.compress = Math.max(0, Math.min(1, +v || 0));
    persistSoon();
    paintRanges();
    applyCompressMacro(postComp, cfg.compress);
  }
  function setDeess(v) {
    cfg.deess = Math.max(0, Math.min(1, +v || 0));
    persistSoon();
    paintRanges();
    // The de-ess depth lives in the sidechain WaveShaper's curve — swap it
    // live; no graph rebuild needed.
    if (deessChain) {
      try { deessChain.shaper.curve = deessCurve(cfg.deess); } catch {}
    }
  }

  // Apply a partial config — used by the qualem snapshot restore and by the
  // preset picker. Every field routes through its setter so live audio nodes
  // update; presets only ever touch fields that also have a panel control,
  // so a loaded preset stays fully editable.
  function applyConfig(partial) {
    if (!partial || typeof partial !== 'object') return;
    if (typeof partial.carrierType === 'string') setCarrierType(partial.carrierType);
    if (typeof partial.pitch       === 'number') setPitch(partial.pitch);
    if (typeof partial.bands       === 'number') setBandCount(partial.bands);
    if (typeof partial.sibilance   === 'number') setSibilance(partial.sibilance);
    if (typeof partial.dry         === 'number') setDry(partial.dry);
    if (typeof partial.rawVoice    === 'number') setRawVoice(partial.rawVoice);
    if (typeof partial.output      === 'number') setOutput(partial.output);
    if (typeof partial.gate        === 'number') setGate(partial.gate);
    if (typeof partial.voices      === 'number') setVoices(partial.voices);
    if (typeof partial.consonant   === 'number') setConsonant(partial.consonant);
    if (typeof partial.presence    === 'number') setPresence(partial.presence);
    if (typeof partial.compress    === 'number') setCompress(partial.compress);
    if (typeof partial.deess       === 'number') setDeess(partial.deess);
    if (typeof partial.vocoderEnabled === 'boolean') setVocoderEnabled(partial.vocoderEnabled);
    if (typeof partial.micId       === 'string') applyMicId(partial.micId);
    if (typeof partial.feedMix     === 'boolean') setFeedMix(partial.feedMix);
    if (typeof partial.limiter     === 'boolean') setLimiter(partial.limiter);
    if (partial.harmonizer && harmonizer?.setConfig) harmonizer.setConfig(partial.harmonizer);
    // Re-paint sliders so the panel reflects the new values even if a setter
    // bailed out on an equal value.
    syncPropsFromCfg();
    micPicker.populate();
  }

  // ── Wire UI controls ───────────────────────────────────────────────────
  syncPropsFromCfg();
  if (elCarrier) elCarrier.addEventListener('change', () => setCarrierType(elCarrier.value));
  if (elPitch)   elPitch.addEventListener('change',   () => setPitch(elPitch.value));
  if (elBands)   elBands.addEventListener('change',   () => setBandCount(elBands.value));
  if (elSib)     elSib.addEventListener('input',      () => setSibilance(elSib.value));
  if (elDry)     elDry.addEventListener('input',      () => setDry(elDry.value));
  if (elRaw)     elRaw.addEventListener('input',      () => setRawVoice(elRaw.value));
  if (elOut)     elOut.addEventListener('input',      () => setOutput(elOut.value));
  if (elGate)    elGate.addEventListener('input',     () => setGate(elGate.value));
  if (elVoices)  elVoices.addEventListener('change',  () => setVoices(elVoices.value));
  if (elConsonant) elConsonant.addEventListener('input', () => setConsonant(elConsonant.value));
  if (elPresence)  elPresence.addEventListener('input',  () => setPresence(elPresence.value));
  if (elCompress)  elCompress.addEventListener('input',  () => setCompress(elCompress.value));
  if (elDeess)     elDeess.addEventListener('input',     () => setDeess(elDeess.value));

  if (btnFeed)  btnFeed.addEventListener('click',  () => setFeedMix(!cfg.feedMix));
  if (btnVocFx) btnVocFx.addEventListener('click', () => setVocoderEnabled(!cfg.vocoderEnabled));

  // Retune (or rebuild) the carrier whenever the harmonizer's chord or
  // engaged-state changes.
  harmonizer?.onChange?.(onHarmonizerChange);

  // The vocoder's own mic picker. The synthetic leading option keeps the
  // historical behaviour — follow the topbar mic — as the default, while
  // letting a performer pin a dedicated input. Persistence lives in our own
  // config (persist:false), not the shared device store.
  const micPicker = wirePicker({
    select:        elMic,
    kind:          'audioinput',
    alwaysShow:    true,
    persist:       false,
    leadingOption: { value: '', label: 'same as main mic' },
    getCurrentId:  () => cfg.micId || '',
    onChoose:      async (id) => { await applyMicId(id); return cfg.micId || ''; },
  });
  micPicker.populate();

  // ── Preset picker ──────────────────────────────────────────────────────
  // Applies an artistic starting point via applyConfig. Every field a preset
  // sets has its own panel control, so the loaded sound stays fully editable;
  // the dropdown just reflects the last preset loaded.
  if (elPreset) {
    for (const [key, p] of Object.entries(VOX_PRESETS)) {
      const o = document.createElement('option');
      o.value = key; o.textContent = p.label;
      elPreset.appendChild(o);
    }
    elPreset.addEventListener('change', () => {
      const p = VOX_PRESETS[elPreset.value];
      if (p) applyConfig(p.config);
      // Reset to the placeholder — a preset is a one-shot starting point, and
      // resetting lets the same preset be re-loaded after a tweak.
      elPreset.value = '';
    });
  }

  // ── Collapsible fx sub-sections ────────────────────────────────────────
  // Each .vox-section in the panel has a .vox-sec-head (with a .vox-caret
  // toggle) and a .vox-sec-body. Clicking the caret — or the head away from
  // its own controls — collapses the body; the state persists per section.
  (function wireCollapsibles() {
    document.querySelectorAll('#vocoder-panel .vox-section').forEach((sec) => {
      const head  = sec.querySelector('.vox-sec-head');
      const caret = sec.querySelector('.vox-caret');
      if (!head || !sec.id) return;
      const key = `${NS}.collapsed.${sec.id}`;
      const paint = () => {
        if (caret) caret.textContent = sec.classList.contains('vox-collapsed') ? '▸' : '▾';
      };
      let collapsed0 = false;
      try { collapsed0 = localStorage.getItem(key) === '1'; } catch {}
      sec.classList.toggle('vox-collapsed', collapsed0);
      paint();
      head.addEventListener('click', (e) => {
        // Ignore clicks on interactive controls in the head — but not the caret.
        if (e.target.closest('button, input, select, textarea') && !e.target.closest('.vox-caret')) return;
        const c = sec.classList.toggle('vox-collapsed');
        try { localStorage.setItem(key, c ? '1' : '0'); } catch {}
        paint();
      });
    });
  })();

  // ── Drag / reposition (mirror sequencer & strudel panels) ──────────────
  let movedByUser = restorePanelPos('vocoder', panel);
  function reposition() {
    if (!panel || panel.style.display === 'none') return;
    const tb = document.getElementById('topbar');
    if (!tb) return;
    const h = tb.getBoundingClientRect().height;
    panel.style.maxHeight = `calc(100vh - ${h + 24}px)`;
    if (!movedByUser) panel.style.top = (h + 8) + 'px';
  }
  window.addEventListener('resize', reposition);
  const topbarEl = document.getElementById('topbar');
  if (topbarEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reposition).observe(topbarEl);
  }
  (() => {
    const header = document.getElementById('vocoder-header');
    if (!header || !panel) return;
    let dragging = false, dx = 0, dy = 0, pointerId = null;
    const VP_PAD = 4;
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, textarea')) return;
      if (e.button !== undefined && e.button !== 0) return;
      const r = panel.getBoundingClientRect();
      if (!movedByUser) {
        panel.style.transform = 'none';
        panel.style.left = r.left + 'px';
        panel.style.top  = r.top  + 'px';
        movedByUser = true;
      }
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      pointerId = e.pointerId;
      dragging = true;
      header.classList.add('dragging');
      try { header.setPointerCapture(pointerId); } catch {}
      e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const r = panel.getBoundingClientRect();
      const maxX = window.innerWidth  - r.width  - VP_PAD;
      const maxY = window.innerHeight - 32;
      const x = Math.min(Math.max(VP_PAD, e.clientX - dx), Math.max(VP_PAD, maxX));
      const y = Math.min(Math.max(VP_PAD, e.clientY - dy), Math.max(VP_PAD, maxY));
      panel.style.left = x + 'px';
      panel.style.top  = y + 'px';
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      header.classList.remove('dragging');
      savePanelPos('vocoder', panel);
      try { header.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  })();

  // ResizeObserver — persist position when the user resizes via CSS resize: both.
  if (panel && typeof ResizeObserver !== 'undefined') {
    let _rDebounce = 0;
    new ResizeObserver(() => {
      if (!movedByUser && !panel.style.width) return;
      clearTimeout(_rDebounce);
      _rDebounce = setTimeout(() => savePanelPos('vocoder', panel), 300);
    }).observe(panel);
  }

  // ── Open / close ───────────────────────────────────────────────────────
  function open() {
    if (panel) panel.style.display = '';
    savePanelOpen(true);
    reposition();
    refreshButton();
    // Re-enumerate: if the main mic has since been granted, device labels
    // are now available to fill the picker.
    micPicker.populate();
  }
  function close() {
    // Hiding the panel is purely a "hide UI" action — vocoding keeps running
    // so a performer can collapse the panel mid-narration without breaking
    // their voice path. Stop is its own explicit action via ■.
    if (panel) panel.style.display = 'none';
    savePanelOpen(false);
    refreshButton();
  }

  // ── Wire control buttons ───────────────────────────────────────────────
  if (btnToggle) btnToggle.addEventListener('click', () => {
    if (!panel) return;
    if (panel.style.display === 'none') open();
    else                                close();
  });
  if (btnClose) btnClose.addEventListener('click', close);
  if (btnPlay)  btnPlay .addEventListener('click', () => { start(); });
  if (btnStop)  btnStop .addEventListener('click', () => { stop(); });
  if (btnMute)  btnMute .addEventListener('click', () => { setMuted(!muted); });

  refreshMuteBtn();
  refreshPlayBtn();
  refreshFeedBtn();
  refreshButton();
  if (wasOpenLastSession) open();

  return {
    open, close,
    isOpen:   () => panel?.style.display !== 'none',
    start, stop,
    isActive: () => active,
    setMuted, isMuted: () => muted,
    setDevice,
    // Mixer surface — output level (0..2), limiter toggle, change subscription.
    setOutput, getOutput: () => cfg.output,
    setLimiter, getLimiter,
    onChange,
    // Snapshot/restore for the qualem state-saving system. getConfig returns
    // a plain copy of the current config; setConfig applies a partial config,
    // routing each field through its setter so live audio nodes update.
    getConfig: () => ({ ...cfg, harmonizer: harmonizer?.getConfig?.() }),
    setConfig: applyConfig,
    // 3rd-party Web Audio fx integration: the input node is the GainNode
    // straight off the mic source (insert pre-fx here), the output node is
    // the bus before output gain + mute (insert post-fx here), and the
    // context is the vocoder's own — use it to instantiate any nodes you
    // intend to connect into the chain.
    getInputNode:  () => inputGate,
    getOutputNode: () => outBus,
    getContext:    () => ctx,
    // Output analyser for audio-reactive modulation — null until the graph
    // is built. Paired with isFeedEnabled() so page-init knows whether to
    // adopt it as the 'vocoder' audio source.
    getFeedAnalyser: () => feedAnalyser,
    isFeedEnabled:   () => cfg.feedMix,
  };
}
