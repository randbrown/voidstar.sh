// No Man's Land — a liminal threshold-scape for slow ambient sets. A dark
// borderland strip between two territories, drifted through at walking pace:
// the camera glides along a river of light while beacon-monoliths approach
// from the vanishing point, pass, and slide out of frame — an endless
// procession of markers alternating sides of the water. Dream-geography
// ridgelines swell with the long memory of the spectrum, a void-orbital moon
// (black disc, hairline ring, slow electron shells) hangs at the threshold,
// and each performer's hands are tethered to their nearest stars by faint
// survey lines. Three hand-built perspectives share the one world — the
// side-on strip, a cartographer's overhead map, and standing in the river
// looking downstream — walked by auto-phase as real chapters. Built for the
// 2026 "No Man's Land" exhibit opening at the Knoxville Museum of Art —
// projection-friendly, museum-calm: audio moves color and light, never jumps.
//
// Audio map (color/light only — no geometry snaps to audio):
//   audio.total    → aurora luminance breath          (declarative, `aurora`)
//   audio.bass     → beacon glow + earthen warmth     (declarative on
//                    `beaconLight`; inline warm tint on the land)
//   audio.mids     → aurora fine-curtain detail       (inline, uBands.y)
//   audio.rms      → river luminance                  (declarative, `river`)
//   audio.highs    → star glints                      (inline, gentle)
//   audio.spectrum → ridge terrain, via slow attack / very-slow decay
//                    envelopes — the land remembers the sound (`eqRidge`)
//   audio.beat     → slow luminance wave down the river + a slow orbital
//                    shell emitted from the void moon (6–9s traversals)
//   audio.pitchClass → very slow aurora/river hue glide (gated on pitchConf)
//
// Pose map:
//   star links     → head + wrists of every person tether to their nearest
//                    `starLinks` stars; distance-faded so links crossfade
//                    instead of popping (screen-anchored to the skeleton the
//                    overlay draws, works for any headcount)
//   beacon breath  → RELATIVE gestures only: wrist spread ÷ shoulder span +
//                    wrist lift ÷ torso, per person, breathe light into the
//                    beacon passing that person's station depth
//   pose.headPitch → aurora (declarative, scale-invariant lean)

import { compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter, uploadAudioUniforms } from '../webgl.js';
import { scaleAudio } from '../field.js';
import { lmToCanvas } from '../video.js';

const NB_VIS  = 6;    // max beacons on screen
const MAX_LINK = 20;  // max pose→star survey lines
const N_EQ   = 24;    // spectrum envelope bins
const N_STAR = 28;    // CPU anchor-star catalog (link endpoints)
const HY   = 0.42;    // strip-view horizon
const HY_R = 0.30;    // riverbed-view horizon
const Z_VIS  = 60;    // world units from camera to horizon (strip/riverbed)
const Z_OVER = 80;    // world units spanned by the overhead map
const SPACING = 22;   // world units between beacons

const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform int   uView;         // 0 strip · 1 overhead · 2 riverbed
uniform float uTravel;       // world distance traveled along the strip
uniform float uAurora;
uniform float uBeaconLight;
uniform float uRiver;
uniform float uEqAmt;        // spectrum→terrain amount
uniform int   uPalette;
uniform float uHueShift;
uniform float uEq[${N_EQ}];  // slow spectrum envelopes, 0..1
uniform vec4  uBeacons[${NB_VIS}];  // x01, baseY, height, glow
uniform vec4  uBeaconB[${NB_VIS}];  // alpha, seed, colorTilt, unused
uniform int   uBeaconN;
uniform vec4  uLinks[${MAX_LINK}];  // star(x,y) → joint(x,y), vUv space
uniform float uLinkA[${MAX_LINK}];
uniform int   uLinkN;
uniform vec2  uMoon;
uniform vec4  uWaves[2];     // river waves: progress, amp
uniform vec4  uRings[2];     // orbital shells: progress, amp

uniform vec4  uBands;        // (bass, mids, highs, total)
uniform vec2  uBeat;
uniform vec2  uHighs;
uniform float uRms;

const float HY   = ${HY};
const float HY_R = ${HY_R};

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
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
  return v;
}
float n1(float x, float seed) {
  float i = floor(x), f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(hash(vec2(i, seed)), hash(vec2(i + 1.0, seed)), u);
}
float ridge1(float x, float seed) {
  float v = 0.0, a = 0.55, fr = 1.0;
  for (int i = 0; i < 3; i++) { v += a * n1(x * fr, seed + float(i) * 7.7); fr *= 2.13; a *= 0.5; }
  return v;
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
float sdRBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
// Spectrum envelope sampled along x with inter-bin smoothing.
float eqSample(float x) {
  float f = clamp(x, 0.0, 1.0) * float(${N_EQ} - 1);
  int i = int(floor(f));
  int j = min(i + 1, ${N_EQ} - 1);
  return mix(uEq[i], uEq[j], fract(f));
}
// World-space river centerline. lt is the perspective convergence factor
// (0 at the vanishing point → 1 at the viewer); overhead passes lt = 1.
float riverX(float wz, float lt) {
  return 0.5
    + (n1(wz * 0.045, 44.0) - 0.5) * 0.62 * lt
    + 0.085 * sin(wz * 0.08) * lt
    + (n1(wz * 0.018, 45.5) - 0.5) * 0.20 * lt;
}

void palette(int idx, out vec3 skyT, out vec3 skyH, out vec3 aurA, out vec3 aurB,
             out vec3 land, out vec3 riverC, out vec3 glowC, out vec3 sigC,
             out vec3 moteC, out vec3 ringC, out float hueAmt) {
  if (idx == 1) {          // wayside — dusk lantern warmth on the roadside
    skyT = vec3(0.028, 0.018, 0.045); skyH = vec3(0.130, 0.066, 0.048);
    aurA = vec3(0.85, 0.50, 0.16);    aurB = vec3(0.50, 0.19, 0.38);
    land = vec3(0.034, 0.024, 0.038); riverC = vec3(0.95, 0.55, 0.25);
    glowC = vec3(1.00, 0.70, 0.30);   sigC = vec3(0.90, 0.70, 0.48);
    moteC = vec3(0.95, 0.70, 0.35);   ringC = vec3(1.00, 0.75, 0.45);
    hueAmt = 0.35;
  } else if (idx == 2) {   // pasaquan — richer wandering hue, held quiet
    skyT = vec3(0.030, 0.016, 0.055); skyH = vec3(0.100, 0.050, 0.130);
    aurA = vec3(0.78, 0.24, 0.62);    aurB = vec3(0.14, 0.66, 0.58);
    land = vec3(0.030, 0.024, 0.050); riverC = vec3(0.82, 0.45, 0.82);
    glowC = vec3(1.00, 0.62, 0.72);   sigC = vec3(0.95, 0.65, 0.85);
    moteC = vec3(0.62, 0.88, 0.55);   ringC = vec3(0.95, 0.55, 0.85);
    hueAmt = 1.6;
  } else if (idx == 3) {   // borderwater — sea-green threshold, river leads
    skyT = vec3(0.012, 0.028, 0.045); skyH = vec3(0.040, 0.098, 0.108);
    aurA = vec3(0.10, 0.72, 0.52);    aurB = vec3(0.10, 0.30, 0.68);
    land = vec3(0.020, 0.032, 0.044); riverC = vec3(0.35, 0.95, 0.85);
    glowC = vec3(0.75, 0.95, 1.00);   sigC = vec3(0.50, 0.90, 0.80);
    moteC = vec3(0.40, 0.90, 0.70);   ringC = vec3(0.55, 0.95, 0.90);
    hueAmt = 0.45;
  } else if (idx == 4) {   // concrete — silver monument dusk, one warm light
    skyT = vec3(0.022, 0.024, 0.034); skyH = vec3(0.075, 0.080, 0.100);
    aurA = vec3(0.42, 0.47, 0.58);    aurB = vec3(0.24, 0.27, 0.37);
    land = vec3(0.028, 0.030, 0.040); riverC = vec3(0.60, 0.68, 0.78);
    glowC = vec3(1.00, 0.92, 0.78);   sigC = vec3(0.85, 0.88, 0.95);
    moteC = vec3(0.58, 0.60, 0.68);   ringC = vec3(0.90, 0.92, 1.00);
    hueAmt = 0.15;
  } else {                 // liminal — canonical voidstar cyan/violet/gold
    skyT = vec3(0.020, 0.020, 0.051); skyH = vec3(0.055, 0.072, 0.135);
    aurA = vec3(0.10, 0.62, 0.70);    aurB = vec3(0.36, 0.21, 0.70);
    land = vec3(0.024, 0.026, 0.050); riverC = vec3(0.28, 0.75, 0.85);
    glowC = vec3(1.00, 0.78, 0.42);   sigC = vec3(0.55, 0.75, 0.95);
    moteC = vec3(0.52, 0.82, 0.62);   ringC = vec3(0.65, 0.85, 1.00);
    hueAmt = 0.55;
  }
}

// ── The void moon as the voidstar emblem: black disc, hairline ring, three
// inclined electron shells with slow orbiting glints, plus expanding shell
// pulses on musical swells. No text — just the orbital energy.
void drawVoid(inout vec3 col, vec2 sc, vec2 mp, float R, vec3 ringC, vec3 skyT, float t) {
  float md = length(sc - mp);
  if (md > R * 8.0) return;
  float breathe = 0.65 + 0.35 * sin(t * 0.11);
  // body + hairline + soft halo
  col = mix(col, skyT * 0.45, smoothstep(R, R * 0.92, md));
  col += ringC * exp(-pow((md - R * 1.08) / (R * 0.040), 2.0)) * 0.40 * breathe;
  col += ringC * exp(-pow((md - R * 1.15) / (R * 0.55),  2.0)) * 0.05 * breathe;
  // electron shells — ellipse rings at three inclinations, one glint each
  // (plus a comet-fade trailing glint), orbiting slowly.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float a  = -0.45 + fi * 0.85;                 // inclination
    float rr = R * (1.75 + fi * 0.55);            // shell radius
    float sq = 0.30 + fi * 0.05;                  // squash
    float ca = cos(a), sa = sin(a);
    vec2 lp = vec2(ca * (sc.x - mp.x) + sa * (sc.y - mp.y),
                  -sa * (sc.x - mp.x) + ca * (sc.y - mp.y));
    lp.y /= sq;
    float rd = abs(length(lp) - rr);
    col += ringC * exp(-pow(rd / (R * 0.045), 2.0)) * (0.10 + 0.04 * sin(t * 0.07 + fi * 2.1));
    float th = t * (0.12 + fi * 0.05) * (mod(fi, 2.0) < 1.0 ? 1.0 : -1.0) + fi * 2.4;
    for (int g = 0; g < 2; g++) {
      float thg = th - float(g) * 0.22;
      vec2 ep = vec2(cos(thg), sin(thg)) * rr;
      float gd = length(lp - ep);
      col += ringC * exp(-pow(gd / (R * (0.09 + 0.05 * float(g))), 2.0)) * (g == 0 ? 0.55 : 0.18);
    }
  }
  // expanding shells on swells — quiet, close to the void
  for (int i = 0; i < 2; i++) {
    float pr = uRings[i].x, amp = uRings[i].y;
    if (amp > 0.001) {
      float rr = mix(R * 1.3, R * 7.0, pr);
      float w  = R * (0.22 + pr * 0.55);
      col += ringC * exp(-pow((md - rr) / w, 2.0)) * amp * (1.0 - pr) * (1.0 - pr) * 0.16;
    }
  }
}

// Beacon body + light column, shared by strip and riverbed views.
void drawBeacon(inout vec3 col, vec2 sc, float aspect, vec4 b, vec4 meta,
                vec3 glowC, vec3 land, vec3 skyT, float t) {
  float bx = b.x * aspect;
  float baseY = b.y, h = b.z, glow = b.w;
  float alpha = meta.x, seed = meta.y, tilt = meta.z;
  float w = h * 0.24;
  if (abs(sc.x - bx) > w * 2.0 + 0.035 || alpha < 0.01) return;
  vec3 gC = glowC * (1.0 + tilt * vec3(0.15, 0.02, -0.18));
  float topY = baseY + h;

  // light column — transmission to the stars
  float cw = 0.0045 + h * 0.018;
  float lat = exp(-pow((sc.x - bx) / (cw * (1.0 + max(0.0, sc.y - topY) * 0.8)), 2.0));
  float vfade = smoothstep(topY - 0.01, topY + 0.02, sc.y) * exp(-(sc.y - topY) * 2.1);
  float flick = 0.8 + 0.2 * n1(t * 0.20 + seed * 9.0, 3.0 + seed);
  col += gC * lat * vfade * uBeaconLight * glow * flick * 0.50 * alpha;

  // stone body
  vec2 lp = vec2(sc.x - bx, sc.y - (baseY + h * 0.5));
  float sd = sdRBox(lp, vec2(w * 0.5, h * 0.5), w * 0.42);
  if (sd < 0.0) {
    float vt = clamp((lp.y / h) + 0.5, 0.0, 1.0);
    vec3 stone = mix(land * 1.5, skyT * 1.8, vt * 0.4);
    float heart = exp(-pow((vt - 0.78) / 0.26, 2.0));
    stone += gC * heart * uBeaconLight * glow * 0.55;
    // carved inscription shimmer — density scales with apparent size
    vec2 gp = vec2(lp.x / w * 6.0, vt * (14.0 + h * 55.0));
    vec2 gf = fract(gp) - 0.5;
    float gh = hash(floor(gp) + seed * 31.0 + floor(t * 0.22) * 0.37);
    stone += gC * step(0.78, gh) * exp(-dot(gf, gf) * 9.0) * heart * 0.07 * uBeaconLight
           * step(abs(lp.x), w * 0.30);
    col = mix(col, stone, smoothstep(0.0015, -0.0015, sd) * alpha);
  }
  col += gC * exp(-abs(sd) * 420.0) * uBeaconLight * glow * 0.14 * alpha;
  if (sc.y < baseY + 0.012) {
    float pd = (sc.x - bx) * (sc.x - bx) + (sc.y - baseY) * (sc.y - baseY) * 7.0;
    col += gC * exp(-pd / (0.0022 + h * 0.004)) * uBeaconLight * glow * 0.10 * alpha;
  }
}

// Procedural background starfield (bright anchor glints live on the links).
float starField(vec2 sc, float t) {
  vec2 g = sc * 34.0;
  vec2 cell = floor(g), local = fract(g) - 0.5;
  float h = hash(cell);
  float r = length(local - (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.6);
  float s = step(0.962, h) * exp(-r * r * 46.0) * (0.55 + 0.45 * sin(t * (0.25 + h * 0.5) + h * 37.0));
  vec2 g2 = sc * 15.0;
  vec2 c2 = floor(g2), l2 = fract(g2) - 0.5;
  float h2 = hash(c2 + 91.0);
  float r2 = length(l2 - (vec2(hash(c2 + 13.0), hash(c2 + 17.0)) - 0.5) * 0.6);
  s += step(0.975, h2) * exp(-r2 * r2 * 30.0) * (0.5 + 0.5 * sin(t * 0.18 + h2 * 51.0));
  return s;
}

// Pose→star survey lines with soft glints at both ends.
void drawLinks(inout vec3 col, vec2 sc, float aspect, vec3 sigC) {
  for (int i = 0; i < ${MAX_LINK}; i++) {
    if (i >= uLinkN) break;
    float a = uLinkA[i];
    if (a < 0.01) continue;
    vec4 s = uLinks[i];
    vec2 pa = vec2(s.x * aspect, s.y), pb = vec2(s.z * aspect, s.w);
    float d = sdSeg(sc, pa, pb);
    col += sigC * (exp(-d * 800.0) * 0.30 + exp(-d * 120.0) * 0.05) * a;
    float da = length(sc - pa), db = length(sc - pb);
    col += sigC * exp(-pow(da / 0.006, 2.0)) * 0.55 * a;   // the star, claimed
    col += sigC * exp(-pow(db / 0.010, 2.0)) * 0.22 * a;   // the hand, softly
  }
}

void main() {
  vec2  res = uResolution;
  float aspect = res.x / res.y;
  float x01 = vUv.x;
  float y   = vUv.y;
  vec2  sc  = vec2(x01 * aspect, y);

  vec3 skyT, skyH, aurA, aurB, land, riverC, glowC, sigC, moteC, ringC;
  float hueAmt;
  palette(uPalette, skyT, skyH, aurA, aurB, land, riverC, glowC, sigC, moteC, ringC, hueAmt);
  float rot = uHueShift * hueAmt;
  aurA = hueRotate(aurA, rot); aurB = hueRotate(aurB, rot);
  riverC = hueRotate(riverC, rot);

  float t = uTime;
  vec3 col;

  if (uView == 1) {
    // ── OVERHEAD — the cartographer's view. The map scrolls as we travel;
    // contour lines record the terrain (and the spectrum), the river writes
    // its meander down the page, beacons are double-ring survey marks.
    float wz = uTravel + y * float(${Z_OVER});   // ahead is up the page
    float xr = riverX(wz, 1.0) * 0.9 + 0.05;
    float side = sign(x01 - xr);

    // two jurisdictions, faintly different tones, the strip between them
    vec3 terrA = land * 1.35 + skyH * 0.16;
    vec3 terrB = land * 0.85 + skyT * 0.30;
    float dRiv = abs(x01 - xr) * aspect;
    col = mix(terrA, terrB, smoothstep(-0.05, 0.05, x01 - xr));
    col = mix(col, land * 0.8, exp(-dRiv * dRiv * 260.0) * 0.5);    // floodplain

    // terrain height → tonal relief + contour lines, warped by the
    // spectrum's memory — the map records the sound
    float hgt = fbm(vec2(sc.x * 1.6, wz * 0.028)) + eqSample(x01) * 0.35 * uEqAmt;
    col *= 0.82 + hgt * 0.42;                                       // relief wash
    float ct = fract(hgt * 7.0);
    float contour = smoothstep(0.055, 0.0, min(ct, 1.0 - ct));
    col += sigC * contour * 0.11 * (0.7 + uBands.x * 0.3);

    // graticule — the surveyor's faint grid, latitude lines fixed to the world
    float gy = fract(wz / 8.8);
    float grat = max(smoothstep(0.012, 0.0, abs(fract(x01 / 0.22) - 0.5) * 0.22),
                     smoothstep(0.0028, 0.0, min(gy, 1.0 - gy) * 8.8 / float(${Z_OVER})));
    col += sigC * grat * 0.022;

    // the river writes down the page; waves run from far (top) toward us
    float wave = 0.0;
    for (int i = 0; i < 2; i++) {
      float pr = uWaves[i].x, amp = uWaves[i].y;
      if (amp > 0.001) wave += amp * exp(-pow((y - mix(1.0, 0.0, pr)) / 0.06, 2.0)) * (1.0 - pr * 0.6);
    }
    float shimmer = 0.55 + 0.45 * vnoise(vec2(wz * 0.35, xr * 12.0));
    float w = 0.012 + 0.008 * n1(wz * 0.06, 71.0);
    col = mix(col, col * 0.7, exp(-(dRiv * dRiv) / (w * w * 3.0)) * 0.5);
    col += riverC * exp(-(dRiv * dRiv) / (w * w)) * uRiver * (0.26 + 0.28 * shimmer + wave * 0.55);

    // beacons as luminous survey marks — dot, double ring, radial bloom
    for (int i = 0; i < ${NB_VIS}; i++) {
      if (i >= uBeaconN) break;
      vec4 b = uBeacons[i];
      vec2 bp = vec2(b.x * aspect, b.y);
      float bd = length(sc - bp);
      if (bd > 0.16) continue;
      float alpha = uBeaconB[i].x, glow = b.w;
      vec3 gC = glowC * (1.0 + uBeaconB[i].z * vec3(0.15, 0.02, -0.18));
      col += gC * exp(-pow(bd / 0.0045, 2.0)) * uBeaconLight * glow * 0.9 * alpha;
      col += gC * exp(-pow((bd - 0.016) / 0.0028, 2.0)) * 0.30 * alpha;
      col += gC * exp(-pow((bd - 0.030) / 0.0030, 2.0)) * 0.16 * alpha;
      col += gC * exp(-bd * 22.0) * uBeaconLight * glow * 0.10 * alpha;   // bloom toward us
    }

    // orbital emblem as a quiet cartouche in the corner of the map
    drawVoid(col, sc, vec2(0.88 * aspect, 0.84), 0.030, ringC * 0.8, skyT, t);
  } else {
    // ── STRIP and RIVERBED share the sky-over-land structure.
    bool bed = (uView == 2);
    float hy = bed ? HY_R : HY;

    // ridge silhouettes; the far ridge carries the spectrum's slow memory
    float eqh = eqSample(x01) * uEqAmt;
    float r0, r1, r2, r3;
    if (bed) {
      r0 = hy + 0.045 + (ridge1(sc.x * 1.45 + uTravel * 0.004, 91.0) - 0.5) * 0.070 + eqh * 0.085;
      r1 = hy + 0.020 + (ridge1(sc.x * 2.00 + uTravel * 0.007, 23.0) - 0.5) * 0.045 + eqh * 0.030;
      r2 = r1; r3 = hy - 0.004 + (ridge1(sc.x * 2.9 + uTravel * 0.011, 51.0) - 0.5) * 0.020;
    } else {
      r0 = hy + 0.064 + (ridge1(sc.x * 1.30 + uTravel * 0.0045, 11.0) - 0.5) * 0.120 + eqh * 0.105;
      r1 = hy + 0.036 + (ridge1(sc.x * 1.75 + uTravel * 0.008,  23.0) - 0.5) * 0.085 + eqh * 0.045;
      r2 = hy + 0.014 + (ridge1(sc.x * 2.30 + uTravel * 0.013,  37.0) - 0.5) * 0.055 + eqh * 0.015;
      r3 = hy - 0.006 + (ridge1(sc.x * 3.00 + uTravel * 0.020,  51.0) - 0.5) * 0.028;
    }

    if (y > r0) {
      // SKY
      float ay = clamp((y - hy) / (1.0 - hy), 0.0, 1.0);
      col = mix(skyH, skyT, smoothstep(0.0, 0.85, ay));

      // gravitational pull of the void bends the field behind it
      vec2 mp = vec2(uMoon.x * aspect, uMoon.y);
      float R = bed ? 0.075 : 0.050;
      float mdd = max(length(sc - mp), R);
      vec2 scLens = sc + normalize(sc - mp) * (R * R * 1.1) / mdd;

      float starGain = starField(scLens, t) * smoothstep(0.02, 0.16, ay);
      float glint = 1.0 + uHighs.y * 0.9 + uBands.z * 0.35;

      float tA = t * 0.025 + uTravel * 0.006;
      float envLo = bed ? 0.05 : 0.015, envHi = bed ? 0.35 : 0.24;
      float env = smoothstep(envLo, envHi, ay) * (1.0 - smoothstep(bed ? 0.70 : 0.52, bed ? 1.05 : 0.95, ay));
      float curt = fbm(vec2(scLens.x * 1.9 - tA, ay * 2.4 - tA * 0.35));
      float det  = fbm(vec2(scLens.x * 5.2 + tA * 0.7, ay * 7.0 + 3.3));
      float aur = env * (0.30 + 0.70 * curt) * (0.55 + (0.35 + uBands.y * 0.55) * det) * uAurora;
      col += mix(aurA, aurB, clamp(ay * 1.7, 0.0, 1.0)) * aur * 0.85;
      col += vec3(0.90, 0.95, 1.00) * starGain * glint * 0.55 * (1.0 - min(1.0, aur * 1.8) * 0.6);

      drawVoid(col, sc, mp, R, ringC, skyT, t);
    } else if (!bed && y > r1) {
      col = mix(skyH, skyT, 0.30) * 0.85;
      col += aurA * exp(-(r0 - y) * 30.0) * 0.16 * uAurora;
    } else if (!bed && y > r2) {
      col = mix(skyH, skyT, 0.52) * 0.55;
      col += aurA * exp(-(r1 - y) * 38.0) * 0.10 * uAurora;
      col += glowC * exp(-(r1 - y) * 70.0) * 0.03;
    } else if (y > r3) {
      col = mix(land, skyT, 0.35) * (bed ? 0.55 : 0.62);
      float stri = 0.5 + 0.5 * sin(sc.x * 90.0 + n1(sc.x * 3.1, 66.0) * 8.0);
      col *= 1.0 + stri * 0.05;
      col += glowC * exp(-(r2 - y) * 44.0) * 0.055 * (0.5 + uBands.x * 0.5);
      if (bed) col += aurA * exp(-(r0 - y) * 30.0) * 0.10 * uAurora;
    } else {
      // THE STRIP — land flowing past as we travel
      float lt = clamp((r3 - y) / max(r3, 1e-3), 0.0, 1.0);
      float wz = uTravel + pow(1.0 - lt, 2.0) * float(${Z_VIS});
      col = land * (1.0 - lt * 0.45);
      col = mix(col, col * vec3(1.55, 1.22, 0.88), uBands.x * 0.30);
      float stri = 0.5 + 0.5 * sin(sc.x * 70.0 + n1(wz * 0.11, 77.0) * 9.0);
      col *= 1.0 + stri * 0.04 * (1.0 - lt);
      col += glowC * exp(-(r3 - y) * 50.0) * 0.05 * (0.5 + uBands.x * 0.5);

      if (uRiver > 0.003) {
        float xr; float w;
        if (bed) {
          // standing in the water — the river opens wide beneath us
          xr = 0.5 + (riverX(wz, 1.0) - 0.5) * 0.22 * (1.0 - lt);
          w = mix(0.010, 0.55, pow(lt, 1.6));
        } else {
          xr = riverX(wz, lt);
          w = mix(0.006, 0.085, lt * lt);
        }
        float d = abs(x01 - xr) * aspect;
        float bedM = exp(-(d * d) / (w * w * 3.2));
        col = mix(col, col * 0.72, bedM * 0.55);
        float shimmer = 0.55 + 0.45 * vnoise(vec2(wz * (bed ? 0.9 : 0.5) - t * 0.45, xr * 12.0));
        float wave = 0.0;
        for (int i = 0; i < 2; i++) {
          float pr = uWaves[i].x, amp = uWaves[i].y;
          if (amp > 0.001) {
            float yw = bed ? mix(0.0, r3, pr) : mix(r3, 0.0, pr);
            wave += amp * exp(-pow((y - yw) / 0.055, 2.0)) * (1.0 - pr * 0.6);
          }
        }
        col += riverC * exp(-(d * d) / (w * w)) * uRiver
             * ((bed ? 0.22 : 0.26) + 0.30 * shimmer + wave * 0.55);
      }

      // motes drifting off the strip
      vec2 g = vec2(sc.x, y + wz * 0.0012) * 16.0;
      vec2 cell = floor(g), local = fract(g) - 0.5;
      float h = hash(cell + 5.0);
      float r = length(local - (vec2(hash(cell + 1.3), hash(cell + 2.6)) - 0.5) * 0.7);
      col += moteC * step(0.90, h) * exp(-r * r * 130.0)
           * (0.35 + 0.65 * (0.5 + 0.5 * sin(t * 0.35 + h * 40.0))) * 0.12;
    }

    // the procession of beacons, far → near
    for (int i = 0; i < ${NB_VIS}; i++) {
      if (i >= uBeaconN) break;
      drawBeacon(col, sc, aspect, uBeacons[i], uBeaconB[i], glowC, land, skyT, t);
    }
  }

  // pose→star survey lines ride above everything but the grain
  if (uLinkN > 0) drawLinks(col, sc, aspect, sigC);

  vec2 vc = (vUv - 0.5) * vec2(aspect, 1.0);
  col *= smoothstep(1.65, 0.55, length(vc));
  col = pow(col, vec3(0.92));
  col += (hash(vUv * res + fract(t) * 61.7) - 0.5) * 0.008;
  outColor = vec4(col, 1.0);
}
`;

const PALETTES = ['liminal', 'wayside', 'pasaquan', 'borderwater', 'concrete'];
const VIEWS = ['strip', 'overhead', 'riverbed'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fractJs = (v) => v - Math.floor(v);
// Mirrors the GLSL hash/n1 so CPU-placed beacons agree with the shader river.
function hashJs(px, py) {
  let x = fractJs(px * 123.34), y = fractJs(py * 456.21);
  const d = x * (x + 45.32) + y * (y + 45.32);
  x += d; y += d;
  return fractJs(x * y);
}
function n1Js(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hashJs(i, seed) * (1 - u) + hashJs(i + 1, seed) * u;
}
function riverXJs(wz, lt) {
  return 0.5
    + (n1Js(wz * 0.045, 44.0) - 0.5) * 0.62 * lt
    + 0.085 * Math.sin(wz * 0.08) * lt
    + (n1Js(wz * 0.018, 45.5) - 0.5) * 0.20 * lt;
}

// Anchor-star catalog for the pose links — positions in sky-fraction space
// (x across, y as fraction of the sky band), with slow individual drift.
const STAR_BASE = [];
for (let i = 0; i < N_STAR; i++) {
  STAR_BASE.push({
    x: 0.06 + hashJs(i * 1.7 + 0.3, 5.1) * 0.88,
    y: 0.12 + hashJs(i * 2.3 + 1.1, 9.7) * 0.80,
    ph: hashJs(i * 3.1, 2.2) * 6.28,
  });
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'no_mans_land',
  name: 'No Man’s Land',
  contextType: 'webgl2',
  // Full-screen fbm sky + ridge layers + SDF loops: medium fragment load —
  // render crisp up to 1.25× so a 2-hour projection set holds frame rate.
  maxDpr: 1.25,

  params: [
    { id: 'view',        label: 'view',         type: 'select', options: VIEWS, default: 'strip' },
    { id: 'palette',     label: 'palette',      type: 'select', options: PALETTES, default: 'liminal' },
    { id: 'travel',      label: 'travel',       type: 'range', min: 0, max: 2,   step: 0.05, default: 0.5 },
    { id: 'aurora',      label: 'aurora',       type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.8,
      modulators: [
        { source: 'audio.total',    mode: 'mul', amount: 0.35 },
        { source: 'pose.headPitch', mode: 'add', amount: 0.12 },  // lean back → the sky opens
      ] },
    { id: 'beaconLight', label: 'beacon light', type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.9,
      modulators: [
        { source: 'audio.bass', mode: 'mul', amount: 0.40 },
      ] },
    { id: 'river',       label: 'river',        type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.8,
      modulators: [
        { source: 'audio.rms', mode: 'mul', amount: 0.50 },
      ] },
    { id: 'starLinks',   label: 'star links',   type: 'range', min: 0, max: 4,   step: 1,    default: 2 },
    { id: 'eqRidge',     label: 'eq ridge',     type: 'range', min: 0, max: 1,   step: 0.05, default: 0.45 },
    { id: 'reactivity',     label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'poseReactivity', label: 'pose react', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks real chapters now — perspective + palette + emphasis,
  // not just color. Mirrors the presets.
  autoPhase: {
    steps: [
      { view: 'strip',    palette: 'liminal',     aurora: 0.45, beaconLight: 0.70, river: 0.50, starLinks: 1, eqRidge: 0.30, travel: 0.35 },
      { view: 'strip',    palette: 'liminal',     aurora: 0.90, beaconLight: 0.90, river: 0.80, starLinks: 2, eqRidge: 0.50, travel: 0.50 },
      { view: 'riverbed', palette: 'borderwater', aurora: 0.70, beaconLight: 0.80, river: 1.20, starLinks: 2, eqRidge: 0.45, travel: 0.45 },
      { view: 'strip',    palette: 'wayside',     aurora: 0.55, beaconLight: 1.25, river: 0.70, starLinks: 2, eqRidge: 0.40, travel: 0.60 },
      { view: 'overhead', palette: 'pasaquan',    aurora: 0.80, beaconLight: 1.00, river: 1.00, starLinks: 0, eqRidge: 0.70, travel: 0.55 },
      { view: 'riverbed', palette: 'concrete',    aurora: 0.40, beaconLight: 0.95, river: 0.60, starLinks: 3, eqRidge: 0.55, travel: 0.35 },
    ],
  },

  presets: {
    default:      { view: 'strip',    palette: 'liminal',     travel: 0.5,  aurora: 0.8,  beaconLight: 0.9,  river: 0.8,  starLinks: 2, eqRidge: 0.45, reactivity: 1.0, poseReactivity: 1.0 },
    dusk:         { view: 'strip',    palette: 'liminal',     travel: 0.35, aurora: 0.45, beaconLight: 0.7,  river: 0.5,  starLinks: 1, eqRidge: 0.3 },
    riverwalk:    { view: 'riverbed', palette: 'borderwater', travel: 0.45, aurora: 0.7,  beaconLight: 0.8,  river: 1.2,  starLinks: 2 },
    wayside:      { view: 'strip',    palette: 'wayside',     travel: 0.6,  aurora: 0.55, beaconLight: 1.25, river: 0.7,  starLinks: 2 },
    cartographer: { view: 'overhead', palette: 'pasaquan',    travel: 0.55, aurora: 0.8,  beaconLight: 1.0,  river: 1.0,  starLinks: 0, eqRidge: 0.7 },
    monumentsky:  { view: 'riverbed', palette: 'concrete',    travel: 0.35, aurora: 0.4,  beaconLight: 0.95, river: 0.6,  starLinks: 3 },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    let W = canvas.width, H = canvas.height;

    // Pre-allocated uniform payloads + working state — hot path allocates nothing.
    const beaconData = new Float32Array(NB_VIS * 4);
    const beaconMeta = new Float32Array(NB_VIS * 4);
    const linkData   = new Float32Array(MAX_LINK * 4);
    const linkAlpha  = new Float32Array(MAX_LINK);
    const waveData   = new Float32Array(2 * 4);
    const ringData   = new Float32Array(2 * 4);
    const eqEnv      = new Float32Array(N_EQ);
    const eqTarget   = new Float32Array(N_EQ);
    const starUsed   = new Uint8Array(N_STAR);
    const starPos    = new Float32Array(N_STAR * 2);   // resolved vUv positions

    // Per-person gesture state (relative ratios, heavily smoothed).
    const MAXP = 4;
    const pPresence = new Float32Array(MAXP);
    const pGesture  = new Float32Array(MAXP);
    const pLean     = new Float32Array(MAXP);

    const waves = [ { progress: 1, amp: 0 }, { progress: 1, amp: 0 } ];
    const rings = [ { progress: 1, amp: 0 }, { progress: 1, amp: 0 } ];
    let lastBeatPulse = 0, lastWaveAt = -20, lastRingAt = -20, emitFlip = false;

    let travelPos = 0;
    let hueShift = 0;
    let moonX = 0.62, moonY = HY + 0.19;
    let beaconN = 0, linkN = 0;

    const scratch = {
      time: 0, view: 0, aurora: 0.8, beaconLight: 0.9,
      river: 0.8, eqRidge: 0.45, palette: 0,
    };
    let audioRef = null;

    function emitWave(time, amp) {
      const w = waves[0].amp <= 0.001 || waves[0].progress > waves[1].progress ? waves[0] : waves[1];
      w.progress = 0; w.amp = amp; lastWaveAt = time;
    }
    function emitRing(time, amp) {
      const r = rings[0].amp <= 0.001 || rings[0].progress > rings[1].progress ? rings[0] : rings[1];
      r.progress = 0; r.amp = amp; lastRingAt = time;
    }

    function update(field) {
      const { dt, time, pose, params, channels } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;

      const view = Math.max(0, VIEWS.indexOf(params.view));
      scratch.time        = time;
      scratch.view        = view;
      scratch.aurora      = params.aurora;
      scratch.beaconLight = params.beaconLight;
      scratch.river       = params.river;
      scratch.eqRidge     = params.eqRidge;
      scratch.palette     = Math.max(0, PALETTES.indexOf(params.palette));

      // ── Travel — the slow walk along the river.
      travelPos += dt * params.travel * 1.6;

      // ── Spectrum → terrain memory. Slow attack, much slower decay, so the
      // ridge swells with the music instead of dancing to it.
      const spec = field.audio.spectrum;
      if (spec && spec.length) {
        const n = spec.length;
        for (let b = 0; b < N_EQ; b++) {
          // log-ish binning: low bins narrow, high bins wide
          const f0 = Math.pow(b / N_EQ, 1.7), f1 = Math.pow((b + 1) / N_EQ, 1.7);
          const i0 = Math.min(n - 1, (f0 * n) | 0), i1 = Math.max(i0 + 1, Math.min(n, (f1 * n) | 0));
          let mx = 0;
          for (let i = i0; i < i1; i++) { if (spec[i] > mx) mx = spec[i]; }
          eqTarget[b] = Math.pow(mx / 255, 1.4) * params.reactivity;
        }
      } else {
        eqTarget.fill(0);
      }
      const kUp = Math.min(1, dt * 2.2), kDn = Math.min(1, dt * 0.30);
      for (let b = 0; b < N_EQ; b++) {
        const tv = eqTarget[b];
        eqEnv[b] += (tv - eqEnv[b]) * (tv > eqEnv[b] ? kUp : kDn);
      }

      // ── Per-person relative gestures (wrist spread ÷ span, lift ÷ torso).
      const people = pose.people;
      const kP = Math.min(1, dt * 0.7), kG = Math.min(1, dt * 2.0);
      const poseGain = params.poseReactivity ?? 1;
      for (let i = 0; i < MAXP; i++) {
        let present = 0, gest = pGesture[i], lean = pLean[i];
        const p = people[i];
        if (p) {
          const sL = p.shoulders?.l, sR = p.shoulders?.r;
          if (sL && sR && sL.visibility > 0.35 && sR.visibility > 0.35) {
            const span = Math.hypot(sR.x - sL.x, sR.y - sL.y);
            if (span >= 0.05) {
              present = 1;
              lean = Math.max(-1, Math.min(1, ((sR.y - sL.y) / span) * 1.8));
              const wL = p.wrists?.l, wR = p.wrists?.r;
              if (wL && wR && wL.visibility > 0.3 && wR.visibility > 0.3) {
                const smx = (sL.x + sR.x) * 0.5, smy = (sL.y + sR.y) * 0.5;
                const open = clamp01(((Math.hypot(wR.x - wL.x, wR.y - wL.y) / span) - 1.05) / 2.1);
                const hL = p.hips?.l, hR = p.hips?.r;
                let torso = span * 1.15;
                if (hL && hR && hL.visibility > 0.3 && hR.visibility > 0.3) {
                  torso = Math.max(0.05, Math.hypot((hL.x + hR.x) * 0.5 - smx, (hL.y + hR.y) * 0.5 - smy));
                }
                const lift = clamp01(((smy - (wL.y + wR.y) * 0.5) / torso + 0.55) / 1.15);
                gest = clamp01(open * 0.6 + lift * 0.4);
              } else {
                gest = 0.15;
              }
            }
          }
        }
        pPresence[i] += (present - pPresence[i]) * kP;
        pGesture[i]  += (gest - pGesture[i]) * kG;
        pLean[i]     += (lean - pLean[i]) * kG;
      }

      // ── The beacon procession. World-indexed conveyor: beacon k lives at
      // z = k·SPACING, alternating sides of the river; visible ones map to
      // screen via the active view's depth curve, filled far → near.
      const zVis = view === 1 ? Z_OVER : Z_VIS;
      const kLo = Math.ceil(travelPos / SPACING);
      let bn = 0;
      for (let k = kLo + Math.floor(zVis / SPACING); k >= kLo - 1 && bn < NB_VIS; k--) {
        const zk = k * SPACING;
        const zr = zk - travelPos;
        if (zr > zVis || zr < -SPACING * 0.35) continue;
        const side = (k % 2 === 0) ? 1 : -1;
        const hk = hashJs(k * 0.73 + 0.17, 8.8);
        let x, baseY, h, tN;
        if (view === 1) {
          // overhead: ahead is up the page — marks drift down as we travel
          tN = 1 - Math.max(0, zr) / zVis;
          x = riverXJs(zk, 1.0) * 0.9 + 0.05 + side * (0.10 + hk * 0.08);
          baseY = zr / zVis;   // screen y; <0 slides off the bottom, behind us
          h = 0;
        } else {
          // depth curve matches the land rows (wz = travel + (1-lt)²·Z), and
          // keeps extrapolating past the camera so a beacon slides out of
          // frame instead of freezing at the edge.
          tN = zr >= 0 ? 1 - Math.sqrt(zr / zVis) : 1 + Math.sqrt(-zr / zVis);
          const bedV = view === 2;
          if (bedV) {
            x = 0.5 + side * (0.16 + 0.36 * Math.pow(tN, 1.6)) + (hk - 0.5) * 0.05;
            baseY = (HY_R - 0.006) * (1 - tN);
            h = (0.05 + 0.50 * tN * tN) * (0.8 + hk * 0.4);
          } else {
            x = riverXJs(zk, Math.min(1, tN)) + side * (0.13 + hk * 0.10) * (0.35 + 0.65 * Math.min(1.3, tN));
            baseY = (HY - 0.008) * (1 - tN);
            h = (0.05 + 0.24 * tN * tN) * (0.8 + hk * 0.4);
          }
        }
        // spawn fade at the vanishing point; exit is a slide off frame
        const alpha = clamp01((zVis - zr) / (zVis * 0.10));
        // performer stations: each person's light rides whichever beacon is
        // passing their depth band — handoff comes free as the world moves
        let person = 0;
        for (let pi = 0; pi < MAXP; pi++) {
          if (pPresence[pi] < 0.02) continue;
          const st = 0.40 + 0.18 * (pi % 3);
          const wgt = Math.exp(-Math.pow((tN - st) / 0.16, 2));
          person += pPresence[pi] * (0.20 + 0.80 * pGesture[pi]) * wgt;
        }
        const breath = 0.30 + 0.12 * Math.sin(time * 0.21 + hk * 6.28);
        beaconData[bn * 4]     = x;
        beaconData[bn * 4 + 1] = baseY;
        beaconData[bn * 4 + 2] = h;
        beaconData[bn * 4 + 3] = Math.min(1.6, breath + person * 0.9 * poseGain);
        beaconMeta[bn * 4]     = alpha;
        beaconMeta[bn * 4 + 1] = hk;
        let tilt = 0;
        for (let pi = 0; pi < MAXP; pi++) tilt += pLean[pi] * pPresence[pi];
        beaconMeta[bn * 4 + 2] = Math.max(-1, Math.min(1, tilt)) * 0.6;
        beaconMeta[bn * 4 + 3] = 0;
        bn++;
      }
      beaconN = bn;

      // ── Pose→star survey links: head + wrists tether to their nearest
      // stars, alpha faded by distance so reassignments crossfade.
      let ln = 0;
      const linksPer = Math.round(params.starLinks);
      if (view !== 1 && linksPer > 0 && people.length > 0) {
        const skyBase = view === 2 ? HY_R + 0.06 : HY + 0.08;
        for (let s = 0; s < N_STAR; s++) {
          const st = STAR_BASE[s];
          starPos[s * 2]     = st.x + 0.012 * Math.sin(time * 0.013 + st.ph);
          starPos[s * 2 + 1] = skyBase + (st.y + 0.010 * Math.sin(time * 0.017 + st.ph * 1.7)) * (1 - skyBase);
        }
        starUsed.fill(0);
        const asp = W / Math.max(1, H);
        for (let pi = 0; pi < people.length && pi < MAXP && ln < MAX_LINK; pi++) {
          const p = people[pi];
          const joints = [p.head, p.wrists?.l, p.wrists?.r];
          for (let ji = 0; ji < 3 && ln < MAX_LINK; ji++) {
            const lm = joints[ji];
            if (!lm || lm.visibility < 0.35) continue;
            const [px, py] = lmToCanvas(lm.x, lm.y, W, H);
            const jx = px / W, jy = 1 - py / H;
            for (let n = 0; n < linksPer && ln < MAX_LINK; n++) {
              let best = -1, bestD = 1e9;
              for (let s = 0; s < N_STAR; s++) {
                if (starUsed[s]) continue;
                const dx = (starPos[s * 2] - jx) * asp, dy = starPos[s * 2 + 1] - jy;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD) { bestD = d2; best = s; }
              }
              if (best < 0) break;
              starUsed[best] = 1;
              const dist = Math.sqrt(bestD);
              // distance fade: a star drifts out of reach before it unlinks
              const a = clamp01(1.35 - dist * 2.6) * pPresence[pi] * clamp01(lm.visibility);
              if (a < 0.02) break;   // farther candidates are dimmer still
              linkData[ln * 4]     = starPos[best * 2];
              linkData[ln * 4 + 1] = starPos[best * 2 + 1];
              linkData[ln * 4 + 2] = jx;
              linkData[ln * 4 + 3] = jy;
              linkAlpha[ln] = a * 0.9;
              ln++;
            }
          }
        }
      }
      linkN = ln;

      // ── Beat → slow emissions, with autonomous fallbacks for silence.
      const pulse = audio.beat.pulse;
      if (pulse > 0.55 && lastBeatPulse <= 0.55) {
        if (time - lastWaveAt > 3.0) {
          emitFlip = !emitFlip;
          emitWave(time, 0.6 + audio.bands.total * 0.4);
          if (emitFlip && time - lastRingAt > 6.0) emitRing(time, 0.55 + audio.bands.total * 0.35);
        }
      }
      lastBeatPulse = pulse;
      if (time - lastWaveAt > 13.0) emitWave(time, 0.45);
      if (time - lastRingAt > 21.0) emitRing(time, 0.40);
      for (let i = 0; i < 2; i++) {
        const w = waves[i], r = rings[i];
        if (w.amp > 0.001) { w.progress += dt / 6.5; if (w.progress >= 1) { w.amp = 0; w.progress = 1; } }
        if (r.amp > 0.001) { r.progress += dt / 9.0; if (r.progress >= 1) { r.amp = 0; r.progress = 1; } }
        waveData[i * 4] = w.progress; waveData[i * 4 + 1] = w.amp;
        ringData[i * 4] = r.progress; ringData[i * 4 + 1] = r.amp;
      }

      // ── Pitch → hue glide; idle LFO when the rig is silent.
      const conf = channels?.['audio.pitchConf'] ?? 0;
      const pc   = channels?.['audio.pitchClass'] ?? 0;
      const hueTarget = conf > 0.35 ? (pc - 0.5) * 1.1 : Math.sin(time * 0.017) * 0.25;
      hueShift += (hueTarget - hueShift) * Math.min(1, dt * 0.25);

      // Void moon drifts across the threshold over the course of a set.
      const hy = view === 2 ? HY_R : HY;
      moonX = 0.62 + 0.06 * Math.sin(time * 0.008);
      moonY = hy + (view === 2 ? 0.34 : 0.19) + 0.018 * Math.sin(time * 0.011);
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0.02, 0.02, 0.051, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform1f(U('uTime'),        scratch.time);
      gl.uniform1i(U('uView'),        scratch.view);
      gl.uniform1f(U('uTravel'),      travelPos);
      gl.uniform1f(U('uAurora'),      scratch.aurora);
      gl.uniform1f(U('uBeaconLight'), scratch.beaconLight);
      gl.uniform1f(U('uRiver'),       scratch.river);
      gl.uniform1f(U('uEqAmt'),       scratch.eqRidge);
      gl.uniform1i(U('uPalette'),     scratch.palette);
      gl.uniform1f(U('uHueShift'),    hueShift);
      gl.uniform2f(U('uMoon'),        moonX, moonY);
      gl.uniform1i(U('uBeaconN'),     beaconN);
      gl.uniform1i(U('uLinkN'),       linkN);
      gl.uniform1fv(U('uEq[0]'),      eqEnv);
      gl.uniform4fv(U('uBeacons[0]'), beaconData);
      gl.uniform4fv(U('uBeaconB[0]'), beaconMeta);
      gl.uniform4fv(U('uLinks[0]'),   linkData);
      gl.uniform1fv(U('uLinkA[0]'),   linkAlpha);
      gl.uniform4fv(U('uWaves[0]'),   waveData);
      gl.uniform4fv(U('uRings[0]'),   ringData);
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
