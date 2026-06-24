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
import { poseFeatures, packFeatures, packSkeleton, unpackSkeleton, orientSkeleton, orientMatrix, SKELETON_BONES } from './pose-features.js';

const POSE_INTERVAL_MS = 66;     // ~15Hz upstream
const PARAM_DEBOUNCE_MS = 40;
const PREFS_KEY = 'voidstar.entangle.cam';
const CAM_H_MIN = 20, CAM_H_MAX = 70;   // preview height, vh

export async function initEntangleClient(root) {
  const roomId = readRoomFromHash();

  // Participant camera prefs — parity with the performer's own camera. The PHONE
  // owns size + orientation (mirror/flip/rotate); the skeleton is shipped already
  // oriented so the host draws exactly what the participant sees, no guessing.
  // Default flipH mirrors (selfie-natural); camH keeps the preview from eating
  // the whole viewport (the bug: a portrait camera at width:100% was huge).
  const prefs = (() => {
    const d = { flipH: true, flipV: false, rot: 0, camH: 38 };
    try {
      const o = JSON.parse(localStorage.getItem(PREFS_KEY));
      if (o && typeof o === 'object') {
        d.flipH = !!o.flipH; d.flipV = !!o.flipV;
        d.rot = (((o.rot | 0) % 360) + 360) % 360;
        if (Number.isFinite(o.camH)) d.camH = Math.min(CAM_H_MAX, Math.max(CAM_H_MIN, o.camH));
      }
    } catch {}
    return d;
  })();
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };
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

  // ── Pose + camera ───────────────────────────────────────────────────────
  let pose = null, video = null, poseRAF = 0, lastSent = 0, poseOn = false;
  // Preview surfaces, (re)bound by renderControls. The hidden <video> decodes
  // the camera; camCanvas is the single visible surface — it composites the
  // camera image AND the pose overlay through the SAME orientation transform,
  // so what the participant sees is exactly what the performer receives.
  let camWrap = null, camCanvas = null, camCtx = null;

  async function startPose() {
    if (poseOn) return;
    poseOn = true;
    setStatus('Starting camera…');
    if (camWrap) camWrap.style.display = '';
    try {
      const { createPose } = await import('./pose.js');     // lazy: only when needed
      pose = createPose();
      pose.setDetectFps(20);
      video = document.createElement('video');
      video.playsInline = true; video.muted = true;
      video.className = 'ent-cam-video';                     // sits behind camCanvas (decode source)
      if (camWrap) camWrap.insertBefore(video, camWrap.firstChild);
      await pose.startCamera({ video, facing: 'user' });
      setStatus('Entangled — move and the field responds.', 'ok');
      const loop = () => {
        poseRAF = requestAnimationFrame(loop);
        const person = pose.frame.people?.[0] || null;
        const raw = person ? packSkeleton(person) : null;
        drawCamera(person, raw);                             // every frame → smooth preview
        const now = performance.now();
        if (now - lastSent < POSE_INTERVAL_MS) return;       // throttle the upstream
        lastSent = now;
        try { transport.send(T.POSE, packFeatures(poseFeatures(person))); } catch {}
        // Skeleton: ship already-oriented, but ONLY when the host has the
        // overlay on (keeps the default upstream tiny).
        if (manifest.modes?.skeleton && raw) {
          try { transport.send(T.SKELETON, orientSkeleton(raw, prefs)); } catch {}
        }
      };
      poseRAF = requestAnimationFrame(loop);
    } catch (err) {
      console.error('[entangle] pose start failed', err);
      poseOn = false;
      if (camWrap) camWrap.style.display = 'none';
      setStatus('Camera unavailable or denied. Other controls still work.', 'err');
    }
  }
  function stopPose() {
    poseOn = false;
    if (poseRAF) cancelAnimationFrame(poseRAF), (poseRAF = 0);
    try { pose?.stopCamera(); } catch {}
    pose = null; video = null;
    if (camWrap) { camWrap.style.display = 'none'; const v = camWrap.querySelector('video'); if (v) v.remove(); }
    if (camCanvas && camCtx) { camCtx.setTransform(1, 0, 0, 1, 0, 0); camCtx.clearRect(0, 0, camCanvas.width, camCanvas.height); }
  }

  const cssVar = (name) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { return ''; } };

  // Composite the camera + pose overlay through the chosen orientation. The
  // camera is drawn via the orientation matrix (contain-fit, letterboxed); the
  // skeleton is mapped through the SAME matrix into the SAME fitted rect, so the
  // two always register — and both match the oriented data we ship.
  function drawCamera(person, raw) {
    if (!camCanvas || !camCtx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round((camCanvas.clientWidth || 1) * dpr));
    const H = Math.max(1, Math.round((camCanvas.clientHeight || 1) * dpr));
    if (camCanvas.width !== W)  camCanvas.width = W;
    if (camCanvas.height !== H) camCanvas.height = H;
    const ctx = camCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar('--void') || '#05050d';
    ctx.fillRect(0, 0, W, H);
    const vw = video?.videoWidth || 0, vh = video?.videoHeight || 0;
    if (!vw || !vh) return;

    const rot = (((prefs.rot % 360) + 360) % 360);
    const rotated = rot === 90 || rot === 270;
    const outW = rotated ? vh : vw, outH = rotated ? vw : vh;
    const scale = Math.min(W / outW, H / outH);              // contain
    const rectW = outW * scale, rectH = outH * scale;
    const rectX = (W - rectW) / 2, rectY = (H - rectH) / 2;
    const M = orientMatrix(prefs);

    // Camera: video-pixel → oriented-normalized (M) → fitted rect.
    ctx.setTransform(rectW * M.a / vw, rectH * M.b / vw, rectW * M.c / vh, rectH * M.d / vh,
                     rectW * M.e + rectX, rectH * M.f + rectY);
    try { ctx.drawImage(video, 0, 0, vw, vh); } catch {}
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (!raw) return;
    const joints = unpackSkeleton(raw);
    const P = (j) => j ? { x: rectX + (M.a * j.x + M.c * j.y + M.e) * rectW,
                           y: rectY + (M.b * j.x + M.d * j.y + M.f) * rectH } : null;
    const ref = Math.min(rectW, rectH);
    const accent = cssVar('--cyan') || '#22d3ee';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = accent; ctx.fillStyle = accent;
    ctx.shadowColor = accent; ctx.shadowBlur = Math.max(3, ref * 0.03);
    ctx.lineWidth = Math.max(2, ref * 0.012);
    const ln = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
    const dot = (p, r) => { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); };
    const head = P(joints[0]), shL = P(joints[1]), shR = P(joints[2]);
    if (head && shL && shR) ln(head, { x: (shL.x + shR.x) / 2, y: (shL.y + shR.y) / 2 });
    for (const [a, b] of SKELETON_BONES) { const pa = P(joints[a]), pb = P(joints[b]); if (pa && pb) ln(pa, pb); }
    const r = Math.max(1.5, ref * 0.011);
    for (const j of joints) { const p = P(j); if (p) dot(p, r); }
    if (head) dot(head, r * 2);
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
    camWrap = camCanvas = camCtx = null;

    if (m.modes.pose) {
      const sect = section('Your body → the field');

      const btn = el('button', 'ent-bigbtn');
      const reflect = () => {
        btn.textContent = poseOn ? 'stop' : 'tap to entangle your pose';
        btn.classList.toggle('on', poseOn);
        if (camWrap) camWrap.style.display = poseOn ? '' : 'none';
      };
      btn.addEventListener('click', () => { if (poseOn) stopPose(); else startPose(); reflect(); });

      // Tell the participant whether their movement actually does anything on
      // THIS quale — drives the field, shows as a skeleton, or neither.
      const note = el('div', 'ent-posenote');
      if (m.crowdReacts)        { note.textContent = '✓ this visual moves with you'; note.dataset.kind = 'ok'; }
      else if (m.modes.skeleton){ note.textContent = '✦ your pose is drawn on the big screen'; note.dataset.kind = 'ok'; }
      else                      { note.textContent = 'this visual doesn’t react to movement right now'; note.dataset.kind = 'muted'; }

      // The compositor preview — camera + your pose, in the orientation that's
      // shipped to the stage. Sized so it never swamps the page (the prod bug).
      camWrap = el('div', 'ent-cam');
      camWrap.style.height = prefs.camH + 'vh';
      camCanvas = document.createElement('canvas');
      camCanvas.className = 'ent-cam-canvas';
      camCtx = camCanvas.getContext('2d');
      camWrap.appendChild(camCanvas);
      // Survive re-renders (a quale switch re-sends the manifest): re-home the
      // already-running video into the fresh wrapper instead of resetting.
      if (poseOn && video) { camWrap.insertBefore(video, camWrap.firstChild); try { video.play?.().catch(() => {}); } catch {} }

      sect.append(btn, note, camWrap, buildCamControls());
      controlsEl.appendChild(sect);
      reflect();
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
      phaseProgEl.textContent = 'tap together with the observers to advance';
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

  // Camera controls — parity with the performer's own camera: size + orientation
  // (mirror / flip / rotate). Each applies live to the compositor and to the
  // shipped skeleton (drawCamera + the loop both read `prefs`).
  function buildCamControls() {
    const wrap = el('div', 'ent-camctl');
    const sizeRow = el('label', 'ent-slabel');
    sizeRow.innerHTML = `<span>camera size</span><span class="ent-sval"></span>`;
    const size = document.createElement('input');
    size.type = 'range'; size.min = String(CAM_H_MIN); size.max = String(CAM_H_MAX); size.step = '1';
    size.value = String(prefs.camH);
    const sval = sizeRow.querySelector('.ent-sval');
    const showSize = () => { if (sval) sval.textContent = prefs.camH + 'vh'; };
    showSize();
    size.addEventListener('input', () => {
      prefs.camH = Math.min(CAM_H_MAX, Math.max(CAM_H_MIN, +size.value || prefs.camH));
      if (camWrap) camWrap.style.height = prefs.camH + 'vh';
      showSize(); savePrefs();
    });

    const orient = el('div', 'ent-orient');
    const mk = (label, title, onClick, isOn) => {
      const b = el('button', 'ent-oribtn'); b.type = 'button'; b.title = title;
      const sync = () => { b.textContent = label(); b.classList.toggle('on', isOn()); };
      b.addEventListener('click', () => { onClick(); savePrefs(); orient.querySelectorAll('.ent-oribtn').forEach(x => x._sync && x._sync()); });
      b._sync = sync; sync();
      return b;
    };
    orient.append(
      mk(() => '⇄ mirror', 'Flip left ↔ right', () => { prefs.flipH = !prefs.flipH; }, () => prefs.flipH),
      mk(() => '⇅ flip',   'Flip up ↕ down',    () => { prefs.flipV = !prefs.flipV; }, () => prefs.flipV),
      mk(() => prefs.rot ? `⟳ ${prefs.rot}°` : '⟳ rotate', 'Rotate 90°', () => { prefs.rot = (prefs.rot + 90) % 360; }, () => !!prefs.rot),
    );

    wrap.append(sizeRow, size, orient);
    return wrap;
  }

  function teardown() {
    clearTimeout(connectTimer);
    stopPose();
    try { transport.close(); } catch {}
  }

  setStatus('Looking for the performer…');
  renderControls();
}
