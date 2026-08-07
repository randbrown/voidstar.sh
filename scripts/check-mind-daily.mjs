// Smoke tests for mind's daily-note selection — pure functions only (no
// IndexedDB / DOM), so they run under plain node:
//   node scripts/check-mind-daily.mjs
//
// The bug these cover: clicking "today" on 2026-07-30 opened a note headed
// "7/30" that was really from 2025. Document import had to guess a year for the
// year-less header and used the current one, so the imported note claimed
// today's daily key. Now such a claim is flagged rather than trusted.

import {
  dailyKey, dailyTitle, dailyYearIsGuess, dailyClaimRefuted, guessedDailyNotes,
  pickDailyNote, confirmDaily, demoteDaily,
} from '../src/lib/mind/daily.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const KEY = '2026-07-30';
// Default timestamps sit ON the claimed day — a plausible claim. Tests about
// timestamp refutation override updatedAt explicitly.
const DAY = new Date(2026, 6, 30, 12, 0).getTime();
const note = (over = {}) => ({
  id: 'n1', title: '2026-07-30 daily', body: '', deletedAt: 0,
  createdAt: DAY, updatedAt: DAY, meta: { daily: KEY }, ...over,
});

section('(a) dailyKey / dailyTitle');
{
  check('local calendar day', dailyKey(new Date(2026, 6, 30, 23, 30)) === '2026-07-30');
  check('pads month + day', dailyKey(new Date(2026, 0, 5, 0, 1)) === '2026-01-05');
  check('title shape', dailyTitle(KEY) === '2026-07-30 daily');
}

section('(b) dailyYearIsGuess — the title must vouch for the year it claims');
{
  check('app-created daily is trusted', !dailyYearIsGuess(note()));
  check('note with no daily key is not a candidate', !dailyYearIsGuess(note({ meta: {} })));
  check('flagged import is a guess',
    dailyYearIsGuess(note({ title: '7/30', meta: { daily: KEY, importedAt: 5, dailyGuessedYear: true } })));
  check('import titled "7/30" (no year anywhere) is a guess',
    dailyYearIsGuess(note({ title: '7/30', meta: { daily: KEY, importedAt: 5 } })));
  check('import whose header spelled the year is trusted',
    !dailyYearIsGuess(note({ title: '7/30/2026', meta: { daily: KEY, importedAt: 5 } })));
  check('confirmed once, trusted after',
    !dailyYearIsGuess(note({ title: '7/30', meta: { daily: KEY, importedAt: 5, dailyGuessedYear: true, dailyConfirmed: true } })));

  // The regression that shipped in the first fix: the importer only started
  // stamping `meta.importedAt` on 2026-07-15, so every journal imported before
  // that had a daily claim with NO provenance — and the check, which keyed on
  // provenance, waved it straight through. The title is asked instead.
  check('pre-2026-07-15 import (daily claim, no importedAt) is still a guess',
    dailyYearIsGuess(note({ title: '7/30', meta: { daily: KEY } })));
  check('…and it does not stand in for today',
    pickDailyNote([note({ id: 'legacy', title: '7/30', meta: { daily: KEY } })], KEY).guessed?.id === 'legacy');
  check('a title naming a DIFFERENT year does not vouch for this claim',
    dailyYearIsGuess(note({ title: '7/30 (from the 2025 notebook)', meta: { daily: KEY } })));
  check('an ISO-titled import is trusted',
    !dailyYearIsGuess(note({ title: '2026-07-30', meta: { daily: KEY } })));
  check('a title mentioning the year anywhere vouches',
    !dailyYearIsGuess(note({ title: 'trip planning 2026', meta: { daily: KEY } })));
  check('missing title is a guess, not a crash', dailyYearIsGuess({ meta: { daily: KEY } }));
}

section('(c) guessedDailyNotes — the bulk-release corpus');
{
  const all = [
    note({ id: 'a', title: '7/30', meta: { daily: '2026-07-30' } }),
    note({ id: 'b', title: '7/29', meta: { daily: '2026-07-29' } }),
    note({ id: 'c' }),                                                    // app-created
    note({ id: 'd', title: '7/28', meta: { daily: '2026-07-28', dailyConfirmed: true } }),
    note({ id: 'e', title: '7/27', meta: { daily: '2026-07-27' }, deletedAt: 9 }),
    note({ id: 'f', title: 'no claim at all', meta: {} }),
  ];
  const got = guessedDailyNotes(all).map((n) => n.id);
  check('only unvouched, live claims', JSON.stringify(got) === JSON.stringify(['b', 'a']), JSON.stringify(got));
  check('sorted by the day they claim', got[0] === 'b');
}

section('(d) pickDailyNote');
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
    pickDailyNote([note({ id: 'old', updatedAt: DAY }), note({ id: 'new', updatedAt: DAY + 1000 })], KEY).note?.id === 'new');
}

section('(e) confirm / demote');
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

section('(f) dailyClaimRefuted — the record can disprove its own claim');
{
  // The shipped bug: a note headed "8/7", really from 2025 (source doc last
  // edited Aug 11 2025), stamped with THIS year's daily key by import. Its
  // last-edit time predates the claimed day, so the claim can't be true.
  const LAST_YEAR = new Date(2025, 7, 11).getTime();
  const bug = (over = {}) => note({
    id: 'imported', title: '8/7', updatedAt: LAST_YEAR,
    meta: { daily: KEY, dailyGuessedYear: true }, ...over,
  });

  check('guessed claim edited before the day began is refuted', dailyClaimRefuted(bug()));
  check('guessed claim edited ON the day is not', !dailyClaimRefuted(bug({ updatedAt: DAY })));
  check('guessed claim edited AFTER the day is not (a later import is plausible)',
    !dailyClaimRefuted(bug({ updatedAt: DAY + 86400_000 * 3 })));
  check('edited exactly at midnight of the day is not refuted',
    !dailyClaimRefuted(bug({ updatedAt: new Date(2026, 6, 30).getTime() })));
  check('a vouched title is never refuted (rule applies to guesses only)',
    !dailyClaimRefuted(bug({ title: '7/30/2026', meta: { daily: KEY } })));
  check('a confirmed note is never refuted',
    !dailyClaimRefuted(bug({ meta: { daily: KEY, dailyGuessedYear: true, dailyConfirmed: true } })));
  check('no claim, nothing to refute', !dailyClaimRefuted(bug({ meta: {} })));
  check('missing updatedAt cannot prove anything', !dailyClaimRefuted(bug({ updatedAt: 0 })));

  check('pickDailyNote drops a refuted claim instead of asking',
    !pickDailyNote([bug()], KEY).guessed);
  check('…and surfaces it for the caller to release',
    pickDailyNote([bug()], KEY).refuted?.[0]?.id === 'imported');
  check('a plausible guess still asks, alongside the refuted one', (() => {
    const r = pickDailyNote([bug(), bug({ id: 'plausible', updatedAt: DAY })], KEY);
    return r.guessed?.id === 'plausible' && r.refuted?.length === 1 && r.refuted[0].id === 'imported';
  })());
  check('a real daily wins outright — refuted list not even computed', (() => {
    const r = pickDailyNote([bug(), note({ id: 'real' })], KEY);
    return r.note?.id === 'real' && !r.refuted && !r.guessed;
  })());
  check('a refuted note still shows up for bulk release',
    guessedDailyNotes([bug()]).length === 1);
  check('demote releases a refuted claim like any other',
    Object.keys(pickDailyNote([demoteDaily(bug())], KEY)).length === 0);
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
