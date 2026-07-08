// Shared DOM helpers for mind views — forked from setlist/views.js so the
// two apps stay independent.

import { navigate } from './app.js';

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// Minimal HTML escape for interpolating user/external strings into innerHTML.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function btn(label, cls, onclick) {
  const b = el('button', `mn-btn ${cls || ''}`, label);
  if (onclick) b.addEventListener('click', onclick);
  return b;
}

export function topBar(title, backHash, actions = []) {
  const bar = el('div', 'mn-topbar');
  if (backHash) bar.appendChild(btn('&larr;', 'mn-btn-icon', () => navigate(backHash)));
  bar.appendChild(el('span', 'mn-topbar-title', title));
  if (actions.length) {
    const wrap = el('div', 'mn-actions');
    for (const a of actions) wrap.appendChild(a);
    bar.appendChild(wrap);
  }
  return bar;
}

export function emptyState(msg) {
  return el('div', 'mn-empty', msg);
}

// "3m ago" / "2h ago" / "Jul 8" — compact recency for the note list.
export function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

// Simple modal prompt (used for rename) — a native prompt() loses focus
// context on mobile PWAs and can't prefill+select nicely.
export function textPrompt({ title, value = '', placeholder = '', onOk }) {
  const overlay = el('div', 'mn-modal-overlay');
  const box = el('div', 'mn-modal');
  box.appendChild(el('div', 'mn-modal-title', esc(title)));
  const input = el('input', 'mn-input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  box.appendChild(input);
  const row = el('div', 'mn-modal-row');
  const cancel = btn('cancel', '', () => overlay.remove());
  const ok = btn('ok', 'mn-btn-primary', () => { overlay.remove(); onOk(input.value.trim()); });
  row.appendChild(cancel);
  row.appendChild(ok);
  box.appendChild(row);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
    if (e.key === 'Escape') overlay.remove();
  });
  document.body.appendChild(overlay);
  input.focus();
  input.select();
  return overlay;
}

export function confirmBox(msg, onYes) {
  if (window.confirm(msg)) onYes();
}
