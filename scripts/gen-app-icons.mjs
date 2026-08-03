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
// Per-app accent + glyph, same family frame (void-dark ground, accent ring,
// white spark tick at the ring's top-right):
//   qualia  — the qualia eye: lids drawn as the two (void*) parens, a cyan
//             knob-arc iris, the void* spark as pupil — perception + code +
//             rig + star in one mark (the live coding station)
//   setlist — amber chart lines + diamond bullet (the stage list)
//   mind    — low-poly neuron constellation in a brain outline, glowing hub,
//             particles expanding toward the spark (the second brain)
//   tether  — the app's own ⌁ glyph as a fat gold sideways bolt (the remote)
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

// Open arc (gauge/knob) path — angles in degrees, y-down screen coords.
function arcPath(cx, cy, r, a0, a1) {
  const rad = d => (d * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
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
  // The qualia eye. Lids are the two parens of (void*) — top and bottom arcs
  // with round caps and a small gap at each corner so they still read as
  // ( ) — the iris is the rig's cyan knob arc (gap at the bottom), and the
  // pupil is the void* spark itself: seeing sound, through code.
  qualia({ accent }) {
    return `
      <path d="M 10 47 Q 50 3 90 47" fill="none" stroke="${accent}"
            stroke-width="9" stroke-linecap="round"/>
      <path d="M 10 53 Q 50 97 90 53" fill="none" stroke="${accent}"
            stroke-width="9" stroke-linecap="round" opacity="0.8"/>
      <circle cx="50" cy="50" r="18" fill="#22d3ee" opacity="0.18"/>
      <path d="${arcPath(50, 50, 15, 135, 405)}" fill="none" stroke="#22d3ee"
            stroke-width="7.5" stroke-linecap="round"/>
      <path d="${sparkPath(50, 50, 8.5)}" fill="#f8fafc"/>`;
  },
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
  // Tether: the app's own brand glyph — ⌁ U+2301 ELECTRIC ARROW, the sideways
  // bolt from "⌁ TETHER" / "⌁ sync" in the UI — as the sole focus on the
  // family base. Drawn as a path (not <text>) so it renders identically on
  // any build machine: two horizontal bars joined by a Z-diagonal, matching
  // DejaVu's cut of the glyph, in gold with a soft glow.
  tether() {
    return `
      <defs>
        <linearGradient id="gbolt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fde68a"/><stop offset="45%" stop-color="#fbbf24"/>
          <stop offset="100%" stop-color="#f59e0b"/>
        </linearGradient>
        <radialGradient id="gboltglow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.4"/>
          <stop offset="100%" stop-color="#fbbf24" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <ellipse cx="50" cy="50" rx="44" ry="26" fill="url(#gboltglow)"/>
      <path d="M 16 28 L 70 28 L 49 57 L 95 57 L 84 72 L 22 72 L 43 43 L 5 43 Z"
            fill="url(#gbolt)" stroke="${BG}" stroke-width="3" stroke-linejoin="round"/>`;
  },
};

// `scale` multiplies the frame's glyph box — the wide, flat glyphs (the eye,
// the sideways bolt) can afford to overfill the square budget a little.
const APPS = [
  { id: 'qualia', accent: '#8b5cf6', scale: 1.16 },
  { id: 'setlist', accent: '#f59e0b' },
  { id: 'mind', accent: '#14b8a6', scale: 1.06 },
  { id: 'tether', accent: '#8b5cf6', scale: 1.08 }, // violet ring like qualia; the bolt is the tell
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

for (const app of APPS) {
  await writeFile(`public/icon-${app.id}-192.png`, await png(192, app, ANY));
  await writeFile(`public/icon-${app.id}-512.png`, await png(512, app, ANY));
  await writeFile(`public/icon-${app.id}-maskable-512.png`, await png(512, app, MASK));
  console.log(`wrote public/icon-${app.id}-{192,512,maskable-512}.png (${app.accent})`);
}
