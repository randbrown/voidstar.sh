// Scan cloud — turns a 3D scan file (Polycam & friends) into the point cloud
// the Scan quale (fx/scan.js) renders. Pure functions, no DOM / GL / three:
// it runs inside scan-worker.js (so a 6 MB GLB never blocks the render loop)
// and under node in scripts/check-qualia-scan.mjs.
//
// Pipeline (loadScan):
//   1. PARSE   — GLB (binary glTF 2.0, uncompressed), PLY (ascii / binary;
//                plain point clouds, coloured meshes, and 3D Gaussian-splat
//                exports from Scaniverse / KIRI / Polycam) or SPZ (Niantic's
//                gzipped splat format). → a triangle mesh or a raw point set.
//   2. SAMPLE  — meshes: N points scattered area-uniformly over the triangles,
//                colour from the base-colour texture (or vertex colours), face
//                normal per point. Raw vertices are NOT used — scanner apps
//                decimate flat regions, so vertex density is uneven.
//                Point sets: far "sky shell" / floaters cut first; then a
//                random subset, or — for splats sparser than N — each splat
//                expanded into points drawn from its own Gaussian (normal =
//                its shortest axis; colour from the SH DC term).
//   3. LEVEL   — RANSAC finds the dominant plane (the tabletop / floor),
//                PCA-refines it, and rotates the cloud so it lies on y = 0
//                with the subject above. Scans are rarely exported level.
//   4. FRAME   — points above the plane are the "figure"; the cloud is
//                centred on it and scaled so the figure is ~1 unit tall.
//                Far-off ground is cropped.
//   5. ATTRS   — per-point surface distance from the figure's top (voxel
//                Dijkstra, so a ripple crawls ALONG the surface, not through
//                it), a figure mask, and a random seed for the shader.

const C0 = 0.28209479177387814;  // SH band-0 constant (3DGS colour encoding)

// ── Seeded RNG — deterministic resampling so a reload looks the same ───────
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Format sniffing ────────────────────────────────────────────────────────
export function detectFormat(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (b[0] === 0x67 && b[1] === 0x6C && b[2] === 0x54 && b[3] === 0x46) return 'glb';   // 'glTF'
  if (b[0] === 0x70 && b[1] === 0x6C && b[2] === 0x79) return 'ply';                    // 'ply'
  if (b[0] === 0x1F && b[1] === 0x8B) return 'spz';                                     // gzip
  return null;
}

// ── GLB ────────────────────────────────────────────────────────────────────
const COMP_TYPES = {
  5120: [1, 'getInt8', 127], 5121: [1, 'getUint8', 255],
  5122: [2, 'getInt16', 32767], 5123: [2, 'getUint16', 65535],
  5125: [4, 'getUint32', 4294967295], 5126: [4, 'getFloat32', 1],
};
const TYPE_COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  if (!acc) throw new Error(`glb: missing accessor ${index}`);
  if (acc.bufferView == null) throw new Error('glb: sparse / bufferless accessors not supported');
  const bv = json.bufferViews[acc.bufferView];
  const [size, getter, max] = COMP_TYPES[acc.componentType] || [];
  const comps = TYPE_COMPS[acc.type];
  if (!size || !comps) throw new Error(`glb: unsupported accessor ${acc.componentType}/${acc.type}`);
  const stride = bv.byteStride || size * comps;
  const base = bin.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(bin.buffer);
  const norm = acc.normalized && acc.componentType !== 5126 ? 1 / max : 1;
  const out = new Float32Array(acc.count * comps);
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * stride;
    for (let c = 0; c < comps; c++) out[i * comps + c] = dv[getter](o + c * size, true) * norm;
  }
  return out;
}

// Column-major 4×4 helpers (glTF convention) — just enough for node TRS.
function mat4Identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function mat4Mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Parse a GLB into one merged, world-space triangle mesh plus the first
 *  base-colour texture's encoded image bytes. */
export function parseGlb(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('glb: bad magic');
  if (dv.getUint32(4, true) !== 2) throw new Error('glb: only glTF 2.0 is supported');
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const body = new Uint8Array(buf, off + 8, len);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === 0x004E4942) bin = body;
    off += 8 + len;
  }
  if (!json) throw new Error('glb: no JSON chunk');
  const required = json.extensionsRequired || [];
  if (required.some(e => /draco|meshopt/i.test(e))) {
    throw new Error('glb: compressed (Draco/meshopt) — re-export without mesh compression');
  }
  if (!bin) throw new Error('glb: no binary chunk');

  const pos = [], idx = [], uv = [];
  let vertBase = 0, hasUv = false, material = null;
  const visit = (ni, parent) => {
    const node = json.nodes[ni];
    const m = mat4Mul(parent, nodeMatrix(node));
    if (node.mesh != null) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION == null) continue;
        const p = readAccessor(json, bin, prim.attributes.POSITION);
        const n = p.length / 3;
        for (let i = 0; i < n; i++) {
          const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
          pos.push(m[0] * x + m[4] * y + m[8] * z + m[12],
                   m[1] * x + m[5] * y + m[9] * z + m[13],
                   m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        if (prim.attributes.TEXCOORD_0 != null) {
          const t = readAccessor(json, bin, prim.attributes.TEXCOORD_0);
          for (let i = 0; i < t.length; i++) uv.push(t[i]);
          hasUv = true;
        } else {
          for (let i = 0; i < n * 2; i++) uv.push(0);
        }
        if (prim.indices != null) {
          const ix = readAccessor(json, bin, prim.indices);
          for (let i = 0; i < ix.length; i++) idx.push(ix[i] + vertBase);
        } else {
          for (let i = 0; i < n; i++) idx.push(i + vertBase);
        }
        vertBase += n;
        if (!material && prim.material != null) material = json.materials?.[prim.material] || null;
      }
    }
    for (const c of node.children || []) visit(c, m);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene ? scene.nodes : json.nodes.map((_, i) => i);
  for (const r of roots) visit(r, mat4Identity());
  if (!pos.length) throw new Error('glb: no triangle meshes found');

  const pbr = material?.pbrMetallicRoughness || {};
  const baseColor = (pbr.baseColorFactor || [1, 1, 1, 1]).slice(0, 3);
  let image = null;
  const texIndex = pbr.baseColorTexture?.index;
  if (texIndex != null && hasUv) {
    const img = json.images?.[json.textures?.[texIndex]?.source];
    if (img && img.bufferView != null) {
      const bv = json.bufferViews[img.bufferView];
      image = {
        mime: img.mimeType || 'image/jpeg',
        bytes: bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength),
      };
    }
  }
  return {
    kind: 'mesh',
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    uvs: hasUv ? new Float32Array(uv) : null,
    vcolors: null,
    baseColor,
    image,
  };
}

// ── PLY ────────────────────────────────────────────────────────────────────
const PLY_TYPES = {
  char: [1, 'getInt8'], int8: [1, 'getInt8'], uchar: [1, 'getUint8'], uint8: [1, 'getUint8'],
  short: [2, 'getInt16'], int16: [2, 'getInt16'], ushort: [2, 'getUint16'], uint16: [2, 'getUint16'],
  int: [4, 'getInt32'], int32: [4, 'getInt32'], uint: [4, 'getUint32'], uint32: [4, 'getUint32'],
  float: [4, 'getFloat32'], float32: [4, 'getFloat32'], double: [8, 'getFloat64'], float64: [8, 'getFloat64'],
};
// Only these vertex properties are kept — splat PLYs carry ~60 columns and
// keeping them all for a million splats would cost hundreds of MB.
const KEEP = new Set(['x', 'y', 'z', 'nx', 'ny', 'nz', 'red', 'green', 'blue', 'r', 'g', 'b',
  'diffuse_red', 'diffuse_green', 'diffuse_blue', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']);

/** Parse a PLY into a mesh (if it has faces) or a point set. */
export function parsePly(buf) {
  const bytes = new Uint8Array(buf);
  const probe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const endTag = probe.indexOf('end_header');
  if (endTag < 0) throw new Error('ply: no end_header');
  let bodyStart = endTag + 'end_header'.length;
  while (probe[bodyStart] === '\r' || probe[bodyStart] === '\n') { bodyStart++; if (probe[bodyStart - 1] === '\n') break; }
  bodyStart = new TextEncoder().encode(probe.slice(0, bodyStart)).length;

  let format = 'ascii';
  const elements = [];
  for (const raw of probe.slice(0, endTag).split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: parseInt(t[2], 10), props: [] });
    else if (t[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.props.push({ name: t[4], list: true, countType: t[2], itemType: t[3] });
      else el.props.push({ name: t[2], type: t[1] });
    }
  }

  const cols = {};          // vertex property → Float32Array
  let faces = null;         // flat triangle indices
  const vertexEl = elements.find(e => e.name === 'vertex');
  if (!vertexEl) throw new Error('ply: no vertex element');
  for (const p of vertexEl.props) if (KEEP.has(p.name)) cols[p.name] = new Float32Array(vertexEl.count);

  const pushFace = (list) => { for (let k = 1; k + 1 < list.length; k++) faces.push(list[0], list[k], list[k + 1]); };

  if (format === 'ascii') {
    const text = new TextDecoder().decode(bytes.subarray(bodyStart));
    const tok = text.split(/\s+/).filter(Boolean);
    let ti = 0;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        for (const p of el.props) {
          if (p.list) {
            const n = parseInt(tok[ti++], 10);
            const list = [];
            for (let k = 0; k < n; k++) list.push(parseInt(tok[ti++], 10));
            if (el.name === 'face' && /vertex_ind/.test(p.name)) { faces ||= []; pushFace(list); }
          } else {
            const v = parseFloat(tok[ti++]);
            if (el === vertexEl && cols[p.name]) cols[p.name][i] = v;
          }
        }
      }
    }
  } else {
    const le = format === 'binary_little_endian';
    if (!le && format !== 'binary_big_endian') throw new Error(`ply: unknown format ${format}`);
    const dv = new DataView(buf);
    let o = bodyStart;
    for (const el of elements) {
      const fixed = el.props.every(p => !p.list);
      if (fixed) {
        // Fast path: precomputed column offsets, read only the kept columns.
        let rowSize = 0;
        const reads = [];
        for (const p of el.props) {
          const [size, getter] = PLY_TYPES[p.type] || [];
          if (!size) throw new Error(`ply: unknown type ${p.type}`);
          if (el === vertexEl && cols[p.name]) reads.push([rowSize, getter, cols[p.name]]);
          rowSize += size;
        }
        for (let i = 0; i < el.count; i++, o += rowSize) {
          for (const [ro, getter, arr] of reads) arr[i] = dv[getter](o + ro, le);
        }
      } else {
        for (let i = 0; i < el.count; i++) {
          for (const p of el.props) {
            if (p.list) {
              const [cs, cg] = PLY_TYPES[p.countType];
              const [is, ig] = PLY_TYPES[p.itemType];
              const n = dv[cg](o, le); o += cs;
              const list = new Array(n);
              for (let k = 0; k < n; k++) { list[k] = dv[ig](o, le); o += is; }
              if (el.name === 'face' && /vertex_ind/.test(p.name)) { faces ||= []; pushFace(list); }
            } else {
              const [size, getter] = PLY_TYPES[p.type];
              if (el === vertexEl && cols[p.name]) cols[p.name][i] = dv[getter](o, le);
              o += size;
            }
          }
        }
      }
    }
  }

  const n = vertexEl.count;
  if (!cols.x || !cols.y || !cols.z) throw new Error('ply: vertices have no x/y/z');
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { positions[i * 3] = cols.x[i]; positions[i * 3 + 1] = cols.y[i]; positions[i * 3 + 2] = cols.z[i]; }

  // Colour: 3DGS SH DC term → rgb; else 8/16-bit or float rgb; else grey.
  const colors = new Float32Array(n * 3).fill(0.7);
  const isSplat = !!cols.f_dc_0;
  const rgbProps = ['red', 'green', 'blue'].find(k => cols[k]) ? ['red', 'green', 'blue']
    : cols.diffuse_red ? ['diffuse_red', 'diffuse_green', 'diffuse_blue']
    : cols.r ? ['r', 'g', 'b'] : null;
  if (isSplat) {
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
      colors[i * 3 + c] = Math.min(1, Math.max(0, 0.5 + C0 * cols[`f_dc_${c}`][i]));
    }
  } else if (rgbProps) {
    const t = vertexEl.props.find(p => p.name === rgbProps[0])?.type || 'uchar';
    const scale = /short|16/.test(t) ? 1 / 65535 : /float|double/.test(t) ? 1 : 1 / 255;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) colors[i * 3 + c] = cols[rgbProps[c]][i] * scale;
  }

  // 3DGS exports carry nx/ny/nz columns that are all zero — treat those as
  // "no normals" rather than handing the shader zero vectors.
  let normals = null;
  if (cols.nx && cols.ny && cols.nz) {
    normals = new Float32Array(n * 3);
    let any = false;
    for (let i = 0; i < n; i++) {
      normals[i * 3] = cols.nx[i]; normals[i * 3 + 1] = cols.ny[i]; normals[i * 3 + 2] = cols.nz[i];
      if (!any && (cols.nx[i] || cols.ny[i] || cols.nz[i])) any = true;
    }
    if (!any) normals = null;
  }
  // Splat opacity is stored as a logit, scale as log σ, rotation as (w,x,y,z).
  let weights = null, scales = null, rots = null;
  if (isSplat && cols.opacity) {
    weights = new Float32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 / (1 + Math.exp(-cols.opacity[i]));
  }
  if (isSplat && cols.scale_0 && cols.scale_1 && cols.scale_2 && cols.rot_0) {
    scales = new Float32Array(n * 3);
    rots = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      scales[i * 3] = Math.exp(cols.scale_0[i]); scales[i * 3 + 1] = Math.exp(cols.scale_1[i]); scales[i * 3 + 2] = Math.exp(cols.scale_2[i]);
      rots[i * 4] = cols.rot_1[i]; rots[i * 4 + 1] = cols.rot_2[i]; rots[i * 4 + 2] = cols.rot_3[i]; rots[i * 4 + 3] = cols.rot_0[i];
    }
  }

  if (faces && faces.length) {
    return { kind: 'mesh', positions, indices: new Uint32Array(faces), uvs: null, vcolors: colors, baseColor: [1, 1, 1], image: null };
  }
  return { kind: 'points', positions, colors, normals, weights, scales, rots, splat: isSplat };
}

// ── SPZ (Niantic's compressed Gaussian-splat format, Scaniverse export) ────
// gzip → 16-byte header → column blocks: positions (24-bit fixed), alphas,
// colours, scales, rotations, SH. Only what the quale needs is decoded.
const SPZ_MAGIC = 0x5053474e;   // 'NGSP'
const SPZ_COLOR_SCALE = 0.15;

async function gunzip(buf) {
  if (typeof DecompressionStream !== 'function') throw new Error('spz: this browser cannot decompress gzip');
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

/** Parse a decompressed SPZ payload into a splat point set. */
export function parseSpz(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== SPZ_MAGIC) throw new Error('spz: bad magic');
  const version = dv.getUint32(4, true);
  if (version < 1 || version > 3) throw new Error(`spz: unsupported version ${version}`);
  const n = dv.getUint32(8, true);
  const fracBits = dv.getUint8(13);
  const b = new Uint8Array(buf);
  let o = 16;
  const positions = new Float32Array(n * 3);
  if (version === 1) {
    // v1: float16 positions.
    for (let i = 0; i < n * 3; i++, o += 2) positions[i] = halfToFloat(dv.getUint16(o, true));
  } else {
    const k = 1 / (1 << fracBits);
    for (let i = 0; i < n * 3; i++, o += 3) {
      let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
      if (v & 0x800000) v |= ~0xffffff;           // sign-extend 24 → 32 bits
      positions[i] = v * k;
    }
  }
  const weights = new Float32Array(n);
  for (let i = 0; i < n; i++) weights[i] = b[o++] / 255;          // already sigmoid(opacity)
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    const dc = (b[o++] / 255 - 0.5) / SPZ_COLOR_SCALE;
    colors[i] = Math.min(1, Math.max(0, 0.5 + C0 * dc));
  }
  const scales = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) scales[i] = Math.exp(b[o++] / 16 - 10);
  const rots = new Float32Array(n * 4);                             // (x, y, z, w)
  if (version >= 3) {
    // Smallest-three: 2-bit index of the largest component, then three
    // (sign + 9-bit magnitude) components, packed from the top of the word.
    const MASK = 511;
    for (let i = 0; i < n; i++, o += 4) {
      let comp = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
      const largest = comp >>> 30;
      let sum = 0;
      for (let c = 3; c >= 0; c--) {
        if (c === largest) continue;
        const mag = comp & MASK, neg = (comp >>> 9) & 1;
        comp >>>= 10;
        const v = Math.SQRT1_2 * mag / MASK * (neg ? -1 : 1);
        rots[i * 4 + c] = v; sum += v * v;
      }
      rots[i * 4 + largest] = Math.sqrt(Math.max(0, 1 - sum));
    }
  } else {
    for (let i = 0; i < n; i++, o += 3) {
      const x = b[o] / 127.5 - 1, y = b[o + 1] / 127.5 - 1, z = b[o + 2] / 127.5 - 1;
      rots[i * 4] = x; rots[i * 4 + 1] = y; rots[i * 4 + 2] = z;
      rots[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    }
  }
  return { kind: 'points', positions, colors, normals: null, weights, scales, rots, splat: true };
}

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

// ── Procedural fallback — a 2001-style monolith on a ground disc ───────────
// Shown when no scan is loaded, and run through the exact same pipeline so
// every mode works on it.
export function monolithMesh() {
  const pos = [], col = [], idx = [];
  const quad = (a, b, c, d, rgb) => {
    const i = pos.length / 3;
    for (const v of [a, b, c, d]) { pos.push(...v); col.push(...rgb); }
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  // 1 : 4 : 9 slab.
  const w = 0.2, d = 0.05, h = 0.9, slab = [0.30, 0.28, 0.38];
  quad([-w, 0, d], [w, 0, d], [w, h, d], [-w, h, d], slab);
  quad([w, 0, -d], [-w, 0, -d], [-w, h, -d], [w, h, -d], slab);
  quad([w, 0, d], [w, 0, -d], [w, h, -d], [w, h, d], slab);
  quad([-w, 0, -d], [-w, 0, d], [-w, h, d], [-w, h, -d], slab);
  quad([-w, h, d], [w, h, d], [w, h, -d], [-w, h, -d], slab);
  // Ground disc as a fan with a radial colour falloff.
  const R = 2.0, seg = 64, rings = 8;
  for (let r = 0; r < rings; r++) {
    const r0 = (r / rings) * R, r1 = ((r + 1) / rings) * R;
    const c0 = 0.22 * (1 - r / rings), c1 = 0.22 * (1 - (r + 1) / rings);
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      const i = pos.length / 3;
      pos.push(Math.cos(a0) * r0, 0, Math.sin(a0) * r0, Math.cos(a1) * r0, 0, Math.sin(a1) * r0,
               Math.cos(a1) * r1, 0, Math.sin(a1) * r1, Math.cos(a0) * r1, 0, Math.sin(a0) * r1);
      col.push(c0 * 0.9, c0 * 0.85, c0 * 1.2, c0 * 0.9, c0 * 0.85, c0 * 1.2,
               c1 * 0.9, c1 * 0.85, c1 * 1.2, c1 * 0.9, c1 * 0.85, c1 * 1.2);
      idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
    }
  }
  return { kind: 'mesh', positions: new Float32Array(pos), indices: new Uint32Array(idx), uvs: null,
    vcolors: new Float32Array(col), baseColor: [1, 1, 1], image: null };
}

// ── Sampling ───────────────────────────────────────────────────────────────

/** Area-uniform surface sampling. `texture` is {width, height, data:RGBA}
 *  or null. Returns {count, positions, colors, normals}. */
export function sampleMesh(mesh, count, texture, rng) {
  const P = mesh.positions, I = mesh.indices, T = I.length / 3;
  const cdf = new Float64Array(T);
  const fn = new Float32Array(T * 3);
  let total = 0;
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) { fn[t * 3] = nx / len; fn[t * 3 + 1] = ny / len; fn[t * 3 + 2] = nz / len; }
    total += len * 0.5;
    cdf[t] = total;
  }
  if (!(total > 0)) throw new Error('mesh has no area');

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const UV = mesh.uvs, VC = mesh.vcolors, base = mesh.baseColor || [1, 1, 1];
  const tex = UV && texture ? texture : null;
  for (let i = 0; i < count; i++) {
    const r = rng() * total;
    let lo = 0, hi = T - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    const t = lo;
    const ia = I[t * 3], ib = I[t * 3 + 1], ic = I[t * 3 + 2];
    const s = Math.sqrt(rng()), q = rng();
    const wa = 1 - s, wb = s * (1 - q), wc = s * q;
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = P[ia * 3 + k] * wa + P[ib * 3 + k] * wb + P[ic * 3 + k] * wc;
      normals[i * 3 + k] = fn[t * 3 + k];
    }
    if (tex) {
      let u = UV[ia * 2] * wa + UV[ib * 2] * wb + UV[ic * 2] * wc;
      let v = UV[ia * 2 + 1] * wa + UV[ib * 2 + 1] * wb + UV[ic * 2 + 1] * wc;
      u -= Math.floor(u); v -= Math.floor(v);                  // REPEAT wrap
      const px = Math.min(tex.width - 1, (u * tex.width) | 0);
      const py = Math.min(tex.height - 1, (v * tex.height) | 0);  // glTF uv origin = image top-left
      const o = (py * tex.width + px) * 4;
      colors[i * 3] = tex.data[o] / 255 * base[0];
      colors[i * 3 + 1] = tex.data[o + 1] / 255 * base[1];
      colors[i * 3 + 2] = tex.data[o + 2] / 255 * base[2];
    } else if (VC) {
      for (let k = 0; k < 3; k++) colors[i * 3 + k] = VC[ia * 3 + k] * wa + VC[ib * 3 + k] * wb + VC[ic * 3 + k] * wc;
    } else {
      colors[i * 3] = base[0] * 0.7; colors[i * 3 + 1] = base[1] * 0.7; colors[i * 3 + 2] = base[2] * 0.7;
    }
  }
  return { count, positions, colors, normals };
}

// Rotation matrix (row-major 3×3) of splat s from its (x,y,z,w) quaternion.
function splatRotation(rots, s, R) {
  let x = rots[s * 4], y = rots[s * 4 + 1], z = rots[s * 4 + 2], w = rots[s * 4 + 3];
  const l = Math.hypot(x, y, z, w) || 1;
  x /= l; y /= l; z /= l; w /= l;
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w);     R[2] = 2 * (x * z + y * w);
  R[3] = 2 * (x * y + z * w);     R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
  R[6] = 2 * (x * z - y * w);     R[7] = 2 * (y * z + x * w);     R[8] = 1 - 2 * (x * x + y * y);
}

// A trained splat is a flattened disc lying ON the surface, so its shortest
// axis is the surface normal — real normals for free.
function splatNormal(cloud, s, R, out, o) {
  const sc = cloud.scales;
  let a = 0;
  if (sc[s * 3 + 1] < sc[s * 3 + a]) a = 1;
  if (sc[s * 3 + 2] < sc[s * 3 + a]) a = 2;
  out[o] = R[a]; out[o + 1] = R[3 + a]; out[o + 2] = R[6 + a];
}

/** Indices of the dense core of a point set. Scaniverse wraps splat scenes
 *  in a "sky" shell of background splats hundreds of units out; anything
 *  past the first big jump in sorted distance from the median centre goes.
 *  Returns the kept pool and the core's 95th-percentile radius. */
function coreOf(P, pool, m) {
  const axis = (k) => {
    const a = new Float32Array(m);
    for (let i = 0; i < m; i++) a[i] = P[pool[i] * 3 + k];
    return a.sort()[m >> 1];
  };
  const cx = axis(0), cy = axis(1), cz = axis(2);
  const d = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const s = pool[i] * 3;
    d[i] = Math.hypot(P[s] - cx, P[s + 1] - cy, P[s + 2] - cz);
  }
  const sorted = Float32Array.from(d).sort();
  let cut = Infinity;
  for (let i = Math.floor(m * 0.1); i < m - 1; i++) {
    if (sorted[i + 1] > 4 * sorted[i] && sorted[i + 1] - sorted[i] > 1e-6) { cut = sorted[i]; break; }
  }
  let k = 0;
  for (let i = 0; i < m; i++) if (d[i] <= cut) pool[k++] = pool[i];
  return { pool: pool.subarray(0, k), m: k, radius: sorted[Math.floor(Math.min(k - 1, k * 0.95))] || 1 };
}

/** Points from a point set: a random subset when there are more than
 *  `count`; for splats with fewer, each splat is expanded into several points
 *  drawn from its own Gaussian (so a 30k-splat capture still fills a 200k
 *  cloud, dense where the splats are opaque and broad). */
export function samplePoints(cloud, count, rng) {
  const n = cloud.positions.length / 3;
  let pool = new Uint32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) if (!cloud.weights || cloud.weights[i] > 0.15) pool[m++] = i;
  let radius;
  ({ pool, m, radius } = coreOf(cloud.positions, pool.subarray(0, m), m));
  const shaped = !!(cloud.splat && cloud.scales && cloud.rots);
  const R = new Float32Array(9);

  if (shaped && m < count) {
    // Clamp σ so the few huge haze splats don't spray points everywhere.
    const sigMax = radius * 0.03;
    const cdf = new Float64Array(m);
    let total = 0;
    for (let i = 0; i < m; i++) {
      const s = pool[i];
      const a = Math.min(sigMax, cloud.scales[s * 3]), b = Math.min(sigMax, cloud.scales[s * 3 + 1]), c = Math.min(sigMax, cloud.scales[s * 3 + 2]);
      total += (cloud.weights ? cloud.weights[s] : 1) * (a * b + b * c + a * c) + 1e-12;
      cdf[i] = total;
    }
    const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), normals = new Float32Array(count * 3);
    const g = () => {                                   // N(0,1), clamped to ±2σ
      const v = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
      return Math.max(-2, Math.min(2, v));
    };
    for (let i = 0; i < count; i++) {
      const r = rng() * total;
      let lo = 0, hi = m - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
      const s = pool[lo];
      splatRotation(cloud.rots, s, R);
      const lx = Math.min(sigMax, cloud.scales[s * 3]) * g();
      const ly = Math.min(sigMax, cloud.scales[s * 3 + 1]) * g();
      const lz = Math.min(sigMax, cloud.scales[s * 3 + 2]) * g();
      for (let c = 0; c < 3; c++) {
        positions[i * 3 + c] = cloud.positions[s * 3 + c] + R[c * 3] * lx + R[c * 3 + 1] * ly + R[c * 3 + 2] * lz;
        colors[i * 3 + c] = cloud.colors[s * 3 + c];
      }
      splatNormal(cloud, s, R, normals, i * 3);
    }
    return { count, positions, colors, normals };
  }

  const k = Math.min(count, m);
  for (let i = 0; i < k; i++) {                 // partial Fisher–Yates
    const j = i + Math.floor(rng() * (m - i));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  const positions = new Float32Array(k * 3), colors = new Float32Array(k * 3);
  const normals = cloud.normals || shaped ? new Float32Array(k * 3) : null;
  for (let i = 0; i < k; i++) {
    const s = pool[i];
    for (let c = 0; c < 3; c++) {
      positions[i * 3 + c] = cloud.positions[s * 3 + c];
      colors[i * 3 + c] = cloud.colors[s * 3 + c];
      if (cloud.normals) normals[i * 3 + c] = cloud.normals[s * 3 + c];
    }
    if (shaped && !cloud.normals) { splatRotation(cloud.rots, s, R); splatNormal(cloud, s, R, normals, i * 3); }
  }
  return { count: k, positions, colors, normals };
}

// ── Leveling ───────────────────────────────────────────────────────────────

// Smallest-eigenvalue eigenvector of a symmetric 3×3 (cyclic Jacobi).
function smallestEigenvector(m) {
  const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best]];
}

/** RANSAC the dominant plane. Planes facing ±y (glTF is y-up) get a mild
 *  preference so a big wall in a room scan doesn't beat the floor.
 *  Returns {normal, d, inlierFrac} or null. */
export function findGroundPlane(P, count, eps, rng) {
  const S = Math.min(count, 4000);
  const sample = new Uint32Array(S);
  for (let i = 0; i < S; i++) sample[i] = Math.floor(rng() * count);
  let best = null, bestScore = 0;
  for (let it = 0; it < 400; it++) {
    const a = sample[Math.floor(rng() * S)] * 3, b = sample[Math.floor(rng() * S)] * 3, c = sample[Math.floor(rng() * S)] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len; ny /= len; nz /= len;
    const d = -(nx * P[a] + ny * P[a + 1] + nz * P[a + 2]);
    let inl = 0;
    for (let i = 0; i < S; i++) {
      const s = sample[i] * 3;
      if (Math.abs(nx * P[s] + ny * P[s + 1] + nz * P[s + 2] + d) < eps) inl++;
    }
    const score = inl * (1 + 0.5 * Math.abs(ny));
    if (score > bestScore) { bestScore = score; best = { normal: [nx, ny, nz], d, inl }; }
  }
  if (!best || best.inl / S < 0.15) return null;

  // PCA refine over every inlier of the best hypothesis.
  const [bx, by, bz] = best.normal;
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (let i = 0; i < count; i++) {
    const s = i * 3;
    if (Math.abs(bx * P[s] + by * P[s + 1] + bz * P[s + 2] + best.d) < eps) { cx += P[s]; cy += P[s + 1]; cz += P[s + 2]; n++; }
  }
  cx /= n; cy /= n; cz /= n;
  const cov = [0, 0, 0, 0, 0, 0];   // xx xy xz yy yz zz
  for (let i = 0; i < count; i++) {
    const s = i * 3;
    if (Math.abs(bx * P[s] + by * P[s + 1] + bz * P[s + 2] + best.d) >= eps) continue;
    const x = P[s] - cx, y = P[s + 1] - cy, z = P[s + 2] - cz;
    cov[0] += x * x; cov[1] += x * y; cov[2] += x * z; cov[3] += y * y; cov[4] += y * z; cov[5] += z * z;
  }
  let normal = smallestEigenvector(cov);
  const len = Math.hypot(...normal);
  normal = normal.map(v => v / len);
  if (normal[0] * bx + normal[1] * by + normal[2] * bz < 0) normal = normal.map(v => -v);
  const d = -(normal[0] * cx + normal[1] * cy + normal[2] * cz);

  // Orient so the bulk of the off-plane points (the subject) is on +normal.
  let above = 0, below = 0;
  for (let i = 0; i < count; i++) {
    const s = i * 3;
    const h = normal[0] * P[s] + normal[1] * P[s + 1] + normal[2] * P[s + 2] + d;
    if (h > 2 * eps) above++; else if (h < -2 * eps) below++;
  }
  if (below > above) return { normal: normal.map(v => -v), d: -d, inlierFrac: best.inl / S };
  return { normal, d, inlierFrac: best.inl / S };
}

// Rotation taking unit vector n onto +y (Rodrigues), as a row-major 3×3.
function rotationToY(n) {
  const [nx, ny, nz] = n;
  // Axis a = n × ŷ = (−nz, 0, nx); |a| = sin θ, n·ŷ = cos θ.
  const ax = -nz, ay = 0, az = nx;
  const s = Math.hypot(ax, ay, az), c = ny;
  if (s < 1e-9) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const k = (1 - c) / (s * s);
  // R = I + [a]× + [a]×² · k
  const K = [0, -az, ay, az, 0, -ax, -ay, ax, 0];
  const K2 = [
    -(az * az + ay * ay), ax * ay, ax * az,
    ax * ay, -(az * az + ax * ax), ay * az,
    ax * az, ay * az, -(ay * ay + ax * ax),
  ];
  const R = new Array(9);
  for (let i = 0; i < 9; i++) R[i] = (i % 4 === 0 ? 1 : 0) + K[i] + K2[i] * k;
  return R;
}

function percentile(arr, n, q) {
  if (!n) return 0;
  const a = Float32Array.from(arr.subarray(0, n)).sort();
  return a[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
}

// ── Surface distance (voxel Dijkstra over the figure) ──────────────────────
function surfaceDistance(P, fig, count, out) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let seed = -1, seedY = -Infinity, nFig = 0;
  for (let i = 0; i < count; i++) {
    if (!fig[i]) continue;
    nFig++;
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    // Seed = highest point that isn't a lone floater above the figure (≤ 1.02).
    if (y > seedY && y <= 1.02) { seedY = y; seed = i; }
  }
  if (!nFig || seed < 0) return;
  const cell = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 72 || 1;
  const PAD = 2;
  const nx = Math.ceil((maxX - minX) / cell) + 2 * PAD + 1;
  const ny = Math.ceil((maxY - minY) / cell) + 2 * PAD + 1;
  const nz = Math.ceil((maxZ - minZ) / cell) + 2 * PAD + 1;
  const cellOf = (i) => {
    const x = Math.floor((P[i * 3] - minX) / cell) + PAD;
    const y = Math.floor((P[i * 3 + 1] - minY) / cell) + PAD;
    const z = Math.floor((P[i * 3 + 2] - minZ) / cell) + PAD;
    return (z * ny + y) * nx + x;
  };
  const N = nx * ny * nz;
  const occ0 = new Uint8Array(N);
  for (let i = 0; i < count; i++) if (fig[i]) occ0[cellOf(i)] = 1;

  // 26-neighbourhood with integer weights ≈ 10·{1, √2, √3}.
  const nbr = [], wts = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const k = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    if (!k) continue;
    nbr.push((dz * ny + dy) * nx + dx);
    wts.push(k === 1 ? 10 : k === 2 ? 14 : 17);
  }
  // Dilate once so small scan holes don't split the surface into islands.
  const occ = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (!occ0[c]) continue;
    occ[c] = 1;
    for (let k = 0; k < 26; k++) occ[c + nbr[k]] = 1;
  }

  const INF = 0x3fffffff;
  const dist = new Int32Array(N).fill(INF);
  const s0 = cellOf(seed);
  dist[s0] = 0;
  const buckets = [[s0]];
  for (let d = 0; d < buckets.length; d++) {
    const b = buckets[d];
    if (!b) continue;
    for (let j = 0; j < b.length; j++) {
      const c = b[j];
      if (dist[c] !== d) continue;
      for (let k = 0; k < 26; k++) {
        const nc = c + nbr[k];
        if (!occ[nc]) continue;
        const nd = d + wts[k];
        if (nd < dist[nc]) { dist[nc] = nd; (buckets[nd] ||= []).push(nc); }
      }
    }
    buckets[d] = null;
  }

  // Islands the dilation couldn't bridge fall back to straight-line distance.
  const sx = P[seed * 3], sy = P[seed * 3 + 1], sz = P[seed * 3 + 2];
  let maxD = 0;
  for (let i = 0; i < count; i++) {
    if (!fig[i]) continue;
    let d = dist[cellOf(i)];
    if (d >= INF) d = Math.hypot(P[i * 3] - sx, P[i * 3 + 1] - sy, P[i * 3 + 2] - sz) / cell * 10;
    out[i] = d;
    if (d > maxD) maxD = d;
  }
  for (let i = 0; i < count; i++) if (fig[i]) out[i] = maxD > 0 ? out[i] / maxD : 0;
}

/** Level, frame, crop and annotate a sampled cloud. */
export function buildCloud(sampled, { rng, groundRadius = 2.2 } = {}) {
  let { count, positions: P, colors: C, normals: Nm } = sampled;
  rng ||= mulberry32(1);

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const eps = diag * 0.006;

  // 1. Level on the dominant plane (if there is one).
  const plane = findGroundPlane(P, count, eps, rng);
  const height = new Float32Array(count);
  let tiltDeg = 0;
  if (plane) {
    const R = rotationToY(plane.normal);
    tiltDeg = Math.acos(Math.min(1, Math.abs(plane.normal[1]))) * 180 / Math.PI;
    for (let i = 0; i < count; i++) {
      const s = i * 3;
      const x = P[s], y = P[s + 1], z = P[s + 2];
      height[i] = plane.normal[0] * x + plane.normal[1] * y + plane.normal[2] * z + plane.d;
      P[s] = R[0] * x + R[1] * y + R[2] * z;
      P[s + 2] = R[6] * x + R[7] * y + R[8] * z;
      P[s + 1] = height[i];
      if (Nm) {
        const a = Nm[s], b = Nm[s + 1], c = Nm[s + 2];
        Nm[s] = R[0] * a + R[1] * b + R[2] * c;
        Nm[s + 1] = R[3] * a + R[4] * b + R[5] * c;
        Nm[s + 2] = R[6] * a + R[7] * b + R[8] * c;
      }
    }
  } else {
    const floor = percentile(new Float32Array(Array.from({ length: count }, (_, i) => P[i * 3 + 1])), count, 0.01);
    for (let i = 0; i < count; i++) { P[i * 3 + 1] -= floor; height[i] = P[i * 3 + 1]; }
  }

  // 2. Figure = what stands above the plane. Without a plane (or a near-empty
  //    figure) the whole cloud is the figure.
  let fig = new Uint8Array(count);
  let nFig = 0;
  if (plane) for (let i = 0; i < count; i++) if (height[i] > 2 * eps) { fig[i] = 1; nFig++; }
  const hasGround = !!plane && nFig >= count * 0.02;
  if (!hasGround) { fig.fill(1); nFig = count; }

  // 3. Centre on the figure (median x/z) and scale it to ~1 unit tall.
  const fx = new Float32Array(nFig), fz = new Float32Array(nFig), fy = new Float32Array(nFig);
  for (let i = 0, j = 0; i < count; i++) if (fig[i]) { fx[j] = P[i * 3]; fy[j] = P[i * 3 + 1]; fz[j] = P[i * 3 + 2]; j++; }
  const cx = percentile(fx, nFig, 0.5), cz = percentile(fz, nFig, 0.5);
  const y0 = hasGround ? 0 : percentile(fy, nFig, 0.01);
  const h98 = percentile(fy, nFig, 0.98) - y0;
  const rr = new Float32Array(nFig);
  for (let j = 0; j < nFig; j++) rr[j] = Math.hypot(fx[j] - cx, fz[j] - cz);
  const r95 = percentile(rr, nFig, 0.95);
  const scale = 1 / (Math.max(h98, 2 * r95) || 1);
  for (let i = 0; i < count; i++) {
    P[i * 3] = (P[i * 3] - cx) * scale;
    P[i * 3 + 1] = (P[i * 3 + 1] - y0) * scale;
    P[i * 3 + 2] = (P[i * 3 + 2] - cz) * scale;
  }
  const figHeight = h98 * scale;

  // 4. Crop far ground; compact in place.
  let k = 0;
  for (let i = 0; i < count; i++) {
    if (!fig[i] && Math.hypot(P[i * 3], P[i * 3 + 2]) > groundRadius) continue;
    if (k !== i) {
      for (let c = 0; c < 3; c++) {
        P[k * 3 + c] = P[i * 3 + c]; C[k * 3 + c] = C[i * 3 + c];
        if (Nm) Nm[k * 3 + c] = Nm[i * 3 + c];
      }
      fig[k] = fig[i];
    }
    k++;
  }
  count = k;
  P = P.subarray(0, count * 3); C = C.subarray(0, count * 3);
  if (Nm) Nm = Nm.subarray(0, count * 3);
  fig = fig.subarray(0, count);

  // 5. Normals: ground faces up; figure normals face away from its axis
  //    (scan winding isn't reliable, and point clouds may have none).
  const normals = Nm || new Float32Array(count * 3);
  const midY = figHeight * 0.5;
  for (let i = 0; i < count; i++) {
    const s = i * 3;
    if (!fig[i]) { normals[s] = 0; normals[s + 1] = 1; normals[s + 2] = 0; continue; }
    const ox = P[s], oy = P[s + 1] - midY, oz = P[s + 2];
    if (!Nm) {
      const l = Math.hypot(ox, oy, oz) || 1;
      normals[s] = ox / l; normals[s + 1] = oy / l; normals[s + 2] = oz / l;
    } else if (normals[s] * ox + normals[s + 1] * oy + normals[s + 2] * oz < 0) {
      normals[s] = -normals[s]; normals[s + 1] = -normals[s + 1]; normals[s + 2] = -normals[s + 2];
    }
  }

  // 6. Per-point attributes.
  const dist = new Float32Array(count);
  surfaceDistance(P, fig, count, dist);
  const figF = new Float32Array(count);
  const rand = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    figF[i] = fig[i];
    rand[i] = rng();
    // Ground continues the figure's ripple outward as expanding rings.
    if (!fig[i]) dist[i] = 1 + Math.hypot(P[i * 3], P[i * 3 + 2]) * 0.6;
  }

  return {
    count,
    positions: P.slice(), colors: C.slice(), normals: normals.slice(0, count * 3),
    dist, fig: figF, rand,
    stats: {
      count, figurePoints: fig.reduce((a, b) => a + b, 0), groundFound: hasGround,
      groundInlierFrac: plane ? +plane.inlierFrac.toFixed(3) : 0, tiltDeg: +tiltDeg.toFixed(1),
      figHeight: +figHeight.toFixed(3),
    },
  };
}

/**
 * Full pipeline: file bytes → render-ready cloud.
 * @param {ArrayBuffer|null} buf    scan file, or null for the procedural monolith
 * @param {number} count            target point count
 * @param {{decodeImage?: (bytes: Uint8Array, mime: string) => Promise<{width:number,height:number,data:Uint8ClampedArray}|null>, seed?: number}} opts
 */
export async function loadScan(buf, count, { decodeImage, seed = 1337 } = {}) {
  const rng = mulberry32(seed);
  let src;
  if (!buf) src = monolithMesh();
  else {
    const fmt = detectFormat(buf);
    if (fmt === 'glb') src = parseGlb(buf);
    else if (fmt === 'ply') src = parsePly(buf);
    else if (fmt === 'spz') src = parseSpz(await gunzip(buf));
    else throw new Error('unrecognised scan format — expected .glb, .ply or .spz');
  }
  let sampled;
  let source;
  if (src.kind === 'mesh') {
    let texture = null;
    if (src.image && decodeImage) {
      try { texture = await decodeImage(src.image.bytes, src.image.mime); }
      catch (e) { texture = null; }
    }
    sampled = sampleMesh(src, count, texture, rng);
    source = { kind: 'mesh', verts: src.positions.length / 3, tris: src.indices.length / 3, textured: !!texture };
  } else {
    sampled = samplePoints(src, count, rng);
    source = { kind: src.splat ? 'splat' : 'points', verts: src.positions.length / 3 };
  }
  const cloud = buildCloud(sampled, { rng });
  cloud.stats.source = source;
  return cloud;
}
