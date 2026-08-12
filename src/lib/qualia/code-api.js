// The qualia code API — the live-coding control surface for the whole
// instrument.
//
// Two layers, one install:
//
//   1. `globalThis.qualia` — a structured control object covering quales,
//      params/presets, top-level effects (overlay/glitches/logo/cam-walk),
//      transport-level visuals (phase/cycle/transition), camera + pose,
//      audience entanglement, and the audio engines (mixer, strudel,
//      sequencer, looper/rig, vox). strudel-hydra.js CREATES the object
//      (setParam/getField + editor knobs); page-init extends it with a few
//      perf setters; this module merges the full surface on top. Existing
//      keys are never clobbered — back-compat with every pattern that
//      already calls `qualia.setParam(...)`.
//
//   2. Strudel-side pattern functions (`quale`, `qset`, `qpreset`,
//      `qphase`, `qglitch`, `qtext`, `qcall`, `qtrig`) — registered through
//      Strudel's own `register()` once the @strudel/repl bundle's
//      evalScope globals appear, so they're first-class Pattern citizens:
//      they mini-notate, chain, and respect `.slow()/.fast()/.euclid()`
//      like any stock function. Control lanes are silent (dominant
//      onTrigger) and are meant to ride inside `stack(...)` next to the
//      audio; `qtrig` is the non-dominant variant for hanging visual
//      side-effects off a sounding pattern.
//
// Getter/setter convention: one function per knob — call with no args to
// read, with a value to write (the applied value is returned either way).
// That keeps live-code terse: `qualia.cam.walk(true)`, `qualia.zen()`.
// Scalar knobs are additionally PATTERNABLE: handed a Strudel Pattern
// instead of a value they return a silent control lane — see the patterned-
// knobs block below the helpers.
//
// Everything here is a trusted-performer surface (same posture as
// setParam): values are clamped by the receiving engines, not validated
// here, and failures degrade to console warnings — a live set must never
// throw out of a pattern callback.

import { THEMES, getTheme, setTheme, cycleTheme } from './theme.js';
import { CHANNEL_IDS } from './modulation.js';
import { AUDIO_PRESET_NAMES, loadFxUserPresets, saveFxUserPreset } from './presets.js';
import * as qualemStore from './qualem.js';
import { getRotation, setRotation, getMirror, setMirror } from './video.js';
import { QUALIA_FUNCTIONS } from './strudel-reference.js';
import { getBool, setBool } from './prefs.js';
import {
  parseRoot, parseEdoSpec, parseRatio, parseTuneSpec,
  edoFreq, centsFactor, scaleDegree, jiRetune, noteNameToMidi,
} from './microtonal.js';

// Do pattern lanes switch off the hands-off timer they'd otherwise fight?
// Persisted, default on — see the auto-yield note down in the bindings. Cached
// in a module local because every lane hap reads it: localStorage.getItem is
// sync main-thread I/O and a `.segment(16)` lane would hit it 16×/cycle.
const AUTO_YIELD_KEY = 'voidstar.qualia.autoYield';
let _autoYield = getBool(AUTO_YIELD_KEY, true);

/** No-throw wrapper for engine calls made from pattern callbacks. */
function safe(fn, fallback = null) {
  try { return fn(); } catch (e) { console.warn('[qualia] code api:', e); return fallback; }
}

// ── Patterned knobs ───────────────────────────────────────────────────────
// Inside the Strudel editor, double-quoted strings mini-notate into Pattern
// objects before the call even happens (stock Strudel transpilation — single
// quotes stay plain strings). So `qualia.cam.walk("<0 1>/4")` reaches the
// knob as a Pattern, and every scalar knob built on gs/gsBool detects that
// and, instead of writing once, returns a SILENT CONTROL LANE that drives
// the knob per event at its audible time — stack it next to the audio
// exactly like quale()/qset(). Signals work too:
// `qualia.pose.scale(sine.range(.5, 1).segment(8))`.
//
// A knob lane never claims an auto timer (none of these knobs are ones
// auto-cycle/auto-phase write), and like every lane it only fires while the
// evaluated pattern queries it — as a bare top-level statement it's inert.
// Imperative calls (booleans, numbers, single-quoted strings) are unchanged.

/** Duck-typed Pattern check — instanceof is fragile against the CDN bundle. */
function isPattern(v) {
  return !!v && typeof v === 'object'
    && typeof v.onTrigger === 'function' && typeof v.queryArc === 'function';
}

/** Mini-notation-friendly boolean: numbers > 0 are on; the words
 *  off/false/0 (and empty) are off, anything else stringy is on. */
function patBool(v) {
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') return !(v === '' || v === '0' || v === 'off' || v === 'false');
  return !!v;
}

/** Silent control lane calling `apply(value)` per event at audible time. */
function knobLane(pat, apply) {
  return pat.onTrigger(
    (...args) => atAudibleTime(args, (hap) => safe(() => apply(laneValue(hap)))),
    true);
}

/** get/set combinator: fn() reads, fn(v) writes-then-reads, fn(pattern)
 *  returns a lane writing per event. */
function gs(get, set) {
  return (v) => {
    if (v === undefined) return get();
    if (isPattern(v)) return knobLane(v, set);
    set(v);
    return get();
  };
}

/** Boolean get/set: accepts any truthy/falsy write, or a pattern of them. */
function gsBool(get, set) {
  return (on) => {
    if (on === undefined) return !!get();
    if (isPattern(on)) return knobLane(on, (v) => set(patBool(v)));
    set(!!on);
    return !!get();
  };
}

/**
 * Resolve an auto-timer period argument. Numbers are seconds (0 = off);
 * `false` is off; `true` resumes the remembered dwell — the same value the
 * topbar toggle turns back on to — so undoing an auto-yield (or any
 * `autoCycle(0)`) is one call and doesn't need the performer to remember what
 * the dwell was.
 */
function autoSeconds(v, dwell) {
  if (v === true)  return dwell();
  if (v === false) return 0;
  return Math.max(0, +v || 0);
}

/** Shallow-copy a config get/patch pair: fn() snapshots, fn(patch) merges. */
function gsConfig(get, patch) {
  return (cfg) => {
    if (cfg && typeof cfg === 'object') patch(cfg);
    return { ...get() };
  };
}

/**
 * Merge the full code API into `globalThis.qualia` and start watching for
 * the Strudel globals so the pattern functions register themselves.
 *
 * @param {Object} deps  Engine handles + page-scope helpers from page-init.
 * @returns the merged api object (also on globalThis.qualia).
 */
export function installCodeApi(deps) {
  const {
    core, mesh, strudel, audio, sequencer, looper, vocoder, harmonizer,
    pose, overlay, camWalk, logoMark, fader, echoCtl, page,
  } = deps;

  // ── Quale resolution ──────────────────────────────────────────────────────
  // Live-coders type names, not exact ids. Resolve exact id → exact name →
  // case-insensitive id/name → unique prefix. Null (with a warning listing
  // valid ids) when nothing matches — a typo mid-set should fizzle, not throw.
  function resolveQualeId(q) {
    if (typeof q !== 'string' || !q.trim()) return null;
    const want = q.trim();
    if (mesh.get(want)) return want;
    const mods = mesh.list();
    const lower = want.toLowerCase();
    const byName = mods.find(m => m.name.toLowerCase() === lower)
                || mods.find(m => m.id.toLowerCase() === lower);
    if (byName) return byName.id;
    const prefixed = mods.filter(m =>
      m.id.toLowerCase().startsWith(lower) || m.name.toLowerCase().startsWith(lower));
    if (prefixed.length === 1) return prefixed[0].id;
    console.warn(`[qualia] unknown quale "${q}" — try one of:`, mesh.ids().join(', '));
    return null;
  }

  function setQuale(q) {
    const id = resolveQualeId(q);
    if (!id) return null;
    if (id !== core.activeId()) {
      // Same path as the topbar select: honor the scene transition style and
      // the cycle-boundary quantize setting so code-driven switches land like
      // UI-driven ones.
      page.applySceneChange(() => {
        core.setActive(id).catch(err => console.error('[qualia] code api setActive failed:', err));
      });
    }
    return id;
  }

  function setActiveParam(name, value) {
    const fxId = core.activeId();
    if (!fxId) return false;
    return core.setParam(fxId, name, value);
  }

  // Memo for api.phaseParams() — a dense `qset` lane asks on every hap, and the
  // answer only changes when the active quale does.
  let _phaseParams = { id: null, ids: [] };

  // ── The api object ────────────────────────────────────────────────────────
  const api = {
    // — quales —
    /** List registered quales as [{id, name}] in dropdown order. */
    quales: () => mesh.list().map(m => ({ id: m.id, name: m.name })),
    /** Active quale id; pass an id/name (fuzzy) to switch. `null` → the null quale. */
    quale: (q) => (q === undefined ? core.activeId() : setQuale(q === null ? 'null' : q)),
    nextQuale: () => { page.qualeStep(+1); return core.activeId(); },
    prevQuale: () => { page.qualeStep(-1); return core.activeId(); },
    /** Blank the fx layer (switch to the null quale). Hydra + overlay stay live. */
    nullQuale: () => setQuale('null'),
    randomQuale: () => {
      // autoPick:false quales (null) don't come up on a random roll.
      const ids = mesh.list()
        .filter(m => m.autoPick !== false && m.id !== core.activeId())
        .map(m => m.id);
      return ids.length ? setQuale(ids[(Math.random() * ids.length) | 0]) : core.activeId();
    },

    // — params on the ACTIVE quale —
    /** Param specs for the active (or named) quale: [{id,label,type,...}]. */
    params: (fxId) => {
      const mod = mesh.get(fxId || core.activeId() || '');
      return mod ? mod.params.map(p => ({ ...p })) : [];
    },
    /** set('thickness', 0.7) or set({thickness: 0.7, palette: 'cyan'}). */
    set: (name, value) => {
      if (name && typeof name === 'object') {
        let ok = true;
        for (const [k, v] of Object.entries(name)) ok = setActiveParam(k, v) && ok;
        return ok;
      }
      return setActiveParam(name, value);
    },
    /** Live RESOLVED param value(s) — base ⊕ modulators, as the fx sees them. */
    get: (name) => (name === undefined ? { ...core.field.params } : core.field.params[name]),

    // — presets (factory + user) on the active quale —
    /** preset() lists {factory, user} names; preset(name) applies one. */
    preset: (name) => {
      const fxId = core.activeId();
      if (!fxId) return null;
      if (name === undefined) {
        return {
          factory: Object.keys(mesh.get(fxId)?.presets || {}),
          user:    Object.keys(loadFxUserPresets(fxId)),
        };
      }
      if (core.applyFxPreset(name)) return name;
      const user = loadFxUserPresets(fxId)[name];
      if (user) {
        for (const [k, v] of Object.entries(user)) core.setParam(fxId, k, v);
        return name;
      }
      console.warn(`[qualia] unknown preset "${name}" for ${fxId}`);
      return null;
    },
    /** Save the active quale's current base params as a user preset. */
    savePreset: (name) => {
      const fxId = core.activeId();
      if (!fxId || !name) return null;
      saveFxUserPreset(fxId, String(name), core.getBaseParams());
      return String(name);
    },

    // — phase / cycle / transitions —
    /** Step the active quale's phase (dir ±1). True if a step landed — false
     *  when the active quale declares no phases (or all of them are pooled
     *  out), which is what the qphase lane's auto-yield keys off. */
    phase: (dir = 1) => !!page.phaseShift(dir >= 0 ? +1 : -1),
    /** autoPhase() → {seconds, style}; autoPhase(10, 'random') sets both.
     *  0/false = off, true = resume the remembered dwell. */
    autoPhase: (seconds, style) => {
      if (seconds !== undefined) page.setPhasePeriod(autoSeconds(seconds, page.getPhaseDwell));
      if (style !== undefined) page.setPhaseStyle(style);
      return { seconds: page.getPhasePeriod(), style: page.getPhaseStyle() };
    },
    /** autoCycle() → {seconds, style}; autoCycle(30, 'random') sets both.
     *  0/false = off, true = resume the remembered dwell. */
    autoCycle: (seconds, style) => {
      if (seconds !== undefined) page.setCyclePeriod(autoSeconds(seconds, page.getCycleDwell));
      if (style !== undefined) page.setCycleStyle(style);
      return { seconds: page.getCyclePeriod(), style: page.getCycleStyle() };
    },
    /** Do pattern lanes switch off the timer they'd fight? Default true;
     *  `autoYield(false)` lets both run (the old behaviour). */
    autoYield: gsBool(() => _autoYield, (on) => { _autoYield = on; setBool(AUTO_YIELD_KEY, on); }),
    /** Param ids the active quale's auto-phase steps write — i.e. the params a
     *  `qset` lane would end up fighting auto-phase over. Empty when the quale
     *  declares no phases. Cached per quale; treat the array as read-only. */
    phaseParams: () => {
      const id = core.activeId() || '';
      if (_phaseParams.id !== id) {
        const steps = mesh.get(id)?.autoPhase?.steps;
        const out = new Set();
        if (Array.isArray(steps)) for (const s of steps) for (const k of Object.keys(s || {})) out.add(k);
        _phaseParams = { id, ids: [...out] };
      }
      return _phaseParams.ids;
    },
    /** Scene-change bridge: transition() → {style, ms}; transition('wipe', 1200). */
    transition: (style, ms) => page.setTransition(style, ms),
    /** Quantize scene changes to the Strudel cycle: 'cycle'|'off' (or bool). */
    quantize: (mode) => page.setQuantize(
      mode === undefined ? undefined : (mode === true ? 'cycle' : mode === false ? 'off' : mode)),

    // — top-level effects —
    /** overlay('skeleton') reads; overlay('sparks', false) writes;
     *  overlay('sparks', "<0 1>") returns a lane toggling per event. */
    overlay: (key, on) => {
      if (on === undefined) return overlay.getOption(key);
      if (isPattern(on)) return knobLane(on, (v) => overlay.setOption(key, patBool(v)));
      overlay.setOption(key, !!on);
      return overlay.getOption(key);
    },
    sparkStyle: gs(() => overlay.getSparkStyle(), (s) => overlay.setSparkStyle(s)),
    /** glitch() → all modes; glitch('mosh') reads; glitch('mosh','flip') writes. */
    glitch: (name, mode) => {
      if (name === undefined) return page.getGlitchModes();
      if (mode !== undefined) page.setGlitchMode(name, mode);
      return page.getGlitchModes()[name];
    },
    mosh:   gsConfig(() => overlay.getMoshConfig(),   (c) => overlay.setMoshConfig(c)),
    edge:   gsConfig(() => overlay.getEdgeConfig(),   (c) => overlay.setEdgeConfig(c)),
    stitch: gsConfig(() => overlay.getStitchConfig(), (c) => overlay.setStitchConfig(c)),
    logo:       gsBool(() => logoMark.isEnabled(), (on) => page.setLogoOn(on)),
    logoConfig: gsConfig(() => logoMark.getConfig(), (c) => logoMark.setConfig(c)),

    // — set-level fades (the slow open / close of a set) —
    /** Fade the whole instrument: every audio bus ramps natively in its own
     *  context AND the stage fades to black (mirrored into recordings).
     *  fadeOut(20) → 20 s to silence + black; fadeIn(20) back to full.
     *  opts {audio:false} / {visuals:false} fade only one side. Mixer levels
     *  are untouched (the fade multiplies them) and nothing persists — a
     *  reload always comes back at full level. */
    fadeOut: (seconds, opts) => safe(() => fader.fadeOut(seconds, opts)),
    fadeIn:  (seconds, opts) => safe(() => fader.fadeIn(seconds, opts)),
    /** fade(level, seconds) — fade to any level 0..1 (e.g. duck to 0.3). */
    fade:    (level, seconds, opts) => safe(() => fader.fade(level, seconds, opts)),
    /** Current audio-fade level 0..1 (1 = full; interpolates mid-fade). */
    fadeLevel: () => safe(() => fader.level(), 1),
    /** Instantly restore full level + clear the scrim — undo any fade
     *  (alias for fade(1, 0); the engines clamp the ramp to ~40 ms so
     *  it's click-free). */
    unfade:  () => safe(() => fader.fade(1, 0)),

    // — stage state —
    blackout:   gsBool(() => core.isRenderSuspended(), (on) => page.setBlackout(on)),
    zen:        gsBool(() => core.isZen(),    (on) => page.setZen(on)),
    /** Training mode: UI actions echo their qualia.* call in a console strip
     *  at the bottom of the stage (click a line to copy). Persisted. */
    echo:       gsBool(() => !!echoCtl?.isEnabled(), (on) => echoCtl?.setEnabled(on)),
    pause:      gsBool(() => core.isPaused(), (on) => page.setPaused(on)),
    fullscreen: gsBool(
      () => !!(document.fullscreenElement || document.webkitFullscreenElement),
      (on) => page.setFullscreen(on)),

    // — theming —
    themes: () => THEMES.map(t => t.id),
    theme:  gs(() => getTheme(), (id) => setTheme(id)),
    cycleTheme: (dir = 1) => cycleTheme(dir),

    // — modulation channels / field reads (for conditionals in patterns) —
    /** All valid modulator source ids (audio.* / pose.* / crowd.* / time.*). */
    CHANNELS: CHANNEL_IDS,
    channels: () => ({ ...core.getChannels() }),
    channel:  (id) => core.getChannels()[id],
    bands: () => ({ ...core.field.audio.bands }),
    crowd: () => ({ ...core.field.crowd }),

    // — qualem snapshots (whole-scene save/recall) —
    qualem: {
      /** Capture the current scene into the saved list. Returns {id, name}. */
      save: (name) => safe(() => {
        const q = page.captureQualem(name ? { name: String(name) } : {});
        const entry = qualemStore.addToList(q, q.name);
        page.refreshQualemList();
        return { id: entry.id, name: entry.name };
      }),
      /** Recall a saved qualem by id or name (case-insensitive). Async. */
      recall: async (ref) => {
        const list = qualemStore.loadList();
        const lower = String(ref ?? '').toLowerCase();
        const entry = qualemStore.getById(ref)
          || list.find(x => x.name.toLowerCase() === lower);
        if (!entry) { console.warn(`[qualia] no qualem "${ref}"`); return null; }
        await page.applyQualem(entry);
        return { id: entry.id, name: entry.name };
      },
      list: () => qualemStore.loadList().map(q =>
        ({ id: q.id, name: q.name, quale: q.activeFxId, updatedAt: q.updatedAt })),
    },

    // — camera (walk + physical) —
    cam: {
      /** Camera-walk (compositor pan/zoom/rotate drift) on/off. */
      walk:       gsBool(() => camWalk.isEnabled(), (on) => page.setCamWalkOn(on)),
      /** Walk feel: {drift,zoom,rotate,punch,minGapS,maxGapS,hydra,pose,post}. */
      walkConfig: gsConfig(() => camWalk.getConfig(), (c) => camWalk.setConfig(c)),
      /** Webcam feed into pose/quales: source('camera'|'off'). */
      source: gs(() => page.getPoseSource(), (v) => page.setPoseSource(v)),
      rotate: gs(() => getRotation(), (deg) => setRotation(deg)),
      mirror: gsBool(() => getMirror(), (on) => setMirror(on)),
      /** Flip between user/environment cameras (phones). Async. */
      flip: () => safe(() => pose.flipFacing()),
      /** Hardware camera zoom where supported; zoom() reads caps' value. */
      zoom: (v) => {
        if (isPattern(v)) return knobLane(v, (x) => pose.setZoom(+x));
        if (v !== undefined) safe(() => pose.setZoom(+v));
        return pose.getZoomCaps()?.value ?? null;
      },
    },

    // — pose pipeline —
    pose: {
      smoothing:  gs(() => pose.getSmoothing(),  (v) => page.setPoseSmoothing(+v)),
      poses:      gs(() => pose.getNumPoses(),   (n) => pose.setNumPoses(n | 0)),
      thresholds: gsConfig(() => pose.getThresholds(), (t) => pose.setThresholds(t)),
      linger:     gs(() => pose.getLingerMs(),   (ms) => pose.setLingerMs(+ms)),
      /** Skeleton size about the screen centre — 1 = raw landmarks. */
      scale:      gs(() => pose.getScale(),      (v) => page.setPoseScale(+v)),
      fps:        gs(() => pose.getDetectFps(),  (v) => pose.setDetectFps(+v)),
      /** Number of people currently tracked. */
      people: () => core.field.pose.people.length,
    },

    // — audience entanglement (null-safe before boot / with no room open) —
    entangle: {
      open:   () => safe(() => page.getEntangle()?.open()),
      close:  () => safe(() => page.getEntangle()?.close()),
      isOpen: () => !!safe(() => page.getEntangle()?.isOpen(), false),
      /** mode('vote') reads; mode('phase', true) writes. Modes: pose/param/vote/phase/skeleton. */
      mode: (m, on) => safe(() => {
        const e = page.getEntangle();
        if (!e) return null;
        if (on !== undefined) e.setMode(m, !!on);
        return e.getModes()[m];
      }),
      autoVote: (on) => safe(() => {
        const e = page.getEntangle();
        if (!e) return null;
        if (on !== undefined) e.setAutoVote(!!on);
        return e.getAutoVote();
      }),
      /** whitelist() lists crowd-drivable param ids; whitelist(id) toggles one. */
      whitelist: (id) => safe(() => {
        const e = page.getEntangle();
        if (!e) return [];
        if (id !== undefined) e.toggleWhitelist(id);
        return e.getWhitelist();
      }, []),
      peers: () => safe(() => page.getEntangle()?.peerCount() ?? 0, 0),
      room:  () => safe(() => page.getEntangle()?.getRoomId() ?? null),
    },

    // — audio analysis engine —
    audio: {
      /** Reactivity source mode: 'off'|'mic'|'mix'|'all'. Async on set. */
      mode: (m) => {
        if (m !== undefined) safe(() => page.setAudioMode(m));
        return page.getAudioMode();
      },
      /** Band/beat tunables {gain, ema, thresh, cooldown}. */
      tunables: gsConfig(() => audio.getTunables(), (t) => page.setAudioTunables(t)),
      /** preset() lists names; preset('metal') applies a pipeline tuning. */
      preset: (name) => {
        if (name === undefined) return [...AUDIO_PRESET_NAMES];
        return page.applyAudioPreset(name) ? name : null;
      },
      levels:   () => ({ ...audio.getLevels() }),
      clipping: () => audio.isClipping(),
    },

    // — strudel transport / mix (the panel's own knobs, from code) —
    strudel: {
      play:    () => strudel.play(),
      stop:    () => strudel.stop(),
      playing: () => strudel.isPlaying(),
      cps:     gs(() => strudel.getStrudelCps(), (v) => strudel.setCps(+v)),
      volume:  gs(() => strudel.getVolume(), (v) => strudel.setVolume(+v)),
      mute:    gsBool(() => strudel.isMuted(), (on) => strudel.setMuted(on)),
      limiter: gsBool(() => strudel.getLimiter(), (on) => strudel.setLimiter(on)),
    },

    // — sequencer —
    seq: {
      play:    () => sequencer.play(),
      stop:    () => sequencer.stop(),
      playing: () => sequencer.isPlaying(),
      cps:     gs(() => sequencer.getCps(), (v) => sequencer.setCps(+v)),
      volume:  gs(() => sequencer.getVolume(), (v) => sequencer.setVolume(+v)),
      mute:    gsBool(() => sequencer.isMuted(), (on) => sequencer.setMuted(on)),
      kit:     gs(() => sequencer.getKitId(),    (id) => sequencer.setKit(id)),
      genre:   gs(() => sequencer.getGenreId(),  (id) => sequencer.setGenre(id)),
      source:  gs(() => sequencer.getSourceId(), (id) => sequencer.setSource(id)),
      random:  () => safe(() => sequencer.patterns.random()),
      /** Current pattern model (read-only snapshot use — don't mutate live). */
      pattern: () => safe(() => sequencer.patterns.getCurrent()),
      /** Wipe every hit (one undoable edit — same path as the tether pad). */
      clear:   () => !!safe(() => sequencer.clearPattern(), false),
      /** Undo / redo over tap-writes + clears (tether's ↶/↷ pads). */
      undo:    () => !!safe(() => sequencer.tapUndo(), false),
      redo:    () => !!safe(() => sequencer.tapRedo(), false),
    },

    // — looper + rig —
    looper: {
      play:    () => safe(() => looper.play()),
      stop:    () => safe(() => looper.stop()),
      playing: () => !!safe(() => looper.isPlaying(), false),
      /** record() toggles via the same button path as the pad (keeps grid/sync). */
      record: (on) => {
        const rec = !!safe(() => looper.isRecording(), false);
        if (on === undefined || !!on !== rec) {
          document.getElementById('btn-looper-record')?.click();
        }
        return !!safe(() => looper.isRecording(), false);
      },
      recording: () => !!safe(() => looper.isRecording(), false),
      /** Retroactive grab — same as the rig's "grab" pad key. */
      grab:         () => document.getElementById('btn-looper-retro')?.click(),
      freeze:       () => safe(() => looper.toggleFreeze()),
      freezePop:    () => safe(() => looper.freezePop()),
      freezeRegrab: () => safe(() => looper.freezeRegrab()),
      freezeClear:  () => safe(() => looper.freezeClear()),
      frozen:       () => !!safe(() => looper.isFrozen(), false),
      rigLevel: gs(() => looper.getRig().level, (v) => looper.setRigLevel(+v)),
      rigMute:  gsBool(() => looper.getRig().muted, (on) => looper.setRigMuted(on)),
    },
    rig: {
      /** Signal transport (the rig header's ▶/■, same idiom as vox.start/stop):
       *  play opens the input capture and sends the live signal to the mix;
       *  stop silences it and releases the input device. */
      play:    () => safe(() => looper.playSignal()),
      stop:    () => safe(() => looper.stopSignal()),
      playing: () => !!safe(() => looper.isSignalOn(), false),
      /** Toggle a pedalboard stage: earth/metal/comp/delay/reverb/eq/geq/peq/
       *  cab/amp/hpf, or a noise gate — gate (strip-wide), earthGate/metalGate
       *  (per-pedal; each only runs while its drive is engaged). */
      toggle: (stage) => safe(() => looper.toggleStripStage(stage)),
      /** Set one stage param, e.g. param('delay','mix',0.4). */
      param:  (stage, name, v) => safe(() => looper.setStripParam(stage, name, +v)),
      /** Tone presets — the amp+eq+cab trio saved in the rig's tone zone.
       *  tone('name') applies one; saveTone() snapshots the current trio;
       *  tones() lists names. */
      tone:     (name) => !!safe(() => looper.applyTone(name), false),
      saveTone: (name) => safe(() => looper.saveTone(name), ''),
      tones:    () => safe(() => looper.listTones(), []),
    },

    // — vox (vocoder / harmonizer) —
    vox: {
      start:  () => safe(() => vocoder.start()),
      stop:   () => safe(() => vocoder.stop()),
      active: () => !!safe(() => vocoder.isActive(), false),
      mute:   gsBool(() => vocoder.isMuted(), (on) => vocoder.setMuted(on)),
      output: gs(() => vocoder.getOutput(), (v) => vocoder.setOutput(+v)),
      config: gsConfig(() => vocoder.getConfig(), (c) => vocoder.setConfig(c)),
      harmony: gsBool(() => harmonizer.isEnabled(), (on) => harmonizer.setEnabled(on)),
    },

    // — perf levers (grouped; the flat legacy names stay too) —
    perf: {
      fps:         gs(() => core.getMaxFps(), (v) => core.setMaxFps(v)),
      dpr:         gs(() => core.getDprCap(), (v) => core.setDprCap(+v)),
      reactFps:    gs(() => core.getReactFps(), (v) => core.setReactFps(v)),
      reactSmooth: gs(() => core.getReactSmoothing(), (v) => core.setReactSmoothing(+v)),
    },

    /** Searchable console help for this API (same data as the funcs tab). */
    help: (query) => {
      const q = String(query ?? '').trim().toLowerCase();
      const hits = QUALIA_FUNCTIONS.filter(f => !q
        || f.name.toLowerCase().includes(q)
        || (f.doc || '').toLowerCase().includes(q)
        || (f.category || '').toLowerCase().includes(q));
      let cat = null;
      for (const f of hits) {
        if (f.category !== cat) { cat = f.category; console.log(`\n— ${cat} —`); }
        console.log(`${f.name}${f.signature ? '  ' + f.signature : ''}\n    ${f.doc}`);
      }
      if (!hits.length) console.log(`[qualia] no help entries match "${query}"`);
      return `${hits.length} entries`;
    },
  };

  // Merge into the object strudel-hydra created. Existing keys win — nothing
  // this module defines may break `setParam`/`getField`/`mixer`/the editor
  // knobs that shipped before it existed.
  const g = globalThis;
  const existing = (g.qualia && typeof g.qualia === 'object') ? g.qualia : {};
  for (const [k, v] of Object.entries(api)) {
    if (!(k in existing)) existing[k] = v;
  }
  g.qualia = existing;

  // Page-side hooks the bindings need but that don't belong on the public
  // `qualia` object: the topbar pulse when a lane yields, and the arm counter
  // that tells a lane whether its claim has been superseded.
  installStrudelBindings(existing, {
    flashAuto: (kind) => page.flashAuto?.(kind),
    armEpoch:  (kind) => page.autoArmEpoch?.(kind) ?? 0,
  });
  return existing;
}

// ── Strudel-side pattern functions ─────────────────────────────────────────
//
// The @strudel/repl bundle exposes its whole eval scope on globalThis
// (register, reify, Pattern, silence, …) once the REPL initialises — the
// same bulk-global path strudel-hydra already relies on for samples()/
// getAudioContext(). We poll for it (cheap property checks) and register
// exactly once; Pattern.prototype persists across editor re-mounts so
// re-registration is never needed.
//
// Timing: onTrigger callbacks fire when the cyclist SCHEDULES a hap —
// `latency` seconds before it sounds. Callbacks receive
// (hap, currentTime, cps, targetTime); we defer the visual apply by
// (targetTime − currentTime) so code-driven changes land on the audible
// beat, not the scheduling edge. Clamped defensively in case a scheduler
// variant reports garbage.
let _strudelBindingsInstalled = false;
let _bindPollT = null;

function atAudibleTime(args, fn) {
  const hap = args[0];
  const currentTime = args[1];
  const targetTime  = args[3];
  const delay = (typeof currentTime === 'number' && typeof targetTime === 'number')
    ? Math.max(0, Math.min(2, targetTime - currentTime))
    : 0;
  if (delay > 0.005) setTimeout(() => fn(hap), delay * 1000);
  else fn(hap);
}

// A control chained onto an enclosing stack — stack(...).room(.5) — unions
// every hap value into a control object, tucking a lane's plain value under
// the `value` key ({value: 'chaos', room: .5}). Unwrap it so lanes see what
// the user actually wrote; the raw hap stays available to qcall/qtrig fns.
// Shared by the registered lane functions below and the patterned knobs above.
const laneValue = (hap) => {
  const v = hap?.value;
  return (v && typeof v === 'object' && 'value' in v) ? v.value : v;
};

function tryRegisterStrudelBindings(api, hooks) {
  const g = globalThis;
  if (typeof g.register !== 'function' || typeof g.reify !== 'function') return false;

  // Never clobber a global Strudel (or the user) already owns — if a future
  // bundle ships a `quale`, theirs wins and we just log the conflict.
  const define = (name, fn) => {
    const cur = g[name];
    if (cur !== undefined && !cur?.__qualiaBinding) {
      console.warn(`[qualia] strudel binding "${name}" skipped — global already defined`);
      return;
    }
    const f = g.register(name, fn);
    f.__qualiaBinding = true;
    g[name] = f;
  };

  // A silent control lane: fires `apply` per hap at its audible time and
  // produces no sound (dominant onTrigger) — stack it next to audio patterns.
  const lane = (pat, apply) =>
    g.reify(pat).onTrigger((...args) => atAudibleTime(args, apply), true);

  // ── Auto-yield: a lane claims the wheel ───────────────────────────────────
  // A `quale()` lane and auto-cycle drive the same knob; `qphase()`,
  // `qpreset()` and a colliding `qset()` all write the same params auto-phase
  // steps. With both running, one control has two masters: the lane sets a
  // look, the dwell timer moves it seconds later, the lane snaps it back on its
  // next hap — on stage that reads as the visuals stuttering, and it's the one
  // thing a performer can't debug mid-set. The typed pattern is the more
  // specific intent, so a lane CLAIMS the wheel and the matching timer stands
  // down.
  //
  // Last deliberate act wins, and a claim is how a lane takes its turn:
  //
  //   - One claim per lane INSTANCE. A lane object is built fresh by every
  //     editor eval, so re-evaluating the pattern hands the wheel back.
  //   - The claim is spent even when the timer was already off — the lane
  //     asserting itself is the event, not the write. So anything explicit you
  //     do afterwards STICKS instead of being clawed back on the next hap of a
  //     lane that already had its say.
  //   - Deliberately ARMING a timer (topbar toggle, dwell picker, hotkey,
  //     `autoCycle(true)`, a qualem recall) bumps page.autoArmEpoch and voids
  //     any outstanding claim, so an explicit arm outranks even a lane that
  //     hasn't fired yet — recall a scene between a `.slow(32)` lane's haps and
  //     the recall stands. The yield itself only ever writes 0, so it can't
  //     void its own claim.
  //
  // Reversible by design: the yield goes through setCyclePeriod/setPhasePeriod,
  // so the topbar toggle flips with it, the remembered dwell survives, and one
  // click (or `qualia.autoCycle(true)`) puts it back. `qualia.autoYield(false)`
  // opts out entirely for anyone who wants the two layered.
  const knobFor = (kind) => (kind === 'cycle' ? api.autoCycle : api.autoPhase);
  const armEpoch = (kind) => hooks?.armEpoch?.(kind) ?? 0;

  /** A single lane instance's one-shot claim on `kind`'s wheel. */
  const yieldClaim = (kind) => {
    const born = armEpoch(kind);
    let spent = false;
    // Also lets a caller skip work it only needs in order to decide whether to
    // claim — see the `qset` collision scan below.
    const live = () => !spent && _autoYield && armEpoch(kind) === born;
    const claim = () => {
      if (!live()) return;
      spent = true;
      const knob = knobFor(kind);
      if (!(knob().seconds > 0)) return;   // nothing to stand down
      knob(0);
      hooks?.flashAuto?.(kind);
      const restore = kind === 'cycle' ? 'autoCycle' : 'autoPhase';
      console.info(`[qualia] auto-${kind} off — a pattern lane took the wheel (qualia.${restore}(true) to restore, qualia.autoYield(false) to keep both)`);
    };
    claim.live = live;
    return claim;
  };

  // Switch the active quale per event: quale("<chladni fractal>").slow(8)
  // Claims only on a resolved id — a typo'd quale name fizzles with a warning
  // and must not cost the performer their cycle settings.
  define('quale', (pat) => {
    const claim = yieldClaim('cycle');
    return lane(pat, (hap) => { if (api.quale(String(laneValue(hap))) !== null) claim(); });
  });

  // Drive an active-quale param from a pattern: qset("hue", sine.segment(16))
  // (continuous signals need .segment(n) to become discrete events).
  //
  // Claims auto-phase only on a COLLISION — when the param is one the active
  // quale's phase steps also write. `qset("palette", …)` under auto-phase is a
  // real fight; `qset("reactivity", …)` isn't, and blanket-yielding on it would
  // disarm the timer for no reason. The collision scan sits behind claim.live()
  // so a dense `.segment(16)` lane doesn't pay for it once the claim is settled.
  define('qset', (name, pat) => {
    const claim = yieldClaim('phase');
    const id = String(name);
    return lane(pat, (hap) => {
      if (!api.set(id, laneValue(hap))) return;
      if (claim.live() && api.phaseParams().includes(id)) claim();
    });
  });

  // Apply factory/user presets by name per event: qpreset("<default punchy>")
  // A preset writes the whole param set — including the mode/palette keys
  // auto-phase steps — so an applied preset claims the phase wheel too.
  define('qpreset', (pat) => {
    const claim = yieldClaim('phase');
    return lane(pat, (hap) => { if (api.preset(String(laneValue(hap))) !== null) claim(); });
  });

  // Step the active quale's phase per event; value is the direction (±1).
  // qphase("1").slow(4) → a phase step every 4th cycle. Claims only when a step
  // actually landed: on a quale with no phases the timer's period is armed
  // intent waiting for the next supporting quale, and a no-op lane hap has no
  // business disarming it.
  define('qphase', (pat) => {
    const claim = yieldClaim('phase');
    return lane(pat, (hap) => { if (api.phase(Number(laneValue(hap)) || 1)) claim(); });
  });

  // Glitch mode rides a pattern: qglitch("mosh", "<off on off flip>")
  define('qglitch', (name, pat) =>
    lane(pat, (hap) => api.glitch(String(name), String(laneValue(hap)))));

  // Text to the Text quale (the text video-synth):
  // qtext("<VOID STAR one_more_time>"). Underscores render as spaces, so
  // phrases survive mini-notation tokenization. Addressed to the text quale
  // explicitly (unlike qset's active-quale target) so it can never scribble a
  // `text` param onto some other quale — while a different quale is active
  // it's a deliberate no-op, and the next hap after quale("text") lands
  // takes hold.
  define('qtext', (pat) =>
    lane(pat, (hap) => api.setParam?.('text', 'text', String(laneValue(hap)))));

  // Generic escape hatch: qcall(v => qualia.blackout(v > 0), "0 1")
  define('qcall', (fn, pat) =>
    lane(pat, (hap) => { try { fn(laneValue(hap), hap); } catch (e) { console.warn('[qualia] qcall:', e); } }));

  // Non-dominant sibling of qcall — the pattern KEEPS sounding and the
  // callback rides along: s("bd*4").qtrig(() => qualia.phase())
  define('qtrig', (fn, pat) =>
    g.reify(pat).onTrigger(
      (...args) => atAudibleTime(args, (hap) => {
        try { fn(laneValue(hap), hap); } catch (e) { console.warn('[qualia] qtrig:', e); }
      }),
      false));

  // ── Microtonal tuning helpers ─────────────────────────────────────────────
  // Unlike the lanes above these are SOUNDING transforms: they rewrite hap
  // values into a `freq` control, which superdough honors end-to-end on
  // synths and samples — no rig changes, arbitrary tunings. The math lives
  // in microtonal.js (node-testable; see scripts/check-qualia-edo.mjs).
  // Upstream Strudel is growing an `@strudel/edo` package; when the pinned
  // bundle ships one, define()'s no-clobber guard hands `edo` back to it.
  //
  // House rule holds here too: a bad spec or junk value warns once and
  // passes through — a live set must never throw out of a pattern callback.
  const _tuningWarned = new Set();
  const tuningWarn = (key, msg) => {
    if (_tuningWarned.has(key)) return;
    _tuningWarned.add(key);
    console.warn(`[qualia] ${msg}`);
  };

  // Prefer the bundle's own note-name parser when evalScope exposes one —
  // ours is the no-bundle fallback and agrees on standard names.
  const bundleNoteToMidi = typeof g.noteToMidi === 'function' ? g.noteToMidi : undefined;

  // Note-name → midi, null on junk — shared by cents + jitune.
  const toMidiSafe = (name) => {
    try {
      const m = bundleNoteToMidi ? bundleNoteToMidi(name) : noteNameToMidi(name);
      return Number.isFinite(m) ? m : null;
    } catch { return null; }
  };

  // The editor transpiles EVERY double-quoted string through mini-notation,
  // and mini SPLITS colon tokens — "c3:super" arrives as ['c3','super'],
  // "31:a3" as [31,'a3']. Without this rejoin the tuning helpers would see
  // garbage, warn once, and silently fall back to 12-TET — the worst kind
  // of microtonal bug: everything plays, nothing is in tune. Specs with
  // SPACES (custom tables, edoscale degree lists) can't survive mini
  // tokenization at all and must be single-quoted plain JS strings instead
  // (documented in qualia-code-api.md).
  const specString = (spec) => (Array.isArray(spec) ? spec.map(String).join(':') : spec);

  // Hap value → {freq} via `resolve(degree)`. Three incoming shapes: a plain
  // number/numeric string (from "0 8 18"), a control object from n()/note()
  // (spread it so chained .s()/.gain() keep merging; n/note are consumed —
  // left in place superdough would re-pitch or re-index off them), or junk
  // (pass through + one-time warn).
  const toFreqValue = (v, resolve, warnKey) => {
    const isObj = v && typeof v === 'object';
    const raw = isObj ? (v.n ?? v.note ?? v.value) : v;
    const num = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    if (!Number.isFinite(num)) {
      tuningWarn(`${warnKey}:${String(raw)}`, `${warnKey}: non-numeric degree ${JSON.stringify(raw ?? v)} — value passed through`);
      return v;
    }
    const freq = resolve(num);
    if (!isObj) return { freq };
    const out = { ...v };
    delete out.n; delete out.note; delete out.value;
    out.freq = freq;
    return out;
  };

  // Values are N-EDO step degrees → freq: n("0 8 18 26 31").edo(31)
  // Spec packs divisions + optional root: 31 | "31:a3" | "19:440"
  // (root defaults to c4; degrees may be negative, ≥ N, or fractional).
  define('edo', (spec, pat) => {
    spec = specString(spec);
    const parsed = parseEdoSpec(spec, bundleNoteToMidi);
    if (!parsed) {
      tuningWarn(`edo:${spec}`, `edo("${spec}"): bad spec (want N | "N:root") — pattern unchanged`);
      return g.reify(pat);
    }
    const { n, rootHz } = parsed;
    return g.reify(pat).withValue((v) =>
      toFreqValue(v, (deg) => edoFreq(rootHz, n, deg), 'edo'));
  });

  // Values index a degree SUBSET of an EDO, wrapping by octave — a mode
  // carved out of the tuning: n("0 1 2 4 6").edoscale("31:c4:0 5 10 13 18 23 28")
  // Index 7 of a 7-note subset = subset[0] an octave up; negatives wrap down.
  define('edoscale', (spec, pat) => {
    spec = specString(spec);
    const parsed = parseEdoSpec(spec, bundleNoteToMidi);
    if (!parsed || !parsed.degrees) {
      tuningWarn(`edoscale:${spec}`, `edoscale("${spec}"): bad spec (want "N:root:d0 d1 …") — pattern unchanged`);
      return g.reify(pat);
    }
    const { n, rootHz, degrees } = parsed;
    return g.reify(pat).withValue((v) =>
      toFreqValue(v, (i) => edoFreq(rootHz, n, scaleDegree(degrees, n, i)), 'edoscale'));
  });

  // Values are just-intonation ratios against a root → freq:
  // ji("a3", "1 5:4 3:2 2"). COLON form inside mini strings — `/` is the
  // slow operator there ("5/4" = pure(5) over 4 cycles); plain-JS strings
  // and numbers can use whatever parseRatio takes ("5/4", 1.25, "5:4").
  // Named `ji`, not `ratio` — the 1.3.0 bundle already owns a `ratio()`
  // (value → number conversion, no root/freq semantics) and define() would
  // rightly refuse to shadow it.
  define('ji', (root, pat) => {
    root = specString(root);
    const rootHz = parseRoot(root, bundleNoteToMidi);
    if (rootHz === null) {
      tuningWarn(`ji:${root}`, `ji("${root}"): bad root (want note name or Hz) — pattern unchanged`);
      return g.reify(pat);
    }
    return g.reify(pat).withValue((v) => {
      let base = null;
      let r;
      if (Array.isArray(v)) {
        // Mini's colon token: "3:2" parses to [3, 2] in the 1.3.0 bundle.
        r = parseRatio(v);
      } else if (v && typeof v === 'object') {
        base = { ...v };
        // Fallback shape against bundle drift: an {s, n} pair (the same
        // channel s("bd:3") rides) — numeric s/n reads as num:den. A real
        // sound name in s stays untouched by the Number guard below.
        if (base.s !== undefined && base.n !== undefined && Number.isFinite(Number(base.s))) {
          r = parseRatio(base);
          delete base.s; delete base.n;
        } else {
          r = parseRatio(base.value ?? base.n ?? base.note);
          delete base.value; delete base.n; delete base.note;
        }
      } else {
        r = parseRatio(v);
      }
      if (!Number.isFinite(r)) {
        tuningWarn(`ji-val:${String(v)}`, `ji: unreadable ratio ${JSON.stringify(v)} — value passed through`);
        return v;
      }
      const freq = rootHz * r;
      return base ? { ...base, freq } : { freq };
    });
  });

  // Cent offsets on ALREADY-PITCHED values — chain it after the pitch is
  // resolved: note("c3 e3 g3").cents("<0 -14 14>"). A {freq} scales by
  // 2^(c/1200); a numeric note/n shifts by c/100 (superdough takes
  // fractional note numbers); a note NAME is converted to midi first; a
  // bare number is treated as note-ish (+c/100).
  define('cents', (offset, pat) => {
    const c = Number(offset);
    if (!Number.isFinite(c)) {
      tuningWarn(`cents:${offset}`, `cents(${JSON.stringify(offset)}): non-numeric offset — pattern unchanged`);
      return g.reify(pat);
    }
    const factor = centsFactor(c);
    return g.reify(pat).withValue((v) => {
      if (v && typeof v === 'object') {
        const out = { ...v };
        // freq("440") stores the value as a STRING — coerce before scaling.
        const f = out.freq !== undefined ? Number(out.freq) : NaN;
        if (Number.isFinite(f)) { out.freq = f * factor; return out; }
        const key = out.note !== undefined ? 'note' : (out.n !== undefined ? 'n' : null);
        if (key) {
          const cur = out[key];
          const midi = typeof cur === 'number' ? cur : toMidiSafe(String(cur));
          if (midi !== null) { out[key] = midi + c / 100; return out; }
        }
        tuningWarn('cents:unpitched', 'cents: value has no freq/note/n to detune — passed through');
        return v;
      }
      const num = Number(v);
      if (Number.isFinite(num)) return num + c / 100;
      const midi = toMidiSafe(String(v));
      if (midi !== null) return midi + c / 100;
      tuningWarn(`cents-val:${String(v)}`, `cents: unpitched value ${JSON.stringify(v)} — passed through`);
      return v;
    });
  });

  // Retune ALREADY-PITCHED values to just intonation — the chord()/voicing()
  // companion: chord("<C^7 Dm7 G7>").voicing().jitune("c3").s("piano").
  // Each note's pitch class snaps to a 12-entry ratio table over the root
  // (only the root's pitch CLASS matters — its octave falls out of the
  // math). Spec: "c3" = 5-limit table, "c3:7" = septimal tritone + harmonic
  // seventh, "c3:1 16:15 9:8 …" = custom 12-ratio table. Fixed-root JI:
  // chords ring pure against the root; some internal fifths carry the
  // syntonic comma — that's the physics, not a bug. A prior .cents() detune
  // survives (fractional midi re-applies on top of the snapped ratio).
  // Bypass tokens: values pass through untouched — plain 12-TET equal
  // temperament. Because register() patterns the spec arg, the tuning
  // itself can ride a pattern: .jitune("<c3 a3 off>") retunes to C, then
  // A, then back to equal temper per cycle. (Use "off", not "~" — a mini
  // rest means NO spec event, which silences the join for that cycle
  // instead of bypassing.)
  const JITUNE_OFF = new Set(['off', 'et', 'equal', '-', 'none']);
  define('jitune', (spec, pat) => {
    spec = specString(spec);
    if (typeof spec === 'string' && JITUNE_OFF.has(spec.trim().toLowerCase())) return g.reify(pat);
    const parsed = parseTuneSpec(spec, bundleNoteToMidi);
    if (!parsed) {
      tuningWarn(`jitune:${spec}`, `jitune("${spec}"): bad spec (want "root", "root:7" or "root:<12 ratios>") — pattern unchanged`);
      return g.reify(pat);
    }
    const { rootHz, rootMidi, ratios } = parsed;
    const retune = (midi) => jiRetune(rootHz, rootMidi, ratios, midi);
    return g.reify(pat).withValue((v) => {
      if (v && typeof v === 'object') {
        const out = { ...v };
        const raw = out.note ?? out.n ?? out.value;
        const midi = typeof raw === 'number' ? raw : toMidiSafe(String(raw));
        if (midi === null || !Number.isFinite(midi)) {
          tuningWarn('jitune:unpitched', 'jitune: value has no note/n to retune — passed through');
          return v;
        }
        delete out.note; delete out.n; delete out.value;
        out.freq = retune(midi);
        return out;
      }
      const num = Number(v);
      const midi = (v !== '' && v !== null && Number.isFinite(num)) ? num : toMidiSafe(String(v));
      if (midi === null || !Number.isFinite(midi)) {
        tuningWarn(`jitune-val:${String(v)}`, `jitune: unpitched value ${JSON.stringify(v)} — passed through`);
        return v;
      }
      return { freq: retune(midi) };
    });
  });

  console.log('[qualia] strudel bindings registered: quale, qset, qpreset, qphase, qglitch, qtext, qcall, qtrig, edo, edoscale, ji, cents, jitune');
  return true;
}

function installStrudelBindings(api, hooks) {
  if (_strudelBindingsInstalled) return;
  if (tryRegisterStrudelBindings(api, hooks)) { _strudelBindingsInstalled = true; return; }
  if (_bindPollT) return;
  // Strudel lazy-loads on first panel open; poll until its globals appear.
  // Two typeof checks per tick — negligible even if the panel never opens.
  _bindPollT = setInterval(() => {
    if (tryRegisterStrudelBindings(api, hooks)) {
      _strudelBindingsInstalled = true;
      clearInterval(_bindPollT);
      _bindPollT = null;
    }
  }, 400);
}
