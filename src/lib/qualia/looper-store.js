// Minimal IndexedDB store for recorded loop tracks so they survive a reload.
// One object store keyed by track id; each record holds the mono PCM
// (Float32Array, structured-cloned) plus loop geometry + per-track settings.
// AudioBuffers aren't serialisable, so we store raw PCM and rebuild on load.
//
// Record shape:
//   { id, order, pcm: Float32Array, sampleRate, regionFrames, loopStartBase,
//     naturalSeconds, recordedCycles, grid, length, volume, muted, preservePitch }

const DB_NAME = 'voidstar.qualia.looper';
const DB_VERSION = 1;
const STORE = 'tracks';

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
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('order', 'order', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

// Resolve to { store, done } for a fresh transaction. The caller must use
// `store` synchronously (no awaits before the first request) so the
// transaction doesn't auto-commit.
async function tx(mode) {
  const db = await openDb();
  const t = db.transaction(STORE, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onabort = t.onerror = () => rej(t.error);
  });
  return { store: t.objectStore(STORE), done };
}

export async function putTrack(record) {
  const { store, done } = await tx('readwrite');
  store.put(record);
  await done;
}

export async function deleteTrack(id) {
  const { store, done } = await tx('readwrite');
  store.delete(id);
  await done;
}

export async function clearAll() {
  const { store, done } = await tx('readwrite');
  store.clear();
  await done;
}

export async function getAllTracks() {
  const { store, done } = await tx('readonly');
  const all = await new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
  await done.catch(() => {});
  all.sort((a, b) => (a.order || 0) - (b.order || 0));
  return all;
}
