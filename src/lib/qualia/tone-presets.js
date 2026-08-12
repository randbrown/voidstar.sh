// Tone presets — the rig's amp + eq + cab trio saved as one recallable "tone".
//
// A tone is the coupled state of the three tone-cluster stages: which amp
// capture and cab IR are selected (as library POINTERS — the bytes stay in
// IndexedDB / travel via .qualem.zip bundles) plus each stage's on/off and
// params (incl. the amp's norm toggle). Pure store + file I/O here; the UI
// and the apply path live in looper.js, which owns the strip model. Follows
// qualem.js's list-store idiom ({id, name, createdAt, updatedAt} entries in
// one localStorage JSON array, newest first).
//
// Exported files carry `format: 'voidstar-tone'`. Importing on a machine
// that lacks the referenced amp/cab bytes still applies the stage settings —
// the missing pointer just leaves the current capture, the same policy the
// qualem apply path uses.

const LIST_KEY = 'voidstar.qualia.looper.tonePresets';
export const TONE_FORMAT = 'voidstar-tone';
export const TONE_VERSION = 1;

function uid() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function loadTones() {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && e.id && e.name) : [];
  } catch { return []; }
}
export function saveTones(list) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); } catch {}
}
export function getToneById(id) {
  return loadTones().find((e) => e.id === id) || null;
}
export function getToneByName(name) {
  const n = String(name || '').toLowerCase();
  return loadTones().find((e) => String(e.name).toLowerCase() === n) || null;
}

// Suffix "· 2", "· 3", … until the name is unique in the list.
function uniqueName(list, base) {
  const names = new Set(list.map((e) => String(e.name).toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const cand = `${base} · ${i}`;
    if (!names.has(cand.toLowerCase())) return cand;
  }
}

/** Add a preset from a tone slice ({strip:{amp,eq,cab}, ampFile, cabFile}). */
export function addTone(name, slice) {
  const list = loadTones();
  const now = Date.now();
  const entry = {
    format: TONE_FORMAT, v: TONE_VERSION,
    id: uid(),
    name: uniqueName(list, String(name || 'tone').trim() || 'tone'),
    createdAt: now, updatedAt: now,
    ...sanitizeToneSlice(slice),
  };
  list.unshift(entry);
  saveTones(list);
  return entry;
}
export function updateTone(id, patch) {
  const list = loadTones();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, id, updatedAt: Date.now() };
  saveTones(list);
  return list[i];
}
export function removeTone(id) {
  saveTones(loadTones().filter((e) => e.id !== id));
}

// Keep only the fields a tone owns; anything else in an imported file is
// dropped rather than trusted.
export function sanitizeToneSlice(slice) {
  const out = { strip: {}, ampFile: filePtr(slice?.ampFile), cabFile: filePtr(slice?.cabFile) };
  for (const stage of ['amp', 'eq', 'cab']) {
    const src = slice?.strip?.[stage];
    if (!src || typeof src !== 'object') continue;
    const dst = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === 'collapsed') continue;
      if (typeof v === 'number' && Number.isFinite(v)) dst[k] = v;
      else if (typeof v === 'boolean') dst[k] = v;
    }
    out.strip[stage] = dst;
  }
  return out;
}
function filePtr(p) {
  return { id: typeof p?.id === 'string' ? p.id : '', name: typeof p?.name === 'string' ? p.name : '' };
}

// ── file I/O ────────────────────────────────────────────────────────────────
function safeFile(s) {
  return String(s || 'tone').replace(/[^\w\-. ]+/g, '_').trim().slice(0, 60) || 'tone';
}
export function downloadTone(entry) {
  const blob = new Blob([JSON.stringify(entry, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFile(entry.name)}.tone.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 200);
}
/** Read a .tone.json file → the imported entry (added to the list). */
export function importToneFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('read failed'));
    r.onload = () => {
      try {
        const obj = JSON.parse(String(r.result));
        if (!obj || obj.format !== TONE_FORMAT) { reject(new Error('not a tone preset file')); return; }
        const base = String(obj.name || file.name.replace(/\.tone\.json$/i, '') || 'tone');
        resolve(addTone(base, obj));
      } catch (e) { reject(e); }
    };
    r.readAsText(file);
  });
}
