// Node smoke test for chart-header parsing — the key (and tempo) a chart
// states in its top corner, which "read chart" turns into song.key/song.bpm.
// Pure functions only (no IndexedDB, no network):
//   node scripts/check-chart-key.mjs
//
// The client (src/lib/setlist/chart-key.js) and the worker
// (workers/setlist-sync/index.js) each carry their own copy of these patterns
// — the client parses doc text it already holds, the worker parses text it
// exports from Drive. This file runs BOTH against one shared table so the two
// can't drift apart silently.

import {
  extractKeyFromChartText,
  extractTempoFromChartText,
  normalizeKeyName,
} from '../src/lib/setlist/chart-key.js';
import {
  extractFromText,
  normalizeKeyName as workerNormalizeKeyName,
  normalizeChartRead,
  readConfidence,
  validChartReadImages,
  buildChartReadPrompt,
} from '../workers/setlist-sync/index.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

// ── Chart headers, as musicians actually write them ──
// The first entry is the reported case: a hand-written chart whose key sits in
// the top-left corner next to the time signature, which every pattern used to
// miss — the song stayed at "no key" however often "read chart" was run.
const HEADERS = [
  {
    name: 'key + time signature in the top corner (hand-written chart)',
    text: [
      "D|4/4        It's Five O'Clock Somewhere        Chart by Josh Ryan",
      '♩= 126                      Alan Jackson / Jimmy Buffett',
      'Traditional Country',
      '',
      'Intro',
      '| 1 3 4 5 | 1 |',
    ].join('\n'),
    key: 'D',
    bpm: 126,
  },
  { name: 'spaced key + time signature', text: 'Fancy\nBb 3/4\n', key: 'Bb', bpm: 0 },
  { name: 'dashed key + time signature', text: 'G-6/8\n', key: 'G', bpm: 0 },
  { name: 'minor key + time signature', text: 'Gm | 6/8\n', key: 'Gm', bpm: 0 },
  { name: 'labeled key still wins', text: 'A 4/4\nKey: E\n', key: 'E', bpm: 0 },
  { name: '"Key of G"', text: 'Key of G\n', key: 'G', bpm: 0 },
  { name: '"KEY - Bbm"', text: 'KEY - Bbm\n', key: 'Bbm', bpm: 0 },
  { name: 'bare key on its own line', text: 'Neon Moon\nC#m\n', key: 'C#m', bpm: 0 },
  // A labeled key in the OTHER top corner, with the artist under it — the
  // shape the vision route kept missing on scans.
  {
    name: 'labeled key in the far corner of the title line',
    text: 'DIXIELAND DELIGHT                    KEY: G   4/4\n                                     Alabama\n\n|I| 1 5 6- 4 |\n',
    key: 'G',
    bpm: 0,
  },
  { name: 'tempo label', text: 'Key: C\nTempo: 96\n', key: 'C', bpm: 96 },
  { name: 'tempo as a bpm suffix', text: 'Key: C\n132 bpm\n', key: 'C', bpm: 132 },
  { name: 'tempo as a typed quarter note', text: 'Key: C\nq = 120\n', key: 'C', bpm: 120 },
  // Negatives — a wrong key is worse than no key.
  { name: '"Key of Grace" is a title, not a key', text: 'Key of Grace\n', key: '', bpm: 0 },
  { name: 'a date in the header is not a time signature', text: 'Catoosa Fest 9/5/2026\nBb 9/5/2026\n', key: '', bpm: 0 },
  { name: 'a bar count with no key letter stays unparsed', text: 'Intro 5/4 groove\n', key: '', bpm: 0 },
  { name: 'a plain title line yields nothing', text: 'Amazing Grace\nwritten by John Newton\n', key: '', bpm: 0 },
  { name: 'a lyric far below the header never wins', text: `${'la la la\n'.repeat(40)}Key: F\n`, key: '', bpm: 0 },
  { name: 'an out-of-range tempo is ignored', text: 'Key: C\nTempo: 999\n', key: 'C', bpm: 0 },
];

console.log('chart header → key / bpm (client and worker must agree)');
for (const h of HEADERS) {
  const clientKey = extractKeyFromChartText(h.text);
  const clientBpm = extractTempoFromChartText(h.text);
  const worker = extractFromText(h.text);
  check(`${h.name}: key ${h.key || '(none)'}`, clientKey === h.key, `client got "${clientKey}"`);
  check(`${h.name}: bpm ${h.bpm || '(none)'}`, clientBpm === h.bpm, `client got ${clientBpm}`);
  check(`${h.name}: worker agrees`,
    (worker.inferredKey || '') === h.key && (worker.inferredBpm || 0) === h.bpm,
    `worker got key "${worker.inferredKey || ''}" / bpm ${worker.inferredBpm || 0}`);
}

// ── normalizeKeyName: a single value that is supposed to BE a key ──
// This is what the vision model hands back for a scanned chart, and it answers
// with what the page literally says.
const VALUES = [
  ['D|4/4', 'D'],
  ['D 4/4', 'D'],
  ['Key of D', 'D'],
  ['Key: Bb', 'Bb'],
  ['D major', 'D'],
  ['F# minor', 'F#m'],
  ['Dm', 'Dm'],
  ['Dm7', 'Dm'],
  ['d', 'D'],
  ['A♭', 'Ab'],
  ['', ''],
  ['N/A', ''],
  ['none', ''],
  ['unknown', ''],
  ['4/4', ''],
  ['Dixieland', ''],
];

console.log('\nnormalizeKeyName (the vision model\'s answer)');
for (const [input, want] of VALUES) {
  check(`"${input}" → ${want || '(none)'}`, normalizeKeyName(input) === want, `got "${normalizeKeyName(input)}"`);
  check(`"${input}" → ${want || '(none)'} (worker)`,
    workerNormalizeKeyName(input) === want, `got "${workerNormalizeKeyName(input)}"`);
}

// ── The worker's vision-read normalization and confidence gate ──
console.log('\nvision read normalization');
check('the corner marking survives as a key',
  normalizeChartRead({ found: true, key: 'D|4/4', bpm: 126, confidence: 0.6 })?.key === 'D');
check('bpm rides along', normalizeChartRead({ found: true, key: 'D|4/4', bpm: 126 })?.bpm === 126);
check('a labeled answer is no longer truncated into nothing',
  normalizeChartRead({ found: true, key: 'Key of D' })?.key === 'D');
check('a bare key still works', normalizeChartRead({ found: true, key: 'Bb' })?.key === 'Bb');
check('"not written" stays empty', normalizeChartRead({ found: true, key: 'N/A' }) === null);
check('found:false is nothing', normalizeChartRead({ found: false, key: 'D' }) === null);

// ── headerText fallback: what the model transcribed, parsed like chart text ──
// A model that won't commit to "the key" will still copy the corner out
// verbatim — that transcription is a second chance at the same answer.
console.log('\nheaderText fallback');
check('a corner key the model would not interpret is still found',
  normalizeChartRead({
    found: true, key: '', bpm: 0,
    headerText: 'DIXIELAND DELIGHT\nKEY: G   4/4\nAlabama',
  })?.key === 'G');
check('the corner shorthand works through it too',
  normalizeChartRead({ found: true, key: '', headerText: "D|4/4\nIt's Five O'Clock Somewhere" })?.key === 'D');
check('tempo comes out of the transcription as well',
  normalizeChartRead({ found: true, key: '', bpm: 0, headerText: 'Key: A\n♩ = 112' })?.bpm === 112);
check('a key the model DID report still wins',
  normalizeChartRead({ found: true, key: 'D', headerText: 'Key: G' })?.key === 'D');
check('a transcription with no key adds nothing',
  normalizeChartRead({ found: true, key: '', headerText: 'DIXIELAND DELIGHT\nAlabama' }) === null);

// ── request shapes for the vision route ──
console.log('\nchart-read request images');
const jpeg = (n) => ({ data: 'x'.repeat(n), mimeType: 'image/jpeg' });
check('page + corner crops all ride along',
  validChartReadImages({ images: [jpeg(10), jpeg(10), jpeg(10)] }).length === 3);
check('the older single-image shape still works',
  validChartReadImages({ image: 'xxxx', mimeType: 'image/png' }).length === 1);
check('a non-image mime type is refused',
  validChartReadImages({ image: 'xxxx', mimeType: 'application/pdf' }).length === 0);
check('an empty body is refused', validChartReadImages({}).length === 0);
check('too many images are capped', validChartReadImages({ images: [jpeg(4), jpeg(4), jpeg(4), jpeg(4)] }).length === 3);
check('the page survives when the extras would blow the size cap',
  validChartReadImages({ images: [jpeg(3_000_000), jpeg(3_000_000)] }).length === 1);

// ── the prompt has to ask for what the parsing above relies on ──
console.log('\nread prompt');
const prompt = buildChartReadPrompt('Dixieland Delight', 'Alabama', 2);
check('it asks for the header transcription', prompt.includes('headerText'));
check('it looks in BOTH top corners, not just the left',
  /left or right/i.test(prompt) && !/TOP-LEFT corner/.test(prompt));
check('it explains the extra images', /zoomed crops/i.test(prompt));
check('a single image gets no multi-image instructions',
  !/zoomed crops/i.test(buildChartReadPrompt('x', 'y', 1)));

console.log('\nconfidence gate');
check('a stated confidence is kept', readConfidence({ confidence: 0.5 }) === 0.5);
check('an omitted confidence means "it did not say", not "illegible"', readConfidence({}) === 1);
check('a non-numeric confidence is not zero', readConfidence({ confidence: 'high' }) === 1);
check('confidence is clamped', readConfidence({ confidence: 2 }) === 1 && readConfidence({ confidence: -1 }) === 0);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nchart key checks passed');
