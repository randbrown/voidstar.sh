// Vocal harmonizer for the qualia vocoder — turns the vocoder's mono carrier
// into a chord so the voice modulates the whole stack at once: the "robot
// choir" (Imogen Heap, "Hide and Seek") effect.
//
// The harmonizer owns no audio nodes. It only decides WHICH notes the carrier
// should sound and fires onChange; the vocoder reads getChord()/isEnabled()
// and retunes (or rebuilds) its carrier voice pool to match. Because the
// pitch is synthetic the chord is always perfectly in tune — autotune for
// free, no pitch-shifting artifacts.
//
// Chord source modes:
//   picker — root note + chord quality → a held chord.
//   keys   — a one-octave tappable key strip; toggled notes form the chord.
//   track  — Prismizer / extreme-auto-tune: the vocoder's pitch tracker feeds
//            the detected vocal fundamental through updatePitch(); it snaps to
//            the chosen key and the harmony voicing follows the lead, the
//            intervals shifting per scale degree to stay in the key signature.

const NS         = 'voidstar.qualia.harmonizer';
const CONFIG_KEY = `${NS}.config`;
// Carrier voice-pool ceiling in the vocoder — keep in sync with CARRIER_POOL
// in vocoder.js. Chords are capped here so the vocoder never runs short.
const MAX_NOTES  = 6;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

// Chord qualities (picker mode) — semitone intervals above the root.
const QUALITIES = {
  power: { label: 'power (5th)', iv: [0, 7] },
  oct:   { label: 'octaves',     iv: [0, 12] },
  maj:   { label: 'major',       iv: [0, 4, 7] },
  min:   { label: 'minor',       iv: [0, 3, 7] },
  sus2:  { label: 'sus2',        iv: [0, 2, 7] },
  sus4:  { label: 'sus4',        iv: [0, 5, 7] },
  maj7:  { label: 'maj7',        iv: [0, 4, 7, 11] },
  min7:  { label: 'min7',        iv: [0, 3, 7, 10] },
  dom7:  { label: 'dom7',        iv: [0, 4, 7, 10] },
  add9:  { label: 'add9',        iv: [0, 4, 7, 14] },
};

// Scales (track mode) — semitone offsets from the key root. Tracked voices
// snap to these so the harmony always sits in the key signature.
const SCALES = {
  major:    { label: 'major',            pc: [0, 2, 4, 5, 7, 9, 11] },
  minor:    { label: 'minor',            pc: [0, 2, 3, 5, 7, 8, 10] },
  dorian:   { label: 'dorian',           pc: [0, 2, 3, 5, 7, 9, 10] },
  mixo:     { label: 'mixolydian',       pc: [0, 2, 4, 5, 7, 9, 10] },
  harmMin:  { label: 'harmonic minor',   pc: [0, 2, 3, 5, 7, 8, 11] },
  pentMaj:  { label: 'major pentatonic', pc: [0, 2, 4, 7, 9] },
  pentMin:  { label: 'minor pentatonic', pc: [0, 3, 5, 7, 10] },
  chromatic:{ label: 'chromatic',        pc: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

// Track-mode harmony voicings — scale-DEGREE offsets from the tracked lead
// (0 = the lead itself). Because they are degree offsets, the actual semitone
// interval shifts per scale degree, so the stack always stays diatonic — the
// Prismizer "in-key auto-tune choir" effect.
const VOICINGS = {
  solo:    { label: 'solo (lead only)', deg: [0] },
  third:   { label: 'lead + 3rd',       deg: [0, 2] },
  triad:   { label: 'triad',            deg: [0, 2, 4] },
  seventh: { label: 'seventh',          deg: [0, 2, 4, 6] },
  cluster: { label: 'cluster',          deg: [0, 1, 2, 3] },
  stack:   { label: 'stack (to 9th)',   deg: [0, 2, 4, 6, 8] },
};

const DEFAULT_CONFIG = {
  enabled: false,
  engine:  'synth',        // 'synth' = drive vocoder carrier · 'voice' = pitch-shift the voice
  mode:    'picker',       // 'picker' | 'keys' | 'track'
  root:    48,             // MIDI note for picker mode (C3)
  quality: 'maj',
  octave:  4,              // octave shown on the key strip
  keys:    [60, 64, 67],   // toggled MIDI notes for keys mode (C major triad)
  key:     0,              // track-mode key root, pitch class 0..11 (0 = C)
  scale:   'major',        // track-mode scale
  voicing: 'triad',        // track-mode harmony voicing
  tune:    false,          // voice engine — autotune the lead to the nearest scale note
  formant: 0,              // voice engine — formant shift in semitones (−12..+12)
};

// MIDI note → name+octave (MIDI 60 = C4).
function midiName(n) {
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}
// Frequency → (fractional) MIDI note number. A4 = 69 = 440 Hz.
function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const p = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG, ...p,
      keys: Array.isArray(p.keys) ? p.keys.slice(0, MAX_NOTES) : [...DEFAULT_CONFIG.keys],
    };
  } catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch {}
}

export function createHarmonizer() {
  const cfg = loadConfig();

  // Track-mode runtime state (not persisted): the chord currently voiced
  // around the detected pitch, plus the committed lead note used for the
  // boundary hysteresis in updatePitch().
  let trackedChord  = [];
  let committedLead = null;

  // ── DOM refs (all inside #vocoder-panel) ───────────────────────────────
  const elSection = document.getElementById('harm-section');
  const btnEnable = document.getElementById('btn-harm');
  const elEngine  = document.getElementById('harm-engine');
  const btnTune   = document.getElementById('btn-harm-tune');
  const elMode    = document.getElementById('harm-mode');
  const elChord   = document.getElementById('harm-chord');
  const elPicker  = document.getElementById('harm-picker');
  const elRoot    = document.getElementById('harm-root');
  const elQuality = document.getElementById('harm-quality');
  const elKeysRow = document.getElementById('harm-keys-row');
  const elKeys    = document.getElementById('harm-keys');
  const elOctLbl  = document.getElementById('harm-oct-label');
  const btnOctDn  = document.getElementById('harm-oct-down');
  const btnOctUp  = document.getElementById('harm-oct-up');
  const elTrack   = document.getElementById('harm-track');
  const elKey     = document.getElementById('harm-key');
  const elScale   = document.getElementById('harm-scale');
  const elVoicing = document.getElementById('harm-voicing');
  const elFormantRow = document.getElementById('harm-formant-row');
  const elFormant    = document.getElementById('harm-formant');
  const elFormantVal = document.getElementById('harm-formant-val');

  // ── Change subscription — the vocoder listens to retune its carrier ────
  const changeListeners = new Set();
  function onChange(cb) { changeListeners.add(cb); return () => changeListeners.delete(cb); }
  function notify() { changeListeners.forEach(fn => { try { fn(); } catch {} }); }

  let saveT = null;
  function persistSoon() {
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(() => { saveConfig(cfg); saveT = null; }, 400);
  }

  // ── Chord computation ──────────────────────────────────────────────────
  // The current chord as sorted, de-duped MIDI notes, capped to the pool.
  function getChord() {
    if (cfg.mode === 'track') return [...trackedChord];
    let notes;
    if (cfg.mode === 'keys') {
      notes = [...cfg.keys];
    } else {
      const iv = (QUALITIES[cfg.quality] || QUALITIES.maj).iv;
      notes = iv.map(i => cfg.root + i);
    }
    return [...new Set(notes)].sort((a, b) => a - b).slice(0, MAX_NOTES);
  }

  // Semitone shifts for the "voice" engine — how far to pitch-shift the live
  // voice for each chord tone, relative to the tracked lead. A shift of ~0 is
  // the dry lead itself (the vocoder leaves it unshifted for intelligibility).
  function getShifts() {
    if (committedLead == null) return [];
    return getChord().map(n => n - committedLead);
  }

  // ── Track mode: scale snapping + diatonic voicing ──────────────────────
  function scalePC() { return (SCALES[cfg.scale] || SCALES.major).pc; }

  function inScale(midi) {
    const pc = (((midi - cfg.key) % 12) + 12) % 12;
    return scalePC().includes(pc);
  }
  // Snap a (possibly fractional) MIDI note to the nearest in-key note —
  // nearest to the FLOAT m, so a pitch sitting 0.8 semitones above a scale
  // note doesn't over-shoot to the next one.
  function snapToScale(m) {
    const c = Math.round(m);
    let bestN = c, bestD = Infinity;
    for (let n = c - 7; n <= c + 7; n++) {
      if (!inScale(n)) continue;
      const d = Math.abs(n - m);
      if (d < bestD) { bestD = d; bestN = n; }
    }
    return bestN;
  }
  // Absolute scale-degree index of an in-key MIDI note, and its inverse.
  function noteToDegree(n) {
    const S = scalePC(), D = S.length;
    const rel = n - cfg.key;
    const oct = Math.floor(rel / 12);
    const pc  = ((rel % 12) + 12) % 12;
    let idx = S.indexOf(pc);
    if (idx < 0) idx = 0;
    return oct * D + idx;
  }
  function degreeToNote(g) {
    const S = scalePC(), D = S.length;
    const oct = Math.floor(g / D);
    const idx = ((g % D) + D) % D;
    return cfg.key + oct * 12 + S[idx];
  }
  // The chord voiced around a tracked lead note — the voicing's degree
  // offsets stacked on the lead's scale degree.
  function voiceLead(lead) {
    const dL  = noteToDegree(lead);
    const deg = (VOICINGS[cfg.voicing] || VOICINGS.triad).deg;
    const notes = deg.map(o => degreeToNote(dL + o));
    return [...new Set(notes)].sort((a, b) => a - b).slice(0, MAX_NOTES);
  }
  // Feed a detected fundamental (Hz) from the vocoder's pitch tracker. Snaps
  // to the key, applies boundary hysteresis, and rebuilds the tracked chord
  // when the lead note actually changes. Returns true when the chord moved.
  function updatePitch(hz) {
    if (!(hz > 0)) return false;
    const m = hzToMidi(hz);
    if (m < 28 || m > 96) return false;          // outside a plausible voice
    const lead = snapToScale(m);
    if (lead === committedLead) return false;
    if (committedLead != null) {
      // Hysteresis — switch only when the new note is clearly closer than
      // holding the current one, so a wobble at a scale boundary doesn't
      // flutter the chord. Unlike a multi-frame debounce this adds no
      // latency: a decisive move commits on the very next frame.
      if (Math.abs(m - lead) + 0.3 > Math.abs(m - committedLead)) return false;
    }
    committedLead = lead;
    trackedChord = voiceLead(lead);
    paintChordReadout();
    return true;
  }

  // ── UI paint ───────────────────────────────────────────────────────────
  function paintChordReadout() {
    if (!elChord) return;
    if (cfg.mode === 'track') {
      elChord.textContent = trackedChord.length
        ? trackedChord.map(midiName).join(' ')
        : `${NOTE_NAMES[cfg.key]} ${SCALES[cfg.scale]?.label || ''} · sing…`;
      return;
    }
    const notes = getChord();
    elChord.textContent = notes.length ? notes.map(midiName).join(' ') : '— no notes —';
  }
  function paintMode() {
    if (elPicker)  elPicker.style.display  = cfg.mode === 'picker' ? '' : 'none';
    if (elKeysRow) elKeysRow.style.display = cfg.mode === 'keys'   ? '' : 'none';
    if (elTrack)   elTrack.style.display   = cfg.mode === 'track'  ? '' : 'none';
  }
  function paintEnable() {
    if (btnEnable) {
      btnEnable.classList.toggle('active', cfg.enabled);
      btnEnable.textContent = cfg.enabled ? 'on' : 'off';
    }
    if (elSection) elSection.classList.toggle('harm-disabled', !cfg.enabled);
  }
  function paintTune() {
    const voice = cfg.engine === 'voice';
    if (btnTune) {
      btnTune.classList.toggle('active', cfg.tune);
      // Autotune + formant only apply to the voice engine — hide for synth.
      btnTune.style.display = voice ? '' : 'none';
    }
    if (elFormantRow) elFormantRow.style.display = voice ? '' : 'none';
    if (elFormantVal) {
      elFormantVal.textContent = (cfg.formant > 0 ? '+' : '') + cfg.formant + ' st';
    }
  }
  function paintKeys() {
    if (!elKeys) return;
    const active = new Set(cfg.keys);
    elKeys.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('on', active.has(+btn.dataset.note));
    });
    if (elOctLbl) elOctLbl.textContent = 'C' + cfg.octave;
  }

  // Build the 13-button strip (one octave, C..C) for the current octave.
  // Notes are absolute MIDI numbers, so a toggle survives octave shifts.
  function buildKeyStrip() {
    if (!elKeys) return;
    elKeys.innerHTML = '';
    const base = (cfg.octave + 1) * 12;   // MIDI C of cfg.octave
    for (let s = 0; s <= 12; s++) {
      const n = base + s;
      const btn = document.createElement('button');
      btn.className = 'harm-key' + (BLACK_KEYS.has(s % 12) ? ' blk' : '');
      btn.dataset.note = String(n);
      btn.textContent = NOTE_NAMES[s % 12];
      btn.title = midiName(n);
      btn.addEventListener('click', () => toggleKey(n));
      elKeys.appendChild(btn);
    }
    paintKeys();
  }

  function syncControls() {
    if (elEngine)  elEngine.value  = cfg.engine;
    if (elMode)    elMode.value    = cfg.mode;
    if (elRoot)    elRoot.value    = String(cfg.root);
    if (elQuality) elQuality.value = cfg.quality;
    if (elKey)     elKey.value     = String(cfg.key);
    if (elScale)   elScale.value   = cfg.scale;
    if (elVoicing) elVoicing.value = cfg.voicing;
    if (elFormant) elFormant.value = String(cfg.formant);
    paintEnable(); paintTune(); paintMode(); paintChordReadout();
  }

  // ── Mutators ───────────────────────────────────────────────────────────
  function setEnabled(on) {
    cfg.enabled = !!on;
    committedLead = null;
    persistSoon();
    paintEnable();
    notify();
  }
  function setMode(m) {
    if (m !== 'picker' && m !== 'keys' && m !== 'track') return;
    cfg.mode = m;
    committedLead = null;        // re-detect fresh when (re-)entering track
    persistSoon();
    paintMode(); paintChordReadout();
    notify();
  }
  function setEngine(e) {
    if (e !== 'synth' && e !== 'voice') return;
    cfg.engine = e;
    committedLead = null;
    persistSoon();
    paintTune();
    notify();
  }
  function setTune(on) {
    cfg.tune = !!on;
    persistSoon();
    paintTune();
    notify();
  }
  function setFormant(st) {
    cfg.formant = Math.max(-12, Math.min(12, +st | 0));
    persistSoon();
    paintTune();
    // Formant is a voice-engine control — no need to wake the synth carrier.
    if (cfg.engine === 'voice') notify();
  }
  function setRoot(n) {
    cfg.root = Math.max(24, Math.min(96, +n | 0));
    persistSoon();
    paintChordReadout();
    if (cfg.mode === 'picker') notify();
  }
  function setQuality(q) {
    if (!QUALITIES[q]) return;
    cfg.quality = q;
    persistSoon();
    paintChordReadout();
    if (cfg.mode === 'picker') notify();
  }
  function setKey(pc) {
    cfg.key = (((+pc | 0) % 12) + 12) % 12;
    committedLead = null;        // re-snap to the new key
    persistSoon();
    paintChordReadout();
    if (cfg.mode === 'track') notify();
  }
  function setScale(s) {
    if (!SCALES[s]) return;
    cfg.scale = s;
    committedLead = null;
    persistSoon();
    paintChordReadout();
    if (cfg.mode === 'track') notify();
  }
  function setVoicing(v) {
    if (!VOICINGS[v]) return;
    cfg.voicing = v;
    committedLead = null;
    persistSoon();
    paintChordReadout();
    if (cfg.mode === 'track') notify();
  }
  function toggleKey(n) {
    const i = cfg.keys.indexOf(n);
    if (i >= 0) {
      cfg.keys.splice(i, 1);
    } else {
      if (cfg.keys.length >= MAX_NOTES) return;   // carrier pool is full
      cfg.keys.push(n);
    }
    persistSoon();
    paintKeys(); paintChordReadout();
    if (cfg.mode === 'keys') notify();
  }
  function shiftOctave(d) {
    cfg.octave = Math.max(1, Math.min(7, cfg.octave + d));
    persistSoon();
    buildKeyStrip();
  }

  // ── Wire UI ────────────────────────────────────────────────────────────
  if (btnEnable) btnEnable.addEventListener('click', () => setEnabled(!cfg.enabled));
  if (elEngine)  elEngine.addEventListener('change', () => setEngine(elEngine.value));
  if (btnTune)   btnTune.addEventListener('click', () => setTune(!cfg.tune));
  if (elFormant) elFormant.addEventListener('input', () => setFormant(elFormant.value));
  if (elMode)    elMode.addEventListener('change', () => setMode(elMode.value));
  if (elRoot) {
    for (let n = 36; n <= 72; n++) {
      const o = document.createElement('option');
      o.value = String(n); o.textContent = midiName(n);
      elRoot.appendChild(o);
    }
    elRoot.addEventListener('change', () => setRoot(elRoot.value));
  }
  if (elQuality) {
    for (const [k, v] of Object.entries(QUALITIES)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = v.label;
      elQuality.appendChild(o);
    }
    elQuality.addEventListener('change', () => setQuality(elQuality.value));
  }
  if (elKey) {
    NOTE_NAMES.forEach((nm, pc) => {
      const o = document.createElement('option');
      o.value = String(pc); o.textContent = nm;
      elKey.appendChild(o);
    });
    elKey.addEventListener('change', () => setKey(elKey.value));
  }
  if (elScale) {
    for (const [k, v] of Object.entries(SCALES)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = v.label;
      elScale.appendChild(o);
    }
    elScale.addEventListener('change', () => setScale(elScale.value));
  }
  if (elVoicing) {
    for (const [k, v] of Object.entries(VOICINGS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = v.label;
      elVoicing.appendChild(o);
    }
    elVoicing.addEventListener('change', () => setVoicing(elVoicing.value));
  }
  if (btnOctDn) btnOctDn.addEventListener('click', () => shiftOctave(-1));
  if (btnOctUp) btnOctUp.addEventListener('click', () => shiftOctave(1));

  buildKeyStrip();
  syncControls();

  return {
    onChange,
    isEnabled: () => cfg.enabled,
    isTuned:   () => cfg.tune,
    getMode:   () => cfg.mode,
    getEngine: () => cfg.engine,
    getFormant: () => cfg.formant,
    getChord,
    getShifts,
    updatePitch,
    setEnabled,
    // Snapshot/restore for the qualem state system — folded into the
    // vocoder's own config blob by createVocoder.
    getConfig: () => ({ ...cfg, keys: [...cfg.keys] }),
    setConfig(partial) {
      if (!partial || typeof partial !== 'object') return;
      if (typeof partial.enabled === 'boolean') cfg.enabled = partial.enabled;
      if (partial.engine === 'synth' || partial.engine === 'voice') cfg.engine = partial.engine;
      if (partial.mode === 'picker' || partial.mode === 'keys' || partial.mode === 'track') {
        cfg.mode = partial.mode;
      }
      if (typeof partial.root === 'number') cfg.root = Math.max(24, Math.min(96, partial.root | 0));
      if (typeof partial.quality === 'string' && QUALITIES[partial.quality]) cfg.quality = partial.quality;
      if (typeof partial.octave === 'number') cfg.octave = Math.max(1, Math.min(7, partial.octave | 0));
      if (Array.isArray(partial.keys)) {
        cfg.keys = partial.keys.filter(n => Number.isFinite(n)).slice(0, MAX_NOTES);
      }
      if (typeof partial.key === 'number') cfg.key = (((partial.key | 0) % 12) + 12) % 12;
      if (typeof partial.scale === 'string' && SCALES[partial.scale]) cfg.scale = partial.scale;
      if (typeof partial.voicing === 'string' && VOICINGS[partial.voicing]) cfg.voicing = partial.voicing;
      if (typeof partial.tune === 'boolean') cfg.tune = partial.tune;
      if (typeof partial.formant === 'number') {
        cfg.formant = Math.max(-12, Math.min(12, partial.formant | 0));
      }
      committedLead = null;
      persistSoon();
      buildKeyStrip();
      syncControls();
      notify();
    },
  };
}
