// Neural amp model parser — normalises a loaded capture file into the flat
// typed-array form the neural-amp worklet expects:
//   { ok, type:'lstm', hidden, Wih, Whh, b, Wd, bd }   (single-layer LSTM, input 1)
//   { ok, type:'wavenet', arrays, headScale, … }       (NAM WaveNet, WASM kernel)
// or { ok:false, reason }.
//
// Supported:
//   - GuitarML / RTNeural state_dict JSON (Proteus, NeuralPi) — rec.* / lin.*
//   - AIDA-X-style single-LSTM JSON (same state_dict shape)
//   - NAM .nam with architecture "LSTM" (experimental — single layer, input 1)
//   - NAM .nam with architecture "WaveNet" — the standard NAM architecture, and
//     what virtually every shared `.nam` capture actually is. Runs on the WASM
//     SIMD kernel (wasm/nam-wavenet.c); the parsing lives in nam-wavenet.js.
//   - NAM 0.7 container architectures (SlimmableContainer) wrapping a WaveNet
// Not supported:
//   - conditioned (input_size > 1) or multi-layer LSTM models
//   - NAM extras nobody ships yet: FiLM blocks, grouped convs, per-layer gating

import { parseWaveNet, unwrapContainer } from './nam-wavenet.js';

// ── capture normalisation ───────────────────────────────────────────────────
// NAM captures carry a measured output loudness, and they vary by well over
// 10 dB between models — enough that swapping one mid-set sends a real level
// jump to the PA, and enough to change how hard the mixer limiter works and how
// excitable the visuals are (the rig analyser is adopted into the mix).
//
// `normTrim` is the linear gain that would bring a capture to a common level.
// It is only ever ADVISORY: the strip applies it when the amp stage's `norm`
// toggle is on, and the loader shows the dB it represents. Nothing here changes
// the model's own output.
//
// Caveats worth remembering: the loudness is measured at one operating point of
// a NONLINEAR model, so matching there doesn't guarantee matching at your own
// dynamics or with the drive knob up; and only NAM files declare it at all —
// GuitarML/AIDA-X captures get a trim of 1 and say so.
const NORM_TARGET_DB = -18;   // NAM's own normalisation target, so levels
                              // translate between this rig and other NAM hosts
const NORM_MAX_DB = 12;       // never trim further than this in either direction

export function normTrimFor(loudnessDb) {
  if (!Number.isFinite(loudnessDb)) return 1;
  const db = Math.max(-NORM_MAX_DB, Math.min(NORM_MAX_DB, NORM_TARGET_DB - loudnessDb));
  return Math.pow(10, db / 20);
}

// ── capture gear type ───────────────────────────────────────────────────────
// NAM metadata can declare WHAT was captured (`gear_type`: amp · pedal ·
// pedal_amp · amp_cab · amp_pedal_cab · preamp · studio). The rig uses it to
// default the downstream cab/eq stages when a capture is first selected — an
// "amp_cab" capture already has the cabinet baked in, so stacking the cab IR
// on top double-filters the tone. Advisory and optional: it's free text the
// capture's author picked, and GuitarML/AIDA-X files don't carry it at all.
function gearTypeOf(model) {
  const g = model?.metadata?.gear_type;
  return typeof g === 'string' && g.trim() ? g.trim().toLowerCase() : null;
}

/** True when the capture's declared gear type means the cabinet (and usually
 *  the whole downstream chain) is baked into the model — "amp_cab",
 *  "amp_pedal_cab", "studio". Null/unknown gear types return false. */
export function isFullRigGearType(gearType) {
  return !!gearType && (gearType.includes('cab') || gearType === 'studio');
}

function flatten(a, out) {
  if (Array.isArray(a)) { for (let i = 0; i < a.length; i++) flatten(a[i], out); }
  else out.push(a);
  return out;
}
function toF32(a) {
  if (!a) return null;
  if (a instanceof Float32Array) return a;
  return Float32Array.from(flatten(a, []));
}

export function parseAmpModel(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'not a JSON model' };

  // NAM format (has architecture + flat weights). NAM 0.7 wraps the real model
  // in a container architecture, so unwrap before dispatching on the name.
  if (json.architecture || (json.weights && json.config)) {
    const { model, arch: archName, picked } = unwrapContainer(json);
    const arch = archName.toLowerCase();
    if (arch === 'wavenet') {
      const parsed = parseWaveNet(model);
      if (parsed.ok && picked) parsed.container = picked;
      if (parsed.ok) {
        parsed.normTrim = normTrimFor(parsed.loudnessDb);
        parsed.gearType = gearTypeOf(model);
      }
      return parsed;
    }
    if (arch === 'lstm') {
      const parsed = parseNamLstm(model);
      if (parsed.ok) {
        parsed.loudnessDb = Number.isFinite(model?.metadata?.loudness) ? +model.metadata.loudness : null;
        parsed.normTrim = normTrimFor(parsed.loudnessDb);
        parsed.gearType = gearTypeOf(model);
      }
      return parsed;
    }
    return { ok: false, reason: `unsupported NAM architecture: ${archName || '?'}` };
  }

  // GuitarML / RTNeural state_dict.
  const sd = json.state_dict || json;
  if ((sd['rec.weight_ih_l0'] || sd['weight_ih_l0']) && (sd['rec.weight_hh_l0'] || sd['weight_hh_l0'])) {
    return parseStateDict(json, sd);
  }
  return { ok: false, reason: 'unrecognised model (expected GuitarML/RTNeural LSTM or NAM)' };
}

function parseStateDict(json, sd) {
  const md = json.model_data || json;
  const inputSize = md.input_size != null ? (md.input_size | 0) : 1;
  const numLayers = md.num_layers != null ? (md.num_layers | 0) : 1;
  const unit = String(md.unit_type || 'LSTM').toUpperCase();
  if (unit !== 'LSTM') return { ok: false, reason: `${unit} cell not supported yet (LSTM only)` };
  if (inputSize !== 1) return { ok: false, reason: `conditioned models (input_size ${inputSize}) not supported yet` };
  if (numLayers !== 1) return { ok: false, reason: `${numLayers}-layer LSTM not supported yet (single-layer only)` };

  const Wih = toF32(sd['rec.weight_ih_l0'] || sd['weight_ih_l0']);
  const Whh = toF32(sd['rec.weight_hh_l0'] || sd['weight_hh_l0']);
  const bih = toF32(sd['rec.bias_ih_l0'] || sd['bias_ih_l0']);
  const bhh = toF32(sd['rec.bias_hh_l0'] || sd['bias_hh_l0']);
  const Wd  = toF32(sd['lin.weight'] || sd['lin.0.weight']);
  const lb  = toF32(sd['lin.bias'] || sd['lin.0.bias']);
  if (!Wih || !Whh || !Wd) return { ok: false, reason: 'missing LSTM weights' };

  const H = (Wih.length / 4) | 0;
  if (H <= 0 || Whh.length !== 4 * H * H) return { ok: false, reason: 'LSTM weight shape mismatch' };
  if (Wd.length !== H) return { ok: false, reason: 'dense head shape mismatch' };

  const b = new Float32Array(4 * H);
  for (let i = 0; i < 4 * H; i++) b[i] = (bih ? bih[i] : 0) + (bhh ? bhh[i] : 0);
  return { ok: true, type: 'lstm', hidden: H, Wih, Whh, b, Wd, bd: lb ? lb[0] : 0 };
}

// NAM LSTM (experimental): single layer, input_size 1. NAM packs each layer as a
// [4H × (1+H)] weight matrix (row = [Wih_r, Whh_r…]) + [4H] bias, then a dense
// head [H]+[1]. Gate order assumed i,f,g,o. Any extra trailing values (initial
// hidden/cell state) are ignored.
function parseNamLstm(json) {
  const cfg = json.config || {};
  const H = (cfg.hidden_size || 0) | 0;
  const I = cfg.input_size != null ? (cfg.input_size | 0) : 1;
  const nl = cfg.num_layers != null ? (cfg.num_layers | 0) : 1;
  if (H <= 0) return { ok: false, reason: 'NAM LSTM: missing hidden_size' };
  if (I !== 1) return { ok: false, reason: 'NAM LSTM: only input_size 1 supported' };
  if (nl !== 1) return { ok: false, reason: 'NAM LSTM: only single-layer supported (prototype)' };

  const w = toF32(json.weights);
  const need = 4 * H * (1 + H) + 4 * H + H + 1;
  if (!w || w.length < need) return { ok: false, reason: `NAM LSTM weights too short (${w ? w.length : 0} < ${need})` };

  const Wih = new Float32Array(4 * H);
  const Whh = new Float32Array(4 * H * H);
  let p = 0;
  for (let r = 0; r < 4 * H; r++) {
    Wih[r] = w[p++];
    for (let j = 0; j < H; j++) Whh[r * H + j] = w[p++];
  }
  const b = new Float32Array(4 * H);
  for (let r = 0; r < 4 * H; r++) b[r] = w[p++];
  const Wd = new Float32Array(H);
  for (let j = 0; j < H; j++) Wd[j] = w[p++];
  const bd = w[p++] || 0;
  return { ok: true, type: 'lstm', hidden: H, Wih, Whh, b, Wd, bd, experimental: true };
}
