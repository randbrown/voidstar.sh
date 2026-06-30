// Sync orchestration — matches songs against Spotify playlists and Google Drive folders.
// Uses the setlist-sync Cloudflare Worker for API access when configured,
// falls back to client-side matching with manually provided URLs.

import { findBestMatch, parseDriveFilename } from './match.js';
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

  const spotifyTracks = [];
  const uniqueUrls = [...new Set(playlistUrls)];
  for (const url of uniqueUrls) {
    try {
      const tracks = await fetchSpotifyTracks(sources.workerUrl, url);
      spotifyTracks.push(...tracks);
    } catch (e) {
      results.spotify.errors.push(e.message);
    }
  }

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

  for (const song of songs) {
    let updated = false;

    if (!song.spotifyUri && spotifyTracks.length) {
      const result = findBestMatch(song.title, spotifyTracks);
      if (result) {
        song.spotifyUri = result.match.spotifyUrl;
        if (result.match.artist && !song.artist) song.artist = result.match.artist;
        results.spotify.matched++;
        updated = true;
      } else {
        results.spotify.skipped++;
      }
    }

    if (!song.chartUrl && driveFiles.length) {
      const result = findBestMatch(song.title, driveFiles);
      if (result) {
        song.chartUrl = result.match.webViewLink;
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
    if (!res.ok) throw new Error(`Spotify API ${res.status}`);
    return await res.json();
  }
  return [];
}

async function fetchDriveFiles(workerUrl, folderUrl) {
  if (!workerUrl) return [];
  const m = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (!m) return [];

  const res = await fetch(`${workerUrl}/drive/folder/${m[1]}`);
  if (!res.ok) throw new Error(`Drive API ${res.status}`);
  return await res.json();
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
