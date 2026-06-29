# Samples & sequencer kits

How sounds are shared between **Strudel** and the **sequencer**, the kit system,
the bundled collections, and how to add your own / pull in free sample packs.

Read [`looper-and-sequencer.md`](looper-and-sequencer.md) for the sequencer
itself and [`livecoding.md`](livecoding.md) for the Strudel embed.

All paths under `src/lib/qualia/` unless noted.

---

## The shared format: Strudel `strudel.json`

Both engines load the **same** manifest format — Strudel's
[`strudel.json`](https://strudel.cc/learn/samples) — so a pack is defined once
and plays in either place. A manifest maps **sample names** to files or URLs,
with an optional base URL:

```json
{
  "_base": "https://host/path/",   // prefixed to every relative path (optional)
  "bd":  "kick.wav",                // single sample        → s("bd")
  "sd":  ["sd1.wav", "sd2.wav"],    // variations           → s("sd:0 sd:1")
  "piano": {                        // pitched map (note → file)
    "_base": "piano/",              // optional, stacks onto the pack base
    "c4": "c4.wav", "e4": "e4.wav"  // Strudel pitch-shifts to fill the gaps
  }
}
```

`_base` may be:

- **absolute** (`https://…/`) — a remote pack, e.g. one copied from GitHub;
- **root-relative** (`/samples/…/`) — a pack bundled in `public/`;
- **relative** (`./`, `drums/`) — resolved against the manifest URL's directory.

A sample value may also be a complete `data:audio/wav;base64,…` URL. The bundled
voidstar packs currently use that form so the committed `strudel.json` is the
one offline source of truth. `samples-manifest.js` (`resolveManifest(url)`) treats
`data:` URLs as absolute and resolves every other path using the same
concatenation rules superdough uses, so all base styles resolve identically in
both engines.

---

## How the two engines share a pack

```
                         public/samples/<pack>/strudel.json
                          (one manifest, one source of truth)
                                       │
                 ┌─────────────────────┴──────────────────────┐
        resolveManifest()                              resolveManifest()
        (strudel-hydra.js)                             (sequencer-voices.js)
                 │                                              │
     globalThis.samples(map)                      fetch → decodeAudioData →
     → playable as s("bd sd hh")                  Tone buffers → a sample kit
        in the Strudel REPL                       the sequencer pads play
```

- **Strudel side** — `strudel-hydra.js` calls `registerSharedSamples()` once the
  `@strudel/repl` bundle has loaded. It resolves every pack of **both bundled
  collections** and hands the name→URL maps to the global `samples()` the bundle
  exposes (same path as `getAudioContext` / `superdough` / `soundMap`).
  Registration is **additive** — each pack registers under a collection-qualified
  `<bank><genre>_` prefix (`sigmetal_`, `v0metal_`), and the **active** collection
  *also* registers under the plain `<genre>_` prefix. So `s("bd sd").bank("metal")`
  plays whatever collection is active, while `.bank("sigmetal")` / `.bank("v0metal")`
  reach a specific one for explicit A/B. None of this clobbers Strudel's stock
  `bd`/`sd`/`hh`. Decoding is lazy (on first play), so this is cheap at load even
  when a manifest embeds offline data URLs.
- **Sequencer side** — `createSampleKit({ manifestUrl, voiceMap })` in
  `sequencer-voices.js` resolves the same manifest, fetches + `decodeAudioData`s
  each mapped sample into a Tone `AudioBuffer`, and plays per-hit
  `ToneBufferSource`s. `voiceMap` maps the sequencer's stable voice ids
  (`kick`, `snare`, `hat-c`, …) onto manifest sample names (`bd`, `sd`, `hh`, …).
  A sample kit is built for a (genre, source) pair from `packUrl(source, genre)`.

Both sides enumerate the collections via `COLLECTIONS` / `collectionPacks()` (in
`samples-manifest.js`), so there's no chance of them drifting apart.

---

## Kits (the sequencer's instruments)

A **kit** is the instrument the sequencer pads play through, modelled as a
**genre × source** pair. Every kit speaks the same voice ids, so a groove
re-voices onto any kit without touching the grid. Kits live in
`sequencer-kits.js` and are picked from **two dropdowns** in the sequencer's
settings pane — **genre** (with ‹ › steppers) and **source**. Switching either
is live (no play/stop).

- **genre** — the voicing (tuning / decay / character):

  | Genre | What it is |
  |---|---|
  | **voidstar** | Clean, punchy 808/909 — the original default. |
  | **lofi** | Warm, filtered boom-bap / chillhop. |
  | **tape** | Saturated cassette character — mellow, rolled-off, dusty. |
  | **dub** | Heavy dubstep — deep sub kick, huge snare, wide space. |
  | **jazz** | Clean modern-jazz kit — soft, brushed, ride-forward. |
  | **metal** | Tight, aggressive metal — clicky kick, cracking snare. |
  | **death** | Extreme death metal — ultra-tight kick, pingy snare. |
  | **hiphop** | Dusty Dilla-style boom-bap. |

- **source** — where the sound comes from for that genre:
  - **synth** — a Tone.js synth factory (offline, zero-network, always there).
    `voidstar`/`lofi` are hand-written (`createKit`/`createLofiKit`); the rest are
    data-driven specs fed to `createSynthKit`.
  - a bundled **collection** (`signature` / `voidstar_0` / `real_0`) — decoded
    one-shots from that collection's pack for the genre (`createSampleKit`), the
    same files Strudel registers, playable in the REPL as `s("bd sd").bank("…")`.
  - a **loaded pack** — any external GitHub/URL pack appears here once loaded.

Switching **source** while keeping the genre is the in-place A/B: same groove,
same voicing, different sound set (synth ↔ signature ↔ voidstar_0 ↔ real_0).
`synth` is just another source, so it's treated uniformly — no separate "is this
synth or samples" toggle. Synth sources are zero-network and always work; sample
sources load asynchronously and degrade gracefully (an unmapped/not-yet-decoded
voice is simply silent).

A kit id encodes the pair: `"<genre>"` for synth, `"<genre>@<collection>"` for a
sample source (e.g. `metal@real_0`); external packs keep their own id. `getKit()`
in `sequencer-kits.js` parses these (and migrates legacy `"<genre>-samples"` ids).

**Per-pattern kit.** The selected kit id is saved on the pattern model (`kitId`),
so a recalled or downloaded `.seq.json` (and a `.qualem` snapshot) restores its
instrument. The last-used kit (`voidstar.qualia.sequencer.kit`) seeds fresh
patterns; a legacy/unknown id normalises back to the default. Choosing a
collection source also sets the **active collection**
(`voidstar.qualia.sequencer.collection`), which is what Strudel's plain
`.bank("<genre>")` resolves to; flip `DEFAULT_COLLECTION_ID` in
`samples-manifest.js` to change the out-of-box default.

---

## The bundled collections

A **collection** is a full bundled bank — one pack per genre, swapped all at once.
Two ship today, each generated by a **dependency-free** Node generator (pure math,
no recordings, no downloaded libraries, no uncleared samples → CC0-clean,
project-local, deterministic):

| Collection | Generator | Layout | Character |
|---|---|---|---|
| **signature** *(default)* | `scripts/gen-samples.mjs` | `public/samples/signature/<genre>/strudel.json` with `data:audio/wav;base64,…` payloads (manifest is the source of truth) | Characterful, intentional synthetic one-shots — the on-brand default. |
| **voidstar_0** | `scripts/gen-samples-voidstar0.mjs` | `public/samples/voidstar_0/<genre>/` loose 16-bit WAVs + a relative-`_base` `strudel.json` | The original synthetic packs — a clean, neutral baseline. |
| **real_0** | `scripts/gen-real-manifests.mjs` | `public/samples/real_0/<genre>/strudel.json` holding **remote URLs** (no binaries committed) | Real recorded drum-machine one-shots — one classic machine per genre. Streams at play time; **needs network**. |

```
npm run gen:samples              # signature  → scripts/gen-samples.mjs
npm run gen:samples -- --wavs    # signature, also write loose WAV audition files
npm run gen:samples:v0           # voidstar_0 → scripts/gen-samples-voidstar0.mjs
npm run gen:samples:all          # both synthetic collections (offline, deterministic)
npm run gen:samples:real         # real_0 → re-resolve remote manifests (needs network)
```

**real_0** is the real-recording counterpart to the synthetic packs, for an
honest A/B. To avoid re-hosting samples we don't own, its committed manifests
reference the audio by URL (the same posture as the in-app GitHub pack loader) —
real one-shots from the TidalCycles/Strudel drum-machine library
([`ritchse/tidal-drum-machines`](https://github.com/ritchse/tidal-drum-machines)).
The genre→machine map lives in `scripts/gen-real-manifests.mjs`; rerun it to
re-resolve filenames or change machines. Because the audio is remote, real_0 is
the one collection that needs network at play time (the sample kit degrades to
silence offline). See `public/samples/README.md` for source/credit.

The two synthetic generators emit 16-bit / 22.05 kHz mono and the same
`bd/sd/rim/hh/oh/lt/mt/ht/rd/cr` voice contract, so a groove A/Bs cleanly between
collections. `signature` embeds its audio as `data:` URLs (works in both engines
because `resolveManifest()` treats `data:` URLs as already-resolved); `voidstar_0`
keeps loose WAVs referenced via a root-relative `_base`.

**Per-voice loudness + headroom.** Both the sequencer's sample kits and Strudel's
`.bank()` apply a single flat gain to every voice, so the one-shots themselves
must carry the mix balance. The `signature` generator levels each voice with
`rmsTarget()` to a `TARGET_RMS_DB` table (loudness, not peak) plus a hard peak
ceiling — two reasons:

- **Balance** — bright, sustained cymbals hold ~10-40× the kick's HF energy, so
  equal *peaks* read far louder; loudness targets put cymbals ~15-18 dB under the
  kick (mirroring the synth kits).
- **Headroom** — peak-normalising every voice to ~0.9 slammed each hit against
  the ceiling, so a kick+tom stack drove the kit limiter and the groove sounded
  squashed. Loudness targets leave the sustained body well below 0 dBFS (kick body
  ~-6 dBFS, RMS ~-13).

`voidstar_0` keeps the simpler peak-normalise + `VOICE_TRIM_DB` approach as the
baseline. Retune `TARGET_RMS_DB` if a voice sits wrong across the board.

**Kick/tom punch.** A decaying sine body is low-crest (~5 dB → reads as hum). The
`signature` kick/tom add a short, bright attack transient *after* the saturation
stage (so it isn't flattened), scaled to a multiple of the body peak so it becomes
the loudest sample — raising crest to ~10-11 dB. Crest is gain-invariant, so the
later `rmsTarget()` keeps the punch; the transient dial is `k.atk` / `t.atk`.

**Cymbal/hat timbre.** The signature hats/ride/crash are built from a dense
inharmonic partial cluster (`metalCluster()`) plus shaped noise + an attack
chiff, rather than a few clean sines over white noise — much closer to real metal
and far less "synthetic". `voidstar_0` keeps its original simpler synthesis as the
baseline. For genuinely real cymbals, switch to the `real_0` collection.

Signature pack character:

| Pack | Sample voice |
|---|---|
| **voidstar** | Neon-clean 808/909: round sub kick, crisp snare, glassy ride/crash. |
| **lofi** | Warm boom-bap: thick low kick, velvet hats, sampler dust and soft clipping. |
| **tape** | Cassette-smudged: rolled highs, rounded transients, hissy tails. |
| **dub** | Halftime weight: long sub kick, cavern snare, smoky metallic cymbals. |
| **jazz** | Brushed kit: soft kick, rattle/brush snare, woody toms, ride-forward cymbal. |
| **metal** | Tight modern metal: hard beater click, cracking snare, bright tight cymbals. |
| **death** | Triggered extreme kit: surgical kick, pingy snare, clipped-fast cymbal voices. |
| **hiphop** | SP-style Dilla dust: thick lows, vinyl snap snare, softened hats. |

Collections live in `COLLECTIONS` (`samples-manifest.js`); `collectionPacks(id)`
enumerates one collection's packs and both engines key off it. To add a
collection: add a generator that writes `public/samples/<id>/<genre>/strudel.json`
for every genre, add a `{ id, label, bank, desc }` entry to `COLLECTIONS` (the
`bank` token must be unique), and it shows up in the sequencer's collection
dropdown and as `.bank("<bank><genre>")` in Strudel automatically.

---

## One-click GitHub pack loader

The sequencer settings pane has a **pack loader** — a text field + genre preset
chips — that pulls an external Strudel pack into **both engines** at once:

- registers it in Strudel (so `s("name")` / `.bank()` work in the REPL), and
- adds a runtime **sequencer sample kit** (best-effort name matching via
  `EXTERNAL_VOICE_MAP`, since external packs use names like `sn`/`cp`), then
  selects it.

Loaded packs persist (`voidstar.qualia.sequencer.extPacks`) and reappear under a
**loaded** group in the kit picker on reload. Type any `github:user/repo`
(optionally `/branch`) or a direct `strudel.json` URL, or tap a preset:

Presets are deliberately **single-shot** packs (no drum-break / loop packs — a
loop played as a one-shot just runs away on the pads):

| Chip | Pack | Note |
|---|---|---|
| lofi | `github:eddyflux/crate` | lo-fi one-shots |
| hiphop | `github:tidalcycles/Dirt-Samples` | classic hip-hop one-shot hits + drum machines |
| jazz | `github:tidalcycles/Dirt-Samples` | acoustic / jazz one-shots (`jazz`, `jvbass`…) |
| metal | `github:tidalcycles/Dirt-Samples` | metallic / industrial one-shots (`s("metal")`) |
| ambient | `github:klo-e-1/sampls4strudel` | ambient one-shots / textures |

> These are real, public repos chosen as starting points — contents and licenses
> vary per repo, so audition and check terms before using one in a set. The
> Strudel side gets every name; the sequencer maps drum-named samples onto the
> matching pad voices (`bd`→kick, `sn`/`sd`→snare, …) and then **auto-fills** any
> still-empty pads with the pack's remaining single-shot samples (loop/break-named
> entries are skipped — they'd run away as a one-shot), so even a pack that
> doesn't follow the drum convention makes sound on the grid (remap by curating).
> Packs with no branch given are tried on `main` then `master`. Watch the console /
> status line for `loaded N/M` to see how a pack mapped.

---

## Adding your own / pulling in free packs

### Into Strudel (REPL)

Strudel already ships a large library of CC/free banks via its prebake
(`bd sd hh`, `RolandTR808`, `EmuSP12`, the VCSL set, soundfonts, …). To add more:

```js
// A GitHub repo that contains a strudel.json at its root:
samples('github:user/repo')          // → github:user/repo/main
samples('github:user/repo/branch')

// A hosted manifest:
samples('https://host/path/strudel.json')

// Inline map + base:
samples({ bd: 'kick.wav', sd: ['s1.wav','s2.wav'] }, 'https://host/path/')
```

### Into the sequencer too (shared)

To make a pack playable on the sequencer pads as well, add a sample kit in
`sequencer-kits.js` pointing at the **same** manifest URL and mapping voice ids
to that pack's sample names:

```js
{
  id: 'my-pack', label: 'my pack · samples', type: 'sample',
  desc: '…',
  make: () => createSampleKit({
    manifestUrl: 'https://host/path/strudel.json',
    voiceMap: { kick: 'bd', snare: 'sd', 'hat-c': 'hh', /* … */ },
  }),
}
```

To bundle it instead (offline, no network dependency), drop a `strudel.json`
under `public/samples/<pack>/` and reference it with a root-relative
`manifestUrl` (`/samples/<pack>/strudel.json`). The manifest may point at loose
WAVs in that folder or embed short one-shots as `data:` URLs. Remember the
**static-host / degrade-gracefully** rule in `AGENTS.md`: a core performance
feature must not *depend* on a remote pack — keep the synth kits as the offline
fallback.

### Free / open sample sources (verify the license yourself)

Licenses vary per pack and per file — confirm before shipping anything in a set.

- **Strudel's built-in banks** — already loaded; nothing to do. Browse them in
  the sequencer's *sounds* tab / Strudel sounds browser.
- **TidalCycles Dirt-Samples** — the classic live-coding drum/instrument set,
  strudel-ready: `samples('github:tidalcycles/dirt-samples')`.
- **Freesound CC0 packs** — genuinely public-domain one-shots and loops, e.g.
  Erokia's CC0 electronic samples and Stereo Surgeon's CC0 drum loops. Download,
  host (or bundle), add a `strudel.json`, and keep only single hits for the grid.
- **Community strudel packs** — discoverable via `open-strudel-samples`, an
  explorer for GitHub-hosted strudel sample packs.
- **Royalty-free lofi kits** (not CC0 — check terms): BVKER "Lunar", Clark Audio
  free lofi kit, and the roundups at hiphopmakers / cymatics.fm.

> Tip: a GitHub repo of folders-of-wavs can auto-generate its `strudel.json` with
> the official `@strudel/sampler` action (each subfolder becomes a sample name).
