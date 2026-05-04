// Camera — passthrough quale that draws the live camera feed as the
// "visualizer." Exists primarily so the data-mosh overlay can mosh the
// camera input (point an effect at a quale, get a moshed camera). Reads
// the bound HTMLVideoElement directly via video.js so it doesn't have to
// own the camera lifecycle — the user enables the camera via the topbar
// pose-source select (or by activating any pose-using quale) and this
// quale just paints whatever stream is currently flowing.
//
// Audio map: bands.bass → cover-fade pump (subtle "pulse" on the camera
// edges); beat.pulse → brief radial vignette that contracts inward.
// Pose isn't read here — the overlay layer paints the skeleton on top
// like it does for every other quale.

import { getVideoEl, getRotation, getMirror } from '../video.js';
import { scaleAudio } from '../field.js';

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'camera',
  name: 'Camera',
  contextType: 'canvas2d',

  params: [
    { id: 'fit',       label: 'fit',        type: 'select', options: ['cover', 'contain'], default: 'cover' },
    { id: 'tint',      label: 'tint',       type: 'select', options: ['none', 'mono', 'cyan', 'magenta', 'amber'], default: 'none' },
    { id: 'vignette',  label: 'vignette',   type: 'range', min: 0,    max: 1,    step: 0.02, default: 0.30 },
    { id: 'pulse',     label: 'audio pulse',type: 'range', min: 0,    max: 1,    step: 0.02, default: 0.30 },
    { id: 'reactivity',label: 'reactivity', type: 'range', min: 0,    max: 2,    step: 0.05, default: 1.0 },
  ],

  presets: {
    default:    { fit: 'cover', tint: 'none', vignette: 0.30, pulse: 0.30, reactivity: 1.0 },
    mono:       { tint: 'mono', vignette: 0.40 },
    nightclub:  { tint: 'magenta', vignette: 0.55, pulse: 0.55 },
    minimal:    { tint: 'none', vignette: 0.10, pulse: 0.10 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    // Scratch updated by update(), consumed by render().
    const scratch = {
      fit: 'cover', tint: 'none', vignette: 0.30, pulse: 0.30,
      audioOn: false, bass: 0, beatP: 0,
    };

    function update(field) {
      const { params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      scratch.fit       = params.fit;
      scratch.tint      = params.tint;
      scratch.vignette  = params.vignette;
      scratch.pulse     = params.pulse;
      scratch.audioOn   = !!audio.spectrum;
      scratch.bass      = audio.bands.bass;
      scratch.beatP     = audio.beat.pulse;
    }

    function render() {
      const video = getVideoEl();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);

      const ready = video && video.videoWidth > 0 && video.videoHeight > 0;
      if (!ready) {
        ctx.fillStyle = 'rgba(180,200,220,0.5)';
        ctx.font = '600 18px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('camera off — set pose source to "camera"', W / 2, H / 2);
        ctx.textAlign = 'left';
        return;
      }

      const vw = video.videoWidth, vh = video.videoHeight;
      const rot = getRotation();
      // For 90/270 rotations, the effective video bounding box swaps width
      // and height. Compute scale against the rotated bbox so cover/contain
      // still cover/contain the whole canvas correctly.
      const rotated = rot === 90 || rot === 270;
      const ew = rotated ? vh : vw;
      const eh = rotated ? vw : vh;
      const sx = W / ew, sy = H / eh;
      const scale = scratch.fit === 'cover'
        ? Math.max(sx, sy)
        : Math.min(sx, sy);
      const drawW = ew * scale;
      const drawH = eh * scale;

      ctx.save();
      ctx.translate(W / 2, H / 2);
      // Match the CSS preview transform `scaleX(-1) rotate(N)`. In matrix-
      // multiplied form that's S·R, applied to a point as: rotate first,
      // then scale. Canvas API multiplies each call on the RIGHT, so to
      // build the matrix T·S·R (where the point gets R then S then T)
      // we have to call scale BEFORE rotate. The opposite order builds
      // T·R·S — point gets S then R — which is exactly 180° rotated from
      // the preview when both rotation and mirror are active.
      if (getMirror()) ctx.scale(-1, 1);
      if (rot !== 0)   ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(video, -vw * scale / 2, -vh * scale / 2, vw * scale, vh * scale);
      ctx.restore();

      // Tint pass — flat overlay with `multiply` for chromatic looks, or
      // `saturation` for mono. Skipped at 'none' to keep the cost zero.
      if (scratch.tint !== 'none') {
        const audioBoost = scratch.audioOn
          ? scratch.bass * scratch.pulse * 0.4 + scratch.beatP * scratch.pulse * 0.25
          : 0;
        ctx.save();
        if (scratch.tint === 'mono') {
          ctx.globalCompositeOperation = 'saturation';
          ctx.fillStyle = 'rgba(0,0,0,1)';
        } else {
          const colors = {
            cyan:    'rgba(34,211,238,1)',
            magenta: 'rgba(244,114,182,1)',
            amber:   'rgba(251,191,36,1)',
          };
          ctx.globalCompositeOperation = 'multiply';
          ctx.fillStyle = colors[scratch.tint] || 'rgba(255,255,255,1)';
        }
        ctx.globalAlpha = 0.55 + audioBoost;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      // Audio-modulated vignette — subtle radial darken from the corners.
      if (scratch.vignette > 0.01) {
        const audioPunch = scratch.audioOn
          ? scratch.beatP * scratch.pulse * 0.35
          : 0;
        const vAmt = Math.min(1, scratch.vignette + audioPunch);
        const cx = W / 2, cy = H / 2;
        const rOuter = Math.hypot(W, H) * 0.55;
        const rInner = rOuter * (0.42 - audioPunch * 0.18);
        const grad = ctx.createRadialGradient(cx, cy, rInner, cx, cy, rOuter);
        grad.addColorStop(0, 'rgba(5,5,13,0)');
        grad.addColorStop(1, `rgba(5,5,13,${vAmt})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* nothing to free */ },
    };
  },
};
