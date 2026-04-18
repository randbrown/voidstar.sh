---
title: "Skeleton as Attractor: Real-Time Pose Particles in the Browser"
description: "Using MediaPipe Pose to turn body landmarks into live attractor fields that shape a particle system — no server, no install, just a camera and a canvas."
pubDate: 2026-04-10
tags: ["pose-tracking", "particles", "mediapipe", "canvas2d", "camera"]
---

The idea is simple: your skeleton becomes the physics engine.

MediaPipe Pose gives you 33 body landmarks — nose, shoulders, elbows, wrists, hips, knees, ankles — each as a normalized `{x, y, z, visibility}` vector at ~30fps in the browser. Feed those coordinates into an attractor field and suddenly every particle in your system is reacting to your body in real time.

## The setup

```js
import { Pose } from '@mediapipe/pose';

const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
});

pose.setOptions({
  modelComplexity: 1,
  smoothLandmarks: true,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
});

pose.onResults(onPoseResults);
```

You pipe a `<video>` element into `pose.send()` on each animation frame. The results callback gives you `results.poseLandmarks` — an array of 33 points you can use however you want.

## Landmark → attractor

I map each landmark to a force field centered at its canvas position. Every particle within a radius `R` gets a velocity nudge toward (or away from) that point, scaled by `1/distance²`:

```js
function applyLandmarkForces(landmarks, px, py, vx, vy, N) {
  for (const lm of landmarks) {
    if (lm.visibility < 0.5) continue; // skip occluded joints

    const lx = lm.x * canvas.width;
    const ly = lm.y * canvas.height;

    for (let i = 0; i < N; i++) {
      const dx = lx - px[i];
      const dy = ly - py[i];
      const distSq = dx * dx + dy * dy;
      if (distSq > R * R || distSq < 1) continue;

      const force = STRENGTH / distSq;
      vx[i] += dx * force;
      vy[i] += dy * force;
    }
  }
}
```

Using typed arrays (`Float32Array`) keeps this fast enough to run 10k particles alongside the pose model at a stable 30fps on a mid-range laptop.

## Making it interesting

A plain gravity attractor is boring after 30 seconds. A few variations that work well:

**Repeller joints** — wrists push particles away while shoulders pull them in. The body becomes a lens.

**Velocity-coded color** — map particle speed to hue. Slow particles near the body glow violet; fast ones ejected outward shift to cyan.

**Additive blending** — `ctx.globalCompositeOperation = 'lighter'` makes dense clusters near joints bloom into bright focal points. Combined with a slow fade (semi-transparent fill instead of `clearRect`) you get motion trails that trace the body's path through space.

**Audio modulation** — feed a microphone FFT into the attractor strength so the field pulses to beat.

The lab demo wires all of these together. It asks for camera (and optionally microphone) access, loads the MediaPipe WASM model, and runs everything in a single `requestAnimationFrame` loop — no backend required.

→ [Open the Pose Particles demo in the Lab](/lab)
→ [Source on GitHub](https://github.com/randbrown)
