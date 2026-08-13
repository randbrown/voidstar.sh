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

// Model versions pinned ('1', not 'latest') so an upstream reissue can't
// change pose behavior between soundcheck and the set. Mirrors pose-worker.js
// (keep the two maps in sync). lite = fastest; full is markedly more robust in
// low light / low contrast for ~2-3× the inference cost (still off the main
// thread); heavy is the most accurate and much slower — pair it with a lower
// detect fps.
const POSE_MODELS = {
  lite:  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full:  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
};

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
  // Uniform scale applied to every landmark, about the FRAME centre (0.5, 0.5),
  // on the way out of the pipeline. A close camera renders the body bigger than
  // the frame — head, hands and feet land outside 0..1, so the skeleton/aura/
  // sparks draw off-screen — and moving the camera mid-set isn't an option.
  // Anchoring on the frame centre rather than the body's own centroid keeps the
  // gesture predictable: <1 always pulls the whole figure toward the middle of
  // the screen, >1 always pushes it out, and a half-cropped body (hips estimated
  // below the bottom edge) can't drag the head off the top.
  let poseScale = 1;
  // Model quality — baked into the landmarker at create time, like numPoses.
  let modelQuality = 'lite';
  // Confidence thresholds — baked into the landmarker at create time.
  let detectConf = 0.05, presenceConf = 0.05, trackConf = 0.05;
  // Low-light boost — brightens the frames the DETECTOR sees (the on-screen
  // preview and camera quale read the raw <video> and stay untouched).
  // amount 0..1 maps to a fixed gain; auto measures mean frame luma and picks
  // the gain itself. Applied in the worker (see pose-worker.js) or, on the
  // main-thread fallback, via boostFrame() below.
  let lowLightAmount = 0;
  let lowLightAuto   = false;
  let lowLightGain   = 1;   // last gain actually applied (worker-reported)
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
    return { numPoses, detectConf, presenceConf, trackConf, model: modelQuality };
  }
  function pushLowLight() {
    if (worker && useWorker) {
      worker.postMessage({ type: 'lowlight', amount: lowLightAmount, auto: lowLightAuto });
    }
  }
  function hasLandmarker() { return useWorker ? workerReady : !!landmarker; }
  // ── Hands (opt-in, worker-only) ──────────────────────────────────────────
  // Hand landmarks for the horns 🤘 gesture detector. Deliberately NOT
  // offered on the main-thread fallback path: a second synchronous
  // inference on the main thread is exactly the block the worker exists to
  // avoid, and a missing party trick beats a starved cyclist.
  let handsWanted = false;
  let _handsWarned = false;
  const handsCbs = [];
  function setHandsEnabled(on) {
    handsWanted = !!on;
    if (worker && useWorker) {
      worker.postMessage({ type: 'hands', on: handsWanted });
    } else if (handsWanted && _workerFailed && !_handsWarned) {
      // Enabling before the camera starts is the normal flow — the worker
      // doesn't exist yet and buildLandmarker restores the hands state when
      // it does. Only a FAILED worker (main-thread fallback) is worth a warn.
      _handsWarned = true;
      console.warn('[qualia] hands: needs the pose worker (main-thread fallback active) — gesture detection unavailable');
    }
    if (!handsWanted) frame.hands = null;
    return handsWanted;
  }
  /** cb(handLandmarkArrays, timestampMs) per hand-detection result. */
  function onHands(cb) { if (typeof cb === 'function') handsCbs.push(cb); }

  function onWorkerMessage(e) {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'ready') {
      workerReady = true;
      // stale = the rebuild failed but the previous landmarker survived
      // (offline gig, CDN hiccup) — pose keeps running on the old config.
      if (msg.stale) console.warn('[qualia] pose: landmarker rebuild failed — previous config kept:', msg.error);
      return;
    }
    if (msg.type === 'hands-ready') return;
    if (msg.type === 'hands-error') {
      console.warn('[qualia] hand landmarker failed — pose continues without gestures:', msg.error);
      return;
    }
    if (msg.type === 'error') {
      console.warn('[qualia] pose worker reported error — falling back:', msg.error);
      disableWorker();
      return;
    }
    if (msg.type === 'result') {
      workerBusy = false;
      if (typeof msg.gain === 'number') lowLightGain = msg.gain;
      // Drop stale results whose source no longer matches (camera stopped or
      // switched to canvas mid-flight) so a ghost pose can't reappear.
      if (!detectSource || detectSource !== msg.source) return;
      if (msg.hands && handsWanted) {
        frame.hands = { t: msg.t, landmarks: msg.hands.landmarks, handedness: msg.hands.handedness };
        for (const cb of handsCbs) {
          try { cb(msg.hands.landmarks, msg.t); } catch (err) { console.warn('[qualia] hands callback:', err); }
        }
      }
      const t = msg.t;
      const fresh = msg.landmarks ?? [];
      // Linger for BOTH sources: a single empty detection (a hand over the
      // lens, occlusion behind the steel) must not snap the skeleton/aura off
      // — hold the last pose until lingerMs elapses. The camera branch used to
      // smoothLandmarks([]) unconditionally, which reset smoothed and blanked
      // pose-driven fx on any dropped frame (against the "never snap" rule).
      applyPoseResult(fresh, t);
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
      // A fresh worker starts with hands off — restore the wanted state.
      if (handsWanted) worker?.postMessage({ type: 'hands', on: true });
      // Same for the low-light boost state.
      if (lowLightAmount > 0 || lowLightAuto) pushLowLight();
      return;
    }
    // Main-thread fallback. Create-first for the same reason as the worker
    // path: a failed rebuild mid-set (offline gig) keeps the old landmarker
    // running instead of leaving pose dead.
    if (!vision) await ensureVision();
    const next = await PoseLandmarkerCls.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODELS[modelQuality], delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses,
      minPoseDetectionConfidence: detectConf,
      minPosePresenceConfidence:  presenceConf,
      minTrackingConfidence:      trackConf,
    });
    if (landmarker) { try { landmarker.close(); } catch {} }
    landmarker = next;
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

  // Reused scaled-landmark buffers. `smoothed` can't be scaled in place — it's
  // the running smoothing state, so the factor would compound every tick — but
  // rebuildPeople runs on every detection, so the copies are written into
  // persistent objects rather than reallocating 33 landmarks per person.
  const scaledBuf = [];
  function scaleLandmarks(list) {
    if (poseScale === 1) return list;
    for (let p = 0; p < list.length; p++) {
      const src = list[p];
      const dst = scaledBuf[p] || (scaledBuf[p] = []);
      for (let i = 0; i < src.length; i++) {
        const s = src[i];
        const d = dst[i] || (dst[i] = { x: 0, y: 0, z: 0, visibility: 0 });
        d.x = 0.5 + (s.x - 0.5) * poseScale;
        d.y = 0.5 + (s.y - 0.5) * poseScale;
        d.z = s.z * poseScale;          // z is hip-relative depth — no anchor, just scale
        d.visibility = s.visibility;
      }
      if (dst.length !== src.length) dst.length = src.length;
    }
    if (scaledBuf.length !== list.length) scaledBuf.length = list.length;
    return scaledBuf;
  }

  function rebuildPeople(timestamp) {
    frame.people = scaleLandmarks(smoothed).map(shapePerson);
    frame.timestamp = timestamp;
  }

  // ── Re-detection (stuck-tracking recovery) ───────────────────────────────
  // MediaPipe's VIDEO-mode graph SKIPS its person detector while it already
  // tracks numPoses poses — re-detection only happens when a track drops
  // below the tracking threshold. With the thresholds floored for dark-stage
  // linger (0.05), a track essentially never drops, so a false lock (an amp
  // head, a jacket on a chair) pins a slot forever. Once every slot is full
  // the detector never runs again and a real body walking into frame is
  // simply ignored. redetect() forces the graph to let go: tracking state
  // lives inside the landmarker, so rebuilding it in place (fail-safe —
  // see buildLandmarker) makes the detector re-run on the next frame while
  // smoothing + linger carry the overlay through the swap.
  //
  // The watchdog fires it automatically when every slot is occupied AND at
  // least one track's confidence (mean landmark visibility — the number the
  // pose card shows) sits under `conf` for `holdMs`. Ghost locks hug the
  // floor for minutes; real bodies rarely do. While slots are NOT full the
  // detector already re-runs every frame, so the watchdog stays quiet —
  // which also means a solo dark-stage set with poses at 3 can never lose
  // the performer to a spurious rebuild.
  let autoRedetect = { on: true, conf: 0.2, holdMs: 4000, coolMs: 12000 };
  let ghostSinceMs = 0;
  let lastRedetectMs = -1e9;
  let redetecting = false;

  /** Drop every tracked pose and re-run person detection. Resolves true when
   *  the landmarker rebuilt; false when it wasn't possible (no landmarker,
   *  rebuild already in flight, or the rebuild failed and the old tracking
   *  was kept). */
  async function redetect() {
    if (redetecting || !hasLandmarker()) return false;
    redetecting = true;
    lastRedetectMs = performance.now();
    ghostSinceMs = 0;
    try {
      await buildLandmarker();
      return true;
    } catch (err) {
      console.warn('[qualia] pose re-detect failed — keeping current tracking:', err);
      return false;
    } finally {
      redetecting = false;
    }
  }

  function checkGhostLock(t) {
    if (!autoRedetect.on || redetecting) return;
    const people = frame.people;
    if (people.length < numPoses) { ghostSinceMs = 0; return; }
    let ghost = false;
    for (const p of people) {
      if (p.confidence < autoRedetect.conf) { ghost = true; break; }
    }
    if (!ghost) { ghostSinceMs = 0; return; }
    if (!ghostSinceMs) { ghostSinceMs = t; return; }
    if (t - ghostSinceMs < autoRedetect.holdMs) return;
    if (t - lastRedetectMs < autoRedetect.coolMs) return;
    console.warn('[qualia] pose: every slot full with a rock-bottom-confidence track — forcing re-detection');
    redetect();
  }

  /** Watchdog config, partial patch: {on, conf 0..1, holdMs, coolMs}. */
  function setAutoRedetect(cfg = {}) {
    if (cfg.on != null) autoRedetect.on = !!cfg.on;
    if (cfg.conf != null) {
      const c = Number(cfg.conf);
      if (Number.isFinite(c)) autoRedetect.conf = Math.max(0, Math.min(1, c));
    }
    if (cfg.holdMs != null && Number.isFinite(+cfg.holdMs)) autoRedetect.holdMs = Math.max(500,  +cfg.holdMs);
    if (cfg.coolMs != null && Number.isFinite(+cfg.coolMs)) autoRedetect.coolMs = Math.max(2000, +cfg.coolMs);
    if (!autoRedetect.on) ghostSinceMs = 0;
    return getAutoRedetect();
  }
  function getAutoRedetect() { return { ...autoRedetect }; }

  // Fold a detection result (from the worker or the main-thread landmarker)
  // into the smoothed pose, with a linger grace so a single dropped/empty
  // frame never snaps pose-driven fx off. Shared by both detect paths.
  function applyPoseResult(fresh, t) {
    if (fresh.length > 0) {
      smoothLandmarks(fresh);
      lastDetectMs = t;
      rebuildPeople(t);
      checkGhostLock(t);
    } else if (lingerMs > 0 && t - lastDetectMs > lingerMs) {
      smoothed = [];
      frame.people = [];
      frame.timestamp = t;
    }
    // Within the linger window on an empty frame: hold the last pose.
  }

  async function startCamera({ deviceId, video, facing } = {}) {
    // Pose inference is best-effort: if the landmarker can't build (e.g. the
    // MediaPipe CDN is unreachable at an offline gig), the camera preview
    // must still open — the detect loop just idles until a landmarker
    // exists. This also keeps recoverCamera() able to reopen a reclaimed
    // camera while inference is down.
    if (!hasLandmarker()) {
      try { await buildLandmarker(); }
      catch (err) { console.warn('[qualia] pose landmarker unavailable — camera continues without pose:', err); }
    }

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
    // Bind the track BEFORE flipping detectSource / starting the detect
    // loop — startDetectLoop()'s first tick runs synchronously, and the
    // keep-alive watchdog would otherwise see detectSource === 'camera'
    // with no live track and re-enter startCamera (double getUserMedia).
    activeTrack = stream.getVideoTracks()[0] || null;
    watchTrack(activeTrack);
    recoverFails = 0;
    detectSource = 'camera';
    if (!detectLoopStarted) startDetectLoop();
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

  // ── Hardware camera controls beyond zoom ─────────────────────────────────
  // getZoomCaps/setZoom generalized: read what the active track can actually
  // do (exposure, iso, torch, …) and apply values via constraints. Only
  // capabilities the track reports come back, so the UI renders rows
  // conditionally — iOS Safari reports none of these, Android Chrome and most
  // desktop UVC webcams report several. The dark-stage payoff is exposure:
  // fixing the image at the sensor beats any software boost.
  const CAM_CAP_NAMES = [
    'exposureMode', 'exposureCompensation', 'exposureTime', 'iso',
    'brightness', 'contrast', 'colorTemperature', 'torch',
  ];
  function getCamCaps() {
    if (!activeTrack) return null;
    const caps = activeTrack.getCapabilities?.();
    if (!caps) return null;
    const cur = activeTrack.getSettings?.() || {};
    const out = {};
    for (const name of CAM_CAP_NAMES) {
      const c = caps[name];
      if (c == null) continue;
      if (Array.isArray(c)) {
        // Enumerated modes ('continuous'/'manual'), or [false,true] — some
        // UAs report torch as a boolean array rather than a plain boolean.
        if (typeof c[0] === 'string' && c.length > 1) {
          out[name] = { options: c.slice(), value: cur[name] ?? c[0] };
        } else if (c.includes(true)) {
          out[name] = { toggle: true, value: !!cur[name] };
        }
      } else if (typeof c === 'object') {
        if (typeof c.min === 'number' && typeof c.max === 'number' && c.max > c.min) {
          out[name] = {
            min: c.min, max: c.max,
            step: (typeof c.step === 'number' && c.step > 0)
              ? c.step : (c.max - c.min) / 100,
            value: typeof cur[name] === 'number' ? cur[name] : c.min,
          };
        }
      } else if (c === true) {   // torch per spec: boolean capability
        out[name] = { toggle: true, value: !!cur[name] };
      }
    }
    return Object.keys(out).length ? out : null;
  }
  /** Apply one hardware control by capability name. Best-effort — false when
   *  no track is open or the browser rejects the constraint. */
  async function setCamConstraint(name, value) {
    if (!activeTrack || !CAM_CAP_NAMES.includes(name)) return false;
    try {
      await activeTrack.applyConstraints({ advanced: [{ [name]: value }] });
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

  // ── Camera keep-alive ─────────────────────────────────────────────────────
  // Mobile browsers (Android Chrome especially) pause the <video> element,
  // mute the MediaStreamTrack, or end it outright when the tab is
  // backgrounded, the screen locks, or another app claims the camera — and
  // nothing resumes it on return. A video element with no decoded frame
  // paints TRANSPARENT (not black), so the preview degrades to a ghost
  // border while the app still believes the camera is on. These hooks
  // re-kick play() / re-open the stream whenever that happens.
  let recovering = false;      // reentry guard across the async attempt
  let lastRecoverMs = -1e9;    // rate limit — at most one attempt per 2s
  let recoverFails = 0;        // consecutive failures before giving up

  function trackAlive() {
    return !!(activeTrack && activeTrack.readyState === 'live');
  }

  async function recoverCamera(reason) {
    // Only act while a camera session is (believed) active. detectSource is
    // null during stopCamera()/flipFacing() teardown and the initial
    // startCamera(), so recovery can never race a deliberate (re)start.
    if (detectSource !== 'camera' || !videoEl) return;
    // While hidden the browser is entitled to keep us paused; retry lands
    // via the visibilitychange/pageshow hooks + the detect-loop watchdog.
    if (document.visibilityState === 'hidden') return;
    const now = performance.now();
    if (recovering || now - lastRecoverMs < 2000) return;
    recovering = true;
    lastRecoverMs = now;
    try {
      if (trackAlive()) {
        // Stream is fine — the element just stopped painting/playing.
        // play() resolves as a no-op when already playing.
        await videoEl.play();
        recoverFails = 0;
        return;
      }
      // Track died (OS/another app reclaimed the lens). Re-open the same
      // device; startCamera's constraint ladder falls back gracefully if
      // that exact deviceId is gone.
      console.warn(`[qualia] camera track lost (${reason}) — reopening`);
      await startCamera({ deviceId: activeDeviceId || undefined, video: videoEl });
    } catch (err) {
      recoverFails++;
      console.warn(`[qualia] camera recovery failed (attempt ${recoverFails}):`, err);
      if (recoverFails >= 3 && detectSource === 'camera') {
        // Genuinely gone (e.g. camera held by another app). Tear down so
        // the preview doesn't sit as an invisible ghost frame, and tell the
        // UI so the controls stop claiming the camera is on.
        stopCamera();
        try { window.dispatchEvent(new CustomEvent('qualia:camera-lost', { detail: { reason } })); } catch {}
      }
    } finally {
      recovering = false;
    }
  }

  function watchTrack(track) {
    if (!track) return;
    // Note: our own track.stop() (stopCamera/flipFacing) does NOT fire
    // 'ended' — per spec it only fires when the source ends the track — so
    // this only catches the OS/browser reclaiming the camera under us.
    track.addEventListener('ended', () => recoverCamera('track ended'));
    // Backgrounding often just mutes the track (frames stop flowing). When
    // frames resume the element sometimes stays stalled on Android — a
    // play() kick unsticks the decoder. Harmless if already playing.
    track.addEventListener('unmute', () => { videoEl?.play().catch(() => {}); });
  }

  if (typeof document !== 'undefined') {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      recoverFails = 0;   // fresh retry budget per foreground return
      recoverCamera('page visible');
    };
    document.addEventListener('visibilitychange', onVisible);
    // bfcache restore skips visibilitychange on some browsers.
    window.addEventListener('pageshow', onVisible);
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

  // ── Low-light boost (main-thread fallback path) ──────────────────────────
  // KEEP IN SYNC with the identical math in pose-worker.js — the worker is a
  // deliberately import-free classic worker, so these ~40 lines are mirrored
  // there rather than shared (don't add a third copy). Normally the boost
  // runs in the worker; this copy only serves the fallback path.
  let boostCanvas = null, boostCtx = null;   // full-res filtered frame copy
  let lumaCanvas = null,  lumaCtx = null;    // 32×18 probe for auto gain
  let autoGain = 1, lumaTick = 0;
  const LL_TARGET_LUMA = 110;  // mean 8-bit luma auto aims for (~0.43)
  const LL_MAX_GAIN    = 3.5;
  const LL_LUMA_EVERY  = 15;   // probe cadence in detect ticks (~1 Hz @ 15fps)

  function lowLightActive() { return lowLightAuto || lowLightAmount > 0; }

  function currentBoostGain(source) {
    if (!lowLightAuto) return 1 + lowLightAmount * 1.5;
    if (--lumaTick <= 0) {
      lumaTick = LL_LUMA_EVERY;
      try {
        if (!lumaCanvas) {
          lumaCanvas = document.createElement('canvas');
          lumaCanvas.width = 32; lumaCanvas.height = 18;
          lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
        }
        lumaCtx.drawImage(source, 0, 0, 32, 18);
        const d = lumaCtx.getImageData(0, 0, 32, 18).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        const mean = sum / (d.length * 0.75);
        const want = Math.max(1, Math.min(LL_MAX_GAIN, LL_TARGET_LUMA / Math.max(mean, 8)));
        autoGain += (want - autoGain) * 0.25;   // settle over ~4s, no pumping
      } catch { /* zero-sized frame — keep the last gain */ }
    }
    return autoGain;
  }

  function boostFrame(source, w, h) {
    const gain = currentBoostGain(source);
    lowLightGain = Math.round(gain * 100) / 100;
    if (gain < 1.05) return source;   // not worth a copy
    try {
      if (!boostCanvas) {
        boostCanvas = document.createElement('canvas');
        boostCtx = boostCanvas.getContext('2d');
      }
      if (boostCanvas.width !== w || boostCanvas.height !== h) {
        boostCanvas.width = w; boostCanvas.height = h;
      }
      if (typeof boostCtx.filter === 'string') {
        // Chrome/Firefox: GPU-accelerated canvas filter. Mild contrast rides
        // along so the lifted image doesn't wash flat.
        boostCtx.filter = `brightness(${gain}) contrast(${1 + (gain - 1) * 0.25})`;
        boostCtx.drawImage(source, 0, 0, w, h);
        boostCtx.filter = 'none';
      } else {
        // Safari never shipped ctx.filter: approximate with a screen-blend of
        // the frame over itself — screen(a,a) = 2a − a², a gamma-ish midtone
        // lift, with the blend alpha standing in for gain.
        boostCtx.globalCompositeOperation = 'source-over';
        boostCtx.globalAlpha = 1;
        boostCtx.drawImage(source, 0, 0, w, h);
        boostCtx.globalCompositeOperation = 'screen';
        boostCtx.globalAlpha = Math.min(1, (gain - 1) / 1.5);
        boostCtx.drawImage(source, 0, 0, w, h);
        boostCtx.globalCompositeOperation = 'source-over';
        boostCtx.globalAlpha = 1;
      }
      return boostCanvas;
    } catch {
      return source;
    }
  }

  // Main-thread fallback: synchronous detectForVideo (blocks until the
  // forward pass finishes — the path we move OFF the main thread above).
  function detectMainThread() {
    const source = currentDetectSource();
    if (!source) return;
    const t = performance.now();
    try {
      let det = source;
      if (lowLightActive()) {
        const w = source.videoWidth || source.width || 0;
        const h = source.videoHeight || source.height || 0;
        if (w && h) det = boostFrame(source, w, h);
      } else {
        lowLightGain = 1;
      }
      const result = landmarker.detectForVideo(det, t);
      const fresh = result.landmarks ?? [];
      applyPoseResult(fresh, t); // linger for both sources — see the worker path
    } catch { /* swallow timestamp regressions */ }
  }

  function startDetectLoop() {
    detectLoopStarted = true;
    (function detectLoop() {
      // Park the loop when detection stops (camera + canvas both off) instead
      // of spinning an rAF for the life of the page — it kept mobile devices
      // from idling after stopCamera. startCamera/startCanvas restart it via
      // the `if (!detectLoopStarted)` guard.
      if (!detectSource) { detectLoopStarted = false; return; }
      requestAnimationFrame(detectLoop);
      // Camera keep-alive watchdog — catches stalls that fire no event at
      // all (decoder surface dropped, silent pause). Cheap flag checks per
      // tick; recoverCamera rate-limits the actual work to one attempt/2s.
      if (detectSource === 'camera' && videoEl && (videoEl.paused || !trackAlive())) {
        recoverCamera(videoEl.paused ? 'preview paused' : 'track dead');
      }
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
  /** Swap the landmarker model: 'lite' | 'full' | 'heavy'. Rebuild like
   *  numPoses/thresholds; a rebuild mid-set costs one model fetch + init. */
  async function setModelQuality(q) {
    if (!POSE_MODELS[q] || q === modelQuality) return modelQuality;
    modelQuality = q;
    if (hasLandmarker()) await buildLandmarker();
    return modelQuality;
  }
  /** Low-light boost config, partial patch: {amount 0..1, auto bool}. */
  function setLowLight(cfg = {}) {
    if (cfg.amount != null) {
      const a = Number(cfg.amount);
      lowLightAmount = Math.max(0, Math.min(1, Number.isFinite(a) ? a : 0));
    }
    if (cfg.auto != null) lowLightAuto = !!cfg.auto;
    if (!lowLightAuto && lowLightAmount === 0) lowLightGain = 1;
    pushLowLight();
    return getLowLight();
  }
  function getLowLight() { return { amount: lowLightAmount, auto: lowLightAuto }; }
  /** Gain the boost is actually applying right now (1 = passthrough). */
  function getLowLightGain() { return lowLightGain; }

  function setSmoothing(v) { smoothing = Math.max(0, Math.min(1, v)); }
  function setLingerMs(v)  { lingerMs = Math.max(0, v | 0); }
  /** Uniform pose scale about the frame centre. 1 = raw landmarks. Clamped
   *  wider than the panel slider so code/pattern control can push further. */
  function setScale(v) {
    const s = Number(v);
    poseScale = Math.max(0.1, Math.min(4, Number.isFinite(s) ? s : 1));
  }
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
    getCamCaps,
    setCamConstraint,
    startCanvasDetection,
    stopCanvasDetection,
    setNumPoses,
    setThresholds,
    setModelQuality,
    redetect,
    setAutoRedetect,
    getAutoRedetect,
    setSmoothing,
    setLingerMs,
    setScale,
    setDetectFps,
    setLowLight,
    setHandsEnabled,
    isHandsEnabled: () => handsWanted,
    onHands,
    getNumPoses: () => numPoses,
    getThresholds: () => ({ detect: detectConf, presence: presenceConf, track: trackConf }),
    getModelQuality: () => modelQuality,
    getSmoothing:  () => smoothing,
    getLingerMs:   () => lingerMs,
    getScale:      () => poseScale,
    getDetectFps,
    getLowLight,
    getLowLightGain,
  };
}
