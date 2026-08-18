---
title: "hearing in color: audio-reactive visuals with the browser's FFT"
description: "Point an AnalyserNode at the mic, read the spectrum every frame, and map bass/mid/highs to visuals — the lazy, browser-native way."
pubDate: 2026-03-22
updatedDate: 2026-08-18
tags: ["audio", "web-audio", "fft", "canvas2d", "generative"]
---

Turns out the browser already ships a decent FFT. No plugins, no C++, no build step — you point an `AnalyserNode` at the mic and it hands you the spectrum every frame. Here's the lazy version that looks great on a projector.

## grab the spectrum

Hook the analyser to any source — mic, an audio file, an oscillator — and read a `Uint8Array` of amplitudes, one per frequency bin, every frame.

```js
const ctx = new AudioContext();
const analyser = ctx.createAnalyser();
analyser.fftSize = 2048;              // 1024 bins
analyser.smoothingTimeConstant = 0.8; // free temporal smoothing

const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
ctx.createMediaStreamSource(stream).connect(analyser);

const freq = new Uint8Array(analyser.frequencyBinCount); // 1024 values, 0–255
function tick() {
  analyser.getByteFrequencyData(freq); // freq is now fresh
  requestAnimationFrame(tick);
}
```

Index 0 is sub-bass, the last bin is ~22kHz, and basically all the musical energy lives down in the low-to-mid range. So don't overthink it — a few band averages get you most of the way.

## map bands to stuff that moves

The whole trick is picking which slice drives which knob:

- **Bass** (indices 0–8) → burst size. Kick hits, the field explodes.
- **Mid** (200–600Hz-ish) → rotation speed. Breathes with the rhythm section.
- **Highs** (hats, cymbals) → sparkle density. Silence looks like void; a busy hat pattern looks like static.

Want the oscilloscope look instead? Skip the frequency domain — `getByteTimeDomainData()` hands you the raw waveform. Draw it as a fat ribbon, curve it, rotate it, shift the color over time.

## kill the jitter

Raw FFT flickers. `smoothingTimeConstant` helps, but I usually stack a cheap per-bin exponential moving average on top:

```js
const smoothed = new Float32Array(analyser.frequencyBinCount);
const alpha = 0.15; // higher = snappier, lower = smoother
for (let i = 0; i < freq.length; i++) {
  smoothed[i] += alpha * (freq[i] / 255 - smoothed[i]);
}
```

Drive slow params (hue, field strength) off `smoothed`; keep raw `freq` for fast transients — flash on kick, sparkle on snare.

## fake beat detection that feels good

Real onset detection is a rabbit hole. This isn't, and it holds up fine for anything with a kick:

```js
let avgBass = 0;
function isBeat(freq) {
  const bass = freq.slice(0, 8).reduce((s, v) => s + v, 0) / 8;
  avgBass = 0.95 * avgBass + 0.05 * bass;
  return bass > avgBass * 1.5; // spiked above the running average
}
```

Fire a burst, a flash, a camera shake on each hit. Won't win a DSP award, feels great on stage.

All of it runs in one `requestAnimationFrame` loop — mic in, pixels out, nothing installed.

→ [The whole thing, playable — the qualia instrument](/qualia)
→ [Audio-reactive cymatics in the lab](/lab/cymatics)
→ [Web Audio API on MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
→ [Source on GitHub](https://github.com/randbrown)
