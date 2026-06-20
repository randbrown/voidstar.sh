// Arcade engine — the shared harness every game in the `arcade` quale runs on.
//
// One idea drives the whole thing: games render into a small fixed-resolution
// "cabinet" framebuffer (a few hundred px), and the engine upscales that buffer
// to the live canvas once per frame with smoothing OFF — so a 1080p projector
// shows crisp chunky pixels and the games pay a constant, tiny fill cost no
// matter how big the display is. That's authentic (Outrun/Pac-Man ran ~224p)
// AND it's the single biggest perf win available: we never rasterize a game at
// 1080p, only the final drawImage does.
//
// Games are written against the VIRTUAL dimensions `eng.vw` / `eng.vh` and draw
// through `eng.vctx` (a normal 2D context) plus the helpers below. The engine
// owns: the framebuffer, the upscale, the CRT/scanline/vignette post, a 3×5
// bitmap font for HUDs, screen-shake, and a reusable particle pool factory.
//
// Zero per-frame allocation in the hot path: the framebuffer + post layers are
// lazy and cached; helpers take primitives; particle pools are struct-of-arrays.

// ── Voidstar arcade palette ────────────────────────────────────────────────
// Cosmic-code colours from the brand brief: void bg, cyan/ice, magenta, gold
// accretion, ghost green, plasma orange, white. Games pull from here so the
// four cabinets read as one machine.
export const C = {
  void:    '#05050d',
  void2:   '#0a0f2a',
  cyan:    '#00d4ff',
  ice:     '#66f0ff',
  magenta: '#ff3df0',
  gold:    '#ffcf5c',
  amber:   '#ff9d3c',
  green:   '#5cff9d',
  red:     '#ff4d6a',
  white:   '#f0f6ff',
  dim:     '#3a4668',
};

// ── 3×5 bitmap font ─────────────────────────────────────────────────────────
// Each glyph is 5 rows of a 3-bit mask (bit 0b100 = leftmost column). Tiny on
// purpose — the classic "score font" look, and it upscales to big legible
// blocks. Covers what HUDs need: A–Z, 0–9, space, and a little punctuation.
const FONT = {
  '0':['111','101','101','101','111'], '1':['010','110','010','010','111'],
  '2':['111','001','111','100','111'], '3':['111','001','111','001','111'],
  '4':['101','101','111','001','001'], '5':['111','100','111','001','111'],
  '6':['111','100','111','101','111'], '7':['111','001','010','010','010'],
  '8':['111','101','111','101','111'], '9':['111','101','111','001','111'],
  'A':['111','101','111','101','101'], 'B':['110','101','110','101','110'],
  'C':['111','100','100','100','111'], 'D':['110','101','101','101','110'],
  'E':['111','100','111','100','111'], 'F':['111','100','111','100','100'],
  'G':['011','100','101','101','011'], 'H':['101','101','111','101','101'],
  'I':['111','010','010','010','111'], 'J':['001','001','001','101','111'],
  'K':['101','101','110','101','101'], 'L':['100','100','100','100','111'],
  'M':['101','111','111','101','101'], 'N':['101','111','111','111','101'],
  'O':['111','101','101','101','111'], 'P':['111','101','111','100','100'],
  'Q':['111','101','101','111','011'], 'R':['111','101','111','110','101'],
  'S':['011','100','010','001','110'], 'T':['111','010','010','010','010'],
  'U':['101','101','101','101','111'], 'V':['101','101','101','101','010'],
  'W':['101','101','111','111','101'], 'X':['101','101','010','101','101'],
  'Y':['101','101','010','010','010'], 'Z':['111','001','010','100','111'],
  ' ':['000','000','000','000','000'], ':':['000','010','000','010','000'],
  '-':['000','000','111','000','000'], '.':['000','000','000','000','010'],
  '!':['010','010','010','000','010'], '<':['001','010','100','010','001'],
  '>':['100','010','001','010','100'], '/':['001','001','010','100','100'],
  '+':['000','010','111','010','000'], '*':['101','010','111','010','101'],
  '%':['101','001','010','100','101'], '?':['111','001','011','000','010'],
};
const GLYPH_W = 3, GLYPH_H = 5;

/** Pixel width of `str` at scale `s` (each glyph is 3 px + 1 px gap). */
export function textWidth(str, s = 1) {
  return str.length * (GLYPH_W + 1) * s - s;
}

// ── Reusable particle pool ──────────────────────────────────────────────────
// Struct-of-arrays, fixed cap, no allocation after construction. Games make
// one (or several) in their create() and reuse forever. Colours are stored as
// an index into a small caller-provided palette array to avoid per-particle
// string churn.
export function createParticles(cap = 256) {
  const x = new Float32Array(cap), y = new Float32Array(cap);
  const vx = new Float32Array(cap), vy = new Float32Array(cap);
  const life = new Float32Array(cap), max = new Float32Array(cap);
  const size = new Float32Array(cap);
  const col = new Array(cap).fill('#fff');
  let head = 0;
  return {
    spawn(px, py, pvx, pvy, plife, color, psize = 1) {
      const i = head; head = (head + 1) % cap;
      x[i] = px; y[i] = py; vx[i] = pvx; vy[i] = pvy;
      life[i] = plife; max[i] = plife; col[i] = color; size[i] = psize;
    },
    update(dt, gravity = 0, drag = 1) {
      for (let i = 0; i < cap; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        vy[i] += gravity * dt;
        vx[i] *= drag; vy[i] *= drag;
        x[i] += vx[i] * dt; y[i] += vy[i] * dt;
      }
    },
    draw(vctx) {
      for (let i = 0; i < cap; i++) {
        if (life[i] <= 0) continue;
        const a = Math.max(0, Math.min(1, life[i] / max[i]));
        vctx.globalAlpha = a;
        vctx.fillStyle = col[i];
        const s = size[i];
        vctx.fillRect(x[i] - s * 0.5, y[i] - s * 0.5, s, s);
      }
      vctx.globalAlpha = 1;
    },
    clear() { for (let i = 0; i < cap; i++) life[i] = 0; },
  };
}

// Knock out a sprite's solid background to transparent. Many exported PNGs come
// on an opaque (usually white) matte — that shows in-game as a rectangle around
// the sprite. We flood-fill from the image EDGES, clearing only background that
// matches the corner colour and is connected to the border — so interior pixels
// of that same colour (a white licence plate, headlights, highlights) are kept.
// Returns a canvas (drawable/tintable like an Image). No-op headless.
function keyOutBackground(img) {
  if (typeof document === 'undefined') return img;
  const w = img.width | 0, h = img.height | 0;
  if (w < 2 || h < 2) return img;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.drawImage(img, 0, 0);
  let data;
  try { data = cc.getImageData(0, 0, w, h); } catch { return c; }   // CORS-taint guard
  const px = data.data;
  if (px[3] < 250) return c;                 // corner already transparent → leave as-is
  const br = px[0], bg = px[1], bb = px[2];
  const TOL = 76 * 76;                        // colour distance² that counts as "background"
  const N = w * h, visited = new Uint8Array(N), stack = [];
  const seed = (p) => { if (!visited[p]) { visited[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + (w - 1)); }
  while (stack.length) {
    const p = stack.pop(), i = p << 2;
    if (px[i + 3] === 0) continue;
    const dr = px[i] - br, dg = px[i + 1] - bg, db = px[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > TOL) continue;   // hit the car → stop spreading
    px[i + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }
  cc.putImageData(data, 0, 0);
  // Crop to the opaque content bounds — removes the transparent padding so a
  // shadow drawn at the sprite's bottom hugs the wheels (no float) and the
  // aspect ratio reflects the actual car, not the export canvas.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return c;                          // nothing opaque
  const cw = maxX - minX + 1, chh = maxY - minY + 1;
  if (cw === w && chh === h) return c;                // no padding to trim
  const cropped = document.createElement('canvas');
  cropped.width = cw; cropped.height = chh;
  cropped.getContext('2d').drawImage(c, minX, minY, cw, chh, 0, 0, cw, chh);
  return cropped;
}

// ── The engine ──────────────────────────────────────────────────────────────
export function createEngine(mainCtx) {
  // Virtual framebuffer (the "cabinet screen"). Lazily (re)sized.
  const vbuf = document.createElement('canvas');
  const vctx = vbuf.getContext('2d');
  vctx.imageSmoothingEnabled = false;

  // Separate HUD layer — composited in present() WITHOUT the screen-shake
  // offset so the score/diagnostics read rock-steady while the game world
  // shakes underneath. `dc` is the current draw target for text()/rect():
  // the game buffer (vctx) by default, the HUD buffer (hctx) only between
  // beginHud()/endHud(). Every other primitive always targets the game buffer.
  const hbuf = document.createElement('canvas');
  const hctx = hbuf.getContext('2d');
  hctx.imageSmoothingEnabled = false;
  let dc = vctx;

  let W = 1, H = 1;           // display (backing-buffer) px
  let vw = 256, vh = 224;     // virtual px — games render against these
  let shakeX = 0, shakeY = 0, shakeMag = 0;

  // CRT post layers, built lazily and cached against display size.
  let scanPat = null, scanForH = -1;
  let vig = null, vigForKey = '';

  function ensureScanlines() {
    if (scanPat && scanForH === H) return scanPat;
    // One dark row every 3 device px — subtle, reads as a CRT raster without
    // eating brightness. Pattern is 1×3 so it tiles vertically for free.
    const c = document.createElement('canvas');
    c.width = 1; c.height = 3;
    const cc = c.getContext('2d');
    cc.fillStyle = 'rgba(0,0,0,0.22)';
    cc.fillRect(0, 2, 1, 1);
    scanPat = mainCtx.createPattern(c, 'repeat');
    scanForH = H;
    return scanPat;
  }
  function ensureVignette() {
    const key = `${W}x${H}`;
    if (vig && vigForKey === key) return vig;
    const g = mainCtx.createRadialGradient(
      W * 0.5, H * 0.5, Math.min(W, H) * 0.30,
      W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    vig = g; vigForKey = key;
    return vig;
  }

  // Recompute virtual dims from a target height + the live aspect ratio. vw is
  // derived from the SAME aspect as the display so the upscale is uniform (no
  // letterbox). Only resize the backing canvas when it actually changes —
  // resizing clears it and isn't free.
  function setVirtualHeight(targetH) {
    const aspect = W / Math.max(1, H);
    const nvh = Math.max(120, Math.min(360, Math.round(targetH)));
    let nvw = Math.round(nvh * aspect);
    nvw = Math.max(160, Math.min(640, nvw - (nvw & 1)));   // even, bounded
    if (nvw === vw && nvh === vh) return false;
    vw = nvw; vh = nvh;
    vbuf.width = vw; vbuf.height = vh;
    hbuf.width = vw; hbuf.height = vh;
    vctx.imageSmoothingEnabled = false;
    hctx.imageSmoothingEnabled = false;
    return true;     // signal: dims changed (games may need to relayout)
  }

  const eng = {
    C,
    get vw() { return vw; },
    get vh() { return vh; },
    get vctx() { return vctx; },
    createParticles,
    textWidth,

    resize(w, h) { W = w; H = h; scanForH = -1; vigForKey = ''; },
    setVirtualHeight,

    // Clear the framebuffer to a colour (default void). Also resets the draw
    // target back to the game layer — a frame always opens with clear(), so an
    // unbalanced beginHud() (e.g. a game that threw mid-HUD) can't leak.
    clear(color = C.void) {
      dc = vctx;
      vctx.globalAlpha = 1;
      vctx.fillStyle = color;
      vctx.fillRect(0, 0, vw, vh);
    },

    // Filled rect in virtual space (rounds to whole pixels for crisp edges).
    // Targets the current layer (`dc`) so HUD rects land on the stationary layer.
    rect(x, y, w, h, color, alpha = 1) {
      dc.globalAlpha = alpha;
      dc.fillStyle = color;
      dc.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      dc.globalAlpha = 1;
    },

    // 1-px-thick rectangle outline.
    box(x, y, w, h, color, alpha = 1) {
      vctx.globalAlpha = alpha;
      vctx.fillStyle = color;
      x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
      vctx.fillRect(x, y, w, 1);
      vctx.fillRect(x, y + h - 1, w, 1);
      vctx.fillRect(x, y, 1, h);
      vctx.fillRect(x + w - 1, y, 1, h);
      vctx.globalAlpha = 1;
    },

    // Pixel-art sprite blitter. `rows` is an array of equal-length strings;
    // each char keys into `pal` (a {char: color} map). ' ' and '.' are
    // transparent. `s` is the pixel scale, `flipX` mirrors horizontally. This
    // is the way to draw the racer car, glyph pellets, ships, etc. — author a
    // little ASCII grid + palette and blit it.
    sprite(x, y, rows, pal, s = 1, flipX = false, alpha = 1) {
      vctx.globalAlpha = alpha;
      const h = rows.length;
      for (let r = 0; r < h; r++) {
        const row = rows[r], w = row.length;
        for (let c = 0; c < w; c++) {
          const ch = row[flipX ? (w - 1 - c) : c];
          if (ch === ' ' || ch === '.') continue;
          const col = pal[ch];
          if (!col) continue;
          vctx.fillStyle = col;
          vctx.fillRect(Math.round(x + c * s), Math.round(y + r * s), s, s);
        }
      }
      vctx.globalAlpha = 1;
    },

    // Linear interpolate — handy for autopilot/player blends.
    lerp(a, b, t) { return a + (b - a) * t; },

    // Cheap filled disc (for orbs / dots / wheels). Radius in virtual px.
    disc(cx, cy, r, color, alpha = 1) {
      vctx.globalAlpha = alpha;
      vctx.fillStyle = color;
      vctx.beginPath();
      vctx.arc(cx, cy, r, 0, Math.PI * 2);
      vctx.fill();
      vctx.globalAlpha = 1;
    },

    // Switch text()/rect() to the stationary HUD layer. Wrap a game's HUD block
    // (and the shell's diagnostics strip) in beginHud()/endHud() so they
    // composite WITHOUT the screen-shake offset — the world shakes, the HUD
    // doesn't. Everything drawn outside the pair stays on the shakeable layer.
    beginHud() { dc = hctx; },
    endHud()   { dc = vctx; },

    // Bitmap text. `align`: 'left' | 'center' | 'right'. Returns the right edge.
    // Targets the current layer (`dc`).
    text(str, x, y, color = C.white, s = 1, align = 'left', alpha = 1) {
      str = String(str).toUpperCase();
      const w = textWidth(str, s);
      let px = align === 'center' ? Math.round(x - w / 2)
             : align === 'right'  ? Math.round(x - w)
             : Math.round(x);
      dc.globalAlpha = alpha;
      dc.fillStyle = color;
      for (let ci = 0; ci < str.length; ci++) {
        const g = FONT[str[ci]] || FONT['?'];
        for (let r = 0; r < GLYPH_H; r++) {
          const row = g[r];
          for (let cphi = 0; cphi < GLYPH_W; cphi++) {
            if (row[cphi] === '1') dc.fillRect(px + cphi * s, y + r * s, s, s);
          }
        }
        px += (GLYPH_W + 1) * s;
      }
      dc.globalAlpha = 1;
      return px;
    },

    // ── Image sprites (optional PNG assets) ──────────────────────────────────
    // Games may load real bitmaps (e.g. the player car) and draw them into the
    // framebuffer. Everything is guarded so it no-ops cleanly headless / before
    // the asset has loaded — callers fall back to procedural art until .ready.
    loadImage(url, removeBg = false) {
      const o = { ready: false, src: null, w: 1, h: 1 };
      if (typeof Image === 'undefined') return o;
      const im = new Image();
      im.onload = () => {
        o.src = removeBg ? keyOutBackground(im) : im;
        o.w = (o.src && o.src.width) || im.width || 1;     // cropped dims when keyed
        o.h = (o.src && o.src.height) || im.height || 1;
        o.ready = true;
      };
      im.onerror = () => {};
      try { im.src = url; } catch {}
      return o;
    },
    // Bake a hue-rotated copy of a loaded image to an offscreen canvas (for NPC
    // colour variants — one bake at load, then a plain draw each frame).
    tintImage(src, hueDeg, sat = 1.15) {
      if (typeof document === 'undefined' || !src) return src;
      const w = src.width || 1, h = src.height || 1;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const cc = c.getContext('2d');
      cc.filter = `hue-rotate(${hueDeg}deg) saturate(${sat})`;
      cc.drawImage(src, 0, 0);
      return c;
    },
    // Draw a loaded image/canvas into the framebuffer (smoothing ON for a clean
    // downscale into the cabinet), optional horizontal flip. No-op if !src.
    drawSprite(src, dx, dy, dw, dh, flip = false, alpha = 1) {
      if (!src) return;
      vctx.imageSmoothingEnabled = true;
      vctx.globalAlpha = alpha;
      dx = Math.round(dx); dy = Math.round(dy); dw = Math.round(dw); dh = Math.round(dh);
      if (flip) {
        vctx.save(); vctx.translate(dx + dw, dy); vctx.scale(-1, 1);
        vctx.drawImage(src, 0, 0, dw, dh); vctx.restore();
      } else {
        vctx.drawImage(src, dx, dy, dw, dh);
      }
      vctx.globalAlpha = 1;
      vctx.imageSmoothingEnabled = false;
    },

    // ── Outrun-style HUD ─────────────────────────────────────────────────────
    // Chunky outlined labels + values, the classic arcade dashboard look. Used
    // by every game's HUD (game stats) and by the quale shell (diagnostics).
    textOutline(str, x, y, color, s = 1, align = 'left') {
      const w = textWidth(String(str).toUpperCase(), s);
      const px = align === 'center' ? Math.round(x - w / 2) : align === 'right' ? Math.round(x - w) : Math.round(x);
      this.text(str, px - s, y, '#05050d', s); this.text(str, px + s, y, '#05050d', s);
      this.text(str, px, y - s, '#05050d', s); this.text(str, px, y + s, '#05050d', s);
      this.text(str, px, y, color, s);
      return px + w;
    },
    // A labelled stat: outlined LABEL (in `color`) + a one-glyph gap + outlined
    // value (in white). Returns total px width. align left|center|right.
    hud(x, y, label, value, color = C.gold, align = 'left', s = 1) {
      label = String(label).toUpperCase();
      const val = value == null ? '' : String(value).toUpperCase();
      const lw = textWidth(label, s);
      const gap = val ? (GLYPH_W + 1) * s : 0;
      const total = lw + gap + (val ? textWidth(val, s) : 0);
      const px = align === 'center' ? Math.round(x - total / 2) : align === 'right' ? Math.round(x - total) : Math.round(x);
      this.textOutline(label, px, y, color, s);
      if (val) this.textOutline(val, px + lw + gap, y, C.white, s);
      return total;
    },
    // Segmented level gauge (the km/h-bar analog). frac 0..1.
    hudBar(x, y, w, h, frac, color, segs = 12) {
      frac = Math.max(0, Math.min(1, frac));
      const sw = w / segs;
      for (let i = 0; i < segs; i++) {
        const on = (i + 0.5) / segs <= frac;
        this.rect(x + i * sw, y, Math.max(1, sw - 1), h, on ? color : '#232b3d', on ? 1 : 0.7);
      }
    },

    // Add screen-shake energy (decays in present()). Magnitude in display px.
    shake(mag) { if (mag > shakeMag) shakeMag = mag; },

    // Composite the framebuffer to the live canvas: crisp upscale + optional
    // CRT post + screen-shake. Called by the quale shell once per frame after
    // the active game has drawn into vctx.
    present(opts) {
      const crt = opts && opts.crt;
      // Decay shake and pick a random offset within its current magnitude.
      if (shakeMag > 0.05) {
        shakeX = (Math.random() * 2 - 1) * shakeMag;
        shakeY = (Math.random() * 2 - 1) * shakeMag;
        shakeMag *= 0.86;
      } else { shakeX = shakeY = shakeMag = 0; }

      mainCtx.save();
      mainCtx.imageSmoothingEnabled = false;
      mainCtx.clearRect(0, 0, W, H);
      // Over-scale a hair while shaking so the jittered frame never exposes a
      // hard edge at the canvas border.
      const pad = shakeMag > 0 || shakeX !== 0 ? Math.ceil(Math.max(Math.abs(shakeX), Math.abs(shakeY))) + 2 : 0;
      mainCtx.drawImage(vbuf, 0, 0, vw, vh,
        -pad + shakeX, -pad + shakeY, W + pad * 2, H + pad * 2);
      // HUD layer — drawn at the EXACT 1:1 upscale (no shake offset, no
      // overscale pad) so it stays stationary over the shaking world. Composited
      // before the CRT post so it gets the same scanline/vignette treatment.
      mainCtx.drawImage(hbuf, 0, 0, vw, vh, 0, 0, W, H);
      mainCtx.restore();

      if (crt) {
        mainCtx.save();
        mainCtx.fillStyle = ensureScanlines();
        mainCtx.fillRect(0, 0, W, H);
        mainCtx.fillStyle = ensureVignette();
        mainCtx.fillRect(0, 0, W, H);
        mainCtx.restore();
      }
      // Wipe the HUD layer for the next frame (the game layer is cleared by the
      // game's own clear()). Cheap: only the small virtual buffer.
      hctx.clearRect(0, 0, vw, vh);
      dc = vctx;
    },
  };
  return eng;
}
