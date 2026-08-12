// Smoke tests for the microtonal tuning math behind the Strudel helpers
// (`edo`, `edoscale`, `ji`, `cents`):
//   node scripts/check-qualia-edo.mjs
//
// Only microtonal.js is imported — the registration half in code-api.js
// isn't node-reachable (its strudel-reference.js import pulls JSON that
// only resolves under Vite); that half is exercised in the browser. A
// source-text scan below keeps the two halves and the funcs-tab reference
// honest with each other instead.

import { readFileSync } from 'node:fs';
import {
  DEFAULT_ROOT_HZ, midiToHz, hzToMidi, noteNameToMidi, parseRoot,
  edoFreq, centsFactor, parseEdoSpec, parseRatio, scaleDegree,
  TUNE_TABLES, parseTuneSpec, jiRetune,
} from '../src/lib/qualia/microtonal.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

section('note names → midi → Hz');
check('a4 = 440', near(parseRoot('a4'), 440));
check('c4 is the default root', near(DEFAULT_ROOT_HZ, 261.6255653005986) && near(parseRoot(), DEFAULT_ROOT_HZ));
check('bare letter defaults to octave 4', near(parseRoot('c'), DEFAULT_ROOT_HZ));
check('eb3 = d#3', noteNameToMidi('eb3') === noteNameToMidi('d#3'));
check('f#2 is midi 42', noteNameToMidi('f#2') === 42);
check('s works as sharp (mini-safe)', noteNameToMidi('as3') === noteNameToMidi('a#3'));
check('case-insensitive', noteNameToMidi('Eb3') === noteNameToMidi('eb3'));
check('negative octave parses', noteNameToMidi('c-1') === 0);
check('midiToHz(69) = 440', near(midiToHz(69), 440));
check('numeric root passes through as Hz', near(parseRoot(432), 432) && near(parseRoot('432'), 432));
check('junk root → null', parseRoot('h9') === null && parseRoot(-5) === null && parseRoot('xyz') === null);
check('injected converter wins', near(parseRoot('c4', () => 69), 440));
check('injected converter failure falls back', near(parseRoot('c4', () => { throw new Error('nope'); }), DEFAULT_ROOT_HZ));

section('edoFreq');
check('degree 0 = root', near(edoFreq(261.63, 31, 0), 261.63));
check('degree N = octave', near(edoFreq(261.63, 31, 31), 523.26));
check('negative degree folds down', near(edoFreq(440, 31, -31), 220));
check('31-EDO degree 18 ≈ perfect fifth', near(edoFreq(261.63, 31, 18), 261.63 * 2 ** (18 / 31)));
check('fractional degrees bend freely', near(edoFreq(100, 12, 0.5), 100 * 2 ** (1 / 24)));

section('centsFactor');
check('0 cents = unity', centsFactor(0) === 1);
check('1200 cents = octave', centsFactor(1200) === 2);
check('-1200 cents = octave down', near(centsFactor(-1200), 0.5));
check('100 cents = a 12-TET semitone', near(centsFactor(100), 2 ** (1 / 12)));

section('parseEdoSpec');
{
  const bare = parseEdoSpec(31);
  check('bare number → 31 divisions, c4 root, no subset',
    bare && bare.n === 31 && near(bare.rootHz, DEFAULT_ROOT_HZ) && bare.degrees === null);
  const s = parseEdoSpec('31');
  check('numeric string too', s && s.n === 31 && near(s.rootHz, DEFAULT_ROOT_HZ));
  const withRoot = parseEdoSpec('31:a3');
  check('note-name root', withRoot && near(withRoot.rootHz, 220));
  const hzRoot = parseEdoSpec('19:440');
  check('Hz root', hzRoot && hzRoot.n === 19 && near(hzRoot.rootHz, 440));
  const subset = parseEdoSpec('31:c4:0 5 10 13 18 23 28');
  check('degree subset (spaces)',
    subset && subset.degrees && subset.degrees.join(',') === '0,5,10,13,18,23,28');
  const commas = parseEdoSpec('31:c4:0,5,10');
  check('degree subset (commas)', commas && commas.degrees.join(',') === '0,5,10');
  check('junk → null',
    parseEdoSpec('zero') === null && parseEdoSpec('-31') === null
    && parseEdoSpec('31:h9') === null && parseEdoSpec('31:c4:0 x 5') === null);
}

section('parseRatio');
check('number passes through', parseRatio(1.25) === 1.25);
check('colon form (the mini-safe one)', parseRatio('3:2') === 1.5);
check('slash form (plain JS strings)', parseRatio('5/4') === 1.25);
check('colon and slash agree', parseRatio('3:2') === parseRatio('3/2'));
check('[num, den] mini colon pair', parseRatio([3, 2]) === 1.5);
check('{s, n} mini token pair (fallback shape)', parseRatio({ s: '5', n: '4' }) === 1.25);
check('decimal string', parseRatio('1.5') === 1.5);
check('junk → NaN',
  [parseRatio('x'), parseRatio('3:0'), parseRatio(-2), parseRatio(null),
   parseRatio([3, 0]), parseRatio([1, 2, 3])].every(Number.isNaN));

section('scaleDegree — subset indexing with octave wrap');
{
  const degs = [0, 5, 10, 13, 18, 23, 28]; // 7-note mode of 31-EDO
  check('index 0 = first degree', scaleDegree(degs, 31, 0) === 0);
  check('index 4 = fifth degree', scaleDegree(degs, 31, 4) === 18);
  check('index 7 wraps up an octave', scaleDegree(degs, 31, 7) === 31);
  check('index 8 = second degree + octave', scaleDegree(degs, 31, 8) === 36);
  check('index -1 wraps down', scaleDegree(degs, 31, -1) === 28 - 31);
  check('index -7 = root an octave down', scaleDegree(degs, 31, -7) === -31);
}

section('tuning tables');
for (const [name, t] of Object.entries(TUNE_TABLES)) {
  check(`${name} table: 12 entries inside the octave, never descending`,
    t.length === 12 && t[0] === 1 && t[11] < 2
    && t.every((r, i) => r >= 1 && r < 2 && (i === 0 || r >= t[i - 1])));
}
check('7-limit swaps in 7:5 and 7:4', TUNE_TABLES[7][6] === 7 / 5 && TUNE_TABLES[7][10] === 7 / 4);
check('neutral collapses both thirds → 11:9 and both sevenths → 11:6',
  TUNE_TABLES.neutral[3] === 11 / 9 && TUNE_TABLES.neutral[4] === 11 / 9
  && TUNE_TABLES.neutral[10] === 11 / 6 && TUNE_TABLES.neutral[11] === 11 / 6);
check('supermajor: 9:7 third, 8:7 second, 27:14 seventh',
  TUNE_TABLES.super[4] === 9 / 7 && TUNE_TABLES.super[2] === 8 / 7 && TUNE_TABLES.super[11] === 27 / 14);
check('subminor: 7:6 third, 14:9 sixth, 7:4 seventh',
  TUNE_TABLES.sub[3] === 7 / 6 && TUNE_TABLES.sub[8] === 14 / 9 && TUNE_TABLES.sub[10] === 7 / 4);
check('quarter-comma meantone: four fifths = pure 5:4 major third',
  Math.abs(TUNE_TABLES.meantone[4] - 5 / 4) < 1e-12);
check('meantone fifth ≈ 696.58¢',
  Math.abs(1200 * Math.log2(TUNE_TABLES.meantone[7]) - 696.578) < 0.01);
check('pythagorean: pure 3:2 fifth, wide 81:64 third, 729:512 tritone',
  TUNE_TABLES.pythagorean[7] === 3 / 2 && TUNE_TABLES.pythagorean[4] === 81 / 64
  && TUNE_TABLES.pythagorean[6] === 729 / 512);
check('harmonic: overtone slots 17:16, 19:16, 21:16, 11:8, 13:8, 7:4',
  TUNE_TABLES.harmonic[1] === 17 / 16 && TUNE_TABLES.harmonic[3] === 19 / 16
  && TUNE_TABLES.harmonic[5] === 21 / 16 && TUNE_TABLES.harmonic[6] === 11 / 8
  && TUNE_TABLES.harmonic[8] === 13 / 8 && TUNE_TABLES.harmonic[10] === 7 / 4);
check('well (Werckmeister III): 90¢ ♭2, pure 4:3 fourth, 696¢ fifth, 390¢ third',
  Math.abs(1200 * Math.log2(TUNE_TABLES.well[1]) - 90) < 1e-9
  && Math.abs(TUNE_TABLES.well[5] - 2 ** (498 / 1200)) < 1e-12
  && Math.abs(1200 * Math.log2(TUNE_TABLES.well[7]) - 696) < 1e-9
  && Math.abs(1200 * Math.log2(TUNE_TABLES.well[4]) - 390) < 1e-9);
check('hzToMidi inverts midiToHz', Math.abs(hzToMidi(midiToHz(57)) - 57) < 1e-9);

section('parseTuneSpec');
{
  const t5 = parseTuneSpec('c3');
  check('"c3" → 5-limit, root c3', t5 && t5.rootMidi === 48 && t5.ratios === TUNE_TABLES[5]
    && Math.abs(t5.rootHz - midiToHz(48)) < 1e-6);
  const t7 = parseTuneSpec('c3:7');
  check('"c3:7" → 7-limit', t7 && t7.ratios === TUNE_TABLES[7]);
  check('named tables + aliases resolve',
    parseTuneSpec('c3:neutral')?.ratios === TUNE_TABLES.neutral
    && parseTuneSpec('c3:11')?.ratios === TUNE_TABLES.neutral
    && parseTuneSpec('c3:supermajor')?.ratios === TUNE_TABLES.super
    && parseTuneSpec('c3:sub')?.ratios === TUNE_TABLES.sub
    && parseTuneSpec('c3:MEANTONE')?.ratios === TUNE_TABLES.meantone
    && parseTuneSpec('c3:quarter-comma')?.ratios === TUNE_TABLES.meantone
    && parseTuneSpec('c3:qc')?.ratios === TUNE_TABLES.meantone
    && parseTuneSpec('c3:pythagorean')?.ratios === TUNE_TABLES.pythagorean
    && parseTuneSpec('c3:pyth')?.ratios === TUNE_TABLES.pythagorean
    && parseTuneSpec('c3:3')?.ratios === TUNE_TABLES.pythagorean
    && parseTuneSpec('c3:harmonic')?.ratios === TUNE_TABLES.harmonic
    && parseTuneSpec('c3:harm')?.ratios === TUNE_TABLES.harmonic
    && parseTuneSpec('c3:overtone')?.ratios === TUNE_TABLES.harmonic
    && parseTuneSpec('c3:well')?.ratios === TUNE_TABLES.well
    && parseTuneSpec('c3:werckmeister')?.ratios === TUNE_TABLES.well
    && parseTuneSpec('c3:wm3')?.ratios === TUNE_TABLES.well);
  const hz = parseTuneSpec(440);
  check('bare Hz root → midi anchor 69', hz && hz.rootMidi === 69);
  const custom = parseTuneSpec('c3:1 16:15 9:8 6:5 5:4 4:3 7:5 3:2 8:5 5:3 7:4 15:8');
  check('custom 12-ratio table parses', custom && custom.ratios.length === 12 && custom.ratios[6] === 7 / 5);
  check('junk → null',
    parseTuneSpec('h9') === null && parseTuneSpec('c3:9:8') === null
    && parseTuneSpec('c3:1 2 3') === null && parseTuneSpec('c3:constructor') === null);
}

section('jiRetune — pitch-class snap with octave + cents survival');
{
  const { rootHz, rootMidi, ratios } = parseTuneSpec('c3');
  const r = (midi) => jiRetune(rootHz, rootMidi, ratios, midi);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check('root maps to itself', near(r(48), rootHz));
  check('E over c → exactly 5:4', near(r(52), rootHz * 5 / 4));
  check('A over c → exactly 5:3', near(r(57), rootHz * 5 / 3));
  check('octave above → 2×', near(r(60), rootHz * 2));
  check('E an octave up → 2 × 5:4', near(r(64), rootHz * 2 * 5 / 4));
  check('below the root wraps (B2 → 15:8 down an octave)', near(r(47), rootHz * (15 / 8) / 2));
  check('root octave is irrelevant (c5 anchor ≡ c3 anchor)', (() => {
    const hi = parseTuneSpec('c5');
    return near(jiRetune(hi.rootHz, hi.rootMidi, hi.ratios, 52), r(52));
  })());
  check('fractional midi keeps its cents on top of the snap',
    near(r(52.25), rootHz * (5 / 4) * 2 ** (0.25 / 12)));
  const s7 = parseTuneSpec('c3:7');
  check('7-limit b7: bb3 → 7:4', near(jiRetune(s7.rootHz, s7.rootMidi, s7.ratios, 58), s7.rootHz * 7 / 4));
}

section('registration ↔ reference honesty (source-text scan)');
{
  const codeApi = readFileSync(new URL('../src/lib/qualia/code-api.js', import.meta.url), 'utf8');
  const funcsJson = readFileSync(new URL('../src/data/qualia-functions.json', import.meta.url), 'utf8');
  const reference = JSON.parse(funcsJson);
  for (const name of ['edo', 'edoscale', 'ji', 'cents', 'jitune']) {
    check(`${name} is registered in code-api.js`,
      new RegExp(`define\\('${name}'`).test(codeApi));
    check(`${name} has a funcs-tab entry`,
      reference.some((f) => f.name === name));
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
