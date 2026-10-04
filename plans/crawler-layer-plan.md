# Crawler layer — research + design log

*Point-in-time build log (Oct 2026). For current behaviour read `docs/architecture.md`
("Crawler layer") and `src/lib/qualia/crawler.js`; this file records the research and the
why.*

## 1. The reference

**Artist:** Slava Rybin, **@rybinfx** (rybinfx.com · instagram/tiktok/x `@rybinfx` ·
github.com/rybinfx · hello@rybinfx.com). Self-described "systems artist exploring perception,
feedback, complexity" — TouchDesigner, GLSL, Python, WebGL; based in Thailand/Bali. Prior work:
ORBITA (Signal festival 2024), a run of TouchDesigner grid/"bugs"/anisotropic-damping studies on X.

**The piece:** posted 1 Oct 2026 as **"Web crawlers /[•]\ #js x #css"** (X) — the Instagram reel
in the request is the same work ("Web crawler /// [•] \\\", Aphex Twin "Cock/ver10"). An
eight-legged line spider scuttles over a scrolling Wikipedia reference list about spiders, chases
the cursor, and every foot grips a real word/link; gripped elements get boxed, enlarged,
recoloured, skewed; a thin amber dragline trails from the body to a distant element.

**Correction to the request:** the artist tags it **JS × CSS**, not TouchDesigner. The page is
real DOM text (every word wrapped in a span), the legs are a transparent `<canvas>` on top, and
the highlights are CSS classes toggled on the spans/links. No screen capture is involved.

**Source:** Rybin publishes **no source** for it — no repo, Patreon, Gumroad, `.toe`, tutorial or
write-up (his only public repo is `pixy-processing`, 2017 evolutionary shaders, MIT, unrelated).
What exists is a cluster of third-party clean-room recreations made within days of the post,
all crediting him:

| Repo | Licence | Notes |
|---|---|---|
| github.com/adampog/literal-web-crawler | MIT | DOM-free engine + host interface (`footholdNear`, `tearOff`); fixed alternating tetrapod groups; two-bone IK. The technique source for our sim. |
| github.com/cyohei9907/web-crawlers | none (all rights reserved) | Most faithful look: `elementFromPoint` anchoring, threshold gait, CSS mutation taxonomy, scroll-following camera. Read for technique only — nothing vendored. |
| github.com/majidmanzarpour/threejs-procedural-spider | MIT | Three.js variant, body tilt from the plane of planted feet. |
| github.com/felixyu9722/WebCrawlerMY | MIT | Canvas 2D, heavier on FX. |
| github.com/Sheraff/spider-inverse-kinematics | none | 279-line minimal mouse-chasing canvas spider. |

Background reading for the model every one of these uses: Ryan Juckett, *Analytic Two-Bone IK
in 2D*; weaverdev, *Procedural Animation Tutorial* (home-position stepping, "don't step while
the neighbour steps"); Merxon22, *Recreating Rain World's 2D procedural animation*.

## 2. The technique, reconstructed

1. **Body steering.** Position + velocity; target = pointer or a random waypoint; ease the
   velocity toward a capped speed, slow on arrival; heading lerps toward the velocity.
2. **Legs.** 8 legs = rest angle/offset per leg relative to the heading; two bones
   (L1 ≈ 0.56·reach, L2 ≈ 0.64·reach) solved by the law of cosines with a **fixed bend sign per
   leg** so knees never flip.
3. **Gait.** Each foot has a rest spot (hip + rest vector rotated by heading). A planted foot
   stays glued in page space while the body moves. It steps when `|foot − rest| > stride·reach`
   **and** the opposite gait group is on the ground → emergent alternating tetrapod. Overstretched
   legs step urgently. Step target = rest + velocity lead; swing 0.07–0.17 s, smoothstep, with a
   "lift" done by pulling the foot toward the hip (top-down 2D). Idle twitches when stopped.
4. **Anchoring.** When choosing a landing, sample `document.elementFromPoint` around the step
   target (or a spatial hash of word rects) and snap to the nearest word/link; re-derive the
   planted foot from the element rect each frame so it rides scroll/reflow.
5. **Highlights.** On plant, toggle a short-lived CSS class on the gripped element (outline,
   fill, monospace enlargement, rotate, skew, strike…), batched into one commit per frame.

## 3. What translates to qualia, and what doesn't

- A quale is **pixels, not words**: there is no DOM to `elementFromPoint`. The pixel-space
  equivalent is a low-res **feature grid** (luma + gradient) of the composited scene; feet seek
  the strongest *edge* near their intended landing and box the connected bright blob they grip.
  On the Code / Text / Liner Notes quales that lands feet on glyphs — closest to the reel; on
  particle quales it grips particles; on a flat dark quale it walks bare floor.
- "Scroll following" has no analogue (nothing scrolls), so the body simply chases.
- The overlay already owns the right canvas: stage-registered, device-pixel space, already
  readback-capable (the edge post), already recorded by the recorder composite and scoped by the
  cam walk. So the crawler is an **overlay layer** (`opts.crawler`, like sparks/ripples), **not**
  a post (it must stack with the glitches) and **not** a quale (it has to ride over any quale).
- Targets: pointer (passive `pointermove` on window, mapped through the stage rect), the most
  visible wrist of person 0 via `lmToCanvas` (EMA + 1.5 s linger — never snap on a dropout), or
  autonomous wander. `auto` prefers a pointer that moved in the last 3 s, then pose, then wander.
- Audio: beat pulse quickens steps and bounces the body, bass crouches it, highs make the legs
  tremble — all through the layer's `reactivity`, all eased.

## 4. What shipped

- `src/lib/qualia/crawler.js` — DOM-free: `solveTwoBone`, `createFeatureGrid` (ingest / seek /
  blob), `createCrawlerSim` (steering, gait, anchoring, audio envelopes), `drawCrawler`
  (Canvas2D renderer; `theme` / `reel` / `mono` palettes).
- `overlay.js` — `crawler` option + `crawlerConfig`, pointer tracking, scene sampling
  (Hydra ⊕ fx canvas, or the active post canvas) into a ≤128-cell grid every 4th frame, tick +
  draw on the pose canvas (lands in recordings for free).
- `page-init.js` / `qualia.astro` — `crawler` button in the layers ▾ group (⇧B), a crawler card
  (follow, legs, size, speed, stride, anchor, boxes, silk, reactivity, palette, reset), settings
  persistence, qualem save/recall, button+card repaint at the `setOption` choke point.
- `code-api.js` — `qualia.crawler({...})`; `qualia.overlay('crawler', on)` toggles (pattern
  lanes work: `qualia.overlay('crawler', "<0 1>")`).
- `scripts/check-qualia-crawler.mjs` — 47 node checks (IK, grid, gait invariants, anchoring,
  audio response, rescale); wired into `npm run check`.

## 5. Round two (same day)

- **Packs + per-person:** `count` 1–4 or `'pose'` (one creature per tracked person, min 1). In
  pointer/auto modes creature 0 chases the pointer and the rest wander; in pose/auto creature *i*
  chases person *i*'s most visible wrist. Sims are independent instances; spawn points are spread.
- **Re-blits:** gripped patches are re-printed from the scene canvas (fx canvas, or the post
  canvas when a glitch is up) with a per-foot treatment chosen at plant — zoom, tilt, skew, or
  negative (`filter: invert(1) hue-rotate(180deg)`) — additive, fading with plant age. The pixel
  version of the reel's enlarged/skewed/recoloured words.
- **Body modes:** `frame` (outline), `lens` (the pane is a see-through negative of the *raw*
  fx scene — the null-portal idea carried around), `hole` (the inverse: the overlay paints a
  full-frame negative onto the post canvas, or reuses an active glitch post, and *clears* the
  pane out of it so only the body shows the raw scene). First cut had the lens sampling the post
  canvas and the hole falling back to lens without a post, which made the two indistinguishable
  — negative∘negative is identity. Fixed by giving the hole its own field and the lens the raw
  scene.
- **Void body (hole retired):** `hole` (the full-stage negative with the body as the clear
  window) was dropped after a session with it — not a performance tool. Replaced by `void`: a
  true-black ellipse along the heading with a gravitational-lensing rim. Six concentric annular
  slices of the raw scene are re-drawn through an even-odd ellipse clip, each scaled toward the
  horizon (up to 1.55×) and twisted (up to 0.28 rad, slowly breathing) a little more than the
  last, then a thin photon ring in the core colour sits on the edge and flares on beats. Six
  small `drawImage` calls per creature; no readback. Stored `body: 'hole'` migrates to `void`.
- **Leg counts 4–8:** layouts are generated per count (pairs spread front→rear, widest in the
  middle); an odd count adds one unpaired trailing leg on the right with its knee bent inward,
  in the gait group opposite the rear pair — a lopsided scuttle.
- **Logo latch:** `follow: 'logo'` (and the auto fallback after pointer + pose) steers the pack
  around the logo mark's rect, fanned by index; any foot landing within half a reach of the
  rect's perimeter snaps to it and boxes the whole mark, so the creature climbs the mark as it
  drifts. The page hands the overlay `logoMark.getStageRelRect()` via `setCrawlerSources`.

## 6. Known limits / next steps

- Feature sampling costs one small WebGL→2D readback every 4th frame. Fine on a GPU; under
  software GL it shows as a p90 spike. `anchor = 0` skips sampling entirely (degradation path).
- The grid samples the *raw* fx buffer; with the cam walk on and the pose overlay pinned (the
  walk's `pose` scope off) the feet grip slightly offset features — the same caveat the pinned
  posts already carry.
- Re-blits and the lens body sample the fx canvas (not Hydra) when no post is active; over a
  Hydra-only scene they show nothing. Compositing Hydra into the scene source is a follow-up.
- The logo is gripped as a rectangle; the mark itself is round. Gripping its silhouette would
  need the mark canvas sampled into the feature grid (it is screen-blended above the overlay).
- A `body: 'logo'` mode (the creature *carries* the void* glyph as its body) is the other way
  to marry the two layers; the mark's sprite bake would need exporting from logo-mark.js.
- Crowd input: `field.crowd.x/y` as a fifth `follow` source would let the audience steer it.
