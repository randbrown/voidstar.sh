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
//   - setlist / mind: generated SVG glyphs in the family frame (void-dark
//     ground, accent ring, white spark tick at the ring's top-right) —
//     amber chart lines + diamond bullet (the stage list); teal low-poly
//     neuron constellation with a glowing hub (the second brain).
//   - qualia / tether: RASTER artwork — the crystal-lotus marks (petal burst
//     around an orbital ellipse; star-eye core for qualia, bolt for tether),
//     from src/assets/art/app_icons/*_cutout.png (art on transparency).
//     The art is its own shaped glyph, so the "any" icons are just the
//     trimmed cutout padded on transparent; the maskable variant recomposes
//     it over the family's void-dark ground inside the safe zone (the
//     handoff's own maskables sat on a navy tile and ran petal tips out
//     near the mask edge).
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
  // Mind: the neuron constellation, rebuilt for icon scale. Same idea as the
  // original poly-mesh brain — a node web whose PERIMETER traces a side
  // profile (crown, forehead, temporal lobe, the cerebellum notch) with a
  // glowing mind-map hub inside — but an order of magnitude bolder: ~a dozen
  // nodes instead of dozens, 4-unit edges instead of hairlines, and a faint
  // polygon fill so the small sizes keep some mass. Particles still stream
  // off the crown toward the spark — the mind expanding into the void.
  mind({ accent, light }) {
    const P = [
      [17, 45], [24, 27], [44, 15], [66, 17], [82, 30], [84, 47], // back → crown → front
      [74, 61], [58, 67], [46, 60], [36, 69], [23, 61],           // temporal → notch → cerebellum
    ];
    const H = [49, 41]; // hub
    const ring = P.map(p => p.join(',')).join(' ');
    const spokes = [0, 1, 3, 5, 7, 8]
      .map(i => `<line x1="${H[0]}" y1="${H[1]}" x2="${P[i][0]}" y2="${P[i][1]}"
                       stroke="${accent}" stroke-width="4" stroke-linecap="round" opacity="0.7"/>`)
      .join('');
    const nodes = P
      .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 === 0 ? 5 : 4}"
                                   fill="${i % 3 === 0 ? light : accent}"/>`)
      .join('');
    return `
      <polygon points="${ring}" fill="${accent}" fill-opacity="0.15" stroke="${accent}"
               stroke-width="4.5" stroke-linejoin="round"/>
      ${spokes}${nodes}
      <circle cx="${H[0]}" cy="${H[1]}" r="13" fill="#22d3ee" opacity="0.35"/>
      <circle cx="${H[0]}" cy="${H[1]}" r="7" fill="#eafffb"/>
      <circle cx="79" cy="11" r="3.4" fill="${light}" opacity="0.9"/>
      <circle cx="89" cy="4" r="2.5" fill="${light}" opacity="0.7"/>`;
  },
};

// `scale` multiplies the frame's glyph box (SVG apps). `src` switches the
// app to the raster crystal-art pipeline.
const APPS = [
  { id: 'qualia', accent: '#8b5cf6', src: 'src/assets/art/app_icons/qualia_crystal_cutout.png' },
  { id: 'setlist', accent: '#f59e0b' },
  { id: 'mind', accent: '#14b8a6', scale: 1.06 },
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

// Raster pipeline (crystal-art apps). "any": the trimmed cutout on
// transparent, padded a touch so it sits at the same optical size as
// neighboring OS icons. Maskable: the cutout held inside the r=40% safe
// zone over the family's void-dark ground + accent wash, full-bleed opaque.
async function rasterIcon(size, app, variant) {
  const inner = Math.round(size * (variant === 'any' ? 0.94 : 0.76));
  const art = await sharp(app.src).trim({ threshold: 8 })
    .resize(inner, inner, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
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
