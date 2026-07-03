// QR rendering — a thin wrapper over the `qrcode` lib (CDN ESM, lazy-loaded),
// styled to the voidstar palette. Used by the Entanglement host modal so the
// audience can scan to join — both the on-screen preview (renderQR) and the
// downloadable / printable performance code (qrToDataURL) — plus the artistic
// voidstar-branded renderer (renderArtisticQR) used by the liner_notes quale
// and the chron QR interjections. Kept tiny + dependency-isolated.

const QRCODE_URL = 'https://esm.sh/qrcode@1.5.4';

let _lib = null;
async function lib() {
  if (!_lib) _lib = (await import(/* @vite-ignore */ QRCODE_URL)).default;
  return _lib;
}

/**
 * Render `text` as a QR code into `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {number} [size]  pixel width/height
 */
export async function renderQR(canvas, text, size = 320) {
  const QR = await lib();
  // Pull the active theme's colors so the QR matches whatever skin is live.
  const cs = getComputedStyle(document.documentElement);
  const dark  = cs.getPropertyValue('--text').trim()    || '#e9e6ff';
  const light = cs.getPropertyValue('--viz-bg').trim()   || '#05050d';
  await QR.toCanvas(canvas, text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark, light },   // --text on --viz-bg (theme-aware)
  });
}

/**
 * Render `text` as a PNG data URL — for downloading or dropping into a printed
 * flyer. Defaults to high-contrast dark-on-white (NOT theme-aware): a near-black
 * code on a white quiet zone is the most reliable thing for a phone camera to
 * scan off paper, regardless of whatever skin is live on screen. Rendered large
 * (1024px) so it stays crisp when scaled up on a printout.
 * @param {string} text
 * @param {number} [size]  pixel width/height of the PNG
 * @param {{dark?:string, light?:string}} [colors]
 * @returns {Promise<string>} a `data:image/png;base64,…` URL
 */
export async function qrToDataURL(text, size = 1024, { dark = '#0a0a1a', light = '#ffffff' } = {}) {
  const QR = await lib();
  return QR.toDataURL(text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark, light },
  });
}

// ── Artistic voidstar QR ─────────────────────────────────────────────────────
// The plain toCanvas/toDataURL renders above are the reliable workhorses.
// Everything below renders the SAME code with an artistic touch: rounded
// "star-dust" modules, finder patterns drawn as portal rings (the voidstar
// eye), and the `void*` wordmark on a chip knocked out of the centre.
//
// Scannability rules baked in (don't loosen these):
//  • errorCorrectionLevel 'H' (30% codeword redundancy) whenever the logo
//    knockout is on — the chip destroys data modules and H absorbs it.
//  • The knockout is capped at ~22% of the code's width (≈5% of its area),
//    well inside H's tolerance, and centred so it never touches the finder
//    or timing patterns.
//  • Module ink stays ≥ ~78% of the cell so adjacent modules read as
//    connected dark regions; per-module hue drift is subtle (never lightens
//    toward the background).

/** Raw module matrix for custom renderers. Returns { size, get(x,y) → 0|1 }. */
export async function qrMatrix(text, errorCorrectionLevel = 'H') {
  const QR = await lib();
  const code = QR.create(text, { errorCorrectionLevel });
  const m = code.modules;
  return { size: m.size, get: (x, y) => (m.get(y, x) ? 1 : 0) };
}

// Deterministic per-module hash → [0,1). Keeps the "dust" variation stable
// frame to frame (the fx re-blits a cached canvas, but a re-render of the
// same URL must not shimmer).
function moduleHash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const inFinder = (x, y, n) =>
  (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);

/**
 * Render `text` as a voidstar-styled QR into `canvas`.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {number} [size]  CSS pixel width/height (canvas backing is 2× for crispness)
 * @param {object} [opts]
 * @param {string}  [opts.dark]    module color   (default: theme --text)
 * @param {string}  [opts.light]   background     (default: theme --viz-bg)
 * @param {string}  [opts.accent]  finder rings + chip border (default: theme --accent)
 * @param {boolean} [opts.logo]    knock out the centre for the void* wordmark (default true)
 * @param {string}  [opts.logoText] wordmark text (default 'void*')
 */
export async function renderArtisticQR(canvas, text, size = 320, opts = {}) {
  const cs = getComputedStyle(document.documentElement);
  const dark   = opts.dark   || cs.getPropertyValue('--text').trim()   || '#e9e6ff';
  const light  = opts.light  || cs.getPropertyValue('--viz-bg').trim() || '#05050d';
  const accent = opts.accent || cs.getPropertyValue('--accent').trim() || '#8b5cf6';
  const logo   = opts.logo !== false;
  const logoText = opts.logoText || 'void*';

  const { size: n, get } = await qrMatrix(text, logo ? 'H' : 'M');

  // 2× backing buffer so the rounded modules stay crisp on hi-DPI screens.
  const px = Math.max(64, Math.round(size)) * 2;
  canvas.width = px; canvas.height = px;
  canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');

  const margin = 3;                          // quiet zone, in modules
  const cell = px / (n + margin * 2);
  const ox = margin * cell, oy = margin * cell;

  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, px);

  // Centre knockout for the wordmark chip — an odd count of whole modules so
  // the chip sits symmetric on the grid. ~22% of the code's width, only for
  // codes big enough that the chip clears the timing patterns (row/col 6).
  let holeLo = -1, holeHi = -1;
  if (logo && n >= 29) {
    let holeN = Math.max(7, Math.round(n * 0.22));
    if (holeN % 2 !== n % 2) holeN += 1;     // keep hole centred on the grid
    holeLo = (n - holeN) >> 1;
    holeHi = holeLo + holeN - 1;
  }
  const inHole = (x, y) => x >= holeLo && x <= holeHi && y >= holeLo && y <= holeHi && holeLo >= 0;

  // ── Data modules — rounded star-dust squares with a subtle deterministic
  // drift between `dark` and a dark/accent blend. One path per color pass.
  // Cells bleed 2% past their bounds so runs of modules CONNECT — decoders
  // (verified against jsQR) lose lock when dot-style modules leave gaps;
  // isolated modules still read as rounded dust via the corner radius.
  const inset = -cell * 0.02;
  const rad   = cell * 0.30;
  const passes = [
    { style: dark, test: (h) => h < 0.72 },
    { style: blendColor(ctx, dark, accent, 0.45), test: (h) => h >= 0.72 },
  ];
  for (const pass of passes) {
    ctx.fillStyle = pass.style;
    ctx.beginPath();
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!get(x, y) || inFinder(x, y, n) || inHole(x, y)) continue;
        if (!pass.test(moduleHash(x, y))) continue;
        roundedRectPath(ctx, ox + x * cell + inset, oy + y * cell + inset,
                        cell - inset * 2, cell - inset * 2, rad);
      }
    }
    ctx.fill();
  }

  // ── Finder patterns as portal rings — outer rounded ring in accent→dark
  // gradient, inner 3×3 as a filled "event horizon" dot. Same footprint as
  // the standard pattern, so scanners lock on normally. The accent is always
  // BLENDED toward the module color: a pure mid-luminance accent lands on
  // the wrong side of a scanner's binarizer on inverted (theme) renders.
  const accentInk = blendColor(ctx, dark, accent, 0.45);
  const finders = [[0, 0], [n - 7, 0], [0, n - 7]];
  for (const [fx, fy] of finders) {
    const X = ox + fx * cell, Y = oy + fy * cell;
    const grad = ctx.createLinearGradient(X, Y, X + 7 * cell, Y + 7 * cell);
    grad.addColorStop(0, accentInk);
    grad.addColorStop(1, dark);
    // Outer 7×7 ring (donut via even-odd fill: outer rounded rect minus 5×5).
    // Corner radii stay modest so the 1:1:3:1:1 finder ratio holds on the
    // scanlines decoders sample.
    ctx.fillStyle = grad;
    ctx.beginPath();
    roundedRectPath(ctx, X, Y, 7 * cell, 7 * cell, cell * 1.4);
    roundedRectPath(ctx, X + cell, Y + cell, 5 * cell, 5 * cell, cell * 1.0);
    ctx.fill('evenodd');
    // Inner 3×3 portal dot.
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.arc(X + 3.5 * cell, Y + 3.5 * cell, cell * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = accentInk;
    ctx.beginPath();
    ctx.arc(X + 3.5 * cell, Y + 3.5 * cell, cell * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── void* wordmark chip in the knockout ────────────────────────────────
  if (holeLo >= 0) {
    const hx = ox + holeLo * cell, hy = oy + holeLo * cell;
    const hw = (holeHi - holeLo + 1) * cell;
    // Chip: background fill + hairline accent border, rounded.
    ctx.fillStyle = light;
    ctx.beginPath();
    roundedRectPath(ctx, hx, hy, hw, hw, cell * 1.2);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1.5, cell * 0.16);
    ctx.beginPath();
    roundedRectPath(ctx, hx + cell * 0.35, hy + cell * 0.35, hw - cell * 0.7, hw - cell * 0.7, cell * 1.0);
    ctx.stroke();
    // Wordmark — same monospace stack the logo quale bakes.
    ctx.fillStyle = dark;
    ctx.font = `700 ${Math.floor(hw * 0.30)}px "JetBrains Mono", "Cascadia Code", "Fira Code", "Menlo", "Consolas", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(logoText, hx + hw / 2, hy + hw / 2 + hw * 0.02);
  }
}

// Blend two CSS colors in a 1×1 scratch — avoids parsing color strings by
// hand (they may be hex, rgb(), or hsl() from the theme). Cached per pair.
const _blendCache = new Map();
function blendColor(ctx, a, b, t) {
  const key = `${a}|${b}|${t}`;
  if (_blendCache.has(key)) return _blendCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const x = c.getContext('2d');
  x.fillStyle = a; x.fillRect(0, 0, 1, 1);
  x.globalAlpha = t;
  x.fillStyle = b; x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  const out = `rgb(${d[0]},${d[1]},${d[2]})`;
  _blendCache.set(key, out);
  return out;
}

/**
 * Artistic QR as an offscreen canvas — for consumers that blit it per-frame
 * (the liner_notes quale) or convert it themselves.
 */
export async function artisticQRCanvas(text, size = 320, opts = {}) {
  const c = document.createElement('canvas');
  await renderArtisticQR(c, text, size, opts);
  return c;
}

/**
 * Artistic QR as a PNG data URL. Defaults to dark-on-white (like qrToDataURL):
 * the print/download path favors the highest-contrast thing a phone camera can
 * scan off paper, but keeps the portal finders + void* chip.
 */
export async function artisticQRToDataURL(text, size = 1024, opts = {}) {
  const c = await artisticQRCanvas(text, size / 2, {
    dark: '#0a0a1a', light: '#ffffff', accent: '#6d28d9', ...opts,
  });
  return c.toDataURL('image/png');
}
