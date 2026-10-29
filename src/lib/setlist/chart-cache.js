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
import { extractKeyFromChartText, extractTempoFromChartText } from './chart-key.js';
import { isPdfBlob, rasterizePdfStack } from './chart-pdf.js';

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
// `fresh` skips the browser HTTP cache (the worker answers with a 5-min
// max-age), so an edit made in Google Docs a moment ago is actually seen.
export async function fetchChartText(chartUrl, workerUrl, { fresh = false } = {}) {
  const id = chartFileId(chartUrl);
  if (!id || !workerUrl || !isGoogleDocUrl(chartUrl)) return null;
  try {
    const res = await fetch(`${workerUrl}/drive/file/${id}/text`, {
      headers: workerHeaders(),
      cache: fresh ? 'no-store' : 'default',
    });
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
// `fresh` (the user-pressed "↻ re-fetch") bypasses the browser HTTP cache —
// the worker's max-age would otherwise hand back the pre-edit bytes.
export async function cacheChartByUrl(cacheKey, chartUrl, workerUrl, { fresh = false } = {}) {
  const url = chartImageFetchUrl(chartUrl, workerUrl);
  if (!url) return { ok: false, reason: 'needs worker' };
  try {
    const res = await fetch(url, {
      headers: headersForUrl(url, workerUrl),
      cache: fresh ? 'no-store' : 'default',
    });
    if (!res.ok) return { ok: false, reason: `fetch ${res.status}` };
    const blob = await res.blob();
    if (!blob || blob.size === 0) return { ok: false, reason: 'empty' };
    // Only cache bytes that can actually render as a chart. An upstream that
    // slips an HTML error/login page through here would otherwise poison the
    // cache with a permanently broken "image".
    if (!isRenderableChartBlob(blob)) return { ok: false, reason: `not an image (${blob.type || 'unknown type'})` };
    const stored = await storeChartBlob(cacheKey, blob, chartUrl);
    announceCached(cacheKey);
    return { ok: true, blob: stored, size: stored.size };
  } catch (e) {
    return { ok: false, reason: e.message || 'fetch failed' };
  }
}

// Download + store one song's PRIMARY chart. Returns { songId, ok, reason }.
export async function cacheChartForSong(song, workerUrl, opts) {
  if (!song?.chartUrl) return { songId: song?.id, ok: false, reason: 'no chart' };
  const r = await cacheChartByUrl(song.id, song.chartUrl, workerUrl, opts);
  if (!r.ok) return { songId: song.id, ok: false, reason: r.reason };
  // A text chart's header usually states the key (and the tempo) — fill the
  // empty ones while the bytes are in hand. This also runs during bulk
  // "download all charts", so keys populate library-wide in one pass.
  // Primary-only: the URL-keyed path above deliberately skips this.
  if ((!song.key || !song.bpm) && r.blob.type.startsWith('text/plain')) {
    try {
      const text = await r.blob.text();
      let filled = false;
      if (!song.key) {
        const key = extractKeyFromChartText(text);
        if (key) { song.key = key; filled = true; }
      }
      if (!song.bpm) {
        const bpm = extractTempoFromChartText(text);
        if (bpm) { song.bpm = bpm; filled = true; }
      }
      if (filled) await store.putSong(song);
    } catch {}
  }
  return { songId: song.id, ok: true, size: r.size };
}

// Stale-while-revalidate for Google-Doc charts. The offline cache is keyed by
// URL, and editing the Doc keeps the URL — so without this a cached chart
// never picks up edits. Callers render the cached text first (works offline),
// then call this: it refetches the live export (bypassing the HTTP cache)
// and, when the text changed, rewrites the cache entry and resolves to the
// new text so the caller can swap it in. Resolves null when unchanged, not a
// doc, offline, or the fetch failed. Throttled per key so swiping back and
// forth in perform mode doesn't refetch every time.
const REVALIDATE_MIN_MS = 60_000;
const lastRevalidated = new Map();
export async function revalidateTextChart(cacheKey, chartUrl, cachedText) {
  if (!isGoogleDocUrl(chartUrl)) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  const now = Date.now();
  if (now - (lastRevalidated.get(cacheKey) || 0) < REVALIDATE_MIN_MS) return null;
  lastRevalidated.set(cacheKey, now);
  const text = await fetchChartText(chartUrl, getSources().workerUrl, { fresh: true });
  if (!text || text === cachedText) return null;
  try {
    await store.putChartBlob(cacheKey, new Blob([text], { type: 'text/plain; charset=utf-8' }), chartUrl);
    announceCached(cacheKey);
  } catch {}
  return text;
}

// `full` on a cache entry says how it was rendered. Absent: a Drive file's
// page-1 thumbnail from before whole-document caching. `true`: whole-document
// rendering, but before pdf.js had its image decoders wired in — a scanned
// PDF (JBIG2 / CCITT / JPEG 2000 page images) rasterized as a blank white
// page, which dark mode shows as solid black. FULL_RENDER: current. Drive
// entries older than that get re-fetched once (see isStaleChartRecord).
export const FULL_RENDER = 2;

// Only a PNG can be one of those blank PDF rasters, so a JPEG/text entry
// from the `true` era is still good.
function isStaleChartRecord(rec, url) {
  if (!isDriveFileChart(url)) return false;
  if (!rec.full) return true;
  return rec.full !== FULL_RENDER && rec.blob?.type === 'image/png';
}

// Store a fetched chart. PDFs are rasterized here — every page, stacked
// into one tall PNG (chart-pdf.js) — so every render path keeps handling a
// single flat image.
async function storeChartBlob(cacheKey, blob, chartUrl) {
  if (isPdfBlob(blob)) {
    const r = await rasterizePdfStack(blob);
    await migratePageOneAnnotation(cacheKey, r);
    blob = r.blob;
  }
  await store.putChartBlob(cacheKey, blob, chartUrl, { full: FULL_RENDER });
  return blob;
}

// Annotations normalize y to the chart box's height, so when a page-1-only
// render (the old cache / the live Drive thumbnail) gives way to the full
// page stack, ink drawn on page 1 would stretch down the whole document.
// A layer authored at page 1's aspect gets its y compressed by
// stackHeight/page1Height so it stays on page 1.
async function migratePageOneAnnotation(cacheKey, { pages, aspect, firstPageAspect }) {
  if (pages < 2) return;
  const ann = await store.getAnnotation(cacheKey);
  if (!ann?.aspect || !ann.strokes?.length) return;
  if (Math.abs(ann.aspect / firstPageAspect - 1) > 0.03) return;
  const f = aspect / ann.aspect;
  for (const s of ann.strokes) {
    if (s.type === 'text') s.y *= f;
    else if (s.points) for (const p of s.points) p.y *= f;
  }
  await store.putAnnotation({ ...ann, aspect });
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
  const stale = new Set();
  if (skipCached) {
    const cachedIds = new Set(await store.getCachedChartIds());
    // A stale Drive render (page-1-only, or a possibly-blank PDF raster)
    // counts as missing, so auto-cache re-renders it (fresh: the browser may
    // still hold the worker's old response).
    for (const s of withCharts) {
      if (!cachedIds.has(s.id) || !isDriveFileChart(s.chartUrl)) continue;
      const rec = await store.getChartBlob(s.id);
      if (rec && isStaleChartRecord(rec, rec.sourceUrl || s.chartUrl)) { cachedIds.delete(s.id); stale.add(s.id); }
    }
    const before = withCharts.length;
    withCharts = withCharts.filter(s => !cachedIds.has(s.id));
    skipped = before - withCharts.length;
  }

  const results = [];
  let ok = 0, failed = 0;
  for (let i = 0; i < withCharts.length; i++) {
    const r = await cacheChartForSong(withCharts[i], workerUrl, { fresh: stale.has(withCharts[i].id) });
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

// Drive-file charts cached by an older renderer (a page-1 thumbnail, or a PDF
// raster that may be blank — see FULL_RENDER) are flagged `stale` by
// getOfflineChart. This re-fetches one (the worker now serves PDFs raw) —
// real images just get re-downloaded once, after which the entry is marked
// current either way.
// Concurrent calls for one key share a fetch. Resolves cacheChartByUrl's
// result, or null when there's nothing to do (offline / no worker).
const refreshing = new Map();
export function refreshStaleChart(cacheKey, chartUrl) {
  if (refreshing.has(cacheKey)) return refreshing.get(cacheKey);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(null);
  const workerUrl = getSources().workerUrl;
  if (!workerUrl) return Promise.resolve(null);
  const p = cacheChartByUrl(cacheKey, chartUrl, workerUrl, { fresh: true })
    .finally(() => refreshing.delete(cacheKey));
  refreshing.set(cacheKey, p);
  return p;
}

function isDriveFileChart(url) {
  return !!chartFileId(url) && !isGoogleDocUrl(url);
}

// A song's cached chart, typed for rendering: {kind:'text', text} for
// Google-Doc charts cached as plain text, {kind:'image', url, blob} (an
// object URL the caller MUST URL.revokeObjectURL() when done, plus the raw
// blob so callers can run pixel processing like chart-enhance.js) for
// everything else, or null when not cached. `stale` on an image marks a
// Drive render from an older renderer (see FULL_RENDER) — see
// refreshStaleChart.
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
      // A raw PDF (a direct .pdf link cached before PDFs were rasterized)
      // can't render in an <img> — rasterize every page and re-store.
      if (isPdfBlob(rec.blob)) {
        const blob = await storeChartBlob(songId, rec.blob, rec.sourceUrl || expectedUrl || '');
        return { kind: 'image', url: URL.createObjectURL(blob), blob };
      }
      const stale = isStaleChartRecord(rec, rec.sourceUrl || expectedUrl);
      return { kind: 'image', url: URL.createObjectURL(rec.blob), blob: rec.blob, stale };
    }
  } catch {}
  return null;
}
