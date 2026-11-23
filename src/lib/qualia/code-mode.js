// Live-coding mode — `qualia.code(true)` / `qualia.livecode(true)` / the
// topbar "code" button / ⇧L.
//
// Strips the stage down to a blank canvas for writing code in front of the
// audience: auto-cycle + auto-phase off, every post fx off, every overlay
// layer off, cam walk + logo off, and the null quale. Entering snapshots the
// value of each of those first; exiting puts them back.
//
// Restore rule: a control is put back only if it still holds the value code
// mode gave it. Anything the performer changed while in code mode (a
// `quale("fractal")` from Strudel, a post toggled on by hand) is theirs and is
// kept — the exit just notes it.
//
// Each change is echoed as the exact `qualia.*` call that makes it, as one
// block on the api-echo strip (shown even with training mode off), so the
// audience sees what is switching off and on, and the performer can copy a
// line to bring one thing back.
//
// The snapshot is persisted (localStorage) so a reload mid-set still knows it
// is in code mode and can restore. Nothing here runs per frame.

const KEY = 'voidstar.qualia.codeMode';

/**
 * @typedef {Object} CodeModeControl
 * @property {string} key            stable id in the snapshot
 * @property {string} label          short name for the "kept" note
 * @property {() => any} get         current value
 * @property {(v: any) => void} set  write a value
 * @property {any} off               the code-mode value
 * @property {(v: any) => string} expr  the qualia.* call that sets v
 */

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && s.active && s.snap && typeof s.snap === 'object' ? s : null;
  } catch { return null; }
}
function saveState(s) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {}
}

/**
 * @param {Object} opts
 * @param {CodeModeControl[]} opts.controls  in ENTER order (timers first, quale
 *   last); exit walks them in reverse so timers come back last.
 * @param {(lines: string[]) => void} [opts.show]  print the block of calls
 * @param {(active: boolean) => void} [opts.onChange]
 */
export function createCodeMode({ controls, show = () => {}, onChange = () => {} }) {
  let state = loadState();   // { active: true, snap: { key: value } } | null

  function enter() {
    if (state) return true;
    const snap = {};
    const lines = ['qualia.code(true)  // live coding mode'];
    for (const c of controls) {
      let v;
      try { v = c.get(); } catch { continue; }
      snap[c.key] = v;
      if (same(v, c.off)) continue;
      try { c.set(c.off); lines.push(c.expr(c.off)); }
      catch (e) { console.warn(`[qualia] code mode: couldn't switch off ${c.key}`, e); }
    }
    if (lines.length === 1) lines.push('// already bare: nothing to switch off');
    state = { active: true, snap, at: Date.now() };
    saveState(state);
    show(lines);
    onChange(true);
    return true;
  }

  function exit() {
    if (!state) return false;
    const { snap } = state;
    const lines = ['qualia.code(false)  // restore the scene'];
    const kept = [];
    for (const c of [...controls].reverse()) {
      if (!(c.key in snap)) continue;
      const was = snap[c.key];
      if (same(was, c.off)) continue;   // it was already off: nothing to restore
      let now;
      try { now = c.get(); } catch { continue; }
      if (same(now, was)) continue;     // already back where it was
      if (!same(now, c.off)) { kept.push(c.label); continue; }   // changed in code mode: keep it
      try { c.set(was); lines.push(c.expr(was)); }
      catch (e) { console.warn(`[qualia] code mode: couldn't restore ${c.key}`, e); }
    }
    if (kept.length) lines.push(`// kept your changes: ${kept.join(', ')}`);
    if (lines.length === 1) lines.push('// nothing to restore');
    state = null;
    saveState(null);
    show(lines);
    onChange(false);
    return false;
  }

  return {
    isActive: () => !!state,
    /** set(true) enters, set(false) exits; returns the new state. */
    set: (on) => (on ? enter() : exit()),
    toggle: () => (state ? exit() : enter()),
    /** The saved values (read-only copy), or null outside code mode. */
    snapshot: () => (state ? { ...state.snap } : null),
  };
}
