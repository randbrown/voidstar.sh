// Smoke tests for mind's daily-note selection — pure functions only (no
// IndexedDB / DOM), so they run under plain node:
//   node scripts/check-mind-daily.mjs
//
// The bug these cover: clicking "today" on 2026-07-30 opened a note headed
// "7/30" that was really from 2025. Document import had to guess a year for the
// year-less header and used the current one, so the imported note claimed
// today's daily key. Now such a claim is flagged rather than trusted.

import {
  dailyKey, dailyTitle, dailyYearIsGuess, pickDailyNote, confirmDaily, demoteDaily,
} from '../src/lib/mind/daily.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const KEY = '2026-07-30';
const note = (over = {}) => ({
  id: 'n1', title: '2026-07-30 daily', body: '', deletedAt: 0,
  createdAt: 1, updatedAt: 1, meta: { daily: KEY }, ...over,
});

section('(a) dailyKey / dailyTitle');
{
  check('local calendar day', dailyKey(new Date(2026, 6, 30, 23, 30)) === '2026-07-30');
  check('pads month + day', dailyKey(new Date(2026, 0, 5, 0, 1)) === '2026-01-05');
  check('title shape', dailyTitle(KEY) === '2026-07-30 daily');
}

section('(b) dailyYearIsGuess');
{
  check('app-created daily is trusted', !dailyYearIsGuess(note()));
  check('note with no daily key is not a candidate', !dailyYearIsGuess(note({ meta: {} })));
  check('flagged import is a guess',
    dailyYearIsGuess(note({ title: '7/30', meta: { daily: KEY, importedAt: 5, dailyGuessedYear: true } })));
  check('legacy import titled "7/30" (no year anywhere) is a guess',
    dailyYearIsGuess(note({ title: '7/30', meta: { daily: KEY, importedAt: 5 } })));
  check('import whose header spelled the year is trusted',
    !dailyYearIsGuess(note({ title: '7/30/2026', meta: { daily: KEY, importedAt: 5 } })));
  check('confirmed once, trusted after',
    !dailyYearIsGuess(note({ title: '7/30', meta: { daily: KEY, importedAt: 5, dailyGuessedYear: true, dailyConfirmed: true } })));
}

section('(c) pickDailyNote');
{
  const guessed = note({ id: 'imported', title: '7/30', meta: { daily: KEY, importedAt: 5, dailyGuessedYear: true } });
  const real = note({ id: 'real' });

  check('nothing claims the day → create', Object.keys(pickDailyNote([], KEY)).length === 0);
  check('a real daily is opened', pickDailyNote([real], KEY).note?.id === 'real');
  check('only a guessed claim → ask', pickDailyNote([guessed], KEY).guessed?.id === 'imported');
  check('a real daily wins over a guessed one', pickDailyNote([guessed, real], KEY).note?.id === 'real');
  check('and no question is asked then', !pickDailyNote([guessed, real], KEY).guessed);
  check('other days are ignored',
    Object.keys(pickDailyNote([note({ meta: { daily: '2025-07-30' } })], KEY)).length === 0);
  check('trashed claims are ignored',
    Object.keys(pickDailyNote([note({ deletedAt: 9 })], KEY)).length === 0);
  check('newest claim wins',
    pickDailyNote([note({ id: 'old', updatedAt: 1 }), note({ id: 'new', updatedAt: 2 })], KEY).note?.id === 'new');
}

section('(d) confirm / demote');
{
  const guessed = note({ id: 'imported', title: '7/30', meta: { daily: KEY, importedAt: 5, dailyGuessedYear: true } });

  const confirmed = confirmDaily(guessed);
  check('confirm keeps the daily key', confirmed.meta.daily === KEY);
  check('confirm settles the question', !dailyYearIsGuess(confirmed));
  check('confirmed note is now THE daily', pickDailyNote([confirmed], KEY).note?.id === 'imported');

  const demoted = demoteDaily(guessed);
  check('demote drops the daily claim', demoted.meta.daily === undefined);
  check('demote keeps provenance + content', demoted.meta.importedAt === 5 && demoted.title === '7/30');
  check('demoted note stops claiming the day', Object.keys(pickDailyNote([demoted], KEY)).length === 0);
  check('originals untouched (pure)', guessed.meta.daily === KEY && !guessed.meta.dailyConfirmed);
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
