// Loader for the Signalsmith Stretch (signalsmith-stretch, MIT) WASM +
// AudioWorklet node — pitch-preserving time-stretch for loop playback.
//
// The package self-contains its WASM + worklet (the processor is registered
// from an inline Blob on first construction), so a plain import works — no
// `?url`/asset wrangling like looper-recorder.js. We import it DYNAMICALLY so
// it stays client-only (Astro SSR never evaluates AudioWorkletNode) and out of
// the initial bundle until a track actually turns on preserve-pitch.
//
// Returns an AudioWorkletNode-with-extras (see the package README): .addBuffers,
// .dropBuffers, .schedule, .start/.stop, .latency, .configure. We drive it in
// "buffer" mode — feed a loop region with addBuffers, then schedule looped,
// pitch-preserved playback (rate ≠ 1, semitones 0).

let _modPromise = null;

// Create a stretch node with `channels` outputs (1 mono / 2 stereo) on the
// given context, or null if the library fails to load (caller falls back to
// varispeed). The WASM module + worklet are shared across nodes — the library
// memoises addModule per AudioContext.
export async function createStretchNode(ctx, channels = 1) {
  if (!ctx) return null;
  if (!_modPromise) {
    _modPromise = import('signalsmith-stretch')
      .then((m) => m.default || m)
      .catch((err) => { console.warn('[qualia] signalsmith-stretch load failed:', err); _modPromise = null; return null; });
  }
  const SignalsmithStretch = await _modPromise;
  if (typeof SignalsmithStretch !== 'function') return null;
  const ch = Math.max(1, Math.min(2, (channels | 0) || 1));
  try {
    return await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [ch] });
  } catch (err) {
    console.warn('[qualia] signalsmith-stretch node init failed:', err);
    return null;
  }
}
