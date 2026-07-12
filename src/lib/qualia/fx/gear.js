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

import { scaleAudio } from '../field.js';

const MAX_LEDS     = 420;
const MAX_KNOBS    = 132;
const MAX_CABLES   = 56;
const MAX_PACKETS  = 28;
const MAX_SPARKLES = 44;
const MAX_SCOPES   = 2;
const MAX_VUS      = 4;
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
    { id: 'layout',  label: 'layout',  type: 'select', options: ['wall', 'modular', 'rack'], default: 'wall' },
    { id: 'palette', label: 'palette', type: 'select', options: ['neon', 'crimson', 'amber', 'dusk', 'rainbow'], default: 'neon' },
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
  ],

  // Phase button tours the studio: neon wall → crimson modular den →
  // blue-hour mastering rack → gold-hour cable jungle → sparkle finale.
  autoPhase: {
    steps: [
      { layout: 'wall',    palette: 'neon',    cables: 1.0, sparkle: 0.30 },
      { layout: 'modular', palette: 'crimson', cables: 1.6, sparkle: 0.20 },
      { layout: 'rack',    palette: 'dusk',    cables: 0.5, sparkle: 0.15 },
      { layout: 'modular', palette: 'amber',   cables: 1.8, sparkle: 0.55 },
      { layout: 'wall',    palette: 'rainbow', cables: 1.3, sparkle: 0.80 },
    ],
  },

  presets: {
    default:   { layout: 'wall',    palette: 'neon',    density: 1.0, cables: 1.0,  glow: 1.0,  sparkle: 0.30, flow: 1.0, reactivity: 1.0 },
    devine:    { layout: 'modular', palette: 'crimson', cables: 1.7,  glow: 1.25, sparkle: 0.20 },
    mastering: { layout: 'rack',    palette: 'dusk',    cables: 0.35, glow: 0.9,  sparkle: 0.15 },
    goldrush:  { layout: 'modular', palette: 'amber',   cables: 1.9,  glow: 1.2,  sparkle: 0.55 },
    stardust:  { layout: 'wall',    palette: 'rainbow', cables: 1.3,  glow: 1.1,  sparkle: 0.90 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const seed = (Math.random() * 0xffffffff) >>> 0;

    // ── Rig state (rebuilt on layout/palette/density/cables/resize) ──────
    let rig = null;
    let rigKey = '';
    let pal = PALETTES.neon;
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
        digits: [],   // {x,y,h,band,val,t,ci}
        jacks: [],    // {x,y}
        cables: [],   // {x0,y0,x1,y1,cx1,cy1,cx2,cy2,hue,band,lw}
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

      // Row split. Density scales row count; each row is euro or 19" rack.
      const nRows = Math.max(3, Math.min(9,
        Math.round((4.6 + params.density * 2.8) * (H >= W ? 1.15 : 0.85))));
      const railH = Math.max(3, u * 0.9);
      const rowH = H / nRows;

      const euroBias = params.layout === 'modular' ? 0.86
                     : params.layout === 'rack'    ? 0.16
                     :                               0.55;

      for (let r = 0; r < nRows; r++) {
        const y = r * rowH;
        const h = rowH - railH;
        if (rnd() < euroBias) buildEuroRow(y, h, rnd, led, knob, jack, pick);
        else buildRackRow(y, h, rnd, led, knob, jack, pick, params);
      }

      buildCables(params, rnd);
      // Sprites + static layer.
      sprites = pal.leds.map(makeGlowSprite);
      if (!sparkSprite) sparkSprite = makeSparkSprite();
      drawStatic();
    }

    // A eurorack row: narrow modules, dense jacks, matrices and mini seqs.
    function buildEuroRow(y, h, rnd, led, knob, jack, pick) {
      const u = rig.u;
      let x = 0;
      while (x < W - u * 4) {
        const mw = Math.min(W - x, u * (7 + rnd() * 15));
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
          knob(inner.x + inner.w * 0.68, inner.y + inner.h * 0.22, u * (1.4 + rnd()), (rnd() * pal.leds.length) | 0, (rnd() * 3) | 0);
        } else {
          // Knob stack.
          const rows = Math.max(1, Math.min(3, (inner.h / (u * 6)) | 0));
          for (let kr = 0; kr < rows; kr++) {
            const ky = inner.y + inner.h * ((kr + 0.5) / rows) * 0.72;
            const perRow = inner.w > u * 10 ? 2 : 1;
            for (let kc = 0; kc < perRow; kc++) {
              const kx = inner.x + inner.w * ((kc + 0.5) / perRow);
              knob(kx, ky, u * (1.3 + rnd() * 1.3), (rnd() * pal.leds.length) | 0, (rnd() * 3) | 0);
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

        // Jack field along the module bottom — the patch bay.
        const jy = y + h - u * 1.9;
        const nj = Math.max(2, Math.min(6, (mw / (u * 3.2)) | 0));
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

    function buildCables(params, rnd) {
      const jacks = rig.jacks;
      if (jacks.length < 4 || params.cables <= 0) return;
      const want = Math.min(MAX_CABLES, Math.round(jacks.length * 0.30 * params.cables));
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

    const scratch = {
      lv: new Float32Array(4),   // bass, mids, highs, total
      beatPulse: 0, highsPulse: 0,
      audioOn: false,
      waveform: null, spectrum: null,
      glow: 1, sparkle: 0, flow: 1,
      time: 0,
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
        d.t += dt;
        if (d.t > 0.18) {
          d.t = 0;
          d.val = Math.min(99, Math.round(lv[d.band] * 99));
        }
      }

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
      ctx.drawImage(staticLayer, 0, 0);

      ctx.globalCompositeOperation = 'lighter';

      // Ambient room washes — a warm floor glow pumping with bass and a
      // cooler ceiling tint on total energy.
      const [hFloor, hCeil] = pal.wash;
      const aFloor = (0.05 + lv[0] * 0.16) * glow;
      if (aFloor > 0.01) {
        const gr = ctx.createRadialGradient(W * 0.5, H * 1.05, 0, W * 0.5, H * 1.05, H * 0.9);
        gr.addColorStop(0, `hsla(${hFloor},85%,55%,${aFloor})`);
        gr.addColorStop(1, `hsla(${hFloor},85%,55%,0)`);
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, W, H);
      }
      const aCeil = (0.03 + lv[3] * 0.10) * glow;
      if (aCeil > 0.01) {
        const gr = ctx.createRadialGradient(W * 0.5, -H * 0.1, 0, W * 0.5, -H * 0.1, H * 0.8);
        gr.addColorStop(0, `hsla(${hCeil},80%,60%,${aCeil})`);
        gr.addColorStop(1, `hsla(${hCeil},80%,60%,0)`);
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, W, H);
      }

      // Cable glow — each patched line carries its band's energy.
      ctx.lineCap = 'round';
      for (const c of rig.cables) {
        const e = lv[c.band];
        const a = e * 0.42 * glow;
        if (a < 0.02) continue;
        ctx.strokeStyle = `hsla(${c.hue},95%,62%,${a})`;
        ctx.lineWidth = c.lw + 4;
        strokeCable(ctx, c);
        ctx.strokeStyle = `hsla(${c.hue},95%,80%,${a * 0.9})`;
        ctx.lineWidth = Math.max(1.2, c.lw * 0.45);
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
        b *= glow;
        if (b < 0.03) continue;
        const spr = sprites[l.ci];
        ctx.globalAlpha = Math.min(1, b);
        if (l.sq) {
          const c = pal.leds[l.ci];
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, b) * 0.8})`;
          ctx.fillRect(l.x - l.s * 0.3, l.y - l.s * 0.22, l.s * 0.6, l.s * 0.44);
        }
        ctx.drawImage(spr, l.x - l.s / 2, l.y - l.s / 2, l.s, l.s);
        // Sparkle filter on the hottest LEDs.
        if (sparkOn && b > 0.72 && sparkles < MAX_SPARKLES) {
          const n = Math.sin(i * 91.7 + Math.floor(t * 2.3) * 517.3) * 24634.63;
          const h = n - Math.floor(n);
          if (h < scratch.sparkle * 0.7) {
            sparkles++;
            const ss = l.s * (1.8 + h * 3) * (0.8 + scratch.highsPulse * 0.6);
            ctx.save();
            ctx.translate(l.x, l.y);
            ctx.rotate(h * 6.28 + t * 0.3);
            ctx.globalAlpha = Math.min(1, b) * (0.45 + scratch.sparkle * 0.5);
            ctx.drawImage(sparkSprite, -ss / 2, -ss / 2, ss, ss);
            ctx.restore();
          }
        }
      }
      ctx.globalAlpha = 1;

      // Knob rings + indicators.
      for (const k of rig.knobs) {
        const e = lv[k.band];
        const c = pal.leds[k.ci];
        const a0 = -Math.PI * 0.75 - Math.PI / 2;
        const lit = 0.08 + e * 0.92;
        ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${(0.18 + e * 0.72) * glow})`;
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

      // Kick flash — the whole wall breathes on a hit.
      if (scratch.beatPulse > 0.05) {
        ctx.fillStyle = `hsla(${hFloor},70%,60%,${scratch.beatPulse * 0.05 * glow})`;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.globalCompositeOperation = 'source-over';
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
