// Gear — a wall of electronic-music hardware, procedurally racked and lit.
// Eurorack rows tangled in patch cables next to 19" outboard units (channel
// strips, compressors, mastering limiters, meter bridges), everything
// breathing with the music. Inspired by late-night studio racks: LED
// constellations, glowing cables, VU needles, sequencer chases, round CRT
// scopes, and a sparkle filter for the money shot.
//
// Performance model: the rig is generated once per layout/palette/density
// change and every *dark* thing (faceplates, rails, screws, labels, knob
// bodies, jack bodies, cable sleeves, dim LED segments) is rendered into a
// static offscreen layer that gets blitted each frame. The per-frame pass
// draws only LIGHT: LED glow sprites, knob rings, lit meter segments,
// needles, scope traces, cable glow, signal packets, sparkles, and ambient
// washes. Zero allocation in the hot path (gradients excepted, as per the
// other canvas2d fx).
//
// Audio map:
//   bands.bass   → cable glow (bass-patched cables), VU drive, big LEDs,
//                  warm floor wash
//   bands.mids   → knob rings, gate/activity LEDs, mid cables
//   bands.highs  → twinkle LEDs, sparkle filter, high cables
//   bands.total  → overall panel glow, signal-flow speed
//   beat.pulse   → sequencer step advance, packet launches, panel flash,
//                  peak-pin LEDs
//   highs.pulse  → hat blinks, sparkle bursts, high-cable packets
//   spectrum     → LED matrices (log-binned columns), meter-bridge ladders
//   waveform     → round CRT oscilloscope screens
//   rms          → VU backlight warmth
//
// Idle behavior: with audio off the rig self-patches — a 120 BPM internal
// clock steps the sequencers, LFO-shaped fake bands wander the meters, and
// the scopes draw a slow Lissajous. It should look like the rack was left
// running overnight.
//
// Hero layouts (boombox / dubbing / vintage) swap the rack wall for one
// lovingly-simulated piece of retro gear, framed like a product shot:
//   boombox — an '84 breakdance ghetto blaster. The woofers pump, neon trim
//             rings and floor underglow throb with bass, the graphic-EQ
//             faders dance the spectrum, the tuner hops stations on hard
//             hits, both tape hubs roll (pack radii transfer in real time),
//             and the whole box bumps off the floor on the kick.
//   dubbing — a mid-90s silver mini system (dual-deck Aiwa homage). Cyan
//             VFD spectrum, tape counters flying, a glowing jog ring, both
//             decks rolling at 2× — high speed dubbing, A ► B chevrons
//             chasing between the doors.
//   vintage — a '73 listening room: walnut speaker towers, a backlit tuner
//             dial sweeping the FM band, VU needles, a turntable tracking a
//             record, a reel-to-reel ticking over, dust motes drifting in
//             lamplight. Calm, warm, heavily smoothed ballistics.
//
// Pose drive (hero layouts): the performer is locked in position on stage,
// so absolute landmark coords are ignored — only *relative* motion (frame-
// to-frame joint velocity, folded into an energy + sway signal) stirs the
// neon, meters, tuner and motes. See the `pose drive` param.

import { scaleAudio } from '../field.js';

const MAX_LEDS     = 420;
const MAX_KNOBS    = 132;
const MAX_CABLES   = 56;
const MAX_PACKETS  = 28;
const MAX_SPARKLES = 44;
const MAX_SCOPES   = 2;
const MAX_VUS      = 4;
const MAX_MOTES    = 48;
const ASSUMED_SAMPLE_RATE = 48000;

// ── Palettes ──────────────────────────────────────────────────────────────
// leds: RGB triples for glow sprites. cables: hue pool (deg). wash: [floor
// hue, ceiling hue] for the ambient room light. plate: base panel RGB.
const PALETTES = {
  neon: {
    plate: [15, 17, 27], rail: [42, 46, 62],
    leds: [[255, 62, 200], [57, 255, 136], [62, 224, 255], [176, 77, 255], [255, 210, 62], [240, 245, 255]],
    cables: [318, 140, 190, 275, 48],
    wash: [300, 165],
  },
  crimson: {
    plate: [22, 11, 12], rail: [58, 30, 26],
    leds: [[255, 46, 30], [255, 122, 48], [255, 176, 32], [255, 69, 96], [255, 214, 170], [255, 240, 230]],
    cables: [8, 22, 36, 352, 16],
    wash: [356, 22],
  },
  amber: {
    plate: [24, 18, 9], rail: [62, 48, 24],
    leds: [[255, 176, 32], [255, 206, 90], [255, 232, 160], [255, 148, 24], [255, 250, 220], [255, 190, 60]],
    cables: [38, 44, 30, 50, 34],
    wash: [38, 46],
  },
  dusk: {
    plate: [10, 14, 25], rail: [34, 44, 66],
    leds: [[62, 224, 255], [57, 255, 136], [255, 176, 32], [130, 158, 255], [255, 238, 214], [80, 255, 210]],
    cables: [200, 215, 185, 230, 40],
    wash: [212, 32],
  },
  rainbow: {
    plate: [14, 14, 20], rail: [44, 44, 58],
    leds: [[255, 62, 200], [57, 255, 136], [62, 224, 255], [255, 210, 62], [176, 77, 255], [255, 96, 64]],
    cables: [0, 60, 120, 180, 240, 300],
    wash: [280, 140],
  },
  // Hero-layout house palettes. `bboy` is the boombox's exaggerated street
  // neon, `jade` the cyan/green/red VFD glass of a 90s mini system, `walnut`
  // the warm lamp-lit browns of a 70s listening room. Any palette works with
  // any layout — these are just the canonical pairings.
  bboy: {
    plate: [16, 14, 21], rail: [72, 76, 92],
    leds: [[255, 45, 180], [0, 255, 170], [64, 200, 255], [255, 220, 50], [255, 80, 60], [240, 245, 255]],
    cables: [318, 160, 195, 55],
    wash: [308, 190],
  },
  jade: {
    plate: [24, 26, 28], rail: [118, 124, 132],
    leds: [[60, 255, 180], [80, 230, 255], [255, 64, 70], [255, 176, 32], [190, 255, 230], [240, 250, 255]],
    cables: [160, 190, 0, 45],
    wash: [168, 195],
  },
  walnut: {
    plate: [30, 21, 12], rail: [72, 52, 30],
    leds: [[255, 150, 40], [255, 205, 100], [140, 255, 160], [255, 92, 50], [255, 232, 185], [205, 240, 255]],
    cables: [35, 45, 25],
    wash: [35, 25],
  },
};

// Fake nameplates. Rack brands riff on the voidstar universe; euro module
// names stay generic synth vocabulary.
const RACK_BRANDS = ['VOIDSTAR AUDIO', 'NULL SECTOR', 'QUALIA LABS', 'ENTROPICS', 'OBERHAUS', 'PHASE//9', 'SIGNALWERK', 'DEEP FIELD'];
const RACK_UNITS  = ['MASTER BUS PROCESSOR', 'STEREO COMPRESSOR', 'TRANSIENT DESIGNER', 'PEAK LIMITER', 'CHANNEL STRIP', 'HARMONIC EXCITER', 'TUBE SATURATOR', 'MASTERING EQ'];
const EURO_NAMES  = ['VCO', 'VCF', 'LPG', 'ENV', 'RND', 'CLK', 'MIX', 'FOLD', 'S&H', 'VCA', 'FM', 'RES', 'GRAIN', 'MORPH', 'DRIFT', 'ECHO', 'RING', 'SEQ', 'QNT', 'NOISE'];
const KNOB_LABELS = ['GAIN', 'FREQ', 'RES', 'ATK', 'REL', 'MIX', 'DEPTH', 'RATE', 'TONE', 'DRIVE', 'RATIO', 'THRESH'];

// 7-segment map: segments a,b,c,d,e,f,g per digit 0-9.
const SEG_ON = [
  [1, 1, 1, 1, 1, 1, 0], [0, 1, 1, 0, 0, 0, 0], [1, 1, 0, 1, 1, 0, 1],
  [1, 1, 1, 1, 0, 0, 1], [0, 1, 1, 0, 0, 1, 1], [1, 0, 1, 1, 0, 1, 1],
  [1, 0, 1, 1, 1, 1, 1], [1, 1, 1, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 0, 1, 1],
];
// Segment endpoints in unit space (x0,y0,x1,y1), w=1 h=1.
const SEG_GEO = [
  [0.08, 0.00, 0.92, 0.00],  // a
  [1.00, 0.06, 1.00, 0.46],  // b
  [1.00, 0.54, 1.00, 0.94],  // c
  [0.08, 1.00, 0.92, 1.00],  // d
  [0.00, 0.54, 0.00, 0.94],  // e
  [0.00, 0.06, 0.00, 0.46],  // f
  [0.08, 0.50, 0.92, 0.50],  // g
];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'gear',
  name: 'Gear',
  contextType: 'canvas2d',

  params: [
    { id: 'layout',  label: 'layout',  type: 'select', options: ['wall', 'modular', 'rack', 'boombox', 'dubbing', 'vintage'], default: 'wall' },
    { id: 'palette', label: 'palette', type: 'select', options: ['neon', 'crimson', 'amber', 'dusk', 'rainbow', 'bboy', 'jade', 'walnut'], default: 'neon' },
    { id: 'density', label: 'density', type: 'range', min: 0.5, max: 1.8, step: 0.05, default: 1.0 },
    { id: 'cables',  label: 'cables',  type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0 },
    { id: 'glow',    label: 'glow',    type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total',  mode: 'mul', amount: 0.35 },
        { source: 'crowd.energy', mode: 'add', amount: 0.40 },
      ] },
    { id: 'sparkle', label: 'sparkle', type: 'range', min: 0,   max: 1,   step: 0.02, default: 0.30,
      modulators: [
        { source: 'audio.highsPulse', mode: 'add', amount: 0.35 },
      ] },
    { id: 'flow',    label: 'signal flow', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total', mode: 'mul', amount: 0.30 },
      ] },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'pose', label: 'pose drive', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Phase button tours the studio: neon wall → crimson modular den →
  // blue-hour mastering rack → the vintage listening room → the dubbing
  // deck → gold-hour cable jungle → boombox block party → sparkle finale.
  autoPhase: {
    steps: [
      { layout: 'wall',    palette: 'neon',    cables: 1.0, sparkle: 0.30 },
      { layout: 'modular', palette: 'crimson', cables: 1.6, sparkle: 0.20 },
      { layout: 'rack',    palette: 'dusk',    cables: 0.5, sparkle: 0.15 },
      { layout: 'vintage', palette: 'walnut',  cables: 0.0, sparkle: 0.10 },
      { layout: 'dubbing', palette: 'jade',    cables: 0.0, sparkle: 0.25 },
      { layout: 'modular', palette: 'amber',   cables: 1.8, sparkle: 0.55 },
      { layout: 'boombox', palette: 'bboy',    cables: 0.0, sparkle: 0.55 },
      { layout: 'wall',    palette: 'rainbow', cables: 1.3, sparkle: 0.80 },
    ],
  },

  presets: {
    default:   { layout: 'wall',    palette: 'neon',    density: 1.0, cables: 1.0,  glow: 1.0,  sparkle: 0.30, flow: 1.0, reactivity: 1.0, pose: 1.0 },
    devine:    { layout: 'modular', palette: 'crimson', cables: 1.7,  glow: 1.25, sparkle: 0.20 },
    mastering: { layout: 'rack',    palette: 'dusk',    cables: 0.35, glow: 0.9,  sparkle: 0.15 },
    goldrush:  { layout: 'modular', palette: 'amber',   cables: 1.9,  glow: 1.2,  sparkle: 0.55 },
    stardust:  { layout: 'wall',    palette: 'rainbow', cables: 1.3,  glow: 1.1,  sparkle: 0.90 },
    boombox:   { layout: 'boombox', palette: 'bboy',    glow: 1.15, sparkle: 0.50, flow: 1.2, pose: 1.2 },
    dubbing:   { layout: 'dubbing', palette: 'jade',    glow: 1.0,  sparkle: 0.25, flow: 1.0, pose: 1.0 },
    vintage:   { layout: 'vintage', palette: 'walnut',  glow: 0.85, sparkle: 0.10, flow: 0.7, pose: 0.8 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const seed = (Math.random() * 0xffffffff) >>> 0;

    // ── Rig state (rebuilt on layout/palette/density/cables/resize) ──────
    let rig = null;
    let rigKey = '';
    let pal = PALETTES.neon;
    let LC = null;   // active layout config (set in buildRig)
    let staticLayer = null, staticCtx = null;
    // Glow sprites: one per palette LED color, plus a sparkle star.
    let sprites = [];
    let sparkSprite = null;

    function makeGlowSprite(rgb) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const [r, gg, b] = rgb;
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0.00, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.16, `rgba(${r},${gg},${b},0.90)`);
      grad.addColorStop(0.45, `rgba(${r},${gg},${b},0.28)`);
      grad.addColorStop(1.00, `rgba(${r},${gg},${b},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      return c;
    }

    function makeSparkSprite() {
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      const g = c.getContext('2d');
      g.globalCompositeOperation = 'lighter';
      const arm = (len, wid, rot) => {
        g.save();
        g.translate(48, 48);
        g.rotate(rot);
        const gr = g.createLinearGradient(-len, 0, len, 0);
        gr.addColorStop(0.0, 'rgba(255,255,255,0)');
        gr.addColorStop(0.5, 'rgba(255,255,255,0.95)');
        gr.addColorStop(1.0, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(-len, -wid / 2, len * 2, wid);
        g.restore();
      };
      arm(46, 3.2, 0);
      arm(46, 3.2, Math.PI / 2);
      arm(24, 2.2, Math.PI / 4);
      arm(24, 2.2, -Math.PI / 4);
      const core = g.createRadialGradient(48, 48, 0, 48, 48, 10);
      core.addColorStop(0, 'rgba(255,255,255,0.95)');
      core.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = core;
      g.fillRect(0, 0, 96, 96);
      return c;
    }

    // ── Log-bin sampling for matrices / meter bridges ────────────────────
    // Small per-count cache (2-3 entries); allocation happens only on the
    // first frames after a rig build, then it's stable.
    const logBinCache = new Map();
    function logBins(freqLen, count) {
      const key = freqLen * 64 + count;
      let idx = logBinCache.get(key);
      if (idx) return idx;
      const hz = ASSUMED_SAMPLE_RATE / (freqLen * 2);
      const minF = 35, maxF = 13000, last = freqLen - 1;
      idx = new Int32Array(count + 1);
      for (let i = 0; i <= count; i++) {
        const f = minF * Math.pow(maxF / minF, i / count);
        idx[i] = Math.max(1, Math.min(last, Math.round(f / hz)));
      }
      logBinCache.set(key, idx);
      return idx;
    }
    function sampleSpec(spectrum, bins, i) {
      const lo = bins[i], hi = Math.max(lo + 1, bins[i + 1]);
      let m = 0;
      for (let k = lo; k < hi; k++) if (spectrum[k] > m) m = spectrum[k];
      return m / 255;
    }

    // ── Rig generation ───────────────────────────────────────────────────
    function buildRig(params) {
      const rnd = mulberry32(seed);
      pal = PALETTES[params.palette] || PALETTES.neon;
      const u = Math.min(W, H) / 100;

      rig = {
        u,
        plates: [],   // {x,y,w,h,tone,euro}
        labels: [],   // {x,y,text,size,align,bright}
        screws: [],   // {x,y,rot}
        leds: [],     // {x,y,s,ci,band,kind,th,ph,sq}
        knobs: [],    // {x,y,r,ci,band,base,wob}
        ladders: [],  // {x,y,w,h,n,band,horiz,grn,frac,lvl,peak,peakAge,g}
        vus: [],      // {x,y,w,h,needle,pin}
        scopes: [],   // {x,y,r,ph}
        matrices: [], // {x,y,cols,rows,cell,ci,off,vals}
        seqs: [],     // {x,y,w,h,n,ci,off}
        digits: [],   // {x,y,h,band,val,t,ci,count?}
        jacks: [],    // {x,y}
        cables: [],   // {x0,y0,x1,y1,cx1,cy1,cx2,cy2,hue,band,lw}
        // Hero-layout elements (empty in rack-wall layouts):
        reels: [],    // {x,y,r,hubR,spd,rate,ang,role,ph,pack,big,tint,wx,wy,ww,wh}
        cones: [],    // {x,y,r,band,g,atk,rel,kick,lvl,ring,ci,style}
        sliders: [],  // {x,y,w,h,frac,lvl,ci}
        dials: [],    // {x,y,w,h,pos,target,wait,drift,warm}
        platters: [], // {x,y,r,sq,ang,rpm,arm,pivX,pivY}
        glyphs: [],   // {x,y,text,size,ci,mode,ph}
        motes: [],    // {x,y,vx,vy,ph,x0,y0,w,h}
        hero: null,       // 'boombox' | 'dubbing' | 'vintage' | null
        heroGeom: null,   // device bounding box for washes/underglow
        heroStatic: null, // (g) => paints the device body into the static layer
      };

      const led = (x, y, s, ci, band, kind, sq) => {
        if (rig.leds.length >= MAX_LEDS) return;
        rig.leds.push({ x, y, s, ci, band, kind, th: 0.18 + rnd() * 0.55, ph: rnd() * 1000, sq: !!sq });
      };
      const knob = (x, y, r, ci, band) => {
        if (rig.knobs.length >= MAX_KNOBS) return;
        rig.knobs.push({ x, y, r, ci, band, base: -0.6 + rnd() * 1.2, wob: 0.25 + rnd() * 0.6 });
      };
      const jack = (x, y) => { rig.jacks.push({ x, y }); };
      const pick = (arr) => arr[(rnd() * arr.length) | 0];

      // Layout personalities:
      //   wall    — a dense museum wall of gear: many short rows, narrow
      //             modules, a real mix of euro + 19" racks, moderate patching.
      //   modular — one huge patched synth: few tall rows, ALL eurorack, wide
      //             modules with big knobs and dense jack fields, heavy cabling.
      //   rack    — 19" outboard studio: mostly full-width rack units.
      //   boombox / dubbing / vintage — hero layouts: a single simulated
      //             piece of retro gear, product-shot framed (see file header).
      const layout = params.layout;
      LC = layout === 'modular'
        ? { euroBias: 1.0,  modW: [12, 22], knobScale: 1.5, jackSpacing: 2.6, rowBase: 3.0, rowDens: 1.7, cableMul: 1.7 }
        : layout === 'rack'
        ? { euroBias: 0.14, modW: [8, 16],  knobScale: 1.0, jackSpacing: 3.4, rowBase: 4.4, rowDens: 2.2, cableMul: 0.7 }
        : { euroBias: 0.5,  modW: [5, 9],   knobScale: 0.85, jackSpacing: 3.6, rowBase: 5.6, rowDens: 3.2, cableMul: 0.95 };

      if (layout === 'boombox' || layout === 'dubbing' || layout === 'vintage') {
        rig.hero = layout;
        if (layout === 'boombox') buildBoombox(params, rnd, led, knob);
        else if (layout === 'dubbing') buildDubbing(params, rnd, led, knob);
        else buildVintage(params, rnd, led, knob);
      } else {
        // Row split. Density scales row count; each row is euro or 19" rack.
        const nRows = Math.max(3, Math.min(11,
          Math.round((LC.rowBase + params.density * LC.rowDens) * (H >= W ? 1.15 : 0.9))));
        const railH = Math.max(3, u * 0.9);
        const rowH = H / nRows;

        for (let r = 0; r < nRows; r++) {
          const y = r * rowH;
          const h = rowH - railH;
          if (rnd() < LC.euroBias) buildEuroRow(y, h, rnd, led, knob, jack, pick);
          else buildRackRow(y, h, rnd, led, knob, jack, pick, params);
        }

        buildCables(params, rnd);
      }
      // Sprites + static layer.
      sprites = pal.leds.map(makeGlowSprite);
      if (!sparkSprite) sparkSprite = makeSparkSprite();
      drawStatic();
    }

    // A eurorack row: narrow modules, dense jacks, matrices and mini seqs.
    function buildEuroRow(y, h, rnd, led, knob, jack, pick) {
      const u = rig.u;
      const ks = LC.knobScale;
      let x = 0;
      while (x < W - u * 4) {
        const mw = Math.min(W - x, u * (LC.modW[0] + rnd() * LC.modW[1]));
        const tone = 0.85 + rnd() * 0.5;
        rig.plates.push({ x, y, w: mw, h, tone, euro: true });
        rig.screws.push({ x: x + u * 0.8, y: y + u * 0.8, rot: rnd() * Math.PI });
        rig.screws.push({ x: x + mw - u * 0.8, y: y + h - u * 0.8, rot: rnd() * Math.PI });
        rig.labels.push({
          x: x + mw / 2, y: y + u * 1.6, text: pick(EURO_NAMES),
          size: Math.max(7, u * 1.15), align: 'center', bright: 0.55,
        });

        const inner = { x: x + u * 1.2, y: y + u * 2.6, w: mw - u * 2.4, h: h - u * 5.4 };
        const kind = rnd();
        if (kind < 0.14 && rig.matrices.length < 3 && inner.w > u * 9) {
          buildMatrix(inner, rnd);
        } else if (kind < 0.22 && rig.scopes.length < MAX_SCOPES && inner.w > u * 9 && inner.h > u * 8) {
          const r = Math.min(inner.w, inner.h) * 0.42;
          rig.scopes.push({ x: inner.x + inner.w / 2, y: inner.y + r + u, r, ph: rnd() * 10 });
        } else if (kind < 0.34 && inner.w > u * 8) {
          buildSeq(inner, rnd);
        } else if (kind < 0.46) {
          // LED ladder column(s) + a couple of knobs.
          const n = 8 + ((rnd() * 8) | 0);
          rig.ladders.push({
            x: inner.x + inner.w * 0.18, y: inner.y, w: Math.max(3, u * 1.1), h: inner.h * 0.62,
            n, band: (rnd() * 4) | 0, horiz: false, grn: false, frac: rnd(),
            lvl: 0, peak: 0, peakAge: 0, g: 0.85 + rnd() * 0.5,
          });
          knob(inner.x + inner.w * 0.68, inner.y + inner.h * 0.22, u * (1.4 + rnd()) * ks, (rnd() * pal.leds.length) | 0, (rnd() * 3) | 0);
        } else {
          // Knob stack.
          const rows = Math.max(1, Math.min(3, (inner.h / (u * 6)) | 0));
          for (let kr = 0; kr < rows; kr++) {
            const ky = inner.y + inner.h * ((kr + 0.5) / rows) * 0.72;
            const perRow = inner.w > u * 10 ? 2 : 1;
            for (let kc = 0; kc < perRow; kc++) {
              const kx = inner.x + inner.w * ((kc + 0.5) / perRow);
              knob(kx, ky, u * (1.3 + rnd() * 1.3) * ks, (rnd() * pal.leds.length) | 0, (rnd() * 3) | 0);
            }
          }
          // Activity LEDs beside knobs.
          const nl = 1 + ((rnd() * 3) | 0);
          for (let i = 0; i < nl; i++) {
            led(x + mw * (0.25 + rnd() * 0.5), y + u * (3 + rnd() * 1.6),
              u * 2.2, (rnd() * pal.leds.length) | 0, (rnd() * 4) | 0,
              rnd() < 0.5 ? 'gate' : 'twinkle');
          }
        }

        // Jack field along the module bottom — the patch bay. Modular
        // layouts pack tighter (more jacks ⇒ more cabling opportunity).
        const jy = y + h - u * 1.9;
        const nj = Math.max(2, Math.min(8, (mw / (u * LC.jackSpacing)) | 0));
        for (let i = 0; i < nj; i++) {
          jack(x + mw * ((i + 0.5) / nj), jy);
        }
        x += mw;
      }
    }

    // A 19" rack row: one full-width unit with ears, brand block, knobs,
    // meters. Archetype chosen at random.
    function buildRackRow(y, h, rnd, led, knob, jack, pick, params) {
      const u = rig.u;
      const earW = u * 2.2;
      const x = earW, w = W - earW * 2;
      const tone = 0.9 + rnd() * 0.35;
      rig.plates.push({ x: 0, y, w: W, h, tone: tone * 0.55, euro: false });   // ears strip
      rig.plates.push({ x, y: y + u * 0.4, w, h: h - u * 0.8, tone, euro: false });
      for (const sx of [earW * 0.5, W - earW * 0.5]) {
        rig.screws.push({ x: sx, y: y + u * 1.2, rot: rnd() * Math.PI });
        rig.screws.push({ x: sx, y: y + h - u * 1.2, rot: rnd() * Math.PI });
      }
      rig.labels.push({
        x: x + u * 1.6, y: y + u * 2.1, text: pick(RACK_BRANDS),
        size: Math.max(8, u * 1.35), align: 'left', bright: 0.85,
      });
      rig.labels.push({
        x: x + u * 1.6, y: y + u * 3.6, text: pick(RACK_UNITS),
        size: Math.max(7, u * 1.0), align: 'left', bright: 0.4,
      });

      const cy = y + h * 0.58;
      const arch = rnd();
      if (arch < 0.30 && rig.vus.length < MAX_VUS) {
        // Mastering unit: symmetric knobs + backlit VU pair.
        const vw = Math.min(w * 0.18, u * 16), vh = Math.min(h * 0.5, vw * 0.62);
        for (const vx of [x + w * 0.68, x + w * 0.88]) {
          if (rig.vus.length < MAX_VUS) {
            rig.vus.push({ x: vx - vw / 2, y: cy - vh / 2, w: vw, h: vh, needle: 0, pin: 0 });
          }
        }
        for (let i = 0; i < 5; i++) {
          knob(x + w * (0.08 + i * 0.11), cy, u * (1.8 + rnd() * 0.9), (rnd() * pal.leds.length) | 0, i % 3);
        }
        for (let i = 0; i < 4; i++) {
          led(x + w * (0.08 + i * 0.11), y + h - u * 1.7, u * 2.0, (rnd() * pal.leds.length) | 0, (rnd() * 4) | 0, 'gate', true);
        }
      } else if (arch < 0.58) {
        // Compressor: big knobs, horizontal gain-reduction LED row, digits.
        const n = 12 + ((rnd() * 8) | 0);
        rig.ladders.push({
          x: x + w * 0.36, y: y + u * 2.0, w: w * 0.34, h: Math.max(4, u * 1.5),
          n, band: 0, horiz: true, grn: true, frac: 0,
          lvl: 0, peak: 0, peakAge: 0, g: 1.0,
        });
        for (let i = 0; i < 4; i++) {
          knob(x + w * (0.10 + i * 0.075), cy, u * (2.0 + rnd() * 1.2), (rnd() * pal.leds.length) | 0, i % 3);
          rig.labels.push({
            x: x + w * (0.10 + i * 0.075), y: cy + u * 4.2, text: KNOB_LABELS[(rnd() * KNOB_LABELS.length) | 0],
            size: Math.max(6, u * 0.8), align: 'center', bright: 0.35,
          });
        }
        if (rig.digits.length < 4) {
          rig.digits.push({ x: x + w * 0.80, y: cy - u * 1.6, h: u * 3.2, band: (rnd() * 4) | 0, val: 0, t: rnd(), ci: (rnd() * pal.leds.length) | 0 });
        }
        for (let i = 0; i < 6; i++) {
          led(x + w * (0.46 + i * 0.045), cy + u * 1.5, u * 1.9, (rnd() * pal.leds.length) | 0, (rnd() * 4) | 0, rnd() < 0.6 ? 'gate' : 'steady');
        }
      } else if (arch < 0.78) {
        // Meter bridge: a row of vertical spectrum ladders — the rack
        // becomes a full-width analyzer.
        const n = Math.min(18, Math.max(8, (w / (u * 5)) | 0));
        for (let i = 0; i < n; i++) {
          rig.ladders.push({
            x: x + w * ((i + 0.5) / n) - u * 0.65, y: y + u * 1.6, w: Math.max(3, u * 1.3), h: h - u * 3.4,
            n: 12, band: -1, horiz: false, grn: i % 3 === 0, frac: i / Math.max(1, n - 1),
            lvl: 0, peak: 0, peakAge: 0, g: 0.9 + rnd() * 0.35,
          });
        }
      } else {
        // Channel strip / EQ: a long row of small knobs + status LEDs.
        const n = Math.min(10, Math.max(6, (w / (u * 9)) | 0));
        for (let i = 0; i < n; i++) {
          const kx = x + w * ((i + 0.5) / n);
          knob(kx, cy, u * (1.5 + rnd() * 0.8), (rnd() * pal.leds.length) | 0, i % 3);
          if (rnd() < 0.7) {
            led(kx, y + u * 2.1, u * 1.9, (rnd() * pal.leds.length) | 0, (rnd() * 4) | 0,
              rnd() < 0.4 ? 'pulse' : 'gate');
          }
        }
        // A rack unit gets a few rear-patch jacks too.
        for (let i = 0; i < 3; i++) jack(x + w * (0.86 + i * 0.05), y + h - u * 1.6);
      }
    }

    function buildMatrix(inner, rnd) {
      const u = rig.u;
      const cell = Math.max(4, u * 1.5);
      const cols = Math.max(4, Math.min(16, (inner.w / (cell * 1.35)) | 0));
      const rows = Math.max(3, Math.min(8, (inner.h * 0.8 / (cell * 1.35)) | 0));
      rig.matrices.push({
        x: inner.x + (inner.w - cols * cell * 1.35) / 2, y: inner.y,
        cols, rows, cell, ci: (rnd() * pal.leds.length) | 0, off: (rnd() * 16) | 0,
        vals: new Float32Array(cols),
      });
    }

    function buildSeq(inner, rnd) {
      const u = rig.u;
      const n = inner.w > u * 14 ? 16 : 8;
      rig.seqs.push({
        x: inner.x, y: inner.y + inner.h * 0.3, w: inner.w, h: Math.max(4, u * 1.6),
        n, ci: (rnd() * pal.leds.length) | 0, off: (rnd() * n) | 0,
      });
    }

    // ── Hero static painters ─────────────────────────────────────────────
    // Build-time only — these draw the "dark matter" of the hero devices
    // (wood, plastic, brushed metal, glass) into the static layer.

    function paintWood(g, x, y, w, h, rnd, tone, vert) {
      const br = 58 * tone, bg2 = 38 * tone, bb = 22 * tone;
      const grad = vert ? g.createLinearGradient(x, y, x + w, y) : g.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, `rgb(${(br * 1.3) | 0},${(bg2 * 1.3) | 0},${(bb * 1.25) | 0})`);
      grad.addColorStop(0.5, `rgb(${br | 0},${bg2 | 0},${bb | 0})`);
      grad.addColorStop(1, `rgb(${(br * 0.6) | 0},${(bg2 * 0.6) | 0},${(bb * 0.6) | 0})`);
      g.fillStyle = grad;
      g.fillRect(x, y, w, h);
      // Grain streaks: mostly dark figure lines, a few caught-the-lamp ones.
      const n = Math.max(6, ((vert ? w : h) / 5) | 0);
      for (let i = 0; i < n; i++) {
        const p = (i + rnd() * 0.8) / n;
        g.strokeStyle = rnd() < 0.28
          ? `rgba(255,190,120,${0.03 + rnd() * 0.045})`
          : `rgba(0,0,0,${0.06 + rnd() * 0.11})`;
        g.lineWidth = 0.8 + rnd() * 1.6;
        g.beginPath();
        if (vert) {
          const gx = x + p * w;
          g.moveTo(gx, y);
          g.bezierCurveTo(gx + (rnd() - 0.5) * 8, y + h * 0.33, gx + (rnd() - 0.5) * 8, y + h * 0.66, gx + (rnd() - 0.5) * 4, y + h);
        } else {
          const gy = y + p * h;
          g.moveTo(x, gy);
          g.bezierCurveTo(x + w * 0.33, gy + (rnd() - 0.5) * 6, x + w * 0.66, gy + (rnd() - 0.5) * 6, x + w, gy + (rnd() - 0.5) * 3);
        }
        g.stroke();
      }
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }

    function paintBrushed(g, x, y, w, h, lum) {
      const grad = g.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, `rgb(${(lum * 1.5) | 0},${(lum * 1.5) | 0},${(lum * 1.55) | 0})`);
      grad.addColorStop(0.5, `rgb(${lum | 0},${lum | 0},${(lum * 1.05) | 0})`);
      grad.addColorStop(1, `rgb(${(lum * 0.55) | 0},${(lum * 0.55) | 0},${(lum * 0.6) | 0})`);
      g.fillStyle = grad;
      g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(255,255,255,0.03)';
      for (let ly = y + 2; ly < y + h; ly += 3) g.fillRect(x, ly, w, 1);
    }

    function paintConeBase(g, c) {
      const u = rig.u;
      const warm = c.style === 'warm';
      // Trim ring / mounting flange.
      g.beginPath(); g.arc(c.x, c.y, c.r * 1.12, 0, 6.2832);
      g.fillStyle = warm ? 'rgba(20,14,8,1)' : 'rgba(10,10,14,1)';
      g.fill();
      g.lineWidth = Math.max(1.5, u * 0.35);
      g.strokeStyle = warm ? 'rgba(190,150,80,0.5)' : 'rgba(160,165,180,0.45)';
      g.beginPath(); g.arc(c.x, c.y, c.r * 1.10, 0, 6.2832); g.stroke();
      // Surround.
      g.beginPath(); g.arc(c.x, c.y, c.r, 0, 6.2832);
      g.fillStyle = 'rgba(6,6,8,1)';
      g.fill();
      // Cone (off-axis lit).
      const cg = g.createRadialGradient(c.x - c.r * 0.25, c.y - c.r * 0.3, c.r * 0.05, c.x, c.y, c.r * 0.92);
      cg.addColorStop(0, warm ? 'rgba(54,43,30,1)' : 'rgba(40,42,50,1)');
      cg.addColorStop(0.75, warm ? 'rgba(27,21,14,1)' : 'rgba(18,19,24,1)');
      cg.addColorStop(1, 'rgba(8,8,10,1)');
      g.beginPath(); g.arc(c.x, c.y, c.r * 0.92, 0, 6.2832);
      g.fillStyle = cg; g.fill();
      // Concentric ridge rings.
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.lineWidth = 1;
      for (let rr = 0.36; rr < 0.9; rr += 0.14) {
        g.beginPath(); g.arc(c.x, c.y, c.r * rr, 0, 6.2832); g.stroke();
      }
      // Dust cap.
      const dg = g.createRadialGradient(c.x - c.r * 0.08, c.y - c.r * 0.1, 0, c.x, c.y, c.r * 0.24);
      dg.addColorStop(0, warm ? 'rgba(82,64,42,1)' : 'rgba(70,74,88,1)');
      dg.addColorStop(1, 'rgba(14,14,18,1)');
      g.beginPath(); g.arc(c.x, c.y, c.r * 0.24, 0, 6.2832);
      g.fillStyle = dg; g.fill();
    }

    function paintCassetteWindow(g, wx, wy, ww, wh, tint) {
      const u = rig.u;
      // Door frame.
      g.fillStyle = 'rgba(8,8,11,1)';
      g.fillRect(wx - u * 0.5, wy - u * 0.5, ww + u, wh + u);
      g.strokeStyle = 'rgba(150,155,170,0.35)';
      g.lineWidth = 1.5;
      g.strokeRect(wx - u * 0.5, wy - u * 0.5, ww + u, wh + u);
      // Smoked glass.
      const gg = g.createLinearGradient(wx, wy, wx, wy + wh);
      gg.addColorStop(0, 'rgba(26,28,34,1)');
      gg.addColorStop(1, 'rgba(10,11,14,1)');
      g.fillStyle = gg;
      g.fillRect(wx, wy, ww, wh);
      if (tint) {
        g.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},0.09)`;
        g.fillRect(wx, wy, ww, wh);
      }
      // Cassette shell hint + tape line along the head bridge.
      g.fillStyle = 'rgba(255,255,255,0.045)';
      g.fillRect(wx + ww * 0.06, wy + wh * 0.12, ww * 0.88, wh * 0.70);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(wx + ww * 0.10, wy + wh * 0.82, ww * 0.80, Math.max(1.5, wh * 0.045));
      // Window glare stripe.
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.beginPath();
      g.moveTo(wx + ww * 0.10, wy);
      g.lineTo(wx + ww * 0.34, wy);
      g.lineTo(wx + ww * 0.14, wy + wh);
      g.lineTo(wx, wy + wh * 0.7);
      g.closePath();
      g.fill();
    }

    function paintSliderBase(g, s) {
      // Slot.
      g.fillStyle = 'rgba(0,0,0,0.75)';
      g.fillRect(s.x - s.w * 0.5, s.y, s.w, s.h);
      // Scale ticks either side.
      g.strokeStyle = 'rgba(200,205,220,0.18)';
      g.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const ty = s.y + s.h * (i / 4);
        g.beginPath();
        g.moveTo(s.x - s.w * 1.9, ty); g.lineTo(s.x - s.w * 1.1, ty);
        g.moveTo(s.x + s.w * 1.1, ty); g.lineTo(s.x + s.w * 1.9, ty);
        g.stroke();
      }
    }

    function paintDialBase(g, d) {
      const u = rig.u;
      g.fillStyle = 'rgba(6,7,10,1)';
      g.fillRect(d.x - u * 0.4, d.y - u * 0.4, d.w + u * 0.8, d.h + u * 0.8);
      const dg = g.createLinearGradient(d.x, d.y, d.x, d.y + d.h);
      dg.addColorStop(0, 'rgba(23,21,17,1)');
      dg.addColorStop(1, 'rgba(12,11,9,1)');
      g.fillStyle = dg;
      g.fillRect(d.x, d.y, d.w, d.h);
      // Frequency ticks + FM numbers.
      g.strokeStyle = 'rgba(235,220,190,0.4)';
      g.lineWidth = 1;
      const n = 28;
      for (let i = 0; i <= n; i++) {
        const tx = d.x + d.w * (0.03 + 0.94 * (i / n));
        const long = i % 4 === 0;
        g.beginPath();
        g.moveTo(tx, d.y + d.h * 0.62);
        g.lineTo(tx, d.y + d.h * (long ? 0.28 : 0.44));
        g.stroke();
      }
      g.font = `${Math.max(6, u * 0.9)}px ui-monospace, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(235,220,190,0.5)';
      const freqs = ['88', '92', '96', '100', '104', '108'];
      for (let i = 0; i < freqs.length; i++) {
        g.fillText(freqs[i], d.x + d.w * (0.06 + 0.88 * (i / (freqs.length - 1))), d.y + d.h * 0.82);
      }
    }

    function paintPlatterBase(g, p) {
      const u = rig.u;
      g.save();
      g.translate(p.x, p.y);
      g.scale(1, p.sq);
      // Platter rim (machined aluminum).
      const pg = g.createRadialGradient(0, 0, p.r * 0.6, 0, 0, p.r * 1.12);
      pg.addColorStop(0, 'rgba(30,31,36,1)');
      pg.addColorStop(0.85, 'rgba(62,64,74,1)');
      pg.addColorStop(1, 'rgba(18,18,22,1)');
      g.beginPath(); g.arc(0, 0, p.r * 1.12, 0, 6.2832);
      g.fillStyle = pg; g.fill();
      // Record.
      g.beginPath(); g.arc(0, 0, p.r, 0, 6.2832);
      g.fillStyle = 'rgba(8,8,10,1)'; g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.035)';
      g.lineWidth = 1;
      for (let rr = 0.38; rr < 0.97; rr += 0.07) {
        g.beginPath(); g.arc(0, 0, p.r * rr, 0, 6.2832); g.stroke();
      }
      // Label + spindle.
      g.beginPath(); g.arc(0, 0, p.r * 0.30, 0, 6.2832);
      g.fillStyle = 'rgba(118,26,22,1)'; g.fill();
      g.beginPath(); g.arc(0, 0, p.r * 0.035, 0, 6.2832);
      g.fillStyle = 'rgba(200,205,215,1)'; g.fill();
      g.restore();
      // Tonearm pivot base.
      g.beginPath(); g.arc(p.pivX, p.pivY, u * 1.0, 0, 6.2832);
      g.fillStyle = 'rgba(50,52,60,1)'; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1;
      g.stroke();
    }

    // ── Hero build: BOOMBOX ('84 breakdance ghetto blaster) ─────────────
    function buildBoombox(params, rnd, led, knob) {
      const u = rig.u;
      const bw = Math.min(W * 0.94, H * 1.35);
      const bh = bw * 0.47;
      const x0 = (W - bw) / 2;
      const y0 = Math.max(H * 0.53 - bh / 2, H * 0.10);
      rig.heroGeom = { x0, y0, bw, bh };

      // Speakers: big neon-trimmed woofers + piezo tweeters.
      const spk = [];
      for (const fx of [0.16, 0.84]) {
        const sx = x0 + bw * fx;
        spk.push(sx);
        rig.cones.push({ x: sx, y: y0 + bh * 0.565, r: bh * 0.315, band: 0, g: 1.05, atk: 0.55, rel: 0.20, kick: 0.6, lvl: 0, ring: 1, ci: fx < 0.5 ? 0 : 2, style: 'neon' });
        rig.cones.push({ x: sx, y: y0 + bh * 0.130, r: bh * 0.055, band: 2, g: 1.0, atk: 0.6, rel: 0.3, kick: 0.25, lvl: 0, ring: 0, ci: 3, style: 'neon' });
        // Exaggerated LED studs orbiting the woofer trim.
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * 6.2832 + 0.26;
          led(sx + Math.cos(a) * bh * 0.40, y0 + bh * 0.565 + Math.sin(a) * bh * 0.40,
            u * 1.9, (i + (fx < 0.5 ? 0 : 3)) % pal.leds.length, i % 4, i % 2 ? 'twinkle' : 'gate');
        }
      }

      const cx0 = x0 + bw * 0.335, cw = bw * 0.33;

      // Tuner dial (station-hopping) + flanking tuning/volume knobs.
      rig.dials.push({ x: cx0 + cw * 0.13, y: y0 + bh * 0.065, w: cw * 0.74, h: bh * 0.105, pos: 0.35, target: 0.6, wait: 2, drift: 'hop', warm: false });
      knob(cx0 + cw * 0.045, y0 + bh * 0.115, bh * 0.036, 1, 1);
      knob(cx0 + cw * 0.955, y0 + bh * 0.115, bh * 0.036, 4, 2);

      // Graphic EQ faders.
      const nEq = Math.max(6, Math.min(12, Math.round(6 + params.density * 4)));
      for (let i = 0; i < nEq; i++) {
        rig.sliders.push({
          x: cx0 + cw * ((i + 0.5) / nEq), y: y0 + bh * 0.235,
          w: Math.max(2, u * 0.5), h: bh * 0.195,
          frac: i / Math.max(1, nEq - 1), lvl: 0, ci: i % pal.leds.length,
        });
      }
      rig.labels.push({ x: cx0 + cw / 2, y: y0 + bh * 0.208, text: `${nEq} BAND GRAPHIC EQUALIZER`, size: Math.max(6, u * 0.8), align: 'center', bright: 0.5 });

      // L/R power meters + STEREO badge between them.
      for (const [fx2, band] of [[0.06, 0], [0.58, 3]]) {
        rig.ladders.push({
          x: cx0 + cw * fx2, y: y0 + bh * 0.475, w: cw * 0.36, h: Math.max(3, bh * 0.026),
          n: 10, band, horiz: true, grn: true, frac: 0, lvl: 0, peak: 0, peakAge: 0, g: 1.0,
        });
      }
      rig.glyphs.push({ x: cx0 + cw * 0.5, y: y0 + bh * 0.488, text: '◆', size: Math.max(6, u * 1.0), ci: 2, mode: 'beat', ph: 0 });

      // Dual cassette bay — both tapes rolling.
      const winY = y0 + bh * 0.565, winH = bh * 0.27, winW = cw * 0.46;
      const decks = [
        { wx: cx0 + cw * 0.02, tint: pal.leds[0] },
        { wx: cx0 + cw * 0.52, tint: pal.leds[1] },
      ];
      for (let di = 0; di < 2; di++) {
        const { wx, tint } = decks[di];
        for (const [hx, role] of [[0.30, 'supply'], [0.70, 'take']]) {
          rig.reels.push({
            x: wx + winW * hx, y: winY + winH * 0.46, r: winH * 0.26, hubR: winH * 0.115,
            spd: 2.6, rate: 1 / 52, ang: rnd() * 6.28, role, ph: di * 0.5,
            pack: 0.5, big: false,
            tint: hx < 0.5 ? tint : null,
            wx, wy: winY, ww: winW, wh: winH,
          });
        }
      }
      // Transport lamps.
      led(cx0 + cw * 0.07, y0 + bh * 0.915, u * 1.7, 1, 3, 'steady', true);
      led(cx0 + cw * 0.57, y0 + bh * 0.915, u * 1.7, 0, 0, 'pulse', true);

      // Badging.
      rig.labels.push({ x: x0 + bw * 0.5, y: y0 + bh * 0.033, text: 'V O I D S T A R', size: Math.max(9, u * 1.5), align: 'center', bright: 0.9 });
      rig.labels.push({ x: x0 + bw * 0.155, y: y0 + bh * 0.965, text: 'SSM-808', size: Math.max(7, u * 1.0), align: 'center', bright: 0.5 });
      rig.labels.push({ x: x0 + bw * 0.845, y: y0 + bh * 0.965, text: 'HI-POWER', size: Math.max(7, u * 1.0), align: 'center', bright: 0.5 });

      rig.heroStatic = (g) => {
        const r2 = mulberry32(seed ^ 0xb00b);
        // Floor shadow the box bounces over.
        const sg = g.createRadialGradient(W / 2, y0 + bh * 1.05, 0, W / 2, y0 + bh * 1.05, bw * 0.58);
        sg.addColorStop(0, 'rgba(0,0,0,0.55)');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = sg;
        g.fillRect(0, y0 + bh * 0.9, W, bh * 0.35);
        // Chrome handle.
        g.strokeStyle = 'rgba(140,146,160,0.8)';
        g.lineWidth = Math.max(3, u * 1.0);
        g.beginPath();
        g.moveTo(x0 + bw * 0.30, y0 + u * 0.5);
        g.lineTo(x0 + bw * 0.30, y0 - bh * 0.10);
        g.lineTo(x0 + bw * 0.70, y0 - bh * 0.10);
        g.lineTo(x0 + bw * 0.70, y0 + u * 0.5);
        g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.20)';
        g.lineWidth = Math.max(1, u * 0.3);
        g.beginPath();
        g.moveTo(x0 + bw * 0.31, y0 - bh * 0.10 - u * 0.25);
        g.lineTo(x0 + bw * 0.69, y0 - bh * 0.10 - u * 0.25);
        g.stroke();
        // Body: near-black street plastic.
        const bg2 = g.createLinearGradient(x0, y0, x0, y0 + bh);
        bg2.addColorStop(0, 'rgb(27,28,35)');
        bg2.addColorStop(0.12, 'rgb(19,20,26)');
        bg2.addColorStop(1, 'rgb(11,11,15)');
        g.fillStyle = bg2;
        g.fillRect(x0, y0, bw, bh);
        g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.lineWidth = 2;
        g.strokeRect(x0 + 1, y0 + 1, bw - 2, bh - 2);
        // Chrome trims + corner guards.
        paintBrushed(g, x0, y0, bw, Math.max(2, u * 0.55), 120);
        paintBrushed(g, x0, y0 + bh - Math.max(2, u * 0.55), bw, Math.max(2, u * 0.55), 85);
        const cgS = u * 2.4;
        g.fillStyle = 'rgba(130,136,150,0.5)';
        g.fillRect(x0 - u * 0.3, y0 - u * 0.3, cgS, cgS);
        g.fillRect(x0 + bw - cgS + u * 0.3, y0 - u * 0.3, cgS, cgS);
        g.fillRect(x0 - u * 0.3, y0 + bh - cgS + u * 0.3, cgS, cgS);
        g.fillRect(x0 + bw - cgS + u * 0.3, y0 + bh - cgS + u * 0.3, cgS, cgS);
        // Center panel inset.
        g.fillStyle = 'rgb(15,16,21)';
        g.fillRect(cx0 - u * 0.8, y0 + u * 1.2, cw + u * 1.6, bh - u * 2.4);
        g.strokeStyle = 'rgba(180,185,200,0.16)';
        g.lineWidth = 1;
        g.strokeRect(cx0 - u * 0.8, y0 + u * 1.2, cw + u * 1.6, bh - u * 2.4);
        // Speaker grille mesh behind each woofer.
        for (const sx of spk) {
          g.save();
          g.beginPath(); g.arc(sx, y0 + bh * 0.565, bh * 0.42, 0, 6.2832); g.clip();
          g.fillStyle = 'rgb(13,13,17)';
          g.fillRect(sx - bh * 0.42, y0 + bh * 0.14, bh * 0.84, bh * 0.86);
          g.strokeStyle = 'rgba(255,255,255,0.04)';
          g.lineWidth = 1;
          for (let gy = y0 + bh * 0.15; gy < y0 + bh * 0.99; gy += u * 0.9) {
            g.beginPath(); g.moveTo(sx - bh * 0.42, gy); g.lineTo(sx + bh * 0.42, gy); g.stroke();
          }
          g.restore();
        }
        for (const c of rig.cones) paintConeBase(g, c);
        for (const d of rig.dials) paintDialBase(g, d);
        for (const s of rig.sliders) paintSliderBase(g, s);
        for (const { wx, tint } of decks) paintCassetteWindow(g, wx, winY, winW, winH, tint);
        // Transport buttons.
        g.fillStyle = 'rgba(60,63,74,0.9)';
        for (let i = 0; i < 6; i++) {
          g.fillRect(cx0 + cw * (0.12 + i * 0.13), y0 + bh * 0.888, cw * 0.10, bh * 0.048);
        }
        // Feet.
        g.fillStyle = 'rgb(8,8,11)';
        g.fillRect(x0 + bw * 0.08, y0 + bh, bw * 0.08, u * 1.2);
        g.fillRect(x0 + bw * 0.84, y0 + bh, bw * 0.08, u * 1.2);
        void r2;
      };
    }

    // ── Hero build: DUBBING (mid-90s dual-deck mini system) ─────────────
    function buildDubbing(params, rnd, led, knob) {
      const u = rig.u;
      const bh = Math.min(H * 0.88, W * 1.30);
      const bw = Math.min(W * 0.64, bh * 0.74);
      const x0 = (W - bw) / 2;
      const y0 = H * 0.5 - bh / 2;
      rig.heroGeom = { x0, y0, bw, bh };

      // VFD glass: spectrum matrix + flying tape counters + dub banner.
      const vx = x0 + bw * 0.07, vy = y0 + bh * 0.09, vw = bw * 0.86, vh = bh * 0.175;
      const cell = Math.max(2.5, Math.min((vw * 0.52) / (16 * 1.35), (vh * 0.50) / (6 * 1.35)));
      rig.matrices.push({
        x: vx + vw * 0.05, y: vy + vh * 0.24,
        cols: 16, rows: 6, cell, ci: 1, off: 0,
        vals: new Float32Array(16),
      });
      rig.digits.push({ x: vx + vw * 0.68, y: vy + vh * 0.26, h: vh * 0.30, band: 3, val: 0, t: rnd() * 40, ci: 1, count: 9 });
      rig.digits.push({ x: vx + vw * 0.85, y: vy + vh * 0.26, h: vh * 0.30, band: 3, val: 0, t: rnd() * 40, ci: 0, count: 9 });
      rig.glyphs.push({ x: vx + vw * 0.5, y: vy + vh * 0.86, text: 'HIGH SPEED DUBBING  A ►► B', size: Math.max(7, u * 1.0), ci: 1, mode: 'blink', ph: 0 });
      rig.glyphs.push({ x: vx + vw * 0.135, y: vy + vh * 0.13, text: 'VOL MAX', size: Math.max(6, u * 0.85), ci: 4, mode: 'steady', ph: 0 });
      rig.labels.push({ x: x0 + bw * 0.08, y: y0 + bh * 0.045, text: 'voidstar XD-S9', size: Math.max(8, u * 1.2), align: 'left', bright: 0.8 });
      rig.labels.push({ x: x0 + bw * 0.92, y: y0 + bh * 0.045, text: 'DOLBY B·C NR', size: Math.max(6, u * 0.8), align: 'right', bright: 0.4 });

      // Jog ring (the glowing green collar from the reference) + master vol.
      knob(x0 + bw * 0.185, y0 + bh * 0.385, bh * 0.052, 0, 3);
      knob(x0 + bw * 0.815, y0 + bh * 0.385, bh * 0.068, 1, 3);
      // Source buttons.
      const srcs = ['TAPE', 'TUNER', 'CD', 'AUX', 'SLEEP'];
      for (let i = 0; i < srcs.length; i++) {
        const bx = x0 + bw * (0.335 + i * 0.083);
        rig.labels.push({ x: bx, y: y0 + bh * 0.395, text: srcs[i], size: Math.max(5, u * 0.7), align: 'center', bright: 0.45 });
        led(bx, y0 + bh * 0.358, u * 1.5, i === 0 ? 0 : 1, i % 4, i === 0 ? 'steady' : 'twinkle', true);
      }

      // Dual decks: A plays (red-lit), B records (green-lit), both at 2×.
      const dw = bw * 0.425, dh = bh * 0.275, dy = y0 + bh * 0.545;
      const decks = [
        { dx: x0 + bw * 0.055, tint: pal.leds[2], name: 'DECK A ─ PLAY' },
        { dx: x0 + bw * 0.52,  tint: pal.leds[0], name: 'DECK B ─ REC' },
      ];
      for (let di = 0; di < 2; di++) {
        const { dx, tint, name } = decks[di];
        for (const [hx, role] of [[0.30, 'supply'], [0.70, 'take']]) {
          rig.reels.push({
            x: dx + dw * hx, y: dy + dh * 0.44, r: dh * 0.28, hubR: dh * 0.12,
            spd: 5.2, rate: 1 / 38, ang: rnd() * 6.28, role, ph: di * 0.02,
            pack: 0.5, big: false,
            tint: hx < 0.5 ? tint : null,
            wx: dx, wy: dy, ww: dw, wh: dh,
          });
        }
        rig.labels.push({ x: dx + dw * 0.5, y: dy + dh + u * 1.7, text: name, size: Math.max(6, u * 0.85), align: 'center', bright: 0.5 });
        rig.ladders.push({
          x: dx + dw * 0.10, y: dy + dh + u * 2.8, w: dw * 0.80, h: Math.max(3, u * 1.0),
          n: 12, band: di === 0 ? 3 : 0, horiz: true, grn: true, frac: 0, lvl: 0, peak: 0, peakAge: 0, g: 1.0,
        });
      }
      // A ► B chevrons chasing down the gap between the decks.
      for (let i = 0; i < 3; i++) {
        rig.glyphs.push({ x: x0 + bw * 0.5, y: dy + dh * (0.24 + i * 0.22), text: '►', size: Math.max(9, u * 1.5), ci: 0, mode: 'chase', ph: i });
      }
      led(x0 + bw * 0.5, dy + dh * 0.88, u * 1.6, 2, 0, 'pulse', true);   // REC lamp
      led(x0 + bw * 0.945, y0 + bh * 0.045, u * 1.3, 2, 3, 'steady', true);  // power
      rig.labels.push({ x: x0 + bw * 0.08, y: y0 + bh * 0.955, text: 'T-BASS', size: Math.max(6, u * 0.9), align: 'left', bright: 0.55 });
      rig.labels.push({ x: x0 + bw * 0.92, y: y0 + bh * 0.955, text: '200W PMPO', size: Math.max(6, u * 0.9), align: 'right', bright: 0.45 });

      rig.heroStatic = (g) => {
        // Floor shadow.
        const sg = g.createRadialGradient(W / 2, y0 + bh * 1.03, 0, W / 2, y0 + bh * 1.03, bw * 0.75);
        sg.addColorStop(0, 'rgba(0,0,0,0.5)');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = sg;
        g.fillRect(0, y0 + bh * 0.92, W, bh * 0.2);
        // Body: champagne silver, dusk-lit.
        paintBrushed(g, x0, y0, bw, bh, 44);
        g.strokeStyle = 'rgba(0,0,0,0.65)';
        g.lineWidth = 2;
        g.strokeRect(x0 + 1, y0 + 1, bw - 2, bh - 2);
        // CD lid seam.
        g.fillStyle = 'rgba(0,0,0,0.30)';
        g.fillRect(x0 + bw * 0.30, y0 + bh * 0.028, bw * 0.40, Math.max(2, u * 0.45));
        // VFD glass.
        g.fillStyle = 'rgb(4,10,11)';
        g.fillRect(vx - u * 0.5, vy - u * 0.5, vw + u, vh + u);
        g.strokeStyle = 'rgba(150,160,175,0.30)';
        g.lineWidth = 1.5;
        g.strokeRect(vx - u * 0.5, vy - u * 0.5, vw + u, vh + u);
        // Function strip: the little green→red gradient bar from the ref.
        const fs = g.createLinearGradient(x0 + bw * 0.33, 0, x0 + bw * 0.70, 0);
        fs.addColorStop(0, 'rgba(90,200,90,0.5)');
        fs.addColorStop(1, 'rgba(220,60,60,0.5)');
        g.fillStyle = fs;
        g.fillRect(x0 + bw * 0.33, y0 + bh * 0.325, bw * 0.37, Math.max(2, u * 0.4));
        // Jog-ring LED dots (dim; the live glow is the knob's ring).
        g.fillStyle = 'rgba(120,255,160,0.12)';
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * 6.2832;
          g.beginPath();
          g.arc(x0 + bw * 0.185 + Math.cos(a) * bh * 0.075, y0 + bh * 0.385 + Math.sin(a) * bh * 0.075, Math.max(1.2, u * 0.3), 0, 6.2832);
          g.fill();
        }
        // Deck doors + transport button strips.
        for (const { dx, tint } of decks) {
          paintCassetteWindow(g, dx, dy, dw, dh, tint);
          g.fillStyle = 'rgba(24,25,30,0.9)';
          for (let i = 0; i < 6; i++) {
            g.fillRect(dx + dw * (0.06 + i * 0.155), dy + dh + u * 4.2, dw * 0.12, u * 1.5);
          }
          g.fillStyle = 'rgba(255,255,255,0.06)';
          for (let i = 0; i < 6; i++) {
            g.fillRect(dx + dw * (0.06 + i * 0.155), dy + dh + u * 4.2, dw * 0.12, 1);
          }
        }
        // Feet + vents.
        g.fillStyle = 'rgb(6,6,8)';
        g.fillRect(x0 + bw * 0.06, y0 + bh, bw * 0.10, u * 1.4);
        g.fillRect(x0 + bw * 0.84, y0 + bh, bw * 0.10, u * 1.4);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        for (let i = 0; i < 10; i++) g.fillRect(x0 + bw * (0.30 + i * 0.045), y0 + bh * 0.968, bw * 0.03, Math.max(1.5, u * 0.35));
      };
    }

    // ── Hero build: VINTAGE ('73 walnut listening room) ──────────────────
    function buildVintage(params, rnd, led, knob) {
      const u = rig.u;
      const floorY = H * 0.90;
      // Speaker towers.
      const tw = Math.min(W * 0.20, H * 0.34);
      const th = Math.min(H * 0.70, tw * 3.4);
      const towers = [W * 0.04, W * 0.96 - tw];
      for (let ti = 0; ti < 2; ti++) {
        const cxm = towers[ti] + tw / 2, ty = floorY - th;
        rig.cones.push({ x: cxm, y: ty + th * 0.76, r: tw * 0.295, band: 0, g: 0.95, atk: 0.14, rel: 0.05, kick: 0.18, lvl: 0, ring: 0, ci: 0, style: 'warm' });
        rig.cones.push({ x: cxm, y: ty + th * 0.46, r: tw * 0.175, band: 1, g: 0.9, atk: 0.16, rel: 0.06, kick: 0.10, lvl: 0, ring: 0, ci: 1, style: 'warm' });
        rig.cones.push({ x: cxm, y: ty + th * 0.25, r: tw * 0.105, band: 2, g: 0.9, atk: 0.2, rel: 0.08, kick: 0.06, lvl: 0, ring: 0, ci: 3, style: 'warm' });
        rig.labels.push({ x: cxm, y: ty + th * 0.07, text: 'DEEP FIELD', size: Math.max(6, u * 0.85), align: 'center', bright: 0.35 });
      }

      // Center rack cabinet.
      const rx = W * 0.27, rw = W * 0.46;
      const ry = H * 0.315, rb = floorY;

      // Turntable on top of the cabinet (front ¾ view, squashed ellipse).
      const pr = Math.min(rw * 0.165, H * 0.075);
      const px = rx + rw * 0.38, py = ry - pr * 0.55 - u * 1.6;
      rig.platters.push({
        x: px, y: py, r: pr, sq: 0.40, ang: rnd() * 6.28, rpm: 33.3, arm: rnd() * 0.8,
        pivX: px + pr * 1.42, pivY: py - pr * 0.28,
      });
      led(px + pr * 1.62, py + pr * 0.26, u * 1.2, 3, 0, 'steady', true);   // stylus lamp

      const unitH = (rb - ry);
      // Receiver: backlit sweeping dial + flywheel tuning + preamp knobs.
      const u1y = ry + u * 1.0, u1h = unitH * 0.215;
      rig.dials.push({ x: rx + rw * 0.055, y: u1y + u1h * 0.14, w: rw * 0.70, h: u1h * 0.44, pos: 0.5, target: 0.5, wait: 4, drift: 'sweep', warm: true });
      knob(rx + rw * 0.875, u1y + u1h * 0.40, u1h * 0.24, 0, 1);
      for (let i = 0; i < 4; i++) knob(rx + rw * (0.10 + i * 0.09), u1y + u1h * 0.80, u1h * 0.115, i % 2 ? 1 : 0, i % 3);
      rig.labels.push({ x: rx + rw * 0.94, y: u1y + u1h * 0.86, text: 'OBERHAUS 2270', size: Math.max(6, u * 0.85), align: 'right', bright: 0.5 });
      led(rx + rw * 0.62, u1y + u1h * 0.80, u * 1.3, 0, 3, 'gate', true);
      rig.glyphs.push({ x: rx + rw * 0.62, y: u1y + u1h * 0.63, text: 'STEREO', size: Math.max(5, u * 0.7), ci: 0, mode: 'steady', ph: 0 });

      // Amplifier: twin backlit VU meters + master volume.
      const u2y = ry + unitH * 0.26, u2h = unitH * 0.215;
      const vw2 = Math.min(rw * 0.21, u * 16), vh2 = Math.min(u2h * 0.60, vw2 * 0.60);
      for (const fx3 of [0.175, 0.425]) {
        if (rig.vus.length < MAX_VUS) {
          rig.vus.push({ x: rx + rw * fx3 - vw2 / 2, y: u2y + u2h * 0.42 - vh2 / 2, w: vw2, h: vh2, needle: 0, pin: 0 });
        }
      }
      knob(rx + rw * 0.82, u2y + u2h * 0.42, u2h * 0.22, 0, 3);
      knob(rx + rw * 0.62, u2y + u2h * 0.42, u2h * 0.12, 1, 1);
      rig.labels.push({ x: rx + rw * 0.055, y: u2y + u2h * 0.88, text: 'VOIDSTAR AUDIO · CLASS A', size: Math.max(6, u * 0.8), align: 'left', bright: 0.45 });
      led(rx + rw * 0.93, u2y + u2h * 0.82, u * 1.3, 2, 0, 'steady', true);

      // Reel-to-reel ticking over.
      const u3y = ry + unitH * 0.52, u3h = unitH * 0.30;
      const rr2 = Math.min(rw * 0.115, u3h * 0.33);
      for (const [fx4, role] of [[0.28, 'supply'], [0.72, 'take']]) {
        rig.reels.push({
          x: rx + rw * fx4, y: u3y + u3h * 0.42, r: rr2, hubR: rr2 * 0.30,
          spd: 1.1, rate: 1 / 110, ang: rnd() * 6.28, role, ph: 0.15,
          pack: 0.5, big: true, tint: null,
          wx: 0, wy: 0, ww: 0, wh: 0,
        });
      }
      rig.ladders.push({
        x: rx + rw * 0.42, y: u3y + u3h * 0.16, w: rw * 0.16, h: Math.max(3, u * 1.0),
        n: 12, band: 3, horiz: true, grn: true, frac: 0, lvl: 0, peak: 0, peakAge: 0, g: 0.8,
      });
      knob(rx + rw * 0.90, u3y + u3h * 0.45, u3h * 0.10, 1, 2);
      rig.labels.push({ x: rx + rw * 0.055, y: u3y + u3h * 0.12, text: 'PHASE//9 · 15 IPS', size: Math.max(6, u * 0.8), align: 'left', bright: 0.4 });

      // Dust motes drifting through the lamp shaft.
      const mB = { x0: rx - rw * 0.05, y0: H * 0.06, w: rw * 1.1, h: H * 0.55 };
      const nM = Math.max(16, Math.min(MAX_MOTES, Math.round(20 + params.density * 20)));
      for (let i = 0; i < nM; i++) {
        rig.motes.push({
          x: mB.x0 + rnd() * mB.w, y: mB.y0 + rnd() * mB.h,
          vx: (rnd() - 0.5) * u * 0.8, vy: (rnd() * 0.5 + 0.15) * u * 0.5,
          ph: rnd() * 10, x0: mB.x0, y0: mB.y0, w: mB.w, h: mB.h,
        });
      }

      rig.heroStatic = (g) => {
        const r2 = mulberry32(seed ^ 0x7075);
        // Warm lamp gradient + light shaft the motes live in.
        const lg = g.createRadialGradient(W * 0.12, H * 0.02, 0, W * 0.12, H * 0.02, H * 0.7);
        lg.addColorStop(0, 'rgba(120,80,36,0.20)');
        lg.addColorStop(1, 'rgba(120,80,36,0)');
        g.fillStyle = lg;
        g.fillRect(0, 0, W, H);
        g.beginPath();
        g.moveTo(W * 0.16, 0); g.lineTo(W * 0.40, 0);
        g.lineTo(rx + rw * 0.9, H * 0.62); g.lineTo(rx + rw * 0.1, H * 0.62);
        g.closePath();
        const sg2 = g.createLinearGradient(0, 0, 0, H * 0.62);
        sg2.addColorStop(0, 'rgba(255,210,150,0.05)');
        sg2.addColorStop(1, 'rgba(255,210,150,0)');
        g.fillStyle = sg2;
        g.fill();
        // Floor.
        const fg2 = g.createLinearGradient(0, floorY, 0, H);
        fg2.addColorStop(0, 'rgb(16,11,8)');
        fg2.addColorStop(1, 'rgb(7,6,7)');
        g.fillStyle = fg2;
        g.fillRect(0, floorY, W, H - floorY);
        g.fillStyle = 'rgba(255,190,120,0.05)';
        g.fillRect(0, floorY, W, 2);
        // Speaker towers.
        for (let ti = 0; ti < 2; ti++) {
          const tx = towers[ti], ty = floorY - th;
          paintWood(g, tx, ty, tw, th, r2, 1.0, true);
          g.fillStyle = 'rgba(10,8,6,0.88)';
          g.fillRect(tx + tw * 0.08, ty + tw * 0.10, tw * 0.84, th - tw * 0.20);
          g.strokeStyle = 'rgba(190,150,80,0.30)';
          g.lineWidth = 1;
          g.strokeRect(tx + tw * 0.08, ty + tw * 0.10, tw * 0.84, th - tw * 0.20);
          g.beginPath(); g.arc(tx + tw / 2, ty + th * 0.925, tw * 0.085, 0, 6.2832);
          g.fillStyle = 'rgb(4,4,5)'; g.fill();
        }
        for (const c of rig.cones) paintConeBase(g, c);
        // Cabinet: wood cheeks + black stack.
        paintWood(g, rx - u * 1.4, ry - u * 0.8, u * 1.4, rb - ry + u * 0.8, r2, 0.9, true);
        paintWood(g, rx + rw, ry - u * 0.8, u * 1.4, rb - ry + u * 0.8, r2, 0.9, true);
        g.fillStyle = 'rgb(9,9,11)';
        g.fillRect(rx, ry, rw, rb - ry);
        for (const [uy, uh] of [[u1y, u1h], [u2y, u2h], [u3y, u3h]]) {
          paintBrushed(g, rx + u * 0.3, uy, rw - u * 0.6, uh, 26);
          g.strokeStyle = 'rgba(0,0,0,0.6)';
          g.lineWidth = 1;
          g.strokeRect(rx + u * 0.3, uy, rw - u * 0.6, uh);
        }
        // Turntable plinth + platter.
        paintWood(g, px - pr * 1.75, py - pr * 0.66, pr * 3.6, pr * 1.35, r2, 1.05, false);
        for (const p of rig.platters) paintPlatterBase(g, p);
        for (const d of rig.dials) paintDialBase(g, d);
        // Reel-to-reel tape path + head block.
        const rl0 = rig.reels[0], rl1 = rig.reels[1];
        if (rl0 && rl1) {
          g.strokeStyle = 'rgba(70,50,35,0.8)';
          g.lineWidth = Math.max(1.5, u * 0.3);
          g.beginPath();
          g.moveTo(rl0.x, rl0.y + rl0.r + u * 0.7);
          g.lineTo(rl1.x, rl1.y + rl1.r + u * 0.7);
          g.stroke();
          g.fillStyle = 'rgb(20,20,24)';
          g.fillRect((rl0.x + rl1.x) / 2 - u * 2.0, rl0.y + rl0.r, u * 4.0, u * 1.5);
        }
        // Records leaning against the cabinet.
        for (let i = 0; i < 4; i++) {
          g.save();
          g.translate(rx + rw + u * (2.6 + i * 1.1), floorY);
          g.rotate(-0.06 - i * 0.035);
          g.fillStyle = `rgba(${16 + i * 4},${13 + i * 3},${12 + i * 3},1)`;
          g.fillRect(-u * 0.5, -u * 13, u * 0.9, u * 13);
          g.restore();
        }
      };
    }

    function buildCables(params, rnd) {
      const jacks = rig.jacks;
      if (jacks.length < 4 || params.cables <= 0) return;
      const want = Math.min(MAX_CABLES, Math.round(jacks.length * 0.30 * params.cables * LC.cableMul));
      const u = rig.u;
      let attempts = 0;
      while (rig.cables.length < want && attempts++ < want * 12) {
        const a = jacks[(rnd() * jacks.length) | 0];
        const b = jacks[(rnd() * jacks.length) | 0];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < u * 6 || Math.abs(dx) > W * 0.5 || Math.abs(dy) > H * 0.55) continue;
        const sag = dist * (0.18 + rnd() * 0.3) + u * 2.5;
        rig.cables.push({
          x0: a.x, y0: a.y, x1: b.x, y1: b.y,
          cx1: a.x + dx * 0.2, cy1: a.y + sag,
          cx2: a.x + dx * 0.8, cy2: b.y + sag,
          hue: pal.cables[(rnd() * pal.cables.length) | 0],
          band: rig.cables.length % 4,
          lw: Math.max(2.2, u * 0.42) * (0.85 + rnd() * 0.4),
        });
      }
    }

    // ── Static layer ─────────────────────────────────────────────────────
    function drawStatic() {
      if (!staticLayer) {
        staticLayer = document.createElement('canvas');
        staticCtx = staticLayer.getContext('2d');
      }
      staticLayer.width = W;
      staticLayer.height = H;
      const g = staticCtx;
      const u = rig.u;
      const [pr, pg, pb] = pal.plate;
      const [rr, rgc, rb] = pal.rail;

      g.fillStyle = '#05050d';
      g.fillRect(0, 0, W, H);

      // Hero devices paint their bodies first; the generic element bases
      // below (labels, knob bodies, ladder cells, VU faces…) land on top.
      if (rig.heroStatic) rig.heroStatic(g);

      // Reel recesses — dark wells the tape packs spin in.
      for (const rl of rig.reels) {
        g.beginPath();
        g.arc(rl.x, rl.y, rl.r + Math.max(1.5, u * 0.3), 0, Math.PI * 2);
        g.fillStyle = 'rgba(3,3,5,0.92)';
        g.fill();
      }

      // Plates.
      for (const p of rig.plates) {
        const t = p.tone;
        const grad = g.createLinearGradient(p.x, p.y, p.x, p.y + p.h);
        grad.addColorStop(0, `rgb(${(pr * t * 1.25) | 0},${(pg * t * 1.25) | 0},${(pb * t * 1.25) | 0})`);
        grad.addColorStop(1, `rgb(${(pr * t * 0.7) | 0},${(pg * t * 0.7) | 0},${(pb * t * 0.7) | 0})`);
        g.fillStyle = grad;
        g.fillRect(p.x, p.y, p.w, p.h);
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = 1;
        g.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
        // Top edge highlight — catches the "room light".
        g.fillStyle = `rgba(${rr},${rgc},${rb},0.35)`;
        g.fillRect(p.x, p.y, p.w, 1.5);
      }

      // Rails between rows.
      g.fillStyle = `rgba(${rr},${rgc},${rb},0.8)`;
      const seen = new Set();
      for (const p of rig.plates) {
        const yb = Math.round(p.y + p.h);
        if (p.euro && !seen.has(yb)) {
          seen.add(yb);
          g.fillRect(0, yb, W, Math.max(2, u * 0.8));
          g.fillStyle = 'rgba(0,0,0,0.4)';
          for (let hx = u * 1.5; hx < W; hx += u * 4) {
            g.fillRect(hx, yb + u * 0.25, u * 0.5, Math.max(1, u * 0.3));
          }
          g.fillStyle = `rgba(${rr},${rgc},${rb},0.8)`;
        }
      }

      // Screws.
      for (const s of rig.screws) {
        g.beginPath();
        g.arc(s.x, s.y, Math.max(2, u * 0.45), 0, Math.PI * 2);
        g.fillStyle = 'rgba(150,160,180,0.35)';
        g.fill();
        g.strokeStyle = 'rgba(10,10,16,0.8)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(s.x - Math.cos(s.rot) * u * 0.4, s.y - Math.sin(s.rot) * u * 0.4);
        g.lineTo(s.x + Math.cos(s.rot) * u * 0.4, s.y + Math.sin(s.rot) * u * 0.4);
        g.stroke();
      }

      // Labels.
      g.textBaseline = 'middle';
      for (const l of rig.labels) {
        g.font = `${l.size}px ui-monospace, monospace`;
        g.textAlign = l.align;
        g.fillStyle = `rgba(205,215,235,${l.bright * 0.55})`;
        g.fillText(l.text, l.x, l.y);
      }

      // Knob bodies (rings + skirt), ticks.
      for (const k of rig.knobs) {
        g.beginPath();
        g.arc(k.x, k.y, k.r, 0, Math.PI * 2);
        const kg = g.createRadialGradient(k.x - k.r * 0.3, k.y - k.r * 0.3, k.r * 0.1, k.x, k.y, k.r);
        kg.addColorStop(0, 'rgba(58,62,78,1)');
        kg.addColorStop(1, 'rgba(14,15,22,1)');
        g.fillStyle = kg;
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.lineWidth = 1.5;
        g.stroke();
        // Ticks around the skirt.
        g.strokeStyle = 'rgba(190,200,220,0.28)';
        g.lineWidth = 1;
        for (let i = 0; i <= 10; i++) {
          const a = (-0.75 + 1.5 * (i / 10)) * Math.PI - Math.PI / 2;
          g.beginPath();
          g.moveTo(k.x + Math.cos(a) * k.r * 1.18, k.y + Math.sin(a) * k.r * 1.18);
          g.lineTo(k.x + Math.cos(a) * k.r * 1.32, k.y + Math.sin(a) * k.r * 1.32);
          g.stroke();
        }
      }

      // Jack bodies.
      for (const j of rig.jacks) {
        g.beginPath();
        g.arc(j.x, j.y, Math.max(3, u * 0.85), 0, Math.PI * 2);
        g.fillStyle = 'rgba(120,128,148,0.5)';
        g.fill();
        g.beginPath();
        g.arc(j.x, j.y, Math.max(1.6, u * 0.45), 0, Math.PI * 2);
        g.fillStyle = 'rgba(3,3,8,0.95)';
        g.fill();
      }

      // Dim meter/matrix/seq cells + bezels for scopes, VU faces.
      for (const l of rig.ladders) drawLadderBase(g, l);
      for (const m of rig.matrices) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(m.x - 2, m.y - 2, m.cols * m.cell * 1.35 + 4, m.rows * m.cell * 1.35 + 4);
        g.fillStyle = 'rgba(255,255,255,0.05)';
        for (let cx = 0; cx < m.cols; cx++) {
          for (let ry = 0; ry < m.rows; ry++) {
            g.fillRect(m.x + cx * m.cell * 1.35, m.y + ry * m.cell * 1.35, m.cell, m.cell);
          }
        }
      }
      for (const s of rig.seqs) {
        const sw = s.w / s.n;
        g.fillStyle = 'rgba(255,255,255,0.06)';
        for (let i = 0; i < s.n; i++) {
          g.fillRect(s.x + i * sw + 1, s.y, sw - 2, s.h);
        }
      }
      for (const sc of rig.scopes) {
        // Round CRT: bezel ring + dark tube + faint graticule.
        g.beginPath();
        g.arc(sc.x, sc.y, sc.r * 1.12, 0, Math.PI * 2);
        g.fillStyle = 'rgba(40,44,56,0.9)';
        g.fill();
        g.beginPath();
        g.arc(sc.x, sc.y, sc.r, 0, Math.PI * 2);
        g.fillStyle = 'rgba(4,8,10,0.97)';
        g.fill();
        g.strokeStyle = 'rgba(90,140,150,0.15)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(sc.x - sc.r, sc.y); g.lineTo(sc.x + sc.r, sc.y);
        g.moveTo(sc.x, sc.y - sc.r); g.lineTo(sc.x, sc.y + sc.r);
        g.stroke();
      }
      for (const v of rig.vus) {
        // Warm backlit face + tick arc; needle is dynamic.
        const vg = g.createLinearGradient(v.x, v.y, v.x, v.y + v.h);
        vg.addColorStop(0, 'rgba(72,52,20,0.95)');
        vg.addColorStop(1, 'rgba(40,28,12,0.95)');
        g.fillStyle = vg;
        g.fillRect(v.x, v.y, v.w, v.h);
        g.strokeStyle = 'rgba(8,8,12,0.9)';
        g.lineWidth = 2;
        g.strokeRect(v.x, v.y, v.w, v.h);
        const cx = v.x + v.w / 2, cy = v.y + v.h * 0.95, rad = v.h * 0.78;
        g.strokeStyle = 'rgba(255,235,200,0.5)';
        g.lineWidth = 1;
        for (let i = 0; i <= 8; i++) {
          const a2 = -Math.PI * 0.85 + (i / 8) * Math.PI * 0.7;
          g.beginPath();
          g.moveTo(cx + Math.cos(a2) * rad * 0.82, cy + Math.sin(a2) * rad * 0.82);
          g.lineTo(cx + Math.cos(a2) * rad * 0.92, cy + Math.sin(a2) * rad * 0.92);
          g.stroke();
        }
      }

      // Cable sleeves (dark body under the dynamic glow) + plug caps.
      for (const c of rig.cables) {
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = c.lw + 2;
        g.lineCap = 'round';
        strokeCable(g, c);
        g.strokeStyle = `hsla(${c.hue},55%,40%,0.75)`;
        g.lineWidth = c.lw;
        strokeCable(g, c);
        for (const [px, py] of [[c.x0, c.y0], [c.x1, c.y1]]) {
          g.beginPath();
          g.arc(px, py, Math.max(2.5, u * 0.7), 0, Math.PI * 2);
          g.fillStyle = `hsla(${c.hue},45%,30%,0.95)`;
          g.fill();
        }
      }
    }

    function strokeCable(g, c) {
      g.beginPath();
      g.moveTo(c.x0, c.y0);
      g.bezierCurveTo(c.cx1, c.cy1, c.cx2, c.cy2, c.x1, c.y1);
      g.stroke();
    }

    function drawLadderBase(g, l) {
      g.fillStyle = 'rgba(255,255,255,0.05)';
      const n = l.n;
      if (l.horiz) {
        const sw = l.w / n;
        for (let i = 0; i < n; i++) g.fillRect(l.x + i * sw + 0.5, l.y, sw - 1.5, l.h);
      } else {
        const sh = l.h / n;
        for (let i = 0; i < n; i++) g.fillRect(l.x, l.y + i * sh + 0.5, l.w, sh - 1.5);
      }
    }

    // ── Per-frame state ──────────────────────────────────────────────────
    const packets = [];
    for (let i = 0; i < MAX_PACKETS; i++) packets.push({ live: false, cable: 0, t: 0, sp: 1, ci: 0 });

    let seqStep = 0;
    let stepAcc = 0;
    let lastBeatT = -10;
    let idleT = 0;

    // Relative-motion pose tracker. Only frame-to-frame joint velocity is
    // kept — never absolute positions — so a performer locked in place still
    // drives the rig purely by *moving*.
    const pt = { has: false, ts: 0, hx: 0, hy: 0, lx: 0, ly: 0, rx: 0, ry: 0, energy: 0, sway: 0, swayT: 0 };

    const scratch = {
      lv: new Float32Array(4),   // bass, mids, highs, total
      beatPulse: 0, highsPulse: 0,
      audioOn: false,
      waveform: null, spectrum: null,
      glow: 1, sparkle: 0, flow: 1,
      time: 0,
      poseE: 0, poseSway: 0, bounce: 0,
    };
    const bp = { x: 0, y: 0 };   // bezier point scratch

    function bezPoint(c, t) {
      const mt = 1 - t;
      const a = mt * mt * mt, b = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
      bp.x = a * c.x0 + b * c.cx1 + d * c.cx2 + e * c.x1;
      bp.y = a * c.y0 + b * c.cy1 + d * c.cy2 + e * c.y1;
    }

    function spawnPacket(cableIdx, ci) {
      for (const p of packets) {
        if (!p.live) {
          p.live = true; p.cable = cableIdx; p.t = 0;
          p.sp = 0.8 + Math.random() * 0.9; p.ci = ci;
          return;
        }
      }
    }

    function update(field) {
      const { dt, time, params } = field;
      // Rebuild when structure-affecting params or the canvas change.
      const key = `${W}x${H}|${params.layout}|${params.palette}|${Math.round(params.density * 20)}|${Math.round(params.cables * 20)}`;
      if (key !== rigKey && W > 0 && H > 0) {
        rigKey = key;
        buildRig(params);
      }
      if (!rig) return;

      const audio = scaleAudio(field.audio, params.reactivity);
      const audioOn = !!audio.spectrum;
      const lv = scratch.lv;
      let beatActive = false;

      if (audioOn) {
        lv[0] = audio.bands.bass;
        lv[1] = audio.bands.mids;
        lv[2] = audio.bands.highs;
        lv[3] = audio.bands.total;
        scratch.beatPulse = audio.beat.pulse;
        scratch.highsPulse = audio.highs.pulse;
        beatActive = audio.beat.active;
        if (beatActive) lastBeatT = time;
      } else {
        // Idle rig: 120 BPM internal clock + LFO bands.
        idleT += dt;
        const phase = (idleT % 0.5) / 0.5;
        scratch.beatPulse = Math.exp(-phase * 4.5);
        const hp = ((idleT + 0.25) % 0.25) / 0.25;
        scratch.highsPulse = Math.exp(-hp * 5) * 0.7;
        beatActive = phase < dt / 0.5;
        lv[0] = clamp01(0.22 + 0.5 * scratch.beatPulse + 0.06 * Math.sin(time * 0.7));
        lv[1] = clamp01(0.28 + 0.18 * Math.sin(time * 1.7 + 1) + 0.14 * Math.sin(time * 3.1));
        lv[2] = clamp01(0.16 + 0.22 * Math.max(0, Math.sin(time * 8 + Math.sin(time * 2) * 3)) + scratch.highsPulse * 0.4);
        lv[3] = clamp01((lv[0] + lv[1] + lv[2]) / 2.4);
      }

      // Relative pose motion → energy + sway. Sampled only when a fresh
      // pose detection lands (pose runs slower than render), using the
      // detection-to-detection dt so velocity is stable.
      const person = field.pose && field.pose.people.length ? field.pose.people[0] : null;
      const poseTs = field.pose ? field.pose.timestamp : 0;
      let eTarget = 0;
      if (person && person.confidence > 0.35 && poseTs !== pt.ts) {
        const pdt = pt.ts ? Math.min(0.5, Math.max(0.02, (poseTs - pt.ts) / 1000)) : 0;
        if (pdt > 0 && pt.has) {
          const hs = Math.hypot(person.head.x - pt.hx, person.head.y - pt.hy) / pdt;
          const ws = (Math.hypot(person.wrists.l.x - pt.lx, person.wrists.l.y - pt.ly)
                    + Math.hypot(person.wrists.r.x - pt.rx, person.wrists.r.y - pt.ry)) / (2 * pdt);
          // Deadzones swallow detector jitter; only real movement counts.
          eTarget = clamp01(Math.max(0, hs - 0.03) * 2.2 + Math.max(0, ws - 0.05) * 1.1);
          pt.swayT = Math.max(-1, Math.min(1, (person.head.x - pt.hx) / pdt * 4));
        }
        pt.hx = person.head.x; pt.hy = person.head.y;
        pt.lx = person.wrists.l.x; pt.ly = person.wrists.l.y;
        pt.rx = person.wrists.r.x; pt.ry = person.wrists.r.y;
        pt.ts = poseTs;
        pt.has = true;
      } else if (!person || person.confidence <= 0.35) {
        pt.has = false;
        pt.swayT = 0;
      }
      if (eTarget > pt.energy) pt.energy += (eTarget - pt.energy) * 0.45;
      else pt.energy = Math.max(0, pt.energy - pt.energy * dt * 1.5);
      pt.sway += (pt.swayT - pt.sway) * Math.min(1, dt * 6);
      pt.swayT *= 1 - Math.min(1, dt * 3);
      const poseDrive = params.pose !== undefined ? params.pose : 1;
      scratch.poseE = pt.energy * poseDrive;
      scratch.poseSway = pt.sway * poseDrive;

      // Sequencer clock: beats drive it; a fallback clock keeps the chase
      // running through beatless passages.
      const flow = Math.max(0.15, params.flow);
      if (beatActive) {
        seqStep++;
        stepAcc = 0;
      } else if (time - lastBeatT > 1.2 || !audioOn) {
        stepAcc += dt;
        const stepDur = 0.5 / flow;
        if (stepAcc >= stepDur) {
          stepAcc -= stepDur;
          seqStep++;
        }
      }

      // Packet launches: kicks push energy down bass/total cables, hats
      // spark the high lines.
      if (rig.cables.length) {
        if (beatActive) {
          const n = 2 + ((Math.random() * 3) | 0);
          for (let i = 0; i < n; i++) {
            spawnPacket((Math.random() * rig.cables.length) | 0, (Math.random() * sprites.length) | 0);
          }
        }
        if (audioOn ? audio.highs.active : scratch.highsPulse > 0.65) {
          if (Math.random() < 0.6) {
            spawnPacket((Math.random() * rig.cables.length) | 0, (Math.random() * sprites.length) | 0);
          }
        }
      }
      for (const p of packets) {
        if (!p.live) continue;
        p.t += dt * p.sp * flow * 0.9;
        if (p.t >= 1) p.live = false;
      }

      // Meter ballistics.
      const spectrum = audio.spectrum;
      for (const l of rig.ladders) {
        let target;
        if (l.band >= 0) {
          target = lv[l.band] * l.g;
        } else if (spectrum) {
          const bins = logBins(spectrum.length, 24);
          target = sampleSpec(spectrum, bins, Math.min(23, (l.frac * 23) | 0)) * l.g;
        } else {
          target = clamp01(0.2 + 0.4 * Math.sin(time * 2.2 + l.frac * 6) + 0.3 * Math.sin(time * 5.3 + l.frac * 13)) * (0.35 + 0.65 * scratch.beatPulse) * l.g;
        }
        target = clamp01(target);
        l.lvl += (target - l.lvl) * (target > l.lvl ? 0.55 : 0.12);
        if (l.lvl > l.peak) { l.peak = l.lvl; l.peakAge = 0; }
        else {
          l.peakAge += dt;
          if (l.peakAge > 0.8) l.peak = Math.max(0, l.peak - dt * 1.2);
        }
      }
      for (const v of rig.vus) {
        const drive = clamp01((audioOn ? audio.rms * 1.5 + lv[3] * 0.5 : lv[3]) * 1.1);
        v.needle += (drive - v.needle) * (drive > v.needle ? 0.16 : 0.08);
        v.pin = v.needle > 0.85 ? 1 : v.pin * 0.88;
      }
      for (const m of rig.matrices) {
        const cols = m.cols;
        for (let cx = 0; cx < cols; cx++) {
          let v;
          if (spectrum) {
            const bins = logBins(spectrum.length, cols);
            v = sampleSpec(spectrum, bins, cx);
          } else {
            v = clamp01(0.25 + 0.4 * Math.sin(time * 2.4 + cx * 0.8) + 0.3 * Math.sin(time * 5.1 + cx * 2.1)) * (0.3 + 0.7 * scratch.beatPulse);
          }
          m.vals[cx] += (v - m.vals[cx]) * 0.5;
        }
      }
      for (const d of rig.digits) {
        if (d.count) {
          // Tape counter: rolls continuously, faster when the music is hot.
          d.t += dt * d.count * (0.5 + lv[3] * 0.8 + scratch.beatPulse * 0.5);
          d.val = d.t % 100 | 0;
        } else {
          d.t += dt;
          if (d.t > 0.18) {
            d.t = 0;
            d.val = Math.min(99, Math.round(lv[d.band] * 99));
          }
        }
      }

      // ── Hero element simulation ─────────────────────────────────────────
      const poseE = scratch.poseE;
      for (const c of rig.cones) {
        // Cone excursion: slow band pump + a percussive kick, with per-mode
        // attack/release ballistics (snappy boombox, lazy vintage).
        const target = clamp01(lv[c.band] * c.g + scratch.beatPulse * c.kick);
        c.lvl += (target - c.lvl) * (target > c.lvl ? c.atk : c.rel);
      }
      for (const s of rig.sliders) {
        let target;
        if (spectrum) {
          const bins = logBins(spectrum.length, 16);
          target = sampleSpec(spectrum, bins, Math.min(15, (s.frac * 15) | 0));
        } else {
          target = clamp01(0.3 + 0.35 * Math.sin(time * 1.8 + s.frac * 7) + 0.25 * Math.sin(time * 4.7 + s.frac * 15)) * (0.4 + 0.6 * scratch.beatPulse);
        }
        target = clamp01(target * (1 + poseE * 0.5));
        s.lvl += (target - s.lvl) * (target > s.lvl ? 0.35 : 0.10);
      }
      for (const d of rig.dials) {
        if (d.drift === 'sweep') {
          // Vintage receiver: a patient sweep across the FM band.
          d.target = 0.5 + 0.38 * Math.sin(time * 0.045 + 1.7);
          d.pos += (d.target - d.pos) * 0.02;
        } else {
          // Boombox: hops stations on hard hits, nudged by performer sway.
          d.wait -= dt;
          if (d.wait <= 0 || (beatActive && Math.random() < 0.10)) {
            d.target = 0.06 + Math.random() * 0.88;
            d.wait = 3 + Math.random() * 7;
          }
          d.target = clamp01(d.target + scratch.poseSway * dt * 0.5);
          d.pos += (d.target - d.pos) * 0.07;
        }
      }
      for (const rl of rig.reels) {
        // Tape pack transfer: the supply hub empties while the take-up
        // fills, on a loop. Constant linear tape speed ⇒ angular velocity
        // scales inversely with the current pack radius — plus a little
        // bass-coupled wow.
        const prog = (time * rl.rate + rl.ph) % 1;
        rl.pack = rl.role === 'supply' ? 1 - prog : prog;
        const packR = rl.hubR + (0.2 + 0.75 * rl.pack) * (rl.r - rl.hubR);
        const wow = 1 + Math.sin(time * 7.3 + rl.ph * 40) * 0.02 * (1 + lv[0]);
        rl.ang += dt * rl.spd * wow / Math.max(0.2, packR / rl.r);
      }
      for (const p of rig.platters) {
        p.ang += dt * p.rpm * 0.10472;      // rpm → rad/s
        p.arm = (p.arm + dt / 140) % 1.06;  // one LP side, then a quick return
      }
      if (rig.motes.length) {
        const stir = 1 + poseE * 4;
        for (const m of rig.motes) {
          m.x += m.vx * dt * stir + scratch.poseSway * dt * rig.u * 2;
          m.y += m.vy * dt * stir;
          m.ph += dt;
          if (m.x < m.x0) m.x += m.w; else if (m.x > m.x0 + m.w) m.x -= m.w;
          if (m.y < m.y0) m.y += m.h; else if (m.y > m.y0 + m.h) m.y -= m.h;
        }
      }
      // The boombox bumps off the floor on the kick — harder when the
      // performer is moving harder.
      scratch.bounce = rig.hero === 'boombox'
        ? -Math.pow(scratch.beatPulse, 1.6) * rig.u * 0.9 * (0.6 + Math.min(1.4, poseE))
        : 0;

      scratch.audioOn = audioOn;
      scratch.waveform = audio.waveform;
      scratch.spectrum = spectrum;
      scratch.glow = params.glow;
      scratch.sparkle = params.sparkle;
      scratch.flow = flow;
      scratch.time = time;
    }

    // ── Render ───────────────────────────────────────────────────────────
    function render() {
      if (!rig || !staticLayer) return;
      const lv = scratch.lv;
      const glow = scratch.glow;
      const t = scratch.time;
      const u = rig.u;

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      // The boombox bounces on the kick: the whole static shot (and every
      // dynamic element, via the translate below) rides scratch.bounce.
      const bounce = scratch.bounce;
      ctx.drawImage(staticLayer, 0, bounce);
      if (bounce) {
        ctx.fillStyle = '#05050d';
        ctx.fillRect(0, H + bounce - 1, W, -bounce + 2);
      }
      ctx.save();
      ctx.translate(0, bounce);

      // Moving solid parts (tape packs, hubs, fader caps, tonearm) — drawn
      // opaque before the light pass.
      if (rig.hero) renderHeroSolids();

      ctx.globalCompositeOperation = 'lighter';

      // Faint ambient floor tint only — just enough that the deep background
      // isn't dead black. Deliberately NOT tied to `glow`: the glow slider is
      // for per-element bloom (knobs / LEDs / cables), not a room wash.
      const [hFloor] = pal.wash;
      const aFloor = 0.018 + lv[0] * 0.045;
      if (aFloor > 0.005) {
        const gr = ctx.createRadialGradient(W * 0.5, H * 1.08, 0, W * 0.5, H * 1.08, H * 0.85);
        gr.addColorStop(0, `hsla(${hFloor},80%,52%,${aFloor})`);
        gr.addColorStop(1, `hsla(${hFloor},80%,52%,0)`);
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, W, H);
      }

      // Cable glow — each patched line individually blooms + pulses with the
      // band it carries. Two soft bloom passes (wide, dim) under a bright
      // beam core, so a live cable reads as a glowing tube, not a flat line.
      ctx.lineCap = 'round';
      for (const c of rig.cables) {
        const e = lv[c.band];
        const pulse = scratch.beatPulse * (c.band === 0 || c.band === 3 ? 0.35 : 0.15);
        const a = Math.min(1, (e * 0.55 + pulse) * glow);
        if (a < 0.02) continue;
        // Wide outer bloom.
        ctx.strokeStyle = `hsla(${c.hue},95%,58%,${a * 0.35})`;
        ctx.lineWidth = c.lw + 10 + e * 8;
        strokeCable(ctx, c);
        // Mid glow.
        ctx.strokeStyle = `hsla(${c.hue},98%,64%,${a * 0.7})`;
        ctx.lineWidth = c.lw + 3;
        strokeCable(ctx, c);
        // Bright beam core.
        ctx.strokeStyle = `hsla(${c.hue},100%,86%,${a})`;
        ctx.lineWidth = Math.max(1.2, c.lw * 0.4);
        strokeCable(ctx, c);
      }

      // Signal packets riding the cables.
      for (const p of packets) {
        if (!p.live) continue;
        const c = rig.cables[p.cable];
        if (!c) continue;
        const spr = sprites[p.ci];
        const fade = Math.sin(p.t * Math.PI);
        for (let k = 0; k < 3; k++) {
          const tt = Math.max(0, p.t - k * 0.035);
          bezPoint(c, tt);
          const s = u * (2.6 - k * 0.6);
          ctx.globalAlpha = fade * (0.85 - k * 0.28) * glow;
          ctx.drawImage(spr, bp.x - s / 2, bp.y - s / 2, s, s);
        }
      }
      ctx.globalAlpha = 1;

      // LEDs.
      let sparkles = 0;
      const sparkOn = scratch.sparkle > 0.02;
      for (let i = 0; i < rig.leds.length; i++) {
        const l = rig.leds[i];
        let b;
        switch (l.kind) {
          case 'gate':
            b = lv[l.band] > l.th ? 0.95 : 0.06;
            break;
          case 'twinkle': {
            const n = Math.sin(l.ph * 127.1 + Math.floor(t * 3 + l.ph) * 311.7) * 43758.5453;
            const h = n - Math.floor(n);
            b = h < 0.18 + lv[2] * 0.55 ? 0.5 + lv[2] * 0.5 : 0.05;
            break;
          }
          case 'pulse':
            b = scratch.beatPulse * 0.95 + 0.04;
            break;
          default:
            b = 0.12 + lv[l.band] * 0.88;
        }
        const bg = Math.min(1.4, b * glow);
        if (bg < 0.03) continue;
        const spr = sprites[l.ci];
        // Square emitter core (LED body) — crisp lit rectangle.
        if (l.sq) {
          const c = pal.leds[l.ci];
          ctx.globalAlpha = 1;
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, bg) * 0.85})`;
          ctx.fillRect(l.x - l.s * 0.3, l.y - l.s * 0.22, l.s * 0.6, l.s * 0.44);
        }
        // Individual bloom: brighter LEDs throw a proportionally bigger,
        // stronger halo so each one visibly blooms/pulses on its own.
        const bloomS = l.s * (0.85 + bg * 1.4);
        ctx.globalAlpha = Math.min(1, bg * 0.9);
        ctx.drawImage(spr, l.x - bloomS / 2, l.y - bloomS / 2, bloomS, bloomS);
        // Hot LEDs get a hard white-hot centre kick.
        if (bg > 0.7) {
          const hs = l.s * 0.5;
          ctx.globalAlpha = Math.min(1, (bg - 0.7) * 2);
          ctx.drawImage(spr, l.x - hs / 2, l.y - hs / 2, hs, hs);
        }
        // Sparkle filter on the hottest LEDs.
        if (sparkOn && bg > 0.72 && sparkles < MAX_SPARKLES) {
          const n = Math.sin(i * 91.7 + Math.floor(t * 2.3) * 517.3) * 24634.63;
          const h = n - Math.floor(n);
          if (h < scratch.sparkle * 0.7) {
            sparkles++;
            const ss = l.s * (1.8 + h * 3) * (0.8 + scratch.highsPulse * 0.6);
            ctx.save();
            ctx.translate(l.x, l.y);
            ctx.rotate(h * 6.28 + t * 0.3);
            ctx.globalAlpha = Math.min(1, bg) * (0.45 + scratch.sparkle * 0.5);
            ctx.drawImage(sparkSprite, -ss / 2, -ss / 2, ss, ss);
            ctx.restore();
          }
        }
      }
      ctx.globalAlpha = 1;

      // Knob rings + indicators + individual bloom.
      for (const k of rig.knobs) {
        const e = lv[k.band];
        const c = pal.leds[k.ci];
        const a0 = -Math.PI * 0.75 - Math.PI / 2;
        const lit = 0.08 + e * 0.92;
        // Per-knob bloom halo — the knob's collar glows in its band colour,
        // pumping with that band and flashing a touch on the beat.
        const bloom = (e * 0.85 + scratch.beatPulse * 0.12) * glow;
        if (bloom > 0.05) {
          const spr = sprites[k.ci];
          const s = k.r * (3.0 + bloom * 2.8);
          ctx.globalAlpha = Math.min(0.85, bloom * 0.6);
          ctx.drawImage(spr, k.x - s / 2, k.y - s / 2, s, s);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, (0.22 + e * 0.85) * glow)})`;
        ctx.lineWidth = Math.max(1.5, k.r * 0.22);
        ctx.beginPath();
        ctx.arc(k.x, k.y, k.r * 1.25, a0, a0 + lit * Math.PI * 1.5);
        ctx.stroke();
        // Pointer wobbles subtly with its band — an invisible hand riding
        // the mix.
        const ang = a0 + (0.5 + k.base * 0.3 + Math.sin(t * 0.8 + k.wob * 9) * 0.04 + e * k.wob * 0.22) * Math.PI * 1.5;
        ctx.strokeStyle = `rgba(235,240,255,${0.5 + e * 0.5})`;
        ctx.lineWidth = Math.max(1.5, k.r * 0.16);
        ctx.beginPath();
        ctx.moveTo(k.x + Math.cos(ang) * k.r * 0.25, k.y + Math.sin(ang) * k.r * 0.25);
        ctx.lineTo(k.x + Math.cos(ang) * k.r * 0.88, k.y + Math.sin(ang) * k.r * 0.88);
        ctx.stroke();
      }

      // Ladders (lit segments only; dim bases live in the static layer).
      for (const l of rig.ladders) {
        const n = l.n;
        const lit = Math.round(l.lvl * n);
        const peakSeg = Math.min(n - 1, Math.round(l.peak * n) - 1);
        for (let i = 0; i < lit; i++) {
          const f = i / n;
          let style;
          if (l.grn) {
            style = f < 0.6 ? `rgba(60,255,120,${0.85 * glow})`
                  : f < 0.85 ? `rgba(255,210,60,${0.9 * glow})`
                  : `rgba(255,60,50,${0.95 * glow})`;
          } else {
            const c = pal.leds[(i + (l.frac * 3) | 0) % pal.leds.length];
            style = `rgba(${c[0]},${c[1]},${c[2]},${(0.55 + f * 0.45) * glow})`;
          }
          ctx.fillStyle = style;
          if (l.horiz) {
            const sw = l.w / n;
            ctx.fillRect(l.x + i * sw + 0.5, l.y, sw - 1.5, l.h);
          } else {
            const sh = l.h / n;
            ctx.fillRect(l.x, l.y + l.h - (i + 1) * sh + 0.5, l.w, sh - 1.5);
          }
        }
        if (peakSeg >= lit && peakSeg >= 0) {
          ctx.fillStyle = `rgba(255,255,255,${0.75 * glow})`;
          if (l.horiz) {
            const sw = l.w / n;
            ctx.fillRect(l.x + peakSeg * sw + 0.5, l.y, sw - 1.5, l.h);
          } else {
            const sh = l.h / n;
            ctx.fillRect(l.x, l.y + l.h - (peakSeg + 1) * sh + 0.5, l.w, sh - 1.5);
          }
        }
      }

      // Matrices: spectrum columns light bottom-up; the clock column sweeps.
      for (const m of rig.matrices) {
        const c = pal.leds[m.ci];
        const runCol = (seqStep + m.off) % m.cols;
        for (let cx = 0; cx < m.cols; cx++) {
          const v = m.vals[cx];
          const litRows = Math.round(v * m.rows);
          const isRun = cx === runCol;
          for (let ry = 0; ry < m.rows; ry++) {
            const on = ry < litRows;
            if (!on && !isRun) continue;
            const px = m.x + cx * m.cell * 1.35;
            const py = m.y + (m.rows - 1 - ry) * m.cell * 1.35;
            const a = on ? (0.35 + (ry / m.rows) * 0.6) * glow : 0.10 * glow;
            ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, a + (isRun ? 0.22 : 0))})`;
            ctx.fillRect(px, py, m.cell, m.cell);
          }
        }
      }

      // Sequencer chases.
      for (const s of rig.seqs) {
        const c = pal.leds[s.ci];
        const sw = s.w / s.n;
        const cur = (seqStep + s.off) % s.n;
        for (let i = 0; i < s.n; i++) {
          let a = 0;
          if (i === cur) a = 0.9 + scratch.beatPulse * 0.1;
          else {
            const back = (cur - i + s.n) % s.n;
            if (back <= 2) a = 0.35 / back;
          }
          if (a < 0.03) continue;
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, a * glow)})`;
          ctx.fillRect(s.x + i * sw + 1, s.y, sw - 2, s.h);
        }
        // Glow blob on the active step.
        const spr = sprites[s.ci];
        ctx.globalAlpha = Math.min(1, (0.5 + scratch.beatPulse * 0.5) * glow);
        const gx = s.x + cur * sw + sw / 2, gs = s.h * 3.2;
        ctx.drawImage(spr, gx - gs / 2, s.y + s.h / 2 - gs / 2, gs, gs);
        ctx.globalAlpha = 1;
      }

      // 7-segment readouts.
      for (const d of rig.digits) {
        const c = pal.leds[d.ci];
        const dw = d.h * 0.55;
        const tens = (d.val / 10) | 0, ones = d.val % 10;
        drawDigit(d.x, d.y, dw, d.h, tens, c, glow);
        drawDigit(d.x + dw * 1.45, d.y, dw, d.h, ones, c, glow);
      }

      // VU needles + backlight breathing.
      for (const v of rig.vus) {
        ctx.fillStyle = `rgba(255,190,90,${(0.10 + v.needle * 0.30) * glow})`;
        ctx.fillRect(v.x, v.y, v.w, v.h);
        const cx = v.x + v.w / 2, cy = v.y + v.h * 0.95, rad = v.h * 0.78;
        const ang = -Math.PI * 0.85 + clamp01(v.needle) * Math.PI * 0.7;
        ctx.strokeStyle = 'rgba(20,14,8,0.95)';
        ctx.lineWidth = Math.max(1.5, v.h * 0.03);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
        ctx.stroke();
        if (v.pin > 0.05) {
          const spr = sprites[0];
          const s = v.h * 0.6;
          ctx.globalAlpha = v.pin * glow;
          ctx.drawImage(spr, v.x + v.w - s * 0.8, v.y + s * 0.1, s, s);
          ctx.globalAlpha = 1;
        }
      }

      // Scopes: round CRT with a horizontal waveform sweep (idle: slow
      // Lissajous rose).
      for (const sc of rig.scopes) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, sc.r * 0.96, 0, Math.PI * 2);
        ctx.clip();
        const wf = scratch.waveform;
        ctx.lineWidth = Math.max(1.2, u * 0.24);
        ctx.strokeStyle = `rgba(150,255,220,${0.8 * glow})`;
        ctx.beginPath();
        if (wf) {
          const N = wf.length;
          const amp = sc.r * 0.55 * (0.5 + lv[3] * 0.7 + scratch.beatPulse * 0.3);
          for (let i = 0; i <= 64; i++) {
            const x = sc.x - sc.r + (i / 64) * sc.r * 2;
            const s = wf[((i / 64) * (N - 1)) | 0];
            const y = sc.y + ((s - 128) / 128) * amp;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
        } else {
          const tt = t * 0.7 + sc.ph;
          for (let i = 0; i <= 72; i++) {
            const a = (i / 72) * Math.PI * 2;
            const x = sc.x + sc.r * 0.6 * Math.sin(3 * a + tt);
            const y = sc.y + sc.r * 0.6 * Math.sin(2 * a);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
        // Tube glow.
        const gr = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, sc.r);
        gr.addColorStop(0, `rgba(120,255,210,${(0.05 + lv[3] * 0.10) * glow})`);
        gr.addColorStop(1, 'rgba(120,255,210,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(sc.x - sc.r, sc.y - sc.r, sc.r * 2, sc.r * 2);
        ctx.restore();
      }

      // Hero light pass: neon rings, underglow, cone excursion light, fader
      // glow, dial needles, VFD glyphs, platter sheen, dust motes.
      if (rig.hero) renderHeroGlow();

      // Kick flash — a very faint full-wall breath on a hard hit. Kept
      // subtle; the punch now lives in the per-element blooms above.
      if (scratch.beatPulse > 0.05) {
        ctx.fillStyle = `hsla(${hFloor},70%,60%,${scratch.beatPulse * 0.02})`;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }

    // Opaque moving hardware: rendered between the static blit and the
    // light pass, so glows land on top of the moving parts.
    function renderHeroSolids() {
      const u = rig.u;
      const lv0 = scratch.lv[0];

      // Tape reels: pack disc (radius = live pack transfer) + rotating hub.
      for (const rl of rig.reels) {
        const packR = rl.hubR + (0.2 + 0.75 * rl.pack) * (rl.r - rl.hubR);
        if (rl.big) {
          // Open reel: tape pack under a slim 3-spoke aluminum flange.
          ctx.beginPath(); ctx.arc(rl.x, rl.y, packR, 0, 6.2832);
          ctx.fillStyle = 'rgba(42,31,24,0.97)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,215,160,0.14)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.strokeStyle = 'rgba(140,145,158,0.55)';
          ctx.lineWidth = Math.max(1.2, rl.r * 0.035);
          ctx.beginPath(); ctx.arc(rl.x, rl.y, rl.r, 0, 6.2832); ctx.stroke();
          for (let k = 0; k < 3; k++) {
            const a = rl.ang + k * 2.0944;
            ctx.beginPath();
            ctx.moveTo(rl.x + Math.cos(a) * rl.hubR * 0.5, rl.y + Math.sin(a) * rl.hubR * 0.5);
            ctx.lineTo(rl.x + Math.cos(a) * rl.r * 0.97, rl.y + Math.sin(a) * rl.r * 0.97);
            ctx.stroke();
          }
          ctx.beginPath(); ctx.arc(rl.x, rl.y, rl.hubR * 0.45, 0, 6.2832);
          ctx.fillStyle = 'rgba(160,164,176,0.8)';
          ctx.fill();
        } else {
          // Cassette hub: tape pack with an edge sheen, cream hub ring, and
          // rotating drive teeth.
          ctx.beginPath(); ctx.arc(rl.x, rl.y, packR, 0, 6.2832);
          ctx.fillStyle = 'rgba(30,23,19,0.96)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(150,112,84,0.30)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.strokeStyle = 'rgba(216,218,226,0.9)';
          ctx.lineWidth = Math.max(1.5, rl.hubR * 0.28);
          ctx.beginPath(); ctx.arc(rl.x, rl.y, rl.hubR * 0.85, 0, 6.2832); ctx.stroke();
          ctx.lineWidth = Math.max(1.2, rl.hubR * 0.20);
          for (let k = 0; k < 6; k++) {
            const a = rl.ang + k * 1.0472;
            ctx.beginPath();
            ctx.moveTo(rl.x + Math.cos(a) * rl.hubR * 0.68, rl.y + Math.sin(a) * rl.hubR * 0.68);
            ctx.lineTo(rl.x + Math.cos(a) * rl.hubR * 0.26, rl.y + Math.sin(a) * rl.hubR * 0.26);
            ctx.stroke();
          }
        }
      }

      // Fader caps riding the spectrum.
      for (const s of rig.sliders) {
        const cy = s.y + s.h - s.lvl * s.h;
        ctx.fillStyle = 'rgba(10,10,14,0.9)';
        ctx.fillRect(s.x - s.w * 1.4, cy - u * 0.85, s.w * 2.8, u * 1.7);
        ctx.fillStyle = 'rgba(205,208,218,0.95)';
        ctx.fillRect(s.x - s.w * 1.2, cy - u * 0.65, s.w * 2.4, u * 1.3);
        ctx.fillStyle = 'rgba(30,32,40,0.9)';
        ctx.fillRect(s.x - s.w * 1.2, cy - u * 0.12, s.w * 2.4, u * 0.24);
      }

      // Turntable: rotating label marker + tracking tonearm.
      for (const p of rig.platters) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(1, p.sq);
        const mr = p.r * 0.19;
        ctx.fillStyle = 'rgba(235,215,180,0.75)';
        ctx.beginPath();
        ctx.arc(Math.cos(p.ang) * mr, Math.sin(p.ang) * mr, p.r * 0.045, 0, 6.2832);
        ctx.fill();
        ctx.restore();
        // Tonearm tracks inward over the side; the stylus rides a hair of
        // bass vibration.
        const t2 = Math.min(1, p.arm);
        const rr = p.r * (0.95 - 0.55 * t2);
        const na = 0.55;
        const nx = p.x + Math.cos(na) * rr;
        const ny = p.y + Math.sin(na) * rr * p.sq + Math.sin(scratch.time * 48) * lv0 * u * 0.06;
        ctx.strokeStyle = 'rgba(205,208,218,0.85)';
        ctx.lineWidth = Math.max(1.5, u * 0.35);
        ctx.beginPath();
        ctx.moveTo(p.pivX, p.pivY);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(150,152,160,0.8)';
        ctx.lineWidth = Math.max(2, u * 0.55);
        ctx.beginPath();
        ctx.moveTo(p.pivX, p.pivY);
        ctx.lineTo(p.pivX + (p.pivX - nx) * 0.16, p.pivY + (p.pivY - ny) * 0.16);
        ctx.stroke();
        ctx.fillStyle = 'rgba(220,222,230,0.9)';
        ctx.fillRect(nx - u * 0.5, ny - u * 0.5, u, u);
      }
    }

    // Everything the hero devices *emit*: composited 'lighter' on top.
    function renderHeroGlow() {
      const u = rig.u;
      const glow = scratch.glow;
      const lv = scratch.lv;
      const t = scratch.time;
      const poseE = scratch.poseE;

      // Boombox underglow — the exaggerated street-neon floor pool. Squashed
      // to a flat ellipse so it hugs the ground instead of washing the body.
      if (rig.hero === 'boombox' && rig.heroGeom) {
        const gm = rig.heroGeom;
        const hue = (pal.wash[0] + t * 14) % 360;
        const a = (0.12 + lv[0] * 0.26 + poseE * 0.18) * glow;
        const gy = gm.y0 + gm.bh * 1.03;
        ctx.save();
        ctx.translate(W / 2, gy);
        ctx.scale(1, 0.28);
        const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, gm.bw * 0.60);
        gr.addColorStop(0, `hsla(${hue},95%,60%,${a})`);
        gr.addColorStop(1, `hsla(${hue},95%,60%,0)`);
        ctx.fillStyle = gr;
        ctx.fillRect(-gm.bw * 0.62, -gm.bw * 0.62, gm.bw * 1.24, gm.bw * 1.24);
        ctx.restore();
      }
      // Vintage lamp breath — the room inhales with the mix.
      if (rig.hero === 'vintage') {
        const a = (0.02 + lv[3] * 0.05 + poseE * 0.03) * glow;
        const gr = ctx.createRadialGradient(W * 0.12, H * 0.02, 0, W * 0.12, H * 0.02, H * 0.65);
        gr.addColorStop(0, `rgba(255,190,110,${a})`);
        gr.addColorStop(1, 'rgba(255,190,110,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, W, H * 0.7);
      }

      // Speaker cones: excursion light + surround flare (+ neon trim ring).
      for (const c of rig.cones) {
        const e = c.lvl;
        const warm = c.style === 'warm';
        // Off-axis light catching the moving cone.
        const ca = (0.04 + e * (warm ? 0.30 : 0.45)) * glow;
        const cg = ctx.createRadialGradient(c.x - c.r * 0.25, c.y - c.r * 0.28, c.r * 0.05, c.x, c.y, c.r * (0.92 + e * 0.10));
        cg.addColorStop(0, warm ? `rgba(255,215,160,${ca})` : `rgba(200,215,235,${ca})`);
        cg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = cg;
        ctx.fillRect(c.x - c.r * 1.1, c.y - c.r * 1.1, c.r * 2.2, c.r * 2.2);
        // Surround flare on the push.
        ctx.strokeStyle = warm
          ? `rgba(255,200,140,${(0.05 + e * 0.35) * glow})`
          : `rgba(220,230,250,${(0.06 + e * 0.5) * glow})`;
        ctx.lineWidth = Math.max(1, u * (0.25 + e * 0.5));
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r * 0.985, 0, 6.2832);
        ctx.stroke();
        // Neon trim ring (boombox): triple-stroke bloom, like a lit cable.
        if (c.ring) {
          const col = pal.leds[c.ci];
          const na2 = Math.min(1, (0.28 + lv[0] * 0.55 + scratch.beatPulse * 0.30 + poseE * 0.25) * glow);
          ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${na2 * 0.30})`;
          ctx.lineWidth = u * 2.6 + e * u * 2.0;
          ctx.beginPath(); ctx.arc(c.x, c.y, c.r * 1.11, 0, 6.2832); ctx.stroke();
          ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${na2 * 0.7})`;
          ctx.lineWidth = u * 0.9;
          ctx.beginPath(); ctx.arc(c.x, c.y, c.r * 1.11, 0, 6.2832); ctx.stroke();
          ctx.strokeStyle = `rgba(255,255,255,${na2 * 0.55})`;
          ctx.lineWidth = Math.max(1, u * 0.28);
          ctx.beginPath(); ctx.arc(c.x, c.y, c.r * 1.11, 0, 6.2832); ctx.stroke();
        }
        // Dust-cap glint.
        if (e > 0.04) {
          const spr = sprites[c.ci];
          const s = c.r * (0.45 + e * 0.85);
          ctx.globalAlpha = Math.min(0.8, e * (warm ? 0.35 : 0.55) * glow);
          ctx.drawImage(spr, c.x - s / 2, c.y - s / 2, s, s);
          ctx.globalAlpha = 1;
        }
      }

      // Fader glow: the slot lights up to the cap, cap centerline blooms.
      for (const s of rig.sliders) {
        const col = pal.leds[s.ci];
        const cy = s.y + s.h - s.lvl * s.h;
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${(0.10 + s.lvl * 0.35) * glow})`;
        ctx.fillRect(s.x - s.w * 0.5, cy, s.w, s.y + s.h - cy);
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${(0.45 + s.lvl * 0.55) * glow})`;
        ctx.fillRect(s.x - s.w * 1.2, cy - u * 0.12, s.w * 2.4, u * 0.24);
      }

      // Tuner dials: backlight breath + glowing needle.
      for (const d of rig.dials) {
        const a = (0.05 + lv[3] * 0.09 + (d.warm ? 0.05 : 0.01) + poseE * 0.04) * glow;
        ctx.fillStyle = d.warm ? `rgba(255,205,130,${a})` : `rgba(170,230,255,${a})`;
        ctx.fillRect(d.x, d.y, d.w, d.h);
        const nx = d.x + d.w * (0.03 + d.pos * 0.94);
        ctx.fillStyle = `rgba(255,120,90,${0.9 * glow})`;
        ctx.fillRect(nx - 0.75, d.y + 1, 1.5, d.h - 2);
        const spr = sprites[3 % sprites.length];
        const ns = d.h * 1.5;
        ctx.globalAlpha = Math.min(0.7, (0.30 + lv[3] * 0.25) * glow);
        ctx.drawImage(spr, nx - ns / 2, d.y + d.h / 2 - ns / 2, ns, ns);
        ctx.globalAlpha = 1;
      }

      // Deck lamp wash — each playing window glows its deck color.
      for (const rl of rig.reels) {
        if (!rl.tint || !rl.ww) continue;
        const col = rl.tint;
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${(0.07 + lv[3] * 0.13 + scratch.beatPulse * 0.06) * glow})`;
        ctx.fillRect(rl.wx, rl.wy, rl.ww, rl.wh);
      }

      // Turntable: groove sheen shimmering as the record passes under the
      // lamp, and strobe dots chasing around the platter rim.
      for (const p of rig.platters) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(1, p.sq);
        const sh = (0.05 + lv[3] * 0.10 + 0.03 * Math.sin(p.ang * 3)) * glow;
        ctx.strokeStyle = `rgba(255,240,215,${sh})`;
        ctx.lineWidth = Math.max(1, p.r * 0.035);
        for (const rr of [0.45, 0.62, 0.80, 0.93]) {
          const wob = Math.sin(p.ang * 0.5) * 0.1;
          ctx.beginPath();
          ctx.arc(0, 0, p.r * rr, -1.9 + wob, -1.15 + wob);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, 0, p.r * rr, 1.25, 1.95);
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(255,190,120,${(0.25 + lv[3] * 0.4) * glow})`;
        for (let k = 0; k < 18; k++) {
          const a2 = (k / 18) * 6.2832;
          if (Math.sin(a2 * 9 - p.ang * 9) <= 0.55) continue;
          ctx.beginPath();
          ctx.arc(Math.cos(a2) * p.r * 1.06, Math.sin(a2) * p.r * 1.06, p.r * 0.03, 0, 6.2832);
          ctx.fill();
        }
        ctx.restore();
      }

      // Lit glyphs: VFD banners, chase chevrons, stereo lamps.
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      for (const gl of rig.glyphs) {
        let a;
        switch (gl.mode) {
          case 'blink': a = Math.sin(t * 2.4 + gl.ph) > -0.2 ? 0.75 : 0.10; break;
          case 'beat':  a = 0.15 + scratch.beatPulse * 0.85; break;
          case 'chase': a = (seqStep + gl.ph) % 3 === 0 ? 0.9 : 0.15; break;
          default:      a = 0.5 + lv[3] * 0.3;
        }
        const col = pal.leds[gl.ci];
        ctx.font = `${gl.size}px ui-monospace, monospace`;
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${Math.min(1, a * glow)})`;
        ctx.fillText(gl.text, gl.x, gl.y);
      }

      // Dust motes twinkling through the lamp shaft.
      for (const m of rig.motes) {
        const a = (0.04 + 0.10 * (0.5 + 0.5 * Math.sin(m.ph * 1.7))) * glow;
        ctx.fillStyle = `rgba(255,225,180,${a})`;
        ctx.fillRect(m.x, m.y, u * 0.22, u * 0.22);
      }
    }

    function drawDigit(x, y, w, h, digit, c, glow) {
      const on = SEG_ON[digit] || SEG_ON[0];
      ctx.lineWidth = Math.max(1.5, h * 0.10);
      ctx.lineCap = 'round';
      for (let s = 0; s < 7; s++) {
        const gseg = SEG_GEO[s];
        ctx.strokeStyle = on[s]
          ? `rgba(${c[0]},${c[1]},${c[2]},${0.9 * glow})`
          : `rgba(${c[0]},${c[1]},${c[2]},0.07)`;
        ctx.beginPath();
        ctx.moveTo(x + gseg[0] * w, y + gseg[1] * h);
        ctx.lineTo(x + gseg[2] * w, y + gseg[3] * h);
        ctx.stroke();
      }
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        rigKey = '';   // force rebuild on next update
      },
      update,
      render,
      dispose() { /* GC handles canvases + typed arrays */ },
    };
  },
};
