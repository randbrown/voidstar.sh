// Code — streams the qualia lab's own source code on screen, with multiple
// visualization modes. Self-referential: the source it renders is loaded at
// build time from this folder via `import.meta.glob`, so the quale visualizes
// the very code that draws it.
//
// Modes:
//   greenscreen  Retro CRT terminal. Optional rotated, overlapping panels
//                of the same code stream (à la andreasgysin "X-Y-(Z)").
//   mono         Soft white-on-black, clean, minimal — no glow, no glitch.
//   syntax       VSCode-style colorized tokens. Five palettes: classic,
//                dracula, monokai, strudel, neon.
//   binary       Matrix-style waterfall of 0s and 1s with occasional code
//                glyphs mixed in. Palette tints the trail.
//   drift        Code lines floating in 3D space with depth-fade and
//                parallax — the "floating-code" cinematic look.
//
// Audio bindings (declarative on params): bass + beatPulse → scrollSpeed,
// highs → glow, midsPulse → glitch. Spectrum tilts binary column intensity.
// Pose: shoulderSpan → fontScale (lean-in/out for bigger/smaller code), and
// head.x is used directly as a small tilt on rotated greenscreen panels.

import { scaleAudio } from '../field.js';

// ── Source code ingestion ──────────────────────────────────────────────────
// Pull every .js file in src/lib/qualia/** as raw text at build time. Vite
// resolves the glob and inlines the strings into the bundle. Self-reference
// is fine — code.js sees itself.
const SOURCE_MODULES = import.meta.glob('../**/*.js', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Build a flat array of { text, file } line records, with file headers. */
function buildSourceLines() {
  const out = [];
  const paths = Object.keys(SOURCE_MODULES).sort();
  for (const path of paths) {
    const src = SOURCE_MODULES[path];
    if (typeof src !== 'string') continue;
    const short = path.replace(/^\.\.\//, '');
    out.push({ text: `// ─── ${short} ───`.padEnd(80, '─'), file: short, header: true });
    const lines = src.split('\n');
    for (const line of lines) {
      out.push({ text: line, file: short, header: false });
    }
    out.push({ text: '', file: short, header: false });
  }
  return out;
}

const SOURCE_LINES = buildSourceLines();

// ── Palettes ───────────────────────────────────────────────────────────────
const SYNTAX_PALETTES = {
  classic: { bg:'#0f0f1e', text:'#d4d4d4', kw:'#569cd6', str:'#ce9178', num:'#b5cea8', com:'#6a9955', op:'#dcdcaa', punct:'#d4d4d4' },
  dracula: { bg:'#282a36', text:'#f8f8f2', kw:'#ff79c6', str:'#f1fa8c', num:'#bd93f9', com:'#6272a4', op:'#50fa7b', punct:'#f8f8f2' },
  monokai: { bg:'#272822', text:'#f8f8f2', kw:'#f92672', str:'#e6db74', num:'#ae81ff', com:'#75715e', op:'#a6e22e', punct:'#f8f8f2' },
  strudel: { bg:'#0a0a14', text:'#f0e6ff', kw:'#ff6b9d', str:'#ffd93d', num:'#6bcfff', com:'#7a6f9e', op:'#a8ff60', punct:'#f0e6ff' },
  neon:    { bg:'#000010', text:'#00ffff', kw:'#ff00ff', str:'#ffff00', num:'#00ff66', com:'#666688', op:'#00ffaa', punct:'#88ffff' },
};

// Binary mode — head char is bright white, body chars use `body`, tail fades to `dim`.
const BINARY_PALETTES = {
  classic: { bg:'#000000', head:'#eaffea', body:'#00ff66', dim:'#001a0a' },
  dracula: { bg:'#0a0810', head:'#ffffff', body:'#bd93f9', dim:'#1a0f33' },
  monokai: { bg:'#0a0808', head:'#ffffff', body:'#f92672', dim:'#330812' },
  strudel: { bg:'#08080f', head:'#ffffff', body:'#ffd93d', dim:'#332a08' },
  neon:    { bg:'#000010', head:'#ffffff', body:'#ff00ff', dim:'#1a001a' },
};

const PALETTE_NAMES = Object.keys(SYNTAX_PALETTES);

// Extra glyph pool that gets sprinkled into binary mode for visual interest.
const BINARY_EXTRA_GLYPHS = '01010101101001ABCDEF{}[]()=+*-/<>;:.';

// Reserved-word set for the simple syntax tokenizer. Not exhaustive — covers
// what shows up frequently in this codebase.
const KEYWORDS = new Set([
  'const','let','var','function','return','if','else','for','while','do','switch',
  'case','break','continue','default','new','class','extends','this','super',
  'import','export','from','as','async','await','typeof','instanceof','in','of',
  'try','catch','finally','throw','null','undefined','true','false','void','yield',
  'static','get','set','delete',
]);

// ── Tokenizer for syntax mode ──────────────────────────────────────────────
// Token kinds: 'kw'|'str'|'num'|'com'|'op'|'punct'|'text'
// Returns an array of { t, s } per line. Cheap regex-based; not a real parser.
const TOKEN_RE = new RegExp([
  /(\/\/[^\n]*)/.source,                       // line comment
  /(\/\*[\s\S]*?\*\/)/.source,                 // block comment (single line)
  /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/.source, // strings
  /(\b\d+(?:\.\d+)?\b)/.source,                // numbers
  /([+\-*/%=<>!&|^~?]+)/.source,               // operators
  /([{}\[\]();,.:])/.source,                   // punctuation
  /([A-Za-z_$][\w$]*)/.source,                 // identifiers / keywords
  /(\s+)/.source,                              // whitespace
].join('|'), 'g');

function tokenizeLine(line) {
  const out = [];
  if (!line) return out;
  let m;
  TOKEN_RE.lastIndex = 0;
  let last = 0;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) {
      out.push({ t: 'text', s: line.slice(last, m.index) });
    }
    if (m[1] != null)      out.push({ t: 'com',   s: m[1] });
    else if (m[2] != null) out.push({ t: 'com',   s: m[2] });
    else if (m[3] != null) out.push({ t: 'str',   s: m[3] });
    else if (m[4] != null) out.push({ t: 'num',   s: m[4] });
    else if (m[5] != null) out.push({ t: 'op',    s: m[5] });
    else if (m[6] != null) out.push({ t: 'punct', s: m[6] });
    else if (m[7] != null) out.push({ t: KEYWORDS.has(m[7]) ? 'kw' : 'text', s: m[7] });
    else if (m[8] != null) out.push({ t: 'text',  s: m[8] });
    last = TOKEN_RE.lastIndex;
  }
  if (last < line.length) out.push({ t: 'text', s: line.slice(last) });
  return out;
}

// ── Module ─────────────────────────────────────────────────────────────────
/** @type {import('../types.js').QFXModule} */
export default {
  id: 'code',
  name: 'Code',
  contextType: 'canvas2d',

  params: [
    { id: 'mode', label: 'mode', type: 'select',
      options: ['greenscreen', 'mono', 'syntax', 'binary', 'drift', 'spectrum', 'heatmap'], default: 'greenscreen' },
    { id: 'palette', label: 'palette', type: 'select',
      options: PALETTE_NAMES, default: 'dracula' },
    { id: 'scrollSpeed', label: 'scroll speed', type: 'range',
      min: 0, max: 2, step: 0.02, default: 0.2,
      modulators: [
        { source: 'audio.bass',      mode: 'mul', amount: 0.6 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.4 },
      ] },
    { id: 'fontScale', label: 'font scale', type: 'range',
      min: 0.4, max: 2.5, step: 0.05, default: 1.0,
      modulators: [
        { source: 'pose.shoulderSpan', mode: 'mul', amount: 0.0 },
      ] },
    { id: 'glow', label: 'glow', type: 'range',
      min: 0, max: 2, step: 0.05, default: 0.7,
      modulators: [
        { source: 'audio.highs',      mode: 'mul', amount: 0.8 },
        { source: 'audio.beatPulse',  mode: 'add', amount: 0.4 },
      ] },
    { id: 'glitch', label: 'glitch', type: 'range',
      min: 0, max: 1, step: 0.02, default: 0.25,
      modulators: [
        { source: 'audio.midsPulse', mode: 'mul', amount: 1.4 },
      ] },
    { id: 'layers', label: 'panels', type: 'range',
      min: 0, max: 3, step: 1, default: 1 },
    { id: 'reactivity', label: 'reactivity', type: 'range',
      min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  presets: {
    default:     { mode: 'greenscreen', palette: 'dracula', scrollSpeed: 0.2, fontScale: 1.0, glow: 0.7, glitch: 0.25, layers: 1, reactivity: 1.0 },
    greenscreen: { mode: 'greenscreen', layers: 0, glow: 0.9, glitch: 0.15 },
    layered:     { mode: 'greenscreen', layers: 3, glow: 1.0, glitch: 0.30, fontScale: 0.9 },
    mono:        { mode: 'mono', layers: 0, glow: 0.0, glitch: 0.05, scrollSpeed: 0.12 },
    syntax:      { mode: 'syntax', palette: 'dracula', glow: 0.4, glitch: 0.05 },
    monokai:     { mode: 'syntax', palette: 'monokai', glow: 0.5 },
    matrix:      { mode: 'binary', palette: 'classic', scrollSpeed: 1.2, glow: 1.1, fontScale: 0.9 },
    binary_pink: { mode: 'binary', palette: 'monokai', scrollSpeed: 0.9, glow: 0.9 },
    drift:       { mode: 'drift', glow: 0.5, scrollSpeed: 0.4, fontScale: 1.1 },
    spectrum:    { mode: 'spectrum', glow: 0.4, glitch: 0.0, scrollSpeed: 0.18 },
    heatmap:     { mode: 'heatmap',  glow: 0.6, glitch: 0.0, scrollSpeed: 0.15 },
  },

  // Phase steps walk every mode plus a couple palette variants. Stays inside
  // the active quale — switches the `mode`/`palette` params, leaves user-set
  // sliders alone.
  autoPhase: {
    steps: [
      { mode: 'greenscreen', layers: 0 },
      { mode: 'greenscreen', layers: 2 },
      { mode: 'mono' },
      { mode: 'syntax', palette: 'dracula' },
      { mode: 'syntax', palette: 'monokai' },
      { mode: 'syntax', palette: 'strudel' },
      { mode: 'binary', palette: 'classic' },
      { mode: 'binary', palette: 'strudel' },
      { mode: 'drift' },
      { mode: 'spectrum' },
      { mode: 'heatmap' },
    ],
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    const FONT_FAMILY = "'Menlo', 'Consolas', 'DejaVu Sans Mono', 'Courier New', monospace";
    const BASE_FONT_PX = 14;        // pre-scale base size

    // Streaming scroll offsets (in pixels) for the main panel and each
    // rotated overlay panel. Pre-allocated max 3 layers.
    const mainScroll = { y: 0 };
    const layerStates = [
      { y: 0, angle: -0.18, speed: 0.55, scaleX: 1.05, scaleY: 1.05, ofsX: -W * 0.08, ofsY: 0, alpha: 0.35 },
      { y: 0, angle:  0.22, speed: 1.30, scaleX: 0.85, scaleY: 0.85, ofsX:  W * 0.12, ofsY: 0, alpha: 0.40 },
      { y: 0, angle: -0.34, speed: 0.85, scaleX: 1.20, scaleY: 1.20, ofsX:  W * 0.04, ofsY: -H * 0.05, alpha: 0.30 },
    ];

    // Binary mode — per-column drops. Re-allocated in resize() to fit the
    // current column count at the current font scale.
    const dropPool = []; // { col, y, speed, len, glyphs:[], lastAdvance }

    // Drift mode — pre-allocated line records floating in 3D.
    const DRIFT_LINES = 80;
    const driftLines = new Array(DRIFT_LINES);
    function spawnDriftLine(i) {
      driftLines[i] = {
        idx:  Math.floor(Math.random() * SOURCE_LINES.length),
        x:    (Math.random() - 0.5) * 1.4,        // [-0.7, +0.7] horizontal
        y:    (Math.random() - 0.5) * 1.6,        // [-0.8, +0.8] vertical
        z:    0.05 + Math.random() * 1.2,         // depth 0.05..1.25
        vz:   -0.05 - Math.random() * 0.10,       // moves toward viewer
      };
    }
    for (let i = 0; i < DRIFT_LINES; i++) spawnDriftLine(i);

    // Pose-driven smoothed inputs.
    let smoothHeadX = 0;
    let smoothPresence = 0;

    // Heatmap mode — per-line frozen audio band snapshot, keyed by ABSOLUTE
    // scrolled-line number (Math.floor(scrollY/lineH) + row). Each line
    // captures the bands the moment it first scrolls into view, then carries
    // that color upward as it scrolls past — a true spectrogram-on-text
    // waterfall. Bounded to keep memory stable.
    const bandHistory = new Map();
    function pruneBandHistory() {
      if (bandHistory.size <= 600) return;
      // Drop the oldest 200 entries (smallest absolute line numbers).
      const keys = Array.from(bandHistory.keys());
      keys.sort((a, b) => a - b);
      for (let i = 0; i < 200; i++) bandHistory.delete(keys[i]);
    }

    // Tokenize cache for syntax mode — only the visible window of lines
    // gets tokenized. Keyed by line index.
    const tokenCache = new Map();
    function getTokens(idx) {
      let toks = tokenCache.get(idx);
      if (!toks) {
        toks = tokenizeLine(SOURCE_LINES[idx].text);
        tokenCache.set(idx, toks);
        // Bound the cache to keep memory stable.
        if (tokenCache.size > 2000) {
          const firstKey = tokenCache.keys().next().value;
          tokenCache.delete(firstKey);
        }
      }
      return toks;
    }

    // Compute the source-line index for a given panel y-position. SOURCE_LINES
    // wraps cyclically so the stream never runs out.
    function lineAt(scrollY, row, lineHeight) {
      const idx = Math.floor((scrollY / lineHeight) + row);
      const n = SOURCE_LINES.length;
      return ((idx % n) + n) % n;
    }

    // ── Renderers ────────────────────────────────────────────────────────
    // Each renderer is invoked once per frame. They read from `scratch` only.

    function fontSizeFor(params) {
      // Clamp font scale safely — avoid sub-pixel sizes that vanish.
      const px = Math.max(6, Math.round(BASE_FONT_PX * params.fontScale));
      return px;
    }

    /** Draw a single stream of lines into the current ctx transform. */
    function drawTextStream(scrollY, params, palette, opts) {
      const fontPx = opts.fontPx;
      const lineH = Math.round(fontPx * 1.25);
      ctx.font = `${fontPx}px ${FONT_FAMILY}`;
      ctx.textBaseline = 'top';
      const xPad = 16;
      const visW = opts.viewW;
      const visH = opts.viewH;
      const rows = Math.ceil(visH / lineH) + 2;
      const sub = scrollY % lineH;
      for (let r = 0; r < rows; r++) {
        const lineIdx = lineAt(scrollY, r, lineH);
        const yPx = r * lineH - sub;
        const rec = SOURCE_LINES[lineIdx];

        // Glitch: occasionally skip drawing or jitter horizontally.
        let xOff = 0;
        if (params.glitch > 0 && Math.random() < params.glitch * 0.08) {
          xOff = (Math.random() - 0.5) * fontPx * 6;
        }
        if (params.glitch > 0 && Math.random() < params.glitch * 0.04) continue;

        if (opts.kind === 'plain') {
          ctx.fillStyle = opts.color;
          ctx.fillText(rec.text, xPad + xOff, yPx);
        } else if (opts.kind === 'syntax') {
          // Draw token-by-token with palette colors.
          let x = xPad + xOff;
          if (rec.header) {
            ctx.fillStyle = palette.com;
            ctx.fillText(rec.text, x, yPx);
            continue;
          }
          const toks = getTokens(lineIdx);
          for (let ti = 0; ti < toks.length; ti++) {
            const tk = toks[ti];
            ctx.fillStyle = palette[tk.t] || palette.text;
            ctx.fillText(tk.s, x, yPx);
            x += ctx.measureText(tk.s).width;
            if (x > visW + 200) break;
          }
        }
      }
    }

    function paintBackground(color, fade) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${fade})`;
      ctx.fillRect(0, 0, W, H);
    }

    function renderGreenscreen(audio, params) {
      // Trail-fade background. Small fade keeps phosphor smear; bigger fade on
      // bass pumps for that breathing CRT look.
      const fade = 0.28 + audio.bands.bass * 0.10;
      paintBackground({ r: 5, g: 12, b: 6 }, fade);

      const fontPx = fontSizeFor(params);
      const glow = Math.max(0, params.glow);
      ctx.shadowColor = `rgba(0,255,128,${0.45 * glow})`;
      ctx.shadowBlur = 6 + 14 * glow;

      // Main stream — straight-on, full opacity.
      ctx.globalAlpha = 0.92;
      drawTextStream(mainScroll.y, params, null, {
        kind: 'plain',
        color: '#7cff9a',
        viewW: W, viewH: H, fontPx,
      });

      // Optional rotated overlay panels (Andreas Gysin layered look). Each
      // has its own scroll, angle, and parallax offset. Subtle head.x tilt
      // is added for live, person-aware motion.
      const layerCount = Math.min(3, Math.max(0, params.layers | 0));
      for (let li = 0; li < layerCount; li++) {
        const ls = layerStates[li];
        ctx.save();
        ctx.globalAlpha = ls.alpha;
        ctx.translate(W / 2 + ls.ofsX, H / 2 + ls.ofsY);
        ctx.rotate(ls.angle + smoothHeadX * 0.12);
        ctx.scale(ls.scaleX, ls.scaleY);
        ctx.translate(-W / 2, -H / 2);
        // Bright cyan-green border like the screenshot frames.
        ctx.strokeStyle = `rgba(120,255,180,${0.55 + audio.beat.pulse * 0.35})`;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 12 * (1 + glow);
        ctx.shadowColor = `rgba(120,255,180,${0.45 * glow})`;
        const inset = 18;
        ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
        // Code inside the frame.
        ctx.shadowBlur = 4 + 10 * glow;
        ctx.shadowColor = `rgba(0,255,160,${0.55 * glow})`;
        ctx.beginPath();
        ctx.rect(inset, inset, W - inset * 2, H - inset * 2);
        ctx.clip();
        drawTextStream(ls.y, params, null, {
          kind: 'plain',
          color: '#9bffb6',
          viewW: W, viewH: H, fontPx: Math.round(fontPx * (li === 1 ? 0.85 : 1.0)),
        });
        ctx.restore();
      }

      // Hard kick: white phosphor flash.
      if (audio.beat.active) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(180,255,200,${0.10 + audio.beat.pulse * 0.10})`;
        ctx.fillRect(0, 0, W, H);
      }

      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    function renderMono(audio, params) {
      // Crisp solid black background — minimal phosphor fade, intentionally clean.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#06060a';
      ctx.fillRect(0, 0, W, H);

      const fontPx = fontSizeFor(params);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.92;
      drawTextStream(mainScroll.y, params, null, {
        kind: 'plain',
        color: '#e8e8ee',
        viewW: W, viewH: H, fontPx,
      });

      // Subtle dim line under the cursor row for a typewriter feel.
      ctx.globalAlpha = 0.05 + audio.bands.total * 0.10;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, H * 0.5, W, 1);
      ctx.globalAlpha = 1;
    }

    function renderSyntax(audio, params) {
      const palette = SYNTAX_PALETTES[params.palette] || SYNTAX_PALETTES.dracula;
      // Hex bg → rgb for trail fade.
      const bgR = parseInt(palette.bg.slice(1, 3), 16);
      const bgG = parseInt(palette.bg.slice(3, 5), 16);
      const bgB = parseInt(palette.bg.slice(5, 7), 16);
      paintBackground({ r: bgR, g: bgG, b: bgB }, 0.55 + audio.bands.bass * 0.25);

      const fontPx = fontSizeFor(params);
      const glow = Math.max(0, params.glow);
      ctx.shadowColor = `rgba(255,255,255,${0.20 * glow})`;
      ctx.shadowBlur = 2 + 6 * glow;
      ctx.globalAlpha = 1;
      drawTextStream(mainScroll.y, params, palette, {
        kind: 'syntax',
        viewW: W, viewH: H, fontPx,
      });
      ctx.shadowBlur = 0;
    }

    function renderBinary(audio, params) {
      const palette = BINARY_PALETTES[params.palette] || BINARY_PALETTES.classic;
      const bgR = parseInt(palette.bg.slice(1, 3), 16);
      const bgG = parseInt(palette.bg.slice(3, 5), 16);
      const bgB = parseInt(palette.bg.slice(5, 7), 16);
      // Heavy trail fade — short tail keeps it Matrix-y, longer tail with bass.
      paintBackground({ r: bgR, g: bgG, b: bgB }, 0.18 + audio.bands.bass * 0.15);

      const fontPx = Math.max(8, Math.round(BASE_FONT_PX * params.fontScale * 0.85));
      const charW  = Math.max(6, Math.round(fontPx * 0.62));
      const lineH  = Math.round(fontPx * 1.05);
      ctx.font = `${fontPx}px ${FONT_FAMILY}`;
      ctx.textBaseline = 'top';

      const cols = Math.ceil(W / charW);

      // Spawn drops to fill columns. Each column may host 0–2 active drops.
      // Active drop count target: cols × 0.55, modulated lightly by mids.
      const target = Math.floor(cols * (0.45 + audio.bands.mids * 0.35));
      while (dropPool.length < target) {
        dropPool.push({
          col: Math.floor(Math.random() * cols),
          y: -Math.random() * H * 0.4,
          speed: 60 + Math.random() * 220,   // px/sec
          len: 6 + Math.floor(Math.random() * 18),
          glyphs: [],
        });
      }

      const glow = Math.max(0, params.glow);
      ctx.shadowColor = palette.body;
      ctx.shadowBlur = 1 + 8 * glow;

      for (let i = 0; i < dropPool.length; i++) {
        const d = dropPool[i];
        // Lazily fill the glyph trail to its `len`.
        while (d.glyphs.length < d.len) {
          d.glyphs.push(BINARY_EXTRA_GLYPHS[(Math.random() * BINARY_EXTRA_GLYPHS.length) | 0]);
        }
        const x = d.col * charW;
        // Spectrum-weighted column intensity — louder mid-spectrum = brighter.
        let specBoost = 1;
        if (audio.spectrum) {
          const sIdx = Math.floor((d.col / cols) * audio.spectrum.length);
          specBoost = 0.7 + (audio.spectrum[sIdx] / 255) * 0.6;
        }
        // Trail
        for (let k = 0; k < d.len; k++) {
          const yy = d.y - k * lineH;
          if (yy < -lineH || yy > H + lineH) continue;
          const t = k / d.len;
          // Lerp body→dim along the trail.
          const headFrac = 1 - t;
          const alpha = headFrac * specBoost;
          if (k === 0) {
            ctx.fillStyle = palette.head;
            ctx.globalAlpha = Math.min(1, 0.95 * alpha);
          } else {
            // RGB blend body→dim in linear space (cheap).
            const bH = parseInt(palette.body.slice(1, 3), 16);
            const bM = parseInt(palette.body.slice(3, 5), 16);
            const bL = parseInt(palette.body.slice(5, 7), 16);
            const dH = parseInt(palette.dim.slice(1, 3), 16);
            const dM = parseInt(palette.dim.slice(3, 5), 16);
            const dL = parseInt(palette.dim.slice(5, 7), 16);
            const r = Math.round(bH * headFrac + dH * t);
            const g = Math.round(bM * headFrac + dM * t);
            const b = Math.round(bL * headFrac + dL * t);
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.globalAlpha = Math.min(1, alpha);
          }
          ctx.fillText(d.glyphs[k], x, yy);
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    function renderDrift(audio, params) {
      // 3D depth-faded code lines — perspective projection, sorted back-to-front.
      paintBackground({ r: 4, g: 6, b: 14 }, 0.30 + audio.bands.bass * 0.15);

      const baseFontPx = fontSizeFor(params);
      ctx.textBaseline = 'middle';
      const cx = W / 2, cy = H / 2;
      // Sort by z descending (far first).
      driftLines.sort((a, b) => b.z - a.z);

      const glow = Math.max(0, params.glow);
      ctx.shadowColor = `rgba(180,200,255,${0.30 * glow})`;
      ctx.shadowBlur = 2 + 8 * glow;

      for (let i = 0; i < DRIFT_LINES; i++) {
        const ln = driftLines[i];
        if (ln.z < 0.04) continue;
        const persp = 0.5 / ln.z;
        const sx = cx + ln.x * W * persp;
        const sy = cy + ln.y * H * persp;
        const fontPx = Math.max(6, Math.round(baseFontPx * persp));
        ctx.font = `${fontPx}px ${FONT_FAMILY}`;
        const depthAlpha = Math.min(1, persp * 0.9);
        const hue = 200 + audio.bands.mids * 80;
        ctx.fillStyle = `hsla(${hue},75%,${65 + persp * 15}%,${depthAlpha})`;
        ctx.fillText(SOURCE_LINES[ln.idx].text, sx, sy);
      }
      ctx.textBaseline = 'top';
      ctx.shadowBlur = 0;
    }

    // Spectrum-mode color: position → hue (red bass, violet treble),
    // amplitude → brightness. Single allocation-free hsl string per call.
    function spectrumColor(xFrac, amp) {
      const hue = Math.round(xFrac * 280);
      const lum = Math.round(28 + amp * 60);
      return `hsl(${hue},92%,${lum}%)`;
    }

    function renderSpectrum(audio, params) {
      paintBackground({ r: 4, g: 6, b: 14 }, 0.34 + audio.bands.bass * 0.18);

      const fontPx = fontSizeFor(params);
      const lineH = Math.round(fontPx * 1.25);
      ctx.font = `${fontPx}px ${FONT_FAMILY}`;
      ctx.textBaseline = 'top';
      const xPad = 16;
      // Monospaced font: every char advances by the same width — measure once.
      const charW = ctx.measureText('M').width;
      const rows = Math.ceil(H / lineH) + 2;
      const sub = mainScroll.y % lineH;

      const spec = audio.spectrum;
      const specLen = spec ? spec.length : 0;
      const t = scratch.time;

      // No per-char shadow (cost would balloon at ~4k chars/frame). Glow comes
      // from amplitude-driven brightness in the chars themselves.
      ctx.shadowBlur = 0;

      for (let r = 0; r < rows; r++) {
        const lineIdx = lineAt(mainScroll.y, r, lineH);
        const yPx = r * lineH - sub;
        const text = SOURCE_LINES[lineIdx].text;
        if (!text) continue;

        let xOff = 0;
        if (params.glitch > 0 && Math.random() < params.glitch * 0.08) {
          xOff = (Math.random() - 0.5) * fontPx * 6;
        }
        if (params.glitch > 0 && Math.random() < params.glitch * 0.04) continue;

        let x = xPad + xOff;
        for (let ci = 0; ci < text.length; ci++) {
          if (x > W + 10) break;
          const ch = text.charCodeAt(ci);
          // Skip pure spaces — fillText still pays per call.
          if (ch === 32) { x += charW; continue; }
          const xFrac = x / W;
          let amp;
          if (spec) {
            const bin = Math.min(specLen - 1, Math.max(0, Math.floor(xFrac * specLen)));
            amp = spec[bin] / 255;
          } else {
            // Idle: gentle traveling rainbow wave so the screen still feels alive.
            amp = 0.45 + 0.35 * Math.sin(t * 0.8 - xFrac * 4.5);
          }
          ctx.fillStyle = spectrumColor(xFrac, amp);
          ctx.fillText(text[ci], x, yPx);
          x += charW;
        }
      }
    }

    function renderHeatmap(audio, params) {
      paintBackground({ r: 6, g: 6, b: 12 }, 0.32 + audio.bands.bass * 0.16);

      const fontPx = fontSizeFor(params);
      const lineH = Math.round(fontPx * 1.25);
      ctx.font = `${fontPx}px ${FONT_FAMILY}`;
      ctx.textBaseline = 'top';
      const xPad = 16;
      const rows = Math.ceil(H / lineH) + 2;
      const sub = mainScroll.y % lineH;
      const baseLine = Math.floor(mainScroll.y / lineH);

      const glow = Math.max(0, params.glow);
      const audioOn = !!audio.spectrum;
      const t = scratch.time;

      for (let r = 0; r < rows; r++) {
        const abs = baseLine + r;
        const lineIdx = lineAt(mainScroll.y, r, lineH);
        let snap = bandHistory.get(abs);
        if (!snap) {
          if (audioOn) {
            snap = { b: audio.bands.bass, m: audio.bands.mids, h: audio.bands.highs };
          } else {
            // Idle: paint each new line with a slow rainbow drift so the
            // waterfall isn't dead when audio is off.
            snap = {
              b: 0.35 + 0.30 * Math.sin(t * 0.7 + abs * 0.18),
              m: 0.35 + 0.30 * Math.sin(t * 0.9 + abs * 0.18 + 2.094),
              h: 0.35 + 0.30 * Math.sin(t * 1.1 + abs * 0.18 + 4.188),
            };
          }
          bandHistory.set(abs, snap);
        }
        const yPx = r * lineH - sub;
        // RGB direct from bands. Floor keeps text legible at silence;
        // ceiling caps blowout. Slight gain so soft audio still tints visibly.
        const rcol = Math.min(255, Math.max(45, Math.round(snap.b * 380)));
        const gcol = Math.min(255, Math.max(35, Math.round(snap.m * 380)));
        const bcol = Math.min(255, Math.max(70, Math.round(snap.h * 420)));
        ctx.shadowColor = `rgba(${rcol},${gcol},${bcol},0.55)`;
        ctx.shadowBlur = 2 + 10 * glow;
        ctx.fillStyle = `rgb(${rcol},${gcol},${bcol})`;

        let xOff = 0;
        if (params.glitch > 0 && Math.random() < params.glitch * 0.08) {
          xOff = (Math.random() - 0.5) * fontPx * 6;
        }
        if (params.glitch > 0 && Math.random() < params.glitch * 0.04) continue;

        ctx.fillText(SOURCE_LINES[lineIdx].text, xPad + xOff, yPx);
      }
      ctx.shadowBlur = 0;
      pruneBandHistory();
    }

    // ── Main update/render ───────────────────────────────────────────────
    const scratch = { audio: null, params: null, time: 0 };

    function update(field) {
      const audio = scaleAudio(field.audio, field.params.reactivity);
      scratch.audio = audio;
      scratch.params = field.params;
      scratch.time = field.time;

      const dt = field.dt;
      const speed = Math.max(0, field.params.scrollSpeed);
      const fontPx = fontSizeFor(field.params);
      const lineH = Math.round(fontPx * 1.25);
      // Pixels/second for the main stream.
      const px = lineH * speed * 6;
      mainScroll.y += px * dt;

      // Layer streams advance at distinct ratios so the rotated panels
      // visibly differ from the main stream.
      for (let li = 0; li < layerStates.length; li++) {
        layerStates[li].y += px * dt * layerStates[li].speed;
      }

      // Pose smoothing.
      const person = field.pose?.people?.[0];
      if (person && person.confidence > 0.3) {
        const targetX = (1.0 - person.head.x) * 2.0 - 1.0;  // [-1, +1], mirrored
        smoothHeadX += (targetX - smoothHeadX) * Math.min(1, dt * 3.0);
        smoothPresence += (1 - smoothPresence) * Math.min(1, dt * 2.0);
      } else {
        smoothHeadX  *= Math.pow(0.5, dt / 0.6);  // 600ms half-life back to 0
        smoothPresence *= Math.pow(0.5, dt / 1.2);
      }

      // Drift mode: advance Z toward viewer and reset when too close.
      if (field.params.mode === 'drift') {
        const driftSpeed = (1 + audio.bands.total * 1.4 + audio.beat.pulse * 0.6);
        for (let i = 0; i < DRIFT_LINES; i++) {
          const ln = driftLines[i];
          ln.z += ln.vz * dt * driftSpeed;
          if (ln.z < 0.04 || ln.z > 1.5) spawnDriftLine(i);
        }
      }

      // Binary mode: advance drops; spawn/recycle when off-screen.
      if (field.params.mode === 'binary') {
        const cols = Math.max(8, Math.ceil(W / Math.max(6, Math.round(fontPx * 0.62))));
        // Beat boost: kick speeds drops up briefly via beat.pulse.
        const speedMul = 1 + audio.beat.pulse * 1.6 + audio.bands.bass * 0.4;
        for (let i = dropPool.length - 1; i >= 0; i--) {
          const d = dropPool[i];
          d.y += d.speed * dt * speedMul;
          // Occasional glyph mutation for "shimmering" look.
          if (Math.random() < 0.08 + audio.bands.highs * 0.20) {
            const k = (Math.random() * d.glyphs.length) | 0;
            d.glyphs[k] = BINARY_EXTRA_GLYPHS[(Math.random() * BINARY_EXTRA_GLYPHS.length) | 0];
          }
          // Recycle when fully past the bottom.
          if (d.y - d.len * Math.round(fontPx * 1.05) > H) {
            d.col = Math.floor(Math.random() * cols);
            d.y = -Math.random() * H * 0.5;
            d.speed = 60 + Math.random() * 220;
            d.len = 6 + Math.floor(Math.random() * 18);
            d.glyphs.length = 0;
          }
        }
        // Trim pool if it grew above target.
        const target = Math.floor(cols * 0.7);
        if (dropPool.length > target) dropPool.length = target;
      }
    }

    function render() {
      const audio = scratch.audio;
      const params = scratch.params;
      if (!audio || !params) {
        ctx.fillStyle = '#05050d';
        ctx.fillRect(0, 0, W, H);
        return;
      }
      const mode = params.mode || 'greenscreen';
      switch (mode) {
        case 'greenscreen': renderGreenscreen(audio, params); break;
        case 'mono':        renderMono(audio, params);        break;
        case 'syntax':      renderSyntax(audio, params);      break;
        case 'binary':      renderBinary(audio, params);      break;
        case 'drift':       renderDrift(audio, params);       break;
        case 'spectrum':    renderSpectrum(audio, params);    break;
        case 'heatmap':     renderHeatmap(audio, params);     break;
        default:            renderGreenscreen(audio, params); break;
      }
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        // Layer parallax offsets are size-relative — recompute.
        layerStates[0].ofsX = -W * 0.08;
        layerStates[1].ofsX =  W * 0.12;
        layerStates[2].ofsX =  W * 0.04;
        layerStates[2].ofsY = -H * 0.05;
        // Drop pool is column-count dependent; let update() refill from empty.
        dropPool.length = 0;
      },
      update,
      render,
      dispose() {
        tokenCache.clear();
        bandHistory.clear();
        dropPool.length = 0;
      },
    };
  },
};
