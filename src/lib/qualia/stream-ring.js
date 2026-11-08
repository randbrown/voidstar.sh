// stream-ring.js — a ~40 s lookback of a live MediaStream, for the deck's grab.
//
// Reuses the looper's recorder worklet (worklets/looper-recorder.js), never
// armed — only its always-on ring on the audio thread. `grab(seconds)` posts
// back the last N seconds as per-channel Float32Arrays. Costs one block copy per
// render quantum and ~15 MB while attached; `dispose()` frees it.
//
//   source → ring worklet → 0-gain sink → destination
// (the sink only keeps the worklet pulled; nothing is heard).
//
// Two users: app-capture.js (the share-picker stream, ring hung off its own
// source node) and the deck's "grab from mic input" (a loopback device such as
// BlackHole picked as the mic), via createStreamRing(stream).

import { registerContext, resumeContext } from './audio-unlock.js';
// `?url&no-inline` so Vite emits the worklet as a file addModule() can load
// (same as looper-audio.js).
import recorderWorkletUrl from './worklets/looper-recorder.js?url&no-inline';

// Matches RING_SECONDS in worklets/looper-recorder.js.
export const RING_SECONDS = 40;

/** An AudioContext at the TRACK's own sample rate (48 kHz fallback). A
 *  MediaStreamSource in a context at another rate gets resampled on the fly,
 *  and that path drops and repeats blocks — inaudible as a reactivity feed, but
 *  a grab of it comes out garbled and off-pitch. These contexts never play to
 *  the speakers, so their rate needn't match the output. */
export function makeStreamContext(track) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let rate = 0;
  try { rate = track?.getSettings?.().sampleRate || 0; } catch {}
  if (!(rate >= 8000 && rate <= 192000)) rate = 48000;
  try { return new AC({ sampleRate: rate }); } catch { return new AC(); }
}

/** Hang a lookback ring off `sourceNode` in `ctx`. Resolves to
 *  `{ grab, seconds, dispose }`, or null if the worklet can't load. */
export async function attachRing(ctx, sourceNode) {
  if (!ctx?.audioWorklet?.addModule || !sourceNode) return null;
  try {
    await ctx.audioWorklet.addModule(recorderWorkletUrl);
  } catch (err) {
    console.warn('[qualia] lookback ring worklet failed to load:', err);
    return null;
  }
  if (ctx.state === 'closed') return null;
  const node = new AudioWorkletNode(ctx, 'looper-recorder', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sourceNode.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  const t0 = ctx.currentTime;
  const pending = new Map();
  let nextId = 0, disposed = false;
  node.port.onmessage = (e) => {
    const d = e.data;
    if (d?.grab === undefined) return;
    const resolve = pending.get(d.grab);
    if (resolve) { pending.delete(d.grab); resolve(d); }
  };
  return {
    /** Seconds of lookback held so far. */
    seconds: () => (disposed ? 0 : Math.min(RING_SECONDS, Math.max(0, ctx.currentTime - t0))),
    /** The last `seconds` as `{ chans, sampleRate }`, or null. */
    grab: (seconds) => {
      if (disposed) return Promise.resolve(null);
      const id = ++nextId;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 2000);
        pending.set(id, (d) => {
          clearTimeout(timer);
          resolve(d?.chans?.length ? { chans: d.chans, sampleRate: d.sampleRate || ctx.sampleRate } : null);
        });
        try { node.port.postMessage({ cmd: 'grab', seconds, id }); }
        catch { clearTimeout(timer); pending.delete(id); resolve(null); }
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try { node.port.postMessage({ cmd: 'dispose' }); } catch {}
      try { sourceNode.disconnect(node); } catch {}
      try { node.disconnect(); sink.disconnect(); } catch {}
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
    },
  };
}

/** A self-contained ring on a MediaStream (its first audio track) in its own
 *  context at the track's rate. Resolves to `{ grab, seconds, dispose, stream }`
 *  or null. `dispose()` closes the context but leaves the stream's tracks
 *  alone — the stream belongs to whoever opened it (e.g. the mic in audio.js). */
export async function createStreamRing(stream) {
  const track = stream?.getAudioTracks?.()[0];
  if (!track) return null;
  const ctx = registerContext(makeStreamContext(track));
  await resumeContext(ctx);
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const ring = await attachRing(ctx, src);
  if (!ring) { try { await ctx.close(); } catch {} return null; }
  return {
    stream,
    grab: ring.grab,
    seconds: ring.seconds,
    dispose: () => {
      ring.dispose();
      try { src.disconnect(); } catch {}
      try { ctx.close(); } catch {}
    },
  };
}
