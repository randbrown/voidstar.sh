// Entanglement — participant client (runs on the audience member's phone).
//
// Loads NONE of the viz engine. It connects to the host's room, renders the
// controls the host's manifest advertises, and ships small messages:
//   • pose : the 8 derived feature floats, computed locally from the phone
//            camera via the SAME pose pipeline + normalization the host uses
//            (heavy ML stays on the phone), throttled, latest-wins.
//   • param: { id, value } from whitelisted sliders (debounced).
//   • vote : { fxId } for the visual the participant wants.
//
// Everything is best-effort and defensive: a dropped host, a denied camera, or
// a malformed manifest must never hard-crash the page.

import { createTransport } from './entangle-transport.js';
import { T, APP_ID, readRoomFromHash } from './entangle-protocol.js';
import { poseFeatures, packFeatures } from './pose-features.js';

const POSE_INTERVAL_MS = 66;     // ~15Hz upstream
const PARAM_DEBOUNCE_MS = 40;

export async function initEntangleClient(root) {
  const roomId = readRoomFromHash();
  const statusEl = root.querySelector('[data-status]');
  const controlsEl = root.querySelector('[data-controls]');
  const setStatus = (msg, kind = '') => { if (statusEl) { statusEl.textContent = msg; statusEl.dataset.kind = kind; } };

  if (!roomId) { setStatus('No room in this link — ask the performer for a fresh QR.', 'err'); return; }

  setStatus('Entangling…');
  let transport;
  try {
    transport = await createTransport({ appId: APP_ID, room: roomId });
  } catch (err) {
    console.error('[entangle] transport failed', err);
    setStatus('Could not connect. Check your network and reload.', 'err');
    return;
  }

  let manifest = { activeFx: null, fxList: [], modes: { pose: false, param: false, vote: false }, params: [] };
  let myVote = null;

  // Announce ourselves; re-announce whenever a (new) host appears.
  const hello = () => transport.send(T.HELLO, { name: '' });
  transport.onPeer(() => hello());
  hello();

  transport.on(T.MANIFEST, (m) => { if (m && typeof m === 'object') { manifest = m; renderControls(); } });
  transport.on(T.KICK, () => { teardown(); setStatus('The performance has ended. Thanks for entangling. ⊛', 'end'); });

  window.addEventListener('pagehide', () => { try { transport.send(T.BYE, 1); } catch {} });

  // ── Pose ──────────────────────────────────────────────────────────────────
  let pose = null, video = null, poseRAF = 0, lastSent = 0, poseOn = false;
  async function startPose(previewBox) {
    if (poseOn) return;
    poseOn = true;
    setStatus('Starting camera…');
    try {
      const { createPose } = await import('./pose.js');     // lazy: only when needed
      pose = createPose();
      pose.setDetectFps(20);
      video = document.createElement('video');
      video.playsInline = true; video.muted = true;
      video.style.cssText = 'width:100%;border-radius:.6rem;transform:scaleX(-1)';
      previewBox.innerHTML = ''; previewBox.appendChild(video);
      await pose.startCamera({ video, facing: 'user' });
      setStatus('Entangled — move and the field responds.', 'ok');
      const loop = () => {
        poseRAF = requestAnimationFrame(loop);
        const now = performance.now();
        if (now - lastSent < POSE_INTERVAL_MS) return;
        lastSent = now;
        const person = pose.frame.people?.[0] || null;
        try { transport.send(T.POSE, packFeatures(poseFeatures(person))); } catch {}
      };
      poseRAF = requestAnimationFrame(loop);
    } catch (err) {
      console.error('[entangle] pose start failed', err);
      poseOn = false;
      setStatus('Camera unavailable or denied. Other controls still work.', 'err');
    }
  }
  function stopPose(previewBox) {
    poseOn = false;
    if (poseRAF) cancelAnimationFrame(poseRAF), (poseRAF = 0);
    try { pose?.stopCamera(); } catch {}
    pose = null; video = null;
    if (previewBox) previewBox.innerHTML = '';
  }

  // ── Param debounce ──────────────────────────────────────────────────────
  const paramTimers = new Map();
  function sendParam(id, value) {
    clearTimeout(paramTimers.get(id));
    paramTimers.set(id, setTimeout(() => { try { transport.send(T.PARAM, { id, value }); } catch {} }, PARAM_DEBOUNCE_MS));
  }

  // ── Control UI (rebuilt from each manifest) ───────────────────────────────
  function renderControls() {
    if (!controlsEl) return;
    const m = manifest;
    const hasAny = m.modes.pose || (m.modes.param && m.params.length) || (m.modes.vote && m.fxList.length);
    controlsEl.innerHTML = '';

    if (m.modes.pose) {
      const sect = section('Your body → the field');
      const previewBox = el('div', 'ent-preview');
      const btn = el('button', 'ent-bigbtn');
      btn.textContent = 'tap to entangle your pose';
      btn.addEventListener('click', () => {
        if (poseOn) { stopPose(previewBox); btn.textContent = 'tap to entangle your pose'; btn.classList.remove('on'); }
        else { startPose(previewBox); btn.textContent = 'stop'; btn.classList.add('on'); }
      });
      sect.append(btn, previewBox);
      controlsEl.appendChild(sect);
    }

    if (m.modes.param && m.params.length) {
      const sect = section('Tune the visual');
      for (const p of m.params) sect.appendChild(paramControl(p));
      controlsEl.appendChild(sect);
    }

    if (m.modes.vote && m.fxList.length) {
      const sect = section('Vote the visual');
      const grid = el('div', 'ent-votegrid');
      for (const fx of m.fxList) {
        const b = el('button', 'ent-vote' + (myVote === fx.id ? ' on' : '') + (m.activeFx === fx.id ? ' active' : ''));
        b.textContent = fx.name;
        b.addEventListener('click', () => { myVote = fx.id; try { transport.send(T.VOTE, { fxId: fx.id }); } catch {} renderControls(); });
        grid.appendChild(b);
      }
      sect.appendChild(grid);
      controlsEl.appendChild(sect);
    }

    if (!hasAny) controlsEl.innerHTML = '<p class="ent-wait">Waiting for the performer to open a mode…</p>';
  }

  function paramControl(p) {
    const row = el('div', 'ent-param');
    const label = el('label'); label.textContent = p.label;
    row.appendChild(label);
    if (p.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range'; input.min = p.min; input.max = p.max; input.step = p.step;
      input.value = (p.value ?? (p.min + p.max) / 2);
      input.addEventListener('input', () => sendParam(p.id, parseFloat(input.value)));
      row.appendChild(input);
    } else if (p.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = !!p.value;
      input.addEventListener('change', () => sendParam(p.id, input.checked));
      label.prepend(input);
    } else if (p.type === 'select') {
      const sel = document.createElement('select');
      for (const o of (p.options || [])) { const opt = document.createElement('option'); opt.value = opt.textContent = o; sel.appendChild(opt); }
      if (p.value != null) sel.value = p.value;
      sel.addEventListener('change', () => sendParam(p.id, sel.value));
      row.appendChild(sel);
    }
    return row;
  }

  function section(title) { const s = el('section', 'ent-sect'); const h = el('h3'); h.textContent = title; s.appendChild(h); return s; }
  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function teardown() {
    stopPose(controlsEl?.querySelector('.ent-preview'));
    try { transport.close(); } catch {}
  }

  setStatus('Entangled — waiting for the performer.', 'ok');
  renderControls();
}
