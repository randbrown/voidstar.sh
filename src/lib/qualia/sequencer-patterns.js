// Sequencer pattern storage + model helpers.
//
// Mirrors patterns.js but stores JSON pattern *models* (not Strudel code
// strings). Three localStorage slots:
//   - voidstar.qualia.sequencer.current — live editor model (debounce-saved)
//   - voidstar.qualia.sequencer.list    — named pattern library
//   - voidstar.qualia.sequencer.panelOpen — '1'/'0' so we can re-open the
//     panel on next page load
//
// Pattern model:
//   { id, name, cps, beats, steps, cycles,
//     pads:[{id,voice,mute,gain,hits:[0|1...]}],
//     createdAt, updatedAt }
// Cell count = beats * steps. CPS (cycles/sec) matches Strudel — one cycle
// = one full pattern repeat, regardless of beats/steps. Triplets/quintuplets
// are just different `steps` values.
//
// `cycles` (>= 0.25) stretches the pattern over N Strudel cycles so the
// sequencer can sit at a half-time / quarter-time feel without dragging
// Strudel's CPS down with it. cycles=1 is the canonical "one pattern per
// cycle" behaviour; cycles=2 spreads the same grid across two cycles
// (half-time); cycles=0.5 packs it into half a cycle (double-time). Only
// the cell duration changes — `beats`/`steps` are still the pattern grid.

import { getJSON, setJSON, getBool, setBool } from './prefs.js';

const NS           = 'voidstar.qualia.sequencer';
const CURRENT_KEY  = `${NS}.current`;
const LIST_KEY     = `${NS}.list`;
export const PANEL_OPEN_KEY = `${NS}.panelOpen`;

// ── Voice catalog ────────────────────────────────────────────────────────
// Stable ids that sequencer-voices.js maps to Tone.js synths. Ordering here
// drives the default kit row order. Adding a voice without updating
// sequencer-voices.js will leave its rows silent — keep these in sync.
export const VOICES = [
  { id: 'kick',  label: 'kick'  },
  { id: 'snare', label: 'snare' },
  { id: 'hat-c', label: 'hat-c' },
  { id: 'hat-o', label: 'hat-o' },
  { id: 'tom-l', label: 'tom-l' },
  { id: 'tom-m', label: 'tom-m' },
  { id: 'tom-h', label: 'tom-h' },
  { id: 'crash', label: 'crash' },
  { id: 'ride',  label: 'ride'  },
  { id: 'rim',   label: 'rim'   },
];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Storage ──────────────────────────────────────────────────────────────
export function loadCurrent() {
  const m = getJSON(CURRENT_KEY, null);
  return m && validateModel(m) ? m : null;
}
export function saveCurrent(model) {
  if (!validateModel(model)) return;
  setJSON(CURRENT_KEY, model);
}
export function loadList() {
  const list = getJSON(LIST_KEY, []);
  return Array.isArray(list) ? list.filter(validateModel) : [];
}
export function saveList(list) {
  setJSON(LIST_KEY, list);
}

export function loadPanelOpen() { return getBool(PANEL_OPEN_KEY, false); }
export function savePanelOpen(open) { setBool(PANEL_OPEN_KEY, open); }

// ── Validation ───────────────────────────────────────────────────────────
// Defensive: a corrupt or partial `current` blob shouldn't crash the panel
// at boot. Reject anything missing the required shape so callers fall back
// to defaultPattern().
function validateModel(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.cps !== 'number' || !(m.cps > 0)) return false;
  if (!Number.isInteger(m.beats) || m.beats < 1) return false;
  if (!Number.isInteger(m.steps) || m.steps < 1) return false;
  // `cycles` was added after the initial release. Accept patterns without
  // it — the loader backfills cycles=1 — but if present, it must be a
  // positive finite number.
  if (m.cycles != null && (typeof m.cycles !== 'number' || !(m.cycles > 0))) {
    return false;
  }
  // `kitId` (which instrument the pads play through) was added later. Optional;
  // when present it must be a string. An unknown id is normalised to the
  // default kit by the sequencer (getKit), so we don't validate it against the
  // catalog here — that would couple this pure-data module to Tone/kit code.
  if (m.kitId != null && typeof m.kitId !== 'string') return false;
  if (!Array.isArray(m.pads)) return false;
  const expectLen = m.beats * m.steps;
  for (const p of m.pads) {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.voice !== 'string') return false;
    if (!Array.isArray(p.hits) || p.hits.length !== expectLen) return false;
  }
  return true;
}

// ── Model helpers ────────────────────────────────────────────────────────
export function makePad(voice, hits = null, opts = {}) {
  return {
    id: 'p_' + uid(),
    voice,
    mute: !!opts.mute,
    gain: typeof opts.gain === 'number' ? opts.gain : 1.0,
    hits: hits ? hits.slice() : [],
  };
}

// Resize a pad's hits array when beats/steps change. New cells are 0; if
// the new length is shorter, hits beyond it are dropped. Preserves the
// existing rhythm pattern — handy when the user dials beats up/down to
// experiment without losing what they've placed.
export function resizeHits(pad, beats, steps) {
  const want = beats * steps;
  const cur  = pad.hits || [];
  if (cur.length === want) return pad;
  const next = new Array(want).fill(0);
  for (let i = 0; i < Math.min(cur.length, want); i++) next[i] = cur[i] ? 1 : 0;
  pad.hits = next;
  return pad;
}

export function defaultPattern() {
  // Chill-by-default groove for live-ambient performance. 4 beats × 4
  // steps = 16 cells. Kick on the downbeat, snare on the backbeat
  // (cell 8), closed hat on half-notes only (cells 0 & 8). 4 hits total —
  // the minimum that still reads as "I hear a beat", sparse enough that
  // a new user has plenty of room to add their own voice. CPS matches
  // the Strudel default so the two engines start in lockstep.
  const total = 16;
  const empty = () => new Array(total).fill(0);
  const kick  = empty(); kick[0]  = 1;
  const snare = empty(); snare[8] = 1;
  const hat   = empty(); hat[0] = 1; hat[8] = 1;
  const pads = VOICES.map(v => {
    if (v.id === 'kick')  return makePad('kick',  kick);
    if (v.id === 'snare') return makePad('snare', snare);
    if (v.id === 'hat-c') return makePad('hat-c', hat);
    return makePad(v.id, empty());
  });
  return {
    id: uid(),
    name: 'untitled',
    cps: 0.5,
    beats: 4,
    steps: 4,
    // One pattern per Strudel cycle by default. Users dial this up for
    // half-time / quarter-time feels without changing CPS.
    cycles: 1,
    // Sync defaults to ON — most live-set use is "both engines locked
    // and jamming together". Users who want them independent flick the
    // checkbox off; the off-state persists with the pattern.
    syncStrudel: true,
    // Instrument the pads play through, saved with the pattern so a recalled
    // groove restores its kit. 'voidstar' is the default synth kit; the
    // sequencer normalises any unknown id back to it.
    kitId: 'voidstar',
    pads,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Deep clone via JSON — model is plain data, no functions/Dates as own
// props (createdAt/updatedAt are numbers). Keeps the live editor model
// independent from the saved-list copy so mutations don't bleed through.
export function clonePatternModel(m) {
  return JSON.parse(JSON.stringify(m));
}

// ── List operations ──────────────────────────────────────────────────────
export function addToList(model, name) {
  const list = loadList();
  const entry = clonePatternModel(model);
  entry.id = uid();
  entry.name = name || model.name || `Untitled ${list.length + 1}`;
  entry.createdAt = Date.now();
  entry.updatedAt = Date.now();
  list.unshift(entry);
  saveList(list);
  return entry;
}
export function updateInList(id, partial) {
  const list = loadList();
  const i = list.findIndex(p => p.id === id);
  if (i < 0) return null;
  const next = { ...list[i], ...partial, updatedAt: Date.now() };
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
  return addToList(src, `${src.name} (copy)`);
}

// ── Download helper ──────────────────────────────────────────────────────
export function downloadPattern(model) {
  const safe = (model.name || 'pattern').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'pattern';
  const blob = new Blob([JSON.stringify(model, null, 2)], { type: 'application/json;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `${safe}.seq.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}
