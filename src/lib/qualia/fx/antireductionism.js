// Antireductionism — a "powers of ten" scale traveler that drifts through 13
// dynamically-independent strata: beyond (meta-cosmic) → cosmic web → galaxy
// → solar system → Earth → starling flock → bird → cell → molecule → atom →
// Higgs → Planck foam → beneath (sub-Planck). Each stratum visualises the
// song's thesis that reality is layered into regimes that can't be flattened
// onto one another. The two endpoints — beyond and beneath — both render as
// silent voids: where reductionism reaches its outer and inner limits.
//
// Strata live as 13 z-stacked groups in a single Three.js scene. The camera
// dollies along the depth axis; each stratum's `uOpacity` uniform fades
// gaussian-style with camera distance, so adjacent layers crossfade and far
// layers short-circuit early in the fragment shader.
//
// Modulation map (declarative):
//   audio.bass         → stratum bloom + Earth cloud density
//   audio.beatPulse    → flock cohesion pulse + travel speed
//   audio.mids         → molecular bond glow
//   audio.highs        → Planck chromatic noise + star twinkle
//   audio.rms          → Higgs grid amplitude
//   pose.shoulderSpan  → camera depth (mode='pose')
//   pose.head.x/y      → camera azimuth/elevation (smoothed)

import {
  Scene, PerspectiveCamera, OrthographicCamera, Group, Points, LineSegments,
  Mesh, BufferGeometry, BufferAttribute, ShaderMaterial, AdditiveBlending,
  NormalBlending, Color, Vector4, Vector2, Vector3, CanvasTexture, Sprite,
  SpriteMaterial, GridHelper, DoubleSide,
} from 'three';
import { applyAudioUniforms, disposeObject3D } from '../three-host.js';
import { scaleAudio } from '../field.js';
import {
  generateCosmicWeb, generateGalaxy, generateSolar, generateEarth,
  generateFlock, generateBird, generateCell, generateMolecule,
  generateAtom, generateHiggsField, generatePlanck,
  generateBeyond, generateBeneath,
} from './antireductionism-strata.js';

// ─── Stratum table ────────────────────────────────────────────────────────
// id, label, log-scale tag (for HUD), base color, low/med/high count tier.
// Two strata sit off the physical-scale axis: 'beyond' caps the top (larger
// than the cosmic web — meta-cosmic / outside-the-universe) and 'beneath'
// caps the bottom (deeper than the Planck cutoff — where parameters cease
// to model anything). Both render as quiet, near-empty voids.
const STRATA = [
  { id: 'beyond',   label: 'Beyond',      tag: '∞',      color: [0.55, 0.55, 0.70], counts: [40, 80, 140] },
  { id: 'cosmic',   label: 'Cosmic Web',  tag: '10²⁶ m', color: [0.45, 0.55, 0.95], counts: [2500, 5000, 10000] },
  { id: 'galaxy',   label: 'Galaxy',      tag: '10²¹ m', color: [0.95, 0.78, 0.30], counts: [4000, 8000, 16000] },
  { id: 'solar',    label: 'Solar System',tag: '10¹³ m', color: [1.00, 0.90, 0.45], counts: [800, 1600, 3200] },
  { id: 'earth',    label: 'Earth',       tag: '10⁷ m',  color: [0.45, 0.85, 0.95], counts: [3000, 5500, 10000] },
  { id: 'flock',    label: 'Flock',       tag: '10² m',  color: [0.85, 0.85, 0.95], counts: [220, 360, 500] },
  { id: 'bird',     label: 'Bird',        tag: '10⁻¹ m', color: [0.55, 0.75, 1.00], counts: [1, 1, 1] },
  { id: 'cell',     label: 'Cell',        tag: '10⁻⁵ m', color: [0.75, 0.55, 0.95], counts: [4000, 7000, 12000] },
  { id: 'molecule', label: 'Molecule',    tag: '10⁻⁹ m', color: [0.95, 0.55, 0.85], counts: [12, 12, 12] },
  { id: 'atom',     label: 'Atom',        tag: '10⁻¹⁰ m',color: [0.40, 0.95, 1.00], counts: [4000, 7000, 12000] },
  { id: 'higgs',    label: 'Higgs',       tag: '10⁻¹⁸ m',color: [1.00, 0.45, 0.55], counts: [60, 60, 60] },  // grid res
  { id: 'planck',   label: 'Planck',      tag: '10⁻³⁵ m',color: [1.00, 0.85, 0.40], counts: [6000, 10000, 16000] },
  { id: 'beneath',  label: 'Beneath',     tag: '0',      color: [0.40, 0.40, 0.55], counts: [60, 120, 200] },
];

const STRATUM_IDS  = STRATA.map(s => s.id);
const PARTICLE_TIERS = ['low', 'medium', 'high'];
const PALETTES = ['auto', 'cool', 'warm', 'mono', 'inferno'];
const PALETTE_TINTS = {
  auto:    null,                          // use each stratum's own tint
  cool:    [0.45, 0.65, 1.00],
  warm:    [1.00, 0.55, 0.30],
  mono:    [0.85, 0.88, 0.92],
  inferno: [1.00, 0.30, 0.20],
};
const MODES = ['travel', 'focus', 'hybrid', 'shuffle', 'pose'];

// Each stratum sits at z = -i * STRATUM_SPACING. Camera looks down -z.
const STRATUM_SPACING = 28;
const VIEW_OFFSET     = 18;     // camera lead distance in front of active z
const FALLOFF         = 18;     // gaussian crossfade σ between strata

// ─── Shared shader fragments ──────────────────────────────────────────────
// Standard preamble + a uOpacity early-discard so inactive strata cost a
// few instructions per pixel instead of full shading.
const COMMON_DECL = /* glsl */`
  uniform float uOpacity;
  uniform float uTime;
  uniform vec3  uTint;
  uniform vec4  uBands;
  uniform vec2  uBeat;
  uniform vec2  uMids;
  uniform vec2  uHighs;
  uniform float uRms;
`;

// Generic point shader — used by every stratum that draws a Points cloud
// (beyond, cosmic, galaxy disk, solar, earth, cell, atom, planck, beneath). Each
// stratum supplies a per-particle attribute that maps to colour or size.
const POINT_VERT = /* glsl */`
  ${COMMON_DECL}
  attribute float aSize;
  attribute float aBright;
  uniform float uPointSize;
  uniform float uJitter;
  uniform float uSeed;
  varying float vBright;
  varying float vSize;

  // Cheap hash → [0,1].
  float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

  void main() {
    vBright = aBright;
    vSize   = aSize;
    vec3 pos = position;
    if (uJitter > 0.0) {
      // Per-particle jitter for Planck-style foam shake. Phase = uTime + per-particle seed.
      float phase = uTime * 6.0 + uSeed + position.x * 13.0 + position.y * 17.0 + position.z * 23.0;
      pos.x += (h11(phase) - 0.5) * uJitter;
      pos.y += (h11(phase + 1.7) - 0.5) * uJitter;
      pos.z += (h11(phase + 3.1) - 0.5) * uJitter;
    }
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPointSize * aSize * (220.0 / max(0.001, -mv.z));
  }
`;

const POINT_FRAG = /* glsl */`
  precision highp float;
  ${COMMON_DECL}
  varying float vBright;
  varying float vSize;
  void main() {
    if (uOpacity < 0.005) discard;
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float falloff = exp(-r2 * 14.0);
    vec3 col = uTint * (0.45 + vBright * 0.85);
    col *= 1.0 + uBands.x * 0.45 + uBeat.y * 0.30;
    gl_FragColor = vec4(col * falloff, falloff * uOpacity * 0.92);
  }
`;

// Galaxy-disk shader — log-spiral with arms winding via uTime.
const GALAXY_VERT = /* glsl */`
  ${COMMON_DECL}
  attribute float aLogR;
  attribute float aColor;
  attribute float aBulge;
  uniform float uPointSize;
  uniform float uOrbitSpeed;
  uniform float uSpiralWind;
  varying float vColor;
  varying float vBulge;
  void main() {
    vColor = aColor;
    vBulge = aBulge;
    float r = length(position.xz);
    float omega = (1.5 / max(r + 0.5, 0.5)) * uOrbitSpeed;
    float dAngle = uTime * omega + (uSpiralWind - 1.0) * aLogR;
    float ca = cos(dAngle), sa = sin(dAngle);
    vec3 pos = vec3(
      ca * position.x - sa * position.z,
      position.y,
      sa * position.x + ca * position.z
    );
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPointSize * (220.0 / max(0.001, -mv.z)) * mix(1.0, 1.6, aBulge);
  }
`;
const GALAXY_FRAG = /* glsl */`
  precision highp float;
  ${COMMON_DECL}
  varying float vColor;
  varying float vBulge;
  void main() {
    if (uOpacity < 0.005) discard;
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float fade = exp(-r2 * 14.0);
    vec3 col;
    if (vBulge > 0.5) {
      col = uTint * (0.95 + uBands.x * 0.6);
    } else {
      col = mix(uTint * 0.30, uTint * 1.30, vColor);
    }
    col *= 1.0 + uBeat.y * 0.40;
    gl_FragColor = vec4(col * fade, fade * uOpacity * 0.85);
  }
`;

// Higgs-field shader — vertex displaces a flat plane vertically by audio-
// modulated noise sampled from the (u,v) grid coord.
const HIGGS_VERT = /* glsl */`
  ${COMMON_DECL}
  attribute vec2 aGrid;
  uniform float uAmp;
  varying float vH;
  // 2-D wave sum (fast smooth pseudo-noise).
  float h(vec2 p) {
    return sin(p.x * 1.7 + uTime * 1.1) * 0.45
         + sin(p.y * 2.2 + uTime * 0.7) * 0.35
         + sin(p.x * 4.4 + p.y * 3.3 + uTime * 1.7) * 0.22;
  }
  void main() {
    float disp = h(aGrid * 8.0) * uAmp;
    vec3 pos = position + vec3(0.0, disp, 0.0);
    vH = disp;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;
const HIGGS_FRAG = /* glsl */`
  precision highp float;
  ${COMMON_DECL}
  varying float vH;
  void main() {
    if (uOpacity < 0.005) discard;
    float bri = 0.45 + vH * 0.6 + uBands.x * 0.4;
    vec3 col = uTint * bri;
    gl_FragColor = vec4(col, uOpacity * 0.85);
  }
`;

// Bird-mesh shader — wing-flap is offset along y per aWingSide.
const BIRD_VERT = /* glsl */`
  ${COMMON_DECL}
  attribute float aWingSide;
  uniform float uFlap;
  void main() {
    vec3 pos = position;
    float bend = sin(uTime * uFlap) * 0.30 * aWingSide * abs(aWingSide);
    pos.y += bend * (1.0 + abs(position.x));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;
const BIRD_FRAG = /* glsl */`
  precision highp float;
  ${COMMON_DECL}
  void main() {
    if (uOpacity < 0.005) discard;
    vec3 col = uTint * (0.65 + uBands.x * 0.35);
    gl_FragColor = vec4(col, uOpacity * 0.92);
  }
`;

// ─── Module ───────────────────────────────────────────────────────────────
/** @type {import('../types.js').QFXModule} */
export default {
  id: 'antireductionism',
  name: 'Antireductionism',
  contextType: 'three',

  params: [
    { id: 'mode',          label: 'mode',         type: 'select', options: MODES, default: 'hybrid' },
    { id: 'focusStratum',  label: 'focus',        type: 'select', options: STRATUM_IDS, default: 'cosmic' },
    { id: 'travelSpeed',   label: 'travel speed', type: 'range', min: 0, max: 3, step: 0.05, default: 0.6,
      modulators: [
        { source: 'audio.beatPulse', mode: 'add', amount: 0.30 },
      ] },
    { id: 'dwellSec',      label: 'dwell sec',    type: 'range', min: 1, max: 12, step: 0.5, default: 5 },
    { id: 'particleScale', label: 'density',      type: 'select', options: PARTICLE_TIERS, default: 'medium' },
    { id: 'palette',       label: 'palette',      type: 'select', options: PALETTES, default: 'auto' },
    { id: 'gridLines',     label: 'grid',         type: 'toggle', default: true },
    { id: 'showLegend',    label: 'legend',       type: 'toggle', default: false },
    { id: 'reactivity',    label: 'reactivity',   type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks every stratum. The 13 steps line up with the song's
  // arc — outer void → cosmic → … → Planck → sub-Planck void.
  autoPhase: {
    steps: [
      { mode: 'focus', focusStratum: 'beyond'   },
      { mode: 'focus', focusStratum: 'cosmic'   },
      { mode: 'focus', focusStratum: 'galaxy'   },
      { mode: 'focus', focusStratum: 'solar'    },
      { mode: 'focus', focusStratum: 'earth'    },
      { mode: 'focus', focusStratum: 'flock'    },
      { mode: 'focus', focusStratum: 'bird'     },
      { mode: 'focus', focusStratum: 'cell'     },
      { mode: 'focus', focusStratum: 'molecule' },
      { mode: 'focus', focusStratum: 'atom'     },
      { mode: 'focus', focusStratum: 'higgs'    },
      { mode: 'focus', focusStratum: 'planck'   },
      { mode: 'focus', focusStratum: 'beneath'  },
    ],
  },

  presets: {
    default:   { mode: 'hybrid',  focusStratum: 'cosmic', travelSpeed: 0.6, dwellSec: 5, particleScale: 'medium', palette: 'auto',    gridLines: true,  showLegend: false, reactivity: 1.0 },
    journey:   { mode: 'travel',  travelSpeed: 0.4, palette: 'auto' },
    breakdown: { mode: 'shuffle', travelSpeed: 0.0, palette: 'inferno' },
    cosmic:    { mode: 'focus',   focusStratum: 'cosmic',   palette: 'cool'    },
    flock:     { mode: 'focus',   focusStratum: 'flock',    palette: 'mono'    },
    atom:      { mode: 'focus',   focusStratum: 'atom',     palette: 'cool'    },
    foam:      { mode: 'focus',   focusStratum: 'planck',   palette: 'inferno' },
    silence:   { mode: 'focus',   focusStratum: 'beneath',  palette: 'mono',    gridLines: false },
  },

  create(canvas, { renderer }) {
    const scene  = new Scene();
    const camera = new PerspectiveCamera(50, canvas.width / Math.max(1, canvas.height), 0.1, 800);

    // ── HUD scene + ortho camera ──────────────────────────────────────────
    // Drawn after the main scene with autoClear=false so it sits over
    // everything. Sizes itself at resize() to match canvas in pixel units.
    const hudScene = new Scene();
    const hudCamera = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
    let hudSprite = null;
    let hudCanvas, hudCtx, hudTexture;
    let lastHudActive = -1;
    function ensureHudCanvas() {
      if (hudCanvas) return;
      hudCanvas = document.createElement('canvas');
      hudCanvas.width = 220;
      hudCanvas.height = 720;
      hudCtx = hudCanvas.getContext('2d');
      hudTexture = new CanvasTexture(hudCanvas);
      hudTexture.needsUpdate = true;
      const mat = new SpriteMaterial({ map: hudTexture, transparent: true, depthWrite: false });
      hudSprite = new Sprite(mat);
      hudScene.add(hudSprite);
    }
    function repaintHud(activeIdx) {
      if (!hudCtx) return;
      const W = hudCanvas.width, H = hudCanvas.height;
      hudCtx.clearRect(0, 0, W, H);
      // Frame background — matches the PBS reference's right-edge ribbon.
      hudCtx.fillStyle = 'rgba(0,0,0,0.65)';
      hudCtx.fillRect(0, 0, W, H);
      hudCtx.strokeStyle = 'rgba(255,255,255,0.18)';
      hudCtx.lineWidth = 2;
      hudCtx.strokeRect(1, 1, W - 2, H - 2);
      // Stratum labels.
      const rowH = H / STRATA.length;
      hudCtx.font = "16px 'JetBrains Mono', ui-monospace, monospace";
      hudCtx.textBaseline = 'middle';
      hudCtx.textAlign = 'left';
      for (let i = 0; i < STRATA.length; i++) {
        const y = (i + 0.5) * rowH;
        const isActive = i === activeIdx;
        hudCtx.fillStyle = isActive ? 'rgba(255,255,255,0.95)' : 'rgba(220,225,235,0.65)';
        hudCtx.font = isActive
          ? "bold 16px 'JetBrains Mono', ui-monospace, monospace"
          : "15px 'JetBrains Mono', ui-monospace, monospace";
        hudCtx.fillText(STRATA[i].label, 20, y);
        hudCtx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
        hudCtx.fillStyle = isActive ? 'rgba(180,200,255,0.85)' : 'rgba(140,160,190,0.55)';
        hudCtx.fillText(STRATA[i].tag, 20, y + 18);
        if (isActive) {
          // Triangle marker on the left edge.
          hudCtx.fillStyle = 'rgba(255,255,255,0.95)';
          hudCtx.beginPath();
          hudCtx.moveTo(8, y);
          hudCtx.lineTo(2, y - 6);
          hudCtx.lineTo(2, y + 6);
          hudCtx.closePath();
          hudCtx.fill();
        }
      }
      hudTexture.needsUpdate = true;
    }

    // ── Stratum builders ──────────────────────────────────────────────────
    // Each stratum entry: { id, group, materials[], uniforms, points/mesh }.
    // We construct all 12 at create() time; particleScale changes rebuild
    // affected strata only.
    const stratumMap = new Map();
    function makeStandardUniforms(tint) {
      return {
        uTime:       { value: 0 },
        uOpacity:    { value: 0 },
        uTint:       { value: new Color(tint[0], tint[1], tint[2]) },
        uPointSize:  { value: 1.4 },
        uJitter:     { value: 0 },
        uSeed:       { value: Math.random() * 100 },
        uBands:      { value: new Vector4() },
        uBeat:       { value: new Vector2() },
        uMids:       { value: new Vector2() },
        uHighs:      { value: new Vector2() },
        uRms:        { value: 0 },
      };
    }

    function buildPointsStratum(spec, posArr, sizeArr, brightArr, opts = {}) {
      const group = new Group();
      const uniforms = makeStandardUniforms(spec.color);
      uniforms.uPointSize.value = opts.pointSize ?? 1.4;
      uniforms.uJitter.value = opts.jitter ?? 0;
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(posArr, 3));
      geom.setAttribute('aSize',    new BufferAttribute(sizeArr, 1));
      geom.setAttribute('aBright',  new BufferAttribute(brightArr, 1));
      const mat = new ShaderMaterial({
        uniforms,
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const pts = new Points(geom, mat);
      pts.frustumCulled = false;
      group.add(pts);
      return { id: spec.id, group, uniforms, materials: [mat], geometries: [geom], objects: [pts] };
    }

    function buildCosmic(spec, count) {
      const { positions, aSize, aBright } = generateCosmicWeb(count, 60);
      return buildPointsStratum(spec, positions, aSize, aBright, { pointSize: 1.3 });
    }

    function buildGalaxy(spec, count) {
      const { positions, aLogR, aColor, aBulge } = generateGalaxy(count, 4, 14);
      const group = new Group();
      const uniforms = makeStandardUniforms(spec.color);
      uniforms.uPointSize  = { value: 1.4 };
      uniforms.uOrbitSpeed = { value: 0.6 };
      uniforms.uSpiralWind = { value: 1.6 };
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(positions, 3));
      geom.setAttribute('aLogR',    new BufferAttribute(aLogR,  1));
      geom.setAttribute('aColor',   new BufferAttribute(aColor, 1));
      geom.setAttribute('aBulge',   new BufferAttribute(aBulge, 1));
      const mat = new ShaderMaterial({
        uniforms,
        vertexShader: GALAXY_VERT,
        fragmentShader: GALAXY_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const pts = new Points(geom, mat);
      pts.frustumCulled = false;
      group.add(pts);
      return { id: spec.id, group, uniforms, materials: [mat], geometries: [geom], objects: [pts] };
    }

    function buildSolar(spec, count) {
      const { positions, aRing } = generateSolar(count);
      const aSize = new Float32Array(positions.length / 3);
      const aBright = new Float32Array(positions.length / 3);
      for (let i = 0; i < aSize.length; i++) {
        // Star particles are bigger + brighter; ring particles are tiny dots.
        if (aRing[i] > 0.5) { aSize[i] = 0.8; aBright[i] = 0.5 + Math.random() * 0.4; }
        else                 { aSize[i] = 1.7; aBright[i] = 0.9 + Math.random() * 0.1; }
      }
      return buildPointsStratum(spec, positions, aSize, aBright, { pointSize: 1.5 });
    }

    function buildEarth(spec, count) {
      const { positions, aLand } = generateEarth(count);
      const aSize = new Float32Array(aLand.length);
      const aBright = new Float32Array(aLand.length);
      for (let i = 0; i < aLand.length; i++) {
        // Land particles brighter; water dimmer.
        aSize[i] = aLand[i] > 0.05 ? 1.2 : 0.8;
        aBright[i] = 0.45 + aLand[i] * 0.55;
      }
      return buildPointsStratum(spec, positions, aSize, aBright, { pointSize: 2.4 });
    }

    function buildFlock(spec, count) {
      const { positions, velocities } = generateFlock(count);
      const aSize = new Float32Array(count);
      const aBright = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        aSize[i] = 1.2 + Math.random() * 0.6;
        aBright[i] = 0.55 + Math.random() * 0.45;
      }
      const wrapped = buildPointsStratum(spec, positions, aSize, aBright, { pointSize: 3.0 });
      // Stash the boid state on the object so update() can advance it.
      wrapped.boids = {
        velocities,
        positionAttr: wrapped.geometries[0].getAttribute('position'),
        count,
      };
      return wrapped;
    }

    function buildBird(spec) {
      const { positions, aWingSide, indices } = generateBird();
      const group = new Group();
      // Scale up to be visible at the bird stratum.
      group.scale.setScalar(2.2);
      const uniforms = makeStandardUniforms(spec.color);
      uniforms.uFlap = { value: 8.0 };     // wing-flap rate
      const geom = new BufferGeometry();
      geom.setAttribute('position',  new BufferAttribute(positions, 3));
      geom.setAttribute('aWingSide', new BufferAttribute(aWingSide, 1));
      geom.setIndex(new BufferAttribute(indices, 1));
      geom.computeVertexNormals();
      const mat = new ShaderMaterial({
        uniforms,
        vertexShader: BIRD_VERT,
        fragmentShader: BIRD_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: NormalBlending,
      });
      const mesh = new Mesh(geom, mat);
      mesh.frustumCulled = false;
      group.add(mesh);
      return { id: spec.id, group, uniforms, materials: [mat], geometries: [geom], objects: [mesh] };
    }

    function buildCell(spec, count) {
      const { positions, aOrganelle } = generateCell(count);
      const aSize = new Float32Array(aOrganelle.length);
      const aBright = new Float32Array(aOrganelle.length);
      for (let i = 0; i < aOrganelle.length; i++) {
        aSize[i] = aOrganelle[i] > 0 ? 1.5 + aOrganelle[i] * 0.8 : 0.7;
        aBright[i] = aOrganelle[i] > 0 ? 0.85 + aOrganelle[i] * 0.15 : 0.30 + Math.random() * 0.30;
      }
      return buildPointsStratum(spec, positions, aSize, aBright, { pointSize: 2.0 });
    }

    function buildMolecule(spec) {
      const group = new Group();
      group.scale.setScalar(2.0);
      const { atomPositions, atomKind, atomRadius, bondPairs } = generateMolecule();
      // Atoms as a Points cloud with size attribute = radius.
      const N = atomPositions.length / 3;
      const aSize = new Float32Array(N);
      const aBright = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        aSize[i] = atomRadius[i] * 6.0;
        aBright[i] = 0.85 + atomKind[i] * 0.15;
      }
      const uniforms = makeStandardUniforms(spec.color);
      uniforms.uPointSize.value = 2.5;
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(atomPositions, 3));
      geom.setAttribute('aSize',    new BufferAttribute(aSize, 1));
      geom.setAttribute('aBright',  new BufferAttribute(aBright, 1));
      const mat = new ShaderMaterial({
        uniforms,
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const pts = new Points(geom, mat);
      pts.frustumCulled = false;
      group.add(pts);
      // Bonds as line segments with their own simple material reusing uniforms.
      const bondPositions = new Float32Array(bondPairs.length * 3);
      for (let i = 0; i < bondPairs.length; i++) {
        const p = bondPairs[i] * 3;
        bondPositions[i * 3 + 0] = atomPositions[p + 0];
        bondPositions[i * 3 + 1] = atomPositions[p + 1];
        bondPositions[i * 3 + 2] = atomPositions[p + 2];
      }
      const bondGeom = new BufferGeometry();
      bondGeom.setAttribute('position', new BufferAttribute(bondPositions, 3));
      const bondMat = new ShaderMaterial({
        uniforms,
        vertexShader: /* glsl */`
          ${COMMON_DECL}
          void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */`
          precision highp float;
          ${COMMON_DECL}
          void main() {
            if (uOpacity < 0.005) discard;
            vec3 col = uTint * (0.55 + uMids.y * 0.45);
            gl_FragColor = vec4(col, uOpacity * 0.85);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const bonds = new LineSegments(bondGeom, bondMat);
      bonds.frustumCulled = false;
      group.add(bonds);
      return { id: spec.id, group, uniforms, materials: [mat, bondMat], geometries: [geom, bondGeom], objects: [pts, bonds] };
    }

    function buildAtom(spec, count) {
      const { positions, intensities } = generateAtom(count, '1s', 6);
      const N = positions.length / 3;
      const aSize = new Float32Array(N);
      const aBright = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        aSize[i] = 0.9 + Math.random() * 0.5;
        aBright[i] = 0.30 + intensities[i] * 0.70;
      }
      return buildPointsStratum(spec, positions, aSize, aBright, { pointSize: 1.6 });
    }

    function buildHiggs(spec, gridN) {
      const { positions, aGrid, lineIdx } = generateHiggsField(gridN, 8);
      const group = new Group();
      const uniforms = makeStandardUniforms(spec.color);
      uniforms.uAmp = { value: 0.6 };
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(positions, 3));
      geom.setAttribute('aGrid',    new BufferAttribute(aGrid, 2));
      geom.setIndex(new BufferAttribute(lineIdx, 1));
      const mat = new ShaderMaterial({
        uniforms,
        vertexShader: HIGGS_VERT,
        fragmentShader: HIGGS_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const lines = new LineSegments(geom, mat);
      lines.frustumCulled = false;
      group.add(lines);
      return { id: spec.id, group, uniforms, materials: [mat], geometries: [geom], objects: [lines] };
    }

    function buildPlanck(spec, count) {
      const { positions } = generatePlanck(count, 4);
      const N = positions.length / 3;
      const aSize = new Float32Array(N);
      const aBright = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        aSize[i] = 0.5 + Math.random() * 0.4;
        aBright[i] = 0.30 + Math.random() * 0.70;
      }
      // POINT_VERT folds a per-particle hash from `position` into the jitter
      // phase, so we don't need to upload an aSeed attribute — the position
      // itself already decorrelates each foam point's wobble.
      return buildPointsStratum(spec, positions, aSize, aBright, { pointSize: 1.0, jitter: 0.06 });
    }

    function buildBeneath(spec, count) {
      const { positions, aLife } = generateBeneath(count, 30);
      const N = positions.length / 3;
      const aSize = new Float32Array(N);
      const aBright = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        aSize[i] = 0.6 + aLife[i] * 0.4;
        aBright[i] = 0.20 + aLife[i] * 0.30;
      }
      return buildPointsStratum(spec, positions, aSize, aBright, { pointSize: 0.9 });
    }

    function buildBeyond(spec, count) {
      const { positions, aLife } = generateBeyond(count, 60);
      const N = positions.length / 3;
      const aSize = new Float32Array(N);
      const aBright = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        // Meta-cosmic ghosts: faint baseline + the rare bright speck.
        aSize[i] = 0.5 + aLife[i] * 0.7;
        aBright[i] = 0.15 + aLife[i] * 0.55;
      }
      return buildPointsStratum(spec, positions, aSize, aBright, { pointSize: 1.1 });
    }

    function buildAllStrata(tier) {
      // Tear down existing strata first if any.
      for (const s of stratumMap.values()) {
        scene.remove(s.group);
        for (const g of s.geometries) g.dispose();
        for (const m of s.materials)  m.dispose();
      }
      stratumMap.clear();
      const tierIdx = PARTICLE_TIERS.indexOf(tier);
      const idx = tierIdx >= 0 ? tierIdx : 1;
      for (let i = 0; i < STRATA.length; i++) {
        const spec = STRATA[i];
        const count = spec.counts[idx];
        let s;
        switch (spec.id) {
          case 'cosmic':   s = buildCosmic(spec, count); break;
          case 'galaxy':   s = buildGalaxy(spec, count); break;
          case 'solar':    s = buildSolar(spec, count); break;
          case 'earth':    s = buildEarth(spec, count); break;
          case 'flock':    s = buildFlock(spec, count); break;
          case 'bird':     s = buildBird(spec); break;
          case 'cell':     s = buildCell(spec, count); break;
          case 'molecule': s = buildMolecule(spec); break;
          case 'atom':     s = buildAtom(spec, count); break;
          case 'higgs':    s = buildHiggs(spec, count); break;
          case 'planck':   s = buildPlanck(spec, count); break;
          case 'beyond':   s = buildBeyond(spec, count); break;
          case 'beneath':  s = buildBeneath(spec, count); break;
          default: continue;
        }
        // Position stratum at z = -i * SPACING.
        s.group.position.z = -i * STRATUM_SPACING;
        s.zCenter = -i * STRATUM_SPACING;
        scene.add(s.group);
        stratumMap.set(spec.id, s);
      }
    }

    // ── Optional ground / back grid (PBS reference look) ──────────────────
    let gridGroup = null;
    function ensureGrid(on) {
      if (on && !gridGroup) {
        gridGroup = new Group();
        // Faint grid behind the strata.
        const gh = new GridHelper(60, 30, 0xffffff, 0x444444);
        gh.material.transparent = true;
        gh.material.opacity = 0.10;
        gh.position.y = -8;
        gridGroup.add(gh);
        scene.add(gridGroup);
      } else if (!on && gridGroup) {
        scene.remove(gridGroup);
        disposeObject3D(gridGroup);
        gridGroup = null;
      }
    }

    // ── State ─────────────────────────────────────────────────────────────
    let geomKey = '';
    let cameraTravel = 0;     // smoothed camera z-position (negative = into depth)
    let lastShuffleAt = -10;
    let dwellAccum = 0;
    let dwellTargetIdx = 0;
    let activeStratumIdx = 0;

    // Camera state — orbit around active stratum.
    let azimuth = 0, elevation = 0.10;

    let audioRef = null;
    let legendOn = true;

    // ── Helpers ───────────────────────────────────────────────────────────
    function clampIdx(i) {
      if (i < 0) return 0;
      if (i >= STRATA.length) return STRATA.length - 1;
      return i;
    }
    function stratumIndexFromTravel(travelZ) {
      // travelZ is negative; idx 0 is at z=0, idx 11 is at z = -11 * SPACING.
      const fIdx = -travelZ / STRATUM_SPACING;
      return clampIdx(Math.round(fIdx));
    }
    function stratumZ(idx) { return -idx * STRATUM_SPACING; }
    function stratumIdToIdx(id) {
      for (let i = 0; i < STRATA.length; i++) if (STRATA[i].id === id) return i;
      return 0;
    }

    function setActivePalette(palette) {
      const pal = PALETTE_TINTS[palette];
      for (const s of stratumMap.values()) {
        const baseColor = STRATA.find(x => x.id === s.id).color;
        if (pal == null) {
          // 'auto' — restore stratum's own tint.
          s.uniforms.uTint.value.setRGB(baseColor[0], baseColor[1], baseColor[2]);
        } else {
          s.uniforms.uTint.value.setRGB(pal[0], pal[1], pal[2]);
        }
      }
    }

    // Boids integrator. Cohesion / separation / alignment in O(N²) with an
    // early-distance cull. N is small (~360) so this stays cheap.
    function updateBoids(s, dt, beatPulse) {
      const { velocities, positionAttr, count } = s.boids;
      const positions = positionAttr.array;
      const PERCEPTION = 1.6, PERCEPTION2 = PERCEPTION * PERCEPTION;
      const SEP_RAD = 0.45, SEP_RAD2 = SEP_RAD * SEP_RAD;
      const COH_K = 0.35 + beatPulse * 0.40;
      const ALI_K = 0.45;
      const SEP_K = 0.85;
      const MAX_SP = 4.5;
      const BOX = 5.0;
      for (let i = 0; i < count; i++) {
        const ix = i * 3;
        const px = positions[ix], py = positions[ix + 1], pz = positions[ix + 2];
        let vx = velocities[ix], vy = velocities[ix + 1], vz = velocities[ix + 2];
        let cx = 0, cy = 0, cz = 0, axv = 0, ayv = 0, azv = 0;
        let sx = 0, sy = 0, sz = 0, neigh = 0;
        for (let j = 0; j < count; j++) {
          if (j === i) continue;
          const jx = j * 3;
          const dx = positions[jx] - px;
          const dy = positions[jx + 1] - py;
          const dz = positions[jx + 2] - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > PERCEPTION2) continue;
          neigh++;
          cx += positions[jx]; cy += positions[jx + 1]; cz += positions[jx + 2];
          axv += velocities[jx]; ayv += velocities[jx + 1]; azv += velocities[jx + 2];
          if (d2 < SEP_RAD2 && d2 > 1e-6) {
            const inv = 1.0 / d2;
            sx -= dx * inv; sy -= dy * inv; sz -= dz * inv;
          }
        }
        if (neigh > 0) {
          cx = cx / neigh - px; cy = cy / neigh - py; cz = cz / neigh - pz;
          axv = axv / neigh - vx; ayv = ayv / neigh - vy; azv = azv / neigh - vz;
        }
        // Boundary nudge — keep birds in the box.
        const bx = -px * 0.10, by = -py * 0.18, bz = -pz * 0.10;
        vx += (cx * COH_K + axv * ALI_K + sx * SEP_K + bx) * dt;
        vy += (cy * COH_K + ayv * ALI_K + sy * SEP_K + by) * dt;
        vz += (cz * COH_K + azv * ALI_K + sz * SEP_K + bz) * dt;
        // Limit speed.
        const sp = Math.hypot(vx, vy, vz);
        if (sp > MAX_SP) {
          const k = MAX_SP / sp;
          vx *= k; vy *= k; vz *= k;
        }
        // Integrate.
        positions[ix]     = px + vx * dt;
        positions[ix + 1] = py + vy * dt;
        positions[ix + 2] = pz + vz * dt;
        velocities[ix]     = vx;
        velocities[ix + 1] = vy;
        velocities[ix + 2] = vz;
        // Soft wrap.
        if (positions[ix]     >  BOX) positions[ix]     = -BOX;
        if (positions[ix]     < -BOX) positions[ix]     =  BOX;
        if (positions[ix + 1] >  BOX) positions[ix + 1] = -BOX;
        if (positions[ix + 1] < -BOX) positions[ix + 1] =  BOX;
        if (positions[ix + 2] >  BOX) positions[ix + 2] = -BOX;
        if (positions[ix + 2] < -BOX) positions[ix + 2] =  BOX;
      }
      positionAttr.needsUpdate = true;
    }

    // ── Update / Render ───────────────────────────────────────────────────
    function update(field) {
      const { dt, time, params, channels } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;

      // Geometry rebuilds when particleScale changes.
      const tier = params.particleScale || 'medium';
      const key = tier;
      if (key !== geomKey) {
        buildAllStrata(tier);
        setActivePalette(params.palette);
        geomKey = key;
      }

      ensureGrid(!!params.gridLines);
      ensureHudCanvas();

      setActivePalette(params.palette);

      // ── Mode logic — pick a target travel z ───────────────────────────
      let targetZ = cameraTravel;
      const focusIdx = stratumIdToIdx(params.focusStratum);
      switch (params.mode) {
        case 'travel': {
          // Smoothly advance and wrap.
          targetZ = cameraTravel - params.travelSpeed * dt * STRATUM_SPACING * 0.25;
          if (targetZ < -(STRATA.length - 1) * STRATUM_SPACING - STRATUM_SPACING * 0.5) {
            targetZ = STRATUM_SPACING * 0.5;
          }
          break;
        }
        case 'focus': {
          targetZ = stratumZ(focusIdx);
          break;
        }
        case 'hybrid': {
          // Travel through strata but pause `dwellSec` on each. dwellAccum
          // measures time spent at the current target before moving on.
          dwellAccum += dt;
          if (dwellAccum >= params.dwellSec) {
            dwellTargetIdx = (dwellTargetIdx + 1) % STRATA.length;
            dwellAccum = 0;
          }
          targetZ = stratumZ(dwellTargetIdx);
          break;
        }
        case 'shuffle': {
          // On hard kicks (with cooldown) jump to a random stratum.
          if (audio.beat.active && (time - lastShuffleAt) > 1.4 && audio.beat.pulse > 0.6) {
            dwellTargetIdx = Math.floor(Math.random() * STRATA.length);
            lastShuffleAt = time;
          }
          targetZ = stratumZ(dwellTargetIdx);
          break;
        }
        case 'pose': {
          const sp = channels?.['pose.shoulderSpan'] ?? 0;
          // sp ∈ [-1, 1]; lean in (positive) → deeper strata.
          const t = (sp + 1) * 0.5;
          targetZ = stratumZ(Math.round(t * (STRATA.length - 1)));
          break;
        }
      }
      // Smooth camera travel toward target.
      const k = Math.min(1, dt * 1.6);
      cameraTravel += (targetZ - cameraTravel) * k;

      // ── Pose-driven azimuth/elevation (smoothed) ──────────────────────
      const hx = channels?.['pose.head.x'] ?? 0;
      const hy = channels?.['pose.head.y'] ?? 0;
      const tAz = hx * 0.4;
      const tEl = 0.10 - hy * 0.30;
      const ck = Math.min(1, dt * 2.5);
      azimuth   += (tAz - azimuth)   * ck;
      elevation += (tEl - elevation) * ck;

      const camDist = VIEW_OFFSET;
      const cosE = Math.cos(elevation);
      camera.position.set(
        Math.sin(azimuth) * cosE * camDist,
        Math.sin(elevation) * camDist,
        cameraTravel + Math.cos(azimuth) * cosE * camDist,
      );
      camera.lookAt(0, 0, cameraTravel);

      // ── Stratum opacity crossfade + per-stratum dynamic uniforms ──────
      activeStratumIdx = stratumIndexFromTravel(cameraTravel);
      let bestOp = -1, bestIdx = 0;
      for (let i = 0; i < STRATA.length; i++) {
        const s = stratumMap.get(STRATA[i].id);
        if (!s) continue;
        const dz = cameraTravel - s.zCenter;
        const opacity = Math.exp(-(dz * dz) / (FALLOFF * FALLOFF));
        s.uniforms.uOpacity.value = opacity;
        s.uniforms.uTime.value = time;
        if (opacity > bestOp) { bestOp = opacity; bestIdx = i; }
      }
      activeStratumIdx = bestIdx;

      // ── Per-stratum special updates ───────────────────────────────────
      // Galaxy: live orbit speed + spiral wind from audio.
      const galaxy = stratumMap.get('galaxy');
      if (galaxy) {
        galaxy.uniforms.uOrbitSpeed.value = 0.6 + audio.beat.pulse * 0.4;
        galaxy.uniforms.uSpiralWind.value = 1.6 + audio.bands.total * 0.6;
      }
      // Earth: gentle rotation + small displacement on bass.
      const earth = stratumMap.get('earth');
      if (earth) {
        earth.group.rotation.y += dt * 0.08;
        earth.uniforms.uPointSize.value = 2.4 + audio.bands.bass * 1.2;
      }
      // Bird: flap rate from beat.
      const bird = stratumMap.get('bird');
      if (bird) {
        bird.uniforms.uFlap.value = 6.0 + audio.beat.pulse * 6.0;
        bird.group.rotation.y += dt * 0.4;
      }
      // Cell: slow spin.
      const cell = stratumMap.get('cell');
      if (cell) cell.group.rotation.y += dt * 0.18;
      // Molecule: tumble.
      const molecule = stratumMap.get('molecule');
      if (molecule) {
        molecule.group.rotation.y += dt * 0.5;
        molecule.group.rotation.x += dt * 0.2;
      }
      // Atom: spin.
      const atom = stratumMap.get('atom');
      if (atom) atom.group.rotation.y += dt * 0.3;
      // Higgs: amplitude from RMS.
      const higgs = stratumMap.get('higgs');
      if (higgs) higgs.uniforms.uAmp.value = 0.4 + audio.rms * 1.6 + audio.beat.pulse * 0.6;
      // Planck: jitter scales with highs.
      const planck = stratumMap.get('planck');
      if (planck) planck.uniforms.uJitter.value = 0.04 + audio.bands.highs * 0.08;
      // Flock: only integrate when active enough to be visible.
      const flock = stratumMap.get('flock');
      if (flock && flock.boids) {
        if (flock.uniforms.uOpacity.value > 0.05) {
          updateBoids(flock, Math.min(dt, 1 / 30), audio.beat.pulse);
        }
      }

      // ── HUD ribbon: repaint only when the active stratum changes ──────
      legendOn = !!params.showLegend;
      if (legendOn && activeStratumIdx !== lastHudActive) {
        repaintHud(activeStratumIdx);
        lastHudActive = activeStratumIdx;
      }
    }

    function render() {
      if (audioRef) {
        for (const s of stratumMap.values()) {
          applyAudioUniforms(s.uniforms, audioRef);
        }
      }
      renderer.autoClear = true;
      renderer.render(scene, camera);
      if (legendOn) {
        renderer.autoClear = false;
        renderer.render(hudScene, hudCamera);
        renderer.autoClear = true;
      }
    }

    function resize(w, h /*, dpr */) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      // Pin HUD sprite to right edge: ortho frustum is [-aspect,aspect] × [-1,1].
      const aspect = w / Math.max(1, h);
      hudCamera.left = -aspect;
      hudCamera.right = aspect;
      hudCamera.top = 1;
      hudCamera.bottom = -1;
      hudCamera.updateProjectionMatrix();
      if (hudSprite) {
        // Sprite scale in world units (which equal NDC for the ortho cam).
        const ribbonH = 1.5;
        const ribbonW = ribbonH * (hudCanvas.width / hudCanvas.height);
        hudSprite.scale.set(ribbonW, ribbonH, 1);
        hudSprite.position.set(aspect - ribbonW * 0.55, 0, 0);
      }
    }

    function dispose() {
      // Tear down our scene graph; renderer is core-owned.
      disposeObject3D(scene);
      disposeObject3D(hudScene);
      if (hudTexture) hudTexture.dispose();
      stratumMap.clear();
    }

    return { resize, update, render, dispose };
  },
};
