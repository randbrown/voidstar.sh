// Strudel pattern storage + metadata + random-pattern generator.
//
// Two localStorage slots:
//   - `voidstar.qualia.patterns.current` — the live editor buffer, debounce-saved
//     on every play/stop so a refresh restores the current take.
//   - `voidstar.qualia.patterns.list`    — the user's named pattern library.
// Each list entry is { id, name, code, createdAt, updatedAt }. The display
// name + author + license are parsed from Strudel-style `// @key value`
// comments at runtime.

const NS           = 'voidstar.qualia.patterns';
const CURRENT_KEY  = `${NS}.current`;
const LIST_KEY     = `${NS}.list`;

// ── Storage ──────────────────────────────────────────────────────────────
export function loadCurrent() {
  try { return localStorage.getItem(CURRENT_KEY); } catch { return null; }
}
export function saveCurrent(code) {
  if (typeof code !== 'string') return;
  try { localStorage.setItem(CURRENT_KEY, code); } catch {}
}
export function loadList() {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
export function saveList(list) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); } catch {}
}

// ── Metadata ─────────────────────────────────────────────────────────────
// Strudel uses `// @title ...` style comments. We pick up any @-prefixed
// directive on its own comment line and surface the canonical ones (title,
// by, license, desc).
export function parseMetadata(code) {
  const meta = {};
  if (typeof code !== 'string') return meta;
  const re = /^[ \t]*\/\/[ \t]*@(\w+)[ \t]+(.+?)[ \t]*$/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}
export function patternDisplayName(p) {
  return p.name || parseMetadata(p.code).title || 'Untitled';
}

// Replace or insert the metadata block at the top of a pattern. Used when
// the user renames a pattern in the UI — the rename flows back into the
// `// @title ...` line so downloads and re-imports stay consistent.
export function setMetadata(code, key, value) {
  const line = `// @${key} ${value}`;
  const re   = new RegExp(`^[ \\t]*\\/\\/[ \\t]*@${key}[ \\t].*$`, 'm');
  if (re.test(code)) return code.replace(re, line);
  // Insert at top, after any leading blank/comment lines for cleanliness.
  return `${line}\n${code}`;
}

// ── List operations ──────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function addToList(code, name) {
  const list = loadList();
  const meta = parseMetadata(code);
  const entry = {
    id: uid(),
    name: name || meta.title || `Untitled ${list.length + 1}`,
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.unshift(entry);
  saveList(list);
  return entry;
}
export function updateInList(id, partial) {
  const list = loadList();
  const i = list.findIndex(p => p.id === id);
  if (i < 0) return null;
  const next = { ...list[i], ...partial, updatedAt: Date.now() };
  // If renaming, also patch the @title in the code so downloads stay synced.
  if (partial.name && next.code) {
    next.code = setMetadata(next.code, 'title', partial.name);
  }
  list[i] = next;
  saveList(list);
  return next;
}
export function removeFromList(id) {
  const list = loadList().filter(p => p.id !== id);
  saveList(list);
}
export function clonePattern(id) {
  const list = loadList();
  const src  = list.find(p => p.id === id);
  if (!src) return null;
  const cloneName = `${src.name} (copy)`;
  const cloneCode = setMetadata(src.code, 'title', cloneName);
  return addToList(cloneCode, cloneName);
}

// ── Random pattern generator ─────────────────────────────────────────────
// Curated parameter pools chosen to keep the generated output in the
// same "ambient atmospheric" register as the hardcoded default — small
// note pool, pads/leads only, gentle effect chain.
const ROOTS    = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const OCTAVES  = ['3', '4', '4', '5'];          // bias toward 4
const SCALES   = ['minor', 'major', 'dorian', 'mixolydian', 'lydian',
                  'phrygian', 'harmonic minor', 'pentatonic'];
// Sticking to the one confirmed-loading sample for now. The wider GM pool
// (pad_2_warm, choir_aahs, etc.) was triggering "sample not found" errors
// in some Strudel builds — better to play safe with the same source the
// hardcoded default has always used.
const SAMPLES  = ['gm_lead_6_voice'];
// 8-step alternation with *4 density. The mini-notation itself loops in
// 2 cycles — N_TRANSFORMS below stretches/rotates it over ~8 cycles so
// the overall melody evolves instead of looping tightly.
const PATTERNS = [
  '<0 2 4 5 7 5 4 2>*4',
  '<0 3 5 7 9 7 5 3>*4',
  '<0 4 7 9 7 4 0 -3>*4',
  '<0 1 4 7 5 4 2 -1>*4',
  '<0 -1 2 -3 4 -3 2 -1>*4',
  '<0 4 7 4 5 2 0 -3>*4',
  '<0 5 7 5 4 2 0 -2>*4',
  '<0 2 4 7 9 7 4 2>*4',
  '<7 4 0 -3 0 4 7 9>*4',
  '<0 2 5 7 5 2 0 -2>*4',
  '<-3 0 4 7 4 0 -3 -5>*4',
  '<0 1 2 3 4 3 2 1>*4',
];

// Strudel transforms applied to the n() pattern to spread variation
// across multiple cycles. Mostly stretchers and slow rotations so the
// underlying 2-cycle alternation becomes an ~8-cycle journey.
const N_TRANSFORMS = [
  '.slow(4)',
  '.iter(8)',
  '.every(4, rev)',
  '.every(8, fast(2))',
  '.chunk(4, rev)',
  '.slow(2).every(4, rev)',
  '.iter(4).slow(2)',
  '.every(8, scramble(8))',
];
const FX_OPTS  = [
  'jux(rev)',
  'sometimes(add(note("12")))',
  'sometimes(add(note("7")))',
  'lpf(perlin.range(200,20000).slow(4))',
  'lpf(sine.range(400,8000).slow(8))',
  'gain(perlin.range(.4,.9).slow(6))',
  'pan(sine.range(0,1).slow(4))',
  'delay(0.5)',
  'crush(sine.range(4,16).slow(8))',
];

// Drum voice pool — slow mellow ambient kick/snare only. All variants are
// `/4` cycle (one bd or sd every four cycles, very spacious) with LPF
// under 120 so the kicks read as warm sub-thump and never poke through
// the lead. Variation across pool entries is intentionally small —
// melody is where the random character should live.
const DRUMS = [
  's("<bd sd>/4").lpf(90).gain(.3).delay(.2)',
  's("<bd sd>/4").lpf(110).gain(.3).delay(.2).room(.5)',
  's("<bd ~ sd ~>/4").lpf(100).gain(.3).delay(.25)',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function randomPattern() {
  const root   = pick(ROOTS) + pick(OCTAVES);
  const scale  = pick(SCALES);
  const sample = pick(SAMPLES);
  const pat    = pick(PATTERNS);
  const nMod   = pick(N_TRANSFORMS);
  const drums  = pick(DRUMS);
  const cps    = (0.65 + Math.random() * 0.55).toFixed(2);
  const room   = (0.8 + Math.random() * 1.6).toFixed(1);
  // Pick 2–3 distinct fx so each random pattern has its own colour.
  const fxPool = [...FX_OPTS];
  const fxN    = 2 + Math.floor(Math.random() * 2);
  const fxLines = [];
  for (let i = 0; i < fxN && fxPool.length; i++) {
    const idx = Math.floor(Math.random() * fxPool.length);
    fxLines.push('.' + fxPool.splice(idx, 1)[0]);
  }
  // Stack body lives at 2-space indent (Strudel convention). Both the
  // melody chain's continuation lines AND the random-fx lines sit at the
  // same indent so the whole second-voice block reads as one chained
  // expression nested inside stack(...).
  const fxBlock = fxLines.map(line => '  ' + line).join('\n');
  const tag = Math.floor(Math.random() * 0xffff).toString(36);
  return `// @title random ${tag}
// @by voidstar
// @license CC0
setcps(${cps})
stack(
  ${drums},
  n("${pat}")${nMod}
  .scale('${root} ${scale}').s("${sample}")
  .clip(sine.range(.2,.8).slow(8))
${fxBlock}
).room(${room})`;
}

// ── Download helper ──────────────────────────────────────────────────────
export function downloadPattern(code, name) {
  const safe = (name || parseMetadata(code).title || 'pattern')
    .replace(/[^\w.-]+/g, '_').slice(0, 60) || 'pattern';
  const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `${safe}.strudel`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}
