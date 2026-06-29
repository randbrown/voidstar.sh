// real_0 collection — manifest generator (real recorded drum-machine one-shots).
//
// Unlike the synthesised `signature` / `voidstar_0` collections, `real_0` is a
// curated set of REAL recorded one-shots — one classic drum machine per genre —
// for an honest A/B against the synthetic packs. To avoid re-hosting binaries we
// don't own, the committed manifests reference the samples BY URL (the same
// posture as the in-app GitHub pack loader): each
// `public/samples/real_0/<genre>/strudel.json` holds absolute
// raw.githubusercontent URLs into the TidalCycles/Strudel drum-machine library
// (ritchse/tidal-drum-machines, via felixroos/dough-samples). The audio streams
// + decodes lazily at play time; nothing binary is committed here.
//
// Trade-off vs the other collections: real_0 needs network at play time (the
// synthetic collections are fully offline). Source/credit lives in
// public/samples/README.md.
//
// Run:  node scripts/gen-real-manifests.mjs   (or `npm run gen:samples:real`)
// Needs network: it reads the upstream index to resolve exact filenames, then
// writes the committed manifests. Re-run if the genre→machine map changes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLLECTION = 'real_0';
const SAMPLES_ROOT = join(__dirname, '..', 'public', 'samples', COLLECTION);

// Upstream index of every machine's voices → relative file paths.
const INDEX_URL = 'https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json';

const VOICES = ['bd', 'sd', 'rim', 'hh', 'oh', 'lt', 'mt', 'ht', 'rd', 'cr'];

// One characterful machine per genre. All are real recordings of the named unit.
// FALLBACK fills any voice a machine lacks (e.g. the TR-808 has no ride) so every
// pad lands a real hit and the voice contract stays complete.
const GENRE_MACHINE = {
  voidstar: 'RolandTR909',           // clean, punchy — the neon 909
  lofi:     'AkaiMPC60',             // 12-bit boom-bap sampler
  tape:     'RolandCompurhythm1000', // vintage preset-box character
  dub:      'RolandTR808',           // deep sub kick (no ride → fallback)
  jazz:     'RolandR8',              // "human feel", natural-leaning kit
  metal:    'OberheimDMX',           // hard, punchy digital
  death:    'AkaiXR10',              // sharp, aggressive digital
  hiphop:   'EmuSP12',              // classic hip-hop SP
};
const FALLBACK = 'RolandTR909';

// Our `rim` ← the machine's rimshot/clap, in preference order.
const VOICE_ALIASES = { rim: ['rim', 'rs', 'cp'] };

const index = await (await fetch(INDEX_URL)).json();
const base = index._base;
const machineVoices = (m) => {
  const out = {};
  for (const k of Object.keys(index)) {
    if (k === '_base' || !k.startsWith(m + '_')) continue;
    out[k.slice(m.length + 1)] = index[k];
  }
  return out;
};
// First file for `voice` on `machine`, honouring aliases; absolute encoded URL.
const pick = (machine, voice) => {
  const vs = machineVoices(machine);
  const names = VOICE_ALIASES[voice] || [voice];
  for (const n of names) {
    if (vs[n] && vs[n].length) return encodeURI(base + vs[n][0]);
  }
  return null;
};

let count = 0;
for (const [genre, machine] of Object.entries(GENRE_MACHINE)) {
  const dir = join(SAMPLES_ROOT, genre);
  mkdirSync(dir, { recursive: true });
  const manifest = {};
  const filled = [];
  for (const v of VOICES) {
    const url = pick(machine, v) || pick(FALLBACK, v);
    if (!url) { console.warn(`  ${genre}: no sample for ${v}`); continue; }
    if (!pick(machine, v)) filled.push(v);
    manifest[v] = [url];
  }
  writeFileSync(join(dir, 'strudel.json'), JSON.stringify(manifest, null, 2) + '\n');
  count++;
  console.log(`  ${genre.padEnd(9)} ${machine.padEnd(22)} ${Object.keys(manifest).length}/10 voices${filled.length ? `  (fallback ${FALLBACK}: ${filled.join(',')})` : ''}`);
}
console.log(`\nWrote ${count} real_0 manifests under ${SAMPLES_ROOT} (remote-referenced, streamed at play time).`);
