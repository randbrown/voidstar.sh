// Maths — raymarched 3D fractal gallery: Mandelbulb, Mandelbox, Menger
// sponge, Sierpinski tetrahedron. One fullscreen fragment shader holds all
// four distance estimators; JS owns the camera, the object spin, and a
// morph state machine that crossfades between shapes by blending their
// distance fields (not a true SDF mid-blend, so the marcher walks with a
// safety factor — transient and cheap).
//
// Shape logic: the `shape` param picks one fractal or 'cycle', which
// auto-advances through all four on a slow clock. Every change — user
// select, cycle clock, or auto-phase step — routes through the same morph
// so shapes always dissolve into each other instead of popping.
//
// Audio map (declarative — see `modulators` on params below):
//   audio.bass      → glow        (bass swells the halo around the shape)
//   audio.beatPulse → colorFlow   (kick momentarily speeds palette rotation)
// Audio map (inline — non-param shader inputs):
//   bands (bass/mids/highs) → frequency-split colorization: the orbit-trap
//     value partitions the surface into inner/mid/outer regions, and each
//     region brightens with its own band — a literal spectrum→structure map
//   audio.bands.mids  → hueAccum integrator (sustained mids rotate palette)
//   audio.bands.highs → fresnel rim shimmer + per-pixel sparkle
//   audio.beat.pulse  → glow flare + soft white flash on the surface
//   audio.rms         → background nebula lift
//
// Pose map (observer-perspective, inline + smoothed — pose does NOT snap):
//   head.x        → camera yaw   (look around the object, mirrored)
//   head/shoulder → camera pitch (lean back = look up at it)
//   shoulder roll → camera roll  (tilt your shoulders, horizon tilts)
//   shoulder span → dolly        (step closer = camera dollies in)
//   pose.wristSpread → spin      (declarative modulator — arms out = faster spin)
// All camera targets are EMA-smoothed at ~2.2/s so tracking noise reads as
// a deliberate slow camera move; on dropout targets decay to neutral.
//
// Perf: maxDpr 1.0 + bounding-sphere pre-intersection (background pixels
// never march) + distance-scaled epsilon keep this inside the qualia
// 30fps@1080p budget on integrated GPUs.

import {
  compileProgram, makeFullscreenTri, FULLSCREEN_VERT,
  makeUniformGetter, uploadAudioUniforms,
} from '../webgl.js';
import { scaleAudio } from '../field.js';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform int   uShapeA;        // 0 bulb, 1 box, 2 menger, 3 sierpinski
uniform int   uShapeB;
uniform float uMorph;         // 0 = pure A, 1 = pure B (already eased)
uniform float uSpin;          // accumulated object yaw (radians)
uniform float uTumble;        // slow secondary-axis tilt (radians)
uniform float uCamYaw;        // camera orbit azimuth
uniform float uCamPitch;      // camera elevation
uniform float uCamRoll;       // camera roll
uniform float uCamDist;       // camera distance (world units)
uniform float uSteps;         // raymarch step budget (float, from detail)
uniform int   uPalette;       // 0 voidstar, 1 aurora, 2 ember, 3 spectral, 4 mono_void
uniform float uHue;           // [0,1) accumulated palette rotation
uniform float uGlow;          // halo strength
uniform float uFlare;         // beat pulse [0..1]
uniform float uSparkle;       // highs [0..1]

uniform vec4  uBands;         // (bass, mids, highs, total)
uniform vec2  uBeat;          // (active, pulse)
uniform vec2  uHighs;         // (active, pulse)
uniform float uRms;

const float BOUND_R  = 1.75;  // bounding sphere for all (normalized) shapes
const int   MAX_LOOP = 160;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

// 4-stop palette ramp, t in [0,1]. Same piecewise-lerp scheme as fractal.js.
vec3 palette(int pal, float t) {
  vec3 a, b, c, d;
  if (pal == 0) {            // voidstar — deep blue → cyan → soft white
    a = vec3(0.02, 0.04, 0.10);
    b = vec3(0.05, 0.30, 0.55);
    c = vec3(0.40, 0.85, 1.00);
    d = vec3(0.95, 0.98, 1.00);
  } else if (pal == 1) {     // aurora — abyss → teal → mint → pale violet
    a = vec3(0.02, 0.05, 0.09);
    b = vec3(0.05, 0.38, 0.38);
    c = vec3(0.35, 0.90, 0.65);
    d = vec3(0.80, 0.85, 1.00);
  } else if (pal == 2) {     // ember — black → oxblood → orange → gold
    a = vec3(0.03, 0.01, 0.02);
    b = vec3(0.45, 0.06, 0.08);
    c = vec3(1.00, 0.45, 0.10);
    d = vec3(1.00, 0.90, 0.55);
  } else if (pal == 3) {     // spectral — indigo → magenta → cyan-rose
    a = vec3(0.05, 0.02, 0.12);
    b = vec3(0.40, 0.10, 0.60);
    c = vec3(0.90, 0.35, 0.75);
    d = vec3(0.60, 0.95, 1.00);
  } else {                   // mono void — black → grey → pale blue
    a = vec3(0.00, 0.00, 0.00);
    b = vec3(0.16, 0.18, 0.24);
    c = vec3(0.52, 0.60, 0.72);
    d = vec3(0.92, 0.95, 1.00);
  }
  if      (t < 0.33) return mix(a, b, t / 0.33);
  else if (t < 0.66) return mix(b, c, (t - 0.33) / 0.33);
  else               return mix(c, d, (t - 0.66) / 0.34);
}

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// ── Distance estimators ─────────────────────────────────────────────────────
// Each returns vec2(distance, orbitTrap) with the trap pre-normalized to
// roughly [0,1] so the colour path treats all four shapes uniformly. Each
// shape is scaled so it fits a ~1.2 world-unit radius (shared camera framing).

// Mandelbulb, power 8 with a slow autonomous "breathing" of the exponent —
// the classic bulb never sits perfectly still even with audio off.
vec2 deBulb(vec3 p) {
  float power = 8.0 + 0.6 * sin(uTime * 0.05);
  vec3 z = p;
  float dr = 1.0, r = 0.0, trap = 1e10;
  for (int i = 0; i < 8; i++) {
    r = max(length(z), 1e-6);
    if (r > 2.0) break;
    float theta = acos(clamp(z.z / r, -1.0, 1.0)) * power;
    float phi   = atan(z.y, z.x) * power;
    dr = pow(r, power - 1.0) * power * dr + 1.0;
    float zr = pow(r, power);
    z = zr * vec3(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta)) + p;
    trap = min(trap, r);
  }
  return vec2(0.5 * log(r) * r / dr, clamp(trap * 0.68, 0.0, 1.0));
}

// Mandelbox, scale 2.6 (the "cathedral" regime). Input pre-scaled so the
// box's ~4-unit natural radius lands near 1.2.
vec2 deMbox(vec3 p) {
  const float S    = 0.30;   // world→box scale
  const float SCL  = 2.6;
  vec3 q  = p / S;
  vec3 z  = q;
  float dr = 1.0, trap = 1e10;
  for (int i = 0; i < 9; i++) {
    z = clamp(z, -1.0, 1.0) * 2.0 - z;             // box fold
    float r2 = dot(z, z);
    trap = min(trap, r2);
    if (r2 < 0.25)      { z *= 4.0;  dr *= 4.0; }  // sphere fold (inner)
    else if (r2 < 1.0)  { z /= r2;   dr /= r2;  }  // sphere fold (mid)
    z  = z * SCL + q;
    dr = dr * abs(SCL) + 1.0;
  }
  return vec2(length(z) / abs(dr) * S, clamp(trap * 1.05, 0.0, 1.0));
}

// Menger sponge, 5 subdivisions on a unit-ish box.
vec2 deMenger(vec3 p) {
  const float S = 0.70;      // world→sponge scale
  vec3 q = p / S;
  vec3 b = abs(q) - vec3(1.0);
  float d = length(max(b, 0.0)) + min(max(b.x, max(b.y, b.z)), 0.0);
  float s = 1.0, trap = 1e10;
  for (int m = 0; m < 5; m++) {
    vec3 a = mod(q * s, 2.0) - 1.0;
    s *= 3.0;
    vec3 r = abs(1.0 - 3.0 * abs(a));
    float da = max(r.x, r.y);
    float db = max(r.y, r.z);
    float dc = max(r.z, r.x);
    float c  = (min(da, min(db, dc)) - 1.0) / s;
    d = max(d, c);
    trap = min(trap, dot(a, a));
  }
  return vec2(d * S, clamp(trap * 0.55, 0.0, 1.0));
}

// Sierpinski tetrahedron — kaleidoscopic IFS toward the four vertices.
vec2 deSierp(vec3 p) {
  const float S   = 0.70;    // world→tetra scale
  const float SCL = 2.0;
  const vec3 a1 = vec3( 1.0,  1.0,  1.0);
  const vec3 a2 = vec3(-1.0, -1.0,  1.0);
  const vec3 a3 = vec3( 1.0, -1.0, -1.0);
  const vec3 a4 = vec3(-1.0,  1.0, -1.0);
  vec3 z = p / S;
  float trap = 1e10;
  int n = 0;
  for (n = 0; n < 10; n++) {
    vec3 c = a1; float dist = length(z - a1);
    float d = length(z - a2); if (d < dist) { c = a2; dist = d; }
    d = length(z - a3);       if (d < dist) { c = a3; dist = d; }
    d = length(z - a4);       if (d < dist) { c = a4; dist = d; }
    trap = min(trap, dist);
    z = SCL * z - c * (SCL - 1.0);
  }
  return vec2((length(z) - 2.0) * pow(SCL, -float(n)) * S,
              clamp(trap * 0.62, 0.0, 1.0));
}

vec2 deShape(int s, vec3 p) {
  if (s == 0) return deBulb(p);
  if (s == 1) return deMbox(p);
  if (s == 2) return deMenger(p);
  return deSierp(p);
}

// Scene map: object spin/tumble, then one shape — or a blend of two while
// morphing. The uniform branch keeps steady-state cost at a single DE.
vec2 map(vec3 p) {
  p.xz = rot2(uSpin)   * p.xz;
  p.yz = rot2(uTumble) * p.yz;
  if (uMorph <= 0.001) return deShape(uShapeA, p);
  if (uMorph >= 0.999) return deShape(uShapeB, p);
  vec2 a = deShape(uShapeA, p);
  vec2 b = deShape(uShapeB, p);
  return mix(a, b, uMorph);
}

vec3 calcNormal(vec3 p, float eps) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * map(p + k.xyy * eps).x
                 + k.yyx * map(p + k.yyx * eps).x
                 + k.yxy * map(p + k.yxy * eps).x
                 + k.xxx * map(p + k.xxx * eps).x);
}

// Deep-void background: vertical gradient + two starfield layers + a faint
// palette-tinted nebula. Stays near #05050d for the Hydra screen blend.
vec3 background(vec3 rd) {
  vec3 col = mix(vec3(0.010, 0.012, 0.026), vec3(0.022, 0.026, 0.052),
                 clamp(rd.y * 0.5 + 0.5, 0.0, 1.0));
  vec2 sph = vec2(atan(rd.z, rd.x), asin(clamp(rd.y, -1.0, 1.0)));
  for (float i = 0.0; i < 2.0; i++) {
    float scale = 22.0 + i * 26.0;
    vec2  g     = sph * scale;
    vec2  cell  = floor(g);
    vec2  local = fract(g) - 0.5;
    float h     = hash(cell + i * 13.7);
    float star  = step(0.992, h) * exp(-dot(local, local) * 90.0);
    float twink = 0.65 + 0.35 * sin(uTime * (1.0 + i) + h * 40.0);
    col += vec3(star * twink) * (0.35 - i * 0.12) * (1.0 + uHighs.y * 1.2);
  }
  float n = vnoise(sph * 2.2 + vec2(uTime * 0.008, 0.0));
  col += palette(uPalette, 0.28) * smoothstep(0.55, 1.0, n)
       * 0.10 * (1.0 + uRms * 1.5);
  return col;
}

void main() {
  vec2 res = uResolution;
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= res.x / max(res.y, 1.0);

  // ── Camera: orbit around origin, pose-shaped, rolled ─────────────────────
  float cy = uCamYaw, cp = clamp(uCamPitch, -1.35, 1.35);
  vec3 ro = uCamDist * vec3(cos(cp) * sin(cy), sin(cp), cos(cp) * cos(cy));
  vec3 fwd   = normalize(-ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up    = cross(right, fwd);
  // Roll rotates the screen basis around the view axis.
  float cr = cos(uCamRoll), sr = sin(uCamRoll);
  vec3 rr =  right * cr + up * sr;
  vec3 uu = -right * sr + up * cr;
  vec3 rd = normalize(fwd * 1.9 + rr * p.x + uu * p.y);

  vec3 col = background(rd);

  // ── Bounding sphere: background pixels never march ───────────────────────
  float bDot = dot(-ro, rd);
  float b2   = dot(ro, ro) - bDot * bDot;
  float R2   = BOUND_R * BOUND_R;
  float glowAcc = 0.0;
  bool  hit = false;
  float t = 0.0, trap = 0.0;
  float stepsUsed = 0.0;
  int   steps = int(uSteps);

  if (b2 < R2) {
    float half_ = sqrt(R2 - b2);
    float tNear = max(bDot - half_, 0.0);
    float tFar  = bDot + half_;
    t = tNear;
    for (int i = 0; i < MAX_LOOP; i++) {
      if (i >= steps || t > tFar) break;
      vec3 pos = ro + rd * t;
      vec2 dm  = map(pos);
      float d  = dm.x;
      glowAcc += exp(-abs(d) * 26.0);
      float eps = 0.0004 + t * 0.0011;
      if (d < eps) {
        hit  = true;
        trap = dm.y;
        stepsUsed = float(i);
        break;
      }
      // 0.9 safety factor: blended DEs during a morph under-estimate.
      t += d * 0.9;
      stepsUsed = float(i);
    }
  }

  if (hit) {
    vec3 pos  = ro + rd * t;
    float eps = 0.0006 + t * 0.0012;
    vec3 n    = calcNormal(pos, eps);

    // ── Frequency-split colorization ───────────────────────────────────────
    // The orbit trap partitions the surface: deep folds (low trap) belong to
    // the bass, the body to the mids, outer filigree to the highs. Each
    // region brightens with its own band, so the spectrum literally paints
    // different structural depths of the fractal.
    // sqrt lifts the trap's low end — menger/sierpinski traps cluster near 0
    // and would otherwise only ever sample the darkest palette stops.
    float trapL = sqrt(trap);
    float tcol = fract(trapL * 0.80 + uHue + n.y * 0.05);
    vec3 base  = palette(uPalette, tcol);
    float wLow  = 1.0 - smoothstep(0.20, 0.50, trapL);
    float wHigh = smoothstep(0.55, 0.85, trapL);
    float wMid  = clamp(1.0 - wLow - wHigh, 0.0, 1.0);
    base *= 1.0 + uBands.x * 0.55 * wLow
              + uBands.y * 0.40 * wMid
              + uBands.z * 0.60 * wHigh;

    // Lighting: slow-orbiting key + hemispheric fill + iteration AO.
    float la = uTime * 0.09;
    vec3 key = normalize(vec3(cos(la), 0.70, sin(la)));
    float diff = max(dot(n, key), 0.0);
    float fill = 0.5 + 0.5 * n.y;
    float ao   = pow(clamp(1.0 - stepsUsed / uSteps * 1.15, 0.0, 1.0), 1.5);
    float spec = pow(max(dot(reflect(-key, n), -rd), 0.0), 28.0);

    col = base * (0.26 + 0.90 * diff) * (0.35 + 0.65 * ao)
        + base * fill * 0.22
        + palette(uPalette, 0.95) * spec * 0.35;

    // Fresnel rim — shimmers with highs (hats/cymbals edge-light the shape).
    float fre = pow(clamp(1.0 + dot(n, rd), 0.0, 1.0), 3.0);
    col += palette(uPalette, fract(tcol + 0.35)) * fre
         * (0.22 + uBands.z * 0.85 + uHighs.y * 0.45);

    // Beat: soft white-hot flash on the surface.
    col += vec3(1.0) * uFlare * 0.16 * (0.4 + 0.6 * diff);

    // Distance fade into the void so the far side recedes.
    col = mix(col, background(rd), smoothstep(BOUND_R * 1.2, BOUND_R * 2.6, t));
  }

  // Glow halo — near-miss rays accumulate light around the silhouette.
  // Bass swells it (via the glow param's modulator) and beats flare it.
  float g = glowAcc / max(uSteps, 1.0);
  col += palette(uPalette, fract(uHue + 0.55)) * g * g * uGlow
       * (2.2 + uFlare * 2.4);

  // Per-pixel sparkle on highs — additive, tiny.
  if (uSparkle > 0.001) {
    float sn = hash(vUv * res + uTime);
    col += vec3(0.20, 0.24, 0.30) * step(0.986, sn) * uSparkle;
  }

  // Vignette + tone curve.
  float v = smoothstep(1.7, 0.45, length(p));
  col *= v;
  col = pow(col, vec3(0.93));
  outColor = vec4(col, 1.0);
}
`;

const SHAPES   = ['mandelbulb', 'mandelbox', 'menger', 'sierpinski'];
const PALETTES = ['voidstar', 'aurora', 'ember', 'spectral', 'mono_void'];

const MORPH_SECONDS = 3.0;   // shape crossfade duration
const CYCLE_SECONDS = 26;    // dwell per shape in 'cycle' mode

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'maths',
  name: 'Maths',
  contextType: 'webgl2',
  // Fullscreen raymarcher — halve fragment work on hi-DPI screens.
  maxDpr: 1.0,

  params: [
    { id: 'shape',     label: 'shape',      type: 'select', options: ['cycle', ...SHAPES], default: 'cycle' },
    { id: 'spin',      label: 'spin',       type: 'range', min: -2,  max: 2,   step: 0.02, default: 0.30,
      modulators: [
        // Reach your arms out to spin the object faster.
        { source: 'pose.wristSpread', mode: 'add', amount: 0.35 },
      ] },
    { id: 'camDist',   label: 'distance',   type: 'range', min: 1.4, max: 5,   step: 0.05, default: 3.0 },
    { id: 'detail',    label: 'detail',     type: 'range', min: 0.4, max: 1.6, step: 0.05, default: 1.0 },
    { id: 'palette',   label: 'palette',    type: 'select', options: PALETTES, default: 'voidstar' },
    { id: 'colorFlow', label: 'color flow', type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.35,
      modulators: [
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.80 },
      ] },
    { id: 'glow',      label: 'glow',       type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass', mode: 'mul', amount: 0.35 },
      ] },
    { id: 'poseBind',  label: 'pose camera', type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0,  max: 2,   step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks the gallery: each step is a distinct fractal portrait
  // (shape + palette + motion mood). Shape changes route through the same
  // morph crossfade as the cycle clock, so phase steps dissolve smoothly.
  autoPhase: {
    steps: [
      { shape: 'mandelbulb', palette: 'voidstar',  spin: 0.30, colorFlow: 0.35 },
      { shape: 'mandelbox',  palette: 'aurora',    spin: 0.20, colorFlow: 0.25 },
      { shape: 'menger',     palette: 'mono_void', spin: 0.35, colorFlow: 0.15 },
      { shape: 'sierpinski', palette: 'ember',     spin: 0.50, colorFlow: 0.50 },
      { shape: 'mandelbulb', palette: 'spectral',  spin: 0.24, colorFlow: 0.60 },
    ],
  },

  presets: {
    default:         { shape: 'cycle',      spin: 0.30, camDist: 3.0,  detail: 1.0, palette: 'voidstar',  colorFlow: 0.35, glow: 1.0, poseBind: true, reactivity: 1.0 },
    bulb_meditation: { shape: 'mandelbulb', spin: 0.16, camDist: 3.2,  detail: 1.2, palette: 'voidstar',  colorFlow: 0.18, glow: 0.8 },
    box_cathedral:   { shape: 'mandelbox',  spin: 0.14, camDist: 2.4,  detail: 1.1, palette: 'aurora',    colorFlow: 0.25, glow: 1.2 },
    sponge_relic:    { shape: 'menger',     spin: 0.35, camDist: 3.0,  detail: 1.0, palette: 'mono_void', colorFlow: 0.10, glow: 0.9 },
    tetra_rave:      { shape: 'sierpinski', spin: 0.60, camDist: 2.8,  detail: 0.9, palette: 'spectral',  colorFlow: 0.70, glow: 1.5, reactivity: 1.3 },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    let W = canvas.width, H = canvas.height;

    // Morph state machine. shapeA is on screen; when a change is requested
    // shapeB becomes the destination and morph runs 0→1, then A adopts B.
    let shapeA = 0, shapeB = 0, morph = 0;
    let cycleIdx = 0, cycleT = 0;

    // Accumulators.
    let spinAngle = 0;   // object yaw, integrates the spin param
    let hueAccum  = 0;   // palette rotation, integrates colorFlow (+ mids)

    // Pose-driven camera offsets (smoothed). All decay to 0 = neutral
    // orbiting observer when poseBind is off or nobody is in frame.
    let poseYaw = 0, posePitch = 0, poseRoll = 0, poseProx = 0;

    let audioRef = null;
    const scratch = {
      time: 0, shape: 'cycle',
      camYaw: 0, camPitch: 0, camDist: 3.0,
      steps: 96, palette: 0, glow: 1.0, morphEased: 0,
      tumble: 0,
    };

    function requestShape(idx) {
      const current = morph > 0 ? shapeB : shapeA;
      if (idx === current) return;
      // Mid-morph retarget: snap to the old destination, fade to the new one.
      if (morph > 0) { shapeA = shapeB; }
      shapeB = idx;
      morph  = 0.0001;
    }

    function update(field) {
      const { dt, time, pose, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;

      scratch.time    = time;
      scratch.camDist = params.camDist;
      scratch.palette = Math.max(0, PALETTES.indexOf(params.palette));
      scratch.glow    = params.glow;
      // detail 0.4..1.6 → 56..128 raymarch steps.
      scratch.steps   = Math.round(56 + 60 * (params.detail - 0.4));

      // ── Shape selection: user select / cycle clock, all through morph ──
      if (params.shape !== scratch.shape) {
        scratch.shape = params.shape;
        cycleT = 0;
        if (params.shape === 'cycle') {
          cycleIdx = shapeB;   // resume the rotation from the current shape
        } else {
          requestShape(Math.max(0, SHAPES.indexOf(params.shape)));
        }
      }
      if (scratch.shape === 'cycle') {
        cycleT += dt;
        if (cycleT > CYCLE_SECONDS) {
          cycleT = 0;
          cycleIdx = (cycleIdx + 1) % SHAPES.length;
          requestShape(cycleIdx);
        }
      }

      // Advance the morph; ease with smoothstep before upload so the blend
      // has no velocity discontinuity at either end.
      if (morph > 0) {
        morph += dt / MORPH_SECONDS;
        if (morph >= 1) { shapeA = shapeB; morph = 0; }
      }
      const m = morph;
      scratch.morphEased = m <= 0 ? 0 : m * m * (3 - 2 * m);

      // ── Object motion ──────────────────────────────────────────────────
      // params.spin already includes the wristSpread modulator.
      spinAngle += dt * params.spin * 0.5;
      scratch.tumble = 0.35 * Math.sin(time * 0.045);

      // ── Palette rotation: colorFlow sets the pace, sustained mids push
      // it further (integrated, so audio rotates rather than jitters).
      hueAccum += dt * (0.012 + audio.bands.mids * 0.10) * params.colorFlow * 4.0;
      hueAccum -= Math.floor(hueAccum);

      // ── Pose → camera targets (observer perspective, never snapping) ──
      let yawT = 0, pitchT = 0, rollT = 0, proxT = 0;
      if (params.poseBind && pose.people.length > 0) {
        const p0 = pose.people[0];
        const sL = p0.shoulders?.l, sR = p0.shoulders?.r, head = p0.head;
        if (head && head.visibility > 0.3) {
          // Mirrored so moving your head right pans the view right.
          yawT = Math.max(-1, Math.min(1, (0.5 - head.x) * 2.2)) * 0.9;
        }
        if (sL && sR && sL.visibility > 0.4 && sR.visibility > 0.4) {
          const spanX = sR.x - sL.x, spanY = sR.y - sL.y;
          const span  = Math.sqrt(spanX * spanX + spanY * spanY);
          // Step closer (bigger span) → dolly in; step back → pull out.
          proxT = Math.max(-1, Math.min(1, (span - 0.25) / 0.20));
          rollT = Math.max(-1, Math.min(1, (sR.y - sL.y) * 5.0)) * 0.30;
          if (head && head.visibility > 0.3) {
            const shoulderMidY = (sL.y + sR.y) * 0.5;
            const ratio = (shoulderMidY - head.y) / Math.max(span, 0.05);
            // Lean back → camera pitches up to look at the shape from below.
            pitchT = Math.max(-1, Math.min(1, (ratio - 0.75) / 0.4)) * 0.55;
          }
        }
      }
      // Slow EMA — pose noise reads as a deliberate camera move. On dropout
      // (or poseBind off) targets are 0 so the view glides back to neutral.
      const kp = Math.min(1, dt * 2.2);
      poseYaw   += (yawT   - poseYaw)   * kp;
      posePitch += (pitchT - posePitch) * kp;
      poseRoll  += (rollT  - poseRoll)  * kp;
      poseProx  += (proxT  - poseProx)  * kp;

      // Autonomous slow orbit + gentle elevation breathing under the pose.
      scratch.camYaw   = time * 0.05 + poseYaw;
      scratch.camPitch = 0.22 * Math.sin(time * 0.031) + posePitch;
      // Proximity dollies ±30% around the distance param.
      scratch.camDist  = params.camDist * (1 - poseProx * 0.30);
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform1f(U('uTime'),     scratch.time);
      gl.uniform1i(U('uShapeA'),   shapeA);
      gl.uniform1i(U('uShapeB'),   shapeB);
      gl.uniform1f(U('uMorph'),    scratch.morphEased);
      gl.uniform1f(U('uSpin'),     spinAngle);
      gl.uniform1f(U('uTumble'),   scratch.tumble);
      gl.uniform1f(U('uCamYaw'),   scratch.camYaw);
      gl.uniform1f(U('uCamPitch'), scratch.camPitch);
      gl.uniform1f(U('uCamRoll'),  poseRoll);
      gl.uniform1f(U('uCamDist'),  scratch.camDist);
      gl.uniform1f(U('uSteps'),    scratch.steps);
      gl.uniform1i(U('uPalette'),  scratch.palette);
      gl.uniform1f(U('uHue'),      hueAccum);
      gl.uniform1f(U('uGlow'),     scratch.glow);
      gl.uniform1f(U('uFlare'),    audioRef ? audioRef.beat.pulse : 0);
      gl.uniform1f(U('uSparkle'),  audioRef ? audioRef.bands.highs : 0);
      if (audioRef) uploadAudioUniforms(gl, U, audioRef);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() {
        gl.deleteProgram(prog);
        gl.deleteVertexArray(vao);
      },
    };
  },
};
