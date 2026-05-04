// Pose pipeline: MediaPipe PoseLandmarker → normalized PoseFrame.
//
// The wrapper does three things on top of the raw MediaPipe output:
//   1. Adaptive low-pass smoothing (lifted from spectrum-pose:835–859) — heavy
//      smoothing at rest, light while moving. Per-instance state.
//   2. Reshapes the 33-element landmark array into a named-joint object so fx
//      code reads `person.head` / `person.wrists.l` instead of indexing magic
//      numbers. The raw array is preserved for any fx that needs it.
//   3. Owns the per-frame video element + detect loop so the page just toggles
//      `start({ source: 'camera', deviceId })` / `stop()`.

import { emptyPoseFrame } from './field.js';

const POSE_BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs';
const POSE_WASM   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm';
const POSE_MODEL  = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

// MediaPipe landmark indices we care about. The full list is in MP docs;
// these are the ones the named PoseFrame exposes.
const LM = {
  HEAD: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW:    13, R_ELBOW:    14,
  L_WRIST:    15, R_WRIST:    16,
  L_HIP:      23, R_HIP:      24,
  L_KNEE:     25, R_KNEE:     26,
  L_ANKLE:    27, R_ANKLE:    28,
};

const SMOOTH_SLOPE = 22;

function emptyLandmark() { return { x: 0.5, y: 0.5, z: 0, visibility: 0 }; }

function midpoint(a, b) {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
    z: (a.z + b.z) * 0.5,
    visibility: Math.min(a.visibility, b.visibility),
  };
}

/** Reshape a single MediaPipe 33-element landmark array into a Person. */
function shapePerson(raw) {
  const lm = i => raw[i] || emptyLandmark();
  const sL = lm(LM.L_SHOULDER), sR = lm(LM.R_SHOULDER);
  const named = {
    head: lm(LM.HEAD),
    neck: midpoint(sL, sR),
    shoulders: { l: sL, r: sR },
    elbows:    { l: lm(LM.L_ELBOW),    r: lm(LM.R_ELBOW) },
    wrists:    { l: lm(LM.L_WRIST),    r: lm(LM.R_WRIST) },
    hips:      { l: lm(LM.L_HIP),      r: lm(LM.R_HIP) },
    knees:     { l: lm(LM.L_KNEE),     r: lm(LM.R_KNEE) },
    ankles:    { l: lm(LM.L_ANKLE),    r: lm(LM.R_ANKLE) },
    raw,
    confidence: 0,
  };
  // Mean visibility over named joints.
  const ks = [
    named.head, named.shoulders.l, named.shoulders.r,
    named.elbows.l, named.elbows.r, named.wrists.l, named.wrists.r,
    named.hips.l, named.hips.r,
  ];
  let sum = 0;
  for (const k of ks) sum += k.visibility || 0;
  named.confidence = sum / ks.length;
  return named;
}

export function createPose() {
  const frame = emptyPoseFrame();

  /** @type {HTMLVideoElement|null} */ let videoEl = null;
  let stream = null;
  let landmarker = null;
  let vision = null;
  let PoseLandmarkerCls = null;

  // Smoothed raw landmark arrays (one per detected person), in the same
  // shape MediaPipe returns. We mutate these in place so smoothing carries
  // across frames; `frame.people` is rebuilt from them every detect.
  let smoothed = [];

  let smoothing = 0.5;
  let numPoses  = 3;
  // Confidence thresholds — baked into the landmarker at create time.
  let detectConf = 0.05, presenceConf = 0.05, trackConf = 0.05;
  // How long a vanished pose lingers (ms)
  let lingerMs = 800;
  let lastDetectMs = 0;
  // Detection throttle. detectForVideo() is a sync call that blocks the
  // main thread waiting for inference; running it every rAF (60fps) is
  // overkill for whole-body landmarks. Default 33ms ≈ 30fps detection,
  // which roughly halves the duty cycle. Smoothing in pose.js adapts to
  // the slower update rate without visible jitter.
  let detectIntervalMs = 33;
  let lastDetectTickMs = 0;

  let detectLoopStarted = false;
  let detectSource = null; // 'camera' | 'canvas' | null
  let detectCanvas = null; // for source === 'canvas' (viz mode)

  async function loadVision() {
    if (vision) return vision;
    const mod = await import(/* @vite-ignore */ POSE_BUNDLE);
    PoseLandmarkerCls = mod.PoseLandmarker;
    vision = await mod.FilesetResolver.forVisionTasks(POSE_WASM);
    return vision;
  }

  async function buildLandmarker() {
    if (!vision) await loadVision();
    if (landmarker) { try { landmarker.close(); } catch {} landmarker = null; }
    landmarker = await PoseLandmarkerCls.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses,
      minPoseDetectionConfidence: detectConf,
      minPosePresenceConfidence:  presenceConf,
      minTrackingConfidence:      trackConf,
    });
  }

  function smoothLandmarks(fresh) {
    if (fresh.length !== smoothed.length) {
      smoothed = fresh.map(lms => lms.map(lm => ({ ...lm })));
      return;
    }
    const k = smoothing;
    const minA = Math.pow(1 - k, 1.8) * 0.97 + 0.03;
    const maxA = Math.pow(1 - k, 0.3) * 0.75 + 0.25;
    for (let p = 0; p < fresh.length; p++) {
      const src = fresh[p], dst = smoothed[p];
      if (dst.length !== src.length) { smoothed[p] = src.map(lm => ({ ...lm })); continue; }
      for (let i = 0; i < src.length; i++) {
        const a = src[i], b = dst[i];
        const dx = a.x - b.x, dy = a.y - b.y;
        const speed = Math.sqrt(dx * dx + dy * dy);
        let alpha = minA + speed * SMOOTH_SLOPE;
        if (alpha > maxA) alpha = maxA;
        b.x += (a.x - b.x) * alpha;
        b.y += (a.y - b.y) * alpha;
        b.z = a.z;
        b.visibility = a.visibility;
      }
    }
  }

  function rebuildPeople(timestamp) {
    frame.people = smoothed.map(shapePerson);
    frame.timestamp = timestamp;
  }

  async function startCamera({ deviceId, video }) {
    await loadVision();
    if (!landmarker) await buildLandmarker();

    videoEl = video;
    // Try the requested constraint first, then fall back to looser ones if the
    // browser reports NotReadableError (camera busy / driver hiccup) or
    // OverconstrainedError (front cam can't satisfy the ideal resolution).
    const attempts = deviceId
      ? [{ deviceId: { exact: deviceId } }, { facingMode: 'user' }, true]
      : [{ width: { ideal: 1920 }, facingMode: 'user' }, { facingMode: 'user' }, true];
    let lastErr = null;
    stream = null;
    for (const c of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: c });
        break;
      } catch (err) {
        lastErr = err;
        if (err?.name !== 'NotReadableError' && err?.name !== 'OverconstrainedError') break;
      }
    }
    if (!stream) throw lastErr;
    videoEl.srcObject = stream;
    await new Promise(r => { videoEl.onloadedmetadata = r; });
    await videoEl.play().catch(() => {});
    videoEl.classList.add('visible');
    detectSource = 'camera';
    if (!detectLoopStarted) startDetectLoop();
    return stream.getVideoTracks()[0]?.getSettings()?.deviceId || null;
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.classList.remove('visible');
    }
    if (detectSource === 'camera') {
      detectSource = null;
      smoothed = [];
      frame.people = [];
    }
  }

  /** Start running PoseLandmarker against an arbitrary canvas (for "viz" mode). */
  async function startCanvasDetection(canvas) {
    await loadVision();
    if (!landmarker) await buildLandmarker();
    detectCanvas = canvas;
    detectSource = 'canvas';
    if (!detectLoopStarted) startDetectLoop();
  }

  function stopCanvasDetection() {
    if (detectSource === 'canvas') {
      detectSource = null;
      detectCanvas = null;
      smoothed = [];
      frame.people = [];
    }
  }

  function startDetectLoop() {
    detectLoopStarted = true;
    (function detectLoop() {
      requestAnimationFrame(detectLoop);
      if (!landmarker) return;
      // Throttle gate — cheap to spin the rAF, expensive to call
      // detectForVideo. Skip ticks that come faster than the interval.
      const tickT = performance.now();
      if (tickT - lastDetectTickMs < detectIntervalMs) return;
      lastDetectTickMs = tickT;
      try {
        if (detectSource === 'camera' && videoEl
            && videoEl.readyState >= 2 && !videoEl.paused && !videoEl.ended) {
          const t = performance.now();
          const result = landmarker.detectForVideo(videoEl, t);
          smoothLandmarks(result.landmarks ?? []);
          if ((result.landmarks ?? []).length > 0) lastDetectMs = t;
          rebuildPeople(t);
        } else if (detectSource === 'canvas' && detectCanvas) {
          const t = performance.now();
          const result = landmarker.detectForVideo(detectCanvas, t);
          const fresh = result.landmarks ?? [];
          if (fresh.length > 0) {
            smoothLandmarks(fresh);
            lastDetectMs = t;
            rebuildPeople(t);
          } else if (lingerMs > 0 && t - lastDetectMs > lingerMs) {
            smoothed = [];
            frame.people = [];
            frame.timestamp = t;
          }
        }
      } catch { /* swallow timestamp regressions */ }
    })();
  }

  // Setters that require a model rebuild (confidence + numPoses are baked in).
  async function setNumPoses(n) {
    if (n === numPoses) return;
    numPoses = Math.max(1, Math.min(6, n | 0));
    if (landmarker) await buildLandmarker();
  }
  async function setThresholds({ detect, presence, track }) {
    let dirty = false;
    if (detect   != null && detect   !== detectConf)   { detectConf   = detect;   dirty = true; }
    if (presence != null && presence !== presenceConf) { presenceConf = presence; dirty = true; }
    if (track    != null && track    !== trackConf)    { trackConf    = track;    dirty = true; }
    if (dirty && landmarker) await buildLandmarker();
  }

  function setSmoothing(v) { smoothing = Math.max(0, Math.min(1, v)); }
  function setLingerMs(v)  { lingerMs = Math.max(0, v | 0); }
  /** Cap the inference rate. fps in [5..60]. Lower = less CPU/GPU duty. */
  function setDetectFps(fps) {
    const f = Math.max(5, Math.min(60, fps | 0));
    detectIntervalMs = Math.round(1000 / f);
  }
  function getDetectFps() { return Math.round(1000 / detectIntervalMs); }

  return {
    frame,
    startCamera,
    stopCamera,
    startCanvasDetection,
    stopCanvasDetection,
    setNumPoses,
    setThresholds,
    setSmoothing,
    setLingerMs,
    setDetectFps,
    getNumPoses: () => numPoses,
    getThresholds: () => ({ detect: detectConf, presence: presenceConf, track: trackConf }),
    getSmoothing:  () => smoothing,
    getLingerMs:   () => lingerMs,
    getDetectFps,
  };
}
