// Sync orchestration — matches songs against Spotify playlists and Google Drive folders.
// Uses the setlist-sync Cloudflare Worker for API access when configured,
// falls back to client-side matching with manually provided URLs.
// Cross-references Spotify and Drive data for better disambiguation.

import { findBestMatch, findBestMatchWithArtist, parseDriveFilename } from './match.js';
import * as store from './store.js';
import { parseSpotifyUrl } from './spotify.js';

const SOURCES_KEY = 'voidstar.setlist.sources';

export function getSources() {
  try {
    return JSON.parse(localStorage.getItem(SOURCES_KEY)) || defaultSources();
  } catch {
    return defaultSources();
  }
}

function defaultSources() {
  return {
    workerUrl: '',
    driveFolders: [],
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

  // Fetch Drive files
  const driveFiles = [];
  for (const folder of sources.driveFolders) {
    try {
      const files = await fetchDriveFiles(sources.workerUrl, folder.url);
      driveFiles.push(...files);
    } catch (e) {
      results.drive.errors.push(e.message);
    }
  }
  for (const chart of sources.driveCharts) {
    if (chart.title) driveFiles.push({ title: chart.title, webViewLink: chart.url });
  }

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
      const knownArtist = song.artist || '';
      const result = knownArtist
        ? findBestMatchWithArtist(song.title, knownArtist, driveFiles)
        : findBestMatch(song.title, driveFiles);
      if (result) {
        song.chartUrl = result.match.webViewLink;
        if (result.match.artist && !song.artist) song.artist = result.match.artist;
        if (result.match.inferredKey && !song.key) song.key = result.match.inferredKey;
        if (result.match.inferredBpm && !song.bpm) song.bpm = result.match.inferredBpm;
        if (result.match.inferredCapo && !song.capo) song.capo = result.match.inferredCapo;
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
      const body = await res.text().catch(() => '');
      throw new Error(`Spotify API ${res.status}`);
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
