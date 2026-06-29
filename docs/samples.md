# Samples & sequencer kits

How sounds are shared between **Strudel** and the **sequencer**, the kit system,
the bundled signature packs, and how to add your own / pull in free sample packs.

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
  `@strudel/repl` bundle has loaded. It resolves every bundled pack and hands the
  name→URL maps to the global `samples()` the bundle exposes (same path as
  `getAudioContext` / `superdough` / `soundMap`). Registration is **additive** —
  each pack is namespaced with a `<genre>_` prefix so it never clobbers Strudel's
  stock `bd`/`sd`/`hh` banks. Play a pack as `s("metal_bd metal_sd")` or
  idiomatically with `s("bd sd hh").bank("metal")`. Decoding is lazy (on first
  play), so this is cheap at audio decode time even when the manifest embeds
  offline data URLs.
- **Sequencer side** — `createSampleKit({ manifestUrl, voiceMap })` in
  `sequencer-voices.js` resolves the same manifest, fetches + `decodeAudioData`s
  each mapped sample into a Tone `AudioBuffer`, and plays per-hit
  `ToneBufferSource`s. `voiceMap` maps the sequencer's stable voice ids
  (`kick`, `snare`, `hat-c`, …) onto manifest sample names (`bd`, `sd`, `hh`, …).

The single shared list `BUNDLED_PACKS` (in `samples-manifest.js`) is what both
sides enumerate, so there's no chance of them drifting apart.

---

## Kits (the sequencer's instruments)

A **kit** is the instrument the sequencer pads play through. Every kit speaks the
same voice ids, so a groove re-voices onto any kit without touching the grid.
Kits live in `sequencer-kits.js` and are picked from the **kit** dropdown in the
sequencer's settings pane (grouped by genre, synth/samples under each). Switching
is live (no play/stop).

Each genre family ships in **two variants**:

| Family | What it is |
|---|---|
| **voidstar** | Clean, punchy 808/909 — the original default. |
| **lofi** | Warm, filtered boom-bap / chillhop. |
| **tape** | Saturated cassette character — mellow, rolled-off, dusty. |
| **dub** | Heavy dubstep — deep sub kick, huge snare, wide space (San Holo / Com Truise). |
| **jazz** | Clean modern-jazz kit — soft, brushed, ride-forward. |
| **metal** | Tight, aggressive metal — clicky kick, cracking snare (Pantera / Metallica / Gojira). |
| **death** | Extreme death metal — ultra-tight kick, pingy snare (Suffocation / Devourment). |
| **hiphop** | Dusty Dilla-style boom-bap. |

- **synth** variant — a Tone.js synth factory (offline, zero-network, always
  available). `voidstar` and `lofi` are hand-written (`createKit` /
  `createLofiKit`); the rest are data-driven specs fed to `createSynthKit`.
- **samples** variant — decoded one-shots from the bundled `strudel.json` pack of
  the same genre (`createSampleKit`), the same files Strudel registers, playable
  in the REPL as `s("bd sd hh").bank("<genre>")`.

Synth kits are zero-network and always work. Sample kits load asynchronously and
degrade gracefully — an unmapped or not-yet-decoded voice is simply silent.

**Per-pattern kit.** The selected kit is saved on the pattern model (`kitId`), so
a recalled or downloaded `.seq.json` (and a `.qualem` snapshot) restores its
instrument. The last-used kit (`voidstar.qualia.sequencer.kit`) seeds fresh
patterns; an unknown id normalises back to the default.

---

## The bundled signature packs

`scripts/gen-samples.mjs` is a **dependency-free** Node generator that renders one
original drum pack **per genre** with pure math — no recordings, no downloaded
libraries, no uncleared samples. The generated one-shots are therefore
CC0-clean/project-local and deterministic.

```
npm run gen:samples              # → node scripts/gen-samples.mjs
npm run gen:samples -- --wavs    # also write loose WAV audition files
```

By default the generator writes 16-bit / 22.05 kHz mono WAV payloads as
`data:audio/wav;base64,…` entries inside each
`public/samples/<genre>/strudel.json`. This keeps the manifest as the committed
source of truth and works with both engines because `resolveManifest()` treats
`data:` URLs as already-resolved sample URLs. Passing `--wavs` writes matching
loose WAV files beside the manifests for auditioning or editing, but the app
loads from the manifests.

Current pack character:

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

The pack list lives in `BUNDLED_PACKS` (`samples-manifest.js`); both engines key
off it. If you add a new bundled pack, add a folder under `public/samples/`, add
its id to `BUNDLED_PACKS`, and add/retune the corresponding family in
`sequencer-kits.js` if it should appear in the kit picker.

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
