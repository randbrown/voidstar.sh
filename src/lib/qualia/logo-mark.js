// Logo mark — a persistent, top-level `void*` watermark layer: a miniature,
// optimized live rendition of the voidstar-logo quale (breathing void
// aperture, swirling energy sheath, three Bohr orbits with plasma-trailed
// electrons, snare rays, beat shockwave, sparks, the spinning `*`) rendered
// into its own SMALL WebGL2 canvas that floats above the whole scene stack —
// fx, glitch post, pose overlays — the way a broadcast bug/watermark sits
// above all processing. Optional polar frequency-spectrum ring around the
// mark, coloured bass→highs (violet→cyan).
//
// NOT an fx module: it's a page-level layer like the cam walk, independent
// of whichever quale is active, driven from core.onFrame. Disabled by
// default; the GL context, textures and shader are only built on first
// enable, so a session that never turns it on pays nothing.
//
// Performance: shader cost is per-pixel and the canvas is tiny — a 220px
// corner mark at 1.5× DPR is ~110k pixels vs ~3.1M for the fullscreen quale
// (~1/30th of the work), and this variant additionally drops the cosmic
// starfield/dust background and the pose parallax path. Backing buffer is
// hard-capped at 1024px/side so a huge centered mark can't blow the budget.
// The hot path allocates nothing.
//
// Compositing: renders on black and sits under CSS `mix-blend-mode: screen`
// (the same trick the fx canvas uses over Hydra), so dark pixels vanish and
// the mark reads as pure emitted light over any scene. The recorder mirrors
// this with a 'screen' composite draw so recordings match the live view.
//
// Placement: any corner, exact drag position (pointer drag → 'custom'), or
// 'center' — a large centered mode that can ride the cam walk with the rest
// of the scene. Because the walk's translate % is relative to each element's
// own size, the (smaller) mark pans less than the full-viewport layers — a
// deliberate foreground-parallax read rather than a bug.

import {
  compileProgram, makeFullscreenTri, FULLSCREEN_VERT,
  makeUniformGetter, uploadAudioUniforms, bakeTextTex,
} from './webgl.js';
import { scaleAudio } from './field.js';

/** Baseline tunables — the logo card's defaults. */
export const LOGO_MARK_DEFAULTS = {
  position: 'br',      // 'tl' | 'tr' | 'bl' | 'br' | 'center' | 'custom'
  x: 0.5,              // custom-drag centre, fraction of the stage rect
  y: 0.5,
  size: 220,           // CSS px (square) in corner/custom mode
  centerSize: 520,     // CSS px in 'center' mode (large walkable emblem)
  opacity: 0.85,       // brightness under the screen blend = perceived opacity
  glow: 0.5,           // [0,1] aura + halo gain (the "subtle pulse glow")
  reactivity: 1.0,     // [0,2] scales every audio response
  spectrum: 0,         // [0,1] polar frequency-ring amount (0 = off, skips work)
  flow: 1.0,           // [0,3] motion-speed multiplier (swirl / orbits / spin)
  palette: 'platinum', // silver | voidblue | platinum | inferno
  walk: true,          // 'center' mode rides the cam walk (corners stay pinned)
};

const PALETTES   = ['silver', 'voidblue', 'platinum', 'inferno'];
const POSITIONS  = ['tl', 'tr', 'bl', 'br', 'center', 'custom'];
const MARGIN     = 14;    // CSS px corner inset
const DPR_CAP    = 1.5;   // matches the core's global cap
const BACKING_CAP = 1024; // max backing-buffer px per side
const NUM_RINGS  = 3;
const NUM_RAYS   = 6;
const SPEC_BINS  = 96;    // spectrum-ring texture width
const DRAG_SLOP  = 5;     // px before a pointerdown becomes a drag

// The mark variant of the voidstar-logo shader. Differences from the quale:
// no cosmic background (black base for the screen blend), no pose parallax,
// fixed always-on logo glyph, an added rms/beat aura (uGlow), an optional
// spectrum ring fed by a 1D texture, an outer radial feather so the canvas
// edge never shows, and a final uOpacity gain.
const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform float uVoidRadius;
uniform float uEnergyThickness;
uniform float uSwirlIntensity;
uniform float uFlowSpeed;
uniform float uOrbitAmount;
uniform int   uPalette;
uniform float uGlowAmt;
uniform float uOpacity;
uniform float uSpectrumAmt;

uniform sampler2D uLogoTex;
uniform sampler2D uStarTex;
uniform sampler2D uSpecTex;
uniform float     uStarRotC;
uniform float     uStarRotS;
uniform float     uStarCenterX;
uniform vec2      uStarHalfP;

uniform vec3  uRingU[3];
uniform vec3  uRingV[3];
uniform float uRingRMult[3];
uniform float uRingT[3];
uniform float uRayAngles[6];

uniform vec4  uBands;
uniform vec2  uBeat;
uniform vec2  uMids;
uniform vec2  uHighs;
uniform float uRms;

const float PI = 3.14159265359;

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
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p  *= 2.0;
    a  *= 0.5;
  }
  return v;
}

struct Pal {
  vec3 voidEdge, sheath, orbit, electron, logo, halo, plasma;
};
Pal getPalette(int idx) {
  Pal p;
  if (idx == 0) {            // silver
    p.voidEdge = vec3(0.96, 0.98, 1.00);
    p.sheath   = vec3(0.78, 0.84, 0.92);
    p.orbit    = vec3(0.85, 0.90, 1.00);
    p.electron = vec3(1.00, 0.98, 0.92);
    p.logo     = vec3(0.92, 0.94, 0.98);
    p.halo     = vec3(0.55, 0.62, 0.78);
    p.plasma   = vec3(0.78, 0.88, 1.00);
  } else if (idx == 1) {     // voidblue
    p.voidEdge = vec3(0.55, 0.94, 1.00);
    p.sheath   = vec3(0.20, 0.55, 0.95);
    p.orbit    = vec3(0.55, 0.85, 1.00);
    p.electron = vec3(0.85, 0.98, 1.00);
    p.logo     = vec3(0.85, 0.92, 1.00);
    p.halo     = vec3(0.10, 0.30, 0.65);
    p.plasma   = vec3(0.30, 0.75, 1.00);
  } else if (idx == 2) {     // platinum
    p.voidEdge = vec3(0.97, 0.95, 1.00);
    p.sheath   = vec3(0.80, 0.82, 0.88);
    p.orbit    = vec3(0.86, 0.88, 0.96);
    p.electron = vec3(0.98, 0.96, 1.00);
    p.logo     = vec3(0.93, 0.94, 0.98);
    p.halo     = vec3(0.50, 0.55, 0.74);
    p.plasma   = vec3(0.80, 0.82, 0.95);
  } else {                   // inferno
    p.voidEdge = vec3(1.00, 0.55, 0.20);
    p.sheath   = vec3(0.95, 0.40, 0.10);
    p.orbit    = vec3(1.00, 0.78, 0.40);
    p.electron = vec3(1.00, 0.92, 0.55);
    p.logo     = vec3(1.00, 0.78, 0.45);
    p.halo     = vec3(0.55, 0.10, 0.04);
    p.plasma   = vec3(1.00, 0.50, 0.15);
  }
  return p;
}

float ringDist(vec2 q, vec2 ux, vec2 vx, float R) {
  float det = ux.x * vx.y - ux.y * vx.x;
  if (abs(det) < 0.04) return 1e6;
  vec2 mInv = vec2(vx.y * q.x - vx.x * q.y, -ux.y * q.x + ux.x * q.y) / det;
  return abs(length(mInv) - R) * sqrt(abs(det));
}

float voidSample(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture(uLogoTex, uv).r;
}
float starSampleAtP(vec2 pp) {
  vec2 rel = pp - vec2(uStarCenterX, 0.0);
  float maxR = max(uStarHalfP.x, uStarHalfP.y) * 1.45;
  if (dot(rel, rel) > maxR * maxR) return 0.0;
  vec2 rot = vec2(uStarRotC * rel.x - uStarRotS * rel.y,
                  uStarRotS * rel.x + uStarRotC * rel.y);
  vec2 uv  = rot / uStarHalfP * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture(uStarTex, uv).r;
}
float comboSample(vec2 uv, vec2 pp) {
  return max(voidSample(uv), starSampleAtP(pp));
}

// bass→highs ramp for the spectrum ring: deep violet through voidstar cyan,
// whitening at the tip with amplitude. Deliberately palette-independent —
// the ring reads as an instrument readout wrapped around the mark.
vec3 spectrumColor(float f, float amp) {
  vec3 c = mix(vec3(0.45, 0.18, 0.95), vec3(0.20, 0.85, 1.00), f);
  return mix(c, vec3(1.0), amp * amp * 0.45);
}

void main() {
  vec2  res    = uResolution;
  float aspect = res.x / max(res.y, 1.0);

  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= aspect;

  Pal pal = getPalette(uPalette);
  vec3 col = vec3(0.0);

  float r     = length(p);
  float angle = atan(p.y, p.x);

  // ── Void aperture — subtle response to strong bass only.
  float strongBass = clamp((uBands.x - 0.55) * 2.5, 0.0, 1.0);
  float vR = uVoidRadius * (1.0 + strongBass * 0.05);
  vR = clamp(vR, 0.05, 0.65);

  // ── Ambient aura — THE watermark pulse-glow. A wide soft halo around the
  // whole mark, breathing with rms and flicking with the kick, scaled by
  // uGlowAmt. Kept faint so it reads as emitted light, not a spotlight.
  float aura = exp(-pow((r - vR * 1.1) / max(vR * 2.2, 0.05), 2.0))
             * (0.05 + uRms * 0.22 + uBeat.y * 0.08) * uGlowAmt;
  col += mix(pal.halo, pal.voidEdge, 0.4) * aura;

  // ── Energy sheath — mids + highs drive thickness and brightness.
  float sheathInner = vR;
  float sheathOuter = vR + uEnergyThickness * (1.0 + uBands.y * 0.18 + uBands.z * 0.12);
  float sheathBand  = smoothstep(sheathInner - 0.025, sheathInner + 0.060, r) *
                      (1.0 - smoothstep(sheathOuter * 0.82, sheathOuter + 0.14, r));
  vec2 dir = (r > 1e-4) ? p / r : vec2(1.0, 0.0);
  float spinT = uTime * uFlowSpeed * 0.32;
  float cT = cos(spinT), sT = sin(spinT);
  vec2 dirRot = vec2(dir.x * cT - dir.y * sT, dir.x * sT + dir.y * cT);
  vec2 swirlSeed = vec2(
    dirRot.x * 2.2,
    dirRot.y * 2.2 + (r - vR) * 11.0 - uTime * uFlowSpeed * 0.55
  );
  float swirl    = fbm(swirlSeed);
  float fineSw   = fbm(swirlSeed * 3.0 + 11.0);
  float energy   = sheathBand * (0.35 + 0.85 * swirl + 0.40 * fineSw) * uSwirlIntensity;
  float doppler  = 0.55 + 0.5 * sin(angle * 2.0 + uTime * uFlowSpeed * 0.55);
  energy *= 0.55 + 0.65 * doppler;
  energy *= (1.0 + uBands.y * 0.50 + uBands.z * 0.30);
  float sheathMix = smoothstep(sheathOuter, sheathInner, r);
  vec3  energyCol = mix(pal.sheath, pal.voidEdge, sheathMix);
  col += energyCol * energy * 1.35;

  // Inner-rim lit lip — mids + highs only (no kick).
  float rimG = exp(-pow((r - vR) / max(vR * 0.20, 0.01), 2.0))
             * (0.55 + uBands.y * 0.35 + uBands.z * 0.25);
  col += pal.voidEdge * rimG * 0.32;

  // ── Plasma plumes — slow bass envelope.
  float plasma = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi      = float(i);
    float baseAng = fi * 1.0472 + uTime * 0.07 + hash(vec2(fi, 3.1)) * 6.28;
    float dAng    = mod(angle - baseAng + PI, 2.0 * PI) - PI;
    float angWidth = 35.0 + 12.0 * sin(uTime * 0.4 + fi);
    float angleMask = exp(-dAng * dAng * angWidth);
    float radial   = max(0.0, r - vR);
    float falloff  = exp(-radial * 2.6) * smoothstep(vR, vR + 0.04, r);
    float pulse    = 0.4 + 0.6 * sin(uTime * 1.4 + fi * 1.7);
    float power    = uBands.x * 0.45 * pulse + uBeat.y * 0.35;
    plasma += angleMask * falloff * power;
  }
  col += pal.plasma * plasma * 1.25;

  // ── Snare rays — reshuffled JS-side on every snare onset.
  float streaks = 0.0;
  for (int i = 0; i < 6; i++) {
    float baseAng = uRayAngles[i];
    float dAng    = mod(angle - baseAng + PI, 2.0 * PI) - PI;
    float angleMask = exp(-dAng * dAng * 800.0);
    float radial   = r - vR;
    float radialMask = smoothstep(vR - 0.010, vR + 0.050, r) * exp(-max(0.0, radial) * 1.4);
    float intensity = uMids.y * 1.65 + uHighs.y * 0.40;
    streaks += angleMask * radialMask * intensity;
  }
  col += pal.voidEdge * streaks * 1.85;

  // ── Beat shockwave — expands outward from the void edge as it decays.
  float swDecay = 1.0 - uBeat.y;
  float swR     = vR * (1.10 + 4.9 * pow(swDecay, 0.55));
  float swW     = vR * 0.28;
  float shock   = exp(-pow((r - swR) / swW, 2.0)) * uBeat.y;
  col += pal.voidEdge * shock * 1.05;

  // ── Bohr rings + electrons + plasma trails.
  vec3  colFront  = vec3(0.0);
  float orbitGain = uOrbitAmount;
  for (int i = 0; i < 3; i++) {
    vec3  u  = uRingU[i];
    vec3  v  = uRingV[i];
    float Rm = uRingRMult[i] * uVoidRadius;
    float tE = uRingT[i];

    vec2  q        = p / max(Rm, 1e-3);
    float tNearest = atan(dot(q, v.xy), dot(q, u.xy));
    float ctP = cos(tNearest), stP = sin(tNearest);
    float zPix = (u.z * ctP + v.z * stP) * Rm;
    float frontW = smoothstep(-0.04 * Rm, 0.04 * Rm, zPix);

    float d = ringDist(p, u.xy, v.xy, Rm);
    float thick = uVoidRadius * 0.014 + 0.001;
    float outlineSoft = exp(-pow(d / (thick * 2.4), 2.0)) * 0.18;
    float outlineHard = exp(-pow(d / thick, 2.0)) * 0.32;
    vec3  outlineCol  = pal.orbit * (outlineSoft + outlineHard);

    float ct = cos(tE), st = sin(tE);
    vec3  e3  = (u * ct + v * st) * Rm;
    vec3  ev3 = (-u * st + v * ct);
    vec2  eP   = e3.xy;
    float eZ   = e3.z;
    vec2  eVel = ev3.xy;
    float velLen = max(length(eVel), 1e-3);
    vec2  velN = eVel / velLen;
    vec2  velPerp = vec2(-velN.y, velN.x);

    float depthN   = 0.5 + 0.5 * (eZ / max(Rm, 1e-3));
    float depthBri = mix(0.45, 1.7, smoothstep(0.0, 1.0, depthN));

    float dE     = length(p - eP);
    float coreR  = uVoidRadius * (0.045 + uHighs.y * 0.030);
    float core   = exp(-pow(dE / coreR, 2.0));
    float haloR  = uVoidRadius * 0.18;
    float haloEl = exp(-pow(dE / haloR, 2.0)) * 0.45;
    float scintil = uHighs.y * exp(-pow(dE / (coreR * 1.4), 2.0));

    vec2  toE   = p - eP;
    float along = -dot(toE, velN);
    float perp  = dot(toE, velPerp);
    float trailLen   = uVoidRadius * (0.55 + uBands.x * 0.40 + uBeat.y * 0.25);
    float trailWidth = uVoidRadius * (0.020 + uBands.y * 0.020);
    float trailLong  = smoothstep(trailLen, 0.0, along) * step(0.0, along);
    float trailSide  = exp(-pow(perp / trailWidth, 2.0));
    float trail      = trailLong * trailSide * 0.85;

    vec3 electronCol = pal.electron * (core * 2.4 + haloEl + scintil * 1.3) * depthBri;
    vec3 trailCol    = pal.plasma   * trail * (0.7 + 0.6 * depthBri);

    vec3 outlineAndTrail = (outlineCol + trailCol) * orbitGain;
    col      += outlineAndTrail * (1.0 - frontW);
    colFront += outlineAndTrail * frontW;

    float frontE = smoothstep(-0.04 * Rm, 0.04 * Rm, eZ);
    vec3  electronContrib = electronCol * orbitGain;
    col      += electronContrib * (1.0 - frontE);
    colFront += electronContrib * frontE;
  }

  // ── Sparks — highs-driven scintilla near the mark.
  float sparks = 0.0;
  for (float i = 0.0; i < 2.0; i++) {
    float scale = 28.0 + i * 18.0;
    vec2  g     = p * scale;
    vec2  cell  = floor(g);
    vec2  local = fract(g) - 0.5;
    float h     = hash(cell + i * 23.0 + floor(uTime * 4.0) * 0.31);
    float live  = step(0.987, h);
    float zone  = smoothstep(vR * 4.5, vR * 1.05, r);
    float lr    = length(local);
    float core  = exp(-lr * lr * 220.0);
    sparks += core * live * zone;
  }
  col += pal.electron * sparks * (uHighs.y * 1.6 + uMids.y * 0.40 + uBands.z * 0.40 + 0.20);

  // ── Spectrum ring — polar frequency readout just outside the sheath.
  // Mirrored left/right (bass at the bottom, highs at the top), dashed into
  // fine ticks, amplitude pushes each tick outward and brightens it. The
  // uniform gate means the texture fetch + ring math cost nothing when off.
  if (uSpectrumAmt > 0.001) {
    float a01 = fract((angle + PI * 0.5) / (2.0 * PI)); // 0 at the bottom
    float f   = 1.0 - abs(a01 * 2.0 - 1.0);             // mirrored: 0=bass 1=highs
    float amp = texture(uSpecTex, vec2(f, 0.5)).r;
    float sr    = vR + uEnergyThickness + 0.10;
    float outer = sr + 0.015 + amp * 0.17;
    float band  = smoothstep(sr - 0.010, sr + 0.008, r)
                * (1.0 - smoothstep(outer - 0.020, outer + 0.020, r));
    float tick  = smoothstep(0.20, 0.50, abs(fract(a01 * 72.0) - 0.5));
    col += spectrumColor(f, amp) * band * tick * amp
         * uSpectrumAmt * (0.85 + uBands.w * 0.6);
  }

  // ── Cut to black inside the aperture.
  float voidMask = 1.0 - smoothstep(vR * 0.65, vR * 1.04, r);
  col *= mix(1.0, 0.0, voidMask);

  // ── In-scene void* logo on the curved front face — gated to the sphere
  // so the expensive combo sampling is skipped for most pixels.
  float sphereR  = max(uVoidRadius * 2.10, 0.30);
  float onSphere = step(dot(p, p), sphereR * sphereR);
  if (onSphere > 0.5) {
    float zSph    = sqrt(max(sphereR * sphereR - dot(p, p), 1e-4));
    vec2  ang     = vec2(atan(p.x, zSph), atan(p.y, zSph));
    vec2  logoHalfP   = vec2(min(0.55, sphereR * 0.94), min(0.16, sphereR * 0.30));
    vec2  logoHalfAng = vec2(asin(logoHalfP.x / sphereR), asin(logoHalfP.y / sphereR));
    vec2  logoUV      = ang / logoHalfAng * 0.5 + 0.5;

    float maskC = comboSample(logoUV, p);

    vec2  outwardP   = (r > 1e-3) ? p / r : vec2(0.0, 1.0);
    vec2  uvPerP     = vec2(1.0 / max(zSph, 1e-3) / max(logoHalfAng.x, 1e-3),
                            1.0 / max(zSph, 1e-3) / max(logoHalfAng.y, 1e-3)) * 0.5;

    float eps   = 0.0024;
    vec2  epsP  = vec2(eps / max(uvPerP.x, 1e-3), eps / max(uvPerP.y, 1e-3));
    epsP = min(epsP, vec2(0.012));
    float mL = comboSample(logoUV + vec2(-eps, 0.0), p + vec2(-epsP.x, 0.0));
    float mR = comboSample(logoUV + vec2( eps, 0.0), p + vec2( epsP.x, 0.0));
    float mU = comboSample(logoUV + vec2(0.0, -eps), p + vec2(0.0, -epsP.y));
    float mD = comboSample(logoUV + vec2(0.0,  eps), p + vec2(0.0,  epsP.y));
    vec2  grad    = vec2(mR - mL, mD - mU);
    float gradLen = length(grad);
    vec2  norm    = gradLen > 1e-4 ? grad / gradLen : vec2(0.0);

    vec2  toCenter = -outwardP;
    float diffuse = clamp(dot(norm, toCenter), 0.0, 1.0);
    float ambient = 0.50 + uBands.y * 0.18 + uMids.y * 0.22;
    float voidGlow = clamp(1.0 - r / max(vR * 3.5, 1e-3), 0.0, 1.0);
    vec3  bodyCol = mix(pal.logo, pal.voidEdge, voidGlow * 0.55);
    vec3  bodyLit = bodyCol * (ambient + 0.40 * diffuse + voidGlow * 0.30);

    float edge = clamp(gradLen * 8.0, 0.0, 1.0);

    // Cross-pattern halo — 8 samples, gain rides the glow knob.
    float halo = 0.0;
    for (int i = 1; i <= 2; i++) {
      float t = float(i) * 3.2;
      vec2 oh  = vec2( eps, 0.0) * t * 3.0;
      vec2 ov  = vec2(0.0,  eps) * t * 3.0;
      vec2 ohP = vec2( epsP.x, 0.0) * t * 3.0;
      vec2 ovP = vec2(0.0,  epsP.y) * t * 3.0;
      halo += comboSample(logoUV + oh, p + ohP) + comboSample(logoUV - oh, p - ohP)
            + comboSample(logoUV + ov, p + ovP) + comboSample(logoUV - ov, p - ovP);
    }
    halo = clamp(halo / 8.0 - maskC, 0.0, 1.0);
    col += pal.halo * halo * (0.30 + uGlowAmt * 0.55 + uRms * 0.7 + uMids.y * 0.30);

    col = mix(col, bodyLit, maskC);
    col += pal.voidEdge * edge * (0.40 + uBands.y * 0.20 + uMids.y * 0.30);
  }

  col += colFront;

  // ── Outer feather + tone. The radial fade guarantees the square canvas
  // never shows a hard edge, whatever the sheath/rays/shockwave are doing.
  col *= 1.0 - smoothstep(0.86, 0.99, r);
  col = pow(col, vec3(0.92));
  col *= (0.70 + uGlowAmt * 0.60) * uOpacity;

  outColor = vec4(col, 1.0);
}
`;

function rotateXYZ(out, vx, vy, vz, ax, ay, az) {
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const cy = Math.cos(ay), sy = Math.sin(ay);
  const cz = Math.cos(az), sz = Math.sin(az);
  let x = vx;
  let y = vy * cx - vz * sx;
  let z = vy * sx + vz * cx;
  let x2 = x * cy + z * sy;
  let y2 = y;
  let z2 = -x * sy + z * cy;
  out[0] = x2 * cz - y2 * sz;
  out[1] = x2 * sz + y2 * cz;
  out[2] = z2;
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/**
 * @param {Object} opts
 * @param {() => {left:number, top:number, width:number, height:number}} opts.getStageRect
 *   The stage box the mark anchors within (full viewport, or the fx half in
 *   split mode) — same rect the overlay uses. Polled cheaply each frame so
 *   split/fullscreen changes re-anchor without extra plumbing.
 * @param {() => void} [opts.onConfigChange]
 *   Fired after a drag commits a new custom position (page persists settings).
 * @param {HTMLElement} [opts.parent]
 */
export function createLogoMark({ getStageRect, onConfigChange, parent = document.body } = {}) {
  const cfg = { ...LOGO_MARK_DEFAULTS };
  let enabled = false;

  // GL state — built lazily on first enable so an off mark costs nothing.
  let canvas = null, gl = null, prog = null, vao = null, U = null;
  let logoTex = null, starTex = null, specTex = null;
  let built = false, buildFailed = false;

  // Fixed look constants (the quale exposes these as params; the mark keeps
  // its schema small and bakes the canonical "default preset" look).
  const VOID_RADIUS = 0.24;
  const ENERGY_THICKNESS = 0.30;
  const SWIRL = 0.16;
  const FLOW_BASE = 0.23;
  const ORBIT = 1.01;

  // Animation state — mirrors the quale's update() with pose stripped.
  const ringBases = [
    { u0: [1, 0, 0], v0: [0, 1, 0], radiusMult: 1.85, electronSpeed: 1.00 },
    { u0: [0, 1, 0], v0: [0, 0, 1], radiusMult: 2.40, electronSpeed: 1.40 },
    { u0: [0, 0, 1], v0: [1, 0, 0], radiusMult: 3.10, electronSpeed: 0.65 },
  ];
  const ringPrecess = [
    [0.060, 0.045, 0.028],
    [0.038, 0.072, 0.051],
    [0.073, 0.029, 0.044],
  ];
  const ringPhaseOff  = [0.0, 1.7, 4.1];
  const ringElectronT = [0.0, 1.5, 3.2];
  const ringRMultDyn  = ringBases.map(b => b.radiusMult);
  const ringU     = new Float32Array(NUM_RINGS * 3);
  const ringV     = new Float32Array(NUM_RINGS * 3);
  const ringRMult = new Float32Array(NUM_RINGS);
  const ringT     = new Float32Array(NUM_RINGS);
  const tmpVec    = new Float32Array(3);
  const rayAngles = new Float32Array(NUM_RAYS);
  const rayDrift  = [0.05, 0.04, 0.07, 0.03, 0.06, 0.045];
  for (let i = 0; i < NUM_RAYS; i++) rayAngles[i] = (Math.random() * 2 - 1) * Math.PI;
  let prevMidsActive = false;
  let starRot = 0;

  // Spectrum-ring state: log-ish sampled bins, instant rise / smooth fall so
  // the ring is lively without jitter. specMap is rebuilt when the FFT size
  // changes (in practice: once).
  const specSmooth = new Float32Array(SPEC_BINS);
  const specBytes  = new Uint8Array(SPEC_BINS);
  let specMap = null, specMapLen = 0;

  // Layout cache — relayout only when something actually changed.
  let lastStage = { left: -1, top: -1, width: -1, height: -1 };
  let lastPosKey = '';
  let cssRect = { x: 0, y: 0, w: 0, h: 0 };   // CSS px, stage-relative
  let dragging = false;

  function build() {
    if (built || buildFailed) return built;
    canvas = document.createElement('canvas');
    canvas.id = 'qualia-logo-mark';
    // Above the scene stack + glitch post + pose overlays (z:3) and the
    // Strudel scope (z:5); below the camera preview (z:10) and all UI.
    // Screen blend = dark pixels vanish, the mark reads as emitted light.
    canvas.style.cssText =
      'position:fixed;z-index:7;mix-blend-mode:screen;pointer-events:auto;' +
      'cursor:grab;touch-action:none;display:none;';
    canvas.title = 'void* mark — drag to place';
    parent.appendChild(canvas);
    try {
      // preserveDrawingBuffer so the recorder composite can drawImage from
      // this canvas outside our render call.
      gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, preserveDrawingBuffer: true,
        powerPreference: 'low-power',
      });
      if (!gl) throw new Error('webgl2 unavailable');
      prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
      vao  = makeFullscreenTri(gl);
      U    = makeUniformGetter(gl, prog);
      logoTex = bakeTextTex(gl, 'void ', 1024, 256, 168);
      starTex = bakeTextTex(gl, '*',     256, 256, 240, true);
      specTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, specTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SPEC_BINS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } catch (e) {
      console.warn('[qualia] logo mark unavailable:', e);
      buildFailed = true;
      canvas.remove();
      canvas = null; gl = null;
      return false;
    }
    wireDrag();
    built = true;
    return true;
  }

  function markSize() {
    const stage = getStageRect?.() || { width: window.innerWidth, height: window.innerHeight };
    const s = cfg.position === 'center' ? cfg.centerSize : cfg.size;
    // Never larger than the stage's short side (minus margins).
    return Math.max(64, Math.min(s, Math.min(stage.width, stage.height) - MARGIN * 2));
  }

  /** Re-anchor the canvas within the stage rect; resize backing if needed. */
  function layout(force = false) {
    if (!canvas) return;
    const stage = getStageRect?.() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const posKey = `${cfg.position}|${cfg.x.toFixed(4)}|${cfg.y.toFixed(4)}|${cfg.size}|${cfg.centerSize}`;
    if (!force &&
        stage.left === lastStage.left && stage.top === lastStage.top &&
        stage.width === lastStage.width && stage.height === lastStage.height &&
        posKey === lastPosKey) return;
    lastStage = { left: stage.left, top: stage.top, width: stage.width, height: stage.height };
    lastPosKey = posKey;

    const s = markSize();
    let x, y;   // stage-relative CSS px of the top-left corner
    switch (cfg.position) {
      case 'tl':     x = MARGIN; y = MARGIN; break;
      case 'tr':     x = stage.width - s - MARGIN; y = MARGIN; break;
      case 'bl':     x = MARGIN; y = stage.height - s - MARGIN; break;
      case 'center': x = (stage.width - s) / 2; y = (stage.height - s) / 2; break;
      case 'custom':
        x = cfg.x * stage.width - s / 2;
        y = cfg.y * stage.height - s / 2;
        break;
      case 'br':
      default:       x = stage.width - s - MARGIN; y = stage.height - s - MARGIN; break;
    }
    x = Math.max(0, Math.min(stage.width  - s, x));
    y = Math.max(0, Math.min(stage.height - s, y));
    cssRect = { x, y, w: s, h: s };
    canvas.style.left   = `${stage.left + x}px`;
    canvas.style.top    = `${stage.top + y}px`;
    canvas.style.width  = `${s}px`;
    canvas.style.height = `${s}px`;

    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const bpx = Math.min(Math.round(s * dpr), BACKING_CAP);
    if (canvas.width !== bpx || canvas.height !== bpx) {
      canvas.width = bpx; canvas.height = bpx;
    }
  }

  // ── Drag-to-place ─────────────────────────────────────────────────────────
  // Any placement can be dragged; past the slop threshold the mark follows
  // the pointer and the position becomes 'custom' (persisted on release).
  function wireDrag() {
    let startX = 0, startY = 0, startCX = 0, startCY = 0, moved = false;
    canvas.addEventListener('pointerdown', (ev) => {
      if (!enabled) return;
      dragging = true; moved = false;
      startX = ev.clientX; startY = ev.clientY;
      startCX = cssRect.x + cssRect.w / 2;
      startCY = cssRect.y + cssRect.h / 2;
      canvas.setPointerCapture(ev.pointerId);
      canvas.style.cursor = 'grabbing';
      ev.preventDefault();
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && dx * dx + dy * dy < DRAG_SLOP * DRAG_SLOP) return;
      moved = true;
      const stage = getStageRect?.() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      cfg.position = 'custom';
      cfg.x = clamp01((startCX + dx) / Math.max(1, stage.width));
      cfg.y = clamp01((startCY + dy) / Math.max(1, stage.height));
      layout();
    });
    const end = (ev) => {
      if (!dragging) return;
      dragging = false;
      canvas.style.cursor = 'grab';
      try { canvas.releasePointerCapture(ev.pointerId); } catch {}
      if (moved) onConfigChange?.();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // ── Spectrum sampling ─────────────────────────────────────────────────────
  function rebuildSpecMap(fftLen) {
    specMap = new Uint16Array(SPEC_BINS + 1);
    // Slightly-log curve over the lower ~55% of the FFT — where the music
    // lives — so the ring spreads bass/mids/highs evenly around the arc.
    const top = Math.max(SPEC_BINS + 1, Math.floor(fftLen * 0.55));
    for (let i = 0; i <= SPEC_BINS; i++) {
      specMap[i] = Math.min(fftLen - 1, Math.round(Math.pow(i / SPEC_BINS, 1.55) * top));
    }
    specMapLen = fftLen;
  }
  function updateSpectrum(spectrum, dt) {
    const fall = Math.exp(-dt / 0.12);   // ~120ms release
    if (spectrum && spectrum.length) {
      if (specMapLen !== spectrum.length) rebuildSpecMap(spectrum.length);
      for (let i = 0; i < SPEC_BINS; i++) {
        let m = 0;
        for (let j = specMap[i]; j <= specMap[i + 1]; j++) {
          const v = spectrum[j];
          if (v > m) m = v;
        }
        const v = m / 255;
        specSmooth[i] = v > specSmooth[i] ? v : specSmooth[i] * fall;
        specBytes[i] = (specSmooth[i] * 255) | 0;
      }
    } else {
      // Audio off — decay to silence so a stale ring never lingers.
      for (let i = 0; i < SPEC_BINS; i++) {
        specSmooth[i] *= fall;
        specBytes[i] = (specSmooth[i] * 255) | 0;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, specTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPEC_BINS, 1, gl.RED, gl.UNSIGNED_BYTE, specBytes);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Advance + render one frame. Driven from core.onFrame; no-op when off. */
  function frame(field) {
    if (!enabled || !built) return;
    layout();   // cheap compare; catches split/fullscreen/resize changes
    if (canvas.width <= 0) return;

    const dt   = Math.min(field?.dt ?? 0.016, 0.05);
    const time = field?.time ?? 0;
    const audio = scaleAudio(field.audio, cfg.reactivity);
    const flowSpeed = FLOW_BASE * Math.max(0, cfg.flow);

    // Ring rotations + electron advance — beat boosts electron speed.
    const beatBoost = 1.0 + audio.beat.pulse * 4.0 + audio.bands.bass * 0.6;
    const audioPull = (audio.bands.bass - 0.40) * 0.05 + audio.beat.pulse * 0.025;
    for (let i = 0; i < NUM_RINGS; i++) {
      const base = ringBases[i];
      const pre  = ringPrecess[i];
      const off  = ringPhaseOff[i];
      const ax = pre[0] * time + off;
      const ay = pre[1] * time + off * 0.7;
      const az = pre[2] * time + off * 0.3;
      rotateXYZ(tmpVec, base.u0[0], base.u0[1], base.u0[2], ax, ay, az);
      ringU[i * 3]     = tmpVec[0];
      ringU[i * 3 + 1] = tmpVec[1];
      ringU[i * 3 + 2] = tmpVec[2];
      rotateXYZ(tmpVec, base.v0[0], base.v0[1], base.v0[2], ax, ay, az);
      ringV[i * 3]     = tmpVec[0];
      ringV[i * 3 + 1] = tmpVec[1];
      ringV[i * 3 + 2] = tmpVec[2];

      const slow = 0.025 * Math.sin(time * 0.10 + i * 1.7);
      const targetMult = base.radiusMult * (1.0 + audioPull + slow);
      const k = Math.min(1, dt * 1.6);
      ringRMultDyn[i] += (targetMult - ringRMultDyn[i]) * k;
      ringRMult[i] = ringRMultDyn[i];

      ringElectronT[i] += dt * base.electronSpeed * beatBoost * (0.6 + cfg.flow * 0.4);
      ringT[i] = ringElectronT[i];
    }

    // Slow * rotation, snare-reshuffled rays — same behavior as the quale.
    starRot += dt * (0.18 + audio.rms * 0.5) * Math.max(0.25, cfg.flow);
    if (starRot > Math.PI * 200) starRot -= Math.PI * 200;
    if (audio.mids.active && !prevMidsActive) {
      for (let i = 0; i < NUM_RAYS; i++) rayAngles[i] = (Math.random() * 2 - 1) * Math.PI;
    }
    prevMidsActive = audio.mids.active;
    for (let i = 0; i < NUM_RAYS; i++) rayAngles[i] += dt * rayDrift[i];

    if (cfg.spectrum > 0.001) updateSpectrum(audio.spectrum, dt);

    // * sprite geometry (static — tracks the param radius, not the breath).
    const sphereR = Math.max(VOID_RADIUS * 2.10, 0.30);
    const logoHalfPX = Math.min(0.55, sphereR * 0.94);
    const logoHalfPY = Math.min(0.16, sphereR * 0.30);
    const logoHalfAngX = Math.asin(logoHalfPX / sphereR);
    const starAngX = 0.40 * logoHalfAngX;
    const starCenterX = sphereR * Math.sin(starAngX);
    const starHalf = 0.55 * logoHalfPY;

    // ── Draw ──
    const W = canvas.width, H = canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);

    gl.uniform2f(U('uResolution'),      W, H);
    gl.uniform1f(U('uTime'),            time);
    gl.uniform1f(U('uVoidRadius'),      VOID_RADIUS);
    gl.uniform1f(U('uEnergyThickness'), ENERGY_THICKNESS);
    gl.uniform1f(U('uSwirlIntensity'),  SWIRL);
    gl.uniform1f(U('uFlowSpeed'),       flowSpeed);
    gl.uniform1f(U('uOrbitAmount'),     ORBIT);
    gl.uniform1i(U('uPalette'),         Math.max(0, PALETTES.indexOf(cfg.palette)));
    gl.uniform1f(U('uGlowAmt'),         cfg.glow);
    gl.uniform1f(U('uOpacity'),         cfg.opacity);
    gl.uniform1f(U('uSpectrumAmt'),     cfg.spectrum);

    gl.uniform3fv(U('uRingU[0]'),     ringU);
    gl.uniform3fv(U('uRingV[0]'),     ringV);
    gl.uniform1fv(U('uRingRMult[0]'), ringRMult);
    gl.uniform1fv(U('uRingT[0]'),     ringT);
    gl.uniform1fv(U('uRayAngles[0]'), rayAngles);

    gl.uniform1f(U('uStarRotC'),    Math.cos(starRot));
    gl.uniform1f(U('uStarRotS'),    Math.sin(starRot));
    gl.uniform1f(U('uStarCenterX'), starCenterX);
    gl.uniform2f(U('uStarHalfP'),   starHalf, starHalf);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, logoTex);
    gl.uniform1i(U('uLogoTex'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, starTex);
    gl.uniform1i(U('uStarTex'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, specTex);
    gl.uniform1i(U('uSpecTex'), 2);

    uploadAudioUniforms(gl, U, audio);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    if (on && !build()) return;   // GL unavailable → stay off
    enabled = on;
    canvas.style.display = enabled ? 'block' : 'none';
    if (enabled) layout(true);
  }

  function setConfig(patch) {
    if (!patch || typeof patch !== 'object') return;
    if ('position'   in patch && POSITIONS.includes(patch.position)) cfg.position = patch.position;
    if ('x'          in patch) cfg.x = clamp01(patch.x);
    if ('y'          in patch) cfg.y = clamp01(patch.y);
    if ('size'       in patch) cfg.size       = Math.max(80,  Math.min(800,  Number(patch.size)       || LOGO_MARK_DEFAULTS.size));
    if ('centerSize' in patch) cfg.centerSize = Math.max(160, Math.min(1200, Number(patch.centerSize) || LOGO_MARK_DEFAULTS.centerSize));
    if ('opacity'    in patch) cfg.opacity    = Math.max(0.05, clamp01(patch.opacity));
    if ('glow'       in patch) cfg.glow       = clamp01(patch.glow);
    if ('reactivity' in patch) cfg.reactivity = Math.max(0, Math.min(2, Number(patch.reactivity) ?? 1));
    if ('spectrum'   in patch) cfg.spectrum   = clamp01(patch.spectrum);
    if ('flow'       in patch) cfg.flow       = Math.max(0, Math.min(3, Number(patch.flow) ?? 1));
    if ('palette'    in patch && PALETTES.includes(patch.palette)) cfg.palette = patch.palette;
    if ('walk'       in patch) cfg.walk = patch.walk !== false;
    if (enabled) layout();
  }

  return {
    frame,
    setEnabled,
    isEnabled: () => enabled,
    setConfig,
    getConfig: () => ({ ...cfg }),
    /** The mark canvas (null until first enable) — for cam-walk layering. */
    getCanvas: () => canvas,
    /** True when the mark should ride the cam walk (large centered mode). */
    walksWithCam: () => enabled && cfg.position === 'center' && cfg.walk !== false,
    /** Stage-relative CSS-px rect, for the recorder composite. */
    getStageRelRect: () => (enabled && built ? { ...cssRect } : null),
  };
}
