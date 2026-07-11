// gen-app-icons.mjs — per-app PWA icons for the standalone lab apps.
//
// The labs (qualia / setlist / mind) each install as their own standalone PWA
// (own manifest id + scope). Giving them the SAME voidstar mark makes them
// impossible to tell apart in a dock/taskbar/launcher — and a launcher like
// Nova trims the tile edges, clipping the thin accent ring so only a faint
// glow survives. So each icon now leads with a big monogram letter (Q / S / M)
// in the app's accent, over an accent-washed dark tile, with the shared
// voidstar emblem as a small brand tick above it. The letter + fill read
// instantly even when the edges (and the ring) are cropped away.
//
//   public/icon-<app>-192.png            — PWA / apple-touch icon (dark tile)
//   public/icon-<app>-512.png            — PWA icon (dark tile)
//   public/icon-<app>-maskable-512.png   — maskable (mark kept in the safe zone)
//
//   node scripts/gen-app-icons.mjs

import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const SRC = 'src/assets/art/logos_alpha/voidstar_logo_cosmos_atom_0.png';
const TILE_BG = '#05050d'; // brand page bg / manifest theme dark

// Per-app accent + monogram. Colors line up with each app's role: violet
// (qualia instrument), amber (setlist / stage), teal (mind / notes).
const APPS = [
  { id: 'qualia', accent: '#8b5cf6', letter: 'Q' },
  { id: 'setlist', accent: '#f59e0b', letter: 'S' },
  { id: 'mind', accent: '#14b8a6', letter: 'M' },
];

// Mix a hex color toward white (amt 0..1) — used for the letter's top highlight.
function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => Math.round(c + (255 - c) * amt));
  return `#${((ch[0] << 16) | (ch[1] << 8) | ch[2]).toString(16).padStart(6, '0')}`;
}

// The trimmed emblem as a small transparent PNG, base64 for inline SVG embed
// (kept downscaled so the SVG string stays light).
async function emblemDataUri() {
  const buf = await sharp(SRC)
    .trim({ threshold: 6 })
    .resize(256, 256, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// One full icon face as an SVG: dark tile + radial accent wash + optional ring
// + emblem tick (top) + glowing monogram letter (center).
function faceSvg(size, { accent, letter }, emblemUri, { ring, letterFrac, letterCY, emblemFrac, emblemCY }) {
  const r = size / 2;
  const light = lighten(accent, 0.55);
  const fontSize = size * letterFrac;
  const baseline = size * letterCY + fontSize * 0.35; // vertically center the cap-height glyph
  const box = size * emblemFrac;
  const ex = (size - box) / 2;
  const ey = size * emblemCY - box / 2;

  const ringSvg = ring
    ? `<circle cx="${r}" cy="${r}" r="${size * 0.44}" fill="none"
              stroke="${accent}" stroke-width="${Math.max(2, size * 0.02)}" stroke-opacity="0.85"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <radialGradient id="glow" cx="50%" cy="40%" r="72%">
        <stop offset="0%"   stop-color="${accent}" stop-opacity="0.44"/>
        <stop offset="55%"  stop-color="${accent}" stop-opacity="0.13"/>
        <stop offset="100%" stop-color="${TILE_BG}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="letter" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${light}"/>
        <stop offset="100%" stop-color="${accent}"/>
      </linearGradient>
      <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="${size * 0.018}"/>
      </filter>
    </defs>
    <rect width="${size}" height="${size}" fill="${TILE_BG}"/>
    <rect width="${size}" height="${size}" fill="url(#glow)"/>
    ${ringSvg}
    <image href="${emblemUri}" x="${ex}" y="${ey}" width="${box}" height="${box}"
           preserveAspectRatio="xMidYMid meet" opacity="0.62"/>
    <text x="${r}" y="${baseline}" text-anchor="middle"
          font-family="'DejaVu Sans','Liberation Sans','Arial',sans-serif" font-weight="700"
          font-size="${fontSize}" fill="${accent}" opacity="0.55" filter="url(#soft)">${letter}</text>
    <text x="${r}" y="${baseline}" text-anchor="middle"
          font-family="'DejaVu Sans','Liberation Sans','Arial',sans-serif" font-weight="700"
          font-size="${fontSize}" fill="url(#letter)">${letter}</text>
  </svg>`;
}

async function appIcon(size, app, emblemUri, opts) {
  const svg = faceSvg(size, app, emblemUri, opts);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const emblemUri = await emblemDataUri();

// Full icon: ring + emblem tick up top + big letter. Maskable: no ring, and
// everything pulled into the central safe zone so an OS mask never clips it.
const FULL = { ring: true, letterFrac: 0.5, letterCY: 0.64, emblemFrac: 0.34, emblemCY: 0.29 };
const MASK = { ring: false, letterFrac: 0.4, letterCY: 0.63, emblemFrac: 0.26, emblemCY: 0.37 };

for (const app of APPS) {
  await writeFile(`public/icon-${app.id}-192.png`, await appIcon(192, app, emblemUri, FULL));
  await writeFile(`public/icon-${app.id}-512.png`, await appIcon(512, app, emblemUri, FULL));
  await writeFile(`public/icon-${app.id}-maskable-512.png`, await appIcon(512, app, emblemUri, MASK));
  console.log(`wrote public/icon-${app.id}-{192,512,maskable-512}.png (${app.accent} · ${app.letter})`);
}
