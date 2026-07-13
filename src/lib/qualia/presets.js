// localStorage persistence — namespaced per-fx so switching fx doesn't lose
// state. AUDIO_PRESETS is shared across fx (it tunes the audio pipeline,
// not any specific visual).

// Tunables: gain (linear scale 0.25–4×), ema (band response 0.05–0.60),
// thresh (multiplicative beat ratio 1.10–2.50), cooldown (ms 80–1000).
export const AUDIO_PRESETS = {
  default:  { gain: 1.0, ema: 0.30, thresh: 1.30, cooldown: 500 },
  ambient:  { gain: 1.0, ema: 0.18, thresh: 1.22, cooldown: 420 },
  acoustic: { gain: 1.0, ema: 0.20, thresh: 1.20, cooldown: 460 },
  edm:      { gain: 1.0, ema: 0.34, thresh: 1.32, cooldown: 240 },
  metal:    { gain: 1.0, ema: 0.45, thresh: 1.55, cooldown: 110 },
};
export const AUDIO_PRESET_NAMES = Object.keys(AUDIO_PRESETS);

const NS = 'voidstar.qualia';
const SETTINGS_KEY = `${NS}.settings`;

let _saveTimer = null;

/**
 * Debounced top-level settings save. Pass a getter so we always serialise
 * the latest state, not a stale snapshot from when saveSettings was wired up.
 */
export function makeSettingsStore(getState) {
  function save() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(getState())); } catch {}
    }, 200);
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch { return {}; }
  }
  return { save, load };
}

// Per-fx param values. The active fx's param schema dictates which keys are
// stored; we just round-trip a {fxId: {paramId: value}} map.
function fxParamsKey(fxId) { return `${NS}.fx.${fxId}.params`; }

export function loadFxParams(fxId) {
  try { return JSON.parse(localStorage.getItem(fxParamsKey(fxId))) || null; }
  catch { return null; }
}
export function saveFxParams(fxId, params) {
  try { localStorage.setItem(fxParamsKey(fxId), JSON.stringify(params)); } catch {}
}

// Debounced param save for the HOT path. `core.setParam` (the Strudel/MIDI
// live-coding hook) and every panel `input` event used to do a synchronous
// JSON.stringify + localStorage.setItem PER call — a CC knob ride or a pattern
// driving qualia.setParam (~50–100 msg/s) landed a blocking storage write per
// message on the main thread, exactly the jank that starves the Strudel
// cyclist. Coalesce to one write ~250 ms after the last change; flush on fx
// swap / page hide so nothing is lost.
let _fxSaveTimer = null;
let _fxSavePending = null; // { fxId, params } — latest only
export function saveFxParamsDebounced(fxId, params) {
  _fxSavePending = { fxId, params };
  if (_fxSaveTimer) return;
  _fxSaveTimer = setTimeout(() => {
    _fxSaveTimer = null;
    const p = _fxSavePending; _fxSavePending = null;
    if (p) saveFxParams(p.fxId, p.params);
  }, 250);
}
export function flushFxParams() {
  if (_fxSaveTimer) { clearTimeout(_fxSaveTimer); _fxSaveTimer = null; }
  const p = _fxSavePending; _fxSavePending = null;
  if (p) saveFxParams(p.fxId, p.params);
}

// Per-fx modulator weights. Flat dict keyed by `${paramId}.${modIdx}` so
// merging persisted overrides with current spec is trivial — extra/missing
// keys (e.g. fx schema changed since last save) are tolerated.
function fxModWeightsKey(fxId) { return `${NS}.fx.${fxId}.modweights`; }

export function loadFxModWeights(fxId) {
  try { return JSON.parse(localStorage.getItem(fxModWeightsKey(fxId))) || null; }
  catch { return null; }
}
export function saveFxModWeights(fxId, weights) {
  try { localStorage.setItem(fxModWeightsKey(fxId), JSON.stringify(weights)); } catch {}
}

// Per-fx user-saved presets (named param snapshots). Distinct from
// fx.presets baked into the module — those are factory; these are the
// user's "save my current sliders as 'live-set-1'" workflow.
function fxUserPresetsKey(fxId) { return `${NS}.fx.${fxId}.presets`; }

export function loadFxUserPresets(fxId) {
  try { return JSON.parse(localStorage.getItem(fxUserPresetsKey(fxId))) || {}; }
  catch { return {}; }
}
export function saveFxUserPreset(fxId, name, params) {
  const all = loadFxUserPresets(fxId);
  all[name] = params;
  try { localStorage.setItem(fxUserPresetsKey(fxId), JSON.stringify(all)); } catch {}
}
