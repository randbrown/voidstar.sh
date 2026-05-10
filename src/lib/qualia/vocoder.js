// Channel vocoder panel — mic input is the modulator, an internal sustained
// oscillator (or noise) is the carrier. Voice band envelopes shape matching
// carrier bands; the sum is what reaches the speakers.
//
// Design priority is intelligibility for live narration over a "creative"
// timbre — robotic but understandable. Two intelligibility levers:
//   1. HF sibilance passthrough — frictives ("s", "f", "t") have no harmonic
//      structure for the carrier to modulate, so a vocoder without an HF
//      bypass turns every sibilant into a low buzz. We bleed 3.5–9 kHz of
//      raw voice into the output.
//   2. Optional dry mix — sends a small amount of unprocessed voice through.
//      Default 0 (pure vocoder), but the user can dial it up if a venue needs
//      extra clarity.
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
// Mic device selection follows whatever the page's main mic picker is set to
// (via getDeviceId callback). The vocoder opens its own getUserMedia stream
// so two captures of the same physical mic exist simultaneously when audio
// analysis is also on; modern browsers handle this fine.

import { getStoredDeviceId } from './devices.js';

const NS              = 'voidstar.qualia.vocoder';
const PANEL_OPEN_KEY  = `${NS}.panelOpen`;
const CONFIG_KEY      = `${NS}.config`;

const DEFAULT_CONFIG = {
  carrierType: 'drone', // sawtooth | square | triangle | drone | noise
  pitch:       110,     // Hz — fundamental for tonal carriers
  bands:       16,      // BPF count across the formant range
  sibilance:   0.40,    // HF voice passthrough mix (0..1)
  dry:         0.0,     // dry voice passthrough mix (0..1)
  output:      0.9,     // master output gain (0..2)
};

const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl:  false,
};

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
// signal into |x|, which is then lowpassed into an envelope.
function rectifierCurve(len = 1024) {
  const c = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1;
    c[i] = Math.abs(x);
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

export function createVocoder({ getDeviceId } = {}) {
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
  const elOut     = document.getElementById('voc-output');
  const elOutVal  = document.getElementById('voc-output-val');

  // ── Audio state ────────────────────────────────────────────────────────
  let ctx        = null;
  let stream     = null;
  let active     = false;
  let muted      = false;

  // Graph nodes — reset on every (re)build.
  let micSource    = null;
  let inputGate    = null;
  let outBus       = null;
  let outputGain   = null;
  let muteGate     = null;
  let dryGain      = null;
  let sibChain     = null;     // {hpf, lpf, gain}
  let carrierBus   = null;
  let carrierVoices = [];      // [{ sources: [{node, ratio}], outGain }]
  let modBPFs      = [];
  let carrierBPFs  = [];
  let envFollowers = [];       // [{ rect, lpf, depth }]
  let bandVCAs     = [];

  // ── Persistence ────────────────────────────────────────────────────────
  let saveT = null;
  function persistSoon() {
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(() => { saveConfig(cfg); saveT = null; }, 400);
  }

  // ── UI sync ────────────────────────────────────────────────────────────
  function syncPropsFromCfg() {
    if (elCarrier) elCarrier.value = cfg.carrierType;
    if (elPitch)   elPitch.value   = String(cfg.pitch);
    if (elBands)   elBands.value   = String(cfg.bands);
    if (elSib)     elSib.value     = String(cfg.sibilance);
    if (elDry)     elDry.value     = String(cfg.dry);
    if (elOut)     elOut.value     = String(cfg.output);
    paintRanges();
  }
  function paintRanges() {
    if (elSibVal) elSibVal.textContent = cfg.sibilance.toFixed(2);
    if (elDryVal) elDryVal.textContent = cfg.dry.toFixed(2);
    if (elOutVal) elOutVal.textContent = cfg.output.toFixed(2);
  }
  function refreshButton() {
    if (!btnToggle) return;
    btnToggle.classList.remove('active', 'active-audio');
    const open = panel?.style.display !== 'none';
    if (active) {
      btnToggle.classList.add('active-audio');
      btnToggle.textContent = 'voc ●';
    } else if (open) {
      btnToggle.classList.add('active');
      btnToggle.textContent = 'voc on';
    } else {
      btnToggle.textContent = 'voc';
    }
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

  function makeCarrier(c, type, pitch) {
    if (type === 'noise') {
      const src = c.createBufferSource();
      src.buffer = pinkNoiseBuffer(c, 2);
      src.loop = true;
      const out = c.createGain(); out.gain.value = 1;
      src.connect(out);
      src.start();
      return [{ sources: [{ node: src, ratio: 1, isOsc: false }], outGain: out }];
    }
    if (type === 'drone') {
      // Fundamental + sub-octave saw — gives the robot voice some chest.
      const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = pitch;
      const o2 = c.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = pitch * 0.5;
      const out = c.createGain(); out.gain.value = 0.7;
      o1.connect(out); o2.connect(out);
      o1.start(); o2.start();
      return [{
        sources: [
          { node: o1, ratio: 1.0, isOsc: true },
          { node: o2, ratio: 0.5, isOsc: true },
        ],
        outGain: out,
      }];
    }
    // sawtooth / square / triangle
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = pitch;
    const out = c.createGain(); out.gain.value = 1;
    o.connect(out);
    o.start();
    return [{ sources: [{ node: o, ratio: 1, isOsc: true }], outGain: out }];
  }

  function buildGraph() {
    const c = ensureContext();
    const N = cfg.bands;
    const freqs = bandFrequencies(N);
    const Q = 6;  // BPF selectivity — sharp enough to resolve formants, not so sharp it rings.

    // Output chain. muteGate is tagged so the strudel mute-patch (if it ever
    // shares this ctx in some future world) leaves it alone — the vocoder
    // owns its own per-source mute via `muted`.
    outBus     = c.createGain(); outBus.gain.value = 1;
    outputGain = c.createGain(); outputGain.gain.value = cfg.output;
    muteGate   = c.createGain(); muteGate.gain.value = muted ? 0 : 1;
    muteGate.__qualiaBypassMute = true;
    outBus.connect(outputGain);
    outputGain.connect(muteGate);
    muteGate.connect(c.destination);

    // Mic input.
    inputGate = c.createGain(); inputGate.gain.value = 1;
    micSource = c.createMediaStreamSource(stream);
    micSource.connect(inputGate);

    // HF sibilance passthrough — band-limited to 3.5–9 kHz so we get the
    // crispness of "s/sh/t" without dragging in low-frequency room rumble or
    // ultrasonic mic noise.
    {
      const hpf = c.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 3500; hpf.Q.value = 0.7;
      const lpf = c.createBiquadFilter(); lpf.type = 'lowpass';  lpf.frequency.value = 9000; lpf.Q.value = 0.7;
      const g   = c.createGain(); g.gain.value = cfg.sibilance;
      inputGate.connect(hpf); hpf.connect(lpf); lpf.connect(g); g.connect(outBus);
      sibChain = { hpf, lpf, gain: g };
    }

    // Dry passthrough.
    {
      const g = c.createGain(); g.gain.value = cfg.dry;
      inputGate.connect(g); g.connect(outBus);
      dryGain = g;
    }

    // Carrier source(s) → shared carrier bus → per-band carrier BPFs.
    carrierVoices = makeCarrier(c, cfg.carrierType, cfg.pitch);
    carrierBus = c.createGain(); carrierBus.gain.value = 1;
    for (const v of carrierVoices) v.outGain.connect(carrierBus);

    // Per-band: BPF(modulator) → rectify → LPF (envelope) → depthScale → vca.gain
    //           BPF(carrier)  → vca → outBus
    // The rectified+lowpassed envelope drives the VCA's gain AudioParam; the
    // depth gain scales 0..1 envelope into a 0..N range so the carrier band
    // actually punches through. Five empirically gives a balanced output
    // without clipping when summed across 16 bands.
    const rectCurve = rectifierCurve();
    for (let i = 0; i < N; i++) {
      const f = freqs[i];

      const modBPF = c.createBiquadFilter();
      modBPF.type = 'bandpass'; modBPF.frequency.value = f; modBPF.Q.value = Q;
      inputGate.connect(modBPF);

      const rect = c.createWaveShaper(); rect.curve = rectCurve;
      modBPF.connect(rect);

      const env = c.createBiquadFilter();
      env.type = 'lowpass'; env.frequency.value = 25; env.Q.value = 0.707;
      rect.connect(env);

      const depth = c.createGain(); depth.gain.value = 5;
      env.connect(depth);

      const carBPF = c.createBiquadFilter();
      carBPF.type = 'bandpass'; carBPF.frequency.value = f; carBPF.Q.value = Q;
      carrierBus.connect(carBPF);

      // Start with vca.gain.value = 0 so silence in (no envelope) → silence out.
      const vca = c.createGain(); vca.gain.value = 0;
      depth.connect(vca.gain);
      carBPF.connect(vca);
      vca.connect(outBus);

      modBPFs.push(modBPF);
      carrierBPFs.push(carBPF);
      envFollowers.push({ rect, lpf: env, depth });
      bandVCAs.push(vca);
    }
  }

  function teardownGraph() {
    const stopSafe = (n) => { try { n.stop(); } catch {} };
    const disc = (n) => { try { n.disconnect(); } catch {} };

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
    if (sibChain)  { disc(sibChain.hpf); disc(sibChain.lpf); disc(sibChain.gain); sibChain = null; }
    if (dryGain)   { disc(dryGain);   dryGain   = null; }
    if (carrierBus){ disc(carrierBus); carrierBus = null; }
    if (micSource) { disc(micSource); micSource = null; }
    if (inputGate) { disc(inputGate); inputGate = null; }
    if (outBus)    { disc(outBus);    outBus    = null; }
    if (outputGain){ disc(outputGain); outputGain= null; }
    if (muteGate)  { disc(muteGate);  muteGate  = null; }
  }

  // Rebuild the graph in place — used when the user changes carrier type or
  // band count while running. The mic stream is preserved so the user
  // doesn't have to re-grant permission or hear a glitch from the OS-level
  // capture restart.
  function rebuildGraph() {
    if (!active) return;
    teardownGraph();
    buildGraph();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  async function start() {
    if (active) return true;
    try {
      const id = (typeof getDeviceId === 'function' && getDeviceId()) || getStoredDeviceId('mic');
      stream = await openMic(id);
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
  }

  // External hook used by page-init when the user changes the topbar mic
  // selection — rebuild our capture so the vocoder follows the same device.
  async function setDevice(_id) {
    if (!active) return;
    stop();
    await start();
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
    if (active && ctx) {
      // Live update — ramp every oscillator's frequency. Noise carrier has
      // no .frequency to set; ratio is preserved per source so the drone's
      // sub-octave stays an octave below the new fundamental.
      const t = ctx.currentTime;
      for (const voice of carrierVoices) {
        for (const s of voice.sources) {
          if (!s.isOsc) continue;
          try {
            s.node.frequency.cancelScheduledValues(t);
            s.node.frequency.linearRampToValueAtTime(v * s.ratio, t + 0.02);
          } catch {}
        }
      }
    }
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
  function setOutput(v) {
    cfg.output = Math.max(0, Math.min(2, +v || 0));
    persistSoon();
    paintRanges();
    if (outputGain && ctx) {
      try { outputGain.gain.linearRampToValueAtTime(cfg.output, ctx.currentTime + 0.05); } catch {}
    }
  }

  // ── Wire UI controls ───────────────────────────────────────────────────
  syncPropsFromCfg();
  if (elCarrier) elCarrier.addEventListener('change', () => setCarrierType(elCarrier.value));
  if (elPitch)   elPitch.addEventListener('change',   () => setPitch(elPitch.value));
  if (elBands)   elBands.addEventListener('change',   () => setBandCount(elBands.value));
  if (elSib)     elSib.addEventListener('input',      () => setSibilance(elSib.value));
  if (elDry)     elDry.addEventListener('input',      () => setDry(elDry.value));
  if (elOut)     elOut.addEventListener('input',      () => setOutput(elOut.value));

  // ── Drag / reposition (mirror sequencer & strudel panels) ──────────────
  let movedByUser = false;
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
      try { header.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  })();

  // ── Open / close ───────────────────────────────────────────────────────
  function open() {
    if (panel) panel.style.display = '';
    savePanelOpen(true);
    reposition();
    refreshButton();
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
  refreshButton();
  if (wasOpenLastSession) open();

  return {
    open, close,
    isOpen:   () => panel?.style.display !== 'none',
    start, stop,
    isActive: () => active,
    setMuted, isMuted: () => muted,
    setDevice,
    // 3rd-party Web Audio fx integration: the input node is the GainNode
    // straight off the mic source (insert pre-fx here), the output node is
    // the bus before output gain + mute (insert post-fx here), and the
    // context is the vocoder's own — use it to instantiate any nodes you
    // intend to connect into the chain.
    getInputNode:  () => inputGate,
    getOutputNode: () => outBus,
    getContext:    () => ctx,
  };
}
