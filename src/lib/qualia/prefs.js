// prefs.js — tiny localStorage helpers.
//
// Every subsystem (looper, sequencer, patterns, …) hand-rolled the same
// try/catch get/set + parse/clamp boilerplate. This is the one place for it.
// All getters swallow storage errors (Safari private mode, quota, disabled
// storage) and return the supplied default; all setters are best-effort no-ops
// on failure. Behavior is preserved 1:1 with the old inline idioms.

/** Raw string get. Returns `fallback` if missing or storage is unavailable. */
export function getRaw(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; }
  catch { return fallback; }
}

/** Best-effort string set (stringifies non-strings, like the old `String(v)`). */
export function setRaw(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

// Booleans are stored as '1' / '0'. Writes are always one of those, so reading
// `v !== '0'` matches both the old `!== '0'` (default-true) and `=== '1'`
// (default-false) idioms — the `dflt` arg covers the missing-value case.
export function getBool(key, dflt = false) {
  try { const v = localStorage.getItem(key); return v == null ? dflt : v !== '0'; }
  catch { return dflt; }
}
export function setBool(key, on) { setRaw(key, on ? '1' : '0'); }

/** Number with optional clamp. Returns `dflt` on missing / NaN / error. */
export function getNum(key, dflt, min = -Infinity, max = Infinity) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return dflt;
    const v = parseFloat(raw);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : dflt;
  } catch { return dflt; }
}

/** Parse a JSON value. Returns `dflt` on missing / parse error / storage error. */
export function getJSON(key, dflt = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return dflt;
    return JSON.parse(raw);
  } catch { return dflt; }
}

/** Best-effort JSON set. */
export function setJSON(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
}

/** Clamp any value to [0,1] (NaN → 0). The repo's most-duplicated one-liner. */
export const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
