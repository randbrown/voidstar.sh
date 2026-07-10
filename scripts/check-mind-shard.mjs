// Smoke tests for the mind sharding + merge core — pure functions only (no
// IndexedDB / DOM), so they run under plain node:  node scripts/check-mind-shard.mjs
//
// Covers: bucket determinism, canonical-hash stability (key/array order
// independence + change detection), split↔combine round-trip, first-sync no
// conflict spam, same-note conflict copy + dedup (full-local corpus), tombstone
// propagation, attachment fill-field retention, and delta minimality.

import {
  fnv1a, bucket, shardName, parseShardName, DEFAULT_SHARD_COUNT,
  canonicalJSON, hashShard, hashIndex,
  splitIntoShards, combineShards, isEmptyShard,
  mergeNotes, mergeShardData, mergeIndexData, mergeById,
  computeDelta, isEmptyDelta,
} from '../src/lib/mind/shard.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const note = (id, over = {}) => ({
  id, title: id, autoTitle: false, body: '', folderId: '', tags: [], pinned: false,
  conflictOf: '', meta: {}, createdAt: 1000, updatedAt: 1000, deletedAt: 0, clearedFields: {}, ...over,
});
const att = (id, over = {}) => ({
  id, noteId: '', kind: 'image', name: '', mimeType: '', size: 0, ocrText: '', transcript: '',
  transcriptSource: '', driveFileId: '', createdAt: 1000, updatedAt: 1000, deletedAt: 0, clearedFields: {}, ...over,
});
const dataset = (over = {}) => ({
  notes: [], folders: [], tasks: [], tasklists: [], attachments: [], annotations: [], settings: {}, ...over,
});
const idset = (arr) => new Set(arr.map(r => r.id));
const eqSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

// ── (a) bucketing ──
section('(a) bucketing is deterministic and in-range');
{
  check('fnv1a stable', fnv1a('hello') === fnv1a('hello'));
  check('bucket stable', bucket('note-abc', 64) === bucket('note-abc', 64));
  let inRange = true;
  for (const s of ['a', 'longer-id-xyz', 'att-1:2', '', '💡']) {
    const b = bucket(s, 64);
    if (!(Number.isInteger(b) && b >= 0 && b < 64)) inRange = false;
  }
  check('bucket in [0,N)', inRange);
  check('shardName/parseShardName round-trip', parseShardName(shardName(7)) === 7);
  check('parseShardName rejects junk', parseShardName('index.json') === null);
  check('DEFAULT_SHARD_COUNT = 64', DEFAULT_SHARD_COUNT === 64);
}

// ── (b) canonical hashing ──
section('(b) canonical hash: order-independent, change-sensitive');
{
  // Same records, different object-key order AND different array order → same hash.
  const n1 = note('n1', { body: 'x', updatedAt: 5 });
  const n2 = note('n2', { body: 'y', updatedAt: 9 });
  const shardA = { notes: [n1, n2], tasks: [], attachments: [], annotations: [] };
  const reordered = { updatedAt: 5, body: 'x', id: 'n1', title: 'n1', autoTitle: false, folderId: '', tags: [], pinned: false, conflictOf: '', meta: {}, createdAt: 1000, deletedAt: 0, clearedFields: {} };
  const shardB = { annotations: [], attachments: [], tasks: [], notes: [n2, reordered] };
  check('key + array order independent', hashShard(shardA) === hashShard(shardB), `${hashShard(shardA)} vs ${hashShard(shardB)}`);
  // A content change flips the hash.
  const shardC = { notes: [note('n1', { body: 'CHANGED', updatedAt: 5 }), n2], tasks: [], attachments: [], annotations: [] };
  check('content change flips hash', hashShard(shardA) !== hashShard(shardC));
  // Index hash likewise stable/sensitive.
  const idxA = { schema: 2, shardCount: 64, folders: [{ id: 'f1', name: 'A' }], tasklists: [], settings: { dock: 'top' } };
  const idxB = { settings: { dock: 'top' }, tasklists: [], folders: [{ name: 'A', id: 'f1' }], shardCount: 64, schema: 2 };
  check('index hash order-independent', hashIndex(idxA) === hashIndex(idxB));
  check('index hash change-sensitive', hashIndex(idxA) !== hashIndex({ ...idxA, settings: { dock: 'left' } }));
  // canonicalJSON leaves arrays in place (tags order preserved verbatim).
  check('canonicalJSON preserves array order', canonicalJSON({ tags: ['b', 'a'] }) === '{"tags":["b","a"]}');
}

// ── (c) split ↔ combine round-trip ──
section('(c) splitIntoShards ↔ combineShards is identity (by id set)');
{
  const ds = dataset({
    notes: [note('n1'), note('n2'), note('n3'), note('n4')],
    tasks: [{ id: 't1' }, { id: 't2' }],
    attachments: [att('a1'), att('a2')],
    annotations: [{ key: 'a1:1' }, { key: 'a2' }],
    folders: [{ id: 'f1' }],
    tasklists: [{ id: 'tl1' }],
    settings: { dock: 'bottom' },
  });
  const { index, shards } = splitIntoShards(ds, 8);
  const combined = combineShards(index, [...shards.values()]);
  check('notes preserved', eqSet(idset(combined.notes), idset(ds.notes)));
  check('tasks preserved', eqSet(idset(combined.tasks), idset(ds.tasks)));
  check('attachments preserved', eqSet(idset(combined.attachments), idset(ds.attachments)));
  check('annotations preserved', eqSet(new Set(combined.annotations.map(a => a.key)), new Set(ds.annotations.map(a => a.key))));
  check('folders/tasklists/settings ride index', combined.folders.length === 1 && combined.tasklists.length === 1 && combined.settings.dock === 'bottom');
  check('no empty shard materialized', [...shards.values()].every(s => !isEmptyShard(s)));
  let bucketedRight = true;
  for (const [b, s] of shards) for (const n of s.notes) if (bucket(n.id, 8) !== b) bucketedRight = false;
  check('records land in their bucket', bucketedRight);
}

// ── (d) first sync — no conflict-copy spam ──
section('(d) first sync (lastCycleAt=0) is plain LWW, zero conflicts');
{
  const local = { notes: [note('n1', { body: 'a', updatedAt: 10 })] };
  const remote = { notes: [note('n1', { body: 'b', updatedAt: 20 })] };
  const { merged, conflicts } = mergeShardData(local, remote, { lastCycleAt: 0 });
  check('0 conflicts on first sync', conflicts === 0);
  check('newer body wins (LWW)', merged.notes.find(n => n.id === 'n1').body === 'b');
}

// ── (e) different notes changed → no false conflict ──
section('(e) concurrent edits to DIFFERENT notes never conflict');
{
  const local = { notes: [note('n1', { body: 'a', updatedAt: 10 }), note('n2', { body: 'b', updatedAt: 5 })] };
  const remote = { notes: [note('n1', { body: 'a', updatedAt: 10 }), note('n2', { body: 'B', updatedAt: 20 })] };
  const { merged, conflicts } = mergeShardData(local, remote, { lastCycleAt: 8 });
  check('0 conflicts', conflicts === 0);
  check('both notes survive', idset(merged.notes).has('n1') && idset(merged.notes).has('n2'));
  check('n2 takes newer body', merged.notes.find(n => n.id === 'n2').body === 'B');
}

// ── (f) same note, concurrent body edit → exactly one deduped conflict copy ──
section('(f) concurrent same-note edit makes one conflict copy, deduped');
{
  const opts = { lastCycleAt: 5, deviceName: 'mac', idgen: () => 'copyid', now: () => 999 };
  const local = [note('n1', { title: 'N1', body: 'a', updatedAt: 20 })];
  const remote = [note('n1', { title: 'N1', body: 'b', updatedAt: 10 })];
  const r1 = mergeNotes(local, remote, opts);
  check('one conflict copy', r1.conflicts === 1, String(r1.conflicts));
  const copy = r1.merged.find(n => n.conflictOf === 'n1');
  check('copy carries losing body', copy && copy.body === 'b');
  check('winner (newer) kept as n1', r1.merged.find(n => n.id === 'n1' && !n.conflictOf).body === 'a');
  // Re-run with the copy already present in local (simulating a different shard) → no second copy.
  const localWithCopy = [...local, { ...copy }];
  const r2 = mergeNotes(localWithCopy, remote, opts);
  check('dedup: no second copy when one exists (full-local corpus)', r2.conflicts === 0, String(r2.conflicts));
}

// ── (g) tombstone propagates and lands in the delta ──
section('(g) remote delete propagates as a tombstone in the delta');
{
  const local = dataset({ notes: [note('n1', { body: 'live', updatedAt: 10, deletedAt: 0 })] });
  const remotePartial = { notes: [note('n1', { body: 'live', updatedAt: 20, deletedAt: 20 })] };
  const { merged } = mergeShardData(local, remotePartial, { lastCycleAt: 5 });
  const mergedFull = dataset({ notes: merged.notes });
  check('merged note is tombstoned', mergedFull.notes.find(n => n.id === 'n1').deletedAt === 20);
  const delta = computeDelta(local, mergedFull);
  check('tombstone is in delta', (delta.notes || []).some(n => n.id === 'n1' && n.deletedAt === 20));
}

// ── (h) attachment fill-fields: newer blank must not erase derived content ──
section('(h) fill-fields keep OCR/driveFileId across a newer blank copy');
{
  const local = [att('a1', { driveFileId: 'F', ocrText: 'T', updatedAt: 5 })];
  const remote = [att('a1', { driveFileId: '', ocrText: '', updatedAt: 10 })];
  const merged = mergeById(local, remote, 'id', ['ocrText', 'transcript', 'transcriptSource', 'driveFileId', 'width', 'height', 'durationSec', 'name']);
  const m = merged.find(a => a.id === 'a1');
  check('driveFileId retained', m.driveFileId === 'F');
  check('ocrText retained', m.ocrText === 'T');
}

// ── (i) delta minimality + partial-remote leaves local-only records intact ──
section('(i) computeDelta excludes unchanged; partial remote keeps local-only');
{
  const n1 = note('n1'); const n2 = note('n2'); const n3 = note('n3');
  const local = dataset({ notes: [n1, n2, n3] });
  // remotePartial only touches n2.
  const remotePartial = { notes: [note('n2', { body: 'edited', updatedAt: 2000 })] };
  const { merged } = mergeShardData(local, remotePartial, { lastCycleAt: 0 });
  const mergedFull = dataset({ notes: merged.notes });
  check('local-only n1/n3 identity preserved', merged.notes.find(n => n.id === 'n1') === n1 && merged.notes.find(n => n.id === 'n3') === n3);
  const delta = computeDelta(local, mergedFull);
  check('delta contains only n2', (delta.notes || []).length === 1 && delta.notes[0].id === 'n2');
  // No change at all → empty delta.
  const noChange = computeDelta(local, dataset({ notes: [n1, n2, n3] }));
  check('unchanged → empty delta', isEmptyDelta(noChange), JSON.stringify(noChange));
}

// ── (j) index merge change flag ──
section('(j) mergeIndexData reports change correctly');
{
  const localIdx = { folders: [{ id: 'f1', name: 'A', updatedAt: 1 }], tasklists: [], settings: {} };
  const remoteSame = { folders: [{ id: 'f1', name: 'A', updatedAt: 1 }], tasklists: [], settings: {} };
  const remoteNew = { folders: [{ id: 'f2', name: 'B', updatedAt: 2 }], tasklists: [], settings: {} };
  check('no change when identical', mergeIndexData(localIdx, remoteSame).changed === false);
  check('change when remote adds folder', mergeIndexData(localIdx, remoteNew).changed === true);
}

console.log(`\n${failed ? `FAILED ${failed} check(s)` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
