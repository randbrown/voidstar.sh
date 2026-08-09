// No Man's Land — a liminal threshold-scape for slow ambient sets. A dark
// borderland strip between two territories: dream-geography ridgelines drift
// past in train-window parallax under an aurora veil, roadside beacon-monoliths
// stand in the strip transmitting thin columns of light toward the stars, a
// winding river of light carries sound down from the horizon, and a sparse
// survey-diagram constellation maps the territory still taking shape. A void
// moon hangs at the threshold, breathing slow concentric rings. Built for the
// 2026 "No Man's Land" exhibit opening at the Knoxville Museum of Art —
// projection-friendly, museum-calm: audio moves color and light, never size.
//
// Audio map (all color/glow — no geometry scales or jumps with audio):
//   audio.total   → aurora luminance breath          (declarative, on `aurora`)
//   audio.bass    → beacon glow + earthen land warmth (declarative on
//                   `beaconLight`; inline warm tint on the land)
//   audio.mids    → aurora fine-curtain detail        (inline, shader uBands.y)
//   audio.rms     → river luminance                   (declarative, on `river`)
//   audio.highs   → survey-line shimmer + star glints (declarative on
//                   `signals`; inline twinkle gain)
//   audio.beat    → slow luminance wave traveling down the river + a slow
//                   ring emitted from the void moon (6–9s traversals, CPU
//                   envelopes — emissions of light, not jumps)
//   audio.pitchClass → very slow aurora/river hue glide (the note being
//                   played tints the sky; gated on pitchConf)
//
// Pose map (RELATIVE gestures only — every input is a ratio normalized by the
// performer's own shoulder span / torso, so a seated performer at any distance
// reads the same; nothing uses absolute screen position):
//   per person (any count) → one beacon each, center-out: wrist spread ÷
//     shoulder span + wrist lift ÷ torso length breathe light into that
//     person's beacon column; shoulder roll ÷ span tilts its warmth
//   pose.headPitch (scale-invariant lean) → aurora (declarative, gentle)

import { compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter, uploadAudioUniforms } from '../webgl.js';
import { scaleAudio } from '../field.js';

const NB = 7;        // beacon-monoliths standing in the strip
const MAX_SEG = 14;  // survey-diagram segments
const HY = 0.42;     // horizon height in vUv space

const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform float uDrift;        // global motion speed (parallax, aurora, meander)
uniform float uAurora;       // aurora veil intensity
uniform float uBeaconLight;  // beacon glow + light columns
uniform float uRiver;        // river luminance
uniform float uSignals;      // survey-line + star-glint intensity
uniform int   uPalette;      // 0..4
uniform float uHueShift;     // radians — slow pitch-tracking hue glide
uniform vec4  uBeacons[${NB}];   // (x01, baseY, height, glow 0..~1.5)
uniform vec4  uSegs[${MAX_SEG}]; // survey segments (ax, ay, bx, by) in 01 space
uniform int   uSegN;
uniform vec2  uMoon;         // void-moon center (x01, y)
uniform vec4  uWaves[2];     // river waves: (progress 0..1, amp, -, -)
uniform vec4  uRings[2];     // moon rings:  (progress 0..1, amp, -, -)

// Audio uniforms shared with all qualia webgl fx.
uniform vec4  uBands;        // (bass, mids, highs, total)
uniform vec2  uBeat;         // (active, pulse)
uniform vec2  uHighs;        // (active, pulse)
uniform float uRms;

const float HY = ${HY};

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
// 1D value noise — ridge silhouettes.
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

// Palette slots — dark museum restraint, background pinned near #05050d so the
// screen blend over Hydra reads cleanly.
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

void main() {
  vec2  res = uResolution;
  float aspect = res.x / res.y;
  float x01 = vUv.x;
  float y   = vUv.y;
  vec2  sc  = vec2(x01 * aspect, y);   // aspect-true space for round features

  vec3 skyT, skyH, aurA, aurB, land, riverC, glowC, sigC, moteC, ringC;
  float hueAmt;
  palette(uPalette, skyT, skyH, aurA, aurB, land, riverC, glowC, sigC, moteC, ringC, hueAmt);
  float rot = uHueShift * hueAmt;
  aurA = hueRotate(aurA, rot); aurB = hueRotate(aurB, rot);
  riverC = hueRotate(riverC, rot);

  float drift = uDrift;
  float t = uTime;

  // Ridge silhouettes — dream-geography, train-window parallax. Far ridge
  // rises highest; each nearer layer sits lower and drifts a touch faster.
  float r0 = HY + 0.064 + (ridge1(sc.x * 1.30 + t * drift * 0.0060, 11.0) - 0.5) * 0.120;
  float r1 = HY + 0.036 + (ridge1(sc.x * 1.75 + t * drift * 0.0105, 23.0) - 0.5) * 0.085;
  float r2 = HY + 0.014 + (ridge1(sc.x * 2.30 + t * drift * 0.0170, 37.0) - 0.5) * 0.055;
  float r3 = HY - 0.006 + (ridge1(sc.x * 3.00 + t * drift * 0.0260, 51.0) - 0.5) * 0.028;

  vec3 col;
  if (y > r0) {
    // ── Sky ────────────────────────────────────────────────────────────────
    float ay = clamp((y - HY) / (1.0 - HY), 0.0, 1.0);
    col = mix(skyH, skyT, smoothstep(0.0, 0.85, ay));

    // Stars — static field, slow twinkle; highs add gentle glint, never strobe.
    float starGain = 0.0;
    {
      vec2 g = sc * 34.0;
      vec2 cell = floor(g), local = fract(g) - 0.5;
      float h = hash(cell);
      float on = step(0.962, h);
      float r = length(local - (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.6);
      float tw = 0.55 + 0.45 * sin(t * (0.25 + h * 0.5) + h * 37.0);
      starGain = on * exp(-r * r * 46.0) * tw;
      vec2 g2 = sc * 15.0;
      vec2 c2 = floor(g2), l2 = fract(g2) - 0.5;
      float h2 = hash(c2 + 91.0);
      float r2s = length(l2 - (vec2(hash(c2 + 13.0), hash(c2 + 17.0)) - 0.5) * 0.6);
      starGain += step(0.975, h2) * exp(-r2s * r2s * 30.0) * (0.5 + 0.5 * sin(t * 0.18 + h2 * 51.0));
    }
    float glint = 1.0 + uHighs.y * 0.9 + uBands.z * 0.35;
    starGain *= smoothstep(0.02, 0.16, ay);                    // fade at horizon

    // Aurora veil — the threshold made visible. Mids feed fine curtain detail.
    float tA = t * drift * 0.050;
    float env = smoothstep(0.015, 0.24, ay) * (1.0 - smoothstep(0.52, 0.95, ay));
    float curt = fbm(vec2(sc.x * 1.9 - tA, ay * 2.4 - tA * 0.35));
    float det  = fbm(vec2(sc.x * 5.2 + tA * 0.7, ay * 7.0 + 3.3));
    float aur = env * (0.30 + 0.70 * curt) * (0.55 + (0.35 + uBands.y * 0.55) * det) * uAurora;
    vec3 aurCol = mix(aurA, aurB, clamp(ay * 1.7, 0.0, 1.0));
    col += aurCol * aur * 0.85;

    col += vec3(0.90, 0.95, 1.00) * starGain * glint * 0.55 * (1.0 - min(1.0, aur * 1.8) * 0.6);

    // Void moon — a dark disc at the threshold, ringed with thin light.
    {
      vec2 mp = vec2(uMoon.x * aspect, uMoon.y);
      float md = length(sc - mp);
      float R = 0.050;
      col = mix(col, skyT * 0.55, smoothstep(R, R * 0.92, md));         // dark body
      float breathe = 0.65 + 0.35 * sin(t * 0.11);
      col += ringC * exp(-pow((md - R * 1.10) / (R * 0.045), 2.0)) * 0.38 * breathe;   // hairline
      col += ringC * exp(-pow((md - R * 1.15) / (R * 0.55),  2.0)) * 0.05 * breathe;   // soft halo
      // Slow concentric rings — quiet emissions on musical swells, staying
      // close to the moon so they whisper rather than target.
      for (int i = 0; i < 2; i++) {
        float pr = uRings[i].x, amp = uRings[i].y;
        if (amp > 0.001) {
          float rr = mix(R * 1.3, 0.42, pr);
          float w  = 0.012 + pr * 0.030;
          col += ringC * exp(-pow((md - rr) / w, 2.0)) * amp * (1.0 - pr) * (1.0 - pr) * 0.16;
        }
      }
    }

    // Survey diagram — sparse observatory lines linking beacon tips to sky
    // nodes, charting territory still taking shape.
    if (uSignals > 0.003) {
      float sig = 0.0;
      for (int i = 0; i < ${MAX_SEG}; i++) {
        if (i >= uSegN) break;
        vec4 s = uSegs[i];
        float d = sdSeg(sc, vec2(s.x * aspect, s.y), vec2(s.z * aspect, s.w));
        float ph = 0.40 + 0.60 * (0.5 + 0.5 * sin(t * 0.10 + float(i) * 2.19));
        sig += (exp(-d * 700.0) + exp(-d * 90.0) * 0.07) * ph;
      }
      col += sigC * sig * uSignals * (0.26 + uHighs.y * 0.22) * smoothstep(HY - 0.01, HY + 0.02, y);
    }
  } else if (y > r1) {
    col = mix(skyH, skyT, 0.30) * 0.85;                                  // far ridge haze
    col += aurA * exp(-(r0 - y) * 30.0) * 0.16 * uAurora;                // crest catches the veil
  } else if (y > r2) {
    col = mix(skyH, skyT, 0.52) * 0.55;
    col += aurA * exp(-(r1 - y) * 38.0) * 0.10 * uAurora;
    col += glowC * exp(-(r1 - y) * 70.0) * 0.03;                         // faint warm rim
  } else if (y > r3) {
    col = mix(land, skyT, 0.35) * 0.62;
    float stri = 0.5 + 0.5 * sin(sc.x * 90.0 + n1(sc.x * 3.1, 66.0) * 8.0);
    col *= 1.0 + stri * 0.05;                                            // faint linework
    col += glowC * exp(-(r2 - y) * 44.0) * 0.055 * (0.5 + uBands.x * 0.5);
  } else {
    // ── The strip — foreground land, river, motes ─────────────────────────
    float lt = clamp((r3 - y) / max(r3, 1e-3), 0.0, 1.0);                // 0 horizon → 1 near
    col = land * (1.0 - lt * 0.45);
    col = mix(col, col * vec3(1.55, 1.22, 0.88), uBands.x * 0.30);       // bass warms the earth
    float stri = 0.5 + 0.5 * sin(sc.x * 70.0 + n1(sc.x * 2.3, 77.0) * 9.0);
    col *= 1.0 + stri * 0.04 * (1.0 - lt);
    col += glowC * exp(-(r3 - y) * 50.0) * 0.05 * (0.5 + uBands.x * 0.5);

    // River of light — meander widens toward the viewer; sound travels it.
    if (uRiver > 0.003) {
      float tR = t * drift * 0.016;
      float xr = 0.5
        + (n1(y * 5.0 + tR, 44.0) - 0.5) * 0.62 * lt
        + 0.085 * sin(y * 9.0 + 1.7) * lt
        + (n1(y * 2.1 - tR * 0.6, 45.5) - 0.5) * 0.20;
      float w = mix(0.006, 0.085, lt * lt);
      float d = abs(x01 - xr) * aspect;
      float bed = exp(-(d * d) / (w * w * 3.2));
      col = mix(col, col * 0.72, bed * 0.55);                            // darker riverbed
      float shimmer = 0.55 + 0.45 * vnoise(vec2(y * 26.0 - t * 0.45, xr * 12.0));
      float wave = 0.0;
      for (int i = 0; i < 2; i++) {
        float pr = uWaves[i].x, amp = uWaves[i].y;
        if (amp > 0.001) {
          float yw = mix(r3, 0.0, pr);
          wave += amp * exp(-pow((y - yw) / 0.055, 2.0)) * (1.0 - pr * 0.6);
        }
      }
      col += riverC * exp(-(d * d) / (w * w)) * uRiver * (0.26 + 0.30 * shimmer + wave * 0.55);
    }

    // Drifting motes — slow seeds of light rising off the strip.
    {
      vec2 g = vec2(sc.x, y - t * 0.0045) * 16.0;
      vec2 cell = floor(g), local = fract(g) - 0.5;
      float h = hash(cell + 5.0);
      float r = length(local - (vec2(hash(cell + 1.3), hash(cell + 2.6)) - 0.5) * 0.7);
      col += moteC * step(0.90, h) * exp(-r * r * 130.0)
           * (0.35 + 0.65 * (0.5 + 0.5 * sin(t * 0.35 + h * 40.0))) * 0.12;
    }
  }

  // ── Beacons — monoliths of the strip, lit from within ────────────────────
  for (int i = 0; i < ${NB}; i++) {
    vec4 b = uBeacons[i];
    float bx = b.x * aspect;
    float baseY = b.y, h = b.z, glow = b.w;
    float w = h * 0.24;
    float topY = baseY + h;
    // Cheap reject — beacon body + column live in a narrow x band.
    if (abs(sc.x - bx) > w * 2.0 + 0.03) continue;

    // Light column — a thin transmission rising from the tip to the stars.
    float cw = 0.0045 + h * 0.02;
    float lat = exp(-pow((sc.x - bx) / (cw * (1.0 + max(0.0, y - topY) * 0.8)), 2.0));
    float vfade = smoothstep(topY - 0.01, topY + 0.02, y) * exp(-(y - topY) * 2.1);
    float flick = 0.8 + 0.2 * n1(t * 0.20 + float(i) * 9.0, 3.0 + float(i));
    col += glowC * lat * vfade * uBeaconLight * glow * flick * 0.50;

    // Stone body — still, silent, rounded slab; light pools at its heart.
    vec2 lp = vec2(sc.x - bx, y - (baseY + h * 0.5));
    float sd = sdRBox(lp, vec2(w * 0.5, h * 0.5), w * 0.42);
    if (sd < 0.0) {
      float vt = clamp((lp.y / h) + 0.5, 0.0, 1.0);                      // 0 base → 1 tip
      vec3 stone = mix(land * 1.5, skyT * 1.8, vt * 0.4);
      float heart = exp(-pow((vt - 0.78) / 0.26, 2.0));
      stone += glowC * heart * uBeaconLight * glow * 0.55;
      // Carved inscription shimmer — a fine central band of characters
      // catching the light, soft-edged so it reads as relief, not pixels.
      vec2 gp = vec2(lp.x / w * 6.0, vt * 22.0);
      vec2 gf = fract(gp) - 0.5;
      float gh = hash(floor(gp) + float(i) * 31.0 + floor(t * 0.22) * 0.37);
      float cellSoft = exp(-dot(gf, gf) * 9.0);
      stone += glowC * step(0.78, gh) * cellSoft * heart * 0.07 * uBeaconLight
             * step(abs(lp.x), w * 0.30);
      col = mix(col, stone, smoothstep(0.0015, -0.0015, sd));
    }
    // Rim light + ground pool.
    col += glowC * exp(-abs(sd) * 420.0) * uBeaconLight * glow * 0.14;
    if (y < baseY + 0.012) {
      float pd = (sc.x - bx) * (sc.x - bx) + (y - baseY) * (y - baseY) * 7.0;
      col += glowC * exp(-pd / (0.0022 + h * 0.004)) * uBeaconLight * glow * 0.10;
    }
  }

  // Vignette, tone, and grain — the grain kills banding in slow gradients.
  vec2 vc = (vUv - 0.5) * vec2(aspect, 1.0);
  col *= smoothstep(1.65, 0.55, length(vc));
  col = pow(col, vec3(0.92));
  col += (hash(vUv * res + fract(t) * 61.7) - 0.5) * 0.008;
  outColor = vec4(col, 1.0);
}
`;

// Beacon composition — x, depth (0 far → 1 near), height scale, breath phase.
// A loose procession along the strip; the center marker leads.
const BEACON_LAYOUT = [
  { x: 0.105, d: 0.55, hs: 0.95, ph: 0.0 },
  { x: 0.240, d: 0.20, hs: 0.80, ph: 1.7 },
  { x: 0.360, d: 0.75, hs: 1.05, ph: 3.1 },
  { x: 0.500, d: 0.40, hs: 1.25, ph: 4.4 },
  { x: 0.645, d: 0.90, hs: 0.90, ph: 0.9 },
  { x: 0.775, d: 0.30, hs: 1.10, ph: 2.5 },
  { x: 0.910, d: 0.62, hs: 0.85, ph: 5.3 },
];
// People claim beacons center-out so a duo lights the two flanking the center.
const BEACON_ASSIGN = [2, 4, 3, 1, 5, 0, 6];

// Sky nodes for the survey diagram — slow-drifting anchors above the strip.
const SKY_NODES = [
  { x: 0.10, y: 0.86, ph: 0.4 }, { x: 0.26, y: 0.71, ph: 2.1 },
  { x: 0.38, y: 0.90, ph: 4.0 }, { x: 0.52, y: 0.76, ph: 1.1 },
  { x: 0.68, y: 0.88, ph: 3.3 }, { x: 0.80, y: 0.68, ph: 5.2 },
  { x: 0.93, y: 0.82, ph: 0.8 }, { x: 0.60, y: 0.60, ph: 2.8 },
];
// Edges: each beacon tip → a sky node, then a chain across the nodes.
const SEG_EDGES = [
  [0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6],   // beacon i → node j
];
const NODE_LINKS = [ [1, 3], [3, 7] ];

const PALETTES = ['liminal', 'wayside', 'pasaquan', 'borderwater', 'concrete'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'no_mans_land',
  name: 'No Man’s Land',
  contextType: 'webgl2',
  // Full-screen fbm sky + ridge layers + SDF loops: medium fragment load —
  // render crisp up to 1.25× so a 2-hour projection set holds frame rate.
  maxDpr: 1.25,

  params: [
    { id: 'palette',     label: 'palette',      type: 'select', options: PALETTES, default: 'liminal' },
    { id: 'drift',       label: 'drift',        type: 'range', min: 0, max: 2,   step: 0.05, default: 0.5 },
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
    { id: 'signals',     label: 'signals',      type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.6,
      modulators: [
        { source: 'audio.highs', mode: 'mul', amount: 0.50 },
      ] },
    { id: 'reactivity',     label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'poseReactivity', label: 'pose react', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks the set's chapters — dusk into threshold, river, wayside
  // lanterns, full bloom, then the silver monument dusk. Mirrors the presets.
  autoPhase: {
    steps: [
      { palette: 'liminal',     aurora: 0.45, beaconLight: 0.70, river: 0.50, signals: 0.30 },
      { palette: 'liminal',     aurora: 0.90, beaconLight: 0.90, river: 0.80, signals: 0.55 },
      { palette: 'borderwater', aurora: 0.70, beaconLight: 0.80, river: 1.20, signals: 0.45 },
      { palette: 'wayside',     aurora: 0.55, beaconLight: 1.25, river: 0.70, signals: 0.50 },
      { palette: 'pasaquan',    aurora: 1.10, beaconLight: 1.00, river: 0.90, signals: 0.80 },
      { palette: 'concrete',    aurora: 0.40, beaconLight: 0.95, river: 0.45, signals: 0.95 },
    ],
  },

  presets: {
    default:   { palette: 'liminal',     drift: 0.5,  aurora: 0.8,  beaconLight: 0.9,  river: 0.8,  signals: 0.6,  reactivity: 1.0, poseReactivity: 1.0 },
    dusk:      { palette: 'liminal',     drift: 0.35, aurora: 0.45, beaconLight: 0.7,  river: 0.5,  signals: 0.3 },
    riverline: { palette: 'borderwater', aurora: 0.7,  beaconLight: 0.8,  river: 1.2,  signals: 0.45 },
    wayside:   { palette: 'wayside',     aurora: 0.55, beaconLight: 1.25, river: 0.7,  signals: 0.5 },
    bloom:     { palette: 'pasaquan',    aurora: 1.1,  beaconLight: 1.0,  river: 0.9,  signals: 0.8 },
    monument:  { palette: 'concrete',    aurora: 0.4,  beaconLight: 0.95, river: 0.45, signals: 0.95 },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    let W = canvas.width, H = canvas.height;

    // Pre-allocated uniform payloads — the hot path allocates nothing.
    const beaconData = new Float32Array(NB * 4);
    const segData    = new Float32Array(MAX_SEG * 4);
    const waveData   = new Float32Array(2 * 4);
    const ringData   = new Float32Array(2 * 4);

    // Static beacon geometry (x, baseY, height); .w glow is written per frame.
    const beaconTopY = new Float32Array(NB);
    for (let i = 0; i < NB; i++) {
      const b = BEACON_LAYOUT[i];
      const baseY = HY - 0.03 - b.d * 0.24;
      const h = (0.055 + b.d * 0.10) * b.hs;
      beaconData[i * 4]     = b.x;
      beaconData[i * 4 + 1] = baseY;
      beaconData[i * 4 + 2] = h;
      beaconData[i * 4 + 3] = 0.3;
      beaconTopY[i] = baseY + h;
    }
    let segN = 0;

    // Per-beacon person slots — presence/gesture/lean, all heavily smoothed so
    // tracking dropouts fade instead of snapping.
    const slotPresence = new Float32Array(NB);
    const slotGesture  = new Float32Array(NB);
    const slotLean     = new Float32Array(NB);
    const slotTargetP  = new Float32Array(NB);
    const slotTargetG  = new Float32Array(NB);
    const slotTargetL  = new Float32Array(NB);

    // Slow emission envelopes (river waves + moon rings), beat-fed with
    // autonomous fallbacks so the land breathes even in silence.
    const waves = [ { progress: 1, amp: 0 }, { progress: 1, amp: 0 } ];
    const rings = [ { progress: 1, amp: 0 }, { progress: 1, amp: 0 } ];
    let lastBeatPulse = 0, lastWaveAt = -20, lastRingAt = -20, emitFlip = false;

    let hueShift = 0;      // radians, glides toward the played note's hue
    let moonX = 0.62, moonY = HY + 0.19;

    const scratch = {
      time: 0, drift: 0.5, aurora: 0.8, beaconLight: 0.9,
      river: 0.8, signals: 0.6, palette: 0,
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

      scratch.time        = time;
      scratch.drift       = params.drift;
      scratch.aurora      = params.aurora;
      scratch.beaconLight = params.beaconLight;
      scratch.river       = params.river;
      scratch.signals     = params.signals;
      scratch.palette     = Math.max(0, PALETTES.indexOf(params.palette));

      // ── Pose → per-beacon breath. Every input is a ratio against the
      // performer's own frame (span/torso) — relative, never absolute.
      slotTargetP.fill(0);
      const people = pose.people;
      const nP = Math.min(people.length, NB);
      for (let i = 0; i < nP; i++) {
        const slot = BEACON_ASSIGN[i];
        const p = people[i];
        const sL = p.shoulders?.l, sR = p.shoulders?.r;
        if (!sL || !sR || sL.visibility < 0.35 || sR.visibility < 0.35) continue;
        const span = Math.hypot(sR.x - sL.x, sR.y - sL.y);
        if (span < 0.05) continue;
        slotTargetP[slot] = 1;
        slotTargetL[slot] = Math.max(-1, Math.min(1, ((sR.y - sL.y) / span) * 1.8));
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
          slotTargetG[slot] = clamp01(open * 0.6 + lift * 0.4);
        } else {
          slotTargetG[slot] = 0.15;   // present but hands out of view — soft ember
        }
      }
      const kP = Math.min(1, dt * 0.7);   // ~1.4s presence fade — museum slow
      const kG = Math.min(1, dt * 2.0);
      const poseGain = params.poseReactivity ?? 1;
      for (let i = 0; i < NB; i++) {
        slotPresence[i] += (slotTargetP[i] - slotPresence[i]) * kP;
        slotGesture[i]  += (slotTargetG[i] - slotGesture[i]) * kG;
        slotLean[i]     += (slotTargetL[i] - slotLean[i]) * kG;
        const breath = 0.30 + 0.12 * Math.sin(time * 0.21 + BEACON_LAYOUT[i].ph);
        const person = slotPresence[i] * (0.20 + 0.80 * slotGesture[i]) * 0.9 * poseGain;
        beaconData[i * 4 + 3] = Math.min(1.6, breath + person);
      }

      // ── Beat → slow emissions. Rising-edge with long cooldowns; a quiet
      // room still gets an autonomous wave/ring so the scene never stills.
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

      // ── Pitch → hue glide. The note being played tints the veil; when the
      // rig is silent, an incommensurate LFO wanders instead.
      const conf = channels?.['audio.pitchConf'] ?? 0;
      const pc   = channels?.['audio.pitchClass'] ?? 0;
      const hueTarget = conf > 0.35 ? (pc - 0.5) * 1.1 : Math.sin(time * 0.017) * 0.25;
      hueShift += (hueTarget - hueShift) * Math.min(1, dt * 0.25);

      // Void moon drifts across the threshold over the course of a set.
      moonX = 0.62 + 0.06 * Math.sin(time * 0.008);
      moonY = HY + 0.19 + 0.018 * Math.sin(time * 0.011);

      // Survey diagram — beacon tips to slow-drifting sky nodes.
      let s = 0;
      for (let e = 0; e < SEG_EDGES.length; e++) {
        const [bi, ni] = SEG_EDGES[e];
        const n = SKY_NODES[ni];
        segData[s * 4]     = BEACON_LAYOUT[bi].x;
        segData[s * 4 + 1] = beaconTopY[bi];
        segData[s * 4 + 2] = n.x + 0.012 * Math.sin(time * 0.013 + n.ph);
        segData[s * 4 + 3] = n.y + 0.010 * Math.sin(time * 0.017 + n.ph * 1.7);
        s++;
      }
      for (let e = 0; e < NODE_LINKS.length; e++) {
        const [a, b] = NODE_LINKS[e];
        const na = SKY_NODES[a], nb = SKY_NODES[b];
        segData[s * 4]     = na.x + 0.012 * Math.sin(time * 0.013 + na.ph);
        segData[s * 4 + 1] = na.y + 0.010 * Math.sin(time * 0.017 + na.ph * 1.7);
        segData[s * 4 + 2] = nb.x + 0.012 * Math.sin(time * 0.013 + nb.ph);
        segData[s * 4 + 3] = nb.y + 0.010 * Math.sin(time * 0.017 + nb.ph * 1.7);
        s++;
      }
      segN = s;
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0.02, 0.02, 0.051, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform1f(U('uTime'),        scratch.time);
      gl.uniform1f(U('uDrift'),       scratch.drift);
      gl.uniform1f(U('uAurora'),      scratch.aurora);
      gl.uniform1f(U('uBeaconLight'), scratch.beaconLight);
      gl.uniform1f(U('uRiver'),       scratch.river);
      gl.uniform1f(U('uSignals'),     scratch.signals);
      gl.uniform1i(U('uPalette'),     scratch.palette);
      gl.uniform1f(U('uHueShift'),    hueShift);
      gl.uniform2f(U('uMoon'),        moonX, moonY);
      gl.uniform1i(U('uSegN'),        segN);
      gl.uniform4fv(U('uBeacons[0]'), beaconData);
      gl.uniform4fv(U('uSegs[0]'),    segData);
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
