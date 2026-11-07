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
//
// ── Lick practice ─────────────────────────────────────────────────────────
// The deck doubles as a practice player: an A/B loop region, a speed control
// (25–150 %), pitch lock (time-stretch so a slowed lick keeps its key), a
// ± semitone transpose, and a speed trainer that adds a step every few passes.
// Two playback paths, picked per play:
//   - plain BufferSource (rate 1, or rate ≠ 1 with pitch lock off = varispeed);
//   - Signalsmith Stretch (looper-stretch.js) when the pitch has to be held or
//     moved. Lazy: the WASM + worklet load the first time a locked slow-down or
//     transpose is asked for, and the node idles inactive otherwise.
// A loop region plays from a short COPY of the region with an 8 ms equal-power
// seam baked in (deck-practice.js), so a lick loop never clicks at the wrap and
// the stretcher only ever holds a few seconds of audio. The head position is
// analytic (anchor + elapsed × rate, wrapped in the loop window) on both paths.
// `loadBuffer()` takes raw PCM — that's how a grab from app audio lands here.

import { makeLimiter, setLimiterEngaged } from './limiter.js';
import { createStretchNode } from './looper-stretch.js';
import {
  clampRate, clampTranspose, resolveRegion, headPosition, startOffset,
  stretchSemitones, needsStretch, bakeRegionSeam, trainerAdvance, SEAM_FADE_SEC,
} from './deck-practice.js';

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

  // Mix subscribers — fired on any level / mute / limiter change so the mixer
  // channel (and any other surface) mirrors a control moved elsewhere. Kept
  // separate from onState so it's cheap and mixer-focused.
  const mixSubs = new Set();
  function fireMix() {
    for (const fn of mixSubs) { try { fn(); } catch { /* subscriber teardown */ } }
  }

  let ctx = null, bus = null, limiter = null, analyser = null;
  let buffer = null;          // decoded AudioBuffer (null until a file loads)
  let bufferId = 0;           // bumps on every load — keys the region-copy cache
  let name = '';              // display name of the loaded file
  let src = null;             // live AudioBufferSourceNode while playing (plain path)
  let level = 1.0;            // output level (0..2), rides `bus.gain`
  let muted = false;          // mixer-style mute — gates the bus to 0, keeps `level`
  let limiterOn = true;       // brickwall limiter engaged (on by default, house rule)
  let loop = false;
  let playing = false;
  let offset = 0;             // seconds into the track where the next play starts
  let anchorPos = 0;          // track seconds at `anchorTime` (while playing)
  let anchorTime = 0;         // ctx.currentTime the head was anchored at
  let _expectStop = false;    // guards onended against our own stop()/seek() calls
  let _tick = null;           // UI position-push interval (only while playing)
  let _resumeOnUnpause = false; // page pause gate remembers whether we were playing

  // ── practice state ──
  let rate = 1;               // playback speed (0.25..1.5)
  let pitchLock = true;       // hold the pitch when slowed (time-stretch)
  let transpose = 0;          // semitones, −12..12 (always via the stretcher)
  let markA = -1, markB = -1; // loop-region markers, seconds (−1 = unset)
  const trainer = { on: false, step: 0.05, every: 2, target: 1 };
  let _passes = 0, _lastHead = -1;

  // ── playback window + stretch node ──
  let win = null;             // { buf, start, len, loop, key } the live source plays
  let regionCache = null;     // { key, buf } — the seam-baked region copy
  let mode = null;            // 'src' | 'stretch' | 'pending' (stretch loading)
  let stretch = null, stretchCh = 0, stretchFedKey = '', stretchPromise = null;
  let _gen = 0;               // bumps on every kill — cancels a pending async start
  let _endTimer = null;       // stretch path has no onended; a timer stands in

  // Lazily build the graph — an AudioContext created before a user gesture
  // starts suspended and stays silent.
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    bus = ctx.createGain();
    bus.gain.value = muted ? 0 : level;
    limiter = makeLimiter(ctx, limiterOn);   // brickwall before destination
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

  // Push the effective bus gain (0 while muted, `level` otherwise). Ramped, so
  // mute/level moves never click.
  function applyBusGain() {
    if (bus && ctx) bus.gain.setTargetAtTime(muted ? 0 : level, ctx.currentTime, 0.01);
  }

  const duration = () => (buffer ? buffer.duration : 0);
  const region = () => resolveRegion(markA, markB, duration());
  // The region only bites while loop is on — with loop off the markers just sit
  // on the waveform and the track plays straight through.
  const loopRegion = () => (loop ? region() : null);

  // Current playback head, clamped to the track.
  function position() {
    if (!buffer) return 0;
    if (!playing) return Math.min(offset, buffer.duration);
    const lw = win && win.loop ? { lo: win.start, hi: win.start + win.len } : null;
    return headPosition(anchorPos, ctx.currentTime - anchorTime, rate, buffer.duration, lw);
  }

  function startTicker() {
    if (_tick) return;
    _tick = setInterval(() => { trainerTick(); emitState(); }, 100);   // ~10 Hz, only while playing
  }
  function stopTicker() {
    if (_tick) { clearInterval(_tick); _tick = null; }
  }

  // Tear down the live source on either path (banking nothing — callers set `offset`).
  function killSource() {
    _gen++;
    if (_endTimer) { clearTimeout(_endTimer); _endTimer = null; }
    if (src) {
      _expectStop = true;
      try { src.onended = null; src.stop(); } catch { /* already stopped */ }
      try { src.disconnect(); } catch {}
      src = null;
      _expectStop = false;
    }
    if (mode === 'stretch' && stretch && ctx) {
      try { stretch.schedule({ output: ctx.currentTime, active: false }); } catch {}
    }
    mode = null;
  }

  // Natural end of a non-looping track: park at the top, released from the mix.
  function naturalEnd() {
    _endTimer = null;
    src = null;
    mode = null;
    playing = false;
    offset = 0;
    stopTicker();
    onFeedChange();
    emitState();
    fireTransport('ended');
  }

  // What the source plays: the seam-baked region copy while a loop region is
  // active, else the whole track. Region copies are cached per (track, A, B).
  function windowFor() {
    const r = loopRegion();
    if (!r) return { buf: buffer, start: 0, len: buffer.duration, loop, key: `full:${bufferId}` };
    const key = `${bufferId}:${r.lo.toFixed(4)}:${r.hi.toFixed(4)}`;
    if (!regionCache || regionCache.key !== key) {
      const sr = buffer.sampleRate, nch = buffer.numberOfChannels;
      const f0 = Math.round(r.lo * sr), f1 = Math.min(buffer.length, Math.round(r.hi * sr));
      const n = Math.max(2, f1 - f0);
      const fade = Math.round(SEAM_FADE_SEC * sr);
      const regions = [], pre = f0 >= fade ? [] : null;
      for (let c = 0; c < nch; c++) {
        const d = buffer.getChannelData(c);
        regions.push(d.slice(f0, f0 + n));
        if (pre) pre.push(d.slice(f0 - fade, f0));
      }
      bakeRegionSeam(regions, pre, sr);
      const out = ctx.createBuffer(nch, n, sr);
      for (let c = 0; c < nch; c++) out.copyToChannel(regions[c], c);
      regionCache = { key, buf: out };
    }
    return { buf: regionCache.buf, start: r.lo, len: regionCache.buf.duration, loop: true, key };
  }

  // Spin up a fresh source from the current `offset` and go.
  function startSource() {
    ensure();
    ctx.resume?.();
    killSource();
    win = windowFor();
    const isRegion = !win.key.startsWith('full:');
    const at = startOffset(offset, buffer.duration, isRegion ? { lo: win.start, hi: win.start + win.len } : null);
    anchorPos = at;
    anchorTime = ctx.currentTime;
    _lastHead = -1;
    if (needsStretch(rate, pitchLock, transpose)) void startStretch(at);
    else startPlain(at);
  }

  function startPlain(at) {
    const s = ctx.createBufferSource();
    s.buffer = win.buf;
    s.loop = win.loop;
    s.playbackRate.value = rate;
    s.connect(bus);
    s.onended = () => {
      if (_expectStop || src !== s) return;   // our own stop()/seek() — ignore
      naturalEnd();
    };
    s.start(0, Math.max(0, at - win.start));
    src = s;
    mode = 'src';
  }

  // Create (once per channel count) the stretch node, wired into the bus.
  function ensureStretch(nch) {
    if (stretch && stretchCh === nch) return Promise.resolve(stretch);
    if (stretchPromise) return stretchPromise;
    stretchPromise = (async () => {
      if (stretch) { try { stretch.disconnect(); } catch {} stretch = null; }
      const node = await createStretchNode(ctx, nch);
      stretchPromise = null;
      if (!node) return null;
      node.connect(bus);
      stretch = node; stretchCh = nch; stretchFedKey = '';
      return node;
    })();
    return stretchPromise;
  }

  async function startStretch(at) {
    const gen = _gen;
    const w = win;
    mode = 'pending';
    const node = await ensureStretch(w.buf.numberOfChannels);
    if (gen !== _gen) return;                         // paused / restarted meanwhile
    if (!node) { mode = null; startPlain(at); return; } // library failed → varispeed
    if (stretchFedKey !== w.key) {
      const chans = [];
      for (let c = 0; c < w.buf.numberOfChannels; c++) chans.push(w.buf.getChannelData(c));
      try {
        await node.dropBuffers();
        await node.addBuffers(chans);   // structured-clone copy; our buffer stays intact
        stretchFedKey = w.key;
      } catch (err) {
        console.warn('[qualia] deck stretch load failed; varispeed fallback:', err);
        stretchFedKey = '';
        if (gen === _gen) { mode = null; startPlain(at); }
        return;
      }
      if (gen !== _gen) return;
    }
    // Re-anchor after the async load so the scrubber matches what's heard.
    anchorPos = at;
    anchorTime = ctx.currentTime;
    scheduleStretch(at);
    mode = 'stretch';
  }

  function scheduleStretch(at) {
    stretch.schedule({
      output: ctx.currentTime, active: true,
      input: Math.max(0, at - win.start), rate,
      semitones: stretchSemitones(rate, pitchLock, transpose),
      loopStart: 0, loopEnd: win.loop ? win.len : 0,
    });
    if (_endTimer) { clearTimeout(_endTimer); _endTimer = null; }
    if (!win.loop) {
      const gen = _gen;
      _endTimer = setTimeout(() => { if (gen === _gen && playing) naturalEnd(); },
        Math.max(0, (buffer.duration - at) / rate) * 1000 + 50);
    }
  }

  // Apply a speed / pitch-lock / transpose change to the live playback in
  // place when the path doesn't change (no restart, no gap), else restart.
  function retime() {
    if (!playing) { emitState(); return; }
    const pos = position();
    const wantStretch = needsStretch(rate, pitchLock, transpose);
    if (mode === 'src' && !wantStretch && src) {
      anchorPos = pos; anchorTime = ctx.currentTime;
      src.playbackRate.setValueAtTime(rate, ctx.currentTime);
    } else if (mode === 'stretch' && wantStretch && stretch) {
      anchorPos = pos; anchorTime = ctx.currentTime;
      scheduleStretch(pos);
    } else {
      offset = pos;
      startSource();
    }
    emitState();
  }

  // Restart from the live head (region / loop changes reshape the window).
  function restartAtHead() {
    if (!playing) { emitState(); return; }
    offset = position();
    startSource();
    emitState();
  }

  // Speed trainer: count loop wraps; every `every` passes bump the speed.
  function trainerTick() {
    if (!trainer.on || !playing || !win?.loop) { _lastHead = -1; return; }
    const p = position();
    if (_lastHead >= 0 && p < _lastHead - 0.05) {
      const r = trainerAdvance(rate, _passes, trainer);
      _passes = r.passes;
      if (r.rate !== rate) { rate = r.rate; retime(); }
      if (r.done) trainer.on = false;
    }
    _lastHead = p;
  }

  function resetForNewTrack() {
    bufferId++;
    regionCache = null;
    markA = markB = -1;
    offset = 0;
    _passes = 0;
  }

  const api = {
    getContext:      () => ctx,
    getFeedAnalyser: () => analyser,
    /** The decoded AudioBuffer (null until a file loads) — for the deck's
     *  overall-waveform display. Identity changes on each load(), so callers
     *  cache peaks against the returned reference. */
    getBuffer:       () => buffer,
    isReady:         () => !!buffer,
    isPlaying:       () => playing,
    /** Adopt gate: present in the analysis + record mix only while sounding. */
    isActive:        () => playing,
    getName:         () => name,
    getDuration:     () => duration(),
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
        resetForNewTrack();
        emitState();
        return true;
      } catch (e) {
        console.warn('[qualia] audio-file: load failed:', e);
        emitState();
        return false;
      }
    },

    /** Load raw PCM (one Float32Array per channel at `sampleRate`) as the
     *  current track — how a grab from captured app audio lands in the deck.
     *  Replaces (and stops) any current track. Returns true on success. */
    loadBuffer: (chans, sampleRate, label) => {
      if (!chans?.length || !chans[0]?.length) return false;
      ensure();
      api.stop();
      try {
        const b = ctx.createBuffer(chans.length, chans[0].length, sampleRate || ctx.sampleRate);
        for (let c = 0; c < chans.length; c++) b.copyToChannel(chans[c], c);
        buffer = b;
        name = label || 'clip';
        resetForNewTrack();
        emitState();
        return true;
      } catch (e) {
        console.warn('[qualia] audio-file: loadBuffer failed:', e);
        return false;
      }
    },

    /** Start (or restart) playback from the current position. */
    play: () => {
      if (!buffer || playing) return;
      ensure();
      if (offset >= buffer.duration) offset = 0;   // was parked at the end
      playing = true;
      startSource();
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
      _passes = 0;
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
      const next = !!on;
      if (next === loop) { emitState(); return; }
      loop = next;
      _passes = 0;
      // Whole-track loop on the plain path flips live; anything that changes the
      // window (a region, the stretcher's loop bounds) restarts at the head.
      if (playing && mode === 'src' && src && !region()) { src.loop = loop; emitState(); return; }
      restartAtHead();
    },

    // ── lick practice ──
    getRate:      () => rate,
    /** Playback speed, 0.25..1.5 (1 = normal). Applies live. */
    setRate:      (r) => { const v = clampRate(r); if (v === rate) { emitState(); return; } rate = v; retime(); },
    getPitchLock: () => pitchLock,
    /** Hold the original pitch when the speed changes (time-stretch). */
    setPitchLock: (on) => { const v = !!on; if (v === pitchLock) { emitState(); return; } pitchLock = v; retime(); },
    getTranspose: () => transpose,
    /** Shift the pitch by whole semitones (−12..12) without changing speed. */
    setTranspose: (st) => { const v = clampTranspose(st); if (v === transpose) { emitState(); return; } transpose = v; retime(); },
    /** The loop region as `{ start, end }` seconds, or null. */
    getRegion:    () => { const r = region(); return r ? { start: r.lo, end: r.hi } : null; },
    /** Raw markers (−1 = unset), for drawing. */
    getMarks:     () => ({ a: markA, b: markB }),
    /** Set the A/B loop markers (seconds; null / negative clears one). A
     *  region shorter than 50 ms is refused. */
    setRegion:    (a, b) => {
      const dur = duration();
      let na = Number.isFinite(+a) && a !== null && +a >= 0 ? Math.min(+a, dur) : -1;
      let nb = Number.isFinite(+b) && b !== null && +b >= 0 ? Math.min(+b, dur) : -1;
      if (na >= 0 && nb >= 0 && nb < na) [na, nb] = [nb, na];
      if ((na >= 0 || nb >= 0) && !resolveRegion(na, nb, dur)) return false;
      markA = na; markB = nb;
      _passes = 0;
      restartAtHead();
      return true;
    },
    clearRegion:  () => { markA = markB = -1; _passes = 0; restartAtHead(); },
    getTrainer:   () => ({ ...trainer }),
    /** Speed trainer: `{ on, step, every, target }` — every `every` loop passes
     *  the speed rises by `step` until it reaches `target`, then switches off. */
    setTrainer:   (cfg = {}) => {
      if ('step' in cfg)   trainer.step = Math.min(0.25, Math.max(0.01, +cfg.step || 0.05));
      if ('every' in cfg)  trainer.every = Math.min(16, Math.max(1, cfg.every | 0));
      if ('target' in cfg) trainer.target = clampRate(cfg.target);
      if ('on' in cfg)     { trainer.on = !!cfg.on; _passes = 0; _lastHead = -1; }
      emitState();
    },
    /** True while the pitch-preserving stretcher is the live path. */
    isStretching: () => mode === 'stretch' || mode === 'pending',

    setLevel: (v) => {
      level = Math.min(2, Math.max(0, +v || 0));
      applyBusGain();
      emitState();
      fireMix();
    },

    getMuted: () => muted,
    /** Mixer-style mute — gates the output (speakers + recording + reactivity)
     *  to silence while remembering `level`. Ramped, so no click. */
    setMuted: (on) => {
      muted = !!on;
      applyBusGain();
      emitState();
      fireMix();
    },
    toggleMuted: () => { api.setMuted(!muted); },

    getLimiter: () => limiterOn,
    /** Toggle the brickwall limiter (clip insurance). On by default. */
    setLimiter: (on) => {
      limiterOn = !!on;
      if (limiter) setLimiterEngaged(limiter, limiterOn);
      emitState();
      fireMix();
    },

    /** Subscribe to level / mute / limiter changes (mixer surface). Returns an
     *  unsubscribe fn. */
    onMix: (fn) => { mixSubs.add(fn); return () => mixSubs.delete(fn); },

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
      buffer = null; name = ''; regionCache = null;
      try { stretch?.disconnect(); } catch {}
      stretch = null;
      try { analyser?.disconnect(); } catch {}
      try { bus?.disconnect(); } catch {}
      try { limiter?.dispose(); } catch {}
      if (ctx) { try { ctx.close(); } catch {} ctx = null; }
    },
  };

  function getState() {
    const r = region();
    return {
      ready:    !!buffer,
      playing,
      loop,
      level,
      muted,
      limiter:  limiterOn,
      name,
      duration: duration(),
      position: position(),
      rate,
      pitchLock,
      transpose,
      region:   r ? { start: r.lo, end: r.hi } : null,
      marks:    { a: markA, b: markB },
      trainer:  { ...trainer },
      stretching: mode === 'stretch' || mode === 'pending',
    };
  }

  return api;
}
