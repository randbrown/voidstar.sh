// QR interject — the periodic scan-to-join overlay chron can surface mid-set.
//
// Self-mounting (like entangle-ui / overlay): page-init calls
// initQRInterject(...) once; this builds a fixed corner card (artistic
// voidstar QR + a one-line caption), kept display:none until show(). Chron's
// onQRMark drives the cadence; the chron card's "show now" button and the
// entanglement workflow can call show() directly too.
//
// Target resolution happens AT FIRE TIME, not config time:
//   'entangle' — the live join URL when the field is open, else the printed
//                performance code (?room= / pinned), else nothing (skipped —
//                an entangle QR with no code behind it would strand scanners)
//   'qualia'   — the site workstation URL
//   'auto'     — entangle when a code resolves, site otherwise
//
// The card sits BELOW the control panels in z-order (z-index 17, under the
// panel band at 18/19) so an interjection never traps a panel toggle out of
// reach. It's a light-touch control too: a grip bar drags it, any corner or
// edge resizes it (shared panel-pos.js handles), a × dismisses it, and
// position/size persist across reloads under the shared panelPos namespace.

import { getPinnedRoom, readRoomFromQuery, buildJoinUrl } from './entangle-protocol.js';
import { savePanelPos, restorePanelPos, attachPanelResize } from './panel-pos.js';

const STYLE_ID = 'qr-interject-style';
const POS_ID = 'qr-interject';   // panelPos persistence key + `${POS_ID}-grip`
const CSS = `
#qr-interject{position:fixed;right:max(1rem,env(safe-area-inset-right));
  bottom:max(1rem,env(safe-area-inset-bottom));z-index:17;
  display:flex;flex-direction:column;align-items:stretch;gap:.4rem;
  padding:.35rem .9rem .7rem;border-radius:.9rem;
  background:rgba(7,7,16,.82);border:1px solid var(--accent,#8b5cf6);
  box-shadow:0 0 2rem rgba(139,92,246,.35);
  overflow:hidden;
  min-width:180px;min-height:180px;max-width:96vw;max-height:96vh;
  opacity:0;transition:opacity .8s ease}
#qr-interject.visible{opacity:1}
#qr-interject-grip{display:flex;align-items:center;justify-content:space-between;
  gap:.5rem;margin:0 -.4rem;padding:.1rem .4rem;
  cursor:grab;user-select:none;touch-action:none}
#qr-interject-grip.dragging{cursor:grabbing}
#qr-interject-grip .qri-dots{font:600 12px/1 ui-monospace,monospace;
  color:var(--muted,#9b96c4);letter-spacing:.18em}
#qr-interject-grip .qri-close{background:none;border:0;cursor:pointer;
  color:var(--muted,#9b96c4);font:600 16px/1 ui-monospace,monospace;
  padding:.05rem .3rem;border-radius:.3rem}
#qr-interject-grip .qri-close:hover{color:var(--cyan,#22d3ee)}
#qr-interject canvas{display:block;border-radius:.5rem;
  width:100%;height:auto;max-width:100%;align-self:center}
#qr-interject .qri-cap{font:600 13px/1.3 ui-monospace,monospace;color:var(--cyan,#22d3ee);
  letter-spacing:.06em;text-align:center;max-width:16rem;align-self:center}
#qr-interject .qri-url{font:400 11px/1.3 ui-monospace,monospace;color:var(--muted,#9b96c4);
  text-align:center;word-break:break-all;max-width:16rem;align-self:center}
`;

/**
 * @param {object} opts
 * @param {() => object|null} opts.getEntangle  live engine handle (may be
 *        null before boot finishes or if entangle init failed — the printed
 *        code + site fallbacks still work)
 * @param {number} [opts.size]  QR edge in CSS px
 */
export function initQRInterject({ getEntangle = () => null, size = 240 } = {}) {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }

  const el = document.createElement('div');
  el.id = 'qr-interject';
  el.setAttribute('aria-hidden', 'true');
  el.style.display = 'none';

  // Grip bar: the drag handle plus a × to dismiss (handy on mobile, where the
  // card previously covered the very panel toggle you'd reach for to hide it).
  const grip = document.createElement('div');
  grip.id = `${POS_ID}-grip`;
  const dots = document.createElement('span'); dots.className = 'qri-dots'; dots.textContent = '⠿ qr';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button'; closeBtn.className = 'qri-close';
  closeBtn.setAttribute('aria-label', 'dismiss QR'); closeBtn.textContent = '×';
  grip.append(dots, closeBtn);

  const canvas = document.createElement('canvas');
  const cap = document.createElement('div'); cap.className = 'qri-cap';
  const url = document.createElement('div'); url.className = 'qri-url';
  el.append(grip, canvas, cap, url);
  document.body.appendChild(el);

  // ── Movable + resizable, with persisted position/size ──────────────────────
  // The card defaults to the bottom-right corner (CSS right/bottom). The first
  // drag or resize "unpins" it to left/top coordinates so both gestures track
  // the pointer; position and size then persist under the panelPos namespace.
  let unpinned = false;
  function unpin() {
    if (unpinned) return;
    const r = el.getBoundingClientRect();
    el.style.left = r.left + 'px';
    el.style.top  = r.top  + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    unpinned = true;
  }
  // Restore a saved position/size (this switches the card to left/top anchoring).
  if (restorePanelPos(POS_ID, el)) {
    el.style.right = 'auto'; el.style.bottom = 'auto';
    unpinned = true;
  }
  // Convert to left/top BEFORE any resize gesture begins, so the anchored-edge
  // math in the shared corner/edge handles tracks the pointer.
  el.addEventListener('pointerdown', () => unpin(), true);
  attachPanelResize(POS_ID, el, { onStart: unpin });

  closeBtn.addEventListener('click', () => hide());

  // Drag-to-move via the grip (pointer events cover mouse + touch).
  {
    let dragging = false, dx = 0, dy = 0, pid = null;
    const VP_PAD = 4;
    grip.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (e.button !== undefined && e.button !== 0) return;
      unpin();
      const r = el.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      pid = e.pointerId; dragging = true;
      grip.classList.add('dragging');
      try { grip.setPointerCapture(pid); } catch {}
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pid) return;
      const r = el.getBoundingClientRect();
      const maxX = window.innerWidth  - r.width - VP_PAD;
      const maxY = window.innerHeight - 32;
      el.style.left = Math.min(Math.max(VP_PAD, e.clientX - dx), Math.max(VP_PAD, maxX)) + 'px';
      el.style.top  = Math.min(Math.max(VP_PAD, e.clientY - dy), Math.max(VP_PAD, maxY)) + 'px';
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      grip.classList.remove('dragging');
      savePanelPos(POS_ID, el);
      try { grip.releasePointerCapture(pid); } catch {}
      pid = null;
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  // Persist size changes not caught by the resize handles' own pointerup.
  // Ignore the content-driven sizing that happens before any user gesture.
  if (typeof ResizeObserver !== 'undefined') {
    let deb = 0;
    new ResizeObserver(() => {
      if (!unpinned && !el.style.width) return;
      clearTimeout(deb);
      deb = setTimeout(() => savePanelPos(POS_ID, el), 300);
    }).observe(el);
  }

  let hideT = null;
  let showToken = 0;

  function resolve(target) {
    const site = { url: `${location.origin}/qualia`, cap: '⊛ voidstar.sh — this instrument' };
    const ent = getEntangle();
    const room = (ent?.isOpen?.() && ent.getRoomId?.())
      || readRoomFromQuery() || getPinnedRoom();
    const join = room ? { url: buildJoinUrl(room), cap: '⊛ scan to entangle — bend the field' } : null;
    if (target === 'qualia') return site;
    if (target === 'entangle') return join;          // null → skip this firing
    return join || site;                             // 'auto'
  }

  /**
   * Fade the QR card in for `durationSec`. Resolves the target fresh each
   * call. Returns false if the target couldn't resolve (skipped).
   */
  async function show({ target = 'auto', duration = 25 } = {}) {
    const r = resolve(target);
    if (!r) return false;
    const token = ++showToken;
    try {
      const { renderArtisticQR } = await import('./qr.js');
      await renderArtisticQR(canvas, r.url, size);
      // renderArtisticQR pins inline px width/height; let CSS scale it with the
      // panel instead so a resize actually resizes the QR.
      canvas.style.width = '100%'; canvas.style.height = 'auto';
    } catch (err) {
      console.warn('[qr-interject] render failed', err);
      return false;
    }
    if (token !== showToken) return true;   // superseded by a newer show()
    cap.textContent = r.cap;
    url.textContent = r.url.replace(/^https?:\/\//, '');
    el.style.display = 'flex';
    // Next frame so the transition runs from the hidden state.
    requestAnimationFrame(() => el.classList.add('visible'));
    if (hideT) clearTimeout(hideT);
    hideT = setTimeout(hide, Math.max(5, duration) * 1000);
    return true;
  }

  function hide() {
    if (hideT) { clearTimeout(hideT); hideT = null; }
    el.classList.remove('visible');
    // Let the fade-out finish before dropping display (transition is .8s).
    setTimeout(() => { if (!el.classList.contains('visible')) el.style.display = 'none'; }, 900);
  }

  return { show, hide, isVisible: () => el.classList.contains('visible') };
}
