// Smoke tests for the mind sync scheduler's cadence math — pure functions
// only (no browser APIs), so they run under plain node:
//   node scripts/check-mind-sync-cadence.mjs
//
// Covers: active vs idle heartbeat selection, jitter bounds, the failure
// backoff ladder (growth, cap, and that user-initiated pokes cut through it),
// and poke-floor coalescing.

import { CADENCE, jitter, backoffDelay, heartbeatDelay, pokeDelay } from '../src/lib/mind/sync-cadence.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const NOW = 1_800_000_000_000;

// ── (a) jitter stays inside ±JITTER and is deterministic under injected rand ──
section('(a) jitter bounds');
{
  const lo = jitter(1000, () => 0);   // rand 0 → -JITTER
  const hi = jitter(1000, () => 1);   // rand 1 → +JITTER
  const mid = jitter(1000, () => 0.5);
  check('rand 0 → low edge', lo === Math.round(1000 * (1 - CADENCE.JITTER)), String(lo));
  check('rand 1 → high edge', hi === Math.round(1000 * (1 + CADENCE.JITTER)), String(hi));
  check('rand 0.5 → base', mid === 1000, String(mid));
  let inBounds = true;
  for (let i = 0; i < 500; i++) {
    const v = jitter(CADENCE.IDLE_MS);
    if (v < CADENCE.IDLE_MS * (1 - CADENCE.JITTER) - 1 || v > CADENCE.IDLE_MS * (1 + CADENCE.JITTER) + 1) inBounds = false;
  }
  check('500 random samples in bounds', inBounds);
}

// ── (b) heartbeat: active window → tight cadence, idle → relaxed ──
section('(b) heartbeat active/idle selection');
{
  const active = heartbeatDelay({ now: NOW, lastActivityAt: NOW - 60_000, rand: () => 0.5 });
  const idle = heartbeatDelay({ now: NOW, lastActivityAt: NOW - CADENCE.ACTIVE_WINDOW_MS - 1, rand: () => 0.5 });
  const never = heartbeatDelay({ now: NOW, rand: () => 0.5 }); // lastActivityAt omitted → 0
  check('recent activity → ACTIVE_MS', active === CADENCE.ACTIVE_MS, String(active));
  check('stale activity → IDLE_MS', idle === CADENCE.IDLE_MS, String(idle));
  check('no activity ever → IDLE_MS', never === CADENCE.IDLE_MS, String(never));
  const boundary = heartbeatDelay({ now: NOW, lastActivityAt: NOW - CADENCE.ACTIVE_WINDOW_MS + 1, rand: () => 0.5 });
  check('just inside window → ACTIVE_MS', boundary === CADENCE.ACTIVE_MS, String(boundary));
}

// ── (c) failure backoff ladder: growth, cap, and heartbeat adoption ──
section('(c) backoff ladder');
{
  check('1 failure → first rung', backoffDelay(1) === CADENCE.BACKOFF_MS[0]);
  check('2 failures → second rung', backoffDelay(2) === CADENCE.BACKOFF_MS[1]);
  const last = CADENCE.BACKOFF_MS[CADENCE.BACKOFF_MS.length - 1];
  check('failures past the ladder cap at the last rung', backoffDelay(99) === last);
  check('0/negative clamps to first rung', backoffDelay(0) === CADENCE.BACKOFF_MS[0] && backoffDelay(-3) === CADENCE.BACKOFF_MS[0]);
  const hb = heartbeatDelay({ now: NOW, lastActivityAt: NOW, failures: 3, rand: () => 0.5 });
  check('heartbeat under failures uses the ladder (no jitter shortcut)', hb === CADENCE.BACKOFF_MS[2], String(hb));
}

// ── (d) poke: floor coalescing + backoff interplay ──
section('(d) poke delays');
{
  const fresh = pokeDelay({ now: NOW, lastCycleAt: NOW - CADENCE.POKE_FLOOR_MS - 1 });
  check('old last cycle → immediate', fresh === 0, String(fresh));
  const recent = pokeDelay({ now: NOW, lastCycleAt: NOW - 1_000 });
  check('recent cycle → waits out the floor', recent === CADENCE.POKE_FLOOR_MS - 1_000, String(recent));
  const never = pokeDelay({ now: NOW }); // lastCycleAt 0 → way past the floor
  check('no cycle yet → immediate', never === 0, String(never));
  const backedOff = pokeDelay({ now: NOW, lastCycleAt: NOW, failures: 2 });
  check('programmatic poke under failures respects backoff', backedOff === CADENCE.BACKOFF_MS[1], String(backedOff));
  const user = pokeDelay({ now: NOW, lastCycleAt: NOW, failures: 2, userInitiated: true });
  check('user poke cuts through backoff (floor only)', user === CADENCE.POKE_FLOOR_MS, String(user));
}

// ── (e) sanity: constants keep polling cheap and convergence useful ──
section('(e) constant sanity');
{
  check('active cadence ≥ 15s (quota/battery sane)', CADENCE.ACTIVE_MS >= 15_000);
  check('idle cadence ≤ 3min (still converges usefully)', CADENCE.IDLE_MS <= 180_000);
  check('backoff caps ≤ 10min', CADENCE.BACKOFF_MS[CADENCE.BACKOFF_MS.length - 1] <= 600_000);
  check('ladder is monotonic', CADENCE.BACKOFF_MS.every((v, i, a) => i === 0 || v > a[i - 1]));
}

console.log('');
if (failed) { console.error(`${failed} check(s) FAILED`); process.exit(1); }
console.log('all sync-cadence checks passed');
