// Camera — the live camera feed as the visualizer, with canvas2d-native
// artistic treatments. Leans into what 2D compositing does uniquely well
// (frame feedback, geometric folds, pose-driven masking) rather than
// re-implementing the WebGL glitch pipeline that the Video quale owns —
// for true per-pixel chroma/datamosh, point the data-mosh overlay at this
// quale or use the Video quale with a camera source.
//
// Reads the bound HTMLVideoElement directly via video.js so it doesn't have
// to own the camera lifecycle — the user enables the camera via the topbar
// pose-source select (or by activating any pose-using quale) and this quale
// just paints whatever stream is currently flowing.
//
// Pipeline per frame (all canvas2d, no getImageData):
//   1. draw the fitted/mirrored/rotated frame into an offscreen `src` buffer
//   2. compose into the visible canvas: a faded, optionally zoom/rotated
//      copy of the *previous* composited frame (the feedback buffer) +
//      the new frame at a blend weight → motion trails / infinite tunnel.
//      Optionally fold the frame into an N-segment kaleidoscope pivoted on
//      the tracked head.
//   3. snapshot the composite back into the feedback buffer (pre-grade, so
//      the tint/vignette don't compound across the feedback loop)
//   4. grade for display: tint, body spotlight, vignette — all audio-reactive
//
// Audio map: bands.bass → feedback/trail length (declarative modulator);
//   beat.pulse → tint boost + vignette/spotlight tighten (in-code punch).
// Pose: head landmark (via lmToCanvas, matching the overlay's mirror+rotate)
//   centers the kaleidoscope pivot and the spotlight; smoothed to de-jitter.
//   The skeleton itself is painted by the global overlay, as for every quale.

import { getVideoEl, getRotation, applyPreviewTransform, lmToCanvas } from '../video.js';
import { scaleAudio } from '../field.js';

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'camera',
  name: 'Camera',
  contextType: 'canvas2d',

  params: [
    // `look` is a real param so autoPhase can address it via setParam — each
    // step flips the select and update() applies the named preset via
    // applyPreset, exactly like the Video quale's `preset`. 'custom' is not a
    // preset, so selecting it is a no-op anchor that lets you dial freely.
    { id: 'look',      label: 'look',       type: 'select', options: ['custom', 'clean', 'trails', 'tunnel', 'kaleido', 'spotlight', 'nightclub'], default: 'clean' },
    { id: 'fit',       label: 'fit',        type: 'select', options: ['cover', 'contain'], default: 'cover' },

    // Feedback persistence — fraction of the previous frame retained. The new
    // frame is blended in at (1 - feedback), so this reads as trail length.
    // Bass-reactive so trails breathe with the low end.
    { id: 'feedback',  label: 'trails',     type: 'range', min: 0, max: 1, step: 0.02, default: 0.0,
      modulators: [{ source: 'audio.bass', mode: 'add', amount: 0.10 }] },
    // Tunnel — per-frame zoom (+) / push (−) and a slight rotation applied to
    // the retained feedback, so the persistent image spirals outward/inward.
    // Only visible when `feedback` > 0.
    { id: 'tunnel',    label: 'tunnel',     type: 'range', min: -1, max: 1, step: 0.02, default: 0.0 },
    // Kaleidoscope segments, pivoted on the tracked head. 'off' = cost zero.
    { id: 'kaleido',   label: 'kaleido',    type: 'select', options: ['off', '2', '4', '6', '8'], default: 'off' },
    // Body spotlight — radial light centered on the head/torso instead of the
    // frame center, so the person stays lit while the room falls to black.
    { id: 'spotlight', label: 'spotlight',  type: 'range', min: 0, max: 1, step: 0.02, default: 0.0 },

    { id: 'tint',      label: 'tint',       type: 'select', options: ['none', 'mono', 'cyan', 'magenta', 'amber'], default: 'none' },
    { id: 'vignette',  label: 'vignette',   type: 'range', min: 0, max: 1, step: 0.02, default: 0.30 },
    { id: 'pulse',     label: 'audio pulse',type: 'range', min: 0, max: 1, step: 0.02, default: 0.30 },
    { id: 'reactivity',label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks the looks — one knob cycles the whole aesthetic. Each
  // step just flips `look`; update() sees the change and applies the preset.
  autoPhase: {
    steps: [
      { look: 'clean' },
      { look: 'trails' },
      { look: 'tunnel' },
      { look: 'kaleido' },
      { look: 'spotlight' },
      { look: 'nightclub' },
    ],
  },

  // Each preset sets every treatment knob so switching looks is a clean slate
  // (matching the Video quale). 'custom' is intentionally absent.
  presets: {
    clean:     { fit: 'cover', feedback: 0.0,  tunnel: 0.0,  kaleido: 'off', spotlight: 0.0, tint: 'none',    vignette: 0.30, pulse: 0.30, reactivity: 1.0 },
    trails:    { feedback: 0.82, tunnel: 0.0,  kaleido: 'off', spotlight: 0.0, tint: 'none',    vignette: 0.22, pulse: 0.45 },
    tunnel:    { feedback: 0.88, tunnel: 0.55, kaleido: 'off', spotlight: 0.0, tint: 'cyan',    vignette: 0.30, pulse: 0.55 },
    kaleido:   { feedback: 0.40, tunnel: 0.06, kaleido: '6',   spotlight: 0.0, tint: 'magenta', vignette: 0.20, pulse: 0.45 },
    spotlight: { feedback: 0.0,  tunnel: 0.0,  kaleido: 'off', spotlight: 0.85, tint: 'none',   vignette: 0.0,  pulse: 0.30 },
    nightclub: { feedback: 0.60, tunnel: 0.20, kaleido: '4',   spotlight: 0.30, tint: 'magenta', vignette: 0.50, pulse: 0.60 },
  },

  async create(canvas, { ctx, applyPreset }) {
    let W = canvas.width, H = canvas.height;

    // Offscreen buffers: `src` holds the plain fitted frame (kaleido samples
    // it), `fb` holds the previous composite (the feedback accumulator).
    const srcCanvas = document.createElement('canvas');
    const fbCanvas  = document.createElement('canvas');
    srcCanvas.width = W; srcCanvas.height = H;
    fbCanvas.width  = W; fbCanvas.height  = H;
    const sctx = srcCanvas.getContext('2d');
    const fctx = fbCanvas.getContext('2d');

    // Scratch updated by update(), consumed by render().
    const scratch = {
      fit: 'cover', tint: 'none', vignette: 0.30, pulse: 0.30,
      feedback: 0, tunnel: 0, kaleido: 0, spotlight: 0,
      audioOn: false, bass: 0, beatP: 0,
      // Smoothed pivot for kaleido/spotlight (canvas px). Seeded to center so
      // it's sensible before the first pose lands / when nobody is detected.
      cx: W / 2, cy: H / 2,
    };
    let lastLook = null;

    function update(field) {
      const { params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);

      // Look-change detection — apply the named preset through the core's
      // full-panel path so every slider moves in lockstep. Skip the first
      // frame (null → 'clean') so it doesn't clobber persisted user tweaks.
      if (lastLook !== params.look) {
        const prev = lastLook;
        lastLook = params.look;
        if (prev !== null && typeof applyPreset === 'function') applyPreset(params.look);
      }

      scratch.fit       = params.fit;
      scratch.tint      = params.tint;
      scratch.vignette  = params.vignette;
      scratch.pulse     = params.pulse;
      scratch.feedback  = params.feedback;
      scratch.tunnel    = params.tunnel;
      scratch.kaleido   = params.kaleido === 'off' ? 0 : parseInt(params.kaleido, 10) || 0;
      scratch.spotlight = params.spotlight;
      scratch.audioOn   = !!audio.spectrum;
      scratch.bass      = audio.bands.bass;
      scratch.beatP     = audio.beat.pulse;

      // Track the head for the kaleido pivot + spotlight, in the same canvas
      // space the frame is drawn into (lmToCanvas applies mirror+rotation to
      // match the displayed orientation). Smooth to kill landmark jitter.
      const person = field.pose?.people?.[0];
      let tx = W / 2, ty = H / 2;
      if (person && person.head && person.head.visibility > 0.3) {
        const [px, py] = lmToCanvas(person.head.x, person.head.y, W, H);
        tx = px; ty = py;
      }
      scratch.cx += (tx - scratch.cx) * 0.18;
      scratch.cy += (ty - scratch.cy) * 0.18;
    }

    // Draw the live frame into a 2D context, fitted (cover/contain) and with
    // the camera's mirror + rotation applied — shared by the src-buffer fill.
    function drawFittedFrame(c2d, video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const rot = getRotation();
      // 90/270 swap the effective bbox so cover/contain fit the whole canvas.
      const rotated = rot === 90 || rot === 270;
      const ew = rotated ? vh : vw;
      const eh = rotated ? vw : vh;
      const sx = W / ew, sy = H / eh;
      const scale = scratch.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
      c2d.save();
      applyPreviewTransform(c2d, W, H);
      c2d.drawImage(video, -vw * scale / 2, -vh * scale / 2, vw * scale, vh * scale);
      c2d.restore();
    }

    // Fold the source buffer into an N-segment kaleidoscope around (cx,cy).
    // Alternating segments are mirrored so the wedges meet seamlessly.
    function drawKaleido(dst, src, segments, cx, cy) {
      const ang = (Math.PI * 2) / segments;
      // Radius large enough to cover the farthest corner from the pivot.
      const R = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) + 8;
      for (let i = 0; i < segments; i++) {
        dst.save();
        dst.translate(cx, cy);
        dst.rotate(i * ang);
        if (i % 2 === 1) dst.scale(1, -1);   // reflect every other wedge
        dst.beginPath();
        dst.moveTo(0, 0);
        dst.arc(0, 0, R, -ang / 2, ang / 2);
        dst.closePath();
        dst.clip();
        // Sample the source so its (cx,cy) sits at the pivot — the body stays
        // at the heart of the fold rather than the canvas corner.
        dst.drawImage(src, -cx, -cy);
        dst.restore();
      }
    }

    function resetBuffers() {
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, W, H);
      fctx.clearRect(0, 0, W, H);
    }

    function render() {
      const video = getVideoEl();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      const ready = video && video.videoWidth > 0 && video.videoHeight > 0;
      if (!ready) {
        ctx.fillStyle = '#05050d';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(180,200,220,0.5)';
        ctx.font = '600 18px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('camera off — set pose source to "camera"', W / 2, H / 2);
        ctx.textAlign = 'left';
        resetBuffers();   // don't trail a stale frame back in when it returns
        return;
      }

      // 1. Plain fitted frame → src buffer.
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, W, H);
      drawFittedFrame(sctx, video);

      // 2. Compose with feedback. New-frame weight: high feedback → fainter
      // new frame → longer trails. Clamp so the live frame never fully
      // freezes (always ≥ 7% fresh).
      const fb = scratch.feedback;
      const newWeight = fb > 0.001 ? 1 - Math.min(fb, 0.93) : 1;
      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);
      if (fb > 0.001) {
        // Retained history, optionally zoom/rotated for the tunnel feel.
        const tz = 1 + scratch.tunnel * 0.05;
        const tr = scratch.tunnel * 0.012;
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate(tr);
        ctx.scale(tz, tz);
        ctx.translate(-W / 2, -H / 2);
        ctx.drawImage(fbCanvas, 0, 0, W, H);
        ctx.restore();
      }
      ctx.globalAlpha = newWeight;
      if (scratch.kaleido > 1) {
        drawKaleido(ctx, srcCanvas, scratch.kaleido, scratch.cx, scratch.cy);
      } else {
        ctx.drawImage(srcCanvas, 0, 0, W, H);
      }
      ctx.globalAlpha = 1;

      // 3. Snapshot the composite into the feedback buffer BEFORE grading, so
      // tint/vignette/spotlight don't compound through the feedback loop.
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      fctx.globalAlpha = 1;
      fctx.globalCompositeOperation = 'source-over';
      fctx.clearRect(0, 0, W, H);
      fctx.drawImage(canvas, 0, 0, W, H);

      // 4. Grade for display.
      // Tint pass — flat overlay, multiply for colour / saturation for mono.
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
        ctx.globalAlpha = Math.min(1, 0.55 + audioBoost);
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      // Body spotlight — radial light on the tracked head/torso; beat tightens
      // the bright core. Distinct from the centered vignette below.
      if (scratch.spotlight > 0.01) {
        const punch = scratch.audioOn ? scratch.beatP * scratch.pulse * 0.3 : 0;
        const amt = Math.min(1, scratch.spotlight + punch * 0.4);
        const minDim = Math.min(W, H);
        const rInner = minDim * (0.20 - punch * 0.06);
        const rOuter = Math.hypot(W, H) * 0.62;
        const grad = ctx.createRadialGradient(scratch.cx, scratch.cy, rInner, scratch.cx, scratch.cy, rOuter);
        grad.addColorStop(0, 'rgba(5,5,13,0)');
        grad.addColorStop(1, `rgba(5,5,13,${amt})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }

      // Audio-modulated vignette — centered radial darken from the corners.
      if (scratch.vignette > 0.01) {
        const audioPunch = scratch.audioOn ? scratch.beatP * scratch.pulse * 0.35 : 0;
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
      resize(w, h /*, dpr */) {
        W = w; H = h;
        // Resizing a canvas clears it — the feedback loop reseeds next frame.
        srcCanvas.width = W; srcCanvas.height = H;
        fbCanvas.width  = W; fbCanvas.height  = H;
        // Re-center the pivot so it isn't stranded off the new bounds.
        scratch.cx = W / 2; scratch.cy = H / 2;
      },
      update,
      render,
      dispose() {
        // Drop the offscreen backing stores promptly.
        srcCanvas.width = srcCanvas.height = 0;
        fbCanvas.width  = fbCanvas.height  = 0;
      },
    };
  },
};
