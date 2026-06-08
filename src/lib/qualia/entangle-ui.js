// Entanglement — host UI + engine wiring.
//
// Self-mounting (like overlay.js / buildParamPanel): page-init calls
// initEntangleUI({ core, mesh }) once and this builds its own DOM — a topbar
// launcher, the QR / moderation modal, and the live crowd HUD — then wires the
// one piece of hot-path glue: a core.onTick listener that folds the aggregated
// crowd snapshot into field.crowd at the react cadence (O(N), tiny crowd).
//
// All DOM is created in JS with a single scoped <style> so qualia.astro needs
// no markup changes; colors come from the existing voidstar CSS tokens.

import { createEntangle } from './entangle.js';
import { SKELETON_BONES } from './pose-features.js';

const STYLE_ID = 'entangle-style';
const CSS = `
#entangle-launch{display:inline-flex;align-items:center;gap:.35rem}
#entangle-launch[data-live="1"]{color:var(--cyan,#22d3ee);border-color:var(--cyan,#22d3ee)}
#entangle-dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--cyan,#22d3ee);box-shadow:0 0 .4rem var(--cyan,#22d3ee);display:none}
#entangle-launch[data-live="1"] #entangle-dot{display:inline-block;animation:ent-pulse 1.6s ease-in-out infinite}
@keyframes ent-pulse{0%,100%{opacity:.35}50%{opacity:1}}
/* Modeless: no dim, no blur, no click-catch — so the performer keeps watching
   the field (and using the rest of the UI) with the panel open. Close via ×,
   Esc, or the topbar toggle. */
#entangle-backdrop{position:fixed;inset:0;background:transparent;z-index:40;display:none;pointer-events:none}
#entangle-modal{position:fixed;z-index:41;top:50%;left:50%;transform:translate(-50%,-50%);
  width:min(30rem,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);overflow:auto;
  background:linear-gradient(180deg,#0b0b18,#070710);border:1px solid var(--accent,#8b5cf6);
  border-radius:.8rem;box-shadow:0 0 2rem rgba(139,92,246,.35);color:var(--text,#e9e6ff);
  font:13px/1.45 ui-monospace,monospace;display:none;padding:1rem 1.1rem 1.2rem}
#entangle-modal h2{margin:0;font-size:1rem;letter-spacing:.04em;color:var(--text,#e9e6ff);font-weight:600;
  display:flex;align-items:center;gap:.5rem}
#entangle-modal .ent-sub{color:#9b96c4;font-size:.78rem;margin:.15rem 0 .9rem}
#entangle-modal .ent-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;cursor:move;user-select:none;touch-action:none}
#entangle-modal.ent-dragging{user-select:none}
#entangle-modal.ent-dragging .ent-head{cursor:grabbing}
#entangle-modal .ent-head .ent-close{cursor:pointer}
#entangle-modal button{font:inherit;cursor:pointer;border-radius:.4rem;padding:.4rem .7rem;
  background:#15132a;color:var(--text,#e9e6ff);border:1px solid #2c2750;transition:.12s}
#entangle-modal button:hover{border-color:var(--accent,#8b5cf6)}
#entangle-modal button.ent-primary{background:var(--accent,#8b5cf6);border-color:var(--accent,#8b5cf6);color:#0b0b18;font-weight:600}
#entangle-modal button.ent-danger{border-color:var(--pink,#f472b6);color:var(--pink,#f472b6);background:#1a0f1c}
#entangle-modal .ent-close{padding:.1rem .5rem;line-height:1}
#entangle-qr{display:block;margin:.4rem auto;border-radius:.5rem;background:var(--void,#05050d);max-width:100%}
#entangle-url{width:100%;box-sizing:border-box;background:#0c0a18;color:var(--cyan,#22d3ee);
  border:1px solid #2c2750;border-radius:.4rem;padding:.45rem;font:inherit;resize:none;height:3.2rem}
.ent-row{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin:.5rem 0}
.ent-row.between{justify-content:space-between}
.ent-sect{border-top:1px solid #221d40;margin-top:.9rem;padding-top:.7rem}
.ent-sect h3{margin:0 0 .4rem;font-size:.82rem;color:#b9b3e6;letter-spacing:.05em;text-transform:uppercase;font-weight:600}
.ent-chip{display:inline-flex;align-items:center;gap:.35rem;padding:.25rem .55rem;border-radius:.4rem;
  border:1px solid #2c2750;background:#120f24;cursor:pointer;user-select:none}
.ent-chip.on{border-color:var(--cyan,#22d3ee);color:var(--cyan,#22d3ee);background:#0d1820}
.ent-wl{display:flex;flex-wrap:wrap;gap:.35rem}
.ent-count{font-variant-numeric:tabular-nums;color:var(--cyan,#22d3ee)}
.ent-tally{display:flex;flex-direction:column;gap:.25rem;margin:.3rem 0}
.ent-tally .ent-t{display:flex;justify-content:space-between;gap:.5rem;padding:.2rem .4rem;background:#100d20;border-radius:.3rem}
.ent-tally .ent-t b{color:var(--amber,#fbbf24)}
.ent-empty{color:#6f6a93;font-size:.8rem;font-style:italic}
.ent-crowdsig{font:12px/1.55 ui-monospace,monospace;margin:.15rem 0}
.ent-crowdsig .ent-csline{color:var(--cyan,#22d3ee);margin-bottom:.25rem}
.ent-crowdsig .ent-csrow{display:flex;align-items:center;gap:.5rem;color:#9b96c4}
.ent-crowdsig .ent-cslabel{width:3.6rem}
.ent-crowdsig .ent-csbar{color:var(--cyan,#22d3ee);letter-spacing:.04em}
.ent-crowdhint{margin-top:.4rem}
#entangle-skeletons{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:12;display:none}
#entangle-hud{position:fixed;left:max(.6rem,env(safe-area-inset-left));bottom:max(.6rem,env(safe-area-inset-bottom));
  z-index:16;display:none;align-items:center;gap:.45rem;padding:.3rem .6rem;border-radius:.5rem;
  background:rgba(8,7,18,.7);border:1px solid var(--cyan,#22d3ee);color:var(--cyan,#22d3ee);
  font:12px/1 ui-monospace,monospace;pointer-events:none}
#entangle-hud[data-live="1"]{display:inline-flex}
`;

export function initEntangleUI({ core, mesh, actions = {} }) {
  const entangle = createEntangle({ core, mesh, actions });

  // Which qualia actually map crowd.* — used in the "switch to…" hint when the
  // crowd is moving but the active visual ignores it. Static, so compute once.
  let crowdReactiveLabels = '';
  try {
    crowdReactiveLabels = mesh.list()
      .filter(m => (mesh.get(m.id)?.params || [])
        .some(s => (s.modulators || []).some(md => typeof md?.source === 'string' && md.source.startsWith('crowd.'))))
      .map(m => m.name || m.id)
      .join(' · ');
  } catch {}
  if (!crowdReactiveLabels) crowdReactiveLabels = 'code · galaxy · anomaly · gargantua-void · dark-space · neural-field';

  // ── Hot-path glue: fold the crowd snapshot into field.crowd each tick. ────
  // Runs at the react cadence (≤60Hz), before computeChannels. reduceInto is
  // O(peers) over a small crowd writing 8 scalars — no async, no allocations.
  core.onTick((field) => {
    try { entangle.reduceInto(field.crowd, field.reactDt || 0); } catch {}
  });

  // ── Style (once) ──────────────────────────────────────────────────────────
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ── Launcher button (topbar, with graceful fallback) ──────────────────────
  const launch = document.createElement('button');
  launch.id = 'entangle-launch';
  launch.className = 'ctrl-btn';
  launch.title = 'Entanglement — audience participation';
  launch.innerHTML = '<span id="entangle-dot"></span>⊛ entangle';
  const topbarRight = document.getElementById('topbar-right');
  if (topbarRight) topbarRight.appendChild(launch);
  else { launch.style.cssText = 'position:fixed;top:.6rem;right:.6rem;z-index:42'; document.body.appendChild(launch); }

  // ── HUD ─────────────────────────────────────────────────────────────────
  const hud = document.createElement('div');
  hud.id = 'entangle-hud';
  hud.innerHTML = '⊛ <span class="ent-hud-n">0</span> entangled';
  document.body.appendChild(hud);
  const hudN = hud.querySelector('.ent-hud-n');

  // ── Crowd-skeletons overlay ───────────────────────────────────────────────
  // A full-screen canvas drawing each participant's body (glowing, grid-laid)
  // over whatever quale is active, while the host has skeleton mode on. Own rAF
  // loop reading engine.getSkeletons(); per-id alpha fades people in/out. Mirror
  // x so a raised right hand reads on the right (selfie-natural). Cheap and
  // inert when off (display:none, no draw).
  const skelCanvas = document.createElement('canvas');
  skelCanvas.id = 'entangle-skeletons';
  document.body.appendChild(skelCanvas);
  const sctx = skelCanvas.getContext('2d');
  let skelW = 0, skelH = 0, skelDpr = 1;
  function sizeSkel() {
    skelDpr = Math.min(2, window.devicePixelRatio || 1);
    skelW = window.innerWidth; skelH = window.innerHeight;
    skelCanvas.width = Math.round(skelW * skelDpr);
    skelCanvas.height = Math.round(skelH * skelDpr);
  }
  sizeSkel();
  window.addEventListener('resize', sizeSkel);

  const skelLayer = new Map();   // id → { alpha, order, hue, joints }
  let skelOrder = 0;
  const idHue = (id) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return 175 + (h % 130); }; // cyan→violet→pink

  function drawSkeletons() {
    requestAnimationFrame(drawSkeletons);
    const show = entangle.isOpen() && entangle.getModes().skeleton;
    if (!show) {
      if (skelCanvas.style.display !== 'none') {
        skelCanvas.style.display = 'none';
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(0, 0, skelCanvas.width, skelCanvas.height);
      }
      if (skelLayer.size) skelLayer.clear();
      return;
    }
    if (skelCanvas.style.display !== 'block') skelCanvas.style.display = 'block';

    const list = entangle.getSkeletons();
    const present = new Set();
    for (const s of list) {
      present.add(s.id);
      let L = skelLayer.get(s.id);
      if (!L) { L = { alpha: 0, order: skelOrder++, hue: idHue(s.id) }; skelLayer.set(s.id, L); }
      L.joints = s.joints;
      L.alpha += (1 - L.alpha) * 0.12;
    }
    for (const [id, L] of skelLayer) {
      if (!present.has(id)) { L.alpha += (0 - L.alpha) * 0.12; if (L.alpha < 0.01) skelLayer.delete(id); }
    }

    sctx.setTransform(skelDpr, 0, 0, skelDpr, 0, 0);
    sctx.clearRect(0, 0, skelW, skelH);
    const cells = [...skelLayer.values()].sort((a, b) => a.order - b.order);
    const n = cells.length;
    if (!n) return;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = skelW / cols, ch = skelH / rows;
    for (let i = 0; i < n; i++) {
      const L = cells[i];
      if (!L.joints) continue;
      drawOne(L.joints, (i % cols) * cw, ((i / cols) | 0) * ch, cw, ch, L.hue, L.alpha);
    }
  }

  function drawOne(joints, cx, cy, cw, ch, hue, alpha) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0, any = false;
    for (const j of joints) { if (!j) continue; any = true; if (j.x < minX) minX = j.x; if (j.x > maxX) maxX = j.x; if (j.y < minY) minY = j.y; if (j.y > maxY) maxY = j.y; }
    if (!any) return;
    const bw = Math.max(1e-3, maxX - minX), bh = Math.max(1e-3, maxY - minY);
    const pad = Math.min(cw, ch) * 0.16;
    const s = Math.min((cw - pad * 2) / bw, (ch - pad * 2) / bh);
    const drawW = bw * s, drawH = bh * s;
    const ox = cx + (cw - drawW) / 2, oy = cy + (ch - drawH) / 2;
    const P = (j) => j ? { x: ox + (1 - (j.x - minX) / bw) * drawW, y: oy + ((j.y - minY) / bh) * drawH } : null;

    const col = `hsla(${hue},85%,66%,${alpha})`;
    sctx.lineCap = 'round'; sctx.lineJoin = 'round';
    sctx.strokeStyle = col; sctx.fillStyle = col;
    sctx.shadowColor = `hsla(${hue},90%,60%,${alpha})`;
    sctx.shadowBlur = Math.max(6, Math.min(cw, ch) * 0.03);
    sctx.lineWidth = Math.max(2, Math.min(cw, ch) * 0.014);

    const head = P(joints[0]), shL = P(joints[1]), shR = P(joints[2]);
    if (head && shL && shR) line(head, { x: (shL.x + shR.x) / 2, y: (shL.y + shR.y) / 2 });
    for (const [a, b] of SKELETON_BONES) { const pa = P(joints[a]), pb = P(joints[b]); if (pa && pb) line(pa, pb); }

    const r = Math.max(2, Math.min(cw, ch) * 0.012);
    for (const j of joints) { const p = P(j); if (p) dot(p, r); }
    if (head) dot(head, r * 2.4);
    sctx.shadowBlur = 0;
  }
  function line(a, b) { sctx.beginPath(); sctx.moveTo(a.x, a.y); sctx.lineTo(b.x, b.y); sctx.stroke(); }
  function dot(p, r) { sctx.beginPath(); sctx.arc(p.x, p.y, r, 0, Math.PI * 2); sctx.fill(); }

  requestAnimationFrame(drawSkeletons);

  // ── Modal ─────────────────────────────────────────────────────────────────
  const backdrop = document.createElement('div'); backdrop.id = 'entangle-backdrop';
  const modal = document.createElement('div');
  modal.id = 'entangle-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  document.body.append(backdrop, modal);

  let open = false;
  function show() { open = true; backdrop.style.display = modal.style.display = 'block'; render(); }
  function hide() { open = false; backdrop.style.display = modal.style.display = 'none'; }
  launch.addEventListener('click', () => (open ? hide() : show()));
  // Modeless panel: no click-outside-to-close (the backdrop no longer catches
  // clicks). Close via ×, Esc, or the topbar toggle.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) hide(); });

  // ── Draggable panel — grab the header to reposition (sticky for the session). ─
  // Opens centred via CSS transform; on first drag we convert to explicit px so
  // pointer deltas are absolute, then clamp to keep a graspable strip on-screen.
  // Pointer capture keeps the drag alive past the panel edges. Survives modal
  // re-renders (those touch innerHTML, not the modal's own inline style) and
  // re-opens wherever it was left.
  let drag = null;
  modal.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.ent-head') || e.target.closest('button')) return;  // header only, never the ×
    const rect = modal.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    modal.style.left = rect.left + 'px';
    modal.style.top = rect.top + 'px';
    modal.style.transform = 'none';
    modal.classList.add('ent-dragging');
    try { modal.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  modal.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = modal.offsetWidth;
    const left = Math.max(80 - w, Math.min(e.clientX - drag.dx, window.innerWidth - 80));
    const top  = Math.max(0,      Math.min(e.clientY - drag.dy, window.innerHeight - 40));
    modal.style.left = left + 'px';
    modal.style.top  = top + 'px';
  });
  const endDrag = (e) => { if (!drag) return; drag = null; modal.classList.remove('ent-dragging'); try { modal.releasePointerCapture(e.pointerId); } catch {} };
  modal.addEventListener('pointerup', endDrag);
  modal.addEventListener('pointercancel', endDrag);

  function setLive(live) {
    launch.dataset.live = live ? '1' : '0';
    hud.dataset.live = live ? '1' : '0';
  }

  // ── Render the modal body from current state ──────────────────────────────
  function render() {
    if (!open) return;
    const live = entangle.isOpen();
    const modes = entangle.getModes();
    const wl = new Set(entangle.getWhitelist());
    const specs = entangle.getSpecs().filter(s => ['range', 'toggle', 'select'].includes(s.type));
    const url = entangle.getJoinUrl();
    const tally = entangle.tally();
    const autoVote = entangle.getAutoVote();

    modal.innerHTML = `
      <div class="ent-head">
        <div>
          <h2>⊛ Entanglement</h2>
          <div class="ent-sub">Let the crowd entangle with the field — spooky action across the room.</div>
        </div>
        <button class="ent-close" data-act="close" title="Close">×</button>
      </div>
      ${live ? `
        <canvas id="entangle-qr" width="320" height="320"></canvas>
        <textarea id="entangle-url" readonly spellcheck="false">${url || ''}</textarea>
        <div class="ent-row between">
          <span><span class="ent-count" data-n>${entangle.peerCount()}</span> entangled</span>
          <span class="ent-row">
            <button data-act="copy">copy link</button>
            <button class="ent-danger" data-act="closeroom">collapse</button>
          </span>
        </div>
        <div class="ent-sect">
          <h3>Crowd signal</h3>
          <div class="ent-crowdsig" data-crowdsig></div>
          <div class="ent-sub ent-crowdhint" data-crowdhint></div>
        </div>
      ` : `
        <div class="ent-row"><button class="ent-primary" data-act="openroom">⊛ open the field</button></div>
        <div class="ent-sub">Generates a private room + QR. Audience scans to join. Nothing runs on your machine for them — phones do their own pose tracking.</div>
      `}

      <div class="ent-sect">
        <h3>Modes</h3>
        <div class="ent-row">
          <span class="ent-chip ${modes.pose ? 'on' : ''}" data-mode="pose">pose → field</span>
          <span class="ent-chip ${modes.param ? 'on' : ''}" data-mode="param">param control</span>
          <span class="ent-chip ${modes.vote ? 'on' : ''}" data-mode="vote">visual vote</span>
          <span class="ent-chip ${modes.skeleton ? 'on' : ''}" data-mode="skeleton" title="Draw each participant's body as a glowing overlay on top of the visual">⛓ crowd skeletons</span>
          ${entangle.phaseAvailable ? `<span class="ent-chip ${modes.phase ? 'on' : ''}" data-mode="phase">crowd phase-shift</span>` : ''}
        </div>
        ${modes.phase && entangle.phaseAvailable ? `<div class="ent-sub" data-phase>shift charge: 0 / 0 — the crowd taps together to advance the phase</div>` : ''}
      </div>

      ${modes.param ? `
      <div class="ent-sect">
        <h3>Crowd-controllable params <span class="ent-sub" style="text-transform:none">(active quale)</span></h3>
        <div class="ent-wl">
          ${specs.length ? specs.map(s => `<span class="ent-chip ${wl.has(s.id) ? 'on' : ''}" data-wl="${s.id}">${s.label || s.id}</span>`).join('')
            : '<span class="ent-empty">this quale exposes no crowd-friendly params</span>'}
        </div>
      </div>` : ''}

      ${modes.vote ? `
      <div class="ent-sect">
        <h3>Visual votes</h3>
        <div class="ent-tally" data-tally>
          ${tally.length ? tally.map(t => `<div class="ent-t"><span>${t.name}</span><b>${t.count}</b></div>`).join('')
            : '<span class="ent-empty">no votes yet</span>'}
        </div>
        <div class="ent-row between">
          <span class="ent-chip ${autoVote ? 'on' : ''}" data-act="autovote" title="Let the crowd's top vote switch the visual automatically (≤ every 5s)">⟳ auto-switch (5s)</span>
          <button data-act="applyvote" ${tally.length ? '' : 'disabled'}>switch now</button>
        </div>
      </div>` : ''}
    `;

    if (live && url) {
      const canvas = modal.querySelector('#entangle-qr');
      import('./qr.js').then(m => m.renderQR(canvas, url, 300)).catch(err => console.warn('[entangle] qr', err));
    }
    if (live) updateCrowdSig();
  }

  // ── Live crowd-signal meter — confirms phone motion is actually landing. ───
  // Updated on a light interval (the engine snapshots it each reduceInto); shows
  // confidence-gated posers (not just sockets) plus energy / hands / spread, and
  // a hint that pinpoints why nothing's moving (mode off, nobody posing, or the
  // active quale simply doesn't map crowd.*).
  const sigBar = (v, n = 8) => { const f = Math.max(0, Math.min(n, Math.round((v || 0) * n))); return '█'.repeat(f) + '░'.repeat(n - f); };
  function updateCrowdSig() {
    if (!open || !entangle.isOpen()) return;
    const el = modal.querySelector('[data-crowdsig]');
    if (!el) return;
    const s = entangle.getCrowdSignal();
    const connected = entangle.peerCount();
    el.innerHTML =
      `<div class="ent-csline">${s.posing} posing · ${connected} entangled</div>` +
      `<div class="ent-csrow"><span class="ent-cslabel">energy</span><span class="ent-csbar">${sigBar(s.energy)}</span></div>` +
      `<div class="ent-csrow"><span class="ent-cslabel">hands</span><span class="ent-csbar">${sigBar(s.rise)}</span></div>` +
      `<div class="ent-csrow"><span class="ent-cslabel">spread</span><span class="ent-csbar">${sigBar(Math.abs(s.spread))}</span></div>`;
    const hint = modal.querySelector('[data-crowdhint]');
    if (!hint) return;
    const m = entangle.getModes();
    let msg, warn = false;
    if (!m.pose)              { msg = '“pose → field” is off — enable it above to feel the crowd.'; warn = true; }
    else if (connected === 0) { msg = 'no one has joined yet — share the QR.'; }
    else if (s.posing === 0)  { msg = 'connected, but nobody has tapped “entangle your pose” yet.'; }
    else {
      const reacts = entangle.activeReactsToCrowd();
      if (reacts && m.skeleton) msg = '✓ field reacting + skeletons drawing.';
      else if (reacts)          msg = '✓ the field is reacting to the crowd.';
      else if (m.skeleton)      msg = '✓ skeletons drawing (this quale doesn’t map crowd motion to the field).';
      else { msg = `this quale ignores the crowd — switch to: ${crowdReactiveLabels} (or turn on ⛓ skeletons).`; warn = true; }
    }
    hint.textContent = msg;
    hint.style.color = warn ? 'var(--amber,#fbbf24)' : '';
  }

  // ── Modal interactions (event-delegated) ──────────────────────────────────
  modal.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act],[data-mode],[data-wl]');
    if (!el) return;
    if (el.dataset.mode)  { entangle.setMode(el.dataset.mode, !entangle.getModes()[el.dataset.mode]); render(); return; }
    if (el.dataset.wl)    { entangle.toggleWhitelist(el.dataset.wl); render(); return; }
    switch (el.dataset.act) {
      case 'close': hide(); break;
      case 'openroom': {
        el.disabled = true; el.textContent = 'opening…';
        try { await entangle.open(); setLive(true); } catch (err) { console.error('[entangle] open failed', err); alert('Could not open the field — check your network.'); }
        render();
        break;
      }
      case 'closeroom': entangle.close(); setLive(false); render(); break;
      case 'copy': {
        const url = entangle.getJoinUrl();
        if (url) { try { await navigator.clipboard.writeText(url); el.textContent = 'copied!'; setTimeout(() => (el.textContent = 'copy link'), 1200); } catch {} }
        break;
      }
      case 'autovote': { entangle.setAutoVote(!entangle.getAutoVote()); render(); break; }
      case 'applyvote': { const id = entangle.applyWinningVote(); if (id) setTimeout(render, 50); break; }
    }
  });

  // ── Live updates ──────────────────────────────────────────────────────────
  entangle.onPeersChange((n) => {
    hudN.textContent = String(n);
    const nEl = modal.querySelector('[data-n]'); if (nEl) nEl.textContent = String(n);
  });
  entangle.onTallyChange(() => { if (open) render(); });
  entangle.onAutoVote(() => { if (open) render(); });   // reflect the new active scene in the tally promptly
  entangle.onPhaseCharge((have, need, fired) => {
    const el = modal.querySelector('[data-phase]');
    if (!el) return;
    el.textContent = fired
      ? '⟳ phase shifted by the crowd!'
      : `shift charge: ${have} / ${need} — the crowd taps together to advance the phase`;
    el.style.color = fired ? 'var(--cyan,#22d3ee)' : '';
    if (fired) setTimeout(() => { const e2 = modal.querySelector('[data-phase]'); if (e2) e2.style.color = ''; }, 1500);
  });

  // Drive the live crowd-signal meter while the panel is open.
  setInterval(updateCrowdSig, 250);

  // Detect scene (active fx) changes → refresh manifest + whitelist UI.
  let lastFx = core.activeId();
  setInterval(() => {
    if (!entangle.isOpen() && !open) return;
    const cur = core.activeId();
    if (cur !== lastFx) {
      lastFx = cur;
      if (entangle.isOpen()) entangle.broadcastManifest();
      if (open) render();
    }
  }, 700);

  return entangle;
}
