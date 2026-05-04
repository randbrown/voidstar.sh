// Fractal — infinite-zoom Mandelbrot in a fullscreen fragment shader.
// JS holds the zoom state and target point; the shader does the iteration
// per pixel with smooth-iteration colouring. When zoom hits the precision
// floor we snap to the next target so the loop is endless.
//
// Audio map:
//   bass  → brightness pump + radial vignette pull-out
//   mids  → palette hue rotation + iteration-count ramp
//   highs → fine sparkle (per-pixel noise modulation)
//   beat  → flare flash over the whole frame
//
// Single-precision floats die around zoom ≈ 1e-7; deep zoom needs
// double-double tricks that aren't worth the cost on a fullscreen-tri
// fragment shader. The endless-loop pattern (advance through canonical
// deep-zoom targets) hides the depth limit in practice.

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
uniform vec2  uCenter;        // current target point in c-plane
uniform float uZoom;          // half-width of the view window in c-plane
uniform float uMaxIter;       // float so we can ease it with audio
uniform int   uPalette;       // 0 voidstar, 1 inferno, 2 ambient_cyan,
                              // 3 ambient_violet, 4 mono_void
uniform float uHueShift;      // [-0.5, +0.5] palette rotation
uniform float uFlare;         // [0..1] beat flash intensity
uniform float uSparkle;       // [0..1] highs noise modulation

uniform vec4  uBands;         // (bass, mids, highs, total)
uniform vec2  uBeat;          // (active, pulse)
uniform vec2  uMids;          // (active, pulse)
uniform vec2  uHighs;         // (active, pulse)
uniform float uRms;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// 1D ramp through one of five palettes, sampled with t in [0,1]. The
// pal argument is the same uPalette index — branchless via mix() chains
// is overkill on a single fragment, so a switch is fine.
vec3 palette(int pal, float t) {
  // Map shifted t through palette anchors. Each palette is a 4-stop ramp.
  vec3 a, b, c, d;
  if (pal == 0) {            // voidstar — deep blue → cyan → soft white
    a = vec3(0.02, 0.04, 0.10);
    b = vec3(0.05, 0.30, 0.55);
    c = vec3(0.40, 0.85, 1.00);
    d = vec3(0.95, 0.98, 1.00);
  } else if (pal == 1) {     // inferno — black → red → orange → yellow
    a = vec3(0.02, 0.00, 0.02);
    b = vec3(0.55, 0.05, 0.05);
    c = vec3(1.00, 0.45, 0.10);
    d = vec3(1.00, 0.92, 0.55);
  } else if (pal == 2) {     // ambient cyan — deep teal → mint → cream
    a = vec3(0.01, 0.06, 0.10);
    b = vec3(0.05, 0.40, 0.45);
    c = vec3(0.55, 0.92, 0.85);
    d = vec3(0.95, 1.00, 0.92);
  } else if (pal == 3) {     // ambient violet — indigo → magenta → rose
    a = vec3(0.04, 0.02, 0.10);
    b = vec3(0.35, 0.10, 0.55);
    c = vec3(0.85, 0.40, 0.85);
    d = vec3(1.00, 0.85, 0.95);
  } else {                   // mono void — black → grey → pale blue
    a = vec3(0.00, 0.00, 0.00);
    b = vec3(0.18, 0.20, 0.26);
    c = vec3(0.55, 0.62, 0.75);
    d = vec3(0.92, 0.95, 1.00);
  }
  // Three-segment piecewise lerp gives smoother gradients than a single
  // mix from a to d.
  if      (t < 0.33) return mix(a, b, t / 0.33);
  else if (t < 0.66) return mix(b, c, (t - 0.33) / 0.33);
  else               return mix(c, d, (t - 0.66) / 0.34);
}

void main() {
  vec2 res    = uResolution;
  float aspect = res.x / max(res.y, 1.0);

  // c-plane coordinate. uZoom is the half-height of the view; multiply x
  // by aspect so circles in c-plane look circular on a wide viewport.
  vec2 uv01 = vUv;
  vec2 c = uCenter + vec2((uv01.x - 0.5) * 2.0 * uZoom * aspect,
                          (uv01.y - 0.5) * 2.0 * uZoom);

  vec2 z = vec2(0.0);
  int  iters = int(uMaxIter);
  float i_smooth = 0.0;
  bool escaped = false;
  for (int i = 0; i < 800; i++) {
    if (i >= iters) break;
    // z = z^2 + c
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    float r2 = dot(z, z);
    if (r2 > 256.0) {
      // Smooth iteration count using log(log(|z|)) / log(2). Subtracting
      // gives a continuous t through the palette without banding.
      i_smooth = float(i) + 1.0 - log(log(sqrt(r2))) / log(2.0);
      escaped = true;
      break;
    }
  }

  vec3 col;
  if (!escaped) {
    // In-set pixel: dim toward black; palette darkest stop with a tiny
    // breathing pulse so the body isn't perfectly dead.
    col = palette(uPalette, 0.02) * (0.4 + 0.2 * sin(uTime * 0.3));
  } else {
    float t = i_smooth / uMaxIter;
    // Slow time drift through the palette + audio-driven shift.
    t = fract(t + uHueShift + uTime * 0.012);
    col = palette(uPalette, t);
    // Bass brightness pump.
    col *= 1.0 + uBands.x * 0.45;
  }

  // Per-pixel sparkle on highs — additive, tiny.
  if (uSparkle > 0.001) {
    float n = hash(uv01 * res + uTime);
    col += vec3(0.18, 0.25, 0.30) * step(0.985, n) * uSparkle;
  }

  // Beat flare: a soft full-screen wash that fades with the pulse.
  if (uFlare > 0.001) {
    vec3 flareCol = palette(uPalette, 0.85);
    col += flareCol * uFlare * 0.18;
  }

  // Vignette + tone curve.
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= aspect;
  float v = smoothstep(1.6, 0.4, length(p));
  col *= v;
  col = pow(col, vec3(0.95));
  outColor = vec4(col, 1.0);
}
`;

const PALETTES = ['voidstar', 'inferno', 'ambient_cyan', 'ambient_violet', 'mono_void'];

// Canonical deep-zoom targets — interesting points where the boundary
// stays rich for many orders of zoom. The endless-loop logic advances
// through this list each time the zoom hits the float-precision floor.
const TARGETS = {
  seahorse:    { x: -0.74364386269, y:  0.13182590271, name: 'seahorse valley' },
  mini:        { x: -0.74543,        y:  0.11301,       name: 'mini mandelbrot' },
  spiral:      { x: -0.7269,         y:  0.1889,        name: 'spiral' },
  triple:      { x: -0.088,          y:  0.654,         name: 'triple spiral' },
  elephant:    { x:  0.275,          y:  0.0,           name: 'elephant valley' },
};
const TARGET_IDS = Object.keys(TARGETS);

const ZOOM_INITIAL = 1.6;
const ZOOM_FLOOR   = 1e-7;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'fractal',
  name: 'Fractal',
  contextType: 'webgl2',

  params: [
    { id: 'target',     label: 'target',     type: 'select', options: ['cycle', ...TARGET_IDS], default: 'cycle' },
    { id: 'zoomSpeed',  label: 'zoom speed', type: 'range', min: 0,    max: 2,   step: 0.02, default: 0.55 },
    { id: 'iterations', label: 'iterations', type: 'range', min: 60,   max: 400, step: 10,   default: 220 },
    { id: 'palette',    label: 'palette',    type: 'select', options: PALETTES, default: 'voidstar' },
    { id: 'hueDrift',   label: 'hue drift',  type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.35 },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0,    max: 2,   step: 0.05, default: 1.0 },
  ],

  // Auto cycles palettes — the zoom motion already provides visual drift,
  // so a slow palette march is enough to keep the auto button useful.
  autoCycle: {
    steps: [
      { palette: 'voidstar' },
      { palette: 'ambient_cyan' },
      { palette: 'ambient_violet' },
      { palette: 'mono_void' },
      { palette: 'inferno' },
    ],
  },

  presets: {
    default:        { target: 'cycle', zoomSpeed: 0.55, iterations: 220, palette: 'voidstar',       hueDrift: 0.35, reactivity: 1.0 },
    deep_voidstar:  { target: 'spiral', zoomSpeed: 0.40, iterations: 320, palette: 'voidstar',      hueDrift: 0.20 },
    inferno_dive:   { target: 'mini',   zoomSpeed: 0.85, iterations: 260, palette: 'inferno',       hueDrift: 0.50 },
    ambient_drift:  { target: 'seahorse', zoomSpeed: 0.30, iterations: 200, palette: 'ambient_cyan', hueDrift: 0.15 },
    monochrome:     { target: 'cycle',  zoomSpeed: 0.60, iterations: 240, palette: 'mono_void',     hueDrift: 0.10 },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    let W = canvas.width, H = canvas.height;

    // Endless-loop state.
    let zoom = ZOOM_INITIAL;
    let cycleIdx = 0;
    let centerX = TARGETS[TARGET_IDS[0]].x;
    let centerY = TARGETS[TARGET_IDS[0]].y;
    // Slow audio-modulated hue offset; integrates over time so a sustained
    // mids passage rotates the palette continuously rather than jittering.
    let hueAccum = 0;

    let audioRef = null;
    const scratch = {
      time: 0,
      zoomSpeed: 0.55, iterations: 220, hueDrift: 0.35,
      palette: 0, target: 'cycle',
    };

    function pickTarget(name) {
      const t = TARGETS[name];
      if (!t) return;
      centerX = t.x;
      centerY = t.y;
    }

    function update(field) {
      const { dt, time, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;
      scratch.time       = time;
      scratch.zoomSpeed  = params.zoomSpeed;
      scratch.iterations = params.iterations;
      scratch.hueDrift   = params.hueDrift;
      scratch.palette    = Math.max(0, PALETTES.indexOf(params.palette));

      // Target switching. 'cycle' steps through all targets when zoom resets;
      // a named target stays put.
      if (params.target !== scratch.target) {
        scratch.target = params.target;
        zoom = ZOOM_INITIAL;
        if (params.target === 'cycle') {
          pickTarget(TARGET_IDS[cycleIdx % TARGET_IDS.length]);
        } else {
          pickTarget(params.target);
        }
      }

      // Exponential zoom — multiplying by (1 - k*dt) compounds smoothly
      // across frames regardless of rate. Beat slightly accelerates the
      // dive for a kick-driven pump.
      const speed = scratch.zoomSpeed * (1.0 + audio.beat.pulse * 0.6);
      zoom *= Math.max(0.001, 1.0 - speed * dt);
      if (zoom < ZOOM_FLOOR) {
        // Snap to the next target (or the same one if pinned).
        zoom = ZOOM_INITIAL;
        if (scratch.target === 'cycle') {
          cycleIdx++;
          pickTarget(TARGET_IDS[cycleIdx % TARGET_IDS.length]);
        }
      }

      // Audio-driven hue drift. Mids pump rotates the palette; the param
      // sets the strength so the user can dial it down for a still palette.
      hueAccum += dt * (0.0 + audio.bands.mids * 0.6) * scratch.hueDrift;
      hueAccum = ((hueAccum % 1) + 1) % 1;
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform1f(U('uTime'),       scratch.time);
      gl.uniform2f(U('uCenter'),     centerX, centerY);
      gl.uniform1f(U('uZoom'),       zoom);
      gl.uniform1f(U('uMaxIter'),    scratch.iterations);
      gl.uniform1i(U('uPalette'),    scratch.palette);
      gl.uniform1f(U('uHueShift'),   hueAccum);
      gl.uniform1f(U('uFlare'),      audioRef ? audioRef.beat.pulse : 0);
      gl.uniform1f(U('uSparkle'),    audioRef ? audioRef.bands.highs : 0);

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
