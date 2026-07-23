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

import { mergeRecord, SONG_FILL_FIELDS, SETLIST_FILL_FIELDS } from './store.js';
import { GOOGLE_CLIENT_ID } from '../qualia/google-config.js';
import { tokenRow } from '../qualia/gdrive-diag.js';

const CLIENT_ID_KEY = 'voidstar.setlist.gdrive.clientId';
const TOKEN_KEY = 'voidstar.setlist.gdrive.token';
// Set once the user has actually completed a Drive connection. Since the
// app-owned client id makes getClientId() always truthy, needsReconnect() would
// otherwise read "reconnect" for a first-time visitor who never signed in.
const EVER_KEY = 'voidstar.setlist.gdrive.everConnected';
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

// ── Freshness bookkeeping ──
// The Drive data file's modifiedTime as of this device's last completed
// cycle. The automatic pulls (page load, refocus) compare a cheap files.list
// against it and skip the full download-merge-push when nothing moved.
const REMOTE_MODIFIED_KEY = 'voidstar.setlist.gdrive.remoteModifiedTime';
// Set the moment a local write schedules a push, cleared when a cycle
// confirms Drive has caught up. Persisted (not in-memory) because the classic
// loss case is closing the tab inside the 3 s push debounce — the next load
// must know Drive is still behind, or the freshness skip would strand the
// edit locally forever.
const DIRTY_KEY = 'voidstar.setlist.gdrive.dirtyAt';

function getLastRemoteModified() { return localStorage.getItem(REMOTE_MODIFIED_KEY) || ''; }
function setLastRemoteModified(t) { if (t) localStorage.setItem(REMOTE_MODIFIED_KEY, t); }
function markLocalDirty() { try { localStorage.setItem(DIRTY_KEY, String(Date.now())); } catch {} }
function getDirtyStamp() { return localStorage.getItem(DIRTY_KEY) || ''; }
export function isLocalDirty() { return !!getDirtyStamp(); }
// Compare-and-clear: a write that lands DURING a cycle bumps the stamp and
// must stay dirty for the next cycle — its data may have missed the export.
function clearDirtyIf(stamp) { if (getDirtyStamp() === stamp) localStorage.removeItem(DIRTY_KEY); }

let _gisPromise = null;

// Prefer a user-entered override (advanced / self-host); otherwise the
// app-owned client id, so "Sign in with Google" works with zero setup.
function getClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || GOOGLE_CLIENT_ID;
}

export function getClientIdOverride() {
  return localStorage.getItem(CLIENT_ID_KEY) || '';
}

export function usingAppClientId() {
  return !localStorage.getItem(CLIENT_ID_KEY) && !!GOOGLE_CLIENT_ID;
}

export function setClientId(id) {
  if (id) localStorage.setItem(CLIENT_ID_KEY, id);
  else localStorage.removeItem(CLIENT_ID_KEY); // clearing falls back to the app default
}

export function hasClientId() { return !!getClientId(); }

export function isGdriveBackupEnabled() {
  return !!getClientId() && !!getStoredToken();
}

// A client ID is configured but there's no valid (unexpired) token. The
// background sync path (page load / refocus) attempts a prompt:'none' renewal
// and armGestureRenewal retries inside the user's next real tap (see
// getAccessToken), so this only stays true — and drives the pill's
// "reconnect" state — when a silent grant genuinely isn't possible (no Google
// session, consent revoked, or the renewal popup blocked), at which point the
// UI invites a tap to reconnect.
export function needsReconnect() {
  return !!getClientId() && !getStoredToken() && localStorage.getItem(EVER_KEY) === '1';
}

export function getLastBackupTime() {
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  return raw ? parseInt(raw, 10) : null;
}

export function setLastBackupTime(ts) {
  localStorage.setItem(LAST_BACKUP_KEY, String(ts));
}

// Short relative-time string for status displays, e.g. "3m ago", "2h ago",
// "yesterday", or a plain date once it's more than a week old. Also used by
// the per-record "updated" stamps in views.js.
export function formatRelativeTime(ts) {
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

export function formatLastBackup() {
  const ts = getLastBackupTime();
  return ts ? formatRelativeTime(ts) : 'never';
}

// Read-only diagnostics for the settings troubleshooter. `live` adds a real
// Drive round-trip (silent token + peek) so "can this device reach Drive right
// now?" is answered without any of the merge/import side effects of a backup.
export async function gatherDiagnostics({ live = false } = {}) {
  const report = {
    app: 'setlist',
    generatedAt: new Date().toISOString(),
    sections: [
      { title: 'Identity', rows: [
        ['sign-in configured', hasClientId() ? 'yes' : 'NO — not configured on this deployment'],
        ['client id', usingAppClientId() ? 'app-owned' : (getClientIdOverride() ? 'your override' : 'none')],
      ] },
      { title: 'Auth', rows: [
        ['access token', tokenRow(TOKEN_KEY)],
        ['needs reconnect', needsReconnect() ? 'YES — tap the sync pill to reconnect' : 'no'],
        ['backup enabled', isGdriveBackupEnabled() ? 'yes' : 'no'],
      ] },
      { title: 'Sync', rows: [
        ['state', getBackupState()],
        ['syncing now', isSyncing() ? 'yes' : 'no'],
        ['network', (typeof navigator !== 'undefined' && !navigator.onLine) ? 'OFFLINE' : 'online'],
        ['last backup', formatLastBackup()],
        ['local edits unpushed', isLocalDirty() ? 'YES' : 'no'],
        ['last remote modifiedTime', getLastRemoteModified() || '(none)'],
      ] },
    ],
  };

  if (live) {
    const rows = [];
    try {
      // force: bypass the renewal-failure throttle — this is an explicit
      // button press, so report a REAL attempt, not a stale stamp.
      const token = await getAccessToken({ interactive: false, force: true });
      if (!token) {
        rows.push(['result', 'FAIL — silent renew failed (needs a live Google session; renewal popups can be blocked). Reconnect via the sync pill.']);
      } else {
        rows.push(['silent token', 'ok']);
        const client = await initGdriveBackup({ interactive: false });
        const peek = await client.peek();
        rows.push(['drive reachable', 'yes']);
        rows.push(['remote data file', peek ? JSON.stringify(peek) : 'none yet (empty Drive for this identity)']);
      }
    } catch (e) {
      rows.push(['result', `FAIL — ${e && e.message ? e.message : e}`]);
    }
    report.sections.push({ title: 'Live check', rows });
  }
  return report;
}

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

function getStoredToken() {
  try {
    const data = JSON.parse(localStorage.getItem(TOKEN_KEY));
    if (data && data.expiresAt > Date.now()) return data.token;
  } catch {}
  return null;
}

// Renewal-failure throttles (same machinery as the mind app's gdrive-sync).
// GIS "silent" renewal (prompt:'none') is really a POPUP under the hood — the
// token client has no iframe path — so a background attempt without transient
// user activation is popup-blocked in most browsers. And where popups ARE
// allowed (the installed desktop app window), an unthrottled attempt is worse:
// the popup flashes open, fails, closes, and its closing refocuses the app
// window — which used to re-fire the focus pull and spawn the next popup, an
// endless sign-in popup blitz on launch. Two stamps because the failure modes
// differ:
//   _renewFailedBgAt   — a gestureless attempt failed (usually popup-blocked);
//                        gates only further BACKGROUND attempts. A gesture
//                        attempt can still succeed where this one failed.
//   _renewFailedRealAt — an attempt WITH a gesture failed (signed out of
//                        Google, consent revoked); gates every silent attempt,
//                        or each tap would flash a doomed popup.
let _renewFailedBgAt = 0;
let _renewFailedRealAt = 0;
const RENEW_RETRY_MS = 5 * 60_000;

function storeToken(token, expiresIn) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    token,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  }));
  try { localStorage.setItem(EVER_KEY, '1'); } catch {}
  _renewFailedBgAt = 0;
  _renewFailedRealAt = 0;
}

// One token request. The `prompt` decides the UX: `'none'` completes without
// showing consent UI and errors if interaction is required (it still rides a
// popup window — see above); `''` auto-grants when it can and otherwise shows
// the consent/account chooser. A fresh client per call keeps concurrent
// requests from racing over a shared callback.
function requestTokenOnce(clientId, prompt = '') {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      prompt,
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

// Single-flight silent renewal: concurrent callers (the load-time pull racing
// the visibilitychange/focus one, a background chart-doc trash overlapping a
// cycle) collapse onto ONE prompt:'none' attempt — otherwise each would open
// its own GIS popup flow, and a losing sibling could stamp a failure throttle
// right after a winner stored a fresh token. `gesture` marks an attempt made
// with real user activation: its failure is definitive (no Google session /
// consent revoked), not just a blocked popup.
let _renewInflight = null;
function renewSilentlyOnce(clientId, { gesture = false } = {}) {
  if (_renewInflight) return _renewInflight;
  _renewInflight = (async () => {
    try {
      await loadGis();
      return await requestTokenOnce(clientId, 'none');
    } catch {
      const t = getStoredToken(); // another path may have landed a token meanwhile
      if (t) return t;
      if (gesture) _renewFailedRealAt = Date.now();
      else _renewFailedBgAt = Date.now();
      return null;
    } finally {
      _renewInflight = null;
    }
  })();
  return _renewInflight;
}

async function getAccessToken({ interactive = true, force = false } = {}) {
  const existing = getStoredToken();
  if (existing) return existing;

  const clientId = getClientId();
  if (!clientId) {
    if (!interactive) return null;
    throw new Error('Google Drive client ID not configured. Set it in Sources & Sync settings.');
  }

  // Background caller (auto-backup on page load / refocus, chart-doc
  // trash/archive): attempt a prompt:'none' renew, knowing it is a popup and
  // will usually be blocked outside a gesture — it still succeeds where the
  // browser allows it (installed-app window, granted popup permission), and
  // armGestureRenewal covers everyone else on their next real tap. Never
  // attempted for a user who never connected (no doomed popups for non-Drive
  // users), and throttled after failure so the focus churn of a failing popup
  // can't spawn the next attempt. `force` (diagnostics' live check — an
  // explicit button press) bypasses the throttle so the report reflects a
  // real attempt, not a stale stamp.
  if (!interactive) {
    if (localStorage.getItem(EVER_KEY) !== '1') return null;
    if (_renewInflight) return _renewInflight;
    const now = Date.now();
    if (!force && (now - _renewFailedBgAt < RENEW_RETRY_MS || now - _renewFailedRealAt < RENEW_RETRY_MS)) return null;
    return renewSilentlyOnce(clientId);
  }

  // Interactive (inside the user's gesture): if a silent renewal is already in
  // flight (e.g. the gesture-renewal listener fired on this very tap), join it
  // rather than racing a second popup out of the same gesture; only fall
  // through to the real consent/account chooser when it yields nothing.
  await loadGis();
  if (_renewInflight) {
    const t = await _renewInflight.catch(() => null);
    if (t) return t;
  }
  return requestTokenOnce(clientId, '');
}

// Load the GIS script ahead of need so a gesture-time renewal can call
// requestAccessToken synchronously inside the activation window. Skipped for
// a visitor who never connected Drive — nothing to renew, no Google fetch.
export function preloadGis() {
  if (localStorage.getItem(EVER_KEY) !== '1') return;
  loadGis().catch(() => {});
}

// Renew the lapsed token inside the user's NEXT real gesture (the pattern the
// mind app landed on). The GIS token client always opens a popup — even for
// prompt:'none' — and browsers block popups without transient user activation,
// which is why a load-time "silent" renew mostly fails. A capture-phase
// pointerdown/keydown listener calls requestTokenOnce synchronously in the
// gesture (no await first — GIS is preloaded), so once the ~1h token lapses,
// the user's first tap anywhere renews it with at most a brief popup flash,
// and `onRenewed` re-kicks the auto-pull.
let _gestureArmed = false;
export function armGestureRenewal(onRenewed) {
  if (_gestureArmed || typeof document === 'undefined') return;
  _gestureArmed = true;
  const maybeRenew = (ev) => {
    if (_renewInflight || getStoredToken()) return;
    // Never steal the gesture from a control that does its own interactive
    // auth (the sync pill, backup/restore buttons, chart-doc buttons) — a
    // silent popup here would consume the popup allowance and get the real
    // consent popup blocked.
    if (ev?.target instanceof Element && ev.target.closest('[data-sl-auth]')) return;
    if (localStorage.getItem(EVER_KEY) !== '1') return;
    if (Date.now() - _renewFailedRealAt < RENEW_RETRY_MS) return;
    if (!gisReady()) { loadGis().catch(() => {}); return; } // warm it for the next tap
    // Synchronous into requestTokenOnce (via renewSilentlyOnce) — no await
    // before the popup, so it opens inside this gesture's activation window.
    renewSilentlyOnce(getClientId(), { gesture: true })
      .then((t) => { if (t) onRenewed?.(); });
  };
  document.addEventListener('pointerdown', maybeRenew, { capture: true, passive: true });
  document.addEventListener('keydown', maybeRenew, { capture: true, passive: true });
}

// Trash (not hard-delete — recoverable from Drive's trash for ~30 days) a
// chart doc this app created. drive.file scope only reaches files the app
// made, so calling this on a community/foreign chart fails silently —
// exactly right when "rebuild doc" replaces a generated doc but should
// merely unlink anything else. Fire-and-forget; never blocks or breaks the
// caller. Only ever called after the user explicitly opted into trashing —
// the app never discards a chart doc on its own.
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

// The keep-it alternative to trashChartDoc: when a rebuild replaces a doc
// the user chose to keep, rename the old one with a "(replaced <date>)"
// suffix so it doesn't sit in the charts folder as an identically-named
// twin of the new doc. Same access model and fire-and-forget contract as
// trashChartDoc.
export async function archiveChartDoc(chartUrl) {
  const m = (chartUrl || '').match(/(?:file|document)\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return;
  try {
    const token = await getAccessToken({ interactive: false });
    if (!token) return;
    const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${m[1]}?fields=name`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!metaRes.ok) return;
    const { name } = await metaRes.json();
    if (!name || /\(replaced \d{4}-\d{2}-\d{2}\)$/.test(name)) return;
    const stamp = new Date().toISOString().slice(0, 10);
    await fetch(`https://www.googleapis.com/drive/v3/files/${m[1]}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${name} (replaced ${stamp})` }),
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
  // Always name the media part: a bare Blob in FormData uploads as
  // filename="blob", and Drive can surface that instead of the metadata name.
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), FILE_NAME);

  // fields=modifiedTime so the caller can record the file's new stamp for
  // the freshness check without a second metadata request.
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
    // Resolves to the written file's modifiedTime (the freshness stamp).
    async push(data) {
      const files = await findDataFiles(token);
      const file = files.length
        ? await updateFile(token, files[0].id, data)
        : await createFile(token, data);
      return file?.modifiedTime || '';
    },
    // Resolves to {data, modifiedTime, healed} or null when Drive is empty.
    // `healed` = duplicate data files were merged in (their content lives
    // only in `data` until a push writes it back — the cycle must not skip
    // the push in that case).
    async pull() {
      const files = await findDataFiles(token);
      if (!files.length) return null;
      let data = await readFile(token, files[0].id);
      let healed = false;
      // Two devices' first backups can race and create duplicate data files,
      // splitting the dataset (each device reads/writes "its" copy and never
      // sees the other's — reads as backup silently dropping records). Heal
      // it here: merge every duplicate into the newest and trash the extras
      // so all devices converge on one file.
      for (const dupe of files.slice(1)) {
        try {
          data = mergeData(data, await readFile(token, dupe.id));
          await trashFile(token, dupe.id);
          healed = true;
        } catch (e) {
          console.warn('[gdrive-backup] duplicate data file merge failed:', e.message);
        }
      }
      return { data, modifiedTime: files[0].modifiedTime || '', healed };
    },
    // One metadata request: enough for "did Drive change since I last
    // looked?" without downloading the file. `multiple` = unhealed
    // duplicates exist, so a full cycle is needed regardless.
    async peek() {
      const files = await findDataFiles(token);
      if (!files.length) return null;
      return { modifiedTime: files[0].modifiedTime || '', multiple: files.length > 1 };
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
    // The filename matters: a bare Blob uploads as filename="blob", and the
    // Docs conversion has been seen titling the new doc from it — the doc
    // then opens as "blob" instead of "Title - Artist".
    form.append('file', new Blob([content], { type: 'text/plain' }), name);
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

// PNG sibling of createChartDoc, for scratch-drawn charts: uploads the
// rendered page image into the same "voidstar charts" folder and returns
// its webViewLink. Deliberately an image, not a Docs conversion — the
// content is ink, and a Drive image rides the exact pipeline scanned
// charts already use (thumbnail render, offline cache, enhance, invert,
// and fresh annotations on top).
export async function createChartImageFile(song, blob) {
  const token = await getAccessToken({ interactive: true });
  if (!token) throw new Error('Google Drive not connected. Set a Client ID and connect in Settings.');

  const folderId = await findOrCreateChartsFolder(token);
  const base = song.artist ? `${song.title} - ${song.artist}` : song.title;
  const name = `${base} (chart).png`;
  const metadata = { name, parents: [folderId] };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  // Name the media part — a bare Blob uploads as filename="blob" (see
  // createChartDoc) and Drive can surface that as the file's name.
  form.append('file', blob, name);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Drive image upload failed: ${res.status}`);
  const file = await res.json();

  // Link-share like createChartDoc: the worker's thumbnail/caching paths
  // need it. Non-fatal — the owner's signed-in view still works without.
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

// ── Merge by "newer wins" — with field-level fill for content records ──
// Record-level "newer wins" alone LOSES DATA across devices: a stale copy of
// a song that later gets any small touch (a status toggle) carries the newer
// updatedAt and used to replace the whole record, wiping the steel summary /
// lyrics / chart link that only the other device's copy had. mergeRecord
// (store.js) keeps newer-wins for conflicts but never lets a blank field
// erase content — except when a clearedFields tombstone marks the blank as
// an explicit, more recent delete.

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

const recTs = (r) => r.updatedAt || r.createdAt || 0;

// Union both sides' deletion tombstones, newest deletedAt per key. Local
// objects keep their identity when they win (or tie) so recordsChanged's
// `cur === rec` short-circuit still works.
function mergeDeletions(localDel = [], remoteDel = []) {
  const map = new Map();
  for (const d of localDel) if (d && d.key) map.set(d.key, d);
  for (const d of remoteDel) {
    if (!d || !d.key) continue;
    const cur = map.get(d.key);
    if (!cur || (cur.deletedAt || 0) < (d.deletedAt || 0)) map.set(d.key, d);
  }
  return map;
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

// True when the merge would actually change local state — remote carries a
// record local lacks, a newer version of one, or content that field-fills
// into a local blank. Compared on the MERGED result (not raw timestamps —
// field-fill can enrich a local record that is itself the newer one). Lets
// pullMergePushCycle skip the import step (and its write-hook side effects)
// when a cycle finds nothing new — without this, the auto-push cycle would
// re-import identical data, fire the write hook, and reschedule itself
// forever. Records local wins untouched keep their object identity through
// mergeById, so the stringify compare short-circuits on `cur === rec`.
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
  return recordsChanged(local.songs, merged.songs)
    || recordsChanged(local.notes, merged.notes)
    || recordsChanged(local.setlists, merged.setlists)
    || recordsChanged(local.annotations, merged.annotations, 'songId')
    || recordsChanged(local.deletions || [], merged.deletions || [], 'key')
    || configChanged(local.sources, merged.sources)
    || configChanged(local.settings, merged.settings);
}

export function mergeData(local, remote) {
  const merged = {
    songs: mergeById(local.songs || [], remote.songs || [], 'id', SONG_FILL_FIELDS),
    notes: mergeById(local.notes || [], remote.notes || []),
    setlists: mergeById(local.setlists || [], remote.setlists || [], 'id', SETLIST_FILL_FIELDS),
    annotations: mergeById(local.annotations || [], remote.annotations || [], 'songId'),
    sources: mergeConfig(local.sources, remote.sources),
    settings: mergeConfig(local.settings, remote.settings),
  };
  // Deletion tombstones: a record whose tombstone is at least as new as its
  // last edit is dead — drop it from the merged arrays so a delete on one
  // device (or one this device made itself, with the record still in the
  // Drive file) can't be resurrected by the additive record merge above. A
  // record EDITED after its deletion beats the tombstone, which is then
  // retired so it can't shadow the record on a later cycle.
  const delMap = mergeDeletions(local.deletions, remote.deletions);
  const applyTombstones = (arr, storeName, keyField = 'id') => arr.filter(rec => {
    const d = delMap.get(`${storeName}:${rec[keyField]}`);
    if (!d) return true;
    if (recTs(rec) > (d.deletedAt || 0)) { delMap.delete(d.key); return true; }
    return false;
  });
  merged.songs = applyTombstones(merged.songs, 'songs');
  merged.notes = applyTombstones(merged.notes, 'notes');
  merged.setlists = applyTombstones(merged.setlists, 'setlists');
  merged.annotations = applyTombstones(merged.annotations, 'annotations', 'songId');
  merged.deletions = [...delMap.values()];
  return merged;
}

// No songs/setlists/notes/annotations — an empty library. Config (sources/
// settings) alone doesn't count: a backup file worth creating holds actual
// setlist data, not just a worker URL. Gates the "don't mint an empty first
// backup" rule in pullMergePushCycle.
function isEmptyDataset(d) {
  return !((d.songs && d.songs.length) || (d.setlists && d.setlists.length)
    || (d.notes && d.notes.length) || (d.annotations && d.annotations.length));
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
    const dirtyStamp = getDirtyStamp();
    const pulled = await client.pull();
    const remote = pulled ? pulled.data : null;
    const local = await exportFn();
    const merged = remote ? mergeData(local, remote) : local;
    // Import (and snapshot) only when remote actually changes something —
    // re-importing identical data would churn snapshots and re-fire the
    // write hook (which schedules another auto-push) on every cycle.
    const changed = remote ? mergeChangesLocal(local, merged) : false;
    if (changed && opts.snapshotFn) await opts.snapshotFn();
    if (changed) await importFn(merged);
    // Never mint a brand-new *empty* backup file. If Drive holds no data file
    // for the signed-in identity AND local has no songs/setlists/notes/
    // annotations, creating one would (a) read as "backed up just now" over an
    // empty set, and (b) — the real trap — mask the actual cause: this identity
    // (Google account + OAuth client id) isn't the one that holds the data.
    // drive.file only ever sees files the *current* identity created, so a
    // mismatched account/client id looks exactly like an empty Drive. Leave
    // Drive untouched, don't bump the "last backup" stamp, and tell the caller
    // nothing was there — so the UI can point at the identity instead of
    // silently reporting a fresh empty backup.
    if (!remote && isEmptyDataset(merged)) {
      return { merged, hadRemote: false, changed: false, pushed: false, emptyNoBackup: true };
    }
    // Push only when Drive doesn't already hold exactly this data. Pushing
    // identical bytes just bumps the remote modifiedTime — which every other
    // device's freshness check reads as "new remote data", making them all
    // re-download for nothing (and each other's pushes ping-pong forever).
    const pushNeeded = !remote || pulled.healed || mergeChangesLocal(remote, merged);
    let remoteModified = pulled ? pulled.modifiedTime : '';
    if (pushNeeded) {
      remoteModified = await client.push({ ...merged, version: 1, exportedAt: Date.now() });
      // Version history is best-effort — a failure here must not fail the sync.
      if (client.writeHistory) {
        try { await client.writeHistory(merged, !!opts.historyForce); }
        catch (e) { console.warn('[gdrive-backup] history write failed:', e.message); }
      }
    }
    setLastRemoteModified(remoteModified);
    clearDirtyIf(dirtyStamp);
    setLastBackupTime(Date.now());
    return { merged, hadRemote: !!remote, changed, pushed: pushNeeded };
  } finally {
    _syncing = false;
  }
}

// The cheap gate in front of the full cycle, for the AUTOMATIC pulls (page
// load, refocus): one files.list metadata request answers "did the Drive copy
// change since this device last completed a cycle?" — only a yes (or local
// edits Drive hasn't seen yet) pays for the full download-merge-push. Manual
// buttons never come through here; they stay an unconditional full cycle.
export async function pullMergePushIfStale(client, exportFn, importFn, opts = {}) {
  if (!isLocalDirty()) {
    try {
      const info = await client.peek();
      if (info && !info.multiple && info.modifiedTime && info.modifiedTime === getLastRemoteModified()) {
        setLastBackupTime(Date.now()); // verified current — the pill may say so
        return { merged: null, hadRemote: true, changed: false, fresh: true };
      }
    } catch (e) {
      console.warn('[gdrive-backup] freshness check failed, running a full cycle:', e.message);
    }
  }
  return pullMergePushCycle(client, exportFn, importFn, opts);
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
        const dirtyStamp = getDirtyStamp();
        setLastRemoteModified(await _backupClient.push(await _exportFn()));
        clearDirtyIf(dirtyStamp);
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
  // Record "local is ahead of Drive" BEFORE the debounce timer (and even with
  // no backup client yet): if the tab closes inside the delay, the next load
  // sees the dirty flag and runs a full push cycle instead of skipping on
  // "remote unchanged".
  markLocalDirty();
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
