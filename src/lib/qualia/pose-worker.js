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
//   ← { type:'result', landmarks, t, source[, hands][, gain] }
//   → { type:'lowlight', amount, auto }    configure the pre-inference boost
//   → { type:'hands', on }                 build/close the hand landmarker
//   ← { type:'hands-ready', on }           hand landmarker state settled
//   ← { type:'hands-error', error }        hand model failed (pose unaffected)
//   → { type:'close' }                     dispose
//   ← { type:'error', error }              build/load failed (main falls back)
//
// Hands are OPT-IN (the horns 🤘 detector turns them on) and piggyback on
// the same transferred bitmap, so enabling them costs zero extra capture
// work on the main thread — just a second CPU inference here, run every
// HANDS_EVERY_N pose ticks (a held gesture doesn't need 15 fps).

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
// Pinned like POSE_MODEL — a live set must not change gesture behavior
// because the CDN reissued the model.
const HAND_MODEL    = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const HANDS_EVERY_N = 2; // hand inference cadence, in pose ticks

let PoseLandmarkerCls = null;
let HandLandmarkerCls = null;
let fileset = null;
let landmarker = null;
let handLandmarker = null;
let handsWanted = false;
let handsFailed = false;
let handTick = 0;
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
let boostCanvas = null, boostCtx = null;   // full-res filtered frame copy
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

// Returns {src, gain}. When boosting, src is a NEW ImageBitmap the caller
// must close (transferToImageBitmap, so the detector definitely accepts it);
// otherwise src is the original bitmap.
function boostFrame(bitmap) {
  const gain = currentBoostGain(bitmap);
  const rounded = Math.round(gain * 100) / 100;
  if (gain < 1.05) return { src: bitmap, gain: rounded };  // not worth a copy
  try {
    const w = bitmap.width, h = bitmap.height;
    if (!boostCanvas) {
      boostCanvas = new OffscreenCanvas(w, h);
      boostCtx = boostCanvas.getContext('2d');
    }
    if (boostCanvas.width !== w || boostCanvas.height !== h) {
      boostCanvas.width = w; boostCanvas.height = h;
    }
    if (typeof boostCtx.filter === 'string') {
      // Chrome/Firefox: GPU-accelerated canvas filter. Mild contrast rides
      // along so the lifted image doesn't wash flat.
      boostCtx.filter = `brightness(${gain}) contrast(${1 + (gain - 1) * 0.25})`;
      boostCtx.drawImage(bitmap, 0, 0, w, h);
      boostCtx.filter = 'none';
    } else {
      // No ctx.filter (Safari): approximate with a screen-blend of the frame
      // over itself — screen(a,a) = 2a − a², a gamma-ish midtone lift, with
      // the blend alpha standing in for gain.
      boostCtx.globalCompositeOperation = 'source-over';
      boostCtx.globalAlpha = 1;
      boostCtx.drawImage(bitmap, 0, 0, w, h);
      boostCtx.globalCompositeOperation = 'screen';
      boostCtx.globalAlpha = Math.min(1, (gain - 1) / 1.5);
      boostCtx.drawImage(bitmap, 0, 0, w, h);
      boostCtx.globalCompositeOperation = 'source-over';
      boostCtx.globalAlpha = 1;
    }
    return { src: boostCanvas.transferToImageBitmap(), gain: rounded };
  } catch {
    return { src: bitmap, gain: rounded };
  }
}

async function ensureVision() {
  if (fileset) return;
  const mod = await import(/* @vite-ignore */ VISION_BUNDLE);
  PoseLandmarkerCls = mod.PoseLandmarker;
  HandLandmarkerCls = mod.HandLandmarker;
  fileset = await mod.FilesetResolver.forVisionTasks(VISION_WASM);
}

// Build/close the hand landmarker to match `handsWanted`. Failures are
// contained: pose keeps running, main gets one 'hands-error' to log.
async function syncHandLandmarker() {
  if (!handsWanted || handsFailed) {
    if (handLandmarker) { try { handLandmarker.close(); } catch {} handLandmarker = null; }
    return;
  }
  if (handLandmarker) return;
  await ensureVision();
  const common = { runningMode: 'VIDEO', numHands: 2 };
  // CPU-first for the same reason as the pose landmarker below.
  try {
    handLandmarker = await HandLandmarkerCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'CPU' },
    });
  } catch (e) {
    handLandmarker = await HandLandmarkerCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
    });
  }
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
    if (msg.type === 'hands') {
      handsWanted = !!msg.on;
      if (handsWanted) handsFailed = false; // fresh retry budget per enable
      try {
        await syncHandLandmarker();
        self.postMessage({ type: 'hands-ready', on: handsWanted && !!handLandmarker });
      } catch (err) {
        handsFailed = true;
        try { handLandmarker?.close(); } catch {}
        handLandmarker = null;
        self.postMessage({ type: 'hands-error', error: String(err?.message || err) });
      }
      return;
    }
    if (msg.type === 'lowlight') {
      lowLight = { amount: +msg.amount || 0, auto: !!msg.auto };
      if (!lowLight.auto) autoGain = 1;   // fresh ramp next time auto turns on
      lumaTick = 0;                       // re-probe immediately
      return;
    }
    if (msg.type === 'detect') {
      const { bitmap, t, source } = msg;
      // Low-light boost first, so pose AND hands both see the lifted frame.
      let det = bitmap, gain;
      if (lowLightActive()) {
        const b = boostFrame(bitmap);
        det = b.src; gain = b.gain;
      }
      let landmarks = [];
      if (landmarker) {
        try {
          const res = landmarker.detectForVideo(det, t);
          landmarks = res?.landmarks ?? [];
        } catch { /* timestamp regression / transient — drop this frame */ }
      }
      // Hands ride the same bitmap on a slower cadence. Omitted from the
      // message on ticks where they didn't run — main keeps its last result.
      let hands;
      if (handLandmarker && ++handTick >= HANDS_EVERY_N) {
        handTick = 0;
        try {
          const res = handLandmarker.detectForVideo(det, t);
          hands = { landmarks: res?.landmarks ?? [], handedness: res?.handedness ?? [] };
        } catch { /* transient — skip this tick */ }
      }
      try { bitmap.close?.(); } catch {}
      if (det !== bitmap) { try { det.close?.(); } catch {} }
      const out = { type: 'result', landmarks, t, source };
      if (gain !== undefined) out.gain = gain;
      if (hands) out.hands = hands;
      self.postMessage(out);
      return;
    }
    if (msg.type === 'close') {
      try { landmarker?.close(); } catch {}
      landmarker = null;
      try { handLandmarker?.close(); } catch {}
      handLandmarker = null;
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err?.message || err) });
  }
};
