# voidstar bundled sample packs

These are the offline sample variants for the qualia sequencer kits and Strudel
banks listed in `src/lib/qualia/samples-manifest.js`.

## Provenance / license

The current packs are original, deterministic one-shots rendered by
`scripts/gen-samples.mjs`. They do not contain recordings or third-party sample
libraries, so they are CC0-clean for project use and safe to ship with the static
site.

## Format

Each `public/samples/<genre>/strudel.json` uses Strudel's standard sample map
keys:

- `bd` kick
- `sd` snare
- `rim` rimshot / clap
- `hh` closed hat
- `oh` open hat
- `lt`, `mt`, `ht` low / mid / high tom
- `rd` ride
- `cr` crash

The manifest values are `data:audio/wav;base64,...` URLs containing short 16-bit,
22.05 kHz mono WAV one-shots. `resolveManifest()` treats `data:` URLs as absolute,
so both Strudel and the sequencer decode the exact same sounds while staying
fully offline.

Run `npm run gen:samples` after editing the generator profiles. Add `-- --wavs`
to also write loose WAV audition files beside the manifests; the manifests remain
the source of truth used by the app.
