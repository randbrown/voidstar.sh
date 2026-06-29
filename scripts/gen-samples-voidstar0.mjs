// voidstar_0 sample-pack generator — dependency-free (the ORIGINAL packs).
//
// This is the original procedural generator, preserved as the `voidstar_0`
// collection — the neutral baseline kept alongside the newer `signature`
// collection (scripts/gen-samples.mjs) for A/B comparison. See docs/samples.md
// for the collection model.
//
// Renders one synthetic drum pack per genre (voidstar / lofi / tape / dub /
// jazz / metal / death / hiphop) to 16-bit mono WAV under
// `public/samples/voidstar_0/<genre>/`, each with a Strudel-format
// `strudel.json`. These are the *sample* variant of every kit; the *synth*
// variants live in sequencer-voices.js. Both engines load these manifests:
//   - Strudel  → samples() (registered with a `<genre>_` / `v0<genre>_` prefix)
//   - Sequencer → samples-manifest.js → Tone buffers (the "<genre> · samples" kit)
//
// "Synthetic samples": every hit is pure math (no recordings, no deps) so the
// packs are tiny, CC0-clean and regenerate deterministically. Genre character
// comes from a per-genre profile (tuning, decay, brightness) plus a shared
// finishing chain (sample-rate reduction + bit-crush + saturation + hiss) dialed
// per genre — clean for jazz/metal/death, dusty for lofi/tape/hiphop.
//
// Run:  node scripts/gen-samples-voidstar0.mjs   (or `npm run gen:samples:v0`)
// Re-run after editing a profile; commit the regenerated WAVs + json.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLLECTION = 'voidstar_0';
const SAMPLES_ROOT = join(__dirname, '..', 'public', 'samples', COLLECTION);

// Lofi by design: 22.05 kHz halves CD bandwidth (no air above ~11 kHz) and
// halves file size. Plenty for drums; the crush profile does the era-shaping.
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
function expEnv(i, tau) { return Math.exp((-1 * i) / (tau * SR)); }

function lowpass(x, cutoff) {
  const dt = 1 / SR, rc = 1 / (2 * Math.PI * cutoff), a = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; }
  return x;
}
function highpass(x, cutoff) {
  const dt = 1 / SR, rc = 1 / (2 * Math.PI * cutoff), a = rc / (rc + dt);
  let prevX = 0, prevY = 0;
  for (let i = 0; i < x.length; i++) {
    const y = a * (prevY + x[i] - prevX);
    prevX = x[i]; prevY = y; x[i] = y;
  }
  return x;
}
function softclip(x, drive = 1) { for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive); return x; }
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
function sampleHold(x, targetHz) {
  const step = Math.max(1, Math.round(SR / targetHz));
  let held = 0;
  for (let i = 0; i < x.length; i++) { if (i % step === 0) held = x[i]; x[i] = held; }
  return x;
}
function bitcrush(x, bits) {
  const levels = Math.pow(2, bits);
  for (let i = 0; i < x.length; i++) x[i] = Math.round(x[i] * levels) / levels;
  return x;
}
function normalize(x, peak = 0.92) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 1e-6) gain(x, peak / m);
  return x;
}
function fadeOut(x, ms = 8) {
  const n = Math.min(x.length, secs(ms / 1000));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}
// Shared finishing chain — the per-genre "grain". `srr` ≥ SR means no decimation.
function finish(x, fin, rand) {
  softclip(x, fin.drive);
  if (fin.srr < SR) sampleHold(x, fin.srr);
  if (fin.bits < 16) bitcrush(x, fin.bits);
  if (fin.hiss > 0 && rand) addInto(x, highpass(noise(rand, x.length), 2000), fin.hiss);
  normalize(x, 0.92);
  fadeOut(x);
  return x;
}

// ── Generic voice renderers, driven by a profile ─────────────────────────
function renderKick(p, seed) {
  const rand = mulberry32(seed);
  const k = p.kick;
  const x = buf(k.tau + 0.12);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const f = k.f1 + (k.f0 - k.f1) * Math.exp(-t / k.pdecay);
    x[i] = Math.sin(2 * Math.PI * f * t) * expEnv(i, k.tau);
  }
  if (k.click > 0) {
    const click = noise(rand, secs(0.005));
    addInto(x, lowpass(click, k.clickLp || 4000), k.click);
  }
  if (k.lp) lowpass(x, k.lp);
  return finish(x, p.fin, rand);
}
function renderSnare(p, seed) {
  const rand = mulberry32(seed);
  const s = p.snare;
  const x = buf(Math.max(s.bodyTau, s.noiseTau) + 0.05);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const body = Math.sin(2 * Math.PI * s.bodyF * t) + 0.6 * Math.sin(2 * Math.PI * s.bodyF * 1.6 * t);
    x[i] = body * expEnv(i, s.bodyTau) * s.bodyMix;
  }
  const n = noise(rand, secs(s.noiseTau + 0.02));
  highpass(n, s.noiseHp); lowpass(n, s.noiseLp);
  for (let i = 0; i < n.length; i++) n[i] *= expEnv(i, s.noiseTau);
  addInto(x, n, s.noiseMix);
  return finish(x, p.fin, rand);
}
function renderRim(p, seed) {
  const rand = mulberry32(seed);
  const r = p.rim;
  const x = buf(0.05);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * r.f * (i / SR)) * expEnv(i, r.tau);
  const n = noise(rand, x.length);
  highpass(n, 1200);
  for (let i = 0; i < n.length; i++) n[i] *= expEnv(i, r.tau * 0.6);
  addInto(x, n, 0.5);
  return finish(x, p.fin, rand);
}
function renderHat(p, seed, open) {
  const rand = mulberry32(seed);
  const h = open ? p.oh : p.hh;
  const x = noise(rand, secs(h.tau * 4 + 0.02));
  highpass(x, h.hp);
  for (let i = 0; i < x.length; i++) x[i] *= expEnv(i, h.tau);
  return finish(x, p.fin, rand);
}
function renderTom(p, seed, idx) {
  const rand = mulberry32(seed);
  const tm = p.toms;
  const freq = tm.freqs[idx], tau = tm.tau;
  const x = buf(tau + 0.05);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const f = freq * (1 + 0.6 * Math.exp(-t / 0.04));
    x[i] = Math.sin(2 * Math.PI * f * t) * expEnv(i, tau);
  }
  if (tm.lp) lowpass(x, tm.lp);
  return finish(x, p.fin, rand);
}
function renderRide(p, seed) {
  const rand = mulberry32(seed);
  const rd = p.ride;
  const x = buf(rd.tau + 0.05);
  const ratios = [1, 1.34, 1.79, 2.41, 3.07, 3.83];
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    let s = 0;
    for (let kk = 0; kk < ratios.length; kk++) s += Math.sin(2 * Math.PI * rd.base * ratios[kk] * t);
    x[i] = (s / ratios.length) * expEnv(i, rd.tau);
  }
  highpass(x, rd.hp);
  return finish(x, p.fin, rand);
}
function renderCrash(p, seed) {
  const rand = mulberry32(seed);
  const cr = p.crash;
  const x = noise(rand, secs(cr.tau + 0.05));
  highpass(x, cr.hp);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] *= expEnv(i, cr.tau) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 7 * t));
  }
  return finish(x, p.fin, rand);
}

// Voice id → renderer. Sample names follow Strudel's drum-machine convention
// (bd/sd/rim/hh/oh/lt/mt/ht/rd/cr) so packs line up across engines.
const VOICE_RENDERERS = {
  bd:  (p, s) => renderKick(p, s),
  sd:  (p, s) => renderSnare(p, s),
  rim: (p, s) => renderRim(p, s),
  hh:  (p, s) => renderHat(p, s, false),
  oh:  (p, s) => renderHat(p, s, true),
  lt:  (p, s) => renderTom(p, s, 0),
  mt:  (p, s) => renderTom(p, s, 1),
  ht:  (p, s) => renderTom(p, s, 2),
  rd:  (p, s) => renderRide(p, s),
  cr:  (p, s) => renderCrash(p, s),
};

// ── Base profile + per-genre overrides ───────────────────────────────────
// A profile is a deep-mergeable description of the kit's character. Edit a
// genre's overrides to retune it; everything else inherits from BASE.
const BASE = {
  fin:   { drive: 1.3, srr: SR, bits: 16, hiss: 0 },
  kick:  { f0: 120, f1: 48, pdecay: 0.022, tau: 0.30, click: 0.2, clickLp: 3000, lp: 1500 },
  snare: { bodyF: 190, bodyMix: 0.6, bodyTau: 0.09, noiseHp: 1500, noiseLp: 7000, noiseTau: 0.12, noiseMix: 0.8 },
  rim:   { f: 1700, tau: 0.012 },
  hh:    { hp: 7000, tau: 0.028 },
  oh:    { hp: 6500, tau: 0.16 },
  toms:  { freqs: [90, 130, 180], tau: 0.28, lp: 2400 },
  ride:  { base: 520, tau: 0.30, hp: 3000 },
  crash: { hp: 3000, tau: 0.55 },
};
function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]))
      ? merge(base[k] || {}, over[k]) : over[k];
  }
  return out;
}
const profile = (over) => merge(BASE, over);

// Each genre: an `id` (folder + Strudel bank prefix) and a tuned profile.
const GENRES = [
  // Clean, punchy 808/909 — the canonical voidstar default, mirrored as samples.
  { id: 'voidstar', profile: profile({
    fin: { drive: 1.2, bits: 16 },
  }) },
  // Warm, dusty boom-bap — heavy crush, rolled-off, hiss.
  { id: 'lofi', profile: profile({
    fin:   { drive: 1.6, srr: 11000, bits: 11, hiss: 0.015 },
    kick:  { f0: 110, pdecay: 0.026, tau: 0.32, lp: 1300 },
    snare: { bodyF: 180, noiseLp: 6000 },
    hh:    { hp: 6800, tau: 0.03 }, oh: { hp: 6200, tau: 0.18 },
    crash: { tau: 0.7 },
  }) },
  // Cassette — saturated, mellow, highs rolled hard, light wow-ish grit.
  { id: 'tape', profile: profile({
    fin:   { drive: 2.1, srr: 13000, bits: 12, hiss: 0.02 },
    kick:  { f0: 105, tau: 0.34, lp: 1100 },
    snare: { bodyMix: 0.7, noiseLp: 5200, noiseMix: 0.7 },
    hh:    { hp: 6000 }, oh: { hp: 5600, tau: 0.2 },
    toms:  { lp: 1900 }, ride: { hp: 2600 }, crash: { hp: 2600, tau: 0.75 },
  }) },
  // Dubstep — deep sub kick, huge long snare, wide bright crashes.
  { id: 'dub', profile: profile({
    fin:   { drive: 1.5, bits: 14 },
    kick:  { f0: 150, f1: 38, pdecay: 0.04, tau: 0.5, click: 0.3, lp: 1700 },
    snare: { bodyF: 170, bodyTau: 0.14, noiseTau: 0.28, noiseLp: 9000, noiseMix: 0.9 },
    hh:    { hp: 8000, tau: 0.03 }, oh: { hp: 7500, tau: 0.3 },
    toms:  { freqs: [70, 110, 150], tau: 0.4 },
    ride:  { tau: 0.5 }, crash: { hp: 2400, tau: 1.0 },
  }) },
  // Modern jazz — soft, brushed, ride-forward, natural decays, no crush.
  { id: 'jazz', profile: profile({
    fin:   { drive: 1.05, bits: 16 },
    kick:  { f0: 95, f1: 55, tau: 0.22, click: 0.1, lp: 1800 },
    snare: { bodyF: 200, bodyMix: 0.35, noiseHp: 1800, noiseLp: 8500, noiseTau: 0.16, noiseMix: 0.95 },
    hh:    { hp: 8500, tau: 0.04 }, oh: { hp: 8000, tau: 0.22 },
    toms:  { freqs: [110, 150, 200], tau: 0.32, lp: 3200 },
    ride:  { base: 600, tau: 0.6, hp: 3500 }, crash: { hp: 3500, tau: 0.6 },
  }) },
  // Metal (Pantera/Metallica/Gojira) — clicky beater kick, cracking snare, tight.
  { id: 'metal', profile: profile({
    fin:   { drive: 1.6, bits: 16 },
    kick:  { f0: 180, f1: 50, pdecay: 0.012, tau: 0.18, click: 0.55, clickLp: 6000, lp: 3500 },
    snare: { bodyF: 240, bodyTau: 0.06, noiseHp: 2200, noiseLp: 9000, noiseTau: 0.1, noiseMix: 1.0 },
    hh:    { hp: 8000, tau: 0.025 }, oh: { hp: 7500, tau: 0.2 },
    toms:  { freqs: [100, 145, 200], tau: 0.22, lp: 3000 },
    ride:  { base: 560, tau: 0.4 }, crash: { hp: 3200, tau: 0.9 },
  }) },
  // Death metal (Suffocation/Devourment) — ultra-tight triggered kick, pingy snare.
  { id: 'death', profile: profile({
    fin:   { drive: 1.9, bits: 16 },
    kick:  { f0: 220, f1: 55, pdecay: 0.008, tau: 0.12, click: 0.75, clickLp: 7000, lp: 4500 },
    snare: { bodyF: 320, bodyMix: 0.4, bodyTau: 0.04, noiseHp: 3500, noiseLp: 10000, noiseTau: 0.06, noiseMix: 1.0 },
    rim:   { f: 2200, tau: 0.008 },
    hh:    { hp: 9000, tau: 0.02 }, oh: { hp: 8500, tau: 0.16 },
    toms:  { freqs: [120, 165, 220], tau: 0.18, lp: 3400 },
    ride:  { base: 620, tau: 0.35 }, crash: { hp: 3600, tau: 0.85 },
  }) },
  // Hiphop (Dilla) — dusty thick kick, vinyl snare, soft hats, warm crush.
  { id: 'hiphop', profile: profile({
    fin:   { drive: 1.7, srr: 12000, bits: 11, hiss: 0.012 },
    kick:  { f0: 115, f1: 45, pdecay: 0.03, tau: 0.34, click: 0.25, lp: 1400 },
    snare: { bodyF: 175, bodyMix: 0.65, noiseHp: 1300, noiseLp: 6500, noiseTau: 0.14, noiseMix: 0.85 },
    hh:    { hp: 6500, tau: 0.035 }, oh: { hp: 6000, tau: 0.2 },
    toms:  { lp: 2000 }, ride: { hp: 2800 }, crash: { hp: 2700, tau: 0.7 },
  }) },
];

// ── WAV writer — 16-bit PCM mono ────────────────────────────────────────
function encodeWav(samples, sampleRate = SR) {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2);
  }
  return b;
}

// ── Render every genre ───────────────────────────────────────────────────
let grand = 0;
// Stable per-voice seed offsets so noise textures stay distinct but reproducible.
const VOICE_SEED = { bd: 1, sd: 2, rim: 3, hh: 4, oh: 5, lt: 6, mt: 7, ht: 8, rd: 9, cr: 10 };
// Per-voice loudness balance (dB), applied AFTER each one-shot is peak-normalised.
// Equal-peak one-shots make bright cymbals read far louder/harsher than the kick;
// the synth kits trim each cymbal individually, so we bake the same balance into
// the samples (see scripts/gen-samples.mjs for the rationale).
const VOICE_TRIM_DB = {
  bd: 0, lt: -1, mt: -1, ht: -1, sd: -3, rim: -8, hh: -10, oh: -10, rd: -13, cr: -15,
};
const dbToLin = (db) => 10 ** (db / 20);
for (const genre of GENRES) {
  const dir = join(SAMPLES_ROOT, genre.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const manifest = { _base: `/samples/${COLLECTION}/${genre.id}/` };
  let total = 0;
  const base = 1000 + GENRES.indexOf(genre) * 100;
  for (const [name, render] of Object.entries(VOICE_RENDERERS)) {
    const rendered = render(genre.profile, base + VOICE_SEED[name]);
    gain(rendered, dbToLin(VOICE_TRIM_DB[name] ?? 0));   // per-voice loudness balance
    const wav = encodeWav(rendered);
    writeFileSync(join(dir, `${name}.wav`), wav);
    manifest[name] = [`${name}.wav`];
    total += wav.length;
  }
  writeFileSync(join(dir, 'strudel.json'), JSON.stringify(manifest, null, 2) + '\n');
  grand += total;
  console.log(`  ${genre.id.padEnd(9)} ${Object.keys(VOICE_RENDERERS).length} voices  ${(total / 1024).toFixed(0)} KB`);
}
console.log(`\nWrote ${GENRES.length} packs (${(grand / 1024).toFixed(0)} KB total) under ${SAMPLES_ROOT}`);
