// Shared Strudel-format sample-manifest loader.
//
// One source of truth for "what samples does a pack contain", consumed by
// BOTH engines so they play the identical set of sounds:
//   - Strudel   → strudel-hydra.js feeds `globalThis.samples(map)`
//   - Sequencer → sequencer-voices.js decodes the URLs into Tone buffers
//
// The format is Strudel's `strudel.json` (see https://strudel.cc/learn/samples):
//
//   {
//     "_base": "https://host/path/"   // or "/root-relative/", optional
//     "bd":  "bd/kick.wav",            // single sample (string)
//     "sd":  ["sd1.wav", "sd2.wav"],   // variations → sd:0, sd:1, …
//     "piano": {                       // pitched map (note → file)
//       "_base": "piano/",             // optional per-entry base
//       "c4": "c4.wav", "e4": "e4.wav"
//     }
//   }
//
// `resolveManifest` fetches the JSON and resolves every path to an absolute
// URL using the same base + concatenation rules Strudel uses, so a relative
// `_base` (our bundled packs) and an absolute one (a `github:` pack copied in)
// both work and resolve identically in either engine.

// The genres every bundled collection ships. Stable order = picker/stepper order.
export const GENRES = ['voidstar', 'lofi', 'tape', 'dub', 'jazz', 'metal', 'death', 'hiphop'];

// ── Collections ─────────────────────────────────────────────────────────────
// A *collection* is a full bundled bank: one pack per genre, all swapped at once.
// We ship two so the same groove can be A/B'd between sound sets:
//   - signature  → the characterful default (scripts/gen-samples.mjs), embedded
//                  as data: URLs in each public/samples/signature/<genre>/strudel.json
//   - voidstar_0 → the ORIGINAL synthetic packs, the neutral baseline
//                  (scripts/gen-samples-voidstar0.mjs), loose WAVs under
//                  public/samples/voidstar_0/<genre>/
//
// `bank` is a short Strudel-bank token: every pack registers under both its plain
// `<genre>_` namespace (so .bank("metal") plays the ACTIVE collection) and a
// collection-qualified `<bank><genre>_` namespace (so .bank("sigmetal") /
// .bank("v0metal") always reach a specific collection for explicit A/B).
export const COLLECTIONS = [
  { id: 'signature',  label: 'signature',  bank: 'sig', desc: 'voidstar signature one-shots — characterful, embedded offline.' },
  { id: 'voidstar_0', label: 'voidstar_0', bank: 'v0',  desc: 'The original synthetic packs — neutral baseline (v0).' },
];
export const DEFAULT_COLLECTION_ID = 'signature';

const COLLECTION_BY_ID = Object.fromEntries(COLLECTIONS.map((c) => [c.id, c]));
export function getCollection(id) {
  return COLLECTION_BY_ID[id] || COLLECTION_BY_ID[DEFAULT_COLLECTION_ID];
}

// Active collection — the one the sequencer's "<genre> · samples" kits and the
// idiomatic Strudel `.bank("<genre>")` resolve to. In-memory here; the sequencer
// owns persistence (localStorage) and calls setActiveCollectionId on boot/change,
// and strudel-hydra reads it once at registration to pick the plain-bank set.
let _activeCollectionId = DEFAULT_COLLECTION_ID;
export function getActiveCollectionId() { return _activeCollectionId; }
export function setActiveCollectionId(id) {
  if (COLLECTION_BY_ID[id]) _activeCollectionId = id;
  return _activeCollectionId;
}

// Root-relative manifest URL for one genre within a collection.
export function packUrl(collectionId, genre) {
  return `/samples/${collectionId}/${genre}/strudel.json`;
}

// Every pack of a collection, shaped for both engines:
//   url        — the strudel.json the sequencer fetches / Strudel resolves
//   prefix     — plain `<genre>_` namespace (active-collection bank)
//   bankPrefix — collection-qualified `<bank><genre>_` namespace (explicit A/B)
export function collectionPacks(collectionId) {
  const c = getCollection(collectionId);
  return GENRES.map((genre) => ({
    id: `${c.id}:${genre}`,
    genre,
    collectionId: c.id,
    url: packUrl(c.id, genre),
    prefix: `${genre}_`,
    bankPrefix: `${c.bank}${genre}_`,
  }));
}

// Resolve a sample path against a base the way superdough does: string-concat
// `base + path` unless the path is already absolute, then normalise against the
// document so a root-relative base ("/samples/…") becomes a full URL.
function resolveUrl(path, base) {
  if (/^https?:\/\//i.test(path) || /^data:/i.test(path)) return path;
  const joined = (base || '') + path;
  try { return new URL(joined, document.baseURI).href; }
  catch { return joined; }
}

// Normalise one manifest entry (string | array | pitched object) into either
// an array of absolute URLs or, for a pitched map, a { note: url } object.
function resolveEntry(value, base) {
  if (typeof value === 'string') return [resolveUrl(value, base)];
  if (Array.isArray(value)) return value.map((p) => resolveUrl(p, base));
  if (value && typeof value === 'object') {
    // Pitched map: keys are note names, optional own `_base` stacks onto the
    // pack base. Preserve it as an object so callers can pitch-map later.
    const inner = value._base ? base + value._base : base;
    const out = {};
    for (const k of Object.keys(value)) {
      if (k === '_base') continue;
      out[k] = resolveUrl(value[k], inner);
    }
    return out;
  }
  return [];
}

/**
 * Fetch + resolve a strudel.json manifest.
 * @param {string} url manifest URL (absolute or root-relative)
 * @returns {Promise<{ base: string, names: Record<string, string[]|object> }>}
 */
export async function resolveManifest(url) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`samples manifest ${url} → HTTP ${res.status}`);
  const json = await res.json();
  // A relative `_base` ("./", "samples/") resolves against the manifest URL's
  // directory; an absolute or root-relative base is used as-is. This mirrors
  // how Strudel anchors a pack's files to where its json lives.
  let base = json._base || '';
  if (base && !/^https?:\/\//i.test(base) && !base.startsWith('/')) {
    base = new URL(base, new URL(url, document.baseURI)).href;
  }
  const names = {};
  for (const key of Object.keys(json)) {
    if (key === '_base') continue;
    names[key] = resolveEntry(json[key], base);
  }
  return { base, names };
}

/**
 * Parse a user-typed pack reference into the pieces both engines need.
 * Accepts:
 *   - `github:user/repo` or `github:user/repo/branch`
 *   - a bare `user/repo`
 *   - a direct URL to a strudel.json (or a directory containing one)
 * Returns `{ strudelArg, manifestUrl, id, label }`:
 *   - `strudelArg` is handed straight to Strudel's `samples()` (it understands
 *     the `github:` shorthand natively);
 *   - `manifestUrl` is the resolved strudel.json the sequencer fetches itself.
 */
export function parsePackSpec(input) {
  const raw = (input || '').trim();
  if (!raw) return null;
  const gh = raw.startsWith('github:') ? raw.slice(7) : (/^[\w.-]+\/[\w.-]+(\/[\w.-]+)?$/.test(raw) ? raw : null);
  if (gh) {
    const [user, repo, branch] = gh.split('/');
    if (!user || !repo) return null;
    // Hand Strudel the spec as documented — bare `github:user/repo` when no
    // branch is given (Strudel resolves the default), branch-qualified otherwise.
    // The sequencer fetches the raw manifest itself; with no branch it tries
    // `main` then `master` (the two common defaults) so more packs resolve.
    const raw0 = (b) => `https://raw.githubusercontent.com/${user}/${repo}/${b}/strudel.json`;
    const manifestUrls = branch ? [raw0(branch)] : [raw0('main'), raw0('master')];
    return {
      strudelArg: branch ? `github:${user}/${repo}/${branch}` : `github:${user}/${repo}`,
      manifestUrls,
      manifestUrl: manifestUrls[0],
      id: `ext:${user}/${repo}`,
      label: repo,
    };
  }
  // A direct URL: a .json is the manifest; a directory gets /strudel.json.
  let manifestUrl = raw;
  if (!/\.json($|\?)/i.test(manifestUrl)) {
    manifestUrl = manifestUrl.replace(/\/?$/, '/') + 'strudel.json';
  }
  let label = manifestUrl;
  try { label = new URL(manifestUrl, 'https://x/').pathname.split('/').filter(Boolean).slice(-2, -1)[0] || 'pack'; } catch {}
  return { strudelArg: manifestUrl, manifestUrls: [manifestUrl], manifestUrl, id: `ext:${manifestUrl}`, label };
}

/**
 * Shape a resolved manifest for Strudel's `samples()` — it accepts a map of
 * `{ name: url | url[] | { note: url } }`. Absolute URLs need no base, so we
 * pass them straight through (Strudel concatenates an empty base).
 *
 * `prefix` namespaces the names so registration is purely ADDITIVE — without it,
 * a pack named `bd`/`sd`/`hh` would clobber Strudel's built-in drum banks. With
 * `prefix = 'lofi_'` the sounds register as `lofi_bd`… , so both
 * `s("lofi_bd lofi_sd")` and the idiomatic `s("bd sd").bank("lofi")` work while
 * the stock `bd`/`sd` banks stay intact.
 */
export function toStrudelSampleMap(resolved, prefix = '') {
  const src = resolved?.names || {};
  if (!prefix) return src;
  const out = {};
  for (const name of Object.keys(src)) out[prefix + name] = src[name];
  return out;
}
