// gen-app-icons.mjs — per-app PWA icons for the standalone lab apps.
//
// The labs (qualia / setlist / mind / tether) each install as their own
// standalone PWA (own manifest id + scope). All four icons are now ARTWORK
// in a shared cosmic language — a void orb / crystal mark with an orbital
// ellipse, glowing nodes, and star dust — sourced two ways:
//
//   - qualia / tether / mind: raster cutouts (art on transparency) in
//     src/assets/art/app_icons/ — the crystal-lotus marks (star-eye core
//     for qualia, bolt for tether) and mind's neural-orb brain. mind is
//     hue-remapped to the brand's ghost green + neural magenta (remapHues).
//   - setlist: generated SVG art in the same language (setlistArt) — a
//     void orb with the glowing chart lines + diamond bullet inside and an
//     accretion-disk orbit (gold → plasma orange → neural magenta).
//
// Output contract, per app:
//   - "any" (192/512): the trimmed art on TRANSPARENT canvas, padded a
//     touch for optical size. Desktop surfaces (Windows taskbar, macOS
//     dock, tabs) render these as-is, so the art is its own shaped glyph —
//     no square tile.
//   - maskable (512): full-bleed opaque — the art held inside the r=40%
//     safe zone over the void-dark ground + accent wash (Android/ChromeOS
//     crop the icon themselves; transparency would come back as white).
//
//   node scripts/gen-app-icons.mjs

import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const BG = '#05050d'; // brand void-dark ground / manifest theme dark

// Four-point star (the void* spark).
function sparkPath(cx, cy, r) {
  const w = r * 0.22;
  return `M ${cx} ${cy - r} Q ${cx + w} ${cy - w} ${cx + r} ${cy}
          Q ${cx + w} ${cy + w} ${cx} ${cy + r}
          Q ${cx - w} ${cy + w} ${cx - r} ${cy}
          Q ${cx - w} ${cy - w} ${cx} ${cy - r} Z`;
}

// Setlist artwork, drawn in the family language on a 1000×1000 canvas:
// a warm void orb holding the setlist itself — three glowing chart lines
// with the diamond bullet — wrapped by a tilted orbital ellipse running the
// accretion-disk gradient (gold → plasma orange → neural magenta) with a
// glow node in each color. Star dust + a void* spark finish the sky.
function setlistArt() {
  const node = (x, y, r, color) => `
    <circle cx="${x}" cy="${y}" r="${r * 2.4}" fill="${color}" opacity="0.42" filter="url(#bMed)"/>
    <circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>
    <circle cx="${x}" cy="${y}" r="${r * 0.52}" fill="#fffbeb"/>`;
  const bar = (x, y, w, o) => `
    <rect x="${x}" y="${y}" width="${w}" height="88" rx="44" fill="#f59e0b"
          opacity="${o * 0.75}" filter="url(#bMed)"/>
    <rect x="${x}" y="${y}" width="${w}" height="88" rx="44" fill="url(#gBar)" opacity="${o}"/>`;
  const dust = [
    [640, 215, 4, '#ffffff', 0.9], [712, 262, 2.5, '#fde68a', 0.8], [330, 238, 3, '#ffffff', 0.5],
    [762, 424, 2.5, '#ffffff', 0.5], [282, 652, 2.5, '#fde68a', 0.6], [592, 762, 3, '#ffffff', 0.45],
    [424, 180, 2, '#ffffff', 0.6], [820, 330, 2, '#fde68a', 0.55],
    [214, 306, 2.5, '#f0abfc', 0.7], [742, 648, 2.5, '#f0abfc', 0.6],
  ].map(([x, y, r, c, o]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" opacity="${o}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">
  <defs>
    <radialGradient id="gOrb" cx="46%" cy="38%" r="75%">
      <stop offset="0%" stop-color="#2a1704"/>
      <stop offset="45%" stop-color="#150d08"/>
      <stop offset="100%" stop-color="#07060f"/>
    </radialGradient>
    <linearGradient id="gOrbit" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#f59e0b"/>
      <stop offset="42%" stop-color="#fb923c"/>
      <stop offset="82%" stop-color="#e879f9"/>
      <stop offset="100%" stop-color="#f0abfc"/>
    </linearGradient>
    <linearGradient id="gBar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fef3c7"/>
      <stop offset="42%" stop-color="#fcd34d"/>
      <stop offset="100%" stop-color="#f59e0b"/>
    </linearGradient>
    <linearGradient id="gDiamond" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fffbeb"/>
      <stop offset="100%" stop-color="#fbbf24"/>
    </linearGradient>
    <filter id="bSoft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="bMed" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="20"/></filter>
  </defs>

  <!-- orbit, back (upper) half — drawn first so the orb occludes it -->
  <g transform="rotate(-18 500 500)">
    <ellipse cx="500" cy="505" rx="470" ry="185" fill="none" stroke="url(#gOrbit)"
             stroke-width="26" opacity="0.5" filter="url(#bSoft)"/>
    <ellipse cx="500" cy="505" rx="470" ry="185" fill="none" stroke="url(#gOrbit)" stroke-width="13"/>
    ${node(48, 452, 16, '#fbbf24')}
    ${node(957, 455, 20, '#e879f9')}
  </g>

  <!-- the void orb -->
  <circle cx="500" cy="510" r="400" fill="url(#gOrb)"/>
  <circle cx="500" cy="510" r="397" fill="none" stroke="#fbbf24" stroke-opacity="0.28" stroke-width="4"/>

  <!-- star dust + the void* spark -->
  ${dust}
  <path d="${sparkPath(695, 238, 46)}" fill="#fbbf24" opacity="0.65" filter="url(#bSoft)"/>
  <path d="${sparkPath(695, 238, 32)}" fill="#fffbeb"/>

  <!-- the setlist: diamond bullet + three glowing chart lines -->
  <rect x="241" y="357" width="92" height="92" rx="18" transform="rotate(45 287 403)"
        fill="#f59e0b" opacity="0.8" filter="url(#bMed)"/>
  <rect x="241" y="357" width="92" height="92" rx="18" transform="rotate(45 287 403)"
        fill="url(#gDiamond)"/>
  ${bar(372, 360, 350, 1)}
  ${bar(240, 488, 430, 0.92)}
  ${bar(240, 616, 330, 0.8)}

  <!-- orbit, front (lower) half — over the orb, with the plasma node -->
  <g transform="rotate(-18 500 500)">
    <path d="M 30 505 A 470 185 0 0 0 970 505" fill="none" stroke="url(#gOrbit)"
           stroke-width="26" opacity="0.5" filter="url(#bSoft)"/>
    <path d="M 30 505 A 470 185 0 0 0 970 505" fill="none" stroke="url(#gOrbit)" stroke-width="13"/>
    ${node(308, 664, 14, '#fb923c')}
  </g>
</svg>`;
}

// Optional generated over/under orbit wrapped AROUND raster art — the same
// depth trick setlist's art does natively: the full ellipse (+ back nodes)
// is composited UNDER the art so the crystal/orb occludes it, then the
// front (lower) arc + near nodes go OVER the top. Config: tilt (deg),
// gradient stops, and nodes as {a: degrees on the ellipse, r: radius as a
// fraction of the canvas, col}. Runs at the art's native resolution.
async function composeOrbit(artBuf, cfg) {
  const meta = await sharp(artBuf).metadata();
  const W = Math.round(Math.max(meta.width, meta.height) * (cfg.grow ?? 1.16));
  const c = W / 2, rx = W * 0.465, ry = rx * (cfg.squash ?? 0.36), sw = W * 0.013;
  const stops = cfg.stops
    .map((s, i) => `<stop offset="${Math.round((i * 100) / (cfg.stops.length - 1))}%" stop-color="${s}"/>`)
    .join('');
  const node = ({ a, r, col }) => {
    const x = c + rx * Math.cos((a * Math.PI) / 180), y = c + ry * Math.sin((a * Math.PI) / 180);
    const R = r * W;
    return `<circle cx="${x}" cy="${y}" r="${R * 2.4}" fill="${col}" opacity="0.42" filter="url(#nb)"/>
            <circle cx="${x}" cy="${y}" r="${R}" fill="${col}"/>
            <circle cx="${x}" cy="${y}" r="${R * 0.52}" fill="#ffffff"/>`;
  };
  const svg = (inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}">
    <defs>
      <linearGradient id="og" x1="0" y1="1" x2="1" y2="0">${stops}</linearGradient>
      <filter id="ob" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${W * 0.009}"/></filter>
      <filter id="nb" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="${W * 0.02}"/></filter>
    </defs>
    <g transform="rotate(${cfg.tilt} ${c} ${c})">${inner}</g>
  </svg>`);
  const ellipse = (w, extra) =>
    `<ellipse cx="${c}" cy="${c}" rx="${rx}" ry="${ry}" fill="none" stroke="url(#og)" stroke-width="${w}" ${extra}/>`;
  const arc = (w, extra) =>
    `<path d="M ${c - rx} ${c} A ${rx} ${ry} 0 0 0 ${c + rx} ${c}" fill="none" stroke="url(#og)" stroke-width="${w}" ${extra}/>`;
  const back = svg(`${ellipse(sw * 2, 'opacity="0.5" filter="url(#ob)"')}${ellipse(sw, '')}
    ${(cfg.back || []).map(node).join('')}`);
  const front = svg(`${arc(sw * 2, 'opacity="0.5" filter="url(#ob)"')}${arc(sw, '')}
    ${(cfg.front || []).map(node).join('')}`);
  return sharp({ create: { width: W, height: W, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: back, top: 0, left: 0 }, { input: artBuf, gravity: 'center' }, { input: front, top: 0, left: 0 }])
    .png().toBuffer();
}

// Optional per-app hue remap for raster art, run on the pixels before
// compositing. Two "poles" pull the source hue range toward target hues
// (compressing the variation around each so shading depth survives), with a
// smoothstep blend between them. Near-gray pixels pass through, so the
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

// `src` points at raster art; `svg` builds art as an SVG string. `accent`
// only tints the maskable ground wash, so it tracks the ARTWORK's palette,
// not the app UI accent (mind's art runs green/magenta though the app UI is
// teal).
const APPS = [
  { id: 'qualia', accent: '#8b5cf6', src: 'src/assets/art/app_icons/qualia_crystal_cutout.png',
    orbit: { tilt: 30, stops: ['#22d3ee', '#818cf8', '#e879f9'],
             back: [{ a: 197, r: 0.015, col: '#22d3ee' }],
             front: [{ a: 118, r: 0.014, col: '#e879f9' }] } },
  { id: 'setlist', accent: '#f59e0b', svg: setlistArt },
  // mind is recolored from the source's cyan→magenta into the brand canon:
  // ghost green (CRT-phosphor — desaturated, value-lifted, ~140°) and
  // neural magenta (synapse pink-magenta, ~308°), split across a thin
  // 263–269° blend so the orbit's indigo stretch doesn't paint a third color.
  { id: 'mind', accent: '#4ade80', src: 'src/assets/art/app_icons/mind_neural_orb_cutout.png',
    recolor: { green: { from: 205, to: 140, keep: 0.22, sat: 0.68, val: 1.06 }, purple: { from: 300, to: 308, keep: 0.28, sat: 0.92 }, blend: [263, 269] },
    // the sphere art nearly fills its trim box, so the orbit canvas grows
    // further for clearance (the crystal arts are star-shaped and leave
    // their own room)
    orbit: { tilt: 18, grow: 1.34, stops: ['#4ade80', '#a7f3d0', '#f0abfc'],
             back: [{ a: 345, r: 0.014, col: '#f0abfc' }],
             front: [{ a: 65, r: 0.012, col: '#4ade80' }] } },
  { id: 'tether', accent: '#8b5cf6', src: 'src/assets/art/app_icons/tether_crystal_cutout.png',
    orbit: { tilt: -22, stops: ['#8b5cf6', '#a78bfa', '#22d3ee'],
             back: [{ a: 205, r: 0.015, col: '#a78bfa' }],
             front: [{ a: 60, r: 0.014, col: '#22d3ee' }] } },
];

// "any": the trimmed art on transparent, padded a touch so it sits at the
// same optical size as neighboring OS icons. Maskable: the art held inside
// the r=40% safe zone over the void-dark ground + accent wash, full-bleed.
async function appIcon(size, app, variant) {
  const inner = Math.round(size * (variant === 'any' ? 0.94 : 0.76));
  let art = await sharp(app.src ?? Buffer.from(app.svg())).trim({ threshold: 8 }).png().toBuffer();
  if (app.recolor) {
    const { data, info } = await sharp(art).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    remapHues(data, app.recolor);
    art = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  }
  if (app.orbit) art = await composeOrbit(art, app.orbit);
  art = await sharp(art).trim({ threshold: 8 })
    .resize(inner, inner, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  if (variant === 'any') {
    return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: art, gravity: 'center' }]).png().toBuffer();
  }
  const ground = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs><radialGradient id="wash" cx="50%" cy="42%" r="72%">
        <stop offset="0%" stop-color="${app.accent}" stop-opacity="0.3"/>
        <stop offset="60%" stop-color="${app.accent}" stop-opacity="0.09"/>
        <stop offset="100%" stop-color="${app.accent}" stop-opacity="0"/>
      </radialGradient></defs>
      <rect width="${size}" height="${size}" fill="${BG}"/>
      <rect width="${size}" height="${size}" fill="url(#wash)"/>
    </svg>`);
  return sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: ground, top: 0, left: 0 }, { input: art, gravity: 'center' }])
    .png().toBuffer();
}

for (const app of APPS) {
  await writeFile(`public/icon-${app.id}-192.png`, await appIcon(192, app, 'any'));
  await writeFile(`public/icon-${app.id}-512.png`, await appIcon(512, app, 'any'));
  await writeFile(`public/icon-${app.id}-maskable-512.png`, await appIcon(512, app, 'mask'));
  console.log(`wrote public/icon-${app.id}-{192,512,maskable-512}.png (${app.accent} · ${app.src ? 'raster' : 'svg'})`);
}
