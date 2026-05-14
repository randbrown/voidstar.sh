// Screen recorder — one capture backend (composite viewport canvas) +
// three sink backends. No getDisplayMedia. The page composites the fx
// canvas + the overlay canvas into a single recording canvas every frame
// while we're recording, and we capture from that canvas. Result: the
// saved file contains exactly the viewport content (fx + skeleton /
// sparks / aura / ASCII / mosh / edge / ripples), with no browser chrome,
// no topbar, and no HUD panels. Works the same on every platform —
// no screen-share dialog interruption, no transient-activation games
// between getDisplayMedia and showSaveFilePicker, no platform-specific
// "share tab audio" toggle to remember.
//
// Audio: the recordable mix bus (audio.getRecordableStream) carries every
// in-page source — mic, strudel, sequencer, vocoder — that passes the
// audio source filter (the same filter that gates reactivity, set by the
// audio-mode button: off / mic / mix / all). We clone that destination's
// audio track into the recorder's stream. Sources that come online or
// the filter that changes mid-recording flow through the existing track
// because the bus is materialised eagerly and the taps refresh in place.
//
// Sink backends, picked at start() (chunked / streaming, in priority order):
//   1. showSaveFilePicker → FileSystemWritableFileStream. Desktop Chrome /
//      Edge. User picks the save location up front, data streams straight
//      to that file; nothing kept in memory. The file is finished and
//      closed at stop() — no second download step.
//   2. OPFS (origin private file system). Chrome (desktop + Android),
//      Safari 15.2+. Chunks stream into a private file under the origin.
//      At stop() we trigger a download from the OPFS-backed File; on
//      desktop this fires immediately, on mobile it surfaces a tap-to-save
//      fallback if the download anchor's auto-fire is rejected.
//   3. In-memory Blob[]. Last resort for very old browsers — same
//      download handoff as OPFS.
//
// showSaveFilePicker is called BEFORE any other API that consumes
// transient user activation. The rec button click gives us one fresh
// activation; the picker is the only async API in this codepath that
// needs it, so it goes first. Earlier versions of this recorder called
// getDisplayMedia first and showSaveFilePicker second, which silently
// failed with SecurityError on Windows / macOS Chrome (activation was
// already consumed) and fell back to OPFS — by which point the user
// expected the file to already be saved.
//
// Codec preference: MP4 (H.264 + AAC) is tried first because every
// Android player accepts it natively. WebM is the fallback. When we end
// up writing WebM, we post-process the blob through fix-webm-duration
// at close — Chrome's MediaRecorder emits a "live stream" WebM without
// a Duration tag, which the Android stock players reject as "unknown
// error". The fix reads the blob, rewrites the segment header to
// include the actual duration, and returns a playable file. Same shape
// applies to MP4 via fix-mp4-duration.
//
// Recording is independent of any other audio engine (strudel / sequencer /
// vocoder / mic). Start/stop the recorder; the rest keeps running.
// Stale OPFS sweep: every start() prunes leftover qualia-*.webm files
// older than ten minutes so an abandoned recording doesn't squat on quota.

import fixWebmDuration       from 'fix-webm-duration';
import { fixMp4Duration }    from './fix-mp4-duration.js';

const MIME_CANDIDATES = [
  // H.264 profile/level matters more than it looks. Chrome's Android
  // MediaRecorder will happily report `avc1.42E01E` (Baseline 3.0) as
  // supported via isTypeSupported(), but Baseline 3.0 caps at 720x480 —
  // any modern phone canvas is bigger than that, so the hardware encoder
  // throws `EncodingError: "The given encoder configuration is not
  // supported by the encoder."` on the first frame and we get 0-byte
  // recordings. Putting High 4.2 / High 4.0 first asks Chrome for an
  // encoder configuration that actually fits a 1080p+ canvas, with
  // Main 4.0 / Baseline 4.0 as fallbacks before bare 'video/mp4' lets
  // Chrome pick (which would re-pick Baseline 3.0).
  'video/mp4;codecs=avc1.640034,mp4a.40.2',  // High 5.2  — up to 4096x2160
  'video/mp4;codecs=avc1.640033,mp4a.40.2',  // High 5.1  — up to 4096x2048 (tall portrait canvases)
  'video/mp4;codecs=avc1.640032,mp4a.40.2',  // High 5.0  — up to 3840x2160
  'video/mp4;codecs=avc1.64002A,mp4a.40.2',  // High 4.2  — up to 2048x1088
  'video/mp4;codecs=avc1.640028,mp4a.40.2',  // High 4.0  — up to 1920x1080
  'video/mp4;codecs=avc1.4D4028,mp4a.40.2',  // Main 4.0  — up to 1920x1080
  'video/mp4;codecs=avc1.42E028,mp4a.40.2',  // Baseline 4.0 — up to 1920x1080
  'video/mp4;codecs=avc1,mp4a',              // any AVC1 + any AAC — browser picks
  'video/mp4',                                // last MP4 resort — likely Baseline 3.0
  // WebM fallback. fix-webm-duration patches the EBML segment header so
  // Chrome plays the file; Samsung Gallery doesn't open WebM but VLC
  // does, so this branch is the "last-ditch saveable" path.
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const OPFS_STALE_MS = 10 * 60 * 1000;
const VIDEO_BITS_PER_SECOND = 4_000_000;     // 4 Mb/s — plenty for canvas/screen content,
                                             // halves memory + disk footprint vs the old 8 Mb/s default.

// Per-device "MP4 isn't working here, just use WebM" memory. Chrome
// reports MP4 as `isTypeSupported() === true` on Android while the
// hardware encoder throws EncodingError mid-stream — there's no way to
// detect this short of actually trying, so when we do try and fail we
// flip this flag in localStorage and skip all MP4 candidates from then
// on. The user can clear it by clearing site data (or we expose a reset
// later if needed).
const SKIP_MP4_KEY = 'voidstar.recorder.skipMp4';
function shouldSkipMp4() {
  try { return localStorage.getItem(SKIP_MP4_KEY) === '1'; } catch { return false; }
}
function rememberMp4Broken() {
  try { localStorage.setItem(SKIP_MP4_KEY, '1'); } catch {}
}

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const skipMp4 = shouldSkipMp4();
  for (const c of MIME_CANDIDATES) {
    if (skipMp4 && c.startsWith('video/mp4')) continue;
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
async function openSink(filename, { skipFsa = false } = {}) {
  // 1) Direct-to-disk via showSaveFilePicker (desktop only). On mobile,
  // we deliberately skip this — the picker streams chunks straight to
  // the user-chosen location, so by the time MediaRecorder stops, the
  // file is finalized and we can't apply fix-webm-duration before
  // saving. OPFS lets us read the file back at close, patch the
  // segment header, and only THEN trigger the download.
  //
  // skipFsa is set when the caller already consumed the transient user
  // activation on another API (notably getDisplayMedia for tab capture).
  // showSaveFilePicker would throw SecurityError in that case; OPFS +
  // anchor-download is the only viable sink left.
  if (!skipFsa && !looksLikeMobile() && typeof window !== 'undefined' && window.showSaveFilePicker) {
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
      // Use the name the user actually typed into the picker, not the
      // default we suggested. `handle.name` is the filename component of
      // the picked path (no directory prefix). This propagates through
      // to onReadyToSave so the anchor-download backup matches the FSA
      // save's filename instead of falling back to qualia-<timestamp>.
      const actualName = handle.name || filename;
      let totalWritten = 0;
      return {
        kind: 'fsa',
        write: (blob) => {
          totalWritten += blob.size;
          return writable.write(blob);
        },
        close: async () => {
          await writable.close();
          // Verify the file actually materialised. Chrome's FSA on Windows
          // has been observed to resolve writable.close() successfully but
          // leave nothing at the target path — the .crswap temp file
          // doesn't get renamed (antivirus quarantine, mark-of-the-web
          // intervention, or a Chromium FSA bug). Reading the file back
          // via the handle catches this: if we get an empty / missing
          // file but wrote N bytes, signal the recorder to fall back to
          // the in-memory blob + anchor-download path so the user still
          // gets their recording.
          let onDiskSize = -1;
          try {
            const file = await handle.getFile();
            onDiskSize = file.size;
          } catch (err) {
            console.warn(`[recorder] fsa: post-close verify failed: ${err?.name}: ${err?.message || err}`);
          }
          console.log(`[recorder] fsa: wrote ${totalWritten} bytes · on-disk ${onDiskSize} bytes · name="${actualName}"`);
          if (onDiskSize > 0 && onDiskSize >= totalWritten * 0.95) {
            // File is on disk with at least 95% of the bytes we wrote
            // (some FS implementations report slightly different sizes
            // due to alignment / sparse-file behavior; treat anything
            // close enough to written as success).
            return { autoSaved: true, blob: null, filename: actualName };
          }
          // The FSA path looks intact (no exception) but the file isn't
          // really there. Hand the caller back a null blob with
          // autoSaved=false so teardown's memChunks fallback can build a
          // recovery blob and the user gets prompted to download it.
          console.warn(
            `[recorder] fsa: file did not materialise (wrote=${totalWritten}, on-disk=${onDiskSize}) — falling back to in-memory recovery`
          );
          return { autoSaved: false, blob: null, filename: actualName };
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
 *   onStateChange?: (s: { recording: boolean, backend: ''|'composite'|'tab', sink: ''|'fsa'|'opfs'|'memory' }) => void,
 *   onReadyToSave?: (info: { filename: string, autoSaved: boolean, save: (() => Promise<void>)|null, failed: boolean, size: number }) => void,
 *   onError?: (err: Error) => void,
 *   getCanvas?: () => HTMLCanvasElement|null,
 *   getRecordableStream?: () => MediaStream|null,
 *   getCaptureMode?: () => 'viewport'|'tab',
 *   onCaptureStart?: () => void,
 *   onCaptureEnd?: () => void,
 * }} opts
 *
 * Two capture modes:
 *   - 'viewport' (default): captures a composite canvas the page maintains,
 *     containing fx + overlay layers. Zero per-frame DOM work, no
 *     screen-share dialog, clean viewport-only output. Uses FSA / OPFS
 *     for direct-to-disk save.
 *   - 'tab': uses getDisplayMedia({preferCurrentTab: true}) to capture
 *     the whole tab (including strudel REPL + sequencer + any open
 *     panels). One share-picker click at start. Mix bus is still used
 *     for audio (tab-audio capture would miss the mic). FSA is unavailable
 *     after getDisplayMedia consumed the user activation, so the file
 *     streams to OPFS and downloads via anchor.click() at stop.
 *
 * For viewport mode, `getCanvas` returns the composite canvas and
 * `onCaptureStart` / `onCaptureEnd` let the page gate its per-frame
 * composite update loop so the drawImage cost only fires while recording.
 */
export function createRecorder(opts = {}) {
  /** @type {MediaStream|null} */
  let stream = null;
  /** @type {MediaRecorder|null} */
  let recorder = null;
  let startedAt = 0;
  let mimeType = '';
  /** @type {''|'composite'} */
  let backend = '';
  /** @type {Awaited<ReturnType<typeof openSink>>|null} */
  let sink = null;
  let writeChain = Promise.resolve();
  let stopping = false;
  // Tracks we cloned and attached to the recorder stream (mix bus / mic).
  // Held so teardown can stop them and break the reference cycle that
  // would otherwise keep the underlying source streams alive past the
  // recording. The composite canvas's own video track is owned by the
  // capture stream and stopped via `stream.getTracks()`.
  /** @type {MediaStreamTrack[]} */
  let attachedAudio = [];
  // Belt-and-braces: also collect every chunk in memory while recording.
  // OPFS streaming was producing 0-byte and "header-only" MP4s on Chrome
  // Android — the in-memory copy is used as a fallback when the sink blob
  // comes back smaller than what we received, so a buggy OPFS path can't
  // silently throw away the recording.
  let memChunks = [];
  let memBytes  = 0;
  // Set by recorder.onerror — any bytes we recover after this are from a
  // crashed encoder mid-stream, not a usable file. teardown checks this
  // before offering an auto-save so we don't hand the user a broken MP4
  // that triggers Chrome's "Download error" or installs into Gallery as
  // an unplayable thumbnail.
  let erroredOut = false;
  // Tracks whether opts.onCaptureStart() has been fired without a
  // matching onCaptureEnd. Without this, an error after the composite
  // started but before MediaRecorder ran would leave the composite frame
  // loop running indefinitely.
  let captureBegun = false;

  function notify() {
    opts.onStateChange?.({
      recording: !!recorder,
      backend,
      sink: sink?.kind || '',
    });
  }

  function endCapture() {
    if (!captureBegun) return;
    captureBegun = false;
    try { opts.onCaptureEnd?.(); } catch (err) {
      console.warn('[recorder] onCaptureEnd threw:', err);
    }
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
    // Stop the cloned audio tracks we attached to the recorder. The
    // underlying mix-bus + mic sources remain live for the rest of the
    // page — only OUR clones go away.
    for (const t of attachedAudio) { try { t.stop(); } catch {} }
    attachedAudio = [];
    endCapture();
    recorder = null;
    startedAt = 0;
    backend = '';
    stopping = false;
    notify();
    if (!s) return;
    if (success) {
      try {
        const info = await s.close();
        let blob = info.blob;
        // Fallback to the in-memory chunks if the sink came back empty
        // or way smaller than what we actually wrote. This recovers from
        // Chrome Android's intermittent "OPFS writable.close() returns a
        // zero-byte file even though we wrote N bytes through it" bug.
        // We also build the memBlob on the FSA success path so the page
        // can offer a "save backup" download — Chrome on Windows has
        // been observed to claim FSA writes succeeded while the file is
        // missing from the picked location (AV / SmartScreen / OneDrive
        // sync intervention after close). The backup gives the user a
        // second route to the recording if their FSA save vanished.
        const needFallback = !info.autoSaved && (!blob || blob.size < memBytes);
        const buildBackup  = info.autoSaved && memChunks.length;
        if ((needFallback || buildBackup) && memChunks.length) {
          const memBlob = new Blob(memChunks, { type: wasMime || 'video/mp4' });
          if (needFallback) {
            console.warn(
              `[recorder] sink blob ${blob?.size ?? 'null'} bytes < in-memory ${memBlob.size}` +
              ` — falling back to memory copy`
            );
          }
          blob = memBlob;
        }
        memChunks = [];
        memBytes  = 0;
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
        // Auto-save eligibility:
        //   - autoSaved (FSA): file is already at the user-picked
        //     location, just confirm.
        //   - normal success: blob exists with non-zero size, offer save.
        //   - errored encoder: refuse save even if we have bytes — those
        //     bytes are a truncated stream from a crashed muxer and would
        //     install in Gallery as an unplayable thumbnail or fail the
        //     download outright.
        const sizeBytes = blob?.size ?? 0;
        const recoverable = !erroredOut && sizeBytes > 0;
        const hasData = info.autoSaved || recoverable;
        const save = recoverable
          ? () => { triggerDownload(blob, info.filename); return Promise.resolve(); }
          : null;
        opts.onReadyToSave?.({
          filename:  info.filename,
          autoSaved: info.autoSaved,
          save,
          failed:    !hasData,
          size:      sizeBytes,
        });
      } catch (err) {
        opts.onError?.(err);
      }
    } else {
      try { await s.cleanup(); } catch {}
    }
  }

  function startMediaRecorder(s) {
    const recOpts = { videoBitsPerSecond: VIDEO_BITS_PER_SECOND };
    if (mimeType) recOpts.mimeType = mimeType;
    recorder = new MediaRecorder(s, recOpts);
    recorder.ondataavailable = (e) => {
      // Always push non-empty chunks into the memory backup, even if the
      // sink has already been torn down (e.g. EncodingError fired
      // onerror → stop → teardown, and now a late flush is arriving).
      // teardown's memChunks→blob fallback runs before we clear the
      // array so any post-error data still gets a chance to be saved.
      if (!e.data || e.data.size === 0) {
        console.log(`[recorder] chunk · ${e.data?.size ?? 'null'} bytes — empty`);
        return;
      }
      memChunks.push(e.data);
      memBytes += e.data.size;
      console.log(
        `[recorder] chunk · ${e.data.size} bytes${stopping ? ' (final flush)' : ''}` +
        ` · total ${memBytes}${sink ? '' : ' (sink closed, memory only)'}`
      );
      if (!sink) return;
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
      erroredOut = true;
      // If MP4 just blew up at the encoder layer, persist a flag so we
      // skip MP4 candidates on this device for future recordings. Chrome
      // Android's hardware encoder regularly throws EncodingError on the
      // MP4 path even when isTypeSupported says yes — switching to WebM
      // sidesteps the muxer entirely and produces a file that plays.
      const isEncodingError = err?.name === 'EncodingError'
        || /encoder configuration/i.test(err?.message || '');
      if (isEncodingError && mimeType?.startsWith('video/mp4')) {
        console.warn(`[recorder] MP4 encoder rejected the config (${err?.message || err}) — remembering this device as MP4-broken, future recordings will use WebM`);
        rememberMp4Broken();
      }
      opts.onError?.(err);
      if (!stopping) stop();
    };
    recorder.start(1000);
    startedAt = performance.now();
    stream = s;
    notify();
  }

  function attachMixBusAudio(s) {
    // Mix bus carries every in-page audio source (mic + strudel +
    // sequencer + vocoder + …) merged into one track. We clone the track
    // so the recorder owns its lifetime — stopping our clone at teardown
    // doesn't disturb the mix bus, which the rest of the page may still
    // be reading via the audio analyser. The bus is materialised eagerly
    // by audio.getRecordableStream() even when no source is currently
    // active, so sources that come online mid-recording (user enables
    // mic, hits play on strudel) feed into our already-attached track.
    const mix = opts.getRecordableStream?.();
    const mixTracks = mix?.getAudioTracks() ?? [];
    for (const t of mixTracks) {
      try {
        const cloned = t.clone();
        s.addTrack(cloned);
        attachedAudio.push(cloned);
      } catch (err) {
        console.warn('[recorder] failed to attach mix track:', err);
      }
    }
    if (mixTracks.length === 0) {
      console.warn('[recorder] no audio source registered; recording will be silent');
    }
  }

  function buildCompositeStream() {
    // Tell the page to start its per-frame composite (fx + overlay → record
    // canvas). Page hooks may throw if the composite is unavailable; in
    // that case we surface the error to start() which cleans up the sink.
    opts.onCaptureStart?.();
    captureBegun = true;

    const canvas = opts.getCanvas?.();
    if (!canvas?.captureStream) {
      throw new Error('Recording requires a canvas with captureStream support');
    }
    // 30fps balances mobile encoder load with visual continuity. The
    // composite update runs at the page's rAF cadence (usually 60fps);
    // captureStream samples this canvas at the requested rate.
    const s = canvas.captureStream(30);
    attachMixBusAudio(s);
    return s;
  }

  async function buildTabCaptureStream() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Tab capture not supported on this device');
    }
    // Picker UX:
    //   displaySurface 'browser' + preferCurrentTab → current tab is the
    //     default offered in the share dialog (one click to confirm).
    //   selfBrowserSurface 'include' → makes the current tab actually
    //     selectable (some Chrome versions hide it by default to prevent
    //     "hall of mirrors" loops; for our self-capture it's the only
    //     surface we want).
    //   surfaceSwitching 'exclude' → no "Share a different tab" button on
    //     the indicator pill; we're a one-tab capture, not a meeting app.
    //   monitorTypeSurfaces 'exclude' → don't even offer "Entire screen"
    //     in the picker; trims a misclick path.
    //   audio: false → tab-audio capture would miss the mic anyway, and
    //     asking for it would mean a redundant "share tab audio" toggle.
    //     We use the in-page mix bus (mic + strudel + sequencer + …)
    //     for audio instead, same as viewport mode.
    //
    // The "<site> is sharing this tab" notification bar that appears at
    // the top of the page while recording is rendered by the Chrome
    // browser itself as a privacy indicator — there is no page-JS option
    // to suppress it (see crbug.com / Chrome DevTools "Privacy-preserving
    // screen sharing controls"). The only way to hide it during recording
    // is the user pressing F11 to enter fullscreen before recording —
    // browser chrome (including the indicator bar) is then hidden until
    // they Esc back out. We could nudge users toward that in the UI, but
    // we don't force it because some users actually want the bar visible
    // as a "still recording" reminder.
    const tabStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 60 },
      preferCurrentTab:    true,
      selfBrowserSurface:  'include',
      surfaceSwitching:    'exclude',
      monitorTypeSurfaces: 'exclude',
      audio: false,
    });
    const videoTrack = tabStream.getVideoTracks()[0];
    if (!videoTrack) {
      try { tabStream.getTracks().forEach(t => t.stop()); } catch {}
      throw new Error('Tab capture returned no video track');
    }
    // If the user revokes sharing via Chrome's "Stop sharing" UI badge,
    // the video track ends — wire that to recorder.stop() so the rec
    // button and toast clear and the file gets flushed instead of just
    // hanging in an inactive state.
    videoTrack.addEventListener('ended', () => stop());

    const s = new MediaStream();
    s.addTrack(videoTrack);
    // Discard any tab-audio track the browser handed us (we set audio:
    // false above so this shouldn't fire, but belt-and-braces).
    for (const t of tabStream.getAudioTracks()) {
      try { t.stop(); } catch {}
    }
    attachMixBusAudio(s);
    return s;
  }

  async function start() {
    if (recorder) return;
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder not supported in this browser');
    }
    sweepStaleOpfs().catch(() => {});

    const mode = opts.getCaptureMode?.() ?? 'viewport';

    // Pick mime + filename first so the file picker can suggest a name.
    // pickMime() is synchronous — it doesn't consume user activation, so
    // doing this before openSink is fine and lets the picker offer the
    // right extension.
    mimeType = pickMime();
    const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `qualia-${ts}.${ext}`;

    // Two activation-consuming APIs in play: showSaveFilePicker (FSA
    // sink) and getDisplayMedia (tab capture). Only one can run per
    // click. For viewport mode we want FSA → composite (no
    // getDisplayMedia at all). For tab mode we sacrifice FSA so
    // getDisplayMedia can have the activation; the sink falls back to
    // OPFS + anchor-download.
    let s;
    if (mode === 'tab') {
      // Tab capture FIRST — consumes activation. We then open an OPFS
      // (or memory) sink which doesn't need a fresh activation.
      try {
        s = await buildTabCaptureStream();
      } catch (err) {
        throw err;   // AbortError / NotAllowedError propagate to caller
      }
      try {
        sink = await openSink(filename, { skipFsa: true });
      } catch (err) {
        try { s.getTracks().forEach(t => t.stop()); } catch {}
        for (const t of attachedAudio) { try { t.stop(); } catch {} }
        attachedAudio = [];
        throw err;
      }
      backend = 'tab';
    } else {
      // Viewport mode: showSaveFilePicker first to preserve activation
      // for the picker (no getDisplayMedia is called in this path).
      sink = await openSink(filename);
      try {
        s = buildCompositeStream();
      } catch (err) {
        try { await sink.cleanup(); } catch {}
        sink = null;
        endCapture();
        throw err;
      }
      backend = 'composite';
    }

    writeChain = Promise.resolve();
    stopping  = false;
    memChunks = [];
    memBytes  = 0;
    erroredOut = false;
    try {
      startMediaRecorder(s);
    } catch (err) {
      // MediaRecorder constructor / start can throw on unsupported mime
      // or invalid state. Roll back the sink + composite + audio clones so
      // the page is back to its idle state before we re-raise.
      try { s.getTracks().forEach(t => t.stop()); } catch {}
      for (const t of attachedAudio) { try { t.stop(); } catch {} }
      attachedAudio = [];
      endCapture();
      try { await sink.cleanup(); } catch {}
      sink = null;
      backend = '';
      throw err;
    }
    // Diagnostics — visible via remote-debug (chrome://inspect on a
    // tethered Android device) so we can confirm sink + audio attachment
    // without needing extra logging surface.
    const audioTracks = s.getAudioTracks();
    const videoTracks = s.getVideoTracks();
    // Log the actual video track resolution we're feeding the encoder —
    // canvas.captureStream picks up canvas.width/height (DPR-scaled), which
    // on a phone can easily exceed an H.264 level's macroblock cap and
    // produce an EncodingError on the first frame. If recordings are
    // failing this is the first number to check against the chosen codec
    // level's max resolution.
    const vSettings = videoTracks[0]?.getSettings?.() || {};
    const vDims = (vSettings.width && vSettings.height)
      ? `${vSettings.width}x${vSettings.height}@${vSettings.frameRate || '?'}fps`
      : 'unknown';
    console.log(
      `[recorder] started · backend=${backend} sink=${sink?.kind}` +
      ` mime=${mimeType || '(default)'}` +
      ` · video=${videoTracks.length} (${vDims}) audio=${audioTracks.length}` +
      (audioTracks.length ? ` (${audioTracks.map(t => t.label || '(unlabeled)').join(', ')})` : ' [SILENT]')
    );
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
      // The composite canvas + captureStream are checked at start() time
      // when the qualia canvas definitely exists; if either is unavailable,
      // start() surfaces a real error then. Returning true here lets the
      // button stay tappable so the user can trigger the real attempt
      // themselves.
      return typeof MediaRecorder !== 'undefined';
    },
  };
}
