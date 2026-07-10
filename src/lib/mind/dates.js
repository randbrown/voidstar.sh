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

// Find a date anywhere in the line. Returns {iso, index, length} or null.
// A missing year assumes the current year; two-digit years assume 20xx.
export function extractDate(str, nowYear = new Date().getFullYear()) {
  let m = str.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const iso = toIso(+m[1], +m[2], +m[3]);
    if (iso) return { iso, index: m.index, length: m[0].length };
  }
  m = str.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/) ||
      str.match(/\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : nowYear;
    const iso = toIso(y, +m[1], +m[2]);
    if (iso) return { iso, index: m.index, length: m[0].length };
  }
  m = str.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i);
  if (m) {
    const iso = toIso(m[3] ? +m[3] : nowYear, MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
    if (iso) return { iso, index: m.index, length: m[0].length };
  }
  return null;
}
