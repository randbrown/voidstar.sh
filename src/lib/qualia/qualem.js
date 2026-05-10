// Qualem — a saved snapshot of the entire qualia macro-experience.
//
// "Qualem" (singular noun derived from the plural "qualia") = one whole
// experience captured as a JSON document: active quale + every fx's params,
// modulator weights, audio tunables, pose settings, overlay toggles, glitch
// modes, auto-phase/cycle, camera transform, cycle-pool exclusions, strudel
// pattern, sequencer model, vocoder config, and panel layout.
//
// Capture is sparse by default — for each fx we only record params that
// differ from the schema's `default`. Smaller payloads (fits in URLs/QR),
// and fx whose defaults evolve in future builds pick up the new defaults
// for any field the user didn't touch. Pass { sparse: false } to lock in
// every value verbatim.
//
// The pure helpers (sparse diff, list IO, URL encode, file IO) live here.
// The actual `capture(live)` and `apply(qualem, live)` routines live in
// page-init.js where they have direct access to all the imperative
// setters (audio.setTunables, pose.setSmoothing, overlay.setOption, ...).

const NS              = 'voidstar.qualia.qualem';
const LIST_KEY        = `${NS}.list`;

export const QUALEM_FORMAT          = 'qualem';
export const QUALEM_SCHEMA_VERSION  = 1;

// ── Sparse diff against fx schema defaults ─────────────────────────────────
/**
 * Drop param keys whose current value matches the schema default. Numeric
 * comparisons use a small tolerance because slider values can drift by
 * floating-point epsilon between save+restore cycles.
 *
 * @param {{ params?: Array<{ id: string, default: any }> }} mod
 * @param {Record<string, any>|null|undefined} params
 */
export function sparseFxParams(mod, params) {
  if (!params || !mod?.params) return {};
  const out = {};
  for (const spec of mod.params) {
    if (!(spec.id in params)) continue;
    const cur = params[spec.id];
    const def = spec.default;
    if (cur === def) continue;
    if (typeof cur === 'number' && typeof def === 'number'
        && Math.abs(cur - def) < 1e-9) continue;
    out[spec.id] = cur;
  }
  return out;
}

// ── localStorage list ──────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function loadList() {
  try { return JSON.parse(localStorage.getItem(LIST_KEY)) || []; }
  catch { return []; }
}
export function saveList(list) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); } catch {}
}
export function getById(id) {
  return loadList().find(q => q.id === id) || null;
}
export function addToList(qualem, name) {
  const list = loadList();
  const entry = {
    ...qualem,
    id:        qualem.id        || uid(),
    name:      name || qualem.name || `Untitled ${list.length + 1}`,
    createdAt: qualem.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  list.unshift(entry);
  saveList(list);
  return entry;
}
export function updateInList(id, partial) {
  const list = loadList();
  const i = list.findIndex(q => q.id === id);
  if (i < 0) return null;
  const next = { ...list[i], ...partial, updatedAt: Date.now() };
  list[i] = next;
  saveList(list);
  return next;
}
export function removeFromList(id) {
  saveList(loadList().filter(q => q.id !== id));
}
export function cloneEntry(id) {
  const src = getById(id);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src));
  delete copy.id;
  delete copy.createdAt;
  return addToList(copy, `${src.name} (copy)`);
}

// ── URL encoding ───────────────────────────────────────────────────────────
// `g:<base64url>` gzip-compressed JSON, or `p:<base64url>` plain JSON when
// CompressionStream is unavailable (very old browsers). The tag prefix lets
// us evolve the encoding later without breaking old URLs.

/** @param {object} qualem */
export async function encodeForUrl(qualem) {
  const json = JSON.stringify(qualem);
  if (typeof CompressionStream === 'function') {
    const blob = new Blob([json]);
    const buf  = await new Response(
      blob.stream().pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer();
    return 'g:' + bytesToB64u(new Uint8Array(buf));
  }
  return 'p:' + bytesToB64u(new TextEncoder().encode(json));
}

/** @param {string} encoded */
export async function decodeFromUrl(encoded) {
  if (!encoded) return null;
  const colon = encoded.indexOf(':');
  let tag, payload;
  if (colon === 1) { tag = encoded[0]; payload = encoded.slice(2); }
  else { tag = 'g'; payload = encoded; }      // pre-tag fallback
  const bytes = b64uToBytes(payload);
  if (tag === 'g' && typeof DecompressionStream === 'function') {
    const text = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).text();
    return JSON.parse(text);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function bytesToB64u(bytes) {
  let bin = '';
  // Chunk to dodge "argument list too large" for big payloads.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a shareable URL for a qualem. Uses the page's current origin/path. */
export async function buildShareUrl(qualem, baseUrl = location.origin + location.pathname) {
  const enc = await encodeForUrl(qualem);
  return `${baseUrl}#q=${enc}`;
}

// ── File IO ────────────────────────────────────────────────────────────────
export function downloadQualem(qualem, name) {
  const safe = (name || qualem.name || 'qualem')
    .replace(/[^\w.-]+/g, '_').slice(0, 60) || 'qualem';
  const blob = new Blob([JSON.stringify(qualem, null, 2)],
                        { type: 'application/json;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `${safe}.qualem.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}

export function readFileAsQualem(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const obj = JSON.parse(r.result);
        if (!obj || obj.format !== QUALEM_FORMAT) {
          return reject(new Error('Not a qualem file'));
        }
        resolve(obj);
      } catch (e) { reject(e); }
    };
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

// ── Hardware fingerprint matching ──────────────────────────────────────────
// Best-effort device pick: exact deviceId → exact label → fuzzy label →
// groupId → kind+facingMode → first device of kind. Returns the chosen
// deviceId (or null when no devices match the kind at all).
//
//   fingerprint: { deviceId?, label?, groupId?, kind, capabilities? }
export async function pickBestDevice(fingerprint) {
  if (!fingerprint?.kind || !navigator.mediaDevices?.enumerateDevices) return null;
  let all;
  try { all = await navigator.mediaDevices.enumerateDevices(); } catch { return null; }
  const pool = all.filter(d => d.kind === fingerprint.kind);
  if (!pool.length) return null;

  if (fingerprint.deviceId) {
    const exact = pool.find(d => d.deviceId === fingerprint.deviceId);
    if (exact) return exact.deviceId;
  }
  if (fingerprint.label) {
    const exact = pool.find(d => d.label && d.label === fingerprint.label);
    if (exact) return exact.deviceId;
    const norm = fingerprint.label.toLowerCase();
    const fuzzy = pool.find(d => d.label && d.label.toLowerCase().includes(norm));
    if (fuzzy) return fuzzy.deviceId;
  }
  if (fingerprint.groupId) {
    const grp = pool.find(d => d.groupId === fingerprint.groupId);
    if (grp) return grp.deviceId;
  }
  // facingMode (cameras only) — labels often hint at this.
  const facing = fingerprint.capabilities?.facingMode;
  if (facing && fingerprint.kind === 'videoinput') {
    const hint = facing === 'environment' ? /back|rear|environment/i : /front|user|self/i;
    const facingMatch = pool.find(d => d.label && hint.test(d.label));
    if (facingMatch) return facingMatch.deviceId;
  }
  return pool[0].deviceId;
}

/** Build a fingerprint from an enumerateDevices entry + (optional) live track capabilities. */
export function deviceFingerprint(device, capabilities = null) {
  if (!device) return null;
  return {
    deviceId:     device.deviceId || '',
    label:        device.label || '',
    groupId:      device.groupId || '',
    kind:         device.kind,
    capabilities: capabilities || null,
  };
}
