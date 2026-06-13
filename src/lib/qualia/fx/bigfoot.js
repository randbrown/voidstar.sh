// Bigfoot — "Ramblin' Visioneer". A procedurally-animated Sasquatch walks in
// profile across a van-Gogh-swirl cosmos. The body is a furry silhouette used
// as a clip mask: inside it we paint deep space — nebulae + a drifting
// starfield — so the creature reads as a walking window onto the void. Two
// glowing eyes ride the head; a soft aura haloes the whole figure.
//
// The gait is the point. It's tuned for a heavy quadruped-grade biped saunter:
//   - long stride + bent-knee "compliant" legs (the classic sasquatch glide)
//   - high stance duty (62%) so each foot plants with weight
//   - a forward lean that deepens at push-off — the "almost-lunge" — eased so
//     it stays graceful and intentional rather than a stumble
//   - big counter-swinging long arms with a touch of follow-through lag (swag)
//   - a slow two-per-cycle pelvis bob, exaggerated by `swagger`
// Legs are placed with 2-bone IK against a fixed ground so contact looks real;
// arms run on forward kinematics.
//
// Audio map:
//   bands.bass   → stride length + lunge depth + bob amplitude  (the stomp)
//   bands.mids   → nebula brightness inside the body
//   bands.highs  → starfield twinkle
//   beat.pulse   → eye flare + aura swell + a forward lunge thrust
//   rms          → background swirl intensity
//
// Pose map (optional, poseBind):
//   shoulderSpan → figure scale (lean in → he looms larger)
//   head.x       → which way he faces / roams

import { scaleAudio } from '../field.js';

const PI  = Math.PI;
const TAU = PI * 2;

// Background swirl eddies — fixed normalized homes, van-Gogh logarithmic
// spirals that rotate slowly. Stable across resizes (no reseed per frame).
const NUM_EDDIES = 7;
const EDDY_SEGS  = 46;
// Background drifting stars (behind the figure).
const NUM_BG_STARS = 220;
// Cosmos stars living INSIDE the body silhouette.
const MAX_BODY_STARS = 320;

// Palettes — every role the renderer needs, as [r,g,b] triplets.
//   bg      page wash (kept dark)
//   swirlA/B  two swirl inks (complementary, like the teal/amber reference)
//   nebA/B/C  three nebula glows painted inside the body
//   star    body + bg star colour
//   eye     glowing eye colour
//   aura    silhouette halo
const PALETTES = {
  cosmic: { bg: [7, 11, 18],  swirlA: [70, 150, 150], swirlB: [205, 115, 45],
            nebA: [70, 135, 160], nebB: [150, 90, 185], nebC: [205, 120, 55],
            star: [222, 236, 246], eye: [150, 232, 255], aura: [95, 185, 205] },
  aurora: { bg: [5, 14, 14],  swirlA: [60, 200, 150], swirlB: [120, 110, 220],
            nebA: [60, 190, 140], nebB: [90, 120, 220], nebC: [190, 100, 200],
            star: [225, 245, 240], eye: [170, 255, 220], aura: [90, 220, 170] },
  ember:  { bg: [16, 8, 6],   swirlA: [220, 120, 40],  swirlB: [180, 50, 60],
            nebA: [215, 120, 45], nebB: [200, 60, 50],  nebC: [240, 195, 90],
            star: [250, 235, 205], eye: [255, 210, 130], aura: [230, 130, 60] },
  mono:   { bg: [8, 10, 14],  swirlA: [120, 140, 165], swirlB: [80, 95, 120],
            nebA: [110, 130, 160], nebB: [80, 100, 130], nebC: [150, 165, 195],
            star: [235, 240, 248], eye: [190, 220, 255], aura: [120, 150, 190] },
};

function hash(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'bigfoot',
  name: 'Bigfoot',
  contextType: 'canvas2d',

  params: [
    { id: 'speed',   label: 'cadence', type: 'range', min: 0,    max: 3,   step: 0.05, default: 1.0 },
    { id: 'stride',  label: 'stride',  type: 'range', min: 0.4,  max: 1.8, step: 0.05, default: 1.0,
      modulators: [{ source: 'audio.bass', mode: 'add', amount: 0.35 }] },
    { id: 'swagger', label: 'swagger', type: 'range', min: 0,    max: 2,   step: 0.05, default: 1.0 },
    { id: 'lunge',   label: 'lunge',   type: 'range', min: 0,    max: 2,   step: 0.05, default: 1.0,
      modulators: [{ source: 'audio.beatPulse', mode: 'add', amount: 0.5 }] },
    { id: 'scale',   label: 'scale',   type: 'range', min: 0.35, max: 0.95,step: 0.01, default: 0.62 },
    { id: 'starDensity', label: 'stars', type: 'range', min: 0.2, max: 2, step: 0.05, default: 1.0 },
    { id: 'nebula',  label: 'nebula',  type: 'range', min: 0,    max: 2,   step: 0.05, default: 1.0,
      modulators: [{ source: 'audio.mids', mode: 'add', amount: 0.4 }] },
    { id: 'eyeGlow', label: 'eyes',    type: 'range', min: 0,    max: 2,   step: 0.05, default: 1.0 },
    { id: 'swirl',   label: 'swirls',  type: 'range', min: 0,    max: 2,   step: 0.05, default: 1.0,
      modulators: [{ source: 'audio.rms', mode: 'add', amount: 0.5 }] },
    { id: 'roam',    label: 'roam',    type: 'toggle', default: false },
    { id: 'ground',  label: 'ground',  type: 'toggle', default: true },
    { id: 'palette', label: 'palette', type: 'select',
      options: ['cosmic', 'aurora', 'ember', 'mono'], default: 'cosmic' },
    { id: 'poseBind',label: 'pose bind', type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Phase walks the four skies + nudges his mood between graceful and stomping.
  autoPhase: {
    steps: [
      { palette: 'cosmic', lunge: 1.0, swagger: 1.0 },
      { palette: 'aurora', lunge: 0.7, swagger: 0.7 },
      { palette: 'ember',  lunge: 1.6, swagger: 1.5 },
      { palette: 'mono',   lunge: 1.0, swagger: 1.0 },
    ],
  },

  presets: {
    default: { speed: 1.0, stride: 1.0, swagger: 1.0, lunge: 1.0, scale: 0.62, starDensity: 1.0, nebula: 1.0, eyeGlow: 1.0, swirl: 1.0, roam: false, ground: true, palette: 'cosmic', poseBind: true, reactivity: 1.0 },
    swagger: { speed: 1.1, stride: 1.25, swagger: 1.7, lunge: 1.5, palette: 'cosmic' },
    serene:  { speed: 0.6, stride: 0.85, swagger: 0.5, lunge: 0.6, swirl: 0.8, palette: 'aurora' },
    stomp:   { speed: 1.3, stride: 1.4, swagger: 1.4, lunge: 1.7, nebula: 1.4, palette: 'ember' },
    parade:  { speed: 1.0, stride: 1.2, swagger: 1.2, lunge: 1.1, roam: true, palette: 'cosmic' },
    ramblin: { speed: 0.9, stride: 1.1, swagger: 1.15, lunge: 1.2, roam: true, swirl: 1.3, palette: 'cosmic' },
  },

  async create(canvas, opts) {
    const ctx = opts.ctx;
    let W = canvas.width, H = canvas.height;

    // ── Background eddies (van-Gogh swirls) ─────────────────────────────────
    const eddies = [];
    for (let i = 0; i < NUM_EDDIES; i++) {
      eddies.push({
        x:    hash(i * 3.1 + 1.7),
        y:    hash(i * 5.7 + 0.3),
        rad:  0.10 + hash(i * 2.3) * 0.18,
        turns:1.2 + hash(i * 9.1) * 1.6,
        dir:  hash(i * 4.4) < 0.5 ? 1 : -1,
        spin: (0.04 + hash(i * 6.6) * 0.10),
        phase: hash(i * 7.7) * TAU,
        ink:  hash(i * 8.8) < 0.5 ? 0 : 1,   // swirlA or swirlB
      });
    }

    // ── Background starfield (drifts left to imply travel) ──────────────────
    const bgx = new Float32Array(NUM_BG_STARS);
    const bgy = new Float32Array(NUM_BG_STARS);
    const bgs = new Float32Array(NUM_BG_STARS);
    const bgp = new Float32Array(NUM_BG_STARS);
    for (let i = 0; i < NUM_BG_STARS; i++) {
      bgx[i] = Math.random();
      bgy[i] = Math.random();
      bgs[i] = 0.4 + Math.random() * Math.random() * 2.2;
      bgp[i] = Math.random() * TAU;
    }

    // ── Body cosmos stars (normalized in the figure's local bounding box) ────
    const sx = new Float32Array(MAX_BODY_STARS);
    const sy = new Float32Array(MAX_BODY_STARS);
    const ss = new Float32Array(MAX_BODY_STARS);
    const sp = new Float32Array(MAX_BODY_STARS);
    for (let i = 0; i < MAX_BODY_STARS; i++) {
      sx[i] = Math.random();
      sy[i] = Math.random();
      ss[i] = 0.4 + Math.random() * Math.random() * 2.6;
      sp[i] = Math.random() * TAU;
    }

    // Smoothed pose-driven scale + roam drift.
    let poseScale = 0, roamX = 0, faceDir = 1;

    // Everything render() reads is staged here in update() — render() never
    // touches `field` directly.
    const scratch = {
      time: 0, dt: 0, p: 0,
      bass: 0, mids: 0, highs: 0, rms: 0, beatP: 0,
      pal: PALETTES.cosmic,
      S: 100, rootX: 0, rootY: 0, groundY: 0,
      lean: 0, faceDir: 1,
      swirl: 1, nebula: 1, eyeGlow: 1, starDensity: 1, ground: true,
      // staged joint screen positions (filled by computePose)
      joints: null,
      eyeFlare: 0,
    };

    // ── Kinematics ──────────────────────────────────────────────────────────
    // 2-bone IK in screen space. bendDir = -1 puts the knee forward (+x*face).
    function ik(hx, hy, fx, fy, a, b, bendDir) {
      let dx = fx - hx, dy = fy - hy;
      let D = Math.hypot(dx, dy);
      const maxD = a + b - 1e-3, minD = Math.abs(a - b) + 1e-3;
      if (D > maxD) D = maxD; if (D < minD) D = minD;
      const base = Math.atan2(dy, dx);
      let c = (a * a + D * D - b * b) / (2 * a * D);
      c = Math.max(-1, Math.min(1, c));
      const A = Math.acos(c);
      const ka = base + bendDir * A;
      return { x: hx + Math.cos(ka) * a, y: hy + Math.sin(ka) * a };
    }

    // Foot trajectory in local (forward, up) offsets for cycle fraction ψ.
    // High stance duty → weighty plant; eased swing → graceful recovery.
    function footOffset(psi, L, lift) {
      const STANCE = 0.62;
      if (psi < STANCE) {
        const u = psi / STANCE;                 // planted, sliding backward
        return { fx: (0.5 - u) * L, lift: 0 };
      }
      const u  = (psi - STANCE) / (1 - STANCE); // swing forward through the air
      const fx = (-0.5 + easeInOut(u)) * L;
      return { fx, lift: lift * Math.sin(PI * u) };
    }

    function computePose() {
      const S = scratch.S, face = scratch.faceDir;
      const rootX = scratch.rootX, rootY = scratch.rootY;
      const ground = scratch.groundY;
      const p = scratch.p;
      const lungeAmt = scratch.lungeAmt;

      // Stride + foot lift scale with body size + bass stomp.
      const L    = scratch.strideLen * S;
      const lift = 0.13 * S;

      // Pelvis bob — two per cycle, raised at mid-stance. Swagger deepens it.
      const bob = -scratch.bobAmt * S * Math.cos(2 * TAU * p);

      // ── Hunched, forward-driving upper body ──────────────────────────────
      // A confident lunge, not a flagpole: the spine arches forward, the
      // shoulders round over the lead leg, and the head juts AHEAD of the
      // shoulders (forward-head primate posture). Values are radians of
      // forward tilt off vertical, scaled by swagger/lunge and pulsed per step.
      const swag = scratch.swayAmt;
      const step = Math.max(0, Math.sin(2 * TAU * p));   // 0..1, peaks at push-off
      const leanLower = 0.16 + 0.06 * swag + 0.20 * lungeAmt * step + 0.12 * scratch.beatP * lungeAmt;
      const hunch     = 0.12 + 0.06 * swag + 0.14 * lungeAmt * step;
      const leanUpper = leanLower + hunch;
      const neckFwd   = 0.22 + 0.05 * swag;

      const torsoLungeShift = lungeAmt * 0.03 * S * Math.sin(2 * TAU * p);
      const hipY = rootY + bob;
      const hipX = rootX + face * torsoLungeShift;

      // Curved spine: hip → mid-back → shoulders. The upper segment bends
      // further forward than the lower, so the back bows (the hunch).
      const torsoLen = 0.36 * S;
      const lowerLen = torsoLen * 0.45, upperLen = torsoLen * 0.55;
      const lowAng = -PI / 2 + face * leanLower;
      const midX = hipX + Math.cos(lowAng) * lowerLen;
      const midY = hipY + Math.sin(lowAng) * lowerLen;
      const upAng = -PI / 2 + face * leanUpper;
      const shX = midX + Math.cos(upAng) * upperLen;
      const shY = midY + Math.sin(upAng) * upperLen;
      const torsoAng = upAng;     // arm-hang reference

      // Head leads forward: the neck angles further forward than the upper
      // spine, pushing the dome ahead of the shoulders, peering down the lunge.
      const headR = 0.145 * S;
      const neckLen = 0.10 * S;
      const neckAng = -PI / 2 + face * (leanUpper + neckFwd);
      const headCX = shX + Math.cos(neckAng) * (neckLen + headR * 0.55);
      const headCY = shY + Math.sin(neckAng) * (neckLen + headR * 0.55);
      const headTilt = face * (0.18 + leanUpper * 0.35);

      // Eyes + brow, rotated to follow the head tilt so they ride the face.
      const ct = Math.cos(headTilt), st = Math.sin(headTilt);
      const place = (fwd, up) => {
        const lx = face * fwd, ly = up;
        return { x: headCX + lx * ct - ly * st, y: headCY + lx * st + ly * ct };
      };
      const eye0 = place(headR * 0.50, -headR * 0.06);
      const eye1 = place(headR * 0.20, -headR * 0.06);
      const brow = place(headR * 0.55, -headR * 0.20);

      // ── Legs (two, π out of phase) ──────────────────────────────────────
      const a = 0.27 * S, b = 0.27 * S;
      const legs = [];
      for (let i = 0; i < 2; i++) {
        const psi = (p + i * 0.5) % 1;
        const fo = footOffset(psi, L, lift);
        const fx = hipX + face * fo.fx;
        const fy = ground - fo.lift;
        // tiny fore/aft hip split so both legs don't share one pivot
        const hx = hipX + face * (i === 0 ? 0.02 : -0.02) * S;
        // knee bends in the walk direction (forward = sign of face)
        const knee = ik(hx, hipY, fx, fy, a, b, face > 0 ? -1 : 1);
        legs.push({ hx, hy: hipY, kx: knee.x, ky: knee.y, fx, fy, psi, near: i === 0 });
      }

      // ── Arms (FK, counter-swing with follow-through lag) ─────────────────
      const ua = 0.27 * S, la = 0.25 * S;
      const arms = [];
      for (let i = 0; i < 2; i++) {
        // opposite phase to same-side leg + small lag for swagger overlap
        const ph = (p + i * 0.5 + 0.5 + 0.05) % 1;
        const swing = scratch.armSwing * Math.sin(TAU * ph);
        // shoulder points down (+PI/2) with a slight forward bias to match the
        // lunge; swing rotates toward/away from face.
        const shoAng = PI / 2 - face * (swing + 0.10);
        const sX = shX + face * (i === 0 ? 0.03 : -0.03) * S;
        const sY = shY - 0.02 * S;
        const eX = sX + Math.cos(shoAng) * ua;
        const eY = sY + Math.sin(shoAng) * ua;
        const foreAng = shoAng - face * (0.18 + 0.12 * Math.max(0, swing));
        const wX = eX + Math.cos(foreAng) * la;
        const wY = eY + Math.sin(foreAng) * la;
        arms.push({ sX, sY, eX, eY, wX, wY, near: i === 0 });
      }

      scratch.joints = {
        hipX, hipY, midX, midY, shX, shY, headCX, headCY, headR, headTilt, torsoAng,
        eyes: [eye0, eye1], browX: brow.x, browY: brow.y,
        legs, arms, face,
        // foot plant strength for contact shadows
        plant: legs.map(l => l.psi < 0.62 ? 1 : 0),
      };
    }

    function update(field) {
      const { dt, time, params, pose } = field;
      const audio = scaleAudio(field.audio, params.reactivity);

      scratch.time  = time;
      scratch.dt    = dt;
      scratch.bass  = audio.bands.bass;
      scratch.mids  = audio.bands.mids;
      scratch.highs = audio.bands.highs;
      scratch.rms   = audio.rms;
      scratch.beatP = audio.beat.pulse;
      scratch.pal   = PALETTES[params.palette] || PALETTES.cosmic;
      scratch.swirl = params.swirl;
      scratch.nebula = params.nebula;
      scratch.eyeGlow = params.eyeGlow;
      scratch.starDensity = params.starDensity;
      scratch.ground = !!params.ground;

      // Cadence: p counts walk *cycles* (2 steps each). beat gives a tiny
      // nudge so he locks loosely to the groove.
      const cadence = params.speed * 0.9 + scratch.beatP * 0.25 * params.speed;
      scratch.p = (scratch.p + dt * cadence * 0.5) % 1;

      // Gait shaping params (also consumed by computePose).
      scratch.strideLen = 0.32 * params.stride;
      scratch.armSwing  = 0.45 + 0.35 * params.swagger;
      scratch.bobAmt    = 0.012 + 0.022 * params.swagger;
      scratch.swayAmt   = params.swagger;
      scratch.lungeAmt  = params.lunge;

      // ── Pose binding: shoulderSpan → scale, head.x → face/roam ───────────
      let scaleTarget = 0, faceTarget = scratch.faceDir;
      if (params.poseBind && pose.people.length > 0) {
        const p0 = pose.people[0];
        const sL = p0.shoulders?.l, sR = p0.shoulders?.r, head = p0.head;
        if (sL && sR && sL.visibility > 0.4 && sR.visibility > 0.4) {
          const dx = sR.x - sL.x, dy = sR.y - sL.y;
          const span = Math.sqrt(dx * dx + dy * dy);
          scaleTarget = Math.max(-1, Math.min(1, (span - 0.25) / 0.25));
        }
        if (head && head.visibility > 0.3) {
          faceTarget = (1 - head.x) < 0.5 ? -1 : 1;  // mirrored
        }
      }
      poseScale += (scaleTarget - poseScale) * Math.min(1, dt * 2);
      // Face flip is smoothed via a continuous director so it doesn't snap.
      faceDir += ((faceTarget) - faceDir) * Math.min(1, dt * 3);
      scratch.faceDir = faceDir >= 0 ? 1 : -1;

      // Geometry: scale, ground line, root, roam.
      const minDim = Math.min(W, H);
      const S = (params.scale + poseScale * 0.18) * minDim;
      scratch.S = S;
      scratch.groundY = H * 0.82;
      scratch.rootY   = scratch.groundY - 0.46 * S;   // bent-knee crouch

      if (params.roam) {
        // Walk across and wrap. Direction follows faceDir.
        roamX = (roamX + dt * cadence * 0.06 * scratch.faceDir);
        // keep within a generous range and wrap
        if (roamX > 0.75)  roamX -= 1.5;
        if (roamX < -0.75) roamX += 1.5;
        scratch.rootX = (0.5 + roamX) * W;
      } else {
        roamX = 0;
        scratch.rootX = W * 0.5;
      }

      scratch.eyeFlare = scratch.beatP;

      computePose();
    }

    // ── Render helpers ──────────────────────────────────────────────────────
    function rgba(c, a) { return `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`; }

    // Stamp a tapered, slightly-furry capsule (a row of overlapping circles)
    // into a Path2D. Union via fill gives an organic shaggy limb.
    function addBone(path, x0, y0, x1, y1, r0, r1, seed) {
      const steps = 8;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const cx = x0 + (x1 - x0) * t;
        const cy = y0 + (y1 - y0) * t;
        let r = (r0 + (r1 - r0) * t);
        r *= 1 + 0.07 * Math.sin(i * 1.7 + seed);   // fur ripple
        path.moveTo(cx + r, cy);
        path.arc(cx, cy, r, 0, TAU);
      }
    }

    function buildSilhouette() {
      const j = scratch.joints;
      const S = scratch.S;
      const path = new Path2D();

      // Far-side limbs first (thinner) so the union has subtle depth.
      const far = 0.86;
      for (let i = 0; i < 2; i++) {
        const leg = j.legs[i], arm = j.arms[i];
        const m = leg.near ? 1 : far;
        // leg: thigh + shin + foot
        addBone(path, leg.hx, leg.hy, leg.kx, leg.ky, 0.085 * S * m, 0.062 * S * m, i * 2 + 1);
        addBone(path, leg.kx, leg.ky, leg.fx, leg.fy, 0.062 * S * m, 0.045 * S * m, i * 2 + 2);
        // foot points along face
        const fx2 = leg.fx + j.face * 0.11 * S;
        addBone(path, leg.fx, leg.fy + 0.01 * S, fx2, leg.fy + 0.015 * S, 0.05 * S * m, 0.038 * S * m, i + 9);
        // arm: upper + fore + fist
        const am = arm.near ? 1 : far;
        addBone(path, arm.sX, arm.sY, arm.eX, arm.eY, 0.062 * S * am, 0.05 * S * am, i * 2 + 5);
        addBone(path, arm.eX, arm.eY, arm.wX, arm.wY, 0.05 * S * am, 0.04 * S * am, i * 2 + 6);
        path.moveTo(arm.wX + 0.05 * S * am, arm.wY);
        path.arc(arm.wX, arm.wY, 0.05 * S * am, 0, TAU);
      }

      // Curved spine — hip → mid-back → shoulders. Two tapered segments make
      // the back bow forward into the lunge (no flagpole).
      addBone(path, j.hipX, j.hipY + 0.02 * S, j.midX, j.midY, 0.125 * S, 0.135 * S, 12);
      addBone(path, j.midX, j.midY, j.shX, j.shY, 0.135 * S, 0.145 * S, 13);
      // Broad shoulder yoke, hunched over the lead leg.
      path.moveTo(j.shX + 0.14 * S, j.shY);
      path.arc(j.shX, j.shY, 0.14 * S, 0, TAU);
      // Thick forward-angled neck bridging shoulders to the leading head.
      addBone(path, j.shX, j.shY, j.headCX, j.headCY, 0.12 * S, 0.10 * S, 14);
      // Head — a rounded humanoid dome, taller than wide, tilted to peer down
      // the lunge. An ellipse gives the smooth cranium/jaw.
      const hrx = j.headR * 0.94, hry = j.headR * 1.14, ht = j.headTilt;
      path.moveTo(j.headCX + Math.cos(ht) * hrx, j.headCY + Math.sin(ht) * hrx);
      path.ellipse(j.headCX, j.headCY, hrx, hry, ht, 0, TAU);
      // Heavy cavemanish brow ridge — a forward bulge over the eyes.
      path.moveTo(j.browX + 0.06 * S, j.browY);
      path.arc(j.browX, j.browY, 0.06 * S, 0, TAU);

      return path;
    }

    function drawBackground() {
      const pal = scratch.pal, t = scratch.time;
      const minDim = Math.min(W, H);
      // Base wash — slight vertical gradient, a touch lighter at the horizon.
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0,   rgba(pal.bg, 1));
      g.addColorStop(0.6, rgba([pal.bg[0] + 6, pal.bg[1] + 9, pal.bg[2] + 12], 1));
      g.addColorStop(1,   rgba(pal.bg, 1));
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // Cosmic nebula clouds drifting across the whole sky — the cosmos now
      // lives in the background; the body is the void cut out of it.
      ctx.globalCompositeOperation = 'lighter';
      const nebCols = [pal.nebA, pal.nebB, pal.nebC];
      const nebAmt = scratch.nebula;
      for (let i = 0; i < 3; i++) {
        const ph = t * (0.02 + i * 0.012) + i * 2.1;
        const nx = (0.24 + i * 0.26) * W + Math.cos(ph) * 0.05 * W;
        const ny = (0.32 + 0.16 * Math.sin(ph * 1.1) + i * 0.14) * H;
        const nr = (0.30 + 0.08 * Math.sin(ph * 1.3)) * minDim;
        const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
        grad.addColorStop(0,   rgba(nebCols[i], (0.12 + 0.08 * scratch.mids) * nebAmt));
        grad.addColorStop(0.5, rgba(nebCols[i], 0.04 * nebAmt));
        grad.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(nx - nr, ny - nr, nr * 2, nr * 2);
      }

      // Van-Gogh swirl eddies.
      const swirlAmt = scratch.swirl;
      if (swirlAmt > 0.01) {
        for (const e of eddies) {
          const cx = e.x * W, cy = e.y * H;
          const ink = e.ink === 0 ? pal.swirlA : pal.swirlB;
          ctx.strokeStyle = rgba(ink, 0.05 * swirlAmt);
          ctx.lineWidth = 1.0 + scratch.rms * 1.5;
          ctx.beginPath();
          for (let s = 0; s <= EDDY_SEGS; s++) {
            const f = s / EDDY_SEGS;
            const r = e.rad * minDim * f;
            const ang = e.phase + e.dir * (f * e.turns * TAU) + t * e.spin;
            const px = cx + Math.cos(ang) * r;
            const py = cy + Math.sin(ang) * r;
            if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }

      // Cosmic starfield — two parallax layers drifting left to imply travel,
      // density gated by `starDensity`. (Now the main star show, not the body.)
      ctx.globalCompositeOperation = 'lighter';
      const tw = scratch.highs;
      const drift = (t * 0.012) % 1;
      for (let i = 0; i < NUM_BG_STARS; i++) {
        let x = (bgx[i] - drift); x -= Math.floor(x);
        const px = x * W, py = bgy[i] * H;
        const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.5 + bgp[i])) * (0.6 + tw);
        ctx.fillStyle = rgba(pal.star, Math.min(0.85, a) * 0.6);
        ctx.fillRect(px, py, bgs[i], bgs[i]);
      }
      const drift2 = (t * 0.02) % 1;   // nearer layer drifts faster
      const N = Math.min(MAX_BODY_STARS, (MAX_BODY_STARS * scratch.starDensity) | 0);
      for (let i = 0; i < N; i++) {
        let x = (sx[i] - drift2); x -= Math.floor(x);
        const px = x * W, py = sy[i] * H;
        const a = (0.40 + 0.45 * Math.sin(t * (1 + (i % 5) * 0.4) + sp[i])) * (0.6 + tw);
        const r = ss[i] * 0.8;
        ctx.fillStyle = rgba(pal.star, Math.min(1, a) * 0.7);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawContactShadows() {
      if (!scratch.ground) return;
      const j = scratch.joints, pal = scratch.pal, S = scratch.S;
      ctx.globalCompositeOperation = 'multiply';
      for (let i = 0; i < 2; i++) {
        const leg = j.legs[i];
        const planted = leg.psi < 0.62 ? 1 : 0.25;
        const w = 0.16 * S, h = 0.035 * S;
        const cx = leg.fx + j.face * 0.04 * S;
        const cy = scratch.groundY + 0.01 * S;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, w);
        grad.addColorStop(0, `rgba(0,0,0,${(0.45 * planted).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, h / w);
        ctx.beginPath();
        ctx.arc(0, 0, w, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawFigure() {
      const j = scratch.joints, pal = scratch.pal, S = scratch.S;
      const path = buildSilhouette();
      const minDim = Math.min(W, H);

      // Aura halo — soft glow around the whole silhouette.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = rgba(pal.aura, 1);
      ctx.shadowBlur  = (0.04 + 0.03 * scratch.beatP) * minDim;
      ctx.fillStyle   = rgba(pal.aura, 0.10 + 0.12 * scratch.beatP);
      ctx.fill(path);
      ctx.restore();

      // Void interior — the silhouette is negative space punched out of the
      // cosmos. Clip to the body, fill with near-opaque void, then a faint
      // inner rim light so the edge catches the surrounding glow and reads
      // as a form rather than a flat hole.
      ctx.save();
      ctx.clip(path);
      const bx = j.headCX - 1.4 * S, by = scratch.rootY - 1.2 * S;
      const bw = 2.8 * S, bh = 2.4 * S;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba([2, 3, 6], 0.985);
      ctx.fillRect(bx, by, bw, bh);

      ctx.globalCompositeOperation = 'lighter';
      const rcx = j.hipX, rcy = scratch.rootY - 0.18 * S, rr = 0.98 * S;
      const rim = ctx.createRadialGradient(rcx, rcy, rr * 0.5, rcx, rcy, rr);
      rim.addColorStop(0, 'rgba(0,0,0,0)');
      rim.addColorStop(1, rgba(pal.aura, 0.12 + 0.10 * scratch.beatP));
      ctx.fillStyle = rim;
      ctx.fillRect(bx, by, bw, bh);
      ctx.restore();

      // Eyes — ride the head front, glowing, flaring on the beat.
      ctx.globalCompositeOperation = 'lighter';
      const er = j.headR * 0.14;
      const glow = (0.8 + scratch.eyeFlare * 1.2) * scratch.eyeGlow;
      // eye positions are computed in computePose (tilt + face aware)
      for (const e of j.eyes) {
        const bloom = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, er * 6);
        bloom.addColorStop(0, rgba(pal.eye, Math.min(1, 0.5 * glow)));
        bloom.addColorStop(0.4, rgba(pal.eye, 0.12 * glow));
        bloom.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(e.x, e.y, er * 6, 0, TAU);
        ctx.fill();
        ctx.fillStyle = rgba([255, 255, 255], Math.min(1, 0.9 * glow));
        ctx.beginPath();
        ctx.arc(e.x, e.y, er, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawVignette() {
      const g = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.3,
                                         W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.45)');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    function render() {
      if (!scratch.joints) return;
      drawBackground();
      drawContactShadows();
      drawFigure();
      drawVignette();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* GC handles typed arrays */ },
    };
  },
};
