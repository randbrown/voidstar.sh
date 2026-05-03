// QualiaField factory — the single per-frame data object handed to every fx.
// Plugins must read state through this, never via globals; that's what makes
// the fx swappable and live-codeable.

/** @returns {import('./types.js').AudioFrame} */
export function emptyAudioFrame() {
  return {
    bands: { bass: 0, mids: 0, highs: 0, total: 0 },
    beat:  { active: false, pulse: 0 },
    mids:  { active: false, pulse: 0 },
    highs: { active: false, pulse: 0 },
    rms:   0,
    spectrum: null,
    waveform: null,
  };
}

/** @returns {import('./types.js').PoseFrame} */
export function emptyPoseFrame() {
  return { people: [], timestamp: 0 };
}

/** @returns {import('./types.js').QualiaField} */
export function makeField() {
  return {
    dt: 0,
    time: 0,
    audio: emptyAudioFrame(),
    pose:  emptyPoseFrame(),
    params: {},
  };
}

// Adaptive low-pass on a scalar in [0,1]. Same shape as cymatics' EMA but
// generic — used by audio.js for band smoothing and exposed for fx that
// want their own smoothed values.
export function ema(prev, target, alpha) {
  return prev + (target - prev) * alpha;
}

// Exponential decay over a real time delta. dt in seconds; halfLife in seconds.
// e.g. decay(pulse, dt, 0.18) — pulses lose half their amplitude every 180ms.
export function decay(value, dt, halfLife) {
  if (halfLife <= 0) return 0;
  return value * Math.pow(0.5, dt / halfLife);
}

// Per-fx reactivity scaler. Each fx exposes a `reactivity` slider (0..2,
// default 1.0) and calls this once at the top of update():
//   audio = scaleAudio(audio, params.reactivity);
// The rest of the fx code uses `audio.bands.bass`, `audio.beat.pulse`, etc.
// unchanged — magnitudes are pre-multiplied by `react`, transient `active`
// flags are gated to false at react=0 (so an `if (beat.active)` block does
// nothing when reactivity is fully dialed out). Spectrum/waveform buffers
// pass through untouched. react === 1 short-circuits to the original frame
// to avoid per-frame allocation in the common case.
export function scaleAudio(audio, react) {
  if (react === 1 || react == null) return audio;
  const a = audio;
  const r = react;
  const gate = r > 0;
  return {
    bands: {
      bass:  a.bands.bass  * r,
      mids:  a.bands.mids  * r,
      highs: a.bands.highs * r,
      total: a.bands.total * r,
    },
    beat:  { active: gate && a.beat.active,  pulse: a.beat.pulse  * r },
    mids:  { active: gate && a.mids.active,  pulse: a.mids.pulse  * r },
    highs: { active: gate && a.highs.active, pulse: a.highs.pulse * r },
    rms:   a.rms * r,
    spectrum: a.spectrum,
    waveform: a.waveform,
  };
}
