// Vox panel presets — artistic starting points for the vocoder + harmonizer.
//
// Each preset's `config` is a partial passed straight to vocoder.setConfig():
// vocoder fields at the top level, the harmonizer's under `harmonizer`.
// Presets touch ONLY parameters that also have a live control on the panel —
// loading one is a starting point, never a lock; every value it sets stays
// editable. They deliberately leave routing/levels (output gain, gate, mic,
// feed) alone so a venue's setup survives a preset change.

export const VOX_PRESETS = {
  classic: {
    label: 'Classic robot',
    config: {
      carrierType: 'drone', pitch: 110, bands: 24, voices: 3,
      consonant: 0.45, sibilance: 0.40, dry: 0.0,
      presence: 3, compress: 0.40, deess: 0.25,
      vocoderEnabled: true,
      harmonizer: { enabled: false },
    },
  },
  // Bright saw chord, lots of bands, strong consonant noise + a touch of dry
  // highs, heavy compression and presence — the crisp talkbox/vocoder voice.
  daftpunk: {
    label: 'Daft Punk vocoder',
    config: {
      carrierType: 'sawtooth', pitch: 120, bands: 32, voices: 5,
      consonant: 0.70, sibilance: 0.50, dry: 0.10,
      presence: 5, compress: 0.70, deess: 0.45,
      vocoderEnabled: true,
      harmonizer: { enabled: true, engine: 'synth', mode: 'picker', root: 48, quality: 'min7' },
    },
  },
  // Dark retro drone (saw + sub) low in pitch, a minor chord, medium noise,
  // very little dry — the Kavinsky "Nightcall" robot.
  nightcall: {
    label: 'Nightcall robot',
    config: {
      carrierType: 'drone', pitch: 90, bands: 28, voices: 3,
      consonant: 0.55, sibilance: 0.35, dry: 0.04,
      presence: 3, compress: 0.60, deess: 0.35,
      vocoderEnabled: true,
      harmonizer: { enabled: true, engine: 'synth', mode: 'picker', root: 45, quality: 'min' },
    },
  },
  // No vocoder — the harmonizer's voice engine, scale-locked and autotuned
  // with formants preserved: the "Hide and Seek" pitch-corrected choir.
  imogen: {
    label: 'Imogen Heap choir',
    config: {
      vocoderEnabled: false,
      presence: 4, compress: 0.45, deess: 0.40,
      harmonizer: {
        enabled: true, engine: 'voice', mode: 'track',
        key: 0, scale: 'major', voicing: 'triad', tune: true, formant: 0,
      },
    },
  },
  // Plain voice — NO vocoder, NO harmonizer: just the raw mic routed straight
  // to the master clarity EQ + compressor + limiter. The quick "people can't
  // understand me, drop to plain speech" mode. Loading it switches the vocoder
  // off and opens the raw-voice passthrough; switch the vocoder back on (or
  // load another preset) to return to the robot.
  clean: {
    label: 'Clean · raw voice',
    config: {
      vocoderEnabled: false,
      rawVoice: 0.9, dry: 0.0, sibilance: 0.0,
      presence: 2, compress: 0.35, deess: 0.30,
      harmonizer: { enabled: false },
    },
  },
  // Maximum word clarity — bright carrier, 40 bands, heavy consonant noise,
  // audible dry highs, a strong presence lift. Still the robot vocoder, just
  // tuned for intelligibility (distinct from the no-vocoder "clean" above).
  clarity: {
    label: 'Max clarity (vocoder)',
    config: {
      carrierType: 'sawtooth', pitch: 130, bands: 40, voices: 5,
      consonant: 0.80, sibilance: 0.55, dry: 0.14,
      presence: 6, compress: 0.55, deess: 0.50,
      vocoderEnabled: true,
      harmonizer: { enabled: false },
    },
  },
};
