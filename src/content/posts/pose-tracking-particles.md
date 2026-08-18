---
title: "your skeleton is the physics engine"
description: "33 MediaPipe landmarks, a 1/dist² attractor field, and 10k particles that chase your elbows — all in the browser, no install."
pubDate: 2026-04-10
updatedDate: 2026-08-18
tags: ["pose-tracking", "particles", "mediapipe", "web-audio", "creative-coding"]
---

Your skeleton is a pretty good physics engine, and you already own one. MediaPipe Pose hands you 33 body landmarks — each a normalized `{x, y, z, visibility}` — at ~30fps, right in the browser. Point a particle field at them and every dot on screen starts chasing your elbows.

## the whole trick

Load `@mediapipe/pose`, feed it a `<video>` per frame, read `poseLandmarks`. That's the entire pose pipeline.

```js
import { Pose } from "@mediapipe/pose";

const pose = new Pose({
  locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`,
});
pose.setOptions({
  modelComplexity: 1,
  smoothLandmarks: true,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
});
pose.onResults(r => (landmarks = r.poseLandmarks)); // 33 points

// in your render loop:
await pose.send({ image: video });
```

`smoothLandmarks` is doing a lot of quiet work here — without it the joints jitter and your particles look nervous.

Running `pose.send` in the render loop is fine for a demo. For a real set you'd move inference into a worker so a slow forward pass never stutters the visuals — that's exactly what [qualia](/qualia) does — but that's an optimization, not step one.

## landmarks → attractors

Every visible landmark becomes a little gravity well. For each particle, sum the pull from each joint with a `1/dist²` falloff and nudge its velocity. Skip anything under 0.5 visibility so an offscreen limb doesn't yank the whole field.

```js
for (const lm of landmarks) {
  if (lm.visibility < 0.5) continue;
  const ax = lm.x * width, ay = lm.y * height;
  for (let i = 0; i < N; i++) {
    const dx = ax - px[i], dy = ay - py[i];
    const d2 = dx*dx + dy*dy + 1e-3;   // +epsilon, no divide-by-zero
    const f = strength / d2;
    vx[i] += dx * f;
    vy[i] += dy * f;
  }
}
```

Keep positions and velocities in flat `Float32Array`s, not objects (the [particle-systems post](/posts/particle-systems-from-scratch) has the why). On a mid laptop the model plus 10k particles stays comfortably real-time.

## make it weird

The naive version is a blob that follows you. A few cheap upgrades earn their keep:

- **Repellers.** Flip the sign per joint — wrists push, shoulders pull. Waving your arms now carves negative space instead of just gathering dots.
- **Velocity color.** Map speed to hue. Fast particles go hot, settled ones cool. Free motion-heatmap.
- **Trails.** Don't clear the canvas — paint a translucent black rect each frame and blend additively. Instant motion smear, zero history to track.
- **Let the music in.** Run the mic through an `AnalyserNode`, grab the FFT, pipe the low-band energy into `strength`. Bass hits, the field breathes.

That last one is where it stops being a tech demo. Pose gives you space, audio gives you time, and the particles live in the middle.

→ play with it live: [/lab/pose-particles](/lab/pose-particles)
→ where it grew up — the instrument: [/qualia](/qualia)
→ audio-reactive cousin: [/lab/cymatics](/lab/cymatics)
→ MediaPipe Pose docs: [ai.google.dev/edge/mediapipe](https://ai.google.dev/edge/mediapipe)
→ the AnalyserNode / FFT bits: [Web Audio API on MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
→ source: [github.com/randbrown](https://github.com/randbrown)
