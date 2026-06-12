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

/**
 * Read the active theme's canvas knobs (cached until the next theme change).
 * Returns numbers/strings plus helpers used by the lab draw loops:
 *   hueBase, hueSpread, sat, light, glow, mono(0/1), bg
 *   hue(t)          → hue in degrees for a normalized t∈[0,1] (mono-aware)
 *   color(t, opts)  → an hsla() string at hue(t); opts: {alpha, light, sat}
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

  _cache = { hueBase, hueSpread, sat, light, glow, mono, bg, hue, color };
  return _cache;
}
