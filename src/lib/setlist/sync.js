// Sync orchestration — matches songs against Spotify playlists and Google Drive
// folders, and (per-song) against shared chart files found on the open web.
// Uses the setlist-sync Cloudflare Worker for API access when configured,
// falls back to client-side matching with manually provided URLs.
// Cross-references Spotify and Drive data for better disambiguation.

import { findBestMatch, findBestMatchWithArtist, parseDriveFilename } from './match.js';
import * as store from './store.js';
import { parseSpotifyUrl } from './spotify.js';

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
  return s;
}

function defaultSources() {
  return {
    workerUrl: '',
    driveFolders: [],
    communityFolders: [],
    driveCharts: [],
  };
}

export function setSources(sources) {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
}

export async function syncSetlist(setlistId, onProgress) {
  const sl = await store.getSetlist(setlistId);
  if (!sl) throw new Error('Setlist not found');

  const allSongIds = sl.sets.flatMap(s => s.songIds);
  const songs = (await Promise.all(allSongIds.map(id => store.getSong(id)))).filter(Boolean);

  return runSync(songs, sl.spotifyUrl ? [sl.spotifyUrl] : [], onProgress);
}

export async function syncAll(onProgress) {
  const songs = await store.getAllSongs();
  const setlists = await store.getAllSetlists();
  const playlistUrls = setlists.map(sl => sl.spotifyUrl).filter(Boolean);
  return runSync(songs, playlistUrls, onProgress);
}

async function runSync(songs, playlistUrls, onProgress) {
  const sources = getSources();
  const results = {
    spotify: { matched: 0, skipped: 0, errors: [] },
    drive: { matched: 0, skipped: 0, errors: [] },
    total: songs.length,
    done: 0,
  };

  // Fetch Spotify tracks from playlists
  let spotifyTracks = [];
  let playlistFailed = false;
  const uniqueUrls = [...new Set(playlistUrls)];
  for (const url of uniqueUrls) {
    try {
      const tracks = await fetchSpotifyTracks(sources.workerUrl, url);
      spotifyTracks.push(...tracks);
    } catch (e) {
      playlistFailed = true;
      results.spotify.errors.push(e.message);
    }
  }

  // If playlist fetch failed, use batch search instead
  const useSearch = playlistFailed && sources.workerUrl && spotifyTracks.length === 0;
  let searchResults = {};
  if (useSearch) {
    const unlinked = songs.filter(s => !s.spotifyUri).map(s => s.title);
    if (unlinked.length) {
      try {
        searchResults = await batchSearchSpotify(sources.workerUrl, unlinked);
        results.spotify.errors = [];
      } catch (e) {
        results.spotify.errors.push(`Search: ${e.message}`);
      }
    }
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

  for (const song of songs) {
    let updated = false;

    // Spotify matching — cross-reference with Drive artist when available
    if (!song.spotifyUri) {
      const knownArtist = song.artist || driveArtistMap[song.title.toLowerCase().trim()] || '';

      if (spotifyTracks.length) {
        const result = knownArtist
          ? findBestMatchWithArtist(song.title, knownArtist, spotifyTracks)
          : findBestMatch(song.title, spotifyTracks);
        if (result) {
          song.spotifyUri = result.match.spotifyUrl;
          if (result.match.artist && !song.artist) song.artist = result.match.artist;
          results.spotify.matched++;
          updated = true;
        } else {
          results.spotify.skipped++;
        }
      } else if (searchResults[song.title]) {
        const match = searchResults[song.title];
        song.spotifyUri = match.spotifyUrl;
        if (match.artist && !song.artist) song.artist = match.artist;
        results.spotify.matched++;
        updated = true;
      } else if (useSearch) {
        results.spotify.skipped++;
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

async function fetchSpotifyTracks(workerUrl, playlistUrl) {
  const parsed = parseSpotifyUrl(playlistUrl);
  if (!parsed || parsed.type !== 'playlist') return [];

  if (workerUrl) {
    const res = await fetch(`${workerUrl}/spotify/playlist/${parsed.id}`);
    if (!res.ok) {
      // The worker reports the real reason (bad credentials, playlist not
      // accessible, rate-limited) in a JSON {error} body — surface it instead
      // of a bare status so the sync results explain what actually went wrong.
      let detail = '';
      try { detail = (await res.json())?.error || ''; }
      catch { detail = (await res.text().catch(() => '')) || ''; }
      if (res.status === 403 || res.status === 401 || res.status === 502) {
        throw new Error(detail || 'Spotify credentials invalid — check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your worker env vars');
      }
      throw new Error(detail || `Spotify API ${res.status}`);
    }
    return await res.json();
  }
  return [];
}

async function batchSearchSpotify(workerUrl, titles) {
  const res = await fetch(`${workerUrl}/spotify/search-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titles }),
  });
  if (!res.ok) throw new Error(`Search API ${res.status}`);
  return await res.json();
}

async function fetchDriveFiles(workerUrl, folderUrl) {
  if (!workerUrl) return [];
  const m = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (!m) return [];

  const res = await fetch(`${workerUrl}/drive/folder/${m[1]}`);
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

  const res = await fetch(`${workerUrl}/drive/folder/${m[1]}/recursive`);
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
export async function searchChartForSong(song, onStage) {
  const sources = getSources();
  if (!sources.workerUrl) return { found: false, candidates: [] };

  onStage?.('drive');
  const driveFiles = await fetchAllDriveFiles(sources);
  if (applyDriveMatchToSong(song, driveFiles)) return { found: true, tier: 'drive' };

  onStage?.('web');
  let data = null;
  try {
    const params = new URLSearchParams({ title: song.title, artist: song.artist || '' });
    const res = await fetch(`${sources.workerUrl}/web/chart-search?${params}`);
    if (res.ok) data = await res.json();
  } catch { /* offline or a worker without the /web routes — just no tier 3 */ }

  const candidates = data?.candidates || [];
  const top = candidates[0];
  if (top?.verified && top.score >= WEB_AUTO_LINK_SCORE) {
    applyWebCandidateToSong(song, top);
    return { found: true, tier: 'web', candidate: top };
  }
  // providerDown distinguishes "searched, nothing out there" from "couldn't
  // search at all" (keyless engine bot-blocked) so the UI can say which.
  return {
    found: false,
    candidates,
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
    const res = await fetch(`${sources.workerUrl}/web/chart-data?${params}`);
    if (res.status === 404) return { ok: false, reason: 'worker-outdated' };
    if (!res.ok) return { ok: false, reason: `worker error ${res.status}` };
    const data = await res.json();
    if (!data?.found) return { ok: false, reason: data?.reason || 'no chord source found' };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'network error' };
  }
}

// BPM / key / time signature derived from music APIs (worker /meta/song —
// Spotify audio-features when the song has a linked track, keyless Deezer
// for BPM otherwise). Returns {bpm?, key?, time?, sources} or null.
export async function fetchSongMeta(song) {
  const sources = getSources();
  if (!sources.workerUrl) return null;
  const params = new URLSearchParams({ title: song.title || '', artist: song.artist || '' });
  const sp = song.spotifyUri ? parseSpotifyUrl(song.spotifyUri) : null;
  if (sp?.type === 'track' && sp.id) params.set('spotifyId', sp.id);
  try {
    const res = await fetch(`${sources.workerUrl}/meta/song?${params}`);
    if (!res.ok) return null;
    const meta = await res.json();
    return (meta?.bpm || meta?.key || meta?.time) ? meta : null;
  } catch {
    return null;
  }
}

export async function deepScrapeChart(song) {
  const sources = getSources();
  if (!sources.workerUrl || !song.chartUrl) return null;

  const fileMatch = song.chartUrl.match(/(?:file|document)\/d\/([a-zA-Z0-9_-]+)/);
  if (!fileMatch) return null;

  try {
    const res = await fetch(`${sources.workerUrl}/drive/file/${fileMatch[1]}/meta`);
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
