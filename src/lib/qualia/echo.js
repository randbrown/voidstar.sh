// API echo ("training mode") — a virtual console strip at the bottom of the
// stage that prints the `qualia.*` expression equivalent to each UI action
// as the performer makes it: move a slider → `qualia.set('thickness', 0.72)`,
// switch the quale → `qualia.quale('no_mans_land_2')`, toggle the walk →
// `qualia.cam.walk(true)`.
//
// Why: every UI control already routes through the same setters as the code
// API, but the PROGRAMMATIC names (quale ids, param ids, preset names) are
// invisible from the chrome. The echo makes the id ↔ control mapping
// learnable by doing — the console shows exactly what to type in Strudel or
// the JS console to reproduce the gesture, in copy-pasteable form (click a
// line to copy it). Values are formatted the way the docs teach them:
// single-quoted strings (imperative), numbers rounded.
//
// Cost model: everything is behind the enabled flag (default off, persisted);
// disabled, log() is a boolean check. Enabled, a slider drag coalesces into
// ONE re-textContent per event via per-key line reuse — no layout churn, no
// per-frame work, nothing on the render/audio paths.

import { getBool, setBool } from './prefs.js';

const KEY = 'voidstar.qualia.echo';
const MAX_LINES = 3;
const IDLE_FADE_MS = 8000;   // strip dims after a quiet spell

/** Format a JS value the way the docs write it: numbers rounded to ≤3
 *  decimals, strings single-quoted, booleans/others literal. */
export function fmtVal(v) {
  if (typeof v === 'number') {
    const r = Math.round(v * 1000) / 1000;
    return String(r);
  }
  if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
  return String(v);
}

export function createEcho() {
  const strip = document.getElementById('api-echo');
  let enabled = getBool(KEY, false);
  /** @type {{key: string, el: HTMLElement}[]} newest last */
  const lines = [];
  let fadeT = null;

  function applyVisibility() {
    if (strip) strip.style.display = enabled && lines.length ? '' : 'none';
  }

  function poke() {
    if (!strip) return;
    strip.classList.remove('idle');
    if (fadeT) clearTimeout(fadeT);
    fadeT = setTimeout(() => strip.classList.add('idle'), IDLE_FADE_MS);
  }

  /**
   * Print one expression. `key` groups successive updates of the same
   * control (e.g. a slider drag) into a single line that updates in place;
   * defaults to the function path (text before the first paren).
   */
  function log(expr, key) {
    if (!enabled || !strip) return;
    const k = key || expr.slice(0, expr.indexOf('(') + 1 || expr.length);
    const last = lines[lines.length - 1];
    if (last && last.key === k) {
      last.el.textContent = expr;
    } else {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'api-echo-line';
      el.title = 'click to copy';
      el.textContent = expr;
      el.addEventListener('click', () => {
        try { navigator.clipboard?.writeText(el.textContent || ''); } catch {}
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 600);
      });
      strip.appendChild(el);
      lines.push({ key: k, el });
      while (lines.length > MAX_LINES) {
        const dead = lines.shift();
        dead.el.remove();
      }
    }
    applyVisibility();
    poke();
  }

  function setEnabled(on) {
    enabled = !!on;
    setBool(KEY, enabled);
    if (enabled) log("qualia.echo(true)  // training mode — UI actions echo their API call");
    else {
      for (const l of lines) l.el.remove();
      lines.length = 0;
    }
    applyVisibility();
    return enabled;
  }

  applyVisibility();
  return { log, setEnabled, isEnabled: () => enabled };
}
