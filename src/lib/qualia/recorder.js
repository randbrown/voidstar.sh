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
//      At stop() we surface a "tap to save" handle via the readyToSave
//      callback so the caller can show an explicit user-gesture button —
//      that gesture then triggers the actual download. We deliberately do
//      NOT auto-click an anchor here because async stop() loses the
//      original user-gesture context on most mobile browsers, and the
//      download silently fails to fire.
//   3. In-memory Blob[]. Last resort for very old browsers — same
//      "tap to save" handoff as OPFS.
//
// Recording is independent of any other audio engine (strudel / sequencer /
// vocoder / mic). Start/stop the recorder; the rest keeps running.
// Stale OPFS sweep: every start() prunes leftover qualia-*.webm files
// older than ten minutes so an abandoned recording doesn't squat on quota.

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

const OPFS_STALE_MS = 10 * 60 * 1000;

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
 *   { kind, write(blob), close() → { autoSaved, savePending() } }
 *
 * `autoSaved=true` means the sink already wrote to its final destination
 * (showSaveFilePicker path); no further action required.
 * `autoSaved=false` returns a `savePending()` function that triggers the
 * download. Caller MUST invoke it from a user-gesture handler.
 */
async function openSink(filename) {
  // 1) Direct-to-disk via showSaveFilePicker (desktop).
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Recording',
          accept: { 'video/webm': ['.webm'], 'video/mp4': ['.mp4'] },
        }],
      });
      const writable = await handle.createWritable();
      return {
        kind: 'fsa',
        write: (blob) => writable.write(blob),
        close: async () => {
          await writable.close();
          return { autoSaved: true, savePending: null, filename };
        },
        cleanup: async () => { try { await writable.abort(); } catch {} },
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // Other errors drop through to OPFS.
    }
  }

  // 2) OPFS — chunks stream to a private file. Download requires a
  // user gesture; we hand the caller a closure that does it.
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
          // Lazy: only fetch the File when the user actually taps save,
          // so a stop-without-save doesn't waste memory.
          const savePending = async () => {
            const file = await handle.getFile();
            triggerDownload(file, filename);
          };
          return { autoSaved: false, savePending, filename };
        },
        cleanup: async () => {
          try { await writable.abort(); } catch {}
          try { await dir.removeEntry(filename); } catch {}
        },
      };
    } catch {}
  }

  // 3) In-memory Blob[] fallback. Same shape as the OPFS path — caller
  // must invoke savePending() from a user gesture.
  const chunks = [];
  return {
    kind: 'memory',
    write: (blob) => { chunks.push(blob); return Promise.resolve(); },
    close: async () => {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });
      chunks.length = 0;
      const savePending = blob.size > 0
        ? async () => { triggerDownload(blob, filename); }
        : null;
      return { autoSaved: false, savePending, filename };
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
        // Hand the save closure to the page so it can prompt the user
        // for the second gesture (mobile-safe download trigger).
        opts.onReadyToSave?.(info);
      } catch (err) {
        opts.onError?.(err);
      }
    } else {
      try { await s.cleanup(); } catch {}
    }
  }

  function startMediaRecorder(s) {
    mimeType = pickMime();
    const recOpts = { videoBitsPerSecond: 8_000_000 };
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
