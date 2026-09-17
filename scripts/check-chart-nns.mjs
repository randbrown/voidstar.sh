// Node smoke test for the Nashville numbers a generated chart doc carries —
// the de-capo that keeps them honest, and the "spell only what the legend
// can't" rule that keeps everything else pure numbers. Pure functions only
// (no IndexedDB, no network):
//   node scripts/check-chart-nns.mjs
//
// The worker (workers/setlist-sync/index.js, soundingChart) de-capoes at the
// source; the client (src/lib/setlist/chart-build.js, buildChartText) carries
// its own fallback so a site deploy fixes the numbers even against a worker
// deploy that predates it. This file runs BOTH against one shared table so
// they can't drift apart silently.

import {
  buildChartText,
  buildAiChartText,
  chordLegend,
  oddChordLine,
  shiftDegreeToken,
} from '../src/lib/setlist/chart-build.js';
import { extractKeyFromChartText, extractTempoFromChartText } from '../src/lib/setlist/chart-key.js';
import { soundingChart, extractFromText } from '../workers/setlist-sync/index.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

// ── The reported case ──
// "Choosin' Texas" (Ella Langley), key Db. Ultimate Guitar carries it as C
// shapes with a capo at fret 1, and its stated tonality is the SOUNDING key —
// so numbering the written shapes against Db put the whole chart a semitone
// flat: the opening 2- chord printed as "b2-".
const CHOOSIN = {
  tonality: 'Db',
  capo: 1,
  sections: [
    { name: 'Intro', chordLines: [['Dm', 'C', 'Dm', 'F', 'C']] },
    { name: 'Chorus', chordLines: [['F', 'C', 'Dm', 'G', 'F', 'Am', 'F', 'G']] },
  ],
};
const CHOOSIN_INTRO = '2-  1  2-  4  1';
const CHOOSIN_CHORUS = '4  1  2-  5  4  6-  4  5';

console.log('\n── worker: capo shapes → sounding numbers ──');
{
  const chart = soundingChart(CHOOSIN);
  const nns = (i) => chart.sections[i].lines[0].map(c => c.nns).join('  ');
  const chords = (i) => chart.sections[i].lines[0].map(c => c.chord).join(' ');
  check('stated tonality is kept as the key', chart.key === 'Db', chart.key);
  check('intro numbers', nns(0) === CHOOSIN_INTRO, nns(0));
  check('chorus numbers', nns(1) === CHOOSIN_CHORUS, nns(1));
  check('chords come back sounding, spelled for the key',
    chords(0) === 'Ebm Db Ebm Gb Db', chords(0));
  check('response flags the de-capo', chart.decapoed === true && chart.capo === 1);
}

console.log('\n── worker: an INFERRED key is the shape key, so it moves too ──');
{
  const chart = soundingChart({ ...CHOOSIN, tonality: '' });
  const nns = chart.sections[0].lines[0].map(c => c.nns).join('  ');
  check('key is raised by the capo', chart.key === 'Db', chart.key);
  check('flagged as inferred', chart.keyInferred === true);
  check('numbers match the stated-key read', nns === CHOOSIN_INTRO, nns);
}

console.log('\n── worker: no capo is a no-op ──');
{
  const chart = soundingChart({ ...CHOOSIN, capo: 0, tonality: 'C' });
  const line = chart.sections[0].lines[0];
  check('chords untouched', line.map(c => c.chord).join(' ') === 'Dm C Dm F C');
  check('numbers off the stated key', line.map(c => c.nns).join('  ') === '2-  1  2-  4  1');
}

// ── Client ──
// Payload shapes the client has to render: a current worker (already
// de-capoed) and an older deploy (raw capo shapes numbered against the
// sounding key — the bug as shipped).
const song = { title: "Choosin' Texas", artist: 'Ella Langley' };
const fromWorker = { ...soundingChart(CHOOSIN), source: 'ultimate-guitar', sourceUrl: 'https://ug/x' };
const fromOldWorker = {
  key: 'Db',
  keyInferred: false,
  capo: 1,
  source: 'ultimate-guitar',
  sourceUrl: 'https://ug/x',
  sections: CHOOSIN.sections.map(s => ({
    name: s.name,
    // What the pre-fix worker returned: written shapes, numbered against Db.
    lines: s.chordLines.map(line => line.map(chord => ({
      chord,
      nns: { Dm: 'b2-', C: '7', F: '3', G: 'b5', Am: 'b6-' }[chord],
    }))),
  })),
};

console.log('\n── client: both worker vintages render the same numbers ──');
for (const [label, data] of [['current worker', fromWorker], ['pre-fix worker', fromOldWorker]]) {
  const text = buildChartText(song, data);
  check(`${label}: intro numbers`, text.includes(`INTRO\n${CHOOSIN_INTRO}`), text);
  check(`${label}: chorus numbers`, text.includes(`CHORUS\n${CHOOSIN_CHORUS}`), text);
  check(`${label}: key in the corner shorthand`, text.includes('Db  4/4'), text);
}

console.log('\n── client: the format rules ──');
{
  const text = buildChartText(song, fromWorker);
  check('no capo position anywhere', !/capo\s*:/i.test(text), text);
  check('no chord-name line echoing the numbers', !text.includes('(Ebm  Db'), text);
  check('no number→chord legend', !text.includes('1=Db'), text);
  check('no labeled "Key:" block', !text.includes('Key: Db'), text);
  check('a capo source is noted as provenance, not as a position',
    text.includes('capo at fret 1; numbers are the sounding key'), text);
  check('no stale "delete the chord-name lines" instruction',
    !text.includes('delete the chord-name'), text);
}

console.log('\n── the generated header reads back ──');
{
  // "read chart" fills song.key/song.bpm off a doc's header, so the corner
  // shorthand this module writes has to be one the parsers recognise — in the
  // client (doc text already in hand) AND in the worker (text exported from
  // Drive). A header only one of them reads is a chart that loses its key on
  // the other path.
  const text = buildChartText({ ...song, bpm: 96 }, fromWorker);
  check('client reads the key back', extractKeyFromChartText(text) === 'Db', extractKeyFromChartText(text));
  check('client reads the tempo back', extractTempoFromChartText(text) === 96, String(extractTempoFromChartText(text)));
  const worker = extractFromText(text);
  check('worker reads the key back', worker.inferredKey === 'Db', JSON.stringify(worker));
  check('worker reads the tempo back', worker.inferredBpm === 96, JSON.stringify(worker));
  const ai = buildAiChartText({ title: 'Test', artist: 'X' }, {
    key: 'F#m', bpm: 132, time: '3/4', feel: '', confidence: 0.9,
    provider: 'claude', model: 'test', sources: [],
    sections: [{ name: 'Verse', comment: '', bars: ['1-', '4-', '1-', '5-'] }], notes: [],
  });
  check('a minor key survives the round trip too', extractKeyFromChartText(ai) === 'F#m', ai);
  check('the time signature rides along', ai.includes('F#m  3/4'), ai);
}

console.log('\n── spelling only what the legend cannot decode ──');
{
  // In C: 1 4 5 6- 2- 3- are the legend; b7, a major 2 (V/V) and b6 are not.
  check('diatonic section gets nothing',
    oddChordLine(['1', '4', '5', '6-', '2-'], 'C') === '');
  check('borrowed + secondary-dominant chords get named',
    oddChordLine(['1', 'b7', '2', '1'], 'C') === '  (b7=Bb  2=D)',
    oddChordLine(['1', 'b7', '2', '1'], 'C'));
  check('quality and slash bass ride along without confusing the degree',
    oddChordLine(['5(7)', '1/3', 'b6'], 'C') === '  (b6=Ab)',
    oddChordLine(['5(7)', '1/3', 'b6'], 'C'));
  check('a minor key numbers off its own tonic',
    oddChordLine(['1-', 'b3', '4-', '5'], 'Am') === '  (5=E)',
    oddChordLine(['1-', 'b3', '4-', '5'], 'Am'));
  check('NC is not a degree', oddChordLine(['NC', '1', '4'], 'C') === '');
  check('each odd chord is named once', oddChordLine(['b7', 'b7', 'b7'], 'C') === '  (b7=Bb)');
}

console.log('\n── the AI tier gets the same treatment ──');
{
  const ai = {
    key: 'A', bpm: 120, time: '4/4', feel: '', confidence: 0.9,
    provider: 'claude', model: 'test', sources: [],
    sections: [
      { name: 'Verse 1', comment: '', bars: ['1', '4', '1', '5'] },
      { name: 'Bridge', comment: '', bars: ['b3', 'b6', 'b3', '5'] },
    ],
    notes: ['mod up a whole step for the last chorus'],
  };
  const text = buildAiChartText({ title: 'Test', artist: 'X' }, ai);
  check('diatonic verse stays pure numbers',
    text.includes('VERSE 1\n1   4   1   5\n\n'), text);
  check('the out-of-key bridge is spelled out',
    text.includes('BRIDGE\nb3   b6   b3   5\n  (b3=C  b6=F)'), text);
  check('no capo position', !/capo\s*:/i.test(text), text);
}

console.log('\n── token arithmetic ──');
{
  check('b2- up a fret is 2-', shiftDegreeToken('b2-', 1) === '2-');
  check('7 up a fret is 1', shiftDegreeToken('7', 1) === '1');
  check('quality survives', shiftDegreeToken('b5(7)', 1) === '5(7)');
  check('slash bass moves with it', shiftDegreeToken('b2-/4', 1) === '2-/b5');
  check('NC is left alone', shiftDegreeToken('NC', 1) === 'NC');
  check('an unparseable token is left alone', shiftDegreeToken('Am', 1) === 'Am');
  check('legend for a minor key', chordLegend('Am') === '1-=Am  b3=C  4-=Dm  5-=Em  b6=F  b7=G',
    chordLegend('Am'));
  // Spelling follows the DEGREE's accidental, not the key's: the b3 of C minor
  // is Eb, and nobody writes the b7 of C as A#.
  check('flat degrees are spelled flat even in a sharp-looking key',
    chordLegend('Cm') === '1-=Cm  b3=Eb  4-=Fm  5-=Gm  b6=Ab  b7=Bb', chordLegend('Cm'));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall chart-number checks passed');
process.exit(failures ? 1 : 0);
