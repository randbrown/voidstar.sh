// Tasks view — every task list, checkable, with the 24h struck-through
// window and an archive drawer per list.

import * as store from '../store.js';
import { setTaskDoneEverywhere } from '../tasks-sync.js';
import { navigate, refresh } from '../app.js';
import { el, esc, btn, topBar, emptyState, textPrompt, confirmBox, timeAgo } from '../ui.js';

export async function renderTasks(root, focusListId = null) {
  const actions = [
    btn('+ list', '', () => {
      textPrompt({
        title: 'new task list', placeholder: 'list name',
        onOk: async (name) => {
          if (!name) return;
          await store.putTasklistRaw(store.createTasklist(name));
          refresh();
        },
      });
    }),
  ];
  root.appendChild(topBar('tasks', '#home', actions));

  const folders = await store.getAllFolders();
  const lists = await store.getAllTasklists();
  lists.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || a.order - b.order);

  if (!lists.length) {
    root.appendChild(emptyState('no task lists.'));
    return;
  }

  const tasks = await store.getAllTasks();
  const byList = new Map();
  for (const t of tasks) {
    if (!byList.has(t.listId)) byList.set(t.listId, []);
    byList.get(t.listId).push(t);
  }

  for (const tl of lists) {
    if (focusListId && tl.id !== focusListId) continue;
    root.appendChild(await listCard(tl, byList.get(tl.id) || [], folders));
  }
}

async function listCard(tl, tasks, folders) {
  const card = el('div', 'mn-card mn-tasklist-card');

  const head = el('div', 'mn-todo-head');
  const path = tl.folderId ? store.folderPath(folders, tl.folderId) : '';
  head.appendChild(el('span', 'mn-card-title',
    `${esc(tl.name)}${path ? ` <span class="mn-minifolder">&#128193; ${esc(path)}</span>` : ''}`));
  const open = tasks.filter(t => !t.done && !t.archivedAt).length;
  head.appendChild(el('span', 'mn-todo-count', open ? `${open} open` : 'clear'));
  if (!tl.isDefault) {
    const del = btn('&#128465;', 'mn-btn-icon mn-btn-danger', () => {
      confirmBox(`Delete list "${tl.name}" and its tasks?`, async () => {
        for (const t of tasks) await store.trashTask(t);
        await store.trashTasklist(tl);
        refresh();
      });
    });
    head.appendChild(del);
  }
  card.appendChild(head);

  const active = tasks.filter(t => !t.archivedAt);
  active.sort((a, b) => (a.done !== b.done) ? (a.done ? 1 : -1) : a.order - b.order);

  const list = el('div', 'mn-todo-list');
  for (const t of active) list.appendChild(taskRow(t));
  card.appendChild(list);

  const addRow = el('div', 'mn-todo-add');
  const input = el('input', 'mn-input');
  input.type = 'text';
  input.placeholder = 'add a task…';
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = input.value.trim();
    if (!text) return;
    await store.putTaskRaw(store.createTask(tl.id, text));
    refresh();
  });
  addRow.appendChild(input);
  card.appendChild(addRow);

  // Archive drawer — tasks that rolled off the 24h window.
  const archived = tasks.filter(t => t.archivedAt);
  if (archived.length) {
    const drawer = el('details', 'mn-archive');
    drawer.appendChild(el('summary', '', `archive (${archived.length})`));
    archived.sort((a, b) => b.completedAt - a.completedAt);
    for (const t of archived) {
      const row = el('div', 'mn-todo-row mn-archived-row');
      row.appendChild(el('span', 'mn-task-text mn-struck', esc(t.text)));
      row.appendChild(el('span', 'mn-dim', timeAgo(t.completedAt)));
      const un = btn('restore', 'mn-btn-ghost', async () => {
        await store.putTask({ ...t, done: false, completedAt: 0, archivedAt: 0 });
        refresh();
      });
      row.appendChild(un);
      drawer.appendChild(row);
    }
    card.appendChild(drawer);
  }

  return card;
}

function taskRow(task) {
  const row = el('div', 'mn-todo-row');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = task.done;
  cb.addEventListener('change', async () => {
    await setTaskDoneEverywhere(task, cb.checked);
    refresh();
  });
  row.appendChild(cb);

  const text = el('span', `mn-task-text ${task.done ? 'mn-struck' : ''}`, esc(task.text));
  text.addEventListener('click', () => {
    textPrompt({
      title: 'edit task', value: task.text,
      onOk: async (v) => {
        if (!v) return;
        await store.putTask({ ...task, text: v });
        refresh();
      },
    });
  });
  row.appendChild(text);

  if (task.sourceNoteId) {
    const link = btn('&#8599;', 'mn-btn-ghost mn-task-notelink', () => navigate(`#note/${task.sourceNoteId}`));
    link.title = 'open source note';
    row.appendChild(link);
  }

  const del = btn('&times;', 'mn-btn-ghost mn-task-x', async () => {
    await store.trashTask(task);
    refresh();
  });
  row.appendChild(del);
  return row;
}
