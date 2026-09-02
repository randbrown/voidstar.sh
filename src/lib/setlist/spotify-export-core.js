// Pure logic for building a Spotify playlist from a setlist — which songs
// make it in, in what order, and what gets reported as left out. Kept free
// of auth/store/DOM so it's node-testable
// (scripts/check-setlist-spotify-export.mjs, via `npm run check`); the API
// calls live in spotify-export.js.

import { parseSpotifyUrl } from './spotify.js';

// Walk the sets in performance order and collect one `spotify:track:` URI per
// linked song. Per-setlist overrides never touch spotifyUri (it always lives
// on the base song), so plain songs are enough — no mergedSong needed.
//
// Returns:
//   uris       — ordered track URIs, first occurrence wins
//   skipped    — [{songId, title}] songs with no usable track link (playlist
//                links or empty fields don't count), each listed once
//   duplicates — later re-occurrences of a track already in the list (a song
//                on two sets, or two songs linked to the same track)
//   guessCount — included tracks whose link is still a preliminary best-guess
export function collectSetlistTrackUris(setlist, songs) {
  const songById = new Map((songs || []).map((s) => [s.id, s]));
  const uris = [];
  const seen = new Set();
  const skipped = [];
  const skippedIds = new Set();
  let duplicates = 0;
  let guessCount = 0;

  for (const set of setlist?.sets || []) {
    for (const songId of set.songIds || []) {
      const song = songById.get(songId);
      if (!song) continue; // dangling id — the setlist views' problem, not the export's
      const parsed = song.spotifyUri ? parseSpotifyUrl(song.spotifyUri) : null;
      if (!parsed || parsed.type !== 'track') {
        if (!skippedIds.has(songId)) {
          skippedIds.add(songId);
          skipped.push({ songId, title: song.title || '' });
        }
        continue;
      }
      if (seen.has(parsed.id)) { duplicates++; continue; }
      seen.add(parsed.id);
      if (song.spotifyGuess) guessCount++;
      uris.push(`spotify:track:${parsed.id}`);
    }
  }
  return { uris, skipped, duplicates, guessCount };
}

// Playlist name: the setlist's name, with the gig date appended when it isn't
// already part of the name (many setlists are named after the date).
export function exportPlaylistName(setlist) {
  const name = (setlist?.name || '').trim() || 'setlist';
  const date = (setlist?.gigDate || '').trim();
  return date && !name.includes(date) ? `${name} · ${date}` : name;
}

// Spotify caps playlist descriptions at 300 chars.
export function exportPlaylistDescription(setlist) {
  const bits = ['Built from a voidstar setlist'];
  if (setlist?.venue) bits.push(setlist.venue);
  if (setlist?.gigDate) bits.push(setlist.gigDate);
  return bits.join(' · ').slice(0, 300);
}
