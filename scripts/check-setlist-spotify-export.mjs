// Node smoke test for the setlist → Spotify playlist export's pure half —
// which songs make the playlist, in what order, and what's reported as left
// out. Run via `npm run check`.
//
// spotify-export-core.js is pure (spotify.js parsing only), so we test the
// real module; the HTTP half (spotify-export.js) stays browser-only.

import {
  collectSetlistTrackUris,
  exportPlaylistName,
  exportPlaylistDescription,
} from '../src/lib/setlist/spotify-export-core.js';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}

const song = (id, title, extra = {}) => ({ id, title, artist: '', spotifyUri: '', ...extra });

// ── 1. Set order is playlist order, across sets ──
{
  const songs = [
    song('a', 'Alpha', { spotifyUri: 'spotify:track:t1' }),
    song('b', 'Beta', { spotifyUri: 'https://open.spotify.com/track/t2?si=xyz' }),
    song('c', 'Gamma', { spotifyUri: 'spotify:track:t3' }),
  ];
  const sl = { sets: [
    { name: 'Set 1', songIds: ['c', 'a'] },
    { name: 'Set 2', songIds: ['b'] },
  ] };
  const r = collectSetlistTrackUris(sl, songs);
  check('sets flatten in performance order',
    r.uris.join(',') === 'spotify:track:t3,spotify:track:t1,spotify:track:t2');
  check('URL and URI forms both normalize to track URIs', r.uris[2] === 'spotify:track:t2');
  check('nothing skipped, no duplicates', r.skipped.length === 0 && r.duplicates === 0);
}

// ── 2. Unlinked / unusable links are skipped and reported once ──
{
  const songs = [
    song('a', 'Linked', { spotifyUri: 'spotify:track:t1' }),
    song('b', 'No Link'),
    song('c', 'Playlist Link', { spotifyUri: 'https://open.spotify.com/playlist/p1' }),
  ];
  const sl = { sets: [{ name: 'Set 1', songIds: ['b', 'a', 'c', 'b'] }] };
  const r = collectSetlistTrackUris(sl, songs);
  check('only the linked song makes it', r.uris.length === 1 && r.uris[0] === 'spotify:track:t1');
  check('unlinked + playlist-linked are skipped', r.skipped.map((s) => s.songId).sort().join(',') === 'b,c');
  check('a song appearing twice is skipped once', r.skipped.filter((s) => s.songId === 'b').length === 1);
}

// ── 3. Duplicate tracks collapse to the first occurrence ──
{
  const songs = [
    song('a', 'Alpha', { spotifyUri: 'spotify:track:t1' }),
    song('b', 'Same Track Other Song', { spotifyUri: 'https://open.spotify.com/track/t1' }),
  ];
  const sl = { sets: [
    { name: 'Set 1', songIds: ['a'] },
    { name: 'Set 2', songIds: ['a', 'b'] }, // reprise + same-track song
  ] };
  const r = collectSetlistTrackUris(sl, songs);
  check('duplicates collapse', r.uris.length === 1 && r.duplicates === 2);
}

// ── 4. Dangling song ids are ignored, guesses are counted ──
{
  const songs = [song('a', 'Guessed', { spotifyUri: 'spotify:track:t1', spotifyGuess: true })];
  const sl = { sets: [{ name: 'Set 1', songIds: ['ghost', 'a'] }] };
  const r = collectSetlistTrackUris(sl, songs);
  check('dangling id is not skipped-listed', r.uris.length === 1 && r.skipped.length === 0);
  check('preliminary links are counted', r.guessCount === 1);
}

// ── 5. Empty / missing sets are a clean empty result ──
{
  const r = collectSetlistTrackUris({ sets: [] }, []);
  check('empty setlist → empty result', r.uris.length === 0 && r.skipped.length === 0);
  const r2 = collectSetlistTrackUris({}, []);
  check('missing sets tolerated', r2.uris.length === 0);
}

// ── 6. Playlist name and description ──
{
  check('name appends gig date',
    exportPlaylistName({ name: 'Moose Lodge', gigDate: '2026-06-14' }) === 'Moose Lodge · 2026-06-14');
  check('name keeps a date already in it',
    exportPlaylistName({ name: 'gig 2026-06-14', gigDate: '2026-06-14' }) === 'gig 2026-06-14');
  check('unnamed setlist gets a fallback name', exportPlaylistName({}) === 'setlist');
  const d = exportPlaylistDescription({ venue: 'Moose Lodge', gigDate: '2026-06-14' });
  check('description carries venue + date', d.includes('Moose Lodge') && d.includes('2026-06-14'));
  const long = exportPlaylistDescription({ venue: 'x'.repeat(400) });
  check('description clamps to Spotify\'s 300-char cap', long.length <= 300);
}

if (failures) {
  console.error(`\ncheck-setlist-spotify-export: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-setlist-spotify-export: all good');
