// Atomic Orbital — a hydrogen-like wavefunction probability cloud.
// THREE.Points sampled by rejection from |ψ_nlm|² for the selected orbital.
//
// Orbitals supported (eight): 1s, 2s, 2p_x, 2p_y, 2p_z, 3d_z², 3d_xy, 4f_z³.
// Radial parts use un-normalized hydrogenic forms (Bohr radius = 1) — only
// the SHAPE matters here, not the wavefunction normalization.
//
// Modulation map (declarative):
//   audio.bass         → glow            (bass swells the cloud brightness)
//   audio.beatPulse    → glow            (kick punches it)
//   audio.beatPulse    → rotationSpeed   (kick gives a brief spin)
//   audio.highs        → glow            (high-freq shimmer)
// Inline (in update(), not via modulation engine):
//   pose head.x → camera azimuth (smoothed)
//   pose head.y → camera elevation (smoothed)
//   pose.shoulderSpan → camera distance (smoothed; lean in → zoom in)

import {
  Scene, PerspectiveCamera, Points, BufferGeometry, BufferAttribute,
  ShaderMaterial, AdditiveBlending, Color, Vector4, Vector2, Group,
} from 'three';
import { applyAudioUniforms, disposeObject3D } from '../three-host.js';
import { scaleAudio } from '../field.js';

// ─── orbitals ──────────────────────────────────────────────────────────
// Each entry: rMax (sample-box half-extent in Bohr radii) + prob(x,y,z,r)
// returning |ψ|² up to a constant. Forms simplified after R(r)²·Y(θ,φ)²:
//   1s:    e^(-2r)
//   2s:    (2 - r/2)² e^(-r)
//   2p_a:  a² · e^(-r)                           (a ∈ {x,y,z})
//   3d_z²: e^(-2r/3) · (3z² - r²)²
//   3d_xy: e^(-2r/3) · x²y²
//   4f_z³: e^(-r/2) · z² · (5z² - 3r²)²
const ORBITALS = {
  '1s':    { rMax:  6, prob: (x, y, z, r) => Math.exp(-2 * r) },
  '2s':    { rMax: 12, prob: (x, y, z, r) => {
    const t = 2 - r * 0.5; return t * t * Math.exp(-r);
  } },
  '2p_x':  { rMax: 12, prob: (x, y, z, r) => x * x * Math.exp(-r) },
  '2p_y':  { rMax: 12, prob: (x, y, z, r) => y * y * Math.exp(-r) },
  '2p_z':  { rMax: 12, prob: (x, y, z, r) => z * z * Math.exp(-r) },
  '3d_z2': { rMax: 18, prob: (x, y, z, r) => {
    const a = 3 * z * z - r * r; return Math.exp(-2 * r / 3) * a * a;
  } },
  '3d_xy': { rMax: 18, prob: (x, y, z, r) => {
    const xy = x * y; return Math.exp(-2 * r / 3) * xy * xy;
  } },
  '4f_z3': { rMax: 24, prob: (x, y, z, r) => {
    const a = 5 * z * z - 3 * r * r; return Math.exp(-r / 2) * z * z * a * a;
  } },
};

const ORBITAL_KEYS = Object.keys(ORBITALS);
const PALETTES     = ['cyan', 'magenta', 'gold', 'plasma'];
const POINT_OPTS   = ['10000', '20000', '40000', '80000'];

// Palette → (low-intensity color, high-intensity color) for the point shader.
const PALETTE_COLORS = {
  cyan:     [new Color(0.05, 0.18, 0.30), new Color(0.40, 0.95, 1.00)],
  magenta:  [new Color(0.20, 0.04, 0.20), new Color(1.00, 0.45, 0.95)],
  gold:     [new Color(0.20, 0.10, 0.02), new Color(1.00, 0.85, 0.30)],
  plasma:   [new Color(0.15, 0.02, 0.20), new Color(1.00, 0.30, 0.60)],
};

const VERT = /* glsl */`
  attribute float aIntensity;
  varying float vIntensity;
  uniform float uPointSize;
  void main() {
    vIntensity = aIntensity;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Distance-attenuated point size.
    gl_PointSize = uPointSize * (200.0 / max(0.001, -mv.z));
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying float vIntensity;
  uniform float uGlow;
  uniform vec3  uColorLow;
  uniform vec3  uColorHigh;
  uniform vec4  uBands;   // (bass, mids, highs, total)
  uniform vec2  uBeat;
  uniform vec2  uHighs;
  uniform vec2  uMids;
  uniform float uRms;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float falloff = exp(-r2 * 12.0);
    vec3 col = mix(uColorLow, uColorHigh, clamp(vIntensity, 0.0, 1.0));
    float punch = 1.0 + uBeat.y * 0.6 + uBands.x * 0.25;
    gl_FragColor = vec4(col * falloff * uGlow * punch, falloff * 0.85);
  }
`;

/** Rejection-sample `count` points distributed by |ψ|² for the named orbital. */
function sampleOrbital(orbitalKey, count) {
  const spec = ORBITALS[orbitalKey];
  if (!spec) throw new Error(`unknown orbital: ${orbitalKey}`);
  const rMax = spec.rMax;
  const prob = spec.prob;

  // Find an envelope: empirical max of prob over the box, scaled up for safety.
  let maxP = 0;
  for (let i = 0; i < 5000; i++) {
    const x = (Math.random() * 2 - 1) * rMax;
    const y = (Math.random() * 2 - 1) * rMax;
    const z = (Math.random() * 2 - 1) * rMax;
    const r = Math.hypot(x, y, z);
    const p = prob(x, y, z, r);
    if (p > maxP) maxP = p;
  }
  // Safety margin so the empirical max doesn't reject more than it should.
  maxP *= 1.5;
  if (maxP <= 0) maxP = 1;

  const positions   = new Float32Array(count * 3);
  const intensities = new Float32Array(count);
  let written  = 0;
  let attempts = 0;
  const maxAttempts = count * 250;
  while (written < count && attempts < maxAttempts) {
    attempts++;
    const x = (Math.random() * 2 - 1) * rMax;
    const y = (Math.random() * 2 - 1) * rMax;
    const z = (Math.random() * 2 - 1) * rMax;
    const r = Math.hypot(x, y, z);
    const p = prob(x, y, z, r);
    if (Math.random() < p / maxP) {
      positions[written * 3 + 0]   = x;
      positions[written * 3 + 1]   = y;
      positions[written * 3 + 2]   = z;
      intensities[written]         = Math.min(1, p / maxP);
      written++;
    }
  }
  // Shrink to actual write count (rare miss path with maxAttempts cap).
  if (written < count) {
    return {
      positions:   positions.subarray(0, written * 3),
      intensities: intensities.subarray(0, written),
    };
  }
  return { positions, intensities };
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'atomic_orbital',
  name: 'Atomic Orbital',
  contextType: 'three',

  params: [
    { id: 'orbital',       label: 'Orbital',       type: 'select', options: ORBITAL_KEYS, default: '3d_z2' },
    { id: 'pointCount',    label: 'Points',        type: 'select', options: POINT_OPTS,   default: '40000' },
    { id: 'rotationSpeed', label: 'Rotation',      type: 'range', min: 0, max: 2, step: 0.02, default: 0.4,
      modulators: [
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.60 },
      ] },
    { id: 'glow',          label: 'Glow',          type: 'range', min: 0, max: 3, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass',      mode: 'mul', amount: 0.50 },
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.40 },
        { source: 'audio.highs',     mode: 'mul', amount: 0.30 },
      ] },
    { id: 'pointSize',     label: 'Point size',    type: 'range', min: 0.4, max: 4.0, step: 0.05, default: 1.4 },
    { id: 'palette',       label: 'Palette',       type: 'select', options: PALETTES, default: 'cyan' },
    { id: 'poseTrack',     label: 'pose tracks',   type: 'toggle', default: true },
    { id: 'reactivity',    label: 'reactivity',    type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  presets: {
    s_states:     { orbital: '1s',    pointCount: '20000', rotationSpeed: 0.30, glow: 1.0, pointSize: 1.6, palette: 'cyan',    reactivity: 1.0 },
    p_orbital:    { orbital: '2p_z',  pointCount: '40000', rotationSpeed: 0.40, glow: 1.2, pointSize: 1.4, palette: 'magenta' },
    d_donut:      { orbital: '3d_z2', pointCount: '40000', rotationSpeed: 0.40, glow: 1.4, pointSize: 1.4, palette: 'gold' },
    d_clover:     { orbital: '3d_xy', pointCount: '40000', rotationSpeed: 0.50, glow: 1.3, pointSize: 1.3, palette: 'plasma' },
    f_high:       { orbital: '4f_z3', pointCount: '80000', rotationSpeed: 0.30, glow: 1.5, pointSize: 1.1, palette: 'cyan' },
  },

  create(canvas, { renderer }) {
    const scene  = new Scene();
    const camera = new PerspectiveCamera(50, canvas.width / Math.max(1, canvas.height), 0.1, 200);

    // Group hosts the points so we can spin without touching geometry.
    const cloud = new Group();
    scene.add(cloud);

    let points    = null;
    let geometry  = null;
    let material  = null;

    // Stable hash to detect param-driven geometry rebuilds.
    let geomKey = '';

    const uniforms = {
      uPointSize:  { value: 1.4 },
      uGlow:       { value: 1.0 },
      uColorLow:   { value: new Color(0, 0, 0) },
      uColorHigh:  { value: new Color(1, 1, 1) },
      uBands:      { value: new Vector4() },
      uBeat:       { value: new Vector2() },
      uMids:       { value: new Vector2() },
      uHighs:      { value: new Vector2() },
      uRms:        { value: 0 },
    };

    function rebuildGeometry(orbital, pointCount) {
      // Tear down the previous attribute buffers before creating new ones.
      if (points) {
        cloud.remove(points);
        if (geometry) geometry.dispose();
        if (material) material.dispose();
        points = null; geometry = null; material = null;
      }
      const { positions, intensities } = sampleOrbital(orbital, pointCount);
      geometry = new BufferGeometry();
      geometry.setAttribute('position',   new BufferAttribute(positions,   3));
      geometry.setAttribute('aIntensity', new BufferAttribute(intensities, 1));
      material = new ShaderMaterial({
        uniforms,
        vertexShader:   VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      points = new Points(geometry, material);
      cloud.add(points);
    }

    // Camera state — spherical coords around origin.
    let azimuth   = Math.PI * 0.5;     // smoothed look direction
    let elevation = 0.15;
    let distance  = 18.0;
    // Self-rotation of the cloud (driven by rotationSpeed).
    let spinPhase = 0;

    let audioRef = null;

    function update(field) {
      const { dt, params, channels, pose } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;

      // Rebuild geometry on orbital / pointCount change.
      const wantedCount = parseInt(params.pointCount, 10) || 40000;
      const key = `${params.orbital}|${wantedCount}`;
      if (key !== geomKey) {
        rebuildGeometry(params.orbital, wantedCount);
        geomKey = key;
      }

      // Palette colors.
      const pal = PALETTE_COLORS[params.palette] || PALETTE_COLORS.cyan;
      uniforms.uColorLow.value.copy(pal[0]);
      uniforms.uColorHigh.value.copy(pal[1]);
      uniforms.uPointSize.value = params.pointSize;
      uniforms.uGlow.value      = params.glow;

      // Smoothed pose-driven camera. Pull pose channels via field.channels
      // directly so we can apply an exponential filter ourselves — modulation
      // engine output is too jittery for camera control.
      let tAz = azimuth, tEl = elevation, tDist = distance;
      if (params.poseTrack) {
        const hx = channels?.['pose.head.x'] ?? 0;
        const hy = channels?.['pose.head.y'] ?? 0;
        const sp = channels?.['pose.shoulderSpan'] ?? 0;
        // base angles + pose offsets; head x sweeps ±90°, head y sweeps ±35°
        tAz = Math.PI * 0.5 + hx * (Math.PI * 0.5);
        tEl = -hy * 0.6;
        // shoulderSpan ∈ [-1,1]; positive (lean in) zooms in.
        tDist = 18.0 - sp * 6.0;
      }
      const k = Math.min(1, dt * 3.0);
      azimuth   += (tAz   - azimuth)   * k;
      elevation += (tEl   - elevation) * k;
      distance  += (tDist - distance)  * k;

      const cosE = Math.cos(elevation);
      camera.position.set(
        distance * cosE * Math.cos(azimuth),
        distance * Math.sin(elevation),
        distance * cosE * Math.sin(azimuth),
      );
      camera.lookAt(0, 0, 0);

      // Cloud spin — driven by the modulation-resolved rotationSpeed.
      spinPhase += dt * params.rotationSpeed;
      cloud.rotation.y = spinPhase;
    }

    function render() {
      if (audioRef) applyAudioUniforms(uniforms, audioRef);
      renderer.render(scene, camera);
    }

    function resize(w, h /*, dpr */) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }

    function dispose() {
      // Renderer is owned by core (shared across 'three' quales) — only
      // tear down our own scene graph here.
      disposeObject3D(scene);
    }

    return { resize, update, render, dispose };
  },
};
