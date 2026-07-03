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
// Non-interactive by design (pointer-events: none) — it's a projection for
// the room, not a control for the performer.

import { getPinnedRoom, readRoomFromQuery, buildJoinUrl } from './entangle-protocol.js';

const STYLE_ID = 'qr-interject-style';
const CSS = `
#qr-interject{position:fixed;right:max(1rem,env(safe-area-inset-right));
  bottom:max(1rem,env(safe-area-inset-bottom));z-index:19;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;gap:.5rem;
  padding:.9rem .9rem .7rem;border-radius:.9rem;
  background:rgba(7,7,16,.82);border:1px solid var(--accent,#8b5cf6);
  box-shadow:0 0 2rem rgba(139,92,246,.35);
  opacity:0;transform:translateY(.5rem) scale(.98);
  transition:opacity .8s ease,transform .8s ease}
#qr-interject.visible{opacity:1;transform:none}
#qr-interject canvas{display:block;border-radius:.5rem}
#qr-interject .qri-cap{font:600 13px/1.3 ui-monospace,monospace;color:var(--cyan,#22d3ee);
  letter-spacing:.06em;text-align:center;max-width:16rem}
#qr-interject .qri-url{font:400 11px/1.3 ui-monospace,monospace;color:var(--muted,#9b96c4);
  text-align:center;word-break:break-all;max-width:16rem}
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
  const canvas = document.createElement('canvas');
  const cap = document.createElement('div'); cap.className = 'qri-cap';
  const url = document.createElement('div'); url.className = 'qri-url';
  el.append(canvas, cap, url);
  document.body.appendChild(el);

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
