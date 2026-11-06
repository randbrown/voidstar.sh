// Procedural point clouds for the Scan quale — built from scratch, no file
// needed. Each generator returns a sampled cloud ({count, positions, colors,
// normals}) in the same shape scan-cloud.js's samplers produce, so it runs
// through the identical level / frame / annotate pipeline (buildCloud).
//
//   xeno        an original biomechanical creature: domed skull, ribbed
//               torso, dorsal tubes, digitigrade legs, segmented tail
//   atom        nucleus (protons + neutrons), Bohr-style orbit rings, and
//               real hydrogen-like orbital densities |ψ|² — 2p_x/y/z lobes
//               and the 3d_z² dumbbell+torus — coloured by the sign of ψ
//   neuron      a pyramidal neuron: soma, branching apical + basal
//               dendrites, myelinated axon, synaptic boutons. The quale's
//               ripple seeds at the top, so it fires down the cell.
//   circuit     a PCB standing upright: soldermask, routed copper traces +
//               vias, CPU with a finned heatsink, ICs, capacitors, LEDs
//   lorenz      the Lorenz strange attractor (σ=10, ρ=28, β=8/3)
//   calabi-yau  Hanson's quintic Calabi–Yau cross-section (n = 5)
//   black-hole  horizon shadow, Doppler-beamed accretion disk, lensed far-side
//               ring, photon ring and polar jets
//   dna         right-handed B-DNA: two backbones, phosphate beads, A–T / G–C
//               base-pair rungs
//
// Solid objects get lighting baked into their colours (the quale's points
// are unlit), so form reads from any orbit angle. All generators are
// deterministic for a given rng.

// ── Small vector kit ───────────────────────────────────────────────────────
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Generators that model a floor set `floor: true` on their result, so the
// pipeline levels on it and treats it as ground; the rest float free.

// Baked key light + soft fill + specular, for solid parts.
const LIGHT = norm([0.45, 0.8, 0.4]);
const HALF = norm(add(LIGHT, [0.3, 0.2, 1]));
function lit(base, n, { gloss = 0.35, shininess = 20, ambient = 0.3 } = {}) {
  const d = Math.max(0, dot(n, LIGHT));
  const s = gloss * Math.pow(Math.max(0, dot(n, HALF)), shininess);
  const k = ambient + 0.85 * d;
  return [clamp01(base[0] * k + s * 0.8), clamp01(base[1] * k + s * 0.88), clamp01(base[2] * k + s)];
}

function gaussian(rng) {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}
function randomDir(rng) {
  return norm([gaussian(rng), gaussian(rng), gaussian(rng)]);
}

// ── Builder: parts claim a share of the point budget by surface area ──────
function makeBuilder(rng) {
  const parts = [];
  const B = {
    rng,
    /** area: relative weight; sample(k, emit) must emit exactly k points. */
    add(area, sample) { if (area > 0) parts.push({ area, sample }); },
    build(count) {
      const total = parts.reduce((a, p) => a + p.area, 0);
      const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), normals = new Float32Array(count * 3);
      let o = 0;
      const emit = (p, n, c) => {
        if (o >= count) return;
        positions.set(p, o * 3); normals.set(n, o * 3); colors.set(c, o * 3);
        o++;
      };
      let used = 0;
      parts.forEach((p, i) => {
        const k = i === parts.length - 1 ? count - used : Math.round(count * p.area / total);
        used += k;
        p.sample(Math.max(0, k), emit);
      });
      return { count: o, positions, colors, normals };
    },
  };
  return B;
}

// Uniform Catmull–Rom through `pts`, t ∈ [0, 1].
function spline(pts, t) {
  const n = pts.length - 1;
  const f = Math.min(n - 1e-9, Math.max(0, t * n));
  const i = Math.floor(f), u = f - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  const u2 = u * u, u3 = u2 * u;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3);
  }
  return out;
}

/**
 * A tube swept along a spline. `radius(t)` gives the profile; `color(t, n,
 * rib)` the colour (rib ∈ [0,1] is the rib crest amount). Optional ribs
 * modulate the radius like vertebrae / cartilage rings.
 */
function tube(B, pts, radius, color, { ribs = 0, ribDepth = 0, weight = 1, ribRange = [0, 1] } = {}) {
  const S = 32;
  let area = 0, prev = spline(pts, 0);
  for (let i = 1; i <= S; i++) {
    const p = spline(pts, i / S);
    area += len(sub(p, prev)) * 2 * Math.PI * radius((i - 0.5) / S);
    prev = p;
  }
  const rng = B.rng;
  B.add(area * weight, (k, emit) => {
    for (let j = 0; j < k; j++) {
      const t = rng();
      const c = spline(pts, t);
      const T = norm(sub(spline(pts, Math.min(1, t + 1e-3)), spline(pts, Math.max(0, t - 1e-3))));
      const ref = Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const u = norm(cross(T, ref)), v = cross(T, u);
      const a = rng() * Math.PI * 2;
      const n = add(mul(u, Math.cos(a)), mul(v, Math.sin(a)));
      let rib = 0;
      if (ribs && t >= ribRange[0] && t <= ribRange[1]) rib = Math.pow(Math.max(0, Math.sin(t * ribs * Math.PI * 2)), 3);
      const r = radius(t) * (1 + ribDepth * rib);
      emit(add(c, mul(n, r)), n, color(t, n, rib));
    }
  });
}

/** Ellipsoid with semi-axes `r` along the given (orthonormal) axes. */
function ellipsoid(B, center, r, color, { axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], weight = 1 } = {}) {
  const p = 1.6;
  const area = 4 * Math.PI * Math.pow((Math.pow(r[0] * r[1], p) + Math.pow(r[0] * r[2], p) + Math.pow(r[1] * r[2], p)) / 3, 1 / p);
  const rng = B.rng;
  B.add(area * weight, (k, emit) => {
    for (let j = 0; j < k; j++) {
      const d = randomDir(rng);
      const local = [d[0] * r[0], d[1] * r[1], d[2] * r[2]];
      const nl = norm([d[0] / r[0], d[1] / r[1], d[2] / r[2]]);
      const pos = add(center, add(add(mul(axes[0], local[0]), mul(axes[1], local[1])), mul(axes[2], local[2])));
      const n = norm(add(add(mul(axes[0], nl[0]), mul(axes[1], nl[1])), mul(axes[2], nl[2])));
      emit(pos, n, color(n, pos));
    }
  });
}

/** Axis-aligned box (optionally skipping the bottom face). */
function box(B, center, size, color, { bottom = false, weight = 1 } = {}) {
  const [sx, sy, sz] = size;
  const faces = [
    { n: [0, 1, 0], a: sx * sz }, { n: [1, 0, 0], a: sy * sz }, { n: [-1, 0, 0], a: sy * sz },
    { n: [0, 0, 1], a: sx * sy }, { n: [0, 0, -1], a: sx * sy },
  ];
  if (bottom) faces.push({ n: [0, -1, 0], a: sx * sz });
  const area = faces.reduce((s, f) => s + f.a, 0);
  const rng = B.rng;
  B.add(area * weight, (k, emit) => {
    for (let j = 0; j < k; j++) {
      let r = rng() * area, f = faces[0];
      for (const ff of faces) { if (r < ff.a) { f = ff; break; } r -= ff.a; }
      const p = [(rng() - 0.5) * sx, (rng() - 0.5) * sy, (rng() - 0.5) * sz];
      for (let q = 0; q < 3; q++) if (f.n[q]) p[q] = f.n[q] * size[q] / 2;
      const pos = add(center, p);
      emit(pos, f.n, color(f.n, pos));
    }
  });
}

/** Flat disc / rectangle on y = `y` (ground planes, board tops). */
function floor(B, center, extent, color, { round = true, weight = 1 } = {}) {
  const area = round ? Math.PI * extent[0] * extent[0] : extent[0] * extent[1] * 4;
  const rng = B.rng;
  B.add(area * weight, (k, emit) => {
    for (let j = 0; j < k; j++) {
      let x, z;
      if (round) { const r = Math.sqrt(rng()) * extent[0], a = rng() * Math.PI * 2; x = Math.cos(a) * r; z = Math.sin(a) * r; }
      else { x = (rng() * 2 - 1) * extent[0]; z = (rng() * 2 - 1) * extent[1]; }
      const pos = [center[0] + x, center[1], center[2] + z];
      emit(pos, [0, 1, 0], color(pos));
    }
  });
}

// Mirror a list of points across z.
const mz = (pts) => pts.map(p => [p[0], p[1], -p[2]]);

// ── xeno ───────────────────────────────────────────────────────────────────
// Side profile: x forward, y up, z lateral. Crouched, ~1.9 tall, feet and
// tail tip on the floor.
function xeno(count, rng) {
  const B = makeBuilder(rng);
  const chitin = [0.2, 0.22, 0.29], wet = [0.32, 0.36, 0.46];
  const skin = (gloss) => (t, n, rib) => lit(mix(chitin, wet, rib), n, { gloss, shininess: 22, ambient: 0.4 });
  const dome = (n) => lit(wet, n, { gloss: 1.1, shininess: 30, ambient: 0.38 });

  // Head — the long smooth dome sweeping back from the face.
  tube(B, [[0.74, 1.50, 0], [0.62, 1.58, 0], [0.44, 1.68, 0], [0.22, 1.78, 0], [0.02, 1.86, 0], [-0.08, 1.89, 0]],
    (t) => 0.045 + 0.075 * Math.sin(Math.PI * Math.min(1, t * 1.25)) * (1 - 0.55 * t), (t, n) => dome(n), { weight: 1.3 });
  // Jaw + inner jaw, teeth glint.
  tube(B, [[0.42, 1.55, 0], [0.56, 1.50, 0], [0.70, 1.46, 0]], (t) => 0.035 - 0.012 * t, skin(0.5));
  tube(B, [[0.60, 1.52, 0], [0.70, 1.505, 0], [0.77, 1.50, 0]], () => 0.012, (t, n) => lit([0.55, 0.6, 0.65], n, { gloss: 1 }), { weight: 3 });
  for (const s of [1, -1]) {
    tube(B, [[0.64, 1.535, 0.022 * s], [0.70, 1.52, 0.026 * s], [0.75, 1.508, 0.02 * s]], () => 0.006,
      () => [0.85, 0.88, 0.9], { weight: 6 });
  }

  // Neck → hunched ribbed torso → pelvis.
  tube(B, [[0.46, 1.60, 0], [0.30, 1.56, 0], [0.18, 1.48, 0], [0.06, 1.32, 0], [-0.02, 1.14, 0], [-0.06, 0.98, 0]],
    (t) => 0.05 + 0.11 * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (t < 0.7 ? 1 : 0.65),
    skin(0.45), { ribs: 7, ribDepth: 0.18, ribRange: [0.2, 0.75] });
  ellipsoid(B, [-0.06, 0.97, 0], [0.12, 0.09, 0.15], (n) => lit(chitin, n, { gloss: 0.4 }));
  // Spine ridge.
  tube(B, [[0.34, 1.66, 0], [0.18, 1.62, 0], [0.04, 1.47, 0], [-0.08, 1.24, 0], [-0.13, 1.02, 0]], () => 0.022,
    skin(0.6), { ribs: 18, ribDepth: 0.9 });

  // Dorsal tubes — four pipes rising back from the shoulders.
  for (const [z, l] of [[0.05, 0.38], [0.12, 0.32], [-0.05, 0.38], [-0.12, 0.32]]) {
    tube(B, [[0.14, 1.52, z], [0.04, 1.66, z * 1.3], [-0.08, 1.52 + l * 0.75, z * 1.6], [-0.16, 1.5 + l, z * 1.8]],
      (t) => 0.034 - 0.014 * t, skin(0.55), { ribs: 5, ribDepth: 0.12 });
  }

  for (const s of [1, -1]) {
    const side = (pts) => (s > 0 ? pts : mz(pts));
    // Arms: shoulder → elbow → wrist → long fingers.
    tube(B, side([[0.20, 1.50, 0.15], [0.12, 1.34, 0.24], [0.08, 1.22, 0.26], [0.24, 1.12, 0.24], [0.34, 1.08, 0.21]]),
      (t) => 0.04 - 0.018 * t, skin(0.4), { ribs: 4, ribDepth: 0.15 });
    for (const [dz, dy] of [[0.025, 0], [0, -0.02], [-0.025, 0.005]]) {
      tube(B, side([[0.34, 1.08, 0.21 + dz], [0.42, 1.04 + dy, 0.21 + dz * 1.5], [0.47, 0.96 + dy, 0.2 + dz * 1.8], [0.46, 0.9 + dy, 0.19 + dz * 2]]),
        (t) => 0.011 - 0.005 * t, skin(0.5));
    }
    // Digitigrade leg: hip → knee (forward) → hock (back) → foot → toes.
    tube(B, side([[-0.04, 0.96, 0.14], [0.10, 0.80, 0.19], [0.20, 0.60, 0.21]]), (t) => 0.075 - 0.03 * t, skin(0.4), { ribs: 3, ribDepth: 0.1 });
    tube(B, side([[0.20, 0.60, 0.21], [0.06, 0.45, 0.22], [-0.10, 0.30, 0.22]]), (t) => 0.045 - 0.012 * t, skin(0.45));
    tube(B, side([[-0.10, 0.30, 0.22], [-0.02, 0.14, 0.22], [0.08, 0.03, 0.23]]), () => 0.03, skin(0.45));
    for (const dz of [-0.03, 0, 0.03]) {
      tube(B, side([[0.08, 0.03, 0.23], [0.15, 0.025, 0.23 + dz], [0.22, 0.012, 0.23 + dz * 1.6]]), (t) => 0.014 - 0.007 * t, skin(0.5));
    }
  }

  // Tail — long, segmented, curling round on the floor to a blade.
  tube(B, [[-0.14, 0.96, 0], [-0.42, 0.80, 0.03], [-0.70, 0.52, -0.06], [-0.92, 0.25, 0.04], [-1.02, 0.07, 0.24], [-0.92, 0.03, 0.46], [-0.74, 0.03, 0.52]],
    (t) => 0.06 - 0.048 * t, skin(0.5), { ribs: 34, ribDepth: 0.3 });
  ellipsoid(B, [-0.68, 0.035, 0.53], [0.07, 0.008, 0.025], (n) => lit([0.3, 0.32, 0.38], n, { gloss: 1 }),
    { axes: [norm([1, 0, 0.3]), [0, 1, 0], norm([-0.3, 0, 1])], weight: 3 });

  // Floor: a dark slate disc so the creature has somewhere to stand.
  floor(B, [-0.15, 0, 0.1], [1.35], (p) => {
    const r = Math.hypot(p[0] + 0.15, p[2] - 0.1) / 1.35;
    const g = 0.10 * (1 - r * 0.85);
    return [g * 0.8, g * 0.85, g * 1.1];
  }, { weight: 0.12 });

  return { ...B.build(count), floor: true };
}

// ── atom ───────────────────────────────────────────────────────────────────
function atom(count, rng) {
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  let o = 0;
  const emit = (p, c) => {
    if (o >= count) return;
    positions.set(p, o * 3); colors.set(c, o * 3); normals.set(norm(p), o * 3); o++;
  };

  // Nucleus: 6 protons + 6 neutrons packed on a little Fibonacci ball.
  const nNuc = Math.floor(count * 0.1);
  const nucleons = [];
  for (let i = 0; i < 12; i++) {
    const y = 1 - (2 * (i + 0.5)) / 12, r = Math.sqrt(1 - y * y), a = i * 2.39996;
    nucleons.push({ c: mul([Math.cos(a) * r, y, Math.sin(a) * r], 0.085), proton: i % 2 === 0 });
  }
  for (let i = 0; i < nNuc; i++) {
    const nu = nucleons[i % 12], d = randomDir(rng);
    const base = nu.proton ? [1.0, 0.32, 0.22] : [0.55, 0.62, 0.8];
    const c = lit(base, d, { gloss: 0.7, shininess: 24, ambient: 0.35 });
    const p = add(nu.c, mul(d, 0.06));
    if (len(p) < 0.11 && dot(d, norm(nu.c)) < -0.2) { i--; continue; }   // keep the outer shell
    emit(p, c);
  }

  // Bohr-style orbit rings + an electron bead on each.
  const nRing = Math.floor(count * 0.1);
  const rings = [0, 1, 2].map((k) => {
    const yaw = (k * Math.PI) / 3, tilt = 1.15;
    const ax = [Math.cos(yaw), 0, Math.sin(yaw)];
    const ay = norm(add(mul([0, 1, 0], Math.cos(tilt)), mul([-Math.sin(yaw), 0, Math.cos(yaw)], Math.sin(tilt))));
    return { ax, ay, bead: rng() * Math.PI * 2 };
  });
  for (let i = 0; i < nRing; i++) {
    const R = rings[i % 3];
    const beadPt = i % 7 === 0;
    const a = beadPt ? R.bead : rng() * Math.PI * 2;
    const c = add(mul(R.ax, Math.cos(a) * 0.95), mul(R.ay, Math.sin(a) * 0.38));
    if (beadPt) emit(add(c, mul(randomDir(rng), 0.035)), [0.9, 1.0, 1.0]);
    else emit(add(c, mul(randomDir(rng), 0.004)), [0.35, 0.85, 1.0]);
  }

  // Orbital clouds |ψ|², hydrogen-like. Radial parts are Gamma-distributed
  // (r²|R|²), angular parts by rejection; colour = sign of ψ. Most points
  // are kept only near an iso-surface of |ψ| (crisp lobes, the textbook
  // orbital shapes); a sparse remainder is left as volumetric haze.
  const gamma = (k, theta) => { let s = 0; for (let j = 0; j < k; j++) s -= Math.log(1 - rng()); return s * theta; };
  const POS = [0.25, 0.85, 1.0], NEG = [1.0, 0.3, 0.82];
  while (o < count) {
    const pick = rng();
    let d, r, sign;
    let psi;   // |ψ| relative to its maximum
    if (pick < 0.75) {
      // 2p_x / 2p_z: r⁴e^{-r}, |Y|² ∝ cos² of the axis angle. (2p_y is
      // left out — it would sit inside the 3d_z² lobes and hide them.)
      const axis = rng() < 0.5 ? 0 : 2;
      do { d = randomDir(rng); } while (rng() > d[axis] * d[axis]);
      const ru = gamma(5, 1);
      psi = Math.abs(ru * d[axis] * Math.exp(-ru / 2)) / (2 * Math.exp(-1));
      r = ru * 0.21;          // lobes peak at ~0.42 — clear of the nucleus
      sign = d[axis] >= 0 ? 1 : -1;
    } else {
      // 3d_z²: r⁶e^{-2r/3}, |Y|² ∝ (3cos²θ − 1)² — two lobes and a torus.
      let ang;
      do { d = randomDir(rng); ang = 3 * d[1] * d[1] - 1; } while (rng() * 4 > ang * ang);
      const ru = gamma(7, 1.5);
      psi = Math.abs(ru * ru * Math.exp(-ru / 3) * ang) / (2 * 36 * Math.exp(-2));
      r = ru * 0.14;          // lobes + torus at ~0.84 — outside the 2p's
      sign = ang >= 0 ? 1 : -1;
    }
    // Per-orbital iso-levels: high for the 2p's so each lobe is a separate
    // droplet, lower for 3d_z² so its torus (half the lobes' peak) shows.
    const shell = pick < 0.75 ? psi > 0.62 && psi < 0.7 : psi > 0.2 && psi < 0.26;
    if (!shell && rng() > 0.025) continue;
    if (r < 0.16 || r > 1.7) continue;
    const fade = shell ? 0.95 : 0.3;
    const base = pick < 0.75 ? (sign > 0 ? POS : NEG) : (sign > 0 ? [0.62, 0.45, 1.0] : [0.95, 0.55, 1.0]);
    emit(mul(d, r), mul(base, fade));
  }
  return { count: o, positions, colors, normals };
}

// ── neuron ─────────────────────────────────────────────────────────────────
function neuron(count, rng) {
  const B = makeBuilder(rng);
  const soma = [0, 0.95, 0];
  const dendrite = (t) => (n) => lit(mix([0.62, 0.32, 1.0], [0.3, 0.9, 1.0], t), n, { gloss: 0.5, ambient: 0.45 });

  const rotate = (v, axis, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang), k = norm(axis);
    return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
  };
  // Recursive branching: a wiggly tapered tube, then 2 children.
  const branch = (start, dir, length, r, depth, hue) => {
    const pts = [start];
    let p = start, d = dir;
    for (let i = 0; i < 3; i++) {
      d = norm(add(d, mul(randomDir(rng), 0.28)));
      p = add(p, mul(d, length / 3));
      pts.push(p);
    }
    tube(B, pts, (t) => r * (1 - 0.35 * t), (t, n) => dendrite(Math.min(1, hue + t * 0.25))(n), { weight: 1.6 });
    if (depth <= 0) {
      ellipsoid(B, p, [r * 1.4, r * 1.4, r * 1.4], () => [0.55, 0.95, 1.0], { weight: 1.5 });   // tip bulb
      return;
    }
    for (const sgn of [1, -1]) {
      const axis = norm(cross(d, randomDir(rng)));
      const nd = rotate(d, axis, sgn * (0.35 + rng() * 0.4));
      branch(p, nd, length * (0.68 + rng() * 0.12), r * 0.7, depth - 1, Math.min(1, hue + 0.22));
    }
  };

  // Soma — a slightly pyramidal, glowing body.
  ellipsoid(B, soma, [0.11, 0.13, 0.11], (n) => lit([1.0, 0.32, 0.72], n, { gloss: 0.8, ambient: 0.55 }), { weight: 1.4 });
  // Apical dendrite: a trunk up to a branching tuft.
  const trunkTop = [0.04, 1.55, 0.02];
  tube(B, [[0, 1.05, 0], [0.02, 1.25, 0.01], trunkTop], (t) => 0.035 - 0.012 * t, (t, n) => dendrite(t * 0.2)(n));
  for (let i = 0; i < 3; i++) {
    const d = norm([Math.cos(i * 2.1) * 0.6, 1, Math.sin(i * 2.1) * 0.6]);
    branch(trunkTop, d, 0.32, 0.022, 3, 0.2);
  }
  for (const y of [1.2, 1.35]) {
    for (const s of [1, -1]) branch([0.02, y, 0], norm([s * 0.9, 0.5, rng() - 0.5]), 0.2, 0.012, 2, 0.3);
  }
  // Basal dendrites radiating from the soma's lower half.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const d = norm([Math.cos(a), -0.35, Math.sin(a)]);
    branch(add(soma, mul(d, 0.1)), d, 0.26, 0.022, 3, 0.15);
  }
  // Axon: straight down, myelinated (sheath rings), then terminal arbor.
  const axonEnd = [0.05, 0.12, 0.04];
  tube(B, [[0, 0.83, 0], [0.01, 0.6, 0.01], [0.03, 0.35, 0.03], axonEnd], () => 0.018,
    (t, n, rib) => lit(mix([0.35, 0.55, 0.95], [0.85, 0.9, 1.0], rib), n, { gloss: 0.6, ambient: 0.5 }),
    { ribs: 7, ribDepth: 0.9, ribRange: [0.08, 0.95] });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    branch(axonEnd, norm([Math.cos(a), -0.25, Math.sin(a)]), 0.16, 0.01, 2, 0.75);
  }
  return B.build(count);
}

// ── circuit ────────────────────────────────────────────────────────────────
function circuit(count, rng) {
  const B = makeBuilder(rng);
  const W = 1.1, D = 0.8, TOP = 0.0;
  const copper = [0.95, 0.62, 0.22], gold = [1.0, 0.82, 0.35];

  // Soldermask board top (the "floor" — nothing beneath it is sampled).
  floor(B, [0, TOP, 0], [W, D], (p) => {
    const g = 0.75 + 0.25 * Math.sin(p[0] * 40) * Math.sin(p[2] * 40);
    return [0.02 * g, 0.12 * g, 0.07 * g];
  }, { round: false, weight: 0.18 });

  // Components (centre x, z, size x, y, z, colour, kind).
  const parts = [];
  const cpu = { x: 0, z: 0, sx: 0.36, sy: 0.04, sz: 0.36 };
  box(B, [cpu.x, TOP + cpu.sy / 2, cpu.z], [cpu.sx, cpu.sy, cpu.sz], (n) => lit([0.07, 0.07, 0.08], n, { gloss: 0.4 }));
  // Heatsink: base plate + fins.
  box(B, [0, TOP + 0.05, 0], [0.32, 0.02, 0.32], (n) => lit([0.6, 0.64, 0.7], n, { gloss: 0.9 }));
  for (let i = 0; i < 11; i++) {
    const x = -0.15 + i * 0.03;
    box(B, [x, TOP + 0.13, 0], [0.008, 0.14, 0.3], (n) => lit([0.66, 0.7, 0.78], n, { gloss: 1, shininess: 30 }), { weight: 0.9 });
  }
  parts.push(cpu);
  // ICs with gull-wing pins.
  const ics = [[-0.62, -0.42, 0.22, 0.12], [0.62, -0.42, 0.22, 0.12], [-0.62, 0.42, 0.16, 0.16], [0.62, 0.45, 0.26, 0.1], [-0.18, 0.55, 0.14, 0.1], [0.3, -0.58, 0.14, 0.1]];
  for (const [x, z, sx, sz] of ics) {
    box(B, [x, TOP + 0.012, z], [sx, 0.024, sz], (n) => lit([0.06, 0.06, 0.07], n, { gloss: 0.3 }));
    const pins = Math.round(sx / 0.025);
    for (let i = 0; i < pins; i++) {
      for (const s of [1, -1]) {
        const px = x - sx / 2 + (i + 0.5) * (sx / pins);
        box(B, [px, TOP + 0.004, z + s * (sz / 2 + 0.012)], [0.008, 0.008, 0.024], (n) => lit([0.82, 0.84, 0.88], n, { gloss: 1 }), { weight: 2 });
      }
    }
    parts.push({ x, z, sx, sz });
  }
  // Electrolytic capacitors (cylinders with a scored top) + crystal.
  for (const [x, z, r, h] of [[0.85, 0.05, 0.05, 0.14], [0.85, -0.15, 0.04, 0.11], [-0.86, 0.05, 0.05, 0.16], [0.35, 0.25, 0.035, 0.09]]) {
    tube(B, [[x, TOP, z], [x, TOP + h / 2, z], [x, TOP + h, z]], () => r,
      (t, n) => lit(t > 0.85 ? [0.75, 0.78, 0.85] : [0.12, 0.16, 0.42], n, { gloss: 0.7 }));
    floor(B, [x, TOP + h, z], [r], (p) => (Math.abs(p[0] - x) < 0.004 || Math.abs(p[2] - z) < 0.004 ? [0.25, 0.25, 0.3] : [0.72, 0.75, 0.82]));
    parts.push({ x, z, sx: r * 2, sz: r * 2 });
  }
  box(B, [-0.35, TOP + 0.015, -0.2], [0.1, 0.03, 0.04], (n) => lit([0.78, 0.8, 0.86], n, { gloss: 1 }));
  // SMD resistors + LEDs (the LEDs glow).
  for (let i = 0; i < 14; i++) {
    const x = -0.95 + rng() * 1.9, z = -0.7 + rng() * 1.4;
    if (parts.some(p => Math.abs(p.x - x) < p.sx / 2 + 0.06 && Math.abs(p.z - z) < p.sz / 2 + 0.06)) continue;
    const led = i % 4 === 0;
    const body = led ? (i % 8 === 0 ? [1.0, 0.15, 0.3] : [0.2, 1.0, 0.75]) : [0.08, 0.08, 0.09];
    box(B, [x, TOP + 0.008, z], [0.04, 0.016, 0.02], (n) => (led ? body : lit(body, n)), { weight: led ? 6 : 2 });
    parts.push({ x, z, sx: 0.04, sz: 0.02 });
  }

  // Copper traces: Manhattan routes with 45° chamfers, out from component
  // edges, each ending in a via.
  const traces = [];
  for (let i = 0; i < 70; i++) {
    const p0 = parts[Math.floor(rng() * parts.length)];
    const side = Math.floor(rng() * 4);
    let x = p0.x + (side === 0 ? p0.sx / 2 : side === 1 ? -p0.sx / 2 : (rng() - 0.5) * p0.sx);
    let z = p0.z + (side === 2 ? p0.sz / 2 : side === 3 ? -p0.sz / 2 : (rng() - 0.5) * p0.sz);
    let dir = side === 0 ? [1, 0] : side === 1 ? [-1, 0] : side === 2 ? [0, 1] : [0, -1];
    const pts = [[x, z]];
    for (let s = 0; s < 3 + Math.floor(rng() * 4); s++) {
      const L = 0.06 + rng() * 0.28;
      x += dir[0] * L; z += dir[1] * L;
      x = Math.max(-W + 0.03, Math.min(W - 0.03, x)); z = Math.max(-D + 0.03, Math.min(D - 0.03, z));
      pts.push([x, z]);
      const turn = rng() < 0.5 ? 1 : -1;
      const diag = [dir[0] - turn * dir[1], dir[1] + turn * dir[0]].map(v => v * Math.SQRT1_2);
      const c = 0.03 + rng() * 0.05;
      x += diag[0] * c; z += diag[1] * c;
      pts.push([x, z]);
      dir = [-turn * dir[1], turn * dir[0]];
    }
    traces.push(pts);
  }
  for (const pts of traces) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    B.add(L * 0.02 * 3.5, (k, emit) => {
      for (let j = 0; j < k; j++) {
        let r = rng() * L, i = 1;
        for (; i < pts.length - 1; i++) { const s = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (r < s) break; r -= s; }
        const a = pts[i - 1], b = pts[i], s = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const t = Math.min(1, r / s), w = (rng() - 0.5) * 0.009;
        emit([a[0] + (b[0] - a[0]) * t - (b[1] - a[1]) / s * w, TOP + 0.002, a[1] + (b[1] - a[1]) * t + (b[0] - a[0]) / s * w], [0, 1, 0], copper);
      }
    });
    const end = pts[pts.length - 1];
    B.add(0.0004 * 40, (k, emit) => {
      for (let j = 0; j < k; j++) {
        const a = rng() * Math.PI * 2, r = 0.01 + rng() * 0.006;
        emit([end[0] + Math.cos(a) * r, TOP + 0.003, end[1] + Math.sin(a) * r], [0, 1, 0], gold);
      }
    });
  }
  // Built lying flat; stand it up like a monolith (board z → height,
  // component height → toward the viewer) so it reads from every orbit
  // angle and the ripple runs down the traces from the top edge.
  const c = B.build(count);
  for (const A of [c.positions, c.normals]) {
    for (let i = 0; i < c.count; i++) {
      const y = A[i * 3 + 1], z = A[i * 3 + 2];
      A[i * 3 + 1] = -z; A[i * 3 + 2] = y;
    }
  }
  return c;
}

// ── lorenz ─────────────────────────────────────────────────────────────────
function lorenz(count, rng) {
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  // A short run (~30 time units, a few dozen loops) keeps the threads
  // distinct — a long one fills the wings in solid.
  const sigma = 10, rho = 28, beta = 8 / 3, dt = 30 / count;
  let x = 0.1, y = 0, z = 0;
  const step = () => {
    const dx = sigma * (y - x), dy = x * (rho - z) - y, dz = x * y - beta * z;
    x += dx * dt; y += dy * dt; z += dz * dt;
    return Math.hypot(dx, dy, dz);
  };
  for (let i = 0; i < 2 / dt; i++) step();          // settle onto the attractor
  for (let i = 0; i < count; i++) {
    const v = step();
    const j = mul(randomDir(rng), 0.07 * Math.sqrt(rng()));
    // z is the attractor's "up"; the wings sit at x = y = ±8.5, so x + y
    // runs across between them and x − y is the shallow depth.
    positions.set([(x + y) * Math.SQRT1_2 + j[0], z + j[1], (x - y) * Math.SQRT1_2 + j[2]], i * 3);
    // Colour by speed: slow (the lobes' eyes) violet → fast (the swing
    // between wings) cyan → a little white at the fastest.
    const s = clamp01(v / 260);
    const c = s < 0.6 ? mix([0.45, 0.18, 0.95], [0.18, 0.8, 1.0], s / 0.6) : mix([0.18, 0.8, 1.0], [0.75, 0.9, 1.0], (s - 0.6) / 0.4);
    colors.set(c, i * 3);
  }
  return { count, positions, colors, normals: null };
}

// ── calabi-yau ─────────────────────────────────────────────────────────────
// Hanson's projection of the quintic: z1^5 + z2^5 = 1, 25 patches.
function calabiYau(count, rng) {
  const N = 5, alpha = Math.PI / 4;
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  const cpow = (re, im, p) => {
    const r = Math.pow(Math.hypot(re, im), p), a = Math.atan2(im, re) * p;
    return [r * Math.cos(a), r * Math.sin(a)];
  };
  const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const palette = [[0.45, 0.2, 0.95], [0.2, 0.85, 1.0], [1.0, 0.3, 0.8], [0.35, 1.0, 0.7], [1.0, 0.75, 0.3]];
  for (let i = 0; i < count; i++) {
    const k1 = Math.floor(rng() * N), k2 = Math.floor(rng() * N);
    // x biased toward 0 — the patch's far ends stretch out and thin.
    const x = (rng() * 2 - 1) * Math.pow(rng(), 0.35) * 1.1, y = rng() * Math.PI / 2;
    const ch = [Math.cosh(x) * Math.cos(y), Math.sinh(x) * Math.sin(y)];
    const sh = [Math.sinh(x) * Math.cos(y), Math.cosh(x) * Math.sin(y)];
    const z1 = cmul([Math.cos(2 * Math.PI * k1 / N), Math.sin(2 * Math.PI * k1 / N)], cpow(ch[0], ch[1], 2 / N));
    const z2 = cmul([Math.cos(2 * Math.PI * k2 / N), Math.sin(2 * Math.PI * k2 / N)], cpow(sh[0], sh[1], 2 / N));
    positions.set([z1[0], Math.cos(alpha) * z1[1] + Math.sin(alpha) * z2[1], z2[0]], i * 3);
    const c = mix(palette[k1], palette[k2], 0.35);
    colors.set(mul(c, 0.55 + 0.45 * Math.cos(y * 2) ** 2), i * 3);
  }
  return { count, positions, colors, normals: null };
}

// ── black hole ─────────────────────────────────────────────────────────────
// A Gargantua-style black hole in units of the horizon radius: a near-black
// horizon sphere (it occludes in the solid 'scan' palette — the shadow), a
// hot accretion disk with Doppler beaming and spiral turbulence, the lensed
// image of the disk's far side as a ring arching over the poles, a thin
// photon ring, and two relativistic jets.
function blackHole(count, rng) {
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  let o = 0;
  const emit = (p, n, c) => { positions.set(p, o * 3); normals.set(n, o * 3); colors.set(c, o * 3); o++; };
  // Disk temperature: white-hot inside → amber → deep red at the rim.
  const heat = (t) => t < 0.35 ? mix([1.0, 0.97, 0.9], [1.0, 0.72, 0.3], t / 0.35) : mix([1.0, 0.72, 0.3], [0.55, 0.12, 0.08], (t - 0.35) / 0.65);
  const R_IN = 2.6, R_OUT = 7.5;
  const parts = [
    ['horizon', 0.14], ['disk', 0.56], ['lensed', 0.1], ['photon', 0.04], ['jets', 0.16],
  ];
  for (const [kind, share] of parts) {
    const k = kind === 'jets' ? count - o : Math.floor(count * share);
    for (let i = 0; i < k; i++) {
      if (kind === 'horizon') {
        // Event horizon: almost black, with a faint violet limb so its edge reads.
        const d = randomDir(rng);
        emit(d, d, [0.012, 0.01, 0.02]);
      } else if (kind === 'disk') {
        // Radius ∝ inner-weighted (brighter, denser near the ISCO).
        const r = R_IN + (R_OUT - R_IN) * Math.pow(rng(), 1.6);
        const a = rng() * Math.PI * 2;
        const t = (r - R_IN) / (R_OUT - R_IN);
        const h = gaussian(rng) * 0.04 * (0.4 + t * 1.6);           // flares a little outward
        // Spiral turbulence streaks + Doppler beaming (approaching side, sin a > 0).
        const streak = 0.65 + 0.35 * Math.sin(a * 3 + Math.log(r) * 9 + rng() * 0.6);
        const doppler = 0.55 + 0.75 * (0.5 + 0.5 * Math.sin(a));
        const c = mul(heat(t), streak * doppler * (1.15 - 0.45 * t));
        const blue = Math.max(0, Math.sin(a)) * 0.18;               // blueshift on the approaching side
        emit([Math.cos(a) * r, h, Math.sin(a) * r], [0, Math.sign(h) || 1, 0], [clamp01(c[0] - blue * 0.5), clamp01(c[1]), clamp01(c[2] + blue)]);
      } else if (kind === 'lensed') {
        // The disk's far side, bent over the top and under the bottom of the
        // shadow — a ring in the vertical plane, hugging the horizon.
        const a = rng() * Math.PI * 2;
        const r = 1.35 + rng() * 1.3;
        const t = (r - 1.35) / 1.3;
        const z = gaussian(rng) * 0.03;
        emit([Math.cos(a) * r, Math.sin(a) * r, z], [Math.cos(a), Math.sin(a), 0], mul(heat(0.25 + t * 0.7), 0.6 - 0.35 * t));
      } else if (kind === 'photon') {
        // Photon ring: a razor-thin bright circle just outside the shadow.
        const a = rng() * Math.PI * 2, r = 1.12 + gaussian(rng) * 0.01;
        emit([Math.cos(a) * r, Math.sin(a) * r, gaussian(rng) * 0.01], [Math.cos(a), Math.sin(a), 0], [1.0, 0.95, 0.85]);
      } else {
        // Jets: narrow, slightly widening cones up and down the spin axis.
        const up = rng() < 0.5 ? 1 : -1;
        // Kept shorter than the disk is wide, so the disk sets the framing.
        const y = 1.2 + Math.pow(rng(), 0.8) * 4.3;
        const w = 0.04 + y * 0.022, a = rng() * Math.PI * 2, rr = Math.abs(gaussian(rng)) * w * 0.6;
        const fade = 1 - (y - 1.2) / 4.3;
        emit([Math.cos(a) * rr, up * y, Math.sin(a) * rr], [Math.cos(a), 0, Math.sin(a)], mul([0.45, 0.65, 1.0], 0.25 + 0.75 * fade));
      }
    }
  }
  return { count: o, positions, colors, normals };
}

// ── DNA ────────────────────────────────────────────────────────────────────
// B-DNA, right-handed: 10.5 base pairs per turn, two sugar-phosphate
// backbones offset to give the major/minor grooves, phosphate beads, and
// base-pair rungs coloured by base (A–T, G–C).
function dna(count, rng) {
  const B = makeBuilder(rng);
  // ~2.3 turns: true B-DNA proportions, short enough to read as a helix.
  const R = 0.32, RISE = 0.0338 * 3, BP_PER_TURN = 10.5, PAIRS = 24;
  const H = PAIRS * RISE;
  const twist = (2 * Math.PI) / BP_PER_TURN;
  const GROOVE = (2 * Math.PI) * (150 / 360);                       // minor-groove offset between strands
  const strand = (y, s) => {
    const a = (y / RISE) * twist + s * GROOVE;
    return [Math.cos(a) * R, y, Math.sin(a) * R];
  };
  const BASES = { A: [0.25, 0.95, 0.55], T: [1.0, 0.35, 0.45], G: [0.35, 0.65, 1.0], C: [1.0, 0.82, 0.3] };
  const PAIR = { A: 'T', T: 'A', G: 'C', C: 'G' };
  // Backbones: two smooth tubes, sampled densely along the helix.
  for (const s of [0, 1]) {
    const pts = [];
    for (let i = 0; i <= PAIRS * 4; i++) pts.push(strand((i / (PAIRS * 4)) * H, s));
    tube(B, pts, () => 0.045, (t, n) => lit(s ? [0.62, 0.4, 1.0] : [0.3, 0.75, 1.0], n, { gloss: 0.8, ambient: 0.45 }), { weight: 1.3 });
  }
  for (let i = 0; i < PAIRS; i++) {
    const y = (i + 0.5) * RISE;
    const p0 = strand(y, 0), p1 = strand(y, 1);
    // Phosphate beads on each backbone.
    for (const [p, s] of [[p0, 0], [p1, 1]]) {
      ellipsoid(B, p, [0.065, 0.065, 0.065], (n) => lit(s ? [0.8, 0.6, 1.0] : [0.55, 0.9, 1.0], n, { gloss: 1, ambient: 0.5 }), { weight: 1.2 });
    }
    // Base pair: two half-rungs meeting near the axis, a little gap between.
    const b = 'ATGC'[Math.floor(rng() * 4)], pb = PAIR[b];
    const mid = mix(p0, p1, 0.5);
    tube(B, [mix(p0, mid, 0.15), mix(p0, mid, 0.55), mix(p0, mid, 0.95)], () => 0.022, (t, n) => lit(BASES[b], n, { gloss: 0.6, ambient: 0.5 }));
    tube(B, [mix(p1, mid, 0.15), mix(p1, mid, 0.55), mix(p1, mid, 0.95)], () => 0.022, (t, n) => lit(BASES[pb], n, { gloss: 0.6, ambient: 0.5 }));
  }
  return B.build(count);
}

export const PROCEDURAL = {
  'calabi-yau': calabiYau, xeno, atom, neuron, circuit, lorenz, 'black-hole': blackHole, dna,
};
export const PROCEDURAL_NAMES = Object.keys(PROCEDURAL);
