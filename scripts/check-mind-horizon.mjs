// Smoke tests for the horizon pure core (plant / ripen / settle / push out,
// grouping, labels) — no DOM / IndexedDB, so they run under plain node:
//   node scripts/check-mind-horizon.mjs

import {
  HORIZON_KINDS, HORIZON_SPANS, DEFAULT_KIND, kindOf, addMonths,
  horizonOf, isPlanted, isRipe, isSomeday,
  plantMeta, settleMeta, pushOutMeta, clearHorizonMeta,
  groupHorizon, byYear, horizonCounts, horizonDate, horizonLabel,
} from '../src/lib/mind/horizon.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const NOW = new Date(2026, 8, 20, 12, 0).getTime();   // 2026-09-20 noon
const DAY = 86_400_000;
const YEAR = 365 * DAY;

section('(a) kinds + spans');
{
  check('three kinds', HORIZON_KINDS.length === 3);
  check('kinds are question / prediction / idea',
    JSON.stringify(HORIZON_KINDS.map(k => k.key)) === '["question","prediction","idea"]');
  check('default kind exists', HORIZON_KINDS.some(k => k.key === DEFAULT_KIND));
  check('unknown kind falls back', kindOf('nope').key === DEFAULT_KIND);
  check('undefined kind falls back', kindOf().key === DEFAULT_KIND);
  check('spans end in someday', HORIZON_SPANS.at(-1).key === 'someday');
  check('someday carries no months', HORIZON_SPANS.at(-1).months === 0);
  check('every dated span has positive months',
    HORIZON_SPANS.filter(s => s.key !== 'someday').every(s => s.months > 0));
}

section('(b) addMonths clamps the short months');
{
  const jan31 = new Date(2026, 0, 31).getTime();
  check('Jan 31 + 1 month = Feb 28 (2026)',
    horizonDate(addMonths(jan31, 1)) === '2026-02-28', horizonDate(addMonths(jan31, 1)));
  const jan31Leap = new Date(2028, 0, 31).getTime();
  check('leap year gives Feb 29',
    horizonDate(addMonths(jan31Leap, 1)) === '2028-02-29', horizonDate(addMonths(jan31Leap, 1)));
  check('+12 months keeps the day', horizonDate(addMonths(NOW, 12)) === '2027-09-20');
  check('+60 months lands five years out', horizonDate(addMonths(NOW, 60)) === '2031-09-20');
  check('time of day is preserved', new Date(addMonths(NOW, 3)).getHours() === 12);
}

section('(c) reading a horizon off a note');
{
  check('no meta → not planted', horizonOf({ id: 'a' }) === null && !isPlanted({ id: 'a' }));
  check('empty meta → not planted', horizonOf({ meta: {} }) === null);
  check('junk horizon → not planted', horizonOf({ meta: { horizon: 'soon' } }) === null);
  check('shapeless horizon → not planted', horizonOf({ meta: { horizon: {} } }) === null);
  const n = { id: 'a', meta: { horizon: { at: NOW + YEAR, kind: 'prediction', plantedAt: NOW } } };
  const h = horizonOf(n);
  check('reads at/kind/plantedAt', h.at === NOW + YEAR && h.kind === 'prediction' && h.plantedAt === NOW);
  check('settledAt defaults to 0', h.settledAt === 0);
  check('bad kind normalizes on read',
    horizonOf({ meta: { horizon: { at: NOW, kind: 'wishful' } }, createdAt: NOW }).kind === DEFAULT_KIND);
  check('someday (at:0) still reads as planted',
    isPlanted({ meta: { horizon: { at: 0, plantedAt: NOW } } }));
  check('a trashed note is never planted',
    !isPlanted({ deletedAt: NOW, meta: { horizon: { at: NOW, plantedAt: NOW } } }));
}

section('(d) ripeness');
{
  check('future is not ripe', !isRipe({ at: NOW + DAY, settledAt: 0 }, NOW));
  check('past is ripe', isRipe({ at: NOW - DAY, settledAt: 0 }, NOW));
  check('exactly now is ripe', isRipe({ at: NOW, settledAt: 0 }, NOW));
  check('settled is never ripe', !isRipe({ at: NOW - YEAR, settledAt: NOW }, NOW));
  check('someday is never ripe', !isRipe({ at: 0, settledAt: 0 }, NOW));
  check('someday reads as someday', isSomeday({ at: 0 }) && !isSomeday({ at: NOW }));
  check('null-safe', !isRipe(null, NOW));
}

section('(e) meta builders never mutate, and preserve neighbours');
{
  const note = { id: 'a', meta: { daily: '2026-09-20' }, createdAt: NOW };
  const meta = plantMeta(note, { kind: 'idea', at: NOW + YEAR, now: NOW });
  check('plant leaves the source note alone', note.meta.horizon === undefined);
  check('plant keeps meta.daily', meta.daily === '2026-09-20');
  check('plant records the date + kind', meta.horizon.at === NOW + YEAR && meta.horizon.kind === 'idea');
  check('plant stamps plantedAt', meta.horizon.plantedAt === NOW);
  check('plant opens it', meta.horizon.settledAt === 0);

  // Re-planting keeps the ORIGINAL planted date — the arc is when you thought
  // it, not when you last fiddled with the date.
  const replanted = plantMeta({ ...note, meta }, { kind: 'idea', at: NOW + 2 * YEAR, now: NOW + DAY });
  check('re-plant preserves the original plantedAt', replanted.horizon.plantedAt === NOW);

  const settled = settleMeta({ ...note, meta }, NOW + DAY);
  check('settle stamps settledAt', settled.horizon.settledAt === NOW + DAY);
  check('settle keeps the date and kind',
    settled.horizon.at === NOW + YEAR && settled.horizon.kind === 'idea');
  const reopened = plantMeta({ ...note, meta: settled }, { at: NOW + 3 * YEAR, now: NOW + 2 * DAY });
  check('re-planting a settled note re-opens it', reopened.horizon.settledAt === 0);

  check('settle on an unplanted note is a no-op', settleMeta({ meta: { daily: 'x' } }).horizon === undefined);
  check('push-out on an unplanted note is a no-op', pushOutMeta({ meta: {} }, 12).horizon === undefined);
}

section('(f) push out measures from today once ripe');
{
  const future = { meta: { horizon: { at: NOW + 30 * DAY, kind: 'question', plantedAt: NOW } } };
  const pushedFuture = pushOutMeta(future, 12, NOW);
  check('a future horizon pushes from its own date',
    pushedFuture.horizon.at === addMonths(NOW + 30 * DAY, 12), horizonDate(pushedFuture.horizon.at));

  const overdue = { meta: { horizon: { at: NOW - 2 * YEAR, kind: 'question', plantedAt: NOW - 3 * YEAR } } };
  const pushedOverdue = pushOutMeta(overdue, 12, NOW);
  check('an overdue horizon pushes from today, not from the stale date',
    pushedOverdue.horizon.at === addMonths(NOW, 12), horizonDate(pushedOverdue.horizon.at));
  check('push out keeps plantedAt', pushedOverdue.horizon.plantedAt === NOW - 3 * YEAR);

  const settled = { meta: { horizon: { at: NOW - DAY, kind: 'idea', plantedAt: NOW - YEAR, settledAt: NOW } } };
  check('pushing a settled horizon re-opens it', pushOutMeta(settled, 12, NOW).horizon.settledAt === 0);
}

section('(g) clearing reports an empty meta (the fill-field trap)');
{
  const only = { meta: { horizon: { at: NOW, plantedAt: NOW } } };
  const cleared = clearHorizonMeta(only);
  check('horizon removed', cleared.meta.horizon === undefined);
  check('empty flag set so the caller can markCleared', cleared.empty === true);

  const alsoDaily = { meta: { horizon: { at: NOW, plantedAt: NOW }, daily: '2026-09-20' } };
  const cleared2 = clearHorizonMeta(alsoDaily);
  check('a neighbouring meta key survives', cleared2.meta.daily === '2026-09-20');
  check('not empty when a neighbour remains', cleared2.empty === false);
  check('source note untouched', alsoDaily.meta.horizon !== undefined);
  check('no meta at all is safe', clearHorizonMeta({}).empty === true);
}

section('(h) grouping into the four bands');
{
  const mk = (id, at, opts = {}) => ({
    id, title: id, deletedAt: 0,
    meta: { horizon: { at, kind: 'question', plantedAt: opts.plantedAt ?? NOW - YEAR, settledAt: opts.settledAt ?? 0 } },
  });
  const notes = [
    mk('soon', NOW + 30 * DAY),
    mk('far', NOW + 4 * YEAR),
    mk('ripe-recent', NOW - DAY),
    mk('ripe-old', NOW - 2 * YEAR),
    mk('someday', 0, { plantedAt: NOW - 10 * DAY }),
    mk('someday-older', 0, { plantedAt: NOW - 100 * DAY }),
    mk('settled', NOW - YEAR, { settledAt: NOW - DAY }),
    { id: 'plain', deletedAt: 0, meta: {} },
    { id: 'trashed', deletedAt: NOW, meta: { horizon: { at: NOW - DAY, plantedAt: NOW } } },
  ];
  const g = groupHorizon(notes, NOW);
  check('ripe band holds only the arrived ones', g.ripe.length === 2, JSON.stringify(g.ripe.map(e => e.note.id)));
  check('ripe is oldest-first (longest waiting reads first)',
    g.ripe[0].note.id === 'ripe-old', JSON.stringify(g.ripe.map(e => e.note.id)));
  check('growing is soonest-first',
    JSON.stringify(g.growing.map(e => e.note.id)) === '["soon","far"]');
  check('someday is its own band, newest planting first',
    JSON.stringify(g.someday.map(e => e.note.id)) === '["someday","someday-older"]');
  check('settled band', g.settled.length === 1 && g.settled[0].note.id === 'settled');
  check('an unplanted note appears nowhere',
    !JSON.stringify(g).includes('"plain"'));
  check('a trashed note appears nowhere', !JSON.stringify(g).includes('"trashed"'));
  check('null-safe', JSON.stringify(groupHorizon(null, NOW)) === JSON.stringify(groupHorizon([], NOW)));

  const counts = horizonCounts(notes, NOW);
  check('counts: ripe', counts.ripe === 2, JSON.stringify(counts));
  check('counts: open excludes settled', counts.open === 6, JSON.stringify(counts));
  check('counts: settled', counts.settled === 1, JSON.stringify(counts));

  const years = byYear(g.growing);
  check('growing splits into calendar years', years.length === 2, JSON.stringify(years.map(y => y.year)));
  check('years ascend', years[0].year === 2026 && years[1].year === 2030,
    JSON.stringify(years.map(y => y.year)));
  check('byYear is null-safe', byYear(null).length === 0);
}

section('(i) labels stay coarse on a long arc');
{
  check('someday', horizonLabel({ at: 0 }, NOW) === 'someday');
  check('today (future, same day)', horizonLabel({ at: NOW + 3600_000 }, NOW) === 'today');
  check('ripe today', horizonLabel({ at: NOW - 3600_000 }, NOW) === 'ripe today');
  check('days inside 45', horizonLabel({ at: NOW + 10 * DAY }, NOW) === 'in 10 days');
  check('singular day', horizonLabel({ at: NOW + 1 * DAY }, NOW) === 'in 1 day');
  check('months past 45 days', horizonLabel({ at: NOW + 90 * DAY }, NOW) === 'in 3 months');
  check('years past two', horizonLabel({ at: NOW + 3 * YEAR }, NOW) === 'in 3 years');
  check('overdue reads backwards', horizonLabel({ at: NOW - 2 * YEAR }, NOW) === 'ripe 2 years ago');
  check('null-safe', horizonLabel(null, NOW) === '');
  check('horizonDate formats sortably', horizonDate(NOW) === '2026-09-20');
  check('horizonDate(0) is someday', horizonDate(0) === 'someday');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall horizon checks passed');
process.exit(failed ? 1 : 0);
