// Voidstar Logo — the signature brand fx. A dimensional cosmic void-object
// with the lowercase text `void*` embossed onto its curved surface, ringed
// by three Bohr-style 3D orbits whose electrons trail luminous plasma. The
// `*` is rendered as a separate sprite so it can spin slowly while "void"
// stays anchored to the curved face.
//
// Audio is decoupled per element so the whole scene doesn't pump uniformly
// to the kick:
//   • void aperture       — only a subtle response to *strong* bass.
//   • light rays/streaks  — snare-driven (mids transient).
//   • energy sheath/swirl — mids + highs (band levels).
//   • plasma plumes       — slow bass envelope.
//   • beat shockwave      — kick (uBeat).
//   • void* logo body     — subtle mids + snare; never the kick.
//   • electron orbit radii are *not* coupled to the breathing void radius
//     — instead a slow gravity-style perturbation drifts each ring's radius
//     independently. Sizes (electron core, halo, trail) use the static
//     param uVoidRadius so they don't visibly scale with the breath.
//
// Pose drives camera parallax only; the object never moves in scene-space.

import {
  compileProgram, makeFullscreenTri, FULLSCREEN_VERT,
  makeUniformGetter, uploadAudioUniforms,
} from '../webgl.js';
import { scaleAudio } from '../field.js';

const NUM_RINGS = 3;

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
uniform float uLogoDepth;
uniform vec2  uPoseShift;
uniform float uParallax;
uniform int   uPalette;

// "void" baked left of centre + an empty cell where * was.
uniform sampler2D uLogoTex;
// "*" baked centred — sampled with a rotated screen-p UV around its centre.
uniform sampler2D uStarTex;
uniform float     uStarRotC;        // cos(starRot)
uniform float     uStarRotS;        // sin(starRot)
uniform float     uStarCenterX;     // screen-p x of * centre
uniform vec2      uStarHalfP;       // screen-p half-extents of * sprite

uniform vec3  uRingU[3];
uniform vec3  uRingV[3];
uniform float uRingRMult[3];
uniform float uRingT[3];

// Per-ray base angle for the snare-driven light rays. JS shuffles each
// entry on every snare onset and applies a slow per-ray drift in between,
// so the rays read as independently random instead of a fixed pattern.
uniform float uRayAngles[6];

uniform vec4  uBands;
uniform vec2  uBeat;       // kick (bass) transient
uniform vec2  uMids;       // snare / clap transient
uniform vec2  uHighs;      // hat / cymbal transient
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
// 3-octave fbm. The 4th octave adds little visual texture but ~33% more
// hash work per call, and this runs three times per pixel.
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
  vec3 voidEdge, sheath, orbit, electron, logo, halo, dust, plasma;
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
    p.dust     = vec3(0.04, 0.05, 0.10);
    p.plasma   = vec3(0.78, 0.88, 1.00);
  } else if (idx == 1) {     // voidblue
    p.voidEdge = vec3(0.55, 0.94, 1.00);
    p.sheath   = vec3(0.20, 0.55, 0.95);
    p.orbit    = vec3(0.55, 0.85, 1.00);
    p.electron = vec3(0.85, 0.98, 1.00);
    p.logo     = vec3(0.85, 0.92, 1.00);
    p.halo     = vec3(0.10, 0.30, 0.65);
    p.dust     = vec3(0.02, 0.03, 0.10);
    p.plasma   = vec3(0.30, 0.75, 1.00);
  } else if (idx == 2) {     // platinum
    p.voidEdge = vec3(0.97, 0.95, 1.00);
    p.sheath   = vec3(0.80, 0.82, 0.88);
    p.orbit    = vec3(0.86, 0.88, 0.96);
    p.electron = vec3(0.98, 0.96, 1.00);
    p.logo     = vec3(0.93, 0.94, 0.98);
    p.halo     = vec3(0.50, 0.55, 0.74);
    p.dust     = vec3(0.04, 0.04, 0.08);
    p.plasma   = vec3(0.80, 0.82, 0.95);
  } else {                   // inferno
    p.voidEdge = vec3(1.00, 0.55, 0.20);
    p.sheath   = vec3(0.95, 0.40, 0.10);
    p.orbit    = vec3(1.00, 0.78, 0.40);
    p.electron = vec3(1.00, 0.92, 0.55);
    p.logo     = vec3(1.00, 0.78, 0.45);
    p.halo     = vec3(0.55, 0.10, 0.04);
    p.dust     = vec3(0.06, 0.02, 0.01);
    p.plasma   = vec3(1.00, 0.50, 0.15);
  }
  return p;
}

// Single-layer cosmic background. Using one layer (not two) plus a
// 2-octave cheap noise dust keeps the visual feel while halving the
// per-pixel cost — this function runs for every screen pixel.
vec3 cosmic(vec2 q, vec3 dustCol, float twinkleAmp) {
  vec3 col = vec3(0.0);
  vec2  g     = q * 22.0;
  vec2  cell  = floor(g);
  vec2  local = fract(g) - 0.5;
  float h     = hash(cell);
  float starP = step(0.991, h);
  float r     = length(local);
  float core  = exp(-r * r * 110.0);
  float twink = 0.55 + 0.45 * sin(uTime * 1.4 + h * 30.0) * twinkleAmp;
  col += vec3(core * starP * twink) * 0.7;
  // Cheap 2-octave dust.
  float n = vnoise(q * 1.5 + vec2(uTime * 0.012, 0.0)) * 0.5
          + vnoise(q * 3.0)                              * 0.5;
  col += dustCol * smoothstep(0.55, 1.0, n) * 0.9;
  return col;
}

float ringDist(vec2 q, vec2 ux, vec2 vx, float R) {
  float det = ux.x * vx.y - ux.y * vx.x;
  if (abs(det) < 0.04) return 1e6;
  vec2 mInv = vec2(vx.y * q.x - vx.x * q.y, -ux.y * q.x + ux.x * q.y) / det;
  return abs(length(mInv) - R) * sqrt(abs(det));
}

// ── Logo samplers — split so the * can rotate while "void" stays anchored.
// voidSample reads the static "void" texture in (already-warped) sphere UV.
// starSampleAtP reads the rotating "*" sprite via a screen-p coord centred
// on the * position; it is independent of the spherical UV so the rotation
// looks natural.
float voidSample(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture(uLogoTex, uv).r;
}
float starSampleAtP(vec2 pp) {
  vec2 rel = pp - vec2(uStarCenterX, 0.0);
  // Cheap bounding-circle early out — the rotated sprite never extends
  // past sqrt(2) * max(half-extents) from its centre. Skips the texture
  // sample for the ~95% of pixels far from the *.
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

void main() {
  vec2  res    = uResolution;
  float aspect = res.x / max(res.y, 1.0);

  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= aspect;
  p -= uPoseShift * uParallax * 0.10;

  Pal pal = getPalette(uPalette);

  float twinkleAmp = 0.6 + uHighs.y * 1.4 + uBands.z * 0.3;
  vec3  col = cosmic(p, pal.dust, twinkleAmp);

  float r     = length(p);
  float angle = atan(p.y, p.x);

  // ── Void aperture: only a subtle response to *strong* bass.
  // strongBass is 0 below 0.55 and ramps to 1 by 1.0, then breathing tops
  // out at +5% — so a kick alone won't visibly resize the void; only a
  // very loud bass-heavy passage budges it.
  float strongBass = clamp((uBands.x - 0.55) * 2.5, 0.0, 1.0);
  float vR = uVoidRadius * (1.0 + strongBass * 0.05);
  vR = clamp(vR, 0.05, 0.65);

  // ── Energy sheath — mids + highs drive thickness and brightness.
  // Both inner and outer transitions are softly feathered so the sheath
  // bleeds smoothly into the void rim and the surrounding cosmos rather
  // than sitting against hard edges.
  float sheathInner = vR;
  float sheathOuter = vR + uEnergyThickness * (1.0 + uBands.y * 0.18 + uBands.z * 0.12);
  float sheathBand  = smoothstep(sheathInner - 0.025, sheathInner + 0.060, r) *
                      (1.0 - smoothstep(sheathOuter * 0.82, sheathOuter + 0.14, r));
  // Seam-free swirl seed: feed fbm a unit-direction vector instead of the
  // raw atan(y,x). atan wraps from -PI to +PI at the negative x-axis and
  // that jump appears as a vertical seam in fbm; the unit-direction
  // p/length(p) is continuous the whole way round and produces a noise
  // pattern with no discontinuity. Time slowly rotates the seed.
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

  // ── Plasma plumes — slow bass envelope. Reduced amplitude so they read
  // as ambient emission, not as a synced pulse.
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

  // ── Cosmic radiation streaks — SNARE-driven (mids transient). Light
  // rays emit on snare/clap hits. Each ray's angle is uRayAngles[i]
  // (set on the JS side, reshuffled on every snare onset and slowly
  // drifting in between) so the pattern looks independently random
  // instead of a fixed rotating constellation. Inner end is feathered
  // into the void rim so rays appear to emerge from the aperture itself.
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

  // ── Beat shockwave — kick. Reduced so it's a flicker, not a slam.
  float swR   = vR * (1.5 + 4.5 * pow(uBeat.y, 0.55));
  float swW   = vR * 0.28;
  float shock = exp(-pow((r - swR) / swW, 2.0)) * uBeat.y;
  col += pal.voidEdge * shock * 1.05;

  // ── Bohr-style 3D rings.
  // Ring radii use uVoidRadius (the *param*, not the breathing vR) so they
  // don't track the void's audio breathing. Per-ring "gravity" perturbation
  // is baked into uRingRMult on the JS side. Electron sizes use uVoidRadius
  // for the same reason.
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

  // ── Sparks — highs-driven scintilla, with mild snare accent.
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

  // ── Cut to black inside the aperture, feathered so the rim of the void
  // fades softly into the surrounding energy instead of clipping hard.
  float voidMask = 1.0 - smoothstep(vR * 0.65, vR * 1.04, r);
  col *= mix(1.0, 0.0, voidMask);

  // ── In-scene void* logo on a curved (spherical) front face ────────────
  // The whole logo block (combo sampling, extrusion, gradient, halo) is
  // the most expensive part of the shader. Skipping it for off-sphere
  // pixels (the majority of the screen) is a big perf win.
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
    float dStepP     = 0.005 + uLogoDepth * 0.018;
    float maskBack   = 0.0;
    for (int i = 1; i <= 5; i++) {
      vec2 offP  = outwardP * dStepP * float(i);
      vec2 offUV = offP * uvPerP;
      maskBack = max(maskBack, comboSample(logoUV + offUV, p + offP));
    }
    float side = clamp(maskBack - maskC, 0.0, 1.0);

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

    vec3 sideCol = mix(pal.logo * 0.30, pal.voidEdge, voidGlow * 0.6) * (0.55 + voidGlow * 0.7);
    float edge = clamp(gradLen * 8.0, 0.0, 1.0);

    // Cross-pattern halo — 2 distances × 4 directions = 8 samples (was 16).
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
    col += pal.halo * halo * (0.55 + uRms * 0.7 + uMids.y * 0.30);

    col = mix(col, bodyLit, maskC);
    col += sideCol * side * 0.65;
    col += pal.voidEdge * edge * (0.40 + uBands.y * 0.20 + uMids.y * 0.30);
  }

  col += colFront;

  // ── Vignette + tone ───────────────────────────────────────────────────
  float v = smoothstep(1.7, 0.4, length(p));
  col *= v;
  col = pow(col, vec3(0.92));

  outColor = vec4(col, 1.0);
}
`;

const PALETTES = ['silver', 'voidblue', 'platinum', 'inferno'];

// Rotate a 3-vector through Euler XYZ angles. Reuses scratch.
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

// Bake a single text into a black-background canvas → GL texture (red channel
// holds the white text mask in the shader).
function bakeTextTex(gl, text, w, h, fontSize) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${fontSize}px "JetBrains Mono", "Cascadia Code", "Fira Code", "Source Code Pro", "Ubuntu Mono", "Menlo", "Consolas", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 4);
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'voidstar_logo',
  name: 'Voidstar Logo',
  contextType: 'webgl2',

  params: [
    { id: 'voidRadius',      label: 'void radius',      type: 'range', min: 0.10, max: 0.55, step: 0.01, default: 0.26 },
    { id: 'energyThickness', label: 'energy thickness', type: 'range', min: 0.02, max: 0.40, step: 0.01, default: 0.34 },
    { id: 'swirlIntensity',  label: 'swirl intensity',  type: 'range', min: 0.00, max: 1.00, step: 0.01, default: 0.16 },
    { id: 'flowSpeed',       label: 'flow speed',       type: 'range', min: 0.00, max: 3.00, step: 0.01, default: 0.23 },
    { id: 'orbitAmount',     label: 'orbit amount',     type: 'range', min: 0.00, max: 2.00, step: 0.01, default: 1.01 },
    { id: 'logoDepth',       label: 'logo depth',       type: 'range', min: 0.00, max: 2.00, step: 0.01, default: 0.00 },
    { id: 'parallax',        label: 'parallax',         type: 'range', min: 0.00, max: 1.50, step: 0.01, default: 0.76 },
    { id: 'palette',         label: 'palette',          type: 'select', options: ['silver', 'voidblue', 'platinum', 'inferno'], default: 'platinum' },
    { id: 'reactivity',      label: 'reactivity',       type: 'range', min: 0.00, max: 2.00, step: 0.05, default: 1.0 },
  ],

  presets: {
    default:         { voidRadius: 0.26, energyThickness: 0.34, swirlIntensity: 0.16, flowSpeed: 0.23, orbitAmount: 1.01, logoDepth: 0.00, parallax: 0.76, palette: 'platinum', reactivity: 1.0 },
    atomic_mystic:   { voidRadius: 0.24, energyThickness: 0.14, swirlIntensity: 1.10, flowSpeed: 1.00, orbitAmount: 1.50, logoDepth: 0.80, parallax: 0.50, palette: 'platinum' },
    platonic:        { voidRadius: 0.28, energyThickness: 0.10, swirlIntensity: 0.55, flowSpeed: 0.45, orbitAmount: 0.65, logoDepth: 0.65, parallax: 0.35, palette: 'silver' },
    ruliad:          { voidRadius: 0.22, energyThickness: 0.18, swirlIntensity: 1.35, flowSpeed: 1.20, orbitAmount: 1.35, logoDepth: 0.90, parallax: 0.60, palette: 'voidblue' },
    infernal_portal: { voidRadius: 0.25, energyThickness: 0.20, swirlIntensity: 1.50, flowSpeed: 1.60, orbitAmount: 0.90, logoDepth: 0.85, parallax: 0.45, palette: 'inferno' },
    ambient:         { voidRadius: 0.30, energyThickness: 0.11, swirlIntensity: 0.40, flowSpeed: 0.30, orbitAmount: 0.75, logoDepth: 0.60, parallax: 0.25, palette: 'silver' },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    // "void " (trailing space) keeps the four letters in the same cells they
    // used to occupy in "void*" — the * cell is left blank for the rotating
    // sprite to fill. Star is its own 256² square sprite.
    const logoTex = bakeTextTex(gl, 'void ', 1024, 256, 168);
    const starTex = bakeTextTex(gl, '*',     256, 256, 240);

    let W = canvas.width, H = canvas.height;

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
    const ringPhaseOff = [0.0, 1.7, 4.1];
    const ringElectronT = [0.0, 1.5, 3.2];
    // Smoothed dynamic radius multiplier per ring — drifts around its base
    // via a slow gravity-like spring, nudged by bass + slow time.
    const ringRMultDyn = ringBases.map(b => b.radiusMult);

    const ringU      = new Float32Array(NUM_RINGS * 3);
    const ringV      = new Float32Array(NUM_RINGS * 3);
    const ringRMult  = new Float32Array(NUM_RINGS);
    const ringT      = new Float32Array(NUM_RINGS);
    const tmpVec     = new Float32Array(3);

    // Light-ray angles. Six independent rays whose base angle is reshuffled
    // randomly on every snare onset; between hits each ray drifts at its
    // own slow rate so they continue to spread apart even when audio is off.
    const NUM_RAYS  = 6;
    const rayAngles = new Float32Array(NUM_RAYS);
    const rayDrift  = [0.05, 0.04, 0.07, 0.03, 0.06, 0.045];
    for (let i = 0; i < NUM_RAYS; i++) rayAngles[i] = (Math.random() * 2 - 1) * Math.PI;
    let prevMidsActive = false;

    let poseShiftX = 0, poseShiftY = 0;
    let starRot = 0;

    let audioRef = null;
    const scratch = {
      time: 0,
      voidRadius: 0.26, energyThickness: 0.34, swirlIntensity: 0.16,
      flowSpeed: 0.23, orbitAmount: 1.01, logoDepth: 0.00, parallax: 0.76,
      palette: PALETTES.indexOf('platinum'),
      starCenterX: 0.0, starHalfPX: 0.0, starHalfPY: 0.0,
    };

    function update(field) {
      const { dt, time, pose, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;
      scratch.time            = time;
      scratch.voidRadius      = params.voidRadius;
      scratch.energyThickness = params.energyThickness;
      scratch.swirlIntensity  = params.swirlIntensity;
      scratch.flowSpeed       = params.flowSpeed;
      scratch.orbitAmount     = params.orbitAmount;
      scratch.logoDepth       = params.logoDepth;
      scratch.parallax        = params.parallax;
      scratch.palette         = Math.max(0, PALETTES.indexOf(params.palette));

      // Compute static * sprite geometry from the param uVoidRadius — it
      // does NOT track the audio breathing so the * stays anchored. The *
      // sits just to the right of the "d" (logoUV.x ≈ 0.78) so it reads
      // as part of the logotype, not a detached element.
      const sphereR = Math.max(params.voidRadius * 2.10, 0.30);
      const logoHalfPX = Math.min(0.55, sphereR * 0.94);
      const logoHalfPY = Math.min(0.16, sphereR * 0.30);
      const logoHalfAngX = Math.asin(logoHalfPX / sphereR);
      const starAngX = 0.50 * logoHalfAngX;     // → logoUV.x ≈ 0.75 (just past "d")
      scratch.starCenterX = sphereR * Math.sin(starAngX);
      scratch.starHalfPX  = 0.20 * logoHalfPX;
      scratch.starHalfPY  = 0.55 * logoHalfPY;

      // Ring rotations + per-ring electron parameter advance. Beat boosts
      // electron speed transiently — gives a sense of radiation events.
      const beatBoost = 1.0 + audio.beat.pulse * 4.0 + audio.bands.bass * 0.6;
      // Slow gravity perturbation on each ring's radius. Spring-damper
      // toward a target = base * (1 + small audio + slow time wobble).
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

        ringElectronT[i] += dt * base.electronSpeed * beatBoost * (0.6 + params.flowSpeed * 0.4);
        ringT[i] = ringElectronT[i];
      }

      // Slow * rotation. Base rate ~10°/sec, with a tiny audio-energy boost.
      starRot += dt * (0.18 + audio.rms * 0.5);
      if (starRot > Math.PI * 200) starRot -= Math.PI * 200;

      // Light-ray angles: reshuffle on every snare rising edge so each
      // pulse paints a fresh constellation. Continuous slow per-ray drift
      // keeps them moving when audio is off or between hits.
      if (audio.mids.active && !prevMidsActive) {
        for (let i = 0; i < NUM_RAYS; i++) {
          rayAngles[i] = (Math.random() * 2 - 1) * Math.PI;
        }
      }
      prevMidsActive = audio.mids.active;
      for (let i = 0; i < NUM_RAYS; i++) {
        rayAngles[i] += dt * rayDrift[i];
      }

      // Pose-driven parallax (subtle camera shift, capped small).
      let tx = 0, ty = 0;
      let havePose = false;
      if (pose.people.length > 0) {
        const p0 = pose.people[0];
        const head = p0.head;
        if (head && head.visibility > 0.35 && p0.confidence > 0.30) {
          const hx = head.x - 0.5;
          const hy = head.y - 0.5;
          let strength = 1.0;
          const sL = p0.shoulders?.l, sR = p0.shoulders?.r;
          if (sL && sR && sL.visibility > 0.4 && sR.visibility > 0.4) {
            const sx = sR.x - sL.x;
            const sy = sR.y - sL.y;
            const span = Math.sqrt(sx * sx + sy * sy);
            strength = Math.max(0.4, Math.min(1.6, span / 0.25));
          }
          tx = hx * strength;
          ty = hy * strength;
          havePose = true;
        }
      }
      const driftX = 0.18 * Math.sin(time * 0.11);
      const driftY = 0.14 * Math.cos(time * 0.09);
      const tgtX = havePose ? tx : driftX;
      const tgtY = havePose ? ty : driftY;
      const k = Math.min(1, dt * 2.5);
      poseShiftX += (tgtX - poseShiftX) * k;
      poseShiftY += (tgtY - poseShiftY) * k;
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      gl.uniform2f(U('uResolution'),       W, H);
      gl.uniform1f(U('uTime'),             scratch.time);
      gl.uniform1f(U('uVoidRadius'),       scratch.voidRadius);
      gl.uniform1f(U('uEnergyThickness'),  scratch.energyThickness);
      gl.uniform1f(U('uSwirlIntensity'),   scratch.swirlIntensity);
      gl.uniform1f(U('uFlowSpeed'),        scratch.flowSpeed);
      gl.uniform1f(U('uOrbitAmount'),      scratch.orbitAmount);
      gl.uniform1f(U('uLogoDepth'),        scratch.logoDepth);
      gl.uniform1f(U('uParallax'),         scratch.parallax);
      gl.uniform2f(U('uPoseShift'),        poseShiftX, poseShiftY);
      gl.uniform1i(U('uPalette'),          scratch.palette);

      gl.uniform3fv(U('uRingU[0]'),     ringU);
      gl.uniform3fv(U('uRingV[0]'),     ringV);
      gl.uniform1fv(U('uRingRMult[0]'), ringRMult);
      gl.uniform1fv(U('uRingT[0]'),     ringT);
      gl.uniform1fv(U('uRayAngles[0]'), rayAngles);

      // Star sprite uniforms.
      gl.uniform1f(U('uStarRotC'),    Math.cos(starRot));
      gl.uniform1f(U('uStarRotS'),    Math.sin(starRot));
      gl.uniform1f(U('uStarCenterX'), scratch.starCenterX);
      gl.uniform2f(U('uStarHalfP'),   scratch.starHalfPX, scratch.starHalfPY);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, logoTex);
      gl.uniform1i(U('uLogoTex'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, starTex);
      gl.uniform1i(U('uStarTex'), 1);

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
        gl.deleteTexture(logoTex);
        gl.deleteTexture(starTex);
      },
    };
  },
};
