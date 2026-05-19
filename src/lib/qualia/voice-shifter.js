// Voice shifter — the harmonizer "voice" engine's pitch-shift back-end.
//
// Wraps two implementations behind one stable node interface:
//   • formant-shift AudioWorklet (worklets/formant-shift.js) — phase-vocoder
//     with formant preservation, so harmonies keep the singer's vocal
//     identity. This is what makes a stacked harmony intelligible.
//   • the granular shifter (pitch-shift.js) — the no-worklet fallback, used
//     until the worklet module finishes loading and if it ever fails.
//
// The wrapper owns a stable `input` GainNode and N stable `output` GainNodes.
// It starts on the granular path so audio is live immediately, then hot-swaps
// to the worklet once its module is ready — the caller's connections to
// input/outputs never change, so it never sees the swap.

import { createGranularShifter } from './pitch-shift.js';

// Vite emits the worklet as a standalone asset and hands back its URL — the
// processor must load over the network into the AudioWorklet global scope, it
// can't be bundled into the page chunk.
import workletUrl from './worklets/formant-shift.js?url';

// addModule() is per-AudioContext and idempotent-ish, but we still memoise so
// N shifters in one context share a single network load. Resolves to whether
// the worklet is available.
const moduleLoads = new WeakMap();
function ensureModule(ctx) {
  if (moduleLoads.has(ctx)) return moduleLoads.get(ctx);
  let p;
  if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
    p = Promise.resolve(false);
  } else {
    p = ctx.audioWorklet.addModule(workletUrl)
      .then(() => true)
      .catch((err) => {
        console.warn('[qualia] formant-shift worklet failed to load — using granular fallback:', err);
        return false;
      });
  }
  moduleLoads.set(ctx, p);
  return p;
}

/**
 * @param {AudioContext} ctx
 * @param {number} voices  number of harmony voices
 * @returns {{
 *   input: GainNode, outputs: GainNode[],
 *   setRatios:(r:number[])=>void, setFormant:(semitones:number)=>void,
 *   dispose:()=>void, isWorklet:()=>boolean
 * }}
 */
export function createVoiceShifter(ctx, voices) {
  const input   = ctx.createGain();
  const outputs = [];
  for (let v = 0; v < voices; v++) outputs.push(ctx.createGain());

  // Current control state — kept so it can be replayed onto whichever
  // back-end is live (and onto the worklet at swap time).
  const ratios = new Array(voices).fill(1);
  let formant = 0;
  let disposed = false;

  // ── Granular fallback (immediate) ──────────────────────────────────────
  let granular = [];
  for (let v = 0; v < voices; v++) {
    const sh = createGranularShifter(ctx);
    input.connect(sh.input);
    sh.output.connect(outputs[v]);
    granular.push(sh);
  }

  // ── Worklet (swapped in once ready) ────────────────────────────────────
  let node = null, splitter = null;

  function applyToBackEnd() {
    if (node) {
      try { node.port.postMessage({ ratios: ratios.slice(), formant }); } catch {}
    } else {
      for (let v = 0; v < granular.length; v++) {
        // The granular shifter has no "off" — park inactive voices at unity
        // (their output gain is muted by the caller anyway).
        try { granular[v].setRatio(ratios[v] > 0 ? ratios[v] : 1); } catch {}
      }
    }
  }

  ensureModule(ctx).then((ok) => {
    if (disposed || !ok) return;
    try {
      node = new AudioWorkletNode(ctx, 'formant-shift', {
        numberOfInputs:  1,
        numberOfOutputs: 1,
        outputChannelCount: [voices],
        processorOptions: { voices },
      });
      splitter = ctx.createChannelSplitter(voices);
      input.connect(node);
      node.connect(splitter);
      for (let v = 0; v < voices; v++) splitter.connect(outputs[v], v, 0);
      // Worklet is live — push current control state, then retire the
      // granular path. The brief overlap is sub-millisecond.
      applyToBackEnd();
      for (const sh of granular) { try { input.disconnect(sh.input); } catch {} try { sh.dispose(); } catch {} }
      granular = [];
    } catch (err) {
      console.warn('[qualia] formant-shift node init failed — keeping granular fallback:', err);
      node = null; splitter = null;
    }
  });

  return {
    input,
    outputs,
    // Per-voice pitch ratios (output ÷ input). A ratio ≤ 0 marks the voice
    // unused — the worklet skips it for CPU.
    setRatios(arr) {
      for (let v = 0; v < voices; v++) {
        const r = +arr[v];
        ratios[v] = (r > 0 && isFinite(r)) ? r : 0;
      }
      applyToBackEnd();
    },
    // Global formant shift in semitones (worklet only; granular ignores it).
    setFormant(semitones) {
      formant = Math.max(-12, Math.min(12, +semitones || 0));
      if (node) { try { node.port.postMessage({ formant }); } catch {} }
    },
    dispose() {
      disposed = true;
      for (const sh of granular) { try { sh.dispose(); } catch {} }
      granular = [];
      if (node)     { try { node.disconnect(); } catch {} node = null; }
      if (splitter) { try { splitter.disconnect(); } catch {} splitter = null; }
      try { input.disconnect(); } catch {}
      for (const o of outputs) { try { o.disconnect(); } catch {} }
    },
    isWorklet: () => !!node,
  };
}
