// Google Drive sync for the qualia workstation.
//
// A single OAuth (drive.file scope, Google Identity Services in the browser)
// that lets a performer log in and push/pull their whole qualia world to their
// own Google Drive. Everything lives under one top-level `voidstar_qualia`
// folder, with each sub-component in its own subfolder:
//
//   voidstar_qualia/
//     qualems/     — full qualem JSON snapshots
//     bundles/     — .qualem.zip bundles (qualem + loop WAVs + cab/amp + video)
//     video/       — video-quale clip files (mp4/webm)
//     rig/ fx/ strudel/ sequencer/ vocoder/ … — per-panel qualem sections
//
// This is the qualia sibling of the setlist app's gdrive-backup.js and the
// mind app's gdrive-sync.js — it forks their proven GIS auth + folder pattern
// (app-owned client id, drive.file scope, user override for self-hosts) rather
// than sharing code, because the data shapes and UX differ. The module is
// intentionally generic: it exposes folder-scoped file ops (save/list/read
// JSON or blobs) and leaves *what* to store to page-init.js / the fx that own
// each component's live state.
//
// drive.file scope means the app only ever sees files IT created — the user's
// other Drive files stay private and invisible to us.

import { GOOGLE_CLIENT_ID } from './google-config.js';
import { tokenRow } from './gdrive-diag.js';

const NS               = 'voidstar.qualia.gdrive';
const CLIENT_ID_KEY    = `${NS}.clientId`;
const TOKEN_KEY        = `${NS}.token`;
const EVER_KEY         = `${NS}.everConnected`;
const ROOT_FOLDER_NAME = 'voidstar_qualia';
const SCOPES           = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME      = 'application/vnd.google-apps.folder';

// The canonical set of sub-component subfolders. Callers pass a plain name to
// the file ops; this is just the vocabulary the UI browses and a guard that a
// typo doesn't silently scatter files into a new folder. Section names mirror
// the qualem QUALEM_SECTIONS keys in page-init.js.
export const SUBFOLDERS = [
  'qualems', 'bundles', 'video',
  'rig', 'fx', 'overlay', 'camWalk', 'audio', 'pose', 'camera',
  'sequencer', 'strudel', 'vocoder', 'auto',
];

// ── Client id (app-owned, with a self-host override) ───────────────────────
// Prefer a user-entered override (advanced / self-host); otherwise the
// app-owned client id, so "Sign in with Google" works with zero setup — the
// exact model the setlist + mind apps use.
function getClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || GOOGLE_CLIENT_ID;
}
export function getClientIdOverride() { return localStorage.getItem(CLIENT_ID_KEY) || ''; }
export function usingAppClientId() { return !localStorage.getItem(CLIENT_ID_KEY) && !!GOOGLE_CLIENT_ID; }
export function setClientId(id) {
  if (id) localStorage.setItem(CLIENT_ID_KEY, id);
  else localStorage.removeItem(CLIENT_ID_KEY); // clearing falls back to the app default
}
export function hasClientId() { return !!getClientId(); }

// ── Token cache ────────────────────────────────────────────────────────────
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
  try { localStorage.setItem(EVER_KEY, '1'); } catch {}
}

/** Connected = a client id is configured AND we hold a live (unexpired) token. */
export function isConnected() { return !!getClientId() && !!getStoredToken(); }
/** Connected before but the token lapsed. Non-interactive callers first attempt
 *  a SILENT renewal (see getAccessToken), so this only stays true when a silent
 *  grant isn't possible (no Google session, consent revoked, or third-party
 *  cookies blocked) — at which point the UI invites a tap to reconnect. Gated on
 *  having actually connected once, so a first-time visitor (who "has" the
 *  app-owned client id but never signed in) reads as "not connected", not
 *  "token expired". */
export function needsReconnect() {
  return !!getClientId() && !getStoredToken() && localStorage.getItem(EVER_KEY) === '1';
}

// ── Status broadcast (drives the drive pill) ───────────────────────────────
// States: 'idle' | 'connecting' | 'connected' | 'busy' | 'error'
const _stateListeners = new Set();
let _state = isConnected() ? 'connected' : 'idle';
export function getState() { return _state; }
export function onState(fn) {
  _stateListeners.add(fn);
  try { fn(_state); } catch {}
  return () => _stateListeners.delete(fn);
}
function setState(s) {
  _state = s;
  for (const fn of _stateListeners) { try { fn(s); } catch {} }
}

// ── Google Identity Services loader ────────────────────────────────────────
let _gisPromise = null;
function gisReady() {
  return typeof google !== 'undefined' && !!(google.accounts && google.accounts.oauth2);
}
// Memoize the load PROMISE, not a "tag exists" flag: a racing second caller
// that saw the just-appended <script> before it ran would proceed and hit
// `google is not defined`. Resolve only on the script's real load (or when the
// global is already present); a failed load clears the memo so a retry works.
function loadGis() {
  if (gisReady()) return Promise.resolve();
  if (_gisPromise) return _gisPromise;
  _gisPromise = new Promise((resolve, reject) => {
    const fail = () => { _gisPromise = null; reject(new Error('Failed to load Google Identity Services')); };
    let script = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (script) {
      if (gisReady()) return resolve();
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', fail, { once: true });
      return;
    }
    script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = () => resolve();
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return _gisPromise;
}

// One token request. `'none'` renews silently through a hidden iframe (no popup,
// no gesture) and errors if interaction is required; `''` renews silently when
// it can and otherwise shows the consent/account chooser. A fresh client per
// call keeps concurrent requests from racing over a shared callback.
function requestTokenOnce(clientId, prompt = '') {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      prompt,
      callback: (response) => {
        if (response.error) { reject(new Error(response.error_description || response.error)); return; }
        storeToken(response.access_token, parseInt(response.expires_in) || 3600);
        resolve(response.access_token);
      },
      error_callback: (err) => reject(new Error(err.message || err.type || 'Authorization Error')),
    });
    client.requestAccessToken();
  });
}

async function getAccessToken({ interactive = true } = {}) {
  const existing = getStoredToken();
  if (existing) return existing;

  const clientId = getClientId();
  if (!clientId) {
    if (!interactive) return null;
    throw new Error('Google Drive client ID not configured.');
  }
  await loadGis();

  // Background caller (e.g. a non-interactive listFiles): renew SILENTLY, never
  // any UI — so nothing pops up or errors on screen mid-performance. A failed
  // silent grant just returns null and the manual save/load prompts a reconnect.
  if (!interactive) {
    try { return await requestTokenOnce(clientId, 'none'); }
    catch { return null; }
  }

  // Interactive (inside the user's save/load gesture): silent when possible,
  // otherwise the consent/account chooser — one call keeps the gesture valid.
  return requestTokenOnce(clientId, '');
}

// Acquire (or refresh) the Drive token NOW, while still inside the user
// gesture — mobile browsers only allow the GIS consent popup in the immediate
// gesture window. Any handler that touches Drive must call this FIRST, before
// any `await`, or the popup gets blocked (same rule as the setlist app).
export async function ensureAccess() {
  setState('connecting');
  try {
    const token = await getAccessToken({ interactive: true });
    if (!token) throw new Error('Google Drive not connected.');
    setState('connected');
    return token;
  } catch (e) {
    setState(getStoredToken() ? 'connected' : 'error');
    throw e;
  }
}

export function signOut() {
  const token = getStoredToken();
  localStorage.removeItem(TOKEN_KEY);
  // Chosen disconnect — clear the "connected once" flag so the button reads
  // "connect drive" again rather than "reconnect".
  localStorage.removeItem(EVER_KEY);
  setState('idle');
  // Best-effort revoke so the grant doesn't linger server-side.
  if (token && typeof google !== 'undefined') {
    try { google.accounts.oauth2.revoke(token, () => {}); } catch {}
  }
}

// ── Folder resolution (serialized, dup-healing-lite) ───────────────────────
// Folder id caches, keyed by name. In-flight promises serialize concurrent
// resolves for the same key so two callers never race to create duplicate
// folders (the failure mode the mind app hit and had to heal).
const _folderIds = new Map();      // name → id
const _folderInflight = new Map(); // name → Promise<id>

function folderCacheKey(name, parentId) { return parentId ? `${parentId}/${name}` : name; }

async function driveList(token, params) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams(params)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive search failed: ${res.status}`);
  return (await res.json()).files || [];
}

async function createFolder(token, name, parentId) {
  const body = { name, mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Drive folder create failed: ${res.status}`);
  return (await res.json()).id;
}

async function resolveFolder(token, name, parentId = null) {
  const key = folderCacheKey(name, parentId);
  if (_folderIds.has(key)) return _folderIds.get(key);
  if (_folderInflight.has(key)) return _folderInflight.get(key);

  const p = (async () => {
    const q = [
      `name='${name.replace(/'/g, "\\'")}'`,
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
      parentId ? `'${parentId}' in parents` : `'root' in parents`,
    ].join(' and ');
    // Oldest-first so every device converges on the same folder if two exist.
    const files = await driveList(token, {
      q, spaces: 'drive', fields: 'files(id,name,createdTime)',
      orderBy: 'createdTime', pageSize: '10',
    });
    const id = files[0]?.id || await createFolder(token, name, parentId);
    _folderIds.set(key, id);
    return id;
  })();
  _folderInflight.set(key, p);
  try { return await p; }
  finally { _folderInflight.delete(key); }
}

async function getRootFolderId(token) { return resolveFolder(token, ROOT_FOLDER_NAME, null); }

async function getSubFolderId(token, sub) {
  const rootId = await getRootFolderId(token);
  return resolveFolder(token, sub, rootId);
}

// ── File ops (folder-scoped) ───────────────────────────────────────────────
async function findFileInFolder(token, folderId, name) {
  const files = await driveList(token, {
    q: `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
    spaces: 'drive', fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc', pageSize: '1',
  });
  return files[0] || null;
}

async function createFileMultipart(token, folderId, name, blob, mimeType) {
  const metadata = { name, parents: [folderId] };
  if (mimeType) metadata.mimeType = mimeType;
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  // Always name the media part — a bare Blob uploads as filename="blob", which
  // Drive can surface instead of the metadata name.
  form.append('file', blob, name);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status}`);
  return res.json();
}

async function updateFileMedia(token, fileId, blob, mimeType) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,modifiedTime`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, ...(mimeType ? { 'Content-Type': mimeType } : {}) },
    body: blob,
  });
  if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
  return res.json();
}

// Upsert a blob into a subfolder by name: update the existing same-named file
// in place, else create it. Saves are idempotent — re-saving a qualem of the
// same name overwrites rather than piling up duplicates.
async function upsertBlob(token, sub, name, blob, mimeType) {
  const folderId = await getSubFolderId(token, sub);
  const existing = await findFileInFolder(token, folderId, name);
  return existing
    ? updateFileMedia(token, existing.id, blob, mimeType)
    : createFileMultipart(token, folderId, name, blob, mimeType);
}

/** Save a JSON-serializable object as `<name>` into the `<sub>` subfolder. */
export async function saveJson(sub, name, obj) {
  const token = await ensureAccess();
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  setState('busy');
  try { return await upsertBlob(token, sub, name, blob, 'application/json'); }
  finally { setState(isConnected() ? 'connected' : 'idle'); }
}

/** Save a binary blob (video clip, .zip bundle, WAV, …) into `<sub>`. */
export async function saveBlob(sub, name, blob, mimeType) {
  const token = await ensureAccess();
  setState('busy');
  try { return await upsertBlob(token, sub, name, blob, mimeType || blob.type || 'application/octet-stream'); }
  finally { setState(isConnected() ? 'connected' : 'idle'); }
}

/** List the files in a subfolder, newest-modified first. Returns [] when the
 *  subfolder doesn't exist yet (nothing has been saved there). */
export async function listFiles(sub, { interactive = true } = {}) {
  const token = interactive ? await ensureAccess() : await getAccessToken({ interactive: false });
  if (!token) return [];
  const rootId = await getRootFolderId(token);
  // Don't create the subfolder just to list it — resolve without side effects.
  const found = await driveList(token, {
    q: `name='${sub.replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and '${rootId}' in parents and trashed=false`,
    spaces: 'drive', fields: 'files(id)', orderBy: 'createdTime', pageSize: '1',
  });
  const folderId = found[0]?.id;
  if (!folderId) return [];
  return driveList(token, {
    q: `'${folderId}' in parents and trashed=false`,
    spaces: 'drive', fields: 'files(id,name,mimeType,modifiedTime,size)',
    orderBy: 'modifiedTime desc', pageSize: '100',
  });
}

/** Which subfolders actually hold files, as `{ sub: count }` — one listing per
 *  known subfolder. Used to render the browse UI without empty rows. */
export async function listPopulatedSubfolders() {
  const token = await ensureAccess();
  if (!token) return {};
  const rootId = await getRootFolderId(token);
  const folders = await driveList(token, {
    q: `mimeType='${FOLDER_MIME}' and '${rootId}' in parents and trashed=false`,
    spaces: 'drive', fields: 'files(id,name)', pageSize: '100',
  });
  const out = {};
  for (const f of folders) {
    const kids = await driveList(token, {
      q: `'${f.id}' in parents and trashed=false`,
      spaces: 'drive', fields: 'files(id)', pageSize: '100',
    });
    if (kids.length) out[f.name] = kids.length;
  }
  return out;
}

export async function readJson(fileId) {
  const token = await ensureAccess();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive read failed: ${res.status}`);
  return res.json();
}

export async function readBlob(fileId) {
  const token = await ensureAccess();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive read failed: ${res.status}`);
  return res.blob();
}

export async function trashFile(fileId) {
  const token = await ensureAccess();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) throw new Error(`Drive trash failed: ${res.status}`);
}

// Sanitize a display name into a safe Drive filename fragment.
export function safeName(s, fallback = 'file') {
  return (String(s || '').replace(/[^\w.-]+/g, '_').slice(0, 80) || fallback);
}

// ── Diagnostics ─────────────────────────────────────────────────────────────
// Read-only troubleshooter for the qualia admin/util screen. `live` adds a
// silent token + a non-creating root-folder listing so "can I reach Drive?" is
// answered without any automatic sync — nothing here writes or pops up UI, so
// it's safe to run mid-session.
export async function gatherDiagnostics({ live = false } = {}) {
  const report = {
    app: 'qualia',
    generatedAt: new Date().toISOString(),
    sections: [
      { title: 'Identity', rows: [
        ['sign-in configured', hasClientId() ? 'yes' : 'NO — not configured on this deployment'],
        ['client id', usingAppClientId() ? 'app-owned' : (getClientIdOverride() ? 'your override' : 'none')],
      ] },
      { title: 'Auth', rows: [
        ['access token', tokenRow(TOKEN_KEY)],
        ['connected', isConnected() ? 'yes' : 'no'],
        ['needs reconnect', needsReconnect() ? 'YES — Save/Load will prompt sign-in' : 'no'],
        ['pill state', getState()],
        ['network', (typeof navigator !== 'undefined' && !navigator.onLine) ? 'OFFLINE' : 'online'],
      ] },
    ],
  };

  if (live) {
    const rows = [];
    try {
      const token = await getAccessToken({ interactive: false });
      if (!token) {
        rows.push(['result', 'FAIL — no token; silent renew failed. Use Save/Load to sign in.']);
      } else {
        rows.push(['silent token', 'ok']);
        const roots = await driveList(token, {
          q: `name='${ROOT_FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`,
          spaces: 'drive', fields: 'files(id,name)', pageSize: '5',
        });
        rows.push(['drive reachable', 'yes']);
        rows.push(['voidstar_qualia folder', roots.length ? `found${roots.length > 1 ? ` (${roots.length} — duplicates!)` : ''}` : 'not created yet']);
      }
    } catch (e) {
      rows.push(['result', `FAIL — ${e && e.message ? e.message : e}`]);
    }
    report.sections.push({ title: 'Live check', rows });
  }
  return report;
}
