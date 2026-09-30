// Hand inference worker — MediaPipe HandLandmarker on its own thread, fed by
// pose.js whenever a hands consumer is armed (horns 🤘, a `wantsHands` quale
// like null_portal, the fingers overlay).
//
// Why a worker of its own (hands used to piggyback on pose-worker.js every 2nd
// pose tick): hands need a fresh result EVERY tick to follow a moving hand, and
// the pose-guided crops below cost 1–3 inferences per tick. On the pose worker
// that halved the pose rate; here it runs in parallel on another core, and a
// slow hands tick only thins hands (own backpressure), never pose.
//
// Why pose-guided crops: the palm detector sees the WHOLE frame squeezed to
// 192², so a performer's hand at stage distance is a few pixels — and in the
// dark, no pixels at all. The body model finds wrists far more reliably, so for
// each body side the whole-frame tracker isn't already holding, we crop a
// square around that wrist (extended along the forearm, sized from forearm
// length), upscale it to 256², and run a per-side landmarker on it (MediaPipe
// Holistic's hand-ROI-from-pose idea). Measured on moving, darkened test
// scenes: a full-body performer's hands went from ~4% (lit) / 0% (dark) of
// frames correct to ~96% / ~42%; close-up hands were unchanged.
//
// Frames arrive RAW — the pose low-light boost is deliberately NOT applied:
// on dark frames the linear lift took hand detection to ~0% (it amplifies
// noise and flattens the finger edges the palm detector keys on).
//
// Protocol (main ⇄ worker):
//   → { type:'init' }                                build the landmarkers
//   ← { type:'ready' } | { type:'error', error }
//   → { type:'detect', bitmap, t, arms }             arms: [{wx,wy,ex,ey,vis}|null ×2]
//                                                    (normalized body wrists/elbows, L then R)
//   ← { type:'result', t, landmarks, handedness }    landmarks in frame-normalized coords
//   → { type:'close' }

// Pinned — keep VISION_VERSION in sync with vision-loader.js / pose-worker.js.
const VISION_VERSION = '0.10.35';
const VISION_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;
const VISION_WASM   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
// Pinned like the pose models — a live set must not change gesture behavior
// because the CDN reissued the model.
const HAND_MODEL    = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// 0.5 is MediaPipe's default; 0.3 kept ~20% more dark close-up frames with no
// extra false hands in testing (null_portal/horns gate geometry downstream).
const HAND_CONF   = 0.3;
const CROP_PX     = 256;   // crop canvas side (model input is 224²)
const CROP_FOREARM = 2.4;  // crop side, in forearm lengths (margin for a one-tick-stale wrist)
const CROP_PUSH   = 0.4;  // crop centre = wrist + PUSH × (wrist − elbow)
const CROP_MIN    = 0.06;  // crop side floor, fraction of the frame's long side
const CROP_VIS    = 0.1;   // body wrist visibility needed to try a crop

let HandLandmarkerCls = null;
let fileset = null;
let whole = null;          // whole-frame tracker (numHands 2)
let sides = [null, null];  // per-side crop landmarkers (numHands 1), L then R
let cropHeld = [false, false];
let cropCanvas = null, cropCtx = null;

async function ensureVision() {
  if (fileset) return;
  const mod = await import(/* @vite-ignore */ VISION_BUNDLE);
  HandLandmarkerCls = mod.HandLandmarker;
  fileset = await mod.FilesetResolver.forVisionTasks(VISION_WASM);
}

// CPU delegate first, like pose — the GPU is busy with shaders + Hydra.
async function makeLandmarker(numHands) {
  const common = {
    runningMode: 'VIDEO', numHands,
    minHandDetectionConfidence: HAND_CONF,
    minHandPresenceConfidence:  HAND_CONF,
    minTrackingConfidence:      HAND_CONF,
  };
  try {
    return await HandLandmarkerCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'CPU' },
    });
  } catch {
    return await HandLandmarkerCls.createFromOptions(fileset, {
      ...common, baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
    });
  }
}

function closeAll() {
  for (const lm of [whole, ...sides]) { try { lm?.close(); } catch {} }
  whole = null; sides = [null, null]; cropHeld = [false, false];
}

function detect(bitmap, t, arms) {
  const W = bitmap.width, H = bitmap.height;
  const landmarks = [], handedness = [];
  // Whole-frame tracker — skipped only while BOTH sides are crop-tracked (it
  // would just re-find the same hands at lower resolution).
  let wholeLms = [];
  if (whole && !(cropHeld[0] && cropHeld[1])) {
    try {
      const r = whole.detectForVideo(bitmap, t);
      wholeLms = r?.landmarks ?? [];
      for (let i = 0; i < wholeLms.length; i++) { landmarks.push(wholeLms[i]); handedness.push(r.handedness?.[i] ?? []); }
    } catch { /* timestamp regression / transient */ }
  }
  for (let s = 0; s < 2; s++) {
    cropHeld[s] = false;
    const a = arms?.[s];
    if (!a || !sides[s] || !(a.vis >= CROP_VIS)) continue;
    const wx = a.wx * W, wy = a.wy * H, ex = a.ex * W, ey = a.ey * H;
    const fa = Math.hypot(wx - ex, wy - ey);
    // Already held by the whole-frame tracker near this wrist → no crop.
    const near = Math.max(fa * 0.7, 0.03 * W);
    if (wholeLms.some(h => Math.hypot(h[0].x * W - wx, h[0].y * H - wy) < near)) continue;
    const sd = Math.max(CROP_FOREARM * fa, CROP_MIN * Math.max(W, H));
    const sx0 = wx + (wx - ex) * CROP_PUSH - sd / 2;
    const sy0 = wy + (wy - ey) * CROP_PUSH - sd / 2;
    try {
      if (!cropCanvas) {
        cropCanvas = new OffscreenCanvas(CROP_PX, CROP_PX);
        cropCtx = cropCanvas.getContext('2d');
      }
      cropCtx.fillStyle = '#000';
      cropCtx.fillRect(0, 0, CROP_PX, CROP_PX);
      cropCtx.drawImage(bitmap, sx0, sy0, sd, sd, 0, 0, CROP_PX, CROP_PX);
      const r = sides[s].detectForVideo(cropCanvas, t);
      const lm = r?.landmarks?.[0];
      if (!lm) continue;
      landmarks.push(lm.map(p => ({ ...p, x: (sx0 + p.x * sd) / W, y: (sy0 + p.y * sd) / H })));
      handedness.push(r.handedness?.[0] ?? []);
      cropHeld[s] = true;
    } catch { /* transient — skip this side this tick */ }
  }
  return { landmarks, handedness };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;
  try {
    if (msg.type === 'init') {
      await ensureVision();
      closeAll();
      whole = await makeLandmarker(2);
      sides = [await makeLandmarker(1), await makeLandmarker(1)];
      self.postMessage({ type: 'ready' });
      return;
    }
    if (msg.type === 'detect') {
      const { bitmap, t, arms } = msg;
      let out = { landmarks: [], handedness: [] };
      if (whole) out = detect(bitmap, t, arms);
      try { bitmap.close?.(); } catch {}
      self.postMessage({ type: 'result', t, ...out });
      return;
    }
    if (msg.type === 'close') { closeAll(); return; }
  } catch (err) {
    try { msg.bitmap?.close?.(); } catch {}
    self.postMessage({ type: 'error', error: String(err?.message || err) });
  }
};
