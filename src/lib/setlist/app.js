// Setlist app controller — hash-based routing and view dispatch.

import * as store from './store.js';
import { initGdriveBackup, isSyncing, setBackupClient, pullMergePushIfStale, debouncedPush, watchConnectivity } from './gdrive-backup.js';
import { completeSpotifyLogin } from './spotify-auth.js';
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
  return { view, parts, id: parts[1] || null, extra: parts[2] || null, extra2: parts[3] || null, extra3: parts[4] || null };
}

async function route() {
  if (!_root) return;
  const { view, id, extra, extra2, extra3 } = parseHash();

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
          // /annotate/scratch = explicit blank-page chart authoring even
          // when a doc is linked; plain /annotate on a chartless song
          // falls into scratch mode on its own (see renderAnnotation).
          // /annotate/alt:<altId> = annotate one of the song's alternate
          // charts (its own layer, keyed store.altChartKey(songId, altId)).
          await renderAnnotation(_root, id, extra === '_' ? null : extra, {
            draw: true,
            scratch: extra3 === 'scratch',
            altId: extra3?.startsWith('alt:') ? extra3.slice(4) : null,
          });
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

// ── Auto-pull on page load and whenever the app is re-opened / refocused ──
// The key cross-device case: you edited on your PC, then open the app on your
// phone — it should start from the latest backup, never a stale local copy,
// without hunting for a button. Registered once, app-wide, so a fresh load or
// a return on ANY page pulls. Silent-only (never pops OAuth — GIS needs a
// real gesture, so an expired token just skips). Cheap when nothing moved:
// pullMergePushIfStale answers "did Drive change since this device's last
// cycle?" with one metadata request and only then pays for the full
// download-merge-push.
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
      const { changed } = await pullMergePushIfStale(
        client,
        () => store.exportAll(),
        (merged) => store.importAll(merged),
        { snapshotFn: () => store.putSnapshot('pre-sync') },
      );
      // Re-render so pulled changes show — but never yank the view out from
      // under someone mid-typing (would lose an unsaved input/textarea).
      // `changed` (not just "remote existed") so a no-op pull doesn't rebuild
      // the view for nothing on every refocus.
      if (changed) {
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
  // Pull on the initial load too — a fresh tab/session must start from the
  // latest backup no matter which hash it lands on (this used to happen only
  // on the dashboard). If the tab opened in the background, the
  // visibilitychange listener covers it when it first becomes visible.
  onReturn();
}

export function initSetlistApp(root) {
  _root = root;
  window.addEventListener('hashchange', route);
  // Auto-push every local write to Drive (debounced; a no-op until a backup
  // client exists). Wired here — not in any view — so edits made on a fresh
  // load straight into a song/setlist page back up without ever visiting the
  // dashboard, and so the persisted dirty flag is maintained from the very
  // first write.
  store.setOnWrite(() => debouncedPush(() => store.exportAll(), (merged) => store.importAll(merged)));
  watchConnectivity();
  watchFocusSync();
  // Finish a Spotify login redirect (?code=…) before the first render: it
  // rewrites the URL back to the saved hash via replaceState, which fires no
  // hashchange — so route once after it settles. On a normal load this
  // resolves immediately with null.
  completeSpotifyLogin().then(() => route());
}
