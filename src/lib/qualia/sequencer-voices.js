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
//
// This module exports three kit builders, all sharing one interface
// (`{ output, trigger, has, dispose }`) so the sequencer can swap between
// them without caring how a voice makes sound:
//   - createKit()      — the canonical 808/909-flavoured synth kit (default)
//   - createLofiKit()  — a warm, filtered, tape-flavoured synth kit
//   - createSampleKit()— plays decoded samples from a shared strudel.json
//                        manifest (the same packs Strudel loads)
// The kit catalog that names and instantiates these lives in
// sequencer-kits.js.

import * as Tone from 'tone';
import { resolveManifest } from './samples-manifest.js';

export function createKit() {
  const out    = new Tone.Gain(0.9);
  // Fixed headroom stage between the voices and the user-volume `out` bus.
  // Every voice is synthesised near full scale (the MembraneSynth kick and
  // toms peak at ~0 dBFS on their own), so as soon as two pads land on the
  // same cell — e.g. the default groove fires kick + closed-hat together on
  // the downbeat — their sum runs past 0 dBFS and hard-clips at the device
  // DAC. Clipped low frequencies are exactly what reads as a "distorted"
  // kick/tom, on any output (it's digital, not a phone-speaker artefact).
  // Pulling the whole kit down ~4.5 dB here keeps realistic pad stacks under
  // the ceiling — and below the bus limiter's threshold, so the common
  // groove never even engages it — while preserving the per-voice balance
  // tuned below. `out` stays the 0..1 user-volume control on top of this.
  const bus    = new Tone.Gain(0.6);
  bus.connect(out);
  // Light room reverb so hits don't feel sterile; wet stays low so the
  // analyser still sees clean transients.
  const reverb = new Tone.Reverb({ decay: 1.4, wet: 0.12 }).connect(bus);

  // ── Kick ────────────────────────────────────────────────────────────
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves:    6,
    oscillator: { type: 'sine' },
    envelope:   { attack: 0.001, decay: 0.4, sustain: 0.01, release: 1.2 },
  }).connect(bus);

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
  hatClosed.connect(bus);

  const hatOpen = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 0.45, release: 0.2 },
    harmonicity:     5.1,
    modulationIndex: 32,
    resonance:       2800,
    octaves:         1.5,
  });
  hatOpen.volume.value = -10;
  hatOpen.connect(bus);

  // ── Toms (low/mid/high — same synth, different note) ────────────────
  const tomLow  = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 4 }).connect(bus);
  const tomMid  = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 4 }).connect(bus);
  const tomHigh = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 4 }).connect(bus);

  // ── Crash (long bright shimmer, MetalSynth + reverb) ────────────────
  // Long decay (~1.4s) + heavy modulation index gives the "explosive
  // wash" feel of a crash cymbal. Routed through the room reverb so the
  // tail blooms naturally; without it the synthesis sounds noticeably
  // dry vs. a real cymbal recording. Volume sits below the kick/snare
  // because crashes are accent hits — they shouldn't overwhelm the
  // groove when the user lays one down.
  const crash = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 1.4, release: 1.2 },
    harmonicity:     6.4,
    modulationIndex: 40,
    resonance:       4200,
    octaves:         1.8,
  });
  crash.volume.value = -16;
  crash.connect(reverb);

  // ── Ride (medium ping with sustain, MetalSynth) ─────────────────────
  // Shorter than the crash (~0.6s) but longer than the closed hat,
  // with a tighter resonance so the tone reads as a defined "ping"
  // rather than a wash. Drier path (no reverb) keeps the attack
  // articulate for jazz-style ride patterns.
  const ride = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 0.55, release: 0.35 },
    harmonicity:     5.4,
    modulationIndex: 22,
    resonance:       3600,
    octaves:         1.4,
  });
  ride.volume.value = -13;
  ride.connect(bus);

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
  rim.connect(bus);

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
    'crash': (t, v = 1) => crash.triggerAttackRelease('C5', '4n', t, v),
    'ride':  (t, v = 1) => ride.triggerAttackRelease('C5', '8n', t, v),
    'rim':   (t, v = 1) => rim.triggerAttackRelease('A4', '16n', t, v),
  };

  const nodes = [
    kick, snareNoise, snareBp, hatClosed, hatOpen,
    tomLow, tomMid, tomHigh, crash, ride, rim,
    reverb, bus, out,
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

// ── Lofi synth kit ─────────────────────────────────────────────────────────
// A warm, dusty cousin of the default kit: same ten voice ids, but tuned for a
// boom-bap / chillhop feel rather than a clean 909. The character is three
// things working together — softer, lower-tuned voices; a bus tone-shaping
// chain (low-pass "blanket" → gentle bit-crush grit → longer room) so the kit
// sounds like it's coming off tape; and lower transients so it sits *under* a
// pad/Strudel patch instead of cutting through it.
export function createLofiKit() {
  const out = new Tone.Gain(0.9);

  // Bus tone chain (voices → [crush] → blanket LPF → out). Matched to
  // createKit's ~4.5 dB headroom pull so stacked pads stay below the bus
  // limiter.
  const bus = new Tone.Gain(0.6);
  // The lofi "blanket": roll off the highs so nothing sparkles. 3.4 kHz keeps
  // the kit audible on a phone speaker (see createKit's hat tuning) while still
  // reading as muffled/warm.
  const blanket = new Tone.Filter(3400, 'lowpass');
  blanket.Q.value = 0.4;
  // Subtle sample-rate/bit reduction for the "old sampler" grain. Kept light
  // (8-bit, 35% wet) — heavy crushing turns musical hits into harsh noise.
  // BitCrusher is AudioWorklet-backed; if the worklet isn't available we drop
  // it from the chain rather than failing to build the whole kit.
  let crush = null;
  try {
    crush = new Tone.BitCrusher(8);
    crush.wet.value = 0.35;
    bus.chain(crush, blanket, out);
  } catch (e) {
    console.warn('[qualia] lofi BitCrusher unavailable, using clean bus:', e);
    bus.chain(blanket, out);
  }

  // Roomier than the default kit — a chillhop kit lives in its reverb tail.
  const reverb = new Tone.Reverb({ decay: 2.2, wet: 0.22 }).connect(bus);

  // ── Kick — low, round, slow pitch fall (boom-bap thump) ─────────────────
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.08,
    octaves:    5,
    oscillator: { type: 'sine' },
    envelope:   { attack: 0.001, decay: 0.5, sustain: 0.01, release: 1.4 },
  }).connect(bus);

  // ── Snare — softer body, more reverb, less crack ────────────────────────
  const snareNoise = new Tone.NoiseSynth({
    noise:    { type: 'pink' },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0 },
  });
  const snareBp = new Tone.Filter(1400, 'bandpass');
  snareBp.Q.value = 0.9;
  snareNoise.connect(snareBp);
  snareBp.connect(reverb);
  const snareBody = new Tone.MembraneSynth({
    pitchDecay: 0.03, octaves: 2,
    envelope: { attack: 0.001, decay: 0.12, sustain: 0 },
  });
  snareBody.volume.value = -10;
  snareBody.connect(bus);

  // ── Hats — darker MetalSynth, dustier and quieter ───────────────────────
  const hatClosed = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 0.05, release: 0.02 },
    harmonicity:     4.2,
    modulationIndex: 24,
    resonance:       2400,
    octaves:         1.2,
  });
  hatClosed.volume.value = -14;
  hatClosed.connect(bus);

  const hatOpen = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 0.32, release: 0.18 },
    harmonicity:     4.2,
    modulationIndex: 24,
    resonance:       2400,
    octaves:         1.2,
  });
  hatOpen.volume.value = -16;
  hatOpen.connect(bus);

  // ── Toms — lower & softer than the default kit ──────────────────────────
  const tomLow  = new Tone.MembraneSynth({ pitchDecay: 0.07, octaves: 3 }).connect(bus);
  const tomMid  = new Tone.MembraneSynth({ pitchDecay: 0.07, octaves: 3 }).connect(bus);
  const tomHigh = new Tone.MembraneSynth({ pitchDecay: 0.07, octaves: 3 }).connect(bus);

  // ── Crash / ride — washed back into the room, trimmed low ───────────────
  const crash = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 1.6, release: 1.4 },
    harmonicity:     5.6,
    modulationIndex: 32,
    resonance:       3400,
    octaves:         1.5,
  });
  crash.volume.value = -20;
  crash.connect(reverb);

  const ride = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 0.5, release: 0.35 },
    harmonicity:     4.8,
    modulationIndex: 18,
    resonance:       3000,
    octaves:         1.2,
  });
  ride.volume.value = -17;
  ride.connect(bus);

  // ── Rim — soft woody tick ───────────────────────────────────────────────
  const rim = new Tone.MetalSynth({
    envelope:        { attack: 0.001, decay: 0.05, release: 0.04 },
    harmonicity:     2.8,
    modulationIndex: 10,
    resonance:       1400,
    octaves:         0.9,
  });
  rim.volume.value = -15;
  rim.connect(bus);

  const triggers = {
    'kick':  (t, v = 1) => kick.triggerAttackRelease('A0', '4n', t, v),
    'snare': (t, v = 1) => { snareNoise.triggerAttackRelease('8n', t, v); snareBody.triggerAttackRelease('G2', '16n', t, v); },
    'hat-c': (t, v = 1) => hatClosed.triggerAttackRelease('C5', '32n', t, v),
    'hat-o': (t, v = 1) => hatOpen.triggerAttackRelease('C5',  '8n', t, v),
    'tom-l': (t, v = 1) => tomLow.triggerAttackRelease('G1',  '8n', t, v),
    'tom-m': (t, v = 1) => tomMid.triggerAttackRelease('C2',  '8n', t, v),
    'tom-h': (t, v = 1) => tomHigh.triggerAttackRelease('F2', '8n', t, v),
    'crash': (t, v = 1) => crash.triggerAttackRelease('C5', '4n', t, v),
    'ride':  (t, v = 1) => ride.triggerAttackRelease('C5', '8n', t, v),
    'rim':   (t, v = 1) => rim.triggerAttackRelease('A4', '16n', t, v),
  };

  const nodes = [
    kick, snareNoise, snareBp, snareBody, hatClosed, hatOpen,
    tomLow, tomMid, tomHigh, crash, ride, rim,
    reverb, crush, blanket, bus, out,
  ].filter(Boolean);   // crush may be null if the worklet was unavailable

  return {
    output: out,
    trigger(voiceId, time, velocity) {
      const fn = triggers[voiceId];
      if (fn) fn(time, velocity);
    },
    has(voiceId) { return Object.prototype.hasOwnProperty.call(triggers, voiceId); },
    dispose() {
      for (const n of nodes) { try { n.dispose?.(); } catch {} }
    },
  };
}

// ── Sample kit ───────────────────────────────────────────────────────────
// Plays decoded one-shots from a Strudel-format `strudel.json` manifest — the
// exact same packs Strudel loads via `samples()`, so a sound heard in the REPL
// is the sound the sequencer plays. `voiceMap` maps the sequencer's stable
// voice ids (kick/snare/hat-c/…) onto sample names in the manifest (bd/sd/hh/…);
// a voice with no mapping (or whose sample failed to load) simply stays silent,
// matching createKit()'s "unknown voice = no-op" contract.
//
// Loading is async and best-effort: the kit returns immediately with a `ready`
// promise; `trigger` is a no-op until the buffer for that voice has decoded, so
// playback can start before every sample is in (early hits just don't sound).
// Per-hit it spins up a short-lived ToneBufferSource → velocity Gain so hits
// can overlap (a fast open-hat roll, a flam) without choking each other; both
// nodes self-dispose on `onended`.
export function createSampleKit({ manifestUrl, voiceMap = {}, gain = 0.95 } = {}) {
  const out = new Tone.Gain(gain);
  // Headroom stage to match the synth kits — sample one-shots are normalised
  // near full scale, so a kick+hat stack would otherwise sum past 0 dBFS.
  const bus = new Tone.Gain(0.7);
  bus.connect(out);

  const buffers = Object.create(null);   // voiceId → AudioBuffer
  let disposed = false;

  const ready = (async () => {
    if (!manifestUrl) return;
    let resolved;
    try {
      resolved = await resolveManifest(manifestUrl);
    } catch (e) {
      console.warn('[qualia] sample kit manifest load failed:', e);
      return;
    }
    const rawCtx = Tone.getContext().rawContext;
    const tasks = [];
    for (const voiceId of Object.keys(voiceMap)) {
      const sampleName = voiceMap[voiceId];
      const entry = resolved.names[sampleName];
      // First variation of an array; for a pitched map, the first value.
      const url = Array.isArray(entry) ? entry[0]
                : (entry && typeof entry === 'object') ? Object.values(entry)[0]
                : null;
      if (!url) continue;
      tasks.push((async () => {
        try {
          const ab = await (await fetch(url, { cache: 'force-cache' })).arrayBuffer();
          // decodeAudioData detaches the ArrayBuffer; one decode per URL.
          const audioBuf = await rawCtx.decodeAudioData(ab);
          if (!disposed) buffers[voiceId] = audioBuf;
        } catch (e) {
          console.warn(`[qualia] sample "${sampleName}" (${voiceId}) failed:`, e);
        }
      })());
    }
    await Promise.all(tasks);
  })();

  return {
    output: out,
    ready,
    /** True once at least one voice has decoded — UI can show a loading pip. */
    isReady() { return Object.keys(buffers).length > 0; },
    trigger(voiceId, time, velocity = 1) {
      const audioBuf = buffers[voiceId];
      if (!audioBuf) return;   // not loaded / unmapped → silent, never crash
      try {
        const src = new Tone.ToneBufferSource(audioBuf);
        const vg = new Tone.Gain(Math.max(0, Math.min(1, velocity))).connect(bus);
        src.connect(vg);
        src.onended = () => { try { src.dispose(); vg.dispose(); } catch {} };
        src.start(time);
      } catch (e) { /* scheduling past/edge times — drop the hit */ }
    },
    // A voice is "playable" if it's mapped in the kit — greys out unmapped pads
    // exactly like the synth kits do, even before the buffer has finished
    // loading (so the grid doesn't flicker as samples arrive).
    has(voiceId) { return Object.prototype.hasOwnProperty.call(voiceMap, voiceId); },
    dispose() {
      disposed = true;
      try { bus.dispose(); } catch {}
      try { out.dispose(); } catch {}
      for (const k of Object.keys(buffers)) delete buffers[k];
    },
  };
}
