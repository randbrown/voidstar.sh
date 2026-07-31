// Nightcall — homage to Vincent Belorgey (Kavinsky). The premise of the
// song as a quale, in two modes that auto-phase walks like chapters:
//
//   outrun     — rear view: a vector Testarossa running a dead-straight
//                rain-slick night highway at an enormous low moon, city
//                silhouetted on its face, sodium streetlights strobing
//                past. Named for the cabinet. The road never bends — only
//                the car sways in its lane, so the moon stays nailed to
//                the vanishing point the way it does on the record covers.
//   testarossa — side view: a procedural vector illustration of the legend
//                itself driving through the night — popped headlight beam,
//                the signature side strakes, spinning five-hole rims, the
//                full-width tail light dragging a red trail. 1986 forever.
//   dash       — first person: the same road seen over a cockpit. Kavinsky
//                shot almost no interiors, so the panel takes its cues from
//                KITT instead — seven-segment readouts, banks of LED
//                bargraphs, the voice modulator, the gullwing yoke — in the
//                nightcall palette. Every instrument reads real rig data.
//
// All three share the storm sky: beat-driven branching lightning + sky
// flash, moon god-rays and a vertical light column standing on the horizon.
// Red / white / blue-black only; the palette IS the tribute.
//
// Audio map:
//   bass        -> tail-light bloom, road glow, cruise speed, moon bloom
//   mids        -> dash scroll surge, ray fan spread
//   highs       -> star twinkle, rain shimmer, streetlight sparkle, ray flicker
//   beat.pulse  -> lightning strikes + sky flash, brake flash, beam flare,
//                  light-column punch
//   spectrum    -> city skyline silhouette
//
// Pose map:
//   head.x      -> lane sway (outrun) / car drift (testarossa)
//   head.x rel  -> steering (dash). Measured against a slow baseline, never
//                  absolute: a performer stuck off-centre, or one who can
//                  barely move, still gets a centred wheel that answers
//                  whatever movement they have.
//
// Idle (no audio): the car cruises, dashes scroll, ambient lightning on a
// slow random timer. The night doesn't stop.

import { scaleAudio } from '../field.js';
import { lmToCanvas } from '../video.js';

const TAU = Math.PI * 2;

// Pacing. The whole speed scale runs at half its original rate, so param
// 1.0 is the cruise you actually want and the 4.0 top end is a real ceiling
// rather than a blur. Everything downstream of the resolved speed —
// travelled distance, wheel spin, rain fall, the dash speedo — halves with
// it, so the modes stay in step with each other and with the presets.
const SPEED_SCALE = 0.5;
const HORIZON = 0.44;            // outrun horizon as a fraction of H
const NUM_STARS = 110;
const NUM_RAIN = 150;
const SKY_BINS = 48;             // skyline spectrum bins
const MAX_BOLTS = 6;
const TRUNK_PTS = 16;            // points per lightning trunk
const BRANCHES = 4;              // branches per bolt
const BRANCH_PTS = 7;            // points per branch
const LIGHT_SPACING = 0.16;      // outrun streetlight spacing (depth units)
const NUM_LIGHTS = 7;            // visible poles per side
const NUM_RAYS = 9;              // god-rays standing on the vanishing point
const NUM_CLOUDS = 18;           // puffs in the storm bank
const NUM_WETS = 26;             // wet-asphalt specular streaks
const MOON_SLITS = 7;            // outrun slit bands across the moon's foot
// Maria, as fractions of the moon's radius: x, y, r. Placed by eye for
// balance rather than astronomy — they only ever read as soft shading.
// Seven-segment bit masks, bit 0 = top bar then clockwise, bit 6 = middle.
const SEG_MASK = {
  '0': 0b0111111, '1': 0b0000110, '2': 0b1011011, '3': 0b1001111, '4': 0b1100110,
  '5': 0b1101101, '6': 0b1111101, '7': 0b0000111, '8': 0b1111111, '9': 0b1101111,
  '-': 0b1000000, ' ': 0, 'A': 0b1110111, 'C': 0b0111001, 'E': 0b1111001,
  'F': 0b1110001, 'H': 0b1110110, 'L': 0b0111000, 'P': 0b1110011, 'U': 0b0111110,
};
const CRATERS = [
  [-0.38, -0.30, 0.13], [0.27, -0.47, 0.085], [0.43, 0.09, 0.17],
  [-0.13, 0.31, 0.10], [0.04, -0.09, 0.06], [-0.52, 0.12, 0.07],
];

// The colours of the cover: blue-black night, red glow, cold white. The
// blacks are never neutral — every one of them carries blue.
const SKY_TOP = '#01030c';
const SKY_MID = '#050b1f';
const SKY_HORIZON = '#0b1a3e';
const ROAD = '#070d1e';
const SHOULDER = '#02040e';
const CITY = '#040a1a';

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

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'nightcall',
  name: 'Nightcall',
  contextType: 'canvas2d',

  params: [
    { id: 'mode', label: 'mode', type: 'select',
      options: ['outrun', 'testarossa', 'dash'], default: 'outrun' },
    // 1.0 is the cruise; the scale is normalised so 4.0 is a hard top end
    // you'd actually reach for rather than an unusable blur.
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
    // Moon — how much of the sky the thing eats. At 1.0 it overruns the top
    // of the frame and sinks behind the horizon: you only ever see a slice.
    { id: 'moon', label: 'moon', type: 'range', min: 0, max: 1.6, step: 0.02, default: 1.0 },
    // Rays — the god-ray fan off the moon plus the light column on the
    // vanishing point. The whole scene's sense of depth lives here.
    { id: 'rays', label: 'rays', type: 'range', min: 0, max: 1.5, step: 0.02, default: 0.8,
      modulators: [
        { source: 'audio.highs', mode: 'add', amount: 0.30 },
      ] },
    { id: 'city', label: 'city', type: 'toggle', default: true },
    { id: 'rain', label: 'rain', type: 'range', min: 0, max: 1, step: 0.02, default: 0.6 },
    { id: 'poseInfluence', label: 'pose influence', type: 'range', min: 0, max: 1, step: 0.02, default: 0.5 },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Chapters: outrun cruise → outrun storm → the legend side-on →
  // the legend in the full storm.
  autoPhase: {
    steps: [
      { mode: 'outrun',    storm: 0.25, rain: 0.25, speed: 1.4, moon: 1.0, rays: 0.6 },
      { mode: 'dash',      storm: 0.8,  rain: 0.5,  speed: 1.0, moon: 1.1, rays: 0.8 },
      { mode: 'outrun',    storm: 1.0,  rain: 0.6,  speed: 1.0, moon: 1.3, rays: 1.0 },
      { mode: 'testarossa', storm: 1.0,  rain: 0.5,  speed: 1.0, moon: 1.0, rays: 0.8 },
      { mode: 'dash',      storm: 1.8,  rain: 0.8,  speed: 1.3, moon: 1.2, rays: 1.1 },
      { mode: 'testarossa', storm: 1.8,  rain: 0.9,  glow: 1.4, moon: 1.3, rays: 1.2 },
    ],
  },

  presets: {
    default:    { mode: 'outrun', speed: 1.0, storm: 1.0, glow: 1.0, city: true,
                  rain: 0.6, moon: 1.0, rays: 0.8, poseInfluence: 0.5, reactivity: 1.0 },
    cruise:     { mode: 'outrun', speed: 1.5, storm: 0.25, rain: 0.25, rays: 0.6 },
    storm:      { mode: 'outrun', storm: 1.8, rain: 0.9, glow: 1.3, rays: 1.1 },
    // The record sleeve: moon overrunning the frame, rays wide open.
    moonrise:   { mode: 'outrun', storm: 0.4, rain: 0.35, moon: 1.5, rays: 1.4, speed: 0.8 },
    // Behind the wheel: instruments lit, storm running, road ahead.
    dash:       { mode: 'dash', storm: 1.0, rain: 0.5, moon: 1.1, rays: 0.8,
                  speed: 1.0, glow: 1.0, poseInfluence: 0.6 },
    pursuit:    { mode: 'dash', storm: 1.9, rain: 0.85, speed: 1.6, glow: 1.4,
                  moon: 1.2, rays: 1.2 },
    testarossa: { mode: 'testarossa', storm: 1.0, rain: 0.5 },
    legend:     { mode: 'testarossa', storm: 1.8, rain: 0.9, glow: 1.5, rays: 1.2 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const glowRed = bakeGlow('rgba(255,64,52,1)', 'rgba(214,16,32,0.55)');
    const glowAmber = bakeGlow('rgba(255,228,185,1)', 'rgba(255,195,125,0.40)');
    const glowCold = bakeGlow('rgba(215,228,255,1)', 'rgba(160,185,255,0.40)');
    // Storm bank: a dark puff for the body, an electric one for the pass
    // that lights it from inside when a bolt goes off.
    const puffDark = bakeGlow('rgba(6,12,30,1)', 'rgba(8,16,40,0.62)');
    const puffLit = bakeGlow('rgba(176,214,255,1)', 'rgba(74,140,255,0.42)');

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
    // Skyline bins (EMA-smoothed heights, 0..1) over a fixed base profile.
    // The city is architecture first and a spectrum analyser second: the
    // towers stand whether or not anything is playing, and the music only
    // pushes them up. Without the base the skyline vanishes the moment the
    // mix goes quiet, which is exactly when you most want the silhouette.
    const skyline = new Float32Array(SKY_BINS);
    const cityBase = new Float32Array(SKY_BINS);
    for (let i = 0; i < SKY_BINS; i++) {
      const spike = (i % 11 === 4 || i % 17 === 9) ? 0.30 : 0;
      cityBase[i] = 0.16 + Math.random() * 0.26 + spike
                  + 0.10 * Math.sin(i * 0.8) + 0.06 * Math.sin(i * 2.3 + 1.1);
    }
    // Storm bank: x, y (fractions of the sky box), half-width, half-height,
    // drift rate. Two tiers — a heavy deck sitting low against the horizon
    // and thinner wrack up high — so the sky has a floor and a ceiling.
    const clouds = new Float32Array(NUM_CLOUDS * 5);
    for (let i = 0; i < NUM_CLOUDS; i++) {
      const low = i < NUM_CLOUDS * 0.6;
      clouds[i * 5]     = Math.random();
      clouds[i * 5 + 1] = low ? 0.52 + Math.random() * 0.42 : 0.06 + Math.random() * 0.38;
      clouds[i * 5 + 2] = (low ? 0.16 : 0.11) + Math.random() * 0.16;
      clouds[i * 5 + 3] = (low ? 0.070 : 0.038) + Math.random() * 0.055;
      clouds[i * 5 + 4] = (low ? 0.006 : 0.013) * (0.5 + Math.random());
    }
    // Wet specular highlights on the asphalt: lane offset, length/phase,
    // scroll rate. Scattered off the centreline so they never grid up.
    const wets = new Float32Array(NUM_WETS * 3);
    for (let i = 0; i < NUM_WETS; i++) {
      wets[i * 3]     = (Math.random() * 2 - 1) * 0.86;
      wets[i * 3 + 1] = Math.random();
      wets[i * 3 + 2] = 0.8 + Math.random() * 0.5;
    }
    // God-rays: base angle, angular half-width, drift rate, flicker phase.
    // Fanned across the upper hemisphere off the moon's centre, deliberately
    // uneven so the spread never reads as a clock face.
    const rays = new Float32Array(NUM_RAYS * 4);
    for (let i = 0; i < NUM_RAYS; i++) {
      const spread = -Math.PI * 0.96 + (i + 0.5) * (Math.PI * 0.92 / NUM_RAYS);
      rays[i * 4]     = spread + (Math.random() - 0.5) * 0.16;
      rays[i * 4 + 1] = 0.012 + Math.random() * 0.030;
      rays[i * 4 + 2] = (Math.random() - 0.5) * 0.045;
      rays[i * 4 + 3] = Math.random() * TAU;
    }
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
    // The hot path allocates nothing: every gradient below is built here and
    // reused, and the two that depend on a live param (moon face, moon
    // reflection) are keyed on their radius and rebuilt only when it moves.
    let skyGrad = null, skyGradTall = null, vignette = null, paintGrad = null;
    let moonGrad = null, moonKey = -1, moonPool = null, moonPoolKey = -1;
    let moonHaze = null, moonHazeKey = -1;
    let beamGrad = null, wetGrad = null, fogGrad = null, fogGradTall = null;
    let asphaltGrad = null, rearGrad = null, yokeGrad = null;
    // The three that follow the horizon: outrun and dash look down the same
    // road from different heights, so these are keyed on the geometry rather
    // than baked against one fixed horizon. Only one mode renders per frame,
    // so a single slot each never thrashes.
    let skyKey = -1, asphaltKey = -1, fogKey = -1, beamKey = -1;
    function rebuildGradients() {
      skyKey = asphaltKey = fogKey = beamKey = -1;
      // Side-view sky reaches further down.
      skyGradTall = ctx.createLinearGradient(0, 0, 0, H * 0.70);
      skyGradTall.addColorStop(0, SKY_TOP);
      skyGradTall.addColorStop(0.55, SKY_MID);
      skyGradTall.addColorStop(1, SKY_HORIZON);
      vignette = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.42,
                                          W / 2, H * 0.55, Math.max(W, H) * 0.78);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(1,3,14,0.66)');
      // Wet-road red smear under the car (rebuilt here so render allocates none).
      wetGrad = ctx.createLinearGradient(0, H * 0.935, 0, H);
      wetGrad.addColorStop(0, 'rgba(255,40,45,0.30)');
      wetGrad.addColorStop(1, 'rgba(255,40,45,0)');
      fogGradTall = ctx.createLinearGradient(0, H * 0.70 - H * 0.17, 0, H * 0.70 + H * 0.02);
      fogGradTall.addColorStop(0, 'rgba(46,96,190,0)');
      fogGradTall.addColorStop(0.62, 'rgba(52,104,196,0.13)');
      fogGradTall.addColorStop(1, 'rgba(96,150,235,0.26)');
      // Both depend on car size — lazily rebuilt where they're used.
      paintGrad = null;
      rearGrad = null;
      yokeGrad = null;
      moonKey = moonPoolKey = moonHazeKey = -1;
    }
    rebuildGradients();

    function skyGradFor(hy) {
      if (skyKey !== hy) {
        skyGrad = ctx.createLinearGradient(0, 0, 0, hy);
        skyGrad.addColorStop(0, SKY_TOP);
        skyGrad.addColorStop(0.55, SKY_MID);
        skyGrad.addColorStop(1, SKY_HORIZON);
        skyKey = hy;
      }
      return skyGrad;
    }
    // Asphalt: near-black at the horizon, lifting to a wet blue sheen as it
    // comes at the camera.
    function asphaltFor(hy, bottom) {
      const k = hy * 65536 + bottom;
      if (asphaltKey !== k) {
        asphaltGrad = ctx.createLinearGradient(0, hy, 0, bottom);
        asphaltGrad.addColorStop(0, '#050a18');
        asphaltGrad.addColorStop(0.45, '#0a1324');
        asphaltGrad.addColorStop(1, '#101d3a');
        asphaltKey = k;
      }
      return asphaltGrad;
    }
    // Ground fog banking up against the horizon — the thing that stops the
    // skyline from looking like a sticker on the moon.
    function fogFor(hy) {
      if (fogKey !== hy) {
        fogGrad = ctx.createLinearGradient(0, hy - H * 0.17, 0, hy + H * 0.02);
        fogGrad.addColorStop(0, 'rgba(46,96,190,0)');
        fogGrad.addColorStop(0.62, 'rgba(52,104,196,0.13)');
        fogGrad.addColorStop(1, 'rgba(96,150,235,0.26)');
        fogKey = hy;
      }
      return fogGrad;
    }

    // The light column standing on the vanishing point — bright at the road,
    // gone by the top of the sky.
    function beamFor(hy) {
      if (beamKey !== hy) {
        beamGrad = ctx.createLinearGradient(0, hy, 0, 0);
        beamGrad.addColorStop(0, 'rgba(170,205,255,0.30)');
        beamGrad.addColorStop(0.3, 'rgba(110,160,255,0.09)');
        beamGrad.addColorStop(1, 'rgba(70,120,255,0)');
        beamKey = hy;
      }
      return beamGrad;
    }

    // Moon face + its reflection on the asphalt, keyed on radius.
    // Lit from below and behind: the crown stays a deep steel blue and the
    // foot burns cold white, so the disc reads as an object hanging in the
    // sky instead of a hole punched through it.
    function moonFace(R) {
      if (moonKey !== R) {
        moonGrad = ctx.createLinearGradient(0, -R, 0, R);
        moonGrad.addColorStop(0, '#111e42');
        moonGrad.addColorStop(0.40, '#26406c');
        moonGrad.addColorStop(0.58, '#3d5c8e');
        moonGrad.addColorStop(0.74, '#7396cc');
        moonGrad.addColorStop(0.89, '#bed4f4');
        moonGrad.addColorStop(1, '#eef4ff');
        moonKey = R;
      }
      return moonGrad;
    }
    // Atmosphere eating the moon's foot — same blue as the ground fog, so
    // the disc dissolves into the horizon instead of being cut off by it.
    function moonHazeGrad(R) {
      if (moonHazeKey !== R) {
        moonHaze = ctx.createLinearGradient(0, -R * 0.2, 0, R);
        moonHaze.addColorStop(0, 'rgba(11,26,62,0)');
        moonHaze.addColorStop(0.55, 'rgba(13,34,80,0.35)');
        moonHaze.addColorStop(1, 'rgba(16,46,104,0.72)');
        moonHazeKey = R;
      }
      return moonHaze;
    }
    function moonPoolGrad(len) {
      if (moonPoolKey !== len) {
        moonPool = ctx.createLinearGradient(0, 0, 0, len);
        moonPool.addColorStop(0, 'rgba(196,220,255,0.20)');
        moonPool.addColorStop(0.5, 'rgba(150,185,255,0.07)');
        moonPool.addColorStop(1, 'rgba(120,160,255,0)');
        moonPoolKey = len;
      }
      return moonPool;
    }

    // ── Driving state ───────────────────────────────────────────────────
    let dist = 0;            // travelled distance — scrolls dashes + lights
    let laneX = 0;           // smoothed lane position (-1..1)
    let bank = 0;            // visual bank for the car art
    let wanderP = Math.random() * TAU;
    let flash = 0;           // hard strike flash — fast, blue-white, blows the sky out
    let afterglow = 0;       // slow electric-blue bloom the strike leaves behind
    let idleBoltAt = 4 + Math.random() * 6;   // ambient-strike clock (idle)
    let wheelA = 0;          // side-view wheel rotation (rad)
    // Dash-mode steering. headBase is the slow-moving centre the wheel
    // measures against; -1 means "not seeded yet".
    let steer = 0, steerTarget = 0, idleSteer = Math.random() * TAU;
    let headX = 0, headBase = -1;
    // Instrument values, all EMA'd so the readouts settle like real gauges.
    let mph = 0, rpm = 0, volts = 13.8, temp = 0.42, fuelBurn = 0.72;
    let odo = 0;

    const scratch = {
      time: 0, dt: 0, speed: 1,
      bass: 0, mids: 0, highs: 0, total: 0, beatPulse: 0, rms: 0,
      audioOn: false, brake: 0,
      mode: 'outrun', storm: 1, glow: 1, rainAmt: 0.6, city: true,
      moon: 1, rays: 0.8,
      mph: 0, rpm: 0, volts: 13.8, temp: 0.4, fuel: 0.7, odo: 0, steer: 0,
      waveform: null, spectrum: null, clockH: 0, clockM: 0, clockS: 0,
    };

    function update(field) {
      const params = field.params;
      const audio = scaleAudio(field.audio, params.reactivity);
      const dt = field.dt;
      const audioOn = !!audio.spectrum;
      // Anything that isn't the side view is the rear view — which also
      // silently carries the old 'highway' id forward for anyone whose
      // saved params or Strudel patterns still name it.
      const mode = params.mode === 'testarossa' ? 'testarossa'
                 : params.mode === 'dash' ? 'dash' : 'outrun';

      // Cruise speed — the resolved speed param already carries audio.total.
      const spd = params.speed * SPEED_SCALE
                * (0.65 + audio.bands.bass * 0.4 + audio.bands.mids * 0.25);
      dist += dt * spd * 1.7;
      wheelA += dt * spd * 9;               // side view faces right → rolls CW

      // The road runs dead straight at the moon — nothing here bends it.
      // All the motion lives in the car: pose head leads the sway when
      // someone's in frame, else a slow wander keeps it breathing. Held
      // well inside the lane so the vanishing point never drifts.
      wanderP += dt * 0.25;
      let laneTarget = Math.sin(wanderP) * 0.26 + Math.sin(wanderP * 0.41 + 0.9) * 0.11;
      const inf = params.poseInfluence || 0;
      const people = field.pose && field.pose.people;
      let headSeen = false;
      if (inf > 0.001 && people && people.length) {
        const p = people[0];
        if (p && p.head && p.head.visibility > 0.3) {
          // Screen-aligned head x so leaning left on the mirrored preview
          // steers the car left — same rationale as synthwave's pose shift.
          const [hx] = lmToCanvas(p.head.x, p.head.y, W, H);
          const poseLane = Math.max(-1, Math.min(1, (hx / W - 0.5) * 2.4));
          laneTarget = laneTarget * (1 - inf) + poseLane * inf;
          headX = hx;
          headSeen = true;
          if (headBase < 0) headBase = hx;   // first sighting seeds the baseline
        }
      }
      laneX += (laneTarget - laneX) * Math.min(1, dt * 2.2);
      bank += ((laneTarget - laneX) * 2.5 - bank) * Math.min(1, dt * 6);

      // Steering (dash mode). Deliberately *relative*: a slow baseline
      // follows wherever the performer's head actually lives, and the wheel
      // reads only the departure from it. Someone pinned to the left of
      // frame, or who can barely move, still gets a wheel that sits centred
      // and answers what movement they do have — where an absolute mapping
      // would just hold full lock all night.
      if (headSeen) {
        headBase += (headX - headBase) * Math.min(1, dt * 0.22);
        const rel = (headX - headBase) / (W * 0.055);
        steerTarget = Math.max(-1, Math.min(1, rel));
        // Keep the idle wander's phase advancing while tracked, so losing
        // the pose hands over to it mid-stride instead of with a jump.
        idleSteer += dt * 0.33;
      } else {
        // Nobody in frame — drift on the same slow wander the lane uses.
        idleSteer += dt * 0.33;
        steerTarget = Math.sin(idleSteer * 0.7) * 0.42 + Math.sin(idleSteer * 0.23 + 1.4) * 0.22;
      }
      steer += (steerTarget - steer) * Math.min(1, dt * 2.6);

      // Lightning. Live: every loud hit is a strike — the harder the hit the
      // brighter the bolt and the bigger the sky wash, and the loudest ones
      // fork twice. Idle: an ambient strike every few seconds keeps the
      // night alive.
      const storm = params.storm;
      if (storm > 0.01) {
        if (audioOn) {
          // Loudness of this hit, not just its presence — a soft kick gets a
          // distant flicker, a hard one takes the whole sky.
          const hit = audio.beat.pulse * (0.6 + audio.bands.bass * 0.8);
          if (audio.beat.active && audio.beat.pulse > 0.22 && Math.random() < (0.35 + hit * 0.75) * storm) {
            spawnBolt(hit * storm);
            if (hit > 0.75 && Math.random() < 0.5 * storm) spawnBolt(hit * storm * 0.8);
            flash = Math.max(flash, Math.min(1.15, (0.35 + hit * 0.85) * Math.min(1.4, 0.6 + storm)));
            afterglow = Math.max(afterglow, flash * 0.65);
          }
        } else if (field.time > idleBoltAt) {
          idleBoltAt = field.time + (2 + Math.random() * 5) / Math.max(0.25, storm);
          spawnBolt(0.6 * storm);
          flash = Math.max(flash, 0.5);
          afterglow = Math.max(afterglow, 0.35);
        }
      }
      for (const b of bolts) if (b.life > 0) b.life = Math.max(0, b.life - dt * 3.4);
      // Two envelopes: the strike itself snaps away, the charged blue sky it
      // leaves behind takes a beat or two to bleed off.
      flash = Math.max(0, flash - dt * 3.6);
      afterglow = Math.max(0, afterglow - dt * 0.85);

      // Rain — streaks fall with a shear from the driving speed.
      const rainAmt = params.rain;
      if (rainAmt > 0.01) {
        for (let i = 0; i < NUM_RAIN; i++) {
          const z = rain[i * 4 + 2];
          rain[i * 4 + 1] += dt * rain[i * 4 + 3] * (1.4 + spd * 0.3) * z;
          rain[i * 4]     -= dt * 0.06 * z;
          if (rain[i * 4 + 1] > 1) { rain[i * 4 + 1] -= 1; rain[i * 4] = Math.random(); }
          if (rain[i * 4] < 0) rain[i * 4] += 1;
        }
      }

      // Skyline — the base profile with log-binned spectrum stacked on top,
      // EMA'd so the city breathes rather than flickers. Idle: a slow swell
      // through the same towers.
      if (audioOn) {
        const spec = audio.spectrum;
        const n = spec.length;
        for (let i = 0; i < SKY_BINS; i++) {
          const f0 = Math.pow(n * 0.75, i / SKY_BINS) | 0;
          const f1 = Math.max(f0 + 1, Math.pow(n * 0.75, (i + 1) / SKY_BINS) | 0);
          let sum = 0;
          for (let f = f0; f < f1; f++) sum += spec[f];
          const v = cityBase[i] + ((sum / (f1 - f0)) / 255) * 0.60;
          skyline[i] += (v - skyline[i]) * 0.25;
        }
      } else {
        for (let i = 0; i < SKY_BINS; i++) {
          const v = cityBase[i] + 0.10 * (0.5 + 0.5 * Math.sin(field.time * 0.5 + i * 0.55));
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
      scratch.moon = Math.max(0, params.moon ?? 1);
      scratch.rays = Math.max(0, params.rays ?? 0.8);

      // ── Instruments ───────────────────────────────────────────────────
      // Everything on the dash is derived from what the rig already knows
      // and then damped, so the needles and digits settle the way real
      // gauges do instead of strobing on every frame.
      const mphTarget = 42 + spd * 46 + audio.bands.total * 55 + audio.beat.pulse * 18;
      mph += (mphTarget - mph) * Math.min(1, dt * 1.6);
      const rpmTarget = 1800 + audio.bands.bass * 4200 + audio.bands.mids * 1800
                      + audio.beat.pulse * 1200;
      rpm += (rpmTarget - rpm) * Math.min(1, dt * 4.5);
      volts += ((13.2 + audio.bands.highs * 1.6 + flash * 0.9) - volts) * Math.min(1, dt * 1.1);
      temp += ((0.34 + audio.bands.bass * 0.5 + audio.rms * 0.2) - temp) * Math.min(1, dt * 0.35);
      fuelBurn = Math.max(0.06, fuelBurn - dt * (0.0016 + audio.bands.total * 0.0025));
      if (fuelBurn <= 0.07) fuelBurn = 0.98;      // the night doesn't stop
      odo += dt * mph * 0.0031;

      scratch.mph = mph;
      scratch.rpm = rpm;
      scratch.volts = volts;
      scratch.temp = temp;
      scratch.fuel = fuelBurn;
      scratch.odo = odo;
      scratch.steer = steer;
      scratch.waveform = audio.waveform || null;
      scratch.spectrum = audio.spectrum || null;
      // Wall clock for the chron readout, sampled here so render stays a
      // pure function of scratch.
      const now = new Date();
      scratch.clockH = now.getHours();
      scratch.clockM = now.getMinutes();
      scratch.clockS = now.getSeconds();
    }

    // Road-space helper — p in [0..1], 0 at the horizon, 1 at the bottom.
    // The centreline is fixed at W/2: this road does not bend.
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
    }

    // The strike lighting the world. Two passes, either side of the bolts:
    // the afterglow charges the sky electric blue behind them, then the
    // strike itself blows blue-white across the whole frame — sky, road,
    // car, rain — the way it does on the sleeve art.
    function drawSkyCharge(skyBottom) {
      if (afterglow <= 0.01) return;
      const a = Math.min(1, afterglow);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(38,104,214,${a * 0.30})`;
      ctx.fillRect(0, 0, W, skyBottom);
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawSkyFlash() {
      if (flash <= 0.01) return;
      const a = Math.min(1, flash);
      ctx.globalCompositeOperation = 'lighter';
      // Cold blue-white over everything — this is what makes it a strike
      // and not a filter.
      ctx.fillStyle = `rgba(110,160,255,${a * 0.13})`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = `rgba(215,235,255,${a * a * 0.10})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
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

    // ── Storm bank ──────────────────────────────────────────────────────
    // Dark puffs laid over the moon, then an additive pass in electric blue
    // scaled by the strike envelopes — so the cloud doesn't just sit in
    // front of the lightning, it lights up from the inside with it.
    function drawClouds(skyBottom, t) {
      const drift = t * 0.02;
      const lit = Math.min(1.2, flash * 0.85 + afterglow * 0.5);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, skyBottom); ctx.clip();
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) {
          if (lit < 0.02) break;
          ctx.globalCompositeOperation = 'lighter';
        }
        for (let i = 0; i < NUM_CLOUDS; i++) {
          const rx = clouds[i * 5 + 2] * W;
          const ry = clouds[i * 5 + 3] * skyBottom;
          // Wrap with a full sprite-width of margin so nothing pops in.
          let x = (clouds[i * 5] + drift * clouds[i * 5 + 4] * 60) % 1;
          if (x < 0) x += 1;
          x = x * (W + rx * 4) - rx * 2;
          const y = clouds[i * 5 + 1] * skyBottom;
          if (pass === 0) {
            ctx.globalAlpha = 0.55;
            ctx.drawImage(puffDark, x - rx, y - ry, rx * 2, ry * 2);
          } else {
            // Lit slightly high and tight — the glow is inside the cloud.
            ctx.globalAlpha = Math.min(1, lit * 0.30);
            ctx.drawImage(puffLit, x - rx * 0.78, y - ry * 1.05, rx * 1.56, ry * 1.56);
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // ── The moon ────────────────────────────────────────────────────────
    // Deliberately too big for the frame: it runs off the top and sinks
    // behind the horizon, so you only ever get a slice of it. Everything
    // else in the shot is composed against that slice.
    function drawMoon(cx, cy, R, clipBottom) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, clipBottom); ctx.clip();

      // Bloom behind the disc — bass swells it, a strike blows it out.
      ctx.globalCompositeOperation = 'lighter';
      // Kept to ~2.5R: a bloom this size is pure fill cost, and past that
      // it's all below the alpha you can see anyway.
      ctx.globalAlpha = Math.min(1, 0.34 + scratch.bass * 0.30 + flash * 0.45);
      ctx.drawImage(glowCold, cx - R * 1.25, cy - R * 1.25, R * 2.5, R * 2.5);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      ctx.save();
      ctx.translate(cx, cy);
      // Clip everything below to the disc so shading and slits never spill.
      ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.clip();
      ctx.fillStyle = moonFace(R);
      ctx.fillRect(-R, -R, R * 2, R * 2);

      // Maria — soft, low-contrast, no outlines. Two passes each (a wide
      // wash and a tighter core) so they read as depth, not as circles.
      for (let i = 0; i < CRATERS.length; i++) {
        const c = CRATERS[i];
        ctx.fillStyle = 'rgba(12,26,60,0.10)';
        ctx.beginPath(); ctx.arc(c[0] * R, c[1] * R, c[2] * R * 1.25, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(9,20,50,0.09)';
        ctx.beginPath(); ctx.arc(c[0] * R - c[2] * R * 0.1, c[1] * R - c[2] * R * 0.1,
                                 c[2] * R * 0.72, 0, TAU); ctx.fill();
      }

      // The outrun slits. Confined to the band just above the horizon and
      // opening up as they descend, so the disc appears to dissolve into
      // stripes exactly where it meets the world.
      for (let i = 0; i < MOON_SLITS; i++) {
        const f = i / (MOON_SLITS - 1);          // 0 mid-disc → 1 at the foot
        const y = R * (0.30 + f * 0.44);
        const h = R * (0.005 + f * f * 0.052);
        const half = Math.sqrt(Math.max(0, R * R - y * y));
        ctx.fillStyle = `rgba(6,16,44,${0.30 + f * 0.55})`;
        ctx.fillRect(-half, y, half * 2, h);
      }

      // Atmosphere drowning the base.
      ctx.fillStyle = moonHazeGrad(R);
      ctx.fillRect(-R, -R * 0.2, R * 2, R * 1.2);
      ctx.restore();

      // Cold rim along the crown, and a hot one along the foot where the
      // light is coming from. Outside the clip so they sit on the edge.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.strokeStyle = 'rgba(150,180,240,0.35)';
      ctx.lineWidth = Math.max(1, R * 0.005);
      ctx.beginPath(); ctx.arc(0, 0, R * 0.997, Math.PI * 1.10, Math.PI * 1.90); ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = `rgba(150,190,255,${0.16 + scratch.bass * 0.18})`;
      ctx.lineWidth = Math.max(1, R * 0.020);
      ctx.beginPath(); ctx.arc(0, 0, R * 0.99, Math.PI * 0.20, Math.PI * 0.80); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
      ctx.restore();
    }

    // ── Light column + god-rays ─────────────────────────────────────────
    // Both stand on the vanishing point, which is also where the road goes
    // and where the moon sits. One anchor, everything pointing at it.
    function drawLightColumn(cx, hy, fs) {
      const amt = scratch.rays;
      if (amt <= 0.01) return;
      const punch = 0.5 + scratch.beatPulse * 0.7 + scratch.bass * 0.4;
      const w = Math.max(2 * fs, W * 0.012 * (0.7 + punch * 0.6));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, amt * punch * 0.8);
      ctx.fillStyle = beamFor(hy);
      // Slight flare toward the top — a column, not a stripe.
      ctx.beginPath();
      ctx.moveTo(cx - w, hy);
      ctx.lineTo(cx + w, hy);
      ctx.lineTo(cx + w * 2.6, 0);
      ctx.lineTo(cx - w * 2.6, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function drawRays(cx, cy, hy, t) {
      const amt = scratch.rays;
      if (amt <= 0.01) return;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, hy); ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      const len = Math.hypot(W, H) * 1.3;
      const drive = 0.45 + scratch.total * 0.55 + scratch.beatPulse * 0.45 + flash * 0.9;
      for (let i = 0; i < NUM_RAYS; i++) {
        const a0 = rays[i * 4] + t * rays[i * 4 + 2];
        const hw = rays[i * 4 + 1] * (1 + scratch.mids * 0.9);
        const fl = 0.5 + 0.5 * Math.sin(t * 0.9 + rays[i * 4 + 3]);
        const alpha = 0.045 * amt * drive * fl;
        if (alpha < 0.002) continue;
        ctx.fillStyle = `rgba(146,188,255,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a0 - hw) * len, cy + Math.sin(a0 - hw) * len);
        ctx.lineTo(cx + Math.cos(a0 + hw) * len, cy + Math.sin(a0 + hw) * len);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // ── The road ahead ──────────────────────────────────────────────────
    // Sky, moon, city, weather and the straight highway, drawn between the
    // horizon `hy` and the ground line `bottom`. Outrun runs it to the foot
    // of the frame; dash runs it to a line behind the cowl, which is what
    // lets the same world sit inside a windscreen without redrawing it.
    function drawRoadWorld(hy, bottom) {
      const gh = bottom - hy;
      const t = scratch.time;
      const fs = Math.min(W, H) / 1080;
      const glow = scratch.glow;
      const cx = W * 0.5;            // vanishing point — fixed, always

      ctx.fillStyle = skyGradFor(hy);
      ctx.fillRect(0, 0, W, hy);
      ctx.fillStyle = ROAD;
      ctx.fillRect(0, hy, W, gh);

      drawStars(hy, fs, t);
      // Charged sky first, so the moon and the city sit inside the glow
      // rather than on top of a filter.
      drawSkyCharge(hy);

      // ── The moon ──────────────────────────────────────────────────────
      // Hung so its lower half fills the frame: the crown runs off the top,
      // the foot sinks behind the horizon, and the slits land right where
      // the road meets it.
      const moonR = Math.max(W, H) * 0.34 * scratch.moon;
      const moonY = hy - moonR * 0.72;
      if (scratch.moon > 0.01) drawMoon(cx, moonY, moonR, hy);

      // ── City skyline — a hard silhouette bitten out of the moon ───────
      if (scratch.city) {
        const bw = W / SKY_BINS;
        const maxH = hy * 0.55;
        // Sodium haze first, so the towers stand in front of their own
        // light instead of being smeared by it.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.22 + scratch.mids * 0.18;
        ctx.drawImage(glowAmber, W * 0.5 - hy * 1.0, hy - hy * 0.40, hy * 2.0, hy * 0.52);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = CITY;
        for (let i = 0; i < SKY_BINS; i++) {
          const bh = skyline[i] * maxH;
          ctx.fillRect(i * bw, hy - bh, bw + 0.5, bh);
        }
        // Cold light catching every parapet.
        ctx.fillStyle = 'rgba(160,195,255,0.65)';
        for (let i = 0; i < SKY_BINS; i++) {
          ctx.fillRect(i * bw, hy - skyline[i] * maxH, bw + 0.5, 1.5 * fs + 0.5);
        }
        // Masts on the tall ones, then the aircraft-warning beacons that
        // sit on top of them — tiny red pulses along the whole skyline.
        ctx.fillStyle = CITY;
        for (let i = 3; i < SKY_BINS; i += 7) {
          const top = hy - skyline[i] * maxH;
          ctx.fillRect(i * bw + bw * 0.42, top - maxH * 0.16, Math.max(1, 1.6 * fs), maxH * 0.16);
        }
        ctx.fillStyle = `rgba(255,43,51,${0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.1))})`;
        for (let i = 3; i < SKY_BINS; i += 7) {
          const y = hy - skyline[i] * maxH - maxH * 0.16 - 3 * fs;
          ctx.fillRect(i * bw + bw * 0.32, y, Math.max(1.5, 3 * fs), Math.max(1.5, 3 * fs));
        }
      }

      // Storm bank over the moon and the city — drawn after both so the
      // weather is genuinely between us and the backdrop.
      drawClouds(hy, t);

      // Ground fog banked against the horizon — the moon's foot, the city's
      // base and the road all dissolve into the same blue air.
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = fogFor(hy);
      ctx.fillRect(0, hy - H * 0.17, W, H * 0.19);
      ctx.globalCompositeOperation = 'source-over';

      // Rays and the column go over the moon and the city — light shafts
      // raking across the whole backdrop, all standing on one point.
      drawRays(cx, hy, hy, t);
      drawLightColumn(cx, hy, fs);
      drawLightning(hy, fs, t);

      // The horizon laser — the line off the sleeve, laid along the edge of
      // the world. Sits on the beat and bleeds red into the fog. Kept thin
      // and mostly dark: it's an accent on a blue frame, not a light source.
      const laser = 0.18 + scratch.beatPulse * 0.5 + scratch.bass * 0.28;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, laser * 0.5 * glow);
      ctx.drawImage(glowRed, -W * 0.1, hy - H * 0.035, W * 1.2, H * 0.07);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(255,120,110,${Math.min(1, 0.20 + laser * 0.45)})`;
      ctx.fillRect(0, hy - Math.max(0.5, 0.6 * fs), W, Math.max(1, 1.2 * fs));
      ctx.globalCompositeOperation = 'source-over';

      // ── Road ──────────────────────────────────────────────────────────
      // Straight: a plain trapezoid from the vanishing point to the bottom
      // corners. No per-step polygon needed once the centreline is fixed.
      const halfNear = roadHalf(1);
      ctx.fillStyle = SHOULDER;
      ctx.fillRect(0, hy, W, gh);
      ctx.fillStyle = asphaltFor(hy, bottom);
      ctx.beginPath();
      ctx.moveTo(cx - roadHalf(0), hy);
      ctx.lineTo(cx + roadHalf(0), hy);
      ctx.lineTo(cx + halfNear, bottom);
      ctx.lineTo(cx - halfNear, bottom);
      ctx.closePath();
      ctx.fill();

      // Moonlight smeared down the wet asphalt, straight at the camera —
      // the shot only works because the road never bends away from it.
      const poolLen = gh;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(0, hy);
      ctx.fillStyle = moonPoolGrad(poolLen);
      ctx.globalAlpha = Math.min(1, (0.75 + scratch.rainAmt * 0.85) * (0.6 + scratch.moon * 0.4));
      ctx.beginPath();
      ctx.moveTo(cx - roadHalf(0) * 1.6, 0);
      ctx.lineTo(cx + roadHalf(0) * 1.6, 0);
      ctx.lineTo(cx + halfNear * 0.62, poolLen);
      ctx.lineTo(cx - halfNear * 0.62, poolLen);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Wet specular — thin broken highlights sliding at the camera. This is
      // what makes the asphalt read as soaked rather than merely dark.
      if (scratch.rainAmt > 0.05) {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < NUM_WETS; i++) {
          const off = wets[i * 3], spd = wets[i * 3 + 2];
          let z = (wets[i * 3 + 1] + dist * spd * 0.30) % 1;
          if (z < 0) z += 1;
          const p = z * z;                        // same projection as the dashes
          const y = hy + p * (gh);
          const half = roadHalf(p);
          const len = (gh) * 0.075 * (0.5 + Math.abs(off) * 0.7) * (0.3 + p);
          const w = Math.max(1, half * 0.012);
          ctx.fillStyle = `rgba(150,185,250,${0.03 + p * 0.10 * scratch.rainAmt})`;
          ctx.fillRect(cx + off * half - w * 0.5, y, w, len);
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      // Road glow — bass warms the asphalt red from below.
      const roadGlow = (scratch.bass * 0.5 + scratch.beatPulse * 0.25) * glow;
      if (roadGlow > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(200,20,30,${roadGlow * 0.10})`;
        ctx.beginPath();
        ctx.moveTo(cx - roadHalf(0), hy);
        ctx.lineTo(cx + roadHalf(0), hy);
        ctx.lineTo(cx + halfNear, bottom);
        ctx.lineTo(cx - halfNear, bottom);
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }

      // ── Rumble strips ─────────────────────────────────────────────────
      // Red and white kerb blocks marching up both shoulders. Straight off
      // the arcade cabinet, and the only place in the frame where the red
      // gets to run the full depth of the shot.
      const RUMBLE = 14;
      const rumbleFrac = (dist * 0.5) % (1 / RUMBLE);
      const rumbleBase = Math.floor(dist * 0.5 * RUMBLE);
      for (let i = 0; i < RUMBLE; i++) {
        const z = ((i / RUMBLE) - rumbleFrac + 1) % 1;
        const p0 = 1 - z;
        if (p0 < 0.03) continue;
        const p1 = Math.min(1, p0 + 1 / RUMBLE);
        const pj0 = p0 * p0, pj1 = p1 * p1;
        const y0 = hy + pj0 * (gh), y1 = hy + pj1 * (gh);
        const h0 = roadHalf(pj0), h1 = roadHalf(pj1);
        ctx.fillStyle = ((i + rumbleBase) & 1) ? 'rgba(214,226,250,0.62)' : 'rgba(206,24,40,0.82)';
        for (let side = -1; side <= 1; side += 2) {
          ctx.beginPath();
          ctx.moveTo(cx + side * h0 * 0.98, y0);
          ctx.lineTo(cx + side * h0 * 1.15, y0);
          ctx.lineTo(cx + side * h1 * 1.15, y1);
          ctx.lineTo(cx + side * h1 * 0.98, y1);
          ctx.closePath();
          ctx.fill();
        }
      }
      // Edge lines — cold white, straight to the vanishing point.
      ctx.strokeStyle = 'rgba(210,225,255,0.55)';
      ctx.lineWidth = Math.max(1, 2.2 * fs);
      for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.moveTo(cx + side * roadHalf(0) * 0.97, hy);
        ctx.lineTo(cx + side * halfNear * 0.97, bottom);
        ctx.stroke();
      }

      // Centre dashes — projected world-space stripes scrolling past.
      ctx.fillStyle = 'rgba(238,245,255,0.92)';
      const DASHES = 9;
      const dashFrac = (dist * 0.5) % (1 / DASHES);
      for (let i = 0; i < DASHES; i++) {
        // World z of this dash — decreasing with travelled distance, so the
        // stripes march toward the camera.
        const z = ((i / DASHES) - dashFrac + 1) % 1;
        const p = 1 - z;                          // z=0 near → p=1 bottom
        if (p < 0.06) continue;
        const y0 = hy + p * p * (gh);
        const y1 = hy + Math.min(1, (p + 0.035 * p)) ** 2 * (gh);
        const pj0 = p * p, pj1 = Math.min(1, p + 0.035 * p) ** 2;
        const w0 = Math.max(1, roadHalf(pj0) * 0.048);
        const w1 = Math.max(1, roadHalf(pj1) * 0.048);
        ctx.beginPath();
        ctx.moveTo(cx - w0, y0);
        ctx.lineTo(cx + w0, y0);
        ctx.lineTo(cx + w1, y1);
        ctx.lineTo(cx - w1, y1);
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
        const y = hy + pj * (gh);
        const scale = 0.2 + pj * 1.3;
        const poleH = gh * 0.286 * scale;
        const sparkle = 0.75 + scratch.highs * 0.5;
        for (let side = -1; side <= 1; side += 2) {
          const x = cx + side * roadHalf(pj) * 1.22;
          ctx.strokeStyle = 'rgba(90,105,140,0.5)';
          ctx.lineWidth = Math.max(1, 2.5 * fs * scale);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - poleH); ctx.stroke();
          // Arm over the carriageway, then the head.
          const hxp = x - side * poleH * 0.16;
          const hyp = y - poleH;
          const hr = poleH * 0.22;
          ctx.beginPath(); ctx.moveTo(x, hyp); ctx.lineTo(hxp, hyp); ctx.stroke();
          ctx.globalCompositeOperation = 'lighter';
          // The pool the head throws onto the wet asphalt — flattened into
          // the road plane, which reads as light where a cone reads as a
          // grey wedge stuck to the screen.
          ctx.globalAlpha = Math.min(1, 0.20 * sparkle * (0.45 + scratch.rainAmt * 0.9));
          ctx.drawImage(glowAmber, hxp - poleH * 0.85, y - poleH * 0.20,
                        poleH * 1.7, poleH * 0.40);
          // The head itself.
          ctx.globalAlpha = Math.min(1, 0.55 * sparkle);
          ctx.drawImage(glowAmber, hxp - hr, hyp - hr, hr * 2, hr * 2);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          // Wet-road reflection streak below the head.
          ctx.fillStyle = `rgba(255,215,160,${0.10 * sparkle * (0.4 + scratch.rainAmt)})`;
          ctx.fillRect(hxp - 1.5 * fs * scale, y, 3 * fs * scale, poleH * 0.5);
        }
      }

      // ── Reflector posts — the little amber cat's-eyes on the shoulder ──
      // Twice the density of the poles and dead cheap, they're what gives
      // the middle distance its sense of speed.
      for (let i = 0; i < NUM_LIGHTS * 2; i++) {
        const span = NUM_LIGHTS * LIGHT_SPACING;
        const z = (i * LIGHT_SPACING * 0.5 + (1 - (dist * 0.35) % (LIGHT_SPACING * 0.5))) % span;
        const p = 1 - z / span;
        if (p < 0.03 || p > 0.99) continue;
        const pj = p * p;
        const y = hy + pj * (gh);
        const s = Math.max(1, 3.4 * fs * (0.2 + pj * 1.4));
        ctx.fillStyle = `rgba(255,150,60,${0.25 + pj * 0.55})`;
        for (let side = -1; side <= 1; side += 2) {
          ctx.fillRect(cx + side * roadHalf(pj) * 1.06 - s / 2, y - s * 1.6, s, s);
        }
      }

    }

    // ── Dash instruments ────────────────────────────────────────────────
    // KITT's panels are all seven-segment displays and LED bargraphs, and
    // the thing that makes them read as hardware rather than as text is the
    // *unlit* elements: a real display shows you its dark segments. So both
    // primitives draw the off state first at a fraction of the brightness,
    // then the lit state over it.
    function drawSeg(str, x, y, dw, dh, col, dim, glowA) {
      const t = Math.max(1, dh * 0.13);          // segment thickness
      const g = t * 0.42;                        // gap at the joints
      const w = dw - t;
      const hh = (dh - t) / 2;
      for (let i = 0; i < str.length; i++) {
        const mask = SEG_MASK[str[i]] ?? 0;
        const ox = x + i * (dw + dh * 0.16);
        for (let s = 0; s < 7; s++) {
          const on = (mask >> s) & 1;
          ctx.fillStyle = on ? col : dim;
          // a,d,g horizontal; b,c,e,f vertical.
          if (s === 0)      ctx.fillRect(ox + g, y, w - g * 2, t);
          else if (s === 1) ctx.fillRect(ox + w, y + g, t, hh - g * 2);
          else if (s === 2) ctx.fillRect(ox + w, y + hh + g, t, hh - g * 2);
          else if (s === 3) ctx.fillRect(ox + g, y + hh * 2, w - g * 2, t);
          else if (s === 4) ctx.fillRect(ox, y + hh + g, t, hh - g * 2);
          else if (s === 5) ctx.fillRect(ox, y + g, t, hh - g * 2);
          else              ctx.fillRect(ox + g, y + hh, w - g * 2, t);
        }
      }
      // One soft bloom over the whole run rather than per segment.
      if (glowA > 0.01) {
        const runW = str.length * (dw + dh * 0.16);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, glowA);
        ctx.drawImage(glowRed, x - dh * 0.3, y - dh * 0.45, runW + dh * 0.6, dh * 1.9);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // A stacked LED bargraph. `dir` +1 fills upward, -1 downward.
    function drawBar(x, y, w, h, n, v, palette, lift, dir = 1) {
      const cell = h / n;
      const seg = cell * 0.68;
      const lit = v * n;
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1 || 1);
        const yy = dir > 0 ? y + h - (i + 1) * cell : y + i * cell;
        const on = i < lit;
        const edge = (lit - i);                  // partial top segment
        const a = on ? (edge < 1 ? 0.35 + edge * 0.65 : 1) : 0.13;
        const c = palette(f);
        ctx.fillStyle = on ? `rgba(${c},${Math.min(1, a * (0.75 + lift * 0.35))})`
                           : `rgba(${c},0.10)`;
        ctx.fillRect(x, yy, w, seg);
      }
    }

    // Bargraph colour ramps — KITT's green→amber→red climb, and the two
    // single-colour runs the nightcall palette wants.
    const RAMP_KITT = (f) => (f < 0.45 ? '86,220,120' : f < 0.72 ? '255,190,60' : '255,58,52');
    const RAMP_RED = () => '255,58,52';
    const RAMP_COLD = (f) => (f < 0.7 ? '120,175,255' : '226,240,255');

    function label(text, x, y, size, col, align = 'left') {
      ctx.fillStyle = col;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.max(5, size)}px ui-sans-serif, "Helvetica Neue", Arial, sans-serif`;
      ctx.fillText(text, x, y);
    }

    // A recessed instrument bezel with an inner shadow.
    function panel(x, y, w, h, r) {
      ctx.fillStyle = '#05070d';
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
      ctx.strokeStyle = 'rgba(120,150,205,0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r); ctx.stroke();
    }

    const pad = (n, w) => String(Math.max(0, Math.round(n))).padStart(w, '0').slice(-w);

    // ── Outrun mode (rear view) ─────────────────────────────────────────
    function renderOutrun() {
      const hy = H * HORIZON;
      const fs = Math.min(W, H) / 1080;
      drawRoadWorld(hy, H);
      // The car is the only thing in the frame that moves off centre: it
      // sways in its lane with the pose, held to ±0.55 of the half-width so
      // it never crosses an edge line.
      const pcx = W * 0.5 + laneX * roadHalf(0.94) * 0.55;
      drawRearCar(pcx, H * 0.935, Math.min(W, H) * 0.34, fs, scratch.glow);
    }

    // ── The Testarossa from behind ──────────────────────────────────────
    // Drawn as vectors to match the side view, and because the rear of this
    // car is the most graphic thing about it: full-width slats running clean
    // across the tail, lights burning behind them.
    //
    // Car-space: x as a fraction of the width either side of centre, y as a
    // fraction of the height above the ground contact.
    function drawRearCar(pcx, groundY, CW, fs, glow) {
      const CH = CW * 0.44;
      const X = (u) => pcx + u * CW + bank * CW * 0.035;
      const Y = (v) => groundY - v * CH;
      const tlA = Math.min(1, (0.45 + scratch.bass * 0.55 + scratch.brake * 0.5) * glow);

      // Contact shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.ellipse(pcx, groundY, CW * 0.52, CH * 0.075, 0, 0, TAU);
      ctx.fill();

      // Rear tyres — squat and wide, the Testarossa's whole stance.
      ctx.fillStyle = '#07090f';
      for (let s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.roundRect(X(s * 0.50 - (s > 0 ? 0.115 : 0)), Y(0.34), CW * 0.115, CH * 0.34,
                      [CW * 0.02, CW * 0.02, CW * 0.012, CW * 0.012]);
        ctx.fill();
      }

      // Body. Lower box + the tapering upper deck, one path so the
      // silhouette stays clean.
      if (!rearGrad || rearGrad._h !== CH) {
        rearGrad = ctx.createLinearGradient(0, groundY - CH * 1.02, 0, groundY);
        rearGrad.addColorStop(0, '#ff5a5f');
        rearGrad.addColorStop(0.30, '#e01a2b');
        rearGrad.addColorStop(0.72, '#a00f1e');
        rearGrad.addColorStop(1, '#4c060f');
        rearGrad._h = CH;
      }
      ctx.fillStyle = rearGrad;
      ctx.beginPath();
      ctx.moveTo(X(-0.470), Y(0.10));
      ctx.lineTo(X(-0.500), Y(0.30));      // arch flare at its widest
      ctx.lineTo(X(-0.492), Y(0.56));
      ctx.lineTo(X(-0.400), Y(0.86));      // C-pillar rake
      ctx.lineTo(X(-0.330), Y(0.99));
      ctx.lineTo(X(0.330), Y(0.99));
      ctx.lineTo(X(0.400), Y(0.86));
      ctx.lineTo(X(0.492), Y(0.56));
      ctx.lineTo(X(0.500), Y(0.30));
      ctx.lineTo(X(0.470), Y(0.10));
      ctx.closePath();
      ctx.fill();

      // Rear glass, sunk into the deck.
      ctx.fillStyle = '#070c1c';
      ctx.beginPath();
      ctx.moveTo(X(-0.315), Y(0.985));
      ctx.lineTo(X(0.315), Y(0.985));
      ctx.lineTo(X(0.355), Y(0.828));
      ctx.lineTo(X(-0.355), Y(0.828));
      ctx.closePath();
      ctx.fill();

      // Kavinsky, seen from behind through it. Left-hand drive, so from
      // back here he sits on the right. Just the spikes and the shoulders —
      // at this size anything more turns to mud.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(X(-0.315), Y(0.985));
      ctx.lineTo(X(0.315), Y(0.985));
      ctx.lineTo(X(0.355), Y(0.828));
      ctx.lineTo(X(-0.355), Y(0.828));
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = '#141d38';
      ctx.beginPath();                                  // shoulders
      ctx.ellipse(X(0.145), Y(0.828), CW * 0.115, CH * 0.10, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();                                  // head
      ctx.ellipse(X(0.145), Y(0.895), CW * 0.052, CH * 0.075, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();                                  // the spikes
      ctx.moveTo(X(0.100), Y(0.905));
      ctx.lineTo(X(0.112), Y(0.960));
      ctx.lineTo(X(0.132), Y(0.928));
      ctx.lineTo(X(0.150), Y(0.968));
      ctx.lineTo(X(0.170), Y(0.930));
      ctx.lineTo(X(0.188), Y(0.955));
      ctx.lineTo(X(0.192), Y(0.900));
      ctx.closePath();
      ctx.fill();
      // Dash light catching the edge of him.
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, 0.30 + scratch.bass * 0.35);
      ctx.drawImage(glowRed, X(0.06) - CW * 0.16, Y(0.90) - CH * 0.16,
                    CW * 0.32, CH * 0.32);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();

      // Engine-cover louvres above the tail — the other set of fins.
      ctx.strokeStyle = 'rgba(38,4,10,0.75)';
      ctx.lineWidth = Math.max(1, CH * 0.018);
      for (let i = 0; i < 4; i++) {
        const v = 0.80 - i * 0.045;
        ctx.beginPath();
        ctx.moveTo(X(-0.335 - i * 0.012), Y(v));
        ctx.lineTo(X(0.335 + i * 0.012), Y(v));
        ctx.stroke();
      }

      // ── The tail band ────────────────────────────────────────────────
      // Black egg-crate panel spanning the full width, tail lights burning
      // behind it, then the fins laid over the whole thing — lights and all.
      // Running the fins straight across the lamps is the signature; on the
      // real car the lights are simply what you see through the grille.
      const bandTop = 0.600, bandBot = 0.330;
      ctx.fillStyle = '#08090f';
      ctx.fillRect(X(-0.50), Y(bandTop), CW, Y(bandBot) - Y(bandTop));

      ctx.save();
      ctx.beginPath();
      ctx.rect(X(-0.50), Y(bandTop), CW, Y(bandBot) - Y(bandTop));
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      // Lamps run from the outer edge nearly to the middle, leaving the
      // dark centre section the badge sits over.
      for (let s = -1; s <= 1; s += 2) {
        const lx = X(s * 0.315);
        const ly = Y((bandTop + bandBot) / 2);
        ctx.globalAlpha = Math.min(1, tlA);
        ctx.drawImage(glowRed, lx - CW * 0.24, ly - CH * 0.28, CW * 0.48, CH * 0.56);
        ctx.globalAlpha = Math.min(1, tlA * 0.92);
        ctx.fillStyle = '#ff2b32';
        ctx.fillRect(lx - CW * 0.175, ly - CH * 0.098, CW * 0.35, CH * 0.196);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();

      // Fins — six thin ones straight across, tighter than the eye expects,
      // which is what makes the panel read as a grille and not a stripe.
      const FINS = 6;
      for (let i = 0; i < FINS; i++) {
        const v = bandBot + (i + 0.5) * (bandTop - bandBot) / FINS;
        ctx.fillStyle = '#0a0c12';
        ctx.fillRect(X(-0.50), Y(v), CW, Math.max(1.2, CH * 0.026));
        // A cold edge on top of each, so they read as metal.
        ctx.fillStyle = 'rgba(150,180,235,0.20)';
        ctx.fillRect(X(-0.50), Y(v), CW, Math.max(0.6, CH * 0.007));
      }
      // Prancing-horse badge on the dark centre panel.
      ctx.fillStyle = '#e8c020';
      ctx.fillRect(X(-0.017), Y(0.505), CW * 0.034, CH * 0.075);
      ctx.fillStyle = '#141008';
      ctx.fillRect(X(-0.010), Y(0.494), CW * 0.020, CH * 0.045);

      // ── Valance ──────────────────────────────────────────────────────
      // Black bumper section below the grille: plate dead centre, reversing
      // lamps either side of it, quad pipes underneath.
      ctx.fillStyle = '#0d0f16';
      ctx.fillRect(X(-0.50), Y(bandBot), CW, Y(0.085) - Y(bandBot));
      // Body-colour strip between grille and bumper.
      ctx.fillStyle = 'rgba(150,14,26,0.9)';
      ctx.fillRect(X(-0.50), Y(bandBot), CW, Math.max(1, CH * 0.022));

      // Plate.
      const plW = CW * 0.230, plH = CH * 0.115;
      const plX = X(-0.115), plY = Y(0.285);
      ctx.fillStyle = '#e9eef8';
      ctx.beginPath(); ctx.roundRect(plX, plY, plW, plH, CW * 0.006); ctx.fill();
      ctx.strokeStyle = 'rgba(40,50,70,0.7)';
      ctx.lineWidth = Math.max(0.6, fs * 0.8);
      ctx.beginPath(); ctx.roundRect(plX, plY, plW, plH, CW * 0.006); ctx.stroke();
      ctx.fillStyle = '#131820';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.max(4, plH * 0.72)}px ui-sans-serif, "Helvetica Neue", Arial, sans-serif`;
      ctx.fillText('KVNSKY', plX + plW / 2, plY + plH * 0.55);

      // Reversing lamps flanking the plate.
      for (let s = -1; s <= 1; s += 2) {
        const rx = X(s * 0.215 - (s > 0 ? 0.058 : 0));
        ctx.fillStyle = 'rgba(236,244,255,0.92)';
        ctx.fillRect(rx, Y(0.272), CW * 0.058, CH * 0.052);
        ctx.fillStyle = 'rgba(150,175,215,0.5)';
        ctx.fillRect(rx, Y(0.272), CW * 0.058, Math.max(0.6, CH * 0.010));
      }
      // Quad pipes, clear of the plate.
      for (let i = 0; i < 4; i++) {
        const ex = X(-0.072 + i * 0.048);
        ctx.fillStyle = '#242a35';
        ctx.beginPath(); ctx.arc(ex, Y(0.122), CW * 0.018, 0, TAU); ctx.fill();
        ctx.fillStyle = '#05070b';
        ctx.beginPath(); ctx.arc(ex, Y(0.122), CW * 0.012, 0, TAU); ctx.fill();
      }
      // Diffuser shadow under the valance.
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(X(-0.44), Y(0.095), CW * 0.88, CH * 0.040);

      // Body highlights: rear-deck edge and the two shoulder lines. Cold
      // white, because the only light back here is the moon.
      ctx.strokeStyle = 'rgba(198,220,255,0.30)';
      ctx.lineWidth = Math.max(1, 1.4 * fs);
      ctx.beginPath();
      ctx.moveTo(X(-0.355), Y(0.828)); ctx.lineTo(X(0.355), Y(0.828));
      ctx.stroke();
      // Deck lip along the top of the grille — the ridge the light catches.
      ctx.strokeStyle = 'rgba(255,206,206,0.30)';
      ctx.beginPath();
      ctx.moveTo(X(-0.50), Y(bandTop)); ctx.lineTo(X(0.50), Y(bandTop));
      ctx.stroke();

      // Door mirrors, sitting on the C-pillar shoulders where the
      // Testarossa wears them, just clear of the roofline.
      ctx.fillStyle = '#7c0e16';
      for (let s = -1; s <= 1; s += 2) {
        const u = s * 0.405 - (s > 0 ? 0.048 : 0);
        ctx.beginPath();
        ctx.roundRect(X(u), Y(1.028), CW * 0.048, CH * 0.062, CW * 0.008);
        ctx.fill();
        ctx.fillRect(X(u + (s > 0 ? 0.018 : 0.020)), Y(0.966), CW * 0.011, CH * 0.040);
      }

      // ── Light ────────────────────────────────────────────────────────
      const ly = Y((bandTop + bandBot) / 2);
      const tlR = CW * (0.10 + scratch.brake * 0.05) * (0.7 + glow * 0.3);
      ctx.globalCompositeOperation = 'lighter';
      // Anamorphic streak across both lamps — the wide horizontal flare a
      // long lens gives you, and the reason the covers read as photographs.
      ctx.globalAlpha = tlA * 0.5;
      const streak = CW * (0.95 + scratch.bass * 0.7 + scratch.brake * 0.5);
      ctx.drawImage(glowRed, pcx - streak, ly - tlR * 0.8, streak * 2, tlR * 1.6);
      ctx.globalAlpha = tlA * 0.85;
      for (let s = -1; s <= 1; s += 2) {
        ctx.drawImage(glowRed, X(s * 0.325) - tlR * 2.2, ly - tlR * 2.2, tlR * 4.4, tlR * 4.4);
      }
      // Red reflection smeared down the wet road beneath the car. wetGrad is
      // baked in canvas space over exactly this band — no per-frame gradient.
      ctx.globalAlpha = Math.min(1, tlA * (0.4 + scratch.rainAmt) * 0.85);
      ctx.fillStyle = wetGrad;
      ctx.fillRect(pcx - CW * 0.46, groundY, CW * 0.92, H - groundY);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── Dash mode (first person) ────────────────────────────────────────
    // The road ahead through the screen, and below it a cockpit built on
    // KITT's: seven-segment readouts, banks of LED bargraphs, the voice
    // modulator, and the gullwing wheel. Everything on it is real rig data —
    // spectrum, bands, beat, travelled distance, wall clock — so the panel
    // is an instrument cluster for the music, not a decal of one.
    function renderDash() {
      const t = scratch.time;
      const fs = Math.min(W, H) / 1080;
      const cowl = H * 0.545;                 // top of the dash
      const hy = H * 0.285;                   // horizon, high in the screen
      const beat = scratch.beatPulse;
      const lift = 0.55 + scratch.total * 0.5 + beat * 0.6;

      // ── Through the windscreen ────────────────────────────────────────
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, cowl + 1);
      ctx.clip();
      // Ground line sits just below the cowl, so the road is at its widest
      // where the bodywork cuts it off rather than tapering to nothing.
      drawRoadWorld(hy, H * 0.60);
      drawSkyFlash();
      if (scratch.rainAmt > 0.01) drawRain(fs);
      ctx.restore();

      // Screen tint + the wiped arc across it — a rain-slick windscreen is
      // never optically clean, and the smear is what sells the glass.
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.05 + scratch.rainAmt * 0.06;
      ctx.drawImage(glowCold, -W * 0.1, -H * 0.15, W * 1.2, cowl * 1.2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // ── The cowl ──────────────────────────────────────────────────────
      // A wide shallow arc, higher at the sides where the A-pillars come
      // down, so the screen aperture reads as a screen.
      ctx.fillStyle = '#05070e';
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, cowl - H * 0.055);
      ctx.quadraticCurveTo(W * 0.16, cowl - H * 0.012, W * 0.30, cowl);
      ctx.lineTo(W * 0.70, cowl);
      ctx.quadraticCurveTo(W * 0.84, cowl - H * 0.012, W, cowl - H * 0.055);
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
      // The lit edge along the top of the cowl — the one line that separates
      // the car from the night.
      ctx.strokeStyle = `rgba(150,190,255,${0.16 + beat * 0.14})`;
      ctx.lineWidth = Math.max(1, 1.6 * fs);
      ctx.beginPath();
      ctx.moveTo(0, cowl - H * 0.055);
      ctx.quadraticCurveTo(W * 0.16, cowl - H * 0.012, W * 0.30, cowl);
      ctx.lineTo(W * 0.70, cowl);
      ctx.quadraticCurveTo(W * 0.84, cowl - H * 0.012, W, cowl - H * 0.055);
      ctx.stroke();

      // A-pillars.
      ctx.fillStyle = '#04060c';
      for (let s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        const xo = s < 0 ? 0 : W;
        ctx.moveTo(xo, 0);
        ctx.lineTo(xo - s * W * 0.055, 0);
        ctx.lineTo(xo - s * W * 0.020, cowl - H * 0.05);
        ctx.lineTo(xo, cowl);
        ctx.closePath();
        ctx.fill();
      }

      // ── The binnacle ──────────────────────────────────────────────────
      const bT = cowl + H * 0.016;
      const bH = H * 0.175;
      ctx.fillStyle = '#0a0d15';
      ctx.beginPath();
      ctx.moveTo(W * 0.085, bT);
      ctx.lineTo(W * 0.915, bT);
      ctx.lineTo(W * 0.955, bT + bH);
      ctx.lineTo(W * 0.045, bT + bH);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,155,215,0.20)';
      ctx.lineWidth = Math.max(1, 1.2 * fs);
      ctx.stroke();

      const pT = bT + bH * 0.11, pH = bH * 0.78;

      // Panel 1 — spectrum columns, KITT's climbing ramp.
      {
        const x = W * 0.095, w = W * 0.145;
        panel(x, pT, w, pH, 3);
        const N = 7, colW = w / N;
        for (let i = 0; i < N; i++) {
          const v = specBand(i / N, (i + 1) / N);
          drawBar(x + colW * i + colW * 0.22, pT + pH * 0.16, colW * 0.56, pH * 0.66,
                  9, v, RAMP_KITT, lift);
        }
        label('SPECTRUM ANALYSIS', x + w / 2, pT + pH * 0.93, bH * 0.075,
              'rgba(150,180,235,0.5)', 'center');
      }

      // Panel 2 — speed and the chron.
      {
        const x = W * 0.252, w = W * 0.148;
        panel(x, pT, w, pH, 3);
        const dh = pH * 0.34, dw = dh * 0.60;
        drawSeg(pad(scratch.mph, 3), x + w * 0.10, pT + pH * 0.13, dw, dh,
                `rgba(255,64,52,${0.85 + beat * 0.15})`, 'rgba(90,14,18,0.55)',
                0.16 + beat * 0.22);
        label('MPH', x + w * 0.92, pT + pH * 0.30, bH * 0.085,
              'rgba(255,120,110,0.75)', 'right');
        // Wall clock — the chron, running below the speed.
        const clock = pad(scratch.clockH, 2) + pad(scratch.clockM, 2) + pad(scratch.clockS, 2);
        drawSeg(clock, x + w * 0.09, pT + pH * 0.60, dh * 0.30, dh * 0.52,
                'rgba(255,176,58,0.9)', 'rgba(80,48,10,0.5)', 0.05);
        label('CHRON', x + w * 0.92, pT + pH * 0.72, bH * 0.075,
              'rgba(150,180,235,0.5)', 'right');
      }

      // Panel 3 — the voice modulator. KITT's centrepiece, and the obvious
      // home for the waveform.
      {
        const x = W * 0.412, w = W * 0.176;
        panel(x, pT, w, pH, 3);
        drawModulator(x + w * 0.5, pT + pH * 0.46, w * 0.40, pH * 0.30, lift, beat);
        label('VOICE MODULATION', x + w / 2, pT + pH * 0.93, bH * 0.075,
              'rgba(150,180,235,0.5)', 'center');
      }

      // Panel 4 — engine block: rpm, volts, and the horizontal band meters.
      {
        const x = W * 0.600, w = W * 0.148;
        panel(x, pT, w, pH, 3);
        const dh = pH * 0.22, dw = dh * 0.60;
        drawSeg(pad(scratch.rpm, 4), x + w * 0.08, pT + pH * 0.10, dw, dh,
                'rgba(255,64,52,0.9)', 'rgba(90,14,18,0.5)', 0.10 + beat * 0.14);
        label('RPM', x + w * 0.94, pT + pH * 0.21, bH * 0.075,
              'rgba(150,180,235,0.5)', 'right');
        const rows = [['BASS', scratch.bass, RAMP_RED], ['MIDS', scratch.mids, RAMP_KITT],
                      ['HIGH', scratch.highs, RAMP_COLD]];
        for (let i = 0; i < rows.length; i++) {
          const yy = pT + pH * (0.46 + i * 0.17);
          label(rows[i][0], x + w * 0.06, yy + pH * 0.045, bH * 0.075,
                'rgba(150,180,235,0.5)');
          drawHBar(x + w * 0.36, yy, w * 0.56, pH * 0.09, 12, rows[i][1], rows[i][2], lift);
        }
      }

      // Panel 5 — the scanner screen.
      {
        const x = W * 0.760, w = W * 0.145;
        panel(x, pT, w, pH, 3);
        drawScanner(x + w * 0.06, pT + pH * 0.08, w * 0.88, pH * 0.68, t, lift);
        label('PURSUIT SCAN', x + w / 2, pT + pH * 0.90, bH * 0.075,
              'rgba(150,180,235,0.5)', 'center');
      }

      // ── Lower console ─────────────────────────────────────────────────
      // Split to the wings. The yoke owns the middle of this band, and
      // because its top is open the centre column stays readable straight
      // through it — which is where the odometer and the plate go.
      const cT = bT + bH * 1.10;
      const podW = W * 0.170, podH = H * 0.112;
      drawSwitchPod(W * 0.045, cT, podW, podH, t, beat, [
        ['AIR', 0.55], ['OIL', 0.30], ['P1', 0.8], ['P2', 0.2],
        ['S1', 0.65], ['S2', 0.45],
      ]);
      drawModePod(W * 0.785, cT, podW, podH, beat, t);

      // Diagnostics under each pod, out where the yoke can't reach them.
      {
        const y = cT + podH + H * 0.026, h = H * 0.018, bw = podW * 0.62;
        const items = [
          [W * 0.045, 'FUEL', scratch.fuel, RAMP_KITT],
          [W * 0.045, 'TEMP', scratch.temp, RAMP_KITT],
          [W * 0.785, 'AMP', Math.min(1, (scratch.volts - 12) / 3), RAMP_COLD],
          [W * 0.785, 'TRB', Math.min(1, scratch.rms * 1.4), RAMP_RED],
        ];
        for (let i = 0; i < items.length; i++) {
          const yy = y + (i % 2) * h * 1.9;
          label(items[i][1], items[i][0], yy + h * 0.5, H * 0.014, 'rgba(150,180,235,0.5)');
          drawHBar(items[i][0] + podW * 0.34, yy, bw, h, 9, items[i][2], items[i][3], lift);
        }
      }

      // Odometer and the plate, dead centre in the gap between the horns.
      drawSeg(pad(scratch.odo, 6), W * 0.452, cT + H * 0.012, H * 0.014, H * 0.024,
              'rgba(255,176,58,0.85)', 'rgba(80,48,10,0.45)', 0.05);
      label('KNIGHT INDUSTRIES  ·  NIGHTCALL', W * 0.5, cT + H * 0.055, H * 0.015,
            'rgba(120,155,215,0.34)', 'center');

      // ── The wheel ─────────────────────────────────────────────────────
      // Hub below the frame: from the driver's seat you never see the bottom
      // of the rim, only the two horns coming up at you.
      drawGullwing(W * 0.5 + scratch.steer * W * 0.005, H * 0.955,
                   Math.min(W * 0.235, H * 0.375), fs, beat);
    }

    // Mean of a spectrum slice, 0..1. Falls back to a slow idle swell so the
    // panel still breathes with no audio.
    function specBand(a, b) {
      const spec = scratch.spectrum;
      if (!spec) {
        return 0.18 + 0.16 * (0.5 + 0.5 * Math.sin(scratch.time * 1.3 + a * 9));
      }
      const n = spec.length * 0.72;
      const f0 = Math.pow(n, a) | 0;
      const f1 = Math.max(f0 + 1, Math.pow(n, b) | 0);
      let sum = 0;
      for (let f = f0; f < f1; f++) sum += spec[f];
      return Math.min(1, (sum / (f1 - f0)) / 200);
    }

    function drawHBar(x, y, w, h, n, v, palette, lift) {
      const cell = w / n, seg = cell * 0.7;
      const litN = Math.max(0, Math.min(1, v)) * n;
      for (let i = 0; i < n; i++) {
        const on = i < litN;
        const edge = litN - i;
        const a = on ? (edge < 1 ? 0.35 + edge * 0.65 : 1) : 1;
        const c = palette(i / (n - 1));
        ctx.fillStyle = on ? `rgba(${c},${Math.min(1, a * (0.75 + lift * 0.3))})`
                           : `rgba(${c},0.10)`;
        ctx.fillRect(x + i * cell, y, seg, h);
      }
    }

    // The voice modulator: KITT's oscilloscope oval. Real waveform when
    // there's audio, a breathing sine when there isn't.
    function drawModulator(cx, cy, rx, ry, lift, beat) {
      ctx.save();
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU); ctx.clip();
      ctx.fillStyle = '#03050b';
      ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
      // Graticule.
      ctx.strokeStyle = 'rgba(90,130,200,0.16)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const yy = cy - ry + (ry * 2) * i / 4;
        ctx.beginPath(); ctx.moveTo(cx - rx, yy); ctx.lineTo(cx + rx, yy); ctx.stroke();
      }
      // Trace.
      const wave = scratch.waveform;
      const N = 72;
      ctx.strokeStyle = `rgba(255,72,58,${0.75 + beat * 0.25})`;
      ctx.lineWidth = Math.max(1.2, ry * 0.10);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const f = i / N;
        let v;
        if (wave && wave.length) {
          v = (wave[(f * (wave.length - 1)) | 0] - 128) / 128;
        } else {
          v = Math.sin(f * 9 + scratch.time * 2.4) * 0.42
            * (0.45 + 0.55 * Math.sin(scratch.time * 0.7))
            + Math.sin(f * 23 - scratch.time * 1.7) * 0.14;
        }
        const px = cx - rx + f * rx * 2;
        const py = cy - v * ry * 0.82;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.25 + beat * 0.3;
      ctx.drawImage(glowRed, cx - rx, cy - ry * 1.6, rx * 2, ry * 3.2);
      ctx.globalAlpha = 1;
      ctx.restore();
      ctx.strokeStyle = `rgba(150,190,255,${0.30 + lift * 0.15})`;
      ctx.lineWidth = Math.max(1, ry * 0.07);
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU); ctx.stroke();
    }

    // The scanner screen: a sweeping radar over the road ahead, with the
    // moon marked where it actually is.
    function drawScanner(x, y, w, h, t, lift) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      ctx.fillStyle = '#03060e';
      ctx.fillRect(x, y, w, h);
      const cx = x + w / 2, cy = y + h * 0.94, r = h * 0.92;
      ctx.strokeStyle = 'rgba(96,150,240,0.35)';
      ctx.lineWidth = 1;
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath(); ctx.arc(cx, cy, r * i / 3, Math.PI, TAU); ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - r); ctx.stroke();
      // Sweep.
      const a = -Math.PI + ((t * 0.55) % 1) * Math.PI;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(96,190,255,${0.14 + lift * 0.10})`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a - 0.30, a);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(150,225,255,0.85)';
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.stroke();
      // Contacts: the road's vanishing point dead ahead, plus the moon.
      ctx.fillStyle = 'rgba(255,64,52,0.9)';
      ctx.fillRect(cx - 1.5, cy - r * 0.72, 3, 3);
      ctx.fillStyle = 'rgba(226,240,255,0.8)';
      ctx.fillRect(cx + r * 0.10 - 1.5, cy - r * 0.44, 3, 3);
      ctx.restore();
    }

    // Labelled pushbuttons, KITT's lower-left block.
    function drawSwitchPod(x, y, w, h, t, beat, items) {
      ctx.fillStyle = '#080b12';
      ctx.beginPath(); ctx.roundRect(x, y, w, h, w * 0.04); ctx.fill();
      ctx.strokeStyle = 'rgba(120,155,215,0.18)';
      ctx.lineWidth = 1; ctx.stroke();
      const cols = 2, rows = Math.ceil(items.length / cols);
      const bw = w * 0.40, bh = h / (rows + 0.6);
      for (let i = 0; i < items.length; i++) {
        const c = i % cols, r = (i / cols) | 0;
        const bx = x + w * 0.055 + c * w * 0.48;
        const by = y + h * 0.06 + r * bh;
        // Each switch breathes on its own phase; a beat lifts them together.
        const on = 0.30 + items[i][1] * 0.5
                 + 0.18 * Math.sin(t * (1.1 + i * 0.37) + i) + beat * 0.35;
        ctx.fillStyle = `rgba(255,${120 + i * 12},${40 + i * 6},${Math.min(0.95, on)})`;
        ctx.beginPath(); ctx.roundRect(bx, by, bw, bh * 0.66, bh * 0.14); ctx.fill();
        label(items[i][0], bx + bw / 2, by + bh * 0.34, bh * 0.34,
              'rgba(12,8,4,0.85)', 'center');
      }
    }

    // POWER / AUTO / NORMAL / PURSUIT. Pursuit is the one that answers the
    // kick — the panel's own beat light.
    function drawModePod(x, y, w, h, beat, t) {
      ctx.fillStyle = '#080b12';
      ctx.beginPath(); ctx.roundRect(x, y, w, h, w * 0.04); ctx.fill();
      ctx.strokeStyle = 'rgba(120,155,215,0.18)';
      ctx.lineWidth = 1; ctx.stroke();
      const modes = [
        ['POWER', '86,220,120', 0.75],
        ['AUTO', '255,190,60', 0.55],
        ['NORMAL', '120,175,255', 0.5],
        ['PURSUIT', '255,58,52', 0.35 + beat * 0.65],
      ];
      const bh = h / (modes.length + 0.5);
      for (let i = 0; i < modes.length; i++) {
        const by = y + h * 0.05 + i * bh;
        const a = Math.min(0.95, modes[i][2] + 0.10 * Math.sin(t * 1.7 + i));
        ctx.fillStyle = `rgba(${modes[i][1]},${a})`;
        ctx.beginPath();
        ctx.roundRect(x + w * 0.08, by, w * 0.84, bh * 0.68, bh * 0.16);
        ctx.fill();
        label(modes[i][0], x + w * 0.5, by + bh * 0.35, bh * 0.36,
              'rgba(10,8,6,0.85)', 'center');
      }
    }

    // ── The gullwing wheel ──────────────────────────────────────────────
    // KITT's yoke is not a rim at all — it's one moulded delta: a broad flat
    // face peaking in the middle, sloping down to a grip at each end, with
    // the Knight crest set into the right-hand side. There is no top arc and
    // no spokes. Drawn in units of Rw about the centre of the face so the
    // whole piece rotates as one.
    function drawGullwing(cx, cy, Rw, fs, beat) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(scratch.steer * 0.34);

      const face = () => {
        ctx.beginPath();
        ctx.moveTo(-0.92 * Rw, -0.02 * Rw);                 // left grip root
        ctx.lineTo(-0.64 * Rw, -0.30 * Rw);                 // left shoulder
        ctx.lineTo(-0.07 * Rw, -0.62 * Rw);                 // apex
        ctx.lineTo(0.07 * Rw, -0.62 * Rw);
        ctx.lineTo(0.64 * Rw, -0.30 * Rw);                  // right shoulder
        ctx.lineTo(0.92 * Rw, -0.02 * Rw);                  // right grip root
        ctx.lineTo(0.92 * Rw, 0.30 * Rw);
        ctx.quadraticCurveTo(0.58 * Rw, 0.42 * Rw, 0, 0.42 * Rw);
        ctx.quadraticCurveTo(-0.58 * Rw, 0.42 * Rw, -0.92 * Rw, 0.30 * Rw);
        ctx.closePath();
      };

      // The face, lit from the screen above so the top edges catch and the
      // bottom falls into the footwell.
      if (!yokeGrad || yokeGrad._r !== Rw) {
        yokeGrad = ctx.createLinearGradient(0, -0.62 * Rw, 0, 0.42 * Rw);
        yokeGrad.addColorStop(0, '#20263a');
        yokeGrad.addColorStop(0.45, '#141926');
        yokeGrad.addColorStop(1, '#080a11');
        yokeGrad._r = Rw;
      }
      ctx.fillStyle = yokeGrad;
      face(); ctx.fill();

      // Creases: a pair running parallel to each top edge, and the twin
      // ribs down the centre of the apex.
      ctx.strokeStyle = 'rgba(6,8,14,0.85)';
      ctx.lineWidth = Math.max(1, Rw * 0.020);
      ctx.lineJoin = 'round';
      for (const s of [-1, 1]) {
        for (let i = 0; i < 2; i++) {
          const d = 0.09 + i * 0.11;
          ctx.beginPath();
          ctx.moveTo(s * (0.86 - d * 0.5) * Rw, (0.02 + d) * Rw);
          ctx.lineTo(s * (0.60 - d * 0.4) * Rw, (-0.26 + d) * Rw);
          ctx.lineTo(s * 0.10 * Rw, (-0.58 + d) * Rw);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = 'rgba(8,11,18,0.9)';
      ctx.lineWidth = Math.max(1, Rw * 0.016);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.035 * Rw, -0.60 * Rw);
        ctx.lineTo(s * 0.035 * Rw, 0.36 * Rw);
        ctx.stroke();
      }

      // Moonlight down the two top edges — the only hard highlight on it.
      ctx.strokeStyle = `rgba(150,190,255,${0.26 + beat * 0.12})`;
      ctx.lineWidth = Math.max(1, Rw * 0.017);
      ctx.beginPath();
      ctx.moveTo(-0.92 * Rw, -0.02 * Rw);
      ctx.lineTo(-0.64 * Rw, -0.30 * Rw);
      ctx.lineTo(-0.07 * Rw, -0.62 * Rw);
      ctx.lineTo(0.07 * Rw, -0.62 * Rw);
      ctx.lineTo(0.64 * Rw, -0.30 * Rw);
      ctx.lineTo(0.92 * Rw, -0.02 * Rw);
      ctx.stroke();

      // Dash light spilling red across the lower face.
      ctx.save();
      face(); ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.13 + beat * 0.10;
      ctx.drawImage(glowRed, -Rw * 0.95, Rw * 0.02, Rw * 1.9, Rw * 0.62);
      ctx.restore();

      // The grips: tubes at each end, turned toward the driver.
      for (const s of [-1, 1]) {
        const gx = s * 0.92 * Rw;
        ctx.fillStyle = '#161b28';
        ctx.beginPath();
        // Tops stand a little proud of the face, the way the real tubes do.
        ctx.roundRect(gx - Rw * 0.105, -0.22 * Rw, Rw * 0.21, Rw * 0.84, Rw * 0.105);
        ctx.fill();
        ctx.strokeStyle = 'rgba(150,190,255,0.20)';
        ctx.lineWidth = Math.max(1, Rw * 0.012);
        ctx.beginPath();
        ctx.moveTo(gx - Rw * 0.075, -0.14 * Rw);
        ctx.lineTo(gx - Rw * 0.075, 0.52 * Rw);
        ctx.stroke();
        // Finger grooves down the inner face.
        ctx.strokeStyle = 'rgba(6,8,14,0.7)';
        ctx.lineWidth = Math.max(1, Rw * 0.010);
        for (let i = 0; i < 3; i++) {
          const gy = 0.10 * Rw + i * 0.11 * Rw;
          ctx.beginPath();
          ctx.moveTo(gx - Rw * 0.085, gy);
          ctx.lineTo(gx + Rw * 0.085, gy);
          ctx.stroke();
        }
      }

      // The crest, set into the right of the face.
      const ex = 0.44 * Rw, ey = -0.08 * Rw, er = Rw * 0.085;
      ctx.fillStyle = '#0a0d14';
      ctx.beginPath(); ctx.arc(ex, ey, er * 1.22, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(226,32,42,${0.7 + beat * 0.3})`;
      ctx.beginPath(); ctx.arc(ex, ey, er, 0, TAU); ctx.fill();
      ctx.fillStyle = '#0a0d14';
      ctx.beginPath();
      ctx.moveTo(ex - er * 0.34, ey + er * 0.46);
      ctx.lineTo(ex - er * 0.30, ey - er * 0.20);
      ctx.lineTo(ex + er * 0.10, ey - er * 0.52);
      ctx.lineTo(ex + er * 0.40, ey - er * 0.16);
      ctx.lineTo(ex + er * 0.16, ey - er * 0.04);
      ctx.lineTo(ex + er * 0.20, ey + er * 0.46);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.28 + beat * 0.35;
      ctx.drawImage(glowRed, ex - er * 3, ey - er * 3, er * 6, er * 6);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      ctx.restore();
    }

    // ── Testarossa mode (side view) ─────────────────────────────────────
    // A vector illustration of the car itself, drawn with paths in
    // car-space: u along the length (0 = nose, 1 = tail), v up from the
    // ground, both as fractions of the car's length. Car-space runs
    // nose-left; the whole drawing is mirrored at paint time so the car
    // faces RIGHT on screen, matching the world sliding left past it.
    // Upper silhouette, nose → tail, dense enough that the lineTo chain
    // reads as curves at screen scale. Real-profile proportions: wheel
    // diameter ≈ 0.145 of the length, roof at ≈ 0.235, wedge nose. The rise
    // off the nose has to clear the front tyre with bodywork to spare —
    // level with it and the wheel reads as bursting through the fender.
    const CAR_BODY = [
      [0.000, 0.068], [0.000, 0.098], [0.030, 0.114],
      [0.082, 0.136],                       // hood climbing off the nose
      [0.160, 0.158], [0.230, 0.166],       // fender crown over the front wheel
      [0.300, 0.172],                       // cowl
      [0.325, 0.176], [0.360, 0.196],       // windshield, raked in two steps
      [0.405, 0.222], [0.440, 0.231],
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

    // ── The driver ──────────────────────────────────────────────────────
    // Kavinsky at the wheel, drawn in the same car-space as the body so he
    // rides the pitch and the bob with it: spiked hair, the glasses, the
    // varsity jacket with its sleeve stripes, one hand up on the rim. The
    // lens glint is the only part of him that moves with the music.
    //
    // Car-space runs nose-left and the whole illustration is mirrored at
    // paint time, so he's drawn facing left here and comes out facing the
    // road. Everything sits inside the glasshouse (u 0.34–0.65).
    function drawDriver(X, Y, L, fs) {
      const SKIN = '#6a92d2';        // moonlit, the way the sleeve art has him
      const JACKET = '#1b2748';
      const HAIR = '#131d36';

      // Instrument glow washing the front of the cabin — he's lit by his
      // own dashboard, which is what puts him in the car rather than on it.
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, 0.22 + scratch.bass * 0.32);
      ctx.drawImage(glowRed, X(0.428) - L * 0.045, Y(0.172) - L * 0.032,
                    L * 0.090, L * 0.064);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // Seat back, then the torso against it, leaning into the wheel.
      ctx.fillStyle = '#100a19';
      ctx.beginPath();
      ctx.moveTo(X(0.578), Y(0.158));
      ctx.lineTo(X(0.572), Y(0.204));
      ctx.lineTo(X(0.559), Y(0.206));
      ctx.lineTo(X(0.564), Y(0.158));
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = JACKET;
      ctx.beginPath();
      ctx.moveTo(X(0.566), Y(0.158));
      ctx.lineTo(X(0.560), Y(0.196));
      ctx.lineTo(X(0.532), Y(0.188));       // shoulder
      ctx.lineTo(X(0.516), Y(0.170));
      ctx.lineTo(X(0.520), Y(0.158));
      ctx.closePath();
      ctx.fill();

      // Arm out to the rim, with the varsity sleeve stripes on it.
      ctx.lineCap = 'round';
      ctx.strokeStyle = JACKET;
      ctx.lineWidth = Math.max(1.5, L * 0.0125);
      ctx.beginPath();
      ctx.moveTo(X(0.538), Y(0.186));
      ctx.lineTo(X(0.482), Y(0.175));
      ctx.stroke();
      ctx.strokeStyle = '#c8172a';
      ctx.lineWidth = Math.max(1, L * 0.0028);
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.moveTo(X(0.512 + i * 0.009), Y(0.1855));
        ctx.lineTo(X(0.5115 + i * 0.009), Y(0.1765));
        ctx.stroke();
      }
      ctx.strokeStyle = SKIN;
      ctx.lineWidth = Math.max(1, L * 0.0062);
      ctx.beginPath();
      ctx.moveTo(X(0.481), Y(0.1748));
      ctx.lineTo(X(0.474), Y(0.1730));
      ctx.stroke();
      // The wheel rim his hand is on.
      ctx.strokeStyle = '#0a0d16';
      ctx.lineWidth = Math.max(1, L * 0.005);
      ctx.beginPath();
      ctx.moveTo(X(0.466), Y(0.184));
      ctx.lineTo(X(0.459), Y(0.162));
      ctx.stroke();

      // Head — jaw forward, chin up.
      ctx.fillStyle = SKIN;
      ctx.beginPath();
      ctx.ellipse(X(0.524), Y(0.200), L * 0.0180, L * 0.0210, -0.12, 0, TAU);
      ctx.fill();
      // Jaw shadow along the underside.
      ctx.fillStyle = 'rgba(18,30,60,0.5)';
      ctx.beginPath();
      ctx.ellipse(X(0.528), Y(0.188), L * 0.0160, L * 0.0075, -0.12, 0, TAU);
      ctx.fill();

      // Hair — a swept mass off the brow, breaking into three spikes.
      ctx.fillStyle = HAIR;
      ctx.beginPath();
      ctx.moveTo(X(0.510), Y(0.209));
      ctx.lineTo(X(0.516), Y(0.223));
      ctx.lineTo(X(0.526), Y(0.213));
      ctx.lineTo(X(0.534), Y(0.225));
      ctx.lineTo(X(0.541), Y(0.213));
      ctx.lineTo(X(0.548), Y(0.221));
      ctx.lineTo(X(0.551), Y(0.197));
      ctx.lineTo(X(0.539), Y(0.192));
      ctx.lineTo(X(0.518), Y(0.199));
      ctx.closePath();
      ctx.fill();

      // The glasses, and the glint that rides the beat.
      ctx.fillStyle = '#04060d';
      ctx.beginPath();
      ctx.moveTo(X(0.5035), Y(0.2085));
      ctx.lineTo(X(0.5305), Y(0.2050));
      ctx.lineTo(X(0.5310), Y(0.1975));
      ctx.lineTo(X(0.5040), Y(0.2005));
      ctx.closePath();
      ctx.fill();
      const glint = Math.min(1, 0.35 + scratch.beatPulse * 0.65 + scratch.bass * 0.3);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = glint * 0.85;
      ctx.drawImage(glowRed, X(0.5090) - L * 0.019, Y(0.2035) - L * 0.019,
                    L * 0.038, L * 0.038);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(255,232,224,${Math.min(1, 0.55 + glint * 0.45)})`;
      ctx.beginPath();
      ctx.arc(X(0.5100), Y(0.2035), Math.max(0.9, L * 0.0032), 0, TAU);
      ctx.fill();

      // Cold rim down the back of his head and shoulder, from the rear glass.
      ctx.strokeStyle = 'rgba(150,190,255,0.42)';
      ctx.lineWidth = Math.max(1, 1.2 * fs);
      ctx.beginPath();
      ctx.moveTo(X(0.551), Y(0.214));
      ctx.lineTo(X(0.553), Y(0.194));
      ctx.lineTo(X(0.566), Y(0.161));
      ctx.stroke();
    }

    function drawTestarossa(carX, groundY, L, fs) {
      const glow = scratch.glow;
      const t = scratch.time;
      // Suspension: a soft cruise bob + a bass squat.
      const bob = Math.sin(t * 2.3) * 1.6 * fs + scratch.bass * 4 * fs;
      const pitch = -scratch.beatPulse * 0.008;
      const X = (u) => (u - 0.48) * L;
      const Y = (v) => -v * L;
      // World x of a car-space u — car-space points left, the car faces
      // right, so screen x mirrors about carX.
      const wx = (u) => carX - X(u);

      ctx.save();
      ctx.translate(carX, groundY - bob);
      ctx.scale(-1, 1);   // face right
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
      // Arch shadow, not sky: with real bodywork above the tyre a sky-coloured
      // punch would show as a bright crescent over the wheel.
      ctx.fillStyle = '#05080f';
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
      ctx.moveTo(X(0.338), Y(0.174));
      ctx.lineTo(X(0.418), Y(0.217));
      ctx.lineTo(X(0.445), Y(0.224));
      ctx.lineTo(X(0.540), Y(0.228));
      ctx.lineTo(X(0.612), Y(0.221));
      ctx.lineTo(X(0.648), Y(0.155));
      ctx.closePath();
      ctx.fill();
      // The man himself, behind the glass.
      drawDriver(X, Y, L, fs);

      // A-pillar sweep highlight on the glass.
      ctx.strokeStyle = 'rgba(190,210,255,0.35)';
      ctx.lineWidth = Math.max(1, 1.2 * fs);
      ctx.beginPath();
      ctx.moveTo(X(0.352), Y(0.180));
      ctx.lineTo(X(0.428), Y(0.217));
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
      ctx.moveTo(X(0.035), Y(0.120));
      ctx.quadraticCurveTo(X(0.29), Y(0.170), X(0.42), Y(0.164));
      ctx.moveTo(X(0.66), Y(0.156));
      ctx.lineTo(X(0.982), Y(0.158));
      ctx.stroke();
      // Moon rim light along the roof.
      ctx.strokeStyle = 'rgba(190,210,255,0.45)';
      ctx.lineWidth = Math.max(1, 1.4 * fs);
      ctx.beginPath();
      ctx.moveTo(X(0.30), Y(0.170));
      ctx.lineTo(X(0.405), Y(0.222));
      ctx.quadraticCurveTo(X(0.53), Y(0.243), X(0.65), Y(0.213));
      ctx.lineTo(X(0.82), Y(0.168));
      ctx.stroke();

      // Side mirror, on its stalk at the foot of the A-pillar.
      ctx.strokeStyle = '#5a0a12';
      ctx.lineWidth = Math.max(1, L * 0.005);
      ctx.beginPath(); ctx.moveTo(X(0.352), Y(0.174)); ctx.lineTo(X(0.346), Y(0.188)); ctx.stroke();
      ctx.fillStyle = '#8f1018';
      ctx.beginPath();
      ctx.roundRect(X(0.330), Y(0.206), L * 0.026, L * 0.018, L * 0.004);
      ctx.fill();

      // Pop-up headlight, up for the night — pod + white lamp face.
      ctx.fillStyle = '#b0121f';
      ctx.beginPath();
      ctx.moveTo(X(0.085), Y(0.130));
      ctx.lineTo(X(0.088), Y(0.160));
      ctx.lineTo(X(0.150), Y(0.176));
      ctx.lineTo(X(0.152), Y(0.148));
      ctx.closePath();
      ctx.fill();
      const beam = Math.min(1, 0.55 + scratch.beatPulse * 0.45) * glow;
      ctx.fillStyle = `rgba(235,242,255,${0.85 * Math.min(1, beam + 0.3)})`;
      ctx.fillRect(X(0.086), Y(0.158), L * 0.011, L * 0.024);

      // Front amber marker + tail-light strip.
      ctx.fillStyle = '#ffb43a';
      ctx.fillRect(X(0.004), Y(0.080), L * 0.014, L * 0.015);
      ctx.fillStyle = '#ff2030';
      ctx.fillRect(X(0.986), Y(0.120), L * 0.016, L * 0.056);

      ctx.restore();

      // Lights in world space (unrotated — the pitch is tiny).
      const tailX = wx(1.0), tailY = groundY - bob - 0.095 * L;
      const lampX = wx(0.083), lampY = groundY - bob - 0.146 * L;

      ctx.globalCompositeOperation = 'lighter';
      // Headlight beam — a long cold cone toward the right edge. Two thin
      // stacked passes instead of one slab, so it reads as lit air.
      const beamA = (0.045 + scratch.beatPulse * 0.05 + 0.012 * Math.sin(t * 31)) * glow;
      for (let pass = 0; pass < 2; pass++) {
        const k = pass === 0 ? 1 : 0.42;
        ctx.fillStyle = `rgba(198,220,255,${Math.max(0, beamA * (pass === 0 ? 1 : 1.4))})`;
        ctx.beginPath();
        ctx.moveTo(lampX, lampY - 0.010 * L);
        ctx.lineTo(W * 1.02, lampY - 0.055 * L * k);
        ctx.lineTo(W * 1.02, lampY + 0.10 * L * k);
        ctx.lineTo(lampX, lampY + 0.014 * L);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = Math.min(1, 0.8 * glow);
      ctx.drawImage(glowCold, lampX - 0.05 * L, lampY - 0.05 * L, 0.1 * L, 0.1 * L);

      // Tail light bloom + the red trail dragged behind the car.
      const tlA = Math.min(1, (0.5 + scratch.bass * 0.5 + scratch.brake * 0.4) * glow);
      ctx.globalAlpha = tlA;
      ctx.drawImage(glowRed, tailX - 0.09 * L, tailY - 0.09 * L, 0.18 * L, 0.18 * L);
      const trailLen = L * (0.35 + scratch.bass * 0.55 + scratch.speed * 0.12);
      ctx.globalAlpha = tlA * 0.8;
      // The trail drags out behind the tail — leftward now.
      ctx.drawImage(glowRed, tailX + 0.02 * L - trailLen, tailY - 0.028 * L, trailLen, 0.056 * L);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // Wheels last, over the punched arches.
      const fy = groundY - bob - 0.066 * L;
      drawWheel(wx(FRONT_WHEEL.u), fy, FRONT_WHEEL.r * L, L, fs);
      drawWheel(wx(REAR_WHEEL.u), fy, REAR_WHEEL.r * L, L, fs);
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
      drawSkyCharge(horizonY);
      drawClouds(horizonY, t);

      // The same moon as the outrun view, pushed off to the right so the
      // car gets the centre — still far too big for the frame, still cropped.
      const mr = Math.max(W, H) * 0.26 * scratch.moon;
      if (scratch.moon > 0.01) drawMoon(W * 0.78, horizonY - mr * 0.62, mr, horizonY);

      // Rays stand on the horizon under the moon and rake up across it.
      drawRays(W * 0.78, horizonY, horizonY, t);
      drawLightning(horizonY, fs, t);

      // Scrolling city skyline — same spectrum bins, sliding by as we
      // drive (the car faces right, so the world slides left).
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

      // Ground fog against the horizon, same as the outrun view gets.
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = fogGradTall;
      ctx.fillRect(0, horizonY - H * 0.17, W, H * 0.19);
      ctx.globalCompositeOperation = 'source-over';

      // Road band — a lighter lane the car rides, kerb line, dashes.
      ctx.fillStyle = ROAD;
      ctx.fillRect(0, groundY - H * 0.006, W, H * 0.14);
      ctx.fillStyle = 'rgba(210,225,255,0.5)';
      ctx.fillRect(0, horizonY, W, Math.max(1, 1.6 * fs));
      // Dashes slide left as the car drives right — same scroll as the
      // streetlights, skyline and rain.
      const dashW = W * 0.07, gap = W * 0.115;
      const dx = -((dist * W * 0.22) % gap);
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
        // Arm reaching out over the road.
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

      // Wet-road reflection — a soft red pool beneath the tail, now left.
      const tlA = Math.min(1, (0.5 + scratch.bass * 0.5) * glow) * (0.35 + scratch.rainAmt * 0.5);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = tlA * 0.5;
      ctx.drawImage(glowRed, carX - L * 0.68, groundY - L * 0.02, L * 0.3, L * 0.10);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function render() {
      if (scratch.mode === 'dash') {
        // Dash does its own flash and rain inside the windscreen clip —
        // lightning lights the road ahead, not the instruments.
        renderDash();
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, W, H);
        return;
      }
      if (scratch.mode === 'testarossa') renderTestarossa();
      else renderOutrun();

      // The strike lands on the finished frame — sky, road and car all lift
      // together, then the rain falls through the lit air.
      drawSkyFlash();
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
