// Mouse cursor trail. Two compositable layers:
//   • dots — pooled particle bursts at the cursor (smaller than the bookmarklet
//     to avoid the over-fed look the user pointed out)
//   • line — a smooth fading trail through recent cursor positions, drawn as
//     overlapping quadratic-curve segments with diminishing width and alpha
//
// Five user-facing modes:
//   off       — no overlay, rAF stopped
//   dots      — white dots only
//   cyan      — cyan dots only
//   line      — white smooth line only
//   combined  — white line + cyan dots overlaid
//
// Both layers render to one shared transparent canvas with mix-blend-mode:
// screen so highlights stack cleanly over the voidstar fx.

const COLORS = {
  white: { core: [232, 236, 248], glow: [220, 230, 255] },
  cyan:  { core: [120, 240, 255], glow: [40, 180, 240]  },
};
export const MODES = ['off', 'dots', 'cyan', 'line', 'combined'];

function configFor(mode) {
  switch (mode) {
    case 'dots':     return { dots: 'white', line: null    };
    case 'cyan':     return { dots: 'cyan',  line: null    };
    case 'line':     return { dots: null,    line: 'white' };
    case 'combined': return { dots: 'cyan',  line: 'white' };
    default:         return { dots: null,    line: null    };
  }
}

const MAX_PARTICLES = 192;
const LINE_MAX      = 28;            // ring buffer length for the smooth line
const LINE_LIFE_MS  = 420;           // points older than this are pruned
const STORAGE_KEY   = 'voidstar.qualia.cursorFx';

export function createCursorFx() {
  let canvas = null, ctx = null;
  let mode   = 'off';
  let raf    = null;
  let lastT  = 0;

  // Dot particle pool — parallel Float32Arrays so spawn is allocation-free.
  const px  = new Float32Array(MAX_PARTICLES);
  const py  = new Float32Array(MAX_PARTICLES);
  const pvx = new Float32Array(MAX_PARTICLES);
  const pvy = new Float32Array(MAX_PARTICLES);
  const pt  = new Float32Array(MAX_PARTICLES);
  const psz = new Float32Array(MAX_PARTICLES);
  let head = 0;

  // Line buffer — chronological list of recent cursor positions.
  const lx  = new Float32Array(LINE_MAX);
  const ly  = new Float32Array(LINE_MAX);
  const lt  = new Float32Array(LINE_MAX);
  let lineCount = 0;
  let lineHead  = 0;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'cursor-fx-canvas';
    canvas.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none',
      'z-index:999', 'mix-blend-mode:screen',
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

  function spawnDot(x, y) {
    const i = head;
    px[i] = x; py[i] = y;
    const ang = Math.random() * Math.PI * 2;
    const sp  = 6 + Math.random() * 18;
    pvx[i] = Math.cos(ang) * sp;
    pvy[i] = Math.sin(ang) * sp;
    pt[i]  = 1.0;
    // ~1.6× smaller than before — the user wants something closer to the
    // bookmarklet's 8 px dots that shrink fast.
    psz[i] = 2.5 + Math.random() * 1.8;
    head = (head + 1) % MAX_PARTICLES;
  }
  function pushLinePoint(x, y, now) {
    lx[lineHead] = x;
    ly[lineHead] = y;
    lt[lineHead] = now;
    lineHead = (lineHead + 1) % LINE_MAX;
    if (lineCount < LINE_MAX) lineCount++;
  }
  function pruneLine(now) {
    while (lineCount > 0) {
      const oldestIdx = (lineHead - lineCount + LINE_MAX) % LINE_MAX;
      if (now - lt[oldestIdx] <= LINE_LIFE_MS) break;
      lineCount--;
    }
  }

  function onMove(e) {
    const cfg = configFor(mode);
    if (cfg.dots) spawnDot(e.clientX, e.clientY);
    if (cfg.line) pushLinePoint(e.clientX, e.clientY, performance.now());
  }

  function drawDots(palName) {
    const pal = COLORS[palName];
    const gR = pal.glow[0], gG = pal.glow[1], gB = pal.glow[2];
    ctx.globalCompositeOperation = 'lighter';
    // Glow halo pass first, then sharp core pass — gives a soft bloom that
    // reads well over the dark background of the lab.
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const t = pt[i];
      if (t <= 0) continue;
      const r = psz[i] * (0.4 + 0.6 * t);
      ctx.fillStyle = `rgba(${gR},${gG},${gB},${(0.30 * t).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px[i], py[i], r * 2.6, 0, Math.PI * 2);
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
  }

  function drawLine(palName, now) {
    if (lineCount < 2) return;
    const pal = COLORS[palName];
    const cR = pal.core[0], cG = pal.core[1], cB = pal.core[2];
    const startIdx = (lineHead - lineCount + LINE_MAX) % LINE_MAX;
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';

    // Two-pass stroke: a soft wide pass for glow, then a sharper narrow
    // pass for the core line. Each segment carries its own width and alpha
    // so the trail naturally tapers from the cursor (head, age 0) to the
    // tail (oldest, age ≈ LINE_LIFE_MS).
    for (let pass = 0; pass < 2; pass++) {
      const widthMul = pass === 0 ? 3.2 : 1.0;     // glow vs core
      const alphaMul = pass === 0 ? 0.22 : 0.95;
      for (let i = 0; i < lineCount - 1; i++) {
        const k0 = (startIdx + i)     % LINE_MAX;
        const k1 = (startIdx + i + 1) % LINE_MAX;
        const ageHead = (now - lt[k1]) / LINE_LIFE_MS;     // 0=fresh, 1=stale
        const t = Math.max(0, 1 - ageHead);
        if (t <= 0) continue;
        const tt = t * t;
        const w  = Math.max(0.4, 5.0 * tt * widthMul);
        const a  = tt * alphaMul;
        ctx.lineWidth = w;
        ctx.strokeStyle = `rgba(${cR},${cG},${cB},${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(lx[k0], ly[k0]);
        if (i + 2 < lineCount) {
          // Smooth via quadratic curve through midpoints — classic trick
          // for taking a polyline and giving it C1 continuity at vertices.
          const k2 = (startIdx + i + 2) % LINE_MAX;
          ctx.quadraticCurveTo(lx[k1], ly[k1],
                               (lx[k1] + lx[k2]) * 0.5,
                               (ly[k1] + ly[k2]) * 0.5);
        } else {
          ctx.lineTo(lx[k1], ly[k1]);
        }
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function tick(now) {
    if (mode === 'off' || !ctx) { raf = null; return; }
    const dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);

    const cfg = configFor(mode);

    // Advance dot particles even when mode doesn't include dots, so a mode
    // switch from 'dots'→'line' fades the lingering dots out instead of
    // hard-cutting them.
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (pt[i] <= 0) continue;
      pt[i]  -= dt * 1.7;
      px[i]  += pvx[i] * dt;
      py[i]  += pvy[i] * dt;
      pvx[i] *= 0.92;
      pvy[i] *= 0.92;
    }
    pruneLine(now);

    if (cfg.line) drawLine(cfg.line, now);
    if (cfg.dots) drawDots(cfg.dots);

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
    for (let i = 0; i < MAX_PARTICLES; i++) pt[i] = 0;
    lineCount = 0;
  }

  function setMode(next) {
    if (!MODES.includes(next)) next = 'off';
    if (next === mode) return mode;
    mode = next;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
    if (mode === 'off') stop(); else start();
    return mode;
  }

  function loadStored() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      // Old palette names (silver/platinum/voidblue/inferno) → fold into
      // the new mode set so a returning user doesn't land on `off`.
      const migrate = {
        silver: 'dots', platinum: 'dots',
        voidblue: 'cyan', inferno: 'cyan',
      };
      const v2 = migrate[v] || v;
      if (v2 && MODES.includes(v2)) setMode(v2);
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
