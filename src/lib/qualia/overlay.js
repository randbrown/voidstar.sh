// Cross-fx overlays: pose skeleton + sparks + aura, beat-driven ripples,
// ASCII post-process. Sits in its own Canvas2D layer above the active fx
// canvas, so any fx (Canvas2D or WebGL2) can be composited with these
// effects without per-fx duplication.
//
// Pose visuals are lifted from spectrum-pose:309–353,485–538,949–1054.
// Ripples are lifted from cymatics:1075–1143. ASCII is from
// cymatics:635–689.
//
// `tick(dt, field)` updates state (advance sparks, decay ripples, fire
// new ones on beats). `render()` paints the overlay. Both should run
// after the active fx's render() so the overlay lands on top.

import { lmToCanvas } from './video.js';

// ─── Pose visuals ───────────────────────────────────────────────────────────

const PERSON_PALETTE = [
  { boneA: 'rgba(139,92,246,0.75)', boneB: 'rgba(34,211,238,0.75)',
    spark: [270, 190], halo: 'rgba(139,92,246,0.20)', joint: 'rgba(139,92,246,0.95)' },
  { boneA: 'rgba(244,114,182,0.75)', boneB: 'rgba(74,222,128,0.75)',
    spark: [330, 130], halo: 'rgba(244,114,182,0.20)', joint: 'rgba(244,114,182,0.95)' },
  { boneA: 'rgba(251,191,36,0.75)',  boneB: 'rgba(139,92,246,0.75)',
    spark: [ 45, 270], halo: 'rgba(251,191,36,0.20)', joint: 'rgba(251,191,36,0.95)' },
  { boneA: 'rgba(74,222,128,0.75)',  boneB: 'rgba(244,114,182,0.75)',
    spark: [130, 330], halo: 'rgba(74,222,128,0.20)', joint: 'rgba(74,222,128,0.95)' },
  { boneA: 'rgba(34,211,238,0.75)',  boneB: 'rgba(251,191,36,0.75)',
    spark: [195,  45], halo: 'rgba(34,211,238,0.20)', joint: 'rgba(34,211,238,0.95)' },
  { boneA: 'rgba(255,255,255,0.75)', boneB: 'rgba(139,92,246,0.75)',
    spark: [  0, 270], halo: 'rgba(255,255,255,0.18)', joint: 'rgba(255,255,255,0.95)' },
];

const LM_WEIGHT = {
  0: 0.6, 1: 0.35, 3: 0.35, 4: 0.35, 6: 0.35,
  11: 1.0, 12: 1.0, 13: 0.9, 14: 0.9, 15: 1.5, 16: 1.5,
  23: 0.8, 24: 0.8, 25: 0.7, 26: 0.7, 27: 0.6, 28: 0.6,
};
const LM_WEIGHT_ENTRIES = Object.entries(LM_WEIGHT).map(([k, w]) => [Number(k), w]);
const LM_WEIGHT_INDICES = LM_WEIGHT_ENTRIES.map(([i]) => i);

// Bass beat → bursts at body core (head + wrists + elbows + shoulders).
const SPARK_EMITTERS       = [0, 15, 16, 13, 14, 11, 12];
// Highs transient → bursts at head + wrists only (extremities).
const SPARK_EMITTERS_HIGHS = [0, 15, 16];

const SKELETON_CONNECTIONS = [
  // Face — outer ── inner ── nose ── inner ── outer  ("-v-" pattern)
  [3, 1], [1, 0], [0, 4], [4, 6],
  // Body
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [27, 31], [29, 31], [28, 30], [28, 32], [30, 32],
];

// Cheap hue-shift on rgba() strings — used to colour-modulate bones with mids.
const _hueCache = new Map();
function shiftHue(rgbaStr, shift) {
  if (shift === 0) return rgbaStr;
  const key = `${rgbaStr}|${shift}`;
  if (_hueCache.has(key)) return _hueCache.get(key);
  const m = rgbaStr.match(/rgba?\(([^)]+)\)/);
  if (!m) return rgbaStr;
  const [r, g, b, a = '1'] = m[1].split(',').map(s => parseFloat(s.trim()));
  const [h, s, l] = rgbToHsl(r, g, b);
  const out = `hsla(${Math.round((h * 360 + shift) % 360)},${Math.round(s * 100)}%,${Math.round(l * 100)}%,${a})`;
  if (_hueCache.size < 512) _hueCache.set(key, out);
  return out;
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h, s, l];
}

export function createOverlay({ getMainCanvas, parent = document.body } = {}) {
  // Overlay canvas — sized to viewport, sits above the fx canvas.
  const canvas = document.createElement('canvas');
  canvas.id = 'qualia-overlay';
  canvas.style.cssText =
    'position:fixed;inset:0;width:100vw;height:100vh;display:block;' +
    'pointer-events:none;z-index:3;';
  parent.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let dprCap = 1.5;
  function applyDpr() {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    canvas.width  = Math.max(1, Math.floor(window.innerWidth  * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    updateAsciiGrid();
  }
  // Initial applyDpr() is deferred to the bottom of createOverlay so that
  // ASCII_* declarations (used by updateAsciiGrid) have been initialized.
  window.addEventListener('resize', applyDpr);
  window.addEventListener('orientationchange', applyDpr);

  // ── Toggleable visuals ────────────────────────────────────────────────────
  const opts = {
    skeleton: true,
    sparks:   true,
    aura:     true,
    ripples:  true,
    ascii:    false,
    mosh:     false,
  };
  // ASCII and data-mosh both fully repaint the overlay before sparks /
  // skeleton land on top, so they're mutually exclusive — enabling one
  // disables the other automatically.
  function setOption(key, val) {
    if (!(key in opts)) return;
    opts[key] = !!val;
    if (key === 'ascii' && opts.ascii) opts.mosh  = false;
    if (key === 'mosh'  && opts.mosh)  opts.ascii = false;
  }
  function getOption(key) { return opts[key]; }

  // Data-mosh tunables. Defaults aim for a pleasant smear with periodic
  // block glitches; the page exposes these as sliders in a mosh-card.
  const moshConfig = {
    intensity:  0.85,   // global scaler — multiplies smear, glitch, split
    blockSize:  32,     // px on a side; controls glitch granularity
    smear:      0.55,   // 0..1 — how much of last frame leaks into this one
    glitchRate: 0.30,   // base rate of block-displacement events per frame
    colorSplit: 4,      // px offset for the cheap RGB split ghosts
  };
  function setMoshConfig(partial) {
    for (const [k, v] of Object.entries(partial || {})) {
      if (k in moshConfig && typeof v === 'number') moshConfig[k] = v;
    }
  }
  function getMoshConfig() { return { ...moshConfig }; }

  // ── Sparks ring buffer ────────────────────────────────────────────────────
  const MAX_SPARKS = 2400;
  const spx   = new Float32Array(MAX_SPARKS);
  const spy   = new Float32Array(MAX_SPARKS);
  const svx   = new Float32Array(MAX_SPARKS);
  const svy   = new Float32Array(MAX_SPARKS);
  const sage  = new Float32Array(MAX_SPARKS);
  const slife = new Float32Array(MAX_SPARKS);
  const shue  = new Float32Array(MAX_SPARKS);
  const ssize = new Float32Array(MAX_SPARKS);
  let sparkCursor = 0;

  function emitSpark(x, y, hue, speed, size, life) {
    const i = sparkCursor;
    sparkCursor = (sparkCursor + 1) % MAX_SPARKS;
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.9);
    spx[i] = x; spy[i] = y;
    svx[i] = Math.cos(a) * s;
    svy[i] = Math.sin(a) * s - speed * 0.25;
    sage[i] = 0; slife[i] = life;
    shue[i] = hue; ssize[i] = size;
  }

  function updateSparks(dt) {
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (sage[i] >= slife[i]) continue;
      sage[i] += dt;
      svx[i] *= 0.965;
      svy[i] = svy[i] * 0.965 + 0.04;
      spx[i] += svx[i];
      spy[i] += svy[i];
    }
  }

  function drawSparks() {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < MAX_SPARKS; i++) {
      const life = slife[i];
      if (sage[i] >= life) continue;
      const t = sage[i] / life;
      const alpha = (1 - t) * 0.9;
      const r = ssize[i] * (1 - t * 0.6);
      ctx.fillStyle = `hsla(${shue[i]},90%,${60 + t * 20}%,${alpha})`;
      ctx.beginPath(); ctx.arc(spx[i], spy[i], r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // Continuous emission accumulators (key per person+joint for highs sparks).
  const emitAccum = new Map();

  function emitFromJoints(field) {
    if (!opts.sparks) return;
    const audio = field.audio;
    const W = canvas.width, H = canvas.height;
    const audioOn = !!audio.spectrum;
    if (!audioOn) return;

    // Bass beat — body core burst.
    if (audio.beat.active) {
      for (let p = 0; p < field.pose.people.length; p++) {
        const pal = PERSON_PALETTE[p % PERSON_PALETTE.length];
        const [hueA, hueB] = pal.spark;
        const lms = field.pose.people[p].raw;
        for (const idx of SPARK_EMITTERS) {
          const lm = lms[idx];
          if (!lm || lm.visibility < 0.4) continue;
          const [x, y] = lmToCanvas(lm.x, lm.y, W, H);
          const burst = 4 + Math.floor(audio.bands.bass * 10);
          for (let k = 0; k < burst; k++) {
            const hue = (Math.random() < 0.5 ? hueA : hueB) + (Math.random() - 0.5) * 30;
            emitSpark(x, y, hue, 4 + audio.bands.bass * 5, 1.4 + Math.random() * 1.5, 0.7 + Math.random() * 0.9);
          }
        }
      }
    }
    // Highs transient — head + wrists.
    if (audio.highs.active) {
      for (let p = 0; p < field.pose.people.length; p++) {
        const pal = PERSON_PALETTE[p % PERSON_PALETTE.length];
        const [hueA, hueB] = pal.spark;
        const lms = field.pose.people[p].raw;
        for (const idx of SPARK_EMITTERS_HIGHS) {
          const lm = lms[idx];
          if (!lm || lm.visibility < 0.35) continue;
          const [x, y] = lmToCanvas(lm.x, lm.y, W, H);
          const burst = 3 + Math.floor(audio.bands.highs * 10) + Math.floor(audio.highs.pulse * 2);
          for (let k = 0; k < burst; k++) {
            const hue = (Math.random() < 0.5 ? hueA : hueB) + 30 + (Math.random() - 0.5) * 50;
            emitSpark(x, y, hue,
              2.5 + audio.bands.highs * 4 + audio.highs.pulse * 1.2,
              1.1 + Math.random() * 1.2,
              0.55 + Math.random() * 0.7);
          }
        }
      }
    }
    // Continuous highs-driven sparks from wrists (main) + head (lighter).
    const rate = audio.bands.highs * 170;
    if (rate > 0.5) {
      const perSec = rate * field.dt;
      const CONT_EMIT = [[15, 1.0], [16, 1.0], [0, 0.35]];
      for (let p = 0; p < field.pose.people.length; p++) {
        const pal = PERSON_PALETTE[p % PERSON_PALETTE.length];
        const [hueA, hueB] = pal.spark;
        const lms = field.pose.people[p].raw;
        for (const [idx, w] of CONT_EMIT) {
          const lm = lms[idx];
          if (!lm || lm.visibility < 0.4) continue;
          const key = `${p}-h-${idx}`;
          const acc = (emitAccum.get(key) || 0) + perSec * w;
          const n = Math.floor(acc);
          emitAccum.set(key, acc - n);
          if (n <= 0) continue;
          const [x, y] = lmToCanvas(lm.x, lm.y, W, H);
          for (let k = 0; k < n; k++) {
            const hue = (Math.random() < 0.5 ? hueA : hueB) + (Math.random() - 0.5) * 40;
            emitSpark(x, y, hue,
              2.0 + audio.bands.highs * 3.5,
              1.1 + Math.random() * 1.3,
              0.7 + Math.random() * 0.9);
          }
        }
      }
    }
  }

  function drawPoseOverlay(field) {
    if (!opts.skeleton && !opts.aura) return;
    const people = field.pose.people;
    if (!people.length) return;
    const W = canvas.width, H = canvas.height;
    const audio = field.audio;
    const audioOn = !!audio.spectrum;
    const lmPos = lm => lmToCanvas(lm.x, lm.y, W, H);

    ctx.save();
    people.forEach((person, pIdx) => {
      const pal  = PERSON_PALETTE[pIdx % PERSON_PALETTE.length];
      const lms  = person.raw;

      // Aura — soft halo around centroid, scaled by bass.
      if (opts.aura && audioOn) {
        let cx = 0, cy = 0, n = 0;
        for (let k = 0; k < LM_WEIGHT_INDICES.length; k++) {
          const lm = lms[LM_WEIGHT_INDICES[k]];
          if (!lm || lm.visibility < 0.35) continue;
          const [x, y] = lmPos(lm);
          cx += x; cy += y; n++;
        }
        if (n > 0) {
          cx /= n; cy /= n;
          const r = 80 + audio.bands.total * 220 + audio.beat.pulse * 80;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          const baseAlpha = 0.12 + audio.bands.bass * 0.35 + audio.beat.pulse * 0.18;
          g.addColorStop(0, pal.halo.replace(/[\d.]+\)$/, `${baseAlpha})`));
          g.addColorStop(1, pal.halo.replace(/[\d.]+\)$/, '0)'));
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        }
      }

      if (!opts.skeleton) return;

      ctx.globalCompositeOperation = 'source-over';

      // Bones.
      const thick = 1.6 + audio.bands.mids * 4 + audio.beat.pulse * 2;
      ctx.lineWidth = thick; ctx.lineCap = 'round';
      for (const [a, b] of SKELETON_CONNECTIONS) {
        const lmA = lms[a], lmB = lms[b];
        if (!lmA || !lmB || lmA.visibility < 0.35 || lmB.visibility < 0.35) continue;
        const [ax, ay] = lmPos(lmA);
        const [bx, by] = lmPos(lmB);
        const grad = ctx.createLinearGradient(ax, ay, bx, by);
        const shift = audioOn ? Math.floor(audio.bands.mids * 40 + audio.beat.pulse * 30) : 0;
        grad.addColorStop(0, shiftHue(pal.boneA, shift));
        grad.addColorStop(1, shiftHue(pal.boneB, shift));
        ctx.strokeStyle = grad;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }

      // Joints.
      const pulse = 1 + audio.bands.bass * 1.6 + audio.beat.pulse * 0.8;
      for (let k = 0; k < LM_WEIGHT_ENTRIES.length; k++) {
        const idx    = LM_WEIGHT_ENTRIES[k][0];
        const weight = LM_WEIGHT_ENTRIES[k][1];
        const lm     = lms[idx];
        if (!lm || lm.visibility < 0.35) continue;
        const [x, y] = lmPos(lm);
        const r = (2 + weight * 2) * pulse;
        ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath(); ctx.arc(x, y, r + 5 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = pal.halo; ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = pal.joint; ctx.fill();
      }
    });
    ctx.restore();
  }

  // ── Ripples ───────────────────────────────────────────────────────────────
  const MAX_RIPPLES = 32;
  const rpx   = new Float32Array(MAX_RIPPLES);
  const rpy   = new Float32Array(MAX_RIPPLES);
  const rage  = new Float32Array(MAX_RIPPLES);
  const rlife = new Float32Array(MAX_RIPPLES);
  const rhue  = new Float32Array(MAX_RIPPLES);
  const rstr  = new Float32Array(MAX_RIPPLES);
  let rippleCursor = 0;
  for (let i = 0; i < MAX_RIPPLES; i++) rage[i] = rlife[i] = 1; // exhausted

  function spawnRipple(x, y, hue, strength) {
    const i = rippleCursor;
    rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
    rpx[i] = x; rpy[i] = y;
    rage[i] = 0;
    rlife[i] = 1.6 + Math.random() * 1.0;
    rhue[i] = hue; rstr[i] = strength;
  }
  function tickRipples(dt) {
    for (let i = 0; i < MAX_RIPPLES; i++) {
      if (rage[i] < rlife[i]) rage[i] += dt;
    }
  }
  function fireRippleOnBeat(field) {
    if (!opts.ripples) return;
    const audio = field.audio;
    if (!audio.spectrum) return;
    if (audio.beat.active) {
      const ang = Math.random() * Math.PI * 2;
      const r   = Math.random() * 0.18;
      const x   = 0.5 + r * Math.cos(ang);
      const y   = 0.5 + r * Math.sin(ang);
      spawnRipple(x, y, 270 + audio.bands.bass * 40, 0.7 + audio.bands.bass * 0.6);
    }
    if (audio.highs.active) {
      spawnRipple(Math.random(), Math.random(),
                  330 + audio.bands.highs * 40, 0.35 + audio.bands.highs * 0.4);
    }
  }
  function drawRipples() {
    if (!opts.ripples) return;
    const W = canvas.width, H = canvas.height;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < MAX_RIPPLES; i++) {
      if (rage[i] >= rlife[i]) continue;
      const t = rage[i] / rlife[i];
      const x = rpx[i] * W, y = rpy[i] * H;
      const maxR = Math.min(W, H) * (0.28 + 0.30 * rstr[i]);
      const radius = maxR * t;
      const alpha = (1 - t) * 0.55 * rstr[i];
      ctx.strokeStyle = `hsla(${rhue[i]},85%,65%,${alpha})`;
      ctx.lineWidth = 1 + (1 - t) * 3 * rstr[i];
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
      if (t < 0.6) {
        const r2 = radius * 0.55;
        ctx.strokeStyle = `hsla(${rhue[i]},85%,75%,${alpha * 0.5})`;
        ctx.lineWidth = 1 + (0.6 - t) * 2;
        ctx.beginPath(); ctx.arc(x, y, r2, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── ASCII post-process ───────────────────────────────────────────────────
  // Reads pixels from the active fx canvas (Canvas2D OR WebGL2 — drawImage
  // works for both) into a small offscreen, then blits luminance-mapped
  // characters onto the overlay. When ASCII is on, the overlay paints an
  // opaque background first to fully cover the viz beneath.
  const ASCII_RAMP    = ' .,:-=+*#%@';
  const ASCII_CELL_PX = 14;
  let asciiCols = 0, asciiRows = 0;
  let asciiSrc = null, asciiSrcCtx = null;

  function updateAsciiGrid() {
    const W = canvas.width, H = canvas.height;
    asciiCols = Math.max(20, Math.floor(W / (ASCII_CELL_PX * 0.6)));
    asciiRows = Math.max(10, Math.floor(H / ASCII_CELL_PX));
    if (!asciiSrc) {
      asciiSrc = document.createElement('canvas');
      asciiSrcCtx = asciiSrc.getContext('2d', { willReadFrequently: true });
    }
    asciiSrc.width  = asciiCols;
    asciiSrc.height = asciiRows;
  }

  function renderAscii() {
    const main = getMainCanvas?.();
    if (!main) return;
    const W = canvas.width, H = canvas.height;
    if (asciiSrc.width !== asciiCols || asciiSrc.height !== asciiRows) updateAsciiGrid();
    asciiSrcCtx.globalCompositeOperation = 'copy';
    try {
      asciiSrcCtx.drawImage(main, 0, 0, asciiCols, asciiRows);
    } catch {
      // Some WebGL contexts may need preserveDrawingBuffer; if we can't read
      // back, just bail and let the viz show through.
      return;
    }
    const data = asciiSrcCtx.getImageData(0, 0, asciiCols, asciiRows).data;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#05050d';
    ctx.fillRect(0, 0, W, H);

    const cellW    = W / asciiCols;
    const cellH    = H / asciiRows;
    const fontSize = Math.min(cellH * 1.02, cellW / 0.55);
    ctx.font         = `${fontSize}px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    ctx.fillStyle    = 'rgba(122,230,170,0.92)';

    const N = ASCII_RAMP.length - 1;
    const gamma = 0.85;
    for (let r = 0; r < asciiRows; r++) {
      let row = '';
      for (let c = 0; c < asciiCols; c++) {
        const i   = (r * asciiCols + c) * 4;
        const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        const ramp = Math.pow(lum, gamma);
        let idx = (ramp * (N + 1)) | 0;
        if (idx > N) idx = N;
        row += ASCII_RAMP[idx];
      }
      ctx.fillText(row, 0, r * cellH);
    }
  }

  // ── Data-mosh post-process ───────────────────────────────────────────────
  // Persistent offscreen buffer that the active fx canvas is "smeared" into
  // each frame. The look comes from three layered tricks:
  //   1. Self-feedback at a sub-pixel drift — pixels leak forward into the
  //      next frame in a slowly-rotating direction (motion-vector residue).
  //   2. Block-displacement glitches — every frame we may shuffle a few
  //      blockSize×blockSize tiles around inside the buffer; on beats the
  //      count spikes for a full P-frame-style breakup.
  //   3. Cheap RGB split — additive blits of the same buffer at ±X px to
  //      fake chromatic-aberration ghosting cheaply (no per-channel passes).
  let moshBuf = null, moshCtx = null;
  function ensureMoshBuf() {
    const W = canvas.width, H = canvas.height;
    if (!moshBuf) {
      moshBuf = document.createElement('canvas');
      moshCtx = moshBuf.getContext('2d');
    }
    if (moshBuf.width !== W || moshBuf.height !== H) {
      moshBuf.width  = W;
      moshBuf.height = H;
    }
  }
  function renderMosh(field) {
    const main = getMainCanvas?.();
    if (!main) return;
    const W = canvas.width, H = canvas.height;
    ensureMoshBuf();
    const audio = field.audio;
    const audioOn = !!audio.spectrum;
    const k = moshConfig.intensity;

    // 1. Smear-feedback: copy moshBuf onto itself with a tiny drift, faded.
    //    The drift direction rotates slowly (sin/cos of time) so the smear
    //    has a sense of motion rather than just pumping symmetrically.
    const t   = performance.now() * 0.0008;
    const driftMag = 1 + Math.floor(k * 2.5);
    const dx  = Math.round(Math.sin(t) * driftMag);
    const dy  = Math.round(Math.cos(t * 0.9) * driftMag);
    const smearAmt = Math.min(0.95, moshConfig.smear * k * (0.7 + (audioOn ? audio.bands.bass * 0.3 : 0.15)));
    moshCtx.globalAlpha = smearAmt;
    moshCtx.globalCompositeOperation = 'source-over';
    moshCtx.drawImage(moshBuf, dx, dy);

    // 2. Stamp the new fx frame on top with reduced opacity so the smear
    //    survives. Source dimensions fall back to canvas dims because the
    //    main backing-buffer may be a different size from the overlay's.
    const stampAlpha = 1 - smearAmt * 0.55;
    moshCtx.globalAlpha = stampAlpha;
    try {
      moshCtx.drawImage(main, 0, 0, W, H);
    } catch {
      // Some WebGL contexts may need preserveDrawingBuffer; if we can't
      // sample, just show the smeared buffer alone.
    }

    // 3. Block-displacement glitches. Beat-driven burst on top of the
    //    base rate so kicks make the canvas pop apart for a frame.
    let burst = moshConfig.glitchRate * k * 6;
    if (audioOn && audio.beat.active) burst += moshConfig.glitchRate * k * 24;
    if (audioOn && audio.mids.active) burst += moshConfig.glitchRate * k * 8;
    const numBlocks = Math.floor(burst);
    if (numBlocks > 0) {
      const bs = Math.max(4, Math.round(moshConfig.blockSize));
      const maxOff = bs * (2 + k * 3);
      moshCtx.globalAlpha = 1;
      for (let i = 0; i < numBlocks; i++) {
        const sx = Math.floor(Math.random() * Math.max(1, W - bs));
        const sy = Math.floor(Math.random() * Math.max(1, H - bs));
        const dxBlk = Math.max(0, Math.min(W - bs, sx + ((Math.random() - 0.5) * maxOff) | 0));
        const dyBlk = Math.max(0, Math.min(H - bs, sy + ((Math.random() - 0.5) * maxOff) | 0));
        moshCtx.drawImage(moshBuf, sx, sy, bs, bs, dxBlk, dyBlk, bs, bs);
      }
    }

    // 4. Blit the moshed buffer to the overlay (background pass).
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(moshBuf, 0, 0);

    // 5. RGB-split ghosts via additive offset blits. Audio modulates the
    //    split distance so beats widen the chromatic aberration.
    if (moshConfig.colorSplit > 0.5) {
      const cs = moshConfig.colorSplit * k;
      const splitWiden = audioOn ? audio.beat.pulse * cs * 1.2 : 0;
      const off = Math.round(cs + splitWiden);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.30;
      ctx.drawImage(moshBuf,  off, 0);
      ctx.drawImage(moshBuf, -off, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  function tick(dt, field) {
    fireRippleOnBeat(field);
    tickRipples(dt);
    emitFromJoints(field);
    updateSparks(dt);
  }

  function render(field) {
    const W = canvas.width, H = canvas.height;
    if (opts.mosh) {
      // Data-mosh and ASCII both fully repaint the overlay; the setOption
      // mutex guarantees only one is on at a time.
      renderMosh(field);
    } else if (opts.ascii) {
      // ASCII fully covers the viz — render it first, then overlays land
      // ON TOP of the ASCII text (skeleton + sparks should still be visible).
      renderAscii();
    } else {
      ctx.clearRect(0, 0, W, H);
    }
    drawPoseOverlay(field);
    drawSparks();
    drawRipples();
  }

  function dispose() {
    canvas.remove();
    window.removeEventListener('resize', applyDpr);
    window.removeEventListener('orientationchange', applyDpr);
  }

  // Now that all ASCII constants/functions are declared, do the first sizing.
  applyDpr();

  return {
    canvas,
    tick,
    render,
    setOption,
    getOption,
    setMoshConfig,
    getMoshConfig,
    setDprCap(v) { dprCap = Math.max(0.5, v); applyDpr(); },
    dispose,
  };
}
