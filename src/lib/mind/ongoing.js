// Ongoing notes — pure core (no DOM, no IndexedDB), tested by
// scripts/check-mind-ongoing.mjs.
//
// An "ongoing" note is a long-running note you keep adding entries to (lyric
// ideas, a quotes log). Membership is the #ongoing tag — the same convention
// as #template, so marking/unmarking is just tag editing and the list rides
// sync like any tag. Per-note capture preferences (insert at top vs end,
// optional date stamp) live in `meta.ongoing` — `meta` is a NOTE_FILL_FIELDS
// member, so a stale device can't blank them in a merge.
//
// The store-coupled actions (list / add entry / file-note-into) live in
// ongoing-actions.js.

export const ONGOING_TAG = 'ongoing';

export function isOngoing(note) {
  return !!note && !note.deletedAt && (note.tags || []).includes(ONGOING_TAG);
}

// Normalized per-note capture prefs with defaults: insert at top, no stamp.
export function ongoingPrefs(note) {
  const p = note?.meta?.ongoing || {};
  return {
    position: p.position === 'bottom' ? 'bottom' : 'top',
    stamp: !!p.stamp,
  };
}

// "2026-07-17" — day granularity; the quotes-log use case is "who said it,
// which day", not which minute.
export function dateStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Turn captured text into an entry: trim outer blank lines, optionally prefix
// a bold date stamp — inline for a one-liner ("**2026-07-17** — quote"), on
// its own line above a multi-line entry so verses stay intact.
export function composeEntry(text, { stamp = false, ts = Date.now() } = {}) {
  const t = String(text || '').replace(/^\s*\n+/, '').replace(/\s+$/, '');
  if (!t) return '';
  if (!stamp) return t;
  const d = `**${dateStamp(ts)}**`;
  return t.includes('\n') ? `${d}\n${t}` : `${d} — ${t}`;
}

// Insert an entry into a markdown body at top or bottom, separated by one
// blank line. Never destroys existing content; an empty body just becomes
// the entry.
export function insertIntoBody(body, entry, position = 'top') {
  const b = String(body || '');
  if (!entry) return b;
  if (!b.trim()) return `${entry}\n`;
  if (position === 'bottom') return `${b.replace(/\s+$/, '')}\n\n${entry}\n`;
  return `${entry}\n\n${b.replace(/^\s*\n+/, '')}`;
}

// The text a note contributes when it is filed into another note: its body,
// with a hand-set title kept as the first line (an auto timestamp title is
// dropped — it carries no content). Empty result = nothing to merge.
export function mergeText(note) {
  const body = String(note?.body || '').replace(/^\s*\n+/, '').replace(/\s+$/, '');
  const title = note?.autoTitle ? '' : String(note?.title || '').trim();
  if (title && body) return `${title}\n${body}`;
  return body || title;
}
