// Nightcall — homage to Vincent Belorgey (Kavinsky). The premise of the
// song as a quale: a red Testarossa (the outrun arcade sprite) cruising a
// rain-slick night highway under a blackish-blue storm sky, beat-driven
// branching lightning, sodium streetlights strobing past, and — when the
// watcher toggle is on — the album art's red glowing eyes opening in the
// sky. Red / white / blue-black only; the palette IS the tribute.
//
// Audio map:
//   bass        -> tail-light bloom, road glow, cruise speed
//   mids        -> dash scroll surge
//   highs       -> star twinkle, rain shimmer, streetlight sparkle
//   beat.pulse  -> lightning strikes + sky flash, brake flash, eye flare
//   spectrum    -> city skyline silhouette on the horizon
//
// Pose map:
//   head.x      -> lane drift (the car eases toward where you lean)
//
// Idle (no audio): the car cruises, dashes scroll, ambient lightning on a
// slow random timer, the eyes breathe. The night doesn't stop.

import { scaleAudio } from '../field.js';
import { lmToCanvas } from '../video.js';
import { keyOutBackground } from './arcade/engine.js';

const CAR_URL = '/arcade/outrun_ferrari.png';
const TAU = Math.PI * 2;

const HORIZON = 0.44;            // horizon as a fraction of H
const NUM_STARS = 110;
const NUM_RAIN = 150;
const SKY_BINS = 48;             // skyline spectrum bins
const MAX_BOLTS = 3;
const TRUNK_PTS = 16;            // points per lightning trunk
const BRANCHES = 3;              // branches per bolt
const BRANCH_PTS = 7;            // points per branch
const LIGHT_SPACING = 0.16;      // streetlight world spacing (depth units)
const NUM_LIGHTS = 7;            // visible poles per side

// The colours of the cover: blue-black night, red glow, cold white.
const SKY_TOP = '#04060f';
const SKY_HORIZON = '#0d1526';
const ROAD = '#0b101f';
const SHOULDER = '#04050c';

// Bake a soft radial glow once — drawImage per use beats a fresh
// createRadialGradient every frame (the fx draws ~30 glows a frame).
function bakeGlow(inner, mid, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.3, mid);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

function loadCar() {
  const img = new Image();
  img.decoding = 'async';
  img.src = CAR_URL;
  return new Promise(resolve => {
    if (img.complete && img.naturalWidth) { resolve(keyOutBackground(img)); return; }
    img.onload = () => resolve(keyOutBackground(img));
    img.onerror = () => resolve(null);
  });
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'nightcall',
  name: 'Nightcall',
  contextType: 'canvas2d',

  params: [
    { id: 'speed', label: 'speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total', mode: 'mul', amount: 0.35 },
      ] },
    // Storm — lightning frequency + brightness. Strikes land on kicks when
    // audio is live; on an ambient timer when it isn't.
    { id: 'storm', label: 'storm', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    // Glow — the red bloom budget (tail lights, reflections, eyes).
    { id: 'glow', label: 'glow', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass', mode: 'add', amount: 0.40 },
      ] },
    { id: 'watcher', label: 'watcher', type: 'toggle', default: true },
    { id: 'city', label: 'city', type: 'toggle', default: true },
    { id: 'rain', label: 'rain', type: 'range', min: 0, max: 1, step: 0.02, default: 0.6 },
    { id: 'poseInfluence', label: 'pose influence', type: 'range', min: 0, max: 1, step: 0.02, default: 0.5 },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Cruise → nightfall → full storm. A chapter arc for auto-phase.
  autoPhase: {
    steps: [
      { storm: 0.25, rain: 0.25, watcher: false, speed: 1.4 },
      { storm: 1.0,  rain: 0.6,  watcher: true,  speed: 1.0 },
      { storm: 1.8,  rain: 0.9,  watcher: true,  glow: 1.4 },
    ],
  },

  presets: {
    default: { speed: 1.0, storm: 1.0, glow: 1.0, watcher: true, city: true,
               rain: 0.6, poseInfluence: 0.5, reactivity: 1.0 },
    cruise:  { speed: 1.5, storm: 0.25, rain: 0.25, watcher: false },
    storm:   { storm: 1.8, rain: 0.9, glow: 1.3 },
    watcher: { storm: 1.2, glow: 1.5, rain: 0.5, watcher: true },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const car = await loadCar();
    const glowRed = bakeGlow('rgba(255,64,52,1)', 'rgba(214,16,32,0.55)');
    const glowAmber = bakeGlow('rgba(255,228,185,1)', 'rgba(255,195,125,0.40)');

    // ── Pre-allocated state ─────────────────────────────────────────────
    // Stars: x, y (fractions of sky), twinkle phase.
    const stars = new Float32Array(NUM_STARS * 3);
    for (let i = 0; i < NUM_STARS; i++) {
      stars[i * 3]     = Math.random();
      stars[i * 3 + 1] = Math.random() * 0.85;
      stars[i * 3 + 2] = Math.random() * TAU;
    }
    // Rain streaks: x, y (fractions), depth, phase-speed.
    const rain = new Float32Array(NUM_RAIN * 4);
    for (let i = 0; i < NUM_RAIN; i++) {
      rain[i * 4]     = Math.random();
      rain[i * 4 + 1] = Math.random();
      rain[i * 4 + 2] = 0.35 + Math.random() * 0.65;
      rain[i * 4 + 3] = 0.8 + Math.random() * 0.5;
    }
    // Skyline bins (EMA-smoothed spectrum heights, 0..1).
    const skyline = new Float32Array(SKY_BINS);
    // Lightning bolt pool — trunk + branch points in x/y fractions of the
    // sky box, filled at spawn, never re-allocated.
    const bolts = [];
    for (let i = 0; i < MAX_BOLTS; i++) {
      bolts.push({
        life: 0,                                    // 1 → 0, dead at 0
        strength: 1,
        trunk: new Float32Array(TRUNK_PTS * 2),
        branch: new Float32Array(BRANCHES * BRANCH_PTS * 2),
        branchN: new Uint8Array(BRANCHES),          // used points per branch
      });
    }

    function spawnBolt(strength) {
      let slot = null;
      for (const b of bolts) if (b.life <= 0) { slot = b; break; }
      if (!slot) return;
      slot.life = 1;
      slot.strength = 0.7 + strength * 0.6;
      // Trunk: random walk from the sky top down to the horizon, jitter
      // shrinking as it descends so the strike converges on its target.
      let x = 0.12 + Math.random() * 0.76;
      const drift = (Math.random() * 2 - 1) * 0.010;
      for (let p = 0; p < TRUNK_PTS; p++) {
        const t = p / (TRUNK_PTS - 1);
        slot.trunk[p * 2] = x;
        slot.trunk[p * 2 + 1] = t;
        x += drift + (Math.random() * 2 - 1) * 0.028 * (1 - t * 0.6);
      }
      // Branches: short diverging walks off random trunk points.
      for (let b = 0; b < BRANCHES; b++) {
        if (Math.random() < 0.25) { slot.branchN[b] = 0; continue; }
        const at = 2 + ((Math.random() * (TRUNK_PTS - 6)) | 0);
        let bx = slot.trunk[at * 2], by = slot.trunk[at * 2 + 1];
        const side = Math.random() < 0.5 ? -1 : 1;
        const n = 4 + ((Math.random() * (BRANCH_PTS - 4)) | 0);
        slot.branchN[b] = n;
        for (let p = 0; p < n; p++) {
          slot.branch[(b * BRANCH_PTS + p) * 2] = bx;
          slot.branch[(b * BRANCH_PTS + p) * 2 + 1] = by;
          bx += side * (0.008 + Math.random() * 0.020);
          by += 0.02 + Math.random() * 0.03;
        }
      }
    }

    // ── Cached gradients — rebuilt on resize only ───────────────────────
    let skyGrad = null, vignette = null;
    function rebuildGradients() {
      const hy = H * HORIZON;
      skyGrad = ctx.createLinearGradient(0, 0, 0, hy);
      skyGrad.addColorStop(0, SKY_TOP);
      skyGrad.addColorStop(1, SKY_HORIZON);
      vignette = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.45,
                                          W / 2, H * 0.55, Math.max(W, H) * 0.75);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(2,3,8,0.55)');
    }
    rebuildGradients();

    // ── Driving state ───────────────────────────────────────────────────
    let dist = 0;            // travelled distance — scrolls dashes + lights
    let curve = 0;           // smoothed road curve (-1..1)
    let laneX = 0;           // smoothed lane position (-1..1)
    let bank = 0;            // visual bank for the car art
    let wanderP = Math.random() * TAU;
    let flash = 0;           // sky flash envelope from strikes
    let idleBoltAt = 4 + Math.random() * 6;   // ambient-strike clock (idle)

    const scratch = {
      time: 0, dt: 0, speed: 1,
      bass: 0, mids: 0, highs: 0, total: 0, beatPulse: 0, rms: 0,
      audioOn: false, brake: 0,
      storm: 1, glow: 1, rainAmt: 0.6, watcher: true, city: true,
      eye: 0.4,
    };

    function update(field) {
      const params = field.params;
      const audio = scaleAudio(field.audio, params.reactivity);
      const dt = field.dt;
      const audioOn = !!audio.spectrum;

      // Cruise speed — the resolved speed param already carries audio.total.
      const spd = params.speed * (0.65 + audio.bands.bass * 0.4 + audio.bands.mids * 0.25);
      dist += dt * spd * 1.7;

      // Road curve — incommensurate sines of distance so the highway is
      // almost always bending gently one way or the other.
      const curveTarget = Math.sin(dist * 0.11) * 0.4 + Math.sin(dist * 0.043 + 1.7) * 0.25;
      curve += (curveTarget - curve) * Math.min(1, dt * 0.9);

      // Lane: pose head leads when someone's in frame, else a slow wander.
      wanderP += dt * 0.25;
      let laneTarget = Math.sin(wanderP) * 0.28 + Math.sin(wanderP * 0.41 + 0.9) * 0.12;
      const inf = params.poseInfluence || 0;
      const people = field.pose && field.pose.people;
      if (inf > 0.001 && people && people.length) {
        const p = people[0];
        if (p && p.head && p.head.visibility > 0.3) {
          // Screen-aligned head x so leaning left on the mirrored preview
          // steers the car left — same rationale as synthwave's pose shift.
          const [hx] = lmToCanvas(p.head.x, p.head.y, W, H);
          const poseLane = Math.max(-1, Math.min(1, (hx / W - 0.5) * 2.4));
          laneTarget = laneTarget * (1 - inf) + poseLane * inf;
        }
      }
      laneX += (laneTarget - laneX) * Math.min(1, dt * 2.2);
      bank += ((laneTarget - laneX) * 2.5 - bank) * Math.min(1, dt * 6);

      // Lightning. Live: strikes ride hard kicks, gated by storm. Idle: an
      // ambient strike every few seconds keeps the night alive.
      const storm = params.storm;
      if (storm > 0.01) {
        if (audioOn) {
          if (audio.beat.active && audio.beat.pulse > 0.45 && Math.random() < 0.38 * storm) {
            spawnBolt(audio.beat.pulse * storm);
            flash = Math.max(flash, 0.5 + 0.4 * Math.min(1, storm));
          }
        } else if (field.time > idleBoltAt) {
          idleBoltAt = field.time + (3 + Math.random() * 9) / Math.max(0.25, storm);
          spawnBolt(0.6 * storm);
          flash = Math.max(flash, 0.45);
        }
      }
      for (const b of bolts) if (b.life > 0) b.life = Math.max(0, b.life - dt * 3.4);
      flash = Math.max(0, flash - dt * 2.8);

      // Rain — streaks fall with a shear from the driving speed.
      const rainAmt = params.rain;
      if (rainAmt > 0.01) {
        for (let i = 0; i < NUM_RAIN; i++) {
          const z = rain[i * 4 + 2];
          rain[i * 4 + 1] += dt * rain[i * 4 + 3] * (1.4 + spd * 0.3) * z;
          rain[i * 4]     -= dt * 0.06 * z * (1 + curve);
          if (rain[i * 4 + 1] > 1) { rain[i * 4 + 1] -= 1; rain[i * 4] = Math.random(); }
          if (rain[i * 4] < 0) rain[i * 4] += 1;
        }
      }

      // Skyline — log-binned spectrum, EMA so the city breathes rather
      // than flickers. Idle: a slow sine ridge.
      if (audioOn) {
        const spec = audio.spectrum;
        const n = spec.length;
        for (let i = 0; i < SKY_BINS; i++) {
          const f0 = Math.pow(n * 0.75, i / SKY_BINS) | 0;
          const f1 = Math.max(f0 + 1, Math.pow(n * 0.75, (i + 1) / SKY_BINS) | 0);
          let sum = 0;
          for (let f = f0; f < f1; f++) sum += spec[f];
          const v = (sum / (f1 - f0)) / 255;
          skyline[i] += (v - skyline[i]) * 0.25;
        }
      } else {
        for (let i = 0; i < SKY_BINS; i++) {
          const v = 0.22 + 0.16 * Math.sin(field.time * 0.5 + i * 0.55);
          skyline[i] += (v - skyline[i]) * 0.06;
        }
      }

      // Stash for render.
      scratch.time = field.time;
      scratch.dt = dt;
      scratch.speed = spd;
      scratch.bass = audio.bands.bass;
      scratch.mids = audio.bands.mids;
      scratch.highs = audio.bands.highs;
      scratch.total = audio.bands.total;
      scratch.beatPulse = audio.beat.pulse;
      scratch.rms = audio.rms;
      scratch.audioOn = audioOn;
      scratch.brake = audio.beat.pulse;
      scratch.storm = storm;
      scratch.glow = params.glow;
      scratch.rainAmt = rainAmt;
      scratch.watcher = !!params.watcher;
      scratch.city = !!params.city;
      // The watcher's eyes: open with the music, breathe when idle.
      const eyeTarget = audioOn
        ? 0.35 + scratch.total * 0.45 + scratch.beatPulse * 0.3
        : 0.35 + 0.12 * Math.sin(field.time * 0.6);
      scratch.eye += (eyeTarget - scratch.eye) * Math.min(1, dt * 4);
    }

    // Road-space helpers — p in [0..1], 0 at the horizon, 1 at the bottom.
    function roadCx(p) { return W * 0.5 + curve * (1 - p) * (1 - p) * W * 0.55; }
    function roadHalf(p) { return W * 0.02 + p * p * W * 0.42; }

    function render() {
      const t = scratch.time;
      const hy = H * HORIZON;
      const fs = Math.min(W, H) / 1080;
      const glow = scratch.glow;

      // ── Sky ───────────────────────────────────────────────────────────
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, hy);
      ctx.fillStyle = ROAD;
      ctx.fillRect(0, hy, W, H - hy);

      // Stars — sparse, cold, high-twinkle.
      const twAmp = 0.5 + scratch.highs * 0.5;
      ctx.fillStyle = '#dfe8ff';
      for (let i = 0; i < NUM_STARS; i++) {
        const tw = 0.5 + 0.5 * Math.sin(t * 1.6 + stars[i * 3 + 2]);
        ctx.globalAlpha = 0.05 + 0.22 * tw * twAmp;
        ctx.fillRect(stars[i * 3] * W, stars[i * 3 + 1] * hy, 1.5 * fs + 1, 1.5 * fs + 1);
      }
      ctx.globalAlpha = 1;

      // The watcher — the cover's red eyes, opening in the storm.
      if (scratch.watcher) {
        const eye = scratch.eye;
        const ex = W * 0.5 + Math.sin(t * 0.07) * W * 0.04;
        const ey = hy * 0.36 + Math.sin(t * 0.11) * hy * 0.03;
        const sep = W * 0.055;
        const er = Math.min(W, H) * (0.030 + eye * 0.028) * (0.6 + glow * 0.4);
        for (let s = -1; s <= 1; s += 2) {
          const x = ex + s * sep, y = ey;
          const a = eye * (s === 1 ? 1 : 0.72) * 0.85;   // right eye leads, like the art
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = a;
          ctx.drawImage(glowRed, x - er * 3, y - er * 3, er * 6, er * 6);
          ctx.fillStyle = 'rgba(255,150,120,1)';
          ctx.beginPath(); ctx.arc(x, y, er * 0.55, 0, TAU); ctx.fill();
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = `rgba(255,255,255,${Math.min(1, a * 1.5)})`;
          ctx.beginPath(); ctx.arc(x - er * 0.2, y - er * 0.2, Math.max(1, er * 0.16), 0, TAU); ctx.fill();
        }
      }

      // ── Lightning ─────────────────────────────────────────────────────
      for (const b of bolts) {
        if (b.life <= 0) continue;
        const flicker = 0.72 + 0.28 * Math.sin(t * 47 + b.trunk[0] * 40);
        const a = b.life * b.life * b.strength * flicker;
        // Bloom pass, then the beam — the double-stroke glow idiom.
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0
            ? `rgba(140,170,255,${a * 0.30})`
            : `rgba(240,247,255,${a})`;
          ctx.lineWidth = (pass === 0 ? 7 : 2) * fs + (pass === 0 ? 2 : 0.5);
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(b.trunk[0] * W, b.trunk[1] * hy);
          for (let p = 1; p < TRUNK_PTS; p++) {
            ctx.lineTo(b.trunk[p * 2] * W, b.trunk[p * 2 + 1] * hy);
          }
          ctx.stroke();
          ctx.lineWidth = (pass === 0 ? 4 : 1.2) * fs + 0.5;
          for (let br = 0; br < BRANCHES; br++) {
            const n = b.branchN[br];
            if (!n) continue;
            ctx.beginPath();
            ctx.moveTo(b.branch[(br * BRANCH_PTS) * 2] * W, b.branch[(br * BRANCH_PTS) * 2 + 1] * hy);
            for (let p = 1; p < n; p++) {
              const i2 = (br * BRANCH_PTS + p) * 2;
              ctx.lineTo(b.branch[i2] * W, b.branch[i2 + 1] * hy);
            }
            ctx.stroke();
          }
        }
      }
      // Sky flash — the whole night blinks blue-white on a strike.
      if (flash > 0.01) {
        ctx.fillStyle = `rgba(170,195,255,${flash * 0.16})`;
        ctx.fillRect(0, 0, W, H);
      }

      // ── City skyline ──────────────────────────────────────────────────
      if (scratch.city) {
        const bw = W / SKY_BINS;
        const maxH = hy * 0.30;
        ctx.fillStyle = '#0a1020';
        for (let i = 0; i < SKY_BINS; i++) {
          const bh = skyline[i] * maxH;
          ctx.fillRect(i * bw, hy - bh, bw + 0.5, bh);
        }
        ctx.fillStyle = 'rgba(150,180,255,0.5)';
        for (let i = 0; i < SKY_BINS; i++) {
          ctx.fillRect(i * bw, hy - skyline[i] * maxH, bw + 0.5, 1.5 * fs + 0.5);
        }
        // Aircraft-warning beacons on every 7th tower — tiny red pulses.
        ctx.fillStyle = `rgba(255,43,51,${0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.1))})`;
        for (let i = 3; i < SKY_BINS; i += 7) {
          const y = hy - skyline[i] * maxH - 3 * fs;
          ctx.fillRect(i * bw + bw * 0.4, y, Math.max(1.5, 2.5 * fs), Math.max(1.5, 2.5 * fs));
        }
      }

      // Horizon haze — a thin cold band so road and sky knit together.
      ctx.fillStyle = 'rgba(120,150,220,0.10)';
      ctx.fillRect(0, hy - 2 * fs, W, 5 * fs);

      // ── Road ──────────────────────────────────────────────────────────
      // Asphalt as one filled polygon; edges + dashes projected onto it.
      const STEPS = 24;
      ctx.fillStyle = SHOULDER;
      ctx.fillRect(0, hy, W, H - hy);
      ctx.fillStyle = ROAD;
      ctx.beginPath();
      for (let s = 0; s <= STEPS; s++) {
        const p = s / STEPS, y = hy + p * (H - hy);
        const x = roadCx(p) - roadHalf(p);
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let s = STEPS; s >= 0; s--) {
        const p = s / STEPS, y = hy + p * (H - hy);
        ctx.lineTo(roadCx(p) + roadHalf(p), y);
      }
      ctx.closePath();
      ctx.fill();

      // Road glow — bass warms the asphalt red from below.
      const roadGlow = (scratch.bass * 0.5 + scratch.beatPulse * 0.25) * glow;
      if (roadGlow > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(200,20,30,${roadGlow * 0.10})`;
        ctx.beginPath();
        for (let s = 0; s <= STEPS; s++) {
          const p = s / STEPS, y = hy + p * (H - hy);
          const x = roadCx(p) - roadHalf(p);
          if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        for (let s = STEPS; s >= 0; s--) {
          const p = s / STEPS, y = hy + p * (H - hy);
          ctx.lineTo(roadCx(p) + roadHalf(p), y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }

      // Edge lines — cold white, brighter near the camera.
      for (let side = -1; side <= 1; side += 2) {
        ctx.strokeStyle = 'rgba(210,225,255,0.55)';
        ctx.lineWidth = Math.max(1, 2.2 * fs);
        ctx.beginPath();
        for (let s = 0; s <= STEPS; s++) {
          const p = s / STEPS, y = hy + p * (H - hy);
          const x = roadCx(p) + side * roadHalf(p) * 0.97;
          if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Centre dashes — projected world-space stripes scrolling past.
      ctx.fillStyle = 'rgba(235,242,255,0.8)';
      const DASHES = 9;
      const dashFrac = (dist * 0.5) % (1 / DASHES);
      for (let i = 0; i < DASHES; i++) {
        // World z of this dash — decreasing with travelled distance, so the
        // stripes march toward the camera.
        const z = ((i / DASHES) - dashFrac + 1) % 1;
        const p = 1 - z;                          // z=0 near → p=1 bottom
        if (p < 0.06) continue;
        const y0 = hy + p * p * (H - hy);
        const y1 = hy + Math.min(1, (p + 0.035 * p)) ** 2 * (H - hy);
        const pj0 = p * p, pj1 = Math.min(1, p + 0.035 * p) ** 2;
        const w0 = Math.max(1, roadHalf(pj0) * 0.035);
        ctx.beginPath();
        ctx.moveTo(roadCx(pj0) - w0, y0);
        ctx.lineTo(roadCx(pj0) + w0, y0);
        ctx.lineTo(roadCx(pj1) + Math.max(1, roadHalf(pj1) * 0.035), y1);
        ctx.lineTo(roadCx(pj1) - Math.max(1, roadHalf(pj1) * 0.035), y1);
        ctx.closePath();
        ctx.fill();
      }

      // ── Streetlights — sodium heads strobing past on both shoulders ───
      for (let i = 0; i < NUM_LIGHTS; i++) {
        // March each pole toward the camera with travelled distance.
        const z = (i * LIGHT_SPACING + (1 - (dist * 0.35) % LIGHT_SPACING)) % (NUM_LIGHTS * LIGHT_SPACING);
        const p = 1 - z / (NUM_LIGHTS * LIGHT_SPACING);
        if (p < 0.02 || p > 0.99) continue;
        const pj = p * p;
        const y = hy + pj * (H - hy);
        const scale = 0.2 + pj * 1.3;
        const poleH = H * 0.16 * scale;
        const sparkle = 0.75 + scratch.highs * 0.5;
        for (let side = -1; side <= 1; side += 2) {
          const x = roadCx(pj) + side * roadHalf(pj) * 1.22;
          ctx.strokeStyle = 'rgba(90,105,140,0.5)';
          ctx.lineWidth = Math.max(1, 2.5 * fs * scale);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - poleH); ctx.stroke();
          // Head + a tight sodium halo.
          const hxp = x - side * poleH * 0.16;
          const hyp = y - poleH;
          const hr = poleH * 0.22;
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = Math.min(1, 0.55 * sparkle);
          ctx.drawImage(glowAmber, hxp - hr, hyp - hr, hr * 2, hr * 2);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          // Wet-road reflection streak below the head.
          ctx.fillStyle = `rgba(255,215,160,${0.10 * sparkle * (0.4 + scratch.rainAmt)})`;
          ctx.fillRect(hxp - 1.5 * fs * scale, y, 3 * fs * scale, poleH * 0.5);
        }
      }

      // ── The car ───────────────────────────────────────────────────────
      const pcx = roadCx(0.94) + laneX * roadHalf(0.94) * 0.55;
      const pyBottom = H * 0.90;
      const carW = Math.min(W, H) * 0.30;
      if (car) {
        const carH = carW * (car.height / car.width);
        const x = pcx - carW / 2 + bank * carW * 0.04;
        const y = pyBottom - carH;
        // Ground shadow, then the sprite, banked a few degrees into the turn.
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath();
        ctx.ellipse(pcx, pyBottom - carH * 0.02, carW * 0.46, carH * 0.09, 0, 0, TAU);
        ctx.fill();
        ctx.save();
        ctx.translate(x + carW / 2, y + carH);
        ctx.rotate(bank * 0.05);
        ctx.drawImage(car, -carW / 2, -carH, carW, carH);
        ctx.restore();
        // Tail lights — the heart of the shot. Bass bloom + brake flash.
        const tlA = Math.min(1, (0.45 + scratch.bass * 0.55 + scratch.brake * 0.5) * glow);
        const tlR = carW * (0.10 + scratch.brake * 0.05) * (0.7 + glow * 0.3);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = tlA;
        for (let s = -1; s <= 1; s += 2) {
          const lx = pcx + s * carW * 0.30 + bank * carW * 0.04;
          const ly = y + carH * 0.52;
          ctx.drawImage(glowRed, lx - tlR * 2.4, ly - tlR * 2.4, tlR * 4.8, tlR * 4.8);
        }
        ctx.globalAlpha = 1;
        // Red reflection smeared down the wet road beneath the car.
        const rg = ctx.createLinearGradient(0, pyBottom, 0, Math.min(H, pyBottom + carH * 1.4));
        rg.addColorStop(0, `rgba(255,40,45,${0.22 * tlA * (0.4 + scratch.rainAmt)})`);
        rg.addColorStop(1, 'rgba(255,40,45,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(pcx - carW * 0.42, pyBottom, carW * 0.84, carH * 1.4);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        // Sprite missing — a clean silhouette with the two red lights so
        // the tribute still reads.
        const carH = carW * 0.38;
        ctx.fillStyle = '#12060a';
        ctx.fillRect(pcx - carW / 2, pyBottom - carH, carW, carH);
        ctx.fillStyle = `rgba(255,50,45,${0.6 + scratch.brake * 0.4})`;
        ctx.fillRect(pcx - carW * 0.38, pyBottom - carH * 0.55, carW * 0.18, carH * 0.14);
        ctx.fillRect(pcx + carW * 0.20, pyBottom - carH * 0.55, carW * 0.18, carH * 0.14);
      }

      // ── Rain — cold streaks over everything but the vignette ──────────
      if (scratch.rainAmt > 0.01) {
        ctx.strokeStyle = `rgba(170,190,230,${0.12 + scratch.highs * 0.10})`;
        ctx.lineWidth = Math.max(1, fs);
        ctx.beginPath();
        const shear = W * 0.01 * (1 + scratch.speed * 0.4);
        const n = (NUM_RAIN * scratch.rainAmt) | 0;
        for (let i = 0; i < n; i++) {
          const z = rain[i * 4 + 2];
          const x = rain[i * 4] * W, y = rain[i * 4 + 1] * H;
          const len = H * 0.02 * z * (1 + scratch.speed * 0.25);
          ctx.moveTo(x, y);
          ctx.lineTo(x - shear * z, y + len);
        }
        ctx.stroke();
      }

      // Vignette — pull the edges down into the night.
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; rebuildGradients(); },
      update,
      render,
      dispose() { /* typed arrays + canvases — GC handles it */ },
    };
  },
};
