// Signature sample-pack generator — dependency-free, CC0-clean, deterministic.
//
// Renders one original one-shot drum pack per genre (voidstar / lofi / tape /
// dub / jazz / metal / death / hiphop) directly into each Strudel-format
// `public/samples/signature/<genre>/strudel.json`. The manifest entries are
// data:audio/wav URLs, so the sequencer and Strudel share the exact same offline
// samples without needing a binary-file write step. Pass `--wavs` to also emit
// loose WAV files for auditioning / external editing.
//
// `signature` is one of two bundled collections (see docs/samples.md): the
// characterful default, alongside the original `voidstar_0` baseline
// (scripts/gen-samples-voidstar0.mjs). Both ship the same bd/sd/rim/hh/oh/lt/mt/
// ht/rd/cr voice contract so a groove A/Bs cleanly between them.
//
// Every sound is pure synthesis from the code below: no recordings, no external
// packs, no licensing ambiguity. Treat the rendered one-shots as CC0/project-local
// source material; edit a profile or renderer, run `npm run gen:samples`, and
// commit the regenerated manifests.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLLECTION = 'signature';
const SAMPLES_ROOT = join(__dirname, '..', 'public', 'samples', COLLECTION);
const SR = 22050;
const WRITE_WAVS = process.argv.includes('--wavs') || process.argv.includes('--files');

// ── Deterministic DSP helpers ───────────────────────────────────────────────
const TAU = Math.PI * 2;
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const secs = (s) => Math.max(1, Math.round(s * SR));
const make = (s) => new Float32Array(secs(s));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function white(rand, n) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  return x;
}

function add(dst, src, g = 1, off = 0) {
  const start = Math.max(0, off | 0);
  const n = Math.min(src.length, dst.length - start);
  for (let i = 0; i < n; i++) dst[start + i] += src[i] * g;
  return dst;
}
function scale(x, g) { for (let i = 0; i < x.length; i++) x[i] *= g; return x; }
function envExp(t, tau) { return Math.exp(-t / Math.max(0.001, tau)); }

function onePoleLP(x, cutoff) {
  if (!cutoff || cutoff >= SR / 2) return x;
  const dt = 1 / SR, rc = 1 / (TAU * cutoff), a = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; }
  return x;
}
function onePoleHP(x, cutoff) {
  if (!cutoff || cutoff <= 0) return x;
  const dt = 1 / SR, rc = 1 / (TAU * cutoff), a = rc / (rc + dt);
  let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) {
    const y = a * (py + x[i] - px);
    px = x[i]; py = y; x[i] = y;
  }
  return x;
}
function bandpassNoise(rand, len, hp, lp) {
  const x = white(rand, len);
  onePoleHP(x, hp); onePoleLP(x, lp);
  return x;
}
function sampleHold(x, targetHz) {
  if (!targetHz || targetHz >= SR) return x;
  const step = Math.max(1, Math.round(SR / targetHz));
  let held = 0;
  for (let i = 0; i < x.length; i++) { if (i % step === 0) held = x[i]; x[i] = held; }
  return x;
}
function bitcrush(x, bits) {
  if (!bits || bits >= 16) return x;
  const levels = 2 ** bits;
  for (let i = 0; i < x.length; i++) x[i] = Math.round(x[i] * levels) / levels;
  return x;
}
function saturate(x, drive = 1) {
  const d = Math.max(0.1, drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * d) / Math.tanh(d);
  return x;
}
function fadeInOut(x, inMs = 0.8, outMs = 8) {
  const ni = Math.min(x.length, secs(inMs / 1000));
  for (let i = 0; i < ni; i++) x[i] *= i / Math.max(1, ni);
  const no = Math.min(x.length, secs(outMs / 1000));
  for (let i = 0; i < no; i++) x[x.length - 1 - i] *= i / Math.max(1, no);
  return x;
}
function normalize(x, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 1e-8) scale(x, peak / m);
  return x;
}
function finish(x, p, rand) {
  const f = p.fin || {};
  if (f.hp) onePoleHP(x, f.hp);
  if (f.lp) onePoleLP(x, f.lp);
  saturate(x, f.drive || 1.15);
  sampleHold(x, f.srr || SR);
  bitcrush(x, f.bits || 16);
  if (f.hiss) {
    const h = bandpassNoise(rand, x.length, 1800, f.hissLp || 9000);
    for (let i = 0; i < h.length; i++) h[i] *= envExp(i / SR, Math.max(0.15, x.length / SR));
    add(x, h, f.hiss);
  }
  fadeInOut(x, 0.6, f.fadeMs || 8);
  return normalize(x, f.peak || 0.9);
}
function sineSweep(dst, { f0, f1, bend = 0.03, tau = 0.2, amp = 1, phase = 0, start = 0 }) {
  let ph = phase;
  for (let i = start; i < dst.length; i++) {
    const t = (i - start) / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t / bend);
    ph += TAU * f / SR;
    dst[i] += Math.sin(ph) * envExp(t, tau) * amp;
  }
}
function modal(dst, modes, amp = 1) {
  for (const m of modes || []) {
    const [freq, tau, gain = 1, phase = 0] = m;
    let ph = phase;
    for (let i = 0; i < dst.length; i++) {
      const t = i / SR;
      ph += TAU * freq / SR;
      dst[i] += Math.sin(ph) * envExp(t, tau) * gain * amp;
    }
  }
}
function sprinkleClicks(dst, rand, count, durMs, hp, gain) {
  for (let c = 0; c < count; c++) {
    const off = Math.round((rand() ** 1.7) * Math.max(1, dst.length - secs(durMs / 1000)));
    const n = secs((durMs * (0.5 + rand())) / 1000);
    const click = bandpassNoise(rand, n, hp, SR / 2 - 500);
    for (let i = 0; i < click.length; i++) click[i] *= envExp(i / SR, durMs / 5000);
    add(dst, click, gain * (0.4 + rand() * 0.8), off);
  }
}
// Dense inharmonic "metal" cluster — the backbone of a believable cymbal/hat.
// A real cymbal is a thicket of mutually-inharmonic partials, not 3 clean sines
// or flat white noise (which is what reads as "synthetic"). This sums many
// partials at stretched, TR-style inharmonic ratios with seeded micro-detune
// (→ shimmer/beating) plus a few odd harmonics each for metallic bite. Per-mode
// decays shorten up the spectrum so the top sparkles off first, like real metal.
const METAL_RATIOS = [1, 1.418, 1.882, 2.314, 2.91, 3.74, 4.61, 5.40, 6.35, 7.62, 8.91, 10.4];
function metalCluster(dst, rand, { f0, count = 10, tau = 0.3, gain = 1, stretch = 1, odd = 2 }) {
  for (let m = 0; m < count; m++) {
    const ratio = METAL_RATIOS[m % METAL_RATIOS.length] * (m >= METAL_RATIOS.length ? 1.5 : 1);
    const f = f0 * ratio ** stretch * (1 + (rand() - 0.5) * 0.013);   // micro-detune → beating
    if (f >= SR / 2 - 200) continue;
    const g = gain * (0.9 / (1 + m * 0.33));
    const mtau = Math.max(0.01, tau * (1 - m * 0.045));
    let ph = rand() * TAU;
    for (let i = 0; i < dst.length; i++) {
      ph += TAU * f / SR;
      let s = Math.sin(ph);
      for (let h = 3; h <= odd * 2 + 1; h += 2) s += Math.sin(ph * h) / h;   // odd harmonics = square-ish bite
      dst[i] += s * Math.exp(-i / SR / mtau) * g;
    }
  }
  return dst;
}

// ── Voice renderers ─────────────────────────────────────────────────────────
function renderKick(p, seed) {
  const rand = mulberry32(seed);
  const k = p.kick;
  const x = make(k.dur || (k.tau + 0.13));
  sineSweep(x, { f0: k.f0, f1: k.f1, bend: k.bend, tau: k.tau, amp: k.amp || 1 });
  if (k.sub) sineSweep(x, { f0: k.f1 * 1.02, f1: k.f1 * 0.98, bend: k.tau, tau: k.tau * 1.7, amp: k.sub });
  if (k.knock) modal(x, [[k.knockF || 160, k.knockTau || 0.055, 1]], k.knock);
  if (k.click) {
    const n = bandpassNoise(rand, secs(k.clickDur || 0.009), k.clickHp || 1200, k.clickLp || 8000);
    for (let i = 0; i < n.length; i++) n[i] *= envExp(i / SR, k.clickTau || 0.004);
    add(x, n, k.click);
  }
  return finish(x, p, rand);
}
function renderSnare(p, seed) {
  const rand = mulberry32(seed);
  const s = p.snare;
  const x = make(s.dur || Math.max(s.bodyTau || 0.08, s.noiseTau || 0.13) * 3.8);
  modal(x, s.modes || [[s.bodyF || 190, s.bodyTau || 0.08, 1], [(s.bodyF || 190) * 1.52, (s.bodyTau || 0.08) * 0.65, 0.55]], s.body || 0.45);
  const n = bandpassNoise(rand, x.length, s.noiseHp || 1200, s.noiseLp || 9000);
  for (let i = 0; i < n.length; i++) {
    const t = i / SR;
    n[i] *= envExp(t, s.noiseTau || 0.12) * (1 + (s.rattle || 0) * Math.sin(TAU * (80 + 20 * rand()) * t));
  }
  add(x, n, s.noise || 0.8);
  for (let c = 1; c <= (s.claps || 0); c++) {
    const d = secs((0.012 + 0.008 * c) * (0.7 + rand() * 0.6));
    add(x, n, (s.clapGain || 0.25) / c, d);
  }
  if (s.brush) sprinkleClicks(x, rand, s.brush, 18, 2000, 0.08);
  return finish(x, p, rand);
}
function renderRim(p, seed) {
  const rand = mulberry32(seed);
  const r = p.rim;
  const x = make(r.dur || 0.07);
  modal(x, r.modes || [[r.f || 1700, r.tau || 0.014, 1], [(r.f || 1700) * 1.63, (r.tau || 0.014) * 0.7, 0.35]], r.amp || 0.75);
  const n = bandpassNoise(rand, x.length, r.hp || 1100, r.lp || 9000);
  for (let i = 0; i < n.length; i++) n[i] *= envExp(i / SR, r.noiseTau || 0.01);
  add(x, n, r.noise || 0.35);
  return finish(x, p, rand);
}
function renderHat(p, seed, open) {
  const rand = mulberry32(seed);
  const h = open ? p.oh : p.hh;
  const x = make(h.dur || ((open ? 0.32 : 0.07)));
  const tau = h.tau || (open ? 0.16 : 0.035);
  // Metallic core: dense inharmonic cluster keyed off the hat's brightness — the
  // part that makes it read as a real hat rather than a noise burst.
  metalCluster(x, rand, { f0: (h.hp || 6000) * 0.5, count: 12, tau, gain: (h.metal ?? 0.22) * 1.7, stretch: 1.0, odd: 3 });
  // Shaped noise for air/sizzle — present but no longer the whole sound.
  const n = bandpassNoise(rand, x.length, h.hp || 6000, h.lp || (SR / 2 - 500));
  for (let i = 0; i < n.length; i++) n[i] *= envExp(i / SR, tau * 0.85);
  add(x, n, (h.noise || 0.9) * 0.5);
  if (h.chick) {
    const c = bandpassNoise(rand, secs(0.012), 2200, 8500);
    for (let i = 0; i < c.length; i++) c[i] *= envExp(i / SR, 0.003);
    add(x, c, h.chick);
  }
  return finish(x, p, rand);
}
function renderTom(p, seed, idx) {
  const rand = mulberry32(seed);
  const t = p.toms;
  const f = t.freqs[idx];
  const x = make(t.dur || (t.tau + 0.13));
  sineSweep(x, { f0: f * (t.drop || 1.65), f1: f, bend: t.bend || 0.05, tau: t.tau || 0.25, amp: t.amp || 0.9 });
  modal(x, [[f * 1.5, (t.tau || 0.25) * 0.7, 0.22], [f * 2.02, (t.tau || 0.25) * 0.45, 0.12]], 1);
  if (t.hit) add(x, bandpassNoise(rand, secs(0.012), 900, 6000), t.hit);
  return finish(x, p, rand);
}
function renderRide(p, seed) {
  const rand = mulberry32(seed);
  const r = p.ride;
  const x = make(r.dur || 0.48);
  // Dense stick "ping": inharmonic cluster off the ride's fundamental.
  metalCluster(x, rand, { f0: r.base || 520, count: 12, tau: r.tau || 0.35, gain: r.ping || 0.55, stretch: 1.0, odd: 2 });
  // Bright contact chiff so the stick attack is audible (ride is attack-forward).
  const tick = bandpassNoise(rand, secs(0.01), 3000, SR / 2 - 500);
  for (let i = 0; i < tick.length; i++) tick[i] *= envExp(i / SR, 0.0035);
  add(x, tick, (r.ping || 0.55) * 0.5);
  // Sustained wash underneath — shaped and pulled back so the ping leads.
  const wash = bandpassNoise(rand, x.length, r.hp || 2600, r.lp || (SR / 2 - 400));
  for (let i = 0; i < wash.length; i++) wash[i] *= envExp(i / SR, r.washTau || 0.28);
  add(x, wash, (r.wash || 0.35) * 0.7);
  return finish(x, p, rand);
}
function renderCrash(p, seed) {
  const rand = mulberry32(seed);
  const c = p.crash;
  const x = make(c.dur || 0.8);
  // Metallic body: a broad, dense, slightly-stretched cluster with a long tail.
  metalCluster(x, rand, { f0: (c.hp || 2300) * 0.42, count: 14, tau: c.tau || 0.55, gain: (c.metal || 0.35) * 1.5, stretch: 1.02, odd: 3 });
  // Noise wash with a fast splash build, then decay + slow shimmer for movement.
  const wash = bandpassNoise(rand, x.length, c.hp || 2300, c.lp || (SR / 2 - 300));
  for (let i = 0; i < wash.length; i++) {
    const t = i / SR;
    const build = Math.min(1, t / 0.006);
    wash[i] *= build * envExp(t, c.tau || 0.55) * (0.85 + 0.15 * Math.sin(TAU * (5.5 + (c.wobble || 0)) * t));
  }
  add(x, wash, (c.wash || 1) * 0.8);
  return finish(x, p, rand);
}

const VOICES = {
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
const VOICE_SEED = { bd: 1, sd: 2, rim: 3, hh: 4, oh: 5, lt: 6, mt: 7, ht: 8, rd: 9, cr: 10 };

// Per-voice loudness balance (dB), applied AFTER each one-shot is peak-normalised.
// Without this every voice sits at the same ~-1 dB peak, but a bright, sustained
// cymbal carries ~10-40× the kick's high-frequency energy at that peak, so it
// reads far louder and harsher to the ear — and ~15 dB hotter than the SYNTH
// kits, which trim each cymbal individually (crash -14..-21, ride -10..-18, hats
// -9..-17 vs the kick). Bake the same balance into the samples so both the
// sequencer and Strudel's .bank() playback (both apply one flat kit gain) sit
// right. Kick + toms anchor at 0 dB; cymbals come down hardest.
const VOICE_TRIM_DB = {
  bd: 0, lt: -1, mt: -1, ht: -1, sd: -3, rim: -8, hh: -10, oh: -10, rd: -13, cr: -15,
};
const dbToLin = (db) => 10 ** (db / 20);

// ── Genre profiles — characterful, not placeholder-neutral ─────────────────
const BASE = {
  fin:   { drive: 1.18, srr: SR, bits: 16, peak: 0.9, hp: 18, fadeMs: 10 },
  kick:  { f0: 122, f1: 48, bend: 0.026, tau: 0.28, sub: 0.18, click: 0.18, clickHp: 1100, clickLp: 5200, clickTau: 0.0035, knock: 0.08, knockF: 155 },
  snare: { body: 0.45, bodyF: 190, bodyTau: 0.08, noise: 0.78, noiseHp: 1400, noiseLp: 7800, noiseTau: 0.13, rattle: 0.12 },
  rim:   { f: 1700, tau: 0.014, noise: 0.35, hp: 1200, lp: 9000 },
  hh:    { hp: 6500, lp: 10400, tau: 0.032, dur: 0.07, noise: 0.85, metal: 0.25, chick: 0.14 },
  oh:    { hp: 6100, lp: 10400, tau: 0.16, dur: 0.30, noise: 0.9, metal: 0.2, chick: 0.08 },
  toms:  { freqs: [88, 128, 178], tau: 0.26, dur: 0.34, hit: 0.10, drop: 1.55 },
  ride:  { base: 520, tau: 0.38, dur: 0.48, hp: 2600, lp: 10400, ping: 0.58, wash: 0.32, washTau: 0.28 },
  crash: { hp: 2600, lp: 10400, tau: 0.55, dur: 0.78, wash: 0.95, metal: 0.32 },
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

const GENRES = [
  {
    id: 'voidstar', note: 'neon-clean 808/909 with glassy cymbals', profile: profile({
      fin: { drive: 1.14, bits: 16, peak: 0.88, lp: 10000 },
      kick: { f0: 134, f1: 46, bend: 0.024, tau: 0.31, sub: 0.22, click: 0.22, knock: 0.1 },
      snare: { bodyF: 205, noiseLp: 8600, noiseTau: 0.12, claps: 1, clapGain: 0.16 },
      ride: { base: 590, ping: 0.68, wash: 0.24 },
      crash: { dur: 0.72, tau: 0.48, hp: 3000 },
    }),
  },
  {
    id: 'lofi', note: 'warm boom-bap, velvet hats, sampler dust', profile: profile({
      fin: { drive: 1.85, srr: 11200, bits: 11, hiss: 0.012, hissLp: 5600, lp: 4300, peak: 0.86, fadeMs: 12 },
      kick: { f0: 108, f1: 43, bend: 0.034, tau: 0.36, sub: 0.28, click: 0.11, knock: 0.18, knockF: 132 },
      snare: { bodyF: 175, body: 0.62, bodyTau: 0.10, noiseHp: 1050, noiseLp: 5200, noiseTau: 0.16, noise: 0.72, claps: 2, clapGain: 0.18 },
      rim: { f: 1350, tau: 0.018, lp: 5000 },
      hh: { hp: 5000, lp: 6500, tau: 0.038, metal: 0.12, chick: 0.05 },
      oh: { hp: 4700, lp: 6400, tau: 0.20, dur: 0.34, metal: 0.1 },
      toms: { freqs: [78, 115, 155], tau: 0.30, hit: 0.05 },
      ride: { base: 430, hp: 2100, lp: 5600, ping: 0.38, wash: 0.36 },
      crash: { hp: 2100, lp: 5600, tau: 0.60, dur: 0.74, metal: 0.16 },
    }),
  },
  {
    id: 'tape', note: 'cassette-smeared, rounded transients, hissy tails', profile: profile({
      fin: { drive: 2.15, srr: 13500, bits: 12, hiss: 0.018, hissLp: 5200, lp: 3600, peak: 0.84, fadeMs: 18 },
      kick: { f0: 100, f1: 45, bend: 0.04, tau: 0.37, sub: 0.24, click: 0.07, knock: 0.14, knockF: 120 },
      snare: { bodyF: 168, body: 0.66, noiseHp: 950, noiseLp: 4700, noiseTau: 0.18, noise: 0.68, rattle: 0.2, claps: 1 },
      rim: { f: 1180, tau: 0.02, noise: 0.25, lp: 4200 },
      hh: { hp: 4500, lp: 5600, tau: 0.042, metal: 0.08, chick: 0.04 },
      oh: { hp: 4300, lp: 5500, tau: 0.24, dur: 0.38, metal: 0.08 },
      toms: { freqs: [73, 108, 150], tau: 0.34, drop: 1.38, hit: 0.04 },
      ride: { base: 410, hp: 1900, lp: 5200, ping: 0.32, wash: 0.38, dur: 0.54 },
      crash: { hp: 1800, lp: 5100, tau: 0.68, dur: 0.82, metal: 0.12 },
    }),
  },
  {
    id: 'dub', note: 'halftime sub-kick, cavern snare, wide smoky metal', profile: profile({
      fin: { drive: 1.45, bits: 14, lp: 9200, peak: 0.9, fadeMs: 16 },
      kick: { f0: 152, f1: 34, bend: 0.055, tau: 0.54, dur: 0.62, sub: 0.42, click: 0.26, clickHp: 900, clickLp: 4800, knock: 0.13, knockF: 96 },
      snare: { bodyF: 160, body: 0.62, bodyTau: 0.15, noiseHp: 1500, noiseLp: 9200, noiseTau: 0.28, noise: 0.9, rattle: 0.08, claps: 3, clapGain: 0.25 },
      rim: { f: 1600, tau: 0.018, noise: 0.45 },
      hh: { hp: 7200, tau: 0.03, metal: 0.3 },
      oh: { hp: 6600, tau: 0.26, dur: 0.43, metal: 0.28 },
      toms: { freqs: [62, 94, 134], tau: 0.40, dur: 0.48, drop: 1.8, hit: 0.08 },
      ride: { base: 470, tau: 0.46, dur: 0.58, hp: 2400, ping: 0.5, wash: 0.45 },
      crash: { hp: 2100, tau: 0.82, dur: 0.95, wash: 1, metal: 0.38 },
    }),
  },
  {
    id: 'jazz', note: 'brushed snare, woody toms, ride-forward cymbal kit', profile: profile({
      fin: { drive: 1.03, bits: 16, lp: 10500, peak: 0.84, fadeMs: 14 },
      kick: { f0: 88, f1: 54, bend: 0.032, tau: 0.22, dur: 0.30, sub: 0.08, click: 0.06, knock: 0.05 },
      snare: { bodyF: 215, body: 0.28, bodyTau: 0.07, noiseHp: 1600, noiseLp: 8800, noiseTau: 0.20, noise: 0.92, rattle: 0.35, brush: 18 },
      rim: { f: 1420, tau: 0.016, noise: 0.25, modes: [[1250, 0.015, 1], [2050, 0.012, 0.42]] },
      hh: { hp: 7600, tau: 0.045, dur: 0.085, noise: 0.76, metal: 0.34, chick: 0.22 },
      oh: { hp: 7200, tau: 0.22, dur: 0.36, noise: 0.78, metal: 0.3 },
      toms: { freqs: [102, 145, 205], tau: 0.33, dur: 0.42, hit: 0.06, drop: 1.32 },
      ride: { base: 640, tau: 0.58, dur: 0.68, hp: 3100, ping: 0.82, wash: 0.28, washTau: 0.44 },
      crash: { hp: 3100, tau: 0.50, dur: 0.65, wash: 0.72, metal: 0.25 },
    }),
  },
  {
    id: 'metal', note: 'clicky double-kick, cracking snare, tight bright cymbals', profile: profile({
      fin: { drive: 1.55, bits: 16, lp: 10500, peak: 0.9, fadeMs: 8 },
      kick: { f0: 185, f1: 49, bend: 0.012, tau: 0.17, dur: 0.24, sub: 0.16, click: 0.68, clickHp: 2200, clickLp: 9200, clickTau: 0.0025, knock: 0.18, knockF: 102 },
      snare: { modes: [[235, 0.055, 0.8], [515, 0.04, 0.28]], body: 0.58, noiseHp: 2300, noiseLp: 10000, noiseTau: 0.10, noise: 0.96, claps: 1, clapGain: 0.12 },
      rim: { f: 2050, tau: 0.009, noise: 0.5, hp: 1800 },
      hh: { hp: 8000, tau: 0.024, dur: 0.052, metal: 0.38, chick: 0.2 },
      oh: { hp: 7600, tau: 0.16, dur: 0.29, metal: 0.36 },
      toms: { freqs: [96, 142, 205], tau: 0.22, dur: 0.30, hit: 0.18, drop: 1.46 },
      ride: { base: 580, tau: 0.34, dur: 0.42, hp: 3000, ping: 0.7, wash: 0.26 },
      crash: { hp: 3000, tau: 0.72, dur: 0.84, wash: 0.95, metal: 0.42 },
    }),
  },
  {
    id: 'death', note: 'ultra-tight triggered attack, ping snare, surgical cymbals', profile: profile({
      fin: { drive: 1.82, bits: 16, lp: 10800, peak: 0.9, fadeMs: 6 },
      kick: { f0: 225, f1: 55, bend: 0.007, tau: 0.105, dur: 0.18, sub: 0.1, click: 0.95, clickHp: 3000, clickLp: 10300, clickTau: 0.002, knock: 0.14, knockF: 118 },
      snare: { modes: [[335, 0.035, 0.62], [1180, 0.035, 0.32], [2200, 0.018, 0.18]], body: 0.62, noiseHp: 3400, noiseLp: 10500, noiseTau: 0.062, noise: 1, rattle: 0.05 },
      rim: { f: 2500, tau: 0.007, noise: 0.55, hp: 2200, dur: 0.045 },
      hh: { hp: 8800, tau: 0.018, dur: 0.042, metal: 0.42, chick: 0.24 },
      oh: { hp: 8300, tau: 0.115, dur: 0.22, metal: 0.4 },
      toms: { freqs: [116, 165, 226], tau: 0.17, dur: 0.24, hit: 0.23, drop: 1.38 },
      ride: { base: 690, tau: 0.28, dur: 0.35, hp: 3500, ping: 0.82, wash: 0.18 },
      crash: { hp: 3600, tau: 0.55, dur: 0.68, wash: 0.9, metal: 0.48 },
    }),
  },
  {
    id: 'hiphop', note: 'Dilla-dusty SP-style kit with thick lows and vinyl snap', profile: profile({
      fin: { drive: 1.75, srr: 11800, bits: 11, hiss: 0.014, hissLp: 6200, lp: 5200, peak: 0.87, fadeMs: 12 },
      kick: { f0: 118, f1: 42, bend: 0.032, tau: 0.40, dur: 0.48, sub: 0.32, click: 0.18, clickHp: 700, clickLp: 3800, knock: 0.26, knockF: 130 },
      snare: { bodyF: 178, body: 0.7, bodyTau: 0.11, noiseHp: 1200, noiseLp: 6000, noiseTau: 0.15, noise: 0.82, rattle: 0.22, claps: 2, clapGain: 0.22 },
      rim: { f: 1320, tau: 0.017, noise: 0.36, lp: 5800 },
      hh: { hp: 5600, lp: 7200, tau: 0.035, dur: 0.075, metal: 0.16, chick: 0.08 },
      oh: { hp: 5200, lp: 7000, tau: 0.21, dur: 0.36, metal: 0.14 },
      toms: { freqs: [80, 118, 160], tau: 0.31, dur: 0.40, hit: 0.06, drop: 1.5 },
      ride: { base: 450, hp: 2300, lp: 6200, ping: 0.42, wash: 0.35, dur: 0.50 },
      crash: { hp: 2300, lp: 6200, tau: 0.66, dur: 0.78, metal: 0.18 },
    }),
  },
];

// ── WAV writer — 16-bit PCM mono ────────────────────────────────────────────
function encodeWav(samples, sampleRate = SR) {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = clamp(samples[i]);
    b.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2);
  }
  return b;
}
function dataUrl(wav) { return `data:audio/wav;base64,${wav.toString('base64')}`; }

// ── Render every genre ──────────────────────────────────────────────────────
let grandAudio = 0, grandJson = 0;
for (let gi = 0; gi < GENRES.length; gi++) {
  const genre = GENRES[gi];
  const dir = join(SAMPLES_ROOT, genre.id);
  mkdirSync(dir, { recursive: true });
  const manifest = {};
  let audioBytes = 0;
  const base = 1000 + gi * 100;
  for (const [name, render] of Object.entries(VOICES)) {
    const rendered = render(genre.profile, base + VOICE_SEED[name]);
    scale(rendered, dbToLin(VOICE_TRIM_DB[name] ?? 0));   // per-voice loudness balance
    const wav = encodeWav(rendered);
    audioBytes += wav.length;
    manifest[name] = [dataUrl(wav)];
    if (WRITE_WAVS) writeFileSync(join(dir, `${name}.wav`), wav);
  }
  const json = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(dir, 'strudel.json'), json);
  grandAudio += audioBytes;
  grandJson += Buffer.byteLength(json);
  console.log(`  ${genre.id.padEnd(9)} ${Object.keys(VOICES).length} one-shots  ${(audioBytes / 1024).toFixed(0)} KB wav / ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB manifest  — ${genre.note}`);
}
console.log(`\nWrote ${GENRES.length} embedded Strudel packs (${(grandAudio / 1024).toFixed(0)} KB WAV payload, ${(grandJson / 1024).toFixed(0)} KB JSON) under ${SAMPLES_ROOT}`);
if (WRITE_WAVS) console.log('Loose WAV audition files were also written because --wavs/--files was supplied.');
