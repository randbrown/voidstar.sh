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
// this app creates), user-supplied OAuth client ID, token cached ~1h.

import { mergeRecord, NOTE_FILL_FIELDS, ATTACHMENT_FILL_FIELDS } from './store.js';

const NS = 'voidstar.mind.gdrive';
const CLIENT_ID_KEY = `${NS}.clientId`;
const TOKEN_KEY = `${NS}.token`;
const LAST_BACKUP_KEY = `${NS}.lastBackupAt`;
const DEVICE_NAME_KEY = `${NS}.deviceName`;
const FILE_NAME = 'voidstar-mind-data.json';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

const BACKUPS_FOLDER_NAME = 'voidstar mind backups';
const BACKUPS_FOLDER_ID_KEY = `${NS}.backupsFolderId`;
const ATTACH_FOLDER_NAME = 'voidstar mind attachments';
const ATTACH_FOLDER_ID_KEY = `${NS}.attachFolderId`;
const HISTORY_PREFIX = 'voidstar-mind-data-'; // + <ISO>.json
const LAST_HISTORY_KEY = `${NS}.lastHistoryAt`;
const HISTORY_KEEP = 10;
const HISTORY_MIN_INTERVAL_MS = 10 * 60 * 1000;

// ── Freshness bookkeeping (see setlist fork for the full rationale) ──
const REMOTE_MODIFIED_KEY = `${NS}.remoteModifiedTime`;
const DIRTY_KEY = `${NS}.dirtyAt`;
// Stamp of this device's last COMPLETED cycle — the conflict detector's
// baseline: edits on both sides newer than this = a real concurrent fork.
const LAST_CYCLE_KEY = `${NS}.lastCycleAt`;

function getLastRemoteModified() { return localStorage.getItem(REMOTE_MODIFIED_KEY) || ''; }
function setLastRemoteModified(t) { if (t) localStorage.setItem(REMOTE_MODIFIED_KEY, t); }
function markLocalDirty() { try { localStorage.setItem(DIRTY_KEY, String(Date.now())); } catch {} }
function getDirtyStamp() { return localStorage.getItem(DIRTY_KEY) || ''; }
export function isLocalDirty() { return !!getDirtyStamp(); }
function clearDirtyIf(stamp) { if (getDirtyStamp() === stamp) localStorage.removeItem(DIRTY_KEY); }
export function getLastCycleAt() { return parseInt(localStorage.getItem(LAST_CYCLE_KEY) || '0', 10); }
function setLastCycleAt(ts) { localStorage.setItem(LAST_CYCLE_KEY, String(ts)); }

let _gisLoaded = false;

function getClientId() { return localStorage.getItem(CLIENT_ID_KEY) || ''; }
export function setClientId(id) { localStorage.setItem(CLIENT_ID_KEY, id); }
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

// ── Drive REST helpers ──

async function findDataFiles(token) {
  const params = new URLSearchParams({
    q: `name='${FILE_NAME}' and trashed=false`,
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

async function createFile(token, data) {
  const metadata = { name: FILE_NAME, mimeType: 'application/json' };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), FILE_NAME);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
  return res.json();
}

async function updateFile(token, fileId, data) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,modifiedTime`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
  return res.json();
}

async function findOrCreateFolder(token, name, cacheKey) {
  const cached = localStorage.getItem(cacheKey);
  if (cached) return cached;
  const params = new URLSearchParams({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: '1',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive folder search failed: ${res.status}`);
  let folderId = (await res.json()).files?.[0]?.id;
  if (!folderId) {
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!createRes.ok) throw new Error(`Drive folder create failed: ${createRes.status}`);
    folderId = (await createRes.json()).id;
  }
  localStorage.setItem(cacheKey, folderId);
  return folderId;
}

export async function initGdriveSync({ interactive = true } = {}) {
  const token = await getAccessToken({ interactive });
  if (!token) return null;

  return {
    async push(data) {
      const files = await findDataFiles(token);
      const file = files.length
        ? await updateFile(token, files[0].id, data)
        : await createFile(token, data);
      return file?.modifiedTime || '';
    },
    // {data, modifiedTime, healed} or null. Duplicate data files (two devices'
    // first pushes racing) are merged and trashed so all devices converge.
    async pull() {
      const files = await findDataFiles(token);
      if (!files.length) return null;
      let data = await readJsonFile(token, files[0].id);
      let healed = false;
      for (const dupe of files.slice(1)) {
        try {
          data = mergeData(data, await readJsonFile(token, dupe.id)).merged;
          await trashFile(token, dupe.id);
          healed = true;
        } catch (e) {
          console.warn('[mind-sync] duplicate data file merge failed:', e.message);
        }
      }
      return { data, modifiedTime: files[0].modifiedTime || '', healed };
    },
    async peek() {
      const files = await findDataFiles(token);
      if (!files.length) return null;
      return { modifiedTime: files[0].modifiedTime || '', multiple: files.length > 1 };
    },

    // ── Attachment binaries ──
    async uploadAttachment(att, blob) {
      const folderId = await findOrCreateFolder(token, ATTACH_FOLDER_NAME, ATTACH_FOLDER_ID_KEY);
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

  const folderId = await findOrCreateFolder(token, BACKUPS_FOLDER_NAME, BACKUPS_FOLDER_ID_KEY);
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
  const folderId = await findOrCreateFolder(token, BACKUPS_FOLDER_NAME, BACKUPS_FOLDER_ID_KEY);
  return listHistoryFiles(token, folderId);
}

// ── Merge ──

function mergeById(localArr, remoteArr, keyField = 'id', fillFields = null) {
  const map = new Map();
  for (const item of localArr) map.set(item[keyField], item);
  for (const remote of remoteArr) {
    const key = remote[keyField];
    const local = map.get(key);
    map.set(key, local ? mergeRecord(local, remote, fillFields) : remote);
  }
  return [...map.values()];
}

function mergeConfig(local, remote) {
  const out = { ...(remote || {}) };
  for (const [k, v] of Object.entries(local || {})) {
    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (!empty || !(k in out)) out[k] = v;
  }
  return out;
}

function configChanged(local = {}, remote = {}) {
  const merged = mergeConfig(local, remote);
  const keys = new Set([...Object.keys(merged), ...Object.keys(local)]);
  for (const k of keys) {
    if (JSON.stringify(merged[k]) !== JSON.stringify(local[k])) return true;
  }
  return false;
}

function recordsChanged(localArr = [], mergedArr = [], keyField = 'id') {
  if (localArr.length !== mergedArr.length) return true;
  const map = new Map(localArr.map(i => [i[keyField], i]));
  return mergedArr.some(rec => {
    const cur = map.get(rec[keyField]);
    if (cur === rec) return false;
    return !cur || JSON.stringify(cur) !== JSON.stringify(rec);
  });
}

function mergeChangesLocal(local, merged) {
  return recordsChanged(local.notes, merged.notes)
    || recordsChanged(local.folders, merged.folders)
    || recordsChanged(local.tasks, merged.tasks)
    || recordsChanged(local.tasklists, merged.tasklists)
    || recordsChanged(local.attachments, merged.attachments)
    || recordsChanged(local.annotations, merged.annotations, 'key')
    || configChanged(local.settings, merged.settings);
}

// Notes merge with conflict copies. A note edited on BOTH sides since this
// device's last completed cycle, with different bodies, resolves LWW — and
// the losing body is preserved as a new "Conflicted copy of …" note. First
// sync (no cycle stamp) is plain LWW+fill: a missing baseline must not spam
// copies for every note.
function mergeNotes(localArr, remoteArr, lastCycleAt) {
  const copies = [];
  const map = new Map(localArr.map(n => [n.id, n]));
  const existing = [...localArr, ...remoteArr];

  for (const remote of remoteArr) {
    const local = map.get(remote.id);
    if (!local) { map.set(remote.id, remote); continue; }

    const concurrent = lastCycleAt
      && !local.deletedAt && !remote.deletedAt
      && local.updatedAt !== remote.updatedAt
      && local.updatedAt > lastCycleAt && remote.updatedAt > lastCycleAt
      && (local.body || '') !== (remote.body || '');

    const merged = mergeRecord(local, remote, NOTE_FILL_FIELDS);
    map.set(remote.id, merged);

    if (concurrent) {
      const loser = merged.updatedAt === local.updatedAt ? remote : local;
      const loserIsLocal = loser === local;
      // Both devices detect the same fork — don't mint a second copy if one
      // with this exact body already exists (arrived via the remote side).
      const dupe = existing.some(n => n.conflictOf === remote.id && (n.body || '') === (loser.body || ''))
        || copies.some(n => n.conflictOf === remote.id && (n.body || '') === (loser.body || ''));
      if (!dupe) {
        const when = new Date(loser.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
        copies.push({
          ...loser,
          id: crypto.randomUUID(),
          title: `Conflicted copy of ${loser.title} (${loserIsLocal ? getDeviceName() : 'another device'}, ${when})`,
          autoTitle: false,
          conflictOf: remote.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
  }
  return { merged: [...map.values(), ...copies], conflicts: copies.length };
}

export function mergeData(local, remote) {
  const lastCycleAt = getLastCycleAt();
  const notes = mergeNotes(local.notes || [], remote.notes || [], lastCycleAt);
  return {
    merged: {
      notes: notes.merged,
      folders: mergeById(local.folders || [], remote.folders || []),
      tasks: mergeById(local.tasks || [], remote.tasks || []),
      tasklists: mergeById(local.tasklists || [], remote.tasklists || []),
      attachments: mergeById(local.attachments || [], remote.attachments || [], 'id', ATTACHMENT_FILL_FIELDS),
      annotations: mergeById(local.annotations || [], remote.annotations || [], 'key'),
      settings: mergeConfig(local.settings, remote.settings),
    },
    conflicts: notes.conflicts,
  };
}

// ── The single pull→merge→push code path ──

export async function pullMergePushCycle(client, exportFn, importFn, opts = {}) {
  if (_syncing) return { merged: null, hadRemote: false, changed: false, skipped: true };
  _syncing = true;
  try {
    const dirtyStamp = getDirtyStamp();
    const pulled = await client.pull();
    const remote = pulled ? pulled.data : null;
    const local = await exportFn();
    const result = remote ? mergeData(local, remote) : { merged: local, conflicts: 0 };
    const merged = result.merged;
    const changed = remote ? mergeChangesLocal(local, merged) : false;
    if (changed && opts.snapshotFn) await opts.snapshotFn();
    if (changed) await importFn(merged);
    const pushNeeded = !remote || pulled.healed || mergeChangesLocal(remote, merged);
    let remoteModified = pulled ? pulled.modifiedTime : '';
    if (pushNeeded) {
      remoteModified = await client.push({ ...merged, version: 1, app: 'mind', exportedAt: Date.now() });
      if (client.writeHistory) {
        try { await client.writeHistory(merged, !!opts.historyForce); }
        catch (e) { console.warn('[mind-sync] history write failed:', e.message); }
      }
    }
    setLastRemoteModified(remoteModified);
    clearDirtyIf(dirtyStamp);
    setLastBackupTime(Date.now());
    setLastCycleAt(Date.now());
    return { merged, hadRemote: !!remote, changed, pushed: pushNeeded, conflicts: result.conflicts };
  } finally {
    _syncing = false;
  }
}

export async function pullMergePushIfStale(client, exportFn, importFn, opts = {}) {
  if (!isLocalDirty()) {
    try {
      const info = await client.peek();
      if (info && !info.multiple && info.modifiedTime && info.modifiedTime === getLastRemoteModified()) {
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
