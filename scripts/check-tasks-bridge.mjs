// Smoke tests for the setlist↔mind todo-bridge decision core — pure functions
// only (no IndexedDB / DOM), so they run under plain node:
//   node scripts/check-tasks-bridge.mjs
//
// Covers: id round-trip, text canonicalization, task-state classification
// (archived-done counts as done), all rows of the reconcile table including
// both branches of every timestamp tie-break, the missing-todoStatusAt
// ambiguity rule (converge to cleared), orphan trashing on song delete, and
// idempotence (applying each action lands in a state whose next decision is
// 'none').

import {
  SETLIST_TASK_PREFIX,
  taskIdForSong, songIdForTask, canonicalTaskText,
  taskStateOf, decideTodoAction,
} from '../src/lib/setlist/todo-sync-core.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const task = (over = {}) => ({
  id: 'sl:song-1', listId: 'external-setlist', text: 'practice: Wildflower',
  done: false, completedAt: 0, archivedAt: 0, sourceNoteId: '',
  order: 1000, createdAt: 1000, updatedAt: 1000, deletedAt: 0,
  remindAt: 0, remindPlace: null, remindStatus: '', snoozedUntil: 0,
  sourceUrl: '/lab/setlist#song/song-1', ...over,
});
const song = (over = {}) => ({ songExists: true, chipOn: true, todoStatusAt: 2000, title: 'Wildflower', ...over });
const act = (s, t) => decideTodoAction(s, t).action;

// ── (a) helpers ──
section('(a) id + text helpers');
{
  check('prefix is sl:', SETLIST_TASK_PREFIX === 'sl:');
  check('taskIdForSong', taskIdForSong('abc') === 'sl:abc');
  check('songIdForTask round-trip', songIdForTask(taskIdForSong('abc')) === 'abc');
  check('songIdForTask rejects foreign ids', songIdForTask('default-todo') === null);
  check('songIdForTask rejects non-strings', songIdForTask(null) === null);
  check('canonical text', canonicalTaskText('Wildflower') === 'practice: Wildflower');
  check('canonical text handles empty title', canonicalTaskText('') === 'practice: untitled');
}

// ── (b) task-state classification ──
section('(b) taskStateOf');
{
  check('null → none', taskStateOf(null) === 'none');
  check('live undone → open', taskStateOf(task()) === 'open');
  check('done → done', taskStateOf(task({ done: true, completedAt: 5000 })) === 'done');
  check('archived done still done', taskStateOf(task({ done: true, completedAt: 5000, archivedAt: 6000 })) === 'done');
  check('tombstone → trashed', taskStateOf(task({ deletedAt: 5000 })) === 'trashed');
  check('trashed beats done', taskStateOf(task({ done: true, deletedAt: 5000 })) === 'trashed');
}

// ── (c) reconcile table, row by row ──
section('(c) decision table');
{
  // 1: song deleted
  check('r1 gone/open → trash', act(song({ songExists: false }), task()) === 'trash-task');
  check('r1 gone/done → trash', act(song({ songExists: false }), task({ done: true })) === 'trash-task');
  check('r1 gone/trashed → none', act(song({ songExists: false }), task({ deletedAt: 5 })) === 'none');
  check('r1 gone/none → none', act(song({ songExists: false }), null) === 'none');
  // 2: chip on, no task
  const created = decideTodoAction(song(), null);
  check('r2 on/none → create', created.action === 'create-task');
  check('r2 create carries canonical text', created.text === 'practice: Wildflower');
  // 3: chip on, open task
  check('r3 on/open text match → none', act(song(), task()) === 'none');
  const retitled = decideTodoAction(song({ title: 'Wildflower (acoustic)' }), task());
  check('r3 on/open title changed → update-text', retitled.action === 'update-text');
  check('r3 update carries new text', retitled.text === 'practice: Wildflower (acoustic)');
  // 4: chip on, done task — tie-break on completedAt
  check('r4 re-toggle after done → reopen', act(song({ todoStatusAt: 9000 }), task({ done: true, completedAt: 5000 })) === 'reopen-task');
  check('r4 done in mind wins → clear chip', act(song({ todoStatusAt: 2000 }), task({ done: true, completedAt: 5000 })) === 'clear-chip');
  check('r4 archived done also clears', act(song({ todoStatusAt: 2000 }), task({ done: true, completedAt: 5000, archivedAt: 6000 })) === 'clear-chip');
  // 5: chip on, trashed task — tie-break on deletedAt
  check('r5 re-toggle after trash → reopen', act(song({ todoStatusAt: 9000 }), task({ deletedAt: 5000 })) === 'reopen-task');
  check('r5 trash-in-mind = dismiss → clear chip', act(song({ todoStatusAt: 2000 }), task({ deletedAt: 5000 })) === 'clear-chip');
  // 6: chip off, nothing live
  check('r6 off/none → none', act(song({ chipOn: false }), null) === 'none');
  check('r6 off/done → none', act(song({ chipOn: false }), task({ done: true, completedAt: 5000 })) === 'none');
  check('r6 off/trashed → none', act(song({ chipOn: false }), task({ deletedAt: 5000 })) === 'none');
  // 7: chip off, open task — tie-break on updatedAt
  check('r7 task re-opened in mind wins → set chip', act(song({ chipOn: false, todoStatusAt: 2000 }), task({ updatedAt: 5000 })) === 'set-chip');
  check('r7 chip off wins → trash task', act(song({ chipOn: false, todoStatusAt: 9000 }), task({ updatedAt: 5000 })) === 'trash-task');
}

// ── (d) ambiguity rule: missing todoStatusAt converges to cleared ──
section('(d) legacy records (todoStatusAt absent) never resurrect');
{
  check('on/done, no stamp → clear chip', act(song({ todoStatusAt: 0 }), task({ done: true, completedAt: 5000 })) === 'clear-chip');
  check('on/trashed, no stamp → clear chip', act(song({ todoStatusAt: 0 }), task({ deletedAt: 5000 })) === 'clear-chip');
  check('off/open, no stamp → trash task', act(song({ chipOn: false, todoStatusAt: 0 }), task({ updatedAt: 5000 })) === 'trash-task');
  check('on/none, no stamp → still create (backfill)', act(song({ todoStatusAt: 0 }), null) === 'create-task');
}

// ── (e) idempotence: every action lands in a fixpoint ──
section('(e) applying an action → next decision is none');
{
  // Model the glue's side effects; NOW is later than every fixture stamp.
  const NOW = 10_000;
  const apply = (s, t, d) => {
    switch (d.action) {
      case 'create-task': return [s, task({ text: d.text, createdAt: NOW, updatedAt: NOW })];
      case 'update-text': return [s, { ...t, text: d.text, updatedAt: NOW }];
      case 'reopen-task': return [s, { ...t, done: false, completedAt: 0, archivedAt: 0, deletedAt: 0, text: d.text, updatedAt: NOW }];
      case 'trash-task': return [s, { ...t, deletedAt: NOW, updatedAt: NOW }];
      case 'clear-chip': return [{ ...s, chipOn: false, todoStatusAt: NOW }, t];
      case 'set-chip': return [{ ...s, chipOn: true, todoStatusAt: NOW }, t];
      default: return [s, t];
    }
  };
  const fixtures = [
    ['create', song(), null],
    ['update-text', song({ title: 'New Title' }), task()],
    ['reopen from done', song({ todoStatusAt: 9000 }), task({ done: true, completedAt: 5000 })],
    ['reopen from trash', song({ todoStatusAt: 9000 }), task({ deletedAt: 5000 })],
    ['trash on chip-off', song({ chipOn: false, todoStatusAt: 9000 }), task({ updatedAt: 5000 })],
    ['trash on song delete', song({ songExists: false }), task()],
    ['clear-chip on done', song({ todoStatusAt: 2000 }), task({ done: true, completedAt: 5000 })],
    ['set-chip on reopen', song({ chipOn: false, todoStatusAt: 2000 }), task({ updatedAt: 5000 })],
  ];
  for (const [name, s0, t0] of fixtures) {
    const d1 = decideTodoAction(s0, t0);
    const [s1, t1] = apply(s0, t0, d1);
    const d2 = decideTodoAction(s1, t1);
    // set-chip may legitimately need one text touch-up before settling.
    const [s2, t2] = apply(s1, t1, d2);
    const settled = d2.action === 'none' ||
      (d2.action === 'update-text' && decideTodoAction(s2, t2).action === 'none');
    check(`${name} settles`, settled, `second decision was ${d2.action}`);
  }
}

console.log(`\n${failed ? `FAILED ${failed} check(s)` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
