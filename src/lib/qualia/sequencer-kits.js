// Sequencer kit catalog — names the swappable instruments and how to build them.
//
// A "kit" is an instrument the sequencer's pads play through. Every kit speaks
// the same stable voice ids (the VOICES catalog in sequencer-patterns.js), so a
// groove sounds like itself on any kit — switching re-voices the pattern without
// touching the grid. Each genre family ships in two variants:
//   - synth  → a Tone.js synth factory (offline, zero-network, always available)
//   - samples→ decoded one-shots from the bundled strudel.json pack of the same
//              genre, the same files Strudel registers via samples()
//
// To add a genre: add a FAMILY entry (+ a SYNTH_SPECS spec if it isn't one of
// the two hand-written kits) and a bundled pack id in samples-manifest.js. To
// pull in an external pack at runtime, see the GitHub loader in sequencer.js.

import {
  createKit, createLofiKit, createSynthKit, createSampleKit,
} from './sequencer-voices.js';
import { getActiveCollectionId, COLLECTIONS, getCollection, packUrl } from './samples-manifest.js';

// Map the sequencer's voice ids onto the sample names used by Strudel's default
// drum-machine banks (bd/sd/hh/oh/…) — every bundled pack uses these names, so a
// compatibly-named external pack lines up with the pad rows too.
export const DRUM_VOICE_MAP = {
  'kick':  'bd',
  'snare': 'sd',
  'hat-c': 'hh',
  'hat-o': 'oh',
  'tom-l': 'lt',
  'tom-m': 'mt',
  'tom-h': 'ht',
  'crash': 'cr',
  'ride':  'rd',
  'rim':   'rim',
};

// Candidate sample names per voice for EXTERNALLY-loaded packs, whose naming
// rarely matches Strudel's exact bd/sd/hh convention. createSampleKit takes the
// first name that exists in the pack's manifest, so a Dirt-Samples-style pack
// (uses `sn`, `cp`, …) still lands most pads. Best-effort: a voice with no
// matching name in the pack just stays silent.
export const EXTERNAL_VOICE_MAP = {
  'kick':  ['bd', 'kick', 'bassdrum', 'bass', 'kd'],
  'snare': ['sd', 'sn', 'snare', 'snaredrum'],
  'hat-c': ['hh', 'hat', 'ch', 'hihat', 'hc'],
  'hat-o': ['oh', 'open', 'ho', 'hho', 'openhat'],
  'tom-l': ['lt', 'tomlow', 'tom1', 'tom'],
  'tom-m': ['mt', 'tommid', 'tom2', 'tom'],
  'tom-h': ['ht', 'tomhi', 'tom3', 'tom'],
  'crash': ['cr', 'crash', 'cym', 'cymbal', 'cc'],
  'ride':  ['rd', 'ride', 'rc'],
  'rim':   ['rim', 'rs', 'rimshot', 'cp', 'clap'],
};

// ── Synth specs for the config-driven genre kits ───────────────────────────
// Compact builders so a spec reads as character, not boilerplate.
const env = (a, d, s = 0, r = 0) => ({ attack: a, decay: d, sustain: s, release: r });
const membrane = (pitchDecay, octaves, e) => ({ pitchDecay, octaves, oscillator: { type: 'sine' }, envelope: e });
const metal = (decay, release, harmonicity, modulationIndex, resonance, octaves) =>
  ({ envelope: { attack: 0.001, decay, release }, harmonicity, modulationIndex, resonance, octaves });

const SYNTH_SPECS = {
  // Cassette — saturated, mellow, highs rolled hard.
  tape: {
    lowpass: 3000, bitcrush: { bits: 7, wet: 0.4 }, drive: 0.18, driveWet: 0.35,
    reverb: { decay: 1.8, wet: 0.18 },
    kick:  { synth: membrane(0.08, 5, env(0.001, 0.5, 0.01, 1.4)), note: 'A0', dur: '4n' },
    snare: {
      noise: { noise: { type: 'pink' }, envelope: env(0.001, 0.16) }, bp: { freq: 1300, Q: 0.8 },
      dur: '8n', toReverb: true,
      body: { synth: membrane(0.03, 2, env(0.001, 0.12)), note: 'G2', dur: '16n', vol: -11 },
    },
    hatC:  { synth: metal(0.05, 0.02, 4.0, 22, 2200, 1.1), vol: -15 },
    hatO:  { synth: metal(0.30, 0.18, 4.0, 22, 2200, 1.1), vol: -17 },
    toms:  { synth: membrane(0.07, 3, env(0.001, 0.3, 0, 0.3)), notes: ['G1', 'C2', 'F2'] },
    crash: { synth: metal(1.6, 1.4, 5.4, 30, 3000, 1.4), vol: -21, toReverb: true },
    ride:  { synth: metal(0.5, 0.35, 4.6, 16, 2600, 1.2), vol: -18 },
    rim:   { synth: metal(0.05, 0.04, 2.6, 9, 1300, 0.9), vol: -16 },
  },
  // Dubstep — deep sub kick, huge long snare, wide bright crashes, lots of space.
  dub: {
    lowpass: 5200, reverb: { decay: 3.4, wet: 0.3 },
    kick:  { synth: membrane(0.10, 7, env(0.001, 0.7, 0.01, 1.8)), note: 'F0', dur: '2n' },
    snare: {
      noise: { noise: { type: 'white' }, envelope: env(0.001, 0.3) }, bp: { freq: 1900, Q: 0.7 },
      dur: '4n', toReverb: true,
      body: { synth: membrane(0.04, 3, env(0.001, 0.18)), note: 'E2', dur: '8n', vol: -8 },
    },
    hatC:  { synth: metal(0.04, 0.02, 5.4, 30, 3200, 1.5), vol: -10 },
    hatO:  { synth: metal(0.4, 0.25, 5.4, 30, 3200, 1.5), vol: -12 },
    toms:  { synth: membrane(0.06, 4, env(0.001, 0.4, 0, 0.4)), notes: ['E1', 'A1', 'D2'] },
    crash: { synth: metal(1.8, 1.6, 6.0, 36, 3400, 1.7), vol: -16, toReverb: true },
    ride:  { synth: metal(0.6, 0.4, 5.0, 22, 3000, 1.4), vol: -14 },
    rim:   { synth: metal(0.05, 0.04, 3.2, 12, 1700, 1.0), vol: -12 },
  },
  // Modern jazz — soft, brushed, ride-forward, natural decays, no crush.
  jazz: {
    reverb: { decay: 1.6, wet: 0.16 },
    kick:  { synth: membrane(0.05, 4, env(0.001, 0.28, 0.01, 0.8)), note: 'C1', dur: '8n' },
    snare: {
      noise: { noise: { type: 'pink' }, envelope: env(0.001, 0.16) }, bp: { freq: 2400, Q: 0.6 },
      dur: '8n', toReverb: true,
      body: { synth: membrane(0.02, 2, env(0.001, 0.1)), note: 'A2', dur: '16n', vol: -16 },
    },
    hatC:  { synth: metal(0.05, 0.03, 5.6, 26, 3400, 1.4), vol: -14 },
    hatO:  { synth: metal(0.28, 0.2, 5.6, 26, 3400, 1.4), vol: -16 },
    toms:  { synth: membrane(0.05, 4, env(0.001, 0.32, 0, 0.3)), notes: ['A1', 'D2', 'A2'] },
    crash: { synth: metal(1.2, 1.0, 6.2, 30, 3600, 1.6), vol: -20, toReverb: true },
    ride:  { synth: metal(0.7, 0.5, 5.2, 18, 3500, 1.3), vol: -10 },   // ride-forward
    rim:   { synth: metal(0.05, 0.04, 3.0, 10, 1700, 1.0), vol: -13 },
  },
  // Metal (Pantera/Metallica/Gojira) — clicky beater kick, cracking snare, tight.
  metal: {
    lowpass: 8000, reverb: { decay: 0.8, wet: 0.08 },
    kick:  { synth: membrane(0.012, 8, env(0.001, 0.18, 0, 0.3)), note: 'C1', dur: '16n' },
    snare: {
      noise: { noise: { type: 'white' }, envelope: env(0.001, 0.1) }, bp: { freq: 2600, Q: 1.0 },
      dur: '16n',
      body: { synth: membrane(0.02, 3, env(0.001, 0.06)), note: 'B2', dur: '32n', vol: -7 },
    },
    hatC:  { synth: metal(0.03, 0.02, 5.4, 30, 3400, 1.4), vol: -10 },
    hatO:  { synth: metal(0.25, 0.15, 5.4, 30, 3400, 1.4), vol: -12 },
    toms:  { synth: membrane(0.03, 4, env(0.001, 0.22)), notes: ['A1', 'E2', 'A2'] },
    crash: { synth: metal(1.4, 1.2, 6.4, 40, 3600, 1.8), vol: -14, toReverb: true },
    ride:  { synth: metal(0.45, 0.3, 5.4, 22, 3200, 1.3), vol: -12 },
    rim:   { synth: metal(0.04, 0.03, 3.4, 14, 2000, 1.0), vol: -11 },
  },
  // Death metal (Suffocation/Devourment) — ultra-tight triggered kick, pingy snare.
  death: {
    lowpass: 9000, reverb: { decay: 0.5, wet: 0.05 },
    kick:  { synth: membrane(0.006, 10, env(0.001, 0.12, 0, 0.2)), note: 'C1', dur: '32n' },
    snare: {
      noise: { noise: { type: 'white' }, envelope: env(0.001, 0.06) }, bp: { freq: 3800, Q: 1.4 },
      dur: '32n',
      body: { synth: membrane(0.01, 3, env(0.001, 0.04)), note: 'E3', dur: '64n', vol: -6 },
    },
    hatC:  { synth: metal(0.02, 0.015, 5.6, 34, 3800, 1.5), vol: -9 },
    hatO:  { synth: metal(0.18, 0.12, 5.6, 34, 3800, 1.5), vol: -11 },
    toms:  { synth: membrane(0.02, 5, env(0.001, 0.18)), notes: ['B1', 'F2', 'B2'] },
    crash: { synth: metal(1.2, 1.0, 6.6, 44, 3800, 1.9), vol: -13, toReverb: true },
    ride:  { synth: metal(0.35, 0.25, 5.6, 24, 3400, 1.3), vol: -11 },
    rim:   { synth: metal(0.03, 0.02, 3.6, 16, 2200, 1.0), vol: -10 },
  },
  // Hiphop (Dilla) — dusty thick kick, vinyl snare, soft hats, warm crush.
  hiphop: {
    lowpass: 3200, bitcrush: { bits: 9, wet: 0.3 }, reverb: { decay: 1.6, wet: 0.18 },
    kick:  { synth: membrane(0.06, 5, env(0.001, 0.4, 0.01, 1.0)), note: 'B0', dur: '4n' },
    snare: {
      noise: { noise: { type: 'pink' }, envelope: env(0.001, 0.18) }, bp: { freq: 1500, Q: 0.8 },
      dur: '8n', toReverb: true,
      body: { synth: membrane(0.03, 2, env(0.001, 0.12)), note: 'F2', dur: '16n', vol: -10 },
    },
    hatC:  { synth: metal(0.05, 0.03, 4.4, 24, 2600, 1.2), vol: -13 },
    hatO:  { synth: metal(0.3, 0.2, 4.4, 24, 2600, 1.2), vol: -15 },
    toms:  { synth: membrane(0.07, 3, env(0.001, 0.3, 0, 0.3)), notes: ['G1', 'C2', 'F2'] },
    crash: { synth: metal(1.5, 1.3, 5.6, 32, 2900, 1.4), vol: -20, toReverb: true },
    ride:  { synth: metal(0.5, 0.35, 4.8, 16, 2800, 1.2), vol: -17 },
    rim:   { synth: metal(0.05, 0.04, 2.8, 10, 1500, 0.9), vol: -15 },
  },
};

// ── Genre families ─────────────────────────────────────────────────────────
// voidstar + lofi keep their hand-written synth kits; the rest use createSynthKit.
const FAMILIES = [
  { id: 'voidstar', label: 'voidstar', desc: 'Clean, punchy 808/909 — the original voidstar default.', synth: () => createKit() },
  { id: 'lofi',     label: 'lofi',     desc: 'Warm, filtered boom-bap / chillhop.',                       synth: () => createLofiKit() },
  { id: 'tape',     label: 'tape',     desc: 'Saturated cassette character — mellow, rolled-off, dusty.',  synth: () => createSynthKit(SYNTH_SPECS.tape) },
  { id: 'dub',      label: 'dub',      desc: 'Heavy dubstep — deep sub kick, huge snare, wide space (San Holo / Com Truise).', synth: () => createSynthKit(SYNTH_SPECS.dub) },
  { id: 'jazz',     label: 'jazz',     desc: 'Clean modern-jazz kit — soft, brushed, ride-forward.',        synth: () => createSynthKit(SYNTH_SPECS.jazz) },
  { id: 'metal',    label: 'metal',    desc: 'Tight, aggressive metal — clicky kick, cracking snare (Pantera / Metallica / Gojira).', synth: () => createSynthKit(SYNTH_SPECS.metal) },
  { id: 'death',    label: 'death',    desc: 'Extreme death metal — ultra-tight kick, pingy snare (Suffocation / Devourment).', synth: () => createSynthKit(SYNTH_SPECS.death) },
  { id: 'hiphop',   label: 'hiphop',   desc: 'Dusty Dilla-style boom-bap.',                                 synth: () => createSynthKit(SYNTH_SPECS.hiphop) },
];

// ── Kits as a (genre × source) grid ─────────────────────────────────────────
// A kit is one GENRE played through one SOURCE. The genre picks the voicing
// (tuning/decay/character); the source picks where the sound comes from:
//   - 'synth'      → the genre's Tone.js synth factory (offline, always there)
//   - a collection → that genre's bundled sample pack (signature / voidstar_0 /
//                    real_0), decoded by createSampleKit
// This is the model the sequencer UI exposes as two dropdowns, so 'synth' reads
// as just another source alongside the sample collections (no more 16-entry list,
// and the source choice applies uniformly across genres).
export const GENRES_META = FAMILIES;       // [{ id, label, desc, synth }]
export const DEFAULT_GENRE = 'voidstar';
export const DEFAULT_SOURCE = 'synth';

// Selectable sources: synth first, then every bundled collection. (Externally
// loaded GitHub/URL packs are added as extra sources at runtime by sequencer.js.)
export const SOURCES = [
  { id: 'synth', label: 'synth', desc: 'Tone.js synthesis — offline, always available.' },
  ...COLLECTIONS.map((c) => ({ id: c.id, label: c.label, desc: c.desc })),
];

const FAMILY_BY_ID = Object.fromEntries(FAMILIES.map((f) => [f.id, f]));
const GENRE_SET = new Set(FAMILIES.map((f) => f.id));
const COLLECTION_IDS = new Set(COLLECTIONS.map((c) => c.id));

// Canonical kit id from (genre, source): synth stays a bare "<genre>" (so old
// saved patterns keep working); a collection source is "<genre>@<collection>".
export function kitIdFor(genre, source) {
  return source === 'synth' ? genre : `${genre}@${source}`;
}

// Parse a kit id into { genre, source }, tolerant of legacy forms:
//   "voidstar"          → { voidstar, synth }     (current + legacy synth)
//   "voidstar-samples"  → { voidstar, <active collection> }   (legacy sample kit)
//   "metal@real_0"      → { metal, real_0 }
// Returns null for anything else (e.g. an external pack id) so callers fall back.
export function parseKitId(id = '') {
  if (id.includes('@')) {
    const [genre, source] = id.split('@');
    if (GENRE_SET.has(genre) && COLLECTION_IDS.has(source)) return { genre, source };
  }
  if (id.endsWith('-samples')) {
    const genre = id.slice(0, -'-samples'.length);
    if (GENRE_SET.has(genre)) return { genre, source: getActiveCollectionId() };
  }
  if (GENRE_SET.has(id)) return { genre: id, source: 'synth' };
  return null;
}

// Build the live kit (Tone synth or decoded sample kit) for a (genre, source).
export function makeKit(genre, source) {
  const fam = FAMILY_BY_ID[genre] || FAMILIES[0];
  if (source === 'synth') return fam.synth();
  return createSampleKit({ manifestUrl: packUrl(source, genre), voiceMap: DRUM_VOICE_MAP });
}

export const DEFAULT_KIT_ID = kitIdFor(DEFAULT_GENRE, DEFAULT_SOURCE);   // 'voidstar'

// Descriptor (metadata + make) for a kit id — null for ids we don't own (the
// sequencer resolves those against its external-pack registry first).
export function getKit(id) {
  const p = parseKitId(id);
  if (!p) return null;
  const fam = FAMILY_BY_ID[p.genre] || FAMILIES[0];
  const isSynth = p.source === 'synth';
  const srcLabel = isSynth ? 'synth' : getCollection(p.source).label;
  return {
    id: kitIdFor(p.genre, p.source),
    genre: p.genre,
    source: p.source,
    type: isSynth ? 'synth' : 'sample',
    label: `${fam.label} · ${srcLabel}`,
    desc: `${fam.desc} (${isSynth ? 'synthesised' : `${srcLabel} samples`})`,
    make: () => makeKit(p.genre, p.source),
  };
}
