// Anomaly — fullscreen-fragment raymarched volumetric "anomaly" — a domain-
// warped procedural blob with an iridescent shell, sitting in front of a
// star-flecked void. Inspired by Shadertoy-style raymarchers; built on the
// same fullscreen-tri webgl2 path as singularity-lens.
//
// Modulation map (declarative — see `modulators` on params below):
//   audio.mids       → warp        (mid-band drives domain warp amount)
//   audio.beatPulse  → warp        (kick gives a brief domain ripple)
//   audio.highs      → glow        (cymbal sparkle on the iridescent rim)
//   audio.beatPulse  → glow        (kick punches the rim)
// Inline (non-param):
//   shader-side bass → camera dolly nudge
//   pose head xy → smoothed look-direction (in update(), not via modulation)

import { compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter, uploadAudioUniforms } from '../webgl.js';
import { scaleAudio } from '../field.js';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform float uWarp;          // domain warp amount (0..2)
uniform float uTimeScale;     // animation speed (0.1..2)
uniform float uGlow;          // iridescent shell brightness (0..3)
uniform int   uMarchSteps;    // raymarch iteration count (32..96)
uniform int   uPalette;       // 0..3
uniform vec2  uLook;          // smoothed look direction in [-1,1]^2 (pose-biased)

// Audio uniforms (shared shape with all qualia webgl fx).
uniform vec4  uBands;         // (bass, mids, highs, total)
uniform vec2  uBeat;          // (active, pulse)
uniform vec2  uMids;
uniform vec2  uHighs;
uniform float uRms;

// ── noise primitives ────────────────────────────────────────────────────
float hash(vec3 p) {
  p = fract(p * vec3(123.34, 456.21, 789.01));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash(i);
  float n100 = hash(i + vec3(1, 0, 0));
  float n010 = hash(i + vec3(0, 1, 0));
  float n110 = hash(i + vec3(1, 1, 0));
  float n001 = hash(i + vec3(0, 0, 1));
  float n101 = hash(i + vec3(1, 0, 1));
  float n011 = hash(i + vec3(0, 1, 1));
  float n111 = hash(i + vec3(1, 1, 1));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}
// 3-octave fbm. (Was 4 — but the inner raymarch loop calls this 4x per
// step so each octave dropped is a real perf win, and the 4th octave's
// detail is barely visible through the warp anyway.)
float fbm(vec3 p) {
  float a = 0.5, t = 0.0;
  for (int i = 0; i < 3; i++) {
    t += a * noise3(p);
    p = p * 2.04 + vec3(13.1, 17.3, 19.7);
    a *= 0.5;
  }
  return t;
}

// Domain-warp: nudges the sample position by a single-octave noise per
// axis. Single-octave (not fbm) is intentional — fbm here would balloon
// the per-march-step hash count and the warp's role is large-scale shape
// distortion, not fine detail. Visual character from this 3-axis vector
// noise is what makes the blob "fluidy" without a true curl field.
vec3 warpPos(vec3 p, float t, float amount) {
  vec3 w1 = vec3(
    noise3(p + vec3(0.0, 0.0, t * 0.30)),
    noise3(p + vec3(7.1, 3.2, t * 0.27)),
    noise3(p + vec3(2.4, 9.8, t * 0.31))
  );
  return p + (w1 - 0.5) * amount;
}

// Smooth blob SDF — heart of the anomaly. Returns the distance to a
// noise-modulated sphere; the warp arg lets the shape pulse without bumping
// the shell scale.
float sdfAnomaly(vec3 p, float t, float warp) {
  vec3 q = warpPos(p, t * 0.6, warp);
  float r = length(q);
  // Deep noise for shell undulation.
  float n = fbm(q * 1.4 + vec3(0.0, 0.0, t * 0.15));
  float baseR = 1.05 + 0.30 * (n - 0.5);
  // Audio-driven shell tension.
  baseR += uBeat.y * 0.18 + uBands.x * 0.12;
  return r - baseR;
}

vec3 normal(vec3 p, float t, float warp) {
  // Tetrahedral-offset gradient. Cheap, robust enough for our soft surface.
  const float h = 0.0025;
  const vec2 k = vec2(1, -1);
  return normalize(
    k.xyy * sdfAnomaly(p + k.xyy * h, t, warp) +
    k.yyx * sdfAnomaly(p + k.yyx * h, t, warp) +
    k.yxy * sdfAnomaly(p + k.yxy * h, t, warp) +
    k.xxx * sdfAnomaly(p + k.xxx * h, t, warp)
  );
}

vec3 paletteColor(int idx, float t) {
  if (idx == 0) return mix(vec3(0.05, 0.10, 0.30), vec3(0.30, 0.95, 1.00), t);   // void cyan
  if (idx == 1) return mix(vec3(0.18, 0.04, 0.20), vec3(1.00, 0.45, 0.95), t);   // ultraviolet
  if (idx == 2) return mix(vec3(0.30, 0.04, 0.02), vec3(1.00, 0.85, 0.20), t);   // lava
  return            mix(vec3(0.04, 0.18, 0.10), vec3(0.50, 1.00, 0.65), t);      // toxic green
}

// Tiny lensed-space starfield behind the anomaly (so when raymarch misses,
// we still draw something interesting).
vec3 starfield(vec2 q) {
  vec3 col = vec3(0.0);
  for (float i = 0.0; i < 3.0; i++) {
    float scale = 7.0 + i * 13.0;
    vec2 g = q * scale;
    vec2 cell = floor(g);
    vec2 local = fract(g) - 0.5;
    float h = fract(sin(dot(cell + i * 17.31, vec2(12.989, 78.233))) * 43758.5453);
    float starP = step(0.987 - i * 0.005, h);
    float r = length(local);
    float core = exp(-r * r * (60.0 + i * 80.0));
    float twink = 0.7 + 0.3 * sin(uTime * (1.5 + i) + h * 30.0);
    col += vec3(core * starP * twink) * (0.5 + 0.5 * (1.0 - i / 3.0));
  }
  return col;
}

void main() {
  vec2 res = uResolution;
  vec2 uv  = (vUv - 0.5);
  uv.x *= res.x / res.y;

  float t = uTime * uTimeScale;

  // Camera at fixed distance, looking at origin. Pose nudges look-direction.
  vec3 ro = vec3(uLook.x * 0.7, -uLook.y * 0.5, -3.4 - uBands.x * 0.4);
  vec3 ta = vec3(0.0);
  vec3 fwd = normalize(ta - ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up    = cross(fwd, right);
  vec3 rd    = normalize(uv.x * right + uv.y * up + 1.5 * fwd);

  // Background starfield in screen-aligned space.
  vec3 bg = starfield(uv * 1.2);
  // Subtle nebula.
  float neb = fbm(vec3(uv * 1.8, t * 0.10));
  bg += paletteColor(uPalette, 0.35) * smoothstep(0.45, 0.95, neb) * 0.18;

  // Raymarch.
  float warp = uWarp + uMids.y * 0.5 + uHighs.y * 0.25;
  vec3 p = ro;
  float dist = 0.0;
  bool hit = false;
  int steps = uMarchSteps;
  for (int i = 0; i < 96; i++) {
    if (i >= steps) break;
    float d = sdfAnomaly(p, t, warp);
    if (d < 0.002) { hit = true; break; }
    if (dist > 8.0) break;
    p += rd * d * 0.75;
    dist += d * 0.75;
  }

  vec3 col;
  if (hit) {
    vec3 n = normal(p, t, warp);
    // View-dependent iridescence — angle drives palette sweep.
    float fres = pow(1.0 - max(0.0, -dot(rd, n)), 2.0);
    float irid = 0.5 + 0.5 * sin(6.0 * fres + t * 0.5 + p.x * 1.7 + p.y * 1.3);
    vec3 base = paletteColor(uPalette, irid);
    // Inner glow term — light from origin leaks out softly.
    float inner = exp(-length(p) * 1.3);
    col = base * (0.45 + 0.85 * fres) + paletteColor(uPalette, 0.85) * inner * 0.45;
    // Audio-driven rim glow.
    col += paletteColor(uPalette, 1.0) * fres * fres * (uGlow * 0.8 + uHighs.y * 0.6 + uBeat.y * 1.0);
  } else {
    col = bg;
    // Beat shockwave — concentric ring radiating from screen center.
    float r2 = length(uv);
    float swR = 0.5 + 1.4 * pow(uBeat.y, 0.5);
    float sw  = exp(-pow((r2 - swR) / 0.07, 2.0)) * uBeat.y * 0.7;
    col += paletteColor(uPalette, 0.95) * sw;
  }

  // Mild vignette + tone curve.
  float v = smoothstep(1.5, 0.4, length(uv));
  col *= v;
  col = pow(col, vec3(0.92));
  outColor = vec4(col, 1.0);
}
`;

const PALETTES   = ['voidcyan', 'ultraviolet', 'lava', 'toxic'];
const STEP_OPTS  = ['32', '48', '64', '96'];

// Anomaly used to paint the raymarch into a half-res (0.5×) offscreen target
// and linear-upscale it to the canvas — cheap, but the upscale softened the
// iridescent rim and left the shell edges chunky/aliased. It now raymarches
// straight to the canvas at full backing resolution (one pass, like
// singularity-lens), so every edge is crisp. To keep the extra fragment cost
// bounded on hi-DPI displays, the quale caps its own DPR below (`maxDpr`);
// the `March steps` param remains the perf valve if a weak GPU needs relief.

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'anomaly',
  name: 'Anomaly',
  contextType: 'webgl2',
  // Fragment-bound raymarcher: render crisp at up to 1.25× device pixels
  // rather than the global 1.5× cap, trading a little supersampling for the
  // full-resolution quality bump (still far sharper than the old 0.5× path).
  maxDpr: 1.25,

  params: [
    { id: 'warp',       label: 'Warp',         type: 'range', min: 0, max: 2, step: 0.02, default: 0.7,
      modulators: [
        { source: 'audio.mids',      mode: 'mul', amount: 0.40 },
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.30 },
        { source: 'crowd.energy',    mode: 'mul', amount: 0.40 },
      ] },
    { id: 'glow',       label: 'Rim glow',     type: 'range', min: 0, max: 3, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.highs',     mode: 'mul', amount: 0.40 },
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.50 },
        { source: 'crowd.rise',      mode: 'mul', amount: 0.35 },
      ] },
    { id: 'timeScale',  label: 'Time scale',   type: 'range', min: 0.1, max: 2, step: 0.02, default: 0.6 },
    { id: 'marchSteps', label: 'March steps',  type: 'select', options: STEP_OPTS, default: '64' },
    { id: 'palette',    label: 'Palette',      type: 'select', options: PALETTES, default: 'voidcyan' },
    { id: 'poseTrack',  label: 'pose tracks',  type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity',   type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks the palettes alongside paired warp/glow tuning so each
  // step has its own personality (cool wisps → ultraviolet density → lava
  // bloom → sparse toxic). Mirrors the four presets below.
  autoPhase: {
    steps: [
      { palette: 'voidcyan',    warp: 0.70, glow: 1.0 },
      { palette: 'ultraviolet', warp: 1.20, glow: 1.6 },
      { palette: 'lava',        warp: 0.95, glow: 2.0 },
      { palette: 'toxic',       warp: 0.35, glow: 0.6 },
    ],
  },

  presets: {
    default: { warp: 0.70, glow: 1.0, timeScale: 0.6,  marchSteps: '64', palette: 'voidcyan',    reactivity: 1.0 },
    dense:   { warp: 1.20, glow: 1.6, timeScale: 0.45, marchSteps: '96', palette: 'ultraviolet' },
    sparse:  { warp: 0.35, glow: 0.6, timeScale: 0.85, marchSteps: '32', palette: 'toxic' },
    lava:    { warp: 0.95, glow: 2.0, timeScale: 0.50, marchSteps: '64', palette: 'lava' },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    let W = canvas.width, H = canvas.height;

    let lookX = 0, lookY = 0;             // smoothed pose-biased look direction

    let scratch = {
      time: 0, warp: 0.7, glow: 1.0, timeScale: 0.6,
      marchSteps: 64, palette: 0,
    };
    let audioRef = null;

    function update(field) {
      const { dt, time, pose, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;
      scratch.time       = time;
      scratch.warp       = params.warp;
      scratch.glow       = params.glow;
      scratch.timeScale  = params.timeScale;
      scratch.marchSteps = parseInt(params.marchSteps, 10) || 64;
      scratch.palette    = Math.max(0, PALETTES.indexOf(params.palette));

      // Pose-driven look — head x/y nudge the camera a bit. Smoothed in
      // here, not via modulation, so high-frequency landmark jitter doesn't
      // jiggle the camera frame to frame.
      let tx = 0, ty = 0;
      if (params.poseTrack && pose.people.length > 0) {
        const p0 = pose.people[0];
        if (p0.head && p0.head.visibility > 0.3) {
          // Camera frames are mirrored — flip back so right-on-screen feels right.
          tx = (1.0 - p0.head.x) * 2.0 - 1.0;
          ty = p0.head.y * 2.0 - 1.0;
        }
      }
      const k = Math.min(1, dt * 4.0);
      lookX += (tx - lookX) * k;
      lookY += (ty - lookY) * k;
    }

    function render() {
      // Single pass: raymarch straight to the canvas at full backing
      // resolution (no downscaled FBO, no upscale blur).
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform1f(U('uTime'),       scratch.time);
      gl.uniform1f(U('uWarp'),       scratch.warp);
      gl.uniform1f(U('uGlow'),       scratch.glow);
      gl.uniform1f(U('uTimeScale'),  scratch.timeScale);
      gl.uniform1i(U('uMarchSteps'), scratch.marchSteps);
      gl.uniform1i(U('uPalette'),    scratch.palette);
      gl.uniform2f(U('uLook'),       lookX, lookY);
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
