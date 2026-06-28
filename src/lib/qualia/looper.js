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
import { getRaw as lsGet, setRaw as lsSet, clamp01 } from './prefs.js';

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
const SCOPESOPEN_KEY = `${NS}.scopesOpen`; // in/out scopes visible (collapsible)
const SCOPEGAIN_KEY  = `${NS}.scopeGain`;  // scope DISPLAY gain (visual only, not audio)
const RIG_MUTE_KEY   = `${NS}.rigMuted`;  // rig master mute (signal + loops)
const RIG_LEVEL_KEY  = `${NS}.rigLevel`;  // rig master output level
const RIG_LIMITER_KEY = `${NS}.rigLimiter`; // rig master brickwall limiter (signal + loops)
const CHANNELS_KEY   = `${NS}.channels`;   // input: 'mono' | 'stereo'
const STRIP_KEY      = `${NS}.strip`;      // channel strip config (JSON)
const MINI_KEY       = `${NS}.mini`;       // rig panel mini (pedalboard) mode
const STRIPOPEN_KEY  = `${NS}.stripOpen`;  // strip subpanel expanded
const STRIPUTIL_KEY  = `${NS}.stripUtilOpen`; // utility drawer (hpf/comp/eq/pan) expanded
const LOOPOPEN_KEY     = `${NS}.loopOpen`;      // loop section visible
const LOOPCOLLAPSE_KEY = `${NS}.loopCollapsed`; // looper tracks collapsed
const TUNER_KEY      = `${NS}.tuner`;      // tuner enabled
const TUNERMUTE_KEY  = `${NS}.tunerMute`; // mute rig signal while tuner is on
const TEMPER_KEY     = `${NS}.temperament`;// 'et' | 'custom'
const CUSTOMCENTS_KEY = `${NS}.customCents`;// custom temperament: int cents[12]
const REFPITCH_KEY   = `${NS}.refPitch`;   // tuner reference A (Hz)
const CABNAME_KEY    = `${NS}.cabName`;     // loaded cab IR filename (display)
const CAB_IR_ID      = 'cabIR';            // legacy single-IR misc key (migrated → library)
const CABLIB_KEY     = `${NS}.cabLib`;      // saved cab IR library index: [{ id, name }]
const CABCUR_KEY     = `${NS}.cabCur`;      // misc id of the currently-loaded cab IR
const AMPNAME_KEY    = `${NS}.ampName`;     // loaded neural amp model name (display)
const AMP_MODEL_ID   = 'ampModel';         // legacy single-model misc key (migrated → library)
const AMPLIB_KEY     = `${NS}.ampLib`;      // saved amp model library index: [{ id, name }]
const AMPCUR_KEY     = `${NS}.ampCur`;      // misc id of the currently-loaded amp model
const LIB_MAX        = 24;                  // cap on saved files per library
const INPUT_DEFAULT  = 0.7;                // double-click-reset target for the input fader

// Channel strip UI schema — stages + params (the audio side lives in
// rig-strip.js; STRIP_DEFAULTS supplies initial values). `group` controls only
// the UI placement (the audio graph order is fixed in rig-strip.js): 'main'
// stages live in the always-visible row a performer reaches for live (earth,
// metal, amp, cab, delay, reverb); 'util' stages (hpf, comp, eq, pan) tuck into
// a collapsible "utility" drawer so they're out of the way until needed.
const STRIP_SCHEMA = [
  { id: 'hpf',    name: 'hpf',    group: 'util', toggle: true,  params: [{ id: 'freq', label: 'freq', min: 20, max: 400, step: 1, fmt: v => `${v|0}Hz` }] },
  { id: 'earth',  name: 'earth',  group: 'main', toggle: true,  params: [
    { id: 'drive', label: 'gain', min: 0, max: 1, step: 0.01 },
    { id: 'tone', label: 'tone', min: 0, max: 1, step: 0.01 },
    { id: 'level', label: 'lvl', min: 0, max: 1, step: 0.01 },
  ] },
  { id: 'metal',  name: 'metal',  group: 'main', toggle: true,  params: [
    { id: 'drive', label: 'gain', min: 0, max: 1, step: 0.01 },
    { id: 'low', label: 'low', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` },
    { id: 'mid', label: 'mid', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` },
    { id: 'midFreq', label: 'mFq', min: 200, max: 5000, step: 10, fmt: v => `${v|0}Hz` },
    { id: 'high', label: 'high', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` },
    { id: 'level', label: 'lvl', min: 0, max: 1, step: 0.01 },
  ] },
  { id: 'comp',   name: 'comp',   group: 'util', toggle: true,  params: [{ id: 'threshold', label: 'thr', min: -60, max: 0, step: 1, fmt: v => `${v|0}dB` }, { id: 'ratio', label: 'rat', min: 1, max: 20, step: 0.5, fmt: v => `${(+v).toFixed(1)}:1` }, { id: 'attack', label: 'atk', min: 0, max: 0.1, step: 0.001, fmt: v => `${Math.round(v*1000)}ms` }, { id: 'release', label: 'rel', min: 0.01, max: 1, step: 0.01, fmt: v => `${Math.round(v*1000)}ms` }] },
  { id: 'eq',     name: 'eq',     group: 'util', toggle: true,  params: [{ id: 'low', label: 'lo', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` }, { id: 'mid', label: 'mid', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` }, { id: 'high', label: 'hi', min: -15, max: 15, step: 0.5, fmt: v => `${(+v).toFixed(1)}` }] },
  { id: 'amp',    name: 'amp',    group: 'main', toggle: true,  ampLoader: true, params: [{ id: 'gain', label: 'gain', min: 0, max: 4, step: 0.01 }, { id: 'mix', label: 'mix', min: 0, max: 1, step: 0.01 }, { id: 'level', label: 'lvl', min: 0, max: 2, step: 0.01 }] },
  { id: 'cab',    name: 'cab',    group: 'main', toggle: true,  loader: true, params: [{ id: 'mix', label: 'mix', min: 0, max: 1, step: 0.01 }, { id: 'level', label: 'lvl', min: 0, max: 2, step: 0.01 }] },
  { id: 'delay',  name: 'delay',  group: 'main', toggle: true,  params: [{ id: 'time', label: 'time', min: 0.02, max: 1.2, step: 0.01, fmt: v => `${Math.round(v*1000)}ms` }, { id: 'feedback', label: 'fb', min: 0, max: 0.95, step: 0.01 }, { id: 'mix', label: 'mix', min: 0, max: 1, step: 0.01 }] },
  { id: 'reverb', name: 'reverb', group: 'main', toggle: true,  params: [{ id: 'decay', label: 'dec', min: 0.1, max: 6, step: 0.1, fmt: v => `${(+v).toFixed(1)}s` }, { id: 'mix', label: 'mix', min: 0, max: 1, step: 0.01 }] },
  { id: 'pan',    name: 'pan',    group: 'util', toggle: false, params: [{ id: 'pan', label: 'pan', min: -1, max: 1, step: 0.02, fmt: v => v == 0 ? 'C' : (v < 0 ? `L${Math.round(-v*100)}` : `R${Math.round(v*100)}`) }] },
];


const num01 = (raw, dflt) => { const v = parseFloat(raw); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt; };
// clamp01, lsGet (getRaw), lsSet (setRaw) now come from ./prefs.js — see imports.

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
  const scopeOutCanvas = document.getElementById('rig-scope-out');
  const scopesWrap  = document.getElementById('rig-scopes');
  const btnScopeCollapse = document.getElementById('btn-rig-scope-collapse');
  const btnStrip    = document.getElementById('btn-rig-strip');
  const btnTuner    = document.getElementById('btn-rig-tuner');
  const stripPanel  = document.getElementById('rig-strip');
  const stripBody   = document.getElementById('rig-strip-body');
  const stripUtilBody = document.getElementById('rig-strip-util-body');
  const btnStripUtil  = document.getElementById('btn-rig-strip-util');
  const btnStripReset = document.getElementById('btn-rig-strip-reset');
  const rigLoopSection = document.getElementById('rig-loop');
  const looperBody  = document.getElementById('looper-body');
  const btnLoop         = document.getElementById('btn-rig-loop');
  const btnLoopCollapse = document.getElementById('btn-rig-loop-collapse');
  const tunerEl     = document.getElementById('rig-tuner');
  const temperEl    = document.getElementById('rig-temper');
  const btnRigMute  = document.getElementById('btn-rig-master-mute');
  const rigMasterGain = document.getElementById('rig-master-gain');
  const rigSignalEl = document.getElementById('rig-signal');
  const miniEl      = document.getElementById('rig-mini');
  const btnMini     = document.getElementById('btn-rig-mini');
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
    rigMuted: lsGet(RIG_MUTE_KEY, '0') === '1',         // rig master mute
    rigLevel: num01(lsGet(RIG_LEVEL_KEY, '1'), 1.0),   // rig master output level
    rigLimiter: lsGet(RIG_LIMITER_KEY, '1') !== '0',   // rig master brickwall limiter (on by default)
    signalLevel: num01(lsGet(SIGLEVEL_KEY, '0'), 0),   // rig signal monitor/mix level
    signalMuted: lsGet(SIGMUTE_KEY, '0') === '1',      // rig signal mute
    scopesOpen: lsGet(SCOPESOPEN_KEY, '0') === '1',    // in/out scopes visible (default collapsed to save room)
    scopeGain: (() => { const v = parseFloat(lsGet(SCOPEGAIN_KEY, '1.8')); return Number.isFinite(v) ? Math.max(0.5, Math.min(6, v)) : 1.8; })(),  // visual-only display gain (scopes are short now)
    channels: lsGet(CHANNELS_KEY, 'mono') === 'stereo' ? 'stereo' : 'mono',
    strip: loadStripConfig(),                          // channel strip config
    mini: lsGet(MINI_KEY, '0') === '1',                // pedalboard (mini) mode
    stripOpen: lsGet(STRIPOPEN_KEY, '0') === '1',
    stripUtilOpen: lsGet(STRIPUTIL_KEY, '0') === '1',  // utility drawer (default tucked away)
    loopOpen: lsGet(LOOPOPEN_KEY, '1') !== '0',              // loop section visible
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
  looperAudio.primeRig(model.rigLevel, model.rigMuted);             // rig master output level + mute
  looperAudio.primeRigLimiter(model.rigLimiter);                    // rig master brickwall limiter
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
      contentFrames: 0,                             // region minus trailing silence (for "tile")
      grid: prev ? prev.grid : model.gridDefault,   // record-snap + lane width
      length: null,                                 // cycles the take occupies
      fitMode: prev ? prev.fitMode : 'once',        // once | tile | fit (how the take fills the bar)
      volume: 0.5,                                  // Ditto-centre default
      muted: false,
      preservePitch: false,                         // varispeed by default (only used in "fit")
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
      sampleRate: t.sampleRate, regionFrames: t.regionFrames, contentFrames: t.contentFrames,
      loopStartBase: t.loopStartBase, naturalSeconds: t.naturalSeconds,
      recordedCycles: t.recordedCycles,
      grid: t.grid, length: t.length, fitMode: t.fitMode, volume: t.volume, muted: t.muted, preservePitch: t.preservePitch,
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
  async function restoreFromStore({ force = false } = {}) {
    if (!loopStore.isAvailable()) return;
    let recs;
    try { recs = await loopStore.getAllTracks(); }
    catch (e) { console.warn('[qualia] looper restore failed:', e); return; }
    if (!recs || !recs.length) return;
    // If the user already recorded during the (brief) async load, don't clobber
    // — unless we're explicitly reloading after a bundle import.
    if (!force && model.tracks.some(t => t.buffer)) return;
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
        contentFrames: r.contentFrames || r.regionFrames || buffer.length,
        naturalSeconds: r.naturalSeconds || (buffer.length / sr),
        recordedCycles: r.recordedCycles ?? null,
        grid: Math.max(1, Math.min(16, r.grid || model.gridDefault)),
        length: r.length || r.recordedCycles || model.gridDefault,
        // Migrate pre-fitMode loops: a take deliberately stretched (length ≠ its
        // recorded cycles) keeps stretching ("fit"); everything else defaults to
        // the new natural-rate "once".
        fitMode: r.fitMode || ((r.recordedCycles && r.length && r.length !== r.recordedCycles) ? 'fit' : 'once'),
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
    t.contentFrames = res.contentFrames || res.regionFrames;
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
    // Grab off the armed take's grid (or the default if nothing's armed yet).
    const armed = armedTrack();
    const grid = armed ? armed.grid : model.gridDefault;
    setStatus('grabbing…');
    let res = null;
    try {
      res = await looperAudio.grabRetro({ grid, syncOn: syncOn(), cps: currentCps(), cycles: model.retroCycles });
    } catch (e) { console.warn('[qualia] retro grab failed:', e); }
    if (!res) { setStatus('buffer too short — play a few more bars'); refreshTransport(); return; }
    // Grab is additive: land it in a FRESH track so it layers instead of
    // overwriting. Reuse the armed track only when it's still blank, so we don't
    // strand an empty lane (and only after a successful grab, so a failed grab
    // never spawns a stray track).
    let t;
    if (armed && !armed.buffer) {
      t = armed;
      looperAudio.stopVoice(t.id);
    } else {
      t = makeTrack(); t.grid = grid;
      model.tracks.push(t);
      model.armedTrackId = t.id;
      renderTracks();
    }
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
  const FIT_MODES = ['once', 'tile', 'fit'];
  function setTrackFitMode(id, mode) {
    const t = getTrack(id);
    if (!t || !FIT_MODES.includes(mode)) return;
    t.fitMode = mode;
    renderers.get(id)?.invalidate();
    refreshTrackRow(t);
    if (looperAudio.isVoicePlaying(id)) playVoice(t);
    persistSoon(id);
  }
  function cycleTrackFitMode(id) {
    const t = getTrack(id);
    if (!t) return;
    const i = FIT_MODES.indexOf(t.fitMode || 'once');
    setTrackFitMode(id, FIT_MODES[(i + 1) % FIT_MODES.length]);
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

  // ── rig master / loop master / input / nudge / cps ───────────────────────
  // Mix-change listeners — fire whenever the rig master or loop master change
  // so the mixer panel's rig channel stays in sync with this panel's controls.
  const mixListeners = new Set();
  function onMixChange(fn) { mixListeners.add(fn); return () => mixListeners.delete(fn); }
  function notifyMix() {
    const snap = {
      rigLevel: model.rigLevel, rigMuted: model.rigMuted, rigLimiter: model.rigLimiter,
      master: model.master, masterMuted: _muted,
    };
    mixListeners.forEach(fn => { try { fn(snap); } catch {} });
  }
  function setRigMuted(on) {
    model.rigMuted = !!on;
    lsSet(RIG_MUTE_KEY, model.rigMuted ? '1' : '0');
    looperAudio.setRigMuted(model.rigMuted);
    refreshRigMuteBtn();
    refreshLooperBtn();
    notifyMix();
  }
  function setRigLevel(v) {
    model.rigLevel = clamp01(v);
    lsSet(RIG_LEVEL_KEY, model.rigLevel);
    looperAudio.setRigLevel(model.rigLevel);
    if (rigMasterGain && rigMasterGain.value !== String(model.rigLevel)) rigMasterGain.value = String(model.rigLevel);
    syncMiniKnob('master', 'level', model.rigLevel);
    refreshLooperBtn();
    notifyMix();
  }
  function setRigLimiter(on) {
    model.rigLimiter = !!on;
    lsSet(RIG_LIMITER_KEY, model.rigLimiter ? '1' : '0');
    looperAudio.setRigLimiter(model.rigLimiter);
    notifyMix();
  }
  function setMuted(on) { _muted = !!on; looperAudio.setMuted(_muted); refreshMuteBtn(); refreshLooperBtn(); notifyMix(); }
  function setMaster(v) {
    model.master = clamp01(v);
    looperAudio.setMaster(model.master);
    lsSet(MASTER_KEY, model.master);
    if (elGain && elGain.value !== String(model.master)) elGain.value = String(model.master);
    notifyMix();
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
      scopeGain:   model.scopeGain,
      // Which cab IR / amp capture is loaded (pointer by id + display name). The
      // bytes live in IndexedDB (same machine) or the .qualem.zip (cross-machine);
      // setConfig re-selects by id so the tone comes back with the qualem.
      cabFile:     { id: lsGet(CABCUR_KEY, '') || '', name: model.cabName || '' },
      ampFile:     { id: lsGet(AMPCUR_KEY, '') || '', name: model.ampName || '' },
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
    if (typeof cfg.scopeGain === 'number') { setScopeGain(cfg.scopeGain); if (scopeGainSl) scopeGainSl.value = String(model.scopeGain); }
    if (cfg.channels === 'mono' || cfg.channels === 'stereo') setChannels(cfg.channels);
    // Re-select the cab IR / amp by id if it's present in the local library
    // (bytes already installed by the bundle importer, or already on this
    // machine). Fire-and-forget; a missing id just leaves the current tone.
    if (cfg.cabFile && typeof cfg.cabFile === 'object') {
      const id = cfg.cabFile.id || '';
      if (id && id !== (lsGet(CABCUR_KEY, '') || '')) selectCab(id).catch?.(() => {});
      else if (!id && (lsGet(CABCUR_KEY, '') || '')) selectCab('');
    }
    if (cfg.ampFile && typeof cfg.ampFile === 'object') {
      const id = cfg.ampFile.id || '';
      if (id && id !== (lsGet(AMPCUR_KEY, '') || '')) selectAmp(id).catch?.(() => {});
      else if (!id && (lsGet(AMPCUR_KEY, '') || '')) selectAmp('');
    }
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
    const fillBtn = document.createElement('button');
    fillBtn.type = 'button'; fillBtn.className = 'ctrl-btn looper-fill';
    fillBtn.addEventListener('click', () => cycleTrackFitMode(track.id));
    const ppBtn = document.createElement('button');
    ppBtn.type = 'button'; ppBtn.className = 'ctrl-btn looper-pp';
    ppBtn.addEventListener('click', () => setTrackPreserve(track.id, !track.preservePitch));
    const rateEl = document.createElement('span'); rateEl.className = 'looper-track-rate';
    r3.append(mk('vol', volSl),
              mk('fill', fillBtn, 'How the take fills the bar (click to cycle): "once" plays it once at natural pitch then rests; "tile" repeats it (trailing silence trimmed) at natural pitch; "fit" time-stretches it to the length (this is where the pitch vari/keep choice applies).'),
              mk('pitch', ppBtn, 'Only used in "fit": "vari" = varispeed (pitch follows speed); "keep" = pitch-preserving time-stretch (Signalsmith).'),
              mk('speed', rateEl, 'Playback speed vs the recorded take. 1.00× plays at its natural length (once/tile). In "fit" + "vari", anything off 1.00× is pitch-shifted by the shown semitones; "keep" stretches without pitch shift.'));

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
    rowEls.set(track.id, { row, canvas, gridIn, lengthIn, half, dbl, volSl, muteBtn, armBtn, ppBtn, fillBtn, rateEl });

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

  // ── scope display gain (visual magnifier; NOT audio gain) ──────────────────
  // The IN/OUT scopes are short by default to save real estate, so a small
  // signal can vanish. This slider vertically magnifies the trace only — it
  // never touches the audio or the dB readout (which always reflects true peak).
  let scopeGainSl = null;
  function buildScopeGain() {
    const wrap = document.getElementById('rig-scope-gain-wrap');
    if (!wrap || wrap.children.length) return;
    const lab = document.createElement('span');
    lab.className = 'rig-scope-gain-lab'; lab.textContent = '◹';
    lab.title = 'Scope display gain — magnifies the IN/OUT traces visually only (no audio change)';
    scopeGainSl = document.createElement('input');
    scopeGainSl.type = 'range'; scopeGainSl.min = '0.5'; scopeGainSl.max = '6'; scopeGainSl.step = '0.1';
    scopeGainSl.className = 'rig-scope-gain';
    scopeGainSl.setAttribute('value', '1.8');   // double-click-to-reset default
    scopeGainSl.value = String(model.scopeGain);
    scopeGainSl.title = lab.title;
    scopeGainSl.addEventListener('input', () => setScopeGain(scopeGainSl.value));
    wrap.append(lab, scopeGainSl);
  }
  function setScopeGain(v) {
    const g = parseFloat(v);
    if (!Number.isFinite(g)) return;
    model.scopeGain = Math.max(0.5, Math.min(6, g));
    lsSet(SCOPEGAIN_KEY, model.scopeGain);
    if (scopeGainSl && scopeGainSl.value !== String(model.scopeGain)) scopeGainSl.value = String(model.scopeGain);
  }

  // ── live input scope (oscilloscope) ───────────────────────────────────────
  // Draws the captured input's time-domain waveform when the mic source is
  // live, else a faint idle trace so the panel still looks alive. Allocation-
  // free: one reused Uint8Array sized to the analyser's fftSize.
  let scope2d = null, scopeBuf = null, scopeRAF = 0, scopeStatN = 0;
  let scopeOut2d = null, scopeOutBuf = null;
  function sizeCanvas(cv) {
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 360, h = cv.clientHeight || 36;
    cv.width  = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
  }
  function sizeScope() { sizeCanvas(scopeCanvas); sizeCanvas(scopeOutCanvas); }
  // Trace one analyser's time-domain waveform across the canvas; returns the
  // TRUE peak |sample| (pre display-gain) so the caller can flag real clipping.
  // The vertical scale folds in model.scopeGain — a VISUAL-only magnifier so the
  // (now short) scopes stay legible — and clamps the trace inside the canvas so a
  // boosted wave smears against the rails instead of drawing off-screen.
  function traceWave(g, buf, n, W, mid) {
    let peak = 0;
    const k = mid * 0.92 * (model.scopeGain || 1);
    const H = mid * 2;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const v = (buf[i] - 128) / 128;
      const a = v < 0 ? -v : v; if (a > peak) peak = a;
      const x = (i / (n - 1)) * W;
      let y = mid - v * k;
      if (y < 0) y = 0; else if (y > H) y = H;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    return peak;
  }
  // Faint idle sine so a scope still looks alive when its source is silent.
  function idleTrace(g, W, mid) {
    const t = performance.now() / 1000;
    g.beginPath();
    for (let i = 0; i <= 96; i++) {
      const x = (i / 96) * W;
      const y = mid - Math.sin(i * 0.18 + t * 1.1) * mid * 0.12;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(148,163,184,0.26)';
    g.stroke();
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
      const peak = traceWave(g, scopeBuf, n, W, mid);
      const clip = peak > 0.985;
      g.lineWidth = Math.max(1, Math.round(window.devicePixelRatio || 1));
      g.strokeStyle = clip ? 'rgba(244,114,182,0.95)' : 'rgba(34,211,238,0.9)';
      g.stroke();
      if (scopeStatN++ % 6 === 0) setSignalStatus(peak, clip);
    } else {
      idleTrace(g, W, mid);
      if (scopeStatN++ % 6 === 0) setSignalStatus(null, false);
    }
  }
  // Output scope — the full rig output (channel strip signal + loop bus, post
  // master level/mute): what's going to the speakers. Distinct violet trace so
  // it reads apart from the cyan input above it; pink on clip. The input scope
  // owns the dB readout, so this one is trace-only.
  function drawScopeOut() {
    const cv = scopeOutCanvas, g = scopeOut2d;
    if (!cv || !g) return;
    const W = cv.width, H = cv.height, mid = H / 2;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();

    const an = looperAudio.getOutputAnalyser?.();
    if (an) {
      const n = an.fftSize;
      if (!scopeOutBuf || scopeOutBuf.length !== n) scopeOutBuf = new Uint8Array(n);
      an.getByteTimeDomainData(scopeOutBuf);
      const peak = traceWave(g, scopeOutBuf, n, W, mid);
      g.lineWidth = Math.max(1, Math.round(window.devicePixelRatio || 1));
      g.strokeStyle = peak > 0.985 ? 'rgba(244,114,182,0.95)' : 'rgba(167,139,250,0.92)';
      g.stroke();
    } else {
      idleTrace(g, W, mid);
    }
  }
  function startScope() {
    if (scopeRAF || (!scopeCanvas && !scopeOutCanvas)) return;
    if (!scope2d && scopeCanvas) scope2d = scopeCanvas.getContext('2d');
    if (!scopeOut2d && scopeOutCanvas) scopeOut2d = scopeOutCanvas.getContext('2d');
    sizeScope();
    const loop = () => {
      scopeRAF = requestAnimationFrame(loop);
      // Mini mode hides the scopes — skip drawing them (the loop may still run to
      // drive the tuner). Full mode draws even when collapsed (dB readout).
      if (!model.mini) { drawScope(); drawScopeOut(); }
      if (model.tunerOn) {
        const now = performance.now();
        if (now - _tunerLastMs >= TUNER_INTERVAL_MS) { _tunerLastMs = now; updateTuner(); }
        drawStrobe();   // every frame for smooth strobe motion
      }
    };
    scopeRAF = requestAnimationFrame(loop);
  }
  function stopScope() {
    if (scopeRAF) cancelAnimationFrame(scopeRAF);
    scopeRAF = 0;
  }
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { if (scopeRAF) sizeScope(); });
    if (scopeCanvas) ro.observe(scopeCanvas);
    if (scopeOutCanvas) ro.observe(scopeOutCanvas);
  }
  // Collapse / expand the in + out scopes together (the scope rAF keeps running
  // so the dB readout in the always-visible subhead stays live; we just hide the
  // canvases). Re-size on expand since a hidden canvas has zero client width.
  function applyScopesCollapse() {
    const open = model.scopesOpen !== false;
    if (scopesWrap) scopesWrap.style.display = open ? '' : 'none';
    if (btnScopeCollapse) { btnScopeCollapse.textContent = open ? '▾' : '▸'; btnScopeCollapse.classList.toggle('collapsed', !open); }
    if (open && scopeRAF) sizeScope();
  }
  function toggleScopesCollapse() {
    model.scopesOpen = !model.scopesOpen;
    lsSet(SCOPESOPEN_KEY, model.scopesOpen ? '1' : '0');
    applyScopesCollapse();
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
    syncStripCtl(stage, param, v);   // full-mode slider (no-ops if strip UI unbuilt)
    syncMiniKnob(stage, param, v);   // mini knob — independent of the full strip UI
    persistStrip();
  }
  // Mirror a model value back onto its on-screen slider + readout. Called by
  // stripSet so knob/MIDI nudges (which go straight to the model) visibly move the
  // control. No-ops when the strip UI isn't built (panel/subpanel closed) — the
  // value is already in the model, so buildCtl picks it up on next build. The
  // slider's own `input` handler also routes through stripSet, but writing the
  // same value back is idempotent.
  function syncStripCtl(stage, param, v) {
    if (!stripPanel) return;
    const sl = stripPanel.querySelector(`.rig-ctl input[data-stage="${stage}"][data-param="${param}"]`);
    if (!sl) return;
    sl.value = String(v);
    const valEl = sl.parentElement?.querySelector('.rig-ctl-val');
    if (valEl) {
      const p = STRIP_SCHEMA.find(s => s.id === stage)?.params?.find(q => q.id === param);
      const fmt = p?.fmt || (x => (+x).toFixed(2));
      valEl.textContent = fmt(parseFloat(sl.value));
    }
  }
  function stripToggle(stage, on) {
    model.strip[stage].on = !!on;
    looperAudio.setStripEnabled(stage, !!on);
    refreshStripStages();
    syncMiniLed(stage, !!on);
    persistStrip();
  }
  function refreshStripStages() {
    if (!stripPanel) return;
    for (const stage of STRIP_SCHEMA) {
      if (!stage.toggle) continue;
      // Query the whole strip panel so stages in either group (main row or the
      // utility drawer) get their on/off state synced.
      const box = stripPanel.querySelector(`.rig-stage[data-stage="${stage.id}"]`);
      if (!box) continue;
      const on = !!model.strip[stage.id].on;
      box.classList.toggle('on', on);
      const tg = box.querySelector('.rig-stage-toggle');
      if (tg) { tg.textContent = on ? 'on' : 'off'; tg.classList.toggle('active', on); }
    }
  }
  // Build one strip-stage box (head + toggle + param controls). `collapsible`
  // off (main row) gives every stage a fixed footprint so positions never shift
  // mid-performance — muscle memory over space-saving; the utility drawer keeps
  // per-stage collapse since it's the modular "tuck away" group.
  function buildStripStage(stage, { collapsible = true } = {}) {
    const box = document.createElement('div');
    box.className = 'rig-stage'; box.dataset.stage = stage.id;
    const head = document.createElement('div'); head.className = 'rig-stage-head';
    const nameEl = document.createElement('span'); nameEl.className = 'rig-stage-name'; nameEl.textContent = stage.name;

    let chev = null;
    if (collapsible) {
      const collapsed = !!model.strip[stage.id]?.collapsed;
      if (collapsed) box.classList.add('collapsed');
      chev = document.createElement('button');
      chev.type = 'button'; chev.className = 'ctrl-btn rig-stage-chev';
      chev.textContent = collapsed ? '▸' : '▾';
      chev.title = 'Collapse / expand';
      const toggleCollapse = (e) => {
        if (e) { if (e.target.closest('.rig-stage-toggle')) return; e.stopPropagation(); }
        const c = box.classList.toggle('collapsed');
        chev.textContent = c ? '▸' : '▾';
        if (!model.strip[stage.id]) model.strip[stage.id] = {};
        model.strip[stage.id].collapsed = c;
        persistStrip();
      };
      chev.addEventListener('click', toggleCollapse);
      head.addEventListener('click', toggleCollapse);
    } else {
      head.classList.add('rig-stage-head-fixed');
    }

    if (stage.toggle) {
      const tg = document.createElement('button');
      tg.type = 'button'; tg.className = 'ctrl-btn rig-stage-toggle';
      tg.title = `Enable / bypass ${stage.name}`;
      tg.addEventListener('click', () => stripToggle(stage.id, !model.strip[stage.id].on));
      if (chev) head.append(chev, tg, nameEl); else head.append(tg, nameEl);
    } else {
      box.classList.add('on');   // non-toggle stages (pan) are always active
      if (chev) head.append(chev, nameEl); else head.append(nameEl);
    }

    box.append(head);
    if (stage.params) {
      for (const p of stage.params) box.append(buildCtl(stage.id, p));
    }
    if (stage.loader) box.append(buildCabLoader());
    if (stage.ampLoader) box.append(buildAmpLoader());
    return box;
  }
  function buildStripUI() {
    if (!stripBody || stripBody.children.length) return;
    // Main group → fixed always-visible grid; util group → collapsible drawer.
    // Schema order already yields the desired sub-orders (earth·metal·amp·cab·
    // delay·reverb / hpf·comp·eq·pan), so a simple group filter is enough.
    for (const stage of STRIP_SCHEMA) {
      if (stage.group === 'util') continue;
      stripBody.append(buildStripStage(stage, { collapsible: false }));
    }
    if (stripUtilBody) {
      for (const stage of STRIP_SCHEMA) {
        if (stage.group !== 'util') continue;
        stripUtilBody.append(buildStripStage(stage, { collapsible: true }));
      }
    }
    applyStripUtil();
    refreshStripStages();
  }
  function applyStripUtil() {
    // Mirror the loop/signal subpanels: a .rig-collapse chevron drives the body
    // show/hide, so utility + loop collapse the same way.
    const open = !!model.stripUtilOpen;
    if (stripUtilBody) stripUtilBody.style.display = open ? '' : 'none';
    if (btnStripUtil) {
      btnStripUtil.textContent = open ? '▾' : '▸';
      btnStripUtil.classList.toggle('collapsed', !open);
    }
  }
  function toggleStripUtil() {
    model.stripUtilOpen = !model.stripUtilOpen;
    lsSet(STRIPUTIL_KEY, model.stripUtilOpen ? '1' : '0');
    applyStripUtil();
  }
  // One labelled slider bound to model.strip[stageId][p.id].
  function buildCtl(stageId, p) {
    const row = document.createElement('div'); row.className = 'rig-ctl';
    const lab = document.createElement('span'); lab.className = 'rig-ctl-label'; lab.textContent = p.label;
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = String(p.min); sl.max = String(p.max); sl.step = String(p.step);
    // Tag the slider so external setters (knob/MIDI nudges via stripSet) can find
    // it and keep the on-screen control in sync — otherwise a knob-driven change
    // moves the audio but not the slider, reading as "nothing happened".
    sl.dataset.stage = stageId; sl.dataset.param = p.id;
    // The `value` ATTRIBUTE is the default the global double-click-to-reset reads
    // (page-init.js, via input.defaultValue); the `.value` PROPERTY below carries
    // the live/persisted value. Set the attribute first so it survives.
    const def = STRIP_DEFAULTS[stageId]?.[p.id];
    if (def != null) { sl.setAttribute('value', String(def)); sl.title = 'double-click to reset to default'; }
    sl.value = String(model.strip[stageId][p.id]);
    const val = document.createElement('span'); val.className = 'rig-ctl-val';
    const fmt = p.fmt || (v => (+v).toFixed(2));
    val.textContent = fmt(parseFloat(sl.value));
    sl.addEventListener('input', () => { const v = parseFloat(sl.value); val.textContent = fmt(v); stripSet(stageId, p.id, v); });
    row.append(lab, sl, val);
    return row;
  }
  // ── amp / cab file libraries ───────────────────────────────────────────────
  // A few uploaded IRs / amp captures are kept in IndexedDB (heavy bytes/model)
  // plus a lightweight localStorage index (id + name) so the picker lists them
  // without loading every blob. The library IS the "file browser": load a file
  // once and it stays a click away — no re-upload to switch between a few. (The
  // browser sandbox can't list a real folder; a Chromium-only directory picker
  // via showDirectoryPicker is a possible future add.) misc id = `cab:`/`amp:`
  // + filename, so re-loading the same name overwrites instead of duplicating.
  function lsGetJSON(k) { try { const v = localStorage.getItem(k); const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
  function lsSetJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function libAdd(key, id, name) {
    const list = lsGetJSON(key).filter((e) => e && e.id !== id);
    list.unshift({ id, name });
    lsSetJSON(key, list.slice(0, LIB_MAX));
  }
  function libRemove(key, id) {
    lsSetJSON(key, lsGetJSON(key).filter((e) => e && e.id !== id));
  }
  // Build one loader row: [load] [▼ saved files] [✕ remove]. `kind` differs only
  // in labels/accept/keys, so cab + amp share this builder.
  function buildLibLoader(kind) {
    const cab = kind === 'cab';
    const row = document.createElement('div'); row.className = 'rig-ctl rig-cab-load';
    const file = document.createElement('input');
    file.type = 'file'; file.accept = cab ? 'audio/*,.wav' : '.json,.nam,.aidax,application/json'; file.style.display = 'none';
    file.addEventListener('change', () => { const f = file.files && file.files[0]; if (f) (cab ? loadCabFile(f) : loadAmpFile(f)); file.value = ''; });
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ctrl-btn'; btn.textContent = cab ? 'load IR' : 'load amp';
    btn.title = cab
      ? 'Load a cabinet / reverb impulse response (WAV) from disk — it’s saved to the picker so you can switch back without re-uploading'
      : 'Load a neural amp capture (GuitarML / AIDA-X / NAM-LSTM JSON) from disk — it’s saved to the picker so you can switch back without re-uploading';
    btn.addEventListener('click', () => file.click());
    const sel = document.createElement('select');
    sel.className = 'rig-lib-select';
    sel.title = cab ? 'Saved IRs — pick one to load instantly' : 'Saved amp captures — pick one to load instantly';
    sel.dataset.help = sel.title;   // fallback tooltip when nothing is selected
    sel.addEventListener('change', () => (cab ? selectCab(sel.value) : selectAmp(sel.value)));
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'ctrl-btn'; del.textContent = '✕';
    del.title = cab ? 'Remove the selected IR from the picker' : 'Remove the selected amp from the picker';
    del.addEventListener('click', () => (cab ? removeCab(sel.value) : removeAmp(sel.value)));
    if (!cab && !looperAudio.isAmpCapable?.()) { btn.disabled = true; btn.title = 'Neural amp needs AudioWorklet support'; }
    if (cab) cabSelEl = sel; else ampSelEl = sel;
    // load + remove on the top line; the picker (sel) flex-wraps to a full-width
    // line beneath them, so it has room to show the saved file's full name.
    row.append(file, btn, del, sel);
    if (cab) renderCabLib(); else renderAmpLib();
    return row;
  }
  // Repaint a picker's options from its localStorage index, selecting the current.
  function renderLib(sel, libKey, curKey, emptyTxt) {
    if (!sel) return;
    const list = lsGetJSON(libKey);
    const cur = lsGet(curKey, '') || '';
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = list.length ? emptyTxt.have : emptyTxt.empty;
    sel.append(none);
    for (const e of list) {
      const o = document.createElement('option'); o.value = e.id; o.textContent = e.name;
      sel.append(o);
    }
    sel.value = cur && list.some((e) => e.id === cur) ? cur : '';
    // Tooltip mirrors the selected filename (the collapsed select may ellipsize
    // a long name); fall back to the help text when nothing is loaded.
    const selName = list.find((e) => e.id === sel.value)?.name;
    sel.title = selName || sel.dataset.help || '';
  }
  let cabSelEl = null, ampSelEl = null;
  function buildCabLoader() { return buildLibLoader('cab'); }
  function buildAmpLoader() { return buildLibLoader('amp'); }
  function renderCabLib() { renderLib(cabSelEl, CABLIB_KEY, CABCUR_KEY, { have: 'no IR', empty: 'no saved IRs' }); }
  function renderAmpLib() { renderLib(ampSelEl, AMPLIB_KEY, AMPCUR_KEY, { have: 'no amp', empty: 'no saved amps' }); }

  async function loadCabFile(file) {
    try {
      const bytes = await file.arrayBuffer();
      const ok = await looperAudio.setCabIRBytes(bytes);
      if (!ok) { setStatus('IR decode failed'); return; }
      const id = `cab:${file.name}`;
      model.cabName = file.name; lsSet(CABNAME_KEY, model.cabName); lsSet(CABCUR_KEY, id);
      if (loopStore.isAvailable()) loopStore.putMisc({ id, name: file.name, bytes }).catch(() => {});
      libAdd(CABLIB_KEY, id, file.name); renderCabLib();
      setStatus(`cab IR: ${file.name}`);
    } catch (e) { console.warn('[qualia] cab IR load failed:', e); setStatus('IR load failed'); }
  }
  // Switch to a saved IR (or unload when '' is chosen). Library entry stays.
  async function selectCab(id) {
    if (!id) {
      looperAudio.clearCabIR();
      model.cabName = ''; lsSet(CABNAME_KEY, ''); lsSet(CABCUR_KEY, ''); renderCabLib();
      return;
    }
    if (!loopStore.isAvailable()) return;
    try {
      const rec = await loopStore.getMisc(id);
      if (!rec || !rec.bytes) { setStatus('IR missing — removed'); removeCab(id); return; }
      const ok = await looperAudio.setCabIRBytes(rec.bytes);
      if (!ok) { setStatus('IR decode failed'); return; }
      model.cabName = rec.name || ''; lsSet(CABNAME_KEY, model.cabName); lsSet(CABCUR_KEY, id); renderCabLib();
      setStatus(`cab IR: ${model.cabName}`);
    } catch (e) { console.warn('[qualia] cab IR select failed:', e); setStatus('IR load failed'); }
  }
  function removeCab(id) {
    if (!id) return;
    const wasCur = (lsGet(CABCUR_KEY, '') || '') === id;
    libRemove(CABLIB_KEY, id);
    if (loopStore.isAvailable()) loopStore.deleteMisc(id).catch(() => {});
    if (wasCur) { looperAudio.clearCabIR(); model.cabName = ''; lsSet(CABNAME_KEY, ''); lsSet(CABCUR_KEY, ''); }
    renderCabLib();
  }

  async function loadAmpFile(file) {
    try {
      const text = await file.text();
      let json; try { json = JSON.parse(text); } catch { setStatus('amp: not valid JSON'); return; }
      const parsed = parseAmpModel(json);
      if (!parsed.ok) { setStatus(`amp: ${parsed.reason}`); return; }
      looperAudio.setAmpModel(parsed);
      const id = `amp:${file.name}`;
      model.ampName = file.name; lsSet(AMPNAME_KEY, model.ampName); lsSet(AMPCUR_KEY, id);
      if (loopStore.isAvailable()) loopStore.putMisc({ id, name: file.name, model: parsed }).catch(() => {});
      libAdd(AMPLIB_KEY, id, file.name); renderAmpLib();
      setStatus(`amp: ${file.name}${parsed.experimental ? ' (experimental)' : ''} · ${parsed.hidden}-cell`);
    } catch (e) { console.warn('[qualia] amp load failed:', e); setStatus('amp load failed'); }
  }
  async function selectAmp(id) {
    if (!id) {
      looperAudio.clearAmp();
      model.ampName = ''; lsSet(AMPNAME_KEY, ''); lsSet(AMPCUR_KEY, ''); renderAmpLib();
      return;
    }
    if (!loopStore.isAvailable()) return;
    try {
      const rec = await loopStore.getMisc(id);
      if (!rec || !rec.model) { setStatus('amp missing — removed'); removeAmp(id); return; }
      looperAudio.setAmpModel(rec.model);
      model.ampName = rec.name || ''; lsSet(AMPNAME_KEY, model.ampName); lsSet(AMPCUR_KEY, id); renderAmpLib();
      setStatus(`amp: ${model.ampName}`);
    } catch (e) { console.warn('[qualia] amp select failed:', e); setStatus('amp load failed'); }
  }
  function removeAmp(id) {
    if (!id) return;
    const wasCur = (lsGet(AMPCUR_KEY, '') || '') === id;
    libRemove(AMPLIB_KEY, id);
    if (loopStore.isAvailable()) loopStore.deleteMisc(id).catch(() => {});
    if (wasCur) { looperAudio.clearAmp(); model.ampName = ''; lsSet(AMPNAME_KEY, ''); lsSet(AMPCUR_KEY, ''); }
    renderAmpLib();
  }

  // Fold a legacy single-record (old builds) into the library exactly once.
  async function migrateLegacy(legacyId, libKey, curKey, nameKey, prefix, dataKey, fallbackName) {
    if (lsGetJSON(libKey).length) return;
    const legacy = await loopStore.getMisc(legacyId);
    if (!legacy || !legacy[dataKey]) return;
    const name = legacy.name || fallbackName;
    const id = `${prefix}:${name}`;
    await loopStore.putMisc({ id, name, [dataKey]: legacy[dataKey] });
    libAdd(libKey, id, name);
    lsSet(curKey, id); lsSet(nameKey, name);
    loopStore.deleteMisc(legacyId).catch(() => {});
  }
  // Restore the currently-selected amp / cab on reload (applies to the strip
  // whenever capture opens). Both migrate any legacy single record first.
  async function restoreAmp() {
    if (!loopStore.isAvailable()) return;
    try {
      await migrateLegacy(AMP_MODEL_ID, AMPLIB_KEY, AMPCUR_KEY, AMPNAME_KEY, 'amp', 'model', 'amp');
      const cur = lsGet(AMPCUR_KEY, '') || '';
      if (cur) {
        const rec = await loopStore.getMisc(cur);
        if (rec && rec.model) { looperAudio.setAmpModel(rec.model); model.ampName = rec.name || model.ampName; }
      }
      renderAmpLib();
    } catch (e) { console.warn('[qualia] amp restore failed:', e); }
  }
  async function restoreCabIR() {
    if (!loopStore.isAvailable()) return;
    try {
      await migrateLegacy(CAB_IR_ID, CABLIB_KEY, CABCUR_KEY, CABNAME_KEY, 'cab', 'bytes', 'cab IR');
      const cur = lsGet(CABCUR_KEY, '') || '';
      if (cur) {
        const rec = await loopStore.getMisc(cur);
        if (rec && rec.bytes) { await looperAudio.setCabIRBytes(rec.bytes); model.cabName = rec.name || model.cabName; }
      }
      renderCabLib();
    } catch (e) { console.warn('[qualia] cab IR restore failed:', e); }
  }
  function resetStrip() {
    model.strip = loadDefaultStrip();
    looperAudio.setStripConfig(model.strip);
    lsSet(STRIP_KEY, JSON.stringify(model.strip));
    rebuildStrip();
    refreshMini();
    setStatus('strip reset');
  }

  // ── Mini mode — pedalboard toolbar ──────────────────────────────────────────
  // A condensed view of the rig: one LED (on/off) + one circular knob (the single
  // most useful param) per effect, a tap-to-expand strobe tuner, and compact
  // looper transport. Reads/writes the SAME model as the full strip via stripSet /
  // stripToggle / setRigLevel, so the two views stay in lockstep (syncStripCtl and
  // the refreshers below mirror every change into the mini knobs/LEDs). It's all
  // static DOM — knobs repaint only on change, never per frame — and it hides the
  // scopes/meters/waveforms, so mini is cheaper to run than the full panel.
  const MINI_PEDALS = [
    { stage: 'earth',  param: 'drive', label: 'earth'  },
    { stage: 'metal',  param: 'drive', label: 'metal'  },
    { stage: 'amp',    param: 'gain',  label: 'amp'    },
    { stage: 'cab',    param: 'level', label: 'cab'    },
    { stage: 'delay',  param: 'mix',   label: 'delay'  },
    { stage: 'reverb', param: 'mix',   label: 'reverb' },
  ];
  const miniKnobs = new Map();   // `${stage}:${param}` -> { knob, valEl, min, max, fmt }
  const miniLeds  = new Map();   // stage ('master' | effect id) -> led element
  let miniTunerSq = null, miniTunerMount = null, miniPlayLed = null, _miniBuilt = false;

  function stripParamSpec(stage, param) {
    return STRIP_SCHEMA.find(s => s.id === stage)?.params?.find(p => p.id === param);
  }
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function makeSep() { const s = document.createElement('div'); s.className = 'rig-mini-sep'; return s; }

  // One pedal: LED toggle · circular knob · label. get/set/toggle bridge the model.
  function buildMiniPedal({ stage, param, label, min, max, step, def, fmt, get, set, toggle }) {
    const pedal = document.createElement('div');
    pedal.className = 'rig-pedal'; pedal.dataset.stage = stage;

    const led = document.createElement('button');
    led.type = 'button'; led.className = 'rig-pedal-led';
    led.title = stage === 'master' ? 'Rig live / mute' : `Enable / bypass ${label}`;
    led.addEventListener('click', toggle);
    miniLeds.set(stage, led);

    const knob = document.createElement('div');
    knob.className = 'rig-pedal-knob'; knob.tabIndex = 0;
    knob.dataset.stage = stage; knob.dataset.param = param;
    knob.title = `${label} ${param} — drag / wheel to adjust, double-click to reset`;
    const ring = document.createElement('div'); ring.className = 'rig-pedal-ring';
    const ptr  = document.createElement('div'); ptr.className  = 'rig-pedal-ptr';
    const face = document.createElement('div'); face.className = 'rig-pedal-face';
    const valEl = document.createElement('span'); valEl.className = 'rig-pedal-val';
    face.append(valEl); knob.append(ring, ptr, face);

    const labEl = document.createElement('span'); labEl.className = 'rig-pedal-label'; labEl.textContent = label;
    pedal.append(led, knob, labEl);
    miniKnobs.set(stage + ':' + param, { knob, valEl, min, max, fmt });

    const apply = (v) => set(clampN(v, min, max));
    // Vertical drag — ~150px sweeps the full range.
    let dragging = false, startY = 0, startV = 0, pid = null;
    knob.addEventListener('pointerdown', (e) => {
      dragging = true; startY = e.clientY; startV = get(); pid = e.pointerId;
      try { knob.setPointerCapture(pid); } catch {}
      e.preventDefault();
    });
    knob.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pid) return;
      apply(startV + ((startY - e.clientY) / 150) * (max - min));
    });
    const endDrag = (e) => {
      if (!dragging || (pid != null && e.pointerId !== pid)) return;
      dragging = false; try { knob.releasePointerCapture(pid); } catch {} pid = null;
    };
    knob.addEventListener('pointerup', endDrag);
    knob.addEventListener('pointercancel', endDrag);
    // Wheel — one step per notch.
    knob.addEventListener('wheel', (e) => { e.preventDefault(); apply(get() + (e.deltaY < 0 ? step : -step)); }, { passive: false });
    knob.addEventListener('dblclick', (e) => { e.preventDefault(); if (def != null) apply(def); });
    knob.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { apply(get() + step); e.preventDefault(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { apply(get() - step); e.preventDefault(); }
    });
    return pedal;
  }

  function buildMiniUI() {
    if (!miniEl || _miniBuilt) return;
    _miniBuilt = true;
    const row = document.createElement('div'); row.className = 'rig-mini-row';

    // Tuner (left) — tap-to-expand strobe (the strobe node is relocated here).
    const tune = document.createElement('div'); tune.className = 'rig-mini-tune';
    miniTunerSq = document.createElement('button');
    miniTunerSq.type = 'button'; miniTunerSq.className = 'rig-mini-tune-sq'; miniTunerSq.textContent = '♪';
    miniTunerSq.title = 'Strobe tuner — tap to expand for a quick check';
    miniTunerSq.addEventListener('click', () => toggleTuner());
    const tuneCap = document.createElement('span'); tuneCap.className = 'rig-pedal-label'; tuneCap.textContent = 'tune';
    tune.append(miniTunerSq, tuneCap);

    // One pedal per primary effect (param ranges come from STRIP_SCHEMA).
    const effects = document.createElement('div'); effects.className = 'rig-mini-group';
    for (const p of MINI_PEDALS) {
      const spec = stripParamSpec(p.stage, p.param) || { min: 0, max: 1, step: 0.01 };
      effects.append(buildMiniPedal({
        stage: p.stage, param: p.param, label: p.label,
        min: spec.min, max: spec.max, step: spec.step,
        def: STRIP_DEFAULTS[p.stage]?.[p.param],
        fmt: spec.fmt || (v => (+v).toFixed(2)),
        get: () => model.strip[p.stage]?.[p.param] ?? 0,
        set: (v) => stripSet(p.stage, p.param, v),
        toggle: () => stripToggle(p.stage, !model.strip[p.stage].on),
      }));
    }

    // Compact looper transport — record · play · stop + a playing/recording LED.
    const tr = document.createElement('div'); tr.className = 'rig-mini-transport';
    const trRow = document.createElement('div'); trRow.className = 'rig-mini-tr-row';
    const mkBtn = (txt, title, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ctrl-btn'; b.textContent = txt; b.title = title; b.addEventListener('click', fn); return b; };
    miniPlayLed = document.createElement('span'); miniPlayLed.className = 'rig-mini-play-led';
    trRow.append(
      miniPlayLed,
      mkBtn('●', 'Record into the armed track', () => { recording ? stopRecording() : startRecording(); }),
      mkBtn('▶', 'Play loop', () => { playAll(); }),
      mkBtn('■', 'Stop', () => { stop(); }),
    );
    const trCap = document.createElement('span'); trCap.className = 'rig-mini-cap'; trCap.textContent = 'loop';
    tr.append(trRow, trCap);

    // Master pedal (right) — rig level + mute LED (lit = live).
    const master = buildMiniPedal({
      stage: 'master', param: 'level', label: 'rig',
      min: 0, max: 1, step: 0.05, def: 1, fmt: v => (+v).toFixed(2),
      get: () => model.rigLevel, set: (v) => setRigLevel(v),
      toggle: () => setRigMuted(!model.rigMuted),
    });

    // Order: tuner · effects · looper · master (master ends on the far right).
    row.append(tune, makeSep(), effects, makeSep(), tr, makeSep(), master);

    miniTunerMount = document.createElement('div'); miniTunerMount.id = 'rig-mini-tuner-mount';
    miniEl.append(row, miniTunerMount);
  }

  // Mirror a model value onto its mini knob (ring fill + pointer + readout).
  function syncMiniKnob(stage, param, v) {
    const k = miniKnobs.get(stage + ':' + param);
    if (!k) return;
    const frac = k.max > k.min ? clampN((v - k.min) / (k.max - k.min), 0, 1) : 0;
    k.knob.style.setProperty('--p', frac.toFixed(4));
    k.valEl.textContent = k.fmt(v);
  }
  function syncMiniLed(stage, on) {
    const led = miniLeds.get(stage);
    if (!led) return;
    led.classList.toggle('on', !!on);
    led.parentElement?.classList.toggle('off', !on);
  }
  // Repaint every mini control from the model (after build / reset / mode-enter).
  function refreshMini() {
    if (!_miniBuilt) return;
    syncMiniKnob('master', 'level', model.rigLevel);
    syncMiniLed('master', !model.rigMuted);
    for (const p of MINI_PEDALS) {
      syncMiniKnob(p.stage, p.param, model.strip[p.stage]?.[p.param] ?? 0);
      syncMiniLed(p.stage, !!model.strip[p.stage]?.on);
    }
    refreshMiniTransport();
    refreshMiniTuner();
  }
  function refreshMiniTransport() {
    if (!miniPlayLed) return;
    miniPlayLed.classList.toggle('recording', recording);
    miniPlayLed.classList.toggle('playing', !recording && looperAudio.anyPlaying());
  }
  function refreshMiniTuner() {
    if (!miniTunerSq) return;
    miniTunerSq.classList.toggle('active', !!model.tunerOn);
    const inTune = model.tunerOn && _strobe.inTune;
    const near   = model.tunerOn && _strobe.near && !_strobe.inTune;
    miniTunerSq.classList.toggle('intune', inTune);
    miniTunerSq.classList.toggle('near', near);
    miniTunerSq.textContent = (model.tunerOn && _strobe.voiced && _tunerNoteKey) ? _tunerNoteKey : '♪';
  }

  // Run the scope rAF only when needed: full mode always (scopes); mini mode only
  // while the tuner is expanded. Keeps mini idle-cheap.
  function syncScopeLoop() {
    const open = panel && panel.style.display !== 'none';
    if (open && (!model.mini || model.tunerOn)) startScope(); else stopScope();
  }

  // Enter/leave mini mode: swap which view is visible, relocate the strobe tuner
  // so it can show in either mode, size the window to content, persist.
  function applyMiniMode(on) {
    model.mini = !!on;
    lsSet(MINI_KEY, model.mini ? '1' : '0');
    if (panel) panel.classList.toggle('mini', model.mini);
    // Subtle indicator: the glyph stays put; the cyan `active` highlight marks the
    // FULL rig view, so mini is the quiet/unhighlighted state (no word swap).
    if (btnMini) {
      btnMini.classList.toggle('active', !model.mini);
      btnMini.setAttribute('aria-pressed', model.mini ? 'false' : 'true');
      btnMini.title = model.mini ? 'Pedalboard (mini) view — click for the full rig (⇧O)' : 'Full rig view — click to condense to the pedalboard (⇧O)';
    }
    if (model.mini) {
      buildMiniUI();
      if (miniEl) miniEl.style.display = '';
      // Relocate the strobe tuner into the mini mount so a tap-expand shows here.
      if (tunerEl && miniTunerMount && tunerEl.parentElement !== miniTunerMount) miniTunerMount.append(tunerEl);
      if (temperEl) temperEl.style.display = 'none';   // temperament editor is full-mode only
      refreshMini();
    } else {
      if (miniEl) miniEl.style.display = 'none';
      // Restore the tuner to the signal subpanel (its home, just before temper).
      if (tunerEl && rigSignalEl && tunerEl.parentElement !== rigSignalEl) {
        if (temperEl && temperEl.parentElement === rigSignalEl) rigSignalEl.insertBefore(tunerEl, temperEl);
        else rigSignalEl.append(tunerEl);
      }
      if (temperEl) temperEl.style.display = model.tunerOn ? '' : 'none';
    }
    syncScopeLoop();
    reposition();
  }
  function toggleMini() { applyMiniMode(!model.mini); }

  // ── bundle asset I/O (for the .qualem.zip exporter) ────────────────────────
  // Gather the heavy local assets needed to recreate this rig elsewhere: the
  // recorded loops (raw PCM channels), the saved cab IRs, and the saved amp
  // captures. Pointers (ids) match what getConfig() records, so the importer can
  // re-link the active cab/amp after install.
  async function collectAssets() {
    const out = { loops: [], cabs: [], amps: [] };
    if (!loopStore.isAvailable()) return out;
    try {
      const recs = await loopStore.getAllTracks();
      for (const r of recs) {
        const channels = Array.isArray(r.pcm) ? r.pcm : [r.pcm];
        out.loops.push({
          id: r.id, name: `track-${(r.order ?? out.loops.length) + 1}`,
          sampleRate: r.sampleRate || 48000,
          channels,
          meta: {
            order: r.order, regionFrames: r.regionFrames, contentFrames: r.contentFrames, loopStartBase: r.loopStartBase,
            naturalSeconds: r.naturalSeconds, recordedCycles: r.recordedCycles,
            grid: r.grid, length: r.length, fitMode: r.fitMode, volume: r.volume, muted: r.muted, preservePitch: r.preservePitch,
          },
        });
      }
    } catch (e) { console.warn('[qualia] collect loops failed:', e); }
    try {
      for (const e of lsGetJSON(CABLIB_KEY)) {
        const rec = await loopStore.getMisc(e.id);
        if (rec && rec.bytes) out.cabs.push({ id: e.id, name: e.name || rec.name || 'cab', bytes: rec.bytes });
      }
      for (const e of lsGetJSON(AMPLIB_KEY)) {
        const rec = await loopStore.getMisc(e.id);
        if (rec && rec.model) out.amps.push({ id: e.id, name: e.name || rec.name || 'amp', model: rec.model });
      }
    } catch (e) { console.warn('[qualia] collect cab/amp failed:', e); }
    return out;
  }
  // Install assets pulled from a bundle into IndexedDB + the library indexes,
  // then rebuild the loop tracks. The active cab/amp is selected afterwards by
  // setConfig (via cabFile/ampFile pointers).
  async function installAssets(assets, { replaceLoops = true } = {}) {
    if (!assets || !loopStore.isAvailable()) return;
    try {
      for (const c of (assets.cabs || [])) {
        if (!c?.id || !c.bytes) continue;
        await loopStore.putMisc({ id: c.id, name: c.name, bytes: c.bytes });
        libAdd(CABLIB_KEY, c.id, c.name);
      }
      for (const a of (assets.amps || [])) {
        if (!a?.id || !a.model) continue;
        await loopStore.putMisc({ id: a.id, name: a.name, model: a.model });
        libAdd(AMPLIB_KEY, a.id, a.name);
      }
      renderCabLib(); renderAmpLib();
    } catch (e) { console.warn('[qualia] install cab/amp failed:', e); }
    try {
      if (assets.loops && assets.loops.length) {
        if (replaceLoops) await loopStore.clearAll();
        for (const l of assets.loops) {
          const m = l.meta || {};
          await loopStore.putTrack({
            id: l.id, order: m.order,
            pcm: l.channels, sampleRate: l.sampleRate || 48000,
            regionFrames: m.regionFrames, contentFrames: m.contentFrames, loopStartBase: m.loopStartBase,
            naturalSeconds: m.naturalSeconds, recordedCycles: m.recordedCycles,
            grid: m.grid, length: m.length, fitMode: m.fitMode, volume: m.volume, muted: m.muted, preservePitch: m.preservePitch,
          });
        }
        await reloadTracks();
      }
    } catch (e) { console.warn('[qualia] install loops failed:', e); }
  }
  // Force-rebuild the loop tracks from IndexedDB (drops the in-memory set first).
  async function reloadTracks() {
    looperAudio.stopAll?.();
    model.tracks = [];
    await restoreFromStore({ force: true });
    if (!model.tracks.length) { const t = makeTrack(); model.tracks.push(t); model.armedTrackId = t.id; renderTracks(); }
  }
  function rebuildStrip() { if (stripBody) { stripBody.innerHTML = ''; if (stripUtilBody) stripUtilBody.innerHTML = ''; cabSelEl = null; ampSelEl = null; buildStripUI(); } }
  function refreshStripBtn() { if (btnStrip) btnStrip.classList.toggle('active', !!model.stripOpen); }
  function toggleStrip(on) {
    model.stripOpen = on == null ? !model.stripOpen : !!on;
    lsSet(STRIPOPEN_KEY, model.stripOpen ? '1' : '0');
    if (model.stripOpen) buildStripUI();
    if (stripPanel) stripPanel.style.display = model.stripOpen ? '' : 'none';
    refreshStripBtn();
  }

  // ── loop section toggle (signal header button) ──────────────────────────────
  function refreshLoopBtn() { if (btnLoop) btnLoop.classList.toggle('active', !!model.loopOpen); }
  function toggleLoop(on) {
    model.loopOpen = on == null ? !model.loopOpen : !!on;
    lsSet(LOOPOPEN_KEY, model.loopOpen ? '1' : '0');
    if (rigLoopSection) rigLoopSection.style.display = model.loopOpen ? '' : 'none';
    refreshLoopBtn();
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

  // ── virtual strobe tuner ───────────────────────────────────────────────────
  // A Peterson-StroboStomp-style strobe: instead of a needle, a row of striped
  // bands that DRIFT when the note is off (right = sharp, left = flat) and FREEZE
  // when it's in tune. The note name + cents readout stays for a coarse glance.
  //
  // The strobe is driven by PHASE, not by the pitch estimate: each frame we
  // demodulate the input against a reference oscillator running at the target
  // note's exact frequency (I/Q heterodyne, incrementally rotated — allocation-
  // free). The reference is anchored to the audio clock (ctx.currentTime), so a
  // perfectly-tuned note holds a constant phase (frozen bands) while a δ-Hz error
  // rotates the phase at exactly δ cycles/sec — sub-cent precise and cheap.
  // Pitch *detection* (autocorrelation, throttled) only picks WHICH note to lock
  // the strobe to. Three octave-stacked bands give coarse→fine sensitivity.
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const TUNER_MIN_HZ = 22;     // reach below G0 (~24.5 Hz)
  const TUNER_INTERVAL_MS = 140;  // note-detection cadence (strobe itself runs every frame)
  const STROBE_BANDS = 3;      // octave-stacked sensitivity rows (×1, ×2, ×4)
  let tunerNoteEl = null, tunerHzEl = null, tunerTgtEl = null, tunerCentsEl = null;
  let strobeCanvas = null, strobe2d = null, _strobeWin = null;
  let tunerBuf = null, tunerDec = null, _tunerLastMs = 0;
  let _tunerNoteKey = '', _tunerErrSmooth = 0;
  // Shared strobe state written by updateTuner (throttled) + read by drawStrobe (per-frame).
  const _strobe = { fRef: 0, voiced: false, inTune: false, near: false, msg: 'play a note' };
  function buildTunerUI() {
    if (!tunerEl || tunerEl.children.length) return;
    const row = document.createElement('div'); row.className = 'rig-tuner-readout';
    tunerNoteEl = document.createElement('span'); tunerNoteEl.className = 'rig-tuner-note'; tunerNoteEl.textContent = '—';
    tunerCentsEl = document.createElement('span'); tunerCentsEl.className = 'rig-tuner-cents'; tunerCentsEl.textContent = 'play a note';
    tunerHzEl   = document.createElement('span'); tunerHzEl.className   = 'rig-tuner-hz';
    tunerTgtEl  = document.createElement('span'); tunerTgtEl.className  = 'rig-tuner-tgt';
    _tunerMuteBtn = document.createElement('button');
    _tunerMuteBtn.type = 'button'; _tunerMuteBtn.className = 'ctrl-btn rig-tuner-mute';
    _tunerMuteBtn.addEventListener('click', () => {
      model.tunerMute = !model.tunerMute;
      lsSet(TUNERMUTE_KEY, model.tunerMute ? '1' : '0');
      applyTunerMute();
    });
    refreshTunerMuteBtn();
    row.append(tunerNoteEl, tunerCentsEl, tunerHzEl, tunerTgtEl, _tunerMuteBtn);
    strobeCanvas = document.createElement('canvas');
    strobeCanvas.className = 'rig-strobe';
    strobeCanvas.title = 'Strobe tuner — bands freeze when in tune, drift right when sharp / left when flat';
    tunerEl.append(row, strobeCanvas);
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
  // Throttled note pick: detect the fundamental, name it, and set the strobe's
  // target reference frequency (temperament-aware). Updates the text readout.
  function updateTuner() {
    if (!model.tunerOn || !tunerNoteEl) return;
    const an = looperAudio.getTunerAnalyser?.() || looperAudio.getCaptureAnalyser?.();
    const clear = (msg) => {
      tunerNoteEl.textContent = '—'; tunerNoteEl.style.color = '';
      if (tunerHzEl) tunerHzEl.textContent = ''; if (tunerTgtEl) tunerTgtEl.textContent = '';
      tunerCentsEl.textContent = msg; tunerCentsEl.style.color = '';
      _tunerNoteKey = '';
      _strobe.voiced = false; _strobe.inTune = false; _strobe.near = false; _strobe.msg = msg;
      refreshMiniTuner();
    };
    if (!an || typeof an.getFloatTimeDomainData !== 'function') { clear('rig signal off'); return; }
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
    if (f <= 0) { clear('play a note'); return; }
    const midi = 69 + 12 * Math.log2(f / model.refPitch);
    const rounded = Math.round(midi);
    const cls = ((rounded % 12) + 12) % 12;
    const octave = Math.floor(rounded / 12) - 1;
    const rawCents = (midi - rounded) * 100;                // deviation from ET
    const target = temperOffset(cls);                      // sweetened target offset
    let err = rawCents - target;                           // deviation from the target
    // Smooth within a held note (snap on note change) to calm the readout.
    const key = `${cls}.${octave}`;
    err = key === _tunerNoteKey ? _tunerErrSmooth * 0.5 + err * 0.5 : err;
    _tunerNoteKey = key; _tunerErrSmooth = err;
    const shown = Math.round(err);
    const inTune = Math.abs(err) <= 3;
    const near   = Math.abs(err) <= 12;
    const good = 'var(--green)';
    tunerNoteEl.textContent = `${NOTE_NAMES[cls]}${octave}`;
    tunerNoteEl.style.color = inTune ? good : '';
    if (tunerHzEl) tunerHzEl.textContent = `${f.toFixed(1)} Hz`;
    if (tunerTgtEl) tunerTgtEl.textContent = `tgt ${target > 0 ? '+' : ''}${target}¢`;
    tunerCentsEl.textContent = `${shown > 0 ? '+' : ''}${shown}¢`;
    tunerCentsEl.style.color = inTune ? good : (near ? '#fbbf24' : 'var(--pink)');
    // The strobe locks to the note's IDEAL frequency (temperament-aware), so the
    // bands measure the true pitch error continuously, independent of `err`.
    _strobe.fRef    = model.refPitch * Math.pow(2, (rounded - 69) / 12 + target / 1200);
    _strobe.voiced  = true;
    _strobe.inTune  = inTune;
    _strobe.near    = near;
    refreshMiniTuner();
  }
  // Per-frame strobe: demodulate the live input at each band frequency and paint
  // the drifting/frozen bands. Allocation-free (reused buffer + lazy Hann window).
  function drawStrobe() {
    const cv = strobeCanvas; if (!cv) return;
    if (!strobe2d) strobe2d = cv.getContext('2d');
    const g = strobe2d; if (!g) return;
    // Self-healing size (the canvas was display:none until the tuner opened).
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const wantW = Math.max(1, Math.round((cv.clientWidth || 300) * dpr));
    const wantH = Math.max(1, Math.round((cv.clientHeight || 46) * dpr));
    if (cv.width !== wantW || cv.height !== wantH) { cv.width = wantW; cv.height = wantH; }
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);

    const an = looperAudio.getTunerAnalyser?.() || looperAudio.getCaptureAnalyser?.();
    if (!_strobe.voiced || !an || !(_strobe.fRef > 0) || typeof an.getFloatTimeDomainData !== 'function') {
      // Idle: faint static bands + a hint.
      drawStrobeIdle(g, W, H);
      return;
    }
    const n = an.fftSize;
    if (!tunerBuf || tunerBuf.length !== n) tunerBuf = new Float32Array(n);
    an.getFloatTimeDomainData(tunerBuf);
    if (!_strobeWin || _strobeWin.length !== n) {
      _strobeWin = new Float32Array(n);
      for (let i = 0; i < n; i++) _strobeWin[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
    }
    const sr = an.context?.sampleRate || 48000;
    const t0 = (an.context?.currentTime || 0);   // audio-clock anchor → phase continuity
    const bandH = H / STROBE_BANDS;
    const period = Math.max(10 * dpr, bandH * 0.92);   // stripe period (px)
    const inTune = _strobe.inTune;
    const baseColor = inTune ? [52, 211, 153] : (_strobe.near ? [251, 191, 36] : [167, 139, 250]);
    let maxMag = 1e-9;
    const mags = _strobeMags, phs = _strobePhs;
    for (let b = 0; b < STROBE_BANDS; b++) {
      const fb = _strobe.fRef * (1 << b);
      if (fb > sr * 0.45) { mags[b] = 0; phs[b] = 0; continue; }
      // I/Q correlation at fb via incremental unit-vector rotation.
      const w = (2 * Math.PI * fb) / sr;
      const cw = Math.cos(w), sw = Math.sin(w);
      let ang = 2 * Math.PI * ((fb * t0) % 1);
      let cr = Math.cos(ang), si = Math.sin(ang);
      let I = 0, Q = 0;
      for (let i = 0; i < n; i++) {
        const x = tunerBuf[i] * _strobeWin[i];
        I += x * cr; Q += x * si;
        const ncr = cr * cw - si * sw; si = si * cw + cr * sw; cr = ncr;
      }
      mags[b] = Math.sqrt(I * I + Q * Q);
      // atan2(Q,I) drifts at 2π(fRef−fIn); negate so the phase advances at
      // 2π(fIn−fRef) — i.e. SHARP drifts the bands right, flat left (Peterson
      // convention). In tune (fIn==fRef) the phase is constant → bands freeze.
      phs[b] = Math.atan2(-Q, I);
      if (mags[b] > maxMag) maxMag = mags[b];
    }
    for (let b = 0; b < STROBE_BANDS; b++) {
      const y = b * bandH;
      // Band opacity follows its share of energy so weak harmonics fade out
      // rather than flickering as noise.
      const rel = mags[b] / maxMag;
      const alpha = 0.12 + 0.78 * Math.min(1, rel);
      // Frozen when in tune; otherwise the phase drifts → stripes scroll.
      const off = ((phs[b] / (2 * Math.PI)) % 1 + 1) % 1 * period;
      g.fillStyle = `rgba(${baseColor[0]},${baseColor[1]},${baseColor[2]},${alpha.toFixed(3)})`;
      for (let x = -period + off; x < W; x += period) {
        g.fillRect(x, y + bandH * 0.12, period * 0.5, bandH * 0.76);
      }
    }
    if (inTune) {
      g.strokeStyle = 'rgba(52,211,153,0.9)';
      g.lineWidth = Math.max(1, Math.round(dpr));
      g.strokeRect(g.lineWidth, g.lineWidth, W - 2 * g.lineWidth, H - 2 * g.lineWidth);
    }
  }
  const _strobeMags = new Float32Array(STROBE_BANDS);
  const _strobePhs  = new Float32Array(STROBE_BANDS);
  function drawStrobeIdle(g, W, H) {
    const bandH = H / STROBE_BANDS;
    const period = Math.max(18, bandH * 0.92);
    g.fillStyle = 'rgba(148,163,184,0.10)';
    for (let b = 0; b < STROBE_BANDS; b++) {
      const y = b * bandH;
      for (let x = 0; x < W; x += period) g.fillRect(x, y + bandH * 0.12, period * 0.5, bandH * 0.76);
    }
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
    // In mini mode the temperament editor stays tucked away; show it only in full.
    if (temperEl) temperEl.style.display = (model.tunerOn && !model.mini) ? '' : 'none';
    if (model.tunerOn) {
      buildTunerUI();
      buildTemperamentUI();
      looperAudio.ensureCaptureOpen(model.deviceId).then(refreshLooperBtn).catch(() => {});
    }
    applyTunerMute();
    refreshTunerBtn();
    refreshMiniTuner();
    // The strobe is driven by the scope rAF — start/stop it as tuner visibility
    // changes so mini stays idle-cheap when the tuner is collapsed.
    syncScopeLoop();
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
    const mode = track.fitMode || 'once';
    if (el.fillBtn) {
      el.fillBtn.textContent = mode;
      el.fillBtn.classList.toggle('active', mode === 'fit');
    }
    if (el.ppBtn) {
      el.ppBtn.classList.toggle('active', !!track.preservePitch);
      el.ppBtn.textContent = track.preservePitch ? 'keep' : 'vari';
      // Pitch vari/keep only matters when stretching ("fit").
      el.ppBtn.disabled = mode !== 'fit';
    }
    updateTrackRate(track);
    applyCanvasHeight(track);
  }

  // ── varispeed / buffer readouts ────────────────────────────────────────────
  // Mirror of looper-audio's derivePlaybackRate so the row can SHOW why a take
  // plays back sharp/flat: rate = recorded length ÷ the wall-time of `length`
  // cycles at the current tempo. 1.00× = natural; off 1.00× in "vari" is pitch-
  // shifted (the take didn't fill a whole number of cycles, so it's sped to fit).
  function trackRate(t) {
    if (!t.buffer || !t.naturalSeconds || !t.length) return 1;
    const cps = currentCps();
    const targetSec = t.length / (cps > 0 ? cps : 0.5);
    const r = t.naturalSeconds / targetSec;
    return (r > 0 && isFinite(r)) ? r : 1;
  }
  function updateTrackRate(track) {
    const el = rowEls.get(track.id)?.rateEl;
    if (!el) return;
    if (!track.buffer) { el.textContent = '—'; el.className = 'looper-track-rate'; return; }
    // once/tile always play at natural rate — no stretch, no shift.
    if ((track.fitMode || 'once') !== 'fit') {
      el.textContent = '1.00×';
      el.className = 'looper-track-rate';
      return;
    }
    const r = trackRate(track);
    const semis = 12 * Math.log2(r);
    const off = Math.abs(r - 1) > 0.01;
    if (track.preservePitch) {
      // Pitch preserved — only the tempo is stretched, no semitone shift.
      el.textContent = `${r.toFixed(2)}×`;
      el.className = 'looper-track-rate' + (off ? ' stretched' : '');
    } else {
      el.textContent = off ? `${r.toFixed(2)}× ${semis >= 0 ? '+' : ''}${semis.toFixed(1)}st` : `${r.toFixed(2)}×`;
      el.className = 'looper-track-rate' + (Math.abs(semis) > 0.25 ? ' shift' : '');
    }
  }
  // Live "grab" buffer readout: how much lookback is filled vs what a grab needs.
  function updateBufferReadout() {
    const info = looperAudio.getBufferInfo?.() || { capable: false, seconds: 0, capSeconds: 40 };
    if (bufferBtn && looperAudio.isBuffering() && info.capable) {
      bufferBtn.textContent = `buffer ● ${Math.floor(info.seconds)}s`;
    }
    if (btnRetro && info.capable) {
      const cps = currentCps() || 0.5;
      const needSec = model.retroCycles / cps;
      const haveCyc = info.seconds * cps;
      const enough = info.seconds >= needSec * 0.98;
      btnRetro.classList.toggle('insufficient', !enough);
      btnRetro.title = `${enough ? 'Grab' : 'Buffer still filling — grab'} the last ${model.retroCycles} cyc (~${needSec.toFixed(1)}s). `
        + `Buffered ${info.seconds.toFixed(0)}s ≈ ${haveCyc.toFixed(1)} cyc.`;
    }
  }
  let _bufRateTimer = null;
  function startBufRateTick() {
    if (_bufRateTimer) return;
    _bufRateTimer = setInterval(() => {
      updateBufferReadout();
      for (const t of model.tracks) updateTrackRate(t);
    }, 500);
  }
  function stopBufRateTick() { if (_bufRateTimer) { clearInterval(_bufRateTimer); _bufRateTimer = null; } }
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
    refreshMiniTransport();
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
  function refreshRigMuteBtn() {
    syncMiniLed('master', !model.rigMuted);
    if (!btnRigMute) return;
    btnRigMute.classList.toggle('muted', model.rigMuted);
    btnRigMute.textContent = model.rigMuted ? 'muted' : 'live';
    btnRigMute.title = model.rigMuted ? 'Unmute rig output (signal + loops)' : 'Mute all rig output (signal + loops)';
  }
  function refreshLooperBtn() {
    if (!btnToggle) return;
    btnToggle.classList.remove('active', 'active-audio');
    const sig = looperAudio.getSignal();
    const sigOut = sig.live && !sig.muted && sig.level > 0;
    const loopsOut = looperAudio.anyPlaying() && !_muted;
    const outputting = !model.rigMuted && model.rigLevel > 0 && (sigOut || loopsOut);
    const open = panel?.style.display !== 'none';
    if (open) btnToggle.classList.add('active');
    btnToggle.textContent = outputting ? 'rig ●' : 'rig';
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
    refreshLoopBtn();
    if (rigLoopSection) rigLoopSection.style.display = model.loopOpen ? '' : 'none';
    applyLoopCollapse();
    startScope();
    applyScopesCollapse();
    refreshLooperBtn();
    refreshTransport();
    // Restore mini (pedalboard) mode last — it swaps which view is visible,
    // relocates the strobe tuner, and re-runs syncScopeLoop to right-size the rAF.
    applyMiniMode(model.mini);
    startBufRateTick();
  }
  function close() {
    if (panel) panel.style.display = 'none';
    lsSet(PANEL_OPEN_KEY, '0');
    stopScope();
    stopBufRateTick();
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
  if (btnMini)   btnMini.addEventListener('click', () => { toggleMini(); });
  if (btnStrip)  btnStrip.addEventListener('click', () => { toggleStrip(); });
  if (btnStripUtil) btnStripUtil.addEventListener('click', () => { toggleStripUtil(); });
  if (btnStripReset) btnStripReset.addEventListener('click', () => { resetStrip(); });
  if (btnLoop) btnLoop.addEventListener('click', () => { toggleLoop(); });
  if (btnLoopCollapse) btnLoopCollapse.addEventListener('click', () => { toggleLoopCollapse(); });
  if (btnScopeCollapse) btnScopeCollapse.addEventListener('click', () => { toggleScopesCollapse(); });
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
  if (btnRigMute) { btnRigMute.addEventListener('click', () => setRigMuted(!model.rigMuted)); refreshRigMuteBtn(); }
  if (rigMasterGain) {
    rigMasterGain.value = String(model.rigLevel);
    rigMasterGain.addEventListener('input', () => setRigLevel(+rigMasterGain.value));
  }

  // Repaint topbar/state when audio.js flips the looper / rig source on/off.
  audio?.onChange?.(() => refreshLooperBtn());
  syncStrudel?.onReadyChange?.(() => refreshSyncStatus());

  // Seed with one empty armed track (Phase 5 restores persisted tracks here).
  model.tracks.push(makeTrack());
  model.armedTrackId = model.tracks[0].id;

  // Initial paint even while hidden so first open() shows content immediately.
  renderSignal();           // build the rig signal controls up front
  buildScopeGain();         // scope display-gain magnifier
  if (propsEl) renderProps();
  if (tracksEl) renderTracks();
  refreshMuteBtn();
  refreshBufferBtn();
  refreshChannelsBtn();
  refreshStripBtn();
  refreshTunerBtn();
  refreshLoopBtn();
  if (!model.loopOpen && rigLoopSection) rigLoopSection.style.display = 'none';
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
    collectAssets, installAssets,
    // ── Mixer surface — rig master (= rig signal + loops) ──────────────────
    setRigLevel, setRigMuted, setRigLimiter,
    nudgeRigLevel(delta) { setRigLevel(clamp01((model.rigLevel ?? 1) + delta)); },
    getRig: () => ({ level: model.rigLevel, muted: model.rigMuted, limiter: model.rigLimiter }),
    onMixChange,
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
    toggleRigMute() { setRigMuted(!model.rigMuted); },
  };
}
