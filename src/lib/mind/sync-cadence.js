// Pure cadence math for the mind sync scheduler (sync-scheduler.js) —
// dependency-free so scripts/check-mind-sync-cadence.mjs can run it under
// plain node. All times are epoch ms; `rand` is injectable for tests.

export const CADENCE = {
  // Heartbeat while the tab is visible: tight while data is moving, relaxed
  // when idle. ±JITTER keeps a desk full of devices from polling in lockstep.
  ACTIVE_MS: 25_000,
  IDLE_MS: 90_000,
  // "Recently active" = a cycle moved data (pull or push) within this window.
  ACTIVE_WINDOW_MS: 5 * 60_000,
  JITTER: 0.15,
  // Minimum spacing between poked cycles, so an event storm (focus + online +
  // write in one gesture) coalesces into a single cycle.
  POKE_FLOOR_MS: 3_000,
  // Cycle-failure backoff ladder (network/Drive errors — auth failures are
  // throttled separately, they don't grow this ladder).
  BACKOFF_MS: [30_000, 60_000, 120_000, 300_000],
};

export function jitter(ms, rand = Math.random) {
  return Math.round(ms * (1 + (rand() * 2 - 1) * CADENCE.JITTER));
}

export function backoffDelay(failures) {
  const i = Math.min(Math.max(failures, 1), CADENCE.BACKOFF_MS.length) - 1;
  return CADENCE.BACKOFF_MS[i];
}

// Delay until the next steady-state heartbeat tick.
export function heartbeatDelay({ now, lastActivityAt = 0, failures = 0, rand = Math.random }) {
  if (failures > 0) return backoffDelay(failures);
  const active = now - lastActivityAt < CADENCE.ACTIVE_WINDOW_MS;
  return jitter(active ? CADENCE.ACTIVE_MS : CADENCE.IDLE_MS, rand);
}

// Delay for an event-driven poke (load/focus/online/write/…). User-initiated
// pokes cut through the failure backoff — the user just did something real and
// deserves a fresh attempt; programmatic pokes must respect it or a failing
// cycle re-arms itself in a tight loop.
export function pokeDelay({ now, lastCycleAt = 0, failures = 0, userInitiated = false }) {
  if (!userInitiated && failures > 0) return backoffDelay(failures);
  return Math.max(0, CADENCE.POKE_FLOOR_MS - (now - lastCycleAt));
}
