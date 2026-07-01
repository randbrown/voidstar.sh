// Google Drive data backup — stores setlist data in the user's Google Drive.
// Uses Google Identity Services (GIS) for OAuth2 in the browser.
// Data is stored as a single JSON file in the app-specific folder.
//
// Naming note: this module is about *backing up and restoring* app data
// (songs/notes/setlists/annotations). It intentionally does not use the word
// "sync" — that term is reserved for the separate chart/Spotify auto-linking
// feature in sync.js/match.js, which matches an imported setlist against
// Google Drive charts and a Spotify reference playlist. Keeping the two
// features' names distinct avoids confusing "back up my data" with "match my
// songs to charts and tracks".

const CLIENT_ID_KEY = 'voidstar.setlist.gdrive.clientId';
const TOKEN_KEY = 'voidstar.setlist.gdrive.token';
const LAST_BACKUP_KEY = 'voidstar.setlist.gdrive.lastBackupAt';
const FILE_NAME = 'voidstar-setlist-data.json';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

// Drive-side version history: rotating timestamped copies in their own folder,
// so a bad state that already reached Drive can be rolled back from any device.
const BACKUPS_FOLDER_NAME = 'voidstar backups';
const BACKUPS_FOLDER_ID_KEY = 'voidstar.setlist.gdrive.backupsFolderId';
const HISTORY_PREFIX = 'voidstar-setlist-data-'; // + <ISO>.json
const LAST_HISTORY_KEY = 'voidstar.setlist.gdrive.lastHistoryAt';
const HISTORY_KEEP = 10;
const HISTORY_MIN_INTERVAL_MS = 10 * 60 * 1000; // throttle auto (non-forced) writes

let _gisLoaded = false;

function getClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || '';
}

export function setClientId(id) {
  localStorage.setItem(CLIENT_ID_KEY, id);
}

export function isGdriveBackupEnabled() {
  return !!getClientId() && !!getStoredToken();
}

// A client ID is configured but there's no valid (unexpired) token — the user
// connected before but the token lapsed. Drives the pill's "reconnect" state:
// a silent re-auth is impossible (GIS needs a gesture), so the UI must invite
// a tap to reconnect.
export function needsReconnect() {
  return !!getClientId() && !getStoredToken();
}

export function getLastBackupTime() {
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  return raw ? parseInt(raw, 10) : null;
}

export function setLastBackupTime(ts) {
  localStorage.setItem(LAST_BACKUP_KEY, String(ts));
}

// Short relative-time string for status displays, e.g. "3m ago", "2h ago",
// "yesterday", or a plain date once it's more than a week old.
export function formatLastBackup() {
  const ts = getLastBackupTime();
  if (!ts) return 'never';
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60000);
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

  // Non-interactive callers (e.g. auto-backup on page load) must never trigger
  // the OAuth popup: browsers block popups not opened from a user gesture,
  // which surfaces as the noisy GSI_LOGGER "Failed to open popup" error.
  if (!interactive) return null;

  const clientId = getClientId();
  if (!clientId) throw new Error('Google Drive client ID not configured. Set it in Sources & Sync settings.');

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

async function findDataFile(token) {
  const params = new URLSearchParams({
    q: `name='${FILE_NAME}' and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name,modifiedTime)',
    pageSize: '1',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive search failed: ${res.status}`);
  const data = await res.json();
  return data.files?.[0] || null;
}

async function readFile(token, fileId) {
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
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }));

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
  return res.json();
}

async function updateFile(token, fileId, data) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
  return res.json();
}

export async function initGdriveBackup({ interactive = true } = {}) {
  const token = await getAccessToken({ interactive });
  if (!token) return null;

  return {
    async push(data) {
      const existing = await findDataFile(token);
      if (existing) {
        await updateFile(token, existing.id, data);
      } else {
        await createFile(token, data);
      }
    },
    async pull() {
      const existing = await findDataFile(token);
      if (!existing) return null;
      return readFile(token, existing.id);
    },
    // Version history (rotating timestamped copies). Methods close over the
    // token so callers never handle it directly.
    writeHistory: (data, force = false) => writeHistorySnapshot(token, data, force),
    listHistory: () => listHistory(token),
    readHistory: (fileId) => readFile(token, fileId),
  };
}

// ── Tier 3 chart fallback: create a blank chart doc when nothing matched ──
// Reuses the same drive.file-scoped OAuth token as the data backup above —
// that scope is exactly right here too, since it only lets the app manage
// files/folders it creates itself.

const CHARTS_FOLDER_NAME = 'voidstar charts';
const CHARTS_FOLDER_ID_KEY = 'voidstar.setlist.gdrive.chartsFolderId';

async function findOrCreateChartsFolder(token) {
  const cached = localStorage.getItem(CHARTS_FOLDER_ID_KEY);
  if (cached) return cached;

  const params = new URLSearchParams({
    q: `name='${CHARTS_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: '1',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive folder search failed: ${res.status}`);
  const data = await res.json();
  let folderId = data.files?.[0]?.id;

  if (!folderId) {
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: CHARTS_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!createRes.ok) throw new Error(`Drive folder create failed: ${createRes.status}`);
    folderId = (await createRes.json()).id;
  }
  localStorage.setItem(CHARTS_FOLDER_ID_KEY, folderId);
  return folderId;
}

// Creates a blank Google Doc for a song with no chart yet, inside a
// dedicated "voidstar charts" Drive folder, and returns its webViewLink.
// Deliberately a Doc (not a Drawing): the worker's existing chart-scraping
// already understands Google Docs' plain-text export, so once the user
// types/pastes a chart in, "scrape" picks up key/BPM/section data for free.
// For freeform hand-drawn charts, the in-app annotation canvas already draws
// on top of any linked document, covering that case without needing Drive
// Drawing support.
export async function createBlankChartDoc(song) {
  const token = await getAccessToken({ interactive: true });
  if (!token) throw new Error('Google Drive not connected. Set a Client ID and connect in Settings.');

  const folderId = await findOrCreateChartsFolder(token);
  const name = song.artist ? `${song.title} - ${song.artist}` : song.title;

  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId],
    }),
  });
  if (!res.ok) throw new Error(`Drive doc create failed: ${res.status}`);
  const file = await res.json();
  return file.webViewLink;
}

// ── Drive version history ──
// Same drive.file scope + same folder pattern as the charts folder above.

async function findOrCreateBackupsFolder(token) {
  const cached = localStorage.getItem(BACKUPS_FOLDER_ID_KEY);
  if (cached) return cached;

  const params = new URLSearchParams({
    q: `name='${BACKUPS_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: '1',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive folder search failed: ${res.status}`);
  const data = await res.json();
  let folderId = data.files?.[0]?.id;

  if (!folderId) {
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: BACKUPS_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!createRes.ok) throw new Error(`Drive folder create failed: ${createRes.status}`);
    folderId = (await createRes.json()).id;
  }
  localStorage.setItem(BACKUPS_FOLDER_ID_KEY, folderId);
  return folderId;
}

// Write a timestamped copy of the dataset into the backups folder, then prune
// to the newest HISTORY_KEEP. Throttled: skips silently if the last history
// write was < HISTORY_MIN_INTERVAL_MS ago unless `force` (manual actions).
async function writeHistorySnapshot(token, data, force = false) {
  const last = parseInt(localStorage.getItem(LAST_HISTORY_KEY) || '0', 10);
  if (!force && Date.now() - last < HISTORY_MIN_INTERVAL_MS) return;

  const folderId = await findOrCreateBackupsFolder(token);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const metadata = { name: `${HISTORY_PREFIX}${stamp}.json`, mimeType: 'application/json', parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }));

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
  const files = await listHistoryFiles(token, folderId); // newest first
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
  const folderId = await findOrCreateBackupsFolder(token);
  return listHistoryFiles(token, folderId);
}

// ── Merge by "newer wins" ──

function mergeById(localArr, remoteArr, keyField = 'id') {
  const map = new Map();
  for (const item of localArr) map.set(item[keyField], item);
  for (const remote of remoteArr) {
    const key = remote[keyField];
    const local = map.get(key);
    if (!local) {
      map.set(key, remote);
    } else {
      const localTs = local.updatedAt || local.createdAt || 0;
      const remoteTs = remote.updatedAt || remote.createdAt || 0;
      if (remoteTs > localTs) map.set(key, remote);
    }
  }
  return [...map.values()];
}

export function mergeData(local, remote) {
  return {
    songs: mergeById(local.songs || [], remote.songs || []),
    notes: mergeById(local.notes || [], remote.notes || []),
    setlists: mergeById(local.setlists || [], remote.setlists || []),
    annotations: mergeById(local.annotations || [], remote.annotations || [], 'songId'),
    sources: local.sources || remote.sources || {},
  };
}

// The single code path for all Drive data I/O: pull whatever's in Drive,
// merge it with local data (newer record per id/songId wins), write the
// merged result back locally, then push the merged result back to Drive so
// both sides end up identical. Safe to call with nothing in Drive yet (first
// backup) or with local data that's ahead, behind, or diverged from Drive —
// it never blindly overwrites either side. `hadRemote` tells callers whether
// there was anything in Drive to restore (distinct from `merged` being
// non-empty, which is true even on a first backup from local-only data).
//
// opts:
//   snapshotFn  — called right BEFORE importing merged remote data, so the
//                 caller can snapshot the true pre-import local state (used
//                 for "undo last sync"). Only runs when there was remote data.
//   historyForce — force a Drive version-history write even inside the throttle
//                 window (manual actions pass true; auto-sync leaves it false).
export async function pullMergePushCycle(client, exportFn, importFn, opts = {}) {
  if (_syncing) return { merged: null, hadRemote: false, skipped: true };
  _syncing = true;
  try {
    const remote = await client.pull();
    const local = await exportFn();
    const merged = remote ? mergeData(local, remote) : local;
    if (remote && opts.snapshotFn) await opts.snapshotFn();
    if (remote) await importFn(merged);
    await client.push({ ...merged, version: 1, exportedAt: Date.now() });
    // Version history is best-effort — a failure here must not fail the sync.
    if (client.writeHistory) {
      try { await client.writeHistory(merged, !!opts.historyForce); }
      catch (e) { console.warn('[gdrive-backup] history write failed:', e.message); }
    }
    setLastBackupTime(Date.now());
    return { merged, hadRemote: !!remote };
  } finally {
    _syncing = false;
  }
}

let _pushTimer = null;
let _backupClient = null;
let _exportFn = null;
let _syncing = false;

// True while any pull/merge/push (manual, auto, or focus) is in flight — every
// sync entry point checks this to avoid overlapping cycles.
export function isSyncing() { return _syncing; }

export function setBackupClient(client) { _backupClient = client; }

// ── Backup status broadcast (drives the offline/backup pill) ──
// States: 'idle' | 'syncing' | 'synced' | 'pending' | 'offline'
const _statusListeners = new Set();
let _backupState = 'idle';
let _pendingPush = false;
let _connWatched = false;

export function getBackupState() { return _backupState; }

export function onBackupState(fn) {
  _statusListeners.add(fn);
  try { fn(_backupState); } catch {}
  return () => _statusListeners.delete(fn);
}

function setBackupState(s) {
  _backupState = s;
  for (const fn of _statusListeners) { try { fn(s); } catch {} }
}

async function pushNow() {
  // Don't collide with a full pull/merge/push cycle already running; that cycle
  // pushes the same data, so re-flag as pending and let it settle.
  if (_syncing) { _pendingPush = true; return; }
  _syncing = true;
  setBackupState('syncing');
  try {
    await _backupClient.push(await _exportFn());
    setLastBackupTime(Date.now());
    _pendingPush = false;
    setBackupState('synced');
  } catch (e) {
    _pendingPush = true;
    setBackupState('pending');
    console.warn('[gdrive-backup] push failed:', e.message);
  } finally {
    _syncing = false;
  }
}

export async function debouncedPush(exportFn, delayMs = 3000) {
  if (!_backupClient) return;
  _exportFn = exportFn;
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    // Offline: don't even try — flag it so we flush on reconnect.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      _pendingPush = true;
      setBackupState('offline');
      return;
    }
    pushNow();
  }, delayMs);
}

// Watch online/offline so edits made offline flush to Drive on reconnect and
// the pill reflects reality. Safe to call more than once.
export function watchConnectivity() {
  if (_connWatched || typeof window === 'undefined') return;
  _connWatched = true;
  window.addEventListener('offline', () => setBackupState('offline'));
  window.addEventListener('online', () => {
    if (_pendingPush && _backupClient && _exportFn) pushNow();
    else setBackupState(_backupClient ? 'synced' : 'idle');
  });
  if (typeof navigator !== 'undefined' && !navigator.onLine) setBackupState('offline');
}
