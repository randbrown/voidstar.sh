// Phase pool — per-user filter for the auto-phase step rotation.
//
// Mirrors cycle-pool.js, but where the cycle pool is a single flat list of
// quales, phase steps are declared PER QUALE (QFXModule.autoPhase.steps), so
// exclusions are scoped by fx id: a map { fxId: [stepIndex, ...] }. Within a
// quale the same EXCLUDED-set semantics apply — ids (here, step indices) in
// the set are skipped by the auto-phase rotation.
//
// Empty set (default) ⇒ all steps phase. New steps appended to a quale's
// autoPhase.steps in a future update are auto-included since they're not in
// any existing user's excluded set. "deselect all" populates the set with
// every index; phaseNext falls back to "all included" when the set covers
// every step, so the phase button never goes silently dead.
//
// Identity is positional (step index). Appending steps is safe; reordering an
// existing quale's steps would drift stored exclusions, but that's rare and
// no worse than the cycle pool's "rename an id" edge.

const NS       = 'voidstar.qualia.phasePool';
const EXCL_KEY = `${NS}.excluded`;

/** @returns {Object<string, number[]>} raw fxId → excluded-index list map */
export function loadExcludedMap() {
  try {
    const raw = localStorage.getItem(EXCL_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch { return {}; }
}

/** @param {Object<string, number[]>} map */
export function saveExcludedMap(map) {
  try { localStorage.setItem(EXCL_KEY, JSON.stringify(map)); } catch {}
}

/**
 * Excluded step indices for one quale.
 * @param {string} fxId
 * @returns {Set<number>}
 */
export function loadExcludedFor(fxId) {
  const arr = loadExcludedMap()[fxId];
  return new Set(Array.isArray(arr) ? arr : []);
}

/**
 * Persist excluded indices for one quale. An empty set drops the key entirely
 * so the stored map stays lean (and matches the "fresh user" default).
 * @param {string} fxId
 * @param {Set<number>} set
 */
export function saveExcludedFor(fxId, set) {
  const map = loadExcludedMap();
  if (set.size === 0) delete map[fxId];
  else map[fxId] = [...set];
  saveExcludedMap(map);
}

/**
 * Should step `index` participate in the auto-phase right now? Mirrors
 * cycle-pool.isInCycle:
 * - excluded empty → yes (default)
 * - excluded covers every step → yes (fallback so phase never goes dead)
 * - otherwise → not in excluded
 *
 * @param {Set<number>} excluded
 * @param {number} index
 * @param {number} total  number of declared steps
 */
export function isStepInPhase(excluded, index, total) {
  if (excluded.size === 0) return true;
  if (excluded.size >= total) return true;
  return !excluded.has(index);
}

/**
 * The indices of `steps` that are currently in the phase rotation. Never
 * empty: if the user somehow excluded everything, falls back to all indices
 * (the same "treat as all-in" safety isStepInPhase encodes).
 *
 * @param {Array} steps
 * @param {Set<number>} excluded
 * @returns {number[]}
 */
export function includedStepIndices(steps, excluded) {
  const total = steps.length;
  const out = [];
  for (let i = 0; i < total; i++) {
    if (isStepInPhase(excluded, i, total)) out.push(i);
  }
  return out.length ? out : steps.map((_, i) => i);
}

/**
 * Human-readable label for a phase step, derived from its partial param dict
 * (steps carry no explicit name). `{ mode: 'radial' }` → "radial"; multi-key
 * steps join as "key value, key value".
 *
 * @param {Object<string, number|string|boolean>} step
 */
export function stepLabel(step) {
  const entries = Object.entries(step || {});
  if (entries.length === 0) return '(no params)';
  if (entries.length === 1) return String(entries[0][1]);
  return entries.map(([k, v]) => `${k} ${v}`).join(', ');
}
