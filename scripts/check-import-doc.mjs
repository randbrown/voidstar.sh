// Smoke tests for the mind document importer/exporter — pure functions only
// (no IndexedDB), so they run under plain node:  node scripts/check-import-doc.mjs
//
// Covers: heading split, level auto-detect, plain-text date-lines, preamble,
// dateless 1-minute descent, and the export → import round-trip.

import { parseDocIntoNotes, fingerprintNote, markDuplicates } from '../src/lib/mind/import-doc.js';
import { buildDocFromNotes } from '../src/lib/mind/export.js';

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

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
