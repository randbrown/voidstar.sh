// Singularity Lens — fullscreen-fragment Schwarzschild-style lensing over a
// procedural starfield + thin accretion disk. Validates the WebGL2 path of
// the qualia harness.
//
// Audio map:
//   bass  → horizon pulse (event-horizon radius modulates with bass)
//   mids  → disk spin rate
//   highs → ring brightness
//   beat  → expanding ring shockwave
// Pose map (when present):
//   head landmark of person 0 biases the singularity centre
//   wrists inject perturbation into disk orientation

import { compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter, uploadAudioUniforms } from '../webgl.js';
import { scaleAudio } from '../field.js';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform float uHorizon;       // r_s — base horizon radius in screen units
uniform float uSpin;          // disk angular speed multiplier
uniform float uRingBoost;     // brightness multiplier on the ring
uniform vec2  uCenter;        // singularity centre, in [0,1]^2 (pose-biased)
uniform vec2  uPerturb;       // disk-orientation perturbation
uniform int   uPalette;       // 0..3 — palette index

// Audio uniforms shared with all qualia webgl fx.
uniform vec4  uBands;         // (bass, mids, highs, total)
uniform vec2  uBeat;          // (active, pulse)
uniform vec2  uHighs;         // (active, pulse)
uniform float uRms;

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

// Layered starfield rendered in lensed space — coord is the back-traced ray dir.
vec3 starfield(vec2 q) {
  vec3 col = vec3(0.0);
  float layers = 3.0;
  for (float i = 0.0; i < 3.0; i++) {
    float scale = 6.0 + i * 11.0;
    vec2 g = q * scale;
    vec2 cell = floor(g);
    vec2 local = fract(g) - 0.5;
    float h = hash(cell + i * 17.31);
    float starP = step(0.985 - i * 0.005, h);
    float r = length(local);
    float core = exp(-r * r * (60.0 + i * 80.0));
    float twink = 0.7 + 0.3 * sin(uTime * (1.5 + i) + h * 30.0);
    col += vec3(core * starP * twink) * (0.6 + 0.5 * (1.0 - i / layers));
  }
  // Subtle nebula
  float n = noise(q * 1.4 + vec2(uTime * 0.02, 0.0));
  col += vec3(0.04, 0.02, 0.10) * smoothstep(0.5, 1.0, n);
  return col;
}

vec3 paletteColor(int idx, float t) {
  // t in [0,1] — used to sweep gradients.
  if (idx == 0) return mix(vec3(0.10, 0.04, 0.0), vec3(1.0, 0.62, 0.18), t)  // accretionGold
                + vec3(0.0, 0.0, 0.06) * (1.0 - t);
  if (idx == 1) return mix(vec3(0.02, 0.06, 0.18), vec3(0.20, 0.85, 1.0), t); // voidblue
  if (idx == 2) return mix(vec3(0.10, 0.02, 0.20), vec3(0.95, 0.30, 0.85), t); // neuralMagenta
  return            mix(vec3(0.18, 0.04, 0.02), vec3(1.0, 0.45, 0.10), t);     // plasmaOrange
}

void main() {
  vec2 res = uResolution;
  // Centre-relative, aspect-corrected screen coord in [-1,1] ~ish.
  vec2 c = (uCenter - 0.5) * 2.0 * vec2(res.x / res.y, 1.0);
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= res.x / res.y;
  p -= c;

  float r = length(p);
  // Audio-modulated horizon radius. uHorizon is the slider value; bass + beat
  // pulse the horizon outward briefly. Capped so the screen never goes black.
  float r_s = uHorizon * (1.0 + uBands.x * 0.45 + uBeat.y * 0.55);
  r_s = min(r_s, 0.45);

  // Inside event horizon → black.
  if (r < r_s) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Approximate gravitational lensing: bend the ray toward the centre by an
  // amount that grows with 1/r. This is qualitative, not Kerr-exact; the
  // photon-sphere ring at ~1.5 r_s is faked with a brightness boost band.
  float bend = (r_s * 1.6) / max(r - r_s * 0.7, 1e-3);
  vec2 dir = p / max(r, 1e-4);
  vec2 lensed = p - dir * bend;

  // Background starfield in lensed space.
  vec3 col = starfield(lensed * 1.6);

  // Photon ring: bright thin annulus at ~1.5..1.7 r_s
  float ringR = r_s * 1.55;
  float ringW = r_s * 0.10 + 0.002;
  float ring  = exp(-pow((r - ringR) / ringW, 2.0)) * (1.0 + uBands.z * 1.6 + uBeat.y * 1.0);
  vec3 ringCol = paletteColor(uPalette, 0.85);
  col += ringCol * ring * uRingBoost;

  // Beat shockwave — a second outward-moving annulus that fades over ~1.5s.
  float swR  = r_s * (1.6 + 4.5 * pow(uBeat.y, 0.6));
  float swW  = r_s * 0.18;
  float sw   = exp(-pow((r - swR) / swW, 2.0)) * uBeat.y;
  col += ringCol * sw * 1.4;

  // Accretion disk — thin band in screen space, rotated by uTime + uSpin and
  // perturbed by uPerturb. We treat the disk as edge-on with a thickness
  // envelope around y_disk = 0 in disk-local coords.
  float ang = uTime * (0.20 + uSpin * 1.2) + uPerturb.x * 1.4;
  float ca = cos(ang), sa = sin(ang);
  vec2  pd = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
  // Tilt: shrink y to fake an edge-on perspective (thin disk).
  pd.y *= 4.5 + uPerturb.y * 2.0;
  float rd = length(pd);
  float disk = 0.0;
  if (rd > r_s * 1.05 && rd < r_s * 4.5) {
    float band = exp(-abs(pd.y) * 90.0);              // thin disk
    float radial = smoothstep(r_s * 4.5, r_s * 1.6, rd) * smoothstep(r_s * 1.05, r_s * 1.4, rd);
    // Doppler-ish shading: front side brighter via screen-x sign.
    float dop = 0.8 + 0.6 * (pd.x / max(rd, 1e-4));
    // Turbulence — wraps with the rotation so it doesn't strobe.
    float tn = noise(vec2(rd * 6.0, atan(pd.y, pd.x) * 2.0 + uTime * (0.6 + uSpin)));
    disk = band * radial * dop * (0.6 + 0.7 * tn);
  }
  vec3 diskCol = paletteColor(uPalette, clamp(rd / (r_s * 4.5), 0.0, 1.0));
  col += diskCol * disk * (1.0 + uBands.y * 0.8);

  // Faint vignette so off-screen edges don't get too busy.
  float v = smoothstep(1.4, 0.4, length(p));
  col *= v;

  // Mild tone curve.
  col = pow(col, vec3(0.92));
  outColor = vec4(col, 1.0);
}
`;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'singularity_lens',
  name: 'Singularity Lens',
  contextType: 'webgl2',

  params: [
    { id: 'horizon',      label: 'Horizon r_s',   type: 'range', min: 0.05, max: 0.40, step: 0.005, default: 0.16 },
    { id: 'spin',         label: 'Disk spin',     type: 'range', min: 0,    max: 1,    step: 0.01,  default: 0.4 },
    { id: 'ringBoost',    label: 'Ring boost',    type: 'range', min: 0,    max: 3,    step: 0.05,  default: 1.0 },
    { id: 'palette',      label: 'Palette',       type: 'select', options: ['accretionGold','voidblue','neuralMagenta','plasmaOrange'], default: 'accretionGold' },
    { id: 'audioBindBass',label: 'bass→pulse',    type: 'toggle', default: true },
    { id: 'poseTrack',    label: 'pose tracks',   type: 'toggle', default: true },
    { id: 'reactivity',   label: 'reactivity',    type: 'range', min: 0,    max: 2,    step: 0.05, default: 1.0 },
  ],

  presets: {
    default:      { horizon: 0.16, spin: 0.40, ringBoost: 1.0,  palette: 'accretionGold', reactivity: 1.0 },
    interstellar: { horizon: 0.20, spin: 0.55, ringBoost: 1.3,  palette: 'accretionGold' },
    glassblue:    { horizon: 0.12, spin: 0.25, ringBoost: 0.8,  palette: 'voidblue' },
    neural:       { horizon: 0.18, spin: 0.30, ringBoost: 1.2,  palette: 'neuralMagenta' },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    let W = canvas.width, H = canvas.height;
    let centerX = 0.5, centerY = 0.5;     // smoothed pose-biased centre
    let perturbX = 0, perturbY = 0;

    const PALETTES = ['accretionGold','voidblue','neuralMagenta','plasmaOrange'];

    let scratch = {
      horizon: 0.16, spin: 0.4, ringBoost: 1.0,
      palette: 0, poseTrack: true,
      time: 0,
    };

    let audioRef = null;
    function update(field) {
      const { dt, time, pose, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;
      scratch.time      = time;
      scratch.horizon   = params.horizon;
      scratch.spin      = params.spin;
      scratch.ringBoost = params.ringBoost;
      scratch.palette   = Math.max(0, PALETTES.indexOf(params.palette));

      // Pose-biased centre — head of person 0 maps to singularity centre.
      // Smoothed so a missed detection doesn't snap.
      let tx = 0.5, ty = 0.5;
      let pertX = 0, pertY = 0;
      if (params.poseTrack && pose.people.length > 0) {
        const p0 = pose.people[0];
        if (p0.head && p0.head.visibility > 0.3) {
          // Camera frames are mirrored — mirror back to feel intuitive.
          tx = 1.0 - p0.head.x;
          ty = p0.head.y;
        }
        // Wrist motion drives perturbation.
        const wL = p0.wrists?.l, wR = p0.wrists?.r;
        if (wL && wR && wL.visibility > 0.3 && wR.visibility > 0.3) {
          pertX = (wR.x - wL.x) - 0.4;
          pertY = ((wL.y + wR.y) * 0.5) - 0.5;
        }
      }
      const k = Math.min(1, dt * 4.0);
      centerX += (tx - centerX) * k;
      centerY += (ty - centerY) * k;
      perturbX += (pertX - perturbX) * k;
      perturbY += (pertY - perturbY) * k;

      // Audio-bound bass pulse expands horizon. Only when toggle is on.
      if (!params.audioBindBass) {
        scratch.horizon = params.horizon;
      } else {
        scratch.horizon = params.horizon * (1.0 + audio.bands.bass * 0.10);
      }
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform1f(U('uTime'),       scratch.time);
      gl.uniform1f(U('uHorizon'),    scratch.horizon);
      gl.uniform1f(U('uSpin'),       scratch.spin);
      gl.uniform1f(U('uRingBoost'),  scratch.ringBoost);
      gl.uniform1i(U('uPalette'),    scratch.palette);
      gl.uniform2f(U('uCenter'),     centerX, centerY);
      gl.uniform2f(U('uPerturb'),    perturbX, perturbY);
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
