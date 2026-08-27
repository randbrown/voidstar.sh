// audio-file.js — play an existing audio file (mp3/wav/…) as a qualia source.
//
// The "run a finished track through qualia" path. Decode a file (or URL) into
// an AudioBuffer and play it back with a real transport (play/pause/seek/loop/
// level), so a projected set can be built around a recording — steel or guitar
// played live over the top via the rig, both driving the visuals and both
// landing in the screen recording.
//
// ── Architecture fit ──────────────────────────────────────────────────────
// Like the modem and vocoder, the player owns a PRIVATE AudioContext so it
// reaches the speakers without entangling the analysis path or Strudel's
// destination mute-patch. It hangs a limiter.js brickwall before destination
// (house rule), tags its output `__qualiaBypassMute` (belt-and-braces), and
// tees an analyser off its bus so page-init can
// `audio.adoptAnalyser(ctx, analyser, 'file')` — which makes the track drive
// the visuals and land in recordings for free, gated (like every source) by
// the current audio mode's filter.
//
//   buffer → source → level gain → limiter → destination
//                          └────────────────► analyser (reactivity + record tap)
//
// Transport note: a Web-Audio `AudioBufferSourceNode` is single-shot — it can't
// be paused and resumed. Play/pause/seek are therefore modelled the standard
// way: we hold the decoded buffer, track a play offset, and on each play spin up
// a fresh source `start(0, offset)` while remembering `startTime = now - offset`
// so `position()` is `ctx.currentTime - startTime`. Pause/seek stop the live
// source and bank the offset. Nothing runs on the audio thread; a light ~10 Hz
// timer only ticks while playing, purely to push the scrubber position to the UI.

import { makeLimiter } from './limiter.js';

export function createAudioFilePlayer(opts = {}) {
  const onFeedChange = typeof opts.onFeedChange === 'function' ? opts.onFeedChange : () => {};
  const onState      = typeof opts.onState === 'function' ? opts.onState : () => {};

  // Transport subscribers — fired with a phase string on every real transport
  // edge ('play' | 'pause' | 'stop' | 'ended'). page-init drives the
  // playback-synced recorder off these (start before play, stop on end).
  const transportSubs = new Set();
  function fireTransport(phase) {
    for (const fn of transportSubs) { try { fn(phase); } catch { /* subscriber teardown */ } }
  }

  let ctx = null, bus = null, limiter = null, analyser = null;
  let buffer = null;          // decoded AudioBuffer (null until a file loads)
  let name = '';              // display name of the loaded file
  let src = null;             // live AudioBufferSourceNode while playing
  let level = 1.0;            // output level (0..~1.5), rides `bus.gain`
  let loop = false;
  let playing = false;
  let offset = 0;             // seconds into the buffer where the next play starts
  let startTime = 0;          // ctx.currentTime at which the current source's t=0 sits
  let _expectStop = false;    // guards onended against our own stop()/seek() calls
  let _tick = null;           // UI position-push interval (only while playing)
  let _resumeOnUnpause = false; // page pause gate remembers whether we were playing

  // Lazily build the graph — an AudioContext created before a user gesture
  // starts suspended and stays silent.
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    bus = ctx.createGain();
    bus.gain.value = level;
    limiter = makeLimiter(ctx, true);        // brickwall before destination
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    bus.connect(limiter);
    bus.connect(analyser);                    // tee analysis off the pre-limiter bus
    limiter.connect(ctx.destination);
    limiter.__qualiaBypassMute = true;        // never silenced by Strudel's mute gate
    return ctx;
  }

  function emitState() {
    try { onState(getState()); } catch { /* UI teardown */ }
  }

  // Current playback head, clamped to the buffer.
  function position() {
    if (!buffer) return 0;
    if (!playing) return Math.min(offset, buffer.duration);
    const p = ctx.currentTime - startTime;
    if (loop && buffer.duration > 0) return p % buffer.duration;
    return Math.min(Math.max(0, p), buffer.duration);
  }

  function startTicker() {
    if (_tick) return;
    _tick = setInterval(emitState, 100);   // ~10 Hz scrubber push, only while playing
  }
  function stopTicker() {
    if (_tick) { clearInterval(_tick); _tick = null; }
  }

  // Tear down the live source (banking nothing — callers set `offset`).
  function killSource() {
    if (!src) return;
    _expectStop = true;
    try { src.onended = null; src.stop(); } catch { /* already stopped */ }
    try { src.disconnect(); } catch {}
    src = null;
    _expectStop = false;
  }

  // Spin up a fresh source from the current `offset` and go.
  function startSource() {
    ensure();
    ctx.resume?.();
    killSource();
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = loop;
    s.connect(bus);
    s.onended = () => {
      if (_expectStop) return;              // our own stop()/seek() — ignore
      // Natural end of a non-looping track: park at the top, released from the mix.
      playing = false;
      offset = 0;
      stopTicker();
      src = null;
      onFeedChange();
      emitState();
      fireTransport('ended');
    };
    const at = Math.min(Math.max(0, offset), buffer.duration);
    startTime = ctx.currentTime - at;
    s.start(0, at);
    src = s;
  }

  const api = {
    getContext:      () => ctx,
    getFeedAnalyser: () => analyser,
    isReady:         () => !!buffer,
    isPlaying:       () => playing,
    /** Adopt gate: present in the analysis + record mix only while sounding. */
    isActive:        () => playing,
    getName:         () => name,
    getDuration:     () => (buffer ? buffer.duration : 0),
    getPosition:     () => position(),
    getLevel:        () => level,
    getLoop:         () => loop,

    /** Decode `input` (a File, Blob, ArrayBuffer, or URL string) and load it as
     *  the current track, replacing any prior one. Returns true on success.
     *  Stops playback first — loading a new track never leaves the old one
     *  sounding. `label` overrides the display name (defaults to the file name
     *  or the URL's last path segment). */
    load: async (input, label) => {
      ensure();
      api.stop();
      let arr, guessed = label || '';
      try {
        if (typeof input === 'string') {
          if (!guessed) { try { guessed = decodeURIComponent(input.split(/[?#]/)[0].split('/').pop() || 'track'); } catch { guessed = 'track'; } }
          const res = await fetch(input);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          arr = await res.arrayBuffer();
        } else if (input instanceof ArrayBuffer) {
          arr = input;
        } else if (input && typeof input.arrayBuffer === 'function') {   // File / Blob
          if (!guessed) guessed = input.name || 'track';
          arr = await input.arrayBuffer();
        } else {
          throw new Error('unsupported input');
        }
        // decodeAudioData detaches its input; we decode once and never reuse it.
        const decoded = await ctx.decodeAudioData(arr);
        buffer = decoded;
        name = guessed;
        offset = 0;
        emitState();
        return true;
      } catch (e) {
        console.warn('[qualia] audio-file: load failed:', e);
        emitState();
        return false;
      }
    },

    /** Start (or restart) playback from the current position. */
    play: () => {
      if (!buffer || playing) return;
      ensure();
      if (offset >= buffer.duration) offset = 0;   // was parked at the end
      startSource();
      playing = true;
      startTicker();
      onFeedChange();                              // page-init adopts while we sound
      emitState();
      fireTransport('play');
    },

    /** Pause, banking the current position for the next play(). */
    pause: () => {
      if (!playing) return;
      offset = position();
      killSource();
      playing = false;
      stopTicker();
      onFeedChange();                              // release the adopted analyser
      emitState();
      fireTransport('pause');
    },

    toggle: () => { if (playing) api.pause(); else api.play(); },

    /** Seek to `sec`. Keeps playing if we were playing. */
    seek: (sec) => {
      if (!buffer) return;
      const t = Math.min(Math.max(0, +sec || 0), buffer.duration);
      offset = t;
      if (playing) startSource();                  // restart the live source at t
      emitState();
    },

    /** Stop and rewind to the top; drop out of the mix. */
    stop: () => {
      killSource();
      const was = playing;
      playing = false;
      offset = 0;
      stopTicker();
      if (was) onFeedChange();
      emitState();
      fireTransport('stop');
    },

    /** Subscribe to transport edges ('play'|'pause'|'stop'|'ended'). Returns an
     *  unsubscribe fn. */
    onTransport: (fn) => { transportSubs.add(fn); return () => transportSubs.delete(fn); },

    setLoop: (on) => {
      loop = !!on;
      if (src) src.loop = loop;                    // affects the live source too
      emitState();
    },

    setLevel: (v) => {
      level = Math.min(2, Math.max(0, +v || 0));
      if (bus) bus.gain.setTargetAtTime(level, ctx.currentTime, 0.01);
      emitState();
    },

    /** Full snapshot for the UI / code API. */
    getState: getState,

    /** Page pause/Space gate. Pauses playback and, on unpause, resumes it iff
     *  we were playing — so the page transport carries the track with it. */
    setPaused: (on) => {
      if (on) {
        _resumeOnUnpause = playing;
        if (playing) api.pause();
      } else if (_resumeOnUnpause) {
        _resumeOnUnpause = false;
        api.play();
      }
    },

    dispose: () => {
      api.stop();
      buffer = null; name = '';
      try { analyser?.disconnect(); } catch {}
      try { bus?.disconnect(); } catch {}
      try { limiter?.disconnect(); } catch {}
      if (ctx) { try { ctx.close(); } catch {} ctx = null; }
    },
  };

  function getState() {
    return {
      ready:    !!buffer,
      playing,
      loop,
      level,
      name,
      duration: buffer ? buffer.duration : 0,
      position: position(),
    };
  }

  return api;
}
