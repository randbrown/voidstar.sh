// Rig panel — the live performance station. Top level is the live instrument
// "signal" (the page-level input channel: level + mute + an oscilloscope of the
// captured signal, feeding speakers + visualizer + the recordable mix). Built
// on top of it is the "loop" subpanel — a programmable audio source alongside
// Strudel and the sequencer that captures the input, loops it locked to the
// Strudel cycle grid, and plays it back for live performance / screen recording
// as a Reaper-style multi-track list of "take in lanes" waveforms.
//
// The factory is still createLooper(); the loop subpanel's controls keep their
// `looper-*` element ids (this code keys off them), while rig-level chrome
// (signal scope, subpanels) uses `rig-*` ids.
//
// Multi-track: a list of loop tracks, ONE armed at a time. Recording targets
// the armed track (replace). Each track has its own cycles (grid), length,
// stretch (÷2/×2), volume, and mute, mixed independently into one summed
// 'looper' output adopted into audio.js (so the mix feeds reactivity AND the
// recordable screen-recording bus). Capture/playback live in looper-audio.js
// (multi-voice); each row's waveform canvas lives in looper-render.js.
//
// The live input is a page-level concern now (the audio.js 'mic' input
// channel, surfaced here as the "input" row) — it lands on speakers + the
// recording + the visualizer independent of the looper's loop voices.
//
// v2: in-memory only (loops vanish on reload — IndexedDB persistence is a
// later pass), varispeed stretch (pitch shifts with speed; pitch-preserving
// time-stretch is a later pass).

import { createLooperAudio } from './looper-audio.js';
import { STRIP_DEFAULTS } from './rig-strip.js';
import { parseAmpModel } from './neural-amp-model.js';
import { createLooperRenderer } from './looper-render.js';
import * as loopStore from './looper-store.js';
import { wirePicker, getStoredDeviceId } from './devices.js';
import { savePanelPos, restorePanelPos } from './panel-pos.js';

const NS = 'voidstar.qualia.looper';
const PANEL_OPEN_KEY = `${NS}.panelOpen`;
const MASTER_KEY     = `${NS}.master`;     // overall looper output (header slider)
const SYNC_KEY       = `${NS}.sync`;
const GRID_KEY       = `${NS}.grid`;       // default "cycles" (grid) for new tracks
const OFFSET_KEY     = `${NS}.offsetMs`;
const IMMEDIATE_KEY  = `${NS}.immediate`;  // "start now" (drop in mid-cycle) vs wait for boundary
const RETRO_KEY      = `${NS}.retroCycles`;// cycles the retro "grab" captures
const BUFFER_KEY     = `${NS}.buffer`;     // keep the live lookback buffer filling
const SIGLEVEL_KEY   = `${NS}.signalLevel`;// rig signal monitor/mix level
const SIGMUTE_KEY    = `${NS}.signalMuted`;// rig signal mute
const CHANNELS_KEY   = `${NS}.channels`;   // input: 'mono' | 'stereo'
const STRIP_KEY      = `${NS}.strip`;      // channel strip config (JSON)
const STRIPOPEN_KEY  = `${NS}.stripOpen`;  // strip subpanel expanded
const LOOPCOLLAPSE_KEY = `${NS}.loopCollapsed`; // looper tracks collapsed
const TUNER_KEY      = `${NS}.tuner`;      // tuner enabled
const TUNERMUTE_KEY  = `${NS}.tunerMute`; // mute rig signal while tuner is on
const TEMPER_KEY     = `${NS}.temperament`;// 'et' | 'custom'
const CUSTOMCENTS_KEY = `${NS}.customCents`;// custom temperament: int cents[12]
const REFPITCH_KEY   = `${NS}.refPitch`;   // tuner reference A (Hz)
const CABNAME_KEY    = `${NS}.cabName`;     // loaded cab IR filename (display)
const CAB_IR_ID      = 'cabIR';            // IndexedDB misc key for the IR bytes
const AMPNAME_KEY    = `${NS}.ampName`;     // loaded neural amp model name (display)
const AMP_MODEL_ID   = 'ampModel';         // IndexedDB misc key for the normalised model
const INPUT_DEFAULT  = 0.7;                // double-click-reset target for the input fader

// Channel strip UI schema — stages + params (the audio side lives in
// rig-strip.js; STRIP_DEFAULTS supplies initial values).
const STRIP_SCHEMA = [
  { id: 'hpf',    name: 'hpf',    toggle: true,  params: [{ id: 'freq', label: 'freq', min: 20, max: 400, step: 1, fmt: v => `${v|0}Hz` }] },
  { id: 'earth',  name: 'earth',  toggle: true,  params: [
    { id: 'drive', label: 'gain', min: 0, max: 1, step: 0.01 },
    { id: 'tone', label: 'tone', min: 0, max: 1, step: 0.01 },
    { id: 'level', label: 'lvl', min: 0, max: 1, step: 0.01 },
  ] },
  { id: 'metal',  name: 'metal',  toggle: true,  params: [
    { id: 'drive', label: 'gain', min: 0, max: 1, step: 0.01 },
    { id: 'low', label: 'low', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` },
    { id: 'mid', label: 'mid', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` },
    { id: 'midFreq', label: 'mFq', min: 200, max: 5000, step: 10, fmt: v => `${v|0}Hz` },
    { id: 'high', label: 'high', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` },
    { id: 'level', label: 'lvl', min: 0, max: 1, step: 0.01 },
  ] },
  { id: 'comp',   name: 'comp',   toggle: true,  params: [{ id: 'threshold', label: 'thr', min: -60, max: 0, step: 1, fmt: v => `${v|0}dB` }, { id: 'ratio', label: 'rat', min: 1, max: 20, step: 0.5, fmt: v => `${(+v).toFixed(1)}:1` }, { id: 'attack', label: 'atk', min: 0, max: 0.1, step: 0.001, fmt: v => `${Math.round(v*1000)}ms` }, { id: 'release', label: 'rel', min: 0.01, max: 1, step: 0.01, fmt: v => `${Math.round(v*1000)}ms` }] },
  { id: 'eq',     name: 'eq',     toggle: true,  params: [{ id: 'low', label: 'lo', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` }, { id: 'mid', label: 'mid', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` }, { id: 'high', label: 'hi', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` }] },
  { id: 'amp',    name: 'amp',    toggle: true,  ampLoader: true, params: [{ id: 'mix', label: 'mix', min: 0, max: 1, step: 0.01 }, { id: 'level', label: 'lvl', min: 0, max: 2, step: 0.01 }] },
  { id: 'cab',    name: 'cab',    toggle: true,  loader: true, params: [{ id: 'mix', label: 'mix', min: 0, max: 1, step: 0.01 }, { id: 'level', label: 'lvl', min: 0, max: 2, step: 0.01 }] },
  { id: 'delay',  name: 'delay',  toggle: true,  params: [{ id: 'time', label: 'time', min: 0.02, max: 1.2, step: 0.01, fmt: v => `${Math.round(v*1000)}ms` }, { id: 'feedback', label: 'fb', min: 0, max: 0.95, step: 0.01 }, { id: 'mix', label: 'mix', min: 0, max: 1, step: 0.01 }] },
  { id: 'reverb', name: 'reverb', toggle: true,  params: [{ id: 'decay', label: 'dec', min: 0.1, max: 6, step: 0.1, fmt: v => `${(+v).toFixed(1)}s` }, { id: 'mix', label: 'mix', min: 0, max: 1, step: 0.01 }] },
  { id: 'pan',    name: 'pan',    toggle: false, params: [{ id: 'pan', label: 'pan', min: -1, max: 1, step: 0.02, fmt: v => v == 0 ? 'C' : (v < 0 ? `L${Math.round(-v*100)}` : `R${Math.round(v*100)}`) }] },
];


const num01 = (raw, dflt) => { const v = parseFloat(raw); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt; };
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }

// Custom temperament = 12 integer cent offsets (C..B), persisted as JSON.
function loadCustomCents() {
  const out = new Array(12).fill(0);
  try {
    const raw = localStorage.getItem(CUSTOMCENTS_KEY);
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) for (let i = 0; i < 12; i++) out[i] = Math.max(-50, Math.min(50, Math.round(+a[i] || 0))); }
  } catch {}
  return out;
}

// A fresh strip config at unity defaults (all effects off).
function loadDefaultStrip() {
  const base = {};
  for (const k of Object.keys(STRIP_DEFAULTS)) base[k] = { ...STRIP_DEFAULTS[k] };
  return base;
}
// Strip config = unity defaults deep-merged with any persisted JSON.
function loadStripConfig() {
  const base = loadDefaultStrip();
  try {
    const raw = localStorage.getItem(STRIP_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      // Migrate old single-drive config to earth/metal
      if (o && o.drive && !o.earth && !o.metal) {
        const d = o.drive;
        if (d.model === 'metal') {
          Object.assign(base.metal, d, { on: d.on });
          delete base.metal.model; delete base.metal.tone;
        } else {
          Object.assign(base.earth, d, { on: d.on });
          delete base.earth.model; delete base.earth.low; delete base.earth.mid;
          delete base.earth.midFreq; delete base.earth.high;
        }
      }
      for (const k of Object.keys(base)) if (o && o[k]) Object.assign(base[k], o[k]);
    }
  } catch {}
  return base;
}

let _trackSeq = 0;
function nextTrackId() { return `t${Date.now().toString(36)}${(_trackSeq++).toString(36)}`; }
function fmtLen(v) { return v === 0.5 ? '0.5' : String(v); }

// ── DOM builders (stateless; shared by the global props row + track rows) ───
function mkLabel(text) { const sp = document.createElement('span'); sp.className = 'seq-prop-label'; sp.textContent = text; return sp; }
function mk(label, child, title) {
  const w = document.createElement('label');
  w.className = 'seq-prop';
  w.append(mkLabel(label), child);
  if (title) w.title = title;
  return w;
}
function numInput(value, min, max, step, wide) {
  const i = document.createElement('input');
  i.type = 'number'; i.step = String(step); i.min = String(min); i.max = String(max);
  i.value = String(value); i.className = 'seq-num' + (wide ? ' seq-num-wide' : '');
  return i;
}
function miniBtn(txt, fn, title) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'ctrl-btn seq-num-step';
  b.textContent = txt; if (title) b.title = title;
  b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
  return b;
}
function stepper(input, eventName, bumpFn) {
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
  wrap.append(miniBtn('−', () => bump(-1), 'Decrease'), input, miniBtn('+', () => bump(+1), 'Increase'));
  return wrap;
}
function volSlider(value, onInput, title, def) {
  const sl = document.createElement('input');
  sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.01';
  // The `value` attribute is the defaultValue used by double-click-to-reset.
  if (def != null) sl.setAttribute('value', String(def));
  sl.value = String(value); sl.className = 'panel-gain-slider';
  if (title) sl.title = title;
  sl.addEventListener('input', () => onInput(sl.value));
  return sl;
}

export function createLooper({ audio, syncStrudel } = {}) {
  const panel       = document.getElementById('looper-panel');
  const propsEl     = document.getElementById('looper-props');
  const tracksEl    = document.getElementById('looper-tracks');
  const status      = document.getElementById('looper-status');
  const inputSelect = document.getElementById('looper-input');
  const signalCtrls = document.getElementById('rig-input-controls');
  const signalStat  = document.getElementById('rig-signal-status');
  const btnChannels = document.getElementById('btn-rig-channels');
  const scopeCanvas = document.getElementById('rig-scope');
  const btnStrip    = document.getElementById('btn-rig-strip');
  const btnTuner    = document.getElementById('btn-rig-tuner');
  const stripPanel  = document.getElementById('rig-strip');
  const stripBody   = document.getElementById('rig-strip-body');
  const btnStripReset = document.getElementById('btn-rig-strip-reset');
  const rigLoopSection = document.getElementById('rig-loop');
  const looperBody  = document.getElementById('looper-body');
  const btnLoopCollapse = document.getElementById('btn-rig-loop-collapse');
  const tunerEl     = document.getElementById('rig-tuner');
  const temperEl    = document.getElementById('rig-temper');
  const btnToggle   = document.getElementById('btn-looper');
  const btnRecord   = document.getElementById('btn-looper-record');
  const btnRetro    = document.getElementById('btn-looper-retro');
  const bufferBtn   = document.getElementById('btn-rig-buffer');
  const btnPlay     = document.getElementById('btn-looper-play');
  const btnStop     = document.getElementById('btn-looper-stop');
  const btnMute     = document.getElementById('btn-looper-mute');
  const elGain      = document.getElementById('looper-gain');
  const btnSync     = document.getElementById('btn-looper-sync');
  const btnDelete   = document.getElementById('btn-looper-delete');
  const btnClose    = document.getElementById('btn-looper-close');

  const wasOpenLastSession = lsGet(PANEL_OPEN_KEY, '0') === '1';
  const defaultGrid = Math.max(1, Math.min(16, parseInt(lsGet(GRID_KEY, lsGet(`${NS}.metacycle`, '1')), 10) || 1));

  // Live model. `track` became `tracks[]` + an armed id in v2.
  const model = {
    syncStrudel: lsGet(SYNC_KEY, '1') !== '0',
    immediate: lsGet(IMMEDIATE_KEY, '0') === '1',   // "start now" vs wait for boundary
    cps: 0.5,                       // used when sync is off / Strudel idle
    offsetMs: (() => { const v = parseInt(lsGet(OFFSET_KEY, '0'), 10); return Number.isFinite(v) ? Math.max(-200, Math.min(500, v)) : 0; })(),
    master:   num01(lsGet(MASTER_KEY, '0.9'), 0.9),   // overall looper output
    retroCycles: (() => { const v = parseInt(lsGet(RETRO_KEY, '4'), 10); return Number.isFinite(v) ? Math.max(1, Math.min(64, v)) : 4; })(),
    bufferOn: lsGet(BUFFER_KEY, '0') === '1',          // live lookback running
    signalLevel: num01(lsGet(SIGLEVEL_KEY, '0'), 0),   // rig signal monitor/mix level
    signalMuted: lsGet(SIGMUTE_KEY, '0') === '1',      // rig signal mute
    channels: lsGet(CHANNELS_KEY, 'mono') === 'stereo' ? 'stereo' : 'mono',
    strip: loadStripConfig(),                          // channel strip config
    stripOpen: lsGet(STRIPOPEN_KEY, '0') === '1',
    loopCollapsed: lsGet(LOOPCOLLAPSE_KEY, '0') === '1',
    tunerOn: lsGet(TUNER_KEY, '0') === '1',
    tunerMute: lsGet(TUNERMUTE_KEY, '1') !== '0',
    temperament: lsGet(TEMPER_KEY, 'et') === 'custom' ? 'custom' : 'et',
    customCents: loadCustomCents(),
    refPitch: (() => { const v = parseFloat(lsGet(REFPITCH_KEY, '440')); return Number.isFinite(v) ? Math.max(400, Math.min(480, v)) : 440; })(),
    cabName: lsGet(CABNAME_KEY, '') || '',
    ampName: lsGet(AMPNAME_KEY, '') || '',
    gridDefault: defaultGrid,       // "cycles" each new track starts with
    deviceId: getStoredDeviceId('looperInput') || '',   // remembered input device
    tracks: [],                     // Track[] — see makeTrack()
    armedTrackId: null,             // the one track that record targets
  };
  // Header master mute (all loops). The live input is independent (audio.js).
  let _muted = false;
  let recording = false;
  let _everOpened = false;

  const looperAudio = createLooperAudio({ audio, syncStrudel });
  looperAudio.setMaster(model.master);
  looperAudio.setOffsetMs(model.offsetMs);
  looperAudio.primeSignal(model.signalLevel, model.signalMuted);   // value-only; capture opens on a gesture
  looperAudio.setChannels(model.channels);                         // value-only until capture opens
  looperAudio.setStripConfig(model.strip);                         // applied when capture opens

  // Per-track renderers + DOM handles, keyed by track id.
  const renderers = new Map();      // id -> renderer
  const rowEls = new Map();         // id -> { row, canvas, gridIn, lengthIn, half, dbl, volSl, muteBtn, armBtn, ppBtn }
  let _addWrap = null;              // the "+ track" container
  let inputVolSl = null, inputMuteBtn = null, syncStatusEl = null;
  let _orderSeq = 0;                // stable per-track order (persisted, append-only)

  // ── track model ──────────────────────────────────────────────────────────
  function makeTrack() {
    const prev = model.tracks[model.tracks.length - 1];
    return {
      id: nextTrackId(),
      order: _orderSeq++,                           // stable display/persist order
      buffer: null, sampleRate: 0, loopStartBase: 0, regionFrames: 0,
      naturalSeconds: 0, recordedCycles: null,
      grid: prev ? prev.grid : model.gridDefault,   // record-snap + lane width
      length: null,                                 // cycles the take occupies
      volume: 0.5,                                  // Ditto-centre default
      muted: false,
      preservePitch: false,                         // varispeed by default
    };
  }
  function getTrack(id) { return model.tracks.find(t => t.id === id) || null; }
  function armedTrack() { return getTrack(model.armedTrackId); }
  function hasAnyAudio() { return model.tracks.some(t => t.buffer); }

  // ── sync helpers ───────────────────────────────────────────────────────
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

  // The renderer view for one track (its loop region, grid, length, playhead).
  function viewForTrack(track) {
    if (!track || !track.buffer) return null;
    const region = looperAudio.getLoopRegion(track) || { startFrame: 0, endFrame: track.buffer.length };
    return {
      buffer: track.buffer,
      startFrame: region.startFrame,
      endFrame: region.endFrame,
      grid: track.grid,
      length: track.length || track.grid,
      playhead01: looperAudio.isVoicePlaying(track.id) ? looperAudio.getPlayhead01(track.id) : null,
    };
  }

  // ── persistence (IndexedDB) ──────────────────────────────────────────────
  // Recorded loops + per-track settings survive a reload. PCM is stored once on
  // record; setting tweaks re-write the (debounced) record. Buffers are large,
  // so write quietly and degrade gracefully on quota errors.
  const _dirty = new Set();
  let _persistTimer = null;
  function toRecord(t) {
    // Store every channel (stereo when recorded so) — array of Float32Array.
    const pcm = [];
    for (let c = 0; c < t.buffer.numberOfChannels; c++) pcm.push(new Float32Array(t.buffer.getChannelData(c)));
    return {
      id: t.id, order: t.order,
      pcm,
      sampleRate: t.sampleRate, regionFrames: t.regionFrames,
      loopStartBase: t.loopStartBase, naturalSeconds: t.naturalSeconds,
      recordedCycles: t.recordedCycles,
      grid: t.grid, length: t.length, volume: t.volume, muted: t.muted, preservePitch: t.preservePitch,
    };
  }
  function onPersistErr(e) {
    console.warn('[qualia] looper persist failed:', e);
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e?.message || '')))) {
      setStatus('storage full — loop kept in memory only');
    }
  }
  function flushPersist() {
    _persistTimer = null;
    for (const id of _dirty) {
      const t = getTrack(id);
      if (t && t.buffer) loopStore.putTrack(toRecord(t)).catch(onPersistErr);
    }
    _dirty.clear();
  }
  function persistSoon(id) {
    if (!loopStore.isAvailable()) return;
    _dirty.add(id);
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(flushPersist, 250);
  }
  // Rebuild persisted loops on load. Does NOT auto-play; arms a fresh empty
  // track so the next record doesn't clobber a restored take.
  async function restoreFromStore() {
    if (!loopStore.isAvailable()) return;
    let recs;
    try { recs = await loopStore.getAllTracks(); }
    catch (e) { console.warn('[qualia] looper restore failed:', e); return; }
    if (!recs || !recs.length) return;
    // If the user already recorded during the (brief) async load, don't clobber.
    if (model.tracks.some(t => t.buffer)) return;
    const restored = [];
    let maxOrder = -1;
    for (const r of recs) {
      const buffer = looperAudio.makeBuffer(r.pcm, r.sampleRate);
      if (!buffer) continue;
      const order = Number.isFinite(r.order) ? r.order : restored.length;
      if (order > maxOrder) maxOrder = order;
      const sr = r.sampleRate || buffer.sampleRate;
      restored.push({
        id: r.id, order,
        buffer, sampleRate: sr,
        loopStartBase: r.loopStartBase || 0,
        regionFrames: r.regionFrames || buffer.length,
        naturalSeconds: r.naturalSeconds || (buffer.length / sr),
        recordedCycles: r.recordedCycles ?? null,
        grid: Math.max(1, Math.min(16, r.grid || model.gridDefault)),
        length: r.length || r.recordedCycles || model.gridDefault,
        volume: clamp01(r.volume == null ? 0.5 : r.volume),
        muted: !!r.muted,
        preservePitch: !!r.preservePitch,
      });
    }
    if (!restored.length) return;
    _orderSeq = maxOrder + 1;
    model.tracks = restored;
    const fresh = makeTrack();
    model.tracks.push(fresh);
    model.armedTrackId = fresh.id;
    renderTracks();
    refreshTransport();
    refreshLooperBtn();
    setStatus(`restored ${restored.length} loop${restored.length === 1 ? '' : 's'}`);
  }

  // ── transport ──────────────────────────────────────────────────────────
  async function startRecording() {
    if (recording) return;
    const t = armedTrack();
    if (!t) return;
    looperAudio.stopVoice(t.id);   // record replaces the armed take
    setStatus('arming…');
    try {
      const res = await looperAudio.startRecording({ grid: t.grid, syncOn: syncOn(), cps: currentCps(), deviceId: model.deviceId });
      recording = true;
      refreshTransport();
      refreshLooperBtn();
      renderers.get(t.id)?.start();
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
    const t = armedTrack();
    setStatus('finishing…');
    const res = await looperAudio.stopRecording({ grid: t ? t.grid : model.gridDefault, syncOn: syncOn() });
    recording = false;
    refreshLooperBtn();
    if (!res || !t) {
      refreshTransport();
      if (t) renderers.get(t.id)?.stop();
      setStatus('nothing captured');
      return;
    }
    await commitTake(t, res, 'recorded');
  }

  // Apply a finished take (from record OR retro grab) to a track: store the
  // buffer + region metadata, refresh the row, persist, and play it (other
  // tracks keep looping). `verb` is the status prefix ("recorded" / "grabbed").
  async function commitTake(t, res, verb) {
    const cyc = (res.recordedCycles != null && res.recordedCycles > 0) ? res.recordedCycles : Math.max(t.grid, 1);
    t.buffer = res.buffer;
    t.sampleRate = res.sampleRate;
    t.loopStartBase = res.loopStartBase;
    t.regionFrames = res.regionFrames;
    t.naturalSeconds = res.naturalSeconds;
    t.recordedCycles = cyc;
    t.length = cyc;
    renderers.get(t.id)?.invalidate();
    refreshTrackRow(t);
    refreshAddBtn();
    refreshTransport();
    persistSoon(t.id);            // save the new take (PCM + settings) to IndexedDB
    setStatus(`${verb} · ${fmtLen(cyc)} cyc`);
    await playVoice(t);            // play the new take; other tracks keep looping
    syncRenderers();
  }

  // ⟲ retro — grab the last N cycles from the always-on live buffer into the
  // armed track, phase-locked to the grid. The buffer must be running (capture
  // open) and the AudioWorklet available (the ring lives in the processor).
  async function doRetroGrab() {
    if (recording) return;
    if (!looperAudio.isRetroCapable()) { setStatus('retro needs AudioWorklet'); return; }
    if (!looperAudio.isCapturing()) { setStatus('turn the buffer on first'); return; }
    const t = armedTrack();
    if (!t) return;
    looperAudio.stopVoice(t.id);   // retro replaces the armed take
    setStatus('grabbing…');
    let res = null;
    try {
      res = await looperAudio.grabRetro({ grid: t.grid, syncOn: syncOn(), cps: currentCps(), cycles: model.retroCycles });
    } catch (e) { console.warn('[qualia] retro grab failed:', e); }
    if (!res) { setStatus('buffer too short — play a few more bars'); refreshTransport(); return; }
    await commitTake(t, res, 'grabbed');
  }

  // ── live lookback buffer ───────────────────────────────────────────────────
  async function setBuffer(on) {
    model.bufferOn = !!on;
    lsSet(BUFFER_KEY, model.bufferOn ? '1' : '0');
    if (model.bufferOn) {
      try {
        const capable = await looperAudio.startBuffer(model.deviceId);
        setStatus(capable ? 'live buffer on' : 'retro unavailable (no AudioWorklet)');
        try { picker?.populate?.(model.deviceId); } catch {}
      } catch (e) {
        console.warn('[qualia] buffer start failed:', e);
        model.bufferOn = false; lsSet(BUFFER_KEY, '0');
        setStatus('mic error — check permissions');
      }
    } else {
      looperAudio.stopBuffer();
      setStatus('live buffer off');
    }
    refreshBufferBtn();
    refreshTransport();
  }
  function setRetroCycles(v) {
    const n = Math.max(1, Math.min(64, parseInt(v, 10) || 1));
    model.retroCycles = n;
    lsSet(RETRO_KEY, n);
  }

  // Play (or re-lock) one track's voice.
  async function playVoice(track) {
    if (!track || !track.buffer) return;
    await looperAudio.playVoice(track, { grid: track.grid, syncOn: syncOn(), cps: currentCps(), immediate: model.immediate });
    renderers.get(track.id)?.start();
    refreshTransport();
    refreshLooperBtn();
  }

  // ▶ — play every recorded track, locked to the same boundary.
  async function playAll() {
    const withAudio = model.tracks.filter(t => t.buffer);
    if (!withAudio.length) return;
    for (const t of withAudio) {
      await looperAudio.playVoice(t, { grid: t.grid, syncOn: syncOn(), cps: currentCps(), immediate: model.immediate });
    }
    syncRenderers();
    refreshTransport();
    refreshLooperBtn();
    setStatus(strudelLive() ? 'looping · locked' : 'looping');
  }

  // ■ — stop all loops (they re-lock from the boundary on next play).
  function stop() {
    looperAudio.stopAll();
    syncRenderers();
    refreshTransport();
    refreshLooperBtn();
    if (hasAnyAudio()) setStatus('stopped');
  }

  // ⟲ — realign all playing loops to the next boundary.
  function realign() { if (looperAudio.anyPlaying()) playAll(); }

  // ── per-track operations ─────────────────────────────────────────────────
  function setTrackLength(id, v) {
    const t = getTrack(id);
    if (!t || !t.buffer) return;
    const next = Math.max(0.5, Math.min(64, v));
    if (next === t.length) return;
    t.length = next;
    renderers.get(id)?.invalidate();
    refreshTrackRow(t);
    if (looperAudio.isVoicePlaying(id)) playVoice(t);
    persistSoon(id);
  }
  function setTrackVolume(id, v) {
    const t = getTrack(id);
    if (!t) return;
    t.volume = clamp01(v);
    looperAudio.setTrackVolume(id, t.volume);
    persistSoon(id);
  }
  function setTrackMuted(id, on) {
    const t = getTrack(id);
    if (!t) return;
    t.muted = !!on;
    looperAudio.setTrackMuted(id, t.muted);
    refreshTrackRow(t);
    persistSoon(id);
  }
  function setTrackGrid(id, v) {
    const t = getTrack(id);
    if (!t) return;
    const g = Math.max(1, Math.min(16, parseInt(v, 10) || 1));
    if (g === t.grid) return;
    t.grid = g;
    model.gridDefault = g; lsSet(GRID_KEY, g);   // next new track inherits it
    renderers.get(id)?.invalidate();
    if (looperAudio.isVoicePlaying(id)) playVoice(t);
    persistSoon(id);
  }
  // Toggle pitch-preserving time-stretch for a track. Re-locks the voice so the
  // varispeed ⇄ stretch swap takes effect seamlessly (others keep playing).
  function setTrackPreserve(id, on) {
    const t = getTrack(id);
    if (!t) return;
    t.preservePitch = !!on;
    refreshTrackRow(t);
    if (looperAudio.isVoicePlaying(id)) playVoice(t);
    persistSoon(id);
  }
  function deleteTrack(id) {
    looperAudio.removeTrack(id);
    renderers.get(id)?.dispose();
    renderers.delete(id);
    _dirty.delete(id);
    if (loopStore.isAvailable()) loopStore.deleteTrack(id).catch(() => {});
    model.tracks = model.tracks.filter(t => t.id !== id);
    if (model.armedTrackId === id) model.armedTrackId = null;
    if (!model.tracks.length) {
      const t = makeTrack(); model.tracks.push(t); model.armedTrackId = t.id;
    } else if (!getTrack(model.armedTrackId)) {
      model.armedTrackId = model.tracks[model.tracks.length - 1].id;
    }
    renderTracks();
    refreshTransport();
    refreshLooperBtn();
    setStatus('deleted');
  }
  function clearAll() {
    looperAudio.removeAll();
    for (const r of renderers.values()) r.dispose();
    renderers.clear();
    _dirty.clear();
    if (loopStore.isAvailable()) loopStore.clearAll().catch(() => {});
    model.tracks = [];
    const t = makeTrack(); model.tracks.push(t); model.armedTrackId = t.id;
    renderTracks();
    refreshTransport();
    refreshLooperBtn();
    setStatus('cleared');
  }
  function addTrack() {
    const t = makeTrack();
    model.tracks.push(t);
    model.armedTrackId = t.id;
    renderTracks();
    refreshTransport();
    setStatus('track added — armed');
  }
  function armTrack(id) {
    if (!getTrack(id) || recording) return;
    model.armedTrackId = id;
    refreshArmIndicators();
  }
  // Trim one lane (grid cycles) off the front or back of a take — for dropping
  // a late start or a trailing bar. Removes the matching slice of buffer frames
  // and the same number of cycles from `length`, so tempo/pitch are unchanged
  // (rate = naturalSeconds/(length/cps) stays constant). Needs length > grid so
  // at least one lane remains.
  function trimTrack(id, which) {
    const t = getTrack(id);
    if (!t || !t.buffer || !t.length || t.length <= t.grid) return;
    const oldRegion = t.regionFrames;
    const fpl = Math.round(oldRegion * (t.grid / t.length));   // frames in one lane
    if (fpl <= 0 || fpl >= oldRegion) return;
    if (which === 'first') t.loopStartBase += fpl;
    t.regionFrames = oldRegion - fpl;
    t.length = t.length - t.grid;
    t.naturalSeconds = t.regionFrames / (t.sampleRate || 48000);
    if (t.recordedCycles) t.recordedCycles = t.recordedCycles * (t.regionFrames / oldRegion);
    applyCanvasHeight(t);
    renderers.get(id)?.invalidate();
    refreshTrackRow(t);
    if (looperAudio.isVoicePlaying(id)) playVoice(t);
    persistSoon(id);
    setStatus(which === 'first' ? 'trimmed first lane' : 'trimmed last lane');
  }

  // ── per-track waveform height ──────────────────────────────────────────────
  // Lanes are compact and the canvas grows with lane count (capped) so a take
  // takes only the space it needs and more tracks fit on screen.
  const LANE_PX = 24, CANVAS_MIN = 40, CANVAS_MAX = 140;
  function laneCount(t) {
    if (!t.buffer || !t.length) return 1;
    return Math.max(1, Math.ceil(t.length / t.grid - 1e-6));
  }
  function applyCanvasHeight(t) {
    const el = rowEls.get(t.id);
    if (!el?.canvas) return;
    const h = Math.max(CANVAS_MIN, Math.min(CANVAS_MAX, laneCount(t) * LANE_PX));
    el.canvas.style.height = h + 'px';
    renderers.get(t.id)?.resize();
  }

  // ── right-click context menu (trim / delete) on a track's waveform ─────────
  let _ctxMenu = null;
  function hideCtxMenu() {
    if (!_ctxMenu) return;
    _ctxMenu.remove(); _ctxMenu = null;
    document.removeEventListener('pointerdown', onCtxAway, true);
    document.removeEventListener('keydown', onCtxKey, true);
    window.removeEventListener('blur', hideCtxMenu);
  }
  function onCtxAway(e) { if (_ctxMenu && !_ctxMenu.contains(e.target)) hideCtxMenu(); }
  function onCtxKey(e) { if (e.key === 'Escape') hideCtxMenu(); }
  function showTrackMenu(track, x, y) {
    hideCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'looper-ctx-menu';
    const canTrim = !!track.buffer && track.length > track.grid;
    const item = (label, fn, disabled) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.disabled = !!disabled;
      b.addEventListener('click', () => { hideCtxMenu(); fn(); });
      return b;
    };
    const hr = document.createElement('hr');
    menu.append(
      item(`Trim first lane (−${track.grid} cyc)`, () => trimTrack(track.id, 'first'), !canTrim),
      item(`Trim last lane (−${track.grid} cyc)`, () => trimTrack(track.id, 'last'), !canTrim),
      hr,
      item('Delete track', () => deleteTrack(track.id)),
    );
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
    menu.style.top  = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
    _ctxMenu = menu;
    document.addEventListener('pointerdown', onCtxAway, true);
    document.addEventListener('keydown', onCtxKey, true);
    window.addEventListener('blur', hideCtxMenu);
  }

  // ── master / input / nudge / cps ─────────────────────────────────────────
  function setMuted(on) { _muted = !!on; looperAudio.setMuted(_muted); refreshMuteBtn(); }
  function setMaster(v) {
    model.master = clamp01(v);
    looperAudio.setMaster(model.master);
    lsSet(MASTER_KEY, model.master);
  }
  // The rig signal is the rig's OWN input source (looperAudio), independent of
  // the audio-panel mic: volume + mute land on the monitor + the mix ('rig'
  // source). Raising the level opens the rig capture (a user gesture).
  function setInputVol(v) {
    model.signalLevel = clamp01(v);
    lsSet(SIGLEVEL_KEY, model.signalLevel);
    looperAudio.setSignalLevel(model.signalLevel, model.deviceId).then(refreshLooperBtn).catch(() => {});
  }
  function setInputMuted(on) {
    model.signalMuted = !!on;
    lsSet(SIGMUTE_KEY, model.signalMuted ? '1' : '0');
    looperAudio.setSignalMuted(model.signalMuted);
    refreshInputMuteBtn();
  }
  function refreshChannelsBtn() {
    if (!btnChannels) return;
    btnChannels.textContent = model.channels;
    btnChannels.classList.toggle('active', model.channels === 'stereo');
  }
  function setChannels(mode) {
    model.channels = mode === 'stereo' ? 'stereo' : 'mono';
    lsSet(CHANNELS_KEY, model.channels);
    looperAudio.setChannels(model.channels);   // reopens capture if live
    refreshChannelsBtn();
  }
  // Nudge (ms): slides every loop window live to compensate record latency.
  function setOffsetMs(v) {
    model.offsetMs = Math.max(-200, Math.min(500, Math.round(Number(v) || 0)));
    looperAudio.setOffsetMs(model.offsetMs);
    lsSet(OFFSET_KEY, model.offsetMs);
    for (const t of model.tracks) renderers.get(t.id)?.invalidate();
    if (looperAudio.anyPlaying()) playAll();   // re-lock with the new window
  }
  function setCps(v) {
    const c = parseFloat(v);
    if (!Number.isFinite(c)) return;
    model.cps = Math.max(0.1, Math.min(4, c));
    if (looperAudio.anyPlaying() && !strudelLive()) playAll();
  }

  // ── qualem snapshot/restore ───────────────────────────────────────────────
  // The looper's device-independent, shareable settings: master out, sync,
  // "start now", nudge, default grid, and free-run cps. Deliberately excludes
  // the recorded loops (PCM is large + session-local — it lives in IndexedDB
  // across reloads and never belongs in a URL/QR-sized qualem) and the input
  // deviceId (machine-specific; restored via its own picker). Mirrors the
  // vocoder/harmonizer getConfig/setConfig the qualem system already consumes.
  function getConfig() {
    return {
      master:      model.master,
      sync:        !!model.syncStrudel,
      immediate:   !!model.immediate,
      offsetMs:    model.offsetMs,
      gridDefault: model.gridDefault,
      retroCycles: model.retroCycles,
      cps:         model.cps,
      strip:       JSON.parse(JSON.stringify(model.strip)),
      temperament: model.temperament,
      customCents: model.customCents.slice(),
      refPitch:    model.refPitch,
      channels:    model.channels,
    };
  }
  function setConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (typeof cfg.master === 'number') {
      setMaster(cfg.master);
      if (elGain) elGain.value = String(model.master);   // sync header slider
    }
    if (typeof cfg.offsetMs === 'number') setOffsetMs(cfg.offsetMs);
    if (typeof cfg.cps === 'number')      setCps(cfg.cps);
    if (typeof cfg.sync === 'boolean') {
      model.syncStrudel = cfg.sync;
      lsSet(SYNC_KEY, model.syncStrudel ? '1' : '0');
    }
    if (typeof cfg.immediate === 'boolean') {
      model.immediate = cfg.immediate;
      lsSet(IMMEDIATE_KEY, model.immediate ? '1' : '0');
    }
    if (typeof cfg.gridDefault === 'number') {
      model.gridDefault = Math.max(1, Math.min(16, cfg.gridDefault | 0));
      lsSet(GRID_KEY, model.gridDefault);
    }
    if (typeof cfg.retroCycles === 'number') setRetroCycles(cfg.retroCycles);
    if (cfg.strip && typeof cfg.strip === 'object') {
      for (const k of Object.keys(model.strip)) if (cfg.strip[k]) Object.assign(model.strip[k], cfg.strip[k]);
      looperAudio.setStripConfig(model.strip);
      lsSet(STRIP_KEY, JSON.stringify(model.strip));
      rebuildStrip();
    }
    if (cfg.temperament === 'et' || cfg.temperament === 'custom') setTemperament(cfg.temperament);
    if (Array.isArray(cfg.customCents)) {
      for (let i = 0; i < 12; i++) model.customCents[i] = Math.max(-50, Math.min(50, Math.round(+cfg.customCents[i] || 0)));
      persistCustomCents();
      syncTemperCells();
    }
    if (typeof cfg.refPitch === 'number') setRefPitch(cfg.refPitch);
    if (cfg.channels === 'mono' || cfg.channels === 'stereo') setChannels(cfg.channels);
    // Repaint the props row so the panel mirrors the applied settings
    // (master slider, nudge, sync/start-now checkboxes) whether or not it's
    // currently open; renderProps re-reads model on the next open anyway.
    if (propsEl) renderProps();
    refreshSyncStatus();
    refreshSyncBtnVisibility();
  }

  // ── track rows UI ─────────────────────────────────────────────────────
  function renderTracks() {
    if (!tracksEl) return;
    for (const r of renderers.values()) r.dispose();
    renderers.clear();
    rowEls.clear();
    tracksEl.innerHTML = '';
    model.tracks.forEach((t, i) => tracksEl.append(buildRow(t, i)));
    model.tracks.forEach((t) => refreshTrackRow(t));

    const addWrap = document.createElement('div');
    addWrap.className = 'looper-add';
    const addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'ctrl-btn'; addBtn.id = 'btn-looper-add';
    addBtn.textContent = '+ track';
    addBtn.title = 'Add a loop track (armed for recording)';
    addBtn.addEventListener('click', addTrack);
    addWrap.append(addBtn);
    tracksEl.append(addWrap);
    _addWrap = addWrap;

    refreshAddBtn();
    refreshArmIndicators();
    syncRenderers();
  }

  function buildRow(track, index) {
    const row = document.createElement('div');
    row.className = 'looper-track';
    row.dataset.id = track.id;

    const head = document.createElement('div');
    head.className = 'looper-track-head';

    // row 1 — arm · name · mute · delete
    const r1 = document.createElement('div');
    r1.className = 'looper-track-row';
    const armBtn = document.createElement('button');
    armBtn.type = 'button'; armBtn.className = 'ctrl-btn looper-arm';
    armBtn.addEventListener('click', () => armTrack(track.id));
    const nameSp = document.createElement('span');
    nameSp.className = 'looper-track-name';
    nameSp.textContent = String(index + 1);
    const muteBtn = document.createElement('button');
    muteBtn.type = 'button'; muteBtn.className = 'ctrl-btn seq-mini-mute looper-track-mute';
    muteBtn.addEventListener('click', () => setTrackMuted(track.id, !track.muted));
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'ctrl-btn looper-track-del';
    delBtn.textContent = '🗑'; delBtn.title = 'Delete this track';
    delBtn.addEventListener('click', () => deleteTrack(track.id));
    r1.append(armBtn, nameSp, muteBtn, delBtn);

    // row 2 — cycles (grid) · length + stretch
    const r2 = document.createElement('div');
    r2.className = 'looper-track-row';
    const gridIn = numInput(track.grid, 1, 16, 1);
    gridIn.addEventListener('change', () => { setTrackGrid(track.id, gridIn.value); gridIn.value = String(track.grid); });
    const lengthIn = numInput(track.buffer ? fmtLen(track.length) : '—', 0.5, 64, 1, true);
    lengthIn.disabled = !track.buffer;
    lengthIn.addEventListener('change', () => {
      let v = parseFloat(lengthIn.value);
      if (!Number.isFinite(v)) { lengthIn.value = track.buffer ? fmtLen(track.length) : '—'; return; }
      v = v < 0.75 ? 0.5 : Math.round(v);
      setTrackLength(track.id, v);
    });
    const lengthStep = stepper(lengthIn, 'change', (delta) => {
      if (!track.buffer) return;
      const cur = track.length;
      setTrackLength(track.id, delta > 0 ? (cur < 1 ? 1 : cur + 1) : (cur > 1 ? cur - 1 : 0.5));
    });
    const half = miniBtn('÷2', () => { if (track.buffer) setTrackLength(track.id, track.length / 2); }, 'Halve length (varispeed)');
    const dbl  = miniBtn('×2', () => { if (track.buffer) setTrackLength(track.id, track.length * 2); }, 'Double length (varispeed)');
    const stretchGrp = document.createElement('span'); stretchGrp.className = 'seq-num-wrap'; stretchGrp.append(half, dbl);
    r2.append(mk('cycles', stepper(gridIn, 'change'), 'Strudel cycles per bar — record-snap grid + waveform lane width for this track.'),
              mk('length', lengthStep, 'How many cycles the loop occupies (a multiple of cycles).'),
              mk('stretch', stretchGrp, 'Halve / double the length. Varispeed — pitch shifts with speed.'));

    // row 3 — volume · preserve-pitch
    const r3 = document.createElement('div');
    r3.className = 'looper-track-row';
    const volSl = volSlider(track.volume, (v) => setTrackVolume(track.id, v), 'Track playback volume (double-click to reset)', 0.5);
    const ppBtn = document.createElement('button');
    ppBtn.type = 'button'; ppBtn.className = 'ctrl-btn looper-pp';
    ppBtn.addEventListener('click', () => setTrackPreserve(track.id, !track.preservePitch));
    r3.append(mk('vol', volSl), mk('pitch', ppBtn, 'Stretch mode: "vari" = varispeed (pitch follows speed); "keep" = pitch-preserving time-stretch (Signalsmith).'));

    head.append(r1, r2, r3);

    const canvas = document.createElement('canvas');
    canvas.className = 'looper-track-canvas';
    canvas.title = 'Right-click (two-finger tap) for trim / delete';
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); showTrackMenu(track, e.clientX, e.clientY); });

    row.append(head, canvas);

    const renderer = createLooperRenderer({
      canvas,
      getView: () => viewForTrack(track),
      getRecordView: () => (recording && model.armedTrackId === track.id) ? looperAudio.getLiveView() : { recording: false },
    });
    renderers.set(track.id, renderer);
    rowEls.set(track.id, { row, canvas, gridIn, lengthIn, half, dbl, volSl, muteBtn, armBtn, ppBtn });

    return row;
  }

  // ── global props row (cps · nudge · input · sync) ─────────────────────────
  function renderProps() {
    if (!propsEl) return;
    propsEl.innerHTML = '';

    const cpsIn = numInput(model.cps, 0.1, 4, 0.05, true);
    cpsIn.addEventListener('input', () => setCps(cpsIn.value));

    const nudgeIn = numInput(model.offsetMs, -200, 500, 5);
    nudgeIn.addEventListener('change', () => { setOffsetMs(nudgeIn.value); nudgeIn.value = String(model.offsetMs); });

    const retroIn = numInput(model.retroCycles, 1, 64, 1);
    retroIn.addEventListener('change', () => { setRetroCycles(retroIn.value); retroIn.value = String(model.retroCycles); });

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
    syncWrap.title = 'Lock record IN/OUT and loop playback to the Strudel cycle grid. Off = free capture, set cps + length manually.';
    const syncLabel = document.createElement('span'); syncLabel.className = 'seq-prop-label'; syncLabel.textContent = 'sync strudel';
    syncStatusEl = document.createElement('span'); syncStatusEl.className = 'seq-sync-status';
    syncWrap.append(syncCb, syncLabel, syncStatusEl);

    // "start now" — drop in immediately at the current Strudel phase instead of
    // waiting for the next cycle block to come round to the loop head.
    const immCb = document.createElement('input');
    immCb.type = 'checkbox'; immCb.checked = !!model.immediate;
    immCb.addEventListener('change', () => {
      model.immediate = !!immCb.checked;
      lsSet(IMMEDIATE_KEY, model.immediate ? '1' : '0');
    });
    const immWrap = document.createElement('label');
    immWrap.className = 'seq-prop seq-prop-check';
    immWrap.title = 'Play starts immediately at the current position within the Strudel cycle, rather than waiting for the next block of cycles to start at the loop head.';
    const immLabel = document.createElement('span'); immLabel.className = 'seq-prop-label'; immLabel.textContent = 'start now';
    immWrap.append(immCb, immLabel);

    propsEl.append(
      mk('cps', stepper(cpsIn, 'input'), 'Cycles per second when sync is off (Strudel\'s clock drives it when synced).'),
      mk('nudge ms', stepper(nudgeIn, 'change'), 'Slide all loops into the pocket. + pulls a late take earlier to compensate record latency.'),
      mk('retro cyc', stepper(retroIn, 'change'), 'How many cycles the “grab” button captures from the live buffer (snapped to the armed track\'s grid).'),
      syncWrap,
      immWrap,
    );
    refreshSyncStatus();
  }

  // ── signal subpanel (rig signal level + mute + scope) ─────────────────────
  // The rig signal is the rig's own input source (looperAudio): its fader
  // (gated by mute) lands on the speakers AND the mix ('rig' source — visuals +
  // recording), POST-fader, so muting pulls it from the mix. The scope reads the
  // capture PRE-fader, so the raw input stays visible even when muted. Built
  // once; the scope self-drives a rAF while the panel is open.
  function renderSignal() {
    if (!signalCtrls || signalCtrls.children.length) return;
    inputVolSl = volSlider(model.signalLevel, setInputVol,
      'Rig signal level — your guitar through the speakers AND into the mix (visuals + recording) at this level, like a channel strip. Muting/lowering it pulls the signal from the mix; the scope still shows the raw input. Raising it can feed back on speakers (fine on headphones / an interface). Double-click to reset.',
      INPUT_DEFAULT);
    inputMuteBtn = miniBtn('mute', () => setInputMuted(!model.signalMuted));
    inputMuteBtn.classList.add('seq-mini-mute');
    signalCtrls.append(inputVolSl, inputMuteBtn);
    refreshInputMuteBtn();
  }

  // ── live input scope (oscilloscope) ───────────────────────────────────────
  // Draws the captured input's time-domain waveform when the mic source is
  // live, else a faint idle trace so the panel still looks alive. Allocation-
  // free: one reused Uint8Array sized to the analyser's fftSize.
  let scope2d = null, scopeBuf = null, scopeRAF = 0, scopeStatN = 0;
  function sizeScope() {
    if (!scopeCanvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = scopeCanvas.clientWidth || 360, h = scopeCanvas.clientHeight || 76;
    scopeCanvas.width  = Math.max(1, Math.round(w * dpr));
    scopeCanvas.height = Math.max(1, Math.round(h * dpr));
  }
  function setSignalStatus(peak, clip) {
    if (!signalStat) return;
    if (peak == null) { signalStat.textContent = 'input off'; signalStat.style.color = ''; return; }
    if (clip) { signalStat.textContent = 'clip'; signalStat.style.color = 'var(--pink)'; return; }
    const db = peak > 0.0003 ? Math.round(20 * Math.log10(peak)) : -99;
    signalStat.textContent = db <= -99 ? '−∞ dB' : `${db} dB`;
    signalStat.style.color = '';
  }
  function drawScope() {
    const cv = scopeCanvas, g = scope2d;
    if (!cv || !g) return;
    const W = cv.width, H = cv.height, mid = H / 2;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();

    // The rig's own capture analyser (pre-fader) — shows the raw rig input
    // whenever capture is open (signal up, buffer on, or recording), even when
    // the signal is muted out of the mix. Idle trace otherwise.
    const an = looperAudio.getCaptureAnalyser?.();
    if (an) {
      const n = an.fftSize;
      if (!scopeBuf || scopeBuf.length !== n) scopeBuf = new Uint8Array(n);
      an.getByteTimeDomainData(scopeBuf);
      let peak = 0;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const v = (scopeBuf[i] - 128) / 128;
        const a = v < 0 ? -v : v; if (a > peak) peak = a;
        const x = (i / (n - 1)) * W;
        const y = mid - v * mid * 0.92;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      const clip = peak > 0.985;
      g.lineWidth = Math.max(1, Math.round(window.devicePixelRatio || 1));
      g.strokeStyle = clip ? 'rgba(244,114,182,0.95)' : 'rgba(34,211,238,0.9)';
      g.stroke();
      if (scopeStatN++ % 6 === 0) setSignalStatus(peak, clip);
    } else {
      const t = performance.now() / 1000;
      g.beginPath();
      for (let i = 0; i <= 96; i++) {
        const x = (i / 96) * W;
        const y = mid - Math.sin(i * 0.18 + t * 1.1) * mid * 0.12;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = 'rgba(148,163,184,0.26)';
      g.stroke();
      if (scopeStatN++ % 6 === 0) setSignalStatus(null, false);
    }
  }
  function startScope() {
    if (scopeRAF || !scopeCanvas) return;
    if (!scope2d) scope2d = scopeCanvas.getContext('2d');
    sizeScope();
    const loop = () => {
      scopeRAF = requestAnimationFrame(loop);
      drawScope();
      if (model.tunerOn) {
        const now = performance.now();
        if (now - _tunerLastMs >= TUNER_INTERVAL_MS) { _tunerLastMs = now; updateTuner(); }
      }
    };
    scopeRAF = requestAnimationFrame(loop);
  }
  function stopScope() {
    if (scopeRAF) cancelAnimationFrame(scopeRAF);
    scopeRAF = 0;
  }
  if (scopeCanvas && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { if (scopeRAF) sizeScope(); }).observe(scopeCanvas);
  }

  // ── channel strip UI ──────────────────────────────────────────────────────
  let _stripTimer = null;
  function persistStrip() {
    if (_stripTimer) clearTimeout(_stripTimer);
    _stripTimer = setTimeout(() => { _stripTimer = null; lsSet(STRIP_KEY, JSON.stringify(model.strip)); }, 200);
  }
  function stripSet(stage, param, v) {
    model.strip[stage][param] = v;
    looperAudio.setStripParam(stage, param, v);
    persistStrip();
  }
  function stripToggle(stage, on) {
    model.strip[stage].on = !!on;
    looperAudio.setStripEnabled(stage, !!on);
    refreshStripStages();
    persistStrip();
  }
  function refreshStripStages() {
    if (!stripBody) return;
    for (const stage of STRIP_SCHEMA) {
      if (!stage.toggle) continue;
      const box = stripBody.querySelector(`.rig-stage[data-stage="${stage.id}"]`);
      if (!box) continue;
      const on = !!model.strip[stage.id].on;
      box.classList.toggle('on', on);
      const tg = box.querySelector('.rig-stage-toggle');
      if (tg) { tg.textContent = on ? 'on' : 'off'; tg.classList.toggle('active', on); }
    }
  }
  function buildStripUI() {
    if (!stripBody || stripBody.children.length) return;
    for (const stage of STRIP_SCHEMA) {
      const box = document.createElement('div');
      box.className = 'rig-stage'; box.dataset.stage = stage.id;
      const head = document.createElement('div'); head.className = 'rig-stage-head';
      const nameEl = document.createElement('span'); nameEl.className = 'rig-stage-name'; nameEl.textContent = stage.name;

      // Collapse toggle
      const collapsed = !!model.strip[stage.id]?.collapsed;
      if (collapsed) box.classList.add('collapsed');
      const chev = document.createElement('button');
      chev.type = 'button'; chev.className = 'ctrl-btn rig-stage-chev';
      chev.textContent = collapsed ? '▸' : '▾';
      chev.title = 'Collapse / expand';
      chev.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = box.classList.toggle('collapsed');
        chev.textContent = c ? '▸' : '▾';
        if (!model.strip[stage.id]) model.strip[stage.id] = {};
        model.strip[stage.id].collapsed = c;
        persistStrip();
      });

      if (stage.toggle) {
        const tg = document.createElement('button');
        tg.type = 'button'; tg.className = 'ctrl-btn rig-stage-toggle';
        tg.title = `Enable / bypass ${stage.name}`;
        tg.addEventListener('click', () => stripToggle(stage.id, !model.strip[stage.id].on));
        head.append(chev, tg, nameEl);
      } else {
        box.classList.add('on');   // non-toggle stages (pan) are always active
        head.append(chev, nameEl);
      }

      // Click anywhere on head to toggle collapse (except the on/off button)
      head.addEventListener('click', (e) => {
        if (e.target.closest('.rig-stage-toggle')) return;
        const c = box.classList.toggle('collapsed');
        chev.textContent = c ? '▸' : '▾';
        if (!model.strip[stage.id]) model.strip[stage.id] = {};
        model.strip[stage.id].collapsed = c;
        persistStrip();
      });

      box.append(head);
      if (stage.params) {
        for (const p of stage.params) box.append(buildCtl(stage.id, p));
      }
      if (stage.loader) box.append(buildCabLoader());
      if (stage.ampLoader) box.append(buildAmpLoader());
      stripBody.append(box);
    }
    refreshStripStages();
  }
  // One labelled slider bound to model.strip[stageId][p.id].
  function buildCtl(stageId, p) {
    const row = document.createElement('div'); row.className = 'rig-ctl';
    const lab = document.createElement('span'); lab.className = 'rig-ctl-label'; lab.textContent = p.label;
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = String(p.min); sl.max = String(p.max); sl.step = String(p.step);
    sl.value = String(model.strip[stageId][p.id]);
    const val = document.createElement('span'); val.className = 'rig-ctl-val';
    const fmt = p.fmt || (v => (+v).toFixed(2));
    val.textContent = fmt(parseFloat(sl.value));
    sl.addEventListener('input', () => { const v = parseFloat(sl.value); val.textContent = fmt(v); stripSet(stageId, p.id, v); });
    row.append(lab, sl, val);
    return row;
  }
  // Cab IR loader row — file picker + filename + clear.
  let cabNameEl = null;
  function buildCabLoader() {
    const row = document.createElement('div'); row.className = 'rig-ctl rig-cab-load';
    const file = document.createElement('input');
    file.type = 'file'; file.accept = 'audio/*,.wav'; file.style.display = 'none';
    file.addEventListener('change', () => { const f = file.files && file.files[0]; if (f) loadCabFile(f); file.value = ''; });
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ctrl-btn'; btn.textContent = 'load IR';
    btn.title = 'Load a cabinet / reverb impulse response (WAV)';
    btn.addEventListener('click', () => file.click());
    cabNameEl = document.createElement('span'); cabNameEl.className = 'rig-cab-name';
    cabNameEl.textContent = model.cabName || 'no IR';
    const clr = document.createElement('button');
    clr.type = 'button'; clr.className = 'ctrl-btn'; clr.textContent = '×'; clr.title = 'Clear IR';
    clr.addEventListener('click', clearCabIR);
    row.append(file, btn, cabNameEl, clr);
    return row;
  }
  async function loadCabFile(file) {
    try {
      const bytes = await file.arrayBuffer();
      const ok = await looperAudio.setCabIRBytes(bytes);
      if (!ok) { setStatus('IR decode failed'); return; }
      model.cabName = file.name; lsSet(CABNAME_KEY, model.cabName);
      if (cabNameEl) cabNameEl.textContent = model.cabName;
      if (loopStore.isAvailable()) loopStore.putMisc({ id: CAB_IR_ID, name: file.name, bytes }).catch(() => {});
      setStatus(`cab IR: ${file.name}`);
    } catch (e) { console.warn('[qualia] cab IR load failed:', e); setStatus('IR load failed'); }
  }
  function clearCabIR() {
    looperAudio.clearCabIR();
    model.cabName = ''; lsSet(CABNAME_KEY, '');
    if (cabNameEl) cabNameEl.textContent = 'no IR';
    if (loopStore.isAvailable()) loopStore.deleteMisc(CAB_IR_ID).catch(() => {});
  }
  // Neural amp model loader row — file picker + name + clear.
  let ampNameEl = null;
  function buildAmpLoader() {
    const row = document.createElement('div'); row.className = 'rig-ctl rig-cab-load';
    const file = document.createElement('input');
    file.type = 'file'; file.accept = '.json,.nam,.aidax,application/json'; file.style.display = 'none';
    file.addEventListener('change', () => { const f = file.files && file.files[0]; if (f) loadAmpFile(f); file.value = ''; });
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ctrl-btn'; btn.textContent = 'load amp';
    btn.title = 'Load a neural amp capture (GuitarML / AIDA-X / NAM-LSTM JSON)';
    btn.addEventListener('click', () => file.click());
    if (!looperAudio.isAmpCapable?.()) { btn.disabled = true; btn.title = 'Neural amp needs AudioWorklet support'; }
    ampNameEl = document.createElement('span'); ampNameEl.className = 'rig-cab-name';
    ampNameEl.textContent = model.ampName || 'no amp';
    const clr = document.createElement('button');
    clr.type = 'button'; clr.className = 'ctrl-btn'; clr.textContent = '×'; clr.title = 'Clear amp model';
    clr.addEventListener('click', clearAmpModel);
    row.append(file, btn, ampNameEl, clr);
    return row;
  }
  async function loadAmpFile(file) {
    try {
      const text = await file.text();
      let json; try { json = JSON.parse(text); } catch { setStatus('amp: not valid JSON'); return; }
      const parsed = parseAmpModel(json);
      if (!parsed.ok) { setStatus(`amp: ${parsed.reason}`); return; }
      looperAudio.setAmpModel(parsed);
      model.ampName = file.name; lsSet(AMPNAME_KEY, model.ampName);
      if (ampNameEl) ampNameEl.textContent = model.ampName;
      if (loopStore.isAvailable()) loopStore.putMisc({ id: AMP_MODEL_ID, name: file.name, model: parsed }).catch(() => {});
      setStatus(`amp: ${file.name}${parsed.experimental ? ' (experimental)' : ''} · ${parsed.hidden}-cell`);
    } catch (e) { console.warn('[qualia] amp load failed:', e); setStatus('amp load failed'); }
  }
  function clearAmpModel() {
    looperAudio.clearAmp();
    model.ampName = ''; lsSet(AMPNAME_KEY, '');
    if (ampNameEl) ampNameEl.textContent = 'no amp';
    if (loopStore.isAvailable()) loopStore.deleteMisc(AMP_MODEL_ID).catch(() => {});
  }
  async function restoreAmp() {
    if (!loopStore.isAvailable()) return;
    try {
      const rec = await loopStore.getMisc(AMP_MODEL_ID);
      if (rec && rec.model) { looperAudio.setAmpModel(rec.model); model.ampName = rec.name || model.ampName; if (ampNameEl) ampNameEl.textContent = model.ampName || 'amp'; }
    } catch (e) { console.warn('[qualia] amp restore failed:', e); }
  }

  // Restore a persisted cab IR (async; applies to the strip whenever capture opens).
  async function restoreCabIR() {
    if (!loopStore.isAvailable()) return;
    try {
      const rec = await loopStore.getMisc(CAB_IR_ID);
      if (rec && rec.bytes) { await looperAudio.setCabIRBytes(rec.bytes); model.cabName = rec.name || model.cabName; if (cabNameEl) cabNameEl.textContent = model.cabName || 'IR'; }
    } catch (e) { console.warn('[qualia] cab IR restore failed:', e); }
  }
  function resetStrip() {
    model.strip = loadDefaultStrip();
    looperAudio.setStripConfig(model.strip);
    lsSet(STRIP_KEY, JSON.stringify(model.strip));
    rebuildStrip();
    setStatus('strip reset');
  }
  function rebuildStrip() { if (stripBody) { stripBody.innerHTML = ''; cabNameEl = null; ampNameEl = null; buildStripUI(); } }
  function refreshStripBtn() { if (btnStrip) btnStrip.classList.toggle('active', !!model.stripOpen); }
  function toggleStrip(on) {
    model.stripOpen = on == null ? !model.stripOpen : !!on;
    lsSet(STRIPOPEN_KEY, model.stripOpen ? '1' : '0');
    if (model.stripOpen) buildStripUI();
    if (stripPanel) stripPanel.style.display = model.stripOpen ? '' : 'none';
    refreshStripBtn();
  }

  // ── collapsible looper ─────────────────────────────────────────────────────
  // Hide the props + tracks (keeping the transport bar) and shrink the window to
  // fit, so the rig can run as a live amp/fx rig without the looper taking room.
  let _loopExpandedH = null;
  function applyLoopCollapse() {
    const c = !!model.loopCollapsed;
    if (looperBody) looperBody.style.display = c ? 'none' : '';
    if (propsEl) propsEl.style.display = c ? 'none' : '';
    if (rigLoopSection) rigLoopSection.style.flex = c ? '0 0 auto' : '';
    if (btnLoopCollapse) { btnLoopCollapse.textContent = c ? '▸' : '▾'; btnLoopCollapse.classList.toggle('collapsed', c); }
    if (panel) {
      if (c) {
        const h = panel.getBoundingClientRect().height;
        if (h > 0) _loopExpandedH = h;
        panel.style.height = 'auto';
        panel.style.minHeight = '0';
      } else if (panel.style.height === 'auto') {
        // Only restore when coming back from a collapsed state — leave a
        // user-resized height untouched otherwise.
        panel.style.height = _loopExpandedH ? `${_loopExpandedH}px` : '';
        panel.style.minHeight = '';
      }
    }
  }
  function toggleLoopCollapse() {
    model.loopCollapsed = !model.loopCollapsed;
    lsSet(LOOPCOLLAPSE_KEY, model.loopCollapsed ? '1' : '0');
    applyLoopCollapse();
  }

  // ── chromatic tuner ───────────────────────────────────────────────────────
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const TUNER_MIN_HZ = 22;     // reach below G0 (~24.5 Hz)
  const TUNER_INTERVAL_MS = 180;  // slower update = steadier reading
  let tunerNoteEl = null, tunerHzEl = null, tunerTgtEl = null, tunerNeedleEl = null, tunerCentsEl = null;
  let tunerBuf = null, tunerDec = null, _tunerLastMs = 0;
  let _tunerNoteKey = '', _tunerErrSmooth = 0;
  function buildTunerUI() {
    if (!tunerEl || tunerEl.children.length) return;
    tunerNoteEl = document.createElement('span'); tunerNoteEl.className = 'rig-tuner-note'; tunerNoteEl.textContent = '—';
    tunerHzEl   = document.createElement('span'); tunerHzEl.className   = 'rig-tuner-hz';
    tunerTgtEl  = document.createElement('span'); tunerTgtEl.className  = 'rig-tuner-tgt';
    const bar = document.createElement('span'); bar.className = 'rig-tuner-bar';
    tunerNeedleEl = document.createElement('span'); tunerNeedleEl.className = 'rig-tuner-needle'; tunerNeedleEl.style.left = '50%';
    bar.append(tunerNeedleEl);
    tunerCentsEl = document.createElement('span'); tunerCentsEl.className = 'rig-tuner-cents'; tunerCentsEl.textContent = 'play a note';
    _tunerMuteBtn = document.createElement('button');
    _tunerMuteBtn.type = 'button'; _tunerMuteBtn.className = 'ctrl-btn rig-tuner-mute';
    _tunerMuteBtn.addEventListener('click', () => {
      model.tunerMute = !model.tunerMute;
      lsSet(TUNERMUTE_KEY, model.tunerMute ? '1' : '0');
      applyTunerMute();
    });
    refreshTunerMuteBtn();
    tunerEl.append(tunerNoteEl, tunerHzEl, tunerTgtEl, bar, tunerCentsEl, _tunerMuteBtn);
  }
  // Target cents offset for a note class under the active temperament.
  function temperOffset(noteClass) { return model.temperament === 'custom' ? (model.customCents[noteClass] | 0) : 0; }
  // Bounded autocorrelation pitch detector (parabolic-interpolated). Returns Hz
  // or -1 when the signal is too quiet / not periodic.
  function autoCorrelate(buf, sr) {
    const SIZE = buf.length;
    let energy = 0;
    for (let i = 0; i < SIZE; i++) energy += buf[i] * buf[i];
    if (Math.sqrt(energy / SIZE) < 0.01) return -1;
    const minLag = Math.max(2, Math.floor(sr / 1200));
    const maxLag = Math.min(SIZE - 1, Math.floor(sr / TUNER_MIN_HZ));
    const corr = new Float32Array(maxLag + 2);
    let best = -1, bestVal = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i < SIZE - lag; i++) c += buf[i] * buf[i + lag];
      corr[lag] = c;
      if (c > bestVal) { bestVal = c; best = lag; }
    }
    if (best <= 0 || bestVal < energy * 0.01) return -1;
    const x1 = corr[best - 1] || 0, x2 = corr[best], x3 = corr[best + 1] || 0;
    const denom = x1 + x3 - 2 * x2;
    let shift = denom ? 0.5 * (x1 - x3) / denom : 0;
    if (!isFinite(shift) || Math.abs(shift) > 1) shift = 0;
    return sr / (best + shift);
  }
  function updateTuner() {
    if (!model.tunerOn || !tunerNoteEl) return;
    const an = looperAudio.getTunerAnalyser?.() || looperAudio.getCaptureAnalyser?.();
    const clear = () => {
      tunerNoteEl.textContent = '—'; tunerNoteEl.style.color = '';
      if (tunerHzEl) tunerHzEl.textContent = ''; if (tunerTgtEl) tunerTgtEl.textContent = '';
      tunerCentsEl.textContent = an ? 'play a note' : 'rig signal off'; tunerNeedleEl.style.left = '50%';
      _tunerNoteKey = '';
    };
    if (!an || typeof an.getFloatTimeDomainData !== 'function') { clear(); return; }
    const n = an.fftSize;
    if (!tunerBuf || tunerBuf.length !== n) tunerBuf = new Float32Array(n);
    an.getFloatTimeDomainData(tunerBuf);
    // Decimate ×2 (average pairs) — cheaper autocorrelation and a gentle
    // low-pass that steadies low-note detection.
    const m = n >> 1;
    if (!tunerDec || tunerDec.length !== m) tunerDec = new Float32Array(m);
    for (let i = 0; i < m; i++) tunerDec[i] = (tunerBuf[2 * i] + tunerBuf[2 * i + 1]) * 0.5;
    const sr = (an.context?.sampleRate || 48000) / 2;
    const f = autoCorrelate(tunerDec, sr);
    if (f <= 0) { clear(); return; }
    const midi = 69 + 12 * Math.log2(f / model.refPitch);
    const rounded = Math.round(midi);
    const cls = ((rounded % 12) + 12) % 12;
    const octave = Math.floor(rounded / 12) - 1;
    const rawCents = (midi - rounded) * 100;                // deviation from ET
    const target = temperOffset(cls);                      // sweetened target offset
    let err = rawCents - target;                           // deviation from the target
    // Smooth within a held note (snap on note change) to calm the needle.
    const key = `${cls}.${octave}`;
    err = key === _tunerNoteKey ? _tunerErrSmooth * 0.5 + err * 0.5 : err;
    _tunerNoteKey = key; _tunerErrSmooth = err;
    const shown = Math.round(err);
    tunerNoteEl.textContent = `${NOTE_NAMES[cls]}${octave}`;
    if (tunerHzEl) tunerHzEl.textContent = `${f.toFixed(1)} Hz`;
    if (tunerTgtEl) tunerTgtEl.textContent = `tgt ${target > 0 ? '+' : ''}${target}¢`;
    const inTune = Math.abs(err) <= 3;
    tunerNoteEl.style.color = inTune ? 'var(--cyan)' : '';
    tunerCentsEl.textContent = `${shown > 0 ? '+' : ''}${shown}¢`;
    tunerNeedleEl.style.left = Math.max(0, Math.min(100, 50 + err)) + '%';
    tunerNeedleEl.style.background = inTune ? 'var(--cyan)' : (Math.abs(err) <= 12 ? '#fbbf24' : 'var(--pink)');
  }

  // ── temperament editor (ET / custom + per-note cent spinners) ──────────────
  let temperToggleBtn = null, temperGridEl = null;
  const temperCells = new Array(12).fill(null);
  function persistCustomCents() { lsSet(CUSTOMCENTS_KEY, JSON.stringify(model.customCents)); }
  function setTemperament(t) {
    model.temperament = t === 'custom' ? 'custom' : 'et';
    lsSet(TEMPER_KEY, model.temperament);
    refreshTemperUI();
  }
  function setCustomCent(i, v) {
    model.customCents[i] = Math.max(-50, Math.min(50, (v | 0)));
    persistCustomCents();
  }
  function setRefPitch(v) {
    const f = parseFloat(v);
    if (!Number.isFinite(f)) return;
    model.refPitch = Math.round(Math.max(400, Math.min(480, f)) * 10) / 10;
    lsSet(REFPITCH_KEY, model.refPitch);
  }
  function refreshTemperUI() {
    if (temperToggleBtn) {
      temperToggleBtn.textContent = model.temperament === 'custom' ? 'custom' : 'ET';
      temperToggleBtn.classList.toggle('active', model.temperament === 'custom');
      temperToggleBtn.title = model.temperament === 'custom'
        ? 'Custom temperament — click for Equal Temperament'
        : 'Equal Temperament — click for your custom temperament';
    }
    if (temperGridEl) temperGridEl.style.display = model.temperament === 'custom' ? '' : 'none';
  }
  function buildTemperamentUI() {
    if (!temperEl || temperEl.children.length) return;
    const head = document.createElement('div'); head.className = 'rig-temper-head';
    const lab = document.createElement('span'); lab.className = 'seq-prop-label'; lab.textContent = 'temperament';
    temperToggleBtn = document.createElement('button');
    temperToggleBtn.type = 'button'; temperToggleBtn.className = 'ctrl-btn';
    temperToggleBtn.addEventListener('click', () => setTemperament(model.temperament === 'custom' ? 'et' : 'custom'));
    // Reference pitch (A, Hz) — one-decimal spinner.
    const refIn = numInput(model.refPitch.toFixed(1), 400, 480, 0.1);
    refIn.addEventListener('change', () => { setRefPitch(parseFloat(refIn.value)); refIn.value = model.refPitch.toFixed(1); });
    head.append(lab, temperToggleBtn, mk('ref Hz', stepper(refIn, 'change'), 'Reference pitch for A (Hz) — equal-temperament anchor for the tuner.'));

    temperGridEl = document.createElement('div'); temperGridEl.className = 'rig-temper-grid';
    for (let i = 0; i < 12; i++) {
      const cell = document.createElement('div'); cell.className = 'rig-temper-cell';
      const nl = document.createElement('span'); nl.className = 'rig-temper-note'; nl.textContent = NOTE_NAMES[i];
      const inp = numInput(model.customCents[i], -50, 50, 1);
      inp.title = `${NOTE_NAMES[i]} cents offset`;
      inp.addEventListener('change', () => { setCustomCent(i, parseInt(inp.value, 10) || 0); inp.value = String(model.customCents[i]); });
      temperCells[i] = inp;
      cell.append(nl, stepper(inp, 'change'));
      temperGridEl.append(cell);
    }
    temperEl.append(head, temperGridEl);
    refreshTemperUI();
  }
  function syncTemperCells() {
    for (let i = 0; i < 12; i++) if (temperCells[i]) temperCells[i].value = String(model.customCents[i]);
  }
  function refreshTunerBtn() { if (btnTuner) btnTuner.classList.toggle('active', !!model.tunerOn); }
  // Mute/unmute rig signal output while the tuner is active so the raw
  // instrument doesn't bleed into the mix or visualizers during tuning.
  // The mute piggybacks on the existing signalMuted path — it remembers
  // whether the user had it manually muted beforehand so we don't
  // accidentally unmute on tuner-close.
  let _preTunerMuted = false;
  function applyTunerMute() {
    if (model.tunerOn && model.tunerMute) {
      _preTunerMuted = model.signalMuted;
      if (!model.signalMuted) { looperAudio.setSignalMuted(true); }
    } else {
      if (!_preTunerMuted) { looperAudio.setSignalMuted(model.signalMuted); }
      _preTunerMuted = false;
    }
    refreshInputMuteBtn();
    refreshTunerMuteBtn();
  }
  let _tunerMuteBtn = null;
  function refreshTunerMuteBtn() {
    if (_tunerMuteBtn) {
      _tunerMuteBtn.classList.toggle('active', !!model.tunerMute);
      _tunerMuteBtn.textContent = model.tunerMute ? 'mute' : 'thru';
      _tunerMuteBtn.title = model.tunerMute ? 'Rig output muted while tuning (click for pass-through)' : 'Rig output audible while tuning (click to mute)';
    }
  }
  function toggleTuner(on) {
    model.tunerOn = on == null ? !model.tunerOn : !!on;
    lsSet(TUNER_KEY, model.tunerOn ? '1' : '0');
    if (tunerEl) tunerEl.style.display = model.tunerOn ? '' : 'none';
    if (temperEl) temperEl.style.display = model.tunerOn ? '' : 'none';
    if (model.tunerOn) {
      buildTunerUI();
      buildTemperamentUI();
      looperAudio.ensureCaptureOpen(model.deviceId).then(refreshLooperBtn).catch(() => {});
    }
    applyTunerMute();
    refreshTunerBtn();
  }

  // ── refreshers ───────────────────────────────────────────────────────────
  function refreshTrackRow(track) {
    const el = rowEls.get(track.id);
    if (!el) return;
    const hasBuf = !!track.buffer;
    el.lengthIn.disabled = !hasBuf;
    el.lengthIn.value = hasBuf ? fmtLen(track.length) : '—';
    el.half.disabled = !hasBuf || track.length <= 0.5;
    el.dbl.disabled  = !hasBuf || track.length >= 64;
    el.muteBtn.classList.toggle('muted', !!track.muted);
    el.muteBtn.textContent = track.muted ? 'muted' : 'mute';
    el.muteBtn.title = track.muted ? 'Unmute this track' : 'Mute this track (keeps looping in time)';
    el.gridIn.value = String(track.grid);
    if (el.volSl) el.volSl.value = String(track.volume);
    if (el.ppBtn) {
      el.ppBtn.classList.toggle('active', !!track.preservePitch);
      el.ppBtn.textContent = track.preservePitch ? 'keep' : 'vari';
    }
    applyCanvasHeight(track);
  }
  function refreshArmIndicators() {
    for (const [id, el] of rowEls) {
      const armed = id === model.armedTrackId;
      el.row.classList.toggle('armed', armed);
      el.armBtn.classList.toggle('armed', armed);
      el.armBtn.textContent = armed ? '●' : '○';
      el.armBtn.title = armed ? 'Armed for recording' : 'Arm this track for recording';
    }
  }
  function refreshAddBtn() {
    if (_addWrap) _addWrap.style.display = hasAnyAudio() ? '' : 'none';
  }
  function syncRenderers() {
    for (const t of model.tracks) {
      const r = renderers.get(t.id);
      if (!r) continue;
      const active = (recording && model.armedTrackId === t.id) || looperAudio.isVoicePlaying(t.id);
      if (active) r.start(); else r.stop();
    }
  }
  function refreshSyncStatus() {
    if (!syncStatusEl) return;
    if (!model.syncStrudel) { syncStatusEl.textContent = ''; syncStatusEl.dataset.state = 'off'; return; }
    const ready = !!syncStrudel?.isReady?.();
    syncStatusEl.textContent = ready ? '· connected' : '· waiting for strudel';
    syncStatusEl.dataset.state = ready ? 'connected' : 'waiting';
  }
  function refreshInputMuteBtn() {
    if (!inputMuteBtn) return;
    const tunerMuting = model.tunerOn && model.tunerMute && !model.signalMuted;
    const muted = !!model.signalMuted || tunerMuting;
    inputMuteBtn.classList.toggle('muted', muted);
    inputMuteBtn.textContent = tunerMuting ? 'tuner' : (model.signalMuted ? 'muted' : 'mute');
    inputMuteBtn.title = tunerMuting ? 'Muted by tuner (auto)' : (model.signalMuted ? 'Unmute rig signal' : 'Mute rig signal (out of monitor + mix)');
  }

  // ── button paint ─────────────────────────────────────────────────────────
  function refreshTransport() {
    const any = hasAnyAudio();
    const playing = looperAudio.anyPlaying();
    if (btnRecord) {
      btnRecord.classList.toggle('recording', recording);
      btnRecord.textContent = recording ? '■' : '●';
      btnRecord.title = recording ? 'Stop recording' : 'Record into the armed track';
    }
    if (btnPlay) { btnPlay.classList.toggle('playing', playing); btnPlay.disabled = !any || recording; }
    if (btnStop) btnStop.disabled = !playing;
    if (btnDelete) btnDelete.disabled = !any || recording;
    if (btnRetro) btnRetro.disabled = recording || !(looperAudio.isRetroCapable() && looperAudio.isCapturing());
    refreshSyncBtnVisibility();
  }
  function refreshBufferBtn() {
    if (!bufferBtn) return;
    const on = looperAudio.isBuffering();
    bufferBtn.classList.toggle('active', on);
    bufferBtn.textContent = on ? 'buffer ●' : 'buffer';
    bufferBtn.title = on
      ? 'Live buffer on — last 40s captured; use “grab” to retro-loop. Click to stop.'
      : 'Live buffer — continuously capture the last 40s so you can retroactively grab a loop of what you just played (pre-fader; works with monitor at 0).';
  }
  function refreshMuteBtn() {
    if (!btnMute) return;
    btnMute.classList.toggle('muted', _muted);
    btnMute.textContent = _muted ? 'mute' : 'live';
    btnMute.title = _muted ? 'Unmute loop output' : 'Mute all loop output (keeps looping in time)';
  }
  function refreshSyncBtnVisibility() {
    if (!btnSync) return;
    btnSync.style.display = (model.syncStrudel && hasAnyAudio()) ? '' : 'none';
  }
  function refreshLooperBtn() {
    if (!btnToggle) return;
    btnToggle.classList.remove('active', 'active-audio');
    // Rig is "live" when anything it owns is audible — a loop voice OR the rig
    // signal source (the processed live input feeding the mix).
    const live = audio?.hasSource?.('looper') || audio?.hasSource?.('rig');
    const open = panel?.style.display !== 'none';
    if (live) { btnToggle.classList.add('active-audio'); btnToggle.textContent = 'rig ●'; }
    else if (open) { btnToggle.classList.add('active'); btnToggle.textContent = 'rig on'; }
    else btnToggle.textContent = 'rig';
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
      // The rig input is its own device, independent of the audio-panel mic.
      try { await looperAudio.setInputDevice(model.deviceId); } catch (e) { console.warn('[qualia] rig device switch failed:', e); }
      return model.deviceId;
    },
  });

  // ── drag (mirror sequencer) ──────────────────────────────────────────────
  let movedByUser = restorePanelPos('looper', panel);
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
      savePanelPos('looper', panel);
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
      _rDebounce = setTimeout(() => savePanelPos('looper', panel), 300);
    }).observe(panel);
  }

  // ── open / close ─────────────────────────────────────────────────────────
  function open() {
    if (panel) panel.style.display = '';
    _everOpened = true;
    lsSet(PANEL_OPEN_KEY, '1');
    reposition();
    renderSignal();
    if (!rowEls.size) renderTracks();
    if (!propsEl?.children.length) renderProps();
    for (const r of renderers.values()) r.resize();
    try { picker?.populate?.(model.deviceId); } catch {}
    if (inputVolSl) inputVolSl.value = String(model.signalLevel);
    refreshInputMuteBtn();
    // open() is a user gesture, so a getUserMedia prompt is allowed here.
    // Resume the rig signal monitor if it was left up, and the lookback buffer
    // if it was left on — so a remembered rig comes back without a manual nudge.
    if (model.signalLevel > 0 && !looperAudio.getSignal().live) {
      looperAudio.ensureCaptureOpen(model.deviceId).then(refreshLooperBtn).catch(() => {});
    }
    if (model.bufferOn && !looperAudio.isBuffering()) setBuffer(true);
    refreshBufferBtn();
    refreshChannelsBtn();
    // Restore the strip / tuner subpanels if they were left open.
    if (model.stripOpen) { buildStripUI(); if (stripPanel) stripPanel.style.display = ''; }
    if (model.tunerOn) {
      buildTunerUI();
      buildTemperamentUI();
      if (tunerEl) tunerEl.style.display = '';
      if (temperEl) temperEl.style.display = '';
      if (!looperAudio.getSignal().live) looperAudio.ensureCaptureOpen(model.deviceId).then(refreshLooperBtn).catch(() => {});
    }
    refreshStripBtn();
    refreshTunerBtn();
    applyLoopCollapse();
    startScope();
    refreshLooperBtn();
    refreshTransport();
  }
  function close() {
    if (panel) panel.style.display = 'none';
    lsSet(PANEL_OPEN_KEY, '0');
    stopScope();
    refreshLooperBtn();
  }

  // ── wire buttons ─────────────────────────────────────────────────────────
  if (btnToggle) btnToggle.addEventListener('click', () => {
    if (!panel) return;
    if (panel.style.display === 'none') open(); else close();
  });
  if (btnClose)  btnClose.addEventListener('click', close);
  if (btnRecord) btnRecord.addEventListener('click', () => { recording ? stopRecording() : startRecording(); });
  if (btnRetro)  btnRetro.addEventListener('click', () => { doRetroGrab(); });
  if (bufferBtn) bufferBtn.addEventListener('click', () => { setBuffer(!model.bufferOn); });
  if (btnChannels) btnChannels.addEventListener('click', () => { setChannels(model.channels === 'stereo' ? 'mono' : 'stereo'); });
  if (btnStrip)  btnStrip.addEventListener('click', () => { toggleStrip(); });
  if (btnStripReset) btnStripReset.addEventListener('click', () => { resetStrip(); });
  if (btnLoopCollapse) btnLoopCollapse.addEventListener('click', () => { toggleLoopCollapse(); });
  if (btnTuner)  btnTuner.addEventListener('click', () => { toggleTuner(); });
  if (btnPlay)   btnPlay.addEventListener('click', () => { playAll(); });
  if (btnStop)   btnStop.addEventListener('click', () => { stop(); });
  if (btnMute)   btnMute.addEventListener('click', () => { setMuted(!_muted); });
  if (btnSync)   btnSync.addEventListener('click', () => { realign(); });
  if (btnDelete) btnDelete.addEventListener('click', () => { clearAll(); });
  if (elGain) {
    elGain.value = String(model.master);
    elGain.addEventListener('input', () => setMaster(elGain.value));
  }

  // Repaint topbar/state when audio.js flips the looper / rig source on/off.
  audio?.onChange?.(() => refreshLooperBtn());
  syncStrudel?.onReadyChange?.(() => refreshSyncStatus());

  // Seed with one empty armed track (Phase 5 restores persisted tracks here).
  model.tracks.push(makeTrack());
  model.armedTrackId = model.tracks[0].id;

  // Initial paint even while hidden so first open() shows content immediately.
  renderSignal();           // build the rig signal controls up front
  if (propsEl) renderProps();
  if (tracksEl) renderTracks();
  refreshMuteBtn();
  refreshBufferBtn();
  refreshChannelsBtn();
  refreshStripBtn();
  refreshTunerBtn();
  refreshTransport();
  refreshLooperBtn();
  refreshSyncBtnVisibility();

  if (wasOpenLastSession) open();

  // Restore persisted loops (async). Replaces the seeded empty track if any
  // saved loops are found; otherwise the seeded empty armed track stays.
  restoreFromStore();
  // Restore a persisted cab IR + neural amp model (async; applied to the strip
  // on next capture open).
  restoreCabIR();
  restoreAmp();

  // perFrame is a no-op: each renderer self-drives its own rAF while
  // recording/playing. Exposed for symmetry with the sequencer's page-init hook.
  function perFrame() {}

  return {
    open, close,
    isOpen: () => panel?.style.display !== 'none',
    hasBeenOpened: () => _everOpened,
    isPlaying: () => looperAudio.anyPlaying(),
    isRecording: () => recording,
    play: playAll, stop,
    perFrame,
    getConfig, setConfig,
    dispose: () => { hideCtxMenu(); stopScope(); looperAudio.dispose(); for (const r of renderers.values()) r.dispose(); renderers.clear(); },

    // ── Hotkey / MIDI helpers ──────────────────────────────────────────────
    toggleStripStage(stageId) {
      if (!model.strip[stageId]) return;
      const on = !model.strip[stageId].on;
      stripToggle(stageId, on);
    },
    setStripParam(stageId, paramId, value) {
      if (!model.strip[stageId]) return;
      stripSet(stageId, paramId, value);
    },
    nudgeStripParam(stageId, paramId, delta) {
      if (!model.strip[stageId]) return;
      const cur = model.strip[stageId][paramId] ?? 0;
      stripSet(stageId, paramId, Math.max(0, Math.min(1, cur + delta)));
    },
    setSignalLevel(level) {
      const v = Math.max(0, Math.min(1, level));
      model.signalLevel = v;
      lsSet(SIGLEVEL_KEY, String(v));
      looperAudio.setSignalLevel(v, model.deviceId).then(refreshLooperBtn).catch(() => {});
      if (inputVolSl) inputVolSl.value = String(v);
    },
    nudgeSignalLevel(delta) {
      const next = Math.max(0, Math.min(1, model.signalLevel + delta));
      model.signalLevel = next;
      lsSet(SIGLEVEL_KEY, String(next));
      looperAudio.setSignalLevel(next, model.deviceId).then(refreshLooperBtn).catch(() => {});
      if (inputVolSl) inputVolSl.value = String(next);
    },
  };
}
