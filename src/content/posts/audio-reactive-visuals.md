---
title: "Hearing in Color: Audio-Reactive Visuals with the Web Audio API"
description: "Building a real-time audio visualizer using the browser's built-in FFT — from microphone input to frequency-mapped particle fields and shader-driven waveforms."
pubDate: 2026-03-22
tags: ["audio", "web-audio", "fft", "canvas2d", "generative"]
---

Music and visuals have always wanted to be the same thing. The Web Audio API makes it surprisingly easy to bridge them — no plugins, no native code, just the browser's built-in signal processing running in real time.

## Getting frequency data

The core tool is `AnalyserNode`. Hook it up to any audio source — microphone, audio file, oscillator — and it hands you a `Uint8Array` of amplitude values at each FFT frequency bin on every frame:

```js
const ctx = new AudioContext();
const analyser = ctx.createAnalyser();
analyser.fftSize = 2048; // 1024 frequency bins
analyser.smoothingTimeConstant = 0.8; // temporal smoothing

// Microphone input
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const source = ctx.createMediaStreamSource(stream);
source.connect(analyser);

const freqData = new Uint8Array(analyser.frequencyBinCount); // 1024 values, 0–255

function tick() {
  analyser.getByteFrequencyData(freqData);
  // freqData is now fresh — draw with it
  requestAnimationFrame(tick);
}
```

Each value in `freqData` is 0–255. Index 0 is sub-bass, the last index is ~22kHz. Most musical energy lives in the low-to-mid range (indices 0–200 or so for a 44.1kHz sample rate).

## Mapping frequency to visuals

The interesting work is in the mapping. Some approaches I've used:

**Bass → particle burst size.** Average indices 0–8 (sub-bass), normalize to 0–1, use it to scale an attractor radius. Heavy kick hits make the field explode outward.

**Mid → rotation speed.** The 200–600Hz range (snare, chord stabs) drives the angular velocity of a swirling vortex. The visual "breathes" with the rhythm section.

**High → sparkle density.** High-frequency content (hi-hats, cymbals) triggers short-lived bright particles that fade in under 100ms. Silence sounds like void; a busy hi-hat pattern looks like static electricity.

**Waveform → ribbon geometry.** Instead of the frequency domain, `getByteTimeDomainData()` gives you the raw waveform. Draw it as a thick ribbon with varying width (mapped to amplitude) and you get the classic oscilloscope look — but curved, rotated, and color-shifted over time.

## The smoothing problem

Raw FFT data is jittery. The `smoothingTimeConstant` on `AnalyserNode` helps (0.8–0.9 is a good start), but for visuals you often want an additional layer: track a rolling average or apply a simple exponential moving average per bin:

```js
const smoothed = new Float32Array(analyser.frequencyBinCount);
const alpha = 0.15; // higher = more responsive, lower = smoother

analyser.getByteFrequencyData(freqData);
for (let i = 0; i < freqData.length; i++) {
  smoothed[i] += alpha * (freqData[i] / 255 - smoothed[i]);
}
```

Use `smoothed` for driving slow-moving parameters (particle field strength, color hue) and raw `freqData` for fast transient effects (flash on kick, sparkle on snare).

## Beat detection

True beat detection is a deep rabbit hole, but a cheap version works surprisingly well for dance music: track the running average of the bass band energy. When the current frame's energy exceeds the average by a threshold factor (~1.5×), call it a beat:

```js
let avgBass = 0;
function detectBeat(freqData) {
  const bass = freqData.slice(0, 8).reduce((s, v) => s + v, 0) / 8;
  avgBass = 0.95 * avgBass + 0.05 * bass;
  return bass > avgBass * 1.5;
}
```

Trigger a particle burst, a color flash, or a camera shake on each beat hit. It won't win any DSP awards but it's fast and feels good.

The full lab demo combines microphone FFT, beat detection, and a pose particle field — the music shapes the physics, and your body shapes the field. The whole thing runs in one `requestAnimationFrame` loop.

→ [Open the Audio Reactive demo in the Lab](/lab)
→ [Source on GitHub](https://github.com/randbrown)
