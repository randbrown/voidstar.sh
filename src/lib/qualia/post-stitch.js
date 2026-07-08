// Stitch post-process — palette-quantized tile mosaic with beat-driven
// word-pill scatter. The active fx canvas is downsampled to a coarse cell
// grid, every cell snapped to a small fixed palette (cross-stitch /
// tatreez / bead-loom look), and short words from a user-editable list
// are stamped onto the grid as subtitle-chip pills that live a few
// seconds. When pose tracking is live, cells inside the tracked person's
// bounding box subdivide 2×2 so the figure renders finer than the
// background and "emerges from the weave".
//
// Pipeline per frame:
//   1. drawImage(main) into a fine sample buffer at 2 samples per cell
//      (one getImageData at grid resolution — same trick as the ASCII pass)
//   2. coarse cell color = 4-sample average → nearest palette entry;
//      cells are batched into one Path2D per palette index (≤ 8 fills
//      total instead of thousands of fillStyle swaps)
//   3. inside the pose bbox, the 4 fine samples paint as 4 sub-cells
//   4. a cached cross-stitch "×" pattern tile overlays the grid
//   5. word pills: pool-based spawn on beats (plus a slow idle trickle),
//      snapped to the cell grid, drawn over the mosaic
//
// Owned by overlay.js: it holds the config object and calls
// render(postCtx, main, W, H, field) while the 'stitch' option is on.

import { lmToCanvas } from './video.js';
import { readKnobs, onThemeChange } from './theme.js';

// Fixed palettes (RGB triplets). 'theme' is rebuilt from the active theme's
// accent set on theme change so the weave stays in-family on every skin.
const PALETTES = {
  tatreez: [
    [11, 10, 12],     // black wool
    [127, 16, 36],    // deep crimson
    [193, 18, 31],    // red
    [46, 102, 106],   // teal
    [232, 220, 200],  // cream
    [245, 242, 234],  // white linen
  ],
  mono: [
    [8, 8, 12],
    [56, 58, 66],
    [118, 122, 132],
    [186, 190, 198],
    [240, 242, 246],
  ],
};

function buildThemePalette() {
  const { ac } = readKnobs();
  return [
    [7, 7, 14],                 // near page bg
    ac.accent.rgb.slice(),
    ac.cyan.rgb.slice(),
    ac.pink.rgb.slice(),
    ac.amber.rgb.slice(),
    [238, 240, 248],            // near-white
  ];
}

const MAX_PILLS = 48;

export function createStitchPost() {
  let themePalette = buildThemePalette();
  const offTheme = onThemeChange(() => { themePalette = buildThemePalette(); });

  // Fine sample buffer — 2 samples per cell in each axis.
  const sampleCanvas = document.createElement('canvas');
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  // Cached cross-stitch pattern tile (rebuilt when cell size changes).
  let patternCanvas = null, pattern = null, patternCell = 0, patternCtxRef = null;

  // Word-pill pool.
  const pillWord  = new Array(MAX_PILLS).fill('');
  const pillCol   = new Float32Array(MAX_PILLS);   // grid col
  const pillRow   = new Float32Array(MAX_PILLS);   // grid row
  const pillAge   = new Float32Array(MAX_PILLS);
  const pillLife  = new Float32Array(MAX_PILLS);
  const pillStyle = new Uint8Array(MAX_PILLS);     // palette style variant
  let pillCursor = 0;
  for (let i = 0; i < MAX_PILLS; i++) { pillAge[i] = 1; pillLife[i] = 1; }
  let spawnClock = 0;
  let wordsCache = null, wordsCacheSrc = '';

  // Path2D batches are rebuilt per frame (small objects; the rect data
  // lives in native memory, so this stays off the GC hot path).

  function paletteFor(name) {
    if (name === 'theme') return themePalette;
    return PALETTES[name] || PALETTES.tatreez;
  }

  function ensurePattern(cell, alpha) {
    if (pattern && patternCell === cell) return;
    if (!patternCanvas) {
      patternCanvas = document.createElement('canvas');
      patternCtxRef = patternCanvas.getContext('2d');
    }
    patternCanvas.width = patternCanvas.height = Math.max(2, cell);
    const p = patternCtxRef;
    p.clearRect(0, 0, cell, cell);
    const inset = Math.max(1, cell * 0.18);
    p.lineWidth = Math.max(1, cell * 0.10);
    p.lineCap = 'round';
    // Dark "×" strokes + a faint light echo offset up-left: reads as thread
    // over the flat quantized cells without per-cell stroke calls.
    p.strokeStyle = 'rgba(0,0,0,0.55)';
    p.beginPath();
    p.moveTo(inset, inset); p.lineTo(cell - inset, cell - inset);
    p.moveTo(cell - inset, inset); p.lineTo(inset, cell - inset);
    p.stroke();
    p.strokeStyle = 'rgba(255,255,255,0.18)';
    p.beginPath();
    p.moveTo(inset - 1, inset - 1); p.lineTo(cell - inset - 1, cell - inset - 1);
    p.stroke();
    pattern = null; // rebuilt lazily against the destination ctx
    patternCell = cell;
    void alpha;
  }

  function wordsFrom(config) {
    const src = typeof config.words === 'string' ? config.words : '';
    if (wordsCache && wordsCacheSrc === src) return wordsCache;
    const list = src.split(',').map(w => w.trim()).filter(Boolean);
    wordsCache = list.length ? list : ['voidstar'];
    wordsCacheSrc = src;
    return wordsCache;
  }

  function spawnPill(words, cols, rows) {
    const i = pillCursor;
    pillCursor = (pillCursor + 1) % MAX_PILLS;
    pillWord[i]  = words[(Math.random() * words.length) | 0];
    pillCol[i]   = 1 + Math.floor(Math.random() * Math.max(1, cols - 8));
    pillRow[i]   = 1 + Math.floor(Math.random() * Math.max(1, rows - 2));
    pillAge[i]   = 0;
    pillLife[i]  = 2.2 + Math.random() * 1.8;
    pillStyle[i] = (Math.random() * 4) | 0;
  }

  // Pose bbox in canvas px, or null. Uses the named joints so a briefly
  // occluded landmark doesn't collapse the box.
  function poseBBox(field, W, H) {
    const person = field?.pose?.people?.[0];
    if (!person || person.confidence < 0.35) return null;
    const pts = [
      person.head, person.neck,
      person.shoulders.l, person.shoulders.r,
      person.wrists.l, person.wrists.r,
      person.hips.l, person.hips.r,
      person.knees.l, person.knees.r,
      person.ankles.l, person.ankles.r,
    ];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (const lm of pts) {
      if (!lm || lm.visibility < 0.35) continue;
      const [x, y] = lmToCanvas(lm.x, lm.y, W, H);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      n++;
    }
    if (n < 4) return null;
    const mx = (x1 - x0) * 0.18 + 8, my = (y1 - y0) * 0.12 + 8;
    return [x0 - mx, y0 - my * 2.2, x1 + mx, y1 + my]; // extra headroom up top
  }

  function render(ctx, main, W, H, field, config) {
    const cell = Math.max(8, Math.round(config.cellSize));
    const cols = Math.max(8, Math.ceil(W / cell));
    const rows = Math.max(4, Math.ceil(H / cell));
    const fineCols = cols * 2, fineRows = rows * 2;
    const audio = field?.audio;
    const audioOn = !!audio?.spectrum;
    const dt = Math.min(0.05, field?.dt ?? 0.016);

    if (sampleCanvas.width !== fineCols || sampleCanvas.height !== fineRows) {
      sampleCanvas.width = fineCols;
      sampleCanvas.height = fineRows;
    }
    sampleCtx.globalCompositeOperation = 'copy';
    try {
      sampleCtx.drawImage(main, 0, 0, fineCols, fineRows);
    } catch {
      return; // unreadable main canvas — let the viz show through
    }
    const data = sampleCtx.getImageData(0, 0, fineCols, fineRows).data;

    const pal = paletteFor(config.palette);
    const nPal = pal.length;

    // Reused per-frame paths, one per palette entry (coarse + fine share).
    const paths = [];
    for (let i = 0; i < nPal; i++) paths.push(new Path2D());

    // Sparkle: highs promote a few random cells to the brightest entry.
    const sparkle = audioOn ? audio.highs.pulse * 0.05 + audio.beat.pulse * 0.02 : 0.004;
    const brightIdx = nPal - 1;

    const bbox = config.focus > 0.05 ? poseBBox(field, W, H) : null;
    const gap = Math.max(1, Math.round(cell * 0.07));
    const sub = cell / 2;
    const subGap = Math.max(1, gap - 1);

    // Nearest-palette lookup, written flat for the hot loop.
    const quantize = (r, g, b) => {
      let best = 0, bestD = Infinity;
      for (let p = 0; p < nPal; p++) {
        const pe = pal[p];
        const dr = r - pe[0], dg = g - pe[1], db = b - pe[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    };

    for (let r = 0; r < rows; r++) {
      const y = r * cell;
      const fr0 = r * 2, fr1 = fr0 + 1;
      for (let c = 0; c < cols; c++) {
        const x = c * cell;
        const fc0 = c * 2, fc1 = fc0 + 1;
        const i00 = (fr0 * fineCols + fc0) * 4;
        const i01 = (fr0 * fineCols + fc1) * 4;
        const i10 = (fr1 * fineCols + fc0) * 4;
        const i11 = (fr1 * fineCols + fc1) * 4;

        const fine = bbox &&
          x + cell > bbox[0] && x < bbox[2] &&
          y + cell > bbox[1] && y < bbox[3] &&
          Math.random() < config.focus * 2; // dither the focus boundary

        if (fine) {
          // 2×2 sub-cells straight from the fine samples.
          paths[quantize(data[i00], data[i00 + 1], data[i00 + 2])]
            .rect(x, y, sub - subGap, sub - subGap);
          paths[quantize(data[i01], data[i01 + 1], data[i01 + 2])]
            .rect(x + sub, y, sub - subGap, sub - subGap);
          paths[quantize(data[i10], data[i10 + 1], data[i10 + 2])]
            .rect(x, y + sub, sub - subGap, sub - subGap);
          paths[quantize(data[i11], data[i11 + 1], data[i11 + 2])]
            .rect(x + sub, y + sub, sub - subGap, sub - subGap);
        } else {
          const rr = (data[i00] + data[i01] + data[i10] + data[i11]) >> 2;
          const gg = (data[i00 + 1] + data[i01 + 1] + data[i10 + 1] + data[i11 + 1]) >> 2;
          const bb = (data[i00 + 2] + data[i01 + 2] + data[i10 + 2] + data[i11 + 2]) >> 2;
          let idx = quantize(rr, gg, bb);
          if (sparkle > 0 && Math.random() < sparkle) idx = brightIdx;
          paths[idx].rect(x, y, cell - gap, cell - gap);
        }
      }
    }

    // Paint: dark backing (the gaps read as the loom), then one fill per
    // palette entry.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#060509';
    ctx.fillRect(0, 0, W, H);
    for (let p = 0; p < nPal; p++) {
      ctx.fillStyle = `rgb(${pal[p][0]},${pal[p][1]},${pal[p][2]})`;
      ctx.fill(paths[p]);
    }

    // Cross-stitch texture overlay, aligned to the grid.
    if (config.stitch > 0.02) {
      ensurePattern(cell, config.stitch);
      if (!pattern) pattern = ctx.createPattern(patternCanvas, 'repeat');
      ctx.globalAlpha = Math.min(1, config.stitch);
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, cols * cell, rows * cell);
      ctx.globalAlpha = 1;
    }

    // ── Word pills ──────────────────────────────────────────────────────────
    const rate = config.wordRate;
    if (rate > 0.01) {
      const words = wordsFrom(config);
      // Idle trickle + beat bursts. spawnClock accumulates spawn credit.
      spawnClock += dt * rate * (audioOn ? 0.55 : 0.85);
      if (audioOn && audio.beat.active)  spawnClock += rate * (1.2 + audio.bands.bass);
      if (audioOn && audio.highs.active) spawnClock += rate * 0.5;
      while (spawnClock >= 1) { spawnClock -= 1; spawnPill(words, cols, rows); }

      const fontPx = Math.max(9, Math.round(cell * 0.62));
      ctx.font = `600 ${fontPx}px 'JetBrains Mono', ui-monospace, monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let i = 0; i < MAX_PILLS; i++) {
        if (pillAge[i] >= pillLife[i]) continue;
        pillAge[i] += dt;
        const t = pillAge[i] / pillLife[i];
        if (t >= 1) continue;
        // Chunky quantized fade — pills pop in/out in steps, like hard cuts.
        const aRaw = t < 0.12 ? t / 0.12 : t > 0.75 ? (1 - t) / 0.25 : 1;
        const a = Math.min(1, Math.ceil(aRaw * 3) / 3);

        const word = pillWord[i];
        const tw = ctx.measureText(word).width;
        const wCells = Math.max(1, Math.ceil((tw + cell * 0.9) / cell));
        let gx = pillCol[i], gy = pillRow[i];
        if (gx + wCells > cols) gx = Math.max(0, cols - wCells);
        const px = gx * cell, py = gy * cell;
        const pw = wCells * cell - gap, ph = cell - gap;

        ctx.globalAlpha = a * 0.92;
        // Style variants echo the reference: red / dark / teal chips with
        // cream text, plus an inverted light chip with dark text.
        const style = pillStyle[i];
        if (style === 3) {
          ctx.fillStyle = `rgb(${pal[nPal - 1][0]},${pal[nPal - 1][1]},${pal[nPal - 1][2]})`;
          ctx.fillRect(px, py, pw, ph);
          ctx.fillStyle = 'rgba(10,9,12,0.95)';
        } else {
          const bg = pal[Math.min(nPal - 1, style + 1)];
          ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
          ctx.fillRect(px, py, pw, ph);
          ctx.fillStyle = 'rgba(245,242,234,0.95)';
        }
        ctx.fillText(word, px + cell * 0.45, py + ph / 2 + 1);
      }
      ctx.globalAlpha = 1;
    }
  }

  function dispose() {
    offTheme?.();
    sampleCanvas.width = sampleCanvas.height = 0;
    if (patternCanvas) patternCanvas.width = patternCanvas.height = 0;
    pattern = null;
  }

  return { render, dispose };
}
