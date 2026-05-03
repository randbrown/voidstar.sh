// Boilerplate for a new qualia fx. Copy this file, change `id` and `name`,
// flesh out create(). Then `register(<your-module>)` in qualia.astro.
//
// Contract reminders:
//   - Plugins read state ONLY through `field` — never via globals. That's
//     what makes them swappable + Strudel-driveable.
//   - The UI for `params` is generated automatically; just declare them.
//   - `presets` are factory snapshots. User-saved presets are managed
//     separately by presets.js (loadFxUserPresets / saveFxUserPreset).
//   - Canvas is sized to backing-buffer pixels in resize(w,h,dpr).
//   - If your fx uses any `field.audio.*` reactivity, declare a `reactivity`
//     range param (0..2, default 1) and call scaleAudio(field.audio, params.
//     reactivity) once at the top of update(). The rest of your audio reads
//     stay unchanged; the helper pre-multiplies magnitudes and gates the
//     transient `active` flags so the slider works uniformly across fx.

import { scaleAudio } from '../field.js';

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'template',
  name: 'Template',
  contextType: 'canvas2d', // 'canvas2d' | 'webgl2'

  params: [
    { id: 'speed',      label: 'Speed',      type: 'range', min: 0, max: 4, step: 0.05, default: 1.0 },
    { id: 'wide',       label: 'Wide',       type: 'toggle', default: false },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  presets: {
    default: { speed: 1.0, wide: false, reactivity: 1.0 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update(field) {
        const audio = scaleAudio(field.audio, field.params.reactivity);
        // ...read audio.bands.bass, audio.beat.pulse, etc. — already scaled.
      },
      render() {
        ctx.fillStyle = '#05050d';
        ctx.fillRect(0, 0, W, H);
      },
      dispose() { /* nothing to free */ },
    };
  },
};
