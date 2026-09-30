// Pose inference worker — runs MediaPipe PoseLandmarker.detectForVideo() off
// the main thread.
//
// Why this exists: detectForVideo() is SYNCHRONOUS and blocks the calling
// thread for the entire forward pass (~20-40ms on Windows). On the main
// thread that block starves Strudel's cyclist (dropped notes) and janks the
// UI / editor. Measured: with the camera on, main-thread perf tanks
// regardless of how many poses or which overlay layers are drawn — it's the
// inference call itself. Moving just that call here lands the block on this
// worker thread instead; the main thread only does a cheap createImageBitmap
// + transfer and keeps the smoothing / linger / joint-reshaping (all cheap).
//
// Protocol (main ⇄ worker):
//   → { type:'init'|'config', opts }      build/rebuild the landmarker
//   ← { type:'ready' }                     landmarker is live
//   → { type:'detect', bitmap, t, source } run inference on a transferred bmp
//   ← { type:'result', landmarks, t, source[, gain][, face] }
//   → { type:'lowlight', amount, auto }    configure the pre-inference boost
//   → { type:'input', pad }                letterbox pad (selfie framing)
//   → { type:'face', on }                  build/close the face anchor detector
//   ← { type:'face-ready'|'face-error' }   face detector state (pose unaffected)
//   ← result.face                          largest face | null (only while armed)
//   → { type:'close' }                     dispose
//   ← { type:'error', error }              build/load failed (main falls back)
//
// Hands live in their own worker (hand-worker.js) so they can run every tick
// with pose-guided crops without halving the pose rate.

// Pinned — see the note in vision-loader.js. Keep VISION_VERSION in sync with
// that file, and the model version ('1') pinned instead of 'latest'.
const VISION_VERSION = '0.10.35';
const VISION_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;
const VISION_WASM   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
// Model versions pinned ('1', not 'latest') — keep this map in sync with
// POSE_MODELS in pose.js. lite = fastest; full is markedly more robust in low
// light for ~2-3× the cost; heavy is the most accurate and much slower.
const POSE_MODELS   = {
  lite:  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full:  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
};
// Face anchor (opt-in, the entangle phones turn it on): BlazeFace short-range
// is built for front-camera selfies and stays locked on in dim, face-filled
// frames where BlazePose confidently returns a garbage body. ~230 KB, a few ms
// per frame. Pinned like the others.
const FACE_MODEL    = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

let PoseLandmarkerCls = null;
let FaceDetectorCls = null;
let faceDetector = null;
let faceWanted = false;
let faceFailed = false;
let fileset = null;
let landmarker = null;
let opts = { numPoses: 3, detectConf: 0.05, presenceConf: 0.05, trackConf: 0.05, model: 'lite' };

// ── Low-light boost ──────────────────────────────────────────────────────────
// Brightens the frames the DETECTOR sees before inference — the on-screen
// preview reads the raw <video> and stays untouched. Manual: amount 0..1 maps
// to a fixed gain. Auto: a 32×18 luma probe (~1 Hz) picks the gain, EMA-
// smoothed so stage lighting changes settle over a few seconds instead of
// pumping the skeleton. KEEP THE MATH IN SYNC with the fallback copy in
// pose.js (this file is a deliberately import-free classic worker, so the
// logic is mirrored rather than shared — don't add a third copy).
let lowLight = { amount: 0, auto: false };
let prepCanvas = null, prepCtx = null;     // padded / lifted frame copy
let lumaCanvas = null,  lumaCtx = null;    // 32×18 probe for auto gain
let autoGain = 1, lumaTick = 0;
const LL_TARGET_LUMA = 110;  // mean 8-bit luma auto aims for (~0.43)
const LL_MAX_GAIN    = 3.5;
const LL_LUMA_EVERY  = 15;   // probe cadence in detect ticks (~1 Hz @ 15fps)

function lowLightActive() { return lowLight.auto || lowLight.amount > 0; }

function currentBoostGain(bitmap) {
  if (!lowLight.auto) return 1 + lowLight.amount * 1.5;
  if (--lumaTick <= 0) {
    lumaTick = LL_LUMA_EVERY;
    try {
      if (!lumaCanvas) {
        lumaCanvas = new OffscreenCanvas(32, 18);
        lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
      }
      lumaCtx.drawImage(bitmap, 0, 0, 32, 18);
      const d = lumaCtx.getImageData(0, 0, 32, 18).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      const mean = sum / (d.length * 0.75);
      const want = Math.max(1, Math.min(LL_MAX_GAIN, LL_TARGET_LUMA / Math.max(mean, 8)));
      autoGain += (want - autoGain) * 0.25;   // settle over ~4s, no pumping
    } catch { /* keep the last gain */ }
  }
  return autoGain;
}

// ── Input framing (selfie pad) ───────────────────────────────────────────────
// A close-up selfie puts the face in most of the frame and the shoulders /
// elbows on (or past) the edges. BlazePose's detector keys on the head and
// then wants room to place the torso — with none it hallucinates a sideways
// skeleton. Letterboxing the frame in a black border (`inputPad` = fraction of
// the frame added on EACH side) shrinks the person relative to the model's
// input and gives the out-of-frame joints somewhere to land; landmarks are
// mapped back into original-frame coords (unpadLandmarks) before they leave
// the worker, so nothing downstream knows. 0 (performer default) = untouched.
let inputPad = 0;
const PREP_MAX_SIDE = 960;   // padded canvas long-side cap (model input is 256²)

// Returns {src, gain, map}. When it draws, src is a NEW ImageBitmap the caller
// must close (transferToImageBitmap, so the detector definitely accepts it);
// otherwise src is the original bitmap. map (null = identity) takes a
// prepped-normalized landmark back to original-frame normalized coords:
// x = x' * sx + ox, y = y' * sy + oy.
function prepFrame(bitmap) {
  const boosting = lowLightActive();
  const gain = boosting ? currentBoostGain(bitmap) : 1;
  const rounded = boosting ? Math.round(gain * 100) / 100 : undefined;
  const lift = gain >= 1.05;                       // below that: not worth a copy
  if (!lift && inputPad <= 0) return { src: bitmap, gain: rounded, map: null };
  try {
    const w = bitmap.width, h = bitmap.height;
    const pw = w * (1 + 2 * inputPad), ph = h * (1 + 2 * inputPad);
    const s = inputPad > 0 ? Math.min(1, PREP_MAX_SIDE / Math.max(pw, ph)) : 1;
    const cw = Math.max(1, Math.round(pw * s)), ch = Math.max(1, Math.round(ph * s));
    const dw = Math.max(1, Math.round(w * s)),  dh = Math.max(1, Math.round(h * s));
    const dx = Math.round((cw - dw) / 2),       dy = Math.round((ch - dh) / 2);
    if (!prepCanvas) {
      prepCanvas = new OffscreenCanvas(cw, ch);
      prepCtx = prepCanvas.getContext('2d');
    }
    if (prepCanvas.width !== cw || prepCanvas.height !== ch) {
      prepCanvas.width = cw; prepCanvas.height = ch;
    }
    const ctx = prepCtx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (inputPad > 0) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch); }
    if (!lift) {
      ctx.drawImage(bitmap, dx, dy, dw, dh);
    } else if (typeof ctx.filter === 'string') {
      // Chrome/Firefox: GPU-accelerated canvas filter. Mild contrast rides
      // along so the lifted image doesn't wash flat.
      ctx.filter = `brightness(${gain}) contrast(${1 + (gain - 1) * 0.25})`;
      ctx.drawImage(bitmap, dx, dy, dw, dh);
      ctx.filter = 'none';
    } else {
      // No ctx.filter (Safari): approximate with a screen-blend of the frame
      // over itself — screen(a,a) = 2a − a², a gamma-ish midtone lift, with
      // the blend alpha standing in for gain.
      ctx.drawImage(bitmap, dx, dy, dw, dh);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = Math.min(1, (gain - 1) / 1.5);
      ctx.drawImage(bitmap, dx, dy, dw, dh);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    const map = inputPad > 0 ? { sx: cw / dw, ox: -dx / dw, sy: ch / dh, oy: -dy / dh } : null;
    return { src: prepCanvas.transferToImageBitmap(), gain: rounded, map };
  } catch {
    return { src: bitmap, gain: rounded, map: null };
  }
}

// Map prepped-frame landmark lists back to original-frame coords. z is in
// roughly x-units, so it takes the x scale.
function unpadLandmarks(list, map) {
  if (!map || !list) return list;
  return list.map(lms => lms.map(lm => ({
    ...lm,
    x: lm.x * map.sx + map.ox,
    y: lm.y * map.sy + map.oy,
    z: typeof lm.z === 'number' ? lm.z * map.sx : lm.z,
  })));
}

async function ensureVision() {
  if (fileset) return;
  const mod = await import(/* @vite-ignore */ VISION_BUNDLE);
  PoseLandmarkerCls = mod.PoseLandmarker;
  FaceDetectorCls = mod.FaceDetector;
  fileset = await mod.FilesetResolver.forVisionTasks(VISION_WASM);
}

// Build/close the face detector to match `faceWanted`. Failures are
// contained: pose keeps running, main gets one 'face-error' to log.
async function syncFaceDetector() {
  if (!faceWanted || faceFailed) {
    if (faceDetector) { try { faceDetector.close(); } catch {} faceDetector = null; }
    return;
  }
  if (faceDetector) return;
  await ensureVision();
  const common = { runningMode: 'VIDEO', minDetectionConfidence: 0.35 };
  try {
    faceDetector = await FaceDetectorCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
    });
  } catch (e) {
    faceDetector = await FaceDetectorCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
    });
  }
}

// Largest detected face (the phone's owner is the one nearest the lens), in
// original-frame normalized coords: { x, y, w, h, score, kp: [[x,y]×6] }.
// kp order is BlazeFace's: right eye, left eye, nose tip, mouth, right ear,
// left ear (subject's right/left). null when there's no face.
function pickFace(detections, iw, ih, map) {
  let best = null, bestA = 0;
  for (const d of detections || []) {
    const bb = d.boundingBox;
    if (!bb) continue;
    const a = bb.width * bb.height;
    if (a > bestA) { bestA = a; best = d; }
  }
  if (!best) return null;
  const bb = best.boundingBox;
  const sx = map ? map.sx : 1, ox = map ? map.ox : 0, sy = map ? map.sy : 1, oy = map ? map.oy : 0;
  return {
    x: (bb.originX / iw) * sx + ox,
    y: (bb.originY / ih) * sy + oy,
    w: (bb.width / iw) * sx,
    h: (bb.height / ih) * sy,
    score: best.categories?.[0]?.score ?? 0,
    kp: (best.keypoints || []).map(k => [k.x * sx + ox, k.y * sy + oy]),
  };
}

async function buildLandmarker() {
  await ensureVision();
  if (landmarker) { try { landmarker.close(); } catch {} landmarker = null; }
  const common = {
    runningMode: 'VIDEO',
    numPoses: opts.numPoses,
    minPoseDetectionConfidence: opts.detectConf,
    minPosePresenceConfidence:  opts.presenceConf,
    minTrackingConfidence:      opts.trackConf,
  };
  // CPU delegate FIRST — deliberate. The whole app is GPU-bound (fx shader +
  // Hydra both render every frame); putting pose inference on the GPU too just
  // makes the GPU the bottleneck, and a saturated GPU stalls the main thread's
  // WebGL submission → the Strudel cyclist starves → dropouts. Running pose on
  // the worker's CPU keeps the GPU free for visuals and the forward pass on an
  // otherwise-idle core, off the main thread. GPU delegate is the fallback if
  // the WASM SIMD/CPU path is unavailable.
  const modelUrl = POSE_MODELS[opts.model] || POSE_MODELS.lite;
  try {
    landmarker = await PoseLandmarkerCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
    });
  } catch (e) {
    landmarker = await PoseLandmarkerCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
    });
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;
  try {
    if (msg.type === 'init' || msg.type === 'config') {
      if (msg.opts) opts = { ...opts, ...msg.opts };
      await buildLandmarker();
      self.postMessage({ type: 'ready' });
      return;
    }
    if (msg.type === 'lowlight') {
      lowLight = { amount: +msg.amount || 0, auto: !!msg.auto };
      if (!lowLight.auto) autoGain = 1;   // fresh ramp next time auto turns on
      lumaTick = 0;                       // re-probe immediately
      return;
    }
    if (msg.type === 'face') {
      faceWanted = !!msg.on;
      if (faceWanted) faceFailed = false;
      try {
        await syncFaceDetector();
        self.postMessage({ type: 'face-ready', on: faceWanted && !!faceDetector });
      } catch (err) {
        faceFailed = true;
        try { faceDetector?.close(); } catch {}
        faceDetector = null;
        self.postMessage({ type: 'face-error', error: String(err?.message || err) });
      }
      return;
    }
    if (msg.type === 'input') {
      const p = +msg.pad;
      inputPad = Math.max(0, Math.min(0.5, Number.isFinite(p) ? p : 0));
      return;
    }
    if (msg.type === 'detect') {
      const { bitmap, t, source } = msg;
      // Pad + low-light boost first; pose and the face anchor both see the
      // prepped frame and get mapped back through the same `map`.
      const { src: det, gain, map } = prepFrame(bitmap);
      let landmarks = [];
      if (landmarker) {
        try {
          const res = landmarker.detectForVideo(det, t);
          landmarks = unpadLandmarks(res?.landmarks ?? [], map);
        } catch { /* timestamp regression / transient — drop this frame */ }
      }
      // Face anchor rides every pose tick (it's the cheap, reliable half).
      // Key present = the detector ran (null = no face); absent = not armed.
      let face;
      if (faceDetector) {
        try {
          const res = faceDetector.detectForVideo(det, t);
          face = pickFace(res?.detections, det.width, det.height, map);
        } catch { /* transient — omit this tick */ }
      }
      try { bitmap.close?.(); } catch {}
      if (det !== bitmap) { try { det.close?.(); } catch {} }
      const out = { type: 'result', landmarks, t, source };
      if (gain !== undefined) out.gain = gain;
      if (face !== undefined) out.face = face;
      self.postMessage(out);
      return;
    }
    if (msg.type === 'close') {
      try { landmarker?.close(); } catch {}
      landmarker = null;
      try { faceDetector?.close(); } catch {}
      faceDetector = null;
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err?.message || err) });
  }
};
