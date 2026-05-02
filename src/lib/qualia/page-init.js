// Page bootstrap for /lab/qualia. Lives outside the .astro file so Astro/Vite
// resolves the ESM import graph correctly — inline <script type="module"> in
// .astro pages is served verbatim and would 404 on the relative paths.

import { createMesh }    from './registry.js';
import { createCore }    from './core.js';
import { createAudio }   from './audio.js';
import { createPose }    from './pose.js';
import { createOverlay } from './overlay.js';
import { wirePicker, getStoredDeviceId, storeDeviceId } from './devices.js';
import { AUDIO_PRESETS, makeSettingsStore } from './presets.js';
import { buildAudioPanel } from './ui.js';
import { createStrudelHydra } from './strudel-hydra.js';
import { bindVideoElement, getRotation, cycleRotation, getMirror, toggleMirror } from './video.js';
import chladni         from './fx/chladni.js';
import singularityLens from './fx/singularity-lens.js';
import neuralField     from './fx/neural-field.js';
import gargantuaVoid   from './fx/gargantua-void.js';
import voidstarLogo    from './fx/voidstar-logo.js';

const AUTO_CYCLE_SECONDS = 22;
const AUTO_STYLES = ['chapters', 'alternate', 'random', 'hold'];

export function initQualiaPage() {
  // ── Registry ──────────────────────────────────────────────────────────────
  const mesh = createMesh();
  mesh.register(chladni);
  mesh.register(singularityLens);
  mesh.register(gargantuaVoid);
  mesh.register(voidstarLogo);
  mesh.register(neuralField);

  // ── Topbar refs ───────────────────────────────────────────────────────────
  const topbarEl   = document.getElementById('topbar');
  const fpsEl      = document.getElementById('fps');
  const lvlEl      = document.getElementById('lvl');
  const fxnameEl   = document.getElementById('fxname');
  const fxSelect   = document.getElementById('fx-select');
  const micSelect  = document.getElementById('mic-select');
  const camSelect  = document.getElementById('cam-select');
  const btnAudio   = document.getElementById('btn-audio');
  const btnPause   = document.getElementById('btn-pause');
  const btnZen     = document.getElementById('btn-zen');
  const btnCamera  = document.getElementById('btn-camera');
  const btnCamRotate = document.getElementById('btn-cam-rotate');
  const btnCamMirror = document.getElementById('btn-cam-mirror');
  const poseSelect = document.getElementById('pose-source');
  const posesSelect = document.getElementById('pose-max');
  const btnSkel    = document.getElementById('btn-skeleton');
  const btnSparks  = document.getElementById('btn-sparks');
  const btnAura    = document.getElementById('btn-aura');
  const btnRipples = document.getElementById('btn-ripples');
  const btnAscii   = document.getElementById('btn-ascii');
  const btnAuto    = document.getElementById('btn-auto');
  const autoStyleSelect = document.getElementById('auto-style');
  const zenHandle  = document.getElementById('zen-handle');
  const overlayUI  = document.getElementById('status-overlay');
  const startBtn   = document.getElementById('start-btn');
  const startSilentBtn = document.getElementById('start-silent-btn');
  const audioCard  = document.getElementById('audio-card');
  const videoEl    = document.getElementById('video');
  const fxResetBtn = document.getElementById('btn-fx-reset');
  const host       = document.getElementById('qualia-host');
  const fxParamsEl = document.getElementById('fx-params');
  const poseCard   = document.getElementById('pose-card');

  // ── Core wiring ───────────────────────────────────────────────────────────
  const audio = createAudio();
  const pose  = createPose();
  bindVideoElement(videoEl);

  let camSizeIdx = 0;

  const core = createCore({
    host,
    mesh,
    audio,
    pose,
    paramsContainer: fxParamsEl,
    onFxChange: (id) => {
      const mod = mesh.get(id);
      fxnameEl.textContent = mod ? mod.name : '—';
      fxSelect.value = id;
      settings.save();
    },
  });

  // Overlay (skeleton / sparks / aura / ripples / ASCII) — sits ABOVE the
  // fx canvas and runs once per frame after fx render.
  const overlay = createOverlay({
    getMainCanvas: () => core.getCanvas(),
  });
  core.onFrame((field) => {
    overlay.tick(field.dt, field);
    overlay.render(field);
  });

  // ── Settings (top-level) ──────────────────────────────────────────────────
  // Whatever the page-state surface is, it gets serialized here so that a
  // page reload restores the user's exact session. Per-fx params are
  // persisted separately by core.js (per-fx localStorage keys).
  const settings = makeSettingsStore(() => ({
    fxId:           core.activeId(),
    audioTunables:  audio.getTunables(),
    audioOn:        audio.getSource() === 'mic',
    paused:         core.isPaused(),
    zen:            core.isZen(),
    poseSource:     poseSelect.value,
    camSizeIdx,
    cameraRotation: getRotation(),
    mirrorMode:     getMirror(),
    showOverlay:    overlay.getOption('skeleton'),
    sparksOn:       overlay.getOption('sparks'),
    auraOn:         overlay.getOption('aura'),
    ripplesOn:      overlay.getOption('ripples'),
    asciiMode:      overlay.getOption('ascii'),
    autoCycle,
    autoStyle,
    numPoses:       pose.getNumPoses(),
    poseSmoothing:  poseSmoothingValue,
    poseThresh:     pose.getThresholds(),
    poseLingerMs:   pose.getLingerMs(),
    audioCollapsed: audioCard.classList.contains('collapsed'),
    poseCollapsed:  poseCard?.classList.contains('collapsed') ?? true,
    paramsCollapsed: document.getElementById('fx-card')?.classList.contains('collapsed') ?? false,
  }));
  const stored = settings.load();
  camSizeIdx = stored.camSizeIdx ?? 0;

  // ── Restore overlay toggles from settings ────────────────────────────────
  if (typeof stored.showOverlay === 'boolean') overlay.setOption('skeleton', stored.showOverlay);
  if (typeof stored.sparksOn    === 'boolean') overlay.setOption('sparks',   stored.sparksOn);
  if (typeof stored.auraOn      === 'boolean') overlay.setOption('aura',     stored.auraOn);
  if (typeof stored.ripplesOn   === 'boolean') overlay.setOption('ripples',  stored.ripplesOn);
  if (typeof stored.asciiMode   === 'boolean') overlay.setOption('ascii',    stored.asciiMode);

  // ── Pose smoothing + thresholds restore ──────────────────────────────────
  let poseSmoothingValue = 0.5;
  if (typeof stored.poseSmoothing === 'number') {
    poseSmoothingValue = stored.poseSmoothing;
    pose.setSmoothing(poseSmoothingValue);
  }
  if (stored.poseThresh) pose.setThresholds(stored.poseThresh);

  if (typeof stored.numPoses === 'number') pose.setNumPoses(stored.numPoses);

  // ── Populate fx selector ──────────────────────────────────────────────────
  for (const mod of mesh.list()) {
    const opt = document.createElement('option');
    opt.value = mod.id;
    opt.textContent = mod.name;
    fxSelect.appendChild(opt);
  }
  fxSelect.addEventListener('change', () => {
    core.setActive(fxSelect.value).catch(err => console.error('[qualia] setActive failed:', err));
  });

  // ── Audio panel ───────────────────────────────────────────────────────────
  const audioPanel = buildAudioPanel({
    root: audioCard,
    presets: AUDIO_PRESETS,
    onTunablesChange: (delta) => {
      audio.setTunables(delta);
      audioPanel.setActivePreset(null);
      settings.save();
    },
    onPreset: (name) => {
      const p = AUDIO_PRESETS[name];
      if (!p) return;
      audio.setTunables(p);
      audioPanel.setTunables(p);
      audioPanel.setActivePreset(name);
      settings.save();
    },
  });
  if (stored.audioTunables) {
    audio.setTunables(stored.audioTunables);
    audioPanel.setTunables(stored.audioTunables);
  } else {
    audio.setTunables(AUDIO_PRESETS.default);
    audioPanel.setTunables(AUDIO_PRESETS.default);
    audioPanel.setActivePreset('default');
  }

  // ── Pose smoothing slider (lives in audio card under sliders) ────────────
  const smoothInput = document.querySelector('[data-qp="pose-smooth"] input[type=range]');
  const smoothVal   = document.querySelector('[data-qp="pose-smooth"] .qp-val');
  if (smoothInput) {
    smoothInput.value = String(poseSmoothingValue);
    if (smoothVal) smoothVal.textContent = `${Math.round(poseSmoothingValue * 100)}%`;
    smoothInput.addEventListener('input', () => {
      poseSmoothingValue = parseFloat(smoothInput.value);
      pose.setSmoothing(poseSmoothingValue);
      if (smoothVal) smoothVal.textContent = `${Math.round(poseSmoothingValue * 100)}%`;
      settings.save();
    });
  }
  // Pose threshold sliders.
  function wirePoseThresh(id, key) {
    const row = document.querySelector(`[data-qp="${id}"]`);
    if (!row) return;
    const input = row.querySelector('input[type=range]');
    const val   = row.querySelector('.qp-val');
    const initial = pose.getThresholds()[key];
    input.value = String(initial);
    val.textContent = initial.toFixed(2);
    input.addEventListener('input', async () => {
      const v = parseFloat(input.value);
      val.textContent = v.toFixed(2);
      await pose.setThresholds({ [key]: v });
      settings.save();
    });
  }
  wirePoseThresh('pose-detect',   'detect');
  wirePoseThresh('pose-presence', 'presence');
  wirePoseThresh('pose-track',    'track');
  // Linger
  const lingerRow = document.querySelector('[data-qp="pose-linger"]');
  if (lingerRow) {
    const input = lingerRow.querySelector('input[type=range]');
    const val   = lingerRow.querySelector('.qp-val');
    if (typeof stored.poseLingerMs === 'number') {
      input.value = String(stored.poseLingerMs);
      pose.setLingerMs(stored.poseLingerMs);
    }
    val.textContent = `${parseInt(input.value, 10)}ms`;
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10);
      val.textContent = `${v}ms`;
      pose.setLingerMs(v);
      settings.save();
    });
  }

  // ── Card collapse toggles ─────────────────────────────────────────────────
  // Restore prior collapse state. The audio + pose cards default to
  // `collapsed`; the params card defaults to expanded. Only override when
  // a stored value exists so first-time visitors get the curated default.
  if (typeof stored.audioCollapsed === 'boolean') {
    audioCard.classList.toggle('collapsed', stored.audioCollapsed);
  }
  if (poseCard && typeof stored.poseCollapsed === 'boolean') {
    poseCard.classList.toggle('collapsed', stored.poseCollapsed);
  }
  const fxCardEl = document.getElementById('fx-card');
  if (fxCardEl && typeof stored.paramsCollapsed === 'boolean') {
    fxCardEl.classList.toggle('collapsed', stored.paramsCollapsed);
  }
  // Pose card visibility tracks the pose source — only shown when pose is on.
  function syncPoseCardVisibility() {
    if (!poseCard) return;
    const on = poseSelect.value !== 'off';
    poseCard.style.display = on ? '' : 'none';
  }
  syncPoseCardVisibility();
  document.querySelectorAll('[data-toggle]').forEach(h => {
    h.addEventListener('click', (e) => {
      if (e.target.closest('button, input, select')) return;
      const card = document.getElementById(h.dataset.toggle);
      card?.classList.toggle('collapsed');
      settings.save();
    });
  });

  // ── Audio state UI sync ───────────────────────────────────────────────────
  // Single source of truth: audio.onChange fires whenever mic / Strudel / off
  // toggles. Both directions (user clicking btn-audio AND Strudel opening or
  // closing) flow through here, so the topbar button can't drift out of sync.
  audio.onChange(({ source }) => {
    btnAudio.classList.remove('active', 'active-audio');
    if (source === 'mic') {
      btnAudio.classList.add('active-audio');
      btnAudio.textContent = 'audio on';
      audioCard.style.display = '';
    } else if (source === 'strudel') {
      // Strudel button gets the active-audio styling; mic button shows idle.
      btnAudio.textContent = 'audio';
      audioCard.style.display = '';   // keep audio panel visible (Strudel-driven)
    } else {
      btnAudio.textContent = 'audio';
      audioCard.style.display = 'none';
    }
    settings.save();
  });

  // ── Audio toggle (mic) ────────────────────────────────────────────────────
  async function startMic(deviceId) {
    try {
      // Mic + Strudel are mutually exclusive on the analyser. If Strudel is
      // open, close it first so its UI also resets cleanly.
      if (strudel.isOpen()) strudel.close();
      const id = await audio.start(deviceId);
      if (id) storeDeviceId('mic', id);
      micPicker.populate(id);
      // NOTE: we used to auto-uncollapse the audio card here so the user
      // could see the sliders right away. That trampled the persisted
      // collapse state — the user's explicit choice now wins. They can
      // click the panel header to expand if needed.
    } catch (err) {
      alert(`Could not open microphone: ${err.message || err}`);
    }
  }
  async function stopMic() {
    await audio.stop();
  }
  btnAudio.addEventListener('click', () => {
    if (audio.getSource() === 'mic') stopMic();
    else                              startMic(getStoredDeviceId('mic'));
  });

  // ── Mic / cam pickers ─────────────────────────────────────────────────────
  const micPicker = wirePicker({
    select: micSelect,
    kind: 'audioinput',
    getCurrentId: () => audio.getCurrentMicId(),
    onChoose: async (id) => {
      if (audio.isEnabled()) await audio.stop();
      return await audio.start(id);
    },
  });
  const camPicker = wirePicker({
    select: camSelect,
    kind: 'videoinput',
    getCurrentId: () => null,
    onChoose: async (id) => {
      pose.stopCamera();
      return await pose.startCamera({ deviceId: id, video: videoEl });
    },
  });

  // ── Pose source ───────────────────────────────────────────────────────────
  poseSelect.addEventListener('change', async () => {
    const v = poseSelect.value;
    if (v === 'off') {
      pose.stopCamera();
      videoEl.classList.remove('visible');
      btnCamera.style.display = 'none';
      btnCamRotate.style.display = 'none';
      btnCamMirror.style.display = 'none';
      camSelect.style.display = 'none';
      posesSelect.style.display = 'none';
    } else if (v === 'camera') {
      try {
        const id = await pose.startCamera({ deviceId: getStoredDeviceId('cam'), video: videoEl });
        if (id) storeDeviceId('cam', id);
        btnCamera.style.display = '';
        btnCamRotate.style.display = '';
        btnCamMirror.style.display = '';
        posesSelect.style.display = '';
        camPicker.populate(id);
      } catch (err) {
        alert(`Could not open camera: ${err.message || err}`);
        poseSelect.value = 'off';
      }
    }
    syncPoseCardVisibility();
    settings.save();
  });

  // ── Cam size cycle ────────────────────────────────────────────────────────
  const CAM_SIZES = ['small', 'large', 'full', 'hidden'];
  function setCamSize(idx) {
    camSizeIdx = ((idx % CAM_SIZES.length) + CAM_SIZES.length) % CAM_SIZES.length;
    const s = CAM_SIZES[camSizeIdx];
    videoEl.classList.remove('hidden','size-large','size-full');
    if (s === 'hidden') videoEl.classList.add('hidden');
    if (s === 'large')  videoEl.classList.add('size-large');
    if (s === 'full')   videoEl.classList.add('size-full');
    btnCamera.classList.toggle('active', s !== 'hidden');
    btnCamera.textContent = s === 'full' ? 'cam full'
                         : s === 'large' ? 'cam large'
                         : s === 'small' ? 'camera'
                         : 'cam off';
    settings.save();
  }
  btnCamera.addEventListener('click', () => setCamSize(camSizeIdx + 1));
  setCamSize(camSizeIdx);

  // ── Cam rotate / mirror ───────────────────────────────────────────────────
  if (typeof stored.cameraRotation === 'number') {
    // Rotation is restored via setRotation; we cycle by 90° from 0 to match.
    while (getRotation() !== ((stored.cameraRotation % 360) + 360) % 360) {
      cycleRotation();
      if (getRotation() === 0) break; // safety
    }
    btnCamRotate.textContent = `rot ${getRotation()}°`;
    btnCamRotate.classList.toggle('active', getRotation() !== 0);
  }
  if (typeof stored.mirrorMode === 'boolean' && stored.mirrorMode !== getMirror()) {
    toggleMirror();
  }
  btnCamMirror.classList.toggle('active', getMirror());
  btnCamRotate.addEventListener('click', () => {
    const r = cycleRotation();
    btnCamRotate.textContent = `rot ${r}°`;
    btnCamRotate.classList.toggle('active', r !== 0);
    settings.save();
  });
  btnCamMirror.addEventListener('click', () => {
    const m = toggleMirror();
    btnCamMirror.classList.toggle('active', m);
    settings.save();
  });

  // ── Pose count ────────────────────────────────────────────────────────────
  posesSelect.value = String(pose.getNumPoses());
  posesSelect.addEventListener('change', async () => {
    const n = parseInt(posesSelect.value, 10);
    await pose.setNumPoses(n);
    settings.save();
  });

  // ── Overlay toggles (skeleton / sparks / aura / ripples / ASCII) ─────────
  function wireOverlayToggle(btn, key) {
    if (!btn) return;
    btn.classList.toggle('active', overlay.getOption(key));
    btn.addEventListener('click', () => {
      const v = !overlay.getOption(key);
      overlay.setOption(key, v);
      btn.classList.toggle('active', v);
      settings.save();
    });
  }
  wireOverlayToggle(btnSkel,    'skeleton');
  wireOverlayToggle(btnSparks,  'sparks');
  wireOverlayToggle(btnAura,    'aura');
  wireOverlayToggle(btnRipples, 'ripples');
  wireOverlayToggle(btnAscii,   'ascii');

  // ── Pause / Zen ───────────────────────────────────────────────────────────
  function setPaused(on) {
    core.setPaused(on);
    btnPause.classList.toggle('active', on);
    btnPause.textContent = on ? 'paused' : 'pause';
    settings.save();
  }
  btnPause.addEventListener('click', () => setPaused(!core.isPaused()));

  function setZen(on) {
    core.setZen(on);
    topbarEl.classList.toggle('zen', on);
    zenHandle.classList.toggle('visible', on);
    document.getElementById('hints').style.opacity = on ? '0' : '';
    document.getElementById('panel-stack').style.opacity = on ? '0' : '';
    settings.save();
  }
  btnZen.addEventListener('click', () => setZen(!core.isZen()));
  zenHandle.addEventListener('click', () => setZen(false));

  // ── Reset fx params ───────────────────────────────────────────────────────
  fxResetBtn.addEventListener('click', () => core.applyFxPreset('default'));

  // ── Auto-cycle ────────────────────────────────────────────────────────────
  // Cycles through registered fx every AUTO_CYCLE_SECONDS. Within the chladni
  // fx, also cycles its `mode` param so all five wave-field families surface.
  // Other fx don't have multi-mode so they just dwell.
  let autoCycle = !!stored.autoCycle;
  let autoStyle = AUTO_STYLES.includes(stored.autoStyle) ? stored.autoStyle : 'chapters';
  let autoStartMs = 0;
  let autoStepCount = 0;
  let autoTickT = null;
  autoStyleSelect.value = autoStyle;
  btnAuto.classList.toggle('active', autoCycle);
  btnAuto.textContent = autoCycle ? `auto ${AUTO_CYCLE_SECONDS}s` : 'auto';

  // Cycle order: each fx in registry order, AND each chladni mode as its own
  // step (so the auto-cycle visits all the wave-field families).
  function buildAutoSteps() {
    const steps = [];
    for (const mod of mesh.list()) {
      if (mod.id === 'chladni') {
        const modeParam = mod.params.find(p => p.id === 'mode');
        const modes = modeParam?.options ?? ['chladni'];
        for (const m of modes) steps.push({ fxId: 'chladni', chladniMode: m });
      } else {
        steps.push({ fxId: mod.id });
      }
    }
    return steps;
  }
  const autoSteps = buildAutoSteps();

  function autoNext() {
    autoStepCount++;
    const step = autoSteps[autoStepCount % autoSteps.length];
    // ASCII scheduling.
    switch (autoStyle) {
      case 'chapters': {
        // Two-pass chapter structure: pass 0 normal, pass 1 ASCII, repeat.
        const pass = Math.floor(autoStepCount / autoSteps.length) % 2;
        overlay.setOption('ascii', pass === 1);
        btnAscii.classList.toggle('active', pass === 1);
        break;
      }
      case 'alternate':
        overlay.setOption('ascii', !overlay.getOption('ascii'));
        btnAscii.classList.toggle('active', overlay.getOption('ascii'));
        break;
      case 'random':
        overlay.setOption('ascii', Math.random() < 0.3);
        btnAscii.classList.toggle('active', overlay.getOption('ascii'));
        break;
      case 'hold':
      default: break;
    }
    // Move to next fx (or change chladni mode in-place if same fx).
    (async () => {
      if (core.activeId() !== step.fxId) {
        await core.setActive(step.fxId).catch(() => {});
      }
      if (step.fxId === 'chladni' && step.chladniMode) {
        core.setParam('chladni', 'mode', step.chladniMode);
      }
    })();
  }

  function tickAuto() {
    if (!autoCycle) { btnAuto.textContent = 'auto'; return; }
    const elapsed = (performance.now() - autoStartMs) / 1000;
    const remaining = Math.max(0, Math.ceil(AUTO_CYCLE_SECONDS - elapsed));
    btnAuto.textContent = `auto ${remaining}s`;
    if (elapsed >= AUTO_CYCLE_SECONDS) {
      autoStartMs = performance.now();
      autoNext();
    }
  }
  function startAuto() {
    autoCycle = true;
    autoStartMs = performance.now();
    autoStepCount = 0;
    btnAuto.classList.add('active');
    if (autoStyle === 'chapters') { overlay.setOption('ascii', false); btnAscii.classList.remove('active'); }
    if (autoTickT) clearInterval(autoTickT);
    autoTickT = setInterval(tickAuto, 250);
    settings.save();
  }
  function stopAuto() {
    autoCycle = false;
    btnAuto.classList.remove('active');
    btnAuto.textContent = 'auto';
    if (autoTickT) { clearInterval(autoTickT); autoTickT = null; }
    settings.save();
  }
  btnAuto.addEventListener('click', () => autoCycle ? stopAuto() : startAuto());
  autoStyleSelect.addEventListener('change', () => {
    autoStyle = autoStyleSelect.value;
    autoStepCount = 0;
    if (autoCycle && autoStyle === 'chapters') {
      overlay.setOption('ascii', false); btnAscii.classList.remove('active');
    }
    settings.save();
  });

  // ── Strudel + Hydra ───────────────────────────────────────────────────────
  const strudel = createStrudelHydra({
    audio,
    getField: () => core.field,
    setParam: (fxId, paramId, value) => core.setParam(fxId, paramId, value),
    scopeCanvas: document.getElementById('test-canvas'),
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea, [contenteditable]')) return;
    if (strudel.isOpen() && document.activeElement?.closest('#strudel-panel')) return;

    switch (e.key.toLowerCase()) {
      case 'v': {
        const ids = mesh.ids();
        const i = ids.indexOf(core.activeId() || ids[0]);
        core.setActive(ids[(i + 1) % ids.length]);
        break;
      }
      case 'm': btnAudio.click(); break;
      case 'd': document.getElementById('btn-strudel').click(); break;
      case 'p': {
        const opts = ['off','camera'];
        const i = opts.indexOf(poseSelect.value);
        poseSelect.value = opts[(i + 1) % opts.length];
        poseSelect.dispatchEvent(new Event('change'));
        break;
      }
      case 'c': if (btnCamera.style.display !== 'none') btnCamera.click(); break;
      case 'o': case '0': if (btnCamRotate.style.display !== 'none') btnCamRotate.click(); break;
      case 'i': if (btnCamMirror.style.display !== 'none') btnCamMirror.click(); break;
      case 'j': btnSkel.click(); break;
      case 'f': btnSparks.click(); break;
      case 'a': btnAura.click(); break;
      case 'b': btnRipples.click(); break;
      case 'x': btnAscii.click(); break;
      case 'l': btnAuto.click(); break;
      case 'z': setZen(!core.isZen()); break;
      case ' ': btnPause.click(); e.preventDefault(); break;
    }
  });

  // ── FPS / level HUD ───────────────────────────────────────────────────────
  core.onFps((fps, field) => {
    fpsEl.textContent = `${fps} fps`;
    if (audio.isEnabled()) {
      const fmt = v => Math.round(v * 99).toString().padStart(2, '0');
      lvlEl.textContent = `b${fmt(field.audio.bands.bass)} m${fmt(field.audio.bands.mids)} h${fmt(field.audio.bands.highs)}`;
    } else {
      lvlEl.textContent = 'audio off';
    }
    strudel.perFrame();
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  async function boot(opts = {}) {
    overlayUI.classList.add('hidden');
    const initialFx = mesh.get(stored.fxId) ? stored.fxId : mesh.ids()[0];
    try {
      await core.setActive(initialFx);
    } catch (err) {
      console.error('[qualia] initial setActive failed:', err);
      const fallback = mesh.list().find(m => m.contextType === 'canvas2d');
      if (fallback) await core.setActive(fallback.id);
    }
    core.start();

    // Restore audio source. `withMic` (from the explicit "enable mic" button)
    // or stored.audioOn (last session had mic on) both trigger startMic. The
    // browser's previously-granted mic permission means this resumes silently.
    if (opts.withMic || stored.audioOn) {
      await startMic(getStoredDeviceId('mic'));
    }
    if (stored.poseSource && stored.poseSource !== 'off') {
      poseSelect.value = stored.poseSource;
      poseSelect.dispatchEvent(new Event('change'));
    }
    if (stored.paused) setPaused(true);
    if (stored.zen)    setZen(true);
    if (autoCycle)     startAuto();
  }
  startBtn.addEventListener('click', () => boot({ withMic: true }));
  startSilentBtn.addEventListener('click', () => boot({ withMic: false }));
}
