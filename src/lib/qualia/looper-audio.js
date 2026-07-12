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
import neuralWorkletUrl from './worklets/neural-amp.js?url&no-inline';
import { createStretchNode } from './looper-stretch.js';
import { createRigStrip } from './rig-strip.js';
import { makeSoftLimiter, setSoftLimiterEngaged } from './limiter.js';
import { autoCorrelate } from './pitch.js';

// Reused analysis window for the input-pitch reader (allocation-free hot path).
// A ~43 ms window at 48 k still resolves down to ~70 Hz (two periods fit), and
// is a quarter the cost of the tuner's full 8192 buffer — plenty for a
// modulation channel that's smoothed downstream.
const PITCH_WINDOW = 2048;
let _pitchBuf = new Float32Array(PITCH_WINDOW);

const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl:  false,
  // Capture stereo when the interface offers it (the looper records whatever
  // channel count the source provides — mono stays mono). `ideal` so a
  // mono-only input doesn't OverconstrainedError.
  channelCount: { ideal: 2 },
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
  let neuralReady = null;           // Promise<boolean> — neural-amp worklet module

  // ── capture graph ──
  let stream = null;
  let streamOwned = false;          // false when we borrowed audio.getMicStream()
  let streamDeviceId = '';
  let srcNode = null, recNode = null, sinkGain = null, captureAnalyser = null, tunerAnalyser = null;
  let inputNode = null, monoSplitter = null;
  let _inputSampleRate = 0;         // capture track rate (0 = unknown) — see clock-match check
  let _channels = 'mono';           // 'mono' (sum to centre) | 'stereo' (pass L/R)
  let usingWorklet = false;

  // ── retroactive ring buffer ──
  // The worklet keeps an always-on ring of the last ~40s; `_bufferOn` is the
  // user's "keep the lookback filling" intent (capture stays open even when not
  // recording). Grabs are request/response over the port, keyed by id.
  let _bufferOn = false;
  const _pendingGrabs = new Map();
  let _grabSeq = 0;
  const RING_SECONDS = 40;          // mirror of the worklet's RING_SECONDS

  // ── rig signal monitor ──
  // The rig's live instrument signal is its own source: srcNode → sigGain
  // (volume × mute) → speakers (monitor) + sigAnalyser (post-fader), and that
  // analyser is adopted into audio.js as the 'rig' source so the processed
  // signal lands in the mix (visuals + recording). Independent of the
  // audio-panel 'mic'. The scope reads the PRE-fader captureAnalyser, so the
  // raw input stays monitorable even when the signal is muted out of the mix.
  let sigGain = null, sigAnalyser = null;
  let _sigLevel = 0, _sigMuted = false, _rigAdopted = false;

  // ── rig master output ──
  // Both the signal path (sigGain) and the loop bus (loopMaster) route through
  // rigMaster before hitting ctx.destination, giving a single mute + level
  // control over all rig output.
  let rigMaster = null, outputAnalyser = null, rigLimiter = null;
  let _rigMuted = false, _rigLevel = 1.0, _rigLimiterOn = true;
  // Channel strip (HPF/drive/comp/EQ/delay/reverb/pan) inserted between the raw
  // input and the volume fader. Rebuilt with each capture; looper.js owns the
  // persisted config and primes it via setStripConfig().
  let strip = null, _stripConfig = null, _cabBuffer = null, _ampModel = null;
  let recMerge = null;   // mono-sum of strip.output feeding the recorder in mono mode

  // ── recording state ──
  let recording = false;
  let _ringStartT = null;           // ctx time the lookback ring began filling (capture open)
  let recChans = [];                 // per-channel array of Float32 chunk arrays
  let recChannelCount = 1;
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

  // ── playback graph (multi-voice) ──
  //   each track:  bufferSource | stretchNode → chan.gain (vol × mute) → loopMaster (master × mute)
  //   loopMaster → destination + analyser('looper')
  // Only recorded loops run through the looper. Live-input monitoring +
  // recording are a page-level concern (the audio.js 'mic' input channel), so
  // the input is never routed here and can't be double-counted.
  //
  // A per-track CHANNEL (chans) is persistent for the track's life: its gain
  // (volume × mute) and optional Signalsmith stretch node survive play/stop, so
  // volume/mute work whether or not the track is currently looping and a stretch
  // node isn't re-created on every re-lock. A VOICE (voices) is the transient
  // playback: the live bufferSource (varispeed) or the active stretch schedule.
  let loopMaster = null, analyser = null;
  const chans = new Map();          // trackId -> { gain, stretch, vol, muted }
  const voices = new Map();         // trackId -> { kind: 'buffer'|'stretch', source?, playStartAbs, playLoopDur }
  let _muted = false;               // header master mute (all loops)
  let _master = 0.9;                // overall looper output level
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
    // Neural-amp worklet (best-effort; the strip degrades to a passthrough if it
    // isn't available). Awaited so the strip can construct the node on open.
    if (!neuralReady) {
      if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
        neuralReady = ctx.audioWorklet.addModule(neuralWorkletUrl)
          .then(() => true)
          .catch((err) => { console.warn('[qualia] neural-amp worklet failed to load:', err); return false; });
      } else {
        neuralReady = Promise.resolve(false);
      }
    }
    try { await neuralReady; } catch {}
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

  // Accept one render quantum as an array of per-channel Float32Arrays. The
  // channel count is fixed from the first quantum of a take; live peaks come
  // from channel 0.
  function onChunks(chans) {
    if (!chans || !chans.length) return;
    if (!recChans.length) {
      recChannelCount = chans.length;
      recChans = Array.from({ length: recChannelCount }, () => []);
    }
    const n = Math.min(chans.length, recChannelCount);
    for (let c = 0; c < n; c++) recChans[c].push(chans[c]);
    recFrames += chans[0].length;
    foldChunkIntoLive(chans[0]);
  }

  // Open (or replace) the rig input capture on its OWN device (independent of
  // the audio-panel mic). deviceId '' means the default input.
  async function openCapture(deviceId) {
    await ensureContext();
    const want = deviceId || '';
    const constraints = want
      ? { ...MIC_CONSTRAINTS, deviceId: { exact: want } }
      : { ...MIC_CONSTRAINTS };
    const useStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    teardownCapture();
    stream = useStream;
    streamOwned = true;
    const settings = stream.getAudioTracks()[0]?.getSettings() || {};
    streamDeviceId = want || settings.deviceId || '';

    // Clock-match check: when the capture device runs at a different sample
    // rate than the context (which follows the OUTPUT device), the browser
    // inserts a hidden resampler on the mic stream — extra latency that no
    // in-app setting can remove. Surface it (console + getLatencyInfo → rig
    // panel readout) so the fix — set input & output to the same rate in the
    // OS audio settings (Audio MIDI Setup on macOS) — is discoverable.
    _inputSampleRate = Number(settings.sampleRate) || 0;
    if (_inputSampleRate && Math.abs(_inputSampleRate - ctx.sampleRate) > 1) {
      console.warn(`[qualia] rig input runs at ${_inputSampleRate} Hz but the audio context (output device) runs at ${ctx.sampleRate} Hz — the browser is resampling the input, adding latency. Set both devices to the same rate in the OS sound settings.`);
    }

    srcNode = ctx.createMediaStreamSource(stream);

    // Input channel handling. Everything downstream (strip, recorder, scope,
    // tuner) taps `inputNode`:
    //   mono   → sum L+R to one channel, so a single-input instrument is
    //            centred and gets full stereo treatment from the strip's pan /
    //            ping-pong delay / stereo reverb (the panner up-mixes mono to
    //            both channels). Also records mono.
    //   stereo → pass both channels straight through.
    if (_channels === 'stereo') {
      inputNode = ctx.createGain();
      srcNode.connect(inputNode);
    } else {
      monoSplitter = ctx.createChannelSplitter(2);
      inputNode = ctx.createGain();   // both split channels summed into one input
      srcNode.connect(monoSplitter);
      monoSplitter.connect(inputNode, 0);
      monoSplitter.connect(inputNode, 1);
    }

    // Channel strip inserted between the input and the volume fader, so the
    // monitor + the mix carry the PROCESSED signal. The RECORDER taps the strip's
    // OUTPUT (post-fx, see recTap below) so loops bake in the effects that were on
    // at record time; the scope + tuner stay PRE-strip for a clean signal.
    strip = createRigStrip(ctx, _stripConfig);
    if (_cabBuffer) strip.setCabBuffer(_cabBuffer);
    if (_ampModel) strip.setAmpModel(_ampModel);
    inputNode.connect(strip.input);

    // Rig signal monitor: strip → sigGain (volume × mute) → speakers, plus a
    // post-fader analyser adopted into audio.js as 'rig' so the processed signal
    // lands in the mix (visuals + recording) and follows volume/mute — muting
    // pulls it from the mix, like a channel strip's send.
    sigGain = ctx.createGain();
    sigGain.gain.value = effSignal();
    sigGain.__qualiaBypassMute = true;        // the rig owns its own mute
    strip.output.connect(sigGain);
    ensureRigMaster();
    sigGain.connect(rigMaster);
    sigAnalyser = ctx.createAnalyser();
    sigAnalyser.fftSize = 1024;
    sigAnalyser.smoothingTimeConstant = 0.40;
    sigGain.connect(sigAnalyser);
    if (audio?.adoptAnalyser) { try { audio.adoptAnalyser(ctx, sigAnalyser, 'rig'); _rigAdopted = true; } catch {} }

    // A worklet/ScriptProcessor only gets pulled if it has a live downstream;
    // route it through a silent sink so process() keeps firing.
    sinkGain = ctx.createGain();
    sinkGain.gain.value = 0;
    sinkGain.connect(ctx.destination);

    // A non-audible analyser on the raw capture (PRE-fader) so the rig scope can
    // show the exact signal being buffered/recorded even when it's muted, and so
    // the tuner gets a clean pre-distortion window (2048 ≈ 43ms handles low
    // strings down to ~50 Hz).
    captureAnalyser = ctx.createAnalyser();
    captureAnalyser.fftSize = 2048;
    captureAnalyser.smoothingTimeConstant = 0.40;
    inputNode.connect(captureAnalyser);

    // A long-window analyser dedicated to the tuner — ~171ms at 48k so the
    // autocorrelation has several periods of even very low notes (G0 ≈ 24.5 Hz,
    // ~41ms period). Separate from the scope so the scope stays responsive.
    tunerAnalyser = ctx.createAnalyser();
    tunerAnalyser.fftSize = 8192;
    tunerAnalyser.smoothingTimeConstant = 0;
    inputNode.connect(tunerAnalyser);

    // Recorder source — the strip OUTPUT, so the captured loop carries whatever
    // effects were on. In mono mode, sum the strip's stereo output back to one
    // channel (the loop stays mono, just effected); stereo keeps both channels.
    let recTap;
    if (_channels === 'stereo') {
      recTap = strip.output;
    } else {
      recMerge = ctx.createGain();
      recMerge.channelCount = 1;
      recMerge.channelCountMode = 'explicit';
      recMerge.channelInterpretation = 'speakers';
      strip.output.connect(recMerge);
      recTap = recMerge;
    }

    // Channel count for the ScriptProcessor fallback: forced to 1 in mono mode,
    // else the native input count. The worklet adopts it via 'max' channelCount.
    const inCh = _channels === 'stereo' ? Math.max(1, Math.min(2, settings.channelCount || 2)) : 1;

    const ready = await workletReady;
    if (ready) {
      usingWorklet = true;
      recNode = new AudioWorkletNode(ctx, 'looper-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      });
      recNode.port.onmessage = (e) => {
        const d = e.data;
        if (!d) return;
        // Control message: precise ctx time of the first armed quantum (frame 0).
        if (d.t0 !== undefined) { if (firstChunkAbs == null) firstChunkAbs = d.t0; return; }
        // Retro grab response — resolve the matching pending request.
        if (d.grab !== undefined) {
          const resolve = _pendingGrabs.get(d.grab);
          if (resolve) { _pendingGrabs.delete(d.grab); resolve(d); }
          return;
        }
        if (!recording) return;
        if (d.chans) onChunks(d.chans);
      };
      recTap.connect(recNode);
      recNode.connect(sinkGain);
    } else {
      usingWorklet = false;
      recNode = ctx.createScriptProcessor(4096, inCh, inCh);
      recNode.onaudioprocess = (e) => {
        if (!recording) return;
        if (firstChunkAbs == null) firstChunkAbs = e.playbackTime;
        const ib = e.inputBuffer;
        const chans = [];
        for (let c = 0; c < ib.numberOfChannels; c++) {
          const ch = ib.getChannelData(c);
          const copy = new Float32Array(ch.length);
          copy.set(ch);
          chans.push(copy);
        }
        onChunks(chans);
      };
      recTap.connect(recNode);
      recNode.connect(sinkGain);
    }
    // The ring starts filling now (worklet path only — the SP fallback has no ring).
    _ringStartT = usingWorklet ? ctx.currentTime : null;
  }

  function teardownCapture() {
    _ringStartT = null;
    if (_rigAdopted) { try { audio?.releaseAdopted?.('rig'); } catch {} _rigAdopted = false; }
    try { srcNode?.disconnect(); } catch {}
    try { monoSplitter?.disconnect(); } catch {}
    try { inputNode?.disconnect(); } catch {}
    if (recNode) {
      // End the worklet processor (returns false) so its ~15 MB ring GCs;
      // ScriptProcessor fallback just clears its callback.
      try { recNode.port?.postMessage({ cmd: 'dispose' }); } catch {}
      try { recNode.disconnect(); } catch {}
      if ('onaudioprocess' in recNode) recNode.onaudioprocess = null;
    }
    try { sinkGain?.disconnect(); } catch {}
    try { sigGain?.disconnect(); } catch {}
    try { sigAnalyser?.disconnect(); } catch {}
    try { captureAnalyser?.disconnect(); } catch {}
    try { tunerAnalyser?.disconnect(); } catch {}
    try { recMerge?.disconnect(); } catch {}
    recMerge = null;
    try { strip?.dispose(); } catch {}
    strip = null;
    if (stream && streamOwned) { try { stream.getTracks().forEach(t => t.stop()); } catch {} }
    srcNode = recNode = sinkGain = sigGain = sigAnalyser = captureAnalyser = tunerAnalyser = null;
    inputNode = monoSplitter = null;
    stream = null; streamOwned = false;
    _inputSampleRate = 0;
  }

  // ── rig master output ──────────────────────────────────────────────────────
  function ensureRigMaster() {
    if (rigMaster || !ctx) return;
    rigMaster = ctx.createGain();
    rigMaster.gain.value = effRig();
    rigMaster.__qualiaBypassMute = true;
    // Brickwall on the combined rig output (live signal + loop bus) before the
    // speakers — clip insurance so the rig can't push full-scale into the
    // device-level sum. The rig strip's own compressor shapes tone upstream;
    // this only catches true overs. Bypassable from the mixer. This is the
    // ZERO-LATENCY soft-clip variant, not the shared DynamicsCompressor
    // limiter: the live instrument monitor runs through here, and the
    // compressor version costs ~6 ms of lookahead pre-delay even when idle.
    rigLimiter = makeSoftLimiter(ctx, _rigLimiterOn);
    rigLimiter.__qualiaBypassMute = true;
    rigMaster.connect(rigLimiter);
    rigLimiter.connect(ctx.destination);
    // Non-audible analyser on the FULL rig output (processed signal + loop bus,
    // POST master level/mute, PRE limiter) — exactly what's going to the
    // speakers. Lives as long as rigMaster, so the output scope keeps drawing
    // even when the input capture is closed but loops are still playing.
    outputAnalyser = ctx.createAnalyser();
    outputAnalyser.fftSize = 2048;
    outputAnalyser.smoothingTimeConstant = 0.40;
    rigMaster.connect(outputAnalyser);
  }
  function effRig() { return _rigMuted ? 0 : _rigLevel; }

  // ── Freeze / infinite sustain ───────────────────────────────────────────────
  // The ambient pedal-steel drone move: grab the last moment of the PROCESSED
  // signal (the recorder ring taps the strip output, so the pad carries the
  // amp/cab/verb that were on) and loop it as an endless pad under whatever is
  // played next. A long equal-power seam (25% of the grain) makes the pad
  // smooth rather than obviously looped; re-triggering while frozen replaces
  // the grain (evolving drone). Output rides rigMaster → soft limiter, so it
  // obeys the rig level/mute and can't clip the sum.
  const FREEZE_GRAB_SEC = 1.6;     // ring slice requested (grain + seam + margin)
  const FREEZE_GRAIN_SEC = 1.0;    // loop length
  const FREEZE_LEVEL = 0.8;        // pad sits just under the live signal
  let _freeze = null;              // { source, gain }

  function isFrozen() { return !!_freeze; }

  function freezeStop({ fadeSec = 0.35 } = {}) {
    const f = _freeze;
    if (!f) return;
    _freeze = null;
    try {
      const t = ctx.currentTime;
      f.gain.gain.cancelScheduledValues(t);
      f.gain.gain.setValueAtTime(f.gain.gain.value, t);
      f.gain.gain.linearRampToValueAtTime(0, t + fadeSec);
      f.source.stop(t + fadeSec + 0.05);
      setTimeout(() => { try { f.source.disconnect(); f.gain.disconnect(); } catch {} }, (fadeSec + 0.2) * 1000);
    } catch {}
  }

  async function freezeStart() {
    if (!usingWorklet || !recNode || !srcNode) return false;   // needs the ring (capture open)
    await ensureContext();
    ensureRigMaster();
    // Grab the newest slice of the ring (same plumbing as retro-grab).
    const id = `f${(_grabSeq++).toString(36)}`;
    const resp = await new Promise((resolve) => {
      _pendingGrabs.set(id, resolve);
      try { recNode.port.postMessage({ cmd: 'grab', seconds: FREEZE_GRAB_SEC, id }); }
      catch { _pendingGrabs.delete(id); resolve(null); }
      setTimeout(() => { if (_pendingGrabs.has(id)) { _pendingGrabs.delete(id); resolve(null); } }, 600);
    });
    if (!resp || !resp.chans || !resp.chans.length || !resp.frames) return false;

    const sr = resp.sampleRate || ctx.sampleRate;
    const grain = Math.min(Math.round(FREEZE_GRAIN_SEC * sr), resp.frames);
    const nSeam = grain >> 2;                       // 25% seam → pad, not loop
    if (grain < sr * 0.2) return false;             // too little audio to freeze
    const start = resp.frames - grain;              // newest `grain` frames
    const buf = ctx.createBuffer(resp.chans.length, grain, sr);
    for (let ch = 0; ch < resp.chans.length; ch++) {
      const src = resp.chans[ch];
      const d = buf.getChannelData(ch);
      d.set(src.subarray(start, start + grain));
      // Seam: crossfade the tail into the audio preceding the grain (real
      // recorded continuity when the ring has it, else fade against the head).
      const hasPre = start >= nSeam;
      for (let i = 0; i < nSeam; i++) {
        const t = (i + 1) / nSeam;
        const gOut = Math.cos(t * Math.PI / 2);
        const gIn = Math.sin(t * Math.PI / 2);
        d[grain - nSeam + i] = hasPre
          ? d[grain - nSeam + i] * gOut + src[start - nSeam + i] * gIn
          : d[grain - nSeam + i] * gOut + d[i] * gIn;
      }
      if (!hasPre) for (let i = 0; i < 64 && i < grain; i++) d[i] *= i / 64; // de-click head
    }

    freezeStop({ fadeSec: 0.2 });                  // replace an existing pad
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(rigMaster);
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;
    source.connect(gain);
    const t = ctx.currentTime;
    source.start(t);
    gain.gain.linearRampToValueAtTime(FREEZE_LEVEL, t + 0.08);
    _freeze = { source, gain };
    return true;
  }

  async function toggleFreeze() {
    if (_freeze) { freezeStop(); return false; }
    return freezeStart();
  }

  function setRigMuted(on) { _rigMuted = !!on; if (rigMaster) ramp(rigMaster.gain, effRig()); }
  function setRigLevel(v) { _rigLevel = clamp01(v); if (rigMaster && !_rigMuted) ramp(rigMaster.gain, _rigLevel); }
  function primeRig(level, muted) { _rigLevel = clamp01(level); _rigMuted = !!muted; if (rigMaster) ramp(rigMaster.gain, effRig()); }
  function setRigLimiter(on) { _rigLimiterOn = !!on; setSoftLimiterEngaged(rigLimiter, _rigLimiterOn); }
  function getRigLimiter() { return _rigLimiterOn; }
  function primeRigLimiter(on) { _rigLimiterOn = !!on; setSoftLimiterEngaged(rigLimiter, _rigLimiterOn); }
  function getRigMaster() { return { level: _rigLevel, muted: _rigMuted, limiter: _rigLimiterOn }; }

  // ── latency introspection (rig panel readout) ──────────────────────────────
  // What the browser reports plus what the strip knows it adds. `outputSec` is
  // live (Chrome updates ctx.outputLatency as the device buffer settles); input
  // capture buffering is NOT observable from JS, so the true round trip is a
  // little higher than base+output+graph. `resampled` flags a mic/output
  // clock mismatch (hidden resampler — fix in OS sound settings).
  function getLatencyInfo() {
    if (!ctx) return null;
    return {
      baseSec:   ctx.baseLatency || 0,
      outputSec: ctx.outputLatency || 0,
      graphSec:  strip ? strip.getLatencySeconds() : 0,
      sampleRate: ctx.sampleRate,
      inputSampleRate: _inputSampleRate,
      resampled: !!(_inputSampleRate && Math.abs(_inputSampleRate - ctx.sampleRate) > 1),
      live: !!srcNode,
    };
  }

  // ── rig signal level / mute (channel-strip volume + mute) ──────────────────
  function effSignal() { return _sigMuted ? 0 : _sigLevel; }
  function wantCapture() { return _bufferOn || recording || _sigLevel > 0; }
  // Open capture if anything needs it; close it when nothing does.
  async function ensureCaptureOpen(deviceId) {
    await ensureContext();
    await ensureCapture(deviceId ?? streamDeviceId ?? '');
  }
  function maybeCloseCapture() {
    if (!wantCapture() && srcNode) teardownCapture();
  }
  // Set value only (no capture open) — for restoring persisted state pre-gesture.
  function primeSignal(level, muted) {
    _sigLevel = clamp01(level);
    _sigMuted = !!muted;
    if (sigGain) ramp(sigGain.gain, effSignal());
  }
  async function setSignalLevel(v, deviceId) {
    _sigLevel = clamp01(v);
    if (_sigLevel > 0 && !srcNode) { try { await ensureCaptureOpen(deviceId); } catch (e) { console.warn('[qualia] rig signal capture failed:', e); } }
    if (sigGain) ramp(sigGain.gain, effSignal());
    maybeCloseCapture();
  }
  function setSignalMuted(on) {
    _sigMuted = !!on;
    if (sigGain) ramp(sigGain.gain, effSignal());
  }
  function getSignal() { return { level: _sigLevel, muted: _sigMuted, live: !!srcNode }; }
  function getChannels() { return _channels; }
  // Switch mono/stereo input. Reopens the capture (cheap; loops keep playing) so
  // the input routing rebuilds — unless mid-record, where it applies next open.
  async function setChannels(mode) {
    const next = mode === 'stereo' ? 'stereo' : 'mono';
    if (next === _channels) return;
    _channels = next;
    if (srcNode && !recording) { try { await openCapture(streamDeviceId); } catch (e) { console.warn('[qualia] channel mode switch failed:', e); } }
  }

  // Dedupe concurrent opens — a fader drag from 0 can call this many times
  // before the first getUserMedia resolves (srcNode is still null), which would
  // otherwise open several streams and teardown-race each other.
  let _openPromise = null;
  async function ensureCapture(deviceId) {
    const want = deviceId || '';
    if (srcNode && want === (streamDeviceId || '')) return;
    if (_openPromise) {
      try { await _openPromise; } catch {}
      if (srcNode && want === (streamDeviceId || '')) return;
    }
    _openPromise = openCapture(want).finally(() => { _openPromise = null; });
    return _openPromise;
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
    recChans = []; recChannelCount = 1; recFrames = 0;
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
        // Release the rig capture if nothing else wants it open (buffer off and
        // the signal monitor down); the ring keeps filling otherwise.
        maybeCloseCapture();
        const sr = ctx.sampleRate;
        const total = recFrames;
        const nch = Math.max(1, recChannelCount);
        // Concat per-channel chunk lists into contiguous channel arrays.
        const all = [];
        for (let c = 0; c < nch; c++) {
          const a = new Float32Array(total);
          let off = 0;
          for (const chunk of (recChans[c] || [])) { a.set(chunk, off); off += chunk.length; }
          all.push(a);
        }
        recChans = [];

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
        const regionLen = sliceTo - sliceFrom;
        const buffer = ctx.createBuffer(nch, regionLen, sr);
        for (let c = 0; c < nch; c++) buffer.copyToChannel(all[c].subarray(sliceFrom, sliceTo), c);
        const loopStartBase = padStart;   // sample idx of the musical IN within `buffer`

        snapIn = null;
        resolve({
          buffer, sampleRate: sr,
          loopStartBase, regionFrames,
          naturalSeconds: regionFrames / sr,
          recordedCycles,
          contentFrames: trailingContentFrames(buffer, loopStartBase, regionFrames, sr),
        });
      };

      // Wait for the OUT boundary + the post-pad audio to arrive (so the nudge
      // has headroom). If OUT already elapsed (rounded down), finish now.
      const waitMs = (outAbs + PAD_SEC - ctx.currentTime) * 1000;
      if (waitMs < 5) finish();
      else setTimeout(finish, waitMs + 20);
    });
  }

  // ── retroactive ring buffer ──
  // Keep the capture open so the worklet's always-on ring keeps filling, even
  // when not recording. Retro only works on the worklet path (the ring lives in
  // the processor); the ScriptProcessor fallback returns not-capable.
  async function startBuffer(deviceId) {
    await ensureContext();
    await ensureCapture(deviceId || streamDeviceId || '');
    _bufferOn = true;
    return usingWorklet;
  }
  function stopBuffer() {
    _bufferOn = false;
    maybeCloseCapture();   // keep open if the signal monitor or a record needs it
  }

  // Grab the most recent `cycles` of the live ring as a loop, phase-locked to
  // the Strudel grid. Resolves to the same track shape as stopRecording (buffer
  // padded both sides, loopStartBase, regionFrames, naturalSeconds,
  // recordedCycles) or null when the ring can't cover a single grid unit.
  async function grabRetro({ grid = 1, syncOn = false, cps = 0.5, cycles = 4 } = {}) {
    if (!usingWorklet || !recNode) return null;     // ring lives in the worklet
    await ensureContext();
    if (!srcNode) return null;                       // capture must be open
    const N = grid > 0 ? grid : 1;
    let L = Math.max(N, Math.round((cycles > 0 ? cycles : N) / N) * N);

    // Anchor the Strudel grid to a looper-ctx reference time read right now.
    const tRef = ctx.currentTime;
    let info = null;
    if (syncOn) {
      const i = syncStrudel?.getStrudelCyclePos?.();
      if (i && i.cps > 0 && typeof i.pos === 'number') info = i;
    }
    const effCps = info ? info.cps : (cps > 0 ? cps : 0.5);

    // Clamp to what the ring can hold (leave PAD headroom on both ends).
    const maxByRing = Math.max(N, Math.floor(((RING_SECONDS - 2 * PAD_SEC - 0.2) * effCps) / N) * N);
    if (L > maxByRing) L = maxByRing;

    const secondsWanted = L / effCps + 2 * PAD_SEC + 0.3;
    const id = `g${(_grabSeq++).toString(36)}`;
    const resp = await new Promise((resolve) => {
      _pendingGrabs.set(id, resolve);
      try { recNode.port.postMessage({ cmd: 'grab', seconds: secondsWanted, id }); }
      catch { _pendingGrabs.delete(id); resolve(null); }
      setTimeout(() => { if (_pendingGrabs.has(id)) { _pendingGrabs.delete(id); resolve(null); } }, 600);
    });
    if (!resp || !resp.chans || !resp.chans.length || !resp.frames) return null;

    const sr = resp.sampleRate || ctx.sampleRate;
    const total = resp.frames;
    const fpc = sr / effCps;                          // frames per cycle

    // OUT boundary. Snap to the NEAREST grid boundary; if that boundary is
    // still in the future, fall back to the last one that passed. Then clamp to
    // the captured end — the boundary may sit a few ms past the worklet's last
    // block (it can't grab audio not yet captured); the residual offset is what
    // the global "nudge ms" compensates, same as a normal recording.
    let outAbs;
    if (info) {
      let endCycle = Math.round(info.pos / N) * N;
      outAbs = tRef + (endCycle - info.pos) / info.cps;
      if (outAbs > tRef + EPS) {
        endCycle = Math.floor(info.pos / N) * N;
        outAbs = tRef + (endCycle - info.pos) / info.cps;
      }
      if (outAbs > resp.tEnd) outAbs = resp.tEnd;
    } else {
      outAbs = resp.tEnd;                             // free mode: end "now"
    }
    let outFrame = Math.round((outAbs - resp.tStart) * sr);
    outFrame = Math.max(0, Math.min(total, outFrame));

    // Step back whole grid units from OUT, clamped to the audio present, so the
    // loop is an integer number of cycles and phase-locked to the grid.
    const maxL = Math.floor(outFrame / fpc / N) * N;
    if (maxL < N) return null;                        // ring too short for one unit
    const effL = Math.max(N, Math.min(L, maxL));
    let inFrame = Math.round(outFrame - effL * fpc);
    inFrame = Math.max(0, Math.min(outFrame, inFrame));
    const regionFrames = outFrame - inFrame;
    if (regionFrames < 16) return null;

    const pad = Math.round(PAD_SEC * sr);
    const padStart = Math.min(pad, inFrame);
    const padEnd   = Math.min(pad, total - outFrame);
    const sliceFrom = inFrame - padStart;
    const sliceTo   = outFrame + padEnd;
    const regionLen = sliceTo - sliceFrom;
    const nch = resp.chans.length;
    const buffer = ctx.createBuffer(nch, regionLen, sr);
    for (let c = 0; c < nch; c++) {
      const src = resp.chans[c] instanceof Float32Array ? resp.chans[c] : new Float32Array(resp.chans[c]);
      buffer.copyToChannel(src.subarray(sliceFrom, sliceTo), c);
    }
    return {
      buffer, sampleRate: sr,
      loopStartBase: padStart,
      regionFrames,
      naturalSeconds: regionFrames / sr,
      recordedCycles: effL,
      contentFrames: trailingContentFrames(buffer, padStart, regionFrames, sr),
    };
  }

  // ── playback / monitor bus ──
  function ensureBus() {
    if (loopMaster) return;
    loopMaster = ctx.createGain();
    loopMaster.gain.value = _muted ? 0 : _master;
    // Tag so Strudel's connect-into-destination mute patch leaves the looper
    // alone — the looper owns its own mute on loopMaster (mirrors kit.output).
    loopMaster.__qualiaBypassMute = true;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.40;
    ensureRigMaster();
    loopMaster.connect(rigMaster);
    loopMaster.connect(analyser);
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

  // Frames of audible content from the region head, i.e. the region minus
  // trailing near-silence — so "tile" can repeat gaplessly while "once" keeps the
  // full region (its trailing silence becomes the rest-of-the-bar). Scans back in
  // 5ms windows for the last sound, adds a 20ms tail, snaps to a zero-crossing to
  // avoid a click. Returns regionFrames when there's no trailing silence.
  function trailingContentFrames(buffer, startFrame, regionFrames, sr) {
    const THRESH = 0.008;                          // ≈ -42 dBFS
    const win = Math.max(1, Math.round(0.005 * sr));
    const nch = buffer.numberOfChannels;
    const end = startFrame + regionFrames;
    let last = startFrame;
    for (let w = end; w > startFrame; w -= win) {
      const from = Math.max(startFrame, w - win);
      let peak = 0;
      for (let c = 0; c < nch; c++) {
        const d = buffer.getChannelData(c);
        for (let i = from; i < w; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
      }
      if (peak >= THRESH) { last = w; break; }
    }
    let content = Math.min(regionFrames, (last - startFrame) + Math.round(0.02 * sr));
    const d0 = buffer.getChannelData(0);
    for (let i = startFrame + content; i < end - 1; i++) {
      if ((d0[i] <= 0 && d0[i + 1] > 0) || (d0[i] >= 0 && d0[i + 1] < 0)) { content = i - startFrame; break; }
    }
    return Math.max(1, Math.min(regionFrames, content));
  }

  // Effective loop-start sample within track.buffer after applying the nudge,
  // clamped so the region stays inside the padded buffer.
  function effLoopStartFrame(track) {
    const sr = track.sampleRate;
    const maxStart = Math.max(0, track.buffer.length - track.regionFrames);
    const want = track.loopStartBase + Math.round((_offsetMs / 1000) * sr);
    return Math.max(0, Math.min(maxStart, want));
  }

  // Rebuild an AudioBuffer from stored PCM (for IndexedDB restore). Accepts a
  // single Float32Array (legacy mono) or an array of per-channel Float32Arrays
  // (stereo). Uses the looper's own ctx; a buffer may carry its own sampleRate
  // (BufferSource resamples on playback) so a recording survives a
  // different-rate reload.
  function makeBuffer(pcm, sampleRate) {
    const chans = Array.isArray(pcm) ? pcm : (pcm ? [pcm] : null);
    if (!chans || !chans.length || !chans[0] || !chans[0].length) return null;
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }); }
      catch { return null; }
    }
    const len = chans[0].length;
    const buf = ctx.createBuffer(chans.length, len, sampleRate || ctx.sampleRate);
    for (let c = 0; c < chans.length; c++) {
      const d = chans[c] instanceof Float32Array ? chans[c] : new Float32Array(chans[c]);
      buf.copyToChannel(d.length === len ? d : d.subarray(0, len), c);
    }
    return buf;
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

  // Loop phase 0..1 at `now + ahead`, locked so Strudel cycle ≡ 0 (mod length)
  // is phase 0. Used by "start now" to drop in mid-cycle. 0 when unsynced / no
  // Strudel position (so immediate start just begins at the loop head).
  function currentPhase(length, syncOn, ahead = 0) {
    if (!syncOn) return 0;
    const info = syncStrudel?.getStrudelCyclePos?.();
    if (!info || !(info.cps > 0) || typeof info.pos !== 'number') return 0;
    const L = length > 0 ? length : 1;
    let ph = ((info.pos + ahead * info.cps) % L) / L;
    if (ph < 0) ph += 1;
    return ph;
  }

  // The persistent output channel for a track (gain → loopMaster), created on
  // demand and reused across play/stop. Volume + mute live here.
  function ensureChan(id) {
    let c = chans.get(id);
    if (!c) {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(loopMaster);
      c = { gain, stretch: null, vol: 0.5, muted: false };
      chans.set(id, c);
    }
    return c;
  }

  // Lazily attach a Signalsmith stretch node to a channel (pitch-preserving
  // time-stretch). Cached on the channel; null if the library fails to load
  // (caller falls back to varispeed).
  async function ensureStretch(c, channels) {
    if (c.stretch) return c.stretch;
    const node = await createStretchNode(ctx, channels);
    if (!node) return null;
    try { node.connect(c.gain); } catch {}
    c.stretch = node;
    return node;
  }

  // ── Loop-seam crossfade ────────────────────────────────────────────────────
  // A loop region whose IN/OUT are grid boundaries lands mid-waveform, so the
  // wrap (last sample → first sample) is an amplitude step — an audible click
  // every pass, which on sustained ambient material is a metronome of clicks.
  // Fix: equal-power crossfade the region's TAIL into the audio immediately
  // BEFORE the region start (the ring/recording has pre-roll), so at the wrap
  // the signal is genuinely continuous (B[s-1]→B[s] as recorded). With no
  // pre-roll, fall back to a micro fade-out(tail)+fade-in(head) — a tiny dip,
  // never a click.
  const SEAM_FADE_SEC = 0.008;

  // Bake the seam into the track's buffer IN PLACE, before source.start()
  // acquires the content. Returns an undo record (restored by stopVoice) so
  // the stored PCM/waveform stays pristine and re-locks re-bake at the new
  // nudge-shifted position.
  function bakeSeam(buffer, startFrame, loopFrames, sr) {
    const n = Math.min(Math.round(SEAM_FADE_SEC * sr), loopFrames >> 1);
    if (n < 8) return null;
    const tailAt = startFrame + loopFrames - n;
    const hasPre = startFrame >= n;
    const nch = buffer.numberOfChannels;
    const saved = { tailAt, n, tails: [], heads: hasPre ? null : [] };
    for (let ch = 0; ch < nch; ch++) {
      const d = buffer.getChannelData(ch);
      saved.tails.push(d.slice(tailAt, tailAt + n));
      if (!hasPre) saved.heads.push(d.slice(startFrame, startFrame + n));
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / n;
        const gOut = Math.cos(t * Math.PI / 2);
        if (hasPre) {
          d[tailAt + i] = d[tailAt + i] * gOut + d[startFrame - n + i] * Math.sin(t * Math.PI / 2);
        } else {
          d[tailAt + i] *= gOut;                       // tail → 0…
          d[startFrame + i] *= Math.sin((i / n) * Math.PI / 2); // …head from 0
        }
      }
    }
    saved.startFrame = startFrame;
    return saved;
  }

  function unbakeSeam(buffer, bake) {
    if (!bake) return;
    try {
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const d = buffer.getChannelData(ch);
        d.set(bake.tails[ch], bake.tailAt);
        if (bake.heads) d.set(bake.heads[ch], bake.startFrame);
      }
    } catch {}
  }

  // Same crossfade applied to freshly-sliced region copies (the stretch path
  // owns its copies, so no undo needed). `preSlices` = per-channel arrays of
  // the n samples before the region start, or null.
  function xfadeRegionCopies(regions, preSlices, sr) {
    const len = regions[0]?.length || 0;
    const n = Math.min(Math.round(SEAM_FADE_SEC * sr), len >> 1);
    if (n < 8) return;
    for (let ch = 0; ch < regions.length; ch++) {
      const d = regions[ch];
      const pre = preSlices ? preSlices[ch] : null;
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / n;
        const gOut = Math.cos(t * Math.PI / 2);
        if (pre) d[len - n + i] = d[len - n + i] * gOut + pre[i] * Math.sin(t * Math.PI / 2);
        else {
          d[len - n + i] *= gOut;
          d[i] *= Math.sin((i / n) * Math.PI / 2);
        }
      }
    }
  }

  // Start (or restart) one track's loop voice. Other voices keep playing — only
  // the voice for this track.id is replaced, so re-locking one loop to a new
  // boundary (length / nudge change) doesn't disturb the rest.
  async function playVoice(track, { grid = 1, syncOn = false, cps = 0.5, immediate = false } = {}) {
    if (!track || !track.buffer || !track.id) return false;
    await ensureContext();
    ensureBus();
    stopVoice(track.id);
    const c = ensureChan(track.id);
    c.vol = clamp01(track.volume == null ? 0.5 : track.volume);
    c.muted = !!track.muted;
    c.gain.gain.value = c.muted ? 0 : c.vol;
    const sr = track.sampleRate;
    // Fill mode decides rate + loop length:
    //   fit  → stretch the region to `length` cycles (rate ≠ 1; vari/keep pitch)
    //   once → natural rate, loop the FULL region (trailing silence = rest of bar)
    //   tile → natural rate, loop the region trimmed of trailing silence (gapless)
    const mode = track.fitMode || 'once';
    const isFit = mode === 'fit';
    const rate = isFit ? derivePlaybackRate(track, cps) : 1;
    const loopFrames = (mode === 'tile')
      ? Math.max(1, Math.min(track.regionFrames, track.contentFrames || track.regionFrames))
      : track.regionFrames;
    const startFrame = effLoopStartFrame(track);
    const regionSec = loopFrames / sr;
    const playLoopDur = regionSec / rate;   // output seconds per loop

    // When + phase to start at: the next grid boundary at the loop head
    // (default), or — with "start now" — immediately at the current Strudel
    // phase within the loop. Computed fresh per call (after any async load).
    const plan = () => immediate
      ? { when: ctx.currentTime + START_MARGIN, phase: currentPhase(track.length, syncOn, START_MARGIN) }
      : { when: nextBoundaryAbs(grid, syncOn), phase: 0 };

    // Pitch-preserving path: feed the nudge-adjusted region (all channels) into
    // the stretch node and loop it at `rate` with no pitch shift. Only in `fit`
    // mode — once/tile play at natural rate (1×), where there's nothing to
    // pitch-preserve, so they take the plain varispeed path below.
    if (isFit && track.preservePitch) {
      const nch = track.buffer.numberOfChannels;
      const node = await ensureStretch(c, nch);
      if (node) {
        const regions = [];
        for (let ch = 0; ch < nch; ch++) regions.push(track.buffer.getChannelData(ch).slice(startFrame, startFrame + track.regionFrames));
        // Seam crossfade on the copies (see bakeSeam) so the stretch loop
        // doesn't click every wrap.
        const nPre = Math.min(Math.round(SEAM_FADE_SEC * sr), track.regionFrames >> 1);
        const preSlices = startFrame >= nPre && nPre >= 8
          ? Array.from({ length: nch }, (_, ch) => track.buffer.getChannelData(ch).slice(startFrame - nPre, startFrame))
          : null;
        xfadeRegionCopies(regions, preSlices, sr);
        try {
          node.dropBuffers();
          await node.addBuffers(regions);
          const { when, phase } = plan();   // re-read after the async load for a tight lock
          node.schedule({ output: when, active: true, input: phase * regionSec, rate, semitones: 0, loopStart: 0, loopEnd: regionSec });
          voices.set(track.id, { kind: 'stretch', playStartAbs: when - phase * playLoopDur, playLoopDur });
          ensureAdopted();
          return true;
        } catch (err) {
          console.warn('[qualia] looper stretch playback failed; varispeed fallback:', err);
        }
      }
    }

    // Varispeed path (default): a looping BufferSource (pitch shifts with rate).
    // Stereo buffers play natively; `offset` drops in at the current phase.
    // Seam-bake BEFORE start() and keep it for the voice's lifetime (restored
    // in stopVoice): whether the engine snapshots the buffer at start() or
    // keeps referencing it live (implementations differ), the playing loop has
    // the crossfade either way. A persist/export while the voice plays
    // captures the 8 ms seam — which loops cleanly in a DAW too; stopped
    // tracks persist pristine. A re-lock (stop→play) re-bakes at the new
    // nudge-shifted position.
    const seam = bakeSeam(track.buffer, startFrame, loopFrames, sr);
    const { when, phase } = plan();
    const source = ctx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = true;
    source.loopStart = startFrame / sr;
    source.loopEnd = (startFrame + loopFrames) / sr;
    source.playbackRate.value = rate;
    source.connect(c.gain);
    source.start(when, (startFrame + phase * loopFrames) / sr);
    voices.set(track.id, { kind: 'buffer', source, playStartAbs: when - phase * playLoopDur, playLoopDur, seam, buffer: track.buffer });
    ensureAdopted();
    return true;
  }

  function stopVoice(id) {
    const v = voices.get(id);
    if (!v) return;
    if (v.kind === 'buffer' && v.source) {
      try { v.source.stop(); } catch {}
      try { v.source.disconnect(); } catch {}
      if (v.seam) unbakeSeam(v.buffer, v.seam);
    } else if (v.kind === 'stretch') {
      // Keep the cached stretch node; just stop processing.
      try { chans.get(id)?.stretch?.stop(); } catch {}
    }
    voices.delete(id);
    maybeRelease();
  }

  function stopAll() {
    for (const id of Array.from(voices.keys())) stopVoice(id);
  }

  // Tear down a track's whole channel (gain + stretch node) — on delete.
  function removeTrack(id) {
    stopVoice(id);
    const c = chans.get(id);
    if (c) {
      try { c.stretch?.stop?.(); } catch {}
      try { c.stretch?.disconnect?.(); } catch {}
      try { c.gain.disconnect(); } catch {}
      chans.delete(id);
    }
  }

  function removeAll() {
    for (const id of Array.from(chans.keys())) removeTrack(id);
    for (const id of Array.from(voices.keys())) stopVoice(id);
  }

  // Drop the adopted 'looper' analyser once nothing is looping, so the source
  // disappears from the visualizer + recordable mix when silent.
  function maybeRelease() {
    if (voices.size === 0 && _adopted) { audio?.releaseAdopted?.('looper'); _adopted = false; }
  }

  function ramp(param, target) {
    try {
      const t = ctx.currentTime;
      param.cancelScheduledValues(t);
      param.linearRampToValueAtTime(target, t + 0.04);
    } catch { try { param.value = target; } catch {} }
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  // Header master (all loops) — volume + mute on loopMaster.
  function setMuted(on) { _muted = !!on; if (loopMaster) ramp(loopMaster.gain, _muted ? 0 : _master); }
  function setMaster(v)  { _master = clamp01(v); if (loopMaster && !_muted) ramp(loopMaster.gain, _master); }
  // Per-track volume + mute — operate on the persistent channel gain, so they
  // work whether or not the track is currently playing. Before a track has ever
  // played there's no channel yet; the model holds the value and playVoice
  // applies it on next play.
  function setTrackVolume(id, v) {
    const c = chans.get(id);
    if (!c) return;
    c.vol = clamp01(v);
    if (!c.muted) ramp(c.gain.gain, c.vol);
  }
  function setTrackMuted(id, on) {
    const c = chans.get(id);
    if (!c) return;
    c.muted = !!on;
    ramp(c.gain.gain, c.muted ? 0 : c.vol);
  }
  function setOffsetMs(v) { _offsetMs = Number(v) || 0; }
  function getOffsetMs() { return _offsetMs; }

  // Loop phase 0..1 across the whole take for one track, or null when that
  // track isn't playing.
  function getPlayhead01(id) {
    const v = voices.get(id);
    if (!v || v.playStartAbs == null || !(v.playLoopDur > 0) || !ctx) return null;
    const t = ctx.currentTime;
    if (t < v.playStartAbs) return 0;
    return ((t - v.playStartAbs) % v.playLoopDur) / v.playLoopDur;
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
    freezeStop({ fadeSec: 0.05 });
    for (const resolve of _pendingGrabs.values()) { try { resolve(null); } catch {} }
    _pendingGrabs.clear();
    removeAll();
    teardownCapture();
    if (_adopted) { audio?.releaseAdopted?.('looper'); _adopted = false; }
    try { loopMaster?.disconnect(); } catch {}
    try { analyser?.disconnect(); } catch {}
    try { outputAnalyser?.disconnect(); } catch {}
    try { rigLimiter?.disconnect(); } catch {}
    try { rigMaster?.disconnect(); } catch {}
    rigMaster = outputAnalyser = rigLimiter = null;
    loopMaster = analyser = null;
    try { ctx?.close(); } catch {}
    ctx = null; workletReady = null;
  }

  return {
    ensureContext,
    // Switch the rig input device: reopen on the new device when capture is
    // live, otherwise just remember it for the next open.
    setInputDevice: async (id) => {
      const want = id || '';
      if (srcNode && !recording) await openCapture(want);
      else streamDeviceId = want;
    },
    getInputDeviceId: () => streamDeviceId,
    startRecording, stopRecording,
    startBuffer, stopBuffer, grabRetro,
    ensureCaptureOpen,
    setRigMuted, setRigLevel, primeRig, getRigMaster,
    setRigLimiter, getRigLimiter, primeRigLimiter,
    getLatencyInfo,
    setSignalLevel, setSignalMuted, getSignal, primeSignal,
    setChannels, getChannels,
    // Channel strip — persisted config lives in looper.js; updates apply to the
    // live strip when capture is open and are remembered for the next open.
    setStripConfig: (cfg) => { _stripConfig = cfg; strip?.setConfig(cfg); },
    getStripConfig: () => (strip ? strip.getConfig() : _stripConfig),
    setStripParam: (stage, param, val) => {
      if (!_stripConfig) _stripConfig = {};
      _stripConfig[stage] = { ...(_stripConfig[stage] || {}), [param]: val };
      strip?.setParam(stage, param, val);
    },
    setStripEnabled: (stage, on) => {
      if (!_stripConfig) _stripConfig = {};
      _stripConfig[stage] = { ...(_stripConfig[stage] || {}), on: !!on };
      strip?.setEnabled(stage, !!on);
    },
    // Live pre/post-peq analyser taps for the peq editor's spectrum overlay.
    // Re-query per frame — the strip (and its taps) are rebuilt on capture open.
    getPeqAnalysers: () => strip?.getPeqAnalysers?.() || null,
    // Cab / IR loader: decode raw file bytes with the looper's ctx and apply to
    // the strip's convolver (kept across capture reopens). bytes are copied so
    // the caller's ArrayBuffer survives (decodeAudioData detaches its input).
    setCabIRBytes: async (bytes) => {
      if (!bytes) return false;
      await ensureContext();
      try {
        const buf = await ctx.decodeAudioData(bytes.slice(0));
        _cabBuffer = buf;
        strip?.setCabBuffer(buf);
        return true;
      } catch (e) { console.warn('[qualia] cab IR decode failed:', e); return false; }
    },
    clearCabIR: () => { _cabBuffer = null; strip?.setCabBuffer(null); },
    hasCabIR: () => !!_cabBuffer,
    // Neural amp: a normalised LSTM model (from neural-amp-model.js) applied to
    // the strip's worklet node; kept across capture reopens.
    setAmpModel: (model) => { _ampModel = model || null; strip?.setAmpModel(_ampModel); },
    clearAmp: () => { _ampModel = null; strip?.setAmpModel(null); },
    hasAmp: () => !!_ampModel,
    isAmpCapable: () => typeof AudioWorkletNode !== 'undefined',
    isBuffering: () => _bufferOn && !!srcNode,
    isRetroCapable: () => usingWorklet,
    // How much lookback is available right now, for the "grab" buffer readout.
    // `seconds` grows from capture-open to the RING_SECONDS cap.
    getBufferInfo: () => {
      const capable = usingWorklet && !!srcNode && _ringStartT != null;
      const seconds = capable ? Math.min(Math.max(0, ctx.currentTime - _ringStartT), RING_SECONDS) : 0;
      return { capable, seconds, capSeconds: RING_SECONDS };
    },
    getCaptureAnalyser: () => captureAnalyser,
    getTunerAnalyser: () => tunerAnalyser,
    // Freeze / infinite-sustain pad (see freezeStart above).
    toggleFreeze, isFrozen, freezeStart, freezeStop,
    // Current monophonic pitch of the clean (pre-strip) input, in Hz, or -1
    // when the rig isn't capturing / the signal is unvoiced or too quiet. Reads
    // the tuner analyser's newest window and autocorrelates it — allocation-
    // free. Callers (the pitch-channel glue) throttle this; it never runs on
    // the audio thread.
    getInputPitchHz() {
      if (!tunerAnalyser) return -1;
      const n = Math.min(PITCH_WINDOW, tunerAnalyser.fftSize);
      const buf = n === PITCH_WINDOW ? _pitchBuf : (_pitchBuf = new Float32Array(n));
      try { tunerAnalyser.getFloatTimeDomainData(buf); } catch { return -1; }
      return autoCorrelate(buf, ctx?.sampleRate || 48000, 60, 1200);
    },
    // Full rig output (signal + loops, post master) — for the output scope.
    getOutputAnalyser: () => outputAnalyser,
    playVoice, stopVoice, stopAll, removeTrack, removeAll,
    setMuted, setMaster,
    setTrackVolume, setTrackMuted,
    setOffsetMs, getOffsetMs,
    makeBuffer,
    getLoopRegion,
    getPlayhead01,
    getLiveView,
    isCapturing: () => !!srcNode,
    isRecording: () => recording,
    isVoicePlaying: (id) => voices.has(id),
    anyPlaying: () => voices.size > 0,
    dispose,
  };
}
