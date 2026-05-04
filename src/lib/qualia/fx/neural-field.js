// Neural Field — graph of soma nodes drifting in 3D, connected by curved
// filaments, with energy pulses streaming along the edges. Beats spike
// node radius; bass pumps soma glow + edge thickness; mids scales pulse
// rate; highs make tip flicker.
//
// Audio map:
//   bass  → soma glow + edge thickness + node spike envelope
//   mids  → continuous pulse spawn rate
//   beat  → bursts of pulses + sharp soma size-spike
//   highs → wrist/head local-stimulus accents
// Pose map (when present):
//   each visible hand fires nearest-edge pulses (a "stimulus")
//
// 3D motion model: each soma has a base position in [0,1]² × [-1,1] plus a
// per-axis sine drift (different freq/phase/amplitude per node). Projection
// is a cheap 1/(1+z·k) perspective scale; we don't bother with a full
// camera matrix — orthographic-with-depth-scale reads as 3D enough for the
// "neural net pulsing in space" feel.

import { scaleAudio } from '../field.js';

const NUM_SOMA   = 80;
const NUM_EDGES  = 160;
const MAX_PULSES = 200;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'neural_field',
  name: 'Neural Field',
  contextType: 'canvas2d',

  params: [
    { id: 'density',   label: 'density',     type: 'range', min: 0.2, max: 1.5, step: 0.02, default: 1.0 },
    { id: 'glow',      label: 'soma glow',   type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0 },
    { id: 'pulseRate', label: 'pulse rate',  type: 'range', min: 0,   max: 4,   step: 0.05, default: 1.5 },
    { id: 'curve',     label: 'edge curve',  type: 'range', min: 0,   max: 0.6, step: 0.01, default: 0.18 },
    { id: 'motion',    label: '3d motion',   type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total', mode: 'mul', amount: 0.30 },
      ] },
    { id: 'depth',     label: 'depth',       type: 'range', min: 0,   max: 1,   step: 0.02, default: 0.6 },
    { id: 'palette',   label: 'palette',     type: 'select', options: ['violet','cyan','magenta','amber'], default: 'violet' },
    { id: 'poseStim',  label: 'pose stim',   type: 'toggle', default: true },
    { id: 'reactivity',label: 'reactivity',  type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0 },
  ],

  presets: {
    default: { density: 1.0, glow: 1.0, pulseRate: 1.5, curve: 0.18, motion: 1.0, depth: 0.6, palette: 'violet', reactivity: 1.0 },
    sparse:  { density: 0.45, pulseRate: 0.8, motion: 0.6 },
    dense:   { density: 1.4, pulseRate: 2.5, motion: 1.4, depth: 0.8 },
    cosmic:  { density: 1.1, pulseRate: 2.0, motion: 1.6, depth: 0.95, palette: 'cyan' },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // Soma rest position (base) and per-axis 3D motion params.
    // x,y in [0,1], z in [-1, 1] (negative = closer to camera).
    const sx0  = new Float32Array(NUM_SOMA);
    const sy0  = new Float32Array(NUM_SOMA);
    const sz0  = new Float32Array(NUM_SOMA);
    const ampX = new Float32Array(NUM_SOMA);
    const ampY = new Float32Array(NUM_SOMA);
    const ampZ = new Float32Array(NUM_SOMA);
    const fX   = new Float32Array(NUM_SOMA);
    const fY   = new Float32Array(NUM_SOMA);
    const fZ   = new Float32Array(NUM_SOMA);
    const phX  = new Float32Array(NUM_SOMA);
    const phY  = new Float32Array(NUM_SOMA);
    const phZ  = new Float32Array(NUM_SOMA);
    const sBaseR = new Float32Array(NUM_SOMA); // resting radius

    // Live (post-motion + projected) per-soma state, refreshed each frame.
    const lx  = new Float32Array(NUM_SOMA);   // [0,1] projected
    const ly  = new Float32Array(NUM_SOMA);
    const lz  = new Float32Array(NUM_SOMA);   // raw z (for depth fade)
    const lsc = new Float32Array(NUM_SOMA);   // perspective scale
    // Per-soma beat-spike envelope (decays each frame; spikes on beat).
    const sSpike = new Float32Array(NUM_SOMA);

    for (let i = 0; i < NUM_SOMA; i++) {
      sx0[i] = Math.random();
      sy0[i] = Math.random();
      sz0[i] = Math.random() * 2 - 1;
      // Motion amplitudes — small in xy, larger in z so depth motion reads.
      ampX[i] = 0.035 + Math.random() * 0.075;
      ampY[i] = 0.035 + Math.random() * 0.075;
      ampZ[i] = 0.20  + Math.random() * 0.30;
      // Slow, varied drift freqs (rad/s).
      fX[i] = 0.25 + Math.random() * 0.65;
      fY[i] = 0.25 + Math.random() * 0.65;
      fZ[i] = 0.15 + Math.random() * 0.45;
      phX[i] = Math.random() * Math.PI * 2;
      phY[i] = Math.random() * Math.PI * 2;
      phZ[i] = Math.random() * Math.PI * 2;
      sBaseR[i] = 1.4 + Math.random() * 2.6;
    }

    // Edge graph — connect each soma to a NEARBY soma (closest of K
    // candidates) so the network reads as locally-clustered, not spaghetti.
    const ea = new Int16Array(NUM_EDGES);
    const eb = new Int16Array(NUM_EDGES);
    const ec = new Float32Array(NUM_EDGES); // curvature sign
    for (let e = 0; e < NUM_EDGES; e++) {
      const a = (Math.random() * NUM_SOMA) | 0;
      let bestB = a, bestD = Infinity;
      for (let k = 0; k < 6; k++) {
        const b = (Math.random() * NUM_SOMA) | 0;
        if (b === a) continue;
        const dx = sx0[a] - sx0[b], dy = sy0[a] - sy0[b], dz = sz0[a] - sz0[b];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) { bestD = d2; bestB = b; }
      }
      ea[e] = a;
      eb[e] = bestB;
      ec[e] = Math.random() < 0.5 ? -1 : 1;
    }

    // Pulse pool — ring buffer (edgeIdx, t-progress, life, hue, intensity).
    const pe = new Int16Array(MAX_PULSES);
    const pt = new Float32Array(MAX_PULSES);
    const pl = new Float32Array(MAX_PULSES);
    const ph = new Float32Array(MAX_PULSES);
    const pi = new Float32Array(MAX_PULSES);
    let pulseCursor = 0;
    let pulseAccum  = 0;

    const PALETTES = {
      violet:   { soma: 270, edge: 230, pulse: 300 },
      cyan:     { soma: 195, edge: 170, pulse: 220 },
      magenta:  { soma: 320, edge: 280, pulse: 340 },
      amber:    { soma:  40, edge:  20, pulse:  60 },
    };

    function spawnPulse(edgeIdx, hue, intensity) {
      const idx = pulseCursor;
      pulseCursor = (pulseCursor + 1) % MAX_PULSES;
      pe[idx] = edgeIdx;
      pt[idx] = 0;
      pl[idx] = 0.7 + Math.random() * 0.5;  // travel duration in seconds
      ph[idx] = hue;
      pi[idx] = intensity;
    }

    // ── Per-frame state stash for render() ───────────────────────────────────
    let scratch = {
      audioOn: false,
      bass: 0, mids: 0, highs: 0, total: 0,
      beatP: 0, beatActive: false,
      density: 1.0, glow: 1.0, pulseRate: 1.5,
      curve: 0.18, motion: 1.0, depth: 0.6,
      palette: PALETTES.violet,
      poseHands: [],
      time: 0, dt: 0,
    };

    function update(field) {
      const { dt, time, pose, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      scratch.audioOn   = !!audio.spectrum;
      scratch.bass      = audio.bands.bass;
      scratch.mids      = audio.bands.mids;
      scratch.highs     = audio.bands.highs;
      scratch.total     = audio.bands.total;
      scratch.beatP     = audio.beat.pulse;
      scratch.beatActive = audio.beat.active;
      scratch.density   = params.density;
      scratch.glow      = params.glow;
      scratch.pulseRate = params.pulseRate;
      scratch.curve     = params.curve;
      scratch.motion    = params.motion;
      scratch.depth     = params.depth;
      scratch.palette   = PALETTES[params.palette] || PALETTES.violet;
      scratch.time      = time;
      scratch.dt        = dt;

      // ── Advance 3D motion + project ────────────────────────────────────────
      // params.motion already includes the audio.total modulator (see spec).
      const motionScale = params.motion;
      const depthScale  = params.depth;
      for (let i = 0; i < NUM_SOMA; i++) {
        const x = sx0[i] + ampX[i] * motionScale * Math.sin(time * fX[i] + phX[i]);
        const y = sy0[i] + ampY[i] * motionScale * Math.sin(time * fY[i] + phY[i]);
        const z = sz0[i] + ampZ[i] * motionScale * Math.sin(time * fZ[i] + phZ[i]);
        // Perspective scale: closer (z<0) bigger, far (z>0) smaller. Capped
        // so very far / very close nodes don't blow up or vanish entirely.
        const zClamped = Math.max(-0.85, Math.min(0.85, z));
        const sc = 1 / (1 + zClamped * depthScale);
        // Pull projected x,y slightly toward centre for far nodes — gives
        // a subtle parallax-vanishing-point feel without proper FOV math.
        const px = 0.5 + (x - 0.5) * (0.5 + 0.5 * sc);
        const py = 0.5 + (y - 0.5) * (0.5 + 0.5 * sc);
        lx[i] = px;
        ly[i] = py;
        lz[i] = z;
        lsc[i] = sc;
      }

      // ── Beat spike envelope per soma ───────────────────────────────────────
      // On beat: every visible soma gets a brief size-spike. Decays
      // exponentially each frame so multiple beats can stack briefly.
      const decay = Math.pow(0.001, dt);
      for (let i = 0; i < NUM_SOMA; i++) sSpike[i] *= decay;
      if (audio.beat.active) {
        const visible = Math.min(NUM_SOMA, Math.max(20, Math.floor(NUM_SOMA * params.density)));
        for (let i = 0; i < visible; i++) {
          // Each soma spikes by a slightly random amount so the beat reads
          // as a wave of activations, not a single uniform pulse.
          sSpike[i] = Math.max(sSpike[i], 0.6 + Math.random() * 0.6);
        }
      }

      // ── Pulse spawning ─────────────────────────────────────────────────────
      // Beat → 8-20 pulses across random edges.
      if (audio.beat.active) {
        const n = Math.min(28, 8 + Math.floor(audio.bands.bass * 22));
        for (let k = 0; k < n; k++) {
          spawnPulse((Math.random() * NUM_EDGES) | 0,
                     scratch.palette.pulse + (Math.random() - 0.5) * 30,
                     0.85 + audio.bands.bass * 0.6);
        }
      }
      // Highs → tip flicker.
      if (audio.highs.active) {
        for (let k = 0; k < 4; k++) {
          spawnPulse((Math.random() * NUM_EDGES) | 0,
                     scratch.palette.pulse + 30,
                     0.4 + audio.bands.highs * 0.4);
        }
      }
      // Continuous flow tied to mids + total + slider. Even with no audio,
      // a baseline 0.6 keeps the network looking alive.
      const baseRate = 0.6;
      const flow = (baseRate + audio.bands.mids * 2.0 + audio.bands.total * 0.8) * params.pulseRate;
      pulseAccum += flow * dt;
      while (pulseAccum >= 1) {
        pulseAccum -= 1;
        spawnPulse((Math.random() * NUM_EDGES) | 0,
                   scratch.palette.pulse + (Math.random() - 0.5) * 40,
                   0.4 + Math.random() * 0.4);
      }

      // Pose stimulus — fire pulses on edges nearest to each visible hand.
      scratch.poseHands.length = 0;
      if (params.poseStim) {
        for (const p of pose.people) {
          for (const lm of [p.wrists?.l, p.wrists?.r]) {
            if (lm && lm.visibility > 0.4) scratch.poseHands.push([1.0 - lm.x, lm.y]);
          }
        }
        for (const [hx, hy] of scratch.poseHands) {
          if (Math.random() < dt * 5) {
            // Pick from K random candidate edges, take the closest midpoint.
            let bestE = 0, bestD = Infinity;
            for (let k = 0; k < 12; k++) {
              const e = (Math.random() * NUM_EDGES) | 0;
              const a = ea[e], b = eb[e];
              const mx = (lx[a] + lx[b]) * 0.5, my = (ly[a] + ly[b]) * 0.5;
              const d = (mx - hx) * (mx - hx) + (my - hy) * (my - hy);
              if (d < bestD) { bestD = d; bestE = e; }
            }
            spawnPulse(bestE, scratch.palette.pulse + 60, 0.9);
          }
        }
      }

      // ── Advance pulses ─────────────────────────────────────────────────────
      // Bass speeds up the flow — gives the sensation of energy injection.
      const speed = 1.5 + scratch.bass * 1.5;
      for (let i = 0; i < MAX_PULSES; i++) {
        if (pt[i] < pl[i]) pt[i] += dt * speed;
      }
    }

    // Bezier between two soma in projected space, with curvature offset
    // perpendicular to the AB line.
    function edgeXY(e, t) {
      const a = ea[e], b = eb[e];
      const ax = lx[a], ay = ly[a], bx = lx[b], by = ly[b];
      const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
      const ddx = bx - ax, ddy = by - ay;
      const len = Math.hypot(ddx, ddy) + 1e-6;
      const nx = -ddy / len, ny = ddx / len;
      // Curvature scales with the AVG depth — distant edges curve less.
      const depthScale = (lsc[a] + lsc[b]) * 0.5;
      const k = scratch.curve * ec[e] * depthScale;
      const cx = mx + nx * k, cy = my + ny * k;
      const u = 1 - t;
      return [u * u * ax + 2 * u * t * cx + t * t * bx,
              u * u * ay + 2 * u * t * cy + t * t * by];
    }

    function render() {
      // Heavy decay = trails. Bass slightly opens up the trails.
      ctx.globalCompositeOperation = 'source-over';
      const fade = 0.10 + scratch.bass * 0.05;
      ctx.fillStyle = `rgba(5,5,13,${fade})`;
      ctx.fillRect(0, 0, W, H);

      ctx.globalCompositeOperation = 'lighter';

      // ── Edges ──────────────────────────────────────────────────────────────
      const edgeAlpha = 0.05 + scratch.bass * 0.10;
      for (let e = 0; e < NUM_EDGES; e++) {
        const a = ea[e], b = eb[e];
        const ax = lx[a] * W, ay = ly[a] * H;
        const bx = lx[b] * W, by = ly[b] * H;
        const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
        const ddx = bx - ax, ddy = by - ay;
        const len = Math.hypot(ddx, ddy) + 1e-6;
        const nx = -ddy / len, ny = ddx / len;
        const depthScale = (lsc[a] + lsc[b]) * 0.5;
        const k = scratch.curve * ec[e] * Math.min(W, H) * depthScale;
        const cx = mx + nx * k, cy = my + ny * k;
        // Linewidth + alpha scale with depth so distant edges read as fainter.
        ctx.lineWidth   = (0.7 + scratch.bass * 0.7) * depthScale;
        ctx.strokeStyle = `hsla(${scratch.palette.edge},80%,60%,${edgeAlpha * depthScale})`;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cx, cy, bx, by);
        ctx.stroke();
      }

      // ── Pulses with comet trails ───────────────────────────────────────────
      // Each pulse renders as a glowing head plus 4 fading trail dots
      // sampled BACK along the edge curve. That's what makes the energy
      // "stream" along the connection visible at any frame.
      const TRAIL_SAMPLES = 5;
      const TRAIL_SPACING = 0.04; // in t-space (each sample 4% of edge back)
      for (let i = 0; i < MAX_PULSES; i++) {
        if (pt[i] >= pl[i]) continue;
        const t = pt[i] / pl[i];
        const a = ea[pe[i]], b = eb[pe[i]];
        const depthScale = (lsc[a] + lsc[b]) * 0.5;
        const fade = 1 - t;
        const baseSize = (2.6 + scratch.highs * 1.5) * pi[i] * depthScale;
        const headHue = ph[i];
        for (let s = 0; s < TRAIL_SAMPLES; s++) {
          const tt = t - s * TRAIL_SPACING;
          if (tt < 0) break;
          const [x01, y01] = edgeXY(pe[i], tt);
          const x = x01 * W, y = y01 * H;
          const trailFade = (1 - s / TRAIL_SAMPLES);
          const sz = baseSize * (1 - s * 0.18) * fade;
          const a  = 0.78 * pi[i] * fade * trailFade;
          // Subtle hue shift along the trail — head bright, tail cooler.
          const hue = headHue - s * 8;
          ctx.fillStyle = `hsla(${hue},90%,${72 + s * 4}%,${a})`;
          ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.fill();
        }
      }

      // ── Soma ───────────────────────────────────────────────────────────────
      // Draw back-to-front so closer nodes overlap farther ones cleanly.
      // We fake the sort by iterating in z order — simple bucket pass since
      // NUM_SOMA is small.
      const visible = Math.min(NUM_SOMA, Math.max(20, Math.floor(NUM_SOMA * scratch.density)));
      const order = _somaOrder;
      for (let i = 0; i < visible; i++) order[i] = i;
      // Insertion sort by lz[i] descending (far first → near last).
      for (let i = 1; i < visible; i++) {
        let j = i;
        while (j > 0 && lz[order[j - 1]] < lz[order[j]]) {
          const tmp = order[j - 1]; order[j - 1] = order[j]; order[j] = tmp;
          j--;
        }
      }

      const somaHue = scratch.palette.soma + scratch.mids * 30;
      for (let k = 0; k < visible; k++) {
        const i = order[k];
        const x = lx[i] * W, y = ly[i] * H;
        // Beat spike adds a brief sharp size punch ON TOP of the slow
        // bass/glow scaling — so beats read as percussive flashes.
        const spike = sSpike[i];
        const r = sBaseR[i] *
                  lsc[i] *
                  (1 + scratch.bass * 1.4 + scratch.beatP * 0.6 + spike * 1.8) *
                  scratch.glow;

        // Soft halo
        const haloR = r * 5;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, haloR);
        const haloAlpha = (0.7 + spike * 0.4) * scratch.glow * lsc[i];
        grad.addColorStop(0,   `hsla(${somaHue},85%,75%,${haloAlpha})`);
        grad.addColorStop(0.4, `hsla(${somaHue},85%,55%,${0.18 * scratch.glow * lsc[i]})`);
        grad.addColorStop(1,   `hsla(${somaHue},85%,40%,0)`);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(x, y, haloR, 0, Math.PI * 2); ctx.fill();

        // Solid core — saturates to white on a strong spike for visible flash.
        const coreLight = 82 + spike * 15;
        const coreAlpha = (0.9 + spike * 0.1) * scratch.glow;
        ctx.fillStyle = `hsla(${somaHue},${90 - spike * 20}%,${coreLight}%,${coreAlpha})`;
        ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, Math.PI * 2); ctx.fill();
      }

      // ── Pose stim halos ────────────────────────────────────────────────────
      for (const [hx, hy] of scratch.poseHands) {
        const x = hx * W, y = hy * H;
        const r = 28 + scratch.bass * 22;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `hsla(${scratch.palette.pulse},90%,70%,0.40)`);
        grad.addColorStop(1, `hsla(${scratch.palette.pulse},90%,70%,0)`);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
    }

    // Reusable order buffer for back-to-front soma sort. Allocated once at
    // create() time — sort happens in-place every frame.
    const _somaOrder = new Int16Array(NUM_SOMA);

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* GC handles typed arrays */ },
    };
  },
};
