// Pose features — derive named scalar channels from a single Person.
//
// Extracted from modulation.js so two callers can share the EXACT same math:
//   1. The host engine (modulation.js POSE_CHANNELS) — turns the local camera
//      pose into `pose.*` modulation channels.
//   2. The Entanglement participant client — runs the same pose pipeline on a
//      phone and ships these 8 derived floats (not 33 raw landmarks) to the
//      host, where they're aggregated into the `crowd.*` channels.
//
// Keeping the normalization here guarantees a participant's "wrist spread"
// means the same thing as the performer's, so crowd aggregation is coherent.
//
// All outputs are documented ranges; see modulation.js channel docs.

const HEAD_VIS = 0.30;
const SHOULDER_VIS = 0.40;
const WRIST_VIS = 0.30;

export function poseHeadX(p) {
  // Camera frames are mirrored — flip so right-on-screen reads as positive x.
  if (!p?.head || p.head.visibility < HEAD_VIS) return 0;
  return (1.0 - p.head.x) * 2.0 - 1.0;
}
export function poseHeadY(p) {
  if (!p?.head || p.head.visibility < HEAD_VIS) return 0;
  return p.head.y * 2.0 - 1.0;
}
export function poseShoulderSpan(p) {
  const sL = p?.shoulders?.l, sR = p?.shoulders?.r;
  if (!sL || !sR || sL.visibility < SHOULDER_VIS || sR.visibility < SHOULDER_VIS) return 0;
  const dx = sR.x - sL.x, dy = sR.y - sL.y;
  const span = Math.sqrt(dx * dx + dy * dy);
  // Same normalization gargantua-void uses: typical span ≈ 0.25, ±0.20 swing.
  const v = (span - 0.25) / 0.20;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
export function poseShoulderRoll(p) {
  const sL = p?.shoulders?.l, sR = p?.shoulders?.r;
  if (!sL || !sR || sL.visibility < SHOULDER_VIS || sR.visibility < SHOULDER_VIS) return 0;
  const v = (sR.y - sL.y) * 5.0;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
export function poseHeadPitch(p) {
  const sL = p?.shoulders?.l, sR = p?.shoulders?.r, h = p?.head;
  if (!sL || !sR || !h
      || sL.visibility < SHOULDER_VIS || sR.visibility < SHOULDER_VIS
      || h.visibility < HEAD_VIS) return 0;
  const dx = sR.x - sL.x, dy = sR.y - sL.y;
  const span = Math.sqrt(dx * dx + dy * dy);
  if (span < 0.05) return 0;
  const midY = (sL.y + sR.y) * 0.5;
  const ratio = (midY - h.y) / span;
  const v = (ratio - 0.75) / 0.40;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
export function poseWristSpread(p) {
  const wL = p?.wrists?.l, wR = p?.wrists?.r;
  if (!wL || !wR || wL.visibility < WRIST_VIS || wR.visibility < WRIST_VIS) return 0;
  const dx = wR.x - wL.x, dy = wR.y - wL.y;
  const spread = Math.sqrt(dx * dx + dy * dy);
  // Loose normalization — 0.40 is a typical "arms moderately apart" value.
  const v = (spread - 0.40) / 0.30;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
export function poseWristMidY(p) {
  const wL = p?.wrists?.l, wR = p?.wrists?.r;
  if (!wL || !wR || wL.visibility < WRIST_VIS || wR.visibility < WRIST_VIS) return 0;
  const midY = (wL.y + wR.y) * 0.5;
  // Above shoulders → negative; below hips → positive. Centered on 0.55.
  const v = (midY - 0.55) * 2.5;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
export function poseConfidence(p) {
  return p?.confidence ?? 0;
}

/**
 * The compact feature vector a participant ships over the wire. Order is
 * fixed so it can travel as a plain array [hx, hy, ss, sr, hp, ws, wy, conf].
 * @param {object|null} person  A reshaped Person (pose.js shapePerson output).
 */
export function poseFeatures(person) {
  return {
    headX:        poseHeadX(person),
    headY:        poseHeadY(person),
    shoulderSpan: poseShoulderSpan(person),
    shoulderRoll: poseShoulderRoll(person),
    headPitch:    poseHeadPitch(person),
    wristSpread:  poseWristSpread(person),
    wristMidY:    poseWristMidY(person),
    confidence:   poseConfidence(person),
  };
}

/** Pack/unpack the feature vector as a fixed-order array for the wire. */
export const FEATURE_ORDER = [
  'headX', 'headY', 'shoulderSpan', 'shoulderRoll',
  'headPitch', 'wristSpread', 'wristMidY', 'confidence',
];
export function packFeatures(f) { return FEATURE_ORDER.map(k => +(f[k] || 0).toFixed(3)); }
export function unpackFeatures(arr) {
  const o = {};
  for (let i = 0; i < FEATURE_ORDER.length; i++) o[FEATURE_ORDER[i]] = arr?.[i] ?? 0;
  return o;
}

// ── Skeleton (overlay-only) ──────────────────────────────────────────────────
// A compact upper-body skeleton for the host's crowd-overlay render. Unlike the
// 8 aggregate features above, this is the raw joint geometry — sent ONLY while a
// host has the skeleton overlay on (manifest gates it), so the default path
// stays tiny. 9 joints × (x, y) in normalized [0,1] camera space; a joint below
// the visibility floor (or absent) is encoded as (-1, -1) = "don't draw".
export const SKELETON_JOINTS = ['head', 'shL', 'shR', 'elL', 'elR', 'wrL', 'wrR', 'hipL', 'hipR'];
// Bone connections (index pairs into SKELETON_JOINTS) the renderer draws.
export const SKELETON_BONES = [
  [1, 2],          // shoulders
  [1, 3], [3, 5],  // left arm  (shoulder→elbow→wrist)
  [2, 4], [4, 6],  // right arm
  [1, 7], [2, 8],  // torso sides (shoulder→hip)
  [7, 8],          // hips
];
const SKEL_VIS = 0.30;
function jointXY(j) {
  if (!j || (j.visibility != null && j.visibility < SKEL_VIS)) return [-1, -1];
  return [+(j.x).toFixed(3), +(j.y).toFixed(3)];
}
/** Pack a Person → flat [hx,hy, shLx,shLy, …] of 18 numbers. */
export function packSkeleton(p) {
  const head = jointXY(p?.head);
  const shL = jointXY(p?.shoulders?.l), shR = jointXY(p?.shoulders?.r);
  const elL = jointXY(p?.elbows?.l),    elR = jointXY(p?.elbows?.r);
  const wrL = jointXY(p?.wrists?.l),    wrR = jointXY(p?.wrists?.r);
  const hipL = jointXY(p?.hips?.l),     hipR = jointXY(p?.hips?.r);
  return [...head, ...shL, ...shR, ...elL, ...elR, ...wrL, ...wrR, ...hipL, ...hipR];
}
/**
 * Re-orient a packed skeleton in normalized [0,1] space. Applied on the
 * participant's PHONE before shipping, so the performer's machine can draw each
 * body exactly as the participant chose — no host-side mirror-guessing (which
 * was what left bodies flipped/mirrored on the big screen). flipH/flipV mirror;
 * `rot` is a clockwise quarter-turn in {0,90,180,270} for a sideways phone.
 * Sentinel (-1,-1) joints pass through untouched ("don't draw").
 * @param {number[]} arr  packed skeleton (flat x,y pairs)
 * @param {{flipH?:boolean,flipV?:boolean,rot?:number}} [ori]
 */
export function orientSkeleton(arr, ori) {
  if (!arr || !ori) return arr;
  const flipH = !!ori.flipH, flipV = !!ori.flipV;
  const rot = (((ori.rot || 0) % 360) + 360) % 360;
  if (!flipH && !flipV && !rot) return arr;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i += 2) {
    let x = arr[i], y = arr[i + 1];
    if (x == null || y == null || x < 0 || y < 0) { out[i] = -1; out[i + 1] = -1; continue; }
    if (rot === 90)       { const nx = 1 - y, ny = x;     x = nx; y = ny; }
    else if (rot === 180) { x = 1 - x; y = 1 - y; }
    else if (rot === 270) { const nx = y, ny = 1 - x;     x = nx; y = ny; }
    if (flipH) x = 1 - x;
    if (flipV) y = 1 - y;
    out[i] = +x.toFixed(3); out[i + 1] = +y.toFixed(3);
  }
  return out;
}

/** Unpack → array of {x,y}|null in SKELETON_JOINTS order (null = don't draw). */
export function unpackSkeleton(arr) {
  const out = [];
  for (let i = 0; i < SKELETON_JOINTS.length; i++) {
    const x = arr?.[i * 2], y = arr?.[i * 2 + 1];
    out.push((x == null || x < 0 || y < 0) ? null : { x, y });
  }
  return out;
}
