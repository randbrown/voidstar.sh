// Setlist app controller — hash-based routing and view dispatch.

import * as store from './store.js';
import { renderDashboard, renderLibrary, renderSetlistView, renderSetlistEdit, renderSongFocus, renderPerformMode, renderSettings, renderAnnotation } from './views.js';

let _root = null;
let _lastSongId = null;

export function getLastSongId() { return _lastSongId; }
export function setLastSongId(id) { _lastSongId = id; }

export function navigate(hash) {
  location.hash = hash;
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
        if (extra2 === 'chart' || extra2 === 'annotate') {
          await renderAnnotation(_root, id, extra === '_' ? null : extra);
        } else {
          await renderSongFocus(_root, id, extra);
        }
        break;
      case 'perform':
        await renderPerformMode(_root, id);
        break;
      default:
        await renderDashboard(_root);
    }
  } catch (e) {
    _root.innerHTML = `<div class="sl-error">Error: ${e.message}</div>`;
    console.error('[setlist]', e);
  }
}

export function initSetlistApp(root) {
  _root = root;
  window.addEventListener('hashchange', route);
  route();
}
