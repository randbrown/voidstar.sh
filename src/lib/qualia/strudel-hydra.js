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
  patternDisplayName, downloadPattern,
} from './patterns.js';

const STRUDEL_SCRIPT = 'https://unpkg.com/@strudel/repl@latest';

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
  return _strudelLoadingP;
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
export function createStrudelHydra({ audio, getField, setParam, scopeCanvas }) {
  const panel  = document.getElementById('strudel-panel');
  const mount  = document.getElementById('strudel-mount');
  const status = document.getElementById('strudel-status');
  const btnToggle = document.getElementById('btn-strudel');
  const btnClose  = document.getElementById('btn-strudel-close');
  const btnPlay   = document.getElementById('btn-strudel-play');
  const btnStop   = document.getElementById('btn-strudel-stop');

  let editorEl = null;
  let mounted  = false;
  let strudelAnalyser = null;
  let pollT = null;
  let tapped = false;
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

  // Strudel-editor's internal CodeMirror state is not exposed by a single
  // canonical API across versions. Try several access paths in order, ending
  // with a DOM scrape of the rendered .cm-line nodes.
  function readEditorCode() {
    const ed = editorEl;
    if (!ed) return null;
    try {
      if (typeof ed.code === 'string') return ed.code;
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
    } catch {}
    return null;
  }
  function persistCurrent() {
    const code = readEditorCode();
    if (code != null) saveCurrent(code);
    return code;
  }

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
        return orig(...args);
      };
    }
    if (typeof ed.stop === 'function') {
      const orig = ed.stop.bind(ed);
      ed.stop = function(...args) {
        try { clearHydraOutputs(); clearScopeCanvas(scopeCanvas); } catch {}
        try { persistCurrent(); } catch {}
        // Deliberately do NOT touch isPlayingFlag / btnPlay here.
        // Strudel's runtime calls this.stop() as part of evaluate() to
        // halt the previous pattern before scheduling the new one — if
        // we cleared the playing flag from this hook, every restart
        // would race with the user's intent. Our explicit play()/stop()
        // entrypoints are the source of truth.
        return orig(...args);
      };
    }
    _strudelEvalPatched = true;
    return true;
  }

  // Initial code: stored buffer if present, else a freshly-rolled random
  // pattern so the lab boots with something playable but novel each visit.
  function pickInitialCode() {
    const stored = loadCurrent();
    if (stored && stored.trim()) return stored;
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
    let tries = 0;
    const t = setInterval(() => {
      if (ensureEvalPatch() || ++tries > 40) clearInterval(t);
    }, 150);
    injectStrudelTransparency(ed);
    saveCurrent(code);
  }
  function loadCode(code) {
    if (typeof code !== 'string' || !code) return;
    // If the user was mid-playback when they swapped patterns, immediately
    // re-evaluate the new code on the freshly-mounted editor — keeps the
    // jam continuous instead of forcing a manual ▶ after every change.
    const wasPlaying = isPlayingFlag;
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

  function play() {
    const ed = getEditor();
    if (!ed) return false;
    ensureEvalPatch();
    try {
      if      (typeof ed.evaluate === 'function') ed.evaluate();
      else if (typeof ed.toggle   === 'function') ed.toggle();
      else return false;
      isPlayingFlag = true;
      btnPlay?.classList.add('playing');
      return true;
    } catch (e) { console.warn('[qualia] strudel play failed:', e); return false; }
  }
  function stop() {
    const ed = getEditor();
    if (!ed) return false;
    ensureEvalPatch();
    try {
      if (typeof ed.stop === 'function') ed.stop();
      else return false;
      isPlayingFlag = false;
      btnPlay?.classList.remove('playing');
      return true;
    } catch (e) { console.warn('[qualia] strudel stop failed:', e); return false; }
  }

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
      try { if (typeof ed.stop === 'function') ed.stop(); } catch {}
    }
    isPlayingFlag = false;
    btnPlay?.classList.remove('playing');
  }

  function tapMaster(ctx) {
    if (!strudelAnalyser) {
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.72;
      let didTap = false;
      try {
        if (typeof globalThis.getDestination === 'function') {
          const dest = globalThis.getDestination();
          if (dest && typeof dest.connect === 'function') {
            dest.connect(an);
            didTap = true;
          }
        }
      } catch {}
      if (!didTap && !_strudelConnectPatched) {
        // Fallback: tee any node connecting to ctx.destination into our analyser.
        const orig = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function(target, ...rest) {
          if (target === ctx.destination) { try { orig.call(this, an); } catch {} }
          return orig.call(this, target, ...rest);
        };
        _strudelConnectPatched = true;
      }
      strudelAnalyser = an;
    }
    tapped = true;
    audio.adoptAnalyser(ctx, strudelAnalyser);
    if (status) {
      status.textContent = 'audio: live';
      status.classList.add('live');
    }
    if (btnToggle) {
      btnToggle.classList.remove('active');
      btnToggle.classList.add('active-audio');
      btnToggle.textContent = 'strudel ●';
    }
    return true;
  }

  function pollForAudio() {
    if (pollT) return;
    const deadline = performance.now() + 12000;
    pollT = setInterval(() => {
      if (performance.now() > deadline) { clearInterval(pollT); pollT = null; return; }
      let ctx = null;
      try { ctx = globalThis.getAudioContext?.(); } catch {}
      if (!ctx || ctx.state !== 'running') return;
      if (tapMaster(ctx)) { clearInterval(pollT); pollT = null; }
    }, 200);
  }

  // Topbar can grow tall on narrow viewports — measure & pin the panel below it.
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
  // The topbar uses flex-wrap, so its rendered height changes when buttons
  // wrap to a second row — that doesn't fire `resize`. Watch the topbar
  // itself so the panel stays clear of it whenever the wrap point shifts.
  const topbarEl = document.getElementById('topbar');
  if (topbarEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reposition).observe(topbarEl);
  }

  // Drag-to-move via the header (pointer events handle mouse + touch).
  (() => {
    const header = document.getElementById('strudel-header');
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

  async function open() {
    // Mic and Strudel are mutually exclusive on the analyser — only stop
    // the MIC source. If we already adopted Strudel's analyser (source ===
    // 'strudel'), keep it; reopen is a no-op for audio.
    if (audio.getSource?.() === 'mic') await audio.stop();
    if (panel) panel.style.display = '';
    reposition();
    if (btnToggle) {
      btnToggle.classList.add('active');
      btnToggle.textContent = 'strudel on';
    }
    if (status) {
      status.textContent = 'loading…';
      status.classList.remove('live');
    }
    try { await loadStrudelScript(); }
    catch (err) {
      if (status) status.textContent = `error: ${err.message || err}`;
      return;
    }
    mountEditor();
    if (status) status.textContent = 'click ▶ in editor to start';
    pollForAudio();
  }

  function close() {
    // Deliberately *do not* stop Strudel playback here — closing the
    // panel is a "hide UI" action, and keeping the jam audible while the
    // editor is collapsed is intentional. Callers that need to actually
    // halt Strudel (e.g. switching the mic input) should call
    // stopPlayback() themselves before close().
    if (panel) panel.style.display = 'none';
    if (pollT) { clearInterval(pollT); pollT = null; }
    if (tapped) audio.releaseAdopted();
    tapped = false;
    if (btnToggle) {
      btnToggle.classList.remove('active-audio');
      btnToggle.classList.remove('active');
      btnToggle.textContent = 'strudel';
    }
    status?.classList.remove('live');
  }

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
    loadCode([
      '// @title untitled',
      '// @by you',
      '// @license CC0',
      '',
      'setcps(1)',
      'silence',
    ].join('\n'));
  }
  function newRandomPattern() {
    loadCode(randomPattern());
  }

  return {
    open,
    close,
    stopPlayback,
    isPlaying: () => isPlayingFlag,
    isOpen: () => panel?.style.display !== 'none',
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
      getCurrentCode: readEditorCode,
      meta:     parseMetadata,
      displayName: patternDisplayName,
    },
  };
}
