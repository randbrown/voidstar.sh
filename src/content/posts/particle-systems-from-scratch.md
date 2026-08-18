---
title: "particle systems from scratch (no library)"
description: "Skip the library — a fast Canvas2D particle system fits in a screen of code, and then you can feed it pose, audio, or your mouse."
pubDate: 2026-03-05
updatedDate: 2026-08-18
tags: ["canvas", "particles", "javascript", "graphics", "performance"]
---

The temptation is to `npm install` a particle library. Don't. The whole thing fits on one screen, and once you own the loop you can pipe pose landmarks, a live FFT, or your mouse straight into the force field.

## typed arrays or bust

An array of `{x, y, vx, vy}` objects is cache poison — the fields you touch every frame are scattered all over the heap. Flip it: one flat `Float32Array` per attribute. 10k particles across six arrays is ~240KB sitting contiguous in memory, which the CPU loves.

```js
const N = 10000;
const px  = new Float32Array(N);
const py  = new Float32Array(N);
const vx  = new Float32Array(N);
const vy  = new Float32Array(N);
const age = new Float32Array(N);
const life = new Float32Array(N);
```

## the loop is boring on purpose

Damping, a little gravity, respawn when a particle ages out, and a force field. That's the whole simulation.

```js
function step() {
  for (let i = 0; i < N; i++) {
    const [fx, fy] = curl(px[i] * 0.005, py[i] * 0.005);
    vx[i] = vx[i] * 0.98 + fx;
    vy[i] = vy[i] * 0.98 + fy + 0.04; // gravity
    px[i] += vx[i];
    py[i] += vy[i];
    if ((age[i] += 1) >= life[i]) respawn(i);
  }
}
```

`curl()` is the fun part. It's a divergence-free field, so particles swirl and flow instead of piling up in a corner. You get it by finite-differencing a noise function and rotating the gradient 90°.

```js
const EPS = 0.01;
function curl(x, y) {
  const dx = noise(x, y + EPS) - noise(x, y - EPS);
  const dy = noise(x + EPS, y) - noise(x - EPS, y);
  return [dx / (2 * EPS), -dy / (2 * EPS)];
}
```

Bring your own `noise()` — any Perlin/simplex will do.

## two rendering tricks that do all the work

You don't need shaders to make this look expensive. Two cheap moves:

- **Additive blending.** Set `globalCompositeOperation = 'lighter'` so overlapping particles bloom into plasma.
- **Motion trails.** Don't `clearRect`. Paint a semi-transparent black rect over the whole frame — old positions fade instead of blinking out.

```js
ctx.globalCompositeOperation = 'lighter';
// each frame, instead of clearRect:
ctx.fillStyle = 'rgba(0,0,0,0.1)';
ctx.fillRect(0, 0, w, h);
```

One gotcha: changing `fillStyle` is genuinely expensive. If your particles are colored, bucket them by color and draw each bucket in a single pass. Don't set the style 10,000 times a frame.

## what you actually plug in

The loop doesn't care where the force comes from. That's the payoff of not using a library — swap `curl()` for whatever you've got:

- a mouse/touch attractor
- MediaPipe pose landmarks, so the skeleton *is* the field and a dancer shoves the particles around in real time
- FFT bands off a live audio source, so the bass drives the swirl
- other particles, if you want to pay for n-body

Same 240KB, same boring loop. Point it at a body or a waveform and it turns into an instrument.

→ Play with it live: [/lab/pose-particles](/lab/pose-particles)
→ Feeding pose into the field, in depth: [/posts/pose-tracking-particles](/posts/pose-tracking-particles)
→ The tracking half (skeleton landmarks): [MediaPipe](https://ai.google.dev/edge/mediapipe)
→ Or drive it with audio instead: [/qualia](/qualia)
→ Source: [github.com/randbrown](https://github.com/randbrown)
