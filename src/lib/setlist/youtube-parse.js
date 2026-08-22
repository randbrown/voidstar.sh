// Pure YouTube helpers — URL/id parsing, video-title → title/artist splitting,
// and match scoring. Kept in its own module (imports only match.js) so it's
// node-testable (scripts/check-youtube-parse.mjs) exactly like playlist-diff.js.
// youtube.js re-exports all of these and adds the worker calls.

import { matchScore } from './match.js';

// ── URL / id helpers ──

// The playlist id out of a full URL (?list=…) or a bare, prefixed id
// (PL…/OL…/UU…/LL…/FL…/RD…). A bare 11-char *video* id must NOT read as a
// playlist, so bare ids require a known playlist prefix.
export function youtubePlaylistId(url) {
  const raw = (url || '').trim();
  try {
    const list = new URL(raw).searchParams.get('list');
    if (list && /^[A-Za-z0-9_-]+$/.test(list)) return list;
  } catch {}
  return /^(PL|OL|UU|LL|FL|RD|EC)[A-Za-z0-9_-]{6,}$/.test(raw) ? raw : null;
}

export function isYoutubePlaylistUrl(url) {
  return youtubePlaylistId(url) != null;
}

export function youtubeVideoId(url) {
  const m = (url || '').match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/,
  );
  return m ? m[1] : null;
}

export function youtubeThumb(videoId) {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';
}

// Does the song already carry a YouTube link (YouTube has no primary field, so
// this is really "any YouTube altLink")?
export function songHasYoutube(song) {
  const links = Array.isArray(song?.altLinks) ? song.altLinks : [];
  return links.some((l) => l.service === 'youtube' || youtubeVideoId(l.url));
}

// ── Title parsing ──
//
// A YouTube video title is marketing text ("Artist - Song (Official Music
// Video) [4K]"), not a clean pair. parseYouTubeTitle strips the noise, splits
// an "Artist - Title" form, and trusts the two channel shapes that ARE
// authoritative: an auto-generated "<Artist> - Topic" channel and an
// "<Artist>VEVO" channel both name the artist exactly, and their titles are
// then just the song.

const NOISE = /^(official\s*(music\s*)?(video|audio|visuali[sz]er)|official\s*lyric\s*video|lyric\s*video|lyrics?|visuali[sz]er|music\s*video|audio\s*only|audio|hd|hq|4k|8k|mv|m\/v|remaster(ed)?(\s*\d{4})?|explicit|full\s*audio|color\s*coded)$/i;

function stripNoiseBrackets(s) {
  return s.replace(/[([{]([^)\]}]*)[)\]}]/g, (full, inner) =>
    NOISE.test(inner.trim()) ? ' ' : full);
}

function tidy(s) {
  return (s || '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—|:]+/, '')
    .replace(/[\s\-–—|:]+$/, '')
    .trim();
}

// The artist a channel name asserts, or '' when it asserts none. "X - Topic"
// and "XVEVO" are authoritative; a plain channel is not treated as an artist.
export function channelArtist(channel) {
  const c = (channel || '').trim();
  if (!c) return '';
  const topic = c.match(/^(.*?)\s*-\s*Topic$/i);
  if (topic) return topic[1].trim();
  const vevo = c.match(/^(.*?)VEVO$/);
  if (vevo && vevo[1]) return vevo[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return '';
}

export function parseYouTubeTitle(rawTitle, channel = '') {
  const raw = (rawTitle || '').trim();
  const chan = (channel || '').trim();
  const cleaned = tidy(stripNoiseBrackets(raw)) || raw;
  const authoritativeArtist = channelArtist(chan);

  // Topic / VEVO: the channel names the artist. The title is usually just the
  // song, but some uploads still carry an "Artist - Song" form — when a dashed
  // part IS the (authoritative) artist, drop it and keep the rest as the title.
  // A dashed song name with no artist part (e.g. "T-R-O-U-B-L-E") is untouched.
  if (authoritativeArtist && /(-\s*Topic|VEVO)$/i.test(chan)) {
    const parts = cleaned.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      const titleParts = parts.filter((p) => matchScore(authoritativeArtist, p) < 0.8);
      if (titleParts.length && titleParts.length < parts.length) {
        return { title: tidy(titleParts.join(' - ')), artist: authoritativeArtist };
      }
    }
    return { title: cleaned, artist: authoritativeArtist };
  }

  // "Artist - Title" (dash flanked by spaces, like parseDriveFilename). Without
  // an authoritative channel signal there's no reliable way to know the order,
  // and left=artist is the overwhelming convention for music uploads.
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { title: tidy(parts.slice(1).join(' - ')), artist: tidy(parts[0]) };
  }

  // No dash — a bare song name. No artist unless the channel asserted one.
  return { title: cleaned, artist: authoritativeArtist };
}

// ── Match scoring — the "is this the right video?" bar ──

export const YT_MIN_TITLE_SCORE = 0.6;

export function scoreYoutubeMatch(song, result) {
  const parsed = parseYouTubeTitle(result.title || '', result.channel || '');
  // Score against the parsed song name (the main signal) and the raw title
  // (catches a bare-title upload) and take the better.
  const title = Math.max(
    matchScore(song.title || '', parsed.title || ''),
    matchScore(song.title || '', result.title || ''),
  );
  const artistCand = parsed.artist || channelArtist(result.channel || '');
  const artist = song.artist && artistCand ? matchScore(song.artist, artistCand) : null;
  return { title, artist, conflict: artist !== null && artist < 0.4 };
}

export function isConfidentYoutube(song, result) {
  const s = scoreYoutubeMatch(song, result);
  return s.title >= YT_MIN_TITLE_SCORE && !s.conflict;
}
