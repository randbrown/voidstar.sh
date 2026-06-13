// Bigfoot — "Ramblin' Visioneer" (professional animation pass).
//
// A layered, articulated procedural 2D puppet of a Sasquatch apparition: a
// mostly-black silhouette with real anatomy (hunched back, sloped shoulders,
// long arms to the knees, big hands + feet), weighted body mechanics with
// delayed/overlapping motion, edge fur breakup, layered glowing cyan eyes, a
// soft aura, and an abstract stained-glass OR cosmic-void backdrop. Audio,
// pose and a debug-rig overlay drive it. He should read instantly as Bigfoot
// even in pure black, and feel like a heavy creature living inside the mystery.
//
// Animation states (animationState):
//   idle       living stand: breath, shoulder rise/fall, weight shift, arm
//              pendulum, knee flex, slow eye pulse + rare occlusion dimming
//   walk       weighted Sasquatch gait (the mechanics dialed in earlier):
//              forward-committed lunge, heel-toe foot roll, counter-rotating
//              shoulders, arms swing opposite legs, hands lag the wrists
//   loom       leans toward the audience: torso scales up, shoulders widen,
//              eyes + aura intensify (great on bass / approach)
//   apparition edges dissolve into smoky wisps; eyes stay as the anchor
//   ritual     still, centered, hunched, arms slightly forward, halo aura
//
// Audio map (smoothed, ritualistic — not twitchy):
//   bass  → body squash/stretch + footfall + aura bloom + eye brightness
//   mids  → fur lift + shoulder sway + glass shimmer
//   highs → eye sparkle + glass flecks + edge particles
//
// Pose map (he *notices*, he doesn't mimic):
//   center.x      → gaze direction (eyes/head glance)
//   wrist.y       → aura tendril on that side
//   velocity      → apparition ripple
//   shoulderSpan  → loom intensity

import { scaleAudio } from '../field.js';

const PI = Math.PI, TAU = PI * 2;

// Signature palette (per spec).
const VOID_BLACK = [2, 3, 10];
const RIM_BLUE   = [29, 93, 255];
const EYE_CORE   = [234, 255, 255];
const EYE_GLOW   = [57, 207, 255];
const AURA_BLUE  = [60, 140, 255];

// Background palettes — drive the cosmic/void sky AND the stained-glass leads.
const PALETTES = {
  cosmic: { bg: [7, 11, 18],  glassA: [40, 110, 140], glassB: [200, 120, 50], glassC: [120, 80, 170],
            star: [222, 236, 246], neb: [70, 135, 160] },
  aurora: { bg: [5, 14, 14],  glassA: [50, 180, 140], glassB: [90, 120, 210], glassC: [180, 90, 190],
            star: [225, 245, 240], neb: [60, 180, 140] },
  ember:  { bg: [16, 8, 6],   glassA: [210, 110, 40], glassB: [180, 50, 55],  glassC: [240, 190, 90],
            star: [250, 235, 205], neb: [210, 120, 50] },
  mono:   { bg: [8, 10, 14],  glassA: [110, 130, 160], glassB: [70, 90, 120], glassC: [150, 165, 195],
            star: [235, 240, 248], neb: [110, 130, 160] },
};

const QUALITY = {
  low:    { fur: 46,  particles: 0,  auraLayers: 1, bgStars: 90,  glassCells: 0  },
  medium: { fur: 96,  particles: 28, auraLayers: 2, bgStars: 160, glassCells: 26 },
  high:   { fur: 170, particles: 56, auraLayers: 3, bgStars: 240, glassCells: 40 },
};

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp  = (a, b, t) => a + (b - a) * t;
const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
// Frame-rate-independent smoothing toward a target.
const approach = (cur, target, dt, rate) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
function hash(n) { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); }
function vnoise(x) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(i), hash(i + 1), u); }
const rgba = (c, a) => `rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a < 0 ? 0 : a > 1 ? 1 : a})`;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'bigfoot',
  name: 'Bigfoot',
  contextType: 'canvas2d',

  params: [
    { id: 'animationState', label: 'state', type: 'select',
      options: ['idle', 'walk', 'loom', 'apparition', 'ritual'], default: 'idle' },
    { id: 'backgroundMode', label: 'backdrop', type: 'select',
      options: ['void', 'stainedGlass', 'gardenRitual', 'evilEye', 'apparitionGlass'], default: 'void' },
    { id: 'palette', label: 'palette', type: 'select', options: ['cosmic', 'aurora', 'ember', 'mono'], default: 'cosmic' },
    { id: 'quality', label: 'quality', type: 'select', options: ['low', 'medium', 'high'], default: 'high' },

    { id: 'bigfootScale', label: 'scale',     type: 'range', min: 0.4, max: 1.4, step: 0.01, default: 1.0 },
    { id: 'bigfootX',     label: 'pos x',     type: 'range', min: -0.5, max: 0.5, step: 0.01, default: 0.0 },
    { id: 'bigfootY',     label: 'pos y',     type: 'range', min: -0.3, max: 0.3, step: 0.01, default: 0.0 },
    { id: 'walkSpeed',    label: 'walk speed',type: 'range', min: 0, max: 3, step: 0.05, default: 1.0 },
    { id: 'breathAmount', label: 'breath',    type: 'range', min: 0, max: 1, step: 0.05, default: 0.45 },
    { id: 'swayAmount',   label: 'sway',      type: 'range', min: 0, max: 1, step: 0.05, default: 0.35 },
    { id: 'furAmount',    label: 'fur',       type: 'range', min: 0, max: 1, step: 0.05, default: 0.55 },
    { id: 'furMotion',    label: 'fur motion',type: 'range', min: 0, max: 1, step: 0.05, default: 0.30 },
    { id: 'eyeGlow',      label: 'eye glow',  type: 'range', min: 0, max: 2, step: 0.05, default: 0.85 },
    { id: 'eyePulse',     label: 'eye pulse', type: 'range', min: 0, max: 1, step: 0.05, default: 0.50 },
    { id: 'auraAmount',   label: 'aura',      type: 'range', min: 0, max: 1, step: 0.05, default: 0.45 },
    { id: 'apparitionAmount', label: 'apparition', type: 'range', min: 0, max: 1, step: 0.05, default: 0.15 },
    { id: 'loomAmount',   label: 'loom',      type: 'range', min: 0, max: 1, step: 0.05, default: 0.0 },

    { id: 'stainedGlassAmount', label: 'glass',   type: 'range', min: 0, max: 1, step: 0.05, default: 0.25 },
    { id: 'glassGrain',   label: 'glass grain',   type: 'range', min: 0, max: 1, step: 0.05, default: 0.30 },
    { id: 'evilEyeAmount',label: 'evil eye',      type: 'range', min: 0, max: 1, step: 0.05, default: 0.30 },
    { id: 'gardenAmount', label: 'garden',        type: 'range', min: 0, max: 1, step: 0.05, default: 0.30 },

    { id: 'audioBodyAmount', label: 'au·body', type: 'range', min: 0, max: 1, step: 0.05, default: 0.35 },
    { id: 'audioEyeAmount',  label: 'au·eye',  type: 'range', min: 0, max: 1, step: 0.05, default: 0.55 },
    { id: 'audioAuraAmount', label: 'au·aura', type: 'range', min: 0, max: 1, step: 0.05, default: 0.65 },
    { id: 'audioFurAmount',  label: 'au·fur',  type: 'range', min: 0, max: 1, step: 0.05, default: 0.25 },
    { id: 'poseInfluence',   label: 'pose',    type: 'range', min: 0, max: 1, step: 0.05, default: 0.30 },

    { id: 'debugRig',   label: 'debug rig', type: 'toggle', default: false },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { animationState: 'idle',  backgroundMode: 'void' },
      { animationState: 'walk',  backgroundMode: 'void' },
      { animationState: 'loom',  backgroundMode: 'evilEye' },
      { animationState: 'ritual', backgroundMode: 'stainedGlass' },
      { animationState: 'apparition', backgroundMode: 'apparitionGlass' },
    ],
  },

  presets: {
    default:      { animationState: 'idle', backgroundMode: 'void', palette: 'cosmic', quality: 'high', bigfootScale: 1.0, breathAmount: 0.45, swayAmount: 0.35, furAmount: 0.55, furMotion: 0.30, eyeGlow: 0.85, eyePulse: 0.50, auraAmount: 0.45, apparitionAmount: 0.15, loomAmount: 0.0, stainedGlassAmount: 0.25, audioBodyAmount: 0.35, audioEyeAmount: 0.55, audioAuraAmount: 0.65, audioFurAmount: 0.25, poseInfluence: 0.30, debugRig: false },
    ramblin:      { animationState: 'walk', backgroundMode: 'void', walkSpeed: 1.0, furAmount: 0.6, auraAmount: 0.5, palette: 'cosmic' },
    stagePresence:{ animationState: 'loom', backgroundMode: 'evilEye', loomAmount: 0.8, eyeGlow: 1.3, auraAmount: 0.8, evilEyeAmount: 0.7 },
    apparition:   { animationState: 'apparition', backgroundMode: 'apparitionGlass', apparitionAmount: 0.8, auraAmount: 0.6, furAmount: 0.45, eyeGlow: 1.0 },
    ritual:       { animationState: 'ritual', backgroundMode: 'stainedGlass', stainedGlassAmount: 0.7, evilEyeAmount: 0.6, gardenAmount: 0.6, auraAmount: 0.7, eyeGlow: 1.0 },
    woodsSpirit:  { animationState: 'idle', backgroundMode: 'gardenRitual', gardenAmount: 0.8, stainedGlassAmount: 0.5, furAmount: 0.7, breathAmount: 0.6 },
  },

  async create(canvas, opts) {
    const ctx = opts.ctx;
    let W = canvas.width, H = canvas.height, DPR = 1;

    // Background star pools (cosmic void mode).
    const STAR_MAX = 260;
    const bgx = new Float32Array(STAR_MAX), bgy = new Float32Array(STAR_MAX);
    const bgs = new Float32Array(STAR_MAX), bgp = new Float32Array(STAR_MAX);
    for (let i = 0; i < STAR_MAX; i++) {
      bgx[i] = Math.random(); bgy[i] = Math.random();
      bgs[i] = 0.4 + Math.random() * Math.random() * 2.4; bgp[i] = Math.random() * TAU;
    }
    // Swirl eddies (van-Gogh cosmos backdrop).
    const eddies = [];
    for (let i = 0; i < 7; i++) eddies.push({
      x: hash(i * 3.1 + 1.7), y: hash(i * 5.7 + 0.3), rad: 0.10 + hash(i * 2.3) * 0.18,
      turns: 1.2 + hash(i * 9.1) * 1.6, dir: hash(i * 4.4) < 0.5 ? 1 : -1,
      spin: 0.04 + hash(i * 6.6) * 0.10, phase: hash(i * 7.7) * TAU,
    });

    // Fur anchors: stable per-session t-positions + side + jitter seed, grouped
    // by the rig segment they ride. Positions recomputed per frame from joints,
    // but the parametric layout is cached here (cheap).
    const FUR_GROUPS = ['back', 'shoulderL', 'shoulderR', 'foreL', 'foreR', 'calfL', 'calfR', 'thighL', 'thighR', 'crown'];
    const furAll = [];
    for (let i = 0; i < QUALITY.high.fur; i++) {
      const g = FUR_GROUPS[i % FUR_GROUPS.length];
      furAll.push({ g, t: hash(i * 1.7), side: hash(i * 2.9) < 0.5 ? -1 : 1,
        len: 0.5 + hash(i * 4.1), seed: hash(i * 5.3) * 100, lean: (hash(i * 6.7) - 0.5) });
    }

    // Particle pool (apparition wisps + treble sparkles).
    const PMAX = QUALITY.high.particles;
    const parts = [];
    for (let i = 0; i < PMAX; i++) parts.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, kind: 0, r: 1 });

    // Persistent animation state (springs / lagged anchors / smoothed inputs).
    const st = {
      p: 0, weightPhase: Math.random() * TAU, furPhase: 0,
      chest: null, head: null, hand: [null, null],   // lagged screen anchors
      aura: null, eyeB: 0.6, loom: 0, appar: 0,
      gazeX: 0, gazeY: 0, poseLoom: 0, tendril: [0, 0], ripple: 0,
      blinkT: 3 + Math.random() * 5, occlude: 0,
      fps: 60, lastHead: null,
      glass: null, glassKey: '',
    };

    // Per-frame staged data (render reads only this).
    const sc = {
      t: 0, dt: 0, pal: PALETTES.cosmic, q: QUALITY.high,
      bass: 0, mids: 0, highs: 0, rms: 0, beat: 0,
      params: null, rig: null, face: 1, S: 100,
      squash: 1, stretch: 1, eyeBright: 0.6, auraR: 0,
    };

    // ── Kinematics helpers ──────────────────────────────────────────────────
    function ik(hx, hy, fx, fy, a, b, bend) {
      let dx = fx - hx, dy = fy - hy, D = Math.hypot(dx, dy);
      const mx = a + b - 1e-3, mn = Math.abs(a - b) + 1e-3;
      D = clamp(D, mn, mx);
      const base = Math.atan2(dy, dx);
      const c = clamp((a * a + D * D - b * b) / (2 * a * D), -1, 1);
      const A = Math.acos(c), ka = base + bend * A;
      return { x: hx + Math.cos(ka) * a, y: hy + Math.sin(ka) * a };
    }
    function footTraj(psi, L, lift) {
      const STANCE = 0.62;
      if (psi < STANCE) { const u = psi / STANCE; return { fx: (0.5 - u) * L, lift: 0, roll: (u - 0.5) }; }
      const u = (psi - STANCE) / (1 - STANCE);
      return { fx: (-0.5 + easeInOut(u)) * L, lift: lift * Math.sin(PI * u), roll: 0 };
    }

    // Build the full articulated rig (named joints) for this frame.
    function buildRig(P) {
      const dt = sc.dt, t = sc.t, S = sc.S, face = sc.face;
      const state = P.animationState;
      const ground = sc.groundY;
      const rootX = sc.rootX;

      const swag = 1.0;                          // base character swagger
      const breath = 0.5 + 0.5 * Math.sin(t * 1.1);  // 0..1 breath cycle
      sc.breath = breath;

      // Audio body squash/stretch (smoothed, subtle).
      const ab = P.audioBodyAmount;
      sc.squash  = 1 - sc.beat * 0.025 * ab * 4;
      sc.stretch = 1 + sc.beat * 0.018 * ab * 4;

      const walking = state === 'walk';
      // Locomotion phase.
      if (walking) st.p = (st.p + dt * (P.walkSpeed * 0.9 + sc.beat * 0.25 * P.walkSpeed) * 0.5) % 1;
      const p = st.p;

      // Weight shift (idle): slow lateral lean over the planted feet.
      st.weightPhase += dt * 0.5;
      const weight = Math.sin(st.weightPhase) * (state === 'walk' ? 0 : P.swayAmount);

      // Forward lunge envelope (walk) — the mechanics signed off earlier.
      const step = walking ? Math.max(0, Math.sin(2 * TAU * p)) : 0;
      const leanLower = (walking ? 0.24 : 0.16) + 0.08 * swag + 0.12 * step + 0.10 * sc.beat;
      const hunchAmt  = (walking ? 0.14 : 0.13) + 0.07 * swag + 0.07 * step;
      const leanUpper = leanLower + hunchAmt;
      const neckFwd   = 0.26 + 0.05 * swag;

      // Pelvis.
      const bob = walking ? -(0.012 + 0.022 * swag) * S * Math.cos(2 * TAU * p)
                          : (Math.sin(t * 1.1 + PI) * 0.006) * S; // gentle idle rise
      const lungeShift = walking ? swag * 0.03 * S * Math.sin(2 * TAU * p) : 0;
      const sway = (walking ? Math.sin(2 * TAU * p) * 0.02 : weight * 0.05) * S * P.swayAmount * 2;
      const hipY = ground - 0.46 * S + bob;
      const hipX = rootX + face * lungeShift + sway;
      const hips = { x: hipX, y: hipY };

      // Counter-rotation: hips and shoulders twist oppositely through the step.
      const rot = walking ? Math.sin(2 * TAU * p) * 0.06 : 0;

      // Curved spine: hips → spine → chest, bowing forward.
      const tLen = 0.36 * S * sc.stretch;
      const lowAng = -PI / 2 + face * (leanLower - rot * 0.5);
      const spine = { x: hipX + Math.cos(lowAng) * tLen * 0.40, y: hipY + Math.sin(lowAng) * tLen * 0.40 };
      const upAng = -PI / 2 + face * (leanUpper + rot * 0.5);
      const chestTarget = { x: spine.x + Math.cos(upAng) * tLen * 0.42, y: spine.y + Math.sin(upAng) * tLen * 0.42 };
      // Chest lags the hips a touch (overlapping action).
      if (!st.chest) st.chest = { ...chestTarget };
      st.chest.x = approach(st.chest.x, chestTarget.x, dt, 11);
      st.chest.y = approach(st.chest.y, chestTarget.y, dt, 11);
      const chest = st.chest;
      // Breathing expands the chest mass.
      sc.chestExpand = 1 + (breath - 0.5) * 0.10 * P.breathAmount + sc.beat * 0.04 * P.audioBodyAmount;

      // Shoulders: broad, sloped, can widen on loom.
      const shAng = upAng;
      const shoulder = { x: chest.x + Math.cos(shAng) * tLen * 0.10, y: chest.y + Math.sin(shAng) * tLen * 0.10 - 0.01 * S };
      const shrug = (state === 'idle' ? (breath - 0.5) * 0.02 * S : 0);
      shoulder.y += shrug;

      // Neck → head (head leads forward; stays strangely stable = intelligence).
      const headR = 0.135 * S;
      const neckAng = -PI / 2 + face * (leanUpper + neckFwd);
      const neck = { x: shoulder.x + Math.cos(neckAng) * 0.05 * S, y: shoulder.y + Math.sin(neckAng) * 0.05 * S };
      const headTarget = {
        x: neck.x + Math.cos(neckAng) * (headR * 0.7),
        y: neck.y + Math.sin(neckAng) * (headR * 0.7),
      };
      const headTilt = face * (0.16 + leanUpper * 0.30) + st.gazeX * 0.12;
      // Head follows almost exactly but with the tiniest lag + idle tilt.
      const idleTilt = state === 'idle' ? Math.sin(t * 0.7) * 0.03 : 0;
      if (!st.head) st.head = { ...headTarget };
      st.head.x = approach(st.head.x, headTarget.x, dt, 16);
      st.head.y = approach(st.head.y, headTarget.y, dt, 16);
      const head = { x: st.head.x, y: st.head.y, r: headR, tilt: headTilt + idleTilt };

      // ── Legs (IK). Walk uses moving foot targets; idle uses a planted stance
      // with knee flex from the weight shift. Big feet, heel-toe roll.
      const a = 0.26 * S, b = 0.24 * S, footLen = 0.17 * S;
      const L = (walking ? 0.34 : 0.12) * S;
      const lift = 0.13 * S;
      const legs = [];
      for (let i = 0; i < 2; i++) {
        const near = i === 0;
        let fx, fy, roll;
        if (walking) {
          const psi = (p + i * 0.5) % 1;
          const tr = footTraj(psi, L, lift);
          fx = hipX + face * (tr.fx + (i === 0 ? 0.05 : -0.05) * S);
          fy = ground - tr.lift; roll = tr.roll;
        } else {
          fx = hipX + face * (i === 0 ? 0.16 : -0.14) * S + weight * 0.02 * S;
          fy = ground; roll = 0;
        }
        const hx = hipX + face * (i === 0 ? 0.04 : -0.04) * S + (i === 0 ? 1 : -1) * 0.02 * S;
        // idle knee flex: shift hip target down a hair on the weighted side
        const hy = hipY + (walking ? 0 : (i === 0 ? 1 : -1) * weight * 0.02 * S);
        const knee = ik(hx, hy, fx, fy, a, b, face > 0 ? -1 : 1);
        const ankle = { x: fx, y: fy };
        const footAng = face * (0.05 + roll * 0.5);
        const foot = { x: fx + Math.cos(footAng) * footLen * face, y: fy + Math.sin(footAng) * footLen * 0.4 };
        legs.push({ hip: { x: hx, y: hy }, knee, ankle, foot, near, footLen, footAng });
      }

      // ── Arms (FK + hand lag). Long, heavy, swing opposite legs; hands settle
      // last. Idle = slow pendulum from the sway.
      const ua = 0.30 * S, fa = 0.27 * S, handR = 0.075 * S;
      const arms = [];
      for (let i = 0; i < 2; i++) {
        const near = i === 0;
        let swing;
        if (walking) {
          const ph = (p + i * 0.5 + 0.5 + 0.05) % 1;
          swing = (0.45 + 0.30 * swag) * Math.sin(TAU * ph);
        } else {
          swing = Math.sin(t * 0.9 + i * PI) * 0.10 * (0.4 + P.swayAmount) + weight * 0.15 * (near ? 1 : -1);
        }
        const shoAng = PI / 2 - face * (swing + 0.10 - rot * (near ? 1 : -1));
        const sX = shoulder.x + face * (near ? 0.05 : -0.05) * S;
        const sY = shoulder.y + 0.01 * S;
        const eX = sX + Math.cos(shoAng) * ua, eY = sY + Math.sin(shoAng) * ua;
        const foreAng = shoAng - face * (0.16 + 0.12 * Math.max(0, swing));
        const wX = eX + Math.cos(foreAng) * fa, wY = eY + Math.sin(foreAng) * fa;
        // Hand lags the wrist (heavy rope feel).
        if (!st.hand[i]) st.hand[i] = { x: wX, y: wY };
        st.hand[i].x = approach(st.hand[i].x, wX, dt, near ? 7 : 6);
        st.hand[i].y = approach(st.hand[i].y, wY, dt, near ? 7 : 6);
        const hand = { x: st.hand[i].x, y: st.hand[i].y, r: handR };
        arms.push({ shoulder: { x: sX, y: sY }, elbow: { x: eX, y: eY }, wrist: { x: wX, y: wY }, hand, near });
      }

      // Eyes — deep under the brow, layered, follow head + gaze.
      const ct = Math.cos(head.tilt), si = Math.sin(head.tilt);
      const place = (fwd, up) => ({ x: head.x + (face * fwd) * ct - up * si, y: head.y + (face * fwd) * si + up * ct });
      const eyeGap = headR * 0.30;
      const eyeFwd = headR * 0.40 + st.gazeX * headR * 0.10;
      const eyeUp  = -headR * 0.02 + st.gazeY * headR * 0.10;
      const eyes = [place(eyeFwd + eyeGap, eyeUp), place(eyeFwd - eyeGap, eyeUp)];
      const brow = place(headR * 0.55, -headR * 0.22);

      sc.rig = { hips, spine, chest, shoulder, neck, head, legs, arms, eyes, brow, headR, face, rot };
    }

    // ── Silhouette path (one near-black union) ──────────────────────────────
    function addBone(path, x0, y0, x1, y1, r0, r1, seed) {
      const steps = 7;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, cx = lerp(x0, x1, t), cy = lerp(y0, y1, t);
        let r = lerp(r0, r1, t) * (1 + 0.06 * Math.sin(i * 1.7 + seed));
        path.moveTo(cx + r, cy); path.arc(cx, cy, r, 0, TAU);
      }
    }
    function addBlob(path, x, y, r) { path.moveTo(x + r, y); path.arc(x, y, r, 0, TAU); }

    function buildBody() {
      const r = sc.rig, S = sc.S, f = r.face;
      const path = new Path2D();
      const far = 0.85, ce = sc.chestExpand;

      // Far limbs first (thinner) for subtle depth.
      const farLeg = r.legs[1], farArm = r.arms[1];
      addBone(path, farLeg.hip.x, farLeg.hip.y, farLeg.knee.x, farLeg.knee.y, 0.10 * S * far, 0.075 * S * far, 11);
      addBone(path, farLeg.knee.x, farLeg.knee.y, farLeg.ankle.x, farLeg.ankle.y, 0.075 * S * far, 0.05 * S * far, 12);
      addBone(path, farArm.shoulder.x, farArm.shoulder.y, farArm.elbow.x, farArm.elbow.y, 0.07 * S * far, 0.06 * S * far, 13);
      addBone(path, farArm.elbow.x, farArm.elbow.y, farArm.wrist.x, farArm.wrist.y, 0.06 * S * far, 0.05 * S * far, 14);
      addBlob(path, farArm.hand.x, farArm.hand.y, farArm.hand.r * far);

      // Torso mass: hips → spine → chest, with barrel-chest + belly blobs.
      addBone(path, r.hips.x, r.hips.y, r.spine.x, r.spine.y, 0.155 * S, 0.15 * S, 21);
      addBone(path, r.spine.x, r.spine.y, r.chest.x, r.chest.y, 0.15 * S, 0.165 * S * ce, 22);
      addBlob(path, (r.spine.x + r.chest.x) / 2 + f * 0.03 * S, (r.spine.y + r.chest.y) / 2, 0.135 * S * ce); // belly
      addBlob(path, r.chest.x, r.chest.y, 0.155 * S * ce);                                                   // chest
      // Sloped shoulder yoke.
      addBone(path, r.shoulder.x - f * 0.12 * S, r.shoulder.y + 0.03 * S, r.shoulder.x + f * 0.12 * S, r.shoulder.y - 0.01 * S, 0.10 * S, 0.13 * S, 23);
      addBlob(path, r.shoulder.x, r.shoulder.y, 0.14 * S);
      // Thick neck vanishing into shoulders.
      addBone(path, r.shoulder.x, r.shoulder.y, r.head.x, r.head.y, 0.115 * S, 0.10 * S, 24);

      // Head: dome + low forehead/brow + faint muzzle.
      const hr = r.headR, ht = r.head.tilt;
      const hrx = hr * 0.95, hry = hr * 1.12;
      path.moveTo(r.head.x + Math.cos(ht) * hrx, r.head.y + Math.sin(ht) * hrx);
      path.ellipse(r.head.x, r.head.y, hrx, hry, ht, 0, TAU);
      addBlob(path, r.brow.x, r.brow.y, 0.062 * S);                            // brow ridge
      addBlob(path, r.head.x + f * hrx * 0.6, r.head.y + hry * 0.18, 0.055 * S); // subtle muzzle

      // Near limbs (full thickness) + big feet/hands.
      for (const leg of [r.legs[0]]) {
        addBone(path, leg.hip.x, leg.hip.y, leg.knee.x, leg.knee.y, 0.10 * S, 0.075 * S, 31);
        addBone(path, leg.knee.x, leg.knee.y, leg.ankle.x, leg.ankle.y, 0.075 * S, 0.05 * S, 32);
      }
      // Both feet (big, recognizable).
      for (const leg of r.legs) {
        addBone(path, leg.ankle.x, leg.ankle.y + 0.01 * S, leg.foot.x, leg.foot.y + 0.012 * S, 0.055 * S * (leg.near ? 1 : far), 0.04 * S * (leg.near ? 1 : far), 33);
      }
      const nearArm = r.arms[0];
      addBone(path, nearArm.shoulder.x, nearArm.shoulder.y, nearArm.elbow.x, nearArm.elbow.y, 0.072 * S, 0.062 * S, 41);
      addBone(path, nearArm.elbow.x, nearArm.elbow.y, nearArm.wrist.x, nearArm.wrist.y, 0.062 * S, 0.052 * S, 42);
      // Hands: palm blob + a couple heavy rounded digits.
      for (const arm of r.arms) {
        const m = arm.near ? 1 : far;
        addBlob(path, arm.hand.x, arm.hand.y, arm.hand.r * m);
        for (let d = -1; d <= 1; d++) {
          const dx = arm.hand.x + f * 0.05 * S, dy = arm.hand.y + d * 0.03 * S + 0.04 * S;
          addBlob(path, dx, dy, 0.026 * S * m);
        }
      }
      return path;
    }

    // ── Fur: short tapered black tufts along the outline, with faint blue tip.
    function segFor(g) {
      const r = sc.rig;
      switch (g) {
        case 'back':     return [r.spine, r.chest];
        case 'shoulderL':return [r.shoulder, r.chest];
        case 'shoulderR':return [r.chest, r.shoulder];
        case 'foreL':    return [r.arms[0].elbow, r.arms[0].wrist];
        case 'foreR':    return [r.arms[1].elbow, r.arms[1].wrist];
        case 'calfL':    return [r.legs[0].knee, r.legs[0].ankle];
        case 'calfR':    return [r.legs[1].knee, r.legs[1].ankle];
        case 'thighL':   return [r.legs[0].hip, r.legs[0].knee];
        case 'thighR':   return [r.legs[1].hip, r.legs[1].knee];
        case 'crown':    return [{ x: r.head.x, y: r.head.y - r.headR }, { x: r.head.x + r.face * r.headR, y: r.head.y - r.headR * 0.5 }];
      }
      return [r.spine, r.chest];
    }
    function drawFur(P) {
      const n = Math.min(furAll.length, (sc.q.fur * P.furAmount) | 0);
      if (n <= 0) return;
      const S = sc.S, t = sc.t;
      const audioLift = (sc.mids * 0.35 + sc.highs * 0.25) * P.audioFurAmount;
      st.furPhase += sc.dt * (0.4 + P.furMotion);
      ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const fu = furAll[i];
        const [j0, j1] = segFor(fu.g);
        const px = lerp(j0.x, j1.x, fu.t), py = lerp(j0.y, j1.y, fu.t);
        let nx = -(j1.y - j0.y), ny = (j1.x - j0.x);
        const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl; nx *= fu.side; ny *= fu.side;
        const flutter = (vnoise(st.furPhase * (0.8 + P.furMotion) + fu.seed) - 0.5);
        const baseR = (fu.g === 'crown' ? 0.085 : 0.11) * S;
        const rootX = px + nx * baseR, rootY = py + ny * baseR;
        const len = (8 + fu.len * 14) * (S / 300) * (1 + audioLift) * (0.8 + 0.4 * P.furAmount);
        // tangential bend
        const tx = (j1.x - j0.x) / nl, ty = (j1.y - j0.y) / nl;
        const bend = (fu.lean + flutter * (0.6 + P.furMotion)) * len * 0.6;
        const tipX = rootX + nx * len + tx * bend, tipY = rootY + ny * len + ty * bend;
        ctx.strokeStyle = rgba(VOID_BLACK, 0.95);
        ctx.lineWidth = Math.max(1, 2.2 * (S / 320));
        ctx.beginPath(); ctx.moveTo(rootX, rootY); ctx.lineTo(tipX, tipY); ctx.stroke();
      }
      // faint blue rim on a subset of tips
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i += 3) {
        const fu = furAll[i];
        const [j0, j1] = segFor(fu.g);
        const px = lerp(j0.x, j1.x, fu.t), py = lerp(j0.y, j1.y, fu.t);
        let nx = -(j1.y - j0.y), ny = (j1.x - j0.x); const nl = Math.hypot(nx, ny) || 1;
        nx = nx / nl * fu.side; ny = ny / nl * fu.side;
        ctx.fillStyle = rgba(RIM_BLUE, 0.05);
        ctx.beginPath(); ctx.arc(px + nx * 0.13 * S, py + ny * 0.13 * S, 1.2, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── Backgrounds ─────────────────────────────────────────────────────────
    function drawVoid(P) {
      const pal = sc.pal, t = sc.t, minDim = Math.min(W, H);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, rgba(pal.bg, 1));
      g.addColorStop(0.6, rgba([pal.bg[0] + 6, pal.bg[1] + 9, pal.bg[2] + 12], 1));
      g.addColorStop(1, rgba(pal.bg, 1));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // swirls
      ctx.globalCompositeOperation = 'lighter';
      for (const e of eddies) {
        const cx = e.x * W, cy = e.y * H;
        ctx.strokeStyle = rgba(pal.neb, 0.04 * (0.6 + sc.mids));
        ctx.lineWidth = 1 + sc.rms * 1.5;
        ctx.beginPath();
        for (let s = 0; s <= 44; s++) {
          const fr = s / 44, rr = e.rad * minDim * fr;
          const ang = e.phase + e.dir * fr * e.turns * TAU + t * e.spin;
          const px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
          s === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      // stars
      const N = Math.min(STAR_MAX, sc.q.bgStars), drift = (t * 0.012) % 1, tw = sc.highs;
      for (let i = 0; i < N; i++) {
        let x = bgx[i] - drift; x -= Math.floor(x);
        const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.5 + bgp[i])) * (0.6 + tw);
        ctx.fillStyle = rgba(pal.star, Math.min(0.85, a) * 0.6);
        ctx.fillRect(x * W, bgy[i] * H, bgs[i], bgs[i]);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function buildGlass(pal, cells) {
      if (typeof document === 'undefined') return null;
      const oc = document.createElement('canvas'); oc.width = W; oc.height = H;
      const g = oc.getContext('2d'); if (!g) return null;
      g.fillStyle = rgba([6, 8, 14], 1); g.fillRect(0, 0, W, H);
      // backlight
      const bl = g.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, Math.max(W, H) * 0.7);
      bl.addColorStop(0, rgba(pal.glassA, 0.5)); bl.addColorStop(1, rgba([4, 6, 12], 0.2));
      g.fillStyle = bl; g.fillRect(0, 0, W, H);
      // jittered grid cells with thick black leading
      const cols = Math.ceil(Math.sqrt(cells * (W / H))), rows = Math.ceil(cells / cols);
      const cw = W / cols, ch = H / rows, glassCols = [pal.glassA, pal.glassB, pal.glassC];
      g.lineJoin = 'round';
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const jx = (hash(r * 31 + c) - 0.5) * cw * 0.4, jy = (hash(r * 17 + c * 7) - 0.5) * ch * 0.4;
        const col = glassCols[(r + c) % 3];
        const x = c * cw, y = r * ch;
        g.beginPath();
        g.moveTo(x + jx, y); g.lineTo(x + cw, y + jy); g.lineTo(x + cw - jx, y + ch); g.lineTo(x, y + ch - jy); g.closePath();
        const cg = g.createLinearGradient(x, y, x + cw, y + ch);
        cg.addColorStop(0, rgba(col, 0.55)); cg.addColorStop(1, rgba(col, 0.28));
        g.fillStyle = cg; g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = Math.max(2, cw * 0.05); g.stroke();
      }
      return oc;
    }
    function drawGlassBG(P) {
      const pal = sc.pal, minDim = Math.min(W, H), t = sc.t;
      const key = `${W}x${H}:${P.palette}:${sc.q.glassCells}`;
      if (st.glassKey !== key) { st.glass = buildGlass(pal, Math.max(18, sc.q.glassCells)); st.glassKey = key; }
      if (st.glass) ctx.drawImage(st.glass, 0, 0); else { ctx.fillStyle = rgba([6, 8, 14], 1); ctx.fillRect(0, 0, W, H); }

      // Evil eye / halo behind the figure.
      const ee = P.evilEyeAmount * (P.backgroundMode === 'evilEye' ? 1.4 : 1);
      if (ee > 0.01) {
        const cx = W * 0.5, cy = H * 0.40, R = minDim * 0.30 * (1 + sc.beat * 0.06);
        ctx.globalCompositeOperation = 'lighter';
        for (let k = 4; k >= 1; k--) {
          ctx.strokeStyle = rgba(pal.glassA, 0.10 * ee);
          ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, R * k / 4, 0, TAU); ctx.stroke();
        }
        // almond eye
        ctx.fillStyle = rgba(EYE_GLOW, 0.10 * ee);
        ctx.beginPath(); ctx.ellipse(cx, cy, R * 0.5, R * 0.24, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = rgba(EYE_CORE, 0.14 * ee);
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.10, 0, TAU); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      // Garden flowers along the bottom.
      const gd = P.gardenAmount * (P.backgroundMode === 'gardenRitual' ? 1.4 : 1);
      if (gd > 0.01) {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 6; i++) {
          const fx = (0.08 + (i / 5) * 0.84) * W, fy = H * (0.9 + 0.05 * Math.sin(i)) + Math.sin(t * 0.4 + i) * 4;
          const fr = minDim * 0.03 * (0.7 + hash(i) * 0.6);
          const col = [pal.glassB, pal.glassC, pal.glassA][i % 3];
          for (let ptl = 0; ptl < 6; ptl++) {
            const ang = (ptl / 6) * TAU + t * 0.05;
            ctx.fillStyle = rgba(col, 0.16 * gd);
            ctx.beginPath(); ctx.ellipse(fx + Math.cos(ang) * fr, fy + Math.sin(ang) * fr, fr * 0.6, fr * 0.3, ang, 0, TAU); ctx.fill();
          }
          ctx.fillStyle = rgba(pal.glassC, 0.22 * gd);
          ctx.beginPath(); ctx.arc(fx, fy, fr * 0.4, 0, TAU); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      // Shimmer sweep + grain.
      ctx.globalCompositeOperation = 'lighter';
      const sweep = ((t * 0.05) % 1.4 - 0.2) * W;
      const sg = ctx.createLinearGradient(sweep, 0, sweep + W * 0.25, H);
      sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, rgba(pal.glassA, 0.05 * P.stainedGlassAmount + sc.mids * 0.05));
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      if (P.glassGrain > 0.01 && sc.q !== QUALITY.low) {
        ctx.globalAlpha = P.glassGrain * 0.08;
        for (let i = 0; i < 60; i++) {
          ctx.fillStyle = (i % 2) ? '#fff' : '#000';
          ctx.fillRect((hash(i + Math.floor(t * 6)) * W) | 0, (hash(i * 3 + Math.floor(t * 6)) * H) | 0, 2, 2);
        }
        ctx.globalAlpha = 1;
      }
    }

    // ── Aura behind head/shoulders (smoothed follow). ───────────────────────
    function drawAura(P) {
      const r = sc.rig, S = sc.S;
      const amt = P.auraAmount + sc.beat * 0.4 * P.audioAuraAmount + sc.loom * 0.4;
      if (amt <= 0.01) return;
      const target = { x: (r.head.x + r.shoulder.x) / 2, y: (r.head.y + r.shoulder.y) / 2 };
      if (!st.aura) st.aura = { ...target };
      st.aura.x = approach(st.aura.x, target.x, sc.dt, 2);
      st.aura.y = approach(st.aura.y, target.y, sc.dt, 2);
      const baseR = (0.5 + sc.loom * 0.25) * S * (1 + sc.beat * 0.15 * P.audioAuraAmount);
      sc.auraR = baseR;
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < sc.q.auraLayers; k++) {
        const rr = baseR * (1 + k * 0.5);
        const gg = ctx.createRadialGradient(st.aura.x, st.aura.y, 0, st.aura.x, st.aura.y, rr);
        gg.addColorStop(0, rgba(AURA_BLUE, 0.22 * amt / (k + 1)));
        gg.addColorStop(0.6, rgba(AURA_BLUE, 0.06 * amt / (k + 1)));
        gg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(st.aura.x, st.aura.y, rr, 0, TAU); ctx.fill();
      }
      // Pose-driven aura tendrils (he reacts to raised hands).
      for (let s = 0; s < 2; s++) {
        const amtT = st.tendril[s];
        if (amtT < 0.02) continue;
        const dir = s === 0 ? -1 : 1;
        const tx = st.aura.x + dir * S * 0.4, ty = st.aura.y - S * 0.2 * amtT;
        const gg = ctx.createRadialGradient(tx, ty, 0, tx, ty, S * 0.3);
        gg.addColorStop(0, rgba(AURA_BLUE, 0.18 * amtT)); gg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(tx, ty, S * 0.3, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── Eyes: layered emissive glass. ───────────────────────────────────────
    function drawEyes(P) {
      const r = sc.rig, S = sc.S;
      const bright = sc.eyeBright;
      const er = r.headR * 0.12;
      ctx.globalCompositeOperation = 'lighter';
      for (const e of r.eyes) {
        // bloom halo
        let g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, er * 8);
        g.addColorStop(0, rgba(EYE_GLOW, 0.5 * bright)); g.addColorStop(0.35, rgba(EYE_GLOW, 0.16 * bright)); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(e.x, e.y, er * 8, 0, TAU); ctx.fill();
        // glow ellipse
        g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, er * 2.4);
        g.addColorStop(0, rgba(EYE_GLOW, 0.9 * bright)); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(e.x, e.y, er * 2.4, 0, TAU); ctx.fill();
        // core
        ctx.fillStyle = rgba(EYE_CORE, Math.min(1, bright)); ctx.beginPath(); ctx.arc(e.x, e.y, er, 0, TAU); ctx.fill();
        // treble sparkle
        if (sc.highs > 0.3) { ctx.fillStyle = rgba(EYE_CORE, sc.highs * 0.6 * P.audioEyeAmount); ctx.beginPath(); ctx.arc(e.x - er * 0.4, e.y - er * 0.4, er * 0.35, 0, TAU); ctx.fill(); }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── Particles (apparition wisps + treble flecks). ───────────────────────
    function updateParticles(P) {
      const r = sc.rig, S = sc.S, dt = sc.dt;
      const apparFx = clamp(sc.appar + (P.backgroundMode === 'apparitionGlass' ? 0.3 : 0), 0, 1);
      const wispRate = apparFx * 40 + sc.highs * P.audioFurAmount * 25;
      const max = sc.q.particles;
      for (let i = 0; i < max; i++) {
        const pt = parts[i];
        if (pt.life <= 0) {
          if (Math.random() < dt * wispRate / Math.max(1, max)) {
            // spawn at a random edge anchor
            const seg = segFor(FUR_GROUPS[(Math.random() * FUR_GROUPS.length) | 0]);
            const tt = Math.random();
            pt.x = lerp(seg[0].x, seg[1].x, tt); pt.y = lerp(seg[0].y, seg[1].y, tt);
            const ang = Math.random() * TAU, sp = (10 + Math.random() * 25) * (S / 320);
            pt.vx = Math.cos(ang) * sp; pt.vy = Math.sin(ang) * sp - 8 * (S / 320);
            pt.life = 0.6 + Math.random() * 1.2; pt.kind = Math.random() < 0.5 ? 0 : 1;
            pt.r = (0.8 + Math.random() * 2.2);
          }
          continue;
        }
        pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vx *= 0.96; pt.vy = pt.vy * 0.96 + 4 * dt; pt.life -= dt;
      }
    }
    function drawParticles() {
      const max = sc.q.particles; if (max <= 0) return;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < max; i++) {
        const pt = parts[i]; if (pt.life <= 0) continue;
        const a = clamp(pt.life, 0, 1) * 0.5;
        ctx.fillStyle = pt.kind === 0 ? rgba(AURA_BLUE, a * 0.6) : rgba(EYE_GLOW, a);
        ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── Debug rig overlay. ──────────────────────────────────────────────────
    function drawDebug(P) {
      const r = sc.rig;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(0,255,180,0.7)'; ctx.lineWidth = 2;
      const bone = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
      bone(r.hips, r.spine); bone(r.spine, r.chest); bone(r.chest, r.shoulder); bone(r.shoulder, r.head);
      for (const a of r.arms) { bone(a.shoulder, a.elbow); bone(a.elbow, a.wrist); bone(a.wrist, a.hand); }
      for (const l of r.legs) { bone(l.hip, l.knee); bone(l.knee, l.ankle); bone(l.ankle, l.foot); }
      const dot = (j, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(j.x, j.y, 4, 0, TAU); ctx.fill(); };
      [r.hips, r.spine, r.chest, r.shoulder, r.head].forEach(j => dot(j, '#ff3b6b'));
      r.arms.forEach(a => { dot(a.elbow, '#ffd23b'); dot(a.wrist, '#ffd23b'); dot(a.hand, '#3bd2ff'); });
      r.legs.forEach(l => { dot(l.knee, '#ffd23b'); dot(l.ankle, '#ffd23b'); dot(l.foot, '#3bd2ff'); });
      // contact points
      r.legs.forEach(l => { if (Math.abs(l.ankle.y - sc.groundY) < 2) { ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(l.foot.x, sc.groundY, 8, 0, TAU); ctx.stroke(); } });
      // HUD
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(8, 8, 210, 116);
      ctx.fillStyle = '#9effdf'; ctx.font = '12px ui-monospace, monospace'; ctx.textBaseline = 'top';
      const lines = [
        `state: ${P.animationState}  bg: ${P.backgroundMode}`,
        `fps: ${st.fps.toFixed(0)}  q: ${P.quality}`,
        `bass ${sc.bass.toFixed(2)} mid ${sc.mids.toFixed(2)} hi ${sc.highs.toFixed(2)}`,
        `beat ${sc.beat.toFixed(2)}  eye ${sc.eyeBright.toFixed(2)}`,
        `loom ${sc.loom.toFixed(2)}  appar ${sc.appar.toFixed(2)}`,
        `gaze ${st.gazeX.toFixed(2)} poseLoom ${st.poseLoom.toFixed(2)}`,
      ];
      lines.forEach((l, i) => ctx.fillText(l, 14, 14 + i * 17));
    }

    function drawContactShadow(P) {
      const r = sc.rig, S = sc.S;
      ctx.globalCompositeOperation = 'multiply';
      for (const leg of r.legs) {
        const planted = Math.abs(leg.ankle.y - sc.groundY) < 0.02 * S ? 1 : 0.3;
        const w = 0.18 * S * (1 + sc.beat * 0.2 * P.audioBodyAmount);
        const cx = leg.foot.x, cy = sc.groundY + 0.01 * S;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w);
        g.addColorStop(0, `rgba(0,0,0,${0.45 * planted})`); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.save(); ctx.translate(cx, cy); ctx.scale(1, 0.22); ctx.beginPath(); ctx.arc(0, 0, w, 0, TAU); ctx.fill(); ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── update() ────────────────────────────────────────────────────────────
    function update(field) {
      const { dt, time, params, pose } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      sc.t = time; sc.dt = dt; sc.params = params;
      sc.pal = PALETTES[params.palette] || PALETTES.cosmic;
      sc.q = QUALITY[params.quality] || QUALITY.high;
      sc.bass = audio.bands.bass; sc.mids = audio.bands.mids; sc.highs = audio.bands.highs;
      sc.rms = audio.rms; sc.beat = audio.beat.pulse;
      st.fps = approach(st.fps, dt > 0 ? 1 / dt : 60, dt, 3);

      // Geometry placement.
      const minDim = Math.min(W, H);
      const loomTarget = clamp((params.animationState === 'loom' ? 0.8 : 0) + params.loomAmount + st.poseLoom, 0, 1.2);
      st.loom = approach(st.loom, loomTarget, dt, 3); sc.loom = st.loom;
      const apparTarget = clamp((params.animationState === 'apparition' ? 0.7 : 0) + params.apparitionAmount + st.ripple, 0, 1);
      st.appar = approach(st.appar, apparTarget, dt, 3); sc.appar = st.appar;

      sc.S = params.bigfootScale * minDim * 0.62 * (1 + sc.loom * 0.12);
      sc.face = 1;
      sc.rootX = W * (0.5 + params.bigfootX);
      sc.groundY = H * (0.82 + params.bigfootY);

      // Pose: he NOTICES (gaze, tendrils, loom, ripple) — smoothed by influence.
      let gazeT = 0, gazeYt = 0, loomP = 0, tnd = [0, 0], rip = 0;
      if (params.poseInfluence > 0 && pose && pose.people && pose.people.length > 0) {
        const p0 = pose.people[0], infl = params.poseInfluence;
        const head = p0.head, sL = p0.shoulders?.l, sR = p0.shoulders?.r, wL = p0.wrists?.l, wR = p0.wrists?.r;
        if (head && head.visibility > 0.3) gazeT = ((1 - head.x) - 0.5) * 2 * infl;
        if (sL && sR && sL.visibility > 0.4 && sR.visibility > 0.4) {
          const span = Math.hypot(sR.x - sL.x, sR.y - sL.y);
          loomP = clamp((span - 0.22) / 0.25, 0, 1) * infl;
          if (st.lastHead && head) { const v = Math.hypot(head.x - st.lastHead.x, head.y - st.lastHead.y); rip = clamp(v * 8, 0, 1) * infl; }
        }
        if (wL && wL.visibility > 0.4) tnd[0] = clamp((0.6 - wL.y) * 2, 0, 1) * infl;
        if (wR && wR.visibility > 0.4) tnd[1] = clamp((0.6 - wR.y) * 2, 0, 1) * infl;
        if (head) st.lastHead = { x: head.x, y: head.y };
      }
      st.gazeX = approach(st.gazeX, gazeT, dt, 4); st.gazeY = approach(st.gazeY, gazeYt, dt, 4);
      st.poseLoom = approach(st.poseLoom, loomP, dt, 3);
      st.tendril[0] = approach(st.tendril[0], tnd[0], dt, 4); st.tendril[1] = approach(st.tendril[1], tnd[1], dt, 4);
      st.ripple = approach(st.ripple, rip, dt, 2);

      // Eye brightness: base glow + breath pulse + bass flare − occlusion dim.
      st.blinkT -= dt;
      if (st.blinkT <= 0) { st.occlude = 1; st.blinkT = 4 + Math.random() * 6; }
      st.occlude = approach(st.occlude, 0, dt, 6);
      const pulse = 1 + (sc.breath - 0.5) * 0.3 * params.eyePulse;
      const eyeTarget = (params.eyeGlow * pulse * (1 + sc.beat * 0.6 * params.audioEyeAmount) + sc.loom * 0.5) * (1 - st.occlude * 0.85);
      st.eyeB = approach(st.eyeB, eyeTarget, dt, 8); sc.eyeBright = st.eyeB;

      // Ritual: still, centered, hunched — override locomotion phase.
      if (params.animationState === 'ritual') { st.p = 0; sc.rootX = W * 0.5; }

      buildRig(params);
    }

    // ── render() ────────────────────────────────────────────────────────────
    function render() {
      if (!sc.rig) return;
      const P = sc.params;
      // backdrop
      if (P.backgroundMode === 'void') drawVoid(P); else drawGlassBG(P);
      // aura behind
      drawAura(P);
      // ground contact
      drawContactShadow(P);
      // body silhouette: void-black fill + tight blue rim
      const path = buildBody();
      ctx.save();
      ctx.shadowColor = rgba(RIM_BLUE, 1);
      ctx.shadowBlur = (0.018 + sc.beat * 0.01) * Math.min(W, H);
      ctx.fillStyle = rgba(VOID_BLACK, 1);
      ctx.fill(path); ctx.fill(path);
      ctx.restore();
      // subtle interior depth so it isn't a flat hole
      ctx.save(); ctx.clip(path);
      const r = sc.rig;
      const ig = ctx.createLinearGradient(0, r.head.y - sc.S, 0, sc.groundY);
      ig.addColorStop(0, rgba([10, 14, 30], 0.5)); ig.addColorStop(1, rgba(VOID_BLACK, 0.9));
      ctx.fillStyle = ig; ctx.fillRect(r.head.x - 1.4 * sc.S, r.head.y - 1.3 * sc.S, 2.8 * sc.S, 2.8 * sc.S);
      ctx.restore();
      // fur edge breakup (dissolves with apparition)
      if (sc.appar < 0.85) drawFur(P);
      // particles + eyes
      updateParticles(P); drawParticles();
      drawEyes(P);
      // debug
      if (P.debugRig) drawDebug(P);
      // vignette
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    return {
      resize(w, h, dpr) { W = w; H = h; DPR = dpr || 1; st.glassKey = ''; },
      update, render,
      dispose() { st.glass = null; },
    };
  },
};
