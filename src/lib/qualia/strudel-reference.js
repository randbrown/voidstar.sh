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
  'templates',
  'qualia',
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

// ── The house functions — the `globalThis.qualia` live-code surface ─────────
// These aren't Strudel builtins; they're the bridge this instrument exposes to
// pattern code (see docs/livecoding.md and strudel-hydra.js / page-init.js,
// which own the implementations). Kept here, next to the Strudel subset, so
// the funcs tab documents the WHOLE vocabulary a pattern can speak.
const QUALIA_FUNCTIONS = [
  {
    name: 'qualia.setParam',
    category: 'qualia',
    signature: 'qualia.setParam(fxId, paramId, value)',
    doc: 'Drive any quale param from pattern code — the live-code → fx bridge. Ids match the param panel (fx id is snake_case, param ids are the slider names). A param with modulators keeps its audio/pose reactivity on top of the value you set.',
    example: "qualia.setParam('block_world', 'scene', 'mine')",
    insert: "qualia.setParam('block_world', 'scene', 'mine')",
  },
  {
    name: 'setParam per event',
    category: 'qualia',
    signature: '.onTrigger(fn, false)',
    doc: 'Fire setParam from a pattern so the visual moves with the notes — onTrigger with `false` keeps the sound while running the side effect per event.',
    example: 's("bd ~ sd ~").onTrigger(() => qualia.setParam(\'liner_notes\', \'typeSpeed\', 2 + Math.random()), false)',
    insert: '.onTrigger(() => qualia.setParam(\'\', \'\', 1), false)',
  },
  {
    name: 'qualia.getField',
    category: 'qualia',
    signature: 'qualia.getField() → QualiaField',
    doc: 'Read the live per-frame field: audio.bands (bass/mids/highs/total), audio.beat.pulse, rms, pose.people, crowd.*. Lets pattern code react to the room.',
    example: 'const f = qualia.getField()\n// f.audio.bands.bass, f.crowd.energy …',
    insert: 'qualia.getField()',
  },
  {
    name: 'a.fft (Hydra bands)',
    category: 'qualia',
    signature: 'a.fft[0..3]',
    doc: 'The four smoothed bands for Hydra code: [0] bass, [1] mids, [2] highs, [3] total. Backed by the same analysis that drives the quales.',
    example: 'osc(10, .1).scale(() => 1 + a.fft[0]).out()',
    insert: 'a.fft[0]',
  },
  {
    name: 'qualia.mixer',
    category: 'qualia',
    signature: 'qualia.mixer.setLevel(id, v) · setMuted(id, on) · setLimiter(id, on)',
    doc: "Drive any track from code. Track ids: 'mic', 'rig', 'strudel', 'seq', 'vox'. Also mixer.open()/close() and mixer.isClipping().",
    example: "qualia.mixer.setLevel('strudel', .7)",
    insert: "qualia.mixer.setLevel('strudel', .7)",
  },
  {
    name: 'qualia.setStrudelLatency',
    category: 'qualia',
    signature: 'qualia.setStrudelLatency(seconds)',
    doc: 'A/B the cyclist lookahead live — higher = fewer dropouts but more delay before edits land. Re-run the sequencer realign after changing.',
    example: 'qualia.setStrudelLatency(0.3)',
    insert: 'qualia.setStrudelLatency(0.3)',
  },
  {
    name: 'qualia.setReactFps',
    category: 'qualia',
    signature: 'qualia.setReactFps(fps)',
    doc: 'Perf knob: the reactivity cadence (audio tick + listeners). Lower trims main-thread load and helps the cyclist at the cost of coarser beat response. 0 = every rAF.',
    example: 'qualia.setReactFps(40)',
    insert: 'qualia.setReactFps(40)',
  },
  {
    name: 'qualia.setDprCap',
    category: 'qualia',
    signature: 'qualia.setDprCap(n)',
    doc: 'Perf knob: cap the canvas devicePixelRatio (default 1.5). Dropping toward 1.0 cuts fragment work ~2.25× when GPU-bound. Console A/B only — not persisted.',
    example: 'qualia.setDprCap(1.0)',
    insert: 'qualia.setDprCap(1.0)',
  },
  {
    name: 'qualia editor knobs',
    category: 'qualia',
    signature: 'setStrudelEditorPerf(on) · setStrudelLineNumbers(on) · setStrudelFontSize(px)',
    doc: 'Editor controls from code: perf mode (kills per-frame highlight + flash — the biggest main-thread saving while the editor is open), line numbers, font size.',
    example: 'qualia.setStrudelEditorPerf(true)',
    insert: 'qualia.setStrudelEditorPerf(true)',
  },
];

export const STRUDEL_FUNCTIONS = [...functions, ...QUALIA_FUNCTIONS];

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
