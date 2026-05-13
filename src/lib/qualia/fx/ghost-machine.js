// Ghost in the Machine — a luminous cyan apparition made of smoke, fog, and
// digital memory, breathing into humanoid form above a dark circuit-board
// substrate. Rendered as two layered passes on an aspect-aware ortho frame:
//
//   1. Fullscreen volumetric pass (heavy fragment shader)
//      ── procedural circuit board (grid, traces, pulsing nodes)
//      ── humanoid SDF (head + neck + torso + shoulders + arms + lower body),
//         softly unioned with smin, breathed by bass
//      ── curl-noise/fBm smoke field, advected outward from the body so the
//         silhouette frays into vapor instead of stopping at a hard edge
//      ── face cavity mask (eye sockets, nose ridge, mouth) carved out of
//         the head region as dark falloffs
//      ── chest vortex glow with slow radial swirl
//      ── filament threads carrying brighter cyan highlights
//      ── soft cyan→white-blue core ramp + violet accent + Reinhard tonemap
//
//   2. Particle overlay (Points, additive blend)
//      ── ~6–30k motes spawned with humanoid-biased positions
//      ── three classes: core (dense in head/chest), edge (frays outward),
//         sparks (bright, treble-reactive flickers)
//      ── per-particle curl drift driven entirely in the vertex shader so
//         the JS update path stays allocation-free
//
// Modulation map (declarative, see params below):
//   audio.bass       → breath, chestGlow            (the figure inhales)
//   audio.beatPulse  → chestGlow, circuitPulse      (machine locks on)
//   audio.mids       → coherence, flowSpeed         (body becomes fluid)
//   audio.highs      → edgeDissolve, shimmer        (face flickers, sparks)
//   audio.highsPulse → shimmer                       (treble sparkle)
//   audio.total      → density                       (overall presence)
//
// No external assets, no pose tracking — the apparition is procedural and
// breathes on its own. The shader stays heavy; maxDpr is capped at 1.25 so
// high-DPI screens don't push the fragment cost off a cliff.

import {
  Scene, OrthographicCamera, Points, Mesh, PlaneGeometry,
  BufferGeometry, BufferAttribute, ShaderMaterial,
  AdditiveBlending, Color, Vector2, Vector4,
} from 'three';
import { applyAudioUniforms, disposeObject3D } from '../three-host.js';
import { scaleAudio } from '../field.js';

const COUNT_OPTS = ['6000', '15000', '30000', '60000'];
const PALETTES   = ['cyan_spirit', 'violet_seance', 'emerald_phantom', 'white_shroud'];

// Palette is four cyan-family colors plus a violet accent for highlights.
//   bg     — circuit-board substrate base (deep navy)
//   trace  — circuit traces / faint grid (dim cyan)
//   deep   — outer ghost body fog (deep cyan)
//   bright — main ghost glow (electric cyan)
//   core   — brightest core / filament highlight (white-blue)
//   violet — rare accent in highlights / face contour
const PALETTE_COLORS = {
  cyan_spirit: {
    bg:     [0.020, 0.040, 0.075],
    trace:  [0.090, 0.420, 0.580],
    deep:   [0.050, 0.500, 0.700],
    bright: [0.260, 0.860, 0.960],
    core:   [0.850, 0.985, 1.000],
    violet: [0.420, 0.260, 1.000],
  },
  violet_seance: {
    bg:     [0.030, 0.020, 0.060],
    trace:  [0.380, 0.180, 0.620],
    deep:   [0.380, 0.220, 0.680],
    bright: [0.700, 0.450, 1.000],
    core:   [0.970, 0.870, 1.000],
    violet: [0.300, 0.700, 1.000],
  },
  emerald_phantom: {
    bg:     [0.020, 0.040, 0.040],
    trace:  [0.080, 0.520, 0.420],
    deep:   [0.050, 0.560, 0.380],
    bright: [0.300, 0.940, 0.700],
    core:   [0.870, 1.000, 0.940],
    violet: [0.350, 0.300, 1.000],
  },
  white_shroud: {
    bg:     [0.035, 0.045, 0.075],
    trace:  [0.350, 0.450, 0.560],
    deep:   [0.500, 0.620, 0.760],
    bright: [0.820, 0.900, 1.000],
    core:   [1.000, 1.000, 1.000],
    violet: [0.500, 0.420, 0.900],
  },
};

// ── Shared GLSL: hash + value noise + fBm + curl ─────────────────────────
//
// Used by both the volumetric pass and the particle vertex shader so the
// two layers move through the same flow field — particles look like they
// belong inside the fog, not pasted on top.
const NOISE_GLSL = /* glsl */`
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p) {
    float a = 0.5;
    float v = 0.0;
    mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p  = rot * p * 2.02 + 17.0;
      a *= 0.5;
    }
    return v;
  }
  // 2D curl via finite differences on a scalar fbm potential. Cheap and
  // gives the swirly, divergence-free flow the smoke needs.
  vec2 curl2(vec2 p) {
    float e = 0.06;
    float n1 = fbm(p + vec2(0.0, e));
    float n2 = fbm(p - vec2(0.0, e));
    float n3 = fbm(p + vec2(e, 0.0));
    float n4 = fbm(p - vec2(e, 0.0));
    return vec2((n1 - n2), -(n3 - n4)) / (2.0 * e);
  }
`;

// ── Volumetric pass ─────────────────────────────────────────────────────
//
// Single fullscreen quad. Fragment shader does ALL the heavy lifting:
// circuit BG, humanoid SDF, smoke field, face cavities, chest vortex,
// composite + tonemap.
const VERT_VOLUME = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG_VOLUME = /* glsl */`
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uAspect;

  uniform vec3  uBgColor;
  uniform vec3  uTraceColor;
  uniform vec3  uGhostDeep;
  uniform vec3  uGhostBright;
  uniform vec3  uGhostCore;
  uniform vec3  uViolet;

  uniform vec4  uBands;        // bass, mids, highs, total
  uniform vec2  uBeat;         // active, pulse
  uniform vec2  uMids;
  uniform vec2  uHighs;

  uniform float uDensity;
  uniform float uBreath;
  uniform float uCoherence;
  uniform float uEdgeDissolve;
  uniform float uChestGlow;
  uniform float uCircuitPulse;
  uniform float uShimmer;
  uniform float uFlowSpeed;
  uniform float uVioletGain;

  ${NOISE_GLSL}

  // Smooth-min for SDF unions. k is the blend radius — larger = puffier joints.
  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  // Soft 2D ellipse SDF (approximate; good enough for the smooth union).
  float sdEllipse(vec2 p, vec2 r) {
    float k = min(r.x, r.y);
    return (length(p / r) - 1.0) * k;
  }

  // 2D capsule SDF along segment a→b with radius r.
  float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
  }

  // Humanoid silhouette in ortho space. Compositional: a few overlapping
  // ellipses + capsules glued with smin. breathExpand inflates the torso
  // and slightly drops the shoulder line on inhale.
  float humanoidSDF(vec2 p, float breathExpand) {
    float headY = 0.58;
    float head = sdEllipse(p - vec2(0.0, headY), vec2(0.115, 0.150));

    float neck = sdEllipse(p - vec2(0.0, headY - 0.21), vec2(0.060, 0.055));

    // Torso swells slightly with breath.
    vec2  torsoR = vec2(0.245 + breathExpand * 0.030,
                        0.260 + breathExpand * 0.030);
    float torso  = sdEllipse(p - vec2(0.0, 0.08 - breathExpand * 0.010), torsoR);

    // Shoulders — rounded caps that fuse with the torso/neck.
    float shL = sdEllipse(p - vec2(-0.220, 0.235), vec2(0.115, 0.090));
    float shR = sdEllipse(p - vec2( 0.220, 0.235), vec2(0.115, 0.090));

    // Arms — vague capsules. The figure's arms are loose, almost
    // dissolving; they're more about hint than form.
    float armL = sdCapsule(p, vec2(-0.290, 0.180), vec2(-0.340, -0.180), 0.060);
    float armR = sdCapsule(p, vec2( 0.290, 0.180), vec2( 0.340, -0.180), 0.060);

    // Lower body — soft taper. We don't draw legs; the body diffuses.
    float lower = sdEllipse(p - vec2(0.0, -0.45), vec2(0.215, 0.350));

    // Glue with progressively wider smin radii toward the extremities so
    // joints look like fused fog rather than hinged limbs.
    float d = head;
    d = smin(d, neck,  0.05);
    d = smin(d, torso, 0.10);
    d = smin(d, shL,   0.11);
    d = smin(d, shR,   0.11);
    d = smin(d, armL,  0.13);
    d = smin(d, armR,  0.13);
    d = smin(d, lower, 0.22);
    return d;
  }

  // Face cavity mask. Returns a [0,1] dark amount localized to the head.
  // Eye sockets are the dominant feature, then a faint vertical nose
  // shadow and a soft horizontal mouth depression.
  float faceCavities(vec2 p, float time) {
    vec2 h = p - vec2(0.0, 0.58);

    // Sockets — slightly elongated vertically; positioned a touch above
    // head-center so the skull reads as elongated/elongated.
    vec2 eyeL = h - vec2(-0.044, 0.012);
    vec2 eyeR = h - vec2( 0.044, 0.012);
    float eyeFL = exp(-dot(eyeL * vec2(1.0, 1.35), eyeL * vec2(1.0, 1.35)) / 0.0014);
    float eyeFR = exp(-dot(eyeR * vec2(1.0, 1.35), eyeR * vec2(1.0, 1.35)) / 0.0014);
    float eyes = max(eyeFL, eyeFR);

    // Nose ridge — a slim vertical falloff, much fainter than eyes.
    vec2 nose = h - vec2(0.0, -0.032);
    float noseM = exp(-dot(nose * vec2(8.0, 1.8), nose * vec2(8.0, 1.8)));

    // Mouth — a soft horizontal oval. Breathes very subtly with time so
    // the face doesn't read as static even when the music is quiet.
    float mouthBreathe = 0.85 + 0.15 * sin(time * 0.6);
    vec2 mouth = h - vec2(0.0, -0.082);
    float mouthM = exp(-dot(mouth * vec2(2.6, 5.2 / mouthBreathe),
                            mouth * vec2(2.6, 5.2 / mouthBreathe)));

    return clamp(eyes + noseM * 0.32 + mouthM * 0.55, 0.0, 1.0);
  }

  // PCB-style background. Restrained on purpose — the ghost is the star.
  vec3 renderCircuit(vec2 uv) {
    vec3 base = uBgColor;

    // Faint cell grid for substrate depth.
    vec2 cellUv = uv * 9.0;
    vec2 g = abs(fract(cellUv) - 0.5);
    float gridLine = smoothstep(0.46, 0.50, max(g.x, g.y));

    // Horizontal traces — hashed rows, only a fraction are "live".
    float traces = 0.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);

      // Row line — only rows with seed past a threshold get a trace.
      float yLine = floor(uv.y * 14.0 + fi * 6.31);
      float ySeed = hash21(vec2(yLine, fi + 7.0));
      if (ySeed > 0.55) {
        float yPos = (yLine + 0.5) / 14.0 - 1.0;
        float thick = smoothstep(0.004, 0.0, abs(uv.y - yPos));
        // Signal pulse traveling along the trace.
        float wave = fract(uv.x * 0.45 - uTime * (0.15 + ySeed * 0.30) + fi * 0.31);
        float pulse = exp(-pow((wave - 0.5) * 5.0, 2.0));
        traces += thick * (0.20 + pulse * (0.50 + uCircuitPulse * 0.6));
      }

      // Column line — sparser.
      float xLine = floor(uv.x * 14.0 + fi * 11.7);
      float xSeed = hash21(vec2(xLine, fi + 19.0));
      if (xSeed > 0.70) {
        float xPos = (xLine + 0.5) / 14.0 - 1.0;
        float thick = smoothstep(0.004, 0.0, abs(uv.x - xPos));
        float wave = fract(uv.y * 0.45 - uTime * (0.10 + xSeed * 0.20) + fi * 0.71);
        float pulse = exp(-pow((wave - 0.5) * 5.0, 2.0));
        traces += thick * (0.15 + pulse * (0.40 + uCircuitPulse * 0.4));
      }
    }

    // Nodes — sparse bright dots that flicker like neurons.
    vec2 nodeId   = floor(uv * 12.0);
    float nodeSeed = hash21(nodeId + 31.0);
    vec2 nodeC = (nodeId + 0.5) / 12.0;
    float nodeD = length(uv - nodeC) * uAspect;
    float flicker = sin(uTime * (1.4 + nodeSeed * 3.5) + nodeSeed * 6.283) * 0.5 + 0.5;
    float node = exp(-nodeD * 80.0)
               * step(0.86, nodeSeed)
               * (0.40 + flicker * 0.60)
               * (1.0 + uBeat.y * 1.2 + uCircuitPulse * 0.5);

    vec3 col = base;
    col += uTraceColor * 0.04 * gridLine;
    col += uTraceColor * traces * 0.7;
    col += uTraceColor * node * 2.2;

    // Subtle horizontal scan haze so the substrate feels deep.
    float haze = smoothstep(0.0, 0.7, abs(uv.y)) * 0.025;
    col -= haze * uBgColor;

    // Vignette — pushes the eye to center where the apparition sits.
    float vig = 1.0 - smoothstep(0.6, 1.45, length(uv));
    col *= 0.55 + 0.45 * vig;
    return col;
  }

  void main() {
    // [-aspect, aspect] × [-1, 1]
    vec2 uv = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);

    // ── 1. Background ────────────────────────────────────────────────
    vec3 bg = renderCircuit(uv);

    // ── 2. Breathing parameters ──────────────────────────────────────
    // Slow underlying breath, amplified by bass.
    float breathPhase  = sin(uTime * 0.45) * 0.5 + 0.5;
    float breathExpand = breathPhase * (0.20 + uBreath * 1.6);

    // ── 3. Humanoid SDF + base mask ──────────────────────────────────
    float sdfBase = humanoidSDF(uv, breathExpand);
    float maskBase = smoothstep(0.06, -0.05, sdfBase);

    // ── 4. Curl-noise flow advection ─────────────────────────────────
    // Upward drift for vapor, slow horizontal phase. Outside the body
    // the flow has more authority so wisps peel off; inside, it churns
    // but stays mostly contained.
    vec2 flowP = uv * 2.2
               + vec2(uTime * 0.04, -uTime * 0.13 * uFlowSpeed);
    vec2 c = curl2(flowP);

    // Edge-dissolve magnitude grows with high-mid energy and the
    // uEdgeDissolve parameter.
    float fray = 0.045 + uEdgeDissolve * 0.080 + uHighs.x * 0.020;
    vec2  pAdv = uv + c * fray * (1.0 - maskBase * 0.55);
    float sdfAdv  = humanoidSDF(pAdv, breathExpand);
    float maskAdv = smoothstep(0.10, -0.02, sdfAdv);

    // ── 5. Volumetric smoke field ────────────────────────────────────
    // Two octaves of warped fBm: a slow churn + a faster wisp layer.
    vec2 nP1 = uv * 3.2 + c * 1.1
             + vec2(uTime * 0.03, -uTime * 0.20 * uFlowSpeed);
    float smokeA = fbm(nP1);

    vec2 nP2 = uv * 7.0 + c * 1.6
             + vec2(-uTime * 0.05, -uTime * 0.32 * uFlowSpeed);
    float smokeB = fbm(nP2);
    smokeB = pow(smokeB, 1.6);

    // Filament threads — high-freq band with a hard ridge that picks
    // out thin glowing strands.
    float fil = abs(fbm(uv * 11.0 + c * 2.2 + uTime * 0.18) - 0.50);
    fil = smoothstep(0.08, 0.0, fil);

    // ── 6. Composite density ─────────────────────────────────────────
    // Mix between the rigid SDF mask (high coherence) and the wildly
    // advected one (low coherence) so the figure firms up on beats.
    float coh = clamp(uCoherence + uBeat.y * 0.25 + uMids.x * 0.10, 0.0, 1.2);
    float mask = mix(maskAdv, maskBase, clamp(coh * 0.6, 0.0, 0.9));

    float density = mask * (0.32 + 0.55 * smokeA + 0.28 * smokeB);
    density += mask * fil * 0.55;

    // ── 7. Face cavities (subtractive, head-localized) ───────────────
    float face = faceCavities(uv, uTime);
    float headRegion = exp(-pow(length(uv - vec2(0.0, 0.58)) / 0.20, 2.0));
    // High-mids deepen the eye sockets — face "haunts" harder on snares.
    float socketDepth = 0.78 + uHighs.x * 0.18;
    density *= 1.0 - face * headRegion * socketDepth;

    // ── 8. Chest vortex ──────────────────────────────────────────────
    vec2 chestP = uv - vec2(0.0, 0.05);
    float chestR = length(chestP);
    float chestAng = atan(chestP.y, chestP.x);
    float swirl = sin(chestAng * 3.0 - uTime * 1.1 - chestR * 6.0);
    float chestField = exp(-chestR * chestR * 18.0);
    float chestGlow = chestField
                    * (0.55 + 0.45 * (swirl * 0.5 + 0.5))
                    * (0.6 + uChestGlow * 1.4 + uBeat.y * 0.6);
    chestGlow *= mask;

    // ── 9. Edge wisps outside the SDF ────────────────────────────────
    // These let the figure leak vapor into the surrounding space.
    float edgeBand = smoothstep(0.18, 0.0, sdfBase) - smoothstep(0.0, -0.10, sdfBase);
    edgeBand = max(0.0, edgeBand);
    float wisp = edgeBand * smokeB * (0.6 + uEdgeDissolve * 0.7);

    // ── 10. Color ramp ───────────────────────────────────────────────
    // Outer → mid → inner, governed by composite intensity.
    float intensity = clamp(density * (0.7 + uDensity * 0.6), 0.0, 1.3);
    vec3 colGhost = mix(uGhostDeep, uGhostBright, smoothstep(0.05, 0.55, intensity));
    colGhost = mix(colGhost, uGhostCore, smoothstep(0.60, 1.0, intensity));

    // Chest core glow — pushes toward white-blue at the heart.
    colGhost += uGhostCore * chestGlow * 0.9;

    // Filament highlight tinted slightly toward core.
    colGhost += uGhostCore * fil * mask * 0.35;

    // Outer wisps in deep cyan with a hint of violet.
    vec3 wispCol = mix(uGhostDeep, uViolet, uVioletGain * 0.35);
    colGhost += wispCol * wisp * 0.55;

    // Violet accent in the brightest interior highlights, very sparing.
    colGhost = mix(colGhost,
                   mix(colGhost, uViolet, 0.18),
                   uVioletGain * smoothstep(0.78, 1.05, intensity));

    // ── 11. Treble shimmer over the ghost mask ───────────────────────
    // High-frequency speckle on top of the smoke; intentionally faint.
    float sparkleN = hash21(floor(uv * 240.0) + floor(uTime * 18.0));
    float sparkle = step(0.985, sparkleN) * mask * uShimmer * (0.3 + uHighs.y * 0.7);
    colGhost += uGhostCore * sparkle * 0.6;

    // ── 12. Composite over BG ────────────────────────────────────────
    vec3 col = bg + colGhost * (intensity + wisp * 0.6);

    // ── 13. Soft bloom approximation + Reinhard tonemap ──────────────
    // Heavy whites are intentionally pulled back — we want luminous,
    // not blown out. Reinhard keeps highlights present without clipping.
    col *= 1.05;
    col = col / (1.0 + col * 0.34);

    // Subtle final desaturation toward black to deepen shadow regions.
    col = mix(col, col * 0.92, 1.0 - smoothstep(0.05, 0.45, length(col)));

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Particle overlay ─────────────────────────────────────────────────────
//
// Lightweight motes that drift through the same curl field. Three roles:
//   0 = core   — small, slow, bright, biased to head + chest
//   1 = edge   — slightly larger, dissolves outward over time
//   2 = spark  — tiny, treble-flickering, very short visual life
const VERT_PARTICLE = /* glsl */`
  attribute vec3  aAnchor;   // base position (humanoid-biased)
  attribute float aPhase;    // random phase
  attribute float aRole;     // 0/1/2
  attribute float aSize;     // base size

  uniform float uTime;
  uniform float uAspect;
  uniform float uFlowSpeed;
  uniform float uShimmer;
  uniform float uDensity;
  uniform vec4  uBands;
  uniform vec2  uHighs;
  uniform vec2  uBeat;
  uniform float uPointScale;
  uniform float uEdgeDissolve;
  uniform float uBreath;

  varying float vRole;
  varying float vPhase;
  varying float vAlpha;

  ${NOISE_GLSL}

  void main() {
    vRole = aRole;
    vPhase = aPhase;

    vec2 p = aAnchor.xy;

    // Slow upward drift (vapor rising).
    float drift = uTime * 0.08 * (0.6 + uFlowSpeed * 0.6);

    // Curl flow — same field the fragment shader uses, sampled at the
    // anchor so motes ride the same currents as the fog.
    vec2 flowP = p * 2.2 + vec2(uTime * 0.04, -uTime * 0.13 * uFlowSpeed);
    float e = 0.06;
    vec2 c = vec2(
      fbm(flowP + vec2(0.0, e)) - fbm(flowP - vec2(0.0, e)),
      -(fbm(flowP + vec2(e, 0.0)) - fbm(flowP - vec2(e, 0.0)))
    ) / (2.0 * e);

    // Per-mote orbit + breath sway.
    float ph = aPhase + uTime * 0.7;
    vec2 orbit = vec2(cos(ph), sin(ph * 1.3)) * 0.025;
    float breath = sin(uTime * 0.45) * (0.018 + uBreath * 0.030);

    // Spread amount scales with role: sparks fly farther, core stays put.
    float spread = mix(0.045, 0.090, step(0.5, aRole));
    spread = mix(spread, 0.140, step(1.5, aRole));

    vec2 pos = p
             + c * spread * (0.6 + uEdgeDissolve * 0.7)
             + orbit
             + vec2(0.0, breath);

    // Sparks: short visual life, sized by treble.
    float roleSpark = step(1.5, aRole);
    float sparkLife = fract(aPhase * 0.31 + uTime * 1.4);
    float sparkBoost = roleSpark * uHighs.y * (1.0 - sparkLife) * 1.6;

    vec3 world = vec3(pos, 0.0);
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;

    // Size: core small + steady, edge medium, sparks tiny but boost on hits.
    float sizeMul = 1.0 + uBands.w * 0.4 + uBeat.y * 0.3;
    float size = aSize * uPointScale * sizeMul * (0.6 + uShimmer * 0.4);
    size *= mix(1.0, 0.6 + sparkBoost * 2.0, roleSpark);
    gl_PointSize = size;

    // Alpha: core full, edge fades out at large displacement, sparks pulse.
    float disp = length(c) * spread;
    float fadeEdge = mix(1.0, 1.0 - smoothstep(0.05, 0.16, disp), step(0.5, aRole));
    float a = 0.55 + 0.35 * uDensity;
    a *= mix(1.0, fadeEdge, step(0.5, aRole));
    a *= mix(1.0, 0.4 + sparkBoost * 1.2, roleSpark);
    vAlpha = clamp(a, 0.0, 1.0);
  }
`;

const FRAG_PARTICLE = /* glsl */`
  precision highp float;
  varying float vRole;
  varying float vPhase;
  varying float vAlpha;

  uniform vec3 uGhostBright;
  uniform vec3 uGhostCore;
  uniform vec3 uGhostDeep;
  uniform vec3 uViolet;
  uniform float uVioletGain;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float fall = exp(-r2 * 9.0);

    vec3 col;
    if (vRole < 0.5) {
      // Core: bright cyan-white
      col = mix(uGhostBright, uGhostCore, 0.65);
    } else if (vRole < 1.5) {
      // Edge: deeper cyan
      col = mix(uGhostDeep, uGhostBright, 0.55);
    } else {
      // Sparks: brightest, occasional violet
      col = uGhostCore;
      col = mix(col, uViolet, uVioletGain * 0.30);
    }

    gl_FragColor = vec4(col * fall, fall * vAlpha);
  }
`;

// Generate anchor points biased to the humanoid silhouette. Particles are
// sampled from soft body regions (head, chest, shoulders, lower body) with
// different role weights — so the visual distribution matches the figure.
function generateParticles(count) {
  const aAnchor = new Float32Array(count * 3);
  const aPhase  = new Float32Array(count);
  const aRole   = new Float32Array(count);
  const aSize   = new Float32Array(count);
  const positions = new Float32Array(count * 3);

  // Body region anchors: [cx, cy, sigmaX, sigmaY, weight]
  const REGIONS = [
    [ 0.000,  0.580, 0.085, 0.130, 1.5],  // head
    [ 0.000,  0.300, 0.090, 0.080, 1.2],  // neck/upper-chest band
    [ 0.000,  0.080, 0.190, 0.180, 2.6],  // chest/torso
    [-0.220,  0.220, 0.080, 0.080, 0.9],  // shoulder L
    [ 0.220,  0.220, 0.080, 0.080, 0.9],  // shoulder R
    [-0.310, -0.020, 0.060, 0.180, 0.6],  // arm L
    [ 0.310, -0.020, 0.060, 0.180, 0.6],  // arm R
    [ 0.000, -0.380, 0.150, 0.250, 1.6],  // lower body
  ];
  let wsum = 0;
  for (const r of REGIONS) wsum += r[4];
  const cdf = new Float32Array(REGIONS.length);
  let acc = 0;
  for (let i = 0; i < REGIONS.length; i++) {
    acc += REGIONS[i][4] / wsum;
    cdf[i] = acc;
  }

  // Role splits: most particles are core/edge, a small fraction are sparks.
  const coreFrac  = 0.55;
  const edgeFrac  = 0.35;
  // sparkFrac = 0.10 (implicit)

  function gauss() {
    // Box–Muller, sample once per call.
    const u1 = Math.max(1e-6, Math.random());
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  for (let i = 0; i < count; i++) {
    const t = Math.random();
    let region = REGIONS[0];
    for (let r = 0; r < REGIONS.length; r++) {
      if (t <= cdf[r]) { region = REGIONS[r]; break; }
    }
    const [cx, cy, sx, sy] = region;
    aAnchor[i * 3 + 0] = cx + gauss() * sx;
    aAnchor[i * 3 + 1] = cy + gauss() * sy;
    aAnchor[i * 3 + 2] = 0;

    aPhase[i] = Math.random() * Math.PI * 2;

    const rRand = Math.random();
    let role, size;
    if (rRand < coreFrac) {
      role = 0;
      size = 1.0 + Math.random() * 0.8;
    } else if (rRand < coreFrac + edgeFrac) {
      role = 1;
      size = 1.2 + Math.random() * 1.4;
    } else {
      role = 2;
      size = 0.6 + Math.random() * 0.8;
    }
    aRole[i] = role;
    aSize[i] = size;
  }
  return { positions, aAnchor, aPhase, aRole, aSize };
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'ghost_machine',
  name: 'Ghost in the Machine',
  contextType: 'three',
  // Heavy fragment shader — cap DPR so 2x retina screens don't double the
  // fragment cost.
  maxDpr: 1.25,

  params: [
    { id: 'particleCount', label: 'Particles',    type: 'select', options: COUNT_OPTS, default: '15000' },
    { id: 'palette',       label: 'Palette',      type: 'select', options: PALETTES,   default: 'cyan_spirit' },

    { id: 'density',       label: 'Density',      type: 'range',  min: 0.3,  max: 2.0,  step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total', mode: 'mul', amount: 0.25 },
      ] },

    { id: 'breath',        label: 'Breath',       type: 'range',  min: 0.0,  max: 2.0,  step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass',      mode: 'mul', amount: 0.45 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.20 },
      ] },

    { id: 'coherence',     label: 'Coherence',    type: 'range',  min: 0.0,  max: 1.5,  step: 0.05, default: 0.7,
      modulators: [
        { source: 'audio.mids', mode: 'mul', amount: 0.20 },
      ] },

    { id: 'edgeDissolve',  label: 'Edge fray',    type: 'range',  min: 0.0,  max: 2.0,  step: 0.05, default: 0.8,
      modulators: [
        { source: 'audio.highs',      mode: 'mul', amount: 0.40 },
        { source: 'audio.highsPulse', mode: 'add', amount: 0.20 },
      ] },

    { id: 'chestGlow',     label: 'Chest glow',   type: 'range',  min: 0.0,  max: 2.5,  step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass',      mode: 'mul', amount: 0.60 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.40 },
      ] },

    { id: 'circuitPulse',  label: 'Circuit',      type: 'range',  min: 0.0,  max: 2.0,  step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.40 },
        { source: 'audio.highs',     mode: 'mul', amount: 0.25 },
      ] },

    { id: 'shimmer',       label: 'Shimmer',      type: 'range',  min: 0.0,  max: 2.0,  step: 0.05, default: 0.9,
      modulators: [
        { source: 'audio.highs',      mode: 'mul', amount: 0.50 },
        { source: 'audio.highsPulse', mode: 'add', amount: 0.30 },
      ] },

    { id: 'flowSpeed',     label: 'Flow speed',   type: 'range',  min: 0.2,  max: 2.5,  step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.mids', mode: 'mul', amount: 0.20 },
      ] },

    { id: 'violet',        label: 'Violet hint',  type: 'range',  min: 0.0,  max: 1.5,  step: 0.05, default: 0.4 },
    { id: 'reactivity',    label: 'reactivity',   type: 'range',  min: 0.0,  max: 2.0,  step: 0.05, default: 1.0 },
  ],

  presets: {
    apparition: { particleCount: '15000', palette: 'cyan_spirit',     density: 1.0, breath: 1.0, coherence: 0.7,  edgeDissolve: 0.8, chestGlow: 1.0, circuitPulse: 1.0, shimmer: 0.9, flowSpeed: 1.0, violet: 0.4, reactivity: 1.0 },
    seance:     { particleCount: '15000', palette: 'violet_seance',   density: 1.2, breath: 1.3, coherence: 0.4,  edgeDissolve: 1.4, chestGlow: 1.4, circuitPulse: 1.4, shimmer: 1.2, flowSpeed: 1.4, violet: 0.9, reactivity: 1.0 },
    sentinel:   { particleCount: '30000', palette: 'emerald_phantom', density: 1.1, breath: 0.7, coherence: 1.0,  edgeDissolve: 0.5, chestGlow: 0.8, circuitPulse: 1.6, shimmer: 0.7, flowSpeed: 0.7, violet: 0.2, reactivity: 1.0 },
    shroud:     { particleCount: '30000', palette: 'white_shroud',    density: 1.4, breath: 0.9, coherence: 0.9,  edgeDissolve: 0.4, chestGlow: 1.2, circuitPulse: 0.6, shimmer: 0.5, flowSpeed: 0.5, violet: 0.0, reactivity: 1.0 },
  },

  autoPhase: {
    steps: [
      { palette: 'cyan_spirit',     coherence: 0.7, edgeDissolve: 0.8, flowSpeed: 1.0, violet: 0.4 },
      { palette: 'violet_seance',   coherence: 0.4, edgeDissolve: 1.4, flowSpeed: 1.4, violet: 0.9 },
      { palette: 'emerald_phantom', coherence: 1.0, edgeDissolve: 0.5, flowSpeed: 0.7, violet: 0.2 },
      { palette: 'white_shroud',    coherence: 0.9, edgeDissolve: 0.4, flowSpeed: 0.5, violet: 0.0 },
    ],
  },

  create(canvas, { renderer }) {
    const scene = new Scene();
    const camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
    camera.position.z = 5;
    camera.lookAt(0, 0, 0);

    // Shared uniforms — colors and audio uniforms feed both materials,
    // so the particle layer breathes alongside the volumetric pass.
    const uniforms = {
      uTime:         { value: 0 },
      uAspect:       { value: 1 },

      uBgColor:      { value: new Color() },
      uTraceColor:   { value: new Color() },
      uGhostDeep:    { value: new Color() },
      uGhostBright:  { value: new Color() },
      uGhostCore:    { value: new Color() },
      uViolet:       { value: new Color() },

      uBands:        { value: new Vector4() },
      uBeat:         { value: new Vector2() },
      uMids:         { value: new Vector2() },
      uHighs:        { value: new Vector2() },
      uRms:          { value: 0 },

      uDensity:      { value: 1.0 },
      uBreath:       { value: 1.0 },
      uCoherence:    { value: 0.7 },
      uEdgeDissolve: { value: 0.8 },
      uChestGlow:    { value: 1.0 },
      uCircuitPulse: { value: 1.0 },
      uShimmer:      { value: 0.9 },
      uFlowSpeed:    { value: 1.0 },
      uVioletGain:   { value: 0.4 },

      uPointScale:   { value: 2.0 },
    };

    // Volumetric pass — fullscreen quad, rendered first (renderOrder = -1).
    const volMat = new ShaderMaterial({
      uniforms,
      vertexShader:   VERT_VOLUME,
      fragmentShader: FRAG_VOLUME,
      depthWrite: false,
      depthTest:  false,
    });
    const volMesh = new Mesh(new PlaneGeometry(2, 2), volMat);
    volMesh.renderOrder = -1;
    volMesh.frustumCulled = false;
    scene.add(volMesh);

    let points = null;
    let pGeom = null;
    let pMat = null;
    let geomKey = '';

    function rebuildParticles(count) {
      if (points) {
        scene.remove(points);
        if (pGeom) pGeom.dispose();
        if (pMat)  pMat.dispose();
        points = null; pGeom = null; pMat = null;
      }
      const a = generateParticles(count);
      pGeom = new BufferGeometry();
      // Three requires `position`; we never read it in the vert shader
      // but the buffer has to exist for the draw call.
      pGeom.setAttribute('position', new BufferAttribute(a.positions, 3));
      pGeom.setAttribute('aAnchor',  new BufferAttribute(a.aAnchor, 3));
      pGeom.setAttribute('aPhase',   new BufferAttribute(a.aPhase,  1));
      pGeom.setAttribute('aRole',    new BufferAttribute(a.aRole,   1));
      pGeom.setAttribute('aSize',    new BufferAttribute(a.aSize,   1));

      pMat = new ShaderMaterial({
        uniforms,
        vertexShader:   VERT_PARTICLE,
        fragmentShader: FRAG_PARTICLE,
        transparent: true,
        depthWrite:  false,
        depthTest:   false,
        blending:    AdditiveBlending,
      });
      points = new Points(pGeom, pMat);
      points.frustumCulled = false;
      scene.add(points);
    }

    let audioRef = null;

    function update(field) {
      const audio = scaleAudio(field.audio, field.params.reactivity);
      audioRef = audio;
      const p = field.params;

      const countStr = String(p.particleCount);
      if (countStr !== geomKey) {
        const n = parseInt(countStr, 10) || 15000;
        rebuildParticles(n);
        geomKey = countStr;
      }

      const pal = PALETTE_COLORS[p.palette] || PALETTE_COLORS.cyan_spirit;
      uniforms.uBgColor.value.fromArray(pal.bg);
      uniforms.uTraceColor.value.fromArray(pal.trace);
      uniforms.uGhostDeep.value.fromArray(pal.deep);
      uniforms.uGhostBright.value.fromArray(pal.bright);
      uniforms.uGhostCore.value.fromArray(pal.core);
      uniforms.uViolet.value.fromArray(pal.violet);

      uniforms.uTime.value         = field.time;
      uniforms.uDensity.value      = p.density;
      uniforms.uBreath.value       = p.breath;
      uniforms.uCoherence.value    = p.coherence;
      uniforms.uEdgeDissolve.value = p.edgeDissolve;
      uniforms.uChestGlow.value    = p.chestGlow;
      uniforms.uCircuitPulse.value = p.circuitPulse;
      uniforms.uShimmer.value      = p.shimmer;
      uniforms.uFlowSpeed.value    = p.flowSpeed;
      uniforms.uVioletGain.value   = p.violet;
    }

    function render() {
      if (audioRef) applyAudioUniforms(uniforms, audioRef);
      renderer.render(scene, camera);
    }

    function resize(w, h /*, dpr */) {
      const a = w / Math.max(1, h);
      camera.left = -a; camera.right = a;
      camera.top = 1;   camera.bottom = -1;
      camera.updateProjectionMatrix();
      volMesh.scale.set(a, 1, 1);
      uniforms.uAspect.value = a;
      // Scale point size with viewport height so the apparition looks the
      // same density at any window size.
      uniforms.uPointScale.value = Math.max(1.0, h / 360.0);
      renderer.setSize(w, h, false);
    }

    function dispose() {
      // Renderer is core-owned; only tear down the scene graph.
      disposeObject3D(scene);
    }

    return { resize, update, render, dispose };
  },
};
