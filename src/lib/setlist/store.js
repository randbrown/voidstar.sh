// IndexedDB store for setlist songs, notes, and setlists.
// Follows the looper-store.js pattern: lazy singleton, tx() helper, async CRUD.

const DB_NAME = 'voidstar.setlist';
const DB_VERSION = 4;
const SONGS = 'songs';
const NOTES = 'notes';
const SETLISTS = 'setlists';
const ANNOTATIONS = 'annotations';
// Cached chart images (Blobs) keyed by songId, for offline perform mode.
// Local-only: derivable from the chart URL, so never included in the Google
// Drive JSON sync (that stays lean, data-only).
const CHARTS = 'charts';
// Pre-sync/pre-import safety snapshots of the whole dataset, keyed by
// timestamp. A rolling buffer (see pruneSnapshots) so a bad restore/sync can
// be undone. Local-only and derived from the live data, so — like CHARTS —
// it is NEVER included in exportAll() (would recurse the whole backup file).
const SNAPSHOTS = 'snapshots';

let _dbPromise = null;

export function isAvailable() {
  try { return typeof indexedDB !== 'undefined'; } catch { return false; }
}

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SONGS)) {
        const s = db.createObjectStore(SONGS, { keyPath: 'id' });
        s.createIndex('by-title', 'title', { unique: false });
      }
      if (!db.objectStoreNames.contains(NOTES)) {
        const n = db.createObjectStore(NOTES, { keyPath: 'id' });
        n.createIndex('by-song', 'songId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SETLISTS)) {
        const sl = db.createObjectStore(SETLISTS, { keyPath: 'id' });
        sl.createIndex('by-name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains(ANNOTATIONS)) {
        db.createObjectStore(ANNOTATIONS, { keyPath: 'songId' });
      }
      if (!db.objectStoreNames.contains(CHARTS)) {
        db.createObjectStore(CHARTS, { keyPath: 'songId' });
      }
      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        db.createObjectStore(SNAPSHOTS, { keyPath: 'ts' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function tx(storeName, mode) {
  const db = await openDb();
  const t = db.transaction(storeName, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onabort = t.onerror = () => rej(t.error);
  });
  return { store: t.objectStore(storeName), done };
}

async function getAll(storeName) {
  const { store, done } = await tx(storeName, 'readonly');
  const all = await new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
  await done.catch(() => {});
  return all;
}

async function getOne(storeName, id) {
  const { store, done } = await tx(storeName, 'readonly');
  const rec = await new Promise((res, rej) => {
    const req = store.get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
  await done.catch(() => {});
  return rec;
}

let _onWrite = null;
export function setOnWrite(fn) { _onWrite = fn; }

async function put(storeName, record) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.put(record);
  await done;
  _onWrite?.();
}

async function del(storeName, id) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.delete(id);
  await done;
  _onWrite?.();
}

// Silent variants — write without firing _onWrite (used for the local-only
// chart image cache, which must not kick off a Google Drive data push).
async function putSilent(storeName, record) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.put(record);
  await done;
}

async function delSilent(storeName, id) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.delete(id);
  await done;
}

async function clearStore(storeName) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.clear();
  await done;
}

async function getAllKeys(storeName) {
  const { store, done } = await tx(storeName, 'readonly');
  const keys = await new Promise((res, rej) => {
    const req = store.getAllKeys();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
  await done.catch(() => {});
  return keys;
}

// ── Songs ──

export function createSong(title, artist = '') {
  return {
    id: crypto.randomUUID(),
    title,
    artist,
    key: '',
    bpm: 0,
    capo: 0,
    keyChanges: '',
    steelEntry: '',
    spotifyUri: '',
    chartUrl: '',
    lyrics: '',
    syncedLyrics: '', // LRC text ("[mm:ss.xx] line") when LRCLIB has it
    genre: '',
    year: 0,
    durationSec: 0,
    artworkUrl: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export const putSong = (song) => put(SONGS, { ...song, updatedAt: Date.now() });
export const getSong = (id) => getOne(SONGS, id);
export const getAllSongs = () => getAll(SONGS);
export const deleteSong = (id) => del(SONGS, id);

export async function findSongByTitle(title) {
  const all = await getAllSongs();
  const lower = title.toLowerCase().trim();
  return all.find(s => s.title.toLowerCase().trim() === lower) || null;
}

// ── Notes ──

export function createNote(songId, text, source = 'typed') {
  return {
    id: crypto.randomUUID(),
    songId,
    text,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source,
  };
}

export const putNote = (note) => put(NOTES, { ...note, updatedAt: Date.now() });
export const deleteNote = (id) => del(NOTES, id);

export async function getNotesForSong(songId) {
  const { store, done } = await tx(NOTES, 'readonly');
  const idx = store.index('by-song');
  const notes = await new Promise((res, rej) => {
    const req = idx.getAll(songId);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
  await done.catch(() => {});
  notes.sort((a, b) => a.createdAt - b.createdAt);
  return notes;
}

export async function getAllNotes() {
  return getAll(NOTES);
}

// ── Setlists ──

export function createSetlist(name) {
  return {
    id: crypto.randomUUID(),
    name,
    sets: [{ name: 'Set 1', songIds: [] }],
    gigDate: '',
    venue: '',
    spotifyUrl: '',
    vocalistLegend: {},
    songOverrides: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export const putSetlist = (sl) => put(SETLISTS, { ...sl, updatedAt: Date.now() });
export const getSetlist = (id) => getOne(SETLISTS, id);
export const getAllSetlists = () => getAll(SETLISTS);
export const deleteSetlist = (id) => del(SETLISTS, id);

// ── Annotations (hand-drawn chart markup, keyed by songId) ──

export const putAnnotation = (ann) => put(ANNOTATIONS, { ...ann, updatedAt: Date.now() });
export const getAnnotation = (songId) => getOne(ANNOTATIONS, songId);
export const getAllAnnotations = () => getAll(ANNOTATIONS);
export const deleteAnnotation = (songId) => del(ANNOTATIONS, songId);

// ── Cached chart images (offline) ──

export const putChartBlob = (songId, blob, sourceUrl) =>
  putSilent(CHARTS, {
    songId, blob, sourceUrl,
    mimeType: blob.type || '',
    size: blob.size || 0,
    fetchedAt: Date.now(),
  });
export const getChartBlob = (songId) => getOne(CHARTS, songId);
export const deleteChartBlob = (songId) => delSilent(CHARTS, songId);
export const getCachedChartIds = () => getAllKeys(CHARTS);

// ── Safety snapshots (undo a restore/sync) ──
// A rolling buffer of full-dataset snapshots, taken right before any operation
// that overwrites local data (a Drive restore/sync or a file import). All
// writes are SILENT (putSilent/delSilent) so snapshotting never itself
// schedules a Drive push.

const SNAPSHOT_KEEP = 10;

// Capture the current dataset as a snapshot, then prune to the newest N.
export async function putSnapshot(label = '') {
  const ts = Date.now();
  await putSilent(SNAPSHOTS, { ts, label, data: await exportAll() });
  await pruneSnapshots(SNAPSHOT_KEEP);
  return ts;
}

// Metadata only (ts + label), newest first — avoids loading every full payload
// just to render a list.
export async function listSnapshots() {
  const all = await getAll(SNAPSHOTS);
  return all
    .map(({ ts, label }) => ({ ts, label }))
    .sort((a, b) => b.ts - a.ts);
}

export const getSnapshot = (ts) => getOne(SNAPSHOTS, ts);

export async function pruneSnapshots(keep = SNAPSHOT_KEEP) {
  const keys = (await getAllKeys(SNAPSHOTS)).sort((a, b) => a - b); // oldest first
  for (let i = 0; i < keys.length - keep; i++) {
    await delSilent(SNAPSHOTS, keys[i]);
  }
}

// Restore a snapshot. Snapshots the current state first so the restore is
// itself reversible, then imports the chosen snapshot (importAll fires the
// write hook, so the reverted state propagates to Drive on the next push).
export async function restoreSnapshot(ts) {
  const snap = await getSnapshot(ts);
  if (!snap) return false;
  await putSnapshot('pre-undo');
  await replaceAll(snap.data);
  return true;
}

// ── Merge helper ──

export function mergedSong(song, setlist) {
  if (!setlist?.songOverrides?.[song.id]) return song;
  const ov = setlist.songOverrides[song.id];
  return { ...song, ...ov, _origKey: song.key, _origSteelEntry: song.steelEntry };
}

// ── Export / Import ──

export async function exportAll() {
  // NOTE: deliberately omits the CHARTS blob cache and the SNAPSHOTS store.
  // Both are local-only and derived from this data; including SNAPSHOTS in
  // particular would recurse the whole backup into every snapshot. Keep this
  // list to the canonical, user-authored stores only.
  const [songs, notes, setlists, annotations] = await Promise.all([
    getAllSongs(), getAllNotes(), getAllSetlists(), getAllAnnotations(),
  ]);
  const sources = getSourcesRaw();
  const settings = getSettingsRaw();
  return { version: 1, songs, notes, setlists, annotations, sources, settings, exportedAt: Date.now() };
}

export async function importAll(data) {
  if (data.songs) for (const s of data.songs) await put(SONGS, s);
  if (data.notes) for (const n of data.notes) await put(NOTES, n);
  if (data.setlists) for (const sl of data.setlists) await put(SETLISTS, sl);
  if (data.annotations) for (const a of data.annotations) await put(ANNOTATIONS, a);
  if (data.sources) setSourcesRaw(data.sources);
  if (data.settings) applySettingsRaw(data.settings);
}

// Full REPLACE (not a merge): clear the user-data stores, then load `data`.
// importAll only upserts, so it can't reproduce deletions — a snapshot "undo"
// or explicit version restore needs this to reproduce an exact prior state.
// The final put()s fire _onWrite, so the reverted state propagates to Drive.
export async function replaceAll(data) {
  await clearStore(SONGS);
  await clearStore(NOTES);
  await clearStore(SETLISTS);
  await clearStore(ANNOTATIONS);
  await importAll(data);
}

export async function exportSetlist(setlistId) {
  const sl = await getSetlist(setlistId);
  if (!sl) return null;
  const songIds = sl.sets.flatMap(s => s.songIds);
  const songs = (await Promise.all(songIds.map(id => getSong(id)))).filter(Boolean);
  const noteArrays = await Promise.all(songIds.map(id => getNotesForSong(id)));
  const notes = noteArrays.flat();
  const annotations = (await Promise.all(songIds.map(id => getAnnotation(id)))).filter(Boolean);
  return { version: 1, type: 'setlist', setlist: sl, songs, notes, annotations, exportedAt: Date.now() };
}

export async function exportSong(songId) {
  const song = await getSong(songId);
  if (!song) return null;
  const notes = await getNotesForSong(songId);
  const annotation = await getAnnotation(songId);
  return { version: 1, type: 'song', song, notes, annotation: annotation || null, exportedAt: Date.now() };
}

export async function exportSources() {
  return { version: 1, type: 'sources', sources: getSourcesRaw(), exportedAt: Date.now() };
}

export async function importSetlist(data) {
  if (data.setlist) await put(SETLISTS, data.setlist);
  if (data.songs) for (const s of data.songs) await put(SONGS, s);
  if (data.notes) for (const n of data.notes) await put(NOTES, n);
  if (data.annotations) for (const a of data.annotations) await put(ANNOTATIONS, a);
}

export async function importSong(data) {
  if (data.song) await put(SONGS, data.song);
  if (data.notes) for (const n of data.notes) await put(NOTES, n);
  if (data.annotation) await put(ANNOTATIONS, data.annotation);
}

export async function importSources(data) {
  if (data.sources) setSourcesRaw(data.sources);
}

function getSourcesRaw() {
  try { return JSON.parse(localStorage.getItem('voidstar.setlist.sources')) || {}; }
  catch { return {}; }
}

function setSourcesRaw(sources) {
  localStorage.setItem('voidstar.setlist.sources', JSON.stringify(sources));
}

// ── Cross-device settings (identity/config that should follow the user) ──
// OAuth *client ids* are public identifiers, not secrets, so they ride the
// Drive backup — a new device inherits them instead of re-entering by hand.
// Tokens never ride the backup; per-device prefs (chart appearance, enhance)
// stay local on purpose.
const SETTINGS_KEYS = {
  gdriveClientId: 'voidstar.setlist.gdrive.clientId',
  spotifyClientId: 'voidstar.setlist.spotify.clientId',
};

function getSettingsRaw() {
  const out = {};
  for (const [name, key] of Object.entries(SETTINGS_KEYS)) {
    const v = localStorage.getItem(key);
    if (v) out[name] = v;
  }
  return out;
}

// Fill-empty apply: a backed-up value never overwrites one this device
// already has — local stays authoritative, the backup bootstraps blanks.
function applySettingsRaw(settings) {
  for (const [name, key] of Object.entries(SETTINGS_KEYS)) {
    if (settings[name] && !localStorage.getItem(key)) {
      localStorage.setItem(key, settings[name]);
    }
  }
}
