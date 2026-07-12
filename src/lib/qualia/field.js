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
    // Monophonic pitch of the guitar/steel input (rig tuner), for the
    // audio.pitch / audio.pitchClass modulation channels. `pitch` is a
    // normalized log-frequency across the useful range (0..1); `pitchClass`
    // wraps the octave (0..1, i.e. hue-by-note); `pitchConf` is 0 when
    // unvoiced/silent (the last note is held so hue doesn't strobe). Written
    // by the pitch-channel glue in page-init only when the rig is capturing.
    pitch: 0,
    pitchClass: 0,
    pitchConf: 0,
    spectrum: null,
    waveform: null,
  };
}

/** @returns {import('./types.js').PoseFrame} */
export function emptyPoseFrame() {
  return { people: [], timestamp: 0 };
}

// Aggregated audience input (Entanglement). The host reduces every connected
// participant into this one snapshot each react-tick; the crowd.* modulation
// channels read it. All zero = nobody entangled (identity for any modulator).
export function emptyCrowdSnapshot() {
  return { x: 0, y: 0, energy: 0, spread: 0, rise: 0, sway: 0, count: 0, confidence: 0 };
}

/** @returns {import('./types.js').QualiaField} */
export function makeField() {
  return {
    dt: 0,
    reactDt: 0,
    renderDt: 0,
    fps: 0,
    time: 0,
    audio: emptyAudioFrame(),
    pose:  emptyPoseFrame(),
    crowd: emptyCrowdSnapshot(),
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
// pass through untouched. react === 1 short-circuits to the original frame; the
// react !== 1 path writes into a reused module-level scratch (not a fresh
// object) so neither path allocates per frame. Safe because exactly one fx is
// active per frame and it reads the result synchronously within its update().
const _scaled = {
  bands: { bass: 0, mids: 0, highs: 0, total: 0 },
  beat:  { active: false, pulse: 0 },
  mids:  { active: false, pulse: 0 },
  highs: { active: false, pulse: 0 },
  rms: 0, spectrum: null, waveform: null,
};
export function scaleAudio(audio, react) {
  if (react === 1 || react == null) return audio;
  const a = audio;
  const r = react;
  const gate = r > 0;
  const s = _scaled;
  s.bands.bass  = a.bands.bass  * r;
  s.bands.mids  = a.bands.mids  * r;
  s.bands.highs = a.bands.highs * r;
  s.bands.total = a.bands.total * r;
  s.beat.active  = gate && a.beat.active;   s.beat.pulse  = a.beat.pulse  * r;
  s.mids.active  = gate && a.mids.active;    s.mids.pulse  = a.mids.pulse  * r;
  s.highs.active = gate && a.highs.active;   s.highs.pulse = a.highs.pulse * r;
  s.rms = a.rms * r;
  s.spectrum = a.spectrum;
  s.waveform = a.waveform;
  return s;
}
