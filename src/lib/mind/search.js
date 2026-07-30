// Search over notes + tasks — in-memory, rebuilt on demand and cached until
// the next store write. Token AND-match over title/body/OCR/transcript/tags,
// plus structured filters. The query(q, filters) surface is deliberately
// index-agnostic so a real inverted index can replace the linear scan later.

import * as store from './store.js';
import { markdownToText } from './editor/markdown.js';

let _index = null;

export function invalidateIndex() { _index = null; }

async function buildIndex() {
  const [notes, tasks, attachments, tasklists] = await Promise.all([
    store.getAllNotes(), store.getAllTasks(), store.getAllAttachments(), store.getAllTasklists(),
  ]);
  const listFolder = new Map(tasklists.map(l => [l.id, l.folderId || '']));

  const attsByNote = new Map();
  const attsByTask = new Map();
  for (const a of attachments) {
    // An attachment belongs to a note or (a TODO screenshot) to a task.
    const [map, key] = a.taskId ? [attsByTask, a.taskId] : [attsByNote, a.noteId];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }

  const entries = notes.map((n) => {
    const atts = attsByNote.get(n.id) || [];
    const ocrText = atts.map(a => a.ocrText).filter(Boolean).join('\n');
    const transcript = atts.map(a => a.transcript).filter(Boolean).join('\n');
    return {
      type: 'note',
      id: n.id,
      note: n,
      folderId: n.folderId || '',
      title: n.title,
      bodyText: markdownToText(n.body),
      ocrText,
      transcript,
      tags: n.tags || [],
      kinds: [...new Set(atts.map(a => a.kind))],
      hasAttachment: atts.length > 0,
      pinned: !!n.pinned,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      haystack: [
        n.title, markdownToText(n.body), ocrText, transcript, (n.tags || []).join(' '),
      ].join('\n').toLowerCase(),
    };
  });

  for (const t of tasks) {
    // A screenshot on a TODO item is searchable by its recognized text, the
    // same as one in a note.
    const atts = attsByTask.get(t.id) || [];
    const ocrText = atts.map(a => a.ocrText).filter(Boolean).join('\n');
    entries.push({
      type: 'task',
      id: t.id,
      task: t,
      folderId: listFolder.get(t.listId) || '',
      title: t.text,
      ocrText,
      tags: [],
      kinds: [...new Set(atts.map(a => a.kind))],
      hasAttachment: atts.length > 0,
      pinned: false,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      haystack: [t.text, ocrText].join('\n').toLowerCase(),
    });
  }
  return entries;
}

async function getIndex() {
  if (!_index) _index = await buildIndex();
  return _index;
}

// filters: { type: 'note'|'task'|null, kind: 'image'|'audio'|..., tag,
//            hasAttachment, after, before }
export async function query(q = '', filters = {}) {
  const entries = await getIndex();
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);

  return entries.filter((e) => {
    if (filters.type && e.type !== filters.type) return false;
    if (filters.kind && !e.kinds.includes(filters.kind)) return false;
    if (filters.tag && !e.tags.includes(filters.tag)) return false;
    if (filters.hasAttachment && !e.hasAttachment) return false;
    if (filters.after && e.updatedAt < filters.after) return false;
    if (filters.before && e.updatedAt > filters.before) return false;
    return tokens.every((t) => e.haystack.includes(t));
  });
}

export async function allTags() {
  const notes = await store.getAllNotes();
  const tags = new Set();
  for (const n of notes) for (const t of n.tags || []) tags.add(t);
  return [...tags].sort();
}
