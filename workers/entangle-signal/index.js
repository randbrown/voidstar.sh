// Entanglement signaling — Cloudflare Worker + Durable Object star relay.
//
// One Durable Object instance per room (keyed `appId:room`). Clients open a
// WebSocket to the DO, which is the hub. This is the owned, rate-limit-free
// replacement for the public Nostr relays the WebRTC transport leaned on — no
// relay rot, no per-IP "noting too much", no NAT traversal.
//
// Routing is ROLE-AWARE so fan-out stays linear, not N², for the intimate crowd
// this targets:
//   • a participant's messages  → the host(s) only
//   • the host's messages       → all participants
//   • a message with `target`   → that one peer
// The participant page never listens to peer-to-peer chatter anyway, so this
// matches the app's hub-and-spoke shape exactly while saving ~crowd× bandwidth.
//
// Wire protocol (JSON):
//   client→DO : {t:'msg', topic, data, target?}
//   DO→client : {t:'welcome', self, peers[]} | {t:'peer', id} | {t:'leave', id}
//             | {t:'msg', topic, data, from}
// Uses the WebSocket Hibernation API so idle rooms cost nothing.
//
// ── Abuse hardening (a public workers.dev URL is reachable by anyone who
// learns it; the room id is only ~50 bits and shown on stage) ──
//   • Origin allowlist on the upgrade (env.ALLOWED_ORIGINS, comma-separated;
//     default https://voidstar.sh + localhost). Browsers always send Origin;
//     a forged one still has to also know the room + host key.
//   • Host role is authenticated by a per-room HOST KEY (trust-on-first-use):
//     the first socket to claim `role=host` with a key registers it in DO
//     storage; later host claims must present the same key or are silently
//     downgraded to participant. The key lives only on the performer's device
//     (never in the QR/join URL), so a heckler who scans the QR can only ever
//     join as a participant and can't drive the projection.
//   • Same-role eviction only — a reconnect with an existing id can't close a
//     socket of the OTHER role (so a participant can't knock the host offline
//     by reusing its id).
//   • Participants may only `target` a host; hosts may target anyone.
//   • Per-message size cap + per-socket token-bucket rate limit.
//   • Unknown topics are dropped.

const KNOWN_TOPICS = new Set([
  'hello', 'manifest', 'pose', 'skeleton', 'param', 'vote',
  'phase', 'phaseprog', 'values', 'bye', 'kick',
  // Playback sync + tether remote (SYNC_APP_ID rooms — see
  // src/lib/qualia/sync-protocol.js). Same hub-and-spoke routing:
  // leader connects as role=host, followers/controllers as participants.
  'clock', 'csync', 'fhello', 'chello', 'cwelc', 'ctl', 'cstate', 'sbye',
  'rtc',   // WebRTC SDP/ICE signaling for the sync A/V feed (media is P2P)
]);

const MAX_MSG_BYTES = 16 * 1024;   // one pose/skeleton frame is well under this
const RATE_TOKENS = 120;           // burst
const RATE_REFILL_PER_SEC = 60;    // sustained messages/sec per socket

function allowedOrigin(origin, env) {
  if (!origin) return false; // browsers always send Origin on a WS upgrade
  const list = (env.ALLOWED_ORIGINS || 'https://voidstar.sh')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (list.includes(origin)) return true;
  try {
    const o = new URL(origin);
    if ((o.hostname === 'localhost' || o.hostname === '127.0.0.1')) return true;
    // Subdomains of an allowed https host (e.g. www.) are the same site.
    for (const a of list) {
      const au = new URL(a);
      if (o.protocol === 'https:' && (o.hostname === au.hostname || o.hostname.endsWith(`.${au.hostname}`))) return true;
    }
  } catch {}
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('entangle-signal: ok', { status: 200 });
    }
    const m = /^\/r\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);   // /r/<appId>/<room>
    if (!m) return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // WebSockets aren't subject to CORS, so this Origin check is the only thing
    // stopping a third-party page from opening sockets into a room.
    if (!allowedOrigin(request.headers.get('Origin'), env)) {
      return new Response('forbidden origin', { status: 403 });
    }
    const name = `${decodeURIComponent(m[1])}:${decodeURIComponent(m[2])}`;
    const stub = env.ENTANGLE_ROOM.get(env.ENTANGLE_ROOM.idFromName(name));
    return stub.fetch(request);
  },
};

export class EntangleRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buckets = new Map(); // peerId → { tokens, ts } (best-effort; per-instance)
  }

  async fetch(request) {
    const url = new URL(request.url);
    const peerId = (url.searchParams.get('id') || crypto.randomUUID()).slice(0, 64);
    const wantsHost = url.searchParams.get('role') === 'host';
    const key = url.searchParams.get('key') || '';

    // Host authentication (trust-on-first-use per room). The first host to
    // present a key claims the room; later host claims must match or are
    // downgraded to participant. A host claim with no key at all is only
    // honored when no key has been registered yet (legacy/first host).
    let role = 'participant';
    if (wantsHost) {
      const registered = await this.state.storage.get('hostKey');
      if (!registered) {
        if (key) await this.state.storage.put('hostKey', key);
        role = 'host';
      } else {
        role = (key && key === registered) ? 'host' : 'participant';
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();

    // Reconnect with the same id → evict the stale socket, but ONLY one of the
    // same role (so a participant reusing the host's id can't close the host),
    // and flag it so its close handler doesn't fire a spurious 'leave'.
    for (const old of this.state.getWebSockets(peerId)) {
      const oldAttr = old.deserializeAttachment() || {};
      if (oldAttr.role && oldAttr.role !== role) continue;
      try { old.serializeAttachment({ ...oldAttr, evicted: true }); } catch {}
      try { old.close(4001, 'replaced'); } catch {}
    }

    this.state.acceptWebSocket(server, [peerId, 'r:' + role]);
    server.serializeAttachment({ id: peerId, role });

    // participants care about hosts; hosts care about participants.
    const careTag = role === 'host' ? 'r:participant' : 'r:host';
    const peers = this.state.getWebSockets(careTag).map(s => this.idOf(s)).filter(Boolean);
    this.send(server, { t: 'welcome', self: peerId, peers });
    for (const s of this.state.getWebSockets(careTag)) this.send(s, { t: 'peer', id: peerId });

    return new Response(null, { status: 101, webSocket: client });
  }

  // Best-effort per-socket token bucket. In-memory on the DO instance, so a
  // hibernation eviction just resets it (more lenient, never blocks). Stops a
  // single socket from flooding the room; the host key stops role abuse.
  allow(peerId) {
    const now = Date.now();
    let b = this.buckets.get(peerId);
    if (!b) { b = { tokens: RATE_TOKENS, ts: now }; this.buckets.set(peerId, b); }
    b.tokens = Math.min(RATE_TOKENS, b.tokens + ((now - b.ts) / 1000) * RATE_REFILL_PER_SEC);
    b.ts = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  webSocketMessage(ws, message) {
    // Size cap first — reject an oversize frame before parsing it.
    const size = typeof message === 'string' ? message.length : (message.byteLength || 0);
    if (size > MAX_MSG_BYTES) return;
    const me = ws.deserializeAttachment() || {};
    if (!this.allow(me.id || 'anon')) return;

    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg.t !== 'msg') return;
    if (typeof msg.topic !== 'string' || !KNOWN_TOPICS.has(msg.topic)) return; // drop unknown topics

    const out = { t: 'msg', topic: msg.topic, data: msg.data, from: me.id };
    if (msg.target) {
      // A participant may only reach a host; a host may reach any peer. Keeps
      // the hub-and-spoke boundary — no participant→participant side channel.
      const targetOk = me.role === 'host'
        ? true
        : this.state.getWebSockets(msg.target).some(s => (this.state.getTags(s) || []).includes('r:host'));
      if (!targetOk) return;
      for (const s of this.state.getWebSockets(msg.target)) this.send(s, out);
      return;
    }
    const dst = me.role === 'host' ? 'r:participant' : 'r:host';
    for (const s of this.state.getWebSockets(dst)) this.send(s, out);
  }

  webSocketClose(ws) { this.gone(ws); }
  webSocketError(ws) { this.gone(ws); }

  gone(ws) {
    const me = ws.deserializeAttachment() || {};
    if (me.id) this.buckets.delete(me.id);
    if (!me.id || me.evicted) return;                 // evicted dup: the id is still live
    const careTag = me.role === 'host' ? 'r:participant' : 'r:host';
    for (const s of this.state.getWebSockets(careTag)) this.send(s, { t: 'leave', id: me.id });
  }

  idOf(s) { const t = this.state.getTags(s); return t && t.length ? t[0] : null; }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
