// mind app controller — hash routing, init housekeeping, view dispatch.
// Mirrors setlist/app.js (navigate vs refresh semantics, error surface).

import * as store from './store.js';
import { invalidateIndex } from './search.js';
import { revokeObjectUrls } from './attachments.js';
import { renderHome } from './views/home.js';
import { renderEditor } from './views/editor.js';
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
      case 'note': await renderEditor(_root, id, { annotate: extra === 'annotate' ? extra2 : null }); break;
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

export function initMindApp(root) {
  _root = root;
  window.addEventListener('hashchange', route);

  // Every write invalidates the search index. (P3 adds the debounced Drive
  // push here, same hook.)
  store.setOnWrite(() => invalidateIndex());

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
    } catch (e) { console.warn('[mind] init housekeeping:', e.message); }
  })();
  setInterval(housekeeping, 3600_000);

  // Ask for durable storage so the browser doesn't evict IDB under pressure
  // (matters most on iOS Safari). Fire-and-forget; denial is fine.
  try { navigator.storage?.persist?.().catch(() => {}); } catch {}

  route();
}
