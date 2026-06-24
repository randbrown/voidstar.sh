// Curated Strudel function reference for the editor's "funcs" tab.
//
// The data is a hand-maintained JSON subset (the ~100 most-used functions,
// operators, and signals) rather than Strudel's full generated doc.json — we
// own the wording, examples, and the exact click-to-insert token, and stay
// decoupled from the CDN bundle's internals. Strudel's *own* autocomplete +
// hover docs (toggled in strudel-hydra.js) still cover the complete API live;
// this panel is the browseable, searchable companion.

import functions from '../../data/strudel-functions.json';

/** Category display order in the panel. Unknown categories sort after these. */
export const CATEGORY_ORDER = [
  'sources',
  'mini-notation',
  'time',
  'transforms',
  'randomness',
  'pitch',
  'effects',
  'envelope',
  'samples',
  'signals',
  'tempo',
  'control',
];

export const STRUDEL_FUNCTIONS = functions;

/**
 * Loose substring match across name / doc / signature / category.
 * Returns the entries in source order (the renderer regroups by category).
 */
export function filterFunctions(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return STRUDEL_FUNCTIONS;
  return STRUDEL_FUNCTIONS.filter((f) =>
    f.name.toLowerCase().includes(q) ||
    (f.doc && f.doc.toLowerCase().includes(q)) ||
    (f.signature && f.signature.toLowerCase().includes(q)) ||
    (f.category && f.category.toLowerCase().includes(q)),
  );
}

/**
 * Group a flat list into ordered [category, entries[]] pairs.
 * @param {Array} list
 * @param {string[]} [order]
 * @returns {Array<[string, Array]>}
 */
export function groupByCategory(list, order = CATEGORY_ORDER) {
  const buckets = new Map();
  for (const f of list) {
    const c = f.category || 'other';
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c).push(f);
  }
  const out = [];
  for (const c of order) {
    if (buckets.has(c)) {
      out.push([c, buckets.get(c)]);
      buckets.delete(c);
    }
  }
  // Any leftover categories not in the order list, alphabetical.
  for (const c of [...buckets.keys()].sort()) out.push([c, buckets.get(c)]);
  return out;
}
