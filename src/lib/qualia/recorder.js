// Screen recorder — two capture backends + three sink backends.
//
// Capture backends, picked at start():
//   1. getDisplayMedia (desktop, some Android Chrome builds). User picks
//      tab / window / screen + audio inclusion in the browser share
//      picker. Highest fidelity — captures the whole page including the
//      HUD, overlay, etc.
//   2. canvas.captureStream() fallback for mobile / restricted browsers
//      where getDisplayMedia isn't available or silently fails. Captures
//      only the active fx canvas (no overlay / topbar / HUD) and splices
//      in mic audio when a stream is available. iOS Safari, Android
//      Firefox, Samsung Internet, and Android Chrome builds that block
//      display-capture all land here.
//
// Sink backends, picked at start() (chunked / streaming, in priority order):
//   1. showSaveFilePicker → FileSystemWritableFileStream. Desktop Chrome /
//      Edge. User picks the save location up front, data streams straight
//      to that file; nothing kept in memory. The file is finished and
//      closed at stop() — no second download step.
//   2. OPFS (origin private file system). Chrome (desktop + Android),
//      Safari 15.2+. Chunks stream into a private file under the origin.
//      At stop() we surface a "tap to save" handle so the caller can
//      prompt the user for an explicit save gesture — that gesture then
//      triggers the actual download. Async stop() loses the original
//      user-gesture context on most mobile browsers, so this two-step
//      flow is required for the download to actually fire.
//   3. In-memory Blob[]. Last resort for very old browsers — same
//      "tap to save" handoff as OPFS.
//
// Codec preference: MP4 (H.264 + AAC) is tried first because every
// Android player accepts it natively. WebM is the fallback. When we end
// up writing WebM, we post-process the blob through fix-webm-duration
// at close — Chrome's MediaRecorder emits a "live stream" WebM without
// a Duration tag, which the Android stock players reject as "unknown
// error". The fix reads the blob, rewrites the segment header to
// include the actual duration, and returns a playable file.
//
// Recording is independent of any other audio engine (strudel / sequencer /
// vocoder / mic). Start/stop the recorder; the rest keeps running.
// Stale OPFS sweep: every start() prunes leftover qualia-*.webm files
// older than ten minutes so an abandoned recording doesn't squat on quota.

// Codec preference: try MP4 first because Android's stock Photos /
// Gallery decodes h264 natively and refuses WebM regardless of how
// well-formed it is. Both MP4 and WebM from MediaRecorder need their
// duration fields patched at finalize (Chrome writes neither during
// recording), so we ship inline patchers for both formats and pick
// based on which mime MediaRecorder actually chose.

import fixWebmDuration       from 'fix-webm-duration';
import { fixMp4Duration }    from './fix-mp4-duration.js';

const MIME_CANDIDATES = [
  // MP4 first — fragmented MP4 from MediaRecorder, but the inline
  // fix-mp4-duration patcher rewrites moov.mvhd / trak.tkhd / trak.mdia.mdhd
  // and mvex.mehd to embed the actual duration, after which Android
  // stock Photos opens and plays the file.
  'video/mp4;codecs=h264,aac',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  // WebM fallback. fix-webm-duration patches the EBML segment header
  // so Chrome plays the file. Some Android players still won't open
  // WebM, so this branch is a "good enough on desktop, may need VLC
  // on phones" path used only when MP4 is unavailable.
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const OPFS_STALE_MS = 10 * 60 * 1000;
const VIDEO_BITS_PER_SECOND = 4_000_000;     // 4 Mb/s — plenty for canvas/screen content,
                                             // halves memory + disk footprint vs the old 8 Mb/s default.

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const c of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch {}
  }
  return '';
}

function looksLikeMobile() {
  if (typeof navigator === 'undefined') return false;
  const uad = navigator.userAgentData;
  if (uad?.mobile) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

/** Trigger a browser download. Returns the chosen filename so the caller
 *  can show it in a toast. Must be called from a user-gesture context for
 *  reliable mobile behavior. */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Keep the object URL alive for a generous window so the browser can
  // stream a multi-GB file off it. The underlying source (OPFS / Blob)
  // outlives this URL.
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);
  return filename;
}

/** Sweep stale OPFS recordings older than OPFS_STALE_MS. Best-effort. */
async function sweepStaleOpfs() {
  if (!navigator.storage?.getDirectory) return;
  try {
    const dir = await navigator.storage.getDirectory();
    const now = Date.now();
    // @ts-ignore — entries() is widely supported but not yet in lib.dom
    for await (const [name, handle] of dir.entries()) {
      if (!name.startsWith('qualia-') || !/\.(webm|mp4)$/.test(name)) continue;
      try {
        if (handle.kind !== 'file') continue;
        const file = await handle.getFile();
        if (now - file.lastModified > OPFS_STALE_MS) {
          await dir.removeEntry(name);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Open a streaming sink for the recording. Returns:
 *   { kind, write(blob), close() → { autoSaved, blob, filename }, cleanup() }
 *
 * `autoSaved=true` means the sink already wrote to its final destination
 * (showSaveFilePicker path); `blob` will be null because there's nothing
 * left to fix or save. `autoSaved=false` returns the recorded file as a
 * Blob so the caller can apply any post-processing (WebM duration fix)
 * and then prompt the user to save it via an explicit gesture.
 */
async function openSink(filename) {
  // 1) Direct-to-disk via showSaveFilePicker (desktop only). On mobile,
  // we deliberately skip this — the picker streams chunks straight to
  // the user-chosen location, so by the time MediaRecorder stops, the
  // file is finalized and we can't apply fix-webm-duration before
  // saving. OPFS lets us read the file back at close, patch the
  // segment header, and only THEN trigger the download.
  if (!looksLikeMobile() && typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Recording',
          accept: {
            'video/mp4':  ['.mp4'],
            'video/webm': ['.webm'],
          },
        }],
      });
      const writable = await handle.createWritable();
      return {
        kind: 'fsa',
        write: (blob) => writable.write(blob),
        close: async () => {
          await writable.close();
          return { autoSaved: true, blob: null, filename };
        },
        cleanup: async () => { try { await writable.abort(); } catch {} },
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
    }
  }

  // 2) OPFS — chunks stream to a private file. close() reads back the
  // File reference (no memory copy at this point) so the recorder can
  // apply duration-fix or hand it to the download trigger.
  if (navigator.storage?.getDirectory) {
    try {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      return {
        kind: 'opfs',
        write: (blob) => writable.write(blob),
        close: async () => {
          await writable.close();
          // getFile() returns a File backed by the OPFS entry — no
          // memory copy until something actually reads it.
          const file = await handle.getFile();
          return { autoSaved: false, blob: file, filename };
        },
        cleanup: async () => {
          try { await writable.abort(); } catch {}
          try { await dir.removeEntry(filename); } catch {}
        },
      };
    } catch {}
  }

  // 3) In-memory Blob[] fallback.
  const chunks = [];
  return {
    kind: 'memory',
    write: (blob) => { chunks.push(blob); return Promise.resolve(); },
    close: async () => {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });
      chunks.length = 0;
      return { autoSaved: false, blob: blob.size > 0 ? blob : null, filename };
    },
    cleanup: () => { chunks.length = 0; },
  };
}

/**
 * @param {{
 *   onStateChange?: (s: { recording: boolean, backend: ''|'display'|'canvas', sink: ''|'fsa'|'opfs'|'memory' }) => void,
 *   onReadyToSave?: (info: { filename: string, autoSaved: boolean, save: (() => Promise<void>)|null }) => void,
 *   onError?: (err: Error) => void,
 *   getCanvas?: () => HTMLCanvasElement|null,
 *   getMicStream?: () => MediaStream|null,
 * }} opts
 */
export function createRecorder(opts = {}) {
  /** @type {MediaStream|null} */
  let stream = null;
  /** @type {MediaRecorder|null} */
  let recorder = null;
  let startedAt = 0;
  let mimeType = '';
  /** @type {''|'display'|'canvas'} */
  let backend = '';
  /** @type {Awaited<ReturnType<typeof openSink>>|null} */
  let sink = null;
  let writeChain = Promise.resolve();
  let stopping = false;

  function notify() {
    opts.onStateChange?.({
      recording: !!recorder,
      backend,
      sink: sink?.kind || '',
    });
  }

  async function teardown(success) {
    const s = sink;
    // Capture before resetting — we need mime + duration for the WebM
    // duration fix below.
    const wasMime    = mimeType;
    const startedMs  = startedAt;
    sink = null;
    if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch {} }
    stream = null;
    recorder = null;
    startedAt = 0;
    backend = '';
    stopping = false;
    notify();
    if (!s) return;
    if (success) {
      try {
        const info = await s.close();
        // WebM duration fix. Chrome's MediaRecorder writes WebM without
        // a final Duration tag, which Chrome itself reads fine but the
        // Android stock players reject with "unknown error". The fix
        // parses the EBML segment header and inserts the actual
        // duration. Skip when the file is already saved to a user-
        // picked location (we can't re-open + rewrite that), and skip
        // for MP4 output (no fix needed).
        let blob = info.blob;
        if (!info.autoSaved && blob) {
          const durMs = Math.max(0, performance.now() - startedMs);
          try {
            if (wasMime?.startsWith('video/mp4')) {
              console.log(`[recorder] applying mp4 duration fix · ${blob.size} bytes · ${Math.round(durMs)}ms`);
              blob = await fixMp4Duration(blob, durMs);
              console.log(`[recorder] mp4 duration fix done · output ${blob.size} bytes`);
            } else if (wasMime?.startsWith('video/webm')) {
              console.log(`[recorder] applying webm duration fix · ${blob.size} bytes · ${Math.round(durMs)}ms`);
              blob = await fixWebmDuration(blob, durMs);
              console.log(`[recorder] webm duration fix done · output ${blob.size} bytes`);
            }
          } catch (err) {
            console.warn(`[recorder] duration fix failed (mime=${wasMime}); saving unfixed:`, err);
          }
        }
        const save = blob
          ? () => { triggerDownload(blob, info.filename); return Promise.resolve(); }
          : null;
        opts.onReadyToSave?.({
          filename:  info.filename,
          autoSaved: info.autoSaved,
          save,
        });
      } catch (err) {
        opts.onError?.(err);
      }
    } else {
      try { await s.cleanup(); } catch {}
    }
  }

  function startMediaRecorder(s) {
    mimeType = pickMime();
    const recOpts = { videoBitsPerSecond: VIDEO_BITS_PER_SECOND };
    if (mimeType) recOpts.mimeType = mimeType;
    recorder = new MediaRecorder(s, recOpts);
    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0 || !sink || stopping) return;
      writeChain = writeChain.then(() => sink.write(e.data)).catch(err => {
        console.warn('[recorder] write failed:', err);
        opts.onError?.(err);
        if (!stopping) stop();
      });
    };
    recorder.onstop = async () => {
      try { await writeChain; } catch {}
      teardown(true);
    };
    recorder.onerror = (e) => {
      const err = e?.error || new Error('MediaRecorder error');
      opts.onError?.(err);
      if (!stopping) stop();
    };
    recorder.start(1000);
    startedAt = performance.now();
    stream = s;
    notify();
  }

  async function tryDisplayCapture() {
    if (!navigator.mediaDevices?.getDisplayMedia) return null;
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio: true,
    });
  }

  function tryCanvasCapture() {
    const canvas = opts.getCanvas?.();
    if (!canvas?.captureStream) return null;
    const s = canvas.captureStream(30);
    const micStream = opts.getMicStream?.();
    if (micStream) {
      try {
        for (const t of micStream.getAudioTracks()) s.addTrack(t.clone());
      } catch {}
    }
    return s;
  }

  async function start() {
    if (recorder) return;
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder not supported in this browser');
    }
    sweepStaleOpfs().catch(() => {});

    let s = null;
    let displayErr = null;
    try {
      s = await tryDisplayCapture();
    } catch (err) {
      displayErr = err;
      if (err?.name === 'AbortError') throw err;
      if (err?.name === 'NotAllowedError' && !looksLikeMobile()) throw err;
    }
    if (s) {
      backend = 'display';
      s.getVideoTracks()[0]?.addEventListener('ended', () => stop());
    } else {
      s = tryCanvasCapture();
      if (!s) {
        if (displayErr) throw displayErr;
        throw new Error('Screen recording not supported on this device');
      }
      backend = 'canvas';
    }

    mimeType = pickMime();
    const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `qualia-${ts}.${ext}`;
    try {
      sink = await openSink(filename);
    } catch (err) {
      try { s.getTracks().forEach(t => t.stop()); } catch {}
      backend = '';
      throw err;
    }

    writeChain = Promise.resolve();
    stopping = false;
    startMediaRecorder(s);
    // Diagnostics — visible via remote-debug (chrome://inspect on a
    // tethered Android device) so we can confirm which backend / sink
    // the recorder ended up on without needing extra logging surface.
    console.log(`[recorder] started · backend=${backend} sink=${sink?.kind} mime=${mimeType || '(default)'}`);
  }

  function stop() {
    if (!recorder) return;
    stopping = true;
    // Optimistically tell the page the recording is "no longer live" so
    // the button + toast clear immediately, even if the underlying
    // MediaRecorder.stop() takes a while (or, on broken Android builds,
    // never fires onstop at all). Final state cleanup still runs in
    // teardown() — this just decouples UI feedback from a possibly-slow
    // codec flush.
    opts.onStateChange?.({ recording: false, backend, sink: sink?.kind || '' });
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (err) {
        // Stop threw — force teardown so we don't stay wedged.
        console.warn('[recorder] stop threw, forcing teardown:', err);
        writeChain.catch(() => {}).finally(() => teardown(true));
      }
    } else {
      writeChain.catch(() => {}).finally(() => teardown(true));
    }
    // Belt-and-braces: if onstop hasn't fired in 5 seconds, force teardown.
    // Some Android builds drop onstop for canvas-backed streams entirely.
    setTimeout(() => {
      if (stopping && recorder) {
        console.warn('[recorder] onstop never fired — forcing teardown');
        teardown(true);
      }
    }, 5000);
  }

  async function toggle() {
    if (recorder) { stop(); return; }
    await start();
  }

  return {
    start,
    stop,
    toggle,
    isRecording: () => !!recorder,
    getStartedAt: () => startedAt,
    getBackend: () => backend,
    getSink: () => sink?.kind || '',
    isSupported: () => {
      // Lazy / permissive: MediaRecorder is the only hard requirement.
      // The canvas-capture fallback evaluates at start() time when the
      // qualia canvas definitely exists; if it doesn't, start() surfaces
      // a real error then. Returning true here lets the button stay
      // tappable so the user can trigger the real attempt themselves.
      return typeof MediaRecorder !== 'undefined';
    },
  };
}
