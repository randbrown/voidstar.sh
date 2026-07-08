// mind app controller — hash routing, init housekeeping, view dispatch.
// Mirrors setlist/app.js (navigate vs refresh semantics, error surface).

import * as store from './store.js';
import { invalidateIndex } from './search.js';
import { revokeObjectUrls } from './attachments.js';
import { processPendingOcr } from './ocr.js';
import {
  initGdriveSync, isSyncing, setSyncClient, pullMergePushIfStale,
  debouncedPush, watchConnectivity, hasClientId,
} from './gdrive-sync.js';
import { pushPendingAttachments, wireLazyBlobFetch } from './attachments-drive.js';
import { renderHome } from './views/home.js';
import { renderEditor } from './views/editor.js';
import { renderAnnotate } from './views/annotate.js';
import { renderTasks } from './views/tasks.js';
import { renderTrash } from './views/trash.js';
import { renderSettings } from './views/settings.js';

let _root = null;

export function navigate(hash) {
  location.hash = hash;
}

// Re-render the current route in place — navigate() to the current hash
// fires no hashchange, so views that mutate data call refresh() instead.
export function refresh() {
  route();
}

function parseHash() {
  const h = (location.hash || '#').slice(1);
  const parts = h.split('/').filter(Boolean);
  return { view: parts[0] || 'home', id: parts[1] || null, extra: parts[2] || null, extra2: parts[3] || null };
}

async function route() {
  if (!_root) return;
  const { view, id, extra, extra2 } = parseHash();

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
        else await renderEditor(_root, id);
        break;
      case 'tasks': await renderTasks(_root, id); break;
      case 'trash': await renderTrash(_root); break;
      case 'settings': await renderSettings(_root); break;
      default: await renderHome(_root);
    }
  } catch (e) {
    _root.innerHTML = `<div class="mn-error">Error: ${e.message}</div>`;
    console.error('[mind]', e);
  }
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

  // Every write invalidates the search index and (when Drive is connected)
  // schedules a debounced merge-push.
  store.setOnWrite(() => {
    invalidateIndex();
    debouncedPush(() => store.exportAll(), (merged) => store.importAll(merged));
  });
  wireLazyBlobFetch();
  watchConnectivity();
  watchFocusSync();

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

  route();
}
