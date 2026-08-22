// Bandcamp + SoundCloud embed helpers — the non-Spotify listening links.
// SoundCloud's widget player takes the plain track URL, so it needs no
// lookup. Bandcamp's EmbeddedPlayer needs numeric track/album ids that only
// exist in the page markup: auto-link stores the ready-made embed URL in
// song.bandcampEmbedUrl (from the worker's /media/bandcamp scrape), and a
// hand-pasted link gets resolved lazily on the song page via
// resolveBandcampEmbed (sync.js), falling back to a plain link offline.

import { parseSpotifyUrl } from './spotify.js';

const BANDCAMP_EMBED_HOST = 'https://bandcamp.com/EmbeddedPlayer/';

export function isBandcampUrl(url) {
  return /^https?:\/\/[^/]+\.bandcamp\.com\//i.test(url || '');
}

export function isSoundcloudUrl(url) {
  return /^https?:\/\/([a-z-]+\.)?soundcloud\.com\//i.test(url || '');
}

// ── Extra listen links (song.altLinks) ──
//
// A song has one primary link per service (spotifyUri / bandcampUrl /
// soundcloudUrl — what auto-link fills and what the song page embeds by
// default). `song.altLinks` holds every OTHER recording of the same song the
// performer wants at hand: the live cut, the single vs. the album version, a
// different artist's version to steal a steel part from, a YouTube video.
// Shape: [{id, url, label, service, embedUrl?, addedAt}] — lazy (usually
// absent), fill-protected like altCharts.

// Which service a pasted URL belongs to. 'spotify' | 'bandcamp' |
// 'soundcloud' | 'youtube' | 'other' — only the first three have a primary
// slot on the song, so only those can be promoted.
export function linkService(url) {
  const u = (url || '').trim();
  if (/^spotify:track:/i.test(u) || /^https?:\/\/open\.spotify\.com\//i.test(u)) return 'spotify';
  if (isBandcampUrl(u)) return 'bandcamp';
  if (isSoundcloudUrl(u)) return 'soundcloud';
  if (/^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i.test(u)) return 'youtube';
  return 'other';
}

export const LINK_SERVICE_LABELS = {
  spotify: 'spotify',
  bandcamp: 'bandcamp',
  soundcloud: 'soundcloud',
  youtube: 'youtube',
  other: 'link',
};

// The song field a service's PRIMARY link lives in, or null for services with
// no primary slot (they can only ever be alternates).
export const LINK_PRIMARY_FIELD = {
  spotify: 'spotifyUri',
  bandcamp: 'bandcampUrl',
  soundcloud: 'soundcloudUrl',
};

// Always an array — the field is lazy, so old records and fresh songs have no
// `altLinks` at all.
export function altLinksOf(song) {
  return Array.isArray(song?.altLinks) ? song.altLinks : [];
}

export function makeAltLink(url, label = '') {
  const service = linkService(url);
  return {
    id: crypto.randomUUID(),
    url: url.trim(),
    label: (label || '').trim().slice(0, 60),
    service,
    addedAt: Date.now(),
  };
}

// Is this URL already on the song (as a primary or an alternate)? Keeps the
// pickers from stacking the same track twice. Spotify links compare by track
// id — the same track travels as both `spotify:track:…` and an
// open.spotify.com URL.
export function songHasLink(song, url) {
  const norm = (u) => {
    const id = parseSpotifyUrl(u || '');
    if (id?.type === 'track') return `spotify:${id.id}`;
    return (u || '').trim().replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
  };
  const target = norm(url);
  if (!target) return false;
  return [song.spotifyUri, song.bandcampUrl, song.soundcloudUrl, ...altLinksOf(song).map(l => l.url)]
    .some(u => norm(u) === target);
}

export function soundcloudEmbedUrl(trackUrl) {
  const params = new URLSearchParams({
    url: trackUrl,
    color: '#ff5500',
    auto_play: 'false',
    hide_related: 'true',
    show_comments: 'false',
    show_teaser: 'false',
  });
  return `https://w.soundcloud.com/player/?${params}`;
}

// Shared iframe + "open in …" link, matching renderSpotifyEmbed's layout so
// the three services read as the same feature on the song page.
function mountEmbedFrame(container, src, height, openUrl, openLabel) {
  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.width = '100%';
  iframe.height = String(height);
  iframe.frameBorder = '0';
  iframe.allow = 'autoplay; encrypted-media; fullscreen';
  iframe.loading = 'lazy';
  iframe.style.borderRadius = '8px';
  container.appendChild(iframe);
  if (openUrl) {
    const link = document.createElement('a');
    link.href = openUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = openLabel;
    link.style.cssText = 'display:block;text-align:center;font-size:0.75rem;color:var(--text-dim);margin-top:0.25rem;text-decoration:none;';
    container.appendChild(link);
  }
}

// YouTube exists here only as an ALTERNATE listen link (no primary slot, no
// auto-link matching): live versions and lesson videos live there, and the
// no-cookie player embeds them with nothing to resolve.
export function youtubeEmbedUrl(url) {
  const u = (url || '').trim();
  const m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : null;
}

export function renderYoutubeEmbed(container, url) {
  const src = youtubeEmbedUrl(url);
  if (!src) return;
  mountEmbedFrame(container, src, 180, url, 'open in youtube');
}

export function renderSoundcloudEmbed(container, trackUrl) {
  if (!isSoundcloudUrl(trackUrl)) return;
  mountEmbedFrame(container, soundcloudEmbedUrl(trackUrl), 152, trackUrl, 'open in soundcloud');
}

// `resolveEmbed` is async (the worker scrape) and may come up empty; the page
// URL link renders immediately so the song page never blocks on it, and a
// resolved embed swaps in when (and if) it lands. `onResolved` lets the
// caller persist the found embed URL onto the song so the lookup runs once.
// ── Song photo (the performer's visual recall cue) ──
//
// song.photoUrl is either a remote https URL (a YouTube thumbnail from import /
// "find on YouTube", or a pasted image link — like artworkUrl) OR a compact
// data: URL from a hand-uploaded photo. Uploads are downscaled here so the
// embedded image is small enough to ride the Drive backup and render offline
// on stage; remote thumbnails stay URLs (cheap, browser-cached).

export const PHOTO_MAX_DIM = 480;

// Downscale a chosen image File to a small JPEG data URL. Rejects if the file
// isn't a decodable image.
export async function fileToPhotoDataUrl(file, maxDim = PHOTO_MAX_DIM) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.82);
}

// Only https and data:image URLs are safe to drop into an <img src> (a Drive
// backup could carry anything; never render javascript:/http: photos).
export function isDisplayablePhoto(url) {
  return typeof url === 'string' && (/^https:\/\//i.test(url) || /^data:image\//i.test(url));
}

export function renderBandcampEmbed(container, song, resolveEmbed, onResolved) {
  const pageUrl = song.bandcampUrl;
  if (!isBandcampUrl(pageUrl)) return;
  if (song.bandcampEmbedUrl?.startsWith(BANDCAMP_EMBED_HOST)) {
    mountEmbedFrame(container, song.bandcampEmbedUrl, 42, pageUrl, 'open in bandcamp');
    return;
  }
  container.innerHTML = '';
  const link = document.createElement('a');
  link.href = pageUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '▶ open in bandcamp';
  link.style.cssText = 'display:block;text-align:center;font-size:0.85rem;color:var(--text-dim);padding:0.5rem;text-decoration:none;';
  container.appendChild(link);
  resolveEmbed?.(pageUrl).then((embedUrl) => {
    if (!embedUrl || !container.isConnected) return;
    song.bandcampEmbedUrl = embedUrl;
    onResolved?.(song);
    mountEmbedFrame(container, embedUrl, 42, pageUrl, 'open in bandcamp');
  }).catch(() => {});
}
