// Telemetry — Sci-HUD diagnostics visualizer for live performance.
//
// The qualia lab's `diag` card surfaces audio + pose internals as plain
// text for the operator. Telemetry renders the SAME signals as a full-
// screen HUD so the audience can read them as part of the show: SPAN-
// style spectrum (live + slow average + peak hold) with internal dB +
// Hz axes, oscilloscope, bass/mids/highs/RMS meters, beat tick rows,
// per-person bounding boxes, joint reticles with labels, and frame
// stats. Every panel is toggleable so the operator can dial the
// composition mid-set.
//
// Optional layers: `cameraLayer` paints the live mediapipe video as a
// background; `spectrumFullscreen` expands the analyzer to fill the
// canvas (sitting between the camera and the HUD frames). The HUD grid
// has off / radial / square / both styles. Colour comes from a curated
// `palette` select; auto-phase walks five distinct palettes. Setting
// `palette: 'custom'` re-enables the `accentHue` slider.
//
// Data flow follows the standard fx contract — read field once in
// update(), stash into `scratch`, draw from scratch in render(). Beat
// rising-edges feed three ring buffers so the BEATS panel can replay
// the last 5 s of kicks/snares/hats. The spectrum series live in
// pre-allocated Float32Arrays and decay each frame whether or not
// audio is active, so they stay coherent across mic/strudel transitions.

import { scaleAudio } from '../field.js';
import { lmToCanvas, getVideoEl, applyPreviewTransform } from '../video.js';

const ASSUMED_SAMPLE_RATE = 48000;
const BEAT_WINDOW_S = 5.0;
const MAX_BEATS = 256;

// Spectrum analyzer display range (dB). 0 dB = analyser top (byte 255);
// -70 dB = byte 0. The Web Audio default analyser range is -100..-30 dB,
// which maps linearly to byte 0..255 via getByteFrequencyData; we shift
// by +30 so labels read 0..-70 instead of -30..-100 (audience-friendly).
const SPEC_DB_MIN = -70;
const SPEC_DB_MAX = 0;
const SPEC_F_MIN  = 30;
const SPEC_F_MAX  = 14000;

const NAMED_JOINTS = [
  ['head',        'HEAD'   ],
  ['neck',        'NECK'   ],
  ['shoulders.l', 'L-SHLDR'],
  ['shoulders.r', 'R-SHLDR'],
  ['elbows.l',    'L-ELBOW'],
  ['elbows.r',    'R-ELBOW'],
  ['wrists.l',    'L-WRIST'],
  ['wrists.r',    'R-WRIST'],
  ['hips.l',      'L-HIP'  ],
  ['hips.r',      'R-HIP'  ],
  ['knees.l',     'L-KNEE' ],
  ['knees.r',     'R-KNEE' ],
  ['ankles.l',    'L-ANKLE'],
  ['ankles.r',    'R-ANKLE'],
];

const SKELETON_PAIRS = [
  ['head', 'neck'],
  ['neck', 'shoulders.l'], ['neck', 'shoulders.r'],
  ['shoulders.l', 'shoulders.r'],
  ['shoulders.l', 'elbows.l'], ['elbows.l', 'wrists.l'],
  ['shoulders.r', 'elbows.r'], ['elbows.r', 'wrists.r'],
  ['shoulders.l', 'hips.l'], ['shoulders.r', 'hips.r'],
  ['hips.l', 'hips.r'],
  ['hips.l', 'knees.l'], ['knees.l', 'ankles.l'],
  ['hips.r', 'knees.r'], ['knees.r', 'ankles.r'],
];

// Curated palettes. Each entry is { primary, secondary, warning } where
// the value is an [hue, saturation%, lightness%] triple. Alpha is applied
// at draw time via hslaArr(). 'custom' resolves to the accentHue slider.
const PALETTES = {
  blueprint:     { primary: [195, 80, 65], secondary: [  0,  0, 92], warning: [  0, 85, 60] },
  phosphor:      { primary: [120, 70, 55], secondary: [120, 45, 75], warning: [ 50, 90, 65] },
  'amber-crt':   { primary: [ 40, 90, 55], secondary: [ 40, 70, 70], warning: [  0,  0, 92] },
  'night-vision':{ primary: [120, 75, 50], secondary: [120, 50, 78], warning: [  0, 85, 55] },
  magma:         { primary: [320, 80, 60], secondary: [ 40, 90, 60], warning: [  0,  0, 92] },
  tritium:       { primary: [165, 75, 60], secondary: [195, 80, 65], warning: [ 40, 90, 60] },
  arcturus:      { primary: [270, 75, 65], secondary: [195, 80, 65], warning: [320, 80, 60] },
  ice:           { primary: [200, 80, 80], secondary: [  0,  0, 92], warning: [320, 80, 60] },
  solar:         { primary: [ 25, 90, 60], secondary: [ 50, 90, 65], warning: [270, 75, 65] },
  monochrome:    { primary: [  0,  0, 85], secondary: [  0,  0, 55], warning: [  0,  0, 95] },
};

function resolvePalette(name, customHue) {
  if (name === 'custom') {
    return {
      primary:   [customHue,                    80, 65],
      secondary: [(customHue + 165) % 360,      70, 60],
      warning:   [(customHue + 225) % 360,      95, 65],
    };
  }
  return PALETTES[name] || PALETTES.blueprint;
}

function getJoint(person, key) {
  const dot = key.indexOf('.');
  if (dot < 0) return person[key];
  return person[key.slice(0, dot)]?.[key.slice(dot + 1)];
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'telemetry',
  name: 'Telemetry',
  contextType: 'canvas2d',

  params: [
    { id: 'palette',     label: 'palette',      type: 'select',
      options: ['custom','blueprint','phosphor','amber-crt','night-vision',
                'magma','tritium','arcturus','ice','solar','monochrome'],
      default: 'blueprint' },
    { id: 'accentHue',   label: 'accent hue (custom)', type: 'range', min: 0, max: 360, step: 1, default: 195 },

    { id: 'gridStyle',   label: 'grid',         type: 'select',
      options: ['off', 'radial', 'square', 'both'], default: 'radial' },
    { id: 'gridDensity', label: 'grid density', type: 'range',  min: 0, max: 1, step: 0.05, default: 0.55 },
    { id: 'labelDetail', label: 'labels',       type: 'select',
      options: ['minimal', 'standard', 'verbose'], default: 'standard' },

    { id: 'showSkeleton',label: 'skeleton',     type: 'toggle', default: false },
    { id: 'showBoxes',   label: 'bounding box', type: 'toggle', default: true  },

    { id: 'showSpectrum',       label: 'spectrum',            type: 'toggle', default: true  },
    { id: 'spectrumFullscreen', label: 'spectrum fullscreen', type: 'toggle', default: false },
    { id: 'spectrumSeries',     label: 'spectrum series',     type: 'select',
      options: ['live', 'live+avg', 'live+peak', 'full'], default: 'full' },

    { id: 'showScope',   label: 'oscilloscope', type: 'toggle', default: true  },
    { id: 'showMeters',  label: 'band meters',  type: 'toggle', default: true  },
    { id: 'showBeats',   label: 'beat ticks',   type: 'toggle', default: true  },
    { id: 'showStats',   label: 'frame stats',  type: 'toggle', default: true  },

    { id: 'cameraLayer', label: 'camera layer', type: 'toggle', default: false },

    { id: 'reactivity',  label: 'reactivity',   type: 'range',  min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  presets: {
    default: {
      palette: 'blueprint', accentHue: 195,
      gridStyle: 'radial', gridDensity: 0.55,
      labelDetail: 'standard',
      showSkeleton: false, showBoxes: true,
      showSpectrum: true, spectrumFullscreen: false, spectrumSeries: 'full',
      showScope: true, showMeters: true, showBeats: true, showStats: true,
      cameraLayer: false, reactivity: 1.0,
    },
    minimal: {
      palette: 'monochrome', labelDetail: 'minimal',
      gridStyle: 'off', gridDensity: 0.20,
      showStats: false, showBeats: false,
    },
    broadcast: {
      palette: 'blueprint', labelDetail: 'verbose',
      gridStyle: 'square', gridDensity: 0.75,
      showSkeleton: true,
    },
    daw: {
      palette: 'phosphor',
      spectrumFullscreen: true, spectrumSeries: 'full',
      showScope: false, showMeters: false, showBeats: false,
      gridStyle: 'off', labelDetail: 'minimal',
    },
    cinema: {
      palette: 'magma', cameraLayer: true,
      showBoxes: true, showSkeleton: false,
      showSpectrum: false, showScope: false, showMeters: false, showBeats: false,
      showStats: false, gridStyle: 'off',
    },
    'phosphor-crt': {
      palette: 'phosphor', gridStyle: 'square', gridDensity: 0.6,
      labelDetail: 'verbose',
    },
    demo: {
      palette: 'arcturus', labelDetail: 'verbose',
      gridStyle: 'both', gridDensity: 0.55,
      showSkeleton: true, showBoxes: true,
      showSpectrum: true, spectrumSeries: 'full',
      showScope: true, showMeters: true, showBeats: true, showStats: true,
      cameraLayer: true,
    },
  },

  // Auto-phase walks five distinct palettes — the topbar phase button now
  // switches the palette through visually different stops rather than the
  // old label-detail walk (label detail stays user-controlled).
  autoPhase: {
    steps: [
      { palette: 'blueprint' },
      { palette: 'phosphor' },
      { palette: 'amber-crt' },
      { palette: 'magma' },
      { palette: 'night-vision' },
    ],
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // ── Beat ring buffers (kicks / snares / hats), times in seconds ─────────
    const kickT  = new Float32Array(MAX_BEATS);
    const snareT = new Float32Array(MAX_BEATS);
    const hatT   = new Float32Array(MAX_BEATS);
    let kickHead = 0, snareHead = 0, hatHead = 0;
    let prevKick = false, prevSnare = false, prevHat = false;
    let kickCount = 0, snareCount = 0, hatCount = 0;
    function pushBeat(arr, head, t) { arr[head] = t; return (head + 1) % MAX_BEATS; }
    function countWithin(arr, tNow, windowS) {
      let n = 0;
      for (let i = 0; i < MAX_BEATS; i++) {
        if (arr[i] > 0 && tNow - arr[i] <= windowS) n++;
      }
      return n;
    }

    // ── Spectrum series — pre-allocated, sized on first valid spectrum.
    //    slowAvg : EMA of bin amplitude with ~1.5 s half-life
    //    peakHold: max(prev * decay, v) with ~3 s half-life
    //    Both keep updating during silence so the display falls off gracefully.
    let slowAvg  = null;
    let peakHold = null;
    let nBins    = -1;
    function ensureSeries(len) {
      if (len === nBins && slowAvg) return;
      slowAvg  = new Float32Array(len);
      peakHold = new Float32Array(len);
      nBins    = len;
    }

    // ── Per-frame scratch (read in render; never read field in render) ──────
    const scratch = {
      audio: null,
      params: null,
      pose: null,
      time: 0,
      dt: 0,
      fpsEMA: 60,
    };

    function update(field) {
      const params = field.params;
      const audio  = scaleAudio(field.audio, params.reactivity);
      const t = field.time;

      if (audio.beat.active && !prevKick)   { kickHead  = pushBeat(kickT,  kickHead,  t); kickCount++;  }
      if (audio.mids.active  && !prevSnare) { snareHead = pushBeat(snareT, snareHead, t); snareCount++; }
      if (audio.highs.active && !prevHat)   { hatHead   = pushBeat(hatT,   hatHead,   t); hatCount++;   }
      prevKick  = audio.beat.active;
      prevSnare = audio.mids.active;
      prevHat   = audio.highs.active;

      const dt = field.dt > 0 ? field.dt : 0.016;
      const peakDecay = Math.pow(0.5, dt / 3.0);
      const avgAlpha  = 1 - Math.pow(0.5, dt / 1.5);
      const sp = audio.spectrum;
      if (sp && sp.length > 0) {
        if (sp.length !== nBins) ensureSeries(sp.length);
        for (let i = 0; i < sp.length; i++) {
          const v = sp[i];
          slowAvg[i]  += (v - slowAvg[i]) * avgAlpha;
          peakHold[i]  = Math.max(peakHold[i] * peakDecay, v);
        }
      } else if (nBins > 0) {
        for (let i = 0; i < nBins; i++) {
          slowAvg[i]  *= 1 - avgAlpha;
          peakHold[i] *= peakDecay;
        }
      }

      // Use renderDt (the unclamped render interval), not field.dt — field.dt
      // is clamped for motion stability and would floor this readout at ~20fps.
      const rdt  = field.renderDt > 0 ? field.renderDt : field.dt;
      const inst = rdt > 0 ? 1 / rdt : 60;
      scratch.fpsEMA = scratch.fpsEMA + (inst - scratch.fpsEMA) * 0.08;

      scratch.audio  = audio;
      scratch.params = params;
      scratch.pose   = field.pose;
      scratch.time   = t;
      scratch.dt     = field.dt;
    }

    // ── Tiny helpers ────────────────────────────────────────────────────────
    const FONT     = (px) => `${px}px ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`;
    const hslaArr  = (hsl, a) => `hsla(${((hsl[0] % 360) + 360) % 360},${hsl[1]}%,${hsl[2]}%,${a})`;
    const hsla     = (h, s, l, a) => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;
    const fmtTime  = (s) => {
      const sec = Math.max(0, Math.floor(s));
      const m = Math.floor(sec / 60), r = sec % 60;
      return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    };
    const pad2 = (n) => String(n).padStart(2, ' ');

    function bracket(x, y, w, h, color, lw, len) {
      ctx.strokeStyle = color; ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x, y + len);     ctx.lineTo(x, y);             ctx.lineTo(x + len, y);
      ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y);         ctx.lineTo(x + w, y + len);
      ctx.moveTo(x + w, y + h - len); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - len, y + h);
      ctx.moveTo(x + len, y + h); ctx.lineTo(x, y + h);         ctx.lineTo(x, y + h - len);
      ctx.stroke();
    }

    function panel(x, y, w, h, label, accent, secondary) {
      ctx.fillStyle = 'rgba(5,5,13,0.55)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = secondary; ctx.lineWidth = 0.8;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      bracket(x, y, w, h, accent, 1.4, Math.min(14, w * 0.08));
      if (label) {
        ctx.font = FONT(10);
        ctx.textBaseline = 'middle';
        const txt = `· ${label} ·`;
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = '#05050d';
        ctx.fillRect(x + 8 - 2, y - 7, tw + 4, 14);
        ctx.fillStyle = accent;
        ctx.fillText(txt, x + 8, y);
      }
    }

    // ── Camera background layer ─────────────────────────────────────────────
    // Draws the live mediapipe video element as a fullscreen background, with
    // the same rotation+mirror transform as the corner preview. Mirrors
    // fx/camera.js's render path. The CSS `mix-blend-mode: screen` on the qfx
    // canvas means the camera will visually composite against Hydra below —
    // the same look fx/camera.js produces. Returns silently if the video
    // isn't bound or hasn't reported a frame size yet.
    function drawCameraLayer() {
      const video = getVideoEl();
      if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
      const vw = video.videoWidth, vh = video.videoHeight;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      applyPreviewTransform(ctx, W, H);
      // Cover-fit so the long axis fills.
      const sx = W / vw, sy = H / vh;
      const scale = Math.max(sx, sy);
      ctx.drawImage(video, -vw * scale / 2, -vh * scale / 2, vw * scale, vh * scale);
      ctx.restore();
    }

    // ── HUD background grid: dispatched by gridStyle ────────────────────────
    function drawHudGrid(color, density, style) {
      if (style === 'off' || density <= 0.001) return;
      if (style === 'square') drawSquareGrid(color, density);
      else if (style === 'radial') drawRadialGrid(color, density);
      else if (style === 'both') {
        drawSquareGrid(color, density * 0.7);
        drawRadialGrid(color, density);
      }
    }

    function drawRadialGrid(color, density) {
      const cx = W / 2, cy = H / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.5;
      ctx.globalAlpha = 0.25 + density * 0.35;
      ctx.beginPath();
      ctx.moveTo(0, cy); ctx.lineTo(W, cy);
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
      ctx.stroke();
      const maxR = Math.min(W, H) * 0.42;
      const rings = Math.round(2 + density * 4);
      ctx.globalAlpha = 0.20 + density * 0.30;
      for (let i = 1; i <= rings; i++) {
        const r = maxR * (i / rings);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      }
      const r0 = maxR / rings;
      const spokes = 12;
      ctx.globalAlpha = 0.4 + density * 0.4;
      ctx.beginPath();
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2;
        const x1 = cx + Math.cos(a) * (r0 - 4);
        const y1 = cy + Math.sin(a) * (r0 - 4);
        const x2 = cx + Math.cos(a) * (r0 + 4);
        const y2 = cy + Math.sin(a) * (r0 + 4);
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Graph-paper grid: equal-pitch vertical + horizontal lines. Minor lines
    // are dashed; every 5th line is a solid major. Pitch is derived from
    // density so the slider continues to mean "more lines / heavier".
    function drawSquareGrid(color, density) {
      const cells = Math.round(8 + density * 16);            // 8..24 cells across short axis
      const pitch = Math.min(W, H) / cells;
      const cx = W / 2, cy = H / 2;
      ctx.strokeStyle = color;

      // Minor lines (dashed).
      ctx.globalAlpha = 0.18 + density * 0.20;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      for (let x = cx % pitch; x < W; x += pitch) {
        ctx.moveTo(x, 0); ctx.lineTo(x, H);
      }
      for (let y = cy % pitch; y < H; y += pitch) {
        ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Major lines (every 5th from centre, solid).
      ctx.globalAlpha = 0.30 + density * 0.30;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (let i = -Math.ceil(W / (pitch * 5)); i * pitch * 5 + cx <= W; i++) {
        const x = cx + i * pitch * 5;
        if (x < 0 || x > W) continue;
        ctx.moveTo(x, 0); ctx.lineTo(x, H);
      }
      for (let j = -Math.ceil(H / (pitch * 5)); j * pitch * 5 + cy <= H; j++) {
        const y = cy + j * pitch * 5;
        if (y < 0 || y > H) continue;
        ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();

      // Centre cross — slightly brighter than majors.
      ctx.globalAlpha = 0.45 + density * 0.35;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(0, cy); ctx.lineTo(W, cy);
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ── Top stats strip ─────────────────────────────────────────────────────
    function drawTopStrip(x, y, w, h, accent, secondary, audioOn) {
      panel(x, y, w, h, 'TELEMETRY', accent, secondary);
      ctx.font = FONT(11);
      ctx.textBaseline = 'middle';
      const my = y + h / 2;
      const fps = scratch.fpsEMA;
      const ms  = 1000 / Math.max(fps, 1);
      ctx.fillStyle = accent;
      ctx.fillText(`${fps.toFixed(1)} fps`, x + 14, my);
      ctx.fillStyle = secondary;
      ctx.fillText(`${ms.toFixed(1)} ms`, x + 14 + 80, my);
      ctx.fillStyle = accent;
      ctx.fillText(`t=${fmtTime(scratch.time)}`, x + 14 + 80 + 70, my);

      const persons = scratch.pose?.people?.length || 0;
      const kicks  = countWithin(kickT,  scratch.time, BEAT_WINDOW_S);
      const snares = countWithin(snareT, scratch.time, BEAT_WINDOW_S);
      const hats   = countWithin(hatT,   scratch.time, BEAT_WINDOW_S);
      const parts = [
        `persons:${persons}`,
        `K:${pad2(kicks)}`,
        `S:${pad2(snares)}`,
        `H:${pad2(hats)}`,
        audioOn ? 'AUDIO:ON' : 'AUDIO:--',
      ];
      ctx.textAlign = 'right';
      let rx = x + w - 14;
      for (let i = parts.length - 1; i >= 0; i--) {
        const c = (i === 4)
          ? (audioOn ? hsla(120, 70, 60, 0.95) : hsla(0, 0, 60, 0.6))
          : (i >= 1 && i <= 3 ? secondary : accent);
        ctx.fillStyle = c;
        ctx.fillText(parts[i], rx, my);
        rx -= ctx.measureText(parts[i]).width + 18;
      }
      ctx.textAlign = 'left';
    }

    // ── Spectrum panel — DAW/SPAN-style: live + slow average + peak hold,
    //    internal dB grid (left gutter) and Hz grid (bottom gutter). Layout-
    //    aware: caller passes the strip rect or the fullscreen rect.
    function drawSpectrumPanel(x, y, w, h, pal, audio, audioOn, series, fullscreen) {
      const accent       = hslaArr(pal.primary,   0.95);
      const accentMed    = hslaArr(pal.primary,   0.55);
      const secondary    = hslaArr(pal.secondary, 0.70);
      const secondarySft = hslaArr(pal.secondary, 0.35);
      const secondaryFill= hslaArr(pal.secondary, 0.20);
      const warning      = hslaArr(pal.warning,   0.85);

      const title = fullscreen
        ? `SPECTRUM (${SPEC_DB_MIN}..${SPEC_DB_MAX} dB · 30 Hz – 14 kHz · live + avg + peak)`
        : `SPECTRUM (${SPEC_DB_MIN}..${SPEC_DB_MAX} dB · 30 Hz – 14 kHz)`;
      panel(x, y, w, h, title, accent, secondary);

      // Plot rect with gutters.
      const fontSm = FONT(fullscreen ? 11 : 9);
      const gutterL = fullscreen ? 56 : 38;
      const gutterB = fullscreen ? 22 : 16;
      const gutterT = 12;
      const plotX = x + gutterL;
      const plotY = y + gutterT;
      const plotW = Math.max(40, w - gutterL - 8);
      const plotH = Math.max(30, h - gutterT - gutterB);

      // Coordinate helpers.
      const dbSpan = SPEC_DB_MAX - SPEC_DB_MIN;
      const dbToY  = (db) => plotY + (1 - (db - SPEC_DB_MIN) / dbSpan) * plotH;
      const byteToY = (byte) => {
        // byte 255 → 0 dB, byte 0 → -70 dB (linear in dB across the range).
        const u = byte / 255;
        return plotY + (1 - u) * plotH;
      };
      const logSpan = Math.log(SPEC_F_MAX / SPEC_F_MIN);
      const freqToX = (f) => plotX + (Math.log(f / SPEC_F_MIN) / logSpan) * plotW;

      // dB gridlines (every 12 dB) — dashed.
      ctx.strokeStyle = secondarySft;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      for (let db = SPEC_DB_MAX; db >= SPEC_DB_MIN; db -= 12) {
        const yy = dbToY(db);
        ctx.moveTo(plotX, yy); ctx.lineTo(plotX + plotW, yy);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Hz gridlines (50/100/200/500/1k/2k/5k/10k) — dashed.
      const hzMarks = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
      ctx.strokeStyle = secondarySft;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      for (const f of hzMarks) {
        const xx = freqToX(f);
        if (xx < plotX || xx > plotX + plotW) continue;
        ctx.moveTo(xx, plotY); ctx.lineTo(xx, plotY + plotH);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Plot rect outline.
      ctx.strokeStyle = secondarySft; ctx.lineWidth = 0.6;
      ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);

      const sp = audioOn ? audio.spectrum : null;
      const hasSeries = sp && sp.length > 0 && nBins === sp.length;

      if (hasSeries) {
        const hzPerBin = ASSUMED_SAMPLE_RATE / (sp.length * 2);
        const px0 = Math.ceil(plotX);
        const px1 = Math.floor(plotX + plotW);
        const wantAvg  = (series === 'live+avg' || series === 'full');
        const wantPeak = (series === 'live+peak' || series === 'full');

        // 1) Slow-average area fill (drawn first / behind).
        if (wantAvg) {
          ctx.fillStyle = secondaryFill;
          ctx.beginPath();
          ctx.moveTo(px0, plotY + plotH);
          for (let px = px0; px <= px1; px++) {
            const u = (px - plotX) / plotW;
            const f = SPEC_F_MIN * Math.pow(SPEC_F_MAX / SPEC_F_MIN, u);
            const bin = Math.max(0, Math.min(sp.length - 1, Math.round(f / hzPerBin)));
            ctx.lineTo(px, byteToY(slowAvg[bin]));
          }
          ctx.lineTo(px1, plotY + plotH);
          ctx.closePath();
          ctx.fill();
        }

        // 2) Peak-hold dashed line.
        if (wantPeak) {
          ctx.strokeStyle = warning;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          for (let px = px0; px <= px1; px++) {
            const u = (px - plotX) / plotW;
            const f = SPEC_F_MIN * Math.pow(SPEC_F_MAX / SPEC_F_MIN, u);
            const bin = Math.max(0, Math.min(sp.length - 1, Math.round(f / hzPerBin)));
            const yy = byteToY(peakHold[bin]);
            if (px === px0) ctx.moveTo(px, yy); else ctx.lineTo(px, yy);
          }
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // 3) Live trace solid line (front).
        ctx.strokeStyle = accent;
        ctx.lineWidth = fullscreen ? 1.6 : 1.3;
        ctx.beginPath();
        for (let px = px0; px <= px1; px++) {
          const u = (px - plotX) / plotW;
          const f = SPEC_F_MIN * Math.pow(SPEC_F_MAX / SPEC_F_MIN, u);
          const bin = Math.max(0, Math.min(sp.length - 1, Math.round(f / hzPerBin)));
          const yy = byteToY(sp[bin]);
          if (px === px0) ctx.moveTo(px, yy); else ctx.lineTo(px, yy);
        }
        ctx.stroke();
      } else {
        // Idle trace — slow drifting low sine so the panel reads as alive.
        ctx.strokeStyle = accentMed;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const t = scratch.time;
        const px0 = Math.ceil(plotX);
        const px1 = Math.floor(plotX + plotW);
        for (let px = px0; px <= px1; px++) {
          const u = (px - plotX) / plotW;
          const wob = 0.06 + 0.04 * Math.sin(t * 0.8 + u * 8);
          const yy = plotY + plotH * (1 - wob);
          if (px === px0) ctx.moveTo(px, yy); else ctx.lineTo(px, yy);
        }
        ctx.stroke();
      }

      // dB labels (left gutter).
      ctx.font = fontSm;
      ctx.fillStyle = secondary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let db = SPEC_DB_MAX; db >= SPEC_DB_MIN; db -= 12) {
        ctx.fillText(`${db}`, plotX - 4, dbToY(db));
      }
      ctx.fillStyle = secondarySft;
      ctx.fillText('dB', plotX - 4, plotY - 6);

      // Hz labels (bottom gutter).
      ctx.fillStyle = secondary;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const f of hzMarks) {
        const xx = freqToX(f);
        if (xx < plotX - 2 || xx > plotX + plotW + 2) continue;
        const lbl = f >= 1000 ? `${f / 1000}k` : `${f}`;
        ctx.fillText(lbl, xx, plotY + plotH + 3);
      }
      ctx.fillStyle = secondarySft;
      ctx.textAlign = 'left';
      ctx.fillText('Hz', plotX + plotW + 2, plotY + plotH + 3);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    // ── Oscilloscope ────────────────────────────────────────────────────────
    function drawScopePanel(x, y, w, h, accent, secondary, audio, audioOn) {
      panel(x, y, w, h, 'SCOPE', accent, secondary);
      const innerX = x + 8, innerY = y + 8;
      const innerW = w - 16, innerH = h - 16;
      const midY = innerY + innerH / 2;
      ctx.strokeStyle = secondary; ctx.lineWidth = 0.5; ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(innerX, midY); ctx.lineTo(innerX + innerW, midY);
      ctx.moveTo(innerX, midY - innerH * 0.25); ctx.lineTo(innerX + innerW, midY - innerH * 0.25);
      ctx.moveTo(innerX, midY + innerH * 0.25); ctx.lineTo(innerX + innerW, midY + innerH * 0.25);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const wf = audioOn ? audio.waveform : null;
      ctx.strokeStyle = accent; ctx.lineWidth = 1.4;
      ctx.beginPath();
      if (wf) {
        const amp = innerH * 0.42;
        const N = wf.length;
        for (let i = 0; i < N; i += 2) {
          const xx = innerX + (i / (N - 1)) * innerW;
          const v = (wf[i] - 128) / 128;
          const yy = midY + v * amp;
          if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
      } else {
        const amp = innerH * 0.18;
        const t = scratch.time;
        const STEPS = 96;
        for (let i = 0; i <= STEPS; i++) {
          const u = i / STEPS;
          const xx = innerX + u * innerW;
          const yy = midY + Math.sin(u * Math.PI * 4 + t * 1.2) * amp * (0.5 + 0.5 * Math.sin(t * 0.6));
          if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
      }
      ctx.stroke();
    }

    // ── Band meters ─────────────────────────────────────────────────────────
    function drawMetersPanel(x, y, w, h, accent, secondary, warning, audio, audioOn) {
      panel(x, y, w, h, 'BANDS', accent, secondary);
      const innerX = x + 10, innerY = y + 10;
      const innerW = w - 20, innerH = h - 20;
      const rows = [
        ['B', audioOn ? audio.bands.bass  : 0, audio.beat.pulse],
        ['M', audioOn ? audio.bands.mids  : 0, audio.mids.pulse],
        ['H', audioOn ? audio.bands.highs : 0, audio.highs.pulse],
        ['R', audioOn ? audio.rms         : 0, 0],
      ];
      const rowH = innerH / rows.length;
      ctx.font = FONT(10);
      ctx.textBaseline = 'middle';
      for (let i = 0; i < rows.length; i++) {
        const [label, v, pulse] = rows[i];
        const ry = innerY + i * rowH;
        const my = ry + rowH / 2;
        ctx.fillStyle = secondary;
        ctx.fillText(label, innerX, my);
        const barX = innerX + 14;
        const barW = innerW - 14 - 44;
        const barH = Math.max(4, rowH * 0.42);
        const barY = my - barH / 2;
        ctx.strokeStyle = secondary; ctx.lineWidth = 0.6; ctx.globalAlpha = 0.6;
        ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
        ctx.globalAlpha = 1;
        const fillW = Math.max(0, Math.min(1, v)) * (barW - 2);
        ctx.fillStyle = accent;
        ctx.fillRect(barX + 1, barY + 1, fillW, barH - 2);
        if (pulse > 0.05) {
          ctx.fillStyle = warning;
          ctx.globalAlpha = Math.min(0.8, pulse);
          ctx.fillRect(barX + 1, barY + 1, barW - 2, barH - 2);
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = accent;
        ctx.textAlign = 'right';
        ctx.fillText(v.toFixed(2), innerX + innerW, my);
        ctx.textAlign = 'left';
      }
    }

    // ── Beat tick rows (rolling 5 s) ────────────────────────────────────────
    function drawBeatsPanel(x, y, w, h, accent, secondary, warning, secondaryHue) {
      panel(x, y, w, h, `BEATS (${BEAT_WINDOW_S.toFixed(0)}s)`, accent, secondary);
      const innerX = x + 18, innerY = y + 10;
      const innerW = w - 28, innerH = h - 20;
      // Distinct hues for the three rows: warning (kick), shifted secondary (snare),
      // shifted accent (hat). Stays palette-aware.
      const snareCol = `hsla(${(secondaryHue + 30) % 360},85%,65%,0.95)`;
      const hatCol   = `hsla(${(secondaryHue + 60) % 360},80%,70%,0.95)`;
      const rows = [
        ['K', kickT,  warning,   kickCount],
        ['S', snareT, snareCol,  snareCount],
        ['H', hatT,   hatCol,    hatCount],
      ];
      const rowH = innerH / rows.length;
      ctx.font = FONT(10);
      ctx.textBaseline = 'middle';
      const tNow = scratch.time;
      for (let i = 0; i < rows.length; i++) {
        const [label, arr, color, total] = rows[i];
        const ry = innerY + i * rowH;
        const my = ry + rowH / 2;
        ctx.fillStyle = secondary;
        ctx.fillText(label, x + 8, my);
        ctx.strokeStyle = secondary; ctx.lineWidth = 0.5; ctx.globalAlpha = 0.45;
        ctx.beginPath(); ctx.moveTo(innerX, my); ctx.lineTo(innerX + innerW, my); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color; ctx.lineWidth = 1.6;
        for (let k = 0; k < MAX_BEATS; k++) {
          const t = arr[k];
          if (t <= 0) continue;
          const age = tNow - t;
          if (age < 0 || age > BEAT_WINDOW_S) continue;
          const u = 1 - age / BEAT_WINDOW_S;
          const tx = innerX + u * innerW;
          ctx.globalAlpha = 0.25 + 0.75 * u;
          ctx.beginPath();
          ctx.moveTo(tx, my - rowH * 0.32);
          ctx.lineTo(tx, my + rowH * 0.32);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = accent;
        ctx.textAlign = 'right';
        ctx.fillText(`Σ${total}`, innerX + innerW + 6, my);
        ctx.textAlign = 'left';
      }
    }

    // ── Pose overlay: bounding box, joint reticles, labels, optional skel ──
    function drawPoseOverlay(personHueBase, labelDetail, showBoxes, showSkeleton, audio, audioOn) {
      const people = scratch.pose?.people || [];
      if (!people.length) return;
      const beatPulse = audioOn ? audio.beat.pulse : 0;

      ctx.font = FONT(9);
      ctx.textBaseline = 'middle';

      for (let p = 0; p < people.length; p++) {
        const person = people[p];
        const personHue = (personHueBase + p * 67) % 360;
        const pAccent  = hsla(personHue, 80, 65, 0.95);
        const pSoft    = hsla(personHue, 70, 55, 0.50);

        const projected = [];
        for (let i = 0; i < NAMED_JOINTS.length; i++) {
          const [key, label] = NAMED_JOINTS[i];
          const lm = getJoint(person, key);
          if (!lm || lm.visibility < 0.35) continue;
          const [px, py] = lmToCanvas(lm.x, lm.y, W, H);
          projected.push({ key, label, px, py, vis: lm.visibility });
        }
        if (!projected.length) continue;

        if (showBoxes) {
          let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
          for (let i = 0; i < projected.length; i++) {
            const j = projected[i];
            if (j.px < xmin) xmin = j.px;
            if (j.px > xmax) xmax = j.px;
            if (j.py < ymin) ymin = j.py;
            if (j.py > ymax) ymax = j.py;
          }
          const padBx = 18;
          xmin -= padBx; xmax += padBx; ymin -= padBx; ymax += padBx;
          const bw = xmax - xmin, bh = ymax - ymin;
          ctx.strokeStyle = pSoft; ctx.lineWidth = 0.6;
          ctx.strokeRect(xmin + 0.5, ymin + 0.5, bw - 1, bh - 1);
          bracket(xmin, ymin, bw, bh, pAccent, 1.4 + beatPulse * 1.2,
                  Math.min(22, Math.min(bw, bh) * 0.12));
          const tag = `P${p}  conf ${person.confidence.toFixed(2)}`;
          ctx.font = FONT(10);
          const tw = ctx.measureText(tag).width;
          ctx.fillStyle = '#05050d';
          ctx.fillRect(xmin, ymin - 14, tw + 12, 14);
          ctx.fillStyle = pAccent;
          ctx.fillText(tag, xmin + 6, ymin - 7);
          ctx.font = FONT(9);
        }

        if (showSkeleton) {
          ctx.strokeStyle = pSoft; ctx.lineWidth = 1;
          ctx.beginPath();
          for (let i = 0; i < SKELETON_PAIRS.length; i++) {
            const [aKey, bKey] = SKELETON_PAIRS[i];
            const lmA = getJoint(person, aKey), lmB = getJoint(person, bKey);
            if (!lmA || !lmB || lmA.visibility < 0.35 || lmB.visibility < 0.35) continue;
            const [ax, ay] = lmToCanvas(lmA.x, lmA.y, W, H);
            const [bx, by] = lmToCanvas(lmB.x, lmB.y, W, H);
            ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
          }
          ctx.stroke();
        }

        const showLabel = labelDetail !== 'minimal';
        const verbose   = labelDetail === 'verbose';
        const r = 4 + beatPulse * 2;
        for (let i = 0; i < projected.length; i++) {
          const j = projected[i];
          ctx.strokeStyle = pAccent; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(j.px - r - 3, j.py); ctx.lineTo(j.px - 1, j.py);
          ctx.moveTo(j.px + 1, j.py);     ctx.lineTo(j.px + r + 3, j.py);
          ctx.moveTo(j.px, j.py - r - 3); ctx.lineTo(j.px, j.py - 1);
          ctx.moveTo(j.px, j.py + 1);     ctx.lineTo(j.px, j.py + r + 3);
          ctx.stroke();
          ctx.beginPath(); ctx.arc(j.px, j.py, r, 0, Math.PI * 2); ctx.stroke();

          if (showLabel) {
            const txt = verbose
              ? `${j.label}  v${j.vis.toFixed(2)}`
              : j.label;
            const lx = j.px + r + 6;
            const ly = j.py;
            ctx.strokeStyle = pSoft; ctx.lineWidth = 0.6;
            ctx.beginPath(); ctx.moveTo(j.px + r + 1, j.py); ctx.lineTo(lx - 2, ly); ctx.stroke();
            ctx.fillStyle = pAccent;
            ctx.fillText(txt, lx, ly);
          }
        }
      }
    }

    function render() {
      const audio  = scratch.audio;
      const params = scratch.params;
      if (!audio || !params) return;

      // Resolve palette → accent / secondary / warning strings used everywhere.
      const pal = resolvePalette(params.palette || 'blueprint', params.accentHue ?? 195);
      const accent      = hslaArr(pal.primary,   0.95);
      const accentSoft  = hslaArr(pal.primary,   0.30);
      const secondary   = hslaArr(pal.secondary, 0.70);
      const warning     = hslaArr(pal.warning,   0.95);

      const gridDens     = params.gridDensity ?? 0.55;
      const gridStyle    = params.gridStyle  || 'radial';
      const labelDetail  = params.labelDetail || 'standard';
      const audioOn      = !!audio.spectrum || !!audio.waveform;
      const fullscreenFx = !!params.spectrumFullscreen;

      // 1. Background clear (full opacity now that panelOpacity is gone — the
      //    canvas's mix-blend:screen still keeps near-black effectively
      //    transparent over Hydra below).
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(5,5,13,1)';
      ctx.fillRect(0, 0, W, H);

      // 2. Camera background layer (drawn before HUD so everything paints on top).
      if (params.cameraLayer) drawCameraLayer();

      // Use the whole screen — tighter margins and larger spectrum / right
      // column so the HUD fills the canvas instead of floating in a sea of
      // empty real estate on big displays. The centre band stays clear for
      // the pose overlay (boxes / skeleton / joint reticles).
      const padding = Math.max(8, Math.round(Math.min(W, H) * 0.012));
      const topH    = 36;
      const botH    = Math.round(Math.min(300, H * 0.26));
      const rightW  = Math.round(Math.min(480, W * 0.27));

      // 3. Spectrum (fullscreen sits between camera and HUD; strip mode lives
      //    in the bottom band along with the right column above it).
      if (params.showSpectrum) {
        if (fullscreenFx) {
          const sx = padding;
          const sy = padding + (params.showStats ? topH + padding : 0);
          const sw = W - padding * 2;
          const sh = H - sy - padding;
          drawSpectrumPanel(sx, sy, sw, sh, pal, audio, audioOn,
                            params.spectrumSeries || 'full', true);
        } else {
          drawSpectrumPanel(padding, H - botH - padding, W - padding * 2, botH,
                            pal, audio, audioOn,
                            params.spectrumSeries || 'full', false);
        }
      }

      // 4. HUD reticle/grid — suppressed when spectrum fullscreen so the
      //    spectrum's own dB+Hz grid carries the structure.
      if (!fullscreenFx) drawHudGrid(accentSoft, gridDens, gridStyle);

      // 5. Top stats strip + right column + pose overlay (always painted on
      //    top of camera + spectrum).
      if (params.showStats) {
        drawTopStrip(padding, padding, W - padding * 2, topH, accent, secondary, audioOn);
      }

      const colX = W - rightW - padding;
      let   colY = padding + (params.showStats ? topH + padding : 0);
      // When fullscreen spectrum is on the right column overlays the spectrum.
      const remaining = fullscreenFx
        ? H - colY - padding
        : H - colY - (params.showSpectrum ? botH + padding * 2 : padding);
      const visiblePanels = (params.showScope ? 1 : 0) + (params.showMeters ? 1 : 0) + (params.showBeats ? 1 : 0);
      const colGap = padding;
      const colPanelH = visiblePanels > 0
        ? Math.floor((remaining - (visiblePanels - 1) * colGap) / visiblePanels)
        : 0;

      if (params.showScope && colPanelH > 30) {
        drawScopePanel(colX, colY, rightW, colPanelH, accent, secondary, audio, audioOn);
        colY += colPanelH + colGap;
      }
      if (params.showMeters && colPanelH > 30) {
        drawMetersPanel(colX, colY, rightW, colPanelH, accent, secondary, warning, audio, audioOn);
        colY += colPanelH + colGap;
      }
      if (params.showBeats && colPanelH > 30) {
        drawBeatsPanel(colX, colY, rightW, colPanelH, accent, secondary, warning, pal.secondary[0]);
        colY += colPanelH + colGap;
      }

      drawPoseOverlay(pal.primary[0], labelDetail,
                      params.showBoxes, params.showSkeleton, audio, audioOn);
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* typed arrays are GC-managed */ },
    };
  },
};
