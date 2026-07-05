// Chaos — chaos theory as a live instrument. Five modes, one idea:
// sensitive dependence on initial conditions, rendered as light.
//
//   pendulums   — ten double pendulums begin almost identical, fanned a
//                 single degree apart. RK4 integration; ribbon trails; a
//                 divergence-σ meter watches the fan tear itself apart.
//   lorenz      — the Lorenz strange attractor. A 900-particle flow rides
//                 the field while eight near-identical tracers split into
//                 separate futures. Bass breathes ρ; the camera orbits.
//   threebody   — a gravitational figure-eight ballet (Chenciner–Montgomery
//                 orbit) seeded with a whisper of error. Music feeds energy
//                 until a body escapes and the dance re-seeds.
//   bifurcation — the logistic-map period-doubling cascade as phosphor
//                 dust. A playhead scrubs r through the Feigenbaum route
//                 to chaos, showing the live orbit at that column.
//   dejong      — the Peter de Jong attractor as slow phosphor dust.
//                 Thousands of iterates per frame settle onto filigree;
//                 four incommensurate LFOs walk the coefficients so the
//                 attractor is forever morphing between shapes. Nothing
//                 here moves fast — the *shape itself* is what drifts.
//
// Audio map (tuned for ambient/atmospheric, not spazzy — everything below
// is a slow breath or a soft shimmer, never a hard jump):
//   bass        → atmosphere wash breathing + glow + scale breathing
//                 (pendulum fan, lorenz camera, three-body halos, de jong
//                 dust), Lorenz ρ, three-body G, de jong morph depth,
//                 bifurcation dust glow
//   mids        → atmosphere hue drift + per-mode hue drift (lorenz swarm,
//                 three-body trails, de jong dust), playhead sweep rate
//   highs.pulse → tip / tracer / bead / dust shimmer in every mode
//   beat        → deterministic energy kick (all pendulums get the SAME
//                 kick, so divergence stays an honest experiment), tracer
//                 flash, orbit-column flash, a soft push through de jong
//                 coefficient space (envelope-shaped — glides, never jumps)
//   total       → timeScale modulator (declared, tunable in the panel)
// The `atmosphere` param scales a palette-tinted background wash that
// breathes with bass and drifts hue with mids — the always-legible ambient
// layer; per-mode effects sit on top of it.
// Pose map (relative, mirror-tolerant — see poseSway toggle):
//   shoulder roll  → tilts gravity for the pendulum fan
//   head x / wrist height → Lorenz camera yaw / pitch
//   wrist x        → scrubs the bifurcation playhead through r
//   wrists         → ghost masses perturbing the three-body ballet
//   wrist x / y    → bends the de jong coefficients a & c

import { scaleAudio } from '../field.js';

const MODES = ['pendulums', 'lorenz', 'threebody', 'bifurcation', 'dejong'];

// ── Pendulums ────────────────────────────────────────────────────────────────
const NPEND        = 10;
const PEND_H       = 1 / 240;   // RK4 step (sim seconds)
const PEND_TRAIL   = 420;       // ring-buffer points per tip
const PEND_RESEED  = 90;        // seconds before the fan realigns

// ── Lorenz ───────────────────────────────────────────────────────────────────
const LOR_SWARM    = 900;
const LOR_TRACERS  = 8;
const LOR_TRAIL    = 220;
const LOR_H        = 0.005;

// ── Three-body ───────────────────────────────────────────────────────────────
const TB_TRAIL     = 400;
const TB_H         = 0.004;
const TB_EPS2      = 1e-3;      // gravitational softening
const TB_ESCAPE_R  = 2.6;

// ── Bifurcation ──────────────────────────────────────────────────────────────
const BIF_RMIN     = 2.8;
const BIF_RMAX     = 4.0;
const BIF_FEIG     = 3.569945;  // onset of chaos
const BIF_ORBIT    = 90;        // live-orbit beads at the playhead

// ── De Jong attractor ────────────────────────────────────────────────────────
const DJ_N         = 6500;      // iterates plotted per frame
const DJ_BANDS     = 12;        // hue bands (radius-bucketed, counting-sorted)
const TAU          = Math.PI * 2;

// Palette = hue ramp + white-core accent. hue(t): t∈[0,1] across the family
// (pendulum index, tracer index, orbit depth…).
const PALETTES = {
  spectral: { h0: 300, h1:  10, sat: 68, light: 70 },  // pastel violet→red (the reference)
  void:     { h0: 215, h1: 165, sat: 92, light: 64 },  // voidstar cyan-white
  plasma:   { h0:  52, h1: -35, sat: 88, light: 62 },  // accretion gold→neural magenta
  phosphor: { h0: 148, h1:  95, sat: 72, light: 62 },  // ghost green / CRT
};
function palHue(pal, t) { return pal.h0 + (pal.h1 - pal.h0) * t; }

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'chaos',
  name: 'Chaos',
  contextType: 'canvas2d',

  params: [
    { id: 'mode', label: 'mode', type: 'select',
      options: MODES, default: 'pendulums' },
    { id: 'spread', label: 'Δ° initial', type: 'range',
      min: 0.05, max: 5, step: 0.05, default: 1.0,
      modulators: [
        { source: 'pose.wristSpread', mode: 'add', amount: 0.0 },
      ] },
    { id: 'timeScale', label: 'time', type: 'range',
      min: 0.1, max: 2.5, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total',  mode: 'mul', amount: 0.35 },
        { source: 'crowd.energy', mode: 'mul', amount: 0.30 },
      ] },
    { id: 'trails', label: 'trails', type: 'range',
      min: 0, max: 1, step: 0.02, default: 0.5 },
    { id: 'glow', label: 'glow', type: 'range',
      min: 0, max: 2, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass', mode: 'add', amount: 0.55 },
        { source: 'crowd.rise', mode: 'add', amount: 0.40 },
      ] },
    { id: 'atmosphere', label: 'atmosphere', type: 'range',
      min: 0, max: 1, step: 0.02, default: 0.6 },
    { id: 'kick', label: 'beat kick', type: 'range',
      min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'palette', label: 'palette', type: 'select',
      options: ['spectral', 'void', 'plasma', 'phosphor'], default: 'spectral' },
    { id: 'poseSway', label: 'pose sway', type: 'toggle', default: true },
    { id: 'hud', label: 'hud', type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity', type: 'range',
      min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Phase walks the five faces of chaos, each with its home palette.
  autoPhase: {
    steps: [
      { mode: 'pendulums',   palette: 'spectral' },
      { mode: 'lorenz',      palette: 'void'     },
      { mode: 'threebody',   palette: 'plasma'   },
      { mode: 'bifurcation', palette: 'phosphor' },
      { mode: 'dejong',      palette: 'void'     },
    ],
  },

  presets: {
    default:   { mode: 'pendulums', spread: 1.0, timeScale: 1.0, trails: 0.5, glow: 1.0, atmosphere: 0.6, kick: 1.0, palette: 'spectral', poseSway: true, hud: true, reactivity: 1.0 },
    butterfly: { mode: 'pendulums', spread: 0.1, trails: 0.9, timeScale: 0.9 },
    strange:   { mode: 'lorenz', palette: 'void', trails: 0.85, timeScale: 1.1 },
    ballet:    { mode: 'threebody', palette: 'plasma', spread: 0.5, trails: 0.9 },
    cascade:   { mode: 'bifurcation', palette: 'phosphor', timeScale: 0.8 },
    filigree:  { mode: 'dejong', palette: 'void', trails: 0.85, timeScale: 0.8 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height, DPR = 1;

    // ── Shared per-frame scratch (render() never reads field) ────────────────
    const scratch = {
      mode: 'pendulums', pal: PALETTES.spectral,
      glow: 1, trails: 0.5, atmosphere: 0.6, kick: 1, hudOn: true,
      bass: 0, mids: 0, highs: 0, total: 0, beatP: 0, highsP: 0,
      time: 0, dt: 0,
      flash: 0,             // beat flash envelope (all modes)
      clearFrames: 0,       // opaque clears queued after a (re)seed
      hudLines: ['', ''],   // refreshed at ~6 Hz
    };
    let hudAccum = 0;

    // Smoothed pose features (lerped so a person leaving frame doesn't snap).
    const poseS = { present: 0, roll: 0, headX: 0.5, wristY: 0.5, wristX: 0.5,
                    hands: [[0, 0, 0], [0, 0, 0]] };  // [x, y, weight]

    // ── Pendulums state ──────────────────────────────────────────────────────
    // State per pendulum: [θ1, ω1, θ2, ω2]. Equal masses + arm lengths.
    const pTh1 = new Float64Array(NPEND), pW1 = new Float64Array(NPEND);
    const pTh2 = new Float64Array(NPEND), pW2 = new Float64Array(NPEND);
    const pTrail = []; // per pendulum: Float32Array ring of tip xy
    for (let i = 0; i < NPEND; i++) pTrail.push(new Float32Array(PEND_TRAIL * 2));
    const pTrailHead = new Int32Array(NPEND);
    const pTrailLen  = new Int32Array(NPEND);
    let pendAccum = 0, pendAge = 0, pendSigma = 0;
    let spreadSeen = 1.0, spreadDirty = 0;
    const G_PEND = 9.81;
    // RK4 scratch (k1..k4 × 4 components) — allocated once.
    const rk = new Float64Array(16);

    function seedPendulums(spreadDeg) {
      const step = (spreadDeg * Math.PI / 180) / (NPEND - 1);
      for (let i = 0; i < NPEND; i++) {
        pTh1[i] = Math.PI * 0.62 + i * step;
        pTh2[i] = Math.PI * 0.88 + i * step;
        pW1[i] = 0; pW2[i] = 0;
        pTrailHead[i] = 0; pTrailLen[i] = 0;
      }
      pendAccum = 0; pendAge = 0; pendSigma = 0;
      spreadSeen = spreadDeg; spreadDirty = 0;
      scratch.clearFrames = 2;
    }

    // Double-pendulum accelerations (m1=m2=1, l1=l2=1). gTilt rotates the
    // gravity vector — the pose "lean" input.
    function pendDeriv(th1, w1, th2, w2, gTilt, out, o) {
      const s1 = Math.sin(th1 - gTilt), s2 = Math.sin(th2 - gTilt);
      const d  = th1 - th2;
      const sd = Math.sin(d), cd = Math.cos(d);
      const den = 3 - Math.cos(2 * d);
      out[o]     = w1;
      out[o + 1] = (-3 * G_PEND * s1 - G_PEND * Math.sin(th1 - 2 * th2 + gTilt)
                    - 2 * sd * (w2 * w2 + w1 * w1 * cd)) / den;
      out[o + 2] = w2;
      out[o + 3] = (2 * sd * (2 * w1 * w1 + 2 * G_PEND * Math.cos(th1 - gTilt) + w2 * w2 * cd)) / den;
    }

    function stepPendulum(i, h, gTilt) {
      const t1 = pTh1[i], w1 = pW1[i], t2 = pTh2[i], w2 = pW2[i];
      pendDeriv(t1, w1, t2, w2, gTilt, rk, 0);
      pendDeriv(t1 + rk[0] * h / 2, w1 + rk[1] * h / 2, t2 + rk[2] * h / 2, w2 + rk[3] * h / 2, gTilt, rk, 4);
      pendDeriv(t1 + rk[4] * h / 2, w1 + rk[5] * h / 2, t2 + rk[6] * h / 2, w2 + rk[7] * h / 2, gTilt, rk, 8);
      pendDeriv(t1 + rk[8] * h,     w1 + rk[9] * h,     t2 + rk[10] * h,    w2 + rk[11] * h,    gTilt, rk, 12);
      pTh1[i] = t1 + (h / 6) * (rk[0] + 2 * rk[4] + 2 * rk[8]  + rk[12]);
      pW1[i]  = w1 + (h / 6) * (rk[1] + 2 * rk[5] + 2 * rk[9]  + rk[13]);
      pTh2[i] = t2 + (h / 6) * (rk[2] + 2 * rk[6] + 2 * rk[10] + rk[14]);
      pW2[i]  = w2 + (h / 6) * (rk[3] + 2 * rk[7] + 2 * rk[11] + rk[15]);
    }

    // ── Lorenz state ─────────────────────────────────────────────────────────
    const lx = new Float32Array(LOR_SWARM);
    const ly = new Float32Array(LOR_SWARM);
    const lz = new Float32Array(LOR_SWARM);
    const tX = new Float64Array(LOR_TRACERS);
    const tY = new Float64Array(LOR_TRACERS);
    const tZ = new Float64Array(LOR_TRACERS);
    // Tracer ribbons are true 3D polylines — 3 floats per point.
    const tTrail = [];
    for (let i = 0; i < LOR_TRACERS; i++) tTrail.push(new Float32Array(LOR_TRAIL * 3));
    const tTrailHead = new Int32Array(LOR_TRACERS);
    const tTrailLen  = new Int32Array(LOR_TRACERS);
    let lorYaw = 0, lorRho = 28, lorAccum = 0, lorTracerAge = 0;

    // Re-align the tracers onto (nearly) one point — the "watch them split"
    // moment recurs without disturbing the swarm.
    function seedTracers(spread, atX, atY, atZ) {
      const eps = 1e-4 * (0.2 + spread);
      for (let i = 0; i < LOR_TRACERS; i++) {
        tX[i] = atX + i * eps; tY[i] = atY; tZ[i] = atZ;
        tTrailHead[i] = 0; tTrailLen[i] = 0;
      }
      lorTracerAge = 0;
    }

    function seedLorenz(spread) {
      for (let i = 0; i < LOR_SWARM; i++) {
        lx[i] = (Math.random() - 0.5) * 30;
        ly[i] = (Math.random() - 0.5) * 30;
        lz[i] = Math.random() * 40 + 5;
      }
      seedTracers(spread, 2, 1, 20);
      lorAccum = 0;
      scratch.clearFrames = 2;
    }

    // ── Three-body state ─────────────────────────────────────────────────────
    const bX = new Float64Array(3), bY = new Float64Array(3);
    const bVx = new Float64Array(3), bVy = new Float64Array(3);
    const bAx = new Float64Array(3), bAy = new Float64Array(3);
    const bTrail = [];
    for (let i = 0; i < 3; i++) bTrail.push(new Float32Array(TB_TRAIL * 2));
    const bTrailHead = new Int32Array(3);
    const bTrailLen  = new Int32Array(3);
    let tbAccum = 0, tbAge = 0, tbG = 1;

    function seedThreeBody(spread) {
      // Chenciner–Montgomery figure-eight, plus a whisper of error scaled by
      // the spread slider — the whole point is watching it come undone.
      const vx = 0.93240737, vy = 0.86473146;
      bX[0] = -0.97000436; bY[0] =  0.24308753; bVx[0] = vx / 2; bVy[0] = vy / 2;
      bX[1] =  0.97000436; bY[1] = -0.24308753; bVx[1] = vx / 2; bVy[1] = vy / 2;
      bX[2] = 0;           bY[2] = 0;           bVx[2] = -vx;    bVy[2] = -vy;
      const eps = 1e-3 + spread * 2e-3;
      for (let i = 0; i < 3; i++) {
        bVx[i] += (Math.random() - 0.5) * eps;
        bVy[i] += (Math.random() - 0.5) * eps;
        bTrailHead[i] = 0; bTrailLen[i] = 0;
      }
      tbAccum = 0; tbAge = 0;
      scratch.clearFrames = 2;
    }

    function tbAccel() {
      for (let i = 0; i < 3; i++) { bAx[i] = 0; bAy[i] = 0; }
      for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
          const dx = bX[j] - bX[i], dy = bY[j] - bY[i];
          const d2 = dx * dx + dy * dy + TB_EPS2;
          const inv = tbG / (d2 * Math.sqrt(d2));
          bAx[i] += dx * inv; bAy[i] += dy * inv;
          bAx[j] -= dx * inv; bAy[j] -= dy * inv;
        }
      }
      // Ghost masses at the performer's wrists — a gentle, clamped pull.
      for (const gm of poseS.hands) {
        if (gm[2] <= 0.01) continue;
        for (let i = 0; i < 3; i++) {
          const dx = gm[0] - bX[i], dy = gm[1] - bY[i];
          const d2 = dx * dx + dy * dy + 0.08;
          const inv = 0.35 * gm[2] / (d2 * Math.sqrt(d2));
          bAx[i] += dx * inv; bAy[i] += dy * inv;
        }
      }
    }

    // ── Bifurcation state ────────────────────────────────────────────────────
    // The full diagram accumulates progressively into an offscreen canvas
    // (a few columns per frame) so entering the mode never stalls a frame.
    let bifCanvas = null, bifCtx = null, bifCol = 0, bifW = 0, bifH = 0;
    let bifPhase = 0;               // ping-pong playhead phase
    let bifPalName = '';            // diagram dust is baked per-palette
    const bifOrbit = new Float64Array(BIF_ORBIT);
    let bifR = BIF_RMIN;
    const bifM = { l: 0, r: 0, t: 0, b: 0 };

    function resetBifurcation() {
      bifW = W; bifH = H;
      bifM.l = W * 0.06; bifM.r = W * 0.03; bifM.t = H * 0.08; bifM.b = H * 0.10;
      if (!bifCanvas) {
        bifCanvas = document.createElement('canvas');
        bifCtx = bifCanvas.getContext('2d');
      }
      bifCanvas.width = Math.max(2, W);
      bifCanvas.height = Math.max(2, H);
      bifCtx.clearRect(0, 0, W, H);
      bifCol = 0;
      scratch.clearFrames = 2;
    }

    function bifBuildChunk() {
      if (!bifCanvas) return;
      const m = bifM;
      const plotW = bifW - m.l - m.r, plotH = bifH - m.t - m.b;
      if (bifCol >= plotW) return;
      const cols = Math.max(4, (plotW / 160) | 0);
      const pal = scratch.pal;
      for (let c = 0; c < cols && bifCol < plotW; c++, bifCol++) {
        const r = BIF_RMIN + (BIF_RMAX - BIF_RMIN) * (bifCol / plotW);
        let x = 0.31;
        for (let k = 0; k < 70; k++) x = r * x * (1 - x);      // settle
        const hue = palHue(pal, (r - BIF_RMIN) / (BIF_RMAX - BIF_RMIN));
        bifCtx.fillStyle = `hsla(${hue},${pal.sat}%,${pal.light}%,0.30)`;
        for (let k = 0; k < 130; k++) {
          x = r * x * (1 - x);
          bifCtx.fillRect(m.l + bifCol, m.t + (1 - x) * plotH, 1, 1);
        }
      }
    }

    // ── De Jong state ────────────────────────────────────────────────────────
    // One orbit point iterates DJ_N times per frame; every iterate is a dust
    // mote. The dust is a *density*, not a particle system — nothing on
    // screen travels, only the attractor's shape drifts as the coefficients
    // walk. Points are radius-bucketed into DJ_BANDS hue bands and counting-
    // sorted so render() pays 12 fillStyle changes, not 6500.
    const djPts  = new Float32Array(DJ_N * 2);   // band-sorted xy for render
    const djRawX = new Float32Array(DJ_N), djRawY = new Float32Array(DJ_N);
    const djBand = new Uint8Array(DJ_N);
    const djBandStart = new Int32Array(DJ_BANDS + 1);
    const djCursor    = new Int32Array(DJ_BANDS);
    const djGrid = new Uint8Array(32 * 32);      // occupancy probe (richness)
    let djX = 0.1, djY = 0.1;                    // orbit carries across frames
    let djPhase = 0;                             // coefficient-LFO clock
    let djBoost = 1;                             // dead-pocket escape speed
    let djCells = 0;                             // occupied cells last frame
    let djA = 0, djB = 0, djC = 0, djD = 0;      // current coefficients (HUD)

    function djCoeffs(t, depth, wob) {
      djA = -2.24 + Math.sin(t * 0.063)       * 1.10 * depth
                  + (poseS.wristX - 0.5) * 0.8 * wob;
      djB =  0.43 + Math.sin(t * 0.041 + 1.7) * 0.90 * depth;
      djC = -0.65 + Math.sin(t * 0.055 + 3.1) * 1.00 * depth
                  + (0.5 - poseS.wristY) * 0.8 * wob;
      djD = -2.43 + Math.sin(t * 0.047 + 4.6) * 0.90 * depth;
    }

    // How many 32×32 cells does a short probe orbit light up at LFO-clock t?
    // Fixed points / short cycles hit a handful; a healthy attractor hits
    // hundreds. The map's range is x,y ∈ [−2,2], so /5.7+0.5 never escapes
    // the grid.
    function djProbe(t) {
      djCoeffs(t, 0.55, 0);
      djGrid.fill(0);
      let x = 0.1, y = 0.1, cells = 0;
      for (let i = 0; i < 400; i++) {
        const nx = Math.sin(djA * y) - Math.cos(djB * x);
        y = Math.sin(djC * x) - Math.cos(djD * y);
        x = nx;
        const c = (((y / 5.7 + 0.5) * 32) | 0) * 32 + (((x / 5.7 + 0.5) * 32) | 0);
        if (!djGrid[c]) { djGrid[c] = 1; cells++; }
      }
      return cells;
    }

    function seedDejong() {
      djX = 0.1; djY = 0.1;
      // Coefficient space has dead pockets where the dust collapses to a
      // few motes — probe random phases and keep the richest, so entering
      // the mode never opens on a collapsed orbit.
      let best = -1;
      for (let k = 0; k < 24; k++) {
        const t = Math.random() * 400;
        const c = djProbe(t);
        if (c > best) { best = c; djPhase = t; }
        if (best > 130) break;
      }
      djBoost = 1; djCells = 400;
      scratch.clearFrames = 2;
    }

    // ── Mode lifecycle ───────────────────────────────────────────────────────
    let curMode = null;
    function seedMode(mode, spread) {
      curMode = mode;
      switch (mode) {
        case 'pendulums':   seedPendulums(spread); break;
        case 'lorenz':      seedLorenz(spread);    break;
        case 'threebody':   seedThreeBody(spread); break;
        case 'bifurcation': resetBifurcation();    break;
        case 'dejong':      seedDejong();          break;
      }
    }

    function pushTrail(ring, headArr, lenArr, i, cap, x, y) {
      const h = headArr[i];
      ring[h * 2] = x; ring[h * 2 + 1] = y;
      headArr[i] = (h + 1) % cap;
      if (lenArr[i] < cap) lenArr[i]++;
    }

    // ── update ───────────────────────────────────────────────────────────────
    function update(field) {
      const { dt, time, pose, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);

      scratch.mode   = MODES.includes(params.mode) ? params.mode : 'pendulums';
      scratch.pal    = PALETTES[params.palette] || PALETTES.spectral;
      scratch.glow   = params.glow;
      scratch.trails = params.trails;
      scratch.atmosphere = params.atmosphere ?? 0.6;
      scratch.kick   = params.kick;
      scratch.hudOn  = !!params.hud;
      scratch.bass   = audio.bands.bass;
      scratch.mids   = audio.bands.mids;
      scratch.highs  = audio.bands.highs;
      scratch.total  = audio.bands.total;
      scratch.beatP  = audio.beat.pulse;
      scratch.highsP = audio.highs.pulse;
      scratch.time   = time;
      scratch.dt     = dt;

      const beat = audio.beat.active;
      scratch.flash *= Math.pow(0.002, dt);
      if (beat) scratch.flash = Math.min(1.5, 0.5 + scratch.bass);

      if (curMode !== scratch.mode) seedMode(scratch.mode, params.spread);

      // Smooth pose features. Weight fades in/out over ~0.4s so a person
      // stepping out of frame never snaps the visuals.
      const person = params.poseSway ? pose.people[0] : null;
      const target = person && person.confidence > 0.35 ? 1 : 0;
      poseS.present += (target - poseS.present) * Math.min(1, dt * 4);
      if (person) {
        const sl = person.shoulders?.l, sr = person.shoulders?.r;
        if (sl && sr && sl.visibility > 0.4 && sr.visibility > 0.4) {
          // Roll of the shoulder line, sign-stable under mirroring only in
          // magnitude terms; smoothing keeps it gentle either way.
          const roll = Math.atan2(sr.y - sl.y, (1 - sr.x) - (1 - sl.x));
          poseS.roll += (roll - poseS.roll) * Math.min(1, dt * 3);
        }
        if (person.head?.visibility > 0.4) {
          poseS.headX += ((1 - person.head.x) - poseS.headX) * Math.min(1, dt * 3);
        }
        const wl = person.wrists?.l, wr = person.wrists?.r;
        let wy = 0, wx = 0, n = 0;
        const hands = [wl, wr];
        for (let k = 0; k < 2; k++) {
          const lm = hands[k];
          const vis = lm && lm.visibility > 0.4 ? 1 : 0;
          poseS.hands[k][2] += (vis * poseS.present - poseS.hands[k][2]) * Math.min(1, dt * 4);
          if (vis) {
            // Sim-space coords for the three-body ghost masses.
            poseS.hands[k][0] = ((1 - lm.x) - 0.5) * 2.8;
            poseS.hands[k][1] = (lm.y - 0.5) * 2.8;
            wy += lm.y; wx += (1 - lm.x); n++;
          }
        }
        if (n) {
          poseS.wristY += (wy / n - poseS.wristY) * Math.min(1, dt * 3);
          poseS.wristX += (wx / n - poseS.wristX) * Math.min(1, dt * 3);
        }
      } else {
        for (let k = 0; k < 2; k++) poseS.hands[k][2] *= Math.max(0, 1 - dt * 4);
      }

      // Base speed runs at 0.5× the slider — chaos reads better slowed down.
      const ts = params.timeScale * 0.5;

      switch (scratch.mode) {
        case 'pendulums': {
          // A changed Δ° slider re-seeds the experiment (debounced so a drag
          // doesn't restart per pixel).
          if (Math.abs(params.spread - spreadSeen) > 1e-6) {
            spreadSeen = params.spread; spreadDirty = 0.7;
          }
          if (spreadDirty > 0) {
            spreadDirty -= dt;
            if (spreadDirty <= 0) seedPendulums(spreadSeen);
          }
          pendAge += dt;
          if (pendAge > PEND_RESEED) seedPendulums(params.spread);

          // Deterministic beat kick — identical multiplier for every
          // pendulum, so the fan's divergence stays a clean experiment.
          if (beat && scratch.kick > 0) {
            const m = 1 + 0.06 * scratch.kick * (0.5 + scratch.bass);
            for (let i = 0; i < NPEND; i++) { pW1[i] *= m; pW2[i] *= m; }
          }

          const gTilt = poseS.roll * 0.6 * poseS.present;
          pendAccum += dt * ts;
          let steps = Math.min(24, (pendAccum / PEND_H) | 0);
          pendAccum -= steps * PEND_H;
          while (steps-- > 0) {
            for (let i = 0; i < NPEND; i++) stepPendulum(i, PEND_H, gTilt);
          }

          // Tip positions → trails; circular dispersion of tip angle → σ.
          let cs = 0, sn = 0;
          for (let i = 0; i < NPEND; i++) {
            const x = Math.sin(pTh1[i]) + Math.sin(pTh2[i]);
            const y = Math.cos(pTh1[i]) + Math.cos(pTh2[i]);
            pushTrail(pTrail[i], pTrailHead, pTrailLen, i, PEND_TRAIL, x, y);
            const a = Math.atan2(x, y);
            cs += Math.cos(a); sn += Math.sin(a);
          }
          const R = Math.hypot(cs, sn) / NPEND;
          pendSigma = Math.sqrt(Math.max(0, -2 * Math.log(Math.max(1e-6, R))));
          break;
        }

        case 'lorenz': {
          const sigma = 10, beta = 8 / 3;
          lorRho = 28 + scratch.bass * 12;
          lorYaw += dt * (0.10 + scratch.mids * 0.25)
                  + (poseS.headX - 0.5) * dt * 1.6 * poseS.present;
          if (beat && scratch.kick > 0) scratch.flash = Math.min(1.5, scratch.flash + 0.3);

          lorAccum += dt * ts * (1 + scratch.beatP * 0.8 * scratch.kick);
          let steps = Math.min(8, (lorAccum / LOR_H) | 0);
          lorAccum -= steps * LOR_H;
          while (steps-- > 0) {
            for (let i = 0; i < LOR_SWARM; i++) {
              const x = lx[i], y = ly[i], z = lz[i];
              lx[i] = x + LOR_H * sigma * (y - x);
              ly[i] = y + LOR_H * (x * (lorRho - z) - y);
              lz[i] = z + LOR_H * (x * y - beta * z);
            }
            for (let i = 0; i < LOR_TRACERS; i++) {
              const x = tX[i], y = tY[i], z = tZ[i];
              tX[i] = x + LOR_H * sigma * (y - x);
              tY[i] = y + LOR_H * (x * (lorRho - z) - y);
              tZ[i] = z + LOR_H * (x * y - beta * z);
            }
          }
          for (let i = 0; i < LOR_TRACERS; i++) {
            const ring = tTrail[i], h = tTrailHead[i];
            ring[h * 3] = tX[i]; ring[h * 3 + 1] = tY[i]; ring[h * 3 + 2] = tZ[i];
            tTrailHead[i] = (h + 1) % LOR_TRAIL;
            if (tTrailLen[i] < LOR_TRAIL) tTrailLen[i]++;
          }
          lorTracerAge += dt;
          if (lorTracerAge > 60) seedTracers(params.spread, tX[0], tY[0], tZ[0]);
          break;
        }

        case 'threebody': {
          tbG = 1 + scratch.bass * 0.35;
          tbAge += dt;
          if (beat && scratch.kick > 0) {
            const m = 1 + 0.035 * scratch.kick;
            for (let i = 0; i < 3; i++) { bVx[i] *= m; bVy[i] *= m; }
          }
          tbAccum += dt * ts * 1.4;
          let steps = Math.min(30, (tbAccum / TB_H) | 0);
          tbAccum -= steps * TB_H;
          while (steps-- > 0) {
            // Velocity Verlet.
            tbAccel();
            for (let i = 0; i < 3; i++) {
              bVx[i] += bAx[i] * TB_H / 2; bVy[i] += bAy[i] * TB_H / 2;
              bX[i]  += bVx[i] * TB_H;     bY[i]  += bVy[i] * TB_H;
            }
            tbAccel();
            for (let i = 0; i < 3; i++) {
              bVx[i] += bAx[i] * TB_H / 2; bVy[i] += bAy[i] * TB_H / 2;
            }
          }
          // Keep the dance centered: remove center-of-mass drift.
          const cx = (bX[0] + bX[1] + bX[2]) / 3, cy = (bY[0] + bY[1] + bY[2]) / 3;
          for (let i = 0; i < 3; i++) { bX[i] -= cx; bY[i] -= cy; }
          let escaped = false;
          for (let i = 0; i < 3; i++) {
            if (Math.hypot(bX[i], bY[i]) > TB_ESCAPE_R) escaped = true;
            pushTrail(bTrail[i], bTrailHead, bTrailLen, i, TB_TRAIL, bX[i], bY[i]);
          }
          if (escaped || tbAge > 120) seedThreeBody(params.spread);
          break;
        }

        case 'bifurcation': {
          // Size or palette drift invalidates the baked dust — rebuild
          // progressively (a few columns per frame, never a frame stall).
          if (bifW !== W || bifH !== H || bifPalName !== params.palette) {
            bifPalName = params.palette;
            resetBifurcation();
          }
          bifBuildChunk();
          // Playhead: ping-pong sweep through r; a raised hand scrubs it.
          if (poseS.present > 0.5) {
            const targetPhase = poseS.wristX;
            bifPhase += (targetPhase - bifPhase) * Math.min(1, dt * 3);
          } else {
            bifPhase += dt * ts * (0.03 + scratch.mids * 0.05);
          }
          const pp = bifPhase % 2;
          const t = pp < 1 ? pp : 2 - pp;   // triangle wave 0→1→0
          bifR = BIF_RMIN + (BIF_RMAX - BIF_RMIN) * t;
          // Live orbit at the playhead column.
          let x = 0.31;
          for (let k = 0; k < 60; k++) x = bifR * x * (1 - x);
          for (let k = 0; k < BIF_ORBIT; k++) { x = bifR * x * (1 - x); bifOrbit[k] = x; }
          break;
        }

        case 'dejong': {
          // The morph IS the show, so the clock stays slow. Four
          // incommensurate LFOs walk (a,b,c,d) around a known-pretty home;
          // bass deepens the excursion a touch, and beats push the walk
          // forward through an envelope (beatP), so the shape leans into
          // the music instead of snapping. Wrists bend a & c directly.
          // djBoost is the dead-pocket escape: when last frame's dust
          // collapsed (few occupied cells), glide faster along the same
          // smooth path until shape returns.
          djPhase += dt * ts * djBoost * (0.55 + scratch.beatP * 0.9 * scratch.kick);
          djCoeffs(djPhase, 0.55 + scratch.bass * 0.30, poseS.present);

          // Iterate; the orbit carries across frames so the dust never
          // restarts. Bucket each mote by radius for the hue ramp
          // (attractor lives inside r ≤ 2√2), and mark the occupancy grid
          // for the richness guard.
          djGrid.fill(0);
          let x = djX, y = djY, cells = 0;
          for (let i = 0; i < DJ_N; i++) {
            const nx = Math.sin(djA * y) - Math.cos(djB * x);
            y = Math.sin(djC * x) - Math.cos(djD * y);
            x = nx;
            djRawX[i] = x; djRawY[i] = y;
            const b = (Math.sqrt(x * x + y * y) * (DJ_BANDS / 2.85)) | 0;
            djBand[i] = b >= DJ_BANDS ? DJ_BANDS - 1 : b;
            const c = (((y / 5.7 + 0.5) * 32) | 0) * 32 + (((x / 5.7 + 0.5) * 32) | 0);
            if (!djGrid[c]) { djGrid[c] = 1; cells++; }
          }
          djX = x; djY = y;
          djCells = cells;
          const boostTarget = djCells < 70 ? 9 : 1;
          djBoost += (boostTarget - djBoost) * Math.min(1, dt * 2.5);

          // Counting sort into contiguous per-band runs.
          djCursor.fill(0);
          for (let i = 0; i < DJ_N; i++) djCursor[djBand[i]]++;
          djBandStart[0] = 0;
          for (let b = 0; b < DJ_BANDS; b++) djBandStart[b + 1] = djBandStart[b] + djCursor[b];
          djCursor.set(djBandStart.subarray(0, DJ_BANDS));
          for (let i = 0; i < DJ_N; i++) {
            const o = djCursor[djBand[i]]++ * 2;
            djPts[o] = djRawX[i]; djPts[o + 1] = djRawY[i];
          }
          break;
        }
      }

      // HUD strings, refreshed ~6 Hz (cheap, but no need to build every frame).
      hudAccum += dt;
      if (scratch.hudOn && hudAccum > 0.16) {
        hudAccum = 0;
        switch (scratch.mode) {
          case 'pendulums':
            scratch.hudLines[0] = `10 double pendulums · Δθ₀ ${params.spread.toFixed(2)}°`;
            scratch.hudLines[1] = `t+${pendAge.toFixed(1)}s · divergence σ ${pendSigma.toFixed(2)} rad`;
            break;
          case 'lorenz':
            scratch.hudLines[0] = 'lorenz attractor · σ 10 · β 8/3';
            scratch.hudLines[1] = `ρ ${lorRho.toFixed(1)} · ${LOR_TRACERS} tracers Δ ${(1e-4 * (0.2 + params.spread)).toExponential(1)}`;
            break;
          case 'threebody':
            scratch.hudLines[0] = 'three-body ballet · figure-eight seed';
            scratch.hudLines[1] = `t+${tbAge.toFixed(1)}s · G ${tbG.toFixed(2)}`;
            break;
          case 'bifurcation':
            scratch.hudLines[0] = 'logistic map x→rx(1−x)';
            scratch.hudLines[1] = `r ${bifR.toFixed(4)} · r∞ ${BIF_FEIG}`;
            break;
          case 'dejong':
            scratch.hudLines[0] = 'de jong attractor · x′=sin(a·y)−cos(b·x) · y′=sin(c·x)−cos(d·y)';
            scratch.hudLines[1] = `a ${djA.toFixed(2)} · b ${djB.toFixed(2)} · c ${djC.toFixed(2)} · d ${djD.toFixed(2)}`;
            break;
        }
      }
    }

    // ── render helpers ───────────────────────────────────────────────────────
    // Shared projection state, refreshed at the top of each mode's render —
    // mapper functions are created ONCE and read this, so the hot path never
    // allocates closures.
    const prj = { cx: 0, cy: 0, S: 1, L: 1, cosY: 1, sinY: 0, cosP: 1, sinP: 0 };
    const flatMapX = (x)    => prj.cx + x * prj.S;
    const flatMapY = (x, y) => prj.cy + y * prj.S;

    // Trail ribbon drawn in banded alpha chunks (old → transparent) so the
    // whole ring costs a handful of strokes, not one per segment.
    const TRAIL_BANDS = 5;
    function drawTrail(ring, head, len, cap, mapX, mapY, hue, sat, light, width, alpha) {
      if (len < 2) return;
      const per = Math.ceil(len / TRAIL_BANDS);
      // Oldest stored point index:
      const start = (head - len + cap) % cap;
      for (let b = 0; b < TRAIL_BANDS; b++) {
        const from = b * per;
        const to = Math.min(len - 1, (b + 1) * per);
        if (to <= from) continue;
        const bandA = alpha * ((b + 1) / TRAIL_BANDS) * ((b + 1) / TRAIL_BANDS);
        ctx.strokeStyle = `hsla(${hue},${sat}%,${light}%,${bandA})`;
        ctx.lineWidth = width * (0.55 + 0.45 * (b + 1) / TRAIL_BANDS);
        ctx.beginPath();
        for (let k = from; k <= to; k++) {
          const idx = ((start + k) % cap) * 2;
          const x = mapX(ring[idx], ring[idx + 1]);
          const y = mapY(ring[idx], ring[idx + 1]);
          if (k === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    function drawHud() {
      if (!scratch.hudOn) return;
      const fs = Math.round(11 * DPR);
      ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillStyle = 'rgba(150,220,255,0.50)';
      ctx.fillText(scratch.hudLines[0], 14 * DPR, H - 30 * DPR);
      ctx.fillStyle = 'rgba(150,220,255,0.34)';
      ctx.fillText(scratch.hudLines[1], 14 * DPR, H - 14 * DPR);
    }

    // ── render ───────────────────────────────────────────────────────────────
    // Ambient atmosphere — a palette-tinted wash that breathes with bass and
    // drifts hue with mids; the one audio response that's legible in every
    // mode. Drawn additively every frame, so its alpha is scaled by this
    // frame's fade: steady-state brightness ≈ drawn/fade, which keeps the
    // wash constant across the whole trails range instead of blowing out at
    // long trails. With audio off it still drifts slowly on field.time.
    function drawAtmosphere(pal, fade) {
      const atm = scratch.atmosphere;
      if (atm <= 0.01) return;
      const t = scratch.time;
      const hue = palHue(pal, 0.5 + 0.4 * Math.sin(t * 0.05)) + scratch.mids * 30;
      const m = Math.min(W, H);
      const cx = W / 2 + Math.sin(t * 0.043) * W * 0.05;
      const cy = H / 2 + Math.cos(t * 0.031) * H * 0.05;
      const r = m * (0.55 + 0.06 * Math.sin(t * 0.07) + scratch.bass * 0.22);
      const a = Math.min(0.5, atm * fade * (0.10 + scratch.bass * 0.26));
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `hsla(${hue},${pal.sat}%,${pal.light}%,${a})`);
      grad.addColorStop(1, `hsla(${hue},${pal.sat}%,${pal.light}%,0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    function render() {
      ctx.globalCompositeOperation = 'source-over';
      // Trail persistence: high trails → light fade (long ghosts).
      const fade = scratch.mode === 'bifurcation'
        ? 0.55
        : 0.06 + (1 - scratch.trails) * 0.55;
      if (scratch.clearFrames > 0) {
        scratch.clearFrames--;
        ctx.fillStyle = 'rgb(5,5,13)';
        ctx.fillRect(0, 0, W, H);
      } else {
        ctx.fillStyle = `rgba(5,5,13,${fade})`;
        ctx.fillRect(0, 0, W, H);
      }

      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      const pal = scratch.pal;
      const glow = scratch.glow;
      drawAtmosphere(pal, fade);

      switch (scratch.mode) {
        case 'pendulums':   renderPendulums(pal, glow); break;
        case 'lorenz':      renderLorenz(pal, glow);    break;
        case 'threebody':   renderThreeBody(pal, glow); break;
        case 'bifurcation': renderBifurcation(pal, glow); break;
        case 'dejong':      renderDejong(pal, glow);    break;
      }

      drawHud();
      ctx.globalCompositeOperation = 'source-over';
    }

    function renderPendulums(pal, glow) {
      const cx = W / 2, cy = H * 0.44;
      // Bass breathes the projection scale (±4%) — trails re-project each
      // frame, so the whole ribbon fan gently swells with the low end
      // without touching the sim.
      const L = Math.min(W, H) * 0.215 * (1 + scratch.bass * 0.04);
      prj.cx = cx; prj.cy = cy; prj.S = L;

      // Ribbons first (under the hardware).
      for (let i = 0; i < NPEND; i++) {
        const hue = palHue(pal, i / (NPEND - 1));
        drawTrail(pTrail[i], pTrailHead[i], pTrailLen[i], PEND_TRAIL,
                  flatMapX, flatMapY, hue, pal.sat, pal.light,
                  1.4 * DPR, (0.30 + 0.25 * glow));
      }

      // The fan of rods — pale, additive, so aligned pendulums read as one
      // bright pendulum that slowly frays into ten.
      const rodA = 0.22 + scratch.flash * 0.10;
      for (let i = 0; i < NPEND; i++) {
        const x1 = cx + Math.sin(pTh1[i]) * L, y1 = cy + Math.cos(pTh1[i]) * L;
        const x2 = x1 + Math.sin(pTh2[i]) * L, y2 = y1 + Math.cos(pTh2[i]) * L;
        ctx.strokeStyle = `rgba(235,240,255,${rodA})`;
        ctx.lineWidth = 1.5 * DPR;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        // Elbow + tip bobs.
        ctx.fillStyle = `rgba(235,240,255,${0.35 + scratch.flash * 0.3})`;
        ctx.beginPath(); ctx.arc(x1, y1, 2.2 * DPR, 0, TAU); ctx.fill();
        const hue = palHue(pal, i / (NPEND - 1));
        // Hat/cymbal hits shimmer the tips — a soft sparkle, not a strobe.
        const r = (3.2 + scratch.flash * 3 + scratch.highsP * 2.2) * DPR;
        const lt = Math.min(92, pal.light + 15 + scratch.highsP * 10);
        ctx.fillStyle = `hsla(${hue},${pal.sat}%,${lt}%,${0.8 * Math.min(1, glow)})`;
        ctx.beginPath(); ctx.arc(x2, y2, r, 0, TAU); ctx.fill();
      }

      // Pivot.
      ctx.fillStyle = 'rgba(235,240,255,0.7)';
      ctx.beginPath(); ctx.arc(cx, cy, 2.6 * DPR, 0, TAU); ctx.fill();

      // Divergence meter — a thin arc of chaos at the bottom.
      const sig01 = Math.min(1, pendSigma / Math.PI);
      const bw = W * 0.24;
      const bx = W / 2 - bw / 2, by = H - 22 * DPR;
      ctx.strokeStyle = 'rgba(150,220,255,0.18)';
      ctx.lineWidth = 2 * DPR;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + bw, by); ctx.stroke();
      const hue = palHue(pal, sig01);
      ctx.strokeStyle = `hsla(${hue},${pal.sat}%,${pal.light + 8}%,${0.7})`;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + bw * sig01, by); ctx.stroke();
    }

    // Lorenz projection: yaw about the vertical (z) axis, gentle pitch,
    // near-orthographic. Attractor spans x,y∈±20, z∈[0,50], centre z≈27.
    function lorProjX(x, y) { return prj.cx + (x * prj.cosY - y * prj.sinY) * prj.S * 1.55; }
    function lorProjY(x, y, z) {
      const ry = x * prj.sinY + y * prj.cosY;
      return prj.cy + (ry * prj.sinP - (z - 27) * prj.cosP) * prj.S * 1.35;
    }

    // 3D ribbon for a tracer — same banded-alpha idea as drawTrail but each
    // stored point carries its own z through the projection.
    function drawTrail3D(ring, head, len, cap, hue, sat, light, width, alpha) {
      if (len < 2) return;
      const per = Math.ceil(len / TRAIL_BANDS);
      const start = (head - len + cap) % cap;
      for (let b = 0; b < TRAIL_BANDS; b++) {
        const from = b * per;
        const to = Math.min(len - 1, (b + 1) * per);
        if (to <= from) continue;
        const bandA = alpha * ((b + 1) / TRAIL_BANDS) * ((b + 1) / TRAIL_BANDS);
        ctx.strokeStyle = `hsla(${hue},${sat}%,${light}%,${bandA})`;
        ctx.lineWidth = width * (0.55 + 0.45 * (b + 1) / TRAIL_BANDS);
        ctx.beginPath();
        for (let k = from; k <= to; k++) {
          const idx = ((start + k) % cap) * 3;
          const x = lorProjX(ring[idx], ring[idx + 1]);
          const y = lorProjY(ring[idx], ring[idx + 1], ring[idx + 2]);
          if (k === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    function renderLorenz(pal, glow) {
      prj.cx = W / 2; prj.cy = H / 2;
      // Bass leans the camera in (±5%) — the attractor breathes with the
      // low end the way ρ alone never visibly could.
      prj.S = (Math.min(W, H) / 62) * (1 + scratch.bass * 0.05);
      prj.cosY = Math.cos(lorYaw); prj.sinY = Math.sin(lorYaw);
      const pitch = -0.42 + (0.5 - poseS.wristY) * 0.6 * poseS.present;
      prj.cosP = Math.cos(pitch); prj.sinP = Math.sin(pitch);

      // Swarm — the flow made visible, banded by altitude (z) so the wings
      // read with depth instead of as flat monochrome dust. Hats sprinkle a
      // brief extra twinkle across the dust.
      const dotA = (0.24 + scratch.total * 0.20 + scratch.highsP * 0.12) * Math.min(1.5, glow);
      const hueDrift = scratch.mids * 20;
      const dr = 1.3 * DPR;
      for (let band = 0; band < 8; band++) {
        const zLo = band * 6.25, zHi = zLo + 6.25;   // z ∈ [0, 50]
        const hue = palHue(pal, band / 7) + hueDrift;
        ctx.fillStyle = `hsla(${hue},${pal.sat}%,${pal.light + band}%,${dotA})`;
        for (let i = 0; i < LOR_SWARM; i++) {
          if (lz[i] < zLo || lz[i] >= zHi) continue;
          ctx.fillRect(lorProjX(lx[i], ly[i]), lorProjY(lx[i], ly[i], lz[i]), dr, dr);
        }
      }

      // Tracers — near-identical twins diverging into separate futures. Alpha
      // stays moderate: eight aligned ribbons summing additively should glow,
      // not clip to white.
      for (let i = 0; i < LOR_TRACERS; i++) {
        const hue = palHue(pal, i / (LOR_TRACERS - 1));
        drawTrail3D(tTrail[i], tTrailHead[i], tTrailLen[i], LOR_TRAIL,
                    hue, pal.sat, pal.light, 1.5 * DPR, 0.22 + 0.14 * glow);
        const hx = lorProjX(tX[i], tY[i]), hy = lorProjY(tX[i], tY[i], tZ[i]);
        const r = (2.6 + scratch.flash * 3.5) * DPR;
        ctx.fillStyle = `hsla(${hue},${pal.sat}%,${Math.min(92, pal.light + 18)}%,0.9)`;
        ctx.beginPath(); ctx.arc(hx, hy, r, 0, TAU); ctx.fill();
      }
    }

    function renderThreeBody(pal, glow) {
      const S = Math.min(W, H) * 0.30;
      const cx = W / 2, cy = H / 2;
      prj.cx = cx; prj.cy = cy; prj.S = S;
      // Mids slowly walk the three hues around the palette ramp.
      const hd = scratch.mids * 18;
      const hues = [palHue(pal, 0) + hd, palHue(pal, 0.5) + hd, palHue(pal, 1) + hd];

      for (let i = 0; i < 3; i++) {
        drawTrail(bTrail[i], bTrailHead[i], bTrailLen[i], TB_TRAIL,
                  flatMapX, flatMapY, hues[i], pal.sat, pal.light,
                  1.7 * DPR, 0.35 + 0.22 * glow);
      }
      for (let i = 0; i < 3; i++) {
        const x = cx + bX[i] * S, y = cy + bY[i] * S;
        const speed = Math.hypot(bVx[i], bVy[i]);
        const r = (4 + Math.min(4, speed * 2.5) + scratch.flash * 3) * DPR;
        // Bass swells each body's halo — three soft suns breathing together.
        const halo = r * (4.5 + scratch.bass * 1.8);
        const grad = ctx.createRadialGradient(x, y, 0, x, y, halo);
        grad.addColorStop(0, `hsla(${hues[i]},${pal.sat}%,${pal.light + 12}%,${0.55 * Math.min(1.4, glow)})`);
        grad.addColorStop(1, `hsla(${hues[i]},${pal.sat}%,${pal.light}%,0)`);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(x, y, halo, 0, TAU); ctx.fill();
        ctx.fillStyle = `hsla(${hues[i]},${Math.max(30, pal.sat - 20)}%,${90 + scratch.highsP * 6}%,0.95)`;
        ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, TAU); ctx.fill();
      }

      // Ghost masses (wrists) — faint pulsing halos so the pull is legible.
      for (const gm of poseS.hands) {
        if (gm[2] <= 0.05) continue;
        const x = cx + gm[0] * S, y = cy + gm[1] * S;
        const r = (16 + scratch.bass * 14) * DPR * gm[2];
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(160,230,255,${0.22 * gm[2]})`);
        grad.addColorStop(1, 'rgba(160,230,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }
    }

    function renderBifurcation(pal, glow) {
      const m = bifM;
      const plotW = W - m.l - m.r, plotH = H - m.t - m.b;

      // The accumulated diagram dust — the whole cascade breathes with the
      // bass and shimmers faintly on hats.
      if (bifCanvas) {
        ctx.globalAlpha = Math.min(1, 0.70 + scratch.bass * 0.24 + scratch.highsP * 0.08);
        ctx.drawImage(bifCanvas, 0, 0);
        ctx.globalAlpha = 1;
      }

      // Feigenbaum marker — the doorway into chaos.
      const feigX = m.l + plotW * (BIF_FEIG - BIF_RMIN) / (BIF_RMAX - BIF_RMIN);
      ctx.strokeStyle = 'rgba(150,220,255,0.20)';
      ctx.lineWidth = 1 * DPR;
      ctx.setLineDash([4 * DPR, 6 * DPR]);
      ctx.beginPath(); ctx.moveTo(feigX, m.t); ctx.lineTo(feigX, m.t + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `${Math.round(10 * DPR)}px ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(150,220,255,0.38)';
      ctx.fillText('r∞', feigX + 4 * DPR, m.t + 12 * DPR);

      // Playhead column — a soft vertical beam that flares on beats.
      const px = m.l + plotW * (bifR - BIF_RMIN) / (BIF_RMAX - BIF_RMIN);
      const beamW = (14 + scratch.bass * 26 + scratch.flash * 20) * DPR;
      const hue = palHue(pal, (bifR - BIF_RMIN) / (BIF_RMAX - BIF_RMIN));
      const grad = ctx.createLinearGradient(px - beamW, 0, px + beamW, 0);
      grad.addColorStop(0,   `hsla(${hue},${pal.sat}%,${pal.light}%,0)`);
      grad.addColorStop(0.5, `hsla(${hue},${pal.sat}%,${pal.light}%,${0.10 + scratch.flash * 0.12})`);
      grad.addColorStop(1,   `hsla(${hue},${pal.sat}%,${pal.light}%,0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(px - beamW, m.t, beamW * 2, plotH);

      // The live orbit at this r — the attractor made of beads. Period-1 is
      // a single bright star; the cascade splits it 2, 4, 8… then dust.
      for (let k = 0; k < BIF_ORBIT; k++) {
        const y = m.t + (1 - bifOrbit[k]) * plotH;
        const recent = k / BIF_ORBIT;
        const r = (1.2 + recent * 2.2 + scratch.flash * 1.5) * DPR;
        ctx.fillStyle = `hsla(${hue},${pal.sat}%,${Math.min(92, pal.light + 16)}%,${(0.10 + recent * 0.5) * Math.min(1.4, glow)})`;
        ctx.beginPath(); ctx.arc(px, y, r, 0, TAU); ctx.fill();
      }

      // Axis whispers.
      ctx.fillStyle = 'rgba(150,220,255,0.30)';
      ctx.fillText('r →', W - m.r - 30 * DPR, m.t + plotH + 16 * DPR);
      ctx.fillText('x', m.l - 14 * DPR, m.t + 10 * DPR);
    }

    function renderDejong(pal, glow) {
      const cx = W / 2, cy = H / 2;
      // Bass breathes the projection scale (±4%) — the same gentle swell as
      // the pendulum fan. The attractor spans roughly ±2.4 in map space.
      const S = Math.min(W, H) * 0.235 * (1 + scratch.bass * 0.04);
      const dr = 1.5 * DPR;
      const bright = Math.min(1.4, glow);

      // Dust motes, batched into contiguous radius→hue bands (counting-
      // sorted in update). Mids drift the whole ramp; hats add a brief
      // sparkle; beat flash blooms the density rather than moving anything.
      const hueDrift = scratch.mids * 24;
      const dotA = Math.min(0.85,
        (0.30 + scratch.flash * 0.10 + scratch.highsP * 0.08) * bright);
      for (let band = 0; band < DJ_BANDS; band++) {
        const from = djBandStart[band], to = djBandStart[band + 1];
        if (to <= from) continue;
        const hue = palHue(pal, band / (DJ_BANDS - 1)) + hueDrift;
        ctx.fillStyle = `hsla(${hue},${pal.sat}%,${pal.light + 4}%,${dotA})`;
        for (let i = from; i < to; i++) {
          ctx.fillRect(cx + djPts[i * 2] * S, cy + djPts[i * 2 + 1] * S, dr, dr);
        }
      }
    }

    // Initial seed happens on the first update via curMode mismatch.
    return {
      resize(w, h, dpr) {
        W = w; H = h; DPR = dpr || 1;
        // Backing-buffer change invalidates trails' pixel mapping only for
        // the bifurcation offscreen; sim-space trails just re-project.
        if (curMode === 'bifurcation') resetBifurcation();
        scratch.clearFrames = 2;
      },
      update,
      render,
      dispose() { /* Canvas2D + typed arrays — GC handles it */ },
    };
  },
};
