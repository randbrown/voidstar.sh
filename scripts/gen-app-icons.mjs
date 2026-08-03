// gen-app-icons.mjs — per-app PWA icons for the standalone lab apps.
//
// The labs (qualia / setlist / mind / tether) each install as their own
// standalone PWA (own manifest id + scope), so each needs an icon that reads
// at taskbar size AND sits comfortably next to native app icons. Two rules
// drive the design:
//
//  1. The `purpose:"any"` icons are a DISC on a transparent canvas — no
//     full-bleed square. Desktop surfaces (Windows taskbar, macOS dock,
//     browser tabs) render "any" icons as-is, so a square dark tile shows up
//     as a literal dark square next to shaped neighbors (Chrome's circle,
//     Spotify's disc…). A dark disc with the accent ring keeps the void-dark
//     brand ground (so the neon art survives light taskbars too) while
//     reading as a shaped glyph, not a tile.
//  2. Glyphs are deliberately LOW-DETAIL: one bold shape per app, thick
//     strokes (≥4% of the canvas), no fine mesh. Taskbars rasterize these at
//     16–48px, where thin lines alias away — earlier fine-grained art (the
//     poly-mesh brain especially) turned to mush. Sparse + chunky wins.
//
// The maskable icons stay full-bleed opaque (Android launchers and ChromeOS
// crop them to a circle/squircle themselves — transparency would come back
// as white), with the glyph held inside the central safe zone (r = 40%).
//
// Two icon pipelines share the output contract:
//   - setlist: generated SVG glyph in the family frame (void-dark ground,
//     accent ring, white spark tick at the ring's top-right) — amber chart
//     lines + diamond bullet (the stage list).
//   - qualia / tether / mind: RASTER artwork from
//     src/assets/art/app_icons/*_cutout.png (art on transparency) — the
//     crystal-lotus marks (petal burst around an orbital ellipse; star-eye
//     core for qualia, bolt for tether) and mind's neural orb (neon brain
//     in a void sphere with orbit nodes). The art is its own shaped glyph,
//     so the "any" icons are just the trimmed cutout padded on transparent;
//     the maskable variant recomposes it over the family's void-dark ground
//     inside the safe zone (the handoffs' own maskables sat on off-family
//     tiles and ran art out near the mask edge).
//
//   public/icon-<app>-192.png            — PWA icon (disc on transparent)
//   public/icon-<app>-512.png            — PWA icon (disc on transparent)
//   public/icon-<app>-maskable-512.png   — maskable (full-bleed, safe zone)
//
//   node scripts/gen-app-icons.mjs

import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const BG = '#05050d'; // brand void-dark ground / manifest theme dark

// Mix a hex color toward white (amt 0..1).
function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => Math.round(c + (255 - c) * amt));
  return `#${((ch[0] << 16) | (ch[1] << 8) | ch[2]).toString(16).padStart(6, '0')}`;
}

// Four-point star (the void* spark).
function sparkPath(cx, cy, r) {
  const w = r * 0.22;
  return `M ${cx} ${cy - r} Q ${cx + w} ${cy - w} ${cx + r} ${cy}
          Q ${cx + w} ${cy + w} ${cx} ${cy + r}
          Q ${cx - w} ${cy + w} ${cx - r} ${cy}
          Q ${cx - w} ${cy - w} ${cx} ${cy - r} Z`;
}

// Each glyph draws into a 100×100 box (the caller scales/places it) and gets
// the app's colors. Keep every stroke ≥4 units — that's the legibility floor.
const GLYPHS = {
  // Setlist: three fat rounded chart lines, diamond bullet on the opener.
  setlist({ accent, light }) {
    const bar = (x, y, w, o) =>
      `<rect x="${x}" y="${y}" width="${w}" height="14" rx="7" fill="url(#gbar)" opacity="${o}"/>`;
    return `
      <defs><linearGradient id="gbar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${light}"/><stop offset="100%" stop-color="${accent}"/>
      </linearGradient></defs>
      <rect x="11" y="18" width="16" height="16" rx="3.5" transform="rotate(45 19 26)" fill="${light}"/>
      ${bar(36, 19, 52, 1)}
      ${bar(13, 43, 62, 0.9)}
      ${bar(13, 67, 46, 0.78)}`;
  },
};

// `scale` multiplies the frame's glyph box (SVG apps). `src` switches the
// app to the raster art pipeline, where `accent` only tints the maskable
// ground wash — so it matches the artwork's palette, not the app UI accent
// (mind's art is indigo-neon even though the app runs teal).
const APPS = [
  { id: 'qualia', accent: '#8b5cf6', src: 'src/assets/art/app_icons/qualia_crystal_cutout.png' },
  { id: 'setlist', accent: '#f59e0b' },
  // mind is recolored from the source's cyan→magenta into the brand canon:
  // ghost green (CRT-phosphor — desaturated, value-lifted, ~140°) and
  // neural magenta (synapse pink-magenta, ~308°), split across a thin
  // 263–269° blend so the orbit's indigo stretch doesn't paint a third color.
  { id: 'mind', accent: '#4ade80', src: 'src/assets/art/app_icons/mind_neural_orb_cutout.png',
    recolor: { green: { from: 205, to: 140, keep: 0.22, sat: 0.68, val: 1.06 }, purple: { from: 300, to: 308, keep: 0.28, sat: 0.92 }, blend: [263, 269] } },
  { id: 'tether', accent: '#8b5cf6', src: 'src/assets/art/app_icons/tether_crystal_cutout.png' },
];

// Shared frame: accent wash + ring + glyph + spark. `disc:true` clips the
// ground to a circle on transparent (the "any" icons); false is full-bleed
// square (maskable). Geometry knobs pull everything inward for maskable.
function iconSvg(size, app, { disc, ringR, ringW, glyphFrac, glyphCY, spark }) {
  const { accent } = app;
  const light = lighten(accent, 0.55);
  const c = size / 2;
  const box = size * glyphFrac * (app.scale || 1);
  const gx = (size - box) / 2;
  const gy = size * glyphCY - box / 2;
  const ground = disc
    ? `<circle cx="${c}" cy="${c}" r="${size * 0.47}" fill="${BG}"/>
       <circle cx="${c}" cy="${c}" r="${size * 0.47}" fill="url(#wash)"/>`
    : `<rect width="${size}" height="${size}" fill="${BG}"/>
       <rect width="${size}" height="${size}" fill="url(#wash)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <radialGradient id="wash" cx="50%" cy="40%" r="72%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.38"/>
        <stop offset="55%" stop-color="${accent}" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    ${ground}
    <circle cx="${c}" cy="${c}" r="${size * ringR}" fill="none" stroke="${accent}"
            stroke-width="${size * ringW}" stroke-opacity="0.9"/>
    <g transform="translate(${gx} ${gy}) scale(${box / 100})">${GLYPHS[app.id]({ accent, light })}</g>
    <path d="${sparkPath(size * spark.x, size * spark.y, size * spark.r)}"
          fill="#f8fafc" opacity="0.5" transform="rotate(8 ${size * spark.x} ${size * spark.y})"/>
    <path d="${sparkPath(size * spark.x, size * spark.y, size * spark.r * 0.72)}" fill="#ffffff"/>
  </svg>`;
}

// Disc icons: ring hugs the disc edge, glyph fills the interior, spark rides
// the ring. Maskable: everything inside the r=0.4 safe zone.
const ANY = { disc: true, ringR: 0.43, ringW: 0.032, glyphFrac: 0.56, glyphCY: 0.52, spark: { x: 0.79, y: 0.21, r: 0.085 } };
const MASK = { disc: false, ringR: 0.34, ringW: 0.028, glyphFrac: 0.46, glyphCY: 0.515, spark: { x: 0.73, y: 0.27, r: 0.062 } };

async function png(size, app, opts) {
  return sharp(Buffer.from(iconSvg(size, app, opts))).png().toBuffer();
}

// Optional per-app hue remap for raster art, run on the pixels before
// compositing. Two "poles" pull the source hue range toward target hues
// (compressing the variation around each so shading depth survives), with a
// smoothstep blend between them. Saturation/value pass through, so the
// white-hot glow cores stay white. Angles are HSV degrees.
function remapHues(data, { green, purple, blend }) {
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.03) continue; // gray/white — nothing to shift
    let h;
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    const hg = green.to + (h - green.from) * green.keep;
    const hp = purple.to + (h - purple.from) * purple.keep;
    const t = smooth(blend[0], blend[1], h);
    let nh = (hg * (1 - t) + hp * t + 360) % 360;
    // HSV back to RGB — per-pole saturation trim keeps neon from going acid,
    // per-pole value lift lets a pole glow paler (the "ghost" quality)
    const sf = (green.sat ?? 1) * (1 - t) + (purple.sat ?? 1) * t;
    const vf = (green.val ?? 1) * (1 - t) + (purple.val ?? 1) * t;
    const s = (mx === 0 ? 0 : d / mx) * sf, v = Math.min(1, mx * vf);
    const c = v * s, x = c * (1 - Math.abs(((nh / 60) % 2) - 1)), m = v - c;
    const [r2, g2, b2] =
      nh < 60 ? [c, x, 0] : nh < 120 ? [x, c, 0] : nh < 180 ? [0, c, x]
      : nh < 240 ? [0, x, c] : nh < 300 ? [x, 0, c] : [c, 0, x];
    data[i] = Math.round((r2 + m) * 255);
    data[i + 1] = Math.round((g2 + m) * 255);
    data[i + 2] = Math.round((b2 + m) * 255);
  }
}

// Raster pipeline (crystal-art apps). "any": the trimmed cutout on
// transparent, padded a touch so it sits at the same optical size as
// neighboring OS icons. Maskable: the cutout held inside the r=40% safe
// zone over the family's void-dark ground + accent wash, full-bleed opaque.
async function rasterIcon(size, app, variant) {
  const inner = Math.round(size * (variant === 'any' ? 0.94 : 0.76));
  let art = await sharp(app.src).trim({ threshold: 8 })
    .resize(inner, inner, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  if (app.recolor) {
    const { data, info } = await sharp(art).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    remapHues(data, app.recolor);
    art = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  }
  const ground = variant === 'any'
    ? { create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }
    : Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
        <defs><radialGradient id="wash" cx="50%" cy="42%" r="72%">
          <stop offset="0%" stop-color="${app.accent}" stop-opacity="0.3"/>
          <stop offset="60%" stop-color="${app.accent}" stop-opacity="0.09"/>
          <stop offset="100%" stop-color="${app.accent}" stop-opacity="0"/>
        </radialGradient></defs>
        <rect width="${size}" height="${size}" fill="${BG}"/>
        <rect width="${size}" height="${size}" fill="url(#wash)"/>
      </svg>`);
  return sharp(variant === 'any' ? ground : { create: { width: size, height: size, channels: 4, background: BG } })
    .composite(variant === 'any'
      ? [{ input: art, gravity: 'center' }]
      : [{ input: ground, top: 0, left: 0 }, { input: art, gravity: 'center' }])
    .png().toBuffer();
}

for (const app of APPS) {
  const make = (size, variant) =>
    app.src ? rasterIcon(size, app, variant) : png(size, app, variant === 'any' ? ANY : MASK);
  await writeFile(`public/icon-${app.id}-192.png`, await make(192, 'any'));
  await writeFile(`public/icon-${app.id}-512.png`, await make(512, 'any'));
  await writeFile(`public/icon-${app.id}-maskable-512.png`, await make(512, 'mask'));
  console.log(`wrote public/icon-${app.id}-{192,512,maskable-512}.png (${app.accent}${app.src ? ' · raster' : ''})`);
}
