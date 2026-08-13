// No Man's Land 2 — the second KMA "No Man's Land" quale, built as a real
// navigable 3D borderland instead of quale 1's painted strip. A high-desert
// valley at deep dusk: teal sky burning down to an orange horizon, mesa
// buttes at the rim, and at the center the two Harrison-Mayes-style folk
// monuments from the exhibit — the "JESUS IS COMING SOON" heart totem and
// the "GET RIGHT WITH GOD" cross — modeled as first-class concrete citizens
// with carved text and beacon bulb-holes. Over the eastern half the same
// terrain phases into its own wireframe ghost (the land re-rendered as
// data), monospace glyphs rise off it like sparks of thought, a signal
// beam stands between the monuments, and a cratered blood moon rotates
// slowly inside a set of thin orbital rings. The space between the two
// worlds — bible-belt roadside faith and the push past every boundary into
// space — IS the subject: the carved gospel letters themselves crossfade
// from punched-out shadow to luminous signal as the tech layer wakes.
// Five hand-built camera walks share the one world and auto-phase strolls
// them as chapters. Museum-calm: audio moves color and light, never
// geometry; the camera always glides.
//
// Audio map (color/light only):
//   audio.bass       → totem warmth + moon emissive breath   (declarative on
//                      `totemLight` / `moonGlow`; inline breathing on both)
//   audio.mids       → data-grid shimmer + glyph sway        (declarative on
//                      `signal`; inline smoothed uniform)
//   audio.highs      → star glints                           (declarative on
//                      `starLevel`; inline glint envelope on the sparkle set)
//   audio.rms        → signal-beam luminance                 (inline)
//   audio.beat       → a pulse of light traveling up the beam + a scan wave
//                      down the grid + satellite glints (rate-limited, with
//                      autonomous fallbacks so silence still breathes)
//
// Pose map:
//   pose.head.x / headPitch → camera look drift (heavily smoothed — the
//                             performer leans and the whole valley pans)
//   pose.wristMidY          → hands raised lifts the signal: beam, grid and
//                             stars swell together (plus crowd.rise when the
//                             audience is entangled)
//
// Modeled elements (each built by its own design function below):
//   buildTerrain      — dune valley + mesa buttes, vertex-colored rock/sand
//   buildHeartTotem   — heart tablet on a post, "JESUS IS / COMING / SOON"
//   buildCrossTotem   — roadside cross, "GET RIGHT" / "WITH GOD" + bulb holes
//   buildMoon         — cratered, bump-mapped, slowly rotating blood moon
//   buildStars        — twinkle + slow phase-in/out + audio glint starfield
//   buildGrid         — the terrain's wireframe data-ghost (east side)
//   buildGlyphField   — rising monospace glyphs (the virtual space of ideas)
//   buildBeam         — the transmission column between the monuments
//   buildTitleStars   — the poster's scattered NO MAN'S LAND sky letters

import {
  Scene, PerspectiveCamera, Group, Mesh, Points, LineSegments, LineLoop,
  Sprite, InstancedMesh,
  BufferGeometry, BufferAttribute, PlaneGeometry, SphereGeometry,
  ExtrudeGeometry, Shape, BoxGeometry, DodecahedronGeometry,
  MeshStandardMaterial, ShaderMaterial, SpriteMaterial, LineBasicMaterial,
  CanvasTexture, Color, Vector2, Vector3, Vector4, Matrix4, Quaternion,
  Euler, FogExp2, HemisphereLight, DirectionalLight, PointLight,
  AdditiveBlending, DoubleSide, BackSide, RepeatWrapping,
  LinearSRGBColorSpace,
} from 'three';
import { disposeObject3D } from '../three-host.js';
import { scaleAudio } from '../field.js';

// ── World constants ────────────────────────────────────────────────────
const TERRAIN_SIZE = 380;
const TERRAIN_SEG  = 148;
const MOON_POS     = new Vector3(55, 105, -330);
const MOON_R       = 26;
const N_STARS      = 2600;
const N_GLYPHS     = 650;
const GRID_N       = 64;          // grid samples per axis (east-side region)

const CAMERAS  = ['procession', 'monuments', 'moonwatch', 'threshold', 'ascension'];
const PALETTES = ['kma', 'bloodmoon', 'verdigris', 'hymnal', 'static'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (e0, e1, v) => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ── CPU value noise (matches quale 1's house style) ────────────────────
const fractJs = (v) => v - Math.floor(v);
function hash2(px, py) {
  let x = fractJs(px * 123.34), y = fractJs(py * 456.21);
  const d = x * (x + 45.32) + y * (y + 45.32);
  x += d; y += d;
  return fractJs(x * y);
}
function vnoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy * (1 - ux) + (d - b) * ux * uy;
}
function fbm2(x, y, oct) {
  let v = 0, amp = 0.5;
  for (let i = 0; i < oct; i++) { v += amp * vnoise2(x, y); x = x * 2.07 + 11.3; y = y * 2.07 - 7.1; amp *= 0.5; }
  return v;
}

// ── Terrain heightfield — dune valley, flat gathering ground, mesa ring.
// The ring leaves the corridor toward the moon (northeast) open.
const BUTTES = [
  { x: -120, z: -105, r: 34, h: 34 },
  { x: -158, z:   12, r: 42, h: 26 },
  { x:  -78, z: -162, r: 30, h: 40 },
  { x:  148, z:  -78, r: 38, h: 30 },
  { x:  122, z:   96, r: 30, h: 22 },
  { x:  -62, z:  152, r: 40, h: 24 },
  { x:   42, z: -178, r: 26, h: 36 },
  { x:  176, z: -162, r: 46, h: 44 },
];
function terrainHeight(x, z) {
  let h = fbm2(x * 0.011 + 7.3, z * 0.011 - 2.1, 4) * 5.2
        + fbm2(x * 0.05 + 1.7, z * 0.05 + 9.4, 2) * 0.9
        - 3.0;
  // flat gathering ground around the monuments
  const d0 = Math.hypot(x, z + 2);
  h *= 0.18 + 0.82 * sstep(16, 60, d0);
  // mesas: steep noise-wobbled walls, near-flat caps
  for (let i = 0; i < BUTTES.length; i++) {
    const b = BUTTES[i];
    const wob = 1 + (vnoise2(x * 0.05 + i * 9.1, z * 0.05 - i * 4.7) - 0.5) * 0.5;
    const d = Math.hypot(x - b.x, z - b.z) * wob;
    const t = 1 - clamp01((d - b.r * 0.55) / (b.r * 0.8));
    if (t > 0) {
      const cap = 1 + (vnoise2(x * 0.03 + i * 3.3, z * 0.03 + i * 7.7) - 0.5) * 0.22;
      h += b.h * cap * (sstep(0.25, 0.62, t) * 0.9 + t * 0.1);
    }
  }
  return h;
}

// ── Palettes — every slot is a Color so the whole scene can crossfade.
// 'kma' is the poster: luminous teal sky, orange dusk, rust rock, blood moon.
// Hex is stored RAW (no sRGB→linear conversion): core's renderer outputs
// LinearSRGBColorSpace with no encode, so raw values display as authored —
// same convention as galaxy's float triples.
const SCALAR_SLOTS = ['duskAmt', 'hemiInt', 'sunInt'];
function pal(o) {
  const out = {};
  for (const k of Object.keys(o)) {
    out[k] = SCALAR_SLOTS.includes(k)
      ? o[k]
      : new Color().setHex(o[k], LinearSRGBColorSpace);
  }
  return out;
}
const PALETTE_DEFS = {
  kma: pal({
    horizon: 0x2fb9c6, zenith: 0x07182e, dusk: 0xff8a3a, duskAmt: 1.0,
    fog: 0x0d3038, hemiSky: 0x2e8f9c, hemiGround: 0x6e4526, hemiInt: 0.95,
    sun: 0xffb474, sunInt: 2.9, moonlx: 0x9fc8d8,
    moonTint: 0xd96a30, moonEmis: 0xb84a18,
    grid: 0x38e4ff, glyphA: 0x9ff4ff, glyphB: 0xffb45a, beam: 0x86f0ff,
    letter: 0x5eeaff, totemWarm: 0xffb168, starCool: 0xd4f2ff, starWarm: 0xffd9a6,
  }),
  bloodmoon: pal({
    horizon: 0xa04220, zenith: 0x140714, dusk: 0xff5a2a, duskAmt: 1.1,
    fog: 0x2a0f14, hemiSky: 0x7a3a2a, hemiGround: 0x40201a, hemiInt: 0.85,
    sun: 0xff6a35, sunInt: 2.4, moonlx: 0xd89078,
    moonTint: 0xff3818, moonEmis: 0xd42408,
    grid: 0xffa040, glyphA: 0xffc890, glyphB: 0xff6a3a, beam: 0xffb070,
    letter: 0xffc060, totemWarm: 0xff9048, starCool: 0xffd8c0, starWarm: 0xffa060,
  }),
  verdigris: pal({
    horizon: 0x2ec9a0, zenith: 0x06251f, dusk: 0xd4b83a, duskAmt: 0.6,
    fog: 0x0c2e28, hemiSky: 0x2f9c86, hemiGround: 0x4a5a30, hemiInt: 0.95,
    sun: 0xe8d070, sunInt: 2.0, moonlx: 0xa8d8c8,
    moonTint: 0xd8b070, moonEmis: 0xa07830,
    grid: 0x50ffd8, glyphA: 0xb0ffe8, glyphB: 0xffe080, beam: 0x90ffdf,
    letter: 0x60ffd0, totemWarm: 0xffd080, starCool: 0xd0fff0, starWarm: 0xffe8b0,
  }),
  hymnal: pal({
    horizon: 0x7a5aa8, zenith: 0x0d0a26, dusk: 0xff9a58, duskAmt: 0.9,
    fog: 0x201a38, hemiSky: 0x6a5a9c, hemiGround: 0x5a4030, hemiInt: 0.95,
    sun: 0xffb070, sunInt: 2.4, moonlx: 0xc8bce0,
    moonTint: 0xe8c898, moonEmis: 0xb09050,
    grid: 0xc0a8ff, glyphA: 0xe0d0ff, glyphB: 0xffcf90, beam: 0xd8c8ff,
    letter: 0xcdb8ff, totemWarm: 0xffc078, starCool: 0xe8e0ff, starWarm: 0xffe0b8,
  }),
  static: pal({
    horizon: 0x9aa8b4, zenith: 0x0a0d12, dusk: 0xc8c0b0, duskAmt: 0.3,
    fog: 0x1a2026, hemiSky: 0x8a98a4, hemiGround: 0x4a4a46, hemiInt: 0.9,
    sun: 0xe8e0d0, sunInt: 2.2, moonlx: 0xd8dce0,
    moonTint: 0xd8d4c8, moonEmis: 0x909088,
    grid: 0xd0f0ff, glyphA: 0xe8f8ff, glyphB: 0xc0c8d0, beam: 0xe0f4ff,
    letter: 0xcfeaff, totemWarm: 0xf0e0c8, starCool: 0xffffff, starWarm: 0xe8e0d0,
  }),
};
const COLOR_SLOTS = ['horizon', 'zenith', 'dusk', 'fog', 'hemiSky', 'hemiGround',
  'sun', 'moonlx', 'moonTint', 'moonEmis', 'grid', 'glyphA', 'glyphB', 'beam',
  'letter', 'totemWarm', 'starCool', 'starWarm'];

// ── Shaders ────────────────────────────────────────────────────────────
const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uHorizon; uniform vec3 uZenith; uniform vec3 uDusk;
  uniform vec3 uDuskDir; uniform float uDuskAmt;
  void main() {
    vec3 d = normalize(vDir);
    float up = d.y;
    vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.03, 0.55, up), 0.8));
    col += uHorizon * 0.5 * exp(-abs(up) * 9.0);
    float az = max(dot(normalize(vec3(d.x, 0.0, d.z)), uDuskDir), 0.0);
    col += uDusk * pow(az, 2.6) * exp(-max(up, -0.02) * 7.0) * uDuskAmt;
    col = mix(col, uZenith * 0.28, smoothstep(-0.04, -0.35, up));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const STAR_VERT = /* glsl */`
  attribute float aSeed;
  attribute float aSize;
  attribute float aBlink;
  attribute float aTint;
  uniform float uTime; uniform float uLevel; uniform float uTwinkle; uniform float uGlint;
  varying float vA; varying float vTint; varying float vSpark;
  void main() {
    float s7 = fract(aSeed * 7.31), s3 = fract(aSeed * 3.77), s5 = fract(aSeed * 5.13);
    // fast shimmer + a much slower visibility breath: blink stars sink all
    // the way out of sight and surface again over ~half a minute.
    float tw = 0.62 + 0.38 * sin(uTime * (0.4 + s7 * 1.5) * uTwinkle + aSeed * 61.7);
    float ph = 0.5 + 0.5 * sin(uTime * (0.04 + s3 * 0.05) + aSeed * 17.3);
    float vis = mix(1.0, smoothstep(0.12, 0.55, ph), aBlink);
    vSpark = step(0.72, s5);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vA = uLevel * tw * vis * smoothstep(-14.0, 40.0, position.y);
    vTint = aTint;
    gl_PointSize = aSize * (1.0 + uGlint * (0.4 + 1.2 * vSpark)) * (1300.0 / max(1.0, -mv.z));
  }
`;
const STAR_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uCool; uniform vec3 uWarm; uniform float uGlint;
  varying float vA; varying float vTint; varying float vSpark;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float r2 = dot(q, q);
    if (r2 > 0.25) discard;
    float fall = exp(-r2 * 18.0);
    vec3 col = mix(uCool, uWarm, vTint) * (1.0 + uGlint * vSpark * 0.8);
    gl_FragColor = vec4(col * fall * vA, fall * vA);
  }
`;

const GRID_VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vWorld = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const GRID_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  uniform float uTime; uniform float uSignal; uniform float uMids; uniform float uScanAmp;
  uniform vec3 uColor; uniform vec3 uCam; uniform vec2 uFade;
  void main() {
    // the digitization front: nothing on the nature side, full lattice east
    float lat = smoothstep(uFade.x, uFade.y, vWorld.x);
    float s = fract((vWorld.z + uTime * 9.0) / 70.0);
    float band = exp(-pow((s - 0.5) * 7.0, 2.0));
    float dfade = exp(-length(vWorld - uCam) * 0.006);
    float a = uSignal * lat * dfade * (0.38 + 0.34 * uMids + 0.85 * band * uScanAmp);
    gl_FragColor = vec4(uColor * a, a);
  }
`;

const GLYPH_VERT = /* glsl */`
  attribute float aSeed;
  attribute float aGlyph;
  uniform float uTime; uniform float uSignal; uniform float uMids;
  varying float vA; varying float vGlyph; varying float vWarm;
  void main() {
    float sp = 1.1 + fract(aSeed * 3.3) * 2.2;
    float y = mod(position.y + uTime * sp, 62.0);
    float sway = sin(uTime * 0.5 + aSeed * 41.0) * (0.6 + uMids * 2.4);
    vec3 pos = vec3(position.x + sway, y, position.z);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    vA = uSignal * smoothstep(0.0, 7.0, y) * (1.0 - smoothstep(38.0, 62.0, y))
       * (0.30 + 0.70 * fract(aSeed * 9.1));
    vGlyph = aGlyph;
    vWarm = step(0.86, fract(aSeed * 11.7));
    gl_PointSize = min((13.0 + 11.0 * fract(aSeed * 5.7)) * (130.0 / max(20.0, -mv.z)), 40.0);
  }
`;
const GLYPH_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uAtlas;
  uniform vec3 uColA; uniform vec3 uColB; uniform float uBeat;
  varying float vA; varying float vGlyph; varying float vWarm;
  void main() {
    float col8 = mod(vGlyph, 8.0);
    float row8 = floor(vGlyph / 8.0);
    vec2 uv = (vec2(col8, 7.0 - row8) + vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y)) / 8.0;
    float g = texture2D(uAtlas, uv).a;
    vec3 col = mix(uColA, uColB, vWarm) * (1.0 + uBeat * 0.6);
    float a = g * vA;
    gl_FragColor = vec4(col * a, a);
  }
`;

const BEAM_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const BEAM_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform float uTime; uniform float uBeam; uniform vec4 uPulses; uniform vec3 uColor;
  void main() {
    float lat = exp(-pow((vUv.x - 0.5) * 4.6, 2.0));
    float vert = (1.0 - vUv.y * 0.85) * smoothstep(0.0, 0.05, vUv.y);
    float flick = 0.85 + 0.15 * sin(uTime * 2.3 + vUv.y * 18.0);
    float pulses =
        uPulses.y * exp(-pow((vUv.y - uPulses.x) * 9.0, 2.0)) * (1.0 - uPulses.x * 0.5)
      + uPulses.w * exp(-pow((vUv.y - uPulses.z) * 9.0, 2.0)) * (1.0 - uPulses.z * 0.5);
    float a = lat * (uBeam * vert * 0.5 + pulses * 0.85) * flick;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

// ── Design: shared canvas helpers ──────────────────────────────────────
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function paintConcrete(ctx, w, h, seed) {
  ctx.fillStyle = '#e0ddd5';
  ctx.fillRect(0, 0, w, h);
  // aggregate speckle
  for (let i = 0; i < 1400; i++) {
    const x = hash2(i * 1.7, seed) * w, y = hash2(i * 2.9, seed + 4) * h;
    const l = hash2(i * 3.1, seed + 9);
    ctx.fillStyle = l > 0.5
      ? `rgba(228, 224, 214, ${0.04 + l * 0.08})`
      : `rgba(58, 56, 52, ${0.04 + l * 0.10})`;
    ctx.fillRect(x, y, 1 + l * 2, 1 + l * 2);
  }
  // rain-weather streaks
  for (let i = 0; i < 12; i++) {
    const x = hash2(i * 7.7, seed + 13) * w;
    const len = (0.25 + hash2(i * 5.1, seed + 17) * 0.6) * h;
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, 'rgba(52, 50, 46, 0.10)');
    g.addColorStop(1, 'rgba(52, 50, 46, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 3 + hash2(i, seed) * 7, len);
  }
}
// Carved-through lettering: a pale bevel lip offset down-right, then the
// punched hole showing dusk-dark air. The emissive canvas gets the same
// glyphs in white so the letters can become pure signal later.
const TOTEM_FONT = (px) => `900 ${px}px 'Arial Narrow', 'Helvetica Neue', 'Liberation Sans Narrow', sans-serif`;
function punchText(colorCtx, emisCtx, text, cx, cy, px) {
  for (const [ctx, mode] of [[colorCtx, 'c'], [emisCtx, 'e']]) {
    ctx.font = TOTEM_FONT(px);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (mode === 'c') {
      ctx.fillStyle = 'rgba(226, 229, 224, 0.9)';
      ctx.fillText(text, cx + px * 0.035, cy + px * 0.05);
      ctx.fillStyle = '#101820';
      ctx.fillText(text, cx, cy);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, cx, cy);
    }
  }
}
function punchHole(colorCtx, emisCtx, cx, cy, r) {
  colorCtx.fillStyle = 'rgba(226, 229, 224, 0.9)';
  colorCtx.beginPath(); colorCtx.arc(cx + r * 0.18, cy + r * 0.22, r, 0, Math.PI * 2); colorCtx.fill();
  colorCtx.fillStyle = '#101820';
  colorCtx.beginPath(); colorCtx.arc(cx, cy, r, 0, Math.PI * 2); colorCtx.fill();
  emisCtx.fillStyle = '#ffffff';
  emisCtx.beginPath(); emisCtx.arc(cx, cy, r, 0, Math.PI * 2); emisCtx.fill();
}
// Map a cap texture onto ExtrudeGeometry's default shape-space UVs.
function fitCapTexture(tex, minX, minY, w, h) {
  tex.repeat.set(1 / w, 1 / h);
  tex.offset.set(-minX / w, -minY / h);
}

// ── Design: the heart totem ("JESUS IS / COMING / SOON") ───────────────
// A Harrison-Mayes-style heart tablet on a concrete post. Returns
// { group, capMat } — capMat's emissive is driven live (warm ↔ signal).
function buildHeartTotem(sideTex) {
  const s = 2.6;
  const shape = new Shape();
  shape.moveTo(0, -1.05 * s);
  shape.bezierCurveTo(0.95 * s, -0.35 * s, 1.05 * s, 0.45 * s, 0.55 * s, 0.85 * s);
  shape.bezierCurveTo(0.25 * s, 1.08 * s, 0, 0.9 * s, 0, 0.55 * s);
  shape.bezierCurveTo(0, 0.9 * s, -0.25 * s, 1.08 * s, -0.55 * s, 0.85 * s);
  shape.bezierCurveTo(-1.05 * s, 0.45 * s, -0.95 * s, -0.35 * s, 0, -1.05 * s);

  const cw = 512, ch = 512;
  const colorC = makeCanvas(cw, ch), emisC = makeCanvas(cw, ch);
  const cc = colorC.getContext('2d'), ec = emisC.getContext('2d');
  paintConcrete(cc, cw, ch, 3.7);
  ec.clearRect(0, 0, cw, ch);
  // lines sit below the lobe cleft so no glyph falls in the notch void
  punchText(cc, ec, 'JESUS IS', cw * 0.5, ch * 0.38, 80);
  punchText(cc, ec, 'COMING',   cw * 0.5, ch * 0.54, 80);
  punchText(cc, ec, 'SOON',     cw * 0.5, ch * 0.70, 80);

  const capTex  = new CanvasTexture(colorC);
  const emisTex = new CanvasTexture(emisC);
  // shape bbox: x ∈ [-1.05s, 1.05s], y ∈ [-1.05s, 1.08s]
  fitCapTexture(capTex,  -1.05 * s, -1.05 * s, 2.10 * s, 2.13 * s);
  fitCapTexture(emisTex, -1.05 * s, -1.05 * s, 2.10 * s, 2.13 * s);

  const capMat = new MeshStandardMaterial({
    map: capTex, emissiveMap: emisTex, emissive: 0x000000,
    roughness: 0.92, metalness: 0.02,
  });
  const sideMat = new MeshStandardMaterial({ map: sideTex, roughness: 0.95, metalness: 0.02 });

  const geo = new ExtrudeGeometry(shape, {
    depth: 0.55, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05,
    bevelSegments: 2, steps: 1, curveSegments: 22,
  });
  const heart = new Mesh(geo, [capMat, sideMat]);
  heart.position.y = 5.55;

  const post = new Mesh(new BoxGeometry(0.95, 3.6, 0.5),
    new MeshStandardMaterial({ map: sideTex, roughness: 0.95, metalness: 0.02 }));
  post.position.y = 1.8;
  post.position.z = 0.27;

  const group = new Group();
  group.add(heart); group.add(post);
  return { group, capMat };
}

// ── Design: the cross totem ("GET RIGHT" / "WITH GOD") ─────────────────
// Roadside evangelist cross with airway-beacon bulb holes at the tips —
// the holes read as dark punches at dusk and as beacon lights in signal.
function buildCrossTotem(sideTex) {
  const halfW = 0.55, armHalf = 2.3, armY0 = 4.9, armY1 = 6.0, top = 7.4;
  const shape = new Shape();
  shape.moveTo(-halfW, 0);
  shape.lineTo(-halfW, armY0); shape.lineTo(-armHalf, armY0);
  shape.lineTo(-armHalf, armY1); shape.lineTo(-halfW, armY1);
  shape.lineTo(-halfW, top); shape.lineTo(halfW, top);
  shape.lineTo(halfW, armY1); shape.lineTo(armHalf, armY1);
  shape.lineTo(armHalf, armY0); shape.lineTo(halfW, armY0);
  shape.lineTo(halfW, 0);

  const cw = 512, ch = 1024;
  const colorC = makeCanvas(cw, ch), emisC = makeCanvas(cw, ch);
  const cc = colorC.getContext('2d'), ec = emisC.getContext('2d');
  paintConcrete(cc, cw, ch, 8.1);
  ec.clearRect(0, 0, cw, ch);

  // canvas maps shape bbox: x ∈ [-armHalf, armHalf], y ∈ [0, top]; canvas
  // y=0 is shape top. Helpers convert shape coords → canvas pixels.
  const X = (sx) => ((sx + armHalf) / (armHalf * 2)) * cw;
  const Y = (sy) => ((top - sy) / top) * ch;
  const armMidY = (armY0 + armY1) / 2;
  punchText(cc, ec, 'GET RIGHT', X(0), Y(armMidY), 96);
  const WORD = 'WITHGOD';
  for (let i = 0; i < WORD.length; i++) {
    punchText(cc, ec, WORD[i], X(0), Y(armY0 - 0.55 - i * 0.62), 78);
  }
  // beacon bulb holes: arm tips + crown
  for (const [sx, sy] of [
    [-armHalf + 0.26, armMidY + 0.26], [-armHalf + 0.26, armMidY - 0.26],
    [ armHalf - 0.26, armMidY + 0.26], [ armHalf - 0.26, armMidY - 0.26],
    [0, top - 0.30], [0, top - 0.78], [0, top - 1.26],
  ]) punchHole(cc, ec, X(sx), Y(sy), 9);

  const capTex  = new CanvasTexture(colorC);
  const emisTex = new CanvasTexture(emisC);
  fitCapTexture(capTex,  -armHalf, 0, armHalf * 2, top);
  fitCapTexture(emisTex, -armHalf, 0, armHalf * 2, top);

  const capMat = new MeshStandardMaterial({
    map: capTex, emissiveMap: emisTex, emissive: 0x000000,
    roughness: 0.92, metalness: 0.02,
  });
  const sideMat = new MeshStandardMaterial({ map: sideTex, roughness: 0.95, metalness: 0.02 });

  const geo = new ExtrudeGeometry(shape, {
    depth: 0.6, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05,
    bevelSegments: 2, steps: 1, curveSegments: 4,
  });
  const cross = new Mesh(geo, [capMat, sideMat]);
  const group = new Group();
  group.add(cross);
  return { group, capMat };
}

// ── Design: the moon — cratered, bump-mapped, slowly rotating ──────────
function paintMoonMaps(colorC, bumpC) {
  const w = colorC.width, h = colorC.height;
  const cc = colorC.getContext('2d'), bc = bumpC.getContext('2d');
  cc.fillStyle = '#b8b4ae'; cc.fillRect(0, 0, w, h);
  bc.fillStyle = '#808080'; bc.fillRect(0, 0, w, h);
  // maria — broad dark basins
  for (let i = 0; i < 42; i++) {
    const x = hash2(i * 1.3, 2.2) * w, y = (0.15 + hash2(i * 2.1, 5.5) * 0.7) * h;
    const r = (30 + hash2(i * 3.7, 7.1) * 110);
    const g = cc.createRadialGradient(x, y, r * 0.1, x, y, r);
    const a = 0.18 + hash2(i * 5.3, 9.9) * 0.25;
    g.addColorStop(0, `rgba(118, 112, 102, ${a})`);
    g.addColorStop(1, 'rgba(118, 112, 102, 0)');
    cc.fillStyle = g; cc.fillRect(x - r, y - r, r * 2, r * 2);
    const bg = bc.createRadialGradient(x, y, r * 0.1, x, y, r);
    bg.addColorStop(0, `rgba(96, 96, 96, ${a * 0.8})`);
    bg.addColorStop(1, 'rgba(96, 96, 96, 0)');
    bc.fillStyle = bg; bc.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // highland streaks
  for (let i = 0; i < 26; i++) {
    const x = hash2(i * 4.9, 3.3) * w, y = hash2(i * 6.1, 8.8) * h;
    const r = 20 + hash2(i * 1.9, 4.4) * 60;
    const g = cc.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(216, 212, 202, 0.16)');
    g.addColorStop(1, 'rgba(216, 212, 202, 0)');
    cc.fillStyle = g; cc.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // craters — dark floor, sun-caught rim arc
  for (let i = 0; i < 150; i++) {
    const x = hash2(i * 7.7, 1.1) * w;
    const y = (0.06 + hash2(i * 8.3, 6.6) * 0.88) * h;
    const r = 2.5 + Math.pow(hash2(i * 9.1, 2.7), 2.2) * 24;
    const fg = cc.createRadialGradient(x, y, 0, x, y, r);
    fg.addColorStop(0, 'rgba(64, 60, 54, 0.55)');
    fg.addColorStop(0.75, 'rgba(64, 60, 54, 0.30)');
    fg.addColorStop(1, 'rgba(64, 60, 54, 0)');
    cc.fillStyle = fg;
    cc.beginPath(); cc.arc(x, y, r, 0, Math.PI * 2); cc.fill();
    cc.strokeStyle = 'rgba(232, 226, 214, 0.5)';
    cc.lineWidth = Math.max(1, r * 0.14);
    cc.beginPath(); cc.arc(x, y, r * 0.92, -2.6, 0.4); cc.stroke();
    cc.strokeStyle = 'rgba(40, 38, 34, 0.4)';
    cc.beginPath(); cc.arc(x, y, r * 0.92, 0.6, 3.4); cc.stroke();
    // bump: recessed floor, raised rim
    const bg = bc.createRadialGradient(x, y, 0, x, y, r);
    bg.addColorStop(0, 'rgba(40, 40, 40, 0.8)');
    bg.addColorStop(0.8, 'rgba(70, 70, 70, 0.4)');
    bg.addColorStop(1, 'rgba(70, 70, 70, 0)');
    bc.fillStyle = bg;
    bc.beginPath(); bc.arc(x, y, r, 0, Math.PI * 2); bc.fill();
    bc.strokeStyle = 'rgba(214, 214, 214, 0.85)';
    bc.lineWidth = Math.max(1, r * 0.16);
    bc.beginPath(); bc.arc(x, y, r * 0.96, 0, Math.PI * 2); bc.stroke();
  }
}
function buildMoon() {
  const colorC = makeCanvas(1024, 512), bumpC = makeCanvas(1024, 512);
  paintMoonMaps(colorC, bumpC);
  const map = new CanvasTexture(colorC);
  const bumpMap = new CanvasTexture(bumpC);
  map.wrapS = RepeatWrapping; bumpMap.wrapS = RepeatWrapping;
  const mat = new MeshStandardMaterial({
    map, bumpMap, bumpScale: 1.1, roughness: 1.0, metalness: 0,
    emissiveMap: map, emissiveIntensity: 0.4, fog: false,
  });
  const moon = new Mesh(new SphereGeometry(MOON_R, 48, 48), mat);
  moon.position.copy(MOON_POS);
  moon.rotation.z = 0.15;

  // halo
  const hc = makeCanvas(256, 256);
  const hctx = hc.getContext('2d');
  const hg = hctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  hg.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
  hg.addColorStop(0.35, 'rgba(255, 255, 255, 0.14)');
  hg.addColorStop(1, 'rgba(255, 255, 255, 0)');
  hctx.fillStyle = hg; hctx.fillRect(0, 0, 256, 256);
  const haloMat = new SpriteMaterial({
    map: new CanvasTexture(hc), blending: AdditiveBlending,
    depthWrite: false, transparent: true, opacity: 0.2, fog: false,
  });
  const halo = new Sprite(haloMat);
  halo.position.copy(MOON_POS);
  halo.scale.set(MOON_R * 7, MOON_R * 7, 1);
  return { moon, mat, halo, haloMat, bumpMap };
}

// ── Design: orbital rings + satellites around the moon ─────────────────
function buildOrbits() {
  const group = new Group();
  group.position.copy(MOON_POS);
  // radius baked into each ring's geometry — sprites billboard incorrectly
  // under a non-uniform parent scale, so rings are never scaled
  const makeCircle = (r) => {
    const g = new BufferGeometry();
    const pts = new Float32Array(160 * 3);
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      pts[i * 3] = Math.cos(a) * r; pts[i * 3 + 1] = Math.sin(a) * r; pts[i * 3 + 2] = 0;
    }
    g.setAttribute('position', new BufferAttribute(pts, 3));
    return g;
  };

  const dot = makeCanvas(64, 64);
  const dctx = dot.getContext('2d');
  const dg = dctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  dg.addColorStop(0, 'rgba(255,255,255,1)');
  dg.addColorStop(0.3, 'rgba(255,255,255,0.5)');
  dg.addColorStop(1, 'rgba(255,255,255,0)');
  dctx.fillStyle = dg; dctx.fillRect(0, 0, 64, 64);
  const dotTex = new CanvasTexture(dot);

  const rings = [];
  const incl = [[1.25, 0.30], [1.05, -0.55], [1.45, 0.95]];
  for (let i = 0; i < 3; i++) {
    const r = MOON_R * (1.8 + i * 0.55);
    const mat = new LineBasicMaterial({
      transparent: true, opacity: 0.2, blending: AdditiveBlending,
      depthWrite: false, fog: false,
    });
    const ring = new LineLoop(makeCircle(r), mat);
    ring.rotation.set(incl[i][0], incl[i][1], 0);
    group.add(ring);
    const satMat = new SpriteMaterial({
      map: dotTex, blending: AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 0.5, fog: false,
    });
    const sat = new Sprite(satMat);
    sat.scale.set(3, 3, 1);
    ring.add(sat);
    // satellite orbits in the ring's local XY circle of radius r
    rings.push({ ring, mat, sat, satMat, r, th: i * 2.1, sp: (0.10 + i * 0.05) * (i % 2 ? -1 : 1) });
  }
  return { group, rings, dotTex };
}

// ── Design: terrain mesh with baked albedo vertex colors ───────────────
function buildTerrain() {
  const geo = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEG, TERRAIN_SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const n = pos.count;
  const side = TERRAIN_SEG + 1;
  // two passes: heights once, then slope from grid neighbours — keeps
  // create() cost to one terrainHeight call per vertex
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    heights[i] = terrainHeight(pos.getX(i), pos.getZ(i));
    pos.setY(i, heights[i]);
  }
  const cell = TERRAIN_SIZE / TERRAIN_SEG;
  const colors = new Float32Array(n * 3);
  const sand = [0.60, 0.44, 0.31], rock = [0.62, 0.34, 0.19], crag = [0.38, 0.22, 0.16];
  for (let i = 0; i < n; i++) {
    const cx = i % side, cz = (i / side) | 0;
    const xm = heights[cz * side + Math.max(0, cx - 1)];
    const xp = heights[cz * side + Math.min(side - 1, cx + 1)];
    const zm = heights[Math.max(0, cz - 1) * side + cx];
    const zp = heights[Math.min(side - 1, cz + 1) * side + cx];
    const slope = Math.hypot(xp - xm, zp - zm) / (2 * cell);
    const h = heights[i];
    const rockAmt = sstep(2.5, 14, h);
    const cragAmt = sstep(0.55, 1.4, slope) * 0.85;
    const mott = 0.85 + 0.3 * fbm2(pos.getX(i) * 0.13 + 3.1, pos.getZ(i) * 0.13 - 6.2, 2);
    for (let c = 0; c < 3; c++) {
      let v = lerp(sand[c], rock[c], rockAmt);
      v = lerp(v, crag[c], cragAmt);
      colors[i * 3 + c] = v * mott;
    }
  }
  geo.computeVertexNormals();
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  return new Mesh(geo, mat);
}

// ── Design: scattered rocks (instanced) ────────────────────────────────
function buildRocks() {
  const geo = new DodecahedronGeometry(1, 0);
  const mat = new MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  mat.color.setHex(0x8a6a50, LinearSRGBColorSpace);
  const mesh = new InstancedMesh(geo, mat, 46);
  const m4 = new Matrix4(), q = new Quaternion(), e = new Euler(), v = new Vector3(), sc = new Vector3();
  for (let i = 0; i < 46; i++) {
    const a = hash2(i * 3.3, 5.5) * Math.PI * 2;
    const r = 10 + Math.pow(hash2(i * 1.7, 8.8), 0.6) * 52;
    const x = Math.cos(a) * r, z = Math.sin(a) * r + 2;
    const s = 0.3 + Math.pow(hash2(i * 7.1, 2.2), 1.6) * 1.15;
    e.set(hash2(i, 1) * 3.1, hash2(i, 2) * 3.1, hash2(i, 3) * 3.1);
    q.setFromEuler(e);
    v.set(x, terrainHeight(x, z) + s * 0.25, z);
    sc.set(s, s * (0.6 + hash2(i, 4) * 0.5), s);
    m4.compose(v, q, sc);
    mesh.setMatrixAt(i, m4);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// ── Design: the data-grid — the terrain's wireframe ghost (east side) ──
function buildGrid(uniforms) {
  const x0 = -30, x1 = 190, z0 = -190, z1 = 60;
  const heights = new Float32Array(GRID_N * GRID_N);
  const gx = (i) => x0 + (i / (GRID_N - 1)) * (x1 - x0);
  const gz = (j) => z0 + (j / (GRID_N - 1)) * (z1 - z0);
  for (let j = 0; j < GRID_N; j++) {
    for (let i = 0; i < GRID_N; i++) {
      heights[j * GRID_N + i] = terrainHeight(gx(i), gz(j)) + 0.22;
    }
  }
  const segs = GRID_N * (GRID_N - 1) * 2;
  const posArr = new Float32Array(segs * 2 * 3);
  let p = 0;
  const put = (i, j) => {
    posArr[p++] = gx(i); posArr[p++] = heights[j * GRID_N + i]; posArr[p++] = gz(j);
  };
  for (let j = 0; j < GRID_N; j++) {
    for (let i = 0; i < GRID_N - 1; i++) { put(i, j); put(i + 1, j); }
  }
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N - 1; j++) { put(i, j); put(i, j + 1); }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(posArr, 3));
  const mat = new ShaderMaterial({
    uniforms, vertexShader: GRID_VERT, fragmentShader: GRID_FRAG,
    transparent: true, depthWrite: false, blending: AdditiveBlending,
  });
  const lines = new LineSegments(geo, mat);
  lines.frustumCulled = false;
  return lines;
}

// ── Design: the glyph field — ideas rising off the digitized land ──────
const GLYPH_CHARS = '01<>=/*+-{}()[]|;:.,!?#&@^~%$"\'λπΔμψΩ∞√≡±·°§';
function buildGlyphAtlas() {
  const c = makeCanvas(512, 512);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 512, 512);
  ctx.font = '46px "SF Mono", "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 64; i++) {
    const ch = GLYPH_CHARS[i % GLYPH_CHARS.length];
    const cx = (i % 8) * 64 + 32, cy = Math.floor(i / 8) * 64 + 32;
    ctx.fillText(ch, cx, cy);
  }
  return new CanvasTexture(c);
}
function buildGlyphField(uniforms) {
  const posArr = new Float32Array(N_GLYPHS * 3);
  const seedArr = new Float32Array(N_GLYPHS);
  const glyphArr = new Float32Array(N_GLYPHS);
  for (let i = 0; i < N_GLYPHS; i++) {
    posArr[i * 3]     = 15 + hash2(i * 1.9, 3.1) * 150;
    posArr[i * 3 + 1] = hash2(i * 2.7, 7.7) * 62;
    posArr[i * 3 + 2] = -165 + hash2(i * 3.7, 5.9) * 205;
    seedArr[i]  = hash2(i * 5.1, 9.3) * 100;
    glyphArr[i] = Math.floor(hash2(i * 7.9, 2.6) * 64);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(posArr, 3));
  geo.setAttribute('aSeed',  new BufferAttribute(seedArr, 1));
  geo.setAttribute('aGlyph', new BufferAttribute(glyphArr, 1));
  const mat = new ShaderMaterial({
    uniforms, vertexShader: GLYPH_VERT, fragmentShader: GLYPH_FRAG,
    transparent: true, depthWrite: false, blending: AdditiveBlending,
  });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

// ── Design: starfield ──────────────────────────────────────────────────
function buildStars(uniforms) {
  const posArr = new Float32Array(N_STARS * 3);
  const seedArr = new Float32Array(N_STARS);
  const sizeArr = new Float32Array(N_STARS);
  const blinkArr = new Float32Array(N_STARS);
  const tintArr = new Float32Array(N_STARS);
  for (let i = 0; i < N_STARS; i++) {
    // uniform on the sphere; the deep underworld mirrors up top
    const u = hash2(i * 1.3, 4.2) * 2 - 1;
    const th = hash2(i * 2.9, 8.4) * Math.PI * 2;
    let y = u * 510;
    if (y < -30) y = -y;
    const rr = Math.sqrt(Math.max(0, 510 * 510 - y * y));
    posArr[i * 3]     = Math.cos(th) * rr;
    posArr[i * 3 + 1] = y;
    posArr[i * 3 + 2] = Math.sin(th) * rr;
    seedArr[i]  = hash2(i * 3.7, 6.1) * 100;
    const big = hash2(i * 5.3, 2.8);
    sizeArr[i]  = 0.6 + Math.pow(big, 3.0) * 2.4;
    blinkArr[i] = hash2(i * 7.1, 9.9) < 0.30 ? 1 : 0;
    tintArr[i]  = Math.pow(hash2(i * 9.7, 1.4), 2.0);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(posArr, 3));
  geo.setAttribute('aSeed',  new BufferAttribute(seedArr, 1));
  geo.setAttribute('aSize',  new BufferAttribute(sizeArr, 1));
  geo.setAttribute('aBlink', new BufferAttribute(blinkArr, 1));
  geo.setAttribute('aTint',  new BufferAttribute(tintArr, 1));
  const mat = new ShaderMaterial({
    uniforms, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
    transparent: true, depthWrite: false, blending: AdditiveBlending,
  });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

// ── Design: the poster's scattered sky letters ─────────────────────────
const TITLE_LAYOUT = [
  ['N', -74, 152], ['O', -40, 136],
  ['M', -92, 108], ['A', -66,  95], ['N', -41,  82], ['’', -26, 76], ['S', -12, 66],
  ['L',  96, 130], ['A',  98, 106], ['N', 100,  82], ['D', 102,  58],
];
function buildTitleStars() {
  const texCache = {};
  const letters = [];
  const group = new Group();
  for (let i = 0; i < TITLE_LAYOUT.length; i++) {
    const [ch, x, y] = TITLE_LAYOUT[i];
    if (!texCache[ch]) {
      const c = makeCanvas(160, 224);
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 160, 224);
      ctx.font = '200 170px "Helvetica Neue", Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(ch, 80, 118);
      texCache[ch] = new CanvasTexture(c);
    }
    const mat = new SpriteMaterial({
      map: texCache[ch], transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const spr = new Sprite(mat);
    spr.position.set(MOON_POS.x + x, MOON_POS.y + y - 90, MOON_POS.z + 16);
    spr.scale.set(10, 14, 1);
    group.add(spr);
    letters.push({ mat, ph: i * 1.7, sp: 0.10 + hash2(i * 1.1, 6.6) * 0.08 });
  }
  return { group, letters, textures: Object.values(texCache) };
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'no_mans_land_2',
  name: 'No Man’s Land 2',
  contextType: 'three',
  // Full 3D scene with several standard-lit meshes + four additive shader
  // layers: cap DPR like quale 1 so a long projection set holds frame rate.
  maxDpr: 1.25,

  params: [
    { id: 'camera',     label: 'camera',      type: 'select', options: CAMERAS,  default: 'moonwatch' },
    { id: 'palette',    label: 'palette',     type: 'select', options: PALETTES, default: 'kma' },
    { id: 'travel',     label: 'travel',      type: 'range', min: 0, max: 2,   step: 0.05, default: 0.45 },
    { id: 'moonGlow',   label: 'moon glow',   type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.8,
      modulators: [ { source: 'audio.bass', mode: 'mul', amount: 0.35 } ] },
    { id: 'totemLight', label: 'totem light', type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.9,
      modulators: [ { source: 'audio.bass', mode: 'mul', amount: 0.40 } ] },
    { id: 'signal',     label: 'signal',      type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.6,
      modulators: [
        { source: 'audio.mids',   mode: 'mul', amount: 0.30 },
        { source: 'crowd.energy', mode: 'mul', amount: 0.30 },
      ] },
    { id: 'starLevel',  label: 'stars',       type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.8,
      modulators: [ { source: 'audio.highs', mode: 'mul', amount: 0.35 } ] },
    { id: 'twinkle',    label: 'twinkle',     type: 'range', min: 0, max: 2,   step: 0.05, default: 1.0 },
    { id: 'titleStars', label: 'title stars', type: 'toggle', default: true },
    { id: 'reactivity',     label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'poseReactivity', label: 'pose react', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks the exhibit as chapters: dusk revival → testament →
  // the liminal crossing → bloodmoon procession → ascension → benediction.
  autoPhase: {
    steps: [
      { camera: 'moonwatch',  palette: 'kma',       signal: 0.12, totemLight: 0.80, moonGlow: 0.65, starLevel: 0.55, twinkle: 0.8, travel: 0.35, titleStars: true },
      { camera: 'monuments',  palette: 'kma',       signal: 0.30, totemLight: 1.20, moonGlow: 0.80, starLevel: 0.70, twinkle: 1.0, travel: 0.40, titleStars: false },
      { camera: 'threshold',  palette: 'verdigris', signal: 0.95, totemLight: 0.70, moonGlow: 0.90, starLevel: 0.90, twinkle: 1.1, travel: 0.50, titleStars: false },
      { camera: 'procession', palette: 'bloodmoon', signal: 0.60, totemLight: 0.90, moonGlow: 1.25, starLevel: 0.80, twinkle: 1.0, travel: 0.55, titleStars: false },
      { camera: 'ascension',  palette: 'kma',       signal: 1.15, totemLight: 0.60, moonGlow: 1.00, starLevel: 1.25, twinkle: 1.3, travel: 0.50, titleStars: false },
      { camera: 'moonwatch',  palette: 'hymnal',    signal: 0.45, totemLight: 1.00, moonGlow: 0.90, starLevel: 0.90, twinkle: 0.9, travel: 0.30, titleStars: true },
    ],
  },

  presets: {
    default:     { camera: 'moonwatch',  palette: 'kma',       travel: 0.45, moonGlow: 0.8,  totemLight: 0.9, signal: 0.6,  starLevel: 0.8,  twinkle: 1.0, titleStars: true,  reactivity: 1.0, poseReactivity: 1.0 },
    revival:     { camera: 'moonwatch',  palette: 'kma',       travel: 0.35, moonGlow: 0.65, totemLight: 0.8, signal: 0.12, starLevel: 0.55, twinkle: 0.8, titleStars: true },
    testament:   { camera: 'monuments',  palette: 'kma',       travel: 0.4,  moonGlow: 0.8,  totemLight: 1.2, signal: 0.3,  starLevel: 0.7,  twinkle: 1.0, titleStars: false },
    liminal:     { camera: 'threshold',  palette: 'verdigris', travel: 0.5,  moonGlow: 0.9,  totemLight: 0.7, signal: 0.95, starLevel: 0.9,  twinkle: 1.1, titleStars: false },
    procession:  { camera: 'procession', palette: 'bloodmoon', travel: 0.55, moonGlow: 1.25, totemLight: 0.9, signal: 0.6,  starLevel: 0.8,  twinkle: 1.0, titleStars: false },
    ascension:   { camera: 'ascension',  palette: 'kma',       travel: 0.5,  moonGlow: 1.0,  totemLight: 0.6, signal: 1.15, starLevel: 1.25, twinkle: 1.3, titleStars: false },
    benediction: { camera: 'moonwatch',  palette: 'hymnal',    travel: 0.3,  moonGlow: 0.9,  totemLight: 1.0, signal: 0.45, starLevel: 0.9,  twinkle: 0.9, titleStars: true },
  },

  create(canvas, { renderer }) {
    const scene = new Scene();
    const camera = new PerspectiveCamera(55, canvas.width / Math.max(1, canvas.height), 0.1, 1400);

    // Live palette state — every material/uniform holds refs to these Color
    // instances; update() lerps them toward the selected palette so palette
    // and phase changes crossfade instead of snapping.
    const cur = {};
    const kma = PALETTE_DEFS.kma;
    for (const s of COLOR_SLOTS)  cur[s] = kma[s].clone();
    for (const s of SCALAR_SLOTS) cur[s] = kma[s];

    scene.fog = new FogExp2(0x0d3038, 0.0040);
    scene.fog.color = cur.fog;

    // ── Sky, lights ────────────────────────────────────────────────────
    const skyUniforms = {
      uHorizon: { value: cur.horizon }, uZenith: { value: cur.zenith },
      uDusk: { value: cur.dusk }, uDuskAmt: { value: 1.0 },
      uDuskDir: { value: new Vector3(-0.82, 0, 0.57).normalize() },
    };
    const sky = new Mesh(
      new SphereGeometry(560, 32, 20),
      new ShaderMaterial({ uniforms: skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: BackSide, depthWrite: false }),
    );
    scene.add(sky);

    const hemi = new HemisphereLight(0xffffff, 0xffffff, 0.95);
    hemi.color = cur.hemiSky; hemi.groundColor = cur.hemiGround;
    scene.add(hemi);
    const sun = new DirectionalLight(0xffffff, 2.9);
    sun.color = cur.sun;
    sun.position.set(-82, 22, 57);
    scene.add(sun);
    const moonlight = new DirectionalLight(0xffffff, 0.7);
    moonlight.color = cur.moonlx;
    moonlight.position.copy(MOON_POS).normalize().multiplyScalar(100);
    scene.add(moonlight);
    const totemGlow = new PointLight(0xffffff, 0, 42, 2);
    totemGlow.color = cur.totemWarm;
    totemGlow.position.set(-0.5, 4.5, 1.5);
    scene.add(totemGlow);

    // ── Land + monuments ───────────────────────────────────────────────
    scene.add(buildTerrain());
    const rocks = buildRocks();
    scene.add(rocks);

    const sideC = makeCanvas(256, 256);
    paintConcrete(sideC.getContext('2d'), 256, 256, 6.4);
    const sideTex = new CanvasTexture(sideC);
    sideTex.wrapS = sideTex.wrapT = RepeatWrapping;

    const heart = buildHeartTotem(sideTex);
    heart.group.position.set(-7, terrainHeight(-7, 2) - 0.12, 2);
    heart.group.rotation.set(0, 0.34, 0.045);
    scene.add(heart.group);
    const cross = buildCrossTotem(sideTex);
    cross.group.position.set(6, terrainHeight(6, -3) - 0.12, -3);
    cross.group.rotation.set(0, -0.3, -0.02);
    scene.add(cross.group);

    // ── Moon + orbits ──────────────────────────────────────────────────
    const moon = buildMoon();
    scene.add(moon.moon); scene.add(moon.halo);
    const orbits = buildOrbits();
    scene.add(orbits.group);

    // ── Sky + tech layers ──────────────────────────────────────────────
    const starUniforms = {
      uTime: { value: 0 }, uLevel: { value: 0.8 }, uTwinkle: { value: 1 },
      uGlint: { value: 0 }, uCool: { value: cur.starCool }, uWarm: { value: cur.starWarm },
    };
    scene.add(buildStars(starUniforms));

    const gridUniforms = {
      uTime: { value: 0 }, uSignal: { value: 0 }, uMids: { value: 0 },
      uScanAmp: { value: 0 }, uColor: { value: cur.grid },
      uCam: { value: camera.position }, uFade: { value: new Vector2(6, 70) },
    };
    scene.add(buildGrid(gridUniforms));

    const atlasTex = buildGlyphAtlas();
    const glyphUniforms = {
      uTime: { value: 0 }, uSignal: { value: 0 }, uMids: { value: 0 },
      uBeat: { value: 0 }, uColA: { value: cur.glyphA }, uColB: { value: cur.glyphB },
      uAtlas: { value: atlasTex },
    };
    scene.add(buildGlyphField(glyphUniforms));

    const beamUniforms = {
      uTime: { value: 0 }, uBeam: { value: 0 },
      uPulses: { value: new Vector4(1, 0, 1, 0) }, uColor: { value: cur.beam },
    };
    const beam = new Mesh(
      new PlaneGeometry(7, 140),
      new ShaderMaterial({ uniforms: beamUniforms, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide }),
    );
    beam.position.set(-0.5, 70, -0.5);
    beam.frustumCulled = false;
    scene.add(beam);

    const title = buildTitleStars();
    scene.add(title.group);

    // ── State ──────────────────────────────────────────────────────────
    const camPosS = new Vector3(-6, 3.2, 30);
    const camLookS = new Vector3(20, 40, -140);
    const tPos = new Vector3(), tLook = new Vector3(), lookDir = new Vector3();
    const emisCur = new Color(0, 0, 0);
    heart.capMat.emissive = emisCur;
    cross.capMat.emissive = emisCur;

    let pathT = 40;                    // start mid-walk so moonwatch opens composed
    let midsS = 0, glintEnv = 0, scanAmp = 0, satGlint = 0;
    let liftS = 0, yawS = 0, pitchS = 0, titleAmt = 0;
    let lastBeatPulse = 0, lastEmitAt = -20;
    const pulses = [ { progress: 1, amp: 0 }, { progress: 1, amp: 0 } ];

    function emitSignal(time, amp) {
      const w = pulses[0].amp <= 0.001 || pulses[0].progress > pulses[1].progress ? pulses[0] : pulses[1];
      w.progress = 0; w.amp = amp;
      scanAmp = Math.min(1.2, scanAmp + amp);
      satGlint = 1;
      lastEmitAt = time;
    }

    // Camera walks — every path is a smooth closed drift; mode switches
    // glide because the camera chases the path through smoothing.
    function evalPath(mode, t, pos, look) {
      if (mode === 0) {            // procession — the long ellipse walk
        const th = t * 0.05;
        const x = 2 + Math.cos(th) * 30, z = -4 + Math.sin(th) * 18;
        pos.set(x, terrainHeight(x, z) + 2.6 + Math.sin(t * 0.11) * 0.5, z);
        const m = 0.5 + 0.5 * Math.sin(th + 1.2);
        look.set(lerp(0, 30, m), lerp(5, 70, m), lerp(-2, -180, m));
      } else if (mode === 1) {     // monuments — tight slow orbit of the pair
        const th = t * 0.038;
        const x = -0.5 + Math.cos(th) * 12.5, z = -0.5 + Math.sin(th) * 12.5;
        pos.set(x, terrainHeight(x, z) + 3.2 + Math.sin(t * 0.09) * 0.4, z);
        look.set(-0.5 + Math.sin(t * 0.05) * 2, 4.6, -0.5);
      } else if (mode === 2) {     // moonwatch — totems in frame, moon high
        const x = -6 + Math.sin(t * 0.021) * 4, z = 30 + Math.cos(t * 0.017) * 3;
        pos.set(x, terrainHeight(x, z) + 2.2 + Math.sin(t * 0.09) * 0.3, z);
        look.set(24 + Math.sin(t * 0.013) * 6, 36, -150);
      } else if (mode === 3) {     // threshold — pan across the digitization front
        const x = 26 + Math.sin(t * 0.023) * 6, z = -20 + Math.cos(t * 0.019) * 26;
        pos.set(x, terrainHeight(x, z) + 3.6, z);
        const yaw = -2.5 + Math.sin(t * 0.045) * 1.25;
        look.set(x + Math.sin(yaw) * 40, pos.y + 1 + Math.sin(t * 0.07) * 7, z + Math.cos(yaw) * 40);
      } else {                     // ascension — rise from the valley to orbit
        const rise = 0.5 - 0.5 * Math.cos(t * 0.03);
        const th = t * 0.02;
        const x = 8 + Math.cos(th) * 14, z = -8 + Math.sin(th) * 14;
        pos.set(x, terrainHeight(x, z) + 3 + rise * 56, z);
        const k = sstep(0.12, 0.8, rise);
        look.set(lerp(0, 34, k), lerp(5, 78, k), lerp(-2, -210, k));
      }
    }

    function update(field) {
      const { dt, time, params, channels } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      const poseGain = params.poseReactivity ?? 1;

      // ── Palette crossfade (all scene colors chase the target) ────────
      const target = PALETTE_DEFS[params.palette] || PALETTE_DEFS.kma;
      const kc = Math.min(1, dt * 1.4);
      for (const s of COLOR_SLOTS)  cur[s].lerp(target[s], kc);
      for (const s of SCALAR_SLOTS) cur[s] += (target[s] - cur[s]) * kc;
      skyUniforms.uDuskAmt.value = cur.duskAmt;
      hemi.intensity = cur.hemiInt;
      sun.intensity = cur.sunInt;

      // ── Gesture: raised hands lift the whole signal field ────────────
      const wristY = channels?.['pose.wristMidY'] ?? 0;   // hands high → −1
      const rise = channels?.['crowd.rise'] ?? 0;
      const liftT = clamp01(clamp01(-wristY) * poseGain + rise * 0.6);
      liftS += (liftT - liftS) * Math.min(1, dt * 2);
      const signalLive = params.signal * (1 + liftS * 0.6);
      const starLive = params.starLevel * (1 + liftS * 0.5);

      // ── Audio envelopes (all light, no geometry) ─────────────────────
      const bass = audio.bands.bass;
      midsS += (audio.bands.mids - midsS) * Math.min(1, dt * 3);
      glintEnv = Math.max(glintEnv * Math.exp(-dt * 2.2), audio.highs.pulse);
      scanAmp *= Math.exp(-dt * 0.9);
      satGlint *= Math.exp(-dt * 1.6);

      // beat → an emission traveling up the beam / down the grid; slow,
      // rate-limited, with an autonomous fallback so silence still breathes
      const pulse = audio.beat.pulse;
      if (pulse > 0.55 && lastBeatPulse <= 0.55 && time - lastEmitAt > 2.6) {
        emitSignal(time, 0.5 + audio.bands.total * 0.5);
      }
      lastBeatPulse = pulse;
      if (time - lastEmitAt > 12.0) emitSignal(time, 0.4);
      for (let i = 0; i < 2; i++) {
        const p = pulses[i];
        if (p.amp > 0.001) {
          p.progress += dt / 5.0;
          if (p.progress >= 1) { p.amp = 0; p.progress = 1; }
        }
      }
      beamUniforms.uPulses.value.set(pulses[0].progress, pulses[0].amp, pulses[1].progress, pulses[1].amp);

      // ── The moon: slow crater rotation + emissive breath ─────────────
      moon.moon.rotation.y += dt * 0.012;
      moon.mat.color.copy(cur.moonTint);
      moon.mat.emissive.copy(cur.moonEmis);
      moon.mat.emissiveIntensity = params.moonGlow * (1.15 + bass * 0.5);
      moon.haloMat.color.copy(cur.moonTint);
      moon.haloMat.opacity = 0.10 + params.moonGlow * (0.16 + bass * 0.12);
      moonlight.intensity = 0.4 + params.moonGlow * 0.7;

      // orbital rings + satellites phase in with the signal
      const ringA = clamp01(signalLive * 0.5 - 0.02);
      for (let i = 0; i < orbits.rings.length; i++) {
        const r = orbits.rings[i];
        r.mat.color = cur.grid;
        r.mat.opacity = ringA * (0.16 + 0.10 * Math.sin(time * 0.1 + i * 2.4)) + satGlint * 0.08;
        r.th += dt * r.sp;
        r.sat.position.set(Math.cos(r.th) * r.r, Math.sin(r.th) * r.r, 0);
        r.satMat.color = cur.grid;
        r.satMat.opacity = ringA * (0.5 + glintEnv * 0.5) + satGlint * 0.35;
        const ss = 2.2 + satGlint * 2.2;
        r.sat.scale.set(ss, ss, 1);
      }

      // ── The monuments: warm faith-light ↔ luminous signal letters ────
      const sigMix = sstep(0.25, 0.95, signalLive);
      emisCur.lerpColors(cur.totemWarm, cur.letter, sigMix);
      const letterInt = params.totemLight * (0.50 + bass * 0.60) + signalLive * 1.30;
      heart.capMat.emissiveIntensity = letterInt;
      cross.capMat.emissiveIntensity = letterInt;
      totemGlow.intensity = params.totemLight * (26 + bass * 22);

      // ── Sky layers ───────────────────────────────────────────────────
      starUniforms.uTime.value = time;
      starUniforms.uLevel.value = starLive;
      starUniforms.uTwinkle.value = params.twinkle;
      starUniforms.uGlint.value = glintEnv;

      gridUniforms.uTime.value = time;
      gridUniforms.uSignal.value = signalLive;
      gridUniforms.uMids.value = midsS;
      gridUniforms.uScanAmp.value = scanAmp;

      glyphUniforms.uTime.value = time;
      glyphUniforms.uSignal.value = clamp01(signalLive * 0.75) * 0.8;
      glyphUniforms.uMids.value = midsS;
      glyphUniforms.uBeat.value = pulse;

      beamUniforms.uTime.value = time;
      beamUniforms.uBeam.value = signalLive * (0.18 + audio.rms * 0.45 + liftS * 0.35);

      // title letters drift in and out of visibility like the poster
      titleAmt += ((params.titleStars ? 1 : 0) - titleAmt) * Math.min(1, dt * 0.8);
      for (let i = 0; i < title.letters.length; i++) {
        const L = title.letters[i];
        L.mat.opacity = titleAmt * (0.16 + 0.30 * (0.5 + 0.5 * Math.sin(time * L.sp + L.ph)));
      }

      // ── Camera ───────────────────────────────────────────────────────
      pathT += dt * params.travel;
      evalPath(Math.max(0, CAMERAS.indexOf(params.camera)), pathT, tPos, tLook);
      const kCam = Math.min(1, dt * 0.9);
      camPosS.lerp(tPos, kCam);
      camLookS.lerp(tLook, kCam);
      camPosS.y = Math.max(camPosS.y, terrainHeight(camPosS.x, camPosS.z) + 1.5);

      // pose lean pans the valley (heavily smoothed)
      const hx = channels?.['pose.head.x'] ?? 0;
      const hp = channels?.['pose.headPitch'] ?? 0;
      yawS += (hx * 0.4 * poseGain - yawS) * Math.min(1, dt * 1.2);
      pitchS += (hp * 0.3 * poseGain - pitchS) * Math.min(1, dt * 1.2);
      lookDir.subVectors(camLookS, camPosS);
      const len = lookDir.length();
      lookDir.applyAxisAngle(camera.up, -yawS);
      lookDir.y += pitchS * len * 0.5;
      camera.position.copy(camPosS);
      lookDir.add(camPosS);
      camera.lookAt(lookDir);

      // the beam billboards toward the camera (yaw only)
      beam.rotation.y = Math.atan2(camPosS.x - beam.position.x, camPosS.z - beam.position.z);
    }

    function render() {
      // every audio value reaches the GPU as an envelope-smoothed uniform
      // written during update() — render never reads field
      renderer.render(scene, camera);
    }

    function resize(w, h /*, dpr */) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }

    function dispose() {
      // Renderer is core-owned. Textures living only in ShaderMaterial
      // uniforms or non-slot map channels need explicit disposal.
      atlasTex.dispose();
      moon.bumpMap.dispose();
      orbits.dotTex.dispose();
      for (const t of title.textures) t.dispose();
      rocks.dispose();
      disposeObject3D(scene);
    }

    return { resize, update, render, dispose };
  },
};
