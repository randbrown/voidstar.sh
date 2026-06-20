# Arcade quale — research & design

*New qualia-lab fx: interactive retro-game simulations driven by pose, audio, and the
entangled crowd. Researched against the existing stack (Astro + canvas2d/webgl2/three fx
harness, MediaPipe pose worker, Cloudflare-relay entanglement). Author: design pass, 2026-06.*

---

## 1. The one fact that shapes everything

An fx can read three input surfaces from `QualiaField`:

| Surface | What it is | Granularity |
|---|---|---|
| `field.pose.people[]` | The **performer's** camera, MediaPipe, up to 6 bodies, full named joints | per-joint, per-person |
| `field.audio` | bands / beat / rms / spectrum / waveform | full |
| `field.crowd` | The **entire entangled audience**, reduced to 8 scalars | **aggregate only** |

`field.crowd = { x, y, energy, spread, rise, sway, count, confidence }` — that's *all* the
audience data an fx ever sees (`modulation.js:78`, `entangle.js reduceInto`). Each phone runs
pose locally, ships an 8-float feature vector ~15 Hz, and the host **collapses every phone into
that single snapshot before any fx runs.** No per-phone identity reaches the render loop today.

That gives us two cleanly-separated interaction tiers:

- **Tier A — "the crowd is one joystick."** The whole room collectively drives one avatar/world
  through `field.crowd`. **Works today with zero protocol changes.** This is the 80%, it's the
  most *voidstar* (a literal Wavefunction Chorus collapsing into Pac-Man's next turn), and it
  degrades gracefully to the performer's own body when nobody's entangled.
- **Tier B — "each phone is a player."** Individual avatars, optional virtual NES controller.
  Requires a bounded extension: a new gamepad message, per-peer state retained (already is,
  internally), and a new `field.players[]` surface. This is the wishlist tier.

**Recommendation: ship Tier A first as a complete, popular feature; add Tier B as a second pass.**

---

## 2. How a quale plugs in (confirmed contract)

- One file `src/lib/qualia/fx/arcade.js`, `default export` conforming to `QFXModule`, registered
  in `page-init.js` (import + `mesh.register(arcade)`). UI/persistence/Strudel-hook are automatic.
- `contextType: 'canvas2d'` for everything here except an optional 3D piece (see §5). Canvas2D is
  the right tool: cheap, pixel-perfect, and the codebase already has the patterns.
- **Multiple games = one fx with a `select` param**, not many fx. This is the established pattern
  (`chladni` 5 modes, `synthwave` 4, `code` **9 — one of which is already `tetris`**). It keeps
  the dropdown clean, preserves params across switches, and plugs into auto-phase/auto-cycle.
- **fx may import helper modules** — `code.js` already does `import { createMeltEngine } from
  './code-meltdown.js'`. So we get a clean `fx/arcade/` subdirectory, one file per game.
- Hot-path discipline is mandatory: pre-allocate all entity/tile arrays in `create()`, zero
  per-frame allocation, `update(field)` advances sim → stashes into scratch, `render()` only draws
  (README "Allocation discipline" / "Render-update split"). Pose runs at 15 fps decoupled from
  render, so avatar motion is integrated with `dt` and the pose snapshot is a target, not a frame.

### Proposed structure

```
src/lib/qualia/fx/arcade.js            // QFXModule: params, presets, game registry, dispatch
src/lib/qualia/fx/arcade/
  engine.js        // shared: fixed-timestep loop, input-intent model, sprite atlas, tile blitter,
                   //         text, palette, screen-shake, CRT vignette, score HUD
  input.js         // maps field.pose + field.crowd (+ later field.players) → a normalized
                   //         "intent" struct {moveX, moveY, jump, fire, action, steer...}
  muncher.js       // maze (Pac-Man / Dig Dug family)
  racer.js         // pseudo-3D road (Outrun / Pole Position / Spy Hunter / Kart family)
  invaders.js      // fixed shooter (Galaga / Galaxian family)
  scroller.js      // side-scroll platformer (Mario / Castlevania / Pitfall family)
  ...              // added incrementally
```

Each game module exports `create(engine) -> { reset(), update(intent, audio, dt), render(ctx), dispose() }`.
The fx shell owns the `select` param, instantiates the chosen game lazily, and routes the field.

---

## 3. The input model — pose & crowd → game intent

There are **no gesture classifiers** in the stack — `pose-features.js` exposes 8 normalized
scalars (headX/Y, shoulderSpan/Roll, headPitch, wristSpread, wristMidY, confidence), all clamped
[-1,1], computed identically on performer and phone. We derive higher-level intents in `input.js`
by keeping a tiny ring buffer of recent landmark/feature values (velocity = Δ over dt).

`input.js` produces one normalized **intent** struct per frame, sourced from whichever surface is
active (crowd if entangled, else performer pose, else idle attract-mode AI):

| Intent | Crowd source (Tier A) | Performer source | Notes |
|---|---|---|---|
| `steer` / `moveX` | `crowd.sway` (low-passed mean head-x — *perfect* for a room leaning together) | `pose.head.x` | racers, side-scrollers, ship |
| `moveY` / aim | `crowd.y` | `pose.head.y` | maze vertical, FPS pitch |
| `jump` / `thrust` | `crowd.rise` rising-edge (hands up across room) | wrists above shoulders + upward velocity | platformers, Joust flap |
| `fire` / `action` | `crowd.rise` or beat-gated `crowd.energy` | wrist forward-extend velocity ("punch") | shooters, fighters |
| `duck` / `brake` | low `crowd.y` | head drop toward hips | universal |
| `intensity` | `crowd.energy`, `crowd.count` | — | **audio + crowd drive enemy/world intensity** (the brief's wish) |

**Audio → game elements (the brief's explicit ask)** is wired the *declarative* way via param
modulators so it shows in the UI and respects the reactivity slider:

```js
{ id: 'enemyIntensity', type: 'range', min: 0, max: 2, default: 1,
  modulators: [
    { source: 'audio.bass',   mode: 'mul', amount: 0.5 },   // bass → enemy speed/size
    { source: 'audio.beatPulse', mode: 'add', amount: 0.4 },// kick → spawn/advance wave
    { source: 'crowd.energy', mode: 'mul', amount: 0.5 },   // rowdier crowd → harder game
  ] }
```

Inside the game, `audio.beat.pulse` advances Galaga waves / drops Tetris pieces / fires the muncher
ghosts; `audio.bands.bass` scales enemy speed; `audio.highs.pulse` sparkles pickups. This is exactly
the "audio affects enemies and game elements intensity" wish, and it's the genre the harness is best at.

---

## 4. IP & art direction (important — this is a public, recorded, performed site)

Pac-Man, Mario, Doom, etc. are **trademarked and the sprites/names are copyrighted.** We do **not**
ship their assets or names. We ship **genre homages with voidstar skins and original names**, which
is also the more on-brand result. The listed titles are *vibe references*, not asset sources.

| Genre (reference) | voidstar skin / working name |
|---|---|
| Pac-Man / Dig Dug | **NULLMUNCHER** — a void-dot eating null-pointers `((void*)0)`, hunted by glitch-ghosts in a neon stained-glass maze |
| Outrun / Pole Position / Spy Hunter | **ACCRETION RUN** — neon road diving into a black-hole horizon, traffic = debris in the disk |
| Galaga / Galaxian / Joust | **VOID INVADERS** — wavefunction swarms; the crowd is the cannon |
| Mario / Castlevania / Pitfall | **PORCH RUNNER** — a little stained-glass Sasquatch hopping a cosmic side-scroll |
| Punch-Out / Mortal Kombat / Kung Fu | **STEEL FIGHTER** — silhouette boxer, the *performer's* real punches land |
| Tetris | **VOIDRIS** — already half-built in `code.js` tetris mode; port/restyle |
| Doom / Unreal (Tier-2 3D) | **THE CORRIDOR** — raycast hallway through the machine |
| Frogger | **CROSSVOID** |
| Pong | **EVENT HORIZON PONG** — performer vs. crowd |

Procedural/vector pixel-art (drawn with rects/paths, no image files) is preferred for most: zero
asset pipeline, zero bundle weight, instant load, total IP safety, and it screen-blends cleanly over
Hydra at `#05050d`. A small pre-rendered sprite atlas (one OffscreenCanvas built once in `create()`,
the documented `synthwave cityBuf` / `chladni fieldBuf` pattern) is the fallback for anything fiddly.

---

## 5. Rendering approach per genre — all proven by existing fx

- **Tile/grid (muncher, invaders, scroller, tetris, frogger, pong, fighters):** plain canvas2d.
  Tilemaps as `Uint8Array`, entities as struct-of-arrays `Float32Array`. Pre-render the glyph/sprite
  atlas once. Trivially 60 fps. Reference discipline: `code-meltdown.js` (typed-array cell sim with a
  hard `MAX_CELLS` budget), `chladni.js`.
- **Pseudo-3D racer:** copy `synthwave.js`'s `projectZ()` perspective curl + vanishing-point shift
  (`synthwave.js:262`). The neon-horizon road is *already the visual*; add road edges, curve, and
  sprite-scaled traffic. `crowd.sway` → steering is genuinely magical for a room.
- **Raycaster FPS (Tier 2, optional):** Wolfenstein-style DDA, ~160–320 columns rendered into a
  small offscreen buffer then `drawImage`-scaled up. Cheap and authentically retro. *Or* a real
  corridor via the existing core-owned three.js renderer (`contextType:'three'`, used by `galaxy`,
  `atomic-orbital`, `ghost-machine`). Defer either to Phase 2.

**No new libraries needed.** three.js (0.165) is already a dep for the optional 3D piece. **Skip
physics engines (matter/planck)** — they fight the no-GC discipline; hand-rolled AABB + gravity per
game matches the codebase and every listed game needs only that. Reuse existing canvas text for HUDs.

---

## 6. Performance budget

- One game active at a time → render cost = one game, comfortably inside the 30 fps @ 1080p budget
  (target 60). DPR capped at 1.5× by core; `resize(w,h,dpr)` hands backing-buffer pixels.
- Pose at 15 fps in a worker, CPU delegate (GPU is reserved for fx+Hydra). Crowd reduce is O(N≤40),
  8 scalars, no allocation. None of this touches the render hot path.
- Internal-resolution trick for any pixel-heavy mode: simulate/draw at a low fixed virtual
  resolution (e.g. 256×224, the NES-ish frame), `drawImage` upscale with `imageSmoothingEnabled=false`
  for crisp big pixels. Cheap *and* it's the correct retro aesthetic.

---

## 7. Tier B — virtual NES controller & per-player avatars (Phase 2)

Feasible and bounded. Per-peer state is **already retained** in the host's `peers` Map; today it's
just never surfaced past `reduceInto`. The work:

1. **Protocol** (`entangle-protocol.js`): add `T.INPUT` with a tiny payload
   `{ b: <bitmask up/down/left/right/A/B/start>, ax, ay }` (ax/ay optional analog stick). ~6 bytes.
2. **Phone UI** (`entangle-client.js` + `entangle.astro`): a new manifest mode `gamepad` renders a
   fixed-position D-pad + A/B overlay (CSS, pointer-capture, edge-triggered sends ~30–60 Hz +
   heartbeat, reuse the existing `hapticPulse` for button feedback). The manifest is already a
   dynamic, host-driven control list — this slots in beside `range/toggle/select`.
3. **Host** (`entangle.js`): store `peers[id].input`; assign a stable **player slot** on join
   (0..N), reclaim on leave; expose `getPlayers() -> [{id,name,slot,input,pose}]`.
4. **Field surface**: a second `core.onTick` (next to the existing `reduceInto`) writes
   `field.players`. Add to `QualiaField` typedef. fx that don't care never read it.
5. **Engine**: games read `field.players` when present, else fall back to Tier-A `field.crowd`.
   **Cap active players (~8)**; extra phones spectate/queue with a "you're player 5 / waiting"
   status. 40 simultaneous Marios is noise — bounded slots keep it legible from stage distance.

This also lets the performer expose a **"crowd picks the game"** vote: the entangle layer already has
a `VOTE` path (currently fx-selection) and an auto-seeded param whitelist — the `game` select param
can be whitelisted so phones choose the next game (`entangle.js` whitelist + `manifestParam`).

---

## 8. Proposed phasing

- **Phase 0 — harness:** `arcade.js` shell + `arcade/engine.js` + `arcade/input.js`. One throwaway
  "attract demo" game to prove the loop, params, persistence, audio+pose+crowd intents, 60 fps.
- **Phase 1 — launch set (Tier A, ships the feature):** pick ~4 across genres so the crowd-control
  range is obvious. Recommended launch four:
  1. **ACCRETION RUN** (racer) — crowd-lean steering is the showstopper; reuses synthwave projection.
  2. **NULLMUNCHER** (maze) — most iconic, cheapest, crowd-vote-direction reads instantly.
  3. **VOID INVADERS** (shooter) — collective cannon + beat-spawned waves = audio-reactive by design.
  4. **VOIDRIS** (tetris) — fastest to build (port `code.js` tetris), proves the "tidy" genre.
- **Phase 2 — Tier B:** virtual gamepad + `field.players` + per-player avatars; convert Invaders &
  Muncher to individual play; optional **THE CORRIDOR** raycaster/3D wow-piece.
- **Phase 3 — depth:** more genres (fighter with performer punches, side-scroller, frogger, pong),
  per-game presets, auto-phase step list, leaderboard/score overlay.

## 9. Open decisions (need a call before building)

1. **Build now or research-only?** This doc is the research deliverable. Say the word to start Phase 0.
2. **Launch set** — the recommended four (§8), or a different mix?
3. **Tier B timing** — confirm "Tier A first, gamepad second," or do you want the virtual controller
   in the first build?
4. **IP stance** — confirm genre-homages-with-voidstar-skins-and-original-names (strongly recommended)
   vs. literal retro reproductions (not advised for a public/recorded site).

---

## 10. Status — Phase 0 + 1 built (2026-06-19)

Shipped the `arcade` quale (Tier-A: crowd/pose/audio control, no entangle protocol
changes). Registered in `page-init.js` after `video`.

- `fx/arcade.js` — QFXModule shell: `game` select + `controlMode` / `enemyIntensity`
  (bass + beatPulse + crowd.energy modulators) / `pixelScale` / `crt` / `hud` /
  `reactivity`. autoPhase cycles the four games.
- `fx/arcade/engine.js` — fixed low-res cabinet framebuffer + crisp upscale + CRT/
  vignette/scanlines + screen-shake + 3×5 bitmap font + particle pool. Constant fill
  cost regardless of display size.
- `fx/arcade/input.js` — one normalized intent from `field.crowd` (crowd-first) →
  `field.pose.people[0]` (performer) → CPU attract. Edge buttons + DAS repeat.
- `fx/arcade/{accretion-run,nullmuncher,void-invaders,voidris}.js` — the four games.

Verified: `npm run build` clean; headless render-loop sim (3200 frames across all
games × crowd/performer/cpu sources, with live pixelScale + display resizes) — no
throws, no runaway loops, zero NaN/Inf draw coords. Visual polish pending in-browser.

**Deferred to Phase 2 (Tier B):** virtual NES controller (`T.INPUT` gamepad message +
phone D-pad/A-B overlay + `field.players[]` surface + per-player avatars, capped slots);
optional THE CORRIDOR raycaster. Per §7.

### 10a. Autonomy iteration (2026-06-19)

Performer feedback: while playing music you want to *nudge* the avatar with pose cues,
not steer it — the sim should mostly drive itself; an entangled crowd should be tightly
coupled. Added:

- `intent.autonomy` / `playerWeight` in `input.js` — performer ≈ `autopilot` param (0.7
  default, mostly self-driving), crowd ≈ `autopilot×0.2` (tight control), nobody = 1.0.
  New `autopilot` range param. Games blend `lerp(playerSignal, aiSignal, autonomy)`.
- A competent per-game **autopilot**: accretion weaves debris; nullmuncher geodesic-BFS
  to nearest pellet + multi-source ghost-dodge + chase-when-frightened + stall watchdog +
  post-catch invuln; invaders dodges bullets / lines up kills / beat-fires; voidris
  placement-AI stacks tidily.
- accretion: rear-view **red Outrun car sprite** (`eng.sprite` + new pixel-art blitter),
  banks when steering. nullmuncher: **code-glyph pellets** (`0 ; / %` + `*` power) and a
  **freshly randomized maze every board** (DFS spanning tree + braided loops, always
  connected).

Built via a verify-pipeline workflow (implement → adversarial review/fix per game).
Verified: build clean; instrumented headless sim — no throws, 0 NaN/Inf over 6.8M draw
calls, no dead-frame streaks, every game self-drives at zero input, crowd-sway tracks
~3× tighter than performer (autonomy coupling confirmed).

### 10b. Auto-mode high-pass + Testarossa (2026-06-19)

Performer feedback: a *held* playing posture (leaning to play steel) shouldn't steer at
all in `auto`; only deliberate movement should register.

- `input.js`: in `auto` mode the performer's directional signal is now the **high-pass**
  of pose (lean − slow ~1.4s baseline), so a held lean → ~0; autonomy pushed to
  `ap+(1-ap)*0.6` (≈0.88) so the sim is firmly self-driving. New `intent.poseEnergy`
  (movement magnitude) seeds autopilot liveliness without steering. Explicit `performer`
  mode keeps absolute lean (and `autopilot=0` = full manual). Verified by a focused sim:
  held lean drifts laneX 0.03 in auto vs 0.75 at `performer/autopilot=0`.
- `accretion`: new **rear-view Ferrari Testarossa** sprite (34×15, louvred tail + amber
  taillights, authored by rendering to PNG and iterating visually), sized to ~22% screen
  (was ~43%); much stronger **road curve** (continuous sweeping bends + beat kicks,
  clamped so the vanishing point reaches but doesn't clip the screen edge).

### 10c. Ambient pass + 4 more games (2026-06-19)

Performer feedback (todo list): slower/ambient feel, stationary HUDs, and four more
genres. Now **8 games**.

- **Stationary HUDs.** `engine.js` gained a second framebuffer (`hbuf`) composited in
  `present()` WITHOUT the screen-shake offset. `eng.beginHud()/endHud()` switch the
  `text()`/`rect()` draw target to it; every game's HUD block + the shell `drawDiag()` are
  wrapped. The world shakes; the score/diagnostics stay rock-steady (the brief: shake
  read as jarring on the HUD specifically).
- **Global `speed` param** (0.3–1.75, default 1) scales the sim clock for every game
  (`simDt = dt × speed`, capped 0.05 so a slow display + speed-up can't tunnel). Input
  timing stays real-time.
- **Per-game ambient tuning:** `voidris` never hard-drops — pieces settle under gentle
  gravity only (positioned optimally up high, so the slow fall can't spoil placement);
  `void_invaders` swarm motion ~5× slower (`ATTACK=0.2`) + slower bullets + a swarm that
  slips past now silently re-forms (no "you lost" stun/shake); `nullmuncher` 0.8× pace.
- **New games:** `event-pong.js` EVENT HORIZON PONG (top/bottom paddles, bounded-angle
  reflections, long ambient rallies), `voidsnake.js` VOIDSNAKE (flood-fill survival AI +
  tail-reachability invariant → effectively never self-traps; rare graceful soft-reset),
  `the-corridor.js` THE CORRIDOR (the deferred Doom raycaster — DDA per virtual column,
  precomputed wall shade ramps for zero per-frame string alloc, depth-buffered billboard
  wraiths, corridor-locked self-navigating camera so there's nothing to die to),
  `crossvoid.js` CROSSVOID (Frogger — **never dies in auto**, see below).

**CROSSVOID never-die (explicit ask).** Provably-cautious autopilot: per-frame `staySafe`
look-ahead leads every hazard by > one hop; landings must be CENTRAL on a log
(`logContains`, margin > the beat/frame-quantization prediction error — landing on a
log's trailing edge was the main leak); the lane layout brackets every river row with an
always-safe escape row. Subtle bug fixed: the river edge-death zone must sit a cell BEYOND
the playfield (`ax < -0.5 || ax > COLS-0.5`), not at the valid end cells, else landing on a
left-moving log at the last column died instantly.

Verified via a headless render-loop sim (mock canvas flags any non-finite draw coord;
each game's `__test()` probes deaths): `npm run build` clean; no throws / 0 NaN across all
8 games × {cpu, expert, performer-auto, crowd, performer} sources with live
pixelScale/speed sweeps + display resizes. Never-die stress: **crossvoid 0 deaths over
416k frames / 160 random seeds** (auto + expert); voidris / void_invaders / the_corridor
also 0; voidsnake 0–1 graceful soft-resets per ~130k frames. Visual polish pending
in-browser.
