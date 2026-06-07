// Looper station panel — a third programmable audio source alongside Strudel
// and the sequencer. Captures the live audio input (pedal steel, voice, …),
// loops it locked to the Strudel metacycle grid, and plays it back for live
// performance / screen recording, with a Reaper-style "take in lanes" display.
//
// Mirrors createSequencer in shape: owns its floating panel DOM, lifecycle,
// drag, Strudel-sync controls (cycles + ÷2/×2), per-source mute/gain, and
// adoption into the audio.js source registry (so the loop feeds reactivity AND
// the recordable mix bus). Capture/playback live in looper-audio.js; the
// waveform canvas lives in looper-render.js.
//
// v1: single track, in-memory only (loops vanish on reload), varispeed stretch
// (pitch shifts with speed). Seams marked for multi-track, IndexedDB
// persistence, and pitch-preserving time-stretch.

import { createLooperAudio } from './looper-audio.js';
import { createLooperRenderer } from './looper-render.js';
import { wirePicker } from './devices.js';

const NS = 'voidstar.qualia.looper';
const PANEL_OPEN_KEY = `${NS}.panelOpen`;
const MASTER_KEY     = `${NS}.master`;     // overall looper output (header slider)
const LOOP_KEY       = `${NS}.loopVol`;    // recorded-loop playback level
const SYNC_KEY       = `${NS}.sync`;
const METACYCLE_KEY  = `${NS}.metacycle`;
const OFFSET_KEY     = `${NS}.offsetMs`;

const num01 = (raw, dflt) => { const v = parseFloat(raw); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt; };

function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }

export function createLooper({ audio, syncStrudel } = {}) {
  const panel       = document.getElementById('looper-panel');
  const propsEl     = document.getElementById('looper-props');
  const canvas      = document.getElementById('looper-canvas');
  const status      = document.getElementById('looper-status');
  const inputSelect = document.getElementById('looper-input');
  const btnToggle   = document.getElementById('btn-looper');
  const btnRecord   = document.getElementById('btn-looper-record');
  const btnPlay     = document.getElementById('btn-looper-play');
  const btnStop     = document.getElementById('btn-looper-stop');
  const btnMute     = document.getElementById('btn-looper-mute');
  const elGain      = document.getElementById('looper-gain');
  const btnSync     = document.getElementById('btn-looper-sync');
  const btnDelete   = document.getElementById('btn-looper-delete');
  const btnClose    = document.getElementById('btn-looper-close');

  const wasOpenLastSession = lsGet(PANEL_OPEN_KEY, '0') === '1';

  // Live model. Single track in v1; `track` becomes an array element in vNext.
  const model = {
    syncStrudel: lsGet(SYNC_KEY, '1') !== '0',
    metacycle: Math.max(1, Math.min(16, parseInt(lsGet(METACYCLE_KEY, '1'), 10) || 1)),
    cps: 0.5,                       // used when sync is off / Strudel idle
    offsetMs: (() => { const v = parseInt(lsGet(OFFSET_KEY, '0'), 10); return Number.isFinite(v) ? Math.max(-200, Math.min(500, v)) : 0; })(),
    master:   num01(lsGet(MASTER_KEY, '0.9'), 0.9),   // overall looper output
    loopVol:  num01(lsGet(LOOP_KEY, '0.5'), 0.5),     // recorded-loop playback (centre, Ditto-style)
    deviceId: '',                   // '' = default input; set by the picker
    track: null,                    // { buffer, sampleRate, loopStartBase, regionFrames, naturalSeconds, recordedCycles, cycles }
  };
  // The "input" knob is a proxy for the page-level mic monitor (audio.js) — one
  // shared path, so it's never double-counted. Off by default for feedback
  // safety; raise it (here or in the audio panel) to hear the live input.
  let _muted = false;
  let recording = false;
  let playing = false;
  let _everOpened = false;

  const looperAudio = createLooperAudio({ audio, syncStrudel });
  looperAudio.setMaster(model.master);
  looperAudio.setLoopVol(model.loopVol);
  looperAudio.setOffsetMs(model.offsetMs);

  const renderer = createLooperRenderer({
    canvas,
    getView: () => {
      const t = model.track;
      if (!t || !t.buffer) return null;
      const region = looperAudio.getLoopRegion(t) || { startFrame: 0, endFrame: t.buffer.length };
      return {
        buffer: t.buffer,
        startFrame: region.startFrame,
        endFrame: region.endFrame,
        metacycle: model.metacycle,
        cycles: t.cycles || model.metacycle,
        playhead01: playing ? looperAudio.getPlayhead01() : null,
      };
    },
    getRecordView: () => looperAudio.getLiveView(),
  });

  // ── helpers ──────────────────────────────────────────────────────────────
  function syncOn() { return !!model.syncStrudel; }
  function strudelLive() { return syncOn() && !!syncStrudel?.isStrudelPlaying?.(); }
  function currentCps() {
    if (strudelLive()) {
      const c = syncStrudel?.getStrudelCps?.();
      if (typeof c === 'number' && c > 0) return c;
    }
    return model.cps;
  }
  function setStatus(t) { if (status) status.textContent = t; }

  // ── transport ────────────────────────────────────────────────────────────
  async function startRecording() {
    if (recording) return;
    if (playing) stop();
    setStatus('arming…');
    try {
      const res = await looperAudio.startRecording({ metacycle: model.metacycle, syncOn: syncOn(), cps: currentCps(), deviceId: model.deviceId });
      recording = true;
      refreshTransport();
      refreshLooperBtn();
      renderer.start();
      // Labels become available once getUserMedia has granted — repopulate.
      try { picker?.populate?.(model.deviceId); } catch {}
      setStatus(res?.snapped ? 'recording — locks to cycle' : (syncOn() ? 'recording (strudel idle — free)' : 'recording…'));
    } catch (err) {
      console.warn('[qualia] looper record failed:', err);
      setStatus('mic error — check permissions');
      recording = false;
      refreshTransport();
    }
  }

  async function stopRecording() {
    if (!recording) return;
    setStatus('finishing…');
    const res = await looperAudio.stopRecording({ metacycle: model.metacycle, syncOn: syncOn() });
    recording = false;
    refreshLooperBtn();
    if (!res) {
      refreshTransport();
      renderer.stop();
      setStatus('nothing captured');
      return;
    }
    const cyc = (res.recordedCycles != null && res.recordedCycles > 0)
      ? res.recordedCycles
      : Math.max(model.metacycle, 1);
    // TODO(persist): encode res.buffer → IndexedDB for vNext reload survival.
    model.track = {
      buffer: res.buffer,
      sampleRate: res.sampleRate,
      loopStartBase: res.loopStartBase,
      regionFrames: res.regionFrames,
      naturalSeconds: res.naturalSeconds,
      recordedCycles: cyc,
      cycles: cyc,
    };
    renderer.invalidate();
    refreshTransport();
    refreshCyclesUI();
    setStatus(`recorded · ${fmtCyc(cyc)} cyc`);
    await play();
  }

  async function play() {
    if (!model.track) return;
    const ok = await looperAudio.play(model.track, { metacycle: model.metacycle, syncOn: syncOn(), cps: currentCps() });
    if (!ok) return;
    playing = true;
    refreshTransport();
    refreshLooperBtn();
    renderer.start();
    setStatus(strudelLive() ? 'looping · locked' : 'looping');
  }

  function stop() {
    looperAudio.stop();
    playing = false;
    refreshTransport();
    refreshLooperBtn();
    renderer.stop();
    if (model.track) setStatus('stopped');
  }

  function deleteTrack() {
    looperAudio.stop();
    playing = false;
    model.track = null;
    renderer.invalidate();
    renderer.stop();
    refreshTransport();
    refreshCyclesUI();
    refreshLooperBtn();
    setStatus('cleared');
  }

  // ÷2 / ×2 — change how many Strudel cycles the loop occupies (varispeed). The
  // buffer never changes; only playbackRate. Re-locks to the next boundary.
  function setTrackCycles(v) {
    if (!model.track) return;
    const next = Math.max(0.5, Math.min(64, v));
    if (next === model.track.cycles) return;
    model.track.cycles = next;
    renderer.invalidate();
    refreshCyclesUI();
    if (playing) play();
  }

  function realign() { if (playing) play(); }

  function setMuted(on) {
    _muted = !!on;
    looperAudio.setMuted(_muted);
    refreshMuteBtn();
  }
  // Master = overall looper output (header slider). Loop = recorded-take
  // playback level (50% default). Input = the shared page-level mic monitor.
  function setMaster(v) {
    model.master = Math.max(0, Math.min(1, Number(v) || 0));
    looperAudio.setMaster(model.master);
    lsSet(MASTER_KEY, model.master);
  }
  // Proxy the page-level mic monitor (audio.js) — one shared path, no doubling.
  // When the page mic isn't running (mix/off mode) there's no page source to
  // monitor, so bring up the looper's own capture to hear the input.
  function setInputVol(v) {
    const lvl = Math.max(0, Math.min(1, Number(v) || 0));
    audio?.setMonitorLevel?.(lvl);
    if (lvl > 0 && !audio?.hasSource?.('mic') && !looperAudio.isCapturing?.()) {
      looperAudio.startMonitor().then(refreshLooperBtn).catch(() => {});
    }
  }
  function setLoopVol(v) {
    model.loopVol = Math.max(0, Math.min(1, Number(v) || 0));
    looperAudio.setLoopVol(model.loopVol);
    lsSet(LOOP_KEY, model.loopVol);
  }
  // Nudge (ms): slides the loop window live to compensate record latency.
  // + = take plays earlier (pulls a late take into the pocket).
  function setOffsetMs(v) {
    model.offsetMs = Math.max(-200, Math.min(500, Math.round(Number(v) || 0)));
    looperAudio.setOffsetMs(model.offsetMs);
    lsSet(OFFSET_KEY, model.offsetMs);
    renderer.invalidate();        // region shifted → recompute peaks
    if (playing) play();          // re-lock at the next boundary with the new window
  }

  function fmtCyc(v) { return v === 0.5 ? '0.5' : String(v); }

  // ── props UI ───────────────────────────────────────────────────────────
  let cyclesIn = null;
  let _scaleBtns = null;
  let syncStatusEl = null;
  let inputVolSl = null;

  function renderProps() {
    if (!propsEl) return;
    propsEl.innerHTML = '';

    const mk = (label, child, title) => {
      const wrap = document.createElement('label');
      wrap.className = 'seq-prop';
      const sp = document.createElement('span');
      sp.className = 'seq-prop-label';
      sp.textContent = label;
      wrap.append(sp, child);
      if (title) wrap.title = title;
      return wrap;
    };
    const stepperFor = (input, eventName, bumpFn) => {
      const wrap = document.createElement('span');
      wrap.className = 'seq-num-wrap';
      const step = parseFloat(input.step) || 1;
      const min  = input.min !== '' ? parseFloat(input.min) : -Infinity;
      const max  = input.max !== '' ? parseFloat(input.max) : Infinity;
      const isInt = Number.isInteger(step);
      const decimals = isInt ? 0 : Math.max(0, (String(step).split('.')[1] || '').length);
      const bump = bumpFn || ((delta) => {
        const cur = parseFloat(input.value);
        const base = Number.isFinite(cur) ? cur : (Number.isFinite(min) ? min : 0);
        let next = Math.min(max, Math.max(min, base + delta * step));
        input.value = isInt ? String(Math.round(next)) : next.toFixed(decimals);
        input.dispatchEvent(new Event(eventName, { bubbles: true }));
      });
      const mkBtn = (txt, delta, title) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ctrl-btn seq-num-step';
        b.textContent = txt; b.title = title;
        b.addEventListener('click', (e) => { e.preventDefault(); bump(delta); });
        return b;
      };
      wrap.append(mkBtn('−', -1, 'Decrease'), input, mkBtn('+', +1, 'Increase'));
      return wrap;
    };

    // cps — only used when sync is off / Strudel idle.
    const cpsIn = document.createElement('input');
    cpsIn.type = 'number'; cpsIn.step = '0.05'; cpsIn.min = '0.1'; cpsIn.max = '4';
    cpsIn.value = String(model.cps); cpsIn.className = 'seq-num seq-num-wide';
    cpsIn.addEventListener('input', () => {
      const v = parseFloat(cpsIn.value);
      if (!Number.isFinite(v)) return;
      model.cps = Math.max(0.1, Math.min(4, v));
      if (playing && !strudelLive()) play();
    });

    // metacycle — Strudel cycles per metacycle (the record-snap grid + lane width).
    const metaIn = document.createElement('input');
    metaIn.type = 'number'; metaIn.step = '1'; metaIn.min = '1'; metaIn.max = '16';
    metaIn.value = String(model.metacycle); metaIn.className = 'seq-num';
    metaIn.addEventListener('change', () => {
      const v = Math.max(1, Math.min(16, parseInt(metaIn.value, 10) || 1));
      metaIn.value = String(v);
      if (v === model.metacycle) return;
      model.metacycle = v;
      lsSet(METACYCLE_KEY, v);
      renderer.invalidate();
      if (playing) play();
    });

    // cycles — how many Strudel cycles the recorded loop occupies (÷2/×2).
    cyclesIn = document.createElement('input');
    cyclesIn.type = 'number'; cyclesIn.step = '1'; cyclesIn.min = '0.5'; cyclesIn.max = '64';
    cyclesIn.value = model.track ? fmtCyc(model.track.cycles) : '—';
    cyclesIn.className = 'seq-num seq-num-wide';
    cyclesIn.disabled = !model.track;
    cyclesIn.addEventListener('change', () => {
      let v = parseFloat(cyclesIn.value);
      if (!Number.isFinite(v)) { refreshCyclesUI(); return; }
      v = v < 0.75 ? 0.5 : Math.round(v);
      setTrackCycles(v);
    });
    const cyclesBump = (delta) => {
      if (!model.track) return;
      const cur = model.track.cycles;
      const next = delta > 0 ? (cur < 1 ? 1 : cur + 1) : (cur > 1 ? cur - 1 : 0.5);
      setTrackCycles(next);
    };

    // ÷2 / ×2 length pair — halves/doubles the cycles span (varispeed stretch).
    const scalePair = (label, title, onHalf, onDouble) => {
      const wrap = document.createElement('span');
      wrap.className = 'seq-prop';
      if (title) wrap.title = title;
      const sp = document.createElement('span'); sp.className = 'seq-prop-label'; sp.textContent = label;
      const grp = document.createElement('span'); grp.className = 'seq-num-wrap';
      const mkB = (txt, fn, t) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ctrl-btn seq-num-step';
        b.textContent = txt; b.title = t;
        b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
        return b;
      };
      const bHalf = mkB('÷2', onHalf, title + ' — halve');
      const bDbl  = mkB('×2', onDouble, title + ' — double');
      grp.append(bHalf, bDbl);
      wrap.append(sp, grp);
      return { wrap, bHalf, bDbl };
    };
    const sLen = scalePair('stretch',
      'Stretch the loop to occupy half / double the Strudel cycles. v1 is varispeed — pitch shifts with speed.',
      () => { if (model.track) setTrackCycles(model.track.cycles / 2); },
      () => { if (model.track) setTrackCycles(model.track.cycles * 2); });
    _scaleBtns = { half: sLen.bHalf, dbl: sLen.bDbl };

    // sync strudel
    const syncCb = document.createElement('input');
    syncCb.type = 'checkbox'; syncCb.checked = !!model.syncStrudel;
    syncCb.addEventListener('change', () => {
      model.syncStrudel = !!syncCb.checked;
      lsSet(SYNC_KEY, model.syncStrudel ? '1' : '0');
      refreshSyncStatus();
      refreshSyncBtnVisibility();
    });
    const syncWrap = document.createElement('label');
    syncWrap.className = 'seq-prop seq-prop-check';
    syncWrap.title = 'Lock record IN/OUT and loop playback to the Strudel cycle grid. Off = free capture, set cps + cycles manually.';
    const syncLabel = document.createElement('span'); syncLabel.className = 'seq-prop-label'; syncLabel.textContent = 'sync strudel';
    syncStatusEl = document.createElement('span'); syncStatusEl.className = 'seq-sync-status';
    syncWrap.append(syncCb, syncLabel, syncStatusEl);

    // nudge (ms) — slides the loop window live to compensate record latency.
    const nudgeIn = document.createElement('input');
    nudgeIn.type = 'number'; nudgeIn.step = '5'; nudgeIn.min = '-200'; nudgeIn.max = '500';
    nudgeIn.value = String(model.offsetMs); nudgeIn.className = 'seq-num';
    nudgeIn.addEventListener('change', () => {
      setOffsetMs(nudgeIn.value);
      nudgeIn.value = String(model.offsetMs);
    });

    // input / loop volumes (Ditto-style): raw input full, loop playback centred.
    const volSlider = (value, onInput, title) => {
      const sl = document.createElement('input');
      sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.01';
      sl.value = String(value); sl.className = 'panel-gain-slider';
      if (title) sl.title = title;
      sl.addEventListener('input', () => onInput(sl.value));
      return sl;
    };
    inputVolSl = volSlider(audio?.getMonitor?.().level ?? 0, setInputVol,
      'Live input monitor — hear your mic through the speakers. Shared with the audio panel\'s monitor. OFF (0) by default; raising it can feed back on speakers (fine on headphones / an interface). For zero latency use your interface\'s direct monitoring instead.');
    const loopVolSl  = volSlider(model.loopVol, setLoopVol, 'Recorded-loop playback level — sits under the live input (50% by default, like a Ditto).');

    // preserve pitch — deferred seam (time-stretch not yet implemented).
    const ppCb = document.createElement('input');
    ppCb.type = 'checkbox'; ppCb.disabled = true;
    const ppWrap = document.createElement('label');
    ppWrap.className = 'seq-prop seq-prop-check';
    ppWrap.title = 'Preserve pitch while stretching (time-stretch) — coming in a later pass. v1 stretch is varispeed.';
    const ppLabel = document.createElement('span'); ppLabel.className = 'seq-prop-label'; ppLabel.textContent = 'preserve pitch (soon)';
    ppWrap.append(ppCb, ppLabel);

    propsEl.append(
      mk('cps', stepperFor(cpsIn, 'input'), 'Cycles per second when sync is off (Strudel\'s clock drives it when synced).'),
      mk('metacycle', stepperFor(metaIn, 'change'), 'Strudel cycles per metacycle — set this to your bar / phrase length. It is the record-snap grid (IN→next downbeat, OUT→nearest boundary) and the width of each waveform lane.'),
      mk('cycles', stepperFor(cyclesIn, 'change', cyclesBump), 'How many Strudel cycles the recorded loop occupies (a multiple of the metacycle).'),
      sLen.wrap,
      mk('nudge ms', stepperFor(nudgeIn, 'change'), 'Slide the loop into the pocket. + pulls a late take earlier to compensate record latency.'),
      mk('input', inputVolSl, 'Live input monitor level (full by default).'),
      mk('loop', loopVolSl, 'Recorded-loop playback level (50% by default, like a Ditto).'),
      syncWrap,
      ppWrap,
    );
    refreshCyclesUI();
    refreshSyncStatus();
  }

  function refreshCyclesUI() {
    if (!cyclesIn) return;
    cyclesIn.disabled = !model.track;
    cyclesIn.value = model.track ? fmtCyc(model.track.cycles) : '—';
    if (_scaleBtns) {
      _scaleBtns.half.disabled = !model.track || model.track.cycles <= 0.5;
      _scaleBtns.dbl.disabled  = !model.track || model.track.cycles >= 64;
    }
  }

  function refreshSyncStatus() {
    if (!syncStatusEl) return;
    if (!model.syncStrudel) { syncStatusEl.textContent = ''; syncStatusEl.dataset.state = 'off'; return; }
    const ready = !!syncStrudel?.isReady?.();
    syncStatusEl.textContent = ready ? '· connected' : '· waiting for strudel';
    syncStatusEl.dataset.state = ready ? 'connected' : 'waiting';
  }

  // ── button paint ─────────────────────────────────────────────────────────
  function refreshTransport() {
    if (btnRecord) {
      btnRecord.classList.toggle('recording', recording);
      btnRecord.textContent = recording ? '■' : '●';
      btnRecord.title = recording ? 'Stop recording' : 'Record';
    }
    if (btnPlay) { btnPlay.classList.toggle('playing', playing); btnPlay.disabled = !model.track || recording; }
    if (btnStop) btnStop.disabled = !playing;
    if (btnDelete) btnDelete.disabled = !model.track || recording;
    refreshSyncBtnVisibility();
  }
  function refreshMuteBtn() {
    if (!btnMute) return;
    btnMute.classList.toggle('muted', _muted);
    btnMute.textContent = _muted ? 'mute' : 'live';
    btnMute.title = _muted ? 'Unmute loop output' : 'Mute loop output (keeps looping in time)';
  }
  function refreshSyncBtnVisibility() {
    if (!btnSync) return;
    btnSync.style.display = (model.syncStrudel && model.track) ? '' : 'none';
  }
  function refreshLooperBtn() {
    if (!btnToggle) return;
    btnToggle.classList.remove('active', 'active-audio');
    const live = audio?.hasSource?.('looper');
    const open = panel?.style.display !== 'none';
    if (live) { btnToggle.classList.add('active-audio'); btnToggle.textContent = 'loop ●'; }
    else if (open) { btnToggle.classList.add('active'); btnToggle.textContent = 'loop on'; }
    else btnToggle.textContent = 'loop';
  }

  // ── device picker ────────────────────────────────────────────────────────
  const picker = wirePicker({
    select: inputSelect,
    kind: 'audioinput',
    storeKind: 'looperInput',
    leadingOption: { value: '', label: 'default input' },
    getCurrentId: () => model.deviceId || null,
    onChoose: async (id) => {
      model.deviceId = id || '';
      try { await looperAudio.setInputDevice(model.deviceId); } catch (e) { console.warn('[qualia] looper device switch failed:', e); }
      return model.deviceId;
    },
  });

  // ── drag (mirror sequencer) ──────────────────────────────────────────────
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
  if (topbarEl && typeof ResizeObserver !== 'undefined') new ResizeObserver(reposition).observe(topbarEl);
  (() => {
    const header = document.getElementById('looper-header');
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
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      pointerId = e.pointerId; dragging = true;
      header.classList.add('dragging');
      try { header.setPointerCapture(pointerId); } catch {}
      e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const r = panel.getBoundingClientRect();
      const maxX = window.innerWidth - r.width - VP_PAD;
      const maxY = window.innerHeight - 32;
      const x = Math.min(Math.max(VP_PAD, e.clientX - dx), Math.max(VP_PAD, maxX));
      const y = Math.min(Math.max(VP_PAD, e.clientY - dy), Math.max(VP_PAD, maxY));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
    });
    const end = () => {
      if (!dragging) return;
      dragging = false; header.classList.remove('dragging');
      try { header.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  })();

  // ── open / close ─────────────────────────────────────────────────────────
  function open() {
    if (panel) panel.style.display = '';
    _everOpened = true;
    lsSet(PANEL_OPEN_KEY, '1');
    reposition();
    if (!propsEl?.children.length) renderProps();
    renderer.resize();
    try { picker?.populate?.(model.deviceId); } catch {}
    if (inputVolSl) inputVolSl.value = String(audio?.getMonitor?.().level ?? 0);
    refreshLooperBtn();
    refreshTransport();
  }
  function close() {
    if (panel) panel.style.display = 'none';
    lsSet(PANEL_OPEN_KEY, '0');
    refreshLooperBtn();
  }

  // ── wire buttons ─────────────────────────────────────────────────────────
  if (btnToggle) btnToggle.addEventListener('click', () => {
    if (!panel) return;
    if (panel.style.display === 'none') open(); else close();
  });
  if (btnClose)  btnClose.addEventListener('click', close);
  if (btnRecord) btnRecord.addEventListener('click', () => { recording ? stopRecording() : startRecording(); });
  if (btnPlay)   btnPlay.addEventListener('click', () => { play(); });
  if (btnStop)   btnStop.addEventListener('click', () => { stop(); });
  if (btnMute)   btnMute.addEventListener('click', () => { setMuted(!_muted); });
  if (btnSync)   btnSync.addEventListener('click', () => { realign(); });
  if (btnDelete) btnDelete.addEventListener('click', () => { if (model.track) deleteTrack(); });
  if (elGain) {
    elGain.value = String(model.master);
    elGain.addEventListener('input', () => setMaster(elGain.value));
  }

  // Repaint topbar/state when audio.js flips the looper source on/off.
  audio?.onChange?.(() => refreshLooperBtn());
  // Keep the "input" knob in sync with the shared page-level mic monitor (it can
  // also be changed from the audio panel).
  audio?.onMonitorChange?.((m) => { if (inputVolSl) inputVolSl.value = String(m.level); });
  syncStrudel?.onReadyChange?.(() => refreshSyncStatus());

  // Initial paint even while hidden so first open() shows content immediately.
  if (propsEl) renderProps();
  refreshMuteBtn();
  refreshTransport();
  refreshLooperBtn();
  refreshSyncBtnVisibility();

  if (wasOpenLastSession) open();

  // perFrame is a no-op: the renderer self-drives its own rAF while
  // recording/playing. Exposed for symmetry with the sequencer's page-init hook.
  function perFrame() {}

  return {
    open, close,
    isOpen: () => panel?.style.display !== 'none',
    hasBeenOpened: () => _everOpened,
    isPlaying: () => playing,
    isRecording: () => recording,
    play, stop,
    perFrame,
    dispose: () => { looperAudio.dispose(); renderer.dispose(); },
  };
}
