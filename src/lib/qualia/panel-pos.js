// Tiny utility for persisting floating-panel positions (left, top, width,
// height) across page reloads.  Each panel passes a short id ('strudel',
// 'sequencer', etc.) — the key lands under the voidstar.qualia.panelPos
// namespace so it sits alongside the other per-panel localStorage keys.

import { getJSON, setJSON, removeRaw } from './prefs.js';

const NS = 'voidstar.qualia.panelPos';

export function savePanelPos(id, panel) {
  if (!panel) return;
  const data = { left: panel.style.left, top: panel.style.top };
  // Only persist width/height when the user has explicitly resized
  // (panels use CSS `resize: both` — the browser writes to style.*).
  if (panel.style.width)  data.width  = panel.style.width;
  if (panel.style.height) data.height = panel.style.height;
  setJSON(`${NS}.${id}`, data);
}

export function restorePanelPos(id, panel) {
  if (!panel) return false;
  const d = getJSON(`${NS}.${id}`, null);
  if (!d || (!d.left && !d.top)) return false;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = parseFloat(d.left) || 0;
  const top  = parseFloat(d.top)  || 0;
  const w = parseFloat(d.width)  || 360;
  const h = parseFloat(d.height) || 260;

  // At least 60px of the panel must be visible in the viewport —
  // otherwise discard the saved position and fall back to defaults.
  const MIN_VIS = 60;
  if (left + MIN_VIS > vw || top + MIN_VIS > vh || left + w < MIN_VIS || top < -20) {
    removeRaw(`${NS}.${id}`);
    return false;
  }

  panel.style.transform = 'none';
  if (d.left) panel.style.left = d.left;
  if (d.top)  panel.style.top  = d.top;
  if (d.width)  panel.style.width  = d.width;
  if (d.height) panel.style.height = d.height;
  return true;
}

export function clearPanelPos(id) {
  removeRaw(`${NS}.${id}`);
}
