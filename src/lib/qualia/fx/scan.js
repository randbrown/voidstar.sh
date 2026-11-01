// Scan — a 3D scan (Polycam GLB, PLY point cloud, Gaussian-splat PLY/SPZ) as
// an audio-reactive point cloud. The file is parsed, surface-sampled into N
// points, leveled onto its tabletop/floor and annotated off the main thread
// (scan-worker.js → scan-cloud.js); per frame the CPU only writes uniforms.
//
// Every point carries: colour (from the scan texture), normal, a figure mask
// (above the ground plane vs. the ground itself), a surface distance from the
// figure's top (geodesic-ish — voxel Dijkstra), and a random seed.
//
// Modes:
//   strata  — the figure is a 3D spectrum analyser: height → log-frequency
//             band (bass at the feet, highs at the head); the ground carries
//             the same spectrum outward by radius.
//   ripple  — each kick launches a ring that crawls DOWN the surface from
//             the head and spreads out across the ground. With no beats
//             (ambient sets) rings self-launch so it never stalls.
//   shatter — points blow out along their normals on the beat and spring
//             back; mids stir a slow swirl.
//   sweep   — a LiDAR-style scan plane climbs the figure; points light as it
//             passes and leave an afterglow, so the object keeps re-scanning
//             itself. Highs scatter the scan line.
//
// Modulation map (declarative):
//   audio.beatPulse → burst      (kick blows points out along normals)
//   crowd.energy    → burst      (the audience can blow it apart)
//   audio.total     → speed      (ripple / sweep / swirl rate)
//   audio.rms       → pointSize
// Inline: beat rising edge → ripple launch; spectrum → strata bands;
//   pose head.x → orbit offset, pose headPitch → camera elevation (smoothed).
//
// Loading: pick a .glb / .ply / .spz in the `scan` param. The last file is kept in
// IndexedDB (scan-store.js) and restored on reload; with nothing loaded (or
// `source: monolith`) a procedural monolith runs through the same pipeline.
// GLB limits: uncompressed only (no Draco/meshopt), first base-colour texture.

import {
  Scene, PerspectiveCamera, Points, BufferGeometry, BufferAttribute,
  ShaderMaterial, AdditiveBlending, NormalBlending, Vector4, Vector2,
} from 'three';
import { applyAudioUniforms, disposeObject3D } from '../three-host.js';
import { scaleAudio } from '../field.js';
import { loadLastScan, saveLastScan } from '../scan-store.js';

const COUNT_OPTS = ['50000', '100000', '200000', '400000'];
const MODES      = ['strata', 'ripple', 'shatter', 'sweep'];
const PALETTES   = ['scan', 'mono', 'thermal', 'void'];
const SPEC_N     = 32;
const RINGS      = 4;
const RING_IDLE  = 99;        // age that marks a ring slot as unused
const RING_KEYS  = ['x', 'y', 'z', 'w'];

// Survives quale switches: the source bytes and the last processed cloud, so
// coming back to Scan doesn't re-read IndexedDB or re-run the worker.
const shared = {
  source: null,       // { name, bytes } — null → monolith
  serial: 0,          // bumps on every new source
  lastFile: null,     // the File object last read from the param
  restore: 'idle',    // 'idle' | 'pending' | 'done'
  cloud: null,
  cloudKey: '',
};

const VERT = /* glsl */`
  attribute vec3 aColor;
  attribute float aDist;
  attribute float aFig;
  attribute float aRand;

  uniform float uTime;
  uniform float uMode;
  uniform float uPointSize;
  uniform float uPx;
  uniform float uDensity;
  uniform float uBurst;
  uniform float uRingSpeed;
  uniform vec4  uRings;
  uniform float uSweep;
  uniform float uReveal;
  uniform float uGround;
  uniform float uAudioOn;
  uniform float uSpec[${SPEC_N}];
  uniform vec4  uBands;
  uniform vec2  uBeat;
  uniform vec2  uHighs;
  uniform float uRms;

  varying vec3  vColor;
  varying float vEnergy;
  varying float vBright;
  varying float vHeight;
  varying float vAlpha;
  varying float vFig;

  float ring(float age) {
    if (age < 0.0 || age > 12.0) return 0.0;
    float x = (aDist - age * uRingSpeed) / 0.05;
    return exp(-x * x) * exp(-age * 0.45);
  }

  vec3 swirl(vec3 p, float t) {
    return vec3(
      sin(p.y * 7.0 + t * 1.3 + aRand * 6.28),
      sin(p.z * 6.0 - t * 1.1 + aRand * 3.10),
      sin(p.x * 8.0 + t * 0.9 + aRand * 4.70)
    );
  }

  void main() {
    vec3 p = position;
    vec3 n = normal;
    float r = length(p.xz);
    float bright = 1.0;
    float energy = 0.0;

    if (uMode < 0.5) {
      // strata — figure height / ground radius → spectrum band
      float s = aFig > 0.5 ? clamp(p.y, 0.0, 0.999) : clamp((r - 0.15) / 2.0, 0.0, 0.999);
      float e = uSpec[int(s * ${SPEC_N}.0)];
      energy = e;
      vec3 radial = normalize(vec3(p.x, 0.0, p.z) + vec3(1e-5, 0.0, 0.0));
      p += aFig > 0.5 ? radial * e * 0.06 : vec3(0.0, e * 0.05, 0.0);
      bright = 0.35 + 1.5 * e;
    } else if (uMode < 1.5) {
      // ripple — rings travelling along the surface distance
      float w = ring(uRings.x) + ring(uRings.y) + ring(uRings.z) + ring(uRings.w);
      energy = min(w, 1.5);
      p += n * w * 0.025;
      bright = 0.45 + 1.8 * w;
    } else if (uMode < 2.5) {
      // shatter — beat burst along normals + a slow mids swirl
      float k = uBurst * (0.35 + aRand);
      float breathe = (1.0 - uAudioOn) * (0.5 + 0.5 * sin(uTime * 0.6)) * 0.35;
      vec3 dir = normalize(n * 0.8 + swirl(p, uTime) * 0.6);
      p += dir * (k * 0.35 + breathe * 0.2) * (aFig > 0.5 ? 1.0 : 0.3);
      p += swirl(p * 1.7, uTime * 0.7) * 0.006 * (1.0 + uBands.y * 4.0);
      energy = clamp(k + breathe, 0.0, 1.0);
      bright = 0.8 + 0.6 * energy;
    } else {
      // sweep — a scan plane with afterglow below it
      float d = p.y - uSweep;
      float line = exp(-d * d * 900.0);
      float trail = d < 0.0 ? exp(d * 3.5) : 0.0;
      float a = aRand * 40.0;
      p.xz += vec2(cos(a), sin(a)) * (aRand - 0.5) * line * (0.02 + uHighs.y * 0.08);
      energy = line;
      bright = 0.08 + 0.9 * trail + 2.2 * line;
    }

    // Every mode but shatter gets a small beat breath along the normal.
    if (uMode < 1.5 || uMode > 2.5) p += n * uBurst * 0.03 * (0.5 + aRand);

    // Reveal — the cloud builds up bottom-to-top after a (re)load.
    float rv = uReveal * 1.35 - 0.1;
    float hidden = step(rv, p.y) * step(uReveal, 0.999);
    float x = (p.y - rv) * 30.0;
    bright += exp(-x * x) * 2.0 * step(uReveal, 0.999);

    // Ground fades out in a circle around the figure so a big tabletop
    // doesn't swamp the frame.
    float alpha = aFig > 0.5 ? 1.0 : uGround * (1.0 - smoothstep(0.35, 1.8, r));
    vAlpha  = alpha;
    vFig    = aFig;
    vColor  = aColor;
    vEnergy = energy;
    vBright = bright * (1.0 + uBeat.y * 0.2 + uRms * 0.3);
    vHeight = clamp(p.y, 0.0, 1.0);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, uPointSize * uPx * uDensity / max(0.05, -mv.z));
    // Hidden / fully faded points are pushed outside the clip volume.
    if (hidden > 0.5 || alpha < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform float uPalette;
  uniform float uMode;
  uniform float uAdditive;
  varying vec3  vColor;
  varying float vEnergy;
  varying float vBright;
  varying float vHeight;
  varying float vAlpha;
  varying float vFig;

  vec3 thermal(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 a = vec3(0.02, 0.00, 0.08), b = vec3(0.45, 0.05, 0.60), c = vec3(0.95, 0.20, 0.15);
    vec3 d = vec3(1.00, 0.75, 0.20), e = vec3(1.00, 1.00, 0.90);
    if (t < 0.25) return mix(a, b, t / 0.25);
    if (t < 0.50) return mix(b, c, (t - 0.25) / 0.25);
    if (t < 0.75) return mix(c, d, (t - 0.50) / 0.25);
    return mix(d, e, (t - 0.75) / 0.25);
  }

  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float r2 = dot(q, q);
    if (r2 > 0.25) discard;
    float fall = uAdditive > 0.5 ? exp(-r2 * 10.0) * 0.6 : 1.0;
    float lum = dot(vColor, vec3(0.299, 0.587, 0.114));

    vec3 base;
    // scan: true colour, but a faint violet floor on the figure so a dark
    // subject (a black figurine) still reads against the void.
    if (uPalette < 0.5)      base = vColor * 0.9 + vec3(0.09, 0.08, 0.14) * vFig;
    else if (uPalette < 1.5) base = vec3(0.82, 0.86, 1.0) * (0.25 + lum * 1.1);
    else if (uPalette < 2.5) base = thermal(lum * 0.55 + vEnergy * 0.6);
    else                     base = mix(vec3(0.42, 0.16, 0.95), vec3(0.15, 0.95, 1.0), vHeight) * (0.25 + lum * 1.2);

    vec3 hi = uMode < 0.5 ? mix(vec3(0.90, 0.20, 0.60), vec3(0.30, 0.90, 1.00), vHeight)
            : uMode < 1.5 ? vec3(0.75, 0.60, 1.00)
            : uMode < 2.5 ? vec3(1.00, 0.55, 0.25)
            :               vec3(0.45, 1.00, 0.95);

    // Additive palettes stack thousands of ground points — keep it a floor.
    float groundK = mix(1.0 - 0.5 * uAdditive, 1.0, vFig);
    vec3 col = (base * vBright + hi * vEnergy * 0.9) * vAlpha * fall * groundK;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'scan',
  name: 'Scan',
  contextType: 'three',

  params: [
    { id: 'scan',      label: 'scan file',  type: 'file', accept: '.glb,.ply,.spz', default: null },
    { id: 'source',    label: 'source',     type: 'select', options: ['scan', 'monolith'], default: 'scan' },
    { id: 'mode',      label: 'mode',       type: 'select', options: MODES, default: 'ripple' },
    { id: 'points',    label: 'points',     type: 'select', options: COUNT_OPTS, default: '200000' },
    { id: 'palette',   label: 'palette',    type: 'select', options: PALETTES, default: 'scan' },
    { id: 'pointSize', label: 'point size', type: 'range', min: 0.3, max: 4, step: 0.05, default: 1.2,
      modulators: [{ source: 'audio.rms', mode: 'mul', amount: 0.30 }] },
    { id: 'burst',     label: 'burst',      type: 'range', min: 0, max: 2, step: 0.05, default: 0,
      modulators: [
        { source: 'audio.beatPulse', mode: 'add', amount: 0.80 },
        { source: 'crowd.energy',    mode: 'add', amount: 0.60 },
      ] },
    { id: 'speed',     label: 'speed',      type: 'range', min: 0.1, max: 3, step: 0.05, default: 1.0,
      modulators: [{ source: 'audio.total', mode: 'mul', amount: 0.30 }] },
    { id: 'ground',    label: 'ground',     type: 'range', min: 0, max: 1, step: 0.05, default: 0.3 },
    { id: 'orbit',     label: 'orbit',      type: 'range', min: -1, max: 1, step: 0.01, default: 0.12 },
    { id: 'poseTrack', label: 'pose tracks', type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { mode: 'ripple',  palette: 'scan' },
      { mode: 'strata',  palette: 'void' },
      { mode: 'sweep',   palette: 'mono' },
      { mode: 'shatter', palette: 'thermal' },
    ],
  },

  presets: {
    default:  { source: 'scan', mode: 'ripple', points: '200000', palette: 'scan', pointSize: 1.2, burst: 0, speed: 1.0, ground: 0.3, orbit: 0.12, reactivity: 1.0 },
    lidar:    { mode: 'sweep',   palette: 'mono',    pointSize: 1.0, ground: 0.25, speed: 1.0 },
    spectral: { mode: 'strata',  palette: 'void',    pointSize: 1.3, ground: 0.45 },
    shatter:  { mode: 'shatter', palette: 'thermal', pointSize: 1.4, burst: 0.2, speed: 1.2 },
  },

  create(canvas, { renderer }) {
    const scene  = new Scene();
    const camera = new PerspectiveCamera(38, canvas.width / Math.max(1, canvas.height), 0.01, 50);

    const uniforms = {
      uTime:      { value: 0 },
      uMode:      { value: 1 },
      uPointSize: { value: 1.2 },
      uPx:        { value: 5 },
      uDensity:   { value: 1 },
      uBurst:     { value: 0 },
      uRingSpeed: { value: 0.55 },
      uRings:     { value: new Vector4(RING_IDLE, RING_IDLE, RING_IDLE, RING_IDLE) },
      uSweep:     { value: 0 },
      uReveal:    { value: 0 },
      uGround:    { value: 0.5 },
      uAudioOn:   { value: 0 },
      uSpec:      { value: new Float32Array(SPEC_N) },
      uPalette:   { value: 0 },
      uAdditive:  { value: 0 },
      uBands:     { value: new Vector4() },
      uBeat:      { value: new Vector2() },
      uMids:      { value: new Vector2() },
      uHighs:     { value: new Vector2() },
      uRms:       { value: 0 },
    };
    const material = new ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: false, depthWrite: true, depthTest: true, blending: NormalBlending,
    });
    let additive = false;
    let points = null;

    function setCloud(cloud) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(cloud.positions, 3));
      g.setAttribute('normal',   new BufferAttribute(cloud.normals, 3));
      g.setAttribute('aColor',   new BufferAttribute(cloud.colors, 3));
      g.setAttribute('aDist',    new BufferAttribute(cloud.dist, 1));
      g.setAttribute('aFig',     new BufferAttribute(cloud.fig, 1));
      g.setAttribute('aRand',    new BufferAttribute(cloud.rand, 1));
      if (points) {
        points.geometry.dispose();
        points.geometry = g;
      } else {
        points = new Points(g, material);
        // Shader displaces points, and the cloud always fills the frame.
        points.frustumCulled = false;
        scene.add(points);
      }
      uniforms.uDensity.value = Math.sqrt(200000 / Math.max(1000, cloud.count));
      uniforms.uReveal.value = 0;
    }

    // ── Worker plumbing ──────────────────────────────────────────────────
    let worker = null;
    let reqId = 0;
    let pendingKey = '';
    try {
      worker = new Worker(new URL('../scan-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const { id, cloud, error } = e.data || {};
        if (id !== reqId) return;                      // superseded request
        const key = pendingKey;
        pendingKey = '';
        if (error) {
          console.warn('[qualia] scan: could not load —', error);
          shared.cloudKey = key;                       // don't retry the same bad file every frame
          return;
        }
        shared.cloud = cloud;
        shared.cloudKey = key;
        console.info('[qualia] scan: loaded', shared.source?.name || 'monolith', cloud.stats);
        setCloud(cloud);
      };
      worker.onerror = (err) => console.warn('[qualia] scan worker error', err?.message || err);
    } catch (err) {
      console.warn('[qualia] scan: worker unavailable', err);
    }

    if (shared.cloud) setCloud(shared.cloud);
    if (shared.restore === 'idle') {
      shared.restore = 'pending';
      loadLastScan().then((rec) => {
        if (rec && !shared.source) { shared.source = rec; shared.serial++; }
        shared.restore = 'done';
      });
    }

    // ── Per-frame audio state ────────────────────────────────────────────
    const spec = uniforms.uSpec.value;
    let specLen = 0;
    const binLo = new Int32Array(SPEC_N), binHi = new Int32Array(SPEC_N);
    function buildBins(L) {
      // Log-spaced from bin 1 up to half the FFT (~11–12 kHz at 44.1/48 kHz).
      const top = Math.max(2, L * 0.5);
      for (let i = 0; i < SPEC_N; i++) {
        binLo[i] = Math.floor(Math.pow(top, i / SPEC_N));
        binHi[i] = Math.max(binLo[i] + 1, Math.floor(Math.pow(top, (i + 1) / SPEC_N)));
      }
      specLen = L;
    }
    function updateSpectrum(s, dt, time, react) {
      if (!s || !s.length) {
        // Audio off: a slow travelling swell so strata still breathes.
        for (let i = 0; i < SPEC_N; i++) {
          const v = 0.18 + 0.16 * Math.sin(time * 0.7 - i * 0.35) + 0.08 * Math.sin(time * 1.9 + i * 0.9);
          spec[i] += (v - spec[i]) * Math.min(1, dt * 4);
        }
        return;
      }
      if (s.length !== specLen) buildBins(s.length);
      for (let i = 0; i < SPEC_N; i++) {
        let m = 0;
        for (let b = binLo[i]; b < binHi[i]; b++) if (s[b] > m) m = s[b];
        const v = Math.min(1, Math.max(0, (m / 255 - 0.15) / 0.85) * react);
        spec[i] += (v - spec[i]) * Math.min(1, dt * (v > spec[i] ? 30 : 6));
      }
    }

    const rings = uniforms.uRings.value;
    let lastRing = -10;
    let prevBeat = false;
    function launchRing(time) {
      // Reuse the oldest slot.
      let slot = RING_KEYS[0];
      for (const k of RING_KEYS) if (rings[k] > rings[slot]) slot = k;
      rings[slot] = 0;
      lastRing = time;
    }

    let sweepPhase = 0;
    let orbitAz = 0.6;
    let azOff = 0, elev = 0.22;
    let audioRef = null;

    function update(field) {
      const { dt, time, params, channels } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;

      // ── Source selection (file param → IndexedDB → monolith) ───────────
      const f = params.scan;
      if (f && f !== shared.lastFile) {
        shared.lastFile = f;
        f.arrayBuffer().then((bytes) => {
          shared.source = { name: f.name, bytes };
          shared.serial++;
          saveLastScan(f.name, bytes);
        }).catch((e) => console.warn('[qualia] scan: could not read file', e));
      }
      const useScan = params.source !== 'monolith' && !!shared.source;
      const count = parseInt(params.points, 10) || 200000;
      const key = `${useScan ? `s${shared.serial}` : 'mono'}|${count}`;
      if (worker && shared.restore === 'done' && key !== shared.cloudKey && key !== pendingKey) {
        pendingKey = key;
        worker.postMessage({ id: ++reqId, bytes: useScan ? shared.source.bytes : null, count });
      }

      // ── Uniforms ───────────────────────────────────────────────────────
      const audioOn = !!audio.spectrum;
      uniforms.uTime.value = time;
      uniforms.uMode.value = Math.max(0, MODES.indexOf(params.mode));
      uniforms.uPointSize.value = params.pointSize;
      uniforms.uBurst.value = params.burst;
      uniforms.uGround.value = params.ground;
      uniforms.uAudioOn.value = audioOn ? 1 : 0;
      uniforms.uRingSpeed.value = 0.55 * params.speed;
      if (uniforms.uReveal.value < 1) uniforms.uReveal.value = Math.min(1, uniforms.uReveal.value + dt / 1.8);

      const pal = Math.max(0, PALETTES.indexOf(params.palette));
      uniforms.uPalette.value = pal;
      const wantAdditive = pal !== 0;
      if (wantAdditive !== additive) {
        additive = wantAdditive;
        material.blending = additive ? AdditiveBlending : NormalBlending;
        material.transparent = additive;
        material.depthWrite = !additive;
        uniforms.uAdditive.value = additive ? 1 : 0;
        material.needsUpdate = true;
      }

      updateSpectrum(audio.spectrum, dt, time, params.reactivity ?? 1);

      // Ripples: launch on each kick; self-launch when the music has no beat.
      for (const k of RING_KEYS) if (rings[k] < RING_IDLE) rings[k] = Math.min(RING_IDLE, rings[k] + dt);
      const beat = !!audio.beat.active;
      if (beat && !prevBeat && time - lastRing > 0.18) launchRing(time);
      else if (time - lastRing > 3.0 / Math.max(0.1, params.speed)) launchRing(time);
      prevBeat = beat;

      sweepPhase += dt * params.speed * 0.22 * (1 + audio.beat.pulse * 1.5);
      uniforms.uSweep.value = (sweepPhase % 1) * 1.3 - 0.1;

      // ── Camera: slow orbit + smoothed pose offset ──────────────────────
      orbitAz += params.orbit * dt;
      let tOff = 0, tEl = 0.22;
      if (params.poseTrack) {
        tOff = (channels?.['pose.head.x'] ?? 0) * 0.9;
        tEl = 0.22 + (channels?.['pose.headPitch'] ?? 0) * 0.4;
      }
      tEl = Math.max(-0.1, Math.min(1.1, tEl));
      const k = Math.min(1, dt * 2.5);
      azOff += (tOff - azOff) * k;
      elev += (tEl - elev) * k;
      const az = orbitAz + azOff, dist = 2.7, cosE = Math.cos(elev);
      camera.position.set(dist * cosE * Math.cos(az), 0.48 + dist * Math.sin(elev), dist * cosE * Math.sin(az));
      camera.lookAt(0, 0.48, 0);
    }

    function render() {
      if (audioRef) applyAudioUniforms(uniforms, audioRef);
      renderer.render(scene, camera);
    }

    function resize(w, h /*, dpr */) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      uniforms.uPx.value = h * 0.005;
    }

    function dispose() {
      if (worker) { worker.terminate(); worker = null; }
      // A request in flight dies with the worker; the next create() retries.
      pendingKey = '';
      if (!points) material.dispose();
      disposeObject3D(scene);
    }

    return { resize, update, render, dispose };
  },
};
