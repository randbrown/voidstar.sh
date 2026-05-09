// Tone.js grid pattern sequencer panel — second programmable audio source
// alongside Strudel. Mirrors createStrudelHydra in shape: owns its panel
// DOM, lifecycle, audio adoption into the audio.js source registry, and
// CRUD over a stored pattern library.
//
// The defining design rule is from Rhythm Rascal: a pattern is just
// `beats × steps-per-beat` integers. Triplets/quintuplets/septuplets are
// not special — they're just different values of `steps`. CPS (cycles
// per second) matches Strudel; one cycle = one full pattern repeat.
//
// The audio path goes Tone synths → `kit.output` → Tone.getDestination()
// (so the user hears it) AND → analyser → audio.adoptAnalyser('sequencer').
// Scheduling uses Tone.Transport.scheduleRepeat — sample-accurate and
// keeps running under tab-throttling, unlike setInterval.

import * as Tone from 'tone';
import {
  loadCurrent, saveCurrent, loadList, addToList, updateInList,
  removeFromList, clonePattern, defaultPattern, resizeHits, makePad,
  loadPanelOpen, savePanelOpen, downloadPattern, VOICES,
} from './sequencer-patterns.js';
import { createKit } from './sequencer-voices.js';

export function createSequencer({ audio, syncStrudel } = {}) {
  // Snapshot panel-open state from the previous session ONCE — open()/close()
  // mutate the stored flag for next time, but the answer to "should we
  // re-open on boot?" is whatever the user left it at last visit.
  const wasOpenLastSession = loadPanelOpen();

  const panel       = document.getElementById('sequencer-panel');
  const matrixEl    = document.getElementById('seq-matrix');
  const propsEl     = document.getElementById('seq-props');
  const status      = document.getElementById('sequencer-status');
  const btnToggle   = document.getElementById('btn-sequencer');
  const btnClose    = document.getElementById('btn-sequencer-close');
  const btnPlay     = document.getElementById('btn-sequencer-play');
  const btnStop     = document.getElementById('btn-sequencer-stop');
  const nameInput   = document.getElementById('sequencer-name');
  const tabBar      = document.getElementById('sequencer-tabs');
  const gridPane    = document.getElementById('sequencer-grid');
  const patternsPane= document.getElementById('sequencer-patterns');
  const patListEl   = document.getElementById('seq-pat-list');

  // Live editor model. Loaded from storage if the panel was open last
  // session (mid-edit recovery), otherwise a fresh default groove.
  let model = pickInitialModel();

  // Kit + scheduling state, lazily created on first open() since spinning
  // up Tone.js touches the AudioContext (must follow a user gesture).
  let kit = null;
  let analyser = null;
  let loopId = null;
  let cellIdx = 0;
  let isPlaying = false;
  let pendingStepPaint = -1;     // last step seen by scheduleRepeat; perFrame() reads this
  let lastPaintedStep = -1;
  let _inhibitSync = false;      // set when applying CPS *from* Strudel so we don't recurse

  function pickInitialModel() {
    if (wasOpenLastSession) {
      const stored = loadCurrent();
      if (stored) return stored;
    }
    return defaultPattern();
  }

  // ── Persistence (debounced auto-save) ──────────────────────────────────
  let saveTimer = null;
  function persistSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveCurrent(model); saveTimer = null; }, 600);
  }
  function persistNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveCurrent(model);
  }

  // ── Scheduling ─────────────────────────────────────────────────────────
  // Cell duration in seconds. CPS=cycles/sec, one cycle = beats*steps cells.
  function cellDuration() {
    return 1 / (model.cps * model.beats * model.steps);
  }
  function totalCells() { return model.beats * model.steps; }

  function clearLoop() {
    if (loopId !== null) {
      try { Tone.getTransport().clear(loopId); } catch {}
      loopId = null;
    }
  }

  function scheduleLoop() {
    clearLoop();
    const dur = cellDuration();
    const cells = totalCells();
    loopId = Tone.getTransport().scheduleRepeat((time) => {
      // Read model live each tick so cell toggles, mute changes, and gain
      // tweaks land in the next hit without a play/stop dance.
      const m = model;
      for (const pad of m.pads) {
        if (pad.mute) continue;
        if (pad.hits[cellIdx]) {
          kit?.trigger(pad.voice, time, Math.max(0, Math.min(1, pad.gain ?? 1)));
        }
      }
      // Paint the active step on the next animation frame. Tone.Draw
      // doesn't have a guaranteed equivalent of rAF in older versions,
      // and we already have a perFrame() hook driven by core.onFps —
      // surface the step there so all DOM updates happen on the main
      // thread's rAF cycle.
      pendingStepPaint = cellIdx;
      cellIdx = (cellIdx + 1) % cells;
    }, dur);
  }

  // Re-schedule when the timing changes (cps / beats / steps). Transport
  // position is preserved, so the user hears a smooth retempo rather than
  // a jolt to the start of the loop.
  function rescheduleIfPlaying() {
    if (!isPlaying) return;
    const cells = totalCells();
    if (cellIdx >= cells) cellIdx = 0;
    scheduleLoop();
  }

  // ── Audio tap ──────────────────────────────────────────────────────────
  function ensureKit() {
    if (kit) return;
    kit = createKit();
    kit.output.connect(Tone.getDestination());
  }
  function ensureAnalyserAdopted() {
    if (!kit) return;
    if (audio.hasSource('sequencer')) return;
    const ctx = Tone.getContext().rawContext;
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.40;
      // Tap the kit output (post-effects, pre-destination). We tap the
      // kit bus — not Tone.getDestination() — so the sequencer's analyser
      // sees its own signal even if anything else is later routed into
      // Tone.Destination by other panels.
      kit.output.connect(analyser);
    }
    audio.adoptAnalyser(ctx, analyser, 'sequencer');
  }

  async function play() {
    if (isPlaying) return true;
    try {
      await Tone.start();
    } catch (e) {
      console.warn('[qualia] Tone.start failed:', e);
      return false;
    }
    ensureKit();
    cellIdx = 0;
    pendingStepPaint = -1;
    lastPaintedStep = -1;
    isPlaying = true;
    btnPlay?.classList.add('playing');
    scheduleLoop();
    Tone.getTransport().start();
    ensureAnalyserAdopted();
    persistNow();
    refreshSeqBtn();
    return true;
  }
  function stop() {
    if (!isPlaying && !audio.hasSource('sequencer')) {
      // Idempotent — keep the button paint correct even if called twice.
      btnPlay?.classList.remove('playing');
      return false;
    }
    isPlaying = false;
    btnPlay?.classList.remove('playing');
    clearLoop();
    try { Tone.getTransport().stop(); } catch {}
    audio.releaseAdopted('sequencer');
    pendingStepPaint = -1;
    paintCurrentStep(-1);
    persistNow();
    refreshSeqBtn();
    return true;
  }

  // ── CPS sync ───────────────────────────────────────────────────────────
  function setCps(v, opts = {}) {
    const cps = Math.max(0.05, Math.min(8, +v || 0));
    if (cps === model.cps) return;
    model.cps = cps;
    model.updatedAt = Date.now();
    rescheduleIfPlaying();
    refreshPropsValues();
    persistSoon();
    // Echo to Strudel when sync is on, unless this update *came from*
    // Strudel (the wrapped setcps callback sets _inhibitSync). The
    // sync-strudel-via-globalThis-setcps path is debounced by the caller.
    if (opts.fromStrudel) return;
    if (model.syncStrudel) {
      syncStrudel?.setCpsDebounced?.(cps);
    }
  }

  // Public hook for Strudel→sequencer direction. Wrapped in setCps so the
  // toggle still gates whether external changes apply at all.
  function applyCpsFromStrudel(v) {
    if (!model.syncStrudel) return;
    _inhibitSync = true;
    try { setCps(v, { fromStrudel: true }); }
    finally { _inhibitSync = false; }
  }

  // ── UI ─────────────────────────────────────────────────────────────────
  function renderProps() {
    if (!propsEl) return;
    propsEl.innerHTML = '';
    const mk = (label, child, opts = {}) => {
      const wrap = document.createElement('label');
      wrap.className = 'seq-prop';
      const sp = document.createElement('span');
      sp.className = 'seq-prop-label';
      sp.textContent = label;
      wrap.append(sp, child);
      if (opts.title) wrap.title = opts.title;
      return wrap;
    };
    const beatsIn = document.createElement('input');
    beatsIn.type = 'number'; beatsIn.min = '1'; beatsIn.max = '32';
    beatsIn.value = String(model.beats);
    beatsIn.className = 'seq-num';
    beatsIn.addEventListener('change', () => {
      const v = Math.max(1, Math.min(32, parseInt(beatsIn.value, 10) || 1));
      if (v === model.beats) return;
      model.beats = v;
      for (const p of model.pads) resizeHits(p, model.beats, model.steps);
      model.updatedAt = Date.now();
      rescheduleIfPlaying();
      renderMatrix();
      persistSoon();
    });

    const stepsIn = document.createElement('input');
    stepsIn.type = 'number'; stepsIn.min = '1'; stepsIn.max = '16';
    stepsIn.value = String(model.steps);
    stepsIn.className = 'seq-num';
    stepsIn.addEventListener('change', () => {
      const v = Math.max(1, Math.min(16, parseInt(stepsIn.value, 10) || 1));
      if (v === model.steps) return;
      model.steps = v;
      for (const p of model.pads) resizeHits(p, model.beats, model.steps);
      model.updatedAt = Date.now();
      rescheduleIfPlaying();
      renderMatrix();
      persistSoon();
    });

    const cpsIn = document.createElement('input');
    cpsIn.type = 'number'; cpsIn.step = '0.05'; cpsIn.min = '0.1'; cpsIn.max = '4';
    cpsIn.value = String(model.cps);
    cpsIn.className = 'seq-num seq-num-wide';
    cpsIn.addEventListener('input', () => {
      const v = parseFloat(cpsIn.value);
      if (Number.isFinite(v)) setCps(v);
    });

    const syncCb = document.createElement('input');
    syncCb.type = 'checkbox';
    syncCb.checked = !!model.syncStrudel;
    syncCb.addEventListener('change', () => {
      model.syncStrudel = !!syncCb.checked;
      model.updatedAt = Date.now();
      persistSoon();
      // When the user just turned sync on, immediately push the current
      // CPS to Strudel so the two engines align without waiting for the
      // next Strudel re-eval.
      if (model.syncStrudel && !_inhibitSync) {
        syncStrudel?.setCpsDebounced?.(model.cps);
      }
    });
    const syncWrap = document.createElement('label');
    syncWrap.className = 'seq-prop seq-prop-check';
    syncWrap.title = 'Sync this panel’s CPS with the Strudel REPL (bidirectional)';
    const syncLabel = document.createElement('span');
    syncLabel.className = 'seq-prop-label';
    syncLabel.textContent = 'sync strudel';
    syncWrap.append(syncCb, syncLabel);

    propsEl.append(
      mk('beats',     beatsIn, { title: 'Beats per pattern (RR-style)' }),
      mk('steps/beat', stepsIn, { title: 'Subdivisions per beat — 3 for triplets, 5 for quintuplets, etc.' }),
      mk('cps',       cpsIn,   { title: 'Cycles per second — one cycle = one full pattern' }),
      syncWrap,
    );
  }
  function refreshPropsValues() {
    if (!propsEl) return;
    const inputs = propsEl.querySelectorAll('input[type="number"]');
    if (inputs.length >= 3) {
      inputs[0].value = String(model.beats);
      inputs[1].value = String(model.steps);
      inputs[2].value = String(model.cps);
    }
    const cb = propsEl.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = !!model.syncStrudel;
  }

  function renderMatrix() {
    if (!matrixEl) return;
    matrixEl.innerHTML = '';
    const total = totalCells();
    for (const pad of model.pads) {
      const row = document.createElement('div');
      row.className = 'seq-pad-row';

      const ctrl = document.createElement('div');
      ctrl.className = 'seq-pad-ctrl';
      const muteBtn = document.createElement('button');
      muteBtn.className = 'ctrl-btn seq-pad-mute';
      muteBtn.textContent = pad.mute ? '·' : pad.voice;
      muteBtn.title = pad.mute ? 'Unmute pad' : 'Mute pad';
      if (pad.mute) muteBtn.classList.add('muted');
      muteBtn.addEventListener('click', () => {
        pad.mute = !pad.mute;
        model.updatedAt = Date.now();
        muteBtn.classList.toggle('muted', pad.mute);
        muteBtn.textContent = pad.mute ? '·' : pad.voice;
        muteBtn.title = pad.mute ? 'Unmute pad' : 'Mute pad';
        persistSoon();
      });
      const audBtn = document.createElement('button');
      audBtn.className = 'ctrl-btn seq-pad-audition';
      audBtn.textContent = '▶';
      audBtn.title = `Audition ${pad.voice}`;
      audBtn.addEventListener('click', async () => {
        try { await Tone.start(); } catch {}
        ensureKit();
        ensureAnalyserAdopted();
        kit?.trigger(pad.voice, Tone.now(), pad.gain ?? 1);
      });
      ctrl.append(muteBtn, audBtn);

      const cellsEl = document.createElement('div');
      cellsEl.className = 'seq-cells';
      cellsEl.style.gridTemplateColumns = `repeat(${total}, minmax(0, 1fr))`;
      for (let i = 0; i < total; i++) {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'seq-cell';
        if (i % model.steps === 0) c.classList.add('beat-start');
        if (pad.hits[i]) c.classList.add('on');
        c.dataset.i = String(i);
        c.addEventListener('click', () => {
          pad.hits[i] = pad.hits[i] ? 0 : 1;
          model.updatedAt = Date.now();
          c.classList.toggle('on', !!pad.hits[i]);
          persistSoon();
        });
        cellsEl.appendChild(c);
      }

      row.append(ctrl, cellsEl);
      row.dataset.padId = pad.id;
      matrixEl.appendChild(row);
    }
    lastPaintedStep = -1;
    paintCurrentStep(pendingStepPaint);
  }

  function paintCurrentStep(stepIdx) {
    if (!matrixEl) return;
    if (stepIdx === lastPaintedStep) return;
    if (lastPaintedStep >= 0) {
      matrixEl.querySelectorAll(`.seq-cell.cur`).forEach(el => el.classList.remove('cur'));
    }
    if (stepIdx >= 0) {
      // One column highlighted across all rows. Selector handles dynamic
      // pad count without us tracking row refs.
      matrixEl.querySelectorAll(`.seq-cell[data-i="${stepIdx}"]`).forEach(el => el.classList.add('cur'));
    }
    lastPaintedStep = stepIdx;
  }

  // ── Topbar button paint ────────────────────────────────────────────────
  function refreshSeqBtn() {
    if (!btnToggle) return;
    btnToggle.classList.remove('active', 'active-audio');
    const live = audio.hasSource('sequencer');
    const open = panel?.style.display !== 'none';
    if (live) {
      btnToggle.classList.add('active-audio');
      btnToggle.textContent = 'seq ●';
    } else if (open) {
      btnToggle.classList.add('active');
      btnToggle.textContent = 'seq on';
    } else {
      btnToggle.textContent = 'seq';
    }
    if (status) {
      if (live)       status.textContent = 'audio: live';
      else if (open)  status.textContent = isPlaying ? 'starting…' : 'click ▶ to play';
    }
  }

  // ── Drag / reposition (mirror strudel-hydra) ───────────────────────────
  let movedByUser = false;
  function reposition() {
    if (!panel || panel.style.display === 'none') return;
    const tb = document.getElementById('topbar');
    if (!tb) return;
    const h = tb.getBoundingClientRect().height;
    panel.style.maxHeight = `calc(100vh - ${h + 24}px)`;
    if (!movedByUser) panel.style.top = (h + 8) + 'px';
  }
  window.addEventListener('resize', reposition);
  const topbarEl = document.getElementById('topbar');
  if (topbarEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reposition).observe(topbarEl);
  }
  (() => {
    const header = document.getElementById('sequencer-header');
    if (!header || !panel) return;
    let dragging = false, dx = 0, dy = 0, pointerId = null;
    const VP_PAD = 4;
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, textarea')) return;
      if (e.button !== undefined && e.button !== 0) return;
      const r = panel.getBoundingClientRect();
      if (!movedByUser) {
        panel.style.transform = 'none';
        panel.style.left = r.left + 'px';
        panel.style.top  = r.top  + 'px';
        movedByUser = true;
      }
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      pointerId = e.pointerId;
      dragging = true;
      header.classList.add('dragging');
      try { header.setPointerCapture(pointerId); } catch {}
      e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const r = panel.getBoundingClientRect();
      const maxX = window.innerWidth  - r.width  - VP_PAD;
      const maxY = window.innerHeight - 32;
      const x = Math.min(Math.max(VP_PAD, e.clientX - dx), Math.max(VP_PAD, maxX));
      const y = Math.min(Math.max(VP_PAD, e.clientY - dy), Math.max(VP_PAD, maxY));
      panel.style.left = x + 'px';
      panel.style.top  = y + 'px';
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      header.classList.remove('dragging');
      try { header.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  })();

  // ── Tabs ───────────────────────────────────────────────────────────────
  function setTab(name) {
    tabBar?.querySelectorAll('.sp-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === name));
    if (gridPane)     gridPane.style.display     = name === 'grid'     ? '' : 'none';
    if (patternsPane) patternsPane.style.display = name === 'patterns' ? 'flex' : 'none';
    if (name === 'patterns') renderPatternList();
  }
  tabBar?.querySelectorAll('.sp-tab').forEach(t => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  // ── Pattern manager ────────────────────────────────────────────────────
  function renderPatternList() {
    if (!patListEl) return;
    const list = loadList();
    patListEl.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'sp-pat-empty';
      empty.textContent = 'no saved patterns yet — hit "save current" to add one';
      patListEl.appendChild(empty);
      return;
    }
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'sp-pat-row';

      const metaCol = document.createElement('div');
      metaCol.className = 'sp-pat-meta';
      const nameInputEl = document.createElement('input');
      nameInputEl.className = 'sp-pat-name';
      nameInputEl.value = p.name;
      nameInputEl.title = 'rename';
      nameInputEl.addEventListener('change', () => {
        const next = nameInputEl.value.trim();
        if (next && next !== p.name) {
          updateInList(p.id, { name: next });
          renderPatternList();
        }
      });
      const byLine = document.createElement('div');
      byLine.className = 'sp-pat-by';
      byLine.textContent =
        `${p.beats}×${p.steps} · ${p.cps} cps · ${new Date(p.updatedAt).toLocaleDateString()}`;
      metaCol.append(nameInputEl, byLine);

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
        mkBtn('load', 'Load into editor', () => { setTab('grid'); loadModelById(p.id); }),
        mkBtn('clone', 'Duplicate this entry', () => { clonePattern(p.id); renderPatternList(); }),
        mkBtn('download', 'Download as .seq.json', () => downloadPattern(p)),
        mkBtn('delete', 'Remove from list', () => {
          if (confirm(`Delete "${p.name}"?`)) {
            removeFromList(p.id);
            renderPatternList();
          }
        }),
      );
      row.append(metaCol, actions);
      patListEl.appendChild(row);
    }
  }

  function loadModelById(id) {
    const list = loadList();
    const found = list.find(p => p.id === id);
    if (!found) return;
    // Stop, swap model, re-render. Keep in mind the saved entry is the
    // user's canonical copy — clone it so editing doesn't bleed back.
    const wasPlaying = isPlaying;
    if (wasPlaying) stop();
    model = JSON.parse(JSON.stringify(found));
    if (nameInput) nameInput.value = model.name || '';
    refreshPropsValues();
    renderMatrix();
    persistNow();
    if (wasPlaying) play();
  }
  function newBlank() {
    const wasPlaying = isPlaying;
    if (wasPlaying) stop();
    const empty = (n) => new Array(n).fill(0);
    const total = 16;
    model = {
      id: Date.now().toString(36),
      name: 'untitled',
      cps: 0.5, beats: 4, steps: 4,
      pads: VOICES.map(v => makePad(v.id, empty(total))),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    if (nameInput) nameInput.value = model.name;
    refreshPropsValues();
    renderMatrix();
    persistNow();
    if (wasPlaying) play();
  }
  function newRandom() {
    const wasPlaying = isPlaying;
    if (wasPlaying) stop();
    model = defaultPattern();
    // Sprinkle a little chaos on top of the default groove so each
    // "random" press produces a different starting point. Keep kick/snare
    // as-is so the result is recognisable as a beat.
    for (const pad of model.pads) {
      if (pad.voice === 'kick' || pad.voice === 'snare') continue;
      for (let i = 0; i < pad.hits.length; i++) {
        if (Math.random() < 0.18) pad.hits[i] = 1;
      }
    }
    if (nameInput) nameInput.value = model.name;
    refreshPropsValues();
    renderMatrix();
    persistNow();
    if (wasPlaying) play();
  }
  function saveCurrentToList() {
    const name = (nameInput?.value || '').trim() || model.name || `pattern ${new Date().toLocaleString()}`;
    model.name = name;
    return addToList(model, name);
  }

  // ── Open / close ───────────────────────────────────────────────────────
  function open() {
    if (panel) panel.style.display = '';
    savePanelOpen(true);
    reposition();
    if (nameInput) nameInput.value = model.name || '';
    if (!propsEl?.children.length) renderProps();
    if (!matrixEl?.children.length) renderMatrix();
    refreshSeqBtn();
  }
  function close() {
    // Hide the UI but keep playback (if any) alive — same contract as
    // strudel-hydra. The user can have the panel closed while the
    // sequencer continues driving the visualizers.
    if (panel) panel.style.display = 'none';
    savePanelOpen(false);
    refreshSeqBtn();
  }

  // ── Wire control buttons ───────────────────────────────────────────────
  if (btnToggle) btnToggle.addEventListener('click', () => {
    if (!panel) return;
    if (panel.style.display === 'none') open();
    else                                close();
  });
  if (btnClose) btnClose.addEventListener('click', close);
  if (btnPlay)  btnPlay .addEventListener('click', () => { play(); });
  if (btnStop)  btnStop .addEventListener('click', stop);
  if (nameInput) nameInput.addEventListener('change', () => {
    model.name = nameInput.value;
    model.updatedAt = Date.now();
    persistSoon();
  });

  // Initial render even if the panel starts hidden — so the first open()
  // shows the matrix without a flash of empty content.
  if (propsEl)   renderProps();
  if (matrixEl)  renderMatrix();
  if (nameInput) nameInput.value = model.name || '';
  refreshSeqBtn();

  // Re-paint when audio.js flips sequencer source on/off.
  audio?.onChange?.(() => refreshSeqBtn());

  if (wasOpenLastSession) open();

  // ── Public API ─────────────────────────────────────────────────────────
  function perFrame() {
    // Drain the latest scheduled step from the audio thread to the DOM.
    // Reading a single int and bouncing back is cheaper than scheduling
    // a Tone.Draw callback per step.
    if (pendingStepPaint !== lastPaintedStep) {
      paintCurrentStep(pendingStepPaint);
    }
  }

  return {
    open, close,
    isOpen:    () => panel?.style.display !== 'none',
    isPlaying: () => isPlaying,
    play, stop,
    setCps,
    getCps:    () => model.cps,
    isSyncOn:  () => !!model.syncStrudel,
    setSync:   (on) => { model.syncStrudel = !!on; persistSoon(); },
    applyCpsFromStrudel,
    perFrame,
    patterns: {
      list:     loadList,
      add:      saveCurrentToList,
      update:   updateInList,
      remove:   removeFromList,
      clone:    clonePattern,
      load:     loadModelById,
      newBlank,
      random:   newRandom,
      getCurrent: () => model,
    },
  };
}
