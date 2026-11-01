// Guards the Scan quale's processing pipeline (src/lib/qualia/scan-cloud.js):
//   node scripts/check-qualia-scan.mjs [path/to/scan.glb|.ply]
//
// Builds synthetic scans in memory — a box standing on a ground slab, the
// whole thing tilted 25° the way phone scans come out — and checks that the
// pipeline parses them, levels the ground back to y = 0, frames the figure
// ~1 unit tall, samples texture colour, and orders the surface distance from
// the top of the figure down. Also covers PLY point clouds, Gaussian-splat
// PLYs (SH colour + opacity filter) and the procedural monolith.
// With a path argument it also runs a real scan and prints its stats.

import { readFileSync } from 'node:fs';
import { loadScan, parseGlb, parsePly, detectFormat } from '../src/lib/qualia/scan-cloud.js';

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
