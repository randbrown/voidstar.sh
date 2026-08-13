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
//   ← { type:'result', landmarks, t, source[, hands] }
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
const POSE_MODEL    = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
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
let opts = { numPoses: 3, detectConf: 0.05, presenceConf: 0.05, trackConf: 0.05 };

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
  try {
    landmarker = await PoseLandmarkerCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'CPU' },
    });
  } catch (e) {
    landmarker = await PoseLandmarkerCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
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
    if (msg.type === 'detect') {
      const { bitmap, t, source } = msg;
      let landmarks = [];
      if (landmarker) {
        try {
          const res = landmarker.detectForVideo(bitmap, t);
          landmarks = res?.landmarks ?? [];
        } catch { /* timestamp regression / transient — drop this frame */ }
      }
      // Hands ride the same bitmap on a slower cadence. Omitted from the
      // message on ticks where they didn't run — main keeps its last result.
      let hands;
      if (handLandmarker && ++handTick >= HANDS_EVERY_N) {
        handTick = 0;
        try {
          const res = handLandmarker.detectForVideo(bitmap, t);
          hands = { landmarks: res?.landmarks ?? [], handedness: res?.handedness ?? [] };
        } catch { /* transient — skip this tick */ }
      }
      try { bitmap.close?.(); } catch {}
      const out = { type: 'result', landmarks, t, source };
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
