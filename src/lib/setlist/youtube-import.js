// Import a public YouTube playlist into a setlist as a new set.
//
// One gig's reference material is often two YouTube playlists (the motivating
// case), so each import APPENDS a set named after the playlist rather than
// replacing anything — run it twice and you get two sets in one setlist. Songs
// are matched to the library by exact title (reused) or created; every song
// gets the video as a YouTube listen-link alternate and the video thumbnail as
// its photoUrl (fill-empty). The playlist is recorded on setlist.playlists so
// it can be seen and re-imported later.

import * as store from './store.js';
import { fetchYoutubePlaylist, parseYouTubeTitle, youtubePlaylistId } from './youtube.js';
import { altLinksOf, makeAltLink, songHasLink } from './media.js';

// Attach a YouTube video to a song, fill-empty: add the video as a listen-link
// alternate (unless the song already carries that URL) and set photoUrl from
// the thumbnail if it has none. Pure mutation of `song` — the CALLER saves.
// Returns {linked, photoed} so passes can count what they did.
export function applyYoutubeToSong(song, video) {
  let linked = false;
  let photoed = false;
  if (video.url && !songHasLink(song, video.url)) {
    song.altLinks = [...altLinksOf(song), makeAltLink(video.url, '')];
    linked = true;
  }
  if (!song.photoUrl && video.thumbnail) {
    song.photoUrl = video.thumbnail;
    photoed = true;
  }
  return { linked, photoed };
}

// A set name unique within the setlist (appends " (2)", " (3)" on collision).
function uniqueSetName(setlist, base) {
  const name = (base || 'YouTube playlist').trim() || 'YouTube playlist';
  const taken = new Set((setlist.sets || []).map((s) => s.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Import the playlist at `url` into `setlist`, appending one set. Mutates and
// saves `setlist` and the songs. Throws only when the playlist can't be read;
// otherwise returns a report for the UI.
export async function importYoutubePlaylist(setlist, url, onProgress) {
  const { title: plTitle, tracks, truncated } = await fetchYoutubePlaylist(url);
  if (!tracks?.length) throw new Error('the playlist came back empty — check it is public and not empty');

  const setName = uniqueSetName(setlist, plTitle || 'YouTube playlist');
  const songIds = [];
  const seen = new Set(); // dedupe repeats WITHIN this playlist
  let created = 0;
  let linked = 0;
  let photoed = 0;

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const parsed = parseYouTubeTitle(t.title || '', t.channel || '');
    const title = parsed.title || t.title || '';
    if (!title) continue;

    let song = await store.findSongByTitle(title);
    let changed = false;
    if (!song) {
      song = store.createSong(title, parsed.artist || '');
      changed = true;
      created++;
    } else if (parsed.artist && !song.artist) {
      song.artist = parsed.artist;
      changed = true;
    }
    const r = applyYoutubeToSong(song, t);
    if (r.linked) { changed = true; linked++; }
    if (r.photoed) { changed = true; photoed++; }
    if (changed) await store.putSong(song);

    if (!seen.has(song.id)) { seen.add(song.id); songIds.push(song.id); }
    onProgress?.({ done: i + 1, total: tracks.length, title });
  }

  setlist.sets.push({ name: setName, songIds });
  const existing = Array.isArray(setlist.playlists) ? setlist.playlists : [];
  setlist.playlists = [...existing, {
    id: crypto.randomUUID(),
    service: 'youtube',
    url,
    playlistId: youtubePlaylistId(url) || '',
    title: plTitle || '',
    setName,
    addedAt: Date.now(),
  }];
  await store.putSetlist(setlist);

  return { setName, title: plTitle || '', total: tracks.length, added: songIds.length, created, linked, photoed, truncated };
}
