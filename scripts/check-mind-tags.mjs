// Smoke tests for the tag pure core (normalization + common-tag ranking) —
// no DOM / IndexedDB, so they run under plain node:
//   node scripts/check-mind-tags.mjs

import { normalizeTag, tagStats, rankTags, TAG_SUGGEST_LIMIT } from '../src/lib/mind/tags.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const NOW = new Date(2026, 8, 20).getTime();
const DAY = 86_400_000;
const note = (tags, agoDays = 0, extra = {}) => ({
  id: `n${Math.random().toString(36).slice(2)}`,
  tags,
  updatedAt: NOW - agoDays * DAY,
  createdAt: NOW - agoDays * DAY,
  ...extra,
});

section('(a) normalizeTag');
{
  check('lowercases', normalizeTag('Ideas') === 'ideas');
  check('strips a leading hash', normalizeTag('#ideas') === 'ideas');
  check('strips repeated hashes', normalizeTag('##ideas') === 'ideas');
  check('spaces become hyphens', normalizeTag('big idea') === 'big-idea');
  check('runs of space collapse', normalizeTag('big   idea') === 'big-idea');
  check('outer whitespace trimmed', normalizeTag('  gear  ') === 'gear');
  check('punctuation dropped', normalizeTag('gear!?') === 'gear');
  check('slash and dot survive (nesting/versions)', normalizeTag('work/AirVision') === 'work/airvision');
  check('double hyphens collapse', normalizeTag('a -- b') === 'a-b', normalizeTag('a -- b'));
  check('edge hyphens trimmed', normalizeTag('-gear-') === 'gear');
  check('null-safe', normalizeTag(null) === '' && normalizeTag(undefined) === '');
  check('all-punctuation → empty', normalizeTag('!!!') === '');
}

section('(b) tagStats counts uses and recent uses');
{
  const notes = [
    note(['gear', 'rig'], 1),
    note(['gear'], 2),
    note(['gear'], 900),
    note(['lyrics'], 400),
  ];
  const stats = tagStats(notes, { now: NOW });
  const gear = stats.find(s => s.tag === 'gear');
  check('uses counted across notes', gear.uses === 3, JSON.stringify(gear));
  check('only recent uses count as recent', gear.recentUses === 2, JSON.stringify(gear));
  check('score = uses + recentUses', gear.score === 5, JSON.stringify(gear));
  const lyrics = stats.find(s => s.tag === 'lyrics');
  check('an old-only tag scores its raw count', lyrics.score === 1, JSON.stringify(lyrics));
}

section('(c) recency lifts the working set over a big old pile');
{
  const notes = [
    // An old favourite: used 4 times, but not in over a year.
    ...Array.from({ length: 4 }, () => note(['archive'], 500)),
    // This month's habit: 3 uses, all recent.
    ...Array.from({ length: 3 }, () => note(['horizon'], 3)),
  ];
  const ranked = rankTags(notes, { now: NOW });
  check('recent working set ranks first', ranked[0] === 'horizon', JSON.stringify(ranked));
  check('the old pile is still offered', ranked.includes('archive'), JSON.stringify(ranked));
}

section('(d) hygiene: dedupe, tombstones, normalization on the way in');
{
  const notes = [
    note(['Gear', '#gear', 'gear'], 1),           // one note, three spellings
    note(['gear'], 2, { deletedAt: NOW - DAY }),   // trashed — must not count
    note(['rig'], 2),
  ];
  const stats = tagStats(notes, { now: NOW });
  const gear = stats.find(s => s.tag === 'gear');
  check('spellings collapse to one tag', stats.filter(s => s.tag === 'gear').length === 1);
  check('one note counts once however often it lists the tag', gear.uses === 1, JSON.stringify(gear));
  check('a trashed note contributes nothing', gear.uses === 1 && stats.length === 2, JSON.stringify(stats));
  check('null note list is safe', tagStats(null).length === 0 && rankTags(undefined).length === 0);
  check('a note with no tags is safe', tagStats([{ id: 'x', updatedAt: NOW }]).length === 0);
}

section('(e) rankTags: exclusion + cap + deterministic ties');
{
  const notes = [note(['b'], 1), note(['a'], 1), note(['c'], 1)];
  check('equal scores break alphabetically',
    JSON.stringify(rankTags(notes, { now: NOW })) === '["a","b","c"]',
    JSON.stringify(rankTags(notes, { now: NOW })));
  check('tags already on the note are excluded',
    JSON.stringify(rankTags(notes, { now: NOW, exclude: ['a'] })) === '["b","c"]');
  check('exclusion normalizes too',
    JSON.stringify(rankTags(notes, { now: NOW, exclude: ['#A'] })) === '["b","c"]');
  check('limit caps the list', rankTags(notes, { now: NOW, limit: 2 }).length === 2);
  check('limit 0 returns nothing', rankTags(notes, { now: NOW, limit: 0 }).length === 0);
  const many = Array.from({ length: 30 }, (_, i) => note([`t${String(i).padStart(2, '0')}`], 1));
  check('default limit is the suggest cap',
    rankTags(many, { now: NOW }).length === TAG_SUGGEST_LIMIT);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall tag checks passed');
process.exit(failed ? 1 : 0);
