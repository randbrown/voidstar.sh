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
  let alpha        = 0.30;   // EMA factor on band values — higher = snappier
  let beatThresh   = 1.30;
  let beatCooldown = 280;

  let binBassLo = 0,  binBassHi = 8;
  let binMidsLo = 8,  binMidsHi = 80;
  let binHighsLo= 80, binHighsHi= 200;
  // Tighter band for snare transient detection (snare body lives mostly
  // 200–1800 Hz). The full mids band (250–4000) is too wide — vocals and
  // sustained leads keep the running mean too high for snares to break
  // through the multiplicative threshold.
  let binSnareLo= 4,  binSnareHi= 40;

  // Beat / transient state. The running means (bassAvg/midsAvg/highsAvg) are
  // used as a noise-floor reference for transient detection; BAND_CEILING
  // caps them so a sustained-loud passage can't push the comparator into a
  // region where multiplicative beats are mathematically impossible.
  const BAND_CEILING = 0.65;
  const BEAT_DELTA_BASS  = 0.06;
  const BEAT_DELTA_HIGHS = 0.04;
  // Snare detection uses spectral-flux (fast-EMA minus slow-EMA): a true
  // onset detector that fires whenever the current level rises sharply
  // above the recent baseline, in both loud AND quiet sections.
  const SNARE_FLUX_THRESH = 0.018;
  let bassAvg = 0, highsAvg = 0;
  let snareFastEma = 0, snareSlowEma = 0;
  let lastBeatMs = 0, lastMidsMs = 0, lastHighsMs = 0;

  function configureBins() {
    if (!ctx || !analyser) return;
    freqBuf = new Uint8Array(analyser.frequencyBinCount);
    timeBuf = new Uint8Array(analyser.fftSize);
    const hz = ctx.sampleRate / analyser.fftSize;
    const f2b = f => Math.max(0, Math.min(Math.round(f / hz), analyser.frequencyBinCount - 1));
    binBassLo  = f2b(20);    binBassHi  = f2b(250);
    binMidsLo  = f2b(250);   binMidsHi  = f2b(4000);
    binHighsLo = f2b(4000);  binHighsHi = f2b(12000);
    // Snare band lower bound at 500 Hz to keep kick-drum harmonics from
    // false-triggering the snare/clap detector. Snare body lives ~500–900 Hz
    // and crack sits 1.5–2.5 kHz; both fall inside this window.
    binSnareLo = f2b(500);   binSnareHi = f2b(2500);
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
    // Smaller FFT → less internal latency; lower smoothingTimeConstant
    // makes the analyser itself respond more quickly so beat transients
    // aren't washed out by its built-in temporal smoothing.
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.40;
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
    frame.beat.active  = false; frame.beat.pulse  = 0;
    frame.mids.active  = false; frame.mids.pulse  = 0;
    frame.highs.active = false; frame.highs.pulse = 0;
    frame.rms = 0;
    bassAvg = highsAvg = 0;
    snareFastEma = snareSlowEma = 0;
  }

  /** Pull one frame of data from the analyser into `frame`. dt in seconds. */
  function tick(dt) {
    // Always decay pulses, even when audio is off — keeps them from getting
    // stuck on a non-zero value after stop().
    const decay = Math.pow(0.001, dt);
    frame.beat.pulse  *= decay;
    frame.mids.pulse  *= decay;
    frame.highs.pulse *= decay;

    if (!enabled || !analyser) {
      frame.beat.active  = false;
      frame.mids.active  = false;
      frame.highs.active = false;
      return;
    }

    analyser.getByteFrequencyData(freqBuf);
    analyser.getByteTimeDomainData(timeBuf);

    // Raw spectrum readouts (0..1, pre-gain) — averaged over each band's bins.
    const rawBassPre0  = avgBins(freqBuf, binBassLo,  binBassHi)  / 255;
    const rawMidsPre0  = avgBins(freqBuf, binMidsLo,  binMidsHi)  / 255;
    const rawHighsPre0 = avgBins(freqBuf, binHighsLo, binHighsHi) / 255;
    const rawSnarePre0 = avgBins(freqBuf, binSnareLo, binSnareHi) / 255;

    // Apply user gain to all transient/visual paths. The transient detector
    // works on UNCLAMPED gained values (so headroom > 1 is fine, the
    // comparator runs against an EMA of the same gained signal). Visual
    // band levels are clamped to [0,1] because shaders expect that range.
    const rawBassPre  = rawBassPre0  * gain;
    const rawMidsPre  = rawMidsPre0  * gain;
    const rawHighsPre = rawHighsPre0 * gain;
    const rawSnarePre = rawSnarePre0 * gain;
    const rawBass  = Math.min(rawBassPre,  1);
    const rawMids  = Math.min(rawMidsPre,  1);
    const rawHighs = Math.min(rawHighsPre, 1);
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

    // Beat detection. Running means use the PRE-gain raw values + a fast
    // adaptation rate (0.10 instead of 0.03) so the floor tracks recent
    // loudness within ~1 sec. The mean is then clamped to BAND_CEILING so
    // a sustained-loud passage can't push the comparator past where beats
    // can ever exceed it. Gating uses BOTH a multiplicative ratio AND an
    // additive delta — the additive term is what guarantees beats keep
    // firing on bass-heavy material where the mean approaches the signal.
    bassAvg  = 0.90 * bassAvg  + 0.10 * rawBassPre;
    highsAvg = 0.88 * highsAvg + 0.12 * rawHighsPre;
    // Snare flux: fast EMA tracks the current level (≈3 frames lag);
    // slow EMA tracks the long-term baseline (≈20 frames). Onsets push
    // fast above slow before slow catches up — that gap is the transient.
    snareFastEma = 0.55 * snareFastEma + 0.45 * rawSnarePre;
    snareSlowEma = 0.94 * snareSlowEma + 0.06 * rawSnarePre;
    const bassFloor  = Math.min(bassAvg,  BAND_CEILING);
    const highsFloor = Math.min(highsAvg, BAND_CEILING);
    const now = performance.now();

    frame.beat.active = rawBassPre > bassFloor * beatThresh
                     && rawBassPre > bassFloor + BEAT_DELTA_BASS
                     && rawBassPre > 0.04
                     && now - lastBeatMs > beatCooldown;
    if (frame.beat.active) { lastBeatMs = now; frame.beat.pulse = 1; }

    // Snare/clap transient via spectral flux. Fires whenever the snare
    // band's fast level pops above the slow baseline by SNARE_FLUX_THRESH.
    // Works in both loud and quiet sections because both EMAs adapt with
    // the surrounding loudness — only the *shape* of the rise matters.
    const midCooldown = beatCooldown * 0.65;
    const snareFlux   = snareFastEma - snareSlowEma;
    frame.mids.active = snareFlux > SNARE_FLUX_THRESH
                     && rawSnarePre > 0.03
                     && now - lastMidsMs > midCooldown;
    if (frame.mids.active) { lastMidsMs = now; frame.mids.pulse = 1; }

    // Highs transient — looser threshold + shorter cooldown for hat / cymbal hits.
    const hiThresh   = beatThresh   * 0.88;
    const hiCooldown = beatCooldown * 0.45;
    frame.highs.active = rawHighsPre > highsFloor * hiThresh
                      && rawHighsPre > highsFloor + BEAT_DELTA_HIGHS
                      && rawHighsPre > 0.04
                      && now - lastHighsMs > hiCooldown;
    if (frame.highs.active) { lastHighsMs = now; frame.highs.pulse = 1; }
  }

  function setTunables(t) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    if (t.gain         != null) gain         = clamp(t.gain, 0.25, 4.0);
    if (t.ema          != null) alpha        = clamp(t.ema, 0.05, 0.60);
    if (t.thresh       != null) beatThresh   = clamp(t.thresh, 1.10, 2.50);
    if (t.cooldown     != null) beatCooldown = clamp(t.cooldown, 80, 600);
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
