// Voxel post-process — the active fx canvas extruded into a field of 3D
// cubes. Every cell of a coarse grid becomes one block: colour from the
// cell's pixels, height from its brightness, near-black cells dropped so
// they read as void. A slow perspective camera drifts / tilts / orbits
// over the field, so a flat image (camera, video, Hydra, any quale) turns
// into a lit city of blocks with real parallax.
//
// Pipeline per frame (WebGL2, offscreen):
//   1. drawImage(main) → grid-sized staging canvas → texture (one texel
//      per cube — the browser's downscale filter does the cell average)
//   2. SMOOTH  — tiny ping-pong pass at grid res: the cube field eases
//                toward the live frame instead of strobing with video
//                noise (`smooth` = how much of last frame survives)
//   3. CUBES   — ONE instanced draw: a 30-vert open-bottom unit cube ×
//                cols·rows instances. The vertex shader derives (col,row)
//                from gl_InstanceID and texelFetches its colour, so there
//                are no per-instance buffers to upload. Lambert light,
//                darkened face edges (the block "seams"), depth fog to the
//                void colour.
//   4. blit the GL canvas onto the post canvas
//
// Cost is one draw call; the instance count is capped (MAX_CUBES) by
// growing the cell size, and the GL buffer is capped at RENDER_MAX_W so
// it's independent of display DPR. Falls back to a flat Canvas2D block
// mosaic when WebGL2 is unavailable.
//
// Owned by overlay.js: it holds the config object and calls
// render(postCtx, main, W, H, field, config) while the 'voxel' option is on.

import { compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter } from './webgl.js';

const RENDER_MAX_W = 1600;   // GL buffer cap (device px)
const MAX_CUBES    = 48000;  // instance cap — cell grows past this
const VOID_RGB     = [0.020, 0.018, 0.035];
// Tower height (world units, grid is 2 tall) at depth 1 and full white.
const HEIGHT_PER_DEPTH = 0.25;

const SMOOTH_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCurr;
uniform sampler2D uPrev;
uniform float uKeep;
void main() {
  outColor = mix(texture(uCurr, vUv), texture(uPrev, vUv), uKeep);
}
`;

const CUBE_VERT = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;   // unit cube, 0..1
layout(location = 1) in vec3 aNrm;
uniform sampler2D uSrc;
uniform int   uCols;
uniform vec2  uGrid;     // cols, rows
uniform float uCell;     // world size of one cell
uniform float uFoot;     // footprint fraction (1 - gap)
uniform float uDepth;    // tower height at full white (world)
uniform float uMinH;     // floor tile height so every live cell has a face
uniform float uCutoff;   // luminance below which a cell is void
uniform mat4  uViewProj;
out vec3 vColor;
flat out vec3 vNrm;
out vec3 vLocal;         // position inside the cube, world units
flat out vec3 vSize;     // cube extents, world units
out vec3 vWorld;
void main() {
  int col = gl_InstanceID % uCols;
  int row = gl_InstanceID / uCols;
  vec3 c = texelFetch(uSrc, ivec2(col, row), 0).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Dead cells collapse to a point — every triangle degenerates and the
  // rasterizer drops it, leaving the void showing through.
  float alive = step(uCutoff, lum);
  float h = (uMinH + uDepth * lum) * alive;
  float f = uCell * uFoot * alive;
  vec2 centre = vec2((float(col) + 0.5 - uGrid.x * 0.5) * uCell,
                     (uGrid.y * 0.5 - float(row) - 0.5) * uCell);
  vSize  = vec3(f, f, h);
  vLocal = aPos * vSize;
  vec3 p = vec3(centre + (aPos.xy - 0.5) * f, aPos.z * h);
  vWorld = p;
  vNrm   = aNrm;
  vColor = c;
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

const CUBE_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec3 vColor;
flat in vec3 vNrm;
in vec3 vLocal;
flat in vec3 vSize;
in vec3 vWorld;
out vec4 outColor;
uniform vec3  uEye;
uniform vec3  uLight;
uniform vec3  uVoid;
uniform float uEdgeW;
uniform float uFogStart;
uniform float uFogK;
void main() {
  // Distance to the nearest face edge, ignoring the axis the face points
  // along — darkens a thin seam round every face so blocks read as blocks.
  vec3 d = min(vLocal, vSize - vLocal) + abs(vNrm) * 1e3;
  float e = min(d.x, min(d.y, d.z));
  float seam = mix(0.6, 1.0, smoothstep(0.0, uEdgeW, e));
  float diff = max(dot(vNrm, uLight), 0.0);
  vec3 col = vColor * (0.38 + 0.72 * diff) * seam;
  float fog = exp(-max(0.0, distance(vWorld, uEye) - uFogStart) * uFogK);
  outColor = vec4(mix(uVoid, col, fog), 1.0);
}
`;

// Open-bottom unit cube (the z=0 face lies on the image plane and never
// shows): 5 faces × 2 tris, CCW from outside. Interleaved pos + normal.
function buildCube() {
  const faces = [
    // origin,     u,         v          (u × v = outward normal)
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],   // +z — the cap facing the camera
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],   // +x
    [[0, 0, 0], [0, 0, 1], [0, 1, 0]],   // -x
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],   // +y
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]],   // -y
  ];
  const out = [];
  for (const [o, u, v] of faces) {
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const c = [
      o,
      [o[0] + u[0], o[1] + u[1], o[2] + u[2]],
      [o[0] + u[0] + v[0], o[1] + u[1] + v[1], o[2] + u[2] + v[2]],
      [o[0] + v[0], o[1] + v[1], o[2] + v[2]],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) out.push(...c[i], ...n);
  }
  return new Float32Array(out);
}
const CUBE_VERTS = 30;

// ── Allocation-free mat4 helpers (column-major, like GL) ────────────────────
function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) * nf; out[11] = -1;
  out[14] = 2 * far * near * nf;
}
function lookAt(out, ex, ey, ez, tx, ty, tz) {
  // up = +y (pitch is capped well short of the pole)
  let zx = ex - tx, zy = ey - ty, zz = ez - tz;
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  // x = up × z
  let xx = zz, xy = 0, xz = -zx;
  l = Math.hypot(xx, xz) || 1; xx /= l; xz /= l;
  // y = z × x
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
}
function mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                       a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
}

const FOVY = 40 * Math.PI / 180;

export function createVoxelPost() {
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl2', {
    antialias: true, depth: true, stencil: false,
    alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false,
  });
  if (!gl) return createFallback();

  const triVao = makeFullscreenTri(gl);
  const progSmooth = compileProgram(gl, FULLSCREEN_VERT, SMOOTH_FRAG);
  const progCube   = compileProgram(gl, CUBE_VERT, CUBE_FRAG);
  const US = makeUniformGetter(gl, progSmooth);
  const UC = makeUniformGetter(gl, progCube);

  const cubeVao = gl.createVertexArray();
  const cubeBuf = gl.createBuffer();
  gl.bindVertexArray(cubeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, buildCube(), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);

  const srcCanvas = document.createElement('canvas');
  const srcCtx = srcCanvas.getContext('2d');

  let cols = 0, rows = 0, glW = 0, glH = 0;
  let texCurr = null;
  let texSmooth = [null, null], fboSmooth = [null, null], smoothSrc = 0;
  let lastRenderAt = 0;
  let seed = true;           // first frame after (re)start: no easing
  let camT = 0;              // camera clock (speed-scaled, so speed changes don't jump)
  let kick = 0;              // smoothed beat push

  const proj = new Float32Array(16), view = new Float32Array(16), vp = new Float32Array(16);
  // Key light from upper-left-front.
  const L = [-0.45, 0.55, 0.70];
  { const l = Math.hypot(L[0], L[1], L[2]); L[0] /= l; L[1] /= l; L[2] /= l; }

  function makeTex(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function makeFbo(tex) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return f;
  }
  function freeGrid() {
    if (texCurr) gl.deleteTexture(texCurr);
    for (const t of texSmooth) if (t) gl.deleteTexture(t);
    for (const f of fboSmooth) if (f) gl.deleteFramebuffer(f);
    texCurr = null; texSmooth = [null, null]; fboSmooth = [null, null];
  }

  function ensureSize(W, H, cellPx) {
    let cell = Math.max(4, cellPx);
    let c = Math.ceil(W / cell), r = Math.ceil(H / cell);
    if (c * r > MAX_CUBES) {
      cell *= Math.sqrt((c * r) / MAX_CUBES);
      c = Math.ceil(W / cell); r = Math.ceil(H / cell);
    }
    c = Math.max(4, c); r = Math.max(3, r);
    const w = Math.min(RENDER_MAX_W, Math.max(2, W));
    const h = Math.max(2, Math.round(w * H / Math.max(1, W)));
    if (w !== glW || h !== glH) {
      glW = w; glH = h;
      glCanvas.width = glW; glCanvas.height = glH;
    }
    if (c === cols && r === rows) return;
    cols = c; rows = r;
    srcCanvas.width = cols; srcCanvas.height = rows;
    freeGrid();
    texCurr = makeTex(cols, rows);
    texSmooth = [makeTex(cols, rows), makeTex(cols, rows)];
    fboSmooth = [makeFbo(texSmooth[0]), makeFbo(texSmooth[1])];
    seed = true;
  }

  function render(postCtx, main, W, H, field, cfg) {
    ensureSize(W, H, cfg.cellSize);

    const audio = field?.audio;
    const audioOn = !!audio?.spectrum;
    const bass  = audioOn ? audio.bands.bass : 0;
    const beatP = audioOn ? audio.beat.pulse : 0;
    const dt = Math.min(0.05, field?.dt ?? 0.016);
    const react = cfg.react;

    const now = performance.now();
    if (now - lastRenderAt > 300) seed = true;   // was off (blip/flip) — no stale ease
    lastRenderAt = now;

    // 1. Frame → grid texture (one texel per cube).
    srcCtx.globalCompositeOperation = 'copy';
    srcCtx.imageSmoothingEnabled = true;
    srcCtx.imageSmoothingQuality = 'medium';
    try {
      srcCtx.drawImage(main, 0, 0, cols, rows);
    } catch {
      return; // unreadable fx canvas — skip the frame
    }
    gl.bindTexture(gl.TEXTURE_2D, texCurr);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);

    // 2. Ease the cube field toward the live frame.
    const dst = 1 - smoothSrc;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboSmooth[dst]);
    gl.viewport(0, 0, cols, rows);
    gl.useProgram(progSmooth);
    gl.bindVertexArray(triVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texCurr);
    gl.uniform1i(US('uCurr'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texSmooth[smoothSrc]);
    gl.uniform1i(US('uPrev'), 1);
    gl.uniform1f(US('uKeep'), seed ? 0 : Math.min(0.97, Math.max(0, cfg.smooth)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    seed = false;
    smoothSrc = dst;

    // 3. Camera — a slow lissajous drift around a wandering target. `tilt`
    // sets the base pitch (0 = face-on, 1 = a grazing fly-over), `orbit`
    // the swing, `zoom` the push-in; beats kick the dolly.
    camT += dt * cfg.speed;
    kick += (beatP - kick) * Math.min(1, dt * (beatP > kick ? 30 : 4));
    const aspect = glW / glH;
    const orbit = cfg.orbit;
    const yaw   = orbit * 0.65 * Math.sin(camT * 0.31) + orbit * 0.2 * Math.sin(camT * 0.17 + 2.1);
    const pitch = Math.min(1.2, Math.max(0,
      cfg.tilt * 1.13 + orbit * 0.22 * Math.sin(camT * 0.23 + 1.3)));
    const tx = orbit * 0.22 * (W / Math.max(1, H)) * Math.sin(camT * 0.13 + 0.7);
    const ty = orbit * 0.18 * Math.cos(camT * 0.11);
    const depth = cfg.depth * HEIGHT_PER_DEPTH * (1 + react * (bass * 0.6 + beatP * 0.4));
    const tz = depth * 0.35;
    const dist = (1 / Math.tan(FOVY / 2)) / Math.max(0.2, cfg.zoom) *
      (1 - Math.min(0.25, 0.09 * react * kick));
    const cp = Math.cos(pitch);
    const ex = tx + dist * Math.sin(yaw) * cp;
    const ey = ty - dist * Math.sin(pitch);
    const ez = tz + dist * Math.cos(yaw) * cp;
    perspective(proj, FOVY, aspect, 0.02, dist * 6 + 4);
    lookAt(view, ex, ey, ez, tx, ty, tz);
    mul(vp, proj, view);

    // 4. The cubes — one instanced draw.
    const cellW = 2 / rows;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, glW, glH);
    gl.clearColor(VOID_RGB[0], VOID_RGB[1], VOID_RGB[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.useProgram(progCube);
    gl.bindVertexArray(cubeVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texSmooth[smoothSrc]);
    gl.uniform1i(UC('uSrc'), 0);
    gl.uniform1i(UC('uCols'), cols);
    gl.uniform2f(UC('uGrid'), cols, rows);
    gl.uniform1f(UC('uCell'), cellW);
    gl.uniform1f(UC('uFoot'), 1 - Math.min(0.8, Math.max(0, cfg.gap)));
    gl.uniform1f(UC('uDepth'), depth);
    gl.uniform1f(UC('uMinH'), cellW * 0.15);
    gl.uniform1f(UC('uCutoff'), cfg.cutoff);
    gl.uniformMatrix4fv(UC('uViewProj'), false, vp);
    gl.uniform3f(UC('uEye'), ex, ey, ez);
    gl.uniform3f(UC('uLight'), L[0], L[1], L[2]);
    gl.uniform3f(UC('uVoid'), VOID_RGB[0], VOID_RGB[1], VOID_RGB[2]);
    gl.uniform1f(UC('uEdgeW'), cellW * 0.09);
    // Fog: clear out to just past the image plane, then falls off; `fog`
    // 0 = none.
    gl.uniform1f(UC('uFogStart'), dist * 0.85);
    gl.uniform1f(UC('uFogK'), cfg.fog * 1.6 / Math.max(0.3, dist));
    gl.drawArraysInstanced(gl.TRIANGLES, 0, CUBE_VERTS, cols * rows);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    // 5. Blit to the post canvas.
    postCtx.globalCompositeOperation = 'source-over';
    postCtx.globalAlpha = 1;
    postCtx.drawImage(glCanvas, 0, 0, W, H);
  }

  function dispose() {
    freeGrid();
    gl.deleteProgram(progSmooth);
    gl.deleteProgram(progCube);
    gl.deleteBuffer(cubeBuf);
    gl.deleteVertexArray(cubeVao);
    gl.deleteVertexArray(triVao);
    srcCanvas.width = srcCanvas.height = 0;
    glCanvas.width = glCanvas.height = 0;
  }

  return { render, dispose };
}

// ── Canvas2D fallback — flat block mosaic (no WebGL2) ──────────────────────
function createFallback() {
  const src = document.createElement('canvas');
  const sctx = src.getContext('2d');
  function render(postCtx, main, W, H, field, cfg) {
    const cell = Math.max(4, cfg.cellSize);
    const c = Math.max(4, Math.ceil(W / cell)), r = Math.max(3, Math.ceil(H / cell));
    if (src.width !== c || src.height !== r) { src.width = c; src.height = r; }
    try { sctx.drawImage(main, 0, 0, c, r); } catch { return; }
    postCtx.globalCompositeOperation = 'source-over';
    postCtx.globalAlpha = 1;
    postCtx.fillStyle = '#050509';
    postCtx.fillRect(0, 0, W, H);
    const smoothWas = postCtx.imageSmoothingEnabled;
    postCtx.imageSmoothingEnabled = false;
    postCtx.drawImage(src, 0, 0, c * cell, r * cell);
    postCtx.imageSmoothingEnabled = smoothWas;
  }
  function dispose() { src.width = src.height = 0; }
  return { render, dispose };
}
