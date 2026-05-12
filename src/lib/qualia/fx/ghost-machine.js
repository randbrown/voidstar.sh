// Ghost in the Machine — pose-driven volumetric "ghost" rendered as a single
// Points cloud bound to the live MediaPipe skeleton, hovering over a
// procedural circuit-grid background. The body is a haze of additive
// particles strung along 14 bones (neck/spine/limbs); a denser cluster on
// a unit sphere centered on the head joint forms a skull silhouette via
// shader-baked eye-socket and jaw-stripe masks. No external assets.
//
// Coordinate system: a single Scene + OrthographicCamera with extents
// (-aspect..+aspect) × (+1..-1). MediaPipe landmarks (mirrored, [0,1])
// map directly into shader-space via `poseToOrtho`, so the skeleton's
// proportions match the user's silhouette without any projection guess.
//
// Modulation map (declarative):
//   audio.total      → swirl        (overall energy tightens the breath)
//   audio.bass       → glow         (low end swells body brightness)
//   audio.beatPulse  → glow         (kick pumps the silhouette)
//   audio.highs      → edgeShimmer  (hats sparkle wisp edges)
//   audio.highsPulse → edgeShimmer
//   audio.mids       → bgEnergy     (mids brighten the circuit traces)
//   audio.beatPulse  → bgEnergy     (kick flashes the background)
// Inline (in update(), not via modulation engine):
//   pose head/neck/shoulders/elbows/wrists/hips/knees/ankles → uJoints[14]
//   (smoothed; idleBlend ramps to a canned drift when confidence drops)

import {
  Scene, OrthographicCamera, Points, Mesh, PlaneGeometry,
  BufferGeometry, BufferAttribute, ShaderMaterial,
  AdditiveBlending, Color, Vector2, Vector3, Vector4, Group,
} from 'three';
import { applyAudioUniforms, disposeObject3D } from '../three-host.js';
import { scaleAudio } from '../field.js';

const COUNT_OPTS = ['15000', '30000', '60000', '120000'];
const PALETTES   = ['cyan_spirit', 'magenta_wraith', 'green_phantom', 'white_shroud'];

// Each palette: body (main mist), edge (outer wisps), skull, bg (circuit base).
const PALETTE_COLORS = {
  cyan_spirit:    { body: [0.55, 0.85, 1.00], edge: [0.20, 0.55, 0.90], skull: [0.85, 0.95, 1.00], bg: [0.10, 0.35, 0.65] },
  magenta_wraith: { body: [0.95, 0.55, 0.95], edge: [0.55, 0.20, 0.75], skull: [1.00, 0.80, 0.95], bg: [0.45, 0.15, 0.55] },
  green_phantom:  { body: [0.55, 1.00, 0.75], edge: [0.10, 0.55, 0.40], skull: [0.85, 1.00, 0.90], bg: [0.10, 0.45, 0.30] },
  white_shroud:   { body: [0.90, 0.92, 0.98], edge: [0.55, 0.65, 0.80], skull: [1.00, 1.00, 1.00], bg: [0.20, 0.25, 0.40] },
};

// Joint slots in the uJoints[14] uniform. Order must agree with pickJoint().
const J = {
  HEAD: 0, NECK: 1,
  SHOULDER_L: 2, SHOULDER_R: 3,
  ELBOW_L: 4,    ELBOW_R: 5,
  WRIST_L: 6,    WRIST_R: 7,
  HIP_L: 8,      HIP_R: 9,
  KNEE_L: 10,    KNEE_R: 11,
  ANKLE_L: 12,   ANKLE_R: 13,
};

// Bones, as [jointA, jointB]. Particles distribute uniformly along these.
const BONE_PAIRS = [
  [J.NECK, J.HEAD],
  [J.SHOULDER_L, J.SHOULDER_R],
  [J.NECK, J.SHOULDER_L], [J.NECK, J.SHOULDER_R],
  [J.SHOULDER_L, J.ELBOW_L], [J.ELBOW_L, J.WRIST_L],
  [J.SHOULDER_R, J.ELBOW_R], [J.ELBOW_R, J.WRIST_R],
  [J.NECK, J.HIP_L], [J.NECK, J.HIP_R],
  [J.HIP_L, J.KNEE_L], [J.KNEE_L, J.ANKLE_L],
  [J.HIP_R, J.KNEE_R], [J.KNEE_R, J.ANKLE_R],
];

// T-pose-ish idle skeleton (ortho units). Used when no pose is detected,
// blended with a slow drift in update().
const IDLE_POSE = [
  [ 0.00,  0.55, 0.0],  // head
  [ 0.00,  0.32, 0.0],  // neck
  [-0.18,  0.30, 0.0],  // shoulder.l
  [ 0.18,  0.30, 0.0],  // shoulder.r
  [-0.28,  0.05, 0.0],  // elbow.l
  [ 0.28,  0.05, 0.0],  // elbow.r
  [-0.35, -0.20, 0.0],  // wrist.l
  [ 0.35, -0.20, 0.0],  // wrist.r
  [-0.12, -0.10, 0.0],  // hip.l
  [ 0.12, -0.10, 0.0],  // hip.r
  [-0.14, -0.45, 0.0],  // knee.l
  [ 0.14, -0.45, 0.0],  // knee.r
  [-0.16, -0.80, 0.0],  // ankle.l
  [ 0.16, -0.80, 0.0],  // ankle.r
];

const VERT_GHOST = /* glsl */`
  attribute float aBoneA;
  attribute float aBoneB;
  attribute float aT;
  attribute float aPhase;
  attribute float aSize;
  attribute float aRole;
  attribute vec3  aOffset;

  uniform vec3  uJoints[14];
  uniform float uTime;
  uniform float uSwirl;
  uniform float uFlinch;
  uniform float uGlow;
  uniform float uPointSize;
  uniform float uSkullRadius;
  uniform vec2  uBeat;

  varying float vRole;
  varying float vPhase;
  varying vec2  vOffXY;
  varying float vSize;

  // Loop-based selection — GLSL ES 1.0 doesn't allow non-constant dynamic
  // indexing of uniform arrays in the general case. A bounded for-loop with
  // a loop-index compare is portable across WebGL1/2.
  vec3 getJoint(int idx) {
    vec3 j = uJoints[0];
    for (int k = 0; k < 14; k++) {
      if (k == idx) { j = uJoints[k]; }
    }
    return j;
  }

  void main() {
    vRole = aRole;
    vPhase = aPhase;
    vOffXY = aOffset.xy;
    vSize  = aSize;

    int ia = int(aBoneA + 0.5);
    int ib = int(aBoneB + 0.5);
    vec3 ja = getJoint(ia);
    vec3 jb = getJoint(ib);
    vec3 along = jb - ja;
    vec3 perp = normalize(vec3(-along.y, along.x, 0.0001));

    vec3 base = mix(ja, jb, aT) + perp * aOffset.x + vec3(0.0, 0.0, aOffset.z);

    float ph = aPhase + uTime * (0.6 + uSwirl * 0.8);
    vec3 swirl = vec3(cos(ph) * 0.018, sin(ph * 1.3) * 0.018, sin(ph * 0.7) * 0.018) * uSwirl;
    swirl += perp * uBeat.y * uFlinch * 0.06;

    if (aRole > 0.5) {
      // Skull: place on unit sphere around the head joint (slot 0 = HEAD).
      base = uJoints[0] + aOffset * uSkullRadius;
      swirl *= 0.25;
    }

    vec4 mv = modelViewMatrix * vec4(base + swirl, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPointSize * aSize * (1.0 + uGlow * 0.25);
  }
`;

const FRAG_GHOST = /* glsl */`
  precision highp float;
  varying float vRole;
  varying float vPhase;
  varying vec2  vOffXY;
  varying float vSize;

  uniform vec3  uBodyColor;
  uniform vec3  uEdgeColor;
  uniform vec3  uSkullColor;
  uniform vec4  uBands;
  uniform vec2  uBeat;
  uniform vec2  uHighs;
  uniform float uGlow;
  uniform float uShimmer;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float fall = exp(-r2 * 11.0);

    vec3 col;
    if (vRole > 0.5) {
      // Skull particles — kill zero-sized (eye socket / jaw mask),
      // tint with skull color and beat boost.
      if (vSize < 0.05) discard;
      col = uSkullColor * (0.85 + uBeat.y * 0.5 + uBands.x * 0.3);
    } else {
      float edge = clamp(length(vOffXY) * 6.0, 0.0, 1.0);
      col = mix(uBodyColor, uEdgeColor, edge);
      col *= 0.65 + 0.8 * uGlow + uBands.x * 0.5 + uBeat.y * 0.4;
    }
    float sparkle = uShimmer * uHighs.y * step(0.92, fract(vPhase * 43.7));
    gl_FragColor = vec4((col + sparkle) * fall, fall * 0.85);
  }
`;

const VERT_BG = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG_BG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uBgEnergy;
  uniform float uAspect;
  uniform vec3  uBgColor;
  uniform vec4  uBands;
  uniform vec2  uBeat;
  uniform vec2  uMids;

  // Cheap hash for sparse trace seeds.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    // Convert [0,1] uv into aspect-aware [-aspect, aspect] × [-1, 1].
    vec2 uv = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);

    // Substrate grid — thin cell lines.
    vec2 grid = abs(fract(uv * 12.0) - 0.5);
    float cell = smoothstep(0.48, 0.50, max(grid.x, grid.y));

    // Horizontal data traces drifting right; modulated by row-wise noise.
    float row = floor(uv.y * 18.0);
    float seed = hash(vec2(row, 17.0));
    float trace = step(0.985, fract(uv.x * 24.0 + uTime * (0.20 + seed * 0.4)
                                    + sin(uv.y * 5.0) * 0.3));
    trace *= smoothstep(0.55, 0.95, seed);

    // Vertical capillaries — sparse, slower.
    float col = floor(uv.x * 14.0);
    float colSeed = hash(vec2(col, 31.0));
    float cap = step(0.992, fract(uv.y * 18.0 - uTime * (0.10 + colSeed * 0.25)));
    cap *= smoothstep(0.65, 0.98, colSeed);

    float pulse = 0.35 + 0.85 * uBands.x * uBgEnergy;
    float trans = (trace + cap) * pulse;

    // Soft radial vignette so the figure pops.
    float vig = 1.0 - smoothstep(0.6, 1.4, length(uv));

    vec3 base = uBgColor * (0.05 + cell * 0.12 + uBands.y * 0.06 * uBgEnergy);
    vec3 hot  = uBgColor * (1.6 + uBeat.y * 0.8) + vec3(0.10, 0.20, 0.35);
    vec3 col3 = base + hot * trans + uBgColor * uBeat.y * 0.05;
    col3 *= 0.35 + 0.65 * vig;

    gl_FragColor = vec4(col3, 1.0);
  }
`;

// Build the per-particle attribute buffers. Buffers are static — bone
// indices, t-along-bone, offsets, phases, and roles are baked once.
// Skull particles (~20% of the count) get aOffset = unit Fibonacci-sphere
// normal, with eye-socket and jaw-stripe masks zeroing aSize so the
// fragment shader discards them — giving the iconic two dark eye voids
// and bottom jaw band without any texture.
function generateParticles(count) {
  const skullN = Math.floor(count * 0.20);
  const wispN  = Math.floor(count * 0.08);
  const bodyN  = count - skullN - wispN;

  const aBoneA  = new Float32Array(count);
  const aBoneB  = new Float32Array(count);
  const aT      = new Float32Array(count);
  const aPhase  = new Float32Array(count);
  const aSize   = new Float32Array(count);
  const aRole   = new Float32Array(count);
  const aOffset = new Float32Array(count * 3);
  // BufferGeometry requires a `position` attribute (we never actually use
  // it — the vert shader builds position from joints — but Three.js will
  // refuse to draw without it).
  const positions = new Float32Array(count * 3);

  let p = 0;

  // Body particles strung along bones.
  for (let i = 0; i < bodyN; i++, p++) {
    const boneIdx = i % BONE_PAIRS.length;
    const [a, b] = BONE_PAIRS[boneIdx];
    aBoneA[p] = a;
    aBoneB[p] = b;
    aT[p]     = Math.random();
    // Perpendicular jitter wider on torso bones (neck↔shoulders/hips),
    // tighter on limbs — gives the dense central mist and trim limbs.
    const isTorso = (a === J.NECK || b === J.NECK
                  || a === J.SHOULDER_L || a === J.SHOULDER_R
                  || b === J.HIP_L || b === J.HIP_R);
    const sigma = isTorso ? 0.075 : 0.040;
    aOffset[p * 3 + 0] = (Math.random() + Math.random() - 1.0) * sigma;
    aOffset[p * 3 + 1] = 0.0;
    aOffset[p * 3 + 2] = (Math.random() - 0.5) * 0.06;
    aPhase[p]  = Math.random() * Math.PI * 2;
    aSize[p]   = 0.6 + Math.random() * 1.4;
    aRole[p]   = 0.0;
  }

  // Wisp tails overshoot bone ends, with bigger lateral spread.
  for (let i = 0; i < wispN; i++, p++) {
    const boneIdx = Math.floor(Math.random() * BONE_PAIRS.length);
    const [a, b] = BONE_PAIRS[boneIdx];
    aBoneA[p] = a;
    aBoneB[p] = b;
    aT[p]     = Math.random() < 0.5 ? -0.15 - Math.random() * 0.15
                                    :  1.15 + Math.random() * 0.15;
    aOffset[p * 3 + 0] = (Math.random() - 0.5) * 0.18;
    aOffset[p * 3 + 1] = 0.0;
    aOffset[p * 3 + 2] = (Math.random() - 0.5) * 0.10;
    aPhase[p]  = Math.random() * Math.PI * 2;
    aSize[p]   = 0.3 + Math.random() * 0.7;
    aRole[p]   = 0.0;
  }

  // Skull cluster on Fibonacci-sphere centered on head joint.
  // Face features are masked into per-particle aSize: zero-size particles
  // are discarded in the fragment shader, leaving dark voids that read as
  // eye sockets / mouth on the front hemisphere.
  // Eye centers sit ON the unit sphere (lat 0.15, lon ±30° from +z).
  const PHI = Math.PI * (3 - Math.sqrt(5));
  const EYE_LY = 0.15;
  const EYE_LX = 0.5;
  const EYE_LZ = Math.sqrt(Math.max(0, 1 - EYE_LY * EYE_LY - EYE_LX * EYE_LX)); // ≈ 0.853
  const EYE_R  = 0.30;
  for (let i = 0; i < skullN; i++, p++) {
    const t = i / Math.max(1, skullN - 1);
    const y = 1.0 - t * 2.0;             // -1..+1 (lat)
    const r = Math.sqrt(Math.max(0, 1.0 - y * y));
    const theta = PHI * i;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;

    aBoneA[p] = J.HEAD;
    aBoneB[p] = J.HEAD;
    aT[p]     = 0.0;
    aOffset[p * 3 + 0] = x;
    aOffset[p * 3 + 1] = y;
    aOffset[p * 3 + 2] = z;
    aPhase[p] = Math.random() * Math.PI * 2;
    aRole[p]  = 1.0;

    let size = 0.9 + Math.random() * 0.6;

    // Face features only on the front hemisphere.
    if (z > 0.2) {
      const eyeL = Math.hypot(x - (-EYE_LX), y - EYE_LY, z - EYE_LZ);
      const eyeR = Math.hypot(x - ( EYE_LX), y - EYE_LY, z - EYE_LZ);
      if (eyeL < EYE_R || eyeR < EYE_R) size = 0.0;

      // Nasal triangle — narrow strip just below eye line.
      if (y < EYE_LY - 0.08 && y > -0.20 && Math.abs(x) < 0.10 && z > 0.7) {
        size = 0.0;
      }

      // Mouth slit — horizontal opening between the upper and lower jaw.
      if (y > -0.38 && y < -0.30 && Math.abs(x) < 0.40 && z > 0.55) {
        size = 0.0;
      }

      // Teeth — alternating bands flanking the mouth slit, both above and
      // below; the dark gaps between bands read as individual teeth.
      if (((y >= -0.30 && y < -0.20) || (y >= -0.50 && y < -0.40))
          && Math.abs(x) < 0.45 && z > 0.55) {
        const band = Math.floor((x + 0.45) * 9);
        if ((band & 1) === 0) size = 0.0;
      }
    }
    aSize[p] = size;
  }

  return { positions, aBoneA, aBoneB, aT, aPhase, aSize, aRole, aOffset };
}

function pickJoint(person, idx) {
  switch (idx) {
    case J.HEAD:       return person.head;
    case J.NECK:       return person.neck;
    case J.SHOULDER_L: return person.shoulders.l;
    case J.SHOULDER_R: return person.shoulders.r;
    case J.ELBOW_L:    return person.elbows.l;
    case J.ELBOW_R:    return person.elbows.r;
    case J.WRIST_L:    return person.wrists.l;
    case J.WRIST_R:    return person.wrists.r;
    case J.HIP_L:      return person.hips.l;
    case J.HIP_R:      return person.hips.r;
    case J.KNEE_L:     return person.knees.l;
    case J.KNEE_R:     return person.knees.r;
    case J.ANKLE_L:    return person.ankles.l;
    case J.ANKLE_R:    return person.ankles.r;
  }
  return null;
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'ghost_machine',
  name: 'Ghost in the Machine',
  contextType: 'three',

  params: [
    { id: 'particleCount', label: 'Particles',     type: 'select', options: COUNT_OPTS, default: '30000' },
    { id: 'palette',       label: 'Palette',       type: 'select', options: PALETTES,   default: 'cyan_spirit' },
    { id: 'density',       label: 'Density',       type: 'range',  min: 0.4, max: 2.5, step: 0.05, default: 1.1 },
    { id: 'swirl',         label: 'Swirl',         type: 'range',  min: 0,   max: 2.5, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total', mode: 'mul', amount: 0.25 },
      ] },
    { id: 'glow',          label: 'Glow',          type: 'range',  min: 0,   max: 2,   step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass',      mode: 'mul', amount: 0.50 },
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.40 },
      ] },
    { id: 'edgeShimmer',   label: 'Edge shimmer',  type: 'range',  min: 0,   max: 2,   step: 0.05, default: 0.8,
      modulators: [
        { source: 'audio.highs',      mode: 'mul', amount: 0.60 },
        { source: 'audio.highsPulse', mode: 'mul', amount: 0.40 },
      ] },
    { id: 'bgEnergy',      label: 'BG energy',     type: 'range',  min: 0,   max: 2,   step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.mids',      mode: 'mul', amount: 0.35 },
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.25 },
      ] },
    { id: 'flinch',        label: 'Beat flinch',   type: 'range',  min: 0,   max: 1,   step: 0.02, default: 0.4 },
    { id: 'poseTrack',     label: 'pose tracks',   type: 'toggle', default: true },
    { id: 'reactivity',    label: 'reactivity',    type: 'range',  min: 0,   max: 2,   step: 0.05, default: 1.0 },
  ],

  presets: {
    wraith:    { particleCount: '30000', palette: 'cyan_spirit',    density: 1.1, swirl: 1.0, glow: 1.0, edgeShimmer: 0.8, bgEnergy: 1.0, flinch: 0.4, reactivity: 1.0 },
    seance:    { particleCount: '30000', palette: 'magenta_wraith', density: 1.3, swirl: 1.8, glow: 1.4, edgeShimmer: 1.4, bgEnergy: 1.5, flinch: 0.6 },
    dataghost: { particleCount: '30000', palette: 'green_phantom',  density: 0.8, swirl: 0.6, glow: 0.8, edgeShimmer: 1.6, bgEnergy: 1.8, flinch: 0.3 },
    shroud:    { particleCount: '60000', palette: 'white_shroud',   density: 1.6, swirl: 0.5, glow: 1.6, edgeShimmer: 0.5, bgEnergy: 0.7, flinch: 0.5 },
  },

  autoPhase: {
    steps: [
      { palette: 'cyan_spirit',    swirl: 1.0, bgEnergy: 1.0 },
      { palette: 'magenta_wraith', swirl: 1.8, bgEnergy: 1.5 },
      { palette: 'green_phantom',  swirl: 0.6, bgEnergy: 1.8 },
      { palette: 'white_shroud',   swirl: 0.5, bgEnergy: 0.7 },
    ],
  },

  create(canvas, { renderer }) {
    const scene = new Scene();
    const camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
    camera.position.z = 5;
    camera.lookAt(0, 0, 0);

    const uJointsArr = Array.from({ length: 14 }, () => new Vector3());

    const uniforms = {
      uTime:        { value: 0 },
      uAspect:      { value: 1 },
      uSwirl:       { value: 1.0 },
      uFlinch:      { value: 0.4 },
      uGlow:        { value: 1.0 },
      uShimmer:     { value: 0.8 },
      uPointSize:   { value: 1.6 },
      uSkullRadius: { value: 0.085 },
      uBgEnergy:    { value: 1.0 },
      uIdleBlend:   { value: 1 },
      uBodyColor:   { value: new Color(0.55, 0.85, 1.00) },
      uEdgeColor:   { value: new Color(0.20, 0.55, 0.90) },
      uSkullColor:  { value: new Color(0.85, 0.95, 1.00) },
      uBgColor:     { value: new Color(0.10, 0.35, 0.65) },
      uJoints:      { value: uJointsArr },
      uBands:       { value: new Vector4() },
      uBeat:        { value: new Vector2() },
      uMids:        { value: new Vector2() },
      uHighs:       { value: new Vector2() },
      uRms:         { value: 0 },
    };

    // Background — fullscreen ortho plane, rendered first via renderOrder.
    const bgMat = new ShaderMaterial({
      uniforms,
      vertexShader:   VERT_BG,
      fragmentShader: FRAG_BG,
      depthWrite: false,
      depthTest:  false,
    });
    const bgMesh = new Mesh(new PlaneGeometry(2, 2), bgMat);
    bgMesh.renderOrder = -1;
    bgMesh.frustumCulled = false;
    scene.add(bgMesh);

    const ghostGroup = new Group();
    scene.add(ghostGroup);

    let points = null;
    let geometry = null;
    let ghostMat = null;
    let geomKey = '';

    function rebuildGeometry(count) {
      if (points) {
        ghostGroup.remove(points);
        if (geometry) geometry.dispose();
        if (ghostMat) ghostMat.dispose();
        points = null; geometry = null; ghostMat = null;
      }
      const a = generateParticles(count);
      geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(a.positions, 3));
      geometry.setAttribute('aBoneA',   new BufferAttribute(a.aBoneA,   1));
      geometry.setAttribute('aBoneB',   new BufferAttribute(a.aBoneB,   1));
      geometry.setAttribute('aT',       new BufferAttribute(a.aT,       1));
      geometry.setAttribute('aPhase',   new BufferAttribute(a.aPhase,   1));
      geometry.setAttribute('aSize',    new BufferAttribute(a.aSize,    1));
      geometry.setAttribute('aRole',    new BufferAttribute(a.aRole,    1));
      geometry.setAttribute('aOffset',  new BufferAttribute(a.aOffset,  3));

      ghostMat = new ShaderMaterial({
        uniforms,
        vertexShader:   VERT_GHOST,
        fragmentShader: FRAG_GHOST,
        transparent: true,
        depthWrite:  false,
        depthTest:   false,
        blending:    AdditiveBlending,
      });
      points = new Points(geometry, ghostMat);
      points.frustumCulled = false;
      ghostGroup.add(points);
    }

    // Per-frame smoothing state (allocated once).
    const smoothedJoints = Array.from({ length: 14 }, () => new Vector3());
    const tmpTarget = new Vector3();
    let idleBlend = 1;
    let audioRef = null;

    function update(field) {
      const audio = scaleAudio(field.audio, field.params.reactivity);
      audioRef = audio;
      const p = field.params;

      // Geometry rebuilds on count change only.
      const countStr = String(p.particleCount);
      if (countStr !== geomKey) {
        const n = parseInt(countStr, 10) || 30000;
        rebuildGeometry(n);
        geomKey = countStr;
      }

      // Palette → color uniforms.
      const pal = PALETTE_COLORS[p.palette] || PALETTE_COLORS.cyan_spirit;
      uniforms.uBodyColor.value.fromArray(pal.body);
      uniforms.uEdgeColor.value.fromArray(pal.edge);
      uniforms.uSkullColor.value.fromArray(pal.skull);
      uniforms.uBgColor.value.fromArray(pal.bg);

      // Idle-vs-pose blend.
      const person = field.pose?.people?.[0] ?? null;
      const conf = person?.confidence ?? 0;
      const wantIdle = (!p.poseTrack || !person || conf < 0.35) ? 1 : 0;
      idleBlend += (wantIdle - idleBlend) * Math.min(1, field.dt * 3.0);
      uniforms.uIdleBlend.value = idleBlend;

      const aspect = uniforms.uAspect.value;
      const lerpK = Math.min(1, field.dt * 12);

      for (let i = 0; i < 14; i++) {
        const idle = IDLE_POSE[i];
        // Slow idle drift — same per-joint phase offsets so it reads as a
        // single breathing figure, not jittering parts.
        const driftX = Math.sin(field.time * 0.30 + i * 0.4) * 0.018;
        const driftY = Math.sin(field.time * 0.45 + i * 0.7) * 0.013;

        let tx, ty, tz;
        if (idleBlend > 0.999 || !person) {
          tx = idle[0] + driftX;
          ty = idle[1] + driftY;
          tz = idle[2];
        } else {
          const lm = pickJoint(person, i);
          // Pose-to-ortho: mirror x (codebase convention, see modulation.poseHeadX).
          const px = (1.0 - lm.x) * 2.0 * aspect - aspect;
          const py = (0.5 - lm.y) * 2.0;
          const pz = -(lm.z ?? 0) * 0.5;
          // Blend toward idle when confidence is partial.
          tx = px * (1 - idleBlend) + (idle[0] + driftX) * idleBlend;
          ty = py * (1 - idleBlend) + (idle[1] + driftY) * idleBlend;
          tz = pz * (1 - idleBlend) + idle[2] * idleBlend;
        }
        tmpTarget.set(tx, ty, tz);
        smoothedJoints[i].lerp(tmpTarget, lerpK);
        uJointsArr[i].copy(smoothedJoints[i]);
      }

      uniforms.uTime.value      = field.time;
      uniforms.uSwirl.value     = p.swirl;
      uniforms.uFlinch.value    = p.flinch;
      uniforms.uGlow.value      = p.glow;
      uniforms.uShimmer.value   = p.edgeShimmer;
      uniforms.uPointSize.value = p.density * 1.6;
      uniforms.uBgEnergy.value  = p.bgEnergy;
    }

    function render() {
      if (audioRef) applyAudioUniforms(uniforms, audioRef);
      renderer.render(scene, camera);
    }

    function resize(w, h /*, dpr */) {
      const a = w / Math.max(1, h);
      camera.left = -a; camera.right = a;
      camera.top = 1; camera.bottom = -1;
      camera.updateProjectionMatrix();
      bgMesh.scale.set(a, 1, 1);
      uniforms.uAspect.value = a;
      renderer.setSize(w, h, false);
    }

    function dispose() {
      // Renderer is core-owned. Only tear down our own scene graph.
      disposeObject3D(scene);
    }

    return { resize, update, render, dispose };
  },
};
