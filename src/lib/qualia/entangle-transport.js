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

/**
 * @param {object} opts
 * @param {string} opts.appId   transport namespace (keep stable across builds)
 * @param {string} opts.room    room id (shared host ⇄ participants)
 * @returns {Promise<object>} the transport interface
 */
export async function createTransport({ appId, room }) {
  const { joinRoom, selfId } = await import(/* @vite-ignore */ TRYSTERO_URL);
  const r = joinRoom({ appId }, room);

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
