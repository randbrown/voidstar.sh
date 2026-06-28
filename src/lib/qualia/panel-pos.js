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

/**
 * Wire a floating panel for drag-to-move (header grip) + viewport clamping +
 * topbar-aware reposition + position persistence. This is the block that was
 * inlined verbatim in the mixer / sequencer / vocoder / strudel panels. The
 * drag grip is the element with id `${id}-header`.
 *
 * Returns the `reposition` fn — panels call it from their open() so the panel
 * tucks under the (flex-wrapping) topbar each time it's shown.
 *
 * @param {string} id      persistence id, and `${id}-header` for the grip
 * @param {HTMLElement} panel
 * @returns {() => void}   reposition
 */
export function makeDraggablePanel(id, panel) {
  let movedByUser = restorePanelPos(id, panel);

  function reposition() {
    if (!panel || panel.style.display === 'none') return;
    const tb = document.getElementById('topbar');
    if (!tb) return;
    const h = tb.getBoundingClientRect().height;
    panel.style.maxHeight = `calc(100vh - ${h + 24}px)`;
    if (!movedByUser) panel.style.top = (h + 8) + 'px';
  }
  window.addEventListener('resize', reposition);
  // The topbar uses flex-wrap, so its rendered height changes when buttons wrap
  // to a second row — that doesn't fire `resize`. Watch the topbar itself.
  const topbarEl = document.getElementById('topbar');
  if (topbarEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reposition).observe(topbarEl);
  }

  // Drag-to-move via the header (pointer events handle mouse + touch).
  const header = document.getElementById(`${id}-header`);
  if (header && panel) {
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
      savePanelPos(id, panel);
      try { header.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  }

  // Persist position/size when the user resizes via CSS `resize: both`.
  if (panel && typeof ResizeObserver !== 'undefined') {
    let _rDebounce = 0;
    new ResizeObserver(() => {
      if (!movedByUser && !panel.style.width) return;
      clearTimeout(_rDebounce);
      _rDebounce = setTimeout(() => savePanelPos(id, panel), 300);
    }).observe(panel);
  }

  return reposition;
}
