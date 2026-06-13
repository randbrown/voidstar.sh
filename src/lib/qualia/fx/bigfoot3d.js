// Bigfoot 3D — "Ramblin' Visioneer", real-time skinned-character variant.
//
// A rigged glTF character walks in real time, rendered as a flat void-black
// silhouette with a Fresnel rim and glowing cyan eyes over a cosmic starfield
// — the same art direction as the procedural 2D `bigfoot` quale, but with a
// real skeleton/gait. The silhouette treatment hides the underlying model's
// surface detail, so a generic rigged creature reads as a Sasquatch apparition.
//
// Asset: /public/models/bigfoot-rig.glb  (placeholder = three.js' RobotExpressive,
//   Tomás Laulhé / CC0 modifications by Don McCurdy). Swap this file for a
//   Quaternius CC0 brute or a Mixamo-rigged ape and it just works, as long as
//   the clip names are remapped in STATE_CLIPS below.
//
// Pipeline: GLTFLoader → AnimationMixer (core three) → a shared skinned
//   MeshStandardMaterial whose emissive is driven by a Fresnel rim injected
//   via onBeforeCompile (keeps three's built-in GPU skinning). Eyes are two
//   emissive spheres parented to the Head bone.
//
// Audio: bass/beat → rim + eye flare + gait timeScale. Pose: head.x → gaze
//   (the head bone turns toward you), shoulderSpan → loom (camera dollies in).

import {
  Scene, PerspectiveCamera, Group, Color, Vector3, Box3,
  AnimationMixer, LoopRepeat, SphereGeometry, MeshBasicMaterial, MeshStandardMaterial,
  Mesh, Points, BufferGeometry, BufferAttribute, PointsMaterial, AdditiveBlending,
  Sprite, SpriteMaterial, CanvasTexture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { disposeObject3D } from '../three-host.js';

const MODEL_URL = '/models/bigfoot-rig.glb';

// Map quale states → animation clip names in the GLB. Edit when swapping models.
const STATE_CLIPS = {
  idle:       'Idle',
  walk:       'Walking',
  loom:       'Wave',
  apparition: 'Idle',
  ritual:     'Standing',
};

const PALETTES = {
  cosmic: { bg: 0x07101a, rim: [0.11, 0.36, 1.0], eye: [0.22, 0.81, 1.0], star: [0.87, 0.93, 0.96], aura: [60, 140, 255] },
  aurora: { bg: 0x05140e, rim: [0.20, 0.86, 0.55], eye: [0.40, 1.0, 0.78], star: [0.88, 0.96, 0.94], aura: [70, 220, 150] },
  ember:  { bg: 0x140806, rim: [1.0, 0.45, 0.15], eye: [1.0, 0.62, 0.30], star: [0.98, 0.92, 0.80], aura: [230, 120, 60] },
  mono:   { bg: 0x080a0e, rim: [0.45, 0.55, 0.72], eye: [0.74, 0.86, 1.0], star: [0.92, 0.94, 0.97], aura: [120, 150, 190] },
};

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'bigfoot3d',
  name: 'Bigfoot 3D',
  contextType: 'three',
  maxDpr: 1.5,

  params: [
    { id: 'animationState', label: 'state', type: 'select',
      options: ['idle', 'walk', 'loom', 'apparition', 'ritual'], default: 'walk' },
    { id: 'palette',   label: 'palette',   type: 'select', options: ['cosmic', 'aurora', 'ember', 'mono'], default: 'cosmic' },
    { id: 'walkSpeed', label: 'walk speed', type: 'range', min: 0, max: 2.5, step: 0.05, default: 1.0 },
    { id: 'modelScale',label: 'scale',     type: 'range', min: 0.5, max: 1.6, step: 0.01, default: 1.0 },
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
      { animationState: 'walk', palette: 'cosmic' },
      { animationState: 'idle', palette: 'aurora' },
      { animationState: 'loom', palette: 'ember' },
      { animationState: 'ritual', palette: 'mono' },
    ],
  },

  presets: {
    default: { animationState: 'walk', palette: 'cosmic', walkSpeed: 1.0, modelScale: 1.0, rimGlow: 1.2, eyeGlow: 1.6, auraAmount: 0.8, starAmount: 1.0, orbit: 0.12, camHeight: 0.62, poseTrack: true, poseInfluence: 0.5, reactivity: 1.0 },
    ramblin: { animationState: 'walk', walkSpeed: 1.1, rimGlow: 1.4, eyeGlow: 1.8, orbit: 0.18 },
    loom:    { animationState: 'loom', rimGlow: 2.0, eyeGlow: 2.6, auraAmount: 1.4, orbit: 0.0, camHeight: 0.7 },
    ritual:  { animationState: 'ritual', orbit: 0.0, rimGlow: 1.0, eyeGlow: 1.4, auraAmount: 1.2, palette: 'mono' },
    ember:   { animationState: 'walk', palette: 'ember', rimGlow: 1.6, eyeGlow: 2.0 },
  },

  async create(canvas, { renderer }) {
    const scene = new Scene();
    const camera = new PerspectiveCamera(42, canvas.width / Math.max(1, canvas.height), 0.1, 500);
    const pal0 = PALETTES.cosmic;
    if (renderer) renderer.setClearColor(pal0.bg, 1);

    // ── Starfield ───────────────────────────────────────────────────────────
    const STAR_N = 2600;
    const sg = new BufferGeometry();
    const spos = new Float32Array(STAR_N * 3);
    for (let i = 0; i < STAR_N; i++) {
      // shell of stars around the figure
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
    let auraSprite = null;
    if (typeof document !== 'undefined') {
      const oc = document.createElement('canvas'); oc.width = oc.height = 128;
      const g = oc.getContext('2d');
      const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.4, 'rgba(255,255,255,0.5)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
      const tex = new CanvasTexture(oc);
      const sm = new SpriteMaterial({ map: tex, color: new Color(pal0.aura[0] / 255, pal0.aura[1] / 255, pal0.aura[2] / 255), transparent: true, blending: AdditiveBlending, depthWrite: false, opacity: 0.5 });
      auraSprite = new Sprite(sm);
      auraSprite.scale.set(7, 7, 1);
      scene.add(auraSprite);
    }

    // ── Body silhouette material: black + Fresnel rim via onBeforeCompile ────
    const rimUniforms = { uRimColor: { value: new Color(pal0.rim[0], pal0.rim[1], pal0.rim[2]) }, uRimPower: { value: 2.4 }, uRimIntensity: { value: 1.2 } };
    const bodyMat = new MeshStandardMaterial({ color: 0x020306, roughness: 1, metalness: 0 });
    bodyMat.onBeforeCompile = (shader) => {
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

    // ── Eyes ────────────────────────────────────────────────────────────────
    const eyeMat = new MeshBasicMaterial({ color: new Color(pal0.eye[0], pal0.eye[1], pal0.eye[2]) });
    const eyeGeo = new SphereGeometry(1, 16, 12);

    // ── Load the rigged model ───────────────────────────────────────────────
    const rig = new Group();
    scene.add(rig);
    let model = null, mixer = null, headBone = null, current = null;
    const actions = {};
    let modelHeight = 3, baseY = 0;

    try {
      const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
      model = gltf.scene;
      // Silhouette material on every mesh; collect the head bone.
      model.traverse((o) => {
        if (o.isMesh) { o.material = bodyMat; o.castShadow = false; o.frustumCulled = false; }
        if (o.isBone && !headBone && /head/i.test(o.name)) headBone = o;
      });
      // Normalize size + center on origin, feet at y=0.
      const box = new Box3().setFromObject(model);
      const size = new Vector3(); box.getSize(size);
      const center = new Vector3(); box.getCenter(center);
      modelHeight = size.y || 3;
      const s = 3 / modelHeight;
      model.scale.setScalar(s);
      model.position.set(-center.x * s, -box.min.y * s, -center.z * s);
      rig.add(model);
      baseY = 3;

      // Eyes parented to head bone (so they ride the animation).
      if (headBone) {
        const er = 0.06 * (modelHeight); // head-bone space ≈ model units
        for (let i = 0; i < 2; i++) {
          const e = new Mesh(eyeGeo, eyeMat);
          e.scale.setScalar(er);
          // forward (+z) and slightly down, split on x — tuned for RobotExpressive
          e.position.set((i === 0 ? 1 : -1) * 0.18 * modelHeight * 0.18, 0.02 * modelHeight, 0.42 * modelHeight * 0.5);
          e.frustumCulled = false;
          headBone.add(e);
        }
      }

      mixer = new AnimationMixer(model);
      for (const clip of gltf.animations) {
        const a = mixer.clipAction(clip);
        a.loop = LoopRepeat; a.clampWhenFinished = false;
        actions[clip.name] = a;
      }
    } catch (err) {
      // Fallback: a simple capsule-ish box so the quale never hard-fails.
      console.warn('[bigfoot3d] model load failed:', err);
      const fb = new Mesh(new SphereGeometry(1.2, 24, 16), bodyMat);
      fb.scale.set(1, 2.2, 0.8); fb.position.y = 2.4; rig.add(fb); model = fb; baseY = 2.4;
    }

    // ── State / animation crossfade ─────────────────────────────────────────
    function playState(state) {
      if (!mixer) return;
      const name = STATE_CLIPS[state] || STATE_CLIPS.walk;
      const next = actions[name] || actions[Object.keys(actions)[0]];
      if (!next || next === current) return;
      next.reset().fadeIn(0.35).play();
      if (current) current.fadeOut(0.35);
      current = next;
    }

    // smoothed view + pose state
    let azimuth = 0.6, dolly = 0, gaze = 0, lastHeadX = null, eyePulse = 0;
    let lastState = null;

    function update(field) {
      const { dt, time, params, channels } = field;
      const pal = PALETTES[params.palette] || PALETTES.cosmic;
      if (renderer) renderer.setClearColor(pal.bg, 1);

      if (params.animationState !== lastState) { playState(params.animationState); lastState = params.animationState; }

      // Gait playback (audio nudges tempo a touch).
      const beat = channels?.['audio.beatPulse'] ?? 0;
      if (mixer) { mixer.timeScale = params.walkSpeed * (1 + beat * 0.15); mixer.update(dt); }

      // Pose: gaze (head bone turns toward you) + loom (dolly in).
      let gazeT = 0, dollyT = 0;
      if (params.poseTrack && params.poseInfluence > 0) {
        const hx = channels?.['pose.head.x'];
        const span = channels?.['pose.shoulderSpan'];
        if (hx != null) gazeT = clamp(hx, -1, 1) * params.poseInfluence;
        if (span != null) dollyT = clamp((span - 0.25) / 0.25, -1, 1) * params.poseInfluence;
      }
      gaze += (gazeT - gaze) * Math.min(1, dt * 4);
      dolly += (dollyT - dolly) * Math.min(1, dt * 3);
      // Apply gaze AFTER mixer so it layers on the animated head pose.
      if (headBone) headBone.rotation.y += gaze * 0.6;

      rig.scale.setScalar(params.modelScale);

      // Camera orbit + dolly.
      azimuth += dt * params.orbit;
      const dist = 7.2 - dolly * 1.6;
      const cy = baseY * params.camHeight;
      camera.position.set(Math.sin(azimuth) * dist, cy + 1.2, Math.cos(azimuth) * dist);
      camera.lookAt(0, cy, 0);

      // Material / emissive drive.
      rimUniforms.uRimColor.value.setRGB(pal.rim[0], pal.rim[1], pal.rim[2]);
      rimUniforms.uRimIntensity.value = params.rimGlow;
      // Eyes pulse with breath + bass.
      eyePulse += ((1 + Math.sin(time * 1.6) * 0.15) - eyePulse) * Math.min(1, dt * 4);
      eyeMat.color.setRGB(pal.eye[0], pal.eye[1], pal.eye[2]).multiplyScalar(Math.max(0.2, params.eyeGlow * eyePulse));

      // Stars + aura.
      stars.rotation.y += dt * 0.01;
      starMat.color.setRGB(pal.star[0], pal.star[1], pal.star[2]);
      starMat.opacity = 0.35 + 0.55 * clamp(params.starAmount, 0, 2) * 0.5;
      if (auraSprite) {
        auraSprite.material.color.setRGB(pal.aura[0] / 255, pal.aura[1] / 255, pal.aura[2] / 255);
        auraSprite.material.opacity = 0.25 + params.auraAmount * 0.3;
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
      if (mixer) mixer.stopAllAction();
      disposeObject3D(scene);
    }

    return { resize, update, render, dispose };
  },
};
