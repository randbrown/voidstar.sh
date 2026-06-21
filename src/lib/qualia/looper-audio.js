// Looper capture + playback engine. Records the selected audio input into an
// AudioBuffer with sample-accurate timing, snaps the loop region to Strudel
// grid boundaries, and plays it back phase-locked to those boundaries.
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
// Length: IN snaps to the next grid downbeat (preserves the prep bar);
// OUT rounds to the NEAREST grid boundary so a slow Stop is discarded.
// The trimmed loop is always an integer number of grid units (the per-track
// "cycles" control).
//
// Alignment: the captured downbeat lands later than the IN boundary by the
// round-trip latency (output + input + acoustic + reaction). We bake a PAD of
// silence-headroom on both sides of the loop region into the stored buffer so a
// "nudge (ms)" offset can slide the loop window live (no re-record) to dial the
// take into the pocket. A diagnostic logs the measured first-transient offset.
//
// v1 is varispeed: fitting a take into N cycles changes playbackRate, so pitch
// shifts with speed. Pitch-preserving time-stretch is a future pass.

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
  // Hint the browser toward the lowest input buffering it can manage. Chrome on
  // Windows (shared-mode WASAPI) often ignores this, but where it's honoured it
  // shaves real latency off the recording. The rest is compensated by `nudge`.
  latency: 0,
};
const EPS = 1e-6;
// Small scheduling lookahead so `source.start()` lands a hair in the future.
// Strudel's cycle position is already audible-corrected, so this only needs to
// cover the gap between reading the clock and the node actually starting.
const START_MARGIN = 0.08;
// Headroom baked on each side of the loop region so the "nudge (ms)" offset can
// slide the playback window live without re-recording. Bounds the offset range.
const PAD_SEC = 0.5;

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
  let firstChunkAbs = null;         // precise ctx time of buffer frame 0 (worklet t0)
  let armEstimateAbs = 0;           // fallback frame-0 estimate (arm time)
  let snapIn = null;                // { cycleIn, inAbs, cps } when synced, else null
  let recN = 1;                     // grid (per-track "cycles") for this take
  let recCps = 0.5;                 // cps captured at record time (for unsynced lane math)

  // ── live record peaks (min/max per bin, grown as chunks arrive) ──
  let liveMin = null, liveMax = null;
  let liveBins = 0, liveBinSamples = 0;
  let liveAccMin = 1, liveAccMax = -1, liveAccN = 0;
  let liveTotalFrames = 0;

  // ── playback graph ──
  //   loop source → loopGain → masterGain → destination + analyser('looper')
  // Only the recorded loop runs through the looper. Live-input monitoring is a
  // page-level concern (audio.js mic monitor) so it isn't double-captured; the
  // raw input already reaches the visualizers + recording via the 'mic' source.
  let masterGain = null, analyser = null, loopGain = null;
  let source = null;
  let playStartAbs = null, playLoopDur = 0;
  let _muted = false;
  let _master = 0.9;                // overall looper output level
  let _loopVol = 0.5;               // recorded-loop playback level (Ditto-centre)
  let _adopted = false;             // 'looper' registered with audio.js
  let _offsetMs = 0;                // nudge: + = take plays earlier (compensates lateness)

  const frameZeroAbs = () => (firstChunkAbs != null ? firstChunkAbs : armEstimateAbs);

  async function ensureContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
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

  // ── live peak accumulation ──
  function resetLivePeaks() {
    liveBinSamples = Math.max(64, Math.round((ctx?.sampleRate || 48000) * 0.012)); // ~12 ms bins
    liveBins = 0; liveAccMin = 1; liveAccMax = -1; liveAccN = 0; liveTotalFrames = 0;
    liveMin = new Float32Array(4096);
    liveMax = new Float32Array(4096);
  }
  function pushLiveBin(mn, mx) {
    if (liveBins >= liveMin.length) {
      const nMin = new Float32Array(liveMin.length * 2);
      const nMax = new Float32Array(liveMax.length * 2);
      nMin.set(liveMin); nMax.set(liveMax);
      liveMin = nMin; liveMax = nMax;
    }
    liveMin[liveBins] = mn; liveMax[liveBins] = mx; liveBins++;
  }
  function foldChunkIntoLive(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const s = chunk[i];
      if (s < liveAccMin) liveAccMin = s;
      if (s > liveAccMax) liveAccMax = s;
      if (++liveAccN >= liveBinSamples) {
        pushLiveBin(liveAccMin, liveAccMax);
        liveAccMin = 1; liveAccMax = -1; liveAccN = 0;
      }
    }
    liveTotalFrames += chunk.length;
  }

  function onChunk(chunk) {
    recChunks.push(chunk);
    recFrames += chunk.length;
    foldChunkIntoLive(chunk);
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
    const settings = stream.getAudioTracks()[0]?.getSettings() || {};
    streamDeviceId = want || settings.deviceId || '';

    srcNode = ctx.createMediaStreamSource(stream);
    // Capture is recording-only: live-input monitoring is owned by the
    // page-level input channel (audio.js mic source → monitorGain), so the
    // looper never fans the input to the speakers itself — exactly one audible
    // path, never doubled.
    // A worklet/ScriptProcessor only gets pulled if it has a live downstream;
    // route it through a silent sink so process() keeps firing.
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
        const d = e.data;
        // Control message: precise ctx time of the first armed quantum (frame 0).
        if (d && d.t0 !== undefined) { if (firstChunkAbs == null) firstChunkAbs = d.t0; return; }
        if (!recording) return;
        onChunk(d);
      };
      srcNode.connect(recNode);
      recNode.connect(sinkGain);
    } else {
      usingWorklet = false;
      recNode = ctx.createScriptProcessor(4096, 1, 1);
      recNode.onaudioprocess = (e) => {
        if (!recording) return;
        if (firstChunkAbs == null) firstChunkAbs = e.playbackTime;
        const ch = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(ch.length);
        copy.set(ch);
        onChunk(copy);
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
  async function startRecording({ grid = 1, syncOn = false, cps = 0.5, deviceId = '' } = {}) {
    if (recording) return { snapped: false };
    await ensureContext();
    await ensureCapture(deviceId);
    recChunks = []; recFrames = 0;
    firstChunkAbs = null;
    armEstimateAbs = ctx.currentTime;
    recN = grid > 0 ? grid : 1;
    recCps = cps > 0 ? cps : 0.5;
    resetLivePeaks();
    snapIn = null;
    if (syncOn) {
      const info = syncStrudel?.getStrudelCyclePos?.();
      if (info && info.cps > 0 && typeof info.pos === 'number') {
        const cycleIn = Math.ceil(info.pos / recN - EPS) * recN;   // next grid downbeat
        const inAbs = armEstimateAbs + (cycleIn - info.pos) / info.cps;  // absolute ctx time
        snapIn = { cycleIn, inAbs, cps: info.cps };
        recCps = info.cps;
      }
    }
    recording = true;
    armRecorder(true);
    return { snapped: !!snapIn };
  }

  // Resolves to a track { buffer, sampleRate, loopStartBase, regionFrames,
  // naturalSeconds, recordedCycles } or null. The stored buffer is the loop
  // region with PAD_SEC of headroom on each side so the nudge can slide it.
  function stopRecording({ grid = 1, syncOn = false } = {}) {
    return new Promise((resolve) => {
      if (!recording) { resolve(null); return; }
      const N = grid > 0 ? grid : 1;
      let outAbs = ctx.currentTime;
      let cycleOut = null;
      if (snapIn) {
        const info = syncStrudel?.getStrudelCyclePos?.();
        if (info && info.cps > 0 && typeof info.pos === 'number') {
          const stopAbs = ctx.currentTime;
          cycleOut = Math.round(info.pos / N) * N;                 // NEAREST grid boundary
          if (cycleOut <= snapIn.cycleIn) cycleOut = snapIn.cycleIn + N;   // ≥ one grid unit
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

        const z = frameZeroAbs();
        const pad = Math.round(PAD_SEC * sr);
        let inFrame, outFrame, recordedCycles;
        if (snapIn && cycleOut != null) {
          inFrame  = Math.round((snapIn.inAbs - z) * sr);
          outFrame = Math.round((outAbs - z) * sr);
          recordedCycles = cycleOut - snapIn.cycleIn;
        } else {
          inFrame = 0; outFrame = total; recordedCycles = null;
        }
        inFrame = Math.max(0, Math.min(total, inFrame));
        outFrame = Math.max(inFrame, Math.min(total, outFrame));
        const regionFrames = outFrame - inFrame;
        if (regionFrames < 16) { snapIn = null; resolve(null); return; }

        // Slice with PAD on each side (clamped to what was captured).
        const padStart = Math.min(pad, inFrame);
        const padEnd   = Math.min(pad, total - outFrame);
        const sliceFrom = inFrame - padStart;
        const sliceTo   = outFrame + padEnd;
        const region = all.subarray(sliceFrom, sliceTo);
        const buffer = ctx.createBuffer(1, region.length, sr);
        buffer.copyToChannel(region, 0);
        const loopStartBase = padStart;   // sample idx of the musical IN within `buffer`

        snapIn = null;
        resolve({
          buffer, sampleRate: sr,
          loopStartBase, regionFrames,
          naturalSeconds: regionFrames / sr,
          recordedCycles,
        });
      };

      // Wait for the OUT boundary + the post-pad audio to arrive (so the nudge
      // has headroom). If OUT already elapsed (rounded down), finish now.
      const waitMs = (outAbs + PAD_SEC - ctx.currentTime) * 1000;
      if (waitMs < 5) finish();
      else setTimeout(finish, waitMs + 20);
    });
  }

  // ── playback / monitor bus ──
  function ensureBus() {
    if (masterGain) return;
    masterGain = ctx.createGain();
    masterGain.gain.value = _muted ? 0 : _master;
    // Tag so Strudel's connect-into-destination mute patch leaves the looper
    // alone — the looper owns its own mute on masterGain (mirrors kit.output).
    masterGain.__qualiaBypassMute = true;
    loopGain  = ctx.createGain(); loopGain.gain.value  = _loopVol;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.40;
    loopGain.connect(masterGain);
    masterGain.connect(ctx.destination);
    masterGain.connect(analyser);
  }

  // Register the looper's loop output with audio.js so it drives the
  // visualizers AND lands in the recordable screen-recording mix.
  function ensureAdopted() {
    if (_adopted || !analyser) return;
    audio?.adoptAnalyser?.(ctx, analyser, 'looper');
    _adopted = true;
  }

  function derivePlaybackRate(track, cps) {
    const targetSec = track.length / (cps > 0 ? cps : 0.5);   // wall seconds for `length` cycles
    const rate = track.naturalSeconds / targetSec;
    return (rate > 0 && isFinite(rate)) ? rate : 1;
  }

  // Effective loop-start sample within track.buffer after applying the nudge,
  // clamped so the region stays inside the padded buffer.
  function effLoopStartFrame(track) {
    const sr = track.sampleRate;
    const maxStart = Math.max(0, track.buffer.length - track.regionFrames);
    const want = track.loopStartBase + Math.round((_offsetMs / 1000) * sr);
    return Math.max(0, Math.min(maxStart, want));
  }

  // The current loop region [startFrame, endFrame] for the renderer.
  function getLoopRegion(track) {
    if (!track || !track.buffer) return null;
    const startFrame = effLoopStartFrame(track);
    return { startFrame, endFrame: startFrame + track.regionFrames };
  }

  // Absolute rawContext time of the next grid boundary (≡ 0 mod N), or a
  // tiny lookahead when unsynced / Strudel isn't reporting a position.
  function nextBoundaryAbs(grid, syncOn) {
    const now = ctx.currentTime;
    if (syncOn) {
      const info = syncStrudel?.getStrudelCyclePos?.();
      if (info && info.cps > 0 && typeof info.pos === 'number') {
        const N = grid > 0 ? grid : 1;
        const k = Math.ceil((info.pos + START_MARGIN * info.cps) / N - EPS);
        return now + (k * N - info.pos) / info.cps;
      }
    }
    return now + START_MARGIN;
  }

  async function play(track, { grid = 1, syncOn = false, cps = 0.5 } = {}) {
    if (!track || !track.buffer) return false;
    await ensureContext();
    ensureBus();
    stopSource();
    const sr = track.sampleRate;
    const rate = derivePlaybackRate(track, cps);
    const startAbs = nextBoundaryAbs(grid, syncOn);
    const startFrame = effLoopStartFrame(track);
    source = ctx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = true;
    source.loopStart = startFrame / sr;
    source.loopEnd = (startFrame + track.regionFrames) / sr;
    source.playbackRate.value = rate;
    source.connect(loopGain);
    source.start(startAbs, startFrame / sr);
    playStartAbs = startAbs;
    playLoopDur = (track.regionFrames / sr) / rate;   // == track.length / cps
    ensureAdopted();
    return true;
  }

  function stopSource() {
    if (source) { try { source.stop(); } catch {}; try { source.disconnect(); } catch {}; source = null; }
    playStartAbs = null;
  }

  function stop() {
    stopSource();
    if (_adopted) { audio?.releaseAdopted?.('looper'); _adopted = false; }
  }

  function ramp(param, target) {
    try {
      const t = ctx.currentTime;
      param.cancelScheduledValues(t);
      param.linearRampToValueAtTime(target, t + 0.04);
    } catch { try { param.value = target; } catch {} }
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  function setMuted(on) { _muted = !!on; if (masterGain) ramp(masterGain.gain, _muted ? 0 : _master); }
  function setMaster(v)  { _master = clamp01(v); if (masterGain && !_muted) ramp(masterGain.gain, _master); }
  function setLoopVol(v) { _loopVol = clamp01(v); if (loopGain) ramp(loopGain.gain, _loopVol); }
  function setOffsetMs(v) { _offsetMs = Number(v) || 0; }
  function getOffsetMs() { return _offsetMs; }

  // Loop phase 0..1 across the whole take, or null when not playing.
  function getPlayhead01() {
    if (playStartAbs == null || !(playLoopDur > 0) || !ctx) return null;
    const t = ctx.currentTime;
    if (t < playStartAbs) return 0;
    return ((t - playStartAbs) % playLoopDur) / playLoopDur;
  }

  // Live view for the renderer while recording: min/max peak bins (from frame
  // 0), the bin index of the musical IN, the head position in cycles, and the
  // lane geometry (grid, cps).
  function getLiveView() {
    if (!recording) return { recording: false };
    const sr = ctx?.sampleRate || 48000;
    const inFrame = snapIn ? Math.max(0, Math.round((snapIn.inAbs - frameZeroAbs()) * sr)) : 0;
    const headCycle = snapIn
      ? Math.max(0, (ctx.currentTime - snapIn.inAbs) * snapIn.cps)
      : (liveTotalFrames / sr) * recCps;
    return {
      recording: true,
      min: liveMin, max: liveMax, bins: liveBins,
      binSamples: liveBinSamples, sampleRate: sr,
      inBin: Math.floor(inFrame / Math.max(1, liveBinSamples)),
      grid: recN, cps: recCps,
      headCycle,
    };
  }

  function dispose() {
    stop();
    teardownCapture();
    if (_adopted) { audio?.releaseAdopted?.('looper'); _adopted = false; }
    try { masterGain?.disconnect(); } catch {}
    try { analyser?.disconnect(); } catch {}
    masterGain = analyser = loopGain = null;
    try { ctx?.close(); } catch {}
    ctx = null; workletReady = null;
  }

  return {
    ensureContext,
    setInputDevice: async (id) => { if (!recording) await openCapture(id || ''); else streamDeviceId = id || ''; },
    getInputDeviceId: () => streamDeviceId,
    startRecording, stopRecording,
    play, stop,
    setMuted, setMaster, setLoopVol,
    setOffsetMs, getOffsetMs,
    getLoopRegion,
    getPlayhead01,
    getLiveView,
    isCapturing: () => !!srcNode,
    isRecording: () => recording,
    isPlaying:   () => !!source,
    dispose,
  };
}
