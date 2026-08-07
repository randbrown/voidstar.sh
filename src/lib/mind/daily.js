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
// silently stands in for today — when the note's own last-edit time disproves
// the claim outright it is released without a question (`dailyClaimRefuted`),
// and otherwise the caller asks first, once, and the answer sticks
// (`dailyConfirmed`, or the daily key is dropped).

// 'YYYY-MM-DD' in LOCAL time (the calendar day the user is living in).
export function dailyKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The app's own daily-note title, e.g. "2026-07-30 daily".
export const dailyTitle = (key) => `${key} daily`;

// True when we can't tell that this note's daily date names the right YEAR.
//
// The test is the note's own title: does it contain the year it claims? That
// holds for everything the app writes ("2026-07-30 daily") and for any import
// whose header spelled a year out ("7/30/2026", "2026-07-30"), and fails for
// exactly the shape that caused the bug — a bare "7/30" header, where the year
// is the importer's assumption and nothing else.
//
// It deliberately does NOT key on import provenance. The first version of this
// check required `meta.importedAt`, which the importer only started stamping on
// 2026-07-15 — every journal imported before that carried a daily claim with no
// provenance at all, sailed through as trustworthy, and kept opening last
// year's note. Asking the title is a property of the record itself, so it works
// on data written by any version.
//
// Cost of a false positive: one question, once, on a note the user has renamed
// away from its date — answered with "open it", which pins it
// (`dailyConfirmed`) and never asks again.
export function dailyYearIsGuess(note) {
  const meta = note?.meta || {};
  const key = meta.daily;
  if (!key) return false;
  if (meta.dailyConfirmed) return false;
  if (meta.dailyGuessedYear) return true;
  return !String(note?.title || '').includes(String(key).slice(0, 4));
}

// Start of the claimed calendar day in LOCAL time (the key is a local day).
function dayStartMs(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

// A guessed claim the record itself disproves: the note was last edited BEFORE
// the claimed day even began, so nothing in it can be about that day. This is
// the "8/7" case — a journal imported from a doc last touched Aug 2025 whose
// year-less header got stamped with this year's daily key. The wrong year used
// to cost the user a question; the note's own updatedAt already answers it.
//
// updatedAt is the one timestamp that's always real wall-clock time (an edit,
// an import, a Drive file's modifiedTime) — createdAt is deliberately ignored
// because import anchors it to the parsed section date, i.e. to the very year
// guess under suspicion. Only GUESSED claims are ever refuted this way; a
// vouched or confirmed note is trusted outright. (Callers only ever ask about
// today's key — a claim on a future day would trivially "refute", but the app
// never mints one.)
export function dailyClaimRefuted(note) {
  const key = note?.meta?.daily;
  if (!key || !dailyYearIsGuess(note)) return false;
  const edited = note.updatedAt || 0;
  return edited > 0 && edited < dayStartMs(key);
}

// Every daily claim this device can't vouch for, newest first — the corpus
// behind "release imported daily claims" in Settings → data. A year-long
// journal import can leave hundreds of these, and answering the question one
// colliding day at a time is a slow way to clean that up.
export function guessedDailyNotes(notes) {
  return (notes || [])
    .filter((n) => n && !n.deletedAt && dailyYearIsGuess(n))
    .sort((a, b) => String(a.meta.daily).localeCompare(String(b.meta.daily)));
}

// Choose the note that IS the given day's daily note.
//   → { note }        — trustworthy match, open it
//   → { guessed }     — an import-with-a-guessed-year plausibly claims it; ask
//   → { refuted: [] } — claims disproved by their own timestamps (edited before
//                       the day began); the caller releases them silently and
//                       treats the day as unclaimed
//   → {}              — nothing claims it, create one
// `guessed` and `refuted` can coexist; `note` wins outright (no writes needed —
// the trustworthy match is found first on every future pick too).
// Newest-updated wins within each group so two devices land on the same note.
export function pickDailyNote(notes, key) {
  const byNewest = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const claims = (notes || [])
    .filter((n) => n && !n.deletedAt && n.meta?.daily === key)
    .sort(byNewest);
  const note = claims.find((n) => !dailyYearIsGuess(n));
  if (note) return { note };
  const refuted = claims.filter((n) => dailyClaimRefuted(n));
  const guessed = claims.find((n) => !refuted.includes(n));
  const out = {};
  if (guessed) out.guessed = guessed;
  if (refuted.length) out.refuted = refuted;
  return out;
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
