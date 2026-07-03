// Blockworld — a voxel diorama quale. An isometric cube world (very
// Minecraft-coded, deliberately) whose scenes phase through five biomes:
// plains, cavern, nether, ocean, end. The world itself is the visualizer —
// audio drives the game conditions, pose drives the camera and the weather
// of motion.
//
// Audio → world:
//   • beat.pulse   — a bounce ring that travels outward through the terrain
//                    from the centre (blocks jump in a radial wave)
//   • bass         — liquid level (water / lava) swells; terrain breathes
//   • mids.pulse   — mobs hop; torches flare
//   • highs.pulse  — scene particles (sparks, bubbles, embers, void motes)
//   • rms          — sky light
//   • hard kicks   — scene events (lightning / cave flash / geyser / beams)
//
// Pose → world, via RELATIVE motion only. Performers may be mirrored,
// scaled, or oddly framed on stage, so nothing here reads absolute screen
// position. All features are normalized by torso size (scale-invariant) and
// most use velocity magnitudes (mirror-invariant):
//   • limb speed (wrist velocity, torso-relative) → world energy: mob pace,
//     particle weather, terrain shimmer
//   • torso sway — magnitude drives camera pan amount; only the smoothed
//     *direction* uses sign, so a mirrored camera merely reverses pan
//     direction, it never fights the performer
//   • hands-above-shoulders (torso-relative height, sign-stable) → raises
//     the liquid level and ignites beacon beams
//   • a fast upward centre-of-mass move (a jump) → slams a bounce ring,
//     same as a kick

import { scaleAudio, decay } from '../field.js';

const GRID = 24;
const SCENES = ['plains', 'cavern', 'nether', 'ocean', 'end'];
const MAX_PARTICLES = 160;

// ── Materials — top / left / right face colors (pre-shaded, no per-frame
// color math). Kept dusky so the diorama sits on the #05050d page void.
const MATS = {
  grass:    { top: '#4f8a4a', left: '#3b4a33', right: '#2c3826' },
  dirt:     { top: '#6b4d33', left: '#523a26', right: '#3d2b1c' },
  stone:    { top: '#7a7f8c', left: '#565b68', right: '#40444f' },
  ore:      { top: '#8b93a6', left: '#5d647a', right: '#464c5e' },
  wood:     { top: '#5d4326', left: '#4a351e', right: '#382817' },
  leaf:     { top: '#2f6b3a', left: '#25522d', right: '#1b3d21' },
  sand:     { top: '#c2b280', left: '#96895f', right: '#6f6546' },
  nether:   { top: '#6e2b2b', left: '#521e1e', right: '#3c1515' },
  glow:     { top: '#e8c46a', left: '#b8964a', right: '#8f7136' },
  obsidian: { top: '#2b2438', left: '#1e1929', right: '#15111d' },
  endstone: { top: '#d9d8a8', left: '#a3a27b', right: '#787757' },
  wool:     { top: '#e8e6df', left: '#bcbab2', right: '#8f8d86' },
  creeper:  { top: '#4fae4f', left: '#3b823b', right: '#2b5f2b' },
  ghast:    { top: '#e5e2ee', left: '#b4b1c4', right: '#8a8798' },
  squid:    { top: '#3a4a6b', left: '#2b3750', right: '#1f283a' },
  ender:    { top: '#17131f', left: '#100d16', right: '#0b0910' },
};

// Per-scene look: sky gradient stops [top, horizon], liquid, particles.
const SCENE_DEFS = {
  plains: { sky: ['#0b1030', '#233a63'], liquid: null,               particle: '#eef3ff', mob: 'wool',    mobMode: 'walk'  },
  cavern: { sky: ['#050509', '#0b0a14'], liquid: null,               particle: '#ffd98a', mob: 'creeper', mobMode: 'walk'  },
  nether: { sky: ['#160607', '#3a0d0a'], liquid: '#e2542b',          particle: '#ff9a3d', mob: 'ghast',   mobMode: 'float' },
  ocean:  { sky: ['#04101f', '#0a2f45'], liquid: '#1d5fa0',           particle: '#9fd8ff', mob: 'squid',   mobMode: 'swim'  },
  end:    { sky: ['#05050d', '#0d0a1a'], liquid: null,               particle: '#c9a3ff', mob: 'ender',   mobMode: 'walk'  },
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
      options: ['plains', 'cavern', 'nether', 'ocean', 'end'], default: 'plains' },
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
      { scene: 'cavern' },
      { scene: 'nether' },
      { scene: 'ocean' },
      { scene: 'end' },
    ],
  },

  presets: {
    default:     { scene: 'plains', zoom: 1.0, mobs: 4, drift: 0.8, poseDrive: 1.0, reactivity: 1.0 },
    cave_rave:   { scene: 'cavern', mobs: 6, zoom: 1.15, reactivity: 1.4 },
    lava_set:    { scene: 'nether', mobs: 5, zoom: 0.95 },
    deep:        { scene: 'ocean', mobs: 6, drift: 0.5 },
    the_end:     { scene: 'end', mobs: 3, zoom: 0.9 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // ── Sprite cache — one pre-rendered iso cube per (material, tile size).
    let tsCached = 0;
    const sprites = new Map();
    function sprite(mat, ts) {
      const key = `${mat}|${ts}`;
      let c = sprites.get(key);
      if (c) return c;
      const bh = Math.round(ts * 0.9);
      c = document.createElement('canvas');
      c.width = ts * 2; c.height = ts + bh;
      const x = c.getContext('2d');
      const m = MATS[mat] || MATS.stone;
      // top diamond
      x.fillStyle = m.top;
      x.beginPath();
      x.moveTo(ts, 0); x.lineTo(ts * 2, ts / 2); x.lineTo(ts, ts); x.lineTo(0, ts / 2);
      x.closePath(); x.fill();
      // left face
      x.fillStyle = m.left;
      x.beginPath();
      x.moveTo(0, ts / 2); x.lineTo(ts, ts); x.lineTo(ts, ts + bh); x.lineTo(0, ts / 2 + bh);
      x.closePath(); x.fill();
      // right face
      x.fillStyle = m.right;
      x.beginPath();
      x.moveTo(ts, ts); x.lineTo(ts * 2, ts / 2); x.lineTo(ts * 2, ts / 2 + bh); x.lineTo(ts, ts + bh);
      x.closePath(); x.fill();
      // hairline edge glow — reads "voxel" from the back of the room
      x.strokeStyle = 'rgba(255,255,255,0.10)';
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(0, ts / 2); x.lineTo(ts, 0); x.lineTo(ts * 2, ts / 2); x.lineTo(ts, ts); x.closePath();
      x.stroke();
      sprites.set(key, c);
      return c;
    }

    // ── Scene state (rebuilt on scene switch — not the hot path) ──────────
    const hgt   = new Float32Array(GRID * GRID);   // terrain height (blocks)
    const distC = new Float32Array(GRID * GRID);   // distance from grid centre
    const colOff = new Float32Array(GRID * GRID);  // per-column y bounce (px-ish, in blocks)
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const dx = i - (GRID - 1) / 2, dy = j - (GRID - 1) / 2;
        distC[j * GRID + i] = Math.sqrt(dx * dx + dy * dy);
      }
    }
    /** draw list entry stride 4: i, j, k, matIndex */
    let drawList = new Int16Array(0);
    let drawLen = 0;
    const matNames = Object.keys(MATS);
    const matIdx = (m) => matNames.indexOf(m);
    let beacons = [];        // [{i,j,h}] — torch/crystal columns that can beam
    let liquidBase = 0;      // resting liquid level (blocks); 0 = none
    let activeScene = null;

    function buildScene(scene) {
      activeScene = scene;
      const rand = mulberry32(1337 + SCENES.indexOf(scene) * 7919);
      beacons = [];
      liquidBase = 0;
      const list = [];
      const push = (i, j, k, m) => list.push(i, j, k, matIdx(m));

      // Terrain heights + materials per biome.
      let top = 'grass', under = 'dirt';
      if (scene === 'plains') {
        const f = heightField(rand, 6, 1, 3.6);
        for (let n = 0; n < GRID * GRID; n++) hgt[n] = Math.round(f[n]);
      } else if (scene === 'cavern') {
        top = 'stone'; under = 'stone';
        const f = heightField(rand, 7, 1, 4.2);
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
      } else { // end — a floating island: columns fade to void at the rim
        top = 'endstone'; under = 'endstone';
        const f = heightField(rand, 6, 1.5, 3.5);
        for (let n = 0; n < GRID * GRID; n++) {
          const fall = Math.max(0, 1 - Math.pow(distC[n] / (GRID * 0.48), 3));
          hgt[n] = fall > 0.12 ? Math.max(1, Math.round(f[n] * fall)) : 0;
        }
      }

      // Base terrain blocks — draw exposed range only (top block down to the
      // lowest front-facing neighbour, so side faces never pop a hole).
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const h = hgt[j * GRID + i];
          if (h <= 0) continue;
          const nI = i + 1 < GRID ? hgt[j * GRID + i + 1] : 0;
          const nJ = j + 1 < GRID ? hgt[(j + 1) * GRID + i] : 0;
          const kMin = Math.max(0, Math.min(h - 1, Math.min(nI, nJ)));
          for (let k = kMin; k < h; k++) {
            let m = k === h - 1 ? top : under;
            // ore glints in the cavern; glowstone seams in the nether
            if (scene === 'cavern' && k === h - 1 && rand() < 0.10) m = 'ore';
            if (scene === 'nether' && k === h - 1 && rand() < 0.06) m = 'glow';
            push(i, j, k, m);
          }
        }
      }

      // Features per biome.
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
      } else if (scene === 'cavern') {
        for (let t = 0; t < 6; t++) {
          const i = 2 + Math.floor(rand() * (GRID - 4));
          const j = 2 + Math.floor(rand() * (GRID - 4));
          const h = hgt[j * GRID + i];
          push(i, j, h, 'wood');
          push(i, j, h + 1, 'glow');       // torch head
          beacons.push({ i, j, h: h + 2 });
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
          push(i, j, h + ph, 'glow');      // crystal
          beacons.push({ i, j, h: h + ph + 1 });
        }
      } else if (scene === 'ocean') {
        for (let t = 0; t < 10; t++) {      // kelp
          const i = Math.floor(rand() * GRID), j = Math.floor(rand() * GRID);
          const h = hgt[j * GRID + i];
          for (let k = 0; k < 1 + Math.floor(rand() * 2); k++) push(i, j, h + k, 'leaf');
        }
      }

      // Painter order: back → front by (i + j), then bottom → top.
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

    // ── Mobs ───────────────────────────────────────────────────────────────
    const mobs = [];   // {x, y, dx, dy, retarget, hop, bob, blink}
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

    // ── Particles — flat pool, spawn head cursor, zero per-frame alloc ─────
    const parts = new Float32Array(MAX_PARTICLES * 6);  // x, y, vx, vy, life, size
    let partHead = 0;
    function spawnPart(x, y, vx, vy, life, size) {
      const o = partHead * 6;
      parts[o] = x; parts[o + 1] = y; parts[o + 2] = vx; parts[o + 3] = vy;
      parts[o + 4] = life; parts[o + 5] = size;
      partHead = (partHead + 1) % MAX_PARTICLES;
    }

    // ── Pose relative-motion tracker (mirror / scale invariant) ────────────
    const trk = {
      seen: false,
      pLx: 0, pLy: 0, pRx: 0, pRy: 0, pCx: 0, pCy: 0,   // previous normalized joints
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
          // Torso scale — the normalizer that makes everything below
          // invariant to how large/near the performer appears in frame.
          const s = Math.max(0.05, Math.hypot(hcx - scx, hcy - scy));
          const cx = (scx + hcx) / 2, cy = (scy + hcy) / 2;
          const nLx = (wL.x - cx) / s, nLy = (wL.y - cy) / s;
          const nRx = (wR.x - cx) / s, nRy = (wR.y - cy) / s;
          if (trk.seen && dt > 0.001) {
            // Limb speed — velocity magnitudes, so mirroring can't flip it.
            const vL = Math.hypot(nLx - trk.pLx, nLy - trk.pLy) / dt;
            const vR = Math.hypot(nRx - trk.pRx, nRy - trk.pRy) / dt;
            const wristsOk = wL.visibility > 0.3 && wR.visibility > 0.3;
            const e = wristsOk ? Math.min(1, (vL + vR) * 0.5 / 6) : 0;
            trk.energy += (e * drive - trk.energy) * dk;
            // Sway — |centre velocity| for amount; smoothed sign for
            // direction only (mirror flips direction, never the feel).
            const vcx = (cx - trk.pCx) / dt, vcy = (cy - trk.pCy) / dt;
            trk.swayAmt += (Math.min(1, Math.abs(vcx) / 0.8) * drive - trk.swayAmt) * dk;
            trk.swayDir += ((vcx > 0 ? 1 : vcx < 0 ? -1 : 0) - trk.swayDir) * Math.min(1, dt * 1.2);
            // Jump — a sharp upward centre move (y shrinks upward).
            if (vcy < -0.9) trk.jump = Math.min(1, trk.jump + 0.8 * drive);
          }
          // Hands over shoulders, torso units — sign-stable vertically.
          const raise = Math.max(0, ((cy - Math.min(wL.y, wR.y)) / s) - 0.9);
          trk.lift += (Math.min(1, raise * 0.8) * drive - trk.lift) * dk;
          trk.pLx = nLx; trk.pLy = nLy; trk.pRx = nRx; trk.pRy = nRy;
          trk.pCx = cx; trk.pCy = cy;
          trk.seen = true;
          ok = true;
        }
      }
      if (!ok) {
        // Dropout: never snap — everything decays home.
        trk.seen = false;
        trk.energy  += (0 - trk.energy)  * dk * 0.5;
        trk.swayAmt += (0 - trk.swayAmt) * dk * 0.5;
        trk.lift    += (0 - trk.lift)    * dk * 0.5;
      }
      trk.jump = decay(trk.jump, dt, 0.30);
    }

    // ── Frame state ────────────────────────────────────────────────────────
    let beatRingT = 9;       // seconds since last bounce impulse
    let eventFlash = 0;      // scene event flash envelope
    let liquidLvl = 0;       // smoothed liquid level
    let camX = 0;            // smoothed camera pan (px)
    const bolt = new Float32Array(16);   // lightning polyline (x,y × 8)
    let boltLife = 0;

    const scratch = {
      time: 0, dt: 0, bass: 0, mids: 0, highs: 0, rms: 0,
      beatPulse: 0, midsPulse: 0, highsPulse: 0,
      scene: 'plains', zoom: 1, drift: 0.8, audioOn: false,
    };

    function update(field) {
      const params = field.params;
      const audio = scaleAudio(field.audio, params.reactivity);
      const dt = field.dt;

      const scene = SCENES.includes(params.scene) ? params.scene : 'plains';
      if (scene !== activeScene) buildScene(scene);
      ensureMobs(Math.round(params.mobs));

      trackPose(field.pose, dt, params.poseDrive);

      // Bounce impulses: kick, or a performer jump.
      if (audio.beat.active || trk.jump > 0.55) { beatRingT = 0; trk.jump *= 0.4; }
      beatRingT += dt;

      // Per-column bounce offsets — a ring travelling out from the centre.
      const ringR = beatRingT * 13;
      const ringA = Math.exp(-beatRingT * 2.4) * (0.55 + audio.bands.bass * 0.5);
      const shimmer = trk.energy * 0.12;
      for (let n = 0; n < GRID * GRID; n++) {
        const d = distC[n] - ringR;
        let off = ringA * Math.exp(-d * d * 0.55);
        if (shimmer > 0.004) off += shimmer * Math.sin(field.time * 7 + n * 1.7);
        colOff[n] = off;
      }

      // Liquid level: rest + bass swell + raised hands.
      const lTarget = liquidBase > 0 ? liquidBase + audio.bands.bass * 1.1 + trk.lift * 1.4 : 0;
      liquidLvl += (lTarget - liquidLvl) * Math.min(1, dt * 3);

      // Camera pan from sway; drift bobs it when nobody's moving.
      const panT = trk.swayDir * trk.swayAmt * Math.min(W, H) * 0.06
                 + Math.sin(field.time * 0.13) * params.drift * Math.min(W, H) * 0.02;
      camX += (panT - camX) * Math.min(1, dt * 2);

      // Scene events on hard kicks (strict gate so it's a flare, not a strobe).
      if (audio.beat.active && audio.bands.bass > 0.72 && eventFlash < 0.2) {
        eventFlash = 1;
        if (scene === 'plains') {
          // lightning bolt: jittered polyline from sky to a random column
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

      // Mobs wander; hop on snares; pace scales with performer energy.
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
        // Walkers won't step into the void (the end island's rim) — bounce.
        const stepH = hgt[Math.round(ny) * GRID + Math.round(nx)];
        if (SCENE_DEFS[scene].mobMode === 'walk' && stepH <= 0) {
          mb.dx = -mb.dx; mb.dy = -mb.dy; mb.retarget = Math.min(mb.retarget, 0.5);
        } else { mb.x = nx; mb.y = ny; }
        if (audio.mids.active) mb.hop = 1;
        mb.hop = decay(mb.hop, dt, 0.16);
        mb.bob += dt * (1.2 + audio.bands.mids);
        if (Math.random() < dt * 0.3) mb.blink = 0.15;
        mb.blink = Math.max(0, mb.blink - dt);
      }

      // Particle weather — highs sparkle + performer energy, biome-flavored.
      const spawnRate = (audio.highs.pulse * 26 + trk.energy * 20 + 1.5) * dt;
      const whole = Math.floor(spawnRate) + (Math.random() < spawnRate % 1 ? 1 : 0);
      for (let s = 0; s < whole; s++) {
        const gx = Math.random() * GRID, gy = Math.random() * GRID;
        const up = scene === 'ocean' || scene === 'nether' ? -1 : (Math.random() < 0.5 ? -1 : -0.3);
        spawnPart(gx, gy, (Math.random() - 0.5) * 0.4, up * (0.6 + Math.random()),
                  0.8 + Math.random() * 1.4, 1 + Math.random() * 2);
      }
      for (let n = 0; n < MAX_PARTICLES; n++) {
        const o = n * 6;
        if (parts[o + 4] <= 0) continue;
        parts[o]     += parts[o + 2] * dt;
        parts[o + 1] += parts[o + 3] * dt;
        parts[o + 4] -= dt;
      }

      scratch.time = field.time; scratch.dt = dt;
      scratch.bass = audio.bands.bass; scratch.mids = audio.bands.mids;
      scratch.highs = audio.bands.highs; scratch.rms = audio.rms;
      scratch.beatPulse = audio.beat.pulse; scratch.midsPulse = audio.mids.pulse;
      scratch.highsPulse = audio.highs.pulse;
      scratch.scene = scene; scratch.zoom = params.zoom; scratch.drift = params.drift;
      scratch.audioOn = !!field.audio.spectrum;
    }

    function render() {
      const def = SCENE_DEFS[scratch.scene];
      const t = scratch.time;

      // Sky — biome gradient, lit by rms (and a slow day cycle on the plains).
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

      // Stars for the void-y biomes.
      if (scratch.scene === 'end' || scratch.scene === 'cavern') {
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
      // Sun / moon block on the plains.
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

      // ── Terrain ──────────────────────────────────────────────────────────
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

      // ── Liquid surface (water / lava) ────────────────────────────────────
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

      // ── Beacon beams — torches / crystals, lit by raised hands + snares ──
      const beam = Math.min(1, trk.lift * 1.2 + scratch.midsPulse * 0.4);
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

      // ── Mobs ─────────────────────────────────────────────────────────────
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
        // eyes on the left face
        ctx.fillStyle = def.mob === 'ender' ? '#c084fc' : '#0b0910';
        if (mb.blink <= 0) {
          const ey = sy + mobTs * 0.95;
          ctx.fillRect(sx + mobTs * 0.25, ey, Math.max(1.5, mobTs * 0.12), Math.max(1.5, mobTs * 0.12));
          ctx.fillRect(sx + mobTs * 0.60, ey + mobTs * 0.12, Math.max(1.5, mobTs * 0.12), Math.max(1.5, mobTs * 0.12));
        }
      }

      // ── Particles ────────────────────────────────────────────────────────
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

      // ── Scene events: flash + lightning bolt ─────────────────────────────
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

    buildScene('plains');

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { sprites.clear(); },
    };
  },
};
