// ⚠️ RESEARCH / REFERENCE ONLY — NOT WIRED IN, NOT A DROP-IN FALLBACK.
// The live transport is ./entangle-transport-cf.js (Cloudflare DO star relay).
// This Nostr/WebRTC implementation predates the role-aware routing and ignores
// the `role` argument the host/client now pass, so swapping it back in would
// break fan-out. Kept for its relay-selection notes and P2P rationale; update
// the signature (honour `role`) before relying on it. See plans/maintenance-backlog.md (D2).
//
// Entanglement transport seam.
//
// The ONLY module that knows about the underlying P2P library. Everything else
// (host manager, participant client) talks to this small interface:
//
//   const t = await createTransport({ appId, room });
//   t.onPeer(id => …); t.onLeave(id => …);
//   t.on('pose', (data, peerId) => …);
//   t.send('manifest', payload);          // → all peers
//   t.send('manifest', payload, peerId);  // → one peer
//   t.peers();  t.selfId;  t.close();
//
// Swapping transports (e.g. an MQTT pub/sub star for larger crowds) means
// writing another factory with the same shape — no caller changes.
//
// Implementation: Trystero with the Nostr strategy — serverless WebRTC over
// free public Nostr relays for signaling (no broker, no account, encrypted
// P2P data channels). Loaded from CDN ESM to match the project's MediaPipe /
// Strudel pattern and keep it out of the initial bundle. Best for the intimate
// (~≤30) crowds this targets; the mesh grows with crowd size.

const TRYSTERO_URL = 'https://esm.sh/trystero@0.21/nostr';

// Signaling relays — pinned, NOT Trystero's defaults.
//
// Trystero picks its default relays by *deterministically* shuffling its
// built-in list seeded on the appId hash, then taking the first few. For our
// appId that subset rotted onto dead/hostile relays (every join failed at the
// WebSocket layer — host stuck on "0 entangled", phones on "waiting for the
// performer"), and because the pick is deterministic it failed 100% of the
// time, not intermittently. Pinning a vetted list removes that fragility: both
// ends use the SAME relays, Trystero connects to ALL of them, and a single
// reachable relay is enough to exchange WebRTC offers. Each was verified with a
// signed ephemeral-event round-trip — the exact handshake Trystero performs.
// If joins start failing again, re-probe and refresh this list.
//
// relay.damus.io is deliberately OMITTED: it rate-limits aggressively per-IP
// ("noting too much") — which a crowd sharing one venue's wifi (a single NAT IP)
// would trip, and which bit us even in two-tab local testing. The relays below
// are laxer. The real cure for rate-limits / relay-rot is owned signaling: a
// Cloudflare Durable Object WebSocket hub can replace this module behind the
// same seam (no caller changes).
const RELAY_URLS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.oxtr.dev',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://nostr.bitcoiner.social',
];

/**
 * @param {object} opts
 * @param {string} opts.appId   transport namespace (keep stable across builds)
 * @param {string} opts.room    room id (shared host ⇄ participants)
 * @returns {Promise<object>} the transport interface
 */
export async function createTransport({ appId, room }) {
  const { joinRoom, selfId } = await import(/* @vite-ignore */ TRYSTERO_URL);
  const r = joinRoom({ appId, relayUrls: RELAY_URLS }, room);

  // Trystero actions are created once and return a [send, receive] pair; both
  // ends of a namespace must exist for messages to flow. Cache per topic and
  // register a single fan-out receiver so callers can `.on()` repeatedly.
  const actions = new Map();           // topic → { send, recvs:Set }
  function action(topic) {
    let a = actions.get(topic);
    if (!a) {
      const [send, receive] = r.makeAction(topic);
      a = { send, recvs: new Set() };
      receive((data, peerId) => {
        for (const fn of a.recvs) { try { fn(data, peerId); } catch (e) { console.error('[entangle] recv', topic, e); } }
      });
      actions.set(topic, a);
    }
    return a;
  }

  return {
    selfId,
    on(topic, fn)  { action(topic).recvs.add(fn); return () => action(topic).recvs.delete(fn); },
    send(topic, data, target) { return action(topic).send(data, target); },
    onPeer(fn)     { r.onPeerJoin(fn); },
    onLeave(fn)    { r.onPeerLeave(fn); },
    peers()        { try { return Object.keys(r.getPeers()); } catch { return []; } },
    close()        { try { r.leave(); } catch {} actions.clear(); },
  };
}
