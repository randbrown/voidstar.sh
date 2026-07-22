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
        // #05050d matches the page bg — effectively transparent under the
        // canvas's screen blend, so Hydra shows through untouched.
        ctx.fillStyle = '#05050d';
        ctx.fillRect(0, 0, W, H);
      },
      dispose() {},
    };
  },
};
