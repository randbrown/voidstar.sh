// Spotify embed and oEmbed helpers. No auth required.

const TRACK_RE = /open\.spotify\.com\/track\/([a-zA-Z0-9]+)/;
const PLAYLIST_RE = /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/;
const URI_TRACK_RE = /^spotify:track:([a-zA-Z0-9]+)$/;

export function parseSpotifyUrl(url) {
  if (!url) return null;
  let m = url.match(TRACK_RE);
  if (m) return { type: 'track', id: m[1] };
  m = url.match(PLAYLIST_RE);
  if (m) return { type: 'playlist', id: m[1] };
  m = url.match(URI_TRACK_RE);
  if (m) return { type: 'track', id: m[1] };
  return null;
}

export function getEmbedUrl(urlOrUri, compact = false) {
  const parsed = parseSpotifyUrl(urlOrUri);
  if (!parsed) return null;
  const h = compact ? '&compact=1' : '';
  return `https://open.spotify.com/embed/${parsed.type}/${parsed.id}?utm_source=generator&theme=0${h}`;
}

export function getSpotifyOpenUrl(urlOrUri) {
  const parsed = parseSpotifyUrl(urlOrUri);
  if (!parsed) return urlOrUri;
  return `https://open.spotify.com/${parsed.type}/${parsed.id}`;
}

export async function fetchOEmbed(url) {
  try {
    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetch(oembedUrl);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function renderSpotifyEmbed(container, urlOrUri, height = 80) {
  const embedUrl = getEmbedUrl(urlOrUri);
  if (!embedUrl) return;
  const parsed = parseSpotifyUrl(urlOrUri);
  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = embedUrl;
  iframe.width = '100%';
  iframe.height = String(height);
  iframe.frameBorder = '0';
  iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  iframe.loading = 'lazy';
  iframe.style.borderRadius = '8px';
  container.appendChild(iframe);

  if (parsed) {
    const link = document.createElement('a');
    link.href = `https://open.spotify.com/${parsed.type}/${parsed.id}`;
    link.textContent = 'open in spotify';
    link.style.cssText = 'display:block;text-align:center;font-size:0.75rem;color:var(--text-dim);margin-top:0.25rem;text-decoration:none;';
    container.appendChild(link);
  }
}
