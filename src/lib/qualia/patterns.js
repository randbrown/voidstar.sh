// Strudel pattern storage + metadata + random-pattern generator.
//
// Two localStorage slots:
//   - `voidstar.qualia.patterns.current` — the live editor buffer, debounce-saved
//     on every play/stop so a refresh restores the current take.
//   - `voidstar.qualia.patterns.list`    — the user's named pattern library.
// Each list entry is { id, name, code, createdAt, updatedAt }. The display
// name + author + license are parsed from Strudel-style `// @key value`
// comments at runtime.

import { getRaw, setRaw, getJSON, setJSON } from './prefs.js';

const NS           = 'voidstar.qualia.patterns';
const CURRENT_KEY  = `${NS}.current`;
const LIST_KEY     = `${NS}.list`;

// ── Storage ──────────────────────────────────────────────────────────────
export function loadCurrent() {
  return getRaw(CURRENT_KEY, null);
}
export function saveCurrent(code) {
  if (typeof code !== 'string') return;
  setRaw(CURRENT_KEY, code);
}
export function loadList() {
  return getJSON(LIST_KEY, []);
}
export function saveList(list) {
  setJSON(LIST_KEY, list);
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
// Drums + bass only, octave-1 bass, tempo in [0.5, 1.0], no note-density
// multipliers above 2. Tuned for chill live-ambient performance — the
// melody/lead lines that used to ride on top were too prominent for that
// register, so we dropped them entirely. Variation now lives in root note,
// scale, and tempo; the rhythmic + timbral shape stays consistent so the
// generated patterns all sit in the same sonic neighborhood.
const ROOTS  = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SCALES = ['minor', 'major', 'dorian', 'mixolydian', 'lydian',
                'phrygian', 'harmonic minor', 'pentatonic'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function randomPattern() {
  const rootNote = pick(ROOTS);
  const scale    = pick(SCALES);
  // Tempo random across [0.5, 1.0] — chill range with a touch of headroom.
  const cps      = (0.5 + Math.random() * 0.5).toFixed(2);
  const tag      = Math.floor(Math.random() * 0xffff).toString(36);
  // Bass line: 0 and 4, then two distinct random degrees from 1–6 (no repeats,
  // so 4 is excluded from the pool).
  const pool     = [1, 2, 3, 5, 6];
  const bass3    = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  const bass4    = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  return `// @title qualem ${tag}
// @by voidstar
setcps(${cps})
stack(
  s("<bd ~ sd ~>").lpf(sine.range(500, 2000).slow(8)).delay(.2),
  n("<0 4 ${bass3} ${bass4}>/4").scale('${rootNote}1 ${scale}').s("gm_synth_strings_2").lpf(800),
).room(0.5)`;
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
