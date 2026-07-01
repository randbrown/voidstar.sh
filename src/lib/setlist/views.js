// All view renderers for the setlist lab.

import * as store from './store.js';
import { navigate, refresh, getLastSongId, setLastSongId } from './app.js';
import { parseTextList, isSpotifyUrl } from './import.js';
import { renderSpotifyEmbed, getSpotifyOpenUrl, fetchOEmbed, parseSpotifyUrl } from './spotify.js';
import { createDictation, isSupported as voiceSupported } from './voice.js';
import { getSources, setSources, syncSetlist, syncAll, spotifySearchUrl, parseBatchChartUrls, deepScrapeChart, searchChartForSong } from './sync.js';
import { findBestMatch as fuzzyMatch } from './match.js';
import { initGdriveBackup, isGdriveBackupEnabled, needsReconnect, isSyncing, setBackupClient, debouncedPush, watchConnectivity, onBackupState, pullMergePushCycle, formatLastBackup, createBlankChartDoc } from './gdrive-backup.js';
import { initAnnotationCanvas, loadAnnotation, renderReadonlyAnnotations } from './annotation.js';
import { cacheSetlistCharts, cacheAllCharts, getSetlistOfflineStatus, getAllChartsOfflineStatus, getOfflineChartUrl, CHART_CACHED_EVENT } from './chart-cache.js';

function formatTimecode(seconds) {
  if (seconds == null) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseTimecodeInput(val) {
  if (val.includes(':')) {
    const [m, s] = val.split(':').map(Number);
    return (m || 0) * 60 + (s || 0);
  }
  return parseInt(val) || 0;
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function uploadJson() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        resolve(JSON.parse(text));
      } catch { resolve(null); }
    });
    input.click();
  });
}

// ── Helpers ──

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

function btn(label, cls, onclick) {
  const b = el('button', `sl-btn ${cls || ''}`, label);
  b.addEventListener('click', onclick);
  return b;
}

function topBar(title, backHash) {
  const bar = el('div', 'sl-topbar');
  if (backHash) {
    const back = btn('&larr;', 'sl-btn-icon', () => navigate(backHash));
    bar.appendChild(back);
  }
  const t = el('span', 'sl-topbar-title', title);
  bar.appendChild(t);
  return bar;
}

function emptyState(msg) {
  return el('div', 'sl-empty', msg);
}

// Transient toast with an Undo action. Used for destructive taps (note delete)
// so an accidental swipe/press during a live set is one tap to recover.
let _activeToast = null;
function showUndoToast(msg, onUndo, ms = 6000) {
  if (_activeToast) _activeToast.remove();
  const toast = el('div', 'sl-toast');
  toast.appendChild(el('span', 'sl-toast-msg', msg));
  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    window.removeEventListener('hashchange', dismiss);
    toast.remove();
    if (_activeToast === toast) _activeToast = null;
  };
  const undoBtn = btn('undo', 'sl-btn-sm sl-btn-accent', () => { dismiss(); onUndo(); });
  toast.appendChild(undoBtn);
  document.body.appendChild(toast);
  _activeToast = toast;
  timer = setTimeout(dismiss, ms);
  // Leaving the view (e.g. swiping to the next song) clears the toast so it
  // can't linger over unrelated content.
  window.addEventListener('hashchange', dismiss);
  return dismiss;
}

function keyBadge(key, origKey) {
  if (!key) return '';
  const label = origKey && origKey !== key ? `${key} <span class="sl-orig">(orig ${origKey})</span>` : key;
  return `<span class="sl-key-badge">${label}</span>`;
}

function vocalistDot(code, legend) {
  if (!code) return '';
  const name = legend?.[code] || code;
  return `<span class="sl-vocalist" data-v="${code}" title="${name}">${code}</span>`;
}

// Lock a chart box's aspect-ratio to the chart IMAGE's natural dimensions, so
// the chart renders at the document's true page aspect (not the annotation's
// authoring/viewport shape) — no stretch. The chart image and the annotation
// canvas both fill this box, so strokes stay pinned to the same chart content
// at any box aspect; only the box's shape changes. naturalWidth/naturalHeight
// are readable even for the cross-origin Drive thumbnail (only pixel data is
// tainted). Marks the box so the authoring-aspect fallback won't clobber it.
function lockAspectToImage(img, box) {
  const apply = () => {
    if (img.naturalWidth && img.naturalHeight) {
      box.style.aspectRatio = String(img.naturalWidth / img.naturalHeight);
      box.dataset.naturalAspect = '1';
    }
  };
  if (img.complete && img.naturalWidth) apply();
  else img.addEventListener('load', apply, { once: true });
}

// ── Shared Google Drive sync (used by Settings, per-page buttons, the pill) ──

function formatGdriveError(e) {
  const msg = e.message || String(e);
  if (msg.includes('invalid_client') || msg.includes('no registered origin') || msg.includes('Authorization Error')) {
    return `OAuth error: add ${location.origin} as an authorized JavaScript origin in your Google Cloud Console → Credentials → OAuth client ID`;
  }
  if (msg.includes('popup_closed') || msg.includes('user_cancel')) {
    return 'Sign-in cancelled.';
  }
  return `Error: ${msg}`;
}

// One implementation for every "sync now" affordance. Runs the safe
// pull→merge→push cycle, snapshotting local state before any remote import so
// the sync is reversible, and reports status into an optional element.
// Returns true on success. `interactive` controls whether an expired token may
// trigger the OAuth popup (only from a real user gesture).
async function runManualSync(statusEl, { interactive = true } = {}) {
  const setStatus = (text, color) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = color || '';
  };
  if (isSyncing()) { setStatus('Sync already in progress…'); return false; }

  let client;
  try {
    client = await initGdriveBackup({ interactive });
  } catch (e) {
    setStatus(formatGdriveError(e), 'var(--pink)');
    return false;
  }
  if (!client) {
    setStatus(needsReconnect()
      ? 'Google Drive needs reconnecting — tap the sync pill on the home screen.'
      : 'Set a Google OAuth Client ID in Settings to enable backup.', 'var(--pink)');
    return false;
  }

  setBackupClient(client);
  setStatus('Syncing…', '');
  try {
    await pullMergePushCycle(
      client,
      () => store.exportAll(),
      (merged) => store.importAll(merged),
      { snapshotFn: () => store.putSnapshot('pre-sync'), historyForce: true },
    );
    setStatus(`✓ synced · ${formatLastBackup()}`, 'var(--green)');
    return true;
  } catch (e) {
    setStatus(formatGdriveError(e), 'var(--pink)');
    return false;
  }
}

// A compact "sync now" button + inline status, for edit-page action bars. On
// success it re-renders the page shortly after so any pulled-in changes show.
function syncNowButton() {
  const wrap = el('div', 'sl-sync-inline');
  const status = el('span', 'sl-hint sl-sync-inline-status');
  const b = btn('⟲ sync', 'sl-btn-ghost sl-btn-sm', async () => {
    const ok = await runManualSync(status, { interactive: true });
    if (ok) setTimeout(() => refresh(), 900);
  });
  wrap.appendChild(b);
  wrap.appendChild(status);
  return wrap;
}

// ── Dashboard ──

export async function renderDashboard(root) {
  const bar = topBar('setlist');
  const homeLink = el('a', 'sl-btn sl-btn-icon', '⬡');
  homeLink.href = '/';
  homeLink.title = 'voidstar.sh';
  homeLink.style.textDecoration = 'none';
  bar.insertBefore(homeLink, bar.firstChild);
  const actions = el('div', 'sl-actions');
  actions.appendChild(btn('+ new setlist', 'sl-btn-primary', async () => {
    const name = prompt('Setlist name:');
    if (!name) return;
    const sl = store.createSetlist(name);
    await store.putSetlist(sl);
    navigate(`#setlist/${sl.id}/edit`);
  }));
  actions.appendChild(btn('library', 'sl-btn-ghost', () => navigate('#library')));
  actions.appendChild(btn('sources', 'sl-btn-ghost', () => navigate('#settings')));
  bar.appendChild(actions);
  root.appendChild(bar);

  // Connectivity / backup pill. Shows 'offline' when the device is offline;
  // (when Drive backup is on) syncing / unsynced / synced so the user knows
  // edits are safe; and 'reconnect' when a client is configured but the OAuth
  // token has lapsed (a silent refresh is impossible — GIS needs a gesture).
  // Tapping the pill syncs now, or reconnects when needed. Tooltip carries the
  // last-successful-backup time.
  const pill = el('div', 'sl-sync-pill');
  root.appendChild(pill);
  const gbackup = isGdriveBackupEnabled();
  const reconnect = needsReconnect();
  const paintPill = (state) => {
    const online = typeof navigator === 'undefined' || navigator.onLine;
    let text = '', cls = '';
    if (!online) { text = '● offline'; cls = 'sl-sync-offline'; }
    else if (reconnect) { text = '↻ reconnect'; cls = 'sl-sync-reconnect'; }
    else if (!gbackup) { text = ''; }
    else if (state === 'syncing') { text = '⟳ backing up…'; cls = 'sl-sync-syncing'; }
    else if (state === 'pending') { text = '● unsaved changes'; cls = 'sl-sync-pending'; }
    else if (state === 'synced') { text = '✓ backed up'; cls = 'sl-sync-synced'; }
    else if (gbackup) { text = '✓ backed up'; cls = 'sl-sync-synced'; }
    pill.className = `sl-sync-pill ${cls}`;
    if (gbackup || reconnect) pill.classList.add('sl-sync-tappable');
    pill.textContent = text;
    pill.title = gbackup ? `Last backup: ${formatLastBackup()} — tap to sync`
      : reconnect ? 'Tap to reconnect Google Drive' : '';
  };
  pill.addEventListener('click', async () => {
    if (isSyncing()) return;
    if (reconnect) {
      // User gesture → interactive re-auth is allowed.
      const ok = await runManualSync(null, { interactive: true });
      if (ok) refresh();
      return;
    }
    if (gbackup) {
      pill.textContent = '⟳ backing up…';
      const ok = await runManualSync(null, { interactive: false });
      if (ok) refresh(); else paintPill(undefined);
      return;
    }
    // No client configured yet — send them to set one up.
    navigate('#settings');
  });
  const unsubPill = onBackupState(paintPill);
  const onOnline = () => paintPill(undefined);
  const onOffline = () => paintPill('offline');
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  paintPill(undefined);
  // Tear down when leaving the dashboard so listeners don't pile up across
  // navigations (the dashboard re-renders on every return to #home).
  const pillCleanup = () => {
    unsubPill();
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('hashchange', pillCleanup);
  };
  window.addEventListener('hashchange', pillCleanup);

  const setlists = await store.getAllSetlists();
  if (!setlists.length) {
    root.appendChild(emptyState('No setlists yet. Create one or import from text.'));
  } else {
    setlists.sort((a, b) => b.updatedAt - a.updatedAt);
    const grid = el('div', 'sl-grid');
    for (const sl of setlists) {
      const songCount = sl.sets.reduce((n, s) => n + s.songIds.length, 0);
      const card = el('div', 'sl-setlist-card');
      card.innerHTML = `
        <div class="sl-setlist-card-title">${sl.name}</div>
        <div class="sl-setlist-card-meta">
          ${sl.venue ? `<span>${sl.venue}</span>` : ''}
          ${sl.gigDate ? `<span>${sl.gigDate}</span>` : ''}
          <span>${songCount} song${songCount !== 1 ? 's' : ''}</span>
          <span>${sl.sets.length} set${sl.sets.length !== 1 ? 's' : ''}</span>
        </div>
      `;
      card.addEventListener('click', () => navigate(`#setlist/${sl.id}`));
      grid.appendChild(card);
    }
    root.appendChild(grid);
  }

  // Export/Import section
  const dataSection = el('div', 'sl-section');
  dataSection.innerHTML = '<div class="sl-section-title">data</div>';
  const dataActions = el('div', 'sl-action-bar');
  dataActions.appendChild(btn('export all', 'sl-btn-ghost sl-btn-sm', async () => {
    const data = await store.exportAll();
    downloadJson(data, `setlist-backup-${new Date().toISOString().slice(0, 10)}.json`);
  }));
  dataActions.appendChild(btn('import', 'sl-btn-ghost sl-btn-sm', async () => {
    const data = await uploadJson();
    if (!data) return;
    // Snapshot current state first so a mistaken import is reversible via
    // Settings → "undo last sync".
    await store.putSnapshot('pre-import');
    if (data.type === 'setlist') await store.importSetlist(data);
    else if (data.type === 'song') await store.importSong(data);
    else if (data.type === 'sources') await store.importSources(data);
    else await store.importAll(data);
    navigate('#home');
  }));
  dataSection.appendChild(dataActions);
  root.appendChild(dataSection);

  // Auto-backup to/from Google Drive on page load
  if (isGdriveBackupEnabled()) {
    autoBackupFromGdrive().catch(e => console.warn('[gdrive-backup] auto-backup:', e.message));
  }
}

let _autoBackupDone = false;

async function autoBackupFromGdrive() {
  if (_autoBackupDone) return;
  _autoBackupDone = true;
  // Silent: only back up if we already hold a valid token. If the token has
  // expired, skip rather than popping an OAuth window the browser will block
  // (the user can re-connect from Sources & Sync, which is a real gesture).
  const client = await initGdriveBackup({ interactive: false });
  if (!client) return;
  setBackupClient(client);

  // Snapshot before importing remote data; history write is throttled (not
  // forced) so opening the app repeatedly doesn't spam Drive with versions.
  await pullMergePushCycle(client, () => store.exportAll(), (merged) => store.importAll(merged),
    { snapshotFn: () => store.putSnapshot('pre-sync') });

  store.setOnWrite(() => debouncedPush(() => store.exportAll()));
  watchConnectivity();
}

// ── Song Library ──

export async function renderLibrary(root) {
  const bar = topBar('song library', '#home');
  const addBtn = btn('+ add song', 'sl-btn-primary', async () => {
    const title = prompt('Song title:');
    if (!title) return;
    const song = store.createSong(title);
    await store.putSong(song);
    navigate(`#song/${song.id}`);
  });
  bar.appendChild(addBtn);
  root.appendChild(bar);

  const search = el('input', 'sl-search');
  search.type = 'search';
  search.placeholder = 'search songs...';
  root.appendChild(search);

  const listEl = el('div', 'sl-song-list');
  root.appendChild(listEl);

  const allSongs = await store.getAllSongs();
  allSongs.sort((a, b) => a.title.localeCompare(b.title));

  function renderList(filter) {
    const lower = (filter || '').toLowerCase();
    const filtered = lower
      ? allSongs.filter(s => s.title.toLowerCase().includes(lower) || s.artist.toLowerCase().includes(lower))
      : allSongs;
    listEl.innerHTML = '';
    if (!filtered.length) {
      listEl.appendChild(emptyState(lower ? 'No matches.' : 'No songs yet.'));
      return;
    }
    for (const s of filtered) {
      const row = el('div', 'sl-lib-row');
      row.innerHTML = `
        <span class="sl-lib-title">${s.title}</span>
        ${s.artist ? `<span class="sl-lib-artist">${s.artist}</span>` : ''}
        ${s.key ? `<span class="sl-key-badge sl-key-sm">${s.key}</span>` : ''}
      `;
      row.addEventListener('click', () => navigate(`#song/${s.id}`));
      listEl.appendChild(row);
    }
  }

  renderList('');
  search.addEventListener('input', () => renderList(search.value));
}

// ── Setlist View (compact cards) ──

export async function renderSetlistView(root, setlistId) {
  const sl = await store.getSetlist(setlistId);
  if (!sl) { root.appendChild(emptyState('Setlist not found.')); return; }

  const bar = topBar(sl.name, '#home');
  const actions = el('div', 'sl-actions');
  actions.appendChild(btn('sync', 'sl-btn-ghost', () => runSetlistSync(root, sl.id)));
  actions.appendChild(btn('perform', 'sl-btn-accent', () => navigate(`#perform/${sl.id}`)));
  actions.appendChild(btn('edit', 'sl-btn-ghost', () => navigate(`#setlist/${sl.id}/edit`)));
  actions.appendChild(btn('⇣', 'sl-btn-icon', async () => {
    const data = await store.exportSetlist(sl.id);
    if (data) downloadJson(data, `setlist-${sl.name.replace(/\s+/g, '-').toLowerCase()}.json`);
  }));
  bar.appendChild(actions);
  root.appendChild(bar);

  if (sl.venue || sl.gigDate) {
    const meta = el('div', 'sl-setlist-meta', `${sl.venue || ''} ${sl.gigDate ? '&middot; ' + sl.gigDate : ''}`);
    root.appendChild(meta);
  }

  // Offline readiness — cache every chart so perform mode works with no signal
  // at a gig. Only shown when the setlist actually has charts to cache.
  const offlineBar = el('div', 'sl-offline-bar');
  root.appendChild(offlineBar);
  async function paintOfflineBar(overrideLabel) {
    const { cached, total } = await getSetlistOfflineStatus(sl);
    offlineBar.innerHTML = '';
    if (!total) return; // no charted songs — nothing to cache
    const ready = cached >= total;
    const label = el('span', 'sl-offline-label',
      overrideLabel || `${ready ? '✓' : '⤓'} offline charts ${cached}/${total}`);
    if (ready) label.classList.add('sl-offline-ready');
    offlineBar.appendChild(label);
    if (!navigator.onLine) {
      offlineBar.appendChild(el('span', 'sl-offline-hint', '· offline — connect to cache'));
      return;
    }
    const dlBtn = btn(ready ? 'refresh' : 'download', 'sl-btn-ghost sl-btn-xs', async () => {
      dlBtn.disabled = true;
      const res = await cacheSetlistCharts(sl, ({ done, total: t }) => {
        label.textContent = `caching ${done}/${t}…`;
      });
      const hint = res.failed
        ? `· ${res.failed} couldn't cache (check worker / sharing)`
        : '';
      await paintOfflineBar();
      if (hint) offlineBar.appendChild(el('span', 'sl-offline-hint', hint));
    });
    offlineBar.appendChild(dlBtn);
  }
  paintOfflineBar();
  // Live-refresh the N/M count as background auto-caching (kicked off by perform
  // mode) lands charts. Throttled to a repaint on the next frame, and torn down
  // when leaving the setlist view.
  let offlinePaintQueued = false;
  const onChartCached = () => {
    if (offlinePaintQueued) return;
    offlinePaintQueued = true;
    requestAnimationFrame(() => { offlinePaintQueued = false; paintOfflineBar(); });
  };
  window.addEventListener(CHART_CACHED_EVENT, onChartCached);
  const offlineBarCleanup = () => {
    window.removeEventListener(CHART_CACHED_EVENT, onChartCached);
    window.removeEventListener('hashchange', offlineBarCleanup);
  };
  window.addEventListener('hashchange', offlineBarCleanup);

  const allNotes = await store.getAllNotes();
  const notesBySong = {};
  for (const n of allNotes) {
    if (!notesBySong[n.songId]) notesBySong[n.songId] = [];
    notesBySong[n.songId].push(n);
  }

  for (let si = 0; si < sl.sets.length; si++) {
    const set = sl.sets[si];
    if (sl.sets.length > 1) {
      const divider = el('div', 'sl-set-divider', set.name);
      root.appendChild(divider);
    }

    for (let i = 0; i < set.songIds.length; i++) {
      const song = await store.getSong(set.songIds[i]);
      if (!song) continue;
      const merged = store.mergedSong(song, sl);
      const notes = notesBySong[song.id] || [];
      const lastNote = notes.length ? notes[notes.length - 1].text : '';
      const ov = sl.songOverrides?.[song.id];
      const vocalist = ov?.vocalist || '';

      const card = el('div', 'sl-song-card');
      card.innerHTML = `
        <div class="sl-song-card-row">
          <span class="sl-song-num">${i + 1}</span>
          <span class="sl-song-card-title">${merged.title}${merged.artist ? ` <span class="sl-song-card-artist">${merged.artist}</span>` : ''}</span>
          ${keyBadge(merged.key, merged._origKey)}
          ${vocalistDot(vocalist, sl.vocalistLegend)}
        </div>
        ${merged.steelEntry ? `<div class="sl-steel-tag">steel: ${merged.steelEntry}</div>` : ''}
        ${lastNote ? `<div class="sl-note-preview">${lastNote.length > 60 ? lastNote.slice(0, 60) + '...' : lastNote}</div>` : ''}
      `;
      card.addEventListener('click', () => navigate(`#song/${song.id}/${setlistId}`));
      root.appendChild(card);
    }
  }
}

// ── Setlist Edit ──

// Undo stack for set edits, kept at module scope so it survives the in-place
// re-renders that add/remove/reorder trigger. Reset when a different setlist
// is opened for editing.
let _setlistEditUndo = null;

export async function renderSetlistEdit(root, setlistId) {
  let sl = await store.getSetlist(setlistId);
  if (!sl) { root.appendChild(emptyState('Setlist not found.')); return; }

  const bar = topBar('edit: ' + sl.name, `#setlist/${sl.id}`);

  if (!_setlistEditUndo || _setlistEditUndo.id !== setlistId) {
    _setlistEditUndo = { id: setlistId, stack: [] };
  }
  let reorderEnabled = false;

  const snapshotSets = () => sl.sets.map(s => ({ name: s.name, songIds: [...s.songIds] }));
  const pushUndo = (snap) => { _setlistEditUndo.stack.push(snap || snapshotSets()); updateUndoBtn(); };
  function updateUndoBtn() {
    const has = _setlistEditUndo.stack.length > 0;
    undoBtn.disabled = !has;
    undoBtn.style.opacity = has ? '' : '0.4';
  }

  const editActions = el('div', 'sl-actions');
  const reorderBtn = btn('↕ reorder', 'sl-btn-ghost sl-btn-sm', () => {
    reorderEnabled = !reorderEnabled;
    root.classList.toggle('sl-reorder-on', reorderEnabled);
    reorderBtn.classList.toggle('sl-btn-active', reorderEnabled);
    reorderBtn.innerHTML = reorderEnabled ? '✓ done' : '↕ reorder';
  });
  reorderBtn.title = 'Unlock drag-to-reorder';
  const undoBtn = btn('↶ undo', 'sl-btn-ghost sl-btn-sm', async () => {
    const prev = _setlistEditUndo.stack.pop();
    if (!prev) return;
    sl.sets = prev;
    await store.putSetlist(sl);
    refresh();
  });
  editActions.appendChild(reorderBtn);
  editActions.appendChild(undoBtn);
  if (isGdriveBackupEnabled() || needsReconnect()) editActions.appendChild(syncNowButton());
  bar.appendChild(editActions);
  root.classList.remove('sl-reorder-on');

  root.appendChild(bar);
  updateUndoBtn();

  const form = el('div', 'sl-edit-form');
  form.innerHTML = `
    <label class="sl-label">Name<input class="sl-input" id="sl-name" value="${sl.name}"></label>
    <label class="sl-label">Venue<input class="sl-input" id="sl-venue" value="${sl.venue || ''}"></label>
    <label class="sl-label">Date<input class="sl-input" id="sl-date" type="date" value="${sl.gigDate || ''}"></label>
    <label class="sl-label">Spotify Playlist URL<input class="sl-input" id="sl-spotify" value="${sl.spotifyUrl || ''}" placeholder="https://open.spotify.com/playlist/..."></label>
  `;
  root.appendChild(form);

  const save = async () => {
    sl.name = document.getElementById('sl-name').value;
    sl.venue = document.getElementById('sl-venue').value;
    sl.gigDate = document.getElementById('sl-date').value;
    sl.spotifyUrl = document.getElementById('sl-spotify').value;
    await store.putSetlist(sl);
  };
  form.addEventListener('change', save);

  // Vocalist legend
  const vocSection = el('div', 'sl-section');
  vocSection.innerHTML = '<div class="sl-section-title">Vocalist Legend</div>';
  const vocGrid = el('div', 'sl-voc-grid');
  const codes = Object.keys(sl.vocalistLegend || {});
  const allCodes = new Set(codes);
  if (sl.songOverrides) {
    for (const ov of Object.values(sl.songOverrides)) {
      if (ov.vocalist) allCodes.add(ov.vocalist);
    }
  }
  for (const code of allCodes) {
    const row = el('div', 'sl-voc-row');
    row.innerHTML = `<span class="sl-vocalist" data-v="${code}">${code}</span>
      <input class="sl-input sl-input-sm" data-vcode="${code}" value="${sl.vocalistLegend?.[code] || ''}" placeholder="name">`;
    vocGrid.appendChild(row);
  }
  const addVoc = btn('+ code', 'sl-btn-sm', () => {
    const code = prompt('Vocalist letter code (e.g., C):');
    if (!code) return;
    const name = prompt(`Name for "${code.toUpperCase()}":`);
    if (!sl.vocalistLegend) sl.vocalistLegend = {};
    sl.vocalistLegend[code.toUpperCase()] = name || '';
    store.putSetlist(sl).then(() => renderSetlistEdit(root.parentElement || root, setlistId));
  });
  vocSection.appendChild(vocGrid);
  vocSection.appendChild(addVoc);
  vocGrid.addEventListener('change', (e) => {
    const code = e.target.dataset.vcode;
    if (!code) return;
    if (!sl.vocalistLegend) sl.vocalistLegend = {};
    sl.vocalistLegend[code] = e.target.value;
    store.putSetlist(sl);
  });
  root.appendChild(vocSection);

  // Import section
  const importSection = el('div', 'sl-section');
  importSection.innerHTML = '<div class="sl-section-title">Import Songs</div>';
  const textarea = el('textarea', 'sl-textarea');
  textarea.placeholder = 'Paste setlist text here...\n\nSet 1:\n1  Song Title  C\n2  Another Song  S\n\nSet 2:\n1  Third Song  H';
  textarea.rows = 8;
  importSection.appendChild(textarea);
  importSection.appendChild(btn('import', 'sl-btn-primary', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    const parsed = parseTextList(text);
    if (!parsed.sets.length) { alert('No songs found.'); return; }

    let importedCount = 0;
    const newSets = [];

    for (const pSet of parsed.sets) {
      const songIds = [];
      for (const ps of pSet.songs) {
        let song = await store.findSongByTitle(ps.title);
        if (!song) {
          song = store.createSong(ps.title);
          await store.putSong(song);
        }
        songIds.push(song.id);
        if (ps.vocalist) {
          if (!sl.songOverrides) sl.songOverrides = {};
          if (!sl.songOverrides[song.id]) sl.songOverrides[song.id] = {};
          sl.songOverrides[song.id].vocalist = ps.vocalist;
        }
        importedCount++;
      }
      newSets.push({ name: pSet.name, songIds });
    }

    pushUndo();
    sl.sets = newSets;
    await store.putSetlist(sl);
    textarea.value = '';
    alert(`Imported ${importedCount} songs across ${newSets.length} set(s).`);
    navigate(`#setlist/${sl.id}`);
  }));
  root.appendChild(importSection);

  // Songs per set (with drag reorder)
  for (let si = 0; si < sl.sets.length; si++) {
    const set = sl.sets[si];
    const section = el('div', 'sl-section');
    section.innerHTML = `<div class="sl-section-title">${set.name} <span class="sl-dim">(${set.songIds.length} songs)</span></div>`;

    const rowContainer = el('div', 'sl-drag-container');

    for (let i = 0; i < set.songIds.length; i++) {
      const song = await store.getSong(set.songIds[i]);
      if (!song) continue;
      const row = el('div', 'sl-edit-row');
      row.dataset.songId = song.id;
      row.innerHTML = `<span class="sl-drag-handle" title="Drag to reorder">⠿</span><span class="sl-song-num">${i + 1}</span><span>${song.title}</span>`;
      const songLink = btn('▸', 'sl-btn-icon sl-edit-song-link', (e) => {
        e.stopPropagation();
        navigate(`#song/${song.id}/${sl.id}`);
      });
      songLink.title = 'Go to song';
      row.appendChild(songLink);
      const removeBtn = btn('&times;', 'sl-btn-icon sl-btn-danger', async () => {
        pushUndo();
        set.songIds.splice(set.songIds.indexOf(song.id), 1);
        await store.putSetlist(sl);
        refresh();
      });
      row.appendChild(removeBtn);
      rowContainer.appendChild(row);
    }

    section.appendChild(rowContainer);
    setupDragReorder(rowContainer, set, sl, {
      isEnabled: () => reorderEnabled,
      onCommit: (snap) => pushUndo(snap),
    });

    section.appendChild(btn('+ add song', 'sl-btn-sm', async () => {
      const allSongs = await store.getAllSongs();
      const title = prompt('Song title (or search):');
      if (!title) return;
      let song = allSongs.find(s => s.title.toLowerCase().includes(title.toLowerCase()));
      if (!song) {
        song = store.createSong(title);
        await store.putSong(song);
      }
      pushUndo();
      set.songIds.push(song.id);
      await store.putSetlist(sl);
      refresh();
    }));
    root.appendChild(section);
  }

  // Add set
  root.appendChild(btn('+ add set', 'sl-btn-ghost', async () => {
    pushUndo();
    sl.sets.push({ name: `Set ${sl.sets.length + 1}`, songIds: [] });
    await store.putSetlist(sl);
    refresh();
  }));

  // Danger zone
  const danger = el('div', 'sl-section sl-danger-zone');
  danger.appendChild(btn('delete setlist', 'sl-btn-danger', async () => {
    if (!confirm(`Delete "${sl.name}"? Songs will remain in your library.`)) return;
    await store.deleteSetlist(sl.id);
    navigate('#home');
  }));
  root.appendChild(danger);
}

function setupDragReorder(container, set, setlist, opts = {}) {
  let dragState = null;

  container.addEventListener('pointerdown', (e) => {
    if (opts.isEnabled && !opts.isEnabled()) return;
    const handle = e.target.closest('.sl-drag-handle');
    if (!handle) return;
    e.preventDefault();

    const row = handle.closest('[data-song-id]');
    if (!row) return;

    const beforeSnapshot = setlist.sets.map(s => ({ name: s.name, songIds: [...s.songIds] }));
    const oldOrder = [...set.songIds];
    row.classList.add('sl-dragging');
    dragState = { row, startY: e.clientY };

    const onMove = (e2) => {
      if (!dragState) return;
      e2.preventDefault();

      const dy = e2.clientY - dragState.startY;
      dragState.row.style.transform = `translateY(${dy}px)`;

      const rows = [...container.querySelectorAll('[data-song-id]')];
      const dragRect = dragState.row.getBoundingClientRect();
      const dragMid = dragRect.top + dragRect.height / 2;
      const ci = rows.indexOf(dragState.row);

      for (let i = 0; i < rows.length; i++) {
        if (rows[i] === dragState.row) continue;
        const rect = rows[i].getBoundingClientRect();
        const mid = rect.top + rect.height / 2;

        if (ci < i && dragMid > mid) {
          rows[i].after(dragState.row);
          dragState.startY = e2.clientY;
          dragState.row.style.transform = '';
          break;
        } else if (ci > i && dragMid < mid) {
          rows[i].before(dragState.row);
          dragState.startY = e2.clientY;
          dragState.row.style.transform = '';
          break;
        }
      }
    };

    const onUp = async () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);

      if (!dragState) return;
      dragState.row.classList.remove('sl-dragging');
      dragState.row.style.transform = '';

      const rows = [...container.querySelectorAll('[data-song-id]')];
      const newOrder = rows.map(r => r.dataset.songId);
      if (newOrder.join('|') !== oldOrder.join('|')) {
        opts.onCommit?.(beforeSnapshot);
      }
      set.songIds = newOrder;
      await store.putSetlist(setlist);

      rows.forEach((r, i) => {
        const num = r.querySelector('.sl-song-num');
        if (num) num.textContent = i + 1;
      });

      dragState = null;
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

// ── Song Focus ──

export async function renderSongFocus(root, songId, setlistId) {
  const song = await store.getSong(songId);
  if (!song) { root.appendChild(emptyState('Song not found.')); return; }

  let setlist = null;
  let merged = song;
  if (setlistId) {
    setlist = await store.getSetlist(setlistId);
    if (setlist) merged = store.mergedSong(song, setlist);
  }

  setLastSongId(songId);
  const backHash = setlistId ? `#setlist/${setlistId}` : '#library';
  const bar = topBar(merged.title, backHash);
  if (setlist) {
    const topActions = el('div', 'sl-actions');
    topActions.appendChild(btn('perform', 'sl-btn-accent sl-btn-sm', () => navigate(`#perform/${setlistId}/${songId}`)));
    bar.appendChild(topActions);
  }
  root.appendChild(bar);

  root.classList.add('sl-focus');

  // Main info
  const info = el('div', 'sl-focus-info');
  info.innerHTML = `
    <h1 class="sl-focus-title">${merged.title}</h1>
    ${merged.artist ? `<div class="sl-focus-artist">${merged.artist}</div>` : ''}
    <div class="sl-focus-badges">
      ${merged.key ? keyBadge(merged.key, merged._origKey) : '<span class="sl-key-badge sl-key-empty">no key</span>'}
      ${merged.capo ? `<span class="sl-badge">capo ${merged.capo}</span>` : ''}
      ${merged.bpm ? `<span class="sl-badge">${merged.bpm} bpm</span>` : ''}
      ${merged.steelEntry ? `<span class="sl-steel-tag">steel: ${merged.steelEntry}</span>` : ''}
      ${merged.keyChanges ? `<span class="sl-badge sl-badge-dim">${merged.keyChanges}</span>` : ''}
    </div>
  `;
  root.appendChild(info);

  // Quick edit metadata
  const editToggle = btn('edit details', 'sl-btn-sm sl-btn-ghost', () => {
    editForm.classList.toggle('sl-hidden');
  });
  root.appendChild(editToggle);

  const editForm = el('div', 'sl-edit-form sl-hidden');
  const isOverride = !!setlist;
  editForm.innerHTML = `
    <label class="sl-label">Title<input class="sl-input" id="sf-title" value="${song.title}"></label>
    <label class="sl-label">Artist<input class="sl-input" id="sf-artist" value="${song.artist || ''}"></label>
    <div class="sl-row">
      <label class="sl-label sl-flex1">Key<input class="sl-input" id="sf-key" value="${isOverride ? (merged.key || '') : (song.key || '')}" placeholder="e.g. G, Bb, C#m"></label>
      <label class="sl-label sl-flex1">Capo<input class="sl-input" id="sf-capo" type="number" min="0" max="12" value="${merged.capo || 0}"></label>
      <label class="sl-label sl-flex1">BPM<input class="sl-input" id="sf-bpm" type="number" min="0" value="${merged.bpm || 0}"></label>
    </div>
    <label class="sl-label">Key Changes<input class="sl-input" id="sf-keychanges" value="${song.keyChanges || ''}" placeholder="e.g. Modulates to A"></label>
    <label class="sl-label">Steel Entry<input class="sl-input" id="sf-steel" value="${isOverride ? (merged.steelEntry || '') : (song.steelEntry || '')}" placeholder="e.g. intro, chorus, verse 2"></label>
    <label class="sl-label">Spotify URL<input class="sl-input" id="sf-spotify" value="${song.spotifyUri || ''}" placeholder="https://open.spotify.com/track/..."></label>
    <label class="sl-label">Chart URL (Google Drive)<input class="sl-input" id="sf-chart" value="${song.chartUrl || ''}" placeholder="https://drive.google.com/..."></label>
    ${isOverride ? '<div class="sl-hint">Key, capo, and steel entry save as overrides for this setlist. Title, artist, Spotify, and chart save to the base song.</div>' : ''}
  `;
  editForm.addEventListener('change', async () => {
    song.title = document.getElementById('sf-title').value;
    song.artist = document.getElementById('sf-artist').value;
    song.keyChanges = document.getElementById('sf-keychanges').value;
    song.spotifyUri = document.getElementById('sf-spotify').value;
    song.chartUrl = document.getElementById('sf-chart').value;

    const keyVal = document.getElementById('sf-key').value;
    const capoVal = parseInt(document.getElementById('sf-capo').value) || 0;
    const bpmVal = parseInt(document.getElementById('sf-bpm').value) || 0;
    const steelVal = document.getElementById('sf-steel').value;

    if (isOverride) {
      if (!setlist.songOverrides) setlist.songOverrides = {};
      if (!setlist.songOverrides[song.id]) setlist.songOverrides[song.id] = {};
      setlist.songOverrides[song.id].key = keyVal;
      setlist.songOverrides[song.id].capo = capoVal;
      setlist.songOverrides[song.id].steelEntry = steelVal;
      await store.putSetlist(setlist);
    } else {
      song.key = keyVal;
      song.capo = capoVal;
      song.steelEntry = steelVal;
    }
    song.bpm = bpmVal;
    await store.putSong(song);
  });
  root.appendChild(editForm);

  // Action buttons
  const actionBar = el('div', 'sl-action-bar');
  if (song.chartUrl) {
    const inlineChartBtn = btn('chart', 'sl-btn-accent', () => {
      navigate(`#song/${songId}/${setlistId || '_'}/chart`);
    });
    actionBar.appendChild(inlineChartBtn);
    const scrapeBtn = btn('scrape', 'sl-btn-ghost sl-btn-sm', async () => {
      scrapeBtn.textContent = 'scraping...';
      const updates = await deepScrapeChart(song);
      if (updates) {
        let applied = 0;
        for (const [k, v] of Object.entries(updates)) {
          if (k.startsWith('_')) continue;
          const cur = song[k];
          const empty = cur === '' || cur === 0 || cur === null || cur === undefined;
          if (empty) { song[k] = v; applied++; }
        }
        if (applied) {
          await store.putSong(song);
          scrapeBtn.textContent = `found ${applied} field(s)!`;
          setTimeout(() => refresh(), 1200);
        } else {
          scrapeBtn.textContent = 'no new data';
        }
      } else {
        scrapeBtn.textContent = 'no data found';
      }
      setTimeout(() => { scrapeBtn.textContent = 'scrape'; }, 2500);
    });
    actionBar.appendChild(scrapeBtn);
  } else {
    // Chart-fallback ladder: search configured Drive folders first (tier 1
    // personal + tier 2 community, both recursed via searchChartForSong),
    // and only offer "create chart doc" (tier 3) once that comes up empty.
    const searchBtn = btn('search for chart', 'sl-btn-ghost sl-btn-sm', async () => {
      searchBtn.textContent = 'searching...';
      try {
        const found = await searchChartForSong(song);
        if (found) {
          await store.putSong(song);
          searchBtn.textContent = 'found it!';
          setTimeout(() => refresh(), 900);
        } else {
          searchBtn.textContent = 'no match found';
          setTimeout(() => { searchBtn.textContent = 'search for chart'; }, 2000);
        }
      } catch (e) {
        searchBtn.textContent = 'search failed';
        setTimeout(() => { searchBtn.textContent = 'search for chart'; }, 2000);
      }
    });
    actionBar.appendChild(searchBtn);

    const createBtn = btn('create chart doc', 'sl-btn-accent sl-btn-sm', async () => {
      createBtn.textContent = 'creating...';
      try {
        const webViewLink = await createBlankChartDoc(song);
        song.chartUrl = webViewLink;
        await store.putSong(song);
        window.open(webViewLink, '_blank');
        refresh();
      } catch (e) {
        createBtn.textContent = 'failed';
        alert(e.message);
        setTimeout(() => { createBtn.textContent = 'create chart doc'; }, 2000);
      }
    });
    actionBar.appendChild(createBtn);
  }
  if (song.spotifyUri) {
    const spBtn = btn('open in spotify', 'sl-btn-spotify sl-btn-sm', () => {
      window.open(getSpotifyOpenUrl(song.spotifyUri), '_blank');
    });
    actionBar.appendChild(spBtn);
  }
  actionBar.appendChild(btn('⇣', 'sl-btn-icon', async () => {
    const data = await store.exportSong(songId);
    if (data) downloadJson(data, `song-${song.title.replace(/\s+/g, '-').toLowerCase()}.json`);
  }));
  // Quick "sync now" to Drive from the song page (whole dataset), shown once a
  // Drive client is configured.
  if (isGdriveBackupEnabled() || needsReconnect()) actionBar.appendChild(syncNowButton());
  root.appendChild(actionBar);

  // Spotify embed + timecode tracker
  let currentTimecode = 0;
  let timecodeInterval = null;
  let isPlaying = false;
  if (song.spotifyUri && parseSpotifyUrl(song.spotifyUri)) {
    const embedWrap = el('div', 'sl-spotify-embed');
    renderSpotifyEmbed(embedWrap, song.spotifyUri, 152);
    root.appendChild(embedWrap);

    const tcRow = el('div', 'sl-timecode-row');
    const tcDisplay = el('span', 'sl-timecode-display', '0:00');
    const tcPlayBtn = btn('start timer', 'sl-btn-ghost sl-btn-xs', () => {
      if (isPlaying) {
        clearInterval(timecodeInterval);
        isPlaying = false;
        tcPlayBtn.textContent = 'resume';
      } else {
        isPlaying = true;
        tcPlayBtn.textContent = 'pause';
        timecodeInterval = setInterval(() => {
          currentTimecode++;
          tcDisplay.textContent = formatTimecode(currentTimecode);
        }, 1000);
      }
    });
    const tcResetBtn = btn('reset', 'sl-btn-ghost sl-btn-xs', () => {
      clearInterval(timecodeInterval);
      currentTimecode = 0;
      isPlaying = false;
      tcDisplay.textContent = '0:00';
      tcPlayBtn.textContent = 'start timer';
    });
    tcRow.appendChild(el('span', 'sl-timecode-label', 'timecode'));
    tcRow.appendChild(tcDisplay);
    tcRow.appendChild(tcPlayBtn);
    tcRow.appendChild(tcResetBtn);
    root.appendChild(tcRow);
  }

  // Notes
  const notesSection = el('div', 'sl-section');
  notesSection.innerHTML = '<div class="sl-section-title">notes</div>';
  const notesList = el('div', 'sl-notes-list');
  notesSection.appendChild(notesList);

  const notes = await store.getNotesForSong(songId);

  function startEditNote(nEl, n) {
    const ta = el('textarea', 'sl-textarea sl-textarea-sm');
    ta.value = n.text;
    ta.rows = Math.min(8, Math.max(2, (n.text.match(/\n/g) || []).length + 1));
    const actions = el('div', 'sl-note-btns');
    actions.appendChild(btn('save', 'sl-btn-primary sl-btn-xs', async () => {
      const v = ta.value.trim();
      if (!v) return;
      n.text = v;
      await store.putNote(n);
      renderNotes();
    }));
    actions.appendChild(btn('cancel', 'sl-btn-ghost sl-btn-xs', () => renderNotes()));
    nEl.innerHTML = '';
    nEl.appendChild(ta);
    nEl.appendChild(actions);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function renderNotes() {
    notesList.innerHTML = '';
    if (!notes.length) {
      notesList.appendChild(emptyState('No notes yet.'));
      return;
    }
    for (const n of notes) {
      const nEl = el('div', 'sl-note');
      const date = new Date(n.createdAt);
      const ts = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const tcBadge = n.timecode != null ? `<span class="sl-tc-badge" title="Click to edit timecode">${formatTimecode(n.timecode)}</span>` : '';
      const sectionBadge = n.section ? `<span class="sl-section-badge">${n.section}</span>` : '';
      const steelBadge = n.steelType ? `<span class="sl-steel-note-badge">${n.steelType}</span>` : '';
      nEl.innerHTML = `
        <div class="sl-note-text">${n.text}</div>
        <div class="sl-note-meta">
          <span>${ts}</span>
          ${tcBadge}
          ${sectionBadge}
          ${steelBadge}
          ${n.source === 'voice' ? '<span class="sl-voice-badge">voice</span>' : ''}
        </div>
      `;
      // Timecode badge click to edit
      const tcEl = nEl.querySelector('.sl-tc-badge');
      if (tcEl) {
        tcEl.style.cursor = 'pointer';
        tcEl.addEventListener('click', async () => {
          const val = prompt('Edit timecode (m:ss or seconds, blank to remove):', formatTimecode(n.timecode));
          if (val === null) return;
          if (val.trim() === '') {
            delete n.timecode;
          } else {
            n.timecode = parseTimecodeInput(val.trim());
          }
          await store.putNote(n);
          renderNotes();
        });
      }
      const editBtn = btn('✎', 'sl-btn-icon sl-btn-xs sl-note-edit', () => startEditNote(nEl, n));
      editBtn.title = 'Edit note';
      nEl.appendChild(editBtn);
      const delBtn = btn('&times;', 'sl-btn-icon sl-btn-danger sl-btn-xs', async () => {
        const idx = notes.indexOf(n);
        await store.deleteNote(n.id);
        if (idx >= 0) notes.splice(idx, 1);
        renderNotes();
        showUndoToast('Note deleted', async () => {
          await store.putNote(n);
          if (idx >= 0) notes.splice(idx, 0, n); else notes.push(n);
          renderNotes();
        });
      });
      nEl.appendChild(delBtn);
      notesList.appendChild(nEl);
    }
  }
  renderNotes();

  // Add note input
  const noteInput = el('div', 'sl-note-input');
  const textarea = el('textarea', 'sl-textarea sl-textarea-sm');
  textarea.placeholder = 'Add a note...';
  textarea.rows = 2;
  noteInput.appendChild(textarea);

  // Section selector
  const sectionRow = el('div', 'sl-note-section-row');
  const sectionSelect = el('select', 'sl-ann-size');
  sectionSelect.innerHTML = `
    <option value="">no section</option>
    <option value="intro">intro</option>
    <option value="verse 1">verse 1</option>
    <option value="verse 2">verse 2</option>
    <option value="verse 3">verse 3</option>
    <option value="pre-chorus">pre-chorus</option>
    <option value="chorus">chorus</option>
    <option value="chorus 2">chorus 2</option>
    <option value="bridge">bridge</option>
    <option value="solo">solo</option>
    <option value="interlude">interlude</option>
    <option value="outro">outro</option>
    <option value="tag">tag</option>
    <option value="turnaround">turnaround</option>
  `;
  sectionRow.appendChild(el('span', 'sl-timecode-label', 'section'));
  sectionRow.appendChild(sectionSelect);
  noteInput.appendChild(sectionRow);

  async function addNote(text, source, extras = {}) {
    if (!text) return;
    const note = store.createNote(songId, text, source);
    if (isPlaying || currentTimecode > 0) note.timecode = currentTimecode;
    if (sectionSelect.value) note.section = sectionSelect.value;
    Object.assign(note, extras);
    await store.putNote(note);
    notes.push(note);
    textarea.value = '';
    renderNotes();
  }

  const noteBtns = el('div', 'sl-note-btns');
  noteBtns.appendChild(btn('add note', 'sl-btn-primary sl-btn-sm', () => {
    addNote(textarea.value.trim(), 'typed');
  }));
  noteBtns.appendChild(btn('+ timecode', 'sl-btn-ghost sl-btn-xs', () => {
    const text = textarea.value.trim() || `marker at ${formatTimecode(currentTimecode)}`;
    addNote(text, 'typed');
  }));

  if (voiceSupported()) {
    let dictation = null;
    const micBtn = btn('mic', 'sl-btn-mic sl-btn-sm', () => {
      if (dictation && dictation.isListening) {
        dictation.stop();
        micBtn.classList.remove('sl-listening');
        return;
      }
      dictation = createDictation(
        async (text) => {
          micBtn.classList.remove('sl-listening');
          await addNote(text, 'voice');
        },
        (err) => {
          micBtn.classList.remove('sl-listening');
          console.warn('[setlist] voice error:', err);
        }
      );
      dictation.start();
      micBtn.classList.add('sl-listening');
    });
    noteBtns.appendChild(micBtn);
  }

  noteInput.appendChild(noteBtns);

  // Steel quick-buttons
  const steelRow = el('div', 'sl-steel-buttons');
  steelRow.appendChild(el('span', 'sl-timecode-label', 'steel'));
  const steelTypes = ['steel solo', 'steel intro', 'light steel', 'heavy steel'];
  for (const st of steelTypes) {
    steelRow.appendChild(btn(st, 'sl-btn-ghost sl-btn-xs sl-steel-qb', () => {
      const extra = textarea.value.trim();
      addNote(extra || st, 'typed', { steelType: st });
    }));
  }
  noteInput.appendChild(steelRow);

  notesSection.appendChild(noteInput);
  root.appendChild(notesSection);

  // Lyrics
  if (song.lyrics) {
    const lyricsSection = el('div', 'sl-section');
    lyricsSection.innerHTML = `<div class="sl-section-title">lyrics</div><pre class="sl-lyrics">${song.lyrics}</pre>`;
    root.appendChild(lyricsSection);
  }

  // Delete song (only from library view, not setlist context)
  if (!setlistId) {
    const danger = el('div', 'sl-section sl-danger-zone');
    danger.appendChild(btn('delete song', 'sl-btn-danger sl-btn-sm', async () => {
      if (!confirm(`Delete "${song.title}" and all its notes?`)) return;
      const songNotes = await store.getNotesForSong(songId);
      for (const n of songNotes) await store.deleteNote(n.id);
      await store.deleteChartBlob(songId).catch(() => {});
      await store.deleteSong(songId);
      navigate('#library');
    }));
    root.appendChild(danger);
  }

  // Swipe navigation + bottom nav bar (when viewing within a setlist)
  if (setlist) {
    const flatSongIds = setlist.sets.flatMap(s => s.songIds);
    const currentIdx = flatSongIds.indexOf(songId);

    const navBar = el('div', 'sl-song-nav');
    const prevBtn = btn('&larr;', 'sl-btn-ghost sl-btn-sm', () => {
      if (currentIdx > 0) navigate(`#song/${flatSongIds[currentIdx - 1]}/${setlistId}`);
    });
    if (currentIdx <= 0) { prevBtn.disabled = true; prevBtn.style.opacity = '0.3'; }
    const posLabel = el('span', 'sl-song-nav-pos', `${currentIdx + 1} / ${flatSongIds.length}`);
    const nextBtn = btn('next &rarr;', 'sl-btn-ghost sl-btn-sm', () => {
      if (currentIdx < flatSongIds.length - 1) navigate(`#song/${flatSongIds[currentIdx + 1]}/${setlistId}`);
    });
    if (currentIdx >= flatSongIds.length - 1) { nextBtn.disabled = true; nextBtn.style.opacity = '0.3'; }

    navBar.appendChild(prevBtn);
    navBar.appendChild(posLabel);
    navBar.appendChild(nextBtn);
    root.appendChild(navBar);

    // Swipe listeners live on the persistent root element, which route() only
    // clears via innerHTML — that never detaches listeners bound to root itself.
    // Without explicit teardown they leak into the next view (e.g. the chart
    // annotation view, where a horizontal pen stroke would fire a song nav).
    // Tear them down on the next hashchange so they're scoped to this view.
    const swipeAc = new AbortController();
    let touchStartX = 0, touchStartY = 0;
    root.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true, signal: swipeAc.signal });
    root.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.8) {
        if (dx < 0 && currentIdx < flatSongIds.length - 1) {
          navigate(`#song/${flatSongIds[currentIdx + 1]}/${setlistId}`);
        } else if (dx > 0 && currentIdx > 0) {
          navigate(`#song/${flatSongIds[currentIdx - 1]}/${setlistId}`);
        }
      }
    }, { passive: true, signal: swipeAc.signal });
    const cleanupSwipe = () => {
      swipeAc.abort();
      window.removeEventListener('hashchange', cleanupSwipe);
    };
    window.addEventListener('hashchange', cleanupSwipe);
  }
}

// ── Sync helpers ──

function showSyncOverlay(root) {
  const overlay = el('div', 'sl-sync-overlay');
  overlay.innerHTML = '<div class="sl-sync-spinner"></div><div class="sl-sync-status">syncing...</div>';
  root.appendChild(overlay);
  return {
    update(msg) { overlay.querySelector('.sl-sync-status').textContent = msg; },
    done(results) {
      const sm = results.spotify.matched;
      const dm = results.drive.matched;
      const errs = [...results.spotify.errors, ...results.drive.errors];
      let msg = '';
      if (sm || dm) msg += `Linked: ${sm ? sm + ' Spotify' : ''}${sm && dm ? ', ' : ''}${dm ? dm + ' chart' : ''}.`;
      else msg += 'No new matches found.';
      if (errs.length) msg += ` Errors: ${errs.join('; ')}`;
      overlay.innerHTML = `<div class="sl-sync-result">${msg}</div>`;
      overlay.addEventListener('click', () => overlay.remove());
      setTimeout(() => overlay.remove(), 4000);
    },
    error(msg) {
      overlay.innerHTML = `<div class="sl-sync-result sl-sync-error">${msg}</div>`;
      overlay.addEventListener('click', () => overlay.remove());
      setTimeout(() => overlay.remove(), 4000);
    },
  };
}

async function runSetlistSync(root, setlistId) {
  const ov = showSyncOverlay(root);
  try {
    const results = await syncSetlist(setlistId, (r) => {
      ov.update(`${r.done}/${r.total} songs...`);
    });
    ov.done(results);
    setTimeout(() => navigate(`#setlist/${setlistId}`), 500);
  } catch (e) {
    ov.error(e.message);
  }
}

async function runGlobalSync(root) {
  const ov = showSyncOverlay(root);
  try {
    const results = await syncAll((r) => {
      ov.update(`${r.done}/${r.total} songs...`);
    });
    ov.done(results);
  } catch (e) {
    ov.error(e.message);
  }
}

// ── Settings ──

export async function renderSettings(root) {
  const bar = topBar('sources & sync', '#home');
  root.appendChild(bar);

  const sources = getSources();

  // Worker URL
  const workerSection = el('div', 'sl-section');
  workerSection.innerHTML = `
    <div class="sl-section-title">sync worker url</div>
    <div class="sl-hint" style="margin-bottom:0.5rem">Optional. Deploy the setlist-sync Cloudflare Worker to enable auto-linking from Spotify playlists and Google Drive folders.</div>
    <input class="sl-input" id="sl-worker-url" value="${sources.workerUrl || ''}" placeholder="https://voidstar-setlist-sync.YOUR.workers.dev">
  `;
  root.appendChild(workerSection);

  // Google Drive folders — personal (direct children only) and
  // community/shared (recursive subfolder search) are kept as two separate
  // lists: they have different trust/perf profiles (a recursive walk of a
  // shared archive you don't own is slower and worth a distinct warning).
  function buildFolderSection(title, hint, sourceKey) {
    const section = el('div', 'sl-section');
    section.innerHTML = `
      <div class="sl-section-title">${title}</div>
      <div class="sl-hint" style="margin-bottom:0.5rem">${hint}</div>
    `;
    const list = el('div', 'sl-source-list');
    section.appendChild(list);

    function renderFolders() {
      list.innerHTML = '';
      for (let i = 0; i < sources[sourceKey].length; i++) {
        const f = sources[sourceKey][i];
        const row = el('div', 'sl-source-row');
        row.innerHTML = `<span class="sl-source-url">${f.url}</span>`;
        const removeBtn = btn('&times;', 'sl-btn-icon sl-btn-danger', () => {
          sources[sourceKey].splice(i, 1);
          setSources(sources);
          renderFolders();
        });
        row.appendChild(removeBtn);
        list.appendChild(row);
      }
    }
    renderFolders();

    const addRow = el('div', 'sl-row');
    const input = el('input', 'sl-input');
    input.placeholder = 'https://drive.google.com/drive/folders/...';
    input.style.flex = '1';
    addRow.appendChild(input);
    addRow.appendChild(btn('add', 'sl-btn-primary sl-btn-sm', () => {
      const url = input.value.trim();
      if (!url) return;
      sources[sourceKey].push({ url });
      setSources(sources);
      input.value = '';
      renderFolders();
    }));
    section.appendChild(addRow);
    return section;
  }

  root.appendChild(buildFolderSection(
    'personal drive folders',
    'Your own Google Drive folders. Scanned directly (not their subfolders) — for nested archives, use Community Chart Folders below. Requires the sync worker to be deployed.',
    'driveFolders',
  ));
  root.appendChild(buildFolderSection(
    'community chart folders',
    'Shared Dropbox/Drive folders in circulation among working musicians (e.g. a bandleader\'s master chart archive). Subfolders are searched recursively, which can be slower and is capped to protect API quotas.',
    'communityFolders',
  ));

  // Manual chart batch import
  const chartSection = el('div', 'sl-section');
  chartSection.innerHTML = `
    <div class="sl-section-title">batch link charts</div>
    <div class="sl-hint" style="margin-bottom:0.5rem">
      Paste chart URLs with song titles, one per line. The app will fuzzy-match against your song library.<br>
      Format: <code>URL  Song Title - Artist</code> or <code>Song Title  URL</code>
    </div>
  `;
  const chartTextarea = el('textarea', 'sl-textarea');
  chartTextarea.rows = 6;
  chartTextarea.placeholder = 'https://docs.google.com/document/d/abc  Two Dozen Roses - Shenandoah\nhttps://drive.google.com/file/d/xyz  Amarillo By Morning';
  chartSection.appendChild(chartTextarea);
  chartSection.appendChild(btn('match & link', 'sl-btn-primary', async () => {
    const text = chartTextarea.value.trim();
    if (!text) return;
    const parsed = parseBatchChartUrls(text);
    if (!parsed.length) { alert('No valid URLs found.'); return; }

    const songs = await store.getAllSongs();
    let matched = 0;
    for (const chart of parsed) {
      if (!chart.title) continue;
      const candidates = songs.filter(s => !s.chartUrl);
      const result = fuzzyMatch(chart.title, candidates);
      if (result) {
        result.match.chartUrl = chart.url;
        await store.putSong(result.match);
        matched++;
      }
    }
    alert(`Linked ${matched} chart${matched !== 1 ? 's' : ''} out of ${parsed.length} entries.`);
    chartTextarea.value = '';
  }));
  root.appendChild(chartSection);

  // Spotify search links fallback
  const spotifySection = el('div', 'sl-section');
  spotifySection.innerHTML = `
    <div class="sl-section-title">spotify quick-link</div>
    <div class="sl-hint" style="margin-bottom:0.5rem">
      Songs without a Spotify link get a "search" button that opens Spotify search.
      With the sync worker deployed, the sync button auto-links from your setlist playlists.
    </div>
  `;
  const unlinkedBtn = btn('show unlinked songs', 'sl-btn-ghost', async () => {
    const songs = await store.getAllSongs();
    const unlinked = songs.filter(s => !s.spotifyUri);
    unlinkedList.innerHTML = '';
    if (!unlinked.length) {
      unlinkedList.appendChild(emptyState('All songs linked!'));
      return;
    }
    for (const s of unlinked) {
      const row = el('div', 'sl-source-row');
      const searchUrl = spotifySearchUrl(s.title, s.artist);
      row.innerHTML = `
        <span class="sl-source-url">${s.title}</span>
        <a href="${searchUrl}" target="_blank" rel="noopener" class="sl-btn sl-btn-spotify sl-btn-sm">search</a>
      `;
      unlinkedList.appendChild(row);
    }
  });
  spotifySection.appendChild(unlinkedBtn);
  const unlinkedList = el('div', 'sl-source-list');
  spotifySection.appendChild(unlinkedList);
  root.appendChild(spotifySection);

  // Global sync
  const syncSection = el('div', 'sl-section');
  syncSection.innerHTML = '<div class="sl-section-title">sync all songs</div>';
  syncSection.appendChild(btn('sync now', 'sl-btn-accent', () => runGlobalSync(root)));
  syncSection.appendChild(el('div', 'sl-hint', 'Scans all configured Spotify playlists and Drive folders, auto-links matching songs.'));
  root.appendChild(syncSection);

  // Google Drive backup
  const gdriveSection = el('div', 'sl-section');
  const currentClientId = localStorage.getItem('voidstar.setlist.gdrive.clientId') || '';
  gdriveSection.innerHTML = `
    <div class="sl-section-title">google drive backup</div>
    <div class="sl-hint" style="margin-bottom:0.5rem">
      Back up your setlist data, notes, chart links, and annotations to Google Drive so you can restore them on any device.
      Requires a Google Cloud OAuth2 client ID with Drive API enabled.
    </div>
    <label class="sl-label">Google OAuth Client ID
      <input class="sl-input" id="sl-gdrive-client-id" value="${currentClientId}" placeholder="xxxx.apps.googleusercontent.com">
    </label>
  `;
  const clientIdInput = gdriveSection.querySelector('#sl-gdrive-client-id');
  clientIdInput?.addEventListener('change', () => {
    localStorage.setItem('voidstar.setlist.gdrive.clientId', clientIdInput.value.trim());
  });
  const gdriveStatus = el('div', 'sl-hint',
    isGdriveBackupEnabled() ? `Last backup: ${formatLastBackup()}` : '');

  const gdriveActions = el('div', 'sl-action-bar');
  gdriveActions.appendChild(btn('back up now', 'sl-btn-primary sl-btn-sm', () =>
    runManualSync(gdriveStatus, { interactive: true })));
  gdriveActions.appendChild(btn('restore from drive', 'sl-btn-ghost sl-btn-sm', async () => {
    const ok = await runManualSync(gdriveStatus, { interactive: true });
    if (ok) setTimeout(() => navigate('#home'), 700);
  }));
  gdriveSection.appendChild(gdriveActions);
  gdriveSection.appendChild(gdriveStatus);

  // ── Version safeguards: undo last sync/import, or restore an earlier
  // Drive version. Every restore snapshots current state first, so it's itself
  // reversible via "undo last sync".
  const safetyActions = el('div', 'sl-action-bar');
  safetyActions.appendChild(btn('undo last sync', 'sl-btn-ghost sl-btn-sm', async () => {
    const snaps = await store.listSnapshots();
    if (!snaps.length) {
      gdriveStatus.textContent = 'No snapshot to undo yet.';
      gdriveStatus.style.color = '';
      return;
    }
    if (!confirm('Revert to the state saved just before your last sync / restore / import?')) return;
    await store.restoreSnapshot(snaps[0].ts);
    gdriveStatus.textContent = 'Reverted to the pre-sync snapshot.';
    gdriveStatus.style.color = 'var(--green)';
    setTimeout(() => navigate('#home'), 700);
  }));
  const historyList = el('div', 'sl-source-list');
  safetyActions.appendChild(btn('restore a version…', 'sl-btn-ghost sl-btn-sm', async () => {
    historyList.textContent = 'Loading versions…';
    try {
      const client = await initGdriveBackup({ interactive: true });
      if (!client) {
        historyList.textContent = needsReconnect()
          ? 'Reconnect Google Drive first (tap the sync pill on the home screen).'
          : 'Set a Google OAuth Client ID first.';
        return;
      }
      setBackupClient(client);
      const files = await client.listHistory();
      historyList.innerHTML = '';
      if (!files.length) { historyList.appendChild(emptyState('No earlier versions saved on Drive yet.')); return; }
      for (const f of files) {
        const when = f.createdTime ? new Date(f.createdTime).toLocaleString() : f.name;
        const row = el('div', 'sl-source-row');
        row.appendChild(el('span', 'sl-source-url', when));
        row.appendChild(btn('load', 'sl-btn-sm sl-btn-ghost', async () => {
          if (!confirm(`Restore the version from ${when}? Your current data is snapshotted first, so you can undo this.`)) return;
          await store.putSnapshot('pre-version-restore');
          const data = await client.readHistory(f.id);
          await store.replaceAll(data);
          navigate('#home');
        }));
        historyList.appendChild(row);
      }
    } catch (e) {
      historyList.textContent = formatGdriveError(e);
    }
  }));
  gdriveSection.appendChild(safetyActions);
  gdriveSection.appendChild(historyList);
  root.appendChild(gdriveSection);

  // ── Offline charts ──
  const offlineSection = el('div', 'sl-section');
  offlineSection.innerHTML = `
    <div class="sl-section-title">offline charts</div>
    <div class="sl-hint" style="margin-bottom:0.5rem">
      Cache every song's chart as an image so perform mode works with no signal.
      Charts also auto-cache the first time you perform a setlist while online.
      Requires the sync worker to be deployed.
    </div>
  `;
  const offlineStatus = el('div', 'sl-hint');
  const offlineActions = el('div', 'sl-action-bar');
  async function refreshOfflineStatus() {
    const { cached, total } = await getAllChartsOfflineStatus();
    offlineStatus.textContent = total
      ? `${cached}/${total} charts cached${cached >= total ? ' — fully offline-ready' : ''}`
      : 'No charts linked yet.';
    offlineStatus.style.color = total && cached >= total ? 'var(--green)' : '';
  }
  const dlAllBtn = btn('download all charts', 'sl-btn-primary sl-btn-sm', async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      offlineStatus.textContent = 'Offline — connect to a network first.';
      offlineStatus.style.color = 'var(--pink)';
      return;
    }
    dlAllBtn.disabled = true;
    const res = await cacheAllCharts(({ done, total }) => {
      offlineStatus.textContent = `caching ${done}/${total}…`;
      offlineStatus.style.color = '';
    });
    dlAllBtn.disabled = false;
    await refreshOfflineStatus();
    if (res.failed) {
      offlineStatus.textContent += ` · ${res.failed} couldn't cache (check worker / sharing)`;
      offlineStatus.style.color = 'var(--pink)';
    }
  });
  offlineActions.appendChild(dlAllBtn);
  offlineSection.appendChild(offlineActions);
  offlineSection.appendChild(offlineStatus);
  root.appendChild(offlineSection);
  refreshOfflineStatus();

  // Export/import sources config
  const configSection = el('div', 'sl-section');
  configSection.innerHTML = '<div class="sl-section-title">config backup</div>';
  const configActions = el('div', 'sl-action-bar');
  configActions.appendChild(btn('export sources', 'sl-btn-ghost sl-btn-sm', async () => {
    const data = await store.exportSources();
    downloadJson(data, 'setlist-sources.json');
  }));
  configActions.appendChild(btn('import sources', 'sl-btn-ghost sl-btn-sm', async () => {
    const data = await uploadJson();
    if (data?.sources) {
      await store.importSources(data);
      navigate('#settings');
    }
  }));
  configSection.appendChild(configActions);
  root.appendChild(configSection);

  // Save on change
  const saveWorker = () => {
    sources.workerUrl = document.getElementById('sl-worker-url').value.trim().replace(/\/+$/, '');
    setSources(sources);
  };
  document.getElementById('sl-worker-url').addEventListener('change', saveWorker);
}

// ── Performance Mode ──

/**
 * Custom pinch-to-zoom + pan for perform mode.
 *
 * Android Chrome disables native pinch-to-zoom whenever the page is in the
 * Fullscreen API (page-scale is locked to 1), which is exactly the mode a
 * performer uses on stage. So we drive our own zoom by transforming an inner
 * layer instead of relying on the browser's page zoom — this works identically
 * in and out of fullscreen.
 *
 * `scrollEl` is the scroll container (`.sl-perform-content`); `layerEl` is the
 * transformed child (`.sl-perform-zoom`). At scale 1 the layer sits untouched
 * and the container scrolls natively (keeps momentum for long charts); once the
 * user pinches past 1× we lock native scroll and pan via the transform.
 */
function attachPerformZoom(scrollEl, layerEl) {
  const MIN = 1, MAX = 5;
  let scale = 1, tx = 0, ty = 0;
  // Active gesture bookkeeping.
  let gStartDist = 0, gStartScale = 1, gStartTx = 0, gStartTy = 0;
  let gRectLeft = 0, gRectTop = 0;
  let panStartX = 0, panStartY = 0, panTx = 0, panTy = 0, panning = false;
  let gFocalX = 0, gFocalY = 0;
  let lastTap = 0;

  const isZoomed = () => scale > 1.001;

  function apply() {
    if (isZoomed()) {
      scrollEl.classList.add('sl-zoomed');
      layerEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    } else {
      scrollEl.classList.remove('sl-zoomed');
      layerEl.style.transform = '';
    }
  }

  // Keep the scaled layer inside the viewport so you can't lose the content
  // off-screen; when the layer is smaller than the viewport on an axis it's
  // pinned to the top-left.
  function clamp() {
    const vw = scrollEl.clientWidth, vh = scrollEl.clientHeight;
    const lw = layerEl.offsetWidth * scale, lh = layerEl.offsetHeight * scale;
    const minTx = Math.min(0, vw - lw), minTy = Math.min(0, vh - lh);
    if (tx > 0) tx = 0; else if (tx < minTx) tx = minTx;
    if (ty > 0) ty = 0; else if (ty < minTy) ty = minTy;
  }

  function dist(t0, t1) {
    return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
  }

  function beginPinch(e) {
    const rect = scrollEl.getBoundingClientRect();
    gRectLeft = rect.left; gRectTop = rect.top;
    gStartDist = dist(e.touches[0], e.touches[1]);
    gStartScale = scale;
    // Fold the current native scroll into the transform so the picture doesn't
    // jump when we take over scrolling.
    if (scale <= 1.001) { tx = 0; ty = -scrollEl.scrollTop; scrollEl.scrollTop = 0; }
    gStartTx = tx; gStartTy = ty;
  }

  function movePinch(e) {
    const d = dist(e.touches[0], e.touches[1]);
    if (!gStartDist) return;
    const s2 = Math.max(MIN, Math.min(MAX, gStartScale * (d / gStartDist)));
    // Current midpoint in container coords; its travel since gesture start pans
    // the content, so one formula handles pinch-zoom + two-finger drag together.
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - gRectLeft;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - gRectTop;
    // Layer coord under the initial focal — keep it pinned under the fingers.
    const Lx = (gFocalX - gStartTx) / gStartScale;
    const Ly = (gFocalY - gStartTy) / gStartScale;
    scale = s2;
    tx = midX - s2 * Lx;
    ty = midY - s2 * Ly;
    clamp();
    apply();
  }

  function onTouchStart(e) {
    if (e.touches.length === 2) {
      const rect = scrollEl.getBoundingClientRect();
      gFocalX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      gFocalY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      beginPinch(e);
      panning = false;
    } else if (e.touches.length === 1 && isZoomed()) {
      panning = true;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      panTx = tx; panTy = ty;
      // Double-tap to reset to fit.
      const now = e.timeStamp;
      if (now - lastTap < 300) { reset(); panning = false; }
      lastTap = now;
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 2 && gStartDist) {
      e.preventDefault();
      movePinch(e);
    } else if (panning && e.touches.length === 1) {
      e.preventDefault();
      tx = panTx + (e.touches[0].clientX - panStartX);
      ty = panTy + (e.touches[0].clientY - panStartY);
      clamp();
      apply();
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length < 2) gStartDist = 0;
    if (e.touches.length === 0) {
      panning = false;
      // Snap out of zoom mode when we've basically returned to 1× and hand the
      // scroll position back to the native scroller.
      if (scale <= 1.02) reset();
    }
  }

  function reset() {
    const restoreScroll = -ty;
    scale = 1; tx = 0; ty = 0; gStartDist = 0; panning = false;
    apply();
    if (restoreScroll > 0) scrollEl.scrollTop = restoreScroll;
  }

  scrollEl.addEventListener('touchstart', onTouchStart, { passive: false });
  scrollEl.addEventListener('touchmove', onTouchMove, { passive: false });
  scrollEl.addEventListener('touchend', onTouchEnd, { passive: true });
  scrollEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return {
    isActive: () => isZoomed() || gStartDist > 0 || panning,
    reset,
    destroy() {
      scrollEl.removeEventListener('touchstart', onTouchStart);
      scrollEl.removeEventListener('touchmove', onTouchMove);
      scrollEl.removeEventListener('touchend', onTouchEnd);
      scrollEl.removeEventListener('touchcancel', onTouchEnd);
    },
  };
}

export async function renderPerformMode(root, setlistId, startSongId) {
  const sl = await store.getSetlist(setlistId);
  if (!sl) { root.appendChild(emptyState('Setlist not found.')); return; }

  root.classList.add('sl-perform');

  // Auto-cache this setlist's charts for offline the first time it's performed
  // online (e.g. at soundcheck) so they're available later with no signal.
  // Fire-and-forget, skips charts already cached, and never blocks the view.
  if (typeof navigator === 'undefined' || navigator.onLine) {
    cacheSetlistCharts(sl, null, { skipCached: true }).catch(() => {});
  }

  // Build flat list of entries: songs + set dividers
  const entries = [];
  for (let si = 0; si < sl.sets.length; si++) {
    const set = sl.sets[si];
    if (sl.sets.length > 1) {
      entries.push({ type: 'divider', name: set.name });
    }
    for (const songId of set.songIds) {
      const song = await store.getSong(songId);
      if (!song) continue;
      const merged = store.mergedSong(song, sl);
      const notes = await store.getNotesForSong(songId);
      const vocalist = sl.songOverrides?.[songId]?.vocalist || '';
      entries.push({ type: 'song', song: merged, notes, vocalist, songId });
    }
  }

  // Start on the requested song, or fall back to lastSongId, or first song
  let idx = -1;
  const effectiveStartId = startSongId || getLastSongId();
  if (effectiveStartId) {
    idx = entries.findIndex(e => e.type === 'song' && e.songId === effectiveStartId);
  }
  if (idx < 0) idx = entries.findIndex(e => e.type === 'song');
  if (idx < 0) { root.appendChild(emptyState('No songs in this setlist.')); return; }

  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  const container = el('div', 'sl-perform-container');
  const progress = el('div', 'sl-perform-progress');
  const counter = el('div', 'sl-perform-counter');
  const content = el('div', 'sl-perform-content');
  // Inner layer our pinch-to-zoom transforms (see attachPerformZoom). All song
  // markup goes in here, not directly in `content`.
  const zoomLayer = el('div', 'sl-perform-zoom');
  content.appendChild(zoomLayer);
  const exitBtn = btn('&times;', 'sl-btn-icon sl-perform-exit', () => {
    try { document.exitFullscreen?.(); } catch {}
    try { wakeLock?.release(); } catch {}
    navigate(`#setlist/${setlistId}`);
  });
  const fsBtn = btn('⛶', 'sl-btn-icon sl-perform-fs', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      document.documentElement.requestFullscreen?.();
    }
  });
  fsBtn.title = 'Toggle fullscreen';

  const detailBtn = btn('detail', 'sl-btn-ghost sl-btn-sm sl-perform-detail', () => {
    const entry = entries[idx];
    if (entry?.type === 'song') {
      try { document.exitFullscreen?.(); } catch {}
      try { wakeLock?.release(); } catch {}
      navigate(`#song/${entry.songId}/${setlistId}`);
    }
  });
  detailBtn.title = 'Song details';

  let invertActive = localStorage.getItem('voidstar.setlist.invertChart') === '1';
  let currentChartWrap = null;
  // Object URL for the currently-shown cached chart blob, if any. Revoked when
  // we move off the song (in render's reset) and on teardown, so blobs don't
  // leak across a long set.
  let currentChartObjectUrl = null;

  // Bottom nav bar
  const navBar = el('div', 'sl-perform-nav');
  const prevBtn = btn('&larr; prev', 'sl-btn-ghost sl-btn-sm', () => go(-1));
  const navPos = el('span', 'sl-song-nav-pos');
  const nextBtn = btn('next &rarr;', 'sl-btn-ghost sl-btn-sm', () => go(1));
  // Invert sits in the top control strip; nav bar keeps only prev/next.
  const invertBtn = btn('invert', 'sl-btn-ghost sl-btn-sm sl-perform-invert', () => {
    invertActive = !invertActive;
    localStorage.setItem('voidstar.setlist.invertChart', invertActive ? '1' : '0');
    if (currentChartWrap) currentChartWrap.classList.toggle('sl-chart-inverted', invertActive);
    invertBtn.classList.toggle('sl-btn-active', invertActive);
  });
  invertBtn.title = 'Invert chart colors for dark stage';
  if (invertActive) invertBtn.classList.add('sl-btn-active');
  navBar.appendChild(prevBtn);
  navBar.appendChild(navPos);
  navBar.appendChild(nextBtn);

  container.appendChild(progress);
  container.appendChild(exitBtn);
  container.appendChild(fsBtn);
  container.appendChild(detailBtn);
  container.appendChild(invertBtn);
  container.appendChild(counter);
  container.appendChild(content);
  container.appendChild(navBar);
  root.appendChild(container);

  const songEntries = entries.filter(e => e.type === 'song');
  const totalSongs = songEntries.length;

  let chartAnnotationCtrl = null;
  const zoomCtrl = attachPerformZoom(content, zoomLayer);

  function getSongIndex() {
    let n = 0;
    for (let i = 0; i <= idx; i++) {
      if (entries[i].type === 'song') n++;
    }
    return n;
  }

  function updateNavState() {
    const songNum = getSongIndex();
    navPos.textContent = `${songNum} / ${totalSongs}`;
    let hasPrev = false, hasNext = false;
    for (let i = idx - 1; i >= 0; i--) { if (entries[i].type === 'song') { hasPrev = true; break; } }
    for (let i = idx + 1; i < entries.length; i++) { if (entries[i].type === 'song') { hasNext = true; break; } }
    prevBtn.disabled = !hasPrev;
    prevBtn.style.opacity = hasPrev ? '' : '0.3';
    nextBtn.disabled = !hasNext;
    nextBtn.style.opacity = hasNext ? '' : '0.3';
  }

  function render() {
    if (chartAnnotationCtrl) { chartAnnotationCtrl.destroy(); chartAnnotationCtrl = null; }
    if (currentChartObjectUrl) { URL.revokeObjectURL(currentChartObjectUrl); currentChartObjectUrl = null; }
    currentChartWrap = null;
    invertBtn.style.display = 'none';
    // Every song starts at 1× so a leftover zoom from the previous chart doesn't
    // carry over.
    zoomCtrl?.reset();

    const entry = entries[idx];
    const songNum = getSongIndex();
    progress.style.width = `${(songNum / totalSongs) * 100}%`;
    counter.textContent = `${songNum} / ${totalSongs}`;
    updateNavState();

    if (entry.type === 'divider') {
      zoomLayer.innerHTML = `<div class="sl-perform-divider">${entry.name}</div>`;
      return;
    }

    const { song, notes, vocalist } = entry;
    zoomLayer.innerHTML = `
      <h1 class="sl-perform-title">${song.title}</h1>
      ${song.artist ? `<div class="sl-perform-artist">${song.artist}</div>` : ''}
      <div class="sl-perform-badges">
        ${song.key ? keyBadge(song.key, song._origKey) : ''}
        ${song.capo ? `<span class="sl-badge">capo ${song.capo}</span>` : ''}
        ${song.bpm ? `<span class="sl-badge">${song.bpm} bpm</span>` : ''}
        ${vocalist ? vocalistDot(vocalist, sl.vocalistLegend) : ''}
      </div>
      ${song.steelEntry ? `<div class="sl-perform-steel">steel: ${song.steelEntry}</div>` : ''}
      ${notes.length ? `<div class="sl-perform-notes">${notes.map(n => {
        const badges = [
          n.timecode != null ? `<span class="sl-tc-badge">${formatTimecode(n.timecode)}</span>` : '',
          n.section ? `<span class="sl-section-badge">${n.section}</span>` : '',
          n.steelType ? `<span class="sl-steel-note-badge">${n.steelType}</span>` : '',
        ].filter(Boolean).join(' ');
        return `<div class="sl-perform-note">${badges ? badges + ' ' : ''}${n.text}</div>`;
      }).join('')}</div>` : ''}
    `;

    if (song.chartUrl) {
      invertBtn.style.display = '';
      invertBtn.classList.toggle('sl-btn-active', invertActive);

      const chartWrap = el('div', 'sl-perform-chart-wrap');
      currentChartWrap = chartWrap;
      if (invertActive) chartWrap.classList.add('sl-chart-inverted');

      // Canvas (annotation overlay) is appended first so it stays the last
      // child — i.e. stacked above whatever chart element we insert before it.
      const chartCanvas = document.createElement('canvas');
      chartCanvas.className = 'sl-perform-chart-canvas';
      chartWrap.appendChild(chartCanvas);
      zoomLayer.appendChild(chartWrap);

      const insertChart = (node) => chartWrap.insertBefore(node, chartWrap.firstChild);

      // Live Google rendering — used when there's no offline copy cached.
      function mountRemoteChart() {
        const embedUrl = buildChartEmbedUrl(song.chartUrl);
        const flatImageUrl = buildChartImageUrl(song.chartUrl);
        if (flatImageUrl) {
          // Prefer a flattened image so the area around the chart is our own
          // dark backdrop (which doesn't flip to white in invert mode).
          // Top-aligned + fit-to-width mirrors the viewer's layout, so
          // annotations stay lined up. If the image endpoint can't serve the
          // file (e.g. a private Drive file), fall back to the embeddable
          // viewer so the chart still shows.
          const img = document.createElement('img');
          img.src = flatImageUrl;
          img.className = 'sl-perform-chart-img sl-chart-flat';
          lockAspectToImage(img, chartWrap);
          img.addEventListener('error', () => {
            if (img.parentElement !== chartWrap) return;
            img.remove();
            if (embedUrl) {
              const iframe = document.createElement('iframe');
              iframe.src = embedUrl;
              iframe.className = 'sl-perform-chart-iframe';
              insertChart(iframe);
            } else {
              const raw = document.createElement('img');
              raw.src = song.chartUrl;
              raw.className = 'sl-perform-chart-img';
              lockAspectToImage(raw, chartWrap);
              insertChart(raw);
            }
          }, { once: true });
          insertChart(img);
        } else if (embedUrl) {
          const iframe = document.createElement('iframe');
          iframe.src = embedUrl;
          iframe.className = 'sl-perform-chart-iframe';
          insertChart(iframe);
        } else {
          const img = document.createElement('img');
          img.src = song.chartUrl;
          img.className = 'sl-perform-chart-img';
          lockAspectToImage(img, chartWrap);
          insertChart(img);
        }
      }

      // Offline-cached blob first (renders with no network); live URLs
      // otherwise. Async cache read is guarded against a fast swipe that has
      // already moved us to a different song.
      getOfflineChartUrl(entry.songId, song.chartUrl).then(objUrl => {
        if (currentChartWrap !== chartWrap) { if (objUrl) URL.revokeObjectURL(objUrl); return; }
        if (objUrl) {
          currentChartObjectUrl = objUrl;
          const img = document.createElement('img');
          img.src = objUrl;
          img.className = 'sl-perform-chart-img sl-chart-flat';
          lockAspectToImage(img, chartWrap);
          insertChart(img);
        } else {
          mountRemoteChart();
        }
      });

      loadAnnotation(entry.songId).then(data => {
        // The chart image's natural aspect (set by lockAspectToImage) is the
        // source of truth for the box shape. Only fall back to the authoring/
        // viewport aspect if the image hasn't provided one yet (e.g. an iframe
        // chart, or before the image has loaded).
        const aspect = data?.aspect ||
          (window.innerWidth / Math.max(1, window.innerHeight - 96));
        if (!chartWrap.dataset.naturalAspect) chartWrap.style.aspectRatio = String(aspect);
        if (data?.strokes?.length) {
          // Make the chart fill the aspect-locked wrap (see .sl-has-annotations
          // CSS) so the overlay lines up exactly, matching the annotate/detail
          // views. The class goes on the shared parent, so it applies whether
          // the chart image mounts before or after this annotation load.
          chartWrap.classList.add('sl-has-annotations');
          chartAnnotationCtrl = renderReadonlyAnnotations(chartCanvas, data.strokes);
        }
      });
    }
  }

  function go(dir) {
    const next = idx + dir;
    if (next >= 0 && next < entries.length) {
      idx = next;
      if (entries[idx].type === 'divider') {
        render();
        setTimeout(() => {
          const next2 = idx + dir;
          if (next2 >= 0 && next2 < entries.length) {
            idx = next2;
            render();
          }
        }, 600);
        return;
      }
      render();
    }
  }

  render();

  // Swipe handling
  let touchStartX = 0, touchStartY = 0, swipeMulti = false;
  container.addEventListener('touchstart', (e) => {
    swipeMulti = e.touches.length > 1;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  container.addEventListener('touchend', (e) => {
    // Don't treat a pinch/pan (or the finger-lift after one) as a nav swipe.
    if (swipeMulti || e.touches.length > 0 || zoomCtrl.isActive()) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.8) {
      go(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  // Keyboard
  const onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(-1);
    else if (e.key === 'Escape') exitBtn.click();
  };
  document.addEventListener('keydown', onKey);

  // Cleanup on navigation
  const cleanup = () => {
    if (chartAnnotationCtrl) chartAnnotationCtrl.destroy();
    if (currentChartObjectUrl) { URL.revokeObjectURL(currentChartObjectUrl); currentChartObjectUrl = null; }
    zoomCtrl.destroy();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup);
}

// ── Chart View (read-only by default, toggle to annotate) ──

export async function renderAnnotation(root, songId, setlistId) {
  const song = await store.getSong(songId);
  if (!song) { root.appendChild(emptyState('Song not found.')); return; }
  if (!song.chartUrl) { root.appendChild(emptyState('No chart linked to this song.')); return; }

  root.classList.add('sl-perform');
  const container = el('div', 'sl-annotation-container');

  const backHash = setlistId ? `#song/${songId}/${setlistId}` : `#song/${songId}`;
  const toolbar = el('div', 'sl-annotation-toolbar');

  const backBtn = btn('&larr;', 'sl-btn-icon', () => navigate(backHash));
  toolbar.appendChild(backBtn);
  toolbar.appendChild(el('span', 'sl-ann-sep'));

  // View controls (visible in read-only mode)
  const viewControls = el('div', 'sl-ann-controls');
  viewControls.style.cssText = 'display:flex;align-items:center;gap:0.35rem;flex:1;justify-content:flex-end';
  viewControls.appendChild(btn('edit chart', 'sl-btn-ghost sl-btn-sm', () => {
    window.open(song.chartUrl, '_blank');
  }));
  viewControls.appendChild(btn('annotate', 'sl-btn-sm sl-btn-primary', () => enterAnnotateMode()));
  toolbar.appendChild(viewControls);

  // Draw controls (hidden by default)
  const drawControls = el('div', 'sl-ann-controls');
  drawControls.style.cssText = 'display:none;align-items:center;gap:0.35rem;flex-wrap:wrap';
  drawControls.innerHTML = `
    <button class="sl-btn sl-btn-sm sl-ann-tool" data-tool="pan" title="Scroll chart">🖐</button>
    <span class="sl-ann-sep"></span>
    <button class="sl-btn sl-btn-sm sl-ann-tool" data-tool="pen" title="Pen">✎</button>
    <button class="sl-btn sl-btn-sm sl-ann-tool" data-tool="highlighter" title="Highlighter">▮</button>
    <button class="sl-btn sl-btn-sm sl-ann-tool" data-tool="text" title="Text">T</button>
    <button class="sl-btn sl-btn-sm sl-ann-tool" data-tool="arrow" title="Arrow">→</button>
    <button class="sl-btn sl-btn-sm sl-ann-tool" data-tool="eraser" title="Eraser">◻</button>
    <button class="sl-btn sl-btn-sm sl-ann-tool" data-tool="select" title="Select to move, edit, recolor, or delete">⌖</button>
    <span class="sl-ann-sep"></span>
    <input type="color" class="sl-ann-color" value="#ff5e7e" title="Color">
    <select class="sl-ann-size">
      <option value="2">Fine</option>
      <option value="4" selected>Medium</option>
      <option value="8">Thick</option>
    </select>
    <span class="sl-ann-sep"></span>
    <button class="sl-btn sl-btn-sm sl-btn-ghost" id="sl-ann-undo" title="Undo">↶</button>
    <button class="sl-btn sl-btn-sm sl-btn-ghost" id="sl-ann-clear" title="Clear all">Clear</button>
    <button class="sl-btn sl-btn-sm sl-btn-primary" id="sl-ann-save">Save</button>
  `;
  const doneBtn = btn('done', 'sl-btn-ghost sl-btn-sm', () => exitAnnotateMode());
  drawControls.appendChild(doneBtn);
  toolbar.appendChild(drawControls);

  container.appendChild(toolbar);

  const canvasWrap = el('div', 'sl-annotation-wrap');
  // Aspect-locked stage that actually holds the chart + canvas. The canvas
  // normalizes strokes to its parent's box, so that box must be identical in
  // both annotate and view modes — otherwise the two toolbars (draw controls
  // wrap to two rows; view controls fit on one) leave the flex wrap at
  // different heights and the same normalized stroke lands in a different
  // pixel spot, shifting annotations off the chart. Locking the stage to a
  // width-driven aspect ratio (as perform mode does) makes the box stable
  // regardless of toolbar height.
  const stage = el('div', 'sl-annotation-stage');

  // Offline-cached blob first (also gives a flat image to annotate against,
  // which lines up better than a live Google Doc iframe); live URL otherwise.
  const cachedChartUrl = await getOfflineChartUrl(songId, song.chartUrl);
  if (cachedChartUrl) {
    const img = document.createElement('img');
    img.src = cachedChartUrl;
    img.className = 'sl-annotation-img';
    lockAspectToImage(img, stage);
    stage.appendChild(img);
    window.addEventListener('hashchange', () => URL.revokeObjectURL(cachedChartUrl), { once: true });
  } else {
    const embedUrl = buildChartEmbedUrl(song.chartUrl);
    if (embedUrl) {
      const iframe = document.createElement('iframe');
      iframe.src = embedUrl;
      iframe.className = 'sl-annotation-iframe';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      stage.appendChild(iframe);
    } else {
      const img = document.createElement('img');
      img.src = song.chartUrl;
      img.className = 'sl-annotation-img';
      lockAspectToImage(img, stage);
      stage.appendChild(img);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'sl-annotation-canvas';
  canvas.style.pointerEvents = 'none';
  stage.appendChild(canvas);
  canvasWrap.appendChild(stage);
  container.appendChild(canvasWrap);
  root.appendChild(container);

  let readonlyCtrl = null;
  let canvasCtrl = null;

  requestAnimationFrame(async () => {
    const data = await loadAnnotation(songId);
    // The chart image's natural aspect (set by lockAspectToImage) is the source
    // of truth for the box shape. Only fall back to the authoring/viewport
    // aspect if the image hasn't provided one (iframe chart, or pre-load).
    const aspect = data?.aspect ||
      (canvasWrap.clientHeight
        ? canvasWrap.clientWidth / canvasWrap.clientHeight
        : window.innerWidth / Math.max(1, window.innerHeight - 96));
    if (!stage.dataset.naturalAspect) stage.style.aspectRatio = String(aspect);
    if (data?.strokes?.length) {
      readonlyCtrl = renderReadonlyAnnotations(canvas, data.strokes);
    }
  });

  function enterAnnotateMode() {
    viewControls.style.display = 'none';
    drawControls.style.display = 'flex';
    canvas.style.pointerEvents = '';
    canvas.style.cursor = 'crosshair';
    if (readonlyCtrl) { readonlyCtrl.destroy(); readonlyCtrl = null; }
    canvasCtrl = initAnnotationCanvas(canvas, songId, drawControls);
  }

  async function exitAnnotateMode() {
    const saveBtn = drawControls.querySelector('#sl-ann-save');
    if (saveBtn) saveBtn.click();

    if (canvasCtrl) { canvasCtrl.destroy(); canvasCtrl = null; }
    viewControls.style.display = 'flex';
    drawControls.style.display = 'none';
    canvas.style.pointerEvents = 'none';
    canvas.style.cursor = '';

    await new Promise(r => setTimeout(r, 100));
    const data = await loadAnnotation(songId);
    if (data?.strokes?.length) {
      readonlyCtrl = renderReadonlyAnnotations(canvas, data.strokes);
    }
  }
}

function buildChartEmbedUrl(url) {
  const gdocMatch = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (gdocMatch) return `https://docs.google.com/document/d/${gdocMatch[1]}/preview`;
  const gfileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (gfileMatch) return `https://drive.google.com/file/d/${gfileMatch[1]}/preview`;
  if (url.match(/\.(pdf|png|jpg|jpeg|gif|webp)(\?|$)/i)) return url;
  return null;
}

// A flat *image* URL for the chart, when one exists — used by perform mode so
// the chart renders as a bare image on our dark backdrop instead of inside
// Google's cross-origin viewer (whose surround flips to white in invert mode).
// Google Drive files rasterize cleanly via the thumbnail endpoint (works for
// images and single-page PDFs; carries the user's cookies for their own files).
// Google Docs are left to the iframe path (a doc isn't a chart image). Direct
// image links are already bare images and keep their existing rendering.
function buildChartImageUrl(url) {
  const driveId =
    url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/)?.[1] ||
    url.match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1];
  if (driveId) return `https://drive.google.com/thumbnail?id=${driveId}&sz=w2000`;
  return null;
}
