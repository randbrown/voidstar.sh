# voidstar bundled sample collections

These are the offline sample variants for the qualia sequencer kits and Strudel
banks. A **collection** is a full bank — one pack per genre — and the sequencer
can swap the whole bank at once for A/B (see `src/lib/qualia/samples-manifest.js`
→ `COLLECTIONS`, and `docs/samples.md`).

```
public/samples/
  signature/<genre>/strudel.json    # default — data: URLs, manifest is the source of truth
  voidstar_0/<genre>/{*.wav, strudel.json}   # original baseline — loose WAVs + relative _base
```

`<genre>` is one of: voidstar, lofi, tape, dub, jazz, metal, death, hiphop.

## Provenance / license

Every pack is an original, deterministic one-shot rendered by pure synthesis —
no recordings, no third-party sample libraries — so they are CC0-clean for
project use and safe to ship with the static site.

- `signature`  → `scripts/gen-samples.mjs`
- `voidstar_0` → `scripts/gen-samples-voidstar0.mjs`

## Format

Each `strudel.json` uses Strudel's standard sample-map keys and the same voice
contract across both collections:

- `bd` kick
- `sd` snare
- `rim` rimshot / clap
- `hh` closed hat
- `oh` open hat
- `lt`, `mt`, `ht` low / mid / high tom
- `rd` ride
- `cr` crash

All audio is 16-bit, 22.05 kHz mono. `signature` embeds it as
`data:audio/wav;base64,…` URLs (`resolveManifest()` treats `data:` URLs as
absolute, so both engines decode the exact same offline sounds); `voidstar_0`
ships loose `.wav` files referenced by a root-relative `_base`.

## Regenerating

```
npm run gen:samples         # signature   (add `-- --wavs` for loose audition WAVs)
npm run gen:samples:v0      # voidstar_0
npm run gen:samples:all     # both
```
