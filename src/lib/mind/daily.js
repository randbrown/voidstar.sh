// Daily notes — one note per calendar day, keyed `meta.daily = 'YYYY-MM-DD'`.
//
// Pure (no store, no DOM) so it's node-testable from
// scripts/check-mind-daily.mjs; the action that opens/creates the note lives in
// views/home.js.
//
// Why picking today's note needs a rule at all: document import can MINT daily
// notes, and a journal header is usually just "7/30" — no year. The importer
// now infers the year from the document's own timeline (import-doc.js
// `inferSectionYears`), but inference is still inference, and notes imported
// before that fix took the import's year outright. Either way a 2025 entry can
// end up claiming this year's daily key, which is exactly how the "today"
// button opened last year's note. So: a note whose daily year we GUESSED never
// silently stands in for today — the caller asks first, once, and the answer
// sticks (`dailyConfirmed`, or the daily key is dropped).

// 'YYYY-MM-DD' in LOCAL time (the calendar day the user is living in).
export function dailyKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The app's own daily-note title, e.g. "2026-07-30 daily".
export const dailyTitle = (key) => `${key} daily`;

// True when this note's daily date came from an import that had to guess the
// year. Explicit for notes imported since the fix (`meta.dailyGuessedYear`);
// for older ones the fingerprint is an imported note whose title carries no
// 4-digit year at all — i.e. a bare "7/30" header, the year-less shape. A note
// the user has already vouched for (`dailyConfirmed`) is never suspect again.
export function dailyYearIsGuess(note) {
  const meta = note?.meta || {};
  if (!meta.daily) return false;
  if (meta.dailyConfirmed) return false;
  if (meta.dailyGuessedYear) return true;
  return !!meta.importedAt && !/\d{4}/.test(note.title || '');
}

// Choose the note that IS the given day's daily note.
//   → { note }     — trustworthy match, open it
//   → { guessed }  — only an import-with-a-guessed-year claims this day; ask
//   → {}           — nothing claims it, create one
// Newest-updated wins within each group so two devices land on the same note.
export function pickDailyNote(notes, key) {
  const byNewest = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const claims = (notes || [])
    .filter((n) => n && !n.deletedAt && n.meta?.daily === key)
    .sort(byNewest);
  const note = claims.find((n) => !dailyYearIsGuess(n));
  if (note) return { note };
  const guessed = claims[0];
  return guessed ? { guessed } : {};
}

// The two answers to that question, as record patches (pure — the caller
// writes them). Confirming pins the note as this day's daily for good;
// demoting drops only the daily claim, leaving the note itself untouched.
export function confirmDaily(note) {
  return { ...note, meta: { ...(note.meta || {}), dailyConfirmed: true } };
}

export function demoteDaily(note) {
  const meta = { ...(note.meta || {}) };
  delete meta.daily;
  delete meta.dailyGuessedYear;
  delete meta.dailyConfirmed;
  return { ...note, meta };
}
