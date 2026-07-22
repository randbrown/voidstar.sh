// Node smoke test for the setlist "scrape playlist" diff/apply — matching a
// Spotify reference playlist against a setlist's sets and applying inserts,
// removals, and re-ordering. Run via `npm run check`.
//
// playlist-diff.js is pure (match.js only), so we test the real module.

import {
  spotifyTrackId,
  diffPlaylistAgainstSets,
  applyPlaylistToSets,
} from '../src/lib/setlist/playlist-diff.js';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}

const song = (id, title, extra = {}) => ({ id, title, artist: '', spotifyUri: '', ...extra });
const track = (title, artist = '', id = '') => ({
  title, artist, spotifyUrl: id ? `https://open.spotify.com/track/${id}` : '',
});
const flat = (sets) => sets.flatMap((s) => s.songIds);

// ── spotifyTrackId ──
check('track id from URL', spotifyTrackId('https://open.spotify.com/track/abc123?si=x') === 'abc123');
check('track id from URI', spotifyTrackId('spotify:track:abc123') === 'abc123');
check('playlist URL is not a track id', spotifyTrackId('https://open.spotify.com/playlist/abc123') === null);
check('empty is null', spotifyTrackId('') === null);

// ── 1. Exact-uri match survives a retitle (rename ≠ delete+add) ──
{
  const songs = [song('a', 'Completely Different Name', { spotifyUri: 'spotify:track:t1' })];
  const sets = [{ name: 'Set 1', songIds: ['a'] }];
  const d = diffPlaylistAgainstSets([track('Real Title', 'X', 't1')], sets, songs);
  check('uri match beats title mismatch',
    d.matches.length === 1 && d.matches[0].songId === 'a' && d.newTracks.length === 0);
}

// ── 2. Fuzzy title match tolerates punctuation/case ──
{
  const songs = [song('a', "should've been a cowboy")];
  const sets = [{ name: 'Set 1', songIds: ['a'] }];
  const d = diffPlaylistAgainstSets([track("Should've Been A Cowboy", 'Toby Keith')], sets, songs);
  check('fuzzy title match links the track', d.matches.length === 1 && d.matches[0].songId === 'a');
  check('nothing new, nothing unmatched', d.newTracks.length === 0 && d.unmatchedSongIds.length === 0);
}

// ── 3. Artist mismatch sinks a similar title (Bye-Bye ≠ Bye Bye Bye) ──
{
  const songs = [song('a', 'Bye-Bye', { artist: 'Jo Dee Messina' })];
  const sets = [{ name: 'Set 1', songIds: ['a'] }];
  const d = diffPlaylistAgainstSets([track('Bye Bye Bye', '*NSYNC')], sets, songs);
  check('artist mismatch keeps them apart',
    d.matches.length === 0 && d.newTracks.length === 1 && d.unmatchedSongIds[0] === 'a');
}

// ── 4. Re-order within a set follows playlist order ──
{
  const songs = [song('a', 'Alpha'), song('b', 'Beta'), song('c', 'Gamma')];
  const sets = [{ name: 'Set 1', songIds: ['a', 'b', 'c'] }];
  const tracks = [track('Gamma'), track('Alpha'), track('Beta')];
  const d = diffPlaylistAgainstSets(tracks, sets, songs);
  const out = applyPlaylistToSets(sets, d.matches, []);
  check('set re-ordered to playlist order', flat(out).join(',') === 'c,a,b');
  check('input sets not mutated', sets[0].songIds.join(',') === 'a,b,c');
}

// ── 5. Unmatched song holds its position through a re-order ──
{
  const songs = [song('a', 'Alpha'), song('x', 'Original Not On Spotify'), song('b', 'Beta')];
  const sets = [{ name: 'Set 1', songIds: ['a', 'x', 'b'] }];
  const tracks = [track('Beta'), track('Alpha')];
  const d = diffPlaylistAgainstSets(tracks, sets, songs);
  check('original reported unmatched', d.unmatchedSongIds.join(',') === 'x');
  const out = applyPlaylistToSets(sets, d.matches, []);
  check('unmatched song keeps its slot', flat(out).join(',') === 'b,x,a');
}

// ── 6. Removal only when confirmed ──
{
  const songs = [song('a', 'Alpha'), song('x', 'Dropped')];
  const sets = [{ name: 'Set 1', songIds: ['a', 'x'] }];
  const d = diffPlaylistAgainstSets([track('Alpha')], sets, songs);
  const kept = applyPlaylistToSets(sets, d.matches, [], []);
  check('unconfirmed removal keeps the song', flat(kept).join(',') === 'a,x');
  const removed = applyPlaylistToSets(sets, d.matches, [], ['x']);
  check('confirmed removal drops it', flat(removed).join(',') === 'a');
}

// ── 7. Insert lands after its preceding playlist neighbor ──
{
  const songs = [song('a', 'Alpha'), song('b', 'Beta')];
  const sets = [{ name: 'Set 1', songIds: ['a', 'b'] }];
  const tracks = [track('Alpha'), track('Newcomer'), track('Beta')];
  const d = diffPlaylistAgainstSets(tracks, sets, songs);
  check('newcomer is a new track', d.newTracks.length === 1 && d.newTracks[0].track.title === 'Newcomer');
  const inserts = d.newTracks.map((t) => ({ songId: 'n1', trackIndex: t.trackIndex }));
  const out = applyPlaylistToSets(sets, d.matches, inserts);
  check('insert placed between its neighbors', flat(out).join(',') === 'a,n1,b');
}

// ── 8. Consecutive inserts chain in playlist order; no anchor → top ──
{
  const songs = [song('a', 'Alpha')];
  const sets = [{ name: 'Set 1', songIds: ['a'] }];
  const tracks = [track('New One'), track('New Two'), track('Alpha')];
  const d = diffPlaylistAgainstSets(tracks, sets, songs);
  const ids = { 0: 'n1', 1: 'n2' };
  const inserts = d.newTracks.map((t) => ({ songId: ids[t.trackIndex], trackIndex: t.trackIndex }));
  const out = applyPlaylistToSets(sets, d.matches, inserts);
  check('anchorless run opens the set in order', flat(out).join(',') === 'n1,n2,a');
}

// ── 9. Multi-set: order applies within sets, membership never crosses ──
{
  const songs = [song('a', 'Alpha'), song('b', 'Beta'), song('c', 'Gamma'), song('d', 'Delta')];
  const sets = [
    { name: 'Set 1', songIds: ['b', 'a'] },
    { name: 'Set 2', songIds: ['d', 'c'] },
  ];
  const tracks = [track('Alpha'), track('Beta'), track('Gamma'), track('Delta')];
  const d = diffPlaylistAgainstSets(tracks, sets, songs);
  const out = applyPlaylistToSets(sets, d.matches, []);
  check('set 1 re-ordered in place', out[0].songIds.join(',') === 'a,b');
  check('set 2 re-ordered in place', out[1].songIds.join(',') === 'c,d');
}

// ── 10. Insert anchored into the right set ──
{
  const songs = [song('a', 'Alpha'), song('c', 'Gamma')];
  const sets = [
    { name: 'Set 1', songIds: ['a'] },
    { name: 'Set 2', songIds: ['c'] },
  ];
  const tracks = [track('Alpha'), track('Gamma'), track('Newcomer')];
  const d = diffPlaylistAgainstSets(tracks, sets, songs);
  const inserts = d.newTracks.map((t) => ({ songId: 'n1', trackIndex: t.trackIndex }));
  const out = applyPlaylistToSets(sets, d.matches, inserts);
  check('insert follows its neighbor into set 2',
    out[0].songIds.join(',') === 'a' && out[1].songIds.join(',') === 'c,n1');
}

// ── 11. Empty setlist: whole playlist inserts in order ──
{
  const sets = [{ name: 'Set 1', songIds: [] }];
  const tracks = [track('One'), track('Two'), track('Three')];
  const d = diffPlaylistAgainstSets(tracks, sets, []);
  check('all tracks are new', d.newTracks.length === 3);
  const ids = { 0: 'n1', 1: 'n2', 2: 'n3' };
  const inserts = d.newTracks.map((t) => ({ songId: ids[t.trackIndex], trackIndex: t.trackIndex }));
  const out = applyPlaylistToSets(sets, d.matches, inserts);
  check('playlist order preserved', flat(out).join(',') === 'n1,n2,n3');
}

// ── 12. Two same-titled songs can't claim one track twice ──
{
  const songs = [song('a', 'Crazy'), song('b', 'Crazy')];
  const sets = [{ name: 'Set 1', songIds: ['a', 'b'] }];
  const d = diffPlaylistAgainstSets([track('Crazy')], sets, songs);
  check('one claim per track',
    d.matches.length === 1 && d.matches[0].songId === 'a' && d.unmatchedSongIds.join(',') === 'b');
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nsetlist playlist-diff checks passed');
