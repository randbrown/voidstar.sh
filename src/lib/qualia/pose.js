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
import { loadVision } from './vision-loader.js';
import { createDogDetector } from './dog.js';

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
    kind: 'human',
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

  // Dog detection — runs alongside human pose against the same source. We
  // own a separate smoothing array (smoothedDogs) so a human entering /
  // leaving doesn't perturb dog landmark indices, and a separate throttle
  // (ObjectDetector inference is heavier than PoseLandmarker on some GPUs,
  // and bboxes don't need 30fps to read smoothly). dogPersons is the most
  // recent shaped output, kept around so frame.people can be rebuilt at
  // human-detection cadence without re-synthesizing.
  const dogDetector = createDogDetector();
  let dogPersons = []; // shaped {kind:'dog', ...} objects, smoothed in place
  let dogDetectIntervalMs = 100;
  let lastDogTickMs = 0;

  let detectLoopStarted = false;
  let detectSource = null; // 'camera' | 'canvas' | null
  // Tracked so flipFacing() can re-issue getUserMedia with the opposite
  // direction; also exposed so the topbar / camera card can label which
  // way the lens is currently pointing.
  let facingMode = 'user';   // 'user' | 'environment'
  let activeDeviceId = null;
  let activeTrack = null;    // primary MediaStreamTrack (for zoom etc.)
  let detectCanvas = null; // for source === 'canvas' (viz mode)

  async function ensureVision() {
    if (vision) return vision;
    const { mod, fileset } = await loadVision();
    PoseLandmarkerCls = mod.PoseLandmarker;
    vision = fileset;
    return vision;
  }

  async function buildLandmarker() {
    if (!vision) await ensureVision();
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
    const humans = smoothed.map(shapePerson);
    // Concatenate dogs after humans. Dog objects are already shaped (and
    // smoothed via per-landmark EMA on each detect tick), so this is a
    // cheap reference splice — no per-frame re-synthesis.
    frame.people = dogPersons.length ? humans.concat(dogPersons) : humans;
    frame.timestamp = timestamp;
  }

  // Adaptive low-pass on a previously-shaped dog Person, matching the human
  // smoother's shape (minA/maxA bounds + speed-driven alpha). We mutate the
  // prior object in place so identity (and therefore heading state) carries
  // forward across detect ticks.
  function smoothDogTo(prev, fresh) {
    const k = smoothing;
    const minA = Math.pow(1 - k, 1.8) * 0.97 + 0.03;
    const maxA = Math.pow(1 - k, 0.3) * 0.75 + 0.25;
    const blendLm = (dst, src) => {
      const dx = src.x - dst.x, dy = src.y - dst.y;
      const speed = Math.sqrt(dx * dx + dy * dy);
      let alpha = minA + speed * SMOOTH_SLOPE;
      if (alpha > maxA) alpha = maxA;
      dst.x += (src.x - dst.x) * alpha;
      dst.y += (src.y - dst.y) * alpha;
      dst.z = src.z;
      dst.visibility = src.visibility;
    };
    blendLm(prev.head,  fresh.head);
    blendLm(prev.neck,  fresh.neck);
    blendLm(prev.snout, fresh.snout);
    blendLm(prev.hips.l, fresh.hips.l);
    blendLm(prev.hips.r, fresh.hips.r);
    blendLm(prev.paws.fl, fresh.paws.fl);
    blendLm(prev.paws.fr, fresh.paws.fr);
    blendLm(prev.paws.bl, fresh.paws.bl);
    blendLm(prev.paws.br, fresh.paws.br);
    blendLm(prev.tail,  fresh.tail);
    // bbox slides with the new detection (no smoothing — already stable
    // enough at 10fps detect, and downstream fx may want crisp edges).
    prev.bbox = fresh.bbox;
    prev.heading = fresh.heading;
    prev.confidence = fresh.confidence;
  }

  async function startCamera({ deviceId, video, facing } = {}) {
    await ensureVision();
    if (!landmarker) await buildLandmarker();

    videoEl = video;
    // facing wins over deviceId when both are provided (used by flipFacing
    // — we want the opposite-direction lens regardless of any persisted
    // deviceId). Most callers pass one or the other.
    const wantFacing = facing || facingMode;
    // Try the requested constraint first, then fall back to looser ones if the
    // browser reports NotReadableError (camera busy / driver hiccup) or
    // OverconstrainedError (front cam can't satisfy the ideal resolution).
    let attempts;
    if (facing) {
      attempts = [
        { width: { ideal: 1920 }, facingMode: { ideal: facing } },
        { facingMode: { ideal: facing } },
        true,
      ];
    } else if (deviceId) {
      attempts = [{ deviceId: { exact: deviceId } }, { facingMode: wantFacing }, true];
    } else {
      attempts = [{ width: { ideal: 1920 }, facingMode: wantFacing }, { facingMode: wantFacing }, true];
    }
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
    if (!stream) {
      console.error('[qualia] getUserMedia failed for all attempts:', lastErr);
      throw lastErr;
    }
    videoEl.srcObject = stream;
    // Reveal the preview BEFORE awaiting metadata. Android Chrome won't
    // fire `loadedmetadata` (or start the underlying decode) while the
    // element is display:none. We add the class first so layout has a
    // visible box for the decoder to attach to.
    videoEl.classList.add('visible');
    // Kick off play() but don't await it — on some Android builds play()
    // only resolves after metadata, while metadata in turn waits for
    // play() to be called, deadlocking unless we let both run loose.
    videoEl.play().catch(() => {});
    // Best-effort wait for metadata. We DON'T throw on timeout anymore:
    // getUserMedia already confirmed the stream is alive, so a slow
    // metadata event just means frames haven't been decoded yet. The
    // detect loop gates on readyState, so it'll pick up automatically
    // once the element catches up. Throwing here used to surface an
    // error dialog on devices where the lens just needed a couple
    // extra seconds to warm up — much worse UX than just rendering an
    // empty preview that fills in a beat later.
    if (videoEl.readyState < 1) {
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; cleanup(); resolve(); };
        const onReady = () => finish();
        // Listen for several events — different browsers reach
        // HAVE_METADATA via different signals, especially on mobile
        // where loadeddata sometimes arrives before loadedmetadata.
        const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing'];
        events.forEach(e => videoEl.addEventListener(e, onReady, { once: true }));
        // Poll readyState as a fallback: some Android builds drop the
        // events when the element transitions display:none → block
        // while data is arriving, but readyState updates correctly.
        const poll = setInterval(() => { if (videoEl.readyState >= 1) finish(); }, 120);
        const timer = setTimeout(() => {
          if (videoEl.readyState < 1) {
            console.warn('[qualia] camera metadata still pending after 8s — preview will fill in once frames arrive');
          }
          finish();
        }, 8000);
        function cleanup() {
          events.forEach(e => videoEl.removeEventListener(e, onReady));
          clearInterval(poll);
          clearTimeout(timer);
        }
      });
    }
    detectSource = 'camera';
    if (!detectLoopStarted) startDetectLoop();
    activeTrack = stream.getVideoTracks()[0] || null;
    const settings = activeTrack?.getSettings?.() || {};
    activeDeviceId = settings.deviceId || null;
    if (settings.facingMode === 'user' || settings.facingMode === 'environment') {
      facingMode = settings.facingMode;
    } else if (facing) {
      facingMode = facing;
    }
    return activeDeviceId;
  }

  /** Toggle between user/environment facing. Phones with front+back lenses
   *  switch via the facingMode constraint; desktops with multiple USB
   *  webcams (or any setup where facingMode doesn't differentiate) fall
   *  through to a deviceId cycle so the gesture still feels like "next
   *  camera". Order:
   *    1. try opposite facingMode (works on Android/iPad)
   *    2. if that returned the same deviceId, cycle to next videoinput
   *    3. if that fails too, surface the original error.
   */
  async function flipFacing() {
    const prevDeviceId = activeDeviceId;
    const next = facingMode === 'user' ? 'environment' : 'user';
    stopCamera();
    let resolved = null;
    try {
      resolved = await startCamera({ video: videoEl, facing: next });
    } catch {
      // Fall through to deviceId cycle below.
    }
    // facingMode flip succeeded AND actually switched cameras — done.
    if (resolved && resolved !== prevDeviceId) return resolved;
    // facingMode flip yielded the same lens (or failed): cycle deviceIds.
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter(d => d.kind === 'videoinput');
      if (cams.length >= 2 && prevDeviceId) {
        const i = cams.findIndex(c => c.deviceId === prevDeviceId);
        const nextCam = cams[(i + 1) % cams.length];
        if (nextCam && nextCam.deviceId !== prevDeviceId) {
          stopCamera();
          return await startCamera({ video: videoEl, deviceId: nextCam.deviceId });
        }
      }
    } catch {}
    // Fallback to whatever we managed to open (may be the original camera).
    if (resolved) return resolved;
    // Last resort: re-open the previous camera so the user isn't left
    // staring at a black preview.
    if (prevDeviceId) {
      try { return await startCamera({ video: videoEl, deviceId: prevDeviceId }); } catch {}
    }
    return null;
  }

  /** Read zoom capability + current value off the active track. Returns
   *  null when no track is open or the track exposes no zoom capability
   *  (iOS Safari, USB webcams without zoom support, etc.). */
  function getZoomCaps() {
    if (!activeTrack) return null;
    const caps = activeTrack.getCapabilities?.();
    if (!caps || typeof caps.zoom !== 'object') return null;
    const settings = activeTrack.getSettings?.() || {};
    return {
      min:  caps.zoom.min  ?? 1,
      max:  caps.zoom.max  ?? 1,
      step: caps.zoom.step ?? 0.1,
      value: typeof settings.zoom === 'number' ? settings.zoom : (caps.zoom.min ?? 1),
    };
  }

  /** Apply a zoom value via track constraints. Caller is expected to clamp
   *  to caps; we re-clamp anyway in case caps changed mid-session. */
  async function setZoom(value) {
    if (!activeTrack) return false;
    const caps = activeTrack.getCapabilities?.();
    if (!caps || typeof caps.zoom !== 'object') return false;
    const v = Math.max(caps.zoom.min ?? 1, Math.min(caps.zoom.max ?? 1, value));
    try {
      await activeTrack.applyConstraints({ advanced: [{ zoom: v }] });
      return true;
    } catch {
      return false;
    }
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.classList.remove('visible');
    }
    activeTrack = null;
    activeDeviceId = null;
    if (detectSource === 'camera') {
      detectSource = null;
      smoothed = [];
      dogPersons = [];
      frame.people = [];
    }
  }

  /** Start running PoseLandmarker against an arbitrary canvas (for "viz" mode). */
  async function startCanvasDetection(canvas) {
    await ensureVision();
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
      dogPersons = [];
      frame.people = [];
    }
  }

  /** Resolve the active detect source and validate it's ready. Returns
   *  {source, sourceW, sourceH} or null when nothing is detectable yet. */
  function activeSource() {
    if (detectSource === 'camera' && videoEl
        && videoEl.readyState >= 2 && !videoEl.paused && !videoEl.ended) {
      return { source: videoEl, sourceW: videoEl.videoWidth || 1, sourceH: videoEl.videoHeight || 1 };
    }
    if (detectSource === 'canvas' && detectCanvas) {
      return { source: detectCanvas, sourceW: detectCanvas.width || 1, sourceH: detectCanvas.height || 1 };
    }
    return null;
  }

  /** Re-shape a fresh list of dog detections into smoothed dogPersons. */
  function ingestDogs(rawDetections, sourceW, sourceH) {
    if (!rawDetections) return; // null = detector not ready yet; skip silently
    const matched = dogDetector.matchToPrev(rawDetections, dogPersons, sourceW, sourceH);
    const next = [];
    for (const m of matched) {
      const fresh = dogDetector.shapeDog(m);
      if (m.prior) {
        smoothDogTo(m.prior, fresh);
        next.push(m.prior);
      } else {
        next.push(fresh);
      }
    }
    dogPersons = next;
  }

  function startDetectLoop() {
    detectLoopStarted = true;
    // Build the dog detector lazily on first loop tick after a source is
    // available. We don't gate on its readiness — humans detect immediately
    // either way, and detectSync returns null until the detector is up.
    let dogEnsureStarted = false;
    (function detectLoop() {
      requestAnimationFrame(detectLoop);
      if (!landmarker) return;
      const tickT = performance.now();
      const src = activeSource();
      if (!src) return;
      const { source, sourceW, sourceH } = src;

      // Kick the dog detector build the first time we have a live source.
      // Idempotent thereafter — ensureDetector short-circuits when ready.
      if (!dogEnsureStarted) {
        dogEnsureStarted = true;
        dogDetector.ensureDetector().catch(() => { /* fall through; dog detection stays no-op */ });
      } else if (!dogDetector.isReady()) {
        // Score-threshold or maxDogs changed — rebuild in background.
        dogDetector.ensureDetector().catch(() => {});
      }

      // Human pose — gated by detectIntervalMs (default ~30fps).
      let humanRan = false;
      if (tickT - lastDetectTickMs >= detectIntervalMs) {
        lastDetectTickMs = tickT;
        try {
          const t = performance.now();
          const result = landmarker.detectForVideo(source, t);
          const fresh = result.landmarks ?? [];
          if (detectSource === 'camera') {
            smoothLandmarks(fresh);
            if (fresh.length > 0) lastDetectMs = t;
            humanRan = true;
          } else if (detectSource === 'canvas') {
            if (fresh.length > 0) {
              smoothLandmarks(fresh);
              lastDetectMs = t;
              humanRan = true;
            } else if (lingerMs > 0 && t - lastDetectMs > lingerMs) {
              smoothed = [];
              humanRan = true;
            }
          }
        } catch { /* swallow timestamp regressions */ }
      }

      // Dog detection — gated independently. Skip entirely when the user
      // has zeroed out maxDogs (no need to spin inference).
      let dogRan = false;
      if (dogDetector.getMaxDogs() > 0 && tickT - lastDogTickMs >= dogDetectIntervalMs) {
        lastDogTickMs = tickT;
        try {
          const t = performance.now();
          const dogs = dogDetector.detectSync(source, t);
          if (dogs !== null) {
            ingestDogs(dogs, sourceW, sourceH);
            dogRan = true;
          }
        } catch { /* swallow timestamp regressions */ }
      } else if (dogDetector.getMaxDogs() === 0 && dogPersons.length) {
        dogPersons = [];
        dogRan = true;
      }

      if (humanRan || dogRan) rebuildPeople(performance.now());
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

  // Dog detection knobs — independent from the human pose ones above.
  function setNumDogs(n)      { dogDetector.setMaxDogs(n); }
  function getNumDogs()       { return dogDetector.getMaxDogs(); }
  function setDogMinScore(v)  { dogDetector.setMinScore(v); }
  function getDogMinScore()   { return dogDetector.getMinScore(); }
  function setDogDetectFps(fps) {
    const f = Math.max(2, Math.min(30, fps | 0));
    dogDetectIntervalMs = Math.round(1000 / f);
  }
  function getDogDetectFps() { return Math.round(1000 / dogDetectIntervalMs); }

  return {
    frame,
    startCamera,
    stopCamera,
    flipFacing,
    getFacingMode: () => facingMode,
    getZoomCaps,
    setZoom,
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
    setNumDogs,
    getNumDogs,
    setDogMinScore,
    getDogMinScore,
    setDogDetectFps,
    getDogDetectFps,
  };
}
