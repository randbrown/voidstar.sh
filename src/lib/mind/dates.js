// Loose date parsing for document import — ported from
// setlist/import.js (extractDate/toIso/MONTHS). mind forks setlist rather than
// sharing modules, so this is a faithful copy kept local to the mind app.
//
// Handles the shapes that show up in journal section headers: 2026-06-14,
// 6/14, 6/14/26, 6-14-2026, "June 14", "Jun 14 2026".

export const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad2(n) { return String(n).padStart(2, '0'); }

export function toIso(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

// Musical time-signature denominators (note values are powers of two). A bare
// "N/D" with such a denominator and a small numerator reads as a time signature
// (4/4, 6/8, 12/8, 7/8, 2/2…), NOT a date — so document import can be told to
// skip them. Only slash-form, year-less tokens are ambiguous: an explicit year
// or a dash separator is always a date.
const TS_DENOMS = new Set([1, 2, 4, 8, 16, 32]);
export function looksLikeTimeSignature(n, d) {
  return TS_DENOMS.has(d) && n >= 1 && n <= 32;
}

// Find a date anywhere in the line. Returns {iso, index, length, hasYear} or
// null. A missing year assumes `nowYear` (and is flagged `hasYear: false`, so
// callers that can do better — see import-doc.js `inferSectionYears` — know the
// year is a guess); two-digit years assume 20xx.
//
// Numeric shapes accepted: 2026-06-14 (ISO), and M/D · M.D · M-D with an
// optional /·.·- year (6/14, 6-14, 6/14/26, 6-14-2026, 6.14.26). `opts`:
//   rejectTimeSignatures — skip a bare slash "N/D" that looks like a musical
//   time signature (used by the document importer so a 4/4 in a chord chart
//   never mints a spurious date). Dashes and year-bearing tokens are unaffected.
export function extractDate(str, nowYear = new Date().getFullYear(), opts = {}) {
  const { rejectTimeSignatures = false } = opts;
  let m = str.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const iso = toIso(+m[1], +m[2], +m[3]);
    if (iso) return { iso, index: m.index, length: m[0].length, hasYear: true };
  }
  // Scan every numeric M/D(/Y) or M-D(-Y) token so a leading time signature
  // ("4/4 …") can be skipped without hiding a real date later in the line. The
  // \2 backreference keeps the separator consistent across the token.
  const NUM_RE = /\b(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{2,4}))?\b/g;
  let nm;
  while ((nm = NUM_RE.exec(str))) {
    const [, mo, sep, day, yr] = nm;
    const hasYear = yr != null;
    if (rejectTimeSignatures && !hasYear && sep === '/' && looksLikeTimeSignature(+mo, +day)) continue;
    const y = yr ? (yr.length === 2 ? 2000 + +yr : +yr) : nowYear;
    const iso = toIso(y, +mo, +day);
    if (iso) return { iso, index: nm.index, length: nm[0].length, hasYear };
  }
  m = str.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i);
  if (m) {
    const iso = toIso(m[3] ? +m[3] : nowYear, MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
    if (iso) return { iso, index: m.index, length: m[0].length, hasYear: !!m[3] };
  }
  return null;
}

// ── Reminder "when" parsing ───────────────────────────────────────────────
// parseWhen(str, now) finds a time expression anywhere in `str` and resolves
// it to an absolute epoch-ms timestamp. Returns { ts, index, length } (the
// matched span, so callers can strip it) or null. `now` is injectable so tests
// stay deterministic.
//
// Grammar (pragmatic, dependency-free):
//   - durations:    "in 2 hours", "in 30 min", "in 3 days", "in 1 week"
//   - relative day: "today", "tonight" (→18:00), "tomorrow"/"tmrw",
//                   "next monday" / bare weekday (→ upcoming that weekday)
//   - explicit date: anything extractDate() handles (2026-06-14, 6/14, Jun 14…)
//   - time of day:  "5pm", "6:30am", "at 6:30", "after 5pm", "by 9"
// A time with no day defaults to today, rolling to tomorrow if it already
// passed. A day with no time defaults to 9am (tonight → 18:00). A bare hour
// with no am/pm in 1–6 is read as pm ("remind me at 6" → 18:00).

const WEEKDAYS3 = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Quoted text is LITERAL — never a "when".
//
// A captured line often *talks about* a day rather than scheduling one:
//   "today" note pulls up last year's "7/30" note
// Reading the quoted words as a reminder armed a 9am alarm AND deleted them
// from the task text (parseCapture strips the matched span), so the task read
// `"" note pulls up last year's "" note`. Everything between paired double
// quotes (straight or smart) or backticks is therefore blanked before the
// matchers run — replaced space-for-space, so every index/length they report
// still lines up with the ORIGINAL string and the caller's slice stays exact.
// Apostrophes are deliberately not delimiters: "last year's" would open a span
// that never closes and swallow the rest of the line.
const QUOTE_PAIRS = [['"', '"'], ['“', '”'], ['`', '`']];

export function maskQuoted(str) {
  const s = String(str ?? '');
  const closers = new Map(QUOTE_PAIRS);
  const out = s.split('');
  let i = 0;
  while (i < out.length) {
    const close = closers.get(s[i]);
    if (close) {
      const end = s.indexOf(close, i + 1);
      // An unmatched opener is just punctuation — masking to end-of-line would
      // silently kill a real "tomorrow 9am" after a stray quote.
      if (end > i) {
        for (let k = i + 1; k < end; k++) out[k] = ' ';
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

function startOfDayMs(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function disambiguateHour(h) {
  // No am/pm given: read an early hour as afternoon/evening (the common intent
  // for a reminder), leave the rest as written (24h-ish).
  return h >= 1 && h <= 6 ? h + 12 : h;
}

function matchDuration(str, now) {
  const m = str.match(/\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i);
  if (!m) return null;
  const n = +m[1];
  const u = m[2].toLowerCase();
  let ms = 0;
  if (u.startsWith('min')) ms = n * 60_000;
  else if (u.startsWith('h')) ms = n * 3_600_000;
  else if (u.startsWith('day')) ms = n * 86_400_000;
  else if (u.startsWith('week')) ms = n * 7 * 86_400_000;
  return { ts: now + ms, index: m.index, length: m[0].length };
}

// → { startMs, defaultHour, index, length } | null
function matchDay(str, now) {
  const today0 = startOfDayMs(now);
  let m;
  if ((m = str.match(/\btonight\b/i))) return { startMs: today0, defaultHour: 18, index: m.index, length: m[0].length };
  if ((m = str.match(/\btoday\b/i))) return { startMs: today0, defaultHour: 9, index: m.index, length: m[0].length };
  if ((m = str.match(/\b(?:tomorrow|tmrw|tmw)\b/i))) return { startMs: today0 + 86_400_000, defaultHour: 9, index: m.index, length: m[0].length };
  if ((m = str.match(/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thur?s?|fri|sat)\b/i))) {
    const target = WEEKDAYS3[m[1].slice(0, 3).toLowerCase()];
    const cur = new Date(now).getDay();
    let delta = (target - cur + 7) % 7;
    if (delta === 0) delta = 7; // a bare weekday name means the *upcoming* one
    return { startMs: today0 + delta * 86_400_000, defaultHour: 9, index: m.index, length: m[0].length };
  }
  const ed = extractDate(str, new Date(now).getFullYear());
  if (ed) {
    const [y, mo, d] = ed.iso.split('-').map(Number);
    return { startMs: new Date(y, mo - 1, d).getTime(), defaultHour: 9, index: ed.index, length: ed.length };
  }
  return null;
}

// → { h, m, index, length } | null
function matchTime(str) {
  let m;
  // H[:MM] am/pm  (meridiem is authoritative — no disambiguation)
  if ((m = str.match(/\b(?:at|by|after|around|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i))) {
    let h = +m[1] % 12;
    if (/p/i.test(m[3])) h += 12;
    return { h, m: m[2] ? +m[2] : 0, index: m.index, length: m[0].length };
  }
  // at/by HH:MM  (no meridiem)
  if ((m = str.match(/\b(?:at|by|after|around|@)\s+(\d{1,2}):(\d{2})\b/i))) {
    return { h: disambiguateHour(+m[1]), m: +m[2], index: m.index, length: m[0].length };
  }
  // at/by H  (bare hour)
  if ((m = str.match(/\b(?:at|by|around|@)\s+(\d{1,2})\b/i))) {
    return { h: disambiguateHour(+m[1]), m: 0, index: m.index, length: m[0].length };
  }
  return null;
}

export function parseWhen(str, now = Date.now()) {
  if (!str) return null;
  // Match against the quote-masked copy (same length, so indices map 1:1 back
  // onto `str`) — a day/time named inside quotes is being quoted, not scheduled.
  const src = maskQuoted(str);

  // A self-contained duration wins outright.
  const dur = matchDuration(src, now);
  if (dur) return { ts: dur.ts, index: dur.index, length: dur.length };

  const day = matchDay(src, now);
  const time = matchTime(src);
  if (!day && !time) return null;

  let spanStart = Infinity, spanEnd = -1;
  const consume = (idx, len) => { spanStart = Math.min(spanStart, idx); spanEnd = Math.max(spanEnd, idx + len); };

  const base = day ? day.startMs : startOfDayMs(now);
  if (day) consume(day.index, day.length);

  let hour, minute;
  if (time) { consume(time.index, time.length); hour = time.h; minute = time.m; }
  else { hour = day.defaultHour; minute = 0; }

  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  let ts = d.getTime();
  // A time-only expression that already passed today rolls to tomorrow.
  if (!day && ts <= now) ts += 86_400_000;

  return { ts, index: spanStart, length: spanEnd - spanStart };
}
