// Offline chart cache — downloads each song's chart as an image blob (via the
// sync worker's /drive/file/:id/image proxy) and stores it in IndexedDB so
// perform mode renders charts with no network at a gig.
//
// Why a worker proxy: the online <img> rendering loads Google's cross-origin
// chart URLs fine, but *reading* those bytes to cache them is blocked by CORS.
// The worker refetches with the API key and re-serves with our CORS headers.
// Direct same-origin / CORS-friendly image or PDF URLs are fetched straight.

import * as store from './store.js';
import { getSources, workerHeaders } from './sync.js';
import { extractKeyFromChartText } from './chart-key.js';

// The token header, but ONLY when the fetch target is our own worker — a chart
// URL can also be a direct third-party file (Dropbox/Drive link), and we must
// never leak the worker token to an arbitrary host.
function headersForUrl(url, workerUrl) {
  return (workerUrl && url.startsWith(workerUrl)) ? workerHeaders() : undefined;
}

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

// Google-Doc charts cache (and render) as plain TEXT, not as an image: the
// thumbnail rasterizes only the first page, and the Docs preview iframe
// scrolls internally so annotations can't stay aligned. Flat text has the
// full content and scrolls with the page.
export function isGoogleDocUrl(url) {
  return /docs\.google\.com\/document\/d\//.test(url || '');
}

// The URL we fetch to get cacheable bytes for a chart, or null if we can't
// (no worker configured and not a direct file). Text for Google Docs, image
// bytes for everything else.
export function chartImageFetchUrl(chartUrl, workerUrl) {
  const id = chartFileId(chartUrl);
  if (id && workerUrl) {
    return isGoogleDocUrl(chartUrl)
      ? `${workerUrl}/drive/file/${id}/text`
      : `${workerUrl}/drive/file/${id}/image`;
  }
  if (isDirectFile(chartUrl)) return chartUrl;
  return null;
}

// Fetch a Google-Doc chart's full text for live (uncached) rendering.
// Returns the text or null (not a doc, no worker, fetch failed, empty).
export async function fetchChartText(chartUrl, workerUrl) {
  const id = chartFileId(chartUrl);
  if (!id || !workerUrl || !isGoogleDocUrl(chartUrl)) return null;
  try {
    const res = await fetch(`${workerUrl}/drive/file/${id}/text`, { headers: workerHeaders() });
    if (!res.ok) {
      // Loud on purpose: a failure here silently degrades to the iframe
      // embed, whose internal scroll breaks annotation alignment.
      console.warn('[setlist] chart text fetch failed:', res.status, '— falling back to embed');
      return null;
    }
    const text = await res.text();
    return text.trim() ? text : null;
  } catch (e) {
    console.warn('[setlist] chart text fetch failed:', e.message, '— falling back to embed (worker unreachable or CORS)');
    return null;
  }
}

// True when a song has a chart that we could cache given current config.
export function isChartCacheable(song, workerUrl) {
  return !!(song?.chartUrl && chartImageFetchUrl(song.chartUrl, workerUrl));
}

// Download + store arbitrary chart bytes under an arbitrary cache key — used
// for alternate charts, keyed `${songId}::${altId}` (store.altChartKey). No
// song mutation and NO key auto-fill: an alternate may be a different
// arrangement in a different key/capo, and filling song.key from it would
// poison the primary's data. Returns { ok, blob?, size?, reason? }.
export async function cacheChartByUrl(cacheKey, chartUrl, workerUrl) {
  const url = chartImageFetchUrl(chartUrl, workerUrl);
  if (!url) return { ok: false, reason: 'needs worker' };
  try {
    const res = await fetch(url, { headers: headersForUrl(url, workerUrl) });
    if (!res.ok) return { ok: false, reason: `fetch ${res.status}` };
    const blob = await res.blob();
    if (!blob || blob.size === 0) return { ok: false, reason: 'empty' };
    // Only cache bytes that can actually render as a chart. An upstream that
    // slips an HTML error/login page through here would otherwise poison the
    // cache with a permanently broken "image".
    if (!isRenderableChartBlob(blob)) return { ok: false, reason: `not an image (${blob.type || 'unknown type'})` };
    await store.putChartBlob(cacheKey, blob, chartUrl);
    announceCached(cacheKey);
    return { ok: true, blob, size: blob.size };
  } catch (e) {
    return { ok: false, reason: e.message || 'fetch failed' };
  }
}

// Download + store one song's PRIMARY chart. Returns { songId, ok, reason }.
export async function cacheChartForSong(song, workerUrl) {
  if (!song?.chartUrl) return { songId: song?.id, ok: false, reason: 'no chart' };
  const r = await cacheChartByUrl(song.id, song.chartUrl, workerUrl);
  if (!r.ok) return { songId: song.id, ok: false, reason: r.reason };
  // A text chart's header usually states the key — fill an empty song.key
  // while the bytes are in hand. This also runs during bulk "download all
  // charts", so keys populate library-wide in one pass. Primary-only: the
  // URL-keyed path above deliberately skips this.
  if (!song.key && r.blob.type.startsWith('text/plain')) {
    try {
      const key = extractKeyFromChartText(await r.blob.text());
      if (key) { song.key = key; await store.putSong(song); }
    } catch {}
  }
  return { songId: song.id, ok: true, size: r.size };
}

function isRenderableChartBlob(blob) {
  return /^(?:image\/|application\/pdf|text\/plain)/.test(blob?.type || '');
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

// A song's cached chart, typed for rendering: {kind:'text', text} for
// Google-Doc charts cached as plain text, {kind:'image', url, blob} (an
// object URL the caller MUST URL.revokeObjectURL() when done, plus the raw
// blob so callers can run pixel processing like chart-enhance.js) for
// everything else, or null when not cached.
//
// Pass the song's current chartUrl as `expectedUrl` to guard against a stale
// blob: the cache is keyed by songId, so if the chart link later changed (e.g.
// a re-sync corrected a bad match) the old blob would otherwise keep rendering
// forever. When the cached sourceUrl doesn't match, we drop the stale entry and
// report a miss so the caller falls back to the live URL.
export async function getOfflineChart(songId, expectedUrl) {
  try {
    const rec = await store.getChartBlob(songId);
    if (rec?.blob) {
      if (expectedUrl && rec.sourceUrl && rec.sourceUrl !== expectedUrl) {
        await store.deleteChartBlob(songId);
        return null;
      }
      // Self-heal cache entries poisoned before blob validation existed
      // (e.g. a Google login page cached as the "image" for a private doc):
      // drop them and report a miss so the caller falls back to the live
      // iframe/URL rendering.
      if (!isRenderableChartBlob(rec.blob)) {
        await store.deleteChartBlob(songId);
        return null;
      }
      if (rec.blob.type.startsWith('text/plain')) {
        return { kind: 'text', text: await rec.blob.text() };
      }
      return { kind: 'image', url: URL.createObjectURL(rec.blob), blob: rec.blob };
    }
  } catch {}
  return null;
}
