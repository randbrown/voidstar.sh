# Synthwave qfx — implementation spec

Planning doc for a new qualia visualizer. **Not yet implemented.** Read this
first, then `_template.js`, then one reference fx (recommended: `spectrum.js`
for the log-binning + multi-mode pattern, plus `vintage-analog.js` for
multi-mode-with-distinct-renderers within one fx).

Goal: drive home the **80s synthwave / outrun / vaporwave aesthetic** — neon
horizon grid, glowing sun, polygonal mountains, racing-forward perspective —
all reactive to audio. Inspiration image (provided by user) is the iconic
"sun on a perspective grid + neon mountains + spectrum waveform" shot.

The headline behaviour from the user brief: **"the horizon line is actually
an EQ spectrum"** — the mountain silhouette must be log-binned spectrum
data, not a static polygon.

---

## 1. Module shape

| Field         | Value |
|---------------|-------|
| `id`          | `synthwave` |
| `name`        | `Synthwave` |
| `contextType` | `canvas2d` |
| `autoPhase`   | walks the 4 modes (see below) |

Path: `src/lib/qualia/fx/synthwave.js`. Register in
`src/lib/qualia/page-init.js` next to the existing `vintageAnalog` import +
`mesh.register(...)` line.

---

## 2. Phase modes (4)

The `mode` param is a `select` and each entry below maps to one option.
`autoPhase.steps` should walk them in this order.

### 2.1 `horizon` — the headline shot
The image-on-the-tin. Paint, back-to-front:
1. **Sky gradient** (deep purple top → dark magenta horizon).
2. **Stars** — random dots in the upper third, twinkle with `audio.bands.highs`.
3. **Sun disc** centred at the horizon. Hot orange→pink vertical gradient
   inside, with 5–7 horizontal black bands cutting it (the iconic stripe
   sun). Sun's bottom is clipped by horizon line. With palette `void`
   (or the `sunCore` toggle) a dark central disc cuts a cosmic-eclipse
   hole in the middle — the voidstar signature.
4. **Wireframe mountain silhouettes** (background scenery — *not* spectrum):
   1–2 procedural-noise polylines drifting slowly sideways at different
   parallax rates. Stroked with `palette.mountain` colour, low alpha.
   Heights modulated very gently by `audio.bands.mids` (shimmer, not jump).
   These set spatial depth so the spectrum line below has something to
   sit *in front of*.
5. **Spectrum horizon line** (the headline EQ behaviour): log-binned
   `audio.spectrum` drives a polyline running exactly across the horizon
   `y`, peaks rising upward into the mountains. Brighter neon stroke
   (`palette.spectrum` — typically cyan or hot magenta) + glow + a
   lighter fill below the line down to the horizon for solidity.
   **Bin count** ~32 (wider than `spectrum.js`'s 96 — jagged ridge, not
   bar-graph). Idle: smooth sine wave so the screen isn't dead.
6. **Perspective grid floor** — vanishing point at the horizon, grid
   scrolls forward (toward camera). Cell brightness pulses with
   `audio.bands.bass`. On `audio.beat.pulse`, a **shockwave of N rows**
   is highlighted with falloff: the leading-edge row flashes brightest,
   each subsequent row behind it dims by ~50 % until it fades to base.
   N scales with pulse intensity (e.g. `Math.ceil(pulse * 4)`), so a
   soft kick lights 1–2 rows and a hard sub kick lights 4–5. Wave
   advances toward the camera each frame at the grid scroll rate.

### 2.2 `road` — outrun racing
Same backdrop (sky / stars / sun / mountains) but the floor changes:
- Centre of the floor is a darker-shaded **road** (broad cyan strip,
  vanishing-point projected), with white **dashed centre line** scrolling
  toward camera. Dash phase advances faster on `audio.bands.mids` (snare).
- Spectrum horizon line is pulled smaller / further back (lower amplitude).
- Side grid lines remain on the road shoulders.

### 2.3 `city` — neon skyline
Same sky/sun but the mountain layer + spectrum line are replaced by:
- **City silhouette**: rectangles of varied widths along the horizon,
  heights driven by log-binned spectrum (same log map, different render).
  Top of each rectangle has a 2 px hot-pink edge so the silhouette glows.
- "Wet pavement" reflection: a faint, vertically-flipped, alpha-blurred
  copy of the city is painted onto the grid for ~30 % of the floor depth,
  so it reads as the city reflecting off rain on the grid.

### 2.4 `dreamscape` — vaporwave chill
A slower, less reactive mode for the *aesthetic* tier:
- Sun stays. Grid stays but **density halved + scroll speed near zero**.
- Mountain layer + spectrum line replaced by **palm tree silhouettes**
  (2–3 tall stylised palms — straight trunk + a crown of 6–8 frond
  triangles). Fronds sway gently on `audio.bands.mids`.
- Stars more abundant, slower twinkle.
- Optional muted text overlay reading `A E S T H E T I C` (wide-spaced
  caps) sitting just under the sun, very low alpha, drifts horizontally.
  Gated by the `aesthetic` toggle param (default off — see §3).

---

## 3. Param schema

```js
params: [
  { id: 'mode',         type: 'select',
    options: ['horizon', 'road', 'city', 'dreamscape'], default: 'horizon' },

  // Palette swap — recolours sun + mountains/spectrum/skyline + grid.
  { id: 'palette',      type: 'select',
    options: ['classic', 'miami', 'vapor', 'void'], default: 'classic' },
  // classic = orange/yellow sun + cyan grid + magenta spectrum + violet mountains
  // miami   = hot-pink sun + cyan grid + magenta spectrum + purple mountains
  // vapor   = pastel-pink sun + violet grid + cyan spectrum + lavender mountains
  // void    = neon halo around dark eclipse-core sun + cyan grid + magenta spectrum

  { id: 'gridDensity',  type: 'range', min: 6,  max: 32, step: 1,    default: 16 },
  { id: 'gridSpeed',    type: 'range', min: 0,  max: 4,  step: 0.05, default: 1.0,
    modulators: [
      { source: 'audio.bass',      mode: 'mul', amount: 0.6 },
      { source: 'audio.beatPulse', mode: 'add', amount: 0.8 },
    ] },

  { id: 'sunSize',      type: 'range', min: 0.15, max: 0.55, step: 0.01, default: 0.32 },
                                              // fraction of min(W,H)

  { id: 'fog',          type: 'range', min: 0,   max: 1,    step: 0.02, default: 0.55 },
                                              // horizon haze density

  { id: 'stars',        type: 'toggle', default: true },
  { id: 'sunStripes',   type: 'toggle', default: true },
  { id: 'sunCore',      type: 'toggle', default: false },
                        // forces the dark eclipse-core look on any
                        // palette (palette `void` enables it implicitly)
  { id: 'mountains',    type: 'toggle', default: true },
                        // background wireframe ridges (horizon + road modes)
  { id: 'aesthetic',    type: 'toggle', default: false },
                        // dreamscape-only: enables the A E S T H E T I C
                        // overlay text. See §10 Q3 for custom-text note.

  { id: 'reactivity',   type: 'range', min: 0,   max: 2,    step: 0.05, default: 1.0 },
],
```

---

## 4. Audio mapping

| Channel              | Drives |
|----------------------|--------|
| `audio.spectrum`     | spectrum-horizon polyline (`horizon`/`road`) + city silhouette heights (`city`) — log-binned to ~32 bars |
| `audio.bands.bass`   | grid cell glow brightness, sun bloom radius, road shoulder pulse |
| `audio.beat.pulse`   | grid "shockwave": leading row + N-row falloff (intensity-scaled); sun bloom flash |
| `audio.bands.mids`   | mountain ridge shimmer (subtle parallax); road dash scroll-rate boost (snare); palm frond sway in dreamscape |
| `audio.bands.highs`  | star twinkle amplitude; spectrum edge sparkle |
| `audio.bands.total`  | overall sky brightness lift; fog wash |
| `audio.rms`          | minor sun pulse on sustained loud passages |

`reactivity` slider scales all audio reads via `scaleAudio()` (standard
pattern — see `_template.js` line 17).

Idle behaviour (no audio yet): default mountain silhouette uses a sine
wave so the screen isn't dead. Grid scrolls at `gridSpeed` only. Sun
breathes at ~0.3 Hz. Stars twinkle with their own per-star phase.

---

## 5. Visual technique notes

### Perspective grid
Flat 2D projection — no real 3D math needed.
- Pick a horizon `y0 = H * 0.55` (about 55 % down the screen).
- Z-axis runs from horizon (z=∞) down to bottom of canvas (z=0). Use
  `screenY = y0 + (H - y0) / (1 + z*zScale)` so lines bunch at horizon.
- For each horizontal line `i = 0..N`, advance `z` by a step, draw line
  at the projected `y`. Animate by adding `(time * gridSpeed)` to `i`
  and `mod` it so lines scroll forward.
- For vertical lines: project two end-points (one at z=near, one at
  z=horizon), draw a line between them. Use an x-grid that fans out
  with z (further = wider real-world spacing).

### Sun stripes
Draw a filled circle with a vertical gradient (orange→hot pink top to
bottom, or per palette). Then over-paint horizontal black bands from
~50 % to 100 % of the disc height. Bands get progressively shorter
toward the bottom (already cut by horizon). Below the horizon, just
clip — don't draw the lower half.

### Sun core (void / `sunCore` toggle)
Voidstar identity hook. With `sunCore: true` (or implicit on palette
`void`):
- After painting the disc + stripes, draw a smaller dark central disc
  at ~35 % of sun radius. Use near-black (`rgba(5,5,13,0.95)`) so it
  blends with the canvas backdrop.
- Add a thin halo ring at the void's edge in `palette.spectrum` colour
  to sell the eclipse look.
- On `audio.beat.pulse > 0.5`, the halo flares — gives a portal-opening
  feel during loud sections.

### Mountain layer (procedural — *separate from spectrum line*)
2 parallax layers of low-poly mountain silhouettes drifting horizontally
at slightly different rates so they read as depth.
- Generate each layer once in `create()`: pick ~24 vertices spread
  across the canvas width, give each a random base height drawn from
  `noise(i)` (cheap value-noise — 4 octaves of summed sines is fine).
- Each frame, advance each layer's horizontal offset by a slow
  per-layer rate; vertices wrap modulo width.
- Stroke + fill at low alpha. Heights jitter ±4 % with `audio.bands.mids`.
- Disabled when `mountains: false` (param toggle).

### Spectrum horizon line (the EQ — *on top of mountains*)
Sample log-bins (reuse the pattern from `spectrum.js` lines 65–87).
For ~32 bars across the horizon:
- For each bar `i`, peak height = `sampleBar(spectrum, i) * peakRange`.
- Build a polyline: start at horizon-left, then for each bar add a
  point at `(x, y0 - height)`. Linear interpolation is fine — peaks
  pointing up read as ridge spikes.
- Stroke twice for glow: wide (`lineWidth: 6`, low alpha) for bloom,
  then narrow (`lineWidth: 1.5`, full alpha) for the beam — same
  pattern as vintage-analog's oscilloscope mode.
- Below the polyline, fill with a vertical gradient from
  `palette.spectrum` (top) to near-transparent (bottom) for solidity.
- Idle (no spectrum): `Math.sin(time + i * 0.4) * 0.4 + 0.4` per bar.

### Grid kick shockwave
On every frame, track an array of *active wavefronts* — each is `{ z,
intensity }` advancing toward the camera (decreasing `z`) and decaying
in `intensity`.
- On a kick frame (`audio.beat.active`), push a new wavefront with
  `z = horizonZ`, `intensity = audio.beat.pulse`.
- Per frame, advance each wavefront's `z` by `gridSpeed * dt * waveSpeed`
  and decay `intensity *= 0.92` (~half-life of ~250 ms at 60fps).
- For each wavefront, light the **N nearest grid rows** behind it where
  `N = Math.ceil(intensity * 4)`. The leading row gets full
  `intensity`, each row behind gets `intensity * 0.5^k` (so 4-row
  ripple goes 1.0 / 0.5 / 0.25 / 0.125).
- Drop wavefronts whose `intensity < 0.05` or that have crossed the
  near plane. Cap to ~6 active wavefronts (rarely more on dense music).

### Stars
Allocate ~120 stars on first frame: `{x, y, basePhase, brightness}`.
Each frame: `alpha = brightness * (0.5 + 0.5 * Math.sin(time*2 + basePhase))`.
Boost `alpha` by `audio.bands.highs * 0.5`.

### Palm trees (dreamscape only)
Simple silhouette:
- Trunk: 3 px wide black line, slightly curved (use a Bezier or two
  line segments).
- Crown: 7 fronds, each a thin triangle radiating from the top of the
  trunk at angles -60°…+60° (15° apart). Slightly waving on `audio.bands.mids`.
- 2–3 palms total, asymmetrically placed so they don't look like a
  picket fence.

### A E S T H E T I C overlay (dreamscape only, opt-in)
- Gated by `aesthetic` toggle (default off — see §10 Q3).
- Wide-letter-spaced uppercase. `letter-spacing: 0.5em` equivalent (in
  canvas2d, just `ctx.fillText` letter-by-letter with manual spacing).
- 8 % alpha, slow horizontal drift (`x += dt * 6`, wrap around).
- Font: same `ui-monospace, monospace` we use elsewhere; size ~`H * 0.06`.
- Text content is hardcoded `"A E S T H E T I C"` in v1. The user
  asked about a customisable string (§10 Q3); see that section for
  why this is deferred. If we add `ParamText` later, just swap the
  literal for `params.aestheticText`.

---

## 6. Palette table

Use HSL string templates so palette swap is a one-line change.

Each palette has six slots — sky-top / sky-horizon / sun-top / sun-bot /
mountain (background ridge) / spectrum (EQ line) / grid. With the new
mountain+spectrum split, mountains and spectrum get *separate* colours.

| name    | sky-top       | sky-horizon    | sun-top       | sun-bot       | mountain      | spectrum      | grid         |
|---------|---------------|----------------|---------------|---------------|---------------|---------------|--------------|
| classic | `260,80%,8%`  | `320,75%,18%`  | `45,100%,60%` | `15,100%,55%` | `260,40%,30%` | `320,90%,60%` | `190,90%,55%` |
| miami   | `285,85%,10%` | `330,80%,20%`  | `330,95%,65%` | `300,95%,55%` | `270,40%,28%` | `330,95%,62%` | `185,90%,55%` |
| vapor   | `260,60%,12%` | `280,55%,22%`  | `330,80%,75%` | `260,75%,55%` | `260,30%,40%` | `190,85%,68%` | `285,75%,55%` |
| void    | `250,90%,4%`  | `260,80%,10%`  | `15,100%,55%` | `330,90%,50%` | `250,30%,20%` | `190,95%,60%` | `190,85%,55%` |

Palette `void` skews darker overall and pairs with `sunCore: true` to
sell the "eclipse-portal" voidstar-identity look.

(These are starting points — tune by eye in-browser.)

---

## 7. Presets

```js
presets: {
  default:     { mode: 'horizon',    palette: 'classic' },
  horizon:     { mode: 'horizon' },
  miami:       { mode: 'horizon',    palette: 'miami'  },
  voidstar:    { mode: 'horizon',    palette: 'void',   sunCore: true },
  road:        { mode: 'road',       palette: 'classic'},
  'road-night':{ mode: 'road',       palette: 'miami',  stars: true },
  city:        { mode: 'city',       palette: 'miami'  },
  vapor:       { mode: 'dreamscape', palette: 'vapor', aesthetic: true },
  dreamy:      { mode: 'dreamscape', palette: 'vapor', gridSpeed: 0.2, aesthetic: true },
},
```

---

## 8. AutoPhase

```js
autoPhase: {
  steps: [
    { mode: 'horizon' },
    { mode: 'road' },
    { mode: 'city' },
    { mode: 'dreamscape' },
  ],
},
```

(Optional follow-up: an `autoPhase` that *also* cycles the palette would
be cool — `{mode:'horizon', palette:'classic'}, {mode:'horizon', palette:'miami'}, ...`
— but that doubles step count. Skip in v1; user can use the topbar
`cycle` button across qfx if they want more variety.)

---

## 9. Performance notes

- Star list, mountain bar buffer, palm geometry: allocate once in
  `create()`, reuse every frame.
- Grid drawing is the per-frame cost ceiling. With `gridDensity = 16`
  that's 16 horizontal lines + 32 vertical lines ≈ 48 stroke calls
  per frame — fine on canvas2d.
- City rectangles: 32 × `fillRect`. Trivial.
- Sun stripes: 6 `fillRect` calls. Trivial.
- The reflection in `city` mode is the most expensive operation —
  `drawImage` of the silhouette canvas vertically flipped with low
  alpha. Use an offscreen canvas reused across frames (same pattern
  as `spectrum.js`'s waterfall buffer, lines 91–101).

---

## 10. Resolved decisions

(All five original open questions have answers — recorded here for the
implementing agent.)

1. **Mode count** → **4** modes: `horizon`, `road`, `city`, `dreamscape`.
2. **Palette** → **separate param** with 4 options: `classic`, `miami`,
   `vapor`, `void`. (`void` adds voidstar-identity eclipse vibe.)
3. **`A E S T H E T I C` text** → **opt-in toggle** (`aesthetic`,
   default off). Custom user-defined text was requested as a bonus but
   needs a new param type — see Q3a below.
4. **Idle sine for spectrum** → **yes**, smooth sine when audio is off
   (matches chladni's lissajous idle pattern).
5. **Grid kick pulse** → **multi-row shockwave with intensity-scaled
   falloff** — leading row at full pulse, each row behind dims by ~50 %.
   Number of lit rows scales with `audio.beat.pulse` (1 row for a soft
   tap, 4–5 for a hard sub kick).

### 10a. New question opened by external brief

**Q3a (deferred): customisable AESTHETIC text string.**
Our `ParamSpec` union (`types.js:96-116`) only has `range` / `toggle` /
`select`. There's no free-text input type. Adding one requires:
- Add `ParamText` to `types.js` (define + add to union).
- Render a `<input type=text>` in the param panel builder
  (`ui.js`) — needs styling that matches `qp-toggle` / `qp-select`.
- Persist the value through the existing per-fx settings mechanism
  (it should "just work" since `core.setParam` already handles
  arbitrary values).
~30 LOC across 2 files. Low risk but a real refactor. **Recommendation:
defer to v2** — ship synthwave first with the literal `A E S T H E T I C`
string, then add `ParamText` as a separate PR if we still want it.
(Other future fx — track titles, label text, etc — would also benefit
from `ParamText`, so the value isn't synthwave-specific.)

### 10b. Cross-walk against external brief

The external brief proposed several ideas that were considered and
**rejected** (or absorbed differently) for v1:

| External brief idea | Decision | Why |
|---|---|---|
| CRT scanlines / VHS noise / chromatic aberration | reject | Duplicates existing `mosh` and `ascii` post-fx that already overlay any qfx. Users who want grit can layer those. |
| Real low-poly 3D wireframe mountains | reject | Canvas2d, no 3D math. Procedural-noise silhouettes read as wireframes at this scale. |
| CLI options / `--preset` flags | reject (different system) | Qualia uses schema-driven presets, not CLI. Already covered in §7. |
| Voidstar portal as 5th mode | absorbed into palette+toggle | `palette: 'void'` + `sunCore: true` gives the same vibe inside the existing 4-mode set. User said 4 modes is good. |
| Embedded perspective text | reject | Way out of scope for v1. Maybe a future "logo" fx. |
| Multi-layer parallax mountains | absorbed | 2 layers integrated into §5 mountain spec. |
| Mountains separate from spectrum | absorbed (key fix!) | Brief was right that the inspiration image shows both. §2.1 + §5 updated. |
| Forward shockwave on kick | absorbed | Matches your Q5 multi-row falloff answer. §5 has the wavefront algorithm. |

---

## 11. Implementation checklist (when greenlit)

- [ ] Copy `_template.js` → `synthwave.js`, fill in id/name/contextType.
- [ ] Implement palette table (4 entries) + helper `getPalette(name)`
      that returns an object of resolved HSL strings.
- [ ] Implement `drawSky(palette)` (vertical gradient backdrop).
- [ ] Implement `drawStars(time, audio)` — lazy-init list of ~120,
      twinkle phase per star, boost on `audio.bands.highs`. Gated by
      `stars` toggle.
- [ ] Implement `drawSun(palette, audio, params)` — vertical-gradient
      disc + horizontal stripes (gated by `sunStripes`) + optional
      dark eclipse-core (gated by `sunCore` or `palette === 'void'`).
- [ ] Implement `drawMountains(palette, audio, time)` — 2 parallax
      procedural-noise polylines, slow drift. Gated by `mountains`.
- [ ] Implement `drawSpectrum(spectrum, palette, audio, time)` —
      log-binned polyline at horizon, glow + beam stroke pattern.
      Idle: sine fallback.
- [ ] Implement `drawGrid(params, audio, time, wavefronts)` —
      perspective floor + per-frame wavefront update + multi-row
      kick shockwave with falloff. Cap to ~6 wavefronts.
- [ ] Implement `drawRoad(...)` for `road` mode (cyan strip + dashed line).
- [ ] Implement `drawCity(spectrum, palette, audio)` + flipped reflection.
- [ ] Implement `drawDreamscape(...)` — palms (sway on mids), optional
      AESTHETIC overlay (gated by `aesthetic` toggle).
- [ ] Wire `update`/`render` split (cache audio + params + wavefronts
      array in update; render in render).
- [ ] Register in `page-init.js` (line ~23 import, line ~78 register).
- [ ] `npm run build` clean.
- [ ] Eyeball each mode + each palette in browser w/ audio on + audio off.
