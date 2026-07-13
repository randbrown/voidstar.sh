// Fire — realtime combustion simulation. A 2D Eulerian fluid solver (Stam
// "stable fluids") runs entirely on the GPU via ping-pong half-float FBOs:
// semi-Lagrangian advection → combustion chemistry (fuel → heat + soot) →
// thermal buoyancy (αT − βs) → vorticity confinement → Jacobi pressure
// projection. The render pass maps temperature through a blackbody-style
// emission ramp with soot absorption, so the glow is driven by the simulated
// temperature field, not a painted gradient.
//
// The sim grid is fixed-resolution (velocity ~160 rows, thermo 2×) and
// independent of canvas size — the composite pass upscales with a small
// fbm detail warp, so cost stays flat at any viewport. maxDpr 1.0 keeps the
// fullscreen composite bounded on hi-DPI.
//
// Modulation map (declarative — see `modulators` on params below):
//   audio.bass        → intensity  (fuel feed pumps with the low end)
//   audio.beatPulse   → intensity  (kick flares the bed)
//   audio.highs       → turbulence (cymbals sharpen the eddies)
//   pose.head.x       → wind       (lean left/right bends the flames — subtle)
//   pose.wristMidY    → height     (hands rise → flames rise — subtle)
//   pose.shoulderSpan → intensity  (lean in → the fire feeds — subtle)
// Inline (non-param):
//   beat.pulse  → vertical impulse burst at the bed (percussive lick)
//   highs.pulse → composite-pass detail-warp shimmer
//
// If float render targets are unavailable (no EXT_color_buffer_float /
// _half_float) the quale degrades to a single-pass procedural fbm flame —
// same palette + emitter envelope, no solver — instead of throwing at
// create() time.

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

// ── Solver passes (all fullscreen-tri draws into sim-res FBOs) ─────────────

// Self-advect velocity, semi-Lagrangian. Velocity is stored in sim cells/sec,
// so the uv back-trace is v * dt * texel.
const ADVECT_VEL_FRAG = HEADER + /* glsl */`
uniform highp sampler2D uVel;
uniform vec2  uTexel;
uniform float uDt;
uniform float uDiss;
void main() {
  vec2 v = texture(uVel, vUv).xy;
  vec2 coord = vUv - uDt * v * uTexel;
  outColor = vec4(texture(uVel, coord).xy * uDiss, 0.0, 1.0);
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
  v.y += uKick * 240.0 * th.x * smoothstep(0.6, 0.0, vUv.y) * uDt;

  if (vUv.y < uTexel.y * 2.0) v.y = max(v.y, 0.0);
  outColor = vec4(clamp(v, vec2(-420.0), vec2(420.0)), 0.0, 1.0);
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

// Thermo field (R = temperature, G = fuel, B = soot): advect along the
// velocity field, then react. Combustion needs ignition heat (smoothstep on
// T) so fuel doesn't burn until the bed or a neighbor lights it. Cooling has
// a T² term standing in for radiative loss, so the hottest cores fade
// fastest. Injection re-seeds fuel + heat at the bed with an fbm flicker so
// the tongues wander on their own — the idle fire stays alive with audio off.
const THERMO_FRAG = HEADER + NOISE + EMITTER + /* glsl */`
uniform highp sampler2D uThermo;
uniform highp sampler2D uVel;
uniform vec2  uSimTexel;
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
  vec3 th = texture(uThermo, coord).xyz;
  float T = th.x, fuel = th.y, smoke = th.z;

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
  float flick = fbm(vec2(vUv.x * 11.0, uTime * 1.9));
  flick = 0.20 + 0.80 * smoothstep(0.40, 0.88, flick);
  float bed = smoothstep(0.04, 0.0, vUv.y);
  float src = uIntensity * band * flick * bed;
  fuel = max(fuel, src * 0.80);
  T    = max(T,    src * 1.00);

  outColor = vec4(T, fuel, smoke, 1.0);
}
`;

// Composite to screen: upscale the thermo field with an fbm detail warp
// (fine licks the coarse grid can't hold), temperature → emission ramp,
// soot absorbs (Beer-Lambert) and catches a faint fire-lit scatter.
const RENDER_FRAG = HEADER + NOISE + EMITTER + PALETTE + /* glsl */`
uniform highp sampler2D uThermo;
uniform float uTime;
uniform float uShimmer;
uniform float uSmokeVis;
uniform float uIntensity;
uniform int   uPalette;
void main() {
  vec4 base = texture(uThermo, vUv);
  float wAmp = 0.022 * (1.0 + 0.9 * uShimmer)
             * smoothstep(0.0, 0.45, base.x + base.z * 0.3);
  vec2 warp = vec2(
    fbm(vUv * vec2(6.0, 9.0) + vec2(0.0,  -uTime * 1.50)),
    fbm(vUv * vec2(6.0, 9.0) + vec2(7.31, -uTime * 1.15))
  ) - 0.5;
  vec4 th = texture(uThermo, vUv + warp * wAmp);
  float T = th.x, smoke = th.z;

  vec3 col = firePal(uPalette, T / 1.5) * smoothstep(0.02, 0.10, T);
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

// ── Module ─────────────────────────────────────────────────────────────────

const SIM_H     = 160;   // velocity / pressure grid rows
const DYE_SCALE = 2;     // thermo grid runs finer for crisper tongues
const JACOBI_ITERS = 22;
const PALETTES = ['blackbody', 'voidfire', 'cryo', 'ember'];

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
    { id: 'palette',    label: 'palette',    type: 'select', options: PALETTES, default: 'blackbody' },
    { id: 'reactivity',     label: 'reactivity',      type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'poseReactivity', label: 'pose reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { palette: 'blackbody', intensity: 1.0,  height: 1.0,  turbulence: 1.0,  smoke: 1.0, wind: 0.0 },
      { palette: 'ember',     intensity: 0.7,  height: 0.8,  turbulence: 0.75, smoke: 1.4, wind: 0.0 },
      { palette: 'voidfire',  intensity: 1.2,  height: 1.15, turbulence: 1.3,  smoke: 0.8, wind: 0.0 },
      { palette: 'cryo',      intensity: 0.9,  height: 1.05, turbulence: 1.1,  smoke: 0.9, wind: 0.25 },
    ],
  },

  presets: {
    default:  { intensity: 1.0,  height: 1.0,  turbulence: 1.0,  wind: 0.0,  smoke: 1.0, palette: 'blackbody', reactivity: 1.0, poseReactivity: 1.0 },
    campfire: { intensity: 0.65, height: 0.8,  turbulence: 0.75, wind: 0.0,  smoke: 1.3, palette: 'ember' },
    inferno:  { intensity: 1.6,  height: 1.35, turbulence: 1.5,  wind: 0.0,  smoke: 0.7, palette: 'blackbody' },
    voidfire: { intensity: 1.1,  height: 1.1,  turbulence: 1.25, wind: 0.0,  smoke: 0.9, palette: 'voidfire' },
  },

  create(canvas, { gl }) {
    // Float render targets: 16F is texture-filterable in core WebGL2 but only
    // color-renderable behind one of these extensions. Missing both (rare) →
    // procedural fallback path, never a throw mid-set.
    const floatOk = !!(gl.getExtension('EXT_color_buffer_float')
                    || gl.getExtension('EXT_color_buffer_half_float'));

    const vao = makeFullscreenTri(gl);

    function makePass(frag) {
      const prog = compileProgram(gl, FULLSCREEN_VERT, frag);
      return { prog, U: makeUniformGetter(gl, prog) };
    }

    let sim = null;      // solver passes + FBOs, or null in fallback mode
    const pRender = makePass(floatOk ? RENDER_FRAG : FALLBACK_FRAG);
    if (floatOk) {
      sim = {
        pAdvect: makePass(ADVECT_VEL_FRAG),
        pCurl:   makePass(CURL_FRAG),
        pForces: makePass(FORCES_FRAG),
        pDiv:    makePass(DIVERGENCE_FRAG),
        pJacobi: makePass(JACOBI_FRAG),
        pGrad:   makePass(GRADIENT_FRAG),
        pThermo: makePass(THERMO_FRAG),
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

    let W = 0, H = 0;                 // canvas backing buffer
    let SW = 0, SH = 0, DW = 0, DH = 0; // sim + thermo grid dims
    let vel = null, thermo = null, pressure = null, curl = null, div = null;
    let simOk = false;                // grids allocated + framebuffer-complete

    function allocGrids() {
      freeDouble(vel); freeDouble(thermo); freeDouble(pressure);
      freeTarget(curl); freeTarget(div);
      vel = thermo = pressure = curl = div = null;
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
      simOk = vel.read.ok && thermo.read.ok && pressure.read.ok && curl.ok && div.ok;
    }

    function bindTex(unit, tex) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
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
    }

    function runSim() {
      const { pAdvect, pCurl, pForces, pDiv, pJacobi, pGrad, pThermo } = sim;
      const dt = scratch.dt;
      const tx = 1 / SW, ty = 1 / SH;

      gl.viewport(0, 0, SW, SH);

      // 1 — self-advect velocity (with mild dissipation).
      gl.bindFramebuffer(gl.FRAMEBUFFER, vel.write.fbo);
      gl.useProgram(pAdvect.prog);
      bindTex(0, vel.read.tex);
      gl.uniform1i(pAdvect.U('uVel'), 0);
      gl.uniform2f(pAdvect.U('uTexel'), tx, ty);
      gl.uniform1f(pAdvect.U('uDt'), dt);
      gl.uniform1f(pAdvect.U('uDiss'), Math.exp(-0.35 * dt));
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
      gl.uniform1f(pForces.U('uBuoy'),    95 * scratch.height);
      gl.uniform1f(pForces.U('uWeight'),  38 * scratch.smoke);
      gl.uniform1f(pForces.U('uCurlAmt'), 3.4 * scratch.turb);
      gl.uniform1f(pForces.U('uWind'),    scratch.wind);
      gl.uniform1f(pForces.U('uKick'),    scratch.kick);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      vel.swap();

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

      // 7 — thermo: advect + combust + cool + inject, at dye res.
      gl.viewport(0, 0, DW, DH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, thermo.write.fbo);
      gl.useProgram(pThermo.prog);
      bindTex(0, thermo.read.tex);
      bindTex(1, vel.read.tex);
      gl.uniform1i(pThermo.U('uThermo'), 0);
      gl.uniform1i(pThermo.U('uVel'), 1);
      gl.uniform2f(pThermo.U('uSimTexel'), tx, ty);
      gl.uniform1f(pThermo.U('uDt'), dt);
      gl.uniform1f(pThermo.U('uTime'), scratch.time);
      gl.uniform1f(pThermo.U('uIntensity'), scratch.intensity);
      gl.uniform1f(pThermo.U('uBurn'), 7.0);
      gl.uniform1f(pThermo.U('uHeat'), 2.0);
      gl.uniform1f(pThermo.U('uSmokeGain'), 0.45 * scratch.smoke);
      gl.uniform1f(pThermo.U('uCool'), 2.4 / Math.max(0.35, Math.pow(scratch.height, 0.7)));
      gl.uniform1f(pThermo.U('uSmokeFade'), 0.7);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      thermo.swap();
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
        gl.deleteProgram(pRender.prog);
        if (sim) for (const k in sim) gl.deleteProgram(sim[k].prog);
        gl.deleteVertexArray(vao);
      },
    };
  },
};
