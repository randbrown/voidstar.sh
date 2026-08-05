// syzygy — session persistence (settings, files, results) across page loads.
//
// Three tiers, each degrading gracefully:
//   localStorage — settings, the sound-match result (keyed to the file
//     pair), and a tiny run-status marker ("was a render interrupted?").
//   IndexedDB blobs — the actual picked Files (and pad images / the last
//     finished output) up to MAX_BLOB each; File objects are structured-
//     cloneable, so a reload restores them silently in any browser.
//   IndexedDB handles — File System Access handles for files ABOVE the blob
//     cap (no data copy); restoring may need one permission click, and only
//     Chromium can mint them. Everything else falls back to a "drop it
//     again" hint carrying the remembered identity.
//
// Every entry point is failure-tolerant (private mode, quota, no IDB): a
// throw degrades to "no persistence", never to a broken app. The pure
// serialize/apply/validate parts are node-tested by check-syzygy-plan.mjs.

const LS_SETTINGS = 'syzygy-session-v1';
const LS_SOUND = 'syzygy-sound-v1';
const LS_STATUS = 'syzygy-status-v1';

/** Per-file cap for storing the bytes themselves (handles cover bigger). */
export const MAX_BLOB = 512 * 1024 * 1024;

// ── settings (pure serialize/apply — node-testable) ─────────────────────

const ALIGN_MODES = ['zero', 'meta', 'sound', 'manual'];
const AUDIO_MODES = ['auto', 'transcode', 'copy'];
const VIDEO_MODES = ['auto', 'reencode'];
const PRESETS = ['ultrafast', 'veryfast', 'fast', 'medium'];
const PAD_MODES = ['adjacent', 'time', 'image'];

function num(v, def, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

/** State → a plain, versioned settings object (no Files, no DOM). */
export function serializeSettings(state) {
  return {
    v: 1,
    align: state.align,
    manualOffset: state.manualOffset,
    adjust: state.adjust,
    trimStart: !!state.trimStart,
    trimEnd: !!state.trimEnd,
    keepVideoAudio: !!state.keepVideoAudio,
    audioMode: state.audioMode,
    videoMode: state.videoMode,
    crf: state.crf,
    preset: state.preset,
    testStart: state.testStart,
    testLen: state.testLen,
    pad: {
      lead: { mode: state.pad.lead.mode, time: state.pad.lead.time },
      tail: { mode: state.pad.tail.mode, time: state.pad.tail.time },
    },
  };
}

/** Validated merge of a stored settings object into state. */
export function applySettings(state, s) {
  if (!s || s.v !== 1) return false;
  state.align = ALIGN_MODES.includes(s.align) ? s.align : 'zero';
  state.manualOffset = num(s.manualOffset, 0, -360000, 360000);
  state.adjust = num(s.adjust, 0, -360000, 360000);
  state.trimStart = !!s.trimStart;
  state.trimEnd = !!s.trimEnd;
  state.keepVideoAudio = !!s.keepVideoAudio;
  state.audioMode = AUDIO_MODES.includes(s.audioMode) ? s.audioMode : 'auto';
  state.videoMode = VIDEO_MODES.includes(s.videoMode) ? s.videoMode : 'auto';
  state.crf = num(s.crf, 17, 0, 35);
  state.preset = PRESETS.includes(s.preset) ? s.preset : 'veryfast';
  state.testStart = s.testStart == null ? null : num(s.testStart, 0, 0, 360000);
  state.testLen = num(s.testLen, 4, 1, 30);
  for (const side of ['lead', 'tail']) {
    const p = s.pad?.[side] || {};
    state.pad[side].mode = PAD_MODES.includes(p.mode) ? p.mode : 'adjacent';
    state.pad[side].time = num(p.time, 0, 0, 360000);
    // a persisted 'image' mode without its restored image is meaningless
    if (state.pad[side].mode === 'image' && !state.pad[side].file) state.pad[side].mode = 'adjacent';
  }
  return true;
}

/** Identity of a picked file — enough to recognize "the same file again". */
export function fileKeyOf(file) {
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

/** Stable key for a video+audio pair (scopes the sound match / results). */
export function pairKey(videoKey, audioKey) {
  const part = (k) => k ? `${k.name}|${k.size}|${k.lastModified}` : '?';
  return `${part(videoKey)}::${part(audioKey)}`;
}

// ── localStorage tier ───────────────────────────────────────────────────

function lsSet(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* full/blocked */ }
}
function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export function saveSettings(state) { lsSet(LS_SETTINGS, serializeSettings(state)); }
export function loadSettings() { return lsGet(LS_SETTINGS); }

export function saveSound(sound, key) { lsSet(LS_SOUND, sound ? { sound, key } : null); }
export function loadSound() { return lsGet(LS_SOUND); }

/** 'running' while a render is in flight; { doneAt } after; null idle. */
export function saveRunStatus(s) { lsSet(LS_STATUS, s); }
export function loadRunStatus() { return lsGet(LS_STATUS); }

// ── IndexedDB tier ──────────────────────────────────────────────────────

let dbPromise = null;
function idb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('syzygy', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (err) { rej(err); }
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function kv(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
const kvGet = (k) => kv('readonly', (s) => s.get(k));
const kvPut = (k, v) => kv('readwrite', (s) => s.put(v, k));
const kvDel = (k) => kv('readwrite', (s) => s.delete(k));

/**
 * Remember a picked file: identity always, bytes when small enough, a
 * FileSystem handle (no copy) when provided. Fire-and-forget friendly.
 * @param {'video'|'audio'|'padLead'|'padTail'} slot
 * @param {File} file
 * @param {?FileSystemFileHandle} handle
 */
export async function saveFile(slot, file, handle) {
  const meta = { key: fileKeyOf(file), hasBlob: file.size <= MAX_BLOB, hasHandle: !!handle };
  await kvPut(`meta:${slot}`, meta);
  if (meta.hasBlob) await kvPut(`blob:${slot}`, file);
  else await kvDel(`blob:${slot}`);
  if (handle) await kvPut(`handle:${slot}`, handle);
  else await kvDel(`handle:${slot}`);
}

/**
 * @returns {Promise<?{key:object, file:?File, handle:?FileSystemFileHandle}>}
 */
export async function loadFile(slot) {
  const meta = await kvGet(`meta:${slot}`).catch(() => null);
  if (!meta) return null;
  const out = { key: meta.key, file: null, handle: null };
  if (meta.hasBlob) out.file = (await kvGet(`blob:${slot}`).catch(() => null)) || null;
  if (!out.file && meta.hasHandle) out.handle = (await kvGet(`handle:${slot}`).catch(() => null)) || null;
  return out;
}

export async function clearFile(slot) {
  await Promise.all([kvDel(`meta:${slot}`), kvDel(`blob:${slot}`), kvDel(`handle:${slot}`)]).catch(() => {});
}

/** Persist the last finished output (bytes only under the cap). */
export async function saveResult(meta, blob) {
  await kvPut('result:meta', { ...meta, blobStored: !!blob && blob.size <= MAX_BLOB, doneAt: Date.now() });
  if (blob && blob.size <= MAX_BLOB) await kvPut('result:blob', blob);
  else await kvDel('result:blob');
}

export async function loadResult() {
  const meta = await kvGet('result:meta').catch(() => null);
  if (!meta) return null;
  const blob = meta.blobStored ? (await kvGet('result:blob').catch(() => null)) : null;
  return { meta, blob };
}

export async function clearResult() {
  await Promise.all([kvDel('result:meta'), kvDel('result:blob')]).catch(() => {});
}

// ── probe cache (skip re-probing / keyframe-scanning known files) ───────

const LS_PROBES = 'syzygy-probes-v1';
const PROBE_CACHE_MAX = 8;

const probeKeyStr = (k) => `${k.name}|${k.size}|${k.lastModified}`;

/** Cached stream summaries / keyframe scans for a file identity, or null. */
export function cachedProbe(fileKey) {
  const map = lsGet(LS_PROBES);
  return map?.[probeKeyStr(fileKey)] || null;
}

/**
 * Merge probe data for a file into the cache (LRU-capped). `data` may hold
 * `video`/`audio` stream summaries (path stripped by the caller) and/or a
 * `kf` map of trim-target → nearest-keyframe results.
 */
export function saveProbe(fileKey, data) {
  const map = lsGet(LS_PROBES) || {};
  const key = probeKeyStr(fileKey);
  const prev = map[key] || {};
  delete map[key]; // re-insert at the end = most recently used
  map[key] = { ...prev, ...data, kf: { ...(prev.kf || {}), ...(data.kf || {}) } };
  const keys = Object.keys(map);
  while (keys.length > PROBE_CACHE_MAX) delete map[keys.shift()];
  lsSet(LS_PROBES, map);
}

// ── decoded-audio cache (analysis PCM for both soundtracks) ─────────────
// Sound alignment decodes each soundtrack to low-rate mono PCM — minutes of
// engine time for long files. The decoded audio is a pure function of the
// file bytes + decode params, so it's cached in IndexedDB (packed to Int16,
// which round-trips losslessly — the decode itself was s16) keyed by file
// identity, and recalled instantly on any later analysis.

const PCM_INDEX = 'pcm:index';
const PCM_CACHE_MAX = 6;
/** Entries above this are not worth the storage (≈30 min @ 2 kHz s16 ×2). */
export const PCM_MAX_BYTES = 16 * 1024 * 1024;

export function pcmKeyOf(fileKey, { rate, ss = 0, t = 0 }) {
  return `pcm:${probeKeyStr(fileKey)}:${rate}:${Math.round(ss * 1000)}:${Math.round(t * 1000)}`;
}

/** Float32 [-1,1] → Int16, exact inverse of the s16 decode's /32768. */
export function f32ToI16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32768)));
  }
  return i16;
}

export function i16ToF32(i16) {
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

export async function savePcm(key, f32) {
  if (f32.length * 2 > PCM_MAX_BYTES) return;
  await kvPut(key, new Blob([f32ToI16(f32).buffer]));
  const idx = ((await kvGet(PCM_INDEX).catch(() => null)) || []).filter((k) => k !== key);
  idx.push(key);
  while (idx.length > PCM_CACHE_MAX) await kvDel(idx.shift()).catch(() => {});
  await kvPut(PCM_INDEX, idx);
}

/** @returns {Promise<?Float32Array>} */
export async function loadPcm(key) {
  const blob = await kvGet(key).catch(() => null);
  if (!blob) return null;
  try {
    return i16ToF32(new Int16Array(await blob.arrayBuffer()));
  } catch {
    return null;
  }
}

async function clearPcm() {
  const idx = (await kvGet(PCM_INDEX).catch(() => null)) || [];
  await Promise.all(idx.map((k) => kvDel(k))).catch(() => {});
  await kvDel(PCM_INDEX).catch(() => {});
}

// ── segmented-render checkpoints ────────────────────────────────────────

/**
 * Stable identity for a segmented render job: same files + same video-
 * affecting parameters → same key → finished segments are reusable.
 * Audio-only options (audioMode, keepVideoAudio) are deliberately excluded —
 * they only shape the final stitch pass. Pure djb2-style hash, node-tested.
 */
export function jobKeyOf(parts) {
  const s = JSON.stringify(parts);
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = (h2 * 31) ^ c;
  }
  return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36);
}

export async function saveJob(meta) { await kvPut('job:meta', meta); }
export async function loadJob() { return kvGet('job:meta').catch(() => null); }

export async function saveSegment(jobKey, index, blob) {
  await kvPut(`seg:${jobKey}:${index}`, blob);
}
export async function loadSegment(jobKey, index) {
  return kvGet(`seg:${jobKey}:${index}`).catch(() => null);
}

/** Drop a job and every segment it may have written. */
export async function clearJob(meta) {
  const m = meta || await loadJob();
  if (m?.key && m?.total) {
    await Promise.all(Array.from({ length: m.total }, (_, i) => kvDel(`seg:${m.key}:${i}`))).catch(() => {});
  }
  await kvDel('job:meta').catch(() => {});
}

/** Forget everything — settings, files, results, checkpoints, caches. */
export async function clearAll() {
  try {
    localStorage.removeItem(LS_SETTINGS);
    localStorage.removeItem(LS_SOUND);
    localStorage.removeItem(LS_STATUS);
    localStorage.removeItem(LS_PROBES);
  } catch { /* blocked */ }
  await Promise.all([
    ...['video', 'audio', 'padLead', 'padTail'].map((s) => clearFile(s)),
    clearResult(),
    clearJob(),
    clearPcm(),
  ]).catch(() => {});
}
