// Mind's write surface for OTHER apps on this origin (currently the setlist
// todo bridge). External writers must not touch store.js directly, for one
// load-bearing reason: mind's sharded Drive push only uploads dirty-flagged
// shards, and the write hook that flags them (store.setOnWrite → markShardDirty
// / markLocalDirty, wired in initMindApp) is NOT active on other apps' pages.
// A bare store write from the setlist page would sit in IndexedDB forever and
// never reach Drive. Every write here marks dirtiness explicitly instead —
// never via setOnWrite, which would clobber mind's own hook if this module
// ever runs inside the mind app itself.

import * as store from './store.js';
import { markShardDirty, markLocalDirty } from './gdrive-sync.js';

export { isAvailable } from './store.js';

// One list for all setlist-sourced tasks. Deterministic id, same trick as
// ensureFolderTasklist's `todo-<folderId>`: two devices lazily creating it
// merge into ONE list instead of forking.
export const SETLIST_TASKLIST_ID = 'external-setlist';

function markTaskWrite(id) {
  markShardDirty({ store: 'tasks', key: id });
  markLocalDirty();
}

export async function ensureSetlistTasklist() {
  const existing = await store.getTasklist(SETLIST_TASKLIST_ID);
  if (existing && !existing.deletedAt) return existing;
  const tl = store.createTasklist('setlist', { id: SETLIST_TASKLIST_ID });
  await store.putTasklistRaw(tl);
  markShardDirty({ store: 'tasklists', key: SETLIST_TASKLIST_ID });
  markLocalDirty();
  return tl;
}

// Raw read — tombstoned/archived records included; the bridge's reconcile
// needs to see them to tell "trashed in mind" from "never existed".
export const getTaskRaw = (id) => store.getTask(id);

export const getLiveSetlistTasks = () => store.getTasksForList(SETLIST_TASKLIST_ID);

export async function createExternalTask({ id, text, sourceUrl }) {
  const tl = await ensureSetlistTasklist();
  const task = store.createTask(tl.id, text, { id, sourceUrl });
  await store.putTaskRaw(task);
  markTaskWrite(id);
  return task;
}

// Full-record update; bumps updatedAt so the write wins mind's LWW merge.
export async function writeExternalTask(task) {
  await store.putTask(task);
  markTaskWrite(task.id);
}

export async function trashExternalTask(task) {
  await store.trashTask(task);
  markTaskWrite(task.id);
}
