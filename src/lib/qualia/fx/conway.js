// Conway — Game of Life cellular automaton on a torus, rendered four ways.
// The sim is one shared grid; `mode` picks the visualization ("phase"):
//   lattice  — flat glowing grid, cells colored by age
//   terrain  — the grid as a 3D plane of light-pillars, extruded by cell age,
//              viewed at a pose-driven angle
//   phosphor — CRT-phosphor afterglow: dead cells cool from white to the
//              palette hue, gliders draw comet paths
//   bloom    — soft nebula: dim lattice + additive glow flares on births
//
// Audio map:
//   bass  → cell glow / pillar height / bloom intensity (slow pump)
//   mids  → hue shift across the palette (audio-reactive color)
//   highs → newborn-cell flash accent
//   beat  → stamps a live pattern (glider / r-pentomino / acorn / LWSS)
//           into the grid — kicks literally seed life
//   total → generation rate (declarative modulator on `rate`)
// Pose map (poseView on):
//   head.x       → view yaw   (terrain orbit; subtle shear in flat modes)
//   headPitch    → view pitch (terrain camera elevation)
//   shoulderRoll → frame roll (flat modes)
// With nobody in frame the view slow-orbits on its own so the angular
// motion never fully stops.

import { scaleAudio, VOID } from '../field.js';

const AGE_CAP             = 48;    // generations before a cell counts as "ancient"
const MAX_STEPS_PER_FRAME = 4;     // sim steps per rAF cap (high rate + hitch guard)
const STAGNANT_GENS       = 36;    // period-1/2 repeats before a soft reseed
const HEAT_HALF_LIFE      = 0.9;   // seconds for phosphor afterglow to halve

// Classic patterns stamped into the grid on beats (and to rescue a dead
// board). Coords are [row, col]; stamps get a random symmetry transform.
const PATTERNS = [
  [[0, 1], [1, 2], [2, 0], [2, 1], [2, 2]],                          // glider
  [[0, 1], [0, 2], [1, 0], [1, 1], [2, 1]],                          // r-pentomino
  [[0, 1], [1, 3], [2, 0], [2, 1], [2, 4], [2, 5], [2, 6]],          // acorn
  [[0, 1], [0, 4], [1, 0], [2, 0], [2, 4], [3, 0], [3, 1], [3, 2], [3, 3]], // LWSS
];

const PALETTES = {
  violet:  { base: 270, accent: 300 },
  cyan:    { base: 190, accent: 220 },
  magenta: { base: 320, accent: 345 },
  amber:   { base:  40, accent:  60 },
};

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'conway',
  name: 'Conway',
  contextType: 'canvas2d',

  params: [
    { id: 'mode',        label: 'mode',       type: 'select',
      options: ['lattice', 'terrain', 'phosphor', 'bloom'], default: 'lattice' },
    { id: 'cell',        label: 'cell size',  type: 'range', min: 6,    max: 28,  step: 1,    default: 12 },
    { id: 'rate',        label: 'gen rate',   type: 'range', min: 0,    max: 24,  step: 0.5,  default: 8,
      modulators: [
        { source: 'audio.total',     mode: 'mul', amount: 0.50 },
        { source: 'audio.beatPulse', mode: 'add', amount: 3.0  },
      ] },
    { id: 'seedDensity', label: 'seed density', type: 'range', min: 0.05, max: 0.5, step: 0.01, default: 0.22 },
    { id: 'glow',        label: 'glow',       type: 'range', min: 0,    max: 2,   step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass',  mode: 'add', amount: 0.40 },
        { source: 'crowd.energy', mode: 'add', amount: 0.30 },
      ] },
    { id: 'palette',     label: 'palette',    type: 'select',
      options: ['violet', 'cyan', 'magenta', 'amber'], default: 'violet' },
    { id: 'poseView',    label: 'pose view',  type: 'toggle', default: true },
    { id: 'reactivity',  label: 'reactivity', type: 'range', min: 0,    max: 2,   step: 0.05, default: 1.0 },
  ],

  // Phase walks the four visualization modes, each paired with the palette
  // it reads best in — lattice violet, terrain cyan relief, magenta ghost
  // trails, amber nebula.
  autoPhase: {
    steps: [
      { mode: 'lattice',  palette: 'violet'  },
      { mode: 'terrain',  palette: 'cyan'    },
      { mode: 'phosphor', palette: 'magenta' },
      { mode: 'bloom',    palette: 'amber'   },
    ],
  },

  presets: {
    default: { mode: 'lattice', cell: 12, rate: 8, seedDensity: 0.22, glow: 1.0,
               palette: 'violet', poseView: true, reactivity: 1.0 },
    relief:  { mode: 'terrain', cell: 14, rate: 10, seedDensity: 0.25, glow: 1.2, palette: 'cyan' },
    ghosts:  { mode: 'phosphor', cell: 9, rate: 5, seedDensity: 0.18, glow: 0.9, palette: 'magenta' },
    nebula:  { mode: 'bloom', cell: 16, rate: 14, seedDensity: 0.14, glow: 1.4, palette: 'amber' },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // ── Grid state (torus) ────────────────────────────────────────────────
    let C = 0, R = 0;              // cols, rows
    let cur, nxt;                  // Uint8Array cell buffers
    let age;                       // Uint16Array generations alive
    let heat;                      // Float32Array phosphor afterglow [0,1]
    let simAcc = 0;                // fractional generations owed
    let hash1 = 0, hash2 = 0;      // grid checksums, last two generations
    let stagnant = 0;              // consecutive period-1/2 generations

    function reseed(density) {
      for (let i = 0; i < C * R; i++) {
        cur[i] = Math.random() < density ? 1 : 0;
        age[i] = cur[i];
        heat[i] = 0;
      }
      simAcc = 0; hash1 = 0; hash2 = 0; stagnant = 0;
    }

    // (Re)allocate when the canvas or cell param changes the grid dims.
    function ensureGrid(cellPx, density) {
      const c = Math.max(24, Math.min(260, Math.round(W / cellPx)));
      const r = Math.max(16, Math.min(160, Math.round(H / cellPx)));
      if (c === C && r === R) return;
      C = c; R = r;
      cur  = new Uint8Array(C * R);
      nxt  = new Uint8Array(C * R);
      age  = new Uint16Array(C * R);
      heat = new Float32Array(C * R);
      reseed(density);
    }

    // Stamp a pattern with one of the 8 square symmetries, wrapped on the torus.
    function stamp(pattern, r0, c0, sym) {
      for (const [pr, pc] of pattern) {
        let rr = pr, cc = pc;
        if (sym & 1) { const t = rr; rr = cc; cc = t; }
        if (sym & 2) rr = -rr;
        if (sym & 4) cc = -cc;
        const r = ((r0 + rr) % R + R) % R;
        const c = ((c0 + cc) % C + C) % C;
        const i = r * C + c;
        cur[i] = 1;
        if (!age[i]) age[i] = 1;
      }
    }

    function stampRandom(n) {
      for (let k = 0; k < n; k++) {
        stamp(PATTERNS[(Math.random() * PATTERNS.length) | 0],
              (Math.random() * R) | 0, (Math.random() * C) | 0,
              (Math.random() * 8) | 0);
      }
    }

    function sprinkle(n) {
      for (let k = 0; k < n; k++) {
        const i = (Math.random() * C * R) | 0;
        cur[i] = 1;
        if (!age[i]) age[i] = 1;
      }
    }

    // One Game of Life generation. Returns population.
    function step() {
      let pop = 0, h = 0;
      for (let r = 0; r < R; r++) {
        const rm = ((r - 1 + R) % R) * C;
        const r0 = r * C;
        const rp = ((r + 1) % R) * C;
        for (let c = 0; c < C; c++) {
          const cm = (c - 1 + C) % C;
          const cp = (c + 1) % C;
          const n = cur[rm + cm] + cur[rm + c] + cur[rm + cp]
                  + cur[r0 + cm]               + cur[r0 + cp]
                  + cur[rp + cm] + cur[rp + c] + cur[rp + cp];
          const i = r0 + c;
          const alive = cur[i] ? (n === 2 || n === 3) : (n === 3);
          nxt[i] = alive ? 1 : 0;
          if (alive) {
            pop++;
            h = (h ^ Math.imul(i + 1, 2654435761)) >>> 0;
            age[i] = Math.min(AGE_CAP + 1, age[i] + 1);
          } else {
            age[i] = 0;
          }
        }
      }
      const t = cur; cur = nxt; nxt = t;

      // Stagnation: still lifes hash-repeat every gen, blinkers every 2.
      if (h === hash1 || h === hash2) stagnant++; else stagnant = 0;
      hash2 = hash1; hash1 = h;
      return pop;
    }

    // ── View state (pose-driven angular viewing, smoothed) ────────────────
    let yaw = 0, pitch = 0, roll = 0;

    // ── Per-frame stash for render() ──────────────────────────────────────
    const scratch = {
      mode: 'lattice', pal: PALETTES.violet,
      bass: 0, mids: 0, highs: 0, beatP: 0, highsP: 0,
      glow: 1, yaw: 0, pitch: 0, roll: 0,
    };

    // Lazy per-frame style cache: styleKey → hsla string. Rebuilt each frame
    // (hue moves with mids) but only for keys actually used.
    const styleCache = new Map();

    // Bloom sprite — a soft radial flare, re-rendered only when its
    // quantized hue changes (mids drift the hue slowly).
    const SPRITE_PX = 64;
    const sprite = document.createElement('canvas');
    sprite.width = SPRITE_PX; sprite.height = SPRITE_PX;
    const sctx = sprite.getContext('2d');
    let spriteHue = -1;
    function ensureSprite(hue) {
      const q = Math.round(hue / 6) * 6;
      if (q === spriteHue) return;
      spriteHue = q;
      sctx.clearRect(0, 0, SPRITE_PX, SPRITE_PX);
      const g = sctx.createRadialGradient(SPRITE_PX / 2, SPRITE_PX / 2, 0,
                                          SPRITE_PX / 2, SPRITE_PX / 2, SPRITE_PX / 2);
      g.addColorStop(0,    `hsla(${q},95%,80%,0.9)`);
      g.addColorStop(0.35, `hsla(${q},90%,60%,0.35)`);
      g.addColorStop(1,    `hsla(${q},90%,50%,0)`);
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    }

    function update(field) {
      if (!W || !H) return;
      const { dt, time, params, channels } = field;
      const audio = scaleAudio(field.audio, params.reactivity);

      ensureGrid(params.cell, params.seedDensity);

      // Beats seed life; hats sprinkle dust.
      if (audio.beat.active)  stampRandom(1 + Math.floor(audio.bands.bass * 3));
      if (audio.highs.active) sprinkle(3 + Math.floor(audio.bands.highs * 6));

      // Advance generations. params.rate already carries the audio.total /
      // beatPulse modulators, so music pushes evolution for free.
      simAcc += dt * Math.max(0, params.rate);
      let steps = 0;
      while (simAcc >= 1 && steps < MAX_STEPS_PER_FRAME) {
        simAcc -= 1; steps++;
        const pop = step();
        if (pop < C * R * 0.015 || stagnant > STAGNANT_GENS) {
          // Board died or settled into still lifes — rescue, don't wipe:
          // stamp fresh runners into whatever remains.
          stampRandom(6);
          sprinkle(Math.floor(C * R * 0.01));
          stagnant = 0;
        }
      }
      if (simAcc >= 1) simAcc = 0; // dropped frames: don't bank a burst

      // Phosphor afterglow — alive pins to 1, dead cools exponentially.
      const cool = Math.pow(0.5, dt / HEAT_HALF_LIFE);
      for (let i = 0; i < C * R; i++) {
        heat[i] = cur[i] ? 1 : heat[i] * cool;
      }

      // Pose-driven view angles, smoothed; slow auto-orbit when idle.
      const conf = channels?.['pose.confidence'] ?? 0;
      let ty, tp, tr;
      if (params.poseView && conf > 0.2) {
        ty = -(channels?.['pose.head.x']       ?? 0);   // mirror: lean left → orbit left
        tp =  (channels?.['pose.headPitch']    ?? 0);
        tr =  (channels?.['pose.shoulderRoll'] ?? 0);
      } else {
        ty = Math.sin(time * 0.13) * 0.6;
        tp = Math.sin(time * 0.09) * 0.35;
        tr = Math.sin(time * 0.05) * 0.2;
      }
      const k = Math.min(1, dt * 3);
      yaw   += (ty - yaw)   * k;
      pitch += (tp - pitch) * k;
      roll  += (tr - roll)  * k;

      scratch.mode   = params.mode;
      scratch.pal    = PALETTES[params.palette] || PALETTES.violet;
      scratch.bass   = audio.bands.bass;
      scratch.mids   = audio.bands.mids;
      scratch.highs  = audio.bands.highs;
      scratch.beatP  = audio.beat.pulse;
      scratch.highsP = audio.highs.pulse;
      scratch.glow   = params.glow;
      scratch.yaw    = yaw;
      scratch.pitch  = pitch;
      scratch.roll   = roll;
    }

    // Age → style bucket: 0 newborn flash, then cooling seniority tiers.
    function ageBucket(a) {
      return a <= 1 ? 0 : a <= 4 ? 1 : a <= 12 ? 2 : a <= 30 ? 3 : 4;
    }

    function cachedStyle(key, make) {
      let s = styleCache.get(key);
      if (s === undefined) { s = make(); styleCache.set(key, s); }
      return s;
    }

    // Subtle pose shear + beat zoom shared by the flat modes.
    function applyFlatView() {
      ctx.translate(W / 2, H / 2);
      const zoom = 1 + scratch.beatP * 0.03;
      ctx.transform(zoom, scratch.roll * 0.06, scratch.yaw * 0.14, zoom, 0, 0);
      ctx.translate(-W / 2, -H / 2);
    }

    function renderLattice(cw, ch) {
      applyFlatView();
      const hue   = scratch.pal.base + scratch.mids * 35;
      const alpha = Math.min(1, (0.55 + scratch.bass * 0.35) * scratch.glow);
      const gap   = Math.max(0.5, cw * 0.12);
      let lastKey = -1;
      for (let r = 0; r < R; r++) {
        const y = r * ch;
        const r0 = r * C;
        for (let c = 0; c < C; c++) {
          if (!cur[r0 + c]) continue;
          const b = ageBucket(age[r0 + c]);
          if (b !== lastKey) {
            lastKey = b;
            ctx.fillStyle = cachedStyle(b, () => {
              if (b === 0) {
                const l = 82 + scratch.highsP * 14;
                return `hsla(${scratch.pal.accent},95%,${l}%,${alpha})`;
              }
              const l = [0, 68, 56, 46, 38][b];
              return `hsla(${hue + b * 10},85%,${l}%,${alpha})`;
            });
          }
          ctx.fillRect(c * cw + gap / 2, y + gap / 2, cw - gap, ch - gap);
        }
      }
    }

    function renderTerrain(cw) {
      // Grid plane orbited by yaw, elevated by pitch; pillars rise with age.
      const cx = W / 2, cy = H * 0.52;
      const yawA  = scratch.yaw * 0.9;
      const cosY  = Math.cos(yawA), sinY = Math.sin(yawA);
      const elev  = 0.5 + scratch.pitch * 0.3;      // camera elevation factor
      const S     = Math.min(W, H) * 1.25;
      const wpx   = Math.max(1.5, cw * 0.5);
      ctx.globalCompositeOperation = 'lighter';
      const hue = scratch.pal.base + scratch.mids * 35;
      let lastKey = -1;
      for (let r = 0; r < R; r++) {
        const gz0 = r / R - 0.5;
        const r0 = r * C;
        for (let c = 0; c < C; c++) {
          const i = r0 + c;
          if (!cur[i]) continue;
          const gx = c / C - 0.5;
          const rx = gx * cosY - gz0 * sinY;
          const rz = gx * sinY + gz0 * cosY;
          const persp = 1 / (1 + rz * 0.85);
          const sx = cx + rx * S * persp;
          const sy = cy + rz * S * 0.42 * elev * persp;
          const a  = Math.min(age[i], 24);
          const hp = (cw * 0.5 + a * cw * 0.14 + scratch.bass * cw * 1.6) * persp;
          // Style bucketed by depth band × age tier so fillStyle swaps stay rare.
          const depthB = Math.min(5, Math.max(0, ((persp - 0.55) * 6) | 0));
          const b = ageBucket(age[i]);
          const key = depthB * 8 + b;
          if (key !== lastKey) {
            lastKey = key;
            ctx.fillStyle = cachedStyle(100 + key, () => {
              const l = b === 0 ? 78 : 62 - b * 6;
              const al = (0.10 + depthB * 0.045) * scratch.glow;
              return `hsla(${b === 0 ? scratch.pal.accent : hue + rz * 25},90%,${l}%,${Math.min(0.6, al)})`;
            });
          }
          const w = wpx * persp;
          ctx.fillRect(sx - w / 2, sy - hp, w, hp);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function renderPhosphor(cw, ch) {
      applyFlatView();
      const hue = scratch.pal.base + scratch.mids * 35;
      const gap = Math.max(0.5, cw * 0.1);
      let lastKey = -1;
      for (let r = 0; r < R; r++) {
        const y = r * ch;
        const r0 = r * C;
        for (let c = 0; c < C; c++) {
          const i = r0 + c;
          let key, x = c * cw;
          if (cur[i]) {
            key = 200; // live: hot white-ish core
          } else {
            const hq = (heat[i] * 8) | 0;    // afterglow, 8 cooling levels
            if (hq < 1) continue;
            key = 210 + hq;
          }
          if (key !== lastKey) {
            lastKey = key;
            ctx.fillStyle = cachedStyle(key, () => {
              if (key === 200) {
                const l = 78 + scratch.highsP * 12;
                return `hsla(${scratch.pal.accent},90%,${l}%,${Math.min(1, 0.9 * scratch.glow)})`;
              }
              const t = (key - 210) / 8;     // 0 cold … 1 just died
              return `hsla(${hue + (1 - t) * 30},85%,${30 + t * 35}%,${(t * 0.55 * scratch.glow).toFixed(3)})`;
            });
          }
          ctx.fillRect(x + gap / 2, y + gap / 2, cw - gap, ch - gap);
        }
      }
    }

    function renderBloom(cw, ch) {
      applyFlatView();
      const hue = scratch.pal.base + scratch.mids * 35;
      // Dim lattice underlay.
      const alpha = Math.min(0.6, (0.3 + scratch.bass * 0.2) * scratch.glow);
      ctx.fillStyle = `hsla(${hue},80%,45%,${alpha})`;
      const gap = Math.max(0.5, cw * 0.25);
      for (let r = 0; r < R; r++) {
        const y = r * ch;
        const r0 = r * C;
        for (let c = 0; c < C; c++) {
          if (cur[r0 + c]) ctx.fillRect(c * cw + gap / 2, y + gap / 2, cw - gap, ch - gap);
        }
      }
      // Additive flares on newborns — births read as sparks in the nebula.
      ensureSprite(scratch.pal.accent + scratch.mids * 20);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, (0.55 + scratch.bass * 0.45 + scratch.beatP * 0.3) * scratch.glow);
      const sz = cw * (3.2 + scratch.beatP * 1.5);
      for (let r = 0; r < R; r++) {
        const y = r * ch + ch / 2;
        const r0 = r * C;
        for (let c = 0; c < C; c++) {
          const i = r0 + c;
          if (cur[i] && age[i] <= 2) {
            ctx.drawImage(sprite, c * cw + cw / 2 - sz / 2, y - sz / 2, sz, sz);
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function render() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = VOID;
      ctx.fillRect(0, 0, W, H);
      if (!C || !R) return;
      styleCache.clear();

      const cw = W / C, ch = H / R;
      ctx.save();
      if      (scratch.mode === 'terrain')  renderTerrain(cw);
      else if (scratch.mode === 'phosphor') renderPhosphor(cw, ch);
      else if (scratch.mode === 'bloom')    renderBloom(cw, ch);
      else                                  renderLattice(cw, ch);
      ctx.restore();
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* GC handles typed arrays + sprite canvas */ },
    };
  },
};
