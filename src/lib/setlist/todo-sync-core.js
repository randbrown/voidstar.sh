// Pure decision core for the setlist↔mind todo bridge — no IndexedDB, no DOM,
// so it runs under plain node (scripts/check-tasks-bridge.mjs), same pattern
// as mind/shard.js.
//
// The bridge mirrors a song's `todo` practice-status chip into a mind task
// (id `sl:<songId>`, list `external-setlist`). Two-way: completing/trashing
// the task in mind clears the chip; toggling the chip drives the task. The
// tie-breaker is `song.todoStatusAt` — stamped on every todo-chip change and
// carried by the song record through setlist's Drive merge — compared against
// the task's own timestamps, which ride mind's Drive merge. Reconciliation is
// therefore a pure function of the two synced records: no per-device state.
//
// Ambiguity rule: a song record with no `todoStatusAt` (written by pre-bridge
// code, or resurrected by whole-record LWW) always converges to CLEARED — a
// lost todo marker is minor, a resurrection ping-pong is worse.

export const SETLIST_TASK_PREFIX = 'sl:';

export const taskIdForSong = (songId) => `${SETLIST_TASK_PREFIX}${songId}`;
export const songIdForTask = (taskId) =>
  typeof taskId === 'string' && taskId.startsWith(SETLIST_TASK_PREFIX)
    ? taskId.slice(SETLIST_TASK_PREFIX.length)
    : null;

export const canonicalTaskText = (title) => `practice: ${title || 'untitled'}`;

// 'none' | 'open' | 'done' | 'trashed'. Archived-done counts as done: the
// task was completed, only the strike-through window elapsed.
export function taskStateOf(task) {
  if (!task) return 'none';
  if (task.deletedAt) return 'trashed';
  return task.done ? 'done' : 'open';
}

// The whole two-way protocol as one table. `song` is a plain summary
// ({ songExists, chipOn, todoStatusAt, title }), `task` the raw mind record
// (tombstones included) or null. Returns { action, text? } where action is:
//   'none'        — states agree, do nothing
//   'create-task' — chip on, no task yet (also first-run backfill)
//   'update-text' — song title changed; re-canonicalize task text
//   'reopen-task' — chip re-toggled after the task was done/trashed
//   'trash-task'  — chip off (or song gone) while the task is live
//   'clear-chip'  — task completed/trashed in mind wins; drop the chip
//   'set-chip'    — task re-opened in mind wins; raise the chip
export function decideTodoAction(song, task) {
  const state = taskStateOf(task);
  if (!song.songExists) {
    return state === 'open' || state === 'done' ? { action: 'trash-task' } : { action: 'none' };
  }
  const at = song.todoStatusAt || 0;
  const text = canonicalTaskText(song.title);
  if (song.chipOn) {
    if (state === 'none') return { action: 'create-task', text };
    if (state === 'open') return task.text === text ? { action: 'none' } : { action: 'update-text', text };
    if (state === 'done') return at > (task.completedAt || 0) ? { action: 'reopen-task', text } : { action: 'clear-chip' };
    /* trashed */ return at > task.deletedAt ? { action: 'reopen-task', text } : { action: 'clear-chip' };
  }
  if (state !== 'open') return { action: 'none' };
  if (!at) return { action: 'trash-task' }; // ambiguity rule: converge to cleared
  return (task.updatedAt || 0) > at ? { action: 'set-chip' } : { action: 'trash-task' };
}
