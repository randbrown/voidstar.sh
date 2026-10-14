// Node smoke test for the setlist lyrics matcher (src/lib/setlist/lyrics.js):
// LRCLIB hit scoring, the auto-fill threshold, rejected-id exclusion, and the
// candidate list the song page's "wrong — pick another" shows. fetch is
// stubbed, so this runs offline under plain node:
//   node scripts/check-setlist-lyrics.mjs

import { scoreLyricsHit, fetchLyrics, searchLyrics } from '../src/lib/setlist/lyrics.js';

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

// ── Scoring: a same-title song by another artist must not auto-accept ──

const right = { id: 1, trackName: 'Sold', artistName: 'John Michael Montgomery', duration: 167, plainLyrics: 'a' };
const wrong = { id: 2, trackName: 'Sold', artistName: 'Grace Potter', duration: 240, plainLyrics: 'b' };
const sR = scoreLyricsHit(right, 'Sold', 'John Michael Montgomery', 166);
const sW = scoreLyricsHit(wrong, 'Sold', 'John Michael Montgomery', 166);
check('right artist outranks same-title other artist', sR > sW);
check('other artist falls below the 0.7 auto-accept bar', sW < 0.7);
check('right artist clears the bar', sR >= 0.7);
check('no artist known → title alone still scores', scoreLyricsHit(wrong, 'Sold') >= 0.7);

// ── Stubbed LRCLIB ──

function stubFetch({ get = null, search = [] }) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/get')) {
      return get ? { ok: true, json: async () => get } : { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => search };
  };
}

// Exact /get hit that the user rejected → falls through to search, skipping it.
stubFetch({ get: wrong, search: [wrong, right] });
let r = await fetchLyrics('Sold', 'John Michael Montgomery', 166, { excludeIds: [2] });
check('rejected exact hit is skipped', r && r.id === 1);

// Only the wrong-artist hit exists → nothing auto-applied.
stubFetch({ get: null, search: [wrong] });
r = await fetchLyrics('Sold', 'John Michael Montgomery', 166);
check('lone wrong-artist hit is not auto-applied', r === null);

// Candidate list: ranked, deduped across the two queries, excludes rejected,
// skips instrumentals.
stubFetch({
  search: [wrong, right, { id: 3, trackName: 'Sold', artistName: 'X', instrumental: true, plainLyrics: '' }],
});
const list = await searchLyrics('Sold', 'John Michael Montgomery', { durationSec: 166 });
check('candidates deduped', list.length === 2);
check('candidates ranked best-first', list[0].id === 1);
const excl = await searchLyrics('Sold', 'John Michael Montgomery', { excludeIds: [1] });
check('excludeIds removes the rejected entry', excl.every((c) => c.id !== 1) && excl.length === 1);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nsetlist lyrics: all checks passed');
