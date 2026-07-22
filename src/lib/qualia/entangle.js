// Entanglement — host manager (headless).
//
// Owns the audience side of a live set: the P2P room, the participant
// registry, the per-tick reduction of the whole crowd into the `crowd.*`
// modulation snapshot, the vote tally, and the moderation gates. Knows nothing
// about the DOM — entangle-ui.js drives it and paints the HUD.
//
// THE NO-LAG GUARANTEE lives here:
//  • Heavy work (camera, pose ML) runs on participants' phones, never here.
//  • Inbound messages only stamp a small per-peer record — they NEVER touch
//    the field or the render loop.
//  • The field is updated once per react-tick via reduceInto(), an O(N) pass
//    over a small intimate crowd that writes 8 scalars. No per-message,
//    per-frame, or async work on the hot path. Every handler is wrapped so a
//    malformed message can't throw into the engine.

// Owned signaling via the Cloudflare Durable Object star relay. (A Nostr/WebRTC
// transport survives in ./entangle-transport.js as RESEARCH ONLY — it predates
// the role-aware routing and ignores the `role` arg this file passes, so it is
// NOT a drop-in fallback as-is; it would need updating before it could be swapped
// back in.)
import { createTransport } from './entangle-transport-cf.js';
import { T, MODES, APP_ID, resolveRoomId, buildJoinUrl, clampToSpec, manifestParam, getPinnedRoom, pinRoom, unpinRoom, readRoomFromQuery, makeRoomId, normalizeRoomSlug, getOrCreateHostKey } from './entangle-protocol.js';
import { unpackFeatures, unpackSkeleton } from './pose-features.js';

const STALE_MS    = 9000;   // prune a peer we haven't heard from in this long
const SKEL_STALE_MS = 1200; // drop a peer's overlay skeleton if its feed pauses
const PARAM_MIN_MS = 40;    // per-peer param throttle (~25/s)
const VOTE_MIN_MS  = 200;   // per-peer vote throttle
const PHASE_MIN_MS = 600;   // per-peer phase-nudge throttle
const COUNT_FULL   = 12;    // crowd.count hits 1.0 at this many active posers
const ENERGY_SCALE = 6;     // maps mean per-frame motion → [0,1]
const ENERGY_TAU   = 0.35;  // motion EMA time constant (s)
const SWAY_TAU     = 1.2;   // crowd.sway low-pass time constant (s)
const MAX_PEERS    = 40;
const VALUE_SYNC_MS = 200;  // cadence of live base-value broadcasts to phones
const PHASE_WINDOW_MS = 4000; // distinct pushers must land within this window
const PHASE_COOLDOWN_MS = 4000; // min gap between crowd-triggered shifts
const VOTE_APPLY_MS = 5000;   // auto-switch governor: min gap between vote-driven scene changes

/**
 * @param {object} opts
 * @param {ReturnType<import('./core.js').createCore>} opts.core
 * @param {ReturnType<import('./registry.js').createMesh>} opts.mesh
 * @param {{ phaseNext?: () => void }} [opts.actions]  host-side actions the
 *        crowd can collectively trigger (e.g. advancing the auto-phase step).
 */
export function createEntangle({ core, mesh, actions = {} }) {
  /** @type {Map<string, any>} */
  const peers = new Map();          // peerId → { id, name, feat, motion, vote, lastSeen, tParam, tVote }
  let transport = null;
  let roomId = null;
  let opened = false;
  const phaseAvailable = typeof actions.phaseNext === 'function';
  const modes = { pose: true, param: true, vote: true, phase: false, skeleton: false };
  /** @type {Set<string>} param ids the crowd may drive on the active fx. */
  const whitelist = new Set();
  let swayEma = 0;
  // Live value-sync: last base values we pushed to phones (per whitelisted id).
  let lastSentValues = {};
  let valueSyncTimer = 0;
  // Crowd phase-shift: per-peer last nudge time, plus charge/cooldown state.
  let lastPhaseFireMs = 0;
  // Visual vote auto-switch: the crowd's plurality drives the active fx,
  // governed so the scene can't flip faster than VOTE_APPLY_MS. Host-toggleable.
  let autoVote = true;
  let lastVoteApplyMs = 0;
  let voteApplyTimer = 0;
  // Last reduced crowd signal — for the host's live diagnostic readout, so the
  // performer can SEE that phones' motion is actually landing (vs. just "N
  // entangled", which is only socket count). Set fresh each reduceInto.
  let lastSignal = { posing: 0, energy: 0, rise: 0, spread: 0, sway: 0, count: 0, confidence: 0 };

  // UI callbacks (set by entangle-ui). All optional.
  const cb = { peers: null, tally: null, scene: null, phase: null, autovote: null };
  const fire = (name, ...a) => { try { cb[name]?.(...a); } catch (e) { console.error('[entangle] cb', name, e); } };

  function activeFx() { return core.activeId(); }
  function activeSpecs() {
    const mod = mesh.get(activeFx());
    return mod?.params || [];
  }
  /** Does the active quale map ANY crowd.* channel? Only 6 of the qualia do;
   *  drives the host hint when the crowd is moving but the visual ignores it. */
  function activeReactsToCrowd() {
    for (const spec of activeSpecs()) {
      const mods = spec.modulators;
      if (mods) for (const m of mods) if (typeof m?.source === 'string' && m.source.startsWith('crowd.')) return true;
    }
    return false;
  }

  // ── Manifest ────────────────────────────────────────────────────────────
  function buildManifest() {
    const base = core.getBaseParams();
    const specs = activeSpecs();
    const params = [];
    if (modes.param) {
      for (const spec of specs) {
        if (!whitelist.has(spec.id)) continue;
        // Only kinds a phone can sanely drive (range/toggle/select).
        if (!['range', 'toggle', 'select'].includes(spec.type)) continue;
        params.push(manifestParam(spec, base[spec.id]));
      }
    }
    return {
      activeFx: activeFx(),
      // autoPick:false quales (null) stay off the ballot — the crowd
      // shouldn't be able to vote the screen blank.
      fxList: modes.vote ? mesh.list().filter(m => m.autoPick !== false).map(m => ({ id: m.id, name: m.name || m.id })) : [],
      // Only advertise `phase` when the host actually supplied a phaseNext.
      modes: { ...modes, phase: modes.phase && phaseAvailable },
      // Does the active quale map crowd.* → field? Lets the phone tell the
      // participant whether their movement actually drives the visual.
      crowdReacts: activeReactsToCrowd(),
      params,
    };
  }
  /** Re-send the manifest to everyone (after a scene / whitelist / mode change). */
  function broadcastManifest() {
    if (transport) transport.send(T.MANIFEST, buildManifest());
    // Force the next value-sync to re-push every value so freshly-rendered
    // phone controls immediately reflect the live scene.
    lastSentValues = {};
  }

  // ── Live value-sync — keep phone sliders tracking host / auto-phase ───────
  // Diffs the active fx's whitelisted base values against what we last sent and
  // broadcasts only the deltas. Cheap (a handful of numbers at VALUE_SYNC_MS).
  function pushValueSync() {
    if (!transport || !modes.param) return;
    const base = core.getBaseParams();
    let delta = null;
    for (const id of whitelist) {
      const v = base[id];
      if (v === undefined) continue;
      if (lastSentValues[id] !== v) { (delta ||= {})[id] = v; lastSentValues[id] = v; }
    }
    if (delta) transport.send(T.VALUES, delta);
  }

  // ── Inbound handlers (cheap; never touch the field) ───────────────────────
  function touch(peerId) {
    let p = peers.get(peerId);
    if (!p) {
      if (peers.size >= MAX_PEERS) return null;
      p = { id: peerId, name: '', feat: null, motion: 0, vote: null, lastSeen: 0, tParam: 0, tVote: 0, tPhase: 0, phaseAt: 0, skel: null, skelAt: 0 };
      peers.set(peerId, p);
      fire('peers', peers.size);
    }
    p.lastSeen = performance.now();
    return p;
  }

  function onHello(data, peerId) {
    const p = touch(peerId);
    if (!p) return;
    if (data && typeof data.name === 'string') p.name = data.name.slice(0, 24);
    // New arrival: send them the current scene directly.
    if (transport) transport.send(T.MANIFEST, buildManifest(), peerId);
  }

  function onPose(arr, peerId) {
    if (!modes.pose) return;
    const p = touch(peerId);
    if (!p || !Array.isArray(arr)) return;
    const f = unpackFeatures(arr);
    if (p.feat) {
      // Instantaneous motion = how much the tracked body moved since last msg.
      const m = Math.abs(f.headX - p.feat.headX)
              + Math.abs(f.headY - p.feat.headY)
              + Math.abs(f.wristSpread - p.feat.wristSpread);
      p.motionInst = (p.motionInst || 0) + m;   // accumulate; drained in reduceInto
    }
    p.feat = f;
  }

  function onSkeleton(arr, peerId) {
    if (!modes.skeleton) return;            // overlay off → ignore (shouldn't arrive)
    const p = touch(peerId);
    if (!p || !Array.isArray(arr)) return;
    p.skel = unpackSkeleton(arr);
    p.skelAt = performance.now();
  }

  function onParam(data, peerId) {
    if (!modes.param || !data) return;
    const p = touch(peerId);
    if (!p) return;
    const now = performance.now();
    if (now - p.tParam < PARAM_MIN_MS) return;   // per-peer throttle
    p.tParam = now;
    if (!whitelist.has(data.id)) return;          // not exposed → ignore
    const spec = activeSpecs().find(s => s.id === data.id);
    const v = clampToSpec(spec, data.value);      // clamp at ingress
    if (v === undefined) return;
    core.setParam(activeFx(), data.id, v);
  }

  function onVote(data, peerId) {
    if (!modes.vote || !data) return;
    const p = touch(peerId);
    if (!p) return;
    const now = performance.now();
    if (now - p.tVote < VOTE_MIN_MS) return;
    p.tVote = now;
    const mod = mesh.get(data.fxId);
    if (!mod || mod.autoPick === false) return;   // unknown / off-ballot fx → ignore
    p.vote = data.fxId;
    fire('tally', tally());
  }

  // ── Crowd phase-shift — a quorum of distinct pushers advances the phase ───
  function phaseCharge() {
    const now = performance.now();
    let have = 0;
    for (const p of peers.values()) if (p.phaseAt && now - p.phaseAt <= PHASE_WINDOW_MS) have++;
    // Quorum scales with the crowd: half the connected peers, at least 1.
    const need = Math.max(1, Math.ceil(peers.size * 0.5));
    return { have, need };
  }
  function onPhase(_data, peerId) {
    if (!modes.phase || !phaseAvailable) return;
    const p = touch(peerId);
    if (!p) return;
    const now = performance.now();
    if (now - (p.tPhase || 0) < PHASE_MIN_MS) return;   // per-peer throttle
    p.tPhase = now;
    p.phaseAt = now;
    const { have, need } = phaseCharge();
    if (transport) transport.send(T.PHASEPROG, { have, need });
    fire('phase', have, need);
    if (have >= need && now - lastPhaseFireMs > PHASE_COOLDOWN_MS) {
      lastPhaseFireMs = now;
      for (const q of peers.values()) q.phaseAt = 0;       // reset the charge
      try { actions.phaseNext(); } catch (e) { console.error('[entangle] phaseNext', e); }
      if (transport) transport.send(T.PHASEPROG, { have: 0, need, fired: true });
      fire('phase', 0, need, true);
    }
  }

  function dropPeer(peerId) {
    if (peers.delete(peerId)) { fire('peers', peers.size); fire('tally', tally()); }
  }

  // ── Crowd reduction — the ONLY field write, once per react-tick ───────────
  /**
   * Reduce every peer to the 8 crowd scalars, writing into `out` (= field.crowd).
   * @param {object} out  the crowd snapshot object the field references
   * @param {number} dt   seconds since last react-tick (field.reactDt)
   */
  function reduceInto(out, dt) {
    const now = performance.now();
    const kMot = dt > 0 ? 1 - Math.exp(-dt / ENERGY_TAU) : 1;
    let n = 0, sx = 0, sy = 0, sSpread = 0, sRise = 0, sEnergy = 0, sConf = 0;

    for (const [id, p] of peers) {
      if (now - p.lastSeen > STALE_MS) { peers.delete(id); fire('peers', peers.size); continue; }
      // Decay each peer's motion toward the freshly-accumulated instantaneous
      // value, then drain it so a peer that stops sending settles to 0.
      const inst = (p.motionInst || 0);
      p.motion += (inst - p.motion) * kMot;
      p.motionInst = 0;
      const f = p.feat;
      if (!modes.pose || !f || f.confidence < 0.15) continue;
      n++;
      sx += f.headX; sy += f.headY;
      sSpread += f.wristSpread;
      sRise += Math.max(0, -f.wristMidY);            // hands above center → up
      sEnergy += p.motion;
      sConf += f.confidence;
    }

    if (n > 0) {
      out.x = sx / n;
      out.y = sy / n;
      out.spread = sSpread / n;
      out.rise = Math.min(1, sRise / n);
      out.energy = Math.min(1, (sEnergy / n) * ENERGY_SCALE);
      out.confidence = sConf / n;
      out.count = Math.min(1, n / COUNT_FULL);
    } else {
      out.x = 0; out.y = 0; out.spread = 0; out.rise = 0;
      out.energy = 0; out.confidence = 0; out.count = 0;
    }
    // Sway is a slow low-pass of mean head x (settles to 0 when nobody's there).
    const kSway = dt > 0 ? 1 - Math.exp(-dt / SWAY_TAU) : 1;
    swayEma += (out.x - swayEma) * kSway;
    out.sway = swayEma;

    // Snapshot for the host diagnostic. `posing` = confidence-gated contributors
    // (NOT just connected peers), so the readout reflects who is actually moving.
    lastSignal.posing = n;
    lastSignal.energy = out.energy;
    lastSignal.rise = out.rise;
    lastSignal.spread = out.spread;
    lastSignal.sway = out.sway;
    lastSignal.count = out.count;
    lastSignal.confidence = out.confidence;
  }

  /** Snapshot of every peer's current skeleton, for the host overlay renderer.
   *  Stale feeds (a phone that paused) drop out so the overlay can fade them. */
  function getSkeletons() {
    const now = performance.now();
    const out = [];
    for (const p of peers.values()) {
      if (!p.skel || now - p.skelAt > SKEL_STALE_MS) continue;
      out.push({ id: p.id, joints: p.skel });
    }
    return out;
  }

  // ── Vote tally ────────────────────────────────────────────────────────────
  function tally() {
    const counts = new Map();
    for (const p of peers.values()) if (p.vote) counts.set(p.vote, (counts.get(p.vote) || 0) + 1);
    const out = [];
    for (const [fxId, count] of counts) {
      out.push({ fxId, name: mesh.get(fxId)?.name || fxId, count });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }
  /** Apply the current winning vote (host one-tap). Returns the fx id or null. */
  function applyWinningVote() {
    const t = tally();
    if (!t.length) return null;
    lastVoteApplyMs = performance.now();   // share the governor with auto-switch
    core.setActive(t[0].fxId).catch(err => console.error('[entangle] setActive', err));
    return t[0].fxId;
  }
  /** Auto-switch governor (polled). Drives the active fx from the crowd's
   *  plurality, but no more often than VOTE_APPLY_MS, and only when a challenger
   *  STRICTLY beats the current scene — a tie leaves it be, so it won't
   *  flip-flop. Polled (not vote-triggered) so a winner that emerged during the
   *  cooldown still applies the moment the cooldown clears. */
  function autoApplyVote() {
    if (!autoVote || !modes.vote || !transport) return;
    const now = performance.now();
    if (now - lastVoteApplyMs < VOTE_APPLY_MS) return;
    const t = tally();
    if (!t.length) return;
    const top = t[0];
    const cur = activeFx();
    if (top.fxId === cur) return;                          // already on the leader
    const curVotes = t.find(x => x.fxId === cur)?.count || 0;
    if (top.count <= curVotes) return;                     // must beat the active scene
    lastVoteApplyMs = now;
    core.setActive(top.fxId).catch(err => console.error('[entangle] auto-vote', err));
    fire('autovote', top.fxId, top.name);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  async function open() {
    if (opened) return { roomId, joinUrl: buildJoinUrl(roomId) };
    roomId = resolveRoomId();
    // Seed the whitelist with a couple of safe range params from the active fx
    // so the crowd has something to touch immediately (host can edit).
    if (whitelist.size === 0) {
      for (const s of activeSpecs()) {
        if (s.type === 'range' && s.id !== 'reactivity' && s.id !== 'poseReactivity') {
          whitelist.add(s.id);
          if (whitelist.size >= 3) break;
        }
      }
    }
    // Host key authenticates this device as the room's host to the signaling
    // Worker; it stays on this device and never rides the QR/join URL.
    transport = await createTransport({ appId: APP_ID, room: roomId, role: 'host', key: getOrCreateHostKey(roomId) });
    transport.on(T.HELLO, (d, id) => { try { onHello(d, id); } catch (e) { console.error(e); } });
    transport.on(T.POSE,  (d, id) => { try { onPose(d, id);  } catch (e) { console.error(e); } });
    transport.on(T.SKELETON, (d, id) => { try { onSkeleton(d, id); } catch (e) { console.error(e); } });
    transport.on(T.PARAM, (d, id) => { try { onParam(d, id); } catch (e) { console.error(e); } });
    transport.on(T.VOTE,  (d, id) => { try { onVote(d, id);  } catch (e) { console.error(e); } });
    transport.on(T.PHASE, (d, id) => { try { onPhase(d, id); } catch (e) { console.error(e); } });
    transport.on(T.BYE,   (_d, id) => dropPeer(id));
    transport.onPeer((id) => { broadcastManifest(); });   // (re)send scene on connect
    transport.onLeave((id) => dropPeer(id));
    valueSyncTimer = setInterval(() => { try { pushValueSync(); } catch {} }, VALUE_SYNC_MS);
    voteApplyTimer = setInterval(() => { try { autoApplyVote(); } catch {} }, 1000);
    opened = true;
    return { roomId, joinUrl: buildJoinUrl(roomId) };
  }

  // ── Performance code (pre-print + reuse) ──────────────────────────────────
  // The room id a NEXT open() would resolve to, WITHOUT generating one: a
  // ?room= URL override, or a code saved on this device. Lets the host preview /
  // download / print a QR before the field is live, then open into the very same
  // code on stage (and again for the next set). null ⇒ nothing chosen yet.
  function preparedRoomId() {
    if (opened && roomId) return roomId;
    return readRoomFromQuery() || getPinnedRoom() || null;
  }

  function close() {
    if (valueSyncTimer) { clearInterval(valueSyncTimer); valueSyncTimer = 0; }
    if (voteApplyTimer) { clearInterval(voteApplyTimer); voteApplyTimer = 0; }
    if (transport) { try { transport.send(T.KICK, { id: '*' }); } catch {} transport.close(); transport = null; }
    peers.clear();
    swayEma = 0;
    lastSentValues = {};
    opened = false;
    fire('peers', 0);
    fire('tally', []);
  }

  return {
    open, close,
    isOpen: () => opened,
    getRoomId: () => roomId,
    getJoinUrl: () => (roomId ? buildJoinUrl(roomId) : null),
    reduceInto,
    broadcastManifest,
    // moderation
    getModes: () => ({ ...modes }),
    setMode(mode, on) {
      if (!MODES.includes(mode)) return;
      modes[mode] = !!on;
      // The skeleton overlay rides the phone camera that 'pose' turns on, so
      // keep them coherent: enabling skeleton forces pose on; turning pose off
      // also drops skeleton (no camera ⇒ no joints).
      if (mode === 'skeleton' && modes.skeleton) modes.pose = true;
      if (mode === 'pose' && !modes.pose) modes.skeleton = false;
      broadcastManifest();
    },
    getWhitelist: () => [...whitelist],
    toggleWhitelist(id) { whitelist.has(id) ? whitelist.delete(id) : whitelist.add(id); broadcastManifest(); },
    getSpecs: activeSpecs,
    // votes
    tally,
    applyWinningVote,
    getAutoVote: () => autoVote,
    setAutoVote(on) { autoVote = !!on; if (autoVote) lastVoteApplyMs = 0; },  // re-enable → allow an immediate apply
    // phase
    phaseAvailable,
    phaseCharge,
    // counts + event hooks
    peerCount: () => peers.size,
    getCrowdSignal: () => ({ ...lastSignal }),
    getSkeletons,
    activeReactsToCrowd,
    isPinned: () => !!getPinnedRoom(),
    pinRoom()  { if (roomId) pinRoom(roomId); },
    unpinRoom() { unpinRoom(); },
    // Performance code — pre-print + reuse across sets.
    getPreparedRoomId: preparedRoomId,
    getPreparedJoinUrl: (origin) => { const r = preparedRoomId(); return r ? buildJoinUrl(r, origin) : null; },
    isRoomFromUrl: () => !!readRoomFromQuery(),   // ?room= override locks the code
    /** Set a custom, memorable performance code and save it for reuse. Returns
     *  the normalized id, or null if it normalized to nothing. Applies on the
     *  next open() — collapse the field first to change a live code. */
    setRoom(slug) { const id = normalizeRoomSlug(slug); if (!id) return null; pinRoom(id); return id; },
    /** Roll a fresh random performance code and save it for reuse. */
    newRoom() { const id = makeRoomId(); pinRoom(id); return id; },
    onPeersChange(fn) { cb.peers = fn; },
    onTallyChange(fn) { cb.tally = fn; },
    onPhaseCharge(fn) { cb.phase = fn; },
    onAutoVote(fn) { cb.autovote = fn; },
  };
}
