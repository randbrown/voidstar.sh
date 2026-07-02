// Setlist app controller — hash-based routing and view dispatch.

import * as store from './store.js';
import { initGdriveBackup, isSyncing, setBackupClient, pullMergePushCycle } from './gdrive-backup.js';
import { renderDashboard, renderLibrary, renderSetlistView, renderSetlistEdit, renderSongFocus, renderPerformMode, renderSettings, renderAnnotation } from './views.js';

let _root = null;
let _lastSongId = null;

export function getLastSongId() { return _lastSongId; }
export function setLastSongId(id) { _lastSongId = id; }

export function navigate(hash) {
  location.hash = hash;
}

// Re-render the current route in place. Needed because navigate() only sets
// location.hash, and assigning it its *current* value fires no hashchange —
// so handlers that "navigate" to the page they're already on (to reflect an
// edit) would otherwise be silent no-ops. Call refresh() instead in that case.
export function refresh() {
  route();
}

function parseHash() {
  const h = (location.hash || '#').slice(1);
  const parts = h.split('/').filter(Boolean);
  const view = parts[0] || 'home';
  return { view, parts, id: parts[1] || null, extra: parts[2] || null, extra2: parts[3] || null };
}

async function route() {
  if (!_root) return;
  const { view, id, extra, extra2 } = parseHash();

  _root.innerHTML = '';
  _root.className = 'setlist-root';

  try {
    switch (view) {
      case 'home':
        await renderDashboard(_root);
        break;
      case 'library':
        await renderLibrary(_root);
        break;
      case 'settings':
        await renderSettings(_root);
        break;
      case 'setlist':
        if (extra === 'edit') {
          await renderSetlistEdit(_root, id);
        } else {
          await renderSetlistView(_root, id);
        }
        break;
      case 'song':
        if (id) setLastSongId(id);
        if (extra2 === 'annotate') {
          await renderAnnotation(_root, id, extra === '_' ? null : extra, { draw: true });
        } else if (extra2 === 'chart') {
          // Legacy read-only chart page — folded into the song page, which
          // renders the chart (with annotations) inline.
          await renderSongFocus(_root, id, extra === '_' ? null : extra);
        } else {
          await renderSongFocus(_root, id, extra);
        }
        break;
      case 'perform':
        await renderPerformMode(_root, id, extra);
        break;
      default:
        await renderDashboard(_root);
    }
  } catch (e) {
    _root.innerHTML = `<div class="sl-error">Error: ${e.message}</div>`;
    console.error('[setlist]', e);
  }
}

// ── Auto-pull when the app is re-opened / refocused ──
// The key cross-device case: you edited on your PC, then open the app on your
// phone — it should show the latest without hunting for a button. Registered
// once, app-wide, so returning on ANY page pulls. Silent-only (never pops
// OAuth on focus — GIS needs a real gesture, so an expired token just skips).
let _focusWatched = false;
let _lastFocusPull = 0;
const FOCUS_PULL_MIN_MS = 30_000;

function watchFocusSync() {
  if (_focusWatched || typeof window === 'undefined') return;
  _focusWatched = true;

  const onReturn = async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (isSyncing()) return;
    if (Date.now() - _lastFocusPull < FOCUS_PULL_MIN_MS) return;

    const client = await initGdriveBackup({ interactive: false });
    if (!client) return; // no valid token — reconnect happens via the pill
    _lastFocusPull = Date.now();
    setBackupClient(client);
    try {
      const { hadRemote } = await pullMergePushCycle(
        client,
        () => store.exportAll(),
        (merged) => store.importAll(merged),
        { snapshotFn: () => store.putSnapshot('pre-sync') },
      );
      // Re-render so pulled changes show — but never yank the view out from
      // under someone mid-typing (would lose an unsaved input/textarea).
      if (hadRemote) {
        const ae = document.activeElement;
        const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
        if (!typing) refresh();
      }
    } catch (e) {
      console.warn('[gdrive-backup] focus pull:', e.message);
    }
  };

  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
}

export function initSetlistApp(root) {
  _root = root;
  window.addEventListener('hashchange', route);
  watchFocusSync();
  route();
}
