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
