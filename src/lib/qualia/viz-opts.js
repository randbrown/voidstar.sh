// `viz` — sizing defaults for Strudel's inline visual widgets.
//
// The `_scope` / `_pianoroll` / `_punchcard` / `_spectrum` / `_spiral` /
// `_pitchwheel` widgets take an options object whose width/height set the
// canvas (Strudel's defaults: 500×60, or a 200–275px square). `viz()` returns
// one sized to the window, so
//
//   s("bd*4")._scope(viz())              // full width, 1/7 of the window high
//   n("0 2 4")._pianoroll(viz('tall'))   // 1/4 high
//   s("saw")._scope(viz(.1, { thickness: 2, smear: .6 }))
//
// Height: a preset name (HEIGHTS; single or double quotes both work), a
// fraction of the window height (0 < n ≤ 1), or pixels (n > 1). Width
// resolves the same way against the window width, so
// viz({ width: .5 }) is half the window. Anything else in the object is passed
// through to the widget. Sizes are read when you call viz(), i.e. on each eval:
// re-evaluate after resizing the window.
//
// Pure (no window access at import) so scripts/check-qualia-viz.mjs can run it
// in node.

/** Named heights, as fractions of the window height. `band` is the default. */
export const HEIGHTS = {
  thin: 1 / 14,
  band: 1 / 7,
  tall: 1 / 4,
  third: 1 / 3,
  half: 1 / 2,
  full: 1,
};
export const DEFAULT_HEIGHT = 'band';
// Widget canvases default to devicePixelRatio. Capped so a 3× display doesn't
// paint 9× the pixels of a 1× one for a full-width strip: realtime budget first.
export const MAX_PIXEL_RATIO = 2;

// A size spec → pixels: preset name, fraction (≤ 1) of `extent`, or px (> 1).
// Anything unusable falls back to `fallback` (also a spec).
function resolveSize(spec, extent, fallback) {
  if (typeof spec === 'string') {
    const t = spec.trim().toLowerCase();
    if (t in HEIGHTS) return Math.round(extent * HEIGHTS[t]);
    const n = Number(t);
    if (t && Number.isFinite(n)) spec = n;
  }
  if (typeof spec === 'number' && Number.isFinite(spec) && spec > 0) {
    return Math.max(1, Math.round(spec <= 1 ? extent * spec : spec));
  }
  return fallback === undefined ? Math.round(extent) : resolveSize(fallback, extent);
}

// The editor mini-notates double-quoted strings, so viz("tall") hands us a
// Pattern rather than 'tall'. Take its first value at cycle 0.
function unpattern(v) {
  if (v && typeof v.queryArc === 'function') {
    try { v = v.queryArc(0, 1)[0]?.value; } catch { v = undefined; }
  }
  return v;
}

/**
 * Build a widget options object.
 * @param {Array} args  what viz() was called with: ([height], [overrides]) or
 *                      ([overrides]).
 * @param {{width:number, height:number, dpr?:number}} win  window metrics.
 */
export function vizOptions(args, win) {
  let [height, overrides] = args.map(unpattern);
  if (height && typeof height === 'object') { overrides = height; height = undefined; }
  const o = (overrides && typeof overrides === 'object') ? overrides : {};
  const h = o.height !== undefined ? unpattern(o.height) : height;
  const W = Math.max(1, win.width || 0);
  const H = Math.max(1, win.height || 0);
  return {
    pixelRatio: Math.min(MAX_PIXEL_RATIO, Math.max(1, win.dpr || 1)),
    ...o,
    width: resolveSize(unpattern(o.width), W),
    height: resolveSize(h, H, DEFAULT_HEIGHT),
  };
}

/**
 * The `viz` function: `viz(height?, overrides?)` plus one shortcut per preset
 * (`viz.tall()`, `viz.thin({ smear: .5 })`, …).
 * @param {() => {width:number, height:number, dpr?:number}} getWin
 */
export function makeViz(getWin) {
  const viz = (...args) => vizOptions(args, getWin());
  for (const name of Object.keys(HEIGHTS)) {
    viz[name] = (overrides) => vizOptions([name, overrides], getWin());
  }
  return viz;
}
