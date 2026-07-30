// Tasks view — every task list, checkable, with the 24h struck-through
// window and an archive drawer per list.

import * as store from '../store.js';
import { setTaskDoneEverywhere, setTaskTextEverywhere } from '../tasks-sync.js';
import { navigate, refresh } from '../app.js';
import { taskAddRow } from './task-add.js';
import {
  taskAttachButton, taskThumbs, groupTaskAttachments, wirePasteOnRow, wireDropOnRow,
} from './task-attach.js';
import { reminderSheet, reminderBadge, isReminderDue, snoozeTask } from '../reminders.js';
import { el, esc, btn, topBar, emptyState, textPrompt, confirmBox, timeAgo } from '../ui.js';

// Set by a quick-add so the re-render puts the cursor back in the same box —
// refresh() rebuilds the whole view, and typing a burst of tasks shouldn't need
// a click between each one.
let _refocusList = '';

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

  const [tasks, allAtts] = await Promise.all([store.getAllTasks(), store.getAllAttachments()]);
  const byList = new Map();
  for (const t of tasks) {
    if (!byList.has(t.listId)) byList.set(t.listId, []);
    byList.get(t.listId).push(t);
  }
  const attsByTask = groupTaskAttachments(allAtts);

  const refocus = _refocusList;
  _refocusList = '';
  for (const tl of lists) {
    if (focusListId && tl.id !== focusListId) continue;
    const { card, focusAdd } = await listCard(tl, byList.get(tl.id) || [], folders, attsByTask);
    root.appendChild(card);
    if (refocus === tl.id) focusAdd();
  }
}

async function listCard(tl, tasks, folders, attsByTask) {
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
  for (const t of active) list.appendChild(await taskRow(t, attsByTask.get(t.id) || []));
  card.appendChild(list);

  const add = taskAddRow({
    ensureList: async () => tl,
    onAdded: () => { _refocusList = tl.id; refresh(); },
  });
  card.appendChild(add.el);

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

  return { card, focusAdd: add.focus };
}

async function taskRow(task, atts = []) {
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
        // Note-sourced tasks rewrite the canonical body line too — a
        // record-only edit reverts on the note's next open/save re-parse.
        await setTaskTextEverywhere(task, v);
        refresh();
      },
    });
  });
  row.appendChild(text);

  const badge = reminderBadge(task);
  if (badge) row.appendChild(badge);

  // Quick-snooze — one tap to defer a due/overdue reminder by 10 min, without
  // opening the reminder sheet. Only shown when the reminder is actually due.
  if (isReminderDue(task)) {
    const snooze = btn('&#128564; 10m', 'mn-btn-ghost mn-task-snooze', async () => {
      await snoozeTask(task);
      refresh();
    });
    snooze.title = 'snooze 10 minutes';
    row.appendChild(snooze);
  }

  row.appendChild(taskAttachButton(task, refresh));
  wirePasteOnRow(row, task, refresh);
  wireDropOnRow(row, task, refresh);

  const bell = btn(task.remindAt || task.remindPlace ? '&#128276;' : '&#128368;',
    'mn-btn-ghost mn-task-bell', () => reminderSheet(task, refresh));
  bell.title = 'set a reminder';
  row.appendChild(bell);

  if (task.sourceNoteId) {
    const link = btn('&#8599;', 'mn-btn-ghost mn-task-notelink', () => navigate(`#note/${task.sourceNoteId}`));
    link.title = 'open source note';
    row.appendChild(link);
  } else if (task.sourceUrl) {
    // External task (e.g. setlist todo bridge) — cross-page, so a real
    // location change rather than navigate()'s in-app hash routing.
    const link = btn('&#8599;', 'mn-btn-ghost mn-task-notelink', () => { location.href = task.sourceUrl; });
    link.title = 'open in setlist';
    row.appendChild(link);
  }

  const del = btn('&times;', 'mn-btn-ghost mn-task-x', async () => {
    // Takes the task's screenshots with it — nothing else renders them.
    await store.trashTaskAndAttachments(task);
    refresh();
  });
  row.appendChild(del);

  const thumbs = await taskThumbs(task, atts, refresh);
  if (thumbs) row.appendChild(thumbs);
  return row;
}
