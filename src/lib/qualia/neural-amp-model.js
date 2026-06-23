// Neural amp model parser — normalises a loaded capture file into the flat
// typed-array form the neural-amp worklet expects:
//   { ok, type:'lstm', hidden, Wih, Whh, b, Wd, bd }   (single-layer LSTM, input 1)
// or { ok:false, reason }.
//
// Supported now (realtime-feasible in pure JS):
//   - GuitarML / RTNeural state_dict JSON (Proteus, NeuralPi) — rec.* / lin.*
//   - AIDA-X-style single-LSTM JSON (same state_dict shape)
//   - NAM .nam with architecture "LSTM" (experimental — single layer, input 1)
// Not supported here (needs a WASM backend):
//   - NAM "WaveNet" (the standard NAM architecture)
//   - conditioned (input_size > 1) or multi-layer models

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

  // NAM format (has architecture + flat weights).
  if (json.architecture || (json.weights && json.config)) {
    const arch = String(json.architecture || '').toLowerCase();
    if (arch === 'wavenet') return { ok: false, reason: 'NAM WaveNet needs the WASM core (not bundled yet) — load a GuitarML/AIDA-X LSTM capture instead' };
    if (arch === 'lstm') return parseNamLstm(json);
    return { ok: false, reason: `unsupported NAM architecture: ${json.architecture || '?'}` };
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
