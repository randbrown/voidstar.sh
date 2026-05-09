// Dog Skeleton — debug-style overlay for the dog detection pipeline.
// Iterates `field.pose.people`, filters to `kind === 'dog'`, and for each
// dog draws:
//   - a dashed bounding box
//   - line segments connecting the synthesized joints (head→neck→hips,
//     hips→tail, neck→front-paws, hips→back-paws)
//   - dots at each joint sized by visibility
//   - a small heading triangle past the snout so orientation is legible
//
// Audio mapping is light (this is a diagnostic visual, not an art piece):
//   bass  → stroke alpha tilt
//   beat  → brief shockwave ring around the bbox center
//
// Coordinate convention: x is mirrored (1 - x) to match the selfie-cam
// display flip used by every other pose-aware fx in the lab.

import { scaleAudio } from '../field.js';

const PALETTES = {
  amber:    { bbox: '#ffb142', bone: '#ffd166', dot: '#fff3b0', tail: '#ff9a3c' },
  cyan:     { bbox: '#5fd1ff', bone: '#9be7ff', dot: '#e0f7ff', tail: '#28a4d4' },
  magenta:  { bbox: '#ff6cd9', bone: '#ff9eea', dot: '#ffd6f5', tail: '#d83fb1' },
  void:     { bbox: '#9aa0ff', bone: '#c8ccff', dot: '#eef0ff', tail: '#6a72e0' },
};

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'dog_skeleton',
  name: 'Dog Skeleton',
  contextType: 'canvas2d',

  params: [
    { id: 'showBbox',   label: 'show bbox',   type: 'toggle', default: true },
    { id: 'showLabel',  label: 'show label',  type: 'toggle', default: true },
    { id: 'lineWidth',  label: 'line width',  type: 'range',  min: 0.5, max: 6,   step: 0.1, default: 2.0 },
    { id: 'dotSize',    label: 'dot size',    type: 'range',  min: 1,   max: 10,  step: 0.2, default: 3.5 },
    { id: 'palette',    label: 'palette',     type: 'select', options: ['amber', 'cyan', 'magenta', 'void'], default: 'amber' },
    { id: 'reactivity', label: 'reactivity',  type: 'range',  min: 0,   max: 2,   step: 0.05, default: 1.0 },
  ],

  presets: {
    default: { showBbox: true, showLabel: true, lineWidth: 2.0, dotSize: 3.5, palette: 'amber', reactivity: 1.0 },
    minimal: { showBbox: false, showLabel: false, lineWidth: 1.2, dotSize: 2.0, palette: 'cyan', reactivity: 0.5 },
    bold:    { showBbox: true, showLabel: true, lineWidth: 3.5, dotSize: 5.0, palette: 'magenta', reactivity: 1.5 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    let scratch = {
      dogs: [],
      bass: 0,
      beatPulse: 0,
      params: null,
    };

    function update(field) {
      const audio = scaleAudio(field.audio, field.params.reactivity);
      scratch.bass = audio.bands.bass;
      scratch.beatPulse = audio.beat.pulse;
      scratch.params = field.params;
      // Filter to dogs once per frame so render() doesn't re-walk people.
      const dogs = [];
      for (const p of field.pose.people) {
        if (p.kind === 'dog') dogs.push(p);
      }
      scratch.dogs = dogs;
    }

    function mx(x) { return (1 - x) * W; }
    function my(y) { return y * H; }

    function drawBone(p, ax, ay, bx, by, lw) {
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(mx(ax), my(ay));
      ctx.lineTo(mx(bx), my(by));
      ctx.stroke();
    }

    function drawDot(lm, baseSize) {
      const r = baseSize * (0.5 + Math.max(0, lm.visibility) * 0.7);
      ctx.beginPath();
      ctx.arc(mx(lm.x), my(lm.y), r, 0, Math.PI * 2);
      ctx.fill();
    }

    function render() {
      // Trail-fade onto a near-black backdrop. This fx is a debug overlay,
      // so the fade is light — silhouettes shouldn't pile up.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(5,5,13,0.30)`;
      ctx.fillRect(0, 0, W, H);

      const dogs = scratch.dogs;
      if (dogs.length === 0) {
        // Idle hint, dimmed. Helps confirm the fx is running before a dog
        // walks into frame.
        ctx.fillStyle = 'rgba(200,200,220,0.25)';
        ctx.font = '12px ui-monospace, monospace';
        ctx.textBaseline = 'top';
        ctx.fillText('Dog Skeleton — waiting for dog…', 12, 12);
        return;
      }

      const params = scratch.params;
      const pal = PALETTES[params.palette] || PALETTES.amber;
      const lw = params.lineWidth * (1 + scratch.bass * 0.5);
      const dotSize = params.dotSize * (1 + scratch.beatPulse * 0.4);

      ctx.globalCompositeOperation = 'lighter';

      for (const d of dogs) {
        const conf = d.confidence;
        const alpha = 0.55 + 0.4 * conf + 0.15 * scratch.bass;

        // Beat shockwave — a thin ring around bbox center, expanding with
        // the pulse envelope. Visible for only a beat-pulse worth of time.
        if (scratch.beatPulse > 0.05) {
          const cx = mx(d.bbox.x + d.bbox.w / 2);
          const cy = my(d.bbox.y + d.bbox.h / 2);
          const baseR = Math.hypot(d.bbox.w * W, d.bbox.h * H) * 0.6;
          const r = baseR * (0.4 + scratch.beatPulse * 0.8);
          ctx.strokeStyle = `${pal.dot}`;
          ctx.globalAlpha = scratch.beatPulse * 0.5;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // ── Bones ────────────────────────────────────────────────────────
        ctx.strokeStyle = pal.bone;
        ctx.globalAlpha = alpha;
        // Spine: head → neck → hips midpoint → tail.
        drawBone(d, d.head.x, d.head.y, d.neck.x, d.neck.y, lw);
        const hipMidX = (d.hips.l.x + d.hips.r.x) * 0.5;
        const hipMidY = (d.hips.l.y + d.hips.r.y) * 0.5;
        drawBone(d, d.neck.x, d.neck.y, hipMidX, hipMidY, lw);
        // Hip bar (l↔r)
        drawBone(d, d.hips.l.x, d.hips.l.y, d.hips.r.x, d.hips.r.y, lw * 0.7);
        // Tail
        ctx.strokeStyle = pal.tail;
        drawBone(d, hipMidX, hipMidY, d.tail.x, d.tail.y, lw * 0.85);
        // Front legs: neck → fl, neck → fr
        ctx.strokeStyle = pal.bone;
        drawBone(d, d.neck.x, d.neck.y, d.paws.fl.x, d.paws.fl.y, lw * 0.75);
        drawBone(d, d.neck.x, d.neck.y, d.paws.fr.x, d.paws.fr.y, lw * 0.75);
        // Back legs: hips.l → bl, hips.r → br
        drawBone(d, d.hips.l.x, d.hips.l.y, d.paws.bl.x, d.paws.bl.y, lw * 0.75);
        drawBone(d, d.hips.r.x, d.hips.r.y, d.paws.br.x, d.paws.br.y, lw * 0.75);

        // ── Joint dots ───────────────────────────────────────────────────
        ctx.fillStyle = pal.dot;
        drawDot(d.head,    dotSize * 1.3);
        drawDot(d.snout,   dotSize * 0.9);
        drawDot(d.neck,    dotSize);
        drawDot(d.hips.l,  dotSize);
        drawDot(d.hips.r,  dotSize);
        drawDot(d.paws.fl, dotSize);
        drawDot(d.paws.fr, dotSize);
        drawDot(d.paws.bl, dotSize);
        drawDot(d.paws.br, dotSize);
        drawDot(d.tail,    dotSize * 0.8);

        // Heading triangle past snout — direction cue.
        ctx.beginPath();
        const sx = mx(d.snout.x), sy = my(d.snout.y);
        // Heading is in image coords; mirroring x flips its sign at draw time.
        const hxScreen = -d.heading.x; // mirror x
        const hyScreen =  d.heading.y;
        const len = Math.hypot(d.bbox.w * W, d.bbox.h * H) * 0.08;
        const tipX = sx + hxScreen * len;
        const tipY = sy + hyScreen * len;
        const perpX = -hyScreen * len * 0.4;
        const perpY =  hxScreen * len * 0.4;
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(sx + perpX, sy + perpY);
        ctx.lineTo(sx - perpX, sy - perpY);
        ctx.closePath();
        ctx.fill();

        // ── Bounding box (dashed) ────────────────────────────────────────
        if (params.showBbox) {
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = pal.bbox;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 1.4;
          ctx.setLineDash([6, 4]);
          // Bbox x is mirrored, so the LEFT screen edge is (1 - (x + w)) * W.
          const bx = mx(d.bbox.x + d.bbox.w);
          const by = my(d.bbox.y);
          const bw = d.bbox.w * W;
          const bh = d.bbox.h * H;
          ctx.strokeRect(bx, by, bw, bh);
          ctx.setLineDash([]);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = alpha;

          if (params.showLabel) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = pal.bbox;
            ctx.font = '11px ui-monospace, monospace';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`dog · ${(conf * 100).toFixed(0)}%`, bx + 4, by - 3);
            ctx.globalCompositeOperation = 'lighter';
          }
        }
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* no GPU resources */ },
    };
  },
};
