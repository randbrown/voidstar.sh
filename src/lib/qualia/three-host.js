// Three.js host helpers — small surface that lets Three quales avoid
// reinventing the same dispose / audio-uniform / setup boilerplate, and
// keeps authoring conventions aligned with the canvas2d / webgl2 quales.
//
// Authoring conventions for `contextType: 'three'` quales:
//
//   1. Use NAMED imports from 'three' (`import { Scene, PerspectiveCamera, ... }`).
//      Never `import * as THREE`. Never import from 'three/examples/jsm/*'
//      without first writing it down here — addons break tree-shaking and
//      the bundle blows up fast.
//   2. Camera aspect is the quale's responsibility. In `resize(w, h, dpr)`
//      call `camera.aspect = w / h; camera.updateProjectionMatrix();
//      renderer.setSize(w, h, false)`. The trailing `false` keeps Three
//      from clobbering the canvas's CSS sizing.
//   3. DPR: leave `renderer.setPixelRatio(1)` set by core. Do NOT call
//      `setPixelRatio(window.devicePixelRatio)` — core already DPR-scales
//      the canvas pixel buffer.
//   4. Dispose: call ONLY `disposeObject3D(scene)` in your `dispose()`.
//      The renderer is core-owned and shared across all 'three' quales —
//      tearing it down would lose the GL context for the next quale on the
//      same canvas. Drop your scene/camera/material refs after.
//   5. Pose-driven camera transforms must be smoothed in `update()` (the
//      modulation engine is too jittery for a camera). Read pose channels
//      from `field.channels` directly; smooth via
//      `state += (target - state) * Math.min(1, dt * k)`.
//   6. Geometry-sizing params (point count, resolution) must NOT carry
//      `modulators` — modulating them would force buffer rebuilds every
//      frame. Use modulators only on uniform-fed values.
//   7. For param-driven geometry rebuilds (e.g. swapping orbital), hash the
//      relevant params at the top of `update()` and rebuild only when the
//      hash changes.
//   8. Always declare a `reactivity` range param (0..2, default 1.0). The
//      modulation engine multiplies every audio modulator by it.

/**
 * Recursively dispose every disposable on an Object3D subtree:
 *   - `geometry.dispose()`
 *   - `material.dispose()` (handles `Material[]` arrays from `Mesh.material`)
 *   - any texture references on a material's known map slots
 * Safe to call on `null` / `undefined`. Does NOT remove children from their
 * parents — the caller is expected to drop the root reference afterwards.
 */
export function disposeObject3D(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (obj.geometry && typeof obj.geometry.dispose === 'function') {
      obj.geometry.dispose();
    }
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for (const m of mats) {
      // Common texture slots — dispose them too. Adding more here is fine;
      // missing slots are silently skipped.
      const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
                     'emissiveMap', 'aoMap', 'envMap', 'alphaMap', 'displacementMap'];
      for (const s of slots) {
        const tex = m[s];
        if (tex && typeof tex.dispose === 'function') tex.dispose();
      }
      if (typeof m.dispose === 'function') m.dispose();
    }
  });
}

// Note: there used to be a `safeDisposeRenderer` helper here that quales
// called from their dispose() to forceContextLoss + renderer.dispose. That
// caused the canvas's GL context to die between switches between two
// 'three' quales — the next quale would see a lost context. The renderer
// is now core-owned (see core.js); quales must NOT dispose it themselves.

/**
 * Push the standard QualiaField audio uniforms into a Three ShaderMaterial's
 * `.uniforms` object, mirroring the shape used by `webgl.js` /
 * `uploadAudioUniforms` so GLSL written for the raw-WebGL path drops in
 * with minimal edits.
 *
 * Caller is responsible for declaring the matching uniforms when constructing
 * the ShaderMaterial:
 *   uniforms: {
 *     uBands:  { value: new THREE.Vector4() },
 *     uBeat:   { value: new THREE.Vector2() },
 *     uMids:   { value: new THREE.Vector2() },
 *     uHighs:  { value: new THREE.Vector2() },
 *     uRms:    { value: 0 },
 *     ...
 *   }
 */
export function applyAudioUniforms(uniforms, audio) {
  if (!uniforms || !audio) return;
  if (uniforms.uBands && uniforms.uBands.value && uniforms.uBands.value.set) {
    uniforms.uBands.value.set(audio.bands.bass, audio.bands.mids, audio.bands.highs, audio.bands.total);
  }
  if (uniforms.uBeat && uniforms.uBeat.value && uniforms.uBeat.value.set) {
    uniforms.uBeat.value.set(audio.beat.active ? 1 : 0, audio.beat.pulse);
  }
  if (uniforms.uMids && uniforms.uMids.value && uniforms.uMids.value.set) {
    uniforms.uMids.value.set(audio.mids.active ? 1 : 0, audio.mids.pulse);
  }
  if (uniforms.uHighs && uniforms.uHighs.value && uniforms.uHighs.value.set) {
    uniforms.uHighs.value.set(audio.highs.active ? 1 : 0, audio.highs.pulse);
  }
  if (uniforms.uRms) uniforms.uRms.value = audio.rms;
}
