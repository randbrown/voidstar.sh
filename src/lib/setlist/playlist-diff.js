// Diff a Spotify reference playlist against a setlist's sets — backs the
// setlist-edit page's "scrape playlist" button, which applies the playlist's
// current state (inserts, removals, re-ordering) to the setlist.
//
// Pure data-in/data-out (no store, no DOM) so it runs under node:
// scripts/check-setlist-playlist-diff.mjs covers it via `npm run check`.
// The caller (views.js) fetches the tracks, resolves new tracks to library
// songs, confirms removals with the user, and persists the result.

import { findBestMatch, findBestMatchWithArtist } from './match.js';

// Extract the bare track id from any Spotify track reference — a
// `spotify:track:<id>` URI or an open.spotify.com/track/<id> URL (with or
// without query junk). Returns null for playlists/albums/garbage.
export function spotifyTrackId(value) {
  if (!value) return null;
  const m = String(value).match(/(?:spotify:track:|open\.spotify\.com\/track\/)([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * Match a playlist's tracks against the songs currently on a setlist.
 *
 * Matching is two-pass: an exact Spotify track-id match first (a linked song
 * renamed in either place must not read as deleted+added), then the same
 * fuzzy title/artist matcher auto-link uses (threshold 0.7; a clear artist
 * mismatch sinks a candidate — see match.js). Each track claims at most one
 * setlist song and vice versa, greedily in setlist order.
 *
 * @param {Array<{title: string, artist?: string, spotifyUrl?: string}>} tracks
 *   playlist tracks, in playlist order
 * @param {Array<{name: string, songIds: string[]}>} sets - the setlist's sets
 * @param {Array<{id: string, title: string, artist?: string, spotifyUri?: string}>} songs
 *   records for the songs referenced by `sets` (missing ids are ignored)
 * @returns {{
 *   matches: Array<{songId: string, trackIndex: number, track: object}>,
 *   newTracks: Array<{trackIndex: number, track: object}>,
 *   unmatchedSongIds: string[],
 * }} newTracks = playlist tracks absent from the setlist (inserts);
 *   unmatchedSongIds = setlist songs absent from the playlist (removal
 *   candidates — the caller decides, they may be originals never on Spotify)
 */
export function diffPlaylistAgainstSets(tracks, sets, songs) {
  const songById = new Map(songs.map((s) => [s.id, s]));
  const setSongIds = [];
  const seen = new Set();
  for (const set of sets) {
    for (const id of set.songIds) {
      if (!seen.has(id) && songById.has(id)) { seen.add(id); setSongIds.push(id); }
    }
  }

  const trackBySpotifyId = new Map();
  tracks.forEach((t, i) => {
    const tid = spotifyTrackId(t.spotifyUrl);
    if (tid && !trackBySpotifyId.has(tid)) trackBySpotifyId.set(tid, i);
  });

  const songToTrack = new Map(); // songId -> trackIndex
  const claimedTracks = new Set(); // trackIndex

  // Pass 1: exact Spotify id.
  for (const id of setSongIds) {
    const tid = spotifyTrackId(songById.get(id).spotifyUri);
    if (!tid || !trackBySpotifyId.has(tid)) continue;
    const ti = trackBySpotifyId.get(tid);
    if (claimedTracks.has(ti)) continue;
    songToTrack.set(id, ti);
    claimedTracks.add(ti);
  }

  // Pass 2: fuzzy title/artist over the still-unclaimed tracks.
  for (const id of setSongIds) {
    if (songToTrack.has(id)) continue;
    const song = songById.get(id);
    const candidates = tracks
      .map((t, i) => ({ ...t, trackIndex: i }))
      .filter((t) => !claimedTracks.has(t.trackIndex));
    if (!candidates.length) break;
    const best = song.artist
      ? findBestMatchWithArtist(song.title, song.artist, candidates)
      : findBestMatch(song.title, candidates);
    if (!best) continue;
    songToTrack.set(id, best.match.trackIndex);
    claimedTracks.add(best.match.trackIndex);
  }

  const matches = [...songToTrack.entries()]
    .map(([songId, trackIndex]) => ({ songId, trackIndex, track: tracks[trackIndex] }))
    .sort((a, b) => a.trackIndex - b.trackIndex);
  const newTracks = tracks
    .map((track, trackIndex) => ({ track, trackIndex }))
    .filter((t) => !claimedTracks.has(t.trackIndex));
  const unmatchedSongIds = setSongIds.filter((id) => !songToTrack.has(id));
  return { matches, newTracks, unmatchedSongIds };
}

/**
 * Apply a playlist diff to a setlist's sets, returning NEW sets (input is
 * never mutated). Three steps, in order:
 *
 * 1. Removals — `removeIds` (the caller-confirmed subset of
 *    `unmatchedSongIds`) drop out of every set.
 * 2. Re-order — within each set, matched songs are re-sorted into playlist
 *    order; unmatched songs keep their exact positions (set boundaries are
 *    never crossed: a playlist is one flat list, and which set a song
 *    belongs to is the performer's call).
 * 3. Inserts — each new track lands right after the setlist song of the
 *    nearest preceding playlist track (chaining, so a run of consecutive new
 *    tracks stays in playlist order); a track with nothing placed before it
 *    opens the first set.
 *
 * @param {Array<{name: string, songIds: string[]}>} sets
 * @param {Array<{songId: string, trackIndex: number}>} matches - from diffPlaylistAgainstSets
 * @param {Array<{songId: string, trackIndex: number}>} inserts - newTracks resolved to song ids
 * @param {string[]} [removeIds]
 * @returns {Array<{name: string, songIds: string[]}>}
 */
export function applyPlaylistToSets(sets, matches, inserts, removeIds = []) {
  const removeSet = new Set(removeIds);
  const trackIndexOf = new Map(matches.map((m) => [m.songId, m.trackIndex]));
  const newSets = sets.map((s) => ({
    name: s.name,
    songIds: s.songIds.filter((id) => !removeSet.has(id)),
  }));

  for (const set of newSets) {
    const slots = [];
    const matchedIds = [];
    set.songIds.forEach((id, i) => {
      if (trackIndexOf.has(id)) { slots.push(i); matchedIds.push(id); }
    });
    matchedIds.sort((a, b) => trackIndexOf.get(a) - trackIndexOf.get(b));
    slots.forEach((slot, j) => { set.songIds[slot] = matchedIds[j]; });
  }

  const placed = new Map(); // trackIndex -> songId already in the sets
  for (const m of matches) {
    if (!removeSet.has(m.songId)) placed.set(m.trackIndex, m.songId);
  }
  const locate = (songId) => {
    for (let si = 0; si < newSets.length; si++) {
      const p = newSets[si].songIds.indexOf(songId);
      if (p >= 0) return { si, p };
    }
    return null;
  };
  const ordered = [...inserts].sort((a, b) => a.trackIndex - b.trackIndex);
  if (ordered.length && !newSets.length) newSets.push({ name: 'Set 1', songIds: [] });
  for (const ins of ordered) {
    let anchor = null;
    for (let t = ins.trackIndex - 1; t >= 0 && !anchor; t--) {
      const sid = placed.get(t);
      if (sid) anchor = locate(sid);
    }
    if (anchor) newSets[anchor.si].songIds.splice(anchor.p + 1, 0, ins.songId);
    else newSets[0].songIds.unshift(ins.songId);
    placed.set(ins.trackIndex, ins.songId);
  }
  return newSets;
}
