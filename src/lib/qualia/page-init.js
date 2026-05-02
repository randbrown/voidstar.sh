// Page bootstrap for /lab/qualia. Lives outside the .astro file so Astro/Vite
// resolves the ESM imports correctly — inline <script type="module"> in
// .astro pages is served verbatim and would fetch the relative paths against
// the page URL, producing 404s.

import { createMesh }    from './registry.js';
import { createCore }    from './core.js';
import { createAudio }   from './audio.js';
import { createPose }    from './pose.js';
import { wirePicker, getStoredDeviceId, storeDeviceId } from './devices.js';
import { AUDIO_PRESETS, makeSettingsStore } from './presets.js';
import { buildAudioPanel } from './ui.js';
import { createStrudelHydra } from './strudel-hydra.js';
import chladni         from './fx/chladni.js';
import singularityLens from './fx/singularity-lens.js';
import neuralField     from './fx/neural-field.js';

export function initQualiaPage() {
  // ── Registry ──────────────────────────────────────────────────────────────
  const mesh = createMesh();
  mesh.register(chladni);
  mesh.register(singularityLens);
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
  const poseSelect = document.getElementById('pose-source');
  const zenHandle  = document.getElementById('zen-handle');
  const overlay    = document.getElementById('status-overlay');
  const startBtn   = document.getElementById('start-btn');
  const startSilentBtn = document.getElementById('start-silent-btn');
  const audioCard  = document.getElementById('audio-card');
  const videoEl    = document.getElementById('video');
  const fxResetBtn = document.getElementById('btn-fx-reset');
  const host       = document.getElementById('qualia-host');
  const fxParamsEl = document.getElementById('fx-params');

  // ── Core wiring ───────────────────────────────────────────────────────────
  const audio = createAudio();
  const pose  = createPose();

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

  // ── Settings (top-level) ──────────────────────────────────────────────────
  const settings = makeSettingsStore(() => ({
    fxId:          core.activeId(),
    audioTunables: audio.getTunables(),
    poseSource:    poseSelect.value,
    camSizeIdx,
  }));
  const stored = settings.load();
  camSizeIdx = stored.camSizeIdx ?? 0;

  // Populate fx selector from registry.
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

  // ── Card collapse toggles ─────────────────────────────────────────────────
  document.querySelectorAll('[data-toggle]').forEach(h => {
    h.addEventListener('click', (e) => {
      if (e.target.closest('button, input, select')) return;
      const card = document.getElementById(h.dataset.toggle);
      card?.classList.toggle('collapsed');
    });
  });

  // ── Audio toggle (mic) ────────────────────────────────────────────────────
  async function startMic(deviceId) {
    try {
      const id = await audio.start(deviceId);
      if (id) storeDeviceId('mic', id);
      btnAudio.classList.remove('active');
      btnAudio.classList.add('active-audio');
      btnAudio.textContent = 'audio on';
      audioCard.style.display = '';
      audioCard.classList.remove('collapsed');
      micPicker.populate(id);
    } catch (err) {
      alert(`Could not open microphone: ${err.message || err}`);
    }
  }
  async function stopMic() {
    await audio.stop();
    btnAudio.classList.remove('active-audio');
    btnAudio.classList.add('active');
    btnAudio.textContent = 'audio';
    audioCard.style.display = 'none';
  }
  btnAudio.addEventListener('click', () => {
    if (audio.isEnabled() && audio.getCurrentMicId()) stopMic();
    else                                              startMic(getStoredDeviceId('mic'));
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
      camSelect.style.display = 'none';
    } else if (v === 'camera') {
      try {
        const id = await pose.startCamera({ deviceId: getStoredDeviceId('cam'), video: videoEl });
        if (id) storeDeviceId('cam', id);
        btnCamera.style.display = '';
        camPicker.populate(id);
      } catch (err) {
        alert(`Could not open camera: ${err.message || err}`);
        poseSelect.value = 'off';
      }
    }
    settings.save();
  });

  // ── Camera size cycle ─────────────────────────────────────────────────────
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

  // ── Pause / Zen ───────────────────────────────────────────────────────────
  btnPause.addEventListener('click', () => {
    const next = !core.isPaused();
    core.setPaused(next);
    btnPause.classList.toggle('active', next);
    btnPause.textContent = next ? 'paused' : 'pause';
  });

  function setZen(on) {
    core.setZen(on);
    topbarEl.classList.toggle('zen', on);
    zenHandle.classList.toggle('visible', on);
    document.getElementById('hints').style.opacity = on ? '0' : '';
    document.getElementById('panel-stack').style.opacity = on ? '0' : '';
  }
  btnZen.addEventListener('click', () => setZen(!core.isZen()));
  zenHandle.addEventListener('click', () => setZen(false));

  // ── Reset fx params ───────────────────────────────────────────────────────
  fxResetBtn.addEventListener('click', () => core.applyFxPreset('default'));

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
    overlay.classList.add('hidden');
    const initialFx = mesh.get(stored.fxId) ? stored.fxId : mesh.ids()[0];
    try {
      await core.setActive(initialFx);
    } catch (err) {
      console.error('[qualia] initial setActive failed:', err);
      // If the initial fx blew up (e.g. webgl2 unavailable on this GPU),
      // fall back to the first canvas2d fx.
      const fallback = mesh.list().find(m => m.contextType === 'canvas2d');
      if (fallback) await core.setActive(fallback.id);
    }
    core.start();
    if (opts.withMic) {
      await startMic(getStoredDeviceId('mic'));
    }
    if (stored.poseSource && stored.poseSource !== 'off') {
      poseSelect.value = stored.poseSource;
      poseSelect.dispatchEvent(new Event('change'));
    }
  }
  startBtn.addEventListener('click', () => boot({ withMic: true }));
  startSilentBtn.addEventListener('click', () => boot({ withMic: false }));
}
