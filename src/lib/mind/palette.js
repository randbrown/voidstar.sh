// Command palette / quick-switcher (Ctrl/Cmd-K). A single keystroke to jump to
// any note or task by fuzzy title, or fire a common action, without leaving the
// keyboard. Built on the existing search index (search.js `query`) and the
// hash router — no new data, no new store surface.

import { query } from './search.js';
import { navigate } from './app.js';
import { startSketchNote } from './sketch.js';
import * as store from './store.js';
import { el, esc } from './ui.js';

let _open = false;

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function openDailyNote() {
  const key = todayKey();
  const all = await store.getAllNotes();
  let note = all.find(n => n.meta?.daily === key);
  if (!note) {
    note = store.createNote({ title: `${key} daily`, autoTitle: false, meta: { daily: key } });
    await store.putNoteRaw(note);
  }
  navigate(`#note/${note.id}`);
}

async function newNote() {
  const note = store.createNote({});
  await store.putNoteRaw(note);
  navigate(`#note/${note.id}`);
}

// Static commands, shown when they match the typed query (or when it's empty).
const COMMANDS = [
  { icon: '📝', label: 'New note', keywords: 'new note create', run: newNote },
  { icon: '✏️', label: 'New sketch', keywords: 'new sketch draw drawing doodle canvas whiteboard', run: () => startSketchNote() },
  { icon: '📅', label: "Today's daily note", keywords: 'today daily journal', run: openDailyNote },
  { icon: '✅', label: 'Tasks', keywords: 'tasks todo', run: () => navigate('#tasks') },
  { icon: '🎙', label: 'Voice capture', keywords: 'voice capture dictate record', run: () => navigate('#capture/voice/note') },
  { icon: '⚙️', label: 'Settings', keywords: 'settings preferences drive sync', run: () => navigate('#settings') },
  { icon: '🗑', label: 'Trash', keywords: 'trash deleted', run: () => navigate('#trash') },
];

export function openPalette() {
  if (_open) return;
  _open = true;

  const overlay = el('div', 'mn-modal-overlay mn-palette-overlay');
  const box = el('div', 'mn-palette');
  const input = el('input', 'mn-palette-input');
  input.type = 'text';
  input.placeholder = 'Jump to a note, task, or action…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const listEl = el('div', 'mn-palette-list');
  box.appendChild(input);
  box.appendChild(listEl);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  input.focus();

  let items = [];   // [{icon,label,sub,run}]
  let sel = 0;
  let runId = 0;    // guards out-of-order async results

  function close() {
    _open = false;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  }

  function render() {
    listEl.innerHTML = '';
    if (!items.length) {
      listEl.appendChild(el('div', 'mn-palette-empty', 'No matches'));
      return;
    }
    items.forEach((it, i) => {
      const row = el('div', `mn-palette-row${i === sel ? ' mn-palette-sel' : ''}`);
      row.innerHTML = `<span class="mn-palette-icon">${it.icon || ''}</span>` +
        `<span class="mn-palette-label">${esc(it.label)}</span>` +
        (it.sub ? `<span class="mn-palette-sub">${esc(it.sub)}</span>` : '');
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render(); } });
      row.addEventListener('click', () => activate(i));
      listEl.appendChild(row);
    });
    const cur = listEl.querySelector('.mn-palette-sel');
    cur?.scrollIntoView({ block: 'nearest' });
  }

  function activate(i) {
    const it = items[i];
    if (!it) return;
    close();
    Promise.resolve().then(it.run).catch(e => console.warn('[mind] palette action:', e?.message));
  }

  async function update() {
    const q = input.value.trim();
    const id = ++runId;
    const ql = q.toLowerCase();
    const cmds = COMMANDS
      .filter(c => !ql || c.label.toLowerCase().includes(ql) || c.keywords.includes(ql))
      .map(c => ({ icon: c.icon, label: c.label, sub: 'action', run: c.run }));

    let results = [];
    if (q) {
      const hits = await query(q);
      if (id !== runId) return; // a newer keystroke superseded this search
      results = hits.slice(0, 30).map(e => e.type === 'task'
        ? { icon: '✅', label: e.title || '(untitled task)', sub: 'task', run: () => navigate(`#task/${e.id}`) }
        : { icon: '📄', label: e.title || '(untitled note)', sub: 'note', run: () => navigate(`#note/${e.id}`) });
    }
    // Commands first when the box is empty (a launcher); search hits first once
    // the user is clearly looking for something (typed ≥ 2 chars).
    items = q.length >= 2 ? [...results, ...cmds] : [...cmds, ...results];
    sel = 0;
    render();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; render(); } return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; render(); } return; }
    if (e.key === 'Enter') { e.preventDefault(); activate(sel); return; }
  }

  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  input.addEventListener('input', () => { update(); });
  update();
}

// Wire the global Ctrl/Cmd-K shortcut. Ignored while a text field/editor has
// focus so it can't hijack typing (except our own palette input, handled by
// the toggle). Call once from initMindApp.
export function wireCommandPalette() {
  if (typeof window === 'undefined') return;
  // Capture phase so the shortcut fires before an editor keymap (e.g.
  // ProseMirror) can claim Ctrl-K — the quick-switcher is the higher-value
  // global binding.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (_open) return;
      openPalette();
    }
  }, true);
}
