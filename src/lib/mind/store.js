// IndexedDB store for mind — notes, tasks, tasklists, attachments, blobs,
// annotations, snapshots. Forked from setlist/store.js (lazy singleton,
// tx() helper, setOnWrite hook, merge-aware import, rolling snapshots).
//
// Sync model differences from setlist:
//   - Soft delete everywhere. Notes/tasks/attachments get a `deletedAt`
//     tombstone instead of a hard delete, because deletion is a routine
//     action here and must propagate across devices via the Drive JSON.
//     Tombstones older than TRASH_TTL_MS are purged for real.
//   - The BLOBS store (attachment binaries) is local-only and silent: the
//     binaries sync separately as individual Drive files (attachments-drive),
//     never inside the JSON payload.

const DB_NAME = 'voidstar.mind';
const DB_VERSION = 2;
const NOTES = 'notes';
const FOLDERS = 'folders';
const TASKS = 'tasks';
const TASKLISTS = 'tasklists';
const ATTACHMENTS = 'attachments';
const BLOBS = 'blobs';
const ANNOTATIONS = 'annotations';
const SNAPSHOTS = 'snapshots';

// Tombstoned records vanish from the trash (and the sync payload) after this.
export const TRASH_TTL_MS = 30 * 24 * 3600_000;
// Completed tasks stay struck-through on the list this long, then archive.
export const TASK_ARCHIVE_MS = 24 * 3600_000;

let _dbPromise = null;

export function isAvailable() {
  try { return typeof indexedDB !== 'undefined'; } catch { return false; }
}

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NOTES)) {
        const n = db.createObjectStore(NOTES, { keyPath: 'id' });
        n.createIndex('by-updatedAt', 'updatedAt', { unique: false });
        n.createIndex('by-createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(TASKS)) {
        const t = db.createObjectStore(TASKS, { keyPath: 'id' });
        t.createIndex('by-list', 'listId', { unique: false });
        t.createIndex('by-note', 'sourceNoteId', { unique: false });
        t.createIndex('by-updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(TASKLISTS)) {
        db.createObjectStore(TASKLISTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FOLDERS)) {
        db.createObjectStore(FOLDERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(ATTACHMENTS)) {
        const a = db.createObjectStore(ATTACHMENTS, { keyPath: 'id' });
        a.createIndex('by-note', 'noteId', { unique: false });
        a.createIndex('by-ocrStatus', 'ocrStatus', { unique: false });
      }
      if (!db.objectStoreNames.contains(BLOBS)) {
        db.createObjectStore(BLOBS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(ANNOTATIONS)) {
        db.createObjectStore(ANNOTATIONS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        db.createObjectStore(SNAPSHOTS, { keyPath: 'ts' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function tx(storeName, mode) {
  const db = await openDb();
  const t = db.transaction(storeName, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onabort = t.onerror = () => rej(t.error);
  });
  return { store: t.objectStore(storeName), done };
}

async function getAll(storeName) {
  const { store, done } = await tx(storeName, 'readonly');
  const all = await new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
  await done.catch(() => {});
  return all;
}

async function getOne(storeName, id) {
  const { store, done } = await tx(storeName, 'readonly');
  const rec = await new Promise((res, rej) => {
    const req = store.get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
  await done.catch(() => {});
  return rec;
}

async function getByIndex(storeName, indexName, value) {
  const { store, done } = await tx(storeName, 'readonly');
  const idx = store.index(indexName);
  const recs = await new Promise((res, rej) => {
    const req = idx.getAll(value);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
  await done.catch(() => {});
  return recs;
}

let _onWrite = null;
export function setOnWrite(fn) { _onWrite = fn; }

async function put(storeName, record) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.put(record);
  await done;
  _onWrite?.();
}

async function del(storeName, id) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.delete(id);
  await done;
  _onWrite?.();
}

// Silent variants — write without firing _onWrite (local-only stores: blob
// cache and snapshots must never schedule a Drive push).
async function putSilent(storeName, record) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.put(record);
  await done;
}

async function delSilent(storeName, id) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.delete(id);
  await done;
}

async function clearStore(storeName) {
  const { store, done } = await tx(storeName, 'readwrite');
  store.clear();
  await done;
}

async function getAllKeys(storeName) {
  const { store, done } = await tx(storeName, 'readonly');
  const keys = await new Promise((res, rej) => {
    const req = store.getAllKeys();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
  await done.catch(() => {});
  return keys;
}

const live = (recs) => recs.filter(r => !r.deletedAt);

// ── Notes ──

// Default title: sortable ISO-style local date+time ("2026-07-08 14:32") —
// lexicographic sort IS chronological sort. Marked autoTitle so a later
// rename can offer the first body line instead. Seconds only on demand
// (uniqueAutoTitle adds them when two notes land in the same minute).
export function autoTitleNow(ts = Date.now(), withSeconds = false) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base;
}

export async function uniqueAutoTitle(ts = Date.now()) {
  const t = autoTitleNow(ts);
  const all = await getAllNotes();
  return all.some(n => n.title === t) ? autoTitleNow(ts, true) : t;
}

// Compact sortable stamp for generated filenames (screenshots, recordings):
// "20260708-143207" — no spaces/colons, safe in any filesystem.
export function fileStamp(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createNote(partial = {}) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: autoTitleNow(now),
    autoTitle: true,
    body: '',
    folderId: '',
    tags: [],
    pinned: false,
    conflictOf: '',
    sourceDevice: '',
    meta: {},
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    clearedFields: {},
    ...partial,
  };
}

export const putNote = (note) => put(NOTES, { ...note, updatedAt: Date.now() });
// Preserve updatedAt — for merge/import paths where the record's own clock is
// authoritative (bumping it would make every sync look like a fresh edit).
export const putNoteRaw = (note) => put(NOTES, note);
export const getNote = (id) => getOne(NOTES, id);
export const getAllNotesRaw = () => getAll(NOTES);
export const getAllNotes = async () => live(await getAll(NOTES));
export const trashNote = (note) => put(NOTES, { ...note, deletedAt: Date.now(), updatedAt: Date.now() });
export const restoreNote = (note) => put(NOTES, { ...note, deletedAt: 0, updatedAt: Date.now() });
export const purgeNote = (id) => del(NOTES, id);

// ── Folders ──
// Hierarchical, surrogate-keyed: notes/tasklists reference folder ids, so a
// rename touches one record and no links. parentId '' = root.

export function createFolder(name, parentId = '', partial = {}) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    parentId,
    order: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    ...partial,
  };
}

export const putFolder = (f) => put(FOLDERS, { ...f, updatedAt: Date.now() });
export const putFolderRaw = (f) => put(FOLDERS, f);
export const getFolder = (id) => getOne(FOLDERS, id);
export const getAllFoldersRaw = () => getAll(FOLDERS);
export const getAllFolders = async () => live(await getAll(FOLDERS));

// Delete a folder: children/notes/tasklists move to its parent (never lost).
export async function deleteFolderAndReparent(folder) {
  const [folders, notes, lists] = await Promise.all([
    getAllFolders(), getAllNotes(), getAllTasklists(),
  ]);
  for (const f of folders) {
    if (f.parentId === folder.id) await putFolder({ ...f, parentId: folder.parentId });
  }
  for (const n of notes) {
    if (n.folderId === folder.id) await putNote({ ...n, folderId: folder.parentId });
  }
  for (const l of lists) {
    if (l.folderId === folder.id) await putTasklist({ ...l, folderId: folder.parentId });
  }
  await put(FOLDERS, { ...folder, deletedAt: Date.now(), updatedAt: Date.now() });
}

// "work / AirVision" breadcrumb path for a folder id.
export function folderPath(folders, id) {
  const byId = new Map(folders.map(f => [f.id, f]));
  const parts = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.name);
    cur = byId.get(cur.parentId);
  }
  return parts.join(' / ');
}

// id plus every descendant id — the "this folder" scope for soft filtering.
export function folderScope(folders, id) {
  const scope = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (scope.has(f.parentId) && !scope.has(f.id)) { scope.add(f.id); grew = true; }
    }
  }
  return scope;
}

// ── Tasks ──

export function createTask(listId, text, partial = {}) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    listId,
    text,
    done: false,
    completedAt: 0,
    archivedAt: 0,
    sourceNoteId: '',
    order: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    ...partial,
  };
}

export const putTask = (task) => put(TASKS, { ...task, updatedAt: Date.now() });
export const putTaskRaw = (task) => put(TASKS, task);
export const getTask = (id) => getOne(TASKS, id);
export const getAllTasksRaw = () => getAll(TASKS);
export const getAllTasks = async () => live(await getAll(TASKS));
export const getTasksForList = async (listId) => live(await getByIndex(TASKS, 'by-list', listId));
export const getTasksForNote = async (noteId) => live(await getByIndex(TASKS, 'by-note', noteId));
export const trashTask = (task) => put(TASKS, { ...task, deletedAt: Date.now(), updatedAt: Date.now() });
export const purgeTask = (id) => del(TASKS, id);

export function setTaskDone(task, done) {
  return putTask({ ...task, done, completedAt: done ? Date.now() : 0, archivedAt: 0 });
}

// Archive done tasks past the 24h strike-through window. Called on app init
// and hourly; returns how many rolled off so callers can re-render.
export async function rollOffCompletedTasks() {
  const tasks = await getAllTasks();
  const cutoff = Date.now() - TASK_ARCHIVE_MS;
  let n = 0;
  for (const t of tasks) {
    if (t.done && !t.archivedAt && t.completedAt && t.completedAt < cutoff) {
      await putTask({ ...t, archivedAt: Date.now() });
      n++;
    }
  }
  return n;
}

// ── Task lists ──

export function createTasklist(name, partial = {}) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    folderId: '',
    order: now,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    ...partial,
  };
}

export const putTasklist = (tl) => put(TASKLISTS, { ...tl, updatedAt: Date.now() });
export const putTasklistRaw = (tl) => put(TASKLISTS, tl);
export const getTasklist = (id) => getOne(TASKLISTS, id);
export const getAllTasklistsRaw = () => getAll(TASKLISTS);
export const getAllTasklists = async () => live(await getAll(TASKLISTS));
export const trashTasklist = (tl) => put(TASKLISTS, { ...tl, deletedAt: Date.now(), updatedAt: Date.now() });

// The pinned TODO list — created on first run, stable id so every device's
// first-run default merges into ONE list instead of forking per device.
export const DEFAULT_TASKLIST_ID = 'default-todo';

export async function ensureDefaultTasklist() {
  const existing = await getTasklist(DEFAULT_TASKLIST_ID);
  if (existing) return existing;
  const tl = createTasklist('todo', { id: DEFAULT_TASKLIST_ID, isDefault: true });
  await putTasklistRaw(tl);
  return tl;
}

// Per-folder TODO list, created lazily on first use. Deterministic id
// (`todo-<folderId>`) so two devices lazily creating "the work TODO" merge
// into ONE list instead of forking. Root ('') maps to the global default.
export async function ensureFolderTasklist(folderId) {
  if (!folderId) return ensureDefaultTasklist();
  const id = `todo-${folderId}`;
  const existing = await getTasklist(id);
  if (existing && !existing.deletedAt) return existing;
  const tl = createTasklist('todo', { id, folderId, isDefault: true });
  await putTasklistRaw(tl);
  return tl;
}

// ── Attachments (metadata; binaries live in BLOBS / on Drive) ──

export function createAttachment(noteId, { kind, name, mimeType, size }, partial = {}) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    noteId,
    kind, // 'image' | 'audio' | 'pdf' | 'file'
    name: name || '',
    mimeType: mimeType || '',
    size: size || 0,
    width: 0,
    height: 0,
    durationSec: 0,
    ocrText: '',
    // Images AND pdfs queue for text extraction (pdfs try their real text
    // layer first, then OCR — see ocr.js).
    ocrStatus: (kind === 'image' || kind === 'pdf') ? 'pending' : 'skipped',
    transcript: '',
    transcriptSource: '',
    driveFileId: '',
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    ...partial,
  };
}

export const putAttachment = (att) => put(ATTACHMENTS, { ...att, updatedAt: Date.now() });
export const putAttachmentRaw = (att) => put(ATTACHMENTS, att);
// Metadata enrichment (OCR result, transcript, drive id). Bumps updatedAt so
// the enriched copy deterministically wins the cross-device merge — and the
// ATTACHMENT_FILL_FIELDS below make sure a plain-newer copy without the
// enrichment can never blank it back out.
export const patchAttachment = (att, patch) => put(ATTACHMENTS, { ...att, ...patch, updatedAt: Date.now() });
export const getAttachment = (id) => getOne(ATTACHMENTS, id);
export const getAllAttachmentsRaw = () => getAll(ATTACHMENTS);
export const getAllAttachments = async () => live(await getAll(ATTACHMENTS));
export const getAttachmentsForNote = async (noteId) => live(await getByIndex(ATTACHMENTS, 'by-note', noteId));
export const getPendingOcrAttachments = async () => live(await getByIndex(ATTACHMENTS, 'by-ocrStatus', 'pending'));
export const trashAttachment = (att) => put(ATTACHMENTS, { ...att, deletedAt: Date.now(), updatedAt: Date.now() });
export const purgeAttachment = (id) => del(ATTACHMENTS, id);

// ── Attachment blobs (local-only, silent) ──

export const putBlob = (id, blob) => putSilent(BLOBS, { id, blob, size: blob.size || 0, storedAt: Date.now() });
export const getBlobRec = (id) => getOne(BLOBS, id);
export async function getBlob(id) {
  const rec = await getOne(BLOBS, id);
  return rec?.blob || null;
}
export const deleteBlob = (id) => delSilent(BLOBS, id);
export const getBlobIds = () => getAllKeys(BLOBS);

// ── Annotations (strokes over an attachment, keyed attachmentId[:page]) ──

export const annotationKey = (attachmentId, page = 0) =>
  page ? `${attachmentId}:${page}` : attachmentId;

export const putAnnotation = (ann) => put(ANNOTATIONS, { ...ann, updatedAt: Date.now() });
export const putAnnotationRaw = (ann) => put(ANNOTATIONS, ann);
export const getAnnotationByKey = (key) => getOne(ANNOTATIONS, key);
export const getAllAnnotations = () => getAll(ANNOTATIONS);
export const deleteAnnotation = (key) => del(ANNOTATIONS, key);

// ── Safety snapshots (undo a restore/sync) — setlist pattern verbatim ──

const SNAPSHOT_KEEP = 10;

export async function putSnapshot(label = '') {
  const ts = Date.now();
  await putSilent(SNAPSHOTS, { ts, label, data: await exportAll() });
  await pruneSnapshots(SNAPSHOT_KEEP);
  return ts;
}

export async function listSnapshots() {
  const all = await getAll(SNAPSHOTS);
  return all
    .map(({ ts, label }) => ({ ts, label }))
    .sort((a, b) => b.ts - a.ts);
}

export const getSnapshot = (ts) => getOne(SNAPSHOTS, ts);

export async function pruneSnapshots(keep = SNAPSHOT_KEEP) {
  const keys = (await getAllKeys(SNAPSHOTS)).sort((a, b) => a - b);
  for (let i = 0; i < keys.length - keep; i++) {
    await delSilent(SNAPSHOTS, keys[i]);
  }
}

export async function restoreSnapshot(ts) {
  const snap = await getSnapshot(ts);
  if (!snap) return false;
  await putSnapshot('pre-undo');
  await replaceAll(snap.data);
  return true;
}

// ── Merge helpers (setlist mergeRecord, unchanged semantics) ──

// Note fields where a blank must never silently beat real content when two
// device copies merge. `body` is deliberately EXCLUDED: concurrent body edits
// are resolved by the sync layer as conflict copies, never by field-filling.
export const NOTE_FILL_FIELDS = ['tags', 'meta', 'sourceDevice', 'folderId'];
// Attachment fields carrying expensive derived content (OCR, transcripts) or
// upload state — a copy that lacks them must never erase them in a merge.
export const ATTACHMENT_FILL_FIELDS = [
  'ocrText', 'transcript', 'transcriptSource', 'driveFileId',
  'width', 'height', 'durationSec', 'name',
];

function isEmptyValue(v) {
  if (v == null || v === '' || v === 0) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

export function markCleared(record, field) {
  record.clearedFields = { ...(record.clearedFields || {}), [field]: Date.now() };
}

// Merge two copies of the same record: newer (by updatedAt/createdAt) wins,
// but a blank in the winner never erases content the loser still carries —
// unless a clearedFields tombstone says the blank was a more recent delete.
// deletedAt rides updatedAt: trashing bumps updatedAt, so a trash on one
// device beats an older edit from another, and a later edit un-trashes.
export function mergeRecord(a, b, fillFields = null) {
  if (!a) return b;
  if (!b) return a;
  const ts = (r) => r.updatedAt || r.createdAt || 0;
  const [newer, older] = ts(b) > ts(a) ? [b, a] : [a, b];
  if (!fillFields) return newer;

  let out = newer;
  const olderTs = ts(older);
  for (const f of fillFields) {
    if (!isEmptyValue(newer[f]) || isEmptyValue(older[f])) continue;
    const clearedAt = Math.max(newer.clearedFields?.[f] || 0, older.clearedFields?.[f] || 0);
    if (clearedAt >= olderTs) continue;
    if (out === newer) out = { ...newer };
    out[f] = older[f];
  }
  const cleared = { ...(older.clearedFields || {}) };
  for (const [f, t] of Object.entries(newer.clearedFields || {})) {
    cleared[f] = Math.max(cleared[f] || 0, t);
  }
  if (Object.keys(cleared).length) {
    if (out === newer) out = { ...newer };
    out.clearedFields = cleared;
  }
  return out;
}

// ── Export / Import ──

// Tombstones past TTL drop out of the export (and get purged locally by
// purgeExpiredTombstones) so the sync payload doesn't grow forever.
function exportable(recs) {
  const cutoff = Date.now() - TRASH_TTL_MS;
  return recs.filter(r => !r.deletedAt || r.deletedAt > cutoff);
}

export async function exportAll() {
  // Deliberately omits BLOBS (binaries sync as separate Drive files) and
  // SNAPSHOTS (local-only; would recurse the backup into every snapshot).
  const [notes, folders, tasks, tasklists, attachments, annotations] = await Promise.all([
    getAll(NOTES), getAll(FOLDERS), getAll(TASKS), getAll(TASKLISTS), getAll(ATTACHMENTS), getAll(ANNOTATIONS),
  ]);
  return {
    version: 1,
    app: 'mind',
    notes: exportable(notes),
    folders: exportable(folders),
    tasks: exportable(tasks),
    tasklists: exportable(tasklists),
    attachments: exportable(attachments),
    annotations,
    settings: getSettingsRaw(),
    exportedAt: Date.now(),
  };
}

// Additive, merge-aware import — upserts without deleting. Timestamps are
// preserved (raw puts) so merges stay stable across devices. Tombstoned
// incoming records land as tombstones (that's how deletes propagate).
export async function importAll(data) {
  if (data.notes) for (const n of data.notes) await put(NOTES, mergeRecord(await getOne(NOTES, n.id), n, NOTE_FILL_FIELDS));
  if (data.folders) for (const f of data.folders) await put(FOLDERS, mergeRecord(await getOne(FOLDERS, f.id), f));
  if (data.tasks) for (const t of data.tasks) await put(TASKS, mergeRecord(await getOne(TASKS, t.id), t));
  if (data.tasklists) for (const tl of data.tasklists) await put(TASKLISTS, mergeRecord(await getOne(TASKLISTS, tl.id), tl));
  if (data.attachments) for (const a of data.attachments) await put(ATTACHMENTS, mergeRecord(await getOne(ATTACHMENTS, a.id), a, ATTACHMENT_FILL_FIELDS));
  if (data.annotations) for (const an of data.annotations) await put(ANNOTATIONS, mergeRecord(await getOne(ANNOTATIONS, an.key), an));
  if (data.settings) applySettingsRaw(data.settings);
}

// Full REPLACE (not a merge) — for snapshot undo / explicit restore.
export async function replaceAll(data) {
  await clearStore(NOTES);
  await clearStore(FOLDERS);
  await clearStore(TASKS);
  await clearStore(TASKLISTS);
  await clearStore(ATTACHMENTS);
  await clearStore(ANNOTATIONS);
  await importAll(data);
}

// Hard-delete tombstones past TTL, plus their local blobs. Runs at init.
export async function purgeExpiredTombstones() {
  const cutoff = Date.now() - TRASH_TTL_MS;
  const expired = (recs) => recs.filter(r => r.deletedAt && r.deletedAt < cutoff);
  for (const n of expired(await getAll(NOTES))) await delSilent(NOTES, n.id);
  for (const f of expired(await getAll(FOLDERS))) await delSilent(FOLDERS, f.id);
  for (const t of expired(await getAll(TASKS))) await delSilent(TASKS, t.id);
  for (const a of expired(await getAll(ATTACHMENTS))) {
    await delSilent(ATTACHMENTS, a.id);
    await deleteBlob(a.id);
  }
}

// ── Cross-device settings (public identifiers only — never tokens) ──

const SETTINGS_KEYS = {
  gdriveClientId: 'voidstar.mind.gdrive.clientId',
};

function getSettingsRaw() {
  const out = {};
  for (const [name, key] of Object.entries(SETTINGS_KEYS)) {
    const v = localStorage.getItem(key);
    if (v) out[name] = v;
  }
  return out;
}

function applySettingsRaw(settings) {
  for (const [name, key] of Object.entries(SETTINGS_KEYS)) {
    if (settings[name] && !localStorage.getItem(key)) {
      localStorage.setItem(key, settings[name]);
    }
  }
}
