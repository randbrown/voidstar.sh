// Modulation — audio + pose channels and the param resolver.
//
// Channels are named scalars derived from the current QualiaField. An fx
// declares modulators on its params; the engine computes channels once per
// frame and applies them so `field.params.x` reaches the fx already nudged.
// Direct reads of `field.audio.*` / `field.pose.*` still work — modulation
// complements them, doesn't replace them.
//
// Source path conventions:
//   audio.bass | audio.mids | audio.highs | audio.total | audio.rms
//   audio.beatPulse | audio.midsPulse | audio.highsPulse
//   pose.head.x | pose.head.y         (mirrored, [-1, +1] from frame center)
//   pose.shoulderSpan                 ([-1, +1] centered on typical webcam dist)
//   pose.shoulderRoll                 ([-1, +1] right shoulder lower → +)
//   pose.headPitch                    ([-1, +1] lean back → +)
//   pose.wristSpread                  ([-1, +1] wide → +)
//   pose.wristMidY                    ([-1, +1] hands high → -)
//   pose.confidence                   ([0, 1] mean visibility)
//
// Modulator modes:
//   'add'     v += source * amount
//   'mul'     v *= (1 + source * amount)         (amount=0 ⇒ identity)
//   'replace' v  = source * amount               (param value ignored)
//
// The per-fx `reactivity` slider (when present) is applied as a global
// multiplier on every audio modulator's amount. Pose modulators ignore it —
// pose smoothing/confidence is handled at the source.

const HEAD_VIS = 0.30;
const SHOULDER_VIS = 0.40;
const WRIST_VIS = 0.30;

// ── Audio channels ─────────────────────────────────────────────────────
const AUDIO_CHANNELS = {
  'audio.bass':       a => a.bands.bass,
  'audio.mids':       a => a.bands.mids,
  'audio.highs':      a => a.bands.highs,
  'audio.total':      a => a.bands.total,
  'audio.rms':        a => a.rms,
  'audio.beatPulse':  a => a.beat.pulse,
  'audio.midsPulse':  a => a.mids.pulse,
  'audio.highsPulse': a => a.highs.pulse,
};

// ── Pose channels (single-person v1; person 0 only) ────────────────────
function poseHeadX(p) {
  // Camera frames are mirrored — flip so right-on-screen reads as positive x.
  if (!p?.head || p.head.visibility < HEAD_VIS) return 0;
  return (1.0 - p.head.x) * 2.0 - 1.0;
}
function poseHeadY(p) {
  if (!p?.head || p.head.visibility < HEAD_VIS) return 0;
  return p.head.y * 2.0 - 1.0;
}
function poseShoulderSpan(p) {
  const sL = p?.shoulders?.l, sR = p?.shoulders?.r;
  if (!sL || !sR || sL.visibility < SHOULDER_VIS || sR.visibility < SHOULDER_VIS) return 0;
  const dx = sR.x - sL.x, dy = sR.y - sL.y;
  const span = Math.sqrt(dx * dx + dy * dy);
  // Same normalization gargantua-void uses: typical span ≈ 0.25, ±0.20 swing.
  const v = (span - 0.25) / 0.20;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
function poseShoulderRoll(p) {
  const sL = p?.shoulders?.l, sR = p?.shoulders?.r;
  if (!sL || !sR || sL.visibility < SHOULDER_VIS || sR.visibility < SHOULDER_VIS) return 0;
  const v = (sR.y - sL.y) * 5.0;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
function poseHeadPitch(p) {
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
function poseWristSpread(p) {
  const wL = p?.wrists?.l, wR = p?.wrists?.r;
  if (!wL || !wR || wL.visibility < WRIST_VIS || wR.visibility < WRIST_VIS) return 0;
  const dx = wR.x - wL.x, dy = wR.y - wL.y;
  const spread = Math.sqrt(dx * dx + dy * dy);
  // Loose normalization — 0.40 is a typical "arms moderately apart" value.
  const v = (spread - 0.40) / 0.30;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
function poseWristMidY(p) {
  const wL = p?.wrists?.l, wR = p?.wrists?.r;
  if (!wL || !wR || wL.visibility < WRIST_VIS || wR.visibility < WRIST_VIS) return 0;
  const midY = (wL.y + wR.y) * 0.5;
  // Above shoulders → negative; below hips → positive. Centered on 0.55.
  const v = (midY - 0.55) * 2.5;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
function poseConfidence(p) {
  return p?.confidence ?? 0;
}

const POSE_CHANNELS = {
  'pose.head.x':        poseHeadX,
  'pose.head.y':        poseHeadY,
  'pose.shoulderSpan':  poseShoulderSpan,
  'pose.shoulderRoll':  poseShoulderRoll,
  'pose.headPitch':     poseHeadPitch,
  'pose.wristSpread':   poseWristSpread,
  'pose.wristMidY':     poseWristMidY,
  'pose.confidence':    poseConfidence,
};

/** Names available as `modulators[].source`. Sorted for UI display. */
export const CHANNEL_IDS = [
  ...Object.keys(AUDIO_CHANNELS),
  ...Object.keys(POSE_CHANNELS),
];

/** Compute every channel value into `out` from the live field. Mutates `out`. */
export function computeChannels(field, out) {
  const a = field.audio;
  for (const id in AUDIO_CHANNELS) out[id] = AUDIO_CHANNELS[id](a);
  const p0 = field.pose?.people?.[0] ?? null;
  for (const id in POSE_CHANNELS) out[id] = POSE_CHANNELS[id](p0);
  return out;
}

export function makeChannelSnapshot() {
  const o = {};
  for (const id of CHANNEL_IDS) o[id] = 0;
  return o;
}

/** Storage key form for a modulator's weight. */
export function modWeightKey(paramId, modIdx) { return `${paramId}.${modIdx}`; }

/**
 * Apply modulators to a base param dict, writing into `into`.
 * @param {Object} into       Scratch dict to populate (mutated, returned).
 * @param {Object} base       User-set (UI-side) param values.
 * @param {Array}  schema     The fx's params spec list.
 * @param {Object} channels   Output of computeChannels().
 * @param {Object} [modWeights] Per-modulator user weights, keyed by
 *                              `${paramId}.${modIdx}`. Default 1 each.
 *                              Multiplies the spec's declared `amount`.
 */
export function resolveParams(into, base, schema, channels, modWeights) {
  for (const k in base) into[k] = base[k];
  // Audio modulators scale by the per-fx reactivity slider when the fx
  // declares one (default 1). Pose modulators ignore it.
  const audioGain = (base.reactivity == null) ? 1 : base.reactivity;
  const w = modWeights || null;
  for (const spec of schema) {
    const mods = spec.modulators;
    if (!mods || mods.length === 0) continue;
    let v = into[spec.id];
    if (typeof v !== 'number') continue;
    for (let i = 0; i < mods.length; i++) {
      const mod = mods[i];
      const src = channels[mod.source];
      if (src == null) continue;
      const isAudio = mod.source.charCodeAt(0) === 97 /* 'a' */
                   && mod.source.startsWith('audio.');
      const gain = isAudio ? audioGain : 1;
      const userWeight = w == null ? 1 : (w[modWeightKey(spec.id, i)] ?? 1);
      const amt = (mod.amount == null ? 1 : mod.amount) * userWeight * gain;
      if (amt === 0) continue;
      const delta = src * amt;
      if (mod.mode === 'add')          v += delta;
      else if (mod.mode === 'replace') v  = delta;
      else /* 'mul' default */         v *= (1 + delta);
    }
    if (spec.type === 'range') {
      if (v < spec.min) v = spec.min;
      else if (v > spec.max) v = spec.max;
    }
    into[spec.id] = v;
  }
  return into;
}
