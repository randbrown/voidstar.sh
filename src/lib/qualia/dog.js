// Dog detection — MediaPipe ObjectDetector (COCO) filtered to "dog", with a
// coarse skeleton synthesized from each bounding box. Exists as a sibling to
// pose.js, but does NOT run its own rAF / camera lifecycle: pose.js drives the
// detect loop and asks this module for fresh detections each tick. That keeps
// the camera, throttle, and lingering policy single-sourced.
//
// Output shape is a `Person`-like object with `kind: 'dog'`, so detected dogs
// land in the same `frame.pose.people` array existing fx already iterate. fx
// that read shared joints (head/neck/hips) work on dogs out of the box; fx
// that read human-only joints (wrists/elbows/...) skip dogs because those
// keys are undefined.
//
// The bbox→skeleton synthesis is deliberately coarse — 6-ish landmarks
// arranged along the bbox's long axis, with heading inferred from
// inter-frame centroid motion (defaults to "head=left" when stationary).
// This is for artistic effect, not anatomy.

import { loadVision } from './vision-loader.js';

const DOG_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite';

export function createDogDetector() {
  let detector = null;
  let vision = null;
  let ObjectDetectorCls = null;

  let minScore = 0.4;
  let maxDogs = 2;
  let dirty = false; // model needs rebuild on next ensure*

  async function ensureVision() {
    if (vision) return vision;
    const { mod, fileset } = await loadVision();
    ObjectDetectorCls = mod.ObjectDetector;
    vision = fileset;
    return vision;
  }

  async function buildDetector() {
    if (!vision) await ensureVision();
    if (!ObjectDetectorCls) return null; // Older Tasks-Vision bundles may lack it.
    if (detector) { try { detector.close(); } catch {} detector = null; }
    detector = await ObjectDetectorCls.createFromOptions(vision, {
      baseOptions: { modelAssetPath: DOG_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      maxResults: Math.max(1, maxDogs * 2),
      scoreThreshold: minScore,
      categoryAllowlist: ['dog'],
    });
    dirty = false;
    return detector;
  }

  async function ensureDetector() {
    if (detector && !dirty) return detector;
    return await buildDetector();
  }

  /** Run one inference on the given source. Returns array of raw detections
   *  (already filtered to dog, score-thresholded by the model). Caller is
   *  responsible for throttling. Returns [] on first-call before model loads
   *  (build is async + non-blocking). */
  function detectSync(source, t) {
    if (!detector || dirty) return null; // Caller should `await ensureDetector()` first.
    try {
      const result = detector.detectForVideo(source, t);
      const all = result?.detections ?? [];
      // Cap to maxDogs by score (model already sorts but we keep this defensive).
      if (all.length <= maxDogs) return all;
      return [...all].sort((a, b) => (b.categories?.[0]?.score ?? 0) - (a.categories?.[0]?.score ?? 0)).slice(0, maxDogs);
    } catch {
      return [];
    }
  }

  /** Match new detections to previous synthesized dogs by nearest centroid,
   *  so per-instance state (heading, smoothing) carries across frames. */
  function matchToPrev(newRaw, prev, imgW, imgH) {
    const used = new Set();
    return newRaw.map(det => {
      const b = det.boundingBox;
      // MediaPipe ObjectDetector returns boundingBox in source pixels.
      const cx = (b.originX + b.width / 2) / imgW;
      const cy = (b.originY + b.height / 2) / imgH;
      let bestIdx = -1, bestD = Infinity;
      for (let i = 0; i < prev.length; i++) {
        if (used.has(i)) continue;
        const p = prev[i];
        if (!p) continue;
        const pc = p.bbox;
        const pcx = pc.x + pc.w / 2, pcy = pc.y + pc.h / 2;
        const dx = pcx - cx, dy = pcy - cy;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestD < 0.05) used.add(bestIdx); // ~22% bbox-distance gate
      const prior = bestIdx >= 0 ? prev[bestIdx] : null;
      return { det, prior, cx, cy, w: b.width / imgW, h: b.height / imgH };
    });
  }

  /** Build a Person-shaped object for one matched detection. */
  function shapeDog(matched) {
    const { det, prior, cx, cy, w, h } = matched;
    const score = det.categories?.[0]?.score ?? 0;

    // Heading: bbox is axis-aligned in image space, so we don't know which end
    // is the head. Two cues:
    //   1. Motion: if the dog has moved meaningfully since last frame, head
    //      points along the centroid delta projected onto the long axis.
    //   2. Stationary fallback: assume the dog faces left (heading.x = -1).
    // Result is a unit vector along the long axis ({±1, 0} or {0, ±1}).
    const longAxisX = w >= h;
    let hx, hy;
    if (prior) {
      const ddx = cx - (prior.bbox.x + prior.bbox.w / 2);
      const ddy = cy - (prior.bbox.y + prior.bbox.h / 2);
      // Smooth heading across frames: only flip when motion strongly opposes
      // current heading. Otherwise carry over.
      hx = prior.heading.x;
      hy = prior.heading.y;
      if (longAxisX) {
        if (Math.abs(ddx) > 0.004) hx = ddx < 0 ? -1 : 1;
        hy = 0;
      } else {
        if (Math.abs(ddy) > 0.004) hy = ddy < 0 ? -1 : 1;
        hx = 0;
      }
    } else {
      // Default: head points left (matches typical stock-photo orientation).
      hx = longAxisX ? -1 : 0;
      hy = longAxisX ? 0 : -1;
    }

    // bbox edges in [0,1] image coords
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;

    // Helper: a point at fraction `t` along the long axis from the head end,
    // and `s` perpendicular offset (-1..1) from the long axis centerline.
    function ptAlong(t, s = 0) {
      if (longAxisX) {
        const headX = hx < 0 ? x1 : x0; // head at x1 if heading -x, x0 if +x
        const tailX = hx < 0 ? x0 : x1;
        const x = headX + (tailX - headX) * t;
        const y = cy + s * (h * 0.5);
        return { x, y, z: 0, visibility: score };
      } else {
        const headY = hy < 0 ? y1 : y0;
        const tailY = hy < 0 ? y0 : y1;
        const y = headY + (tailY - headY) * t;
        const x = cx + s * (w * 0.5);
        return { x, y, z: 0, visibility: score };
      }
    }

    // Tail extends past the back edge by 25% of the long-axis length.
    function tailPt() {
      if (longAxisX) {
        const tailX = hx < 0 ? x0 : x1;
        const beyond = (hx < 0 ? -1 : 1) * w * 0.25;
        return { x: tailX + beyond, y: cy, z: 0, visibility: score * 0.7 };
      } else {
        const tailY = hy < 0 ? y0 : y1;
        const beyond = (hy < 0 ? -1 : 1) * h * 0.25;
        return { x: cx, y: tailY + beyond, z: 0, visibility: score * 0.7 };
      }
    }

    // Snout: small offset past head along heading.
    function snoutPt() {
      const head = ptAlong(0, 0);
      if (longAxisX) {
        head.x += (hx < 0 ? 1 : -1) * w * 0.06; // pull *back* a hair so it's INSIDE bbox
      } else {
        head.y += (hy < 0 ? 1 : -1) * h * 0.06;
      }
      head.visibility = score * 0.8;
      return head;
    }

    // Bottom edge in image coords (paws sit on the lower edge of the bbox).
    // For a dog detected from the side, the long axis is roughly horizontal;
    // for a top-down dog, it's vertical. Either way, paws drop to the bottom
    // of the bbox in image space.
    function paw(longT, sideS) {
      const p = ptAlong(longT, sideS);
      // Snap y to the bottom of the bbox so paws look grounded.
      p.y = y1;
      p.visibility = score * 0.6;
      return p;
    }

    // Hips: two points 80% back along the long axis, at ±40% perpendicular.
    const hipsL = ptAlong(0.8, -0.4);
    const hipsR = ptAlong(0.8,  0.4);
    hipsL.visibility = score * 0.7;
    hipsR.visibility = score * 0.7;

    return {
      kind: 'dog',
      head:  ptAlong(0.0, 0),
      neck:  ptAlong(0.2, 0),
      snout: snoutPt(),
      hips:  { l: hipsL, r: hipsR },
      paws:  {
        // Front paws — 25% back along long axis, on either side.
        fl: paw(0.25, -0.45),
        fr: paw(0.25,  0.45),
        // Back paws — 80% back, on either side.
        bl: paw(0.80, -0.45),
        br: paw(0.80,  0.45),
      },
      tail: tailPt(),
      bbox: { x: x0, y: y0, w, h },
      heading: { x: hx, y: hy },
      raw: null, // no per-landmark raw array for synthesized dogs
      confidence: score,
    };
  }

  function setMinScore(v) {
    const next = Math.max(0, Math.min(1, v));
    if (next === minScore) return;
    minScore = next;
    dirty = true;
  }

  function setMaxDogs(n) {
    const next = Math.max(0, Math.min(6, n | 0));
    if (next === maxDogs) return;
    maxDogs = next;
    dirty = true;
  }

  function close() {
    if (detector) { try { detector.close(); } catch {} detector = null; }
  }

  return {
    ensureDetector,
    detectSync,
    matchToPrev,
    shapeDog,
    setMinScore,
    setMaxDogs,
    getMinScore: () => minScore,
    getMaxDogs:  () => maxDogs,
    close,
    isReady: () => !!detector && !dirty,
  };
}
