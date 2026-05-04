// Synthwave — neon retrofuture audio-reactive landscape. Four phase
// modes share a backdrop (sky / stars / sun) and swap the foreground:
//   horizon    sun + spectrum-as-mountain + grid
//   road       sun + spectrum-as-mountain (low) + grid + outrun strip
//   city       sun + skyline rectangles (from spectrum) + grid
//   dreamscape sun + spectrum-as-mountain (low) + grid + palms
//
// The spectrum polyline IS the mountain silhouette — the gradient
// underfill makes it read as a ridge, and the EQ behaviour gives the
// whole landscape a "horizon line is the music" feel (the brief's
// headline). No separate procedural mountain layer.
//
// Audio map (declarative — see `modulators` in the params schema):
//   audio.total       → params.gridSpeed (mul, default 0.0 = off)
//   audio.bass        → params.sunSize   (mul, default 0.30)
//   audio.beatPulse   → params.sunSize   (mul, default 0.10)
// Audio map (inline — visual flavour, not user-tunable knobs):
//   audio.spectrum     → log-binned (~32) horizon spectrum polyline
//                        (also drives the city silhouette in city mode)
//   audio.bands.bass   → grid cell glow, sun bloom radius
//   audio.bands.mids   → road dash speed (snare drives the dashes)
//   audio.bands.highs  → star twinkle, spectrum edge sparkle, palm sway
//   audio.bands.total  → sky brightness lift
//   audio.beat.pulse   → grid shockwave (multi-row falloff), sun flash
//
// Pose binding (head + shoulders): poseTilt rotates the reactive
// scene-stack around the horizon centre; poseShiftX shifts the grid
// vanishing-point. Sky/stars/AESTHETIC text stay screen-aligned so
// framing stays legible regardless of body lean.
//
// Idle (no audio): spectrum falls back to a smooth sine; grid scrolls
// at gridSpeed alone; sun breathes at ~0.3 Hz; stars twinkle on their
// own per-star phases.
//
// See `_synthwave.md` next door for the full design spec, palette
// table, and the cross-walk against the external brief.

import { scaleAudio } from '../field.js';
import { lmToCanvas } from '../video.js';

const SPEC_BARS = 32;
const STAR_COUNT = 120;
const ASSUMED_SAMPLE_RATE = 48000;
const HORIZON_FRAC = 0.55;        // horizon at 55% down the canvas
const Z_NEAR = 0.05;              // perspective: bottom of canvas
const Z_FAR  = 1.0;               // approach (but never reach) horizon
const MAX_WAVEFRONTS = 6;

// Palettes — HSL components only; consumers compose `hsla(${...},a)`.
// Slots: skyTop, skyHorizon, sunTop, sunBot, mountain, spectrum, grid.
const PALETTES = {
  classic: {
    skyTop:    '260,80%,8%',
    skyHorizon:'320,75%,18%',
    sunTop:    '45,100%,60%',
    sunBot:    '15,100%,55%',
    mountain:  '260,40%,30%',
    spectrum:  '320,90%,60%',
    grid:      '190,90%,55%',
  },
  miami: {
    skyTop:    '285,85%,10%',
    skyHorizon:'330,80%,20%',
    sunTop:    '330,95%,65%',
    sunBot:    '300,95%,55%',
    mountain:  '270,40%,28%',
    spectrum:  '330,95%,62%',
    grid:      '185,90%,55%',
  },
  vapor: {
    skyTop:    '260,60%,12%',
    skyHorizon:'280,55%,22%',
    sunTop:    '330,80%,75%',
    sunBot:    '260,75%,55%',
    mountain:  '260,30%,40%',
    spectrum:  '190,85%,68%',
    grid:      '285,75%,55%',
  },
  void: {
    skyTop:    '250,90%,4%',
    skyHorizon:'260,80%,10%',
    sunTop:    '15,100%,55%',
    sunBot:    '330,90%,50%',
    mountain:  '250,30%,20%',
    spectrum:  '190,95%,60%',
    grid:      '190,85%,55%',
  },
};

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'synthwave',
  name: 'Synthwave',
  contextType: 'canvas2d',

  params: [
    { id: 'mode', label: 'mode', type: 'select',
      options: ['horizon', 'road', 'city', 'dreamscape'], default: 'horizon' },
    { id: 'palette', label: 'palette', type: 'select',
      options: ['classic', 'miami', 'vapor', 'void'], default: 'classic' },
    { id: 'gridDensity', label: 'grid density', type: 'range', min: 6, max: 32, step: 1, default: 16 },
    // Grid speed — base scrolls forward at the slider rate, audio.total
    // adds a surge. Modulator amount is non-zero (modulator math zeroes
    // out at amount=0 regardless of user weight, which made the pill
    // appear dead). Drag the pill weight to 0 in the UI to disable.
    { id: 'gridSpeed', label: 'grid speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total', mode: 'mul', amount: 0.40 },
      ] },
    // Sun size — pure manual slider. No audio modulation, no idle
    // breath: changes only when the user drags it. Bloom (below) is
    // where the audio reactivity for the sun lives.
    { id: 'sunSize',   label: 'sun size',   type: 'range', min: 0.15, max: 0.55, step: 0.01, default: 0.32 },
    // Sun bloom — outer halo intensity. Bass + beat-pulse drive it.
    { id: 'sunBloom',  label: 'sun bloom',  type: 'range', min: 0,    max: 1.5,  step: 0.02, default: 0.45,
      modulators: [
        { source: 'audio.bass',      mode: 'add', amount: 0.30 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.50 },
      ] },
    // EQ depth — second spectrum line drawn behind the front one. Now
    // controls BOTH alpha (saturates at 1) and back-layer height (max
    // ~2.0× front), so dragging past 1 makes the back ridge tower over
    // the front for a chunkier mountain silhouette.
    { id: 'eqDepth',   label: 'eq depth',   type: 'range', min: 0,    max: 4,    step: 0.05, default: 1.0 },
    { id: 'fog',      label: 'fog',         type: 'range', min: 0,    max: 1,    step: 0.02, default: 0.55 },
    { id: 'poseInfluence', label: 'pose influence', type: 'range', min: 0, max: 1, step: 0.02, default: 0.5 },
    // Palm sway — dreamscape only. Max bumped to 4 so dragging up gives
    // genuinely wild fronds during loud passages.
    { id: 'palmSway',  label: 'palm sway',  type: 'range', min: 0,    max: 4,    step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.highs',     mode: 'add', amount: 1.50 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.40 },
      ] },
    { id: 'stars',     label: 'stars',     type: 'toggle', default: true },
    { id: 'sunStripes',label: 'sun stripes',type: 'toggle', default: true },
    { id: 'sunCore',   label: 'sun core',  type: 'toggle', default: false },
    { id: 'aesthetic', label: 'aesthetic', type: 'toggle', default: false },
    { id: 'reactivity',label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { mode: 'horizon' },
      { mode: 'road' },
      { mode: 'city' },
      { mode: 'dreamscape' },
    ],
  },

  presets: {
    default:      { mode: 'horizon',    palette: 'classic' },
    horizon:      { mode: 'horizon' },
    miami:        { mode: 'horizon',    palette: 'miami' },
    voidstar:     { mode: 'horizon',    palette: 'void',  sunCore: true },
    road:         { mode: 'road',       palette: 'classic' },
    'road-night': { mode: 'road',       palette: 'miami', stars: true },
    city:         { mode: 'city',       palette: 'miami' },
    vapor:        { mode: 'dreamscape', palette: 'vapor', aesthetic: true },
    dreamy:       { mode: 'dreamscape', palette: 'vapor', gridSpeed: 0.2, aesthetic: true },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const startMs = performance.now();

    // ── Stars (lazy-init; see drawStars) ──────────────────────────────
    let stars = null;
    function ensureStars() {
      if (stars && stars.length === STAR_COUNT) return;
      stars = new Array(STAR_COUNT);
      for (let i = 0; i < STAR_COUNT; i++) {
        stars[i] = {
          x: Math.random(),
          y: Math.random() * 0.55,            // upper-half only
          base: 0.25 + Math.random() * 0.6,
          phase: Math.random() * Math.PI * 2,
          rate: 0.6 + Math.random() * 1.6,    // twinkle frequency
          size: Math.random() < 0.85 ? 1 : 2, // ~15% are 2px
        };
      }
    }

    // ── Spectrum log-bins (recomputed when buffer length changes) ─────
    let logBinIdx = null;
    let logBinFor = -1;
    function buildLogBins(freqLen) {
      if (freqLen === logBinFor && logBinIdx) return;
      const fftSize = freqLen * 2;
      const hz = ASSUMED_SAMPLE_RATE / fftSize;
      const minF = 30, maxF = 14000;
      const last = freqLen - 1;
      logBinIdx = new Int32Array(SPEC_BARS + 1);
      for (let i = 0; i <= SPEC_BARS; i++) {
        const f = minF * Math.pow(maxF / minF, i / SPEC_BARS);
        logBinIdx[i] = Math.max(1, Math.min(last, Math.round(f / hz)));
      }
      logBinFor = freqLen;
    }
    function sampleBar(freqBuf, i) {
      if (!logBinIdx) return 0;
      const lo = logBinIdx[i], hi = Math.max(lo + 1, logBinIdx[i + 1]);
      let m = 0;
      for (let k = lo; k < hi; k++) if (freqBuf[k] > m) m = freqBuf[k];
      return m / 255;
    }

    // ── Slow-smoothed spectrum copy (back EQ "mountain" layer) ────────
    // Same source as the front spectrum, but EMA'd over ~600ms so the
    // back ridge has visible "mass" — peaks settle slowly instead of
    // tracking the front in lockstep. Distinct visual character →
    // perspective parallax without inventing a second audio source.
    const slowSpec = new Float32Array(SPEC_BARS);
    let slowSpecPrimed = false;

    // ── Grid scroll state ─────────────────────────────────────────────
    // We integrate `dt * smoothedGridSpeed` each frame and feed
    // `scrollIntegral % 1` to the renderer. Two things this fixes:
    //
    //   (1) Bounce-back: the previous form `(tSec * gridSpeed) % 1`
    //       only stays monotonic if gridSpeed is constant. Once
    //       `params.gridSpeed` varies (audio.total modulator on), the
    //       product can decrease frame-to-frame and scrollPhase jumps
    //       backward — visible as the grid lurching left/right or
    //       forward/back. Integrating dt-steps is monotonic regardless.
    //
    //   (2) Bursty audio: the modulator gets us a per-frame speed, but
    //       audio.total has a fast EMA in audio.js — so loud bursts
    //       still spike the speed sharply. We add a slower EMA on the
    //       resolved speed (~250 ms half-life) so the grid surges feel
    //       like swells, not stutters. Drag the modulator amount lower
    //       in the UI for less surge, or to 0 for steady forward.
    let scrollIntegral = 0;
    let gridSpeedSmoothed = 1.0;

    // ── Grid wavefronts (kick shockwaves) ─────────────────────────────
    // Each wavefront has a normalised z position (1.0 = horizon, 0.0 =
    // near plane) and a decaying intensity. Lit rows are picked at
    // render time relative to z.
    /** @type {{z:number, intensity:number}[]} */
    const wavefronts = [];
    let prevBeatActive = false;

    // ── City reflection buffer (lazy) ─────────────────────────────────
    let cityBuf = null, cityBufCtx = null;
    function ensureCityBuf() {
      if (!cityBuf) {
        cityBuf = document.createElement('canvas');
        cityBufCtx = cityBuf.getContext('2d');
      }
      if (cityBuf.width !== W || cityBuf.height !== H) {
        cityBuf.width = W; cityBuf.height = H;
      }
    }

    // ── Helpers ───────────────────────────────────────────────────────
    function getPalette(name) {
      return PALETTES[name] || PALETTES.classic;
    }

    // Project a world-z (0..1, 1=horizon) to a screen-y between
    // horizonY and bottom of canvas.
    function projectZ(z, horizonY) {
      // Lines bunch toward the horizon. zEff in (0,1].
      const zEff = Math.max(Z_NEAR, Math.min(Z_FAR, z));
      const t = 1 / (1 + zEff * 8);     // perspective curl
      // t ranges roughly from 1/(1+8*Z_NEAR)=~0.71 down to 1/(1+8)=0.111.
      // Map t∈[0.111, 0.71] linearly to screen y∈[horizonY+1, H].
      const tNear = 1 / (1 + Z_NEAR * 8);
      const tFar  = 1 / (1 + Z_FAR  * 8);
      const u = (t - tFar) / (tNear - tFar);   // 0 at horizon, 1 near
      return horizonY + (H - horizonY) * u;
    }

    // ── Drawing primitives ────────────────────────────────────────────
    function drawSky(pal, audio) {
      const lift = 1 + audio.bands.total * 0.25;
      const grad = ctx.createLinearGradient(0, 0, 0, H * HORIZON_FRAC);
      grad.addColorStop(0, `hsla(${pal.skyTop},${0.95 * lift})`);
      grad.addColorStop(1, `hsla(${pal.skyHorizon},${0.92 * lift})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H * HORIZON_FRAC);
      // Below the horizon — deep, neutral floor backdrop. Most of this
      // gets painted over by the grid, but the corners need to read as
      // dark instead of leaking the previous frame.
      ctx.fillStyle = 'rgba(5,5,13,0.95)';
      ctx.fillRect(0, H * HORIZON_FRAC, W, H * (1 - HORIZON_FRAC));
    }

    // Atmospheric haze — tight horizontal band right at the horizon.
    // Now narrow (~6% H tall) and more concentrated so the bloom from
    // the sun doesn't wash it out. Sells the "soft glow where grid
    // meets sky" feel without competing with the sun.
    function drawFog(pal, params, audio) {
      const fog = params.fog;
      if (fog <= 0.001) return;
      const horizonY = H * HORIZON_FRAC;
      // Tight band: 4% H minimum, +2% per fog unit, capped 8%.
      const bandH = Math.min(H * 0.08, H * 0.04 + H * 0.04 * fog);
      // Stronger alpha since the band is narrower — peak in the centre
      // of the band (right at horizon) where it reads as a glowing line.
      const a = Math.min(0.95, fog * 1.10 + audio.bands.total * 0.10);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const top = horizonY - bandH * 0.5;
      const grad = ctx.createLinearGradient(0, top, 0, top + bandH);
      grad.addColorStop(0,    `hsla(${pal.skyHorizon},0)`);
      grad.addColorStop(0.5,  `hsla(${pal.skyHorizon},${a})`);
      grad.addColorStop(1,    `hsla(${pal.skyHorizon},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, top, W, bandH);
      ctx.restore();
    }

    function drawStars(pal, audio, tSec) {
      ensureStars();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const horizonY = H * HORIZON_FRAC;
      const trebleBoost = 0.3 + audio.bands.highs * 0.7;
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const tw = 0.5 + 0.5 * Math.sin(tSec * s.rate + s.phase);
        const a  = s.base * tw * trebleBoost;
        if (a < 0.02) continue;
        const x = s.x * W;
        const y = s.y * horizonY;
        ctx.fillStyle = `rgba(255,255,255,${Math.min(1, a)})`;
        ctx.fillRect(x, y, s.size, s.size);
      }
      ctx.restore();
    }

    // Note: separate procedural mountain layer was removed in favour of
    // letting the spectrum line itself act as the mountain silhouette
    // — the EQ ridge IS the mountain. Less code, less jitter, matches
    // the brief's "horizon line is the spectrum" headline.

    // Sample SPEC_BARS log-binned values from the live spectrum (or an
    // idle sine when audio is off). Returned array is reused — caller
    // must consume immediately or copy.
    const _specScratch = new Float32Array(SPEC_BARS + 1);
    function sampleSpec(audio, tSec) {
      const spectrum = audio.spectrum;
      if (spectrum) buildLogBins(spectrum.length);
      for (let i = 0; i <= SPEC_BARS; i++) {
        const idx = Math.min(i, SPEC_BARS - 1);
        _specScratch[i] = spectrum
          ? sampleBar(spectrum, idx)
          : (Math.sin(tSec * 1.1 + i * 0.4) * 0.4 + 0.4);
      }
      return _specScratch;
    }

    // EMA the slow-spec copy each frame. Alpha tuned for ~600ms decay
    // (~half-life), gives a visibly distinct settle from the front
    // ridge without lagging so far behind it loses the music.
    function updateSlowSpec(audio, tSec, dt) {
      const live = sampleSpec(audio, tSec);
      const k = 1 - Math.pow(0.5, dt / 0.6);    // 600ms half-life
      if (!slowSpecPrimed) {
        for (let i = 0; i < SPEC_BARS; i++) slowSpec[i] = live[i];
        slowSpecPrimed = true;
      } else {
        for (let i = 0; i < SPEC_BARS; i++) {
          slowSpec[i] += (live[i] - slowSpec[i]) * k;
        }
      }
    }

    // Draw a single spectrum-as-mountain ridge from a values array. The
    // `style` arg picks between "front" (live, vivid) and "back" (slow,
    // dim — for the parallax depth layer).
    function drawSpectrumLayer(values, pal, audio, scale, style) {
      const horizonY = H * HORIZON_FRAC;
      const peakRange = horizonY * 0.28 * scale;
      const points = new Array(SPEC_BARS + 1);
      for (let i = 0; i <= SPEC_BARS; i++) {
        const v = values[Math.min(i, SPEC_BARS)];
        const x = (i / SPEC_BARS) * W;
        const y = horizonY - v * peakRange;
        points[i] = { x, y };
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      const fillTop  = style === 'back' ? 0.30 : 0.45;
      const beamA    = style === 'back' ? 0.55 : 0.95;
      const bloomA   = style === 'back' ? 0.22 : 0.45;
      const beamW    = style === 'back' ? 1.0  : 1.5 + audio.bands.highs * 1.2;
      const bloomW   = style === 'back' ? 4    : 6   + audio.beat.pulse * 4;

      // Underfill.
      ctx.beginPath();
      ctx.moveTo(0, horizonY);
      for (let i = 0; i <= SPEC_BARS; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.lineTo(W, horizonY);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, horizonY - peakRange, 0, horizonY);
      fill.addColorStop(0, `hsla(${pal.spectrum},${fillTop})`);
      fill.addColorStop(1, `hsla(${pal.spectrum},0)`);
      ctx.fillStyle = fill;
      ctx.fill();

      // Bloom + beam strokes.
      ctx.strokeStyle = `hsla(${pal.spectrum},${bloomA})`;
      ctx.lineWidth = bloomW;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i <= SPEC_BARS; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();

      ctx.strokeStyle = `hsla(${pal.spectrum},${beamA})`;
      ctx.lineWidth = beamW;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i <= SPEC_BARS; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();

      ctx.restore();
    }

    function drawSpectrum(pal, params, audio, tSec, scale = 1.0) {
      // Back layer first — slow-smoothed values. eqDepth (0..4) scales
      // alpha (saturates at 1) AND height (back layer at 0.40× scale at
      // eqDepth=0, climbing to 2.0× scale at eqDepth=4). Past ~1.5 the
      // back ridge towers over the front for a chunky mountain feel.
      const depth = params.eqDepth;
      if (depth > 0.01) {
        const alpha   = Math.min(1, depth);
        const heightF = 0.40 + Math.min(4, depth) * 0.40;       // 0.40..2.00
        const backValues = new Float32Array(SPEC_BARS + 1);
        for (let i = 0; i < SPEC_BARS; i++) backValues[i] = slowSpec[i];
        backValues[SPEC_BARS] = slowSpec[SPEC_BARS - 1] || 0;
        ctx.save();
        ctx.globalAlpha = alpha;
        drawSpectrumLayer(backValues, pal, audio, scale * heightF, 'back');
        ctx.restore();
      }
      // Front layer — live values, full alpha.
      const liveValues = sampleSpec(audio, tSec);
      drawSpectrumLayer(liveValues, pal, audio, scale, 'front');
    }

    function drawSun(pal, params, audio, tSec) {
      const horizonY = H * HORIZON_FRAC;
      // Sun size is purely manual — no breath, no audio. Audio-driven
      // bloom + halo flash happen in their own layers below.
      const r = Math.min(W, H) * params.sunSize;
      const cx = W * 0.5;
      const cy = horizonY;
      // Outer bloom — driven by the `sunBloom` param, which has its own
      // audio.bass + audio.beatPulse modulators (visible in the params
      // panel). Param value is already resolved through the modulator
      // pipeline, so we just clamp + paint.
      const bloomAlpha = Math.max(0, Math.min(1, params.sunBloom));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const bloom = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.2);
      bloom.addColorStop(0, `hsla(${pal.sunTop},${bloomAlpha})`);
      bloom.addColorStop(1, `hsla(${pal.sunTop},0)`);
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // Disc — gradient sun-top → sun-bot, with stripe cutouts in one
      // path. We build the disc circle plus stripe rectangles into a
      // single sub-path collection, then fill with the 'evenodd' rule:
      // pixels covered by both the circle AND a stripe (overlap count
      // = 2) fall outside the path, so they're skipped — leaving holes
      // where the layers behind the disc (sky / stars / sun bloom)
      // show through. That's what the user wants by "cutouts, not
      // black bands".
      //
      // Clipped to upper half so any stripe rect that pokes past the
      // horizon is also chopped at the horizon line.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, cy);
      ctx.clip();

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (params.sunStripes) {
        const stripes = 5;
        for (let i = 0; i < stripes; i++) {
          const tBand = i / (stripes - 1);     // 0 = horizon → 1 = top stripe
          // Cluster tight to the bottom of the visible disc — yFrac
          // 0.50 (horizon) → 0.30 (40% up from horizon), so the upper
          // 60% of the visible disc is uncut.
          const yFrac = 0.50 - tBand * 0.20;
          const yMid  = cy - r + yFrac * (2 * r);
          // Much thinner overall, with the topmost stripes thinner
          // still — gives the slatted-window-blinds look from the
          // synthwave reference frames.
          const thick = (r * 0.045) * (1 - tBand * 0.55);
          ctx.rect(cx - r, yMid - thick / 2, r * 2, thick);
        }
      }
      const disc = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
      disc.addColorStop(0, `hsla(${pal.sunTop},0.95)`);
      disc.addColorStop(1, `hsla(${pal.sunBot},0.95)`);
      ctx.fillStyle = disc;
      ctx.fill('evenodd');

      // Eclipse core — voidstar identity.
      const showCore = params.sunCore || params.palette === 'void';
      if (showCore) {
        const coreR = r * 0.35;
        ctx.fillStyle = 'rgba(5,5,13,0.95)';
        ctx.beginPath();
        ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
        ctx.fill();
        // Halo ring.
        const haloAlpha = 0.55 + audio.beat.pulse * 0.45;
        ctx.strokeStyle = `hsla(${pal.spectrum},${haloAlpha})`;
        ctx.lineWidth = 1.5 + audio.beat.pulse * 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    function updateWavefronts(audio, dt, gridSpeed) {
      // Push a new wavefront on rising-edge of beat.active.
      if (audio.beat.active && !prevBeatActive && wavefronts.length < MAX_WAVEFRONTS) {
        wavefronts.push({ z: Z_FAR, intensity: Math.min(1, audio.beat.pulse + 0.2) });
      }
      prevBeatActive = audio.beat.active;
      // Advance + decay.
      const dz = (1.2 + gridSpeed * 0.4) * dt;
      for (let i = wavefronts.length - 1; i >= 0; i--) {
        const w = wavefronts[i];
        w.z -= dz;
        w.intensity *= Math.pow(0.92, dt * 60);
        if (w.intensity < 0.05 || w.z <= Z_NEAR) {
          wavefronts.splice(i, 1);
        }
      }
    }

    // Main floor grid + wavefront overlay. roadMode shifts vertical
    // line spacing so the centre is darker (the road body) — actual
    // road dashes are painted in drawRoad after the grid.
    // `vpShiftX` shifts the vanishing-point horizontally for pose-driven
    // "look left/right" tracking. 0 = centred.
    function drawGrid(pal, params, audio, tSec, dt, roadMode = false, vpShiftX = 0) {
      const horizonY = H * HORIZON_FRAC;
      const cx = W * 0.5 + vpShiftX;
      const density = params.gridDensity | 0;
      // scrollIntegral is updated in update() and is monotonic — see
      // the state-block comment above. Using it here means audio
      // surges accelerate forward motion smoothly instead of letting
      // gridSpeed swings rewind the modulo math.
      const scrollPhase = scrollIntegral % 1;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      // Horizontal (depth) lines. Direction: each line spawns at the
      // horizon and travels toward the camera over time (down the
      // screen) — that's the "moving forward" feel. Achieved by
      // flipping the z formula so stripe=0 maps to Z_FAR and stripe=1
      // maps to Z_NEAR, while scrollPhase still grows monotonically.
      const baseAlpha = 0.45 + audio.bands.bass * 0.35;
      for (let i = 0; i < density; i++) {
        const stripe = (i + scrollPhase) / density;
        // Inverted: stripe=0 is at the horizon, stripe=1 at near plane.
        // As scrollPhase grows, each line's stripe grows → z decreases
        // → line moves toward the viewer.
        const z = Z_FAR - stripe * stripe * (Z_FAR - Z_NEAR);
        const y = projectZ(z, horizonY);
        // Lines near the horizon (small stripe → large z) are dimmer
        // for atmospheric perspective.
        const depthFade = 0.2 + (1 - z) * 0.9;
        // Wavefront glow contribution: any wavefront within ~0.06 of
        // this z stripe lights it, with falloff for trailing rows.
        let waveBoost = 0;
        for (let k = 0; k < wavefronts.length; k++) {
          const w = wavefronts[k];
          // Position of "leading row" is w.z; trailing rows are
          // *behind* the wavefront (further from camera = larger z).
          const dz = z - w.z;
          if (dz < -0.02) continue;            // ahead of wavefront
          const rowsBehind = Math.max(0, Math.round(dz / (1 / density)));
          if (rowsBehind > 4) continue;
          const falloff = Math.pow(0.5, rowsBehind);
          waveBoost += w.intensity * falloff;
        }
        waveBoost = Math.min(1.5, waveBoost);
        const a = Math.max(0, Math.min(1, baseAlpha * depthFade + waveBoost * 0.55));
        ctx.strokeStyle = waveBoost > 0.05
          ? `hsla(${pal.spectrum},${a})`
          : `hsla(${pal.grid},${a})`;
        ctx.lineWidth = 1 + waveBoost * 1.6;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      // Vertical lines — fan out from the vanishing point. We project
      // a near-end (z=Z_NEAR) and horizon (z=Z_FAR) for each line,
      // then stroke the segment.
      const verts = density * 2;       // twice horizontal lines for a tight floor
      const yNear = projectZ(Z_NEAR, horizonY);
      const yHoriz = horizonY;
      // Near-plane spread is wide; horizon converges.
      for (let i = 0; i <= verts; i++) {
        const u = (i / verts) - 0.5;             // -0.5..+0.5
        const xNear = cx + u * W * 1.6;          // overshoot for off-screen extents
        const xHoriz = cx + u * W * 0.05;        // tight at horizon
        // Skip the centre-ish lines in road mode so the road body
        // reads as a dark strip.
        if (roadMode && Math.abs(u) < 0.07) continue;
        const a = 0.30 + audio.bands.bass * 0.25;
        ctx.strokeStyle = `hsla(${pal.grid},${a})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xNear, yNear);
        ctx.lineTo(xHoriz, yHoriz);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Road overlay (drawn over grid) — broad cyan strip + dashed line.
    function drawRoad(pal, params, audio, tSec, vpShiftX = 0) {
      const horizonY = H * HORIZON_FRAC;
      const cx = W * 0.5 + vpShiftX;
      const yNear = H;
      // Body (dark cyan trapezoid).
      const halfNear = W * 0.18;
      const halfHoriz = W * 0.012;
      ctx.save();
      ctx.fillStyle = 'rgba(8,16,28,0.85)';
      ctx.beginPath();
      ctx.moveTo(cx - halfNear, yNear);
      ctx.lineTo(cx + halfNear, yNear);
      ctx.lineTo(cx + halfHoriz, horizonY);
      ctx.lineTo(cx - halfHoriz, horizonY);
      ctx.closePath();
      ctx.fill();
      // Cyan rim along edges.
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `hsla(${pal.grid},0.55)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - halfNear, yNear); ctx.lineTo(cx - halfHoriz, horizonY);
      ctx.moveTo(cx + halfNear, yNear); ctx.lineTo(cx + halfHoriz, horizonY);
      ctx.stroke();
      // Dashed centre line — locked to grid via the same scroll
      // integral the grid uses. They tick forward together (no audio
      // jitter, no rewind on speed swings).
      const dashPhase = scrollIntegral % 1;
      const dashes = 14;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineCap = 'butt';
      for (let i = 0; i < dashes; i++) {
        const u0 = ((i + dashPhase) / dashes);
        const u1 = u0 + 0.5 / dashes;
        if (u0 >= 1 || u1 <= 0) continue;
        const z0 = Z_NEAR + (1 - Math.min(1, u0)) * (Z_FAR - Z_NEAR);
        const z1 = Z_NEAR + (1 - Math.max(0, u1)) * (Z_FAR - Z_NEAR);
        const y0 = projectZ(z0, horizonY);
        const y1 = projectZ(z1, horizonY);
        const w0 = 4 * (1 - z0 * 0.85);
        ctx.lineWidth = Math.max(1, w0);
        ctx.beginPath();
        ctx.moveTo(cx, y0);
        ctx.lineTo(cx, y1);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawCity(pal, params, audio) {
      const spectrum = audio.spectrum;
      if (spectrum) buildLogBins(spectrum.length);
      const horizonY = H * HORIZON_FRAC;
      const bandH = horizonY * 0.42;
      ensureCityBuf();
      cityBufCtx.clearRect(0, 0, W, H);

      // Build silhouette into the city buffer first so we can flip it
      // for the reflection without re-computing everything.
      const N = SPEC_BARS;
      const slot = W / N;
      // Vary widths slightly per index for non-uniform skyline.
      const widthMul = (i) => 0.55 + ((i * 31) % 7) / 14;   // [0.55, 1.0]
      cityBufCtx.fillStyle = 'rgba(8,12,20,0.95)';
      cityBufCtx.beginPath();
      for (let i = 0; i < N; i++) {
        const v = spectrum
          ? sampleBar(spectrum, i)
          : (Math.sin(performance.now() * 0.0008 + i * 0.4) * 0.4 + 0.4);
        const h = v * bandH;
        const w = slot * widthMul(i);
        const x = i * slot + (slot - w) / 2;
        cityBufCtx.fillRect(x, horizonY - h, w, h);
      }
      // Hot-pink top edge per rectangle.
      cityBufCtx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < N; i++) {
        const v = spectrum
          ? sampleBar(spectrum, i)
          : (Math.sin(performance.now() * 0.0008 + i * 0.4) * 0.4 + 0.4);
        const h = v * bandH;
        if (h < 1) continue;
        const w = slot * widthMul(i);
        const x = i * slot + (slot - w) / 2;
        cityBufCtx.fillStyle = `hsla(${pal.spectrum},0.95)`;
        cityBufCtx.fillRect(x, horizonY - h, w, 2);
      }
      cityBufCtx.globalCompositeOperation = 'source-over';

      // Composite the silhouette onto the main canvas.
      ctx.drawImage(cityBuf, 0, 0);

      // Reflection — vertically flipped, lower alpha, painted onto the
      // top ~30% of the floor depth.
      ctx.save();
      ctx.globalAlpha = 0.30;
      ctx.translate(0, horizonY * 2);
      ctx.scale(1, -1);
      ctx.drawImage(cityBuf, 0, 0, W, horizonY, 0, 0, W, horizonY * 0.6);
      ctx.restore();
    }

    function drawPalms(pal, params, audio, tSec) {
      const horizonY = H * HORIZON_FRAC;
      const palms = [
        { x: W * 0.12, h: H * 0.28, lean: -0.05 },
        { x: W * 0.78, h: H * 0.22, lean:  0.04 },
        { x: W * 0.92, h: H * 0.18, lean: -0.02 },
      ];
      ctx.save();
      ctx.fillStyle = 'rgba(5,5,13,0.95)';
      ctx.strokeStyle = 'rgba(5,5,13,0.95)';
      ctx.lineCap = 'round';
      // Sway — `palmSway` param has audio.highs + audio.beatPulse
      // modulators baked in (see schema). Direct read keeps the audio
      // reactivity discoverable + tunable. Always-on sin gives a wind
      // feel even at silence.
      const sway = (Math.sin(tSec * 0.8) * 0.10 + 0.05) * params.palmSway;
      for (const p of palms) {
        // Trunk — slight curve via two segments.
        const baseX = p.x, baseY = horizonY;
        const topX  = baseX + p.lean * p.h * (1 + sway * 0.2);
        const topY  = baseY - p.h;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(baseX, baseY);
        ctx.quadraticCurveTo(baseX + p.lean * p.h * 0.5, baseY - p.h * 0.5,
                             topX, topY);
        ctx.stroke();
        // Crown — 7 fronds radiating with sway.
        const fronds = 7;
        for (let k = 0; k < fronds; k++) {
          const ang = (-Math.PI / 2) + (k - (fronds - 1) / 2) * 0.32 + sway * 0.25;
          const len = p.h * 0.42;
          const fx = topX + Math.cos(ang) * len;
          const fy = topY + Math.sin(ang) * len;
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(topX, topY);
          ctx.quadraticCurveTo(topX + Math.cos(ang) * len * 0.5,
                               topY + Math.sin(ang) * len * 0.5 + 4,
                               fx, fy);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    function drawAesthetic(pal, _params, audio, tSec, _dt) {
      const text = 'A E S T H E T I C';
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // Fit to canvas: spacing clamped so the whole word fits within
      // 86% of W regardless of viewport. Smaller of (font-size * 1.0,
      // available width / chars) wins.
      const fontSize = Math.max(16, Math.min(H * 0.055, W * 0.08));
      const fitSpacing = (W * 0.86) / text.length;
      const spacing = Math.min(fontSize * 1.0, fitSpacing);
      const total = text.length * spacing;
      ctx.font = `${fontSize}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Subtle horizontal sin-bob (bounded — no wrap) so the word feels
      // alive without ever sliding off-screen.
      const drift = Math.sin(tSec * 0.4) * Math.min(20, W * 0.012);
      const baseY = H * HORIZON_FRAC + H * 0.10;
      const startX = (W - total) / 2 + spacing / 2 + drift;

      // Reactive: per-letter vertical bob (each letter at its own
      // sine phase, plus an audio-driven amplitude); per-letter scale
      // pulse on bass + beat; alpha lifts with total + flashes on beat.
      const baseAlpha = 0.10 + audio.bands.total * 0.18 + audio.beat.pulse * 0.45;
      const bobAmpAudio = (audio.bands.total * H * 0.020) + (audio.beat.pulse * H * 0.018);
      const scaleBoost = 1 + audio.bands.bass * 0.12 + audio.beat.pulse * 0.18;

      for (let i = 0; i < text.length; i++) {
        const x = startX + i * spacing;
        const phaseY = Math.sin(tSec * 2.2 + i * 0.45);
        const yOff = phaseY * (H * 0.010 + bobAmpAudio);
        // Letters near beats also get a tiny color flash to the
        // palette spectrum hue, fading back to white.
        const flash = audio.beat.pulse;
        const alpha = Math.min(1, baseAlpha);
        ctx.save();
        ctx.translate(x, baseY + yOff);
        ctx.scale(scaleBoost, scaleBoost);
        // White underglow for legibility.
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.fillText(text[i], 0, 0);
        // Hue tint on top — lighter blend so it adds, doesn't replace.
        if (flash > 0.05) {
          ctx.fillStyle = `hsla(${pal.spectrum},${flash * 0.8})`;
          ctx.fillText(text[i], 0, 0);
        }
        ctx.restore();
      }
      ctx.restore();
    }

    // Render-time scratch.
    let _params = null, _audio = null, _dt = 0, _tSec = 0;

    // Pose-driven scene transform. Smoothed across frames — pose
    // detection + the user's body both jitter at ~60 Hz, so a small
    // EMA on top of the pose pipeline's own smoothing keeps the scene
    // from twitching. `poseTilt` is the rotation (radians) of the
    // mid-stack around the horizon centre; `poseShiftX` shifts the
    // grid vanishing-point horizontally.
    let poseTilt = 0;
    let poseShiftX = 0;

    function readPoseTargets(field, params) {
      const inf = params.poseInfluence || 0;
      if (inf <= 0.001) return { tilt: 0, shift: 0 };
      const people = field.pose && field.pose.people;
      if (!people || !people.length) return { tilt: 0, shift: 0 };
      const p = people[0];
      if (!p || p.confidence < 0.3) return { tilt: 0, shift: 0 };
      // Pose landmarks come in raw [0,1] coords from the un-rotated /
      // un-mirrored video frame. The user sees a rotated+mirrored
      // preview, so we MUST apply the same transform (lmToCanvas) to
      // the landmarks before deriving an angle — otherwise a rotated
      // camera produces a 90°-off tilt and a mirrored camera flips the
      // sign relative to what the user feels they're doing.
      const sL = p.shoulders.l, sR = p.shoulders.r;
      const head = p.head;
      const [lx, ly] = lmToCanvas(sL.x, sL.y, W, H);
      const [rx, ry] = lmToCanvas(sR.x, sR.y, W, H);
      const dx = rx - lx;
      const dy = ry - ly;
      let angle = Math.atan2(dy, dx);
      // Wrap to [-π/2, π/2] just in case detection inverts.
      if (angle >  Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      // Cap to ±25° at full influence. Sign: with screen-space
      // landmarks, atan2(dy,dx) is positive when the user's right
      // shoulder is *visually lower* than their left. Negate so the
      // scene levels with the body — feels like "the world tilts
      // opposite the body" (intuitive: same direction as a phone
      // rotation lock).
      const tilt = -Math.max(-0.45, Math.min(0.45, angle)) * inf * 0.7;
      // Head-x shift in screen space. Centre = W/2.
      let shift = 0;
      if (head && head.visibility > 0.3) {
        const [hx /* hy */] = lmToCanvas(head.x, head.y, W, H);
        shift = (hx - W / 2) / W * W * 0.15 * inf; // = (hx-W/2) * 0.15 * inf
      }
      return { tilt, shift };
    }

    function update(field) {
      const { params, dt, time } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      _params = params;
      _audio = audio;
      _dt = dt;
      _tSec = time;
      // Smooth resolved gridSpeed (which already includes its declared
      // audio.total modulator) before integrating, so loud audio bursts
      // produce gentle swells instead of frame-by-frame stutter.
      const speedK = 1 - Math.pow(0.5, dt / 0.25);   // ~250ms half-life
      gridSpeedSmoothed += (params.gridSpeed - gridSpeedSmoothed) * speedK;
      scrollIntegral += dt * gridSpeedSmoothed * 0.5;
      updateWavefronts(audio, dt, gridSpeedSmoothed);
      updateSlowSpec(audio, time, dt);
      // Pose smoothing — k≈4*dt critically damps at the noise frequency
      // we expect while still tracking real body movement quickly.
      const { tilt, shift } = readPoseTargets(field, params);
      const poseK = Math.min(1, dt * 4);
      poseTilt   += (tilt  - poseTilt)   * poseK;
      poseShiftX += (shift - poseShiftX) * poseK;
    }

    function render() {
      const params = _params;
      const audio  = _audio;
      if (!params || !audio) return;
      const pal = getPalette(params.palette);
      const mode = params.mode || 'horizon';
      const horizonY = H * HORIZON_FRAC;

      // Sky + stars stay aligned to the screen (pose tilt would make
      // them slosh oddly). The reactive scene-stack rotates around the
      // horizon centre by `poseTilt` and shifts its vanishing-point by
      // `poseShiftX` — that's the "leaning into the music" feel.
      drawSky(pal, audio);
      if (params.stars) drawStars(pal, audio, _tSec);

      const tilted = Math.abs(poseTilt) > 0.0005;
      if (tilted) {
        ctx.save();
        ctx.translate(W / 2, horizonY);
        ctx.rotate(poseTilt);
        ctx.translate(-W / 2, -horizonY);
      }

      if (mode === 'dreamscape') {
        // Dreamscape: sun → spectrum-as-mountain → grid → palms (front).
        // Spectrum drawn small so the foreground palms remain the
        // visual focus.
        drawSun(pal, params, audio, _tSec);
        drawSpectrum(pal, params, audio, _tSec, 0.55);
        drawGrid(pal, params, audio, _tSec, _dt, false, poseShiftX);
        drawPalms(pal, params, audio, _tSec);
      } else if (mode === 'city') {
        // City silhouette is the mountain analog here — no spectrum line.
        drawSun(pal, params, audio, _tSec);
        drawCity(pal, params, audio);
        drawGrid(pal, params, audio, _tSec, _dt, false, poseShiftX);
      } else {
        // horizon + road: sun → spectrum-as-mountain → grid (+ road).
        // The spectrum line, with its underfill gradient, IS the
        // mountain ridge — replaces the previous procedural-noise
        // mountain layer for less jitter and a cleaner read.
        drawSun(pal, params, audio, _tSec);
        drawSpectrum(pal, params, audio, _tSec, mode === 'road' ? 0.55 : 1.0);
        drawGrid(pal, params, audio, _tSec, _dt, mode === 'road', poseShiftX);
        if (mode === 'road') drawRoad(pal, params, audio, _tSec, poseShiftX);
      }

      if (tilted) ctx.restore();

      // Atmospheric haze at the horizon — drawn after the scene-stack
      // so it dims distant grid lines + the lower edge of the spectrum
      // ridge into a soft glow band. Sits below the AESTHETIC text.
      drawFog(pal, params, audio);

      // AESTHETIC overlay sits on top of the rotated scene-stack so it
      // stays readable regardless of pose tilt — same reason topbar UI
      // doesn't tilt with the canvas.
      if (mode === 'dreamscape' && params.aesthetic) {
        drawAesthetic(pal, params, audio, _tSec, _dt);
      }
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        if (cityBuf) { cityBuf.width = W; cityBuf.height = H; }
      },
      update,
      render,
      dispose() { /* GC handles canvases + typed arrays */ },
    };
  },
};
