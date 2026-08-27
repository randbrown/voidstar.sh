// stem-recorder.js — record ONE audio source (the rig) to its own file, in
// lockstep with the main screen recorder, so a tracking session yields a
// full-mix video PLUS an isolated stem you can drop into a DAW.
//
// The stem is captured as raw Float32 PCM off the main thread: a tiny 'pcm-tap'
// AudioWorklet, attached to the source's passthrough analyser in the source's
// own ctx (audio.getStemNode), copies armed input back here where we assemble
// the per-channel chunks. At stop we write a lossless WAV (wav.js, no network,
// works offline) or — when the performer picks MP3 — transcode that WAV through
// ffmpeg.wasm (mp3-encode.js, lazy ~31 MB core, online), falling back to the
// WAV if the encoder can't load.
//
// Why not MediaRecorder like the main video take? MediaRecorder can't emit WAV
// or MP3 (only webm/ogg/mp4-aac), and a rig stem for a DAW wants the lossless,
// offline WAV. Start/pause/resume/stop still mirror the main recorder so both
// takes share one timeline; page-init drives both from the file player's
// transport. A paused span simply isn't captured, so the stem stays gap-free
// and the same length as the (also-frozen) video.

import pcmTapUrl from './worklets/pcm-tap.js?url&no-inline';
import { encodeWav } from './wav.js';
import { wavToMp3 } from './mp3-encode.js';

// Track which contexts already have the worklet module, so re-arming doesn't
// re-add it (addModule is cheap-but-not-free, and re-registering throws).
const workletReady = new WeakMap();   // ctx -> Promise<boolean>
function ensureWorklet(ctx) {
  if (!ctx?.audioWorklet?.addModule) return Promise.resolve(false);
  let p = workletReady.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(pcmTapUrl).then(() => true).catch((err) => {
      console.warn('[qualia] pcm-tap worklet failed to load:', err);
      workletReady.delete(ctx);   // let a later attempt retry
      return false;
    });
    workletReady.set(ctx, p);
  }
  return p;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);
}

/**
 * @param {{
 *   getStemNode?: () => { ctx: AudioContext, node: AudioNode } | null,  // audio.getStemNode
 *   getFormat?:   () => 'wav' | 'mp3',                                   // chosen output format
 *   onSave?:      (info: { blob: Blob, filename: string, size: number, format: string }) => void,
 *   onError?:     (err: Error) => void,
 *   onStatus?:    (msg: string) => void,                                 // encode progress
 *   onStateChange?: (s: { recording: boolean, paused: boolean }) => void,
 * }} opts
 */
export function createStemRecorder(opts = {}) {
  const getStemNode = typeof opts.getStemNode === 'function' ? opts.getStemNode : () => null;
  const getFormat   = typeof opts.getFormat === 'function' ? opts.getFormat : () => 'wav';

  let ctx = null, srcNode = null, tapNode = null, sink = null;
  let chunks = [];        // [{ chans: Float32Array[] }]
  let recording = false, paused = false, sampleRate = 48000, baseName = '';

  function notify() { opts.onStateChange?.({ recording, paused }); }

  function teardownGraph() {
    try { srcNode?.disconnect(tapNode); } catch {}
    try { tapNode?.disconnect(); } catch {}
    try { sink?.disconnect(); } catch {}
    tapNode = null; sink = null; srcNode = null; ctx = null;
  }

  function assembleWav() {
    if (!chunks.length) return null;
    const numCh = chunks[0].chans.length || 1;
    const total = chunks.reduce((n, c) => n + (c.chans[0]?.length || 0), 0);
    if (!total) return null;
    const channels = Array.from({ length: numCh }, () => new Float32Array(total));
    let off = 0;
    for (const c of chunks) {
      const len = c.chans[0]?.length || 0;
      for (let ch = 0; ch < numCh; ch++) {
        if (c.chans[ch]) channels[ch].set(c.chans[ch], off);
      }
      off += len;
    }
    return encodeWav(channels, sampleRate);
  }

  async function finalize() {
    const wav = assembleWav();
    chunks = [];
    teardownGraph();
    if (!wav) { opts.onError?.(new Error('stem recording was empty')); return; }

    const requestedFormat = getFormat();
    let format = requestedFormat;
    let bytes = wav, ext = 'wav';
    let wavFallback = false, fallbackReason = '';
    if (format === 'mp3') {
      try {
        bytes = await wavToMp3(wav, { onStatus: opts.onStatus });
        ext = 'mp3';
      } catch (err) {
        // Offline / CDN down — the WAV is already in hand, so save that rather
        // than lose the take. Reported through onSave (below) as a single
        // fallback message so a generic "saved" toast can't hide the swap.
        console.warn('[qualia] mp3 stem encode failed — saving WAV instead:', err);
        format = 'wav'; bytes = wav; ext = 'wav';
        wavFallback = true; fallbackReason = err?.message || String(err);
      }
    }

    const mime = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    const blob = new Blob([bytes], { type: mime });
    const filename = `${baseName}.rig.${ext}`;
    try { download(blob, filename); } catch { /* onSave still fires so the caller can retry */ }
    opts.onSave?.({ blob, filename, size: blob.size, format, requestedFormat, wavFallback, fallbackReason });
  }

  /** Begin capturing the stem. `name` (no extension) pairs the file with the
   *  video take. Returns false (and fires onError) when there's no signal to
   *  record — e.g. the rig capture isn't open. */
  async function start(name) {
    if (recording) return true;   // already running — idempotent
    const info = getStemNode();
    if (!info || !info.ctx || !info.node) { opts.onError?.(new Error('no stem signal to capture')); return false; }
    const ready = await ensureWorklet(info.ctx);
    if (!ready) { opts.onError?.(new Error('stem capture unavailable (no AudioWorklet)')); return false; }
    // getStemNode can go stale across the await (rig reopened) — re-read.
    const live = getStemNode();
    if (!live || live.ctx !== info.ctx) { opts.onError?.(new Error('rig signal changed — reopen and retry')); return false; }

    ctx = info.ctx;
    srcNode = info.node;
    sampleRate = ctx.sampleRate || 48000;
    baseName = name || `qualia-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    chunks = [];
    try {
      tapNode = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    } catch (err) {
      teardownGraph();
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
    tapNode.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.done) { void finalize(); return; }
      if (d.chans) chunks.push({ chans: d.chans });
    };
    // 0-gain sink keeps the worklet pulled by the graph without adding anything
    // audible; the source's own output path is untouched (this is a fan-out tap).
    sink = ctx.createGain();
    sink.gain.value = 0;
    try {
      srcNode.connect(tapNode);
      tapNode.connect(sink);
      sink.connect(ctx.destination);
    } catch (err) {
      teardownGraph();
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
    recording = true; paused = false;
    tapNode.port.postMessage({ cmd: 'start' });
    notify();
    return true;
  }

  function stop() {
    if (!recording) return;
    recording = false; paused = false;
    // Ask the worklet to flush its tail and signal 'done'; finalize() runs when
    // that arrives (all posted blocks received) and tears the graph down.
    try { tapNode?.port.postMessage({ cmd: 'stop' }); } catch { void finalize(); }
    notify();
  }

  function pause() {
    if (!recording || paused) return;
    paused = true;
    try { tapNode?.port.postMessage({ cmd: 'pause' }); } catch {}
    notify();
  }

  function resume() {
    if (!recording || !paused) return;
    paused = false;
    try { tapNode?.port.postMessage({ cmd: 'resume' }); } catch {}
    notify();
  }

  return {
    start, stop, pause, resume,
    isRecording: () => recording,
    isPaused: () => paused,
    isSupported: () => typeof AudioWorkletNode !== 'undefined',
  };
}
