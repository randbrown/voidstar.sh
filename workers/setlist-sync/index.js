// Setlist sync Worker — proxies Spotify Web API (client credentials) and
// Google Drive API (API key) so the browser-only setlist app can auto-link
// songs to Spotify tracks and Google Drive charts.
//
// Routes:
//   GET /spotify/playlist/:id       → playlist track list
//   GET /spotify/search?q=...       → search for a track
//   GET /spotify/search-batch       → search multiple songs (POST body: {titles:[]})
//   GET /drive/folder/:id           → folder file list
//   GET /health                     → ok

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function corsOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || 'https://voidstar.sh';
  if (origin === allowed || origin === 'http://localhost:4321' || origin === 'http://localhost:3000') {
    return origin;
  }
  return allowed;
}

function corsResponse(body, status, request, env, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin(request, env),
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

let _spotifyToken = null;
let _spotifyExpiry = 0;

async function getSpotifyToken(env) {
  if (_spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken;
  const creds = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Spotify token ${res.status}: ${body}`);
  }
  const data = await res.json();
  _spotifyToken = data.access_token;
  _spotifyExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _spotifyToken;
}

async function handleSpotifyPlaylist(playlistId, request, env) {
  const token = await getSpotifyToken(env);
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&market=US`;

  while (url) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Spotify API ${res.status}: ${body}`);
    }
    const data = await res.json();
    for (const item of (data.items || [])) {
      const t = item.track;
      if (!t) continue;
      tracks.push({
        title: t.name,
        artist: t.artists?.map(a => a.name).join(', ') || '',
        spotifyUrl: t.external_urls?.spotify || `spotify:track:${t.uri?.split(':').pop()}`,
      });
    }
    url = data.next || null;
  }

  return corsResponse(JSON.stringify(tracks), 200, request, env, {
    'Cache-Control': 'public, max-age=300',
  });
}

async function searchSpotifyTrack(token, query) {
  const params = new URLSearchParams({
    q: query,
    type: 'track',
    limit: '1',
    market: 'US',
  });
  const res = await fetch(`https://api.spotify.com/v1/search?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const t = data.tracks?.items?.[0];
  if (!t) return null;
  return {
    title: t.name,
    artist: t.artists?.map(a => a.name).join(', ') || '',
    spotifyUrl: t.external_urls?.spotify || '',
  };
}

async function handleSpotifySearch(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q');
  if (!q) return corsResponse(JSON.stringify({ error: 'missing q param' }), 400, request, env);

  const token = await getSpotifyToken(env);
  const result = await searchSpotifyTrack(token, q);
  return corsResponse(JSON.stringify(result), result ? 200 : 404, request, env);
}

async function handleSpotifySearchBatch(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.titles?.length) {
    return corsResponse(JSON.stringify({ error: 'POST {titles: ["song1", "song2"]}' }), 400, request, env);
  }

  const token = await getSpotifyToken(env);
  const results = {};
  for (const title of body.titles.slice(0, 100)) {
    results[title] = await searchSpotifyTrack(token, title);
  }

  return corsResponse(JSON.stringify(results), 200, request, env, {
    'Cache-Control': 'public, max-age=300',
  });
}

async function handleDriveFolder(folderId, request, env) {
  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) return corsResponse(JSON.stringify({ error: 'GOOGLE_API_KEY not configured' }), 500, request, env);

  const files = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      key: apiKey,
      fields: 'nextPageToken,files(id,name,mimeType,webViewLink)',
      pageSize: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive API ${res.status}: ${body}`);
    }
    const data = await res.json();

    for (const f of (data.files || [])) {
      const parsed = parseDriveFilename(f.name);
      files.push({
        title: parsed.title,
        artist: parsed.artist,
        webViewLink: f.webViewLink,
        mimeType: f.mimeType,
        name: f.name,
      });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return corsResponse(JSON.stringify(files), 200, request, env, {
    'Cache-Control': 'public, max-age=300',
  });
}

function parseDriveFilename(name) {
  let clean = name.replace(/\.(pdf|docx?|txt|gdoc)$/i, '').trim();
  clean = clean.replace(/^\d+\.\s*/, '');
  const parts = clean.split(/\s*[-–—]\s*/);
  if (parts.length >= 2) {
    return { title: parts[0].trim(), artist: parts.slice(1).join(' - ').trim() };
  }
  return { title: clean, artist: '' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin(request, env),
          ...CORS_HEADERS,
        },
      });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('setlist-sync: ok', { status: 200 });
    }

    try {
      if (url.pathname === '/spotify/search-batch' && request.method === 'POST') {
        return await handleSpotifySearchBatch(request, env);
      }

      if (url.pathname === '/spotify/search') {
        return await handleSpotifySearch(request, env);
      }

      const spotifyMatch = url.pathname.match(/^\/spotify\/playlist\/([a-zA-Z0-9]+)$/);
      if (spotifyMatch) {
        return await handleSpotifyPlaylist(spotifyMatch[1], request, env);
      }

      const driveMatch = url.pathname.match(/^\/drive\/folder\/([a-zA-Z0-9_-]+)$/);
      if (driveMatch) {
        return await handleDriveFolder(driveMatch[1], request, env);
      }

      return corsResponse(JSON.stringify({ error: 'not found' }), 404, request, env);
    } catch (e) {
      return corsResponse(JSON.stringify({ error: e.message }), 500, request, env);
    }
  },
};
