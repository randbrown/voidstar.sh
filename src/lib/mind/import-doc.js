// Smart document import: split one big markdown/plain-text document (e.g. a
// Google Doc of daily notes, newest at the top) into individual mind notes,
// parsing a date onto each section.
//
// parseDocIntoNotes / fingerprintNote / markDuplicates are PURE (no DOM, no
// IndexedDB) so they can be unit-tested from a plain node script — they import
// only ./dates.js and ./store.js, both of which are side-effect-free at load.
// commitDocImport is the only function that writes to the store.

import * as store from './store.js';
import { extractDate } from './dates.js';

// Document import treats a bare "4/4" as a musical time signature, not a date,
// so a chord chart or setlist never mints spurious dated notes.
const DATE_OPTS = { rejectTimeSignatures: true };
const findDate = (s) => extractDate(s, undefined, DATE_OPTS);

const GAP = 60_000; // 1-minute step between same-day / dateless sections
const HEADING_RE = /^(#{1,6})\s+(\S.*?)\s*#*\s*$/;
const EXPORT_META_RE = /^<!--\s*mind\s+(.*?)\s*-->\s*$/;
const TAG_LINE_RE = /^(#[\w-]+(?:\s+|$))+$/;

// First non-empty text line, stripped of markdown noise — the title fallback
// for a preamble or a heading-less section. (Kept local so the parser needn't
// import the prosemirror-backed editor/markdown.js.)
function firstLineOf(text) {
  for (const raw of (text || '').split('\n')) {
    const line = raw
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[>\-*+\s]+/, '')
      .replace(/[*_~`#]/g, '')
      .trim();
    if (line) return line.slice(0, 120);
  }
  return '';
}

// The text remaining once the matched date and surrounding separators are
// removed — used to judge whether a line/header is "essentially just a date".
function remainderAfterDate(text, d) {
  return (text.slice(0, d.index) + text.slice(d.index + d.length))
    .replace(/[\s\-–—,|·:.#]+/g, ' ')
    .trim();
}

// A line that is a date and little else — the boundary test for plain-text
// (no-`#`) exports. Guards keep a `6/14` inside a prose sentence from splitting.
function isDateLine(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  if (t.split(/\s+/).length > 6) return false;
  const d = findDate(t);
  if (!d) return false;
  const rest = remainderAfterDate(t, d);
  return (rest ? rest.split(/\s+/).filter(Boolean).length : 0) <= 2;
}

// Pick the heading level that starts a note: the level carrying the most dated
// headers (ties → shallowest); if none are dated, the shallowest level present.
function chooseHeadingLevel(headings, override) {
  if (override && override !== 'auto') return +override;
  const present = new Set(headings.map((h) => h.level));
  if (!present.size) return 1;
  let best = null;
  let bestDated = -1;
  for (let lvl = 1; lvl <= 6; lvl++) {
    if (!present.has(lvl)) continue;
    const dated = headings.filter((h) => h.level === lvl && findDate(h.text)).length;
    if (dated > bestDated) { bestDated = dated; best = lvl; } // strict → ties keep shallower
  }
  return best;
}

// "date=… tags=a,b daily id=…" → structured overrides (export round-trip).
function parseMetaComment(inner) {
  const out = {};
  for (const tok of inner.trim().split(/\s+/)) {
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq === -1) { if (tok === 'daily') out.daily = true; continue; }
    const k = tok.slice(0, eq);
    const v = tok.slice(eq + 1);
    if (k === 'date') out.date = v;
    else if (k === 'tags') out.tags = v.split(',').map((s) => s.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
    else if (k === 'daily') out.daily = v || true;
    else if (k === 'id') out.id = v;
  }
  return out;
}

function tagsFromLine(line) {
  return (line.match(/#([\w-]+)/g) || []).map((t) => t.slice(1).toLowerCase());
}

function stripDateSuffix(title, iso) {
  if (!iso) return title;
  const esc = iso.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleaned = title.replace(new RegExp(`\\s*[—–-]\\s*${esc}\\s*$`), '').trim();
  return cleaned || title;
}

/**
 * Split a document into a preview list of would-be notes. Pure & deterministic
 * given opts.now.
 *
 * @param {string} text
 * @param {object} [opts]
 *   mode: 'auto'|'headings'|'dates'   (auto → headings when ≥2 ATX headings)
 *   headingLevel: 'auto'|1..6         (which level starts a note, headings mode)
 *   keepPreamble: boolean (default true) — content before the first boundary
 *   markDailies: boolean (default true) — date-only sections become daily notes
 *   order: 'newest-first'|'oldest-first' (how the DOC is ordered; default newest)
 *   now: number (default Date.now())
 * @returns {{sections:Array, mode:string, headingLevel:number|null, stats:object, warnings:string[]}}
 */
export function parseDocIntoNotes(text, opts = {}) {
  const {
    keepPreamble = true,
    markDailies = true,
    order = 'newest-first',
    now = Date.now(),
  } = opts;
  const headingOverride = opts.headingLevel || 'auto';
  const warnings = [];

  let lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');

  // Strip our own export document header (a `<!-- mind-export … -->` line and an
  // optional single `# …` title right after it) so a round-tripped export never
  // mints a junk note from its own title. Only the mind-export marker triggers
  // this, so a real user `# Title` in a normal doc is untouched.
  let exportDoc = false;
  {
    let k = 0;
    while (k < lines.length && !lines[k].trim()) k++;
    if (k < lines.length && /^<!--\s*mind-export\b.*-->\s*$/.test(lines[k].trim())) {
      exportDoc = true;
      k++;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && /^#\s+\S/.test(lines[k])) k++;
      lines = lines.slice(k);
    }
  }

  // ── mode detection ──
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) headings.push({ index: i, level: m[1].length, text: m[2].trim() });
  }
  let mode = opts.mode && opts.mode !== 'auto' ? opts.mode : (headings.length >= 2 ? 'headings' : 'dates');
  // 'single' (no-split) is an explicit user choice — it wins even over our own
  // export format, so "import as one note" always yields exactly one note.
  if (exportDoc && mode !== 'single') mode = 'export';

  // ── boundary detection ──
  // 'single' leaves boundaries empty on purpose: the whole document (minus any
  // export header stripped above) becomes one note.
  let chosenLevel = null;
  const boundaries = []; // {index, headerText, level}
  if (mode === 'export') {
    // Our own export: a note starts at a heading whose next non-blank line is a
    // `<!-- mind … -->` metadata comment. This ignores `##`/`###` inside a note
    // body (never followed by a mind comment), so round-trip can't over-split.
    for (const h of headings) {
      let j = h.index + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && EXPORT_META_RE.test(lines[j].trim())) {
        boundaries.push({ index: h.index, headerText: h.text, level: h.level });
      }
    }
    if (!boundaries.length) mode = 'headings'; // export with no comments → fall back
  }
  if (mode === 'headings') {
    chosenLevel = chooseHeadingLevel(headings, headingOverride);
    for (const h of headings) {
      if (h.level <= chosenLevel) boundaries.push({ index: h.index, headerText: h.text, level: h.level });
    }
    if (!boundaries.length) mode = 'dates'; // no heading at/above the chosen level
  }
  if (mode === 'dates') {
    chosenLevel = null;
    // A bare date only splits when it's set off by a blank line above (or opens
    // the document) — so a date written mid-paragraph, or a table/list row that
    // happens to start with one, is never mistaken for a day boundary.
    for (let i = 0; i < lines.length; i++) {
      const blankAbove = i === 0 || !lines[i - 1].trim();
      if (blankAbove && isDateLine(lines[i])) boundaries.push({ index: i, headerText: lines[i].trim(), level: 0 });
    }
  }

  // ── assemble raw sections (document order) ──
  const raw = [];
  let hasPreamble = false;
  if (mode === 'single') {
    // No-split: the entire document is one note (only meaningful when there's
    // something to import).
    if (lines.join('\n').trim()) raw.push({ headerRaw: '', level: 0, bodyLines: lines });
  } else {
    const preambleEnd = boundaries.length ? boundaries[0].index : lines.length;
    const preambleText = lines.slice(0, preambleEnd).join('\n').trim();
    if (preambleText) {
      if (boundaries.length && keepPreamble) {
        raw.push({ headerRaw: '', level: 0, bodyLines: lines.slice(0, preambleEnd) });
        hasPreamble = true;
      } else if (!boundaries.length) {
        // No boundaries at all — import the whole doc as a single note.
        raw.push({ headerRaw: '', level: 0, bodyLines: lines });
        warnings.push('No headings or dates found — importing as a single note.');
      }
    }
    for (let b = 0; b < boundaries.length; b++) {
      const cur = boundaries[b];
      const end = b + 1 < boundaries.length ? boundaries[b + 1].index : lines.length;
      raw.push({
        headerRaw: cur.headerText,
        level: cur.level,
        bodyLines: lines.slice(cur.index + 1, end),
      });
    }
  }

  // ── derive per-section fields ──
  const seenDaily = new Set();
  const sections = raw.map((r) => {
    let bodyLines = r.bodyLines.slice();
    // Trim leading/trailing blank body lines.
    while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
    while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();

    // Lift an export metadata comment or a bare hashtag line off the top.
    let metaOverride = null;
    let tagLine = null;
    if (bodyLines.length) {
      const mm = EXPORT_META_RE.exec(bodyLines[0].trim());
      if (mm) { metaOverride = parseMetaComment(mm[1]); bodyLines.shift(); while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift(); }
    }
    if (!metaOverride && bodyLines.length && TAG_LINE_RE.test(bodyLines[0].trim())) {
      tagLine = tagsFromLine(bodyLines[0]); bodyLines.shift(); while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
    }

    const header = r.headerRaw;
    const d = header ? findDate(header) : null;
    let dateIso = metaOverride?.date || (d ? d.iso : '');

    // Title: full cleaned header, minus a trailing " — <iso>" written by export.
    let title = header ? stripDateSuffix(header, dateIso) : firstLineOf(bodyLines.join('\n'));
    if (!title) title = dateIso || 'untitled';

    // Daily: header is essentially just a date (or the export said so).
    let isDaily = false;
    if (metaOverride && metaOverride.daily) {
      isDaily = true;
      if (typeof metaOverride.daily === 'string') dateIso = metaOverride.daily;
    } else if (markDailies && dateIso && header && d && remainderAfterDate(header, d) === '') {
      isDaily = true;
    }
    // Batch-internal dedupe: only the first section per date claims the daily key.
    if (isDaily) {
      if (seenDaily.has(dateIso)) isDaily = false;
      else seenDaily.add(dateIso);
    }

    const tags = metaOverride?.tags || tagLine || [];
    return {
      title,
      dateIso,
      isDaily,
      body: bodyLines.join('\n'),
      tags,
      headerRaw: header,
      level: r.level,
      id: metaOverride?.id || '',
      createdAt: 0,
      updatedAt: 0,
    };
  });

  // ── timestamps: strictly descending so the newest section sorts to the top ──
  // Process newest-first: for a newest-first doc that's document order, for an
  // oldest-first doc it's the reverse (so the last, newest section gets the
  // largest timestamp).
  const seq = order === 'oldest-first' ? [...sections].reverse() : sections;
  let prevTs = now;
  for (const s of seq) {
    const anchor = s.dateIso ? Date.parse(`${s.dateIso}T12:00:00`) : NaN;
    let cand = Number.isNaN(anchor) ? prevTs - GAP : anchor;
    if (cand >= prevTs) cand = prevTs - GAP; // enforce strict descent
    s.createdAt = cand;
    s.updatedAt = cand;
    prevTs = cand;
  }

  const dated = sections.filter((s) => s.dateIso).length;
  return {
    sections,
    mode,
    headingLevel: chosenLevel,
    stats: { total: sections.length, dated, dateless: sections.length - dated, preamble: hasPreamble },
    warnings,
  };
}

/**
 * Split MULTIPLE documents into a single combined preview list of would-be
 * notes. Each document is split independently with the same options — so the
 * split setting (`mode`/`headingLevel`/…) is honored per-document — or, with
 * `opts.combine`, the whole batch is imported as ONE note (split mode ignored).
 *
 * Pure & deterministic given `opts.now`, so it's unit-testable without a DOM.
 *
 * @param {Array<{name?:string, text:string}>} docs
 * @param {object} [opts]  same shape as parseDocIntoNotes, plus:
 *   combine: boolean — merge the entire batch into a single note
 * @returns {{sections:Array, mode:string, stats:object, warnings:string[], combine:boolean}}
 */
export function parseBatchIntoNotes(docs, opts = {}) {
  const list = (docs || []).filter((d) => d && String(d.text || '').trim());
  const { combine = false, now = Date.now() } = opts;

  if (combine) {
    // Whole batch → one note: concatenate every document, then force single mode
    // (a blank line between docs so their content doesn't run together).
    const merged = list.map((d) => String(d.text || '').trim()).join('\n\n');
    const p = parseDocIntoNotes(merged, { ...opts, mode: 'single', now });
    const mtime = list.reduce((m, d) => Math.max(m, Number(d.modifiedMs) || 0), 0);
    for (const s of p.sections) s.srcModified = mtime;
    return {
      sections: p.sections,
      mode: 'combine',
      stats: { total: p.sections.length, dated: p.stats.dated, dateless: p.stats.dateless, docs: list.length },
      warnings: p.warnings,
      combine: true,
    };
  }

  // Per-document split, concatenated. A descending `now` cursor keeps each
  // document's dateless sections stacked below the previous document's, so the
  // combined list stays in a stable, non-overlapping newest-first order.
  const sections = [];
  const warnings = [];
  let cursor = now;
  for (const d of list) {
    const p = parseDocIntoNotes(d.text, { ...opts, now: cursor });
    for (const w of p.warnings) warnings.push(d.name ? `${d.name}: ${w}` : w);
    // Stamp the Drive file's real last-edit time onto every section from this
    // doc so re-import matching can tell whether the mind copy is newer.
    const mtime = Number(d.modifiedMs) || 0;
    for (const s of p.sections) { s.srcModified = mtime; sections.push(s); }
    if (p.sections.length) cursor = Math.min(...p.sections.map((s) => s.createdAt)) - GAP;
    else cursor -= GAP;
  }

  // Cross-document daily dedupe: the same calendar day appearing as a pure-date
  // header in two different docs must not mint two daily notes for one date
  // (`meta.daily` is meant to be unique) — the first claims it, the rest demote.
  const seenDaily = new Set();
  for (const s of sections) {
    if (!s.isDaily) continue;
    if (seenDaily.has(s.dateIso)) s.isDaily = false;
    else seenDaily.add(s.dateIso);
  }

  const dated = sections.filter((s) => s.dateIso).length;
  return {
    sections,
    mode: 'batch',
    stats: { total: sections.length, dated, dateless: sections.length - dated, docs: list.length },
    warnings,
    combine: false,
  };
}

// Cheap content fingerprint for duplicate detection on re-import.
export function fingerprintNote({ title = '', body = '' }) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  return `${norm(title)}\n${norm(body)}`;
}

// Filesystem-style identity: a note's "path" is its (folder, title). Re-importing
// the same document should refresh the note at that path, not spawn a twin.
const normTitle = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
const pathKey = (folderId, title) => `${folderId ?? ''} ${normTitle(title)}`;

// A section's "document time" for newer-than comparison: the source file's real
// last-edit time when known, else the date parsed from its header (noon).
function docTimeOf(s) {
  if (s.srcModified) return s.srcModified;
  return s.dateIso ? Date.parse(`${s.dateIso}T12:00:00`) : 0;
}

/**
 * Annotate sections in place with duplicate/upsert state:
 *  - `.upsertId` — update an existing note instead of inserting. Set on an `id`
 *    round-trip (mind's own export) and, when `opts.matchByTitle`, on a
 *    filesystem-style match: same daily date, else same title within the target
 *    folder (`opts.folderId`). `.dup.kind` is `'id' | 'content' | 'path'`.
 *  - `.skip` (pre-checked) — a byte-identical note already exists (no-op), or a
 *    path match whose existing note looks NEWER than the import (`.newerExists`,
 *    left unchecked so fresher local edits aren't silently overwritten).
 *  - `.dailyCollision` (isDaily cleared) — a *different* note already owns this
 *    daily date and we're not upserting it.
 *
 * @param {Array} sections
 * @param {Array} existingNotes
 * @param {{matchByTitle?:boolean, folderId?:string}} [opts]
 *   matchByTitle — enable path/daily upsert (default off → legacy behavior).
 *   folderId — the import's target folder id; `undefined` disables title matching
 *   (e.g. a brand-new folder that can't hold matches yet). Daily matching is
 *   folder-independent (a daily note is unique per calendar day).
 */
export function markDuplicates(sections, existingNotes, opts = {}) {
  const { matchByTitle = false, folderId } = opts;
  const live = (existingNotes || []).filter((n) => !n.deletedAt);
  const byId = new Map(live.map((n) => [n.id, n]));
  const byPrint = new Map();
  const dailyDates = new Set();
  const dailyByDate = new Map();
  const byPath = new Map();
  const newer = (a, b) => (a.updatedAt || 0) >= (b?.updatedAt || 0); // keep freshest on collision
  for (const n of live) {
    byPrint.set(fingerprintNote({ title: n.title, body: n.body }), n);
    if (n.meta?.daily) {
      dailyDates.add(n.meta.daily);
      if (newer(n, dailyByDate.get(n.meta.daily))) dailyByDate.set(n.meta.daily, n);
    }
    const pk = pathKey(n.folderId, n.title);
    if (newer(n, byPath.get(pk))) byPath.set(pk, n);
  }

  for (const s of sections) {
    s.upsertId = '';
    s.dup = null;
    s.skip = false;
    s.dailyCollision = false;
    s.newerExists = false;

    // 1. explicit id round-trip (mind's own export) → update in place.
    if (s.id && byId.has(s.id)) {
      s.upsertId = s.id;
      s.dup = { id: s.id, title: byId.get(s.id).title, kind: 'id' };
      continue;
    }
    // 2. byte-identical note already exists → skip (importing would be a no-op).
    const hit = byPrint.get(fingerprintNote(s));
    if (hit) {
      s.dup = { id: hit.id, title: hit.title, kind: 'content' };
      s.skip = true;
      continue;
    }
    // 3. filesystem identity (opt-in): refresh the note at this (folder, title),
    //    or the daily note for this date, rather than inserting a duplicate.
    if (matchByTitle) {
      let match = null;
      if (s.isDaily && s.dateIso) match = dailyByDate.get(s.dateIso) || null;
      if (!match && folderId !== undefined) match = byPath.get(pathKey(folderId, s.title)) || null;
      if (match) {
        s.upsertId = match.id;
        const docT = docTimeOf(s);
        s.newerExists = docT > 0 && (match.updatedAt || 0) > docT;
        s.dup = { id: match.id, title: match.title, kind: 'path', newer: s.newerExists };
        s.skip = s.newerExists; // update by default; if mind is newer, leave unchecked
        continue;
      }
    }
    // 4. no upsert target, but a different note already owns this daily date →
    //    demote to a plain dated note so it doesn't shadow the real daily.
    if (s.isDaily && dailyDates.has(s.dateIso)) {
      s.isDaily = false;
      s.dailyCollision = true;
    }
  }
}

/**
 * Snapshot, then create (or upsert) notes for the selected sections. Preserves
 * each section's parsed createdAt/updatedAt via putNoteRaw.
 *
 * @returns {Promise<{created:number, folderId:string, snapshotTs:number}>}
 */
export async function commitDocImport(sections, opts = {}) {
  const {
    folderId = '', newFolderName = '', parentId = '', tag = '', skipDuplicates = true,
  } = opts;

  const snapshotTs = await store.putSnapshot('pre-doc-import');

  let targetFolder = folderId;
  if (newFolderName) {
    const f = store.createFolder(newFolderName.trim(), parentId);
    await store.putFolder(f);
    targetFolder = f.id;
  }

  const extraTag = tag ? tag.replace(/^#/, '').trim().toLowerCase() : '';
  let created = 0;

  for (const s of sections) {
    if (skipDuplicates && s.skip) continue;

    const tags = [];
    for (const t of (Array.isArray(s.tags) ? s.tags : [])) {
      const tt = String(t).replace(/^#/, '').trim().toLowerCase();
      if (tt && !tags.includes(tt)) tags.push(tt);
    }
    if (extraTag && !tags.includes(extraTag)) tags.push(extraTag);
    const meta = s.isDaily && s.dateIso ? { daily: s.dateIso } : {};

    if (s.upsertId) {
      const existing = await store.getNote(s.upsertId);
      if (existing) {
        // When the source file's real edit time is known, make it authoritative
        // so a repeat import converges (note.updatedAt == doc time → not "newer"
        // next time); otherwise keep the newer-wins timestamp.
        const stamp = s.srcModified || Math.max(existing.updatedAt || 0, s.updatedAt);
        await store.putNoteRaw({
          ...existing,
          title: s.title,
          body: s.body,
          tags: tags.length ? tags : existing.tags,
          meta: { ...existing.meta, ...meta },
          updatedAt: stamp,
        });
        created++;
        continue;
      }
    }

    const note = store.createNote({
      title: s.title,
      autoTitle: false,
      body: s.body,
      folderId: targetFolder,
      tags,
      meta,
      createdAt: s.createdAt,
      updatedAt: s.srcModified || s.updatedAt,
    });
    await store.putNoteRaw(note);
    created++;
  }

  return { created, folderId: targetFolder, snapshotTs };
}
