// Gargantua Void — cinematic relativistic black hole. Fakes Schwarzschild
// lensing + a tilted accretion disk seen near edge-on. Three disk
// components compose the iconic look:
//   1. Front disk: thin horizontal band crossing IN FRONT of the horizon.
//      Renders inside the horizon screen-space too (it occludes).
//   2. Top arc: lensed back-side disk light bent UP and OVER the horizon.
//   3. Lower arc: dimmer red/orange echo below.
//
// The shader avoids actual ray-tracing — it uses inverse-projection from
// screen-y to world-z (assuming the disk lies flat in y=0 plane, tilted
// around X by uDiskTilt radians). This gives the visual model "for free":
// pdz > 0 → front of disk; pdz < 0 → back side. The horizon early-return
// only allows front-disk pixels through, and the back side is mostly
// hidden by the horizon (its laterally-extending wings remain visible
// outside the horizon).
//
// Audio bindings: bass→horizon breath + slow gravitational pulse; mids→disk
// band brightness + plasma flow; highs→star twinkle + fine sparks;
// beat.pulse→shockwave + white-hot flash; rms→global glow.
//
// Pose bindings (observer-perspective model — pose does NOT move the black
// hole). The user's body in front of the camera reshapes the *view*:
//   shoulder span → proximity → horizon size on screen
//                 (closer body = bigger horizon, like walking toward it)
//   shoulder roll → camera roll (tilt your shoulders, the whole scene rolls)
//   head-to-shoulder ratio → camera pitch (lean back, disk goes more face-on;
//                                          lean forward, disk goes edge-on)
// The singularity centre itself just does a slow autonomous drift so the
// composition isn't perfectly static.

import {
  compileProgram,
  makeFullscreenTri,
  FULLSCREEN_VERT,
  makeUniformGetter,
  uploadAudioUniforms,
} from '../webgl.js';
import { scaleAudio } from '../field.js';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform vec2  uCenter;          // [0,1]² singularity centre
uniform vec2  uPerturb;          // disk-plane perturbation (wrist-driven)
uniform int   uPalette;          // 0 gold, 1 voidblue, 2 inferno
uniform float uHorizon;          // base r_s
uniform float uLensStrength;     // background lens intensity
uniform float uDiskBrightness;
uniform float uTurbulence;
uniform float uFlowSpeed;
uniform float uDiskTilt;         // radians, 0.05..PI/2 (small=edge-on)
uniform float uBloomFake;
uniform float uHaloIntensity;    // event-horizon halo brightness multiplier
// ── Observer-perspective uniforms (pose-driven) ─────────────────────────────
// These reshape the *view*, not the singularity position.
uniform float uPoseProximity;    // -1 (far) .. +1 (close)   → horizon size
uniform float uPoseRoll;         // -1 .. +1                  → camera roll
uniform float uPosePitch;        // -1 .. +1                  → disk tilt offset

// Standard qualia audio uniforms (uploadAudioUniforms in webgl.js)
uniform vec4  uBands;            // (bass, mids, highs, total)
uniform vec2  uBeat;             // (active, pulse)
uniform vec2  uHighs;            // (active, pulse)
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

// Five colour stops per palette: hot core, mid disk, cold outer, lower-arc
// echo, gravitational aura.
void getPalette(int idx,
                out vec3 hot, out vec3 mid, out vec3 cold,
                out vec3 lowerArcCol, out vec3 auraCol) {
  if (idx == 0) {        // gold (Interstellar-ish)
    hot         = vec3(1.00, 0.97, 0.82);
    mid         = vec3(1.00, 0.66, 0.18);
    cold        = vec3(0.32, 0.10, 0.02);
    lowerArcCol = vec3(0.95, 0.30, 0.08);
    auraCol     = vec3(0.18, 0.30, 0.55);
  } else if (idx == 1) { // voidblue
    hot         = vec3(0.95, 0.98, 1.00);
    mid         = vec3(0.20, 0.85, 1.00);
    cold        = vec3(0.04, 0.10, 0.30);
    lowerArcCol = vec3(1.00, 0.50, 0.25);
    auraCol     = vec3(0.25, 0.50, 0.85);
  } else {               // inferno
    hot         = vec3(1.00, 0.95, 0.75);
    mid         = vec3(1.00, 0.30, 0.05);
    cold        = vec3(0.30, 0.02, 0.00);
    lowerArcCol = vec3(0.85, 0.10, 0.05);
    auraCol     = vec3(0.45, 0.15, 0.20);
  }
}

vec3 starfield(vec2 q) {
  vec3 col = vec3(0.0);
  float twinkleAmp = 0.8 + uHighs.y * 1.5 + uBands.z * 0.6;
  for (float i = 0.0; i < 3.0; i++) {
    float scale = 5.0 + i * 11.0;
    vec2  g     = q * scale;
    vec2  cell  = floor(g);
    vec2  local = fract(g) - 0.5;
    float h     = hash(cell + i * 17.31);
    float starP = step(0.985 - i * 0.005, h);
    float r     = length(local);
    float core  = exp(-r * r * (60.0 + i * 80.0));
    float twink = 0.7 + 0.3 * sin(uTime * (1.5 + i) + h * 30.0) * twinkleAmp;
    col += vec3(core * starP * twink) * (0.55 + 0.45 * (1.0 - i / 3.0));
  }
  // Subtle nebula
  float n = vnoise(q * 1.4 + vec2(uTime * 0.02, 0.0));
  col += vec3(0.04, 0.02, 0.10) * smoothstep(0.5, 1.0, n);
  return col;
}

void main() {
  vec2  res = uResolution;
  // Centre-relative aspect-corrected screen coord. uCenter only carries the
  // tiny autonomous drift now — pose no longer moves the singularity.
  vec2 c = (uCenter - 0.5) * 2.0 * vec2(res.x / res.y, 1.0);
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= res.x / res.y;

  // ── Camera roll (pose-driven) ────────────────────────────────────────────
  // Apply BEFORE the centre offset and lensing so the entire scene rotates
  // around the BH centre as if the observer's head were tilted. The roll
  // is capped at ~30° max (uPoseRoll * 0.5 rad).
  float rollAng = uPoseRoll * 0.5;
  float ca = cos(rollAng), sa = sin(rollAng);
  p = mat2(ca, -sa, sa, ca) * p;

  p -= c;

  float r = length(p);

  // ── Audio + pose-proximity pulsed horizon ────────────────────────────────
  // Closer pose → bigger horizon (you've walked toward the BH). Range is
  // ±45% so coming close-up doesn't completely fill the screen.
  float r_s = uHorizon
            * (1.0 + uBands.x * 0.30 + uBeat.y * 0.40 + uPoseProximity * 0.45);
  r_s = clamp(r_s, 0.04, 0.55);

  // ── Palette ──────────────────────────────────────────────────────────────
  vec3 hot, mid, cold, lowerArcCol, auraCol;
  getPalette(uPalette, hot, mid, cold, lowerArcCol, auraCol);

  // ── Tilted disk inverse-projection ───────────────────────────────────────
  // Disk lies flat in world (y=0 plane) tilted by uDiskTilt around X axis.
  // Camera looks toward -Z. Screen y maps to world z via 1/sin(tilt).
  // tiltSin small → near edge-on → tiny pdy maps to huge pdz (thin band).
  // Observer pitch (lean back/forward) NUDGES the effective tilt so the disk
  // goes more face-on as the user looks up at it.
  float tilt    = clamp(uDiskTilt + uPosePitch * 0.35, 0.05, 1.50);
  float tiltSin = max(sin(tilt), 0.05);
  float pdz     = p.y / tiltSin;          // world-z (positive = near viewer)
  float pdr     = sqrt(p.x * p.x + pdz * pdz);
  float pdTheta = atan(pdz, p.x);

  // Disk extent in plane-space.
  float diskInner = r_s * 1.05;
  float diskOuter = r_s * 5.5;
  float diskRadial = smoothstep(diskInner, r_s * 1.30, pdr)
                   * (1.0 - smoothstep(r_s * 3.5, diskOuter, pdr));

  // ── Disk striations: flowing wisps via two octaves of fbm + a softer
  // radial banding. Earlier version used a hard 60-cycle sin which read
  // as concentric stripes; replacing the high-freq term with a low-freq
  // sin + warped fbm gives a more organic "rivers of plasma" look.
  float diskAng  = uTime * uFlowSpeed * 0.30 + uPerturb.x * 0.7;
  float radialBands = sin(pdr * 22.0 - uTime * uFlowSpeed * 1.6 + pdTheta * 5.0) * 0.5 + 0.5;
  float angularFlow = fbm(vec2(pdr * 3.5, pdTheta * 2.6 + uTime * uFlowSpeed * 0.40)) * uTurbulence;
  // Warped detail: domain-distort the second fbm by the first so strands
  // bend around each other instead of running in straight rings.
  float warpDetail  = fbm(vec2(pdr * 9.0 + angularFlow * 1.4
                               + uTime * uFlowSpeed * 0.45,
                               pdTheta * 6.0 + angularFlow * 0.9)) * 0.55;
  float streaks     = clamp(radialBands * 0.45 + angularFlow * 0.7 + warpDetail * 0.7,
                            0.0, 1.8);

  // Doppler-ish asymmetry: one side runs brighter/whiter, opposite cooler.
  // Driven by sin of plane angle so it rotates with the perturb/flow.
  float doppler = 0.5 + 0.5 * sin(pdTheta + diskAng);

  float midsBoost = 1.0 + uBands.y * 0.7;
  float diskInt   = diskRadial
                  * (0.4 + 0.7 * streaks)
                  * (0.55 + 0.6 * doppler)
                  * uDiskBrightness * midsBoost;

  // Hot inner edge — narrow band where the disk meets the horizon.
  float hotEdge = smoothstep(r_s * 1.40, diskInner, pdr)
                * smoothstep(r_s * 0.95, diskInner, pdr);

  // Disk colour fades hot → mid → cold radially. Doppler tints toward hot
  // on the approaching side.
  float tColor = clamp((pdr - diskInner) / (diskOuter - diskInner), 0.0, 1.0);
  vec3  base   = mix(mix(hot, mid, smoothstep(0.0, 0.30, tColor)),
                     cold, smoothstep(0.30, 1.0, tColor));
  vec3  diskCol = mix(base, hot, doppler * 0.30);
  diskCol += hot * hotEdge * 1.8;
  // Beat: white-hot flash mixed into disk.
  diskCol += vec3(1.0) * uBeat.y * diskRadial * 0.45;

  // ── Lensed-back arcs: multi-band wispy strands wrapping the horizon ─────
  // Real Schwarzschild BH images (and Interstellar's Gargantua) show many
  // overlapping photon paths bending the rear of the disk over and under
  // the horizon — not a single uniform arch. We render 4 top + 3 bottom
  // bands, each at its own base radius and warped by an independent noise
  // sample so the strands look like wisps of light rather than concentric
  // circles. Per-band brightness falls off outward.
  float thetaScreen = atan(p.y, p.x);
  float sT = sin(thetaScreen);
  // Tighter band spacing reads more like the Interstellar reference where
  // the wrapping arcs cluster against the silhouette instead of fanning
  // outward. Warp magnitudes scaled down proportionally so bands don't
  // smear into each other when they wiggle.
  float topArcInt = 0.0;
  float topMask   = smoothstep(-0.10, 0.65, sT);
  for (int b = 0; b < 4; b++) {
    float fb       = float(b);
    float baseR    = r_s * (1.40 + 0.13 * fb);
    // Each band wiggles independently: per-band offset + slow time scrub
    // through the noise field so the warp evolves over seconds.
    float warpX    = thetaScreen * (1.4 + fb * 0.35) + fb * 4.7;
    float warpY    = uTime * uFlowSpeed * (0.08 + fb * 0.04) + fb * 1.3;
    float warp     = vnoise(vec2(warpX, warpY)) - 0.5;
    float bandR    = baseR + warp * r_s * (0.10 + fb * 0.04);
    float bandW    = r_s * (0.020 + fb * 0.020);
    float bandRad  = exp(-pow((r - bandR) / bandW, 2.0));
    // Slow, broad angular modulation — no high-frequency sin so no
    // "comb teeth" segmenting the band.
    float modAng   = 0.55 + 0.45 * sin(thetaScreen * (2.5 + fb * 1.3)
                                       - uTime * uFlowSpeed * 0.25 + fb * 2.1);
    float bandBri  = (0.55 - fb * 0.09) * uDiskBrightness;
    topArcInt += topMask * bandRad * modAng * bandBri;
  }
  topArcInt *= (1.0 + uBands.x * 0.20);
  vec3 topArcCol = mix(mid, hot, 0.55) + hot * uBeat.y * 0.35;

  float botArcInt = 0.0;
  float botMask   = smoothstep(-0.10, 0.55, -sT);
  for (int b = 0; b < 3; b++) {
    float fb       = float(b);
    float baseR    = r_s * (1.38 + 0.14 * fb);
    float warpX    = thetaScreen * (1.2 + fb * 0.35) - fb * 3.3;
    float warpY    = uTime * uFlowSpeed * (0.07 + fb * 0.03) + fb * 0.9;
    float warp     = vnoise(vec2(warpX, warpY)) - 0.5;
    float bandR    = baseR + warp * r_s * (0.11 + fb * 0.04);
    float bandW    = r_s * (0.018 + fb * 0.020);
    float bandRad  = exp(-pow((r - bandR) / bandW, 2.0));
    float modAng   = 0.45 + 0.45 * sin(thetaScreen * (2.2 + fb * 1.1)
                                       + uTime * uFlowSpeed * 0.20 + fb * 1.5);
    float bandBri  = (0.42 - fb * 0.10) * uDiskBrightness;
    botArcInt += botMask * bandRad * modAng * bandBri;
  }
  vec3 botArcCol = mix(lowerArcCol, mid, 0.40) * 0.95;

  // ── Photon ring + secondary ring ────────────────────────────────────────
  // Both rings sit close to the silhouette in a tight cluster (1.28 + 1.45
  // r_s). They share a softer tilt with the disk — strict screen-circle
  // rings felt disconnected from the tilted disk plane, but using the
  // disk's full tilt collapses them into the silhouette at small tilts,
  // so we mix halfway. ringSin is the effective vertical compression
  // applied to the rings only; ringR is the disk-tilted radial coord.
  float ringSin = mix(1.0, tiltSin, 0.50);
  float ringPdz = p.y / max(ringSin, 0.05);
  float ringR   = sqrt(p.x * p.x + ringPdz * ringPdz);

  float photonR1 = r_s * 1.55;
  float photonW1 = r_s * 0.05 + 0.002;
  float photonR2 = r_s * 1.84;
  float photonW2 = r_s * 0.025 + 0.0015;
  float photonRing = exp(-pow((ringR - photonR1) / photonW1, 2.0))
                   + exp(-pow((ringR - photonR2) / photonW2, 2.0)) * 0.50;
  photonRing *= (1.0 + uBands.z * 1.5 + uBeat.y * 0.9);

  // ── Event-horizon halo (the "Interstellar" hot ring) ────────────────────
  // Bright band hugging the event-horizon edge — the lensed light grazing
  // the photon sphere collapses into a near-horizon glow that wraps the
  // dark disk completely. Two layers compose the look:
  //   - haloCore: a tight Gaussian centred just outside r_s, sharp and
  //     hot, fed by the disk's HOT colour stop. This is the bright
  //     line you see flush with the dark void.
  //   - haloBleed: a wider warm wash falling off outward to r_s * 1.45,
  //     gated by an inner smoothstep so it can't seep into the black
  //     region. This is the soft "energy" filling the gap between the
  //     hot ring and the disk arcs.
  // Both pulse with bass + beat, so the halo "breathes" musically.
  float haloCore   = exp(-pow((r - r_s * 1.04) / (r_s * 0.045), 2.0));
  float haloBleed  = (1.0 - smoothstep(r_s * 1.05, r_s * 1.45, r))
                   *  smoothstep(r_s * 0.985, r_s * 1.04, r);
  float haloPulse  = 1.0 + uBands.x * 0.55 + uBeat.y * 0.85;
  vec3  horizonHalo = (hot * haloCore * 1.85
                     + mix(hot, mid, 0.25) * haloBleed * 0.55) * haloPulse;

  // ── Beat shockwave: expanding annulus that fades over ~1s ───────────────
  float swR   = r_s * (1.6 + 4.5 * pow(uBeat.y, 0.6));
  float swW   = r_s * 0.18;
  float shock = exp(-pow((r - swR) / swW, 2.0)) * uBeat.y;

  // ── Inside event horizon: mostly black, with two subtle leaks ───────────
  // The dark disk is no longer pure black — Interstellar's reference
  // composites two effects that bleed inward:
  //   1. Inner halo band — a narrow ring just inside r_s, mirroring the
  //      outer horizon halo. Reads as the lensed light's "reflection"
  //      hugging the inside edge of the silhouette.
  //   2. Void bloom — soft warm wash that fades exponentially from the
  //      rim toward the centre, so the silhouette gets some atmospheric
  //      lift instead of clipping to pure #000. Uses the same bloomFake
  //      slider as the outer bloom so they scale together.
  // Front-of-disk pieces continue to occlude the horizon as before.
  if (r < r_s) {
    vec3 col = vec3(0.0);

    // 1. Inner halo band — narrow Gaussian sitting just inside the rim,
    // so the falloff begins almost immediately as you scan inward from
    // the dark edge. Centre at 0.98*r_s puts the bright pinch right
    // against the silhouette boundary; width 0.04 keeps it tight.
    float innerHalo = exp(-pow((r - r_s * 0.98) / (r_s * 0.040), 2.0));
    col += hot * innerHalo * 0.45 * uHaloIntensity
         * (1.0 + uBands.x * 0.40 + uBeat.y * 0.55);

    // 2. Void bloom — exp falloff from r_s inward. The e-folding factor
    // controls how deep the bloom penetrates (peak at the rim, dropping
    // through the silhouette toward r=0). Matched to the outside bloom's
    // RMS curve and weight so the bloom slider drives both sides at
    // comparable strength — the dark disk isn't isolated from the rest
    // of the gravitational glow.
    float voidBloom = exp(-(r_s - r) / max(r_s * 0.55, 1e-3))
                    * uBloomFake * (0.18 + uRms * 0.45);
    col += mix(hot, mid, 0.30) * voidBloom * 0.85;

    // Front-of-disk pixel — render disk piece occluding the horizon.
    if (pdz > 0.02 && diskRadial > 0.0) {
      col += diskCol * diskInt;
      col += hot * photonRing * 0.4;
    }

    outColor = vec4(col, 1.0);
    return;
  }

  // ── Outside horizon: composite layers ───────────────────────────────────
  // Background lensed starfield. Bend strength scales with uLensStrength.
  float bend   = (r_s * 1.6 * uLensStrength) / max(r - r_s * 0.7, 1e-3);
  vec2  dir    = p / max(r, 1e-4);
  vec2  lensed = p - dir * bend;

  vec3 col = starfield(lensed * 1.6);

  // Lower arc → top arc → disk → halo → ring → shock — back to front.
  // The horizon halo lands UNDER the photon ring so the photon ring's
  // hot pinch sits on top of the broader halo glow, not the other way
  // around — keeps the silhouette of the dark disk razor-sharp.
  col += botArcCol * botArcInt;
  col += topArcCol * topArcInt;
  col += diskCol * diskInt;
  col += horizonHalo * uHaloIntensity;
  col += hot * photonRing * 0.85;
  col += hot * shock * 1.5;

  // Faint gravitational aura — soft halo around the horizon.
  float aura = exp(-pow((r - r_s * 1.10) / (r_s * 0.55), 2.0))
             * 0.25 * (1.0 + uRms * 1.5);
  col += auraCol * aura;

  // Wide gravitational lensing haze — a very soft dust-coloured glow that
  // extends ~6× r_s outward, hinting at the gravity well distorting the
  // entire region. Uses warmer tone so it ties into the disk colour family.
  float haze = exp(-pow(r / (r_s * 5.5), 1.6))
             * uBloomFake * (0.10 + uRms * 0.20);
  col += mix(cold, mid, 0.45) * haze * 0.85;

  // Fake bloom — radial halo + RMS-driven global glow.
  float bloom = exp(-pow(r / (r_s * 4.0), 2.0))
              * uBloomFake * (0.18 + uRms * 0.45);
  col += hot * bloom * 0.50;
  col += mid * bloom * 0.20;

  // Subtle vignette so far edges don't get noisy.
  float v = smoothstep(1.6, 0.4, length(p));
  col *= v;

  // Mild tone curve.
  col = pow(col, vec3(0.92));
  outColor = vec4(col, 1.0);
}
`;

const PALETTES = ['gold', 'voidblue', 'inferno'];

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'gargantua_void',
  name: 'Gargantua Void',
  contextType: 'webgl2',

  params: [
    { id: 'diskTilt',       label: 'disk tilt',       type: 'range', min: 0.1, max: 1.2, step: 0.01, default: 0.55 },
    { id: 'lensStrength',   label: 'lens strength',   type: 'range', min: 0,   max: 3,   step: 0.05, default: 1.4 },
    { id: 'diskBrightness', label: 'disk brightness', type: 'range', min: 0,   max: 4,   step: 0.05, default: 2.2,
      modulators: [
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.30 },
      ] },
    { id: 'turbulence',     label: 'turbulence',      type: 'range', min: 0,   max: 2,   step: 0.05, default: 0.8 },
    { id: 'flowSpeed',      label: 'flow speed',      type: 'range', min: 0,   max: 3,   step: 0.05, default: 1.0 },
    { id: 'horizonSize',    label: 'horizon r_s',     type: 'range', min: 0.1, max: 0.6, step: 0.005, default: 0.28,
      modulators: [
        { source: 'audio.bass', mode: 'mul', amount: 0.10 },
      ] },
    { id: 'bloomFake',      label: 'bloom',           type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0 },
    { id: 'haloIntensity',  label: 'horizon halo',    type: 'range', min: 0,   max: 3,   step: 0.05, default: 1.0 },
    { id: 'poseBind',       label: 'pose binding',    type: 'toggle', default: true },
    { id: 'palette',        label: 'palette',         type: 'select', options: ['gold', 'voidblue', 'inferno'], default: 'gold' },
    { id: 'reactivity',     label: 'reactivity',      type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0 },
  ],

  presets: {
    default:         { diskTilt: 0.55, lensStrength: 1.4, diskBrightness: 2.2, turbulence: 0.8, flowSpeed: 1.0, horizonSize: 0.28, bloomFake: 1.0, haloIntensity: 1.0, poseBind: true,  palette: 'gold', reactivity: 1.0 },
    interstellarish: { diskTilt: 0.42, lensStrength: 1.7, diskBrightness: 2.6, turbulence: 0.6, flowSpeed: 0.7, horizonSize: 0.22, bloomFake: 1.2, haloIntensity: 1.6, poseBind: true,  palette: 'gold' },
    voidstar:        { diskTilt: 0.48, lensStrength: 1.8, diskBrightness: 2.4, turbulence: 0.7, flowSpeed: 0.85, horizonSize: 0.26, bloomFake: 1.3, haloIntensity: 1.3, poseBind: true,  palette: 'voidblue' },
    violent:         { diskTilt: 0.70, lensStrength: 1.2, diskBrightness: 3.2, turbulence: 1.5, flowSpeed: 2.0, horizonSize: 0.32, bloomFake: 1.6, haloIntensity: 1.4, poseBind: true,  palette: 'inferno' },
    ambient:         { diskTilt: 0.30, lensStrength: 1.0, diskBrightness: 1.5, turbulence: 0.4, flowSpeed: 0.4, horizonSize: 0.20, bloomFake: 0.7, haloIntensity: 0.7, poseBind: false, palette: 'gold' },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    let W = canvas.width, H = canvas.height;

    // Singularity centre — autonomous slow drift, never pose-driven.
    let centerX  = 0.5, centerY  = 0.5;
    // Disk-plane perturbation (autonomous; drives angular flow asymmetry).
    let perturbX = 0,   perturbY = 0;

    // Pose-perspective (smoothed). All three default to 0 = neutral observer
    // straight in front of the BH at standard distance.
    let poseProximity = 0;   // -1 (far) .. +1 (close)
    let poseRoll      = 0;   // -1 .. +1, body roll → camera roll
    let posePitch     = 0;   // -1 .. +1, head-back lean → disk face-on

    let audioRef = null;
    let scratch  = {
      time: 0,
      horizon: 0.28, lensStrength: 1.4,
      diskBrightness: 2.2, turbulence: 0.8,
      flowSpeed: 1.0, diskTilt: 0.55,
      bloomFake: 1.0, haloIntensity: 1.0, palette: 0,
    };

    function update(field) {
      const { dt, time, pose, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;

      scratch.time           = time;
      scratch.lensStrength   = params.lensStrength;
      scratch.diskBrightness = params.diskBrightness;
      scratch.turbulence     = params.turbulence;
      scratch.flowSpeed      = params.flowSpeed;
      scratch.diskTilt       = params.diskTilt;
      scratch.bloomFake      = params.bloomFake;
      scratch.haloIntensity  = params.haloIntensity ?? 1.0;
      scratch.palette        = Math.max(0, PALETTES.indexOf(params.palette));
      // params.horizonSize already includes the audio.bass modulator (see spec).
      scratch.horizon        = params.horizonSize;

      // ── Observer perspective from pose ─────────────────────────────────────
      // Pose does NOT move the singularity. It reshapes the *view*:
      //   shoulderSpan  → proximity (closer body = bigger horizon)
      //   shoulderRoll  → camera roll (lateral lean)
      //   head/shoulder → camera pitch (lean back = look up = disk face-on)
      // When `poseBind` is OFF, all three smoothly decay back to 0 so the
      // fx becomes audio-only (a fixed centred BH). The smoothing path
      // below picks up the zero targets without snapping.
      let proxTarget = 0, rollTarget = 0, pitchTarget = 0;
      if (params.poseBind && pose.people.length > 0) {
        const p0 = pose.people[0];
        const sL = p0.shoulders?.l, sR = p0.shoulders?.r, head = p0.head;
        if (sL && sR && sL.visibility > 0.4 && sR.visibility > 0.4) {
          // Shoulder span in camera-frame normalized coords. Empirically a
          // person at typical webcam distance shows ~0.20–0.30 span; closer
          // bumps it toward 0.45+, farther shrinks below 0.15. Centre on 0.25
          // and normalize to ±1 over a 0.20 swing.
          const spanX = sR.x - sL.x;
          const spanY = sR.y - sL.y;
          const span  = Math.sqrt(spanX * spanX + spanY * spanY);
          proxTarget = Math.max(-1, Math.min(1, (span - 0.25) / 0.20));

          // Shoulder roll: y-difference between right and left shoulder.
          // Right shoulder lower (positive sR.y - sL.y) reads as roll-right.
          // 5× scale so a ~0.05 difference saturates near ±0.25 roll target.
          rollTarget = Math.max(-1, Math.min(1, (sR.y - sL.y) * 5.0));

          // Pitch via head-to-shoulder vertical distance vs span. A standing
          // person has head ~0.7–1.0× span above shoulder midpoint. Leaning
          // back keeps your shoulder-span constant but moves the head
          // upward (further from shoulders in screen-y).
          if (head && head.visibility > 0.3) {
            const shoulderMidY = (sL.y + sR.y) * 0.5;
            const headToShY    = shoulderMidY - head.y;
            const ratio = headToShY / Math.max(span, 0.05);
            pitchTarget = Math.max(-1, Math.min(1, (ratio - 0.75) / 0.4));
          }
        }
      }

      // Smooth toward targets — slightly slower than other smoothing so
      // pose-driven perspective feels like a deliberate camera move, not
      // jittery pose noise.
      const kp = Math.min(1, dt * 2.5);
      poseProximity += (proxTarget  - poseProximity) * kp;
      poseRoll      += (rollTarget  - poseRoll)      * kp;
      posePitch     += (pitchTarget - posePitch)     * kp;

      // Centre + perturb: autonomous drift only.
      const tx    = 0.5 + 0.04 * Math.sin(time * 0.13);
      const ty    = 0.5 + 0.03 * Math.cos(time * 0.11);
      const pertX = 0.18 * Math.sin(time * 0.08);
      const pertY = 0.14 * Math.cos(time * 0.09);
      const k = Math.min(1, dt * 3.5);
      centerX  += (tx    - centerX)  * k;
      centerY  += (ty    - centerY)  * k;
      perturbX += (pertX - perturbX) * k;
      perturbY += (pertY - perturbY) * k;
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      gl.uniform2f(U('uResolution'),    W, H);
      gl.uniform1f(U('uTime'),          scratch.time);
      gl.uniform2f(U('uCenter'),        centerX, centerY);
      gl.uniform2f(U('uPerturb'),       perturbX, perturbY);
      gl.uniform1i(U('uPalette'),       scratch.palette);
      gl.uniform1f(U('uHorizon'),       scratch.horizon);
      gl.uniform1f(U('uLensStrength'),  scratch.lensStrength);
      gl.uniform1f(U('uDiskBrightness'), scratch.diskBrightness);
      gl.uniform1f(U('uTurbulence'),    scratch.turbulence);
      gl.uniform1f(U('uFlowSpeed'),     scratch.flowSpeed);
      gl.uniform1f(U('uDiskTilt'),      scratch.diskTilt);
      gl.uniform1f(U('uBloomFake'),     scratch.bloomFake);
      gl.uniform1f(U('uHaloIntensity'), scratch.haloIntensity);
      gl.uniform1f(U('uPoseProximity'), poseProximity);
      gl.uniform1f(U('uPoseRoll'),      poseRoll);
      gl.uniform1f(U('uPosePitch'),     posePitch);
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
