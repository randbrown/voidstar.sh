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

// Owned signaling via the Cloudflare Durable Object star relay (drop-in for the
// Nostr/WebRTC ./entangle-transport.js — same interface).
import { createTransport } from './entangle-transport-cf.js';
import { T, APP_ID, readRoomFromHash } from './entangle-protocol.js';
import { poseFeatures, packFeatures, packSkeleton, unpackSkeleton, orientSkeleton, SKELETON_BONES } from './pose-features.js';

const POSE_INTERVAL_MS = 66;     // ~15Hz upstream
const PARAM_DEBOUNCE_MS = 40;
const ORI_KEY = 'voidstar.entangle.orient';

export async function initEntangleClient(root) {
  const roomId = readRoomFromHash();

  // Orientation the participant ships their skeleton in. The PHONE owns this so
  // the body lands on the big screen the right way up — the host draws exactly
  // what we send, no mirror-guessing. Default flipH mirrors (selfie-natural).
  const orientation = (() => {
    const d = { flipH: true, flipV: false, rot: 0 };
    try {
      const o = JSON.parse(localStorage.getItem(ORI_KEY));
      if (o && typeof o === 'object') {
        d.flipH = !!o.flipH; d.flipV = !!o.flipV; d.rot = (((o.rot | 0) % 360) + 360) % 360;
      }
    } catch {}
    return d;
  })();
  const saveOrientation = () => { try { localStorage.setItem(ORI_KEY, JSON.stringify(orientation)); } catch {} };
  const statusEl = root.querySelector('[data-status]');
  const controlsEl = root.querySelector('[data-controls]');
  const setStatus = (msg, kind = '') => { if (statusEl) { statusEl.textContent = msg; statusEl.dataset.kind = kind; } };

  if (!roomId) { setStatus('No room in this link — ask the performer for a fresh QR.', 'err'); return; }

  setStatus('Entangling…');
  let transport;
  try {
    transport = await createTransport({ appId: APP_ID, room: roomId, role: 'participant' });
  } catch (err) {
    console.error('[entangle] transport failed', err);
    setStatus('Could not connect. Check your network and reload.', 'err');
    return;
  }

  let manifest = { activeFx: null, fxList: [], modes: { pose: false, param: false, vote: false, phase: false }, crowdReacts: false, params: [] };
  let myVote = null;
  // Live-synced controls, keyed by param id → { input, type, lastEdit }. Lets
  // host / auto-phase value updates (T.VALUES) move the sliders without
  // clobbering a control the participant is actively dragging.
  const paramInputs = new Map();
  let phaseProgEl = null;

  // Connection feedback. Trystero's joinRoom resolves immediately — that is NOT
  // a connection. Stay in a "looking" state until the performer's peer actually
  // appears (onPeer), and fail loudly if it never does, so a relay outage shows
  // an actionable message instead of hanging forever on "waiting".
  let peerSeen = false;
  const connectTimer = setTimeout(() => {
    if (!peerSeen) setStatus("Couldn't reach the performer — make sure the field is still open, then reload this page.", 'err');
  }, 20000);

  // Announce ourselves; re-announce whenever a (new) host appears.
  const hello = () => transport.send(T.HELLO, { name: '' });
  transport.onPeer(() => {
    if (!peerSeen) { peerSeen = true; clearTimeout(connectTimer); setStatus('Entangled ⊛ — waiting for the performer.', 'ok'); }
    hello();
  });
  hello();

  transport.on(T.MANIFEST, (m) => { if (m && typeof m === 'object') { manifest = m; renderControls(); } });
  transport.on(T.KICK, () => { teardown(); setStatus('The performance has ended. Thanks for entangling. ⊛', 'end'); });

  // Live value-sync — host / auto-phase moved a param; reflect it on our slider
  // unless the participant is actively touching that control.
  transport.on(T.VALUES, (delta) => {
    if (!delta || typeof delta !== 'object') return;
    const now = performance.now();
    for (const id in delta) {
      const ctl = paramInputs.get(id);
      if (!ctl) continue;
      if (document.activeElement === ctl.input) continue;       // user focused
      if (now - ctl.lastEdit < 1200) continue;                  // recently dragged
      const v = delta[id];
      if (ctl.type === 'toggle') ctl.input.checked = !!v;
      else ctl.input.value = v;
    }
  });

  // Crowd phase-shift progress (host → all).
  transport.on(T.PHASEPROG, (p) => {
    if (!phaseProgEl || !p) return;
    phaseProgEl.textContent = p.fired
      ? '⟳ the phase shifted!'
      : `${p.have} / ${p.need} pushing…`;
  });

  window.addEventListener('pagehide', () => { try { transport.send(T.BYE, 1); } catch {} });

  // ── Pose ──────────────────────────────────────────────────────────────────
  let pose = null, video = null, poseRAF = 0, lastSent = 0, poseOn = false;
  // Local preview surfaces, (re)bound by renderControls. camHolder hosts the
  // live camera; poseOverlay draws the skeleton on top of it; stageCanvas shows
  // the oriented body exactly as the performer's screen will render it.
  let camHolder = null, poseOverlay = null, poseOverlayCtx = null, stageCanvas = null, stageCtx = null;

  async function startPose() {
    if (poseOn) return;
    poseOn = true;
    setStatus('Starting camera…');
    try {
      const { createPose } = await import('./pose.js');     // lazy: only when needed
      pose = createPose();
      pose.setDetectFps(20);
      video = document.createElement('video');
      video.playsInline = true; video.muted = true;
      video.className = 'ent-cam-video';
      if (camHolder) { camHolder.innerHTML = ''; camHolder.appendChild(video); }
      await pose.startCamera({ video, facing: 'user' });
      setStatus('Entangled — move and the field responds.', 'ok');
      const loop = () => {
        poseRAF = requestAnimationFrame(loop);
        const now = performance.now();
        if (now - lastSent < POSE_INTERVAL_MS) return;
        lastSent = now;
        const person = pose.frame.people?.[0] || null;
        try { transport.send(T.POSE, packFeatures(poseFeatures(person))); } catch {}
        // Skeleton: pack once, orient on-device, then ship — but ONLY when the
        // host has the overlay on (keeps the default upstream tiny). The same
        // raw + oriented arrays feed the local previews below.
        let raw = null, oriented = null;
        if (person) { raw = packSkeleton(person); oriented = orientSkeleton(raw, orientation); }
        if (manifest.modes?.skeleton && oriented) {
          try { transport.send(T.SKELETON, oriented); } catch {}
        }
        drawLocalPose(raw, oriented);
      };
      poseRAF = requestAnimationFrame(loop);
    } catch (err) {
      console.error('[entangle] pose start failed', err);
      poseOn = false;
      setStatus('Camera unavailable or denied. Other controls still work.', 'err');
    }
  }
  function stopPose() {
    poseOn = false;
    if (poseRAF) cancelAnimationFrame(poseRAF), (poseRAF = 0);
    try { pose?.stopCamera(); } catch {}
    pose = null; video = null;
    if (camHolder) camHolder.innerHTML = '';
    if (poseOverlay && poseOverlayCtx) poseOverlayCtx.clearRect(0, 0, poseOverlay.width, poseOverlay.height);
    if (stageCanvas && stageCtx) stageCtx.clearRect(0, 0, stageCanvas.width, stageCanvas.height);
  }

  // Paint the two local previews. The camera overlay tracks the body on the
  // selfie-mirrored video (raw coords, mirrored to match). The stage preview is
  // strictly WYSIWYG — the oriented skeleton the performer's machine receives.
  function drawLocalPose(raw, oriented) {
    if (poseOverlay && poseOverlayCtx) {
      const w = poseOverlay.clientWidth || poseOverlay.width;
      const h = poseOverlay.clientHeight || poseOverlay.height;
      if (poseOverlay.width !== w)  poseOverlay.width = w;
      if (poseOverlay.height !== h) poseOverlay.height = h;
      poseOverlayCtx.clearRect(0, 0, poseOverlay.width, poseOverlay.height);
      if (raw) drawSkel(poseOverlayCtx, poseOverlay.width, poseOverlay.height, unpackSkeleton(raw), { mirror: true, fit: false });
    }
    if (stageCanvas && stageCtx) {
      stageCtx.clearRect(0, 0, stageCanvas.width, stageCanvas.height);
      if (oriented) drawSkel(stageCtx, stageCanvas.width, stageCanvas.height, unpackSkeleton(oriented), { fit: true });
    }
  }

  const cssVar = (name) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { return ''; } };
  // Compact skeleton renderer shared by both previews. `fit` bbox-fits the body
  // into the canvas (stage preview); otherwise joints map straight to the frame
  // (camera overlay), optionally mirrored to match the selfie video.
  function drawSkel(ctx, w, h, joints, { mirror = false, fit = false } = {}) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0, any = false;
    for (const j of joints) { if (!j) continue; any = true; if (j.x < minX) minX = j.x; if (j.x > maxX) maxX = j.x; if (j.y < minY) minY = j.y; if (j.y > maxY) maxY = j.y; }
    if (!any) return;
    let P;
    if (fit) {
      const bw = Math.max(1e-3, maxX - minX), bh = Math.max(1e-3, maxY - minY);
      const pad = Math.min(w, h) * 0.16, s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
      const dw = bw * s, dh = bh * s, ox = (w - dw) / 2, oy = (h - dh) / 2;
      P = (j) => j ? { x: ox + ((j.x - minX) / bw) * dw, y: oy + ((j.y - minY) / bh) * dh } : null;
    } else {
      P = (j) => j ? { x: (mirror ? 1 - j.x : j.x) * w, y: j.y * h } : null;
    }
    const accent = cssVar('--cyan') || '#22d3ee';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = accent; ctx.fillStyle = accent;
    ctx.shadowColor = accent; ctx.shadowBlur = Math.max(3, Math.min(w, h) * 0.04);
    ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.02);
    const ln = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
    const dt = (p, r) => { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); };
    const head = P(joints[0]), shL = P(joints[1]), shR = P(joints[2]);
    if (head && shL && shR) ln(head, { x: (shL.x + shR.x) / 2, y: (shL.y + shR.y) / 2 });
    for (const [a, b] of SKELETON_BONES) { const pa = P(joints[a]), pb = P(joints[b]); if (pa && pb) ln(pa, pb); }
    const r = Math.max(1.5, Math.min(w, h) * 0.018);
    for (const j of joints) { const p = P(j); if (p) dt(p, r); }
    if (head) dt(head, r * 2);
    ctx.shadowBlur = 0;
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
    // Host disabled pose entirely → release the camera. (A mere quale switch
    // keeps pose on; we preserve the running camera through the re-render below.)
    if (!m.modes.pose && poseOn) stopPose();
    const hasAny = m.modes.pose || (m.modes.param && m.params.length)
      || (m.modes.vote && m.fxList.length) || m.modes.phase;
    controlsEl.innerHTML = '';
    paramInputs.clear();
    phaseProgEl = null;
    camHolder = poseOverlay = poseOverlayCtx = stageCanvas = stageCtx = null;

    if (m.modes.pose) {
      const sect = section('Your body → the field');
      // Camera + live skeleton overlay (your own pose, shown locally).
      const previewBox = el('div', 'ent-preview');
      camHolder = el('div', 'ent-cam');
      poseOverlay = document.createElement('canvas');
      poseOverlay.className = 'ent-pose-overlay';
      poseOverlayCtx = poseOverlay.getContext('2d');
      previewBox.append(camHolder, poseOverlay);

      const btn = el('button', 'ent-bigbtn');
      const reflect = () => { btn.textContent = poseOn ? 'stop' : 'tap to entangle your pose'; btn.classList.toggle('on', poseOn); };
      btn.addEventListener('click', () => {
        if (poseOn) stopPose(); else startPose();
        reflect();
      });
      // Persist across re-renders: a quale switch re-sends the manifest, which
      // rebuilds these controls. If the camera is already running, keep it on
      // and re-home the live preview into the fresh box instead of resetting.
      if (poseOn && video) { camHolder.appendChild(video); try { video.play?.().catch(() => {}); } catch {} }
      reflect();
      // Tell the participant whether their movement actually does anything on
      // THIS quale — drives the field, shows as a skeleton, or neither.
      const note = el('div', 'ent-posenote');
      if (m.crowdReacts)        { note.textContent = '✓ this visual moves with you'; note.dataset.kind = 'ok'; }
      else if (m.modes.skeleton){ note.textContent = '✦ your pose is drawn on the big screen'; note.dataset.kind = 'ok'; }
      else                      { note.textContent = 'this visual doesn’t react to movement right now'; note.dataset.kind = 'muted'; }
      sect.append(btn, note, previewBox);

      // Orientation — only when the performer is drawing crowd skeletons (the
      // only time it matters). Adjust mirror/flip/rotate so the body lands the
      // right way up on the big screen; the stage preview is exactly what they
      // see, and the same orientation is what we ship.
      if (m.modes.skeleton) {
        const stage = el('div', 'ent-stage');
        const slabel = el('div', 'ent-stage-label'); slabel.textContent = 'what the performer sees';
        stageCanvas = document.createElement('canvas');
        stageCanvas.className = 'ent-stage-canvas';
        stageCanvas.width = 160; stageCanvas.height = 200;
        stageCtx = stageCanvas.getContext('2d');
        stage.append(slabel, stageCanvas);

        const orient = el('div', 'ent-orient');
        const mk = (label, title, onClick, isOn) => {
          const b = el('button', 'ent-oribtn');
          b.type = 'button'; b.title = title;
          const sync = () => { b.textContent = label(); b.classList.toggle('on', isOn()); };
          b.addEventListener('click', () => { onClick(); saveOrientation(); orient.querySelectorAll('.ent-oribtn').forEach(x => x._sync && x._sync()); });
          b._sync = sync; sync();
          return b;
        };
        orient.append(
          mk(() => '⇄ mirror',                                       'Flip left ↔ right', () => { orientation.flipH = !orientation.flipH; }, () => orientation.flipH),
          mk(() => '⇅ flip',                                          'Flip up ↕ down',    () => { orientation.flipV = !orientation.flipV; }, () => orientation.flipV),
          mk(() => orientation.rot ? `⟳ ${orientation.rot}°` : '⟳ rotate', 'Rotate 90°',  () => { orientation.rot = (orientation.rot + 90) % 360; }, () => !!orientation.rot),
        );
        sect.append(stage, orient);
      }

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

    if (m.modes.phase) {
      const sect = section('Shift the phase');
      const btn = el('button', 'ent-bigbtn');
      btn.textContent = '⟳ shift the phase';
      btn.addEventListener('click', () => {
        try { transport.send(T.PHASE, 1); } catch {}
        btn.classList.add('on');
        setTimeout(() => btn.classList.remove('on'), 180);
      });
      phaseProgEl = el('div', 'ent-phaseprog');
      phaseProgEl.textContent = 'tap together with the crowd to advance';
      sect.append(btn, phaseProgEl);
      controlsEl.appendChild(sect);
    }

    if (!hasAny) controlsEl.innerHTML = '<p class="ent-wait">Waiting for the performer to open a mode…</p>';
  }

  function paramControl(p) {
    const row = el('div', 'ent-param');
    const label = el('label'); label.textContent = p.label;
    row.appendChild(label);
    // Mark a control as locally edited so incoming value-sync leaves it alone.
    const stamp = (ctl) => { ctl.lastEdit = performance.now(); };
    if (p.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range'; input.min = p.min; input.max = p.max; input.step = p.step;
      input.value = (p.value ?? (p.min + p.max) / 2);
      const ctl = { input, type: 'range', lastEdit: 0 };
      input.addEventListener('input', () => { stamp(ctl); sendParam(p.id, parseFloat(input.value)); });
      paramInputs.set(p.id, ctl);
      row.appendChild(input);
    } else if (p.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = !!p.value;
      const ctl = { input, type: 'toggle', lastEdit: 0 };
      input.addEventListener('change', () => { stamp(ctl); sendParam(p.id, input.checked); });
      paramInputs.set(p.id, ctl);
      label.prepend(input);
    } else if (p.type === 'select') {
      const sel = document.createElement('select');
      for (const o of (p.options || [])) { const opt = document.createElement('option'); opt.value = opt.textContent = o; sel.appendChild(opt); }
      if (p.value != null) sel.value = p.value;
      const ctl = { input: sel, type: 'select', lastEdit: 0 };
      sel.addEventListener('change', () => { stamp(ctl); sendParam(p.id, sel.value); });
      paramInputs.set(p.id, ctl);
      row.appendChild(sel);
    }
    return row;
  }

  function section(title) { const s = el('section', 'ent-sect'); const h = el('h3'); h.textContent = title; s.appendChild(h); return s; }
  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function teardown() {
    clearTimeout(connectTimer);
    stopPose();
    try { transport.close(); } catch {}
  }

  setStatus('Looking for the performer…');
  renderControls();
}
