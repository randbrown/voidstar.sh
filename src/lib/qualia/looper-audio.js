// Looper capture + playback engine. Records the selected audio input into an
// AudioBuffer with sample-accurate timing, snaps the loop region to Strudel
// metacycle boundaries, and plays it back phase-locked to those boundaries.
//
// Everything runs in the looper's own native AudioContext (like the mic in
// audio.js). We deliberately do NOT reuse Tone's context: Tone wraps a
// standardized-audio-context, whose objects the native `AudioWorkletNode`
// constructor rejects. A separate context is fine for sync because
// `getStrudelCyclePos()` is only ever used to form RELATIVE durations
// (boundary − pos)/cps, which are portable across contexts — both advance at
// one audio-second per real-second, the same reason the mic's own context
// stays phase-aligned. This mirrors the sequencer's "durations are portable"
// note (see sequencer.js computeAlignedStart / getSecondsUntilNextStrudelBoundary).
//
// v1 is varispeed: fitting a take into N cycles changes playbackRate, so pitch
// shifts with speed. A pitch-preserving time-stretch is a future pass (the
// disabled "preserve pitch" toggle in the panel marks the seam).

// Vite emits the worklet as a standalone asset and returns its URL — the
// processor loads into the AudioWorklet global scope, it can't be page-bundled.
// `no-inline` keeps it a real network asset: the file is small enough that
// Vite would otherwise inline it as a data: URL, which addModule() can't load
// reliably across browsers.
import recorderWorkletUrl from './worklets/looper-recorder.js?url&no-inline';

const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl:  false,
};
const EPS = 1e-6;
// Small scheduling lookahead so `source.start()` lands a hair in the future.
// Strudel's cycle position is already audible-corrected, so this only needs to
// cover the gap between reading the clock and the node actually starting.
const START_MARGIN = 0.08;

export function createLooperAudio({ audio, syncStrudel } = {}) {
  let ctx = null;
  let workletReady = null;          // Promise<boolean> — memoised module load

  // ── capture graph ──
  let stream = null;
  let streamOwned = false;          // false when we borrowed audio.getMicStream()
  let streamDeviceId = '';
  let srcNode = null, recNode = null, sinkGain = null;
  let usingWorklet = false;

  // ── recording state ──
  let recording = false;
  let recChunks = [];
  let recFrames = 0;
  let captureStartAbs = 0;
  let snapIn = null;                // { cycleIn, inAbs, cps, N } when synced, else null

  // ── playback graph ──
  let masterGain = null, analyser = null;
  let source = null, trackGain = null;
  let playStartAbs = null, playLoopDur = 0;
  let _muted = false, _gain = 0.9;

  async function ensureContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    if (!workletReady) {
      if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
        workletReady = ctx.audioWorklet.addModule(recorderWorkletUrl)
          .then(() => true)
          .catch((err) => {
            console.warn('[qualia] looper-recorder worklet failed to load — using ScriptProcessor fallback:', err);
            return false;
          });
      } else {
        workletReady = Promise.resolve(false);
      }
    }
    return ctx;
  }

  // Open (or replace) the input capture. deviceId '' means "default input":
  // reuse the page mic's stream when one is live, else open the default device.
  async function openCapture(deviceId) {
    await ensureContext();
    const want = deviceId || '';
    let useStream = null, owned = false;
    if (!want) {
      const mic = audio?.getMicStream?.();
      if (mic) { useStream = mic; owned = false; }
    }
    if (!useStream) {
      const constraints = want
        ? { ...MIC_CONSTRAINTS, deviceId: { exact: want } }
        : { ...MIC_CONSTRAINTS };
      useStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      owned = true;
    }
    teardownCapture();
    stream = useStream;
    streamOwned = owned;
    streamDeviceId = want || (stream.getAudioTracks()[0]?.getSettings().deviceId) || '';

    srcNode = ctx.createMediaStreamSource(stream);
    // A worklet/ScriptProcessor only gets pulled if it has a live downstream;
    // route it through a silent sink so process() keeps firing without
    // monitoring the input to the speakers (that would feed back).
    sinkGain = ctx.createGain();
    sinkGain.gain.value = 0;
    sinkGain.connect(ctx.destination);

    const ready = await workletReady;
    if (ready) {
      usingWorklet = true;
      recNode = new AudioWorkletNode(ctx, 'looper-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      });
      recNode.port.onmessage = (e) => {
        if (!recording) return;
        recChunks.push(e.data);
        recFrames += e.data.length;
      };
      srcNode.connect(recNode);
      recNode.connect(sinkGain);
    } else {
      usingWorklet = false;
      recNode = ctx.createScriptProcessor(4096, 1, 1);
      recNode.onaudioprocess = (e) => {
        if (!recording) return;
        const ch = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(ch.length);
        copy.set(ch);
        recChunks.push(copy);
        recFrames += copy.length;
      };
      srcNode.connect(recNode);
      recNode.connect(sinkGain);
    }
  }

  function teardownCapture() {
    try { srcNode?.disconnect(); } catch {}
    if (recNode) { try { recNode.disconnect(); } catch {}; if ('onaudioprocess' in recNode) recNode.onaudioprocess = null; }
    try { sinkGain?.disconnect(); } catch {}
    if (stream && streamOwned) { try { stream.getTracks().forEach(t => t.stop()); } catch {} }
    srcNode = recNode = sinkGain = null;
    stream = null; streamOwned = false;
  }

  async function ensureCapture(deviceId) {
    const want = deviceId || '';
    if (srcNode && want === (streamDeviceId || '')) return;
    await openCapture(want);
  }

  function armRecorder(on) {
    if (usingWorklet && recNode) {
      try { recNode.port.postMessage({ cmd: on ? 'start' : 'stop' }); } catch {}
    }
    // ScriptProcessor path is gated by the `recording` flag directly.
  }

  // ── record ──
  async function startRecording({ metacycle = 1, syncOn = false, deviceId = '' } = {}) {
    if (recording) return;
    await ensureContext();
    await ensureCapture(deviceId);
    recChunks = []; recFrames = 0;
    captureStartAbs = ctx.currentTime;
    snapIn = null;
    if (syncOn) {
      const info = syncStrudel?.getStrudelCyclePos?.();
      if (info && info.cps > 0 && typeof info.pos === 'number') {
        const N = metacycle > 0 ? metacycle : 1;
        const cycleIn = Math.ceil(info.pos / N - EPS) * N;     // next multiple of N
        const inAbs = captureStartAbs + (cycleIn - info.pos) / info.cps;
        snapIn = { cycleIn, inAbs, cps: info.cps, N };
      }
    }
    recording = true;
    armRecorder(true);
    return { snapped: !!snapIn };
  }

  // Resolves to { buffer, sampleRate, naturalSeconds, recordedCycles } or null
  // if nothing usable was captured. When synced, waits for the OUT boundary's
  // audio to actually arrive before building the buffer (captures the user's
  // late Stop press up to the metacycle boundary).
  function stopRecording({ metacycle = 1, syncOn = false } = {}) {
    return new Promise((resolve) => {
      if (!recording) { resolve(null); return; }
      const N = metacycle > 0 ? metacycle : 1;
      let outAbs = ctx.currentTime;
      let cycleOut = null;
      if (snapIn) {
        const info = syncStrudel?.getStrudelCyclePos?.();
        if (info && info.cps > 0 && typeof info.pos === 'number') {
          const stopAbs = ctx.currentTime;
          cycleOut = Math.ceil(info.pos / N - EPS) * N;        // next multiple of N at/after stop
          if (cycleOut <= snapIn.cycleIn) cycleOut = snapIn.cycleIn + N;  // ≥ one metacycle
          outAbs = stopAbs + (cycleOut - info.pos) / info.cps;
        }
      }
      const finish = () => {
        recording = false;
        armRecorder(false);
        const sr = ctx.sampleRate;
        const total = recFrames;
        const all = new Float32Array(total);
        let off = 0;
        for (const c of recChunks) { all.set(c, off); off += c.length; }
        recChunks = [];

        let inFrame = 0, outFrame = total, recordedCycles = null;
        if (snapIn && cycleOut != null) {
          inFrame  = Math.max(0, Math.round((snapIn.inAbs - captureStartAbs) * sr));
          outFrame = Math.min(total, Math.round((outAbs - captureStartAbs) * sr));
          recordedCycles = cycleOut - snapIn.cycleIn;
        }
        snapIn = null;
        if (outFrame - inFrame < 16) { resolve(null); return; }
        const region = all.subarray(inFrame, outFrame);
        const buffer = ctx.createBuffer(1, region.length, sr);
        buffer.copyToChannel(region, 0);
        resolve({ buffer, sampleRate: sr, naturalSeconds: region.length / sr, recordedCycles });
      };

      const waitMs = (outAbs - ctx.currentTime) * 1000;
      if (waitMs < 5) finish();
      else setTimeout(finish, waitMs + 20);   // small cushion for the boundary audio
    });
  }

  // ── playback ──
  function ensureBus() {
    if (masterGain) return;
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    // Tag so Strudel's connect-into-destination mute patch leaves the looper
    // alone — the looper owns its own mute on trackGain (mirrors kit.output).
    masterGain.__qualiaBypassMute = true;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.40;
    masterGain.connect(ctx.destination);
    masterGain.connect(analyser);
  }

  function derivePlaybackRate(track, cps) {
    const targetSec = track.cycles / (cps > 0 ? cps : 0.5);   // wall seconds for N cycles
    const rate = track.naturalSeconds / targetSec;
    return (rate > 0 && isFinite(rate)) ? rate : 1;
  }

  // Absolute rawContext time of the next metacycle boundary (≡ 0 mod N), or a
  // tiny lookahead when unsynced / Strudel isn't reporting a position.
  function nextBoundaryAbs(metacycle, syncOn) {
    const now = ctx.currentTime;
    if (syncOn) {
      const info = syncStrudel?.getStrudelCyclePos?.();
      if (info && info.cps > 0 && typeof info.pos === 'number') {
        const N = metacycle > 0 ? metacycle : 1;
        const k = Math.ceil((info.pos + START_MARGIN * info.cps) / N - EPS);
        return now + (k * N - info.pos) / info.cps;
      }
    }
    return now + START_MARGIN;
  }

  async function play(track, { metacycle = 1, syncOn = false, cps = 0.5 } = {}) {
    if (!track || !track.buffer) return false;
    await ensureContext();
    ensureBus();
    stopSource();
    const rate = derivePlaybackRate(track, cps);
    const startAbs = nextBoundaryAbs(metacycle, syncOn);
    source = ctx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = track.buffer.duration;
    source.playbackRate.value = rate;
    trackGain = ctx.createGain();
    trackGain.gain.value = _muted ? 0 : _gain;
    source.connect(trackGain).connect(masterGain);
    source.start(startAbs, 0);
    playStartAbs = startAbs;
    playLoopDur = track.buffer.duration / rate;   // == track.cycles / cps
    audio?.adoptAnalyser?.(ctx, analyser, 'looper');
    return true;
  }

  function stopSource() {
    if (source) { try { source.stop(); } catch {}; try { source.disconnect(); } catch {}; source = null; }
    if (trackGain) { try { trackGain.disconnect(); } catch {}; trackGain = null; }
    playStartAbs = null;
  }

  function stop() {
    stopSource();
    audio?.releaseAdopted?.('looper');
  }

  function ramp(param, target) {
    try {
      const t = ctx.currentTime;
      param.cancelScheduledValues(t);
      param.linearRampToValueAtTime(target, t + 0.04);
    } catch { try { param.value = target; } catch {} }
  }

  function setMuted(on) { _muted = !!on; if (trackGain) ramp(trackGain.gain, _muted ? 0 : _gain); }
  function setGain(v) {
    _gain = Math.max(0, Math.min(1, Number(v) || 0));
    if (trackGain && !_muted) ramp(trackGain.gain, _gain);
  }

  // Loop phase 0..1 across the whole take, or null when not playing.
  function getPlayhead01() {
    if (playStartAbs == null || !(playLoopDur > 0) || !ctx) return null;
    const t = ctx.currentTime;
    if (t < playStartAbs) return 0;
    return ((t - playStartAbs) % playLoopDur) / playLoopDur;
  }

  function dispose() {
    stop();
    teardownCapture();
    try { masterGain?.disconnect(); } catch {}
    try { analyser?.disconnect(); } catch {}
    masterGain = analyser = null;
    try { ctx?.close(); } catch {}
    ctx = null; workletReady = null;
  }

  return {
    ensureContext,
    setInputDevice: async (id) => { if (!recording) await openCapture(id || ''); else streamDeviceId = id || ''; },
    getInputDeviceId: () => streamDeviceId,
    startRecording, stopRecording,
    play, stop,
    setMuted, setGain,
    getPlayhead01,
    isRecording: () => recording,
    isPlaying:   () => !!source,
    dispose,
  };
}
