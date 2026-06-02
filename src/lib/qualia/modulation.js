// Modulation — audio + pose + time channels and the param resolver.
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
//   crowd.x | crowd.y                 ([-1, +1] mean audience head position)
//   crowd.energy                      ([0, 1] mean audience motion)
//   crowd.spread                      ([-1, +1] mean arm spread)
//   crowd.rise                        ([0, 1] hands raised across the crowd)
//   crowd.sway                        ([-1, +1] low-passed mean head x)
//   crowd.count                       ([0, 1] normalized active-participant count)
//   crowd.confidence                  ([0, 1] mean tracking confidence)
//   time.slow | time.med | time.fast  ([-1, +1] sin LFOs, ~31s/12s/5s)
//   time.veryFast                     ([-1, +1] sin LFO, ~2s)
//   time.slowCos | time.medCos        (cos counterparts — 90° phase, for
//                                       circular / quadrature motion)
//
// Modulator modes:
//   'add'     v += source * amount
//   'mul'     v *= (1 + source * amount)         (amount=0 ⇒ identity)
//   'replace' v  = source * amount               (param value ignored)
//
// The per-fx `reactivity` slider (when present) is a global multiplier on
// every audio modulator's amount; the parallel `poseReactivity` slider (when
// present) does the same for pose modulators. A quale that declares neither
// gets gain 1 on both. Pose smoothing/confidence is still handled at the
// source; poseReactivity only scales the modulator contribution.

import {
  poseHeadX, poseHeadY, poseShoulderSpan, poseShoulderRoll,
  poseHeadPitch, poseWristSpread, poseWristMidY, poseConfidence,
} from './pose-features.js';

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

// ── Pose channels (single-person; person 0 only) ───────────────────────
// The per-feature normalization lives in pose-features.js so the audience
// (Entanglement) client computes identical values on participant phones.
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

// ── Crowd channels (Entanglement — aggregated audience input) ──────────
// Read from `field.crowd`, a snapshot the host fills once per react-tick by
// reducing every connected participant down to these few scalars (O(N), and
// N is a small intimate crowd). Zeroed when no one is entangled, so a quale
// that modulates against crowd.* simply sees 0 (identity) during a solo set.
const CROWD_CHANNELS = {
  'crowd.x':          c => c.x,
  'crowd.y':          c => c.y,
  'crowd.energy':     c => c.energy,
  'crowd.spread':     c => c.spread,
  'crowd.rise':       c => c.rise,
  'crowd.sway':       c => c.sway,
  'crowd.count':      c => c.count,
  'crowd.confidence': c => c.confidence,
};

// ── Time channels (LFOs) ───────────────────────────────────────────────
// Output is in [-1, +1]. Periods are deliberately incommensurate so that
// combining two channels rarely repeats a phase pattern — that keeps
// "auto-pilot" visuals from feeling looped. The cos variants are 90°
// shifted so an fx can use (slow, slowCos) as a quadrature pair for
// circular or Lissajous-style motion.
const TIME_CHANNELS = {
  'time.slow':     t => Math.sin(t * 0.20),  // ≈ 31s period
  'time.med':      t => Math.sin(t * 0.50),  // ≈ 12.5s
  'time.fast':     t => Math.sin(t * 1.25),  // ≈ 5s
  'time.veryFast': t => Math.sin(t * 3.10),  // ≈ 2s
  'time.slowCos':  t => Math.cos(t * 0.20),
  'time.medCos':   t => Math.cos(t * 0.50),
};

/** Names available as `modulators[].source`. Sorted for UI display. */
export const CHANNEL_IDS = [
  ...Object.keys(AUDIO_CHANNELS),
  ...Object.keys(POSE_CHANNELS),
  ...Object.keys(CROWD_CHANNELS),
  ...Object.keys(TIME_CHANNELS),
];

/** Compute every channel value into `out` from the live field. Mutates `out`. */
export function computeChannels(field, out) {
  const a = field.audio;
  for (const id in AUDIO_CHANNELS) out[id] = AUDIO_CHANNELS[id](a);
  const p0 = field.pose?.people?.[0] ?? null;
  for (const id in POSE_CHANNELS) out[id] = POSE_CHANNELS[id](p0);
  const c = field.crowd || EMPTY_CROWD;
  for (const id in CROWD_CHANNELS) out[id] = CROWD_CHANNELS[id](c);
  const t = field.time;
  for (const id in TIME_CHANNELS) out[id] = TIME_CHANNELS[id](t);
  return out;
}

// Zeroed fallback so computeChannels is safe before any crowd snapshot exists.
const EMPTY_CROWD = { x: 0, y: 0, energy: 0, spread: 0, rise: 0, sway: 0, count: 0, confidence: 0 };

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
  // Reactivity masters: audio modulators scale by `reactivity`, pose
  // modulators by `poseReactivity` — each when the fx declares that param
  // (default 1 = unscaled). Lets a quale offer one global "how audio-reactive"
  // and one "how pose-reactive" knob; both at 0 ⇒ the base values pass through
  // untouched (e.g. the video quale's unmodified 'default' preset).
  const audioGain = (base.reactivity == null) ? 1 : base.reactivity;
  const poseGain  = (base.poseReactivity == null) ? 1 : base.poseReactivity;
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
      const isPose  = !isAudio
                   && mod.source.charCodeAt(0) === 112 /* 'p' */
                   && mod.source.startsWith('pose.');
      const gain = isAudio ? audioGain : (isPose ? poseGain : 1);
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
