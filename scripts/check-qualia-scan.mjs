// Guards the Scan quale's processing pipeline (src/lib/qualia/scan-cloud.js):
//   node scripts/check-qualia-scan.mjs [path/to/scan.glb|.ply|.spz]
//
// Builds synthetic scans in memory — a box standing on a ground slab, the
// whole thing tilted 25° the way phone scans come out — and checks that the
// pipeline parses them, levels the ground back to y = 0, frames the figure
// ~1 unit tall, samples texture colour, and orders the surface distance from
// the top of the figure down. Also covers PLY point clouds, Gaussian-splat
// PLYs (SH colour + opacity filter), SPZ, the far "sky shell" cut, splat
// expansion with thin-axis normals, and the procedural monolith.
// With a path argument it also runs a real scan and prints its stats.

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadScan, parseGlb, parsePly, parseSpz, detectFormat } from '../src/lib/qualia/scan-cloud.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── Synthetic geometry ─────────────────────────────────────────────────────
function boxOnSlab(tiltDeg) {
  const pos = [], uv = [], idx = [];
  const quad = (a, b, c, d) => {
    const i = pos.length / 3;
    for (const v of [a, b, c, d]) { pos.push(...v); uv.push(0.25, 0.25); }
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  // Ground slab top (y = 0), 2 × 2 — the dominant plane.
  quad([-1, 0, 1], [1, 0, 1], [1, 0, -1], [-1, 0, -1]);
  // Box 0.3 × 0.6 × 0.3 standing on it (sides + top).
  const w = 0.15, h = 0.6;
  quad([-w, 0, w], [w, 0, w], [w, h, w], [-w, h, w]);
  quad([w, 0, -w], [-w, 0, -w], [-w, h, -w], [w, h, -w]);
  quad([w, 0, w], [w, 0, -w], [w, h, -w], [w, h, w]);
  quad([-w, 0, -w], [-w, 0, w], [-w, h, w], [-w, h, -w]);
  quad([-w, h, w], [w, h, w], [w, h, -w], [-w, h, -w]);
  // Tilt about z.
  const t = tiltDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1];
    pos[i] = c * x - s * y; pos[i + 1] = s * x + c * y;
  }
  return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}

function makeGlb({ pos, uv, idx }, { node = {}, extensionsRequired } = {}) {
  const pad4 = (n) => (n + 3) & ~3;
  const image = new Uint8Array([1, 2, 3, 4]);          // decoded by the stub below
  const parts = [idx, pos, uv, image];
  const views = [];
  let off = 0;
  for (const p of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: p.byteLength }); off = pad4(off + p.byteLength); }
  const bin = new Uint8Array(off);
  parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), views[i].byteOffset));
  const json = {
    asset: { version: '2.0' },
    ...(extensionsRequired ? { extensionsRequired } : {}),
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...node }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, TEXCOORD_0: 2 }, indices: 0, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5125, count: idx.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: pos.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.byteLength }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jl = pad4(jsonBytes.length);
  const jsonPadded = new Uint8Array(jl).fill(0x20); jsonPadded.set(jsonBytes); jsonBytes = jsonPadded;
  const total = 12 + 8 + jl + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4E4F534A, true);
  new Uint8Array(out, 20, jl).set(jsonBytes);
  dv.setUint32(20 + jl, bin.byteLength, true); dv.setUint32(24 + jl, 0x004E4942, true);
  new Uint8Array(out, 28 + jl).set(bin);
  return out;
}

// Texture stub: a 2×2 solid red image (the worker uses createImageBitmap).
const decodeImage = async () => ({ width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]) });

function figureStats(c) {
  let ymin = Infinity, ymax = -Infinity, n = 0, sxy = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < c.count; i++) {
    if (!c.fig[i]) continue;
    const y = c.positions[i * 3 + 1], d = c.dist[i];
    ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    n++; sx += y; sy += d; sxy += y * d; sxx += y * y; syy += d * d;
  }
  const corr = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  let groundAbsY = 0, ng = 0;
  for (let i = 0; i < c.count; i++) if (!c.fig[i]) { groundAbsY += Math.abs(c.positions[i * 3 + 1]); ng++; }
  return { ymin, ymax, corr, groundMeanAbsY: ng ? groundAbsY / ng : 0 };
}

// ── GLB ────────────────────────────────────────────────────────────────────
console.log('scan: GLB (tilted box on slab)');
{
  const glb = makeGlb(boxOnSlab(25));
  check('detects glb', detectFormat(glb) === 'glb');
  const c = await loadScan(glb, 40000, { decodeImage });
  const st = figureStats(c);
  check('finds the ground plane', c.stats.groundFound);
  check('measures the 25° tilt', Math.abs(c.stats.tiltDeg - 25) < 2, `tilt=${c.stats.tiltDeg}`);
  check('ground leveled to y≈0', st.groundMeanAbsY < 0.01, `mean |y|=${st.groundMeanAbsY.toFixed(4)}`);
  check('figure framed ~1 unit tall', st.ymax > 0.9 && st.ymax < 1.1 && st.ymin > -0.01, `y∈[${st.ymin.toFixed(3)}, ${st.ymax.toFixed(3)}]`);
  check('surface distance runs top → bottom', st.corr < -0.8, `corr(y, dist)=${st.corr.toFixed(3)}`);
  check('texture colour sampled', c.colors[0] > 0.99 && c.colors[1] < 0.01 && c.colors[2] < 0.01);
  check('arrays sized to count', c.positions.length === c.count * 3 && c.dist.length === c.count && c.fig.length === c.count);
  check('figure is a minority of points', c.stats.figurePoints > 0 && c.stats.figurePoints < c.count * 0.6);

  const again = await loadScan(glb, 40000, { decodeImage });
  check('deterministic resample', again.count === c.count && again.positions.every((v, i) => v === c.positions[i]));

  // Node transform (translate + uniform scale) must not change the framing.
  const moved = makeGlb(boxOnSlab(25), { node: { translation: [5, -3, 2], scale: [10, 10, 10] } });
  const cm = await loadScan(moved, 40000, { decodeImage });
  const sm = figureStats(cm);
  check('node TRS applied, framing invariant', Math.abs(sm.ymax - st.ymax) < 0.05 && cm.stats.groundFound, `ymax ${sm.ymax.toFixed(3)} vs ${st.ymax.toFixed(3)}`);

  let threw = '';
  try { parseGlb(makeGlb(boxOnSlab(0), { extensionsRequired: ['KHR_draco_mesh_compression'] })); } catch (e) { threw = e.message; }
  check('rejects Draco GLB with a clear error', /Draco/.test(threw), threw);
}

// ── PLY ────────────────────────────────────────────────────────────────────
console.log('scan: PLY');
{
  // ASCII point cloud: a vertical line of points + a ground grid, uchar rgb.
  const rows = [];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) rows.push(`${i / 20 - 1} 0 ${j / 20 - 1} 0 255 0`);
  for (let i = 0; i < 300; i++) rows.push(`0 ${i / 300 * 0.5} 0 255 255 255`);
  const ascii = `ply\nformat ascii 1.0\nelement vertex ${rows.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n${rows.join('\n')}\n`;
  const ab = new TextEncoder().encode(ascii).buffer;
  check('detects ply', detectFormat(ab) === 'ply');
  const p = parsePly(ab);
  check('ascii ply → points with rgb', p.kind === 'points' && p.positions.length === rows.length * 3 && p.colors[1] === 1);
  const c = await loadScan(ab, 100000, {});
  // Smaller than the target → no subsampling; only the far-ground crop (the
  // grid's corners lie beyond 2.2 figure-units) removes points.
  check('point cloud smaller than target is not subsampled', c.count > rows.length * 0.85 && c.count < rows.length && c.stats.figurePoints >= 250,
        `count=${c.count} figure=${c.stats.figurePoints}`);
  check('point cloud ground found', c.stats.groundFound);

  // Binary little-endian splat: f_dc → colour, logit opacity filter.
  const n = 1000;
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0'];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map(k => `property float ${k}`).join('\n')}\nend_header\n`;
  const hb = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(hb.length + n * props.length * 4);
  new Uint8Array(buf).set(hb);
  const dv = new DataView(buf);
  for (let i = 0; i < n; i++) {
    const o = hb.length + i * props.length * 4;
    const vals = [Math.cos(i), (i % 50) / 50, Math.sin(i), 0, 1.7724, -1.7724, i < n / 2 ? 4 : -6, -3];
    vals.forEach((v, k) => dv.setFloat32(o + k * 4, v, true));
  }
  const sp = parsePly(buf);
  check('splat colour from SH DC', Math.abs(sp.colors[0] - 0.5) < 1e-3 && Math.abs(sp.colors[1] - 1) < 1e-3 && sp.colors[2] < 1e-3);
  const cs = await loadScan(buf, 5000, {});
  check('splat drops near-transparent splats', cs.stats.source.kind === 'splat' && cs.count <= n / 2, `count=${cs.count}`);
}

// ── Splat shape: sky shell, expansion, normals, SPZ ────────────────────────
console.log('scan: splat shape + SPZ');
{
  // 2000 flat splats on a ground disc + 800 on a vertical post, oriented so
  // their thin axis is the surface normal; plus a 1500-splat "sky shell" at
  // radius 240 the way Scaniverse exports wrap a scene.
  const pts = [];
  const rng = (() => { let a = 7; return () => ((a = (a * 16807) % 2147483647) / 2147483647); })();
  for (let i = 0; i < 2000; i++) { const r = Math.sqrt(rng()) * 1.0, t = rng() * 6.283; pts.push({ p: [r * Math.cos(t), 0, r * Math.sin(t)], q: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], c: 200 }); }
  for (let i = 0; i < 800; i++) { const t = rng() * 6.283; pts.push({ p: [0.05 * Math.cos(t), rng() * 0.8, 0.05 * Math.sin(t)], q: [0, 0, 0, 1], c: 60 }); }
  for (let i = 0; i < 1500; i++) { const u = rng() * 2 - 1, t = rng() * 6.283, r = Math.sqrt(1 - u * u); pts.push({ p: [240 * r * Math.cos(t), 240 * u, 240 * r * Math.sin(t)], q: [0, 0, 0, 1], c: 128 }); }
  const n = pts.length;

  // SPZ v3 encoder (inverse of parseSpz) → gzip.
  const FRAC = 12, body = new Uint8Array(16 + n * (9 + 1 + 3 + 3 + 4));
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0x5053474e, true); dv.setUint32(4, 3, true); dv.setUint32(8, n, true);
  dv.setUint8(12, 0); dv.setUint8(13, FRAC);
  let o = 16;
  for (const { p } of pts) for (const v of p) { const q = Math.round(v * (1 << FRAC)) & 0xffffff; body[o++] = q & 255; body[o++] = (q >> 8) & 255; body[o++] = (q >> 16) & 255; }
  for (let i = 0; i < n; i++) body[o++] = 230;                                   // alpha ≈ 0.9
  for (const { c } of pts) for (let k = 0; k < 3; k++) body[o++] = c;
  // σ = (0.02, 0.02, 0.002) — thin along local z… except the ground splats,
  // whose quaternion turns local z onto world y.
  for (let i = 0; i < n; i++) { body[o++] = Math.round((Math.log(0.02) + 10) * 16); body[o++] = Math.round((Math.log(0.02) + 10) * 16); body[o++] = Math.round((Math.log(0.002) + 10) * 16); }
  for (const { q } of pts) {
    let largest = 0; for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[largest])) largest = k;
    const sgn = q[largest] < 0 ? -1 : 1;
    let comp = largest;
    for (let k = 0; k < 4; k++) {
      if (k === largest) continue;
      const v = q[k] * sgn;
      comp = (comp << 10) | ((v < 0 ? 1 : 0) << 9) | Math.round(Math.abs(v) / Math.SQRT1_2 * 511);
    }
    comp >>>= 0;
    body[o++] = comp & 255; body[o++] = (comp >>> 8) & 255; body[o++] = (comp >>> 16) & 255; body[o++] = (comp >>> 24) & 255;
  }
  const gz = gzipSync(body);
  const spzBuf = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
  check('detects spz (gzip)', detectFormat(spzBuf) === 'spz');
  const raw = parseSpz(body.buffer);
  check('spz positions decode (24-bit fixed)', Math.abs(raw.positions[2000 * 3 + 1] - pts[2000].p[1]) < 1e-3);
  check('spz colour / alpha / scale decode', Math.abs(raw.colors[2000 * 3] - (0.5 + 0.28209479 * ((60 / 255 - 0.5) / 0.15))) < 1e-4
    && Math.abs(raw.weights[0] - 230 / 255) < 1e-6 && Math.abs(raw.scales[2] - 0.002) < 2e-4);
  check('spz smallest-three rotation decode', Math.abs(raw.rots[0] - Math.SQRT1_2) < 0.01 && Math.abs(raw.rots[3] - Math.SQRT1_2) < 0.01);

  const c = await loadScan(spzBuf, 20000, {});
  let maxR = 0; for (let i = 0; i < c.count; i++) maxR = Math.max(maxR, Math.hypot(c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]));
  check('sky shell stripped', maxR < 3, `max radius ${maxR.toFixed(2)}`);
  check('sparse splats expanded to the target count', c.count > 15000, `count=${c.count}`);
  let up = 0, ng = 0;
  for (let i = 0; i < c.count; i++) if (!c.fig[i]) { ng++; if (Math.abs(c.normals[i * 3 + 1]) > 0.9) up++; }
  check('ground splat normals = thin axis (up)', ng > 0 && up / ng > 0.9, `${up}/${ng}`);
  check('post stands as the figure', c.stats.groundFound && c.stats.figurePoints > 0);
}

// ── Monolith fallback ──────────────────────────────────────────────────────
console.log('scan: monolith');
{
  const c = await loadScan(null, 50000, {});
  const st = figureStats(c);
  check('monolith builds, stands on its ground', c.count > 40000 && c.stats.groundFound && st.ymax > 0.9);
}

// ── Optional: a real scan ──────────────────────────────────────────────────
if (process.argv[2]) {
  const b = readFileSync(process.argv[2]);
  const t0 = performance.now();
  const c = await loadScan(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 200000, {});
  console.log(`scan: ${process.argv[2]} (${(performance.now() - t0).toFixed(0)} ms, no texture decode under node)`);
  console.log('  ', JSON.stringify(c.stats));
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nscan: all checks passed');
