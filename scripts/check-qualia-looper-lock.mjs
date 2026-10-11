// Phrase-lock math for the looper's Strudel sync (src/lib/qualia/looper-lock.js).
// Run: node scripts/check-qualia-looper-lock.mjs
import assert from 'node:assert/strict';
import { mod, loopCycles, planLock, lockErrorSec, retroOutCycle } from '../src/lib/qualia/looper-lock.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

ok(mod(-1, 4) === 3 && mod(5, 4) === 1, 'mod wraps negatives');
ok(loopCycles(8, 0.5) === 4, 'loop of 8 s at 0.5 cps = 4 cycles');
ok(loopCycles(8.0001, 0.5) === 4, 'float noise snaps to integer cycles');
ok(near(loopCycles(3, 0.5), 1.5), 'non-integer (tile) periods are kept');

// A 4-cycle take whose head was played on cycle 5 (≡ 1 mod 4).
const take = { anchor: 5, loopDurSec: 8 };   // 4 cycles @ 0.5 cps

// Boundary start, grid 1, Strudel at 9.3 → next boundary is cycle 10, which is
// bar 1 of the take ((10 − 5) mod 4 = 1), not its head. The old code started
// the head there — a bar off the phrase.
{
  const p = planLock({ pos: 9.3, cps: 0.5, grid: 1, margin: 0.08, ...take });
  ok(near(p.aheadSec, 0.7 / 0.5), 'waits for the next grid boundary');
  ok(near(p.phase, 0.25), 'lands on bar 1 of the take, not its head');
}
// After a Strudel restart the counter is back near 0: cycle 1 ≡ the head.
{
  const p = planLock({ pos: 0.95, cps: 0.5, grid: 1, margin: 0.08, ...take });
  ok(near(p.phase, 0), 'restart: cycle 1 ≡ anchor 5 (mod 4) plays the head');
}
// Grid = loop length still phrase-locks via the anchor.
{
  const p = planLock({ pos: 6.2, cps: 0.5, grid: 4, margin: 0.08, ...take });
  ok(near(p.aheadSec, 1.8 / 0.5) && near(p.phase, (8 - 5) / 4), 'grid 4 → cycle 8 = bar 3');
}
// Immediate ("start now") drops in mid-loop at the locked phase.
{
  const p = planLock({ pos: 7.0, cps: 1, grid: 1, immediate: true, margin: 0.1, anchor: 5, loopDurSec: 4 });
  ok(near(p.aheadSec, 0.1) && near(p.phase, 2.1 / 4), 'immediate phase = (pos+margin − anchor) mod L');
}
// Legacy takes (no anchor) lock cycle ≡ 0 (mod L) to the head.
{
  const p = planLock({ pos: 3.9, cps: 0.5, grid: 1, loopDurSec: 8 });
  ok(near(p.phase, 0), 'legacy anchor 0: cycle 4 is the head');
}

// Lock error: a voice started in lock stays at ~0 error as both clocks advance.
{
  const p = planLock({ pos: 9.3, cps: 0.5, grid: 1, ...take });
  const when = p.aheadSec;                         // looper clock: now = 0
  const playStartAbs = when - p.phase * take.loopDurSec;
  for (const t of [1.5, 3, 7.9, 20]) {
    const err = lockErrorSec({ pos: 9.3 + t * 0.5, cps: 0.5, ...take, sinceStartSec: t - playStartAbs });
    ok(Math.abs(err) < 1e-9, `in-lock voice has ~0 error at t=${t}`);
  }
  // Strudel restarts (counter → 0) at t=10: the same voice is now 2.5 cycles = 5 s off.
  const t = 11;
  const err = lockErrorSec({ pos: 0.5, cps: 0.5, ...take, sinceStartSec: t - playStartAbs });
  ok(Math.abs(err) > 0.03, 'a Strudel restart shows up as lock error');
  ok(Math.abs(err) <= take.loopDurSec / 2 + 1e-9, 'error wraps to ±half a loop');
}
// Small drift is signed: voice 20 ms ahead → +0.02.
{
  const err = lockErrorSec({ pos: 6, cps: 0.5, anchor: 5, loopDurSec: 8, sinceStartSec: 2.02 });
  ok(near(err, 0.02, 1e-9), 'positive error = voice ahead');
}

// Retro OUT = nearest boundary (may be just ahead — caller waits for it).
ok(retroOutCycle(7.95, 4) === 8, 'grab pressed just before the downbeat keeps that phrase');
ok(retroOutCycle(8.3, 4) === 8, 'grab pressed just after the downbeat');
ok(retroOutCycle(9.2, 1) === 9, 'grid 1 nearest boundary');

console.log(`check-qualia-looper-lock: ${n} assertions passed`);

// Auto-length grab: count consecutive audible blocks back from OUT.
{
  const { countAudibleBlocks } = await import('../src/lib/qualia/looper-lock.js');
  const sr = 1000, block = 500;                    // 0.5 s blocks @ 1 kHz
  const a = new Float32Array(3000);                 // 6 blocks
  const fill = (from, to, amp) => { for (let i = from; i < to; i++) a[i] = amp * Math.sin(i); };
  fill(1000, 3000, 0.3);                            // last 4 blocks played, first 2 silent
  fill(0, 1000, 0.002);                             // hiss well under −40 dBFS
  assert.equal(countAudibleBlocks([a], 3000, block, 6, sr), 4, 'stops at the first silent block');
  assert.equal(countAudibleBlocks([a], 3000, block, 2, sr), 2, 'capped by maxBlocks (ring)');
  fill(2000, 2500, 0);                              // a fully silent block in the middle
  assert.equal(countAudibleBlocks([a], 3000, block, 6, sr), 1, 'a silent block ends the run');
  const s = new Float32Array(3000);
  assert.equal(countAudibleBlocks([s], 3000, block, 6, sr), 0, 'silence → 0 (caller keeps one block)');
  // Two blocks played, plus a short lead-in note poking into the end of the
  // block before them: the pickup is dropped, the grab is 2 blocks.
  const p = new Float32Array(3000);
  for (let i = 2000; i < 3000; i++) p[i] = 0.3 * Math.sin(i);
  for (let i = 1900; i < 2000; i++) p[i] = 0.3 * Math.sin(i);   // 100 ms pickup = 20 % of the block
  assert.equal(countAudibleBlocks([p], 3000, block, 6, sr), 2, 'a lead-in note doesn\'t keep its block');
  // A block that's half sounding (a sparse phrase) still counts.
  for (let i = 1500; i < 1750; i++) p[i] = 0.3 * Math.sin(i);
  assert.equal(countAudibleBlocks([p], 3000, block, 6, sr), 3, 'a half-played block counts');
  console.log('check-qualia-looper-lock: auto-length grab ok');
}
