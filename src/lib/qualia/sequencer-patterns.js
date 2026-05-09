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
//   { id, name, cps, beats, steps, pads:[{id,voice,mute,gain,hits:[0|1...]}],
//     createdAt, updatedAt }
// Cell count = beats * steps. CPS (cycles/sec) matches Strudel — one cycle
// = one full pattern repeat, regardless of beats/steps. Triplets/quintuplets
// are just different `steps` values.

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
  { id: 'clap',  label: 'clap'  },
  { id: 'rim',   label: 'rim'   },
];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Storage ──────────────────────────────────────────────────────────────
export function loadCurrent() {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    return validateModel(m) ? m : null;
  } catch { return null; }
}
export function saveCurrent(model) {
  if (!validateModel(model)) return;
  try { localStorage.setItem(CURRENT_KEY, JSON.stringify(model)); } catch {}
}
export function loadList() {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(validateModel) : [];
  } catch { return []; }
}
export function saveList(list) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); } catch {}
}

export function loadPanelOpen() {
  try { return localStorage.getItem(PANEL_OPEN_KEY) === '1'; } catch { return false; }
}
export function savePanelOpen(open) {
  try { localStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0'); } catch {}
}

// ── Validation ───────────────────────────────────────────────────────────
// Defensive: a corrupt or partial `current` blob shouldn't crash the panel
// at boot. Reject anything missing the required shape so callers fall back
// to defaultPattern().
function validateModel(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.cps !== 'number' || !(m.cps > 0)) return false;
  if (!Number.isInteger(m.beats) || m.beats < 1) return false;
  if (!Number.isInteger(m.steps) || m.steps < 1) return false;
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
  // 4 beats × 4 steps = 16 cells. A passable groove out of the box: kick
  // on 1+9 (downbeats of beats 1 + 3), snare on 5+13 (downbeats of beats
  // 2 + 4), closed hat on every odd cell. Everything else empty so the
  // user has somewhere to add their own hits without hunting for room.
  const total = 16;
  const empty = () => new Array(total).fill(0);
  const kick  = empty(); kick[0]  = 1; kick[8]  = 1;
  const snare = empty(); snare[4] = 1; snare[12] = 1;
  const hat   = empty(); for (let i = 0; i < total; i += 2) hat[i] = 1;
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
    // Sync defaults to ON — most live-set use is "both engines locked
    // and jamming together". Users who want them independent flick the
    // checkbox off; the off-state persists with the pattern.
    syncStrudel: true,
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
