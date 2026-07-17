// Smoke tests for the ongoing-notes pure core (append/insert entries, date
// stamping, merge text) — no IndexedDB, so they run under plain node:
//   node scripts/check-mind-ongoing.mjs

import {
  ONGOING_TAG, isOngoing, ongoingPrefs, dateStamp, composeEntry, insertIntoBody, mergeText,
} from '../src/lib/mind/ongoing.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// A fixed local timestamp: 2026-07-17 14:30 local time.
const TS = new Date(2026, 6, 17, 14, 30).getTime();

section('(a) membership + prefs');
{
  check('tagged note is ongoing', isOngoing({ tags: ['lyrics', ONGOING_TAG], deletedAt: 0 }));
  check('untagged note is not', !isOngoing({ tags: ['lyrics'], deletedAt: 0 }));
  check('trashed note is not', !isOngoing({ tags: [ONGOING_TAG], deletedAt: 123 }));
  check('null-safe', !isOngoing(null));

  const d = ongoingPrefs({});
  check('defaults: top, no stamp', d.position === 'top' && d.stamp === false);
  const p = ongoingPrefs({ meta: { ongoing: { position: 'bottom', stamp: 1 } } });
  check('stored prefs read back', p.position === 'bottom' && p.stamp === true);
  const junk = ongoingPrefs({ meta: { ongoing: { position: 'sideways' } } });
  check('junk position falls back to top', junk.position === 'top');
}

section('(b) date stamp');
{
  check('YYYY-MM-DD', dateStamp(TS) === '2026-07-17', dateStamp(TS));
}

section('(c) composeEntry');
{
  check('plain text passes through', composeEntry('a fragment') === 'a fragment');
  check('outer whitespace trimmed', composeEntry('\n\n  idea  \n\n') === '  idea');
  check('empty → empty', composeEntry('   \n  ') === '');
  check('single line stamps inline',
    composeEntry('stay gold', { stamp: true, ts: TS }) === '**2026-07-17** — stay gold');
  const multi = composeEntry('verse one\nverse two', { stamp: true, ts: TS });
  check('multi-line stamps on its own line', multi === '**2026-07-17**\nverse one\nverse two', JSON.stringify(multi));
}

section('(d) insertIntoBody');
{
  check('top: entry, blank line, body',
    insertIntoBody('old stuff\n', 'new idea', 'top') === 'new idea\n\nold stuff\n');
  check('bottom: body, blank line, entry',
    insertIntoBody('old stuff\n', 'new idea', 'bottom') === 'old stuff\n\nnew idea\n');
  check('bottom collapses trailing blank lines',
    insertIntoBody('old stuff\n\n\n', 'x', 'bottom') === 'old stuff\n\nx\n');
  check('top collapses leading blank lines',
    insertIntoBody('\n\nold stuff', 'x', 'top') === 'x\n\nold stuff');
  check('empty body becomes the entry', insertIntoBody('', 'x', 'top') === 'x\n');
  check('whitespace-only body becomes the entry', insertIntoBody('  \n ', 'x', 'bottom') === 'x\n');
  check('empty entry leaves body untouched', insertIntoBody('body', '', 'top') === 'body');
}

section('(e) mergeText — what a filed note contributes');
{
  check('auto-titled note contributes body only',
    mergeText({ autoTitle: true, title: '2026-07-17 09:12', body: 'the idea\n' }) === 'the idea');
  check('hand-named note keeps its title as first line',
    mergeText({ autoTitle: false, title: 'Neon Dust', body: 'chorus goes here' }) === 'Neon Dust\nchorus goes here');
  check('hand-named, empty body → title alone',
    mergeText({ autoTitle: false, title: 'Neon Dust', body: '  ' }) === 'Neon Dust');
  check('auto-titled, empty body → nothing',
    mergeText({ autoTitle: true, title: '2026-07-17 09:12', body: '' }) === '');
}

section('(f) end-to-end composition (stamped quote into a quotes log)');
{
  const body = '**2026-07-01** — earlier quote\n';
  const entry = composeEntry('"be the void" — jay', { stamp: true, ts: TS });
  const out = insertIntoBody(body, entry, 'top');
  check('newest quote lands on top, dated',
    out === '**2026-07-17** — "be the void" — jay\n\n**2026-07-01** — earlier quote\n',
    JSON.stringify(out));
}

console.log(`\n${failed ? `FAILED ${failed}` : 'all ongoing checks passed'}`);
process.exit(failed ? 1 : 0);
