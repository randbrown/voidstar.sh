// Offline chart cache — downloads each song's chart as an image blob (via the
// sync worker's /drive/file/:id/image proxy) and stores it in IndexedDB so
// perform mode renders charts with no network at a gig.
//
// Why a worker proxy: the online <img> rendering loads Google's cross-origin
// chart URLs fine, but *reading* those bytes to cache them is blocked by CORS.
// The worker refetches with the API key and re-serves with our CORS headers.
// Direct same-origin / CORS-friendly image or PDF URLs are fetched straight.

import * as store from './store.js';
import { getSources } from './sync.js';

// Broadcast when a chart lands in the cache so open views (e.g. the setlist
// offline bar) can live-refresh their N/M count as background caching runs.
export const CHART_CACHED_EVENT = 'setlist:chart-cached';
function announceCached(songId) {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent(CHART_CACHED_EVENT, { detail: { songId } })); } catch {}
}

// Pull the Drive file id out of the common chart URL shapes:
//   drive.google.com/file/d/<id>/view · docs.google.com/document/d/<id>/edit
//   ...?id=<id> · ...open?id=<id>
export function chartFileId(url) {
  if (!url) return null;
  return (
    url.match(/\/(?:file|document|presentation|spreadsheets)\/d\/([a-zA-Z0-9_-]+)/)?.[1] ||
    url.match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1] ||
    null
  );
}

// A same-origin/CORS-friendly direct file that we can fetch bytes from without
// the worker (a bare image or PDF link, not a Google viewer page).
function isDirectFile(url) {
  return /\.(png|jpe?g|gif|webp|avif|pdf)(\?|#|$)/i.test(url || '');
}

// The URL we fetch to get cacheable bytes for a chart, or null if we can't
// (no worker configured and not a direct file).
export function chartImageFetchUrl(chartUrl, workerUrl) {
  const id = chartFileId(chartUrl);
  if (id && workerUrl) return `${workerUrl}/drive/file/${id}/image`;
  if (isDirectFile(chartUrl)) return chartUrl;
  return null;
}

// True when a song has a chart that we could cache given current config.
export function isChartCacheable(song, workerUrl) {
  return !!(song?.chartUrl && chartImageFetchUrl(song.chartUrl, workerUrl));
}

// Download + store one song's chart. Returns { songId, ok, reason }.
export async function cacheChartForSong(song, workerUrl) {
  if (!song?.chartUrl) return { songId: song?.id, ok: false, reason: 'no chart' };
  const url = chartImageFetchUrl(song.chartUrl, workerUrl);
  if (!url) return { songId: song.id, ok: false, reason: 'needs worker' };
  try {
    const res = await fetch(url);
    if (!res.ok) return { songId: song.id, ok: false, reason: `fetch ${res.status}` };
    const blob = await res.blob();
    if (!blob || blob.size === 0) return { songId: song.id, ok: false, reason: 'empty' };
    await store.putChartBlob(song.id, blob, song.chartUrl);
    announceCached(song.id);
    return { songId: song.id, ok: true, size: blob.size };
  } catch (e) {
    return { songId: song.id, ok: false, reason: e.message || 'fetch failed' };
  }
}

// Download + store a list of songs' charts. onProgress({ done, total, ok,
// failed, last }) fires after each. With skipCached, songs that already have a
// cached blob are left alone (used for auto-cache and "cache missing only").
// Returns { total, ok, failed, skipped, results }.
async function cacheSongs(songs, onProgress, { skipCached = false } = {}) {
  const workerUrl = getSources().workerUrl;
  let withCharts = songs.filter(s => s.chartUrl);
  let skipped = 0;
  if (skipCached) {
    const cachedIds = new Set(await store.getCachedChartIds());
    const before = withCharts.length;
    withCharts = withCharts.filter(s => !cachedIds.has(s.id));
    skipped = before - withCharts.length;
  }

  const results = [];
  let ok = 0, failed = 0;
  for (let i = 0; i < withCharts.length; i++) {
    const r = await cacheChartForSong(withCharts[i], workerUrl);
    results.push(r);
    if (r.ok) ok++; else failed++;
    onProgress?.({ done: i + 1, total: withCharts.length, ok, failed, skipped, last: r });
  }
  return { total: withCharts.length, ok, failed, skipped, results };
}

// Cache every chart in a setlist.
export async function cacheSetlistCharts(setlist, onProgress, opts) {
  const songIds = [...new Set(setlist.sets.flatMap(s => s.songIds))];
  const songs = (await Promise.all(songIds.map(id => store.getSong(id)))).filter(Boolean);
  return cacheSongs(songs, onProgress, opts);
}

// Cache every chart in the whole library (all songs, regardless of setlist).
export async function cacheAllCharts(onProgress, opts) {
  const songs = await store.getAllSongs();
  return cacheSongs(songs, onProgress, opts);
}

// Offline status across the entire library: { cached, total } where total =
// songs that have a chartUrl.
export async function getAllChartsOfflineStatus() {
  const songs = await store.getAllSongs();
  const chartedIds = songs.filter(s => s.chartUrl).map(s => s.id);
  if (!chartedIds.length) return { cached: 0, total: 0 };
  const cachedIds = new Set(await store.getCachedChartIds());
  const cached = chartedIds.filter(id => cachedIds.has(id)).length;
  return { cached, total: chartedIds.length };
}

// How many of a setlist's charted songs already have a cached blob.
// Returns { cached, total } where total = songs that have a chartUrl.
export async function getSetlistOfflineStatus(setlist) {
  const songIds = [...new Set(setlist.sets.flatMap(s => s.songIds))];
  const songs = (await Promise.all(songIds.map(id => store.getSong(id)))).filter(Boolean);
  const chartedIds = songs.filter(s => s.chartUrl).map(s => s.id);
  if (!chartedIds.length) return { cached: 0, total: 0 };
  const cachedIds = new Set(await store.getCachedChartIds());
  const cached = chartedIds.filter(id => cachedIds.has(id)).length;
  return { cached, total: chartedIds.length };
}

// An object URL for a song's cached chart, or null if not cached. Caller MUST
// URL.revokeObjectURL() it when done to avoid leaking.
//
// Pass the song's current chartUrl as `expectedUrl` to guard against a stale
// blob: the cache is keyed by songId, so if the chart link later changed (e.g.
// a re-sync corrected a bad match) the old blob would otherwise keep rendering
// forever. When the cached sourceUrl doesn't match, we drop the stale entry and
// report a miss so the caller falls back to the live URL.
export async function getOfflineChartUrl(songId, expectedUrl) {
  try {
    const rec = await store.getChartBlob(songId);
    if (rec?.blob) {
      if (expectedUrl && rec.sourceUrl && rec.sourceUrl !== expectedUrl) {
        await store.deleteChartBlob(songId);
        return null;
      }
      return URL.createObjectURL(rec.blob);
    }
  } catch {}
  return null;
}
