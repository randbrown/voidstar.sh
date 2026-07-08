# AGENTS.md — voidstar.sh

`voidstar.sh` is a **browser-native audiovisual live-coding instrument** — a single-performer
performance workstation that fuses live coding, a pedal-steel/guitar rig, live looping, a
sequencer, vocal processing, realtime audio analysis, pose tracking, audience participation, and
shader/canvas visuals into one realtime instrument ("qualia"). It's an Astro site, statically
hosted on Cloudflare Pages (auto-deploy on push to `main`, no CI), with one companion Cloudflare
Worker for the audience-mesh signaling.

The primary use case is **solo pedal-steel + live-coded ambient music with audio-reactive
visuals.** Every design decision serves a live performer on stage, alone, who cannot stop to debug.

## What it actually is (the subsystems)

This is not "an audio visualizer." It's an instrument with many subsystems, most of which run in
the main workstation page `/qualia` (`src/pages/qualia.astro` → wired together by
`src/lib/qualia/page-init.js`):

| Subsystem | What it is | Where |
|---|---|---|
| **Live coding** | Strudel REPL + Hydra visual-synth bridge; pattern code can drive fx params via `globalThis.qualia.setParam` | `strudel-hydra.js`, `strudel-reference.js` |
| **Sequencer** | Custom Tone.js step/pattern drum machine, cycle-locked to Strudel | `sequencer.js`, `sequencer-voices.js`, `sequencer-patterns.js` |
| **Guitar rig / pedalboard** | Native-Web-Audio channel strip: HPF → drives → comp → **neural amp model** → cab IR → EQ ×3 (3-band tone · 7-band graphic · 8-band parametric) → delay/reverb → pan, with a tuner | `rig-strip.js`, `neural-amp-model.js`, `worklets/neural-amp.js` |
| **Looper** | Multi-track live-looping pedal, grid-snapped to the Strudel cycle, with retroactive "grab", time-stretch, and IndexedDB persistence | `looper*.js`, `worklets/looper-recorder.js`, `looper-stretch.js` |
| **Vox** | Channel vocoder (for spoken narration), harmonizer (chord/scale/track modes), formant-preserving voice shifter | `vocoder.js`, `harmonizer.js`, `voice-shifter.js`, `pitch*.js`, `worklets/formant-shift.js`, `vox-presets.js` |
| **Audio analysis** | Multi-source FFT/RMS/beat engine that produces the per-frame `AudioFrame` driving all visuals; also the mixer + per-track limiters | `audio.js`, `mixer.js`, `limiter.js` |
| **Visuals (qualia fx)** | 24 swappable visualizer "quales" + an 8-game arcade, on a shared Canvas2D/WebGL2/Three.js harness | `core.js`, `fx/`, `overlay.js`, `modulation.js` |
| **Pose** | MediaPipe pose tracking, run off the main thread in a worker; landmarks become modulation channels | `pose.js`, `pose-worker.js`, `pose-features.js`, `vision-loader.js`, `video.js` |
| **Entanglement** | Audience participation — phones join via QR, run their own pose, and feed sandboxed, rate-limited `crowd.*` channels and votes | `entangle*.js`, `workers/entangle-signal/` |
| **Recording / export** | Canvas+audio capture to MP4 (with SMPTE timecode) or WebM; loop/set export to `.qualem.zip` | `recorder.js`, `mp4-timecode.js`, `wav.js`, `zip.js` |
| **Control surface** | DOIO KB16-01 macro pad (sends keystrokes) + true MIDI CC; maps physical knobs/keys to qualia functions | `docs/doio-kb16-qualia-keymap.md`, handlers in `page-init.js` |

There are also three **legacy standalone lab pages** (`/lab/cymatics`, `/lab/spectrum-pose`,
`/lab/pose-particles`) — self-contained early experiments whose patterns were extracted into the
qualia harness. They still work but are not the instrument; don't add features there.

Separately, `/lab/setlist` is an **active standalone app** (not legacy): a gig setlist / Nashville-
number-chart / annotation tool with Google Drive backup and a Cloudflare Worker
(`workers/setlist-sync/`) for Spotify/Drive/web-search/AI chart building. It shares nothing with
the qualia engine — see [`docs/setlist-app.md`](docs/setlist-app.md) before touching it.

`/lab/mind` is a second **active standalone app**: a local-first notes / second-brain app
(ProseMirror editor with markdown-canonical storage, tasks-in-notes, folders, voice capture,
image OCR, stylus annotation, Google Drive sync). Serverless like setlist; it forks setlist's
store/Drive patterns rather than sharing code — see [`docs/mind-app.md`](docs/mind-app.md).

## Read first — canonical sources of truth

Don't restate these; read the relevant one for your task. This file is the map and the
non-negotiables; the technical detail lives in the docs below.

| Working on… | Read |
|---|---|
| The full tech stack, architecture decisions, and realtime performance budgets | [`docs/architecture.md`](docs/architecture.md) |
| Aesthetic, brand, mythology, voice, prompt snippets, dos/don'ts | [`docs/agent-reference.md`](docs/agent-reference.md) |
| A qualia visualizer ("fx") — the module contract, field shape, helpers | [`src/lib/qualia/README.md`](src/lib/qualia/README.md) |
| The audio engine — rig/pedalboard, neural amp, vocoder, harmonizer, voice shifter, mixer | [`docs/audio-engine.md`](docs/audio-engine.md) |
| The looper, the sequencer, and the recording/export pipeline | [`docs/looper-and-sequencer.md`](docs/looper-and-sequencer.md) |
| Sequencer kits + samples shared with Strudel (the `strudel.json` pipeline) | [`docs/samples.md`](docs/samples.md) |
| Live coding — Strudel REPL, Hydra bridge, the `qualia.setParam` surface | [`docs/livecoding.md`](docs/livecoding.md) |
| Audience participation + pose — the entanglement mesh and pose pipeline | [`docs/entanglement.md`](docs/entanglement.md) |
| The setlist app (`/lab/setlist`) — data model, backup vs auto-link, chart-fallback ladder, annotations, its worker | [`docs/setlist-app.md`](docs/setlist-app.md) |
| The mind app (`/lab/mind`) — notes store, editor, tasks-in-notes, folders, capture, Drive sync | [`docs/mind-app.md`](docs/mind-app.md) |
| Arcade games / playable visualizers | [`plans/arcade-quale-plan.md`](plans/arcade-quale-plan.md) (+ `src/lib/qualia/fx/arcade/`) |
| Site theming / CSS themes | [`docs/THEMES.md`](docs/THEMES.md) |
| Known refactors, perf wins, and tech-debt backlog | [`plans/maintenance-backlog.md`](plans/maintenance-backlog.md) |

> The two `plans/*-plan.md` files are **point-in-time design/build logs**, not current-state
> reference. They describe the original intent; reality has moved on (e.g. Three.js is now a
> dependency, there are 22 fx not 3). Read them for *why*, not *what is*.

## Non-negotiables

- **Realtime first.** Target 30+ fps at 1080p for visuals; never block the render loop with
  network, model loading, or heavy CPU work. **The audio thread is sacred** — DSP in worklets must
  be allocation-free and must not starve the Strudel cyclist. Keep hot paths allocation-free.
  (Per-area specifics: `docs/architecture.md` for the loop budget, `docs/audio-engine.md` for DSP.)
- **Static-host / serverless.** No core *performance* feature may depend on a server. The only
  server is the entanglement signaling Worker, and a solo set must work with it offline. Degrade
  gracefully: lower DPR, fewer particles, simplified passes, idle mode.
- **Performer stays in control.** Audio, pose, and audience input *suggest*; the performer decides.
  Smooth noisy inputs and never snap on a brief tracking dropout. Audience input is sandboxed,
  rate-limited, and overridable.
- **Multi-context audio is intentional.** The rig/looper run in a native `AudioContext`, the
  sequencer in Tone's, the vocoder in its own. Don't try to "unify" them — see
  `docs/architecture.md` for why (worklet/Tone incompatibility and Strudel's destination mute).
- **Stay on-aesthetic.** voidstar = dark, code-cosmic, minimal, legible from across a room. Avoid
  generic EDM bars, stock cyberpunk, SaaS-dashboard UI, particle soup that hides the music. The
  canon is `docs/agent-reference.md`.

## Build & verify

- `npm run dev` (localhost:4321) · `npm run build` · `npm run preview`
- The main workstation is `/qualia`. (`/lab/qualia` is a permanent redirect to it.)
- A qualia fx isn't done until it builds clean, boots in `/qualia` with no console errors, swaps
  cleanly to/from another fx, persists its params, still looks alive with audio off, and holds
  30+ fps. The full checklist is in `src/lib/qualia/README.md`.
- Audio/DSP changes: verify no `EncodingError`-style failures, no audible clicks on toggle, and no
  xruns/cyclist stalls while a Strudel pattern is running.

## Handoff

When you finish, report: what you implemented, what you verified (build, fx swap, params persist,
no console errors, fps/audio-thread considered), known limits, and suggested next steps.
