// Page bootstrap for /lab/qualia. Lives outside the .astro file so Astro/Vite
// resolves the ESM import graph correctly — inline <script type="module"> in
// .astro pages is served verbatim and would 404 on the relative paths.

import { createMesh }    from './registry.js';
import { createCore }    from './core.js';
import { createAudio }   from './audio.js';
import { createPose }    from './pose.js';
import { createOverlay } from './overlay.js';
import { wirePicker, getStoredDeviceId, storeDeviceId } from './devices.js';
import {
  AUDIO_PRESETS, makeSettingsStore,
  loadFxParams, saveFxParams, loadFxModWeights, saveFxModWeights,
} from './presets.js';
import * as qualem from './qualem.js';
import { parseMetadata as parseStrudelMeta, setMetadata as setStrudelMeta } from './patterns.js';
import { buildAudioPanel } from './ui.js';
import { createStrudelHydra } from './strudel-hydra.js';
import { createSequencer } from './sequencer.js';
import { createVocoder } from './vocoder.js';
import { createCursorFx } from './cursor-fx.js';
import { createRecorder } from './recorder.js';
import { loadExcluded as loadCycleExcluded, saveExcluded as saveCycleExcluded, isInCycle } from './cycle-pool.js';
import { bindVideoElement, getRotation, setRotation, cycleRotation, getMirror, setMirror, toggleMirror } from './video.js';
import chladni         from './fx/chladni.js';
import singularityLens from './fx/singularity-lens.js';
import neuralField     from './fx/neural-field.js';
import gargantuaVoid   from './fx/gargantua-void.js';
import voidstarLogo    from './fx/voidstar-logo.js';
import fractal         from './fx/fractal.js';
import spectrum        from './fx/spectrum.js';
import vintageAnalog   from './fx/vintage-analog.js';
import synthwave       from './fx/synthwave.js';
import telemetry       from './fx/telemetry.js';
import camera          from './fx/camera.js';
import darkSpace       from './fx/dark-space.js';
import code            from './fx/code.js';
import anomaly         from './fx/anomaly.js';
import atomicOrbital   from './fx/atomic-orbital.js';
import galaxy          from './fx/galaxy.js';
import antireductionism from './fx/antireductionism.js';
import detector       from './fx/detector.js';
import ghostMachine   from './fx/ghost-machine.js';

// Auto-phase: walks modes/presets WITHIN the active qfx (one quale's
// internal phases — palettes, modes, etc.). The qfx declares the steps via
// QFXModule.autoPhase.steps; the topbar `phase` button drives them. Each
// click advances through PHASE_PERIODS (0 = off).
const PHASE_PERIODS = [0, 5, 10, 15];          // seconds
const AUTO_PHASE_STYLES = ['chapters', 'alternate', 'random', 'hold'];
// Auto-cycle: swaps the active qfx ITSELF on a longer timer. Independent of
// auto-phase — the two can run together (a single qfx phases through its
// modes, then cycle picks the next quale and the new one starts phasing).
const CYCLE_PERIODS = [0, 5, 15, 30, 45];       // seconds
const AUTO_CYCLE_STYLES = ['sequential', 'random'];
// "Glitch" post-process modes (shared by ascii / mosh / edge). The button
// cycles through these:
//   off:  glitch disabled (always)
//   on:   glitch enabled (always); also: included in auto-phase roster
//   blip: brief flash on hard kicks, auto-clears after BLIP_DURATION_MS
//   flip: toggles glitch state on each hard kick (persists between hits)
// blip + flip stay reactive regardless of auto-phase rotation; only the
// 'on' modes form the rotation roster.
// Audio source modes. The button cycles through these:
//   off:     no streams feed analysis (mic stopped, strudel ignored)
//   mic:     mic only — strudel ignored even while playing
//   strudel: strudel only — mic stopped (avoids speaker→mic echo doubling)
//   mix:     mic + strudel both feed (user opts in; pick this when the
//            mic is on a clean line — guitar interface, etc — so there's
//            no acoustic feedback path back from speakers)
// Audio source mode selector — four real-world states:
//   off → no reactivity
//   mic → mic only (engines ignored — full venue mix from one input,
//          useful when playing with others through a shared PA)
//   mix → strudel + sequencer (no mic; play through speakers without
//          feedback risk)
//   all → strudel + sequencer + mic
// Older multi-state values (strudel, sequencer alone) get remapped on
// load — see the audioMode restore block below.
const AUDIO_MODES   = ['off', 'mic', 'mix', 'all'];
const GLITCH_MODES  = ['off', 'on', 'blip', 'flip'];
const GLITCH_KEYS   = ['ascii', 'mosh', 'edge'];
const BLIP_DURATION_MS = 280;
// Hard-kick detector — tuned for "occasional flare on sub hits", not every
// kick or snare. Multiple gates must all pass for a fire:
//   - rising-edge beat pulse above a strict threshold
//   - bass band above an absolute floor (rejects normal-volume kicks)
//   - bass band ≥ a fraction of recent rolling peak (only the loudest
//     kicks of the recent stretch — peak decays so quiet sections
//     re-calibrate)
//   - bass dominates mids/highs (rejects snares + full-spectrum metal hits)
//   - cooldown since last fire (turns it into "occasional flare", not a
//     stutter on every sub-loaded beat)
const HARD_KICK_PULSE_THRESH = 0.95;     // rising-edge pulse minimum
const HARD_KICK_FLOOR        = 0.70;     // absolute bass minimum
const HARD_KICK_RATIO        = 0.92;     // ≥ 92% of recent rolling peak
const HARD_KICK_DOMINANCE    = 1.15;     // bass ≥ 1.15× max(mids, highs)
const HARD_KICK_PEAK_DECAY   = 0.998;    // ~6s half-life @ 60fps
const HARD_KICK_COOLDOWN_MS  = 10000;    // ~10s between fires

export function initQualiaPage() {
  // ── Registry ──────────────────────────────────────────────────────────────
  const mesh = createMesh();
  mesh.register(chladni);
  mesh.register(singularityLens);
  mesh.register(gargantuaVoid);
  mesh.register(voidstarLogo);
  mesh.register(neuralField);
  mesh.register(fractal);
  mesh.register(spectrum);
  mesh.register(vintageAnalog);
  mesh.register(synthwave);
  mesh.register(telemetry);
  mesh.register(camera);
  mesh.register(darkSpace);
  mesh.register(code);
  mesh.register(anomaly);
  mesh.register(atomicOrbital);
  mesh.register(galaxy);
  mesh.register(antireductionism);
  mesh.register(detector);
  mesh.register(ghostMachine);

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
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const btnRecord  = document.getElementById('btn-record');
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
  const btnMosh    = document.getElementById('btn-mosh');
  const btnEdge    = document.getElementById('btn-edge');
  const btnPhase   = document.getElementById('btn-phase');
  const phaseStyleSelect = document.getElementById('phase-style');
  const btnCycle   = document.getElementById('btn-cycle');
  const cycleStyleSelect = document.getElementById('cycle-style');
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
  const cameraCard = document.getElementById('camera-card');
  const camFlipBtn = document.getElementById('btn-cam-flip');
  const camFacingVal = document.getElementById('cam-facing-val');
  const camZoomRow = document.querySelector('[data-qp="cam-zoom"]');
  const camZoomInput = camZoomRow?.querySelector('input[type=range]');
  const camZoomVal   = camZoomRow?.querySelector('.qp-val');
  const camZoomNoneRow = document.getElementById('cam-zoom-unsupported');

  // ── Core wiring ───────────────────────────────────────────────────────────
  const audio = createAudio();
  const pose  = createPose();
  bindVideoElement(videoEl);

  let camSizeIdx = 0;
  // Camera zoom (hardware track-level zoom, gated by capability detection).
  // Persisted across reloads; reapplied after each camera open/flip.
  let lastZoomValue = 1.0;
  // Custom drag offset for the video preview (px from default bottom-right
  // anchor — positive values move it up/left). Persisted so a placement
  // chosen on the user's main rig sticks across sessions.
  let videoOffset = { dx: 0, dy: 0 };

  // Haptic feedback for touch interactions. The Vibration API is best-effort:
  // Android Chrome honors it, iOS Safari ignores it, desktop browsers usually
  // ignore it. Wrapped so we don't sprinkle navigator?.vibrate?.() everywhere.
  // Respect prefers-reduced-motion as a coarse "don't tickle me" signal.
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function hapticPulse(ms = 10) {
    if (REDUCED_MOTION) return;
    try { navigator.vibrate?.(ms); } catch {}
  }

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
      // Re-sync the phase timer for the new quale. autoPhaseSeconds (the
      // user's intended period) is preserved across switches — if the new
      // quale lacks phase support the timer just pauses; the next quale
      // that supports phase resumes at the same period without the user
      // having to re-enable.
      syncPhaseTimer();
      refreshPhaseBtn();
      // Auto-cycle: any switch (manual or via cycleNext) restarts the
      // dwell clock so the new fx gets the full autoCycleSeconds window.
      autoCycleStartMs = performance.now();
      refreshCycleBtn();
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
    audioMode,
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
    glitchModes:    { ...glitchModes },
    moshConfig:     overlay.getMoshConfig(),
    edgeConfig:     overlay.getEdgeConfig(),
    autoPhaseSeconds,
    autoPhaseStyle,
    autoPhaseBeatSync,
    autoCycleSeconds,
    autoCycleStyle,
    autoCycleBeatSync,
    numPoses:       pose.getNumPoses(),
    poseSmoothing:  poseSmoothingValue,
    poseThresh:     pose.getThresholds(),
    poseLingerMs:   pose.getLingerMs(),
    audioCollapsed: audioCard.classList.contains('collapsed'),
    poseCollapsed:  poseCard?.classList.contains('collapsed') ?? true,
    diagCollapsed:  document.getElementById('diag-card')?.classList.contains('collapsed') ?? true,
    paramsCollapsed: document.getElementById('fx-card')?.classList.contains('collapsed') ?? false,
    moshCollapsed:  document.getElementById('mosh-card')?.classList.contains('collapsed') ?? true,
    edgeCollapsed:  document.getElementById('edge-card')?.classList.contains('collapsed') ?? true,
    cameraCollapsed: cameraCard?.classList.contains('collapsed') ?? true,
    cameraZoom:     lastZoomValue,
    videoPos:       videoOffset,
  }));
  const stored = settings.load();
  camSizeIdx = stored.camSizeIdx ?? 0;

  // ── Restore overlay toggles from settings ────────────────────────────────
  if (typeof stored.showOverlay === 'boolean') overlay.setOption('skeleton', stored.showOverlay);
  if (typeof stored.sparksOn    === 'boolean') overlay.setOption('sparks',   stored.sparksOn);
  if (typeof stored.auraOn      === 'boolean') overlay.setOption('aura',     stored.auraOn);
  if (typeof stored.ripplesOn   === 'boolean') overlay.setOption('ripples',  stored.ripplesOn);
  // Glitch modes (per-button mode for ascii / mosh / edge). Migrate any
  // legacy stored.asciiMode / stored.moshOn / stored.edgeOn shape into the
  // unified glitchModes object so users coming from an earlier build keep
  // their toggles.
  const glitchModes = { ascii: 'off', mosh: 'off', edge: 'off' };
  if (stored.glitchModes && typeof stored.glitchModes === 'object') {
    for (const g of GLITCH_KEYS) {
      const m = stored.glitchModes[g];
      if (typeof m === 'string' && GLITCH_MODES.includes(m)) glitchModes[g] = m;
    }
  } else {
    if (typeof stored.asciiMode === 'string' && GLITCH_MODES.includes(stored.asciiMode)) {
      glitchModes.ascii = stored.asciiMode;
    } else if (typeof stored.asciiMode === 'boolean') {
      glitchModes.ascii = stored.asciiMode ? 'on' : 'off';
    }
    if (typeof stored.moshOn === 'boolean') glitchModes.mosh = stored.moshOn ? 'on' : 'off';
    if (typeof stored.edgeOn === 'boolean') glitchModes.edge = stored.edgeOn ? 'on' : 'off';
  }
  // Match overlay options to modes at boot time. Reactive modes (blip /
  // flip) start with the glitch off and let the kick trigger flip it on.
  // The mutex inside overlay.setOption means only the last 'on' glitch in
  // iteration order ends up rendering — fine, since only one renders anyway.
  for (const g of GLITCH_KEYS) overlay.setOption(g, glitchModes[g] === 'on');
  // Per-glitch blip auto-clear timestamps (epoch ms; 0 = inactive).
  const blipExpiresAt = { ascii: 0, mosh: 0, edge: 0 };

  // Audio mode. The button cycles through four real-world states:
  //   off → mic (mic only) → mix (strudel + seq, no mic) → all (everything)
  // The 'mic' mode is useful at venues — feed reactivity from a shared
  // PA / room mic without adding the direct engine streams.
  //
  // Migrations across earlier shapes:
  //   - `audioOn` boolean: true → 'all' (legacy mic mode also wanted reactivity), false → 'off'.
  //   - older `audioMode` ∈ {off, mic, strudel, sequencer, mix, all}:
  //       'mic' → 'mic'  (mic-only intent preserved)
  //       'all' → 'all'
  //       'strudel'/'sequencer'/'mix' → 'mix'  (preserve "engines, no mic" intent)
  //       'off' → 'off'
  let audioMode;
  if (typeof stored.audioMode === 'string') {
    if (stored.audioMode === 'all') audioMode = 'all';
    else if (stored.audioMode === 'mic') audioMode = 'mic';
    else if (stored.audioMode === 'off') audioMode = 'off';
    else audioMode = 'mix';
  } else if (typeof stored.audioOn === 'boolean') {
    audioMode = stored.audioOn ? 'all' : 'off';
  } else {
    audioMode = 'off';
  }
  // Mosh / edge config restore (overlay options themselves are derived
  // from glitchModes above).
  if (stored.moshConfig) overlay.setMoshConfig(stored.moshConfig);
  if (stored.edgeConfig) overlay.setEdgeConfig(stored.edgeConfig);

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
  const diagCardEl = document.getElementById('diag-card');
  if (diagCardEl && typeof stored.diagCollapsed === 'boolean') {
    diagCardEl.classList.toggle('collapsed', stored.diagCollapsed);
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
  // On touch / narrow viewports we want accordion semantics — opening one
  // card collapses its siblings — because vertical space is at a premium.
  // Desktop with a wide viewport keeps the existing free-stack behavior so
  // power users can have audio + pose + params all open at once. Detection
  // uses pointer: coarse OR width <= 768px, matching the mobile media query
  // above. Re-evaluated on each click so flipping the device into landscape
  // doesn't get stuck in the wrong mode.
  const ACCORDION_MQ = window.matchMedia('(max-width: 768px), (pointer: coarse)');
  document.querySelectorAll('[data-toggle]').forEach(h => {
    h.addEventListener('click', (e) => {
      if (e.target.closest('button, input, select')) return;
      const card = document.getElementById(h.dataset.toggle);
      if (!card) return;
      const wasCollapsed = card.classList.contains('collapsed');
      card.classList.toggle('collapsed');
      // Just expanded a card on mobile? Collapse its siblings inside the
      // panel stack so the resulting tower still fits the viewport.
      if (wasCollapsed && ACCORDION_MQ.matches) {
        document.querySelectorAll('#panel-stack > .qp-card').forEach(other => {
          if (other !== card) other.classList.add('collapsed');
        });
      }
      settings.save();
    });
  });

  // ── Reset-all (escape hatch for stuck state) ─────────────────────────────
  // Tucked into the diagnostics card so it's not in the casual-user flow,
  // but reachable when something's wedged. Wipes every voidstar.qualia.*
  // localStorage key, every CacheStorage cache (the SW + any Strudel
  // off-main-thread caches), and unregisters the service worker — then
  // hard-reloads. Effectively a factory reset for the qualia tab.
  document.getElementById('btn-reset-all')?.addEventListener('click', async (ev) => {
    // Stop the click bubbling to the qp-head data-toggle handler so the
    // card doesn't snap shut underneath the confirm dialog.
    ev.stopPropagation();
    const ok = confirm('Reset qualia: clear all settings + cached assets and reload?');
    if (!ok) return;
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('voidstar.qualia')) localStorage.removeItem(k);
      }
    } catch {}
    try {
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
      }
    } catch {}
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch {}
    location.reload();
  });

  // ── Topbar group popovers ────────────────────────────────────────────────
  // Each `.qg-group` is a trigger button + a popover holding the original
  // controls (camera / pose / layers / post / auto). The popover shows on
  // trigger click, hides on outside click, swaps when another trigger is
  // pressed. A MutationObserver mirrors descendant .active state onto the
  // trigger so the user can see at a glance which groups have something on.
  const groupEls = document.querySelectorAll('.qg-group');
  function closeAllGroupsExcept(except) {
    groupEls.forEach(g => {
      if (g === except) return;
      if (g.classList.contains('open')) {
        g.classList.remove('open');
        const trig = g.querySelector('.qg-trigger');
        trig?.setAttribute('aria-expanded', 'false');
      }
    });
  }
  function repositionPopover(group) {
    const pop = group.querySelector('.qg-popover');
    if (!pop) return;
    pop.classList.remove('right-aligned');
    // After a frame so getBoundingClientRect reflects the displayed size.
    requestAnimationFrame(() => {
      const r = pop.getBoundingClientRect();
      if (r.right > window.innerWidth - 4) pop.classList.add('right-aligned');
    });
  }
  // Topbar groups whose drawer mirrors a bottom-stack card. Opening the
  // popover also expands the matching card (and accordion-collapses the
  // others on mobile); opening a tab from #panel-tabs reciprocally opens
  // the popover. Keeps the user from hunting in two places when "camera"
  // / "pose" settings are split between the topbar and the params HUD.
  const LINKED_CARDS = { camera: 'camera-card', pose: 'pose-card' };
  function expandLinkedCard(groupKey) {
    const cardId = LINKED_CARDS[groupKey];
    if (!cardId) return;
    const card = document.getElementById(cardId);
    if (!card || card.style.display === 'none') return;
    card.classList.remove('collapsed');
    if (ACCORDION_MQ.matches) {
      document.querySelectorAll('#panel-stack > .qp-card').forEach(c => {
        if (c.id !== cardId) c.classList.add('collapsed');
      });
    }
    settings.save();
  }
  function openLinkedGroup(cardId) {
    const groupKey = Object.keys(LINKED_CARDS).find(k => LINKED_CARDS[k] === cardId);
    if (!groupKey) return;
    const group = document.querySelector(`.qg-group[data-group="${groupKey}"]`);
    if (!group || group.classList.contains('open')) return;
    closeAllGroupsExcept(group);
    group.classList.add('open');
    const trig = group.querySelector('.qg-trigger');
    trig?.setAttribute('aria-expanded', 'true');
    repositionPopover(group);
  }

  groupEls.forEach(group => {
    const trigger = group.querySelector('.qg-trigger');
    if (!trigger) return;
    trigger.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wasOpen = group.classList.contains('open');
      closeAllGroupsExcept(wasOpen ? null : group);
      group.classList.toggle('open', !wasOpen);
      trigger.setAttribute('aria-expanded', String(!wasOpen));
      if (!wasOpen) {
        repositionPopover(group);
        expandLinkedCard(group.dataset.group);
      }
    });
  });

  // Per-group "is anything actually on?" predicates power the trigger dot.
  // Earlier the dot mirrored any descendant with .active, but several
  // buttons start with class="active" by default (mirror, skeleton,
  // sparks, aura, ripples) — so the dot was lit even when the underlying
  // feature was off. Hardcoding the meaningful check per group is a few
  // lines and fixes the misleading display.
  function refreshGroupActiveDots() {
    const checks = {
      camera: () => poseSelect.value === 'camera',
      // Pose group now also houses the audio-driven overlays (sparks /
      // aura) — light the dot whenever any of its controls is engaged,
      // not just when the camera-pose source is on.
      pose:   () => poseSelect.value === 'camera'
                 || overlay.getOption('sparks')
                 || overlay.getOption('aura'),
      layers: () => overlay.getOption('ripples'),
      post:   () => glitchModes.ascii !== 'off'
                 || glitchModes.mosh  !== 'off'
                 || glitchModes.edge  !== 'off',
      // Auto group now owns auto-phase too; either an auto-cycle or an
      // auto-phase being scheduled lights the dot.
      auto:   () => autoCycleSeconds > 0 || autoPhaseSeconds > 0,
    };
    document.querySelectorAll('.qg-group').forEach(g => {
      const key = g.dataset.group;
      const trigger = g.querySelector('.qg-trigger');
      if (!trigger) return;
      const fn = checks[key];
      const on = fn ? !!fn() : false;
      trigger.classList.toggle('qg-has-active', on);
    });
  }
  // Initial paint runs after the rest of init finishes wiring; call it
  // once boot completes via the same path that sets up the auto-boot.
  // For now, expose as a trailing window.requestAnimationFrame.
  requestAnimationFrame(() => { try { refreshGroupActiveDots(); } catch {} });
  // Outside click closes any open popover. Pointerdown (capture) so a
  // gesture handler that stops propagation later doesn't shield us.
  document.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest?.('.qg-group')) return;
    closeAllGroupsExcept(null);
  }, true);
  // Escape closes too.
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeAllGroupsExcept(null);
  });

  // ── Bottom-left panel tab bar (mobile only) ──────────────────────────────
  // The tab bar enforces accordion semantics on touch/narrow viewports:
  // exactly one card open at a time, with tabs as the discovery mechanism.
  // Cards keep their existing per-header collapse buttons too — tapping a
  // tab is shorthand for "expand this and collapse the others". The bar
  // hides on desktop (CSS media query); the JS just keeps tab state in
  // sync with whichever cards are visible + currently expanded.
  const panelTabs = document.getElementById('panel-tabs');
  if (panelTabs) {
    function refreshPanelTabs() {
      panelTabs.querySelectorAll('.qp-tab').forEach(btn => {
        const card = document.getElementById(btn.dataset.card);
        if (!card) { btn.style.display = 'none'; return; }
        // Hide tabs whose underlying card is currently display:none (e.g.
        // mosh / edge / camera cards that only surface when their feature
        // is on). Empty container is meaningless to switch to.
        const cardHidden = card.style.display === 'none';
        btn.style.display = cardHidden ? 'none' : '';
        btn.classList.toggle('active', !cardHidden && !card.classList.contains('collapsed'));
      });
    }
    panelTabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.qp-tab');
      if (!btn) return;
      const cardId = btn.dataset.card;
      const target = document.getElementById(cardId);
      if (!target) return;
      // Tapping the already-active tab dismisses the panel (collapse all);
      // tapping any other tab expands that card and collapses siblings.
      // The "all collapsed" state is fine on mobile — the CSS rule
      // hides collapsed cards entirely, so the panel-stack vanishes and
      // the fx canvas is fully unobstructed until the next tap.
      const isActive = !target.classList.contains('collapsed');
      if (isActive) {
        target.classList.add('collapsed');
      } else {
        document.querySelectorAll('#panel-stack > .qp-card').forEach(c => {
          c.classList.toggle('collapsed', c.id !== cardId);
        });
        // Mirror the open into the topbar popover for linked groups so
        // the camera / pose controls in both places surface together.
        openLinkedGroup(cardId);
      }
      refreshPanelTabs();
      settings.save();
    });
    // Watch each card for class/style changes so the tab bar mirrors live
    // visibility + expand state. Cheap — observers fire only on attribute
    // changes, not every frame.
    if (typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(refreshPanelTabs);
      document.querySelectorAll('#panel-stack > .qp-card').forEach(c => {
        obs.observe(c, { attributes: true, attributeFilter: ['class', 'style'] });
      });
    }
    refreshPanelTabs();
  }

  // Expose the live topbar height as a CSS var so #panel-stack and
  // #strudel-panel can size themselves relative to it instead of guessing.
  // The topbar is column-flex with a wrapping control row so its height
  // depends on viewport width (number of wrap rows). ResizeObserver is the
  // cheap way to keep --topbar-h current. --tabs-h does the same for the
  // mobile-only panel tab bar so #panel-stack lifts to clear it without
  // hard-coding the height.
  const setTopbarVar = () => {
    const h = topbarEl.getBoundingClientRect().height;
    if (h > 0) document.documentElement.style.setProperty('--topbar-h', `${h}px`);
  };
  const setTabsVar = () => {
    if (!panelTabs) return;
    // getBoundingClientRect returns 0 while the bar is display:none on
    // desktop; in that case we want the var to be 0 so #panel-stack reclaims
    // the bottom margin instead of leaving a phantom gap.
    const cs = window.getComputedStyle(panelTabs);
    const h = cs.display === 'none' ? 0 : panelTabs.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--tabs-h', `${h}px`);
  };
  setTopbarVar();
  setTabsVar();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(setTopbarVar).observe(topbarEl);
    if (panelTabs) new ResizeObserver(setTabsVar).observe(panelTabs);
  } else {
    window.addEventListener('resize', () => { setTopbarVar(); setTabsVar(); });
  }
  // Media-query change (rotating the phone, resizing a touch laptop) flips
  // the display:none toggle on the tab bar — ResizeObserver doesn't fire
  // for display changes, so listen here too.
  window.matchMedia('(max-width: 768px), (pointer: coarse)')
    .addEventListener?.('change', setTabsVar);

  // ── Audio source mode (off / mic / mix / all) ──────────────────────────
  // The button is a 4-state selector matching real-world usage:
  //   off → mic stopped, audio.setSourceFilter([])
  //   mic → mic running, filter ['mic']  (engines ignored — venue mix)
  //   mix → mic stopped, filter ['strudel', 'sequencer']  (engines only)
  //   all → mic running, filter ['mic', 'strudel', 'sequencer']
  // The `onChange` callback only handles visual side-effects from external
  // source changes (e.g. strudel adopt/release while panel is open) so the
  // panel visibility and label stay in sync with whatever's actually live.
  async function startMic(deviceId) {
    // Caller decides how to surface failure. audio.start() already retries
    // without the deviceId constraint when the stored mic is gone, so a
    // throw here means a real problem (denied permission, no input device,
    // etc.) — not just a stale stored deviceId.
    const id = await audio.start(deviceId);
    if (id) storeDeviceId('mic', id);
    micPicker.populate(id);
    return id;
  }
  async function stopMic() {
    await audio.stop();
  }

  function applyAudioFilter() {
    switch (audioMode) {
      case 'off': audio.setSourceFilter([]);                              break;
      case 'mic': audio.setSourceFilter(['mic']);                         break;
      case 'mix': audio.setSourceFilter(['strudel', 'sequencer']);        break;
      case 'all': audio.setSourceFilter(['mic', 'strudel', 'sequencer']); break;
    }
  }

  function refreshAudioBtn() {
    btnAudio.classList.remove('active', 'active-audio');
    btnAudio.textContent = `audio ${audioMode}`;
    if (audioMode !== 'off') {
      // Pink (active-audio) when the mic itself is engaged — visual hint
      // that we're listening to the room. Cyan (active) for engines-only
      // mix where no live mic is open.
      const micEngaged = audioMode === 'all' || audioMode === 'mic';
      btnAudio.classList.add(micEngaged ? 'active-audio' : 'active');
    }
    btnAudio.title = 'Audio source (A) — off / mic / mix (strudel+seq) / all (+mic)';
    // Audio panel visibility tracks "is anything driving reactivity" — open
    // when mode != off.
    audioCard.style.display = audioMode === 'off' ? 'none' : '';
  }

  async function setAudioMode(mode) {
    if (!AUDIO_MODES.includes(mode)) return;
    const prevMode = audioMode;
    audioMode = mode;
    const wantMic = mode === 'all' || mode === 'mic';
    try {
      if (wantMic && !audio.hasSource('mic')) {
        await startMic(getStoredDeviceId('mic'));
      } else if (!wantMic && audio.hasSource('mic')) {
        await stopMic();
      }
    } catch (err) {
      // Mic open failed — roll the displayed mode back so the UI matches
      // reality. The caller (boot, button click handler) decides whether
      // to surface this to the user; we just log and re-throw.
      audioMode = prevMode;
      applyAudioFilter();
      refreshAudioBtn();
      settings.save();
      console.warn('[qualia] setAudioMode failed:', err);
      throw err;
    }
    applyAudioFilter();
    refreshAudioBtn();
    settings.save();
  }

  // External source changes (e.g., strudel adopt/release) only need to
  // refresh the panel visibility; the mode itself is user-driven.
  audio.onChange(() => {
    refreshAudioBtn();
    settings.save();
  });

  btnAudio.addEventListener('click', () => {
    setAudioMode(nextAudioMode()).catch(err => {
      // User explicitly clicked the audio button — surface failures
      // (mic permission denied, no input device) so they know why
      // nothing happened. Auto-boot path silences this via its own catch.
      alert(`Could not open microphone: ${err?.message || err}`);
    });
  });
  function nextAudioMode() {
    const i = AUDIO_MODES.indexOf(audioMode);
    return AUDIO_MODES[(i + 1) % AUDIO_MODES.length];
  }
  // Initial filter + paint. Mic source is opened separately during boot
  // (so the start/silent overlay buttons can sequence permissions).
  applyAudioFilter();
  refreshAudioBtn();

  // ── Mic / cam pickers ─────────────────────────────────────────────────────
  // Forward holder for the vocoder — created later, but the mic picker's
  // onChoose needs to restart its capture when the user swaps devices.
  let _vocoderRef = null;
  const micPicker = wirePicker({
    select: micSelect,
    kind: 'audioinput',
    getCurrentId: () => audio.getCurrentMicId(),
    onChoose: async (id) => {
      // Mic and Strudel coexist on separate analysers — switching mics
      // only restarts the mic source, leaving any active Strudel tap
      // (and its AudioContext) intact.
      if (audio.hasSource('mic')) await audio.stop();
      const chosen = await audio.start(id);
      // Vocoder owns its own getUserMedia stream; propagate the swap so it
      // follows the topbar selection rather than holding onto the previous
      // device. Awaited so a failure here surfaces through the picker's
      // alert path the same way an audio.start failure would.
      try { await _vocoderRef?.setDevice?.(chosen); } catch {}
      return chosen;
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

  // ── Camera card (zoom + flip) ────────────────────────────────────────────
  // Visibility tracks "is the pose camera open" — same as the pose card,
  // but split out so zoom controls live with their visual subject.
  function syncCameraCardVisibility() {
    if (!cameraCard) return;
    const on = poseSelect.value !== 'off';
    cameraCard.style.display = on ? '' : 'none';
    if (on) refreshCameraCard();
  }
  function refreshCameraCard() {
    if (!cameraCard) return;
    const facing = pose.getFacingMode();
    if (camFacingVal) camFacingVal.textContent = facing === 'environment' ? 'rear' : 'front';
    // Zoom row visibility hinges on the active track's capabilities. Most
    // Android phones expose hardware zoom; iOS Safari + many USB webcams
    // do not. We hide the slider entirely (rather than showing it disabled)
    // so the panel stays calm on devices that can't deliver.
    const caps = pose.getZoomCaps();
    if (camZoomRow && camZoomInput) {
      if (caps && caps.max > caps.min) {
        camZoomRow.style.display = '';
        if (camZoomNoneRow) camZoomNoneRow.style.display = 'none';
        camZoomInput.min  = String(caps.min);
        camZoomInput.max  = String(caps.max);
        camZoomInput.step = String(caps.step);
        // Clamp the persisted value to the new caps; reapply on the track.
        const clamped = Math.max(caps.min, Math.min(caps.max, lastZoomValue));
        camZoomInput.value = String(clamped);
        if (camZoomVal) camZoomVal.textContent = `${clamped.toFixed(1)}×`;
        if (clamped !== caps.value) pose.setZoom(clamped);
      } else {
        camZoomRow.style.display = 'none';
        if (camZoomNoneRow) camZoomNoneRow.style.display = '';
      }
    }
  }
  // Slider → track zoom. We update the value label optimistically; the
  // track's own clamping is enforced by setZoom.
  camZoomInput?.addEventListener('input', async () => {
    const v = parseFloat(camZoomInput.value);
    lastZoomValue = v;
    if (camZoomVal) camZoomVal.textContent = `${v.toFixed(1)}×`;
    await pose.setZoom(v);
    settings.save();
  });
  // Flip front/back. Drops the persisted deviceId on purpose — the OS
  // picks whichever lens matches the requested side.
  async function flipCameraFacing() {
    if (poseSelect.value !== 'camera') return;
    try {
      const id = await pose.flipFacing();
      if (id) storeDeviceId('cam', id);
      camPicker.populate(id);
      refreshCameraCard();
      // Reapply persisted zoom to the new track (it has its own capabilities).
      // refreshCameraCard already clamps + re-applies; nothing else needed.
      settings.save();
    } catch (err) {
      alert(`Could not flip camera: ${err.message || err}`);
    }
  }
  camFlipBtn?.addEventListener('click', flipCameraFacing);
  if (typeof stored.cameraZoom === 'number') lastZoomValue = stored.cameraZoom;
  if (cameraCard && typeof stored.cameraCollapsed === 'boolean') {
    cameraCard.classList.toggle('collapsed', stored.cameraCollapsed);
  }

  // ── Pose source ───────────────────────────────────────────────────────────
  // The cam-action buttons (size / rotate / mirror) are now always visible
  // in the camera popover — they're pure toggles that work whether the
  // camera is on or off, and keeping them visible avoids the "empty
  // popover" bug seen on Android when startCamera hiccups silently. Only
  // pose-max + cam-select remain gated on camera state.
  poseSelect.addEventListener('change', async () => {
    const v = poseSelect.value;
    if (v === 'off') {
      pose.stopCamera();
      videoEl.classList.remove('visible');
      camSelect.style.display = 'none';
      posesSelect.style.display = 'none';
    } else if (v === 'camera') {
      try {
        const id = await pose.startCamera({ deviceId: getStoredDeviceId('cam'), video: videoEl });
        if (id) storeDeviceId('cam', id);
        posesSelect.style.display = '';
        camPicker.populate(id);
      } catch (err) {
        // Surface to console too — alerts on Android sometimes get
        // dismissed by the OS before the user reads them; the console
        // copy survives so a remote debugger can confirm.
        console.error('[qualia] camera startup failed:', err);
        alert(`Could not open camera: ${err.message || err}`);
        poseSelect.value = 'off';
      }
    }
    syncPoseCardVisibility();
    syncCameraCardVisibility();
    refreshGroupActiveDots();
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
    // Drag offset is meaningless in size-full (the element fills the
    // viewport and the bottom/right CSS is overridden). For all other
    // sizes, reapply so a previously-dragged placement survives.
    // applyVideoOffset is a hoisted function declaration further down.
    if (s === 'full') {
      videoEl.style.bottom = '';
      videoEl.style.right  = '';
    } else {
      applyVideoOffset();
    }
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

  // ── Video-preview touch gestures ─────────────────────────────────────────
  // The preview rectangle is a busy little control surface. To keep the
  // chrome out of the way, we layer gestures onto the same element:
  //   - tap          → cycle cam size
  //   - double-tap   → flip front/back camera
  //   - long-press   → open the camera picker (cam-select)
  //   - drag         → reposition (persisted)
  // Ordering matters: we don't fire the single-tap action until the
  // double-tap window closes, so a quick second tap upgrades cleanly.
  // PointerEvents handle mouse + touch + pen uniformly, but only on
  // browsers ≥ 2018. On any environment without them the user still has
  // every action via the topbar buttons and the cam-card's flip button.
  const TAP_TIMEOUT_MS  = 280;   // window for second tap to upgrade to dbl-tap
  const TAP_MAX_MOVE_PX = 10;    // jitter floor before we call it a drag
  const LONG_PRESS_MS   = 550;   // press-and-hold opens cam picker
  const LONG_PRESS_MOVE = 8;     // movement before the long-press is cancelled
  let lastTapTime = 0;
  let pendingTapT = null;
  let pressStartT = 0;
  let pressStartX = 0, pressStartY = 0;
  let didDrag = false;
  let didLongPress = false;
  let dragStartOffset = null;
  let longPressT = null;

  function applyVideoOffset() {
    if (!videoEl.classList.contains('visible')) return;
    if (videoEl.classList.contains('size-full')) return; // no offset in full
    // The base anchor is bottom/right. Positive dx pushes left, dy pushes up.
    // We update both bottom & right to keep the existing CSS as the base.
    const isMobile   = window.matchMedia('(max-width: 768px)').matches;
    const baseBottom = isMobile ? 0.5 : 1.25; // rem
    const baseRight  = baseBottom;
    // On mobile, lift the default anchor above the fixed panel-tabs bar
    // (matches the CSS rule for #video.visible). Without this, dragging
    // the preview snaps it back down behind the tab bar.
    const tabsLift = isMobile ? ' + var(--tabs-h, 2.4rem) + 0.4rem' : '';
    videoEl.style.bottom = `calc(${baseBottom}rem${tabsLift} + ${videoOffset.dy}px)`;
    videoEl.style.right  = `calc(${baseRight}rem + ${videoOffset.dx}px)`;
  }

  function clampVideoOffset() {
    // Keep at least 32px of the preview on-screen so a stray drag can't lose
    // it past the viewport edge.
    if (!videoEl) return;
    const rect = videoEl.getBoundingClientRect();
    const maxDx = Math.max(0, window.innerWidth  - 32);
    const maxDy = Math.max(0, window.innerHeight - 32);
    videoOffset.dx = Math.max(0, Math.min(maxDx, videoOffset.dx));
    videoOffset.dy = Math.max(0, Math.min(maxDy, videoOffset.dy));
    void rect; // referenced for future viewport-aware clamping logic
  }

  if (stored.videoPos && typeof stored.videoPos.dx === 'number' && typeof stored.videoPos.dy === 'number') {
    videoOffset = { dx: stored.videoPos.dx, dy: stored.videoPos.dy };
  }
  // Reapply offset on resize / orientation change so the pip stays visible.
  window.addEventListener('resize', () => { clampVideoOffset(); applyVideoOffset(); });
  applyVideoOffset();

  function onPointerDown(ev) {
    if (!videoEl.classList.contains('visible')) return;
    pressStartT = performance.now();
    pressStartX = ev.clientX; pressStartY = ev.clientY;
    didDrag = false;
    didLongPress = false;
    dragStartOffset = { dx: videoOffset.dx, dy: videoOffset.dy };
    videoEl.setPointerCapture?.(ev.pointerId);
    // In size-full the pip covers the whole viewport. Tapping should still
    // cycle out of full (the user wants to escape) but drag + long-press
    // are disabled — repositioning a fullscreen element is meaningless and
    // a long-press would block the natural tap-to-escape gesture.
    if (videoEl.classList.contains('size-full')) return;
    longPressT = setTimeout(() => {
      // Long-press: open cam picker if multiple cameras are available;
      // otherwise fall through to a haptic "nothing here" cue.
      if (didDrag) return;
      didLongPress = true;
      hapticPulse(20);
      if (camSelect && camSelect.style.display !== 'none') {
        try { camSelect.focus(); camSelect.click?.(); } catch {}
        // showPicker() is the only programmatic way to drop a native <select>
        // popup on most browsers. Optional chain — Safari/iOS lacks it.
        camSelect.showPicker?.();
      }
    }, LONG_PRESS_MS);
  }

  function onPointerMove(ev) {
    if (!pressStartT) return;
    const dx = ev.clientX - pressStartX;
    const dy = ev.clientY - pressStartY;
    if (!didDrag && Math.hypot(dx, dy) > TAP_MAX_MOVE_PX) {
      didDrag = true;
      videoEl.classList.add('dragging');
      if (longPressT) { clearTimeout(longPressT); longPressT = null; }
    }
    if (didDrag) {
      // Bottom-right anchor → moving right/down decreases dx/dy.
      videoOffset.dx = (dragStartOffset?.dx ?? 0) - dx;
      videoOffset.dy = (dragStartOffset?.dy ?? 0) - dy;
      clampVideoOffset();
      applyVideoOffset();
    }
  }

  function onPointerUp() {
    if (!pressStartT) return;
    if (longPressT) { clearTimeout(longPressT); longPressT = null; }
    const elapsed = performance.now() - pressStartT;
    pressStartT = 0;
    if (didDrag) {
      videoEl.classList.remove('dragging');
      settings.save();
      return;
    }
    if (didLongPress) return;
    if (elapsed > LONG_PRESS_MS) return;
    // Tap path. Defer the size-cycle in case the user is mid-double-tap.
    const now = performance.now();
    const isDoubleTap = (now - lastTapTime) < TAP_TIMEOUT_MS;
    lastTapTime = now;
    if (isDoubleTap) {
      if (pendingTapT) { clearTimeout(pendingTapT); pendingTapT = null; }
      hapticPulse(15);
      flipCameraFacing();
    } else {
      pendingTapT = setTimeout(() => {
        pendingTapT = null;
        hapticPulse(8);
        btnCamera.click();
      }, TAP_TIMEOUT_MS);
    }
  }

  function onPointerCancel() {
    if (longPressT) { clearTimeout(longPressT); longPressT = null; }
    pressStartT = 0;
    if (didDrag) {
      videoEl.classList.remove('dragging');
      settings.save();
    }
  }

  if (videoEl) {
    videoEl.addEventListener('pointerdown',   onPointerDown);
    videoEl.addEventListener('pointermove',   onPointerMove);
    videoEl.addEventListener('pointerup',     onPointerUp);
    videoEl.addEventListener('pointercancel', onPointerCancel);
    // Suppress the synthesized "click" the browser fires alongside touch /
    // mouse pointer events — we already dispatched our own action via
    // onPointerUp, and the click would re-trigger btnCamera through its
    // own listener, double-cycling the size.
    videoEl.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  }

  // ── Canvas-level touch gestures ──────────────────────────────────────────
  // Three gestures, all on the empty canvas area (we ignore touches inside
  // any UI surface):
  //   - vertical swipe       → cycle to next / prev quale
  //   - two-finger tap       → toggle pause
  //   - pinch                → drive camera zoom (when hardware caps allow)
  //
  // Single-finger horizontal motion is reserved for the future. Pointer
  // capture is on the body so a swipe that crosses onto the topbar still
  // completes — swipes on phones often overshoot.
  const SWIPE_MIN_PX     = 60;     // total distance to count as a swipe
  const SWIPE_AXIS_RATIO = 1.6;    // |dy| > |dx| * ratio for vertical
  const TWO_FINGER_TAP_MS = 220;
  const TWO_FINGER_TAP_MOVE = 18;  // total finger-1 movement during the tap
  const PINCH_MIN_MOVE_PX = 8;     // distance change before we treat as pinch

  // Active touches by pointerId. Excludes mouse + pen — those have their own
  // interaction model and we don't want a stray right-click to count.
  const canvasPointers = new Map();
  let pinchInitialDist = 0;
  let pinchInitialZoom = 1;
  let pinchInitialMin  = 1;
  let pinchInitialMax  = 1;
  let canvasGestureStartT = 0;
  let canvasGestureMaxFingers = 0;
  let canvasGestureDidPinch = false;

  function pointInUiZone(x, y) {
    // Pull the element under the touch and check if it lives inside any of
    // our HUD surfaces. Using elementFromPoint instead of event.target lets
    // a swipe that ENDS over the topbar still register as "started on the
    // canvas" — only the start position decides.
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    return !!el.closest('#topbar, #panel-stack, #panel-tabs, #strudel-panel, #sequencer-panel, #video, #zen-handle, #status-overlay, .qg-popover');
  }

  function onCanvasPointerDown(ev) {
    if (ev.pointerType !== 'touch') return;
    if (pointInUiZone(ev.clientX, ev.clientY)) return;
    canvasPointers.set(ev.pointerId, {
      x0: ev.clientX, y0: ev.clientY,
      x:  ev.clientX, y:  ev.clientY,
      t0: performance.now(),
    });
    canvasGestureMaxFingers = Math.max(canvasGestureMaxFingers, canvasPointers.size);
    if (canvasPointers.size === 1) {
      canvasGestureStartT = performance.now();
      canvasGestureDidPinch = false;
    }
    if (canvasPointers.size === 2) {
      // Initialize pinch baseline. We only run pinch-zoom when the camera
      // track exposes hardware zoom — capability check is cheap and means
      // the gesture silently no-ops on iOS Safari / non-zoomable USB cams.
      const [a, b] = [...canvasPointers.values()];
      pinchInitialDist = Math.hypot(a.x - b.x, a.y - b.y);
      const caps = pose.getZoomCaps?.();
      if (caps && caps.max > caps.min) {
        pinchInitialZoom = lastZoomValue;
        pinchInitialMin = caps.min;
        pinchInitialMax = caps.max;
      } else {
        pinchInitialZoom = 0; // sentinel: no zoom support
      }
    }
  }

  function onCanvasPointerMove(ev) {
    const p = canvasPointers.get(ev.pointerId);
    if (!p) return;
    p.x = ev.clientX; p.y = ev.clientY;
    if (canvasPointers.size === 2 && pinchInitialZoom > 0) {
      const [a, b] = [...canvasPointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const delta = dist - pinchInitialDist;
      if (Math.abs(delta) > PINCH_MIN_MOVE_PX) {
        canvasGestureDidPinch = true;
        // Map pixel-space pinch to a zoom range. Each 200px ≈ full sweep
        // through the available zoom range; tuned so a comfortable pinch
        // covers most lenses' min→max in one motion.
        const ratio = dist / Math.max(pinchInitialDist, 1);
        const zoomRange = pinchInitialMax - pinchInitialMin;
        const target = Math.max(
          pinchInitialMin,
          Math.min(pinchInitialMax, pinchInitialZoom * ratio)
        );
        // Throttle the actual track update to ~30Hz; the slider updates
        // every move so the visual stays responsive.
        applyPinchZoom(target);
        void zoomRange;
      }
    }
  }

  let _lastPinchApplyT = 0;
  function applyPinchZoom(value) {
    lastZoomValue = value;
    if (camZoomInput) {
      camZoomInput.value = String(value);
      if (camZoomVal) camZoomVal.textContent = `${value.toFixed(1)}×`;
    }
    const now = performance.now();
    if (now - _lastPinchApplyT < 33) return;
    _lastPinchApplyT = now;
    pose.setZoom(value);
  }

  function onCanvasPointerUp(ev) {
    const p = canvasPointers.get(ev.pointerId);
    if (!p) return;
    canvasPointers.delete(ev.pointerId);
    // All fingers up: final classification.
    if (canvasPointers.size === 0) {
      const elapsed = performance.now() - canvasGestureStartT;
      if (canvasGestureDidPinch) {
        // Persist the pinched zoom on lift; per-frame applyPinchZoom already
        // sent intermediate values to the track.
        pose.setZoom(lastZoomValue);
        settings.save();
      } else if (canvasGestureMaxFingers === 2 && elapsed < TWO_FINGER_TAP_MS) {
        const dx = Math.abs(p.x - p.x0), dy = Math.abs(p.y - p.y0);
        if (dx + dy < TWO_FINGER_TAP_MOVE) {
          hapticPulse(12);
          btnPause.click();
        }
      } else if (canvasGestureMaxFingers === 1) {
        const dx = p.x - p.x0, dy = p.y - p.y0;
        if (Math.abs(dy) >= SWIPE_MIN_PX && Math.abs(dy) > Math.abs(dx) * SWIPE_AXIS_RATIO) {
          hapticPulse(15);
          // Up = next quale (forward), Down = previous. Same direction
          // semantics as a music app's "next track" gesture.
          const ids = mesh.ids();
          if (ids.length > 1) {
            const cur = core.activeId();
            const i = ids.indexOf(cur || ids[0]);
            const step = dy < 0 ? 1 : -1;
            const nextId = ids[(i + step + ids.length) % ids.length];
            core.setActive(nextId).catch(err => console.error('[qualia] swipe setActive failed:', err));
          }
        }
      }
      canvasGestureMaxFingers = 0;
      canvasGestureDidPinch = false;
    }
  }

  document.body.addEventListener('pointerdown',   onCanvasPointerDown);
  document.body.addEventListener('pointermove',   onCanvasPointerMove);
  document.body.addEventListener('pointerup',     onCanvasPointerUp);
  document.body.addEventListener('pointercancel', onCanvasPointerUp);

  // Light haptic on every toggle button tap. Delegated, capture phase so we
  // fire even when the click handler stops propagation. Filtered to .ctrl-btn
  // / .qp-toggle so plain text and selects don't buzz.
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.ctrl-btn, .qp-toggle');
    if (!btn) return;
    // Skip the (large) source link — it's an external nav, not a state toggle.
    if (btn.tagName === 'A') return;
    hapticPulse(6);
  }, true);

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
  // Mosh / edge card lookups must happen before the overlay-toggle wiring
  // below, because syncPostBtns toggles their visibility.
  const moshCard = document.getElementById('mosh-card');
  const edgeCard = document.getElementById('edge-card');

  wireOverlayToggle(btnSkel,    'skeleton');
  wireOverlayToggle(btnSparks,  'sparks');
  wireOverlayToggle(btnAura,    'aura');
  wireOverlayToggle(btnRipples, 'ripples');

  // ── Glitches: ascii / mosh / edge share the same multi-state semantics ──
  // (off / on / blip / flip). blip + flip react to hard kicks (see the
  // core.onFrame handler below). 'on' is the only mode that participates
  // in auto-phase rotation. Buttons cycle modes on click; the active
  // class is bound to the MODE (not the overlay option) so a glitch in
  // 'on' still reads as active even when auto-phase has temporarily
  // switched the overlay onto a different roster member.
  const btnByGlitch = { ascii: btnAscii, mosh: btnMosh, edge: btnEdge };
  function refreshGlitchBtn(glitch) {
    const btn = btnByGlitch[glitch];
    if (!btn) return;
    const mode = glitchModes[glitch];
    btn.textContent = `${glitch} ${mode}`;
    btn.classList.toggle('active', mode !== 'off');
    btn.title = `${glitch} post-process — off / on / blip / flip — blip + flip react to hard kicks`;
  }
  function setGlitchMode(glitch, mode) {
    if (!GLITCH_MODES.includes(mode)) return;
    if (!GLITCH_KEYS.includes(glitch)) return;
    glitchModes[glitch] = mode;
    blipExpiresAt[glitch] = 0;
    // Sync overlay option: 'on' shows, reactive modes start hidden and
    // are toggled by the kick handler. 'off' hides. The overlay's
    // internal ascii/mosh/edge mutex still keeps only one rendering at
    // a time when the user has multiple set to 'on' — auto-phase rotation
    // is what moves between them in that case.
    overlay.setOption(glitch, mode === 'on');
    refreshGlitchBtn(glitch);
    syncPostBtns();
    // Re-sync the phase timer if a glitch's mode change affects the chapters
    // boundary (active roster shifted). Reuses the existing chapter-reset
    // path below by deferring to the next tick.
    settings.save();
  }
  function cycleGlitchMode(glitch) {
    const i = GLITCH_MODES.indexOf(glitchModes[glitch]);
    setGlitchMode(glitch, GLITCH_MODES[(i + 1) % GLITCH_MODES.length]);
  }
  btnAscii.addEventListener('click', () => cycleGlitchMode('ascii'));
  btnMosh.addEventListener('click',  () => cycleGlitchMode('mosh'));
  btnEdge.addEventListener('click',  () => cycleGlitchMode('edge'));

  // Sync each glitch button + its associated tunable card with current
  // state. Tunable cards are shown when the glitch is in any non-'off'
  // mode so the user can dial the look while it's (or it'll be) live.
  function syncPostBtns() {
    for (const g of GLITCH_KEYS) refreshGlitchBtn(g);
    if (moshCard) moshCard.style.display = glitchModes.mosh !== 'off' ? '' : 'none';
    if (edgeCard) edgeCard.style.display = glitchModes.edge !== 'off' ? '' : 'none';
  }

  // Roster of glitches included in auto-phase rotation. Computed live from
  // current modes — only 'on' glitches participate; off / blip / flip are
  // skipped (per spec: blip + flip stay reactive on their own; off stays off).
  function getGlitchRoster() {
    return GLITCH_KEYS.filter(g => glitchModes[g] === 'on');
  }
  // Apply a rotation choice. `target` is either a glitch key or null (for
  // a no-glitch chapter). Only roster members get their overlay toggled —
  // we never touch glitches outside the roster, so blip / flip stay free
  // to do their kick-driven thing.
  function applyGlitchRotation(target) {
    const roster = getGlitchRoster();
    for (const g of roster) {
      overlay.setOption(g, g === target);
    }
  }

  // Mosh slider wiring — every input writes back into the overlay's
  // moshConfig. The overlay reads its own state each frame so changes
  // take effect on the next paint without further plumbing.
  function wireMoshSlider(qpId, key, fmt = (v) => v.toFixed(2)) {
    const row = document.querySelector(`[data-qp="${qpId}"]`);
    if (!row) return;
    const input = row.querySelector('input[type=range]');
    const val   = row.querySelector('.qp-val');
    const initial = overlay.getMoshConfig()[key];
    input.value = String(initial);
    val.textContent = fmt(initial);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      overlay.setMoshConfig({ [key]: v });
      val.textContent = fmt(v);
      settings.save();
    });
  }
  wireMoshSlider('mosh-intensity', 'intensity');
  wireMoshSlider('mosh-smear',     'smear');
  wireMoshSlider('mosh-glitch',    'glitchRate');
  wireMoshSlider('mosh-block',     'blockSize',  (v) => `${Math.round(v)}px`);
  wireMoshSlider('mosh-split',     'colorSplit', (v) => `${Math.round(v)}px`);
  // Restore the mosh-card collapse + show state from settings.
  if (typeof stored.moshCollapsed === 'boolean') {
    moshCard.classList.toggle('collapsed', stored.moshCollapsed);
  }

  // Edge-detect slider wiring — same pattern as mosh, just talks to
  // overlay.setEdgeConfig instead.
  function wireEdgeSlider(qpId, key, fmt = (v) => v.toFixed(2)) {
    const row = document.querySelector(`[data-qp="${qpId}"]`);
    if (!row) return;
    const input = row.querySelector('input[type=range]');
    const val   = row.querySelector('.qp-val');
    const initial = overlay.getEdgeConfig()[key];
    input.value = String(initial);
    val.textContent = fmt(initial);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      overlay.setEdgeConfig({ [key]: v });
      val.textContent = fmt(v);
      settings.save();
    });
  }
  wireEdgeSlider('edge-intensity', 'intensity');
  wireEdgeSlider('edge-threshold', 'threshold');
  wireEdgeSlider('edge-thickness', 'thickness');
  wireEdgeSlider('edge-glow',      'glow');
  if (edgeCard && typeof stored.edgeCollapsed === 'boolean') {
    edgeCard.classList.toggle('collapsed', stored.edgeCollapsed);
  }
  syncPostBtns();

  // ── Pause / Zen ───────────────────────────────────────────────────────────
  // Pause also silences the audio sources so the spacebar gesture matches the
  // live-performance expectation ("tap brake on everything"). Strudel + the
  // sequencer get a transport stop+restart; the vocoder mutes instead of
  // tearing down the mic stream (re-opening the mic prompts the OS indicator
  // and rebuilds the audio graph — too heavy for a single keypress).
  // _pauseAudioState remembers which sources were active pre-pause so they
  // don't surprise-start on resume.
  let _pauseAudioState = null;
  function setPaused(on) {
    core.setPaused(on);
    if (on && !_pauseAudioState) {
      _pauseAudioState = {
        strudel:      !!strudel?.isPlaying?.(),
        seq:          !!sequencer?.isPlaying?.(),
        vocoderMuted: !!vocoder?.isMuted?.(),
      };
      try { if (_pauseAudioState.strudel) strudel.stopPlayback?.(); } catch (e) { console.warn('[qualia] pause strudel stop failed:', e); }
      try { if (_pauseAudioState.seq)     sequencer.stop?.();       } catch (e) { console.warn('[qualia] pause seq stop failed:', e); }
      try { if (vocoder?.isActive?.())    vocoder.setMuted?.(true); } catch (e) { console.warn('[qualia] pause vocoder mute failed:', e); }
    } else if (!on && _pauseAudioState) {
      const s = _pauseAudioState;
      _pauseAudioState = null;
      // Strudel + sequencer have a sync bridge — starting either may
      // implicitly start the other when sync is armed. play() / stop()
      // early-return when already in the target state, so the explicit
      // double-call is safe and idempotent.
      try { if (s.strudel) strudel.play?.(); } catch (e) { console.warn('[qualia] resume strudel failed:', e); }
      try { if (s.seq)     sequencer.play?.(); } catch (e) { console.warn('[qualia] resume seq failed:', e); }
      try { vocoder?.setMuted?.(s.vocoderMuted); } catch (e) { console.warn('[qualia] resume vocoder unmute failed:', e); }
    }
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
    // Slide the mobile bottom tab bar off-screen too — without this, zen
    // mode left the tab strip pinned over the viz on phones. CSS `.zen`
    // on #panel-tabs handles the transition.
    const tabs = document.getElementById('panel-tabs');
    if (tabs) tabs.classList.toggle('zen', on);
    settings.save();
  }
  btnZen.addEventListener('click', () => setZen(!core.isZen()));
  zenHandle.addEventListener('click', () => setZen(false));

  // Browser fullscreen — hides chrome (URL bar, tabs) via the Fullscreen API.
  // Independent of zen mode (which only hides our in-page topbar/HUD), so the
  // two can compose: zen + fullscreen = no chrome anywhere.
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function setFullscreen(on) {
    if (on && !isFullscreen()) {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
    } else if (!on && isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
    }
  }
  function refreshFullscreenBtn() {
    btnFullscreen.classList.toggle('active', isFullscreen());
  }
  btnFullscreen.addEventListener('click', () => setFullscreen(!isFullscreen()));
  document.addEventListener('fullscreenchange', refreshFullscreenBtn);
  document.addEventListener('webkitfullscreenchange', refreshFullscreenBtn);

  // ── Screen recorder ──────────────────────────────────────────────────────
  // Two capture backends inside createRecorder: getDisplayMedia (desktop)
  // and a canvas.captureStream() fallback for mobile / restricted browsers
  // where getDisplayMedia is missing or silently fails. The fallback only
  // captures the fx canvas (no overlay/HUD), plus mic audio when live.
  // Chunks stream straight to disk via showSaveFilePicker (desktop) or
  // OPFS (mobile-friendly) so multi-hour sets don't OOM the tab — the
  // in-memory path is only the last-resort fallback.
  const recorder = createRecorder({
    getCanvas:    () => core.getCanvas?.(),
    getMicStream: () => audio.getMicStream?.(),
    onStateChange: ({ recording, backend, sink }) => {
      if (!btnRecord) return;
      btnRecord.classList.toggle('active-audio', recording);
      if (!recording) {
        btnRecord.textContent = 'rec';
        btnRecord.title = 'Record screen (Shift+R) — picks tab/window/screen via the browser share picker; tick to include audio';
        return;
      }
      const capLabel  = backend === 'canvas' ? 'fx canvas only (no HUD)' : 'full page';
      const sinkLabel = sink === 'fsa'    ? 'streaming to chosen file'
                      : sink === 'opfs'   ? 'streaming to disk (OPFS)'
                      : sink === 'memory' ? 'buffered in RAM'
                      : '';
      btnRecord.title = `Recording ${capLabel} · ${sinkLabel}. Shift+R or click to stop.`;
    },
  });
  if (btnRecord) {
    if (!recorder.isSupported()) {
      btnRecord.disabled = true;
      btnRecord.title = 'Screen recording not supported in this browser';
    }
    btnRecord.addEventListener('click', async () => {
      try {
        if (recorder.isRecording()) recorder.stop();
        else await recorder.start();
      } catch (err) {
        // User cancelled the share picker, or the browser denied it.
        // Only surface a real error — cancellation is expected and silent.
        if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
          alert(`Screen recording failed: ${err?.message || err}`);
        }
      }
    });
    // Per-second tick updates the "rec ●" label to "rec ● mm:ss" so the
    // user can see how long the recording has been running. Idle ticks
    // bail before touching the DOM.
    setInterval(() => {
      if (!recorder.isRecording()) return;
      const sec = Math.floor((performance.now() - recorder.getStartedAt()) / 1000);
      const mm = Math.floor(sec / 60).toString().padStart(2, '0');
      const ss = (sec % 60).toString().padStart(2, '0');
      btnRecord.textContent = `rec ● ${mm}:${ss}`;
    }, 1000);
  }

  // ── Reset fx params ───────────────────────────────────────────────────────
  fxResetBtn.addEventListener('click', () => core.applyFxPreset('default'));

  // ── Auto-phase + Auto-cycle ───────────────────────────────────────────────
  // Two independent automation tracks, each a multi-state button (like the
  // camera mode button). Click advances through the period array; the last
  // step wraps back to off. Tooltip lists the cycle so the muscle-memory is
  // discoverable.
  //   - phase: walks modes/presets WITHIN the active qfx (palettes, modes).
  //     Each QFXModule may declare `autoPhase: { steps: [...] }`. If the
  //     active quale has no autoPhase, the button reads "phase n/a" and
  //     clicks are no-ops.
  //   - cycle: swaps the active qfx itself. Sequential walks mesh order;
  //     random picks any other id. Manual switches reset the dwell via
  //     onFxChange so the new fx gets the full window.
  // Both tracks can run together — a quale phases through its modes for ~30s
  // (within-fx), then cycle picks the next quale and the new one phases.
  //
  // Settings migration. Two prior shapes coexist:
  //   v1 (older prod):   autoCycle/autoStyle (within-fx bool) +
  //                      fxAutoCycle/fxAutoStyle (cross-fx bool)
  //   v2 (recent rename): autoPhase/autoPhaseStyle (within) +
  //                      autoCycle/autoCycleStyle (cross, still bool)
  // v3 (this change) persists numeric periods. Detect v1 via the unique
  // `fxAutoCycle` key; otherwise read v2/v3 keys with bool→default-period
  // fallback so any truthy historical state lights up at a sensible default.
  const _isV1Shape = 'fxAutoCycle' in stored;
  const _phaseStyleRaw = _isV1Shape ? stored.autoStyle    : stored.autoPhaseStyle;
  const _cycleStyleRaw = _isV1Shape ? stored.fxAutoStyle  : stored.autoCycleStyle;
  // Phase period: prefer numeric v3 key; else map historical bool → 10s.
  const _phaseSecRaw = (typeof stored.autoPhaseSeconds === 'number')
    ? stored.autoPhaseSeconds
    : ((_isV1Shape ? stored.autoCycle : stored.autoPhase) ? 10 : 0);
  // Cycle period: prefer numeric v3 key; else map historical bool → 30s.
  // Note that `stored.autoCycle` means within-fx in v1 but cross-fx in v2,
  // so the v1 gate matters here.
  const _cycleSecRaw = (typeof stored.autoCycleSeconds === 'number')
    ? stored.autoCycleSeconds
    : ((_isV1Shape ? stored.fxAutoCycle : stored.autoCycle) ? 30 : 0);

  // — Auto-phase (within-fx) —
  // Period 0 means "off"; any positive value runs a setInterval that calls
  // phaseNext() every `autoPhaseSeconds`. The press-cycles-through-states
  // design means we never need a separate startPhase/stopPhase split — the
  // setPhasePeriod helper handles every transition.
  let autoPhaseSeconds = PHASE_PERIODS.includes(_phaseSecRaw) ? _phaseSecRaw : 0;
  let autoPhaseStyle = AUTO_PHASE_STYLES.includes(_phaseStyleRaw) ? _phaseStyleRaw : 'chapters';
  let autoPhaseBeatSync = !!stored.autoPhaseBeatSync;
  let autoPhaseStartMs = 0;
  let autoPhaseStepCount = 0;
  let autoPhaseTickT = null;
  phaseStyleSelect.value = autoPhaseStyle;
  // Tooltip lists the cycle so muscle-memory builds; users see "off → 5 →
  // 10 → 15" without poking the button to find the upper bound.
  btnPhase.title = 'Phase modes within active quale (L) — off / 5s / 10s / 15s';

  function getActivePhaseSteps() {
    const mod = mesh.get(core.activeId());
    return mod?.autoPhase?.steps ?? null;
  }

  function refreshPhaseBtn() {
    const supported = !!getActivePhaseSteps();
    // Always enabled — clicks change the user's intent regardless of
    // whether the active quale can act on it. Period change "stickiness"
    // means a click while on a non-supporting quale still adjusts the
    // period and resumes when cycle hits a supporting one.
    btnPhase.disabled = false;
    btnPhase.classList.toggle('active', autoPhaseSeconds > 0);
    if (!supported) {
      // Show the preserved period in parens so the user can see their
      // intent isn't lost — it'll resume on the next supporting quale.
      btnPhase.textContent = autoPhaseSeconds > 0
        ? `phase n/a (${autoPhaseSeconds}s)`
        : 'phase n/a';
      btnPhase.title = autoPhaseSeconds > 0
        ? `phase set to ${autoPhaseSeconds}s — active quale has no phases; resumes on next supporting qfx (L cycles)`
        : 'active quale has no phases (L cycles: off / 5s / 10s / 15s)';
      return;
    }
    btnPhase.title = 'Phase modes within active quale (L) — off / 5s / 10s / 15s';
    if (autoPhaseSeconds > 0) {
      const elapsed = (performance.now() - autoPhaseStartMs) / 1000;
      const remaining = Math.max(0, Math.ceil(autoPhaseSeconds - elapsed));
      if (autoPhaseBeatSync && audioActive()) {
        btnPhase.textContent = remaining > 0 ? `phase ${remaining}s ♪` : 'phase ♪';
      } else if (autoPhaseBeatSync) {
        btnPhase.textContent = `phase ${remaining}s (♪)`;
      } else {
        btnPhase.textContent = `phase ${remaining}s`;
      }
    } else {
      btnPhase.textContent = 'phase off';
    }
  }

  function phaseNext() {
    const steps = getActivePhaseSteps();
    if (!steps || !steps.length) return;
    autoPhaseStepCount++;
    const step = steps[autoPhaseStepCount % steps.length];
    // Glitch scheduling. Roster = glitches whose mode is 'on'; off / blip /
    // flip are skipped so they keep doing their own thing. Step granularity
    // == one phase-step. With one roster member this falls back to the old
    // single-glitch on/off chapters behavior; with multiple, each chapter
    // (and alternate / random tick) round-robins between them.
    const roster = getGlitchRoster();
    if (roster.length > 0) {
      const pool = ['off', ...roster];   // 'off' = no glitch chapter
      switch (autoPhaseStyle) {
        case 'chapters': {
          // One full pass through the phase steps = one chapter. Alternate
          // between off-chapters and roster-chapters; the roster-chapter
          // index advances each time we land on one (so chapters cycle
          // through all roster members over time).
          const pass = Math.floor(autoPhaseStepCount / steps.length);
          if (pass % 2 === 0) {
            applyGlitchRotation(null);
          } else {
            const rIdx = ((pass - 1) >> 1) % roster.length;
            applyGlitchRotation(roster[rIdx]);
          }
          break;
        }
        case 'alternate': {
          // Each step bumps to the next entry in [off, ...roster].
          const idx = autoPhaseStepCount % pool.length;
          applyGlitchRotation(pool[idx] === 'off' ? null : pool[idx]);
          break;
        }
        case 'random': {
          // 30% off, otherwise pick a random roster member.
          if (Math.random() < 0.3) applyGlitchRotation(null);
          else applyGlitchRotation(roster[(Math.random() * roster.length) | 0]);
          break;
        }
        case 'hold':
        default: break;
      }
    }
    // Apply the step's partial params via core.setParam so the panel UI
    // and persistence stay in sync.
    const fxId = core.activeId();
    if (fxId) {
      for (const [k, v] of Object.entries(step)) {
        core.setParam(fxId, k, v);
      }
    }
  }

  function tickPhase() {
    if (autoPhaseSeconds <= 0) { refreshPhaseBtn(); return; }
    const now = performance.now();
    const elapsed = (now - autoPhaseStartMs) / 1000;
    refreshPhaseBtn();
    if (autoPhaseBeatSync && audioActive()) {
      // Beat-sync mode: dwell time is a floor (cooldown), 2× dwell is the
      // silence-fallback ceiling. Between floor and ceiling, fire on a
      // beat that arrives AFTER the floor timestamp.
      if (elapsed >= autoPhaseSeconds * 2) {
        autoPhaseStartMs = now;
        phaseNext();
        return;
      }
      if (elapsed >= autoPhaseSeconds) {
        const floorMs = autoPhaseStartMs + autoPhaseSeconds * 1000;
        if (lastBeatAt > floorMs) {
          autoPhaseStartMs = now;
          phaseNext();
        }
      }
      return;
    }
    if (elapsed >= autoPhaseSeconds) {
      autoPhaseStartMs = now;
      phaseNext();
    }
  }

  // Sync the running interval with current intent + quale support. Stops
  // the timer when off or unsupported; (re)starts it otherwise. Does NOT
  // mutate autoPhaseSeconds — that's the user's preserved intent and
  // needs to survive cycling through a quale that lacks phase support so
  // the next supporting quale resumes at the chosen period.
  function syncPhaseTimer() {
    if (autoPhaseTickT) { clearInterval(autoPhaseTickT); autoPhaseTickT = null; }
    if (autoPhaseSeconds > 0 && getActivePhaseSteps()) {
      autoPhaseStartMs = performance.now();
      autoPhaseStepCount = 0;
      // Reset roster glitches to off at the start of a chapters pass so
      // the first chapter is the off-chapter. Only roster ('on') glitches
      // are touched — blip / flip stay reactive on their own.
      if (autoPhaseStyle === 'chapters') applyGlitchRotation(null);
      autoPhaseTickT = setInterval(tickPhase, 250);
    }
  }

  // Single source of truth for user-driven period changes. Updates intent,
  // re-syncs the timer, refreshes the button, persists.
  function setPhasePeriod(seconds) {
    autoPhaseSeconds = seconds;
    syncPhaseTimer();
    btnPhase.classList.toggle('active', autoPhaseSeconds > 0);
    refreshPhaseBtn();
    settings.save();
  }

  btnPhase.addEventListener('click', () => {
    const i = PHASE_PERIODS.indexOf(autoPhaseSeconds);
    const next = PHASE_PERIODS[(i + 1) % PHASE_PERIODS.length];
    setPhasePeriod(next);
  });
  phaseStyleSelect.addEventListener('change', () => {
    autoPhaseStyle = phaseStyleSelect.value;
    autoPhaseStepCount = 0;
    if (autoPhaseSeconds > 0 && autoPhaseStyle === 'chapters') {
      applyGlitchRotation(null);
    }
    settings.save();
  });

  // — Auto-cycle (cross-fx) —
  let autoCycleSeconds = CYCLE_PERIODS.includes(_cycleSecRaw) ? _cycleSecRaw : 0;
  let autoCycleStyle = AUTO_CYCLE_STYLES.includes(_cycleStyleRaw) ? _cycleStyleRaw : 'sequential';
  let autoCycleBeatSync = !!stored.autoCycleBeatSync;
  let autoCycleStartMs = 0;
  let autoCycleTickT = null;
  cycleStyleSelect.value = autoCycleStyle;
  btnCycle.title = 'Cycle between qualia (N) — off / 5s / 15s / 30s / 45s';

  function refreshCycleBtn() {
    if (!btnCycle) return;
    if (autoCycleSeconds > 0) {
      const elapsed = (performance.now() - autoCycleStartMs) / 1000;
      const remaining = Math.max(0, Math.ceil(autoCycleSeconds - elapsed));
      // Beat-sync visual states:
      //   beat-sync ON, audio ON, in cooldown → "Ns ♪"  (floor counting down)
      //   beat-sync ON, audio ON, armed       → "♪"     (waiting for kick)
      //   beat-sync ON, audio OFF             → "Ns (♪)" (parens flag the
      //     setting is on but audio is off so the cycle is firing on time
      //     anyway — explicit visual cue, not a silent fall-through)
      //   beat-sync OFF                       → "Ns"
      if (autoCycleBeatSync && audioActive()) {
        btnCycle.textContent = remaining > 0 ? `cycle ${remaining}s ♪` : 'cycle ♪';
      } else if (autoCycleBeatSync) {
        btnCycle.textContent = `cycle ${remaining}s (♪)`;
      } else {
        btnCycle.textContent = `cycle ${remaining}s`;
      }
    } else {
      btnCycle.textContent = 'cycle off';
    }
  }

  function cycleNext() {
    const ids = mesh.ids();
    if (ids.length < 2) return;
    const excluded = loadCycleExcluded();
    const totalN   = ids.length;
    const inPool   = (id) => isInCycle(excluded, id, totalN);
    const cur = core.activeId();
    let nextId;
    if (autoCycleStyle === 'random') {
      const candidates = ids.filter(id => id !== cur && inPool(id));
      // If the user has excluded everything but the current one, just stay
      // put — no good alternative to switch to.
      nextId = candidates.length > 0
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : cur;
    } else {
      // Sequential — walk from cur+1 in declaration order, skipping any
      // ids that aren't in the cycle pool. Bounded loop in case every id
      // is excluded somehow (shouldn't happen — isInCycle falls back to
      // "all in" when excluded covers everything).
      let i = (ids.indexOf(cur || ids[0]) + 1) % ids.length;
      let safety = ids.length;
      while (safety-- > 0 && !inPool(ids[i])) {
        i = (i + 1) % ids.length;
      }
      nextId = ids[i];
    }
    if (!nextId || nextId === cur) return;
    core.setActive(nextId).catch(err => console.error('[qualia] cycle setActive failed:', err));
  }

  // Beat-sync only counts when there's an actual audio source. With audio
  // off the trigger never fires, so we fall through to time-based behavior
  // (matches the documented "audio=off → fall through to time cycle"
  // contract).
  function audioActive() { return audioMode !== 'off'; }

  function tickCycle() {
    if (autoCycleSeconds <= 0) { refreshCycleBtn(); return; }
    const now = performance.now();
    const elapsed = (now - autoCycleStartMs) / 1000;
    refreshCycleBtn();
    if (autoCycleBeatSync && audioActive()) {
      // Beat-sync mode: dwell time is a floor (cooldown), 2× dwell is the
      // silence-fallback ceiling. Between floor and ceiling, fire on the
      // next beat that arrives AFTER the floor timestamp (not just any
      // unconsumed beat — beats during the cooldown shouldn't count).
      if (elapsed >= autoCycleSeconds * 2) {
        cycleNext();
        return;
      }
      if (elapsed >= autoCycleSeconds) {
        const floorMs = autoCycleStartMs + autoCycleSeconds * 1000;
        if (lastBeatAt > floorMs) cycleNext();
      }
      return;
    }
    if (elapsed >= autoCycleSeconds) {
      // Don't reset autoCycleStartMs here — onFxChange does it after the
      // switch lands, so the dwell clock starts when the new fx is live.
      cycleNext();
    }
  }

  function setCyclePeriod(seconds) {
    if (autoCycleTickT) { clearInterval(autoCycleTickT); autoCycleTickT = null; }
    autoCycleSeconds = seconds;
    if (seconds > 0) {
      autoCycleStartMs = performance.now();
      autoCycleTickT = setInterval(tickCycle, 250);
    }
    btnCycle.classList.toggle('active', autoCycleSeconds > 0);
    refreshCycleBtn();
    settings.save();
  }

  btnCycle.addEventListener('click', () => {
    const i = CYCLE_PERIODS.indexOf(autoCycleSeconds);
    const next = CYCLE_PERIODS[(i + 1) % CYCLE_PERIODS.length];
    setCyclePeriod(next);
  });
  cycleStyleSelect.addEventListener('change', () => {
    autoCycleStyle = cycleStyleSelect.value;
    settings.save();
  });

  // ── Beat-sync toggles ────────────────────────────────────────────────────
  // Both cycle and phase use the same trigger source: rising edge of
  // beat.active. The user-set dwell time provides the gating — cycle dwell
  // (typically 15-45s) feels rarer than phase dwell (5-15s) naturally. We
  // tried using the hard-kick detector for cycle to get a more cinematic
  // "fires on big hits" feel, but its built-in 10s cooldown clashed with
  // short dwell times and made the cycle effectively never fire on beat.
  const btnCycleBeat = document.getElementById('btn-cycle-beat');
  const btnPhaseBeat = document.getElementById('btn-phase-beat');
  function refreshBeatSyncBtns() {
    if (btnCycleBeat) {
      btnCycleBeat.classList.toggle('active', autoCycleBeatSync);
      // Spell out the state in the label so the toggle is unambiguous —
      // colour alone is easy to miss inside the popover.
      btnCycleBeat.textContent = autoCycleBeatSync ? '♪ cycle on' : '♪ cycle off';
    }
    if (btnPhaseBeat) {
      btnPhaseBeat.classList.toggle('active', autoPhaseBeatSync);
      btnPhaseBeat.textContent = autoPhaseBeatSync ? '♪ phase on' : '♪ phase off';
    }
  }
  btnCycleBeat?.addEventListener('click', () => {
    autoCycleBeatSync = !autoCycleBeatSync;
    refreshBeatSyncBtns();
    refreshCycleBtn();
    settings.save();
  });
  btnPhaseBeat?.addEventListener('click', () => {
    autoPhaseBeatSync = !autoPhaseBeatSync;
    refreshBeatSyncBtns();
    refreshPhaseBtn();
    settings.save();
  });
  refreshBeatSyncBtns();

  // ── Cycle pool manager ───────────────────────────────────────────────────
  // Lets the user pick which quales the auto-cycle rotates through. Stored
  // as an EXCLUDED set in localStorage; cycleNext above filters by it.
  const cycleMgr         = document.getElementById('cycle-mgr');
  const cycleMgrBackdrop = document.getElementById('cycle-mgr-backdrop');
  const cycleMgrList     = document.getElementById('cycle-mgr-list');
  const cycleMgrAll      = document.getElementById('cycle-mgr-all');
  const cycleMgrNone     = document.getElementById('cycle-mgr-none');
  const cycleMgrClose    = document.getElementById('cycle-mgr-close');
  const btnCycleManage   = document.getElementById('btn-cycle-manage');

  function renderCycleMgrList() {
    if (!cycleMgrList) return;
    const excluded = loadCycleExcluded();
    const curId = core.activeId();
    cycleMgrList.innerHTML = '';
    for (const mod of mesh.list()) {
      const row = document.createElement('label');
      row.className = 'cycle-mgr-row' + (mod.id === curId ? ' active' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !excluded.has(mod.id);
      cb.addEventListener('change', () => {
        const cur = loadCycleExcluded();
        if (cb.checked) cur.delete(mod.id);
        else            cur.add(mod.id);
        saveCycleExcluded(cur);
      });
      const name = document.createElement('span');
      name.className = 'cycle-mgr-name';
      name.textContent = mod.name || mod.id;
      row.appendChild(cb);
      row.appendChild(name);
      cycleMgrList.appendChild(row);
    }
  }
  function openCycleMgr() {
    renderCycleMgrList();
    cycleMgr?.classList.add('visible');
    cycleMgrBackdrop?.classList.add('visible');
    closeAllGroupsExcept(null); // collapse the auto popover behind it
  }
  function closeCycleMgr() {
    cycleMgr?.classList.remove('visible');
    cycleMgrBackdrop?.classList.remove('visible');
  }

  btnCycleManage?.addEventListener('click', openCycleMgr);
  cycleMgrClose?.addEventListener('click', closeCycleMgr);
  cycleMgrBackdrop?.addEventListener('click', closeCycleMgr);
  cycleMgrAll?.addEventListener('click', () => {
    saveCycleExcluded(new Set());
    renderCycleMgrList();
  });
  cycleMgrNone?.addEventListener('click', () => {
    saveCycleExcluded(new Set(mesh.ids()));
    renderCycleMgrList();
  });
  // Repaint when the active quale changes so the highlighted "active" row
  // stays in sync if the manager happens to be open. (When the modal is
  // closed, renderCycleMgrList() reruns on next open anyway, so this is
  // only for the "manager open while user cycles via V/N keys" case.)
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && cycleMgr?.classList.contains('visible')) {
      closeCycleMgr();
    }
  });


  // Render initial labels (active class will catch up below if periods > 0).
  refreshPhaseBtn();
  refreshCycleBtn();
  btnPhase.classList.toggle('active', autoPhaseSeconds > 0);
  btnCycle.classList.toggle('active', autoCycleSeconds > 0);

  // ── Strudel + Hydra ───────────────────────────────────────────────────────
  // The onPlayStateChange callback lets transport sync flow Strudel →
  // sequencer (when the user hits ▶ in the Strudel panel and sync is
  // armed, the seq panel starts too). The sequencer is created below so
  // we close over a holder that gets populated after construction —
  // by the time Strudel actually fires play, the holder is set.
  let _sequencerRef = null;
  // Sync between strudel and sequencer is held off until BOTH panels have
  // been opened at least once this page session. On a fresh page load,
  // playing strudel before the user has ever seen the sequencer (or vice
  // versa) shouldn't auto-drive the other engine — they haven't opted in.
  // A panel restored from the previous session via wasOpenLastSession→
  // open() counts as opened, so reloads of an established setup behave
  // normally.
  function bothPanelsOpened() {
    return !!(strudel?.hasBeenOpened?.() && _sequencerRef?.hasBeenOpened?.());
  }
  const strudel = createStrudelHydra({
    audio,
    getField: () => core.field,
    setParam: (fxId, paramId, value) => core.setParam(fxId, paramId, value),
    scopeCanvas: document.getElementById('test-canvas'),
    onPlayStateChange: (playing) => {
      const seq = _sequencerRef;
      if (!seq?.isSyncOn?.()) return;
      if (!bothPanelsOpened()) return;
      try {
        if (playing) seq.playFromStrudel?.();
        else         seq.stopFromStrudel?.();
      } catch (e) { console.warn('[qualia] seq follow strudel transport failed:', e); }
    },
  });

  // ── Pattern sequencer (tone.js, second programmable audio source) ────────
  // Bidirectional CPS sync with Strudel. Two delivery paths, tried in
  // order so the toggle works regardless of which Strudel REPL build is
  // loaded:
  //   1. `strudel.getScheduler().setCps(v)` — direct call into the
  //      Strudel runtime. Most reliable; doesn't depend on whether the
  //      eval scope ever publishes setcps as a global.
  //   2. `globalThis.setcps(v)` — fallback for older Strudel builds.
  //
  // Reverse direction (Strudel → sequencer) gets installed as soon as
  // either hook becomes available: we monkey-patch scheduler.setCps if
  // present and globalThis.setcps if present, and either fires
  // `applyCpsFromStrudel` so a `setcps(2)` inside an evaluated pattern
  // bumps the sequencer's CPS to match.
  //
  // `isReady()` exposes "have we found at least one delivery path" so
  // the sequencer panel can paint a status indicator next to the sync
  // checkbox — without it, the user has no way to tell the difference
  // between "sync is armed but Strudel isn't loaded yet" and "sync is
  // broken".
  let _strudelSetCpsTimer = null;
  let _strudelGlobalWrapped = false;
  let _strudelSchedWrapped  = false;
  const _strudelReadyListeners = new Set();
  function strudelSyncReady() {
    if (_strudelGlobalWrapped) return true;
    if (_strudelSchedWrapped)  return true;
    // The wrap may not have happened yet but if either path EXISTS the
    // outbound direction will work — that's enough to call ourselves
    // connected from the user's POV.
    if (typeof globalThis.setcps === 'function') return true;
    try {
      const sched = strudel?.getScheduler?.();
      if (sched && typeof sched.setCps === 'function') return true;
    } catch {}
    return false;
  }
  function notifyStrudelReadyChange() {
    for (const cb of _strudelReadyListeners) {
      try { cb(strudelSyncReady()); } catch {}
    }
  }
  const seqSyncStrudel = {
    setCpsDebounced: (v) => {
      if (_strudelSetCpsTimer) clearTimeout(_strudelSetCpsTimer);
      _strudelSetCpsTimer = setTimeout(() => {
        _strudelSetCpsTimer = null;
        if (!bothPanelsOpened()) return;
        let delivered = false;
        try {
          const sched = strudel?.getScheduler?.();
          if (sched && typeof sched.setCps === 'function') {
            sched.setCps(v);
            delivered = true;
          }
        } catch {}
        if (!delivered) {
          try { if (typeof globalThis.setcps === 'function') { globalThis.setcps(v); delivered = true; } } catch {}
        }
      }, 150);
    },
    // Transport sync — sequencer asks us to mirror its play/stop into
    // Strudel. `fromSync: true` tells strudel-hydra to suppress its
    // onPlayStateChange callback for this invocation, breaking the
    // play→play→play feedback loop.
    playStrudel: () => {
      if (!bothPanelsOpened()) return;
      try { strudel?.play?.({ fromSync: true }); }
      catch (e) { console.warn('[qualia] strudel follow seq play failed:', e); }
    },
    stopStrudel: () => {
      if (!bothPanelsOpened()) return;
      try { strudel?.stop?.({ fromSync: true }); }
      catch (e) { console.warn('[qualia] strudel follow seq stop failed:', e); }
    },
    isReady: strudelSyncReady,
    onReadyChange: (cb) => {
      _strudelReadyListeners.add(cb);
      return () => _strudelReadyListeners.delete(cb);
    },
    // Title sync — sequencer uses these to default its name from the
    // strudel @title, to push a renamed sequencer pattern back into the
    // strudel buffer when sync is on, and to listen for @title changes
    // (random rolls, pattern loads, manual edits) so the sequencer name
    // can mirror them in real time. getStrudelTitle is intentionally
    // un-gated — it's a one-shot read at sequencer init to seed the
    // default pattern name, not a runtime sync event.
    getStrudelTitle: () => {
      try { return strudel?.patterns?.getCurrentTitle?.() || ''; }
      catch { return ''; }
    },
    setStrudelTitle: (name) => {
      if (!bothPanelsOpened()) return;
      try { strudel?.patterns?.setTitle?.(name); }
      catch (e) { console.warn('[qualia] strudel setTitle failed:', e); }
    },
    onStrudelTitleChange: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const gated = (title) => { if (bothPanelsOpened()) cb(title); };
      try { return strudel?.patterns?.onTitleChange?.(gated) || (() => {}); }
      catch { return () => {}; }
    },
  };
  const sequencer = createSequencer({ audio, syncStrudel: seqSyncStrudel });
  _sequencerRef = sequencer;

  // ── Vocoder (mic-driven channel vocoder for live narration) ─────────────
  // Owns its own AudioContext + getUserMedia stream so it can route to the
  // speakers without entangling with the analysis path or the strudel
  // mute-patch. Follows whichever mic the topbar picker is currently on.
  const vocoder = createVocoder({ getDeviceId: () => audio.getCurrentMicId() });
  _vocoderRef = vocoder;

  // Wrap both directions of CPS as soon as either hook appears. We poll
  // because Strudel lazy-loads on first panel open and its scheduler
  // takes a beat after that to materialise. Stop polling once both are
  // wrapped — re-mounts of the editor (pattern swap) reset
  // _strudelSchedWrapped so we'll wrap the new scheduler on the next
  // tick.
  const _strudelSyncPoll = setInterval(() => {
    let progressed = false;
    if (!_strudelGlobalWrapped && typeof globalThis.setcps === 'function') {
      const orig = globalThis.setcps;
      globalThis.setcps = function (v) {
        if (bothPanelsOpened()) {
          try { sequencer.applyCpsFromStrudel(+v); } catch {}
        }
        return orig.call(this, v);
      };
      _strudelGlobalWrapped = true;
      progressed = true;
    }
    if (!_strudelSchedWrapped) {
      try {
        const sched = strudel?.getScheduler?.();
        if (sched && typeof sched.setCps === 'function' && !sched.__qualiaWrapped) {
          const orig = sched.setCps.bind(sched);
          sched.setCps = function (v) {
            if (bothPanelsOpened()) {
              try { sequencer.applyCpsFromStrudel(+v); } catch {}
            }
            return orig(v);
          };
          sched.__qualiaWrapped = true;
          _strudelSchedWrapped = true;
          progressed = true;
        }
      } catch {}
    }
    if (progressed) notifyStrudelReadyChange();
    // Once both directions are wrapped there's nothing left to discover —
    // stop polling. (If Strudel later swaps in a new scheduler instance
    // via pattern reload, the existing wrapped function lives on the
    // prototype's reference; we accept that small risk to avoid forever
    // ticking. A future fix could re-arm on strudel.onEditorMount().)
    if (_strudelGlobalWrapped && _strudelSchedWrapped) {
      clearInterval(_strudelSyncPoll);
    }
  }, 250);

  // ── Cursor fx (pointer-trail overlay) ─────────────────────────────────────
  const cursorFx = createCursorFx();
  cursorFx.loadStored();
  const btnCursor = document.getElementById('btn-cursor');
  function refreshCursorBtn() {
    const m = cursorFx.getMode();
    btnCursor.textContent = m === 'off' ? 'cursor off' : `cursor ${m}`;
    btnCursor.classList.toggle('active', m !== 'off');
  }
  refreshCursorBtn();
  btnCursor?.addEventListener('click', () => {
    cursorFx.cycle();
    refreshCursorBtn();
  });

  // Now that every reactive state variable (overlay, glitchModes,
  // autoPhaseSeconds, autoCycleSeconds, ...) is bound, hook
  // settings.save so each persistence write also re-evaluates the
  // group trigger dots. Earlier wraps would hit TDZ on the let
  // bindings; wrapping here keeps the dot in sync with whichever
  // toggle the user just flipped without each handler having to
  // remember to call refreshGroupActiveDots itself.
  const _origSettingsSave = settings.save.bind(settings);
  settings.save = function patchedSave() {
    _origSettingsSave();
    try { refreshGroupActiveDots(); } catch {}
  };
  // Initial paint — kicks the dots after every let has bound, since
  // the earlier rAF-based init runs before this wrap is installed.
  refreshGroupActiveDots();

  // ── Strudel tabs + pattern manager UI ─────────────────────────────────────
  const tabBar       = document.getElementById('strudel-tabs');
  const editorPane   = document.getElementById('strudel-mount');
  const patternsPane = document.getElementById('strudel-patterns');
  const patListEl    = document.getElementById('pat-list');
  function setStrudelTab(name) {
    tabBar?.querySelectorAll('.sp-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === name));
    if (editorPane)   editorPane.style.display   = name === 'editor'   ? '' : 'none';
    if (patternsPane) patternsPane.style.display = name === 'patterns' ? 'flex' : 'none';
    if (name === 'patterns') renderPatternList();
  }
  tabBar?.querySelectorAll('.sp-tab').forEach(t => {
    t.addEventListener('click', () => setStrudelTab(t.dataset.tab));
  });

  function renderPatternList() {
    if (!patListEl) return;
    const list = strudel.patterns.list();
    patListEl.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'sp-pat-empty';
      empty.textContent = 'no saved patterns yet — hit "save current" to add one';
      patListEl.appendChild(empty);
      return;
    }
    for (const p of list) {
      const meta = strudel.patterns.meta(p.code);
      const row = document.createElement('div');
      row.className = 'sp-pat-row';

      const metaCol = document.createElement('div');
      metaCol.className = 'sp-pat-meta';
      const nameInput = document.createElement('input');
      nameInput.className = 'sp-pat-name';
      nameInput.value = p.name;
      nameInput.title = 'rename';
      nameInput.addEventListener('change', () => {
        const next = nameInput.value.trim();
        if (next && next !== p.name) {
          strudel.patterns.update(p.id, { name: next });
          renderPatternList();
        }
      });
      const byLine = document.createElement('div');
      byLine.className = 'sp-pat-by';
      const byParts = [];
      if (meta.by)      byParts.push(`by ${meta.by}`);
      if (meta.license) byParts.push(meta.license);
      byParts.push(new Date(p.updatedAt).toLocaleDateString());
      byLine.textContent = byParts.join(' · ');
      metaCol.append(nameInput, byLine);

      const actions = document.createElement('div');
      actions.className = 'sp-pat-actions';
      const mkBtn = (label, title, fn) => {
        const b = document.createElement('button');
        b.className = 'ctrl-btn';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', fn);
        return b;
      };
      actions.append(
        mkBtn('load',     'Load into editor',      () => { setStrudelTab('editor'); strudel.patterns.load(p.id); }),
        mkBtn('clone',    'Duplicate this entry',  () => { strudel.patterns.clone(p.id); renderPatternList(); }),
        mkBtn('download', 'Download as .strudel',  () => strudel.patterns.download(p.id)),
        mkBtn('delete',   'Remove from list',      () => {
          if (confirm(`Delete "${p.name}"?`)) {
            strudel.patterns.remove(p.id);
            renderPatternList();
          }
        }),
      );
      row.append(metaCol, actions);
      patListEl.appendChild(row);
    }
  }
  document.getElementById('btn-pat-save')?.addEventListener('click', () => {
    const code = strudel.patterns.getCurrentCode();
    if (!code) return;
    // Pick a name without prompting — the row exposes inline rename, so a
    // blocking dialog just gets in the way of save-fast workflows.
    // Prefer the @title metadata when present; otherwise stamp with the
    // local time so the entry is at least uniquely identifiable.
    const meta = strudel.patterns.meta(code);
    const name = meta.title
              || `pattern ${new Date().toLocaleString('sv-SE').replace(' ', ' ')}`;
    strudel.patterns.add(name);
    renderPatternList();
  });
  // Reveal the editor pane BEFORE asking strudel to instantiate the new
  // pattern — CodeMirror won't lay out inside a `display:none` container,
  // which leaves readEditorCode() empty and the auto-resume retry can
  // never reach the "stable content" stage to fire play().
  document.getElementById('btn-pat-new')?.addEventListener('click', () => {
    setStrudelTab('editor');
    strudel.patterns.newBlank();
  });
  document.getElementById('btn-pat-random')?.addEventListener('click', () => {
    setStrudelTab('editor');
    strudel.patterns.random();
  });

  // ── Sequencer pattern-manager toolbar ────────────────────────────────────
  // Same shape as the Strudel toolbar above so the user has muscle memory:
  // save current grid, drop to a blank one, or roll a new groove.
  document.getElementById('btn-seq-pat-save')?.addEventListener('click', () => {
    sequencer.patterns.add();
    // Switch to the patterns tab so the freshly-saved entry is visible.
    document.querySelector('#sequencer-tabs .sp-tab[data-tab="patterns"]')?.click();
  });
  document.getElementById('btn-seq-pat-new')?.addEventListener('click', () => {
    document.querySelector('#sequencer-tabs .sp-tab[data-tab="grid"]')?.click();
    sequencer.patterns.newBlank();
  });
  document.getElementById('btn-seq-pat-random')?.addEventListener('click', () => {
    document.querySelector('#sequencer-tabs .sp-tab[data-tab="grid"]')?.click();
    sequencer.patterns.random();
  });

  // ── Qualem (state snapshots) ─────────────────────────────────────────────
  // A "qualem" is the singular noun for one entire macro-experience: every
  // fx's params + modweights, top-level toggles, audio + pose + overlay
  // settings, glitch modes, auto-phase/cycle, camera transform, cycle-pool
  // exclusions, the live strudel pattern, the sequencer model, vocoder
  // config, and panel layout. Captured into a JSON document; recall
  // restores the full setup live (no page reload).
  //
  // Capture is sparse by default — for each fx we diff against the schema
  // defaults so future builds whose defaults shift don't lock the user
  // into stale values, and so URL-encoded payloads stay small. The list
  // is keyed under `voidstar.qualia.qualem.list`.
  //
  // Sharing: each row + a toolbar button open a popover with a self-
  // contained URL (`#q=<base64url-gzip-json>`) that any other instance of
  // the page can auto-apply. Hardware (mic / cam) match by stored deviceId
  // first, then label / fuzzy label / facingMode; full enumeration-based
  // fallback lives in qualem.pickBestDevice.

  const qualemListEl     = document.getElementById('qualem-list');
  const qualemFileInput  = document.getElementById('qualem-file-input');
  const qualemShare      = document.getElementById('qualem-share');
  const qualemShareBack  = document.getElementById('qualem-share-backdrop');
  const qualemShareUrl   = document.getElementById('qualem-share-url');
  const qualemShareCopy  = document.getElementById('qualem-share-copy');
  const qualemShareOpen  = document.getElementById('qualem-share-open');
  const qualemShareClose = document.getElementById('qualem-share-close');
  const qualemShareStat  = document.getElementById('qualem-share-status');

  /**
   * Scoop the entire live state into a qualem document. Sparse capture
   * (default) drops fx params that match their schema default — the rest of
   * the document records exact values, since "default" is a fuzzy concept
   * for top-level toggles whose user intent matters even when they happen
   * to coincide with the factory state.
   */
  function captureQualem({ name, full = false } = {}) {
    const isSparse  = !full;
    const activeFxId = core.activeId();

    // Per-fx params + modweights from localStorage covers inactive fx.
    // The active fx's *unsaved* slider edits are picked up by also overlaying
    // core.getBaseParams() on top.
    const fx = {};
    for (const mod of mesh.list()) {
      const params     = loadFxParams(mod.id);
      const modweights = loadFxModWeights(mod.id);
      const entry = {};
      if (params) {
        entry.params = isSparse ? qualem.sparseFxParams(mod, params) : params;
      }
      if (modweights && Object.keys(modweights).length) {
        entry.modweights = modweights;
      }
      const hasParams = entry.params && Object.keys(entry.params).length;
      const hasMods   = entry.modweights && Object.keys(entry.modweights).length;
      if (hasParams || hasMods) fx[mod.id] = entry;
    }
    // Overlay live (unsaved) values for the active fx.
    if (activeFxId) {
      const activeMod = mesh.get(activeFxId);
      const live      = core.getBaseParams();
      const liveParams = isSparse ? qualem.sparseFxParams(activeMod, live) : live;
      if (liveParams && Object.keys(liveParams).length) {
        fx[activeFxId] = { ...(fx[activeFxId] || {}), params: liveParams };
      }
    }

    // Name source priority: explicit arg → strudel @title (canonical user-
    // facing name; users rename strudel patterns inline so this is what they
    // expect to see) → timestamp fallback. The sequencer model.name is
    // patched to match below so all three names align.
    const strudelCode  = strudel.patterns.getCurrentCode() || '';
    const strudelTitle = parseStrudelMeta(strudelCode).title;
    const qualemName   = name
      || strudelTitle
      || `Qualem ${new Date().toLocaleString('sv-SE').slice(0, 16)}`;
    const seqModel = sequencer.patterns.getCurrent() || null;

    return {
      format:        qualem.QUALEM_FORMAT,
      schemaVersion: qualem.QUALEM_SCHEMA_VERSION,
      name:          qualemName,
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
      sparse:        isSparse,
      activeFxId,
      audio: {
        mode:     audioMode,
        tunables: audio.getTunables(),
      },
      pose: {
        source:     poseSelect.value,
        smoothing:  poseSmoothingValue,
        thresholds: pose.getThresholds(),
        lingerMs:   pose.getLingerMs(),
        numPoses:   pose.getNumPoses(),
      },
      overlay: {
        skeleton: overlay.getOption('skeleton'),
        sparks:   overlay.getOption('sparks'),
        aura:     overlay.getOption('aura'),
        ripples:  overlay.getOption('ripples'),
        mosh:     overlay.getMoshConfig(),
        edge:     overlay.getEdgeConfig(),
      },
      glitch: { ...glitchModes },
      auto: {
        phaseSeconds:  autoPhaseSeconds,
        phaseStyle:    autoPhaseStyle,
        phaseBeatSync: autoPhaseBeatSync,
        cycleSeconds:  autoCycleSeconds,
        cycleStyle:    autoCycleStyle,
        cycleBeatSync: autoCycleBeatSync,
      },
      camera: {
        rotation:    getRotation(),
        mirror:      getMirror(),
        zoom:        lastZoomValue,
        videoOffset: { ...videoOffset },
        sizeIdx:     camSizeIdx,
      },
      cards: {
        audio:  audioCard.classList.contains('collapsed'),
        pose:   poseCard?.classList.contains('collapsed') ?? true,
        diag:   document.getElementById('diag-card')?.classList.contains('collapsed') ?? true,
        params: document.getElementById('fx-card')?.classList.contains('collapsed') ?? false,
        mosh:   document.getElementById('mosh-card')?.classList.contains('collapsed') ?? true,
        edge:   document.getElementById('edge-card')?.classList.contains('collapsed') ?? true,
        camera: cameraCard?.classList.contains('collapsed') ?? true,
        qualem: document.getElementById('qualem-card')?.classList.contains('collapsed') ?? true,
      },
      cyclePool: { excluded: [...loadCycleExcluded()] },
      fx,
      strudel:   { code: strudelCode },
      sequencer: { model: seqModel ? { ...seqModel, name: qualemName } : null },
      vocoder:   vocoder.getConfig(),
      pausedZen: { paused: core.isPaused(), zen: core.isZen() },
      // Hardware fingerprint — deviceId only by default; the label is
      // already in localStorage via the picker. Cross-machine matching
      // upgrades inside qualem.pickBestDevice (label fuzzy → groupId →
      // facingMode → first-of-kind).
      devices: {
        mic: getStoredDeviceId('mic') ? { kind: 'audioinput', deviceId: getStoredDeviceId('mic') } : null,
        cam: getStoredDeviceId('cam') ? { kind: 'videoinput', deviceId: getStoredDeviceId('cam') } : null,
      },
    };
  }

  /**
   * Apply a qualem to the live page. Skips fields that are missing or
   * malformed so partial / older qualems still load gracefully. Async
   * because several stages (setActive, setNumPoses, setThresholds) await.
   */
  async function applyQualem(q) {
    if (!q || q.format !== qualem.QUALEM_FORMAT) return;

    // 1. Per-fx state → localStorage. core.setActive() picks them up on rebuild.
    if (q.fx && typeof q.fx === 'object') {
      for (const [fxId, body] of Object.entries(q.fx)) {
        if (body?.params)     saveFxParams(fxId, body.params);
        if (body?.modweights) saveFxModWeights(fxId, body.modweights);
      }
    }

    // 2. Devices — best-effort fingerprint match. We persist whatever we
    // chose so subsequent picker reopens reflect it.
    if (q.devices?.mic) {
      const id = await qualem.pickBestDevice(q.devices.mic);
      if (id) storeDeviceId('mic', id);
    }
    if (q.devices?.cam) {
      const id = await qualem.pickBestDevice(q.devices.cam);
      if (id) storeDeviceId('cam', id);
    }

    // 3. Active fx — clean rebuild that swallows the new fx params.
    if (q.activeFxId && mesh.get(q.activeFxId)) {
      try { await core.setActive(q.activeFxId); }
      catch (e) { console.warn('[qualia] qualem setActive failed:', e); }
      fxSelect.value = q.activeFxId;
    }

    // 4. Audio
    if (q.audio?.tunables) {
      audio.setTunables(q.audio.tunables);
      audioPanel.setTunables(q.audio.tunables);
      audioPanel.setActivePreset(null);
    }
    if (typeof q.audio?.mode === 'string') {
      try { await setAudioMode(q.audio.mode); } catch {}
    }

    // 5. Pose
    if (q.pose) {
      if (typeof q.pose.smoothing === 'number') {
        poseSmoothingValue = q.pose.smoothing;
        pose.setSmoothing(poseSmoothingValue);
        const sm  = document.querySelector('[data-qp="pose-smooth"] input[type=range]');
        const smv = document.querySelector('[data-qp="pose-smooth"] .qp-val');
        if (sm)  sm.value = String(poseSmoothingValue);
        if (smv) smv.textContent = `${Math.round(poseSmoothingValue * 100)}%`;
      }
      if (q.pose.thresholds) {
        try { await pose.setThresholds(q.pose.thresholds); } catch {}
      }
      if (typeof q.pose.lingerMs === 'number') pose.setLingerMs(q.pose.lingerMs);
      if (typeof q.pose.numPoses === 'number') {
        try { await pose.setNumPoses(q.pose.numPoses); } catch {}
        if (posesSelect) posesSelect.value = String(q.pose.numPoses);
      }
      if (typeof q.pose.source === 'string' && poseSelect.value !== q.pose.source) {
        poseSelect.value = q.pose.source;
        poseSelect.dispatchEvent(new Event('change'));
      }
    }

    // 6. Overlay
    if (q.overlay) {
      const overlayKeys = ['skeleton', 'sparks', 'aura', 'ripples'];
      for (const k of overlayKeys) {
        if (typeof q.overlay[k] === 'boolean') overlay.setOption(k, q.overlay[k]);
      }
      if (q.overlay.mosh) overlay.setMoshConfig(q.overlay.mosh);
      if (q.overlay.edge) overlay.setEdgeConfig(q.overlay.edge);
      // Repaint button active classes since wireOverlayToggle's listener
      // wasn't the source of these state changes.
      btnSkel?.classList.toggle('active',    !!q.overlay.skeleton);
      btnSparks?.classList.toggle('active',  !!q.overlay.sparks);
      btnAura?.classList.toggle('active',    !!q.overlay.aura);
      btnRipples?.classList.toggle('active', !!q.overlay.ripples);
    }

    // 7. Glitch modes
    if (q.glitch && typeof q.glitch === 'object') {
      for (const g of GLITCH_KEYS) {
        const m = q.glitch[g];
        if (typeof m === 'string' && GLITCH_MODES.includes(m)) {
          glitchModes[g] = m;
          // 'on' shows the overlay; reactive modes start hidden + flip on kick.
          overlay.setOption(g, m === 'on');
        }
      }
      syncPostBtns();
    }

    // 8. Auto-phase / cycle
    if (q.auto) {
      if (typeof q.auto.phaseStyle === 'string') {
        autoPhaseStyle = q.auto.phaseStyle;
        if (phaseStyleSelect) phaseStyleSelect.value = autoPhaseStyle;
      }
      if (typeof q.auto.cycleStyle === 'string') {
        autoCycleStyle = q.auto.cycleStyle;
        if (cycleStyleSelect) cycleStyleSelect.value = autoCycleStyle;
      }
      if (typeof q.auto.phaseBeatSync === 'boolean') autoPhaseBeatSync = q.auto.phaseBeatSync;
      if (typeof q.auto.cycleBeatSync === 'boolean') autoCycleBeatSync = q.auto.cycleBeatSync;
      if (typeof q.auto.phaseSeconds === 'number') {
        autoPhaseSeconds = q.auto.phaseSeconds;
        setPhasePeriod(autoPhaseSeconds);
      }
      if (typeof q.auto.cycleSeconds === 'number') {
        autoCycleSeconds = q.auto.cycleSeconds;
        setCyclePeriod(autoCycleSeconds);
      }
    }

    // 9. Camera transform
    if (q.camera) {
      if (typeof q.camera.rotation === 'number') {
        setRotation(q.camera.rotation);
        if (btnCamRotate) {
          btnCamRotate.textContent = `rot ${getRotation()}°`;
          btnCamRotate.classList.toggle('active', getRotation() !== 0);
        }
      }
      if (typeof q.camera.mirror === 'boolean') {
        setMirror(q.camera.mirror);
        btnCamMirror?.classList.toggle('active', getMirror());
      }
      if (typeof q.camera.zoom === 'number') lastZoomValue = q.camera.zoom;
      if (q.camera.videoOffset && typeof q.camera.videoOffset === 'object') {
        videoOffset = {
          dx: +q.camera.videoOffset.dx || 0,
          dy: +q.camera.videoOffset.dy || 0,
        };
        try { applyVideoOffset(); } catch {}
      }
      if (typeof q.camera.sizeIdx === 'number') {
        camSizeIdx = q.camera.sizeIdx;
        try { setCamSize(camSizeIdx); } catch {}
      }
    }

    // 10. Card collapse state
    if (q.cards) {
      const cardMap = {
        audio: 'audio-card', pose: 'pose-card', diag: 'diag-card',
        params: 'fx-card', mosh: 'mosh-card', edge: 'edge-card',
        camera: 'camera-card', qualem: 'qualem-card',
      };
      for (const [key, id] of Object.entries(cardMap)) {
        const el = document.getElementById(id);
        if (el && typeof q.cards[key] === 'boolean') {
          el.classList.toggle('collapsed', q.cards[key]);
        }
      }
    }

    // 11. Cycle-pool exclusions
    if (Array.isArray(q.cyclePool?.excluded)) {
      saveCycleExcluded(new Set(q.cyclePool.excluded));
    }

    // 12. Strudel pattern + sequencer model
    if (q.strudel?.code && typeof strudel.patterns.loadCode === 'function') {
      try { strudel.patterns.loadCode(q.strudel.code); } catch (e) { console.warn('[qualia] strudel loadCode failed:', e); }
    }
    if (q.sequencer?.model && typeof sequencer.patterns.applyModel === 'function') {
      try { sequencer.patterns.applyModel(q.sequencer.model); } catch (e) { console.warn('[qualia] sequencer applyModel failed:', e); }
    }

    // 13. Vocoder
    if (q.vocoder && typeof vocoder.setConfig === 'function') {
      try { vocoder.setConfig(q.vocoder); } catch (e) { console.warn('[qualia] vocoder setConfig failed:', e); }
    }

    // 14. Pause / zen
    if (q.pausedZen) {
      if (typeof q.pausedZen.paused === 'boolean') setPaused(q.pausedZen.paused);
      if (typeof q.pausedZen.zen    === 'boolean') setZen(q.pausedZen.zen);
    }

    // 15. Persist top-level settings shape so a refresh restores the same.
    settings.save();
  }

  /** Reset live state to a clean default qualem — fresh-visitor look. */
  async function applyDefaultQualem() {
    // Wipe all per-fx params + modweights so each fx's setActive picks up
    // schema defaults on next activation.
    for (const mod of mesh.list()) {
      try { localStorage.removeItem(`voidstar.qualia.fx.${mod.id}.params`); } catch {}
      try { localStorage.removeItem(`voidstar.qualia.fx.${mod.id}.modweights`); } catch {}
    }
    // Build a "blank" qualem reflecting the defaults the page boots with.
    const blank = {
      format:        qualem.QUALEM_FORMAT,
      schemaVersion: qualem.QUALEM_SCHEMA_VERSION,
      sparse:        true,
      activeFxId:    mesh.ids()[0],
      audio:   { mode: 'off', tunables: AUDIO_PRESETS.default },
      pose:    { source: 'off', smoothing: 0.5, lingerMs: 800, numPoses: 1 },
      overlay: { skeleton: true, sparks: true, aura: true, ripples: true },
      glitch:  { ascii: 'off', mosh: 'off', edge: 'off' },
      auto:    { phaseSeconds: 0, phaseStyle: 'chapters', phaseBeatSync: false,
                 cycleSeconds: 0, cycleStyle: 'sequential', cycleBeatSync: false },
      camera:  { rotation: 0, mirror: true, zoom: 1.0, videoOffset: { dx: 0, dy: 0 }, sizeIdx: 0 },
      cyclePool: { excluded: [] },
      fx: {},
      pausedZen: { paused: false, zen: false },
    };
    await applyQualem(blank);
  }

  /** Inline-rename row UI (mirrors the strudel patterns list at line ~2164). */
  function renderQualemList() {
    if (!qualemListEl) return;
    const list = qualem.loadList();
    qualemListEl.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'sp-pat-empty';
      empty.textContent = 'no saved qualems yet — hit "save current" to capture this state';
      qualemListEl.appendChild(empty);
      return;
    }
    for (const q of list) {
      const row = document.createElement('div');
      row.className = 'sp-pat-row';

      const metaCol = document.createElement('div');
      metaCol.className = 'sp-pat-meta';
      const nameInput = document.createElement('input');
      nameInput.className = 'sp-pat-name';
      nameInput.value = q.name;
      nameInput.title = 'rename';
      nameInput.addEventListener('change', () => {
        const next = nameInput.value.trim();
        if (next && next !== q.name) {
          // Propagate the rename into the embedded strudel @title and the
          // embedded sequencer model.name so all three stay aligned. Pure
          // qualem.js stays free of patterns.js — the patch lives here.
          const patch = { name: next };
          if (q.strudel?.code) {
            patch.strudel = { ...q.strudel, code: setStrudelMeta(q.strudel.code, 'title', next) };
          }
          if (q.sequencer?.model) {
            patch.sequencer = { ...q.sequencer, model: { ...q.sequencer.model, name: next } };
          }
          qualem.updateInList(q.id, patch);
          renderQualemList();
        }
      });
      const byLine = document.createElement('div');
      byLine.className = 'sp-pat-by';
      const stamp = new Date(q.updatedAt).toLocaleDateString();
      const fxName = mesh.get(q.activeFxId)?.name || q.activeFxId || '—';
      byLine.textContent = `${fxName} · ${stamp}`;
      metaCol.append(nameInput, byLine);

      const actions = document.createElement('div');
      actions.className = 'sp-pat-actions';
      const mkBtn = (label, title, fn) => {
        const b = document.createElement('button');
        b.className = 'ctrl-btn';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', fn);
        return b;
      };
      actions.append(
        mkBtn('load',     'Recall this qualem into the live state', async () => {
          try { await applyQualem(q); }
          catch (e) { console.error('[qualia] applyQualem failed:', e); alert('Load failed: ' + (e?.message || e)); }
        }),
        mkBtn('clone',    'Duplicate this entry', () => {
          qualem.cloneEntry(q.id);
          renderQualemList();
        }),
        mkBtn('share',    'Copy a self-contained share URL', () => openShare(q)),
        mkBtn('download', 'Download as .qualem.json', () => qualem.downloadQualem(q)),
        mkBtn('delete',   'Remove from list', () => {
          if (confirm(`Delete "${q.name}"?`)) {
            qualem.removeFromList(q.id);
            renderQualemList();
          }
        }),
      );
      row.append(metaCol, actions);
      qualemListEl.appendChild(row);
    }
  }

  // ── Toolbar wiring ────────────────────────────────────────────────────────
  document.getElementById('btn-qualem-save')?.addEventListener('click', () => {
    // No prompt — default to the strudel @title (most user-visible name
    // field) and stamp a timestamp fallback if it's missing. getCurrentTitle
    // also falls back to the persisted buffer when the live editor read
    // fails (e.g. panel never opened this session). Renames live in the
    // qualem panel where each row has an editable name input.
    const finalName = (strudel.patterns.getCurrentTitle?.() || '').trim()
      || `Qualem ${new Date().toLocaleString('sv-SE').slice(0, 16)}`;
    const captured = captureQualem({ name: finalName });
    qualem.addToList(captured, captured.name);
    renderQualemList();
  });
  document.getElementById('btn-qualem-new')?.addEventListener('click', async () => {
    if (!confirm('Reset live state to clean defaults? Saved qualems are kept.')) return;
    try { await applyDefaultQualem(); }
    catch (e) { console.error('[qualia] applyDefaultQualem failed:', e); }
  });
  // Random rolls only the audio patterns, on purpose: visuals stay put so the
  // user can A/B beats against a chosen quale. Mirrors the Strudel +
  // sequencer "random" buttons but with both engines rolled at once.
  document.getElementById('btn-qualem-random')?.addEventListener('click', () => {
    try { strudel.patterns.random(); } catch (e) { console.warn('[qualia] strudel random:', e); }
    try { sequencer.patterns.random(); } catch (e) { console.warn('[qualia] sequencer random:', e); }
  });
  document.getElementById('btn-qualem-import')?.addEventListener('click', () => {
    qualemFileInput?.click();
  });
  qualemFileInput?.addEventListener('change', async () => {
    const f = qualemFileInput.files?.[0];
    if (!f) return;
    qualemFileInput.value = ''; // allow same file twice in a row
    try {
      const q = await qualem.readFileAsQualem(f);
      // Imported qualems land in the library so they survive a reload.
      const entry = qualem.addToList(q, q.name);
      renderQualemList();
      if (confirm(`Imported "${entry.name}". Load it now?`)) {
        await applyQualem(entry);
      }
    } catch (e) {
      console.error('[qualia] qualem import failed:', e);
      alert('Import failed: ' + (e?.message || e));
    }
  });
  document.getElementById('btn-qualem-share-current')?.addEventListener('click', () => {
    openShare(captureQualem({}));
  });

  // ── Share popover ────────────────────────────────────────────────────────
  async function openShare(q) {
    if (!qualemShare) return;
    if (qualemShareStat) qualemShareStat.textContent = 'building URL…';
    qualemShareUrl.value = '';
    qualemShareBack.style.display = '';
    qualemShare.style.display = '';
    try {
      const url = await qualem.buildShareUrl(q);
      qualemShareUrl.value = url;
      qualemShareUrl.select();
      if (qualemShareStat) qualemShareStat.textContent = `${(url.length / 1024).toFixed(1)} KB`;
    } catch (e) {
      console.error('[qualia] buildShareUrl failed:', e);
      if (qualemShareStat) qualemShareStat.textContent = 'failed: ' + (e?.message || e);
    }
  }
  function closeShare() {
    if (!qualemShare) return;
    qualemShare.style.display = 'none';
    qualemShareBack.style.display = 'none';
    if (qualemShareStat) qualemShareStat.textContent = '';
  }
  qualemShareClose?.addEventListener('click', closeShare);
  qualemShareBack?.addEventListener('click', closeShare);
  qualemShareCopy?.addEventListener('click', async () => {
    const url = qualemShareUrl?.value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      if (qualemShareStat) qualemShareStat.textContent = 'copied';
    } catch {
      // Fallback: manual select for "copy" via keyboard.
      qualemShareUrl?.select();
      if (qualemShareStat) qualemShareStat.textContent = 'press ⌘/Ctrl+C';
    }
  });
  qualemShareOpen?.addEventListener('click', () => {
    const url = qualemShareUrl?.value;
    if (!url) return;
    window.open(url, '_blank', 'noopener');
  });

  // ── URL hash boot — auto-apply `#q=<encoded>` after boot settles ────────
  // Strudel uses the same UX. We decode synchronously and stash the qualem
  // on a closure variable; boot() applies it as its very last step so we
  // don't race against boot's own setActive(initialFx). The hash is cleared
  // via history.replaceState immediately so a subsequent reload uses the
  // user's saved settings instead of re-applying the qualem every refresh.
  let pendingUrlQualem = null;
  (async () => {
    try {
      const m = location.hash.match(/^#q=(.+)$/);
      if (!m) return;
      pendingUrlQualem = await qualem.decodeFromUrl(m[1]);
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      console.warn('[qualia] qualem URL decode failed:', e);
    }
  })();
  // Picked up by boot() after its initial setActive — keeps the qualem's
  // activeFxId choice from racing with the page's normal startup.
  async function applyPendingUrlQualem() {
    if (!pendingUrlQualem) return;
    const q = pendingUrlQualem;
    pendingUrlQualem = null;
    try { await applyQualem(q); }
    catch (e) { console.error('[qualia] qualem URL apply failed:', e); }
  }

  // First paint of the list once everything else is wired.
  renderQualemList();

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea, [contenteditable]')) return;
    if (strudel.isOpen()   && document.activeElement?.closest('#strudel-panel'))   return;
    if (sequencer.isOpen() && document.activeElement?.closest('#sequencer-panel')) return;
    if (vocoder.isOpen()   && document.activeElement?.closest('#vocoder-panel'))   return;

    switch (e.key.toLowerCase()) {
      case 'v': {
        const ids = mesh.ids();
        const i = ids.indexOf(core.activeId() || ids[0]);
        core.setActive(ids[(i + 1) % ids.length]);
        break;
      }
      case 'a': btnAudio.click(); break;
      case 's': document.getElementById('btn-strudel').click(); break;
      case 'q': document.getElementById('btn-sequencer').click(); break;
      case 'w': document.getElementById('btn-vocoder').click(); break;
      case 'p': {
        const opts = ['off','camera'];
        const i = opts.indexOf(poseSelect.value);
        poseSelect.value = opts[(i + 1) % opts.length];
        poseSelect.dispatchEvent(new Event('change'));
        break;
      }
      case 'c': if (btnCamera.style.display !== 'none') btnCamera.click(); break;
      case 'r':
        // Shift+R toggles screen recording (R alone is camera-rotate).
        if (e.shiftKey) btnRecord?.click();
        else if (btnCamRotate.style.display !== 'none') btnCamRotate.click();
        break;
      case 'm': if (btnCamMirror.style.display !== 'none') btnCamMirror.click(); break;
      case 'j': btnSkel.click(); break;
      case 'f': btnSparks.click(); break;
      case 'g': btnAura.click(); break;
      case 'b': btnRipples.click(); break;
      case 't': btnAscii.click(); break;
      case 'k': btnMosh.click(); break;
      case 'e': btnEdge.click(); break;
      case 'l': btnPhase.click(); break;
      case 'n': btnCycle.click(); break;
      case 'z': setZen(!core.isZen()); break;
      case 'x': btnFullscreen.click(); break;
      case ' ': btnPause.click(); e.preventDefault(); break;
    }
  });

  // ── FPS / level HUD + diagnostics panel ───────────────────────────────────
  // Per-frame rising-edge detection on transient pulses powers the rolling
  // 5-second counters in the diagnostics panel. The DOM updates are
  // throttled to the fps callback (~5×/sec) and skipped entirely when the
  // diagnostics card is collapsed.
  const diagFpsEl    = document.getElementById('diag-fps');
  const diagMsEl     = document.getElementById('diag-ms');
  const diagBassEl   = document.getElementById('diag-bass');
  const diagMidsEl   = document.getElementById('diag-mids');
  const diagHighsEl  = document.getElementById('diag-highs');
  const diagRmsEl    = document.getElementById('diag-rms');
  const diagBeatEl   = document.getElementById('diag-beat');
  const diagSnareEl  = document.getElementById('diag-snare');
  const diagHatEl    = document.getElementById('diag-hat');
  const diagPosesEl  = document.getElementById('diag-poses');
  const diagCard     = document.getElementById('diag-card');
  const beatTimes = [], snareTimes = [], hatTimes = [];
  function pruneOlderThan(arr, cutoff) {
    while (arr.length && arr[0] < cutoff) arr.shift();
  }
  let prevBeat = 0, prevSnare = 0, prevHat = 0;
  core.onFrame((field) => {
    const a = field.audio;
    const now = performance.now();
    if (a.beat.pulse  > 0.95 && prevBeat  < 0.95) beatTimes.push(now);
    if (a.mids.pulse  > 0.95 && prevSnare < 0.95) snareTimes.push(now);
    if (a.highs.pulse > 0.95 && prevHat   < 0.95) hatTimes.push(now);
    prevBeat = a.beat.pulse; prevSnare = a.mids.pulse; prevHat = a.highs.pulse;
  });

  // ── Hard-kick detector (shared) ──────────────────────────────────────────
  // Detects rising-edge sub-bass kicks: bass pulse above a strict threshold,
  // band absolutely loud, ≥92% of a slowly-decaying recent-rolling peak
  // (~6s half-life @ 60fps so quiet stretches re-calibrate), and bass
  // dominates mids/highs (rejects snares + full-spectrum metal hits). The
  // detector also enforces a 10s cooldown so it fires "occasionally" rather
  // than every kick.
  //
  // Two consumers downstream:
  //   - the glitch blip/flip handler (ASCII / mosh / edge flares)
  //   - the beat-sync auto-cycle (when enabled — gated by the dwell time)
  // Both read `lastHardKickAt`; their per-event consume tracking (compare
  // against a previously-seen timestamp) prevents double-fires.
  //
  // Also tracks `lastBeatAt` (any rising-edge beat regardless of strength),
  // which the beat-sync auto-phase consumer reads.
  let bassPeakEma     = 0;
  let prevReactiveBeat = 0;
  let prevAnyBeat      = 0;
  let lastHardKickAt   = 0;
  let lastBeatAt       = 0;
  core.onFrame((field) => {
    const a = field.audio;
    const now = performance.now();
    const beat = a.beat.pulse;
    const bass = a.bands.bass;
    const mids = a.bands.mids;
    const highs = a.bands.highs;
    // Generic beat tracker — rising edge of beat.active (a softer threshold
    // than hard-kick). Used by phase beat-sync.
    if (a.beat.active && prevAnyBeat < 0.5) lastBeatAt = now;
    prevAnyBeat = a.beat.active ? 1 : 0;
    // Hard-kick — rising edge above the strict pulse threshold, with all
    // the gating gates passing. Decays the EMA every frame so silence
    // re-calibrates the "powerful" baseline.
    bassPeakEma *= HARD_KICK_PEAK_DECAY;
    const rising = beat > HARD_KICK_PULSE_THRESH && prevReactiveBeat <= HARD_KICK_PULSE_THRESH;
    prevReactiveBeat = beat;
    if (rising) {
      const cooledDown = (now - lastHardKickAt) >= HARD_KICK_COOLDOWN_MS;
      const isLoud      = bass >= HARD_KICK_FLOOR;
      const isPeakLevel = bass >= bassPeakEma * HARD_KICK_RATIO;
      const isSubBass   = bass >= Math.max(mids, highs) * HARD_KICK_DOMINANCE;
      if (bass > bassPeakEma) bassPeakEma = bass;
      if (cooledDown && isLoud && isPeakLevel && isSubBass) {
        lastHardKickAt = now;
      }
    }
  });

  // ── Glitch reactive trigger ──────────────────────────────────────────────
  // Subscribes to the shared hard-kick detector above. When at least one of
  // the glitches is in 'blip' / 'flip' mode, every fresh hard-kick picks one
  // of those glitches at random and triggers it (the overlay's own ascii /
  // mosh / edge mutex enforces only one visible glitch at a time, so picking
  // one cleanly avoids last-iteration-wins flicker).
  let glitchLastConsumedHardKickAt = 0;
  core.onFrame((field) => {
    const reactive = GLITCH_KEYS.filter(g =>
      glitchModes[g] === 'blip' || glitchModes[g] === 'flip');
    if (reactive.length === 0) {
      for (const g of GLITCH_KEYS) blipExpiresAt[g] = 0;
      return;
    }
    const now = performance.now();
    if (lastHardKickAt > glitchLastConsumedHardKickAt) {
      glitchLastConsumedHardKickAt = lastHardKickAt;
      const winner = reactive[(Math.random() * reactive.length) | 0];
      if (glitchModes[winner] === 'blip') {
        overlay.setOption(winner, true);
        blipExpiresAt[winner] = now + BLIP_DURATION_MS;
      } else { // flip
        overlay.setOption(winner, !overlay.getOption(winner));
      }
    }
    // Auto-clear any active blips whose windows have elapsed.
    for (const g of reactive) {
      if (glitchModes[g] === 'blip' && blipExpiresAt[g] && now >= blipExpiresAt[g]) {
        overlay.setOption(g, false);
        blipExpiresAt[g] = 0;
      }
    }
  });

  core.onFps((fps, field) => {
    fpsEl.textContent = `${fps} fps`;
    if (audio.isEnabled()) {
      const fmt = v => Math.round(v * 99).toString().padStart(2, '0');
      lvlEl.textContent = `b${fmt(field.audio.bands.bass)} m${fmt(field.audio.bands.mids)} h${fmt(field.audio.bands.highs)}`;
    } else {
      lvlEl.textContent = 'audio off';
    }
    strudel.perFrame();
    sequencer.perFrame();

    if (diagCard && !diagCard.classList.contains('collapsed')) {
      const a = field.audio;
      const cutoff = performance.now() - 5000;
      pruneOlderThan(beatTimes,  cutoff);
      pruneOlderThan(snareTimes, cutoff);
      pruneOlderThan(hatTimes,   cutoff);
      diagFpsEl.textContent   = `${fps}`;
      diagMsEl.textContent    = `${(1000 / Math.max(fps, 1)).toFixed(1)}ms`;
      diagBassEl.textContent  = audio.isEnabled() ? a.bands.bass.toFixed(2)  : '—';
      diagMidsEl.textContent  = audio.isEnabled() ? a.bands.mids.toFixed(2)  : '—';
      diagHighsEl.textContent = audio.isEnabled() ? a.bands.highs.toFixed(2) : '—';
      diagRmsEl.textContent   = audio.isEnabled() ? a.rms.toFixed(2)         : '—';
      diagBeatEl.textContent  = `${beatTimes.length}`;
      diagSnareEl.textContent = `${snareTimes.length}`;
      diagHatEl.textContent   = `${hatTimes.length}`;
      diagPosesEl.textContent = `${field.pose.people.length}`;
    }
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

    // Restore audio source. `withMic` (from the "enable mic" overlay button)
    // forces audio mode to 'all' even if the persisted mode is 'off' — the
    // user explicitly requested mic via the boot overlay. Otherwise replay
    // the persisted mode (which itself decides whether to open the mic).
    if (opts.withMic && audioMode === 'off') audioMode = 'all';
    try {
      await setAudioMode(audioMode);
    } catch (err) {
      // Mic permission denied / no gesture / device gone — fall back to
      // off so the rest of the page stays functional. User can re-enable
      // via the audio button (which runs setAudioMode under a gesture).
      console.warn('[qualia] audio mode init failed; falling back to off:', err);
      audioMode = 'off';
      try { await setAudioMode('off'); } catch {}
    }
    if (stored.poseSource && stored.poseSource !== 'off') {
      poseSelect.value = stored.poseSource;
      poseSelect.dispatchEvent(new Event('change'));
    }
    if (stored.paused) setPaused(true);
    if (stored.zen)    setZen(true);
    // Re-arm phase + cycle timers from the persisted period. setPhasePeriod
    // is idempotent (just kicks the interval off) and handles the n/a
    // guard for quales that lack autoPhase.steps.
    if (autoPhaseSeconds > 0) setPhasePeriod(autoPhaseSeconds);
    if (autoCycleSeconds > 0) setCyclePeriod(autoCycleSeconds);

    // Apply a `#q=…` URL qualem (if any) AFTER the page's own startup so
    // the qualem's choice of activeFxId / audio mode / etc. wins without
    // racing against boot's initial setActive. Decode happened earlier
    // (synchronously when page-init ran) — this just runs the apply.
    await applyPendingUrlQualem();
  }
  startBtn.addEventListener('click', () => boot({ withMic: true }));
  startSilentBtn.addEventListener('click', () => boot({ withMic: false }));

  // Auto-boot for returning users — they've already chosen an audio
  // source, the "enable mic" overlay is just a friction click on every
  // reload. If the browser still requires a user gesture for mic
  // (rare — permission is usually persistent for the origin), the
  // setAudioMode call inside boot will throw and we fall back to
  // 'off'; the user can re-enable via the audio button.
  //
  // First-time visitors (no stored audio prefs) still see the overlay
  // so the very first mic-permission prompt happens after a deliberate
  // user gesture.
  const hasBootedBefore = stored.audioMode != null
                       || typeof stored.audioOn === 'boolean';
  if (hasBootedBefore) {
    boot().catch(err => {
      console.error('[qualia] auto-boot failed:', err);
      // Fall back to revealing the overlay if anything went wrong so
      // the user has a manual entry point.
      overlayUI.classList.remove('hidden');
    });
  }
}
