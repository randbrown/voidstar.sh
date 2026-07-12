// Tasks-in-notes materialization. The note BODY is canonical for
// note-sourced tasks; task records are a searchable/checkable index of it.
//
//   - Every task_item in a note serializes with a stable id marker
//     (`- [ ] buy milk <!--t:ab12cd-->`). The editor assigns missing ids
//     right before save (ensureTaskIds), so the same checkbox keeps its
//     identity across devices and edits.
//   - On note save, syncNoteTasks() reconciles task records with
//     sourceNoteId === note.id against the body: create / update / trash.
//   - Checking a note-sourced task from a task-list view goes the OTHER way:
//     setTaskDoneEverywhere() rewrites the checkbox line in the body (single
//     writer path — no divergence), then updates the record.

import * as store from './store.js';
import { schema } from './editor/schema.js';

export function newTaskMarkerId() {
  // 8 chars base36 — plenty within one account's notes.
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => (b % 36).toString(36)).join('').slice(0, 8);
}

// Walk the editor doc and give every task_item a stable id before
// serializing. Dispatches one no-history transaction when needed.
//
// A copy/pasted checkbox carries its source's id — duplicated within this doc
// (`seen`) or pasted in from another note (`foreignIds`, ids whose record
// belongs to a different sourceNoteId). Either way the repeat gets a fresh id;
// without this, two lines share one record and every save flips its
// sourceNoteId/listId back and forth, destroying reminder fields.
export function ensureTaskIds(view, foreignIds = null) {
  const { doc, tr } = view.state;
  let changed = false;
  const seen = new Set();
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.task_item) return;
    let id = node.attrs.taskId;
    if (!id || seen.has(id) || (foreignIds && foreignIds.has(id))) {
      id = newTaskMarkerId();
      tr.setNodeMarkup(pos, null, { ...node.attrs, taskId: id });
      changed = true;
    }
    seen.add(id);
  });
  if (changed) {
    tr.setMeta('addToHistory', false);
    view.dispatch(tr);
  }
}

const TASK_LINE_RE = /^(\s*[-*+]\s+)\[([ xX])\]\s+(.*?)\s*<!--t:([A-Za-z0-9_-]+)-->\s*$/;

// Parse body → [{taskId, text, checked}] for marked task lines. Unmarked
// checkboxes (hand-written markdown from an import) are left alone until the
// editor touches the note and stamps them.
export function parseNoteTasks(body) {
  const items = [];
  for (const line of (body || '').split('\n')) {
    const m = TASK_LINE_RE.exec(line);
    if (m) items.push({ taskId: m[4], text: m[3].trim(), checked: m[2].toLowerCase() === 'x' });
  }
  return items;
}

// Reconcile task records against the note body. Note-sourced tasks use the
// marker as their record id, so two devices materializing the same body
// converge on the same records instead of forking.
//
// Reminder fields (remindAt/remindPlace/…) live on the record only — the note
// markdown carries just `- [ ] text <!--t:id-->`, so a reminder does NOT
// round-trip through the body. The update path below spreads `...rec`, so a
// re-parse of the body preserves any reminder already set on the record; only a
// checkbox that was removed from the note trashes its record.
export async function syncNoteTasks(note) {
  const items = parseNoteTasks(note.body);
  const byId = new Map(items.map(i => [i.taskId, i]));
  const existing = await store.getTasksForNote(note.id);
  if (!items.length && !existing.length) return; // no lazy list creation for task-less notes

  const listId = items.length ? (await store.ensureFolderTasklist(note.folderId || '')).id : '';

  for (const item of items) {
    const rec = existing.find(t => t.id === item.taskId);
    if (!rec) {
      await store.putTaskRaw(store.createTask(listId, item.text, {
        id: item.taskId,
        sourceNoteId: note.id,
        done: item.checked,
        completedAt: item.checked ? Date.now() : 0,
      }));
    } else if (rec.text !== item.text || rec.done !== item.checked) {
      await store.putTask({
        ...rec,
        text: item.text,
        done: item.checked,
        completedAt: item.checked ? (rec.completedAt || Date.now()) : 0,
        archivedAt: item.checked ? rec.archivedAt : 0,
      });
    }
  }

  // Checkbox removed from the note → its record goes too.
  for (const rec of existing) {
    if (!byId.has(rec.id)) await store.trashTask(rec);
  }
}

// Toggle a task wherever it lives. For note-sourced tasks the body is
// rewritten first (canonical side), then the record follows.
export async function setTaskDoneEverywhere(task, done) {
  if (task.sourceNoteId) {
    const note = await store.getNote(task.sourceNoteId);
    if (note && !note.deletedAt) {
      const lines = (note.body || '').split('\n');
      let hit = false;
      const marker = `<!--t:${task.id}-->`;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(marker)) continue;
        lines[i] = lines[i].replace(/\[([ xX])\]/, done ? '[x]' : '[ ]');
        hit = true;
        break;
      }
      if (hit) await store.putNote({ ...note, body: lines.join('\n') });
    }
  }
  await store.setTaskDone(task, done);
}

// Edit a task's text wherever it lives — same single-writer rule as the done
// toggle: for note-sourced tasks the body line is rewritten FIRST (the body
// is canonical, so a record-only edit would silently revert on the note's
// next open/save re-parse), then the record follows.
export async function setTaskTextEverywhere(task, text) {
  if (task.sourceNoteId) {
    const note = await store.getNote(task.sourceNoteId);
    if (note && !note.deletedAt) {
      const lines = (note.body || '').split('\n');
      const marker = `<!--t:${task.id}-->`;
      let hit = false;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(marker)) continue;
        const m = /^(\s*[-*+]\s+\[[ xX]\]\s+).*?(\s*<!--t:[A-Za-z0-9_-]+-->\s*)$/.exec(lines[i]);
        if (m) { lines[i] = m[1] + text + m[2]; hit = true; }
        break;
      }
      if (hit) await store.putNote({ ...note, body: lines.join('\n') });
    }
  }
  await store.putTask({ ...task, text });
}

// Notes that link to `noteId` via markdown links (#note/<id>) — the
// backlinks panel. Cheap linear scan; fine at thousands of notes.
export async function backlinksTo(noteId) {
  const notes = await store.getAllNotes();
  const needle = `#note/${noteId}`;
  return notes.filter(n => n.id !== noteId && (n.body || '').includes(needle));
}
