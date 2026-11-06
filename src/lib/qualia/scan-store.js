// Scan store — keeps the last scan file the Scan quale loaded in IndexedDB so
// it survives a reload (`file` params are session-only File objects). One
// record: the original file bytes + name; the point cloud is re-derived from
// them (deterministically) on load.

const DB_NAME = 'voidstar.qualia.scan';
const DB_VERSION = 1;
const STORE = 'files';
const LAST = 'last';
// A splat PLY of a whole room can run to hundreds of MB; don't try to persist
// those — they still work for the session.
const MAX_BYTES = 150 * 1024 * 1024;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

/** @returns {Promise<{name: string, bytes: ArrayBuffer}|null>} */
export async function loadLastScan() {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(LAST);
      req.onsuccess = () => resolve(req.result ? { name: req.result.name, bytes: req.result.bytes } : null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

/** Forget the saved scan (the performer cleared the file). */
export async function clearLastScan() {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(LAST);
  } catch { /* nothing saved / storage unavailable */ }
}

/** Fire-and-forget; failures (quota, private mode) only cost persistence. */
export async function saveLastScan(name, bytes) {
  if (!bytes || bytes.byteLength > MAX_BYTES) return;
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ id: LAST, name, bytes, savedAt: Date.now() });
  } catch (e) {
    console.warn('[qualia] scan: could not persist scan', e);
  }
}
