// Audio pipeline: WebAudio analyser → bass/mids/highs bands + bass-beat +
// highs-transient, both delivered through the QualiaField every frame.
//
// Lifted near-verbatim from cymatics:688–752,760–771,1733–1784. Two important
// differences:
//   1. State is per-instance, not global, so multiple harnesses can coexist
//      (and so the page can be torn down without leaking analysers).
//   2. The output is an AudioFrame object — not a pile of free vars. Fx code
//      reads `field.audio.bands.bass`, etc.
//
// Mic constraints disable browser DSP for the same reasons as cymatics:
//   - AGC pumping in loud rooms ruins the band envelopes.
//   - Android's VOICE_COMMUNICATION mode would fight a screen recorder.

import { emptyAudioFrame, ema } from './field.js';

const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl:  false,
};

export function createAudio() {
  const frame = emptyAudioFrame();

  let stream    = null;
  let ctx       = null;
  let analyser  = null;
  let freqBuf   = null;
  let timeBuf   = null;
  let enabled   = false;
  let micId     = null;
  let source    = 'off'; // 'off' | 'mic' | 'strudel'

  // State-change listeners — fired whenever the audio source changes (mic
  // start/stop, Strudel adopt/release). Page UI subscribes so the topbar
  // button stays consistent regardless of which subsystem flipped state.
  const listeners = new Set();
  function notify() {
    const snap = { enabled, source, micId };
    listeners.forEach(fn => { try { fn(snap); } catch {} });
  }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // Tunables (preset-driven by presets.js)
  let gain         = 1.0;
  let alpha        = 0.14;   // EMA factor on band values
  let beatThresh   = 1.40;
  let beatCooldown = 320;

  let binBassLo = 0,  binBassHi = 8;
  let binMidsLo = 8,  binMidsHi = 80;
  let binHighsLo= 80, binHighsHi= 200;

  // Beat / transient state
  let bassAvg = 0, highsAvg = 0;
  let lastBeatMs = 0, lastHighsMs = 0;

  function configureBins() {
    if (!ctx || !analyser) return;
    freqBuf = new Uint8Array(analyser.frequencyBinCount);
    timeBuf = new Uint8Array(analyser.fftSize);
    const hz = ctx.sampleRate / analyser.fftSize;
    const f2b = f => Math.max(0, Math.min(Math.round(f / hz), analyser.frequencyBinCount - 1));
    binBassLo  = f2b(20);    binBassHi  = f2b(250);
    binMidsLo  = f2b(250);   binMidsHi  = f2b(4000);
    binHighsLo = f2b(4000);  binHighsHi = f2b(12000);
    frame.spectrum = freqBuf;
    frame.waveform = timeBuf;
  }

  function avgBins(buf, lo, hi) {
    let s = 0;
    for (let i = lo; i < hi; i++) s += buf[i];
    return s / Math.max(1, hi - lo);
  }

  /** Start mic capture. Returns the chosen deviceId so callers can persist it. */
  async function start(deviceId) {
    await stop();
    const constraints = { ...MIC_CONSTRAINTS };
    if (deviceId) constraints.deviceId = { exact: deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    // source ➝ analyser only. Connecting to destination would loop mic to speakers.
    ctx.createMediaStreamSource(stream).connect(analyser);
    configureBins();

    const track = stream.getAudioTracks()[0];
    const settings = track ? track.getSettings() : {};
    micId = settings.deviceId || deviceId || null;

    enabled = true;
    source = 'mic';
    notify();
    return micId;
  }

  async function stop() {
    enabled = false;
    source = 'off';
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (ctx)    { try { await ctx.close(); } catch {} ctx = null; }
    analyser = null;
    freqBuf = timeBuf = null;
    frame.spectrum = frame.waveform = null;
    resetState();
    notify();
  }

  /** Adopt an externally-owned analyser+ctx (used by Strudel tap). */
  function adoptAnalyser(externalCtx, externalAnalyser) {
    enabled = true;
    source = 'strudel';
    ctx = externalCtx;
    analyser = externalAnalyser;
    configureBins();
    notify();
  }

  function releaseAdopted() {
    enabled = false;
    source = 'off';
    ctx = null; analyser = null;
    freqBuf = timeBuf = null;
    frame.spectrum = frame.waveform = null;
    resetState();
    notify();
  }

  function resetState() {
    frame.bands.bass = frame.bands.mids = frame.bands.highs = frame.bands.total = 0;
    frame.beat.active = false; frame.beat.pulse = 0;
    frame.highs.active = false; frame.highs.pulse = 0;
    frame.rms = 0;
    bassAvg = highsAvg = 0;
  }

  /** Pull one frame of data from the analyser into `frame`. dt in seconds. */
  function tick(dt) {
    // Always decay pulses, even when audio is off — keeps them from getting
    // stuck on a non-zero value after stop().
    const decay = Math.pow(0.001, dt);
    frame.beat.pulse  *= decay;
    frame.highs.pulse *= decay;

    if (!enabled || !analyser) {
      frame.beat.active = false;
      frame.highs.active = false;
      return;
    }

    analyser.getByteFrequencyData(freqBuf);
    analyser.getByteTimeDomainData(timeBuf);

    const rawBass  = Math.min(avgBins(freqBuf, binBassLo,  binBassHi)  / 255 * gain, 1);
    const rawMids  = Math.min(avgBins(freqBuf, binMidsLo,  binMidsHi)  / 255 * gain, 1);
    const rawHighs = Math.min(avgBins(freqBuf, binHighsLo, binHighsHi) / 255 * gain, 1);
    frame.bands.bass  = ema(frame.bands.bass,  rawBass,  alpha);
    frame.bands.mids  = ema(frame.bands.mids,  rawMids,  alpha);
    frame.bands.highs = ema(frame.bands.highs, rawHighs, alpha);
    frame.bands.total = ema(frame.bands.total, (rawBass + rawMids + rawHighs) / 3, alpha);

    // Time-domain RMS for fx that want raw signal energy independent of bands.
    let rmsAcc = 0;
    for (let i = 0; i < timeBuf.length; i++) {
      const v = (timeBuf[i] - 128) / 128;
      rmsAcc += v * v;
    }
    frame.rms = Math.sqrt(rmsAcc / timeBuf.length);

    // Bass beat — same envelope-vs-running-mean heuristic as cymatics.
    bassAvg  = 0.97 * bassAvg  + 0.03 * rawBass;
    highsAvg = 0.95 * highsAvg + 0.05 * rawHighs;
    const now = performance.now();
    frame.beat.active = rawBass > bassAvg * beatThresh && now - lastBeatMs > beatCooldown;
    if (frame.beat.active) { lastBeatMs = now; frame.beat.pulse = 1; }

    // Highs transient — looser threshold + shorter cooldown for hat / cymbal hits.
    const hiThresh   = beatThresh   * 0.88;
    const hiCooldown = beatCooldown * 0.45;
    frame.highs.active = rawHighs > highsAvg * hiThresh
                      && rawHighs > 0.05
                      && now - lastHighsMs > hiCooldown;
    if (frame.highs.active) { lastHighsMs = now; frame.highs.pulse = 1; }
  }

  function setTunables(t) {
    if (t.gain         != null) gain         = t.gain;
    if (t.ema          != null) alpha        = t.ema;
    if (t.thresh       != null) beatThresh   = t.thresh;
    if (t.cooldown     != null) beatCooldown = t.cooldown;
  }
  function getTunables() {
    return { gain, ema: alpha, thresh: beatThresh, cooldown: beatCooldown };
  }

  return {
    frame,
    start,
    stop,
    adoptAnalyser,
    releaseAdopted,
    tick,
    setTunables,
    getTunables,
    onChange,
    isEnabled: () => enabled,
    getSource:       () => source,
    getCurrentMicId: () => micId,
    getAnalyser: () => analyser,
    getCtx:      () => ctx,
  };
}
