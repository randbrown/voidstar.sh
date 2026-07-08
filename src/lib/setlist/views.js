// All view renderers for the setlist lab.

import * as store from './store.js';
import { navigate, refresh, getLastSongId, setLastSongId } from './app.js';
import { parseTextList, isSpotifyUrl } from './import.js';
import { renderSpotifyEmbed, getSpotifyOpenUrl, fetchOEmbed, parseSpotifyUrl } from './spotify.js';
import { createDictation, isSupported as voiceSupported } from './voice.js';
import { getSources, setSources, syncSetlist, syncAll, spotifySearchUrl, parseBatchChartUrls, searchChartForSong, linkChartCandidate, fetchAiChart, fetchWebChartData, fetchSongMeta, fetchSteelSummary, getReferencePlaylistTracks, resolveBandcampEmbed } from './sync.js';
import { renderBandcampEmbed, renderSoundcloudEmbed } from './media.js';
import { readChartFields, scanAllCharts, fetchInfoForAllSongs, summarizeSteelForAllSongs, verifySpotifyLinks, libraryHealth, songHealth } from './bulk.js';
import { fetchLyrics, parseSyncedLyrics } from './lyrics.js';
import { findBestMatch as fuzzyMatch, matchScore } from './match.js';
import { initGdriveBackup, isGdriveBackupEnabled, needsReconnect, isSyncing, setBackupClient, onBackupState, pullMergePushCycle, formatLastBackup, createChartDoc, createChartImageFile, ensureDriveAccess, trashChartDoc, archiveChartDoc } from './gdrive-backup.js';
import { buildChartText, buildAiChartText, buildTemplateChartText } from './chart-build.js';
import { initAnnotationCanvas, loadAnnotation, renderReadonlyAnnotations, renderStrokesToPngBlob } from './annotation.js';
import { cacheSetlistCharts, cacheAllCharts, cacheChartForSong, cacheChartByUrl, getSetlistOfflineStatus, getAllChartsOfflineStatus, getOfflineChart, fetchChartText, CHART_CACHED_EVENT } from './chart-cache.js';
import { chartEnhanceEnabled, setChartEnhanceEnabled, enhanceChartBlob } from './chart-enhance.js';
import { getSpotifyClientId, setSpotifyClientId, spotifyRedirectUri, isSpotifyConnected, beginSpotifyLogin, disconnectSpotify, spotifyLoginError, checkSpotifyConnection } from './spotify-auth.js';
import { extractKeyFromChartText } from './chart-key.js';

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

// Minimal HTML escape for interpolating external-source strings (API
// metadata, lyrics, filenames) into innerHTML templates. The full sweep of
// existing interpolations is tracked in plans/maintenance-backlog.md §G.1 —
// use this for any new ones.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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

// Toast with a link action — for opening a freshly created doc when the
// browser blocked window.open (mobile popup rules: the open fires long after
// the tap gesture, so it's denied; tapping the toast's link IS a gesture).
function showLinkToast(msg, href, label = 'open', ms = 20000) {
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
  const link = el('a', 'sl-btn sl-btn-sm sl-btn-accent', label);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.addEventListener('click', () => setTimeout(dismiss, 300));
  toast.appendChild(link);
  document.body.appendChild(toast);
  _activeToast = toast;
  timer = setTimeout(dismiss, ms);
  window.addEventListener('hashchange', dismiss);
}

// One-shot hint when entering the annotation editor on a touch device: the
// two-finger scroll gesture is invisible UI, so it gets said out loud once
// per session. Desktop (fine pointer) scrolls with the wheel and needs no
// coaching.
function showAnnotateScrollHint(ms = 5000) {
  if (!window.matchMedia?.('(pointer: coarse)')?.matches) return;
  try {
    if (sessionStorage.getItem('sl-ann-scroll-hint')) return;
    sessionStorage.setItem('sl-ann-scroll-hint', '1');
  } catch { /* private mode: hint just shows each time */ }
  if (_activeToast) _activeToast.remove();
  const toast = el('div', 'sl-toast');
  toast.appendChild(el('span', 'sl-toast-msg', 'scroll with two fingers while annotating'));
  const dismiss = () => {
    window.removeEventListener('hashchange', dismiss);
    toast.remove();
    if (_activeToast === toast) _activeToast = null;
  };
  document.body.appendChild(toast);
  _activeToast = toast;
  setTimeout(dismiss, ms);
  window.addEventListener('hashchange', dismiss);
}

function keyBadge(key, origKey) {
  if (!key) return '';
  const label = origKey && origKey !== key ? `${key} <span class="sl-orig">(orig ${origKey})</span>` : key;
  return `<span class="sl-key-badge">${label}</span>`;
}

// Key-change callout. A mid-song modulation is easy to blow on stage, so a
// filled-in keyChanges renders as a loud pulsing badge right next to the key
// — never a dim afterthought.
function keyChangeBadge(keyChanges) {
  if (!keyChanges) return '';
  return `<span class="sl-keychange-badge">⚠ ${keyChanges}</span>`;
}

function vocalistDot(code, legend) {
  if (!code) return '';
  const name = legend?.[code] || code;
  return `<span class="sl-vocalist" data-v="${code}" title="${name}">${code}</span>`;
}

// Last default-artist used by setlist import / bulk assign — remembered so
// pasting the next originals set doesn't mean retyping the band name.
const IMPORT_ARTIST_KEY = 'voidstar.setlist.importArtist';

// Personal practice/readiness statuses — global per song (not per-setlist),
// stored as song.statuses (array of keys; absent/empty = all off). Toggled
// on the song page; setlist rows show the abbreviated badge.
const SONG_STATUSES = [
  { key: 'todo', label: 'todo', abbr: 'todo' },
  { key: 'needsWork', label: 'work', abbr: 'work' },
  { key: 'ok', label: 'ok', abbr: 'ok' },
  { key: 'goodToGo', label: 'good', abbr: 'good' },
  { key: 'steelLead', label: 'steel lead', abbr: 'steel' },
];

function statusBadges(song) {
  const active = song?.statuses || [];
  return SONG_STATUSES
    .filter(d => active.includes(d.key))
    .map(d => `<span class="sl-status-badge" data-s="${d.key}" title="${d.label}">${d.abbr}</span>`)
    .join('');
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

// Mount a text chart (a Google-Doc number chart as plain text) into a chart
// box as a flat, in-flow block. Flat matters: the Docs preview iframe scrolls
// its content internally, which the annotation overlay can't follow — a
// full-height block scrolls with the page, so the ink stays pinned. All type
// metrics are container-relative (cqw, see .sl-text-chart), so the layout
// scales uniformly with box width and the box's natural aspect — which
// annotation strokes are normalized against — is identical on every device.
function mountTextChart(box, text) {
  box.classList.add('sl-text-stage');
  box.style.aspectRatio = 'auto'; // the content's height defines the box
  box.dataset.naturalAspect = '1'; // don't clobber with stored/viewport aspect
  const pre = document.createElement('pre');
  pre.className = 'sl-text-chart';
  pre.textContent = text;
  return pre;
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
  if (isSyncing()) { setStatus('Backup already in progress…'); return false; }

  let client;
  try {
    client = await initGdriveBackup({ interactive });
  } catch (e) {
    setStatus(formatGdriveError(e), 'var(--pink)');
    return false;
  }
  if (!client) {
    setStatus(needsReconnect()
      ? 'Google Drive needs reconnecting — tap the backup pill on the home screen.'
      : 'Set a Google OAuth Client ID in Settings to enable backup.', 'var(--pink)');
    return false;
  }

  setBackupClient(client);
  setStatus('Backing up to Drive…', '');
  try {
    await pullMergePushCycle(
      client,
      () => store.exportAll(),
      (merged) => store.importAll(merged),
      { snapshotFn: () => store.putSnapshot('pre-sync'), historyForce: true },
    );
    setStatus(`✓ backed up · ${formatLastBackup()}`, 'var(--green)');
    return true;
  } catch (e) {
    setStatus(formatGdriveError(e), 'var(--pink)');
    return false;
  }
}

// A compact Drive-backup button + inline status, for edit-page action bars.
// On success it re-renders the page shortly after so pulled-in changes show.
function syncNowButton() {
  const wrap = el('div', 'sl-sync-inline');
  const status = el('span', 'sl-hint sl-sync-inline-status');
  const b = btn('⟲ drive backup', 'sl-btn-ghost sl-btn-sm', async () => {
    const ok = await runManualSync(status, { interactive: true });
    if (ok) setTimeout(() => refresh(), 900);
  });
  b.title = 'Back up to (and pull the latest from) your Google Drive now';
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
  actions.appendChild(btn('settings', 'sl-btn-ghost', () => navigate('#settings')));
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
    pill.title = gbackup ? `Last backup: ${formatLastBackup()} — tap to back up now`
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
  // (The load-time Drive pull + auto-push write hook used to be wired here,
  // dashboard-only — they now live in initSetlistApp/watchFocusSync in
  // app.js, so a fresh load on ANY hash starts from the latest backup.)
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

  // Practice-status filter — selected chips narrow the list to songs carrying
  // ALL of them ("steel lead" + "needs work" = steel songs to practice).
  const statusFilter = new Set();
  const filterRow = el('div', 'sl-status-row sl-lib-filter');
  for (const def of SONG_STATUSES) {
    const chip = btn(def.label, 'sl-status-chip', () => {
      if (statusFilter.has(def.key)) statusFilter.delete(def.key);
      else statusFilter.add(def.key);
      chip.classList.toggle('sl-on', statusFilter.has(def.key));
      renderList(search.value);
    });
    chip.dataset.s = def.key;
    filterRow.appendChild(chip);
  }
  root.appendChild(filterRow);

  // Library tools — the whole-library utility passes (health check, bulk
  // fill-empty passes, auto-link, offline downloads, batch link) live here
  // with the songs they operate on. Folded away by default so the everyday
  // search-and-tap list stays lean.
  const toolsToggle = btn('⚒ library tools', 'sl-btn-ghost sl-btn-sm sl-lib-tools-toggle', () => {
    const hidden = toolsPanel.classList.toggle('sl-hidden');
    toolsToggle.textContent = hidden ? '⚒ library tools' : '⚒ hide library tools';
  });
  root.appendChild(toolsToggle);
  const toolsPanel = buildLibraryTools(root, { onSongsChanged: () => reloadSongs() });
  toolsPanel.classList.add('sl-hidden');
  root.appendChild(toolsPanel);

  const listEl = el('div', 'sl-song-list');
  root.appendChild(listEl);

  let allSongs = await store.getAllSongs();
  allSongs.sort((a, b) => a.title.localeCompare(b.title));

  // Re-pull the list after a tools pass mutates songs (new keys, artists,
  // badges) — without rebuilding the whole view, which would wipe the pass's
  // status line and failure list mid-read.
  async function reloadSongs() {
    allSongs = await store.getAllSongs();
    allSongs.sort((a, b) => a.title.localeCompare(b.title));
    renderList(search.value);
  }

  function renderList(filter) {
    const lower = (filter || '').toLowerCase();
    let filtered = lower
      ? allSongs.filter(s => s.title.toLowerCase().includes(lower) || (s.artist || '').toLowerCase().includes(lower))
      : allSongs;
    if (statusFilter.size) {
      filtered = filtered.filter(s => [...statusFilter].every(k => (s.statuses || []).includes(k)));
    }
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
        ${statusBadges(s)}
        ${s.key ? `<span class="sl-key-badge sl-key-sm">${s.key}</span>` : ''}
      `;
      row.addEventListener('click', () => navigate(`#song/${s.id}`));
      listEl.appendChild(row);
    }
  }

  renderList('');
  search.addEventListener('input', () => renderList(search.value));
}

// ── Library tools: whole-library utility passes ──
// Everything here operates on song DATA across the whole library; each tool
// has a "this song only" counterpart on the song page (read chart / fetch
// info / steel summary / checkup / cache offline / search for chart / relink
// spotify). Config — worker URL, folders, accounts, backup — stays in
// Settings. `root` hosts the auto-link overlay; `onSongsChanged` lets the
// library list re-pull after a pass fills fields.
function buildLibraryTools(root, { onSongsChanged } = {}) {
  const wrap = el('div', 'sl-lib-tools');
  const songsChanged = () => { try { onSongsChanged?.(); } catch {} };

  // ── Library helpers: whole-library administrative passes (bulk.js) ──
  // The song page's per-song buttons ("read chart", "fetch info", "steel
  // summary"), run across every song that still needs them — so keeping the
  // library filled in doesn't require opening songs one by one. All passes
  // are fill-empty; the health check is how you see what's still missing.
  const helpersSection = el('div', 'sl-section');
  helpersSection.innerHTML = `
    <div class="sl-section-title">library helpers</div>
    <div class="sl-hint" style="margin-bottom:0.5rem">
      Bulk passes over the whole song library. They only fill fields that are
      still empty — nothing you've set by hand gets overwritten. Start with the
      health check to see what's missing.
    </div>
  `;
  const helperStatus = el('div', 'sl-hint');
  const helperResults = el('div', 'sl-source-list');
  const helperActions = el('div', 'sl-action-bar');

  // One pass at a time; per-song progress in the status line; failures land
  // in a tappable list (open the song, fix it there) instead of vanishing.
  let helperRunning = false;
  function renderHelperFailures(failures) {
    for (const f of failures) {
      const row = el('div', 'sl-source-row');
      const label = el('span', 'sl-source-url');
      label.textContent = `${f.song.title} — ${f.reason}`;
      row.appendChild(label);
      row.appendChild(btn('open', 'sl-btn-ghost sl-btn-sm', () => navigate(`#song/${f.song.id}`)));
      helperResults.appendChild(row);
    }
  }
  function helperButton(label, title, run, summarize) {
    const b = btn(label, 'sl-btn-ghost sl-btn-sm', async () => {
      if (helperRunning) return;
      helperRunning = true;
      b.disabled = true;
      helperResults.innerHTML = '';
      helperStatus.style.color = '';
      try {
        const res = await run(({ done, total, updated, title: t }) => {
          helperStatus.textContent = `${done}/${total} — ${t}${updated ? ` · ${updated} updated` : ''}`;
        });
        if (res.aborted) {
          helperStatus.textContent = `${label}: ${res.aborted}`;
          helperStatus.style.color = 'var(--pink)';
          renderHelperFailures(res.failures || []);
        } else {
          helperStatus.textContent = summarize(res);
          helperStatus.style.color = res.failures?.length ? 'var(--pink)' : 'var(--green)';
          renderHelperFailures(res.failures || []);
        }
        if (res.updated) songsChanged();
      } catch (e) {
        helperStatus.textContent = `${label} failed: ${e.message}`;
        helperStatus.style.color = 'var(--pink)';
      }
      helperRunning = false;
      b.disabled = false;
    });
    b.title = title;
    return b;
  }

  // Health check — read-only, instant, and the map for the other passes.
  // Each gap expands into the actual songs, tappable to jump there.
  helperActions.appendChild(btn('check library health', 'sl-btn-primary sl-btn-sm', async () => {
    helperResults.innerHTML = '';
    helperStatus.style.color = '';
    const h = await libraryHealth();
    if (!h.total) { helperStatus.textContent = 'No songs yet.'; return; }
    const gaps = h.checks.filter(c => c.songs.length);
    if (!gaps.length) {
      helperStatus.textContent = `${h.total} songs — everything filled in ✓`;
      helperStatus.style.color = 'var(--green)';
      return;
    }
    helperStatus.textContent = `${h.total} songs — still missing:`;
    for (const c of gaps) {
      const row = el('div', 'sl-source-row');
      row.appendChild(el('span', 'sl-source-url', `${c.label}: <b>${c.songs.length}</b>`));
      const sub = el('div', 'sl-health-sublist sl-hidden');
      for (const s of c.songs) {
        const songRow = el('div', 'sl-health-song');
        songRow.textContent = s.title + (s.artist ? ` — ${s.artist}` : '');
        songRow.addEventListener('click', () => navigate(`#song/${s.id}`));
        sub.appendChild(songRow);
      }
      const toggle = btn('list', 'sl-btn-ghost sl-btn-sm', () => {
        const hidden = sub.classList.toggle('sl-hidden');
        toggle.textContent = hidden ? 'list' : 'hide';
      });
      row.appendChild(toggle);
      helperResults.appendChild(row);
      helperResults.appendChild(sub);
    }
  }));

  helperActions.appendChild(helperButton(
    're-scan all charts',
    'Pull key / BPM / key-change info out of every linked chart — scrapes doc text, AI-reads scanned images for songs still missing a key (the song page\'s "read chart", library-wide)',
    (onProgress) => scanAllCharts(onProgress),
    (res) => `Scanned ${res.total} chart${res.total === 1 ? '' : 's'} · ${res.updated} song${res.updated === 1 ? '' : 's'} updated${res.failures.length ? ` · ${res.failures.length} still missing a key:` : ''}`,
  ));

  helperActions.appendChild(helperButton(
    'fetch info & lyrics',
    'Fill missing metadata (artist, key, genre, year, artwork, length) from music APIs and fetch lyrics from LRCLIB, for every song still missing any of it — the song page\'s "fetch info", library-wide',
    (onProgress) => fetchInfoForAllSongs(onProgress),
    (res) => `${res.total} song${res.total === 1 ? '' : 's'} needed info · ${res.updated} updated (${res.lyricsFilled} got lyrics) · ${res.skipped} already complete${res.failures.length ? ` · ${res.failures.length} failed:` : ''}`,
  ));

  helperActions.appendChild(helperButton(
    'AI steel summaries',
    'Draft a steel-direction summary for every song that doesn\'t have one yet — a web-search-grounded AI pass, roughly 15-30 seconds per song',
    async (onProgress) => {
      const missing = (await store.getAllSongs()).filter(s => !s.steelSummary).length;
      if (!missing) return { total: 0, updated: 0, failures: [] };
      if (!confirm(`Draft AI steel summaries for ${missing} song${missing === 1 ? '' : 's'} without one? Takes roughly 15-30 seconds per song — leave the tab open.`)) {
        return { aborted: 'cancelled' };
      }
      return summarizeSteelForAllSongs(onProgress);
    },
    (res) => (res.total === 0
      ? 'Every song already has a steel summary ✓'
      : `${res.updated} of ${res.total} summaries drafted${res.failures.length ? ` · ${res.failures.length} failed:` : ''}`),
  ));

  helperActions.appendChild(helperButton(
    'verify spotify links',
    'Check every linked song\'s Spotify track against its setlist playlist: links already in the playlist pass, links pointing elsewhere re-link to the playlist\'s same-title track (when unambiguous), the rest get flagged — the song page\'s "relink spotify", library-wide',
    async (onProgress) => {
      if (!confirm('Verify each song\'s Spotify link against its setlist playlist? A link that isn\'t in the playlist gets re-linked to the playlist\'s same-title track when there\'s exactly one; ambiguous ones are only flagged.')) {
        return { aborted: 'cancelled' };
      }
      return verifySpotifyLinks(onProgress);
    },
    (res) => (res.total === 0
      ? 'No linked songs appear in a setlist with a playlist URL.'
      : `${res.total} link${res.total === 1 ? '' : 's'} checked · ${res.ok} match the playlist · ${res.updated} re-linked${res.failures.length ? ` · ${res.failures.length} need a manual pick:` : ''}`),
  ));

  helpersSection.appendChild(helperActions);
  helpersSection.appendChild(helperStatus);
  helpersSection.appendChild(helperResults);
  wrap.appendChild(helpersSection);

  // Global auto-link pass (this is the matching feature, not Drive backup)
  const syncSection = el('div', 'sl-section');
  syncSection.innerHTML = '<div class="sl-section-title">auto-link all songs</div>';
  syncSection.appendChild(btn('auto-link now', 'sl-btn-accent', async () => {
    await runGlobalSync(root);
    songsChanged();
  }));
  syncSection.appendChild(el('div', 'sl-hint', 'Scans your setlists\' Spotify playlists, Bandcamp/SoundCloud pages, and chart folders, and fills each song\'s missing streaming + chart links. Never overwrites links you already have.'));
  wrap.appendChild(syncSection);

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
    // Caching a text chart fills an empty song.key from its header.
    songsChanged();
  });
  offlineActions.appendChild(dlAllBtn);
  offlineSection.appendChild(offlineActions);
  offlineSection.appendChild(offlineStatus);
  wrap.appendChild(offlineSection);
  refreshOfflineStatus();

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
    if (matched) songsChanged();
  }));
  wrap.appendChild(chartSection);

  // Spotify search links fallback
  const spotifySection = el('div', 'sl-section');
  spotifySection.innerHTML = `
    <div class="sl-section-title">spotify quick-link</div>
    <div class="sl-hint" style="margin-bottom:0.5rem">
      Songs without a Spotify link get a "search" button that opens Spotify search.
      With the sync worker deployed, auto-link fills links from your setlist playlists.
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
  wrap.appendChild(spotifySection);

  return wrap;
}

// ── Setlist View (compact cards) ──

export async function renderSetlistView(root, setlistId) {
  const sl = await store.getSetlist(setlistId);
  if (!sl) { root.appendChild(emptyState('Setlist not found.')); return; }

  const bar = topBar(sl.name, '#home');
  const actions = el('div', 'sl-actions');
  const autoLinkBtn = btn('auto-link', 'sl-btn-ghost', () => runSetlistSync(root, sl.id));
  autoLinkBtn.title = 'Match these songs to the Spotify playlist and chart folders';
  actions.appendChild(autoLinkBtn);
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
          ${statusBadges(song)}
          ${keyBadge(merged.key, merged._origKey)}
          ${keyChangeBadge(merged.keyChanges)}
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
    <label class="sl-label">Bandcamp URL<input class="sl-input" id="sl-bandcamp" value="${sl.bandcampUrl || ''}" placeholder="https://yourband.bandcamp.com/music"></label>
    <label class="sl-label">SoundCloud URL<input class="sl-input" id="sl-soundcloud" value="${sl.soundcloudUrl || ''}" placeholder="https://soundcloud.com/yourband"></label>
    <div class="sl-hint">Reference links for auto-link: songs on this setlist match against the playlist's / band page's tracks. Bandcamp takes a band page, /music, or an album link; SoundCloud a profile or /sets/ playlist.</div>
  `;
  root.appendChild(form);

  const save = async () => {
    sl.name = document.getElementById('sl-name').value;
    sl.venue = document.getElementById('sl-venue').value;
    sl.gigDate = document.getElementById('sl-date').value;
    sl.spotifyUrl = document.getElementById('sl-spotify').value;
    sl.bandcampUrl = document.getElementById('sl-bandcamp').value;
    sl.soundcloudUrl = document.getElementById('sl-soundcloud').value;
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
    store.putSetlist(sl).then(() => refresh());
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
  const artistLabel = el('label', 'sl-label',
    'Default artist <span class="sl-dim">(applied to songs with no artist named — covers stay unattributed)</span>');
  const artistInput = el('input', 'sl-input');
  artistInput.placeholder = 'e.g. your band name — optional';
  artistInput.value = localStorage.getItem(IMPORT_ARTIST_KEY) || '';
  artistLabel.appendChild(artistInput);
  importSection.appendChild(artistLabel);
  const textarea = el('textarea', 'sl-textarea');
  textarea.placeholder = 'Paste setlist text here...\n\nThe Grey Eagle 6/14\nSet 1:\n1  Song Title  C\n2  Crazy (Patsy Cline cover)\n3  Another Song  S';
  textarea.rows = 8;
  importSection.appendChild(textarea);
  importSection.appendChild(btn('import', 'sl-btn-primary', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    const defaultArtist = artistInput.value.trim();
    if (defaultArtist) localStorage.setItem(IMPORT_ARTIST_KEY, defaultArtist);
    else localStorage.removeItem(IMPORT_ARTIST_KEY);
    const parsed = parseTextList(text, { defaultArtist });
    if (!parsed.sets.length) { alert('No songs found.'); return; }

    let importedCount = 0;
    let artistCount = 0;
    const newSets = [];

    for (const pSet of parsed.sets) {
      const songIds = [];
      for (const ps of pSet.songs) {
        let song = await store.findSongByTitle(ps.title);
        if (!song) {
          song = store.createSong(ps.title, ps.artist);
          await store.putSong(song);
          if (ps.artist) artistCount++;
        } else if (ps.artist && !song.artist) {
          song.artist = ps.artist;
          await store.putSong(song);
          artistCount++;
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
    const metaNotes = [];
    const m = parsed.meta || {};
    if (!sl.venue && (m.venue || m.name)) {
      sl.venue = m.venue || m.name;
      metaNotes.push(`venue "${sl.venue}"`);
    }
    if (!sl.gigDate && m.gigDate) {
      sl.gigDate = m.gigDate;
      metaNotes.push(`date ${m.gigDate}`);
    }
    await store.putSetlist(sl);
    textarea.value = '';
    let msg = `Imported ${importedCount} songs across ${newSets.length} set(s).`;
    if (artistCount) msg += `\nArtist filled on ${artistCount} song(s).`;
    if (metaNotes.length) msg += `\nFrom the header line: ${metaNotes.join(', ')}.`;
    alert(msg);
    navigate(`#setlist/${sl.id}`);
  }));
  importSection.appendChild(btn('set artist on all songs…', 'sl-btn-ghost sl-btn-sm', async () => {
    const suggested = artistInput.value.trim() || localStorage.getItem(IMPORT_ARTIST_KEY) || '';
    const name = prompt('Artist for every song in this setlist (only fills songs with no artist):', suggested);
    if (!name || !name.trim()) return;
    const artist = name.trim();
    localStorage.setItem(IMPORT_ARTIST_KEY, artist);
    let setCount = 0;
    let skipped = 0;
    const seen = new Set();
    for (const set of sl.sets) {
      for (const id of set.songIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        const song = await store.getSong(id);
        if (!song) continue;
        if (song.artist) { skipped++; continue; }
        song.artist = artist;
        await store.putSong(song);
        setCount++;
      }
    }
    alert(`Artist "${artist}" set on ${setCount} song(s); ${skipped} already had one and were left alone.`);
    refresh();
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

// Shared by "create chart doc" and "rebuild doc": research the song (AI
// chart → chord-sheet scrape → template, with audio-analysis metadata in
// parallel), create the Google Doc, and fill empty song fields from whatever
// tier landed. Returns the new doc's webViewLink. The caller must have run
// ensureDriveAccess() inside the originating tap gesture.
async function researchAndCreateChartDoc(song, setStatus, { retry = false } = {}) {
  const metaPromise = fetchSongMeta(song);
  // retry (set by "rebuild doc"): bust the worker's 7-day AI-chart cache and
  // research harder — a rebuild that replays the cached chart would hand
  // back the exact doc the user just scrapped.
  const ai = await fetchAiChart(song, { retry });
  const meta = await metaPromise;
  const extra = { key: meta?.key || '', bpm: meta?.bpm || 0, time: meta?.time || '' };

  let text;
  const applied = {};
  if (ai.ok) {
    setStatus('drafting number chart (AI)...');
    text = buildAiChartText(song, ai.data, extra);
    applied.key = ai.data.key;
    applied.bpm = ai.data.bpm;
    applied.capo = ai.data.capo;
    applied.artist = ai.data.artist;
  } else {
    if (ai.reason !== 'no-ai-key') console.warn('[setlist] AI chart unavailable:', ai.reason);
    const chart = await fetchWebChartData(song);
    if (chart.ok) {
      setStatus('drafting number chart...');
      text = buildChartText(song, chart.data, extra);
      applied.key = chart.data.key;
      applied.capo = chart.data.capo;
      applied.artist = chart.data.artist;
    } else {
      console.warn('[setlist] chart data unavailable:', chart.reason);
      setStatus(chart.reason === 'worker-outdated' ? 'worker outdated — template...' : 'no chords found — template...');
      text = buildTemplateChartText(song, extra);
    }
  }

  const webViewLink = await createChartDoc(song, text);
  song.chartUrl = webViewLink;
  if (!song.key) song.key = applied.key || meta?.key || '';
  if (!song.bpm) song.bpm = applied.bpm || meta?.bpm || 0;
  if (!song.capo && applied.capo) song.capo = applied.capo;
  if (!song.artist && applied.artist) song.artist = applied.artist;
  await store.putSong(song);
  return webViewLink;
}

// Chart appearance — a per-mode 'dark'/'light' preference (perform and the
// regular views each remember their own). This is a TARGET look, not a raw
// invert switch: scans/PDF pages are natively white, so "dark" inverts
// them; our text charts are natively dark, so "light" restyles them to
// paper — a shared invert filter would do opposite things to the two
// document types. Legacy invert prefs migrate (invert-on meant "dark").
const CHART_APPEARANCE_KEYS = {
  detail: 'voidstar.setlist.chartAppearance.detail',
  perform: 'voidstar.setlist.chartAppearance.perform',
};
const LEGACY_INVERT_KEYS = {
  detail: 'voidstar.setlist.invertChartDetail',
  perform: 'voidstar.setlist.invertChart',
};

function chartAppearance(mode) {
  const v = localStorage.getItem(CHART_APPEARANCE_KEYS[mode]);
  if (v === 'dark' || v === 'light') return v;
  const legacy = localStorage.getItem(LEGACY_INVERT_KEYS[mode]);
  if (legacy === '1') return 'dark';
  if (legacy === '0') return 'light';
  return 'dark';
}

function setChartAppearance(mode, v) {
  localStorage.setItem(CHART_APPEARANCE_KEYS[mode], v);
}

function applyChartAppearance(box, mode) {
  const v = chartAppearance(mode);
  box.classList.toggle('sl-charts-dark', v === 'dark');
  box.classList.toggle('sl-charts-light', v === 'light');
  return v;
}

function chartAppearanceButton(stage, mode) {
  const label = () => (chartAppearance(mode) === 'dark' ? '◐ dark charts' : '◐ light charts');
  const b = btn(label(), 'sl-btn-ghost sl-btn-xs', () => {
    setChartAppearance(mode, chartAppearance(mode) === 'dark' ? 'light' : 'dark');
    applyChartAppearance(stage, mode);
    b.innerHTML = label();
  });
  b.title = 'Chart look: dark for stage, light like paper — each document type inverts only when it needs to';
  return b;
}

// The URL a cached image chart should render: the auto-leveled version when
// the enhance preference is on and processing succeeds, else the raw blob's
// URL. On success the raw URL is revoked HERE — the caller ends up owning
// exactly one object URL either way, so the existing revoke-on-navigate
// paths need no change.
async function chartDisplayUrl(cached) {
  if (!chartEnhanceEnabled()) return cached.url;
  const enhanced = await enhanceChartBlob(cached.blob);
  if (!enhanced) return cached.url;
  URL.revokeObjectURL(cached.url);
  return enhanced;
}

// "✦ enhance" toggle for scanned image charts — auto-levels faint scans to
// real ink-on-paper contrast (which the dark look then inverts cleanly).
// Toggling re-renders the view: unlike the appearance button this changes
// pixels, not CSS classes, so the chart has to remount.
function chartEnhanceButton() {
  const b = btn('✦ enhance', 'sl-btn-ghost sl-btn-xs', () => {
    setChartEnhanceEnabled(!chartEnhanceEnabled());
    refresh();
  });
  b.classList.toggle('sl-btn-active', chartEnhanceEnabled());
  b.title = 'Auto-levels for scanned charts: pins paper to white and ink to black, so faint pencil reads on stage';
  return b;
}

// A song's alternate charts (song.altCharts) — always an array. The field is
// lazy: old records simply don't have it.
function altChartsOf(song) {
  return Array.isArray(song?.altCharts) ? song.altCharts : [];
}

// The chart to render somewhere: which URL, which cache/annotation key, and
// whether it's the song's primary (primary-only side effects like key
// auto-fill hang off this). Alternates key their cache blob and annotation
// layer by store.altChartKey(songId, altId).
function chartRef(song, alt = null) {
  return alt
    ? { url: alt.url, key: store.altChartKey(song.id, alt.id), isPrimary: false }
    : { url: song.chartUrl, key: song.id, isPrimary: true };
}

// Mount the best remote (uncached) rendering of a chart into a stage box:
// flattened Drive image first (aligned and annotatable — Drive's thumbnail
// endpoint rides the user's cookies, so it works even for private files),
// the embeddable viewer only as a last resort (its internal scroll can't
// keep annotations aligned, and Google may CSP-block the frame entirely on
// devices not signed in), a bare <img> for direct image links. Also warms
// this device's offline cache in the background so the fallback is a
// first-visit-only experience.
function mountRemoteChartInto(stage, song, chart = null) {
  const c = chart || chartRef(song);
  const flatImageUrl = buildChartImageUrl(c.url);
  const embedUrl = buildChartEmbedUrl(c.url);

  const mountRawImg = () => {
    const raw = document.createElement('img');
    raw.src = c.url;
    raw.className = 'sl-annotation-img';
    lockAspectToImage(raw, stage);
    stage.appendChild(raw);
  };
  const mountIframe = () => {
    if (!embedUrl) return false;
    const iframe = document.createElement('iframe');
    iframe.src = embedUrl;
    iframe.className = 'sl-annotation-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    stage.appendChild(iframe);
    return true;
  };

  if (flatImageUrl) {
    const img = document.createElement('img');
    img.src = flatImageUrl;
    img.className = 'sl-annotation-img';
    lockAspectToImage(img, stage);
    img.addEventListener('error', () => {
      if (img.parentElement !== stage) return;
      img.remove();
      if (!mountIframe()) mountRawImg();
    }, { once: true });
    stage.appendChild(img);
    // Warm the offline cache: the primary path also auto-fills song.key from
    // text charts; alternates must not (different arrangement, different key).
    if (c.isPrimary) cacheChartForSong(song, getSources().workerUrl).catch(() => {});
    else cacheChartByUrl(c.key, c.url, getSources().workerUrl).catch(() => {});
  } else if (!mountIframe()) {
    mountRawImg();
  }
}

// Fill an empty song.key from chart text the page just rendered — the key is
// usually right in the chart header, so a song with a linked doc chart should
// never sit at "no key". Saves once, then patches the already-rendered "no
// key" badge in place rather than re-rendering mid-view.
async function maybeFillKeyFromChart(song, text) {
  if (song.key || !text) return;
  const key = extractKeyFromChartText(text);
  if (!key) return;
  song.key = key;
  await store.putSong(song);
  const empty = document.querySelector('.sl-focus-badges .sl-key-empty');
  if (empty) empty.outerHTML = keyBadge(key);
  console.log('[setlist] key parsed from chart header:', key);
}

// Inline chart display for the song page — the same aspect-locked stage
// pattern as the annotation editor (chart rect == canvas rect == the
// stored-aspect box, see docs/setlist-app.md), rendering the cached chart
// image (or the live embed) with that chart's annotations composited
// read-only on top. `chart` is a chartRef() — the primary or an alternate;
// key auto-fill (and the cache warm-up's key side effect) is primary-only.
async function renderInlineChart(container, song, chart) {
  const wrap = el('div', 'sl-focus-chart');
  const stage = el('div', 'sl-annotation-stage');
  applyChartAppearance(stage, 'detail');

  const tools = el('div', 'sl-chart-tools');
  tools.appendChild(chartAppearanceButton(stage, 'detail'));
  container.appendChild(tools);

  const cached = await getOfflineChart(chart.key, chart.url);
  if (cached?.kind === 'text') {
    stage.appendChild(mountTextChart(stage, cached.text));
    if (chart.isPrimary) maybeFillKeyFromChart(song, cached.text);
  } else if (cached) {
    const url = await chartDisplayUrl(cached);
    const img = document.createElement('img');
    img.src = url;
    img.className = 'sl-annotation-img';
    lockAspectToImage(img, stage);
    stage.appendChild(img);
    window.addEventListener('hashchange', () => URL.revokeObjectURL(url), { once: true });
    // Enhance only applies to cached image charts (live cross-origin images
    // taint the canvas; text charts have nothing to level), so the toggle
    // only appears when it can act.
    tools.appendChild(chartEnhanceButton());
  } else {
    // No cache: Google-Doc charts render flat from a live text export
    // (annotations can't track an iframe's internal scroll); anything else
    // renders the flattened Drive image with the embed as last resort.
    const liveText = await fetchChartText(chart.url, getSources().workerUrl);
    if (liveText) {
      stage.appendChild(mountTextChart(stage, liveText));
      if (chart.isPrimary) maybeFillKeyFromChart(song, liveText);
      else cacheChartByUrl(chart.key, chart.url, getSources().workerUrl).catch(() => {});
    } else {
      mountRemoteChartInto(stage, song, chart);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'sl-annotation-canvas';
  canvas.style.pointerEvents = 'none';
  stage.appendChild(canvas);
  wrap.appendChild(stage);
  container.appendChild(wrap);

  const data = await loadAnnotation(chart.key);
  // Natural image aspect wins (set by lockAspectToImage); the stored
  // authoring aspect covers iframe charts and pre-load.
  if (data?.aspect && !stage.dataset.naturalAspect) stage.style.aspectRatio = String(data.aspect);
  if (data?.strokes?.length) {
    const ctrl = renderReadonlyAnnotations(canvas, data.strokes);
    window.addEventListener('hashchange', () => ctrl.destroy(), { once: true });
  }
}

// Scratch-chart WIP preview for the song page: a chartless song with saved
// ink still shows what's been drawn (paper page + read-only strokes), so a
// hand-drawn chart in progress isn't invisible outside the editor.
async function renderInlineScratch(container, songId) {
  const data = await loadAnnotation(songId);
  if (!data?.strokes?.length) return;
  const wrap = el('div', 'sl-focus-chart');
  const stage = el('div', 'sl-annotation-stage sl-scratch-stage');
  stage.style.aspectRatio = String(data.aspect || SCRATCH_PAGE_ASPECT);
  const canvas = document.createElement('canvas');
  canvas.className = 'sl-annotation-canvas';
  canvas.style.pointerEvents = 'none';
  stage.appendChild(canvas);
  wrap.appendChild(stage);
  container.appendChild(wrap);
  const ctrl = renderReadonlyAnnotations(canvas, data.strokes);
  window.addEventListener('hashchange', () => ctrl.destroy(), { once: true });
}

// The setlist's reference-playlist tracks, ranked by title match, for
// relinking a song's Spotify URL to the RIGHT track (auto-matching can land
// on a same-titled cover/karaoke cut). Filter box for long playlists; "open"
// previews the track, "use" links it. Track names come from Spotify — set
// via textContent, never innerHTML.
function renderSpotifyPicker(wrap, tracks, song) {
  wrap.innerHTML = '';
  wrap.appendChild(el('div', 'sl-section-title', 'pick the right track from the playlist'));
  const filter = el('input', 'sl-search');
  filter.type = 'search';
  filter.placeholder = 'filter tracks...';
  wrap.appendChild(filter);
  const list = el('div', 'sl-chart-candidates');
  wrap.appendChild(list);

  const ranked = tracks
    .map(t => ({ t, score: matchScore(song.title, t.title) }))
    .sort((a, b) => b.score - a.score);

  const MAX_ROWS = 100;
  function renderRows(query) {
    const lower = (query || '').toLowerCase();
    list.innerHTML = '';
    let shown = 0;
    for (const { t, score } of ranked) {
      if (lower && !`${t.title} ${t.artist}`.toLowerCase().includes(lower)) continue;
      if (++shown > MAX_ROWS) {
        list.appendChild(el('div', 'sl-hint', `…and more — type to filter`));
        break;
      }
      const row = el('div', 'sl-chart-candidate');
      const info = el('div', 'sl-chart-candidate-info');
      const name = el('div', 'sl-chart-candidate-name');
      name.textContent = t.title;
      info.appendChild(name);
      const meta = el('div', 'sl-chart-candidate-meta');
      meta.textContent = `${t.artist}${score >= 0.5 ? ` · ${Math.round(score * 100)}% match` : ''}`;
      info.appendChild(meta);
      row.appendChild(info);
      const open = el('a', 'sl-btn sl-btn-ghost sl-btn-xs', 'open');
      open.href = t.spotifyUrl;
      open.target = '_blank';
      open.rel = 'noopener';
      row.appendChild(open);
      row.appendChild(btn('use', 'sl-btn-primary sl-btn-xs', async () => {
        song.spotifyUri = t.spotifyUrl;
        if (t.artist && !song.artist) song.artist = t.artist;
        await store.putSong(song);
        refresh();
      }));
      list.appendChild(row);
    }
    if (!shown) list.appendChild(el('div', 'sl-hint', 'no matching tracks'));
  }
  filter.addEventListener('input', () => renderRows(filter.value));
  renderRows('');
}

// Web-search chart candidates that didn't clear the auto-link threshold:
// let the user preview each one and pick. Names/URLs come from the open web,
// so they're set via textContent (the el() helper's innerHTML would XSS).
//
// alternate mode (the "find alt chart" flow on a song that already has a
// primary): "use" becomes "add alt" (append to song.altCharts, primary
// untouched) plus "make primary" (the old primary is demoted to an alternate
// — never silently discarded — and its annotation layer + cached blob move
// with it).
function renderChartCandidates(wrap, candidates, song, { alternate = false } = {}) {
  wrap.innerHTML = '';
  wrap.appendChild(el('div', 'sl-section-title', alternate ? 'possible alternate charts' : 'possible charts found online'));
  for (const c of candidates) {
    const row = el('div', 'sl-chart-candidate');
    const info = el('div', 'sl-chart-candidate-info');
    const name = el('div', 'sl-chart-candidate-name');
    name.textContent = c.name || c.url;
    info.appendChild(name);
    const meta = el('div', 'sl-chart-candidate-meta');
    meta.textContent = `${c.source}${c.verified ? '' : ' · unverified'} · ${Math.round((c.score || 0) * 100)}% match`;
    info.appendChild(meta);
    row.appendChild(info);
    const preview = el('a', 'sl-btn sl-btn-ghost sl-btn-xs', 'open');
    preview.href = c.url;
    preview.target = '_blank';
    preview.rel = 'noopener noreferrer';
    row.appendChild(preview);
    if (alternate) {
      const addBtn = btn('add alt', 'sl-btn-primary sl-btn-xs', async () => {
        const dupe = c.url === song.chartUrl || altChartsOf(song).some(a => a.url === c.url);
        if (dupe) { addBtn.textContent = 'already linked'; addBtn.disabled = true; return; }
        song.altCharts = [...altChartsOf(song), {
          id: crypto.randomUUID(),
          url: c.url,
          label: String(c.name || '').slice(0, 60) || `alt ${altChartsOf(song).length + 1}`,
          addedAt: Date.now(),
        }];
        await store.putSong(song);
        refresh();
      });
      row.appendChild(addBtn);
      row.appendChild(btn('make primary', 'sl-btn-ghost sl-btn-xs', async () => {
        if (!confirm('Replace the primary chart? The current chart is kept as an alternate, and its annotations move with it.')) return;
        await demotePrimaryToAlt(song);
        linkChartCandidate(song, c); // fill-empty key/bpm/capo side effects
        await store.putSong(song);
        refresh();
      }));
    } else {
      row.appendChild(btn('use', 'sl-btn-primary sl-btn-xs', async () => {
        linkChartCandidate(song, c);
        await store.putSong(song);
        refresh();
      }));
    }
    wrap.appendChild(row);
  }
}

// Demote the song's current primary chart into a new alternate entry, moving
// its annotation layer and cached blob to the alternate's composite key.
// Leaves song.chartUrl untouched-but-stale — the caller relinks it and saves.
async function demotePrimaryToAlt(song) {
  if (!song.chartUrl) return null;
  const alt = { id: crypto.randomUUID(), url: song.chartUrl, label: 'previous chart', addedAt: Date.now() };
  song.altCharts = [...altChartsOf(song), alt];
  const altKey = store.altChartKey(song.id, alt.id);
  const [ann, blob] = await Promise.all([store.getAnnotation(song.id), store.getChartBlob(song.id)]);
  if (ann) {
    await store.putAnnotation({ ...ann, songId: altKey });
    await store.deleteAnnotation(song.id);
  }
  if (blob?.blob) await store.putChartBlob(altKey, blob.blob, alt.url);
  await store.deleteChartBlob(song.id);
  return alt;
}

// Swap an alternate into the primary slot (and the primary into the alternate
// slot). Annotation layers and cached blobs follow their charts — the keyPath
// is the record's songId, so "moving" a layer is a put under the other key.
async function swapPrimaryWithAlt(song, alt) {
  const altKey = store.altChartKey(song.id, alt.id);
  const [pAnn, aAnn] = await Promise.all([store.getAnnotation(song.id), store.getAnnotation(altKey)]);
  const [pBlob, aBlob] = await Promise.all([store.getChartBlob(song.id), store.getChartBlob(altKey)]);
  const oldPrimaryUrl = song.chartUrl;
  song.chartUrl = alt.url;
  alt.url = oldPrimaryUrl;
  song.altCharts = altChartsOf(song).map(a => (a.id === alt.id ? alt : a));
  if (aAnn) await store.putAnnotation({ ...aAnn, songId: song.id });
  else await store.deleteAnnotation(song.id);
  if (pAnn) await store.putAnnotation({ ...pAnn, songId: altKey });
  else await store.deleteAnnotation(altKey);
  // Blob bytes are already in hand — swap them under the other keys with
  // corrected sourceUrls (getOfflineChart's stale-check would self-heal a
  // miss here anyway, at the cost of a refetch).
  if (aBlob?.blob) await store.putChartBlob(song.id, aBlob.blob, song.chartUrl);
  else await store.deleteChartBlob(song.id);
  if (pBlob?.blob) await store.putChartBlob(altKey, pBlob.blob, alt.url);
  else await store.deleteChartBlob(altKey);
  await store.putSong(song);
}

// Which chart tab the song page shows: sessionStorage (like noteDraft) so the
// selection survives the focus-sync refresh() and a mid-practice reload, but
// doesn't follow the user across devices. Absent = the primary chart.
const chartTabStorageKey = (songId) => `voidstar.setlist.chartTab.${songId}`;

function selectedAltChart(song) {
  try {
    const id = sessionStorage.getItem(chartTabStorageKey(song.id));
    return altChartsOf(song).find(a => a.id === id) || null;
  } catch { return null; }
}

function setSelectedChartTab(songId, altId) {
  try {
    if (altId) sessionStorage.setItem(chartTabStorageKey(songId), altId);
    else sessionStorage.removeItem(chartTabStorageKey(songId));
  } catch {}
}

// Chip row for switching between the primary chart and the alternates.
// Labels default from Drive filenames / web candidate names — untrusted, so
// they're set via textContent, never through el()/btn()'s innerHTML.
function buildChartTabs(song, selAlt) {
  const tabs = el('div', 'sl-chart-tabs');
  const chip = (label, altId) => {
    const active = (altId || '') === (selAlt?.id || '');
    const c = btn('', 'sl-chart-tab' + (active ? ' sl-chart-tab-active' : ''), () => {
      if (active) return;
      setSelectedChartTab(song.id, altId);
      refresh();
    });
    c.textContent = label;
    tabs.appendChild(c);
  };
  chip('primary', null);
  altChartsOf(song).forEach((a, i) => chip(a.label || `alt ${i + 1}`, a.id));
  return tabs;
}

// Action strip for the currently selected ALTERNATE chart (the primary's
// actions live in the main action bar and stay primary-only).
function buildAltActionsRow(song, alt, setlistId) {
  const row = el('div', 'sl-alt-chart-actions');
  row.appendChild(btn('annotate', 'sl-btn-accent sl-btn-xs', () => {
    navigate(`#song/${song.id}/${setlistId || '_'}/annotate/alt:${alt.id}`);
  }));
  row.appendChild(btn('open doc', 'sl-btn-ghost sl-btn-xs', () => {
    window.open(alt.url, '_blank');
  }));
  row.appendChild(btn('rename', 'sl-btn-ghost sl-btn-xs', async () => {
    const label = prompt('Label for this chart:', alt.label || '');
    if (label == null) return;
    alt.label = label.trim().slice(0, 60);
    song.altCharts = altChartsOf(song).map(a => (a.id === alt.id ? alt : a));
    await store.putSong(song);
    refresh();
  }));
  const cacheBtn = btn('cache offline', 'sl-btn-ghost sl-btn-xs', async () => {
    cacheBtn.disabled = true;
    cacheBtn.textContent = 'caching…';
    const r = await cacheChartByUrl(store.altChartKey(song.id, alt.id), alt.url, getSources().workerUrl);
    cacheBtn.textContent = r.ok ? '✓ cached offline' : 'cache failed';
    if (!r.ok) alert(`couldn't cache this chart: ${r.reason}`);
    setTimeout(() => { cacheBtn.textContent = 'cache offline'; cacheBtn.disabled = false; }, 2200);
  });
  row.appendChild(cacheBtn);
  row.appendChild(btn('make primary', 'sl-btn-ghost sl-btn-xs', async () => {
    if (!confirm('Make this the primary chart? The current primary becomes an alternate; each chart keeps its own annotations.')) return;
    await swapPrimaryWithAlt(song, alt);
    setSelectedChartTab(song.id, null); // the chart being viewed is now the primary tab
    refresh();
  }));
  row.appendChild(btn('remove', 'sl-btn-danger sl-btn-xs', async () => {
    if (!confirm(`Remove this alternate chart${alt.label ? ` ("${alt.label}")` : ''}? Its annotations are deleted too. The doc itself stays in Drive.`)) return;
    const altKey = store.altChartKey(song.id, alt.id);
    song.altCharts = altChartsOf(song).filter(a => a.id !== alt.id);
    await store.putSong(song);
    await store.deleteAnnotation(altKey);
    await store.deleteChartBlob(altKey);
    setSelectedChartTab(song.id, null);
    refresh();
  }));
  return row;
}

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

  // Main info. Artwork/genre/year/duration come from "fetch info" (iTunes
  // via the worker); kept dim/small — key + key changes are the stage info.
  const info = el('div', 'sl-focus-info');
  info.innerHTML = `
    <h1 class="sl-focus-title">${merged.title}</h1>
    ${merged.artist ? `<div class="sl-focus-artist">${merged.artist}</div>` : ''}
    <div class="sl-focus-badges">
      ${merged.key ? keyBadge(merged.key, merged._origKey) : '<span class="sl-key-badge sl-key-empty">no key</span>'}
      ${keyChangeBadge(merged.keyChanges)}
      ${merged.steelEntry ? `<span class="sl-steel-tag">steel: ${merged.steelEntry}</span>` : ''}
      ${song.durationSec ? `<span class="sl-badge sl-badge-dim">${formatTimecode(song.durationSec)}</span>` : ''}
      ${song.genre ? `<span class="sl-badge sl-badge-dim">${esc(song.genre)}</span>` : ''}
      ${song.year ? `<span class="sl-badge sl-badge-dim">${parseInt(song.year) || ''}</span>` : ''}
    </div>
  `;
  if (song.artworkUrl && /^https:\/\//.test(song.artworkUrl)) {
    const art = document.createElement('img');
    art.className = 'sl-focus-art';
    art.src = song.artworkUrl;
    art.alt = '';
    art.loading = 'lazy';
    info.insertBefore(art, info.firstChild);
  }
  // One steel-summary regen path, shared by the action-bar button and the
  // summary block's controls. `fresh` busts the worker's 7-day response
  // cache (an explicit redo must actually re-run, not replay the cached
  // answer); `retry` additionally marks the previous summary WRONG so the
  // model researches deeper before answering.
  const regenSteelSummary = async (b, opts = {}) => {
    const prevLabel = b.textContent;
    b.disabled = true;
    b.textContent = opts.retry ? 'digging deeper...' : 'researching steel...';
    const r = await fetchSteelSummary(song, opts);
    if (r.ok) {
      song.steelSummary = r.data.summary;
      await store.putSong(song);
      b.textContent = 'done!';
      setTimeout(() => refresh(), 900);
    } else {
      console.warn('[setlist] steel summary:', r.reason);
      const reasons = {
        'no-ai-key': 'no AI key configured on the worker — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY',
        'worker-outdated': 'worker outdated — redeploy workers/setlist-sync to get /ai/steel-summary',
        'no worker configured': 'no worker URL configured in Settings',
      };
      b.textContent = 'failed';
      alert(`steel summary failed: ${reasons[r.reason] || r.reason}`);
      setTimeout(() => { b.textContent = prevLabel; b.disabled = false; }, 2000);
    }
  };

  // Steel direction — the AI-drafted (hand-editable) quick summary of what
  // the steel does in this song, kept with the key/steel-entry stage info.
  // textContent: AI/external data never goes through innerHTML.
  // The summary is an AI claim about a recording, so it can be wrong — the
  // verdict controls live right on the block: fix the wording by hand,
  // re-roll it, re-roll with deeper research, or delete it.
  if (song.steelSummary) {
    const ss = el('div', 'sl-steel-summary');
    const ssText = el('div', 'sl-steel-summary-text');
    ssText.textContent = song.steelSummary;
    ss.appendChild(ssText);
    const ssActions = el('div', 'sl-steel-summary-actions');
    ssActions.appendChild(btn('✎ edit', 'sl-btn-ghost sl-btn-xs', () => {
      editForm.classList.remove('sl-hidden');
      const ta = document.getElementById('sf-steelsummary');
      ta?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      ta?.focus();
    }));
    const redoB = btn('↻ redo', 'sl-btn-ghost sl-btn-xs', () => regenSteelSummary(redoB, { fresh: true }));
    ssActions.appendChild(redoB);
    const wrongB = btn('✗ wrong — retry', 'sl-btn-ghost sl-btn-xs', () => regenSteelSummary(wrongB, { retry: true }));
    wrongB.title = 'Mark this summary inaccurate and regenerate with deeper research';
    ssActions.appendChild(wrongB);
    ssActions.appendChild(btn('delete', 'sl-btn-ghost sl-btn-xs', async () => {
      if (!confirm('Delete this steel summary? The deletion carries to your other devices on the next backup.')) return;
      // The tombstone stops the fill-empty backup merge from "helpfully"
      // restoring the deleted summary from another device's older copy.
      store.markCleared(song, 'steelSummary');
      song.steelSummary = '';
      await store.putSong(song);
      refresh();
    }));
    ss.appendChild(ssActions);
    info.appendChild(ss);
  }
  root.appendChild(info);

  // Practice-status toggles — independent on/off chips, saved immediately.
  const statusRow = el('div', 'sl-status-row');
  for (const def of SONG_STATUSES) {
    const chip = btn(def.label, 'sl-status-chip', async () => {
      const active = new Set(song.statuses || []);
      if (active.has(def.key)) active.delete(def.key);
      else active.add(def.key);
      song.statuses = [...active];
      await store.putSong(song);
      chip.classList.toggle('sl-on', active.has(def.key));
    });
    chip.dataset.s = def.key;
    if ((song.statuses || []).includes(def.key)) chip.classList.add('sl-on');
    statusRow.appendChild(chip);
  }
  root.appendChild(statusRow);

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
      <label class="sl-label sl-flex1">Key Changes<input class="sl-input" id="sf-keychanges" value="${song.keyChanges || ''}" placeholder="e.g. mod up to A, last chorus"></label>
    </div>
    <label class="sl-label">Steel Entry<input class="sl-input" id="sf-steel" value="${isOverride ? (merged.steelEntry || '') : (song.steelEntry || '')}" placeholder="e.g. intro, chorus, verse 2"></label>
    <label class="sl-label">Steel Summary<textarea class="sl-textarea sl-textarea-sm" id="sf-steelsummary" rows="2" placeholder="steel direction — the AI button drafts this, or write your own">${esc(song.steelSummary || '')}</textarea></label>
    <label class="sl-label">Spotify URL<input class="sl-input" id="sf-spotify" value="${song.spotifyUri || ''}" placeholder="https://open.spotify.com/track/..."></label>
    <label class="sl-label">Bandcamp URL<input class="sl-input" id="sf-bandcamp" value="${song.bandcampUrl || ''}" placeholder="https://yourband.bandcamp.com/track/..."></label>
    <label class="sl-label">SoundCloud URL<input class="sl-input" id="sf-soundcloud" value="${song.soundcloudUrl || ''}" placeholder="https://soundcloud.com/yourband/track"></label>
    <label class="sl-label">Chart URL (Google Drive)<input class="sl-input" id="sf-chart" value="${song.chartUrl || ''}" placeholder="https://drive.google.com/..."></label>
    ${isOverride ? '<div class="sl-hint">Key and steel entry save as overrides for this setlist. Title, artist, key changes, Spotify, and chart save to the base song.</div>' : ''}
  `;
  editForm.addEventListener('change', async () => {
    // Emptying a field here is an explicit delete — tombstone it, or the
    // fill-empty backup merge restores the old value from another device's
    // older copy on the next cycle.
    const clearedByForm = (field, next) => {
      if (song[field] && !(next || '').trim()) store.markCleared(song, field);
      return next;
    };
    song.title = document.getElementById('sf-title').value;
    song.artist = clearedByForm('artist', document.getElementById('sf-artist').value);
    song.keyChanges = clearedByForm('keyChanges', document.getElementById('sf-keychanges').value);
    song.steelSummary = clearedByForm('steelSummary', document.getElementById('sf-steelsummary').value.trim());
    song.spotifyUri = clearedByForm('spotifyUri', document.getElementById('sf-spotify').value);
    const nextBandcamp = document.getElementById('sf-bandcamp').value;
    if ((nextBandcamp || '').trim() !== (song.bandcampUrl || '')) {
      // The stored embed-player URL belongs to the OLD link — drop it (with
      // a tombstone, so the backup merge doesn't resurrect it) and let the
      // song page re-resolve the new one.
      if (song.bandcampEmbedUrl) store.markCleared(song, 'bandcampEmbedUrl');
      song.bandcampEmbedUrl = '';
    }
    song.bandcampUrl = clearedByForm('bandcampUrl', nextBandcamp);
    song.soundcloudUrl = clearedByForm('soundcloudUrl', document.getElementById('sf-soundcloud').value);
    song.chartUrl = clearedByForm('chartUrl', document.getElementById('sf-chart').value);

    const keyVal = document.getElementById('sf-key').value;
    const steelVal = document.getElementById('sf-steel').value;

    if (isOverride) {
      if (!setlist.songOverrides) setlist.songOverrides = {};
      if (!setlist.songOverrides[song.id]) setlist.songOverrides[song.id] = {};
      setlist.songOverrides[song.id].key = keyVal;
      setlist.songOverrides[song.id].steelEntry = steelVal;
      await store.putSetlist(setlist);
    } else {
      song.key = clearedByForm('key', keyVal);
      song.steelEntry = clearedByForm('steelEntry', steelVal);
    }
    await store.putSong(song);
  });
  root.appendChild(editForm);

  // Action buttons
  const actionBar = el('div', 'sl-action-bar');
  let chartCandidatesWrap = null; // filled by "search for chart" when web hits need a manual pick
  if (song.chartUrl) {
    // The chart itself renders inline below (with annotations) — no separate
    // chart page. "annotate" jumps straight into the full-screen editor.
    const annotateBtn = btn('annotate', 'sl-btn-accent', () => {
      navigate(`#song/${songId}/${setlistId || '_'}/annotate`);
    });
    actionBar.appendChild(annotateBtn);
    const editDocBtn = btn('edit doc', 'sl-btn-ghost sl-btn-sm', () => {
      window.open(song.chartUrl, '_blank');
    });
    actionBar.appendChild(editDocBtn);

    // Regenerate the doc from fresh research (same ladder as "create chart
    // doc") and relink the song. The OLD doc is never discarded silently:
    // the user chooses trash (recoverable from Drive's trash for ~30 days)
    // or keep (renamed "(replaced <date>)" in the charts folder). Either
    // way only app-created docs are touched — drive.file scope can't reach
    // community charts, so those are merely unlinked.
    const rebuildBtn = btn('rebuild doc', 'sl-btn-ghost sl-btn-sm', async () => {
      if (!confirm('Rebuild this chart doc from fresh research? The song relinks to the new doc; existing annotations stay but may need redrawing.')) return;
      const trashOld = confirm(
        'And the old doc itself?\n\nOK — move it to the Drive trash (recoverable for ~30 days)\nCancel — keep it in Drive, renamed "(replaced)"'
      );
      rebuildBtn.disabled = true;
      rebuildBtn.textContent = 'connecting drive...';
      try {
        await ensureDriveAccess();
        const oldUrl = song.chartUrl;
        rebuildBtn.textContent = 'researching song...';
        const webViewLink = await researchAndCreateChartDoc(song, (s) => { rebuildBtn.textContent = s; }, { retry: true });
        await store.deleteChartBlob(song.id); // drop the old doc's cached copy
        // Fire-and-forget; both only touch app-created docs.
        if (trashOld) trashChartDoc(oldUrl);
        else archiveChartDoc(oldUrl);
        const win = window.open(webViewLink, '_blank');
        if (!win) showLinkToast('chart doc rebuilt', webViewLink);
        refresh();
      } catch (e) {
        rebuildBtn.textContent = 'failed';
        alert(`rebuild doc failed: ${e.message}`);
        setTimeout(() => {
          rebuildBtn.textContent = 'rebuild doc';
          rebuildBtn.disabled = false;
        }, 2000);
      }
    });
    actionBar.appendChild(rebuildBtn);

    // "read chart" (né "scrape"): doc charts scrape their text export via
    // the worker; scanned/image charts have no text, so the image falls
    // through to the worker's vision route, which reads what's written on
    // the page (key, bpm, capo, modulation notes). The ladder itself lives
    // in bulk.js (readChartFields) — shared with Settings' library-wide
    // chart re-scan. Failures must be LOUD: the user explicitly clicked —
    // "no new data" when the real story is "no AI key on the worker" reads
    // as a dead button.
    const readBtn = btn('read chart', 'sl-btn-ghost sl-btn-sm', async () => {
      readBtn.disabled = true;
      readBtn.textContent = 'reading doc...';
      const stageLabels = { doc: 'reading doc...', fetch: 'fetching chart...', ai: 'reading scan (AI)...' };
      const { applied, problems } = await readChartFields(song, (stage) => {
        readBtn.textContent = stageLabels[stage] || 'reading...';
      });
      if (applied) {
        await store.putSong(song);
        readBtn.textContent = `found ${applied} field(s)!`;
        setTimeout(() => refresh(), 1200);
      } else if (problems.length) {
        console.warn('[setlist] read chart:', problems);
        readBtn.textContent = 'read failed';
        alert(`read chart couldn't pull anything:\n\n• ${problems.join('\n• ')}`);
      } else {
        readBtn.textContent = 'no new data';
      }
      setTimeout(() => { readBtn.textContent = 'read chart'; readBtn.disabled = false; }, 2500);
    });
    readBtn.title = 'Pull key / BPM / key-change notes from the linked chart — scrapes doc text, AI-reads a scanned image';
    actionBar.appendChild(readBtn);

    // "cache offline" — the library's "download all charts", this song only:
    // pin this chart into the offline cache so perform mode works with no
    // signal. (Text charts also fill an empty key from the chart header.)
    const cacheBtn = btn('cache offline', 'sl-btn-ghost sl-btn-sm', async () => {
      cacheBtn.disabled = true;
      cacheBtn.textContent = 'caching…';
      const hadKey = !!song.key;
      const r = await cacheChartForSong(song, getSources().workerUrl);
      if (r.ok) {
        cacheBtn.textContent = '✓ cached offline';
        // cacheChartForSong persists a key it finds — show it.
        if (!hadKey && song.key) setTimeout(() => refresh(), 1200);
      } else {
        cacheBtn.textContent = 'cache failed';
        alert(`couldn't cache this chart: ${r.reason}`);
      }
      setTimeout(() => { cacheBtn.textContent = 'cache offline'; cacheBtn.disabled = false; }, 2200);
    });
    cacheBtn.title = 'Download this chart into the offline cache so perform mode works with no signal';
    actionBar.appendChild(cacheBtn);

    // From-scratch redo even though a doc is linked: a blank paper page in
    // the annotation editor. Warn first — the song has ONE annotation layer,
    // so saving scratch ink replaces the current chart's annotations.
    const scratchBtn = btn('scratch chart', 'sl-btn-ghost sl-btn-sm', async () => {
      const existing = await loadAnnotation(songId);
      if (existing?.strokes?.length &&
          !confirm('Draw a new chart from a blank page?\n\nThe song keeps its current chart doc until you export and link the new one — but saving the scratch page replaces the annotations drawn on the current chart.')) return;
      navigate(`#song/${songId}/${setlistId || '_'}/annotate/scratch`);
    });
    scratchBtn.title = 'Draw a brand-new chart on a blank page, then export it to Drive';
    actionBar.appendChild(scratchBtn);

    // "find alt chart" — the same Drive + web search as the chartless
    // "search for chart", collect-only: nothing auto-links (a confident web
    // hit must not overwrite the primary), every hit lands in the picker
    // with "add alt" / "make primary".
    chartCandidatesWrap = el('div', 'sl-chart-candidates');
    const altSearchBtn = btn('find alt chart', 'sl-btn-ghost sl-btn-sm', async () => {
      altSearchBtn.disabled = true;
      const restore = (label) => {
        altSearchBtn.textContent = label;
        setTimeout(() => {
          altSearchBtn.textContent = 'find alt chart';
          altSearchBtn.disabled = false;
        }, 2200);
      };
      try {
        const result = await searchChartForSong(song, (stage) => {
          altSearchBtn.textContent = stage === 'web' ? 'searching the web...' : 'searching drive...';
        }, { collectOnly: true });
        if (result.candidates?.length) {
          renderChartCandidates(chartCandidatesWrap, result.candidates, song, { alternate: true });
          restore('pick below');
        } else if (result.providerDown) {
          if (result.warnings?.length) console.warn('[setlist] alt chart search:', ...result.warnings);
          restore('web search blocked — add search key');
        } else {
          restore('no match found');
        }
      } catch (e) {
        restore('search failed');
      }
    });
    altSearchBtn.title = 'Search your Drive folders and the web for another chart of this song, and link it as an alternate';
    actionBar.appendChild(altSearchBtn);
  } else {
    // Chart-fallback ladder: tiers 1+2 search personal + community Drive
    // folders, tier 3 scours the web for shared chart files (all via
    // searchChartForSong — a confident hit auto-links, weaker hits land in
    // the candidate picker below the action bar). Tier 4, "create chart
    // doc", researches the song's chords online and drafts a real number
    // chart — or a fill-in template when the web comes up empty too.
    chartCandidatesWrap = el('div', 'sl-chart-candidates');
    const searchBtn = btn('search for chart', 'sl-btn-ghost sl-btn-sm', async () => {
      searchBtn.disabled = true;
      const restore = (label) => {
        searchBtn.textContent = label;
        setTimeout(() => {
          searchBtn.textContent = 'search for chart';
          searchBtn.disabled = false;
        }, 2200);
      };
      try {
        const result = await searchChartForSong(song, (stage) => {
          searchBtn.textContent = stage === 'web' ? 'searching the web...' : 'searching drive...';
        });
        if (result.found) {
          await store.putSong(song);
          searchBtn.textContent = result.tier === 'web' ? 'found one online!' : 'found it!';
          setTimeout(() => refresh(), 900);
        } else if (result.candidates?.length) {
          renderChartCandidates(chartCandidatesWrap, result.candidates, song);
          restore('no sure match — pick below');
        } else if (result.providerDown) {
          if (result.warnings?.length) console.warn('[setlist] chart search:', ...result.warnings);
          restore('web search blocked — add search key');
        } else {
          restore('no match found');
        }
      } catch (e) {
        restore('search failed');
      }
    });
    actionBar.appendChild(searchBtn);

    const createBtn = btn('create chart doc', 'sl-btn-accent sl-btn-sm', async () => {
      createBtn.disabled = true;
      createBtn.textContent = 'connecting drive...';
      try {
        // Drive consent must happen NOW, inside the tap gesture — mobile
        // browsers block the OAuth popup once the slow research has pushed
        // us out of the gesture window. The token this caches covers the
        // doc creation at the end.
        await ensureDriveAccess();

        createBtn.textContent = 'researching song...';
        const webViewLink = await researchAndCreateChartDoc(song, (s) => { createBtn.textContent = s; });
        // window.open this long after the tap gets popup-blocked on mobile —
        // fall back to a toast whose link the user taps (a real gesture).
        const win = window.open(webViewLink, '_blank');
        if (!win) showLinkToast('chart doc created', webViewLink);
        refresh();
      } catch (e) {
        createBtn.textContent = 'failed';
        alert(`create chart doc failed: ${e.message}`);
        setTimeout(() => {
          createBtn.textContent = 'create chart doc';
          createBtn.disabled = false;
        }, 2000);
      }
    });
    actionBar.appendChild(createBtn);

    // Tier 5, by hand: originals (or anything research can't find) get a
    // blank paper page in the annotation editor — draw/type the chart, then
    // "make doc" exports it to Drive and links it here.
    const drawBtn = btn('draw chart', 'sl-btn-ghost sl-btn-sm', () => {
      navigate(`#song/${songId}/${setlistId || '_'}/annotate`);
    });
    drawBtn.title = 'Draw or type the chart yourself on a blank page — export it to Drive when ready';
    actionBar.appendChild(drawBtn);
  }
  // "fetch info" — one button for song metadata + lyrics: /meta/song on the
  // worker (Spotify audio-features / Deezer BPM / iTunes artist·genre·year·
  // artwork·length) plus LRCLIB lyrics straight from the browser (keyless,
  // CORS-open). Fill-empty: never overwrites a field you've set by hand.
  const infoBtn = btn('fetch info', 'sl-btn-ghost sl-btn-sm', async () => {
    infoBtn.disabled = true;
    infoBtn.textContent = 'fetching info...';
    try {
      const meta = await fetchSongMeta(song);
      infoBtn.textContent = 'fetching lyrics...';
      const lyr = await fetchLyrics(
        song.title,
        song.artist || meta?.artist || '',
        song.durationSec || meta?.durationSec || 0,
      );
      const filled = [];
      const fill = (field, value, label) => {
        if (!song[field] && value) { song[field] = value; filled.push(label || field); }
      };
      if (meta) {
        fill('artist', meta.artist);
        fill('key', meta.key);
        fill('bpm', meta.bpm);
        fill('genre', meta.genre);
        fill('year', meta.year);
        fill('durationSec', meta.durationSec, 'length');
        fill('artworkUrl', /^https:\/\//.test(meta.artworkUrl || '') ? meta.artworkUrl : '', 'art');
      }
      if (lyr) {
        const hadLyrics = !!song.lyrics;
        fill('lyrics', lyr.plain);
        if (!song.syncedLyrics && lyr.synced) {
          song.syncedLyrics = lyr.synced;
          // "lyrics" already announces the new-lyrics case; only call out
          // synced separately when it upgrades lyrics the song already had.
          if (hadLyrics) filled.push('synced lyrics');
        }
      }
      if (filled.length) {
        await store.putSong(song);
        infoBtn.textContent = `+ ${filled.join(', ')}`;
        setTimeout(() => refresh(), 1400);
      } else {
        infoBtn.textContent = 'nothing new';
        setTimeout(() => { infoBtn.textContent = 'fetch info'; infoBtn.disabled = false; }, 2200);
      }
    } catch (e) {
      console.warn('[setlist] fetch info:', e.message);
      infoBtn.textContent = 'failed';
      setTimeout(() => { infoBtn.textContent = 'fetch info'; infoBtn.disabled = false; }, 2200);
    }
  });
  infoBtn.title = 'Fill empty fields from music APIs (artist, key, genre, year, artwork, length) and fetch lyrics from LRCLIB';
  actionBar.appendChild(infoBtn);

  // "steel summary (AI)" — the steel-player's version of "create chart doc":
  // a search-grounded LLM writes a few concise sentences on the steel's role
  // in the recording (presence, entrances, style, intensity). Regenerating
  // overwrites the previous summary (the tap is the consent); the edit-
  // details form has a field for hand-tweaking the wording. Failures are
  // loud, same contract as "read chart".
  const steelLabel = song.steelSummary ? 'redo steel summary' : 'steel summary (AI)';
  // A redo busts the response cache (fresh:true) — replaying the cached
  // summary would make the button look broken; a first draft may still use
  // the cache.
  const steelBtn = btn(steelLabel, 'sl-btn-ghost sl-btn-sm', () =>
    regenSteelSummary(steelBtn, { fresh: !!song.steelSummary }));
  steelBtn.title = "AI-research the steel guitar's role in this song — presence, entrances, style, intensity";
  actionBar.appendChild(steelBtn);

  if (song.spotifyUri) {
    const spBtn = btn('open in spotify', 'sl-btn-spotify sl-btn-sm', () => {
      window.open(getSpotifyOpenUrl(song.spotifyUri), '_blank');
    });
    actionBar.appendChild(spBtn);
  }
  if (song.bandcampUrl) {
    actionBar.appendChild(btn('open in bandcamp', 'sl-btn-ghost sl-btn-sm', () => {
      window.open(song.bandcampUrl, '_blank');
    }));
  }
  if (song.soundcloudUrl) {
    actionBar.appendChild(btn('open in soundcloud', 'sl-btn-ghost sl-btn-sm', () => {
      window.open(song.soundcloudUrl, '_blank');
    }));
  }
  // Relink (or first-link) the Spotify track from the reference playlist —
  // the antidote to auto-matching landing on a same-titled cover.
  const spotifyPickerWrap = el('div', 'sl-spotify-picker');
  const loadSpotifyPicker = async (button, label, opts) => {
    button.disabled = true;
    button.textContent = 'loading playlist...';
    try {
      const { tracks, problems } = await getReferencePlaylistTracks(setlist, opts);
      if (tracks.length) {
        renderSpotifyPicker(spotifyPickerWrap, tracks, song);
        button.textContent = 'pick below';
      } else {
        // Show the real reason where there's room to read it.
        spotifyPickerWrap.innerHTML = '';
        const note = el('div', 'sl-hint');
        note.textContent = `Couldn't load playlist tracks: ${problems[0] || 'the playlist came back empty'}`;
        spotifyPickerWrap.appendChild(note);
        button.textContent = 'no tracks — see note';
      }
    } catch (e) {
      spotifyPickerWrap.innerHTML = '';
      const note = el('div', 'sl-hint');
      note.textContent = `Playlist fetch failed: ${e.message}`;
      spotifyPickerWrap.appendChild(note);
      button.textContent = 'failed — see note';
    }
    setTimeout(() => {
      button.textContent = label;
      button.disabled = false;
    }, 2200);
  };
  const relinkLabel = song.spotifyUri ? 'relink spotify' : 'pick spotify track';
  const relinkBtn = btn(relinkLabel, 'sl-btn-ghost sl-btn-sm', () =>
    loadSpotifyPicker(relinkBtn, relinkLabel, {}));
  actionBar.appendChild(relinkBtn);
  // Same picker, fed by scraping the public playlist page instead of the
  // API — the way in when Spotify's owner-only rule blocks every API read
  // of a bandmate's public playlist.
  const scrapeBtn = btn('scrape playlist', 'sl-btn-ghost sl-btn-sm', () =>
    loadSpotifyPicker(scrapeBtn, 'scrape playlist', { forceScrape: true }));
  scrapeBtn.title = "Read the setlist's reference playlist from its public open.spotify.com page (no API) — works for public playlists your account doesn't own, e.g. a bandmate's";
  actionBar.appendChild(scrapeBtn);
  if (!song.spotifyUri) {
    // No link yet — a raw Spotify search too (the quick-link tool's per-song
    // "search"), for when the reference playlists don't carry the song.
    const spSearchBtn = btn('spotify search', 'sl-btn-spotify sl-btn-sm', () => {
      window.open(spotifySearchUrl(song.title, song.artist), '_blank');
    });
    spSearchBtn.title = 'Open a Spotify search for this song in a new tab';
    actionBar.appendChild(spSearchBtn);
  }

  // "checkup" — the library health check, this song only: list what's still
  // missing so the buttons above can fill it.
  const checkupHint = el('div', 'sl-hint');
  const checkupBtn = btn('checkup', 'sl-btn-ghost sl-btn-sm', () => {
    const missing = songHealth(song);
    checkupHint.textContent = missing.length
      ? `still missing: ${missing.join(' · ')}`
      : 'everything filled in ✓';
    checkupHint.style.color = missing.length ? 'var(--pink)' : 'var(--green)';
  });
  checkupBtn.title = 'Check what this song is still missing (key, chart, lyrics, listen link, artist, steel summary)';
  actionBar.appendChild(checkupBtn);

  actionBar.appendChild(btn('⇣', 'sl-btn-icon', async () => {
    const data = await store.exportSong(songId);
    if (data) downloadJson(data, `song-${song.title.replace(/\s+/g, '-').toLowerCase()}.json`);
  }));
  // Quick "sync now" to Drive from the song page (whole dataset), shown once a
  // Drive client is configured.
  if (isGdriveBackupEnabled() || needsReconnect()) actionBar.appendChild(syncNowButton());
  root.appendChild(actionBar);
  root.appendChild(checkupHint);
  if (chartCandidatesWrap) root.appendChild(chartCandidatesWrap);
  root.appendChild(spotifyPickerWrap);

  // Inline chart with annotations — the old read-only chart page, folded in.
  // With alternates linked, a chip row switches which chart (and which
  // annotation layer) renders; the primary stays the default.
  if (song.chartUrl) {
    const selAlt = selectedAltChart(song);
    if (altChartsOf(song).length) {
      root.appendChild(buildChartTabs(song, selAlt));
      if (selAlt) root.appendChild(buildAltActionsRow(song, selAlt, setlistId));
    }
    await renderInlineChart(root, song, chartRef(song, selAlt));
  }
  // No chart, but scratch ink saved: show the drawn page.
  else await renderInlineScratch(root, songId);

  // Listening embed (Spotify, else Bandcamp, else SoundCloud) + timecode
  // tracker
  let currentTimecode = 0;
  let timecodeInterval = null;
  let isPlaying = false;
  // Assigned by the synced-lyrics section below; called each timer tick so
  // the active lyric line follows the timecode.
  let onTimecodeTick = null;
  const spotifyEmbeddable = !!(song.spotifyUri && parseSpotifyUrl(song.spotifyUri));
  const hasTimecodeTimer = spotifyEmbeddable || !!song.bandcampUrl || !!song.soundcloudUrl;
  // A running timer must not survive navigation (it would tick a detached
  // node forever — one leaked interval per song visited during practice).
  window.addEventListener('hashchange', () => {
    if (timecodeInterval) clearInterval(timecodeInterval);
  }, { once: true });
  if (hasTimecodeTimer) {
    const embedWrap = el('div', 'sl-spotify-embed');
    if (spotifyEmbeddable) {
      renderSpotifyEmbed(embedWrap, song.spotifyUri, 152);
    } else if (song.bandcampUrl) {
      // A hand-pasted link has no stored embed-player URL yet — resolve it
      // through the worker in the background and save the answer so the
      // lookup runs once per song, not per visit.
      renderBandcampEmbed(embedWrap, song, resolveBandcampEmbed, (s) => store.putSong(s));
    } else {
      renderSoundcloudEmbed(embedWrap, song.soundcloudUrl);
    }
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
          onTimecodeTick?.(currentTimecode);
        }, 1000);
      }
    });
    const tcResetBtn = btn('reset', 'sl-btn-ghost sl-btn-xs', () => {
      clearInterval(timecodeInterval);
      currentTimecode = 0;
      isPlaying = false;
      tcDisplay.textContent = '0:00';
      tcPlayBtn.textContent = 'start timer';
      onTimecodeTick?.(0);
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

  // Add note input. The draft survives re-renders (focus-sync refresh, swipe
  // nav, app-switching to check the track) via sessionStorage — an
  // uncommitted note must never silently vanish.
  const draftKey = `voidstar.setlist.noteDraft.${songId}`;
  const noteInput = el('div', 'sl-note-input');
  const textarea = el('textarea', 'sl-textarea sl-textarea-sm');
  textarea.placeholder = 'Add a note...';
  textarea.rows = 2;
  textarea.value = sessionStorage.getItem(draftKey) || '';
  textarea.addEventListener('input', () => {
    try { sessionStorage.setItem(draftKey, textarea.value); } catch {}
  });
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
    if (!text) return false;
    const note = store.createNote(songId, text, source);
    if (isPlaying || currentTimecode > 0) note.timecode = currentTimecode;
    if (sectionSelect.value) note.section = sectionSelect.value;
    Object.assign(note, extras);
    await store.putNote(note);
    notes.push(note);
    textarea.value = '';
    try { sessionStorage.removeItem(draftKey); } catch {}
    renderNotes();
    // Make the commit unmissable: show the new note card.
    notesList.lastElementChild?.scrollIntoView({ block: 'nearest' });
    return true;
  }

  const noteBtns = el('div', 'sl-note-btns');
  const addNoteBtn = btn('add note', 'sl-btn-primary sl-btn-sm', async () => {
    const ok = await addNote(textarea.value.trim(), 'typed');
    addNoteBtn.textContent = ok ? '✓ added' : 'type a note first';
    setTimeout(() => { addNoteBtn.textContent = 'add note'; }, 1200);
  });
  noteBtns.appendChild(addNoteBtn);
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

  // Lyrics — synced lines (LRC from LRCLIB) follow the timecode timer:
  // start the timer with the track and the active line highlights and
  // scrolls into view inside the lyrics box. Plain lyrics render as-is.
  // Lyrics are external data — textContent only, never innerHTML.
  if (song.lyrics || song.syncedLyrics) {
    const lyricsSection = el('div', 'sl-section');
    lyricsSection.innerHTML = '<div class="sl-section-title">lyrics</div>';
    const synced = song.syncedLyrics ? parseSyncedLyrics(song.syncedLyrics) : [];
    if (synced.length) {
      const wrap = el('div', 'sl-lyrics sl-lyrics-synced');
      const lineEls = synced.map(({ t, text }) => {
        const line = el('div', 'sl-lyrics-line');
        line.textContent = text || '·';
        wrap.appendChild(line);
        return { t, line };
      });
      lyricsSection.appendChild(wrap);
      if (hasTimecodeTimer) {
        lyricsSection.appendChild(el('div', 'sl-hint', 'synced — lines follow the timecode timer'));
      }
      let lastActive = -1;
      onTimecodeTick = (sec) => {
        let active = -1;
        for (let i = 0; i < lineEls.length && lineEls[i].t <= sec; i++) active = i;
        if (active === lastActive) return;
        if (lastActive >= 0) lineEls[lastActive].line.classList.remove('sl-active');
        if (active >= 0) {
          lineEls[active].line.classList.add('sl-active');
          // Scroll only the lyrics box (it owns its overflow), not the page.
          wrap.scrollTop = lineEls[active].line.offsetTop - wrap.clientHeight / 2;
        }
        lastActive = active;
      };
    } else {
      const pre = el('pre', 'sl-lyrics');
      pre.textContent = song.lyrics;
      lyricsSection.appendChild(pre);
    }
    root.appendChild(lyricsSection);
  }

  // Delete song (only from library view, not setlist context)
  if (!setlistId) {
    const danger = el('div', 'sl-section sl-danger-zone');
    danger.appendChild(btn('delete song', 'sl-btn-danger sl-btn-sm', async () => {
      if (!confirm(`Delete "${song.title}" and all its notes?`)) return;
      const songNotes = await store.getNotesForSong(songId);
      for (const n of songNotes) await store.deleteNote(n.id);
      // Every cached blob and annotation layer — primary AND alternates
      // (composite `${songId}::` keys). Annotations used to be skipped here
      // entirely, orphaning a record in IDB and in every Drive backup.
      await store.deleteChartBlobsForSong(songId).catch(() => {});
      await store.deleteAnnotationsForSong(songId).catch(() => {});
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

    // No swipe-to-navigate here (perform mode keeps it): the song page is an
    // editing surface — annotating, typing notes, dragging text-selection
    // handles — where horizontal drags are routine and a misread swipe swaps
    // the view mid-edit. The prev/next buttons above are the navigation.
  }
}

// ── Sync helpers ──

function showSyncOverlay(root) {
  const overlay = el('div', 'sl-sync-overlay');
  overlay.innerHTML = '<div class="sl-sync-spinner"></div><div class="sl-sync-status">matching songs to streaming links + charts...</div>';
  root.appendChild(overlay);
  return {
    update(msg) { overlay.querySelector('.sl-sync-status').textContent = msg; },
    done(results) {
      const parts = [];
      const errs = [];
      for (const [key, label] of [['spotify', 'Spotify'], ['bandcamp', 'Bandcamp'], ['soundcloud', 'SoundCloud'], ['drive', 'chart']]) {
        const r = results[key];
        if (!r) continue;
        if (r.matched) parts.push(`${r.matched} ${label}`);
        errs.push(...r.errors);
      }
      let msg = parts.length ? `Linked: ${parts.join(', ')}.` : 'No new matches found.';
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
  const bar = topBar('settings', '#home');
  root.appendChild(bar);
  // Settings is config only: worker URL, chart sources, accounts, backup.
  // Everything that OPERATES on the songs lives with them on the library page.
  root.appendChild(el('div', 'sl-hint', 'Library-wide passes (health check, re-scan, fetch info, steel summaries, auto-link, offline downloads) live on the library page under "library tools".'));

  const sources = getSources();

  // Worker URL
  const workerSection = el('div', 'sl-section');
  workerSection.innerHTML = `
    <div class="sl-section-title">sync worker url</div>
    <div class="sl-hint" style="margin-bottom:0.5rem">Optional. Deploy the setlist-sync Cloudflare Worker to enable auto-linking from Spotify playlists, Bandcamp/SoundCloud pages, and Google Drive folders.</div>
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
    'Your own Google Drive folders. Scanned directly (not their subfolders) — for nested archives, use Community Chart Folders below. Requires the setlist worker to be deployed.',
    'driveFolders',
  ));
  root.appendChild(buildFolderSection(
    'community chart folders',
    'Shared Dropbox/Drive folders in circulation among working musicians (e.g. a bandleader\'s master chart archive). Subfolders are searched recursively, which can be slower and is capped to protect API quotas.',
    'communityFolders',
  ));

  // Spotify user login (PKCE) — playlist reads run as the signed-in user.
  // Since Spotify's Feb 2026 API change this is the ONLY way a development-
  // mode app can read playlist contents at all (client credentials get
  // metadata only), and even a user token is owner-only: Spotify returns a
  // playlist's items just to an account that owns or collaborates on it.
  const spotifyAuthSection = el('div', 'sl-section');
  spotifyAuthSection.innerHTML = `
    <div class="sl-section-title">spotify account</div>
    <div class="sl-hint" style="margin-bottom:0.5rem">
      Connect your Spotify account so playlist reads run as you — since
      Spotify's Feb 2026 API change this is the only API path that can read
      playlist contents, and it only works for playlists your account owns
      or collaborates on (public/private no longer matters). For someone
      else's PUBLIC playlist (e.g. a bandmate's), the app falls back to
      scraping the playlist's public open.spotify.com page — no account
      needed; the song page also has an explicit "scrape playlist" button.
      Uses the
      same client id as the worker; no secret is involved. One-time setup: in
      the Spotify developer dashboard (developer.spotify.com → your app →
      Settings → Redirect URIs) add exactly:
      <code>${spotifyRedirectUri()}</code>
    </div>
    <label class="sl-label">Spotify Client ID
      <input class="sl-input" id="sl-spotify-client-id" value="${getSpotifyClientId()}" placeholder="client id from developer.spotify.com">
    </label>
  `;
  const spotifyIdInput = spotifyAuthSection.querySelector('#sl-spotify-client-id');
  spotifyIdInput?.addEventListener('change', () => setSpotifyClientId(spotifyIdInput.value));

  const spotifyAuthStatus = el('div', 'sl-hint',
    spotifyLoginError() || (isSpotifyConnected() ? 'Connected — checking the session…' : 'Not connected.'));
  if (spotifyLoginError()) spotifyAuthStatus.style.color = 'var(--red, #f66)';
  // "Connected" from a stored token can lie (revoked access, a dev-mode app
  // the account was removed from) — prove it against the live API so a broken
  // session shows up HERE, not as a cryptic auto-link failure later.
  if (!spotifyLoginError() && isSpotifyConnected()) {
    checkSpotifyConnection().then(({ ok, name, reason }) => {
      if (!spotifyAuthStatus.isConnected) return;
      spotifyAuthStatus.textContent = ok
        ? `Connected${name ? ` as ${name}` : ''} — playlists are read as your account.`
        : `Connected, but the session is broken: ${reason}.`;
      if (!ok) spotifyAuthStatus.style.color = 'var(--red, #f66)';
    });
  }

  const spotifyAuthActions = el('div', 'sl-action-bar');
  if (isSpotifyConnected()) {
    spotifyAuthActions.appendChild(btn('disconnect spotify', 'sl-btn-ghost sl-btn-sm', () => {
      disconnectSpotify();
      refresh();
    }));
  } else {
    spotifyAuthActions.appendChild(btn('connect spotify', 'sl-btn-primary sl-btn-sm', async () => {
      setSpotifyClientId(spotifyIdInput.value); // commit even without blur
      try {
        await beginSpotifyLogin(); // navigates away on success
      } catch (e) {
        spotifyAuthStatus.textContent = e.message;
        spotifyAuthStatus.style.color = 'var(--red, #f66)';
      }
    }));
  }
  spotifyAuthSection.appendChild(spotifyAuthActions);
  spotifyAuthSection.appendChild(spotifyAuthStatus);
  root.appendChild(spotifyAuthSection);

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

  // ── Version safeguards: undo the last backup merge/restore/import, or
  // restore an earlier Drive version. Every restore snapshots current state
  // first, so it's itself reversible via the same undo.
  const safetyActions = el('div', 'sl-action-bar');
  safetyActions.appendChild(btn('undo last merge/restore', 'sl-btn-ghost sl-btn-sm', async () => {
    const snaps = await store.listSnapshots();
    if (!snaps.length) {
      gdriveStatus.textContent = 'No snapshot to undo yet.';
      gdriveStatus.style.color = '';
      return;
    }
    if (!confirm('Revert to the state saved just before your last backup merge, restore, or import?')) return;
    await store.restoreSnapshot(snaps[0].ts);
    gdriveStatus.textContent = 'Reverted to the previous snapshot.';
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
          ? 'Reconnect Google Drive first (tap the backup pill on the home screen).'
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
  // Appearance toggle sits in the top control strip; nav bar keeps only
  // prev/next. Glyph-only to save strip space — the song page's labeled
  // "◐ dark/light charts" button teaches what the symbol means.
  // No active-state highlight: the chart itself shows which look is on, and
  // the accent color read as a distracting "warning" in the control strip.
  const invertBtn = btn('◐', 'sl-btn-ghost sl-btn-sm sl-perform-invert', () => {
    setChartAppearance('perform', chartAppearance('perform') === 'dark' ? 'light' : 'dark');
    if (currentChartWrap) applyChartAppearance(currentChartWrap, 'perform');
  });
  invertBtn.title = 'Chart look: dark for stage / light like paper';
  // Enhance toggle — remounts the chart through the auto-levels path, so it
  // needs a full render(), not a class flip. Shown only when the current
  // chart is a cached image (the only kind enhance can process).
  const enhanceBtn = btn('✦', 'sl-btn-ghost sl-btn-sm sl-perform-enhance', () => {
    setChartEnhanceEnabled(!chartEnhanceEnabled());
    render();
  });
  enhanceBtn.title = 'Boost faint scans (auto-levels)';
  navBar.appendChild(prevBtn);
  navBar.appendChild(navPos);
  navBar.appendChild(nextBtn);

  container.appendChild(progress);
  container.appendChild(exitBtn);
  container.appendChild(fsBtn);
  container.appendChild(detailBtn);
  container.appendChild(invertBtn);
  container.appendChild(enhanceBtn);
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
    enhanceBtn.style.display = 'none';
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
        ${keyChangeBadge(song.keyChanges)}
        ${vocalist ? vocalistDot(vocalist, sl.vocalistLegend) : ''}
      </div>
      ${song.steelEntry ? `<div class="sl-perform-steel">steel: ${song.steelEntry}</div>` : ''}
      ${song.steelSummary ? `<div class="sl-perform-steel-summary">${esc(song.steelSummary)}</div>` : ''}
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

      const chartWrap = el('div', 'sl-perform-chart-wrap');
      currentChartWrap = chartWrap;
      applyChartAppearance(chartWrap, 'perform');

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

      // Offline-cached chart first (renders with no network) — text for doc
      // charts, image otherwise; live text export for uncached docs, then the
      // remote image/embed. Async reads are guarded against a fast swipe that
      // has already moved us to a different song.
      getOfflineChart(entry.songId, song.chartUrl).then(async (cached) => {
        if (currentChartWrap !== chartWrap) {
          if (cached?.kind === 'image') URL.revokeObjectURL(cached.url);
          return;
        }
        if (cached?.kind === 'text') {
          insertChart(mountTextChart(chartWrap, cached.text));
        } else if (cached) {
          const url = await chartDisplayUrl(cached);
          // Re-check after the enhance pass — a fast swipe may have moved on.
          if (currentChartWrap !== chartWrap) { URL.revokeObjectURL(url); return; }
          currentChartObjectUrl = url;
          const img = document.createElement('img');
          img.src = url;
          img.className = 'sl-perform-chart-img sl-chart-flat';
          lockAspectToImage(img, chartWrap);
          insertChart(img);
          enhanceBtn.style.display = '';
        } else {
          const liveText = await fetchChartText(song.chartUrl, getSources().workerUrl);
          if (currentChartWrap !== chartWrap) return;
          if (liveText) insertChart(mountTextChart(chartWrap, liveText));
          else mountRemoteChart();
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

// ── Annotation editor ──
// The song page renders the chart (with annotations) inline, so this view's
// remaining job is full-screen editing: routed with {draw:true} it opens
// straight in draw mode and "done" saves + returns to the song page. Without
// the option it still behaves as the old read-only chart page.
//
// Scratch mode (no chart linked, or routed .../annotate/scratch): instead of
// a chart the stage is a blank paper page — draw/type the chart itself, then
// "make doc" renders it to a PNG in Drive's charts folder and offers to link
// it as the song's chart (clearing the ink, which now lives in the doc).

// US-letter portrait; the scratch page is destined for a printable doc.
const SCRATCH_PAGE_ASPECT = 8.5 / 11;

export async function renderAnnotation(root, songId, setlistId, { draw = false, scratch = false, altId = null } = {}) {
  const song = await store.getSong(songId);
  if (!song) { root.appendChild(emptyState('Song not found.')); return; }
  const backHash = setlistId ? `#song/${songId}/${setlistId}` : `#song/${songId}`;
  // Annotating an ALTERNATE chart: same editor, but the chart URL and the
  // annotation layer come from the alternate (layer keyed
  // store.altChartKey). A stale alt link (removed on another device) bails
  // back to the song page instead of silently annotating the primary.
  const alt = altId ? altChartsOf(song).find(a => a.id === altId) : null;
  if (altId && !alt) { navigate(backHash); return; }
  const chartUrl = alt ? alt.url : song.chartUrl;
  const annKey = alt ? store.altChartKey(songId, alt.id) : songId;
  // No linked chart = scratch mode implicitly: the editor is how a chartless
  // (e.g. original) song gets a chart drawn from nothing. (An alternate
  // always has a URL, so alt-annotate never enters scratch.)
  const isScratch = scratch || !chartUrl;
  // An explicit scratch redo over a linked chart starts with a blank page —
  // the song-page button confirms first, since saving replaces that chart's
  // annotations (the primary chart has one annotation layer).
  const startBlank = scratch && !!song.chartUrl;

  root.classList.add('sl-perform');
  const container = el('div', 'sl-annotation-container');
  const toolbar = el('div', 'sl-annotation-toolbar');

  const backBtn = btn('&larr;', 'sl-btn-icon', () => navigate(backHash));
  toolbar.appendChild(backBtn);
  toolbar.appendChild(el('span', 'sl-ann-sep'));

  // View controls (visible in read-only mode)
  const viewControls = el('div', 'sl-ann-controls');
  viewControls.style.cssText = 'display:flex;align-items:center;gap:0.35rem;flex:1;justify-content:flex-end';
  if (chartUrl) viewControls.appendChild(btn('edit chart', 'sl-btn-ghost sl-btn-sm', () => {
    window.open(chartUrl, '_blank');
  }));
  viewControls.appendChild(btn('annotate', 'sl-btn-sm sl-btn-primary', () => enterAnnotateMode()));
  toolbar.appendChild(viewControls);

  // Draw controls (hidden by default)
  const drawControls = el('div', 'sl-ann-controls');
  drawControls.style.cssText = 'display:none;align-items:center;gap:0.35rem;flex-wrap:wrap';
  drawControls.innerHTML = `
    <button class="sl-btn sl-btn-sm sl-ann-tool" data-tool="pan" title="Scroll chart (two fingers also scroll with any tool)">🖐</button>
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
  // Scratch-only controls: grow the page, and export the drawing as a real
  // chart doc. Created before doneBtn so "done" stays last in the row.
  let addPageBtn = null;
  let makeDocBtn = null;
  if (isScratch) {
    // On paper, dark ink is the chart itself — not markup — so it's the
    // sane default (initAnnotationCanvas reads its start color from here).
    const colorInput = drawControls.querySelector('.sl-ann-color');
    if (colorInput) colorInput.value = '#16181f';
    addPageBtn = btn('+ page', 'sl-btn-ghost sl-btn-sm', () => addScratchPage());
    addPageBtn.title = 'Extend the page — existing ink keeps its place and size';
    makeDocBtn = btn('make doc', 'sl-btn-accent sl-btn-sm', () => makeDocFromScratch());
    makeDocBtn.title = 'Render this page to a chart image in your Drive charts folder';
    drawControls.appendChild(addPageBtn);
    drawControls.appendChild(makeDocBtn);
  }
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
  if (isScratch) {
    // Blank paper page — no chart to mount, no appearance inversion: the
    // stage is WYSIWYG with the PNG the export renders.
    stage.classList.add('sl-scratch-stage');
  } else {
    // The editor follows the regular views' appearance preference.
    applyChartAppearance(stage, 'detail');

    // Offline-cached chart first (flat — text for docs, image otherwise —
    // which scrolls with the canvas and stays aligned); live text export for
    // docs, then embed/plain image as last resorts.
    const cached = await getOfflineChart(annKey, chartUrl);
    if (cached?.kind === 'text') {
      stage.appendChild(mountTextChart(stage, cached.text));
    } else if (cached) {
      // Same auto-leveled rendering as the song page — annotating a faint
      // scan is exactly when readability matters most. (Toggle lives on the
      // song page; the editor just follows the preference.)
      const url = await chartDisplayUrl(cached);
      const img = document.createElement('img');
      img.src = url;
      img.className = 'sl-annotation-img';
      lockAspectToImage(img, stage);
      stage.appendChild(img);
      window.addEventListener('hashchange', () => URL.revokeObjectURL(url), { once: true });
    } else {
      const liveText = await fetchChartText(chartUrl, getSources().workerUrl);
      if (liveText) stage.appendChild(mountTextChart(stage, liveText));
      else mountRemoteChartInto(stage, song, alt ? chartRef(song, alt) : null);
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
  // Live page shape of the scratch stage; "+ page" derives the page count
  // from it, so a saved multi-page scratch resumes correctly.
  let scratchAspect = SCRATCH_PAGE_ASPECT;
  if (isScratch) stage.style.aspectRatio = String(scratchAspect);

  requestAnimationFrame(async () => {
    const data = await loadAnnotation(annKey);
    if (isScratch) {
      // Resume the saved page shape (e.g. a multi-page scratch WIP) — except
      // for an explicit blank redo, which ignores the old chart's record.
      if (!startBlank && data?.aspect) {
        scratchAspect = data.aspect;
        stage.style.aspectRatio = String(scratchAspect);
      }
      return;
    }
    // The chart image's natural aspect (set by lockAspectToImage) is the source
    // of truth for the box shape. Only fall back to the authoring/viewport
    // aspect if the image hasn't provided one (iframe chart, or pre-load).
    const aspect = data?.aspect ||
      (canvasWrap.clientHeight
        ? canvasWrap.clientWidth / canvasWrap.clientHeight
        : window.innerWidth / Math.max(1, window.innerHeight - 96));
    if (!stage.dataset.naturalAspect) stage.style.aspectRatio = String(aspect);
    // Skip the read-only paint when draw mode already owns the canvas
    // (routed with {draw:true} — the editor loads existing strokes itself).
    if (data?.strokes?.length && !canvasCtrl) {
      readonlyCtrl = renderReadonlyAnnotations(canvas, data.strokes);
    }
  });

  if (draw) enterAnnotateMode();

  function enterAnnotateMode() {
    viewControls.style.display = 'none';
    drawControls.style.display = 'flex';
    canvas.style.pointerEvents = '';
    canvas.style.cursor = 'crosshair';
    if (readonlyCtrl) { readonlyCtrl.destroy(); readonlyCtrl = null; }
    canvasCtrl = initAnnotationCanvas(canvas, annKey, drawControls, { startBlank });
    showAnnotateScrollHint();
  }

  // Extend the scratch page by one letter-page of height. Existing ink keeps
  // its on-page position and size: y is normalized to box height, so it
  // compresses by oldHeight/newHeight as the box grows.
  function addScratchPage() {
    const pages = Math.max(1, Math.round(SCRATCH_PAGE_ASPECT / scratchAspect));
    const newAspect = SCRATCH_PAGE_ASPECT / (pages + 1);
    canvasCtrl?.scaleStrokeYs(newAspect / scratchAspect);
    scratchAspect = newAspect;
    stage.style.aspectRatio = String(newAspect);
  }

  // Render the scratch page to a PNG chart in Drive, then let the user pick:
  // link it as the song's chart (clearing the in-app ink — it's printed into
  // the doc now) or keep it as an export with the drawing still editable.
  async function makeDocFromScratch() {
    const strokes = canvasCtrl?.getStrokes() || [];
    if (!strokes.length) { alert('Nothing drawn yet — the page is empty.'); return; }
    makeDocBtn.disabled = true;
    makeDocBtn.textContent = 'connecting drive...';
    const reset = () => {
      makeDocBtn.textContent = 'make doc';
      makeDocBtn.disabled = false;
    };
    try {
      // OAuth consent must fire NOW, inside the tap gesture — the popup is
      // blocked once rendering/uploading pushes us out of the gesture window.
      await ensureDriveAccess();
      // Persist the ink before anything slow or fallible: the drawing must
      // survive a failed upload or a killed tab either way.
      drawControls.querySelector('#sl-ann-save')?.click();
      makeDocBtn.textContent = 'rendering page...';
      const blob = await renderStrokesToPngBlob(strokes, {
        aspect: canvas.height ? canvas.width / canvas.height : scratchAspect,
        sourceWidth: canvas.width,
      });
      makeDocBtn.textContent = 'uploading...';
      const webViewLink = await createChartImageFile(song, blob);
      const setPrimary = confirm(
        "Chart doc created in Drive.\n\nOK — set it as this song's chart and clear the in-app drawing (it's printed into the doc now)\nCancel — keep it as a Drive export only; the drawing stays editable here"
      );
      if (setPrimary) {
        song.chartUrl = webViewLink;
        await store.putSong(song);
        // The PNG bytes are already in hand — prime the offline cache
        // directly instead of a worker round-trip.
        await store.putChartBlob(songId, blob, webViewLink);
        await store.deleteAnnotation(songId);
        if (canvasCtrl) { canvasCtrl.destroy(); canvasCtrl = null; }
        showLinkToast('chart linked to this song', webViewLink);
        navigate(backHash);
        return;
      }
      showLinkToast('chart exported to Drive', webViewLink);
      reset();
    } catch (e) {
      alert(`make doc failed: ${e.message}`);
      reset();
    }
  }

  async function exitAnnotateMode() {
    const saveBtn = drawControls.querySelector('#sl-ann-save');
    if (saveBtn) saveBtn.click();

    if (canvasCtrl) { canvasCtrl.destroy(); canvasCtrl = null; }

    // Came straight from the song page: done = save and go back there —
    // the inline chart shows the result.
    if (draw) {
      await new Promise(r => setTimeout(r, 100));
      navigate(backHash);
      return;
    }

    viewControls.style.display = 'flex';
    drawControls.style.display = 'none';
    canvas.style.pointerEvents = 'none';
    canvas.style.cursor = '';

    await new Promise(r => setTimeout(r, 100));
    const data = await loadAnnotation(annKey);
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
