// Google Drive sync for mind — forked from setlist/gdrive-backup.js with the
// setlist-specific pieces removed (chart docs) and two additions:
//   - conflict copies: concurrent edits to the same note body on two devices
//     resolve last-write-wins, with the losing body preserved as a visible
//     "Conflicted copy of …" note (nothing is ever silently lost)
//   - attachment binaries: client methods to upload/download/trash individual
//     attachment files in a dedicated Drive folder (metadata rides the JSON;
//     binaries lazy-fetch per device — see attachments-drive.js)
//
// Auth = Google Identity Services token client, drive.file scope (only files
// this app creates), app-owned OAuth client ID by default (user override
// possible), token cached ~1h.

import { NOTE_FILL_FIELDS, ATTACHMENT_FILL_FIELDS } from './store.js';
import { GOOGLE_CLIENT_ID } from '../qualia/google-config.js';
import {
  splitIntoShards, emptyShard, hashShard, hashIndex, shardName, parseShardName,
  mergeById, mergeShardData, mergeIndexData, computeDelta, isEmptyDelta,
  DEFAULT_SHARD_COUNT, SCHEMA_VERSION, bucket,
} from './shard.js';

// Full-dataset merge lives in shard.js now; re-exported for any external caller.
export { mergeData } from './shard.js';

const NS = 'voidstar.mind.gdrive';
const CLIENT_ID_KEY = `${NS}.clientId`;
const TOKEN_KEY = `${NS}.token`;
const LAST_BACKUP_KEY = `${NS}.lastBackupAt`;
const DEVICE_NAME_KEY = `${NS}.deviceName`;
// Legacy single-file layout (pre-sharding). Still READ during migration and
// while an old-code device keeps writing it, but never written by this version.
const FILE_NAME = 'voidstar-mind-data.json';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

// Everything lives under ONE top-level folder in My Drive (voidstar_mind),
// with index.json + shards/ + attachments/ + backups/ inside it.
const ROOT_FOLDER_NAME = 'voidstar_mind';
const ROOT_FOLDER_ID_KEY = `${NS}.rootFolderId`;
// Set once the legacy scattered layout has been re-homed under the root folder.
const CONSOLIDATED_KEY = `${NS}.consolidated`;
// Set once this device has folded any duplicate top-level voidstar_mind
// folders into one (one-time forced heal — see healRootFoldersOnce).
const ROOT_HEALED_KEY = `${NS}.rootHealed`;

const BACKUPS_FOLDER_NAME = 'backups';
const BACKUPS_FOLDER_ID_KEY = `${NS}.backupsFolderId`;
const ATTACH_FOLDER_NAME = 'attachments';
const ATTACH_FOLDER_ID_KEY = `${NS}.attachFolderId`;
// Pre-consolidation root-level object names, migrated into the root folder on
// first sync (the data file was a loose root file; these two were root folders).
const LEGACY_ATTACH_FOLDER_NAME = 'voidstar mind attachments';
const LEGACY_BACKUPS_FOLDER_NAME = 'voidstar mind backups';
const HISTORY_PREFIX = 'voidstar-mind-data-'; // + <ISO>.json
const LAST_HISTORY_KEY = `${NS}.lastHistoryAt`;
const HISTORY_KEEP = 10;
const HISTORY_MIN_INTERVAL_MS = 10 * 60 * 1000;

// ── Sharded layout: index.json (global) + shards/shard-NNN.json (bucketed) ──
const SHARDS_FOLDER_NAME = 'shards';
const SHARDS_FOLDER_ID_KEY = `${NS}.shardsFolderId`;
const INDEX_FILE_NAME = 'index.json';
// Per-file remote state: { files: { "<name>": {id, mtime, hash} }, foldStamp }.
// `hash` = the content we KNOW is on remote for that file (so a pure pull never
// triggers a redundant re-upload); `foldStamp` = the legacy monolith's last
// folded modifiedTime. Persisted so an interrupted cycle recovers correctly.
const SHARD_STATE_KEY = `${NS}.shardState`;
// Which shard files changed locally since the last push, so push re-hashes only
// those instead of the whole dataset: { all, buckets:[…], index }. `all` (or an
// absent key = first run on this version) means "re-hash everything", the safe
// default. Persisted so an interrupted session's pending shards survive.
const DIRTY_SHARDS_KEY = `${NS}.dirtyShards`;

// ── Freshness bookkeeping (see setlist fork for the full rationale) ──
const DIRTY_KEY = `${NS}.dirtyAt`;
// Stamp of this device's last COMPLETED cycle — the conflict detector's
// baseline: edits on both sides newer than this = a real concurrent fork.
const LAST_CYCLE_KEY = `${NS}.lastCycleAt`;

function markLocalDirty() { try { localStorage.setItem(DIRTY_KEY, String(Date.now())); } catch {} }
function getDirtyStamp() { return localStorage.getItem(DIRTY_KEY) || ''; }
export function isLocalDirty() { return !!getDirtyStamp(); }
function clearDirtyIf(stamp) { if (getDirtyStamp() === stamp) localStorage.removeItem(DIRTY_KEY); }
export function getLastCycleAt() { return parseInt(localStorage.getItem(LAST_CYCLE_KEY) || '0', 10); }
function setLastCycleAt(ts) { localStorage.setItem(LAST_CYCLE_KEY, String(ts)); }

// ── Per-file remote state (shard/index modifiedTime + content hash) ──
function getShardState() {
  try { const s = JSON.parse(localStorage.getItem(SHARD_STATE_KEY)); if (s && s.files) return s; } catch {}
  return { files: {}, foldStamp: '' };
}
function saveShardState(state) { try { localStorage.setItem(SHARD_STATE_KEY, JSON.stringify(state)); } catch {} }
// Merge one file's {id,mtime,hash} in-place and persist immediately (crash-safe:
// a stamp is only ever written AFTER the corresponding upload/import succeeded).
function setFileState(name, entry) {
  const s = getShardState();
  s.files[name] = { ...s.files[name], ...entry };
  saveShardState(s);
}
function clearFileHash(name) {
  const s = getShardState();
  if (s.files[name]) { delete s.files[name].hash; saveShardState(s); }
}

// ── Dirty-shard tracking (which shards to re-hash on the next push) ──
const SHARD_STORES = new Set(['notes', 'tasks', 'attachments', 'annotations']);
const INDEX_STORES = new Set(['folders', 'tasklists']);

function getDirtyShards() {
  try {
    const d = JSON.parse(localStorage.getItem(DIRTY_SHARDS_KEY));
    if (d && Array.isArray(d.buckets)) return { all: !!d.all, buckets: d.buckets, index: !!d.index };
  } catch {}
  return { all: true, buckets: [], index: true }; // uninitialized → hash everything once
}
function saveDirtyShards(d) {
  try { localStorage.setItem(DIRTY_SHARDS_KEY, JSON.stringify(d)); } catch {}
}

// Called from the store write hook (via app.js) for every mutation. A write with
// no key (blanket: tombstone purge, snapshot restore) marks ALL — the safe
// superset. Blobs/snapshots never reach here (silent writes fire no hook).
export function markShardDirty(info) {
  const d = getDirtyShards();
  if (!info || info.key == null) { d.all = true; saveDirtyShards(d); return; }
  if (SHARD_STORES.has(info.store)) {
    const b = bucket(info.key, DEFAULT_SHARD_COUNT);
    if (!d.buckets.includes(b)) { d.buckets.push(b); saveDirtyShards(d); }
  } else if (INDEX_STORES.has(info.store)) {
    if (!d.index) { d.index = true; saveDirtyShards(d); }
  }
}
export function markIndexDirty() {
  const d = getDirtyShards();
  if (!d.index) { d.index = true; saveDirtyShards(d); }
}

// Read-and-clear the set for a push; requeue (union) on failure so nothing is
// lost. Writes that land DURING a push repopulate the freshly-cleared set and
// so survive to the next push.
function drainDirtyShards() {
  const d = getDirtyShards();
  saveDirtyShards({ all: false, buckets: [], index: false });
  return d;
}
function requeueDirtyShards(snap) {
  const d = getDirtyShards();
  const buckets = new Set(d.buckets);
  for (const b of snap.buckets) buckets.add(b);
  saveDirtyShards({ all: d.all || snap.all, buckets: [...buckets], index: d.index || snap.index });
}

let _gisLoaded = false;

// Prefer a user-entered override (advanced / self-host); otherwise the
// app-owned client id, so "Sign in with Google" works with zero setup.
function getClientId() { return localStorage.getItem(CLIENT_ID_KEY) || GOOGLE_CLIENT_ID; }
export function getClientIdOverride() { return localStorage.getItem(CLIENT_ID_KEY) || ''; }
export function usingAppClientId() { return !localStorage.getItem(CLIENT_ID_KEY) && !!GOOGLE_CLIENT_ID; }
export function setClientId(id) {
  if (id) localStorage.setItem(CLIENT_ID_KEY, id);
  else localStorage.removeItem(CLIENT_ID_KEY); // clearing falls back to the app default
  markIndexDirty(); // the id override rides settings → index.json
}
export function hasClientId() { return !!getClientId(); }

export function getDeviceName() {
  let n = localStorage.getItem(DEVICE_NAME_KEY);
  if (!n) {
    const ua = navigator.userAgent;
    n = /android/i.test(ua) ? 'android'
      : /iphone|ipad/i.test(ua) ? 'ios'
      : /mac/i.test(ua) ? 'mac'
      : /win/i.test(ua) ? 'windows' : 'device';
    localStorage.setItem(DEVICE_NAME_KEY, n);
  }
  return n;
}
export function setDeviceName(n) { if (n) localStorage.setItem(DEVICE_NAME_KEY, n); }

export function isSyncEnabled() { return !!getClientId() && !!getStoredToken(); }
export function needsReconnect() { return !!getClientId() && !getStoredToken(); }
export function disconnect() { localStorage.removeItem(TOKEN_KEY); }

export function getLastBackupTime() {
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  return raw ? parseInt(raw, 10) : null;
}
function setLastBackupTime(ts) { localStorage.setItem(LAST_BACKUP_KEY, String(ts)); }

export function formatLastBackup() {
  const ts = getLastBackupTime();
  if (!ts) return 'never';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

async function loadGis() {
  if (_gisLoaded) return;
  if (document.querySelector('script[src*="accounts.google.com/gsi/client"]')) {
    _gisLoaded = true;
    return;
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = () => { _gisLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
}

function getStoredToken() {
  try {
    const data = JSON.parse(localStorage.getItem(TOKEN_KEY));
    if (data && data.expiresAt > Date.now()) return data.token;
  } catch {}
  return null;
}

function storeToken(token, expiresIn) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    token,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  }));
}

async function getAccessToken({ interactive = true } = {}) {
  const existing = getStoredToken();
  if (existing) return existing;
  // Non-interactive callers must never trigger the OAuth popup (blocked
  // outside a user gesture).
  if (!interactive) return null;

  const clientId = getClientId();
  if (!clientId) throw new Error('Google Drive client ID not configured — set it in settings.');

  await loadGis();

  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        storeToken(response.access_token, parseInt(response.expires_in) || 3600);
        resolve(response.access_token);
      },
      error_callback: (err) => {
        reject(new Error(err.message || err.type || 'Authorization Error'));
      },
    });
    client.requestAccessToken();
  });
}

// Acquire the token NOW, inside a user gesture (mobile popup rules).
export async function ensureDriveAccess() {
  const token = await getAccessToken({ interactive: true });
  if (!token) throw new Error('Google Drive not connected.');
}

// The current Drive access token (for callers like the Drive Picker that need
// to authorize their own requests). Same gesture rules as ensureDriveAccess.
export async function getDriveToken({ interactive = true } = {}) {
  return getAccessToken({ interactive });
}

// ── Drive REST helpers ──

async function findDataFiles(token) {
  const root = await getRootFolderId(token);
  const params = new URLSearchParams({
    q: `name='${FILE_NAME}' and '${root}' in parents and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: '10',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive search failed: ${res.status}`);
  return (await res.json()).files || [];
}

// Data files by name ANYWHERE in Drive (any parent) — used only by the one-time
// migration to find the legacy loose root file before it's moved under the root
// folder. Includes `parents` so re-parenting knows what to remove.
async function findDataFilesAnywhere(token) {
  const params = new URLSearchParams({
    q: `name='${FILE_NAME}' and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name,parents,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: '10',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive search failed: ${res.status}`);
  return (await res.json()).files || [];
}

async function trashFile(token, fileId) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

async function readJsonFile(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive read failed: ${res.status}`);
  return res.json();
}

// Create (multipart) or update (media) a JSON file, returning {id,modifiedTime}.
// One helper for index.json and every shard.
async function uploadJsonFile(token, { name, parentId, fileId, data }) {
  if (fileId) {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Drive file update failed: ${res.status}`);
    return res.json();
  }
  const metadata = { name, mimeType: 'application/json', parents: [parentId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Drive file create failed: ${res.status}`);
  return res.json();
}

// {id,name,modifiedTime} for every non-trashed child of a folder, paginated.
async function listFolderFiles(token, folderId) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,modifiedTime)',
      pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
    const json = await res.json();
    out.push(...(json.files || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return out;
}

// index.json file(s) directly under the root folder (newest first; normally 0–1).
async function findIndexFiles(token) {
  const root = await getRootFolderId(token);
  const params = new URLSearchParams({
    q: `name='${INDEX_FILE_NAME}' and '${root}' in parents and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: '10',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive index search failed: ${res.status}`);
  return (await res.json()).files || [];
}

// Union duplicate shard-file contents by record (newer wins, NO conflict copies —
// this is data-file healing, not a device fork).
function unionShardObjects(list) {
  let acc = emptyShard();
  for (const s of list) {
    if (!s) continue;
    acc = {
      notes: mergeById(acc.notes, s.notes || [], 'id', NOTE_FILL_FIELDS),
      tasks: mergeById(acc.tasks, s.tasks || []),
      attachments: mergeById(acc.attachments, s.attachments || [], 'id', ATTACHMENT_FILL_FIELDS),
      annotations: mergeById(acc.annotations, s.annotations || [], 'key'),
    };
  }
  return acc;
}

const SHARD_COLLS = ['notes', 'tasks', 'attachments', 'annotations'];

// The shards/ subfolder, self-healing like the root folder: if two devices'
// cold-cache first pushes created two shards/ folders, fold the stragglers into
// the oldest (their shard files reparent in, and pullSharded's dup-name heal
// then merges any now-colliding shard-NNN.json). Deterministic survivor so
// devices converge.
async function getShardsFolderId(token) {
  const cached = localStorage.getItem(SHARDS_FOLDER_ID_KEY);
  if (cached) return cached;
  const rootId = await getRootFolderId(token);
  const found = await searchFolders(token, SHARDS_FOLDER_NAME, { parentId: rootId, pageSize: 100, orderBy: 'createdTime' });
  if (!found.length) return findOrCreateFolder(token, SHARDS_FOLDER_NAME, SHARDS_FOLDER_ID_KEY, rootId);
  const sorted = [...found].sort((a, b) =>
    (a.createdTime || '').localeCompare(b.createdTime || '') || a.id.localeCompare(b.id));
  const keep = sorted[0].id;
  for (const dup of sorted.slice(1)) {
    try { await mergeFolderInto(token, dup.id, keep); }
    catch (e) { console.warn('[mind-sync] duplicate shards folder heal deferred:', e.message); }
  }
  localStorage.setItem(SHARDS_FOLDER_ID_KEY, keep);
  return keep;
}

// ── Sharded push / pull / peek (the client's Drive I/O) ──

// Split the dataset into index.json + shards; upload only the files whose content
// hash changed since we last saw them on remote. Persist each file's {id,mtime,
// hash} the instant its own upload succeeds, so a crash mid-push at worst causes
// a redundant re-upload next cycle — never a missed one.
async function pushSharded(token, dataset) {
  const rootId = await getRootFolderId(token);
  const shardsFolderId = await getShardsFolderId(token);
  const { index, shards } = splitIntoShards(dataset, DEFAULT_SHARD_COUNT);
  const uploaded = [];
  const dirty = drainDirtyShards();

  try {
    // index.json — only when folders/tasklists/settings may have changed.
    if (dirty.all || dirty.index) {
      const idxHash = hashIndex(index);
      const cur = getShardState().files[INDEX_FILE_NAME];
      if (cur?.hash !== idxHash) {
        const res = await uploadJsonFile(token, { name: INDEX_FILE_NAME, parentId: rootId, fileId: cur?.id, data: index });
        setFileState(INDEX_FILE_NAME, { id: res.id, mtime: res.modifiedTime || '', hash: idxHash });
        uploaded.push(INDEX_FILE_NAME);
      }
    }

    // Which buckets to (re)hash. `all` (first push / after a blanket write) →
    // every populated bucket plus any tracked shard that may have emptied;
    // otherwise just the buckets marked dirty since the last push. A bucket
    // emptied by deletes is present in `dirty.buckets` but not in `shards`, so it
    // falls back to explicit empty content (stable id, no trash+recreate).
    let buckets;
    if (dirty.all) {
      buckets = new Set(shards.keys());
      for (const name of Object.keys(getShardState().files)) {
        const b = parseShardName(name);
        if (b != null) buckets.add(b);
      }
    } else {
      buckets = new Set(dirty.buckets);
    }

    for (const b of buckets) {
      const name = shardName(b);
      const shard = shards.get(b) || emptyShard();
      const h = hashShard(shard);
      const cur = getShardState().files[name];
      if (cur?.hash !== h) {
        const res = await uploadJsonFile(token, { name, parentId: shardsFolderId, fileId: cur?.id, data: shard });
        setFileState(name, { id: res.id, mtime: res.modifiedTime || '', hash: h });
        uploaded.push(name);
      }
    }
  } catch (e) {
    requeueDirtyShards(dirty); // retry these shards next cycle (uploaded ones no-op via hash)
    throw e;
  }

  return { indexModifiedTime: getShardState().files[INDEX_FILE_NAME]?.mtime || '', uploaded };
}

// Download only the shards whose remote modifiedTime advanced past what we last
// committed; return their records as a PARTIAL remote for the orchestrator to
// merge against FULL local. Never writes IDB and never persists its own stamps —
// it returns commit() for the cycle to call AFTER a successful import (so an
// interrupted cycle re-pulls rather than skipping). It DOES heal duplicate
// index/shard files (merge + trash), like the old monolith duplicate healing.
async function pullSharded(token) {
  const rootId = await getRootFolderId(token);
  const shardsFolderId = await getShardsFolderId(token);
  let healed = false;

  // index.json (+ dup-name heal).
  let indexFiles = await findIndexFiles(token);
  if (indexFiles.length > 1) {
    const parsed = [];
    for (const f of indexFiles) { try { parsed.push(await readJsonFile(token, f.id)); } catch {} }
    let mergedCollections = { folders: [], tasklists: [], settings: {} };
    for (const p of parsed) mergedCollections = mergeIndexData(mergedCollections, p).merged;
    const mergedIndex = { schema: SCHEMA_VERSION, shardCount: DEFAULT_SHARD_COUNT, ...mergedCollections };
    const keep = indexFiles[0];
    await uploadJsonFile(token, { name: INDEX_FILE_NAME, parentId: rootId, fileId: keep.id, data: mergedIndex });
    for (const f of indexFiles.slice(1)) await trashFile(token, f.id).catch(() => {});
    clearFileHash(INDEX_FILE_NAME);
    healed = true;
    indexFiles = await findIndexFiles(token);
  }
  const indexRec = indexFiles[0] || null;

  // shard files (+ dup-name heal).
  let shardFiles = (await listFolderFiles(token, shardsFolderId)).filter(f => parseShardName(f.name) !== null);
  const byName = new Map();
  for (const f of shardFiles) {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name).push(f);
  }
  for (const [name, files] of byName) {
    if (files.length <= 1) continue;
    files.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
    const parsed = [];
    for (const f of files) { try { parsed.push(await readJsonFile(token, f.id)); } catch {} }
    const merged = unionShardObjects(parsed);
    await uploadJsonFile(token, { name, parentId: shardsFolderId, fileId: files[0].id, data: merged });
    for (const f of files.slice(1)) await trashFile(token, f.id).catch(() => {});
    clearFileHash(name);
    healed = true;
  }
  if (healed) shardFiles = (await listFolderFiles(token, shardsFolderId)).filter(f => parseShardName(f.name) !== null);

  if (!indexRec && !shardFiles.length) return null; // nothing sharded on Drive yet

  const state = getShardState();
  const pendingStamps = {};
  const remotePartial = { notes: [], tasks: [], attachments: [], annotations: [] };
  const changedBuckets = new Set();

  let index = null;
  if (indexRec) {
    const known = state.files[INDEX_FILE_NAME];
    if (!known || (indexRec.modifiedTime || '') > (known.mtime || '')) {
      const data = await readJsonFile(token, indexRec.id);
      index = { folders: data.folders || [], tasklists: data.tasklists || [], settings: data.settings || {} };
      pendingStamps[INDEX_FILE_NAME] = { id: indexRec.id, mtime: indexRec.modifiedTime || '', hash: hashIndex(data) };
    } else if (!known.id) {
      pendingStamps[INDEX_FILE_NAME] = { ...known, id: indexRec.id };
    }
  }

  for (const f of shardFiles) {
    const b = parseShardName(f.name);
    const known = state.files[f.name];
    if (!known || (f.modifiedTime || '') > (known.mtime || '')) {
      const data = await readJsonFile(token, f.id);
      for (const coll of SHARD_COLLS) if (data[coll]) remotePartial[coll].push(...data[coll]);
      changedBuckets.add(b);
      pendingStamps[f.name] = { id: f.id, mtime: f.modifiedTime || '', hash: hashShard(data) };
    } else if (!known.id) {
      pendingStamps[f.name] = { ...known, id: f.id };
    }
  }

  const commit = () => {
    const s = getShardState();
    for (const [name, entry] of Object.entries(pendingStamps)) s.files[name] = { ...s.files[name], ...entry };
    saveShardState(s);
  };

  return { remotePartial, changedBuckets, index, pendingStamps, commit, healed };
}

// Cheap freshness gate for the automatic (focus) path: list shard + index +
// legacy-monolith modifiedTimes and answer "did anything move since our last
// completed cycle?" without downloading. `multiple` = a duplicate file name
// exists (forces a healing cycle regardless).
async function peekSharded(token) {
  const shardsFolderId = await getShardsFolderId(token);
  const [shardFilesRaw, indexFiles, monoFiles] = await Promise.all([
    listFolderFiles(token, shardsFolderId),
    findIndexFiles(token),
    findDataFiles(token),
  ]);
  const state = getShardState();

  // An old-code device still writing the legacy monolith → must fold it.
  if (monoFiles.length && (monoFiles[0].modifiedTime || '') > (state.foldStamp || '')) {
    return { fresh: false, multiple: false };
  }

  const files = [...indexFiles, ...shardFilesRaw.filter(f => parseShardName(f.name) !== null)];
  if (!files.length) return monoFiles.length ? { fresh: false, multiple: false } : null;

  const nameCount = new Map();
  for (const f of files) nameCount.set(f.name, (nameCount.get(f.name) || 0) + 1);
  const multiple = [...nameCount.values()].some(c => c > 1);

  let advanced = false;
  for (const f of files) {
    if ((f.modifiedTime || '') > (state.files[f.name]?.mtime || '')) { advanced = true; break; }
  }
  return { fresh: !advanced && !multiple, multiple };
}

// Fold a legacy monolith into local when an old-code device has advanced it past
// our last fold. Returns {data, commit} — commit stamps foldStamp only AFTER the
// caller imports (crash-safe: the frozen migration copy is never skipped on a
// failed import).
async function readMonolithIfAdvanced(token) {
  const files = await findDataFiles(token);
  if (!files.length) return null;
  const f = files[0]; // newest
  if ((f.modifiedTime || '') <= (getShardState().foldStamp || '')) return null;
  const data = await readJsonFile(token, f.id);
  const commit = () => { const s = getShardState(); s.foldStamp = f.modifiedTime || ''; saveShardState(s); };
  return { data, commit };
}

// Concurrent resolvers must not each create a folder. The sync cycle and the
// attachment-upload queue run under SEPARATE locks (_syncing vs _uploading),
// so with a cold id cache both can call getRootFolderId / findOrCreateFolder
// at once — each searches, finds nothing, and creates its own folder. That is
// exactly how two top-level voidstar_mind folders appear (one ends up with the
// data file, the other with attachments/ + backups/). An in-flight promise per
// cache key collapses same-tab racers onto ONE resolution; the localStorage id
// then caches the winner for everyone.
const _folderInflight = new Map();

async function searchFolders(token, name, { parentId = '', pageSize = 1, orderBy = '' } = {}) {
  const q = [`name='${name.replace(/'/g, "\\'")}'`, `mimeType='application/vnd.google-apps.folder'`, 'trashed=false'];
  if (parentId) q.push(`'${parentId}' in parents`);
  const params = new URLSearchParams({
    q: q.join(' and '),
    spaces: 'drive',
    fields: 'files(id,name,createdTime)',
    pageSize: String(pageSize),
  });
  if (orderBy) params.set('orderBy', orderBy);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive folder search failed: ${res.status}`);
  return (await res.json()).files || [];
}

async function createDriveFolder(token, name, parentId = '') {
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Drive folder create failed: ${res.status}`);
  return (await res.json()).id;
}

// Find (or create) a subfolder by name inside `parentId`. Serialized per cache
// key by the in-flight map above so two racing callers share one folder.
async function findOrCreateFolder(token, name, cacheKey, parentId = '') {
  const cached = localStorage.getItem(cacheKey);
  if (cached) return cached;
  if (_folderInflight.has(cacheKey)) return _folderInflight.get(cacheKey);
  const p = (async () => {
    const found = await searchFolders(token, name, { parentId, pageSize: 1 });
    const folderId = found[0]?.id || await createDriveFolder(token, name, parentId);
    localStorage.setItem(cacheKey, folderId);
    return folderId;
  })();
  _folderInflight.set(cacheKey, p);
  try { return await p; }
  finally { _folderInflight.delete(cacheKey); }
}

// The single top-level folder that holds everything (data file + subfolders).
// If duplicates already exist (a past race, or two devices' cold-cache first
// syncs), resolve to the OLDEST and fold every straggler's contents into it so
// the app converges on one folder. Deterministic canonical (oldest createdTime,
// id tiebreak) so two devices healing at once pick the same survivor.
async function getRootFolderId(token) {
  const cached = localStorage.getItem(ROOT_FOLDER_ID_KEY);
  if (cached) return cached;
  if (_folderInflight.has(ROOT_FOLDER_ID_KEY)) return _folderInflight.get(ROOT_FOLDER_ID_KEY);
  const p = (async () => {
    const found = await searchFolders(token, ROOT_FOLDER_NAME, { pageSize: 100, orderBy: 'createdTime' });
    let rootId;
    if (!found.length) {
      rootId = await createDriveFolder(token, ROOT_FOLDER_NAME);
    } else {
      const sorted = [...found].sort((a, b) =>
        (a.createdTime || '').localeCompare(b.createdTime || '') || a.id.localeCompare(b.id));
      rootId = sorted[0].id;
      if (sorted.length > 1) {
        for (const dup of sorted.slice(1)) {
          try { await mergeFolderInto(token, dup.id, rootId); }
          catch (e) { console.warn('[mind-sync] duplicate root folder heal deferred:', e.message); }
        }
        // A subfolder id we cached may have lived in (or been merged away from)
        // a duplicate root — drop the caches so they re-resolve under the survivor.
        localStorage.removeItem(ATTACH_FOLDER_ID_KEY);
        localStorage.removeItem(BACKUPS_FOLDER_ID_KEY);
      }
    }
    localStorage.setItem(ROOT_FOLDER_ID_KEY, rootId);
    return rootId;
  })();
  _folderInflight.set(ROOT_FOLDER_ID_KEY, p);
  try { return await p; }
  finally { _folderInflight.delete(ROOT_FOLDER_ID_KEY); }
}

// Every non-trashed child of a folder ({id,name,mimeType}), paginated — an
// attachments/ folder can hold thousands of files (esp. after a bulk import).
async function listChildren(token, parentId) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and trashed=false`,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive child list failed: ${res.status}`);
    const json = await res.json();
    out.push(...(json.files || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Move every child of `srcId` into `destId`, merging same-named subfolders (so
// we never leave two attachments/ or two backups/ behind), then trash the
// emptied source. Recoverable — files are trashed, not deleted — and works
// under drive.file because the app created all of these. Duplicate DATA FILES
// that land side by side are healed later by pull() (merge + trash).
async function mergeFolderInto(token, srcId, destId, depth = 0) {
  if (srcId === destId || depth > 4) return;
  const isFolder = (c) => c.mimeType === 'application/vnd.google-apps.folder';
  const [srcChildren, destChildren] = await Promise.all([
    listChildren(token, srcId), listChildren(token, destId),
  ]);
  const destFolderByName = new Map(destChildren.filter(isFolder).map(c => [c.name, c.id]));
  for (const child of srcChildren) {
    const twin = isFolder(child) ? destFolderByName.get(child.name) : null;
    if (twin) await mergeFolderInto(token, child.id, twin, depth + 1); // trashes child.id
    else await reparentInto(token, child.id, destId);
  }
  await trashFile(token, srcId);
}

// One-time migration to the single-folder layout: move the legacy loose data
// file and the two legacy root folders under voidstar_mind (renaming the
// subfolders to attachments/ and backups/). Idempotent, guarded by a flag;
// works under drive.file because the app created every one of these files.
async function migrateToRootFolder(token) {
  if (localStorage.getItem(CONSOLIDATED_KEY)) return;
  try {
    const root = await getRootFolderId(token);

    // Move any root-level data file(s) into the folder.
    for (const f of await findDataFilesAnywhere(token)) {
      if (!(f.parents || []).includes(root)) await reparentInto(token, f.id, root);
    }

    // Re-home + rename the legacy subfolders if they still exist at root.
    const legacyAttach = await findFolderByName(token, LEGACY_ATTACH_FOLDER_NAME, root);
    if (legacyAttach) {
      await reparentInto(token, legacyAttach, root, { name: ATTACH_FOLDER_NAME });
      localStorage.setItem(ATTACH_FOLDER_ID_KEY, legacyAttach);
    }
    const legacyBackups = await findFolderByName(token, LEGACY_BACKUPS_FOLDER_NAME, root);
    if (legacyBackups) {
      await reparentInto(token, legacyBackups, root, { name: BACKUPS_FOLDER_NAME });
      localStorage.setItem(BACKUPS_FOLDER_ID_KEY, legacyBackups);
    }

    localStorage.setItem(CONSOLIDATED_KEY, String(Date.now()));
  } catch (e) {
    // Leave the flag unset so the next init retries. Normal ops still work:
    // fresh installs simply create everything under the root folder.
    console.warn('[mind-sync] folder consolidation deferred:', e.message);
  }
}

// Consolidate any pre-existing duplicate top-level folders exactly once per
// device. getRootFolderId only heals when its id cache is COLD, but an already
// affected install has a warm cache pointing at one of the twins — so it would
// keep using that twin and never merge. Force a single fresh resolution
// (dropping the cache) to fold the duplicates together, then flag it done so we
// don't pay the wider scan on every init. Idempotent and best-effort: a
// deferral just retries next launch.
async function healRootFoldersOnce(token) {
  if (localStorage.getItem(ROOT_HEALED_KEY)) return;
  try {
    localStorage.removeItem(ROOT_FOLDER_ID_KEY);
    await getRootFolderId(token); // re-scans, merges twins, re-caches the survivor
    localStorage.setItem(ROOT_HEALED_KEY, String(Date.now()));
  } catch (e) {
    console.warn('[mind-sync] duplicate root folder heal deferred:', e.message);
  }
}

// A folder by exact name, excluding one id (the root folder itself, so we never
// match it). Returns the id or ''.
async function findFolderByName(token, name, excludeId = '') {
  const params = new URLSearchParams({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: '5',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return '';
  const hit = ((await res.json()).files || []).find(f => f.id !== excludeId);
  return hit ? hit.id : '';
}

// Re-parent a file/folder into `parentId` (removing its current parents), with
// an optional metadata patch (e.g. rename). No-op if already correctly placed.
async function reparentInto(token, fileId, parentId, patch = {}) {
  let parents = [];
  try {
    const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (meta.ok) parents = (await meta.json()).parents || [];
  } catch {}
  const alreadyThere = parents.length === 1 && parents[0] === parentId;
  if (alreadyThere && !Object.keys(patch).length) return;
  const qs = new URLSearchParams({ addParents: parentId, fields: 'id' });
  const removeParents = parents.filter(p => p !== parentId).join(',');
  if (removeParents) qs.set('removeParents', removeParents);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?${qs}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Drive re-parent failed: ${res.status}`);
}

export async function initGdriveSync({ interactive = true } = {}) {
  const token = await getAccessToken({ interactive });
  if (!token) return null;

  // Move any legacy scattered files under the single voidstar_mind folder
  // before the first pull/push so scoped discovery is valid (one-time, guarded).
  await migrateToRootFolder(token);
  // Fold any duplicate top-level voidstar_mind folders into one (one-time).
  await healRootFoldersOnce(token);

  return {
    // Sharded Drive I/O — only changed shards move. See pushSharded/pullSharded.
    push: (dataset) => pushSharded(token, dataset),
    pull: () => pullSharded(token),
    peek: () => peekSharded(token),
    readMonolithIfAdvanced: () => readMonolithIfAdvanced(token),

    // ── Attachment binaries ──
    async uploadAttachment(att, blob) {
      const folderId = await findOrCreateFolder(token, ATTACH_FOLDER_NAME, ATTACH_FOLDER_ID_KEY, await getRootFolderId(token));
      const name = `${att.id}-${att.name || att.kind}`;
      const metadata = { name, parents: [folderId] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', blob, name);
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) throw new Error(`Drive attachment upload failed: ${res.status}`);
      return (await res.json()).id;
    },
    async downloadAttachment(fileId) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Drive attachment download failed: ${res.status}`);
      return res.blob();
    },
    trashAttachmentFile: (fileId) => trashFile(token, fileId).catch(() => {}),

    // Version history (rotating timestamped JSON copies).
    writeHistory: (data, force = false) => writeHistorySnapshot(token, data, force),
    listHistory: () => listHistory(token),
    readHistory: (fileId) => readJsonFile(token, fileId),
  };
}

// ── Drive version history ──

async function writeHistorySnapshot(token, data, force = false) {
  const last = parseInt(localStorage.getItem(LAST_HISTORY_KEY) || '0', 10);
  if (!force && Date.now() - last < HISTORY_MIN_INTERVAL_MS) return;

  const folderId = await findOrCreateFolder(token, BACKUPS_FOLDER_NAME, BACKUPS_FOLDER_ID_KEY, await getRootFolderId(token));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const metadata = { name: `${HISTORY_PREFIX}${stamp}.json`, mimeType: 'application/json', parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), metadata.name);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Drive history write failed: ${res.status}`);
  localStorage.setItem(LAST_HISTORY_KEY, String(Date.now()));
  await pruneHistory(token, folderId, HISTORY_KEEP);
}

async function pruneHistory(token, folderId, keep = HISTORY_KEEP) {
  const files = await listHistoryFiles(token, folderId);
  for (const f of files.slice(keep)) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
  }
}

async function listHistoryFiles(token, folderId) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and name contains '${HISTORY_PREFIX}' and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name,createdTime)',
    orderBy: 'createdTime desc',
    pageSize: '50',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive history list failed: ${res.status}`);
  return (await res.json()).files || [];
}

async function listHistory(token) {
  const folderId = await findOrCreateFolder(token, BACKUPS_FOLDER_NAME, BACKUPS_FOLDER_ID_KEY, await getRootFolderId(token));
  return listHistoryFiles(token, folderId);
}

// ── The single pull→merge→push code path (sharded) ──
//
// The merge itself lives in shard.js (rules unchanged). This orchestrator:
//   1. folds a still-advancing legacy monolith into local (old-code devices),
//   2. pulls only the shards that changed on Drive (a PARTIAL remote),
//   3. merges FULL local ⋈ partial remote (keeps conflict-copy dedup correct),
//   4. imports only the delta locally, then
//   5. pushes only the shards whose content hash diverged.

export async function pullMergePushCycle(client, exportFn, importFn, opts = {}) {
  if (_syncing) return { merged: null, hadRemote: false, changed: false, skipped: true };
  _syncing = true;
  try {
    const dirtyStamp = getDirtyStamp();

    // (1) Dual-read the legacy monolith BEFORE pulling shards, so its records are
    // in local when we export. commit() stamps foldStamp only after the import.
    let foldedMonolith = false;
    if (client.readMonolithIfAdvanced) {
      try {
        const mono = await client.readMonolithIfAdvanced();
        if (mono) { await importFn(mono.data); mono.commit(); foldedMonolith = true; }
      } catch (e) { console.warn('[mind-sync] monolith fold failed:', e.message); }
    }

    // (2) Pull changed shards; (3) merge against full local.
    const pulled = await client.pull();
    const localFull = await exportFn();

    let mergedFull = localFull;
    let delta = null;
    let conflicts = 0;
    if (pulled) {
      const mergeOpts = {
        lastCycleAt: getLastCycleAt(),
        deviceName: getDeviceName(),
        idgen: () => crypto.randomUUID(),
        now: () => Date.now(),
      };
      const sm = mergeShardData(localFull, pulled.remotePartial, mergeOpts);
      conflicts = sm.conflicts;
      let { folders, tasklists, settings } = localFull;
      if (pulled.index) {
        ({ folders, tasklists, settings } = mergeIndexData(
          { folders: localFull.folders, tasklists: localFull.tasklists, settings: localFull.settings },
          pulled.index,
        ).merged);
      }
      mergedFull = {
        notes: sm.merged.notes,
        folders,
        tasks: sm.merged.tasks,
        tasklists,
        attachments: sm.merged.attachments,
        annotations: sm.merged.annotations,
        settings,
      };
      delta = computeDelta(localFull, mergedFull);
    }

    // (4) Import only what changed; snapshot first (size-gated inside putSnapshot).
    const importedDelta = delta && !isEmptyDelta(delta);
    if (importedDelta) {
      if (opts.snapshotFn) await opts.snapshotFn();
      await importFn(delta);
    }
    if (pulled) pulled.commit(); // stamp pulled shards only AFTER the import

    // (5) Push only the shards whose content hash diverged.
    const { uploaded } = await client.push(mergedFull);

    // History is now a manual/forced consolidated restore point only (Drive keeps
    // native per-file revisions on each shard for the automatic path).
    if (opts.historyForce && client.writeHistory) {
      try { await client.writeHistory(mergedFull, true); }
      catch (e) { console.warn('[mind-sync] history write failed:', e.message); }
    }

    clearDirtyIf(dirtyStamp);
    setLastBackupTime(Date.now());
    setLastCycleAt(Date.now());
    const changed = importedDelta || foldedMonolith;
    return { merged: mergedFull, hadRemote: !!pulled, changed, pushed: uploaded.length > 0, conflicts };
  } finally {
    _syncing = false;
  }
}

export async function pullMergePushIfStale(client, exportFn, importFn, opts = {}) {
  if (!isLocalDirty()) {
    try {
      const info = await client.peek();
      if (info && info.fresh) {
        setLastBackupTime(Date.now());
        return { merged: null, hadRemote: true, changed: false, fresh: true };
      }
    } catch (e) {
      console.warn('[mind-sync] freshness check failed, running a full cycle:', e.message);
    }
  }
  return pullMergePushCycle(client, exportFn, importFn, opts);
}

// ── Debounced auto-push + status pill (verbatim pattern from setlist) ──

let _pushTimer = null;
let _syncClient = null;
let _exportFn = null;
let _importFn = null;
let _syncing = false;

export function isSyncing() { return _syncing; }
export function setSyncClient(client) { _syncClient = client; }
export function getSyncClient() { return _syncClient; }

const _statusListeners = new Set();
let _syncState = 'idle'; // 'idle' | 'syncing' | 'synced' | 'pending' | 'offline'
let _pendingPush = false;
let _connWatched = false;

export function getSyncState() { return _syncState; }

export function onSyncState(fn) {
  _statusListeners.add(fn);
  try { fn(_syncState); } catch {}
  return () => _statusListeners.delete(fn);
}

function setSyncState(s) {
  _syncState = s;
  for (const fn of _statusListeners) { try { fn(s); } catch {} }
}

async function pushNow() {
  if (_syncing) { _pendingPush = true; return; }
  setSyncState('syncing');
  try {
    await pullMergePushCycle(_syncClient, _exportFn, _importFn);
    _pendingPush = false;
    setSyncState('synced');
  } catch (e) {
    _pendingPush = true;
    setSyncState('pending');
    console.warn('[mind-sync] push failed:', e.message);
  }
}

export function debouncedPush(exportFn, importFn, delayMs = 3000) {
  markLocalDirty();
  if (!_syncClient) return;
  _exportFn = exportFn;
  if (importFn) _importFn = importFn;
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      _pendingPush = true;
      setSyncState('offline');
      return;
    }
    pushNow();
  }, delayMs);
}

export function watchConnectivity() {
  if (_connWatched || typeof window === 'undefined') return;
  _connWatched = true;
  window.addEventListener('offline', () => setSyncState('offline'));
  window.addEventListener('online', () => {
    if (_pendingPush && _syncClient && _exportFn) pushNow();
    else setSyncState(_syncClient ? 'synced' : 'idle');
  });
  if (typeof navigator !== 'undefined' && !navigator.onLine) setSyncState('offline');
}
