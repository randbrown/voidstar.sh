// Quick-capture parsing — the single choke point shared by voice capture and
// the typed task quick-adds. Turns a raw utterance/line like
//   "add todo pick up prescription from pharmacy after 5pm"
//   "remind me to call Jay back after 6pm tonight"
//   "buy milk tomorrow 9am"
// into { text, remindAt }: a clean task title plus an absolute reminder time
// (0 = none). Pure and deterministic (parseWhen takes an injectable `now`), so
// it's node-testable in scripts/check-mind-capture.mjs.

import { parseWhen } from './dates.js';

// Leading capture verbs to strip: "add todo", "add a task", "remind me to",
// "note to self", bare "todo"/"note", etc. Trailing ":"/"," is eaten too.
const VERB_RE = /^\s*(?:please\s+)?(?:add(?:\s+(?:a|an|new))?\s+(?:todo|task|note|reminder)|remind\s+me\s+(?:to\s+)?|note(?:\s+to\s+self)?|todo|task|note)\b[:,]?\s*/i;

// Tidy the leftover after a middle span is removed: collapse whitespace, drop
// stray punctuation and a dangling connective ("… call Jay to" / "to … pharmacy").
function tidy(text) {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '')
    .replace(/\b(?:to|at|on|by)\s*$/i, '')
    .trim();
}

export function parseCapture(raw, now = Date.now()) {
  let text = (raw || '').trim().replace(VERB_RE, '').trim();

  let remindAt = 0;
  const when = parseWhen(text, now);
  if (when) {
    remindAt = when.ts;
    text = text.slice(0, when.index) + text.slice(when.index + when.length);
  }

  return { text: tidy(text), remindAt };
}
