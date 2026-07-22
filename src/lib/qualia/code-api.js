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
//      `qphase`, `qglitch`, `qcall`, `qtrig`) — registered through
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

/** No-throw wrapper for engine calls made from pattern callbacks. */
function safe(fn, fallback = null) {
  try { return fn(); } catch (e) { console.warn('[qualia] code api:', e); return fallback; }
}

/** get/set combinator: fn() reads, fn(v) writes-then-reads. */
function gs(get, set) {
  return (v) => {
    if (v === undefined) return get();
    set(v);
    return get();
  };
}

/** Boolean get/set: accepts any truthy/falsy write. */
function gsBool(get, set) {
  return (on) => {
    if (on === undefined) return !!get();
    set(!!on);
    return !!get();
  };
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
    pose, overlay, camWalk, logoMark, page,
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
    /** Step the active quale's phase (dir ±1). */
    phase: (dir = 1) => page.phaseShift(dir >= 0 ? +1 : -1),
    /** autoPhase() → {seconds, style}; autoPhase(10, 'random') sets both. */
    autoPhase: (seconds, style) => {
      if (seconds !== undefined) page.setPhasePeriod(Math.max(0, +seconds || 0));
      if (style !== undefined) page.setPhaseStyle(style);
      return { seconds: page.getPhasePeriod(), style: page.getPhaseStyle() };
    },
    /** autoCycle() → {seconds, style}; autoCycle(30, 'random') sets both. */
    autoCycle: (seconds, style) => {
      if (seconds !== undefined) page.setCyclePeriod(Math.max(0, +seconds || 0));
      if (style !== undefined) page.setCycleStyle(style);
      return { seconds: page.getCyclePeriod(), style: page.getCycleStyle() };
    },
    /** Scene-change bridge: transition() → {style, ms}; transition('wipe', 1200). */
    transition: (style, ms) => page.setTransition(style, ms),
    /** Quantize scene changes to the Strudel cycle: 'cycle'|'off' (or bool). */
    quantize: (mode) => page.setQuantize(
      mode === undefined ? undefined : (mode === true ? 'cycle' : mode === false ? 'off' : mode)),

    // — top-level effects —
    /** overlay('skeleton') reads; overlay('sparks', false) writes. */
    overlay: (key, on) => {
      if (on === undefined) return overlay.getOption(key);
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

    // — stage state —
    blackout:   gsBool(() => core.isRenderSuspended(), (on) => page.setBlackout(on)),
    zen:        gsBool(() => core.isZen(),    (on) => page.setZen(on)),
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
      /** Toggle a pedalboard stage: earth/metal/comp/delay/reverb/eq/geq/peq/cab/amp/hpf. */
      toggle: (stage) => safe(() => looper.toggleStripStage(stage)),
      /** Set one stage param, e.g. param('delay','mix',0.4). */
      param:  (stage, name, v) => safe(() => looper.setStripParam(stage, name, +v)),
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

  installStrudelBindings(existing);
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

function tryRegisterStrudelBindings(api) {
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

  // A control chained onto an enclosing stack — stack(...).room(.5) — unions
  // every hap value into a control object, tucking a lane's plain value under
  // the `value` key ({value: 'chaos', room: .5}). Unwrap it so lanes see what
  // the user actually wrote; the raw hap stays available to qcall/qtrig fns.
  const laneValue = (hap) => {
    const v = hap?.value;
    return (v && typeof v === 'object' && 'value' in v) ? v.value : v;
  };

  // A silent control lane: fires `apply` per hap at its audible time and
  // produces no sound (dominant onTrigger) — stack it next to audio patterns.
  const lane = (pat, apply) =>
    g.reify(pat).onTrigger((...args) => atAudibleTime(args, apply), true);

  // Switch the active quale per event: quale("<chladni fractal>").slow(8)
  define('quale', (pat) =>
    lane(pat, (hap) => api.quale(String(laneValue(hap)))));

  // Drive an active-quale param from a pattern: qset("hue", sine.segment(16))
  // (continuous signals need .segment(n) to become discrete events).
  define('qset', (name, pat) =>
    lane(pat, (hap) => api.set(String(name), laneValue(hap))));

  // Apply factory/user presets by name per event: qpreset("<default punchy>")
  define('qpreset', (pat) =>
    lane(pat, (hap) => api.preset(String(laneValue(hap)))));

  // Step the active quale's phase per event; value is the direction (±1).
  // qphase("1").slow(4) → a phase step every 4th cycle.
  define('qphase', (pat) =>
    lane(pat, (hap) => api.phase(Number(laneValue(hap)) || 1)));

  // Glitch mode rides a pattern: qglitch("mosh", "<off on off flip>")
  define('qglitch', (name, pat) =>
    lane(pat, (hap) => api.glitch(String(name), String(laneValue(hap)))));

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

  console.log('[qualia] strudel bindings registered: quale, qset, qpreset, qphase, qglitch, qcall, qtrig');
  return true;
}

function installStrudelBindings(api) {
  if (_strudelBindingsInstalled) return;
  if (tryRegisterStrudelBindings(api)) { _strudelBindingsInstalled = true; return; }
  if (_bindPollT) return;
  // Strudel lazy-loads on first panel open; poll until its globals appear.
  // Two typeof checks per tick — negligible even if the panel never opens.
  _bindPollT = setInterval(() => {
    if (tryRegisterStrudelBindings(api)) {
      _strudelBindingsInstalled = true;
      clearInterval(_bindPollT);
      _bindPollT = null;
    }
  }, 400);
}
