// Horizon — pure core (no DOM, no IndexedDB), tested by
// scripts/check-mind-horizon.mjs.
//
// A horizon is the long-arc counterpart to a task reminder. A task asks "do
// this"; a horizon asks "was I right?" — you plant a question, a prediction or
// an idea today and say roughly when you want it handed back: three months,
// two years, someday. Nothing is due, nothing nags, nothing fires a
// notification. When the date arrives the note surfaces as RIPE on the horizon
// page and as a count on the home header; you read it, and either settle it
// (it moves to the settled arc, which is the record of what you thought and
// when) or push it further out.
//
// Storage is `note.meta.horizon` — `meta` is a NOTE_FILL_FIELDS member, so a
// stale device can never blank a horizon in a sync merge, and the whole thing
// rides Drive sync with no new store, shard or schema surface. Deliberately
// NOT a tag: the date is the point (a tag can't sort an arc), and membership
// that lives in two places drifts. A plain `#tag` is still the right tool for
// "file this with the others" — horizon is for "hand this back to me later".

export const HORIZON_KINDS = [
  { key: 'question', glyph: '?', label: 'question', hint: 'something you wondered about' },
  { key: 'prediction', glyph: '◈', label: 'prediction', hint: 'a call you want to check' },
  { key: 'idea', glyph: '✦', label: 'idea', hint: 'a seed to come back to' },
];

export const DEFAULT_KIND = 'question';

// Offered spans. `months: 0` is "someday" — planted with no date, so it never
// ripens and only ever shows up when you go looking.
export const HORIZON_SPANS = [
  { key: '3m', label: '3 months', months: 3 },
  { key: '6m', label: '6 months', months: 6 },
  { key: '1y', label: '1 year', months: 12 },
  { key: '2y', label: '2 years', months: 24 },
  { key: '5y', label: '5 years', months: 60 },
  { key: 'someday', label: 'someday', months: 0 },
];

export function kindOf(key) {
  return HORIZON_KINDS.find(k => k.key === key) || HORIZON_KINDS.find(k => k.key === DEFAULT_KIND);
}

// Calendar-month arithmetic with day clamping: Jan 31 + 1 month is Feb 28/29,
// not Mar 3 (which a naive setMonth gives you).
export function addMonths(ts, months) {
  const d = new Date(ts);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.getTime();
}

// Normalized horizon for a note, or null. Tolerates junk from an old build or
// a hand-edited export — a horizon with no usable shape reads as "not planted".
export function horizonOf(note) {
  const h = note?.meta?.horizon;
  if (!h || typeof h !== 'object') return null;
  const at = Number(h.at) || 0;
  const plantedAt = Number(h.plantedAt) || note?.createdAt || 0;
  const settledAt = Number(h.settledAt) || 0;
  if (!at && !plantedAt) return null;
  return { at, kind: kindOf(h.kind).key, plantedAt, settledAt };
}

export function isPlanted(note) {
  return !!note && !note.deletedAt && !!horizonOf(note);
}

// Ripe = dated, that date has arrived, and it hasn't been settled yet. A
// "someday" horizon (at === 0) is never ripe — that's the whole point of it.
export function isRipe(h, now = Date.now()) {
  return !!h && !h.settledAt && !!h.at && h.at <= now;
}

export function isSomeday(h) {
  return !!h && !h.at;
}

// ── meta builders ────────────────────────────────────────────────────────
// Each returns a NEW `meta` object for `store.putNote`-style patching; none
// mutate the note. `clearHorizonMeta` also reports whether the result is empty,
// because an empty `meta` is a blank fill-field — the caller must pair that
// with store.markCleared(note, 'meta') or the sync merge refills the horizon
// from an older copy and the note un-clears itself.

export function plantMeta(note, { kind = DEFAULT_KIND, at = 0, now = Date.now() } = {}) {
  const prev = horizonOf(note);
  return {
    ...(note?.meta || {}),
    horizon: {
      at: Number(at) || 0,
      kind: kindOf(kind).key,
      plantedAt: prev?.plantedAt || now,
      settledAt: 0,      // re-planting a settled note re-opens it
    },
  };
}

export function settleMeta(note, now = Date.now()) {
  const h = horizonOf(note);
  if (!h) return note?.meta || {};
  return { ...(note?.meta || {}), horizon: { ...h, settledAt: now } };
}

// Push a horizon further out. Measured from today when it's already ripe (a
// "+1 year" on something overdue should mean a year from now, not a year from
// a date that has passed) and from the existing date otherwise.
export function pushOutMeta(note, months, now = Date.now()) {
  const h = horizonOf(note);
  if (!h) return note?.meta || {};
  const base = h.at && h.at > now ? h.at : now;
  return { ...(note?.meta || {}), horizon: { ...h, at: addMonths(base, months), settledAt: 0 } };
}

export function clearHorizonMeta(note) {
  const meta = { ...(note?.meta || {}) };
  delete meta.horizon;
  return { meta, empty: Object.keys(meta).length === 0 };
}

// ── grouping + labels ────────────────────────────────────────────────────

// Split planted notes into the four bands the horizon view renders.
// Entries are { note, horizon }. Ripe comes oldest-first (the thing you've
// been sitting on longest is the thing to read first); growing comes
// soonest-first; someday and settled come most-recent-first.
export function groupHorizon(notes, now = Date.now()) {
  const out = { ripe: [], growing: [], someday: [], settled: [] };
  for (const note of notes || []) {
    if (!note || note.deletedAt) continue;
    const horizon = horizonOf(note);
    if (!horizon) continue;
    const entry = { note, horizon };
    if (horizon.settledAt) out.settled.push(entry);
    else if (isSomeday(horizon)) out.someday.push(entry);
    else if (horizon.at <= now) out.ripe.push(entry);
    else out.growing.push(entry);
  }
  const byId = (a, b) => a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0;
  out.ripe.sort((a, b) => a.horizon.at - b.horizon.at || byId(a, b));
  out.growing.sort((a, b) => a.horizon.at - b.horizon.at || byId(a, b));
  out.someday.sort((a, b) => b.horizon.plantedAt - a.horizon.plantedAt || byId(a, b));
  out.settled.sort((a, b) => b.horizon.settledAt - a.horizon.settledAt || byId(a, b));
  return out;
}

// [{ year, entries }] — the "growing" band broken into calendar years, so a
// five-year arc reads as an arc instead of one long list.
export function byYear(entries) {
  const years = new Map();
  for (const e of entries || []) {
    const y = new Date(e.horizon.at).getFullYear();
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(e);
  }
  return [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, es]) => ({ year, entries: es }));
}

export function horizonCounts(notes, now = Date.now()) {
  const g = groupHorizon(notes, now);
  return {
    ripe: g.ripe.length,
    growing: g.growing.length,
    someday: g.someday.length,
    settled: g.settled.length,
    open: g.ripe.length + g.growing.length + g.someday.length,
  };
}

// "2027-03-20" — same shape as every other stamp in the app, and sortable.
export function horizonDate(at) {
  if (!at) return 'someday';
  const d = new Date(at);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// Coarse relative distance — "in 3 months", "2 years ago". Coarse on purpose:
// on a multi-year arc, "in 428 days" is noise.
export function horizonLabel(h, now = Date.now()) {
  if (!h) return '';
  if (isSomeday(h)) return 'someday';
  const ms = h.at - now;
  const past = ms < 0;
  const days = Math.max(0, Math.round(Math.abs(ms) / 86_400_000));
  let n, unit;
  if (days < 1) return past ? 'ripe today' : 'today';
  if (days < 45) { n = days; unit = 'day'; }
  else if (days < 730) { n = Math.round(days / 30.44); unit = 'month'; }
  else { n = Math.round(days / 365.25); unit = 'year'; }
  const span = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return past ? `ripe ${span} ago` : `in ${span}`;
}
