// Sync scheduler — the single owner of WHEN the mind app talks to Drive
// (gdrive-sync.js owns HOW). A visibility-gated heartbeat plus event pokes
// replace the old watchFocusSync: a passively open device now converges within
// one tick instead of waiting for a refocus, failures retry with backoff
// instead of dying in a console.warn, and every outcome lands in the sync
// event log (Settings → diagnostics).
//
// Triggers funneled here:
//   load / visible / focus / online — user-ish: cut through the failure backoff
//   write — the debounced store-write push (routed via setWritePoker)
//   flush — page hiding with a pending write timer (runs even when hidden)
//   token-renewed — the gesture-scoped silent renewal succeeded
//   heartbeat / rearm — steady state
//
// Cadence math is pure (sync-cadence.js), node-tested by
// scripts/check-mind-sync-cadence.mjs.

import { heartbeatDelay, pokeDelay } from './sync-cadence.js';
import {
  initGdriveSync, setSyncClient, getSyncClient, pullMergePushIfStale,
  hasClientId, isLocalDirty, needsReconnect, setSyncState, logSyncEvent,
  setWritePoker, setSchedulerDiag, armGestureRenewal, preloadGis,
  flushDebouncedPush,
} from './gdrive-sync.js';

let _cfg = null;
let _started = false;
let _timer = null;
let _nextAt = 0;
let _running = false;
let _failures = 0;      // consecutive cycle failures (network/Drive — not auth)
let _lastCycleAt = 0;
let _lastActivityAt = 0; // last time a cycle actually moved data
let _lastOutcome = '';

function clearTimer() {
  if (_timer) { clearTimeout(_timer); _timer = null; _nextAt = 0; }
}

// Keep whichever run is sooner — a later poke never displaces a queued
// earlier one, and an earlier poke replaces a far-off heartbeat.
function schedule(delayMs, trigger) {
  const at = Date.now() + delayMs;
  if (_timer && _nextAt <= at) return;
  clearTimer();
  _nextAt = at;
  _timer = setTimeout(() => { _timer = null; _nextAt = 0; runCycle(trigger); }, delayMs);
}

function scheduleHeartbeat() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  schedule(heartbeatDelay({ now: Date.now(), lastActivityAt: _lastActivityAt, failures: _failures }), 'heartbeat');
}

export function syncSoon(trigger, { userInitiated = false } = {}) {
  if (!_started) return;
  schedule(pokeDelay({ now: Date.now(), lastCycleAt: _lastCycleAt, failures: _failures, userInitiated }), trigger);
}

async function runCycle(trigger) {
  if (_running) { scheduleHeartbeat(); return; }
  // Hidden tabs don't sync (the visible poke re-enters) — except the flush of
  // a pending write on the way out. Offline waits for the 'online' poke.
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible' && trigger !== 'flush') return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (!hasClientId()) { scheduleHeartbeat(); return; }
  _running = true;
  try {
    let client = getSyncClient();
    if (!client) {
      client = await initGdriveSync({ interactive: false }).catch(() => null);
      if (client) setSyncClient(client);
    }
    if (!client) {
      // No token obtainable in the background (GIS renewal is popup-bound —
      // see armGestureRenewal). The next real gesture or a pill tap recovers;
      // this is not a network failure, so it doesn't grow the backoff ladder.
      _lastOutcome = 'no-token';
      if (needsReconnect()) setSyncState('reconnect');
      logSyncEvent(trigger, 'no-token');
      return;
    }
    // State emissions (syncing/synced/error/reconnect/offline) live inside
    // pullMergePushCycle/IfStale so manual cycles report identically.
    const res = await pullMergePushIfStale(
      client, _cfg.exportFn, _cfg.importFn,
      { snapshotFn: _cfg.snapshotFn, trigger },
    );
    if (res.skipped) { _lastOutcome = 'busy'; return; } // a manual cycle holds the lock (and emits its own states)
    _failures = 0;
    _lastCycleAt = Date.now();
    _lastOutcome = res.fresh ? 'fresh' : res.changed ? 'pulled' : res.pushed ? 'pushed' : 'clean';
    if (res.changed || res.pushed) _lastActivityAt = _lastCycleAt;
    try { await _cfg.afterCycle?.(res); } catch (e) { console.warn('[mind-sync] after-cycle:', e.message); }
    if (isLocalDirty()) syncSoon('rearm'); // an edit landed mid-cycle and missed the export
  } catch (e) {
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    if (e && e.reconnect) {
      // Auth dead-end — the gesture renewal or a pill tap recovers; not a
      // network failure, so it neither grows the backoff nor counts against it.
      _lastOutcome = 'reconnect';
      setSyncState('reconnect'); // peek-path reconnects bypass the cycle's own emit
      logSyncEvent(trigger, 'reconnect');
    } else if (offline) {
      _lastOutcome = 'offline'; // the 'online' poke resumes; no backoff growth
    } else {
      _lastOutcome = 'error';
      _failures++;
    }
    console.warn('[mind-sync] cycle failed:', e.message);
  } finally {
    _running = false;
    scheduleHeartbeat();
  }
}

// cfg: { exportFn, importFn, snapshotFn, afterCycle(res) } — afterCycle runs
// after every completed cycle (attachment queue drain, image retry, and the
// typing-guarded refresh when the cycle changed local data).
export function startSyncScheduler(cfg) {
  if (_started || typeof window === 'undefined') return;
  _started = true;
  _cfg = cfg;

  // Hiding: cancel the queued timer, then flush any unpushed work NOW —
  // flushDebouncedPush covers a debounce timer that hasn't fired yet, and the
  // isLocalDirty check covers a 'write' poke the clearTimer just dropped.
  // Both funnel into runCycle('flush'), which is _running-guarded.
  const flushOnHide = () => {
    clearTimer();
    flushDebouncedPush();
    if (isLocalDirty()) runCycle('flush');
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncSoon('visible', { userInitiated: true });
    else flushOnHide();
  });
  window.addEventListener('focus', () => syncSoon('focus', { userInitiated: true }));
  window.addEventListener('pagehide', flushOnHide);
  window.addEventListener('online', () => syncSoon('online', { userInitiated: true }));

  // Debounced write pushes route through the scheduler (retry/backoff/log);
  // a pending write flushes immediately when the page hides.
  setWritePoker((trigger) => {
    if (trigger === 'flush') runCycle('flush');
    else syncSoon(trigger);
  });

  // The GIS "silent" renewal is a popup and needs a user gesture — renew on
  // the next real tap/keypress once the ~1h token lapses, then sync.
  armGestureRenewal(() => syncSoon('token-renewed', { userInitiated: true }));
  preloadGis(); // so the gesture-time renewal fits inside the activation window

  setSchedulerDiag(() => [
    ['heartbeat', _timer ? `next in ${Math.max(0, Math.round((_nextAt - Date.now()) / 1000))}s` : 'idle'],
    ['consecutive failures', String(_failures)],
    ['last cycle', _lastCycleAt ? new Date(_lastCycleAt).toLocaleTimeString() : 'never'],
    ['last outcome', _lastOutcome || '(none)'],
  ]);

  syncSoon('load', { userInitiated: true });
}
