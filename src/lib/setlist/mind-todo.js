// Setlist side of the setlist↔mind todo bridge — the only setlist module
// that imports mind code. Every entry point is fire-and-forget safe (warns
// instead of throwing) so the bridge can never break a core setlist flow.
//
// The state machine and tie-breakers live in todo-sync-core.js (pure,
// node-tested); mind-side writes go through mind/external-tasks.js, which
// owns the dirty-shard marking mind's Drive push depends on. Reconciliation
// runs from: setlist boot, tab refocus (min-interval sweep), right after a
// setlist Drive pull that changed records, and inline after a chip toggle
// or song delete.

import * as slStore from './store.js';
import * as mind from '../mind/external-tasks.js';
import { taskIdForSong, songIdForTask, decideTodoAction } from './todo-sync-core.js';

const TAG = '[todo-bridge]';

const sourceUrlFor = (songId) => `/lab/setlist#song/${songId}`;
const chipOn = (song) => (song.statuses || []).includes('todo');
const summaryOf = (song) => ({ songExists: true, chipOn: chipOn(song), todoStatusAt: song.todoStatusAt || 0, title: song.title });

// Applies one decision; returns true when the SONG record changed (the
// caller re-renders), false when only mind's side did.
async function applyAction(decision, songId, song, task) {
  switch (decision.action) {
    case 'create-task':
      await mind.createExternalTask({ id: taskIdForSong(songId), text: decision.text, sourceUrl: sourceUrlFor(songId) });
      return false;
    case 'update-text':
      await mind.writeExternalTask({ ...task, text: decision.text });
      return false;
    case 'reopen-task':
      // Re-stamping listId/sourceUrl also heals records from before either
      // field existed; writeExternalTask bumps updatedAt so the reopen wins
      // mind's LWW merge.
      await mind.writeExternalTask({
        ...task, done: false, completedAt: 0, archivedAt: 0, deletedAt: 0,
        listId: mind.SETLIST_TASKLIST_ID, text: decision.text, sourceUrl: sourceUrlFor(songId),
      });
      return false;
    case 'trash-task':
      await mind.trashExternalTask(task);
      return false;
    case 'clear-chip':
      await slStore.putSong({ ...song, statuses: (song.statuses || []).filter((s) => s !== 'todo'), todoStatusAt: Date.now() });
      return true;
    case 'set-chip':
      await slStore.putSong({ ...song, statuses: [...new Set([...(song.statuses || []), 'todo'])], todoStatusAt: Date.now() });
      return true;
    default:
      return false;
  }
}

let _inflight = null;

// Full sweep over every song + every live setlist-sourced task. Serialized:
// concurrent calls share the run already in flight. Never rejects.
export function reconcileTodoBridge() {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      if (!mind.isAvailable()) return { songsChanged: false };
      const [songs, liveTasks] = await Promise.all([slStore.getAllSongs(), mind.getLiveSetlistTasks()]);
      const songById = new Map(songs.map((s) => [s.id, s]));
      const taskById = new Map(liveTasks.map((t) => [t.id, t]));
      let songsChanged = false;

      for (const song of songs) {
        const id = taskIdForSong(song.id);
        let task = taskById.get(id) || null;
        // A chip-on song needs the raw record: "trashed in mind" and "never
        // existed" decide differently (dismiss vs create).
        if (!task && chipOn(song)) task = await mind.getTaskRaw(id);
        const decision = decideTodoAction(summaryOf(song), task);
        if (await applyAction(decision, song.id, song, task)) songsChanged = true;
      }

      // Orphans: live sl: tasks whose song was hard-deleted. Tasks without
      // the prefix (quick-added by hand into the list) are the user's own —
      // leave them alone.
      for (const task of liveTasks) {
        const songId = songIdForTask(task.id);
        if (!songId || songById.has(songId)) continue;
        await applyAction(decideTodoAction({ songExists: false }, task), songId, null, task);
      }

      return { songsChanged };
    } catch (e) {
      console.warn(TAG, e);
      return { songsChanged: false };
    }
  })().finally(() => { _inflight = null; });
  return _inflight;
}

// Targeted fast path after a chip toggle — the song record (statuses +
// todoStatusAt) has already been saved by the caller.
export async function onTodoToggled(song) {
  try {
    if (!mind.isAvailable()) return;
    const task = await mind.getTaskRaw(taskIdForSong(song.id));
    await applyAction(decideTodoAction(summaryOf(song), task), song.id, song, task);
  } catch (e) {
    console.warn(TAG, e);
  }
}

export async function onSongDeleted(songId) {
  try {
    if (!mind.isAvailable()) return;
    const task = await mind.getTaskRaw(taskIdForSong(songId));
    await applyAction(decideTodoAction({ songExists: false }, task), songId, null, task);
  } catch (e) {
    console.warn(TAG, e);
  }
}

let _wired = false;
let _lastSweep = 0;
let _onChanged = null;
const SWEEP_MIN_MS = 10_000;

// Sweep + notify, bypassing the min-interval — for callers that KNOW state
// moved (e.g. a Drive pull that changed records).
export async function reconcileAndNotify() {
  const { songsChanged } = await reconcileTodoBridge();
  if (songsChanged) _onChanged?.();
  return songsChanged;
}

export function initTodoBridge({ onChanged } = {}) {
  if (_wired || typeof window === 'undefined') return;
  _wired = true;
  _onChanged = onChanged || null;
  const sweep = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (Date.now() - _lastSweep < SWEEP_MIN_MS) return;
    _lastSweep = Date.now();
    reconcileAndNotify().catch((e) => console.warn(TAG, e));
  };
  document.addEventListener('visibilitychange', sweep);
  window.addEventListener('focus', sweep);
  sweep();
}
