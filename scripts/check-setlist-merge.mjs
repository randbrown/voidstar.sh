// Node smoke test for the setlist backup merge — especially the deletion
// tombstones that stop the additive pull-merge-push cycle from resurrecting
// deleted records. Run via `npm run check`.
//
// gdrive-backup.js and store.js are import-safe under node (browser APIs are
// only touched inside functions), so we test the real mergeData, not a copy.

import { mergeData } from '../src/lib/setlist/gdrive-backup.js';
import { mergeRecord, SONG_FILL_FIELDS, markCleared } from '../src/lib/setlist/store.js';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}

const song = (id, updatedAt, extra = {}) => ({
  id, title: `song ${id}`, artist: '', key: '', createdAt: 1000, updatedAt, ...extra,
});
const tomb = (store, id, deletedAt) => ({ key: `${store}:${id}`, store, id, deletedAt });

// ── 1. A deleted record still present in the remote file stays deleted ──
{
  const local = { songs: [song('a', 2000)], deletions: [tomb('songs', 'b', 5000)] };
  const remote = { songs: [song('a', 2000), song('b', 3000)], deletions: [] };
  const m = mergeData(local, remote);
  check('deleted song is not resurrected by remote copy',
    m.songs.length === 1 && m.songs[0].id === 'a');
  check('tombstone survives the merge',
    m.deletions.length === 1 && m.deletions[0].key === 'songs:b');
}

// ── 2. Remote tombstone kills the local record (delete propagates) ──
{
  const local = { songs: [song('a', 2000), song('b', 3000)], deletions: [] };
  const remote = { songs: [song('a', 2000)], deletions: [tomb('songs', 'b', 5000)] };
  const m = mergeData(local, remote);
  check('remote deletion removes local record', m.songs.length === 1 && m.songs[0].id === 'a');
  check('remote tombstone is adopted', m.deletions.some(d => d.key === 'songs:b'));
}

// ── 3. A record edited AFTER its deletion wins and retires the tombstone ──
{
  const local = { songs: [song('b', 6000)], deletions: [] };
  const remote = { songs: [], deletions: [tomb('songs', 'b', 5000)] };
  const m = mergeData(local, remote);
  check('newer edit beats older tombstone', m.songs.length === 1 && m.songs[0].id === 'b');
  check('beaten tombstone is retired', m.deletions.length === 0);
}

// ── 4. Tombstone union keeps the newest deletedAt per key ──
{
  const local = { songs: [], deletions: [tomb('songs', 'x', 1000)] };
  const remote = { songs: [], deletions: [tomb('songs', 'x', 2000)] };
  const m = mergeData(local, remote);
  check('newest tombstone wins the union',
    m.deletions.length === 1 && m.deletions[0].deletedAt === 2000);
}

// ── 5. Equal timestamps: deletion wins (deletedAt >= updatedAt is dead) ──
{
  const local = { songs: [song('c', 5000)], deletions: [] };
  const remote = { songs: [], deletions: [tomb('songs', 'c', 5000)] };
  const m = mergeData(local, remote);
  check('tie between edit and delete goes to the delete', m.songs.length === 0);
}

// ── 6. Legacy payloads without a deletions array still merge ──
{
  const local = { songs: [song('a', 2000)] };
  const remote = { songs: [song('b', 3000)] };
  const m = mergeData(local, remote);
  check('legacy payloads (no deletions) merge additively',
    m.songs.length === 2 && Array.isArray(m.deletions) && m.deletions.length === 0);
}

// ── 7. Annotations tombstone by songId (incl. alt-chart composite keys) ──
{
  const ann = (songId, updatedAt) => ({ songId, strokes: [], updatedAt });
  const local = { annotations: [ann('s1', 1000)], deletions: [tomb('annotations', 's1::alt9', 4000)] };
  const remote = { annotations: [ann('s1', 1000), ann('s1::alt9', 3000)], deletions: [] };
  const m = mergeData(local, remote);
  check('alt-chart annotation deletion sticks',
    m.annotations.length === 1 && m.annotations[0].songId === 's1');
}

// ── 8. Regression: fill-empty + clearedFields still behave ──
{
  const older = song('a', 1000, { steelSummary: 'ride the E lever' });
  const newer = song('a', 2000, { steelSummary: '' });
  const filled = mergeRecord(newer, older, SONG_FILL_FIELDS);
  check('blank in newer copy fills from older content', filled.steelSummary === 'ride the E lever');

  const cleared = song('a', 3000, { steelSummary: '' });
  markCleared(cleared, 'steelSummary');
  const afterClear = mergeRecord(cleared, older, SONG_FILL_FIELDS);
  check('clearedFields tombstone beats fill-empty', afterClear.steelSummary === '');
}

if (failures) {
  console.error(`check-setlist-merge: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-setlist-merge: all good');
