// Smoke tests for the datetime-stamp pure core — no DOM, so they run under
// plain node:
//   node scripts/check-mind-stamp.mjs

import {
  STAMP_FORMATS, DEFAULT_STAMP_FORMAT, stampFormat, formatStamp, stampInsertion,
} from '../src/lib/mind/stamp.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// Sunday, 2026-09-20 14:32 local time.
const TS = new Date(2026, 8, 20, 14, 32).getTime();
// Midnight and noon — the two hours a 12-hour clock gets wrong.
const MIDNIGHT = new Date(2026, 8, 20, 0, 5).getTime();
const NOON = new Date(2026, 8, 20, 12, 5).getTime();

section('(a) formats');
{
  check('datetime is sortable ISO-ish', formatStamp(TS, 'datetime') === '2026-09-20 14:32', formatStamp(TS, 'datetime'));
  check('date only', formatStamp(TS, 'date') === '2026-09-20', formatStamp(TS, 'date'));
  check('time only', formatStamp(TS, 'time') === '14:32', formatStamp(TS, 'time'));
  check('long form',
    formatStamp(TS, 'long') === 'Sunday, September 20, 2026 at 2:32 pm',
    formatStamp(TS, 'long'));
  check('midnight is 12 am', formatStamp(MIDNIGHT, 'long').endsWith('12:05 am'), formatStamp(MIDNIGHT, 'long'));
  check('noon is 12 pm', formatStamp(NOON, 'long').endsWith('12:05 pm'), formatStamp(NOON, 'long'));
  check('single-digit month/day pad', formatStamp(new Date(2026, 0, 3, 9, 4).getTime(), 'datetime') === '2026-01-03 09:04');
}

section('(b) format lookup falls back, never throws');
{
  check('unknown key → default', stampFormat('nope').key === DEFAULT_STAMP_FORMAT);
  check('undefined key → default', stampFormat().key === DEFAULT_STAMP_FORMAT);
  check('default key exists in the list', STAMP_FORMATS.some(f => f.key === DEFAULT_STAMP_FORMAT));
  check('every format has a label', STAMP_FORMATS.every(f => f.key && f.label && typeof f.fmt === 'function'));
  check('formatStamp with junk key still stamps', formatStamp(TS, 'junk') === '2026-09-20 14:32');
}

section('(c) insertion shape depends on the caret');
{
  const run = (opts, key = 'datetime') => stampInsertion(TS, key, opts);
  const join = (r) => `${r.lead}${r.text}${r.trail}`;

  const mid = run({ before: 'we shipped at', after: '' });
  check('mid-sentence gets a separating space', join(mid) === ' 2026-09-20 14:32', JSON.stringify(mid));
  check('mid-sentence is not bold', mid.bold === false);
  const spaced = run({ before: 'we shipped at ', after: '' });
  check('no double space after one already typed', join(spaced) === '2026-09-20 14:32', JSON.stringify(spaced));

  const own = run({ before: '', after: '' });
  check('own empty line is bold', own.bold === true && own.text === '2026-09-20 14:32');
  check('own empty line trails a space', join(own) === '2026-09-20 14:32 ', JSON.stringify(own));
  const owsp = run({ before: '   ', after: '' });
  check('whitespace-only before counts as line start', owsp.bold === true && join(owsp) === '2026-09-20 14:32 ');

  const ahead = run({ before: '', after: 'existing line' });
  check('line start with text after → em-dash lead-in',
    join(ahead) === '2026-09-20 14:32 \u2014 ', JSON.stringify(ahead));
  check('whitespace-only after is still an empty line',
    join(run({ before: '', after: '  ' })) === '2026-09-20 14:32 ');

  check('no literal asterisks — the caller applies a real strong mark',
    !JSON.stringify(run({ before: '', after: '' })).includes('*'));

  const longMid = run({ before: 'as of', after: '' }, 'long');
  check('format choice carries into the insertion',
    join(longMid) === ' Sunday, September 20, 2026 at 2:32 pm', JSON.stringify(longMid));
  const bare = stampInsertion(TS, 'datetime');
  check('no caret context → treated as a fresh line', bare.bold === true && bare.lead === '');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall stamp checks passed');
process.exit(failed ? 1 : 0);
