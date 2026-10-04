// Bundled speech one-shots — capture shabda TTS renders into the repo.
//
// `await samples('shabda/speech:voidstar')` in a pattern asks shabda.ndre.gr to
// render the word and registers the result as the sound `voidstar` (the default
// metal-horns 🤘 sample). That needs network on every boot. This script captures
// the render ONCE and embeds it as a data: URL in
// `public/samples/speech/strudel.json`, which strudel-hydra registers at boot
// (registerSpeechSamples) — so `s("voidstar")` and the horns sample work offline
// with no samples() line at all.
//
// Run:  node scripts/fetch-shabda-speech.mjs                 (→ voidstar)
//       node scripts/fetch-shabda-speech.mjs void star       (several words)
//       node scripts/fetch-shabda-speech.mjs --lang en-US --gender m voidstar
//   or  npm run gen:samples:speech
// Needs network (shabda.ndre.gr). Re-running a word replaces its entry; other
// words already in the manifest are kept. Same URL scheme as Strudel's own
// `shabda/speech[/<lang>/<gender>]:<words>` (superdough sampler.mjs).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'samples', 'speech');
const OUT = join(OUT_DIR, 'strudel.json');

const args = process.argv.slice(2);
let language = 'en-GB';
let gender = 'f';
const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--lang') language = args[++i];
  else if (args[i] === '--gender') gender = args[++i];
  else words.push(args[i]);
}
if (!words.length) words.push('voidstar');

const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res;
}

let manifest = {};
try { manifest = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}

const mapUrl = `https://shabda.ndre.gr/speech/${words.join(',')}.json?gender=${gender}&language=${language}&strudel=1`;
console.log(`shabda map: ${mapUrl}`);
const map = await (await fetchOk(mapUrl)).json();
// Same base rule superdough applies: the map's `_base`, else the map URL's dir.
const base = map._base || mapUrl.slice(0, mapUrl.lastIndexOf('/') + 1);

for (const [name, value] of Object.entries(map)) {
  if (name === '_base') continue;
  const paths = Array.isArray(value) ? value : [value];
  const embedded = [];
  for (const p of paths) {
    const url = /^https?:\/\//i.test(p) ? p : base + p;
    const res = await fetchOk(url);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    const mime = type.startsWith('audio/') ? type : (MIME[extname(new URL(url).pathname).toLowerCase()] || 'audio/mpeg');
    const buf = Buffer.from(await res.arrayBuffer());
    embedded.push(`data:${mime};base64,${buf.toString('base64')}`);
    console.log(`  ${name}: ${url} (${mime}, ${(buf.length / 1024).toFixed(1)} KiB)`);
  }
  manifest[name] = embedded.length === 1 ? embedded[0] : embedded;
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${OUT}`);
