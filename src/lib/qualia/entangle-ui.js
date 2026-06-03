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

const STYLE_ID = 'entangle-style';
const CSS = `
#entangle-launch{display:inline-flex;align-items:center;gap:.35rem}
#entangle-launch[data-live="1"]{color:var(--cyan,#22d3ee);border-color:var(--cyan,#22d3ee)}
#entangle-dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--cyan,#22d3ee);box-shadow:0 0 .4rem var(--cyan,#22d3ee);display:none}
#entangle-launch[data-live="1"] #entangle-dot{display:inline-block;animation:ent-pulse 1.6s ease-in-out infinite}
@keyframes ent-pulse{0%,100%{opacity:.35}50%{opacity:1}}
#entangle-backdrop{position:fixed;inset:0;background:rgba(2,2,8,.62);backdrop-filter:blur(3px);z-index:40;display:none}
#entangle-modal{position:fixed;z-index:41;top:50%;left:50%;transform:translate(-50%,-50%);
  width:min(30rem,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);overflow:auto;
  background:linear-gradient(180deg,#0b0b18,#070710);border:1px solid var(--accent,#8b5cf6);
  border-radius:.8rem;box-shadow:0 0 2rem rgba(139,92,246,.35);color:var(--text,#e9e6ff);
  font:13px/1.45 ui-monospace,monospace;display:none;padding:1rem 1.1rem 1.2rem}
#entangle-modal h2{margin:0;font-size:1rem;letter-spacing:.04em;color:var(--text,#e9e6ff);font-weight:600;
  display:flex;align-items:center;gap:.5rem}
#entangle-modal .ent-sub{color:#9b96c4;font-size:.78rem;margin:.15rem 0 .9rem}
#entangle-modal .ent-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem}
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
#entangle-hud{position:fixed;left:max(.6rem,env(safe-area-inset-left));bottom:max(.6rem,env(safe-area-inset-bottom));
  z-index:16;display:none;align-items:center;gap:.45rem;padding:.3rem .6rem;border-radius:.5rem;
  background:rgba(8,7,18,.7);border:1px solid var(--cyan,#22d3ee);color:var(--cyan,#22d3ee);
  font:12px/1 ui-monospace,monospace;pointer-events:none}
#entangle-hud[data-live="1"]{display:inline-flex}
`;

export function initEntangleUI({ core, mesh, actions = {} }) {
  const entangle = createEntangle({ core, mesh, actions });

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

  // ── Modal ─────────────────────────────────────────────────────────────────
  const backdrop = document.createElement('div'); backdrop.id = 'entangle-backdrop';
  const modal = document.createElement('div');
  modal.id = 'entangle-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  document.body.append(backdrop, modal);

  let open = false;
  function show() { open = true; backdrop.style.display = modal.style.display = 'block'; render(); }
  function hide() { open = false; backdrop.style.display = modal.style.display = 'none'; }
  launch.addEventListener('click', () => (open ? hide() : show()));
  backdrop.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) hide(); });

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
        <div class="ent-row"><button data-act="applyvote" ${tally.length ? '' : 'disabled'}>switch to top vote</button></div>
      </div>` : ''}
    `;

    if (live && url) {
      const canvas = modal.querySelector('#entangle-qr');
      import('./qr.js').then(m => m.renderQR(canvas, url, 300)).catch(err => console.warn('[entangle] qr', err));
    }
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
      case 'applyvote': { const id = entangle.applyWinningVote(); if (id) setTimeout(render, 50); break; }
    }
  });

  // ── Live updates ──────────────────────────────────────────────────────────
  entangle.onPeersChange((n) => {
    hudN.textContent = String(n);
    const nEl = modal.querySelector('[data-n]'); if (nEl) nEl.textContent = String(n);
  });
  entangle.onTallyChange(() => { if (open) render(); });
  entangle.onPhaseCharge((have, need, fired) => {
    const el = modal.querySelector('[data-phase]');
    if (!el) return;
    el.textContent = fired
      ? '⟳ phase shifted by the crowd!'
      : `shift charge: ${have} / ${need} — the crowd taps together to advance the phase`;
    el.style.color = fired ? 'var(--cyan,#22d3ee)' : '';
    if (fired) setTimeout(() => { const e2 = modal.querySelector('[data-phase]'); if (e2) e2.style.color = ''; }, 1500);
  });

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
