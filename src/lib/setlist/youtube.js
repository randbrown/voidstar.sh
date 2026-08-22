// YouTube helpers for the setlist app: playlist import + "find on YouTube".
//
// YouTube is a listen-link ALTERNATE only (no primary slot, no auto-link
// matching — see media.js), but it earns two dedicated features because it's
// where a gig's reference playlists often live: importing a public YouTube
// playlist as a set of songs, and searching YouTube for an existing library
// song to attach a video + thumbnail. The worker does the page scraping (no
// keyless YouTube API); the pure parse/score helpers live in youtube-parse.js
// (node-tested) and are re-exported here so callers have one import site.

import { getSources, workerHeaders } from './sync.js';

export {
  youtubePlaylistId, isYoutubePlaylistUrl, youtubeVideoId, youtubeThumb,
  songHasYoutube, channelArtist, parseYouTubeTitle,
  YT_MIN_TITLE_SCORE, scoreYoutubeMatch, isConfidentYoutube,
} from './youtube-parse.js';

// ── Worker calls ──

// {title, tracks:[{title, url, videoId, thumbnail, durationSec, channel}],
//  total, truncated}. Throws with the worker's real reason.
export async function fetchYoutubePlaylist(url) {
  const { workerUrl } = getSources();
  if (!workerUrl) {
    throw new Error('importing a YouTube playlist needs the sync worker — set the worker URL in Settings');
  }
  const res = await fetch(`${workerUrl}/media/youtube/playlist?url=${encodeURIComponent(url)}`, {
    headers: workerHeaders(),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch {}
    if (res.status === 404 && (!detail || detail === 'not found')) {
      throw new Error('worker outdated — redeploy the setlist-sync worker to enable YouTube import');
    }
    throw new Error(detail || `YouTube playlist fetch failed (${res.status})`);
  }
  return await res.json();
}

// {results:[…], problems:[…]} — never throws (mirrors searchSpotifyTracks' "an
// empty result must say why" contract, so the bulk pass can report per song).
export async function searchYoutube(title, artist = '', { limit = 5 } = {}) {
  const { workerUrl } = getSources();
  if (!workerUrl) {
    return { results: [], problems: ['searching YouTube needs the sync worker URL (Settings)'] };
  }
  const q = [title, artist].filter(Boolean).join(' ').trim();
  if (!q) return { results: [], problems: ['this song has no title to search for'] };
  const n = Math.min(Math.max(limit, 1), 20);
  try {
    const res = await fetch(`${workerUrl}/media/youtube/search?q=${encodeURIComponent(q)}&limit=${n}`, {
      headers: workerHeaders(),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error || ''; } catch {}
      if (res.status === 404 && (!detail || detail === 'not found')) {
        return { results: [], problems: ['worker outdated — redeploy the setlist-sync worker to enable YouTube search'] };
      }
      return { results: [], problems: [detail || `YouTube search failed (${res.status})`] };
    }
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return { results, problems: results.length ? [] : ['YouTube returned no results'] };
  } catch (e) {
    return { results: [], problems: [`YouTube search failed: ${e.message}`] };
  }
}
