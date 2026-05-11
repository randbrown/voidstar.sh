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

export function createStrudelHydra({ audio, getField, setParam, scopeCanvas, onPlayStateChange } = {}) {
  // Snapshot the previous-session panel state ONCE at init. open()/close()
  // mutate the flag for next time, but the answer to "should we restore the
  // last pattern?" is based on what the user did before this page load —
  // re-reading after a within-session open() would always see '1'.
  const wasOpenLastSession = loadPanelOpen();

  const panel  = document.getElementById('strudel-panel');
  const mount  = document.getElementById('strudel-mount');
  const status = document.getElementById('strudel-status');
  const btnToggle = document.getElementById('btn-strudel');
  const btnClose  = document.getElementById('btn-strudel-close');
  const btnPlay    = document.getElementById('btn-strudel-play');
  const btnStop    = document.getElementById('btn-strudel-stop');
  const btnMute    = document.getElementById('btn-strudel-mute');
  const btnNewline = document.getElementById('btn-strudel-newline');

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

  // Paint the topbar `strudel` button from current state — panel open
  // and audio adoption are independent now (panel can be hidden while
  // Strudel keeps playing into the analyser), so the label has to
  // consult both. Earlier the text was mutated from open()/close()/
  // tapMaster() in three places and could disagree with itself.
  function refreshStrudelBtn() {
    if (!btnToggle) return;
    btnToggle.classList.remove('active', 'active-audio');
    const live    = audio.hasSource('strudel');
    const open    = panel?.style.display !== 'none';
    if (live) {
      btnToggle.classList.add('active-audio');
      btnToggle.textContent = 'strudel ●';
    } else if (open) {
      btnToggle.classList.add('active');
      btnToggle.textContent = 'strudel on';
    } else {
      btnToggle.textContent = 'strudel';
    }
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
  function emitPlayState(playing) {
    if (_suppressPlayStateChange) return;
    try { onPlayStateChange?.(!!playing); } catch {}
  }
  function play(opts = {}) {
    const ed = getEditor();
    if (!ed) return false;
    ensureEvalPatch();
    const wasSuppressing = _suppressPlayStateChange;
    if (opts.fromSync) _suppressPlayStateChange = true;
    try {
      if      (typeof ed.evaluate === 'function') ed.evaluate();
      else if (typeof ed.toggle   === 'function') ed.toggle();
      else return false;
      isPlayingFlag = true;
      btnPlay?.classList.add('playing');
      // Strudel's AudioContext only spins up after the first play(); poll
      // until it's running and we can attach our analyser. Cheap to call
      // when we're already tapped — ensureTapPolling early-returns.
      ensureTapPolling();
      emitPlayState(true);
      return true;
    } catch (e) { console.warn('[qualia] strudel play failed:', e); return false; }
    finally { _suppressPlayStateChange = wasSuppressing; }
  }
  function stop(opts = {}) {
    const ed = getEditor();
    if (!ed) return false;
    ensureEvalPatch();
    const wasSuppressing = _suppressPlayStateChange;
    if (opts.fromSync) _suppressPlayStateChange = true;
    try {
      if (typeof ed.stop === 'function') ed.stop();
      else return false;
      isPlayingFlag = false;
      btnPlay?.classList.remove('playing');
      // Real stop — drop the analyser so the audio mode's `strudel`
      // filter doesn't keep showing the user a ghost source. Re-tap on
      // next play().
      audio.releaseAdopted();
      refreshStrudelBtn();
      emitPlayState(false);
      return true;
    } catch (e) { console.warn('[qualia] strudel stop failed:', e); return false; }
    finally { _suppressPlayStateChange = wasSuppressing; }
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
  let muteGate = null;
  function ensureMuteGate(ctx) {
    if (muteGate && muteGate.context === ctx) return muteGate;
    muteGate = ctx.createGain();
    muteGate.gain.value = _strudelMuted ? 0 : 1;
    // Self-bypass — muteGate's own connect to ctx.destination must not
    // recurse through the patch.
    muteGate.__qualiaBypassMute = true;
    muteGate.connect(ctx.destination);
    return muteGate;
  }
  function setMuted(on) {
    _strudelMuted = !!on;
    if (muteGate) {
      try {
        const t = muteGate.context.currentTime;
        muteGate.gain.cancelScheduledValues(t);
        muteGate.gain.linearRampToValueAtTime(_strudelMuted ? 0 : 1, t + 0.04);
      } catch {
        try { muteGate.gain.value = _strudelMuted ? 0 : 1; } catch {}
      }
    }
    // Belt + braces: also flip Tone.Destination.mute for any audio that
    // DOES route through Strudel's bundled Tone.Destination (Sampler /
    // Player nodes do). Costs nothing if it's already a no-op.
    try {
      const dest = globalThis.getDestination?.();
      if (dest) dest.mute = _strudelMuted;
    } catch {}
    refreshMuteBtn();
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
      try { if (typeof ed.stop === 'function') ed.stop(); } catch {}
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
      an.smoothingTimeConstant = 0.72;
      // The connect-patch is now the *primary* path (was: fallback). It
      // does two things at once: tees to our analyser AND routes through
      // muteGate so setMuted() can actually silence Strudel. Tone's
      // bundled-destination tap (`dest.connect(an)`) used to feed the
      // analyser but missed superdough's direct ctx.destination writes
      // — and crucially had no node we could mute. Going through the
      // monkey-patch covers both source paths.
      if (!_strudelConnectPatched) {
        const orig = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function(target, ...rest) {
          if (target === ctx.destination && !this.__qualiaBypassMute) {
            try { orig.call(this, an); } catch {}
            return orig.call(this, ensureMuteGate(ctx), ...rest);
          }
          return orig.call(this, target, ...rest);
        };
        _strudelConnectPatched = true;
      }
      // Materialise the gate up front so it exists before any pre-patch
      // node connects (and so setMuted() has a target if the user toggles
      // before Strudel plays its first eval).
      ensureMuteGate(ctx);
      strudelAnalyser = an;
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
    // Mic and Strudel run side-by-side now — each owns its own analyser
    // and the audio module merges per-band readings every tick. Opening
    // Strudel must NOT stop the mic; if reopening with our analyser
    // already adopted, this is a no-op for audio.
    if (panel) panel.style.display = '';
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

  // Insert a newline at the cursor — Android touch keyboards (GBoard
  // especially) drop the keydown event for Enter inside a contenteditable
  // nested in a Shadow DOM, which is exactly what strudel-editor is. We
  // try a chain of insertion paths so this works across CodeMirror
  // versions exposed by different @strudel/repl builds, then fall back to
  // a synthetic keydown which the editor's keymap treats like a real
  // Enter press. Intentionally idempotent: clicking when the editor isn't
  // mounted is a no-op.
  function insertNewlineAtCursor() {
    const ed = editorEl;
    if (!ed) return false;

    // Path 1: CodeMirror 6 EditorView exposed as ed.editor.editor (the
    // Strudel REPL wraps the underlying CM view one level deep).
    try {
      const view = ed.editor?.editor || ed.editor;
      if (view && view.state && typeof view.dispatch === 'function') {
        view.focus?.();
        view.dispatch(view.state.replaceSelection('\n'));
        return true;
      }
    } catch {}

    // Path 2: synthetic keydown on the .cm-content node inside the
    // shadow root. CodeMirror's keymap responds to this even when the
    // OS-level keyboard never fires the original event.
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

    return false;
  }
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

  return {
    open,
    close,
    stopPlayback,
    play,
    stop,
    isPlaying: () => isPlayingFlag,
    isOpen: () => panel?.style.display !== 'none',
    isMuted: () => _strudelMuted,
    setMuted,
    /** Inner StrudelMirror handle — null until the editor mounts. */
    getEditor,
    /** Inner scheduler (`StrudelMirror.repl.scheduler`) — null until
     *  the editor mounts AND has produced a runtime. */
    getScheduler,
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
