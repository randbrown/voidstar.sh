# Samples & sequencer kits

How sounds are shared between **Strudel** and the **sequencer**, the kit system,
the bundled synthetic packs, and how to add your own / pull in free sample packs.

Read [`looper-and-sequencer.md`](looper-and-sequencer.md) for the sequencer
itself and [`livecoding.md`](livecoding.md) for the Strudel embed.

All paths under `src/lib/qualia/` unless noted.

---

## The shared format: Strudel `strudel.json`

Both engines load the **same** manifest format — Strudel's
[`strudel.json`](https://strudel.cc/learn/samples) — so a pack is defined once
and plays in either place. A manifest maps **sample names** to files, with an
optional base URL:

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
- **root-relative** (`/samples/…/`) — a pack bundled in `public/`, the case for
  voidstar's own packs;
- **relative** (`./`, `drums/`) — resolved against the manifest URL's directory.

`samples-manifest.js` (`resolveManifest(url)`) fetches a manifest and resolves
every path to an absolute URL using the same concatenation rules superdough
uses, so all three base styles resolve identically in both engines.

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
  `@strudel/repl` bundle has loaded. It resolves the bundled pack and hands the
  name→URL map to the global `samples()` the bundle exposes (same path as
  `getAudioContext` / `superdough` / `soundMap`). Registration is **additive** —
  names are namespaced with a `lofi_` prefix so they don't clobber Strudel's
  stock `bd`/`sd`/`hh` banks. Play them as `s("lofi_bd lofi_sd lofi_hh")` or
  idiomatically with `s("bd sd hh").bank("lofi")`. Decoding is lazy (on first
  play), so this is cheap at load.
- **Sequencer side** — `createSampleKit({ manifestUrl, voiceMap })` in
  `sequencer-voices.js` resolves the same manifest, fetches + `decodeAudioData`s
  each mapped sample into a Tone `AudioBuffer`, and plays per-hit
  `ToneBufferSource`s. `voiceMap` maps the sequencer's stable voice ids
  (`kick`, `snare`, `hat-c`, …) onto manifest sample names (`bd`, `sd`, `hh`, …).

The single shared constant `VOIDSTAR_LOFI_PACK_URL` (in `samples-manifest.js`)
is what both sides point at, so there's no chance of them drifting apart.

---

## Kits (the sequencer's instruments)

A **kit** is the instrument the sequencer pads play through. Every kit speaks the
same voice ids, so a groove re-voices onto any kit without touching the grid.
Kits live in `sequencer-kits.js`; the selected kit persists across reloads
(`voidstar.qualia.sequencer.kit`) and is picked from the **kit** dropdown in the
sequencer's settings pane. Switching is live (no play/stop).

| Kit | Type | What it is |
|---|---|---|
| `default · synth` | synth | The original 808/909-flavoured Tone.js kit. Clean, punchy, always available offline. **Unchanged.** |
| `lofi · synth` | synth | Warm, filtered, tape-flavoured synthesis (low-pass blanket → light bit-crush → roomy reverb; softer, lower-tuned voices). Boom-bap / chillhop feel. |
| `lofi tape · samples` | sample | The bundled synthetic lofi one-shots, loaded from the shared `strudel.json` — the same sounds Strudel plays via `s("bd sd hh")`. |

Synth kits are zero-network and always work. Sample kits load asynchronously and
degrade gracefully — an unmapped or not-yet-decoded voice is simply silent.

---

## The bundled synthetic packs

`scripts/gen-samples.mjs` is a **dependency-free** Node generator that
synthesises lofi drum one-shots with pure math (no recordings → tiny, CC0-clean,
deterministic) and writes them as 16-bit/22.05 kHz mono WAVs plus a
`strudel.json` to `public/samples/voidstar-lofi/`. Lofi character comes from the
low sample rate + sample-rate reduction + bit-crush + soft saturation + a touch
of hiss, applied as a shared finishing chain so the kit reads as one instrument.

```
node scripts/gen-samples.mjs     # regenerate after editing voice recipes
```

The whole pack is ~150 KB, so it's committed and served statically — the sample
kit and Strudel's `s("bd sd hh lt mt ht rd cr oh rim").bank("lofi")` work offline
out of the box. Re-run the script and commit the regenerated WAVs + json after
edits.

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

To bundle it instead (offline, no network dependency), drop the WAVs +
`strudel.json` under `public/samples/<pack>/` and use a root-relative
`manifestUrl` (`/samples/<pack>/strudel.json`). Remember the
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
  [Erokia's CC0 electronic samples](https://freesound.org/people/Erokia/packs/26717/)
  and [Stereo Surgeon's CC0 drum loops](https://freesound.org/people/Stereo%20Surgeon/packs/16043/).
  Download, host (or bundle), add a `strudel.json`.
- **Community strudel packs** — discoverable via
  [open-strudel-samples](https://github.com/therebelrobot/open-strudel-samples)
  (an explorer for GitHub-hosted strudel sample packs).
- **Royalty-free lofi kits** (not CC0 — check terms): BVKER "Lunar", Clark Audio
  free lofi kit, and the roundups at hiphopmakers / cymatics.fm.

> Tip: a GitHub repo of folders-of-wavs can auto-generate its `strudel.json` with
> the official `@strudel/sampler` action (each subfolder becomes a sample name).
