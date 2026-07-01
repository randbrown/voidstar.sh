// Setlist sync Worker — proxies Spotify Web API (client credentials) and
// Google Drive API (API key) so the browser-only setlist app can auto-link
// songs to Spotify tracks and Google Drive charts, and scours the public web
// for shared chart files / chord data when the user's own folders come up dry.
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
//   GET /web/chart-search?title=&artist=
//                                   → web-search for shared chart files (NNS
//                                     chart collections on Drive/Dropbox links)
//   GET /web/chart-data?title=&artist=
//                                   → chords + song structure scraped from the
//                                     web, converted to Nashville numbers (for
//                                     drafting a chart doc)
//   GET /health                     → ok
//
// Optional env for /web/* search (falls back to keyless DuckDuckGo HTML):
//   GOOGLE_CSE_ID          — Programmable Search Engine id (reuses GOOGLE_API_KEY)
//   BRAVE_SEARCH_API_KEY   — Brave Search API subscription token

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
        : res.status === 403
        ? 'playlist not readable with client credentials — make sure it is set to Public (not private/collaborative) and is owned by your account, not a Spotify-owned editorial/algorithmic playlist'
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

async function walkDriveFolder(rootFolderId, apiKey, {
  maxDepth = RECURSIVE_MAX_DEPTH,
  maxFolders = RECURSIVE_MAX_FOLDERS,
  maxFiles = RECURSIVE_MAX_FILES,
} = {}) {
  const files = [];
  let foldersVisited = 0;
  let truncated = false;
  const queue = [{ id: rootFolderId, depth: 0 }];

  while (queue.length && foldersVisited < maxFolders && files.length < maxFiles) {
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
          if (depth < maxDepth) queue.push({ id: f.id, depth: depth + 1 });
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
        if (files.length >= maxFiles) break;
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken && files.length < maxFiles);
  }
  if (queue.length) truncated = true;

  return { files, truncated, foldersVisited };
}

async function handleDriveFolderRecursive(rootFolderId, request, env) {
  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) return corsResponse(JSON.stringify({ error: 'GOOGLE_API_KEY not configured' }), 500, request, env);

  const result = await walkDriveFolder(rootFolderId, apiKey);
  return corsResponse(JSON.stringify(result), 200, request, env, {
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

// ══ Web chart search + chord scraping ══════════════════════════════════════
// Everything below serves the two /web/* routes: finding shared chart files
// in the wild (Drive/Dropbox links from NNS chart collections musicians pass
// around), and scraping chords + song structure to draft a number chart.

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Minimal HTML-entity decode — enough for search-result titles and the
// attribute-escaped JSON blob Ultimate Guitar embeds in its pages.
function decodeEntities(s) {
  return (s || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// ── Fuzzy title matching ──
// Duplicated from src/lib/setlist/match.js (like parseDriveFilename above) —
// this worker is a single standalone file with no build step.

const NORM_ARTICLES = /^(the|a|an)\s+/i;
const NORM_PARENS = /\s*\([^)]*\)\s*/g;
const NORM_FEAT = /\s*(feat\.?|ft\.?|featuring)\s+.*/i;
const NORM_PUNCT = /[''"".,!?&\-–—:;/\\]/g;
const NORM_SPACE = /\s{2,}/g;

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(NORM_PARENS, ' ')
    .replace(NORM_FEAT, '')
    .replace(NORM_ARTICLES, '')
    .replace(NORM_PUNCT, ' ')
    .replace(NORM_SPACE, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

function matchScore(titleA, titleB) {
  const a = normalizeTitle(titleA);
  const b = normalizeTitle(titleB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 4 && shorter.length / longer.length >= 0.5 &&
      (a.includes(b) || b.includes(a))) {
    return 0.9;
  }
  const maxLen = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);
  return Math.max(0, 1 - dist / maxLen);
}

// Title score with a small artist-agreement bonus — same weighting as the
// client's findBestMatchWithArtist, applied to a single candidate.
function scoreCandidate(songTitle, songArtist, candTitle, candArtist) {
  const titleScore = matchScore(songTitle, candTitle);
  let bonus = 0;
  if (songArtist && candArtist) {
    const artistScore = matchScore(songArtist, candArtist);
    if (artistScore >= 0.7) bonus = 0.15 * artistScore;
  }
  return Math.min(1, Math.round((titleScore + bonus) * 100) / 100);
}

// ── Web search providers ──
// Provider chain: Google Programmable Search (if GOOGLE_CSE_ID is set) →
// Brave (if BRAVE_SEARCH_API_KEY is set) → keyless DuckDuckGo HTML scrape.
// Each returns [{title, url, snippet}]; a failing provider falls through to
// the next so a lapsed key degrades instead of breaking the route.

async function searchGoogleCse(env, query, count) {
  const params = new URLSearchParams({
    key: env.GOOGLE_API_KEY,
    cx: env.GOOGLE_CSE_ID,
    q: query,
    num: String(Math.min(count, 10)),
  });
  const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  if (!res.ok) throw new Error(`CSE ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(i => ({ title: i.title || '', url: i.link || '', snippet: i.snippet || '' }));
}

async function searchBrave(env, query, count) {
  const params = new URLSearchParams({ q: query, count: String(Math.min(count, 20)) });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { 'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: r.description || '' }));
}

// External (non-API) sites get a hard timeout so a hung fetch can't stall
// the whole search request.
const SCRAPE_TIMEOUT_MS = 10000;

async function searchDuckDuckGo(query, count) {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < count) {
      let link = decodeEntities(m[1]);
      // DDG wraps results in a redirect: //duckduckgo.com/l/?uddg=<encoded>
      const uddg = link.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { link = decodeURIComponent(uddg[1]); } catch { continue; } }
      if (!/^https?:\/\//.test(link)) continue;
      const title = decodeEntities(m[2].replace(/<[^>]*>/g, '')).trim();
      results.push({ title, url: link, snippet: '' });
    }
    return results;
  } catch {
    return [];
  }
}

async function searchWeb(env, query, count = 10) {
  if (env.GOOGLE_CSE_ID && env.GOOGLE_API_KEY) {
    try { return { provider: 'google-cse', results: await searchGoogleCse(env, query, count) }; } catch {}
  }
  if (env.BRAVE_SEARCH_API_KEY) {
    try { return { provider: 'brave', results: await searchBrave(env, query, count) }; } catch {}
  }
  return { provider: 'duckduckgo', results: await searchDuckDuckGo(query, count) };
}

// ── Candidate link extraction ──

function extractDriveRef(url) {
  let m = url.match(/(?:drive|docs)\.google\.com\/(?:file|document|presentation|spreadsheets)\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return { kind: 'file', id: m[1] };
  m = url.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]{10,})/);
  if (m) return { kind: 'folder', id: m[1] };
  m = url.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([a-zA-Z0-9_-]{10,})/);
  if (m) return { kind: 'file', id: m[1] };
  return null;
}

function isDropboxUrl(url) {
  return /https?:\/\/(?:www\.)?dropbox\.com\/(?:s|sh|scl\/fi|scl\/fo)\//.test(url);
}

// dl=0 opens Dropbox's viewer (what we want for a chart link).
function normalizeDropboxUrl(url) {
  return url.replace(/([?&])dl=1\b/, '$1dl=0').split('#')[0];
}

// GET /web/chart-search?title=...&artist=...
// Tier 3 of the chart-fallback ladder: web-search for the chart in shared
// collections (NNS chart repos passed around as Drive/Dropbox links). Drive
// hits are verified through the Drive API — reachable with our API key means
// link-shared, so the app's scrape/offline-cache will work on them too.
// Shared *folders* surfaced by the search get a bounded recursive walk, since
// collections usually index the folder, not the individual song file.
const WEB_SEARCH_FOLDER_WALKS = 2;
const WEB_CANDIDATE_MIN_SCORE = 0.55;
const WEB_CANDIDATE_LIMIT = 8;

async function handleWebChartSearch(request, env) {
  const url = new URL(request.url);
  const title = (url.searchParams.get('title') || '').trim();
  const artist = (url.searchParams.get('artist') || '').trim();
  if (!title) return corsResponse(JSON.stringify({ error: 'missing title param' }), 400, request, env);

  const label = artist ? `"${title}" ${artist}` : `"${title}"`;
  const queries = [
    `${label} nashville number chart (site:drive.google.com OR site:docs.google.com OR site:dropbox.com)`,
    `${label} "nashville number" chart`,
    `${label} chord chart pdf`,
  ];

  const seen = new Set();
  const driveFiles = [];
  const driveFolders = [];
  const dropboxLinks = [];
  const warnings = [];
  let provider = '';

  for (const query of queries) {
    const { provider: p, results } = await searchWeb(env, query, 10);
    provider = provider || p;
    for (const r of results) {
      const ref = extractDriveRef(r.url);
      if (ref) {
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
        (ref.kind === 'file' ? driveFiles : driveFolders).push({ id: ref.id, resultTitle: r.title });
      } else if (isDropboxUrl(r.url)) {
        const clean = normalizeDropboxUrl(r.url);
        if (seen.has(clean)) continue;
        seen.add(clean);
        dropboxLinks.push({ url: clean, resultTitle: r.title });
      }
    }
    // Strong leads already in hand — skip the broader (noisier) queries.
    if (driveFiles.length + driveFolders.length >= 4) break;
  }

  const candidates = [];
  const apiKey = env.GOOGLE_API_KEY;

  // Drive file hits: verify via the API key and score on the real filename.
  for (const f of driveFiles.slice(0, 6)) {
    if (!apiKey) break;
    try {
      const params = new URLSearchParams({ key: apiKey, fields: 'id,name,mimeType,webViewLink,description' });
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?${params}`);
      if (!res.ok) continue; // not link-shared (or gone) — unusable for us
      const file = await res.json();
      const parsed = parseDriveFilename(file.name);
      const meta = extractChartMeta(file.name, file.description || '');
      candidates.push({
        url: file.webViewLink,
        name: file.name,
        title: parsed.title,
        artist: parsed.artist,
        mimeType: file.mimeType,
        source: 'drive',
        verified: true,
        score: scoreCandidate(title, artist, parsed.title, parsed.artist),
        ...meta,
      });
    } catch {}
  }

  // Shared-folder hits: walk the collection (tight caps — this runs inside
  // one search request, unlike the user-configured community folders).
  for (const folder of driveFolders.slice(0, WEB_SEARCH_FOLDER_WALKS)) {
    if (!apiKey) break;
    try {
      const { files, truncated } = await walkDriveFolder(folder.id, apiKey, {
        maxDepth: 3, maxFolders: 20, maxFiles: 600,
      });
      if (truncated) warnings.push(`Shared folder "${folder.resultTitle}" was only partially scanned`);
      for (const file of files) {
        const score = scoreCandidate(title, artist, file.title, file.artist);
        if (score < WEB_CANDIDATE_MIN_SCORE) continue;
        candidates.push({ ...file, url: file.webViewLink, source: 'drive-folder', verified: true, score });
      }
    } catch {}
  }

  // Dropbox links can't be verified or listed without OAuth — score them on
  // the search-result title (usually the shared filename) and mark unverified.
  for (const d of dropboxLinks.slice(0, 4)) {
    const cleanTitle = d.resultTitle.replace(/\s*[-–—|]\s*Dropbox\s*$/i, '').trim();
    const parsed = parseDriveFilename(cleanTitle);
    candidates.push({
      url: d.url,
      name: cleanTitle,
      title: parsed.title,
      artist: parsed.artist,
      source: 'dropbox',
      verified: false,
      score: scoreCandidate(title, artist, parsed.title, parsed.artist),
    });
  }

  const ranked = candidates
    .filter(c => c.score >= WEB_CANDIDATE_MIN_SCORE)
    .sort((a, b) => (b.verified - a.verified) || (b.score - a.score))
    .slice(0, WEB_CANDIDATE_LIMIT);

  return corsResponse(JSON.stringify({ candidates: ranked, provider, warnings }), 200, request, env, {
    'Cache-Control': 'public, max-age=3600',
  });
}

// ── Chord scraping (Ultimate Guitar) ──
// UG pages embed their full state as attribute-escaped JSON in a div.js-store
// data-content attribute; both the search page and tab pages use it.

function extractJsStore(html) {
  const m = html.match(/class="js-store"[^>]*data-content="([^"]+)"/);
  if (!m) return null;
  try { return JSON.parse(decodeEntities(m[1])); } catch { return null; }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return await res.text();
}

// UG's own search, filtered to community "Chords" tabs, ranked by how well
// the song/artist match plus a small community-rating nudge.
async function findUgTab(title, artist) {
  try {
    const params = new URLSearchParams({
      search_type: 'title',
      value: artist ? `${title} ${artist}` : title,
    });
    const html = await fetchHtml(`https://www.ultimate-guitar.com/search.php?${params}`);
    if (!html) return null;
    const results = extractJsStore(html)?.store?.page?.data?.results || [];
    let best = null;
    let bestScore = 0;
    for (const t of results) {
      if (t.type !== 'Chords' || !t.tab_url || t.marketing_type) continue;
      const score = scoreCandidate(title, artist, t.song_name || '', t.artist_name || '')
        + Math.min(t.votes || 0, 1000) / 1000 * 0.08
        + (t.rating || 0) / 5 * 0.04;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return bestScore >= 0.7 ? best.tab_url : null;
  } catch {
    return null;
  }
}

// Fallback when UG's search page won't cooperate: find a UG chords URL
// through the general web-search chain instead.
async function findUgTabViaWeb(env, title, artist) {
  const { results } = await searchWeb(env, `${title} ${artist} chords site:tabs.ultimate-guitar.com`, 10);
  const chords = results.find(r => /tabs\.ultimate-guitar\.com\/tab\/.+chords/.test(r.url));
  return (chords || results.find(r => /tabs\.ultimate-guitar\.com\/tab\//.test(r.url)))?.url || null;
}

async function fetchUgTab(tabUrl) {
  try {
    const html = await fetchHtml(tabUrl);
    if (!html) return null;
    const data = extractJsStore(html)?.store?.page?.data;
    if (!data) return null;
    const tab = data.tab || {};
    const view = data.tab_view || {};
    return {
      content: view.wiki_tab?.content || '',
      tonality: tab.tonality_name || view.meta?.tonality || '',
      capo: parseInt(view.meta?.capo, 10) || 0,
      songName: tab.song_name || '',
      artistName: tab.artist_name || '',
    };
  } catch {
    return null;
  }
}

// ── Chord-sheet parsing ──
// UG content marks chords as [ch]Am7[/ch] and sections as bare [Verse 1]
// lines; [tab]...[/tab] wraps chord-over-lyric blocks.

const CHORD_TOKEN_RE = /^(?:[A-G][b#]?(?:m|maj|min|dim|aug|sus|add|M|\+|°|o)?[0-9]*(?:sus[24]?|add[0-9]+|[b#][0-9]+)*(?:\/[A-G][b#]?)?|N\.?C\.?)$/;

function parseChordSheet(content) {
  const text = (content || '').replace(/\r/g, '').replace(/\[\/?tab\]/g, '');
  const hasChMarkers = /\[ch\]/.test(text);
  const sections = [];
  let current = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const header = line.match(/^\[(?!\/?(?:ch|tab)\b)([^\]]{1,40})\]$/);
    if (header) {
      current = { name: header[1].trim(), chordLines: [] };
      sections.push(current);
      continue;
    }
    let chords = [];
    if (hasChMarkers) {
      const re = /\[ch\]([^[\]]+)\[\/ch\]/g;
      let m;
      while ((m = re.exec(line))) chords.push(m[1].trim());
    } else {
      // No [ch] markers (rare raw tabs): treat lines made only of chord
      // tokens as chord lines.
      const tokens = line.split(/\s+/).filter(Boolean);
      if (tokens.length && tokens.every(t => CHORD_TOKEN_RE.test(t))) chords = tokens;
    }
    if (!chords.length) continue;
    if (!current) {
      current = { name: '', chordLines: [] };
      sections.push(current);
    }
    current.chordLines.push(chords);
  }
  return sections.filter(s => s.chordLines.length);
}

// ── Nashville number conversion ──

const NOTE_PC = {
  'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'Fb': 4, 'E#': 5,
  'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10,
  'B': 11, 'Cb': 11,
};
// Interval from the tonic → NNS degree, numbered off the major scale (the
// working convention even for minor-key charts: minor tonic is 1-, and the
// borrowed chords come out as b3 / b6 / b7).
const DEGREE_BY_INTERVAL = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'];

function parseChordSymbol(sym) {
  const s = (sym || '').trim();
  if (/^N\.?C\.?$/i.test(s)) return { nc: true };
  const m = s.match(/^([A-G][b#]?)([^/]*)(?:\/([A-G][b#]?))?$/);
  if (!m) return null;
  return { root: m[1], quality: m[2] || '', bass: m[3] || '' };
}

function parseKeyName(key) {
  const m = (key || '').trim().match(/^([A-G][b#]?)\s*(m|min|minor)?\b/i);
  if (!m) return null;
  const root = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  if (NOTE_PC[root] == null) return null;
  return { tonicPc: NOTE_PC[root], minor: !!m[2], name: root + (m[2] ? 'm' : '') };
}

// "m7" → "-7", "dim" → "°", "maj7"/"sus4"/"add9"… pass through untouched.
function nashvilleQuality(quality) {
  let q = (quality || '').trim();
  let prefix = '';
  if (/^(?:min|mi|m)(?!aj)/.test(q)) { prefix = '-'; q = q.replace(/^(?:min|mi|m)/, ''); }
  else if (/^(?:dim|°|o(?![a-z]))/.test(q)) { prefix = '°'; q = q.replace(/^(?:dim|°|o)/, ''); }
  else if (/^(?:aug|\+)/.test(q)) { prefix = '+'; q = q.replace(/^(?:aug|\+)/, ''); }
  return prefix + q;
}

function chordToNashville(sym, key) {
  const c = parseChordSymbol(sym);
  if (!c) return sym;
  if (c.nc) return 'NC';
  const pc = NOTE_PC[c.root];
  if (pc == null || !key) return sym;
  let out = DEGREE_BY_INTERVAL[(pc - key.tonicPc + 12) % 12] + nashvilleQuality(c.quality);
  const bassPc = NOTE_PC[c.bass];
  if (bassPc != null) out += '/' + DEGREE_BY_INTERVAL[(bassPc - key.tonicPc + 12) % 12];
  return out;
}

// Infer the key from the chords themselves when the source doesn't state a
// tonality: score all 12 major keys by (weighted) diatonic membership, with
// extra weight on the first and last chords, then call it relative minor if
// the song starts and ends on that minor chord.
const MAJOR_DIATONIC = { 0: 'maj', 2: 'min', 4: 'min', 5: 'maj', 7: 'maj', 9: 'min', 11: 'dim' };
const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function chordQualityClass(quality) {
  const q = nashvilleQuality(quality);
  if (q.startsWith('-')) return 'min';
  if (q.startsWith('°')) return 'dim';
  return 'maj';
}

function inferKey(sections) {
  const chords = [];
  for (const s of sections) for (const line of s.chordLines) chords.push(...line);
  const parsed = chords.map(parseChordSymbol).filter(c => c && !c.nc);
  if (!parsed.length) return '';

  const weighted = parsed.map((c, i) => ({
    pc: NOTE_PC[c.root],
    cls: chordQualityClass(c.quality),
    weight: 1 + (i === 0 ? 2 : 0) + (i === parsed.length - 1 ? 1 : 0),
  })).filter(c => c.pc != null);

  let bestTonic = 0;
  let bestScore = -1;
  for (let tonic = 0; tonic < 12; tonic++) {
    let score = 0;
    for (const c of weighted) {
      const interval = (c.pc - tonic + 12) % 12;
      const expected = MAJOR_DIATONIC[interval];
      if (expected === c.cls) score += c.weight;
      else if (expected) score += c.weight * 0.3;          // right root, odd quality
      else if (interval === 10 && c.cls === 'maj') score += c.weight * 0.5; // bVII — country staple
    }
    if (score > bestScore) { bestScore = score; bestTonic = tonic; }
  }

  const first = weighted[0];
  const last = weighted[weighted.length - 1];
  const relMinorPc = (bestTonic + 9) % 12;
  if (first && last && first.cls === 'min' && first.pc === relMinorPc && last.pc === relMinorPc) {
    return `${KEY_NAMES[relMinorPc]}m`;
  }
  return KEY_NAMES[bestTonic];
}

// GET /web/chart-data?title=...&artist=...
// Fuel for "create chart doc": chords + song structure from the web,
// converted to Nashville numbers. Returns {found:false} (not an error) when
// no usable source turns up, so the client can fall back to a template.
async function handleWebChartData(request, env) {
  const url = new URL(request.url);
  const title = (url.searchParams.get('title') || '').trim();
  const artist = (url.searchParams.get('artist') || '').trim();
  if (!title) return corsResponse(JSON.stringify({ error: 'missing title param' }), 400, request, env);

  let tabUrl = await findUgTab(title, artist);
  if (!tabUrl) tabUrl = await findUgTabViaWeb(env, title, artist);
  if (!tabUrl) {
    return corsResponse(JSON.stringify({ found: false, reason: 'no chord source found' }), 200, request, env);
  }

  const tab = await fetchUgTab(tabUrl);
  const sections = tab ? parseChordSheet(tab.content) : [];
  if (!sections.length) {
    return corsResponse(JSON.stringify({ found: false, reason: 'chord source unreadable', sourceUrl: tabUrl }), 200, request, env);
  }

  const key = parseKeyName(tab.tonality)?.name || inferKey(sections);
  const parsedKey = parseKeyName(key);
  const nnsSections = sections.map(s => ({
    name: s.name,
    lines: s.chordLines.map(line => line.map(chord => ({
      chord,
      nns: chordToNashville(chord, parsedKey),
    }))),
  }));

  return corsResponse(JSON.stringify({
    found: true,
    source: 'ultimate-guitar',
    sourceUrl: tabUrl,
    title: tab.songName || title,
    artist: tab.artistName || artist,
    key,
    keyInferred: !parseKeyName(tab.tonality),
    capo: tab.capo || 0,
    sections: nnsSections,
  }), 200, request, env, {
    'Cache-Control': 'public, max-age=86400',
  });
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
      if (url.pathname === '/web/chart-search') {
        return await handleWebChartSearch(request, env);
      }

      if (url.pathname === '/web/chart-data') {
        return await handleWebChartData(request, env);
      }

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
