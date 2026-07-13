// Wake — the present is invisible; only its consequences exist. Nothing from
// the current audio frame is ever drawn. Every sound deposits into a slowly
// decaying HISTORY FIELD — a dark water surface seen from above — and the
// screen shows only that field: ripples, thermals and scars left by beats,
// swells and phrases, drifting and fading over ~`memory` seconds. Silence
// doesn't blank the screen; it's the only time the whole document is legible.
//
// Why this is memory and not delay (a delay repeats the signal; a memory is
// the signal changed by having been kept):
//   · DEVELOPMENT — deposits land in a LATENT channel and develop into the
//     visible channel with a ~0.6s half-transfer, like long-exposure film.
//     At the instant of a hit the screen shows nothing; the mark blooms in
//     after the sound has already gone.
//   · TRAVEL — a beat isn't stamped as a picture of a ring; it launches an
//     invisible expanding wave-packet whose PASSAGE is sedimented into the
//     field over ~7s. What you see is the wake, never the splash.
//   · FREQUENCY-DEPENDENT FORGETTING — decay half-life is scaled by the
//     mark's hue: high-frequency scratches fade ~3.5× faster than deep bass
//     swells. The memory loses detail before it loses gist.
//   · REFRACTION BY THE KEPT — old deep-hued marks locally shift the phase
//     of later wavefronts, so what was kept bends what arrives next.
//   · INTERFERENCE — coincident wavefronts deposit their true superposition
//     (cross terms included); destructive crossings can suppress deposit
//     entirely, so old ripples partially erase new ones.
//   · OVERWRITE + AGING — new deposits blend the local hue toward their own
//     and partially reset local age; per-texel age drives in-field diffusion
//     and composite blur, so old marks physically soften and desaturate.
//   · DRIFT — the whole field is semi-Lagrangian-advected through a slow
//     curl-noise current, so older marks have wandered further from where
//     they were made.
//
// Field texture (one ping-pong RGBA16F pair, fixed sim res):
//   R = developed (visible) intensity      G = latent intensity (never drawn)
//   B = hue, 0 = deep/bass … 1 = high      A = age in seconds
//
// Modulation map:
//   audio.rms  → drift        (declarative modulator: loudness churns the water)
// Inline (non-param):
//   beat.active → launches a ripple wave-packet (hue = spectral centroid)
//   bass        → three slow-wandering deep swell blobs (they refract later
//                 arrivals via the hue-gated refraction above)
//   highs       → fine capillary scratches, fastest of all marks to fade
//   spectrum    → log-binned 1D texture (fire.js pattern); a per-cell hashed
//                 "drizzle" keys each cell of the surface to one bin, so
//                 sustained tones build a signature constellation; ripple hue
//                 is the spectral centroid at hit time
//   rms         → exposure of the composite — nothing visible NOW; it scales
//                 how loudly the PAST echoes (floored so silence stays legible)
//   pose wrists → stir splats DISPLACE the history (advection offset — they
//                 move memory around, they never add marks)
//   pose head.x → lean = a whole-field current; heavily smoothed, decays to
//                 zero on tracking dropout so it never snaps
//
// Idle (audio off / spectrum null): occasional faint "rain" ripples + a slow
// caustic shimmer on the water floor keep the surface alive with no signal.
//
// If float render targets are unavailable (no EXT_color_buffer_float /
// _half_float) the quale degrades to a memoryless dark-water pass that draws
// the CPU ripple pool directly (a few seconds of wake, no long history)
// instead of throwing at create() time.

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
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return v;
}
`;

// Palette: hue h is the frequency position a mark was deposited at
// (0 = deep/bass … 1 = highs). Aged marks get pulled toward the palette's
// sediment tint by the composite. All three run dark — the page bg is
// #05050d and the canvas screen-blends over Hydra.
const PALETTE = /* glsl */`
vec3 wakePal(int idx, float h) {
  h = clamp(h, 0.0, 1.0);
  if (idx == 1) { // sonar — phosphor green, highs go brine-yellow
    vec3 c = mix(vec3(0.03, 0.20, 0.10), vec3(0.28, 0.85, 0.34), smoothstep(0.0, 0.6, h));
    return mix(c, vec3(0.78, 0.95, 0.42), smoothstep(0.6, 1.0, h));
  }
  if (idx == 2) { // voidglass — violet through magenta to ice
    vec3 c = mix(vec3(0.17, 0.08, 0.44), vec3(0.72, 0.22, 0.76), smoothstep(0.0, 0.55, h));
    return mix(c, vec3(0.72, 0.85, 1.00), smoothstep(0.55, 1.0, h));
  }
  // abyss — deep indigo, mid teal, highs pale cyan
  vec3 c = mix(vec3(0.08, 0.15, 0.42), vec3(0.10, 0.46, 0.56), smoothstep(0.0, 0.5, h));
  return mix(c, vec3(0.62, 0.90, 0.96), smoothstep(0.5, 1.0, h));
}
vec3 wakeSediment(int idx) {
  if (idx == 1) return vec3(0.19, 0.25, 0.14);  // dried-kelp olive
  if (idx == 2) return vec3(0.31, 0.27, 0.40);  // smoked violet
  return            vec3(0.22, 0.29, 0.35);     // slate
}
`;

// ── Evolve pass — advect · age · decay · develop · deposit ────────────────
// Reads mem.read, writes mem.write. Runs at fixed sim res. This is the only
// place anything is ever added to the field, and everything it adds goes to
// the LATENT channel — the composite can't show it until it develops.

const EVOLVE_FRAG = HEADER + NOISE + /* glsl */`
uniform highp sampler2D uMem;
uniform highp sampler2D uSpec;    // 1D log-binned FFT, R8
uniform vec2  uTexel;
uniform float uDt;
uniform float uTime;
uniform float uAspect;
uniform float uHalfLife;          // memory param, seconds
uniform float uInterf;            // interference param 0..2
uniform float uSoften;            // in-field diffusion rate (legibility leg)
uniform float uDrift;             // curl-noise flow gain
uniform vec2  uCurrent;           // lean current, uv/s
uniform float uDrizzle;           // spectral drizzle gain (0 when no spectrum)
uniform vec4  uStir[2];           // wrist stirs: x, y, vx, vy (uv/s; 0 = off)
uniform vec4  uRipples[24];       // x, y, age, ampNow (0 = dead)
uniform float uRippleHue[24];
uniform vec4  uScrA[10];          // scratches: x, y, angle, halfLen
uniform vec4  uScrB[10];          // age, ampNow, hue, _
uniform vec4  uBlobs[3];          // bass swells: x, y, radius, strength

const float RSPEED = 0.105;       // wavefront speed, uv/s
const float WAVE_K = 175.0;       // packet spatial frequency (~2π / 0.036 uv)

void main() {
  // ── flow: drift gyres + lean current + wrist stirs. Stirs DISPLACE the
  // history (advection offset) — they never add intensity.
  vec2 nuv = vUv * 3.0 + vec2(uTime * 0.016, -uTime * 0.012);
  vec2 curlF = vec2(
    noise(nuv + vec2(0.0, 0.09)) - noise(nuv - vec2(0.0, 0.09)),
    noise(nuv - vec2(0.09, 0.0)) - noise(nuv + vec2(0.09, 0.0)));
  vec2 flow = uCurrent + curlF * uDrift;
  for (int i = 0; i < 2; i++) {
    vec2 sd = vUv - uStir[i].xy; sd.x *= uAspect;
    flow += uStir[i].zw * exp(-dot(sd, sd) * 320.0);
  }
  vec2 src = vUv - flow * uDt;

  vec4 m = texture(uMem, src);

  // Age-weighted diffusion — old marks physically soften inside the field.
  vec4 nb = 0.25 * (texture(uMem, src + vec2(uTexel.x, 0.0))
                  + texture(uMem, src - vec2(uTexel.x, 0.0))
                  + texture(uMem, src + vec2(0.0, uTexel.y))
                  + texture(uMem, src - vec2(0.0, uTexel.y)));
  float soften = min(uSoften * uDt * smoothstep(3.0, 45.0, m.a), 0.5);
  m = mix(m, nb, soften);

  // Inflow mask (after the neighbor mix, so clamped-edge samples can't leak
  // back in): back-traces that leave the frame bring nothing with them.
  vec2 sc = min(src, 1.0 - src);
  m *= smoothstep(-0.002, 0.012, min(sc.x, sc.y));

  // Frequency-dependent forgetting: high-hue content decays ~3.5× faster —
  // the memory loses its treble before its bass.
  float fast = mix(1.0, 3.5, smoothstep(0.55, 0.95, m.b));
  m.r *= exp2(-uDt * fast / uHalfLife);
  m.g *= exp2(-uDt * fast / max(uHalfLife * 0.5, 4.0));

  // Development: latent → visible, ~0.6s half-transfer. The hit is never on
  // screen at t=0 — the mark blooms in after the sound.
  float dv = m.g * (1.0 - exp2(-uDt / 0.6));
  m.g -= dv; m.r += dv;
  m.a = min(m.a + uDt, 300.0);

  // Border absorb — the current can't pile the past up against the frame.
  vec2 e2 = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.035, 0.0, min(e2.x, e2.y));
  float keep = 1.0 - min(edge * uDt * 2.0, 1.0);
  m.r *= keep; m.g *= keep;

  // ── deposits (into latent only) ──────────────────────────────────────
  // Old deep-hued marks act as swells that refract later arrivals: they
  // shift the local phase of every wavefront passing over them.
  float swell = m.r * (1.0 - smoothstep(0.18, 0.45, m.b));
  float shift = swell * 0.05 * uInterf;
  // Static (time-free) fine warp so wavefronts read organic, not compass-drawn.
  float rn = (noise(vUv * vec2(uAspect, 1.0) * 22.0) - 0.5) * 0.012;

  float sumW = 0.0, sumE = 0.0, hAcc = 0.0, hW = 0.0, dep = 0.0;

  // Ripple wave-packets. Deposit is the true superposition energy: at
  // uInterf=1 it's (Σw)² — full constructive/destructive fringes where
  // wakes cross; destructive crossings suppress deposit (old erases new).
  for (int i = 0; i < 24; i++) {
    vec4 rp = uRipples[i];
    if (rp.w <= 0.0001) continue;
    vec2 d = vUv - rp.xy; d.x *= uAspect;
    float r  = length(d) + rn - shift;
    float rr = RSPEED * rp.z;
    float pw = 0.011 + 0.0012 * rp.z;            // dispersion widens the packet
    float ph = (r - rr) / pw;
    float w  = rp.w * exp(-ph * ph) * cos((r - rr) * WAVE_K);
    sumW += w; sumE += w * w;
    float aw = abs(w);
    hAcc += uRippleHue[i] * aw; hW += aw;
  }
  float crossT = sumW * sumW - sumE;             // cross terms, can be negative
  dep += max(sumE + uInterf * crossT, 0.0) * 10.0 * uDt;

  // Bass swells — broad, slow, deep-hued thermals.
  for (int i = 0; i < 3; i++) {
    vec4 b = uBlobs[i];
    if (b.w <= 0.0001) continue;
    vec2 d = vUv - b.xy; d.x *= uAspect;
    float g = exp(-dot(d, d) / (b.z * b.z)) * b.w;
    dep += g * 0.14 * uDt;
    float bw = g * 0.6;
    hAcc += (0.03 + 0.075 * float(i)) * bw; hW += bw;
  }

  // Capillary scratches — thin high-hue line segments (fastest to fade,
  // via the hue-gated decay above).
  for (int i = 0; i < 10; i++) {
    vec4 a = uScrA[i]; vec4 b = uScrB[i];
    if (b.y <= 0.0001) continue;
    vec2 d = vUv - a.xy; d.x *= uAspect;
    float ca = cos(a.z), sa = sin(a.z);
    vec2 lp = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y);
    float endf = 1.0 - smoothstep(a.w * 0.6, a.w, abs(lp.x));
    float w = exp(-lp.y * lp.y / 1.4e-5) * endf * b.y;
    dep += w * 5.0 * uDt;
    hAcc += b.z * w; hW += w;
  }

  // Spectral drizzle — every cell of the surface is hash-keyed to one FFT
  // bin; sustained tones keep re-wetting the same cells, so a song builds a
  // signature constellation nobody placed on purpose.
  if (uDrizzle > 0.0001) {
    vec2 g = vUv * vec2(uAspect, 1.0) * 26.0;
    vec2 cell = floor(g);
    vec2 jit = vec2(hash(cell + 7.31), hash(cell + 13.77)) - 0.5;
    vec2 lp = fract(g) - 0.5 - jit * 0.55;
    float fu = hash(cell + 0.5);
    float sv = texture(uSpec, vec2(fu, 0.5)).r;
    float dz = exp(-dot(lp, lp) * 34.0) * sv * sv * sv * sv * uDrizzle;
    dep += dz * 0.25 * uDt;
    hAcc += fu * dz; hW += dz;
  }

  // Sediment: deposits enter LATENT; hue is blended toward the depositor and
  // local age is partially reset — what comes after overwrites what came
  // before, in proportion to how hard it lands.
  if (hW > 1e-5) {
    float f = 1.0 - exp(-dep * 5.0);
    m.b = mix(m.b, hAcc / hW, min(f * 1.5, 1.0));
    m.a *= 1.0 - f;
  }
  m.g = min(m.g + dep, 3.0);
  m.r = min(m.r, 1.8);

  outColor = m;
}
`;

// ── Composite — the only thing on screen is the developed past ────────────
// Reads the memory field's VISIBLE channel only (latent never shows). Age
// drives a variable blur + a pull toward the sediment tint, rms drives
// exposure ("how loudly the past echoes", floored so silence stays legible),
// and a slow caustic shimmer keeps the water alive with zero history.

const COMPOSITE_FRAG = HEADER + NOISE + PALETTE + /* glsl */`
uniform highp sampler2D uMem;
uniform vec2  uMemTexel;
uniform vec2  uRes;
uniform float uTime;
uniform float uEcho;
uniform float uLegib;
uniform int   uPalette;
void main() {
  vec4 m0 = texture(uMem, vUv);
  // Age-based softening: old marks are sampled through a wider kernel.
  float br = mix(0.6, 3.2, smoothstep(0.0, 75.0, m0.a)) * (1.0 - 0.6 * uLegib);
  vec2 o = uMemTexel * br;
  vec4 s = m0 * 0.4
         + 0.15 * (texture(uMem, vUv + o)
                 + texture(uMem, vUv - o)
                 + texture(uMem, vUv + vec2(o.x, -o.y))
                 + texture(uMem, vUv + vec2(-o.x, o.y)));

  float v = pow(max(s.r, 0.0), mix(1.25, 0.8, uLegib));  // legibility lifts faint marks
  float lum = 1.0 - exp(-v * 1.25 * uEcho);
  vec3 col = wakePal(uPalette, s.b);
  float aged = smoothstep(8.0, 90.0, s.a);
  col = mix(col, wakeSediment(uPalette), aged * 0.55);   // old marks silt over
  col *= lum;

  // Still-water floor near #05050d + slow caustic shimmer (idle-alive).
  float asp = uRes.x / uRes.y;
  float wn  = fbm(vUv * vec2(asp, 1.0) * 3.0 + vec2(uTime * 0.021, -uTime * 0.017));
  float wn2 = noise(vUv * vec2(asp, 1.0) * 9.0 - vec2(uTime * 0.033, uTime * 0.024));
  col += vec3(0.020, 0.020, 0.051);
  col += vec3(0.012, 0.016, 0.030) * (wn * 0.7 + wn2 * 0.3);

  float vg = smoothstep(1.55, 0.55, length((vUv - 0.5) * vec2(asp, 1.0) * 2.0));
  col *= mix(0.84, 1.0, vg);
  col += (hash(vUv * uRes + uTime) - 0.5) * 0.006;       // dither vs banding
  outColor = vec4(col, 1.0);
}
`;

// No-float-FBO fallback: memoryless dark water — the CPU ripple pool is
// rendered directly (a few seconds of wake), no long history. Never throws.
const FALLBACK_FRAG = HEADER + NOISE + PALETTE + /* glsl */`
uniform vec2  uRes;
uniform float uTime;
uniform float uEcho;
uniform float uAspect;
uniform int   uPalette;
uniform vec4  uRipples[24];
uniform float uRippleHue[24];
const float RSPEED = 0.105;
void main() {
  float asp = uRes.x / uRes.y;
  vec3 col = vec3(0.020, 0.020, 0.051);
  col += vec3(0.012, 0.016, 0.030)
       * fbm(vUv * vec2(asp, 1.0) * 3.0 + vec2(uTime * 0.021, -uTime * 0.017));
  for (int i = 0; i < 24; i++) {
    vec4 rp = uRipples[i];
    if (rp.w <= 0.0001) continue;
    vec2 d = vUv - rp.xy; d.x *= uAspect;
    float r  = length(d);
    float rr = RSPEED * rp.z;
    float pw = 0.012 + 0.003 * rp.z;
    float band = exp(-pow((r - rr) / pw, 2.0)) * rp.w;
    col += wakePal(uPalette, uRippleHue[i]) * band * 0.45 * uEcho;
  }
  float vg = smoothstep(1.55, 0.55, length((vUv - 0.5) * vec2(asp, 1.0) * 2.0));
  col *= mix(0.84, 1.0, vg);
  outColor = vec4(col, 1.0);
}
`;

// ── Module ─────────────────────────────────────────────────────────────────

const MEM_H  = 384;   // history-field rows; width follows aspect
const MAXR   = 24;    // ripple pool
const MAXS   = 10;    // scratch pool
const SPEC_W = 64;    // log-binned FFT columns
const PALETTES = ['abyss', 'sonar', 'voidglass'];

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'wake',
  name: 'Wake',
  contextType: 'webgl2',
  maxDpr: 1.0,

  params: [
    { id: 'memory',       label: 'memory (s)',   type: 'range', min: 10, max: 300, step: 1,    default: 90 },
    { id: 'drift',        label: 'drift',        type: 'range', min: 0,  max: 1,   step: 0.01, default: 0.3,
      modulators: [
        { source: 'audio.rms', mode: 'mul', amount: 0.35 },
      ] },
    { id: 'interference', label: 'interference', type: 'range', min: 0,  max: 2,   step: 0.01, default: 1.0 },
    { id: 'legibility',   label: 'legibility',   type: 'range', min: 0,  max: 1,   step: 0.01, default: 0.6 },
    { id: 'palette',      label: 'palette',      type: 'select', options: PALETTES, default: 'abyss' },
    { id: 'reactivity',   label: 'reactivity',   type: 'range', min: 0,  max: 2,   step: 0.05, default: 1.0 },
  ],

  presets: {
    default:  { memory: 90,  drift: 0.3, interference: 1.0, legibility: 0.6, palette: 'abyss', reactivity: 1.0 },
    goldfish: { memory: 12 },                       // the past barely outlives itself
    elephant: { memory: 300, legibility: 0.85 },    // the whole set, visible
  },

  create(canvas, { gl }) {
    // 16F is texture-filterable in core WebGL2 but color-renderable only
    // behind one of these extensions. Missing both → memoryless fallback.
    const floatOk = !!(gl.getExtension('EXT_color_buffer_float')
                    || gl.getExtension('EXT_color_buffer_half_float'));

    const vao = makeFullscreenTri(gl);
    function makePass(frag) {
      const prog = compileProgram(gl, FULLSCREEN_VERT, frag);
      return { prog, U: makeUniformGetter(gl, prog) };
    }
    const pEvolve    = floatOk ? makePass(EVOLVE_FRAG) : null;
    const pComposite = makePass(floatOk ? COMPOSITE_FRAG : FALLBACK_FRAG);

    // ── FBO plumbing (fire.js pattern) ────────────────────────────────────
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
      if (ok) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); } // blank water
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return { tex, fbo, ok };
    }
    function freeTarget(t) { if (!t) return; gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }

    let W = 0, H = 0;          // canvas backing buffer
    let MW = 0, MH = 0;        // memory-field grid dims
    let mem = null;            // { read, write, swap() }
    let simOk = false;

    function allocGrid() {
      if (mem) { freeTarget(mem.read); freeTarget(mem.write); mem = null; }
      simOk = false;
      if (!pEvolve || !W || !H) return;
      MH = MEM_H;
      MW = Math.max(16, Math.round(MEM_H * (W / H)));
      mem = { read: makeTarget(MW, MH), write: makeTarget(MW, MH),
              swap() { const t = this.read; this.read = this.write; this.write = t; } };
      simOk = mem.read.ok && mem.write.ok;
    }

    function bindTex(unit, tex) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }

    // ── Spectrum (1D log-binned FFT texture — fire.js pattern) ────────────
    const specEma   = new Float32Array(SPEC_W);
    const specBytes = new Uint8Array(SPEC_W);
    let specDirty = false;
    const specTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, specTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SPEC_W, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    function resampleSpectrum(spectrum, dt, react) {
      const n  = spectrum.length;
      const lo = 2, hi = Math.max(lo + SPEC_W, Math.floor(n * 0.7));
      const ratio = Math.log(hi / lo);
      const kUp = Math.min(1, dt * 28), kDn = Math.min(1, dt * 6);
      for (let i = 0; i < SPEC_W; i++) {
        const b0 = Math.floor(lo * Math.exp(ratio * i / SPEC_W));
        const b1 = Math.max(b0 + 1, Math.ceil(lo * Math.exp(ratio * (i + 1) / SPEC_W)));
        let m = 0;
        for (let b = b0; b < b1 && b < n; b++) { const v = spectrum[b]; if (v > m) m = v; }
        const v = Math.min(1, (m / 255) * react);
        const cur = specEma[i];
        specEma[i] = cur + (v - cur) * (v > cur ? kUp : kDn);
        specBytes[i] = (specEma[i] * 255) | 0;
      }
      specDirty = true;
    }

    // ── Ripple pool (CPU state, uniform arrays — zero per-frame garbage) ──
    const ripData = new Float32Array(MAXR * 4);  // x, y, age, ampNow
    const ripHue  = new Float32Array(MAXR);
    const ripAmp0 = new Float32Array(MAXR);      // 0 = dead
    function spawnRipple(x, y, amp, hue) {
      for (let i = 0; i < MAXR; i++) {
        if (ripAmp0[i] > 0) continue;
        ripAmp0[i] = amp;
        ripData[i * 4]     = Math.min(Math.max(x, 0.02), 0.98);
        ripData[i * 4 + 1] = Math.min(Math.max(y, 0.02), 0.98);
        ripData[i * 4 + 2] = 0;
        ripData[i * 4 + 3] = 0;
        ripHue[i] = hue;
        return;
      }
    }
    function ageRipples(dt) {
      for (let i = 0; i < MAXR; i++) {
        if (ripAmp0[i] <= 0) { ripData[i * 4 + 3] = 0; continue; }
        const age = ripData[i * 4 + 2] + dt;
        const amp = ripAmp0[i] * Math.min(1, age / 0.15) * Math.exp(-age / 2.6);
        if (age > 7 || amp < 0.01) { ripAmp0[i] = 0; ripData[i * 4 + 3] = 0; continue; }
        ripData[i * 4 + 2] = age;
        ripData[i * 4 + 3] = amp;
      }
    }

    // ── Scratch pool ──────────────────────────────────────────────────────
    const scrA    = new Float32Array(MAXS * 4);  // x, y, angle, halfLen
    const scrB    = new Float32Array(MAXS * 4);  // age, ampNow, hue, _
    const scrAmp0 = new Float32Array(MAXS);
    function spawnScratch(x, y, angle, halfLen, amp, hue) {
      for (let i = 0; i < MAXS; i++) {
        if (scrAmp0[i] > 0) continue;
        scrAmp0[i] = amp;
        scrA[i * 4] = x; scrA[i * 4 + 1] = y; scrA[i * 4 + 2] = angle; scrA[i * 4 + 3] = halfLen;
        scrB[i * 4] = 0; scrB[i * 4 + 1] = 0; scrB[i * 4 + 2] = hue;
        return;
      }
    }
    function ageScratches(dt) {
      for (let i = 0; i < MAXS; i++) {
        if (scrAmp0[i] <= 0) { scrB[i * 4 + 1] = 0; continue; }
        const age = scrB[i * 4] + dt;
        const amp = scrAmp0[i] * Math.exp(-age / 0.35);
        if (age > 1.6 || amp < 0.01) { scrAmp0[i] = 0; scrB[i * 4 + 1] = 0; continue; }
        scrB[i * 4] = age;
        scrB[i * 4 + 1] = amp;
      }
    }

    const blobData = new Float32Array(3 * 4);    // x, y, radius, strength
    const stirData = new Float32Array(2 * 4);    // x, y, vx, vy

    // ── Wrist stir trackers (fire.js pattern — threshold keeps jitter and a
    // stationary performer inert; dropout resets so re-entry can't slingshot)
    const wrists = [
      { valid: false, x: 0, y: 0, vx: 0, vy: 0 },
      { valid: false, x: 0, y: 0, vx: 0, vy: 0 },
    ];
    function trackWrist(slot, lm, dt) {
      const w = wrists[slot];
      const o = slot * 4;
      stirData[o + 2] = 0; stirData[o + 3] = 0;
      if (!lm || lm.visibility < 0.35) { w.valid = false; return; }
      const x = 1 - lm.x;            // mirror to match the on-screen feel
      const y = 1 - lm.y;            // camera y-down → field y-up
      if (!w.valid) { w.valid = true; w.x = x; w.y = y; w.vx = 0; w.vy = 0; return; }
      const k = Math.min(1, dt * 12);
      const vx = (x - w.x) / Math.max(dt, 1e-3), vy = (y - w.y) / Math.max(dt, 1e-3);
      w.vx += (vx - w.vx) * k; w.vy += (vy - w.vy) * k;
      w.x += (x - w.x) * k;    w.y += (y - w.y) * k;
      const speed = Math.hypot(w.vx, w.vy);
      if (speed < 0.25) return;
      const cap = Math.min(1, 0.9 / speed);      // stir, never blast
      stirData[o]     = w.x;
      stirData[o + 1] = w.y;
      stirData[o + 2] = w.vx * cap * 0.45;
      stirData[o + 3] = w.vy * cap * 0.45;
    }

    // ── Per-frame scratch (update fills, render reads — never field) ──────
    const scr = {
      dt: 1 / 60, time: 0,
      halfLife: 90, drift: 0.03, interf: 1, soften: 0.4, legib: 0.6,
      palette: 0, echo: 0.7, drizzle: 0, curX: 0, curY: 0,
    };
    let prevBeat = false, prevHighs = false;
    let lastRip = -10, lastScr = -10;
    let rainT = 1.2;
    let echoS = 0.7, leanS = 0, centroidS = 0.35;

    function update(field) {
      const p = field.params;
      const audio = scaleAudio(field.audio, p.reactivity);
      const dt = Math.min(Math.max(field.dt, 1 / 240), 1 / 30);
      const t = field.time;
      scr.dt   = dt;
      scr.time = t;
      scr.halfLife = Math.max(2, p.memory ?? 90);
      scr.drift    = (p.drift ?? 0.3) * 0.11;
      scr.interf   = p.interference ?? 1;
      scr.legib    = p.legibility ?? 0.6;
      scr.soften   = 0.9 * (1 - 0.75 * scr.legib);
      scr.palette  = Math.max(0, PALETTES.indexOf(p.palette));

      // rms → exposure of the past. Floored so silence is the most legible
      // moment, not a blackout.
      const echoT = 0.7 + Math.min(1, audio.rms * 1.8);
      echoS += (echoT - echoS) * Math.min(1, dt * 1.5);
      scr.echo = echoS;

      // Spectrum → drizzle gain + centroid (hue for the next ripple).
      if (field.audio.spectrum) {
        resampleSpectrum(field.audio.spectrum, dt, p.reactivity == null ? 1 : p.reactivity);
        let num = 0, den = 0;
        for (let i = 0; i < SPEC_W; i++) { const e = specEma[i]; num += (i / (SPEC_W - 1)) * e; den += e; }
        const c = den > 1e-3 ? num / den : 0.35;
        centroidS += (c - centroidS) * Math.min(1, dt * 6);
        scr.drizzle = 0.25 + 0.75 * Math.min(1, audio.bands.total * 1.4);
      } else {
        scr.drizzle = 0;
      }

      // Slowly wandering anchor — consecutive hits land near each other,
      // like the same drummer sitting in the same seat.
      const ax = 0.5 + 0.26 * Math.sin(t * 0.043 + 1.3) + 0.13 * Math.sin(t * 0.107);
      const ay = 0.5 + 0.22 * Math.sin(t * 0.059 + 0.7) + 0.11 * Math.sin(t * 0.089 + 2.0);

      // beat.active edge → launch a ripple (never drawn; only its wake is).
      if (audio.beat.active && !prevBeat && t - lastRip > 0.1) {
        lastRip = t;
        const amp = Math.min(1.6, 0.5 + 0.75 * audio.bands.bass + 0.5 * audio.beat.pulse);
        spawnRipple(ax + (Math.random() - 0.5) * 0.24, ay + (Math.random() - 0.5) * 0.24, amp, centroidS);
      }
      prevBeat = audio.beat.active;

      // Idle rain — a drop every few seconds keeps still water alive.
      rainT -= dt;
      if (rainT <= 0) {
        rainT = 2.2 + Math.random() * 4.5;
        const hue = 0.32 + 0.18 * Math.sin(t * 0.05) + (Math.random() - 0.5) * 0.1;
        spawnRipple(0.1 + Math.random() * 0.8, 0.1 + Math.random() * 0.8,
                    0.18 + Math.random() * 0.22, hue);
      }

      // highs → capillary scratches.
      if (audio.highs.active && !prevHighs && audio.highs.pulse > 0.2 && t - lastScr > 0.08) {
        lastScr = t;
        const n = 1 + (Math.random() < audio.highs.pulse ? 1 : 0);
        for (let i = 0; i < n; i++) {
          spawnScratch(ax + (Math.random() - 0.5) * 0.5, ay + (Math.random() - 0.5) * 0.5,
                       Math.random() * Math.PI, 0.03 + Math.random() * 0.05,
                       Math.min(1.2, 0.35 + 0.7 * audio.highs.pulse),
                       0.75 + Math.random() * 0.22);
        }
      }
      prevHighs = audio.highs.active;

      ageRipples(dt);
      ageScratches(dt);

      // Bass swells — three broad slow thermals whose strength is the low end.
      const bs = Math.max(0, audio.bands.bass - 0.05);
      const bStr = bs * bs * 0.7;
      for (let i = 0; i < 3; i++) {
        blobData[i * 4]     = 0.5 + 0.30 * Math.sin(t * 0.041 + i * 2.09) + 0.10 * Math.sin(t * 0.013 * (i + 1) + i);
        blobData[i * 4 + 1] = 0.5 + 0.26 * Math.sin(t * 0.057 + i * 1.7);
        blobData[i * 4 + 2] = 0.09 + 0.05 * i;
        blobData[i * 4 + 3] = bStr;
      }

      // Lean → whole-field current. Heavily smoothed; target decays to zero
      // on dropout so tracking loss never snaps the water.
      const p0 = field.pose?.people?.[0] ?? null;
      let leanT = 0;
      if (p0?.head && p0.head.visibility > 0.3) leanT = 0.5 - p0.head.x;
      leanS += (leanT - leanS) * Math.min(1, dt * 1.2);
      scr.curX = leanS * 0.03;
      scr.curY = 0;

      // Wrist stirs — displace the memory, never add to it.
      trackWrist(0, p0?.wrists?.l ?? null, dt);
      trackWrist(1, p0?.wrists?.r ?? null, dt);
    }

    function runEvolve() {
      gl.viewport(0, 0, MW, MH);
      gl.useProgram(pEvolve.prog);
      const U = pEvolve.U;
      bindTex(0, mem.read.tex);
      bindTex(1, specTex);
      gl.uniform1i(U('uMem'), 0);
      gl.uniform1i(U('uSpec'), 1);
      gl.uniform2f(U('uTexel'), 1 / MW, 1 / MH);
      gl.uniform1f(U('uDt'), scr.dt);
      gl.uniform1f(U('uTime'), scr.time);
      gl.uniform1f(U('uAspect'), W / H);
      gl.uniform1f(U('uHalfLife'), scr.halfLife);
      gl.uniform1f(U('uInterf'), scr.interf);
      gl.uniform1f(U('uSoften'), scr.soften);
      gl.uniform1f(U('uDrift'), scr.drift);
      gl.uniform2f(U('uCurrent'), scr.curX, scr.curY);
      gl.uniform1f(U('uDrizzle'), scr.drizzle);
      gl.uniform4fv(U('uStir[0]'), stirData);
      gl.uniform4fv(U('uRipples[0]'), ripData);
      gl.uniform1fv(U('uRippleHue[0]'), ripHue);
      gl.uniform4fv(U('uScrA[0]'), scrA);
      gl.uniform4fv(U('uScrB[0]'), scrB);
      gl.uniform4fv(U('uBlobs[0]'), blobData);
      gl.bindFramebuffer(gl.FRAMEBUFFER, mem.write.fbo);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      mem.swap();
    }

    function render() {
      if (!W || !H) return;
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      if (specDirty) {
        gl.bindTexture(gl.TEXTURE_2D, specTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPEC_W, 1, gl.RED, gl.UNSIGNED_BYTE, specBytes);
        gl.bindTexture(gl.TEXTURE_2D, null);
        specDirty = false;
      }
      if (simOk) runEvolve();

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0.02, 0.02, 0.051, 1);       // #05050d
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pComposite.prog);
      const U = pComposite.U;
      if (simOk) {
        bindTex(0, mem.read.tex);
        gl.uniform1i(U('uMem'), 0);
        gl.uniform2f(U('uMemTexel'), 1 / MW, 1 / MH);
        gl.uniform1f(U('uLegib'), scr.legib);
      } else {
        gl.uniform1f(U('uAspect'), W / H);
        gl.uniform4fv(U('uRipples[0]'), ripData);
        gl.uniform1fv(U('uRippleHue[0]'), ripHue);
      }
      gl.uniform2f(U('uRes'), W, H);
      gl.uniform1f(U('uTime'), scr.time);
      gl.uniform1f(U('uEcho'), scr.echo);
      gl.uniform1i(U('uPalette'), scr.palette);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        // Grid width follows aspect — realloc (forgetting the wake) only when
        // it actually changes.
        const newMW = Math.max(16, Math.round(MEM_H * (W / H || 1)));
        if (newMW !== MW || !simOk) allocGrid();
      },
      update,
      render,
      dispose() {
        if (mem) { freeTarget(mem.read); freeTarget(mem.write); mem = null; }
        gl.deleteTexture(specTex);
        if (pEvolve) gl.deleteProgram(pEvolve.prog);
        gl.deleteProgram(pComposite.prog);
        gl.deleteVertexArray(vao);
      },
    };
  },
};
