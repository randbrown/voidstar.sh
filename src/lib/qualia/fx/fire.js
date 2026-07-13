// Fire — realtime combustion simulation. A 2D Eulerian fluid solver (Stam
// "stable fluids") runs entirely on the GPU via ping-pong half-float FBOs:
// MacCormack (BFECC) advection → combustion chemistry (fuel → heat + soot) →
// thermal buoyancy (αT − βs) → vorticity confinement → Jacobi pressure
// projection. The render pass maps temperature through a blackbody-style
// emission ramp with soot absorption, so the glow is driven by the simulated
// temperature field, not a painted gradient. MacCormack matters: plain
// semi-Lagrangian advection is numerically diffusive and smears the flame
// into slow-motion mush; the forward/backward correction keeps the tongues
// crisp at the same grid size.
//
// The sim grid is fixed-resolution (velocity ~160 rows, thermo 3×) and
// independent of canvas size — the composite pass upscales with an fbm
// detail warp + unsharp mask, so cost stays flat at any viewport. maxDpr 1.0
// keeps the fullscreen composite bounded on hi-DPI.
//
// Modulation map (declarative — see `modulators` on params below):
//   audio.bass        → intensity  (fuel feed pumps with the low end)
//   audio.beatPulse   → intensity  (kick flares the bed)
//   audio.highs       → turbulence (cymbals sharpen the eddies)
//   pose.head.x       → wind       (lean left/right bends the flames — subtle)
//   pose.wristMidY    → height     (hands rise → flames rise — subtle)
//   pose.shoulderSpan → intensity  (lean in → the fire feeds — subtle)
// Inline (non-param):
//   beat.pulse   → vertical impulse burst at the bed (percussive lick)
//   highs.pulse  → ember spawn bursts + composite detail-warp shimmer
//   wrist motion → momentum splats stirring the velocity field (the
//                  performer literally waves the flames around; scaled by
//                  poseReactivity, thresholded so tracking jitter is inert)
//
// Embers are a CPU particle pool drawn as additive GL points — no GPU
// readback; they ride a cheap analytic buffet instead of the actual velocity
// field, which reads fine at their size.
//
// If float render targets are unavailable (no EXT_color_buffer_float /
// _half_float) the quale degrades to a single-pass procedural fbm flame —
// same palette + emitter envelope, no solver — instead of throwing at
// create() time. Embers still run there; splats need the solver and don't.

import { compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter } from '../webgl.js';
import { scaleAudio } from '../field.js';

// ── Shared GLSL chunks ─────────────────────────────────────────────────────

const HEADER = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;
`;

const NOISE = /* glsl */`
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return v;
}
`;

// The fuel bed along the bottom edge — a centered band with feathered ends,
// shared by the injection pass, the composite's ember glow, and the fallback.
const EMITTER = /* glsl */`
float bedBand(float x) {
  const float halfW = 0.20;
  return smoothstep(0.5 - halfW, 0.5 - halfW + 0.09, x)
       * (1.0 - smoothstep(0.5 + halfW - 0.09, 0.5 + halfW, x));
}
`;

// Emission ramps. x is normalized temperature in [0,1]; channels deliberately
// exceed 1.0 at the top — the exponential tone map in the composite rolls
// them off toward white (the blackbody "hotter → whiter" read).
const PALETTE = /* glsl */`
vec3 firePal(int idx, float x) {
  x = clamp(x, 0.0, 1.0);
  if (idx == 1) return vec3(0.95 * pow(x, 1.50), 0.85 * pow(x, 2.60), 1.55 * pow(x, 0.80)); // voidfire
  if (idx == 2) return vec3(1.35 * pow(x, 2.80), 1.30 * pow(x, 1.50), 1.50 * pow(x, 0.75)); // cryo
  if (idx == 3) return vec3(1.75 * pow(x, 0.50), 0.95 * pow(x, 2.10), 0.30 * pow(x, 4.00)); // ember
  return            vec3(1.65 * pow(x, 0.65), 1.45 * pow(x, 1.90), 1.30 * pow(x, 3.80));    // blackbody
}
`;

// MacCormack correction with the standard min/max limiter: the corrected
// value is clamped to the range of the four source texels bracketing the
// back-traced point, so second-order accuracy can't ring into overshoots.
const MACCORMACK = /* glsl */`
vec4 mcCorrect(highp sampler2D orig, highp sampler2D fwd, highp sampler2D back,
               vec2 uv, vec2 coord, vec2 texel) {
  vec4 v0 = texture(orig, uv);
  vec4 v1 = texture(fwd,  uv);
  vec4 v2 = texture(back, uv);
  vec4 c  = v1 + 0.5 * (v0 - v2);
  vec2 st   = coord / texel - 0.5;
  vec2 base = (floor(st) + 0.5) * texel;
  vec4 s00 = texture(orig, base);
  vec4 s10 = texture(orig, base + vec2(texel.x, 0.0));
  vec4 s01 = texture(orig, base + vec2(0.0, texel.y));
  vec4 s11 = texture(orig, base + texel);
  vec4 lo = min(min(s00, s10), min(s01, s11));
  vec4 hi = max(max(s00, s10), max(s01, s11));
  return clamp(c, lo, hi);
}
`;

// ── Solver passes (all fullscreen-tri draws into sim-res FBOs) ─────────────

// Generic semi-Lagrangian advect — runs the forward AND backward legs of the
// MacCormack pair (uDt is signed) for both velocity and thermo fields.
// Velocity is stored in sim cells/sec, so the uv back-trace is v·dt·simTexel.
const ADVECT_FRAG = HEADER + /* glsl */`
uniform highp sampler2D uSrc;
uniform highp sampler2D uVel;
uniform vec2  uSimTexel;
uniform float uDt;
void main() {
  vec2 v = texture(uVel, vUv).xy;
  outColor = texture(uSrc, vUv - uDt * v * uSimTexel);
}
`;

const CORRECT_VEL_FRAG = HEADER + MACCORMACK + /* glsl */`
uniform highp sampler2D uOrig;
uniform highp sampler2D uFwd;
uniform highp sampler2D uBack;
uniform vec2  uSimTexel;
uniform float uDt;
uniform float uDiss;
void main() {
  vec2 v0 = texture(uOrig, vUv).xy;
  vec2 coord = vUv - uDt * v0 * uSimTexel;
  vec4 c = mcCorrect(uOrig, uFwd, uBack, vUv, coord, uSimTexel);
  outColor = vec4(c.xy * uDiss, 0.0, 1.0);
}
`;

const CURL_FRAG = HEADER + /* glsl */`
uniform highp sampler2D uVel;
uniform vec2 uTexel;
void main() {
  float L = texture(uVel, vUv - vec2(uTexel.x, 0.0)).y;
  float R = texture(uVel, vUv + vec2(uTexel.x, 0.0)).y;
  float B = texture(uVel, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uVel, vUv + vec2(0.0, uTexel.y)).x;
  outColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}
`;

// External forces: vorticity confinement (F = ε ω (N.y, −N.x)), thermal
// buoyancy (α·T − β·soot, up), wind shear on the hot column, and the beat
// impulse. Also pins the floor (no flow through the bed) and clamps speed.
const FORCES_FRAG = HEADER + /* glsl */`
uniform highp sampler2D uVel;
uniform highp sampler2D uCurl;
uniform highp sampler2D uThermo;
uniform vec2  uTexel;
uniform float uDt;
uniform float uBuoy;
uniform float uWeight;
uniform float uCurlAmt;
uniform float uWind;
uniform float uKick;
void main() {
  vec2 v = texture(uVel, vUv).xy;

  float L = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  force *= uCurlAmt * C;
  force.y *= -1.0;
  v += force * uDt;

  vec4 th = texture(uThermo, vUv);
  v.y += (uBuoy * th.x - uWeight * th.z) * uDt;

  float hot = clamp(th.x * 1.4 + th.z * 0.4, 0.0, 1.0);
  v.x += uWind * 90.0 * hot * uDt;
  v.y += uKick * 260.0 * th.x * smoothstep(0.6, 0.0, vUv.y) * uDt;

  if (vUv.y < uTexel.y * 2.0) v.y = max(v.y, 0.0);
  outColor = vec4(clamp(v, vec2(-420.0), vec2(420.0)), 0.0, 1.0);
}
`;

// Gaussian momentum splat — wrist stirs. Relaxes local velocity toward the
// wrist velocity instead of adding, so the strength is framerate-independent
// and bounded (a sustained wave stirs; it can't accumulate into a blast).
// Applied pre-projection so the pressure solve folds the injected divergence
// back into swirl.
const SPLAT_FRAG = HEADER + /* glsl */`
uniform highp sampler2D uVel;
uniform vec2  uPoint;
uniform vec2  uDir;
uniform float uRadius;
uniform float uAspect;
uniform float uBlend;
void main() {
  vec2 v = texture(uVel, vUv).xy;
  vec2 d = vUv - uPoint;
  d.x *= uAspect;
  float g = exp(-dot(d, d) / (uRadius * uRadius));
  outColor = vec4(v + (uDir - v) * (g * uBlend), 0.0, 1.0);
}
`;

const DIVERGENCE_FRAG = HEADER + /* glsl */`
uniform highp sampler2D uVel;
uniform vec2 uTexel;
void main() {
  float L = texture(uVel, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVel, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uVel, vUv - vec2(0.0, uTexel.y)).y;
  float T = texture(uVel, vUv + vec2(0.0, uTexel.y)).y;
  outColor = vec4(0.5 * ((R - L) + (T - B)), 0.0, 0.0, 1.0);
}
`;

const JACOBI_FRAG = HEADER + /* glsl */`
uniform highp sampler2D uPressure;
uniform highp sampler2D uDiv;
uniform vec2 uTexel;
void main() {
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float d = texture(uDiv, vUv).x;
  outColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
}
`;

const GRADIENT_FRAG = HEADER + /* glsl */`
uniform highp sampler2D uVel;
uniform highp sampler2D uPressure;
uniform vec2 uTexel;
void main() {
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  vec2 v = texture(uVel, vUv).xy - 0.5 * vec2(R - L, T - B);
  outColor = vec4(v, 0.0, 1.0);
}
`;

// Thermo field (R = temperature, G = fuel, B = soot): MacCormack-corrected
// advection, then react. Combustion needs ignition heat (smoothstep on T) so
// fuel doesn't burn until the bed or a neighbor lights it. Cooling has a T²
// term standing in for radiative loss, so the hottest cores fade fastest.
// Injection re-seeds fuel + heat at the bed with a two-band fbm flicker
// (slow wander + fast strobe) so the tongues live on their own — the idle
// fire stays alive with audio off.
const THERMO_FRAG = HEADER + NOISE + EMITTER + MACCORMACK + /* glsl */`
uniform highp sampler2D uOrig;
uniform highp sampler2D uFwd;
uniform highp sampler2D uBack;
uniform highp sampler2D uVel;
uniform vec2  uSimTexel;
uniform vec2  uDyeTexel;
uniform float uDt;
uniform float uTime;
uniform float uIntensity;
uniform float uBurn;
uniform float uHeat;
uniform float uSmokeGain;
uniform float uCool;
uniform float uSmokeFade;
void main() {
  vec2 vel = texture(uVel, vUv).xy;
  vec2 coord = vUv - uDt * vel * uSimTexel;
  vec4 c = mcCorrect(uOrig, uFwd, uBack, vUv, coord, uDyeTexel);
  float T = c.x, fuel = c.y, smoke = c.z;

  float ignite = smoothstep(0.15, 0.35, T);
  float burn = min(fuel * uBurn * uDt * ignite, fuel);
  T    += burn * uHeat;
  fuel -= burn;
  smoke += burn * uSmokeGain;

  T = max(T - (uCool * T + 1.0 * T * T) * uDt, 0.0);
  smoke *= exp(-uSmokeFade * uDt);

  // Open top: the domain is a closed box, so bleed heat + soot out near the
  // ceiling instead of letting them pool.
  float top = smoothstep(0.82, 1.0, vUv.y);
  T     *= 1.0 - top * 3.0 * uDt;
  smoke *= 1.0 - top * 2.0 * uDt;

  float band  = bedBand(vUv.x);
  float flick = fbm(vec2(vUv.x * 11.0, uTime * 2.6));
  flick = 0.20 + 0.80 * smoothstep(0.40, 0.88, flick);
  flick *= 0.80 + 0.40 * noise(vec2(vUv.x * 23.0, uTime * 7.0));
  float bed = smoothstep(0.04, 0.0, vUv.y);
  float src = uIntensity * band * flick * bed;
  fuel = max(fuel, src * 0.80);
  T    = max(T,    src * 1.00);

  outColor = vec4(T, fuel, smoke, 1.0);
}
`;

// Composite to screen: upscale the thermo field with a two-octave fbm detail
// warp (fine licks the coarse grid can't hold) + a temperature unsharp mask,
// temperature → emission ramp, soot absorbs (Beer-Lambert) and catches a
// faint fire-lit scatter.
const RENDER_FRAG = HEADER + NOISE + EMITTER + PALETTE + /* glsl */`
uniform highp sampler2D uThermo;
uniform vec2  uDyeTexel;
uniform float uTime;
uniform float uShimmer;
uniform float uSmokeVis;
uniform float uIntensity;
uniform int   uPalette;
void main() {
  vec4 base = texture(uThermo, vUv);
  float wAmp = 0.020 * (1.0 + 0.9 * uShimmer)
             * smoothstep(0.0, 0.45, base.x + base.z * 0.3);
  vec2 warp = vec2(
    fbm(vUv * vec2(6.0, 9.0) + vec2(0.0,  -uTime * 2.2)),
    fbm(vUv * vec2(6.0, 9.0) + vec2(7.31, -uTime * 1.8))
  ) - 0.5;
  float fine = fbm(vUv * vec2(15.0, 22.0) + vec2(3.17, -uTime * 3.4)) - 0.5;
  warp += 0.35 * vec2(fine, -fine);
  vec2 uv = vUv + warp * wAmp;
  vec4 th = texture(uThermo, uv);
  float T = th.x, smoke = th.z;

  // Unsharp mask on temperature — recovers edge contrast lost to the
  // bilinear upscale so the tongues read crisp at 1080p.
  float Tb = ( texture(uThermo, uv + vec2(uDyeTexel.x, 0.0)).x
             + texture(uThermo, uv - vec2(uDyeTexel.x, 0.0)).x
             + texture(uThermo, uv + vec2(0.0, uDyeTexel.y)).x
             + texture(uThermo, uv - vec2(0.0, uDyeTexel.y)).x ) * 0.25;
  T = max(T + (T - Tb) * 1.1, 0.0);

  vec3 col = firePal(uPalette, T / 1.5) * smoothstep(0.03, 0.11, T);
  col += vec3(0.90, 0.85, 0.80) * smoothstep(1.30, 1.95, T);   // hottest core → white
  col *= exp(-smoke * 0.55 * vec3(1.0, 1.08, 1.2));            // soot absorption, warms the veil
  col += vec3(0.09, 0.09, 0.13) * smoke * 0.16 * uSmokeVis;    // faint lit-soot scatter

  // Ember glow where the bed meets the floor.
  col += firePal(uPalette, 0.45) * bedBand(vUv.x)
       * smoothstep(0.10, 0.0, vUv.y) * 0.35 * uIntensity;

  col = 1.0 - exp(-col * 1.4);
  outColor = vec4(col, 1.0);
}
`;

// No-float-FBO fallback: one pass of domain-warped fbm shaped by the same
// emitter envelope + palette. Not a simulation, but it burns.
const FALLBACK_FRAG = HEADER + NOISE + EMITTER + PALETTE + /* glsl */`
uniform float uTime;
uniform float uIntensity;
uniform float uHeight;
uniform float uTurb;
uniform float uWind;
uniform float uKick;
uniform int   uPalette;
void main() {
  float x = vUv.x - uWind * 0.25 * vUv.y;
  float band = bedBand(x);
  vec2 q = vec2(x * 4.0, vUv.y * 2.2 - uTime * (1.1 + 0.6 * uHeight));
  float n = fbm(q + fbm(q * 1.7) * 0.6);
  float h = vUv.y / (0.5 + 0.4 * uHeight);
  float t = band * uIntensity * (1.15 + 0.35 * uKick) * (1.0 - h)
          - n * (0.45 + 0.30 * uTurb);
  t = clamp(t * 1.9, 0.0, 1.6);
  vec3 col = firePal(uPalette, t / 1.5) * smoothstep(0.02, 0.08, t);
  col = 1.0 - exp(-col * 1.4);
  outColor = vec4(col, 1.0);
}
`;

// ── Ember point sprites ────────────────────────────────────────────────────

const EMBER_VERT = /* glsl */`#version 300 es
layout(location = 0) in vec2 aPos;    // uv position
layout(location = 1) in vec3 aData;   // size(px@540p), heat, alpha
uniform float uPtScale;
out float vHeat;
out float vAlpha;
void main() {
  gl_Position  = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = max(aData.x * uPtScale, 1.0);
  vHeat  = aData.y;
  vAlpha = aData.z;
}
`;

const EMBER_FRAG = /* glsl */`#version 300 es
precision highp float;
in float vHeat;
in float vAlpha;
out vec4 outColor;
${PALETTE}
uniform int uPalette;
void main() {
  vec2 pc = gl_PointCoord - 0.5;
  float r = length(pc) * 2.0;
  float fall = exp(-r * r * 5.0) * (1.0 - smoothstep(0.8, 1.0, r));
  vec3 col = firePal(uPalette, clamp(vHeat, 0.0, 1.0))
           + vec3(0.6, 0.5, 0.4) * smoothstep(0.9, 1.3, vHeat);
  outColor = vec4(col * fall * vAlpha, 1.0);
}
`;

// ── Module ─────────────────────────────────────────────────────────────────

const SIM_H     = 160;   // velocity / pressure grid rows
const DYE_SCALE = 3;     // thermo grid runs finer for crisper tongues
const JACOBI_ITERS = 22;
const PALETTES = ['blackbody', 'voidfire', 'cryo', 'ember'];

const MAX_EMBERS = 160;
const EMBER_STRIDE = 5;  // x, y, size, heat, alpha

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'fire',
  name: 'Fire',
  contextType: 'webgl2',
  maxDpr: 1.0,

  params: [
    { id: 'intensity',  label: 'intensity',  type: 'range', min: 0, max: 2, step: 0.01, default: 1.0,
      modulators: [
        { source: 'audio.bass',        mode: 'mul', amount: 0.35 },
        { source: 'audio.beatPulse',   mode: 'mul', amount: 0.40 },
        { source: 'pose.shoulderSpan', mode: 'mul', amount: 0.15 },
      ] },
    { id: 'height',     label: 'height',     type: 'range', min: 0.2, max: 2, step: 0.01, default: 1.0,
      modulators: [
        { source: 'pose.wristMidY', mode: 'mul', amount: -0.20 },
      ] },
    { id: 'turbulence', label: 'turbulence', type: 'range', min: 0, max: 2, step: 0.01, default: 1.0,
      modulators: [
        { source: 'audio.highs', mode: 'mul', amount: 0.35 },
      ] },
    { id: 'wind',       label: 'wind',       type: 'range', min: -1, max: 1, step: 0.01, default: 0.0,
      modulators: [
        { source: 'pose.head.x', mode: 'add', amount: 0.30 },
      ] },
    { id: 'smoke',      label: 'smoke',      type: 'range', min: 0, max: 2, step: 0.01, default: 1.0 },
    { id: 'embers',     label: 'embers',     type: 'range', min: 0, max: 2, step: 0.01, default: 1.0 },
    { id: 'palette',    label: 'palette',    type: 'select', options: PALETTES, default: 'blackbody' },
    { id: 'reactivity',     label: 'reactivity',      type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'poseReactivity', label: 'pose reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { palette: 'blackbody', intensity: 1.0,  height: 1.0,  turbulence: 1.0,  smoke: 1.0, embers: 1.0, wind: 0.0 },
      { palette: 'ember',     intensity: 0.7,  height: 0.8,  turbulence: 0.75, smoke: 1.4, embers: 1.4, wind: 0.0 },
      { palette: 'voidfire',  intensity: 1.2,  height: 1.15, turbulence: 1.3,  smoke: 0.8, embers: 0.8, wind: 0.0 },
      { palette: 'cryo',      intensity: 0.9,  height: 1.05, turbulence: 1.1,  smoke: 0.9, embers: 1.0, wind: 0.25 },
    ],
  },

  presets: {
    default:  { intensity: 1.0,  height: 1.0,  turbulence: 1.0,  wind: 0.0, smoke: 1.0, embers: 1.0, palette: 'blackbody', reactivity: 1.0, poseReactivity: 1.0 },
    campfire: { intensity: 0.65, height: 0.8,  turbulence: 0.75, wind: 0.0, smoke: 1.3, embers: 1.3, palette: 'ember' },
    inferno:  { intensity: 1.6,  height: 1.35, turbulence: 1.5,  wind: 0.0, smoke: 0.7, embers: 1.5, palette: 'blackbody' },
    voidfire: { intensity: 1.1,  height: 1.1,  turbulence: 1.25, wind: 0.0, smoke: 0.9, embers: 0.8, palette: 'voidfire' },
  },

  create(canvas, { gl }) {
    // Float render targets: 16F is texture-filterable in core WebGL2 but only
    // color-renderable behind one of these extensions. Missing both (rare) →
    // procedural fallback path, never a throw mid-set.
    const floatOk = !!(gl.getExtension('EXT_color_buffer_float')
                    || gl.getExtension('EXT_color_buffer_half_float'));

    const vao = makeFullscreenTri(gl);

    function makePass(frag, vert) {
      const prog = compileProgram(gl, vert || FULLSCREEN_VERT, frag);
      return { prog, U: makeUniformGetter(gl, prog) };
    }

    let sim = null;      // solver passes + FBOs, or null in fallback mode
    const pRender = makePass(floatOk ? RENDER_FRAG : FALLBACK_FRAG);
    const pEmber  = makePass(EMBER_FRAG, EMBER_VERT);
    if (floatOk) {
      sim = {
        pAdvect:  makePass(ADVECT_FRAG),
        pCorrVel: makePass(CORRECT_VEL_FRAG),
        pCurl:    makePass(CURL_FRAG),
        pForces:  makePass(FORCES_FRAG),
        pSplat:   makePass(SPLAT_FRAG),
        pDiv:     makePass(DIVERGENCE_FRAG),
        pJacobi:  makePass(JACOBI_FRAG),
        pGrad:    makePass(GRADIENT_FRAG),
        pThermo:  makePass(THERMO_FRAG),
      };
    }

    // ── FBO plumbing ──────────────────────────────────────────────────────
    // RGBA16F everywhere (velocity in .xy, scalars in .x) — RGBA is the one
    // format both float-renderability extensions guarantee, and the grids are
    // tiny so the padding is irrelevant.
    function makeTarget(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return { tex, fbo, ok };
    }
    function makeDouble(w, h) {
      return { read: makeTarget(w, h), write: makeTarget(w, h),
               swap() { const t = this.read; this.read = this.write; this.write = t; } };
    }
    function freeTarget(t)  { if (!t) return; gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    function freeDouble(d)  { if (!d) return; freeTarget(d.read); freeTarget(d.write); }

    let W = 0, H = 0;                   // canvas backing buffer
    let SW = 0, SH = 0, DW = 0, DH = 0; // sim + thermo grid dims
    let vel = null, thermo = null, pressure = null, curl = null, div = null;
    let velTmpA = null, velTmpB = null, dyeTmpA = null, dyeTmpB = null;
    let simOk = false;                  // grids allocated + framebuffer-complete

    function allocGrids() {
      freeDouble(vel); freeDouble(thermo); freeDouble(pressure);
      freeTarget(curl); freeTarget(div);
      freeTarget(velTmpA); freeTarget(velTmpB); freeTarget(dyeTmpA); freeTarget(dyeTmpB);
      vel = thermo = pressure = curl = div = null;
      velTmpA = velTmpB = dyeTmpA = dyeTmpB = null;
      simOk = false;
      if (!sim || !W || !H) return;
      SH = SIM_H;
      SW = Math.max(16, Math.round(SIM_H * (W / H)));
      DW = SW * DYE_SCALE; DH = SH * DYE_SCALE;
      vel      = makeDouble(SW, SH);
      thermo   = makeDouble(DW, DH);
      pressure = makeDouble(SW, SH);
      curl     = makeTarget(SW, SH);
      div      = makeTarget(SW, SH);
      velTmpA  = makeTarget(SW, SH);
      velTmpB  = makeTarget(SW, SH);
      dyeTmpA  = makeTarget(DW, DH);
      dyeTmpB  = makeTarget(DW, DH);
      simOk = vel.read.ok && thermo.read.ok && pressure.read.ok && curl.ok && div.ok
           && velTmpA.ok && velTmpB.ok && dyeTmpA.ok && dyeTmpB.ok;
    }

    function bindTex(unit, tex) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }

    // ── Ember pool (CPU sim, GL points) ───────────────────────────────────
    // pos/vel in uv space; buffet is analytic (per-ember sine phase), no
    // velocity-texture readback. All buffers pre-allocated — zero per-frame
    // garbage.
    const emPos  = new Float32Array(MAX_EMBERS * 2);
    const emVel  = new Float32Array(MAX_EMBERS * 2);
    const emLife = new Float32Array(MAX_EMBERS);      // seconds remaining; <=0 = dead
    const emSize = new Float32Array(MAX_EMBERS);
    const emHeat = new Float32Array(MAX_EMBERS);
    const vboData = new Float32Array(MAX_EMBERS * EMBER_STRIDE);
    let emberCount = 0;   // live vertices in vboData this frame
    let emberAcc = 0;     // fractional spawn accumulator
    const emberVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, emberVbo);
    gl.bufferData(gl.ARRAY_BUFFER, vboData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    function spawnEmber(t) {
      for (let i = 0; i < MAX_EMBERS; i++) {
        if (emLife[i] > 0) continue;
        emPos[i * 2]     = 0.5 + (Math.random() - 0.5) * 0.36;
        emPos[i * 2 + 1] = 0.02 + Math.random() * 0.05;
        emVel[i * 2]     = (Math.random() - 0.5) * 0.06;
        emVel[i * 2 + 1] = 0.10 + Math.random() * 0.16;
        emLife[i] = 1.2 + Math.random() * 1.8;
        emSize[i] = 2.6 + Math.random() * 3.2;
        emHeat[i] = 0.85 + Math.random() * 0.45;
        return;
      }
    }

    function updateEmbers(dt, t, rate, wind) {
      emberAcc += dt * rate;
      while (emberAcc >= 1) { emberAcc -= 1; spawnEmber(t); }
      let n = 0;
      for (let i = 0; i < MAX_EMBERS; i++) {
        if (emLife[i] <= 0) continue;
        emLife[i] -= dt;
        let x = emPos[i * 2], y = emPos[i * 2 + 1];
        let vx = emVel[i * 2], vy = emVel[i * 2 + 1];
        vy += 0.22 * dt;                                       // buoyant lift
        vx += Math.sin(t * 6.3 + i * 2.399) * 0.10 * dt;       // analytic buffet
        vx += wind * 0.06 * dt;
        vx *= Math.exp(-0.5 * dt); vy *= Math.exp(-0.2 * dt);  // drag
        x += vx * dt; y += vy * dt;
        emHeat[i] *= Math.exp(-0.9 * dt);
        if (emLife[i] <= 0 || y > 1.05 || emHeat[i] < 0.05) { emLife[i] = 0; continue; }
        emPos[i * 2] = x; emPos[i * 2 + 1] = y;
        emVel[i * 2] = vx; emVel[i * 2 + 1] = vy;
        const twinkle = 0.7 + 0.3 * Math.sin(t * 13 + i * 1.7);
        const o = n * EMBER_STRIDE;
        vboData[o]     = x;
        vboData[o + 1] = y;
        vboData[o + 2] = emSize[i];
        vboData[o + 3] = emHeat[i];
        vboData[o + 4] = Math.min(1, emLife[i]) * twinkle;
        n++;
      }
      emberCount = n;
    }

    // ── Wrist splats ──────────────────────────────────────────────────────
    // Smoothed wrist positions → velocity estimate → momentum splat. The
    // speed threshold keeps tracking jitter (and a stationary performer)
    // inert; a dropout resets the tracker so re-entry can't slingshot.
    const wrists = [
      { valid: false, x: 0, y: 0, vx: 0, vy: 0 },
      { valid: false, x: 0, y: 0, vx: 0, vy: 0 },
    ];
    const splats = [
      { on: false, x: 0, y: 0, fx: 0, fy: 0 },
      { on: false, x: 0, y: 0, fx: 0, fy: 0 },
    ];

    function trackWrist(slot, lm, dt, gain) {
      const w = wrists[slot], s = splats[slot];
      s.on = false;
      if (!lm || lm.visibility < 0.35) { w.valid = false; return; }
      const x = 1 - lm.x;            // mirror to match the on-screen feel
      const y = 1 - lm.y;            // camera y-down → sim y-up
      if (!w.valid) { w.valid = true; w.x = x; w.y = y; w.vx = 0; w.vy = 0; return; }
      const k = Math.min(1, dt * 12);
      const vx = (x - w.x) / Math.max(dt, 1e-3), vy = (y - w.y) / Math.max(dt, 1e-3);
      w.vx += (vx - w.vx) * k; w.vy += (vy - w.vy) * k;
      w.x += (x - w.x) * k;    w.y += (y - w.y) * k;
      const speed = Math.hypot(w.vx, w.vy);
      if (speed < 0.25 || gain <= 0) return;
      // uv/s → sim cells/s, clamped so a fast swipe stirs rather than blasts.
      const cap = Math.min(1, 2.2 / speed);
      s.on = true;
      s.x = w.x; s.y = w.y;
      s.fx = w.vx * cap * SW * 1.3 * gain;
      s.fy = w.vy * cap * SH * 1.3 * gain;
    }

    // ── Per-frame scratch (update fills, render reads — never field) ──────
    const scratch = {
      dt: 1 / 60, time: 0,
      intensity: 1, height: 1, turb: 1, wind: 0, smoke: 1,
      palette: 0, kick: 0, shimmer: 0,
    };

    function update(field) {
      const p = field.params;
      const audio = scaleAudio(field.audio, p.reactivity);
      scratch.dt        = Math.min(Math.max(field.dt, 1 / 240), 1 / 30);
      scratch.time      = field.time;
      scratch.intensity = p.intensity;
      scratch.height    = p.height;
      scratch.turb      = p.turbulence;
      scratch.wind      = p.wind;
      scratch.smoke     = p.smoke;
      scratch.palette   = Math.max(0, PALETTES.indexOf(p.palette));
      scratch.kick      = audio.beat.pulse;
      scratch.shimmer   = audio.highs.pulse;

      // Embers: gentle ambient trickle, bursts on highs (hats/cymbals) and a
      // smaller kick pop, all scaled by the bed intensity + embers knob.
      const rate = (3.0 + 34 * audio.highs.pulse + 10 * audio.beat.pulse)
                 * Math.min(scratch.intensity, 1.5) * (p.embers ?? 1);
      updateEmbers(scratch.dt, scratch.time, rate, scratch.wind);

      // Wrist stirs (only meaningful when the solver runs).
      const p0 = field.pose?.people?.[0] ?? null;
      const gain = p.poseReactivity == null ? 1 : p.poseReactivity;
      trackWrist(0, p0?.wrists?.l ?? null, scratch.dt, gain);
      trackWrist(1, p0?.wrists?.r ?? null, scratch.dt, gain);
    }

    function runSim() {
      const { pAdvect, pCorrVel, pCurl, pForces, pSplat, pDiv, pJacobi, pGrad, pThermo } = sim;
      const dt = scratch.dt;
      const tx = 1 / SW, ty = 1 / SH;

      gl.viewport(0, 0, SW, SH);

      // 1 — MacCormack velocity advection: forward leg, backward leg, then
      // limited correction (dissipation folded into the correction pass).
      gl.useProgram(pAdvect.prog);
      gl.uniform1i(pAdvect.U('uSrc'), 0);
      gl.uniform1i(pAdvect.U('uVel'), 1);
      gl.uniform2f(pAdvect.U('uSimTexel'), tx, ty);
      gl.bindFramebuffer(gl.FRAMEBUFFER, velTmpA.fbo);
      bindTex(0, vel.read.tex); bindTex(1, vel.read.tex);
      gl.uniform1f(pAdvect.U('uDt'), dt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, velTmpB.fbo);
      bindTex(0, velTmpA.tex);
      gl.uniform1f(pAdvect.U('uDt'), -dt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, vel.write.fbo);
      gl.useProgram(pCorrVel.prog);
      bindTex(0, vel.read.tex); bindTex(1, velTmpA.tex); bindTex(2, velTmpB.tex);
      gl.uniform1i(pCorrVel.U('uOrig'), 0);
      gl.uniform1i(pCorrVel.U('uFwd'), 1);
      gl.uniform1i(pCorrVel.U('uBack'), 2);
      gl.uniform2f(pCorrVel.U('uSimTexel'), tx, ty);
      gl.uniform1f(pCorrVel.U('uDt'), dt);
      gl.uniform1f(pCorrVel.U('uDiss'), Math.exp(-0.35 * dt));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      vel.swap();

      // 2 — curl of the velocity field.
      gl.bindFramebuffer(gl.FRAMEBUFFER, curl.fbo);
      gl.useProgram(pCurl.prog);
      bindTex(0, vel.read.tex);
      gl.uniform1i(pCurl.U('uVel'), 0);
      gl.uniform2f(pCurl.U('uTexel'), tx, ty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 3 — forces: confinement + buoyancy + wind + beat kick.
      gl.bindFramebuffer(gl.FRAMEBUFFER, vel.write.fbo);
      gl.useProgram(pForces.prog);
      bindTex(0, vel.read.tex);
      bindTex(1, curl.tex);
      bindTex(2, thermo.read.tex);
      gl.uniform1i(pForces.U('uVel'), 0);
      gl.uniform1i(pForces.U('uCurl'), 1);
      gl.uniform1i(pForces.U('uThermo'), 2);
      gl.uniform2f(pForces.U('uTexel'), tx, ty);
      gl.uniform1f(pForces.U('uDt'), dt);
      gl.uniform1f(pForces.U('uBuoy'),    110 * scratch.height);
      gl.uniform1f(pForces.U('uWeight'),  38 * scratch.smoke);
      gl.uniform1f(pForces.U('uCurlAmt'), 4.0 * scratch.turb);
      gl.uniform1f(pForces.U('uWind'),    scratch.wind);
      gl.uniform1f(pForces.U('uKick'),    scratch.kick);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      vel.swap();

      // 3b — wrist momentum splats (pre-projection, so the pressure solve
      // turns the injected push into swirl).
      for (let i = 0; i < splats.length; i++) {
        const s = splats[i];
        if (!s.on) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, vel.write.fbo);
        gl.useProgram(pSplat.prog);
        bindTex(0, vel.read.tex);
        gl.uniform1i(pSplat.U('uVel'), 0);
        gl.uniform2f(pSplat.U('uPoint'), s.x, s.y);
        gl.uniform2f(pSplat.U('uDir'), s.fx, s.fy);
        gl.uniform1f(pSplat.U('uRadius'), 0.06);
        gl.uniform1f(pSplat.U('uAspect'), W / H);
        gl.uniform1f(pSplat.U('uBlend'), Math.min(1, dt * 10));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        vel.swap();
      }

      // 4 — divergence of the forced field.
      gl.bindFramebuffer(gl.FRAMEBUFFER, div.fbo);
      gl.useProgram(pDiv.prog);
      bindTex(0, vel.read.tex);
      gl.uniform1i(pDiv.U('uVel'), 0);
      gl.uniform2f(pDiv.U('uTexel'), tx, ty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 5 — Jacobi pressure relaxation. Previous frame's pressure is the
      // warm start, so ~22 sweeps converge plenty for a visual solve.
      gl.useProgram(pJacobi.prog);
      gl.uniform1i(pJacobi.U('uPressure'), 0);
      gl.uniform1i(pJacobi.U('uDiv'), 1);
      gl.uniform2f(pJacobi.U('uTexel'), tx, ty);
      bindTex(1, div.tex);
      for (let i = 0; i < JACOBI_ITERS; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.write.fbo);
        bindTex(0, pressure.read.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        pressure.swap();
      }

      // 6 — subtract ∇p → divergence-free velocity.
      gl.bindFramebuffer(gl.FRAMEBUFFER, vel.write.fbo);
      gl.useProgram(pGrad.prog);
      bindTex(0, vel.read.tex);
      bindTex(1, pressure.read.tex);
      gl.uniform1i(pGrad.U('uVel'), 0);
      gl.uniform1i(pGrad.U('uPressure'), 1);
      gl.uniform2f(pGrad.U('uTexel'), tx, ty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      vel.swap();

      // 7 — thermo MacCormack legs at dye res (back-traced through the
      // projected velocity), then the react/inject pass with correction.
      gl.viewport(0, 0, DW, DH);
      gl.useProgram(pAdvect.prog);
      gl.uniform1i(pAdvect.U('uSrc'), 0);
      gl.uniform1i(pAdvect.U('uVel'), 1);
      gl.uniform2f(pAdvect.U('uSimTexel'), tx, ty);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dyeTmpA.fbo);
      bindTex(0, thermo.read.tex); bindTex(1, vel.read.tex);
      gl.uniform1f(pAdvect.U('uDt'), dt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dyeTmpB.fbo);
      bindTex(0, dyeTmpA.tex);
      gl.uniform1f(pAdvect.U('uDt'), -dt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, thermo.write.fbo);
      gl.useProgram(pThermo.prog);
      bindTex(0, thermo.read.tex);
      bindTex(1, dyeTmpA.tex);
      bindTex(2, dyeTmpB.tex);
      bindTex(3, vel.read.tex);
      gl.uniform1i(pThermo.U('uOrig'), 0);
      gl.uniform1i(pThermo.U('uFwd'), 1);
      gl.uniform1i(pThermo.U('uBack'), 2);
      gl.uniform1i(pThermo.U('uVel'), 3);
      gl.uniform2f(pThermo.U('uSimTexel'), tx, ty);
      gl.uniform2f(pThermo.U('uDyeTexel'), 1 / DW, 1 / DH);
      gl.uniform1f(pThermo.U('uDt'), dt);
      gl.uniform1f(pThermo.U('uTime'), scratch.time);
      gl.uniform1f(pThermo.U('uIntensity'), scratch.intensity);
      gl.uniform1f(pThermo.U('uBurn'), 7.0);
      gl.uniform1f(pThermo.U('uHeat'), 2.0);
      gl.uniform1f(pThermo.U('uSmokeGain'), 0.45 * scratch.smoke);
      gl.uniform1f(pThermo.U('uCool'), 2.7 / Math.max(0.35, Math.pow(scratch.height, 0.7)));
      gl.uniform1f(pThermo.U('uSmokeFade'), 0.7);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      thermo.swap();
    }

    function drawEmbers() {
      if (emberCount === 0) return;
      gl.useProgram(pEmber.prog);
      gl.uniform1f(pEmber.U('uPtScale'), H / 540);
      gl.uniform1i(pEmber.U('uPalette'), scratch.palette);
      gl.bindBuffer(gl.ARRAY_BUFFER, emberVbo);
      // Whole-buffer upload (3.2 KB) — avoids a per-frame subarray view.
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vboData);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, EMBER_STRIDE * 4, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, EMBER_STRIDE * 4, 8);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, emberCount);
      gl.disable(gl.BLEND);
      gl.disableVertexAttribArray(0);
      gl.disableVertexAttribArray(1);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    function render() {
      if (!W || !H) return;
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      if (simOk) runSim();

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pRender.prog);
      if (simOk) {
        bindTex(0, thermo.read.tex);
        gl.uniform1i(pRender.U('uThermo'), 0);
        gl.uniform2f(pRender.U('uDyeTexel'), 1 / DW, 1 / DH);
        gl.uniform1f(pRender.U('uShimmer'),  scratch.shimmer);
        gl.uniform1f(pRender.U('uSmokeVis'), scratch.smoke);
      } else {
        gl.uniform1f(pRender.U('uHeight'), scratch.height);
        gl.uniform1f(pRender.U('uTurb'),   scratch.turb);
        gl.uniform1f(pRender.U('uWind'),   scratch.wind);
        gl.uniform1f(pRender.U('uKick'),   scratch.kick);
      }
      gl.uniform1f(pRender.U('uTime'),      scratch.time);
      gl.uniform1f(pRender.U('uIntensity'), scratch.intensity);
      gl.uniform1i(pRender.U('uPalette'),   scratch.palette);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);

      drawEmbers();
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        // Grid width follows aspect — realloc (and restart) the sim only
        // when it actually changes; the fire re-lights in under a second.
        const newSW = Math.max(16, Math.round(SIM_H * (W / H || 1)));
        if (newSW !== SW || !simOk) allocGrids();
      },
      update,
      render,
      dispose() {
        freeDouble(vel); freeDouble(thermo); freeDouble(pressure);
        freeTarget(curl); freeTarget(div);
        freeTarget(velTmpA); freeTarget(velTmpB); freeTarget(dyeTmpA); freeTarget(dyeTmpB);
        gl.deleteBuffer(emberVbo);
        gl.deleteProgram(pRender.prog);
        gl.deleteProgram(pEmber.prog);
        if (sim) for (const k in sim) gl.deleteProgram(sim[k].prog);
        gl.deleteVertexArray(vao);
      },
    };
  },
};
