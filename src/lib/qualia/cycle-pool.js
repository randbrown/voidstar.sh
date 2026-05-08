// Cycle pool — per-user filter for the auto-cycle quale rotation.
//
// Stored as an EXCLUDED set: ids in the set are skipped by the cycle.
// Empty set (default for fresh users) ⇒ all quales cycle. New quales
// shipped in future updates are auto-included since they're not in any
// existing user's excluded set. The "deselect all" UX action populates
// the set with every known id; cycleNext.js falls back to "all included"
// when the set covers every registered quale, so the cycle button never
// goes silently dead.
//
// Active-quale semantics: excluding the currently-active quale does NOT
// auto-switch — the user keeps it on screen until the dwell clock fires
// the next cycleNext, which then picks an included quale. This matches
// the "phase" semantics where toggling autoPhase doesn't immediately
// reset the active mode.

const NS       = 'voidstar.qualia.cyclePool';
const EXCL_KEY = `${NS}.excluded`;

/** @returns {Set<string>} */
export function loadExcluded() {
  try {
    const raw = localStorage.getItem(EXCL_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

/** @param {Set<string>} set */
export function saveExcluded(set) {
  try { localStorage.setItem(EXCL_KEY, JSON.stringify([...set])); } catch {}
}

/**
 * Should `id` participate in the auto-cycle right now?
 * - if `excluded` is empty → yes (default)
 * - if `excluded` covers every registered id → yes (fallback so the cycle
 *   button never goes dead — user excluded everything, treat as "all in")
 * - otherwise → not in excluded
 *
 * @param {Set<string>} excluded
 * @param {string} id
 * @param {number} totalIds  number of registered quales
 */
export function isInCycle(excluded, id, totalIds) {
  if (excluded.size === 0) return true;
  if (excluded.size >= totalIds) return true;
  return !excluded.has(id);
}
