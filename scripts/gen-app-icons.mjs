// gen-app-icons.mjs — per-app PWA icons for the standalone lab apps.
//
// The labs (qualia / setlist / mind) each install as their own standalone PWA
// (own manifest id + scope). Giving them the SAME voidstar mark makes them
// impossible to tell apart in a dock/taskbar/launcher, so this script emits a
// color-coded icon set per app: the shared brand emblem on a dark tile whose
// glow + accent ring is tinted to that app's accent.
//
//   public/icon-<app>-192.png            — PWA / apple-touch icon (dark tile)
//   public/icon-<app>-512.png            — PWA icon (dark tile)
//   public/icon-<app>-maskable-512.png   — maskable (emblem in central safe zone)
//
// Same emblem source + treatment as gen-logo-icons.mjs; only the accent differs.
//
//   node scripts/gen-app-icons.mjs

import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const SRC = 'src/assets/art/logos_alpha/voidstar_logo_cosmos_atom_0.png';
const TILE_BG = '#05050d'; // brand page bg / manifest theme dark

// Per-app accent — used for the background glow and the ring. Colors line up
// with each app's role: violet (qualia instrument), amber (setlist / stage),
// teal (mind / notes).
const APPS = [
  { id: 'qualia', accent: '#8b5cf6' },
  { id: 'setlist', accent: '#f59e0b' },
  { id: 'mind', accent: '#14b8a6' },
];

// The trimmed emblem, contained to `innerFrac` of an `size`² box, transparent bg.
async function emblem(size, innerFrac) {
  const inner = Math.round(size * innerFrac);
  return sharp(SRC)
    .trim({ threshold: 6 })
    .resize(inner, inner, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// Dark tile background: a soft radial accent glow over the brand black, plus an
// optional inset accent ring (skipped for maskable so an OS mask can't clip it).
async function tile(size, accent, { ring }) {
  const r = size / 2;
  const ringSvg = ring
    ? `<circle cx="${r}" cy="${r}" r="${size * 0.44}" fill="none"
              stroke="${accent}" stroke-width="${Math.max(2, size * 0.022)}"
              stroke-opacity="0.9"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <radialGradient id="g" cx="50%" cy="42%" r="65%">
        <stop offset="0%"  stop-color="${accent}" stop-opacity="0.34"/>
        <stop offset="55%" stop-color="${accent}" stop-opacity="0.10"/>
        <stop offset="100%" stop-color="${TILE_BG}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="${TILE_BG}"/>
    <rect width="${size}" height="${size}" fill="url(#g)"/>
    ${ringSvg}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function appIcon(size, accent, { innerFrac, ring }) {
  const [bg, mark] = await Promise.all([
    tile(size, accent, { ring }),
    emblem(size, innerFrac),
  ]);
  return sharp(bg).composite([{ input: mark, gravity: 'center' }]).png().toBuffer();
}

for (const { id, accent } of APPS) {
  await writeFile(`public/icon-${id}-192.png`, await appIcon(192, accent, { innerFrac: 0.72, ring: true }));
  await writeFile(`public/icon-${id}-512.png`, await appIcon(512, accent, { innerFrac: 0.72, ring: true }));
  await writeFile(`public/icon-${id}-maskable-512.png`, await appIcon(512, accent, { innerFrac: 0.52, ring: false }));
  console.log(`wrote public/icon-${id}-{192,512,maskable-512}.png (${accent})`);
}
