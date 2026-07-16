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
import { readKnobs, onThemeChange } from './theme.js';
import { createMoshPost } from './post-mosh.js';
import { createStitchPost } from './post-stitch.js';
import {
  EMMONS_COLORS, SHOBUD_RED, SHOBUD_INK, SUITS, SPR, SHAPE_R,
  bakeAtomSprite, bakeSuitSprite,
} from './icon-sprites.js';

// ─── Pose visuals ───────────────────────────────────────────────────────────

// Built from the theme's curated accent set so skeletons stay in-family on
// every skin; under voidstar this reproduces the original hardcoded colors.
// The last entry pairs neutral white with the accent (works on every theme).
let K = readKnobs();

function buildPersonPalette() {
  const { ac } = K;
  const mk = (a, b) => ({
    boneA: a.rgba(0.75), boneB: b.rgba(0.75),
    spark: [Math.round(a.hue), Math.round(b.hue)],
    halo: a.rgba(0.20), joint: a.rgba(0.95),
  });
  const white = { hue: 0, rgba: (al) => `rgba(255,255,255,${al})` };
  return [
    mk(ac.accent, ac.cyan),
    mk(ac.pink,   ac.green),
    mk(ac.amber,  ac.accent),
    mk(ac.green,  ac.pink),
    mk(ac.cyan,   ac.amber),
    { boneA: white.rgba(0.75), boneB: ac.accent.rgba(0.75),
      spark: [0, Math.round(ac.accent.hue)],
      halo: white.rgba(0.18), joint: white.rgba(0.95) },
  ];
}
let PERSON_PALETTE = buildPersonPalette();
onThemeChange(() => { K = readKnobs(); PERSON_PALETTE = buildPersonPalette(); });

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

export function createOverlay({ getMainCanvas, getStageRect, parent = document.body } = {}) {
  // Overlay canvas — sits above the fx canvas and tracks the same on-screen
  // box (the "stage"). Normally that's the full viewport; in split-screen
  // mode the page hands us a half-viewport rect via getStageRect so the
  // skeleton / sparks / mosh stay pixel-aligned with the fx panel rather
  // than spilling across the camera half. position/size are set in
  // applyDpr() so a stage change re-lays-out the element too.
  // Post canvas — the ascii/mosh/edge passes render here, UNDER the pose
  // canvas (same z-index, earlier in DOM order). They live on their own
  // canvas so the cam walk can transform glitch output and pose overlays
  // independently (walks vs pinned, see cam-walk.js). display:none while no
  // post is active keeps the extra compositor layer free in the common case.
  const postCanvas = document.createElement('canvas');
  postCanvas.id = 'qualia-overlay-post';
  postCanvas.style.cssText =
    'position:fixed;left:0;top:0;width:100vw;height:100vh;display:none;' +
    'pointer-events:none;z-index:3;';
  parent.appendChild(postCanvas);
  const postCtx = postCanvas.getContext('2d');

  const canvas = document.createElement('canvas');
  canvas.id = 'qualia-overlay';
  canvas.style.cssText =
    'position:fixed;left:0;top:0;width:100vw;height:100vh;display:block;' +
    'pointer-events:none;z-index:3;';
  parent.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let dprCap = 1.5;
  function applyDpr() {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const r = getStageRect?.() ||
      { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    // CSS box first — keeps the overlay glued to the fx panel on screen.
    canvas.style.left   = `${r.left}px`;
    canvas.style.top    = `${r.top}px`;
    canvas.style.width  = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    // Backing buffer matches the stage in device pixels. lmToCanvas (and the
    // mosh/edge/ascii passes that read the main canvas) work in THIS canvas's
    // pixel space, so a stage-sized buffer keeps everything registered.
    canvas.width  = Math.max(1, Math.floor(r.width  * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
    // Post canvas tracks the same box + buffer so the two stay registered.
    postCanvas.style.left   = canvas.style.left;
    postCanvas.style.top    = canvas.style.top;
    postCanvas.style.width  = canvas.style.width;
    postCanvas.style.height = canvas.style.height;
    postCanvas.width  = canvas.width;
    postCanvas.height = canvas.height;
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
    edge:     false,
    stitch:   false,
    negative: false,
  };
  // ASCII / data-mosh / edge-detect / stitch / negative each fully repaint the
  // overlay before sparks + skeleton land on top, so they're mutually
  // exclusive — enabling one disables the others automatically.
  const POST_KEYS = ['ascii', 'mosh', 'edge', 'stitch', 'negative'];
  function setOption(key, val) {
    if (!(key in opts)) return;
    opts[key] = !!val;
    if (POST_KEYS.includes(key) && opts[key]) {
      for (const k of POST_KEYS) if (k !== key) opts[k] = false;
    }
  }
  function getOption(key) { return opts[key]; }

  // ── Spark style — dots (classic) or inlay-icon sprites ────────────────────
  // 'emmons' / 'shobud' swap the arc()-dot renderer for the shared inlay
  // sprites (icon-sprites.js), so the atoms/suits ride on top of ANY active
  // quale via this overlay. Sprites are baked lazily on first use; the
  // emission tuning below (fewer, bigger, longer-lived) lives in
  // emitFromJoints so the pool + renderer stay allocation-free.
  const SPARK_STYLES = ['dots', 'emmons', 'shobud'];
  let sparkStyle = 'dots';
  let iconSprites = null;   // { emmons: canvas[4], shobud: canvas[4] }
  function ensureIconSprites() {
    if (iconSprites) return;
    iconSprites = {
      // Atoms bake WITH electrons — sparks spin the whole sprite instead of
      // animating electrons live (that's the Iconism quale's job).
      emmons: EMMONS_COLORS.map(c => bakeAtomSprite(c, true)),
      // Classic red hearts/diamonds + white clubs/spades: black ink would
      // vanish over dark quales, and the overlay sits above everything.
      shobud: SUITS.map(s => bakeSuitSprite(
        s, s === 'heart' || s === 'diamond' ? SHOBUD_RED : SHOBUD_INK.white, false)),
    };
  }
  function setSparkStyle(style) {
    if (!SPARK_STYLES.includes(style)) return;
    sparkStyle = style;
    if (style !== 'dots') ensureIconSprites();
  }
  function getSparkStyle() { return sparkStyle; }

  // Data-mosh tunables. The pass itself lives in post-mosh.js (WebGL2
  // motion-vector melt); the page exposes these as sliders in a mosh-card.
  const moshConfig = {
    intensity:  0.85,   // global scaler — multiplies melt, glitch, split
    blockSize:  32,     // macroblock size, display px
    smear:      0.55,   // 0..1 — melt: how hard motion drags stale pixels
    glitchRate: 0.30,   // beat-burst block teleports (P-frame confetti)
    colorSplit: 4,      // px offset for the RGB split ghosts
    heal:       0.30,   // 0..1 — how fast still regions re-resolve
    cycle:      8,      // seconds between auto I-frame refreshes (0 = never)
    colorful:   0.65,   // rainbow residue in hard-dragged regions
  };
  function setMoshConfig(partial) {
    for (const [k, v] of Object.entries(partial || {})) {
      if (k in moshConfig && typeof v === 'number') moshConfig[k] = v;
    }
  }
  function getMoshConfig() { return { ...moshConfig }; }

  // Stitch tunables — quantized tile mosaic + word pills (post-stitch.js).
  // palette/words are strings, everything else numeric.
  const stitchConfig = {
    cellSize: 22,          // cell size, device px
    palette:  'tatreez',   // 'tatreez' | 'theme' | 'mono'
    stitch:   0.35,        // cross-stitch "×" texture amount
    focus:    0.6,         // pose-bbox cell subdivision amount
    wordRate: 0.8,         // word-pill spawn rate scaler (0 = off)
    words: "what it's like, qualia, voidstar, entangle, signal, noise, bloom, static, ghost, no input",
  };
  function setStitchConfig(partial) {
    for (const [k, v] of Object.entries(partial || {})) {
      if (!(k in stitchConfig)) continue;
      const wantString = k === 'palette' || k === 'words';
      if (wantString ? typeof v === 'string' : typeof v === 'number') stitchConfig[k] = v;
    }
  }
  function getStitchConfig() { return { ...stitchConfig }; }

  // Edge-detect post-process tunables. The look is white edges on black —
  // a Sobel filter on the active fx canvas's luminance. `intensity` scales
  // the gradient → output brightness ramp, `threshold` clips dark edges
  // below it, `glow` adds an additive blurred copy, `thickness` widens
  // edges by stamping the buffer at small offsets.
  const edgeConfig = {
    intensity: 1.20,
    threshold: 0.05,
    thickness: 0.40,
    glow:      0.45,
  };
  function setEdgeConfig(partial) {
    for (const [k, v] of Object.entries(partial || {})) {
      if (k in edgeConfig && typeof v === 'number') edgeConfig[k] = v;
    }
  }
  function getEdgeConfig() { return { ...edgeConfig }; }

  // Negative post — a live "lightbox negative" of the whole scene: the frame
  // is inverted so bright marks on dark become dark marks on a soft light
  // field (invert flips lightness; hue-rotate 180 brings hues back, so colours
  // read true rather than complementary). Works on any theme — the post canvas
  // fully replaces the view like the other posts. A light field is laid down
  // first so any transparent regions of the fx canvas read as the lightbox
  // surface instead of letting the raw scene bleed through.
  const NEGATIVE_FIELD = '#e9ebee';
  function renderNegative() {
    const ctx = postCtx;
    const main = getMainCanvas?.();
    if (!main) return;
    const W = canvas.width, H = canvas.height;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = NEGATIVE_FIELD;
    ctx.fillRect(0, 0, W, H);
    ctx.filter = 'invert(1) hue-rotate(180deg)';
    try {
      ctx.drawImage(main, 0, 0, W, H);
    } catch {
      ctx.filter = 'none';
      return;
    }
    ctx.filter = 'none';
  }

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
  // Sprite-style extras: rotation angle, spin rate, icon index (0-3).
  // Zero cost in 'dots' mode — filled at emit, only read by the blit path.
  const sang  = new Float32Array(MAX_SPARKS);
  const sspin = new Float32Array(MAX_SPARKS);
  const sicon = new Uint8Array(MAX_SPARKS);
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
    sang[i] = Math.random() * Math.PI * 2;
    sspin[i] = (0.6 + Math.random() * 1.8) * (Math.random() < 0.5 ? -1 : 1);
    sicon[i] = (Math.random() * 4) | 0;
  }

  function updateSparks(dt) {
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (sage[i] >= slife[i]) continue;
      sage[i] += dt;
      svx[i] *= 0.965;
      svy[i] = svy[i] * 0.965 + 0.04;
      spx[i] += svx[i];
      spy[i] += svy[i];
      sang[i] += sspin[i] * dt;
    }
  }

  function drawSparks() {
    if (sparkStyle !== 'dots' && iconSprites) {
      // Inlay-icon sparks: blit the pre-baked sprite with per-spark
      // rotation + scale. ssize holds the icon radius (set at emit time);
      // source-over keeps the baked palette true instead of additive-washing.
      const sprites = iconSprites[sparkStyle] || iconSprites.emmons;
      for (let i = 0; i < MAX_SPARKS; i++) {
        const life = slife[i];
        if (sage[i] >= life) continue;
        const t = sage[i] / life;
        const r = ssize[i] * (1 - t * 0.25);
        const ds = (r / SHAPE_R) * SPR;
        ctx.globalAlpha = Math.min(t / 0.08, 1) * (1 - t) * 0.95;
        ctx.save();
        ctx.translate(spx[i], spy[i]);
        ctx.rotate(sang[i]);
        ctx.drawImage(sprites[sicon[i]], -ds / 2, -ds / 2, ds, ds);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      return;
    }
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

    // Icon sparks (emmons/shobud): dozens on screen, not thousands — cut
    // counts ~10× (continuous emission harder still), size up to inlay
    // scale, slow the burst velocity, and lengthen life so the shapes read.
    // Dot sparks keep the classic tuning (all multipliers 1).
    const icon = sparkStyle !== 'dots';
    const minDim = Math.min(W, H);
    const nMul = icon ? 0.10 : 1;
    const cMul = icon ? 0.025 : 1;
    const vMul = icon ? 0.55 : 1;
    const lMul = icon ? 1.9 : 1;
    const iconSize = () => minDim * (0.016 + Math.random() * 0.022);
    const probRound = (x) => { const f = Math.floor(x); return f + (Math.random() < x - f ? 1 : 0); };

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
          const burst = probRound((4 + Math.floor(audio.bands.bass * 10)) * nMul);
          for (let k = 0; k < burst; k++) {
            const hue = (Math.random() < 0.5 ? hueA : hueB) + (Math.random() - 0.5) * 30;
            emitSpark(x, y, hue, (4 + audio.bands.bass * 5) * vMul,
              icon ? iconSize() : 1.4 + Math.random() * 1.5,
              (0.7 + Math.random() * 0.9) * lMul);
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
          const burst = probRound(
            (3 + Math.floor(audio.bands.highs * 10) + Math.floor(audio.highs.pulse * 2)) * nMul);
          for (let k = 0; k < burst; k++) {
            const hue = (Math.random() < 0.5 ? hueA : hueB) + 30 + (Math.random() - 0.5) * 50;
            emitSpark(x, y, hue,
              (2.5 + audio.bands.highs * 4 + audio.highs.pulse * 1.2) * vMul,
              icon ? iconSize() : 1.1 + Math.random() * 1.2,
              (0.55 + Math.random() * 0.7) * lMul);
          }
        }
      }
    }
    // Continuous highs-driven sparks from wrists (main) + head (lighter).
    const rate = audio.bands.highs * 170 * cMul;
    if (rate > 0.5 * cMul) {
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
              (2.0 + audio.bands.highs * 3.5) * vMul,
              icon ? iconSize() : 1.1 + Math.random() * 1.3,
              (0.7 + Math.random() * 0.9) * lMul);
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
      spawnRipple(x, y, K.ac.accent.hue + audio.bands.bass * 40, 0.7 + audio.bands.bass * 0.6);
    }
    if (audio.highs.active) {
      spawnRipple(Math.random(), Math.random(),
                  K.ac.pink.hue + audio.bands.highs * 40, 0.35 + audio.bands.highs * 0.4);
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
    // Post passes paint the post canvas (walk-scoped separately from pose).
    const ctx = postCtx;
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
    ctx.fillStyle = K.bg;
    ctx.fillRect(0, 0, W, H);

    const cellW    = W / asciiCols;
    const cellH    = H / asciiRows;
    const fontSize = Math.min(cellH * 1.02, cellW / 0.55);
    ctx.font         = `${fontSize}px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    ctx.fillStyle    = K.color(0.4, { light: 75, alpha: 0.92 });

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
  // WebGL2 motion-vector melt (see post-mosh.js): per-macroblock motion
  // estimation between consecutive fx frames advects a persistent buffer,
  // so movement drags stale pixels around exactly like I-frame-removed
  // video. Created lazily on first use so sessions that never enable mosh
  // pay nothing.
  let moshPost = null;
  function renderMosh(field) {
    const main = getMainCanvas?.();
    if (!main) return;
    if (!moshPost) moshPost = createMoshPost();
    moshPost.render(postCtx, main, canvas.width, canvas.height, field, moshConfig);
  }

  // ── Stitch post-process ──────────────────────────────────────────────────
  // Palette-quantized tile mosaic + word pills (see post-stitch.js).
  let stitchPost = null;
  function renderStitch(field) {
    const main = getMainCanvas?.();
    if (!main) return;
    if (!stitchPost) stitchPost = createStitchPost();
    stitchPost.render(postCtx, main, canvas.width, canvas.height, field, stitchConfig);
  }

  // ── Edge-detect post-process ─────────────────────────────────────────────
  // Sobel on the active fx canvas's luminance. Sampled into a downsampled
  // working buffer (cap at ~1280 wide) so the per-pixel JS loop stays cheap
  // on hi-DPI displays — the small buffer is then upscaled back onto the
  // overlay, which gives the edges a slightly soft TouchDesigner-ish look.
  let edgeBuf = null, edgeCtx = null;
  let edgeOutData = null;
  let edgeWW = 0, edgeWH = 0;
  function ensureEdgeBufs() {
    const W = canvas.width, H = canvas.height;
    const maxW = 1280;
    const scale = Math.min(1, maxW / Math.max(1, W));
    const wW = Math.max(2, Math.round(W * scale));
    const wH = Math.max(2, Math.round(H * scale));
    if (!edgeBuf) {
      edgeBuf = document.createElement('canvas');
      edgeCtx = edgeBuf.getContext('2d', { willReadFrequently: true });
    }
    if (edgeBuf.width !== wW || edgeBuf.height !== wH) {
      edgeBuf.width  = wW;
      edgeBuf.height = wH;
      edgeOutData = edgeCtx.createImageData(wW, wH);
      edgeWW = wW; edgeWH = wH;
      // Alpha is fixed at 255 for every pixel — initialize once, then only
      // RGB channels need to be rewritten per frame.
      const data = edgeOutData.data;
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
    }
  }
  function renderEdge(field) {
    // Post passes paint the post canvas (walk-scoped separately from pose).
    const ctx = postCtx;
    const main = getMainCanvas?.();
    if (!main) return;
    const W = canvas.width, H = canvas.height;
    ensureEdgeBufs();
    const wW = edgeWW, wH = edgeWH;

    edgeCtx.globalCompositeOperation = 'copy';
    try {
      edgeCtx.drawImage(main, 0, 0, wW, wH);
    } catch {
      return;
    }
    const src = edgeCtx.getImageData(0, 0, wW, wH).data;
    const dst = edgeOutData.data;

    const audio = field?.audio;
    const audioOn = !!audio?.spectrum;
    const beatPulse = audioOn ? audio.beat.pulse : 0;
    // Beats lift overall intensity slightly — feels alive without overpowering
    // the user's threshold/intensity settings.
    const k   = edgeConfig.intensity * (1 + beatPulse * 0.45);
    // Sobel L1 magnitude lives in [0, 4*255] = [0, 1020]; threshold is
    // expressed as a fraction of that range so 0..1 reads naturally.
    const thr  = edgeConfig.threshold * 1020;
    const span = Math.max(1, 1020 - thr);
    const gain = (255 / span) * k;

    // Sobel pass — green channel is a cheap luminance proxy and avoids
    // three multiplies per neighbour read.
    for (let y = 1; y < wH - 1; y++) {
      const row0 = (y - 1) * wW;
      const row1 = (y    ) * wW;
      const row2 = (y + 1) * wW;
      for (let x = 1; x < wW - 1; x++) {
        const i00 = (row0 + x - 1) << 2;
        const i01 = (row0 + x    ) << 2;
        const i02 = (row0 + x + 1) << 2;
        const i10 = (row1 + x - 1) << 2;
        const i12 = (row1 + x + 1) << 2;
        const i20 = (row2 + x - 1) << 2;
        const i21 = (row2 + x    ) << 2;
        const i22 = (row2 + x + 1) << 2;
        const l00 = src[i00 + 1];
        const l01 = src[i01 + 1];
        const l02 = src[i02 + 1];
        const l10 = src[i10 + 1];
        const l12 = src[i12 + 1];
        const l20 = src[i20 + 1];
        const l21 = src[i21 + 1];
        const l22 = src[i22 + 1];
        const gx = (l02 + 2 * l12 + l22) - (l00 + 2 * l10 + l20);
        const gy = (l20 + 2 * l21 + l22) - (l00 + 2 * l01 + l02);
        const aGx = gx < 0 ? -gx : gx;
        const aGy = gy < 0 ? -gy : gy;
        let mag = (aGx + aGy - thr) * gain;
        if (mag < 0)        mag = 0;
        else if (mag > 255) mag = 255;
        const v = mag | 0;
        const di = (row1 + x) << 2;
        dst[di] = v; dst[di + 1] = v; dst[di + 2] = v;
      }
    }
    edgeCtx.putImageData(edgeOutData, 0, 0);

    // Black backdrop, then the edge buffer scaled back up to viewport size.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(edgeBuf, 0, 0, W, H);

    // Thickness — additive offset blits widen each edge by the equivalent
    // of `thickness * 2px` in the working buffer (so it scales with screen).
    if (edgeConfig.thickness > 0.01) {
      const t = edgeConfig.thickness;
      const off = Math.max(1, Math.round(t * 2));
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, 0.7 * t);
      ctx.drawImage(edgeBuf,  off, 0, W, H);
      ctx.drawImage(edgeBuf, -off, 0, W, H);
      ctx.drawImage(edgeBuf, 0,  off, W, H);
      ctx.drawImage(edgeBuf, 0, -off, W, H);
    }

    // Glow — additive blurred copy. Beats widen the blur radius so kicks
    // bloom the whole frame.
    if (edgeConfig.glow > 0.01) {
      const g = edgeConfig.glow * (1 + beatPulse * 0.7);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, g * 0.65);
      ctx.filter = `blur(${Math.round(2 + g * 8)}px)`;
      ctx.drawImage(edgeBuf, 0, 0, W, H);
      ctx.filter = 'none';
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  function tick(dt, field) {
    fireRippleOnBeat(field);
    tickRipples(dt);
    emitFromJoints(field);
    updateSparks(dt);
  }

  let postShown = false;
  function render(field) {
    const W = canvas.width, H = canvas.height;
    // Mosh / ASCII / edge each fully repaint the POST canvas (the setOption
    // mutex guarantees only one is on at a time), which sits under the pose
    // canvas so skeleton + sparks still land on top. The post canvas is
    // display:none while no post is active — the extra compositor layer is
    // free in the common case.
    const postActive = opts.mosh || opts.ascii || opts.edge || opts.stitch || opts.negative;
    if (postActive !== postShown) {
      postCanvas.style.display = postActive ? 'block' : 'none';
      postShown = postActive;
    }
    if (opts.mosh)          renderMosh(field);
    else if (opts.ascii)    renderAscii();
    else if (opts.edge)     renderEdge(field);
    else if (opts.stitch)   renderStitch(field);
    else if (opts.negative) renderNegative();

    ctx.clearRect(0, 0, W, H);
    drawPoseOverlay(field);
    drawSparks();
    drawRipples();
  }

  function dispose() {
    canvas.remove();
    postCanvas.remove();
    moshPost?.dispose();   moshPost = null;
    stitchPost?.dispose(); stitchPost = null;
    window.removeEventListener('resize', applyDpr);
    window.removeEventListener('orientationchange', applyDpr);
  }

  // Now that all ASCII constants/functions are declared, do the first sizing.
  applyDpr();

  return {
    canvas,
    postCanvas,
    /** True while an ascii/mosh/edge/stitch/negative pass is rendering (post canvas shown). */
    isPostActive: () => opts.ascii || opts.mosh || opts.edge || opts.stitch || opts.negative,
    tick,
    render,
    setOption,
    getOption,
    setSparkStyle,
    getSparkStyle,
    setMoshConfig,
    getMoshConfig,
    setEdgeConfig,
    getEdgeConfig,
    setStitchConfig,
    getStitchConfig,
    setDprCap(v) { dprCap = Math.max(0.5, v); applyDpr(); },
    // Re-read the stage rect and re-size — called by the page when the
    // split-screen layout changes (the window 'resize' listener handles the
    // viewport-resize case on its own).
    refreshSize: () => applyDpr(),
    dispose,
  };
}
