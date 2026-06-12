// Runtime theme controller + canvas-knob bridge.
//
// The CSS in themes.css owns the look; this module is the JS side:
//   - setTheme()/cycleTheme() flip the `data-theme` attribute, persist it, and
//     fire a `voidstar:themechange` event.
//   - readKnobs() reads the `--viz-*` tokens (and a few colors) off :root via
//     getComputedStyle and caches them, so canvas draw loops can recolor to the
//     active theme without hardcoding hues. The cache is invalidated on theme
//     change; never call getComputedStyle per-frame.
//
// Safe to import from both the main site (BaseLayout/Header) and the standalone
// lab pages.

export const STORAGE_KEY = 'voidstar.theme';

export const THEMES = [
  { id: 'voidstar',       label: 'voidstar ✦' },
  { id: 'phosphor',       label: 'phosphor ▒' },
  { id: 'phosphor-amber', label: 'phosphor·amber ▒' },
  { id: 'tape',           label: 'tape ▤' },
  { id: 'abyssal',        label: 'abyssal ≈' },
  { id: 'glacial',        label: 'glacial ❄' },
  { id: 'win95',          label: 'win95 ▣' },
];

const IDS = THEMES.map((t) => t.id);
const DEFAULT = 'voidstar';

export function getTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return IDS.includes(t) ? t : DEFAULT;
}

export function setTheme(id) {
  const theme = IDS.includes(id) ? id : DEFAULT;
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(STORAGE_KEY, theme); } catch (_) {}
  invalidate();
  // Keep the PWA/browser chrome color in sync with the void.
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', cssVar('--void') || '#05050d');
  } catch (_) {}
  window.dispatchEvent(new CustomEvent('voidstar:themechange', { detail: { theme } }));
  return theme;
}

export function cycleTheme(dir = 1) {
  const i = IDS.indexOf(getTheme());
  return setTheme(IDS[(i + dir + IDS.length) % IDS.length]);
}

/** Wire a <select> element to the theme system (used by the switcher UIs). */
export function initThemeControl(select) {
  if (!select) return;
  select.innerHTML = '';
  for (const { id, label } of THEMES) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.value = getTheme();
  select.addEventListener('change', () => setTheme(select.value));
  // Reflect external changes (e.g. another control, or cycle shortcut).
  onThemeChange(() => { select.value = getTheme(); });
}

export function onThemeChange(cb) {
  window.addEventListener('voidstar:themechange', cb);
  return () => window.removeEventListener('voidstar:themechange', cb);
}

/* ---- canvas knob bridge --------------------------------------------------- */

let _cache = null;
function invalidate() { _cache = null; }
if (typeof window !== 'undefined') {
  window.addEventListener('voidstar:themechange', invalidate);
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function num(name, fallback) {
  const v = parseFloat(cssVar(name));
  return Number.isFinite(v) ? v : fallback;
}

function parseRgb(s) {
  s = (s || '').trim();
  let m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(s);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

function rgbHue([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h;
  if (max === r)      h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function accent(name, fallbackHex) {
  const rgb = parseRgb(cssVar(name)) || parseRgb(fallbackHex);
  return { rgb, hue: rgbHue(rgb), rgba: (a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})` };
}

/**
 * Read the active theme's canvas knobs (cached until the next theme change).
 * Returns numbers/strings plus helpers used by the lab draw loops:
 *   hueBase, hueSpread, sat, light, glow, mono(0/1), bg
 *   hue(t)          → hue in degrees for a normalized t∈[0,1] (mono-aware)
 *   color(t, opts)  → an hsla() string at hue(t); opts: {alpha, light, sat}
 *   ac              → the theme's curated accent set, each parsed as
 *                     { rgb:[r,g,b], hue, rgba(alpha) }. Use these for
 *                     fixed multi-color palettes (pose skeletons, HUD bars)
 *                     so they stay in-family on every theme.
 */
export function readKnobs() {
  if (_cache) return _cache;
  const hueBase   = num('--viz-hue-base', 250);
  const hueSpread = num('--viz-hue-spread', 90);
  const sat       = num('--viz-sat', 85);
  const light     = num('--viz-light', 55);
  const glow      = num('--viz-glow', 1);
  const mono      = num('--viz-mono', 0);
  const bg        = cssVar('--viz-bg') || '#05050d';

  const hue = (t) => mono ? hueBase : hueBase + (Number.isFinite(t) ? t : 0) * hueSpread;
  const color = (t, opts = {}) => {
    const a = opts.alpha == null ? 1 : opts.alpha;
    const l = opts.light == null ? light : opts.light;
    const s = opts.sat == null ? sat : opts.sat;
    return `hsla(${hue(t)},${s}%,${l}%,${a})`;
  };

  const ac = {
    accent: accent('--accent', '#8b5cf6'),
    cyan:   accent('--cyan',   '#22d3ee'),
    pink:   accent('--pink',   '#f472b6'),
    green:  accent('--green',  '#4ade80'),
    amber:  accent('--amber',  '#fbbf24'),
  };

  _cache = { hueBase, hueSpread, sat, light, glow, mono, bg, hue, color, ac };
  return _cache;
}
