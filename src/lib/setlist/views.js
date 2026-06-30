// All view renderers for the setlist lab.

import * as store from './store.js';
import { navigate, getLastSongId, setLastSongId } from './app.js';
import { parseTextList, isSpotifyUrl } from './import.js';
import { renderSpotifyEmbed, getSpotifyOpenUrl, fetchOEmbed, parseSpotifyUrl } from './spotify.js';
import { createDictation, isSupported as voiceSupported } from './voice.js';

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

// ── Dashboard ──

export async function renderDashboard(root) {
  const bar = topBar('setlist');
  const actions = el('div', 'sl-actions');
  actions.appendChild(btn('+ new setlist', 'sl-btn-primary', async () => {
    const name = prompt('Setlist name:');
    if (!name) return;
    const sl = store.createSetlist(name);
    await store.putSetlist(sl);
    navigate(`#setlist/${sl.id}/edit`);
  }));
  actions.appendChild(btn('song library', 'sl-btn-ghost', () => navigate('#library')));
  bar.appendChild(actions);
  root.appendChild(bar);

  const setlists = await store.getAllSetlists();
  if (!setlists.length) {
    root.appendChild(emptyState('No setlists yet. Create one or import from text.'));
    return;
  }

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
  actions.appendChild(btn('perform', 'sl-btn-accent', () => navigate(`#perform/${sl.id}`)));
  actions.appendChild(btn('edit', 'sl-btn-ghost', () => navigate(`#setlist/${sl.id}/edit`)));
  bar.appendChild(actions);
  root.appendChild(bar);

  if (sl.venue || sl.gigDate) {
    const meta = el('div', 'sl-setlist-meta', `${sl.venue || ''} ${sl.gigDate ? '&middot; ' + sl.gigDate : ''}`);
    root.appendChild(meta);
  }

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
          <span class="sl-song-card-title">${merged.title}</span>
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

export async function renderSetlistEdit(root, setlistId) {
  let sl = await store.getSetlist(setlistId);
  if (!sl) { root.appendChild(emptyState('Setlist not found.')); return; }

  const bar = topBar('edit: ' + sl.name, `#setlist/${sl.id}`);
  root.appendChild(bar);

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

    sl.sets = newSets;
    await store.putSetlist(sl);
    textarea.value = '';
    alert(`Imported ${importedCount} songs across ${newSets.length} set(s).`);
    navigate(`#setlist/${sl.id}`);
  }));
  root.appendChild(importSection);

  // Songs per set
  for (let si = 0; si < sl.sets.length; si++) {
    const set = sl.sets[si];
    const section = el('div', 'sl-section');
    section.innerHTML = `<div class="sl-section-title">${set.name} <span class="sl-dim">(${set.songIds.length} songs)</span></div>`;

    for (let i = 0; i < set.songIds.length; i++) {
      const song = await store.getSong(set.songIds[i]);
      if (!song) continue;
      const row = el('div', 'sl-edit-row');
      row.innerHTML = `<span class="sl-song-num">${i + 1}</span><span>${song.title}</span>`;
      const removeBtn = btn('&times;', 'sl-btn-icon sl-btn-danger', async () => {
        set.songIds.splice(i, 1);
        await store.putSetlist(sl);
        navigate(`#setlist/${sl.id}/edit`);
      });
      row.appendChild(removeBtn);
      section.appendChild(row);
    }

    section.appendChild(btn('+ add song', 'sl-btn-sm', async () => {
      const allSongs = await store.getAllSongs();
      const title = prompt('Song title (or search):');
      if (!title) return;
      let song = allSongs.find(s => s.title.toLowerCase().includes(title.toLowerCase()));
      if (!song) {
        song = store.createSong(title);
        await store.putSong(song);
      }
      set.songIds.push(song.id);
      await store.putSetlist(sl);
      navigate(`#setlist/${sl.id}/edit`);
    }));
    root.appendChild(section);
  }

  // Add set
  root.appendChild(btn('+ add set', 'sl-btn-ghost', async () => {
    sl.sets.push({ name: `Set ${sl.sets.length + 1}`, songIds: [] });
    await store.putSetlist(sl);
    navigate(`#setlist/${sl.id}/edit`);
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
    const chartBtn = btn('open chart', 'sl-btn-accent', () => window.open(song.chartUrl, '_blank'));
    actionBar.appendChild(chartBtn);
  }
  if (song.spotifyUri) {
    const spBtn = btn('open in spotify', 'sl-btn-spotify', () => {
      window.open(getSpotifyOpenUrl(song.spotifyUri), '_blank');
    });
    actionBar.appendChild(spBtn);
  }
  root.appendChild(actionBar);

  // Spotify embed
  if (song.spotifyUri && parseSpotifyUrl(song.spotifyUri)) {
    const embedWrap = el('div', 'sl-spotify-embed');
    renderSpotifyEmbed(embedWrap, song.spotifyUri, 80);
    root.appendChild(embedWrap);
  }

  // Notes
  const notesSection = el('div', 'sl-section');
  notesSection.innerHTML = '<div class="sl-section-title">notes</div>';
  const notesList = el('div', 'sl-notes-list');
  notesSection.appendChild(notesList);

  const notes = await store.getNotesForSong(songId);

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
      nEl.innerHTML = `
        <div class="sl-note-text">${n.text}</div>
        <div class="sl-note-meta">
          <span>${ts}</span>
          ${n.source === 'voice' ? '<span class="sl-voice-badge">voice</span>' : ''}
        </div>
      `;
      const delBtn = btn('&times;', 'sl-btn-icon sl-btn-danger sl-btn-xs', async () => {
        await store.deleteNote(n.id);
        const idx = notes.indexOf(n);
        if (idx >= 0) notes.splice(idx, 1);
        renderNotes();
      });
      nEl.appendChild(delBtn);
      notesList.appendChild(nEl);
    }
  }
  renderNotes();

  // Add note
  const noteInput = el('div', 'sl-note-input');
  const textarea = el('textarea', 'sl-textarea sl-textarea-sm');
  textarea.placeholder = 'Add a note...';
  textarea.rows = 2;
  noteInput.appendChild(textarea);

  const noteBtns = el('div', 'sl-note-btns');
  noteBtns.appendChild(btn('add note', 'sl-btn-primary sl-btn-sm', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    const note = store.createNote(songId, text, 'typed');
    await store.putNote(note);
    notes.push(note);
    textarea.value = '';
    renderNotes();
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
          const note = store.createNote(songId, text, 'voice');
          await store.putNote(note);
          notes.push(note);
          renderNotes();
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
      await store.deleteSong(songId);
      navigate('#library');
    }));
    root.appendChild(danger);
  }
}

// ── Performance Mode ──

export async function renderPerformMode(root, setlistId) {
  const sl = await store.getSetlist(setlistId);
  if (!sl) { root.appendChild(emptyState('Setlist not found.')); return; }

  root.classList.add('sl-perform');

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

  let idx = entries.findIndex(e => e.type === 'song');
  if (idx < 0) { root.appendChild(emptyState('No songs in this setlist.')); return; }

  // Request fullscreen + wake lock
  try { document.documentElement.requestFullscreen?.(); } catch {}
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  const container = el('div', 'sl-perform-container');
  const progress = el('div', 'sl-perform-progress');
  const counter = el('div', 'sl-perform-counter');
  const content = el('div', 'sl-perform-content');
  const exitBtn = btn('&times;', 'sl-btn-icon sl-perform-exit', () => {
    try { document.exitFullscreen?.(); } catch {}
    try { wakeLock?.release(); } catch {}
    navigate(`#setlist/${setlistId}`);
  });

  container.appendChild(progress);
  container.appendChild(exitBtn);
  container.appendChild(counter);
  container.appendChild(content);
  root.appendChild(container);

  const songEntries = entries.filter(e => e.type === 'song');
  const totalSongs = songEntries.length;

  function getSongIndex() {
    let n = 0;
    for (let i = 0; i <= idx; i++) {
      if (entries[i].type === 'song') n++;
    }
    return n;
  }

  function render() {
    const entry = entries[idx];
    const songNum = getSongIndex();
    progress.style.width = `${(songNum / totalSongs) * 100}%`;
    counter.textContent = `${songNum} / ${totalSongs}`;

    if (entry.type === 'divider') {
      content.innerHTML = `<div class="sl-perform-divider">${entry.name}</div>`;
      return;
    }

    const { song, notes, vocalist } = entry;
    content.innerHTML = `
      <h1 class="sl-perform-title">${song.title}</h1>
      ${song.artist ? `<div class="sl-perform-artist">${song.artist}</div>` : ''}
      <div class="sl-perform-badges">
        ${song.key ? keyBadge(song.key, song._origKey) : ''}
        ${song.capo ? `<span class="sl-badge">capo ${song.capo}</span>` : ''}
        ${song.bpm ? `<span class="sl-badge">${song.bpm} bpm</span>` : ''}
        ${vocalist ? vocalistDot(vocalist, sl.vocalistLegend) : ''}
      </div>
      ${song.steelEntry ? `<div class="sl-perform-steel">steel: ${song.steelEntry}</div>` : ''}
      ${notes.length ? `<div class="sl-perform-notes">${notes.map(n => `<div class="sl-perform-note">${n.text}</div>`).join('')}</div>` : ''}
      ${song.chartUrl ? `<a class="sl-btn sl-btn-accent sl-perform-chart" href="${song.chartUrl}" target="_blank" rel="noopener">open chart</a>` : ''}
    `;
  }

  function go(dir) {
    const next = idx + dir;
    if (next >= 0 && next < entries.length) {
      idx = next;
      // Skip dividers if swiping
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
  let touchStartX = 0, touchStartY = 0;
  container.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  container.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
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
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup);
}
