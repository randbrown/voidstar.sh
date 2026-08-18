// Null — the empty quale. Renders nothing but the page background, so the
// fx layer goes dark while Hydra (below, z:1) and the overlay layers (above,
// z:3) keep running. Distinct from blackout: blackout darkens the whole
// stage; null only vacates the fx slot.
//
// It registers first in page-init.js, making it the default when nothing
// else is specified (fresh boot with no stored fx, default-qualem reset).
// `autoPick: false` keeps auto-cycle / randomQuale / the audience vote list
// from landing on a blank screen — null is only ever chosen explicitly
// (dropdown, quale("null"), qualia.nullQuale(), next/prev).

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'null',
  name: 'Null',
  contextType: 'canvas2d',
  autoPick: false,

  params: [],
  presets: { default: {} },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update() {},
      render() {
        // Truly empty: clear to transparent. Under the canvas's screen blend
        // that reveals Hydra (z:1) untouched; with Hydra dark it shows the page
        // void (--void) exactly — so "Null" is the theme's own black, not a
        // hardcoded fill. (Historically this filled the old page-bg color.)
        ctx.clearRect(0, 0, W, H);
      },
      dispose() {},
    };
  },
};
