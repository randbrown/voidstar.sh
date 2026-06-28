// Sequencer kit catalog — names the swappable instruments and how to build them.
//
// A "kit" is an instrument the sequencer's pads play through. Every kit speaks
// the same stable voice ids (the VOICES catalog in sequencer-patterns.js), so a
// groove sounds like itself on any kit — switching kits re-voices the pattern
// without touching the grid. Kits come in two flavours:
//   - synth  → a Tone.js synth factory (offline, zero-network, always available)
//   - sample → decoded one-shots from a shared strudel.json manifest, the same
//              packs Strudel loads via samples() (needs the files to be present)
//
// To add a kit: add an entry here. A synth kit needs a `make()` returning the
// `{ output, trigger, has, dispose }` interface; a sample kit points at a
// manifest URL and maps voice ids → sample names in that manifest.

import { createKit, createLofiKit, createSampleKit } from './sequencer-voices.js';
import { VOIDSTAR_LOFI_PACK_URL } from './samples-manifest.js';

// Map the sequencer's voice ids onto the sample names used by Strudel's default
// drum-machine banks (bd/sd/hh/oh/…), so the bundled pack — and any compatibly
// named pack a user drops in — lines up with the pad rows.
const DRUM_VOICE_MAP = {
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

// URL of the bundled synthetic lofi pack (defined in samples-manifest.js so
// Strudel and the sequencer reference the same constant). Re-exported for any
// caller that wants the kit catalog's view of it.
export const LOFI_PACK_URL = VOIDSTAR_LOFI_PACK_URL;

export const KITS = [
  {
    id: 'default',
    label: 'default · synth',
    type: 'synth',
    desc: 'The classic 808/909-flavoured synth kit. Clean, punchy, always on.',
    make: () => createKit(),
  },
  {
    id: 'lofi',
    label: 'lofi · synth',
    type: 'synth',
    desc: 'Warm, filtered, tape-flavoured synthesis — boom-bap / chillhop feel.',
    make: () => createLofiKit(),
  },
  {
    id: 'lofi-tape',
    label: 'lofi tape · samples',
    type: 'sample',
    desc: 'Synthetic lofi one-shots loaded from the shared strudel.json pack — '
        + 'the same samples Strudel plays.',
    make: () => createSampleKit({ manifestUrl: LOFI_PACK_URL, voiceMap: DRUM_VOICE_MAP }),
  },
];

export const DEFAULT_KIT_ID = 'default';

export function getKit(id) {
  return KITS.find((k) => k.id === id) || KITS[0];
}
