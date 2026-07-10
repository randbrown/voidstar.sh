// gen-logo-icons.mjs — build the site favicon + nav mark from the custom
// voidstar "cosmos atom" brand logo (the same emblem entangle.astro uses).
//
//   public/favicon.svg        — SVG wrapper embedding a dark-tile emblem PNG,
//                               so every page that links /favicon.svg gets the
//                               custom mark from a single file (no per-page edit)
//   public/favicon.ico        — 32px dark-tile emblem (PNG-encoded ICO) for the
//                               default /favicon.ico fetch
//   public/voidstar-mark.png  — the emblem on TRANSPARENT bg (natural aspect),
//                               for the translucent-glass topbar nav logo
//   public/icon-192.png       — PWA / apple-touch icon (dark tile)
//   public/icon-512.png       — PWA icon (dark tile)
//   public/icon-maskable-512  — PWA maskable icon (emblem kept inside the
//                               central safe zone; dark bg bleeds to the edge)
//
// The source in src/assets/art/logos_alpha/ is already emblem-on-transparent
// (the "_alpha" set), so we only trim + place it — no background keying.
//
//   node scripts/gen-logo-icons.mjs

import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const SRC = 'src/assets/art/logos_alpha/voidstar_logo_cosmos_atom_0.png';
const TILE_BG = '#05050d';   // brand page bg / manifest theme dark

// Emblem trimmed + contained in a padded dark square.
async function darkTile(size, innerFrac = 0.86, bg = TILE_BG) {
  const inner = Math.round(size * innerFrac);
  const mark = await sharp(SRC).trim({ threshold: 6 })
    .resize(inner, inner, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: mark, gravity: 'center' }])
    .png().toBuffer();
}

// Emblem trimmed on transparent bg, keeping its natural (wide) aspect.
async function transparentMark(heightPx) {
  return sharp(SRC).trim({ threshold: 6 })
    .resize({ height: heightPx, fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
}

// Wrap a single PNG as a (Vista+) PNG-encoded .ico.
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt16LE(1, 4);   // planes
  entry.writeUInt16LE(32, 6);  // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset = 6 + 16
  return Buffer.concat([header, entry, png]);
}

const embedded = await darkTile(128, 0.9);
const faviconSvg =
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <image width="64" height="64" href="data:image/png;base64,${embedded.toString('base64')}"/>
</svg>
`;
await writeFile('public/favicon.svg', faviconSvg);
console.log('wrote public/favicon.svg', `(${(faviconSvg.length / 1024).toFixed(1)}kb)`);

const ico32 = await darkTile(32, 0.9);
await writeFile('public/favicon.ico', pngToIco(ico32, 32));
console.log('wrote public/favicon.ico');

await writeFile('public/voidstar-mark.png', await transparentMark(256));
console.log('wrote public/voidstar-mark.png');

// PWA icons — regular icons match the favicon's dark-tile treatment; the
// maskable variant keeps the emblem inside the central safe zone (~0.58) so
// an OS mask (circle/squircle) never clips it, with the dark bg full-bleed.
await writeFile('public/icon-192.png', await darkTile(192, 0.82));
await writeFile('public/icon-512.png', await darkTile(512, 0.82));
await writeFile('public/icon-maskable-512.png', await darkTile(512, 0.58));
console.log('wrote public/icon-192.png, public/icon-512.png, public/icon-maskable-512.png');
