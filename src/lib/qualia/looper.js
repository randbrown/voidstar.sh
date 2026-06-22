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
import { createLooperRenderer } from './looper-render.js';
import * as loopStore from './looper-store.js';
import { wirePicker, getStoredDeviceId } from './devices.js';

const NS = 'voidstar.qualia.looper';
const PANEL_OPEN_KEY = `${NS}.panelOpen`;
const MASTER_KEY     = `${NS}.master`;     // overall looper output (header slider)
const SYNC_KEY       = `${NS}.sync`;
const GRID_KEY       = `${NS}.grid`;       // default "cycles" (grid) for new tracks
const OFFSET_KEY     = `${NS}.offsetMs`;
const IMMEDIATE_KEY  = `${NS}.immediate`;  // "start now" (drop in mid-cycle) vs wait for boundary
const INPUT_DEFAULT  = 0.7;                // double-click-reset target for the input fader

const num01 = (raw, dflt) => { const v = parseFloat(raw); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt; };
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }

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
  const scopeCanvas = document.getElementById('rig-scope');
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
  const defaultGrid = Math.max(1, Math.min(16, parseInt(lsGet(GRID_KEY, lsGet(`${NS}.metacycle`, '1')), 10) || 1));

  // Live model. `track` became `tracks[]` + an armed id in v2.
  const model = {
    syncStrudel: lsGet(SYNC_KEY, '1') !== '0',
    immediate: lsGet(IMMEDIATE_KEY, '0') === '1',   // "start now" vs wait for boundary
    cps: 0.5,                       // used when sync is off / Strudel idle
    offsetMs: (() => { const v = parseInt(lsGet(OFFSET_KEY, '0'), 10); return Number.isFinite(v) ? Math.max(-200, Math.min(500, v)) : 0; })(),
    master:   num01(lsGet(MASTER_KEY, '0.9'), 0.9),   // overall looper output
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
    setStatus(`recorded · ${fmtLen(cyc)} cyc`);
    await playVoice(t);            // play the new take; other tracks keep looping
    syncRenderers();
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
  // The live input is the page-level input channel (audio.js) — one shared
  // path (volume + mute) that lands on speakers + the screen recording and
  // drives the visualizer. Raising / unmuting ensures the page mic is live.
  async function ensureInputLive() {
    if (audio?.hasSource?.('mic')) return;
    try { await audio?.start?.(model.deviceId || ''); }
    catch (e) { console.warn('[qualia] looper input start failed:', e); }
    refreshLooperBtn();
  }
  function setInputVol(v) {
    const lvl = clamp01(v);
    audio?.setInputLevel?.(lvl);
    if (lvl > 0) ensureInputLive();
  }
  function setInputMuted(on) {
    audio?.setInputMuted?.(!!on);
    if (!on) ensureInputLive();
    refreshInputMuteBtn();
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
      cps:         model.cps,
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
      syncWrap,
      immWrap,
    );
    refreshSyncStatus();
  }

  // ── signal subpanel (live input level + mute + scope) ─────────────────────
  // The live instrument signal is the page-level input channel (audio.js): its
  // fader (gated by mute) lands on the speakers AND the screen recording, while
  // the visualizer + scope tap the analyser PRE-fader (reactive even at level
  // 0). Built once; the scope self-drives a rAF while the panel is open.
  function renderSignal() {
    if (!signalCtrls || signalCtrls.children.length) return;
    inputVolSl = volSlider(audio?.getInput?.().level ?? 0, setInputVol,
      'Live input level — your guitar / mic through the speakers AND into the screen recording at this level. Shared with the audio panel. The visualizer + scope react whenever input is captured (pre-fader). Raising it can feed back on speakers (fine on headphones / an interface). Double-click to reset.',
      INPUT_DEFAULT);
    inputMuteBtn = miniBtn('mute', () => setInputMuted(!(audio?.getInput?.().muted)));
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

    const an = audio?.getInputAnalyser?.();
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
    const loop = () => { scopeRAF = requestAnimationFrame(loop); drawScope(); };
    scopeRAF = requestAnimationFrame(loop);
  }
  function stopScope() {
    if (scopeRAF) cancelAnimationFrame(scopeRAF);
    scopeRAF = 0;
  }
  if (scopeCanvas && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { if (scopeRAF) sizeScope(); }).observe(scopeCanvas);
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
    const muted = !!(audio?.getInput?.().muted);
    inputMuteBtn.classList.toggle('muted', muted);
    inputMuteBtn.textContent = muted ? 'muted' : 'mute';
    inputMuteBtn.title = muted ? 'Unmute live input' : 'Mute live input (speakers + recording)';
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
    refreshSyncBtnVisibility();
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
    // Rig is "live" when anything it owns is audible — a loop voice OR the live
    // input channel (the processed signal feeding the mix).
    const live = audio?.hasSource?.('looper') || audio?.hasSource?.('mic');
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
      try { await looperAudio.setInputDevice(model.deviceId); } catch (e) { console.warn('[qualia] looper device switch failed:', e); }
      // Keep the page input channel on the same device when it's live.
      if (audio?.hasSource?.('mic')) { try { await audio.start(model.deviceId || ''); } catch {} }
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
    renderSignal();
    if (!rowEls.size) renderTracks();
    if (!propsEl?.children.length) renderProps();
    for (const r of renderers.values()) r.resize();
    try { picker?.populate?.(model.deviceId); } catch {}
    const inp = audio?.getInput?.() || { level: 0, muted: false };
    if (inputVolSl) inputVolSl.value = String(inp.level);
    refreshInputMuteBtn();
    // Resume live-input monitoring on open (a user gesture) if it was left up —
    // so a remembered input level/device comes back without a manual nudge.
    if (inp.level > 0 && !inp.muted && !audio?.hasSource?.('mic')) ensureInputLive();
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
  if (btnPlay)   btnPlay.addEventListener('click', () => { playAll(); });
  if (btnStop)   btnStop.addEventListener('click', () => { stop(); });
  if (btnMute)   btnMute.addEventListener('click', () => { setMuted(!_muted); });
  if (btnSync)   btnSync.addEventListener('click', () => { realign(); });
  if (btnDelete) btnDelete.addEventListener('click', () => { clearAll(); });
  if (elGain) {
    elGain.value = String(model.master);
    elGain.addEventListener('input', () => setMaster(elGain.value));
  }

  // Repaint topbar/state when audio.js flips the looper source on/off.
  audio?.onChange?.(() => refreshLooperBtn());
  // Keep the "input" controls in sync with the shared page-level input channel
  // (it can also be changed from the audio panel).
  audio?.onInputChange?.((m) => {
    if (inputVolSl) inputVolSl.value = String(m.level);
    refreshInputMuteBtn();
  });
  syncStrudel?.onReadyChange?.(() => refreshSyncStatus());

  // Seed with one empty armed track (Phase 5 restores persisted tracks here).
  model.tracks.push(makeTrack());
  model.armedTrackId = model.tracks[0].id;

  // Initial paint even while hidden so first open() shows content immediately.
  renderSignal();           // build input controls up front (onInputChange reads them)
  if (propsEl) renderProps();
  if (tracksEl) renderTracks();
  refreshMuteBtn();
  refreshTransport();
  refreshLooperBtn();
  refreshSyncBtnVisibility();

  if (wasOpenLastSession) open();

  // Restore persisted loops (async). Replaces the seeded empty track if any
  // saved loops are found; otherwise the seeded empty armed track stays.
  restoreFromStore();

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
  };
}
