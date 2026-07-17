// Playback sync — cross-device cycle/CPS lock + spooky controller ingress.
//
// createSync(deps) is a headless engine (no DOM — sync-ui.js owns that) with
// three jobs, all riding one relay room (SYNC_APP_ID, workers/entangle-signal):
//
//   LEADER   — owns the tempo. Broadcasts a cycle-clock beacon {cps, pos, tw}
//              (tw = performance.now() at sample time), answers csync pings
//              (NTP-style), accepts token-authenticated controller input and
//              dispatches it through the SAME action map the DOIO pad uses.
//   FOLLOWER — estimates the clock offset to the leader (median of the
//              lowest-RTT half of csync samples — network latency cancels),
//              projects the leader's audible cycle position into local time,
//              and locks Strudel to it: a hard setCyclePos jump for the
//              initial lock / big errors, then a micro-setCps slew (a soft
//              phase-locked loop) that converges without audible artifacts.
//              Because the sequencer and looper already phase-lock to the
//              local Strudel grid, they inherit the lock for free.
//   CONTROLLER ingress — validated by the per-room control token, the action/
//              slider allowlists in sync-protocol.js, and a per-peer rate
//              bucket. Nothing is ever eval'd.
//
// The clock's ground truth is per-device AudioContext time, which is NOT
// portable — the beacon is therefore stamped with the monotonic wall clock
// (performance.now) and each side subtracts its own output latency, so what
// actually aligns is what leaves the speakers.

import { createTransport } from './entangle-transport-cf.js';
import { createSyncAV } from './sync-av.js';
import {
  SYNC_APP_ID, ST, CTL_ACTIONS, clampCtlSlider, clampCtlTap,
  getOrCreateLeaderKey, getOrCreateControlToken,
  projectLeaderPos, csyncSample, estimateOffset,
} from './sync-protocol.js';

const BEACON_MS        = 1500;   // leader heartbeat (cps changes also fire one immediately)
const CSTATE_MS        = 1000;   // controller state snapshot cadence (only when controllers exist)
const CORRECT_MS       = 400;    // follower correction loop
const PING_BURST       = 8;      // initial csync burst…
const PING_BURST_MS    = 300;    // …spacing, then
const PING_STEADY_MS   = 5000;   // steady-state re-ping (drift + thermal clock skew)
const MAX_SAMPLES      = 24;     // rolling csync window
const HARD_ERR_MS      = 120;    // above this, hard-jump the cycle position
const SOFT_ERR_MS      = 4;      // deadband — inside this we're locked
const MAX_SLEW         = 0.04;   // max ±cps fraction during a slew
const CTL_RATE_TOKENS  = 60;     // controller per-peer burst (drum rolls are real)
const CTL_RATE_REFILL  = 30;     // sustained msgs/sec per controller

export function createSync(deps = {}) {
  const clock = deps.clock || {};
  const noop = () => {};
  const onStatus = typeof deps.onStatus === 'function' ? deps.onStatus : noop;

  let transport = null;
  let role = 'off';              // 'off' | 'leader' | 'follower'
  let roomId = null;
  let ctlToken = '';
  let trimMs = +deps.trimMs || 0;         // by-ear fine alignment (persisted by UI)
  let followTransport = deps.followTransport !== false;

  const followers = new Set();   // leader: follower peer ids
  const controllers = new Set(); // leader: authenticated controller peer ids
  const ctlBuckets = new Map();  // leader: peerId → {tokens, ts}
  let timers = [];
  let unsubs = [];

  // Follower clock state
  let samples = [];              // csync {offsetMs, rttMs}
  let estimate = null;           // {offsetMs, rttMs, samples}
  let beacon = null;             // last {cps, pos, tw, playing} (pos speaker-corrected)
  let slewing = false;
  let lastHardJump = 0;

  const status = {
    role: 'off', room: null, peers: 0, followers: 0, controllers: 0,
    offsetMs: null, rttMs: null, errMs: null, locked: false, playing: false,
    av: null,
  };
  function pushStatus(patch) {
    Object.assign(status, patch);
    status.peers = transport ? transport.peers().length : 0;
    status.followers = followers.size;
    status.controllers = controllers.size;
    status.av = av ? av.getStatus() : null;
    try { onStatus({ ...status }); } catch {}
  }

  // ── A/V feed layer (optional — page-init passes the canvas/mix hooks) ────
  // Media is peer-to-peer; only SDP/ICE rides the relay. sendRtc closes over
  // the live `transport` so it follows role changes automatically.
  const av = deps.av ? createSyncAV({
    ...deps.av,
    sendRtc: (d, target) => { try { transport?.send(ST.RTC, d, target); } catch {} },
    onStatus: () => pushStatus({}),
  }) : null;

  function every(ms, fn) { const id = setInterval(fn, ms); timers.push(id); return id; }
  function later(ms, fn) { const id = setTimeout(fn, ms); timers.push(id); return id; }

  // ── Leader ────────────────────────────────────────────────────────────────
  let beaconSeq = 0, beaconSoonTimer = null;

  function buildBeacon() {
    let clk = null;
    try { clk = clock.get?.(); } catch {}
    if (!clk) return null;
    // Report the position as heard AT THE SPEAKERS: audible pos minus this
    // device's output-latency worth of cycles. The follower does the same on
    // its side, so DAC-path differences between machines cancel out.
    const pos = (typeof clk.pos === 'number')
      ? clk.pos - (clk.outSec || 0) * clk.cps
      : null;
    return { cps: clk.cps, pos, tw: performance.now(), playing: !!clk.playing, n: ++beaconSeq };
  }
  function sendBeacon() {
    const b = buildBeacon();
    if (!b || !transport) return;
    try { transport.send(ST.CLOCK, b); } catch {}
    pushStatus({ playing: b.playing });
  }
  // cps changes / transport flips beacon immediately (debounced a tick so a
  // setCps ramp doesn't flood the room).
  function beaconSoon() {
    if (role !== 'leader' || beaconSoonTimer) return;
    beaconSoonTimer = setTimeout(() => { beaconSoonTimer = null; sendBeacon(); }, 50);
  }

  function ctlAllow(peerId) {
    const now = performance.now();
    let b = ctlBuckets.get(peerId);
    if (!b) { b = { tokens: CTL_RATE_TOKENS, ts: now }; ctlBuckets.set(peerId, b); }
    b.tokens = Math.min(CTL_RATE_TOKENS, b.tokens + ((now - b.ts) / 1000) * CTL_RATE_REFILL);
    b.ts = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function handleCtl(msg, from) {
    if (!msg || msg.k !== ctlToken || !controllers.has(from)) return;
    if (!ctlAllow(from)) return;
    try {
      if (typeof msg.a === 'string') {
        // Momentary action — the DOIO surface, one more input path.
        if (CTL_ACTIONS.has(msg.a)) deps.actions?.[msg.a]?.();
        return;
      }
      if (typeof msg.s === 'string') {
        const v = clampCtlSlider(msg.s, msg.v);
        if (v !== undefined) deps.applySlider?.(msg.s, v);
        return;
      }
      if (typeof msg.hit === 'string') {
        const tap = clampCtlTap(msg);
        if (tap) deps.seqTap?.(tap.voice, tap.gain, tap.write);
      }
    } catch (e) { console.warn('[sync] ctl dispatch failed:', e); }
  }

  function sendCtlState(target) {
    if (!transport) return;
    let state = null;
    try { state = deps.getCtlState?.() || null; } catch {}
    if (!state) return;
    try { transport.send(ST.CSTATE, state, target); } catch {}
  }

  async function startLeader(room) {
    stop();
    role = 'leader';
    roomId = room;
    ctlToken = getOrCreateControlToken(room);
    transport = await createTransport({
      appId: SYNC_APP_ID, room, role: 'host', key: getOrCreateLeaderKey(room),
    });
    av?.setRole('leader');
    transport.onPeer(() => { later(120, sendBeacon); pushStatus({}); });
    transport.onLeave((id) => {
      followers.delete(id); controllers.delete(id); ctlBuckets.delete(id);
      av?.dropPeer(id);
      pushStatus({});
    });
    unsubs.push(transport.on(ST.RTC, (d, from) => av?.handleRtc(d, from)));
    unsubs.push(transport.on(ST.CSYNC, (data, from) => {
      // NTP pong — reply instantly, targeted. t2 (receive) and t3 (send) are
      // the same read; sub-ms apart in practice.
      if (!data || typeof data.t1 !== 'number') return;
      const t = performance.now();
      try { transport.send(ST.CSYNC, { t1: data.t1, t2: t, t3: t }, from); } catch {}
    }));
    unsubs.push(transport.on(ST.FHELLO, (_d, from) => { followers.add(from); pushStatus({}); }));
    unsubs.push(transport.on(ST.CHELLO, (data, from) => {
      const ok = !!data && data.k === ctlToken;
      if (ok) controllers.add(from);
      try { transport.send(ST.CWELC, { ok }, from); } catch {}
      if (ok) { sendCtlState(from); later(120, sendBeacon); }
      pushStatus({});
    }));
    unsubs.push(transport.on(ST.CTL, handleCtl));
    unsubs.push(transport.on(ST.SBYE, (_d, from) => {
      followers.delete(from); controllers.delete(from); pushStatus({});
    }));
    every(BEACON_MS, sendBeacon);
    every(CSTATE_MS, () => { if (controllers.size) sendCtlState(); });
    pushStatus({ role, room, locked: true, offsetMs: null, rttMs: null, errMs: null });
  }

  // ── Follower ──────────────────────────────────────────────────────────────
  function ping() {
    if (!transport) return;
    try { transport.send(ST.CSYNC, { t1: performance.now() }); } catch {}
  }

  function correct() {
    if (role !== 'follower') return;
    estimate = estimateOffset(samples);
    if (!estimate || !beacon) { pushStatus({ locked: false }); return; }

    let clk = null;
    try { clk = clock.get?.(); } catch {}
    const localPlaying = !!clk?.playing;

    // Transport follow: mirror the leader's play/stop (best-effort — the
    // follower still needs its own pattern in the editor to make sound).
    if (followTransport && beacon.playing !== localPlaying) {
      try { beacon.playing ? clock.play?.() : clock.stop?.(); } catch {}
      pushStatus({ playing: beacon.playing, locked: false });
      return;                     // re-probe next tick once transport settles
    }
    if (!beacon.playing || !localPlaying || clk?.pos == null) {
      pushStatus({ offsetMs: estimate.offsetMs, rttMs: estimate.rttMs, errMs: null, locked: false, playing: localPlaying });
      return;
    }

    // Where is the leader (at the speakers) *right now*, in cycles?
    const target = projectLeaderPos(beacon, estimate.offsetMs + trimMs, performance.now());
    if (target == null) return;
    const localSpeakerPos = clk.pos - (clk.outSec || 0) * clk.cps;
    const err = target - localSpeakerPos;              // cycles (absolute — integer cycles count)
    const errMs = (err / beacon.cps) * 1000;

    if (Math.abs(errMs) > HARD_ERR_MS) {
      // Initial lock or a real divergence: exact tempo + hard jump. Rate-limit
      // hard jumps so a flaky probe can't stutter the pattern.
      const now = performance.now();
      if (now - lastHardJump > 2000) {
        lastHardJump = now;
        try { clock.setCps?.(beacon.cps); } catch {}
        let jumped = false;
        try {
          // setCyclePos takes the scheduler-audible position — add back this
          // device's output latency so the SPEAKER lands on target.
          jumped = !!clock.setCyclePos?.(target + (clk.outSec || 0) * beacon.cps);
        } catch {}
        if (!jumped) slewing = true;   // no jump path in this build — slew it
      }
      pushStatus({ offsetMs: estimate.offsetMs, rttMs: estimate.rttMs, errMs, locked: false, playing: true });
      return;
    }

    if (Math.abs(errMs) > SOFT_ERR_MS) {
      // Soft PLL: chase the phase with a bounded tempo skew. err>0 means
      // we're behind the leader → run momentarily faster.
      const rate = Math.max(-MAX_SLEW, Math.min(MAX_SLEW, err * 1.5));
      try { clock.setCps?.(beacon.cps * (1 + rate)); } catch {}
      slewing = true;
      pushStatus({ offsetMs: estimate.offsetMs, rttMs: estimate.rttMs, errMs, locked: false, playing: true });
      return;
    }

    // In the deadband — settle on the exact leader tempo once, then hold.
    if (slewing || Math.abs((clk.cps || 0) - beacon.cps) > 1e-9) {
      try { clock.setCps?.(beacon.cps); } catch {}
      slewing = false;
    }
    pushStatus({ offsetMs: estimate.offsetMs, rttMs: estimate.rttMs, errMs, locked: true, playing: true });
  }

  async function startFollower(room) {
    stop();
    role = 'follower';
    roomId = room;
    samples = []; estimate = null; beacon = null; slewing = false;
    transport = await createTransport({ appId: SYNC_APP_ID, room, role: 'participant' });
    av?.setRole('follower');
    const hello = () => { try { transport.send(ST.FHELLO, { }); } catch {} };
    transport.onPeer(() => {
      hello();
      // Fresh leader (or reconnect) → re-measure the offset from scratch,
      // and re-offer the A/V feed if it's armed.
      samples = [];
      for (let i = 0; i < PING_BURST; i++) later(i * PING_BURST_MS, ping);
      av?.onLeaderSeen();
      pushStatus({});
    });
    unsubs.push(transport.on(ST.RTC, (d, from) => av?.handleRtc(d, from)));
    transport.onLeave(() => { pushStatus({}); });
    unsubs.push(transport.on(ST.CSYNC, (data) => {
      if (!data || typeof data.t1 !== 'number' || typeof data.t2 !== 'number' || typeof data.t3 !== 'number') return;
      const s = csyncSample(data.t1, data.t2, data.t3, performance.now());
      // An RTT beyond ~2s is a stalled socket, not a measurement.
      if (!(s.rttMs >= 0) || s.rttMs > 2000) return;
      samples.push(s);
      if (samples.length > MAX_SAMPLES) samples.shift();
    }));
    unsubs.push(transport.on(ST.CLOCK, (b) => {
      if (!b || typeof b.tw !== 'number' || !(b.cps > 0)) return;
      if (beacon && typeof b.n === 'number' && typeof beacon.n === 'number' && b.n <= beacon.n) return;
      beacon = b;
    }));
    hello();
    every(PING_STEADY_MS, ping);
    every(CORRECT_MS, correct);
    pushStatus({ role, room, locked: false });
  }

  // ── Shared ────────────────────────────────────────────────────────────────
  function stop() {
    av?.stop();
    for (const id of timers) { clearTimeout(id); clearInterval(id); }
    timers = [];
    if (beaconSoonTimer) { clearTimeout(beaconSoonTimer); beaconSoonTimer = null; }
    for (const un of unsubs) { try { un(); } catch {} }
    unsubs = [];
    if (transport) {
      try { transport.send(ST.SBYE, 1); } catch {}
      try { transport.close(); } catch {}
    }
    transport = null;
    followers.clear(); controllers.clear(); ctlBuckets.clear();
    samples = []; estimate = null; beacon = null; slewing = false;
    role = 'off'; roomId = null; ctlToken = '';
    pushStatus({ role: 'off', room: null, offsetMs: null, rttMs: null, errMs: null, locked: false, playing: false });
  }

  return {
    startLeader,
    startFollower,
    stop,
    getRole:   () => role,
    getRoomId: () => roomId,
    getStatus: () => ({ ...status }),
    /** Leader: nudge an immediate beacon after a local cps / transport change. */
    notifyCpsChanged: beaconSoon,
    notifyTransport:  beaconSoon,
    /** Leader: push a controller state snapshot now (e.g. after a local UI change). */
    pushCtlState: () => { if (role === 'leader' && controllers.size) sendCtlState(); },
    setTrimMs: (ms) => { trimMs = Number.isFinite(+ms) ? Math.max(-500, Math.min(500, +ms)) : 0; },
    getTrimMs: () => trimMs,
    setFollowTransport: (on) => { followTransport = !!on; },
    getFollowTransport: () => followTransport,
    /** The A/V feed layer (null when page-init passed no av hooks). */
    getAV: () => av,
  };
}
