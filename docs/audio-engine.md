# The audio engine — analysis, rig, vox, mixer

Everything that makes or measures sound, except the looper and sequencer (those have their own
guide: [`looper-and-sequencer.md`](looper-and-sequencer.md)). Read
[`architecture.md`](architecture.md) §5 first for the multi-`AudioContext` rationale — it explains
why there's no master bus and why each subsystem looks self-contained.

All paths are under `src/lib/qualia/`.

---

## Mental model

```
                       ┌─────────────────────────────────────────────┐
 mic / instrument ───► │ audio.js                                     │
                       │   input strip (gain → limiter → destination) │
                       │   analyser(s) ──► AudioFrame (bands/beat/...) │◄── adopted analysers
                       └─────────────────────────────────────────────┘     from rig, sequencer,
                                  │  per-frame                               strudel, vocoder
                                  ▼
                          all qualia fx (visuals)

 rig (native ctx):  in → GEQ(7-band) → comp → Earth → earth gate → Metal → metal gate
                       → neural amp → EQ → cab IR
                       → HPF → noise gate → ping-pong delay → reverb → PEQ(8-band parametric)
                       → pan → rig master → limiter → out
 vocoder (own ctx): mic → vocoder bank ⨉ carrier → clarity chain → limiter → mute gate → out
```

There is **no single master bus** (see architecture §5). Every track hangs its own
`limiter.js` brickwall before `destination`. `mixer.js` is a *surface* over these scattered
controls, not a summing node.

---

## audio.js — the reactivity engine + input strip

The heart of audio-reactive visuals. Captures the mic/instrument, **adopts** external analysers
(Strudel, sequencer, vocoder, rig/looper), and every reactivity tick distills all active sources
into one `AudioFrame`: `bands {bass, mids, highs, total}` (EMA-smoothed), `beat`/`mids`/`highs`
transient pulses (sharp), `rms`, merged `spectrum`/`waveform`. It also owns the live-input channel
strip and the recordable-mix bus the recorder taps.

- **`createAudio()`** returns ~40 methods. Visuals read `frame`. Lifecycle: `start(deviceId)`,
  `stop()`, `adoptAnalyser(ctx, analyser, id)`, `releaseAdopted(id)`, `tick(dt)`. Metering is the
  single source of truth for the mixer and the topbar CLIP light (`getLevels`, `onClipChange`).
  `setSourceFilter(allowed)` gates both analysis and the recordable mix.
- **Mic pre/post split:** the mic strip is `mic → preGain ('mic gain') → analyser` with the
  output fader/mute (`monitorGain`) and limiter hanging *after* the analyser tap. Reactivity and
  the mixer's mic meter follow the pre gain but ignore the output fader — so a room mic can drive
  the visuals (`'mic'`/`'all'` modes) while muted from the speakers/recording, the
  multi-performer stage case. The recordable-mix tap mirrors `pre × output fader × mute`, so the
  saved file still matches what's heard. All three persist (`inputGain`/`inputLevel`/`inputMuted`).
- **Smooth vs sharp:** `bands.bass` is EMA-smoothed (slow pump); `beat.active`/`beat.pulse` are
  sharp (percussive). Beat detection is fast/slow-EMA spectral flux per band with dominance gates
  and flux-collapse-on-fire to kill double-triggers. Use the sharp signals for anything that should
  read as percussive.
- **No external libs** here — pure native Web Audio. The hot `tick()` is already allocation-free
  (reused level buffers, one `performance.now()` per tick).

> When adding a sound source that should drive visuals or be recorded, give it an analyser and
> `adoptAnalyser(ctx, analyser, '<id>')`. That's the whole integration.

---

## limiter.js — clip insurance

`makeLimiter(ctx, on)` → a `DynamicsCompressor` tuned as a hard brickwall (knee 0, ratio 20,
attack 1 ms, release 100 ms, ceiling −1 dB). `setLimiterEngaged(node, on)` toggles by
**transparency** (ratio 1 / threshold 0), not by reconnecting, so there's no click mid-set. Every
track uses one **except the rig master** — Chromium's `DynamicsCompressor` imposes a fixed ~6 ms
lookahead pre-delay even when transparent, which is monitoring latency on the live-instrument
path, so the rig uses `makeSoftLimiter(ctx, on)`: a zero-latency soft-clip `WaveShaper`
(bit-exact identity below −6 dBFS, tanh ease into the −1 dB ceiling, no oversampling). Trade-off:
it clips the waveform on true overs (slight aliasing) instead of riding a gain envelope —
acceptable for clip insurance. (The vocoder currently reimplements the compressor variant with a
−1.5 dB ceiling — a known consolidation item in the backlog.)

The rig master is also the **pause brake**. Every audible rig path — the live instrument monitor,
the loop bus, the freeze stack, the record count-in — sums at `rigMaster` before the limiter and
`destination` (the capture's `sinkGain` is silent, it only exists to keep the worklet pulled), so
`setRigPaused(on)` gating that one node is the whole rig obeying the page's Space/pause. It's held
separately from `_rigMuted`, and `setRigLevel` ramps to `effRig()` rather than `_rigLevel`, so a
fader move can't punch through the brake and the performer's own mute/level survive the pause
untouched. `looper.setRigPaused()` also cancels a pending record count-in and stops a running take
— nothing should keep capturing behind a paused transport. `page-init.js`'s `setPaused` calls it.

The rig master carries a fixed **`RIG_MAKEUP` ×2 (+6 dB)** under the fader: an instrument-level
capture reads far below the near-full-scale sample playback of the sequencer/Strudel, so without
it the rig fader lived pinned at max while the other channels sat halfway. Applied at `rigMaster`
(inside `effRig()`), so the live signal, loops, and freeze pads scale together and the strip's
drive/amp stages (which assume a reference input level) are untouched; the count-in pips divide it
back out. On top of that the fader itself runs past unity into **boost** (`RIG_LEVEL_MAX`, 0–2×);
boost is safe because it drives the soft limiter (gain into a
brickwall = loudness maximizer), and `looper.js` **force-engages** the rig limiter whenever the
level sits above 1.0 (`setRigLimiter` refuses to disengage while boosted). Because the soft
clipper is memoryless, its gain reduction is exact math on the pre-limiter peak:
`softLimiterReductionDb(peak)` + the rig's pre-limiter `outputAnalyser` feed
`looper-audio.getRigReductionDb()`, which drives the mixer's rig GR bar.

---

## mixer.js — the channel surface

`createMixer({audio, strudel, sequencer, looper, vocoder})` collects level/mute/limiter + live
meters for 5 channels (mic, rig, strudel, seq, vox). Each channel adapter normalizes the owning
subsystem's setter/getter shape and reads meters from `audio.getLevels()` while open. It re-plumbs
no audio. The "rig" channel drives the looper (which owns the rig master), not the rig strip
directly. Boost-capable faders (max > 1) tint their over-unity span; the rig channel additionally
shows a thin amber **gain-reduction bar** along the top of its peak meter (via
`looper.getRigReductionDb()`, full width ≈ 12 dB), glows its `lim` button while the limiter is
actively reducing, and locks the button on while the fader sits above 1.0 (the force-engage rule
in `looper.js`).

---

## rig-strip.js — the guitar/pedal-steel pedalboard

A native-Web-Audio pedalboard, fixed-order series chain laid out like a physical board. Runs in
the **looper's** native context (worklets can't live in Tone's context). Every stage **bypasses to
neutral**, so toggling a pedal never re-wires the graph (no clicks) — except the **comp**, which
hard-bypasses (rewired around, under a ~6 ms gain dip): a "transparent" `DynamicsCompressor`
still delays the signal by its ~6 ms lookahead, and this is the live monitoring path.

```
in → GEQ(7-band graphic) → comp → Earth(drive) → earth gate → Metal(drive) → metal gate
   → neural amp → EQ(lo/mid/hi) → cab(IR) → HPF → gate
   → ping-pong delay → reverb → PEQ(8-band parametric) → pan → output
```

- **Earth** = one asymmetric-tanh `WaveShaper` (JFET-voiced) + tone LPF. **Metal** = two cascaded
  shapers + 3-band parametric EQ. **Cab** + **reverb** are `ConvolverNode`s (reverb IR is generated
  decaying noise, rebuilt on decay change). **Delay** is a true ping-pong. The two time fx run
  **in series** — the delay's output (dry + repeats) feeds the reverb, so echoes get reverberated
  and share the dry signal's room. **Comp** sits up front as an instrument compressor (clarity /
  attack into the drives); output limiting stays at the rig master (`limiter.js`), never in the
  strip. The **HPF** is post-cab: it de-woofs the cab'd tone and keeps low mud out of the wash.
- **Gates** — the rig runs **three independent noise gates** off **one shared sidechain** (the
  vocoder's carrier-gate topology ported to the rig). Each gate is a VCA driven directly on its
  gain `AudioParam` by a sidechain envelope — rectify + LPF on the **clean strip input** — mapped
  through a soft-knee smoothstep WaveShaper curve (an expander, not a chattery hard gate).
  Detection has to be **pre-drive** (post-distortion, hiss and signal sit at nearly the same level
  after two cascaded clippers, so a local detector can't tell them apart), which is why all three
  key off the clean input rather than their own position in the chain. The detector's key HPF +
  rectifier are shared; each gate owns its envelope LPF and threshold curve, so their settings are
  fully separate. All native biquads/gains: zero added latency, toggles by curve swap (unity curve
  = bypass), no graph rewiring. `thresh` squares the knob for fine low-end resolution; `release`
  sweeps the envelope LPF 30 → 6 Hz (one symmetric filter — the slow end trades softened pick
  attack for chatter-free decays). The three:
  - **`gate`** (strip gate) sits between the HPF and the time fx. Post-cab it catches every
    upstream hiss source at once — including the amp capture's idle noise, which the pedal gates
    sit in front of — while a closing gate never chops the delay/reverb tails.
  - **`earthGate`** sits immediately after Earth, so Metal's pre-gain (up to +24 dB) never
    re-amplifies Earth's noise floor. Defaults are gentle — low threshold, slow release — because
    Earth is a low-gain JFET stage and the drive you play touch-dynamically.
  - **`metalGate`** sits immediately after Metal, before the amp. Defaults are aggressive — high
    threshold, fast release — because two cascaded clippers behind heavy pre-gain hiss far louder,
    and a tight cutoff is what that voice wants anyway.

  The per-pedal gates are **part of their pedal**: each is only live while its drive is engaged, so
  arming one can't silently gate the clean signal passing through a bypassed stage. Nothing
  downstream of them holds a tail (the time fx are post-cab), so a closing pedal gate can't chop
  one either. The UI says the same thing — `earthGate`/`metalGate` are `group: 'sub'` in
  `looper.js`'s `STRIP_SCHEMA` and render as a hairline-separated section **inside** their pedal's
  box rather than as boards beside it, while the strip-wide `gate` (set once for the rig's noise
  floor, then left alone) sits in the **utility** drawer next to the HPF it follows.
- **Three EQs spread along the chain**, one job each: **geq** at the front, shaping the raw
  instrument before comp + drives (Boss GE-7-voiced graphic: 7 octave-spaced peaking bands
  100 Hz–6.4 kHz ±15 dB + level); **eq** between amp and cab, an FX-loop tone stack on the amp'd
  signal (3 fixed shelves/peak, tone knobs); **peq** at the output after the time fx, for surgical
  fixes on the full wet signal (ReaEQ-style parametric: 8 bands, each with enable / type
  peak·shelves·pass·notch / freq / gain / Q). Nonlinear stages sit between them, so their
  positions are audible. All are plain biquads permanently in the series chain, bypassing to
  bit-transparent neutral (peaking @ 0 dB) — **zero added latency on or off**, no graph rewiring,
  negligible CPU. The peq's
  panel editor (in `looper.js`) draws the composite response on a log-frequency canvas with
  draggable band handles; the curve is queried from prototype `BiquadFilterNode`s in a dormant
  `OfflineAudioContext` via `getFrequencyResponse`, so the display is exactly the browser's own
  filter math. A **live pre/post-peq spectrum** (ReaEQ-style — grey fill in, pink line out) draws
  behind the curve from two analyser taps inside the strip (`getPeqAnalysers`); analysers are pure
  sinks whose FFT only runs when read. The static curve paints on demand; the spectrum runs a
  ~30 fps rAF loop gated on the canvas being visible **and** the rig capture open — zero cost with
  the panel closed.
- `createRigStrip(ctx, cfg)` → `{ input, output, setParam, setEnabled, setConfig, getConfig,
  setCabBuffer, setAmpModel, dispose }`. `looper-audio.js` instantiates it and hangs the rig master
  limiter/level/mute *outside* the strip.
- **Watch out:** drive knobs rebuild 2048-float waveshaper curves on every change (GC churn — see
  backlog), output-trim constants assume a reference input level, and `dispose()` hand-lists ~55
  nodes (drift risk). The drive shapers use `oversample:'4x'` **only while enabled** — the rig's
  heaviest native cost, and the resamplers add ~4 ms of group delay per shaper (why bypass drops
  to `'none'`).
- **Latency:** the strip exports `stageLatencySeconds(stage)` and instances expose
  `getLatencySeconds()` — the stages that add real delay when ON (earth ~4 ms, metal ~8 ms,
  comp ~6 ms at 48 kHz). Everything else is zero-latency (convolvers have a spec-mandated direct
  head; the LSTM worklet is causal). `looper-audio.getLatencyInfo()` combines this with
  `baseLatency`/`outputLatency` + a mic/output sample-rate-mismatch flag (hidden resampler);
  the rig strip subhead shows it live, and enabling a latency-adding stage pops a transient note.

---

## neural-amp-model.js + worklets/neural-amp.js — neural amp modeling

Loads neural "capture" files and runs realtime inference as the rig's amp. Two backends sit behind
one worklet node:

| Backend | Formats | Where it runs |
|---|---|---|
| `lstm` | GuitarML/Proteus, AIDA-X, NAM `architecture:"LSTM"` | plain JS in the worklet |
| `wavenet` | NAM `architecture:"WaveNet"` — **what virtually every shared `.nam` actually is** | WASM SIMD kernel |

- `parseAmpModel(json)` (main thread) dispatches on architecture and normalizes to flat
  `Float32Array`s — `{hidden, Wih, Whh, b, Wd, bd}` for LSTM, or the packed layer-array description
  for WaveNet. `rig-strip` sends `{cmd:'load'|'clear'|'bypass'}` and **awaits the worklet's ack**,
  so a backend that fails to initialise reports instead of leaving the amp silently transparent.
- The LSTM path runs a single-layer LSTM + dense head sample-by-sample, allocation-free.

### The WaveNet path

- **Parsing/packing:** `nam-wavenet.js`. Handles both NAM config schemas — classic (≤0.6:
  `kernel_size`, `activation:"Tanh"`, `head_size`) and extended (0.7+: `kernel_sizes[]`,
  `bottleneck`, an explicit Conv1D `head`, per-layer activations) — plus 0.7's container
  architectures. A `SlimmableContainer` holds several submodels valid up to increasing input
  levels; they are separately parameterised (not nested slices), so switching mid-stream would step
  the output. **We take the widest**, which is the only one valid across the whole input range —
  affordable now that the kernel is fast.
- **Refusals are by name.** FiLM blocks, grouped convs, per-layer gating, `secondary_activation`
  and friends are rejected saying which one stopped the load. Silently ignoring a block would load
  "fine" and sound wrong — the worst failure for a rig. The final guard is arithmetic: the weight
  cursor must land exactly on `weights.length`.
- **Kernel:** `wasm/nam-wavenet.c` → `public/wasm/nam-wavenet.wasm` (**committed** — the site
  auto-deploys from a push with no CI, and Pages has no C toolchain). Rebuild with
  `src/lib/qualia/wasm/build.sh` and commit the result. Every matrix is packed `[in][outPadded]`
  with channels padded to a multiple of 4, so the inner loop splats a scalar input and accumulates
  whole `v128` lanes — no horizontal reductions.
- **Why WASM:** a typical NAM WaveNet is ~12k mul-adds per sample. Scalar JS costs ~100% of one
  core at 48 kHz (measured, 2.1 GHz Xeon); the SIMD kernel does the same graph at ~15%.
- **The bytes cross the port, not the module.** A compiled `WebAssembly.Module` is
  structured-cloneable but an `AudioWorkletGlobalScope` is a separate agent cluster — Chrome
  *silently drops* the message. `nam-wasm.js` fetches the bytes (and compiles once to check
  `nam_abi()` against a stale service-worker copy); the worklet compiles them synchronously.
### Capture level (`norm`)

Captures are trained at wildly different output levels — well over 10 dB apart. That matters more
here than in a plugin host, because the amp's output feeds four things that care about absolute
level: the PA, the mixer's soft limiter, recorded loops (the recorder taps the strip *output*), and
**visual reactivity** — `sigAnalyser` is adopted into the mix as the `rig` source, so a hot capture
literally makes the fx more excitable.

- The amp stage's **`norm` toggle** level-matches a capture to a common loudness
  (`NORM_TARGET_DB`, matching NAM's own target so levels translate to other NAM hosts). The trim is
  computed by `normTrimFor()` from the capture's declared `metadata.loudness`, clamped to ±12 dB.
- **Off by default** — it's a real gain change and the performer owns level.
- The trim rides with the **capture**, not the strip (`ampNormTrim`, set in `setAmpModel`), so
  swapping captures level-matches on its own while `lvl` stays the performer's knob. It's a
  separate multiplier because `lvl` alone can't do the job — it caps at 2× (+6 dB).
- **Never invisible:** the loader line states the capture's loudness and, when `norm` is on, the
  exact dB being applied. A capture that declares no loudness (GuitarML/AIDA-X, older NAM) gets a
  trim of exactly 1 and says so rather than guessing.
- Worth remembering: loudness is measured at ONE operating point of a nonlinear model, so matching
  there doesn't guarantee a match at your own dynamics or with the drive knob up.

Sample rate is reported but not corrected — the loader line flags a capture trained at a rate other
than the context's, since that shifts its frequency response.

### Capture gear type & the tone layer

NAM metadata can declare **what** was captured (`gear_type`: amp · pedal · pedal_amp · amp_cab ·
amp_pedal_cab · preamp · studio). The parser carries it through as `parsed.gearType`
(`isFullRigGearType()` in `neural-amp-model.js` names the "cab is baked in" set: `amp_cab`,
`amp_pedal_cab`, `studio`), and the rig's **tone layer** (`looper.js`) uses it the first time a
capture is selected: a full-rig capture bypasses the cab + eq stages (stacking a cab IR on a
baked-in cab double-filters), an amp/pedal capture engages the cab, and files with no metadata
(GuitarML/AIDA-X, older NAM) change nothing. The applied default shows in the loader line and the
status toast — never invisible, same rule as `norm`.

That default only fires **once per capture**, because every tone tweak (amp/eq/cab on/off, params,
`norm`, cab IR choice) is remembered **per amp** (`voidstar.qualia.looper.ampTones`, keyed by amp
library id) — re-selecting a capture restores exactly the eq/cab/knobs last used with it, so the
gear-type guess is just the seed and the performer's override sticks. On top of that sit **named
tone presets** (`tone-presets.js` + the tone zone's subhead select/`+`/drawer): the whole
amp + eq + cab trio — stage state plus amp/cab library *pointers* — saved, renamed, exported and
imported as `.tone.json` (pointers only; the heavy bytes travel in `.qualem.zip` bundles, and a
missing pointer leaves the current capture, the qualem policy). `qualia.rig.tone/saveTone/tones`
expose them to the code API.
- `scripts/check-nam-wavenet.mjs` (in `npm run check`) drives the real worklet + real `.wasm`
  against an independent reference forward pass across both schemas, gated layers, chained layer
  arrays and padded channel counts, and asserts the refusal paths.

---

## The vox stack

Tuned mainly for **intelligible spoken narration** during a set (vocoder), plus harmony and
pitch/formant effects. References the performer's interest in Imogen Heap / Daft Punk / Kavinsky
vocal textures.

### vocoder.js — the vox hub (largest audio file)

A channel vocoder (mic modulator, internal oscillator/noise carrier) tuned for intelligibility,
plus host for the harmonizer's two engines. Owns its own private `AudioContext`. Master clarity
chain: `outBus → lowcut → mud → presence → de-esser → comp → outputGain → limiter → muteGate →
destination`. The mic capture asks for stereo (`channelCount: {ideal: 2}`) and the panel's `chan`
select (`micChannel`: mix / ch 1 / ch 2) can take a single input of a stereo interface — pairs
with the rig's ch 1/ch 2 input mode so a 2-in device splits rig ↔ vox. A clever pattern throughout: **sidechains drive `AudioParam`s directly** (the
de-esser sidechain feeds `deEsser.gain`; the noise-gate sidechain feeds the carrier VCAs) rather
than gating audio. Pitch tracking is a rAF `autoCorrelate` loop. `createVocoder(...)` exposes
lifecycle, a mixer surface, `getConfig/setConfig` (folds in harmonizer), and a `feedAnalyser`
that `page-init` adopts into `audio.js` as the `'vocoder'` source.

> It's ~1,500 lines doing DSP + harmonizer integration + pitch tracking + mic/preset pickers +
> draggable UI + persistence. Extraction targets (backlog): the clarity-chain builder, the per-band
> bank builder, the duplicated panel-drag block, and reuse of `limiter.js`.

### harmonizer.js — the music theory brain (no audio nodes)

Decides *which notes* the vocoder sounds (chord/keys/track modes) and the autotune/voicing logic —
but owns **zero audio nodes**. Pure functions: `QUALITIES`, `SCALES`, `VOICINGS` (diatonic
degree-offset voicings), `snapToScale`, `getChord()`, `getShifts()`, `updatePitch(hz)` (with
boundary hysteresis so the lead note doesn't chatter). The standout module for testability.

### voice-shifter.js + worklets/formant-shift.js — formant-preserving pitch shift

The "voice" engine's back-end. Wraps two implementations behind one node interface and
**hot-swaps**: starts on the granular fallback (immediate audio), upgrades to the formant worklet
once it loads — callers never see the swap. `ensureModule` memoizes `addModule` per-context in a
`WeakMap`. The worklet is an STFT phase vocoder (FFT 2048 / 75% overlap) with a **stationary
formant envelope** — pitch moves, formants stay put. All scratch arrays are preallocated (no
per-frame allocation). Up to 6 FFTs/hop with active voices = the vox-engine's dominant cost.

### pitch-shift.js — the granular fallback

Two delay lines swept by looping ramp buffers, crossfaded with Hann windows; phase-locked for free.
Elegant and allocation-free at runtime. Documented limits: warble on sustained notes, no formant
preservation (formant control is a no-op until the worklet loads).

### pitch.js — monophonic pitch detection

`autoCorrelate(buf, sampleRate, fMin, fMax)` → Hz or −1. Normalized autocorrelation (works for
quiet mics), octave-error guard, parabolic interpolation for sub-sample accuracy. **Easy win:** it
allocates a `Float32Array` every call and is called per-frame — hoist the scratch buffer
(backlog).

---

## modem.js — dial-up modem tone simulator

A performance sound-generator (not part of the reactivity engine) that emulates an analog
voiceband modem: dial tone, DTMF dialing, the 2100 Hz answer tone (ANSam), the V.8 handshake
warble, the V.34 line-probe chord, and the V.32 (9600 bps) data carrier — plus **honest 300-baud
FSK** that transmits real bytes as audible, decodable bleeps. A textbook instance of the two audio
conventions below: it owns a **private `AudioContext`** (like the vocoder, so it never entangles
Strudel's mute-patch), hangs a `makeLimiter` brickwall before its destination, tags the output
`__qualiaBypassMute`, and tees an analyser off its bus. `page-init` adopts that analyser as the
`'modem'` source **only while it's audible** (an `onFeedChange` callback fires at the start and end
of every sound), so the chirps drive the visuals and record like every other source.

Nothing runs on the audio thread — each `command`/`data`/`connect`/`whistle` call builds a timeline
of oscillator + bandpassed-noise nodes scheduled against `ctx.currentTime` (calls queue after one
another so sequences don't overlap), and state changes fire a `qualia:modem` window event. All the
tone tables and the full API live in [`qualia-code-api.md`](../docs/qualia-code-api.md#modem-simulator-dial-up-tone-generator);
`page-init` gates it in the `'mix'`/`'all'` source filters and cuts it on pause.

---

## devices.js — mic/camera selection

`getStoredDeviceId(kind)`, `storeDeviceId(kind, id)`, and `wirePicker({...})` for hot-swap
`<select>` wiring (persistence, synthetic "same as main mic" leading option, etc.). Clean and
well-parameterized. The `getUserMedia` fallback ladder + `MIC_CONSTRAINTS` are currently duplicated
in `audio.js` and `vocoder.js` — a candidate to move here (backlog).

Camera **rotation + mirror persist per deviceId** (`video.js`, key
`voidstar.qualia.camTransforms`): they're physical properties of a camera, so switching between
e.g. the FaceTime cam and a sideways-clamped USB cam restores each one's own transform.
`page-init` calls `setActiveCamera(deviceId)` whenever a camera goes live; the `setRotation`/
`setMirror` setters then persist under that id. A first-seen camera keeps the current transform
(seeded as its entry), except a front/back facing flip still derives mirror from the lens.

---

## Conventions when working in audio code

- **Pick the right context.** New worklet-bearing DSP → the rig/looper native context. New
  Tone-scheduled rhythmic source → Tone's context. Something that must survive Strudel's mute →
  tag the output node `__qualiaBypassMute` (or use a private context like the vocoder).
- **Always add a limiter** before any new `destination` path.
- **Adopt an analyser** if it should drive visuals or be recorded.
- **No allocation / no large-buffer rebuilds on the audio thread or per knob tick.** Quantize and
  cache (see backlog for the existing churn spots).
- **Toggle by transparency, not reconnection,** to avoid clicks (the limiter and rig pedals model
  this) — *unless* the node delays the signal even when transparent (`DynamicsCompressor`
  lookahead, oversampled `WaveShaper` group delay). On a live monitoring path, take those out of
  the graph when off, masked by a short gain dip (the rig comp models this).
