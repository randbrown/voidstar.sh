// Visioneer Roadbook - a wandering optical notebook. It sketches drifting
// viewfinder frames, map-path traces, and pose-anchored focus marks as if the
// lab is remembering a camera walk through imaginary terrain.
//
// Audio map:
//   bass        -> ramble speed and route thickness (via modulators)
//   mids        -> exposure warmth and frame glow
//   highs       -> sparkle / scan flecks
//   beat.pulse  -> shutter flash and waypoint kicks
//
// Pose map:
//   head        -> focus anchor / viewfinder target
//   wristSpread -> wider field of view (via zoom modulator)
//   shoulderRoll -> route curl (via drift modulator)

import { scaleAudio } from '../field.js';
import { lmToCanvas } from '../video.js';

const MAX_MARKS = 180;
const TAU = Math.PI * 2;

const PALETTES = {
  dawn: {
    bg: '#05050d',
    ink: 'rgba(218,238,255,',
    warm: [255, 178, 105],
    cool: [87, 204, 255],
    accent: [255, 91, 154],
  },
  field: {
    bg: '#06080b',
    ink: 'rgba(224,246,232,',
    warm: [207, 255, 123],
    cool: [76, 209, 168],
    accent: [255, 211, 111],
  },
  ember: {
    bg: '#070507',
    ink: 'rgba(255,236,218,',
    warm: [255, 128, 75],
    cool: [118, 201, 255],
    accent: [255, 213, 91],
  },
  moon: {
    bg: '#040712',
    ink: 'rgba(226,232,255,',
    warm: [183, 162, 255],
    cool: [112, 223, 255],
    accent: [244, 245, 255],
  },
};

const PALETTE_IDS = Object.keys(PALETTES);

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function rgba(rgb, a) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

function wrap01(v) {
  v = v % 1;
  return v < 0 ? v + 1 : v;
}

function smoothToward(current, target, dt, halfLife) {
  const k = 1 - Math.pow(0.5, dt / Math.max(halfLife, 0.001));
  return current + (target - current) * k;
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'ramblin_visioneer_roadbook',
  name: 'Visioneer Roadbook',
  contextType: 'canvas2d',

  params: [
    { id: 'mode', label: 'mode', type: 'select',
      options: ['roadbook', 'viewfinder', 'constellation', 'memoir'], default: 'roadbook' },
    { id: 'palette', label: 'palette', type: 'select', options: PALETTE_IDS, default: 'dawn' },
    { id: 'density', label: 'waypoints', type: 'range', min: 30, max: MAX_MARKS, step: 5, default: 120,
      modulators: [{ source: 'audio.highsPulse', mode: 'add', amount: 24 }] },
    { id: 'ramble', label: 'ramble', type: 'range', min: 0, max: 2, step: 0.02, default: 0.78,
      modulators: [
        { source: 'audio.bass', mode: 'mul', amount: 0.45 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.22 },
      ] },
    { id: 'zoom', label: 'zoom', type: 'range', min: 0.5, max: 2.5, step: 0.02, default: 1.0,
      modulators: [
        { source: 'pose.wristSpread', mode: 'add', amount: 0.32 },
        { source: 'crowd.spread', mode: 'add', amount: 0.28 },
      ] },
    { id: 'drift', label: 'drift', type: 'range', min: -1, max: 1, step: 0.02, default: 0.25,
      modulators: [
        { source: 'pose.shoulderRoll', mode: 'add', amount: 0.35 },
        { source: 'crowd.sway', mode: 'add', amount: 0.30 },
      ] },
    { id: 'exposure', label: 'exposure', type: 'range', min: 0, max: 1.5, step: 0.02, default: 0.65,
      modulators: [
        { source: 'audio.mids', mode: 'add', amount: 0.30 },
        { source: 'audio.total', mode: 'add', amount: 0.16 },
      ] },
    { id: 'trails', label: 'trails', type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'poseReactivity', label: 'pose react', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { mode: 'roadbook', palette: 'dawn' },
      { mode: 'viewfinder', palette: 'field' },
      { mode: 'constellation', palette: 'moon' },
      { mode: 'memoir', palette: 'ember' },
    ],
  },

  presets: {
    default: { mode: 'roadbook', palette: 'dawn', density: 120, ramble: 0.78, zoom: 1.0, drift: 0.25, exposure: 0.65, trails: true, reactivity: 1.0, poseReactivity: 1.0 },
    roadbook: { mode: 'roadbook', palette: 'dawn', density: 140, ramble: 0.85, zoom: 1.0, drift: 0.35, exposure: 0.58, trails: true },
    viewfinder: { mode: 'viewfinder', palette: 'field', density: 95, ramble: 0.45, zoom: 1.35, drift: 0.05, exposure: 0.78, trails: false },
    constellation: { mode: 'constellation', palette: 'moon', density: 165, ramble: 1.15, zoom: 0.85, drift: -0.20, exposure: 0.72, trails: true },
    memoir: { mode: 'memoir', palette: 'ember', density: 110, ramble: 0.62, zoom: 1.15, drift: 0.55, exposure: 0.90, trails: true },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const x = new Float32Array(MAX_MARKS);
    const y = new Float32Array(MAX_MARKS);
    const vx = new Float32Array(MAX_MARKS);
    const vy = new Float32Array(MAX_MARKS);
    const life = new Float32Array(MAX_MARKS);
    const seed = new Float32Array(MAX_MARKS);
    const size = new Float32Array(MAX_MARKS);
    const pathX = new Float32Array(72);
    const pathY = new Float32Array(72);

    let focusX = 0.5;
    let focusY = 0.5;
    let guideX = 0.5;
    let guideY = 0.5;
    let phase = Math.random() * TAU;
    let flash = 0;
    let lastBeat = 0;

    const scratch = {
      mode: 'roadbook',
      palette: PALETTES.dawn,
      density: 120,
      ramble: 0.78,
      zoom: 1,
      drift: 0.25,
      exposure: 0.65,
      trails: true,
      audioOn: false,
      bass: 0,
      mids: 0,
      highs: 0,
      beat: 0,
      time: 0,
      dt: 0,
    };

    function resetMark(i) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * 0.45;
      x[i] = clamp01(0.5 + Math.cos(a) * r);
      y[i] = clamp01(0.5 + Math.sin(a) * r);
      vx[i] = (Math.random() - 0.5) * 0.012;
      vy[i] = (Math.random() - 0.5) * 0.012;
      life[i] = Math.random();
      seed[i] = Math.random();
      size[i] = 0.45 + Math.random() * 1.9;
    }

    for (let i = 0; i < MAX_MARKS; i++) resetMark(i);
    for (let i = 0; i < pathX.length; i++) {
      pathX[i] = focusX;
      pathY[i] = focusY;
    }

    function resize(w, h) {
      W = w;
      H = h;
      for (let i = 0; i < pathX.length; i++) {
        pathX[i] = focusX;
        pathY[i] = focusY;
      }
    }

    function pushPath(px, py) {
      for (let i = pathX.length - 1; i > 0; i--) {
        pathX[i] = pathX[i - 1];
        pathY[i] = pathY[i - 1];
      }
      pathX[0] = px;
      pathY[0] = py;
    }

    function update(field) {
      const params = field.params;
      const audio = scaleAudio(field.audio, params.reactivity);
      const dt = Math.min(field.dt || 0, 0.05);
      const person = field.pose?.people?.[0];
      let targetX = 0.5 + Math.sin(field.time * 0.19) * 0.22 + Math.cos(field.time * 0.071) * 0.08;
      let targetY = 0.5 + Math.cos(field.time * 0.16) * 0.18 + Math.sin(field.time * 0.113) * 0.08;

      if (person?.head && person.head.visibility > 0.3) {
        const [hx, hy] = lmToCanvas(person.head.x, person.head.y, W, H);
        targetX = hx / Math.max(1, W);
        targetY = hy / Math.max(1, H);
      } else if (field.crowd?.confidence > 0.05) {
        targetX = 0.5 + field.crowd.x * 0.28;
        targetY = 0.5 + field.crowd.y * 0.20;
      }

      focusX = smoothToward(focusX, clamp01(targetX), dt, 0.12);
      focusY = smoothToward(focusY, clamp01(targetY), dt, 0.12);
      phase += dt * (0.22 + params.ramble * 0.55 + audio.bands.bass * 0.5);

      guideX = clamp01(focusX + Math.cos(phase * 0.7) * 0.16 * params.drift);
      guideY = clamp01(focusY + Math.sin(phase * 0.9) * 0.13 * params.drift);
      pushPath(guideX, guideY);

      if (audio.beat.pulse > 0.72 && lastBeat <= 0.72) flash = Math.min(1.3, flash + 0.8);
      lastBeat = audio.beat.pulse;
      flash = smoothToward(flash, 0, dt, 0.16);

      const count = Math.min(MAX_MARKS, Math.max(1, params.density | 0));
      const speed = dt * (0.075 + params.ramble * 0.15 + audio.bands.total * 0.12);
      const curl = 0.4 + params.drift * 1.2;
      for (let i = 0; i < count; i++) {
        const dx = guideX - x[i];
        const dy = guideY - y[i];
        const d = Math.hypot(dx, dy) + 0.001;
        const orbit = ((seed[i] > 0.5 ? 1 : -1) * curl) / d;
        vx[i] += (dx * 0.20 - dy * orbit * 0.018) * speed;
        vy[i] += (dy * 0.20 + dx * orbit * 0.018) * speed;
        vx[i] += Math.cos(phase + seed[i] * TAU) * speed * 0.018;
        vy[i] += Math.sin(phase * 1.17 + seed[i] * TAU) * speed * 0.018;
        vx[i] *= 0.986;
        vy[i] *= 0.986;
        x[i] = wrap01(x[i] + vx[i]);
        y[i] = wrap01(y[i] + vy[i]);
        life[i] += dt * (0.10 + speed * 2.0 + audio.bands.highs * 0.18);
        if (life[i] > 1.35 + seed[i] * 0.6) {
          resetMark(i);
          x[i] = wrap01(guideX + (Math.random() - 0.5) * 0.18);
          y[i] = wrap01(guideY + (Math.random() - 0.5) * 0.18);
          life[i] = 0;
        }
      }

      scratch.mode = params.mode;
      scratch.palette = PALETTES[params.palette] || PALETTES.dawn;
      scratch.density = count;
      scratch.ramble = params.ramble;
      scratch.zoom = params.zoom;
      scratch.drift = params.drift;
      scratch.exposure = params.exposure;
      scratch.trails = !!params.trails;
      scratch.audioOn = !!audio.spectrum;
      scratch.bass = audio.bands.bass;
      scratch.mids = audio.bands.mids;
      scratch.highs = audio.bands.highs;
      scratch.beat = audio.beat.pulse;
      scratch.time = field.time;
      scratch.dt = dt;
    }

    function clearScene() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (scratch.trails) {
        ctx.fillStyle = 'rgba(5,5,13,0.18)';
      } else {
        ctx.fillStyle = scratch.palette.bg;
      }
      ctx.fillRect(0, 0, W, H);
    }

    function applyViewport() {
      const z = scratch.zoom;
      ctx.translate(W / 2, H / 2);
      ctx.scale(z, z);
      ctx.translate(-W / 2, -H / 2);
    }

    function drawGrid() {
      const p = scratch.palette;
      const step = Math.max(44, Math.min(W, H) * 0.075);
      const ox = ((phase * 24) % step) - step;
      const oy = ((phase * 17) % step) - step;
      ctx.save();
      applyViewport();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1;
      ctx.strokeStyle = p.ink + `${0.035 + scratch.exposure * 0.02})`;
      ctx.beginPath();
      for (let x0 = ox; x0 < W + step; x0 += step) {
        ctx.moveTo(x0, 0);
        ctx.lineTo(x0 + scratch.drift * 28, H);
      }
      for (let y0 = oy; y0 < H + step; y0 += step) {
        ctx.moveTo(0, y0);
        ctx.lineTo(W, y0 - scratch.drift * 22);
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawRoute() {
      const p = scratch.palette;
      ctx.save();
      applyViewport();
      ctx.globalCompositeOperation = 'lighter';
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let i = 0; i < pathX.length; i++) {
          const px = pathX[i] * W;
          const py = pathY[i] * H;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.lineWidth = pass === 0
          ? 9 + scratch.bass * 16
          : 1.4 + scratch.bass * 3;
        ctx.strokeStyle = pass === 0
          ? rgba(p.cool, 0.035 + scratch.exposure * 0.04)
          : rgba(p.accent, 0.35 + scratch.exposure * 0.16);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawViewfinder(px, py, r, a, rgb) {
      const w = r * 6.4;
      const h = r * 4.1;
      const corner = Math.min(w, h) * 0.24;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((seed[((px + py) | 0) % MAX_MARKS] - 0.5) * 0.18 + scratch.drift * 0.12);
      ctx.strokeStyle = rgba(rgb, a);
      ctx.lineWidth = Math.max(1, r * 0.22);
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2 + corner);
      ctx.lineTo(-w / 2, -h / 2);
      ctx.lineTo(-w / 2 + corner, -h / 2);
      ctx.moveTo(w / 2 - corner, -h / 2);
      ctx.lineTo(w / 2, -h / 2);
      ctx.lineTo(w / 2, -h / 2 + corner);
      ctx.moveTo(w / 2, h / 2 - corner);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(w / 2 - corner, h / 2);
      ctx.moveTo(-w / 2 + corner, h / 2);
      ctx.lineTo(-w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2 - corner);
      ctx.stroke();
      ctx.restore();
    }

    function drawMarks() {
      const p = scratch.palette;
      const count = scratch.density;
      const mode = scratch.mode;
      ctx.save();
      applyViewport();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < count; i++) {
        const px = x[i] * W;
        const py = y[i] * H;
        const beat = scratch.beat;
        const s = size[i] * (1 + scratch.highs * 0.45 + beat * 0.6);
        const fade = 1 - clamp01(life[i] / (1.35 + seed[i] * 0.6));
        const near = 1 - Math.min(1, Math.hypot(x[i] - guideX, y[i] - guideY) * 2.4);
        const a = (0.10 + fade * 0.28 + near * 0.28 + scratch.exposure * 0.08);
        const rgb = seed[i] < 0.45 ? p.cool : (seed[i] < 0.78 ? p.warm : p.accent);

        if (mode === 'viewfinder' && i % 4 === 0) {
          drawViewfinder(px, py, 3.5 + s * 1.4, a * 0.9, rgb);
        } else if (mode === 'constellation') {
          ctx.fillStyle = rgba(rgb, a + scratch.highs * 0.16);
          ctx.beginPath();
          ctx.arc(px, py, Math.max(0.8, s), 0, TAU);
          ctx.fill();
          if (i > 0 && i % 3 === 0) {
            const j = i - 1;
            const d = Math.hypot(x[i] - x[j], y[i] - y[j]);
            if (d < 0.18) {
              ctx.strokeStyle = rgba(p.cool, (0.06 + near * 0.14) * (1 - d / 0.18));
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(x[j] * W, y[j] * H);
              ctx.stroke();
            }
          }
        } else if (mode === 'memoir') {
          ctx.fillStyle = rgba(rgb, a * 0.55);
          ctx.fillRect(px - s * 5, py - s * 2.8, s * 10, s * 5.6);
          ctx.strokeStyle = rgba(p.ink === PALETTES.ember.ink ? p.accent : rgb, a * 0.8);
          ctx.lineWidth = 1;
          ctx.strokeRect(px - s * 5, py - s * 2.8, s * 10, s * 5.6);
        } else {
          ctx.strokeStyle = rgba(rgb, a);
          ctx.lineWidth = Math.max(1, s * 0.28);
          ctx.beginPath();
          ctx.moveTo(px - s * 2.4, py);
          ctx.lineTo(px + s * 2.4, py);
          ctx.moveTo(px, py - s * 2.4);
          ctx.lineTo(px, py + s * 2.4);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    function drawFocus() {
      const p = scratch.palette;
      const px = focusX * W;
      const py = focusY * H;
      const r = Math.min(W, H) * (0.055 + scratch.zoom * 0.012 + scratch.beat * 0.025);
      ctx.save();
      applyViewport();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(p.accent, 0.45 + scratch.exposure * 0.20 + scratch.beat * 0.25);
      ctx.lineWidth = 1.5 + scratch.beat * 2.5;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.moveTo(px - r * 1.45, py);
      ctx.lineTo(px - r * 0.72, py);
      ctx.moveTo(px + r * 0.72, py);
      ctx.lineTo(px + r * 1.45, py);
      ctx.moveTo(px, py - r * 1.45);
      ctx.lineTo(px, py - r * 0.72);
      ctx.moveTo(px, py + r * 0.72);
      ctx.lineTo(px, py + r * 1.45);
      ctx.stroke();

      drawViewfinder(guideX * W, guideY * H, r * 0.22, 0.30 + scratch.exposure * 0.16, p.cool);
      ctx.restore();
    }

    function drawGrade() {
      const p = scratch.palette;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      if (flash > 0.002) {
        ctx.fillStyle = rgba(p.warm, flash * 0.08);
        ctx.fillRect(0, 0, W, H);
      }

      const cx = W * focusX;
      const cy = H * focusY;
      const g = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.05, cx, cy, Math.max(W, H) * 0.72);
      g.addColorStop(0, rgba(p.cool, 0.035 + scratch.exposure * 0.025));
      g.addColorStop(0.55, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.42)');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      if (scratch.mode === 'viewfinder') {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = p.ink + '0.32)';
        ctx.lineWidth = 1;
        const m = Math.min(W, H) * 0.08;
        ctx.strokeRect(m, m, W - m * 2, H - m * 2);
        ctx.beginPath();
        ctx.moveTo(W / 2, m);
        ctx.lineTo(W / 2, m + 32);
        ctx.moveTo(W / 2, H - m);
        ctx.lineTo(W / 2, H - m - 32);
        ctx.moveTo(m, H / 2);
        ctx.lineTo(m + 32, H / 2);
        ctx.moveTo(W - m, H / 2);
        ctx.lineTo(W - m - 32, H / 2);
        ctx.stroke();
      }
    }

    function render() {
      clearScene();
      drawGrid();
      drawRoute();
      drawMarks();
      drawFocus();
      drawGrade();
    }

    return { resize, update, render, dispose() {} };
  },
};
