// Tiny WebGL2 helpers — just enough for fullscreen-fragment fx without
// pulling in twgl or three. ~80 lines total.

export function compileProgram(gl, vertSrc, fragSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER,   vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    gl.deleteShader(vs); gl.deleteShader(fs);
    throw new Error(`program link failed: ${info}`);
  }
  // Shaders are no longer needed once linked.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    const tag = type === gl.VERTEX_SHADER ? 'vert' : 'frag';
    throw new Error(`${tag} shader compile failed: ${info}\n--- src ---\n${src}`);
  }
  return sh;
}

/**
 * Build a fullscreen-triangle VAO — the single big triangle that covers
 * the viewport with three vertices. Cheaper than a 6-vert quad and avoids
 * the diagonal-overdraw artifact. The vertex shader gets the position from
 * gl_VertexID so no attribute setup is needed at draw time.
 */
export function makeFullscreenTri(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  // No attributes — vert shader uses gl_VertexID.
  gl.bindVertexArray(null);
  return vao;
}

/** Vertex shader source for the fullscreen-tri trick. */
export const FULLSCREEN_VERT = /* glsl */`#version 300 es
  out vec2 vUv;
  void main() {
    // Three vertices laying out a triangle that covers [-1,1]^2 in clip space.
    vec2 pos = vec2(
      (gl_VertexID == 2) ?  3.0 : -1.0,
      (gl_VertexID == 1) ?  3.0 : -1.0
    );
    vUv = pos * 0.5 + 0.5;
    gl_Position = vec4(pos, 0.0, 1.0);
  }
`;

/** Cache uniform locations for a program — saves the per-frame string lookup. */
export function makeUniformGetter(gl, prog) {
  const cache = new Map();
  return name => {
    if (cache.has(name)) return cache.get(name);
    const loc = gl.getUniformLocation(prog, name);
    cache.set(name, loc);
    return loc;
  };
}

/**
 * Push the standard QualiaField audio uniforms into a program. Plugins can
 * call this for the "free" audio-reactivity bundle and add their own custom
 * uniforms on top.
 */
export function uploadAudioUniforms(gl, U, audio) {
  gl.uniform4f(U('uBands'), audio.bands.bass, audio.bands.mids, audio.bands.highs, audio.bands.total);
  gl.uniform2f(U('uBeat'),  audio.beat.active  ? 1 : 0, audio.beat.pulse);
  gl.uniform2f(U('uMids'),  audio.mids.active  ? 1 : 0, audio.mids.pulse);
  gl.uniform2f(U('uHighs'), audio.highs.active ? 1 : 0, audio.highs.pulse);
  gl.uniform1f(U('uRms'),   audio.rms);
}
