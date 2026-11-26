// GPU Sobel for the edge post (overlay.js renderEdge).
//
// The edge pass used to run on the main thread every frame: drawImage the fx
// canvas into a ≤1280-wide 2D canvas, getImageData it back (a synchronous
// GPU→CPU readback when the fx canvas is WebGL), Sobel ~1M pixels in JS, then
// putImageData. That is 10+ ms of main-thread time per frame — enough, with
// other layers up, to starve Strudel's scheduler (which also lives on the main
// thread) into "skip query: too late" dropouts. Here the same math runs as one
// fragment-shader draw: the fx canvas is uploaded as a texture (GPU→GPU in
// Chromium) and the result stays on the GPU until overlay.js composites it.
//
// Same output as the CPU pass: green channel as luma, L1 Sobel magnitude on a
// 0..1020 scale, `(|gx|+|gy| − thr) · gain` clamped to 0..255, grey on black.
// Returns null when WebGL2 isn't available — overlay.js keeps its CPU path.
import { compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter } from './webgl.js';

const SOBEL_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;     // 1 / working size
uniform float uThr;      // threshold on the 0..1020 scale
uniform float uGain;     // 255 / span · intensity
out vec4 o;
float L(vec2 d) { return texture(uTex, vUv + d * uTexel).g * 255.0; }
void main() {
  float l00 = L(vec2(-1.0, -1.0)), l01 = L(vec2(0.0, -1.0)), l02 = L(vec2(1.0, -1.0));
  float l10 = L(vec2(-1.0,  0.0)),                            l12 = L(vec2(1.0,  0.0));
  float l20 = L(vec2(-1.0,  1.0)), l21 = L(vec2(0.0,  1.0)), l22 = L(vec2(1.0,  1.0));
  float gx = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
  float gy = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
  float v = clamp((abs(gx) + abs(gy) - uThr) * uGain, 0.0, 255.0);
  v = floor(v) / 255.0;
  o = vec4(v, v, v, 1.0);
}
`;

export function createEdgeGL() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      antialias: false, depth: false, stencil: false, alpha: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,   // read back in the same task
    });
  } catch { gl = null; }
  if (!gl) return null;

  let prog, U, vao, tex;
  try {
    prog = compileProgram(gl, FULLSCREEN_VERT, SOBEL_FRAG);
    U = makeUniformGetter(gl, prog);
    vao = makeFullscreenTri(gl);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } catch (err) {
    console.warn('[qualia] GPU edge pass unavailable — using the CPU pass:', err);
    return null;
  }

  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });

  /**
   * Sobel `src` (any canvas) at wW×wH. Returns the canvas holding the result,
   * or null if the pass couldn't run this frame (caller falls back to CPU).
   */
  function render(src, wW, wH, thr, gain) {
    if (lost || gl.isContextLost()) { lost = true; return null; }
    if (canvas.width !== wW || canvas.height !== wH) { canvas.width = wW; canvas.height = wH; }
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Canvas rows run top-down; GL textures bottom-up. Flip on upload so the
      // drawing buffer reads back the right way up when drawn into 2D.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.viewport(0, 0, wW, wH);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(U('uTex'), 0);
      gl.uniform2f(U('uTexel'), 1 / wW, 1 / wH);
      gl.uniform1f(U('uThr'), thr);
      gl.uniform1f(U('uGain'), gain);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    } catch {
      return null;
    }
    return canvas;
  }

  return { render, isLost: () => lost };
}
