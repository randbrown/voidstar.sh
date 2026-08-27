// stem-recorder.js — record ONE audio source (the rig) to its own file, in
// lockstep with the main screen recorder, so a tracking session yields a
// full-mix video PLUS an isolated stem you can drop into a DAW.
//
// Deliberately minimal next to recorder.js: audio-only, no canvas/video, no
// sink ladder / timecode / duration-fix. Stems are small (a 5-min AAC stem at
// 320 kb/s ≈ 12 MB), so chunks collect in memory and the finished file is
// offered for download at stop(). The stream comes from
// audio.getStemStream(sourceId) — a MediaStreamDestination in the source's own
// ctx, i.e. exactly that source's contribution to the full mix, so the stem
// lines up sample-for-sample with the rig you hear in the video.
//
// Start/pause/resume/stop mirror the main recorder so both takes share one
// timeline; page-init drives both from the file player's transport.

const AUDIO_MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',   // AAC in .m4a — universal DAW import
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
];
const AUDIO_BITS_PER_SECOND = 320_000;   // matches the main recorder's audio rate

function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const c of AUDIO_MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch {}
  }
  return '';
}

function extFor(mime) {
  if (mime.startsWith('audio/mp4')) return 'm4a';
  if (mime.startsWith('audio/ogg')) return 'ogg';
  return 'webm';
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
 *   getStream?: () => MediaStream|null,       // the isolated source stream (audio.getStemStream)
 *   onSave?:  (info: { blob: Blob, filename: string, size: number, save: () => Promise<void> }) => void,
 *   onError?: (err: Error) => void,
 *   onStateChange?: (s: { recording: boolean, paused: boolean }) => void,
 * }} opts
 */
export function createStemRecorder(opts = {}) {
  const getStream = typeof opts.getStream === 'function' ? opts.getStream : () => null;
  let rec = null, chunks = [], mime = '', filename = '';

  function notify() {
    opts.onStateChange?.({ recording: !!rec, paused: rec?.state === 'paused' });
  }

  /** Begin capturing the stem. `baseName` (no extension) pairs the file with
   *  the video take. Returns false (and fires onError) when there's no signal
   *  to record — e.g. the rig capture isn't open. */
  function start(baseName) {
    if (rec) return true;   // already running — idempotent
    const stream = getStream();
    const track = stream?.getAudioTracks?.()[0];
    if (!stream || !track) { opts.onError?.(new Error('no stem signal to capture')); return false; }
    mime = pickAudioMime();
    const recOpts = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
    if (mime) recOpts.mimeType = mime;
    try { rec = new MediaRecorder(stream, recOpts); }
    catch (err) { opts.onError?.(err instanceof Error ? err : new Error(String(err))); rec = null; return false; }
    chunks = [];
    const base = baseName || `qualia-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    filename = `${base}.rig.${extFor(mime || 'audio/webm')}`;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = chunks.length ? new Blob(chunks, { type: mime || 'audio/webm' }) : null;
      chunks = [];
      rec = null;
      notify();
      if (blob && blob.size) {
        const save = () => { download(blob, filename); return Promise.resolve(); };
        try { download(blob, filename); } catch { /* fall back to onSave's save() */ }
        opts.onSave?.({ blob, filename, size: blob.size, save });
      } else {
        opts.onError?.(new Error('stem recording was empty'));
      }
    };
    rec.onerror = (e) => { opts.onError?.(e?.error || new Error('stem recorder error')); };
    try { rec.start(1000); }
    catch (err) { opts.onError?.(err instanceof Error ? err : new Error(String(err))); rec = null; return false; }
    notify();
    return true;
  }

  function stop()   { if (rec && rec.state !== 'inactive') { try { rec.stop();   } catch {} } }
  function pause()  { if (rec && rec.state === 'recording') { try { rec.pause();  } catch {} notify(); } }
  function resume() { if (rec && rec.state === 'paused')    { try { rec.resume(); } catch {} notify(); } }

  return {
    start, stop, pause, resume,
    isRecording: () => !!rec,
    isPaused: () => rec?.state === 'paused',
    isSupported: () => typeof MediaRecorder !== 'undefined' && !!pickAudioMime(),
  };
}
