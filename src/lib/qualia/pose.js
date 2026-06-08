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
  // overkill for whole-body landmarks. Default 67ms ≈ 15fps detection —
  // higher rates tend to read as jittery (raw landmark noise updates faster
  // than smoothing can settle it), so 15fps is the calmer default. Smoothing
  // adapts to the slower update rate; the UI slider can raise it if wanted.
  let detectIntervalMs = 67;
  let lastDetectTickMs = 0;

  let detectLoopStarted = false;
  let detectSource = null; // 'camera' | 'canvas' | null
  // Tracked so flipFacing() can re-issue getUserMedia with the opposite
  // direction; also exposed so the topbar / camera card can label which
  // way the lens is currently pointing.
  let facingMode = 'user';   // 'user' | 'environment'
  let activeDeviceId = null;
  let activeTrack = null;    // primary MediaStreamTrack (for zoom etc.)
  let detectCanvas = null; // for source === 'canvas' (viz mode)

  // ── Inference worker ─────────────────────────────────────────────────────
  // Runs detectForVideo() off the main thread (see pose-worker.js). The main
  // thread grabs a frame as an ImageBitmap, transfers it to the worker, and
  // receives the raw landmark arrays back — smoothing / linger / reshaping
  // stay here (cheap). Falls back to synchronous main-thread inference if the
  // worker can't be created or fails to load. Disable manually (e.g. while
  // debugging) with: localStorage['voidstar.pose.noWorker']='1'.
  let worker      = null;
  let useWorker   = false;   // a worker was successfully created
  let workerReady = false;   // worker's landmarker is built
  let workerBusy  = false;   // a frame is in flight (backpressure)
  let workerSentAt = 0;      // watchdog timestamp
  let _workerFailed = false; // don't recreate after a failure
  function workerDisabled() {
    try { return localStorage.getItem('voidstar.pose.noWorker') === '1'; } catch { return false; }
  }
  function ensureWorker() {
    if (_workerFailed || workerDisabled()) return false;
    if (worker) return useWorker;
    try {
      // CLASSIC worker (not type:'module'). MediaPipe's FilesetResolver loads
      // its WASM glue via importScripts(), which only exists in classic
      // workers — a module worker fails with "ModuleFactory not set". Dynamic
      // import() (used in pose-worker.js to pull the Tasks-Vision ESM) still
      // works inside a classic worker on Chrome.
      worker = new Worker(new URL('./pose-worker.js', import.meta.url));
      worker.addEventListener('message', onWorkerMessage);
      worker.addEventListener('error', (err) => {
        console.warn('[qualia] pose worker error — falling back to main thread:', err?.message || err);
        disableWorker();
      });
      useWorker = true;
      console.log('[qualia] pose: inference running in a worker (off main thread)');
    } catch (err) {
      console.warn('[qualia] pose worker unavailable — using main-thread inference:', err);
      worker = null; useWorker = false; _workerFailed = true;
    }
    return useWorker;
  }
  function workerConfig() {
    return { numPoses, detectConf, presenceConf, trackConf };
  }
  function hasLandmarker() { return useWorker ? workerReady : !!landmarker; }
  function onWorkerMessage(e) {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'ready') { workerReady = true; return; }
    if (msg.type === 'error') {
      console.warn('[qualia] pose worker reported error — falling back:', msg.error);
      disableWorker();
      return;
    }
    if (msg.type === 'result') {
      workerBusy = false;
      // Drop stale results whose source no longer matches (camera stopped or
      // switched to canvas mid-flight) so a ghost pose can't reappear.
      if (!detectSource || detectSource !== msg.source) return;
      const t = msg.t;
      const fresh = msg.landmarks ?? [];
      if (msg.source === 'camera') {
        smoothLandmarks(fresh);
        if (fresh.length > 0) lastDetectMs = t;
        rebuildPeople(t);
      } else { // 'canvas'
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
    }
  }
  function disableWorker() {
    _workerFailed = true;
    useWorker = false; workerReady = false; workerBusy = false;
    try { worker?.terminate(); } catch {}
    worker = null;
    // Ensure a main-thread landmarker exists for the fallback path.
    if (!landmarker) buildLandmarker().catch(err => console.warn('[qualia] fallback landmarker build failed:', err));
  }

  async function ensureVision() {
    if (vision) return vision;
    const { mod, fileset } = await loadVision();
    PoseLandmarkerCls = mod.PoseLandmarker;
    vision = fileset;
    return vision;
  }

  async function buildLandmarker() {
    // Worker path: (re)configure the off-thread landmarker, resolve on 'ready'.
    if (ensureWorker()) {
      workerReady = false;
      await new Promise((resolve) => {
        const onReady = (e) => {
          const ty = e.data?.type;
          if (ty === 'ready' || ty === 'error') {
            worker?.removeEventListener('message', onReady);
            resolve();
          }
        };
        worker.addEventListener('message', onReady);
        worker.postMessage({ type: 'init', opts: workerConfig() });
      });
      return;
    }
    // Main-thread fallback.
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
    frame.people = smoothed.map(shapePerson);
    frame.timestamp = timestamp;
  }

  async function startCamera({ deviceId, video, facing } = {}) {
    if (!hasLandmarker()) await buildLandmarker();

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
      frame.people = [];
    }
  }

  /** Start running PoseLandmarker against an arbitrary canvas (for "viz" mode). */
  async function startCanvasDetection(canvas) {
    if (!hasLandmarker()) await buildLandmarker();
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

  // Pick the live detection source (or null if not ready). Shared by both
  // the worker and main-thread paths.
  function currentDetectSource() {
    if (detectSource === 'camera' && videoEl
        && videoEl.readyState >= 2 && !videoEl.paused && !videoEl.ended) {
      return videoEl;
    }
    if (detectSource === 'canvas' && detectCanvas) return detectCanvas;
    return null;
  }

  // Worker path: snapshot the frame as an ImageBitmap and transfer it. The
  // expensive inference happens in the worker; the result comes back via
  // onWorkerMessage. Backpressure: only one frame in flight at a time so we
  // never queue work the worker can't keep up with.
  function detectViaWorker() {
    if (workerBusy) {
      // Watchdog — if a result never came back (worker stalled), unstick.
      if (performance.now() - workerSentAt > 2000) workerBusy = false;
      else return;
    }
    const source = currentDetectSource();
    if (!source) return;
    const src = detectSource;
    const t = performance.now();
    workerBusy = true;
    workerSentAt = t;
    createImageBitmap(source).then((bitmap) => {
      if (!worker || !useWorker) { try { bitmap.close?.(); } catch {} workerBusy = false; return; }
      worker.postMessage({ type: 'detect', bitmap, t, source: src }, [bitmap]);
    }).catch(() => { workerBusy = false; });
  }

  // Main-thread fallback: synchronous detectForVideo (blocks until the
  // forward pass finishes — the path we move OFF the main thread above).
  function detectMainThread() {
    const source = currentDetectSource();
    if (!source) return;
    const t = performance.now();
    try {
      const result = landmarker.detectForVideo(source, t);
      const fresh = result.landmarks ?? [];
      if (detectSource === 'camera') {
        smoothLandmarks(fresh);
        if (fresh.length > 0) lastDetectMs = t;
        rebuildPeople(t);
      } else {
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
  }

  function startDetectLoop() {
    detectLoopStarted = true;
    (function detectLoop() {
      requestAnimationFrame(detectLoop);
      if (!hasLandmarker()) return;
      // Throttle gate — cheap to spin the rAF, expensive to call
      // detectForVideo. Skip ticks that come faster than the interval.
      const tickT = performance.now();
      if (tickT - lastDetectTickMs < detectIntervalMs) return;
      lastDetectTickMs = tickT;
      if (useWorker) detectViaWorker();
      else           detectMainThread();
    })();
  }

  // Setters that require a model rebuild (confidence + numPoses are baked in).
  async function setNumPoses(n) {
    if (n === numPoses) return;
    numPoses = Math.max(1, Math.min(6, n | 0));
    if (hasLandmarker()) await buildLandmarker();
  }
  async function setThresholds({ detect, presence, track }) {
    let dirty = false;
    if (detect   != null && detect   !== detectConf)   { detectConf   = detect;   dirty = true; }
    if (presence != null && presence !== presenceConf) { presenceConf = presence; dirty = true; }
    if (track    != null && track    !== trackConf)    { trackConf    = track;    dirty = true; }
    if (dirty && hasLandmarker()) await buildLandmarker();
  }

  function setSmoothing(v) { smoothing = Math.max(0, Math.min(1, v)); }
  function setLingerMs(v)  { lingerMs = Math.max(0, v | 0); }
  /** Cap the inference rate. fps in [1..60]. Lower = less CPU/GPU duty (and a
   *  deliberate slow-tracking aesthetic). Floor is 1fps; at very low rates a
   *  pose can vanish between detections if lingerMs is shorter than the gap. */
  function setDetectFps(fps) {
    const f = Math.max(1, Math.min(60, fps | 0));
    detectIntervalMs = Math.round(1000 / f);
  }
  function getDetectFps() { return Math.round(1000 / detectIntervalMs); }

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
  };
}
