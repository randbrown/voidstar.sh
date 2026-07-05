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
  // (the corner/edge handles below write to style.*).
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

// ── any-corner / any-edge resize ────────────────────────────────────────────
// Panels used to rely on CSS `resize: both`, which only gives the browser's
// bottom-right grip — awkward when that corner sits off the bottom of the
// screen. This injects four corner + four edge handles (pointer events, so
// mouse + touch) that resize from any side, keeping the *opposite* edge
// anchored. Corner hit targets are deliberately large (14px) so they're easy
// to grab mid-set.
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const RESIZE_CURSORS = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};
const CORNER_PX = 14;   // corner handle size (square)
const EDGE_PX   = 6;    // edge strip thickness
const VP_PAD    = 4;    // keep this many px of the panel inside the viewport

/**
 * Attach custom resize handles to a floating panel.
 *
 * @param {string} id       persistence id (same one used by savePanelPos)
 * @param {HTMLElement} panel
 * @param {{ onStart?: () => void }} [hooks]  onStart fires on the first
 *        pointerdown of every resize, BEFORE any geometry changes — callers
 *        use it to materialize a still-centered panel (transform → left/top)
 *        and flip their movedByUser flag, exactly like drag-start does.
 */
export function attachPanelResize(id, panel, hooks = {}) {
  if (!panel || panel.__vsResize) return;
  panel.__vsResize = true;

  for (const dir of RESIZE_DIRS) {
    const h = document.createElement('div');
    h.className = `panel-resize panel-resize-${dir}`;
    const s = h.style;
    s.position = 'absolute';
    s.zIndex = '40';
    s.cursor = RESIZE_CURSORS[dir];
    s.touchAction = 'none';
    s.background = 'transparent';
    const corner = dir.length === 2;
    const px = (corner ? CORNER_PX : EDGE_PX) + 'px';
    if (dir.includes('n')) s.top = '0'; else if (dir.includes('s')) s.bottom = '0';
    if (dir.includes('w')) s.left = '0'; else if (dir.includes('e')) s.right = '0';
    if (corner) { s.width = px; s.height = px; }
    else if (dir === 'n' || dir === 's') { s.left = CORNER_PX + 'px'; s.right = CORNER_PX + 'px'; s.height = px; }
    else { s.top = CORNER_PX + 'px'; s.bottom = CORNER_PX + 'px'; s.width = px; }

    let active = null;   // { pid, x0, y0, rect, minW, minH }
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      hooks.onStart?.();
      // Belt & braces: if the panel is still centered via transform (no
      // caller hook materialized it), pin it now so left/top anchors are real.
      if (!panel.style.left) {
        const r0 = panel.getBoundingClientRect();
        panel.style.transform = 'none';
        panel.style.left = r0.left + 'px';
        panel.style.top  = r0.top + 'px';
      }
      const cs = getComputedStyle(panel);
      active = {
        pid: e.pointerId, x0: e.clientX, y0: e.clientY,
        rect: panel.getBoundingClientRect(),
        minW: parseFloat(cs.minWidth) || 120,
        minH: parseFloat(cs.minHeight) || 80,
      };
      try { h.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault(); e.stopPropagation();
    });
    h.addEventListener('pointermove', (e) => {
      if (!active || e.pointerId !== active.pid) return;
      const { rect, minW, minH } = active;
      const dx = e.clientX - active.x0;
      const dy = e.clientY - active.y0;
      if (dir.includes('e')) {
        const w = Math.min(Math.max(minW, rect.width + dx), window.innerWidth - rect.left - VP_PAD);
        panel.style.width = w + 'px';
      } else if (dir.includes('w')) {
        const w = Math.min(Math.max(minW, rect.width - dx), rect.right - VP_PAD);
        panel.style.width = w + 'px';
        // Anchor the RIGHT edge — re-read the rect so any CSS max-* clamp
        // can't make left drift away from the real rendered width.
        panel.style.left = (rect.right - panel.getBoundingClientRect().width) + 'px';
      }
      if (dir.includes('s')) {
        const hgt = Math.min(Math.max(minH, rect.height + dy), window.innerHeight - rect.top - VP_PAD);
        panel.style.height = hgt + 'px';
      } else if (dir.includes('n')) {
        const hgt = Math.min(Math.max(minH, rect.height - dy), rect.bottom - VP_PAD);
        panel.style.height = hgt + 'px';
        // Anchor the BOTTOM edge (same rationale as the left-edge case).
        panel.style.top = (rect.bottom - panel.getBoundingClientRect().height) + 'px';
      }
    });
    const end = (e) => {
      if (!active || e.pointerId !== active.pid) return;
      active = null;
      savePanelPos(id, panel);
      try { h.releasePointerCapture(e.pointerId); } catch {}
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    panel.appendChild(h);
  }
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

  // Any-corner/edge resize handles. On resize-start, materialize a
  // still-centered panel to concrete left/top (same as drag-start) so the
  // anchored-edge math works, and mark it user-moved so reposition() stops
  // re-centering it.
  if (panel) {
    attachPanelResize(id, panel, { onStart: () => {
      if (movedByUser) return;
      const r = panel.getBoundingClientRect();
      panel.style.transform = 'none';
      panel.style.left = r.left + 'px';
      panel.style.top  = r.top + 'px';
      movedByUser = true;
    } });
  }

  // Persist size changes that don't come from the handles' own pointerup
  // (e.g. content-driven or script-driven size shifts after a user resize).
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
