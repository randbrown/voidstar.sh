// Lyrics via LRCLIB (lrclib.net) — a keyless, CORS-open lyrics database, so
// this runs straight from the browser with no worker involved. /api/get does
// an exact-ish signature lookup (title + artist, optionally duration);
// /api/search fuzzy-matches, and we rank its hits with the same title/artist
// scoring the rest of the app uses. Synced lyrics come back as LRC text
// ("[mm:ss.xx] line"), which the song page can highlight against the
// timecode timer.
//
// Auto-fill (fetchLyrics) takes only a confident match. When it still picks
// the wrong song, the song page's lyrics block offers "wrong — pick another"
// (searchLyrics → a ranked candidate list, excluding the current LRCLIB id)
// and hand edit/paste — see docs/setlist-app.md.

import { matchScore } from './match.js';

const API = 'https://lrclib.net/api';
const SEARCH_MIN_SCORE = 0.7;

// Score one LRCLIB hit against what we know about the song. Title match is
// the base; a known artist that AGREES adds a little, one that clearly
// DISAGREES subtracts enough to sink a same-title cover/unrelated song below
// the auto-accept bar (the classic wrong-lyrics case: a common title, a
// different artist). Duration within a few seconds is a tie-breaker between
// versions.
export function scoreLyricsHit(hit, title, artist = '', durationSec = 0) {
  let score = matchScore(title, hit.trackName || '');
  if (artist && hit.artistName) {
    const a = matchScore(artist, hit.artistName);
    if (a >= 0.7) score += 0.15 * a;
    else if (a < 0.5) score -= 0.35;
  }
  if (durationSec && hit.duration) {
    const diff = Math.abs(durationSec - hit.duration);
    if (diff <= 3) score += 0.05;
    else if (diff > 30) score -= 0.05;
  }
  return score;
}

// Ranked LRCLIB candidates for a song, best first — the "pick another"
// list. Each is normalizeHit()'s shape plus {score}. `excludeIds` drops
// hits already rejected (the current, wrong lyrics). Instrumentals and
// lyric-less entries are skipped. Network errors → [].
export async function searchLyrics(title, artist = '', { durationSec = 0, excludeIds = [], limit = 12 } = {}) {
  if (!title) return [];
  const skip = new Set(excludeIds.filter((x) => x != null).map(String));
  const byId = new Map();
  const add = (h) => {
    if (!h || h.instrumental) return;
    if (!h.plainLyrics && !h.syncedLyrics) return;
    const key = String(h.id ?? `${h.trackName}|${h.artistName}|${h.duration}`);
    if (skip.has(key) || byId.has(key)) return;
    byId.set(key, { ...normalizeHit(h), score: scoreLyricsHit(h, title, artist, durationSec) });
  };
  const queries = [new URLSearchParams({ track_name: title })];
  if (artist) {
    queries[0].set('artist_name', artist);
    // Title-only too: catches the right song when the stored artist is
    // spelled differently ("The Band" vs "Band, The") or is itself wrong.
    queries.push(new URLSearchParams({ track_name: title }));
  }
  await Promise.all(queries.map(async (params) => {
    try {
      const res = await fetch(`${API}/search?${params}`);
      if (!res.ok) return;
      for (const h of (await res.json()) || []) add(h);
    } catch {}
  }));
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// Free-text LRCLIB search ("q" matches title, artist, or album) — the
// picker's search box, for when the stored title/artist are themselves off.
export async function searchLyricsQuery(q, { title = '', artist = '', durationSec = 0, excludeIds = [], limit = 12 } = {}) {
  const query = (q || '').trim();
  if (!query) return [];
  const skip = new Set(excludeIds.filter((x) => x != null).map(String));
  try {
    const res = await fetch(`${API}/search?${new URLSearchParams({ q: query })}`);
    if (!res.ok) return [];
    const out = [];
    for (const h of (await res.json()) || []) {
      if (h.instrumental || (!h.plainLyrics && !h.syncedLyrics)) continue;
      if (h.id != null && skip.has(String(h.id))) continue;
      out.push({ ...normalizeHit(h), score: title ? scoreLyricsHit(h, title, artist, durationSec) : 0 });
    }
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

// Returns {id, plain, synced, trackName, artistName, albumName, durationSec}
// or null. `synced` is raw LRC text ('' when LRCLIB has only plain lyrics).
// `excludeIds` = LRCLIB entries the user already rejected as the wrong song
// (song.lyricsRejectedIds), so a later "fetch info" never re-applies them.
export async function fetchLyrics(title, artist, durationSec = 0, { excludeIds = [] } = {}) {
  if (!title) return null;
  const rejected = new Set(excludeIds.filter((x) => x != null).map(String));

  // Exact lookup first — precise when the artist (and ideally duration,
  // which LRCLIB uses to pick between versions) is known.
  if (artist) {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    if (durationSec) params.set('duration', String(durationSec));
    try {
      const res = await fetch(`${API}/get?${params}`);
      if (res.ok) {
        const hit = await res.json();
        if (!hit?.instrumental && (hit?.plainLyrics || hit?.syncedLyrics) &&
            !(hit.id != null && rejected.has(String(hit.id)))) return normalizeHit(hit);
      }
    } catch {}
  }

  // Fuzzy search fallback, ranked by title match + artist/duration agreement.
  const ranked = await searchLyrics(title, artist, { durationSec, excludeIds, limit: 1 });
  return ranked[0] && ranked[0].score >= SEARCH_MIN_SCORE ? stripScore(ranked[0]) : null;
}

function stripScore({ score, ...rest }) { return rest; }

function normalizeHit(hit) {
  const synced = (hit.syncedLyrics || '').trim();
  let plain = (hit.plainLyrics || '').trim();
  // Some tracks are synced-only; derive plain text so song.lyrics is always
  // filled whenever anything was found.
  if (!plain && synced) {
    plain = parseSyncedLyrics(synced).map((l) => l.text).join('\n').trim();
  }
  return {
    id: hit.id ?? null,
    plain,
    synced,
    trackName: hit.trackName || '',
    artistName: hit.artistName || '',
    albumName: hit.albumName || '',
    durationSec: Math.round(hit.duration || 0),
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
