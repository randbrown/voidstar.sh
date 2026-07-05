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

 rig (native ctx):  in → HPF → Earth → Metal → comp → neural amp → cab IR → EQ
                       → [dry / ping-pong delay / reverb] → pan → rig master → limiter → out
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

---

## mixer.js — the channel surface

`createMixer({audio, strudel, sequencer, looper, vocoder})` collects level/mute/limiter + live
meters for 5 channels (mic, rig, strudel, seq, vox). Each channel adapter normalizes the owning
subsystem's setter/getter shape and reads meters from `audio.getLevels()` while open. It re-plumbs
no audio. The "rig" channel drives the looper (which owns the rig master), not the rig strip
directly.

---

## rig-strip.js — the guitar/pedal-steel pedalboard

A native-Web-Audio pedalboard, fixed-order series chain with parallel time-fx sends. Runs in the
**looper's** native context (worklets can't live in Tone's context). Every stage **bypasses to
neutral**, so toggling a pedal never re-wires the graph (no clicks) — except the **comp**, which
hard-bypasses (rewired around, under a ~6 ms gain dip): a "transparent" `DynamicsCompressor`
still delays the signal by its ~6 ms lookahead, and this is the live monitoring path.

```
in → HPF → Earth(drive) → Metal(drive) → comp → neural amp → cab(IR) → EQ
   → [ dry │ ping-pong delay │ reverb ] → pan → output
```

- **Earth** = one asymmetric-tanh `WaveShaper` (JFET-voiced) + tone LPF. **Metal** = two cascaded
  shapers + 3-band parametric EQ. **Cab** + **reverb** are `ConvolverNode`s (reverb IR is generated
  decaying noise, rebuilt on decay change). **Delay** is a true ping-pong.
- `createRigStrip(ctx, cfg)` → `{ input, output, setParam, setEnabled, setConfig, getConfig,
  setCabBuffer, setAmpModel, dispose }`. `looper-audio.js` instantiates it and hangs the rig master
  limiter/level/mute *outside* the strip.
- **Watch out:** drive knobs rebuild 2048-float waveshaper curves on every change (GC churn — see
  backlog), output-trim constants assume a reference input level, and `dispose()` hand-lists ~40
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

Loads small **LSTM** "capture" files (GuitarML/Proteus, AIDA-X, NAM-LSTM) and runs realtime
inference as the rig's amp. (NAM WaveNet captures are intentionally unsupported — they need a WASM
core.)

- `parseAmpModel(json)` (main thread) normalizes the three on-disk formats into flat
  `Float32Array`s `{hidden, Wih, Whh, b, Wd, bd}` and posts them to the worklet. `rig-strip` sends
  `{cmd:'load'|'clear'|'bypass'}`.
- The worklet runs a single-layer LSTM + dense head **sample-by-sample, allocation-free**.
- **This is the single hottest DSP loop in the app.** Per sample: O(4·H²) mul-adds + 4
  `exp`/`tanh` per hidden unit. At H=40/48 kHz that's ~1.2 GFLOP/s of scalar JS on the audio
  thread. Optimization candidates (backlog): tanh/sigmoid lookup table, WASM/SIMD backend, denormal
  flushing for silent-decay state.

---

## The vox stack

Tuned mainly for **intelligible spoken narration** during a set (vocoder), plus harmony and
pitch/formant effects. References the performer's interest in Imogen Heap / Daft Punk / Kavinsky
vocal textures.

### vocoder.js — the vox hub (largest audio file)

A channel vocoder (mic modulator, internal oscillator/noise carrier) tuned for intelligibility,
plus host for the harmonizer's two engines. Owns its own private `AudioContext`. Master clarity
chain: `outBus → lowcut → mud → presence → de-esser → comp → outputGain → limiter → muteGate →
destination`. A clever pattern throughout: **sidechains drive `AudioParam`s directly** (the
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

## devices.js — mic/camera selection

`getStoredDeviceId(kind)`, `storeDeviceId(kind, id)`, and `wirePicker({...})` for hot-swap
`<select>` wiring (persistence, synthetic "same as main mic" leading option, etc.). Clean and
well-parameterized. The `getUserMedia` fallback ladder + `MIC_CONSTRAINTS` are currently duplicated
in `audio.js` and `vocoder.js` — a candidate to move here (backlog).

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
