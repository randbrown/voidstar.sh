// `palette` — the active theme's colours as strings a pattern can use.
//
//   s("bd*4")._scope(viz()).color(palette.accent)    // '#38d8ff' on voidstar
//   note("c e g")._pianoroll(viz()).color(palette.cycle())   // accents, one per cycle
//   solid(...palette.rgb('pink')).out()              // Hydra wants 0..1 channels
//
// Every value is read when you touch it (on eval), from the same CSS tokens the
// rest of the page wears, so switching themes and re-evaluating recolours the
// pattern. Colours come back as '#rrggbb' because that's the one CSS form the
// mini-notation keeps as a single word ('#' is a step char; rgb(…) and
// color-mix(…) would be split into a sequence).
//
// The parsing/arc maths here is pure; the DOM reads are injected by
// code-api.js so scripts/check-qualia-palette.mjs runs this in node.

/** Named colours → the theme token each one reads. */
export const PALETTE_TOKENS = {
  accent:  '--accent',
  cyan:    '--cyan',
  pink:    '--pink',
  green:   '--green',
  amber:   '--amber',
  text:    '--text',
  muted:   '--text-muted',
  dim:     '--text-dim',
  bg:      '--viz-bg',
  surface: '--surface',
  border:  '--border-2',
};
/** The colours palette.cycle() steps through by default. */
export const CYCLE_NAMES = ['accent', 'cyan', 'pink', 'green', 'amber'];

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * A computed CSS colour → [r, g, b, a] (0–255, alpha 0–1), or null.
 * Handles hex (3/4/6/8), rgb()/rgba() in comma or space syntax, and the
 * `color(srgb r g b / a)` form browsers serialise color-mix() results to.
 */
export function parseCssColor(str) {
  const s = String(str || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p) => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p));
    const a = parts[3] === undefined ? 1 : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
    const rgb = parts.slice(0, 3).map(ch);
    if (rgb.some((v) => !Number.isFinite(v)) || !Number.isFinite(a)) return null;
    return [...rgb.map(clamp255), Math.max(0, Math.min(1, a))];
  }
  m = /^color\(srgb\s+([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
    if (parts.length < 3 || parts.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
    const a = Number.isFinite(parts[3]) ? parts[3] : 1;
    return [...parts.slice(0, 3).map((v) => clamp255(v * 255)), Math.max(0, Math.min(1, a))];
  }
  return null;
}

const hex2 = (v) => clamp255(v).toString(16).padStart(2, '0');
/** [r, g, b, a?] → '#rrggbb', or '#rrggbbaa' when translucent. */
export function rgbToHex([r, g, b, a = 1]) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;
}

/** HSL (deg, %, %) → [r, g, b] 0–255. */
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => clamp255(v * 255));
}

/**
 * Build the `palette` object.
 * @param {{ color: (token: string) => string,
 *           knobs: () => { hue: (t:number) => number, sat: number, light: number } }} env
 *   color(token) returns the token's COMPUTED colour (any CSS form above);
 *   knobs() is theme.js readKnobs() — the theme's visualizer hue arc.
 */
export function makePalette(env) {
  const hexOf = (token, fallback = '#ffffff') => {
    const rgb = parseCssColor(env.color(token));
    return rgb ? rgbToHex(rgb) : fallback;
  };
  // A name from PALETTE_TOKENS, a raw '--token', or a literal CSS colour.
  const resolve = (c) => {
    if (typeof c !== 'string') return '#ffffff';
    if (c in PALETTE_TOKENS) return hexOf(PALETTE_TOKENS[c]);
    if (c.startsWith('--')) return hexOf(c);
    const rgb = parseCssColor(c);
    return rgb ? rgbToHex(rgb) : '#ffffff';
  };
  const arc = (t) => {
    const k = env.knobs();
    const u = Number.isFinite(+t) ? Math.max(0, Math.min(1, +t)) : 0;
    return rgbToHex(hslToRgb(k.hue(u), k.sat, k.light));
  };

  const palette = {
    /** Hex of a name ('pink'), a theme token ('--accent') or any CSS colour. */
    get: resolve,
    /** Point t∈[0,1] along the theme's visualizer hue arc (what the quales paint with). */
    arc,
    /** n evenly spaced stops along the hue arc, as an array of hex strings. */
    arcs: (n = 5) => {
      const k = Math.max(1, Math.floor(n) || 1);
      return Array.from({ length: k }, (_, i) => arc(k === 1 ? 0 : i / (k - 1)));
    },
    /** A mini-notation cycle — '<#a #b …>' — one colour per cycle. No arg:
     *  the five accents; a number: that many hue-arc stops; an array: those
     *  names/colours. */
    cycle: (spec) => {
      const list = Array.isArray(spec) ? spec.map(resolve)
        : typeof spec === 'number' ? palette.arcs(spec)
        : CYCLE_NAMES.map(resolve);
      return `<${list.join(' ')}>`;
    },
    /** [r, g, b] in 0..1 — spread straight into Hydra: solid(...palette.rgb('pink')). */
    rgb: (c = 'accent') => {
      const rgb = parseCssColor(resolve(c)) || [255, 255, 255];
      return rgb.slice(0, 3).map((v) => +(v / 255).toFixed(4));
    },
    /** The named colours. */
    names: () => Object.keys(PALETTE_TOKENS),
  };
  for (const [name, token] of Object.entries(PALETTE_TOKENS)) {
    Object.defineProperty(palette, name, { get: () => hexOf(token), enumerable: true });
  }
  return palette;
}
