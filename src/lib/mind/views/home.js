// Home — the main page: new note first, folder bar, pinned TODO card,
// recent notes with sort / filter / search all inline.
//
// Folders are a SOFT filter: the current folder's content renders normally,
// everything else stays visible but dimmed in an "elsewhere" section —
// you never lose sight of the rest of the brain.

import * as store from '../store.js';
import { query, allTags } from '../search.js';
import { markdownToText } from '../editor/markdown.js';
import { tokenize, markText, snippetHighlighted } from '../search-highlight.js';
import { setTaskDoneEverywhere } from '../tasks-sync.js';
import { parseCapture } from '../capture.js';
import { armReminder, reminderSheet, reminderBadge } from '../reminders.js';
import {
  hasClientId, needsReconnect, onSyncState, initGdriveSync, setSyncClient,
  ensureDriveAccess, pullMergePushCycle,
} from '../gdrive-sync.js';
import { pushPendingAttachments } from '../attachments-drive.js';
import { navigate, refresh } from '../app.js';
import { el, esc, btn, emptyState, timeAgo, textPrompt, confirmBox } from '../ui.js';

const SORT_KEY = 'voidstar.mind.sort';
const TODO_OPEN_KEY = 'voidstar.mind.todoExpanded';
const FOLDER_KEY = 'voidstar.mind.folder';
const TAGS_OPEN_KEY = 'voidstar.mind.tagsExpanded';

let _q = ''; // search text survives re-renders within the session
let _filter = { kind: '', tag: '' };

export function currentFolderId() {
  return localStorage.getItem(FOLDER_KEY) || '';
}

function setCurrentFolder(id) {
  localStorage.setItem(FOLDER_KEY, id || '');
}

export async function renderHome(root) {
  const folders = await store.getAllFolders();
  let folderId = currentFolderId();
  // A folder deleted on another device may still be the sticky selection.
  if (folderId && !folders.some(f => f.id === folderId)) {
    folderId = '';
    setCurrentFolder('');
  }
  const scope = folderId ? store.folderScope(folders, folderId) : null;
  const inScope = (fid) => !scope || scope.has(fid || '');

  // Header stays light — primary navigation lives in the dock (position
  // configurable in settings). Header keeps identity + sync + daily note.
  const head = el('div', 'mn-apphead');
  head.appendChild(el('span', 'mn-wordmark', 'mind'));
  const actions = el('div', 'mn-head-actions');
  const todayBtn = btn('today', '', () => openDailyNote(folderId));
  todayBtn.title = 'open (or create) today’s daily note';
  actions.appendChild(todayBtn);
  head.appendChild(actions);
  root.appendChild(head);

  // Sync status pill (only once Drive is configured). Tapping it when a
  // reconnect is needed re-auths inside the tap's gesture window.
  if (hasClientId()) {
    const pill = el('button', 'mn-sync-pill');
    const setPill = (state) => {
      const s = needsReconnect() ? 'reconnect' : state;
      pill.dataset.state = s;
      pill.textContent = { idle: 'drive ·', syncing: 'syncing…', synced: 'synced ✓', pending: 'push pending', offline: 'offline', reconnect: 'reconnect drive' }[s] || s;
    };
    onSyncState(setPill);
    pill.addEventListener('click', async () => {
      try {
        await ensureDriveAccess();
        const client = await initGdriveSync({ interactive: true });
        setSyncClient(client);
        await pullMergePushCycle(client,
          () => store.exportAll(), (m) => store.importAll(m),
          { snapshotFn: () => store.putSnapshot('pre-sync') });
        pushPendingAttachments();
        refresh();
      } catch (e) { alert(`sync failed: ${e.message}`); }
    });
    actions.insertBefore(pill, actions.firstChild);
  }

  // ── Folder bar: breadcrumb + subfolder chips + manage ──
  root.appendChild(folderBar(folders, folderId));

  // ── Search / sort / filter row ──
  const controls = el('div', 'mn-controls');
  const searchInput = el('input', 'mn-input mn-search');
  searchInput.type = 'search';
  searchInput.placeholder = 'search notes, tasks, image text…';
  searchInput.value = _q;
  controls.appendChild(searchInput);

  const sortSel = el('select', 'mn-select');
  for (const [v, label] of [['edited', 'recently edited'], ['created', 'recently created'], ['title', 'title a→z']]) {
    const o = el('option', '', label); o.value = v; sortSel.appendChild(o);
  }
  sortSel.value = localStorage.getItem(SORT_KEY) || 'edited';
  sortSel.addEventListener('change', () => { localStorage.setItem(SORT_KEY, sortSel.value); renderList(); });
  controls.appendChild(sortSel);
  root.appendChild(controls);

  // Filter chips: attachment kinds + tags (+ new-from-template when any
  // note is tagged #template). Tags collapse behind a toggle — on a phone the
  // full tag list can be several rows tall, pushing results under the keyboard.
  const chips = el('div', 'mn-chips');
  const kindChips = [['', 'all'], ['image', 'images'], ['audio', 'audio'], ['pdf', 'pdfs']];
  const tags = await allTags();
  let tagsOpen = localStorage.getItem(TAGS_OPEN_KEY) === '1';
  const drawChips = () => {
    chips.innerHTML = '';
    if (tags.includes('template')) {
      chips.appendChild(btn('&#65291; from template', 'mn-chip mn-folder-chip', () => pickTemplate(folderId)));
    }
    for (const [kind, label] of kindChips) {
      const c = btn(label, `mn-chip ${(!_filter.tag && _filter.kind === kind) ? 'mn-chip-on' : ''}`, () => {
        _filter = { kind, tag: '' };
        drawChips(); renderList();
      });
      chips.appendChild(c);
    }
    if (tags.length) {
      chips.appendChild(btn(
        `#tags ${tagsOpen ? '&#9662;' : '&#9656;'}`,
        `mn-chip mn-tags-toggle ${_filter.tag ? 'mn-chip-on' : ''}`,
        () => {
          tagsOpen = !tagsOpen;
          localStorage.setItem(TAGS_OPEN_KEY, tagsOpen ? '1' : '0');
          drawChips();
        },
      ));
      // When collapsed, keep the active tag visible so the current filter is
      // never hidden and can still be cleared with a tap.
      const shown = tagsOpen ? tags : (_filter.tag ? [_filter.tag] : []);
      for (const t of shown) {
        const c = btn(`#${esc(t)}`, `mn-chip ${_filter.tag === t ? 'mn-chip-on' : ''}`, () => {
          _filter = _filter.tag === t ? { kind: '', tag: '' } : { kind: '', tag: t };
          drawChips(); renderList();
        });
        chips.appendChild(c);
      }
    }
  };
  drawChips();
  root.appendChild(chips);

  // ── Pinned TODO card ──
  const todoWrap = el('div');
  root.appendChild(todoWrap);
  await renderTodoCard(todoWrap, folders, folderId, scope);

  // ── Notes list ──
  const listWrap = el('div', 'mn-notelist');
  root.appendChild(listWrap);

  let _renderSeq = 0;
  async function renderList() {
    // While searching, the pinned TODO card just pushes results down under the
    // keyboard — hide it so the first hits land right below the search box.
    todoWrap.hidden = !!_q;
    const seq = ++_renderSeq;
    const results = await query(_q, {
      kind: _filter.kind || undefined,
      tag: _filter.tag || undefined,
    });
    if (seq !== _renderSeq) return; // a newer keystroke superseded this run

    const notes = results.filter(r => r.type === 'note');
    const taskHits = _q ? results.filter(r => r.type === 'task') : [];

    const sort = sortSel.value;
    const cmp = (a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    };
    const here = notes.filter(n => inScope(n.folderId)).sort(cmp);
    const elsewhere = scope ? notes.filter(n => !inScope(n.folderId)).sort(cmp) : [];

    listWrap.innerHTML = '';

    if (taskHits.length) {
      listWrap.appendChild(el('div', 'mn-section-label', `tasks (${taskHits.length})`));
      for (const hit of taskHits) listWrap.appendChild(taskHitRow(hit.task, !inScope(hit.folderId)));
      listWrap.appendChild(el('div', 'mn-section-label', `notes (${here.length + elsewhere.length})`));
    }

    if (!here.length && !elsewhere.length) {
      listWrap.appendChild(emptyState(_q || _filter.kind || _filter.tag
        ? 'nothing matches.'
        : 'no notes yet — hit <b>+ note</b> to capture the first one.'));
      return;
    }

    for (const entry of here) listWrap.appendChild(noteCard(entry, folders, false));

    if (elsewhere.length) {
      listWrap.appendChild(el('div', 'mn-section-label', `elsewhere (${elsewhere.length})`));
      for (const entry of elsewhere) listWrap.appendChild(noteCard(entry, folders, true));
    }
  }

  let _debounce = 0;
  searchInput.addEventListener('input', () => {
    _q = searchInput.value.trim();
    clearTimeout(_debounce);
    _debounce = setTimeout(renderList, 150);
  });

  await renderList();
}

// ── Daily note: one per calendar day, found by meta.daily, reused if it
// exists (any folder), created in the current folder otherwise. ──

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function openDailyNote(folderId) {
  const key = todayKey();
  const all = await store.getAllNotes();
  let note = all.find(n => n.meta?.daily === key);
  if (!note) {
    note = store.createNote({
      folderId,
      title: `${key} daily`,
      autoTitle: false,
      meta: { daily: key },
    });
    await store.putNoteRaw(note);
  }
  navigate(`#note/${note.id}`);
}

// ── New from template: any note tagged #template is a template; a copy
// drops the tag and gets a fresh sortable auto-title. ──

async function pickTemplate(folderId) {
  const all = await store.getAllNotes();
  const templates = all.filter(n => (n.tags || []).includes('template'))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!templates.length) return;

  const overlay = el('div', 'mn-modal-overlay');
  const box = el('div', 'mn-modal');
  box.appendChild(el('div', 'mn-modal-title', 'new note from template'));
  const list = el('div', 'mn-linklist');
  for (const t of templates) {
    list.appendChild(btn(esc(t.title), 'mn-btn-ghost mn-linkrow', async () => {
      overlay.remove();
      const note = store.createNote({
        folderId,
        title: await store.uniqueAutoTitle(),
        body: t.body,
        tags: (t.tags || []).filter(x => x !== 'template'),
      });
      await store.putNoteRaw(note);
      navigate(`#note/${note.id}`);
    }));
  }
  box.appendChild(list);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ── Folder bar ──

function folderBar(folders, folderId) {
  const bar = el('div', 'mn-folderbar');

  // Breadcrumb: ~ / work / AirVision
  const crumb = el('div', 'mn-crumbs');
  const rootBtn = btn('~', `mn-crumb ${!folderId ? 'mn-crumb-on' : ''}`, () => { setCurrentFolder(''); refresh(); });
  rootBtn.title = 'all folders';
  crumb.appendChild(rootBtn);

  if (folderId) {
    const byId = new Map(folders.map(f => [f.id, f]));
    const chain = [];
    let cur = byId.get(folderId);
    let guard = 0;
    while (cur && guard++ < 20) { chain.unshift(cur); cur = byId.get(cur.parentId); }
    for (const f of chain) {
      crumb.appendChild(el('span', 'mn-crumb-sep', '/'));
      crumb.appendChild(btn(esc(f.name), `mn-crumb ${f.id === folderId ? 'mn-crumb-on' : ''}`, () => {
        setCurrentFolder(f.id); refresh();
      }));
    }
  }
  bar.appendChild(crumb);

  // Subfolders of the current location + management.
  const row = el('div', 'mn-subfolders');
  const kids = folders.filter(f => (f.parentId || '') === folderId)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const f of kids) {
    row.appendChild(btn(`&#128193; ${esc(f.name)}`, 'mn-chip mn-folder-chip', () => {
      setCurrentFolder(f.id); refresh();
    }));
  }
  row.appendChild(btn('+ folder', 'mn-chip', () => {
    textPrompt({
      title: folderId ? 'new subfolder' : 'new folder', placeholder: 'folder name',
      onOk: async (name) => {
        if (!name) return;
        await store.putFolderRaw(store.createFolder(name, folderId));
        refresh();
      },
    });
  }));
  if (folderId) {
    const f = folders.find(x => x.id === folderId);
    row.appendChild(btn('rename', 'mn-chip', () => {
      textPrompt({
        title: 'rename folder', value: f?.name || '',
        onOk: async (name) => {
          if (!name || !f) return;
          await store.putFolder({ ...f, name });
          refresh();
        },
      });
    }));
    row.appendChild(btn('delete', 'mn-chip mn-chip-danger', () => {
      confirmBox(`Delete folder "${f?.name}"? Its notes, subfolders, and task lists move up a level — nothing is deleted.`, async () => {
        await store.deleteFolderAndReparent(f);
        setCurrentFolder(f.parentId || '');
        refresh();
      });
    }));
  }
  bar.appendChild(row);
  return bar;
}

// Deep-link into a note, carrying the active search query so the editor can
// highlight matches + scroll to the first one.
function noteHash(id) {
  return `#note/${id}${_q ? `?q=${encodeURIComponent(_q)}` : ''}`;
}

function noteCard(entry, folders, dimmed) {
  const n = entry.note;
  const tokens = _q ? tokenize(_q) : [];
  const card = el('div', `mn-card mn-notecard ${dimmed ? 'mn-dimcard' : ''}`);
  card.addEventListener('click', () => navigate(noteHash(n.id)));

  const row = el('div', 'mn-card-titlerow');
  if (n.pinned) row.appendChild(el('span', 'mn-pin-dot', '&#9733;'));
  if (n.conflictOf) row.appendChild(el('span', 'mn-conflict-badge', 'conflict'));
  row.appendChild(el('span', 'mn-card-title', markText(n.title, tokens)));
  row.appendChild(el('span', 'mn-card-time', timeAgo(n.updatedAt)));
  card.appendChild(row);

  const body = markdownToText(n.body);
  const flat = body.split('\n').filter(l => l.trim() && l.trim() !== n.title.trim()).join(' · ');
  const snippet = snippetHighlighted(flat, tokens, { max: 160 });
  if (snippet) card.appendChild(el('div', 'mn-card-snippet', snippet));

  const metaBits = [];
  const path = n.folderId ? store.folderPath(folders, n.folderId) : '';
  if (path) metaBits.push(`<span class="mn-minifolder">&#128193; ${esc(path)}</span>`);
  if (entry.kinds.includes('image')) metaBits.push('&#128247;');
  if (entry.kinds.includes('audio')) metaBits.push('&#127908;');
  if (entry.kinds.includes('pdf')) metaBits.push('&#128196;');
  for (const t of n.tags || []) metaBits.push(`<span class="mn-minitag">#${esc(t)}</span>`);
  if (metaBits.length) card.appendChild(el('div', 'mn-card-meta', metaBits.join(' ')));

  return card;
}

function taskHitRow(task, dimmed) {
  const tokens = _q ? tokenize(_q) : [];
  const row = el('div', `mn-card mn-taskhit ${dimmed ? 'mn-dimcard' : ''}`);
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = task.done;
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', async () => {
    await setTaskDoneEverywhere(task, cb.checked);
    refresh();
  });
  row.appendChild(cb);
  row.appendChild(el('span', `mn-task-text ${task.done ? 'mn-struck' : ''}`, markText(task.text, tokens)));
  row.addEventListener('click', () => {
    navigate(task.sourceNoteId ? noteHash(task.sourceNoteId) : `#tasks/${task.listId}`);
  });
  return row;
}

// ── Pinned TODO card — the first "note" on the page ──
// Shows every open task in the current folder scope (folder + subfolders,
// labeled when they come from a subfolder), quick-add into the current
// folder's own lazily-created list, and other folders' open tasks dimmed
// in a collapsed drawer. At root, scope is everything.

async function renderTodoCard(wrap, folders, folderId, scope) {
  wrap.innerHTML = '';
  const [lists, allTasks] = await Promise.all([
    store.getAllTasklists(), store.getAllTasks(),
  ]);
  const listById = new Map(lists.map(l => [l.id, l]));
  const inScope = (l) => !scope || scope.has(l?.folderId || '');

  const active = allTasks.filter(t => !t.archivedAt);
  const here = active.filter(t => inScope(listById.get(t.listId)));
  const elsewhere = scope ? active.filter(t => !inScope(listById.get(t.listId))) : [];

  const order = (a, b) => (a.done !== b.done) ? (a.done ? 1 : -1) : a.order - b.order;
  here.sort(order);
  const openCount = here.filter(t => !t.done).length;
  const elsewhereOpen = elsewhere.filter(t => !t.done);

  const expanded = localStorage.getItem(TODO_OPEN_KEY) === '1';
  const card = el('div', 'mn-card mn-todocard');

  const folderName = folderId ? (folders.find(f => f.id === folderId)?.name || '') : '';
  const head = el('div', 'mn-todo-head');
  head.appendChild(el('span', 'mn-pin-dot', '&#9733;'));
  head.appendChild(el('span', 'mn-card-title', `todo${folderName ? ` · ${esc(folderName)}` : ''}`));
  head.appendChild(el('span', 'mn-todo-count', openCount ? `${openCount} open` : 'clear'));
  head.appendChild(el('span', 'mn-todo-chevron', expanded ? '&#9662;' : '&#9656;'));
  head.addEventListener('click', () => {
    localStorage.setItem(TODO_OPEN_KEY, expanded ? '0' : '1');
    renderTodoCard(wrap, folders, folderId, scope);
  });
  card.appendChild(head);

  if (expanded) {
    const redraw = () => renderTodoCard(wrap, folders, folderId, scope);
    const list = el('div', 'mn-todo-list');
    for (const t of here) {
      const ownFolder = listById.get(t.listId)?.folderId || '';
      const label = ownFolder && ownFolder !== folderId ? store.folderPath(folders, ownFolder) : '';
      list.appendChild(todoRow(t, redraw, label));
    }
    card.appendChild(list);

    const addRow = el('div', 'mn-todo-add');
    const input = el('input', 'mn-input');
    input.type = 'text';
    input.placeholder = folderName ? `add a task in ${folderName}…` : 'add a task…';
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const raw = input.value.trim();
      if (!raw) return;
      const { text, remindAt } = parseCapture(raw);
      const tl = await store.ensureFolderTasklist(folderId);
      const task = store.createTask(tl.id, text || raw, {
        remindAt, remindStatus: remindAt ? 'scheduled' : '',
      });
      await store.putTaskRaw(task);
      if (remindAt) await armReminder(task); // Enter is the permission gesture
      redraw();
    });
    addRow.appendChild(input);
    card.appendChild(addRow);

    if (elsewhereOpen.length) {
      const drawer = el('details', 'mn-archive mn-elsewhere-tasks');
      drawer.appendChild(el('summary', '', `other folders (${elsewhereOpen.length} open)`));
      elsewhereOpen.sort(order);
      for (const t of elsewhereOpen) {
        const ownFolder = listById.get(t.listId)?.folderId || '';
        drawer.appendChild(todoRow(t, redraw, ownFolder ? store.folderPath(folders, ownFolder) : '', true));
      }
      card.appendChild(drawer);
    }

    const foot = el('div', 'mn-todo-foot');
    foot.appendChild(btn('all lists &rarr;', 'mn-btn-ghost', () => navigate('#tasks')));
    card.appendChild(foot);
  }

  wrap.appendChild(card);
}

function todoRow(task, redraw, folderLabel = '', dimmed = false) {
  const row = el('div', `mn-todo-row ${dimmed ? 'mn-dimcard' : ''}`);
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = task.done;
  cb.addEventListener('change', async () => {
    await setTaskDoneEverywhere(task, cb.checked);
    redraw();
  });
  row.appendChild(cb);
  row.appendChild(el('span', `mn-task-text ${task.done ? 'mn-struck' : ''}`, esc(task.text)));
  if (folderLabel) row.appendChild(el('span', 'mn-minifolder', `&#128193; ${esc(folderLabel)}`));
  const badge = reminderBadge(task);
  if (badge) row.appendChild(badge);
  const bell = btn(task.remindAt || task.remindPlace ? '&#128276;' : '&#128368;',
    'mn-btn-ghost mn-task-bell', (e) => { e.stopPropagation(); reminderSheet(task, redraw); });
  bell.title = 'set a reminder';
  row.appendChild(bell);
  if (task.sourceNoteId) {
    const link = btn('&#8599;', 'mn-btn-ghost mn-task-notelink', (e) => {
      e.stopPropagation();
      navigate(`#note/${task.sourceNoteId}`);
    });
    row.appendChild(link);
  }
  return row;
}
