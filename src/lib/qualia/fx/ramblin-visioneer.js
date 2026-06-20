// Ramblin' Visioneer - animated avatar model from the Randyland2 sprite sheet.
// The quale presents the character as a living stage model: clip-cycled pixel
// animation, blue-eye glow, halo sparks, flowers, and friendly cosmic energy.
//
// Audio map:
//   bass        -> clip speed, stride push
//   mids/total  -> aura and halo exposure
//   highs       -> spark density
//   beat.pulse  -> eye flare, attack bolt, landing pulse
//
// Pose map:
//   head        -> soft stage target
//   wristSpread -> scale modulator
//   shoulderRoll -> sway modulator

import { scaleAudio } from '../field.js';
import { lmToCanvas } from '../video.js';

const SHEET_URL = '/images/ramblin-visioneer-v1.png';
const TAU = Math.PI * 2;
const SPARKS = 96;
const FLOWERS = 18;
const CELL_X = 708;
const CELL_Y = 49;
const CELL_W = 89;
const CELL_H = 113;
const CELL_DX = 89;
const CELL_DY = 128;
const CELL_PAD = 5;
const ROW_GEOMETRY = [
  { x: CELL_X, dx: CELL_DX, w: CELL_W },
  { x: CELL_X, dx: CELL_DX, w: CELL_W },
  { x: CELL_X, dx: CELL_DX, w: CELL_W },
  { x: CELL_X, dx: 103, w: 103 },
  { x: CELL_X, dx: 103, w: 103 },
  { x: CELL_X, dx: 102, w: 102 },
  { x: CELL_X, dx: 103, w: 103 },
];
const FACING_COOLDOWN = 0.25;
const FACING_DEADZONE = 0.022;
const BEAT_ACTION_CLIPS = ['jump', 'attack', 'hit'];
const BEAT_ACTION_HOLD = 0.6;

function rowCells(row, count) {
  const geom = ROW_GEOMETRY[row] || ROW_GEOMETRY[0];
  const y = CELL_Y + row * CELL_DY;
  const rects = [];
  for (let i = 0; i < count; i++) {
    rects.push([
      geom.x + i * geom.dx + CELL_PAD,
      y + CELL_PAD,
      geom.w - CELL_PAD * 2,
      CELL_H - CELL_PAD * 2,
    ]);
  }
  return rects;
}

const FRAME_SETS = {
  idle: {
    fps: 7,
    anchorY: 0.92,
    rects: rowCells(0, 8),
  },
  walk: {
    fps: 10,
    anchorY: 0.90,
    rects: rowCells(1, 8),
  },
  run: {
    fps: 12,
    anchorY: 0.88,
    rects: rowCells(2, 8),
  },
  jump: {
    fps: 9,
    anchorY: 0.86,
    rects: rowCells(3, 6),
  },
  attack: {
    fps: 11,
    anchorY: 0.90,
    rects: rowCells(4, 6),
  },
  hit: {
    fps: 8,
    anchorY: 0.91,
    rects: rowCells(5, 6),
  },
  death: {
    fps: 6,
    anchorY: 0.94,
    rects: rowCells(6, 6),
  },
};

const CLIPS = ['auto', 'idle', 'walk', 'run', 'jump', 'attack', 'hit', 'death'];

const LOOKS = {
  stained: {
    bg0: '#04050a',
    bg1: '#08111a',
    grid: [87, 204, 255],
    warm: [244, 176, 85],
    flower: [255, 82, 145],
    aura: [44, 181, 255],
  },
  garden: {
    bg0: '#05080a',
    bg1: '#06140f',
    grid: [109, 226, 150],
    warm: [255, 202, 97],
    flower: [255, 103, 162],
    aura: [84, 219, 180],
  },
  cosmic: {
    bg0: '#030611',
    bg1: '#090820',
    grid: [147, 144, 255],
    warm: [255, 195, 90],
    flower: [255, 82, 215],
    aura: [47, 196, 255],
  },
  parchment: {
    bg0: '#090704',
    bg1: '#17110a',
    grid: [230, 173, 91],
    warm: [255, 217, 142],
    flower: [242, 85, 86],
    aura: [99, 200, 255],
  },
};
const LOOK_IDS = Object.keys(LOOKS);

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function rgba(rgb, a) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

function smoothToward(current, target, dt, halfLife) {
  const k = 1 - Math.pow(0.5, dt / Math.max(halfLife, 0.001));
  return current + (target - current) * k;
}

function moveToward(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

function loadImage(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  return new Promise(resolve => {
    if (img.complete && img.naturalWidth > 0) {
      resolve(img);
      return;
    }
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
  });
}

function detectEyePoints(imageData, w, h) {
  const data = imageData.data;
  const mask = new Uint8Array(w * h);
  for (let y = Math.floor(h * 0.05); y < h * 0.58; y++) {
    for (let x = Math.floor(w * 0.08); x < w * 0.92; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a > 0 && b > 92 && g > 42 && r < 150 && b > r + 18 && g > r - 8) {
        mask[y * w + x] = 1;
      }
    }
  }

  const components = [];
  const queue = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start]) continue;
      mask[start] = 0;
      queue.length = 0;
      queue.push([x, y]);
      let area = 0;
      let weight = 0;
      let sx = 0;
      let sy = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      for (let qi = 0; qi < queue.length; qi++) {
        const [px, py] = queue[qi];
        const pi = (py * w + px) * 4;
        const pw = (data[pi + 2] + data[pi + 1] - data[pi]) / 255;
        area++;
        weight += pw;
        sx += px * pw;
        sy += py * pw;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = px + ox;
            const ny = py + oy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!mask[ni]) continue;
            mask[ni] = 0;
            queue.push([nx, ny]);
          }
        }
      }
      const cw = maxX - minX + 1;
      const ch = maxY - minY + 1;
      if (area <= 18 && cw <= 8 && ch <= 8 && weight > 0) {
        components.push({
          x: sx / weight,
          y: sy / weight,
          area,
          weight,
          score: weight + (h * 0.58 - sy / weight) * 0.16 - Math.max(0, area - 8) * 0.9,
        });
      }
    }
  }
  if (!components.length) return null;

  let bestPair = null;
  let bestPairScore = -Infinity;
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i];
      const b = components[j];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx < 3 || dx > 16 || dy > 6) continue;
      const score = a.score + b.score - dy * 1.6 - Math.abs(dx - 8) * 0.35;
      if (score > bestPairScore) {
        bestPairScore = score;
        bestPair = a.x < b.x ? [a, b] : [b, a];
      }
    }
  }
  if (bestPair) return bestPair.map(({ x, y }) => ({ x, y }));

  components.sort((a, b) => b.score - a.score);
  const eye = components[0];
  return [{ x: eye.x, y: eye.y }];
}

function fillMissingEyePoints(frames) {
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].eyePoints?.length) continue;
    const prev = findEyeFrame(frames, i, -1);
    const next = findEyeFrame(frames, i, 1);
    frames[i].eyePoints = prev?.eyePoints || next?.eyePoints || null;
  }
}

function findEyeFrame(frames, index, step) {
  for (let i = index + step; i >= 0 && i < frames.length; i += step) {
    if (frames[i].eyePoints?.length) return frames[i];
  }
  return null;
}

function buildTransparentFrames(img) {
  const out = {};
  const scratch = document.createElement('canvas');
  scratch.width = CELL_W;
  scratch.height = CELL_H;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  for (const [clip, set] of Object.entries(FRAME_SETS)) {
    out[clip] = [];
    for (const rect of set.rects) {
      const [sx, sy, sw, sh] = rect;
      scratch.width = sw;
      scratch.height = sh;
      sctx.clearRect(0, 0, sw, sh);
      sctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const imageData = sctx.getImageData(0, 0, sw, sh);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const p = i / 4;
        const x = p % sw;
        const y = (p / sw) | 0;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const neutral = max - min < 18;
        const blueBlack = b >= r - 5 && b >= g - 8;
        const outerEdge = x < 2 || y < 2 || x >= sw - 2 || y >= sh - 2;
        const guideGray = neutral && max >= 42 && max <= 108 && Math.abs(r - 76) < 38;
        if (outerEdge || max < 24 || (max < 56 && neutral && blueBlack) || guideGray) {
          data[i + 3] = 0;
        }
      }
      const frame = document.createElement('canvas');
      frame.width = sw;
      frame.height = sh;
      frame.eyePoints = detectEyePoints(imageData, sw, sh);
      frame.getContext('2d').putImageData(imageData, 0, 0);
      out[clip].push(frame);
    }
    fillMissingEyePoints(out[clip]);
  }
  return out;
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'ramblin_visioneer',
  name: "Ramblin' Visioneer",
  contextType: 'canvas2d',

  params: [
    { id: 'clip', label: 'clip', type: 'select', options: CLIPS, default: 'auto' },
    { id: 'look', label: 'look', type: 'select', options: LOOK_IDS, default: 'stained' },
    { id: 'scale', label: 'scale', type: 'range', min: 1.2, max: 5.5, step: 0.05, default: 2.35,
      modulators: [
        { source: 'pose.wristSpread', mode: 'add', amount: 0.55 },
        { source: 'crowd.spread', mode: 'add', amount: 0.40 },
      ] },
    { id: 'speed', label: 'speed', type: 'range', min: 0, max: 2, step: 0.02, default: 0.42,
      modulators: [
        { source: 'audio.bass', mode: 'mul', amount: 0.45 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.10 },
      ] },
    { id: 'sway', label: 'sway', type: 'range', min: -1, max: 1, step: 0.02, default: 0.20,
      modulators: [
        { source: 'pose.shoulderRoll', mode: 'add', amount: 0.45 },
        { source: 'crowd.sway', mode: 'add', amount: 0.35 },
      ] },
    { id: 'aura', label: 'aura', type: 'range', min: 0, max: 1.5, step: 0.02, default: 0.72,
      modulators: [
        { source: 'audio.mids', mode: 'add', amount: 0.30 },
        { source: 'audio.total', mode: 'add', amount: 0.20 },
      ] },
    { id: 'sparkle', label: 'sparkle', type: 'range', min: 0, max: 1.5, step: 0.02, default: 0.95,
      modulators: [{ source: 'audio.highs', mode: 'add', amount: 0.45 }] },
    { id: 'ground', label: 'ground', type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'poseReactivity', label: 'pose react', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { clip: 'idle', look: 'stained' },
      { clip: 'walk', look: 'garden' },
      { clip: 'run', look: 'cosmic' },
      { clip: 'jump', look: 'stained' },
      { clip: 'attack', look: 'cosmic' },
      { clip: 'hit', look: 'parchment' },
      { clip: 'death', look: 'garden' },
    ],
  },

  presets: {
    default: { clip: 'auto', look: 'stained', scale: 2.35, speed: 0.42, sway: 0.20, aura: 0.72, sparkle: 0.95, ground: true, reactivity: 1.0, poseReactivity: 1.0 },
    idle: { clip: 'idle', scale: 2.5, speed: 0.36, sway: 0.10, aura: 0.75, sparkle: 0.85 },
    ramble: { clip: 'walk', look: 'garden', scale: 2.35, speed: 0.50, sway: 0.28, aura: 0.70, sparkle: 0.95 },
    sprint: { clip: 'run', look: 'cosmic', scale: 2.2, speed: 0.72, sway: 0.38, aura: 0.95, sparkle: 1.15 },
    mystic: { clip: 'attack', look: 'cosmic', scale: 2.35, speed: 0.40, sway: 0.04, aura: 1.05, sparkle: 1.25 },
    tender: { clip: 'idle', look: 'parchment', scale: 2.6, speed: 0.28, sway: -0.10, aura: 0.55, sparkle: 0.70 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width;
    let H = canvas.height;
    const img = await loadImage(SHEET_URL);
    const frames = img ? buildTransparentFrames(img) : null;

    const sparkX = new Float32Array(SPARKS);
    const sparkY = new Float32Array(SPARKS);
    const sparkV = new Float32Array(SPARKS);
    const sparkA = new Float32Array(SPARKS);
    const sparkSeed = new Float32Array(SPARKS);
    const flowerX = new Float32Array(FLOWERS);
    const flowerY = new Float32Array(FLOWERS);
    const flowerS = new Float32Array(FLOWERS);

    for (let i = 0; i < SPARKS; i++) {
      sparkX[i] = Math.random();
      sparkY[i] = Math.random();
      sparkV[i] = 0.2 + Math.random() * 1.4;
      sparkA[i] = Math.random();
      sparkSeed[i] = Math.random() * TAU;
    }
    for (let i = 0; i < FLOWERS; i++) {
      flowerX[i] = Math.random();
      flowerY[i] = Math.random();
      flowerS[i] = 0.55 + Math.random() * 1.2;
    }

    const state = {
      t: 0,
      clip: 'idle',
      frame: 0,
      targetX: 0.5,
      targetY: 0.55,
      intentX: 0.5,
      intentY: 0.55,
      charX: 0.5,
      charY: 0.74,
      facing: 1,
      facingSign: 1,
      lastFacingFlip: -10,
      beatFlash: 0,
      lastBeat: 0,
      landing: 0,
      attackPhase: 0,
      beatActionIndex: 0,
      beatActionClip: null,
      beatActionTimer: 0,
      audio: scaleAudio({
        bands: { bass: 0, mids: 0, highs: 0, total: 0 },
        beat: { active: false, pulse: 0 },
        mids: { active: false, pulse: 0 },
        highs: { active: false, pulse: 0 },
        rms: 0,
        spectrum: null,
        waveform: null,
      }, 1),
      params: {},
    };

    function resize(w, h) {
      W = w;
      H = h;
    }

    function autoClip(time, audio) {
      if (state.beatActionClip) return state.beatActionClip;
      const cycle = time % 24;
      if (cycle < 7) return 'idle';
      if (cycle < 13) return 'walk';
      if (cycle < 17) return 'run';
      if (cycle < 20) return 'jump';
      return 'idle';
    }

    function update(field) {
      const params = field.params;
      const audio = scaleAudio(field.audio, params.reactivity);
      const dt = Math.min(field.dt || 0, 0.05);
      const person = field.pose?.people?.[0];

      let tx = 0.5 + Math.sin(field.time * 0.22) * 0.10;
      let ty = 0.55 + Math.cos(field.time * 0.17) * 0.05;
      if (person?.head && person.head.visibility > 0.3) {
        const [hx, hy] = lmToCanvas(person.head.x, person.head.y, W, H);
        tx = clamp(hx / Math.max(1, W), 0.26, 0.74);
        ty = clamp(hy / Math.max(1, H), 0.28, 0.68);
      } else if (field.crowd?.confidence > 0.05) {
        tx = clamp(0.5 + field.crowd.x * 0.18, 0.26, 0.74);
        ty = clamp(0.55 + field.crowd.y * 0.12, 0.28, 0.68);
      }

      state.intentX = smoothToward(state.intentX, tx, dt, 0.55);
      state.intentY = smoothToward(state.intentY, ty, dt, 0.65);
      state.targetX = state.intentX;
      state.targetY = state.intentY;
      const margin = clamp(0.20 + params.scale * 0.045, 0.25, 0.36);
      const maxMove = dt * (0.055 + params.speed * 0.045 + audio.bands.bass * 0.035);
      state.charX = clamp(moveToward(state.charX, state.targetX, maxMove), margin, 1 - margin);
      state.charY = clamp(moveToward(state.charY, state.targetY + 0.19, maxMove * 0.72), 0.52, 0.78);
      const intentDelta = tx - state.charX;
      const desiredFacing = intentDelta > FACING_DEADZONE ? 1 : (intentDelta < -FACING_DEADZONE ? -1 : state.facingSign);
      if (desiredFacing !== state.facingSign && field.time - state.lastFacingFlip >= FACING_COOLDOWN) {
        state.facingSign = desiredFacing;
        state.lastFacingFlip = field.time;
      }
      state.facing = smoothToward(state.facing, state.facingSign, dt, 0.12);

      if (state.beatActionTimer > 0) {
        state.beatActionTimer -= dt;
        if (state.beatActionTimer <= 0) state.beatActionClip = null;
      }

      const clip = params.clip === 'auto' ? autoClip(field.time, audio) : params.clip;
      const set = FRAME_SETS[clip] || FRAME_SETS.idle;
      const pulseSpeed = 1 + audio.bands.bass * 0.55 + audio.beat.pulse * 0.18;
      state.t += dt * params.speed * pulseSpeed;
      state.clip = clip;
      state.frame = Math.floor(state.t * set.fps) % set.rects.length;
      state.audio = audio;
      state.params = params;

      if (audio.beat.pulse > 0.72 && state.lastBeat <= 0.72) {
        state.beatFlash = Math.min(1, state.beatFlash + 0.75);
        state.landing = Math.min(1, state.landing + (clip === 'jump' ? 0.55 : 0.25));
        if (params.clip === 'auto') {
          state.beatActionClip = BEAT_ACTION_CLIPS[state.beatActionIndex % BEAT_ACTION_CLIPS.length];
          state.beatActionIndex++;
          state.beatActionTimer = BEAT_ACTION_HOLD;
          state.t = 0;
        }
      }
      state.lastBeat = audio.beat.pulse;
      state.beatFlash = smoothToward(state.beatFlash, 0, dt, 0.11);
      state.landing = smoothToward(state.landing, 0, dt, 0.20);
      state.attackPhase = clip === 'attack'
        ? (state.attackPhase + dt * (1.8 + audio.beat.pulse * 1.5)) % 1
        : smoothToward(state.attackPhase, 0, dt, 0.12);

      for (let i = 0; i < SPARKS; i++) {
        sparkA[i] += dt * (0.25 + sparkV[i] * 0.22 + audio.bands.highs * 0.65);
        if (sparkA[i] > 1) {
          sparkA[i] -= 1;
          sparkX[i] = clamp(state.charX + (Math.random() - 0.5) * 0.55, 0.02, 0.98);
          sparkY[i] = clamp(state.charY - 0.25 + (Math.random() - 0.5) * 0.46, 0.03, 0.96);
        }
      }
    }

    function clearStage(look) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      const g = ctx.createRadialGradient(W * 0.5, H * 0.44, 0, W * 0.5, H * 0.44, Math.max(W, H) * 0.75);
      g.addColorStop(0, look.bg1);
      g.addColorStop(1, look.bg0);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    function getAvatarMetrics() {
      const set = FRAME_SETS[state.clip] || FRAME_SETS.idle;
      const frameList = frames?.[state.clip] || null;
      const frame = frameList?.[state.frame] || null;
      const rect = set.rects[state.frame] || set.rects[0];
      const [sx, sy, sw, sh] = rect;
      const src = frame || img;
      const srcX = frame ? 0 : sx;
      const srcY = frame ? 0 : sy;
      const srcW = frame ? frame.width : sw;
      const srcH = frame ? frame.height : sh;
      const scale = state.params.scale * Math.min(W, H) / 720;
      const dw = srcW * scale;
      const dh = srcH * scale;
      const bob = Math.sin(state.t * 7.2) * (state.clip === 'idle' ? 4 : 8);
      const jump = state.clip === 'jump' ? -Math.sin((state.frame + 0.5) / set.rects.length * Math.PI) * dh * 0.38 : 0;
      const px = state.charX * W;
      const py = state.charY * H + bob + jump;
      const dx = -dw / 2;
      const dy = -dh * set.anchorY;
      const auraY = py + dy + dh * 0.46;
      return { set, src, srcX, srcY, srcW, srcH, dw, dh, px, py, dx, dy, auraY };
    }

    function drawBackdrop(look) {
      const audio = state.audio;
      const params = state.params;
      const avatar = getAvatarMetrics();
      const cx = avatar.px;
      const cy = avatar.auraY;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const gridAlpha = 0.045 + params.aura * 0.025 + audio.bands.total * 0.05;
      ctx.strokeStyle = rgba(look.grid, gridAlpha);
      ctx.lineWidth = 1;
      const step = Math.max(48, Math.min(W, H) * 0.085);
      const phase = (state.t * 24) % step;
      ctx.beginPath();
      for (let x = -phase; x < W + step; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x + params.sway * 22, H);
      }
      for (let y = phase - step; y < H + step; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(W, y - params.sway * 18);
      }
      ctx.stroke();

      const auraR = Math.min(W, H) * (0.20 + params.aura * 0.08 + audio.beat.pulse * 0.05);
      const aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, auraR);
      aura.addColorStop(0, rgba(look.aura, 0.22 + params.aura * 0.10 + state.beatFlash * 0.18));
      aura.addColorStop(0.55, rgba(look.aura, 0.05 + params.aura * 0.04));
      aura.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    function drawGround(look) {
      if (!state.params.ground) return;
      const baseY = H * 0.68;
      const flowerBandTop = baseY + Math.min(W, H) * 0.01;
      const flowerBandBottom = H - Math.min(W, H) * 0.035;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(look.warm, 0.24);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(W * 0.12, baseY);
      ctx.bezierCurveTo(W * 0.32, baseY + 18, W * 0.65, baseY - 14, W * 0.88, baseY + 4);
      ctx.stroke();

      if (state.landing > 0.01) {
        ctx.strokeStyle = rgba(look.aura, state.landing * 0.45);
        ctx.lineWidth = 2 + state.landing * 5;
        ctx.beginPath();
        ctx.ellipse(state.charX * W, baseY + 2, Math.min(W, H) * (0.08 + state.landing * 0.08), 14 + state.landing * 22, 0, 0, TAU);
        ctx.stroke();
      }

      for (let i = 0; i < FLOWERS; i++) {
        const x = flowerX[i] * W;
        const y = flowerBandTop + flowerY[i] * Math.max(1, flowerBandBottom - flowerBandTop);
        const s = flowerS[i] * Math.max(3, Math.min(W, H) * 0.006);
        ctx.strokeStyle = rgba(look.grid, 0.32);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - s * 3.2);
        ctx.stroke();
        ctx.fillStyle = rgba(i % 3 === 0 ? look.flower : look.warm, 0.72);
        for (let p = 0; p < 5; p++) {
          const a = p * TAU / 5 + state.t * 0.12;
          ctx.beginPath();
          ctx.arc(x + Math.cos(a) * s, y - s * 3.4 + Math.sin(a) * s, s * 0.62, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    function drawSparks(look) {
      const params = state.params;
      const audio = state.audio;
      const amount = clamp(params.sparkle * 0.55 + audio.bands.highs * 0.7 + state.beatFlash * 0.6, 0, 1.8);
      if (amount <= 0.01) return;
      const count = Math.min(SPARKS, Math.max(8, Math.floor(SPARKS * Math.min(1, amount))));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < count; i++) {
        const tw = Math.sin(sparkA[i] * TAU + sparkSeed[i]) * 0.5 + 0.5;
        const x = sparkX[i] * W + Math.cos(sparkSeed[i] + state.t) * 8;
        const y = sparkY[i] * H - sparkA[i] * 34;
        const s = (1.2 + tw * 2.8) * (0.7 + amount * 0.5);
        ctx.strokeStyle = rgba(i % 2 ? look.aura : look.warm, (0.10 + tw * 0.42) * Math.min(1, amount));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - s, y);
        ctx.lineTo(x + s, y);
        ctx.moveTo(x, y - s);
        ctx.lineTo(x, y + s);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawAttackBolt(look) {
      if (state.clip !== 'attack' && state.beatFlash < 0.08) return;
      const dir = state.facing >= 0 ? 1 : -1;
      const sx = state.charX * W + dir * Math.min(W, H) * 0.11 * state.params.scale / 4;
      const sy = state.charY * H - Math.min(W, H) * 0.18;
      const len = Math.min(W, H) * (0.16 + state.attackPhase * 0.14 + state.beatFlash * 0.10);
      const alpha = state.clip === 'attack' ? 0.65 : state.beatFlash * 0.5;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? rgba(look.aura, alpha * 0.25) : rgba([220, 248, 255], alpha);
        ctx.lineWidth = pass === 0 ? 10 : 2;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        for (let i = 1; i <= 7; i++) {
          const t = i / 7;
          const x = sx + dir * len * t;
          const y = sy + Math.sin(t * TAU * 1.5 + state.t * 8) * 14 * (1 - t * 0.25);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawAvatar(look) {
      if (!img) {
        ctx.save();
        ctx.fillStyle = rgba(look.warm, 0.8);
        ctx.font = '600 18px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('loading Ramblin Visioneer', W / 2, H / 2);
        ctx.restore();
        return;
      }

      const avatar = getAvatarMetrics();

      ctx.save();
      ctx.translate(avatar.px, avatar.py);
      ctx.scale(state.facing >= 0 ? 1 : -1, 1);
      ctx.imageSmoothingEnabled = false;

      const bodyGlow = 0.32;
      if (bodyGlow > 0.01) {
        const glowY = avatar.dy + avatar.dh * 0.46;
        const glowAlpha = bodyGlow * (0.035 + state.params.aura * 0.04 + state.beatFlash * 0.05);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.translate(0, glowY);
        ctx.scale(avatar.dw * 0.46, avatar.dh * 0.43);
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        glow.addColorStop(0, rgba(look.aura, glowAlpha));
        glow.addColorStop(0.45, rgba(look.aura, glowAlpha * 0.45));
        glow.addColorStop(0.82, rgba(look.aura, glowAlpha * 0.10));
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(avatar.src, avatar.srcX, avatar.srcY, avatar.srcW, avatar.srcH, avatar.dx, avatar.dy, avatar.dw, avatar.dh);

      ctx.globalCompositeOperation = 'lighter';
      const eyeScale = avatar.dw / Math.max(1, avatar.srcW);
      const eyeR = Math.max(2.2, eyeScale * 1.9);
      const eyeGlow = 0.45 + state.beatFlash * 0.70 + state.audio.bands.highs * 0.36;
      const detectedEyes = avatar.src.eyePoints?.map(p => ({
        x: avatar.dx + p.x / Math.max(1, avatar.srcW) * avatar.dw,
        y: avatar.dy + p.y / Math.max(1, avatar.srcH) * avatar.dh,
      }));
      const eyePoints = detectedEyes?.length
        ? detectedEyes
        : [
          { x: -avatar.dw * 0.035, y: avatar.dy + avatar.dh * 0.28 },
          { x: avatar.dw * 0.035, y: avatar.dy + avatar.dh * 0.28 },
        ];
      for (const eye of eyePoints) {
        const bloom = ctx.createRadialGradient(eye.x, eye.y, 0, eye.x, eye.y, eyeR * 7.5);
        bloom.addColorStop(0, rgba([226, 252, 255], Math.min(1, eyeGlow)));
        bloom.addColorStop(0.16, rgba([33, 213, 255], eyeGlow * 0.46));
        bloom.addColorStop(0.48, rgba([30, 94, 255], eyeGlow * 0.22));
        bloom.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(eye.x, eye.y, eyeR * 7.5, 0, TAU);
        ctx.fill();

        ctx.lineWidth = Math.max(1, eyeScale * 0.58);
        ctx.strokeStyle = rgba([33, 184, 255], eyeGlow * 0.72);
        ctx.beginPath();
        ctx.arc(eye.x, eye.y, eyeR * 2.15, 0, TAU);
        ctx.stroke();

        ctx.strokeStyle = rgba([71, 54, 255], eyeGlow * 0.56);
        ctx.beginPath();
        ctx.arc(eye.x, eye.y, eyeR * 1.15, 0, TAU);
        ctx.stroke();

        ctx.fillStyle = rgba([236, 255, 255], eyeGlow * 0.90);
        ctx.beginPath();
        ctx.arc(eye.x, eye.y, eyeR * 0.56, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    function drawOverlayText(look) {
      const clip = state.clip;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.font = '600 16px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.fillStyle = rgba(look.warm, 0.72);
      ctx.textAlign = 'center';
      ctx.fillText(clip.toUpperCase(), W / 2, Math.max(34, H * 0.08));
      ctx.fillStyle = rgba(look.aura, 0.45);
      ctx.font = '500 12px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.fillText('LOVE EVERYONE   GROW FLOWERS   TELL THE TRUTH   STAY WEIRD', W / 2, Math.max(54, H * 0.08 + 20));
      ctx.restore();
    }

    function render() {
      const look = LOOKS[state.params.look] || LOOKS.stained;
      clearStage(look);
      drawBackdrop(look);
      drawGround(look);
      drawSparks(look);
      drawAttackBolt(look);
      drawAvatar(look);
      drawOverlayText(look);
    }

    return { resize, update, render, dispose() {} };
  },
};
