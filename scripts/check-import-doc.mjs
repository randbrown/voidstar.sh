// Smoke tests for the mind document importer/exporter — pure functions only
// (no IndexedDB), so they run under plain node:  node scripts/check-import-doc.mjs
//
// Covers: heading split, level auto-detect, plain-text date-lines, preamble,
// dateless 1-minute descent, and the export → import round-trip.

import { parseDocIntoNotes, parseBatchIntoNotes, fingerprintNote, markDuplicates, titleFromFileName } from '../src/lib/mind/import-doc.js';
import { buildDocFromNotes } from '../src/lib/mind/export.js';
import { extractDate } from '../src/lib/mind/dates.js';

const YEAR = new Date().getFullYear();      // extractDate's own default, for its direct tests
const DOC_YEAR = 2026;                      // NOW's year — what a year-less date in these docs resolves to
const NOW = Date.parse('2026-08-01T00:00:00'); // fixed anchor for descent checks
const GAP = 60_000;

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── (a) markdown, ##-per-day, newest-first ──
section('(a) heading split, newest-first, pure-date daily');
{
  const doc = [
    '## July 8, 2026',
    'did stuff today',
    '- [ ] follow up',
    '',
    '## July 7, 2026',
    'older note',
  ].join('\n');
  const { sections, mode } = parseDocIntoNotes(doc, { now: NOW });
  check('mode = headings', mode === 'headings', mode);
  check('2 sections', sections.length === 2, String(sections.length));
  check('dates parsed', sections[0].dateIso === '2026-07-08' && sections[1].dateIso === '2026-07-07');
  check('createdAt strictly descending', sections[0].createdAt > sections[1].createdAt);
  check('both marked daily (pure-date headers)', sections[0].isDaily && sections[1].isDaily);
  check('body captured', sections[0].body.includes('did stuff today') && sections[0].body.includes('- [ ] follow up'));
}

// ── (b) mixed #/##/### → level auto-detect, deeper heading stays inline ──
section('(b) level auto-detect, ### stays inline');
{
  const doc = [
    '## 2026-07-08 Tuesday',
    'morning thoughts',
    '### ideas',
    '- one',
    '## 2026-07-07 Monday',
    'evening',
  ].join('\n');
  const { sections, headingLevel } = parseDocIntoNotes(doc, { now: NOW });
  check('chosen heading level = 2', headingLevel === 2, String(headingLevel));
  check('2 sections (### did not split)', sections.length === 2, String(sections.length));
  check('### kept inside body', sections[0].body.includes('### ideas') && sections[0].body.includes('- one'));
  check('dated-but-not-pure header is NOT daily', sections[0].isDaily === false && sections[0].dateIso === '2026-07-08');
}

// ── (c) plain text, date-dominant lines split; prose date does not ──
section('(c) date-lines mode; prose date ignored');
{
  const doc = [
    'Random intro paragraph without a date.',
    '',
    '6/14',
    'Talked with Sam about the whole plan for the upcoming release and more.',
    'We also revisited the 6/14 milestone mentioned earlier in that same thread.',
    '',
    '6/13',
    'Earlier note.',
  ].join('\n');
  const { sections, mode, stats } = parseDocIntoNotes(doc, { now: NOW });
  check('mode = dates', mode === 'dates', mode);
  check('3 sections (preamble + 2 dates)', sections.length === 3, String(sections.length));
  check('preamble flagged', stats.preamble === true);
  check('6/14 → the document\u2019s year', sections[1].dateIso === `${DOC_YEAR}-06-14`, sections[1].dateIso);
  check('prose 6/14 did not split', sections[1].body.includes('milestone mentioned earlier'));
  check('6/13 section body', sections[2].body.trim() === 'Earlier note.');
}

// ── (d) keepPreamble:false drops the intro ──
section('(d) keepPreamble false');
{
  const doc = ['intro', '', '## 2026-07-08', 'body'].join('\n');
  const kept = parseDocIntoNotes(doc, { now: NOW, keepPreamble: true });
  const dropped = parseDocIntoNotes(doc, { now: NOW, keepPreamble: false });
  check('kept has 2 sections', kept.sections.length === 2, String(kept.sections.length));
  check('dropped has 1 section', dropped.sections.length === 1, String(dropped.sections.length));
}

// ── (e) dateless interleave → 1-minute descent ──
section('(e) dateless section descends by one minute');
{
  const doc = ['## 2026-07-08', 'first', '## notes', 'middle', '## 2026-07-06', 'last'].join('\n');
  const { sections } = parseDocIntoNotes(doc, { now: NOW });
  check('3 sections', sections.length === 3, String(sections.length));
  check('dateless sits 1 min under prior', sections[1].createdAt === sections[0].createdAt - GAP,
    `${sections[0].createdAt - sections[1].createdAt}`);
  check('all strictly descending', sections[0].createdAt > sections[1].createdAt && sections[1].createdAt > sections[2].createdAt);
}

// ── (f) round-trip: export → import recovers title/date/tags/body/id ──
section('(f) export → import round-trip');
{
  const notes = [
    { id: 'aaaa1111', title: 'Morning pages', body: 'woke up early\n\n## sub in body\nstuff',
      tags: ['journal', 'work'], meta: {}, createdAt: Date.parse('2026-07-08T09:00:00'), deletedAt: 0 },
    { id: 'bbbb2222', title: '2026-07-07', body: 'quiet day',
      tags: [], meta: { daily: '2026-07-07' }, createdAt: Date.parse('2026-07-07T09:00:00'), deletedAt: 0 },
  ];
  const doc = buildDocFromNotes(notes, {});
  const { sections, mode } = parseDocIntoNotes(doc, { now: NOW });
  check('mode = export', mode === 'export', mode);
  check('2 sections (## in body did NOT over-split)', sections.length === 2, String(sections.length));
  const a = sections[0];
  check('title recovered', a.title === 'Morning pages', a.title);
  check('date recovered', a.dateIso === '2026-07-08', a.dateIso);
  check('tags recovered', JSON.stringify(a.tags) === JSON.stringify(['journal', 'work']), JSON.stringify(a.tags));
  check('id recovered (for upsert)', a.id === 'aaaa1111', a.id);
  check('body incl. inline ## preserved', a.body === 'woke up early\n\n## sub in body\nstuff', JSON.stringify(a.body));
  const b = sections[1];
  check('daily recovered', b.isDaily === true && b.dateIso === '2026-07-07');
  check('daily title recovered', b.title === '2026-07-07', b.title);
  check('daily body recovered', b.body === 'quiet day', b.body);
}

// ── (g) markDuplicates: content dup → skip; id match → upsert ──
section('(g) duplicate detection');
{
  const existing = [
    { id: 'x1', title: 'Old note', body: 'same content', tags: [], meta: {}, deletedAt: 0 },
    { id: 'aaaa1111', title: 'whatever', body: 'whatever', tags: [], meta: { daily: '2026-07-07' }, deletedAt: 0 },
  ];
  const sections = [
    { title: 'Old note', body: 'same content', dateIso: '', isDaily: false, tags: [], id: '' },
    { title: 'New', body: 'new body', dateIso: '2026-07-07', isDaily: true, tags: [], id: 'aaaa1111' },
    { title: 'Also daily', body: 'z', dateIso: '2026-07-07', isDaily: true, tags: [], id: '' },
  ];
  markDuplicates(sections, existing);
  check('content dup pre-checked skip', sections[0].skip === true && sections[0].dup?.kind === 'content');
  check('id match → upsert, not skip', sections[1].upsertId === 'aaaa1111' && sections[1].skip === false);
  check('daily collision clears isDaily', sections[2].isDaily === false && sections[2].dailyCollision === true);
  check('fingerprint stable', fingerprintNote({ title: 'A B', body: 'x' }) === fingerprintNote({ title: ' a  b ', body: ' x ' }));
}

// ── (h) single mode: whole document → one note, no split ──
section('(h) split: none (single note)');
{
  const doc = [
    '## 2026-07-08',
    'first day',
    '## 2026-07-07',
    'second day',
  ].join('\n');
  const { sections, mode } = parseDocIntoNotes(doc, { now: NOW, mode: 'single' });
  check('mode = single', mode === 'single', mode);
  check('1 section', sections.length === 1, String(sections.length));
  check('body keeps every heading inline', sections[0].body.includes('## 2026-07-08') && sections[0].body.includes('## 2026-07-07'));
  check('title from first line', sections[0].title === '2026-07-08', sections[0].title);
  // An export doc forced to single collapses to one note too.
  const exp = buildDocFromNotes([
    { id: 'z1', title: 'A', body: 'aaa', tags: [], meta: {}, createdAt: Date.parse('2026-07-08T09:00:00'), deletedAt: 0 },
    { id: 'z2', title: 'B', body: 'bbb', tags: [], meta: {}, createdAt: Date.parse('2026-07-07T09:00:00'), deletedAt: 0 },
  ], {});
  const one = parseDocIntoNotes(exp, { now: NOW, mode: 'single' });
  check('export forced to single → 1 note', one.sections.length === 1, String(one.sections.length));
}

// ── (i) date lines only split under a blank line ──
section('(i) blank-line-above split rule');
{
  const doc = [
    '6/14',            // line 0: opens the doc → splits
    'first entry',
    'notes continue',
    '6/13',            // no blank line above → NOT a boundary
    'still first entry body',
    '',
    '6/12',            // blank line above → splits
    'third entry',
  ].join('\n');
  const { sections } = parseDocIntoNotes(doc, { now: NOW, mode: 'dates' });
  check('2 sections (mid-run 6/13 did not split)', sections.length === 2, String(sections.length));
  check('6/13 stays in the first body', sections[0].body.includes('6/13') && sections[0].body.includes('still first entry body'));
  check('6/12 split (blank line above)', sections[1].dateIso === `${DOC_YEAR}-06-12`, sections[1].dateIso);
}

// ── (j) musical time signatures never split / mint dates ──
section('(j) time-signature guard');
{
  const doc = [
    '4/4',            // time signature, not a date
    'practiced the intro riff',
    '',
    '6/8',            // time signature (June 8 would be valid, but denom is power-of-two)
    'switched to compound feel',
    '',
    '6/14',           // real date (day 14 is no time-sig denominator)
    'journal entry',
  ].join('\n');
  const { sections } = parseDocIntoNotes(doc, { now: NOW, mode: 'dates' });
  check('only the real date splits', sections.length === 2, String(sections.length));
  check('preamble holds the time-signature lines', sections[0].body.includes('4/4') && sections[0].body.includes('6/8'));
  check('6/14 recognized as the date', sections[1].dateIso === `${DOC_YEAR}-06-14`, sections[1].dateIso);
  // extractDate opt: bare power-of-two slash rejected, dash / year-bearing kept.
  check('extractDate rejects 4/4 as time sig', extractDate('4/4', YEAR, { rejectTimeSignatures: true }) === null);
  check('extractDate keeps 6/14', extractDate('6/14', YEAR, { rejectTimeSignatures: true })?.iso === `${YEAR}-06-14`);
  check('extractDate keeps 4-4 (dash, no year)', extractDate('4-4', YEAR, { rejectTimeSignatures: true })?.iso === `${YEAR}-04-04`);
  check('extractDate keeps 6/8/26 (year present)', extractDate('6/8/26', YEAR, { rejectTimeSignatures: true })?.iso === '2026-06-08');
  check('default (no opt) still treats 4/4 as a date', extractDate('4/4', YEAR)?.iso === `${YEAR}-04-04`);
}

// ── (k) dash dates without a year ──
section('(k) dash date, no year');
{
  const doc = ['6-14', 'dashed date entry', '', '6-13', 'earlier'].join('\n');
  const { sections, mode } = parseDocIntoNotes(doc, { now: NOW, mode: 'dates' });
  check('mode = dates', mode === 'dates', mode);
  check('2 dashed-date sections', sections.length === 2, String(sections.length));
  check('6-14 → the document\u2019s year', sections[0].dateIso === `${DOC_YEAR}-06-14`, sections[0].dateIso);
}

// ── (l) batch: each doc split per settings, concatenated, cross-doc daily dedupe ──
section('(l) batch split across documents');
{
  const docA = ['## 2026-07-08', 'entry A8', '## 2026-07-07', 'entry A7'].join('\n');
  const docB = ['## 2026-07-08', 'entry B8 (same day, other doc)', '## 2026-07-06', 'entry B6'].join('\n');
  const { sections, mode, stats } = parseBatchIntoNotes(
    [{ name: 'A.md', text: docA }, { name: 'B.md', text: docB }],
    { now: NOW });
  check('mode = batch', mode === 'batch', mode);
  check('stats.docs = 2', stats.docs === 2, String(stats.docs));
  check('4 sections total (2 per doc)', sections.length === 4, String(sections.length));
  check('all strictly descending across docs',
    sections.every((s, i) => i === 0 || sections[i - 1].createdAt > s.createdAt),
    sections.map((s) => s.createdAt).join(','));
  // 2026-07-08 appears as a pure-date daily in BOTH docs → only the first claims it.
  const day8 = sections.filter((s) => s.dateIso === '2026-07-08');
  check('same daily date across docs deduped', day8.length === 2 && day8[0].isDaily === true && day8[1].isDaily === false,
    day8.map((s) => s.isDaily).join(','));
}

// ── (m) batch combine: whole batch → exactly one note ──
section('(m) batch combine into one note');
{
  const docA = ['## 2026-07-08', 'alpha'].join('\n');
  const docB = ['## 2026-07-07', 'beta'].join('\n');
  const { sections, mode, combine } = parseBatchIntoNotes(
    [{ name: 'A.md', text: docA }, { name: 'B.md', text: docB }],
    { now: NOW, combine: true });
  check('mode = combine', mode === 'combine', mode);
  check('combine flag set', combine === true);
  check('exactly one note', sections.length === 1, String(sections.length));
  check('both documents present in the single body',
    sections[0].body.includes('alpha') && sections[0].body.includes('beta'));
  // Empty/whitespace docs are dropped, not turned into blank notes.
  const only = parseBatchIntoNotes([{ text: '   ' }, { name: 'real', text: '# hi\nbody' }], { now: NOW });
  check('blank docs skipped', only.stats.docs === 1, String(only.stats.docs));
}

// ── (n) markDuplicates: filesystem-style upsert by (folder, title) + newer flag ──
section('(n) path upsert + newer detection');
{
  const OLD = Date.parse('2026-06-01T00:00:00');
  const NEW = Date.parse('2026-07-01T00:00:00');
  const existing = [
    { id: 'p1', title: 'Weekly plan', body: 'old body', tags: [], meta: {}, folderId: 'work', updatedAt: OLD, deletedAt: 0 },
    { id: 'p2', title: 'Fresh note', body: 'local edits', tags: [], meta: {}, folderId: 'work', updatedAt: NEW, deletedAt: 0 },
    { id: 'p3', title: 'Weekly plan', body: 'other folder', tags: [], meta: {}, folderId: 'home', updatedAt: OLD, deletedAt: 0 },
  ];
  // Section titled "Weekly plan" imported into 'work' with a newer source time → update p1.
  const sections = [
    { title: 'Weekly plan', body: 'new body', dateIso: '', isDaily: false, tags: [], id: '', srcModified: NEW },
    { title: 'Fresh note', body: 'stale import', dateIso: '', isDaily: false, tags: [], id: '', srcModified: OLD },
    { title: 'Brand new', body: 'x', dateIso: '', isDaily: false, tags: [], id: '', srcModified: NEW },
  ];
  markDuplicates(sections, existing, { matchByTitle: true, folderId: 'work' });
  check('title+folder match → upsert p1 (not p3 in other folder)', sections[0].upsertId === 'p1', sections[0].upsertId);
  check('newer source → not flagged, stays checked', sections[0].newerExists === false && sections[0].skip === false);
  check('local note newer than import → flagged + unchecked', sections[1].upsertId === 'p2' && sections[1].newerExists === true && sections[1].skip === true);
  check('unmatched title → new note', sections[2].upsertId === '' && sections[2].dup === null);

  // matchByTitle off → legacy behavior, no path upsert.
  const legacy = [{ title: 'Weekly plan', body: 'new body', dateIso: '', isDaily: false, tags: [], id: '', srcModified: NEW }];
  markDuplicates(legacy, existing);
  check('no title matching without opts', legacy[0].upsertId === '' && legacy[0].dup === null);

  // A brand-new target folder (folderId undefined) disables title matching.
  const newFolder = [{ title: 'Weekly plan', body: 'new body', dateIso: '', isDaily: false, tags: [], id: '', srcModified: NEW }];
  markDuplicates(newFolder, existing, { matchByTitle: true, folderId: undefined });
  check('undefined target folder → no title match', newFolder[0].upsertId === '');
}

// ── (o) filename titles whole-doc imports; split sections keep header titles ──
section('(o) sourceName → whole-doc note title');
{
  check('extension stripped', titleFromFileName('Practice Log.md') === 'Practice Log', titleFromFileName('Practice Log.md'));
  check('Doc name (no extension) kept', titleFromFileName('Untitled document') === 'Untitled document');
  check('non-text extension untouched', titleFromFileName('archive.tar.gz') === 'archive.tar.gz');
  check('empty name → empty', titleFromFileName('') === '');

  const prose = 'first line of prose\nmore text, no headings or dates';
  const named = parseDocIntoNotes(prose, { now: NOW, sourceName: 'Practice Log.md' });
  check('no-boundary whole doc titled by filename', named.sections[0].title === 'Practice Log', named.sections[0].title);
  check('whole-doc flag exposed', named.sections[0].wholeDoc === true);
  const unnamed = parseDocIntoNotes(prose, { now: NOW });
  check('no sourceName → first line still titles', unnamed.sections[0].title === 'first line of prose', unnamed.sections[0].title);

  const dated = ['## 2026-07-08', 'x', '## 2026-07-07', 'y'].join('\n');
  const single = parseDocIntoNotes(dated, { now: NOW, mode: 'single', sourceName: 'Journal' });
  check('single mode titled by filename', single.sections[0].title === 'Journal', single.sections[0].title);

  const split = parseDocIntoNotes(['intro text', '', ...dated.split('\n')].join('\n'), { now: NOW, sourceName: 'Journal.md' });
  check('split sections keep header titles', split.sections.some((s) => s.title === '2026-07-08'),
    split.sections.map((s) => s.title).join(','));
  check('preamble keeps first-line title (not filename)', split.sections[0].title === 'intro text', split.sections[0].title);
  check('split sections not whole-doc', split.sections.every((s) => s.wholeDoc === false));
}

// ── (p) batch: per-doc filename titles + source timestamps stamped ──
section('(p) batch sourceName + srcCreated/srcModified');
{
  const C = Date.parse('2024-03-01T10:00:00');
  const M = Date.parse('2026-06-01T10:00:00');
  const { sections } = parseBatchIntoNotes(
    [{ name: 'Old idea.md', text: 'just one line of prose', modifiedMs: M, createdMs: C }],
    { now: NOW });
  check('batch whole-doc titled by its filename', sections[0].title === 'Old idea', sections[0].title);
  check('srcModified stamped', sections[0].srcModified === M, String(sections[0].srcModified));
  check('srcCreated stamped', sections[0].srcCreated === C, String(sections[0].srcCreated));

  // Combine: modified = latest doc, created = earliest; multi-doc has no single
  // filename (falls back to first line), a one-doc batch keeps its name.
  const combo = parseBatchIntoNotes([
    { name: 'A.md', text: 'alpha', modifiedMs: 500, createdMs: 200 },
    { name: 'B.md', text: 'beta', modifiedMs: 900, createdMs: 100 },
  ], { now: NOW, combine: true });
  check('combine: modified = latest', combo.sections[0].srcModified === 900, String(combo.sections[0].srcModified));
  check('combine: created = earliest', combo.sections[0].srcCreated === 100, String(combo.sections[0].srcCreated));
  check('combine multi-doc falls back to first line', combo.sections[0].title === 'alpha', combo.sections[0].title);
  const solo = parseBatchIntoNotes([{ name: 'Solo.md', text: 'hello world', modifiedMs: 2, createdMs: 1 }],
    { now: NOW, combine: true });
  check('combine of one doc titled by filename', solo.sections[0].title === 'Solo', solo.sections[0].title);

  // Missing metadata degrades to 0 (unknown), never NaN.
  const bare = parseBatchIntoNotes([{ name: 'X', text: 'y' }], { now: NOW });
  check('missing times → 0', bare.sections[0].srcModified === 0 && bare.sections[0].srcCreated === 0);
}

// ── (q) year inference for year-less dates ──
// The "today" bug: a 2025 journal imported in 2026 filed every "7/30" header
// under 2026, and a date-only header then claimed THIS year's daily key.
section('(q) year-less dates resolve against the document, not the clock');
{
  // A stale Google Doc: last edited 2025-12-31, headers carry no year.
  // (8/12, not 8/2 — a bare "N/D" with a power-of-two denominator is read as a
  // time signature by the importer, never a date.)
  const journal = ['## 12/30', 'new year eve eve', '', '## 8/12', 'summer', '', '## 7/30', 'the note in question'].join('\n');
  const docTime = Date.parse('2025-12-31T10:00:00');
  const { sections } = parseDocIntoNotes(journal, { now: NOW, docTime });
  check('newest entry takes the file’s year', sections[0].dateIso === '2025-12-30', sections[0].dateIso);
  check('later entries follow it', sections[1].dateIso === '2025-08-12', sections[1].dateIso);
  check('7/30 is LAST year, not today', sections[2].dateIso === '2025-07-30', sections[2].dateIso);
  check('year-less dates are flagged as guesses', sections.every((s) => s.dateYearGuessed));
  check('and they are still daily notes', sections.every((s) => s.isDaily));

  // Same doc, no file time known (pasted text): rule 1 alone still pulls a
  // date that would land far in the future back a year.
  const pasted = parseDocIntoNotes(journal, { now: NOW }).sections;
  check('pasted: 12/30 rolls back (would be 5 months out)', pasted[0].dateIso === '2025-12-30', pasted[0].dateIso);
  check('pasted: descending walk keeps 8/12 in 2025', pasted[1].dateIso === '2025-08-12', pasted[1].dateIso);

  // A multi-year journal crossing New Year, newest first.
  const crossing = ['## 1/3', 'jan', '', '## 12/28', 'dec', '', '## 12/20', 'earlier dec'].join('\n');
  const x = parseDocIntoNotes(crossing, { now: NOW, docTime: Date.parse('2026-01-04T09:00:00') }).sections;
  check('1/3 stays in the new year', x[0].dateIso === '2026-01-03', x[0].dateIso);
  check('12/28 wraps back a year', x[1].dateIso === '2025-12-28', x[1].dateIso);
  check('12/20 stays in the same year as 12/28', x[2].dateIso === '2025-12-20', x[2].dateIso);

  // An explicit year is trusted as written AND re-anchors the walk.
  const anchored = ['## 3/2/2024', 'explicit', '', '## 2/28', 'year-less, just before it'].join('\n');
  const a = parseDocIntoNotes(anchored, { now: NOW }).sections;
  check('explicit year kept', a[0].dateIso === '2024-03-02', a[0].dateIso);
  check('explicit year not flagged as a guess', !a[0].dateYearGuessed);
  check('following year-less date follows the anchor', a[1].dateIso === '2024-02-28', a[1].dateIso);

  // Oldest-first documents walk the other way.
  const asc = ['## 12/20', 'dec', '', '## 12/28', 'later dec', '', '## 1/3', 'jan'].join('\n');
  const o = parseDocIntoNotes(asc, { now: NOW, order: 'oldest-first', docTime: Date.parse('2026-01-04T09:00:00') }).sections;
  check('oldest-first: last entry is the newest year', o[2].dateIso === '2026-01-03', o[2].dateIso);
  check('oldest-first: earlier entries wrap back', o[0].dateIso === '2025-12-20' && o[1].dateIso === '2025-12-28',
    `${o[0].dateIso} / ${o[1].dateIso}`);

  // A near-future planning date is not mistaken for last year.
  const plan = ['## 8/20', 'plan ahead', '', '## 8/15', 'sooner'].join('\n');
  const p = parseDocIntoNotes(plan, { now: NOW }).sections; // NOW = 2026-08-01
  check('a few weeks ahead stays put', p[0].dateIso === '2026-08-20', p[0].dateIso);

  // An unsorted document gets no wrap inference — each date is judged against
  // the anchor alone (rule 1). Reading every wobble as a year boundary would
  // scatter such a doc across years.
  const messy = ['## 6/11', 'a', '', '## 9/21', 'b', '', '## 2/13', 'c', '', '## 11/25', 'd'].join('\n');
  const m = parseDocIntoNotes(messy, { now: NOW }).sections; // NOW = 2026-08-01
  check('unsorted: no chained wrap, dates near the anchor stay put',
    m.slice(0, 3).every((s) => s.dateIso.startsWith('2026')), m.map((s) => s.dateIso).join(' '));
  check('unsorted: only a date past the slack window rolls back',
    m[3].dateIso === '2025-11-25', m[3].dateIso);

  // Batch: each document anchors on its OWN modified time.
  const b = parseBatchIntoNotes([
    { name: 'old.md', text: '## 7/30\nold entry', modifiedMs: Date.parse('2024-08-01T00:00:00') },
    { name: 'new.md', text: '## 7/30\nfresh entry', modifiedMs: Date.parse('2026-07-31T00:00:00') },
  ], { now: NOW }).sections;
  check('batch: 2024 doc → 2024', b[0].dateIso === '2024-07-30', b[0].dateIso);
  check('batch: 2026 doc → 2026', b[1].dateIso === '2026-07-30', b[1].dateIso);
  // Both stay daily notes precisely BECAUSE the years now differ — before
  // inference they collided on one date and one got demoted.
  check('batch: distinct years → both keep their daily key', b[0].isDaily && b[1].isDaily);
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
