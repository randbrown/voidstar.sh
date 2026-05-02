// Voidstar Logo — the signature brand fx. A dimensional cosmic void-object
// with the lowercase text `void*` embossed onto its curved surface, ringed
// by three Bohr-style 3D orbits whose electrons trail luminous plasma. The
// void itself stays compositionally stable — audio reactivity comes through
// emitted phenomena (plasma plumes, cosmic radiation streaks, sparks, beat
// shockwaves, electron trails), not by pumping its scale.
//
// Audio map:
//   bass         → plasma plume emission strength + electron trail length
//   mids         → swirl brightness + logo body lighting + edge glow
//   highs        → orbit electron glints + dust scintillation + sparks
//   beat.pulse   → outward shockwave annulus + radial streak burst
//   highs.pulse  → spark scintillation + electron tip flash
//   rms          → global agitation / halo glow
//
// Pose map (subtle perspective only — never moves the object in scene-space):
//   head deviation   → camera parallax shift
//   shoulder span    → modulates parallax strength
//   no pose          → autonomous slow drift fallback

import {
  compileProgram, makeFullscreenTri, FULLSCREEN_VERT,
  makeUniformGetter, uploadAudioUniforms,
} from '../webgl.js';

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
uniform sampler2D uLogoTex;

// Bohr-style ring uniforms (3 rings, each with a 3D orientation basis (u,v),
// a radius multiplier, and a current electron parameter).
uniform vec3  uRingU[3];
uniform vec3  uRingV[3];
uniform float uRingRMult[3];
uniform float uRingT[3];

uniform vec4  uBands;
uniform vec2  uBeat;
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
  for (int i = 0; i < 4; i++) {
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

vec3 cosmic(vec2 q, vec3 dustCol, float twinkleAmp) {
  vec3 col = vec3(0.0);
  for (float i = 0.0; i < 2.0; i++) {
    float scale = 14.0 + i * 22.0;
    vec2  g     = q * scale;
    vec2  cell  = floor(g);
    vec2  local = fract(g) - 0.5;
    float h     = hash(cell + i * 17.31);
    float starP = step(0.992 - i * 0.003, h);
    float r     = length(local);
    float core  = exp(-r * r * 110.0);
    float twink = 0.55 + 0.45 * sin(uTime * (1.0 + i * 0.7) + h * 30.0) * twinkleAmp;
    col += vec3(core * starP * twink) * 0.7;
  }
  float n = fbm(q * 1.5 + vec2(uTime * 0.012, 0.0));
  col += dustCol * smoothstep(0.55, 1.0, n) * 0.9;
  return col;
}

float logoSample(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture(uLogoTex, uv).r;
}

// Approximate distance from p to the projected ring whose 3D basis vectors
// project to ux, vx in screen-p. The ring traces (R*ux*cos t + R*vx*sin t).
// Implicit form: |M^{-1} q| = R, where M = [ux | vx]. We return absolute
// deviation from R, in screen-p units (scaled by sqrt|det| as a rough
// metric correction). Returns large value when the ring is near edge-on.
float ringDist(vec2 q, vec2 ux, vec2 vx, float R) {
  float det = ux.x * vx.y - ux.y * vx.x;
  if (abs(det) < 0.04) return 1e6;
  vec2 mInv = vec2(vx.y * q.x - vx.x * q.y, -ux.y * q.x + ux.x * q.y) / det;
  return abs(length(mInv) - R) * sqrt(abs(det));
}

void main() {
  vec2  res    = uResolution;
  float aspect = res.x / max(res.y, 1.0);

  // Aspect-corrected centred coords. p.x in [-aspect, aspect], p.y in [-1, 1].
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= aspect;

  // Parallax (camera shift; the object never moves in scene-space).
  p -= uPoseShift * uParallax * 0.10;

  Pal pal = getPalette(uPalette);

  // ── Background ─────────────────────────────────────────────────────────
  float twinkleAmp = 0.6 + uHighs.y * 1.4 + uBands.z * 0.3;
  vec3  col = cosmic(p, pal.dust, twinkleAmp);

  float r     = length(p);
  float angle = atan(p.y, p.x);

  // Void radius — only a gentle breath. Real audio energy goes into
  // emitted phenomena (plumes/streaks/sparks/electrons), not scaling.
  float vR = uVoidRadius * (1.0 + uBands.x * 0.05 + uBeat.y * 0.06);
  vR = clamp(vR, 0.05, 0.65);

  // ── Energy sheath: swirling annulus just outside the aperture ──────────
  float sheathInner = vR;
  float sheathOuter = vR + uEnergyThickness * (1.0 + uBands.x * 0.20);
  float sheathBand  = smoothstep(sheathInner - 0.005, sheathInner + 0.020, r) *
                      (1.0 - smoothstep(sheathOuter * 0.95, sheathOuter + 0.05, r));
  vec2  swirlSeed = vec2(angle * 2.2 + uTime * uFlowSpeed * 0.32,
                         (r - vR) * 11.0 - uTime * uFlowSpeed * 0.55);
  float swirl    = fbm(swirlSeed);
  float fineSw   = fbm(swirlSeed * 3.0 + 11.0);
  float energy   = sheathBand * (0.35 + 0.85 * swirl + 0.40 * fineSw) * uSwirlIntensity;
  float doppler  = 0.55 + 0.5 * sin(angle * 2.0 + uTime * uFlowSpeed * 0.55);
  energy *= 0.55 + 0.65 * doppler;
  energy *= (1.0 + uBands.y * 0.65);
  float sheathMix = smoothstep(sheathOuter, sheathInner, r);
  vec3  energyCol = mix(pal.sheath, pal.voidEdge, sheathMix);
  col += energyCol * energy * 1.35;

  // Inner-rim lit lip of the aperture.
  float rimG = exp(-pow((r - vR) / max(vR * 0.20, 0.01), 2.0))
             * (0.55 + uBeat.y * 1.2 + uBands.y * 0.4);
  col += pal.voidEdge * rimG * 0.32;

  // ── Plasma plumes — solar-flare-like radial emissions from the aperture.
  // Each plume has a fixed angle (slowly drifting); intensity is per-plume
  // pulsing modulated by bass + beat → feels like the void emits energy.
  float plasma = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi      = float(i);
    float baseAng = fi * 1.0472 + uTime * 0.07 + hash(vec2(fi, 3.1)) * 6.28;
    float dAng    = mod(angle - baseAng + PI, 2.0 * PI) - PI;
    float angWidth = 35.0 + 12.0 * sin(uTime * 0.4 + fi);
    float angleMask = exp(-dAng * dAng * angWidth);
    float radial   = max(0.0, r - vR);
    float falloff  = exp(-radial * 2.6) * smoothstep(vR, vR + 0.04, r);
    float pulse    = 0.4 + 0.6 * sin(uTime * 1.4 + fi * 1.7);
    float power    = uBands.x * (0.5 + 0.5 * pulse) + uBeat.y * 0.7;
    plasma += angleMask * falloff * power;
  }
  col += pal.plasma * plasma * 1.4;

  // ── Cosmic radiation streaks — very thin, very long, beat-driven. They
  // emerge on transients and decay over ~1s as the bass tail fades.
  float streaks = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi      = float(i);
    float baseAng = fi * 0.7854 + uTime * 0.04 + hash(vec2(fi, 7.7)) * 6.28;
    float dAng    = mod(angle - baseAng + PI, 2.0 * PI) - PI;
    float angleMask = exp(-dAng * dAng * 800.0);
    float radial   = r - vR;
    float radialMask = smoothstep(vR, vR + 0.02, r) * exp(-max(0.0, radial) * 1.4);
    float intensity = uBeat.y * 1.5 + uHighs.y * 0.3 + uBands.x * 0.25;
    streaks += angleMask * radialMask * intensity;
  }
  col += pal.voidEdge * streaks * 2.0;

  // ── Beat shockwave — outward annulus that propagates and fades. ────────
  float swR   = vR * (1.5 + 5.0 * pow(uBeat.y, 0.55));
  float swW   = vR * 0.28;
  float shock = exp(-pow((r - swR) / swW, 2.0)) * uBeat.y;
  col += pal.voidEdge * shock * 1.4;

  // ── Bohr-style 3D rings: faint outline + bright electrons with trails ──
  float orbitGain = uOrbitAmount;
  for (int i = 0; i < 3; i++) {
    vec3  u  = uRingU[i];
    vec3  v  = uRingV[i];
    float Rm = uRingRMult[i] * vR;
    float tE = uRingT[i];

    // Faint ring outline.
    float d = ringDist(p, u.xy, v.xy, Rm);
    float thick = vR * 0.014 + 0.001;
    float outlineSoft = exp(-pow(d / (thick * 2.4), 2.0)) * 0.18;
    float outlineHard = exp(-pow(d / thick, 2.0)) * 0.32;
    col += pal.orbit * (outlineSoft + outlineHard) * orbitGain;

    // Electron 3D position and velocity.
    float ct = cos(tE), st = sin(tE);
    vec3  e3 = (u * ct + v * st) * Rm;
    vec3  ev3 = (-u * st + v * ct);

    vec2  eP   = e3.xy;
    float eZ   = e3.z;                 // -Rm..+Rm; positive = nearer
    vec2  eVel = ev3.xy;
    float velLen = max(length(eVel), 1e-3);
    vec2  velN = eVel / velLen;
    vec2  velPerp = vec2(-velN.y, velN.x);

    // Depth-driven brightness — electrons in front read brighter.
    float depthN = 0.5 + 0.5 * (eZ / max(Rm, 1e-3));
    float depthBri = mix(0.45, 1.7, smoothstep(0.0, 1.0, depthN));

    // Electron core + halo.
    float dE  = length(p - eP);
    float coreR  = vR * (0.045 + uBeat.y * 0.04);
    float core   = exp(-pow(dE / coreR, 2.0));
    float haloR  = vR * 0.18;
    float haloEl = exp(-pow(dE / haloR, 2.0)) * 0.45;
    float scintil = uHighs.y * exp(-pow(dE / (coreR * 1.4), 2.0));

    // Plasma trail behind the electron — projected line segment.
    vec2  toE   = p - eP;
    float along = -dot(toE, velN);
    float perp  = dot(toE, velPerp);
    float trailLen   = vR * (0.55 + uBands.x * 0.55 + uBeat.y * 0.30);
    float trailWidth = vR * (0.020 + uBands.y * 0.020);
    float trailLong  = smoothstep(trailLen, 0.0, along) * step(0.0, along);
    float trailSide  = exp(-pow(perp / trailWidth, 2.0));
    float trail      = trailLong * trailSide * 0.85;

    col += pal.electron * (core * 2.4 + haloEl + scintil * 1.3) * depthBri * orbitGain;
    col += pal.plasma   * trail * (0.7 + 0.6 * depthBri) * orbitGain;
  }

  // ── Sparks scattered radially around the void (highs-driven scintilla).
  float sparks = 0.0;
  for (float i = 0.0; i < 3.0; i++) {
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
  col += pal.electron * sparks * (uHighs.y * 1.6 + uBands.z * 0.6 + 0.20);

  // ── Cut to black inside the aperture ──────────────────────────────────
  float voidMask = 1.0 - smoothstep(vR * 0.86, vR * 0.99, r);
  col *= mix(1.0, 0.0, voidMask);

  // ── In-scene void* logo on a curved (spherical) front face ────────────
  // Spherical UV: we treat the void's front as a sphere and project the
  // current screen point through the sphere to angular coords (lon, lat).
  // Letters thus appear gently wrapped around the curved face.
  float sphereR = max(vR * 2.10, 0.30);   // sphere bigger than the aperture
  float zSph    = sqrt(max(sphereR * sphereR - dot(p, p), 1e-4));
  vec2  ang     = vec2(atan(p.x, zSph), atan(p.y, zSph));

  // Logo box in p-space half-extents, converted to angular extents on the
  // same sphere so the wrap matches a strip of the sphere.
  vec2  logoHalfP   = vec2(min(0.55, sphereR * 0.94), min(0.16, sphereR * 0.30));
  vec2  logoHalfAng = vec2(asin(logoHalfP.x / sphereR), asin(logoHalfP.y / sphereR));
  vec2  logoUV      = ang / logoHalfAng * 0.5 + 0.5;

  // Visibility: only render where p actually projects to the front face
  // and within the logo's angular box.
  float onSphere    = step(dot(p, p), sphereR * sphereR);
  float inLogoBox   = step(0.0, logoUV.x) * step(logoUV.x, 1.0)
                    * step(0.0, logoUV.y) * step(logoUV.y, 1.0);
  float logoVisible = onSphere * inLogoBox;

  float maskC = logoSample(logoUV) * logoVisible;

  // Extrusion direction: depth tied to the void center. We sample the mask
  // at offsets going OUTWARD from the screen centre so the side wall
  // appears on the inner (toward-void) side of each letter — letters look
  // like they recede into the aperture.
  vec2  outwardP   = (r > 1e-3) ? p / r : vec2(0.0, 1.0);
  // Convert a step in p-space to a step in UV-space using the local
  // jacobian of the spherical map. d(ang)/dp_x ≈ 1/zSph, d(ang)/dp_y ≈ 1/zSph
  // for an axial sample. Use this to keep extrusion isotropic in p-space.
  vec2  uvPerP     = vec2(1.0 / max(zSph, 1e-3) / max(logoHalfAng.x, 1e-3),
                          1.0 / max(zSph, 1e-3) / max(logoHalfAng.y, 1e-3)) * 0.5;
  float dStepP     = 0.005 + uLogoDepth * 0.018;
  float maskBack   = 0.0;
  for (int i = 1; i <= 6; i++) {
    vec2 offP  = outwardP * dStepP * float(i);
    vec2 offUV = offP * uvPerP;
    maskBack = max(maskBack, logoSample(logoUV + offUV) * logoVisible);
  }
  float side = clamp(maskBack - maskC, 0.0, 1.0);

  // Edge gradient (Sobel-ish) for diffuse + rim. Step in UV.
  float eps = 0.0024;
  float mL = logoSample(logoUV + vec2(-eps, 0.0));
  float mR = logoSample(logoUV + vec2( eps, 0.0));
  float mU = logoSample(logoUV + vec2(0.0, -eps));
  float mD = logoSample(logoUV + vec2(0.0,  eps));
  vec2  grad    = vec2(mR - mL, mD - mU);
  float gradLen = length(grad);
  vec2  norm    = gradLen > 1e-4 ? grad / gradLen : vec2(0.0);

  // Light source = void centre. Ambient + diffuse + edge rim. Emission
  // scales with surrounding energy so letters pulse gently with the music.
  vec2  toCenter = -outwardP;
  float diffuse = clamp(dot(norm, toCenter), 0.0, 1.0);
  float ambient = 0.50 + uBands.y * 0.35 + uBeat.y * 0.45;
  float voidGlow = clamp(1.0 - r / max(vR * 3.5, 1e-3), 0.0, 1.0);
  vec3  bodyCol = mix(pal.logo, pal.voidEdge, voidGlow * 0.55);
  vec3  bodyLit = bodyCol * (ambient + 0.45 * diffuse + voidGlow * 0.35);

  // Side-wall colour: lit by void glow, dimmer than body.
  vec3 sideCol = mix(pal.logo * 0.30, pal.voidEdge, voidGlow * 0.6) * (0.55 + voidGlow * 0.7);

  // Silhouette edge highlight.
  float edge = clamp(gradLen * 8.0, 0.0, 1.0);

  // Soft halo behind the logo.
  float halo = 0.0;
  for (int i = 1; i <= 4; i++) {
    float t = float(i) * 1.6;
    vec2 oh = vec2( eps, 0.0) * t * 3.0;
    vec2 ov = vec2(0.0,  eps) * t * 3.0;
    halo += logoSample(logoUV + oh) + logoSample(logoUV - oh)
          + logoSample(logoUV + ov) + logoSample(logoUV - ov);
  }
  halo = clamp(halo / 16.0 - maskC, 0.0, 1.0) * logoVisible;
  col += pal.halo * halo * (0.55 + uRms * 0.9 + uBeat.y * 0.7);

  // Composite logo body (alpha-over so it occludes void/orbits behind).
  col = mix(col, bodyLit, maskC);
  // Side wall + edge rim (additive in their respective regions).
  col += sideCol * side * 0.65;
  col += pal.voidEdge * edge * (0.40 + uBands.y * 0.55 + uBeat.y * 0.45) * logoVisible;

  // ── Vignette + tone ───────────────────────────────────────────────────
  float v = smoothstep(1.7, 0.4, length(p));
  col *= v;
  col = pow(col, vec3(0.92));

  outColor = vec4(col, 1.0);
}
`;

const PALETTES = ['silver', 'voidblue', 'platinum', 'inferno'];

// Rotate a 3-vector through Euler XYZ angles (radians). Reuses scratch.
function rotateXYZ(out, vx, vy, vz, ax, ay, az) {
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const cy = Math.cos(ay), sy = Math.sin(ay);
  const cz = Math.cos(az), sz = Math.sin(az);
  // X
  let x = vx;
  let y = vy * cx - vz * sx;
  let z = vy * sx + vz * cx;
  // Y
  let x2 = x * cy + z * sy;
  let y2 = y;
  let z2 = -x * sy + z * cy;
  // Z
  out[0] = x2 * cz - y2 * sz;
  out[1] = x2 * sz + y2 * cz;
  out[2] = z2;
}

/** @type {import('../types.js').QualiaFXModule} */
export default {
  id: 'voidstar_logo',
  name: 'Voidstar Logo',
  contextType: 'webgl2',

  params: [
    { id: 'voidRadius',      label: 'void radius',      type: 'range', min: 0.10, max: 0.55, step: 0.01, default: 0.26 },
    { id: 'energyThickness', label: 'energy thickness', type: 'range', min: 0.02, max: 0.40, step: 0.01, default: 0.16 },
    { id: 'swirlIntensity',  label: 'swirl intensity',  type: 'range', min: 0.00, max: 2.00, step: 0.01, default: 0.95 },
    { id: 'flowSpeed',       label: 'flow speed',       type: 'range', min: 0.00, max: 3.00, step: 0.01, default: 0.80 },
    { id: 'orbitAmount',     label: 'orbit amount',     type: 'range', min: 0.00, max: 2.00, step: 0.01, default: 1.10 },
    { id: 'logoDepth',       label: 'logo depth',       type: 'range', min: 0.00, max: 2.00, step: 0.01, default: 0.75 },
    { id: 'parallax',        label: 'parallax',         type: 'range', min: 0.00, max: 1.50, step: 0.01, default: 0.45 },
    { id: 'palette',         label: 'palette',          type: 'select', options: ['silver', 'voidblue', 'platinum', 'inferno'], default: 'silver' },
  ],

  presets: {
    default:         { voidRadius: 0.26, energyThickness: 0.16, swirlIntensity: 0.95, flowSpeed: 0.80, orbitAmount: 1.10, logoDepth: 0.75, parallax: 0.45, palette: 'silver' },
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

    // ── void* logo texture (offscreen Canvas2D, monospace/terminal feel) ──
    const TEX_W = 1024, TEX_H = 256;
    const tex = (() => {
      const c = document.createElement('canvas');
      c.width = TEX_W; c.height = TEX_H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, TEX_W, TEX_H);
      ctx.fillStyle = '#fff';
      // Terminal/leetcoder vibe: prefer programmer fonts, fall back through
      // common monospace stacks.
      ctx.font = '700 168px "JetBrains Mono", "Cascadia Code", "Fira Code", "Source Code Pro", "Ubuntu Mono", "Menlo", "Consolas", monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('void*', TEX_W / 2, TEX_H / 2 + 4);
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
    })();

    let W = canvas.width, H = canvas.height;

    // ── Bohr-style ring state. Each ring starts orthogonal to the others
    // (planes XY, YZ, XZ), then precesses with its own per-axis Euler
    // rates so over time the trio drifts through 3D space naturally.
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

    // Pre-allocated scratch for uniform uploads.
    const ringU      = new Float32Array(NUM_RINGS * 3);
    const ringV      = new Float32Array(NUM_RINGS * 3);
    const ringRMult  = new Float32Array(NUM_RINGS);
    const ringT      = new Float32Array(NUM_RINGS);
    const tmpVec     = new Float32Array(3);

    // Smoothed parallax target.
    let poseShiftX = 0, poseShiftY = 0;

    let audioRef = null;
    const scratch = {
      time: 0,
      voidRadius: 0.26, energyThickness: 0.16, swirlIntensity: 0.95,
      flowSpeed: 0.80, orbitAmount: 1.10, logoDepth: 0.75, parallax: 0.45,
      palette: 0,
    };

    function update(field) {
      const { dt, time, audio, pose, params } = field;
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

      // Advance ring rotations + electron parameters. Beat boosts electron
      // speed transiently — gives the impression of radiation events.
      const beatBoost = 1.0 + audio.beat.pulse * 4.0 + audio.bands.bass * 0.6;
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

        ringRMult[i] = base.radiusMult;
        ringElectronT[i] += dt * base.electronSpeed * beatBoost * (0.6 + params.flowSpeed * 0.4);
        ringT[i] = ringElectronT[i];
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

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(U('uLogoTex'), 0);

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
        gl.deleteTexture(tex);
      },
    };
  },
};
