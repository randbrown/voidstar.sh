// Sort Strudel's flat sound registry into what the sounds tab shows: drum
// banks (one row per bank, its voices as chips) apart from plain samples,
// synths and soundfonts — the split strudel.cc's sounds panel makes.
//
// superdough names a bank's sounds `<bank>_<voice>` (`.bank("x")` rewrites
// s("bd") to `x_bd`), but plenty of plain samples have underscores too
// (`balafon_hard`, `ocarina_small_stacc`). So a prefix counts as a bank when
// it carries at least one drum voice (bd, sd, hh, …) across two or more
// names, or when the caller says it's one of ours. Strudel's aliasBank()
// registers `tr909_bd` as the SAME entry as `rolandtr909_bd`; listSounds()
// flags those with `aliasOf`, and an all-alias bank folds into its target as
// an "aka" instead of listing twice.
//
// Pure (no DOM, no Strudel) so scripts/check-qualia-sound-groups.mjs runs it
// in node.

/** Voice suffixes that mark a `<bank>_<voice>` name as a drum bank. */
export const DRUM_VOICES = new Set([
  'bd', 'sd', 'hh', 'oh', 'ch', 'cp', 'cr', 'rd', 'rim', 'lt', 'mt', 'ht',
  'cb', 'perc', 'misc', 'sh', 'tb', 'fx',
]);
// Voice order on a bank row: kit order first, then anything else A→Z.
const VOICE_ORDER = ['bd', 'sd', 'rim', 'cp', 'hh', 'ch', 'oh', 'lt', 'mt', 'ht', 'rd', 'cr', 'cb', 'sh', 'tb', 'perc', 'misc', 'fx'];
const voiceRank = (v) => { const i = VOICE_ORDER.indexOf(v); return i < 0 ? VOICE_ORDER.length : i; };

/** The views the sounds tab offers, in chip order. */
export const SOUND_VIEWS = ['banks', 'samples', 'synths', 'soundfonts', 'other'];

const splitBank = (name) => {
  const i = name.indexOf('_');
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [null, name];
};

/**
 * @param {Array<{name:string, type:string, count:number, aliasOf?:string}>} list
 *        listSounds() output.
 * @param {Map<string, object>} [custom]  bank name → info for our own banks
 *        (always treated as banks; the info object rides along as `info`).
 * @returns {{ banks: Array<{name:string, voices:Array<{voice:string, name:string, count:number}>,
 *             aka:string[], info?:object}>, samples:Array, synths:Array, soundfonts:Array, other:Array }}
 */
export function groupSounds(list, custom = new Map()) {
  const byPrefix = new Map();
  for (const s of list) {
    if (s.type !== 'sample') continue;
    const [bank, voice] = splitBank(s.name);
    if (!bank) continue;
    if (!byPrefix.has(bank)) byPrefix.set(bank, []);
    byPrefix.get(bank).push({ voice, name: s.name, count: s.count, aliasOf: s.aliasOf });
  }
  const isBank = (prefix, voices) => custom.has(prefix)
    || (voices.length >= 2 && voices.some((v) => DRUM_VOICES.has(v.voice)));

  const banks = new Map();
  const inBank = new Set();
  for (const [prefix, voices] of byPrefix) {
    if (!isBank(prefix, voices)) continue;
    voices.sort((a, b) => voiceRank(a.voice) - voiceRank(b.voice) || a.voice.localeCompare(b.voice));
    banks.set(prefix, { name: prefix, voices, aka: [], ...(custom.has(prefix) ? { info: custom.get(prefix) } : {}) });
    for (const v of voices) inBank.add(v.name);
  }
  // Fold alias banks (every voice an alias into one other bank) into that bank.
  for (const [prefix, b] of [...banks]) {
    if (b.info) continue;
    const targets = new Set(b.voices.map((v) => (v.aliasOf ? splitBank(v.aliasOf)[0] : null)));
    if (targets.size !== 1) continue;
    const [target] = targets;
    if (!target || target === prefix || !banks.has(target)) continue;
    banks.get(target).aka.push(prefix);
    banks.delete(prefix);
  }
  for (const b of banks.values()) {
    b.aka.sort();
    for (const v of b.voices) delete v.aliasOf;
  }

  const out = { banks: [...banks.values()].sort((a, b) => a.name.localeCompare(b.name)), samples: [], synths: [], soundfonts: [], other: [] };
  for (const s of list) {
    if (inBank.has(s.name)) continue;
    if (s.aliasOf) continue;   // an alias of a plain sample: the original is listed
    const view = s.type === 'sample' ? 'samples' : s.type === 'synth' ? 'synths' : s.type === 'soundfont' ? 'soundfonts' : 'other';
    out[view].push(s);
  }
  return out;
}

/** Does a bank match a search query (name, aka, voice, or its info text)? */
export function bankMatches(bank, q) {
  if (!q) return true;
  if (bank.name.includes(q) || bank.aka.some((a) => a.includes(q))) return true;
  if (bank.voices.some((v) => v.voice === q || v.name.includes(q))) return true;
  const info = bank.info;
  return !!info && Object.values(info).some((x) => typeof x === 'string' && x.toLowerCase().includes(q));
}

/** Filter every view by a (lower-cased, trimmed) query. */
export function filterGroups(groups, q) {
  if (!q) return groups;
  const out = { banks: groups.banks.filter((b) => bankMatches(b, q)) };
  for (const k of SOUND_VIEWS) {
    if (k !== 'banks') out[k] = groups[k].filter((s) => s.name.toLowerCase().includes(q));
  }
  return out;
}
