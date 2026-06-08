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
    const name = `${decodeURIComponent(m[1])}:${decodeURIComponent(m[2])}`;
    const stub = env.ENTANGLE_ROOM.get(env.ENTANGLE_ROOM.idFromName(name));
    return stub.fetch(request);
  },
};

export class EntangleRoom {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    const peerId = (url.searchParams.get('id') || crypto.randomUUID()).slice(0, 64);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'participant';

    const { 0: client, 1: server } = new WebSocketPair();

    // Reconnect with the same id → evict the stale socket, but flag it so its
    // close handler doesn't fire a spurious 'leave' for an id that just rejoined.
    for (const old of this.state.getWebSockets(peerId)) {
      try { old.serializeAttachment({ ...(old.deserializeAttachment() || {}), evicted: true }); } catch {}
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

  webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg.t !== 'msg') return;
    const me = ws.deserializeAttachment() || {};
    const out = { t: 'msg', topic: msg.topic, data: msg.data, from: me.id };
    if (msg.target) {
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
    if (!me.id || me.evicted) return;                 // evicted dup: the id is still live
    const careTag = me.role === 'host' ? 'r:participant' : 'r:host';
    for (const s of this.state.getWebSockets(careTag)) this.send(s, { t: 'leave', id: me.id });
  }

  idOf(s) { const t = this.state.getTags(s); return t && t.length ? t[0] : null; }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
