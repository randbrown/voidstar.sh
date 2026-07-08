// Bandcamp + SoundCloud embed helpers — the non-Spotify listening links.
// SoundCloud's widget player takes the plain track URL, so it needs no
// lookup. Bandcamp's EmbeddedPlayer needs numeric track/album ids that only
// exist in the page markup: auto-link stores the ready-made embed URL in
// song.bandcampEmbedUrl (from the worker's /media/bandcamp scrape), and a
// hand-pasted link gets resolved lazily on the song page via
// resolveBandcampEmbed (sync.js), falling back to a plain link offline.

const BANDCAMP_EMBED_HOST = 'https://bandcamp.com/EmbeddedPlayer/';

export function isBandcampUrl(url) {
  return /^https?:\/\/[^/]+\.bandcamp\.com\//i.test(url || '');
}

export function isSoundcloudUrl(url) {
  return /^https?:\/\/([a-z-]+\.)?soundcloud\.com\//i.test(url || '');
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

export function renderSoundcloudEmbed(container, trackUrl) {
  if (!isSoundcloudUrl(trackUrl)) return;
  mountEmbedFrame(container, soundcloudEmbedUrl(trackUrl), 152, trackUrl, 'open in soundcloud');
}

// `resolveEmbed` is async (the worker scrape) and may come up empty; the page
// URL link renders immediately so the song page never blocks on it, and a
// resolved embed swaps in when (and if) it lands. `onResolved` lets the
// caller persist the found embed URL onto the song so the lookup runs once.
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
