// No Man's Land — an original, slow-moving threshold landscape commissioned
// for the Knoxville Museum of Art exhibition opening. The quale borrows no
// imagery: procedural mineral strata, an ambiguous luminous seam, and fine
// transmission filaments hold the space between landscape, body, and signal.
//
// Performance intent:
//   - built for a two-hour ambient museum set; no flashes, cuts, or camera shake
//   - audio changes colour, patina, and afterglow only — never scale/position
//   - pose is relative-only and averaged across every tracked performer
//   - the shared overlay remains responsible for drawing every skeleton
//
// Audio map (all additionally low-passed in JS before reaching the shader):
//   bass              -> warm earth/mineral stain
//   mids              -> violet/copper chromatic veil
//   highs             -> cool silver edge patina
//   beat pulse        -> a very small, long-decay afterglow (never a flash)
//   pitch class       -> slowly held spectral tint for guitar/pedal steel
//
// Relative pose map (averaged over all visible people, then heavily smoothed):
//   wrist spread      -> seam permeability / chromatic exchange
//   shoulder roll     -> slight field-grain bias (not screen position)
//   head pitch        -> lower/upper atmosphere exchange

import {
  compileProgram,
  makeFullscreenTri,
  FULLSCREEN_VERT,
  makeUniformGetter,
} from '../webgl.js';
import { scaleAudio } from '../field.js';
import {
  poseConfidence,
  poseHeadPitch,
  poseShoulderRoll,
  poseWristSpread,
} from '../pose-features.js';

const FRAG = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform float uDrift;
uniform float uContours;
uniform float uPermeability;
uniform float uFilaments;
uniform float uExposure;
uniform float uChromaticVeil;
uniform int   uPalette;
uniform vec4  uAudio;       // bass, mids, highs, long-decay afterglow
uniform vec3  uGesture;     // wrist spread, shoulder roll, head pitch
uniform vec2  uPitchPhase;  // circularly-smoothed pitch class (cos, sin)
uniform float uPitchConf;

const float TAU = 6.28318530718;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Three octaves are enough for broad mineral grain without making the
// fullscreen pass fragment-bound on an integrated GPU.
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 3; i++) {
    sum += amp * noise2(p);
    p = mat2(1.61, 1.18, -1.18, 1.61) * p + vec2(7.13, 3.71);
    amp *= 0.48;
  }
  return sum;
}

mat2 rotate2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

void palette(int idx, out vec3 night, out vec3 earth, out vec3 bloom, out vec3 silver) {
  if (idx == 1) { // mineral dusk
    night  = vec3(0.010, 0.012, 0.020);
    earth  = vec3(0.32, 0.13, 0.080);
    bloom  = vec3(0.48, 0.19, 0.34);
    silver = vec3(0.76, 0.82, 0.78);
  } else if (idx == 2) { // afterlight
    night  = vec3(0.008, 0.012, 0.026);
    earth  = vec3(0.12, 0.24, 0.28);
    bloom  = vec3(0.40, 0.22, 0.55);
    silver = vec3(0.70, 0.90, 0.92);
  } else if (idx == 3) { // silver quiet
    night  = vec3(0.008, 0.009, 0.012);
    earth  = vec3(0.14, 0.15, 0.16);
    bloom  = vec3(0.28, 0.30, 0.33);
    silver = vec3(0.86, 0.88, 0.86);
  } else { // liminal — concrete, river-dark teal, muted ember
    night  = vec3(0.008, 0.012, 0.021);
    earth  = vec3(0.19, 0.17, 0.14);
    bloom  = vec3(0.18, 0.35, 0.38);
    silver = vec3(0.78, 0.83, 0.79);
  }
}

float contourLine(float field, float frequency) {
  float phase = abs(fract(field * frequency) - 0.5);
  float width = max(fwidth(field * frequency), 0.0025);
  return 1.0 - smoothstep(width * 0.55, width * 1.65, phase);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0) * 2.0;

  // Pose never supplies absolute x/y. Relative roll biases the grain by at
  // most a few degrees; the slow filter in JS makes restricted playing pose
  // feel like pressure on the field rather than puppeteering.
  vec2 q = rotate2(uGesture.y * 0.045) * p;
  float t = uTime * (0.010 + uDrift * 0.026);

  float broad = fbm(q * vec2(0.72, 1.05) + vec2(t, -t * 0.37));
  float cross = fbm(rotate2(-0.58) * q * 1.42 + vec2(-t * 0.31, t * 0.21));
  float grain = mix(broad, cross, 0.38);

  // Two almost-agreeing boundaries make the unclaimed strip. Their motion
  // is autonomous and glacial; audio never enters this geometry.
  float seamCenter = -0.055
    + sin(q.x * 1.12 + t * 0.74) * 0.115
    + sin(q.x * 0.37 - t * 0.29) * 0.055
    + (broad - 0.50) * 0.105;
  float seamHalf = 0.105;
  float seamCoord = q.y - seamCenter;
  float strip = 1.0 - smoothstep(seamHalf * 0.58, seamHalf, abs(seamCoord));
  float boundary = exp(-pow((abs(seamCoord) - seamHalf) / 0.018, 2.0));

  // A remembered, nonliteral geography: overlapping contour systems do not
  // resolve to a single map. Head pitch softly trades upper/lower strata.
  float terrainA = q.y * 0.74 + grain * 0.62 + sin(q.x * 0.82 - t) * 0.075;
  float terrainB = q.y * 0.54 - cross * 0.42 + cos(q.x * 0.55 + t * 0.63) * 0.10;
  float contoursA = contourLine(terrainA, 7.0);
  float contoursB = contourLine(terrainB, 10.0);
  float upperLower = clamp(0.50 + q.y * 0.28 + uGesture.z * 0.08, 0.0, 1.0);
  float contours = mix(contoursB, contoursA, upperLower) * uContours;

  vec3 night, earth, bloom, silver;
  palette(uPalette, night, earth, bloom, silver);

  float verticalHaze = smoothstep(-1.1, 0.95, q.y);
  vec3 col = night;
  col += earth * (0.055 + grain * 0.19) * (1.0 - verticalHaze * 0.42);
  col += bloom * (0.025 + cross * 0.075) * verticalHaze;

  // The seam is a dark interval with light at its two uncertain edges.
  col *= 1.0 - strip * (0.35 - uPermeability * 0.13);
  col += mix(earth, bloom, 0.58) * boundary * (0.18 + uPermeability * 0.25);
  col += silver * contours * (0.10 + boundary * 0.20) * (1.0 - strip * 0.45);

  // Audio lives entirely in colour/patina. Values arrive on long envelopes,
  // so even a hard Strudel kick becomes a slow persistence of light.
  float bass = uAudio.x;
  float mids = uAudio.y;
  float highs = uAudio.z;
  float afterglow = uAudio.w;
  float stainMask = smoothstep(0.20, 0.88, grain) * (0.35 + boundary * 0.65);
  vec3 warmStain = mix(vec3(0.30, 0.075, 0.025), earth, 0.38);
  vec3 midStain = mix(bloom, vec3(0.38, 0.12, 0.34), 0.38);
  col += warmStain * bass * stainMask * 0.42;
  col += midStain * mids * (0.06 + cross * 0.18) * uChromaticVeil;
  col += silver * highs * (contours * 0.12 + boundary * 0.13);
  col += mix(bloom, silver, 0.42) * afterglow * boundary * 0.11;

  // Hold the guitar/steel pitch as a spectral glaze. Circular smoothing in
  // JS avoids the pitch-class wrap discontinuity at the octave.
  float pitchAngle = atan(uPitchPhase.y, uPitchPhase.x);
  vec3 pitchColour = 0.53 + 0.47 * cos(vec3(0.0, 2.094, 4.189) + pitchAngle);
  float pitchMask = uPitchConf * uChromaticVeil * (0.025 + boundary * 0.075);
  col = mix(col, col + pitchColour * 0.20, pitchMask);

  // Gesture opens exchange across the seam without moving it. The average
  // wrist spread of every tracked person is relative to their own body.
  float exchange = clamp(0.5 + 0.5 * uGesture.x, 0.0, 1.0);
  col += mix(earth, bloom, exchange) * strip
       * uPermeability * (0.022 + exchange * 0.032);

  // Fine vertical transmissions: neither signs nor architecture, just quiet
  // lines that appear to continue beyond the frame. Fixed loop, analytical
  // strokes, and no buffers keep this cheap and allocation-free.
  float filamentField = 0.0;
  float nodeField = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float seed = hash21(vec2(fi * 9.17 + 2.1, fi * 3.73 + 8.4));
    float anchor = mix(-aspect * 0.83, aspect * 0.83, seed);
    float threadX = anchor
      + sin(q.y * (1.15 + fi * 0.11) + t * (0.31 + fi * 0.07) + fi) * 0.026
      + (cross - 0.5) * 0.018;
    float d = abs(q.x - threadX);
    float stroke = 1.0 - smoothstep(0.0015, 0.0055, d);
    float breathingDash = 0.42 + 0.58 * smoothstep(
      0.18, 0.82, 0.5 + 0.5 * sin(q.y * (7.0 + fi) - t * 0.45 + fi * 2.7)
    );
    filamentField += stroke * breathingDash;

    float nodeY = mix(-0.78, 0.82, hash21(vec2(fi + 14.2, 6.9)));
    vec2 nodeP = vec2(q.x - threadX, q.y - nodeY);
    float ringD = abs(length(nodeP) - (0.010 + seed * 0.009));
    nodeField += 1.0 - smoothstep(0.0012, 0.0045, ringD);
  }
  float filamentAmount = uFilaments * (0.28 + uPermeability * 0.25);
  col += silver * filamentField * filamentAmount * 0.17;
  col += mix(silver, bloom, 0.32) * nodeField * filamentAmount * 0.22;

  // Sparse, static mineral flecks inside the interval. No temporal hash = no
  // high-frequency sparkle or projector shimmer; highs only tint the flecks.
  vec2 fleckCell = floor((q + vec2(aspect, 1.0)) * 74.0);
  float fleck = step(0.992, hash21(fleckCell)) * strip;
  col += mix(silver, vec3(0.60, 0.82, 0.88), highs * 0.55) * fleck * 0.16;

  // Museum projection finish: restrained blacks, soft vignette, no clipping.
  float vignette = smoothstep(1.48, 0.28, length(p / vec2(max(aspect, 1.0), 1.0)));
  col *= mix(0.48, 1.0, vignette);
  col *= uExposure;
  col = col / (1.0 + col * 0.72);
  col = pow(max(col, 0.0), vec3(0.94));
  outColor = vec4(col, 1.0);
}
`;

const PALETTES = ['liminal', 'mineral_dusk', 'afterlight', 'silver_quiet'];

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'no_mans_land',
  name: "No Man's Land",
  contextType: 'webgl2',
  overlayProfile: 'ambient',

  // Fullscreen procedural pass. 1x backing pixels keeps the 1080p integrated-
  // GPU target comfortable while preserving projection-scale detail.
  maxDpr: 1.0,

  params: [
    { id: 'drift', label: 'drift', type: 'range', min: 0.05, max: 1.0, step: 0.01, default: 0.22 },
    { id: 'contours', label: 'remembered contours', type: 'range', min: 0, max: 1.8, step: 0.02, default: 0.82 },
    { id: 'permeability', label: 'threshold permeability', type: 'range', min: 0, max: 1, step: 0.01, default: 0.58 },
    { id: 'filaments', label: 'transmission filaments', type: 'range', min: 0, max: 1.5, step: 0.02, default: 0.72 },
    { id: 'chromaticVeil', label: 'chromatic veil', type: 'range', min: 0, max: 1.5, step: 0.02, default: 0.62,
      modulators: [
        { source: 'audio.mids', mode: 'mul', amount: 0.24 },
        { source: 'audio.highs', mode: 'mul', amount: 0.10 },
      ] },
    { id: 'exposure', label: 'projection exposure', type: 'range', min: 0.35, max: 1.4, step: 0.01, default: 0.88 },
    { id: 'palette', label: 'field palette', type: 'select', options: PALETTES, default: 'liminal' },
    { id: 'reactivity', label: 'audio colour', type: 'range', min: 0, max: 2, step: 0.05, default: 0.9 },
    { id: 'poseReactivity', label: 'relative pose', type: 'range', min: 0, max: 2, step: 0.05, default: 0.65 },
  ],

  autoPhase: {
    steps: [
      { palette: 'liminal',      contours: 0.82, permeability: 0.58, filaments: 0.72, exposure: 0.88 },
      { palette: 'mineral_dusk', contours: 0.68, permeability: 0.48, filaments: 0.58, exposure: 0.82 },
      { palette: 'afterlight',   contours: 0.92, permeability: 0.72, filaments: 0.82, exposure: 0.90 },
      { palette: 'silver_quiet', contours: 0.55, permeability: 0.38, filaments: 0.46, exposure: 0.80 },
    ],
  },

  presets: {
    default: {
      drift: 0.22, contours: 0.82, permeability: 0.58, filaments: 0.72,
      chromaticVeil: 0.62, exposure: 0.88, palette: 'liminal',
      reactivity: 0.9, poseReactivity: 0.65,
    },
    mineral_dusk: {
      drift: 0.16, contours: 0.68, permeability: 0.48, filaments: 0.58,
      chromaticVeil: 0.72, exposure: 0.82, palette: 'mineral_dusk',
    },
    afterlight: {
      drift: 0.26, contours: 0.92, permeability: 0.72, filaments: 0.82,
      chromaticVeil: 0.78, exposure: 0.90, palette: 'afterlight',
    },
    silver_quiet: {
      drift: 0.10, contours: 0.55, permeability: 0.38, filaments: 0.46,
      chromaticVeil: 0.28, exposure: 0.80, palette: 'silver_quiet',
    },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao = makeFullscreenTri(gl);
    const U = makeUniformGetter(gl, prog);

    let W = canvas.width;
    let H = canvas.height;

    const scratch = {
      time: 0,
      drift: 0.22,
      contours: 0.82,
      permeability: 0.58,
      filaments: 0.72,
      exposure: 0.88,
      chromaticVeil: 0.62,
      palette: 0,
    };

    // Long audio envelopes. Attacks remain smooth; releases are deliberately
    // slower so room sound leaves a patina instead of pumping.
    let bass = 0;
    let mids = 0;
    let highs = 0;
    let afterglow = 0;

    // Circular pitch smoothing prevents pitchClass 0.99 -> 0.01 from taking
    // the long way around the colour wheel.
    let pitchX = 1;
    let pitchY = 0;
    let pitchConf = 0;

    // Relative-only gesture state, averaged over every sufficiently visible
    // person. Zero is the neutral field and also the graceful no-camera state.
    let gestureOpen = 0;
    let gestureRoll = 0;
    let gesturePitch = 0;

    function follow(prev, target, dt, riseSeconds, fallSeconds) {
      const tau = target > prev ? riseSeconds : fallSeconds;
      return prev + (target - prev) * (1.0 - Math.exp(-dt / tau));
    }

    function update(field) {
      const dt = field.dt;
      const params = field.params;
      const audio = scaleAudio(field.audio, params.reactivity);

      scratch.time = field.time;
      scratch.drift = params.drift;
      scratch.contours = params.contours;
      scratch.permeability = params.permeability;
      scratch.filaments = params.filaments;
      scratch.exposure = params.exposure;
      scratch.palette = Math.max(0, PALETTES.indexOf(params.palette));

      // Param modulators can move at the reactivity cadence; filter their
      // resolved value again so the colour veil stays museum-slow.
      scratch.chromaticVeil = follow(
        scratch.chromaticVeil,
        params.chromaticVeil,
        dt,
        1.2,
        2.8,
      );

      bass = follow(bass, audio.bands.bass, dt, 0.85, 3.2);
      mids = follow(mids, audio.bands.mids, dt, 1.05, 3.6);
      highs = follow(highs, audio.bands.highs, dt, 1.35, 3.0);
      const glowTarget = Math.min(1, audio.bands.total * 0.55 + audio.beat.pulse * 0.10);
      afterglow = follow(afterglow, glowTarget, dt, 1.6, 5.5);

      const rawPitchConf = (field.audio.pitchConf || 0) * Math.min(1, params.reactivity || 0);
      if (rawPitchConf > 0.12) {
        const angle = (field.audio.pitchClass || 0) * Math.PI * 2;
        const targetX = Math.cos(angle);
        const targetY = Math.sin(angle);
        const pitchK = 1.0 - Math.exp(-dt / 2.2);
        pitchX += (targetX - pitchX) * pitchK;
        pitchY += (targetY - pitchY) * pitchK;
        const pitchLength = Math.sqrt(pitchX * pitchX + pitchY * pitchY) || 1;
        pitchX /= pitchLength;
        pitchY /= pitchLength;
      }
      pitchConf = follow(pitchConf, rawPitchConf, dt, 1.4, 4.8);

      let openSum = 0;
      let rollSum = 0;
      let pitchSum = 0;
      let weightSum = 0;
      const people = field.pose?.people;
      if (people) {
        for (let i = 0; i < people.length; i++) {
          const person = people[i];
          const confidence = poseConfidence(person);
          if (confidence < 0.22) continue;
          openSum += poseWristSpread(person) * confidence;
          rollSum += poseShoulderRoll(person) * confidence;
          pitchSum += poseHeadPitch(person) * confidence;
          weightSum += confidence;
        }
      }
      const poseGain = params.poseReactivity == null ? 1 : params.poseReactivity;
      const targetOpen = weightSum > 0 ? openSum / weightSum * poseGain : 0;
      const targetRoll = weightSum > 0 ? rollSum / weightSum * poseGain : 0;
      const targetPitch = weightSum > 0 ? pitchSum / weightSum * poseGain : 0;
      const poseK = 1.0 - Math.exp(-dt / 2.4);
      gestureOpen += (targetOpen - gestureOpen) * poseK;
      gestureRoll += (targetRoll - gestureRoll) * poseK;
      gesturePitch += (targetPitch - gesturePitch) * poseK;
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0.003, 0.005, 0.010, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform1f(U('uTime'), scratch.time);
      gl.uniform1f(U('uDrift'), scratch.drift);
      gl.uniform1f(U('uContours'), scratch.contours);
      gl.uniform1f(U('uPermeability'), scratch.permeability);
      gl.uniform1f(U('uFilaments'), scratch.filaments);
      gl.uniform1f(U('uExposure'), scratch.exposure);
      gl.uniform1f(U('uChromaticVeil'), scratch.chromaticVeil);
      gl.uniform1i(U('uPalette'), scratch.palette);
      gl.uniform4f(U('uAudio'), bass, mids, highs, afterglow);
      gl.uniform3f(U('uGesture'), gestureOpen, gestureRoll, gesturePitch);
      gl.uniform2f(U('uPitchPhase'), pitchX, pitchY);
      gl.uniform1f(U('uPitchConf'), pitchConf);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    return {
      resize(w, h /*, dpr */) {
        W = w;
        H = h;
      },
      update,
      render,
      dispose() {
        gl.deleteProgram(prog);
        gl.deleteVertexArray(vao);
      },
    };
  },
};
