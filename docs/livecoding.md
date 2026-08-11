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

**Panel modes.** Two orthogonal per-panel toggles, both persisted: **ghost** (◌, chrome-strip —
tabs and header extras hide, the frame goes transparent, the code floats over the visuals) and the
**fullscreen editor** (⛶ or `⇧X`; `Esc` or `⇧X` exits). Fullscreen pins the panel to the viewport
edges — geometry only, chrome stays — and its **pad** slider insets every edge (persisted, 0–64 px)
for screen-protector cutoffs; CSS `max()`es the pad against `env(safe-area-inset-*)` so notches
still win. Drag/resize suspend while fullscreen and the pre-fullscreen geometry returns on exit.
Ghost + fullscreen compose: bare code over full-bleed visuals; add `X` (browser fullscreen) and
`Z` (zen) for total immersion.

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

`globalThis.qualia` is the full code-side control surface — quales, params/presets, glitches,
camera/pose, entanglement, set-level fades (`fadeOut`/`fadeIn`), and the audio engines — plus
Strudel-registered pattern functions
(`quale`, `qset`, `qpreset`, `qphase`, `qglitch`, `qtext`, `qcall`, `.qtrig`). Scalar `qualia.*` knobs are
also **patternable**: handed a pattern (in the editor, any double-quoted string) they return a
silent control lane — `qualia.cam.walk("<0 1>/4")` inside `stack(...)` rides the pattern. The
complete reference is [`qualia-code-api.md`](qualia-code-api.md) (module: `code-api.js`, installed
by `page-init.js`); the same docs are searchable in the panel's funcs tab and via `qualia.help()`.

**Microtonal tuning helpers** ride the same registration: `.edo(31)` maps degree patterns of any
N-EDO to raw frequency, `.edoscale("31:c4:0 5 10 13 18 23 28")` plays modes carved from a tuning,
`ji("a3", "1 5:4 3:2 2")` is just intonation (colon ratios — `/` means slow in mini), and
`.cents("<0 -14 14>")` detunes already-pitched values. All emit the `freq` control, which superdough
honors on synths and samples alike. Reference: [`qualia-code-api.md`](qualia-code-api.md), math in
`microtonal.js`.

**Lanes vs. the auto modes.** `quale()` and auto-cycle drive the same knob; `qphase()`, `qpreset()`
and a colliding `qset()` write the same params auto-phase steps. Running both hands one control to
two masters and the visuals stutter between them. The pattern wins: a lane **claims** the wheel on
its first hap that would fight, and the matching timer stands down — via the same setters the topbar
buttons use, so the toggle face flips, the button pulses once, and the remembered dwell survives.
One claim per lane instance (rebuilt on every eval), and deliberately arming a timer voids an
outstanding claim, so the last deliberate act wins. The random-pattern roller closes the loop from
the other side — with a timer running it emits that lane **commented out**, so a fresh roll never
starts a fight. The panel header chips the buffer's live lanes, since the lanes themselves are
silent. `qualia.autoYield(false)` opts out. Details in [`qualia-code-api.md`](qualia-code-api.md).

The original hook, `qualia.setParam(fxId, paramId, value)` → `core.setParam(...)`, is unchanged.
Param ids are the fx's `params[].id` (also the localStorage keys), so they're a small stable
public API — choose them like one.

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
- The `setParam` bridge is an **unvalidated** pass-through (acceptable for a trusted local performer;
  note it if the surface ever becomes remotely reachable).

**Performance lever:** the editor's "perf mode" (disable per-frame pattern highlighting + eval
flash) is the single biggest main-thread saving during a set — the ⚡ button in the panel's tab
bar toggles it (persisted; also `qualia.setStrudelEditorPerf(true)`). The viz framerate is
already lowered via `setAuxFps` while editors are open (see architecture §4), and the engines'
`perFrame` hooks (`a.fft` refresh, sequencer playhead) ride the ~60 Hz reactivity tick.
