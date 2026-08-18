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
  qualia.cam.walk("<0 1>").slow(8),                // patterned knob — walk on/off
  qcall(() => qualia.looper.grab(), "<~ ~ ~ 1>").slow(4), // actions, per event
)
```

| Function | Semantics |
|---|---|
| `quale(pat)` | Switch the active quale per event (fuzzy id/name). Honors transition style + cycle quantize. `"null"` selects the null quale (blank fx layer). Claims **auto-cycle**. |
| `qset(paramId, pat)` | Set an **active-quale** param per event. Continuous signals need `.segment(n)`. Claims **auto-phase** on a colliding param. |
| `qpreset(pat)` | Apply factory/user presets by name per event. Claims **auto-phase**. |
| `qphase(pat)` | Step the quale's phase per event (value = direction ±1). Claims **auto-phase**. |
| `qglitch(name, pat)` | Set a glitch post's mode per event (`ascii/mosh/edge/stitch/negative` × `off/on/blip/flip`). |
| `qtext(pat)` | Write the **Text** quale's text per event (the text video-synth — pair with `quale("text")`). Underscores render as spaces: `qtext("<VOID one_more_time>")`. |
| `qcall(fn, pat)` | Call `fn(value, hap)` per event — the generic escape hatch. |
| `pat.qtrig(fn)` | **Chainable, keeps the audio**: fires `fn(value, hap)` on each event of the pattern it's chained to — `s("bd*4").qtrig(() => qualia.phase())`. |

### Microtonal tuning helpers — 31-TET and beyond

Unlike the silent `q*` lanes, these are **sounding transforms**: they rewrite
pattern values into a raw `freq` control, which superdough honors end-to-end
on synths *and* samples — any tuning, no engine changes. (Upstream Strudel is
growing an `@strudel/edo` package; until the pinned bundle ships it, these
cover the ground, and if a future bundle brings its own `edo` the bundle's
wins automatically.) Math lives in
[`src/lib/qualia/microtonal.js`](../src/lib/qualia/microtonal.js), checked by
`scripts/check-qualia-edo.mjs`.

```js
setcps(0.5)
stack(
  s("bd*4"),
  n("0 8 18 26 31").edo(31).s("sawtooth").decay(.2).gain(.7),   // 31-TET degrees
  ji("a3", "1 5:4 3:2 15:8 2").s("sine").room(.4),              // just intonation
)
```

| Function | Semantics |
|---|---|
| `pat.edo(spec)` | Values are **N-EDO step degrees** → frequency. Spec: divisions + optional root — `31`, `"31:a3"`, `"19:440"` (root defaults to **c4**). Degrees may be negative, exceed N (octaves fold), or be fractional for free bends. |
| `pat.edoscale(spec)` | Values index a **degree subset** of an EDO — a mode carved out of the tuning — wrapping by octave: `n("0 1 2 4 6 7").edoscale('31:c4:0 5 10 13 18 23 28')`. Index 7 of a 7-note subset is the root an octave up; negatives wrap down. |
| `ji(root, pat)` | **Just intonation**: values are frequency ratios against a root (note name or Hz) → `freq`. (Named `ji` because stock Strudel already owns `ratio()`, a plain value→number converter.) Inside mini strings write ratios with a **colon** — `"1 5:4 3:2 2"` — because `/` is the slow operator there; plain JS numbers and `"5/4"` strings work too. |
| `pat.cents(offset)` | Detune **already-pitched** values by cents (the offset itself patterns: `.cents("<0 -14 14>")`). A `freq` scales by 2^(c/1200); a numeric `note`/`n` shifts by c/100 (fractional note numbers play true); note names convert first. Chain it *after* the pitch is resolved. |
| `pat.jitune(spec)` | Retune **already-pitched** values to just intonation — the `chord()`/`voicing()` companion: `chord("<C^7 Dm7 G7>").voicing().jitune("c3").s("piano")`. Each note's pitch class snaps to a 12-ratio table over the root (only the root's pitch *class* matters). Tables: `"c3"` = classic 5-limit (♭7 = 9:5) · `"c3:7"` = septimal (7:5 tritone, 7:4 harmonic seventh) · `"c3:neutral"` (`11`) = **neutral thirds + sevenths** (11:9 ≈ 347¢, 11:6 ≈ 1049¢ — major and minor collapse into the in-between maqam color, so ordinary chord symbols play neutral chords) · `"c3:super"` (`supermajor`) = wide septimal majors (9:7 third, 8:7 second, 27:14 seventh) · `"c3:sub"` (`subminor`) = dark septimal minors (7:6 third, 14:9 sixth, 7:4 seventh) · `"c3:meantone"` (`quarter-comma`, `qc`) = quarter-comma meantone, E♭–G♯ chain of 5^(1/4) fifths → pure 5:4 major thirds · `"c3:pythagorean"` (`pyth`, `3`) = 3-limit stacked pure fifths, wide bright 81:64 thirds — meantone's mirror image · `"c3:harmonic"` (`harm`, `overtone`) = every slot an overtone of the root (17:16, 19:16, 21:16, 11:8, 13:8, 7:4 — chords ring like one string) · `"c3:well"` (`werckmeister`, `wm3`) = Werckmeister III, the canonical Bach-era circulating well-temperament (a family — Kirnberger/Vallotti/Young stay reachable as custom tables) · `"c3:<12 ratios>"` = custom table · `"off"` (or `et`/`equal`/`-`/`none`) = bypass back to plain 12-TET equal temperament. The spec itself patterns — `.jitune("<c3 c3:neutral off>")` changes tuning per cycle, then back to equal temper (use `off`, not `~`: a mini rest silences that cycle instead of bypassing). A prior `.cents()` detune survives the snap. Fixed-root tables: chords ring pure against the root, and some internal fifths carry the comma — that's the physics, not a bug. **The root is optional** — a bare table name defaults it to C: `.jitune("meantone")` ≡ `.jitune("c3:meantone")` (bare numeric keys `5`/`7`/`3`/`11` read as tables, not Hz roots). **The root can chase the chords** instead of droning: `.jitune("chord")` / `.jitune("chord:meantone")` retunes each note against the chord that voiced it (the symbol rides through `chord().voicing()` automatically), so every chord rings pure over its *own* root — adaptive JI; root motion between chords stays 12-TET while each chord's insides are pure. Chord symbols also work as literal roots — `.jitune("Em7:harm")` anchors on E, and `.jitune(chordz)` (your chord pattern as the spec) tracks the progression the explicit way. Notes without chord info under `"chord:…"` warn once and pass through unchanged. |

Interval vocabulary for `ji()` (and custom `jitune` tables): neutral third
`11:9`, neutral seventh `11:6`, supermajor third `9:7`, supermajor second
`8:7`, subminor third `7:6`, subminor seventh `7:4`, septimal tritone `7:5` —
e.g. a neutral triad is `ji("c3", "[1,11:9,3:2]")`.

**Quoting rule for specs.** The editor mini-notates every double-quoted
string, and mini splits colon tokens (`"c3:super"` arrives as
`['c3','super']`) — the helpers rejoin those, so colon-only specs like
`"31:a3"`, `"c3:7"`, `"c3:meantone"` are safe in double quotes. Specs
containing **spaces** (custom ratio tables, `edoscale` degree lists) cannot
survive mini tokenization — write those as plain single-quoted JS strings:
`.edoscale('31:c4:0 5 10 13 18 23 28')`.

House rule holds: a bad spec or an unpitched value warns once in the console
and passes through unchanged — a live set never throws out of a pattern.

### Patterned knobs — `qualia.cam.walk("<0 1>/4")`

Every **scalar knob** on the `qualia` object (the one-function get/set knobs
taking a boolean, number, or name — `cam.walk`, `blackout`, `zen`, `theme`,
`overlay(key, …)`, `cam.zoom`, `pose.scale`, `strudel.volume`, …) also
accepts a **pattern**. In the editor, double-quoted strings are mini-notation
(stock Strudel transpilation — single quotes stay plain strings), so handing
one to a knob passes a Pattern, and the knob returns a **silent control
lane** that drives itself per event instead of writing once:

```js
stack(
  s("bd*4"),
  qualia.cam.walk("<0 1>/4"),                        // walk 4 cycles on, 4 off
  qualia.overlay('sparks', "<1 0>").slow(4),
  qualia.pose.scale(sine.range(.5, 1).segment(8)),   // signals work too
)
```

The lane is a real Pattern (`.slow()`, `.euclid()`, `.sometimesBy()`, … all
chain), fires at the audible time like every `q*` lane, and only runs while
the evaluated pattern queries it — **as a bare top-level statement it is
inert**. So imperative writes keep using plain values or single quotes
(`qualia.theme('phosphor')`), and pattern arguments belong inside
`stack(...)`. Booleans are lenient: `1/0`, `on/off`, `true/false` all read
as expected. Knob lanes never claim the auto-cycle/auto-phase timers (none
of these knobs are ones the timers write); the panel's lanes chip lists them
collectively as `qualia.*` (signal-fed knobs with no quoted arg are beyond
its text-level scan and stay unlisted).
Config-object knobs (`walkConfig`, `mosh`, …) and action calls
(`nextQuale()`, `looper.grab()`, …) stay imperative — drive those per event
via `qcall`. From the console (no transpiler) pass a real pattern
(`mini("<0 1>")` once the REPL is up) or use `qcall`.

A param that has audio/pose modulators declared keeps them: `qset` writes the
*base* value and the modulation engine still resolves `base ⊕ modulators`
per frame — so patterns and audio-reactivity compose instead of fighting.

### Auto-yield — lanes claim the wheel

`quale()` and **auto-cycle** drive the same knob; `qphase()`, `qpreset()` and a
colliding `qset()` all write the same params **auto-phase** steps. Run both and
the control has two masters: the lane sets a look, the dwell timer moves it
seconds later, the lane snaps it back on its next hap — on stage that reads as
the visuals stuttering.

The typed pattern wins. A lane **claims** the wheel and the matching timer
stands down:

| Lane | Claims | On |
|---|---|---|
| `quale(pat)` | auto-cycle | any hap that resolves to a real quale |
| `qphase(pat)` | auto-phase | any hap that actually steps |
| `qpreset(pat)` | auto-phase | any preset that applies (it writes the same params) |
| `qset(id, pat)` | auto-phase | only a **collision** — `id` is a param the active quale's phase steps also write |

`qglitch` and `qcall` never claim; nothing fights over them.

**One claim per lane instance, and last deliberate act wins.** A lane object is
built fresh by every editor eval, so re-evaluating hands the wheel back. The
claim is spent even when the timer was already off — the lane asserting itself
is the event, not the write — so anything you do afterwards *sticks* instead of
being clawed back on the lane's next hap. And deliberately **arming** a timer
(topbar toggle, dwell picker, hotkey, `autoCycle(true)`, a qualem recall) voids
any outstanding claim, so an explicit arm outranks even a lane that hasn't
fired yet: recall a scene between a `.slow(32)` lane's haps and the recall
stands.

Deliberately narrow at the edges: a typo'd quale name fizzles with a warning
and costs you nothing, a `qphase()` hap on a quale with no phases is a no-op
that leaves the armed period waiting for the next supporting quale, and
`qset("reactivity", …)` — a param no phase step touches — leaves auto-phase
alone.

The yield goes through the same setters as the topbar buttons, so the toggle
face flips, the button pulses once (easy to catch at playing distance), and the
**remembered dwell survives** — one click, or `qualia.autoCycle(true)`, puts it
back exactly as it was.

```js
qualia.autoYield(false)   // opt out; let lanes and timers layer (persisted)
qualia.autoCycle(true)    // resume auto-cycle at its remembered dwell
qualia.phaseParams()      // params the active quale's phase steps write —
                          // i.e. the qset ids that would collide
```

The **random-pattern roller follows the same rule from the other end**: roll a
new pattern with auto-cycle on and its `quale()` lane comes out commented, with
a note saying why. Uncommenting it is then the explicit hand-off — the lane
fires and auto-cycle yields.

### Which lanes are live?

Silent lanes leave no trace in the UI, which is a problem three songs into a
set. The Strudel panel header shows a chip — `⇢ quale · qphase · qset` — naming
the lanes the current buffer declares. Patterned knobs count too, listed
collectively as `qualia.*` (a scalar-knob `qualia.…(` call with a
double-quoted argument; imperative-only calls like `qualia.quale(…)` /
`qualia.set(…)` are excluded). It's read from the buffer text, so a
parked lane correctly doesn't count, and a `.slow(32)` lane still shows up
between haps.

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
qualia.nullQuale()                 // blank the fx layer (the "null" quale)
qualia.quale(null)                 // same — JS null resolves to the null quale
```

The **null quale** (id `null`) is the blank default: it vacates the fx layer
while Hydra (below) and the overlay (above) keep running — unlike
`qualia.blackout(true)`, which darkens the whole stage. It's what shows on a
fresh boot until a quale is specified, and automatic pickers (auto-cycle,
`randomQuale()`, the audience vote) never land on it — only explicit
selection does, e.g. `quale("<null chladni>")` for a breathing gap between
visuals.

```js
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
qualia.phase()                     // step phase (+1); qualia.phase(-1) back — true if it landed
qualia.autoPhase(10, "random")     // seconds (0=off), style: sequential|palettes|random
qualia.autoCycle(30, "random")     // quale auto-swap; sequential|random|progressive
qualia.autoCycle(true)             // 0/false = off, true = resume the remembered dwell
qualia.autoYield(false)            // stop lanes switching off the timer they'd fight
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
qualia.echo(true)                  // training mode: UI actions echo their API call

qualia.fadeOut(20)                 // slow close: ALL audio buses + stage → black over 20 s
qualia.fadeIn(30)                  // slow open back to full (recordings fade too)
qualia.fade(0.3, 5)                // duck everything to 30%
qualia.fadeLevel()                 // current audio fade 0..1
qualia.unfade()                    // instant reset: full level + scrim cleared
```

`fadeOut`/`fadeIn` ramp every audio engine natively in its own context (no
main-thread work during the fade) and ride a fade-to-black scrim over the
stage — pass `{audio: false}` or `{visuals: false}` to fade only one side.
The fade *multiplies* the mixer levels (faders don't move), never persists
(a reload comes back at full level), and a manual fader/mute touch mid-fade
re-applies that channel at the fade's target level.

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
                                   // rotate/mirror persist PER CAMERA (deviceId) —
                                   // switching cameras restores each one's own
qualia.cam.zoom(2)                 // hardware zoom where supported
qualia.cam.caps()                  // hardware controls the track reports (exposure,
                                   // shutter, iso, torch, …) — null when none
qualia.cam.adjust({ exposureCompensation: 2 })
                                   // apply by capability name; persisted (except torch)
                                   // and re-applied on the next camera open — the
                                   // dark-stage lever: fix light at the sensor first
qualia.cam.reset()                 // light pipeline back to defaults: boost off, hw
                                   // overrides cleared, exposure continuous, torch off
                                   // (zoom/facing/rotation untouched)

qualia.pose.smoothing(0.7)
qualia.pose.poses(2)               // tracked people 1..6
qualia.pose.thresholds({ detect: 0.1 })
qualia.pose.linger(1200)           // ms a vanished pose lingers
qualia.pose.scale(0.7)             // skeleton size about the screen centre (1 = raw)
qualia.pose.fps(15)                // inference throttle
qualia.pose.model('full')          // 'lite' fast · 'full' low-light robust · 'heavy' slow
qualia.pose.lowLight({ auto: true })
                                   // software boost on the frames the DETECTOR sees
                                   // (preview stays raw): {amount 0..1, auto}; auto
                                   // meters the room ~1×/s (≤3.5×)
qualia.pose.lowLightGain()         // gain the boost is applying right now (1 = off)
qualia.pose.darkStage(true)        // one-switch low-light preset: longer linger, heavier
                                   // smoothing, slower rate, auto boost; off restores
qualia.pose.people()               // currently tracked count
qualia.pose.confidence()           // per-person mean landmark visibility 0..1
qualia.pose.reset()                // every pose setting back to its default —
                                   // smoothing/rate/thresholds/linger/scale, model
                                   // lite, dark stage off

qualia.horns.enabled(true)         // metal horns 🤘 detection (hands ride the pose worker)
qualia.horns.config({ sound: 'voidstar', logoMs: 3000, eyesMs: 3000 })
                                   // reaction: one-shot sound name ('' = silent — load it
                                   // first, e.g. await samples('shabda/speech:voidstar'))
                                   // + void* logo / nightcall red-eyes flash lengths
                                   // (0 = skip that flash; eyes flash even with the
                                   // nightcall toggle off, and never disturb it)
qualia.horns.active()              // horns held right now? (pattern conditionals)
qualia.horns.count()               // fires this session; each fire also dispatches
                                   // a `qualia:horns` window event
qualia.horns.fire()                // trigger the reaction manually (soundcheck / pad key)
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

qualia.rig.play(); qualia.rig.stop(); qualia.rig.playing()
                                   // signal transport (header ▶/■) — play opens
                                   // the input capture + sends the live signal
                                   // to the mix; stop releases the device
qualia.rig.toggle("delay")         // flip a pedalboard stage
qualia.rig.param("reverb", "mix", .5)
qualia.rig.tone("glassy steel")    // apply a saved tone preset (amp+eq+cab)
qualia.rig.saveTone("glassy steel"); qualia.rig.tones()

qualia.vox.start(); qualia.vox.mute(true); qualia.vox.output(1.2)
qualia.vox.harmony(true)           // harmonizer on/off
```

### Modem simulator (dial-up tone generator)

A performance sound-generator that emulates an analog voiceband modem —
the dial tone, the DTMF dialing, the answering modem's 2100 Hz answer tone,
the V.8 handshake warble, the V.34 line-probe chord, and the V.32 (9600 bps)
data carrier. It can also transmit **real bytes as audible 300-baud FSK** —
the bleeps you hear literally *are* the string, framed as async serial and
genuinely decodable — and simulate the far-end modem panned opposite the near
end. Module: [`modem.js`](../src/lib/qualia/modem.js); it owns a private
`AudioContext` like the vocoder, hangs a limiter before its destination, and is
adopted as the `'modem'` audio source whenever it's sounding, so the chirps
**drive the visuals and land in recordings** for free.

```js
qualia.modem.connect({ number: "18005551234", farEnd: true })
                                   // the full cinematic handshake into the carrier.
                                   // opts: {number, farEnd, probe, busy, rings, dwell}
qualia.modem.command("ATDT5551234")// what an AT command sounds like: dial tone +
                                   // DTMF (non-dial commands → a short FSK chirp)
qualia.modem.data("<voidstar qualia>")           // HONEST 300-baud FSK — the bleeps are the bytes
qualia.modem.data("payload", { mode: "carrier" })// aesthetic V.32 hiss instead
qualia.modem.hangup()              // drop the carrier back to dial tone
qualia.modem.dtmf("1234,5678")     // DTMF a digit string (',' = Hayes pause)
qualia.modem.whistle("answer")     // play it as an instrument: a Hz number, a
                                   // [chord], a DTMF digit/'#', 'mark'/'space'
                                   // (V.21 FSK), or 'answer' (2100 Hz)
qualia.modem.tone([697, 1209], .3) // raw multi-tone primitive
qualia.modem.state()               // 'idle'|'dialing'|'handshake'|'connected'
qualia.modem.stop()                // silence everything now
```

Calls are **one-shots fired at eval time** (top-level statements, like
`qualia.zen(true)` — see the run-once note below), and each queues after the
last so sequences don't overlap chaotically. State changes fire a
`qualia:modem` window event (`{detail:{state}}`), the horns pattern — a quale
can flash on `"connected"`. There's also a **sounding Strudel lane** for
rhythmic data bursts:

```js
stack(
  s("bd*4"),
  modem("<voidstar qualia>").slow(2),               // one word transmitted per 2 cycles
  qcall(() => qualia.modem.connect(), "<~ ~ ~ 1>").slow(8), // a handshake now and then
)
```

`modem()` transmits each hap's value as FSK; the modem synthesises in its own
context, so the lane is silent-in-superdough and stacks like the `q*` lanes.
The dial/handshake one-shots stay imperative (drive them with `qcall`).

**The `modem()` argument is mini-notated** (double-quoted strings are, in the
editor) — so it only carries plain word tokens: spaces split into separate
haps and `/`, `//`, `<`, `>` are mini operators that will throw a parse error.
For an **arbitrary payload** (punctuation, slashes, whole sentences) send it
through `qcall` with a **single-quoted** JS string, which stays literal:
`qcall(() => qualia.modem.data('carrier lost // reconnecting'), "1").slow(4)`.

**Tone reference** (all real standards): DTMF rows 697/770/852/941 Hz ×
columns 1209/1336/1477/1633 Hz · US dial tone 350+440 · ringback 440+480 ·
busy 480+620 · answer tone (ANSam) 2100 Hz (15 Hz AM, phase-reversed) · V.21
FSK originate 980/1180, answer 1650/1850 · Bell 103 originate 1270/1070 · V.32
carrier 1800 Hz at 2400 baud. A future step could bridge real US Robotics
hardware over the Web Serial API (Chromium-only, client-side) — kept separate
from this audio simulator.

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
- **api echo (training mode)**: `qualia.echo(true)` (or the diagnostics-card
  toggle) prints each UI action's `qualia.*` equivalent in a console strip at
  the bottom of the stage — move a slider and read off its param id, switch a
  quale and see `qualia.quale('no_mans_land_2')`. Click a line to copy it.
- **hover ids**: every param label and fx-dropdown option shows its
  programmatic id (and the call that drives it) in its hover tooltip;
  `qualia.quales()`, `qualia.params()`, `qualia.preset()` and
  `qualia.phaseParams()` list the same ids from code.
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
- **Run-once calls are top-level statements, not stack entries.** The buffer
  is JavaScript: statements before the final pattern expression run once per
  eval, so the canonical "run once" is simply

  ```js
  qualia.zen(true)          // runs once, at eval time
  setcps(0.5)
  stack(s("bd*4"), ...)
  ```

  Re-evaluating re-runs them, which is harmless for idempotent setters like
  `zen(true)`. Dropping the same call *inside* `stack(...)` doesn't loop it —
  it still fires exactly once, at eval time — but its *return value* lands in
  the stack as a junk lane: a `null` return kills the whole pattern's query
  loop, and `.slow()` on it throws. So keep imperative calls out of
  `stack(...)`; to re-assert one rhythmically, wrap it in a lane:
  `qcall(() => qualia.nextQuale(), "1").slow(16)`.
- **What belongs in `stack(...)`:** the registered lane functions
  (`quale`/`qset`/`qpreset`/`qphase`/`qglitch`/`qtext`/`qcall`/`qtrig`) and
  any scalar knob handed a pattern (the patterned-knobs section above) —
  those return real silent lanes.
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
