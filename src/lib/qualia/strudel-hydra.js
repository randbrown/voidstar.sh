// Strudel REPL embed + Hydra canvas stacking + evaluate/stop hooks.
//
// Mirrors cymatics:1834–2282. The big differences:
//   - The audio tap calls `audio.adoptAnalyser(ctx, analyser)` instead of
//     mutating module-level audio state directly.
//   - We expose `globalThis.qualia = { setParam(fxId, paramId, value), getField() }`
//     so live-coded patterns can drive params during a performance. This is
//     the Strudel-driveable hook the plan calls for.
//   - `globalThis.a` is wired to the QualiaField audio frame so existing
//     `osc().scale(()=>a.fft[0])` patterns from cymatics still work.

import {
  loadCurrent, saveCurrent, loadList, addToList, updateInList,
  removeFromList, clonePattern, randomPattern, parseMetadata,
  setMetadata, patternDisplayName, downloadPattern,
} from './patterns.js';
import { makeDraggablePanel } from './panel-pos.js';
import { makeLimiter, setLimiterEngaged } from './limiter.js';
import {
  resolveManifest, toStrudelSampleMap, COLLECTIONS, collectionPacks, getActiveCollectionId,
} from './samples-manifest.js';

// Pinned, NOT @latest: a live set must not break because unpkg served a new
// @strudel/repl mid-tour. Bump this deliberately (and re-test a set) when you
// want a newer Strudel — don't float it. Last verified: 1.3.0.
const STRUDEL_VERSION = '1.3.0';
const STRUDEL_SCRIPT = `https://unpkg.com/@strudel/repl@${STRUDEL_VERSION}`;

let _strudelLoadingP = null;
let _strudelConnectPatched = false;
let _strudelEvalPatched = false;

function loadStrudelScript() {
  if (_strudelLoadingP) return _strudelLoadingP;
  _strudelLoadingP = new Promise((resolve, reject) => {
    if (customElements.get('strudel-editor')) { resolve(); return; }
    const s = document.createElement('script');
    s.src = STRUDEL_SCRIPT;
    s.async = true;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error('failed to load @strudel/repl'));
    document.head.appendChild(s);
  });
  _strudelLoadingP.then(injectLateStrudelOverride).catch(() => {});
  // Register the shared sample pack(s) into Strudel so the same sounds the
  // sequencer's sample kits play are also playable in the REPL (`s("bd sd hh")`,
  // `s("lt mt ht")`, etc.). Fire-and-forget — a pack that fails to load just
  // isn't there, exactly like a default bank that didn't reach the CDN.
  _strudelLoadingP.then(registerSharedSamples).catch(() => {});
  return _strudelLoadingP;
}

// Register voidstar's bundled sample packs via the global `samples()` that the
// @strudel/repl bundle exposes (same bulk-global path as getAudioContext /
// superdough / soundMap). `samples()` only registers the name→URL map; audio
// decodes lazily on first play, so it's safe to call as soon as the function
// exists — we just poll briefly for it after the script loads.
let _sharedSamplesRegistered = false;
async function registerSharedSamples() {
  if (_sharedSamplesRegistered) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && typeof globalThis.samples !== 'function'; i++) {
    await sleep(150);
  }
  if (typeof globalThis.samples !== 'function') return;
  // Register both bundled collections, additively (never clobber Strudel's stock
  // bd/sd/hh). Each pack registers under a collection-qualified `<bank><genre>_`
  // namespace so .bank("sigmetal") / .bank("v0metal") always reach a specific
  // collection; the ACTIVE collection additionally registers under the plain
  // `<genre>_` namespace so s("bd sd").bank("metal") plays whatever's active.
  const activeId = getActiveCollectionId();
  for (const c of COLLECTIONS) {
    for (const pack of collectionPacks(c.id)) {
      try {
        const resolved = await resolveManifest(pack.url);
        await globalThis.samples(toStrudelSampleMap(resolved, pack.bankPrefix));
        if (c.id === activeId) {
          await globalThis.samples(toStrudelSampleMap(resolved, pack.prefix));
        }
      } catch (e) {
        console.warn(`[qualia] shared samples (${pack.id}) registration failed:`, e);
      }
    }
  }
  _sharedSamplesRegistered = true;
}

function injectLateStrudelOverride() {
  const id = 'qualia-strudel-late-override';
  document.getElementById(id)?.remove();
  const s = document.createElement('style');
  s.id = id;
  s.textContent = `
    :root, html, body {
      --background:        transparent !important;
      --bg:                transparent !important;
      --editor-background: transparent !important;
      --background-color:  transparent !important;
    }
    strudel-editor, strudel-editor * {
      background:       transparent !important;
      background-color: transparent !important;
      background-image: none        !important;
    }
    #strudel-mount .cm-line > * {
      background-color: rgba(0,0,0,0.35) !important;
      background-image: none !important;
    }
  `;
  document.head.appendChild(s);
}

function clearHydraOutputs() {
  const g = globalThis;
  if (typeof g.solid !== 'function') return;
  for (const k of ['o0', 'o1', 'o2', 'o3']) {
    const o = g[k];
    if (!o) continue;
    try { g.solid(0, 0, 0, 0).out(o); } catch {}
  }
}
function clearScopeCanvas(canvas) {
  if (!canvas) return;
  const c = canvas.getContext('2d');
  if (c) c.clearRect(0, 0, canvas.width, canvas.height);
}

const STRUDEL_TRANSPARENT_CSS = `
  :host, :host * , * {
    background:       transparent !important;
    background-color: transparent !important;
    background-image: none        !important;
  }
  :host {
    --background:        transparent !important;
    --bg:                transparent !important;
    --editor-background: transparent !important;
    --background-color:  transparent !important;
  }
  .cm-content, .cm-line {
    text-shadow: 0 0 4px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.85);
  }
  :host .code-container .cm-line > *,
  :host .cm-content .cm-line > *,
  .code-container .cm-line > *,
  .cm-content .cm-line > *,
  .cm-line > * {
    background: rgba(0,0,0,0.35) !important;
  }
`;
function injectStrudelTransparency(ed) {
  const inject = (root) => {
    if (!root || root._strudelTransparentInjected) return;
    const style = document.createElement('style');
    style.textContent = STRUDEL_TRANSPARENT_CSS;
    root.appendChild(style);
    root._strudelTransparentInjected = true;
  };
  const stripInline = (el) => {
    if (!el || !el.style) return;
    if (el.parentElement && el.parentElement.classList && el.parentElement.classList.contains('cm-line')) return;
    const attr = el.getAttribute && el.getAttribute('style');
    if (attr && attr.includes('var(--background)')) {
      const fixed = attr.replace(
        /background(-color)?\s*:\s*var\(--background\)\s*(!important)?\s*;?/g,
        'background-color: transparent !important;'
      );
      if (fixed !== attr) el.setAttribute('style', fixed);
    }
    el.style.setProperty('background',       'transparent', 'important');
    el.style.setProperty('background-color', 'transparent', 'important');
    el.style.setProperty('background-image', 'none',        'important');
  };
  const sweep = () => {
    inject(ed.shadowRoot);
    stripInline(ed);
    const walk = (root) => {
      if (!root) return;
      const all = root.querySelectorAll('*');
      for (const el of all) {
        stripInline(el);
        if (el.shadowRoot) { inject(el.shadowRoot); walk(el.shadowRoot); }
      }
    };
    walk(ed);
    if (ed.shadowRoot) walk(ed.shadowRoot);
  };
  sweep();
  const obs = new MutationObserver(sweep);
  obs.observe(ed, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  setTimeout(() => obs.disconnect(), 10000);
}

/**
 * Build a Strudel/Hydra integration bound to one QualiaCore.
 *
 * Hydra runs UNDER the viz canvas; the viz uses `mix-blend-mode: screen`
 * so its near-black fill becomes effectively transparent over Hydra. The
 * Strudel scope/pianoroll uses #test-canvas which sits above the viz.
 */
// Strudel panel open/close state — persisted across page loads so the
// editor reopens to its last-visible state. Doubles as the sentinel for
// the initial-pattern decision: panel was open last time → user was
// mid-edit, restore the stored buffer; panel was closed → fresh random.
const PANEL_OPEN_KEY = 'voidstar.qualia.strudel.panelOpen';
function loadPanelOpen() {
  try { return localStorage.getItem(PANEL_OPEN_KEY) === '1'; } catch { return false; }
}
function savePanelOpen(open) {
  try { localStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0'); } catch {}
}

// Persisted UI volume — multiplies the muteGate when un-muted. Stacks
// with Strudel's own gain() so the user can ride the mix without editing
// the pattern. Runs 0..STRUDEL_MAX_GAIN: 1.0 is nominal, 1.0..1.5 is boost
// headroom for a weak pattern. The track's brickwall limiter (strudelLimiter)
// catches anything the boost pushes over the ceiling.
const STRUDEL_MAX_GAIN = 1.5;
const VOLUME_KEY = 'voidstar.qualia.strudel.volume';
function loadVolume() {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw == null) return 1;
    const v = parseFloat(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(STRUDEL_MAX_GAIN, v)) : 1;
  } catch { return 1; }
}
function saveVolume(v) {
  try { localStorage.setItem(VOLUME_KEY, String(v)); } catch {}
}

// Brickwall limiter on the Strudel bus — on by default (superdough can get
// hot). Persisted so protection survives reloads.
const LIMITER_KEY = 'voidstar.qualia.strudel.limiter';
function loadLimiter() { try { return localStorage.getItem(LIMITER_KEY) !== '0'; } catch { return true; } }
function saveLimiter(on) { try { localStorage.setItem(LIMITER_KEY, on ? '1' : '0'); } catch {} }

const LINES_KEY = 'voidstar.qualia.strudel.lineNumbers';
function loadLineNumbers() {
  try { return localStorage.getItem(LINES_KEY) === '1'; } catch { return false; }
}
function saveLineNumbers(on) {
  try { localStorage.setItem(LINES_KEY, on ? '1' : '0'); } catch {}
}

// Editor font size (px) — driven by the header slider, double-click resets.
// Persisted so projector/large-display sizing survives reloads.
const FONT_KEY = 'voidstar.qualia.strudel.fontSize';
const FONT_DEFAULT = 14, FONT_MIN = 11, FONT_MAX = 64;
function loadFontSize() {
  try {
    const v = parseFloat(localStorage.getItem(FONT_KEY));
    return Number.isFinite(v) ? Math.max(FONT_MIN, Math.min(FONT_MAX, v)) : FONT_DEFAULT;
  } catch { return FONT_DEFAULT; }
}
function saveFontSize(px) { try { localStorage.setItem(FONT_KEY, String(px)); } catch {} }

const BLUR_KEY = 'voidstar.qualia.strudel.blur';
function loadBlur() {
  try { return localStorage.getItem(BLUR_KEY) === '1'; } catch { return false; }
}
function saveBlur(on) {
  try { localStorage.setItem(BLUR_KEY, on ? '1' : '0'); } catch {}
}

const AUTOCOMPLETE_KEY = 'voidstar.qualia.strudel.autocomplete';
// Default ON: function-name completion + hover docs are the whole point of
// having them, and they cost nothing until you type or hover. A first visit
// (no stored value) opts in; the toggle then persists an explicit 0/1.
function loadAutocomplete() {
  try {
    const v = localStorage.getItem(AUTOCOMPLETE_KEY);
    return v === null ? true : v === '1';
  } catch { return true; }
}
function saveAutocomplete(on) {
  try { localStorage.setItem(AUTOCOMPLETE_KEY, on ? '1' : '0'); } catch {}
}

export function createStrudelHydra({ audio, getField, setParam, scopeCanvas, onPlayStateChange } = {}) {
  // Snapshot the previous-session panel state ONCE at init. open()/close()
  // mutate the flag for next time, but the answer to "should we restore the
  // last pattern?" is based on what the user did before this page load —
  // re-reading after a within-session open() would always see '1'.
  const wasOpenLastSession = loadPanelOpen();

  const panel  = document.getElementById('strudel-panel');
  const mount  = document.getElementById('strudel-mount');
  const status = document.getElementById('strudel-status');
  const errEl  = document.getElementById('strudel-error');
  const btnToggle = document.getElementById('btn-strudel');
  const btnClose  = document.getElementById('btn-strudel-close');
  const btnPlay    = document.getElementById('btn-strudel-play');
  const btnStop    = document.getElementById('btn-strudel-stop');
  const btnMute    = document.getElementById('btn-strudel-mute');
  const elGain     = document.getElementById('strudel-gain');
  const elFont     = document.getElementById('strudel-font-size');
  const btnNewline = document.getElementById('btn-strudel-newline');
  const btnLines   = document.getElementById('btn-strudel-lines');
  const btnAuto    = document.getElementById('btn-strudel-autocomplete');
  const btnBlur    = document.getElementById('btn-strudel-blur');

  let editorEl = null;
  let mounted  = false;
  let strudelAnalyser = null;
  let pollT = null;
  // Title-change observers. Subscribers (currently: sequencer via the
  // page-init bridge) get fired when the strudel @title changes — random
  // rolls, pattern loads, in-place setTitle, or manual edits picked up
  // on persist. `_lastSeenTitle` de-dupes so a rename round-trip from the
  // sequencer doesn't loop back to it.
  const _titleListeners = new Set();
  let _lastSeenTitle = null;
  function notifyTitleIfChanged(forceTitle) {
    const t = typeof forceTitle === 'string'
      ? forceTitle
      : (parseMetadata(readEditorCode() || loadCurrent() || '').title || '');
    if (t === _lastSeenTitle) return;
    _lastSeenTitle = t;
    for (const cb of _titleListeners) {
      try { cb(t); } catch (e) { console.warn('[qualia] strudel title listener failed:', e); }
    }
  }
  // Source of truth for "is Strudel adopted into audio analysis" is
  // `audio.hasSource('strudel')` — this module no longer carries its own
  // `tapped` flag, so the panel/playback/audio state can't drift from one
  // another. Local helpers below read hasSource() directly.
  // Source of truth for "is the user expecting Strudel to be playing".
  // We *cannot* use btnPlay's `playing` class for this: Strudel's evaluate()
  // internally calls ed.stop() before scheduling new code, which fires our
  // patched stop and yanks the class off — so by the time the user clicks
  // a pattern button a moment later, the class has already cleared and
  // `wasPlaying` reads false. The flag is set/cleared only from our own
  // play()/stop()/stopPlayback() entrypoints.
  let isPlayingFlag = false;

  // Wire `globalThis.a` so Strudel/Hydra patterns referencing `a.fft[0..3]`
  // get the QualiaField bands. We back the array with the live AudioFrame.
  const aFft = [0, 0, 0, 0];
  const stub = {
    fft: aFft,
    setBins() {}, setSmooth() {}, setCutoff() {}, show() {}, hide() {},
  };
  if (typeof globalThis !== 'undefined') globalThis.a = stub;

  // Live-code hook: setParam('singularity_lens', 'horizon', 0.25)
  if (typeof globalThis !== 'undefined') {
    globalThis.qualia = {
      setParam: (fxId, paramId, value) => setParam?.(fxId, paramId, value),
      getField: () => getField?.(),
      // Live A/B the cyclist lookahead from the console, e.g.
      // qualia.setStrudelLatency(0.3) — higher = fewer dropouts, more delay.
      // Re-run the sequencer realign after changing.
      setStrudelLatency: (sec) => setStrudelLatency(sec),
      getStrudelLatency: () => getStrudelLatency(),
      // A/B the editor cost: qualia.setStrudelEditorPerf(true) disables the
      // per-frame in-code highlighting + flash (the main editor-open cost).
      setStrudelEditorPerf: (on) => setEditorPerf(on),
      getStrudelEditorPerf: () => getEditorPerf(),
      // Toggle editor line numbers (mirrors the "#" button in the tab bar).
      setStrudelLineNumbers: (on) => setLineNumbers(on),
      getStrudelLineNumbers: () => getLineNumbers(),
      // Editor font size (mirrors the header slider; double-click it to reset).
      setStrudelFontSize: (px) => setFontSize(px),
      getStrudelFontSize: () => getFontSize(),
    };
  }

  function refreshAFft() {
    const f = getField?.();
    if (!f) return;
    aFft[0] = f.audio.bands.bass;
    aFft[1] = f.audio.bands.mids;
    aFft[2] = f.audio.bands.highs;
    aFft[3] = f.audio.bands.total;
  }

  function getEditor() { return editorEl?.editor ?? null; }

  // Reach for the inner scheduler (StrudelMirror.repl.scheduler in current
  // Strudel; .scheduler on older builds). Used by the sequencer's sync
  // bridge — calling scheduler.setCps directly is the most reliable way
  // to push tempo into Strudel because it bypasses the eval-scope dance
  // that decides whether `globalThis.setcps` ever appears.
  function getScheduler() {
    const ed = getEditor();
    return ed?.repl?.scheduler ?? ed?.scheduler ?? null;
  }

  // Strudel-editor's internal CodeMirror state is not exposed by a single
  // canonical API across versions. Order matters here:
  //
  //   - The *outer* <strudel-editor> element exposes `ed.code`, but that's
  //     just the initial value passed via the `code` attribute. The
  //     attributeChangedCallback writes it once on mount; user edits never
  //     update it. Reading it gives the original pattern, not the edited
  //     one — that was the long-standing "save persists the original"
  //     bug. Skip it.
  //   - The *inner* `ed.editor` is the StrudelMirror/repl wrapper. Its
  //     onChange callback does `this.code = w.state.doc.toString()` on
  //     every CodeMirror docChanged tick, so `ed.editor.code` IS live.
  //   - DOM scrape of `.cm-line` nodes is a fallback for any Strudel
  //     version whose inner-editor API surface drifts.
  function readEditorCode() {
    const ed = editorEl;
    if (!ed) return null;
    try {
      if (typeof ed.editor?.code === 'string') return ed.editor.code;
      if (typeof ed.editor?.getValue === 'function') return ed.editor.getValue();
      const root = ed.shadowRoot || ed;
      const cm = root.querySelector?.('.cm-editor') || root.querySelector?.('.cm-content');
      if (cm) {
        const lines = cm.querySelectorAll?.('.cm-line');
        if (lines && lines.length) {
          return Array.from(lines).map(l => l.textContent).join('\n');
        }
        return cm.textContent;
      }
      // Outer element's `code` attribute as last resort — likely stale,
      // but better than null if all the inner paths above fail.
      if (typeof ed.code === 'string') return ed.code;
    } catch {}
    return null;
  }
  function persistCurrent() {
    const code = readEditorCode();
    if (code != null) {
      saveCurrent(code);
      // Catch manual @title edits — fires on every play/stop tick (where
      // persistCurrent is invoked), but the de-dup in notifyTitleIfChanged
      // keeps it cheap when nothing changed.
      notifyTitleIfChanged(parseMetadata(code).title || '');
    }
    return code;
  }

  // Eval error indicator. Strudel reports syntax/runtime eval failures only to
  // the console + a 'strudel.log' CustomEvent on `document`; it gives no
  // in-panel signal. Surface the last error in the header (full text in the
  // title tooltip). Pass a falsy err to clear.
  function showEvalError(err) {
    if (!errEl) return;
    if (!err) {
      errEl.style.display = 'none';
      errEl.textContent = '';
      errEl.removeAttribute('title');
      return;
    }
    const msg = (err && (err.message ?? err.toString?.())) || String(err);
    errEl.textContent = `⚠ ${msg}`;
    errEl.title = msg;
    errEl.style.display = '';
  }
  function clearEvalError() { showEvalError(null); }

  // Capture errors from Strudel's own logger (version-stable public surface,
  // no editor internals): it dispatches `strudel.log` on `document` with
  // detail {message,type}. An eval failure is type 'error' ("[eval] error: …");
  // a clean eval logs "[eval] code updated" (no type) — clear on that so the
  // badge tracks every eval, including Strudel-internal re-evals our wrapped
  // evaluate() never sees.
  document.addEventListener('strudel.log', (e) => {
    const d = e.detail;
    if (!d) return;
    const msg = String(d.message ?? '');
    if (d.type === 'error') {
      showEvalError(msg.replace(/^\[eval\]\s*error:\s*/i, '') || 'eval error');
    } else if (msg.includes('[eval] code updated')) {
      clearEvalError();
    }
  });

  function ensureEvalPatch() {
    if (_strudelEvalPatched) return false;
    const ed = getEditor();
    if (!ed) return false;
    if (typeof ed.evaluate === 'function') {
      const orig = ed.evaluate.bind(ed);
      ed.evaluate = function(...args) {
        try { clearHydraOutputs(); } catch {}
        // Persist on play so the in-progress edit survives a refresh.
        try { persistCurrent(); } catch {}
        _inEvaluate = true;
        let r;
        try { r = orig(...args); } finally { _inEvaluate = false; }
        // Re-assert a user-set latency override (if any) after a re-eval
        // rebuilds the scheduler. No-op unless setStrudelLatency was called —
        // by default we leave Strudel's own latency alone (keeps seq aligned).
        try { tuneScheduler(); } catch {}
        // A Strudel-native evaluate (Ctrl-Enter / Shift-Enter in the editor)
        // means "start playing" — mirror it into our play-state machinery so
        // the ▶ button reflects it and, when sync is on + both panels open,
        // the sequencer follows. When our own play() drove this evaluate it
        // marks playing itself (and sets _inExplicitTransport so we don't
        // double-fire). The <strudel-editor> element does not auto-evaluate
        // on mount, so this only ever fires on a deliberate user evaluate.
        if (!_inExplicitTransport) {
          try { markStrudelPlaying(); } catch {}
        }
        return r;
      };
    }
    if (typeof ed.stop === 'function') {
      const orig = ed.stop.bind(ed);
      ed.stop = function(...args) {
        try { clearHydraOutputs(); clearScopeCanvas(scopeCanvas); } catch {}
        try { persistCurrent(); } catch {}
        const r = orig(...args);
        // A Strudel-native stop (Ctrl-.) means "stop playback" — mirror it
        // into our state so the ▶ button clears and, with sync on + both
        // panels open, the sequencer follows. We must NOT do this for the
        // internal stop evaluate() fires to swap patterns (_inEvaluate) nor
        // for our own stop()/stopPlayback() (_inExplicitTransport) — those
        // manage state themselves, and treating the eval-internal stop as a
        // user stop would race every restart.
        if (!_inEvaluate && !_inExplicitTransport) {
          try { markStrudelStopped(); } catch {}
        }
        return r;
      };
    }
    _strudelEvalPatched = true;
    applyEditorSettings();   // re-apply perf mode on this freshly-mounted editor
    return true;
  }

  // Editor visual-cost control. Strudel's CodeMirror per-frame pattern-event
  // highlighting (and the eval flash) are the dominant main-thread cost while
  // the editor panel is open and playing — they update decorations every frame
  // for every event, which is heavy on dense patterns (e.g. hh*15). Perf mode
  // disables them via the editor's own settings API; editing/playback are
  // unchanged, you just lose the moving in-code highlight + flash. Default off
  // (keep highlighting). A/B from the console: qualia.setStrudelEditorPerf(true).
  let _editorPerfMode = false;
  let _lineNumbers = loadLineNumbers();   // opt-in; default off (CDN default)
  let _autocomplete = loadAutocomplete(); // built-in intellisense; default on
  let _fontSize    = loadFontSize();      // editor font px; slider + dblclick-reset
  function applyEditorSettings() {
    const ed = getEditor();
    if (!ed || typeof ed.updateSettings !== 'function') return false;
    try {
      ed.updateSettings({
        isPatternHighlightingEnabled: !_editorPerfMode,
        isFlashEnabled: !_editorPerfMode,
        isLineNumbersDisplayed: _lineNumbers,
        // Strudel's own CodeMirror intellisense — the same function-name
        // completion + doc tooltips as strudel.cc. Both ride this settings
        // call so they re-apply on every editor re-mount. Independent of
        // perf mode (event-driven: completion on keystroke, tooltip on hover).
        isAutoCompletionEnabled: _autocomplete,
        isTooltipEnabled: _autocomplete,
      });
      return true;
    } catch (e) {
      console.warn('[qualia] applyEditorSettings failed:', e);
      return false;
    }
  }
  function setEditorPerf(on) {
    _editorPerfMode = !!on;
    const ok = applyEditorSettings();
    console.log(
      `[qualia] strudel editor perf mode ${_editorPerfMode ? 'ON (highlight off)' : 'OFF (highlight on)'}` +
      (ok ? '' : ' — editor not ready or settings API unavailable')
    );
    return _editorPerfMode;
  }
  function getEditorPerf() { return _editorPerfMode; }

  // Line numbers — optional, persisted, applied via the same editor settings
  // call (so it survives editor re-mounts on load/new/random). The "#" toggle
  // in the tab bar drives it; helpful for locating the "(line:col)" in eval
  // errors. Default off.
  function refreshLinesBtn() {
    if (!btnLines) return;
    btnLines.classList.toggle('active', _lineNumbers);
    btnLines.setAttribute('aria-pressed', _lineNumbers ? 'true' : 'false');
  }
  function setLineNumbers(on) {
    _lineNumbers = !!on;
    saveLineNumbers(_lineNumbers);
    applyEditorSettings();
    refreshLinesBtn();
    return _lineNumbers;
  }
  function getLineNumbers() { return _lineNumbers; }
  if (btnLines) {
    refreshLinesBtn();
    btnLines.addEventListener('click', () => setLineNumbers(!_lineNumbers));
  }

  // Editor font size — a CSS var on :root drives the #strudel-mount font-size
  // rule (CM6 line-height is em-relative, so the gutter scales with it).
  function applyFontSize() {
    try { document.documentElement.style.setProperty('--strudel-font-size', _fontSize + 'px'); } catch {}
  }
  function setFontSize(px) {
    const n = Math.round(Number(px));
    _fontSize = Number.isFinite(n) ? Math.max(FONT_MIN, Math.min(FONT_MAX, n)) : FONT_DEFAULT;
    saveFontSize(_fontSize);
    applyFontSize();
    return _fontSize;
  }
  function getFontSize() { return _fontSize; }
  applyFontSize();   // apply the persisted size on init

  // Built-in autocomplete + hover docs toggle — same settings call, same
  // persistence pattern as line numbers. The ⌨ button in the tab bar drives
  // it. Default on (see loadAutocomplete).
  function refreshAutoBtn() {
    if (!btnAuto) return;
    btnAuto.classList.toggle('active', _autocomplete);
    btnAuto.setAttribute('aria-pressed', _autocomplete ? 'true' : 'false');
  }
  function setAutocomplete(on) {
    _autocomplete = !!on;
    saveAutocomplete(_autocomplete);
    applyEditorSettings();
    refreshAutoBtn();
    return _autocomplete;
  }
  function getAutocomplete() { return _autocomplete; }
  if (btnAuto) {
    refreshAutoBtn();
    btnAuto.addEventListener('click', () => setAutocomplete(!_autocomplete));
  }

  // Optional frosted backdrop behind the editor — persisted, default off.
  // The ⬚ button in the header toggles `.blurred` on the panel.
  let _blur = loadBlur();
  function refreshBlurBtn() {
    if (!btnBlur) return;
    btnBlur.classList.toggle('active', _blur);
    btnBlur.setAttribute('aria-pressed', _blur ? 'true' : 'false');
  }
  function applyBlur() { if (panel) panel.classList.toggle('blurred', _blur); }
  function setBlur(on) { _blur = !!on; saveBlur(_blur); applyBlur(); refreshBlurBtn(); return _blur; }
  applyBlur(); refreshBlurBtn();
  if (btnBlur) btnBlur.addEventListener('click', () => setBlur(!_blur));

  // Initial code: a freshly-rolled random pattern by default. If the panel
  // was open on the previous visit, the user was probably mid-edit — in
  // that case restore the stored buffer instead so their work survives a
  // refresh. Closing the panel is the implicit "I'm done with this take"
  // signal that resets to fresh randomness. Uses the init-time snapshot,
  // not the live flag — open()/close() within this session will have
  // already changed it.
  function pickInitialCode() {
    if (wasOpenLastSession) {
      const stored = loadCurrent();
      if (stored && stored.trim()) return stored;
    }
    return randomPattern();
  }

  function mountEditor() {
    if (mounted || !mount) return;
    instantiateEditor(pickInitialCode());
    mounted = true;
  }
  function instantiateEditor(code) {
    if (!mount) return;
    mount.innerHTML = '';
    const ed = document.createElement('strudel-editor');
    ed.appendChild(document.createComment(`\n${code}\n`));
    mount.appendChild(ed);
    editorEl = ed;
    _strudelEvalPatched = false;
    clearEvalError();   // stale error from the previous buffer no longer applies
    let tries = 0;
    const t = setInterval(() => {
      if (ensureEvalPatch() || ++tries > 40) clearInterval(t);
    }, 150);
    injectStrudelTransparency(ed);
    saveCurrent(code);
    // Surface the @title of whatever code we just mounted (initial random,
    // restored buffer, or a load). Sequencer mirrors this when sync is on.
    notifyTitleIfChanged(parseMetadata(code).title || '');
  }
  function loadCode(code) {
    // Allow '' through (a blank/new pattern is a legitimate buffer); only
    // reject non-strings. instantiateEditor persists whatever we mount.
    if (typeof code !== 'string') return;
    // If the user was mid-playback when they swapped patterns, immediately
    // re-evaluate the new code on the freshly-mounted editor — keeps the
    // jam continuous instead of forcing a manual ▶ after every change.
    // (Nothing to re-eval for an empty buffer.)
    const wasPlaying = isPlayingFlag && !!code.trim();
    // Stop the old editor's scheduler before we destroy its DOM. Without
    // this, Strudel's runtime keeps firing events on the orphaned editor
    // and you get double-playback layered with the new pattern.
    stopPlayback();
    instantiateEditor(code);
    if (wasPlaying) {
      // Three-stage readiness so we don't fire evaluate() on a half-loaded
      // editor (which silently runs on an empty buffer):
      //   1. inner editor handle exists with an .evaluate method (REPL up)
      //   2. CodeMirror has non-empty content (initial-code comment loaded)
      //   3. content is stable for ≥2 ticks (CM has finished any layout/parse
      //      passes — we sometimes saw evaluate fire mid-load and silently
      //      no-op on the previous editor's transient cm-line residue).
      let tries = 0;
      let lastCur = '';
      let stableCount = 0;
      const t = setInterval(() => {
        if (++tries > 80) { clearInterval(t); return; }
        const ed = getEditor();
        if (!ed || typeof ed.evaluate !== 'function') {
          stableCount = 0; lastCur = ''; return;
        }
        const cur = (readEditorCode() || '').trim();
        if (cur.length < 5) { stableCount = 0; lastCur = cur; return; }
        if (cur === lastCur) {
          if (++stableCount >= 2 && play()) clearInterval(t);
        } else {
          stableCount = 0; lastCur = cur;
        }
      }, 100);
    }
  }

  // Paint the topbar `strudel` button from current state — panel open
  // and audio adoption are independent now (panel can be hidden while
  // Strudel keeps playing into the analyser), so the label has to
  // consult both. Earlier the text was mutated from open()/close()/
  // tapMaster() in three places and could disagree with itself.
  function refreshStrudelBtn() {
    if (!btnToggle) return;
    btnToggle.classList.remove('active', 'active-audio');
    const live = audio.hasSource('strudel');
    const open = panel?.style.display !== 'none';
    if (open) btnToggle.classList.add('active');
    btnToggle.textContent = isPlayingFlag ? 'strudel ●' : 'strudel';
    if (status) {
      if (live) {
        status.textContent = 'audio: live';
        status.classList.add('live');
      } else {
        status.classList.remove('live');
      }
    }
  }

  // Suppress the play-state callback when our own play()/stop() is
  // being invoked AS the result of an upstream sync (sequencer →
  // strudel). Without this guard, the seq's "I just played, please
  // play strudel" message would loop right back through onPlayStateChange
  // and re-trigger the seq, causing flutter and double-fire bugs.
  let _suppressPlayStateChange = false;
  // True only while our own play()/stop()/stopPlayback() is driving
  // ed.evaluate()/ed.stop(). The wrapped evaluate treats a Strudel-native
  // evaluate (Ctrl-Enter) as "start playing" and the wrapped stop treats a
  // Strudel-native stop (Ctrl-.) as "stop playing"; this flag tells them to
  // stand down when our own entrypoints are the caller, so state is marked
  // exactly once.
  let _inExplicitTransport = false;
  // True while we're inside the wrapped evaluate's orig() call. Strudel's
  // evaluate() halts the previous pattern via this.stop() before scheduling
  // the new one — that internal stop must NOT be read as the user stopping
  // playback, so the wrapped stop checks this.
  let _inEvaluate = false;

  // ── Cycle-clock epoch (for sequencer phase alignment) ────────────────────
  // Two probes feed `getSecondsUntilNextStrudelBoundary()`:
  //   A. live read of `scheduler.now()` (Strudel cyclist returns a cycle
  //      position float). Preferred — uses Strudel's own clock.
  //   B. epoch fallback: we anchor `_strudelEpoch` (audio-time of a known
  //      cycle-0 boundary) on play(), and re-anchor it on every cps change
  //      so cycle math stays exact across tempo edits. Used when probe A
  //      isn't available.
  let _strudelEpoch    = null;  // AudioContext seconds, OR null when not playing
  let _strudelEpochCps = 0.5;   // cps at the anchor moment
  let _playAnchorCtxTime = 0;   // ctx.currentTime captured when play started;
                                // lets the sequencer tell a FRESH scheduler
                                // anchor from a stale one left by a prior run.
  function getAudioCtxSafe() {
    try { return globalThis.getAudioContext?.() || null; } catch { return null; }
  }
  function readSchedulerCps() {
    try {
      const s = getScheduler();
      const c = s?.cps;
      if (typeof c === 'number' && c > 0) return c;
    } catch {}
    return _strudelEpochCps;
  }
  function readSchedulerLatency() {
    try {
      const s = getScheduler();
      const l = s?.latency;
      if (typeof l === 'number' && l >= 0) return l;
    } catch {}
    return 0.1;  // Strudel cyclist default
  }

  // ── Cyclist lookahead (OPT-IN) ───────────────────────────────────────────
  // Widening the cyclist's latency reduces "skip query: too late" dropouts
  // under main-thread load, BUT auto-bumping it broke sequencer alignment: the
  // boundary probe below reads scheduler.latency live, while the events for the
  // current cycle were already scheduled at the OLD latency — leaving the
  // sequencer a fixed (latency-delta) seconds off from Strudel. So we default
  // to leaving Strudel's own latency untouched (= correct alignment) and treat
  // the real dropout fix as freeing the main thread (pose inference now runs in
  // a worker). The knob remains for manual tuning; when set, re-run the
  // sequencer realign once afterward to re-lock the phase.
  let _strudelLatency = null;   // null = don't override Strudel's default
  function tuneScheduler() {
    if (_strudelLatency == null) return false;   // opt-in only
    const s = getScheduler();
    if (!s) return false;
    try {
      const before = s.latency;
      if (typeof s.latency === 'number') s.latency = _strudelLatency;
      if (before !== s.latency) {
        console.log(`[qualia] strudel scheduler latency ${before} → ${s.latency}`);
      }
      return true;
    } catch (e) {
      console.warn('[qualia] could not tune strudel scheduler:', e);
      return false;
    }
  }
  /** Live-adjust the cyclist lookahead (seconds). Higher = fewer dropouts,
   *  more play→sound delay. Re-run the sequencer realign after changing.
   *  Pass null/0 to release the override back to Strudel's own default. */
  function setStrudelLatency(sec) {
    _strudelLatency = (sec == null || +sec <= 0) ? null : Math.max(0.05, Math.min(0.5, +sec));
    tuneScheduler();
    return _strudelLatency;
  }
  function getStrudelLatency() {
    return _strudelLatency != null ? _strudelLatency : readSchedulerLatency();
  }
  // Probe Strudel's scheduler state directly. Both cyclist (h3) and
  // neocyclist (PT) expose enough internals to compute AUDIBLE boundary
  // times exactly. Strudel schedules events at:
  //   audio_time(cycle K) = (K - anchorCycle) / cps + anchorSec + latency
  // where (anchorCycle, anchorSec) is the cycle/audio-time pair captured
  // at the most recent cps change (or at start). `now()` returns the
  // scheduling-cursor cycle position, which is `latency - duration`
  // seconds AHEAD of audible — using it directly would put the sequencer
  // a fixed offset early.
  function probeStrudelState() {
    try {
      const s = getScheduler();
      if (!s) return null;
      const cps = (typeof s.cps === 'number' && s.cps > 0) ? s.cps : null;
      if (cps == null) return null;
      const latency = readSchedulerLatency();
      // h3 (cyclist) — has both fields directly on the instance.
      if (typeof s.seconds_at_cps_change === 'number' &&
          typeof s.num_cycles_at_cps_change === 'number') {
        return { cps, latency,
                 anchorSec:   s.seconds_at_cps_change,
                 anchorCycle: s.num_cycles_at_cps_change };
      }
      // PT (neocyclist, worker-backed) — anchor on last tick message.
      if (typeof s.time_at_last_tick_message === 'number' &&
          typeof s.cycle === 'number') {
        return { cps, latency,
                 anchorSec:   s.time_at_last_tick_message,
                 anchorCycle: s.cycle };
      }
    } catch {}
    return null;
  }
  // Probe A, but only when its anchor is FRESH since the current play. Right
  // after a (re)start the scheduler can still expose the PREVIOUS run's
  // anchor for a tick or two; using that stale anchorCycle yields a wrong
  // absolute cycle number — which is exactly what put the sequencer half a
  // phrase out of phase on patterns spanning multiple cycles. Reject it so
  // callers fall back to the freshly-anchored epoch (Probe B) until Probe A
  // catches up.
  function probeStrudelStateFresh() {
    const st = probeStrudelState();
    if (!st || typeof st.anchorSec !== 'number') return null;
    if (st.anchorSec < _playAnchorCtxTime - 0.02) return null;
    return st;
  }
  // Anchor (or re-anchor) the cycle epoch used by Probe B. On a cps
  // change, snap the epoch forward to the most recent boundary at the
  // OLD cps before storing the NEW cps. Probe B is a coarse fallback —
  // Probe A is always preferred when scheduler state is readable.
  function reanchorEpoch(newCps) {
    const c = typeof newCps === 'number' && newCps > 0 ? newCps : _strudelEpochCps;
    if (_strudelEpoch != null) {
      const ctx = getAudioCtxSafe();
      const now = ctx?.currentTime;
      if (typeof now === 'number') {
        const elapsed = Math.max(0, now - _strudelEpoch);
        const cyclesElapsed = elapsed * _strudelEpochCps;
        _strudelEpoch = _strudelEpoch + Math.floor(cyclesElapsed) / _strudelEpochCps;
      }
    }
    _strudelEpochCps = c;
  }
  // Smallest integer >= c, with a tiny epsilon so positions within ~1ms
  // of an integer are treated as ON the integer rather than "about to
  // hit the next one in a full cycle". Without this, first-play (where
  // pos starts at exactly 0) would still align correctly via ceil(0)=0,
  // but pos a few microseconds past an integer would unnecessarily wait
  // a whole cycle.
  function nextCycleAt(c) {
    const eps = 1e-4;
    return Math.ceil(c - eps);
  }
  // Return seconds-until-next-AUDIBLE-cycle-boundary. Null when not
  // playing or both probes fail. Returning a RELATIVE duration (not an
  // absolute audio time) is deliberate: Strudel and Tone may not share
  // an AudioContext, so absolute `currentTime` values aren't comparable
  // across the boundary. Both contexts advance at the same rate
  // (1 audio second per real second), so a duration is portable —
  // callers add it to their own clock to get an absolute time.
  //
  // The "audible" part matters: Strudel schedules events `latency`
  // seconds ahead of their cursor time, so a naive read of `now()`
  // would put downbeats ~50–100ms before the user hears them.
  function getSecondsUntilNextStrudelBoundary() {
    if (!isPlayingFlag) return null;
    const ctx = getAudioCtxSafe();
    const now = ctx?.currentTime;
    if (typeof now !== 'number') return null;
    // Probe A — direct read of scheduler state. Computes the audible
    // event time from Strudel's own scheduling formula.
    const st = probeStrudelStateFresh();
    if (st) {
      const absPos = (now - st.anchorSec - st.latency) * st.cps + st.anchorCycle;
      const nextK  = nextCycleAt(absPos);
      const boundaryStrudelTime =
        (nextK - st.anchorCycle) / st.cps + st.anchorSec + st.latency;
      return boundaryStrudelTime - now;
    }
    // Probe B — epoch fallback (no direct state). Epoch is set at play()
    // to ctx.currentTime + latency so it points at audible cycle-0.
    if (_strudelEpoch == null) return null;
    const cyclesElapsed = (now - _strudelEpoch) * _strudelEpochCps;
    const nextK = nextCycleAt(cyclesElapsed);
    const boundaryStrudelTime = _strudelEpoch + nextK / _strudelEpochCps;
    return boundaryStrudelTime - now;
  }
  // Strudel's current AUDIBLE cycle position as a float (e.g. 5.3 = 30% into
  // cycle 5), with its cps. Lets the sequencer phase-lock a multi-cycle
  // pattern to Strudel's absolute cycle — so the pattern's cell 0 lands on a
  // cycle that's a multiple of `cycles`, not on whichever single-cycle
  // boundary happens to be nearest (which flipped the phase by a bar after a
  // restart). Same audible-vs-cursor `latency` correction as the boundary
  // probe; same fresh-Probe-A-else-epoch fallback.
  function getStrudelAudibleCyclePos() {
    if (!isPlayingFlag) return null;
    const ctx = getAudioCtxSafe();
    const now = ctx?.currentTime;
    if (typeof now !== 'number') return null;
    const st = probeStrudelStateFresh();
    if (st) {
      const pos = (now - st.anchorSec - st.latency) * st.cps + st.anchorCycle;
      return { pos, cps: st.cps };
    }
    if (_strudelEpoch == null) return null;
    const pos = (now - _strudelEpoch) * _strudelEpochCps;
    return { pos, cps: _strudelEpochCps };
  }
  function emitPlayState(playing) {
    if (_suppressPlayStateChange) return;
    try { onPlayStateChange?.(!!playing); } catch {}
  }
  // Mark Strudel as playing and emit the play-state. Shared by play() (the ▶
  // button / sync mirror) and the wrapped evaluate (Ctrl-Enter), so both
  // entrypoints update state identically. Anchors the cycle-clock epoch only
  // on the stopped→playing transition: a re-eval while already playing keeps
  // Strudel's running cycle clock, so re-anchoring there would be wrong.
  function markStrudelPlaying() {
    const wasPlaying = isPlayingFlag;
    isPlayingFlag = true;
    if (!wasPlaying) {
      // Anchor the cycle-clock epoch synchronously so the sequencer can
      // align its next tick BEFORE Strudel has finished spinning up. Read
      // cps live from the scheduler if it's already exposing one; otherwise
      // keep the last-known value.
      _strudelEpochCps = readSchedulerCps();
      const ctx = getAudioCtxSafe();
      const nowCtx = (typeof ctx?.currentTime === 'number') ? ctx.currentTime : null;
      // Audible cycle 0 doesn't sound at currentTime — Strudel's first event
      // is scheduled `latency` seconds in the future. Anchor on that audible
      // moment so Probe B reports boundaries that match what the user hears.
      // Probe A (direct scheduler read) takes over once the first cyclist
      // tick has fired and overwrites these with the true scheduler state.
      _strudelEpoch = (nowCtx != null) ? nowCtx + readSchedulerLatency() : null;
      _playAnchorCtxTime = nowCtx ?? 0;
    }
    btnPlay?.classList.add('playing');
    // Strudel's AudioContext only spins up after the first play(); poll
    // until it's running and we can attach our analyser. Cheap to call
    // when we're already tapped — ensureTapPolling early-returns.
    ensureTapPolling();
    emitPlayState(true);
  }
  // Mark Strudel as stopped and emit the play-state. Shared by stop() (the ▶
  // button / sync mirror) and the wrapped stop (Ctrl-.).
  function markStrudelStopped() {
    if (!isPlayingFlag) return;
    isPlayingFlag = false;
    _strudelEpoch = null;
    btnPlay?.classList.remove('playing');
    audio.releaseAdopted();
    refreshStrudelBtn();
    emitPlayState(false);
  }
  // Has Strudel's scheduler produced a FRESH anchor since the current play
  // started? Right after evaluate() the scheduler state can be stale (left
  // by a prior run) or not yet anchored, so the sequencer's cold phase-align
  // can sit a few ms off. The sequencer polls this and, once it flips true,
  // re-runs the (accurate) align — the same scheduler state the manual align
  // button relies on. Works for both cyclist variants: h3 re-anchors
  // seconds_at_cps_change on (re)start, neocyclist advances
  // time_at_last_tick_message every tick.
  function isSchedulerFreshSincePlay() {
    return isPlayingFlag && probeStrudelStateFresh() != null;
  }
  function play(opts = {}) {
    const ed = getEditor();
    if (!ed) return false;
    ensureEvalPatch();
    const wasSuppressing = _suppressPlayStateChange;
    if (opts.fromSync) _suppressPlayStateChange = true;
    // Tell the wrapped evaluate to stand down — we mark playing ourselves
    // right after, so it must not also fire markStrudelPlaying().
    _inExplicitTransport = true;
    try {
      if      (typeof ed.evaluate === 'function') ed.evaluate();
      else if (typeof ed.toggle   === 'function') ed.toggle();
      else return false;
      markStrudelPlaying();
      return true;
    } catch (e) { console.warn('[qualia] strudel play failed:', e); return false; }
    finally { _suppressPlayStateChange = wasSuppressing; _inExplicitTransport = false; }
  }
  function stop(opts = {}) {
    const ed = getEditor();
    if (!ed) return false;
    ensureEvalPatch();
    const wasSuppressing = _suppressPlayStateChange;
    if (opts.fromSync) _suppressPlayStateChange = true;
    // Drive ed.stop() ourselves; the wrapped stop must not also mark stopped.
    _inExplicitTransport = true;
    try {
      if (typeof ed.stop === 'function') ed.stop();
      else return false;
      isPlayingFlag = false;
      _strudelEpoch = null;
      btnPlay?.classList.remove('playing');
      // Real stop — drop the analyser so the audio mode's `strudel`
      // filter doesn't keep showing the user a ghost source. Re-tap on
      // next play().
      audio.releaseAdopted();
      refreshStrudelBtn();
      emitPlayState(false);
      return true;
    } catch (e) { console.warn('[qualia] strudel stop failed:', e); return false; }
    finally { _suppressPlayStateChange = wasSuppressing; _inExplicitTransport = false; }
  }

  // Mute Strudel's audio without stopping its transport. The previous
  // implementation set `globalThis.getDestination().mute = true` on
  // Strudel's bundled Tone.Destination — but Strudel's actual audio
  // (superdough's voice graph) writes directly to ctx.destination,
  // bypassing Tone.Destination entirely, so the toggle had no audible
  // effect. The fix is a real audio-graph gate: tapMaster() patches
  // AudioNode.prototype.connect to route everything destined for
  // ctx.destination through a GainNode (`muteGate`) we own. setMuted()
  // ramps that gain to 0 / 1.
  //
  // Caveats:
  //   - Nodes already connected before the patch installs keep playing
  //     through the unmuted path. In practice Strudel rebuilds its voice
  //     graph on every eval, so the next ▶ in the editor picks up the
  //     gate. We document this rather than monkey-patching retroactively.
  //   - The sequencer also targets ctx.destination. Its kit.output node
  //     is tagged with `__qualiaBypassMute = true` so the patch leaves
  //     it alone — its own mute is per-source via kit.output.gain.
  let _strudelMuted = false;
  let _strudelVolume = loadVolume();
  let _strudelLimiterOn = loadLimiter();
  let muteGate = null;
  let strudelLimiter = null;
  function ensureMuteGate(ctx) {
    if (muteGate && muteGate.context === ctx) return muteGate;
    muteGate = ctx.createGain();
    muteGate.gain.value = _strudelMuted ? 0 : _strudelVolume;
    // Self-bypass — muteGate's own connect to ctx.destination must not
    // recurse through the patch.
    muteGate.__qualiaBypassMute = true;
    // Brickwall limiter between the gate and the speakers — clip insurance so
    // a loud pattern can't shove full-scale into the device-level sum. The
    // strudelAnalyser still taps muteGate (PRE-limiter) so the meter reads true.
    strudelLimiter = makeLimiter(ctx, _strudelLimiterOn);
    strudelLimiter.__qualiaBypassMute = true;
    muteGate.connect(strudelLimiter);
    strudelLimiter.connect(ctx.destination);
    return muteGate;
  }
  function setLimiter(on) {
    _strudelLimiterOn = !!on;
    saveLimiter(_strudelLimiterOn);
    setLimiterEngaged(strudelLimiter, _strudelLimiterOn);
    notifyMix();
  }
  function getLimiter() { return _strudelLimiterOn; }

  // Mix-change listeners — fire whenever volume/mute/limiter change so the
  // mixer panel's Strudel channel stays in sync with the strudel panel's own
  // slider (and vice-versa). Mirrors audio.js's onInputChange.
  const mixListeners = new Set();
  function onChange(fn) { mixListeners.add(fn); return () => mixListeners.delete(fn); }
  function notifyMix() {
    const snap = { volume: _strudelVolume, muted: _strudelMuted, limiter: _strudelLimiterOn };
    mixListeners.forEach(fn => { try { fn(snap); } catch {} });
  }
  function applyMuteGate() {
    if (!muteGate) return;
    const target = _strudelMuted ? 0 : _strudelVolume;
    try {
      const t = muteGate.context.currentTime;
      muteGate.gain.cancelScheduledValues(t);
      muteGate.gain.linearRampToValueAtTime(target, t + 0.04);
    } catch {
      try { muteGate.gain.value = target; } catch {}
    }
  }
  function setMuted(on) {
    _strudelMuted = !!on;
    applyMuteGate();
    // Belt + braces: also flip Tone.Destination.mute for any audio that
    // DOES route through Strudel's bundled Tone.Destination (Sampler /
    // Player nodes do). Costs nothing if it's already a no-op.
    try {
      const dest = globalThis.getDestination?.();
      if (dest) dest.mute = _strudelMuted;
    } catch {}
    refreshMuteBtn();
    notifyMix();
  }
  function refreshMuteBtn() {
    if (!btnMute) return;
    btnMute.classList.toggle('muted', _strudelMuted);
    btnMute.textContent = _strudelMuted ? 'mute' : 'live';
    btnMute.title = _strudelMuted
      ? 'Unmute Strudel audio'
      : 'Mute Strudel audio (transport keeps running so sync stays locked)';
  }
  if (btnMute) btnMute.addEventListener('click', () => setMuted(!_strudelMuted));

  // Output level — multiplies the muteGate while un-muted. Doesn't
  // change Strudel's gain() in code; stacks with it. Persisted so the
  // ride sticks across reloads.
  function setVolume(v) {
    const clamped = Math.max(0, Math.min(STRUDEL_MAX_GAIN, Number(v) || 0));
    if (clamped === _strudelVolume) return;
    _strudelVolume = clamped;
    saveVolume(_strudelVolume);
    applyMuteGate();
    if (elGain && elGain.value !== String(_strudelVolume)) elGain.value = String(_strudelVolume);
    notifyMix();
  }
  if (elGain) {
    elGain.value = String(_strudelVolume);
    elGain.addEventListener('input', () => setVolume(elGain.value));
  }
  if (elFont) {
    elFont.value = String(_fontSize);
    elFont.addEventListener('input', () => { elFont.value = String(setFontSize(elFont.value)); });
    // double-click resets to the default size
    elFont.addEventListener('dblclick', () => { elFont.value = String(setFontSize(FONT_DEFAULT)); });
  }
  // Initial paint — same reason as the seq panel: the static "live"
  // markup is correct for unmuted, but a programmatic preset would
  // otherwise leave the chrome stale.
  refreshMuteBtn();

  // Defensive stop used by panel-close and pattern-swap paths. Unlike
  // stop(), it doesn't care whether eval has been patched yet — the goal
  // is to silence whatever the current editor is scheduling so a new
  // editor (or a closed panel) doesn't leave audio events in flight.
  // Note: the Strudel REPL lives on `editorEl.editor` (inner handle), not
  // on the `<strudel-editor>` web component itself — that's where stop()
  // actually halts the scheduler.
  function stopPlayback() {
    const ed = getEditor();
    if (ed) {
      // Guard so the wrapped stop doesn't read this defensive stop (pattern
      // swap / panel close) as a user Ctrl-. and propagate it to the seq.
      _inExplicitTransport = true;
      try { if (typeof ed.stop === 'function') ed.stop(); } catch {}
      finally { _inExplicitTransport = false; }
    }
    isPlayingFlag = false;
    btnPlay?.classList.remove('playing');
    audio.releaseAdopted();
    refreshStrudelBtn();
  }

  function tapMaster(ctx) {
    if (!strudelAnalyser) {
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      // smoothingTimeConstant is the analyser's own temporal lag — the single
      // biggest knob on how fast the visuals chase the music pulse. Was 0.72
      // (smooth but sluggish); 0.5 tightens the response toward the mic
      // analyser's 0.4 while still damping FFT jitter on sustained tones.
      an.smoothingTimeConstant = 0.5;
      strudelAnalyser = an;
      // The connect-patch is now the *primary* path (was: fallback): every
      // source that targets ctx.destination is rerouted THROUGH muteGate, so
      // setMuted()/setVolume() can actually silence Strudel. Crucially the
      // reactivity analyser is teed off the muteGate OUTPUT (below) — i.e.
      // POST volume/mute — so a muted or zero-volume Strudel stops driving the
      // visuals too. (It used to tap each source PRE-mute, so the visuals kept
      // reacting to music nobody could hear.) Tone's old bundled-destination
      // tap missed superdough's direct ctx.destination writes; the patch
      // covers both source paths.
      if (!_strudelConnectPatched) {
        const orig = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function(target, ...rest) {
          if (target === ctx.destination && !this.__qualiaBypassMute) {
            return orig.call(this, ensureMuteGate(ctx), ...rest);
          }
          return orig.call(this, target, ...rest);
        };
        _strudelConnectPatched = true;
      }
      // Materialise the gate up front (so it exists before any pre-patch node
      // connects, and so setMuted() has a target if the user toggles before
      // the first eval) and tee the analyser off its post-mute output.
      // muteGate is bypass-tagged so these go through the unpatched connect;
      // duplicate connects are coalesced by Web Audio, so it's idempotent.
      const gate = ensureMuteGate(ctx);
      try { gate.connect(strudelAnalyser); } catch {}
    }
    audio.adoptAnalyser(ctx, strudelAnalyser);
    refreshStrudelBtn();
    return true;
  }

  // Keep polling until `audio.hasSource('strudel')` is true. We previously
  // had a 12-second deadline tied to panel-open; that meant any later play()
  // (after the deadline elapsed) silently never tapped, leaving the UI
  // showing "audio strudel" with no live source. The new policy is "poll
  // while we have a reason to" — Strudel is playing, OR the panel is open
  // and the user might play imminently — and stop the moment we tap.
  function ensureTapPolling() {
    if (pollT) return;
    if (audio.hasSource('strudel')) return;
    pollT = setInterval(() => {
      if (audio.hasSource('strudel')) { clearInterval(pollT); pollT = null; return; }
      // Drop the poll once the user has both stopped Strudel and closed
      // the panel — there's nothing live to attach to and we don't want
      // to spin forever in the background.
      const panelOpen = panel?.style.display !== 'none';
      if (!panelOpen && !isPlayingFlag) { clearInterval(pollT); pollT = null; return; }
      let ctx = null;
      try { ctx = globalThis.getAudioContext?.(); } catch {}
      if (!ctx || ctx.state !== 'running') return;
      tapMaster(ctx);
    }, 200);
  }

  // ── Drag / reposition / persist (shared helper) ────────────────────────
  const reposition = makeDraggablePanel('strudel', panel);

  // Sticky in-session "this panel has been revealed at least once" flag.
  // Cross-panel sync (transport/CPS/title) waits until BOTH the strudel
  // and sequencer panels have been opened, so a fresh page load where the
  // user only opens one doesn't surprise them by driving the other.
  // Restored panels (wasOpenLastSession → open() below) count as opened.
  let _everOpened = false;

  async function open() {
    // Mic and Strudel run side-by-side now — each owns its own analyser
    // and the audio module merges per-band readings every tick. Opening
    // Strudel must NOT stop the mic; if reopening with our analyser
    // already adopted, this is a no-op for audio.
    if (panel) panel.style.display = '';
    _everOpened = true;
    savePanelOpen(true);
    reposition();
    refreshStrudelBtn();
    if (status && !audio.hasSource('strudel')) {
      status.textContent = 'loading…';
    }
    try { await loadStrudelScript(); }
    catch (err) {
      if (status) status.textContent = `error: ${err.message || err}`;
      return;
    }
    mountEditor();
    if (status && !audio.hasSource('strudel')) {
      status.textContent = 'click ▶ in editor to start';
    }
    ensureTapPolling();
  }

  function close() {
    // Hiding the panel is purely a "hide UI" action — Strudel keeps
    // playing, and crucially the adopted analyser stays attached so the
    // visualizers continue to react. We previously released the tap
    // here, which left users with `audio strudel` mode set, audio
    // audibly playing, but no viz. Release happens in stop()/
    // stopPlayback() instead — the actual end of playback.
    if (panel) panel.style.display = 'none';
    savePanelOpen(false);
    // Likewise the poll only needs to keep running if we still have
    // something to tap onto (i.e. Strudel is still playing). When the
    // user closes the panel without playing anything, kill it.
    if (!isPlayingFlag && pollT) { clearInterval(pollT); pollT = null; }
    refreshStrudelBtn();
  }

  // Repaint whenever audio.js itself flips strudel on/off so the topbar
  // button label can never disagree with reality. Page-init also
  // subscribes for its own button — both listeners coexist fine.
  audio.onChange?.(() => refreshStrudelBtn());

  if (btnToggle) btnToggle.addEventListener('click', () => {
    if (!panel) return;
    if (panel.style.display === 'none') open();
    else                                 close();
  });
  if (btnClose) btnClose.addEventListener('click', close);
  if (btnPlay) btnPlay.addEventListener('click', () => {
    if (!play()) {
      let tries = 0;
      const t = setInterval(() => {
        if (play() || ++tries > 20) clearInterval(t);
      }, 150);
    }
  });
  if (btnStop) btnStop.addEventListener('click', stop);

  // Insert text at the editor cursor. Path 1 is the CodeMirror 6 transaction
  // API — works for any text, so it backs both the newline button and the
  // funcs/sounds panels' click-to-insert. Path 2 is a newline-only fallback:
  // Android touch keyboards (GBoard especially) drop the keydown for Enter
  // inside the contenteditable nested in strudel-editor's Shadow DOM, so we
  // synthesize a keydown the editor's keymap treats like a real Enter press.
  // Intentionally idempotent: a no-op when the editor isn't mounted.
  function insertAtCursor(text) {
    const ed = editorEl;
    if (!ed) return false;

    // Path 1: CodeMirror 6 EditorView exposed as ed.editor.editor (the
    // Strudel REPL wraps the underlying CM view one level deep).
    try {
      const view = ed.editor?.editor || ed.editor;
      if (view && view.state && typeof view.dispatch === 'function') {
        view.focus?.();
        view.dispatch(view.state.replaceSelection(text));
        return true;
      }
    } catch {}

    // Path 2 (newline only): synthetic keydown on the .cm-content node inside
    // the shadow root. CodeMirror's keymap responds to this even when the
    // OS-level keyboard never fires the original event.
    if (text === '\n') {
      try {
        const root = ed.shadowRoot || ed;
        const cm = root.querySelector?.('.cm-content');
        if (cm) {
          cm.focus();
          const ev = new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true,
          });
          cm.dispatchEvent(ev);
          return true;
        }
      } catch {}
    }

    return false;
  }
  function insertNewlineAtCursor() { return insertAtCursor('\n'); }
  if (btnNewline) btnNewline.addEventListener('click', insertNewlineAtCursor);

  // Periodic auto-save while editing. Cheap (one DOM scrape every 8 sec)
  // and only persists if the code changed since the last save, so we don't
  // hammer localStorage during quiet periods.
  let lastPersistedCode = null;
  setInterval(() => {
    if (!mounted) return;
    const code = readEditorCode();
    if (code != null && code !== lastPersistedCode) {
      saveCurrent(code);
      lastPersistedCode = code;
    }
  }, 8000);

  // Pattern management API. Returned alongside the existing strudel-hydra
  // surface so page-init can wire UI actions without poking internals.
  function listPatterns()        { return loadList(); }
  function saveCurrentToList(name) {
    const code = readEditorCode();
    if (!code) return null;
    return addToList(code, name);
  }
  function updatePattern(id, partial) { return updateInList(id, partial); }
  function removePattern(id)          { removeFromList(id); }
  function clonePatternEntry(id)      { return clonePattern(id); }
  function downloadPatternEntry(id) {
    const p = loadList().find(x => x.id === id);
    if (p) downloadPattern(p.code, p.name);
  }
  function loadPatternEntry(id) {
    const p = loadList().find(x => x.id === id);
    if (p) loadCode(p.code);
  }
  function newBlankPattern() {
    // Literally empty, like the stock Strudel REPL's new pattern — no
    // @title/@by/@license header, no setcps/silence seed.
    loadCode('');
  }
  function newRandomPattern() {
    loadCode(randomPattern());
  }

  // Best-effort title read for cross-engine sync (sequencer mirrors this as
  // its own pattern name when sync is on). Falls back to the persisted
  // buffer so it works even before the editor has mounted.
  function getCurrentTitle() {
    const code = readEditorCode() || loadCurrent() || '';
    return parseMetadata(code).title || '';
  }

  // Rewrite the `// @title ...` line in place. Tries a CodeMirror
  // transaction first so live playback isn't interrupted; falls back to
  // patching the persisted buffer so the next mount reflects the change.
  function setTitle(name) {
    if (typeof name !== 'string') return;
    const trimmed = name.trim();
    if (!trimmed) return;
    // Prime the de-dup BEFORE editing so the persistCurrent notify path
    // (fired on the next eval) sees the value as already-known and
    // doesn't echo back to whoever just called setTitle.
    _lastSeenTitle = trimmed;
    let inPlaceOk = false;
    try {
      const ed = getEditor();
      const view = ed?.editor;
      const doc = view?.state?.doc;
      if (view && doc && typeof view.dispatch === 'function') {
        const code = doc.toString();
        const re = /^[ \t]*\/\/[ \t]*@title[ \t]+.*$/m;
        const m  = re.exec(code);
        const newLine = `// @title ${trimmed}`;
        if (m) {
          if (m[0] !== newLine) {
            view.dispatch({
              changes: { from: m.index, to: m.index + m[0].length, insert: newLine },
            });
          }
          inPlaceOk = true;
        } else {
          view.dispatch({ changes: { from: 0, to: 0, insert: newLine + '\n' } });
          inPlaceOk = true;
        }
      }
    } catch {}
    const cur = readEditorCode();
    if (cur != null) {
      saveCurrent(inPlaceOk ? cur : setMetadata(cur, 'title', trimmed));
    } else {
      const stored = loadCurrent();
      if (stored != null) saveCurrent(setMetadata(stored, 'title', trimmed));
    }
  }

  // Restore last-session panel state. If the panel was open on the previous
  // visit, reopen it now (which mounts the editor and loads the last code
  // via pickInitialCode's restore branch). open() is async — fire and
  // forget, the rest of init doesn't depend on Strudel being ready.
  if (wasOpenLastSession) {
    open();
  }

  // Enumerate the sounds/samples Strudel currently has registered, for the
  // sounds browser panel. superdough keeps them in a nanostores `soundMap`
  // that the @strudel/repl bundle exposes on globalThis via evalScope — the
  // same bulk-global path that gives us getAudioContext(). The map fills in
  // asynchronously as prebake loads the default banks over the network, so
  // the panel re-reads on open and via a refresh button. Returns a sorted
  // [{ name, type, count }]; empty array until the registry exists.
  function listSounds() {
    try {
      const sm = globalThis.soundMap;
      const dict = (sm && typeof sm.get === 'function') ? sm.get() : null;
      if (!dict) return [];
      const out = [];
      for (const name of Object.keys(dict)) {
        const data = dict[name]?.data || {};
        let type = data.type || '';
        if (!type) type = /^gm_/.test(name) ? 'soundfont' : 'other';
        const s = data.samples;
        let count = 0;
        if (Array.isArray(s)) count = s.length;
        else if (s && typeof s === 'object') count = Object.keys(s).length;
        out.push({ name, type, count });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    } catch { return []; }
  }

  // Audition a registered sound through superdough directly — no effect on the
  // editor's pattern or the scheduler. superdough(value, t, dur, cps) wants an
  // ABSOLUTE AudioContext onset time, so we schedule a hair in the future.
  // Pitched sources (synths/soundfonts) get a default note so there's
  // something to hear; samples play as-is. superdough is exposed on globalThis
  // by the bundle, same path as getAudioContext().
  function previewSound(name, type) {
    try {
      const ac = globalThis.getAudioContext?.();
      const dough = globalThis.superdough;
      if (!ac || typeof dough !== 'function') return false;
      ac.resume?.();
      const value = { s: name, gain: 0.9 };
      if (type && type !== 'sample') value.note = 'c3';
      dough(value, ac.currentTime + 0.05, 0.5);
      return true;
    } catch { return false; }
  }

  // Register an external sample pack into Strudel at runtime — used by the
  // sequencer's one-click GitHub loader. `arg` is whatever Strudel's samples()
  // accepts: a `github:user/repo` shorthand or a strudel.json URL. Ensures the
  // bundle is loaded and `samples()` exists first. Returns true on success.
  async function loadSamplesSpec(arg) {
    try { await loadStrudelScript(); } catch {}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 60 && typeof globalThis.samples !== 'function'; i++) await sleep(150);
    if (typeof globalThis.samples !== 'function') return false;
    try { await globalThis.samples(arg); return true; }
    catch (e) { console.warn('[qualia] load samples spec failed:', e); return false; }
  }

  return {
    open,
    close,
    stopPlayback,
    /** Register an external pack (github: shorthand or strudel.json URL). */
    loadSamplesSpec,
    play,
    stop,
    isPlaying: () => isPlayingFlag,
    isOpen: () => panel?.style.display !== 'none',
    hasBeenOpened: () => _everOpened,
    isMuted: () => _strudelMuted,
    setMuted,
    // Mixer surface — level/limiter control + change subscription.
    setVolume,
    getVolume: () => _strudelVolume,
    setLimiter,
    getLimiter,
    onChange,
    /** Inner StrudelMirror handle — null until the editor mounts. */
    getEditor,
    /** Inner scheduler (`StrudelMirror.repl.scheduler`) — null until
     *  the editor mounts AND has produced a runtime. */
    getScheduler,
    /** Cycle-clock probes for sequencer phase alignment. */
    getSecondsUntilNextStrudelBoundary,
    /** Absolute audible cycle position {pos, cps} — for multi-cycle phase-lock. */
    getStrudelCyclePos: getStrudelAudibleCyclePos,
    reanchorEpoch,
    /** True once the scheduler has a fresh anchor since the current play —
     *  the sequencer waits on this to auto-realign a fresh sync-play. */
    isSchedulerFresh: isSchedulerFreshSincePlay,
    /** Strudel's live cps (cycles/sec). The sequencer adopts this on realign
     *  so both clocks share a tempo — phase-lock needs matching rates. */
    getStrudelCps: () => readSchedulerCps(),
    /** Cyclist lookahead (seconds). Higher = fewer dropouts under main-thread
     *  load, slightly more play→sound delay. Re-run seq realign after change. */
    setStrudelLatency,
    getStrudelLatency,
    /** Disable the editor's per-frame highlight + flash (perf while open). */
    setEditorPerf,
    getEditorPerf,
    setLineNumbers,
    getLineNumbers,
    /** Editor font size (px) — header slider; double-click resets. */
    setFontSize,
    getFontSize,
    /** Built-in Strudel intellisense (autocomplete + hover docs) toggle. */
    setAutocomplete,
    getAutocomplete,
    /** Insert text at the editor cursor — used by the funcs/sounds panels. */
    insertAtCursor,
    /** Snapshot of currently-registered Strudel sounds for the browser tab. */
    listSounds,
    /** Audition a sound by name without touching the editor/scheduler. */
    previewSound,
    /** Call from the render loop so globalThis.a.fft stays current. */
    perFrame: refreshAFft,
    patterns: {
      list:     listPatterns,
      add:      saveCurrentToList,
      update:   updatePattern,
      remove:   removePattern,
      clone:    clonePatternEntry,
      download: downloadPatternEntry,
      load:     loadPatternEntry,
      newBlank: newBlankPattern,
      random:   newRandomPattern,
      getCurrentTitle,
      setTitle,
      onTitleChange: (cb) => {
        if (typeof cb !== 'function') return () => {};
        _titleListeners.add(cb);
        return () => _titleListeners.delete(cb);
      },
      getCurrentCode: readEditorCode,
      // Load arbitrary code into the editor — used by the qualem
      // state-saving system to recall a snapshot's strudel pattern. Same
      // play-through behavior as newBlank/random (re-evaluates if was
      // playing).
      loadCode,
      meta:     parseMetadata,
      displayName: patternDisplayName,
    },
  };
}
