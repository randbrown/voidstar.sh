// Reading an AI failure reason well enough to know whether retrying the NEXT
// song could possibly work.
//
// The bulk passes learned this the expensive way: a library-wide scan of 82
// charts hit "claude: Your credit balance is too low…" on song 1 and then
// cheerfully asked the same drained account 81 more times, filling the health
// report with 14 identical rows. The account, not the song, was the problem —
// and every one of those calls still cost a round trip (and, for a provider
// that fails AFTER billing, real money).
//
// Pure string predicates, no DOM and no network, so `npm run check` can test
// them directly. The strings come from the worker's `aiFailureReason`, which
// surfaces the provider's own sentence (e.g. Anthropic's
// `error.error.message`) rather than a raw JSON blob.

// A failure about the ACCOUNT — credits, key, plan, quota — rather than about
// this particular song. Nothing about the next song changes any of these, so
// the pass should stop and say so once instead of grinding through the
// remaining library.
//
// Matched on the provider's sentence, because the HTTP status doesn't
// distinguish them: an exhausted Anthropic balance is a plain 400, the same
// status a malformed request gets.
const TERMINAL_PATTERNS = [
  /credit balance is too low/i,
  /insufficient[_ ](?:credits?|quota|funds|balance)/i,
  /billing|payment required|past due/i,
  /invalid[_ ]?(?:api[_ ]?)?key|authentication[_ ]?error|unauthorized|api 401/i,
  /permission[_ ]?error|api 403/i,
  /quota exceeded|exceeded your current quota|usage limit|spend limit/i,
];

// ...and the ones that look account-shaped but AREN'T terminal. A 429 is the
// big one: on a free tier it is usually a per-MINUTE rate limit that clears in
// seconds, and its message ("You exceeded your current quota, please check
// your plan and billing details") reads exactly like a drained account — it
// trips three of the patterns above. Aborting a library pass on it throws away
// a provider that would have worked a moment later.
const RETRYABLE_PATTERNS = [
  /\b429\b|rate[_ ]?limit|resource[_ ]?exhausted|too many requests/i,
  /\b5\d\d\b|overloaded|unavailable|timed? ?out|timeout/i,
];

export function isRetryableAiFailure(reason) {
  const text = String(reason || '');
  return !!text && RETRYABLE_PATTERNS.some(re => re.test(text));
}

// A failure about the ACCOUNT that no later song can change.
//
// The reason string covers the WHOLE failover chain ("claude: … · gemini: …"),
// and the chain only needs ONE provider to work — so a reason is terminal only
// when nothing in it is worth retrying. A drained Claude balance alongside a
// rate-limited Gemini is NOT terminal: Gemini is still a live path.
export function isAccountLevelAiFailure(reason) {
  const text = String(reason || '');
  if (!text) return false;
  if (isRetryableAiFailure(text)) return false;
  return TERMINAL_PATTERNS.some(re => re.test(text));
}

// How many identical, non-account failures in a row mean "this isn't about
// the songs". Kept for the failures that don't announce themselves as
// account-level (a provider that's simply down, a worker misconfiguration).
export const SAME_FAILURE_LIMIT = 3;

// The shared stop condition for a bulk pass that calls a paid AI route per
// song. Report every AI-rung outcome to it in order — `ok()` when the call
// worked, `fail(reason)` when it didn't — and `fail` returns the message to
// abort the pass with, or null to keep going.
//
// Only report outcomes of calls that actually happened: a song the pass
// skipped (already has a key, no chart to read) is neither, and counting it
// either way would misread the run.
//
// Usage:
//   const stopper = aiFailureStopper();
//   ... const stop = stopper.fail(reason);
//       if (stop) return { aborted: stop, ... };
export function aiFailureStopper() {
  let lastReason = null;
  let sameReasonRun = 0;
  return {
    // A call that worked — whatever run of identical failures was building is
    // broken, so one flaky song can't end an otherwise healthy pass.
    ok() {
      lastReason = null;
      sameReasonRun = 0;
    },
    fail(reason) {
      // An account-level failure is terminal on the FIRST hit — waiting for
      // three of them just buys three identical errors.
      if (isAccountLevelAiFailure(reason)) {
        return `stopped — this is an account problem, not a song problem: ${reason}`;
      }
      sameReasonRun = reason === lastReason ? sameReasonRun + 1 : 1;
      lastReason = reason;
      if (sameReasonRun >= SAME_FAILURE_LIMIT) {
        return `stopped — ${sameReasonRun} songs in a row failed the same way: ${reason}`;
      }
      return null;
    },
  };
}
