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

// ── jitune: retune 12-TET pitches to a tuning table ────────────────────────
// One factor per pitch class above the root — ratios for the JI tables,
// irrational factors for the tempered ones. Named tables:
//   5        classic 5-limit (default; b7 = 9:5, close to piano intonation)
//   7        septimal: 7:5 tritone, 7:4 harmonic seventh (~31¢ flat of ET)
//   neutral  both thirds → 11:9 (~347¢) and both sevenths → 11:6 (~1049¢) —
//            major/minor collapses into the in-between maqam-ish color,
//            so ordinary chord symbols come out as neutral chords ('11')
//   super    supermajor: 9:7 third (~435¢), 8:7 second, 12:7 sixth,
//            27:14 seventh — the wide septimal majors ('supermajor')
//   sub      subminor: 7:6 third (~267¢), 15:14 second, 14:9 sixth,
//            7:4 seventh — the dark septimal minors ('subminor')
//   meantone quarter-comma meantone, Eb–G# chain: every fifth is 5^(1/4)
//            (~696.6¢) so major thirds land on a pure 5:4 — the 16th-17th
//            century keyboard sound ('quarter-comma', 'qc')
//   pythagorean  3-limit, nothing but stacked pure 3:2 fifths — wide bright
//            81:64 thirds, the medieval/pre-meantone sound; the mirror
//            image of meantone's trade ('pyth', '3')
//   harmonic every slot drawn from overtones of the root (17:16, 19:16,
//            21:16, 11:8 tritone, 13:8, 7:4) — chords ring like one
//            resonating string ('harm', 'overtone')
//   well     Werckmeister III, THE canonical Bach-era circulating well-
//            temperament — every key playable, each with its own color.
//            "Well temperament" is a family (Kirnberger, Vallotti, Young,
//            …); this shorthand deliberately means Werckmeister III, the
//            one people mean by default — others via custom tables
//            ('werckmeister', 'wm3')

// Quarter-comma meantone: fifths flattened so four of them stack to exactly
// 5:1 (a pure major third two octaves up). Built from the chain of fifths
// Eb..G#, each entry normalized into [1, 2).
const MEANTONE_FIFTH = 5 ** 0.25;
const MEANTONE = (() => {
  const t = new Array(12);
  for (let k = -3; k <= 8; k++) {
    const pc = (((k * 7) % 12) + 12) % 12;
    const v = MEANTONE_FIFTH ** k;
    t[pc] = v / 2 ** Math.floor(Math.log2(v));
  }
  return t;
})();

// Werckmeister III, by its published cent values — a well-temperament is
// irrational (tempered fifths), so cents are the natural source form.
const WELL_CENTS = [0, 90, 192, 294, 390, 498, 588, 696, 792, 888, 996, 1092];
const WELL = WELL_CENTS.map((c) => 2 ** (c / 1200));

export const TUNE_TABLES = {
  5: [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8],
  7: [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 7 / 5, 3 / 2, 8 / 5, 5 / 3, 7 / 4, 15 / 8],
  neutral: [1, 16 / 15, 9 / 8, 11 / 9, 11 / 9, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 11 / 6, 11 / 6],
  super: [1, 16 / 15, 8 / 7, 6 / 5, 9 / 7, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 12 / 7, 9 / 5, 27 / 14],
  sub: [1, 15 / 14, 9 / 8, 7 / 6, 5 / 4, 4 / 3, 7 / 5, 3 / 2, 14 / 9, 5 / 3, 7 / 4, 15 / 8],
  meantone: MEANTONE,
  pythagorean: [1, 256 / 243, 9 / 8, 32 / 27, 81 / 64, 4 / 3, 729 / 512, 3 / 2, 128 / 81, 27 / 16, 16 / 9, 243 / 128],
  harmonic: [1, 17 / 16, 9 / 8, 19 / 16, 5 / 4, 21 / 16, 11 / 8, 3 / 2, 13 / 8, 27 / 16, 7 / 4, 15 / 8],
  well: WELL,
};

const TABLE_ALIASES = {
  '11': 'neutral',
  supermajor: 'super',
  subminor: 'sub',
  'quarter-comma': 'meantone',
  quartercomma: 'meantone',
  qc: 'meantone',
  pyth: 'pythagorean',
  '3': 'pythagorean',
  harm: 'harmonic',
  overtone: 'harmonic',
  werckmeister: 'well',
  wm3: 'well',
};

/** Hz → (fractional) MIDI note number. */
export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

/**
 * jitune spec → { rootHz, rootMidi, ratios } or null.
 *   "c3"                 → root + the 5-limit table
 *   "c3:<table>"         → a named table: 7, neutral (11), super
 *                          (supermajor), sub (subminor), meantone
 *                          (quarter-comma, qc)
 *   "c3:1 16:15 9:8 …"   → a custom 12-ratio table (parseRatio per token,
 *                          so colon and slash forms both work)
 * Roots take anything parseRoot does (note name or Hz); only the root's
 * pitch CLASS matters to the result — the octave falls out of the math.
 */
export function parseTuneSpec(spec, noteToMidi) {
  let rootPart, tail;
  if (typeof spec === 'number') { rootPart = spec; tail = ''; }
  else {
    const s = String(spec ?? '').trim();
    const i = s.indexOf(':');
    rootPart = i === -1 ? s : s.slice(0, i);
    tail = i === -1 ? '' : s.slice(i + 1).trim();
  }
  const rootHz = parseRoot(rootPart === '' ? undefined : rootPart, noteToMidi);
  if (rootHz === null) return null;
  const rootMidi = Math.round(hzToMidi(rootHz));
  let ratios = TUNE_TABLES[5];
  if (tail !== '') {
    const key = tail.toLowerCase();
    const named = Object.prototype.hasOwnProperty.call(TABLE_ALIASES, key) ? TABLE_ALIASES[key] : key;
    if (Object.prototype.hasOwnProperty.call(TUNE_TABLES, named)) {
      ratios = TUNE_TABLES[named];
    } else {
      const parts = tail.split(/\s+/).map(parseRatio);
      if (parts.length !== 12 || parts.some((r) => !Number.isFinite(r))) return null;
      ratios = parts;
    }
  }
  return { rootHz, rootMidi, ratios };
}

/**
 * Retune one (possibly fractional) MIDI pitch to the JI table: the nearest
 * semitone picks the pitch class + octave, and any fractional remainder
 * (e.g. a prior .cents() detune) is re-applied on top so the two compose.
 */
export function jiRetune(rootHz, rootMidi, ratios, midi) {
  const s = midi - rootMidi;
  const si = Math.round(s);
  const frac = s - si;
  const pc = ((si % 12) + 12) % 12;
  const oct = Math.floor(si / 12);
  return rootHz * 2 ** oct * ratios[pc] * 2 ** (frac / 12);
}
