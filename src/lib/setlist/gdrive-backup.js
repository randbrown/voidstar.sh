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

// Trash (not hard-delete — recoverable from Drive's trash) a chart doc this
// app created. drive.file scope only reaches files the app made, so calling
// this on a community/foreign chart fails silently — exactly right when
// "rebuild doc" replaces a generated doc but should merely unlink anything
// else. Fire-and-forget; never blocks or breaks the caller.
export async function trashChartDoc(chartUrl) {
  const m = (chartUrl || '').match(/(?:file|document)\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return;
  try {
    const token = await getAccessToken({ interactive: false });
    if (!token) return;
    await fetch(`https://www.googleapis.com/drive/v3/files/${m[1]}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  } catch {}
}

// Acquire (or refresh) the Drive OAuth token NOW, while still inside a user
// gesture. Mobile browsers only allow the GIS consent popup in the immediate
// gesture window — an await-heavy flow that asks for the token after seconds
// of research gets the popup blocked and dies. Long flows (create chart doc)
// call this first thing in their tap handler; the cached token (~1h) then
// covers the actual Drive calls that happen after the slow work.
export async function ensureDriveAccess() {
  const token = await getAccessToken({ interactive: true });
  if (!token) throw new Error('Google Drive not connected. Set a Client ID and connect in Settings.');
}

// All data files matching FILE_NAME, newest-modified first. Ordered so every
// device deterministically picks the same (newest) file — an unordered
// pageSize-1 lookup let two devices bind to different duplicates and each
// miss the other's edits.
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
      const files = await findDataFiles(token);
      if (files.length) {
        await updateFile(token, files[0].id, data);
      } else {
        await createFile(token, data);
      }
    },
    async pull() {
      const files = await findDataFiles(token);
      if (!files.length) return null;
      let data = await readFile(token, files[0].id);
      // Two devices' first backups can race and create duplicate data files,
      // splitting the dataset (each device reads/writes "its" copy and never
      // sees the other's — reads as backup silently dropping records). Heal
      // it here: merge every duplicate into the newest and trash the extras
      // so all devices converge on one file.
      for (const dupe of files.slice(1)) {
        try {
          data = mergeData(data, await readFile(token, dupe.id));
          await trashFile(token, dupe.id);
        } catch (e) {
          console.warn('[gdrive-backup] duplicate data file merge failed:', e.message);
        }
      }
      return data;
    },
    // Version history (rotating timestamped copies). Methods close over the
    // token so callers never handle it directly.
    writeHistory: (data, force = false) => writeHistorySnapshot(token, data, force),
    listHistory: () => listHistory(token),
    readHistory: (fileId) => readFile(token, fileId),
  };
}

// ── Tier 4 chart fallback: create a chart doc when nothing matched ──
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

// Creates a Google Doc chart for a song, inside a dedicated "voidstar
// charts" Drive folder, and returns its webViewLink. `content` is the chart
// text (drafted from web chord data or a fill-in template — see
// chart-build.js); uploading it as text/plain with a Google-Doc target
// mimeType makes Drive convert it into a real Doc. Deliberately a Doc (not a
// Drawing): the worker's existing chart-scraping already understands Google
// Docs' plain-text export, so "scrape" picks up key/BPM/section data for
// free. For freeform hand-drawn charts, the in-app annotation canvas already
// draws on top of any linked document, covering that case without needing
// Drive Drawing support.
export async function createChartDoc(song, content = '') {
  const token = await getAccessToken({ interactive: true });
  if (!token) throw new Error('Google Drive not connected. Set a Client ID and connect in Settings.');

  const folderId = await findOrCreateChartsFolder(token);
  const name = song.artist ? `${song.title} - ${song.artist}` : song.title;
  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.document',
    parents: [folderId],
  };

  let res;
  if (content) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: 'text/plain' }));
    res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form,
    });
  } else {
    res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  }
  if (!res.ok) throw new Error(`Drive doc create failed: ${res.status}`);
  const file = await res.json();

  // Make the doc link-shared (anyone with the link, read-only). The whole
  // chart pipeline assumes it: the worker reaches files with an API key —
  // scraping ("scrape"), thumbnail rasterizing, and offline caching all 404
  // on a private doc. Worse, Drive's thumbnail endpoint answers a private
  // fetch with a login page, which used to get cached as the "chart image".
  // Non-fatal: a doc without this still works via the signed-in iframe view.
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
  } catch {}

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

// Config objects (sources, settings) merge by "filled wins": local values
// win only when actually set; gaps fill from remote. The old
// `local.sources || remote.sources` treated a fresh device's empty {} as
// truthy — connecting Drive on a new device clobbered the backed-up sources
// with nothing, and new devices never inherited the worker URL / folders.
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

// True when merging `remote` into `local` would change local state: remote
// carries a record local lacks, a newer version of one it has, or config
// values local is missing. Lets pullMergePushCycle skip the import step (and
// its write-hook side effects) when a cycle finds nothing new — without this,
// the auto-push cycle would re-import identical data, fire the write hook,
// and reschedule itself forever.
function remoteHasNews(local, remote) {
  const newer = (l = [], r = [], keyField = 'id') => {
    const map = new Map(l.map(i => [i[keyField], i]));
    return r.some(rec => {
      const cur = map.get(rec[keyField]);
      if (!cur) return true;
      return (rec.updatedAt || rec.createdAt || 0) > (cur.updatedAt || cur.createdAt || 0);
    });
  };
  return newer(local.songs, remote.songs)
    || newer(local.notes, remote.notes)
    || newer(local.setlists, remote.setlists)
    || newer(local.annotations, remote.annotations, 'songId')
    || configChanged(local.sources, remote.sources)
    || configChanged(local.settings, remote.settings);
}

export function mergeData(local, remote) {
  return {
    songs: mergeById(local.songs || [], remote.songs || []),
    notes: mergeById(local.notes || [], remote.notes || []),
    setlists: mergeById(local.setlists || [], remote.setlists || []),
    annotations: mergeById(local.annotations || [], remote.annotations || [], 'songId'),
    sources: mergeConfig(local.sources, remote.sources),
    settings: mergeConfig(local.settings, remote.settings),
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
//                 for "undo last sync"). Only runs when the remote data will
//                 actually change local state.
//   historyForce — force a Drive version-history write even inside the throttle
//                 window (manual actions pass true; auto-sync leaves it false).
export async function pullMergePushCycle(client, exportFn, importFn, opts = {}) {
  if (_syncing) return { merged: null, hadRemote: false, changed: false, skipped: true };
  _syncing = true;
  try {
    const remote = await client.pull();
    const local = await exportFn();
    const merged = remote ? mergeData(local, remote) : local;
    // Import (and snapshot) only when remote actually changes something —
    // re-importing identical data would churn snapshots and re-fire the
    // write hook (which schedules another auto-push) on every cycle.
    const changed = remote ? remoteHasNews(local, remote) : false;
    if (changed && opts.snapshotFn) await opts.snapshotFn();
    if (changed) await importFn(merged);
    await client.push({ ...merged, version: 1, exportedAt: Date.now() });
    // Version history is best-effort — a failure here must not fail the sync.
    if (client.writeHistory) {
      try { await client.writeHistory(merged, !!opts.historyForce); }
      catch (e) { console.warn('[gdrive-backup] history write failed:', e.message); }
    }
    setLastBackupTime(Date.now());
    return { merged, hadRemote: !!remote, changed };
  } finally {
    _syncing = false;
  }
}

let _pushTimer = null;
let _backupClient = null;
let _exportFn = null;
let _importFn = null;
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
  setBackupState('syncing');
  try {
    if (_importFn) {
      // Auto-push runs the same pull→merge→push cycle as every other path: a
      // blind push would overwrite Drive with this device's dataset and
      // silently drop whatever another device pushed since our last pull —
      // the classic two-devices-open "one backup overwrote another".
      await pullMergePushCycle(_backupClient, _exportFn, _importFn);
    } else {
      _syncing = true;
      try {
        await _backupClient.push(await _exportFn());
        setLastBackupTime(Date.now());
      } finally {
        _syncing = false;
      }
    }
    _pendingPush = false;
    setBackupState('synced');
  } catch (e) {
    _pendingPush = true;
    setBackupState('pending');
    console.warn('[gdrive-backup] push failed:', e.message);
  }
}

export async function debouncedPush(exportFn, importFn, delayMs = 3000) {
  if (!_backupClient) return;
  _exportFn = exportFn;
  if (importFn) _importFn = importFn;
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
