// Node smoke test for setlist copy + archive (store.js copySetlist /
// isArchived) and how archive state survives the Drive backup merge.
// Run via `npm run check`.

import { copySetlist, isArchived } from '../src/lib/setlist/store.js';
import { mergeData } from '../src/lib/setlist/gdrive-backup.js';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}

const original = {
  id: 'sl-1',
  name: 'Friday @ Bluebird',
  venue: 'Bluebird',
  gigDate: '2026-10-02',
  sets: [
    { name: 'Set 1', songIds: ['a', 'b'] },
    { name: 'Set 2', songIds: ['c'] },
  ],
  spotifyUrl: 'https://open.spotify.com/playlist/ref',
  playlists: [
    { id: 'p1', service: 'youtube', url: 'https://youtube.com/playlist?list=x', title: 'yt' },
    { id: 'p2', service: 'spotify', kind: 'export', playlistId: 'built', url: 'https://open.spotify.com/playlist/built' },
  ],
  vocalistLegend: { R: 'Randy' },
  songOverrides: { a: { key: 'G', segueNext: true } },
  clearedFields: { venue: 5 },
  archivedAt: 9000,
  createdAt: 1000,
  updatedAt: 2000,
};

// ── 1. Copy: fresh identity, same running order and per-gig overrides ──
{
  const c = copySetlist(original);
  check('copy gets a new id', c.id && c.id !== original.id);
  check('copy records provenance', c.copiedFrom === 'sl-1');
  check('default name marks it a copy', c.name === 'Friday @ Bluebird (copy)');
  check('venue carried over', c.venue === 'Bluebird');
  check('gig date cleared (a copy is for another gig)', c.gigDate === '');
  check('sets and order carried over',
    JSON.stringify(c.sets) === JSON.stringify(original.sets));
  check('overrides + legend carried over',
    c.songOverrides.a.key === 'G' && c.songOverrides.a.segueNext === true && c.vocalistLegend.R === 'Randy');
  check('reference playlist URL carried over', c.spotifyUrl === original.spotifyUrl);
  check('imported playlists kept, the original\'s exported playlist dropped',
    c.playlists.length === 1 && c.playlists[0].id === 'p1');
  check('copy is not archived', !isArchived(c) && !('archivedAt' in c));
  check('clearedFields tombstones not inherited', !('clearedFields' in c));
  check('timestamps are fresh', c.createdAt > original.updatedAt && c.updatedAt === c.createdAt);
}

// ── 2. Copy is deep: editing it never mutates the original ──
{
  const c = copySetlist(original);
  c.sets[0].songIds.reverse();
  c.sets.push({ name: 'Set 3', songIds: ['d'] });
  c.songOverrides.a.key = 'A';
  c.vocalistLegend.R = 'someone else';
  check('original sets untouched',
    original.sets.length === 2 && original.sets[0].songIds.join() === 'a,b');
  check('original overrides untouched', original.songOverrides.a.key === 'G');
  check('original legend untouched', original.vocalistLegend.R === 'Randy');
}

// ── 3. Overrides win (name/venue/date set at copy time) ──
{
  const c = copySetlist(original, { name: 'Saturday', venue: 'Station Inn', gigDate: '2026-11-14' });
  check('override name', c.name === 'Saturday');
  check('override venue', c.venue === 'Station Inn');
  check('override date', c.gigDate === '2026-11-14');
  check('overrides cannot reuse the original id', copySetlist(original, { id: 'sl-1' }).id !== 'sl-1');
}

// ── 4. Degenerate sources still yield a usable setlist ──
{
  const c = copySetlist({ id: 'x', name: 'empty' });
  check('empty source gets one empty set', c.sets.length === 1 && c.sets[0].songIds.length === 0);
  check('empty source gets empty playlists/overrides',
    Array.isArray(c.playlists) && !c.playlists.length && typeof c.songOverrides === 'object');
}

// ── 5. Archive state merges last-writer-wins (un-archive is not re-filled) ──
{
  const archivedOld = { ...original, archivedAt: 3000, updatedAt: 3000 };
  const restoredNew = { ...original, archivedAt: 0, updatedAt: 4000 };
  const m1 = mergeData({ setlists: [restoredNew] }, { setlists: [archivedOld] });
  check('newer un-archive beats older archived copy', !isArchived(m1.setlists[0]));
  const m2 = mergeData({ setlists: [archivedOld] }, { setlists: [restoredNew] });
  check('…in either merge direction', !isArchived(m2.setlists[0]));
  const archivedNewer = { ...original, archivedAt: 5000, updatedAt: 5000 };
  const m3 = mergeData({ setlists: [restoredNew] }, { setlists: [archivedNewer] });
  check('newer archive beats older active copy', isArchived(m3.setlists[0]));
}

if (failures) { console.error(`\n${failures} setlist copy/archive check(s) failed`); process.exit(1); }
console.log('\nsetlist copy/archive checks passed');
