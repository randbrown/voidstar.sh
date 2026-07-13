// Entanglement transport — Cloudflare Durable Object star relay (WebSocket).
//
// A drop-in for entangle-transport.js (the Nostr/WebRTC seam): SAME interface,
// so host (entangle.js) and participant (entangle-client.js) code is unchanged.
// Owned signaling — no public relays, so no rate limits ("noting too much"), no
// relay rot, and no WebRTC/STUN/TURN NAT traversal. Server: workers/entangle-signal.
//
//   const t = await createTransport({ appId, room, role });   // role: 'host' | 'participant'
//   t.onPeer(fn); t.onLeave(fn); t.on(topic, fn); t.send(topic, data, target?);
//   t.peers(); t.selfId; t.close();
//
// Resolves immediately (the socket connects in the background, like joinRoom),
// so callers can register onPeer before the first peer arrives. Auto-reconnects
// with backoff for flaky venue wifi.

// Where the signaling Worker lives. Local dev hits `wrangler dev` on :8787;
// prod uses the deployed Worker. Point this at your custom domain or the
// *.workers.dev URL once deployed.
const SIGNAL_URL = (() => {
  const h = typeof location !== 'undefined' ? location.hostname : '';
  if (h === 'localhost' || h === '127.0.0.1') return `ws://${h}:8787`;   // `wrangler dev`
  return 'wss://voidstar-entangle-signal.brown-randy.workers.dev';        // deployed Worker
})();

function makeId(len = 16) {
  const a = new Uint8Array(len);
  (globalThis.crypto || crypto).getRandomValues(a);
  let s = '';
  for (let i = 0; i < len; i++) s += (a[i] % 36).toString(36);
  return s;
}

/**
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.room
 * @param {'host'|'participant'} [opts.role]  routing role (default participant)
 * @param {string} [opts.key]  host key — authenticates a `host` role to the
 *   signaling Worker (ignored for participants). Never sent by the phone page.
 * @returns {Promise<object>} the transport interface
 */
export async function createTransport({ appId, room, role = 'participant', key = '' }) {
  const selfId = makeId();
  const recvs = new Map();          // topic → Set<fn>
  const peerCbs = new Set();
  const leaveCbs = new Set();
  const peers = new Set();
  const outbox = [];                // buffered sends until the socket is open
  let ws = null, closed = false, retry = 0;

  const url = () =>
    `${SIGNAL_URL}/r/${encodeURIComponent(appId)}/${encodeURIComponent(room)}?id=${selfId}&role=${role}` +
    (role === 'host' && key ? `&key=${encodeURIComponent(key)}` : '');

  const emitPeer  = (id) => { for (const fn of peerCbs)  { try { fn(id); } catch (e) { console.error('[entangle] peer', e); } } };
  const emitLeave = (id) => { for (const fn of leaveCbs) { try { fn(id); } catch (e) { console.error('[entangle] leave', e); } } };

  function connect() {
    try { ws = new WebSocket(url()); } catch (e) { console.error('[entangle] ws', e); return scheduleReconnect(); }
    ws.onopen = () => { retry = 0; for (const m of outbox.splice(0)) { try { ws.send(m); } catch {} } };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'welcome') {
        for (const id of (m.peers || [])) if (!peers.has(id)) { peers.add(id); emitPeer(id); }
      } else if (m.t === 'peer') {
        if (m.id && !peers.has(m.id)) { peers.add(m.id); emitPeer(m.id); }
      } else if (m.t === 'leave') {
        if (peers.delete(m.id)) emitLeave(m.id);
      } else if (m.t === 'msg') {
        const set = recvs.get(m.topic);
        if (set) for (const fn of set) { try { fn(m.data, m.from); } catch (e) { console.error('[entangle] recv', m.topic, e); } }
      }
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onclose = () => { if (!closed) scheduleReconnect(); };
  }

  function scheduleReconnect() {
    // Peers are stale after a drop; clear them so the re-`welcome` re-announces
    // (and the host's onPeer re-broadcasts the scene on rejoin).
    for (const id of [...peers]) { peers.delete(id); emitLeave(id); }
    retry = Math.min(retry + 1, 6);
    const delay = Math.min(400 * 2 ** (retry - 1), 8000);
    setTimeout(() => { if (!closed) connect(); }, delay);
  }

  function raw(obj) {
    const s = JSON.stringify(obj);
    if (ws && ws.readyState === 1) { try { ws.send(s); } catch { outbox.push(s); } }
    else outbox.push(s);
  }

  connect();

  return {
    selfId,
    on(topic, fn) { let s = recvs.get(topic); if (!s) recvs.set(topic, s = new Set()); s.add(fn); return () => s.delete(fn); },
    send(topic, data, target) { raw({ t: 'msg', topic, data, target }); },
    onPeer(fn)  { peerCbs.add(fn); },
    onLeave(fn) { leaveCbs.add(fn); },
    peers()     { return [...peers]; },
    close()     { closed = true; try { ws && ws.close(); } catch {} recvs.clear(); peers.clear(); },
  };
}
