// Home — the main page: new note first, folder bar, pinned TODO card,
// recent notes with sort / filter / search all inline.
//
// Folders are a SOFT filter: the current folder's content renders normally,
// everything else stays visible but dimmed in an "elsewhere" section —
// you never lose sight of the rest of the brain.

import * as store from '../store.js';
import { query, allTags } from '../search.js';
import { markdownToText } from '../editor/markdown.js';
import { navigate, refresh } from '../app.js';
import { el, esc, btn, emptyState, timeAgo, textPrompt, confirmBox } from '../ui.js';

const SORT_KEY = 'voidstar.mind.sort';
const TODO_OPEN_KEY = 'voidstar.mind.todoExpanded';
const FOLDER_KEY = 'voidstar.mind.folder';

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

  const head = el('div', 'mn-apphead');
  head.appendChild(el('span', 'mn-wordmark', 'mind'));
  const actions = el('div', 'mn-head-actions');
  actions.appendChild(btn('+ note', 'mn-btn-primary mn-btn-new', async () => {
    const note = store.createNote({ folderId, title: await store.uniqueAutoTitle() });
    await store.putNoteRaw(note);
    navigate(`#note/${note.id}`);
  }));
  actions.appendChild(btn('tasks', '', () => navigate('#tasks')));
  actions.appendChild(btn('&#9881;', 'mn-btn-icon', () => navigate('#settings')));
  head.appendChild(actions);
  root.appendChild(head);

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

  // Filter chips: attachment kinds + tags.
  const chips = el('div', 'mn-chips');
  const kindChips = [['', 'all'], ['image', 'images'], ['audio', 'audio'], ['pdf', 'pdfs']];
  const tags = await allTags();
  const drawChips = () => {
    chips.innerHTML = '';
    for (const [kind, label] of kindChips) {
      const c = btn(label, `mn-chip ${(!_filter.tag && _filter.kind === kind) ? 'mn-chip-on' : ''}`, () => {
        _filter = { kind, tag: '' };
        drawChips(); renderList();
      });
      chips.appendChild(c);
    }
    for (const t of tags) {
      const c = btn(`#${esc(t)}`, `mn-chip ${_filter.tag === t ? 'mn-chip-on' : ''}`, () => {
        _filter = _filter.tag === t ? { kind: '', tag: '' } : { kind: '', tag: t };
        drawChips(); renderList();
      });
      chips.appendChild(c);
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

function noteCard(entry, folders, dimmed) {
  const n = entry.note;
  const card = el('div', `mn-card mn-notecard ${dimmed ? 'mn-dimcard' : ''}`);
  card.addEventListener('click', () => navigate(`#note/${n.id}`));

  const row = el('div', 'mn-card-titlerow');
  if (n.pinned) row.appendChild(el('span', 'mn-pin-dot', '&#9733;'));
  if (n.conflictOf) row.appendChild(el('span', 'mn-conflict-badge', 'conflict'));
  row.appendChild(el('span', 'mn-card-title', esc(n.title)));
  row.appendChild(el('span', 'mn-card-time', timeAgo(n.updatedAt)));
  card.appendChild(row);

  const body = markdownToText(n.body);
  const snippet = body.split('\n').filter(l => l.trim() && l.trim() !== n.title.trim()).join(' · ').slice(0, 160);
  if (snippet) card.appendChild(el('div', 'mn-card-snippet', esc(snippet)));

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
  const row = el('div', `mn-card mn-taskhit ${dimmed ? 'mn-dimcard' : ''}`);
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = task.done;
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', async () => {
    await store.setTaskDone(task, cb.checked);
    refresh();
  });
  row.appendChild(cb);
  row.appendChild(el('span', `mn-task-text ${task.done ? 'mn-struck' : ''}`, esc(task.text)));
  row.addEventListener('click', () => {
    navigate(task.sourceNoteId ? `#note/${task.sourceNoteId}` : `#tasks/${task.listId}`);
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
  head.appendChild(el('span', 'mn-card-title', `TODO${folderName ? ` · ${esc(folderName)}` : ''}`));
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
      const text = input.value.trim();
      if (!text) return;
      const tl = await store.ensureFolderTasklist(folderId);
      await store.putTaskRaw(store.createTask(tl.id, text));
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
    await store.setTaskDone(task, cb.checked);
    redraw();
  });
  row.appendChild(cb);
  row.appendChild(el('span', `mn-task-text ${task.done ? 'mn-struck' : ''}`, esc(task.text)));
  if (folderLabel) row.appendChild(el('span', 'mn-minifolder', `&#128193; ${esc(folderLabel)}`));
  if (task.sourceNoteId) {
    const link = btn('&#8599;', 'mn-btn-ghost mn-task-notelink', (e) => {
      e.stopPropagation();
      navigate(`#note/${task.sourceNoteId}`);
    });
    row.appendChild(link);
  }
  return row;
}
