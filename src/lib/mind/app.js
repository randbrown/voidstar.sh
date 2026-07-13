// mind app controller — hash routing, init housekeeping, view dispatch.
// Mirrors setlist/app.js (navigate vs refresh semantics, error surface).

import * as store from './store.js';
import { invalidateIndex } from './search.js';
import { revokeObjectUrls, retryMissingImages } from './attachments.js';
import { processPendingOcr } from './ocr.js';
import {
  initGdriveSync, isSyncing, setSyncClient, pullMergePushIfStale,
  debouncedPush, watchConnectivity, hasClientId, markShardDirty,
} from './gdrive-sync.js';
import { pushPendingAttachments, wireLazyBlobFetch, wireImageRetry } from './attachments-drive.js';
import { renderHome } from './views/home.js';
import { renderEditor } from './views/editor.js';
import { renderAnnotate } from './views/annotate.js';
import { renderTasks } from './views/tasks.js';
import { renderTrash } from './views/trash.js';
import { renderSettings } from './views/settings.js';
import { renderCapture } from './views/capture.js';
import { initReminderScheduler } from './reminders.js';
import { wireCommandPalette } from './palette.js';

let _root = null;

export function navigate(hash) {
  location.hash = hash;
}

// ── Dock: the app's main menu, placeable top/bottom/left/right ──
// Position is a per-device preference (localStorage, never synced).
const DOCK_POS_KEY = 'voidstar.mind.dockPos';
export const DOCK_POSITIONS = ['top', 'bottom', 'left', 'right'];

export function getDockPos() {
  const p = localStorage.getItem(DOCK_POS_KEY);
  return DOCK_POSITIONS.includes(p) ? p : 'bottom';
}

export function setDockPos(pos) {
  if (!DOCK_POSITIONS.includes(pos)) return;
  localStorage.setItem(DOCK_POS_KEY, pos);
  document.body.dataset.mnDock = pos;
}

let _dock = null;

function renderDock() {
  if (_dock) return;
  _dock = document.createElement('nav');
  _dock.className = 'mn-dock';
  const items = [
    ['home', '&#8962;', 'notes', () => navigate('#home')],
    ['new', '&#65291;', 'new note', async () => {
      const { currentFolderId } = await import('./views/home.js');
      const note = store.createNote({ folderId: currentFolderId(), title: await store.uniqueAutoTitle() });
      await store.putNoteRaw(note);
      navigate(`#note/${note.id}`);
    }],
    ['tasks', '&#9745;', 'tasks', () => navigate('#tasks')],
    ['settings', '&#9881;', 'settings', () => navigate('#settings')],
  ];
  for (const [key, icon, label, onClick] of items) {
    const b = document.createElement('button');
    b.className = `mn-dock-btn ${key === 'new' ? 'mn-dock-primary' : ''}`;
    b.dataset.dock = key;
    b.innerHTML = `<span class="mn-dock-icon">${icon}</span><span class="mn-dock-label">${label}</span>`;
    b.addEventListener('click', onClick);
    _dock.appendChild(b);
  }
  document.body.appendChild(_dock);
  document.body.dataset.mnDock = getDockPos();
}

function updateDockActive(view) {
  if (!_dock) return;
  const active = view === 'trash' ? 'settings' : view === 'note' ? 'home' : view;
  _dock.querySelectorAll('.mn-dock-btn').forEach(b => {
    b.classList.toggle('mn-dock-on', b.dataset.dock === active);
  });
}

// ── PWA share target (GET): /lab/mind?title=…&text=…&url=… → new note ──
async function handleShareTarget() {
  const params = new URLSearchParams(location.search);
  const title = params.get('title') || '';
  const text = params.get('text') || '';
  const url = params.get('url') || '';
  if (!title && !text && !url) return false;

  const body = [text, url].filter(Boolean).join('\n\n');
  const { currentFolderId } = await import('./views/home.js');
  const note = store.createNote({
    folderId: currentFolderId(),
    title: title || await store.uniqueAutoTitle(),
    autoTitle: !title,
    body,
  });
  await store.putNoteRaw(note);
  // Strip the share params so a reload doesn't re-create the note.
  history.replaceState(null, '', location.pathname + `#note/${note.id}`);
  return true;
}

// Re-render the current route in place — navigate() to the current hash
// fires no hashchange, so views that mutate data call refresh() instead.
export function refresh() {
  route();
}

function parseHash() {
  const raw = (location.hash || '#').slice(1);
  const qIdx = raw.indexOf('?');
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const params = qIdx === -1 ? {} : Object.fromEntries(new URLSearchParams(raw.slice(qIdx + 1)));
  const parts = path.split('/').filter(Boolean);
  return { view: parts[0] || 'home', id: parts[1] || null, extra: parts[2] || null, extra2: parts[3] || null, params };
}

async function route() {
  if (!_root) return;
  const { view, id, extra, extra2, params } = parseHash();

  // Views hang teardown work (autosave flush, editor destroy) here.
  if (_root._mnCleanup) { try { await _root._mnCleanup(); } catch {} _root._mnCleanup = null; }
  revokeObjectUrls();
  _root.innerHTML = '';
  _root.className = 'mind-root';

  try {
    switch (view) {
      case 'home': await renderHome(_root); break;
      case 'note':
        if (extra === 'annotate' && extra2) await renderAnnotate(_root, id, extra2);
        else await renderEditor(_root, id, { highlight: params?.q || '' });
        break;
      case 'tasks': await renderTasks(_root, id); break;
      // Notification / reminder deep-link: `#task/<id>` → its list, focused.
      case 'task': {
        const t = id ? await store.getTask(id) : null;
        if (t && !t.deletedAt) await renderTasks(_root, t.listId);
        else await renderTasks(_root);
        break;
      }
      // Installed-PWA app-shortcut target: `#capture/voice/note|task`.
      case 'capture': await renderCapture(_root, id, extra); break;
      case 'trash': await renderTrash(_root); break;
      case 'settings': await renderSettings(_root); break;
      default: await renderHome(_root);
    }
  } catch (e) {
    // textContent, not innerHTML — error strings can quote note/import content.
    _root.innerHTML = '';
    const errBox = document.createElement('div');
    errBox.className = 'mn-error';
    errBox.textContent = `Error: ${e.message}`;
    _root.appendChild(errBox);
    console.error('[mind]', e);
  }
  updateDockActive(view);
}

// ── Auto-pull on load and refocus (setlist pattern) ──
// Opening the app on any device starts from the latest Drive copy — silent
// only (GIS needs a gesture for a fresh token; an expired one just skips
// and the settings/pill path reconnects).
let _focusWatched = false;
let _lastFocusPull = 0;
const FOCUS_PULL_MIN_MS = 30_000;

function watchFocusSync() {
  if (_focusWatched || typeof window === 'undefined') return;
  _focusWatched = true;

  const onReturn = async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (!hasClientId() || isSyncing()) return;
    if (Date.now() - _lastFocusPull < FOCUS_PULL_MIN_MS) return;

    const client = await initGdriveSync({ interactive: false }).catch(() => null);
    if (!client) return;
    _lastFocusPull = Date.now();
    setSyncClient(client);
    try {
      const { changed } = await pullMergePushIfStale(
        client,
        () => store.exportAll(),
        (merged) => store.importAll(merged),
        { snapshotFn: () => store.putSnapshot('pre-sync') },
      );
      pushPendingAttachments();
      // A focus pull can land an attachment's driveFileId (or reconnect Drive)
      // without changing anything the current view re-renders — nudge any
      // "unavailable" images to re-fetch their now-reachable binary.
      retryMissingImages();
      if (changed) {
        invalidateIndex();
        processPendingOcr();
        const ae = document.activeElement;
        const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
        if (!typing) refresh();
      }
    } catch (e) {
      console.warn('[mind-sync] focus pull:', e.message);
    }
  };

  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
  onReturn();
}

export function initMindApp(root) {
  _root = root;
  window.addEventListener('hashchange', route);
  wireCommandPalette(); // Ctrl/Cmd-K quick switcher

  // Every write invalidates the search index and (when Drive is connected)
  // schedules a debounced merge-push.
  store.setOnWrite((info) => {
    invalidateIndex();
    markShardDirty(info); // record which shard changed so push re-hashes only it
    debouncedPush(() => store.exportAll(), (merged) => store.importAll(merged));
  });
  wireLazyBlobFetch();
  wireImageRetry();
  watchConnectivity();
  watchFocusSync();
  // Local reminder scheduler: fires due time/place reminders while the app is
  // open or the installed PWA is running (no backend). Safe no-op where
  // Notifications are unavailable.
  initReminderScheduler(() => refresh());

  // Housekeeping: default TODO list, expired-tombstone purge, and the 24h
  // completed-task roll-off (at boot + hourly while the tab lives).
  const housekeeping = async () => {
    const rolled = await store.rollOffCompletedTasks();
    if (rolled) refresh();
  };
  (async () => {
    try {
      await store.ensureDefaultTasklist();
      await store.purgeExpiredTombstones();
      await housekeeping();
      // Drain any images still waiting on OCR (e.g. tab closed mid-queue).
      processPendingOcr();
    } catch (e) { console.warn('[mind] init housekeeping:', e.message); }
  })();
  setInterval(housekeeping, 3600_000);

  // Ask for durable storage so the browser doesn't evict IDB under pressure
  // (matters most on iOS Safari). Fire-and-forget; denial is fine.
  try { navigator.storage?.persist?.().catch(() => {}); } catch {}

  renderDock();

  // A share-target launch creates the note first, then routes into it.
  handleShareTarget()
    .catch((e) => console.warn('[mind] share target:', e.message))
    .finally(() => route());
}
