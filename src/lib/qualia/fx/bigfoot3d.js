// Bigfoot 3D — "Ramblin' Visioneer", real-time skinned-character variant.
//
// A rigged glTF creature walks in real time, rendered as a flat void-black
// silhouette with a Fresnel rim and glowing eyes over a cosmic starfield —
// same art direction as the procedural 2D `bigfoot` quale, but with a real
// skeleton/gait. The silhouette treatment hides surface detail, so the rig +
// walk cycle is all that matters.
//
// Models (CC0, Quaternius): public/models/yeti.glb (default — a literal
//   Sasquatch), giant.glb (hulking brute), bigfoot-rig.glb (three.js
//   RobotExpressive, kept as a control). Switchable live via the `model` param.
//
// Pipeline: GLTFLoader → AnimationMixer → a per-model skinned
//   MeshStandardMaterial whose emissive is a Fresnel rim injected via
//   onBeforeCompile (keeps three's GPU skinning). Eyes are two additive
//   sprites pinned to the Head bone's world position each frame (robust to
//   each rig's wildly different internal scale).
//
// Audio: bass/beat → rim + eye flare + gait tempo. Pose: head.x → gaze
//   (the head bone turns toward you), shoulderSpan → camera dolly-in.

import {
  Scene, PerspectiveCamera, Group, Color, Vector3, Box3,
  AnimationMixer, LoopRepeat, SphereGeometry, MeshStandardMaterial, Mesh,
  Points, BufferGeometry, BufferAttribute, PointsMaterial, AdditiveBlending,
  Sprite, SpriteMaterial, CanvasTexture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { disposeObject3D } from '../three-host.js';

const MODELS = {
  // Ramblin' Visioneer — produced from docs/ramblin-visioneer/ spec. Drop the
  // delivered GLB here; until then this slot gracefully falls back.
  visioneer: '/models/ramblin-visioneer.glb',
  yeti:  '/models/yeti.glb',
  giant: '/models/giant.glb',
  robot: '/models/bigfoot-rig.glb',
};

const TARGET_HEIGHT = 3; // world units every model is normalized to

// State → ordered list of clip-name tokens (case-insensitive substring match),
// so one mapping works across all rigs (Yeti/Giant/Robot use different names).
const STATE_CLIPS = {
  idle:       ['Idle'],
  walk:       ['Walk'],
  loom:       ['Wave', 'Attack', 'Punch', 'Idle'],
  apparition: ['Idle'],
  ritual:     ['Jump', 'Duck', 'Yes', 'Dance', 'Idle'],
};

const PALETTES = {
  cosmic: { bg: 0x07101a, rim: [0.11, 0.36, 1.0], eye: [0.30, 0.85, 1.0], star: [0.87, 0.93, 0.96], aura: [60, 140, 255] },
  aurora: { bg: 0x05140e, rim: [0.20, 0.86, 0.55], eye: [0.45, 1.0, 0.78], star: [0.88, 0.96, 0.94], aura: [70, 220, 150] },
  ember:  { bg: 0x140806, rim: [1.0, 0.45, 0.15], eye: [1.0, 0.62, 0.30], star: [0.98, 0.92, 0.80], aura: [230, 120, 60] },
  blood:  { bg: 0x140406, rim: [1.0, 0.12, 0.20], eye: [1.0, 0.25, 0.30], star: [0.96, 0.86, 0.88], aura: [220, 40, 60] },
  mono:   { bg: 0x080a0e, rim: [0.45, 0.55, 0.72], eye: [0.78, 0.88, 1.0], star: [0.92, 0.94, 0.97], aura: [120, 150, 190] },
};

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function makeRadialTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'bigfoot3d',
  name: 'Bigfoot 3D',
  contextType: 'three',
  maxDpr: 1.5,

  params: [
    { id: 'model',          label: 'creature', type: 'select', options: ['yeti', 'giant', 'visioneer', 'robot'], default: 'yeti' },
    { id: 'animationState', label: 'state',    type: 'select', options: ['idle', 'walk', 'loom', 'apparition', 'ritual'], default: 'walk' },
    { id: 'palette',   label: 'palette',   type: 'select', options: ['cosmic', 'aurora', 'ember', 'blood', 'mono'], default: 'cosmic' },
    { id: 'walkSpeed', label: 'walk speed', type: 'range', min: 0, max: 2.5, step: 0.05, default: 1.0 },
    { id: 'modelScale',label: 'scale',     type: 'range', min: 0.5, max: 1.6, step: 0.01, default: 1.0 },
    { id: 'eyeSize',   label: 'eye size',  type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'rimGlow',   label: 'rim glow',  type: 'range', min: 0, max: 3, step: 0.05, default: 1.2,
      modulators: [{ source: 'audio.beatPulse', mode: 'add', amount: 0.8 }] },
    { id: 'eyeGlow',   label: 'eye glow',  type: 'range', min: 0, max: 4, step: 0.05, default: 1.6,
      modulators: [{ source: 'audio.bass', mode: 'add', amount: 1.2 }] },
    { id: 'auraAmount',label: 'aura',      type: 'range', min: 0, max: 2, step: 0.05, default: 0.8,
      modulators: [{ source: 'audio.beatPulse', mode: 'add', amount: 0.6 }] },
    { id: 'starAmount',label: 'stars',     type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'orbit',     label: 'auto orbit',type: 'range', min: -1, max: 1, step: 0.02, default: 0.12 },
    { id: 'camHeight', label: 'cam height',type: 'range', min: 0.2, max: 1.2, step: 0.02, default: 0.62 },
    { id: 'poseTrack', label: 'pose bind', type: 'toggle', default: true },
    { id: 'poseInfluence', label: 'pose amt', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { model: 'yeti',  animationState: 'walk', palette: 'cosmic' },
      { model: 'yeti',  animationState: 'loom', palette: 'aurora' },
      { model: 'giant', animationState: 'walk', palette: 'ember' },
      { model: 'giant', animationState: 'ritual', palette: 'blood' },
    ],
  },

  presets: {
    default:  { model: 'yeti', animationState: 'walk', palette: 'cosmic', walkSpeed: 1.0, modelScale: 1.0, eyeSize: 1.0, rimGlow: 1.2, eyeGlow: 1.6, auraAmount: 0.8, starAmount: 1.0, orbit: 0.12, camHeight: 0.62, poseTrack: true, poseInfluence: 0.5, reactivity: 1.0 },
    sasquatch:{ model: 'yeti', animationState: 'walk', palette: 'cosmic', rimGlow: 1.4, eyeGlow: 1.9, orbit: 0.16 },
    brute:    { model: 'giant', animationState: 'walk', palette: 'ember', rimGlow: 1.6, eyeGlow: 2.2, modelScale: 1.2 },
    loom:     { model: 'yeti', animationState: 'loom', palette: 'aurora', rimGlow: 2.0, eyeGlow: 2.6, auraAmount: 1.4, orbit: 0.0, camHeight: 0.7 },
    omen:     { model: 'giant', animationState: 'ritual', palette: 'blood', rimGlow: 1.8, eyeGlow: 2.4, auraAmount: 1.3, orbit: 0.0 },
    visioneer:{ model: 'visioneer', animationState: 'walk', palette: 'cosmic', rimGlow: 1.3, eyeGlow: 2.0, eyeSize: 1.0, auraAmount: 1.0, orbit: 0.14, camHeight: 0.64 },
  },

  create(canvas, { renderer }) {
    const scene = new Scene();
    const camera = new PerspectiveCamera(42, canvas.width / Math.max(1, canvas.height), 0.1, 500);
    const pal0 = PALETTES.cosmic;
    if (renderer) renderer.setClearColor(pal0.bg, 1);

    // ── Starfield ───────────────────────────────────────────────────────────
    const STAR_N = 2600;
    const sg = new BufferGeometry();
    const spos = new Float32Array(STAR_N * 3);
    for (let i = 0; i < STAR_N; i++) {
      const r = 30 + Math.random() * 80, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      spos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      spos[i * 3 + 1] = r * Math.cos(ph);
      spos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    sg.setAttribute('position', new BufferAttribute(spos, 3));
    const starMat = new PointsMaterial({ color: new Color(pal0.star[0], pal0.star[1], pal0.star[2]), size: 0.35, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false });
    const stars = new Points(sg, starMat);
    scene.add(stars);

    // ── Aura sprite (additive radial behind the figure) ─────────────────────
    const radial = makeRadialTexture();
    let auraSprite = null;
    if (radial) {
      auraSprite = new Sprite(new SpriteMaterial({ map: radial, color: new Color(pal0.aura[0] / 255, pal0.aura[1] / 255, pal0.aura[2] / 255), transparent: true, blending: AdditiveBlending, depthWrite: false, opacity: 0.5 }));
      auraSprite.scale.set(7, 7, 1);
      scene.add(auraSprite);
    }

    // ── Eyes: two additive sprites pinned to the head world-position ─────────
    const eyeColor = new Color(pal0.eye[0], pal0.eye[1], pal0.eye[2]);
    const eyes = [];
    if (radial) {
      for (let i = 0; i < 2; i++) {
        const e = new Sprite(new SpriteMaterial({ map: radial, color: eyeColor.clone(), transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false }));
        e.visible = false;
        scene.add(e);
        eyes.push(e);
      }
    }

    // ── Shared rim uniforms + per-model silhouette material factory ──────────
    const rimUniforms = {
      uRimColor: { value: new Color(pal0.rim[0], pal0.rim[1], pal0.rim[2]) },
      uRimPower: { value: 2.4 },
      uRimIntensity: { value: 1.2 },
    };
    function makeBodyMat() {
      const m = new MeshStandardMaterial({ color: 0x020306, roughness: 1, metalness: 0 });
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uRimColor = rimUniforms.uRimColor;
        shader.uniforms.uRimPower = rimUniforms.uRimPower;
        shader.uniforms.uRimIntensity = rimUniforms.uRimIntensity;
        shader.fragmentShader = 'uniform vec3 uRimColor;\nuniform float uRimPower;\nuniform float uRimIntensity;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           float _fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), uRimPower);
           totalEmissiveRadiance += uRimColor * _fres * uRimIntensity;`
        );
      };
      return m;
    }

    // ── Model state (rebuilt on each load) ──────────────────────────────────
    const rig = new Group();
    scene.add(rig);
    const loader = new GLTFLoader();
    let model = null, mixer = null, headBone = null, current = null;
    let eyeLocators = [];         // explicit Eye.L/Eye.R nodes, if the rig has them
    let actions = {};
    let baseY = TARGET_HEIGHT;
    let loadToken = 0;            // bumped per load; stale loads are discarded
    let requestedModel = null;    // which key we've started loading
    let desiredState = 'walk';

    function actionFor(state) {
      const cands = STATE_CLIPS[state] || STATE_CLIPS.walk;
      for (const tok of cands) {
        const t = tok.toLowerCase();
        for (const name in actions) if (name.toLowerCase().includes(t)) return actions[name];
      }
      const k = Object.keys(actions)[0];
      return k ? actions[k] : null;
    }
    function playState(state) {
      const next = actionFor(state);
      if (!next || next === current) return;
      next.reset().fadeIn(0.35).play();
      if (current) current.fadeOut(0.35);
      current = next;
    }

    function teardownModel() {
      if (mixer) { mixer.stopAllAction(); mixer = null; }
      if (model) { rig.remove(model); disposeObject3D(model); model = null; }
      headBone = null; eyeLocators = []; current = null; actions = {};
      for (const e of eyes) e.visible = false;
    }

    async function loadModel(key) {
      const url = MODELS[key] || MODELS.yeti;
      const myToken = ++loadToken;
      requestedModel = key;
      let gltf;
      try {
        gltf = await loader.loadAsync(url);
      } catch (err) {
        if (myToken !== loadToken) return;
        console.warn('[bigfoot3d] model load failed:', url, err);
        teardownModel();
        const fb = new Mesh(new SphereGeometry(1.2, 24, 16), makeBodyMat());
        fb.scale.set(1, 2.2, 0.8); fb.position.y = TARGET_HEIGHT * 0.8;
        rig.add(fb); model = fb; baseY = TARGET_HEIGHT;
        return;
      }
      if (myToken !== loadToken) { disposeObject3D(gltf.scene); return; } // superseded

      teardownModel();
      model = gltf.scene;
      const bodyMat = makeBodyMat();
      const foundEyes = [];
      model.traverse((o) => {
        if (o.isMesh) { o.material = bodyMat; o.castShadow = false; o.frustumCulled = false; return; }
        // Head bone (for eye approximation + gaze) and explicit eye locators.
        if (o.name && !headBone && /head/i.test(o.name)) headBone = o;
        if (o.name && /eye/i.test(o.name)) foundEyes.push(o);
      });
      // Prefer explicit Eye.L/Eye.R locators — pin eyes to them exactly.
      if (foundEyes.length >= 2) {
        const L = foundEyes.find((n) => /(\.l$|_l$|\bl\b|left)/i.test(n.name));
        const R = foundEyes.find((n) => /(\.r$|_r$|\br\b|right)/i.test(n.name));
        eyeLocators = (L && R && L !== R) ? [L, R] : foundEyes.slice(0, 2);
      }
      // Normalize: scale to TARGET_HEIGHT, recenter x/z, feet at y=0.
      const box = new Box3().setFromObject(model);
      const size = new Vector3(); box.getSize(size);
      const center = new Vector3(); box.getCenter(center);
      const s = TARGET_HEIGHT / (size.y || TARGET_HEIGHT);
      model.scale.setScalar(s);
      model.position.set(-center.x * s, -box.min.y * s, -center.z * s);
      rig.add(model);
      baseY = TARGET_HEIGHT;

      mixer = new AnimationMixer(model);
      for (const clip of gltf.animations) {
        const a = mixer.clipAction(clip);
        a.loop = LoopRepeat;
        actions[clip.name] = a;
      }
      playState(desiredState);
    }

    loadModel('yeti'); // initial; update() will switch if param differs

    // ── Smoothed view / pose state ──────────────────────────────────────────
    let azimuth = 0.6, dolly = 0, gaze = 0, eyePulse = 1, lastState = null;
    const tmpHead = new Vector3(), camRight = new Vector3(), camUp = new Vector3(), eyeDir = new Vector3();

    function update(field) {
      const { dt, time, params, channels } = field;
      const pal = PALETTES[params.palette] || PALETTES.cosmic;
      if (renderer) renderer.setClearColor(pal.bg, 1);

      if (params.model !== requestedModel) loadModel(params.model);
      if (params.animationState !== lastState) { desiredState = params.animationState; playState(desiredState); lastState = params.animationState; }

      const beat = channels?.['audio.beatPulse'] ?? 0;
      if (mixer) { mixer.timeScale = params.walkSpeed * (1 + beat * 0.15); mixer.update(dt); }

      // Pose: gaze (head turns toward you) + loom (dolly in).
      let gazeT = 0, dollyT = 0;
      if (params.poseTrack && params.poseInfluence > 0) {
        const hx = channels?.['pose.head.x'];
        const span = channels?.['pose.shoulderSpan'];
        if (hx != null) gazeT = clamp(hx, -1, 1) * params.poseInfluence;
        if (span != null) dollyT = clamp((span - 0.25) / 0.25, -1, 1) * params.poseInfluence;
      }
      gaze += (gazeT - gaze) * Math.min(1, dt * 4);
      dolly += (dollyT - dolly) * Math.min(1, dt * 3);
      if (headBone) headBone.rotation.y += gaze * 0.6; // layered after mixer

      rig.scale.setScalar(params.modelScale);

      // Camera orbit + dolly.
      azimuth += dt * params.orbit;
      const dist = 7.2 - dolly * 1.6;
      const cy = baseY * params.camHeight;
      camera.position.set(Math.sin(azimuth) * dist, cy + 1.2, Math.cos(azimuth) * dist);
      camera.lookAt(0, cy, 0);
      camera.updateMatrixWorld();

      // Rim drive.
      rimUniforms.uRimColor.value.setRGB(pal.rim[0], pal.rim[1], pal.rim[2]);
      rimUniforms.uRimIntensity.value = params.rimGlow;

      // Eyes: pinned exactly to Eye.L/Eye.R locators when the rig provides them
      // (per spec), else approximated from the Head bone, split horizontally.
      eyePulse += ((1 + Math.sin(time * 1.6) * 0.18) - eyePulse) * Math.min(1, dt * 4);
      eyeColor.setRGB(pal.eye[0], pal.eye[1], pal.eye[2]);
      const wScale = TARGET_HEIGHT * params.modelScale;
      const haveLoc = eyeLocators.length === 2;
      if (eyes.length && params.eyeSize > 0 && (haveLoc || headBone || model)) {
        const sz = 0.085 * wScale * params.eyeSize * (0.85 + 0.3 * eyePulse) * (1 + beat * 0.25) * Math.max(0.15, params.eyeGlow);
        const op = clamp(0.5 * params.eyeGlow * eyePulse, 0, 1);
        if (haveLoc) {
          for (let i = 0; i < 2; i++) {
            const e2 = eyes[i];
            e2.visible = true;
            eyeLocators[i].getWorldPosition(tmpHead);
            eyeDir.copy(camera.position).sub(tmpHead).normalize();
            e2.position.copy(tmpHead).addScaledVector(eyeDir, 0.02 * wScale); // tiny lift off the face
            e2.scale.setScalar(Math.max(0.001, sz));
            e2.material.color.copy(eyeColor);
            e2.material.opacity = op;
          }
        } else {
          if (headBone) headBone.getWorldPosition(tmpHead);
          else { tmpHead.set(0, baseY * 0.92, 0); rig.localToWorld(tmpHead); }
          const e = camera.matrixWorld.elements;
          camRight.set(e[0], e[1], e[2]).normalize();
          camUp.set(e[4], e[5], e[6]).normalize();
          eyeDir.copy(camera.position).sub(tmpHead).normalize();
          for (let i = 0; i < 2; i++) {
            const e2 = eyes[i];
            e2.visible = true;
            e2.position.copy(tmpHead)
              .addScaledVector(eyeDir, 0.10 * wScale)
              .addScaledVector(camRight, (i === 0 ? -1 : 1) * 0.065 * wScale)
              .addScaledVector(camUp, 0.012 * wScale);
            e2.scale.setScalar(Math.max(0.001, sz));
            e2.material.color.copy(eyeColor);
            e2.material.opacity = op;
          }
        }
      } else {
        for (const e2 of eyes) e2.visible = false;
      }

      // Stars + aura.
      stars.rotation.y += dt * 0.01;
      starMat.color.setRGB(pal.star[0], pal.star[1], pal.star[2]);
      starMat.opacity = 0.3 + 0.4 * clamp(params.starAmount, 0, 2);
      if (auraSprite) {
        auraSprite.material.color.setRGB(pal.aura[0] / 255, pal.aura[1] / 255, pal.aura[2] / 255);
        auraSprite.material.opacity = 0.22 + params.auraAmount * 0.3;
        auraSprite.position.set(0, baseY * 0.7, -1.5);
        const as = (5 + params.auraAmount * 3) * (1 + beat * 0.15);
        auraSprite.scale.set(as, as, 1);
      }
    }

    function render() { if (renderer) renderer.render(scene, camera); }

    function resize(w, h) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      if (renderer) renderer.setSize(w, h, false);
    }

    function dispose() {
      loadToken++; // invalidate any in-flight load
      if (mixer) mixer.stopAllAction();
      disposeObject3D(scene);
      if (radial) radial.dispose();
    }

    return { resize, update, render, dispose };
  },
};
