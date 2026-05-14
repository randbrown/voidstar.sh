// Dark Space — void-cosmology visualizer. Five modes paint different
// faces of the dark universe:
//   - cosmic_web   Galaxies clustered along filaments wrapping dark voids,
//                  with an in-frame galaxy-count label and the occasional
//                  shooting-star streak. (Sachs–Wolfe void-shape inspired.)
//   - voids        Closer look at a few prominent voids — circle/ellipse
//                  outlines + labels (MILKYWAY, LOCAL VOID, …).
//                  (VoidFinder-style boundary callouts.)
//   - dark_matter  Scribbly thin filamentous flow-field lines on a dim
//                  teal field — the "ghost web" of dark matter halos.
//   - dark_energy  Central column of stretched galaxies with vertical
//                  wavy lines on either side bowing outward — visualises
//                  the cosmological expansion w(z).
//   - void_growth  Single void expanding from centre over time; galaxies
//                  near the boundary flee outward (DIVA dynamical view).
//
// Audio map (all modes):
//   bands.bass   → void breathing + expansion rate (declarative on voidSize)
//   bands.mids   → galaxy density (declarative on density)
//   bands.highs  → twinkle amplitude (declarative on twinkle)
//   beat.pulse   → shockwave + filament glow boost
//   rms          → global haze / atmosphere
//
// Pose map (optional):
//   shoulderSpan → camera proximity (cosmic_web zoom + void_growth radius)
//   head.x/y     → drifts cosmic centre so the user feels they're moving
//                  through the volume

import { scaleAudio } from '../field.js';

const MAX_GALAXIES   = 4000;
const NUM_VOIDS      = 8;
const NUM_FLOW_LINES = 96;          // dark_matter trails
const FLOW_HISTORY   = 28;          // points retained per flow line
const NUM_EXPANSION_LINES_SIDE = 6; // dark_energy lines per side
const EXP_LINE_POINTS = 64;
const NUM_DE_GALAXIES = 18;         // dark_energy central column
const PI = Math.PI;
const TAU = PI * 2;

// Palettes — colour stops keyed by role.
//   bg       page wash (kept very dark so screen blend with hydra reads)
//   galaxy   small point light
//   filament thin connecting strand
//   wall     wall/cluster glow
//   accent   labels + special marks
const PALETTES = {
  voidblue: { bg: [4, 6, 12],   galaxy: [220, 232, 245], filament: [120, 165, 200], wall: [70, 110, 150], accent: [200, 220, 240] },
  mono:     { bg: [6, 8, 10],   galaxy: [235, 240, 245], filament: [150, 170, 185], wall: [90, 105, 120], accent: [220, 230, 240] },
  violet:   { bg: [8, 4, 16],   galaxy: [225, 215, 250], filament: [170, 130, 220], wall: [110, 70, 165], accent: [220, 195, 245] },
  inferno:  { bg: [10, 4, 4],   galaxy: [255, 235, 200], filament: [210, 130, 70],  wall: [160, 60, 30],  accent: [240, 180, 110] },
};

// Non-deterministic-looking but stable scalar hash — used to keep void
// placements consistent across resizes (we don't reseed each frame).
function hash(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'dark_space',
  name: 'Dark Space',
  contextType: 'canvas2d',

  params: [
    { id: 'mode', label: 'mode', type: 'select',
      options: ['cosmic_web', 'voids', 'dark_matter', 'dark_energy', 'void_growth'],
      default: 'cosmic_web' },
    { id: 'density',           label: 'density',     type: 'range', min: 0.2, max: 2.0, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.mids', mode: 'mul', amount: 0.30 },
      ] },
    { id: 'voidSize',          label: 'void size',   type: 'range', min: 0.4, max: 2.0, step: 0.02, default: 1.0,
      modulators: [
        { source: 'audio.bass', mode: 'mul', amount: 0.25 },
      ] },
    { id: 'expansion',         label: 'expansion',   type: 'range', min: 0,   max: 3.0, step: 0.05, default: 1.0 },
    { id: 'filamentBrightness',label: 'filaments',   type: 'range', min: 0,   max: 2.5, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.beatPulse', mode: 'add', amount: 0.40 },
      ] },
    { id: 'twinkle',           label: 'twinkle',     type: 'range', min: 0,   max: 2.0, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.highs', mode: 'mul', amount: 0.50 },
      ] },
    { id: 'palette',           label: 'palette',     type: 'select',
      options: ['voidblue', 'mono', 'violet', 'inferno'], default: 'voidblue' },
    { id: 'showLabels',        label: 'labels',      type: 'toggle', default: false },
    { id: 'poseBind',          label: 'pose bind',   type: 'toggle', default: true },
    { id: 'reactivity',        label: 'reactivity',  type: 'range', min: 0,   max: 2.0, step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks the five cosmological modes — the topbar `phase`
  // button surfaces every face without the user touching the dropdown.
  autoPhase: {
    steps: [
      { mode: 'cosmic_web' },
      { mode: 'voids' },
      { mode: 'dark_matter' },
      { mode: 'dark_energy' },
      { mode: 'void_growth' },
    ],
  },

  presets: {
    default:    { mode: 'cosmic_web', density: 1.0, voidSize: 1.0, expansion: 1.0, filamentBrightness: 1.0, twinkle: 1.0, palette: 'voidblue', showLabels: false, poseBind: true, reactivity: 1.0 },
    cosmic:     { mode: 'cosmic_web', density: 1.3, voidSize: 0.9, filamentBrightness: 1.2, palette: 'voidblue' },
    voids:      { mode: 'voids',      voidSize: 1.2, density: 1.1, showLabels: true, palette: 'voidblue' },
    darkMatter: { mode: 'dark_matter', density: 1.4, filamentBrightness: 1.4, palette: 'mono' },
    darkEnergy: { mode: 'dark_energy', expansion: 1.6, filamentBrightness: 1.0, palette: 'voidblue' },
    voidGrowth: { mode: 'void_growth', voidSize: 1.0, expansion: 1.4, palette: 'voidblue' },
    ambient:    { mode: 'cosmic_web', density: 0.6, voidSize: 1.1, expansion: 0.5, filamentBrightness: 0.6, twinkle: 0.6, palette: 'voidblue' },
    inferno:    { mode: 'cosmic_web', palette: 'inferno', density: 1.1, filamentBrightness: 1.3 },
  },

  async create(canvas, /* { ctx } */ opts) {
    const ctx = opts.ctx;
    let W = canvas.width, H = canvas.height;

    // ── Galaxies (fixed positions, randomized per session) ─────────────────
    // Each galaxy has a normalized [0,1]² home + a small per-frame jitter
    // for shimmer. A small fraction are "spiral" galaxies rendered as tiny
    // ellipses (gel > 0); the rest are pinpoint lights.
    const gx  = new Float32Array(MAX_GALAXIES);
    const gy  = new Float32Array(MAX_GALAXIES);
    const gz  = new Float32Array(MAX_GALAXIES);   // depth proxy [0..1]
    const gsz = new Float32Array(MAX_GALAXIES);   // base radius (px-equivalent)
    const gel = new Float32Array(MAX_GALAXIES);   // elongation 0=point, >0=spiral
    const gor = new Float32Array(MAX_GALAXIES);   // orientation
    const gph = new Float32Array(MAX_GALAXIES);   // twinkle phase
    const gtw = new Float32Array(MAX_GALAXIES);   // twinkle freq
    for (let i = 0; i < MAX_GALAXIES; i++) {
      gx[i]  = Math.random();
      gy[i]  = Math.random();
      gz[i]  = Math.random();
      // Heavy bias toward small dots; rare bright larger ones for variety.
      gsz[i] = 0.45 + Math.random() * Math.random() * 3.4;
      gel[i] = Math.random() < 0.05 ? 0.30 + Math.random() * 0.55 : 0;
      gor[i] = Math.random() * PI;
      gph[i] = Math.random() * TAU;
      gtw[i] = 0.6 + Math.random() * 2.0;
    }

    // ── Voids (cosmic underdensities) ──────────────────────────────────────
    // Stable through resizes — we want the same skeleton for the user's
    // session. Rebalance positions roughly so they don't all clump.
    const vx  = new Float32Array(NUM_VOIDS);
    const vy  = new Float32Array(NUM_VOIDS);
    const vr  = new Float32Array(NUM_VOIDS);
    const vph = new Float32Array(NUM_VOIDS);
    const vfr = new Float32Array(NUM_VOIDS);
    for (let i = 0; i < NUM_VOIDS; i++) {
      // Quasi-grid jitter: 4 cols × 2 rows with random offset inside cell.
      const col = i % 4, row = (i / 4) | 0;
      vx[i]  = (col + 0.20 + Math.random() * 0.60) / 4;
      vy[i]  = (row + 0.15 + Math.random() * 0.70) / 2;
      vr[i]  = 0.085 + Math.random() * 0.095;
      vph[i] = Math.random() * TAU;
      vfr[i] = 0.18 + Math.random() * 0.35;       // breath frequency rad/s
    }

    // ── Dark-matter flow lines ─────────────────────────────────────────────
    // Each "line" is a head + N-point trailing buffer. Heads advance through
    // a noise-driven flow field; trailing positions render as a short curve.
    const flx = new Float32Array(NUM_FLOW_LINES * FLOW_HISTORY);
    const fly = new Float32Array(NUM_FLOW_LINES * FLOW_HISTORY);
    const flh = new Int16Array(NUM_FLOW_LINES);   // head index in ring buffer
    const flLife = new Float32Array(NUM_FLOW_LINES); // 0..1, 1 = fresh
    function seedFlowLine(i) {
      const sx = Math.random(), sy = Math.random();
      for (let k = 0; k < FLOW_HISTORY; k++) {
        flx[i * FLOW_HISTORY + k] = sx;
        fly[i * FLOW_HISTORY + k] = sy;
      }
      flh[i] = 0;
      flLife[i] = 0.4 + Math.random() * 0.6;
    }
    for (let i = 0; i < NUM_FLOW_LINES; i++) seedFlowLine(i);

    // ── Dark-energy central-column galaxies (stretched verticals) ──────────
    const dex = new Float32Array(NUM_DE_GALAXIES);
    const dey = new Float32Array(NUM_DE_GALAXIES);
    const desz = new Float32Array(NUM_DE_GALAXIES);
    const dehalo = new Float32Array(NUM_DE_GALAXIES); // glow flag 0..1
    for (let i = 0; i < NUM_DE_GALAXIES; i++) {
      dex[i] = 0.5 + (Math.random() - 0.5) * 0.04;
      dey[i] = 0.04 + (i / (NUM_DE_GALAXIES - 1)) * 0.92 + (Math.random() - 0.5) * 0.018;
      desz[i] = 1.2 + Math.random() * 2.6;
      dehalo[i] = (i === 0 || i === Math.floor(NUM_DE_GALAXIES / 2.5)) ? 1 : 0;
    }

    // Shooting-star (cosmic_web mode only) — single comet that re-spawns at
    // random intervals. Decorative: the reference image shows one.
    let starX = 0.5, starY = 0.5, starVx = 0, starVy = 0, starLife = 0;
    function spawnShootingStar() {
      const ang = Math.random() * TAU;
      const sp  = 0.30 + Math.random() * 0.20;
      starVx   = Math.cos(ang) * sp;
      starVy   = Math.sin(ang) * sp;
      starX    = 0.15 + Math.random() * 0.70;
      starY    = 0.15 + Math.random() * 0.70;
      starLife = 1.0;
    }

    // Void-growth radius integrator — accumulates over time, snaps back when
    // it overflows the screen. Bass + expansion drive growth rate.
    let growR = 0.05;

    // Centre drift (autonomous + pose-driven). Like gargantua-void this is
    // smoothed so pose noise doesn't snap.
    let cx = 0.5, cy = 0.5;
    let proximity = 0;

    // Stored galaxy count for the cosmic_web HUD label. Recomputed every
    // ~250ms so the number doesn't strobe with twinkle.
    let lastCountAt = -1;
    let visibleCount = 0;

    // Per-frame scratch (rendered exclusively from this — render() never
    // reads field directly).
    const scratch = {
      time: 0, dt: 0,
      mode: 'cosmic_web',
      bass: 0, mids: 0, highs: 0, total: 0, rms: 0,
      beatActive: false, beatP: 0, hardKick: 0,
      density: 1, voidSize: 1, expansion: 1,
      filamentBri: 1, twinkle: 1,
      pal: PALETTES.voidblue,
      showLabels: true,
      poseBind: true,
      headOffsetX: 0, headOffsetY: 0,
    };

    // ── Update — flow-field sampling for dark_matter, void breathing,
    // shooting-star physics, pose smoothing, etc.
    function update(field) {
      const { dt, time, params, pose } = field;
      const audio = scaleAudio(field.audio, params.reactivity);

      scratch.time     = time;
      scratch.dt       = dt;
      scratch.mode     = params.mode || 'cosmic_web';
      scratch.bass     = audio.bands.bass;
      scratch.mids     = audio.bands.mids;
      scratch.highs    = audio.bands.highs;
      scratch.total    = audio.bands.total;
      scratch.rms      = audio.rms;
      scratch.beatActive = audio.beat.active;
      scratch.beatP    = audio.beat.pulse;
      scratch.density  = params.density;
      scratch.voidSize = params.voidSize;
      scratch.expansion = params.expansion;
      scratch.filamentBri = params.filamentBrightness;
      scratch.twinkle  = params.twinkle;
      scratch.pal      = PALETTES[params.palette] || PALETTES.voidblue;
      scratch.showLabels = !!params.showLabels;
      scratch.poseBind = !!params.poseBind;

      // ── Pose-driven centre drift ────────────────────────────────────────
      // shoulderSpan → proximity for cosmic_web zoom + void_growth radius
      // head.x/y     → small lateral drift on the cosmic centre
      let proxTarget = 0, headX = 0, headY = 0;
      if (params.poseBind && pose.people.length > 0) {
        const p0 = pose.people[0];
        const sL = p0.shoulders?.l, sR = p0.shoulders?.r, head = p0.head;
        if (sL && sR && sL.visibility > 0.4 && sR.visibility > 0.4) {
          const sx = sR.x - sL.x, sy = sR.y - sL.y;
          const span = Math.sqrt(sx * sx + sy * sy);
          proxTarget = Math.max(-1, Math.min(1, (span - 0.25) / 0.20));
        }
        if (head && head.visibility > 0.3) {
          headX = (1 - head.x - 0.5) * 2;            // mirrored x in [-1..1]
          headY = (head.y - 0.5) * 2;
        }
      }
      const k = Math.min(1, dt * 2.5);
      proximity += (proxTarget - proximity) * k;
      scratch.headOffsetX = headX * 0.04;
      scratch.headOffsetY = headY * 0.04;

      // ── Centre drift (slow autonomous + pose) ───────────────────────────
      const tx = 0.5 + 0.015 * Math.sin(time * 0.07) + scratch.headOffsetX;
      const ty = 0.5 + 0.012 * Math.cos(time * 0.09) + scratch.headOffsetY;
      cx += (tx - cx) * Math.min(1, dt * 1.5);
      cy += (ty - cy) * Math.min(1, dt * 1.5);

      // ── Mode-specific updates ───────────────────────────────────────────
      if (scratch.mode === 'dark_matter') {
        // Advance flow lines through a 2-octave noise-derived curl field.
        // The "field" is just sin/cos of low-frequency phases summed at
        // different scales — cheap, smooth, no allocation.
        const flowSpeed = 0.05 + scratch.mids * 0.10 + scratch.beatP * 0.06;
        for (let i = 0; i < NUM_FLOW_LINES; i++) {
          const headIdx = flh[i];
          const baseOff = i * FLOW_HISTORY;
          const px = flx[baseOff + headIdx];
          const py = fly[baseOff + headIdx];

          const a = Math.sin(px * 9.7 + py * 7.3 + time * 0.18 + i * 0.13)
                  + Math.sin(px * 18.3 + py * 14.1 + time * 0.27) * 0.45;
          const b = Math.cos(px * 8.2 + py * 11.5 + time * 0.21 + i * 0.17)
                  + Math.cos(px * 17.0 + py * 13.6 + time * 0.31) * 0.45;
          // Curl-ish deflection — perpendicular to gradient gives swirl.
          const dx = a * 0.0050 * flowSpeed * 60 * dt;
          const dy = b * 0.0050 * flowSpeed * 60 * dt;
          let nx = px + dx, ny = py + dy;

          flLife[i] -= dt * 0.35;
          // Re-spawn lines that wandered offscreen or aged out so the
          // density remains roughly constant.
          if (flLife[i] <= 0 || nx < -0.05 || nx > 1.05 || ny < -0.05 || ny > 1.05) {
            seedFlowLine(i);
            continue;
          }
          const newHead = (headIdx + 1) % FLOW_HISTORY;
          flx[baseOff + newHead] = nx;
          fly[baseOff + newHead] = ny;
          flh[i] = newHead;
        }
      } else if (scratch.mode === 'cosmic_web' && Math.random() < dt * 0.30) {
        // ~30% chance per second to fire a comet — feels intermittent,
        // never deterministic.
        spawnShootingStar();
      }

      // Shooting star physics — always update so a star already in flight
      // continues even after a mode switch (cosmetic only; cheap).
      if (starLife > 0) {
        starX += starVx * dt;
        starY += starVy * dt;
        starLife -= dt * 0.55;
      }

      // Void-growth integrator. Re-uses the `expansion` slider as the rate
      // (with a baseline so it always grows even at expansion=0 idle).
      if (scratch.mode === 'void_growth') {
        const rate = (0.04 + scratch.expansion * 0.05) * (1.0 + scratch.bass * 0.6);
        growR += rate * dt;
        if (growR > 0.95) growR = 0.05;             // reset to "infant" void
      } else {
        // Decay back to a visible default so re-entering the mode starts
        // from the seed radius rather than wherever the param drift left it.
        const target = 0.05;
        growR += (target - growR) * Math.min(1, dt * 0.4);
      }

      // Cheap visible-count for the cosmic_web HUD chip. Every ~250ms,
      // sample a stride of the galaxy array against the live void mask
      // and extrapolate. Avoids a full pass per frame; the digit stability
      // matches the reference image more than rapid scrolling would.
      if (scratch.mode === 'cosmic_web' && (time - lastCountAt) > 0.25) {
        lastCountAt = time;
        const breath = scratch.voidSize;
        let count = 0;
        const step = 11;                         // sample every 11th galaxy
        const N = Math.min(MAX_GALAXIES, (MAX_GALAXIES * scratch.density) | 0);
        for (let i = 0; i < N; i += step) {
          const x = gx[i], y = gy[i];
          let inside = 0;
          for (let v = 0; v < NUM_VOIDS; v++) {
            const ddx = x - vx[v], ddy = y - vy[v];
            const d2 = ddx * ddx + ddy * ddy;
            const r = vr[v] * breath;
            if (d2 < r * r) { inside = 1; break; }
          }
          if (!inside) count++;
        }
        // Extrapolate sparsely-sampled count back to galaxy-population scale.
        // A small hash-jitter on the stable count keeps the digit alive
        // without making it strobe.
        const extrapolated = (count * step) | 0;
        const jitter = ((Math.sin(time * 0.7) + 1) * 7.5) | 0;
        visibleCount = extrapolated + jitter;
      }
    }

    // ── Helpers shared across renderers ────────────────────────────────────
    function rgba(arr, a) {
      return `rgba(${arr[0]},${arr[1]},${arr[2]},${a.toFixed(3)})`;
    }
    function clearBg() {
      const pal = scratch.pal;
      // Trails-friendly fade: bass slightly opens it up so the void
      // looks like it breathes.
      const fade = 0.20 + scratch.bass * 0.10;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]},${fade})`;
      ctx.fillRect(0, 0, W, H);
    }
    function transformXY(x, y) {
      // Apply pose-driven proximity zoom around (cx,cy) so the user's
      // motion reshapes the view, not the structure.
      const zoom = 1.0 - proximity * 0.18;
      return [
        ((x - cx) * zoom + 0.5) * W,
        ((y - cy) * zoom + 0.5) * H,
      ];
    }
    function effectiveVoidR(idx) {
      // Per-void breathing: each void has its own slow phase so they don't
      // pulse in unison. Bass adds a global swell on top.
      const breath = 1.0
        + 0.10 * Math.sin(scratch.time * vfr[idx] + vph[idx])
        + scratch.bass * 0.30;
      return vr[idx] * scratch.voidSize * breath;
    }

    // ── Renderers ──────────────────────────────────────────────────────────

    function renderCosmicWeb() {
      clearBg();
      const pal = scratch.pal;
      const time = scratch.time;
      const N = Math.min(MAX_GALAXIES, (MAX_GALAXIES * scratch.density) | 0);

      // Galaxies: skip those falling inside a void; brighten those near
      // a wall (d ≈ r, the boundary). Done in a single pass.
      ctx.globalCompositeOperation = 'lighter';
      const rTwk = scratch.twinkle;
      const beatBoost = 1 + scratch.beatP * 0.6;
      for (let i = 0; i < N; i++) {
        const x = gx[i], y = gy[i];
        // Distance to nearest void.
        let bestD = 1e6, bestR = 0.1;
        for (let v = 0; v < NUM_VOIDS; v++) {
          const ddx = x - vx[v], ddy = y - vy[v];
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < bestD) { bestD = d2; bestR = effectiveVoidR(v); }
        }
        const d = Math.sqrt(bestD);
        if (d < bestR * 0.92) continue;         // inside void → skip
        // Wall multiplier — peaks at the boundary; falls off both ways.
        // Voids are ~10× more contrast-y than just gating on/off.
        const ringT  = (d - bestR) / (bestR * 0.55);
        const wall   = Math.exp(-ringT * ringT) * 0.85 + 0.15;

        // Twinkle (per-galaxy phase × shared rate × highs amplitude).
        const tw = 0.6 + 0.4 * Math.sin(time * gtw[i] + gph[i]) * rTwk;
        const a  = (0.30 + wall * 0.55) * tw * beatBoost;

        const [px, py] = transformXY(x, y);
        if (px < -10 || px > W + 10 || py < -10 || py > H + 10) continue;

        const r = gsz[i] * (0.85 + wall * 0.5);
        if (gel[i] > 0) {
          // Spiral galaxy — small ellipse with a faint bar.
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(gor[i]);
          ctx.fillStyle = rgba(pal.galaxy, a * 0.85);
          ctx.beginPath();
          ctx.ellipse(0, 0, r * (1 + gel[i] * 1.4), r * (1 - gel[i] * 0.5), 0, 0, TAU);
          ctx.fill();
          ctx.fillStyle = rgba(pal.galaxy, a * 1.2);
          ctx.beginPath();
          ctx.arc(0, 0, r * 0.45, 0, TAU);
          ctx.fill();
          ctx.restore();
        } else {
          // Pinpoint — additive disk + tiny halo for the brightest ones.
          ctx.fillStyle = rgba(pal.galaxy, a);
          ctx.beginPath();
          ctx.arc(px, py, r, 0, TAU);
          ctx.fill();
          if (r > 1.6) {
            ctx.fillStyle = rgba(pal.wall, a * 0.30);
            ctx.beginPath();
            ctx.arc(px, py, r * 3, 0, TAU);
            ctx.fill();
          }
        }
      }

      // Filaments: pick a small set of inter-void links and stroke a thin
      // glow along the wall the link sits in. Draws AFTER galaxies so the
      // filament glow reads as the structural backbone.
      ctx.globalCompositeOperation = 'lighter';
      const filaA = 0.10 * scratch.filamentBri * (0.6 + scratch.mids * 0.8);
      ctx.strokeStyle = rgba(pal.wall, filaA);
      ctx.lineWidth = 1.0 + scratch.bass * 1.4;
      ctx.beginPath();
      for (let i = 0; i < NUM_VOIDS; i++) {
        for (let j = i + 1; j < NUM_VOIDS; j++) {
          const dx = vx[i] - vx[j], dy = vy[i] - vy[j];
          const d  = Math.sqrt(dx * dx + dy * dy);
          // Only link nearby voids — mirrors the 'walls between adjacent
          // voids' physics. Caps long diagonals from polluting the field.
          if (d > 0.45) continue;
          const ax = (vx[i] + vx[j]) * 0.5;
          const ay = (vy[i] + vy[j]) * 0.5;
          // Run the wall perpendicular to the void-void axis, length
          // proportional to overlap.
          const nx = -dy, ny = dx;
          const len = (effectiveVoidR(i) + effectiveVoidR(j)) * 0.55;
          const [x0, y0] = transformXY(ax - nx * len, ay - ny * len);
          const [x1, y1] = transformXY(ax + nx * len, ay + ny * len);
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
      }
      ctx.stroke();

      // Beat shockwave — expanding circle from cosmic centre. Kicks read as
      // gravitational ripples through the web.
      if (scratch.beatP > 0.02) {
        const r = scratch.beatP * Math.min(W, H) * 0.8;
        const [scx, scy] = transformXY(cx, cy);
        ctx.strokeStyle = rgba(pal.accent, scratch.beatP * 0.25);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(scx, scy, r, 0, TAU);
        ctx.stroke();
      }

      // Shooting star — head + thin tail.
      if (starLife > 0) {
        const headFrac = Math.max(0, starLife);
        const [hx0, hy0] = transformXY(starX, starY);
        const [hx1, hy1] = transformXY(starX - starVx * 0.40, starY - starVy * 0.40);
        const grad = ctx.createLinearGradient(hx1, hy1, hx0, hy0);
        grad.addColorStop(0, rgba(pal.galaxy, 0));
        grad.addColorStop(1, rgba(pal.galaxy, 0.8 * headFrac));
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(hx1, hy1);
        ctx.lineTo(hx0, hy0);
        ctx.stroke();
        ctx.fillStyle = rgba(pal.galaxy, headFrac);
        ctx.beginPath();
        ctx.arc(hx0, hy0, 1.5, 0, TAU);
        ctx.fill();
      }

      // Galaxy-count chip.
      if (scratch.showLabels) {
        ctx.globalCompositeOperation = 'source-over';
        const txt = visibleCount.toLocaleString();
        const fontPx = Math.max(11, Math.min(W, H) * 0.018);
        ctx.font = `${fontPx}px 'JetBrains Mono', ui-monospace, monospace`;
        const padX = fontPx * 0.9, padY = fontPx * 0.55;
        const tw = ctx.measureText(txt).width;
        const bx = (W - tw) * 0.5 - padX;
        const by = H * 0.86;
        const bw = tw + padX * 2;
        const bh = fontPx + padY * 2;
        ctx.strokeStyle = rgba(pal.accent, 0.85);
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.fillStyle = rgba(pal.accent, 0.95);
        ctx.textBaseline = 'top';
        ctx.fillText(txt, bx + padX, by + padY * 0.85);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function renderVoids() {
      // Same galaxy field as cosmic_web, but with explicit void boundary
      // strokes + labels for two named voids (MILKYWAY at v=0, LOCAL VOID
      // at v=1). Mirrors the reference image's annotation aesthetic.
      clearBg();
      const pal = scratch.pal;
      const time = scratch.time;
      const N = Math.min(MAX_GALAXIES, (MAX_GALAXIES * scratch.density) | 0);

      ctx.globalCompositeOperation = 'lighter';
      // Draw galaxies first (sparser & more uniformly distributed; voids
      // will mask them visually with the explicit ring strokes below).
      const rTwk = scratch.twinkle;
      for (let i = 0; i < N; i += 1) {
        const x = gx[i], y = gy[i];
        let bestD = 1e6, bestR = 0.1;
        for (let v = 0; v < NUM_VOIDS; v++) {
          const ddx = x - vx[v], ddy = y - vy[v];
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < bestD) { bestD = d2; bestR = effectiveVoidR(v); }
        }
        const d = Math.sqrt(bestD);
        if (d < bestR * 0.95) continue;
        const tw = 0.55 + 0.45 * Math.sin(time * gtw[i] + gph[i]) * rTwk;
        const a  = 0.40 * tw;
        const [px, py] = transformXY(x, y);
        if (px < -10 || px > W + 10 || py < -10 || py > H + 10) continue;
        const r = gsz[i] * 0.85;
        ctx.fillStyle = rgba(pal.galaxy, a);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, TAU);
        ctx.fill();
      }

      // Void boundary rings — solid stroke for two named voids (the ones
      // that get labels), faint dashed strokes for the rest so the user
      // sees the underlying tessellation.
      ctx.globalCompositeOperation = 'source-over';
      const namedVoids = [
        { idx: 0, label: 'MILKYWAY',   ratio: [1.0, 1.0] },
        { idx: 1, label: 'LOCAL VOID', ratio: [1.7, 1.0] },
      ];
      for (let v = 0; v < NUM_VOIDS; v++) {
        const r = effectiveVoidR(v);
        const named = namedVoids.find(n => n.idx === v);
        const [cx0, cy0] = transformXY(vx[v], vy[v]);
        const rad = r * Math.min(W, H);
        ctx.beginPath();
        if (named) {
          // Slightly elliptical for the LOCAL VOID — the reference image
          // shows it as an oval rather than a perfect circle.
          ctx.ellipse(cx0, cy0,
                      rad * named.ratio[0],
                      rad * named.ratio[1],
                      0, 0, TAU);
          ctx.strokeStyle = rgba(pal.accent, 0.85);
          ctx.lineWidth   = 1.1;
        } else {
          ctx.arc(cx0, cy0, rad, 0, TAU);
          ctx.strokeStyle = rgba(pal.wall, 0.32);
          ctx.lineWidth   = 0.9;
        }
        ctx.stroke();
      }
      // Labels last — pinned inside the named void, centered.
      if (scratch.showLabels) {
        ctx.fillStyle = rgba(pal.accent, 0.92);
        const fontPx = Math.max(10, Math.min(W, H) * 0.014);
        ctx.font = `${fontPx}px 'JetBrains Mono', ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const n of namedVoids) {
          const [lx, ly] = transformXY(vx[n.idx], vy[n.idx]);
          // Stroke a small outline behind text for legibility against
          // bright galaxies bleeding through screen blend.
          ctx.fillText(n.label, lx, ly);
        }
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    }

    function renderDarkMatter() {
      // A scribbly web of thin filaments wandering through a dim teal
      // field. Adds a few darker blob shadows to read as dark-matter halos.
      const pal = scratch.pal;
      ctx.globalCompositeOperation = 'source-over';
      // Heavier fade than other modes — long ink-like trails read better.
      ctx.fillStyle = `rgba(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]},0.10)`;
      ctx.fillRect(0, 0, W, H);

      // Faint "haze" wash — barely-there teal fill so the lines pop.
      ctx.globalCompositeOperation = 'lighter';
      const haze = 0.025 + scratch.rms * 0.04;
      ctx.fillStyle = rgba(pal.wall, haze);
      ctx.fillRect(0, 0, W, H);

      // Halos — soft dark-matter blobs (radial gradients) orbiting slowly.
      // These darken local regions slightly for atmosphere.
      ctx.globalCompositeOperation = 'multiply';
      for (let v = 0; v < NUM_VOIDS; v++) {
        const r = effectiveVoidR(v) * 1.6;
        const [px, py] = transformXY(vx[v], vy[v]);
        const rad = r * Math.min(W, H);
        const grad = ctx.createRadialGradient(px, py, 0, px, py, rad);
        grad.addColorStop(0,   `rgba(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]},0.55)`);
        grad.addColorStop(0.7, `rgba(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]},0.10)`);
        grad.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
      }

      // Flow lines — ribbon strokes from the per-line buffer. Lighter
      // composite + low alpha gives the ink-on-dark look.
      ctx.globalCompositeOperation = 'lighter';
      const lineA = 0.18 * scratch.filamentBri;
      ctx.strokeStyle = rgba(pal.filament, lineA);
      ctx.lineWidth = 0.7 + scratch.bass * 0.6;
      ctx.lineCap = 'round';
      const N = Math.min(NUM_FLOW_LINES, (NUM_FLOW_LINES * scratch.density) | 0);
      for (let i = 0; i < N; i++) {
        const baseOff = i * FLOW_HISTORY;
        const head = flh[i];
        ctx.beginPath();
        let started = false;
        for (let k = 0; k < FLOW_HISTORY; k++) {
          // Walk back from head: oldest → newest so stroke flows correctly.
          const idx = (head - (FLOW_HISTORY - 1 - k) + FLOW_HISTORY) % FLOW_HISTORY;
          const px = flx[baseOff + idx];
          const py = fly[baseOff + idx];
          const [sx, sy] = transformXY(px, py);
          if (!started) { ctx.moveTo(sx, sy); started = true; }
          else           ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }

      // Optional label.
      if (scratch.showLabels) {
        ctx.globalCompositeOperation = 'source-over';
        const fontPx = Math.max(11, Math.min(W, H) * 0.018);
        ctx.font = `${fontPx}px 'JetBrains Mono', ui-monospace, monospace`;
        const txt = 'DARK MATTER';
        const tw = ctx.measureText(txt).width;
        const padX = fontPx * 0.9, padY = fontPx * 0.45;
        const bx = (W - tw) * 0.5 - padX;
        const by = H * 0.88;
        const bw = tw + padX * 2;
        const bh = fontPx + padY * 2;
        ctx.strokeStyle = rgba(pal.accent, 0.85);
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.fillStyle = rgba(pal.accent, 0.95);
        ctx.textBaseline = 'top';
        ctx.fillText(txt, bx + padX, by + padY * 0.85);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function renderDarkEnergy() {
      // Central column of stretched galaxies + wavy vertical lines on
      // either side that bow outward over time, visualising w(z) > 0
      // expansion. The inner narrow corridor is bright; the outer lines
      // peel away.
      clearBg();
      const pal = scratch.pal;
      const time = scratch.time;

      // Background haze — narrow vertical bright band at centre.
      ctx.globalCompositeOperation = 'lighter';
      const cxPx = W * 0.5;
      const bandW = W * 0.07 * (1 + scratch.bass * 0.4);
      const grad = ctx.createLinearGradient(cxPx - bandW, 0, cxPx + bandW, 0);
      grad.addColorStop(0,    rgba(pal.wall, 0));
      grad.addColorStop(0.5,  rgba(pal.wall, 0.35 + scratch.rms * 0.20));
      grad.addColorStop(1,    rgba(pal.wall, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(cxPx - bandW, 0, bandW * 2, H);

      // Central column of stretched spiral galaxies — bigger, with the
      // odd 'halo' galaxy (a soft ring like the reference image's).
      ctx.globalCompositeOperation = 'lighter';
      const expansionT = scratch.expansion + scratch.rms * 0.4;
      const yScroll = (time * 0.05 * expansionT) % 1.0;
      for (let i = 0; i < NUM_DE_GALAXIES; i++) {
        // y wraps so the column appears to keep streaming — feels like
        // observers in an expanding universe seeing things flow past.
        let y = (dey[i] + yScroll) % 1.0;
        if (y < 0) y += 1;
        const x = dex[i];
        const px = x * W + (Math.sin(time * 0.6 + i) * 1.5);
        const py = y * H;
        const r  = desz[i] * (0.9 + scratch.mids * 0.5);

        // Spiral body — rotated ellipse.
        const ang = i * 0.27 + time * 0.10;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.fillStyle = rgba(pal.galaxy, 0.85);
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 1.8, r * 0.8, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = rgba(pal.galaxy, 1.0);
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.55, 0, TAU);
        ctx.fill();
        ctx.restore();

        // Halo galaxies — a soft glowing ring (the prominent ones in the
        // reference image).
        if (dehalo[i] > 0) {
          const haloR = r * 9 * (0.85 + scratch.beatP * 0.5);
          const halo = ctx.createRadialGradient(px, py, 0, px, py, haloR);
          halo.addColorStop(0, rgba(pal.galaxy, 0.35));
          halo.addColorStop(0.5, rgba(pal.wall, 0.15));
          halo.addColorStop(1, rgba(pal.wall, 0));
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(px, py, haloR, 0, TAU);
          ctx.fill();
        }
      }

      // Outer expansion lines — pairs running vertically that bow further
      // outward as you move away from the centre. Time-modulated so they
      // appear to creep outward — that's the dark-energy expansion.
      ctx.globalCompositeOperation = 'lighter';
      const baseLineX = W * 0.18;       // first pair starts ~18% from centre
      const spread    = 1.0 + 0.10 * Math.sin(time * 0.18) + scratch.bass * 0.15;
      const lineA     = 0.55 * scratch.filamentBri;
      ctx.strokeStyle = rgba(pal.galaxy, lineA);
      ctx.lineWidth   = 1.1;
      for (let s = -1; s <= 1; s += 2) {
        for (let k = 0; k < NUM_EXPANSION_LINES_SIDE; k++) {
          const off = (k + 1) * (W * 0.045) * spread + scratch.expansion * W * 0.01 * (k + 1);
          const ampX = 6 + k * 1.5;
          ctx.beginPath();
          for (let p = 0; p <= EXP_LINE_POINTS; p++) {
            const t = p / EXP_LINE_POINTS;
            const yy = t * H;
            const wob = Math.sin(t * 18 + time * 0.6 + k * 0.7 + s) * ampX
                      + Math.sin(t * 7 + time * 0.4 + k) * (ampX * 0.4);
            const xx = cxPx + s * (baseLineX + off + wob);
            if (p === 0) ctx.moveTo(xx, yy);
            else         ctx.lineTo(xx, yy);
          }
          ctx.stroke();
        }
      }

      // Faint background star sprinkle — gives the column some context.
      const N = Math.min(MAX_GALAXIES, (MAX_GALAXIES * 0.2 * scratch.density) | 0);
      for (let i = 0; i < N; i++) {
        // Skip galaxies inside the bright central column — they'd clip.
        const gxn = gx[i];
        if (gxn > 0.42 && gxn < 0.58) continue;
        const tw = 0.5 + 0.5 * Math.sin(time * gtw[i] + gph[i]) * scratch.twinkle;
        const a  = 0.18 * tw;
        const px = gxn * W;
        const py = gy[i] * H;
        ctx.fillStyle = rgba(pal.galaxy, a);
        ctx.fillRect(px, py, gsz[i] * 0.6, gsz[i] * 0.6);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function renderVoidGrowth() {
      clearBg();
      const pal = scratch.pal;
      const time = scratch.time;

      // Galaxies — same field as cosmic_web, but under a single growing
      // void centred on (cx,cy). Galaxies inside the growing radius are
      // suppressed; those near the edge get a "fleeing" radial offset.
      const N = Math.min(MAX_GALAXIES, (MAX_GALAXIES * scratch.density) | 0);
      const radius = growR * (0.6 + proximity * 0.30);
      const minDim = Math.min(W, H);
      const Rpx    = radius * minDim;

      ctx.globalCompositeOperation = 'lighter';
      const rTwk = scratch.twinkle;
      for (let i = 0; i < N; i++) {
        const dx = gx[i] - cx, dy = gy[i] - cy;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < radius * 0.92) continue;
        // "Flee" offset — particles within a thin shell get pushed
        // outward proportional to expansion speed.
        const shellFrac = Math.min(1, (d - radius) / (radius * 0.5));
        const flee = (1 - shellFrac) * 0.012 * scratch.expansion;
        const ang  = Math.atan2(dy, dx);
        const x = gx[i] + Math.cos(ang) * flee;
        const y = gy[i] + Math.sin(ang) * flee;

        const tw = 0.5 + 0.5 * Math.sin(time * gtw[i] + gph[i]) * rTwk;
        const shellArg = (d - radius) / (radius * 0.35);
        const wallBoost = Math.exp(-(shellArg * shellArg)) * 0.9 + 0.2;
        const a = (0.30 + wallBoost * 0.50) * tw;

        const [px, py] = transformXY(x, y);
        if (px < -10 || px > W + 10 || py < -10 || py > H + 10) continue;
        const r = gsz[i] * (0.8 + wallBoost * 0.5);
        ctx.fillStyle = rgba(pal.galaxy, a);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, TAU);
        ctx.fill();
      }

      // Void boundary stroke — bright ring at the leading edge of growth.
      ctx.globalCompositeOperation = 'lighter';
      const [vcx, vcy] = transformXY(cx, cy);
      ctx.strokeStyle = rgba(pal.accent, 0.45 + scratch.beatP * 0.30);
      ctx.lineWidth = 1.4 + scratch.bass * 0.6;
      ctx.beginPath();
      ctx.arc(vcx, vcy, Rpx, 0, TAU);
      ctx.stroke();

      // Inner echoes — concentric rings showing growth history. Trailing
      // rings get fainter as they expand outward.
      for (let k = 1; k <= 3; k++) {
        const echoT = (k * 0.18 + (time * scratch.expansion * 0.18) % 0.18);
        const echoR = Rpx * (1 + echoT);
        if (echoR > Math.max(W, H)) continue;
        ctx.strokeStyle = rgba(pal.wall, 0.18 / k);
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(vcx, vcy, echoR, 0, TAU);
        ctx.stroke();
      }

      // Soft dark-matter halo INSIDE the void — gives mass even where the
      // galaxies have fled.
      ctx.globalCompositeOperation = 'lighter';
      const inner = ctx.createRadialGradient(vcx, vcy, 0, vcx, vcy, Rpx);
      inner.addColorStop(0,   rgba(pal.wall, 0.06));
      inner.addColorStop(0.6, rgba(pal.wall, 0.02));
      inner.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.fillStyle = inner;
      ctx.beginPath();
      ctx.arc(vcx, vcy, Rpx, 0, TAU);
      ctx.fill();

      ctx.globalCompositeOperation = 'source-over';
    }

    function render() {
      switch (scratch.mode) {
        case 'voids':       renderVoids();      break;
        case 'dark_matter': renderDarkMatter(); break;
        case 'dark_energy': renderDarkEnergy(); break;
        case 'void_growth': renderVoidGrowth(); break;
        default:            renderCosmicWeb();  break;
      }
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* GC handles typed arrays */ },
    };
  },
};
