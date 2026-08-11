// Microtonal tuning math — the pure half of the Strudel tuning helpers
// (`edo`, `edoscale`, `ratio`, `cents` — registered in code-api.js).
//
// Upstream Strudel has an unreleased `@strudel/edo` package; until it ships
// in the pinned @strudel/repl bundle these helpers cover the ground by
// mapping degrees/ratios straight to a `freq` control, which superdough
// honors end-to-end on synths and samples alike. Spec strings are designed
// so upstream's `L/s` step-word form could slot in later without breaking
// the degree-list form.
//
// ZERO imports on purpose: code-api.js is not node-reachable (its JSON
// imports only resolve under Vite), so everything testable lives here and
// scripts/check-qualia-edo.mjs imports only this file.
//
// Parsers return null (or NaN for parseRatio) on junk instead of throwing —
// the callers run inside pattern callbacks, and a live set must never throw
// out of one.

// 12-TET anchors for note-name roots. Bare letters default to octave 4, so
// the unadorned default root is c4 (middle C ≈ 261.63 Hz) — degree 0 reads
// as a tonic, not as concert A.
const SEMITONE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NOTE_RE = /^([a-g])([#bs]*)(-?\d+)?$/i;

export const DEFAULT_ROOT_HZ = 440 * 2 ** ((60 - 69) / 12); // c4

/** MIDI note number → Hz (a4 = 69 = 440). */
export function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Note name → MIDI number, or null. Accepts `c4`, `eb3`, `f#2`, `as3`
 * (`s` = sharp, mini-notation-safe like Strudel's own note names); octave
 * defaults to 4. Case-insensitive.
 */
export function noteNameToMidi(name) {
  const m = NOTE_RE.exec(String(name).trim());
  if (!m) return null;
  let semis = SEMITONE[m[1].toLowerCase()];
  for (const acc of m[2].toLowerCase()) semis += (acc === 'b' ? -1 : 1);
  const octave = m[3] === undefined ? 4 : parseInt(m[3], 10);
  return (octave + 1) * 12 + semis;
}

/**
 * Root spec → Hz, or null. Accepts a positive number (Hz), a numeric string
 * (Hz), or a 12-TET note name (`c4`, `eb3`, `f#2`). Empty/undefined → c4.
 * `noteToMidi` is an optional injected converter (the repl bundle exports
 * one on globalThis) tried before the local parser; both agree on standard
 * names, ours is just the no-bundle fallback.
 */
export function parseRoot(spec, noteToMidi) {
  if (spec === undefined || spec === null || spec === '') return DEFAULT_ROOT_HZ;
  if (typeof spec === 'number') return (Number.isFinite(spec) && spec > 0) ? spec : null;
  const s = String(spec).trim();
  if (s === '') return DEFAULT_ROOT_HZ;
  const num = Number(s);
  if (Number.isFinite(num)) return num > 0 ? num : null;
  // Normalize a bare letter to explicit octave 4 before the injected
  // converter sees it — Strudel's own default octave differs (3), and the
  // root must not move depending on whether the bundle has loaded.
  const withOct = /\d/.test(s) ? s : `${s}4`;
  if (typeof noteToMidi === 'function') {
    try {
      const midi = noteToMidi(withOct);
      if (Number.isFinite(midi)) return midiToHz(midi);
    } catch { /* fall through to the local parser */ }
  }
  const midi = noteNameToMidi(withOct);
  return midi === null ? null : midiToHz(midi);
}

/** EDO degree → Hz: rootHz · 2^(degree/divisions). Degrees may be negative,
 *  ≥ divisions (octaves fold naturally) or fractional (free bends). */
export function edoFreq(rootHz, divisions, degree) {
  return rootHz * 2 ** (degree / divisions);
}

/** Cents offset → frequency factor: 2^(cents/1200). */
export function centsFactor(cents) {
  return 2 ** (cents / 1200);
}

/**
 * EDO spec → { n, rootHz, degrees } or null.
 *   31                  → 31 divisions, root c4
 *   "31:a3"  "31:440"   → root by note name or Hz
 *   "31:c4:0 5 10 13 18 23 28"
 *                       → plus a degree subset (space- or comma-separated)
 *                         for edoscale(); omitted → degrees: null.
 */
export function parseEdoSpec(spec, noteToMidi) {
  let n, root, degreeStr;
  if (typeof spec === 'number') { n = spec; }
  else {
    const parts = String(spec).trim().split(':');
    n = Number(parts[0]);
    root = parts[1];
    degreeStr = parts.slice(2).join(':'); // tolerate stray colons in the tail
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  const rootHz = parseRoot(root, noteToMidi);
  if (rootHz === null) return null;
  let degrees = null;
  if (degreeStr !== undefined && degreeStr.trim() !== '') {
    degrees = degreeStr.trim().split(/[\s,]+/).map(Number);
    if (!degrees.length || degrees.some((d) => !Number.isFinite(d))) return null;
  }
  return { n, rootHz, degrees };
}

/**
 * JI ratio → number, or NaN. Accepts a number (1.25), `"5:4"`, `"5/4"`, a
 * `[num, den]` pair (what mini-notation's colon token parses to in the
 * 1.3.0 bundle — verified at runtime), or an `{s, n}` pair (the shape the
 * `s("bd:3")` channel rides, kept as a fallback against version drift).
 * The COLON form is the one to teach: inside double-quoted mini strings
 * `/` is the slow operator, so `"5/4"` would pattern pure(5) over 4
 * cycles — write `"1 5:4 3:2 2"`.
 */
export function parseRatio(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : NaN;
  if (Array.isArray(v)) {
    if (v.length !== 2) return NaN;
    const num = Number(v[0]), den = Number(v[1]);
    return (Number.isFinite(num) && Number.isFinite(den) && den !== 0 && num / den > 0)
      ? num / den : NaN;
  }
  if (v && typeof v === 'object') {
    const num = Number(v.s), den = Number(v.n);
    return (Number.isFinite(num) && Number.isFinite(den) && den !== 0 && num / den > 0)
      ? num / den : NaN;
  }
  const s = String(v).trim();
  const m = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (m) {
    const num = Number(m[1]), den = Number(m[2]);
    return den === 0 ? NaN : num / den;
  }
  const num = Number(s);
  return Number.isFinite(num) && num > 0 ? num : NaN;
}

/**
 * Index into an EDO degree subset with octave wrap: index 7 of a 7-note
 * subset is subset[0] an octave up, index -1 is the last note an octave
 * down. Returns the absolute EDO degree.
 */
export function scaleDegree(degrees, n, index) {
  const len = degrees.length;
  const i = Math.round(index);
  const wrap = ((i % len) + len) % len;
  const octave = Math.floor(i / len);
  return degrees[wrap] + octave * n;
}
