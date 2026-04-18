---
title: "Particle Systems from Scratch"
description: "Building a GPU-friendly particle system using Canvas2D and typed arrays — no libraries, no magic."
pubDate: 2026-03-10
tags: ["code", "particles", "canvas", "javascript"]
---

The temptation with particle systems is to reach for a library. Don't. When you understand what's underneath, you can do things no library anticipated.

## The core loop

Every particle system needs three things:

1. **State** — where each particle is, how fast it's moving, how long it's lived
2. **Update** — integrate position from velocity, apply forces, age the particle
3. **Render** — draw each particle, clear the canvas, repeat

```js
const N = 10_000;
const px = new Float32Array(N); // x positions
const py = new Float32Array(N); // y positions
const vx = new Float32Array(N); // x velocities
const vy = new Float32Array(N); // y velocities
const age = new Float32Array(N);
const life = new Float32Array(N);
```

Using typed arrays instead of objects is the single biggest performance win. Object arrays blow the CPU cache; typed arrays pack tight.

## Forces

The interesting part. Gravity is boring — try:

- **Curl noise** for smooth, swirling motion
- **Attractor fields** that pulse to audio amplitude
- **Pose-driven forces** from MediaPipe landmark positions

That last one is what the pose-tracking demo uses. Each skeleton joint becomes an attractor or repeller, and the particles flow around the body like smoke.

## Rendering tricks

- **Additive blending** (`ctx.globalCompositeOperation = 'lighter'`) makes dense clusters glow
- **Skip `clearRect`** — fade with a semi-transparent fill instead for motion trails
- **Batch fills by color** to minimize state changes

The demo in the [Lab](/lab) section shows all of this running at ~60fps on a mid-range laptop. Go check it out.
