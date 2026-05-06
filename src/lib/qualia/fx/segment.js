// Segment — camera-driven semantic segmentation. MediaPipe Tasks Vision
// ImageSegmenter with the selfie_multiclass model paints six classes
// (bg / hair / body-skin / face-skin / clothes / accessories) which we
// render as audio/pose-reactive silhouettes.
//
// SAM2 is the obvious "segment anything" choice but runs at 1-5 fps in
// browser; selfie_multiclass is ~30-60 fps on GPU delegate, ~700 KB,
// served from the same MediaPipe CDN bundle pose.js already loads.
//
// Camera lifecycle: piggybacks on the topbar pose-source select (single
// source of truth for camera ownership). When pose-source is off, paints
// the same placeholder string camera.js uses.

import { getVideoEl, getRotation, applyPreviewTransform } from '../video.js';
import { scaleAudio } from '../field.js';

const SEG_BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs';
const SEG_WASM   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm';
const SEG_MODEL  = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

// selfie_multiclass class indices.
const NUM_CLASSES = 6;
// 0 bg | 1 hair | 2 body-skin | 3 face-skin | 4 clothes | 5 accessories
const PALETTES = {
  void:      [[5,5,13,0],   [139,92,246,235], [34,211,238,235], [244,114,182,235], [251,191,36,235],  [74,222,128,235]],
  nightclub: [[5,5,13,0],   [244,114,182,235],[244,114,182,235],[251,191,36,235],  [139,92,246,235],  [34,211,238,235]],
  aurora:    [[5,5,13,0],   [74,222,128,235], [34,211,238,235], [139,92,246,235],  [244,114,182,235], [251,191,36,235]],
  mono:      [[5,5,13,0],   [220,225,240,235],[220,225,240,235],[220,225,240,235], [220,225,240,235], [220,225,240,235]],
};

// Module-level singleton — both pose.js and segment.js can share one
// FilesetResolver if loaded together. Kept private to this module for
// now; promoting to a shared `vision-loader.js` helper is a future tidy.
let _visionPromise = null;
async function loadVision() {
  if (_visionPromise) return _visionPromise;
  _visionPromise = (async () => {
    const mod = await import(/* @vite-ignore */ SEG_BUNDLE);
    const fileset = await mod.FilesetResolver.forVisionTasks(SEG_WASM);
    return { mod, fileset };
  })();
  return _visionPromise;
}

const rgba = (c) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)})`;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'segment',
  name: 'Segment',
  contextType: 'canvas2d',

  params: [
    { id: 'style',    label: 'style',    type: 'select',
      options: ['silhouettes','contours','aurora','xray'], default: 'silhouettes' },
    { id: 'palette',  label: 'palette',  type: 'select',
      options: ['void','nightclub','aurora','mono'], default: 'void' },
    { id: 'glow',     label: 'glow',     type: 'range', min: 0, max: 1,    step: 0.02, default: 0.45,
      modulators: [
        { source: 'audio.bass',      mode: 'mul', amount: 0.6 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.25 },
      ] },
    { id: 'edgeWidth',label: 'edge',     type: 'range', min: 0, max: 6,    step: 0.25, default: 1.5,
      modulators: [
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.6 },
      ] },
    { id: 'feather',  label: 'feather',  type: 'range', min: 0, max: 1,    step: 0.02, default: 0.35,
      modulators: [
        { source: 'pose.wristMidY', mode: 'mul', amount: 0.4 },
      ] },
    { id: 'persistence',  label: 'persist',     type: 'range', min: 0, max: 0.95, step: 0.05, default: 0.5 },
    { id: 'inferenceFps', label: 'infer fps',   type: 'range', min: 5, max: 30,   step: 5,    default: 15 },
    { id: 'showHair',     label: 'hair',        type: 'toggle', default: true  },
    { id: 'showBody',     label: 'body',        type: 'toggle', default: true  },
    { id: 'showFace',     label: 'face',        type: 'toggle', default: true  },
    { id: 'showClothes',  label: 'clothes',     type: 'toggle', default: true  },
    { id: 'showAcc',      label: 'accessories', type: 'toggle', default: false },
    { id: 'showBg',       label: 'background',  type: 'toggle', default: false },
    { id: 'reactivity',   label: 'reactivity',  type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  presets: {
    default: { style: 'silhouettes', palette: 'void',      glow: 0.45, edgeWidth: 1.5, feather: 0.35, persistence: 0.5, reactivity: 1.0 },
    aurora:  { style: 'aurora',      palette: 'aurora',    glow: 0.55, edgeWidth: 0.5, feather: 0.45, persistence: 0.6, reactivity: 1.2 },
    void:    { style: 'silhouettes', palette: 'void',      glow: 0.65, edgeWidth: 1.0, feather: 0.30, persistence: 0.7, reactivity: 1.0 },
    xray:    { style: 'contours',    palette: 'nightclub', glow: 0.30, edgeWidth: 2.5, feather: 0.20, persistence: 0.4, reactivity: 1.0 },
  },

  autoPhase: {
    steps: [
      { style: 'silhouettes', palette: 'void' },
      { style: 'aurora',      palette: 'aurora' },
      { style: 'contours',    palette: 'nightclub' },
      { style: 'xray',        palette: 'mono' },
    ],
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    let disposed = false;
    let segmenter = null;

    const MASK_W = 256, MASK_H = 256;
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = MASK_W; maskCanvas.height = MASK_H;
    const maskCtx = maskCanvas.getContext('2d');
    const colorBuffer = new Uint8ClampedArray(MASK_W * MASK_H * 4);
    const maskImageData = new ImageData(colorBuffer, MASK_W, MASK_H);

    const prevCanvas = document.createElement('canvas');
    prevCanvas.width = W; prevCanvas.height = H;
    const prevCtx = prevCanvas.getContext('2d');

    let hasFirstResult = false;
    let lastDetectTickMs = 0;
    let detectIntervalMs = 1000 / 15;

    const scratch = {
      style: 'silhouettes', palette: 'void',
      glow: 0.45, edgeWidth: 1.5, feather: 0.35, persistence: 0.5,
      showBg: false, showHair: true, showBody: true,
      showFace: true, showClothes: true, showAcc: false,
      audioOn: false, bass: 0, beatP: 0,
      time: 0,
    };

    try {
      const { mod, fileset } = await loadVision();
      const opts = {
        baseOptions: { modelAssetPath: SEG_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      };
      try {
        segmenter = await mod.ImageSegmenter.createFromOptions(fileset, opts);
      } catch (gpuErr) {
        console.warn('[segment] GPU delegate failed; retrying on CPU:', gpuErr?.message || gpuErr);
        segmenter = await mod.ImageSegmenter.createFromOptions(fileset, {
          ...opts,
          baseOptions: { modelAssetPath: SEG_MODEL, delegate: 'CPU' },
        });
      }
      // If the user switched fx during the long model download, close
      // immediately rather than leaking the GPU-backed segmenter.
      if (disposed) { try { segmenter.close(); } catch {} segmenter = null; }
    } catch (err) {
      console.error('[segment] failed to initialize ImageSegmenter:', err);
    }

    function colorizeMask(maskU8) {
      const palette = PALETTES[scratch.palette] || PALETTES.void;
      const show = [
        scratch.showBg, scratch.showHair, scratch.showBody,
        scratch.showFace, scratch.showClothes, scratch.showAcc,
      ];
      const buf = colorBuffer;
      const len = MASK_W * MASK_H;
      for (let i = 0; i < len; i++) {
        const cls = maskU8[i];
        const j = i * 4;
        if (cls >= NUM_CLASSES || !show[cls]) {
          buf[j] = 0; buf[j + 1] = 0; buf[j + 2] = 0; buf[j + 3] = 0;
          continue;
        }
        const c = palette[cls];
        buf[j] = c[0]; buf[j + 1] = c[1]; buf[j + 2] = c[2]; buf[j + 3] = c[3];
      }
      maskCtx.putImageData(maskImageData, 0, 0);
      hasFirstResult = true;
    }

    function onResult(result) {
      try {
        if (result?.categoryMask) {
          const u8 = result.categoryMask.getAsUint8Array();
          colorizeMask(u8);
          // MPMask wraps a GPU texture. Without close() the WebGL pool fills
          // up within a few minutes and the page silently stops getting new
          // masks. Skip at your peril.
          result.categoryMask.close();
        }
      } catch { /* swallow */ }
    }

    // Private detect loop, mirroring pose.js startDetectLoop. rAF gates a
    // throttle on detectIntervalMs; segmentForVideo blocks the main thread
    // briefly during WASM bridging so we cap at the user's inferenceFps.
    (function detectLoop() {
      if (disposed) return;
      requestAnimationFrame(detectLoop);
      if (!segmenter) return;
      const tickT = performance.now();
      if (tickT - lastDetectTickMs < detectIntervalMs) return;
      lastDetectTickMs = tickT;
      const video = getVideoEl();
      if (!video || video.readyState < 2 || video.paused || video.ended) return;
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      try {
        segmenter.segmentForVideo(video, tickT, onResult);
      } catch { /* swallow timestamp regressions */ }
    })();

    // Helper: with the preview transform already applied, draw maskCanvas
    // (or any 256×256 source) covering the canvas at video aspect. growFactor
    // > 1 dilates for the contour pass.
    function drawMaskCover(sourceCanvas, growFactor) {
      const rot = getRotation();
      const video = getVideoEl();
      const rotated = rot === 90 || rot === 270;
      const dispW = rotated ? H : W;
      const dispH = rotated ? W : H;
      const vw = video?.videoWidth || dispW;
      const vh = video?.videoHeight || dispH;
      const scale = Math.max(dispW / vw, dispH / vh);
      const dw = vw * scale * growFactor;
      const dh = vh * scale * growFactor;
      ctx.drawImage(sourceCanvas, -dw / 2, -dh / 2, dw, dh);
    }

    function drawVideoCover(video) {
      const rot = getRotation();
      const rotated = rot === 90 || rot === 270;
      const dispW = rotated ? H : W;
      const dispH = rotated ? W : H;
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = Math.max(dispW / vw, dispH / vh);
      ctx.drawImage(video, -vw * scale / 2, -vh * scale / 2, vw * scale, vh * scale);
    }

    function update(field) {
      const { params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      scratch.style       = params.style;
      scratch.palette     = params.palette;
      scratch.glow        = params.glow;
      scratch.edgeWidth   = params.edgeWidth;
      scratch.feather     = params.feather;
      scratch.persistence = Math.max(0, Math.min(0.95, params.persistence));
      scratch.showBg      = !!params.showBg;
      scratch.showHair    = !!params.showHair;
      scratch.showBody    = !!params.showBody;
      scratch.showFace    = !!params.showFace;
      scratch.showClothes = !!params.showClothes;
      scratch.showAcc     = !!params.showAcc;
      scratch.audioOn     = !!audio.spectrum;
      scratch.bass        = audio.bands.bass;
      scratch.beatP       = audio.beat.pulse;
      scratch.time        = field.time;
      detectIntervalMs    = 1000 / Math.max(5, params.inferenceFps);
    }

    function drawPlaceholder() {
      ctx.fillStyle = 'rgba(180,200,220,0.5)';
      ctx.font = '600 18px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('camera off — set pose source to "camera"', W / 2, H / 2);
      ctx.textAlign = 'left';
    }

    function paintSilhouettes() {
      // Base flat fill — palette colors blitted through preview transform.
      ctx.save();
      applyPreviewTransform(ctx, W, H);
      const featherPx = scratch.feather * H * 0.012;
      ctx.imageSmoothingQuality = 'low';
      if (featherPx > 0.1) ctx.filter = `blur(${featherPx.toFixed(2)}px)`;
      drawMaskCover(maskCanvas, 1);
      ctx.filter = 'none';
      ctx.restore();
      // Boundary bloom — additive blurred copy on top.
      const bloomPx = scratch.glow * 24;
      if (bloomPx > 0.5) {
        ctx.save();
        applyPreviewTransform(ctx, W, H);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.18;
        ctx.imageSmoothingQuality = 'low';
        ctx.filter = `blur(${bloomPx.toFixed(1)}px)`;
        drawMaskCover(maskCanvas, 1);
        ctx.filter = 'none';
        ctx.restore();
      }
    }

    function paintContours() {
      // Outline ring: dilated mask − original mask via destination-out.
      const ringPx = Math.max(0.5, scratch.edgeWidth);
      const grow = 1 + (ringPx / 256);
      ctx.save();
      applyPreviewTransform(ctx, W, H);
      ctx.imageSmoothingQuality = 'low';
      ctx.globalCompositeOperation = 'source-over';
      drawMaskCover(maskCanvas, grow);
      ctx.globalCompositeOperation = 'destination-out';
      drawMaskCover(maskCanvas, 1);
      ctx.restore();
    }

    function paintAurora() {
      // Mask first (palette fills), then over-paint with an animated linear
      // gradient using source-atop so it only colors the masked regions.
      ctx.save();
      applyPreviewTransform(ctx, W, H);
      const featherPx = scratch.feather * H * 0.012;
      if (featherPx > 0.1) ctx.filter = `blur(${featherPx.toFixed(2)}px)`;
      ctx.imageSmoothingQuality = 'low';
      drawMaskCover(maskCanvas, 1);
      ctx.filter = 'none';
      ctx.restore();

      const palette = PALETTES[scratch.palette] || PALETTES.void;
      const angle = scratch.time * 0.45;
      const dx = Math.cos(angle) * H * 0.5;
      const dy = Math.sin(angle) * H * 0.5;
      const grad = ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
      grad.addColorStop(0,   rgba(palette[1]));
      grad.addColorStop(0.5, rgba(palette[2]));
      grad.addColorStop(1,   rgba(palette[4]));
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    function paintXray(video) {
      // Live camera underlay, mask on top with `difference` for a ghosted
      // photo-negative look.
      ctx.save();
      applyPreviewTransform(ctx, W, H);
      ctx.imageSmoothingQuality = 'low';
      drawVideoCover(video);
      const featherPx = scratch.feather * H * 0.012;
      if (featherPx > 0.1) ctx.filter = `blur(${featherPx.toFixed(2)}px)`;
      ctx.globalCompositeOperation = 'difference';
      drawMaskCover(maskCanvas, 1);
      ctx.filter = 'none';
      ctx.restore();
    }

    function render() {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);

      const video = getVideoEl();
      const ready = video && video.videoWidth > 0 && video.videoHeight > 0;
      if (!ready) { drawPlaceholder(); return; }
      if (!hasFirstResult) return;  // avoid stale prevCanvas garbage on first frames

      if (scratch.persistence > 0.01) {
        ctx.globalAlpha = scratch.persistence;
        ctx.drawImage(prevCanvas, 0, 0, W, H);
        ctx.globalAlpha = 1;
      }

      switch (scratch.style) {
        case 'contours': paintContours();   break;
        case 'aurora':   paintAurora();     break;
        case 'xray':     paintXray(video);  break;
        case 'silhouettes':
        default:         paintSilhouettes(); break;
      }

      // Snapshot composite → prevCanvas for next frame's persistence trail.
      prevCtx.globalCompositeOperation = 'copy';
      prevCtx.drawImage(canvas, 0, 0, W, H);
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        prevCanvas.width = w; prevCanvas.height = h;
      },
      update,
      render,
      dispose() {
        disposed = true;
        try { segmenter?.close(); } catch {}
        segmenter = null;
      },
    };
  },
};
