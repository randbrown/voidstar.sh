// Audio pipeline: WebAudio analyser → bass/mids/highs bands + bass-beat +
// highs-transient, both delivered through the QualiaField every frame.
//
// Lifted near-verbatim from cymatics:688–752,760–771,1733–1784. Three
// important differences:
//   1. State is per-instance, not global, so multiple harnesses can coexist
//      (and so the page can be torn down without leaking analysers).
//   2. The output is an AudioFrame object — not a pile of free vars. Fx code
//      reads `field.audio.bands.bass`, etc.
//   3. Multiple input sources can run in parallel — the mic input and the
//      Strudel master tap each own their own analyser (on their own
//      AudioContext) and we merge their per-band readings every tick. That
//      way audio reactivity follows pedal steel + a Strudel pattern at the
//      same time, instead of whichever subsystem flipped state last.
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

  // Source registry: id -> { ctx, analyser, freqBuf, timeBuf, bins,
  // ownsCtx, stream }. ownsCtx=true means we created the ctx (mic) and must
  // close it on remove; false means we adopted an external one (Strudel) and
  // must leave it intact for its owner.
  const sources = new Map();
  let micId = null;

  // When more than one source is active we need merged spectrum/waveform
  // buffers to expose a single Uint8Array to fx that read them directly
  // (chladni's lissajous, neural-field's audioOn check). With a single
  // source we just point frame.spectrum/waveform at that source's buffers.
  let combinedFreqBuf = null;
  let combinedTimeBuf = null;

  // State-change listeners — fired whenever the source set changes (mic
  // start/stop, Strudel adopt/release). Page UI subscribes so the topbar
  // button stays consistent regardless of which subsystem flipped state.
  const listeners = new Set();
  function notify() {
    const snap = {
      enabled: sources.size > 0,
      source: describeSources(),
      sources: Array.from(sources.keys()),
      micId,
    };
    listeners.forEach(fn => { try { fn(snap); } catch {} });
  }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // Joined description for back-compat callers that compared getSource()
  // against literal strings — 'off' | 'mic' | 'strudel' | 'mic+strudel'.
  function describeSources() {
    if (sources.size === 0) return 'off';
    return Array.from(sources.keys()).sort().join('+');
  }

  // Tunables (preset-driven by presets.js)
  let gain         = 1.0;
  let alpha        = 0.30;   // EMA factor on band values — higher = snappier
  let beatThresh   = 1.30;
  let beatCooldown = 280;

  // Beat / transient state. The running means (bassAvg/highsAvg) are used as
  // a noise-floor reference for transient detection; BAND_CEILING caps them
  // so a sustained-loud passage can't push the comparator into a region
  // where multiplicative beats are mathematically impossible.
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

  function configureSource(src) {
    src.freqBuf = new Uint8Array(src.analyser.frequencyBinCount);
    src.timeBuf = new Uint8Array(src.analyser.fftSize);
    const hz = src.ctx.sampleRate / src.analyser.fftSize;
    const f2b = f => Math.max(0, Math.min(Math.round(f / hz), src.analyser.frequencyBinCount - 1));
    // Per-source bin ranges — sample rate / fftSize can differ between mic
    // ctx and Strudel ctx, so each source maps its own Hz windows to bins.
    src.bins = {
      bassLo:  f2b(20),    bassHi:  f2b(250),
      midsLo:  f2b(250),   midsHi:  f2b(4000),
      highsLo: f2b(4000),  highsHi: f2b(12000),
      // Snare body 500–2500 Hz (lower bound at 500 keeps kick-drum
      // harmonics from false-triggering the snare/clap detector).
      snareLo: f2b(500),   snareHi: f2b(2500),
    };
  }

  function refreshFrameBuffers() {
    if (sources.size === 0) {
      frame.spectrum = frame.waveform = null;
      combinedFreqBuf = combinedTimeBuf = null;
      return;
    }
    if (sources.size === 1) {
      const only = sources.values().next().value;
      frame.spectrum = only.freqBuf;
      frame.waveform = only.timeBuf;
      combinedFreqBuf = combinedTimeBuf = null;
      return;
    }
    // Multi-source: allocate combined buffers sized to the longest of each
    // kind. Per-tick we merge into these (max for spectrum, summed-around-
    // 128 for waveform). Sources with shorter buffers get nearest-neighbor
    // sampled into the merged length.
    let maxFreq = 0, maxTime = 0;
    for (const s of sources.values()) {
      if (s.freqBuf.length > maxFreq) maxFreq = s.freqBuf.length;
      if (s.timeBuf.length > maxTime) maxTime = s.timeBuf.length;
    }
    combinedFreqBuf = new Uint8Array(maxFreq);
    combinedTimeBuf = new Uint8Array(maxTime);
    frame.spectrum = combinedFreqBuf;
    frame.waveform = combinedTimeBuf;
  }

  function avgBins(buf, lo, hi) {
    let s = 0;
    for (let i = lo; i < hi; i++) s += buf[i];
    return s / Math.max(1, hi - lo);
  }

  async function removeSource(id) {
    const src = sources.get(id);
    if (!src) return;
    if (src.stream) { try { src.stream.getTracks().forEach(t => t.stop()); } catch {} }
    if (src.ownsCtx && src.ctx) { try { await src.ctx.close(); } catch {} }
    sources.delete(id);
    refreshFrameBuffers();
    // Only reset running averages once *all* inputs are gone — when one
    // source drops out we'd rather let the EMAs re-adapt to the surviving
    // signal than zero everything and re-floor.
    if (sources.size === 0) resetState();
  }

  /** Start mic capture. Returns the chosen deviceId so callers can persist it. */
  async function start(deviceId) {
    await removeSource('mic');
    const constraints = { ...MIC_CONSTRAINTS };
    if (deviceId) constraints.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    // Smaller FFT → less internal latency; lower smoothingTimeConstant
    // makes the analyser itself respond more quickly so beat transients
    // aren't washed out by its built-in temporal smoothing.
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.40;
    // source ➝ analyser only. Connecting to destination would loop mic to speakers.
    ctx.createMediaStreamSource(stream).connect(analyser);
    const src = { ctx, analyser, ownsCtx: true, stream };
    configureSource(src);
    sources.set('mic', src);

    const track = stream.getAudioTracks()[0];
    const settings = track ? track.getSettings() : {};
    micId = settings.deviceId || deviceId || null;

    refreshFrameBuffers();
    notify();
    return micId;
  }

  async function stop() {
    await removeSource('mic');
    micId = null;
    notify();
  }

  /** Adopt an externally-owned analyser+ctx (used by Strudel tap). */
  function adoptAnalyser(externalCtx, externalAnalyser) {
    // Replace any prior strudel source without touching mic.
    if (sources.has('strudel')) sources.delete('strudel');
    const src = { ctx: externalCtx, analyser: externalAnalyser, ownsCtx: false };
    configureSource(src);
    sources.set('strudel', src);
    refreshFrameBuffers();
    notify();
  }

  function releaseAdopted() {
    if (!sources.has('strudel')) return;
    sources.delete('strudel');
    refreshFrameBuffers();
    if (sources.size === 0) resetState();
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

  function mergeFreqInto(out, src) {
    const sf = src.freqBuf;
    if (sf.length === out.length) {
      for (let i = 0; i < out.length; i++) if (sf[i] > out[i]) out[i] = sf[i];
    } else {
      const ratio = sf.length / out.length;
      for (let i = 0; i < out.length; i++) {
        const v = sf[Math.min(sf.length - 1, Math.floor(i * ratio))];
        if (v > out[i]) out[i] = v;
      }
    }
  }

  // Waveform is signed-around-128. We sum source contributions (each minus
  // 128), then add 128 back and clamp — this produces something close to
  // what a hardware mixer would feed to one analyser, so lissajous-style
  // visuals see both signals interfering instead of just the loudest.
  function mergeWaveformInto(out, src, isFirst) {
    const st = src.timeBuf;
    if (st.length === out.length) {
      if (isFirst) {
        out.set(st);
      } else {
        for (let i = 0; i < out.length; i++) {
          const sum = (out[i] - 128) + (st[i] - 128) + 128;
          out[i] = sum < 0 ? 0 : sum > 255 ? 255 : sum;
        }
      }
    } else {
      const ratio = st.length / out.length;
      for (let i = 0; i < out.length; i++) {
        const v = st[Math.min(st.length - 1, Math.floor(i * ratio))];
        if (isFirst) {
          out[i] = v;
        } else {
          const sum = (out[i] - 128) + (v - 128) + 128;
          out[i] = sum < 0 ? 0 : sum > 255 ? 255 : sum;
        }
      }
    }
  }

  /** Pull one frame of data from the analyser into `frame`. dt in seconds. */
  function tick(dt) {
    // Always decay pulses, even when audio is off — keeps them from getting
    // stuck on a non-zero value after stop().
    const decay = Math.pow(0.001, dt);
    frame.beat.pulse  *= decay;
    frame.mids.pulse  *= decay;
    frame.highs.pulse *= decay;

    if (sources.size === 0) {
      frame.beat.active  = false;
      frame.mids.active  = false;
      frame.highs.active = false;
      return;
    }

    // Per-source: read the analyser, compute raw band values [0..1], and
    // take the max across sources. Max keeps band values in [0,1] (sum
    // would push past it whenever both sources are even moderately loud)
    // while still letting either source individually drive reactivity.
    let rawBassPre0 = 0, rawMidsPre0 = 0, rawHighsPre0 = 0, rawSnarePre0 = 0;
    let rmsAcc = 0, rmsCount = 0;
    let firstWave = true;
    if (combinedFreqBuf) combinedFreqBuf.fill(0);

    for (const src of sources.values()) {
      src.analyser.getByteFrequencyData(src.freqBuf);
      src.analyser.getByteTimeDomainData(src.timeBuf);
      const b = src.bins;
      const bass  = avgBins(src.freqBuf, b.bassLo,  b.bassHi)  / 255;
      const mids  = avgBins(src.freqBuf, b.midsLo,  b.midsHi)  / 255;
      const highs = avgBins(src.freqBuf, b.highsLo, b.highsHi) / 255;
      const snare = avgBins(src.freqBuf, b.snareLo, b.snareHi) / 255;
      if (bass  > rawBassPre0)  rawBassPre0  = bass;
      if (mids  > rawMidsPre0)  rawMidsPre0  = mids;
      if (highs > rawHighsPre0) rawHighsPre0 = highs;
      if (snare > rawSnarePre0) rawSnarePre0 = snare;
      for (let i = 0; i < src.timeBuf.length; i++) {
        const v = (src.timeBuf[i] - 128) / 128;
        rmsAcc += v * v;
      }
      rmsCount += src.timeBuf.length;
      if (combinedFreqBuf) {
        mergeFreqInto(combinedFreqBuf, src);
        mergeWaveformInto(combinedTimeBuf, src, firstWave);
        firstWave = false;
      }
    }

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
    frame.rms = Math.sqrt(rmsAcc / Math.max(1, rmsCount));

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

  function firstSource() {
    return sources.values().next().value || null;
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
    isEnabled: () => sources.size > 0,
    hasSource: (id) => sources.has(id),
    getSources: () => Array.from(sources.keys()),
    getSource:       () => describeSources(),
    getCurrentMicId: () => micId,
    getAnalyser: () => firstSource()?.analyser ?? null,
    getCtx:      () => firstSource()?.ctx ?? null,
  };
}
