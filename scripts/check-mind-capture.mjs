// Smoke tests for the mind quick-capture parser — pure functions only (no
// IndexedDB / DOM), so they run under plain node:
//   node scripts/check-mind-capture.mjs
//
// Covers parseWhen (dates.js) time/relative grammar and parseCapture
// (capture.js) verb-stripping + reminder extraction.

import { parseWhen } from '../src/lib/mind/dates.js';
import { parseCapture } from '../src/lib/mind/capture.js';

// Fixed anchor: Saturday 2026-07-11 10:00 local. All expectations are relative
// to this so the run is deterministic regardless of the real clock.
const NOW = new Date(2026, 6, 11, 10, 0, 0, 0).getTime();
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── parseWhen ──
section('(a) parseWhen — times, days, durations');
{
  const eq = (str, ts) => {
    const r = parseWhen(str, NOW);
    check(`"${str}"`, r && r.ts === ts, r ? new Date(r.ts).toString().slice(0, 24) : 'null');
  };
  eq('after 5pm', at(2026, 7, 11, 17));          // today, still future
  eq('at 6:30', at(2026, 7, 11, 18, 30));        // bare 6:30 → pm heuristic
  eq('tomorrow 9am', at(2026, 7, 12, 9));
  eq('tonight', at(2026, 7, 11, 18));            // day-only → 18:00 default
  eq('in 2 hours', at(2026, 7, 11, 12));
  eq('in 30 min', at(2026, 7, 11, 10, 30));
  eq('next monday', at(2026, 7, 13, 9));         // upcoming Monday, 9am default
  eq('2026-08-03 at 2pm', at(2026, 8, 3, 14));
  check('bare time already passed rolls to tomorrow',
    parseWhen('at 9am', NOW)?.ts === at(2026, 7, 12, 9));
  check('no time → null', parseWhen('monkeys eat bananas', NOW) === null);
}

// ── parseCapture ──
section('(b) parseCapture — verb strip + reminder extraction');
{
  const one = (raw, text, ts) => {
    const r = parseCapture(raw, NOW);
    check(`text "${raw}"`, r.text === text, JSON.stringify(r.text));
    check(`time "${raw}"`, r.remindAt === ts, r.remindAt ? new Date(r.remindAt).toString().slice(0, 24) : '0');
  };
  one('add todo pick up prescription from pharmacy after 5pm',
    'pick up prescription from pharmacy', at(2026, 7, 11, 17));
  one('remind me to call Jay back after 6pm tonight', 'call Jay back', at(2026, 7, 11, 18));
  one('buy milk tomorrow 9am', 'buy milk', at(2026, 7, 12, 9));
  one('add note monkeys eat bananas', 'monkeys eat bananas', 0);
  one('water plants in 2 hours', 'water plants', at(2026, 7, 11, 12));
  check('empty input safe', parseCapture('', NOW).text === '' && parseCapture('', NOW).remindAt === 0);
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
