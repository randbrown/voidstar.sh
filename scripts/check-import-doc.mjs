// Smoke tests for the mind document importer/exporter — pure functions only
// (no IndexedDB), so they run under plain node:  node scripts/check-import-doc.mjs
//
// Covers: heading split, level auto-detect, plain-text date-lines, preamble,
// dateless 1-minute descent, and the export → import round-trip.

import { parseDocIntoNotes, parseBatchIntoNotes, fingerprintNote, markDuplicates } from '../src/lib/mind/import-doc.js';
import { buildDocFromNotes } from '../src/lib/mind/export.js';
import { extractDate } from '../src/lib/mind/dates.js';

const YEAR = new Date().getFullYear();
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
  check('6/14 → this year', sections[1].dateIso === `${YEAR}-06-14`, sections[1].dateIso);
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
  check('6/12 split (blank line above)', sections[1].dateIso === `${YEAR}-06-12`, sections[1].dateIso);
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
  check('6/14 recognized as the date', sections[1].dateIso === `${YEAR}-06-14`, sections[1].dateIso);
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
  check('6-14 → this year', sections[0].dateIso === `${YEAR}-06-14`, sections[0].dateIso);
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

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
