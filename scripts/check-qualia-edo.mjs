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
  DEFAULT_ROOT_HZ, midiToHz, noteNameToMidi, parseRoot,
  edoFreq, centsFactor, parseEdoSpec, parseRatio, scaleDegree,
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

section('registration ↔ reference honesty (source-text scan)');
{
  const codeApi = readFileSync(new URL('../src/lib/qualia/code-api.js', import.meta.url), 'utf8');
  const funcsJson = readFileSync(new URL('../src/data/qualia-functions.json', import.meta.url), 'utf8');
  const reference = JSON.parse(funcsJson);
  for (const name of ['edo', 'edoscale', 'ji', 'cents']) {
    check(`${name} is registered in code-api.js`,
      new RegExp(`define\\('${name}'`).test(codeApi));
    check(`${name} has a funcs-tab entry`,
      reference.some((f) => f.name === name));
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
