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

import { registerContext, resumeContext } from './audio-unlock.js';

export function createAppCapture(opts = {}) {
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

  let stream = null, ctx = null, srcNode = null, analyser = null;
  let label = '';

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
    ctx = registerContext(new (window.AudioContext || window.webkitAudioContext)());
    // Awaiting the picker spends the user-gesture activation; bounded resume
    // (audio-unlock.js retries on the next gesture if this one hangs).
    await resumeContext(ctx);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;               // same shape as the mic source
    analyser.smoothingTimeConstant = 0.40;
    srcNode = ctx.createMediaStreamSource(new MediaStream([track]));
    srcNode.connect(analyser);
    label = describe(s, track);
    // The user can end the share from the browser's own "Stop sharing" bar.
    for (const t of s.getTracks()) t.addEventListener('ended', () => { if (stream === s) void stop(); });
    onChange();
    return label;
  }

  function describe(s, audioTrack) {
    const v = s.getVideoTracks()[0];
    const surface = v?.getSettings?.().displaySurface;
    const name = (v?.label || audioTrack.label || '').replace(/^(web-contents-media-stream|screen|window):\/\/\S*/i, '').trim();
    if (surface === 'browser') return name ? `tab · ${name}` : 'browser tab';
    if (surface === 'monitor') return 'system audio';
    if (surface === 'window')  return name ? `window · ${name}` : 'window';
    return name || 'app audio';
  }

  async function stop() {
    const was = isActive();
    const s = stream, c = ctx;
    stream = null; ctx = null; analyser = null; label = '';
    // Let page-init release the adopted source before its ctx goes away.
    if (was) onChange();
    try { srcNode?.disconnect(); } catch {}
    srcNode = null;
    if (s) { try { s.getTracks().forEach(t => t.stop()); } catch {} }
    if (c) { try { await c.close(); } catch {} }
  }

  return {
    isSupported,
    isActive,
    start,
    stop,
    getLabel:        () => label,
    getContext:      () => ctx,
    getFeedAnalyser: () => analyser,
  };
}
