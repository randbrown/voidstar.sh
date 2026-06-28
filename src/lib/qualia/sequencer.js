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
import { KITS, getKit, DEFAULT_KIT_ID, EXTERNAL_VOICE_MAP } from './sequencer-kits.js';
import { createSampleKit } from './sequencer-voices.js';
import { parsePackSpec } from './samples-manifest.js';
import { makeDraggablePanel } from './panel-pos.js';
import { makeLimiter, setLimiterEngaged } from './limiter.js';
import { getNum, getBool, setBool, setRaw, getRaw, getJSON, setJSON } from './prefs.js';

// Curated, real GitHub sample packs for the one-click loader — starting points
// across the requested genres. Contents/licenses vary per repo; treat as
// examples to audition, not vetted CC0 sets. Loaded into BOTH engines.
const PACK_PRESETS = [
  { label: 'lofi',    spec: 'github:eddyflux/crate',           title: 'Eddyflux "crate" — lo-fi / boom-bap one-shots' },
  { label: 'hiphop',  spec: 'github:tidalcycles/Dirt-Samples', title: 'Dirt-Samples — classic hip-hop hits + drum machines' },
  { label: 'jazz',    spec: 'github:yaxu/clean-breaks',        title: 'Clean breaks — acoustic break kits (jazzy drums)' },
  { label: 'dubstep', spec: 'github:switchangel/breaks',       title: 'Switch Angel breaks — heavy / halftime break fodder' },
  { label: 'ambient', spec: 'github:mot4i/garden',             title: '"garden" — textural / ambient material (verify contents)' },
  { label: 'metal',   spec: 'github:tidalcycles/Dirt-Samples', title: 'Dirt-Samples — metallic / industrial banks (s("metal"))' },
];

// Persisted list of externally-loaded packs so they survive a reload.
const SEQ_EXTPACKS_KEY = 'voidstar.qualia.sequencer.extPacks';
function loadExtPacks() { const l = getJSON(SEQ_EXTPACKS_KEY, []); return Array.isArray(l) ? l : []; }
function saveExtPacks(list) { setJSON(SEQ_EXTPACKS_KEY, list); }

// Persisted UI volume — multiplies kit.output while un-muted. Sits
// alongside the mute toggle as a performance-time mix-ride control.
// 0.9 default matches createKit()'s default kit.output.gain.
const SEQ_VOLUME_KEY = 'voidstar.qualia.sequencer.volume';
function loadSeqVolume() { return getNum(SEQ_VOLUME_KEY, 0.9, 0, 1); }
function saveSeqVolume(v) { setRaw(SEQ_VOLUME_KEY, v); }

// Brickwall limiter on the kit bus — on by default. Persisted across reloads.
const SEQ_LIMITER_KEY = 'voidstar.qualia.sequencer.limiter';
function loadSeqLimiter() { return getBool(SEQ_LIMITER_KEY, true); }
function saveSeqLimiter(on) { setBool(SEQ_LIMITER_KEY, on); }

// Whether the pattern-settings pane shows alongside the grid. Persisted so a
// user who collapses it (to give the matrix more room) doesn't get it back on
// every reopen. Defaults to visible — the grid + settings are meant to be
// usable side by side.
const SEQ_SHOW_SETTINGS_KEY = 'voidstar.qualia.sequencer.showSettings';
function loadShowSettings() { return getBool(SEQ_SHOW_SETTINGS_KEY, true); }
function saveShowSettings(on) { setBool(SEQ_SHOW_SETTINGS_KEY, on); }

// Selected kit (instrument the pads play through). A performance-time choice
// like volume/limiter — global to the sequencer and persisted across reloads,
// not stored per-pattern (grooves are voice-id rhythms; they sound on whatever
// kit is loaded). Falls back to the default synth kit if the stored id is gone.
const SEQ_KIT_KEY = 'voidstar.qualia.sequencer.kit';
function loadSeqKit() {
  const id = getRaw(SEQ_KIT_KEY, DEFAULT_KIT_ID);
  return getKit(id).id;   // normalises an unknown/removed id to the default
}
function saveSeqKit(id) { setRaw(SEQ_KIT_KEY, id); }

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
  const elGain      = document.getElementById('sequencer-gain');
  const btnSync     = document.getElementById('btn-sequencer-sync');
  const nameInput   = document.getElementById('sequencer-name');
  const tabBar      = document.getElementById('sequencer-tabs');
  const gridPane    = document.getElementById('sequencer-grid');
  const settingsPane= document.getElementById('sequencer-settings');
  const patternsPane= document.getElementById('sequencer-patterns');
  const patListEl   = document.getElementById('seq-pat-list');

  // Live editor model. Loaded from storage if the panel was open last
  // session (mid-edit recovery), otherwise a fresh default groove.
  let model = pickInitialModel();

  // Kit + scheduling state, lazily created on first open() since spinning
  // up Tone.js touches the AudioContext (must follow a user gesture).
  let kit = null;
  // Runtime kits loaded from external GitHub/URL packs (id → kit catalog entry).
  // Metadata only — the sample buffers load lazily when the kit is first built.
  const _dynamicKits = new Map();
  function addDynamicKit(p) {
    const manifestUrls = (p.manifestUrls && p.manifestUrls.length) ? p.manifestUrls : [p.manifestUrl];
    _dynamicKits.set(p.id, {
      id: p.id, group: 'loaded', label: `${p.label} · samples`, type: 'sample',
      desc: `External pack: ${p.strudelArg}`,
      // fillUnmapped: external packs rarely use bd/sd/hh names, so after the
      // candidate match, hand each empty pad a leftover sample so the kit makes
      // sound instead of sitting silent.
      make: () => createSampleKit({ manifestUrls, voiceMap: EXTERNAL_VOICE_MAP, fillUnmapped: true }),
      _spec: p,
    });
  }
  // Resolve a kit id against the dynamic registry first, then the static catalog.
  function resolveKit(id) { return _dynamicKits.get(id) || getKit(id); }
  // Restore persisted external packs as dynamic kits before we resolve the
  // initial kit id (so a pattern saved on an external pack reloads onto it).
  for (const p of loadExtPacks()) { try { addDynamicKit(p); } catch {} }
  // Selected instrument. The pattern model is the source of truth (so a saved
  // groove restores its kit); the global pref is the fallback for patterns with
  // no stored kit and the "last-used" seed for fresh ones.
  let _kitId = resolveKit(model.kitId).id;
  let analyser = null;
  let loopId = null;
  let cellIdx = 0;
  let isPlaying = false;
  // Audio-time of transport position 0, captured at start(). Right after
  // start() Tone clamps getTransport().seconds to ~0 for a whole lookAhead
  // window (it evaluates seconds at now()=currentTime+lookAhead, the start
  // boundary), so converting an absolute audio time via that getter lands
  // the first aligned tick a full lookAhead (~100ms) late vs Strudel. We
  // hold the real zero instead and subtract — exact even in that window,
  // and identical to the running-transport math otherwise (we keep no Tone
  // BPM automation, so transport seconds track audio seconds 1:1).
  let _transportZeroAudio = null;
  // Poll handle for the post-play auto-realign (see armAutoResync).
  let _autoResyncTimer = null;
  let _autoResyncTries = 0;
  // Refs to the ÷2/×2 helper buttons, for enabled-state refresh.
  let _scaleBtns = null;
  let pendingStepPaint = -1;     // last step seen by scheduleRepeat; perFrame() reads this
  let lastPaintedStep = -1;
  // Column → cell elements, built once per renderMatrix. The playhead repaint
  // walks these refs directly instead of querySelectorAll-ing the whole grid
  // every step — that scan ran on the main thread and stole time from the
  // Strudel cyclist while the sequencer was playing with its UI open.
  let colCells = [];
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
    // `cycles` was added later — older stored patterns won't have it.
    // Default 1 = previous "one pattern per cycle" behaviour, so the
    // upgrade is silent.
    if (typeof m.cycles !== 'number' || !(m.cycles > 0)) m.cycles = 1;
    // `kitId` was added later — backfill older patterns from the last-used kit
    // (the global pref) so they don't all snap to the default on upgrade.
    if (typeof m.kitId !== 'string') m.kitId = loadSeqKit();
    // Mirror the strudel @title when the sequencer would otherwise show
    // the placeholder default — keeps the two engines reading as the same
    // session ("qualem 4f9q") on a fresh load.
    if (m.syncStrudel && (!m.name || m.name === 'untitled')) {
      const stTitle = strudelTitleForName();
      if (stTitle) m.name = stTitle;
    }
    return m;
  }
  function strudelTitleForName() {
    try { return syncStrudel?.getStrudelTitle?.() || ''; }
    catch { return ''; }
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
  // `cycles` stretches the whole pattern across N Strudel cycles — cells
  // get N× longer, the grid stays the same shape, and Strudel keeps
  // running at its own CPS (we never push cps/cycles back to Strudel).
  function cellDuration() {
    const cyc = model.cycles > 0 ? model.cycles : 1;
    return cyc / (model.cps * model.beats * model.steps);
  }
  function totalCells() { return model.beats * model.steps; }

  function clearLoop() {
    if (loopId !== null) {
      try { Tone.getTransport().clear(loopId); } catch {}
      loopId = null;
    }
  }

  // Convert an absolute rawContext audio time to Tone transport time. Uses
  // the transport-zero captured at start() so it stays exact in the
  // lookahead window right after start (when getTransport().seconds is
  // clamped at ~0); falls back to the running getter if zero is unknown.
  function absToTransport(desiredAbs) {
    if (_transportZeroAudio != null) {
      return Math.max(0, desiredAbs - _transportZeroAudio);
    }
    const nowAbs = Tone.getContext().rawContext.currentTime;
    return Tone.getTransport().seconds + Math.max(0, desiredAbs - nowAbs);
  }

  // Phase-lock the pattern to Strudel's ABSOLUTE cycle position. Returns
  // { startAtAbs, cellIdx } for the first cell tick, or null if Strudel isn't
  // reporting a position. The key over the old "seconds-until-next-boundary"
  // math: it anchors cell 0 to cycles that are a MULTIPLE of `cycles`, so a
  // multi-cycle pattern can't land half a phrase off after a restart.
  //   - fromTop: begin from cell 0 on Strudel's next pattern boundary (next
  //     absolute cycle ≡ 0 mod `cycles`). Used by play() so a deliberate
  //     start always lands on the phrase downbeat. On a co-start (Strudel at
  //     cycle ~0) that's immediate; mid-jam it waits for the next phrase top.
  //   - !fromTop (continuity): drop in at the current phase with no restart
  //     and no silent gap, picking the cellIdx that keeps the grid locked.
  //     Used by the align button, retempo, and the post-play auto-realign —
  //     it can't skip a whole phrase.
  function computeAlignedStart({ fromTop }) {
    const info = syncStrudel?.getStrudelCyclePos?.();
    if (!info || typeof info.pos !== 'number' || !(info.cps > 0)) return null;
    const { pos, cps } = info;
    const C      = model.cycles > 0 ? model.cycles : 1;
    const cells  = totalCells();
    const dur    = cellDuration();
    const nowAbs = Tone.getContext().rawContext.currentTime;
    const MARGIN = Tone.getContext().lookAhead ?? 0.1;
    if (fromTop) {
      // Next pattern boundary (cell 0) at absolute cycle k*C, ≥ MARGIN ahead
      // so Tone's lookahead scheduler can catch it.
      const k = Math.ceil((pos + MARGIN * cps) / C - 1e-6);
      const secUntil = (k * C - pos) / cps;
      return { startAtAbs: nowAbs + secUntil, cellIdx: 0 };
    }
    // Continuity: most-recent pattern boundary (k*C ≤ pos) is the cell-0
    // anchor; fire the next cell tick ≥ MARGIN ahead with its matching cellIdx.
    const anchorCycle = Math.floor(pos / C + 1e-9) * C;
    const anchorAbs   = nowAbs - (pos - anchorCycle) / cps;
    const n = Math.max(0, Math.ceil((nowAbs + MARGIN - anchorAbs) / dur - 1e-6));
    return { startAtAbs: anchorAbs + n * dur, cellIdx: ((n % cells) + cells) % cells };
  }

  function scheduleLoop(opts = {}) {
    clearLoop();
    const dur = cellDuration();
    const cells = totalCells();
    // Two phase-align modes share this entry point:
    //   - opts.align: schedule the FIRST tick at Strudel's next cycle
    //     boundary. Caller sets cellIdx=0, gap before boundary is silent.
    //   - opts.startAtAbs: schedule the first tick at an explicit absolute
    //     audio-time. Used by resync() so the sequencer keeps ticking
    //     without a silent gap; caller picks cellIdx so the natural cell
    //     progression lands cellIdx=0 on the upcoming Strudel boundary.
    // Cell duration stays constant thereafter, so pattern wraparound
    // (cellIdx → 0) lands on a Strudel boundary too — for integer
    // `cycles`, every wrap is on a boundary; for non-integer `cycles`,
    // every Nth wrap.
    let startT;
    if (opts.startAtAbs != null && Number.isFinite(opts.startAtAbs)) {
      startT = absToTransport(opts.startAtAbs);
    } else if (opts.align && model.syncStrudel && syncStrudel?.isStrudelPlaying?.()) {
      try {
        // Strudel and Tone may not share an AudioContext, so we get a
        // RELATIVE duration (seconds-until-boundary) and rebuild an
        // absolute Tone audio time from our own clock — both contexts
        // tick at the same rate, so the duration is portable across the gap.
        const secondsUntil = syncStrudel.getSecondsUntilNextStrudelBoundary?.();
        if (typeof secondsUntil === 'number' && Number.isFinite(secondsUntil)) {
          const nowAbs  = Tone.getContext().rawContext.currentTime;
          const MARGIN  = Tone.getContext().lookAhead ?? 0.1;
          const period  = model.cps > 0 ? 1 / model.cps : 2;
          let desiredAbs = nowAbs + Math.max(0, secondsUntil);
          // Tone's lookahead scheduler can't catch a tick less than
          // lookAhead in the future; if the boundary is that close, lock
          // to the next Strudel cycle instead of firing late or not at all.
          for (let i = 0; i < 64 && desiredAbs < nowAbs + MARGIN; i++) desiredAbs += period;
          startT = absToTransport(desiredAbs);
        }
      } catch (e) { console.warn('[qualia] phase-align probe failed:', e); }
    }
    const cb = (time) => {
      // Read model live each tick so cell toggles, mute changes, and gain
      // tweaks land in the next hit without a play/stop dance.
      const m = model;
      // Indexed loop, not for…of: this runs on Tone's audio-scheduling thread,
      // and for…of allocates an iterator object per tick.
      const pads = m.pads;
      for (let p = 0; p < pads.length; p++) {
        const pad = pads[p];
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
    };
    loopId = (startT != null)
      ? Tone.getTransport().scheduleRepeat(cb, dur, startT)
      : Tone.getTransport().scheduleRepeat(cb, dur);
  }

  // Re-schedule when the timing changes (cps / beats / steps / cycles).
  // Preserve cellIdx (clamped if the grid shrank below it) for smooth
  // retempo — the user hears a tempo-feel change rather than a jolt back
  // to the start. The explicit sync button (resync) is the deliberate
  // path when the user wants a hard realign to Strudel's cycle 0.
  function rescheduleIfPlaying() {
    if (!isPlaying) return;
    const cells = totalCells();
    if (cellIdx >= cells) cellIdx = 0;
    scheduleLoop();
  }

  // Manual realign — snap cellIdx to "where it should be" given the
  // current strudel cycle phase, treating the most recent strudel
  // boundary as the cellIdx=0 anchor. The next cell tick fires at the
  // natural cell-grid time (anchor + n*cellDur for integer n) with the
  // matching cellIdx value, so the pattern stays phase-locked to strudel
  // from that moment onward.
  //
  // Tone.Transport's lookahead scheduler can't catch events scheduled
  // less than `lookAhead` seconds in the future — those fall behind
  // `_lastUpdate` between `_loop` iterations and never fire. We advance
  // `n` until the chosen tick is at least lookAhead in the future, which
  // skips at most one cellDur from the natural phase. Skipping a cell
  // visibly drops one beat but keeps the pattern locked to strudel —
  // cleaner than leaving the whole pattern phase-shifted by a fraction
  // of a cellDur.
  // When synced, adopt Strudel's actual tempo before aligning. Phase-lock is
  // impossible if the cell grid (model.cps) and Strudel tick at different rates
  // — e.g. a pattern's setcps() that never propagated to the sequencer. The
  // boundary probe uses Strudel's cps while the cell duration uses model.cps,
  // so a mismatch makes realign land then immediately drift. Snapping model.cps
  // to Strudel here closes that gap.
  function adoptStrudelCpsIfSynced() {
    if (!model.syncStrudel || !syncStrudel?.isStrudelPlaying?.()) return;
    const sCps = syncStrudel.getStrudelCps?.();
    if (typeof sCps === 'number' && sCps > 0 && Math.abs(sCps - model.cps) > 1e-3) {
      model.cps = sCps;
      model.updatedAt = Date.now();
      try { refreshPropsValues(); } catch {}
      persistSoon();
    }
  }

  function resync() {
    if (!isPlaying) return;
    // A manual align supersedes any pending post-play auto-realign.
    clearAutoResync();
    adoptStrudelCpsIfSynced();
    if (!model.syncStrudel || !syncStrudel?.isStrudelPlaying?.()) {
      cellIdx = 0;
      pendingStepPaint = -1;
      scheduleLoop();
      return;
    }
    // Continuity re-lock: drop in at Strudel's current absolute phase (no
    // restart, no silent gap), anchoring cell 0 to a multiple of `cycles`.
    const aligned = computeAlignedStart({ fromTop: false });
    pendingStepPaint = -1;
    if (aligned) {
      cellIdx = aligned.cellIdx;
      scheduleLoop({ startAtAbs: aligned.startAtAbs });
    } else {
      cellIdx = 0;
      scheduleLoop({ align: true });
    }
  }

  function clearAutoResync() {
    if (_autoResyncTimer) { clearInterval(_autoResyncTimer); _autoResyncTimer = null; }
    _autoResyncTries = 0;
  }
  // After a fresh sync-play the phase-align at play() runs against whatever
  // Strudel state is readable microseconds after evaluate() — which can be
  // stale from a prior run or not yet anchored, leaving the first downbeat a
  // few ms off Strudel. Once Strudel reports a fresh anchor (the same state
  // the manual align button relies on) re-run the align once. The aligned
  // schedule leaves a silent lead-in before the first cell, so this usually
  // lands BEFORE the first audible hit — the user just hears a locked start.
  function armAutoResync() {
    clearAutoResync();
    if (!model.syncStrudel || !syncStrudel?.isStrudelPlaying?.()) return;
    _autoResyncTimer = setInterval(() => {
      if (!isPlaying || !model.syncStrudel) { clearAutoResync(); return; }
      if (syncStrudel?.isStrudelSchedulerFresh?.()) {
        clearAutoResync();
        try { resync(); } catch (e) { console.warn('[qualia] auto-realign failed:', e); }
        return;
      }
      if (++_autoResyncTries > 30) clearAutoResync();   // ~1.5s safety cap
    }, 50);
  }

  // ── Audio tap ──────────────────────────────────────────────────────────
  // Build the currently-selected kit and tag its output. Bypass
  // Tone.getDestination() (the Tone.js master volume node) by routing to the
  // raw AudioContext destination instead. This is what makes the per-panel
  // mute work: Strudel's mute uses Tone.Destination.mute=true, and if the
  // sequencer also fed through Tone.Destination it would be silenced as a
  // side-effect. The raw destination has no mute/volume controls — those live
  // on kit.output and we drive them from setMuted() below.
  //
  // The strudel mute fix patches AudioNode.prototype.connect to route every
  // connection-into-ctx.destination through a Strudel-owned mute gate. Tag this
  // output node so the patch leaves it alone — the sequencer has its own
  // per-source mute (kit.output.gain) and must not be silenced by Strudel.
  function buildKit() {
    let k;
    try {
      k = resolveKit(_kitId).make();
    } catch (e) {
      // A kit that fails to construct must NOT silently strand the previous
      // one (that reads as "the samples kit just plays the old sound"). Log
      // loudly and let the caller keep the old kit instead.
      console.error(`[qualia] kit "${_kitId}" failed to build:`, e);
      return null;
    }
    k.output.__qualiaBypassMute = true;
    // Sample kits load asynchronously — surface the loaded state (and a clear
    // warning when nothing decoded) so the user knows why pads are silent.
    k.ready?.then((info) => {
      if (kit !== k) return;
      refreshSeqBtn();
      if (info && status) {
        status.textContent = info.loaded === 0
          ? `kit: 0/${info.total} samples loaded — check console`
          : `kit: ${info.loaded}/${info.total} samples`;
      }
    }).catch(() => {});
    return k;
  }
  // Connect a freshly-built kit into the live graph (limiter + analyser).
  function wireKit(k) {
    if (seqLimiter) k.output.connect(seqLimiter);
    // Tap the kit output (PRE-limiter) into the source analyser so the meter
    // reads true. ensureAnalyserAdopted creates `analyser` lazily; on a later
    // kit swap it already exists, so reconnect the new output here.
    if (analyser) k.output.connect(analyser);
  }
  function ensureKit() {
    if (kit) return;
    const rawCtx = Tone.getContext().rawContext;
    const rawDest = rawCtx.destination;
    // Brickwall limiter between the kit bus and the speakers — clip insurance
    // so a stack of loud hits can't push full-scale into the device-level sum.
    // Created once and reused across kit swaps.
    if (!seqLimiter) {
      seqLimiter = makeLimiter(rawCtx, _seqLimiterOn);
      seqLimiter.__qualiaBypassMute = true;
      seqLimiter.connect(rawDest);
    }
    const built = buildKit();
    if (!built) return;   // build failed (logged) — try again on next call
    kit = built;
    wireKit(kit);
    // Apply current mute state in case the user toggled it before the
    // first play (kit didn't exist yet, so the gain change had nowhere
    // to land).
    applyMuteToKit();
  }
  // Swap the live kit without a play/stop dance. Build + wire the new kit
  // first, then dispose the old one, so there's no silent gap (the old kit's
  // tails are cut, which is the expected feel of changing instruments).
  function setKit(id) {
    const next = resolveKit(id);
    // Record on the model even if the kit is unchanged — backfills a pattern
    // that had no kitId so the next save/export carries it.
    model.kitId = next.id;
    if (next.id === _kitId && kit) { refreshKitSelect(); return; }
    _kitId = next.id;
    saveSeqKit(_kitId);     // remember as last-used for fresh patterns
    model.updatedAt = Date.now();
    persistSoon();
    if (kit) {
      const built = buildKit();
      if (built) {
        const old = kit;
        kit = built;
        wireKit(kit);
        applyMuteToKit();
        try { old.dispose(); } catch {}
      }
    }
    refreshKitSelect();
    refreshSeqBtn();
  }
  function getKitId() { return _kitId; }
  // Mute is per-session, not persisted in the pattern model — it's a
  // performance gate ("silence this source for a moment"), not a saved
  // attribute of the pattern. Survives play/stop cycles within the
  // session because it lives on this closure. Output volume sits next to
  // it — same shape, but persisted across reloads via localStorage since
  // a mix-ride should survive a tab refresh.
  let _muted = false;
  let _volume = loadSeqVolume();  // 0..1, applied when un-muted
  let _seqLimiterOn = loadSeqLimiter();
  let seqLimiter = null;          // brickwall on the kit bus (created in ensureKit)

  // Mix-change listeners — fire on volume/mute/limiter change so the mixer
  // panel's seq channel and this panel's own slider stay in sync.
  const mixListeners = new Set();
  function onChange(fn) { mixListeners.add(fn); return () => mixListeners.delete(fn); }
  function notifyMix() {
    const snap = { volume: _volume, muted: _muted, limiter: _seqLimiterOn };
    mixListeners.forEach(fn => { try { fn(snap); } catch {} });
  }
  function setLimiter(on) {
    _seqLimiterOn = !!on;
    saveSeqLimiter(_seqLimiterOn);
    setLimiterEngaged(seqLimiter, _seqLimiterOn);
    notifyMix();
  }
  function getLimiter() { return _seqLimiterOn; }
  function applyMuteToKit() {
    if (!kit?.output?.gain) return;
    const target = _muted ? 0 : _volume;
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
    notifyMix();
  }
  function setVolume(v) {
    const clamped = Math.max(0, Math.min(1, Number(v) || 0));
    if (clamped === _volume) return;
    _volume = clamped;
    saveSeqVolume(_volume);
    applyMuteToKit();
    if (elGain && elGain.value !== String(_volume)) elGain.value = String(_volume);
    notifyMix();
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
    // Mirror play into Strudel FIRST so its cycle epoch is anchored
    // before we probe for the next boundary. Without this ordering the
    // probe sees `isStrudelPlaying === false` and the first tick falls
    // back to unaligned scheduling. Skip when this play was itself
    // triggered by Strudel (already playing) or sync is off.
    if (!opts.fromStrudel && model.syncStrudel && !_inhibitTransportSync) {
      try { syncStrudel?.playStrudel?.(); } catch {}
    }
    // Match Strudel's tempo before the first aligned schedule (best-effort —
    // Strudel's eval may set cps a beat later, in which case a manual realign
    // snaps it). Keeps the cell grid and boundary math on one clock.
    adoptStrudelCpsIfSynced();
    // Start at an explicit audio time we keep, so the align math below can
    // convert boundary times against the real transport-zero instead of the
    // post-start getTransport().seconds (clamped ~0 for a lookAhead window).
    const zeroAbs = Tone.now();   // = ctx.currentTime + lookAhead
    Tone.getTransport().start(zeroAbs);
    _transportZeroAudio = zeroAbs;
    // Start the pattern from cell 0 on Strudel's next phrase boundary (an
    // absolute cycle that's a multiple of `cycles`). Co-start → cycle 0
    // (immediate); joining a running Strudel → its next phrase top.
    const synced  = model.syncStrudel && syncStrudel?.isStrudelPlaying?.();
    const aligned = synced ? computeAlignedStart({ fromTop: true }) : null;
    if (aligned) {
      cellIdx = aligned.cellIdx;
      scheduleLoop({ startAtAbs: aligned.startAtAbs });
    } else {
      scheduleLoop({ align: true });   // fallback (no Strudel position yet)
    }
    // Only a cold start needs a warm correction: if Strudel just (re)started,
    // its scheduler isn't anchored yet so the align above used the epoch
    // estimate — re-lock once the real anchor lands. When Strudel was already
    // running the probe is exact, so skip it.
    if (synced && !syncStrudel?.isStrudelSchedulerFresh?.()) armAutoResync();
    ensureAnalyserAdopted();
    persistNow();
    refreshSeqBtn();
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
    clearAutoResync();
    try { Tone.getTransport().stop(); } catch {}
    _transportZeroAudio = null;
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

  // ── Double / halve helpers ───────────────────────────────────────────────
  // One-tap performance moves. Two hit-remap shapes:
  //   spread  — total cells ×2/÷2 at a CONSTANT span (resolution, beats):
  //             keep every hit's audible position, so hit i → 2i (and back,
  //             OR-ing the pair so a halve doesn't silently drop off-grid
  //             hits). The grid gets finer/coarser; the groove is unchanged.
  //   tile    — total cells ×2/÷2 by LENGTHENING the pattern (cycles+beats
  //             together, cell duration constant): repeat the groove into the
  //             new bars (×2) or keep the front half (÷2).
  function remapHitsSpread(up) {
    for (const pad of model.pads) {
      const old = pad.hits || [];
      if (up) {
        const next = new Array(old.length * 2).fill(0);
        for (let i = 0; i < old.length; i++) if (old[i]) next[i * 2] = 1;
        pad.hits = next;
      } else {
        const next = new Array(Math.ceil(old.length / 2)).fill(0);
        for (let j = 0; j < next.length; j++) next[j] = (old[2 * j] || old[2 * j + 1]) ? 1 : 0;
        pad.hits = next;
      }
    }
  }
  function remapHitsTile(newTotal) {
    for (const pad of model.pads) {
      const old = pad.hits || [];
      const len = old.length || 1;
      const next = new Array(newTotal).fill(0);
      for (let i = 0; i < newTotal; i++) next[i] = old[i % len] ? 1 : 0;
      pad.hits = next;
    }
  }
  // After any grid reshape, re-lock to Strudel (continuity, so the audible
  // position is preserved) when synced; otherwise just reschedule. Then
  // repaint props, helper-button enabled-states, and the matrix.
  function afterGridChange() {
    model.updatedAt = Date.now();
    if (isPlaying && model.syncStrudel && syncStrudel?.isStrudelPlaying?.()) resync();
    else rescheduleIfPlaying();
    refreshPropsValues();
    refreshScaleBtns();
    renderMatrix();
    persistSoon();
  }
  // Resolution: steps-per-beat ×2/÷2, spread hits (same audible positions).
  function scaleResolution(up) {
    if (up) { if (model.steps * 2 > 16) return; remapHitsSpread(true);  model.steps *= 2; }
    else    { if (model.steps % 2 !== 0)  return; remapHitsSpread(false); model.steps /= 2; }
    afterGridChange();
  }
  // Beats ×2/÷2, spread hits. Same span (cycles unchanged) → denser/sparser.
  function scaleBeats(up) {
    if (up) { if (model.beats * 2 > 32) return; remapHitsSpread(true);  model.beats *= 2; }
    else    { if (model.beats % 2 !== 0)  return; remapHitsSpread(false); model.beats /= 2; }
    afterGridChange();
  }
  // Length: cycles AND beats ×2/÷2 together (cell duration constant), tiling
  // the groove. cycles steps on the 0.5 ↔ 1 ↔ 2 … ladder.
  // Length ÷2 needs beats even AND cycles halvable onto the 0.5↔1↔2… ladder
  // (cycles === 1 → 0.5, or an even cycle count → half). An odd cycles like 3
  // can't halve cleanly, so it's blocked rather than producing 1.5.
  function canHalveLength() {
    return model.beats % 2 === 0 &&
           (model.cycles === 1 || (model.cycles >= 2 && model.cycles % 2 === 0));
  }
  function scaleLength(up) {
    if (up) {
      if (model.beats * 2 > 32 || model.cycles * 2 > 16) return;
      remapHitsTile(model.beats * 2 * model.steps);
      model.beats  *= 2;
      model.cycles *= 2;
    } else {
      if (!canHalveLength()) return;
      remapHitsTile((model.beats / 2) * model.steps);
      model.beats  /= 2;
      model.cycles  = model.cycles === 1 ? 0.5 : model.cycles / 2;
    }
    afterGridChange();
  }
  function refreshScaleBtns() {
    if (!_scaleBtns) return;
    const b = _scaleBtns;
    if (b.resHalf) b.resHalf.disabled = (model.steps % 2 !== 0);
    if (b.resDbl)  b.resDbl.disabled  = (model.steps * 2 > 16);
    if (b.beatHalf) b.beatHalf.disabled = (model.beats % 2 !== 0);
    if (b.beatDbl)  b.beatDbl.disabled  = (model.beats * 2 > 32);
    if (b.lenHalf) b.lenHalf.disabled = !canHalveLength();
    if (b.lenDbl)  b.lenDbl.disabled  = (model.beats * 2 > 32 || model.cycles * 2 > 16);
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
    const stepperFor = (input, eventName, bumpFn) => {
      const wrap = document.createElement('span');
      wrap.className = 'seq-num-wrap';
      const step = parseFloat(input.step) || 1;
      const min  = input.min !== '' ? parseFloat(input.min) : -Infinity;
      const max  = input.max !== '' ? parseFloat(input.max) : Infinity;
      const isInt = Number.isInteger(step);
      const decimals = isInt ? 0 : Math.max(0, (String(step).split('.')[1] || '').length);
      // Custom stepping (e.g. cycles: 0.5 → 1 → 2 → 3…) overrides the linear
      // default; it owns setting input.value and dispatching the event.
      const bump = bumpFn || ((delta) => {
        const cur = parseFloat(input.value);
        const base = Number.isFinite(cur) ? cur : (Number.isFinite(min) ? min : 0);
        let next = base + delta * step;
        next = Math.min(max, Math.max(min, next));
        // toFixed avoids float drift (0.05+0.05=0.10000000001) bleeding
        // into the displayed value.
        input.value = isInt ? String(Math.round(next)) : next.toFixed(decimals);
        input.dispatchEvent(new Event(eventName, { bubbles: true }));
      });
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
      refreshScaleBtns();
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
      refreshScaleBtns();
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

    // Cycles-per-pattern stretch. Practical values: 0.5 (double-time, the
    // only sub-1 case) then whole cycles 1, 2, 3, 4… The +/- stepper walks
    // 0.5 ↔ 1 ↔ 2 ↔ 3 — no in-between halves above 1.
    const cyclesIn = document.createElement('input');
    cyclesIn.type = 'number'; cyclesIn.step = '1'; cyclesIn.min = '0.5'; cyclesIn.max = '16';
    cyclesIn.value = String(model.cycles);
    cyclesIn.className = 'seq-num seq-num-wide';
    cyclesIn.addEventListener('change', () => {
      let v = parseFloat(cyclesIn.value);
      if (!Number.isFinite(v)) v = 1;
      // Snap to the allowed set: 0.5, or a whole number ≥ 1.
      v = v < 0.75 ? 0.5 : Math.round(v);
      v = Math.max(0.5, Math.min(16, v));
      cyclesIn.value = v === 0.5 ? '0.5' : String(v);
      if (v === model.cycles) return;
      model.cycles = v;
      model.updatedAt = Date.now();
      rescheduleIfPlaying();
      refreshScaleBtns();
      persistSoon();
    });
    // Whole steps above 1; 0.5 is the single sub-1 stop.
    const cyclesBump = (delta) => {
      let cur = parseFloat(cyclesIn.value);
      if (!Number.isFinite(cur)) cur = 1;
      let next = delta > 0
        ? (cur < 1 ? 1 : cur + 1)
        : (cur > 1 ? cur - 1 : 0.5);
      next = Math.max(0.5, Math.min(16, next));
      cyclesIn.value = next === 0.5 ? '0.5' : String(Math.round(next));
      cyclesIn.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const syncCb = document.createElement('input');
    syncCb.type = 'checkbox';
    syncCb.checked = !!model.syncStrudel;
    syncCb.addEventListener('change', () => {
      model.syncStrudel = !!syncCb.checked;
      model.updatedAt = Date.now();
      persistSoon();
      refreshSyncStatus();
      refreshSyncBtnVisibility();
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

    // ÷2 / ×2 helper pair. Live "double it / halve it" moves that preserve
    // the groove — buttons disable themselves when the move isn't valid.
    const scalePair = (label, title, onHalf, onDouble) => {
      const wrap = document.createElement('span');
      wrap.className = 'seq-prop';
      if (title) wrap.title = title;
      const sp = document.createElement('span');
      sp.className = 'seq-prop-label';
      sp.textContent = label;
      const grp = document.createElement('span');
      grp.className = 'seq-num-wrap';
      const mkB = (txt, fn, t) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ctrl-btn seq-num-step';
        b.textContent = txt;
        b.title = t;
        b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
        return b;
      };
      const bHalf = mkB('÷2', onHalf, title + ' — halve');
      const bDbl  = mkB('×2', onDouble, title + ' — double');
      grp.append(bHalf, bDbl);
      wrap.append(sp, grp);
      return { wrap, bHalf, bDbl };
    };
    const sRes = scalePair('res', 'Resolution (steps per beat) — keeps every hit at the same audible time, just finer/coarser grid', () => scaleResolution(false), () => scaleResolution(true));
    const sBeat = scalePair('beats', 'Beats ×2/÷2 — denser/sparser within the same span; hits keep their audible time', () => scaleBeats(false), () => scaleBeats(true));
    const sLen = scalePair('len', 'Length — cycles + beats together (tempo unchanged), groove tiled into the longer/shorter pattern', () => scaleLength(false), () => scaleLength(true));
    _scaleBtns = {
      resHalf: sRes.bHalf, resDbl: sRes.bDbl,
      beatHalf: sBeat.bHalf, beatDbl: sBeat.bDbl,
      lenHalf: sLen.bHalf, lenDbl: sLen.bDbl,
    };

    // Kit picker — the instrument the pads play through. Switching is live;
    // the same groove re-voices onto the new kit (see setKit). Synth kits are
    // instant; sample kits decode their pack in the background.
    const kitSel = document.createElement('select');
    kitSel.className = 'seq-kit-select';
    populateKitOptions(kitSel);
    kitSel.addEventListener('change', () => setKit(kitSel.value));
    _kitSelectEl = kitSel;
    // ‹ › step through the kit list (wraps) — faster than opening the dropdown
    // to audition adjacent kits during a set.
    const kitNav = document.createElement('span');
    kitNav.className = 'seq-kit-nav';
    const mkNavBtn = (txt, dir, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctrl-btn seq-kit-arrow';
      b.textContent = txt;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', (e) => { e.preventDefault(); stepKit(dir); });
      return b;
    };
    kitNav.append(mkNavBtn('‹', -1, 'Previous kit'), kitSel, mkNavBtn('›', +1, 'Next kit'));

    propsEl.append(
      mk('kit',       kitNav, { title: 'Instrument the pads play through. Synth kits are offline; sample kits load the same strudel.json packs Strudel uses.' }),
      mkPackLoader(),
      mk('beats',     stepperFor(beatsIn, 'change'), { title: 'Beats per pattern (RR-style)' }),
      mk('steps/beat', stepperFor(stepsIn, 'change'), { title: 'Subdivisions per beat — 3 for triplets, 5 for quintuplets, etc.' }),
      mk('cps',       stepperFor(cpsIn,  'input'),  { title: 'Cycles per second — Strudel\'s master clock when sync is on' }),
      mk('cycles',    stepperFor(cyclesIn, 'change', cyclesBump), { title: 'Cycles per pattern — how many Strudel cycles the pattern spans. 0.5 = double-time, 1 = locked, 2 = half-time, 3, 4… = longer phrases. Spreads the same grid across more bars without slowing CPS.' }),
      sRes.wrap, sBeat.wrap, sLen.wrap,
      syncWrap,
    );
    refreshScaleBtns();
  }
  // Keep the kit dropdown in sync when the kit is changed programmatically
  // (e.g. a future remote/macro path) or re-rendered.
  let _kitSelectEl = null;
  let _packStatusEl = null;
  function refreshKitSelect() {
    if (_kitSelectEl && _kitSelectEl.value !== _kitId) _kitSelectEl.value = _kitId;
  }
  // (Re)fill a kit <select> with the static catalog + any loaded external packs.
  // A flat list of full "genre · variant" labels — optgroups render as bulky,
  // non-selectable headers on mobile and bury the actual options, so we avoid
  // them. Called on render and whenever a pack is loaded.
  function populateKitOptions(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    for (const k of [...KITS, ..._dynamicKits.values()]) {
      const opt = document.createElement('option');
      opt.value = k.id;
      opt.textContent = k.label;   // e.g. "voidstar · synth"
      opt.title = k.desc || '';
      sel.appendChild(opt);
    }
    sel.value = _kitId;
  }
  // Step the selection through the ordered kit list (static + loaded), wrapping
  // at the ends. Drives the ‹ › buttons.
  function stepKit(dir) {
    const ids = [...KITS, ..._dynamicKits.values()].map((k) => k.id);
    if (!ids.length) return;
    let i = ids.indexOf(_kitId);
    if (i < 0) i = 0;
    i = (i + dir + ids.length) % ids.length;
    setKit(ids[i]);
  }
  function setPackStatus(msg, isErr) {
    if (!_packStatusEl) return;
    _packStatusEl.textContent = msg || '';
    _packStatusEl.dataset.state = isErr ? 'err' : '';
  }
  // Build the one-click GitHub pack loader: a text field + load button + genre
  // preset chips. Loads into BOTH engines — registers the pack in Strudel (so
  // s("name") / .bank() work in the REPL) and adds a runtime sequencer sample
  // kit (best-effort name matching), then selects it.
  function mkPackLoader() {
    const wrap = document.createElement('div');
    wrap.className = 'seq-pack-loader';

    const row = document.createElement('div');
    row.className = 'seq-pack-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'seq-pack-input';
    input.placeholder = 'github:user/repo or strudel.json URL';
    input.title = 'Load a Strudel sample pack into both engines';
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'ctrl-btn';
    loadBtn.textContent = 'load';
    loadBtn.addEventListener('click', () => loadPack(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadPack(input.value); } });
    row.append(input, loadBtn);

    const chips = document.createElement('div');
    chips.className = 'seq-pack-presets';
    for (const p of PACK_PRESETS) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'ctrl-btn seq-pack-chip';
      c.textContent = p.label;
      c.title = `${p.title} — ${p.spec}`;
      c.addEventListener('click', () => { input.value = p.spec; loadPack(p.spec); });
      chips.appendChild(c);
    }

    const status = document.createElement('div');
    status.className = 'seq-pack-status';
    _packStatusEl = status;

    wrap.append(row, chips, status);
    return wrap;
  }
  // Load a pack spec (github:user/repo or a strudel.json URL) into both engines.
  async function loadPack(input) {
    const spec = parsePackSpec(input);
    if (!spec) { setPackStatus('enter github:user/repo or a strudel.json URL', true); return; }
    setPackStatus(`loading "${spec.label}"…`);
    // Strudel side (best-effort; sequencer still gets the kit if this fails).
    let okStrudel = false;
    try { okStrudel = !!(await syncStrudel?.loadSamplesSpec?.(spec.strudelArg)); } catch {}
    // Sequencer side: register + persist a dynamic sample kit, then select it.
    addDynamicKit(spec);
    const list = loadExtPacks().filter((p) => p.id !== spec.id);
    list.unshift(spec);
    saveExtPacks(list);
    populateKitOptions(_kitSelectEl);
    setKit(spec.id);   // builds the kit (decodes buffers in the background)
    setPackStatus(okStrudel
      ? `loaded "${spec.label}" → Strudel + sequencer kit`
      : `loaded "${spec.label}" → sequencer kit (open Strudel to use s("…"))`);
  }
  // Re-register restored external packs into Strudel once it's ready — lazily,
  // so a boot that never opens Strudel doesn't force-load its bundle.
  let _extPacksPushedToStrudel = false;
  function pushExtPacksToStrudel() {
    if (_extPacksPushedToStrudel) return;
    const packs = loadExtPacks();
    if (!packs.length) return;
    _extPacksPushedToStrudel = true;
    for (const p of packs) { try { syncStrudel?.loadSamplesSpec?.(p.strudelArg); } catch {} }
  }
  function refreshPropsValues() {
    if (!propsEl) return;
    const inputs = propsEl.querySelectorAll('input[type="number"]');
    if (inputs.length >= 4) {
      inputs[0].value = String(model.beats);
      inputs[1].value = String(model.steps);
      inputs[2].value = String(model.cps);
      inputs[3].value = String(model.cycles);
    }
    const cb = propsEl.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = !!model.syncStrudel;
    refreshKitSelect();
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
    colCells = Array.from({ length: total }, () => []);
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
      // Floor the per-cell width at 16px — small enough that a 16-cell
      // row fits a phone-narrow viewport without horizontal scroll, but
      // still wide enough to be tappable. If the total exceeds the
      // available width, #seq-matrix-wrap (overflow:auto) scrolls
      // horizontally instead of squashing the cells.
      cellsEl.style.gridTemplateColumns = `repeat(${total}, minmax(16px, 1fr))`;
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
        colCells[i].push(c);
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
    // Walk cached column refs — no per-step querySelectorAll over the grid.
    if (lastPaintedStep >= 0 && colCells[lastPaintedStep]) {
      for (const el of colCells[lastPaintedStep]) el.classList.remove('cur');
    }
    if (stepIdx >= 0 && colCells[stepIdx]) {
      for (const el of colCells[stepIdx]) el.classList.add('cur');
    }
    lastPaintedStep = stepIdx;
  }

  // ── Topbar button paint ────────────────────────────────────────────────
  function refreshSeqBtn() {
    if (!btnToggle) return;
    btnToggle.classList.remove('active', 'active-audio');
    const live = audio.hasSource('sequencer');
    const open = panel?.style.display !== 'none';
    if (open) btnToggle.classList.add('active');
    btnToggle.textContent = live ? 'seq ●' : 'seq';
    if (status) {
      if (live)       status.textContent = 'audio: live';
      else if (open)  status.textContent = isPlaying ? 'starting…' : 'click ▶ to play';
    }
  }

  // ── Drag / reposition / persist (shared helper) ────────────────────────
  const reposition = makeDraggablePanel('sequencer', panel);

  // ── Tabs ───────────────────────────────────────────────────────────────
  // grid + settings aren't mutually exclusive: they're independent show/hide
  // toggles so the pad matrix and the pattern-settings controls can stay on
  // screen together (settings stacked above the matrix), or either one
  // collapsed to reclaim space. patterns is an exclusive view — its save/load
  // list replaces the edit panes while open; tapping grid/settings leaves it.
  let patternsOpen = false;
  let showGrid     = true;
  let showSettings = loadShowSettings();

  function applyTabs() {
    const editGrid     = !patternsOpen && showGrid;
    const editSettings = !patternsOpen && showSettings;
    if (gridPane)     gridPane.style.display     = editGrid     ? '' : 'none';
    if (settingsPane) settingsPane.style.display = editSettings ? '' : 'none';
    if (patternsPane) patternsPane.style.display = patternsOpen ? 'flex' : 'none';
    // When the grid is hidden, let settings expand to fill the body instead
    // of sitting capped at its half-height with dead space below it.
    settingsPane?.classList.toggle('solo', editSettings && !editGrid);
    tabBar?.querySelectorAll('.sp-tab').forEach(t => {
      const on = t.dataset.tab === 'grid'     ? editGrid
               : t.dataset.tab === 'settings' ? editSettings
               : t.dataset.tab === 'patterns' ? patternsOpen
               : false;
      t.classList.toggle('active', on);
    });
  }

  function setTab(name) {
    if (name === 'patterns') {
      // Non-toggle: always surface (and refresh) the list. Callers like the
      // save-current button rely on a click here meaning "show patterns".
      patternsOpen = true;
      renderPatternList();
    } else if (patternsOpen) {
      // Leaving the patterns view — reveal whichever pane was tapped.
      patternsOpen = false;
      if (name === 'grid')          showGrid = true;
      else if (name === 'settings') showSettings = true;
    } else {
      // Edit view: toggle the tapped pane, but never hide both at once.
      if (name === 'grid' && !(showGrid && !showSettings))          showGrid = !showGrid;
      else if (name === 'settings' && !(showSettings && !showGrid)) showSettings = !showSettings;
    }
    if (name === 'settings') {
      if (showSettings && !propsEl?.children.length) renderProps();
      saveShowSettings(showSettings);
    }
    applyTabs();
  }
  tabBar?.querySelectorAll('.sp-tab').forEach(t => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });
  applyTabs();

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
    applyModel(found);
  }
  // Replace the live sequencer model with an arbitrary external one (used by
  // the qualem state-saving system to recall a snapshot's grid). The argument
  // is deep-cloned so the caller's reference can't bleed into edits.
  function applyModel(next) {
    if (!next || typeof next !== 'object') return;
    const wasPlaying = isPlaying;
    if (wasPlaying) stop();
    model = JSON.parse(JSON.stringify(next));
    if (typeof model.syncStrudel !== 'boolean') model.syncStrudel = true;
    if (typeof model.cycles !== 'number' || !(model.cycles > 0)) model.cycles = 1;
    if (typeof model.kitId !== 'string') model.kitId = _kitId;
    // Recall the pattern's saved instrument (swaps the live kit if needed).
    setKit(model.kitId);
    if (nameInput) nameInput.value = model.name || '';
    refreshPropsValues();
    refreshSyncBtnVisibility();
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
      cps: 0.5, beats: 4, steps: 4, cycles: 1,
      // Default sync ON for fresh-blank patterns too — matches
      // defaultPattern() and pickInitialModel()'s upgrade path.
      syncStrudel: true,
      // Keep the current instrument on a fresh blank pattern.
      kitId: _kitId,
      pads: VOICES.map(v => makePad(v.id, empty(total))),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    if (model.syncStrudel) {
      const stTitle = strudelTitleForName();
      if (stTitle) model.name = stTitle;
    }
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
    model.kitId = _kitId;   // keep the current instrument, not the default
    // Sprinkle a little chaos on top of the default groove so each
    // "random" press produces a different starting point. Keep kick/snare
    // as-is so the result is recognisable as a beat.
    for (const pad of model.pads) {
      if (pad.voice === 'kick' || pad.voice === 'snare') continue;
      for (let i = 0; i < pad.hits.length; i++) {
        if (Math.random() < 0.18) pad.hits[i] = 1;
      }
    }
    if (model.syncStrudel) {
      const stTitle = strudelTitleForName();
      if (stTitle) model.name = stTitle;
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
  // Sticky in-session "this panel has been revealed at least once" flag.
  // Cross-panel sync (transport/CPS/title) waits until BOTH the sequencer
  // and strudel panels have been opened, so a fresh page load where the
  // user only opens one doesn't surprise them by driving the other.
  // Restored panels (wasOpenLastSession → open() below) count as opened.
  let _everOpened = false;
  function open() {
    if (panel) panel.style.display = '';
    _everOpened = true;
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
  if (elGain) {
    elGain.value = String(_volume);
    elGain.addEventListener('input', () => setVolume(elGain.value));
  }
  if (btnSync) btnSync.addEventListener('click', () => { resync(); });
  function refreshSyncBtnVisibility() {
    if (!btnSync) return;
    btnSync.style.display = model.syncStrudel ? '' : 'none';
  }
  refreshSyncBtnVisibility();
  if (nameInput) nameInput.addEventListener('change', () => {
    model.name = nameInput.value;
    model.updatedAt = Date.now();
    persistSoon();
    // When sync is on, propagate the rename into the strudel @title so
    // both engines read as the same session. Skip empty inputs so users
    // can clear the field without nuking the strudel title.
    if (model.syncStrudel) {
      const trimmed = (nameInput.value || '').trim();
      if (trimmed) {
        try { syncStrudel?.setStrudelTitle?.(trimmed); }
        catch (e) { console.warn('[qualia] propagate name to strudel failed:', e); }
      }
    }
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
  syncStrudel?.onReadyChange?.(() => { refreshSyncStatus(); pushExtPacksToStrudel(); });
  // If Strudel is already ready at construction (panel reopened from a prior
  // session), push restored packs now rather than waiting for a ready flip.
  if (syncStrudel?.isReady?.()) pushExtPacksToStrudel();

  // Mirror strudel @title changes (random rolls, pattern loads, manual
  // edits) into the sequencer name while sync is on. We don't echo this
  // back via setStrudelTitle — the listener fires AFTER strudel already
  // settled on the new title, and we only update programmatically (no
  // user-input 'change' event), so the propagate-back path can't fire.
  syncStrudel?.onStrudelTitleChange?.((title) => {
    if (!model.syncStrudel) return;
    const next = (title || '').trim();
    if (!next || next === model.name) return;
    model.name = next;
    model.updatedAt = Date.now();
    if (nameInput) nameInput.value = next;
    persistSoon();
  });

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
    hasBeenOpened: () => _everOpened,
    isPlaying: () => isPlaying,
    isMuted:   () => _muted,
    setMuted,
    // Mixer surface — level/limiter control + change subscription.
    setVolume,
    getVolume: () => _volume,
    setLimiter,
    getLimiter,
    onChange,
    // Kit selection — instrument the pads play through.
    getKits: () => KITS.map(({ id, label, type, desc }) => ({ id, label, type, desc })),
    getKitId,
    setKit,
    play, stop,
    playFromStrudel, stopFromStrudel,
    setCps,
    getCps:    () => model.cps,
    isSyncOn:  () => !!model.syncStrudel,
    setSync:   (on) => { model.syncStrudel = !!on; persistSoon(); refreshSyncBtnVisibility(); },
    applyCpsFromStrudel,
    resync,
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
      applyModel,
    },
  };
}
