// Tag helpers — pure core (no DOM, no IndexedDB), tested by
// scripts/check-mind-tags.mjs.
//
// Two jobs:
//   1. normalizeTag — ONE definition of what a tag string becomes, so a tag
//      typed into the editor, tapped from a suggestion chip, or carried in by
//      an import all collapse to the same key (they used to be normalized
//      inline in views/editor.js only).
//   2. rankTags — "your common tags", for the one-click chips. Frequency alone
//      ossifies: a tag used 40 times three years ago would outrank the one
//      you've used all week. So a use inside the recency window counts extra,
//      which lets the working set float to the front without erasing history.

export const TAG_SUGGEST_LIMIT = 8;
const RECENT_MS = 45 * 86_400_000;   // "lately" — a use this recent counts double
const RECENT_BONUS = 1;

// "#Big Idea " → "big-idea". Collapses whitespace runs to a single hyphen and
// strips characters that would break a `#tag` chip or a search token.
export function normalizeTag(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._/-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

// Every tag in use, with its score. Returns [{ tag, uses, recentUses, score }]
// hottest first; ties break alphabetically so two devices agree on the order.
export function tagStats(notes, { now = Date.now() } = {}) {
  const by = new Map();
  for (const n of notes || []) {
    if (!n || n.deletedAt) continue;
    const recent = (n.updatedAt || n.createdAt || 0) >= now - RECENT_MS;
    // A note listing the same tag twice (an import artifact) still counts once.
    for (const t of new Set((n.tags || []).map(normalizeTag).filter(Boolean))) {
      const s = by.get(t) || { tag: t, uses: 0, recentUses: 0, score: 0 };
      s.uses++;
      if (recent) s.recentUses++;
      by.set(t, s);
    }
  }
  const out = [...by.values()];
  for (const s of out) s.score = s.uses + RECENT_BONUS * s.recentUses;
  out.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  return out;
}

// The tags to offer as one-click chips: hottest first, minus the ones already
// on this note (`exclude`), capped at `limit`.
export function rankTags(notes, { now = Date.now(), limit = TAG_SUGGEST_LIMIT, exclude = [] } = {}) {
  const skip = new Set((exclude || []).map(normalizeTag));
  return tagStats(notes, { now })
    .filter(s => !skip.has(s.tag))
    .slice(0, Math.max(0, limit))
    .map(s => s.tag);
}
