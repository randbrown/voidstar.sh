// Entanglement — the wire contract shared by host (entangle.js) and
// participant (entangle-client.js). No DOM, no transport: just the constants,
// message shapes, and the ingress validators that keep crowd input safe.
//
// Design notes:
//  • Topics are short strings (Trystero action names are length-capped at 12).
//  • Nothing here ever evals participant data. Param/vote payloads are matched
//    against the host's manifest + clamped to the param spec before they touch
//    the engine; pose payloads are fixed-length float arrays.

export const APP_ID = 'voidstar-entangle-v1';   // Trystero namespace
export const PARTICIPANT_PATH = '/lab/entangle'; // participant page route
const PINNED_ROOM_KEY = 'voidstar.entangle.pinnedRoom';

// Trystero action names (host ⇄ participant). Keep ≤ 12 chars.
export const T = {
  HELLO:    'hello',     // participant → host: I joined { name?, caps }
  MANIFEST: 'manifest',  // host → all: current scene + what's open
  POSE:     'pose',      // participant → host: packed feature array (aggregate)
  SKELETON: 'skeleton',  // participant → host: packed 9-joint array (overlay only)
  PARAM:    'param',     // participant → host: { id, value }
  VOTE:     'vote',      // participant → host: { fxId }
  PHASE:    'phase',     // participant → host: a phase-shift nudge (no body)
  PHASEPROG:'phaseprog', // host → all: { have, need } shift-charge progress
  VALUES:   'values',    // host → all: { id: value } live whitelisted base values
  BYE:      'bye',       // participant → host: leaving (best-effort)
  KICK:     'kick',      // host → all: { id } — that peer should disconnect
};

// 'skeleton' draws each participant's body as an overlay; it rides the same
// phone camera as 'pose', so enabling it implies pose (host UI forces it on).
export const MODES = ['pose', 'param', 'vote', 'phase', 'skeleton'];

// ── Room ids ───────────────────────────────────────────────────────────────
// Unguessable, URL-safe, short enough to keep the QR dense. Crockford-ish
// alphabet (no look-alike chars) so a glanced-at code is still typeable.
const ROOM_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export function makeRoomId(len = 10) {
  const a = new Uint8Array(len);
  (globalThis.crypto || crypto).getRandomValues(a);
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET[a[i] & 31];
  return s;
}

/**
 * Normalize a performer-typed room code into a safe, URL-clean id: lowercase,
 * runs of anything non-alphanumeric collapse to a single '-', trimmed, length
 * capped. Lets a performer pick a memorable code ("randy-0623") to pre-print,
 * while keeping the id transport- and URL-safe. Returns '' if nothing usable
 * survives (the caller then falls back to a generated id).
 * @param {string} s
 * @param {number} [max]
 */
export function normalizeRoomSlug(s, max = 32) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Build the participant URL a QR code encodes. */
export function buildJoinUrl(roomId, origin = location.origin) {
  return `${origin}${PARTICIPANT_PATH}#r=${roomId}`;
}
/** Read the room id a participant page was opened with. */
export function readRoomFromHash(hash = location.hash) {
  const m = /[#&]r=([^&]+)/.exec(hash || '');
  return m ? decodeURIComponent(m[1]) : null;
}

/** Read a ?room= query param from the host page URL. */
export function readRoomFromQuery(search = location.search) {
  const m = /[?&]room=([^&]+)/.exec(search || '');
  return m ? decodeURIComponent(m[1]) : null;
}

// Per-room HOST KEY. Authenticates the performer's device as the room's host
// to the signaling Worker (trust-on-first-use): only a socket presenting this
// key gets host privileges (drive the projection / broadcast to all phones).
// It lives ONLY here on the host's device — it is never put in the QR/join
// URL, so a phone that scans the QR can only join as a participant. High
// entropy so it can't be guessed. Stored as a { roomId: key } map so a host
// that hops rooms keeps each room's key.
const HOST_KEYS_KEY = 'voidstar.entangle.hostKeys';
export function getOrCreateHostKey(roomId) {
  if (!roomId) return '';
  let map = {};
  try { map = JSON.parse(localStorage.getItem(HOST_KEYS_KEY)) || {}; } catch {}
  if (!map[roomId]) {
    const a = new Uint8Array(24);
    (globalThis.crypto || crypto).getRandomValues(a);
    map[roomId] = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(HOST_KEYS_KEY, JSON.stringify(map)); } catch {}
  }
  return map[roomId];
}

/** Get the pinned room from localStorage (if any). */
export function getPinnedRoom() {
  try { return localStorage.getItem(PINNED_ROOM_KEY) || null; } catch { return null; }
}
/** Pin a room id to localStorage so it survives reloads. */
export function pinRoom(roomId) {
  try { localStorage.setItem(PINNED_ROOM_KEY, roomId); } catch {}
}
/** Unpin — next open will generate a fresh room. */
export function unpinRoom() {
  try { localStorage.removeItem(PINNED_ROOM_KEY); } catch {}
}

/**
 * Resolve which room id to use on open, in priority order:
 * 1. ?room= query param (explicit URL override)
 * 2. pinned room in localStorage (persistent across reloads)
 * 3. fresh random id
 */
export function resolveRoomId() {
  return readRoomFromQuery() || getPinnedRoom() || makeRoomId();
}

// ── Ingress validation ───────────────────────────────────────────────────
/**
 * Clamp/coerce an incoming value against a param spec. Returns the safe value,
 * or `undefined` if the value can't be made valid (caller drops it). This is
 * the single gate every crowd-driven param passes through before setParam.
 * @param {object} spec  a ParamSpec ({ type, min, max, step, options, ... })
 * @param {*} value
 */
export function clampToSpec(spec, value) {
  if (!spec) return undefined;
  switch (spec.type) {
    case 'range': {
      let v = Number(value);
      if (!Number.isFinite(v)) return undefined;
      const min = spec.min ?? 0, max = spec.max ?? 1;
      if (v < min) v = min; else if (v > max) v = max;
      return v;
    }
    case 'toggle':
      return !!value;
    case 'select':
      return Array.isArray(spec.options) && spec.options.includes(value)
        ? value : undefined;
    default:
      // text/file and anything else: not crowd-controllable in v1.
      return undefined;
  }
}

/** Project a full ParamSpec down to the minimal shape a participant needs to
 *  render a control. Strips anything the phone UI doesn't use. */
export function manifestParam(spec, value) {
  const m = { id: spec.id, label: spec.label || spec.id, type: spec.type };
  if (spec.type === 'range') { m.min = spec.min ?? 0; m.max = spec.max ?? 1; m.step = spec.step ?? 0.01; }
  if (spec.type === 'select') m.options = spec.options || [];
  if (value !== undefined) m.value = value;
  return m;
}
