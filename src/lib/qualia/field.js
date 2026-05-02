// QualiaField factory — the single per-frame data object handed to every fx.
// Plugins must read state through this, never via globals; that's what makes
// the fx swappable and live-codeable.

/** @returns {import('./types.js').AudioFrame} */
export function emptyAudioFrame() {
  return {
    bands: { bass: 0, mids: 0, highs: 0, total: 0 },
    beat:  { active: false, pulse: 0 },
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
