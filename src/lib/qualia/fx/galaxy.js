// Galaxy — N-particle log-spiral disk with a Plummer-distributed bulge,
// orbits advanced in the vertex shader (angular speed ~ flat rotation curve).
// Per-particle attributes are set ONCE at boot; the vertex shader rotates
// each star's initial position about the y-axis by a time-and-radius-dependent
// delta angle, so the CPU only ever updates uniforms.
//
// Modulation map (declarative):
//   audio.bass         → bulgeGlow       (bass swells the core)
//   audio.beatPulse    → orbitSpeed      (kick gives an orbital tick)
//   audio.total        → spiralWind      (overall energy tightens / loosens arms)
// Inline (in update(), not via modulation engine):
//   pose head.x → camera azimuth (smoothed)
//   pose shoulderRoll → galactic plane tilt
//   pose headPitch → top-down vs side view (camera elevation)

import {
  Scene, PerspectiveCamera, Points, BufferGeometry, BufferAttribute,
  ShaderMaterial, AdditiveBlending, Color, Vector4, Vector2, Group,
} from 'three';
import { applyAudioUniforms, disposeObject3D } from '../three-host.js';
import { scaleAudio } from '../field.js';

const COUNT_OPTS = ['25000', '50000', '100000', '200000'];
const ARM_OPTS   = ['2', '3', '4', '5'];
const PALETTES   = ['andromeda', 'nebula', 'dense_core', 'wisp'];

// Palette → (diskCool, diskWarm, bulge) Color triples.
const PALETTE_COLORS = {
  andromeda:  { cool: [0.10, 0.20, 0.55], warm: [0.95, 0.95, 1.00], bulge: [1.00, 0.78, 0.30] },
  nebula:     { cool: [0.15, 0.55, 0.90], warm: [1.00, 0.50, 0.85], bulge: [1.00, 0.70, 0.95] },
  dense_core: { cool: [0.20, 0.10, 0.05], warm: [1.00, 0.55, 0.20], bulge: [1.00, 0.30, 0.15] },
  wisp:       { cool: [0.08, 0.55, 0.65], warm: [0.85, 0.70, 1.00], bulge: [0.65, 0.40, 1.00] },
};

// Vertex shader uses the standard built-in `position` attribute (initial
// star position at uTime=0) — no zero-buffer trick. Custom attributes are
// just (logR, color, bulge): everything radial-orbit-relevant is derivable
// from `position` itself.
const VERT = /* glsl */`
  attribute float aLogR;
  attribute float aColor;
  attribute float aBulge;

  uniform float uTime;
  uniform float uOrbitSpeed;
  uniform float uPointSize;
  uniform float uSpiralWind;

  varying float vColor;
  varying float vBulge;
  varying float vRadial;

  void main() {
    vColor = aColor;
    vBulge = aBulge;

    float r = length(position.xz);
    vRadial = r / 30.0;

    // Flat-ish rotation curve: omega ~ 1/(r + eps).
    float omega = (1.5 / max(r + 0.5, 0.5)) * uOrbitSpeed;
    float dAngle = uTime * omega + (uSpiralWind - 1.0) * aLogR;

    float ca = cos(dAngle);
    float sa = sin(dAngle);
    vec3 pos = vec3(
      ca * position.x - sa * position.z,
      position.y,
      sa * position.x + ca * position.z
    );

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    float bulgeBoost = mix(1.0, 1.6, aBulge);
    gl_PointSize = uPointSize * bulgeBoost * (250.0 / max(0.001, -mv.z));
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying float vColor;
  varying float vBulge;
  varying float vRadial;

  uniform float uBulgeGlow;
  uniform vec3  uDiskCool;
  uniform vec3  uDiskWarm;
  uniform vec3  uBulgeColor;
  uniform vec4  uBands;
  uniform vec2  uBeat;
  uniform vec2  uHighs;
  uniform vec2  uMids;
  uniform float uRms;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float falloff = exp(-r2 * 14.0);

    vec3 col;
    if (vBulge > 0.5) {
      col = uBulgeColor * (0.6 + 0.7 * uBulgeGlow + uBands.x * 0.6 + uBeat.y * 0.4);
    } else {
      col = mix(uDiskCool, uDiskWarm, vColor);
      col *= (0.55 + 0.55 * (1.0 - vRadial));
      col *= 1.0 + uBeat.y * 0.45 + uHighs.y * 0.20;
    }
    gl_FragColor = vec4(col * falloff, falloff * 0.85);
  }
`;

/** Generate the per-particle initial-position + attribute arrays. Buffers
 *  are set ONCE per (count, armCount); orbit advance is in the vertex shader. */
function generateParticles(count, armCount) {
  const positions = new Float32Array(count * 3);
  const aLogR     = new Float32Array(count);
  const aColor    = new Float32Array(count);
  const aBulge    = new Float32Array(count);

  const bulgeCount = Math.floor(count * 0.10);
  const armSpacing = (Math.PI * 2) / armCount;

  for (let i = 0; i < count; i++) {
    let r, phase, height, color, bulge;
    if (i < bulgeCount) {
      // Plummer-like radial distribution.
      const u = Math.max(1e-4, Math.random());
      r = Math.min(2.0 / Math.sqrt(Math.pow(u, -2 / 3) - 1), 9.0);
      phase = Math.random() * Math.PI * 2;
      height = (Math.random() - 0.5) * 1.6 * Math.exp(-r / 3);
      color = 0.85 + Math.random() * 0.15;
      bulge = 1.0;
    } else {
      // Exponential disk profile.
      const radial = -Math.log(1 - Math.random() * 0.95) * 6.0;
      r = Math.min(radial, 30.0);
      // Snap each disk star to the nearest of `armCount` log-spiral arms.
      // armBase at radius r is `log(r)`; the winding factor lives in the
      // shader so it can change live without rebuilding buffers.
      const armBase = Math.log(Math.max(r, 0.5));
      const armIdx  = Math.floor(Math.random() * armCount);
      const jitter  = (Math.random() - 0.5 + Math.random() - 0.5) * 0.45 * armSpacing;
      phase = armBase + armIdx * armSpacing + jitter;
      // Thin disk; thickness flares slightly at large radii.
      const flare = Math.max(0.3, 1 - r / 30);
      height = (Math.random() - 0.5) * 0.42 * flare;
      color = Math.random();
      bulge = 0.0;
    }
    positions[i * 3 + 0] = r * Math.cos(phase);
    positions[i * 3 + 1] = height;
    positions[i * 3 + 2] = r * Math.sin(phase);
    aLogR[i]  = Math.log(Math.max(r, 0.5));
    aColor[i] = color;
    aBulge[i] = bulge;
  }
  return { positions, aLogR, aColor, aBulge };
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'galaxy',
  name: 'Galaxy',
  contextType: 'three',

  params: [
    { id: 'particleCount', label: 'Particles',     type: 'select', options: COUNT_OPTS, default: '100000' },
    { id: 'armCount',      label: 'Arms',          type: 'select', options: ARM_OPTS,   default: '4' },
    { id: 'spiralWind',    label: 'Arm winding',   type: 'range', min: 0, max: 3, step: 0.05, default: 1.6,
      modulators: [
        { source: 'audio.total', mode: 'mul', amount: 0.20 },
        { source: 'crowd.spread', mode: 'mul', amount: 0.25 },
      ] },
    { id: 'orbitSpeed',    label: 'Orbit speed',   type: 'range', min: 0, max: 2, step: 0.02, default: 0.6,
      modulators: [
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.40 },
        { source: 'crowd.energy',    mode: 'mul', amount: 0.50 },
      ] },
    { id: 'bulgeGlow',     label: 'Bulge glow',    type: 'range', min: 0, max: 2, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass',      mode: 'mul', amount: 0.50 },
        { source: 'audio.beatPulse', mode: 'mul', amount: 0.30 },
        { source: 'crowd.rise',      mode: 'mul', amount: 0.60 },
      ] },
    { id: 'pointSize',     label: 'Point size',    type: 'range', min: 0.4, max: 3.0, step: 0.05, default: 1.1 },
    { id: 'palette',       label: 'Palette',       type: 'select', options: PALETTES, default: 'andromeda' },
    { id: 'poseTrack',     label: 'pose tracks',   type: 'toggle', default: true },
    { id: 'reactivity',    label: 'reactivity',    type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Auto-phase rotates palette + arm count per step — arm count rebuilds
  // the particle buffer (visible re-roll of the spiral structure) and
  // palette swaps the disk/bulge colors. Spiral wind nudges along to
  // give each step its own arm tightness.
  autoPhase: {
    steps: [
      { palette: 'andromeda',  armCount: '4', spiralWind: 1.6 },
      { palette: 'nebula',     armCount: '3', spiralWind: 2.2 },
      { palette: 'dense_core', armCount: '5', spiralWind: 1.0 },
      { palette: 'wisp',       armCount: '2', spiralWind: 2.6 },
    ],
  },

  presets: {
    andromeda:  { particleCount: '100000', armCount: '4', spiralWind: 1.6, orbitSpeed: 0.6, bulgeGlow: 1.0, pointSize: 1.1, palette: 'andromeda',  reactivity: 1.0 },
    nebula:     { particleCount: '100000', armCount: '3', spiralWind: 2.2, orbitSpeed: 0.5, bulgeGlow: 1.2, pointSize: 1.2, palette: 'nebula' },
    dense_core: { particleCount: '200000', armCount: '5', spiralWind: 1.0, orbitSpeed: 0.7, bulgeGlow: 1.6, pointSize: 0.9, palette: 'dense_core' },
    wisp:       { particleCount:  '50000', armCount: '2', spiralWind: 2.6, orbitSpeed: 0.4, bulgeGlow: 0.7, pointSize: 1.4, palette: 'wisp' },
  },

  create(canvas, { renderer }) {
    const scene  = new Scene();
    const camera = new PerspectiveCamera(50, canvas.width / Math.max(1, canvas.height), 0.1, 400);

    const galaxy = new Group();
    scene.add(galaxy);

    let points    = null;
    let geometry  = null;
    let material  = null;
    let geomKey   = '';

    const uniforms = {
      uTime:        { value: 0 },
      uOrbitSpeed:  { value: 0.6 },
      uSpiralWind:  { value: 1.6 },
      uPointSize:   { value: 1.1 },
      uBulgeGlow:   { value: 1.0 },
      uDiskCool:    { value: new Color(0.10, 0.20, 0.55) },
      uDiskWarm:    { value: new Color(0.95, 0.95, 1.00) },
      uBulgeColor:  { value: new Color(1.00, 0.78, 0.30) },
      uBands:       { value: new Vector4() },
      uBeat:        { value: new Vector2() },
      uMids:        { value: new Vector2() },
      uHighs:       { value: new Vector2() },
      uRms:         { value: 0 },
    };

    function rebuildGeometry(count, armCount) {
      if (points) {
        galaxy.remove(points);
        if (geometry) geometry.dispose();
        if (material) material.dispose();
        points = null; geometry = null; material = null;
      }
      const { positions, aLogR, aColor, aBulge } = generateParticles(count, armCount);
      geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('aLogR',    new BufferAttribute(aLogR,  1));
      geometry.setAttribute('aColor',   new BufferAttribute(aColor, 1));
      geometry.setAttribute('aBulge',   new BufferAttribute(aBulge, 1));

      material = new ShaderMaterial({
        uniforms,
        vertexShader:   VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      points = new Points(geometry, material);
      // Vertex shader rotates positions about the y-axis. The radius is
      // bounded by 30, so a static bounding sphere is correct without us
      // having to recompute it every frame. Skip frustum culling outright
      // since we always want all points drawn.
      points.frustumCulled = false;
      galaxy.add(points);
    }

    // Camera state — spherical around origin.
    let azimuth   = Math.PI * 0.6;
    let elevation = 0.45;
    let distance  = 55.0;
    let tilt      = 0.20;     // galactic plane tilt (radians)

    let audioRef = null;

    function update(field) {
      const { dt, time, params, channels } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;

      // Geometry rebuilds on count or arm change.
      const count    = parseInt(params.particleCount, 10) || 100000;
      const armCount = parseInt(params.armCount, 10) || 4;
      const key = `${count}|${armCount}`;
      if (key !== geomKey) {
        rebuildGeometry(count, armCount);
        geomKey = key;
      }

      // Palette.
      const pal = PALETTE_COLORS[params.palette] || PALETTE_COLORS.andromeda;
      uniforms.uDiskCool.value.fromArray(pal.cool);
      uniforms.uDiskWarm.value.fromArray(pal.warm);
      uniforms.uBulgeColor.value.fromArray(pal.bulge);

      uniforms.uTime.value       = time;
      uniforms.uOrbitSpeed.value = params.orbitSpeed;
      uniforms.uSpiralWind.value = params.spiralWind;
      uniforms.uPointSize.value  = params.pointSize;
      uniforms.uBulgeGlow.value  = params.bulgeGlow;

      // Pose-driven camera, smoothed.
      let tAz = azimuth, tEl = elevation, tTilt = tilt;
      if (params.poseTrack) {
        const hx    = channels?.['pose.head.x'] ?? 0;
        const roll  = channels?.['pose.shoulderRoll'] ?? 0;
        const pitch = channels?.['pose.headPitch'] ?? 0;
        tAz   = Math.PI * 0.6 + hx * (Math.PI * 0.4);
        tEl   = 0.45 + pitch * 0.35;
        tTilt = 0.20 + roll * 0.30;
      }
      const k = Math.min(1, dt * 2.5);
      azimuth   += (tAz   - azimuth)   * k;
      elevation += (tEl   - elevation) * k;
      tilt      += (tTilt - tilt)      * k;

      const cosE = Math.cos(elevation);
      camera.position.set(
        distance * cosE * Math.cos(azimuth),
        distance * Math.sin(elevation),
        distance * cosE * Math.sin(azimuth),
      );
      camera.lookAt(0, 0, 0);

      galaxy.rotation.x = tilt;
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
