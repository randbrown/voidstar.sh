// Mixer — one compact panel that gathers every audio track's level, mute, and
// brickwall limiter into channel strips, with live peak meters and clip LEDs.
//
// Why it exists: the app has no single master bus (each track lives in its own
// AudioContext and writes straight to the device — see limiter.js). The faders
// here don't sum into one node; each one drives that track's existing output
// gain in its own context. So this panel is a *surface* over controls that
// already live scattered across the strudel / seq / vox / rig panels — it
// doesn't re-plumb audio, it just collects the knobs in one place and adds the
// per-track limiter toggles + metering the individual panels never had.
//
// Metering is read-only and cheap: audio.js already computes per-source peak +
// clip every frame from the analyser buffers it reads anyway, so the meter loop
// just polls audio.getLevels() while the panel is open. The topbar CLIP light
// is wired separately (page-init) off audio.onClipChange so it works panel-shut.

import { makeDraggablePanel } from './panel-pos.js';

const OPEN_KEY = 'voidstar.qualia.mixer.open';

// Peak meter colour ramp — cyan in the safe zone, amber as it gets hot, pink at
// the ceiling. Matches the panel chrome's cyan/pink accents.
function meterColor(p) {
  if (p >= 0.985) return 'var(--pink)';
  if (p >= 0.8)   return '#f5b342';
  return 'var(--cyan)';
}

export function createMixer({ audio, strudel, sequencer, looper, vocoder } = {}) {
  const panel     = document.getElementById('mixer-panel');
  const body      = document.getElementById('mixer-body');
  const btnToggle = document.getElementById('btn-mixer');
  const btnClose  = document.getElementById('btn-mixer-close');
  if (!panel || !body) {
    // Markup missing — return a no-op surface so page-init wiring stays safe.
    return { open() {}, close() {}, isOpen: () => false, hasBeenOpened: () => false };
  }

  // ── Channel adapters ──────────────────────────────────────────────────────
  // Each track exposes a different setter/getter shape; normalise them here so
  // the rendering + metering code below is uniform. `meters` lists the audio.js
  // source ids whose peak/clip feed this channel's meter (rig folds in loops).
  // `max` is the fader's top. 1.0 is nominal (loudness-matched across buses);
  // strudel/seq go to 1.5 for weak-signal boost, vox output runs 0..2, and
  // mic/rig stay at unity (they pass reference-trimmed sources). Per-track
  // limiters catch any clipping the extra headroom introduces.
  const channels = [
    {
      id: 'mic', label: 'mic', max: 1, meters: ['mic'],
      title: 'Live input monitor (mic / instrument)',
      getLevel:   () => audio.getInput().level,
      getMuted:   () => audio.getInput().muted,
      getLimiter: () => audio.getInput().limiter,
      setLevel:   (v) => audio.setInputLevel(v),
      setMuted:   (on) => audio.setInputMuted(on),
      setLimiter: (on) => audio.setInputLimiter(on),
      subscribe:  (cb) => audio.onInputChange(cb),
    },
    {
      id: 'rig', label: 'rig', max: 1, meters: ['rig', 'looper'],
      title: 'Rig master — live pedal-steel signal + loops',
      getLevel:   () => looper.getRig().level,
      getMuted:   () => looper.getRig().muted,
      getLimiter: () => looper.getRig().limiter,
      setLevel:   (v) => looper.setRigLevel(v),
      setMuted:   (on) => looper.setRigMuted(on),
      setLimiter: (on) => looper.setRigLimiter(on),
      subscribe:  (cb) => looper.onMixChange(cb),
    },
    {
      id: 'strudel', label: 'strudel', max: 1.5, meters: ['strudel'],
      title: 'Strudel live-coding bus (0–1.5×; >1.0 boosts a weak pattern)',
      getLevel:   () => strudel.getVolume(),
      getMuted:   () => strudel.isMuted(),
      getLimiter: () => strudel.getLimiter(),
      setLevel:   (v) => strudel.setVolume(v),
      setMuted:   (on) => strudel.setMuted(on),
      setLimiter: (on) => strudel.setLimiter(on),
      subscribe:  (cb) => strudel.onChange(cb),
    },
    {
      id: 'seq', label: 'seq', max: 1.5, meters: ['sequencer'],
      title: 'Pattern sequencer bus (0–1.5×; loudness-matched at 1.0, >1.0 boosts)',
      getLevel:   () => sequencer.getVolume(),
      getMuted:   () => sequencer.isMuted(),
      getLimiter: () => sequencer.getLimiter(),
      setLevel:   (v) => sequencer.setVolume(v),
      setMuted:   (on) => sequencer.setMuted(on),
      setLimiter: (on) => sequencer.setLimiter(on),
      subscribe:  (cb) => sequencer.onChange(cb),
    },
    {
      id: 'vox', label: 'vox', max: 2, meters: ['vocoder'],
      title: 'Vox — vocal fx output (0–2× gain)',
      getLevel:   () => vocoder.getOutput(),
      getMuted:   () => vocoder.isMuted(),
      getLimiter: () => vocoder.getLimiter(),
      setLevel:   (v) => vocoder.setOutput(v),
      setMuted:   (on) => vocoder.setMuted(on),
      setLimiter: (on) => vocoder.setLimiter(on),
      subscribe:  (cb) => vocoder.onChange(cb),
    },
  ];

  // ── Build channel strips ──────────────────────────────────────────────────
  // One row each: name · peak meter · fader · mute · limiter · clip LED. Built
  // in JS (the rows are uniform + data-driven) into the static panel shell.
  for (const ch of channels) {
    const row = document.createElement('div');
    row.className = 'mx-ch';
    row.dataset.id = ch.id;
    row.title = ch.title;

    const name = document.createElement('span');
    name.className = 'mx-ch-name';
    name.textContent = ch.label;

    const meter = document.createElement('div');
    meter.className = 'mx-meter';
    const fill = document.createElement('span');
    fill.className = 'mx-meter-fill';
    meter.appendChild(fill);

    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'mx-fader';
    fader.min = '0'; fader.max = String(ch.max); fader.step = '0.01';
    fader.setAttribute('aria-label', `${ch.label} level`);
    fader.addEventListener('input', () => ch.setLevel(+fader.value));

    const mute = document.createElement('button');
    mute.className = 'ctrl-btn panel-mute-btn mx-mute';
    mute.addEventListener('click', () => ch.setMuted(!ch.getMuted()));

    const lim = document.createElement('button');
    lim.className = 'ctrl-btn mx-lim';
    lim.textContent = 'lim';
    lim.title = 'Brickwall limiter — clip insurance on this track. On by default.';
    lim.addEventListener('click', () => ch.setLimiter(!ch.getLimiter()));

    const clip = document.createElement('span');
    clip.className = 'mx-clip';
    clip.title = 'Clip / over — this track hit full scale';

    row.append(name, meter, fader, mute, lim, clip);
    body.appendChild(row);

    // Cache the live elements on the channel for the sync + meter loops.
    ch.el = { row, fader, fill, mute, lim, clip };
    ch.disp = 0;   // smoothed meter level (fast attack, slow decay)

    // Two-way sync: when the track's own panel changes the value, mirror it
    // here. Subscribed once at init (cheap; DOM is hidden when closed).
    if (ch.subscribe) ch.subscribe(() => syncChannel(ch));
    syncChannel(ch);
  }

  // Push a channel's control state (level / mute / limiter) into its DOM
  // without firing the input listeners (setting .value to its current string is
  // a no-op for the 'input' event).
  function syncChannel(ch) {
    const { fader, mute, lim } = ch.el;
    const lvl = String(ch.getLevel());
    if (fader.value !== lvl) fader.value = lvl;
    const muted = ch.getMuted();
    mute.textContent = muted ? 'mute' : 'live';
    mute.classList.toggle('muted', muted);
    const limOn = ch.getLimiter();
    lim.classList.toggle('active', limOn);
    lim.textContent = limOn ? 'lim' : 'lim✕';
  }

  // ── Meter loop (only while open) ──────────────────────────────────────────
  let raf = 0;
  function meterFrame() {
    raf = requestAnimationFrame(meterFrame);
    const levels = audio.getLevels();   // reused object; no allocation
    for (const ch of channels) {
      let peak = 0, clipping = false;
      for (const mId of ch.meters) {
        const e = levels[mId];
        if (!e) continue;
        if (e.peak > peak) peak = e.peak;
        if (e.clipping) clipping = true;
      }
      // Fast attack, slow decay so the bar is readable across a room.
      ch.disp = peak > ch.disp ? peak : ch.disp * 0.86;
      const pct = Math.min(100, ch.disp * 100);
      ch.el.fill.style.width = pct.toFixed(1) + '%';
      ch.el.fill.style.background = meterColor(ch.disp);
      ch.el.clip.classList.toggle('lit', clipping);
    }
  }
  function startMeters() { if (!raf) raf = requestAnimationFrame(meterFrame); }
  function stopMeters()  { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  // ── Open / close ──────────────────────────────────────────────────────────
  let _everOpened = false;
  function refreshBtn() {
    if (!btnToggle) return;
    btnToggle.classList.toggle('active', panel.style.display !== 'none');
  }
  function open() {
    panel.style.display = '';
    _everOpened = true;
    try { localStorage.setItem(OPEN_KEY, '1'); } catch {}
    reposition();
    for (const ch of channels) syncChannel(ch);   // catch up on changes made while closed
    startMeters();
    refreshBtn();
  }
  function close() {
    panel.style.display = 'none';
    try { localStorage.setItem(OPEN_KEY, '0'); } catch {}
    stopMeters();
    refreshBtn();
  }
  function toggle() { (panel.style.display === 'none') ? open() : close(); }

  if (btnToggle) btnToggle.addEventListener('click', toggle);
  if (btnClose)  btnClose.addEventListener('click', close);

  // ── Drag / reposition / persist (shared helper) ───────────────────────────
  const reposition = makeDraggablePanel('mixer', panel);

  // Restore last-session open state (parity with the other panels).
  let wasOpen = false;
  try { wasOpen = localStorage.getItem(OPEN_KEY) === '1'; } catch {}
  if (wasOpen) open(); else refreshBtn();

  return {
    open, close, toggle,
    isOpen: () => panel.style.display !== 'none',
    hasBeenOpened: () => _everOpened,
    // Programmatic surface (console / Strudel) — drive a channel by id.
    setLevel:   (id, v)  => channels.find(c => c.id === id)?.setLevel(v),
    setMuted:   (id, on) => channels.find(c => c.id === id)?.setMuted(on),
    setLimiter: (id, on) => channels.find(c => c.id === id)?.setLimiter(on),
    channelIds: () => channels.map(c => c.id),
  };
}
