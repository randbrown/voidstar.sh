// app-capture.js — another app's audio (Spotify, YouTube, a DAW…) as a qualia source.
//
// The "make the visuals react to whatever's playing on this machine" path. It
// uses the browser's screen-share picker (getDisplayMedia) purely for its audio
// track: the user picks a tab / window / screen and ticks "share audio", and that
// audio drives the reactivity and lands in the recordable mix.
//
// ── What the browser actually allows ──────────────────────────────────────
// Audio capture via getDisplayMedia is Chromium-only (Chrome / Edge / Brave /
// Opera, desktop). Firefox and Safari return a video-only stream, and mobile
// browsers can't do display capture at all. Within Chromium:
//   - a browser TAB: works on every OS (so Spotify's web player or YouTube in
//     another tab is the universal route);
//   - the ENTIRE SCREEN on Windows and ChromeOS: shares system audio, i.e. the
//     Spotify desktop app or any other app;
//   - macOS / Linux: no system-audio option in the picker (Chrome 13x+ on macOS
//     13+ can offer it; older builds can't). For a native app there, route it
//     through a loopback device (BlackHole / Loopback on macOS, a PipeWire/Pulse
//     monitor on Linux) and pick that as the plain mic input instead.
// We can't detect any of this up front — the picker decides — so a stream with
// no audio track is surfaced as a clear error rather than silently doing nothing.
//
// ── Architecture fit ──────────────────────────────────────────────────────
// Like audio-file.js, it owns a PRIVATE AudioContext and hands an analyser to
// page-init, which adopts it as the 'app' source (`audio.adoptAnalyser`) — so it
// drives the visuals and the recording for free, gated by the audio mode's filter.
//
//   captured audio track → source → analyser   (reactivity + record tap only)
//
// Deliberately NOT routed to ctx.destination: the captured app is already
// playing through the speakers, so monitoring it here would double it (and with
// "entire screen" capture, feed back into itself).
//
// Chromium insists on a video track alongside the audio. We ask for a tiny 1 fps
// one to keep the capture cheap and leave it running (stopping it can end the
// whole share on some builds); it's never read.
//
// ── Lookback ring (grab a lick into the deck) ─────────────────────────────
// While a capture runs, the captured audio also feeds the looper's recorder
// worklet (worklets/looper-recorder.js, never armed here) — its always-on
// ~40 s ring on the audio thread. `grab(seconds)` posts back the last N seconds
// as per-channel Float32Arrays, which page-init loads into the deck to loop /
// slow down. Costs one block copy per render quantum on the audio thread and
// ~15 MB while capturing; nothing at all when capture is off.
//
//   captured audio track → source ─┬→ analyser
//                                  └→ ring worklet → 0-gain sink → destination
// (the sink only keeps the worklet pulled; it outputs silence, so the captured
// app is still never monitored twice).

import { registerContext, resumeContext } from './audio-unlock.js';
// `?url&no-inline` so Vite emits the worklet as a file addModule() can load
// (same as looper-audio.js).
import recorderWorkletUrl from './worklets/looper-recorder.js?url&no-inline';

function makeCaptureContext(track) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let rate = 0;
  try { rate = track.getSettings?.().sampleRate || 0; } catch {}
  if (!(rate >= 8000 && rate <= 192000)) rate = 48000;
  try { return new AC({ sampleRate: rate }); } catch { return new AC(); }
}

// Matches RING_SECONDS in worklets/looper-recorder.js.
export const RING_SECONDS = 40;

export function createAppCapture(opts = {}) {
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

  let stream = null, ctx = null, srcNode = null, analyser = null;
  let ringNode = null, sink = null, ringStartT = 0;
  let label = '';
  let grabId = 0;
  const pendingGrabs = new Map();

  /** True when the browser exposes display capture at all. Audio support can
   *  only be confirmed by the stream that comes back. */
  function isSupported() {
    return !!navigator.mediaDevices?.getDisplayMedia;
  }

  function isActive() { return !!(stream && analyser); }

  async function start() {
    if (!isSupported()) throw new Error('This browser can\'t capture other apps\' audio (needs desktop Chrome / Edge).');
    await stop();
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: { ideal: 320 }, height: { ideal: 180 } },
      audio: {
        // Raw music, not a voice call — the speech processing would gut it.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // Keep the source tab audible (some builds default this on).
        suppressLocalAudioPlayback: false,
      },
      // Chromium hints: offer system audio on the screen tab, and don't put the
      // qualia tab itself in the list (capturing ourselves would loop).
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
    const track = s.getAudioTracks()[0];
    if (!track) {
      s.getTracks().forEach(t => t.stop());
      throw new Error('No audio was shared. Pick a browser tab (or "Entire screen" on Windows / ChromeOS) and turn on "Share audio" in the picker.');
    }
    stream = s;
    // Run the capture context at the TRACK's rate (tab / system audio is 48 kHz
    // in Chromium). A MediaStreamSource in a context at another rate (a 44.1 kHz
    // output device is common) gets resampled on the fly, and that path drops
    // and repeats blocks — inaudible as a reactivity feed, but a grab of it
    // comes out garbled and off-pitch. The context never plays to the speakers
    // (only a 0-gain sink), so its rate needn't match the output.
    ctx = registerContext(makeCaptureContext(track));
    // Awaiting the picker spends the user-gesture activation; bounded resume
    // (audio-unlock.js retries on the next gesture if this one hangs).
    await resumeContext(ctx);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;               // same shape as the mic source
    analyser.smoothingTimeConstant = 0.40;
    srcNode = ctx.createMediaStreamSource(new MediaStream([track]));
    srcNode.connect(analyser);
    await attachRing();
    label = describe(s, track);
    // The user can end the share from the browser's own "Stop sharing" bar.
    for (const t of s.getTracks()) t.addEventListener('ended', () => { if (stream === s) void stop(); });
    onChange();
    return label;
  }

  // Hang the lookback ring off the source. Best-effort: if the worklet can't
  // load, capture still drives the visuals and grab reports it's unavailable.
  async function attachRing() {
    const c = ctx;
    try {
      if (!c?.audioWorklet?.addModule) return;
      await c.audioWorklet.addModule(recorderWorkletUrl);
      if (ctx !== c || !srcNode) return;               // stopped while loading
      ringNode = new AudioWorkletNode(c, 'looper-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      });
      ringNode.port.onmessage = (e) => {
        const d = e.data;
        if (d?.grab === undefined) return;
        const resolve = pendingGrabs.get(d.grab);
        if (resolve) { pendingGrabs.delete(d.grab); resolve(d); }
      };
      sink = c.createGain();
      sink.gain.value = 0;
      srcNode.connect(ringNode);
      ringNode.connect(sink);
      sink.connect(c.destination);
      ringStartT = c.currentTime;
    } catch (err) {
      console.warn('[qualia] app-capture lookback ring unavailable:', err);
      ringNode = null;
    }
  }

  /** Seconds of lookback held so far (0 when there's no ring). */
  function ringSeconds() {
    if (!ringNode || !ctx) return 0;
    return Math.min(RING_SECONDS, Math.max(0, ctx.currentTime - ringStartT));
  }

  /** The last `seconds` of captured audio as `{ chans, sampleRate }`, or null
   *  if nothing is captured / held yet. */
  function grab(seconds) {
    if (!ringNode) return Promise.resolve(null);
    const id = ++grabId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pendingGrabs.delete(id); resolve(null); }, 2000);
      pendingGrabs.set(id, (d) => {
        clearTimeout(timer);
        resolve(d?.chans?.length ? { chans: d.chans, sampleRate: d.sampleRate || ctx?.sampleRate || 48000 } : null);
      });
      try { ringNode.port.postMessage({ cmd: 'grab', seconds, id }); }
      catch { clearTimeout(timer); pendingGrabs.delete(id); resolve(null); }
    });
  }

  function describe(s, audioTrack) {
    const v = s.getVideoTracks()[0];
    const surface = v?.getSettings?.().displaySurface;
    // Chromium labels look like "window:160:0" / "screen:1:0" / "web-contents-media-stream://…".
    const name = (v?.label || audioTrack.label || '')
      .replace(/^(web-contents-media-stream|screen|window):\/\/\S*/i, '')
      .replace(/^(screen|window):\d+(:\d+)*$/i, '')
      .trim();
    // The audio track's reported rate, for troubleshooting a garbled capture.
    let rate = '';
    try { const r = audioTrack.getSettings?.().sampleRate; if (r) rate = ` · ${Math.round(r / 100) / 10}k`; } catch {}
    if (surface === 'browser') return (name ? `tab · ${name}` : 'browser tab') + rate;
    if (surface === 'monitor') return 'system audio' + rate;
    if (surface === 'window')  return (name ? `window · ${name}` : 'window') + rate;
    return (name || 'app audio') + rate;
  }

  async function stop() {
    const was = isActive();
    const s = stream, c = ctx;
    stream = null; ctx = null; analyser = null; label = '';
    // Let page-init release the adopted source before its ctx goes away.
    if (was) onChange();
    try { srcNode?.disconnect(); } catch {}
    srcNode = null;
    // Free the ~15 MB ring (the processor ends itself on 'dispose').
    if (ringNode) { try { ringNode.port.postMessage({ cmd: 'dispose' }); ringNode.disconnect(); } catch {} }
    try { sink?.disconnect(); } catch {}
    ringNode = null; sink = null;
    for (const resolve of pendingGrabs.values()) resolve(null);
    pendingGrabs.clear();
    if (s) { try { s.getTracks().forEach(t => t.stop()); } catch {} }
    if (c) { try { await c.close(); } catch {} }
  }

  return {
    isSupported,
    isActive,
    start,
    stop,
    grab,
    ringSeconds,
    canGrab:         () => !!ringNode,
    getLabel:        () => label,
    getContext:      () => ctx,
    getFeedAnalyser: () => analyser,
  };
}
