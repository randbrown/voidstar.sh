// Node smoke test for the AI cost controls — the model tier each /ai/* route
// defaults to, the request shape each tier actually accepts, and the guard
// that stops a bulk pass once the failures stop being about the songs.
//
//   node scripts/check-ai-cost.mjs
//
// Why this file exists: the reported symptom was a library health check whose
// results were 14 identical rows of "AI read failed: claude: Your credit
// balance is too low". Two separate bugs in one screenshot — the grounded
// routes defaulted to the most expensive model in the lineup, and the chart
// scan kept paying for calls that could not succeed. Both are cheap to
// regress silently, so both get pinned here.

import {
  claudeModelProfile,
  AI_DEFAULT_MODEL,
  AI_DEFAULT_SUMMARY_MODEL,
  AI_DEFAULT_READ_MODEL,
} from '../workers/setlist-sync/index.js';
import {
  isAccountLevelAiFailure,
  isRetryableAiFailure,
  aiFailureStopper,
  SAME_FAILURE_LIMIT,
} from '../src/lib/setlist/ai-failure.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

console.log('default model tiers');
// Opus tier is ~2.5x Sonnet 5 per token ($5/$25 vs $2/$10) for work that is
// "search a few sources, fill a small JSON object". Nothing here should
// silently drift back up to it.
const EXPENSIVE = /opus|fable|mythos/i;
check('chart drafting does not default to an Opus-or-above tier',
  !EXPENSIVE.test(AI_DEFAULT_MODEL), AI_DEFAULT_MODEL);
check('steel summaries do not default to an Opus-or-above tier',
  !EXPENSIVE.test(AI_DEFAULT_SUMMARY_MODEL), AI_DEFAULT_SUMMARY_MODEL);
// Reading a scan is transcription. It also must not move to a 4.7+ model:
// those bill images at the high-resolution visual-token tier (up to 4784
// tokens a page vs 1568), so "newer" would cost ~3x for the same read.
check('chart reading stays on the cheapest (Haiku) tier',
  /haiku/i.test(AI_DEFAULT_READ_MODEL), AI_DEFAULT_READ_MODEL);

console.log('\nper-tier request shape');
// The whole point of the ANTHROPIC_*_MODEL overrides is that someone bleeding
// credits can drop a route to a cheaper tier. That only helps if the request
// adapts: Haiku-tier 400s on the dynamic-filtering web_search (it can't do
// programmatic tool calling), on adaptive thinking, and on output_config.effort.
const sonnet = claudeModelProfile('claude-sonnet-5');
check('Sonnet tier uses dynamic filtering (fewer input tokens on a search)',
  sonnet.searchTool === 'web_search_20260209', sonnet.searchTool);
check('Sonnet tier gets adaptive thinking', sonnet.adaptiveThinking === true);
check('Sonnet tier gets an effort level', sonnet.supportsEffort === true);

for (const id of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'CLAUDE-HAIKU-4-5']) {
  const haiku = claudeModelProfile(id);
  check(`${id}: falls back to the directly-callable web_search`,
    haiku.searchTool === 'web_search_20250305', haiku.searchTool);
  check(`${id}: sends no adaptive thinking block`, haiku.adaptiveThinking === false);
  check(`${id}: sends no output_config.effort`, haiku.supportsEffort === false);
}

const opus = claudeModelProfile('claude-opus-5');
check('a hand-set Opus model still gets the modern shape',
  opus.searchTool === 'web_search_20260209' && opus.adaptiveThinking && opus.supportsEffort);
check('an empty/undefined model does not crash the profile',
  claudeModelProfile(undefined).searchTool === 'web_search_20260209');

console.log('\naccount-level failure detection');
// The exact string from the reported screenshot.
const REPORTED = 'claude: Your credit balance is too low to access the Anthropic API.';
check('the reported credit-balance error reads as account-level',
  isAccountLevelAiFailure(REPORTED));
for (const reason of [
  'claude: invalid x-api-key (API 401)',
  'openai: You exceeded your current quota, please check your plan and billing details',
  'gemini: Permission denied (API 403)',
  'claude: insufficient_quota',
]) {
  check(`account-level: ${reason.slice(0, 44)}…`, isAccountLevelAiFailure(reason));
}
for (const reason of [
  'claude: could not read the chart',
  'claude: confidence too low (0.2)',
  'this chart is a PDF — the AI read needs an image',
  'worker error 500',
  '',
  undefined,
]) {
  check(`NOT account-level: ${String(reason).slice(0, 44) || '(empty)'}`,
    !isAccountLevelAiFailure(reason));
}

console.log('\nrate limits are not account problems');
// A free-tier 429 announces itself in the language of a drained account —
// "You exceeded your current quota, please check your plan and billing
// details" trips the credit/quota/billing patterns — but it is usually a
// per-MINUTE limit that clears in seconds. Aborting on it throws away a
// provider that would have worked a moment later.
const GEMINI_429 = 'gemini: API 429: { "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details.';
check('a bare Gemini 429 is retryable', isRetryableAiFailure(GEMINI_429));
check('a bare Gemini 429 is NOT treated as terminal', !isAccountLevelAiFailure(GEMINI_429));
check('a transient 503 is retryable', isRetryableAiFailure('gemini: API 503: model overloaded'));
check('a drained balance is not retryable', !isRetryableAiFailure(REPORTED));

// The reason string covers the WHOLE chain, and the chain only needs one
// provider. This is the exact string the reported pass produced: Claude
// terminally out of credits, Gemini merely rate-limited, OpenAI unset — so
// Gemini is still a live path and the pass must not abort on song 1.
const MIXED_CHAIN = 'claude: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits. (API 400) · gemini: API 429: { "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details. · openai: not configured (OPENAI_API_KEY)';
check('a chain with one rate-limited provider left is not terminal',
  !isAccountLevelAiFailure(MIXED_CHAIN));
const mixed = aiFailureStopper();
check('...so it does not abort on the first song',
  mixed.fail(MIXED_CHAIN) === null);
check(`...but still stops after ${SAME_FAILURE_LIMIT} in a row`,
  typeof [...Array(SAME_FAILURE_LIMIT - 1)].reduce((acc) => acc ?? mixed.fail(MIXED_CHAIN), null) === 'string');

// A chain where EVERY configured provider is terminally out stays terminal.
const ALL_TERMINAL = 'claude: Your credit balance is too low (API 400) · gemini: API 403 permission_error · openai: not configured (OPENAI_API_KEY)';
check('a chain with no live path left is terminal', isAccountLevelAiFailure(ALL_TERMINAL));

console.log('\nbulk-pass stop condition');
// One drained account should cost ONE failed call, not 82.
const drained = aiFailureStopper();
check('an account-level failure stops on the very first song',
  typeof drained.fail(REPORTED) === 'string');

// An ordinary per-song failure must not stop the pass early — a library with
// two unreadable scans still gets the other 80 songs scanned.
const ordinary = aiFailureStopper();
check('one ordinary failure keeps going', ordinary.fail('claude: could not read the chart') === null);
check('a different ordinary failure keeps going', ordinary.fail('claude: confidence too low (0.2)') === null);

// ...but the same one over and over is a config problem wearing a song's hat.
const repeated = aiFailureStopper();
let stopped = null;
for (let i = 0; i < SAME_FAILURE_LIMIT && !stopped; i++) stopped = repeated.fail('worker error 503');
check(`${SAME_FAILURE_LIMIT} identical ordinary failures in a row stop the pass`,
  typeof stopped === 'string', String(stopped));
check('the stop message names the reason', /503/.test(String(stopped)));

// Alternating reasons aren't a run.
const interleaved = aiFailureStopper();
check('alternating reasons never reach the limit',
  [...Array(8)].every((_, i) => interleaved.fail(i % 2 ? 'reason A' : 'reason B') === null));

// A success between failures breaks the run — one flaky song must not end a
// pass that is otherwise working. This is the regression that matters most:
// without it, a library with a few unreadable scans scattered through it stops
// partway and reports "3 in a row" that were never in a row.
const flaky = aiFailureStopper();
let flakyStopped = null;
for (let i = 0; i < 10 && !flakyStopped; i++) {
  flakyStopped = flaky.fail('worker error 503');
  flaky.ok();
}
check('a success between identical failures keeps the pass alive',
  flakyStopped === null, String(flakyStopped));

// ...but a success does NOT rescue an account-level failure: no later song
// can put credits back on the account.
const drainedLate = aiFailureStopper();
drainedLate.ok();
check('a prior success does not excuse an account-level failure',
  typeof drainedLate.fail(REPORTED) === 'string');

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAI cost checks passed');
