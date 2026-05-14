// Screen recorder — two backends, picked at start():
//
//   1. getDisplayMedia (desktop, some Android Chrome builds). User picks
//      tab / window / screen + audio inclusion in the browser share
//      picker. Highest fidelity — captures the whole page including the
//      HUD, overlay, etc.
//   2. canvas.captureStream() fallback for mobile / restricted environments
//      where getDisplayMedia isn't available or silently fails. Captures
//      only the active fx canvas (no overlay / topbar / HUD) and tries to
//      mix in mic audio when a stream is available. iOS Safari, Android
//      Firefox, Samsung Internet, and Android Chrome builds that block
//      display-capture all land here.
//
// Memory note: chunks live in RAM until finalize(). At 8 Mb/s that's
// ~3.6 GB/hour — fine for typical performance lengths on a laptop, may
// stress phones. OPFS streaming is a future follow-up if needed.

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const c of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch {}
  }
  return '';
}

/** Coarse runtime test for mobile / touch-only devices where
 *  getDisplayMedia is usually broken or absent. We don't gate on it —
 *  we still try getDisplayMedia first — but the canvas-capture path
 *  prefers it when both could work. */
function looksLikeMobile() {
  if (typeof navigator === 'undefined') return false;
  const uad = navigator.userAgentData;
  if (uad?.mobile) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

/**
 * @param {{
 *   onStateChange?: (s: { recording: boolean, backend: ''|'display'|'canvas' }) => void,
 *   getCanvas?: () => HTMLCanvasElement|null,
 *   getMicStream?: () => MediaStream|null,
 * }} opts
 */
export function createRecorder(opts = {}) {
  /** @type {MediaStream|null} */
  let stream = null;
  /** @type {MediaRecorder|null} */
  let recorder = null;
  /** @type {Blob[]} */
  let chunks = [];
  let startedAt = 0;
  let mimeType = '';
  /** @type {''|'display'|'canvas'} */
  let backend = '';

  function notify() {
    opts.onStateChange?.({ recording: !!recorder, backend });
  }

  function finalize() {
    const usedMime = mimeType || (chunks[0]?.type) || 'video/webm';
    const blob = new Blob(chunks, { type: usedMime });
    chunks = [];
    if (stream) {
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
    }
    stream = null;
    recorder = null;
    startedAt = 0;
    backend = '';
    notify();

    if (blob.size === 0) return;
    const ext = usedMime.includes('mp4') ? 'mp4' : 'webm';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `qualia-${ts}.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
  }

  async function tryDisplayCapture() {
    if (!navigator.mediaDevices?.getDisplayMedia) return null;
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio: true,
    });
    return s;
  }

  function tryCanvasCapture() {
    const canvas = opts.getCanvas?.();
    if (!canvas?.captureStream) return null;
    const s = canvas.captureStream(30);
    // Best-effort: if the audio module exposes a live mic MediaStream,
    // splice its audio tracks in so the fallback recording has sound.
    // We don't have a way to capture strudel/sequencer audio without
    // owning their AudioContexts, so this only lands the mic — which
    // at venues is typically the full PA mix anyway.
    const micStream = opts.getMicStream?.();
    if (micStream) {
      try {
        for (const t of micStream.getAudioTracks()) s.addTrack(t.clone());
      } catch {}
    }
    return s;
  }

  function startMediaRecorder(s) {
    mimeType = pickMime();
    const recOpts = { videoBitsPerSecond: 8_000_000 };
    if (mimeType) recOpts.mimeType = mimeType;
    recorder = new MediaRecorder(s, recOpts);
    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = finalize;
    // 1s timeslice — gives `dataavailable` a chance to fire periodically.
    recorder.start(1000);
    startedAt = performance.now();
    stream = s;
    notify();
  }

  async function start() {
    if (recorder) return;
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder not supported in this browser');
    }

    // 1) Try getDisplayMedia. On desktop this is the high-fidelity path —
    // captures the whole page including overlay/HUD. On mobile it may
    // throw NotAllowedError or NotSupportedError, in which case we fall
    // through to canvas capture below.
    let s = null;
    let displayErr = null;
    try {
      s = await tryDisplayCapture();
    } catch (err) {
      displayErr = err;
      // User-cancelled — respect it, don't silently fall back to a
      // different surface than what they asked for. Other errors
      // (NotSupportedError, SecurityError, NotAllowedError on mobile
      // where it really means "not supported") drop through to canvas.
      if (err?.name === 'AbortError') throw err;
      if (err?.name === 'NotAllowedError' && !looksLikeMobile()) throw err;
    }

    if (s) {
      backend = 'display';
      s.getVideoTracks()[0]?.addEventListener('ended', () => stop());
      startMediaRecorder(s);
      return;
    }

    // 2) Canvas-capture fallback. Mobile-friendly: captures only the fx
    // canvas (overlay/HUD are not included) plus any available mic audio.
    s = tryCanvasCapture();
    if (s) {
      backend = 'canvas';
      startMediaRecorder(s);
      return;
    }

    // Both failed — surface whichever original error is most informative.
    if (displayErr) throw displayErr;
    throw new Error('Screen recording not supported on this device');
  }

  function stop() {
    if (!recorder) return;
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    } else {
      finalize();
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
    isSupported: () => {
      if (typeof MediaRecorder === 'undefined') return false;
      // Either path is good enough to call it supported.
      if (navigator.mediaDevices?.getDisplayMedia) return true;
      const c = opts.getCanvas?.();
      return !!(c && c.captureStream);
    },
  };
}
