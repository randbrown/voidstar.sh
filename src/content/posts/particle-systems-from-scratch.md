---
title: "10,000 Particles, No Libraries: Building Fast Particle Systems in Canvas2D"
description: "Typed arrays, additive blending, and curl noise — everything you need to run a high-performance particle system in the browser without a game engine."
pubDate: 2026-03-05
tags: ["particles", "canvas2d", "javascript", "performance", "generative"]
---

The temptation with particle systems is to reach for a library. Don't. When you understand what's underneath, you can do things no library anticipated — like feeding landmark coordinates from a pose model directly into your force field, or modulating curl noise frequency from a live FFT.

## Data layout: why typed arrays matter

The single biggest performance win is memory layout. An array of `{ x, y, vx, vy, age }` objects is cache-unfriendly — the CPU has to chase pointers across the heap for every particle. Typed arrays pack tight:

```js
const N = 10_000;
const px   = new Float32Array(N); // x positions
const py   = new Float32Array(N); // y positions
const vx   = new Float32Array(N); // x velocity
const vy   = new Float32Array(N); // y velocity
const age  = new Float32Array(N); // current age (seconds)
const life = new Float32Array(N); // max lifetime (seconds)
```

Six arrays, 240KB total, all contiguous in memory. The CPU loves it.

## The update loop

```js
const DAMPING = 0.98;
const GRAVITY = 0.04;

function update(dt) {
  for (let i = 0; i < N; i++) {
    age[i] += dt;

    // respawn dead particles
    if (age[i] >= life[i]) {
      respawn(i);
      continue;
    }

    // apply forces
    const [fx, fy] = curl(px[i], py[i], t);
    vx[i] = (vx[i] + fx) * DAMPING;
    vy[i] = (vy[i] + fy + GRAVITY) * DAMPING;

    px[i] += vx[i];
    py[i] += vy[i];
  }
}
```

`curl()` returns a divergence-free vector field — particles flow smoothly without clumping. The formula uses finite differences on a Perlin or simplex noise field:

```js
const EPS = 0.01;
function curl(x, y, t) {
  const n1 = noise(x, y + EPS, t);
  const n2 = noise(x, y - EPS, t);
  const n3 = noise(x + EPS, y, t);
  const n4 = noise(x - EPS, y, t);
  return [(n1 - n2) / (2 * EPS), -(n3 - n4) / (2 * EPS)];
}
```

## Rendering tricks

**Additive blending** is the single biggest visual upgrade. Set `ctx.globalCompositeOperation = 'lighter'` before drawing and particles accumulate light like they're emitting it. Dense clusters glow; sparse regions stay dark. It looks like plasma.

**Motion trails without `clearRect`.** Instead of clearing the canvas each frame, draw a semi-transparent black rectangle over it:

```js
ctx.fillStyle = 'rgba(5, 5, 13, 0.18)';
ctx.fillRect(0, 0, W, H);
```

Older particle positions fade naturally. The decay rate controls how long the trails persist — lower alpha means longer trails.

**Batch by color.** State changes (setting `fillStyle`) are expensive in Canvas2D. Sort particles into color buckets and batch all draws of the same color together:

```js
ctx.fillStyle = `hsl(${hue}, 80%, 60%)`;
for (let i of bucket) {
  ctx.fillRect(px[i] - r, py[i] - r, 2*r, 2*r);
}
```

## What to attach forces to

The physics are a platform. What you attach to the force field is where it gets interesting:

- **Curl noise alone** — organic, fluid-like, hypnotic on a loop
- **Mouse/touch position** — an attractor under the cursor, repeller on right-click
- **MediaPipe landmarks** — your skeleton becomes the force field (see [Pose Particles post](/posts/pose-tracking-particles))
- **FFT frequency bands** — bass pumps the vortex radius, hi-hats scatter particles outward
- **Other particles** — n-body gravity at small N (64 "planets") driving 10k "dust" particles

The lab demo lets you combine all of these live. Toggle pose tracking on and the skeleton joints become attractors; unmute the mic and the curl noise frequency starts responding to your voice.

→ [Open the Particle demo in the Lab](/lab)
→ [Source on GitHub](https://github.com/randbrown)
