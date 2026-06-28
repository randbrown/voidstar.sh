// Procedural lofi sample-pack generator — dependency-free.
//
// Renders a small bank of synthetic drum one-shots to 16-bit mono WAV under
// `public/samples/voidstar-lofi/` and writes a Strudel-format `strudel.json`
// manifest beside them. The same manifest is loaded by BOTH engines:
//   - Strudel  → `samples()` (so `s("bd sd hh")` plays these in the REPL)
//   - Sequencer → `samples-manifest.js` → Tone buffers (the "lofi tape" kit)
//
// "Synthetic samples": every hit here is pure math (no recordings, no deps),
// so the pack is tiny, CC0-clean, and regenerates deterministically. Lofi
// character comes from a low sample rate, sample-rate reduction (sample &
// hold), bit-crush, soft tape saturation and a touch of hiss — applied as a
// shared finishing chain so the kit reads as one cohesive instrument.
//
// Run with:  node scripts/gen-samples.mjs
// Re-run after editing voice recipes; commit the regenerated WAVs + json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'samples', 'voidstar-lofi');

// Lofi by design: 22.05 kHz halves the bandwidth of CD audio (no air above
// ~11 kHz) and halves file size. All voice math runs at this rate.
const SR = 22050;

// ── Tiny seeded PRNG so noise is identical run-to-run (stable git diffs) ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── DSP helpers (all operate on Float32 mono buffers, range ~[-1,1]) ──────
const secs = (s) => Math.max(1, Math.round(s * SR));
function buf(durSec) { return new Float32Array(secs(durSec)); }

// Exponential decay envelope value at sample i (≈ -60 dB at `tau` seconds).
function expEnv(i, tau) { return Math.exp((-1 * i) / (tau * SR)); }

// One-pole low-pass, in place. cutoff in Hz.
function lowpass(x, cutoff) {
  const dt = 1 / SR;
  const rc = 1 / (2 * Math.PI * cutoff);
  const a = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; }
  return x;
}
// One-pole high-pass, in place.
function highpass(x, cutoff) {
  const dt = 1 / SR;
  const rc = 1 / (2 * Math.PI * cutoff);
  const a = rc / (rc + dt);
  let prevX = 0, prevY = 0;
  for (let i = 0; i < x.length; i++) {
    const y = a * (prevY + x[i] - prevX);
    prevX = x[i]; prevY = y; x[i] = y;
  }
  return x;
}
function softclip(x, drive = 1) {
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive);
  return x;
}
function gain(x, g) { for (let i = 0; i < x.length; i++) x[i] *= g; return x; }
function addInto(dst, src, g = 1) {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] += src[i] * g;
  return dst;
}
function noise(rand, n) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  return x;
}

// Sample-rate reduction (sample & hold) — the core "crunchy" lofi move.
// `targetHz` is the effective rate the signal is decimated to.
function sampleHold(x, targetHz) {
  const step = Math.max(1, Math.round(SR / targetHz));
  let held = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % step === 0) held = x[i];
    x[i] = held;
  }
  return x;
}
// Bit-crush to `bits` of resolution.
function bitcrush(x, bits) {
  const levels = Math.pow(2, bits);
  for (let i = 0; i < x.length; i++) x[i] = Math.round(x[i] * levels) / levels;
  return x;
}
// Peak-normalise to `peak` (skips silent buffers).
function normalize(x, peak = 0.95) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 1e-6) gain(x, peak / m);
  return x;
}
// Short fade-out so a truncated tail never clicks.
function fadeOut(x, ms = 8) {
  const n = Math.min(x.length, secs(ms / 1000));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}

// Shared lofi finishing chain — gives every voice a consistent grain so the
// pack reads as one instrument rather than ten unrelated synths.
function lofi(x, { srr = 12000, bits = 11, drive = 1.4, hiss = 0.0 } = {}, rand) {
  softclip(x, drive);
  sampleHold(x, srr);
  bitcrush(x, bits);
  if (hiss > 0 && rand) {
    const h = highpass(noise(rand, x.length), 2000);
    addInto(x, h, hiss);
  }
  normalize(x, 0.92);
  fadeOut(x);
  return x;
}

// ── Voice recipes ─────────────────────────────────────────────────────────
// Each returns a finished Float32 mono buffer. A fresh seeded RNG per voice
// keeps noise textures stable and independent.
const VOICES = {
  // Warm, round kick — pitch drops 120→48 Hz, body decays ~0.3 s, light click.
  bd() {
    const rand = mulberry32(1001);
    const x = buf(0.42);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const f = 48 + (120 - 48) * Math.exp(-t / 0.022);
      const phase = 2 * Math.PI * f * t;
      x[i] = Math.sin(phase) * expEnv(i, 0.30);
    }
    const click = noise(rand, secs(0.004));
    addInto(x, lowpass(click, 3000), 0.25);
    lowpass(x, 1400);
    return lofi(x, { srr: 11000, bits: 11, drive: 1.8 }, rand);
  },
  // Snare — 190/330 Hz body + band-limited noise crack.
  sd() {
    const rand = mulberry32(1002);
    const x = buf(0.22);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const body = (Math.sin(2 * Math.PI * 190 * t) + 0.6 * Math.sin(2 * Math.PI * 330 * t));
      x[i] = body * expEnv(i, 0.085) * 0.6;
    }
    let n = noise(rand, x.length);
    highpass(n, 1500); lowpass(n, 7000);
    for (let i = 0; i < n.length; i++) n[i] *= expEnv(i, 0.10);
    addInto(x, n, 0.8);
    return lofi(x, { srr: 12000, bits: 11, drive: 1.3, hiss: 0.015 }, rand);
  },
  // Rimshot — tight metallic click.
  rim() {
    const rand = mulberry32(1003);
    const x = buf(0.05);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      x[i] = Math.sin(2 * Math.PI * 1700 * t) * expEnv(i, 0.012);
    }
    const n = noise(rand, x.length);
    highpass(n, 1200);
    for (let i = 0; i < n.length; i++) n[i] *= expEnv(i, 0.008);
    addInto(x, n, 0.5);
    return lofi(x, { srr: 12000, bits: 11, drive: 1.5 }, rand);
  },
  // Closed hat — bright, very short highpassed noise.
  hh() {
    const rand = mulberry32(1004);
    const x = noise(rand, secs(0.06));
    highpass(x, 7000);
    for (let i = 0; i < x.length; i++) x[i] *= expEnv(i, 0.028);
    return lofi(x, { srr: 12000, bits: 10, drive: 1.2 }, rand);
  },
  // Open hat — same texture, long decay.
  oh() {
    const rand = mulberry32(1005);
    const x = noise(rand, secs(0.35));
    highpass(x, 6500);
    for (let i = 0; i < x.length; i++) x[i] *= expEnv(i, 0.16);
    return lofi(x, { srr: 12000, bits: 10, drive: 1.2 }, rand);
  },
  // Toms — sine with pitch envelope; three pitches share the recipe.
  lt() { return tom(90,  0.30, 2011); },
  mt() { return tom(130, 0.27, 2012); },
  ht() { return tom(180, 0.24, 2013); },
  // Ride — inharmonic partial stack, bright and sustained.
  rd() {
    const rand = mulberry32(1006);
    const x = buf(0.6);
    const ratios = [1, 1.34, 1.79, 2.41, 3.07, 3.83];
    const base = 520;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      let s = 0;
      for (let k = 0; k < ratios.length; k++) s += Math.sin(2 * Math.PI * base * ratios[k] * t);
      x[i] = (s / ratios.length) * expEnv(i, 0.28);
    }
    highpass(x, 3000);
    return lofi(x, { srr: 12000, bits: 10, drive: 1.3 }, rand);
  },
  // Crash — noise wash with a slow shimmer.
  cr() {
    const rand = mulberry32(1007);
    const x = noise(rand, secs(0.9));
    highpass(x, 3000);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const shimmer = 0.85 + 0.15 * Math.sin(2 * Math.PI * 7 * t);
      x[i] *= expEnv(i, 0.45) * shimmer;
    }
    return lofi(x, { srr: 12000, bits: 10, drive: 1.2 }, rand);
  },
};
function tom(freq, tau, seed) {
  const rand = mulberry32(seed);
  const x = buf(tau + 0.05);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const f = freq * (1 + 0.6 * Math.exp(-t / 0.04));
    x[i] = Math.sin(2 * Math.PI * f * t) * expEnv(i, tau);
  }
  lowpass(x, 2200);
  return lofi(x, { srr: 11000, bits: 11, drive: 1.5 }, rand);
}

// ── WAV writer — 16-bit PCM mono ────────────────────────────────────────
function encodeWav(samples, sampleRate = SR) {
  const n = samples.length;
  const buffer = Buffer.alloc(44 + n * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + n * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);      // fmt chunk size
  buffer.writeUInt16LE(1, 20);       // PCM
  buffer.writeUInt16LE(1, 22);       // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);       // block align
  buffer.writeUInt16LE(16, 34);      // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2);
  }
  return buffer;
}

// ── Render ──────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const manifest = {
  // Root-relative base: both Strudel's samples() and the sequencer's
  // manifest loader resolve each path against the site origin. Keeping it
  // here (not hard-coded in two loaders) makes the pack relocatable.
  _base: '/samples/voidstar-lofi/',
};
let total = 0;
for (const [name, render] of Object.entries(VOICES)) {
  const wav = encodeWav(render());
  const file = `${name}.wav`;
  writeFileSync(join(OUT_DIR, file), wav);
  manifest[name] = [file];
  total += wav.length;
  console.log(`  ${file.padEnd(10)} ${(wav.length / 1024).toFixed(1)} KB`);
}
writeFileSync(join(OUT_DIR, 'strudel.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nWrote ${Object.keys(VOICES).length} voices (${(total / 1024).toFixed(1)} KB) + strudel.json to`);
console.log(`  ${OUT_DIR}`);
