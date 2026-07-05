// Bulk library helpers — one-tap administrative passes over the whole song
// library (Library page → "library tools"), so keeping every song's key,
// metadata, lyrics, and steel summary filled in doesn't require opening each
// song by hand. Every pass is FILL-EMPTY: a value the user (or an earlier
// pass) already set is never overwritten. Passes run sequentially per song —
// gentle on the worker and the upstream APIs, and progress stays readable.
//
// This module is a leaf: views.js calls it; nothing here renders UI.

import * as store from './store.js';
import { getSources, deepScrapeChart, readChartImage, fetchSongMeta, fetchSteelSummary } from './sync.js';
import { fetchLyrics } from './lyrics.js';
import { cacheChartForSong, getOfflineChart } from './chart-cache.js';

// Fill-empty apply of a {field: value} update object onto a song, skipping
// internal `_`-prefixed fields. Returns how many fields were filled.
function applyEmptyFields(song, updates) {
  let n = 0;
  for (const [k, v] of Object.entries(updates || {})) {
    if (k.startsWith('_')) continue;
    const cur = song[k];
    if (cur === '' || cur === 0 || cur === null || cur === undefined) { song[k] = v; n++; }
  }
  return n;
}

// The "read chart" ladder for one song, shared by the song page's button and
// the bulk chart re-scan: scrape a doc chart's text export for key/bpm/capo/
// artist; if the key is still missing, make sure the chart bytes are cached
// (text charts fill the key inside cacheChartForSong), and AI-vision-read an
// image chart as the last step. Fill-empty; mutates `song` in place — the
// CALLER saves when `applied > 0`. `onStage` gets 'doc' | 'fetch' | 'ai' so
// button UIs can narrate. Returns {applied, problems}: `problems` carries the
// human-readable reason for every rung that failed, because a silent "no new
// data" reads as a dead button.
export async function readChartFields(song, onStage) {
  const problems = [];
  if (!getSources().workerUrl) {
    problems.push('no worker URL configured in Settings — both the doc scrape and the AI read need it');
  }
  onStage?.('doc');
  let applied = applyEmptyFields(song, await deepScrapeChart(song));
  if (!song.key) {
    // The vision read needs the chart bytes — fetch them on demand instead
    // of silently skipping when no offline pass has run yet.
    let cached = await getOfflineChart(song.id, song.chartUrl);
    if (!cached && getSources().workerUrl) {
      onStage?.('fetch');
      const r = await cacheChartForSong(song, getSources().workerUrl);
      if (r.ok) cached = await getOfflineChart(song.id, song.chartUrl);
      else problems.push(`couldn't fetch the chart: ${r.reason}`);
      // Text charts fill song.key from the header inside cacheChartForSong
      // (already persisted) — count it as a find.
      if (song.key) applied++;
    }
    if (!song.key && cached?.kind === 'image') {
      URL.revokeObjectURL(cached.url);
      if (cached.blob.type === 'application/pdf') {
        problems.push('this chart is a PDF — the AI read needs an image; link the scan as an image (or a Drive file, which proxies as one)');
      } else {
        onStage?.('ai');
        const read = await readChartImage(song, cached.blob);
        if (read.ok) applied += applyEmptyFields(song, read.data);
        else if (read.reason === 'no-ai-key') problems.push('no AI key configured on the worker — set ANTHROPIC_API_KEY or GEMINI_API_KEY to read scanned charts');
        else problems.push(`AI read failed: ${read.reason}`);
      }
    }
  }
  return { applied, problems };
}

// ── Bulk passes ──
// All return {total, updated, failures:[{song, reason}], ...} and report
// per-song progress via onProgress({done, total, updated, title}). A pass
// that can't run at all returns {aborted: reason} instead.

// Re-scan every linked chart for key/BPM/capo/artist/key-change metadata —
// the song page's "read chart", library-wide. The expensive AI vision rung
// only runs for songs still missing a key, so re-running this is cheap for
// an already-filled library.
export async function scanAllCharts(onProgress) {
  if (!getSources().workerUrl) return { aborted: 'no worker URL configured in Settings' };
  const songs = (await store.getAllSongs()).filter(s => s.chartUrl);
  let updated = 0;
  const failures = [];
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    try {
      const { applied, problems } = await readChartFields(song);
      if (applied) {
        await store.putSong(song);
        updated++;
      } else if (problems.length && !song.key) {
        // Only worth surfacing when the scan actually came up short — a
        // fully-filled song with a PDF chart isn't a problem to fix.
        failures.push({ song, reason: problems[problems.length - 1] });
      }
    } catch (e) {
      failures.push({ song, reason: e.message || 'scan failed' });
    }
    onProgress?.({ done: i + 1, total: songs.length, updated, title: song.title });
  }
  return { total: songs.length, updated, failures };
}

// "fetch info" library-wide: music-API metadata (artist/key/bpm/genre/year/
// length/artwork via the worker) + LRCLIB lyrics, for every song still
// missing any of it. Lyrics need no worker — this pass is useful even with
// nothing configured. Returns lyricsFilled separately since "songs without
// lyrics" is the headline use case.
export async function fetchInfoForAllSongs(onProgress) {
  const songs = await store.getAllSongs();
  const needsInfo = (s) => !s.artist || !s.key || !s.bpm || !s.genre || !s.year
    || !s.durationSec || !s.artworkUrl || !s.lyrics || !s.syncedLyrics;
  const targets = songs.filter(needsInfo);
  let updated = 0;
  let lyricsFilled = 0;
  const failures = [];
  for (let i = 0; i < targets.length; i++) {
    const song = targets[i];
    try {
      const meta = await fetchSongMeta(song); // null without a worker — lyrics still run
      let applied = 0;
      if (meta) {
        applied += applyEmptyFields(song, {
          artist: meta.artist || '',
          key: meta.key || '',
          bpm: meta.bpm || 0,
          genre: meta.genre || '',
          year: meta.year || 0,
          durationSec: meta.durationSec || 0,
          artworkUrl: /^https:\/\//.test(meta.artworkUrl || '') ? meta.artworkUrl : '',
        });
      }
      if (!song.lyrics || !song.syncedLyrics) {
        const lyr = await fetchLyrics(song.title, song.artist || '', song.durationSec || 0);
        if (lyr) {
          const hadLyrics = !!song.lyrics;
          applied += applyEmptyFields(song, { lyrics: lyr.plain, syncedLyrics: lyr.synced });
          if (!hadLyrics && song.lyrics) lyricsFilled++;
        }
      }
      if (applied) {
        await store.putSong(song);
        updated++;
      }
    } catch (e) {
      failures.push({ song, reason: e.message || 'fetch failed' });
    }
    onProgress?.({ done: i + 1, total: targets.length, updated, title: song.title });
  }
  return { total: targets.length, updated, lyricsFilled, skipped: songs.length - targets.length, failures };
}

// AI steel summaries for every song that doesn't have one yet. Each summary
// is a web-search-grounded LLM call (~15-30 s per song), so ONLY missing
// ones are generated — regenerating a single song stays on its song page.
// A worker/AI-config problem aborts the whole pass instead of failing N
// times with the same reason.
export async function summarizeSteelForAllSongs(onProgress) {
  if (!getSources().workerUrl) return { aborted: 'no worker URL configured in Settings' };
  const targets = (await store.getAllSongs()).filter(s => !s.steelSummary);
  let updated = 0;
  const failures = [];
  // Some config problems only show up as a per-song error (an exhausted API
  // credit balance is a 400 on every call, not a 'no-ai-key'). When the same
  // reason repeats back-to-back it isn't about the songs — stop burning
  // 15-30 s per remaining song and surface the reason once.
  const SAME_FAILURE_LIMIT = 3;
  let lastReason = null;
  let sameReasonRun = 0;
  for (let i = 0; i < targets.length; i++) {
    const song = targets[i];
    const r = await fetchSteelSummary(song);
    if (r.ok) {
      song.steelSummary = r.data.summary;
      await store.putSong(song);
      updated++;
      lastReason = null;
      sameReasonRun = 0;
    } else if (r.reason === 'no-ai-key') {
      return { aborted: 'no AI key configured on the worker — set ANTHROPIC_API_KEY or GEMINI_API_KEY', total: targets.length, updated, failures };
    } else if (r.reason === 'worker-outdated') {
      return { aborted: 'worker outdated — redeploy workers/setlist-sync to get /ai/steel-summary', total: targets.length, updated, failures };
    } else {
      failures.push({ song, reason: r.reason });
      sameReasonRun = r.reason === lastReason ? sameReasonRun + 1 : 1;
      lastReason = r.reason;
      if (sameReasonRun >= SAME_FAILURE_LIMIT) {
        return {
          aborted: `stopped — ${sameReasonRun} songs in a row failed the same way: ${r.reason}`,
          total: targets.length, updated, failures,
        };
      }
    }
    onProgress?.({ done: i + 1, total: targets.length, updated, title: song.title });
  }
  return { total: targets.length, updated, skipped: 0, failures };
}

// The health dimensions — one predicate per "is this filled in?" question,
// shared by the library-wide report and the song page's per-song checkup so
// the two can never disagree about what "complete" means.
const HEALTH_CHECKS = [
  { key: 'noKey', label: 'no key', missing: s => !s.key },
  { key: 'noChart', label: 'no chart linked', missing: s => !s.chartUrl },
  { key: 'noLyrics', label: 'no lyrics', missing: s => !s.lyrics },
  { key: 'noSpotify', label: 'no spotify link', missing: s => !s.spotifyUri },
  { key: 'noArtist', label: 'no artist', missing: s => !s.artist },
  { key: 'noSteelSummary', label: 'no steel summary', missing: s => !s.steelSummary },
];

// Per-song checkup — the library health check, this song only. Returns the
// labels of everything still missing (empty array = fully filled in).
export function songHealth(song) {
  return HEALTH_CHECKS.filter(c => c.missing(song)).map(c => c.label);
}

// Library health report — what's still missing, per dimension, so "is
// everything filled in?" is one tap instead of a walk through every song.
// Pure local read; each entry lists the actual songs so the UI can link them.
export async function libraryHealth() {
  const songs = await store.getAllSongs();
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  return {
    total: songs.length,
    checks: HEALTH_CHECKS.map(c => ({
      key: c.key,
      label: c.label,
      songs: songs.filter(c.missing).sort(byTitle),
    })),
  };
}
