# The qualia code API — live-coding the whole instrument

`globalThis.qualia` is the programmatic control surface for everything on the
`/qualia` page: quales (visualizers), their params and presets, the top-level
effects (overlay layers, glitch posts, logo, camera walk), phase/cycle
automation, camera + pose, audience entanglement, and the audio engines
(mixer, Strudel transport, sequencer, looper/rig, vox). It exists so a set can
be *coded* — from the Strudel editor, the browser console, or anything else
with page access (MIDI handlers, the tether remote).

The same reference is searchable in the Strudel panel's **funcs** tab (search
"qualia"), and `qualia.help('cam')` prints it filtered to the console.

Implementation: [`src/lib/qualia/code-api.js`](../src/lib/qualia/code-api.js)
(installed by `page-init.js` with handles to every engine). The dataset behind
the funcs tab + `help()` is
[`src/data/qualia-functions.json`](../src/data/qualia-functions.json).

---

## Strudel pattern functions

Once the Strudel REPL has booted, the code API registers **first-class Strudel
functions** through Strudel's own `register()`, so they mini-notate, chain,
and transform (`.slow()`, `.euclid()`, `.sometimesBy()`, …) like stock
functions.

All the `q*` lane functions are **silent control lanes** — they produce no
audio and are meant to sit inside `stack(...)` next to your sound. Each event
fires at its *audible* time (latency-corrected), so visual changes land on the
beat you hear.

```js
setcps(0.5)
stack(
  s("bd*4"),
  s("~ hh ~ hh").gain(.7),

  quale("<chladni fractal galaxy>").slow(8),      // switch quale every 8 cycles
  qset("reactivity", sine.range(0.5, 2).segment(16)), // ride a param from a signal
  qset("palette", "<violet cyan>").slow(4),
  qpreset("<default punchy>").slow(16),
  qphase("1").slow(4),                             // phase step every 4th cycle
  qglitch("mosh", "<off off on flip>").slow(2),
  qcall(v => qualia.cam.walk(v > 0), "<0 1>").slow(8), // anything, per event
)
```

| Function | Semantics |
|---|---|
| `quale(pat)` | Switch the active quale per event (fuzzy id/name). Honors transition style + cycle quantize. |
| `qset(paramId, pat)` | Set an **active-quale** param per event. Continuous signals need `.segment(n)`. |
| `qpreset(pat)` | Apply factory/user presets by name per event. |
| `qphase(pat)` | Step the quale's phase per event (value = direction ±1). |
| `qglitch(name, pat)` | Set a glitch post's mode per event (`ascii/mosh/edge/stitch/negative` × `off/on/blip/flip`). |
| `qcall(fn, pat)` | Call `fn(value, hap)` per event — the generic escape hatch. |
| `pat.qtrig(fn)` | **Chainable, keeps the audio**: fires `fn(value, hap)` on each event of the pattern it's chained to — `s("bd*4").qtrig(() => qualia.phase())`. |

A param that has audio/pose modulators declared keeps them: `qset` writes the
*base* value and the modulation engine still resolves `base ⊕ modulators`
per frame — so patterns and audio-reactivity compose instead of fighting.

## The `qualia` object

Convention: every knob is one function — **no args reads, an arg writes**, and
the applied value is returned either way. Failures warn to the console and
never throw (a typo mid-set must not kill the scheduler).

### Quales & params

```js
qualia.quales()                    // [{id, name}] in dropdown order
qualia.quale()                     // active id
qualia.quale("singularity")        // switch (fuzzy match, transition + quantize)
qualia.nextQuale(); qualia.prevQuale(); qualia.randomQuale()

qualia.params()                    // active quale's param specs
qualia.set("thickness", 0.7)       // set one param on the active quale
qualia.set({ palette: "cyan", speed: 2 })
qualia.get("thickness")            // live RESOLVED value (base ⊕ modulators)
qualia.setParam(fxId, paramId, v)  // original explicit-target form (kept)

qualia.preset()                    // {factory: [...], user: [...]} names
qualia.preset("punchy")            // apply either kind
qualia.savePreset("live-set-1")    // snapshot current sliders as a user preset
```

### Phase / cycle / transitions

```js
qualia.phase()                     // step phase (+1); qualia.phase(-1) back
qualia.autoPhase(10, "random")     // seconds (0=off), style: sequential|palettes|random
qualia.autoCycle(30, "random")     // quale auto-swap; sequential|random|progressive
qualia.transition("wipe", 1200)    // cut | dissolve | wipe, duration ms
qualia.quantize("cycle")           // scene changes land on the Strudel downbeat
```

### Top-level effects & stage state

```js
qualia.overlay("skeleton", true)   // skeleton | sparks | aura | ripples
qualia.sparkStyle("emmons")        // dots | emmons | shobud
qualia.glitch("mosh", "flip")      // modes: off | on | blip | flip
qualia.mosh({ intensity: .8 })     // tunables; also qualia.edge / qualia.stitch
qualia.logo(true); qualia.logoConfig({ caption: "voidstar" })
qualia.blackout(true)              // screen dark, audio keeps running
qualia.zen(true)                   // hide UI chrome
qualia.pause(true)                 // brake visuals + transports
qualia.fullscreen(true)
qualia.theme("phosphor")           // qualia.themes() lists; cycleTheme(±1)
```

### Live signal reads (for conditionals)

```js
qualia.CHANNELS                    // every modulator source id
qualia.channel("audio.bass")       // one channel, 0..1
qualia.channels()                  // full snapshot
qualia.bands()                     // {bass, mids, highs, total}
qualia.crowd()                     // audience aggregate {x, y, energy, ...}
```

### Camera & pose

```js
qualia.cam.walk(true)              // camera-walk drift on/off
qualia.cam.walkConfig({ zoom: .8, punch: .6 })
qualia.cam.source("camera")        // webcam feed on ("off" stops it)
qualia.cam.rotate(90); qualia.cam.mirror(true); qualia.cam.flip()
qualia.cam.zoom(2)                 // hardware zoom where supported

qualia.pose.smoothing(0.7)
qualia.pose.poses(2)               // tracked people 1..6
qualia.pose.thresholds({ detect: 0.1 })
qualia.pose.linger(1200)           // ms a vanished pose lingers
qualia.pose.fps(15)                // inference throttle
qualia.pose.people()               // currently tracked count
```

### Entanglement (audience)

```js
qualia.entangle.open()             // open a room (returns {roomId, joinUrl})
qualia.entangle.mode("vote", true) // pose | param | vote | phase | skeleton
qualia.entangle.autoVote(true)
qualia.entangle.whitelist("hue")   // toggle a crowd-drivable param
qualia.entangle.peers(); qualia.entangle.room(); qualia.entangle.close()
```

### Audio engines

```js
qualia.audio.mode("mix")           // off | mic | mix | all (reactivity source)
qualia.audio.preset("metal")       // default|ambient|acoustic|edm|metal
qualia.audio.tunables({ ema: .4 }) // {gain, ema, thresh, cooldown}
qualia.audio.levels(); qualia.audio.clipping()

qualia.mixer.setLevel("strudel", .7)   // 'mic'|'rig'|'strudel'|'seq'|'vox'
qualia.mixer.setMuted("seq", true); qualia.mixer.setLimiter("vox", true)

qualia.strudel.play(); qualia.strudel.stop(); qualia.strudel.playing()
qualia.strudel.cps(0.6)            // the shared clock (sequencer follows)
qualia.strudel.volume(1.2); qualia.strudel.mute(true); qualia.strudel.limiter(true)

qualia.seq.play(); qualia.seq.cps(0.5); qualia.seq.kit("metal")
qualia.seq.genre("metal"); qualia.seq.source("sig"); qualia.seq.random()
qualia.seq.clear()                 // wipe the pattern (one undoable edit)
qualia.seq.undo(); qualia.seq.redo()   // tap-write / clear history
qualia.seq.pattern()               // current pattern model (snapshot)

qualia.looper.play(); qualia.looper.record(); qualia.looper.grab()
qualia.looper.freeze(); qualia.looper.freezePop(); qualia.looper.freezeClear()
qualia.looper.rigLevel(.8); qualia.looper.rigMute(false)

qualia.rig.toggle("delay")         // flip a pedalboard stage
qualia.rig.param("reverb", "mix", .5)

qualia.vox.start(); qualia.vox.mute(true); qualia.vox.output(1.2)
qualia.vox.harmony(true)           // harmonizer on/off
```

### Snapshots & perf

```js
qualia.qualem.save("drop section")       // whole-scene snapshot → saved list
await qualia.qualem.recall("drop section")
qualia.qualem.list()

qualia.perf.fps(30)                // viz frame cap (0 = uncapped; 1–5 = strobe)
qualia.perf.dpr(1.0)               // GPU lever
qualia.perf.reactFps(48); qualia.perf.reactSmooth(0.5)
```

The pre-existing flat knobs (`setParam`, `getField`, `setReactFps`,
`setDprCap`, `setStrudelLatency`, `setStrudelEditorPerf`, the editor font/line
toggles, `mixer.*`) all still exist unchanged.

---

## Discoverability

- **funcs tab**: the Strudel panel's funcs search includes every entry above
  under the `qualia*` categories — search "qualia", "glitch", "cam", etc.
- **console**: `qualia.help()` prints the whole reference; `qualia.help("seq")`
  filters.
- **autocomplete**: Strudel's built-in editor intellisense is generated from
  its bundled doc.json and is not extensible from outside the CDN bundle, so
  the `q*` functions don't appear in the popup completions. The funcs tab and
  `help()` are the canonical reference instead.

## Design notes / caveats

- **UI stays in sync.** Every setter goes through the same code path as the
  corresponding UI control (select handlers, preset buttons, sliders), so the
  chrome repaints and the change persists to localStorage exactly as if
  clicked.
- **Trusted-performer surface.** Like `setParam` before it, values are clamped
  by the receiving engines but not validated here; nothing is reachable
  remotely.
- **`qualia.*` calls are imperative, not patterns.** Dropping
  `qualia.nextQuale()` straight into `stack(...)` runs it once at eval time
  and hands its *return value* (an id string, or null) to `stack` — the null
  kills the whole pattern's query loop, and `.slow()` on it throws. To fire
  an API call rhythmically, wrap it in a lane:
  `qcall(() => qualia.nextQuale(), "1").slow(16)`. Only the seven registered
  functions (`quale`/`qset`/`qpreset`/`qphase`/`qglitch`/`qcall`/`qtrig`)
  belong in `stack(...)`.
- **Controls chained on the enclosing stack are fine.** `stack(...).room(.5)`
  unions every hap value into a control object, tucking a lane's plain value
  under the `value` key — lanes unwrap that before applying, so
  `quale("<chaos wake>")` still sees `chaos`, not `[object Object]`.
- **Silent lanes are dominant `onTrigger` patterns.** Stopping the pattern
  stops the lane; there is no state to clean up. `qtrig` is the only
  non-dominant (audio-keeping) binding.
- **Timing**: lane callbacks are deferred by the scheduler's lookahead
  (`targetTime − currentTime`) so effects land on the audible beat. Quale
  switches additionally respect `qualia.quantize("cycle")`.
- **`qualia.audio.mode()` is async on set** (may open the mic); it returns the
  previous mode synchronously — read it back a moment later if you need
  confirmation.
