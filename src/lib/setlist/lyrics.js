// Lyrics via LRCLIB (lrclib.net) — a keyless, CORS-open lyrics database, so
// this runs straight from the browser with no worker involved. /api/get does
// an exact-ish signature lookup (title + artist, optionally duration);
// /api/search fuzzy-matches, and we rank its hits with the same title/artist
// scoring the rest of the app uses. Synced lyrics come back as LRC text
// ("[mm:ss.xx] line"), which the song page can highlight against the
// timecode timer.

import { matchScore } from './match.js';

const API = 'https://lrclib.net/api';
const SEARCH_MIN_SCORE = 0.7;

// Returns {plain, synced, trackName, artistName} or null. `synced` is raw
// LRC text ('' when LRCLIB has only plain lyrics for the track).
export async function fetchLyrics(title, artist, durationSec = 0) {
  if (!title) return null;

  // Exact lookup first — precise when the artist (and ideally duration,
  // which LRCLIB uses to pick between versions) is known.
  if (artist) {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    if (durationSec) params.set('duration', String(durationSec));
    try {
      const res = await fetch(`${API}/get?${params}`);
      if (res.ok) {
        const hit = await res.json();
        if (hit?.plainLyrics || hit?.syncedLyrics) return normalizeHit(hit);
      }
    } catch {}
  }

  // Fuzzy search fallback, ranked by title match + artist agreement.
  try {
    const params = new URLSearchParams({ track_name: title });
    if (artist) params.set('artist_name', artist);
    const res = await fetch(`${API}/search?${params}`);
    if (!res.ok) return null;
    const hits = await res.json();
    let best = null;
    let bestScore = 0;
    for (const h of hits || []) {
      if (h.instrumental) continue;
      if (!h.plainLyrics && !h.syncedLyrics) continue;
      let score = matchScore(title, h.trackName || '');
      if (artist && h.artistName) {
        const artistScore = matchScore(artist, h.artistName);
        if (artistScore >= 0.7) score += 0.15 * artistScore;
      }
      if (score > bestScore) { bestScore = score; best = h; }
    }
    return best && bestScore >= SEARCH_MIN_SCORE ? normalizeHit(best) : null;
  } catch {
    return null;
  }
}

function normalizeHit(hit) {
  const synced = (hit.syncedLyrics || '').trim();
  let plain = (hit.plainLyrics || '').trim();
  // Some tracks are synced-only; derive plain text so song.lyrics is always
  // filled whenever anything was found.
  if (!plain && synced) {
    plain = parseSyncedLyrics(synced).map((l) => l.text).join('\n').trim();
  }
  return {
    plain,
    synced,
    trackName: hit.trackName || '',
    artistName: hit.artistName || '',
  };
}

// LRC text → [{t: seconds, text}], in time order. Lines without a timestamp
// (headers, credits) are skipped.
export function parseSyncedLyrics(lrc) {
  const out = [];
  for (const line of (lrc || '').split('\n')) {
    const m = line.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
    if (!m) continue;
    out.push({ t: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text: m[3].trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}
