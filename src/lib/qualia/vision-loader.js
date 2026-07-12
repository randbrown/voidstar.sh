// Shared MediaPipe Tasks Vision loader. Multiple Tasks-Vision Tasks
// (PoseLandmarker, ImageSegmenter, …) must share a single FilesetResolver
// instance — calling `FilesetResolver.forVisionTasks` twice against the same
// WASM URL leaves the second consumer's create-from-options awaiting
// forever on some mobile browsers (the first symptom is camera fx hanging
// after the user activates Segment).
//
// Both pose.js and segment.js (and any future Tasks-Vision module) go
// through this loader. The promise is memoized so concurrent first-time
// callers all await the same in-flight request.

// Pin the CDN version — a live set must not break because jsdelivr served a
// new @mediapipe/tasks-vision mid-tour (same policy as STRUDEL_VERSION in
// strudel-hydra.js). Bump deliberately and re-verify pose on device.
// Keep in sync with the copy in pose-worker.js (a Worker can't import this).
const VISION_VERSION = '0.10.35';
const VISION_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;
const VISION_WASM   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;

let _promise = null;

/**
 * @returns {Promise<{ mod: any, fileset: any }>} the resolved Tasks-Vision
 *   module and a single shared FilesetResolver.
 */
export function loadVision() {
  if (_promise) return _promise;
  _promise = (async () => {
    const mod = await import(/* @vite-ignore */ VISION_BUNDLE);
    const fileset = await mod.FilesetResolver.forVisionTasks(VISION_WASM);
    return { mod, fileset };
  })();
  return _promise;
}
