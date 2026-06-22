# AGENTS.md — voidstar.sh

`voidstar.sh` is a browser-first live-performance platform: live coding, pedal steel, audio
analysis, pose tracking, audience participation, and shader/canvas visuals fused into one realtime
instrument ("qualia lab"). It's an Astro site, statically hosted on Cloudflare Pages (auto-deploy
on push to `main`, no CI).

## Read first — canonical sources of truth

Don't restate these; read the relevant one for your task. This file is just the map and the
non-negotiables.

| Working on… | Read |
|---|---|
| Aesthetic, brand, mythology, voice, prompt snippets, dos/don'ts | [`docs/agent-reference.md`](docs/agent-reference.md) |
| A qualia visualizer ("fx") — the module contract, field shape, helpers | [`src/lib/qualia/README.md`](src/lib/qualia/README.md) |
| Arcade games / playable visualizers | [`plans/arcade-quale-plan.md`](plans/arcade-quale-plan.md) (+ `src/lib/qualia/fx/arcade.js`) |
| The qualia harness architecture | [`plans/qualia-plan.md`](plans/qualia-plan.md) |
| Site theming / CSS themes | [`docs/THEMES.md`](docs/THEMES.md) |

## Non-negotiables

- **Realtime first.** Target 30+ fps at 1080p; never block the render loop with network, model
  loading, or heavy CPU work. Keep hot paths allocation-free. (fx specifics live in
  `src/lib/qualia/README.md`.)
- **Static-host / serverless.** No core performance feature may depend on a server. Degrade
  gracefully: lower DPR, fewer particles, simplified passes, idle mode.
- **Performer stays in control.** Audio, pose, and audience input *suggest*; the performer
  decides. Smooth noisy inputs and never snap on a brief tracking dropout.
- **Stay on-aesthetic.** voidstar = dark, code-cosmic, minimal, legible from across a room. Avoid
  generic EDM bars, stock cyberpunk, SaaS-dashboard UI, particle soup that hides the music. The
  canon is `docs/agent-reference.md`.

## Build & verify

- `npm run dev` (localhost:4321) · `npm run build` · `npm run preview`
- A qualia fx isn't done until it builds clean, boots in `/lab/qualia` with no console errors,
  swaps cleanly to/from another fx, persists its params, still looks alive with audio off, and
  holds 30+ fps. The full checklist is in `src/lib/qualia/README.md`.

## Handoff

When you finish, report: what you implemented, what you verified (build, fx swap, params persist,
no console errors, fps considered), known limits, and suggested next steps.
