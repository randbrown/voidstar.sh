// localStorage persistence — namespaced per-fx so switching fx doesn't lose
// state. AUDIO_PRESETS is shared across fx (it tunes the audio pipeline,
// not any specific visual).

export const AUDIO_PRESETS = {
  default:  { gain: 1.0, ema: 0.14, thresh: 1.40, cooldown: 320 },
  ambient:  { gain: 1.0, ema: 0.10, thresh: 1.28, cooldown: 420 },
  acoustic: { gain: 1.0, ema: 0.09, thresh: 1.25, cooldown: 550 },
  edm:      { gain: 1.0, ema: 0.15, thresh: 1.38, cooldown: 360 },
  metal:    { gain: 1.0, ema: 0.30, thresh: 1.80, cooldown: 110 },
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
