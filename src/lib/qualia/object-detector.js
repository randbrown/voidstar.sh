// Shared object-detection pipeline — real MediaPipe ObjectDetector
// (EfficientDet-Lite0) running in a worker (detector-worker.js), pumped from
// the SAME camera <video> element the pose pipeline owns (via getVideoEl —
// this module never opens the camera itself). Consumers acquire/release a
// refcount; while held, `getDetections()` returns the latest normalized
// detections:
//
//   [{ cx, cy, hw, hh, label, score }]   // all coords in [0,1] camera frame
//
// Design notes:
//   • Best-effort, like pose: if the CDN/model is unreachable (offline gig)
//     or the worker dies, detections just stay empty — consumers must render
//     a sensible idle state, never error.
//   • Low cadence (~7 fps) on purpose. This feeds an ambient scanner HUD,
//     not a robot; consumers EMA-smooth targets so the gaps never read as
//     jitter, and the CPU stays free for audio + visuals.
//   • Backpressure: one frame in flight at a time, watchdog-unstuck.
//   • The worker stays warm across release/acquire cycles so toggling the
//     HUD mid-set doesn't re-download the model.

import { getVideoEl } from './video.js';

const DETECT_INTERVAL_MS = 140;   // ~7 fps
const STALE_MS = 1500;            // camera stopped → results age out

let worker = null;
let workerReady = false;
let workerBusy = false;
let workerFailed = false;
let workerSentAt = 0;

let refs = 0;
let timer = null;

let detections = [];
let lastResultMs = 0;

function onWorkerMessage(e) {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'ready') { workerReady = true; return; }
  if (msg.type === 'error') {
    console.warn('[qualia] object-detector worker error — detector HUD idle:', msg.error);
    failWorker();
    return;
  }
  if (msg.type === 'result') {
    workerBusy = false;
    detections = msg.detections || [];
    lastResultMs = performance.now();
  }
}

function failWorker() {
  workerFailed = true;
  workerReady = false;
  workerBusy = false;
  try { worker?.terminate(); } catch {}
  worker = null;
  detections = [];
}

function ensureWorker() {
  if (workerFailed || worker) return;
  try {
    // CLASSIC worker (not type:'module') — same constraint as pose-worker.js:
    // MediaPipe's FilesetResolver needs importScripts() for its WASM glue.
    worker = new Worker(new URL('./detector-worker.js', import.meta.url));
    worker.addEventListener('message', onWorkerMessage);
    worker.addEventListener('error', (err) => {
      console.warn('[qualia] object-detector worker failed — detector HUD idle:', err?.message || err);
      failWorker();
    });
    worker.postMessage({ type: 'init', opts: { maxResults: 8, scoreThreshold: 0.35 } });
  } catch (err) {
    console.warn('[qualia] object-detector worker unavailable:', err);
    failWorker();
  }
}

function tick() {
  const now = performance.now();
  if (detections.length && now - lastResultMs > STALE_MS) detections = [];
  if (!worker || !workerReady) return;
  if (workerBusy) {
    if (now - workerSentAt > 3000) workerBusy = false;   // watchdog
    else return;
  }
  const video = getVideoEl();
  if (!video || video.readyState < 2 || video.paused || video.ended) return;
  workerBusy = true;
  workerSentAt = now;
  createImageBitmap(video).then((bitmap) => {
    if (!worker || !refs) { try { bitmap.close?.(); } catch {} workerBusy = false; return; }
    worker.postMessage({ type: 'detect', bitmap, t: now }, [bitmap]);
  }).catch(() => { workerBusy = false; });
}

/** Start (or join) the detection pipeline. Pair with releaseDetector(). */
export function acquireDetector() {
  refs++;
  ensureWorker();
  if (!timer) timer = setInterval(tick, DETECT_INTERVAL_MS);
}

/** Release one hold. The pump stops at zero holds; the worker stays warm. */
export function releaseDetector() {
  refs = Math.max(0, refs - 1);
  if (refs === 0) {
    if (timer) { clearInterval(timer); timer = null; }
    detections = [];
  }
}

/** Latest normalized detections (empty when idle / no camera / no matches). */
export function getDetections() { return detections; }
