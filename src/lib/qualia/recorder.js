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
//      to that file; nothing kept in memory.
//   2. OPFS (origin private file system). Chrome (desktop + Android),
//      Safari 15.2+. Chunks stream into a private file under the origin;
//      at stop() we hand a streaming blob:URL to the download. Mobile-
//      friendly and survives long sets.
//   3. In-memory Blob[]. Last resort for very old browsers — same code
//      path as before, RAM-bound (~3.6 GB/hour at 8 Mb/s).
//
// Stale OPFS sweep: every start() prunes leftover qualia-*.webm files
// older than ten minutes so an abandoned recording from a previous
// session doesn't squat on origin storage forever.

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

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Keep the object URL alive long enough for the browser to stream a
  // multi-GB file off it. The actual filesystem source (OPFS / disk)
  // outlives this URL, so revoking just frees the blob URL mapping.
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);
}

/** Sweep stale OPFS recordings older than OPFS_STALE_MS. Best-effort. */
async function sweepStaleOpfs() {
  if (!navigator.storage?.getDirectory) return;
  try {
    const dir = await navigator.storage.getDirectory();
    const now = Date.now();
    // entries() yields [name, handle] pairs. We only touch files we own.
    // @ts-ignore — entries() is widely supported but not yet typed in lib.dom
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
 * Open a streaming sink for the recording. Returns an object with
 * `write(blob)` / `close()` / `cleanup()` regardless of which backend
 * was picked, so the caller doesn't branch.
 */
async function openSink(filename) {
  // 1) Direct-to-disk via showSaveFilePicker (desktop).
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Recording',
          accept: {
            'video/webm': ['.webm'],
            'video/mp4':  ['.mp4'],
          },
        }],
      });
      const writable = await handle.createWritable();
      return {
        kind: 'fsa',
        write: (blob) => writable.write(blob),
        close: async () => { await writable.close(); },
        cleanup: async () => { try { await writable.abort(); } catch {} },
      };
    } catch (err) {
      // User cancelled the save picker — treat as "they want to abandon"
      // and bubble up so the caller can skip starting the recording.
      if (err?.name === 'AbortError') throw err;
      // Anything else (security policy, unsupported in iframe, etc.) —
      // drop through to OPFS so we still record something.
    }
  }

  // 2) OPFS — chunks stream to a private file, then download via blob URL.
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
          // memory copy, so multi-GB recordings stream off disk into
          // the download instead of being loaded all at once.
          const file = await handle.getFile();
          triggerDownload(file, filename);
          // Leave the OPFS file in place for the duration of the
          // download; the next session's sweep will clean it up.
        },
        cleanup: async () => {
          try { await writable.abort(); } catch {}
          try { await dir.removeEntry(filename); } catch {}
        },
      };
    } catch {}
  }

  // 3) In-memory Blob[] fallback. Same shape as the disk paths; only
  // the assembly differs.
  const chunks = [];
  return {
    kind: 'memory',
    write: (blob) => { chunks.push(blob); return Promise.resolve(); },
    close: async () => {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });
      chunks.length = 0;
      if (blob.size > 0) triggerDownload(blob, filename);
    },
    cleanup: () => { chunks.length = 0; },
  };
}

/**
 * @param {{
 *   onStateChange?: (s: { recording: boolean, backend: ''|'display'|'canvas', sink: ''|'fsa'|'opfs'|'memory' }) => void,
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
  // Serialize sink writes so chunks land in order, even if a previous
  // write is still flushing when the next ondataavailable fires.
  let writeChain = Promise.resolve();
  // Set on stop() so any in-flight writes know to skip — protects against
  // a late chunk arriving after the user already abandoned.
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
      try { await s.close(); }
      catch (err) { console.warn('[recorder] sink close failed:', err); }
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
      // Chain writes so they serialize without ever blocking the audio
      // thread that fired the event. A failed write logs once and stops
      // the recording — better to fail loudly than silently drop data.
      writeChain = writeChain.then(() => sink.write(e.data)).catch(err => {
        console.warn('[recorder] write failed:', err);
        if (!stopping) stop();
      });
    };
    recorder.onstop = async () => {
      // Drain any pending writes before closing the sink so the file
      // isn't truncated mid-chunk.
      try { await writeChain; } catch {}
      teardown(true);
    };
    // 1s timeslice — small enough to drip chunks to the sink steadily
    // even on slow flash storage, large enough to keep MediaRecorder's
    // overhead modest.
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

    // Best-effort housekeeping. Doesn't block start.
    sweepStaleOpfs().catch(() => {});

    // 1) Capture backend.
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

    // 2) Sink backend — opened AFTER the capture stream so a failed
    // display-capture doesn't get the user halfway through a save-as
    // dialog before we know we even need one.
    mimeType = pickMime();
    const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `qualia-${ts}.${ext}`;
    try {
      sink = await openSink(filename);
    } catch (err) {
      // User cancelled the save-file picker — abandon the capture stream
      // so the camera/screen indicator goes away.
      try { s.getTracks().forEach(t => t.stop()); } catch {}
      backend = '';
      throw err;
    }

    writeChain = Promise.resolve();
    stopping = false;
    startMediaRecorder(s);
  }

  function stop() {
    if (!recorder) return;
    stopping = true;
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    } else {
      // Recorder already stopped on its own — drain + close manually.
      writeChain.catch(() => {}).finally(() => teardown(true));
    }
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
      if (typeof MediaRecorder === 'undefined') return false;
      if (navigator.mediaDevices?.getDisplayMedia) return true;
      const c = opts.getCanvas?.();
      return !!(c && c.captureStream);
    },
  };
}
