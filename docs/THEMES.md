# Theme System

A runtime, token-based theming layer for voidstar.sh. One `data-theme`
attribute on `<html>` reskins the **whole site and the labs together** — chrome
(CSS) and canvas visuals (JS) both follow the active theme. Built so each
performer can pick a distinct identity, and so new themes are mostly a
copy-paste-and-tune exercise.

This document is the map for adding/editing themes. If you're a design agent:
read "Quick start" then "Token reference," edit `src/styles/themes.css`, and
verify with the checklist at the end.

---

## How it works (one paragraph)

`src/styles/themes.css` defines all design tokens at `:root` (the **Voidstar**
default) plus one `[data-theme="…"]` override block per theme. A no-flash inline
script sets `data-theme` before first paint from `localStorage`. CSS reads the
tokens directly. Canvas-driven labs read a subset of tokens (the `--viz-*`
knobs, plus the accent colors) through a tiny JS bridge
(`src/lib/qualia/theme.js`) that caches them and re-reads on theme change — so
particle/skeleton/spectrum colors recolor live without a reload. The default
theme's token/knob values are chosen to reproduce the original hardcoded look
exactly, so "voidstar" is a visual no-op.

---

## File map

| File | Role |
|---|---|
| `src/styles/themes.css` | **Source of truth.** All tokens, every `[data-theme]` block, texture overlays, the win95 skin layer. Imported by `global.css` (site) and directly by each lab page. |
| `src/styles/global.css` | Site-wide base styles; `@import './themes.css'` at top. |
| `src/lib/qualia/theme.js` | Runtime controller (`setTheme`/`cycleTheme`/`getTheme`), the switcher wiring (`initThemeControl`), and the canvas knob bridge (`readKnobs`, `onThemeChange`). |
| `src/components/ThemeBoot.astro` | Inline no-flash bootstrap. In `BaseLayout` head + each lab head. |
| `src/components/ThemeSwitch.astro` | Header switcher `<select>`. |
| Lab pages: `src/pages/lab/{cymatics,spectrum-pose,pose-particles,qualia,entangle}.astro` | Import `themes.css` + `ThemeBoot`; have an in-HUD theme `<select id="theme-select">` and a `Y` / `shift+Y` cycle shortcut; canvas draw code reads `readKnobs()`. |
| `src/lib/qualia/overlay.js` | Shared pose skeleton/sparks/ripple/ASCII overlay (used by qualia). Palette derived from theme accents. |
| `src/lib/qualia/entangle-ui.js`, `qr.js` | Crowd skeleton hues + QR colors, theme-aware. |

Theme IDs (keep these in sync across `themes.css`, `theme.js` `THEMES`, and
`ThemeBoot.astro`'s `OK` list):
`voidstar`, `phosphor`, `phosphor-amber`, `tape`, `abyssal`, `glacial`, `win95`.

---

## Quick start: add a theme

1. **Copy a block** in `themes.css` — start from the theme closest to your
   target (a dark theme → copy `abyssal`; a light/odd one → copy `win95`).
   Rename the selector to `[data-theme="yourname"]`.
2. **Set the palette + knobs** (see Token reference). You only need to override
   tokens that differ from `:root`.
3. **Register the id** in three places: `theme.js` `THEMES` (id + label),
   `ThemeBoot.astro` `OK` array, and (implicitly) the block in `themes.css`.
4. **Build + flip through it** (checklist at the end). The labs and site update
   from the one block — no per-lab edits needed for a normal color theme.

A "normal" theme = colors + a few knobs. Only reach for a **skin layer** (see
win95) if you're changing the chrome *metaphor* (bevels, title bars, etc.).

---

## Token reference

All tokens live in `:root` in `themes.css` with their Voidstar defaults.

### Surfaces & text
```
--void, --void-2          page / secondary background
--surface, --surface-2    opaque card surfaces (site)
--surface-glass,          translucent HUD panels (labs). Auto-derived from
--surface-glass-2           --void via color-mix, so themes get frosted panels
                            for free. Override to opaque for non-glass themes.
--hud-border              translucent HUD border (derived)
--border, --border-2      borders / hover borders
--text, --text-muted,     text hierarchy
--text-dim
--muted                   alias of --text-muted (labs reference --muted)
```

### Accents (drive both chrome and canvas)
```
--accent (+ --accent-glow)
--cyan   (+ --cyan-glow)
--pink   (+ --pink-glow)
--green
--amber
```
These five accents are what the **pose skeletons, beat washes, HUD bars, and
ripples** are built from (via `readKnobs().ac`). Choosing them well = your
theme's canvas character. Keep them in-family but distinguishable from each
other (they color different people / frequency bands).

### Typography
```
--font-sans   site headings/body
--font-mono   HUD / code / labels
--font-ui     chrome font alias (defaults to --font-sans)
```
Webfonts are `@import`ed at the top of `themes.css` (Space Grotesk, JetBrains
Mono, VT323). Add a font there if a theme needs it.

### Chrome feel
```
--radius, --radius-lg     corner rounding (0 = sharp)
--glow-strength           multiplier gating CSS bloom (0 = flat). Used in
                          calc() on .btn / .glow-* shadows.
--panel-blur              backdrop-filter amount for HUD panels
--code-filter             CSS filter applied to the embedded Strudel editor +
                          scope canvases to retint syntax colors into the
                          theme family (the editor's colors live in shadow DOM,
                          so a filter is the reliable lever). e.g.
                          sepia()+hue-rotate() duotone; `none` = untouched.
```

### Texture overlays (opacity, 0 = off)
```
--tex-scanline            CRT scanlines (phosphor)
--tex-grain               film grain (tape)
```
Implemented as fixed, pointer-events:none `body::before/::after` layers in
`themes.css`. z-index 9 → above the lab canvas (z2), below the HUD (z20).

### Canvas knobs — read by JS (`readKnobs()`)
```
--viz-bg          canvas clear / trail-fade color (hex)
--viz-hue-base    base hue, degrees
--viz-hue-spread  hue range, degrees (0 collapses to mono)
--viz-sat         base saturation %
--viz-light       base lightness %
--viz-glow        bloom / shadowBlur multiplier for canvas
--viz-mono        1 = render monochrome (collapse spread → base hue)
```

---

## The JS bridge (`src/lib/qualia/theme.js`)

Controller:
```js
import { setTheme, cycleTheme, getTheme, initThemeControl, onThemeChange } from '.../theme.js';
setTheme('abyssal');            // sets data-theme, persists, fires event
cycleTheme(1 /* or -1 */);      // next/prev (Y / shift+Y in labs)
initThemeControl(selectEl);     // populate + wire a <select>
onThemeChange(cb);              // run cb whenever the theme changes
```
- Storage key: `voidstar.theme`. Event: `voidstar:themechange`. Default: `voidstar`.

Canvas knob reader (cached; invalidated on theme change — **never call
`getComputedStyle` per frame**, call `readKnobs()` once and on `themechange`):
```js
import { readKnobs, onThemeChange } from '.../theme.js';
let K = readKnobs();
onThemeChange(() => { K = readKnobs(); });

K.hueBase, K.hueSpread, K.sat, K.light, K.glow, K.mono   // numbers
K.bg                          // '--viz-bg' string (hex)
K.hue(t)                      // hue° for t∈[0,1], mono-aware
K.color(t, {alpha, light, sat})   // hsla() string at hue(t)
K.ac.accent / .cyan / .pink / .green / .amber
   .rgb   // [r,g,b]
   .hue   // degrees
   .rgba(a)  // 'rgba(r,g,b,a)' string
```
**Pattern for fixed multi-color palettes** (pose skeletons, HUD column colors):
build them from `K.ac.*` in a `build…()` function and rebuild it on
`onThemeChange`. See `buildPersonPalette()` in `overlay.js` /
`spectrum-pose.astro` / `cymatics.astro` / `pose-particles.astro`.

**Pattern for hue ramps** (spectrum bars, particle fields): map your fraction
across the theme range, e.g. `K.hueBase + (K.mono ? 0 : frac * span * (K.hueSpread/90))`.
The `/90` keeps a lab's native span proportional to the theme's spread so
Voidstar looks unchanged. See `hspan()` in `spectrum-pose.astro`.

---

## Skin layers (chrome-metaphor changes)

Most themes only set tokens. If a theme changes the *shape* of the chrome
(beveled edges, title bars, etc.), add a layer scoped under
`[data-theme="yourname"]` so it can't leak into other themes. **Win95** is the
reference (bottom of `themes.css`):
- Reusable `--bevel-raised` / `--bevel-sunken` box-shadow strings.
- Buttons/cards/panels → opaque gray, square, beveled (`!important` to beat
  per-page scoped + mobile rules).
- Qualia `.qp-card` headers (`.qp-head`) → navy gradient title bars.
- Site header → gray menu bar; nav links black, navy hover.

### Gotcha worth knowing: light themes on dark/teal surfaces
Win95 uses dark text (tuned for its gray panels), but some surfaces aren't gray
— the hero/sections sit on the teal `--void` desktop, and the site header was
near-black. A single `--text` can't serve both. Resolution used: keep global
text dark (for the dominant gray panels), and **scope the on-teal text light**
(`.hero-eyebrow`, `.hero-desc`, `.section-heading`, `.lab-desc`, `.page-title`,
`.prose`). Any future light theme on a dark page background needs the same
split. Check WCAG contrast for small text on the page background.

### Other gotchas
- **Labs are standalone** (no `BaseLayout`): a new lab must import `themes.css`
  + `ThemeBoot` itself, and add `data-theme` early. Don't rely on the layout.
- **Per-page mobile overrides** can hardcode panel alpha (e.g. qualia's
  `.qp-card` at small widths). Keep these theme-aware (`color-mix` on a token)
  or a light theme will get an off-color slab.
- **Gradient text** (`-webkit-text-fill-color: transparent` + `background-clip`)
  needs `-webkit-text-fill-color` + `background:none` overridden with
  `!important` to recolor under a skin.
- **color-mix** is used for derived translucency; fine in current browsers.

---

## The six shipped themes (intent + lever)

| Theme | Niche | Defining levers |
|---|---|---|
| **voidstar** | cosmic synthwave (default) | purple `--accent`, hue 250/spread 90, glow on |
| **phosphor** (+ **phosphor-amber**) | harsh-noise / experimental | mono CRT green/amber, `--viz-mono:1`, scanlines, square, VT323, low bloom |
| **tape** | lo-fi tape ambient | warm cream/rust/ochre, film grain, rounded, soft glow |
| **abyssal** | dark ambient / drone | teal/jade on near-black, high `--viz-glow`/`--glow-strength` |
| **glacial** | Nordic / ECM ambient | icy low-sat blue-white, heavy `--panel-blur`, crisp small radius, low glow |
| **win95** | net-art / vaporwave | teal desktop, beveled gray chrome + title bars (skin layer), no glow/blur |

---

## Ideas parking lot (unbuilt)

> **Brand context:** see [`docs/agent-reference.md`](./agent-reference.md) for the
> wider voidstar / Randyland creative brief. Its voidstar palette already names
> accents that map cleanly onto new themes — **accretion gold**, **neural
> magenta**, **plasma orange**, **ghost green**, **CRT phosphor white**, on a
> `#000000 / #050816 / #0A0F2A` void with `#00D4FF / #66F0FF` cyans. Good seeds
> for the `--accent` / `--cyan` / `--pink` / `--green` / `--amber` set. Keep the
> brand north stars in mind: restraint, glitch, "consciousness rendered as
> light, sound rendered as geometry" — not generic EDM/cyberpunk.

Directions that fit the ambient/avant-garde brief and the current architecture
(each ≈ one `[data-theme]` block, plus a skin layer only if noted):
- **Gargantua / Accretion** — black + accretion-gold + cyan rim; the qualia
  "gargantua" fx aesthetic as a global theme.
- **Ember Ritual** — ember-red on charcoal, occult serif accent (dark ambient).
- **Solar Plasma** — gold↔magenta plasma on black (cosmic ambient).
- **Botanical / Mycelial** — moss/soil greens & browns, organic (generative);
  ties to the Cindy Lynn's Gardens branch (stained-glass botany / chemistry).
- **Risograph** — 2–3 flat spot inks on warm paper, grain, halftone overlay
  (would want a new texture overlay like `--tex-grain`).
- **Teletext / Mode 7** — chunky blocky palette, scanlines, big type (skin-ish).
- **Blueprint / Drafting** — cyan lines on navy, monospace (low-glow).

Future architecture work (not themes): externalize brand strings/logos/PWA
manifest into a per-performer config; route the qualia `fx/*` module palettes
through `K.ac`/`K.color` (currently only the shared overlay + the three
non-qualia labs are fully knob-driven).

---

## Verification checklist (per theme)

1. `npm run build` is clean; `npm run dev`.
2. Reload with the theme persisted → **no flash** of voidstar before it applies.
3. **Site** (`/`, `/posts`, `/about`): header/menu, buttons, cards, prose, tags,
   tag pills readable; nothing low-contrast. Switcher persists across nav.
4. **Each lab** (`/lab/cymatics`, `/spectrum-pose`, `/pose-particles`,
   `/qualia`): switch via HUD select + `Y`. HUD chrome + canvas (particles /
   skeleton / spectrum / bg / QR) recolor **live** (next frame), FPS unaffected.
5. Contrast: small text ≥ 4.5:1 on its actual background (mind teal/dark areas).
6. Default **voidstar** is unchanged vs `main`.
