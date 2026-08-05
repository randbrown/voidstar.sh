// Object-detection worker — runs MediaPipe ObjectDetector.detectForVideo()
// off the main thread, for the voidstar-logo scanner HUD.
//
// Same rationale as pose-worker.js: detectForVideo() is SYNCHRONOUS and
// blocks the calling thread for the whole forward pass. EfficientDet-Lite0
// is heavier than the pose model (~60-150ms on CPU), so it must never run
// on the main thread — it would starve the Strudel cyclist and jank the
// render loop. The main thread only does createImageBitmap + transfer.
//
// Protocol (main ⇄ worker):
//   → { type:'init'|'config', opts }       build/rebuild the detector
//   ← { type:'ready' }                      detector is live
//   → { type:'detect', bitmap, t }          run inference on a transferred bmp
//   ← { type:'result', detections, t }      normalized [0,1] boxes + labels
//   → { type:'close' }                      dispose
//   ← { type:'error', error }               build/load failed (main gives up)

// Pinned — see the note in vision-loader.js. Keep VISION_VERSION in sync
// with that file and pose-worker.js, and the model version ('1') pinned
// instead of 'latest'.
const VISION_VERSION = '0.10.35';
const VISION_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;
const VISION_WASM   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const DETECT_MODEL  = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

let ObjectDetectorCls = null;
let fileset = null;
let detector = null;
let opts = { maxResults: 8, scoreThreshold: 0.35 };

async function ensureVision() {
  if (fileset) return;
  const mod = await import(/* @vite-ignore */ VISION_BUNDLE);
  ObjectDetectorCls = mod.ObjectDetector;
  fileset = await mod.FilesetResolver.forVisionTasks(VISION_WASM);
}

async function buildDetector() {
  await ensureVision();
  if (detector) { try { detector.close(); } catch {} detector = null; }
  const common = {
    runningMode: 'VIDEO',
    maxResults: opts.maxResults,
    scoreThreshold: opts.scoreThreshold,
  };
  // CPU delegate FIRST — same reasoning as pose-worker.js: the app is
  // GPU-bound (fx shader + Hydra), so inference belongs on an otherwise-idle
  // CPU core. GPU delegate is the fallback if the WASM SIMD path is missing.
  try {
    detector = await ObjectDetectorCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: DETECT_MODEL, delegate: 'CPU' },
    });
  } catch (e) {
    detector = await ObjectDetectorCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: DETECT_MODEL, delegate: 'GPU' },
    });
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;
  try {
    if (msg.type === 'init' || msg.type === 'config') {
      if (msg.opts) opts = { ...opts, ...msg.opts };
      await buildDetector();
      self.postMessage({ type: 'ready' });
      return;
    }
    if (msg.type === 'detect') {
      const { bitmap, t } = msg;
      const w = bitmap.width, h = bitmap.height;
      const out = [];
      if (detector && w > 0 && h > 0) {
        try {
          const res = detector.detectForVideo(bitmap, t);
          // boundingBox is in input-image pixels; normalize here so the main
          // thread never needs to know the capture resolution.
          for (const det of res?.detections ?? []) {
            const bb = det.boundingBox;
            const cat = det.categories?.[0];
            if (!bb || !cat) continue;
            out.push({
              cx: (bb.originX + bb.width  * 0.5) / w,
              cy: (bb.originY + bb.height * 0.5) / h,
              hw: (bb.width  * 0.5) / w,
              hh: (bb.height * 0.5) / h,
              label: (cat.categoryName || 'object').toLowerCase(),
              score: cat.score || 0,
            });
          }
        } catch { /* timestamp regression / transient — drop this frame */ }
      }
      try { bitmap.close?.(); } catch {}
      self.postMessage({ type: 'result', detections: out, t });
      return;
    }
    if (msg.type === 'close') {
      try { detector?.close(); } catch {}
      detector = null;
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err?.message || err) });
  }
};
