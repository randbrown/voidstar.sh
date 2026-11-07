// Checks the deck's lick-practice math (src/lib/qualia/deck-practice.js):
//   node scripts/check-qualia-deck-practice.mjs
//
// - region resolve: open-ended A or B, swapped/too-short regions refused;
// - head position: wraps inside the loop window at any rate, clamps otherwise;
// - start offset: snaps into the region, rewinds a head parked at the end;
// - stretch routing: plain varispeed vs time-stretch, and the semitone math
//   that makes "pitch lock off" sound the same on either path;
// - seam crossfade: the wrap is continuous with real pre-roll, never a step
//   without it;
// - trainer: steps every N passes and stops exactly at the target.

import {
  resolveRegion, headPosition, startOffset, needsStretch, stretchSemitones,
  bakeRegionSeam, trainerAdvance, clampRate, clampTranspose, RATE_MIN, RATE_MAX,
} from '../src/lib/qualia/deck-practice.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

console.log('\nregion');
check('no marks → null', resolveRegion(-1, -1, 10) === null);
check('A only → A..end', JSON.stringify(resolveRegion(2, -1, 10)) === '{"lo":2,"hi":10}');
check('B only → 0..B', JSON.stringify(resolveRegion(-1, 3, 10)) === '{"lo":0,"hi":3}');
check('B past end clamps', resolveRegion(1, 99, 10).hi === 10);
check('too short refused', resolveRegion(2, 2.01, 10) === null);
check('inverted refused', resolveRegion(5, 4, 10) === null);
check('no track → null', resolveRegion(1, 2, 0) === null);

console.log('\nhead position');
check('plain 1×', near(headPosition(3, 2, 1, 10, null), 5));
check('half speed', near(headPosition(3, 2, 0.5, 10, null), 4));
check('clamps at end', headPosition(9, 5, 1, 10, null) === 10);
const lw = { lo: 2, hi: 4 };
check('wraps in loop', near(headPosition(3, 1.5, 1, 10, lw), 2.5));
check('wraps many passes at 0.65×', near(headPosition(2, 100, 0.65, 10, lw), 2 + (65 % 2)));
check('before loop end no wrap', near(headPosition(2, 1, 1, 10, lw), 3));

console.log('\nstart offset');
check('inside region kept', startOffset(3, 10, lw) === 3);
check('before region → A', startOffset(1, 10, lw) === 2);
check('at B → A', startOffset(4, 10, lw) === 2);
check('parked at end → top', startOffset(10, 10, null) === 0);
check('mid track kept', startOffset(5, 10, null) === 5);

console.log('\nstretch routing');
check('1× plain', !needsStretch(1, true, 0));
check('0.5× locked → stretch', needsStretch(0.5, true, 0));
check('0.5× unlocked → varispeed', !needsStretch(0.5, false, 0));
check('transpose always stretch', needsStretch(1, false, 2));
check('unlocked 0.5× = −12 st', near(stretchSemitones(0.5, false, 0), -12));
check('locked 0.5× +3 = +3 st', near(stretchSemitones(0.5, true, 3), 3));
check('rate clamps', clampRate(0.01) === RATE_MIN && clampRate(9) === RATE_MAX && clampRate('x') === 1);
check('transpose clamps', clampTranspose(40) === 12 && clampTranspose(-2.6) === -3);

console.log('\nseam crossfade');
{
  const sr = 48000, n = 4800;
  // A continuous sine; region = samples [1000, 1000+n), pre = the fade's worth before it.
  const sine = (i) => Math.sin(2 * Math.PI * 440 * i / sr);
  const fade = Math.round(0.008 * sr);
  const r = Float32Array.from({ length: n }, (_, i) => sine(1000 + i));
  const pre = Float32Array.from({ length: fade }, (_, i) => sine(1000 - fade + i));
  bakeRegionSeam([r], [pre], sr);
  const step = Math.abs(r[0] - r[n - 1]);
  const natural = Math.abs(sine(1000) - sine(999));
  check('wrap step ≈ one natural sample step', step <= natural * 1.5 + 1e-6, `step ${step.toFixed(4)} vs ${natural.toFixed(4)}`);
  check('tail ends on the sample before A', Math.abs(r[n - 1] - sine(999)) < 0.01);
  const r2 = Float32Array.from({ length: n }, () => 0.8);
  bakeRegionSeam([r2], null, sr);
  check('no pre-roll: fades to ~0 at both edges', Math.abs(r2[0]) < 0.01 && Math.abs(r2[n - 1]) < 0.01);
  check('no pre-roll: middle untouched', near(r2[n >> 1], 0.8, 1e-6));
}

console.log('\ntrainer');
{
  const cfg = { step: 0.05, every: 2, target: 1 };
  let rate = 0.5, passes = 0, steps = 0, done = false, guard = 0;
  while (!done && guard++ < 1000) {
    const r = trainerAdvance(rate, passes, cfg);
    if (r.rate !== rate) steps++;
    rate = r.rate; passes = r.passes; done = r.done;
  }
  check('reaches the target exactly', near(rate, 1), `rate ${rate}`);
  check('10 steps from 50 % at +5 %', steps === 10, `${steps} steps`);
  check('first pass of two holds', trainerAdvance(0.5, 0, cfg).rate === 0.5);
  check('second pass steps', near(trainerAdvance(0.5, 1, cfg).rate, 0.55));
  check('already at target → done', trainerAdvance(1, 1, cfg).done);
  check('never slows down', trainerAdvance(1.2, 1, cfg).rate === 1.2);
}

if (failed) { console.error(`\ncheck-qualia-deck-practice: ${failed} failure(s)`); process.exit(1); }
console.log('\ncheck-qualia-deck-practice: all ok');
