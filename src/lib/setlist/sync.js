// Sync orchestration — matches songs against Spotify playlists and Google Drive
// folders, and (per-song) against shared chart files found on the open web.
// Uses the setlist-sync Cloudflare Worker for API access when configured,
// falls back to client-side matching with manually provided URLs.
// Cross-references Spotify and Drive data for better disambiguation.

import { findBestMatch, findBestMatchWithArtist, matchScore, parseDriveFilename } from './match.js';
import * as store from './store.js';
import { parseSpotifyUrl } from './spotify.js';
import { getSpotifyUserToken, isSpotifyConnected } from './spotify-auth.js';

const SOURCES_KEY = 'voidstar.setlist.sources';

export function getSources() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(SOURCES_KEY)); } catch { stored = null; }
  // Merge over defaults so sources saved by older versions (missing newer
  // fields like driveFolders) don't crash callers that read e.g. .length.
  const s = { ...defaultSources(), ...(stored || {}) };
  if (!Array.isArray(s.driveFolders)) s.driveFolders = [];
  if (!Array.isArray(s.communityFolders)) s.communityFolders = [];
  if (!Array.isArray(s.driveCharts)) s.driveCharts = [];
  if (typeof s.workerUrl !== 'string') s.workerUrl = '';
  if (typeof s.workerToken !== 'string') s.workerToken = '';
  // Routes are exact-match on the worker — a trailing slash in the setting
  // would make every path `//spotify/...` and 404 (which the client reads
  // as "worker outdated").
  s.workerUrl = s.workerUrl.trim().replace(/\/+$/, '');
  s.workerToken = s.workerToken.trim();
  return s;
}

function defaultSources() {
  return {
    workerUrl: '',
    workerToken: '',
    driveFolders: [],
    communityFolders: [],
    driveCharts: [],
  };
}

// Headers for a worker request. When the user has set an access token (Settings
// → sync worker; rides the Drive backup so every device shares it), it's sent
// as X-Worker-Token so a token-gated worker accepts the call. Merges any extra
// headers a POST already needs (e.g. Content-Type).
export function workerHeaders(extra = {}) {
  const token = getSources().workerToken;
  return token ? { ...extra, 'X-Worker-Token': token } : { ...extra };
}

export function setSources(sources) {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
}

// The streaming services a setlist can carry a reference link for. Spotify
// takes a playlist URL; Bandcamp takes a band page (or /music, /album/…) —
// the whole point is bands like nightjar whose catalog lives there, not on
// Spotify; SoundCloud takes a profile or /sets/ playlist. Auto-link matches
// song titles against each service's track list independently and fills that
// service's song field, so one song can carry links on several services.
const MEDIA_SERVICES = [
  { key: 'spotify', label: 'Spotify', setlistField: 'spotifyUrl', songField: 'spotifyUri' },
  { key: 'bandcamp', label: 'Bandcamp', setlistField: 'bandcampUrl', songField: 'bandcampUrl' },
  { key: 'soundcloud', label: 'SoundCloud', setlistField: 'soundcloudUrl', songField: 'soundcloudUrl' },
];

// {service → {perSong: Map<songId, url[]>, all: url[]}} — each song's own
// setlists' reference URLs, plus the full pool (per-song scoping: a song is
// matched against the references of the setlists it actually appears in;
// the rest of the pool is only a near-exact-title fallback).
function buildServiceRefs(setlists) {
  const refs = {};
  for (const svc of MEDIA_SERVICES) refs[svc.key] = { perSong: new Map(), all: [] };
  for (const sl of setlists) {
    for (const svc of MEDIA_SERVICES) {
      const url = sl[svc.setlistField];
      if (!url) continue;
      const r = refs[svc.key];
      if (!r.all.includes(url)) r.all.push(url);
      for (const set of sl.sets) {
        for (const id of set.songIds) {
          const urls = r.perSong.get(id) || [];
          if (!urls.includes(url)) urls.push(url);
          r.perSong.set(id, urls);
        }
      }
    }
  }
  return refs;
}

export async function syncSetlist(setlistId, onProgress) {
  const sl = await store.getSetlist(setlistId);
  if (!sl) throw new Error('Setlist not found');

  const allSongIds = sl.sets.flatMap(s => s.songIds);
  const songs = (await Promise.all(allSongIds.map(id => store.getSong(id)))).filter(Boolean);
  return runSync(songs, buildServiceRefs([sl]), onProgress);
}

export async function syncAll(onProgress) {
  const songs = await store.getAllSongs();
  const setlists = await store.getAllSetlists();
  return runSync(songs, buildServiceRefs(setlists), onProgress);
}

// A cross-playlist match (a playlist from a setlist the song is NOT in) has
// weak provenance, so it must be near-exact on the title. 0.9-scoring
// containment matches are exactly how "Bye-Bye" (Jo Dee Messina) used to
// grab "Bye Bye Bye" (*NSYNC) out of an unrelated playlist.
const CROSS_PLAYLIST_MIN_SCORE = 0.95;

// `refs` is buildServiceRefs' shape: {service → {perSong, all}}.
async function runSync(songs, refs, onProgress) {
  const sources = getSources();
  const results = { total: songs.length, done: 0, drive: { matched: 0, skipped: 0, errors: [] } };
  for (const svc of MEDIA_SERVICES) results[svc.key] = { matched: 0, skipped: 0, errors: [] };

  // Matching is REFERENCE-ONLY for every service: when a playlist/page can't
  // be read, its songs stay unlinked and the error says why. (An old fallback
  // ran a global title-only Spotify search here — which loved to link the
  // most popular same-titled track, karaoke covers and all, and read as data
  // corruption. The song page's "spotify search" button is the explicit,
  // manual escape hatch for songs not on any reference playlist.)
  const trackLink = (t) => t.spotifyUrl || t.url || '';
  const dedupeTracks = (tracks) => {
    const seen = new Set();
    return tracks.filter(t => trackLink(t) && !seen.has(trackLink(t)) && seen.add(trackLink(t)));
  };

  // Fetch each service's reference URLs once.
  const pools = {};
  for (const svc of MEDIA_SERVICES) {
    const r = results[svc.key];
    const tracksByUrl = new Map();
    for (const url of refs[svc.key].all) {
      try {
        tracksByUrl.set(url, svc.key === 'spotify'
          ? await fetchSpotifyTracks(sources.workerUrl, url, { warnings: r.errors })
          : await fetchMediaTracks(sources.workerUrl, svc.key, url, r.errors));
      } catch (e) {
        r.errors.push(e.message);
      }
    }
    pools[svc.key] = { tracksByUrl, allTracks: dedupeTracks([...tracksByUrl.values()].flat()) };
  }

  // Fetch Drive files — personal folders, community/shared folders (recursive), manual links
  const driveFiles = await fetchAllDriveFiles(sources, results.drive.errors);

  // Build a Drive artist lookup: title → artist from Drive filenames
  const driveArtistMap = {};
  for (const f of driveFiles) {
    if (f.artist) {
      driveArtistMap[f.title.toLowerCase().trim()] = f.artist;
    }
  }

  const matchTracks = (song, artist, tracks, threshold) => {
    if (!tracks.length) return null;
    return artist
      ? findBestMatchWithArtist(song.title, artist, tracks, threshold)
      : findBestMatch(song.title, tracks, threshold);
  };

  for (const song of songs) {
    let updated = false;

    // Per service: the song's own setlist references first, at the normal
    // bar; the cross-reference pool only on a near-exact title.
    // Cross-reference with Drive artist when available.
    for (const svc of MEDIA_SERVICES) {
      const { tracksByUrl, allTracks } = pools[svc.key];
      if (song[svc.songField] || !allTracks.length) continue;
      const knownArtist = song.artist || driveArtistMap[song.title.toLowerCase().trim()] || '';
      const ownTracks = dedupeTracks(
        (refs[svc.key].perSong.get(song.id) || []).flatMap(u => tracksByUrl.get(u) || []));
      const result = matchTracks(song, knownArtist, ownTracks, 0.7)
        || matchTracks(song, knownArtist,
          allTracks.length > ownTracks.length ? allTracks : [], CROSS_PLAYLIST_MIN_SCORE);
      if (result) {
        song[svc.songField] = trackLink(result.match);
        // The worker resolves Bandcamp's embed-player ids during the same
        // scrape — store the ready embed URL so the song page never has to
        // re-scrape for it.
        if (svc.key === 'bandcamp' && result.match.embedUrl && !song.bandcampEmbedUrl) {
          song.bandcampEmbedUrl = result.match.embedUrl;
        }
        if (result.match.artist && !song.artist) song.artist = result.match.artist;
        results[svc.key].matched++;
        updated = true;
      } else {
        results[svc.key].skipped++;
      }
    }

    // Drive matching — cross-reference with Spotify artist
    if (!song.chartUrl && driveFiles.length) {
      if (applyDriveMatchToSong(song, driveFiles)) {
        results.drive.matched++;
        updated = true;
      } else {
        results.drive.skipped++;
      }
    }

    if (updated) await store.putSong(song);
    results.done++;
    onProgress?.(results);
  }

  return results;
}

// Track list for a Bandcamp/SoundCloud reference URL, via the worker's
// /media/:service routes (neither service is readable from the browser —
// no API, no CORS). Returns [{title, artist, url, embedUrl}]; a capped scan
// lands in `warnings` rather than failing.
async function fetchMediaTracks(workerUrl, service, refUrl, warnings = []) {
  if (!workerUrl) {
    throw new Error(`the ${service} reference link needs the sync worker — set the worker URL in Settings`);
  }
  const res = await fetch(`${workerUrl}/media/${service}?url=${encodeURIComponent(refUrl)}`, { headers: workerHeaders() });
  let detail = '';
  if (!res.ok) {
    try { detail = (await res.json())?.error || ''; } catch {}
    // The router's own 404 body is exactly {"error":"not found"} — that's a
    // worker deployed before these routes existed, not a missing page.
    if (res.status === 404 && (!detail || detail === 'not found')) {
      throw new Error(`worker outdated — redeploy the setlist-sync worker to enable ${service} auto-link`);
    }
    throw new Error(detail || `${service} fetch failed (${res.status})`);
  }
  const data = await res.json();
  if (data?.truncated) {
    warnings.push(`${service} scan of ${refUrl} was capped — some tracks may be missing`);
  }
  return data?.tracks || [];
}

// The EmbeddedPlayer URL for a hand-pasted Bandcamp track link (auto-linked
// songs already carry one). Returns null when the worker isn't configured or
// the page doesn't resolve — the caller falls back to a plain link.
export async function resolveBandcampEmbed(trackUrl) {
  const sources = getSources();
  if (!sources.workerUrl) return null;
  try {
    const tracks = await fetchMediaTracks(sources.workerUrl, 'bandcamp', trackUrl);
    const norm = (u) => (u || '').replace(/\/+$/, '').toLowerCase();
    const hit = tracks.find(t => norm(t.url) === norm(trackUrl)) || (tracks.length === 1 ? tracks[0] : null);
    return hit?.embedUrl || null;
  } catch {
    return null;
  }
}

// Scrape transport: the worker reads the public open.spotify.com playlist
// page instead of the Web API — the only route left for a PUBLIC playlist
// someone else owns (e.g. a bandmate's), which the API's Feb 2026 owner-only
// rule blocks for every token this app can hold. Returns {tracks, total,
// truncated, source}; throws with the worker's real reason.
async function scrapeSpotifyPlaylist(workerUrl, playlistId) {
  if (!workerUrl) {
    throw new Error('scraping the playlist needs the sync worker — set the worker URL in Settings');
  }
  const res = await fetch(`${workerUrl}/spotify/playlist/${playlistId}/scrape`, { headers: workerHeaders() });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch {}
    // The router's own 404 body is exactly {"error":"not found"} — that's a
    // worker deployed before this route existed, not a missing playlist.
    if (res.status === 404 && (!detail || detail === 'not found')) {
      throw new Error('worker outdated — redeploy the setlist-sync worker to enable playlist scraping');
    }
    throw new Error(detail || `playlist scrape failed (${res.status})`);
  }
  return await res.json();
}

// `warnings` collects non-fatal notes (scrape fallback engaged, scraped list
// truncated) — callers pass their sync-results errors array so these surface
// next to real failures instead of vanishing. `forceScrape` skips the API
// entirely (the song page's explicit "scrape playlist" button).
async function fetchSpotifyTracks(workerUrl, playlistUrl, { forceScrape = false, warnings = [] } = {}) {
  const parsed = parseSpotifyUrl(playlistUrl);
  if (!parsed || parsed.type !== 'playlist') return [];

  if (forceScrape) {
    const scraped = await scrapeSpotifyPlaylist(workerUrl, parsed.id);
    if (scraped.truncated) {
      warnings.push(`scraped ${scraped.tracks.length} of ${scraped.total} tracks from the public playlist page — the page didn't render the rest`);
    }
    return scraped.tracks || [];
  }

  // Prefer the user's own Spotify session when connected (Settings →
  // "spotify account"): since Spotify's Feb 2026 API change, playlist
  // contents are only returned to a USER token whose account owns or
  // collaborates on the playlist — the worker's client-credentials token
  // (no user) gets nothing for development-mode apps. Falls back to the
  // worker anyway if the user read fails (extended-quota deployments).
  let userError = null;
  const userToken = await getSpotifyUserToken();
  if (userToken) {
    try {
      return await fetchPlaylistTracksAsUser(parsed.id, userToken);
    } catch (e) {
      userError = e;
      console.warn('[setlist] spotify user-token playlist read failed, falling back to worker:', e.message);
    }
  } else if (isSpotifyConnected()) {
    // readToken() has a record but getSpotifyUserToken() couldn't mint a
    // token from it (refresh failed on a network error). Without this, the
    // fallback's client-credentials error is the ONLY thing the user sees —
    // and it wrongly implies connecting wouldn't help.
    userError = new Error('the saved Spotify session could not refresh (network hiccup or revoked access)');
  }

  if (workerUrl) {
    const res = await fetch(`${workerUrl}/spotify/playlist/${parsed.id}`, { headers: workerHeaders() });
    if (!res.ok) {
      // The worker reports the real reason (bad credentials, playlist not
      // accessible, rate-limited) in a JSON {error} body — surface it instead
      // of a bare status so the sync results explain what actually went wrong.
      let detail = '';
      try { detail = (await res.json())?.error || ''; }
      catch { detail = (await res.text().catch(() => '')) || ''; }

      // Every API path refused — scrape the public playlist page as a last
      // resort before failing. This is what keeps auto-link working for a
      // public playlist owned by someone else (the API's owner-only dead
      // end); a private playlist won't scrape either, and then the API
      // errors below are still the story that explains why.
      let scrapeNote = '';
      try {
        const scraped = await scrapeSpotifyPlaylist(workerUrl, parsed.id);
        if (scraped.tracks?.length) {
          warnings.push(`playlist read by scraping its public page (Spotify's API refused every read)${scraped.truncated ? ` — got ${scraped.tracks.length} of ${scraped.total} tracks` : ''}`);
          return scraped.tracks;
        }
      } catch (scrapeErr) {
        scrapeNote = ` Scraping the public page also failed: ${scrapeErr.message}.`;
      }

      // The client-credentials dead end has a client-side fix the worker
      // can't know about — point at it. And when the user IS connected, the
      // user-token failure is the actionable half of the story: since
      // Spotify's Feb 2026 change the user token is the ONLY API path that
      // can read playlist contents for development-mode apps, so its error
      // (e.g. "owner-only") is the one worth acting on, not the worker's.
      let hint = '';
      if (userError) {
        hint = ` Reading it as your connected Spotify account also failed: ${userError.message}. If the playlist is yours, try "disconnect spotify" then reconnect in Settings.`;
      } else if ((res.status === 403 || res.status === 404) && !isSpotifyConnected()) {
        hint = ' Fix: connect spotify in Settings — since Spotify\'s Feb 2026 API change that is the only way a development-mode app can read playlist contents, and the playlist must be owned by (or collaborative with) your account.';
      }
      hint += scrapeNote;
      if (res.status === 403 || res.status === 401 || res.status === 502) {
        throw new Error((detail || 'Spotify credentials invalid — check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your worker env vars') + hint);
      }
      throw new Error((detail || `Spotify API ${res.status}`) + hint);
    }
    return await res.json();
  }
  if (userError) throw userError;
  return [];
}

// Read a playlist's tracks directly from the Spotify Web API with the user's
// token (the API is CORS-enabled), returning the same {title, artist,
// spotifyUrl} shape as the worker's /spotify/playlist route.
//
// Uses the /items endpoint from Spotify's February 2026 Web API migration:
// the old …/tracks endpoint 403s for every development-mode app since
// 2026-03-09 (no matter the token or the playlist being public), and each
// element's `track` field is now named `item`. Same migration also made
// contents owner-only — Spotify returns a playlist's items only to a user
// who owns or collaborates on it; anyone else gets metadata with no items.
async function fetchPlaylistTracksAsUser(playlistId, token) {
  const tracks = [];
  const OWNER_ONLY_HINT = 'since Spotify\'s Feb 2026 API change, a development-mode app can only read the contents of playlists your account owns or collaborates on (public/private no longer matters) — for someone else\'s playlist, ask the owner for a collaborator invite, or copy its tracks into a playlist you own';
  const fields = encodeURIComponent('items(item(name,uri,artists(name),external_urls(spotify))),next');
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&fields=${fields}`;
  let firstPage = true;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hint = res.status === 403 ? ` — ${OWNER_ONLY_HINT}` : '';
      throw new Error(`Spotify playlist ${playlistId} (read as your account): ${res.status}${hint}. ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    // 200 with the items field absent is the "metadata only" answer a
    // non-owner gets — surface why rather than reporting an empty playlist.
    if (firstPage && !Array.isArray(data.items)) {
      throw new Error(`Spotify playlist ${playlistId} (read as your account): Spotify withheld the playlist's contents — ${OWNER_ONLY_HINT}`);
    }
    firstPage = false;
    for (const item of (data.items || [])) {
      const t = item.item || item.track; // `track` is the pre-Feb-2026 shape (extended-quota apps)
      if (!t) continue;
      tracks.push({
        title: t.name,
        artist: t.artists?.map(a => a.name).join(', ') || '',
        spotifyUrl: t.external_urls?.spotify || (t.uri ? `spotify:track:${t.uri.split(':').pop()}` : ''),
      });
    }
    url = data.next || null;
  }
  return tracks;
}

// One reference playlist's tracks, via the same user-token-first transport
// as auto-link — for callers outside this module (the library tools' "verify
// spotify links" pass) that need tracks scoped per setlist, not pooled.
export async function fetchPlaylistTracks(playlistUrl, opts = {}) {
  return fetchSpotifyTracks(getSources().workerUrl, playlistUrl, opts);
}

async function fetchDriveFiles(workerUrl, folderUrl) {
  if (!workerUrl) return [];
  const m = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (!m) return [];

  const res = await fetch(`${workerUrl}/drive/folder/${m[1]}`, { headers: workerHeaders() });
  if (!res.ok) throw new Error(`Drive API ${res.status}`);
  return await res.json();
}

// Community/shared chart-repo folders: recursively walks subfolders via the
// worker's /recursive route, since archives in circulation among musicians
// are commonly nested (artist/album/etc). Returns {files, truncated}.
async function fetchDriveFilesRecursive(workerUrl, folderUrl) {
  if (!workerUrl) return { files: [], truncated: false };
  const m = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (!m) return { files: [], truncated: false };

  const res = await fetch(`${workerUrl}/drive/folder/${m[1]}/recursive`, { headers: workerHeaders() });
  if (!res.ok) throw new Error(`Drive API ${res.status}`);
  return await res.json();
}

// Gathers chart candidates from every configured source: personal Drive
// folders (direct children only), community/shared folders (recursive), and
// manually-linked charts. Shared by the bulk sync and the per-song search.
async function fetchAllDriveFiles(sources, errors = []) {
  const driveFiles = [];
  for (const folder of sources.driveFolders) {
    try {
      driveFiles.push(...(await fetchDriveFiles(sources.workerUrl, folder.url)));
    } catch (e) {
      errors.push(e.message);
    }
  }
  for (const folder of sources.communityFolders) {
    try {
      const { files, truncated } = await fetchDriveFilesRecursive(sources.workerUrl, folder.url);
      driveFiles.push(...files);
      if (truncated) {
        errors.push(`Community folder scan was truncated (too many files/subfolders) — some charts may be missing: ${folder.url}`);
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  for (const chart of sources.driveCharts) {
    if (chart.title) driveFiles.push({ title: chart.title, webViewLink: chart.url });
  }
  return driveFiles;
}

// Matches one song against a pool of Drive chart candidates and applies the
// match's fields onto the song in place. Returns true if a match was applied.
function applyDriveMatchToSong(song, driveFiles) {
  if (song.chartUrl || !driveFiles.length) return false;
  const knownArtist = song.artist || '';
  const result = knownArtist
    ? findBestMatchWithArtist(song.title, knownArtist, driveFiles)
    : findBestMatch(song.title, driveFiles);
  if (!result) return false;
  song.chartUrl = result.match.webViewLink;
  if (result.match.artist && !song.artist) song.artist = result.match.artist;
  if (result.match.inferredKey && !song.key) song.key = result.match.inferredKey;
  if (result.match.inferredBpm && !song.bpm) song.bpm = result.match.inferredBpm;
  if (result.match.inferredCapo && !song.capo) song.capo = result.match.inferredCapo;
  return true;
}

// A web-search candidate must clear this to be auto-linked without asking;
// weaker candidates are returned for the user to pick from instead.
const WEB_AUTO_LINK_SCORE = 0.85;

function applyWebCandidateToSong(song, c) {
  song.chartUrl = c.url;
  if (c.artist && !song.artist) song.artist = c.artist;
  if (c.inferredKey && !song.key) song.key = c.inferredKey;
  if (c.inferredBpm && !song.bpm) song.bpm = c.inferredBpm;
  if (c.inferredCapo && !song.capo) song.capo = c.inferredCapo;
}

// Tiers 1–3 of the chart-fallback ladder for a single song:
//   1+2. personal + community Drive folders (same pool as bulk "sync now")
//   3.   web search via the worker — shared NNS chart collections in the wild
//        (Drive/Dropbox links). A verified, high-scoring hit is auto-linked;
//        weaker hits come back as candidates for the caller's picker UI.
// Returns {found, tier?, candidate?, candidates?}; the caller saves the song
// when found. Tier 4 (create/draft a chart doc) is the caller's fallback —
// see createChartDoc in gdrive-backup.js + chart-build.js.
//
// opts.collectOnly: never touch the song — return every plausible candidate
// (Drive folders included) for a manual pick. This is the "find alt chart"
// path for songs that ALREADY have a primary: without it, a high-scoring web
// hit would silently overwrite song.chartUrl, and the Drive tiers would be
// skipped entirely (applyDriveMatchToSong refuses charted songs).
export async function searchChartForSong(song, onStage, { collectOnly = false } = {}) {
  const sources = getSources();
  if (!sources.workerUrl) return { found: false, candidates: [] };

  onStage?.('drive');
  const driveFiles = await fetchAllDriveFiles(sources);
  let driveCandidates = [];
  if (collectOnly) {
    driveCandidates = driveFiles
      .map(f => ({ name: f.title, url: f.webViewLink, source: 'drive', verified: true, score: matchScore(song.title, f.title) }))
      .filter(c => c.url && c.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  } else if (applyDriveMatchToSong(song, driveFiles)) {
    return { found: true, tier: 'drive' };
  }

  onStage?.('web');
  let data = null;
  try {
    const params = new URLSearchParams({ title: song.title, artist: song.artist || '' });
    const res = await fetch(`${sources.workerUrl}/web/chart-search?${params}`, { headers: workerHeaders() });
    if (res.ok) data = await res.json();
  } catch { /* offline or a worker without the /web routes — just no tier 3 */ }

  const candidates = data?.candidates || [];
  const top = candidates[0];
  if (!collectOnly && top?.verified && top.score >= WEB_AUTO_LINK_SCORE) {
    applyWebCandidateToSong(song, top);
    return { found: true, tier: 'web', candidate: top };
  }
  // providerDown distinguishes "searched, nothing out there" from "couldn't
  // search at all" (keyless engine bot-blocked) so the UI can say which.
  return {
    found: false,
    candidates: [...driveCandidates, ...candidates],
    providerDown: !!data?.providerDown,
    warnings: data?.warnings || [],
  };
}

// Applies a user-picked web candidate (from searchChartForSong's candidates)
// onto the song. Caller saves.
export function linkChartCandidate(song, candidate) {
  applyWebCandidateToSong(song, candidate);
}

// Chords + song structure from the web (worker /web/chart-data — Ultimate
// Guitar plus a generic sweep of chord sites, converted to Nashville
// numbers), for drafting a real chart doc. Returns {ok:true, data} or
// {ok:false, reason} — the reason distinguishes a stale worker deploy
// ('worker-outdated') from "searched but found nothing" so the UI can say
// which, instead of silently producing a template.
export async function fetchWebChartData(song) {
  const sources = getSources();
  if (!sources.workerUrl) return { ok: false, reason: 'no worker configured' };
  try {
    const params = new URLSearchParams({ title: song.title, artist: song.artist || '' });
    const res = await fetch(`${sources.workerUrl}/web/chart-data?${params}`, { headers: workerHeaders() });
    if (res.status === 404) return { ok: false, reason: 'worker-outdated' };
    if (!res.ok) return { ok: false, reason: `worker error ${res.status}` };
    const data = await res.json();
    if (!data?.found) return { ok: false, reason: data?.reason || 'no chord source found' };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'network error' };
  }
}

// A full Nashville-number chart drafted by an LLM with web-search grounding
// (worker /ai/chart) — the strongest "create chart doc" tier when the worker
// has an AI key configured. Returns {ok:true, data} with data carrying
// {key, bpm, time, capo, feel, confidence, sections:[{name, comment,
// bars:[]}], notes, provider, model, sources}; or {ok:false, reason} —
// 'no-ai-key' means skip silently to the scrape tier.
// opts.retry: the user judged a previous result wrong (or is explicitly
// rebuilding) — busts the 7-day response cache (fresh `t` param = fresh cache
// key) and tells the worker to research harder; without it, a "redo" within
// the cache window would just replay the same wrong answer.
export async function fetchAiChart(song, { retry = false } = {}) {
  const sources = getSources();
  if (!sources.workerUrl) return { ok: false, reason: 'no worker configured' };
  try {
    const params = new URLSearchParams({ title: song.title, artist: song.artist || '' });
    if (song.key) params.set('key', song.key);
    if (retry) {
      params.set('retry', '1');
      params.set('t', String(Date.now()));
    }
    const res = await fetch(`${sources.workerUrl}/ai/chart?${params}`, { headers: workerHeaders() });
    if (res.status === 404) return { ok: false, reason: 'worker-outdated' };
    if (!res.ok) return { ok: false, reason: `worker error ${res.status}` };
    const data = await res.json();
    if (data?.aiConfigured === false) return { ok: false, reason: 'no-ai-key' };
    if (!data?.found) return { ok: false, reason: data?.reason || 'AI found nothing' };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'network error' };
  }
}

// A concise steel-guitar direction summary drafted by an LLM with web-search
// grounding (worker /ai/steel-summary): presence, entrances, style lineage,
// intensity — a few sentences for quick reference while studying/performing.
// Returns {ok:true, data:{summary, confidence, provider, model, sources}} or
// {ok:false, reason} — 'no-ai-key' means the worker has no AI key configured.
// opts.fresh busts the 7-day response cache (a regen must actually re-run,
// not replay the cached answer); opts.retry additionally tells the worker
// the previous summary was marked WRONG, so it researches harder. The bulk
// missing-only pass passes neither and keeps the cache's cost savings.
export async function fetchSteelSummary(song, { fresh = false, retry = false } = {}) {
  const sources = getSources();
  if (!sources.workerUrl) return { ok: false, reason: 'no worker configured' };
  try {
    const params = new URLSearchParams({ title: song.title, artist: song.artist || '' });
    if (retry) params.set('retry', '1');
    if (fresh || retry) params.set('t', String(Date.now()));
    const res = await fetch(`${sources.workerUrl}/ai/steel-summary?${params}`, { headers: workerHeaders() });
    if (res.status === 404) return { ok: false, reason: 'worker-outdated' };
    if (!res.ok) return { ok: false, reason: `worker error ${res.status}` };
    const data = await res.json();
    if (data?.aiConfigured === false) return { ok: false, reason: 'no-ai-key' };
    if (!data?.found || !data?.summary) return { ok: false, reason: data?.reason || 'AI could not verify this song' };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'network error' };
  }
}

// Song metadata from music APIs (worker /meta/song — Spotify audio-features
// when the song has a linked track, keyless Deezer for BPM, keyless iTunes
// for artist/genre/year/artwork/duration). Returns {bpm?, key?, time?,
// artist?, genre?, year?, artworkUrl?, durationSec?, sources} or null.
export async function fetchSongMeta(song) {
  const sources = getSources();
  if (!sources.workerUrl) return null;
  const params = new URLSearchParams({ title: song.title || '', artist: song.artist || '' });
  const sp = song.spotifyUri ? parseSpotifyUrl(song.spotifyUri) : null;
  if (sp?.type === 'track' && sp.id) params.set('spotifyId', sp.id);
  try {
    const res = await fetch(`${sources.workerUrl}/meta/song?${params}`, { headers: workerHeaders() });
    if (!res.ok) return null;
    const meta = await res.json();
    return meta?.sources?.length || meta?.bpm || meta?.key || meta?.time ? meta : null;
  } catch {
    return null;
  }
}

// ── AI vision read of a scanned/image chart ──
// Text scraping can't reach a photo of a hand-written chart; the worker's
// /ai/chart-read route has a vision model read what's actually written on
// the page (key, bpm, capo, modulation notes). The blob is downscaled
// client-side first — vision models cap request sizes, and the chart header
// doesn't need w2000 pixels.
const CHART_READ_MAX_DIM = 1600;

async function blobToScaledJpegBase64(blob, maxDim = CHART_READ_MAX_DIM) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // JPEG has no alpha — transparency composites to black, which turns a
  // transparent-background PNG scan into black-on-black. Paint paper first.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg' };
}

// Returns {ok:true, data:{key?, bpm?, capo?, keyChanges?, artist?}} with only
// the fields the model actually read off the page, or {ok:false, reason} —
// 'no-ai-key' means skip silently (no key configured on the worker).
export async function readChartImage(song, blob) {
  const sources = getSources();
  if (!sources.workerUrl) return { ok: false, reason: 'no worker configured' };
  let payload;
  try {
    payload = await blobToScaledJpegBase64(blob);
  } catch (e) {
    return { ok: false, reason: `image decode failed: ${e.message}` };
  }
  try {
    const res = await fetch(`${sources.workerUrl}/ai/chart-read`, {
      method: 'POST',
      headers: workerHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        image: payload.data,
        mimeType: payload.mimeType,
        title: song.title || '',
        artist: song.artist || '',
      }),
    });
    if (res.status === 404) return { ok: false, reason: 'worker-outdated' };
    if (!res.ok) return { ok: false, reason: `worker error ${res.status}` };
    const data = await res.json();
    if (data?.aiConfigured === false) return { ok: false, reason: 'no-ai-key' };
    if (!data?.found) return { ok: false, reason: data?.reason || 'could not read the chart' };
    return { ok: true, data: data.fields || {} };
  } catch {
    return { ok: false, reason: 'network error' };
  }
}

export async function deepScrapeChart(song) {
  const sources = getSources();
  if (!sources.workerUrl || !song.chartUrl) return null;

  const fileMatch = song.chartUrl.match(/(?:file|document)\/d\/([a-zA-Z0-9_-]+)/);
  if (!fileMatch) return null;

  try {
    const res = await fetch(`${sources.workerUrl}/drive/file/${fileMatch[1]}/meta`, { headers: workerHeaders() });
    if (!res.ok) return null;
    const meta = await res.json();

    const updates = {};
    if (meta.inferredKey) updates.key = meta.inferredKey;
    if (meta.inferredBpm) updates.bpm = meta.inferredBpm;
    if (meta.inferredCapo) updates.capo = meta.inferredCapo;
    if (meta.artist) updates.artist = meta.artist;
    if (meta.sections) updates._sections = meta.sections;
    if (meta.isNashvilleChart) updates._isNashvilleChart = true;
    if (meta.textContent) updates._textPreview = meta.textContent.slice(0, 500);

    return Object.keys(updates).length ? updates : null;
  } catch {
    return null;
  }
}

// All reference-playlist tracks relevant to a song — its setlist's playlist
// when viewing in setlist context, else every setlist's playlist (deduped).
// Backs the song page's "relink spotify" picker: auto-matching can grab a
// same-titled cover/karaoke track, and the fix is choosing the real one
// from the playlist itself.
//
// Returns {tracks, problems}: an empty result must say WHY (no worker, no
// playlist URL anywhere, a URL that isn't an open.spotify.com/playlist link,
// or the worker's real Spotify error) — silently reporting "no tracks" for a
// playlist the user is looking at in Spotify reads as data loss.
// opts.forceScrape reads via the public-page scrape only (the song page's
// "scrape playlist" button) — no API attempts, so it works for a public
// playlist someone else owns and fails fast with the scrape's own reason.
export async function getReferencePlaylistTracks(setlist, opts = {}) {
  const sources = getSources();
  const problems = [];
  if (!sources.workerUrl) {
    return { tracks: [], problems: ['no worker URL configured in Settings'] };
  }

  let urls;
  if (setlist?.spotifyUrl) {
    urls = [setlist.spotifyUrl];
  } else {
    const all = await store.getAllSetlists();
    urls = [...new Set(all.map(sl => sl.spotifyUrl).filter(Boolean))];
    if (!urls.length) {
      problems.push('no Spotify playlist URL is set on any setlist — add one on the setlist edit page');
    }
  }

  const tracks = [];
  for (const url of urls) {
    const parsed = parseSpotifyUrl(url);
    if (!parsed || parsed.type !== 'playlist') {
      problems.push(`"${url.slice(0, 60)}" isn't a playlist link — paste the full open.spotify.com/playlist/… URL (share short-links and album links don't work)`);
      continue;
    }
    try {
      tracks.push(...await fetchSpotifyTracks(sources.workerUrl, url, { ...opts, warnings: problems }));
    } catch (e) {
      problems.push(e.message);
    }
  }
  const seen = new Set();
  return {
    tracks: tracks.filter(t => t.spotifyUrl && !seen.has(t.spotifyUrl) && seen.add(t.spotifyUrl)),
    problems,
  };
}

export function spotifySearchUrl(title, artist) {
  const q = encodeURIComponent(artist ? `${title} ${artist}` : title);
  return `https://open.spotify.com/search/${q}`;
}

export function parseBatchChartUrls(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const results = [];
  for (const line of lines) {
    const urlMatch = line.match(/(https?:\/\/[^\s]+)/);
    if (!urlMatch) continue;
    const url = urlMatch[1];
    const rest = line.replace(url, '').trim();
    let title = '', artist = '';
    if (rest) {
      const parts = rest.split(/\s*[-–—]\s*/);
      title = parts[0]?.trim() || '';
      artist = parts.slice(1).join(' - ').trim();
    }
    results.push({ url, title, artist });
  }
  return results;
}
