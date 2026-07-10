# Theme Design Guide — for agents building voidstar.sh themes

*The taste-and-judgment layer for designing a custom theme.* This is the brief
you read **before** you touch a line of CSS. It tells you what a voidstar theme
*is*, the UX bar it has to clear, how to give it a distinct point of view, and
how several agents can each build one without producing ten variations of the
same purple.

It is deliberately **complementary** to two existing docs — read all three:

| Doc | Answers |
|---|---|
| **this file** (`docs/theming-guide.md`) | *What should I make, and why? How do I make it good and make it different?* — design intent, UX rules, palette taste, the per-agent brief. |
| [`docs/THEMES.md`](THEMES.md) | *How is it wired?* — the token system, file map, the JS knob bridge, skin layers, the build checklist. The mechanical source of truth. |
| [`docs/agent-reference.md`](agent-reference.md) | *What is the world?* — the voidstar / Randyland brand canon, palettes, mythology, voice, dos & don'ts. |

Workflow in one line: **read this for the idea → read `agent-reference.md` for
the brand → build it per `THEMES.md` → verify against both checklists.**

---

## 1. Why themes matter more here than on a normal site

qualia (`/qualia`) is the flagship — a **live audiovisual instrument** that a
solo performer drives on stage, projected large, in a dark room, alone, unable
to stop and debug. It is the most public-facing, highest-impact surface in the
whole project. A theme is not a color scheme bolted onto a dashboard; it is the
**stage identity** of the instrument for a whole set. Every performer should be
able to pick a theme that feels like *their* rig.

One `data-theme` attribute reskins the entire site *and* the labs together —
chrome (CSS) and canvas visuals (JS knobs) both follow it. So a theme you build
is judged in two very different contexts at once:

- **The marketing site** (`/`, `/posts`, `/about`) — read up close, on a phone
  or laptop, like any website. Contrast and legibility rules apply hard.
- **The live HUD + canvas** (`/qualia` and the labs) — read at *stage distance*,
  over a busy moving visual, in peripheral vision while the performer's hands
  and attention are on an instrument.

The second context is the one people forget and the one that matters most. Design
for it first; the site mostly comes along for free.

---

## 2. Non-negotiables — the UX bar every theme must clear

These are not stylistic preferences. A theme that fails any of them is a bug,
not a taste difference. (They descend from the project's `AGENTS.md`
non-negotiables — "realtime first, performer stays in control, stay
on-aesthetic" — applied to chrome.)

1. **Legible from across a room.** The HUD is glanced at, not read. Labels,
   meters, the active-fx name, the τ clock, mute/level states must resolve in
   peripheral vision at projection scale. If you have to squint at your laptop,
   it's illegible on a wall.
2. **Never hide the music.** The visual field is the point; the chrome sits on
   top of it. Panels use translucent "glass" surfaces (`--surface-glass`) for a
   reason — the fx must stay visible underneath. Don't turn a theme into opaque
   slabs unless the *metaphor* demands it (see win95), and even then keep the
   canvas breathing through.
3. **Dark-first.** voidstar is "dark, code-cosmic, minimal." Light themes are
   allowed (win95, glacial lean bright) but they are the hard case: you must
   then solve contrast on *both* the pale panels **and** the dark canvas/page
   background behind them (see the "light themes on dark surfaces" gotcha in
   `THEMES.md`). Don't ship a light theme without doing that work.
4. **Contrast is a WCAG floor, not a vibe.** Small text ≥ 4.5:1 against its
   *actual* background — check it on the teal/dark areas, not just the panel.
   Slider thumbs and mod pills must be findable against the panel. A gorgeous
   palette that fails contrast is a failed theme.
5. **Restraint over spectacle.** The brand north stars are restraint and glitch,
   not maximalism. No generic EDM neon, no stock cyberpunk, no SaaS-dashboard
   gradients, no particle-soup chrome. A theme should feel *composed*, like it
   was made by one person with a point of view.
6. **Glow costs frames.** `--glow-strength`, `--viz-glow`, and `--panel-blur`
   drive real GPU work (CSS bloom + `backdrop-filter`). The instrument targets
   30+ fps at 1080p. A high-bloom theme (abyssal, glass, visioneer) must still
   hold framerate — verify it, don't assume it.
7. **Respect reduced motion.** Any looping/decorative animation your theme adds
   (CRT flicker, shimmer, pulse, blink) must damp under
   `prefers-reduced-motion: reduce` — collapse to instant, but keep
   hover/focus/active *end-states* visible. There's a block for this at the
   bottom of `themes.css`; extend it, don't bypass it.
8. **Touch targets survive.** On coarse pointers, sliders and buttons keep their
   larger hit sizes. Don't shrink a control so far for looks that a thumb can't
   grab it on a phone.
9. **Voidstar stays a no-op.** The default `voidstar` theme must look **identical
   to `main`** after your change. If you touched a shared/global rule and moved
   the default, you broke it. Themes are additive overrides, never edits to the
   baseline look.

---

## 3. The design process

Don't start in the CSS. Start with an *idea* and end in the CSS.

### Step 1 — Find the one lever (the signature)

Every shipped theme has **one defining idea** it is organized around, not five.
phosphor = a mono CRT terminal. tape = warm lo-fi tape with film grain. win95 =
beveled net-art desktop. glass = leaded jewel-glass. Before choosing any color,
write your theme's signature as a single sentence:

> "This theme is ⟨_the one thing_⟩."

If you can't say it in a sentence, you have a palette, not a theme. The lever is
what makes it *distinct from the other nine* and what a performer picks it *for*.

### Step 2 — Mood in words, then a reference world

Write the mood as a short word-cluster (the way `agent-reference.md` does:
"handmade, psychedelic, porch-coded, stained-glass cosmic"). Name a concrete
reference world — a place, an object, an era, a material — so every later choice
has something to answer to. "Nordic ECM record sleeve." "Oscilloscope in a dark
lab." "Blueprint drafting table." Abstract moods produce mushy themes.

### Step 3 — Palette (see §4)

Derive the void → surface → text ramp and the five accents from the mood. Keep
it in-family and distinguishable. This is where most of the character lives.

### Step 4 — Canvas knobs (see §4)

Set the `--viz-*` knobs so the pose skeletons, spectrum bars, and beat washes
recolor into your family. This is the half of the theme that lives *on the
canvas*, and it's the half agents most often forget. A theme that only restyles
buttons but leaves the particles purple is half-built.

### Step 5 — Chrome material / UI perspective (see §5)

Decide the *feel* of the controls — flat or beveled, sharp or round, glowing or
matte, which font, what texture. This is where your theme gets a **point of
view** rather than just a hue. Reach for a skin layer only if you're changing
the chrome *metaphor*.

### Step 6 — Verify (see §7)

Run the full checklist across the site and every lab, in both light and dark
system settings, with reduced motion on, on mobile widths, and confirm the
default is unchanged.

---

## 4. Palette & canvas — the part that carries the character

Full token reference lives in `THEMES.md`. Here's how to *choose*, not where the
tokens are.

### The surface ramp

`--void / --void-2` (page), `--surface / --surface-2` (opaque cards),
`--text / --text-muted / --text-dim` (three tiers of text). The translucent HUD
panels (`--surface-glass*`) are auto-derived from `--void`, so a coherent frosted
panel comes free once you set the void well. Pick the void first; much else
follows.

### The five accents — these paint the canvas, not just buttons

```
--accent   --cyan   --pink   --green   --amber   (+ their -glow variants)
```

Read this twice: **these five colors are what the pose skeletons, beat washes,
HUD bars, spectrum ramps, and audience ripples are built from** (via
`readKnobs().ac`). Choosing them well is choosing your theme's *canvas*
character, not just its accent buttons. Rules of thumb:

- **In-family but distinguishable.** They color different *people* (audience
  skeletons) and different *frequency bands* — if two accents are near-identical,
  those readouts collapse into mush. Keep them relatives, keep them separable.
- **Map them to the mood.** A Nordic theme's five accents are five icy neighbors;
  a solar-plasma theme's are gold→magenta→orange heat. The set *is* the theme.
- **`--accent` is the lead.** It's the dominant chrome color and the primary
  skeleton hue. Choose it to be the thing someone remembers.

### The canvas knobs

```
--viz-bg  --viz-hue-base  --viz-hue-spread  --viz-sat  --viz-light  --viz-glow  --viz-mono
```

These drive the JS-side visuals (cached via `readKnobs()`, re-read on theme
change). `hue-base` + `hue-spread` define the arc the particles/spectrum sweep;
`--viz-mono: 1` collapses everything to one hue (phosphor/amber's monochrome CRT
look). `--viz-glow` is the canvas bloom multiplier — the lever for "how much does
this theme *radiate*." Set these so a spectrum sweep or a particle field lands
inside your color family; don't leave them at the voidstar defaults or your
canvas will be purple no matter what the buttons look like.

### The code filter

`--code-filter` is a CSS filter over the embedded Strudel editor + scope canvases
(their syntax colors live in shadow DOM, so a filter is the only reliable lever).
Use `sepia()`+`hue-rotate()` to duotone the code into your family, or `none` to
leave it. A theme where the HUD is warm tape but the live code is still stock-blue
reads as unfinished — pull the editor into the family.

---

## 5. Giving a theme a distinct UI *perspective*

This section is the point of running several agents. Variety in *color* is easy;
variety in **perspective** is what makes a set of themes feel like it came from
different minds. A theme's perspective is its **chrome metaphor** — the implied
material and world of the controls. Levers you can pull:

- **Material & bevel.** Flat glass (voidstar), sunken troughs and raised bevels
  (win95), frosted heavy blur (glacial), leaded panes (glass). The `--ctl-*`
  token tier + an optional skin layer control this.
- **Radius.** `--radius` from `0` (sharp terminal) to soft organic curves
  (gardens' dew-drops). Corner language sets tone before color does.
- **Glow / blur.** `--glow-strength` and `--panel-blur` — does the chrome
  *emit light* (abyssal, visioneer) or sit *matte and physical* (win95, tape)?
- **Texture.** The overlay layer (`--tex-scanline`, `--tex-grain`) — CRT
  scanlines, film grain. Add a new overlay only if the metaphor needs one
  (e.g. a risograph halftone), and wire it as a `body::before/::after` layer.
- **Typography.** `--font-ui` / `--font-mono` — VT323 pixels vs JetBrains Mono
  vs a system sans changes the whole personality. Add a webfont at the top of
  `themes.css` if the theme needs one.
- **Control identity.** The signature move: each theme gives its **sliders and
  mod pills** a distinct material (voidstar's neon waveform rail, phosphor's
  terminal progress bar, tape's fader slot, win95's sunken trough, gardens'
  dew-drop stem). This is where a performer's hand meets the theme. Give yours
  one — it's the difference between a reskin and an identity.

**Depth ladder** — how far to push:

| Level | You touch | Use when |
|---|---|---|
| **Tokens only** | palette + knobs | the metaphor is "voidstar, but ⟨color⟩". Rare now — all shipped themes go further. |
| **+ control identity** | a `--ctl-slider-*` / mod-pill block | you want the *hand-feel* to differ (most themes). |
| **+ skin layer** | a scoped `[data-theme="x"] …` block | you're changing the chrome *shape/metaphor* (bevels, title bars, panes). win95/glass/visioneer/gardens are the references. |

A good theme usually reaches at least "control identity." Reaching "skin layer"
is what buys a genuinely different *perspective* — so if the goal is variety
across agents, bias toward giving at least some of them a skin-level idea.

**Anti-patterns** (these read as "generic," which is the one unforgivable note):
EDM rainbow neon, undifferentiated cyberpunk, SaaS dashboard gradients, drop
shadows everywhere, five accents that are all the same blue, particle-soup
chrome that competes with the fx.

---

## 6. Running several agents — the brief template

When you (the human or an orchestrating agent) hand this out to N theme-building
agents, give each one a filled copy of the brief below. The constraints keep them
**coherent** (same system, same UX bar) while the assignment keeps them
**divergent** (distinct lever, distinct perspective).

### Rules of the road (give these to every agent)

1. **One new `[data-theme="…"]` block per agent.** Pick a unique lowercase id.
   Register it in *two* places only: `THEMES` in `src/lib/qualia/theme.js`
   (id + label) and the block in `src/styles/themes.css`. `ThemeBoot.astro`
   derives its list from `THEMES` automatically.
2. **Never edit another theme's block, and never move `:root`.** Themes are
   additive. Touching shared/global rules or the default palette is how you break
   everyone else. If two agents work in parallel, they only ever *append* their
   own block → clean merges.
3. **Own your lever.** No two agents ship the same signature. Coordinate on the
   one-sentence signatures up front so you don't get two CRT themes.
4. **Finish the canvas, not just the chrome.** Set the `--viz-*` knobs and the
   `--code-filter`. A tokens-only "buttons are teal now" submission is not done.
5. **Self-verify before handing back** (§7). Include which themes you compared
   against so a reviewer can trust it's diverse, not a near-duplicate.

### The per-agent brief (copy, fill, hand out)

```md
## Theme brief — <id>

**Signature (one sentence):** This theme is <the one thing>.
**Reference world:** <place / object / era / material it answers to>
**Mood words:** <5–8 words>
**Niche it owns:** <e.g. "harsh-noise set", "long-form drone", "daytime demo">
**Depth target:** tokens-only | + control identity | + skin layer

**Palette intent**
- void / surface / text ramp: <describe>
- --accent (lead): <what it is + why memorable>
- --cyan / --pink / --green / --amber: <the family, kept distinguishable>

**Canvas knobs intent**
- hue-base / spread / sat / light: <the arc the particles+spectrum sweep>
- --viz-glow: <how much it radiates>  ·  --viz-mono: <0 or 1>
- --code-filter: <how the Strudel editor is pulled into the family>

**UI perspective**
- control identity (slider rail + mod pill material): <the hand-feel>
- radius / glow / blur / texture / type: <the metaphor levers you pull>
- skin layer? <only if changing chrome shape — describe the metaphor>

**Must clear:** all §2 non-negotiables + the §7 checklist.
**Compared against (for diversity):** <2–3 existing themes it must NOT resemble>
```

### A diversity checklist for the whole batch

Before accepting a set of agent-built themes, confirm the batch actually varies:

- [ ] No two share a **lever** (two "terminal green" themes = cut one).
- [ ] The batch spans the **depth ladder** — not all tokens-only; at least a
      couple carry a skin-level perspective.
- [ ] Light/bright vs deep-dark is represented, not all one brightness.
- [ ] Control identities are visibly different when you drag a slider in each.
- [ ] Each canvas (particles/spectrum/skeleton) reads as a *different family*,
      not the same field recolored.

### Seed assignments (ready to hand out)

From the `THEMES.md` "ideas parking lot," each is roughly one block (+ a skin
layer where noted) and each has a built-in lever, so they're good starting
briefs that won't collide:

- **Gargantua / Accretion** — black + accretion-gold + cyan rim (the black-hole
  fx aesthetic as a global theme).
- **Ember Ritual** — ember-red on charcoal, occult serif accent (dark ambient).
- **Solar Plasma** — gold↔magenta plasma on black (cosmic ambient).
- **Mycelial** — soil browns & fungal off-whites, subterranean (a darker sibling
  of the shipped **gardens** theme).
- **Risograph** — 2–3 flat spot inks on warm paper, grain + halftone (needs a new
  texture overlay).
- **Teletext / Mode 7** — chunky blocky palette, scanlines, big type (skin-ish).
- **Blueprint / Drafting** — cyan lines on navy, monospace, low-glow.

Pull the brand-anchored palettes for these from `agent-reference.md` (§5
voidstar palette names accretion gold, neural magenta, plasma orange, ghost
green, CRT phosphor white on a `#000000 / #050816 / #0A0F2A` void with
`#00D4FF / #66F0FF` cyans — a ready accent set to draw from).

---

## 7. Deliverable & self-verification checklist

A theme isn't done when it looks good on your screen. It's done when it passes
the full `THEMES.md` "Verification checklist" — reproduced here as the bar you
hand back against. Run `npm run build` (clean), then `npm run dev`, then:

1. **No-flash** on reload with the theme persisted (no voidstar flicker first).
2. **Site** (`/`, `/posts`, `/about`): header, buttons, cards, prose, tags all
   readable; nothing low-contrast; switcher persists across nav.
3. **Every lab** (`/qualia`, `/lab/cymatics`, `/spectrum-pose`,
   `/pose-particles`): switch via the HUD select **and** the `Y` / `shift+Y`
   cycle. HUD chrome *and* canvas (particles / skeleton / spectrum / bg / QR)
   recolor **live**, next frame, FPS unaffected.
4. **Generated controls** (qualia panels): range sliders (track + thumb on
   theme, grabbable, centered, Firefox fill follows), selects, text + file
   inputs, mod pills + their activity meters, mod-weight sliders (per-channel
   color) all read the theme. Drag one; tab to one and check the focus ring.
5. **Contrast:** small text ≥ 4.5:1 on its *actual* background (mind the
   teal/dark areas); thumbs + pills readable on the panel.
6. **Reduced motion:** with `prefers-reduced-motion: reduce`, your looping
   decoration stops and transitions go instant, but hover/focus/active states
   are still visible.
7. **Mobile:** layout holds and touch slider hit-targets survive at
   coarse-pointer sizing.
8. **Perf:** FPS steady if your theme is glow-heavy.
9. **Default unchanged:** `voidstar` looks identical to `main`.

For a live runtime check, the repo ships a **`verify` skill** that drives the
built qualia app headlessly (fake mic, real canvas) — use it to screenshot your
theme across the labs and confirm the canvas recolors, rather than eyeballing a
static build.

---

## 8. Where to look in the code

You will spend almost all your time in `src/styles/themes.css` (append your
block; the generated-controls + skin layers live at the bottom) and a two-line
registration in `src/lib/qualia/theme.js`. Everything else — the no-flash
bootstrap, the switcher, the canvas knob bridge — reads your block automatically.
The file map, token reference, and JS-bridge API are all in
[`THEMES.md`](THEMES.md); the brand canon and palette names are in
[`agent-reference.md`](agent-reference.md). Start from the theme closest to your
target (dark → copy `abyssal`; light/odd → copy `win95`) and tune.

**Golden rule:** a theme is an *identity with a point of view*, legible from
across a room, that never fights the music. If it's just a hue rotation, keep
going until it has a lever.
