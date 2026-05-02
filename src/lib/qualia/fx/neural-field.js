// Neural Field — graph of soma nodes connected by curved filaments. Beat
// triggers traveling pulses along edges. Canvas2D + audio + pose.
//
// Audio map:
//   bass  → soma glow + edge thickness
//   mids  → branch density (more soma render at higher mids)
//   beat  → fire travelling pulses along random edges
//   highs → axon-tip flicker
// Pose map (when present):
//   each visible hand attracts a local pulse fire (a "stimulus")

const NUM_SOMA      = 80;
const NUM_EDGES     = 160;
const MAX_PULSES    = 120;

/** @type {import('../types.js').QualiaFXModule} */
export default {
  id: 'neural_field',
  name: 'Neural Field',
  contextType: 'canvas2d',

  params: [
    { id: 'density',  label: 'density',     type: 'range', min: 0.2, max: 1.5, step: 0.02, default: 1.0 },
    { id: 'glow',     label: 'soma glow',   type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0 },
    { id: 'pulseRate',label: 'pulse rate',  type: 'range', min: 0,   max: 4,   step: 0.05, default: 1.0 },
    { id: 'curve',    label: 'edge curve',  type: 'range', min: 0,   max: 0.6, step: 0.01, default: 0.18 },
    { id: 'palette',  label: 'palette',     type: 'select', options: ['violet','cyan','magenta','amber'], default: 'violet' },
    { id: 'poseStim', label: 'pose stim',   type: 'toggle', default: true },
  ],

  presets: {
    default: { density: 1.0, glow: 1.0, pulseRate: 1.0, curve: 0.18, palette: 'violet' },
    sparse:  { density: 0.45, pulseRate: 0.6 },
    dense:   { density: 1.4, pulseRate: 2.0 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // Soma positions in [0,1]^2.
    const sx = new Float32Array(NUM_SOMA);
    const sy = new Float32Array(NUM_SOMA);
    const sr = new Float32Array(NUM_SOMA);  // resting radius
    for (let i = 0; i < NUM_SOMA; i++) {
      sx[i] = Math.random();
      sy[i] = Math.random();
      sr[i] = 1.4 + Math.random() * 2.6;
    }

    // Edges as (a,b) index pairs + cached curve control offset.
    const ea = new Int16Array(NUM_EDGES);
    const eb = new Int16Array(NUM_EDGES);
    const ec = new Float32Array(NUM_EDGES); // sign of curvature
    for (let e = 0; e < NUM_EDGES; e++) {
      const a = (Math.random() * NUM_SOMA) | 0;
      // Connect to a nearby soma to avoid spaghetti — pick the closest of K random candidates.
      let bestB = a, bestD = Infinity;
      for (let k = 0; k < 6; k++) {
        const b = (Math.random() * NUM_SOMA) | 0;
        if (b === a) continue;
        const dx = sx[a] - sx[b], dy = sy[a] - sy[b];
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; bestB = b; }
      }
      ea[e] = a;
      eb[e] = bestB;
      ec[e] = Math.random() < 0.5 ? -1 : 1;
    }

    // Pulse pool — ring buffer of (edgeIdx, t, life, hue, intensity)
    const pe = new Int16Array(MAX_PULSES);
    const pt = new Float32Array(MAX_PULSES);
    const pl = new Float32Array(MAX_PULSES);
    const ph = new Float32Array(MAX_PULSES);
    const pi = new Float32Array(MAX_PULSES);
    let pulseCursor = 0;
    let pulseAccum = 0;

    const PALETTES = {
      violet:   { soma: 270, edge: 230, pulse: 300 },
      cyan:     { soma: 195, edge: 170, pulse: 220 },
      magenta:  { soma: 320, edge: 280, pulse: 340 },
      amber:    { soma:  40, edge:  20, pulse:  60 },
    };

    function spawnPulse(edgeIdx, hue, intensity) {
      const i = pulseCursor;
      pulseCursor = (pulseCursor + 1) % MAX_PULSES;
      pe[i] = edgeIdx;
      pt[i] = 0;
      pl[i] = 0.6 + Math.random() * 0.4;
      ph[i] = hue;
      pi[i] = intensity;
    }

    let scratch = {
      audioOn: false,
      bass: 0, mids: 0, highs: 0,
      beatP: 0,
      density: 1.0, glow: 1.0, pulseRate: 1.0, curve: 0.18,
      palette: PALETTES.violet,
      poseHands: [],
    };

    function update(field) {
      const { dt, audio, pose, params } = field;
      scratch.audioOn = !!audio.spectrum;
      scratch.bass    = audio.bands.bass;
      scratch.mids    = audio.bands.mids;
      scratch.highs   = audio.bands.highs;
      scratch.beatP   = audio.beat.pulse;
      scratch.density = params.density;
      scratch.glow    = params.glow;
      scratch.pulseRate = params.pulseRate;
      scratch.curve   = params.curve;
      scratch.palette = PALETTES[params.palette] || PALETTES.violet;

      // Beat → many pulses across random edges.
      if (audio.beat.active) {
        const n = Math.min(20, 4 + Math.floor(audio.bands.bass * 16));
        for (let k = 0; k < n; k++) {
          spawnPulse((Math.random() * NUM_EDGES) | 0, scratch.palette.pulse + (Math.random() - 0.5) * 30, 0.7 + audio.bands.bass * 0.6);
        }
      }
      // Highs → tip flicker via small intensity spikes.
      if (audio.highs.active) {
        for (let k = 0; k < 3; k++) {
          spawnPulse((Math.random() * NUM_EDGES) | 0, scratch.palette.pulse + 30, 0.3 + audio.bands.highs * 0.4);
        }
      }
      // Continuous low-rate firing tied to mids + slider.
      pulseAccum += (audio.bands.mids * 1.5 + 0.4) * params.pulseRate * dt;
      while (pulseAccum >= 1) {
        pulseAccum -= 1;
        spawnPulse((Math.random() * NUM_EDGES) | 0, scratch.palette.pulse + (Math.random() - 0.5) * 40, 0.4 + Math.random() * 0.4);
      }

      // Pose stimulus — fire pulses near hands.
      scratch.poseHands.length = 0;
      if (params.poseStim) {
        for (const p of pose.people) {
          for (const lm of [p.wrists?.l, p.wrists?.r]) {
            if (lm && lm.visibility > 0.4) scratch.poseHands.push([1.0 - lm.x, lm.y]);
          }
        }
        // Each detected hand fires one pulse on the nearest edge per few frames.
        for (const [hx, hy] of scratch.poseHands) {
          if (Math.random() < dt * 4) {
            // Pick any edge whose midpoint is close-ish.
            let bestE = 0, bestD = Infinity;
            for (let k = 0; k < 12; k++) {
              const e = (Math.random() * NUM_EDGES) | 0;
              const a = ea[e], b = eb[e];
              const mx = (sx[a] + sx[b]) * 0.5, my = (sy[a] + sy[b]) * 0.5;
              const d = (mx - hx) * (mx - hx) + (my - hy) * (my - hy);
              if (d < bestD) { bestD = d; bestE = e; }
            }
            spawnPulse(bestE, scratch.palette.pulse + 60, 0.8);
          }
        }
      }

      // Advance pulses.
      for (let i = 0; i < MAX_PULSES; i++) {
        if (pt[i] < pl[i]) pt[i] += dt * (1.5 + scratch.bass * 1.5);
      }
    }

    function edgeXY(e, t) {
      // Quadratic Bézier between two soma with a curvature control offset
      // perpendicular to the AB line.
      const a = ea[e], b = eb[e];
      const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b];
      const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
      const ddx = bx - ax, ddy = by - ay;
      const len = Math.hypot(ddx, ddy) + 1e-6;
      const nx = -ddy / len, ny = ddx / len;
      const k = scratch.curve * ec[e];
      const cx = mx + nx * k, cy = my + ny * k;
      const u = 1 - t;
      return [u * u * ax + 2 * u * t * cx + t * t * bx,
              u * u * ay + 2 * u * t * cy + t * t * by];
    }

    function render() {
      // Heavy decay = trails on neural firings.
      ctx.globalCompositeOperation = 'source-over';
      const fade = 0.10 + scratch.bass * 0.06;
      ctx.fillStyle = `rgba(5,5,13,${fade})`;
      ctx.fillRect(0, 0, W, H);

      ctx.globalCompositeOperation = 'lighter';

      // Edges — thin base lines.
      const edgeAlpha = 0.07 + scratch.bass * 0.10;
      ctx.lineWidth = 1.0 + scratch.bass * 0.6;
      ctx.strokeStyle = `hsla(${scratch.palette.edge},80%,60%,${edgeAlpha})`;
      for (let e = 0; e < NUM_EDGES; e++) {
        const a = ea[e], b = eb[e];
        const ax = sx[a] * W, ay = sy[a] * H;
        const bx = sx[b] * W, by = sy[b] * H;
        const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
        const ddx = bx - ax, ddy = by - ay;
        const len = Math.hypot(ddx, ddy) + 1e-6;
        const nx = -ddy / len, ny = ddx / len;
        const k = scratch.curve * ec[e] * Math.min(W, H);
        const cx = mx + nx * k, cy = my + ny * k;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cx, cy, bx, by);
        ctx.stroke();
      }

      // Pulses — small bright dots traveling along edges.
      const visibleSoma = Math.max(20, Math.floor(NUM_SOMA * scratch.density));
      for (let i = 0; i < MAX_PULSES; i++) {
        if (pt[i] >= pl[i]) continue;
        const t = pt[i] / pl[i];
        const [x01, y01] = edgeXY(pe[i], t);
        const x = x01 * W, y = y01 * H;
        const fade = 1 - t;
        const sz = 2.6 * pi[i] * fade + scratch.highs * 1.5;
        const a  = 0.7 * pi[i] * fade;
        ctx.fillStyle = `hsla(${ph[i]},90%,70%,${a})`;
        ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.fill();
      }

      // Soma — glowing nodes.
      const somaHue = scratch.palette.soma + scratch.mids * 30;
      for (let i = 0; i < visibleSoma; i++) {
        const x = sx[i] * W, y = sy[i] * H;
        const r = sr[i] * (1 + scratch.bass * 1.4 + scratch.beatP * 0.8) * scratch.glow;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
        grad.addColorStop(0,   `hsla(${somaHue},85%,75%,${0.7 * scratch.glow})`);
        grad.addColorStop(0.4, `hsla(${somaHue},85%,55%,${0.18 * scratch.glow})`);
        grad.addColorStop(1,   `hsla(${somaHue},85%,40%,0)`);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(x, y, r * 5, 0, Math.PI * 2); ctx.fill();
        // Solid core.
        ctx.fillStyle = `hsla(${somaHue},90%,82%,${0.9 * scratch.glow})`;
        ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, Math.PI * 2); ctx.fill();
      }

      // Hand stim markers — soft halo at each hand position.
      for (const [hx, hy] of scratch.poseHands) {
        const x = hx * W, y = hy * H;
        const r = 24 + scratch.bass * 18;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0,   `hsla(${scratch.palette.pulse},90%,70%,0.35)`);
        grad.addColorStop(1,   `hsla(${scratch.palette.pulse},90%,70%,0)`);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* nothing */ },
    };
  },
};
