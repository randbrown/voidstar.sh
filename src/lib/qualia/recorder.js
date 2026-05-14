// Screen recorder — wraps getDisplayMedia + MediaRecorder. The user
// picks the source (tab / window / screen) and audio inclusion in the
// browser's standard share-picker; we just collect chunks and save a
// .webm/.mp4 when they hit stop (or close the share UI).
//
// Memory note: chunks live in RAM until finalize(). A 30-min set at the
// default bitrate is ~2 GB — fine on a laptop, may hurt phones. If we
// hit limits later we can stream chunks to OPFS / showSaveFilePicker
// instead of buffering. Single recorder instance per page is enough.

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

/** @param {{ onStateChange?: (s: { recording: boolean, startedAt: number }) => void }} opts */
export function createRecorder(opts = {}) {
  let stream = null;
  /** @type {MediaRecorder|null} */
  let recorder = null;
  /** @type {Blob[]} */
  let chunks = [];
  let startedAt = 0;
  let mimeType = '';

  function notify() {
    opts.onStateChange?.({ recording: !!recorder, startedAt });
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

  async function start() {
    if (recorder) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen capture not supported in this browser');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder not supported in this browser');
    }
    // Ask for 60fps + audio; the browser will downgrade to what the
    // chosen source can provide. audio:true at the getDisplayMedia layer
    // lets the user opt into tab/system audio in the share picker.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio: true,
    });
    // If the user stops the share via the browser's "Stop sharing" UI,
    // finalize the recording so they still get a file.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => stop());

    mimeType = pickMime();
    const recOpts = mimeType
      ? { mimeType, videoBitsPerSecond: 8_000_000 }
      : { videoBitsPerSecond: 8_000_000 };
    recorder = new MediaRecorder(stream, recOpts);
    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = finalize;
    // 1s timeslice — keeps chunks small enough that a forced page-close
    // mid-recording at least leaves usable partial data in memory until
    // GC, and gives `dataavailable` a chance to fire periodically.
    recorder.start(1000);
    startedAt = performance.now();
    notify();
  }

  function stop() {
    if (!recorder) return;
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    } else {
      // Already inactive — finalize manually so state cleans up.
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
    isSupported: () =>
      typeof MediaRecorder !== 'undefined'
      && !!navigator.mediaDevices?.getDisplayMedia,
  };
}
