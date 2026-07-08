// Data-mosh post-process — a real-time emulation of compressed-video
// glitch (I-frame removal / P-frame duplication), not just a feedback
// smear. The classic offline technique corrupts the codec so motion
// vectors keep warping a stale reference frame; we reproduce that with
// an actual motion-estimation → advection loop on the GPU:
//
//   1. FLOW    — per-macroblock motion estimation between the previous
//                and current fx frames (three-step diamond search, 5-tap
//                SAD per candidate) into a coarse flow texture.
//   2. ADVECT  — a persistent "mosh" buffer is dragged along the motion
//                vectors (this is the melt: moving content smears stale
//                pixels around, block-quantized like macroblocks).
//                Still regions slowly re-resolve toward the live frame
//                ("residual healing"), moving regions persist and rot.
//                Colorful residue: dragged blocks posterize + hue-rotate
//                by motion direction; beat-driven bursts teleport random
//                blocks and rainbow-shift them (P-frame breakup confetti).
//   3. DISPLAY — mosh buffer → canvas with motion-scaled RGB split.
//
// The time-based component of real datamoshing is the keyframe cycle:
// the melt accumulates until an "I-frame" lands and the image snaps back
// to clean, then starts rotting again. `cycle` sets that period (0 =
// never refresh — pure eternal melt).
//
// Runs in an offscreen WebGL2 canvas at a capped sim resolution
// (≤ 960px wide) and is blitted onto the post canvas with smoothing off,
// so the macroblocks stay crisp and the cost is independent of display
// DPR — comfortably 60fps on an integrated-GPU laptop and flagship
// phones. Falls back to the legacy Canvas2D smear when WebGL2 is
// unavailable.

import { compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter } from './webgl.js';

const SIM_MAX_W = 960;   // sim buffer cap (keeps flow + advect cheap)
const FLOW_R    = 12;    // max search radius, sim px (flow encode range)

const FLOW_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCurr;
uniform sampler2D uPrev;
uniform vec2  uSimSize;
uniform float uBlock;
const float R = ${FLOW_R}.0;

// 5-tap SAD between the current block at p and the previous frame's block
// at p+d (all coords in sim px).
float sad(vec2 p, vec2 d, vec2 ts, float o) {
  vec3 s = vec3(0.0);
  vec3 a0 = texture(uCurr, p * ts).rgb                 - texture(uPrev, (p + d) * ts).rgb;
  vec3 a1 = texture(uCurr, (p + vec2(-o,-o)) * ts).rgb - texture(uPrev, (p + d + vec2(-o,-o)) * ts).rgb;
  vec3 a2 = texture(uCurr, (p + vec2( o,-o)) * ts).rgb - texture(uPrev, (p + d + vec2( o,-o)) * ts).rgb;
  vec3 a3 = texture(uCurr, (p + vec2(-o, o)) * ts).rgb - texture(uPrev, (p + d + vec2(-o, o)) * ts).rgb;
  vec3 a4 = texture(uCurr, (p + vec2( o, o)) * ts).rgb - texture(uPrev, (p + d + vec2( o, o)) * ts).rgb;
  s = abs(a0) + abs(a1) + abs(a2) + abs(a3) + abs(a4);
  return s.r + s.g + s.b;
}

void main() {
  vec2 ts = 1.0 / uSimSize;
  // One output texel per macroblock — search around this block's centre.
  vec2 p = (floor(vUv * uSimSize / uBlock) + 0.5) * uBlock;
  float o = uBlock * 0.27;

  vec2  best  = vec2(0.0);
  // Small bias toward zero motion so flat regions don't jitter.
  float bestS = sad(p, vec2(0.0), ts, o) - 0.05;

  // Three-step search: 8 directions at a shrinking step around the best
  // candidate so far. 4 rounds ≈ ±12px reach at integer-ish precision.
  float stp = 8.0;
  for (int r = 0; r < 4; r++) {
    vec2 roundBest = best;
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.7853981633974483;
      vec2 d = clamp(best + vec2(cos(ang), sin(ang)) * stp, vec2(-R), vec2(R));
      float s = sad(p, d, ts, o);
      if (s < bestS) { bestS = s; roundBest = d; }
    }
    best = roundBest;
    stp *= 0.5;
  }
  outColor = vec4(best / R * 0.5 + 0.5, clamp(bestS * 0.4, 0.0, 1.0), 1.0);
}
`;

const ADVECT_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMosh;   // previous mosh buffer
uniform sampler2D uCurr;   // live frame
uniform sampler2D uFlow;   // coarse motion field (NEAREST → macroblocks)
uniform vec2  uSimSize;
uniform float uBlock;
uniform float uMelt;      // advection strength (1 = exact observed motion)
uniform float uHeal;      // residual healing toward the live frame
uniform float uRefresh;   // 1 on I-frame events — snap to clean
uniform float uColor;     // rainbow residue amount
uniform float uGlitch;    // fraction of blocks hit by teleport bursts
uniform float uSeed;
const float R = ${FLOW_R}.0;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735026919);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

void main() {
  vec2 ts = 1.0 / uSimSize;
  vec2 block = floor(vUv * uSimSize / uBlock);

  vec2 fenc = texture(uFlow, (block + 0.5) * uBlock * ts).rg;
  vec2 d = (fenc - 0.5) * 2.0 * R;          // sim px, prev→curr per block
  float mag = length(d);

  // Melt: drag stale pixels along the observed motion. Whole blocks share
  // one vector (NEAREST flow) — the macroblock signature of the effect.
  vec3 hist = texture(uMosh, vUv + d * uMelt * ts).rgb;
  vec3 fresh = texture(uCurr, vUv).rgb;

  // Beat-burst teleports: random blocks grab content from a few blocks
  // away and hue-shift — the colorful P-frame confetti breakup.
  float g = hash(block * 0.731 + vec2(uSeed, uSeed * 1.37));
  if (g < uGlitch) {
    vec2 jump = (vec2(hash(block + uSeed), hash(block + uSeed + 4.7)) - 0.5) * uBlock * 8.0;
    hist = texture(uMosh, vUv + jump * ts).rgb;
    hist = hueRotate(hist, (g / max(uGlitch, 1e-4)) * 6.2832);
  }

  // Rainbow residue where the melt is dragging hard: posterize (DCT-ish
  // banding) and hue-rotate by motion direction so smears iridesce.
  float dragAmt = smoothstep(0.4, R * 0.6, mag);
  if (uColor > 0.001 && dragAmt > 0.001) {
    float ang = atan(d.y, d.x);
    vec3 shifted = hueRotate(hist, ang * uColor * 1.2);
    vec3 banded = floor(shifted * 10.0 + 0.5) / 10.0;
    hist = mix(hist, banded, uColor * dragAmt * 0.85);
  }

  // Healing: still blocks resolve toward the live frame (residual
  // updates), moving blocks persist and rot. Refresh = I-frame.
  float still_ = 1.0 - smoothstep(0.3, 2.5, mag);
  float w = clamp(uRefresh + uHeal * (0.02 + 0.5 * still_), 0.0, 1.0);
  outColor = vec4(mix(hist, fresh, w), 1.0);
}
`;

const DISPLAY_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2  uSimSize;
uniform float uSplit;   // rgb split, sim px
void main() {
  // Textures hold rows top-down; the default framebuffer is bottom-up.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 off = vec2(uSplit / uSimSize.x, 0.0);
  outColor = vec4(
    texture(uTex, uv + off).r,
    texture(uTex, uv).g,
    texture(uTex, uv - off).b,
    1.0);
}
`;

export function createMoshPost() {
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl2', {
    antialias: false, depth: false, stencil: false,
    alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false,
  });

  // ── Legacy Canvas2D fallback (the old smear) ─────────────────────────────
  if (!gl) return createFallback();

  const vao = makeFullscreenTri(gl);
  const progFlow    = compileProgram(gl, FULLSCREEN_VERT, FLOW_FRAG);
  const progAdvect  = compileProgram(gl, FULLSCREEN_VERT, ADVECT_FRAG);
  const progDisplay = compileProgram(gl, FULLSCREEN_VERT, DISPLAY_FRAG);
  const UF = makeUniformGetter(gl, progFlow);
  const UA = makeUniformGetter(gl, progAdvect);
  const UD = makeUniformGetter(gl, progDisplay);

  // Downsample staging canvas for frame uploads.
  const srcCanvas = document.createElement('canvas');
  const srcCtx = srcCanvas.getContext('2d');

  let simW = 0, simH = 0, gridW = 0, gridH = 0, bsSim = 8;
  let texFrames = [null, null];   // [curr, prev] — swapped each frame
  let texMosh   = [null, null];   // ping-pong
  let texFlow   = null;
  let fboMosh   = [null, null];
  let fboFlow   = null;
  let moshSrc = 0;                // index of the "previous mosh" texture
  let frameCurr = 0;              // index of the current-frame texture

  let lastRenderAt = 0;           // wall-clock; detects off→on gaps
  let lastKeyAt = 0;              // field.time of the last I-frame
  let seedFrames = 0;             // frames left of forced refresh

  function makeTex(w, h, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
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
  function freeAll() {
    for (const t of texFrames) if (t) gl.deleteTexture(t);
    for (const t of texMosh)   if (t) gl.deleteTexture(t);
    if (texFlow) gl.deleteTexture(texFlow);
    for (const f of fboMosh) if (f) gl.deleteFramebuffer(f);
    if (fboFlow) gl.deleteFramebuffer(fboFlow);
    texFrames = [null, null]; texMosh = [null, null]; texFlow = null;
    fboMosh = [null, null]; fboFlow = null;
  }

  function ensureSize(W, H, blockSizePx) {
    const w = Math.min(SIM_MAX_W, Math.max(2, W));
    const h = Math.max(2, Math.round(w * H / Math.max(1, W)));
    // Block size arrives in display px — convert to sim px.
    const bs = Math.max(4, Math.min(64, Math.round(blockSizePx * w / Math.max(1, W))));
    const gw = Math.max(1, Math.ceil(w / bs));
    const gh = Math.max(1, Math.ceil(h / bs));
    if (w === simW && h === simH && gw === gridW && gh === gridH) { bsSim = bs; return; }
    simW = w; simH = h; gridW = gw; gridH = gh; bsSim = bs;
    glCanvas.width = simW; glCanvas.height = simH;
    srcCanvas.width = simW; srcCanvas.height = simH;
    freeAll();
    texFrames = [makeTex(simW, simH, gl.LINEAR), makeTex(simW, simH, gl.LINEAR)];
    texMosh   = [makeTex(simW, simH, gl.LINEAR), makeTex(simW, simH, gl.LINEAR)];
    texFlow   = makeTex(gridW, gridH, gl.NEAREST);
    fboMosh   = [makeFbo(texMosh[0]), makeFbo(texMosh[1])];
    fboFlow   = makeFbo(texFlow);
    seedFrames = 2; // mosh buffers are blank — refresh until seeded
  }

  function render(postCtx, main, W, H, field, cfg) {
    ensureSize(W, H, cfg.blockSize);

    const audio = field?.audio;
    const audioOn = !!audio?.spectrum;
    const bass  = audioOn ? audio.bands.bass : 0.15;
    const beatP = audioOn ? audio.beat.pulse : 0;
    const highP = audioOn ? audio.highs.pulse : 0;
    const time  = field?.time ?? 0;
    const k = cfg.intensity;

    // Re-seed after the pass has been off (blip/flip leave stale buffers).
    const now = performance.now();
    if (now - lastRenderAt > 300) { seedFrames = 2; lastKeyAt = time; }
    lastRenderAt = now;

    // I-frame cycle: melt accumulates for `cycle` seconds, then one clean
    // refresh lands and the rot starts over. 0 = never (eternal melt).
    let refresh = 0;
    if (seedFrames > 0) { refresh = 1; seedFrames--; lastKeyAt = time; }
    else if (cfg.cycle > 0.01 && time - lastKeyAt >= cfg.cycle) {
      refresh = 1;
      lastKeyAt = time;
    }

    // 1. Upload the current frame (downsampled to sim res).
    srcCtx.globalCompositeOperation = 'copy';
    try {
      srcCtx.drawImage(main, 0, 0, simW, simH);
    } catch {
      return; // unreadable fx canvas — skip the frame
    }
    gl.bindTexture(gl.TEXTURE_2D, texFrames[frameCurr]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);

    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);

    // 2. Flow: prev vs curr → coarse motion field.
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboFlow);
    gl.viewport(0, 0, gridW, gridH);
    gl.useProgram(progFlow);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texFrames[frameCurr]);
    gl.uniform1i(UF('uCurr'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texFrames[1 - frameCurr]);
    gl.uniform1i(UF('uPrev'), 1);
    gl.uniform2f(UF('uSimSize'), simW, simH);
    gl.uniform1f(UF('uBlock'), bsSim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3. Advect the mosh buffer along the flow.
    const melt = (0.35 + cfg.smear * 1.85) * k * (1 + bass * 0.5 + beatP * 0.6);
    const glitch = Math.min(0.6, cfg.glitchRate * k * (0.05 + beatP * 0.65 + highP * 0.25));
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboMosh[1 - moshSrc]);
    gl.viewport(0, 0, simW, simH);
    gl.useProgram(progAdvect);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texMosh[moshSrc]);
    gl.uniform1i(UA('uMosh'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texFrames[frameCurr]);
    gl.uniform1i(UA('uCurr'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texFlow);
    gl.uniform1i(UA('uFlow'), 2);
    gl.uniform2f(UA('uSimSize'), simW, simH);
    gl.uniform1f(UA('uBlock'), bsSim);
    gl.uniform1f(UA('uMelt'), melt);
    gl.uniform1f(UA('uHeal'), cfg.heal);
    gl.uniform1f(UA('uRefresh'), refresh);
    gl.uniform1f(UA('uColor'), cfg.colorful);
    gl.uniform1f(UA('uGlitch'), glitch);
    // Seed steps ~10×/s so burst blocks hold for a few frames instead of
    // strobing per-frame.
    gl.uniform1f(UA('uSeed'), Math.floor(time * 10) * 0.173);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 4. Display with beat-widened RGB split.
    const split = cfg.colorSplit * (simW / Math.max(1, W)) * (1 + beatP * 1.4) * k;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, simW, simH);
    gl.useProgram(progDisplay);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texMosh[1 - moshSrc]);
    gl.uniform1i(UD('uTex'), 0);
    gl.uniform2f(UD('uSimSize'), simW, simH);
    gl.uniform1f(UD('uSplit'), split);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    // 5. Blit to the post canvas — smoothing OFF keeps macroblocks crisp.
    postCtx.globalCompositeOperation = 'source-over';
    postCtx.globalAlpha = 1;
    const smoothWas = postCtx.imageSmoothingEnabled;
    postCtx.imageSmoothingEnabled = false;
    postCtx.drawImage(glCanvas, 0, 0, W, H);
    postCtx.imageSmoothingEnabled = smoothWas;

    moshSrc = 1 - moshSrc;
    frameCurr = 1 - frameCurr;
  }

  function dispose() {
    freeAll();
    gl.deleteProgram(progFlow);
    gl.deleteProgram(progAdvect);
    gl.deleteProgram(progDisplay);
    gl.deleteVertexArray(vao);
    srcCanvas.width = srcCanvas.height = 0;
    glCanvas.width = glCanvas.height = 0;
  }

  return { render, dispose };
}

// ── Canvas2D fallback — the pre-WebGL smear implementation ────────────────
// Kept so the pass still does something on contexts without WebGL2 (rare
// on the target hardware). Same config keys, much tamer look.
function createFallback() {
  let moshBuf = null, moshCtx = null;

  function render(postCtx, main, W, H, field, cfg) {
    if (!moshBuf) {
      moshBuf = document.createElement('canvas');
      moshCtx = moshBuf.getContext('2d');
    }
    if (moshBuf.width !== W || moshBuf.height !== H) {
      moshBuf.width = W; moshBuf.height = H;
    }
    const audio = field?.audio;
    const audioOn = !!audio?.spectrum;
    const k = cfg.intensity;

    const t = performance.now() * 0.0008;
    const driftMag = 1 + Math.floor(k * 2.5);
    const dx = Math.round(Math.sin(t) * driftMag);
    const dy = Math.round(Math.cos(t * 0.9) * driftMag);
    const smearAmt = Math.min(0.95, cfg.smear * k * (0.7 + (audioOn ? audio.bands.bass * 0.3 : 0.15)));
    moshCtx.globalAlpha = smearAmt;
    moshCtx.globalCompositeOperation = 'source-over';
    moshCtx.drawImage(moshBuf, dx, dy);

    moshCtx.globalAlpha = 1 - smearAmt * 0.55;
    try {
      moshCtx.drawImage(main, 0, 0, W, H);
    } catch { /* show the smeared buffer alone */ }

    let burst = cfg.glitchRate * k * 6;
    if (audioOn && audio.beat.active) burst += cfg.glitchRate * k * 24;
    if (audioOn && audio.mids?.active) burst += cfg.glitchRate * k * 8;
    const numBlocks = Math.floor(burst);
    if (numBlocks > 0) {
      const bs = Math.max(4, Math.round(cfg.blockSize));
      const maxOff = bs * (2 + k * 3);
      moshCtx.globalAlpha = 1;
      for (let i = 0; i < numBlocks; i++) {
        const sx = Math.floor(Math.random() * Math.max(1, W - bs));
        const sy = Math.floor(Math.random() * Math.max(1, H - bs));
        const dxB = Math.max(0, Math.min(W - bs, sx + ((Math.random() - 0.5) * maxOff) | 0));
        const dyB = Math.max(0, Math.min(H - bs, sy + ((Math.random() - 0.5) * maxOff) | 0));
        moshCtx.drawImage(moshBuf, sx, sy, bs, bs, dxB, dyB, bs, bs);
      }
    }

    postCtx.globalCompositeOperation = 'source-over';
    postCtx.globalAlpha = 1;
    postCtx.drawImage(moshBuf, 0, 0);

    if (cfg.colorSplit > 0.5) {
      const cs = cfg.colorSplit * k;
      const widen = audioOn ? audio.beat.pulse * cs * 1.2 : 0;
      const off = Math.round(cs + widen);
      postCtx.globalCompositeOperation = 'lighter';
      postCtx.globalAlpha = 0.30;
      postCtx.drawImage(moshBuf, off, 0);
      postCtx.drawImage(moshBuf, -off, 0);
      postCtx.globalAlpha = 1;
      postCtx.globalCompositeOperation = 'source-over';
    }
  }

  function dispose() {
    if (moshBuf) moshBuf.width = moshBuf.height = 0;
    moshBuf = moshCtx = null;
  }

  return { render, dispose };
}
