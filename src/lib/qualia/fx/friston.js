// Friston — hierarchical Bayesian brain mapping as a voidstar séance. A
// procedural glass brain (MNI-space cortex + cerebellum + brainstem point
// shell) hosts five modes, one per research thread of Karl Friston and the
// human brain mapping canon:
//
//   spm         Statistical Parametric Mapping — voxel clusters at real MNI
//               coordinates, t-statistics painted with the classic hot (+t)
//               / cool (−t) colormaps, height-thresholded live. Each cluster
//               listens to its own FFT band (auditory→mids, V1→highs,
//               motor→beat, thalamus→bass); the default-mode nodes (mPFC,
//               PCC) are task-NEGATIVE and glow cool when the mix is loud.
//   vbm         Voxel-Based Morphometry — a gray-matter density lattice
//               (cortical ribbon + subcortical nuclei, ventricles carved
//               out) deformed by a live spatial-normalization warp; color
//               encodes the warp's log-Jacobian (contraction→cyan,
//               expansion→magenta), the actual VBM visual language.
//   dcm         Dynamic Causal Modeling — the bilinear neuronal model
//               dz/dt = (A + u·B)z + Cu integrated live over six regions,
//               with balloon-model hemodynamics giving each node a fast
//               neuronal core and a slow BOLD halo; directed edges carry
//               spike pulses at rates ∝ |A_eff · z_presynaptic|.
//   filtering   Generalized filtering / variational Laplace — a 4-level
//               predictive-coding hierarchy in generalized coordinates
//               (μ, μ′), audio entering as sensory data at the bottom;
//               ascending precision-weighted prediction errors (hot, fast)
//               and descending predictions (cool, slow) stream between
//               level rings whose glow encodes precision Π.
//   free_energy Free Energy Principle — a Gaussian-well free-energy
//               landscape F(μ) whose well depths breathe with the band
//               energies; a belief particle does damped gradient descent,
//               kicked uphill by surprise on every beat; the Laplace
//               approximation is drawn as the inverse-Hessian covariance
//               ellipse hugging the surface, and a Markov blanket ornament
//               (internal / sensory / active / external shells) orbits the
//               believer.
//
// Modulation map (declarative, see params):
//   audio.bass      → glow      (bass swells everything luminous)
//   audio.beatPulse → glow,flow (kicks flash + accelerate message passing)
//   audio.highs     → glow      (treble shimmer)
// Inline (in update(), not via the modulation engine):
//   FFT spectrum       → per-cluster t-statistics + spectral-centroid hue tilt
//   audio.beat rising  → DCM pulse volleys, free-energy surprise kicks
//   audio.rms          → SPM threshold relaxation, VBM warp gain
//   pose head.x        → camera azimuth   (smoothed — fly around the brain)
//   pose headPitch     → camera elevation (smoothed)
//   pose.shoulderSpan  → camera distance  (lean in → fly closer)
//
// World units are MNI millimetres (brain spans ~±90); the camera orbits at
// ~250mm. All dynamics are forward-Euler with dt clamped to [1/240, 1/30] —
// every system below is contractive well inside that step size.

import {
  Scene, PerspectiveCamera, Group, Points, LineSegments, LineLoop,
  BufferGeometry, BufferAttribute, DynamicDrawUsage,
  ShaderMaterial, LineBasicMaterial, AdditiveBlending,
  Color, Vector2, Vector3, Vector4,
} from 'three';
import { applyAudioUniforms, disposeObject3D } from '../three-host.js';
import { scaleAudio } from '../field.js';

const MODES   = ['spm', 'vbm', 'dcm', 'filtering', 'free_energy'];
const DETAILS = ['low', 'medium', 'high'];
const SCHEMES_KEYS = ['voidstar', 'clinical', 'synaptic', 'phantom'];

// Color roles per scheme: shell = glass brain, wire = edges/predictions/cool
// structure, pulse = synaptic/travelling energy, err = prediction errors /
// beats / surprise, deep = low-value fill. SPM's hot/cool t-map colors are
// fixed in-shader (they're the scientific convention, not a vibe).
const SCHEMES = {
  voidstar: { shell: [0.30, 0.55, 1.00], wire: [0.40, 0.94, 1.00], pulse: [1.00, 0.48, 0.90], err: [1.00, 0.72, 0.30], deep: [0.10, 0.06, 0.30] },
  clinical: { shell: [0.55, 0.70, 0.90], wire: [0.60, 0.80, 1.00], pulse: [1.00, 0.85, 0.55], err: [1.00, 0.45, 0.25], deep: [0.07, 0.11, 0.20] },
  synaptic: { shell: [0.30, 1.00, 0.70], wire: [0.55, 1.00, 0.75], pulse: [0.85, 1.00, 0.40], err: [1.00, 0.55, 0.20], deep: [0.03, 0.15, 0.10] },
  phantom:  { shell: [0.75, 0.85, 1.00], wire: [0.70, 0.85, 1.00], pulse: [0.85, 0.75, 1.00], err: [1.00, 0.55, 0.75], deep: [0.09, 0.11, 0.22] },
};

// ─── glass brain geometry (MNI axes: x L−/R+, y post−/ant+, z inf−/sup+) ──

function sstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Cortical radius along unit direction d — base ellipsoid support shaped by
// the longitudinal fissure, flattened ventral surface, temporal-lobe bulges,
// orbital-frontal taper and sulcal band-noise (±≈4mm gyri wrinkle).
const TMP_L = { x: -0.80, y: -0.15, z: -0.45 };
const TMP_R = { x:  0.80, y: -0.15, z: -0.45 };
(function normTmp() {
  for (const t of [TMP_L, TMP_R]) {
    const n = Math.hypot(t.x, t.y, t.z);
    t.x /= n; t.y /= n; t.z /= n;
  }
})();

function gyriNoise(x, y, z) {
  return 2.6 * Math.sin(11 * x + 17 * y)
       + 2.2 * Math.sin(13 * y + 9 * z + 1.7)
       + 1.9 * Math.sin(15 * z + 12 * x + 4.1)
       + 1.4 * Math.sin(21 * x * y + 8 * z)
       + 1.1 * Math.sin(19 * y * z + 14 * x + 2.3);
}

function cortexRadius(x, y, z) {
  const r0 = 1 / Math.sqrt((x * x) / (68 * 68) + (y * y) / (86 * 86) + (z * z) / (58 * 58));
  const fissure = -9 * Math.exp(-(x / 0.10) * (x / 0.10)) * sstep(0.15, 0.65, z);
  const ventral = -10 * sstep(-0.25, -0.85, z) * sstep(0.5, -0.2, Math.abs(y));
  const dl = (x - TMP_L.x) ** 2 + (y - TMP_L.y) ** 2 + (z - TMP_L.z) ** 2;
  const dr = (x - TMP_R.x) ** 2 + (y - TMP_R.y) ** 2 + (z - TMP_R.z) ** 2;
  const s2 = 2 * 0.28 * 0.28;
  const temporal = 7 * (Math.exp(-dl / s2) + Math.exp(-dr / s2));
  const frontal = -6 * sstep(0.6, 0.95, y) * sstep(0.1, -0.4, z);
  return r0 + fissure + ventral + temporal + frontal + gyriNoise(x, y, z);
}

// Cerebellum: ellipsoid at (0,−72,−38), half-extents (48,30,26), with fine
// horizontal foliation ridges. Brainstem: 9mm capsule, tilted posteriorly.
const CBL_C = { x: 0, y: -72, z: -38 };
const CBL_H = { x: 48, y: 30, z: 26 };
const STEM_A = { x: 0, y: -30, z: -18 };
const STEM_B = { x: 0, y: -38, z: -58 };

function cerebellumRho(p) {
  const lx = (p.x - CBL_C.x) / CBL_H.x;
  const ly = (p.y - CBL_C.y) / CBL_H.y;
  const lz = (p.z - CBL_C.z) / CBL_H.z;
  return Math.hypot(lx, ly, lz);
}

/** Signed cortical depth (mm under the nearest surface); >0 means inside. */
function depthUnder(p) {
  const r = Math.hypot(p.x, p.y, p.z);
  let d = -1e3;
  if (r > 1e-4) {
    d = cortexRadius(p.x / r, p.y / r, p.z / r) - r;
  } else {
    d = 60;
  }
  const rho = cerebellumRho(p);
  const dCbl = (1 - rho) * 27;         // ≈ mm inside the cerebellar ellipsoid
  return Math.max(d, dCbl);
}

/** Gray-matter density for VBM (cortical ribbon + nuclei − ventricles). */
function grayMatter(p) {
  const depth = depthUnder(p);
  if (depth < 0.5) return 0;
  const inCbl = cerebellumRho(p) < 1;
  let gm;
  if (inCbl && depth < 8) {
    gm = 1.1 * sstep(0.8, 2.0, depth) * (1 - sstep(3.0, 5.5, depth));
  } else {
    const ribbon = sstep(1.5, 3.0, depth) * (1 - sstep(5.0, 8.0, depth));
    const white  = 0.22 * sstep(8.0, 14.0, depth);
    gm = ribbon + white;
  }
  // Subcortical gray nuclei (thalami, amygdalae, putamina).
  const nuclei = [
    [-10.5, -18.5, 7.5, 8, 0.75], [10.5, -18.5, 7.5, 8, 0.75],
    [-23, -5, -19, 6, 0.65],      [23, -5, -19, 6, 0.65],
    [-24, 2, 0, 8, 0.55],         [24, 2, 0, 8, 0.55],
  ];
  for (const [nx, ny, nz, sg, amp] of nuclei) {
    const d2 = (p.x - nx) ** 2 + (p.y - ny) ** 2 + (p.z - nz) ** 2;
    gm += amp * Math.exp(-d2 / (2 * sg * sg));
  }
  // Lateral ventricles carve to zero.
  for (const vx of [-16, 16]) {
    const lx = (p.x - vx) / 9, ly = (p.y + 28) / 32, lz = (p.z - 12) / 11;
    if (lx * lx + ly * ly + lz * lz < 1) return 0;
  }
  return Math.min(1, gm);
}

/** Build the glass-brain shell point cloud (cortex + cerebellum + stem). */
function buildShell(count) {
  const nCtx  = Math.floor(count * 0.75);
  const nCbl  = Math.floor(count * 0.21);
  const nStem = count - nCtx - nCbl;
  const positions = new Float32Array(count * 3);
  const aShade    = new Float32Array(count);
  let w = 0;
  // Cortex — sample directions, bias density toward sulci for shading.
  let guard = 0;
  while (w < nCtx && guard++ < nCtx * 30) {
    let x = Math.random() * 2 - 1, y = Math.random() * 2 - 1, z = Math.random() * 2 - 1;
    const n = Math.hypot(x, y, z);
    if (n < 1e-4 || n > 1) continue;
    x /= n; y /= n; z /= n;
    const g = gyriNoise(x, y, z);
    // Keep gyral crowns slightly denser than sulcal floors.
    if (Math.random() > 0.55 + 0.08 * g) continue;
    const r = cortexRadius(x, y, z);
    if (r < 20) continue;
    positions[w * 3]     = x * r;
    positions[w * 3 + 1] = y * r;
    positions[w * 3 + 2] = z * r;
    aShade[w] = Math.min(1, Math.max(0, 0.5 + g * 0.12));
    w++;
  }
  // Cerebellum — surface of its ellipsoid with foliation ridge shading.
  for (let i = 0; i < nCbl; i++, w++) {
    let x = Math.random() * 2 - 1, y = Math.random() * 2 - 1, z = Math.random() * 2 - 1;
    const n = Math.hypot(x, y, z) || 1;
    x /= n; y /= n; z /= n;
    const fol = 1.8 * Math.sin(26 * Math.asin(Math.min(1, Math.max(-1, z))));
    positions[w * 3]     = CBL_C.x + x * (CBL_H.x + fol);
    positions[w * 3 + 1] = CBL_C.y + y * (CBL_H.y + fol);
    positions[w * 3 + 2] = CBL_C.z + z * (CBL_H.z + fol);
    aShade[w] = 0.5 + 0.28 * Math.sin(26 * Math.asin(Math.min(1, Math.max(-1, z))));
  }
  // Brainstem capsule.
  for (let i = 0; i < nStem; i++, w++) {
    const t = Math.random();
    const ang = Math.random() * Math.PI * 2;
    const rr = 9 * Math.sqrt(Math.random());
    positions[w * 3]     = STEM_A.x + (STEM_B.x - STEM_A.x) * t + Math.cos(ang) * rr;
    positions[w * 3 + 1] = STEM_A.y + (STEM_B.y - STEM_A.y) * t + Math.sin(ang) * rr * 0.6;
    positions[w * 3 + 2] = STEM_A.z + (STEM_B.z - STEM_A.z) * t;
    aShade[w] = 0.45;
  }
  return { positions: positions.subarray(0, w * 3), aShade: aShade.subarray(0, w) };
}

// ─── SPM clusters — real MNI coordinates, σ in mm ────────────────────────
// band: which audio channel drives the cluster's t-statistic.
//   'mids' | 'highs' | 'bass' | 'beat' | 'total'
// sign −1 marks task-negative (default-mode) regions → cool colormap when
// the mix is loud. bin = [lo,hi) fraction of the FFT array for spectrum-
// driven activation (fallback to the named band when audio is off).
const CLUSTERS = [
  { name: 'A1 L',    p: [-42, -22,  7], sigma:  9, band: 'mids',  sign:  1, bin: [0.055, 0.16] },
  { name: 'A1 R',    p: [ 46, -18,  8], sigma:  9, band: 'mids',  sign:  1, bin: [0.07, 0.19] },
  { name: 'STS L',   p: [-56, -40,  4], sigma:  8, band: 'mids',  sign:  1, bin: [0.10, 0.26] },
  { name: 'STS R',   p: [ 56, -40,  4], sigma:  8, band: 'mids',  sign:  1, bin: [0.12, 0.30] },
  { name: 'V1 L',    p: [ -8, -92,  2], sigma: 10, band: 'highs', sign:  1, bin: [0.28, 0.55] },
  { name: 'V1 R',    p: [ 10, -90,  0], sigma: 10, band: 'highs', sign:  1, bin: [0.32, 0.60] },
  { name: 'M1 L',    p: [-38, -22, 56], sigma:  8, band: 'beat',  sign:  1, bin: [0.0, 0.03] },
  { name: 'M1 R',    p: [ 40, -20, 54], sigma:  8, band: 'beat',  sign:  1, bin: [0.0, 0.03] },
  { name: 'SMA',     p: [  0,  -4, 58], sigma:  8, band: 'beat',  sign:  1, bin: [0.0, 0.04] },
  { name: 'Thal L',  p: [-10, -19,  7], sigma:  7, band: 'bass',  sign:  1, bin: [0.0, 0.045] },
  { name: 'Thal R',  p: [ 11, -18,  8], sigma:  7, band: 'bass',  sign:  1, bin: [0.0, 0.045] },
  { name: 'Amy L',   p: [-23,  -5,-19], sigma:  6, band: 'bass',  sign:  1, bin: [0.01, 0.06] },
  { name: 'Amy R',   p: [ 23,  -5,-19], sigma:  6, band: 'bass',  sign:  1, bin: [0.01, 0.06] },
  { name: 'Cbl VI L', p: [-26, -62,-30], sigma: 11, band: 'beat', sign:  1, bin: [0.0, 0.05] },
  { name: 'Cbl VI R', p: [ 26, -62,-30], sigma: 11, band: 'beat', sign:  1, bin: [0.0, 0.05] },
  // Default-mode network — deactivates under load (task-negative).
  { name: 'mPFC',    p: [  0,  52, -2], sigma: 10, band: 'total', sign: -1, bin: [0.0, 0.5] },
  { name: 'PCC',     p: [  0, -52, 26], sigma: 10, band: 'total', sign: -1, bin: [0.0, 0.5] },
];
const MAX_CLUSTERS = 17;

function gauss() {
  // Box–Muller, one sample (throwaway second).
  const u = Math.max(1e-9, Math.random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * Math.random());
}

function buildClusters(perCluster) {
  const total = CLUSTERS.length * perCluster;
  const positions = new Float32Array(total * 3);
  const aCluster  = new Float32Array(total);
  const aFall     = new Float32Array(total);
  const aSeed     = new Float32Array(total);
  let w = 0;
  CLUSTERS.forEach((c, k) => {
    for (let i = 0; i < perCluster; i++, w++) {
      const ox = gauss() * c.sigma, oy = gauss() * c.sigma, oz = gauss() * c.sigma;
      positions[w * 3]     = c.p[0] + ox;
      positions[w * 3 + 1] = c.p[1] + oy;
      positions[w * 3 + 2] = c.p[2] + oz;
      const r2 = ox * ox + oy * oy + oz * oz;
      aFall[w] = Math.exp(-r2 / (2 * c.sigma * c.sigma));
      aCluster[w] = k;
      aSeed[w] = Math.random();
    }
  });
  return { positions, aCluster, aFall, aSeed };
}

// ─── VBM voxel lattice + warp basis ──────────────────────────────────────
function buildVoxels(spacing) {
  const est = (Math.floor(140 / spacing) + 1)
            * (Math.floor(178 / spacing) + 1)
            * (Math.floor(142 / spacing) + 1);
  const positions = new Float32Array(est * 3);
  const aDensity  = new Float32Array(est);
  const aSeed     = new Float32Array(est);
  const p = { x: 0, y: 0, z: 0 };
  let w = 0;
  for (let x = -70; x <= 70; x += spacing) {
    for (let y = -104; y <= 74; y += spacing) {
      for (let z = -66; z <= 76; z += spacing) {
        p.x = x; p.y = y; p.z = z;
        const gm = grayMatter(p);
        if (gm < 0.06 || w >= est) continue;
        positions[w * 3] = x; positions[w * 3 + 1] = y; positions[w * 3 + 2] = z;
        aDensity[w] = gm;
        aSeed[w] = Math.random();
        w++;
      }
    }
  }
  return {
    positions: positions.subarray(0, w * 3),
    aDensity:  aDensity.subarray(0, w),
    aSeed:     aSeed.subarray(0, w),
  };
}

// Six sinusoidal warp bases u(p,t) = Σ A_i sin(k_i·p + φ_i) e_i. Global
// gain stays ≤ ~0.7 so det J > 0 (no folds) — φ advances each frame.
const TAU = Math.PI * 2;
const WARPS = [
  { A: 3.0, k: [TAU / 140 * 1.0, TAU / 140 * 0.2, 0],           w: 0.20, e: [1, 0, 0] },
  { A: 3.0, k: [0, TAU / 120 * 1.0, TAU / 120 * 0.3],           w: 0.26, e: [0, 1, 0] },
  { A: 2.5, k: [TAU / 110 * 0.2, 0, TAU / 110 * 1.0],           w: 0.33, e: [0, 0, 1] },
  { A: 2.0, k: [TAU / 90 * 0.7, TAU / 90 * 0.7, 0],             w: 0.41, e: [0, 0.6, 0.8] },
  { A: 2.0, k: [0, TAU / 90 * 0.7, -TAU / 90 * 0.7],            w: 0.15, e: [0.8, 0, 0.6] },
  { A: 1.5, k: [TAU / 80 * 0.6, -TAU / 80 * 0.6, TAU / 80 * 0.5], w: 0.52, e: [0.6, 0.8, 0] },
];

// ─── DCM — bilinear model over six regions ───────────────────────────────
// Order: A1L, A1R, V1, mPFC, PCC, Thal. Row = target, col = source.
// Off-diagonals ×0.7 at init → strict diagonal dominance → stable.
const DCM_POS = [
  [-42, -22, 7], [46, -18, 8], [0, -91, 1], [0, 52, -2], [0, -52, 26], [0, -18, 8],
];
const DCM_A = [
  [-0.50, 0.15, 0,    0,    0,    0.35],
  [ 0.15, -0.50, 0,   0,    0,    0.35],
  [ 0,    0,   -0.50, 0,    0.10, 0.30],
  [ 0.20, 0.20, 0,   -0.50, 0.25, 0   ],
  [ 0.10, 0.10, 0.15, 0.25, -0.50, 0.10],
  [ 0.10, 0.10, 0.10, 0.15, 0,   -0.50],
];
// B: mids gate A1→mPFC and mPFC→PCC (attention modulates the forward sweep).
const DCM_B = [[3, 0, 0.25], [3, 1, 0.25], [4, 3, 0.20]];
// C: where audio enters — thalamus hard, A1 direct, V1 mild.
const DCM_C = [0.3, 0.3, 0.15, 0, 0, 0.8];
const N_DCM = 6;

// ─── generalized filtering hierarchy ─────────────────────────────────────
const RING_Y = [-60, -15, 30, 75];
const RING_R = [70, 55, 42, 30];
const PI_BASE = [8, 4, 2, 1];
const GF_K = 4.0, GF_BETA = 0.9;

// ─── free-energy landscape ───────────────────────────────────────────────
const WELLS = [
  { c: [-1.5, -1.2], sigma: 0.65, band: 0 },   // bass
  { c: [ 1.4, -1.5], sigma: 0.55, band: 1 },   // mids
  { c: [-1.2,  1.5], sigma: 0.70, band: 2 },   // highs
  { c: [ 1.3,  1.2], sigma: 0.60, band: 3 },   // rms
];
const FE_SCALE = 26;      // μ-space → world mm
const FE_YSCALE = 22;
const FE_YBASE = 8;

// ─── shaders ─────────────────────────────────────────────────────────────
const SOFT_FRAG_HEAD = /* glsl */`
  precision highp float;
  vec4 soft(vec3 col, float alpha) {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float falloff = exp(-r2 * 12.0);
    return vec4(col * falloff, falloff * alpha);
  }
`;

const SHELL_VERT = /* glsl */`
  attribute float aShade;
  varying float vShade;
  uniform float uPointSize;
  uniform vec4  uBands;
  void main() {
    vShade = aShade;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPointSize * (1.0 + uBands.x * 0.15) * (700.0 / max(1.0, -mv.z));
  }
`;
const SHELL_FRAG = /* glsl */`
  ${SOFT_FRAG_HEAD}
  varying float vShade;
  uniform vec3  uShell;
  uniform float uDim;
  uniform float uFade;
  uniform float uTilt;    // spectral centroid 0..1 → warm↔cool hue tilt
  uniform vec2  uBeat;
  void main() {
    vec3 tint = mix(vec3(1.06, 0.98, 0.90), vec3(0.90, 1.00, 1.12), uTilt);
    vec3 col = uShell * tint * (0.40 + vShade * 0.45) * (1.0 + uBeat.y * 0.25);
    gl_FragColor = soft(col * uDim * uFade, 0.26 * uDim * uFade);
  }
`;

const CLUSTER_VERT = /* glsl */`
  attribute float aCluster;
  attribute float aFall;
  attribute float aSeed;
  varying float vT;       // signed t at this voxel, / 8
  varying float vSeed;
  uniform float uAct[${MAX_CLUSTERS}];   // signed cluster t (±8)
  uniform float uThreshT;                // height threshold, t units
  uniform float uPointSize;
  uniform vec2  uBeat;
  void main() {
    float t = uAct[int(aCluster + 0.5)] * aFall;
    vT = t / 8.0;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Sub-threshold voxels are clipped out entirely (a 0-size point can
    // still rasterize 1px on some drivers).
    if (abs(t) < uThreshT) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    float sz = (2.6 + 4.5 * abs(vT)) * (1.0 + 0.6 * uBeat.y);
    gl_PointSize = uPointSize * sz * (700.0 / max(1.0, -mv.z));
  }
`;
const CLUSTER_FRAG = /* glsl */`
  ${SOFT_FRAG_HEAD}
  varying float vT;
  varying float vSeed;
  uniform float uGlow;
  uniform float uFade;
  uniform float uTime;
  uniform vec2  uHighs;
  void main() {
    float a = clamp(abs(vT), 0.0, 1.0);
    // SPM hot (+t) / cool (−t) colormaps — the convention, not a palette.
    vec3 hot  = vec3(min(1.0, a * 3.0), clamp(a * 3.0 - 1.0, 0.0, 1.0), clamp(a * 3.0 - 2.0, 0.0, 1.0) * 0.9);
    vec3 cool = mix(vec3(0.05, 0.12, 0.65), vec3(0.45, 1.00, 1.00), a);
    vec3 col = vT >= 0.0 ? hot : cool;
    float shimmer = 0.85 + 0.3 * sin(uTime * (5.0 + vSeed * 9.0) + vSeed * 40.0) * uHighs.y;
    gl_FragColor = soft(col * uGlow * shimmer * uFade, 0.75 * uFade);
  }
`;

const VOXEL_VERT = /* glsl */`
  attribute float aDensity;
  attribute float aSeed;
  varying float vJ;
  varying float vDen;
  varying float vSeed;
  uniform vec4  uWarpK[6];   // k.xyz, phase
  uniform vec4  uWarpD[6];   // e.xyz, amplitude
  uniform float uWarpGain;
  uniform float uFloor;
  uniform float uPointSize;
  void main() {
    vec3 disp = vec3(0.0);
    float lj = 0.0;
    for (int i = 0; i < 6; i++) {
      float s = dot(uWarpK[i].xyz, position) + uWarpK[i].w;
      disp += uWarpD[i].xyz * (uWarpD[i].w * sin(s));
      lj   += uWarpD[i].w * dot(uWarpK[i].xyz, uWarpD[i].xyz) * cos(s);
    }
    vec3 p = position + uWarpGain * disp;
    vJ = uWarpGain * lj;
    vDen = aDensity;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    if (aDensity < uFloor) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = uPointSize * (1.0 + 2.0 * aDensity) * exp(0.5 * vJ) * (700.0 / max(1.0, -mv.z));
  }
`;
const VOXEL_FRAG = /* glsl */`
  ${SOFT_FRAG_HEAD}
  varying float vJ;
  varying float vDen;
  varying float vSeed;
  uniform vec3  uWire;
  uniform vec3  uPulse;
  uniform float uGlow;
  uniform float uFade;
  uniform float uTime;
  uniform float uSparkle;
  void main() {
    // log-Jacobian colormap: contraction → cyan/wire, expansion → magenta/pulse.
    vec3 col = mix(uWire, uPulse, smoothstep(-0.3, 0.3, vJ)) * (0.25 + 0.85 * vDen);
    float spark = step(0.97, fract(vSeed * 91.7 + floor(uTime * 9.0) * 0.618)) * uSparkle;
    gl_FragColor = soft(col * uGlow * exp(0.6 * vJ) * (1.0 + spark), 0.45 * uFade);
  }
`;

const NODE_VERT = /* glsl */`
  attribute float aNode;
  attribute float aRole;    // 0 = neuronal core, 1 = BOLD halo
  varying float vRole;
  varying float vAct;
  uniform float uNodeZ[${N_DCM}];   // |neuronal state|
  uniform float uNodeH[${N_DCM}];   // BOLD signal 0..1
  uniform float uPointSize;
  void main() {
    int i = int(aNode + 0.5);
    vRole = aRole;
    vAct = aRole < 0.5 ? uNodeZ[i] : uNodeH[i];
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float sz = aRole < 0.5 ? (6.0 + 10.0 * vAct) : (14.0 + 22.0 * vAct);
    gl_PointSize = uPointSize * sz * (700.0 / max(1.0, -mv.z));
  }
`;
const NODE_FRAG = /* glsl */`
  ${SOFT_FRAG_HEAD}
  varying float vRole;
  varying float vAct;
  uniform vec3  uErr;
  uniform vec3  uWire;
  uniform float uGlow;
  uniform float uFade;
  void main() {
    vec3 col; float alpha;
    if (vRole < 0.5) {
      col = mix(uErr, vec3(1.0), clamp(vAct * 0.4, 0.0, 0.55)) * (0.5 + vAct);
      alpha = 0.85;
    } else {
      col = uWire * (0.25 + 0.8 * vAct);
      alpha = 0.30;
    }
    gl_FragColor = soft(col * uGlow * uFade, alpha * uFade);
  }
`;

const MAX_EDGE_U = 24;
const EDGE_VERT = /* glsl */`
  attribute float aEdge;
  attribute float aT;
  attribute float aMod;    // 1 if B-modulated (context-gated) connection
  varying float vAct;
  varying float vT;
  varying float vMod;
  uniform float uEdgeAct[${MAX_EDGE_U}];
  void main() {
    vAct = uEdgeAct[int(aEdge + 0.5)];
    vT = aT;
    vMod = aMod;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const EDGE_FRAG = /* glsl */`
  precision highp float;
  varying float vAct;
  varying float vT;
  varying float vMod;
  uniform vec3  uWire;
  uniform vec3  uPulse;
  uniform float uFlowPhase;
  uniform float uThresh;
  uniform float uFade;
  void main() {
    float act = vAct;
    if (act < uThresh) discard;
    // Directed flow shimmer, source → target.
    float flow = 0.75 + 0.45 * sin(vT * 22.0 - uFlowPhase * 7.0);
    vec3 col = mix(uWire, uPulse, vMod * 0.7);
    float alpha = (0.14 + 0.5 * act) * flow * uFade;
    gl_FragColor = vec4(col * alpha, alpha);
  }
`;

const PULSE_VERT = /* glsl */`
  attribute float aLife;
  attribute float aKind;
  varying float vLife;
  varying float vKind;
  uniform float uPointSize;
  void main() {
    vLife = aLife;
    vKind = aKind;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    if (aLife < 0.01) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = uPointSize * (2.2 + 3.5 * aLife) * (700.0 / max(1.0, -mv.z));
  }
`;
const PULSE_FRAG = /* glsl */`
  ${SOFT_FRAG_HEAD}
  varying float vLife;
  varying float vKind;
  uniform vec3 uKind0;   // predictions (cool)
  uniform vec3 uKind1;   // prediction errors (hot)
  uniform vec3 uKind2;   // synaptic pulses
  uniform float uGlow;
  uniform float uFade;
  void main() {
    vec3 col = vKind < 0.5 ? uKind0 : (vKind < 1.5 ? uKind1 : (vKind < 2.5 ? uKind2 : vec3(1.0)));
    gl_FragColor = soft(col * uGlow * (0.4 + vLife), 0.8 * vLife * uFade);
  }
`;

const RING_VERT = /* glsl */`
  attribute float aRing;
  attribute float aAng;
  attribute float aSeed;
  varying float vXi;
  varying float vRing;
  uniform float uMu[4];
  uniform float uPi[4];
  uniform float uXi[4];
  uniform float uRingY[4];
  uniform float uRingR[4];
  uniform float uTime;
  uniform float uPointSize;
  void main() {
    int ri = int(aRing + 0.5);
    float mu = uMu[ri];
    float xi = uXi[ri];
    vXi = xi;
    vRing = aRing;
    float dir = mod(aRing, 2.0) < 0.5 ? 1.0 : -1.0;
    float ang = aAng + uTime * dir * 0.12;
    // Belief deforms the ring radius; error makes it tremble.
    float wob = sin(aAng * 6.0 + uTime * (1.5 + aRing * 0.4)) * 2.0 * min(1.5, abs(xi));
    float r = uRingR[ri] * (1.0 + 0.15 * tanh(mu)) + wob;
    vec3 p = vec3(cos(ang) * r, uRingY[ri], sin(ang) * r);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Precision Π = glow thickness (log-scaled).
    float sz = 1.5 + 2.5 * log2(1.0 + uPi[ri]) + aSeed;
    gl_PointSize = uPointSize * sz * (700.0 / max(1.0, -mv.z));
  }
`;
const RING_FRAG = /* glsl */`
  ${SOFT_FRAG_HEAD}
  varying float vXi;
  varying float vRing;
  uniform vec3  uWire;
  uniform vec3  uErr;
  uniform float uGlow;
  uniform float uFade;
  void main() {
    vec3 col = mix(uWire, uErr, clamp(abs(vXi) * 0.5, 0.0, 1.0));
    gl_FragColor = soft(col * uGlow * (0.5 + 0.15 * vRing), 0.55 * uFade);
  }
`;

const FIELD_VERT = /* glsl */`
  attribute float aSeed;
  varying float vF;
  varying float vHalo;
  varying float vSeed;
  uniform vec4  uWells[4];    // (cx, cz, sigma, depth) in μ-space
  uniform vec2  uMuPos;       // belief particle in μ-space
  uniform float uTime;
  void main() {
    vec2 mu = position.xz / ${FE_SCALE.toFixed(1)};
    float F = 0.04 * dot(mu, mu);
    for (int i = 0; i < 4; i++) {
      vec2 d = mu - uWells[i].xy;
      float s = uWells[i].z;
      F -= uWells[i].w * exp(-dot(d, d) / (2.0 * s * s));
    }
    float y = ${FE_YBASE.toFixed(1)} + ${FE_YSCALE.toFixed(1)} * F;
    vF = clamp((F + 1.6) / 2.2, 0.0, 1.0);
    vec2 dp = mu - uMuPos;
    vHalo = exp(-dot(dp, dp) * 2.5);
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position.x, y, position.z, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const FIELD_FRAG = /* glsl */`
  precision highp float;
  varying float vF;
  varying float vHalo;
  varying float vSeed;
  uniform vec3  uPulse;
  uniform vec3  uDeep;
  uniform vec3  uWire;
  uniform float uGlow;
  uniform float uFade;
  uniform vec2  uHighs;
  void main() {
    // Deep wells glow (attracting states); the rim recedes into the void.
    vec3 col = mix(uPulse, uDeep * 2.2, vF);
    col += uWire * vHalo * 0.8;
    col *= 1.0 + uHighs.y * vHalo * 0.9;
    float alpha = (0.14 + 0.38 * (1.0 - vF) + 0.35 * vHalo) * uFade;
    gl_FragColor = vec4(col * uGlow * alpha, alpha);
  }
`;

const ORBIT_VERT = /* glsl */`
  attribute vec3 aA;
  attribute vec3 aB;
  attribute vec3 aOrb;     // radius, angular speed, phase
  attribute float aShell;  // 0 internal, 1 sensory, 2 active, 3 external
  varying float vShell;
  uniform vec3  uCenter;
  uniform vec3  uExtCenter;
  uniform float uTime;
  uniform float uPointSize;
  void main() {
    vShell = aShell;
    float th = aOrb.z + uTime * aOrb.y;
    vec3 c = aShell > 2.5 ? uExtCenter : uCenter;
    vec3 p = c + (aA * cos(th) + aB * sin(th)) * aOrb.x;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPointSize * (aShell > 2.5 ? 1.6 : 2.6) * (700.0 / max(1.0, -mv.z));
  }
`;
const ORBIT_FRAG = /* glsl */`
  ${SOFT_FRAG_HEAD}
  varying float vShell;
  uniform vec3  uWire;
  uniform vec3  uErr;
  uniform vec3  uPulse;
  uniform vec3  uDeep;
  uniform float uRms;
  uniform vec2  uBeat;
  uniform float uGlow;
  uniform float uFade;
  void main() {
    vec3 col; float b;
    if (vShell < 0.5)      { col = uPulse; b = 0.9; }                       // internal
    else if (vShell < 1.5) { col = uWire;  b = 0.45 + 1.2 * uRms; }         // sensory
    else if (vShell < 2.5) { col = uErr;   b = 0.35 + 1.6 * uBeat.y; }      // active
    else                   { col = uDeep * 2.0; b = 0.35; }                 // external
    gl_FragColor = soft(col * b * uGlow * uFade, 0.7 * uFade);
  }
`;

const TRAIL_VERT = /* glsl */`
  attribute float aIdx;
  varying float vAge;
  uniform float uHead;
  uniform float uCount;
  uniform float uPointSize;
  void main() {
    float age = mod(uHead - aIdx + uCount, uCount) / uCount;   // 0 = newest
    vAge = 1.0 - age;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPointSize * (1.0 + 3.5 * vAge) * (700.0 / max(1.0, -mv.z));
  }
`;
const TRAIL_FRAG = /* glsl */`
  ${SOFT_FRAG_HEAD}
  varying float vAge;
  uniform vec3  uPulse;
  uniform float uGlow;
  uniform float uFade;
  void main() {
    vec3 col = mix(uPulse, vec3(1.0), vAge * 0.5);
    gl_FragColor = soft(col * uGlow * vAge, 0.85 * vAge * vAge * uFade);
  }
`;

// ─── module ──────────────────────────────────────────────────────────────

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'friston',
  name: 'Friston',
  contextType: 'three',

  params: [
    { id: 'mode',      label: 'mode',      type: 'select', options: MODES,   default: 'spm' },
    { id: 'detail',    label: 'detail',    type: 'select', options: DETAILS, default: 'medium' },
    { id: 'threshold', label: 'threshold', type: 'range', min: 0, max: 1, step: 0.01, default: 0.32 },
    { id: 'flow',      label: 'flow',      type: 'range', min: 0, max: 3, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.45 },
      ] },
    { id: 'glow',      label: 'glow',      type: 'range', min: 0, max: 3, step: 0.05, default: 1.2,
      modulators: [
        { source: 'audio.bass',      mode: 'mul', amount: 0.45 },
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.35 },
        { source: 'audio.highs',     mode: 'mul', amount: 0.25 },
      ] },
    { id: 'palette',   label: 'palette',   type: 'select', options: SCHEMES_KEYS, default: 'voidstar' },
    { id: 'poseTrack', label: 'pose flies', type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks the research program: mapping → morphometry →
  // effective connectivity → hierarchical inference → the principle itself.
  autoPhase: {
    steps: [
      { mode: 'spm',         palette: 'clinical', threshold: 0.35 },
      { mode: 'spm',         palette: 'voidstar', threshold: 0.5 },
      { mode: 'vbm',         palette: 'clinical', threshold: 0.30 },
      { mode: 'vbm',         palette: 'voidstar', threshold: 0.45 },
      { mode: 'dcm',         palette: 'synaptic', flow: 1.4, threshold: 0.12 },
      { mode: 'dcm',         palette: 'voidstar', flow: 2.0, threshold: 0.25 },
      { mode: 'filtering',   palette: 'voidstar', flow: 1.6 },
      { mode: 'free_energy', palette: 'phantom',  flow: 1.2 },
    ],
  },

  presets: {
    default:                { mode: 'spm', detail: 'medium', threshold: 0.32, flow: 1.0, glow: 1.2, palette: 'voidstar', poseTrack: true, reactivity: 1.0 },
    parametric_map:         { mode: 'spm', palette: 'clinical', threshold: 0.45, glow: 1.4 },
    morphometry:            { mode: 'vbm', palette: 'clinical', threshold: 0.30, glow: 1.1, flow: 0.8 },
    effective_connectivity: { mode: 'dcm', palette: 'synaptic', threshold: 0.12, flow: 1.4, glow: 1.3 },
    message_passing:        { mode: 'filtering', palette: 'voidstar', threshold: 0.2, flow: 1.6, glow: 1.3 },
    surprise_minimizer:     { mode: 'free_energy', palette: 'phantom', threshold: 0.3, flow: 1.2, glow: 1.5 },
  },

  create(canvas, { renderer }) {
    const scene  = new Scene();
    const camera = new PerspectiveCamera(50, canvas.width / Math.max(1, canvas.height), 1, 2000);

    const root = new Group();
    scene.add(root);

    // ── shared uniforms (audio block reused across materials) ──
    const audioU = () => ({
      uBands: { value: new Vector4() },
      uBeat:  { value: new Vector2() },
      uMids:  { value: new Vector2() },
      uHighs: { value: new Vector2() },
      uRms:   { value: 0 },
    });

    const shellU = {
      ...audioU(),
      uPointSize: { value: 1.9 }, uShell: { value: new Color() },
      uDim: { value: 1 }, uFade: { value: 1 }, uTilt: { value: 0.5 },
    };
    const clusterU = {
      ...audioU(),
      uAct: { value: new Float32Array(MAX_CLUSTERS) },
      uThreshT: { value: 3 }, uPointSize: { value: 1 },
      uGlow: { value: 1.2 }, uFade: { value: 1 }, uTime: { value: 0 },
    };
    const voxelU = {
      uWarpK: { value: WARPS.map(w => new Vector4(w.k[0], w.k[1], w.k[2], Math.random() * TAU)) },
      uWarpD: { value: WARPS.map(w => new Vector4(w.e[0], w.e[1], w.e[2], w.A)) },
      uWarpGain: { value: 0.5 }, uFloor: { value: 0.15 }, uPointSize: { value: 1 },
      uWire: { value: new Color() }, uPulse: { value: new Color() },
      uGlow: { value: 1.2 }, uFade: { value: 1 }, uTime: { value: 0 }, uSparkle: { value: 0 },
    };
    const nodeU = {
      uNodeZ: { value: new Float32Array(N_DCM) },
      uNodeH: { value: new Float32Array(N_DCM) },
      uPointSize: { value: 1 },
      uErr: { value: new Color() }, uWire: { value: new Color() },
      uGlow: { value: 1.2 }, uFade: { value: 1 },
    };
    const edgeU = {
      uEdgeAct: { value: new Float32Array(MAX_EDGE_U) },
      uWire: { value: new Color() }, uPulse: { value: new Color() },
      uFlowPhase: { value: 0 }, uThresh: { value: 0.05 }, uFade: { value: 1 },
    };
    const pulseU = {
      uPointSize: { value: 1 },
      uKind0: { value: new Color() }, uKind1: { value: new Color() }, uKind2: { value: new Color() },
      uGlow: { value: 1.2 }, uFade: { value: 1 },
    };
    const ringU = {
      uMu: { value: new Float32Array(4) }, uPi: { value: new Float32Array(4) },
      uXi: { value: new Float32Array(4) },
      uRingY: { value: new Float32Array(RING_Y) }, uRingR: { value: new Float32Array(RING_R) },
      uTime: { value: 0 }, uPointSize: { value: 1 },
      uWire: { value: new Color() }, uErr: { value: new Color() },
      uGlow: { value: 1.2 }, uFade: { value: 1 },
    };
    const fieldU = {
      ...audioU(),
      uWells: { value: WELLS.map(w => new Vector4(w.c[0], w.c[1], w.sigma, 1)) },
      uMuPos: { value: new Vector2() }, uTime: { value: 0 },
      uPulse: { value: new Color() }, uDeep: { value: new Color() }, uWire: { value: new Color() },
      uGlow: { value: 1.2 }, uFade: { value: 1 },
    };
    const orbitU = {
      ...audioU(),
      uCenter: { value: new Vector3() }, uExtCenter: { value: new Vector3(0, 34, 0) },
      uTime: { value: 0 }, uPointSize: { value: 1 },
      uWire: { value: new Color() }, uErr: { value: new Color() },
      uPulse: { value: new Color() }, uDeep: { value: new Color() },
      uGlow: { value: 1.2 }, uFade: { value: 1 },
    };
    const TRAIL_N = 96;
    const trailU = {
      uHead: { value: 0 }, uCount: { value: TRAIL_N }, uPointSize: { value: 1 },
      uPulse: { value: new Color() }, uGlow: { value: 1.2 }, uFade: { value: 1 },
    };

    const mkMat = (vert, frag, uniforms) => new ShaderMaterial({
      uniforms, vertexShader: vert, fragmentShader: frag,
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });

    const shellMat   = mkMat(SHELL_VERT, SHELL_FRAG, shellU);
    const clusterMat = mkMat(CLUSTER_VERT, CLUSTER_FRAG, clusterU);
    const voxelMat   = mkMat(VOXEL_VERT, VOXEL_FRAG, voxelU);
    const nodeMat    = mkMat(NODE_VERT, NODE_FRAG, nodeU);
    const edgeMat    = mkMat(EDGE_VERT, EDGE_FRAG, edgeU);
    const pulseMat   = mkMat(PULSE_VERT, PULSE_FRAG, pulseU);
    const ringMat    = mkMat(RING_VERT, RING_FRAG, ringU);
    const fieldMat   = mkMat(FIELD_VERT, FIELD_FRAG, fieldU);
    const orbitMat   = mkMat(ORBIT_VERT, ORBIT_FRAG, orbitU);
    const trailMat   = mkMat(TRAIL_VERT, TRAIL_FRAG, trailU);
    const ellipseMat = new LineBasicMaterial({
      transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false,
    });

    // ── groups (all built once per detail level, toggled per mode) ──
    const gShell  = new Group();
    const gSpm    = new Group();
    const gVbm    = new Group();
    const gDcm    = new Group();
    const gFilter = new Group();
    const gFree   = new Group();
    root.add(gShell, gSpm, gVbm, gDcm, gFilter, gFree);

    let shellPts = null, clusterPts = null, voxelPts = null;

    // ── DCM graph geometry (static per session) ──
    // Enumerate directed edges from A's off-diagonals (×0.7 stability scale).
    const A = DCM_A.map(row => row.slice());
    for (let i = 0; i < N_DCM; i++) {
      for (let j = 0; j < N_DCM; j++) if (i !== j) A[i][j] *= 0.7;
    }
    const EDGES = [];
    for (let i = 0; i < N_DCM; i++) {
      for (let j = 0; j < N_DCM; j++) {
        if (i !== j && A[i][j] !== 0) {
          const mod = DCM_B.some(([bi, bj]) => bi === i && bj === j);
          EDGES.push({ tgt: i, src: j, w: A[i][j], mod });
        }
      }
    }

    // Quadratic-bezier arcs, control point pushed away from brain centre.
    const EDGE_SEG = 24;
    const edgeCurves = EDGES.map(e => {
      const p0 = new Vector3(...DCM_POS[e.src]);
      const p1 = new Vector3(...DCM_POS[e.tgt]);
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      const out = mid.clone().sub(new Vector3(0, -10, 5));
      const len = Math.max(1, out.length());
      const ctrl = mid.add(out.multiplyScalar((0.30 * p0.distanceTo(p1) + 14) / len));
      return { p0, ctrl, p1 };
    });

    function bez(out, c, t) {
      const s = 1 - t;
      out.x = s * s * c.p0.x + 2 * s * t * c.ctrl.x + t * t * c.p1.x;
      out.y = s * s * c.p0.y + 2 * s * t * c.ctrl.y + t * t * c.p1.y;
      out.z = s * s * c.p0.z + 2 * s * t * c.ctrl.z + t * t * c.p1.z;
      return out;
    }

    {
      // Node sprites — one core + one halo point per region.
      const pos = new Float32Array(N_DCM * 2 * 3);
      const aNode = new Float32Array(N_DCM * 2);
      const aRole = new Float32Array(N_DCM * 2);
      for (let i = 0; i < N_DCM; i++) {
        for (let r = 0; r < 2; r++) {
          const w = i * 2 + r;
          pos.set(DCM_POS[i], w * 3);
          aNode[w] = i; aRole[w] = r;
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aNode', new BufferAttribute(aNode, 1));
      g.setAttribute('aRole', new BufferAttribute(aRole, 1));
      const nodes = new Points(g, nodeMat);
      nodes.frustumCulled = false;
      gDcm.add(nodes);

      // Edge polylines.
      const verts = EDGES.length * EDGE_SEG * 2;
      const epos = new Float32Array(verts * 3);
      const aEdge = new Float32Array(verts);
      const aT = new Float32Array(verts);
      const aMod = new Float32Array(verts);
      const tmp = new Vector3();
      let w = 0;
      edgeCurves.forEach((c, e) => {
        for (let s = 0; s < EDGE_SEG; s++) {
          for (const tt of [s / EDGE_SEG, (s + 1) / EDGE_SEG]) {
            bez(tmp, c, tt);
            epos[w * 3] = tmp.x; epos[w * 3 + 1] = tmp.y; epos[w * 3 + 2] = tmp.z;
            aEdge[w] = e; aT[w] = tt; aMod[w] = EDGES[e].mod ? 1 : 0;
            w++;
          }
        }
      });
      const ge = new BufferGeometry();
      ge.setAttribute('position', new BufferAttribute(epos, 3));
      ge.setAttribute('aEdge', new BufferAttribute(aEdge, 1));
      ge.setAttribute('aT', new BufferAttribute(aT, 1));
      ge.setAttribute('aMod', new BufferAttribute(aMod, 1));
      const lines = new LineSegments(ge, edgeMat);
      lines.frustumCulled = false;
      gDcm.add(lines);
    }

    // ── filtering rings ──
    {
      const PER = 96;
      const n = 4 * PER;
      const pos = new Float32Array(n * 3);   // dummy — shader derives position
      const aRing = new Float32Array(n);
      const aAng = new Float32Array(n);
      const aSeed = new Float32Array(n);
      for (let r = 0; r < 4; r++) {
        for (let i = 0; i < PER; i++) {
          const w = r * PER + i;
          aRing[w] = r;
          aAng[w] = (i / PER) * TAU;
          aSeed[w] = Math.random();
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aRing', new BufferAttribute(aRing, 1));
      g.setAttribute('aAng', new BufferAttribute(aAng, 1));
      g.setAttribute('aSeed', new BufferAttribute(aSeed, 1));
      const rings = new Points(g, ringMat);
      rings.frustumCulled = false;
      gFilter.add(rings);
    }

    // ── free-energy landscape wireframe ──
    {
      const N = 64;
      const span = 3 * FE_SCALE;
      const segs = 2 * N * (N - 1);
      const pos = new Float32Array(segs * 2 * 3);
      const aSeed = new Float32Array(segs * 2);
      let w = 0;
      const put = (ix, iz) => {
        pos[w * 3]     = (ix / (N - 1) * 2 - 1) * span;
        pos[w * 3 + 1] = 0;
        pos[w * 3 + 2] = (iz / (N - 1) * 2 - 1) * span;
        aSeed[w] = ((ix * 31 + iz * 17) % 97) / 97;
        w++;
      };
      for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N - 1; ix++) { put(ix, iz); put(ix + 1, iz); }
      for (let ix = 0; ix < N; ix++) for (let iz = 0; iz < N - 1; iz++) { put(ix, iz); put(ix, iz + 1); }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new BufferAttribute(aSeed, 1));
      const grid = new LineSegments(g, fieldMat);
      grid.frustumCulled = false;
      gFree.add(grid);
    }

    // ── Markov blanket orbits ──
    {
      const SHELLS = [
        { n: 60,  r: [6, 10],  speed: [0.5, 1.2],   shell: 0 },   // internal
        { n: 48,  r: [14, 18], speed: [0.35, 0.8],  shell: 1 },   // sensory
        { n: 48,  r: [14, 18], speed: [-0.8, -0.35], shell: 2 },  // active (counter-rotating)
        { n: 120, r: [26, 46], speed: [-0.12, 0.12], shell: 3 },  // external
      ];
      const total = SHELLS.reduce((s, x) => s + x.n, 0);
      const pos = new Float32Array(total * 3);
      const aA = new Float32Array(total * 3);
      const aB = new Float32Array(total * 3);
      const aOrb = new Float32Array(total * 3);
      const aShell = new Float32Array(total);
      let w = 0;
      for (const sh of SHELLS) {
        for (let i = 0; i < sh.n; i++, w++) {
          // Random orbital plane: orthonormal basis (A, B).
          let nx = gauss(), ny = gauss(), nz = gauss();
          const nn = Math.hypot(nx, ny, nz) || 1; nx /= nn; ny /= nn; nz /= nn;
          let ax = gauss(), ay = gauss(), az = gauss();
          const d = ax * nx + ay * ny + az * nz;
          ax -= d * nx; ay -= d * ny; az -= d * nz;
          const an = Math.hypot(ax, ay, az) || 1; ax /= an; ay /= an; az /= an;
          const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
          aA[w * 3] = ax; aA[w * 3 + 1] = ay; aA[w * 3 + 2] = az;
          aB[w * 3] = bx; aB[w * 3 + 1] = by; aB[w * 3 + 2] = bz;
          aOrb[w * 3]     = sh.r[0] + Math.random() * (sh.r[1] - sh.r[0]);
          aOrb[w * 3 + 1] = sh.speed[0] + Math.random() * (sh.speed[1] - sh.speed[0]);
          aOrb[w * 3 + 2] = Math.random() * TAU;
          aShell[w] = sh.shell;
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aA', new BufferAttribute(aA, 3));
      g.setAttribute('aB', new BufferAttribute(aB, 3));
      g.setAttribute('aOrb', new BufferAttribute(aOrb, 3));
      g.setAttribute('aShell', new BufferAttribute(aShell, 1));
      const orbits = new Points(g, orbitMat);
      orbits.frustumCulled = false;
      gFree.add(orbits);
    }

    // ── belief particle trail + Laplace ellipse ──
    const trailPos = new Float32Array(TRAIL_N * 3);
    let trailGeom;
    {
      const aIdx = new Float32Array(TRAIL_N);
      for (let i = 0; i < TRAIL_N; i++) aIdx[i] = i;
      trailGeom = new BufferGeometry();
      const pa = new BufferAttribute(trailPos, 3); pa.setUsage(DynamicDrawUsage);
      trailGeom.setAttribute('position', pa);
      trailGeom.setAttribute('aIdx', new BufferAttribute(aIdx, 1));
      const trail = new Points(trailGeom, trailMat);
      trail.frustumCulled = false;
      gFree.add(trail);
    }
    const ELL_N = 48;
    const ellPos = new Float32Array(ELL_N * 3);
    let ellGeom;
    {
      ellGeom = new BufferGeometry();
      const pa = new BufferAttribute(ellPos, 3); pa.setUsage(DynamicDrawUsage);
      ellGeom.setAttribute('position', pa);
      const loop = new LineLoop(ellGeom, ellipseMat);
      loop.frustumCulled = false;
      gFree.add(loop);
    }

    // ── pulse pool (shared by dcm + filtering) ──
    const MAX_PULSES = 384;
    const pPos = new Float32Array(MAX_PULSES * 3);
    const pLife = new Float32Array(MAX_PULSES);
    const pKind = new Float32Array(MAX_PULSES);
    const pT = new Float32Array(MAX_PULSES);
    const pSpeed = new Float32Array(MAX_PULSES);
    const pP0 = new Float32Array(MAX_PULSES * 3);
    const pPC = new Float32Array(MAX_PULSES * 3);
    const pP1 = new Float32Array(MAX_PULSES * 3);
    let pulseGeom;
    {
      pulseGeom = new BufferGeometry();
      const pa = new BufferAttribute(pPos, 3); pa.setUsage(DynamicDrawUsage);
      const la = new BufferAttribute(pLife, 1); la.setUsage(DynamicDrawUsage);
      const ka = new BufferAttribute(pKind, 1); ka.setUsage(DynamicDrawUsage);
      pulseGeom.setAttribute('position', pa);
      pulseGeom.setAttribute('aLife', la);
      pulseGeom.setAttribute('aKind', ka);
      const pts = new Points(pulseGeom, pulseMat);
      pts.frustumCulled = false;
      root.add(pts);
    }
    let pulseCursor = 0;
    function spawnPulse(x0, y0, z0, cx, cy, cz, x1, y1, z1, kind, speed) {
      const i = pulseCursor;
      pulseCursor = (pulseCursor + 1) % MAX_PULSES;
      pP0[i * 3] = x0; pP0[i * 3 + 1] = y0; pP0[i * 3 + 2] = z0;
      pPC[i * 3] = cx; pPC[i * 3 + 1] = cy; pPC[i * 3 + 2] = cz;
      pP1[i * 3] = x1; pP1[i * 3 + 1] = y1; pP1[i * 3 + 2] = z1;
      pT[i] = 0; pSpeed[i] = speed; pLife[i] = 1; pKind[i] = kind;
    }

    // ── detail-dependent geometry (shell, clusters, voxels) ──
    let geomKey = '';
    function rebuildDetail(detail) {
      const mul = detail === 'low' ? 0.5 : detail === 'high' ? 2 : 1;
      for (const [group, ref] of [[gShell, shellPts], [gSpm, clusterPts], [gVbm, voxelPts]]) {
        if (ref) {
          group.remove(ref);
          ref.geometry.dispose();
        }
      }
      {
        const { positions, aShade } = buildShell(Math.floor(12000 * mul));
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(positions, 3));
        g.setAttribute('aShade', new BufferAttribute(aShade, 1));
        shellPts = new Points(g, shellMat);
        shellPts.frustumCulled = false;
        gShell.add(shellPts);
      }
      {
        const { positions, aCluster, aFall, aSeed } = buildClusters(Math.floor(340 * mul));
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(positions, 3));
        g.setAttribute('aCluster', new BufferAttribute(aCluster, 1));
        g.setAttribute('aFall', new BufferAttribute(aFall, 1));
        g.setAttribute('aSeed', new BufferAttribute(aSeed, 1));
        clusterPts = new Points(g, clusterMat);
        clusterPts.frustumCulled = false;
        gSpm.add(clusterPts);
      }
      {
        const spacing = detail === 'low' ? 6.5 : detail === 'high' ? 4 : 5;
        const { positions, aDensity, aSeed } = buildVoxels(spacing);
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(positions, 3));
        g.setAttribute('aDensity', new BufferAttribute(aDensity, 1));
        g.setAttribute('aSeed', new BufferAttribute(aSeed, 1));
        voxelPts = new Points(g, voxelMat);
        voxelPts.frustumCulled = false;
        gVbm.add(voxelPts);
      }
    }

    // ── simulation state ──
    // SPM
    const tStat = new Float32Array(MAX_CLUSTERS);
    // DCM
    const dcmZ = new Float64Array(N_DCM);
    const dcmS = new Float64Array(N_DCM);        // balloon: vasodilatory signal
    const dcmF = new Float64Array(N_DCM).fill(1); // balloon: blood inflow
    const edgeAccum = new Float32Array(EDGES.length);
    const edgeActSm = new Float32Array(EDGES.length);
    // Generalized filtering: μ, μ′ for levels 1..3 (index 0 = sensory data y).
    const gfMu = new Float64Array(4);
    const gfMuP = new Float64Array(4);
    const gfXi = new Float64Array(5);
    const gfPi = new Float64Array(5);
    const streamAccum = new Float32Array(8);
    // Free energy
    const fe = { x: -1.5, z: -1.2, vx: 0, vz: 0 };
    const feW = new Float32Array(4).fill(1);
    let feKickT = 0;
    let trailHead = 0;
    const blanketC = new Vector3(-1.5 * FE_SCALE, FE_YBASE + 26, -1.2 * FE_SCALE);
    // Audio analysis
    let centroidSm = 0.5;
    let prevBeat = false;
    let modeFade = 1;
    let lastMode = '';
    // Camera
    let azimuth = Math.PI * 0.35, elevation = 0.18, distance = 250;

    // Free-energy math (mirrors the FIELD_VERT shader exactly).
    function feF(x, z) {
      let F = 0.04 * (x * x + z * z);
      for (let i = 0; i < 4; i++) {
        const dx = x - WELLS[i].c[0], dz = z - WELLS[i].c[1];
        const s2 = WELLS[i].sigma * WELLS[i].sigma;
        F -= feW[i] * Math.exp(-(dx * dx + dz * dz) / (2 * s2));
      }
      return F;
    }
    function feGrad(x, z, out) {
      out.gx = 0.08 * x; out.gz = 0.08 * z;
      for (let i = 0; i < 4; i++) {
        const dx = x - WELLS[i].c[0], dz = z - WELLS[i].c[1];
        const s2 = WELLS[i].sigma * WELLS[i].sigma;
        const e = feW[i] * Math.exp(-(dx * dx + dz * dz) / (2 * s2)) / s2;
        out.gx += dx * e; out.gz += dz * e;
      }
      return out;
    }
    const gradScratch = { gx: 0, gz: 0 };

    // Analytic 2×2 Hessian of F (for the Laplace covariance ellipse).
    function feHess(x, z, H) {
      H.xx = 0.08; H.zz = 0.08; H.xz = 0;
      for (let i = 0; i < 4; i++) {
        const dx = x - WELLS[i].c[0], dz = z - WELLS[i].c[1];
        const s2 = WELLS[i].sigma * WELLS[i].sigma;
        const e = feW[i] * Math.exp(-(dx * dx + dz * dz) / (2 * s2)) / s2;
        H.xx += e * (1 - dx * dx / s2);
        H.zz += e * (1 - dz * dz / s2);
        H.xz += e * (-dx * dz / s2);
      }
      return H;
    }
    const hessScratch = { xx: 0, zz: 0, xz: 0 };

    const scratchV = new Vector3();
    let audioRef = null;
    let renderMode = 'spm';

    function update(field) {
      const { time, params, channels, pose } = field;
      const dt = Math.min(1 / 30, Math.max(1 / 240, field.dt));
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;
      const audioOn = !!audio.spectrum;
      const mode = MODES.includes(params.mode) ? params.mode : 'spm';
      renderMode = mode;

      // Detail rebuild.
      if (params.detail !== geomKey) {
        rebuildDetail(params.detail);
        geomKey = params.detail;
      }

      // Mode switch: fade the incoming scene in, retarget visibility.
      if (mode !== lastMode) {
        lastMode = mode;
        modeFade = 0;
      }
      modeFade = Math.min(1, modeFade + dt / 0.7);
      const brainMode = mode !== 'free_energy';
      gShell.visible  = brainMode;
      gSpm.visible    = mode === 'spm';
      gVbm.visible    = mode === 'vbm';
      gDcm.visible    = mode === 'dcm';
      gFilter.visible = mode === 'filtering';
      gFree.visible   = mode === 'free_energy';
      shellU.uDim.value = mode === 'spm' ? 1.0 : mode === 'vbm' ? 0.35
                        : mode === 'dcm' ? 0.55 : 0.45;

      // Palette.
      const sch = SCHEMES[params.palette] || SCHEMES.voidstar;
      shellU.uShell.value.fromArray(sch.shell);
      voxelU.uWire.value.fromArray(sch.wire);
      voxelU.uPulse.value.fromArray(sch.pulse);
      nodeU.uErr.value.fromArray(sch.err);
      nodeU.uWire.value.fromArray(sch.wire);
      edgeU.uWire.value.fromArray(sch.wire);
      edgeU.uPulse.value.fromArray(sch.pulse);
      pulseU.uKind0.value.fromArray(sch.wire);
      pulseU.uKind1.value.fromArray(sch.err);
      pulseU.uKind2.value.fromArray(sch.pulse);
      ringU.uWire.value.fromArray(sch.wire);
      ringU.uErr.value.fromArray(sch.err);
      fieldU.uPulse.value.fromArray(sch.pulse);
      fieldU.uDeep.value.fromArray(sch.deep);
      fieldU.uWire.value.fromArray(sch.wire);
      orbitU.uWire.value.fromArray(sch.wire);
      orbitU.uErr.value.fromArray(sch.err);
      orbitU.uPulse.value.fromArray(sch.pulse);
      orbitU.uDeep.value.fromArray(sch.deep);
      trailU.uPulse.value.fromArray(sch.pulse);
      ellipseMat.color.fromArray(sch.wire);

      // Shared uniform plumbing.
      const glow = params.glow, flow = params.flow;
      for (const u of [clusterU, voxelU, nodeU, pulseU, ringU, fieldU, orbitU, trailU]) {
        u.uGlow.value = glow;
        u.uFade.value = modeFade;
      }
      shellU.uFade.value = modeFade;
      edgeU.uFade.value = modeFade;
      clusterU.uTime.value = time;
      voxelU.uTime.value = time;
      ringU.uTime.value = time;
      fieldU.uTime.value = time;
      orbitU.uTime.value = time;
      edgeU.uFlowPhase.value = (edgeU.uFlowPhase.value + dt * flow) % 1000;

      // Spectral centroid → hue tilt (the "signal frequency analysis" hue).
      const spec = audio.spectrum;
      if (spec && spec.length) {
        let num = 0, den = 0;
        const stride = Math.max(1, spec.length >> 7);
        for (let i = 0; i < spec.length; i += stride) {
          num += i * spec[i]; den += spec[i];
        }
        const c = den > 1 ? (num / den) / spec.length * 2.4 : 0.5;
        centroidSm += (Math.min(1, c) - centroidSm) * Math.min(1, dt * 3);
      } else {
        centroidSm += (0.5 - centroidSm) * Math.min(1, dt * 0.5);
      }
      shellU.uTilt.value = centroidSm;

      const beatRise = audio.beat.active && !prevBeat;
      prevBeat = audio.beat.active;

      // ── SPM: per-cluster t-statistics from the FFT ──
      if (mode === 'spm') {
        const kUp = 1 - Math.exp(-dt * 14);
        const kDn = 1 - Math.exp(-dt * 2.2);
        for (let k = 0; k < CLUSTERS.length; k++) {
          const c = CLUSTERS[k];
          let v;
          if (audioOn) {
            if (spec && c.band !== 'beat' && c.band !== 'total') {
              const lo = Math.floor(c.bin[0] * spec.length);
              const hi = Math.max(lo + 1, Math.floor(c.bin[1] * spec.length));
              let sum = 0;
              const stride = Math.max(1, (hi - lo) >> 4);
              let n = 0;
              for (let i = lo; i < hi; i += stride) { sum += spec[i]; n++; }
              v = Math.max(0, (sum / (n * 255) - 0.10)) * 1.9;
            } else if (c.band === 'beat') {
              v = audio.beat.pulse;
            } else {
              v = audio.bands.total;
            }
          } else {
            // Idle: slow scanning waves of activation sweep the brain.
            v = 0.35 + 0.30 * Math.sin(time * 0.4 + k * 1.31);
          }
          const target = c.sign * 8 * Math.min(1, v);
          const k1 = Math.abs(target) > Math.abs(tStat[k]) ? kUp : kDn;
          tStat[k] += (target - tStat[k]) * k1;
          clusterU.uAct.value[k] = tStat[k];
        }
        // Height threshold: the slider sets it; sustained loudness relaxes
        // it so cluster extent grows outward — SPM thresholding, live.
        const tThr = 1.0 + 6.0 * params.threshold - (audioOn ? 1.6 * audio.rms : 0);
        clusterU.uThreshT.value = Math.max(0.6, tThr);
      }

      // ── VBM: advance warp phases, gain rides the rms ──
      if (mode === 'vbm') {
        const bandFor = [audio.bands.bass, audio.bands.bass, audio.bands.mids,
                         audio.bands.mids, audio.bands.highs, audio.bands.highs];
        for (let i = 0; i < 6; i++) {
          const K = voxelU.uWarpK.value[i];
          K.w += WARPS[i].w * dt * (0.5 + flow);
          const drive = audioOn ? bandFor[i] : 0.4 + 0.3 * Math.sin(time * 0.3 + i * 1.1);
          voxelU.uWarpD.value[i].w = WARPS[i].A * (0.4 + 0.6 * drive);
        }
        voxelU.uWarpGain.value = (audioOn ? 0.45 + 0.25 * audio.rms : 0.5 + 0.15 * Math.sin(time * 0.23))
                               + 0.15 * audio.beat.pulse;
        voxelU.uFloor.value = params.threshold * 0.5;
        voxelU.uSparkle.value = audio.highs.pulse;
      }

      // ── DCM: integrate the bilinear model + balloon hemodynamics ──
      if (mode === 'dcm') {
        const u = audioOn ? 0.5 * audio.bands.bass + 0.5 * audio.beat.pulse
                          : 0.18 + 0.15 * Math.sin(time * 0.5);
        const um = audioOn ? audio.bands.mids : 0.3 + 0.3 * Math.sin(time * 0.23);
        for (let i = 0; i < N_DCM; i++) {
          let dz = 0;
          for (let j = 0; j < N_DCM; j++) {
            let a = A[i][j];
            for (const [bi, bj, bw] of DCM_B) {
              if (bi === i && bj === j) a = Math.min(0.45, a + um * bw);
            }
            dz += a * dcmZ[j];
          }
          dz += DCM_C[i] * u;
          dcmZ[i] = Math.max(-3, Math.min(3, dcmZ[i] + dt * dz));
          // Balloon-flavored hemodynamics (Friston 2000 constants).
          dcmS[i] += dt * (Math.abs(dcmZ[i]) - 0.65 * dcmS[i] - 0.41 * (dcmF[i] - 1));
          dcmF[i] += dt * dcmS[i];
          if (!Number.isFinite(dcmZ[i]) || !Number.isFinite(dcmF[i])) {
            dcmZ[i] = 0; dcmS[i] = 0; dcmF[i] = 1;
          }
          nodeU.uNodeZ.value[i] = Math.abs(dcmZ[i]);
          nodeU.uNodeH.value[i] = Math.max(0, Math.min(1, 0.6 * (dcmF[i] - 1)));
        }
        // Edge activity + pulse emission (rate ∝ |A_eff · z_src|).
        edgeU.uThresh.value = params.threshold * 0.25;
        for (let e = 0; e < EDGES.length; e++) {
          const { src, w } = EDGES[e];
          // Structural floor keeps the anatomy of the graph legible even when
          // the presynaptic state is quiet; dynamics brighten it from there.
          const act = Math.max(0.30 * Math.abs(w) / 0.45,
                               Math.min(1, Math.abs(w * dcmZ[src]) / 0.45));
          edgeActSm[e] += (act - edgeActSm[e]) * Math.min(1, dt * 6);
          edgeU.uEdgeAct.value[e] = edgeActSm[e];
          edgeAccum[e] += 8 * Math.abs(w * dcmZ[src]) * flow * dt;
          const burst = beatRise && Math.abs(w * dcmZ[src]) > 0.05;
          while (edgeAccum[e] > 1 || burst && edgeAccum[e] > -1) {
            const c = edgeCurves[e];
            spawnPulse(c.p0.x, c.p0.y, c.p0.z, c.ctrl.x, c.ctrl.y, c.ctrl.z,
                       c.p1.x, c.p1.y, c.p1.z, burst ? 3 : 2,
                       0.9 + Math.random() * 0.4);
            edgeAccum[e] -= 1;
            if (burst) break;
          }
          if (edgeAccum[e] > 4) edgeAccum[e] = 4;
        }
      }

      // ── generalized filtering: μ̇ = Dμ − ∂F/∂μ over the hierarchy ──
      if (mode === 'filtering') {
        const y = audioOn ? 1.6 * audio.bands.bass + 0.8 * audio.bands.mids - 0.5
                          : 0.8 * Math.sin(time * 0.7) + 0.3 * Math.sin(time * 1.9);
        const attn = audioOn ? audio.bands.highs : 0.4 + 0.3 * Math.sin(time * 0.9);
        const attm = audioOn ? audio.bands.mids : 0.4;
        gfPi[1] = PI_BASE[0] * (0.5 + 1.5 * attn);
        gfPi[2] = PI_BASE[1] * (0.5 + 1.5 * attn);
        gfPi[3] = PI_BASE[2] * (0.5 + 1.0 * attm);
        gfPi[4] = PI_BASE[3] * (0.5 + 1.0 * attm);
        // ε_i = μ_{i−1} − tanh(μ_i); μ_0 ≡ y; ε_4 = μ_3 − 0 (flat prior).
        const muOf = i => (i === 0 ? y : gfMu[i]);
        for (let i = 1; i <= 3; i++) gfXi[i] = gfPi[i] * (muOf(i - 1) - Math.tanh(gfMu[i]));
        gfXi[4] = gfPi[4] * gfMu[3];
        for (let i = 1; i <= 3; i++) {
          const th = Math.tanh(gfMu[i]);
          const sech2 = 1 - th * th;
          const dMu  = gfMuP[i] + GF_K * (gfXi[i] * sech2 - gfXi[i + 1]);
          const dMuP = -GF_K * (GF_BETA * gfMuP[i] + gfXi[i + 1] - gfXi[i] * sech2);
          gfMu[i]  = Math.max(-4, Math.min(4, gfMu[i] + dt * dMu));
          gfMuP[i] = Math.max(-4, Math.min(4, gfMuP[i] + dt * dMuP));
          if (!Number.isFinite(gfMu[i]) || !Number.isFinite(gfMuP[i])) {
            gfMu[i] = 0; gfMuP[i] = 0;
          }
        }
        ringU.uMu.value[0] = y;
        ringU.uPi.value[0] = gfPi[1];
        ringU.uXi.value[0] = gfXi[1] / 8;
        for (let i = 1; i <= 3; i++) {
          ringU.uMu.value[i] = gfMu[i];
          ringU.uPi.value[i] = gfPi[i + 1];
          ringU.uXi.value[i] = gfXi[i + 1] / 8;
        }
        // Message streams: ascending errors (hot, fast) + descending
        // predictions (cool, slow) between consecutive rings.
        const gate = params.threshold * 1.2;
        for (let g2 = 0; g2 < 3; g2++) {
          const up = Math.max(0, Math.abs(gfXi[g2 + 1]) - gate)
                   * (1.2 + 2.0 * audio.beat.pulse) * flow;
          const down = (0.5 + 0.6 * Math.abs(Math.tanh(muOf(g2 + 1)))) * flow;
          streamAccum[g2] += up * dt * 5.0;
          streamAccum[g2 + 4] += down * dt * 2.4;
          const th0 = Math.random() * TAU;
          while (streamAccum[g2] > 1) {
            streamAccum[g2] -= 1;
            const twist = 0.5;
            const r0 = RING_R[g2], r1 = RING_R[g2 + 1];
            const rm = (r0 + r1) * 0.62;
            spawnPulse(
              Math.cos(th0) * r0, RING_Y[g2], Math.sin(th0) * r0,
              Math.cos(th0 + twist * 0.5) * rm, (RING_Y[g2] + RING_Y[g2 + 1]) * 0.5, Math.sin(th0 + twist * 0.5) * rm,
              Math.cos(th0 + twist) * r1, RING_Y[g2 + 1], Math.sin(th0 + twist) * r1,
              1, 1.4 + Math.random() * 0.5);
          }
          while (streamAccum[g2 + 4] > 1) {
            streamAccum[g2 + 4] -= 1;
            const th1 = Math.random() * TAU;
            const r0 = RING_R[g2 + 1], r1 = RING_R[g2];
            spawnPulse(
              Math.cos(th1) * r0, RING_Y[g2 + 1], Math.sin(th1) * r0,
              Math.cos(th1 - 0.4) * (r0 + r1) * 0.55, (RING_Y[g2] + RING_Y[g2 + 1]) * 0.5, Math.sin(th1 - 0.4) * (r0 + r1) * 0.55,
              Math.cos(th1 - 0.8) * r1, RING_Y[g2], Math.sin(th1 - 0.8) * r1,
              0, 0.45 + Math.random() * 0.2);
          }
          if (streamAccum[g2] > 4) streamAccum[g2] = 4;
          if (streamAccum[g2 + 4] > 4) streamAccum[g2 + 4] = 4;
        }
      }

      // ── free energy: well depths breathe, particle descends, beats kick ──
      if (mode === 'free_energy') {
        const bands = [audio.bands.bass, audio.bands.mids, audio.bands.highs, audio.rms];
        for (let i = 0; i < 4; i++) {
          const drive = audioOn ? bands[i] : 0.35 + 0.3 * Math.sin(time * 0.27 + i * 1.7);
          const target = 0.6 + 0.8 * drive;
          const kk = target > feW[i] ? 1 - Math.exp(-dt * 18) : 1 - Math.exp(-dt * 3);
          feW[i] += (target - feW[i]) * kk;
          fieldU.uWells.value[i].w = feW[i];
        }
        // Surprise: beats kick the believer uphill; idle self-kicks keep it roaming.
        feKickT += dt;
        const kick = (beatRise ? 2.2 * Math.max(0.4, audio.beat.pulse) : 0)
                   + (!audioOn && feKickT > 5 ? 1.6 : 0);
        if (kick > 0) {
          const a = Math.random() * TAU;
          fe.vx += kick * Math.cos(a);
          fe.vz += kick * Math.sin(a);
          feKickT = 0;
        }
        feGrad(fe.x, fe.z, gradScratch);
        fe.vx += dt * (-4.0 * gradScratch.gx - 1.8 * fe.vx);
        fe.vz += dt * (-4.0 * gradScratch.gz - 1.8 * fe.vz);
        const vmag = Math.hypot(fe.vx, fe.vz);
        if (vmag > 6) { fe.vx *= 6 / vmag; fe.vz *= 6 / vmag; }
        fe.x = Math.max(-3, Math.min(3, fe.x + dt * fe.vx * flow));
        fe.z = Math.max(-3, Math.min(3, fe.z + dt * fe.vz * flow));
        if (!Number.isFinite(fe.x) || !Number.isFinite(fe.z)) {
          fe.x = -1.5; fe.z = -1.2; fe.vx = 0; fe.vz = 0;
        }
        fieldU.uMuPos.value.set(fe.x, fe.z);

        // Trail (particle rendered as the newest, largest trail point).
        const yNow = FE_YBASE + FE_YSCALE * feF(fe.x, fe.z) + 1.2;
        trailHead = (trailHead + 1) % TRAIL_N;
        trailPos[trailHead * 3]     = fe.x * FE_SCALE;
        trailPos[trailHead * 3 + 1] = yNow;
        trailPos[trailHead * 3 + 2] = fe.z * FE_SCALE;
        trailU.uHead.value = trailHead;
        trailGeom.attributes.position.needsUpdate = true;

        // Laplace approximation: covariance ellipse from the inverse Hessian.
        feHess(fe.x, fe.z, hessScratch);
        const tr2 = (hessScratch.xx + hessScratch.zz) / 2;
        const det = hessScratch.xx * hessScratch.zz - hessScratch.xz * hessScratch.xz;
        const disc = Math.sqrt(Math.max(0, tr2 * tr2 - det));
        const l1 = tr2 + disc, l2 = tr2 - disc;
        let e1x = hessScratch.xz, e1z = l1 - hessScratch.xx;
        const en = Math.hypot(e1x, e1z);
        if (en < 1e-6) { e1x = 1; e1z = 0; } else { e1x /= en; e1z /= en; }
        const sa = Math.sqrt(Math.min(0.7, Math.max(0.04, 1 / Math.max(0.8, l1))));
        const sb = Math.sqrt(Math.min(0.7, Math.max(0.04, 1 / Math.max(0.8, l2))));
        for (let j = 0; j < ELL_N; j++) {
          const a = (j / ELL_N) * TAU;
          const ex = fe.x + (e1x * Math.cos(a) * sa - e1z * Math.sin(a) * sb);
          const ez = fe.z + (e1z * Math.cos(a) * sa + e1x * Math.sin(a) * sb);
          ellPos[j * 3]     = ex * FE_SCALE;
          ellPos[j * 3 + 1] = FE_YBASE + FE_YSCALE * feF(ex, ez) + 1.6;
          ellPos[j * 3 + 2] = ez * FE_SCALE;
        }
        ellGeom.attributes.position.needsUpdate = true;
        ellipseMat.opacity = (0.35 + 0.5 * audio.rms) * modeFade;

        // Markov blanket hovers above the believer (smoothed follow).
        blanketC.x += (fe.x * FE_SCALE - blanketC.x) * Math.min(1, dt * 2);
        blanketC.y += (yNow + 30 - blanketC.y) * Math.min(1, dt * 2);
        blanketC.z += (fe.z * FE_SCALE - blanketC.z) * Math.min(1, dt * 2);
        orbitU.uCenter.value.copy(blanketC);
      }

      // ── advance pulses (allocation-free) ──
      const pulsesLive = mode === 'dcm' || mode === 'filtering';
      for (let i = 0; i < MAX_PULSES; i++) {
        if (pLife[i] <= 0) continue;
        if (!pulsesLive) { pLife[i] = 0; continue; }
        pT[i] += dt * pSpeed[i] * Math.max(0.15, flow);
        if (pT[i] >= 1) { pLife[i] = 0; continue; }
        pLife[i] = Math.min(1, 4 * pT[i] * (1 - pT[i]) + 0.35);
        const t = pT[i], s = 1 - t;
        pPos[i * 3]     = s * s * pP0[i * 3]     + 2 * s * t * pPC[i * 3]     + t * t * pP1[i * 3];
        pPos[i * 3 + 1] = s * s * pP0[i * 3 + 1] + 2 * s * t * pPC[i * 3 + 1] + t * t * pP1[i * 3 + 1];
        pPos[i * 3 + 2] = s * s * pP0[i * 3 + 2] + 2 * s * t * pPC[i * 3 + 2] + t * t * pP1[i * 3 + 2];
      }
      pulseGeom.attributes.position.needsUpdate = true;
      pulseGeom.attributes.aLife.needsUpdate = true;
      pulseGeom.attributes.aKind.needsUpdate = true;

      // ── camera: pose flies through the space, smoothed ──
      const freeMode = mode === 'free_energy';
      const baseEl = freeMode ? 0.60 : mode === 'filtering' ? 0.32 : 0.18;
      const baseDist = freeMode ? 235 : 250;
      let tAz = azimuth, tEl = baseEl, tDist = baseDist;
      const hasPose = params.poseTrack && pose.people.length > 0;
      if (hasPose) {
        const hx = channels?.['pose.head.x'] ?? 0;
        const pitch = channels?.['pose.headPitch'] ?? (channels?.['pose.head.y'] ?? 0);
        const sp = channels?.['pose.shoulderSpan'] ?? 0;
        tAz = Math.PI * 0.35 + hx * 1.6;
        tEl = baseEl + pitch * 0.7;
        tDist = baseDist - sp * 95;
      } else {
        // Idle drift keeps the scene alive with nobody in frame.
        tAz = azimuth + dt * 4 * 0.06;
      }
      const kc = Math.min(1, dt * 3);
      azimuth   += (tAz - azimuth) * kc;
      elevation += (tEl - elevation) * kc;
      distance  += (tDist - distance) * kc;
      const cosE = Math.cos(elevation);
      camera.position.set(
        distance * cosE * Math.cos(azimuth),
        distance * Math.sin(elevation),
        distance * cosE * Math.sin(azimuth),
      );
      scratchV.set(0, freeMode ? -4 : 4, 0);
      camera.lookAt(scratchV);
    }

    function render() {
      if (audioRef) {
        applyAudioUniforms(shellU, audioRef);
        applyAudioUniforms(clusterU, audioRef);
        applyAudioUniforms(fieldU, audioRef);
        applyAudioUniforms(orbitU, audioRef);
      }
      renderer.render(scene, camera);
    }

    function resize(w, h /*, dpr */) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }

    function dispose() {
      // Renderer is core-owned and shared across 'three' quales — only tear
      // down our own scene graph.
      disposeObject3D(scene);
    }

    return { resize, update, render, dispose };
  },
};
