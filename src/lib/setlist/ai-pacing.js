// Pacing for bulk passes that make one paid AI call per song.
//
// The problem this solves, from a real run: a free-tier provider allows ~10
// requests a minute, and a library pass fires ~80 back-to-back as fast as they
// complete. It trips the per-minute limit within seconds, and every remaining
// song gets a 429 — a provider that would happily have done the whole library
// in nine minutes instead does nothing.
//
// The pacing is ADAPTIVE, not a fixed sleep: passes run at full speed until a
// provider actually pushes back, then space out, then ease back off as calls
// start succeeding again. A healthy account (or a paid tier with real limits)
// pays nothing for this — the throttle stays at zero and is never waited on.
//
// Backoff and pacing are the same mechanism here: a retry is just the next
// attempt after the throttle has been tightened, so a rate-limited song waits
// longer each time AND the songs behind it inherit the slower cadence.
//
// Pure and DOM-free, with `sleep` injectable, so `npm run check` can exercise
// the whole schedule without actually waiting.

import { isRetryableAiFailure } from './ai-failure.js';

// Just over 10 requests/minute — the first step-down when a provider pushes
// back, sized for the free tiers that do the pushing.
export const PACE_STEP_MS = 6_500;
// Never space calls further apart than this, however hard we're pushed back:
// past here the pass is not going to finish in a sitting and should fail
// visibly instead of crawling forever.
export const PACE_MAX_MS = 30_000;
// Below this the throttle isn't buying anything — drop it to zero.
const PACE_MIN_MS = 1_500;
// How many extra attempts one song gets before its failure is reported. With
// the doubling above that's ~45 s of waiting in the worst case.
export const MAX_RETRIES = 3;

// A setTimeout that also settles the moment `signal` aborts, so a user who
// hits stop doesn't sit through the rest of a 26-second backoff.
function realSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

// One pacer per bulk pass (the throttle is per-run state, deliberately not
// shared or persisted — the next pass starts optimistic).
//
//   const pacer = aiPacer({ signal, onWait: ({ ms }) => report(...) });
//   const r = await pacer.run(() => fetchSteelSummary(song), x => x.ok ? null : x.reason);
//
// `attempt()` makes the call; `reasonOf(result)` returns its failure reason,
// or null when it worked. Whatever the last attempt returned comes back —
// `run` never throws on a failed call and never invents a result.
export function aiPacer({ sleep = realSleep, signal, onWait, maxRetries = MAX_RETRIES } = {}) {
  let throttleMs = 0;

  // A provider pushed back: first hit jumps straight to the free-tier cadence,
  // further hits double it.
  function tighten() {
    throttleMs = Math.min(PACE_MAX_MS, throttleMs ? throttleMs * 2 : PACE_STEP_MS);
  }

  // A call worked: relax gradually rather than snapping back to full speed,
  // which would just trip the limit again on the next song.
  function easeOff() {
    if (!throttleMs) return;
    const next = Math.floor(throttleMs * 0.75);
    throttleMs = next <= PACE_MIN_MS ? 0 : next;
  }

  return {
    // Current spacing, for a progress line that explains the slowdown.
    get throttleMs() { return throttleMs; },

    async run(attempt, reasonOf) {
      for (let tries = 0; ; tries++) {
        if (throttleMs) {
          onWait?.({ ms: throttleMs, retry: tries > 0 });
          await sleep(throttleMs, signal);
        }
        const result = await attempt();
        const reason = reasonOf(result);
        if (!reason) {
          easeOff();
          return result;
        }
        // Out of retries, not worth retrying, or the user stopped: report what
        // the last attempt actually said.
        if (tries >= maxRetries || !isRetryableAiFailure(reason) || signal?.aborted) {
          return result;
        }
        tighten();
      }
    },
  };
}
