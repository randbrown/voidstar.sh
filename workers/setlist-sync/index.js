// Setlist sync Worker — proxies Spotify Web API (client credentials) and
// Google Drive API (API key) so the browser-only setlist app can auto-link
// songs to Spotify tracks and Google Drive charts.
//
// Routes:
//   GET /spotify/playlist/:id       → playlist track list
//   GET /spotify/search?q=...       → search for a track
//   GET /spotify/search-batch       → search multiple songs (POST body: {titles:[]})
//   GET /drive/folder/:id           → folder file list (direct children only)
//   GET /drive/folder/:id/recursive → folder file list, walking subfolders too
//                                     (for community/shared chart-repo folders)
//   GET /drive/file/:id/meta        → scraped chart metadata (key/bpm/etc)
//   GET /drive/file/:id/image       → chart rendered as image bytes (for
//                                     offline caching in the browser; CORS
//                                     lets the client read + store the blob)
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

// An Error that carries an HTTP status so the router returns the *real* status
// (404, 401, 429, …) instead of collapsing everything to an opaque 500. A 500
// tells the client "the worker broke"; a 404 correctly says "playlist not
// accessible" — which the app can then explain instead of just logging a scary
// Internal Server Error.
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function getSpotifyToken(env, { force = false } = {}) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    throw httpError(500, 'SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not configured in the worker');
  }
  if (!force && _spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken;
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
    // 400/401/403 here means bad client credentials or a suspended/unagreed
    // Spotify app — not our fault, so surface it as 502 (bad upstream), not 500.
    throw httpError(502, `Spotify auth failed (${res.status}) — check SPOTIFY_CLIENT_ID/SECRET and that the Spotify app is active. ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  _spotifyToken = data.access_token;
  _spotifyExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _spotifyToken;
}

async function handleSpotifyPlaylist(playlistId, request, env) {
  let token = await getSpotifyToken(env);
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&market=US`;
  let retriedAuth = false;

  while (url) {
    let res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    // A cached token can go stale between isolate reuse and this request; on a
    // 401 force a fresh token once and retry before giving up.
    if (res.status === 401 && !retriedAuth) {
      retriedAuth = true;
      token = await getSpotifyToken(env, { force: true });
      res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hint = res.status === 404
        ? 'playlist not found, or not readable with client credentials (Spotify-owned editorial/algorithmic playlists can no longer be read this way — use a playlist you created)'
        : `Spotify API ${res.status}`;
      throw httpError(res.status, `Spotify playlist ${playlistId}: ${hint}. ${body.slice(0, 300)}`);
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
      fields: 'nextPageToken,files(id,name,mimeType,webViewLink,description)',
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
      const meta = extractChartMeta(f.name, f.description || '');
      files.push({
        title: parsed.title,
        artist: parsed.artist,
        webViewLink: f.webViewLink,
        mimeType: f.mimeType,
        name: f.name,
        ...meta,
      });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return corsResponse(JSON.stringify(files), 200, request, env, {
    'Cache-Control': 'public, max-age=300',
  });
}

// Recursive folder walk for community/shared chart-repo folders (e.g. a
// bandleader's master archive, organized artist/album/etc). Uses the same
// GOOGLE_API_KEY-based access model as handleDriveFolder — works for any
// link-shared folder, not just ones the caller owns. Capped to protect the
// Drive API and this worker's execution time; a truncated walk still returns
// whatever it found so far rather than failing outright.
const RECURSIVE_MAX_DEPTH = 4;
const RECURSIVE_MAX_FOLDERS = 200;
const RECURSIVE_MAX_FILES = 2000;

async function handleDriveFolderRecursive(rootFolderId, request, env) {
  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) return corsResponse(JSON.stringify({ error: 'GOOGLE_API_KEY not configured' }), 500, request, env);

  const files = [];
  let foldersVisited = 0;
  let truncated = false;
  const queue = [{ id: rootFolderId, depth: 0 }];

  while (queue.length && foldersVisited < RECURSIVE_MAX_FOLDERS && files.length < RECURSIVE_MAX_FILES) {
    const { id, depth } = queue.shift();
    foldersVisited++;
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: `'${id}' in parents and trashed = false`,
        key: apiKey,
        fields: 'nextPageToken,files(id,name,mimeType,webViewLink,description)',
        pageSize: '100',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
      if (!res.ok) { truncated = true; break; }

      const data = await res.json();
      for (const f of (data.files || [])) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          if (depth < RECURSIVE_MAX_DEPTH) queue.push({ id: f.id, depth: depth + 1 });
          continue;
        }
        const parsed = parseDriveFilename(f.name);
        const meta = extractChartMeta(f.name, f.description || '');
        files.push({
          title: parsed.title,
          artist: parsed.artist,
          webViewLink: f.webViewLink,
          mimeType: f.mimeType,
          name: f.name,
          ...meta,
        });
        if (files.length >= RECURSIVE_MAX_FILES) break;
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken && files.length < RECURSIVE_MAX_FILES);
  }
  if (queue.length) truncated = true;

  return corsResponse(JSON.stringify({ files, truncated, foldersVisited }), 200, request, env, {
    'Cache-Control': 'public, max-age=600',
  });
}

async function handleDriveFileMeta(fileId, request, env) {
  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) return corsResponse(JSON.stringify({ error: 'GOOGLE_API_KEY not configured' }), 500, request, env);

  const params = new URLSearchParams({
    key: apiKey,
    fields: 'id,name,mimeType,webViewLink,description,properties,appProperties',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?${params}`);
  if (!res.ok) throw new Error(`Drive API ${res.status}`);
  const file = await res.json();

  const parsed = parseDriveFilename(file.name);
  const meta = extractChartMeta(file.name, file.description || '');

  // Try to export as plain text for Google Docs to scrape more data
  let textContent = '';
  if (file.mimeType === 'application/vnd.google-apps.document') {
    try {
      const exportRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&key=${apiKey}`
      );
      if (exportRes.ok) textContent = await exportRes.text();
    } catch {}
  }

  const textMeta = textContent ? extractFromText(textContent) : {};

  return corsResponse(JSON.stringify({
    ...parsed,
    ...meta,
    ...textMeta,
    name: file.name,
    mimeType: file.mimeType,
    webViewLink: file.webViewLink,
    textContent: textContent.slice(0, 2000),
  }), 200, request, env);
}

// Return the chart as raw image bytes with our own CORS headers so the browser
// can fetch() + store the blob in IndexedDB for offline use. The <img>-based
// online rendering works cross-origin without CORS, but *reading* the bytes to
// cache them does not — hence this proxy.
//   - Real image files stream through as-is (best fidelity).
//   - PDFs / Google Docs are rasterized to a first-page image via Drive's
//     thumbnail renderer (multi-page charts only cache their first page; the
//     client surfaces that as a caveat).
// Access model matches the folder scan: files must be reachable by the API key
// (i.e. link-shared), which they already are if they showed up in a scan.
async function handleDriveFileImage(fileId, request, env) {
  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) return corsResponse(JSON.stringify({ error: 'GOOGLE_API_KEY not configured' }), 500, request, env);

  let mimeType = '';
  try {
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=mimeType&key=${apiKey}`
    );
    if (metaRes.ok) mimeType = (await metaRes.json()).mimeType || '';
  } catch {}

  let upstream;
  if (mimeType.startsWith('image/')) {
    upstream = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`
    );
  } else {
    // PDF, Google Doc, or unknown → let Drive rasterize the first page.
    upstream = await fetch(`https://drive.google.com/thumbnail?id=${fileId}&sz=w2000`);
  }

  if (!upstream || !upstream.ok) {
    return corsResponse(
      JSON.stringify({ error: `Drive image ${upstream ? upstream.status : 'fetch failed'}` }),
      upstream ? upstream.status : 502, request, env,
    );
  }

  const contentType = upstream.headers.get('Content-Type') || 'image/jpeg';
  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': corsOrigin(request, env),
      ...CORS_HEADERS,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

// Extract musical key, tempo, capo, time signature from filename and description
function extractChartMeta(filename, description) {
  const combined = `${filename} ${description}`;
  const meta = {};

  // Key detection: look for standalone key names (A, Bb, C#m, etc.)
  const keyMatch = combined.match(/\b(key\s*(?:of\s*)?[:=]?\s*)?([A-G][b#]?(?:m(?:aj|in)?|sus|dim|aug)?)\b/i);
  if (keyMatch && keyMatch[2]) {
    const k = keyMatch[2];
    if (k.length > 1 || /key/i.test(keyMatch[1] || '')) {
      meta.inferredKey = k.charAt(0).toUpperCase() + k.slice(1);
    }
  }

  // BPM/tempo
  const bpmMatch = combined.match(/(\d{2,3})\s*bpm/i);
  if (bpmMatch) meta.inferredBpm = parseInt(bpmMatch[1]);

  // Capo
  const capoMatch = combined.match(/capo\s*(\d{1,2})/i);
  if (capoMatch) meta.inferredCapo = parseInt(capoMatch[1]);

  // Time signature
  const timeMatch = combined.match(/\b([2-9])\/([248])\b/);
  if (timeMatch) meta.inferredTime = `${timeMatch[1]}/${timeMatch[2]}`;

  return meta;
}

// Extract musical info from exported text content of a Google Doc
function extractFromText(text) {
  const meta = {};
  const lines = text.split('\n').slice(0, 30);
  const header = lines.join('\n');

  // Key in upper left area — Nashville charts often put "Key: A" or just "A" or "G"
  const keyPatterns = [
    /key\s*(?:of\s*)?[:=]\s*([A-G][b#]?(?:m(?:aj|in)?)?)/i,
    /^([A-G][b#]?(?:m(?:aj|in)?)?)\s*$/m,
    /^\s*([A-G][b#]?(?:m(?:aj|in)?)?)\s*(?:major|minor)?\s*$/im,
  ];
  for (const re of keyPatterns) {
    const m = header.match(re);
    if (m) {
      meta.inferredKey = m[1].charAt(0).toUpperCase() + m[1].slice(1);
      break;
    }
  }

  // BPM
  const bpmMatch = header.match(/(?:tempo|bpm)\s*[:=]?\s*(\d{2,3})/i) ||
                    header.match(/(\d{2,3})\s*bpm/i);
  if (bpmMatch) meta.inferredBpm = parseInt(bpmMatch[1]);

  // Capo
  const capoMatch = header.match(/capo\s*[:=]?\s*(\d{1,2})/i);
  if (capoMatch) meta.inferredCapo = parseInt(capoMatch[1]);

  // Time signature
  const timeMatch = header.match(/(?:time\s*(?:sig)?|meter)\s*[:=]?\s*([2-9])\/([248])/i);
  if (timeMatch) meta.inferredTime = `${timeMatch[1]}/${timeMatch[2]}`;

  // Nashville Number patterns — try to detect if this is a NNS chart
  const nnsNumbers = header.match(/\b[1-7][b#]?\b/g);
  if (nnsNumbers && nnsNumbers.length >= 4) meta.isNashvilleChart = true;

  // Look for section markers
  const sections = [];
  const sectionRe = /\b(intro|verse|chorus|bridge|pre-chorus|outro|solo|interlude|tag|coda|turnaround|vamp)\b/gi;
  let sm;
  while ((sm = sectionRe.exec(text))) sections.push(sm[1].toLowerCase());
  if (sections.length) meta.sections = [...new Set(sections)];

  return meta;
}

function parseDriveFilename(name) {
  let clean = name.replace(/\.(pdf|docx?|txt|gdoc)$/i, '').trim();
  clean = clean.replace(/^\d+\.\s*/, '');
  // Split "Title - Artist" only on a dash flanked by whitespace. Requiring the
  // surrounding spaces keeps hyphenated or spelled-out titles intact — e.g.
  // "T-R-O-U-B-L-E - Travis Tritt" must parse to title "T-R-O-U-B-L-E", not "T"
  // (a bare /\s*[-–—]\s*/ splits on every internal hyphen, and a one-letter
  // title then fuzzy-matches nearly every song).
  const parts = clean.split(/\s+[-–—]\s+/);
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

      const driveRecursiveMatch = url.pathname.match(/^\/drive\/folder\/([a-zA-Z0-9_-]+)\/recursive$/);
      if (driveRecursiveMatch) {
        return await handleDriveFolderRecursive(driveRecursiveMatch[1], request, env);
      }

      const driveMatch = url.pathname.match(/^\/drive\/folder\/([a-zA-Z0-9_-]+)$/);
      if (driveMatch) {
        return await handleDriveFolder(driveMatch[1], request, env);
      }

      const driveImageMatch = url.pathname.match(/^\/drive\/file\/([a-zA-Z0-9_-]+)\/image$/);
      if (driveImageMatch) {
        return await handleDriveFileImage(driveImageMatch[1], request, env);
      }

      const driveFileMatch = url.pathname.match(/^\/drive\/file\/([a-zA-Z0-9_-]+)\/meta$/);
      if (driveFileMatch) {
        return await handleDriveFileMeta(driveFileMatch[1], request, env);
      }

      return corsResponse(JSON.stringify({ error: 'not found' }), 404, request, env);
    } catch (e) {
      return corsResponse(JSON.stringify({ error: e.message }), e.status || 500, request, env);
    }
  },
};
