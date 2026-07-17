// Playback sync + spooky controller — the wire contract shared by the leader
// (sync.js on the host rig), follower rigs (sync.js in follower mode) and the
// phone controller (spooky-client.js). No DOM, no transport: constants,
// message shapes, and the ingress validators that keep remote control safe.
//
// Rides the SAME Cloudflare DO relay as entanglement (workers/entangle-signal)
// but in its OWN room namespace (SYNC_APP_ID), so a performance's sync room
// never mixes with its audience room. Roles map onto the relay's existing
// hub-and-spoke routing with zero server-side routing changes:
//   • leader     = relay role 'host'   (authenticated by the per-room key)
//   • follower   = relay role 'participant' (receives clock, sends csync)
//   • controller = relay role 'participant' (sends ctl, authenticated by the
//                  CONTROL TOKEN — see below)
//
// Security model, mirroring entangle-protocol.js:
//   • The leader key (relay TOFU host key) lives only on the leader device.
//   • The CONTROL TOKEN gates who may DRIVE the rig. It's minted per room on
//     the leader, embedded ONLY in the spooky QR / link the performer scans
//     themself (URL fragment — never sent to the server), and checked on every
//     ctl/chello message. A follower or audience phone without it can listen
//     to the clock but can't touch the rig.
//   • Every ctl payload is validated against the action/slider allowlists
//     below and clamped before it reaches the engine. Nothing is eval'd.

export const SYNC_APP_ID = 'voidstar-sync-v1';
export const CONTROLLER_PATH = '/lab/spooky';   // phone controller page route

// Relay topics (keep ≤ 12 chars — same constraint as entangle topics).
export const ST = {
  CLOCK:  'clock',   // leader → all: {cps, pos, tw, playing, n} cycle-clock beacon
  CSYNC:  'csync',   // follower/controller → leader: {t1}; leader → (targeted) {t1,t2,t3}
  FHELLO: 'fhello',  // follower → leader: {name?} I'm a follower rig
  CHELLO: 'chello',  // controller → leader: {k, name?} request to drive
  CWELC:  'cwelc',   // leader → (targeted) controller: {ok, why?} + first state
  CTL:    'ctl',     // controller → leader: {k, a?|s?/v?|hit?/g?/w?} action/slider/tap
  CSTATE: 'cstate',  // leader → all: controller state snapshot (small JSON)
  SBYE:   'sbye',    // any → counterpart: leaving (best-effort)
};

// ── Controller ACTION allowlist ─────────────────────────────────────────────
// Mirrors the DOIO pad's action surface (padActions in page-init.js) — one
// shared dispatch map, three input paths (keystrokes, MIDI, spooky), no drift.
// Every id here must exist in the actions map handed to createSync; unknown or
// un-listed ids are dropped at ingress.
export const CTL_ACTIONS = new Set([
  // rig drives + strip toggles
  'tuner', 'earth', 'metal', 'delayToggle', 'reverbToggle',
  // freeze stack (Frippertronics)
  'freeze', 'freezePop', 'freezeRegrab', 'freezeClear',
  // looper transport
  'loopPlayStop', 'recStart', 'recStop', 'grab',
  // strudel + sequencer transport
  'strudelPlayStop', 'seqPlayStop',
  // vox + global transport
  'voxMute', 'pause', 'blackout',
  // quale / phase navigation + camera
  'qualePrev', 'qualeNext', 'phasePrev', 'phaseNext', 'camNext',
]);

// ── Controller SLIDER allowlist ─────────────────────────────────────────────
// id → {min, max} clamp range. The host maps ids onto the owning module
// (looper strip, rig master, tempo) in its applySlider dispatch.
export const CTL_SLIDERS = {
  'rig.level':  { min: 0,    max: 1.5 },
  'delay.mix':  { min: 0,    max: 1 },
  'reverb.mix': { min: 0,    max: 1 },
  'seq.volume': { min: 0,    max: 1.5 },
  'cps':        { min: 0.05, max: 4 },
};

/** Clamp a controller slider value against its allowlisted range.
 *  Returns the safe number, or undefined if the id is unknown / value bad. */
export function clampCtlSlider(id, value) {
  const spec = CTL_SLIDERS[id];
  if (!spec) return undefined;
  const v = Number(value);
  if (!Number.isFinite(v)) return undefined;
  return Math.min(spec.max, Math.max(spec.min, v));
}

/** Validate a drum-pad tap payload {hit, g?, w?}. Returns a safe copy or null. */
export function clampCtlTap(msg) {
  if (!msg || typeof msg.hit !== 'string' || !msg.hit || msg.hit.length > 24) return null;
  const g = Number(msg.g);
  return {
    voice: msg.hit,
    gain:  Number.isFinite(g) ? Math.min(1.5, Math.max(0, g)) : 1,
    write: !!msg.w,
  };
}

// ── Room ids / persistence (parallel to entangle-protocol, own storage) ─────
const PINNED_ROOM_KEY = 'voidstar.sync.pinnedRoom';
const LEADER_KEYS_KEY = 'voidstar.sync.leaderKeys';
const CTL_TOKENS_KEY  = 'voidstar.sync.ctlTokens';

const ROOM_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export function makeSyncRoomId(len = 10) {
  const a = new Uint8Array(len);
  (globalThis.crypto || crypto).getRandomValues(a);
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET[a[i] & 31];
  return s;
}

/** Normalize a performer-typed room code (same rules as entangle rooms). */
export function normalizeSyncRoomSlug(s, max = 32) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

export function getPinnedSyncRoom() {
  try { return localStorage.getItem(PINNED_ROOM_KEY) || null; } catch { return null; }
}
export function pinSyncRoom(roomId) {
  try { localStorage.setItem(PINNED_ROOM_KEY, roomId); } catch {}
}
export function unpinSyncRoom() {
  try { localStorage.removeItem(PINNED_ROOM_KEY); } catch {}
}

function getOrCreateMapped(storageKey, roomId, bytes) {
  if (!roomId) return '';
  let map = {};
  try { map = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch {}
  if (!map[roomId]) {
    const a = new Uint8Array(bytes);
    (globalThis.crypto || crypto).getRandomValues(a);
    map[roomId] = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch {}
  }
  return map[roomId];
}

/** Per-room LEADER KEY — authenticates this device as the sync room's leader
 *  to the signaling Worker (trust-on-first-use, exactly like the entangle host
 *  key). Lives only on the leader device; never in any QR or join link. */
export function getOrCreateLeaderKey(roomId) {
  return getOrCreateMapped(LEADER_KEYS_KEY, roomId, 24);
}

/** Per-room CONTROL TOKEN — the shareable "may drive the rig" credential. It
 *  IS put in the spooky QR/link (URL fragment only, so it never hits the
 *  server), because the performer shows that QR to their own phone, not the
 *  crowd. Rotate by unpinning the room (fresh room = fresh token). */
export function getOrCreateControlToken(roomId) {
  return getOrCreateMapped(CTL_TOKENS_KEY, roomId, 16);
}

/** Build the spooky controller URL the private QR encodes. */
export function buildControllerUrl(roomId, token, origin = location.origin) {
  return `${origin}${CONTROLLER_PATH}#r=${encodeURIComponent(roomId)}&k=${encodeURIComponent(token)}`;
}

/** Build the follower join URL (a second rig opens /qualia with this). */
export function buildFollowerUrl(roomId, origin = location.origin) {
  return `${origin}/qualia?syncroom=${encodeURIComponent(roomId)}`;
}

/** Read {room, key} the controller page was opened with. */
export function readControlFromHash(hash = location.hash) {
  const r = /[#&]r=([^&]+)/.exec(hash || '');
  const k = /[#&]k=([^&]+)/.exec(hash || '');
  return { room: r ? decodeURIComponent(r[1]) : null, key: k ? decodeURIComponent(k[1]) : null };
}

/** Read a ?syncroom= query param from the host page URL (follower auto-join). */
export function readSyncRoomFromQuery(search = location.search) {
  const m = /[?&]syncroom=([^&]+)/.exec(search || '');
  return m ? decodeURIComponent(m[1]) : null;
}

// ── Clock math (shared by leader + follower) ────────────────────────────────
// The beacon carries the leader's audible cycle position `pos` (absolute
// cycles, float), its `cps`, and `tw` — the leader's performance.now() at the
// moment `pos` was sampled. A follower with an estimated clock offset
// (leaderNow ≈ perfNow + offsetMs) can project the leader's position at any
// local time. AudioContext.currentTime is NOT portable across devices, which
// is why the beacon is stamped with the monotonic wall clock instead.

/** Project the leader's cycle position at the follower's `perfNowMs`,
 *  given the last beacon and the estimated clock offset (ms). */
export function projectLeaderPos(beacon, offsetMs, perfNowMs) {
  if (!beacon || typeof beacon.pos !== 'number' || !(beacon.cps > 0)) return null;
  const leaderNow = perfNowMs + offsetMs;
  return beacon.pos + beacon.cps * ((leaderNow - beacon.tw) / 1000);
}

/** NTP-style offset/rtt from one csync round trip.
 *  t1: follower send, t2: leader receive, t3: leader send, t4: follower receive
 *  (all in each device's own performance.now() ms). */
export function csyncSample(t1, t2, t3, t4) {
  return {
    offsetMs: ((t2 - t1) + (t3 - t4)) / 2,   // leaderClock − followerClock
    rttMs:    (t4 - t1) - (t3 - t2),
  };
}

/** Combine csync samples into one offset estimate: keep the lowest-RTT half
 *  (those bracket the true offset tightest — asymmetric delay lives in the
 *  slow tail), then take their median offset. Returns {offsetMs, rttMs,
 *  samples} or null if there's nothing usable yet. */
export function estimateOffset(samples) {
  const ok = samples.filter(s => s && Number.isFinite(s.offsetMs) && Number.isFinite(s.rttMs) && s.rttMs >= 0);
  if (!ok.length) return null;
  const byRtt = [...ok].sort((a, b) => a.rttMs - b.rttMs);
  const best = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 2)));
  const offs = best.map(s => s.offsetMs).sort((a, b) => a - b);
  const mid = offs.length >> 1;
  const median = offs.length % 2 ? offs[mid] : (offs[mid - 1] + offs[mid]) / 2;
  return { offsetMs: median, rttMs: best[0].rttMs, samples: ok.length };
}
