// Tone.js drum-machine voice factory.
//
// Each voice is a small synth chain configured to read like a classic
// drum-machine pad (RY-10 / 808/909 family). All voices fan into a shared
// `output` Gain so the sequencer can tap one node into its analyser and
// connect that single bus to Tone.getDestination() for monitoring.
//
// `pads` returns stable trigger thunks `(time, vel) => void`. `time` is the
// AudioContext time provided by Tone.Transport.scheduleRepeat — using the
// scheduled time (instead of `Tone.now()`) keeps the hits sample-accurate
// even if the JS thread is busy.

import * as Tone from 'tone';

export function createKit() {
  const out    = new Tone.Gain(0.9);
  // Light room reverb so hits don't feel sterile; wet stays low so the
  // analyser still sees clean transients.
  const reverb = new Tone.Reverb({ decay: 1.4, wet: 0.12 }).connect(out);

  // ── Kick ────────────────────────────────────────────────────────────
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves:    6,
    oscillator: { type: 'sine' },
    envelope:   { attack: 0.001, decay: 0.4, sustain: 0.01, release: 1.2 },
  }).connect(out);

  // ── Snare (noise + bandpass) ────────────────────────────────────────
  const snareNoise = new Tone.NoiseSynth({
    noise:    { type: 'white' },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0 },
  });
  const snareBp = new Tone.Filter(1800, 'bandpass');
  snareBp.Q.value = 1.2;
  snareNoise.connect(snareBp);
  snareBp.connect(reverb);

  // ── Hi-hats (closed + open) — MetalSynth FM-ish texture ─────────────
  // Phone-speaker tuning: the original 4 kHz resonance + -18/-20 dB sat
  // mostly above the speaker's usable band, so on a Samsung S25u the
  // hats were inaudible. Drop resonance to 2.8 kHz (still bright but
  // squarely in the speaker's sweet spot) and raise the trims by ~10 dB
  // so the closed/open contrast stays intact at louder absolute levels.
  // A high-pass on the kit output keeps the boosted trims from muddying
  // the kick band.
  const hatClosed = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 0.06, release: 0.02 },
    harmonicity:     5.1,
    modulationIndex: 32,
    resonance:       2800,
    octaves:         1.5,
  });
  hatClosed.volume.value = -8;
  hatClosed.connect(out);

  const hatOpen = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 0.45, release: 0.2 },
    harmonicity:     5.1,
    modulationIndex: 32,
    resonance:       2800,
    octaves:         1.5,
  });
  hatOpen.volume.value = -10;
  hatOpen.connect(out);

  // ── Toms (low/mid/high — same synth, different note) ────────────────
  const tomLow  = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 4 }).connect(out);
  const tomMid  = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 4 }).connect(out);
  const tomHigh = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 4 }).connect(out);

  // ── Clap (noise burst, slightly longer + bandpassed) ────────────────
  const clapNoise = new Tone.NoiseSynth({
    envelope: { attack: 0.001, decay: 0.12, sustain: 0 },
  });
  const clapBp = new Tone.Filter(1200, 'bandpass');
  clapBp.Q.value = 0.8;
  clapNoise.connect(clapBp);
  clapBp.connect(reverb);

  // ── Rim (short metallic click) ──────────────────────────────────────
  // Original config (resonance 2200, 0.5 octaves, -22 dB, 30 ms decay)
  // produced a click whose energy was barely above the noise floor on a
  // phone speaker. Widen the partial spread (octaves 1.0), drop the
  // centre to 1.6 kHz where speakers respond strongly, and trim 10 dB
  // hotter so the tick is actually audible without drowning the kick.
  const rim = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 0.06, release: 0.04 },
    harmonicity:     3.1,
    modulationIndex: 12,
    resonance:       1600,
    octaves:         1.0,
  });
  rim.volume.value = -12;
  rim.connect(out);

  // Trigger thunks — voice id → (time, vel) => void. Velocity defaults to
  // 1; the sequencer multiplies its per-pad gain into this before calling.
  //
  // Tone.js v15 signatures, by base class:
  //   - MembraneSynth / MetalSynth → Monophonic → Instrument:
  //       triggerAttackRelease(note, duration, time, velocity)   [4 args]
  //   - NoiseSynth (no pitch input):
  //       triggerAttackRelease(duration, time, velocity)         [3 args]
  // The hats and rim are MetalSynths and DO need a base note — without it
  // the duration string ('32n', '8n', '16n') gets bound to `note` and
  // fails the Frequency parse, so the attack is never scheduled (silence
  // + no analyser energy → no FX reactivity). 'C5' / 'A4' pair cleanly
  // with the existing harmonicity / modulationIndex / resonance config.
  const triggers = {
    'kick':  (t, v = 1) => kick.triggerAttackRelease('C1', '8n', t, v),
    'snare': (t, v = 1) => snareNoise.triggerAttackRelease('16n', t, v),
    'hat-c': (t, v = 1) => hatClosed.triggerAttackRelease('C5', '32n', t, v),
    'hat-o': (t, v = 1) => hatOpen.triggerAttackRelease('C5',  '8n', t, v),
    'tom-l': (t, v = 1) => tomLow.triggerAttackRelease('A1',  '8n', t, v),
    'tom-m': (t, v = 1) => tomMid.triggerAttackRelease('D2',  '8n', t, v),
    'tom-h': (t, v = 1) => tomHigh.triggerAttackRelease('G2', '8n', t, v),
    'clap':  (t, v = 1) => clapNoise.triggerAttackRelease('16n', t, v),
    'rim':   (t, v = 1) => rim.triggerAttackRelease('A4', '16n', t, v),
  };

  const nodes = [
    kick, snareNoise, snareBp, hatClosed, hatOpen,
    tomLow, tomMid, tomHigh, clapNoise, clapBp, rim,
    reverb, out,
  ];

  return {
    output: out,
    /** Trigger a voice by id at the given Tone-scheduled time. Unknown
     *  voice ids are a no-op (a saved pattern referencing a removed
     *  voice should stay silent rather than crash). */
    trigger(voiceId, time, velocity) {
      const fn = triggers[voiceId];
      if (fn) fn(time, velocity);
    },
    /** True if the kit knows how to play this voice — used by the UI to
     *  grey-out unmapped pads if/when the catalog ever drifts. */
    has(voiceId) { return Object.prototype.hasOwnProperty.call(triggers, voiceId); },
    dispose() {
      for (const n of nodes) {
        try { n.dispose?.(); } catch {}
      }
    },
  };
}
