// IndexedDB store for setlist songs, notes, and setlists.
// Follows the looper-store.js pattern: lazy singleton, tx() helper, async CRUD.

const DB_NAME = 'voidstar.setlist';
const DB_VERSION = 1;
const SONGS = 'songs';
const NOTES = 'notes';
const SETLISTS = 'setlists';

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

async function put(storeName, record) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.put(record);
  await done;
}

async function del(storeName, id) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.delete(id);
  await done;
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
    source,
  };
}

export const putNote = (note) => put(NOTES, note);
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

// ── Merge helper ──

export function mergedSong(song, setlist) {
  if (!setlist?.songOverrides?.[song.id]) return song;
  const ov = setlist.songOverrides[song.id];
  return { ...song, ...ov, _origKey: song.key, _origSteelEntry: song.steelEntry };
}

// ── Export / Import ──

export async function exportAll() {
  const [songs, notes, setlists] = await Promise.all([
    getAllSongs(), getAllNotes(), getAllSetlists(),
  ]);
  const sources = getSourcesRaw();
  return { version: 1, songs, notes, setlists, sources, exportedAt: Date.now() };
}

export async function importAll(data) {
  if (data.songs) for (const s of data.songs) await put(SONGS, s);
  if (data.notes) for (const n of data.notes) await put(NOTES, n);
  if (data.setlists) for (const sl of data.setlists) await put(SETLISTS, sl);
  if (data.sources) setSourcesRaw(data.sources);
}

export async function exportSetlist(setlistId) {
  const sl = await getSetlist(setlistId);
  if (!sl) return null;
  const songIds = sl.sets.flatMap(s => s.songIds);
  const songs = (await Promise.all(songIds.map(id => getSong(id)))).filter(Boolean);
  const noteArrays = await Promise.all(songIds.map(id => getNotesForSong(id)));
  const notes = noteArrays.flat();
  return { version: 1, type: 'setlist', setlist: sl, songs, notes, exportedAt: Date.now() };
}

export async function exportSong(songId) {
  const song = await getSong(songId);
  if (!song) return null;
  const notes = await getNotesForSong(songId);
  return { version: 1, type: 'song', song, notes, exportedAt: Date.now() };
}

export async function exportSources() {
  return { version: 1, type: 'sources', sources: getSourcesRaw(), exportedAt: Date.now() };
}

export async function importSetlist(data) {
  if (data.setlist) await put(SETLISTS, data.setlist);
  if (data.songs) for (const s of data.songs) await put(SONGS, s);
  if (data.notes) for (const n of data.notes) await put(NOTES, n);
}

export async function importSong(data) {
  if (data.song) await put(SONGS, data.song);
  if (data.notes) for (const n of data.notes) await put(NOTES, n);
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

export async function getNotesForSongBulk(songIds) {
  const allNotes = await getAllNotes();
  const map = {};
  for (const n of allNotes) {
    if (!map[n.songId]) map[n.songId] = [];
    map[n.songId].push(n);
  }
  return map;
}
