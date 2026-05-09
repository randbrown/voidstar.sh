// Antireductionism — per-stratum particle generators.
//
// One pure function per scale stratum. Each returns Float32Arrays for the
// stratum's static geometry; the parent FX module wraps them in
// BufferGeometry / Points and updates uniforms only.
//
// All generators take `(count)` and a small set of stratum-specific params.
// They never reference Three.js — the FX module owns scene construction —
// so these are dirt-cheap to unit-test or hot-reload independently.

const TAU = Math.PI * 2;

/** Cosmic web — sparse filamentary distribution.
 *  Three random "sheet" planes are seeded; each particle is offset along its
 *  nearest sheet, giving the eye coherent walls + voids without a real
 *  Voronoi cell pass. Spread ±SPREAD on each axis. */
export function generateCosmicWeb(count, spread = 60) {
  const positions = new Float32Array(count * 3);
  const aSize     = new Float32Array(count);
  const aBright   = new Float32Array(count);
  // A handful of sheet planes (axis + offset) — galaxies cluster near these.
  const SHEETS = 8;
  const sheets = [];
  for (let i = 0; i < SHEETS; i++) {
    sheets.push({
      ax: Math.random() < 0.5 ? 0 : (Math.random() < 0.5 ? 1 : 2),
      off: (Math.random() - 0.5) * spread * 0.7,
    });
  }
  for (let i = 0; i < count; i++) {
    let x = (Math.random() - 0.5) * spread;
    let y = (Math.random() - 0.5) * spread;
    let z = (Math.random() - 0.5) * spread;
    // Snap a fraction of particles toward their nearest sheet — gives the
    // eye filament-like walls.
    if (Math.random() < 0.65) {
      const s = sheets[(Math.random() * SHEETS) | 0];
      const v = [x, y, z];
      v[s.ax] = s.off + (Math.random() - 0.5) * 1.2;
      x = v[0]; y = v[1]; z = v[2];
    }
    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    aSize[i]   = 0.6 + Math.random() * Math.random() * 1.6;
    aBright[i] = 0.4 + Math.random() * 0.6;
  }
  return { positions, aSize, aBright };
}

/** Galaxy — log-spiral disk with bulge, lifted from galaxy.js. Returns the
 *  `aLogR` attribute used by the parent shader for arm-winding. */
export function generateGalaxy(count, armCount = 4, radius = 14) {
  const positions = new Float32Array(count * 3);
  const aLogR     = new Float32Array(count);
  const aColor    = new Float32Array(count);
  const aBulge    = new Float32Array(count);
  const bulgeCount = Math.floor(count * 0.10);
  const armSpacing = TAU / Math.max(1, armCount);
  for (let i = 0; i < count; i++) {
    let r, phase, height, color, bulge;
    if (i < bulgeCount) {
      const u = Math.max(1e-4, Math.random());
      r = Math.min(radius * 0.07 / Math.sqrt(Math.pow(u, -2 / 3) - 1), radius * 0.30);
      phase = Math.random() * TAU;
      height = (Math.random() - 0.5) * radius * 0.05 * Math.exp(-r / (radius * 0.10));
      color = 0.85 + Math.random() * 0.15;
      bulge = 1.0;
    } else {
      const radial = -Math.log(1 - Math.random() * 0.95) * (radius * 0.20);
      r = Math.min(radial, radius);
      const armBase = Math.log(Math.max(r, 0.5));
      const armIdx  = Math.floor(Math.random() * armCount);
      const jitter  = (Math.random() - 0.5 + Math.random() - 0.5) * 0.45 * armSpacing;
      phase = armBase + armIdx * armSpacing + jitter;
      const flare = Math.max(0.3, 1 - r / radius);
      height = (Math.random() - 0.5) * 0.32 * flare;
      color = Math.random();
      bulge = 0.0;
    }
    positions[i * 3 + 0] = r * Math.cos(phase);
    positions[i * 3 + 1] = height;
    positions[i * 3 + 2] = r * Math.sin(phase);
    aLogR[i]  = Math.log(Math.max(r, 0.5));
    aColor[i] = color;
    aBulge[i] = bulge;
  }
  return { positions, aLogR, aColor, aBulge };
}

/** Solar — central sphere of "star" particles + thin rings of "planets" in
 *  the xz-plane. Returns positions only; the shader uses distance-from-origin
 *  to colour star vs ring. */
export function generateSolar(count) {
  const positions = new Float32Array(count * 3);
  const aRing     = new Float32Array(count);   // 0=star, 1=ring
  const STAR_FRAC = 0.35;
  const starCount = Math.floor(count * STAR_FRAC);
  // Star — gaussian-ish point cloud at origin.
  for (let i = 0; i < starCount; i++) {
    const r = Math.random() * Math.random() * 1.0;
    const theta = Math.acos(2 * Math.random() - 1);
    const phi = Math.random() * TAU;
    positions[i * 3 + 0] = r * Math.sin(theta) * Math.cos(phi);
    positions[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
    positions[i * 3 + 2] = r * Math.cos(theta);
    aRing[i] = 0;
  }
  // Rings — five orbital bands at distinct radii in the xz plane.
  const RING_RADII = [3.5, 5.0, 7.0, 9.5, 12.0];
  for (let i = starCount; i < count; i++) {
    const ringIdx = i % RING_RADII.length;
    const r = RING_RADII[ringIdx] + (Math.random() - 0.5) * 0.18;
    const phase = Math.random() * TAU;
    positions[i * 3 + 0] = r * Math.cos(phase);
    positions[i * 3 + 1] = (Math.random() - 0.5) * 0.06;
    positions[i * 3 + 2] = r * Math.sin(phase);
    aRing[i] = 1;
  }
  return { positions, aRing };
}

/** Earth — points on a unit sphere with a noise-derived "continent" attribute
 *  (0 = ocean, 1 = land). The fragment shader paints accordingly. */
export function generateEarth(count) {
  const positions = new Float32Array(count * 3);
  const aLand     = new Float32Array(count);
  // Fixed-seed noise lobes to give a stable continent map.
  const LOBES = 6;
  const lobes = new Array(LOBES);
  for (let i = 0; i < LOBES; i++) {
    const t = Math.acos(2 * Math.random() - 1);
    const p = Math.random() * TAU;
    lobes[i] = {
      x: Math.sin(t) * Math.cos(p),
      y: Math.sin(t) * Math.sin(p),
      z: Math.cos(t),
      w: 0.20 + Math.random() * 0.45,
    };
  }
  for (let i = 0; i < count; i++) {
    const t = Math.acos(2 * Math.random() - 1);
    const p = Math.random() * TAU;
    const sx = Math.sin(t) * Math.cos(p);
    const sy = Math.sin(t) * Math.sin(p);
    const sz = Math.cos(t);
    positions[i * 3 + 0] = sx * 4.0;
    positions[i * 3 + 1] = sy * 4.0;
    positions[i * 3 + 2] = sz * 4.0;
    let land = 0;
    for (let k = 0; k < LOBES; k++) {
      const L = lobes[k];
      const dot = sx * L.x + sy * L.y + sz * L.z;
      if (dot > 1 - L.w) land = Math.max(land, (dot - (1 - L.w)) / L.w);
    }
    aLand[i] = land;
  }
  return { positions, aLand };
}

/** Flock — initial scatter for the boids. The FX module integrates the
 *  cohesion / separation / alignment loop on CPU each frame. We return
 *  the initial position + velocity arrays only. */
export function generateFlock(count) {
  const positions  = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const SPREAD = 5.0;
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * SPREAD;
    positions[i * 3 + 1] = (Math.random() - 0.5) * SPREAD * 0.5;
    positions[i * 3 + 2] = (Math.random() - 0.5) * SPREAD;
    velocities[i * 3 + 0] = (Math.random() - 0.5) * 0.4;
    velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.2;
    velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
  }
  return { positions, velocities };
}

/** Bird — a low-poly silhouette extruded along the y-axis with hinged wings.
 *  Returns indexed triangle arrays. The shader animates the wings by reading
 *  a per-vertex aWingSide attribute and offsetting along the chord axis. */
export function generateBird() {
  // Simple double-V-with-body. Triangles share vertices to keep the buffer
  // small. Coords in normalised "bird body" space — the parent scales it.
  const positions = new Float32Array([
    // Body (along z, head at z=+1, tail at z=-1).
     0.00,  0.00,  1.20,    // 0 head
     0.00,  0.06,  0.60,    // 1 neck top
     0.00, -0.06,  0.60,    // 2 neck bot
     0.00,  0.10,  0.00,    // 3 mid top
     0.00, -0.10,  0.00,    // 4 mid bot
     0.00,  0.04, -1.00,    // 5 tail top
     0.00, -0.04, -1.00,    // 6 tail bot
    // Right wing — three points: shoulder, mid, tip.
     0.10,  0.00,  0.10,    // 7 R shoulder
     0.65,  0.05,  0.05,    // 8 R mid
     1.30,  0.00, -0.20,    // 9 R tip
    // Left wing — mirror.
    -0.10,  0.00,  0.10,    // 10 L shoulder
    -0.65,  0.05,  0.05,    // 11 L mid
    -1.30,  0.00, -0.20,    // 12 L tip
  ]);
  // 0=body, +1=right wing, -1=left wing — drives the wing-flap shader.
  const aWingSide = new Float32Array([
    0, 0, 0, 0, 0, 0, 0,
    1, 1, 1,
    -1, -1, -1,
  ]);
  const indices = new Uint16Array([
    // Body strip (top + bottom triangles).
    0, 1, 2,
    1, 3, 2,
    2, 3, 4,
    3, 5, 4,
    4, 5, 6,
    // Right wing — two triangles.
    7, 8, 9,
    7, 9, 3,
    // Left wing.
    10, 11, 12,
    10, 12, 3,
  ]);
  return { positions, aWingSide, indices };
}

/** Cell — large outer membrane sphere of point cloud + N small organelles
 *  (each a tiny inner cluster). Returns positions + an aOrganelle attribute
 *  the shader uses to tint organelles distinctly from cytoplasm. */
export function generateCell(count) {
  const positions = new Float32Array(count * 3);
  const aOrganelle = new Float32Array(count);
  const ORGANELLE_COUNT = 12;
  const organelles = [];
  for (let i = 0; i < ORGANELLE_COUNT; i++) {
    const t = Math.acos(2 * Math.random() - 1);
    const p = Math.random() * TAU;
    const r = 0.4 + Math.random() * 1.4;
    organelles.push({
      x: r * Math.sin(t) * Math.cos(p),
      y: r * Math.sin(t) * Math.sin(p),
      z: r * Math.cos(t),
      kind: 0.3 + Math.random() * 0.7,
      size: 0.20 + Math.random() * 0.30,
    });
  }
  // Outer-shell points (membrane) + inner organelle cluster points.
  const SHELL_FRAC = 0.55;
  const shellCount = Math.floor(count * SHELL_FRAC);
  for (let i = 0; i < shellCount; i++) {
    const t = Math.acos(2 * Math.random() - 1);
    const p = Math.random() * TAU;
    const r = 2.4 + (Math.random() - 0.5) * 0.06;
    positions[i * 3 + 0] = r * Math.sin(t) * Math.cos(p);
    positions[i * 3 + 1] = r * Math.sin(t) * Math.sin(p);
    positions[i * 3 + 2] = r * Math.cos(t);
    aOrganelle[i] = 0;
  }
  for (let i = shellCount; i < count; i++) {
    const o = organelles[(Math.random() * ORGANELLE_COUNT) | 0];
    // Cluster around the organelle centre.
    const r = o.size * Math.cbrt(Math.random());
    const t = Math.acos(2 * Math.random() - 1);
    const p = Math.random() * TAU;
    positions[i * 3 + 0] = o.x + r * Math.sin(t) * Math.cos(p);
    positions[i * 3 + 1] = o.y + r * Math.sin(t) * Math.sin(p);
    positions[i * 3 + 2] = o.z + r * Math.cos(t);
    aOrganelle[i] = o.kind;
  }
  return { positions, aOrganelle };
}

/** Molecule — a small caffeine-ish ball-and-stick model. We don't need to
 *  be chemically accurate, just visually jewel-like: 12 atoms at fixed
 *  positions with bond pairs the parent renders as LineSegments. */
export function generateMolecule() {
  // 12 atoms in two interlocked hexagonal rings.
  const atomPositions = new Float32Array([
    // Ring A (xz plane, radius 1.2).
     1.20,  0.00,  0.00,
     0.60,  0.00,  1.04,
    -0.60,  0.00,  1.04,
    -1.20,  0.00,  0.00,
    -0.60,  0.00, -1.04,
     0.60,  0.00, -1.04,
    // Ring B (rotated, radius 0.85, raised on y).
     0.00,  0.85,  0.85,
     0.74,  0.85,  0.42,
     0.74,  0.85, -0.42,
     0.00,  0.85, -0.85,
    -0.74,  0.85, -0.42,
    -0.74,  0.85,  0.42,
  ]);
  // 0=carbon-ish (grey), 1=oxygen-ish (red), 2=nitrogen-ish (blue).
  const atomKind = new Float32Array([
    0, 0, 1, 0, 0, 2,
    1, 0, 0, 2, 0, 0,
  ]);
  const atomRadius = new Float32Array([
    0.32, 0.32, 0.40, 0.32, 0.32, 0.36,
    0.40, 0.32, 0.32, 0.36, 0.32, 0.32,
  ]);
  // Bond pairs (closed Ring A + closed Ring B + a few cross-bonds).
  const bondPairs = new Uint16Array([
    0, 1,  1, 2,  2, 3,  3, 4,  4, 5,  5, 0,        // ring A
    6, 7,  7, 8,  8, 9,  9,10, 10,11, 11, 6,        // ring B
    0, 7,  3,10,                                    // cross
  ]);
  return { atomPositions, atomKind, atomRadius, bondPairs };
}

/** Atom — hydrogenic |ψ|² rejection-sampled cloud (1s by default; the parent
 *  picks the orbital).  Forms reused from atomic-orbital.js. */
const ORBITAL_FNS = {
  '1s':    (x, y, z, r) => Math.exp(-2 * r),
  '2p_z':  (x, y, z, r) => z * z * Math.exp(-r),
  '3d_z2': (x, y, z, r) => {
    const a = 3 * z * z - r * r; return Math.exp(-2 * r / 3) * a * a;
  },
};

export function generateAtom(count, orbital = '1s', rMax = 6) {
  const prob = ORBITAL_FNS[orbital] || ORBITAL_FNS['1s'];
  const positions   = new Float32Array(count * 3);
  const intensities = new Float32Array(count);
  // Empirical envelope for rejection sampling.
  let maxP = 0;
  for (let i = 0; i < 3000; i++) {
    const x = (Math.random() * 2 - 1) * rMax;
    const y = (Math.random() * 2 - 1) * rMax;
    const z = (Math.random() * 2 - 1) * rMax;
    const r = Math.hypot(x, y, z);
    const p = prob(x, y, z, r);
    if (p > maxP) maxP = p;
  }
  maxP *= 1.4;
  if (maxP <= 0) maxP = 1;
  let written = 0, attempts = 0;
  const maxAttempts = count * 200;
  while (written < count && attempts < maxAttempts) {
    attempts++;
    const x = (Math.random() * 2 - 1) * rMax;
    const y = (Math.random() * 2 - 1) * rMax;
    const z = (Math.random() * 2 - 1) * rMax;
    const r = Math.hypot(x, y, z);
    const p = prob(x, y, z, r);
    if (Math.random() < p / maxP) {
      positions[written * 3 + 0] = x;
      positions[written * 3 + 1] = y;
      positions[written * 3 + 2] = z;
      intensities[written] = Math.min(1, p / maxP);
      written++;
    }
  }
  if (written < count) {
    return {
      positions: positions.subarray(0, written * 3),
      intensities: intensities.subarray(0, written),
    };
  }
  return { positions, intensities };
}

/** Higgs — a flat plane of regularly-spaced grid vertices that the vertex
 *  shader displaces by audio-modulated noise. We return positions for an
 *  N×N grid, plus indices for line segments along rows + columns so the
 *  GPU draws a wireframe net. */
export function generateHiggsField(N = 60, size = 8) {
  const positions = new Float32Array(N * N * 3);
  const aGrid     = new Float32Array(N * N * 2);
  const half = size * 0.5;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      positions[idx * 3 + 0] = (i / (N - 1)) * size - half;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = (j / (N - 1)) * size - half;
      aGrid[idx * 2 + 0] = i / (N - 1);
      aGrid[idx * 2 + 1] = j / (N - 1);
    }
  }
  // Line indices — horizontal runs + vertical runs. Max N=60 → max index
  // 3599, fits in Uint16 (no need for the OES_element_index_uint extension).
  const lineIdx = new Uint16Array(2 * (N * (N - 1) * 2));
  let w = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N - 1; i++) {
      lineIdx[w++] = j * N + i;
      lineIdx[w++] = j * N + i + 1;
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - 1; j++) {
      lineIdx[w++] = j * N + i;
      lineIdx[w++] = (j + 1) * N + i;
    }
  }
  return { positions, aGrid, lineIdx };
}

/** Planck — dense, low-amplitude foam. Uniform random points in a small box
 *  with a per-particle aJitterSeed so the shader can shake each one
 *  independently every frame (no CPU update). */
export function generatePlanck(count, extent = 4) {
  const positions = new Float32Array(count * 3);
  const aSeed     = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * extent;
    positions[i * 3 + 1] = (Math.random() - 0.5) * extent;
    positions[i * 3 + 2] = (Math.random() - 0.5) * extent;
    aSeed[i] = Math.random() * 1000;
  }
  return { positions, aSeed };
}

/** Beneath — a near-empty void with a few faint asymptotic glow points
 *  drifting at large radius. Sits below the Planck cutoff: parameters here
 *  cannot be modelled; nature does not exist under this scale. Visually the
 *  lights barely register; the point is the silence. */
export function generateBeneath(count, radius = 30) {
  const positions = new Float32Array(count * 3);
  const aLife     = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = Math.acos(2 * Math.random() - 1);
    const p = Math.random() * TAU;
    const r = radius * (0.6 + Math.random() * 0.4);
    positions[i * 3 + 0] = r * Math.sin(t) * Math.cos(p);
    positions[i * 3 + 1] = r * Math.sin(t) * Math.sin(p);
    positions[i * 3 + 2] = r * Math.cos(t);
    aLife[i] = Math.random();
  }
  return { positions, aLife };
}

/** Beyond — sits OUTSIDE the cosmic web (larger than the universal scale).
 *  Same silent-void aesthetic as Beneath but spread thinner across an even
 *  wider shell, with a few brighter "ghost universes" embedded — distant
 *  cosmic-scale structures that would be inaccessible from inside our own
 *  universe. */
export function generateBeyond(count, radius = 60) {
  const positions = new Float32Array(count * 3);
  const aLife     = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = Math.acos(2 * Math.random() - 1);
    const p = Math.random() * TAU;
    // Distribute across a thicker shell than Beneath — meta-cosmic foam
    // rather than sub-Planck fizz.
    const r = radius * (0.55 + Math.random() * 0.85);
    positions[i * 3 + 0] = r * Math.sin(t) * Math.cos(p);
    positions[i * 3 + 1] = r * Math.sin(t) * Math.sin(p);
    positions[i * 3 + 2] = r * Math.cos(t);
    // ~8% chance of a brighter "ghost universe" speck so the void isn't
    // perfectly uniform — gives the eye a few anchor points.
    aLife[i] = Math.random() < 0.08 ? 0.85 + Math.random() * 0.15 : Math.random() * 0.4;
  }
  return { positions, aLife };
}
