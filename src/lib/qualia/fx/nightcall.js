// Nightcall — homage to Vincent Belorgey (Kavinsky). The premise of the
// song as a quale, in two modes that auto-phase walks like chapters:
//
//   highway    — rear view: the red Testarossa (the outrun arcade sprite)
//                cruising a rain-slick night highway toward a spectrum-driven
//                city skyline, sodium streetlights strobing past.
//   testarossa — side view: a procedural vector illustration of the legend
//                itself driving through the night — popped headlight beam,
//                the signature side strakes, spinning five-hole rims, the
//                full-width tail light dragging a red trail. 1986 forever.
//
// Both modes share the storm sky: beat-driven branching lightning + sky
// flash. Red / white / blue-black only; the palette IS the tribute.
//
// Audio map:
//   bass        -> tail-light bloom, road glow, cruise speed
//   mids        -> dash scroll surge
//   highs       -> star twinkle, rain shimmer, streetlight sparkle
//   beat.pulse  -> lightning strikes + sky flash, brake flash, beam flare
//   spectrum    -> city skyline silhouette
//
// Pose map:
//   head.x      -> lane drift (highway) / car drift (testarossa)
//
// Idle (no audio): the car cruises, dashes scroll, ambient lightning on a
// slow random timer. The night doesn't stop.

import { scaleAudio } from '../field.js';
import { lmToCanvas } from '../video.js';
import { keyOutBackground } from './arcade/engine.js';

const CAR_URL = '/arcade/outrun_ferrari.png';
const TAU = Math.PI * 2;

const HORIZON = 0.44;            // highway horizon as a fraction of H
const NUM_STARS = 110;
const NUM_RAIN = 150;
const SKY_BINS = 48;             // skyline spectrum bins
const MAX_BOLTS = 3;
const TRUNK_PTS = 16;            // points per lightning trunk
const BRANCHES = 3;              // branches per bolt
const BRANCH_PTS = 7;            // points per branch
const LIGHT_SPACING = 0.16;      // highway streetlight spacing (depth units)
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
    { id: 'mode', label: 'mode', type: 'select',
      options: ['highway', 'testarossa'], default: 'highway' },
    { id: 'speed', label: 'speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total', mode: 'mul', amount: 0.35 },
      ] },
    // Storm — lightning frequency + brightness. Strikes land on kicks when
    // audio is live; on an ambient timer when it isn't.
    { id: 'storm', label: 'storm', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    // Glow — the red bloom budget (tail lights, reflections, beams).
    { id: 'glow', label: 'glow', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass', mode: 'add', amount: 0.40 },
      ] },
    { id: 'city', label: 'city', type: 'toggle', default: true },
    { id: 'rain', label: 'rain', type: 'range', min: 0, max: 1, step: 0.02, default: 0.6 },
    { id: 'poseInfluence', label: 'pose influence', type: 'range', min: 0, max: 1, step: 0.02, default: 0.5 },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Chapters: highway cruise → highway storm → the legend side-on →
  // the legend in the full storm.
  autoPhase: {
    steps: [
      { mode: 'highway',    storm: 0.25, rain: 0.25, speed: 1.4 },
      { mode: 'highway',    storm: 1.0,  rain: 0.6,  speed: 1.0 },
      { mode: 'testarossa', storm: 1.0,  rain: 0.5,  speed: 1.0 },
      { mode: 'testarossa', storm: 1.8,  rain: 0.9,  glow: 1.4 },
    ],
  },

  presets: {
    default:    { mode: 'highway', speed: 1.0, storm: 1.0, glow: 1.0, city: true,
                  rain: 0.6, poseInfluence: 0.5, reactivity: 1.0 },
    cruise:     { mode: 'highway', speed: 1.5, storm: 0.25, rain: 0.25 },
    storm:      { mode: 'highway', storm: 1.8, rain: 0.9, glow: 1.3 },
    testarossa: { mode: 'testarossa', storm: 1.0, rain: 0.5 },
    legend:     { mode: 'testarossa', storm: 1.8, rain: 0.9, glow: 1.5 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const car = await loadCar();
    const glowRed = bakeGlow('rgba(255,64,52,1)', 'rgba(214,16,32,0.55)');
    const glowAmber = bakeGlow('rgba(255,228,185,1)', 'rgba(255,195,125,0.40)');
    const glowCold = bakeGlow('rgba(215,228,255,1)', 'rgba(160,185,255,0.40)');

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
    let skyGrad = null, skyGradTall = null, vignette = null, paintGrad = null;
    function rebuildGradients() {
      const hy = H * HORIZON;
      skyGrad = ctx.createLinearGradient(0, 0, 0, hy);
      skyGrad.addColorStop(0, SKY_TOP);
      skyGrad.addColorStop(1, SKY_HORIZON);
      // Side-view sky reaches further down.
      skyGradTall = ctx.createLinearGradient(0, 0, 0, H * 0.70);
      skyGradTall.addColorStop(0, SKY_TOP);
      skyGradTall.addColorStop(1, SKY_HORIZON);
      vignette = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.45,
                                          W / 2, H * 0.55, Math.max(W, H) * 0.75);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(2,3,8,0.55)');
      paintGrad = null;   // depends on car length — lazily rebuilt in drawTestarossa
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
    let wheelA = 0;          // side-view wheel rotation (rad)

    const scratch = {
      time: 0, dt: 0, speed: 1,
      bass: 0, mids: 0, highs: 0, total: 0, beatPulse: 0, rms: 0,
      audioOn: false, brake: 0,
      mode: 'highway', storm: 1, glow: 1, rainAmt: 0.6, city: true,
    };

    function update(field) {
      const params = field.params;
      const audio = scaleAudio(field.audio, params.reactivity);
      const dt = field.dt;
      const audioOn = !!audio.spectrum;
      const mode = params.mode === 'testarossa' ? 'testarossa' : 'highway';

      // Cruise speed — the resolved speed param already carries audio.total.
      const spd = params.speed * (0.65 + audio.bands.bass * 0.4 + audio.bands.mids * 0.25);
      dist += dt * spd * 1.7;
      wheelA -= dt * spd * 9;               // side view faces left → rolls CCW

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
      scratch.mode = mode;
      scratch.storm = storm;
      scratch.glow = params.glow;
      scratch.rainAmt = rainAmt;
      scratch.city = !!params.city;
    }

    // Road-space helpers — p in [0..1], 0 at the horizon, 1 at the bottom.
    function roadCx(p) { return W * 0.5 + curve * (1 - p) * (1 - p) * W * 0.55; }
    function roadHalf(p) { return W * 0.02 + p * p * W * 0.42; }

    // ── Shared sky: stars + lightning + flash, down to skyBottom px ─────
    function drawStars(skyBottom, fs, t) {
      const twAmp = 0.5 + scratch.highs * 0.5;
      ctx.fillStyle = '#dfe8ff';
      for (let i = 0; i < NUM_STARS; i++) {
        const tw = 0.5 + 0.5 * Math.sin(t * 1.6 + stars[i * 3 + 2]);
        ctx.globalAlpha = 0.05 + 0.22 * tw * twAmp;
        ctx.fillRect(stars[i * 3] * W, stars[i * 3 + 1] * skyBottom, 1.5 * fs + 1, 1.5 * fs + 1);
      }
      ctx.globalAlpha = 1;
    }

    function drawLightning(skyBottom, fs, t) {
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
          ctx.moveTo(b.trunk[0] * W, b.trunk[1] * skyBottom);
          for (let p = 1; p < TRUNK_PTS; p++) {
            ctx.lineTo(b.trunk[p * 2] * W, b.trunk[p * 2 + 1] * skyBottom);
          }
          ctx.stroke();
          ctx.lineWidth = (pass === 0 ? 4 : 1.2) * fs + 0.5;
          for (let br = 0; br < BRANCHES; br++) {
            const n = b.branchN[br];
            if (!n) continue;
            ctx.beginPath();
            ctx.moveTo(b.branch[(br * BRANCH_PTS) * 2] * W, b.branch[(br * BRANCH_PTS) * 2 + 1] * skyBottom);
            for (let p = 1; p < n; p++) {
              const i2 = (br * BRANCH_PTS + p) * 2;
              ctx.lineTo(b.branch[i2] * W, b.branch[i2 + 1] * skyBottom);
            }
            ctx.stroke();
          }
        }
      }
      if (flash > 0.01) {
        ctx.fillStyle = `rgba(170,195,255,${flash * 0.16})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    function drawRain(fs) {
      if (scratch.rainAmt <= 0.01) return;
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

    // ── Highway mode (rear view) ────────────────────────────────────────
    function renderHighway() {
      const t = scratch.time;
      const hy = H * HORIZON;
      const fs = Math.min(W, H) / 1080;
      const glow = scratch.glow;

      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, hy);
      ctx.fillStyle = ROAD;
      ctx.fillRect(0, hy, W, H - hy);

      drawStars(hy, fs, t);
      drawLightning(hy, fs, t);

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
    }

    // ── Testarossa mode (side view) ─────────────────────────────────────
    // A vector illustration of the car itself, drawn with paths in
    // car-space: u along the length (0 = nose, facing LEFT, 1 = tail),
    // v up from the ground, both as fractions of the car's length.
    // Upper silhouette, nose → tail, dense enough that the lineTo chain
    // reads as curves at screen scale. Real-profile proportions: wheel
    // diameter ≈ 0.145 of the length, roof at ≈ 0.235, wedge nose.
    const CAR_BODY = [
      [0.000, 0.068], [0.000, 0.098], [0.030, 0.110],
      [0.082, 0.120],                       // hood over the front arch
      [0.160, 0.130], [0.300, 0.148],       // hood rise to windshield base
      [0.325, 0.155], [0.360, 0.185],       // windshield, raked in two steps
      [0.405, 0.220], [0.440, 0.231],
      [0.530, 0.236], [0.600, 0.230],       // low roof
      [0.650, 0.215], [0.720, 0.192],       // flying-buttress slope
      [0.820, 0.166],
      [0.985, 0.156], [1.000, 0.153],       // rear deck → kamm tail top
      [1.000, 0.060], [0.980, 0.040],       // tail face → rear valance
    ];
    const FRONT_WHEEL = { u: 0.185, r: 0.066 };
    const REAR_WHEEL = { u: 0.775, r: 0.066 };

    function drawWheel(cx, cy, R, L, fs) {
      // Tire.
      ctx.fillStyle = '#080a12';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#1e2436';
      ctx.lineWidth = Math.max(1, 1.5 * fs);
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.98, 0, TAU); ctx.stroke();
      // Rim — the five-hole Testarossa wheel, rotating.
      const rimR = R * 0.60;
      ctx.fillStyle = '#c7cfe2';
      ctx.beginPath(); ctx.arc(cx, cy, rimR, 0, TAU); ctx.fill();
      ctx.fillStyle = '#39415c';
      for (let k = 0; k < 5; k++) {
        const a = wheelA + k * (TAU / 5);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * rimR * 0.55, cy + Math.sin(a) * rimR * 0.55, rimR * 0.20, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#8a93ac';
      ctx.beginPath(); ctx.arc(cx, cy, rimR * 0.16, 0, TAU); ctx.fill();
    }

    function drawTestarossa(carX, groundY, L, fs) {
      const glow = scratch.glow;
      const t = scratch.time;
      // Suspension: a soft cruise bob + a bass squat.
      const bob = Math.sin(t * 2.3) * 1.6 * fs + scratch.bass * 4 * fs;
      const pitch = -scratch.beatPulse * 0.008;
      const X = (u) => (u - 0.48) * L;
      const Y = (v) => -v * L;

      ctx.save();
      ctx.translate(carX, groundY - bob);
      ctx.rotate(pitch);

      // Ground shadow (drawn unrotated enough at this pitch).
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.ellipse(X(0.5), 2 * fs + bob, L * 0.5, L * 0.035, 0, 0, TAU);
      ctx.fill();

      // Body paint — vertical red gradient, cached against L.
      if (!paintGrad || paintGrad._L !== L) {
        paintGrad = ctx.createLinearGradient(0, Y(0.26), 0, Y(0.02));
        paintGrad.addColorStop(0, '#ff4550');
        paintGrad.addColorStop(0.45, '#d21426');
        paintGrad.addColorStop(1, '#6f0913');
        paintGrad._L = L;
      }
      ctx.fillStyle = paintGrad;
      ctx.beginPath();
      ctx.moveTo(X(0.025), Y(0.042));
      for (const [u, v] of CAR_BODY) ctx.lineTo(X(u), Y(v));
      ctx.closePath();
      ctx.fill();

      // Punch the wheel arches out of the body.
      ctx.fillStyle = SKY_HORIZON;
      for (const w of [FRONT_WHEEL, REAR_WHEEL]) {
        ctx.beginPath();
        ctx.arc(X(w.u), Y(0.066), w.r * 1.12 * L, 0, TAU);
        ctx.fill();
      }
      // Rocker shadow — a thin dark strip low on the body between arches.
      ctx.fillStyle = '#4a0810';
      ctx.fillRect(X(0.290), Y(0.052), X(0.665) - X(0.290), 0.014 * L);

      // Glasshouse — windshield + door glass in night blue.
      ctx.fillStyle = '#0a0f22';
      ctx.beginPath();
      ctx.moveTo(X(0.338), Y(0.152));
      ctx.lineTo(X(0.418), Y(0.216));
      ctx.lineTo(X(0.445), Y(0.224));
      ctx.lineTo(X(0.540), Y(0.228));
      ctx.lineTo(X(0.612), Y(0.221));
      ctx.lineTo(X(0.648), Y(0.155));
      ctx.closePath();
      ctx.fill();
      // A-pillar sweep highlight on the glass.
      ctx.strokeStyle = 'rgba(190,210,255,0.35)';
      ctx.lineWidth = Math.max(1, 1.2 * fs);
      ctx.beginPath();
      ctx.moveTo(X(0.350), Y(0.158));
      ctx.lineTo(X(0.428), Y(0.216));
      ctx.stroke();
      // B-pillar split.
      ctx.strokeStyle = '#20060c';
      ctx.beginPath();
      ctx.moveTo(X(0.552), Y(0.228)); ctx.lineTo(X(0.562), Y(0.155));
      ctx.stroke();

      // THE strakes — the side louvres raking into the rear intake.
      ctx.strokeStyle = '#55070f';
      ctx.lineWidth = Math.max(1, L * 0.006);
      for (let i = 0; i < 5; i++) {
        const v = 0.055 + i * 0.015;
        ctx.beginPath();
        ctx.moveTo(X(0.445 + i * 0.010), Y(v));
        ctx.lineTo(X(0.700), Y(v + 0.004));
        ctx.stroke();
      }
      // Door seams + handle.
      ctx.strokeStyle = 'rgba(40,4,10,0.8)';
      ctx.lineWidth = Math.max(1, fs);
      ctx.beginPath(); ctx.moveTo(X(0.418), Y(0.150)); ctx.lineTo(X(0.408), Y(0.055)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(0.664), Y(0.152)); ctx.lineTo(X(0.700), Y(0.060)); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,220,220,0.4)';
      ctx.beginPath(); ctx.moveTo(X(0.600), Y(0.146)); ctx.lineTo(X(0.638), Y(0.146)); ctx.stroke();

      // Beltline specular — the long white streak that sells the paint.
      ctx.strokeStyle = 'rgba(255,235,235,0.5)';
      ctx.lineWidth = Math.max(1, 1.6 * fs);
      ctx.beginPath();
      ctx.moveTo(X(0.030), Y(0.116));
      ctx.quadraticCurveTo(X(0.30), Y(0.152), X(0.42), Y(0.154));
      ctx.moveTo(X(0.66), Y(0.156));
      ctx.lineTo(X(0.982), Y(0.158));
      ctx.stroke();
      // Moon rim light along the roof.
      ctx.strokeStyle = 'rgba(190,210,255,0.45)';
      ctx.lineWidth = Math.max(1, 1.4 * fs);
      ctx.beginPath();
      ctx.moveTo(X(0.30), Y(0.148));
      ctx.lineTo(X(0.405), Y(0.220));
      ctx.quadraticCurveTo(X(0.53), Y(0.243), X(0.65), Y(0.213));
      ctx.lineTo(X(0.82), Y(0.168));
      ctx.stroke();

      // Side mirror.
      ctx.fillStyle = '#8f1018';
      ctx.fillRect(X(0.318), Y(0.190), L * 0.024, L * 0.018);
      ctx.strokeStyle = '#30050b';
      ctx.beginPath(); ctx.moveTo(X(0.326), Y(0.172)); ctx.lineTo(X(0.329), Y(0.154)); ctx.stroke();

      // Pop-up headlight, up for the night — pod + white lamp face.
      ctx.fillStyle = '#b0121f';
      ctx.beginPath();
      ctx.moveTo(X(0.085), Y(0.118));
      ctx.lineTo(X(0.090), Y(0.148));
      ctx.lineTo(X(0.150), Y(0.143));
      ctx.lineTo(X(0.152), Y(0.124));
      ctx.closePath();
      ctx.fill();
      const beam = Math.min(1, 0.55 + scratch.beatPulse * 0.45) * glow;
      ctx.fillStyle = `rgba(235,242,255,${0.85 * Math.min(1, beam + 0.3)})`;
      ctx.fillRect(X(0.086), Y(0.146), L * 0.011, L * 0.024);

      // Front amber marker + tail-light strip.
      ctx.fillStyle = '#ffb43a';
      ctx.fillRect(X(0.004), Y(0.080), L * 0.014, L * 0.015);
      ctx.fillStyle = '#ff2030';
      ctx.fillRect(X(0.986), Y(0.120), L * 0.016, L * 0.056);

      ctx.restore();

      // Lights in world space (unrotated — the pitch is tiny).
      const tailX = carX + X(1.0), tailY = groundY - bob - 0.095 * L;
      const lampX = carX + X(0.083), lampY = groundY - bob - 0.138 * L;

      ctx.globalCompositeOperation = 'lighter';
      // Headlight beam — a long cold cone toward the left edge.
      const beamA = (0.10 + scratch.beatPulse * 0.08 + 0.02 * Math.sin(t * 31)) * glow;
      ctx.fillStyle = `rgba(210,225,255,${Math.max(0, beamA)})`;
      ctx.beginPath();
      ctx.moveTo(lampX, lampY - 0.012 * L);
      ctx.lineTo(-W * 0.02, lampY - 0.055 * L);
      ctx.lineTo(-W * 0.02, lampY + 0.10 * L);
      ctx.lineTo(lampX, lampY + 0.016 * L);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = Math.min(1, 0.8 * glow);
      ctx.drawImage(glowCold, lampX - 0.05 * L, lampY - 0.05 * L, 0.1 * L, 0.1 * L);

      // Tail light bloom + the red trail dragged behind the car.
      const tlA = Math.min(1, (0.5 + scratch.bass * 0.5 + scratch.brake * 0.4) * glow);
      ctx.globalAlpha = tlA;
      ctx.drawImage(glowRed, tailX - 0.09 * L, tailY - 0.09 * L, 0.18 * L, 0.18 * L);
      const trailLen = L * (0.35 + scratch.bass * 0.55 + scratch.speed * 0.12);
      ctx.globalAlpha = tlA * 0.8;
      ctx.drawImage(glowRed, tailX - 0.02 * L, tailY - 0.028 * L, trailLen, 0.056 * L);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // Wheels last, over the punched arches.
      const fy = groundY - bob - 0.066 * L;
      drawWheel(carX + X(FRONT_WHEEL.u), fy, FRONT_WHEEL.r * L, L, fs);
      drawWheel(carX + X(REAR_WHEEL.u), fy, REAR_WHEEL.r * L, L, fs);
    }

    function renderTestarossa() {
      const t = scratch.time;
      const fs = Math.min(W, H) / 1080;
      const horizonY = H * 0.70;
      const groundY = H * 0.80;
      const glow = scratch.glow;

      // Sky down to the horizon band, asphalt below.
      ctx.fillStyle = skyGradTall;
      ctx.fillRect(0, 0, W, horizonY);
      ctx.fillStyle = SHOULDER;
      ctx.fillRect(0, horizonY, W, H - horizonY);

      drawStars(horizonY, fs, t);

      // Low moon — cold and huge behind the skyline.
      const mx = W * 0.76, my = H * 0.22, mr = Math.min(W, H) * 0.065;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55;
      ctx.drawImage(glowCold, mx - mr * 3, my - mr * 3, mr * 6, mr * 6);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#dfe8fa';
      ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(178,192,220,0.5)';
      ctx.beginPath(); ctx.arc(mx - mr * 0.3, my - mr * 0.15, mr * 0.16, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(mx + mr * 0.25, my + mr * 0.3, mr * 0.11, 0, TAU); ctx.fill();

      drawLightning(horizonY, fs, t);

      // Scrolling city skyline — same spectrum bins, sliding by as we
      // drive (the car faces left, so the world slides right).
      if (scratch.city) {
        const bw = W / (SKY_BINS - 8);
        const maxH = H * 0.16;
        const off = dist * 1.4;
        ctx.fillStyle = '#0a1020';
        for (let i = 0; i < SKY_BINS + 2; i++) {
          const bin = ((i + Math.floor(off / bw)) % SKY_BINS + SKY_BINS) % SKY_BINS;
          const x = i * bw - (off % bw);
          if (x > W) break;
          const bh = skyline[bin] * maxH;
          ctx.fillRect(x, horizonY - bh, bw + 0.5, bh);
        }
        ctx.fillStyle = 'rgba(150,180,255,0.45)';
        for (let i = 0; i < SKY_BINS + 2; i++) {
          const bin = ((i + Math.floor(off / bw)) % SKY_BINS + SKY_BINS) % SKY_BINS;
          const x = i * bw - (off % bw);
          if (x > W) break;
          ctx.fillRect(x, horizonY - skyline[bin] * maxH, bw + 0.5, 1.5 * fs + 0.5);
        }
      }

      // Road band — a lighter lane the car rides, kerb line, dashes.
      ctx.fillStyle = ROAD;
      ctx.fillRect(0, groundY - H * 0.006, W, H * 0.14);
      ctx.fillStyle = 'rgba(210,225,255,0.5)';
      ctx.fillRect(0, horizonY, W, Math.max(1, 1.6 * fs));
      // Dashes slide right as the car drives left.
      const dashW = W * 0.07, gap = W * 0.115;
      const dx = (dist * W * 0.22) % gap;
      ctx.fillStyle = 'rgba(235,242,255,0.7)';
      for (let x = -gap + dx; x < W + gap; x += gap) {
        ctx.fillRect(x, groundY + H * 0.085, dashW, Math.max(1.5, 2.6 * fs));
      }

      // Streetlights sliding by — bases behind the car's lane.
      const poleGap = W * 0.42;
      const px0 = -((dist * W * 0.22) % poleGap);
      const sparkle = 0.75 + scratch.highs * 0.5;
      for (let x = px0; x < W + poleGap; x += poleGap) {
        const poleTop = H * 0.36;
        ctx.strokeStyle = 'rgba(90,105,140,0.55)';
        ctx.lineWidth = Math.max(1.5, 3 * fs);
        ctx.beginPath();
        ctx.moveTo(x, groundY + H * 0.01);
        ctx.lineTo(x, poleTop);
        ctx.stroke();
        // Arm reaching over the road (toward the left / direction of travel).
        ctx.beginPath();
        ctx.moveTo(x, poleTop);
        ctx.quadraticCurveTo(x - W * 0.035, poleTop, x - W * 0.05, poleTop + H * 0.012);
        ctx.stroke();
        const hx = x - W * 0.05, hyp = poleTop + H * 0.016;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, 0.6 * sparkle);
        const hr = H * 0.05;
        ctx.drawImage(glowAmber, hx - hr, hyp - hr, hr * 2, hr * 2);
        // Light pool on the road under the head.
        ctx.globalAlpha = 0.10 * sparkle * (0.5 + scratch.rainAmt);
        ctx.drawImage(glowAmber, hx - W * 0.06, groundY - H * 0.015, W * 0.12, H * 0.05);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      // The legend — big, centre-left, drifting with the lean.
      const L = Math.min(W * 0.52, H * 0.78);
      const carX = W * (0.46 + laneX * 0.05);
      drawTestarossa(carX, groundY, L, fs);

      // Wet-road reflection — a soft red pool beneath the car.
      const tlA = Math.min(1, (0.5 + scratch.bass * 0.5) * glow) * (0.35 + scratch.rainAmt * 0.5);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = tlA * 0.5;
      ctx.drawImage(glowRed, carX + L * 0.38, groundY - L * 0.02, L * 0.3, L * 0.10);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function render() {
      if (scratch.mode === 'testarossa') renderTestarossa();
      else renderHighway();

      drawRain(Math.min(W, H) / 1080);

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
