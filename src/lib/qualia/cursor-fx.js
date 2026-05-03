// Mouse cursor trail — a pooled-particle Canvas2D effect that mirrors the
// vibe of the live-coder bookmarklet trick but renders to ONE canvas with
// pooled state instead of spawning a DOM node per pointer event. This keeps
// the trail smooth even during heavy fragment-shader work elsewhere on the
// page; the bookmarklet approach pegs layout/style on the main thread.
//
// Modes share the voidstar palette family:
//   silver / platinum / voidblue / inferno
// Plus an explicit `off`. Settings are persisted in localStorage so the
// trail mode survives reloads.
//
// The animation loop only runs while a non-`off` mode is active, so when
// disabled there's no per-frame overhead.

const PALETTES = {
  silver:   { core: [232, 236, 248], glow: [200, 220, 255], glowAlpha: 0.45 },
  platinum: { core: [240, 240, 250], glow: [180, 180, 220], glowAlpha: 0.40 },
  voidblue: { core: [220, 245, 255], glow: [60, 160, 255],  glowAlpha: 0.55 },
  inferno:  { core: [255, 220, 180], glow: [255, 110, 30],  glowAlpha: 0.55 },
};
export const MODES = ['off', 'silver', 'platinum', 'voidblue', 'inferno'];

const MAX_PARTICLES = 256;
const STORAGE_KEY   = 'voidstar.qualia.cursorFx';

export function createCursorFx() {
  let canvas = null, ctx = null;
  let mode   = 'off';
  let raf    = null;
  let lastT  = 0;

  // Pool: pre-allocated parallel arrays (no per-particle object allocations).
  const px   = new Float32Array(MAX_PARTICLES);
  const py   = new Float32Array(MAX_PARTICLES);
  const pvx  = new Float32Array(MAX_PARTICLES);
  const pvy  = new Float32Array(MAX_PARTICLES);
  const pt   = new Float32Array(MAX_PARTICLES);   // life remaining 0..1
  const psz  = new Float32Array(MAX_PARTICLES);
  let head = 0;                                    // ring index of next slot
  let alive = 0;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'cursor-fx-canvas';
    canvas.style.cssText = [
      'position:fixed', 'inset:0',
      'pointer-events:none',
      'z-index:999',                  // below status overlay (z 30) and topbar (20)
      'mix-blend-mode:screen',
    ].join(';');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    sizeCanvas();
    window.addEventListener('resize', sizeCanvas);
  }

  function sizeCanvas() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width  = Math.floor(window.innerWidth  * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width  = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(x, y) {
    const i = head;
    px[i] = x; py[i] = y;
    // Tiny outward velocity so trailing particles spread slightly.
    const ang = Math.random() * Math.PI * 2;
    const sp  = 8 + Math.random() * 24;
    pvx[i] = Math.cos(ang) * sp;
    pvy[i] = Math.sin(ang) * sp;
    pt[i]  = 1.0;
    psz[i] = 5 + Math.random() * 4;
    head = (head + 1) % MAX_PARTICLES;
    if (alive < MAX_PARTICLES) alive++;
  }

  function onMove(e) {
    if (mode === 'off') return;
    spawn(e.clientX, e.clientY);
  }

  function tick(now) {
    if (mode === 'off' || !ctx) { raf = null; return; }
    const dt  = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;
    const pal = PALETTES[mode] || PALETTES.silver;
    const W   = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);

    // Two-pass render: glow halos first (additive feel via screen-blend on
    // the canvas), then bright cores on top.
    ctx.globalCompositeOperation = 'lighter';
    const gR = pal.glow[0], gG = pal.glow[1], gB = pal.glow[2];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const t = pt[i];
      if (t <= 0) continue;
      const tNext = t - dt * 1.6;             // ~0.6 sec lifespan
      pt[i] = tNext;
      if (tNext <= 0) { alive = Math.max(0, alive - 1); continue; }
      px[i]  += pvx[i] * dt;
      py[i]  += pvy[i] * dt;
      pvx[i] *= 0.92;                         // friction
      pvy[i] *= 0.92;
      const r = psz[i] * (0.4 + 0.6 * tNext);
      const a = pal.glowAlpha * tNext;
      ctx.fillStyle = `rgba(${gR},${gG},${gB},${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px[i], py[i], r * 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
    const cR = pal.core[0], cG = pal.core[1], cB = pal.core[2];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const t = pt[i];
      if (t <= 0) continue;
      const r = psz[i] * (0.4 + 0.6 * t);
      ctx.fillStyle = `rgba(${cR},${cG},${cB},${t.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px[i], py[i], r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    raf = requestAnimationFrame(tick);
  }

  function start() {
    ensureCanvas();
    document.addEventListener('mousemove', onMove);
    if (!raf) {
      lastT = performance.now();
      raf   = requestAnimationFrame(tick);
    }
  }
  function stop() {
    document.removeEventListener('mousemove', onMove);
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    // Fast-decay any in-flight particles so re-enabling doesn't show stragglers.
    for (let i = 0; i < MAX_PARTICLES; i++) pt[i] = 0;
    alive = 0;
  }

  function setMode(next) {
    if (!MODES.includes(next)) next = 'off';
    if (next === mode) return mode;
    mode = next;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
    if (mode === 'off') stop();
    else                start();
    return mode;
  }

  function loadStored() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v && MODES.includes(v)) setMode(v);
    } catch {}
  }

  return {
    setMode,
    getMode: () => mode,
    cycle: () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]),
    loadStored,
    modes: MODES,
  };
}
