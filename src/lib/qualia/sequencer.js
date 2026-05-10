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
  const btnMute     = document.getElementById('btn-sequencer-mute');
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
    let m = null;
    if (wasOpenLastSession) {
      const stored = loadCurrent();
      if (stored) m = stored;
    }
    if (!m) m = defaultPattern();
    // syncStrudel was added after the initial release, so older stored
    // patterns won't have the field. Default ON to match the new
    // behavior; users who explicitly turned it off will have the
    // boolean persisted (false) and we leave that alone.
    if (typeof m.syncStrudel !== 'boolean') m.syncStrudel = true;
    return m;
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
    // Bypass Tone.getDestination() (the Tone.js master volume node) by
    // routing to the raw AudioContext destination instead. This is what
    // makes the per-panel mute work: Strudel's mute uses
    // Tone.Destination.mute=true, and if the sequencer also fed through
    // Tone.Destination it would be silenced as a side-effect. The raw
    // destination has no mute/volume controls — those live on
    // kit.output and we drive them from setMuted() below.
    //
    // The strudel mute fix patches AudioNode.prototype.connect to route
    // every connection-into-ctx.destination through a Strudel-owned
    // mute gate. Tag this output node so the patch leaves it alone —
    // the sequencer has its own per-source mute (kit.output.gain) and
    // must not be silenced by the Strudel toggle.
    const rawDest = Tone.getContext().rawContext.destination;
    kit.output.__qualiaBypassMute = true;
    kit.output.connect(rawDest);
    // Apply current mute state in case the user toggled it before the
    // first play (kit didn't exist yet, so the gain change had nowhere
    // to land).
    applyMuteToKit();
  }
  // Mute is per-session, not persisted in the pattern model — it's a
  // performance gate ("silence this source for a moment"), not a saved
  // attribute of the pattern. Survives play/stop cycles within the
  // session because it lives on this closure.
  let _muted = false;
  function applyMuteToKit() {
    if (!kit?.output?.gain) return;
    const target = _muted ? 0 : 0.9;  // 0.9 matches createKit()'s default
    try {
      const t = Tone.now();
      kit.output.gain.cancelScheduledValues(t);
      kit.output.gain.linearRampToValueAtTime(target, t + 0.04);
    } catch {
      try { kit.output.gain.value = target; } catch {}
    }
  }
  function setMuted(on) {
    _muted = !!on;
    applyMuteToKit();
    refreshMuteBtn();
  }
  function refreshMuteBtn() {
    if (!btnMute) return;
    btnMute.classList.toggle('muted', _muted);
    btnMute.textContent = _muted ? 'mute' : 'live';
    btnMute.title = _muted
      ? 'Unmute sequencer audio'
      : 'Mute sequencer audio (transport keeps running so sync stays locked)';
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

  // _inhibitTransportSync is set when play/stop *originates* in Strudel
  // and is being mirrored INTO the sequencer. It keeps the resulting
  // sequencer-side play() from echoing back out to Strudel, which would
  // either no-op (Strudel already playing) or cause a stop/start
  // flutter on certain orderings.
  let _inhibitTransportSync = false;
  async function play(opts = {}) {
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
    if (!opts.fromStrudel && model.syncStrudel && !_inhibitTransportSync) {
      try { syncStrudel?.playStrudel?.(); } catch {}
    }
    return true;
  }
  function stop(opts = {}) {
    if (!isPlaying && !audio.hasSource('sequencer')) {
      // Idempotent — keep the button paint correct even if called twice.
      btnPlay?.classList.remove('playing');
      // Even when we were already idle, propagate the user's stop click
      // to Strudel so the "stop" button feels like a master.
      if (!opts.fromStrudel && model.syncStrudel && !_inhibitTransportSync) {
        try { syncStrudel?.stopStrudel?.(); } catch {}
      }
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
    if (!opts.fromStrudel && model.syncStrudel && !_inhibitTransportSync) {
      try { syncStrudel?.stopStrudel?.(); } catch {}
    }
    return true;
  }
  // Public hooks for Strudel→sequencer transport mirroring. Like
  // applyCpsFromStrudel they're gated by the sync toggle so a closed
  // Strudel session doesn't accidentally drive an unconnected
  // sequencer.
  function playFromStrudel() {
    if (!model.syncStrudel) return;
    if (isPlaying) return;
    _inhibitTransportSync = true;
    try { play({ fromStrudel: true }); } finally { _inhibitTransportSync = false; }
  }
  function stopFromStrudel() {
    if (!model.syncStrudel) return;
    if (!isPlaying) return;
    _inhibitTransportSync = true;
    try { stop({ fromStrudel: true }); } finally { _inhibitTransportSync = false; }
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
    // Wrap a numeric input with finger-tappable [−] [input] [+] steppers.
    // The native UA spinners are too small for touch; we still listen on
    // the input's change/input event so the existing handler logic stays
    // canonical — the buttons just dispatch the same event after mutating
    // the value.
    const stepperFor = (input, eventName) => {
      const wrap = document.createElement('span');
      wrap.className = 'seq-num-wrap';
      const step = parseFloat(input.step) || 1;
      const min  = input.min !== '' ? parseFloat(input.min) : -Infinity;
      const max  = input.max !== '' ? parseFloat(input.max) : Infinity;
      const isInt = Number.isInteger(step);
      const decimals = isInt ? 0 : Math.max(0, (String(step).split('.')[1] || '').length);
      const bump = (delta) => {
        const cur = parseFloat(input.value);
        const base = Number.isFinite(cur) ? cur : (Number.isFinite(min) ? min : 0);
        let next = base + delta * step;
        next = Math.min(max, Math.max(min, next));
        // toFixed avoids float drift (0.05+0.05=0.10000000001) bleeding
        // into the displayed value.
        input.value = isInt ? String(Math.round(next)) : next.toFixed(decimals);
        input.dispatchEvent(new Event(eventName, { bubbles: true }));
      };
      const mkBtn = (txt, delta, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ctrl-btn seq-num-step';
        b.textContent = txt;
        b.title = title;
        b.addEventListener('click', (e) => { e.preventDefault(); bump(delta); });
        return b;
      };
      wrap.append(
        mkBtn('−', -1, 'Decrease'),
        input,
        mkBtn('+', +1, 'Increase'),
      );
      return wrap;
    };
    const beatsIn = document.createElement('input');
    beatsIn.type = 'number'; beatsIn.min = '1'; beatsIn.max = '32'; beatsIn.step = '1';
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
    stepsIn.type = 'number'; stepsIn.min = '1'; stepsIn.max = '16'; stepsIn.step = '1';
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
      refreshSyncStatus();
      // When the user just turned sync on, immediately push the current
      // CPS to Strudel so the two engines align without waiting for the
      // next Strudel re-eval.
      if (model.syncStrudel && !_inhibitSync) {
        syncStrudel?.setCpsDebounced?.(model.cps);
      }
    });
    const syncWrap = document.createElement('label');
    syncWrap.className = 'seq-prop seq-prop-check';
    syncWrap.title = 'Lock CPS + transport (play/stop) with the Strudel REPL (bidirectional). Use the live/mute toggle in each panel to silence one source while the other keeps playing in time.';
    const syncLabel = document.createElement('span');
    syncLabel.className = 'seq-prop-label';
    syncLabel.textContent = 'sync strudel';
    // Status pip — paints connected/waiting state so the user can tell
    // whether the toggle is actually wired to a live Strudel runtime.
    // Strudel's REPL lazy-loads, so "waiting" is the normal state right
    // after page load before the editor is opened for the first time.
    const syncStatus = document.createElement('span');
    syncStatus.className = 'seq-sync-status';
    syncWrap.append(syncCb, syncLabel, syncStatus);

    propsEl.append(
      mk('beats',     stepperFor(beatsIn, 'change'), { title: 'Beats per pattern (RR-style)' }),
      mk('steps/beat', stepperFor(stepsIn, 'change'), { title: 'Subdivisions per beat — 3 for triplets, 5 for quintuplets, etc.' }),
      mk('cps',       stepperFor(cpsIn,  'input'),  { title: 'Cycles per second — one cycle = one full pattern' }),
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
    refreshSyncStatus();
  }

  // Three states:
  //   - off:       checkbox unchecked, no status text
  //   - connected: checkbox checked AND a delivery path exists
  //   - waiting:   checkbox checked but Strudel hasn't published a hook
  //                yet (panel never opened, or REPL still loading)
  // The "waiting" copy is the most actionable — it tells the user what
  // they need to do (open Strudel and play a pattern) for sync to take.
  function refreshSyncStatus() {
    const el = propsEl?.querySelector('.seq-sync-status');
    if (!el) return;
    if (!model.syncStrudel) {
      el.textContent = '';
      el.dataset.state = 'off';
      return;
    }
    const ready = !!syncStrudel?.isReady?.();
    el.textContent = ready ? '· connected' : '· waiting for strudel';
    el.dataset.state = ready ? 'connected' : 'waiting';
  }

  function renderMatrix() {
    if (!matrixEl) return;
    matrixEl.innerHTML = '';
    const total = totalCells();
    for (const pad of model.pads) {
      const row = document.createElement('div');
      row.className = 'seq-pad-row';

      // Layout: [audition ▶] [voice name] [mute M]. The name used to BE
      // the mute toggle, which made the label appear to "go blank" (it
      // swapped to '·') when clicked — confusing UX. Splitting them keeps
      // the name readable at all times and gives mute its own
      // unambiguous, single-letter affordance.
      const ctrl = document.createElement('div');
      ctrl.className = 'seq-pad-ctrl';

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

      const nameEl = document.createElement('span');
      nameEl.className = 'seq-pad-name';
      nameEl.textContent = pad.voice;
      nameEl.title = pad.voice;

      const muteBtn = document.createElement('button');
      muteBtn.className = 'ctrl-btn seq-pad-mute';
      muteBtn.textContent = 'M';
      const refreshMuteBtnState = () => {
        muteBtn.classList.toggle('muted', !!pad.mute);
        muteBtn.title = pad.mute ? `Unmute ${pad.voice}` : `Mute ${pad.voice}`;
        muteBtn.setAttribute('aria-label', muteBtn.title);
        muteBtn.setAttribute('aria-pressed', pad.mute ? 'true' : 'false');
      };
      refreshMuteBtnState();
      muteBtn.addEventListener('click', () => {
        pad.mute = !pad.mute;
        model.updatedAt = Date.now();
        refreshMuteBtnState();
        persistSoon();
      });

      ctrl.append(audBtn, nameEl, muteBtn);

      const cellsEl = document.createElement('div');
      cellsEl.className = 'seq-cells';
      // Floor the per-cell width at 22px so a phone-narrow row doesn't
      // shrink the LEDs to invisible dashes. If the total exceeds the
      // available width, #seq-matrix-wrap (overflow:auto) scrolls
      // horizontally instead of squashing the cells.
      cellsEl.style.gridTemplateColumns = `repeat(${total}, minmax(22px, 1fr))`;
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
    // Same upgrade as pickInitialModel — entries saved before sync was
    // a persisted field default to ON when reloaded.
    if (typeof model.syncStrudel !== 'boolean') model.syncStrudel = true;
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
      // Default sync ON for fresh-blank patterns too — matches
      // defaultPattern() and pickInitialModel()'s upgrade path.
      syncStrudel: true,
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
  if (btnStop)  btnStop .addEventListener('click', () => { stop(); });
  if (btnMute)  btnMute .addEventListener('click', () => { setMuted(!_muted); });
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

  // Repaint the "(connected)/(waiting)" status when the sync bridge in
  // page-init.js wraps Strudel's setCps for the first time. The bridge
  // emits this once Strudel's REPL has loaded enough to expose either
  // setcps path; without the callback the user would see a stale
  // "waiting" forever even after sync is actually working.
  syncStrudel?.onReadyChange?.(() => refreshSyncStatus());

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

  // First paint of the mute button so it's labelled "live" out of the
  // box even though _muted starts false. Otherwise the empty default
  // `<button>live</button>` markup is overwritten only on first toggle,
  // and any inert state shift (e.g. session restore) leaves it stale.
  refreshMuteBtn();

  return {
    open, close,
    isOpen:    () => panel?.style.display !== 'none',
    isPlaying: () => isPlaying,
    isMuted:   () => _muted,
    setMuted,
    play, stop,
    playFromStrudel, stopFromStrudel,
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
