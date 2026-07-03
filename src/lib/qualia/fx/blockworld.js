// Blockworld — a voxel quale. Very Minecraft-coded, deliberately. Eight
// scenes phase through two kinds of view, an even split:
//
//   world dioramas (isometric): plains · nether · ocean · end
//   character scenes (side cutaway): mine · forge · build · fish
//
// The character scenes are underground/action cross-sections — a blocky
// miner swinging a pickaxe at an ore vein, a smith hammering an anvil, a
// builder stacking a tower to the beat, a night fisher on a dock.
//
// Audio → world:
//   • beat.pulse   — iso: a bounce ring travels the terrain; side: the
//                    character swings (pick / hammer / block placement)
//   • bass         — liquid swell · furnace glow · wave height · rumble
//   • mids.pulse   — mobs hop · torch/spark flares · fish jump
//   • highs.pulse  — scene particles (sparks, bubbles, embers, dust)
//   • rms          — sky / lamp light
//   • hard kicks   — scene events (lightning / ore burst / firework)
//
// Pose → world, via RELATIVE motion only. Performers may be mirrored,
// scaled, or oddly framed on stage, so nothing here reads absolute screen
// position. All features are normalized by torso size (scale-invariant) and
// most use velocity magnitudes (mirror-invariant):
//   • limb speed → world energy: swing/mob pace, particle weather
//   • torso sway — magnitude drives camera pan; only the smoothed
//     *direction* uses sign (a mirrored camera merely reverses pan)
//   • hands-above-shoulders → liquid level, torch/beacon light, bellows
//   • a fast upward centre-of-mass move (a jump) → bounce ring / swing

import { scaleAudio, decay } from '../field.js';

const GRID = 24;
// Phase rotation alternates diorama ↔ character scene.
const SCENES = ['plains', 'mine', 'ocean', 'forge', 'nether', 'build', 'end', 'fish'];
const MAX_PARTICLES = 160;

// ── Materials — top / left / right face colors (pre-shaded, no per-frame
// color math). Kept dusky so the diorama sits on the #05050d page void.
// Side-view tiles use `top` as the face color.
const MATS = {
  grass:    { top: '#4f8a4a', left: '#3b4a33', right: '#2c3826' },
  dirt:     { top: '#6b4d33', left: '#523a26', right: '#3d2b1c' },
  stone:    { top: '#7a7f8c', left: '#565b68', right: '#40444f' },
  stone2:   { top: '#6e7380', left: '#4e5360', right: '#3a3e49' },
  brick:    { top: '#5a5f6e', left: '#454a58', right: '#343846' },
  ore:      { top: '#8b93a6', left: '#5d647a', right: '#464c5e' },
  wood:     { top: '#5d4326', left: '#4a351e', right: '#382817' },
  plank:    { top: '#8a6a3e', left: '#6e5330', right: '#523d23' },
  leaf:     { top: '#2f6b3a', left: '#25522d', right: '#1b3d21' },
  sand:     { top: '#c2b280', left: '#96895f', right: '#6f6546' },
  nether:   { top: '#6e2b2b', left: '#521e1e', right: '#3c1515' },
  glow:     { top: '#e8c46a', left: '#b8964a', right: '#8f7136' },
  obsidian: { top: '#2b2438', left: '#1e1929', right: '#15111d' },
  endstone: { top: '#d9d8a8', left: '#a3a27b', right: '#787757' },
  wool:     { top: '#e8e6df', left: '#bcbab2', right: '#8f8d86' },
  ghast:    { top: '#e5e2ee', left: '#b4b1c4', right: '#8a8798' },
  squid:    { top: '#3a4a6b', left: '#2b3750', right: '#1f283a' },
  ender:    { top: '#17131f', left: '#100d16', right: '#0b0910' },
};

// Ore nugget colors for the side-view vein tiles (drawn over stone).
const ORES = {
  diamond: '#7de8e0',
  gold:    '#e8c46a',
  iron:    '#c9c2b8',
  redstone:'#e25b4a',
  coal:    '#26262e',
};
const ORE_KEYS = Object.keys(ORES);

// Per-scene look. view: 'iso' | 'side'.
const SCENE_DEFS = {
  plains: { view: 'iso',  sky: ['#0b1030', '#233a63'], liquid: null,      particle: '#eef3ff', mob: 'wool',  mobMode: 'walk'  },
  nether: { view: 'iso',  sky: ['#160607', '#3a0d0a'], liquid: '#e2542b', particle: '#ff9a3d', mob: 'ghast', mobMode: 'float' },
  ocean:  { view: 'iso',  sky: ['#04101f', '#0a2f45'], liquid: '#1d5fa0', particle: '#9fd8ff', mob: 'squid', mobMode: 'swim'  },
  end:    { view: 'iso',  sky: ['#05050d', '#0d0a1a'], liquid: null,      particle: '#c9a3ff', mob: 'ender', mobMode: 'walk'  },
  mine:   { view: 'side', sky: ['#08070c', '#0b0a10'], particle: '#cfd6ea' },
  forge:  { view: 'side', sky: ['#0b0709', '#150b0a'], particle: '#ffb45d' },
  build:  { view: 'side', sky: ['#0b1030', '#27406b'], particle: '#eef3ff' },
  fish:   { view: 'side', sky: ['#060a18', '#12274a'], particle: '#9fd8ff' },
};

// Deterministic PRNG so each biome rebuilds the same diorama every visit.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Cheap coordinate hash for stable per-tile texture variety.
function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) ^ 0x2545f491;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Smoothed height field: coarse random lattice, bilinear-interpolated.
function heightField(rand, coarse, lo, hi) {
  const c = new Float32Array(coarse * coarse);
  for (let i = 0; i < c.length; i++) c[i] = rand();
  const out = new Float32Array(GRID * GRID);
  const s = (coarse - 1) / (GRID - 1);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = i * s, y = j * s;
      const x0 = Math.min(coarse - 2, Math.floor(x)), y0 = Math.min(coarse - 2, Math.floor(y));
      const fx = x - x0, fy = y - y0;
      const v = c[y0 * coarse + x0] * (1 - fx) * (1 - fy)
              + c[y0 * coarse + x0 + 1] * fx * (1 - fy)
              + c[(y0 + 1) * coarse + x0] * (1 - fx) * fy
              + c[(y0 + 1) * coarse + x0 + 1] * fx * fy;
      out[j * GRID + i] = lo + v * (hi - lo);
    }
  }
  return out;
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'block_world',
  name: 'Blockworld',
  contextType: 'canvas2d',

  params: [
    { id: 'scene', label: 'scene', type: 'select',
      options: ['plains', 'mine', 'ocean', 'forge', 'nether', 'build', 'end', 'fish'], default: 'plains' },
    { id: 'zoom', label: 'zoom', type: 'range', min: 0.6, max: 1.8, step: 0.05, default: 1.0 },
    { id: 'mobs', label: 'mobs', type: 'range', min: 0, max: 8, step: 1, default: 4 },
    { id: 'drift', label: 'camera drift', type: 'range', min: 0, max: 2, step: 0.05, default: 0.8,
      modulators: [{ source: 'audio.total', mode: 'mul', amount: 0.0 }] },
    { id: 'poseDrive', label: 'pose drive', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { scene: 'plains' },
      { scene: 'mine' },
      { scene: 'ocean' },
      { scene: 'forge' },
      { scene: 'nether' },
      { scene: 'build' },
      { scene: 'end' },
      { scene: 'fish' },
    ],
  },

  presets: {
    default:    { scene: 'plains', zoom: 1.0, mobs: 4, drift: 0.8, poseDrive: 1.0, reactivity: 1.0 },
    deep_vein:  { scene: 'mine', reactivity: 1.2 },
    smithy:     { scene: 'forge', reactivity: 1.3 },
    skyward:    { scene: 'build' },
    night_cast: { scene: 'fish', drift: 0.5 },
    lava_set:   { scene: 'nether', mobs: 5, zoom: 0.95 },
    deep:       { scene: 'ocean', mobs: 6, drift: 0.5 },
    the_end:    { scene: 'end', mobs: 3, zoom: 0.9 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // ── Sprite caches ──────────────────────────────────────────────────────
    // Iso cubes (world scenes) and flat tiles (side scenes), one canvas per
    // (material, size); cleared together when the tile scale changes.
    let tsCached = 0;
    const sprites = new Map();
    function sprite(mat, ts) {
      const key = `iso|${mat}|${ts}`;
      let c = sprites.get(key);
      if (c) return c;
      const bh = Math.round(ts * 0.9);
      c = document.createElement('canvas');
      c.width = ts * 2; c.height = ts + bh;
      const x = c.getContext('2d');
      const m = MATS[mat] || MATS.stone;
      x.fillStyle = m.top;
      x.beginPath();
      x.moveTo(ts, 0); x.lineTo(ts * 2, ts / 2); x.lineTo(ts, ts); x.lineTo(0, ts / 2);
      x.closePath(); x.fill();
      x.fillStyle = m.left;
      x.beginPath();
      x.moveTo(0, ts / 2); x.lineTo(ts, ts); x.lineTo(ts, ts + bh); x.lineTo(0, ts / 2 + bh);
      x.closePath(); x.fill();
      x.fillStyle = m.right;
      x.beginPath();
      x.moveTo(ts, ts); x.lineTo(ts * 2, ts / 2); x.lineTo(ts * 2, ts / 2 + bh); x.lineTo(ts, ts + bh);
      x.closePath(); x.fill();
      x.strokeStyle = 'rgba(255,255,255,0.10)';
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(0, ts / 2); x.lineTo(ts, 0); x.lineTo(ts * 2, ts / 2); x.lineTo(ts, ts); x.closePath();
      x.stroke();
      sprites.set(key, c);
      return c;
    }
    // Flat tile for the side cutaways: face color, bevel light/shadow, and a
    // few baked speckles so a wall of stone doesn't read as a flat fill.
    // `ore` bakes nuggets of that color into the face.
    function tile(mat, s, ore = null) {
      const key = `flat|${mat}|${s}|${ore || ''}`;
      let c = sprites.get(key);
      if (c) return c;
      c = document.createElement('canvas');
      c.width = s; c.height = s;
      const x = c.getContext('2d');
      const m = MATS[mat] || MATS.stone;
      x.fillStyle = m.top;
      x.fillRect(0, 0, s, s);
      x.fillStyle = 'rgba(255,255,255,0.08)';
      x.fillRect(0, 0, s, Math.max(1, s * 0.08));
      x.fillRect(0, 0, Math.max(1, s * 0.08), s);
      x.fillStyle = 'rgba(0,0,0,0.28)';
      x.fillRect(0, s - Math.max(1, s * 0.10), s, Math.max(1, s * 0.10));
      x.fillRect(s - Math.max(1, s * 0.10), 0, Math.max(1, s * 0.10), s);
      x.fillStyle = m.left;
      for (let k = 0; k < 4; k++) {
        const r1 = hash2(k * 7 + s, k * 13 + (ore ? 5 : 0));
        const r2 = hash2(k * 31, s + k);
        x.fillRect(s * (0.15 + r1 * 0.6), s * (0.15 + r2 * 0.6), s * 0.14, s * 0.10);
      }
      if (ore) {
        x.fillStyle = ORES[ore] || '#fff';
        const spots = [[0.22, 0.28], [0.58, 0.18], [0.30, 0.62], [0.64, 0.56], [0.46, 0.40]];
        for (const [px, py] of spots) x.fillRect(s * px, s * py, s * 0.16, s * 0.14);
      }
      sprites.set(key, c);
      return c;
    }

    // ── Blocky minifig (side profile) ──────────────────────────────────────
    // (x, y) = feet centre; s = total height; o = { facing, swing (0..1 arm
    // cycle), bob, tool: 'pickaxe'|'hammer'|'rod'|'block', blockMat, sit }.
    function drawFig(x, y, s, o = {}) {
      const f = o.facing ?? 1;
      const headS = s * 0.26, torsoH = s * 0.36, legH = s * 0.38, bw = s * 0.20;
      const bob = Math.sin(o.bob || 0) * s * 0.02;
      const skin = '#c8987a', shirt = '#7c5cd6', pants = '#2a2440', hair = '#241a14';
      ctx.save();
      ctx.translate(x, y + bob);
      // legs (walk scissor when bobbing)
      const lw = bw * 0.42, walk = Math.sin(o.bob || 0) * s * 0.05;
      ctx.fillStyle = pants;
      if (o.sit) {
        ctx.fillRect(-bw / 2, -legH * 0.45, bw, legH * 0.45);           // thighs folded
        ctx.fillRect(f * bw * 0.3, -legH * 0.45, lw, legH * 0.45);
      } else {
        ctx.fillRect(-lw / 2 - walk / 2, -legH, lw, legH);
        ctx.fillRect(-lw / 2 + walk / 2 + lw * 0.4, -legH, lw, legH);
      }
      const hipY = o.sit ? -legH * 0.45 : -legH;
      // back arm (behind torso, slightly darker)
      ctx.fillStyle = '#5c44a8';
      ctx.fillRect(-bw / 2 - lw * 0.4 * f, hipY - torsoH, lw * 0.8, torsoH * 0.9);
      // torso
      ctx.fillStyle = shirt;
      ctx.fillRect(-bw / 2, hipY - torsoH, bw, torsoH);
      // head
      const hy = hipY - torsoH - headS;
      ctx.fillStyle = skin;
      ctx.fillRect(-headS / 2, hy, headS, headS);
      ctx.fillStyle = hair;
      ctx.fillRect(-headS / 2, hy, headS, headS * 0.28);
      ctx.fillStyle = '#17131f';
      ctx.fillRect(f * headS * 0.18, hy + headS * 0.42, headS * 0.14, headS * 0.14);  // eye
      // front arm + tool, rotated at the shoulder
      const shY = hipY - torsoH + torsoH * 0.10;
      const armL = s * 0.34;
      // swing: raise up-and-back then strike down past horizontal
      const ang = (o.armAngle != null)
        ? o.armAngle
        : -0.35 - Math.sin((o.swing || 0) * Math.PI) * 1.9;
      ctx.save();
      ctx.translate(0, shY);
      ctx.rotate(f * ang);
      ctx.fillStyle = shirt;
      ctx.fillRect(-lw * 0.4, 0, lw * 0.8, armL);
      ctx.fillStyle = skin;
      ctx.fillRect(-lw * 0.4, armL * 0.8, lw * 0.8, armL * 0.2);
      // tool in hand — drawn along the arm's axis
      if (o.tool === 'pickaxe') {
        ctx.fillStyle = '#6e5330';
        ctx.fillRect(-lw * 0.22, armL, lw * 0.44, armL * 1.05);          // handle
        ctx.fillStyle = '#9aa0b0';
        ctx.save();
        ctx.translate(0, armL * 2.0);
        ctx.rotate(0.5);  ctx.fillRect(-s * 0.30, -lw * 0.30, s * 0.30, lw * 0.5);
        ctx.rotate(-1.0); ctx.fillRect(0, -lw * 0.30, s * 0.30, lw * 0.5);
        ctx.restore();
      } else if (o.tool === 'hammer') {
        ctx.fillStyle = '#6e5330';
        ctx.fillRect(-lw * 0.22, armL, lw * 0.44, armL * 0.8);
        ctx.fillStyle = '#8a8fa0';
        ctx.fillRect(-s * 0.11, armL * 1.7, s * 0.22, s * 0.13);
      } else if (o.tool === 'rod') {
        ctx.strokeStyle = '#6e5330';
        ctx.lineWidth = Math.max(1.5, lw * 0.25);
        ctx.beginPath(); ctx.moveTo(0, armL); ctx.lineTo(0, armL + s * 0.75); ctx.stroke();
      } else if (o.tool === 'block' && o.blockMat) {
        ctx.drawImage(tile(o.blockMat, Math.max(4, Math.round(s * 0.18))), -s * 0.09, armL);
      }
      ctx.restore();
      ctx.restore();
    }

    // ── Iso scene state (rebuilt on scene switch — not the hot path) ──────
    const hgt   = new Float32Array(GRID * GRID);
    const distC = new Float32Array(GRID * GRID);
    const colOff = new Float32Array(GRID * GRID);
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const dx = i - (GRID - 1) / 2, dy = j - (GRID - 1) / 2;
        distC[j * GRID + i] = Math.sqrt(dx * dx + dy * dy);
      }
    }
    let drawList = new Int16Array(0);
    let drawLen = 0;
    const matNames = Object.keys(MATS);
    const matIdx = (m) => matNames.indexOf(m);
    let beacons = [];
    let liquidBase = 0;
    let activeScene = null;

    // ── Side scene state (reset in buildScene) ─────────────────────────────
    const side = {
      swing: 0, struck: false,          // arm cycle 1→0; strike edge at 0.5
      strikeGlow: 0,                    // impact flash envelope
      hits: 0, ore: 'diamond',          // mining target
      drops: Array.from({ length: 6 }, () => ({ life: 0, x: 0, y: 0, vx: 0, vy: 0, ore: 'gold' })),
      idleClock: 0,
      heat: 0, clang: 0,                // forge
      tower: [], towerAnim: 0,          // build (mats, newest last)
      fw: { t: 9, x: 0.5, y: 0.5 },     // firework
      bobY: 0, fishT: 9, fishX: 0.75, castT: 0, biteT: 2,   // fish
      waveP: new Float32Array(48),      // sampled waveform for the water line
    };
    const TOWER_MATS = ['plank', 'stone', 'brick', 'stone2'];

    function buildScene(scene) {
      activeScene = scene;
      const rand = mulberry32(1337 + SCENES.indexOf(scene) * 7919);
      beacons = [];
      liquidBase = 0;
      parts.fill(0);                     // side/iso pools read coords differently
      const def = SCENE_DEFS[scene];

      if (def.view === 'side') {
        drawLen = 0;
        side.swing = 0; side.struck = false; side.strikeGlow = 0;
        side.hits = 0; side.ore = ORE_KEYS[Math.floor(rand() * 3)];
        for (const d of side.drops) d.life = 0;
        side.idleClock = 0;
        side.heat = 0; side.clang = 0;
        side.tower = ['stone', 'stone', 'plank'];
        side.towerAnim = 0;
        side.fw.t = 9;
        side.fishT = 9; side.castT = 0; side.biteT = 1 + rand() * 2;
        return;
      }

      const list = [];
      const push = (i, j, k, m) => list.push(i, j, k, matIdx(m));

      let top = 'grass', under = 'dirt';
      if (scene === 'plains') {
        const f = heightField(rand, 6, 1, 3.6);
        for (let n = 0; n < GRID * GRID; n++) hgt[n] = Math.round(f[n]);
      } else if (scene === 'nether') {
        top = 'nether'; under = 'nether';
        const f = heightField(rand, 6, 0.4, 4.6);
        for (let n = 0; n < GRID * GRID; n++) hgt[n] = Math.round(f[n]);
        liquidBase = 1.15;
      } else if (scene === 'ocean') {
        top = 'sand'; under = 'stone';
        const f = heightField(rand, 6, 0.6, 2.4);
        for (let n = 0; n < GRID * GRID; n++) hgt[n] = Math.round(f[n]);
        liquidBase = 3.1;
      } else { // end
        top = 'endstone'; under = 'endstone';
        const f = heightField(rand, 6, 1.5, 3.5);
        for (let n = 0; n < GRID * GRID; n++) {
          const fall = Math.max(0, 1 - Math.pow(distC[n] / (GRID * 0.48), 3));
          hgt[n] = fall > 0.12 ? Math.max(1, Math.round(f[n] * fall)) : 0;
        }
      }

      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const h = hgt[j * GRID + i];
          if (h <= 0) continue;
          const nI = i + 1 < GRID ? hgt[j * GRID + i + 1] : 0;
          const nJ = j + 1 < GRID ? hgt[(j + 1) * GRID + i] : 0;
          const kMin = Math.max(0, Math.min(h - 1, Math.min(nI, nJ)));
          for (let k = kMin; k < h; k++) {
            let m = k === h - 1 ? top : under;
            if (scene === 'nether' && k === h - 1 && rand() < 0.06) m = 'glow';
            push(i, j, k, m);
          }
        }
      }

      if (scene === 'plains') {
        for (let t = 0; t < 7; t++) {
          const i = 2 + Math.floor(rand() * (GRID - 4));
          const j = 2 + Math.floor(rand() * (GRID - 4));
          const h = hgt[j * GRID + i];
          const trunk = 2 + Math.floor(rand() * 2);
          for (let k = 0; k < trunk; k++) push(i, j, h + k, 'wood');
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= GRID || jj >= GRID) continue;
              if (Math.abs(di) + Math.abs(dj) === 2 && rand() < 0.4) continue;
              push(ii, jj, h + trunk, 'leaf');
            }
          }
          push(i, j, h + trunk + 1, 'leaf');
        }
      } else if (scene === 'end') {
        for (let t = 0; t < 4; t++) {
          const ang = rand() * Math.PI * 2, r = GRID * (0.18 + rand() * 0.14);
          const i = Math.round(GRID / 2 + Math.cos(ang) * r);
          const j = Math.round(GRID / 2 + Math.sin(ang) * r);
          if (i < 1 || j < 1 || i >= GRID - 1 || j >= GRID - 1) continue;
          const h = hgt[j * GRID + i];
          if (h <= 0) continue;
          const ph = 3 + Math.floor(rand() * 3);
          for (let k = 0; k < ph; k++) push(i, j, h + k, 'obsidian');
          push(i, j, h + ph, 'glow');
          beacons.push({ i, j, h: h + ph + 1 });
        }
      } else if (scene === 'ocean') {
        for (let t = 0; t < 10; t++) {
          const i = Math.floor(rand() * GRID), j = Math.floor(rand() * GRID);
          const h = hgt[j * GRID + i];
          for (let k = 0; k < 1 + Math.floor(rand() * 2); k++) push(i, j, h + k, 'leaf');
        }
      }

      const n = list.length / 4;
      const order = new Array(n);
      for (let e = 0; e < n; e++) order[e] = e;
      order.sort((a, b) => {
        const da = list[a * 4] + list[a * 4 + 1], db = list[b * 4] + list[b * 4 + 1];
        return da - db || list[a * 4 + 2] - list[b * 4 + 2];
      });
      drawList = new Int16Array(list.length);
      for (let e = 0; e < n; e++) {
        drawList[e * 4]     = list[order[e] * 4];
        drawList[e * 4 + 1] = list[order[e] * 4 + 1];
        drawList[e * 4 + 2] = list[order[e] * 4 + 2];
        drawList[e * 4 + 3] = list[order[e] * 4 + 3];
      }
      drawLen = n;
    }

    // ── Mobs (iso scenes) ──────────────────────────────────────────────────
    const mobs = [];
    function ensureMobs(count) {
      while (mobs.length < count) {
        mobs.push({
          x: Math.random() * GRID, y: Math.random() * GRID,
          dx: 0, dy: 0, retarget: 0, hop: 0,
          bob: Math.random() * Math.PI * 2, blink: 0,
        });
      }
      mobs.length = Math.min(mobs.length, count);
    }

    // ── Particles — flat pool. Iso scenes spawn in GRID coords; side scenes
    // spawn in normalized [0,1] screen coords (the pool is zeroed on scene
    // switch, so the two interpretations never mix).
    const parts = new Float32Array(MAX_PARTICLES * 6);  // x, y, vx, vy, life, size
    let partHead = 0;
    function spawnPart(x, y, vx, vy, life, size) {
      const o = partHead * 6;
      parts[o] = x; parts[o + 1] = y; parts[o + 2] = vx; parts[o + 3] = vy;
      parts[o + 4] = life; parts[o + 5] = size;
      partHead = (partHead + 1) % MAX_PARTICLES;
    }
    function burst(x, y, count, speed, life) {
      for (let s = 0; s < count; s++) {
        const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random());
        spawnPart(x, y, Math.cos(a) * v, Math.sin(a) * v - speed * 0.4,
                  life * (0.5 + Math.random()), 1 + Math.random() * 2);
      }
    }

    // ── Pose relative-motion tracker (mirror / scale invariant) ────────────
    const trk = {
      seen: false,
      pLx: 0, pLy: 0, pRx: 0, pRy: 0, pCx: 0, pCy: 0,
      energy: 0, swayAmt: 0, swayDir: 0, lift: 0, jump: 0,
    };
    function trackPose(pose, dt, drive) {
      const p = pose.people[0];
      const dk = Math.min(1, dt * 3);
      let ok = false;
      if (p && p.confidence > 0.3 && drive > 0) {
        const sL = p.shoulders.l, sR = p.shoulders.r, hL = p.hips.l, hR = p.hips.r;
        const wL = p.wrists.l, wR = p.wrists.r;
        if (sL.visibility > 0.4 && sR.visibility > 0.4) {
          const scx = (sL.x + sR.x) / 2, scy = (sL.y + sR.y) / 2;
          const hipsOk = hL.visibility > 0.3 && hR.visibility > 0.3;
          const hcx = hipsOk ? (hL.x + hR.x) / 2 : scx;
          const hcy = hipsOk ? (hL.y + hR.y) / 2 : scy + 0.25;
          const s = Math.max(0.05, Math.hypot(hcx - scx, hcy - scy));
          const cx = (scx + hcx) / 2, cy = (scy + hcy) / 2;
          const nLx = (wL.x - cx) / s, nLy = (wL.y - cy) / s;
          const nRx = (wR.x - cx) / s, nRy = (wR.y - cy) / s;
          if (trk.seen && dt > 0.001) {
            const vL = Math.hypot(nLx - trk.pLx, nLy - trk.pLy) / dt;
            const vR = Math.hypot(nRx - trk.pRx, nRy - trk.pRy) / dt;
            const wristsOk = wL.visibility > 0.3 && wR.visibility > 0.3;
            const e = wristsOk ? Math.min(1, (vL + vR) * 0.5 / 6) : 0;
            trk.energy += (e * drive - trk.energy) * dk;
            const vcx = (cx - trk.pCx) / dt, vcy = (cy - trk.pCy) / dt;
            trk.swayAmt += (Math.min(1, Math.abs(vcx) / 0.8) * drive - trk.swayAmt) * dk;
            trk.swayDir += ((vcx > 0 ? 1 : vcx < 0 ? -1 : 0) - trk.swayDir) * Math.min(1, dt * 1.2);
            if (vcy < -0.9) trk.jump = Math.min(1, trk.jump + 0.8 * drive);
          }
          const raise = Math.max(0, ((cy - Math.min(wL.y, wR.y)) / s) - 0.9);
          trk.lift += (Math.min(1, raise * 0.8) * drive - trk.lift) * dk;
          trk.pLx = nLx; trk.pLy = nLy; trk.pRx = nRx; trk.pRy = nRy;
          trk.pCx = cx; trk.pCy = cy;
          trk.seen = true;
          ok = true;
        }
      }
      if (!ok) {
        trk.seen = false;
        trk.energy  += (0 - trk.energy)  * dk * 0.5;
        trk.swayAmt += (0 - trk.swayAmt) * dk * 0.5;
        trk.lift    += (0 - trk.lift)    * dk * 0.5;
      }
      trk.jump = decay(trk.jump, dt, 0.30);
    }

    // ── Frame state ────────────────────────────────────────────────────────
    let beatRingT = 9;
    let eventFlash = 0;
    let liquidLvl = 0;
    let camX = 0;
    const bolt = new Float32Array(16);
    let boltLife = 0;

    const scratch = {
      time: 0, dt: 0, bass: 0, mids: 0, highs: 0, rms: 0,
      beatPulse: 0, midsPulse: 0, highsPulse: 0,
      scene: 'plains', zoom: 1, drift: 0.8, audioOn: false,
      energy: 0, lift: 0, sway: 0,
    };

    // One "action" trigger shared by all character scenes: the kick, a
    // performer jump, or — with audio off — a motion-paced idle metronome
    // so the scene never freezes.
    function actionTrigger(audio, dt) {
      if (audio.beat.active || trk.jump > 0.55) { trk.jump *= 0.4; return true; }
      if (!scratch.audioOn) {
        side.idleClock += dt * (0.9 + trk.energy * 2.5);
        if (side.idleClock >= 1.1) { side.idleClock = 0; return true; }
      }
      return false;
    }

    function updateSide(scene, audio, field) {
      const dt = field.dt;
      const fire = actionTrigger(audio, dt);

      // Swing cycle (mine / forge / build) — 1 → 0 over ~0.28s; the strike
      // lands when the cycle crosses 0.5 on the way down.
      if (scene !== 'fish' && fire && side.swing < 0.35) { side.swing = 1; side.struck = false; }
      const prevSwing = side.swing;
      side.swing = Math.max(0, side.swing - dt * 3.6);
      const strikeNow = !side.struck && prevSwing > 0.5 && side.swing <= 0.5;

      if (scene === 'mine' && strikeNow) {
        side.struck = true;
        side.strikeGlow = 1;
        side.hits++;
        burst(0.66, 0.505, 5 + Math.round(scratch.bass * 6), 0.25, 0.5);
        if (side.hits >= 3) {
          side.hits = 0;
          burst(0.66, 0.505, 16, 0.45, 0.8);                     // ore shatters
          for (const d of side.drops) {                          // pop a drop
            if (d.life <= 0) {
              d.life = 1.4; d.x = 0.655; d.y = 0.50;
              d.vx = -0.18 - Math.random() * 0.1; d.vy = -0.5; d.ore = side.ore;
              break;
            }
          }
          side.ore = ORE_KEYS[Math.floor(Math.random() * ORE_KEYS.length)];
        }
      }
      if (scene === 'forge' && strikeNow) {
        side.struck = true;
        side.strikeGlow = 1;
        side.clang = 1;
        side.heat = Math.min(1, side.heat + 0.25);
        burst(0.565, 0.585, 8 + Math.round(scratch.bass * 8), 0.4, 0.5);
      }
      if (scene === 'build' && strikeNow) {
        side.struck = true;
        side.tower.push(TOWER_MATS[side.tower.length % TOWER_MATS.length]);
        side.towerAnim = 1;
        if (side.tower.length > 400) side.tower.length = 3;      // arbo reset
        // hard kick → firework
        if (audio.bands.bass > 0.7 && side.fw.t > 1.2) {
          side.fw.t = 0; side.fw.x = 0.3 + Math.random() * 0.4; side.fw.y = 0.18 + Math.random() * 0.2;
        }
      }
      side.towerAnim = Math.max(0, side.towerAnim - dt * 4);
      side.strikeGlow = decay(side.strikeGlow, dt, 0.12);
      side.clang = decay(side.clang, dt, 0.18);
      side.heat = Math.max(0, side.heat - dt * 0.05);
      side.fw.t += dt;
      if (side.fw.t > 0.55 && side.fw.t - dt <= 0.55) {          // rocket → burst
        burst(side.fw.x, side.fw.y, 26, 0.35, 1.0);
      }

      // Fish scene beats: bobber physics + fish arcs on snares.
      if (scene === 'fish') {
        side.biteT -= dt;
        if ((audio.mids.active && side.fishT > 1.4) || side.biteT <= 0) {
          side.fishT = 0;
          side.fishX = 0.62 + Math.random() * 0.25;
          side.biteT = 2.5 + Math.random() * 4;
          burst(side.fishX, 0.615, 8, 0.2, 0.6);
        }
        side.fishT += dt;
        if (fire) side.castT = 1;                                 // re-cast on kick/jump
        side.castT = Math.max(0, side.castT - dt * 2);
        // Sample the waveform for the water surface line.
        const wf = field.audio.waveform;
        const wp = side.waveP;
        if (wf && wf.length) {
          const step = wf.length / wp.length;
          for (let i = 0; i < wp.length; i++) {
            wp[i] += (((wf[(i * step) | 0] - 128) / 128) - wp[i]) * Math.min(1, dt * 10);
          }
        } else {
          for (let i = 0; i < wp.length; i++) {
            wp[i] = Math.sin(field.time * 1.4 + i * 0.5) * 0.3;
          }
        }
      }

      // Ambient particle weather per scene (normalized coords).
      const rate = (audio.highs.pulse * 16 + trk.energy * 10 + 1.0) * dt;
      const whole = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
      for (let s = 0; s < whole; s++) {
        if (scene === 'mine')       spawnPart(Math.random(), 0.1 + Math.random() * 0.5, 0, 0.03 + Math.random() * 0.05, 2, 1);
        else if (scene === 'forge') spawnPart(0.78 + Math.random() * 0.06, 0.52, (Math.random() - 0.5) * 0.05, -0.12 - Math.random() * 0.1, 1.2, 1.5);
        else if (scene === 'build') spawnPart(Math.random(), 1.02, (Math.random() - 0.5) * 0.02, -0.05 - Math.random() * 0.04, 2.5, 1);
        else                        spawnPart(0.4 + Math.random() * 0.55, 0.60, (Math.random() - 0.5) * 0.04, -0.08, 1.2, 1.2);
      }

      // Item drops (mine) — little arcs with gravity, fade out.
      for (const d of side.drops) {
        if (d.life <= 0) continue;
        d.life -= dt;
        d.vy += dt * 1.6;
        d.x += d.vx * dt; d.y += d.vy * dt;
        if (d.y > 0.695) { d.y = 0.695; d.vy *= -0.35; d.vx *= 0.7; }
      }
    }

    function update(field) {
      const params = field.params;
      const audio = scaleAudio(field.audio, params.reactivity);
      const dt = field.dt;

      const scene = SCENES.includes(params.scene) ? params.scene : 'plains';
      if (scene !== activeScene) buildScene(scene);
      const def = SCENE_DEFS[scene];

      trackPose(field.pose, dt, params.poseDrive);

      scratch.time = field.time; scratch.dt = dt;
      scratch.bass = audio.bands.bass; scratch.mids = audio.bands.mids;
      scratch.highs = audio.bands.highs; scratch.rms = audio.rms;
      scratch.beatPulse = audio.beat.pulse; scratch.midsPulse = audio.mids.pulse;
      scratch.highsPulse = audio.highs.pulse;
      scratch.scene = scene; scratch.zoom = params.zoom; scratch.drift = params.drift;
      scratch.audioOn = !!field.audio.spectrum;
      scratch.energy = trk.energy; scratch.lift = trk.lift;
      scratch.sway = trk.swayDir * trk.swayAmt;

      if (def.view === 'side') {
        updateSide(scene, audio, field);
        // Camera micro-pan from sway (kept subtle on side scenes).
        camX += (scratch.sway * Math.min(W, H) * 0.02 - camX) * Math.min(1, dt * 2);
        eventFlash = decay(eventFlash, dt, 0.20);
      } else {
        ensureMobs(Math.round(params.mobs));

        if (audio.beat.active || trk.jump > 0.55) { beatRingT = 0; trk.jump *= 0.4; }
        beatRingT += dt;

        const ringR = beatRingT * 13;
        const ringA = Math.exp(-beatRingT * 2.4) * (0.55 + audio.bands.bass * 0.5);
        const shimmer = trk.energy * 0.12;
        for (let n = 0; n < GRID * GRID; n++) {
          const d = distC[n] - ringR;
          let off = ringA * Math.exp(-d * d * 0.55);
          if (shimmer > 0.004) off += shimmer * Math.sin(field.time * 7 + n * 1.7);
          colOff[n] = off;
        }

        const lTarget = liquidBase > 0 ? liquidBase + audio.bands.bass * 1.1 + trk.lift * 1.4 : 0;
        liquidLvl += (lTarget - liquidLvl) * Math.min(1, dt * 3);

        const panT = trk.swayDir * trk.swayAmt * Math.min(W, H) * 0.06
                   + Math.sin(field.time * 0.13) * params.drift * Math.min(W, H) * 0.02;
        camX += (panT - camX) * Math.min(1, dt * 2);

        if (audio.beat.active && audio.bands.bass > 0.72 && eventFlash < 0.2) {
          eventFlash = 1;
          if (scene === 'plains') {
            let bx = W * (0.25 + Math.random() * 0.5), by = 0;
            for (let s = 0; s < 8; s++) {
              bolt[s * 2] = bx; bolt[s * 2 + 1] = by;
              bx += (Math.random() - 0.5) * W * 0.06;
              by += H * 0.09;
            }
            boltLife = 1;
          }
        }
        eventFlash = decay(eventFlash, dt, 0.20);
        boltLife = decay(boltLife, dt, 0.10);

        const pace = 0.5 + trk.energy * 2.2 + audio.bands.total * 0.6;
        for (const mb of mobs) {
          mb.retarget -= dt;
          if (mb.retarget <= 0) {
            const a = Math.random() * Math.PI * 2;
            mb.dx = Math.cos(a); mb.dy = Math.sin(a);
            mb.retarget = 1.5 + Math.random() * 3;
          }
          const nx = Math.min(GRID - 1, Math.max(0, mb.x + mb.dx * dt * pace));
          const ny = Math.min(GRID - 1, Math.max(0, mb.y + mb.dy * dt * pace));
          const stepH = hgt[Math.round(ny) * GRID + Math.round(nx)];
          if (def.mobMode === 'walk' && stepH <= 0) {
            mb.dx = -mb.dx; mb.dy = -mb.dy; mb.retarget = Math.min(mb.retarget, 0.5);
          } else { mb.x = nx; mb.y = ny; }
          if (audio.mids.active) mb.hop = 1;
          mb.hop = decay(mb.hop, dt, 0.16);
          mb.bob += dt * (1.2 + audio.bands.mids);
          if (Math.random() < dt * 0.3) mb.blink = 0.15;
          mb.blink = Math.max(0, mb.blink - dt);
        }

        const spawnRate = (audio.highs.pulse * 26 + trk.energy * 20 + 1.5) * dt;
        const whole = Math.floor(spawnRate) + (Math.random() < spawnRate % 1 ? 1 : 0);
        for (let s = 0; s < whole; s++) {
          const gx = Math.random() * GRID, gy = Math.random() * GRID;
          const up = scene === 'ocean' || scene === 'nether' ? -1 : (Math.random() < 0.5 ? -1 : -0.3);
          spawnPart(gx, gy, (Math.random() - 0.5) * 0.4, up * (0.6 + Math.random()),
                    0.8 + Math.random() * 1.4, 1 + Math.random() * 2);
        }
      }

      // Advance the particle pool (shared).
      for (let n = 0; n < MAX_PARTICLES; n++) {
        const o = n * 6;
        if (parts[o + 4] <= 0) continue;
        parts[o]     += parts[o + 2] * dt;
        parts[o + 1] += parts[o + 3] * dt;
        parts[o + 4] -= dt;
      }
    }

    // ── Side-view renderers ────────────────────────────────────────────────
    // Layouts in fractions of W (x) and H (y); m scales figure/tile sizes.

    function renderSideCommon(def) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, def.sky[0]);
      g.addColorStop(1, def.sky[1]);
      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = g;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    // Wall of flat tiles covering [x0,x1)×[y0,y1) (fractions); mats vary by
    // hash. Interiors aren't carved out — callers darken their room rect so
    // the "excavated" space still shows back-wall texture, not flat black.
    function tileWall(ts, x0, y0, x1, y1, mats) {
      const i0 = Math.floor(x0 * W / ts), i1 = Math.ceil(x1 * W / ts);
      const j0 = Math.floor(y0 * H / ts), j1 = Math.ceil(y1 * H / ts);
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          const mat = mats[Math.floor(hash2(i, j) * mats.length)];
          ctx.drawImage(tile(mat, ts), i * ts, j * ts);
        }
      }
    }

    // Radial "torch dark" — black overlay with a soft transparent hole.
    function torchDark(x, y, radius, darkness) {
      const g = ctx.createRadialGradient(x, y, radius * 0.25, x, y, radius);
      g.addColorStop(0, 'rgba(2,2,8,0)');
      g.addColorStop(1, `rgba(2,2,8,${darkness})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    function renderMine(m, ts) {
      const t = scratch.time;
      const floorY = 0.70, wallX = 0.64;
      // rumble on heavy bass
      const shake = Math.max(0, scratch.bass - 0.6) * m * 0.012;
      ctx.save();
      if (shake > 0.2) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

      // solid rock everywhere; the tunnel is the same rock, dimmed — an
      // excavated pocket with a visible back wall, not a black void
      tileWall(ts, 0, 0, 1, 1, ['stone', 'stone2', 'stone', 'dirt']);
      ctx.fillStyle = 'rgba(3,3,9,0.62)';
      ctx.fillRect(0, (floorY - 0.34) * H, wallX * W, 0.34 * H);

      // ore vein on the working face — target tile at arm height + neighbors
      const tgtX = Math.floor(wallX * W / ts) * ts, tgtY = Math.floor(0.50 * H / ts) * ts;
      ctx.drawImage(tile('stone', ts, side.ore), tgtX, tgtY);
      ctx.drawImage(tile('stone2', ts, 'coal'), tgtX, tgtY - ts);
      ctx.drawImage(tile('stone', ts, 'iron'), tgtX + ts, tgtY + ts * 0.0);
      ctx.drawImage(tile('stone2', ts, 'gold'), tgtX, tgtY + ts);
      // cracks proportional to hits
      if (side.hits > 0) {
        ctx.strokeStyle = 'rgba(8,8,14,0.85)';
        ctx.lineWidth = Math.max(1, ts * 0.05);
        ctx.beginPath();
        for (let c = 0; c < side.hits * 2; c++) {
          const a = c * 2.4, r1 = ts * 0.12, r2 = ts * (0.22 + 0.12 * side.hits);
          ctx.moveTo(tgtX + ts / 2 + Math.cos(a) * r1, tgtY + ts / 2 + Math.sin(a) * r1);
          ctx.lineTo(tgtX + ts / 2 + Math.cos(a + 0.4) * r2, tgtY + ts / 2 + Math.sin(a + 0.4) * r2);
        }
        ctx.stroke();
      }
      // strike impact flash on the face
      if (side.strikeGlow > 0.03) {
        ctx.globalAlpha = side.strikeGlow * 0.7;
        ctx.fillStyle = '#fff7d8';
        ctx.fillRect(tgtX, tgtY, ts, ts);
        ctx.globalAlpha = 1;
      }

      // torch on the back wall — flame + a soft glow halo that flickers
      const tx = 0.30 * W, tyy = (floorY - 0.26) * H;
      ctx.fillStyle = '#6e5330';
      ctx.fillRect(tx - ts * 0.06, tyy, ts * 0.12, ts * 0.45);
      const flick = 0.8 + Math.sin(t * 11) * 0.12 + scratch.midsPulse * 0.5;
      const halo = ctx.createRadialGradient(tx, tyy - ts * 0.1, 0, tx, tyy - ts * 0.1, ts * 1.6);
      halo.addColorStop(0, `rgba(255,180,93,${0.30 * Math.min(1, flick)})`);
      halo.addColorStop(1, 'rgba(255,180,93,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(tx - ts * 1.6, tyy - ts * 1.7, ts * 3.2, ts * 3.2);
      ctx.fillStyle = '#ffb45d';
      ctx.globalAlpha = Math.min(1, flick);
      ctx.fillRect(tx - ts * 0.10, tyy - ts * 0.22, ts * 0.20, ts * 0.24);
      ctx.globalAlpha = 1;

      // rails on the floor
      ctx.fillStyle = '#3a3f4a';
      ctx.fillRect(0, floorY * H - ts * 0.10, wallX * W, ts * 0.08);

      // miner — swings at the face; motion energy bobs the stance
      drawFig(0.53 * W + camX, floorY * H, m * 0.30, {
        facing: 1, tool: 'pickaxe', swing: side.swing,
        bob: t * (2 + scratch.energy * 6),
      });

      // item drops
      for (const d of side.drops) {
        if (d.life <= 0) continue;
        ctx.globalAlpha = Math.min(1, d.life);
        ctx.drawImage(tile('stone', Math.max(4, Math.round(ts * 0.4)), d.ore), d.x * W, d.y * H);
        ctx.globalAlpha = 1;
      }

      // lighting: torch + raised-hands widen the lit pocket
      const lightR = m * (0.52 + scratch.lift * 0.4 + scratch.beatPulse * 0.05);
      torchDark(0.45 * W, (floorY - 0.18) * H, lightR, 0.82);
      ctx.restore();
    }

    function renderForge(m, ts) {
      const t = scratch.time;
      const floorY = 0.72;
      tileWall(ts, 0, 0, 1, 1, ['brick', 'stone2', 'brick', 'brick']);
      ctx.fillStyle = 'rgba(6,3,4,0.55)';
      ctx.fillRect(0.02 * W, (floorY - 0.40) * H, 0.93 * W, 0.40 * H);

      // furnace (right): body + pulsing mouth
      const fx = 0.76 * W, fw = ts * 2.2, fy = floorY * H - ts * 2.2;
      ctx.drawImage(tile('stone2', Math.round(ts * 2.2)), fx, fy);
      ctx.drawImage(tile('brick', Math.round(ts * 2.2)), fx, fy - ts * 2.2);
      const glow = 0.45 + scratch.bass * 0.55 + scratch.lift * 0.5;
      ctx.fillStyle = '#ff7a2d';
      ctx.globalAlpha = Math.min(1, glow);
      ctx.fillRect(fx + fw * 0.22, fy + fw * 0.35, fw * 0.55, fw * 0.42);
      ctx.globalAlpha = Math.min(0.5, glow * 0.5);
      ctx.fillStyle = '#ffd98a';
      ctx.fillRect(fx + fw * 0.32, fy + fw * 0.45, fw * 0.35, fw * 0.25);
      ctx.globalAlpha = 1;

      // anvil (centre): base + horn, with the heated workpiece on top
      const ax = 0.55 * W, ay = floorY * H;
      ctx.fillStyle = '#3a3f4a';
      ctx.fillRect(ax - ts * 0.5, ay - ts * 0.55, ts, ts * 0.25);
      ctx.fillRect(ax - ts * 0.28, ay - ts * 0.30, ts * 0.56, ts * 0.30);
      ctx.fillRect(ax - ts * 0.75, ay - ts * 0.86, ts * 1.5, ts * 0.32);
      // workpiece: hue from grey → hot orange with heat
      const heat = side.heat;
      ctx.fillStyle = `rgb(${Math.round(140 + heat * 115)},${Math.round(140 - heat * 30)},${Math.round(150 - heat * 110)})`;
      ctx.fillRect(ax - ts * 0.35, ay - ts * 1.02, ts * 0.7, ts * 0.16);

      // clang ring
      if (side.clang > 0.03) {
        ctx.strokeStyle = `rgba(255,217,138,${side.clang * 0.8})`;
        ctx.lineWidth = Math.max(1.5, ts * 0.06);
        ctx.beginPath();
        ctx.arc(ax, ay - ts * 0.95, (1 - side.clang) * m * 0.22 + ts * 0.2, 0, Math.PI * 2);
        ctx.stroke();
      }

      // smith — close enough to the anvil that the hammer lands on it
      drawFig(0.47 * W + camX, floorY * H, m * 0.30, {
        facing: 1, tool: 'hammer', swing: side.swing,
        bob: t * (2 + scratch.energy * 6),
      });

      // warm lighting pocket centred between anvil + furnace
      torchDark(0.62 * W, (floorY - 0.2) * H, m * (0.6 + glow * 0.15 + scratch.lift * 0.25), 0.72);
    }

    function renderBuild(m, ts) {
      const t = scratch.time;
      // higher tower → deeper sky (climbing out of the atmosphere)
      const alt = Math.min(1, side.tower.length / 60);
      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, alt > 0.6 ? '#05050d' : '#0b1030');
      g.addColorStop(1, '#27406b');
      ctx.globalAlpha = 0.9 - alt * 0.4;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      // stars fade in with altitude
      if (alt > 0.2) {
        ctx.fillStyle = '#e8ecf8';
        for (let s = 0; s < 40; s++) {
          const sx = ((s * 97.3) % 1013) / 1013 * W;
          const sy = ((s * 57.7) % 619) / 619 * H * 0.6;
          ctx.globalAlpha = (alt - 0.2) * (0.3 + 0.5 * Math.sin(t * 1.5 + s));
          ctx.fillRect(sx, sy, 2, 2);
        }
        ctx.globalAlpha = 1;
      }
      // clouds drift below the builder as the tower rises — small, soft puffs
      ctx.fillStyle = 'rgba(210,220,240,0.06)';
      for (let c = 0; c < 4; c++) {
        const cy = H * (0.58 + c * 0.11) + Math.sin(t * 0.1 + c) * 6;
        const cxp = ((t * (6 + c * 3) + c * 300) % (W + 300)) - 150;
        ctx.fillRect(cxp, cy, m * 0.15, m * 0.028);
        ctx.fillRect(cxp + m * 0.03, cy - m * 0.02, m * 0.09, m * 0.02);
      }

      // tower: top ~7 blocks visible, character rides the top. towerAnim
      // eases the newest block (and the figure) down into place.
      const bs = Math.round(m * 0.085 * scratch.zoom);
      const topY = 0.58 * H + side.towerAnim * bs;
      const cxp = 0.5 * W + camX;
      const count = Math.min(7, side.tower.length);
      for (let b = 0; b < count; b++) {
        const mat = side.tower[side.tower.length - 1 - b];
        ctx.globalAlpha = 1 - Math.pow(b / 7.5, 2);
        ctx.drawImage(tile(mat, bs), cxp - bs / 2, topY + b * bs);
      }
      ctx.globalAlpha = 1;

      drawFig(cxp, topY, m * 0.26, {
        facing: 1, tool: 'block',
        blockMat: TOWER_MATS[side.tower.length % TOWER_MATS.length],
        swing: side.swing,
        bob: t * (2 + scratch.energy * 6),
      });

      // firework rocket streak
      if (side.fw.t < 0.55) {
        const fy = H * (0.9 - side.fw.t / 0.55 * (0.9 - side.fw.y));
        ctx.strokeStyle = 'rgba(255,240,200,0.8)';
        ctx.lineWidth = Math.max(1.5, m * 0.004);
        ctx.beginPath();
        ctx.moveTo(side.fw.x * W, fy + m * 0.05);
        ctx.lineTo(side.fw.x * W, fy);
        ctx.stroke();
      }
      // altitude readout — blocky HUD nod
      ctx.font = `700 ${Math.round(m * 0.03)}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(233,230,255,0.5)';
      ctx.fillText(`y=${64 + side.tower.length}`, m * 0.04, m * 0.07);
      ctx.textAlign = 'center';
    }

    function renderFish(m, ts) {
      const t = scratch.time;
      const waterY = 0.62, dockX = 0.42;
      // moon + stars
      ctx.fillStyle = '#dfe4f2';
      ctx.fillRect(0.78 * W, 0.12 * H, m * 0.055, m * 0.055);
      ctx.fillStyle = '#e8ecf8';
      for (let s = 0; s < 50; s++) {
        const sx = ((s * 97.3) % 1013) / 1013 * W;
        const sy = ((s * 57.7) % 619) / 619 * H * 0.45;
        ctx.globalAlpha = 0.10 + 0.25 * Math.sin(t * 1.2 + s) + scratch.highs * 0.2;
        ctx.fillRect(sx, sy, 2, 2);
      }
      ctx.globalAlpha = 1;

      // water body with a waveform-driven surface line
      const wp = side.waveP;
      const amp = m * (0.008 + scratch.bass * 0.03);
      ctx.fillStyle = 'rgba(29,95,160,0.5)';
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, waterY * H);
      for (let i = 0; i < wp.length; i++) {
        ctx.lineTo((i / (wp.length - 1)) * W, waterY * H + wp[i] * amp);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(159,216,255,0.55)';
      ctx.lineWidth = Math.max(1.5, m * 0.004);
      ctx.beginPath();
      for (let i = 0; i < wp.length; i++) {
        const px = (i / (wp.length - 1)) * W;
        const py = waterY * H + wp[i] * amp;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // dock: planks + posts
      for (let i = 0; i < Math.ceil(dockX * W / ts); i++) {
        ctx.drawImage(tile('plank', ts), i * ts, waterY * H - ts * 0.5);
      }
      ctx.fillStyle = '#523d23';
      ctx.fillRect(dockX * W - ts * 0.5, waterY * H, ts * 0.4, 0.3 * H);
      ctx.fillRect(ts, waterY * H, ts * 0.4, 0.3 * H);

      // fisher: seated at dock edge, static rod arm; cast lifts the rod
      const figX = (dockX - 0.06) * W + camX;
      const figY = waterY * H - ts * 0.5;
      drawFig(figX, figY, m * 0.26, {
        facing: 1, tool: 'rod',
        armAngle: -1.9 + side.castT * 0.9 - scratch.lift * 0.35,
        bob: t * 1.4, sit: true,
      });

      // fishing line: rod tip → bobber (sagging quadratic)
      const s26 = m * 0.26;
      const rodA = -1.9 + side.castT * 0.9 - scratch.lift * 0.35;
      // Seated shoulder height: folded legs (0.38·0.45) + torso (0.36) − the
      // shoulder inset (0.036) — must mirror drawFig's `sit` geometry.
      const shX = figX;
      const shY = figY + Math.sin(t * 1.4) * s26 * 0.02 - s26 * 0.495;
      const rodLen = s26 * 0.34 + s26 * 0.75;
      const tipX = shX + Math.sin(rodA) * rodLen * -1;
      const tipY = shY + Math.cos(rodA) * rodLen;
      const reel = scratch.lift * 0.18;
      const bobX = (0.68 - reel) * W;
      const surf = waterY * H + Math.sin(t * 2 + 3) * amp * 0.8;
      const bobLift = side.fishT < 0.35 ? Math.sin(side.fishT / 0.35 * Math.PI) * m * 0.02 : 0;
      ctx.strokeStyle = 'rgba(233,230,255,0.5)';
      ctx.lineWidth = Math.max(1, m * 0.0022);
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.quadraticCurveTo((tipX + bobX) / 2, Math.max(tipY, surf) + m * 0.06, bobX, surf - bobLift);
      ctx.stroke();
      ctx.fillStyle = '#f0668c';
      ctx.fillRect(bobX - m * 0.008, surf - bobLift - m * 0.012, m * 0.016, m * 0.024);

      // fish arc on snare hits
      if (side.fishT < 1.0) {
        const ft = side.fishT;
        const fx = side.fishX * W + ft * m * 0.12;
        const fy = waterY * H - Math.sin(ft * Math.PI) * m * 0.13;
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(-Math.PI / 3 + ft * Math.PI * 0.66);
        ctx.fillStyle = '#8fb8d8';
        ctx.fillRect(-m * 0.022, -m * 0.009, m * 0.044, m * 0.018);
        ctx.fillRect(m * 0.018, -m * 0.014, m * 0.014, m * 0.028);
        ctx.restore();
      }
    }

    function renderSide(def) {
      const m = Math.min(W, H);
      const ts = Math.max(10, Math.round(m * 0.075 * scratch.zoom));
      if (ts !== tsCached) { tsCached = ts; sprites.clear(); }
      renderSideCommon(def);

      if (scratch.scene === 'mine')       renderMine(m, ts);
      else if (scratch.scene === 'forge') renderForge(m, ts);
      else if (scratch.scene === 'build') renderBuild(m, ts);
      else                                renderFish(m, ts);

      // particles (normalized coords)
      ctx.fillStyle = def.particle;
      for (let n = 0; n < MAX_PARTICLES; n++) {
        const o = n * 6;
        const life = parts[o + 4];
        if (life <= 0) continue;
        ctx.globalAlpha = Math.min(0.85, life);
        const sz = parts[o + 5] * (m / 500);
        ctx.fillRect(parts[o] * W, parts[o + 1] * H, sz, sz);
      }
      ctx.globalAlpha = 1;
    }

    // ── Iso renderer (world dioramas) ──────────────────────────────────────
    function renderIso(def) {
      const t = scratch.time;

      let light = 0.55 + scratch.rms * 0.45;
      if (scratch.scene === 'plains') light *= 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 0.05));
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, def.sky[0]);
      g.addColorStop(1, def.sky[1]);
      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = Math.min(1, light);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;

      if (scratch.scene === 'end') {
        ctx.fillStyle = '#e8ecf8';
        for (let s = 0; s < 60; s++) {
          const sx = ((s * 97.3) % 1013) / 1013 * W;
          const sy = ((s * 57.7) % 619) / 619 * H * 0.5;
          const tw = 0.5 + 0.5 * Math.sin(t * 1.5 + s);
          ctx.globalAlpha = 0.06 + tw * (0.10 + scratch.highs * 0.25);
          ctx.fillRect(sx, sy, 2, 2);
        }
        ctx.globalAlpha = 1;
      }
      if (scratch.scene === 'plains') {
        const a = t * 0.05;
        const sx = W * (0.5 + 0.42 * Math.cos(a)), sy = H * (0.42 - 0.32 * Math.sin(a));
        const day = Math.sin(a) > 0;
        ctx.fillStyle = day ? '#f5d67a' : '#cfd6ea';
        ctx.globalAlpha = 0.9;
        const r = Math.min(W, H) * 0.03;
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
        ctx.globalAlpha = 1;
      }

      const m = Math.min(W, H);
      const ts = Math.max(8, Math.round((m / GRID) * 0.70 * scratch.zoom));
      if (ts !== tsCached) { tsCached = ts; sprites.clear(); }
      const bh = Math.round(ts * 0.9);
      const cx = W / 2 + camX;
      // Centre the terrain diamond vertically: its surface spans (GRID-1)·ts
      // of screen height; bias down a touch so tall stacks have headroom.
      const cy = (H - (GRID - 1) * ts) / 2 + m * 0.04;

      for (let e = 0; e < drawLen; e++) {
        const i = drawList[e * 4], j = drawList[e * 4 + 1];
        const k = drawList[e * 4 + 2], mi = drawList[e * 4 + 3];
        const off = colOff[j * GRID + i];
        const sx = cx + (i - j) * ts - ts;
        const sy = cy + (i + j) * ts / 2 - (k + off) * bh - ts;
        ctx.drawImage(sprite(matNames[mi], ts), sx, sy);
      }

      if (def.liquid && liquidLvl > 0.05) {
        // One batched path for every surface diamond — per-column fills were
        // the ocean scene's frame killer (≈570 fill calls → 1).
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = def.liquid;
        ctx.beginPath();
        for (let j = 0; j < GRID; j++) {
          for (let i = 0; i < GRID; i++) {
            const n = j * GRID + i;
            if (hgt[n] >= liquidLvl || hgt[n] <= 0) continue;
            const wave = Math.sin(t * 2.2 + (i + j) * 0.55) * (0.06 + scratch.bass * 0.12);
            const lv = liquidLvl + wave;
            const sx = cx + (i - j) * ts;
            const sy = cy + (i + j) * ts / 2 - lv * bh;
            ctx.moveTo(sx, sy - ts / 2);
            ctx.lineTo(sx + ts, sy);
            ctx.lineTo(sx, sy + ts / 2);
            ctx.lineTo(sx - ts, sy);
            ctx.closePath();
          }
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      const beam = Math.min(1, scratch.lift * 1.2 + scratch.midsPulse * 0.4);
      if (beacons.length && beam > 0.03) {
        for (const b of beacons) {
          const off = colOff[b.j * GRID + b.i];
          const sx = cx + (b.i - b.j) * ts;
          const sy = cy + (b.i + b.j) * ts / 2 - (b.h + off) * bh;
          const grad = ctx.createLinearGradient(0, sy, 0, sy - H * 0.5);
          grad.addColorStop(0, def.particle);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalAlpha = 0.35 * beam;
          ctx.fillStyle = grad;
          ctx.fillRect(sx - ts * 0.22, sy - H * 0.5, ts * 0.44, H * 0.5);
        }
        ctx.globalAlpha = 1;
      }

      const mobTs = Math.round(ts * 0.62);
      for (const mb of mobs) {
        const gi = Math.min(GRID - 1, Math.max(0, Math.round(mb.x)));
        const gj = Math.min(GRID - 1, Math.max(0, Math.round(mb.y)));
        const n = gj * GRID + gi;
        let k = Math.max(1, hgt[n]);
        if (def.mobMode === 'float') k += 2.4 + Math.sin(mb.bob) * 0.8;
        else if (def.mobMode === 'swim') k = Math.max(0.6, liquidLvl - 0.7 + Math.sin(mb.bob) * 0.3);
        const hop = Math.sin(Math.min(1, mb.hop) * Math.PI) * 0.7;
        const off = colOff[n];
        const sx = cx + (mb.x - mb.y) * ts - mobTs;
        const sy = cy + (mb.x + mb.y) * ts / 2 - (k + off + hop) * bh - mobTs;
        const sp = sprite(def.mob, mobTs);
        if (def.mob === 'ender') ctx.drawImage(sp, sx, sy - mobTs * 1.4);
        ctx.drawImage(sp, sx, sy);
        ctx.fillStyle = def.mob === 'ender' ? '#c084fc' : '#0b0910';
        if (mb.blink <= 0) {
          const ey = sy + mobTs * 0.95;
          ctx.fillRect(sx + mobTs * 0.25, ey, Math.max(1.5, mobTs * 0.12), Math.max(1.5, mobTs * 0.12));
          ctx.fillRect(sx + mobTs * 0.60, ey + mobTs * 0.12, Math.max(1.5, mobTs * 0.12), Math.max(1.5, mobTs * 0.12));
        }
      }

      ctx.fillStyle = def.particle;
      for (let n = 0; n < MAX_PARTICLES; n++) {
        const o = n * 6;
        const life = parts[o + 4];
        if (life <= 0) continue;
        const gx = parts[o], gy = parts[o + 1];
        const gn = Math.min(GRID - 1, Math.max(0, Math.round(gy))) * GRID
                 + Math.min(GRID - 1, Math.max(0, Math.round(gx)));
        const baseK = Math.max(1, hgt[gn]);
        const sx = cx + (gx - gy) * ts;
        const sy = cy + (gx + gy) * ts / 2 - baseK * bh - (1 - life) * bh * 2;
        ctx.globalAlpha = Math.min(0.8, life);
        const sz = parts[o + 5] * (ts / 22);
        ctx.fillRect(sx, sy, sz, sz);
      }
      ctx.globalAlpha = 1;

      if (boltLife > 0.02) {
        ctx.strokeStyle = '#f3f6ff';
        ctx.lineWidth = Math.max(2, ts * 0.12);
        ctx.globalAlpha = boltLife;
        ctx.beginPath();
        ctx.moveTo(bolt[0], bolt[1]);
        for (let s = 1; s < 8; s++) ctx.lineTo(bolt[s * 2], bolt[s * 2 + 1]);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (eventFlash > 0.02) {
        ctx.globalAlpha = eventFlash * 0.16;
        ctx.fillStyle = scratch.scene === 'nether' ? '#ff6a3d'
                      : scratch.scene === 'end'    ? '#c9a3ff'
                      : '#eef3ff';
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
    }

    function render() {
      const def = SCENE_DEFS[scratch.scene];
      if (def.view === 'side') renderSide(def);
      else renderIso(def);
    }

    buildScene('plains');

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { sprites.clear(); },
    };
  },
};
