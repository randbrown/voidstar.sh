# Live coding — Strudel, Hydra & the param bridge

How the live-coding surface works and how pattern code reaches the visuals. Read
[`architecture.md`](architecture.md) §1 and §4 for where this sits in the stack.

All paths under `src/lib/qualia/`.

---

## What's here

The live-coding surface is **~95% Strudel, ~5% Hydra**:

- **Strudel** (the JS port of TidalCycles) is the audio live-coding language. It runs as a
  `<strudel-editor>` web component, loaded from CDN at runtime.
- **Hydra** is a live-coding *visual synthesizer*. It's initialized as page globals (not in this
  module); the qualia side just feeds it `globalThis.a.fft` and clears its outputs on demand.
- The fx engine is itself a visual synth — but it's driven through params/modulation, not Hydra
  code. Hydra composites *underneath* the fx canvas via CSS `mix-blend-mode: screen`.

`strudel-hydra.js` (`createStrudelHydra`, the sole export) embeds the REPL, taps its audio into the
app analyser, exposes the live-code → fx bridge, and provides transport / mixer / cyclist-probe /
pattern persistence. `strudel-reference.js` is just a curated dataset for the functions help tab.

---

## The audio tap

Strudel's audio is **superdough → `ctx.destination`** (Tone.js is only peripherally involved — a
belt-and-braces destination mute). To both control and analyze it, the module installs a
**permanent global monkey-patch of `AudioNode.prototype.connect`**: anything connecting to
`ctx.destination` is rerouted through a mute-gate → limiter, and a 2048-FFT analyser is teed off the
post-mute node and handed to `audio.adoptAnalyser(... 'strudel')`. That analyser is what makes
Strudel patterns drive the visuals.

> This patch is global and is **never torn down** (see Caveats). The sequencer and looper cooperate
> with it by tagging their output nodes `__qualiaBypassMute` so the mute-gate skips them.

---

## The live-code → fx bridge

`globalThis.qualia.setParam(fxId, paramId, value)` → `core.setParam(...)`. This is the public
surface for driving visuals from a Strudel pattern. Param ids are the fx's `params[].id` (also the
localStorage keys), so they're a small stable public API — choose them like one.

Because modulation resolves audio/pose/crowd into `field.params` each frame, a pattern that targets
a modulated param gets the audio-reactive curve for free. (See [`README.md`](../src/lib/qualia/README.md)
and `modulation.js`.)

There is also `globalThis.a` for Hydra (`a.fft[]` etc.), refreshed by `strudel.perFrame`.

---

## Cycle clock / sync

`getScheduler()` reads `repl.scheduler` and supports both Strudel scheduler variants (h3 and
neocyclist) in `probeStrudelState`. It computes latency-corrected audible cycle boundaries, which is
what the sequencer and looper sync against (they consume relative `(boundary − pos)/cps` durations).
The current CPS is surfaced to the timer HUD (`chron.js`) and the sequencer.

---

## Caveats & known issues (see `plans/maintenance-backlog.md`)

`strudel-hydra.js` is the most fragile module in the tree:

- **Strudel is loaded from CDN, pinned** (`STRUDEL_VERSION` in `strudel-hydra.js`) — bump it
  deliberately and re-test a set; much of the code is fallback paths against version drift.
- **Global `fetch` patch for sample manifests** — Strudel's prebake fetches its default banks from
  `raw.githubusercontent.com` with no `res.ok` check or retry, and GitHub raw serves 404/429 as
  plain text, so a venue-network blip used to surface as
  `SyntaxError: Unexpected non-whitespace character after JSON at position 3` with the bank silently
  missing for the whole set. `installManifestFetchRetry()` wraps `globalThis.fetch` to retry `.json`
  GETs on that host with backoff. Like the connect patch, it's global and never torn down.
- **No disposal path at all** — the connect-patch, the manifest-fetch patch, document/window
  listeners, two ResizeObservers, the ~8 s auto-save interval, the tap-poll interval, and the audio
  nodes all leak for the page lifetime. Module-global mutable state would clash if instantiated twice.
- **`perFrame` is misnamed/miswired:** `strudel.perFrame` (the Hydra `a.fft` refresh) is wired on
  `core.onFps` (~5 Hz), so `a.fft`-driven Hydra visuals update at ~5 fps despite the name. Either
  rename it or rewire to `onFrame`/`onTick`.
- The `setParam` bridge is an **unvalidated** pass-through (acceptable for a trusted local performer;
  note it if the surface ever becomes remotely reachable).

**Performance lever:** the editor's "perf mode" (disable per-frame pattern highlighting + eval
flash) is the single biggest main-thread saving during a set — default it on in performance
contexts. The viz framerate is already lowered via `setAuxFps` while editors are open (see
architecture §4).
