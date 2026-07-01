// Google Drive data sync — stores setlist data in Google Drive app data folder.
// Uses Google Identity Services (GIS) for OAuth2 in the browser.
// Data is stored as a single JSON file in the app-specific folder.

const CLIENT_ID_KEY = 'voidstar.setlist.gdrive.clientId';
const TOKEN_KEY = 'voidstar.setlist.gdrive.token';
const FILE_NAME = 'voidstar-setlist-data.json';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let _gisLoaded = false;

function getClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || '';
}

export function setClientId(id) {
  localStorage.setItem(CLIENT_ID_KEY, id);
}

export function isGdriveSyncEnabled() {
  return !!getClientId() && !!localStorage.getItem(TOKEN_KEY);
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

  // Non-interactive callers (e.g. auto-sync on page load) must never trigger
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

export async function initGdriveSync({ interactive = true } = {}) {
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
  };
}

// ── Auto-sync: merge by "newer wins" ──

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
    sources: local.sources || remote.sources || {},
  };
}

let _pushTimer = null;
let _syncClient = null;
let _exportFn = null;

export function setSyncClient(client) { _syncClient = client; }

// ── Sync status broadcast (drives the offline/sync pill) ──
// States: 'idle' | 'syncing' | 'synced' | 'pending' | 'offline'
const _statusListeners = new Set();
let _syncState = 'idle';
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
  setSyncState('syncing');
  try {
    await _syncClient.push(await _exportFn());
    _pendingPush = false;
    setSyncState('synced');
  } catch (e) {
    _pendingPush = true;
    setSyncState('pending');
    console.warn('[gdrive] push failed:', e.message);
  }
}

export async function debouncedPush(exportFn, delayMs = 3000) {
  if (!_syncClient) return;
  _exportFn = exportFn;
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    // Offline: don't even try — flag it so we flush on reconnect.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      _pendingPush = true;
      setSyncState('offline');
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
  window.addEventListener('offline', () => setSyncState('offline'));
  window.addEventListener('online', () => {
    if (_pendingPush && _syncClient && _exportFn) pushNow();
    else setSyncState(_syncClient ? 'synced' : 'idle');
  });
  if (typeof navigator !== 'undefined' && !navigator.onLine) setSyncState('offline');
}
