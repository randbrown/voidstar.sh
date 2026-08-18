---
title: "your first fragment shader, no three.js"
description: "Canvas2D gives you one CPU core; a fragment shader gives you the whole GPU. The raw WebGL is ~40 lines — here's the whole thing, no build step."
pubDate: 2026-02-14
updatedDate: 2026-08-18
tags: ["webgl", "glsl", "shaders", "graphics", "livecoding"]
---

Canvas2D gives you one CPU core. A fragment shader gives you the whole GPU running the same tiny program on every pixel at once. For 10k particles Canvas2D is fine; for ray-marched fog or per-pixel math at 60fps, you want the GPU. And you don't need three.js to get there — the raw WebGL for a full-screen shader is about 40 lines.

## the whole thing is one quad and one shader

The trick: cover the screen with two triangles, then let the fragment shader color every pixel. It runs once per pixel, in parallel, and all it has to do is output a `vec4`. Here's the entire no-library version.

```js
const gl = document.querySelector('canvas').getContext('webgl2');

const vert = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const frag = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time;
out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;      // 0..1 across the screen
  float d = length(uv - 0.5);             // distance from center
  float glow = smoothstep(0.4, 0.0, d);   // soft disc
  color = vec4(vec3(glow * (0.5 + 0.5 * sin(u_time))), 1.0);
}`;

const compile = (type, src) => {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  return s;
};

const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
gl.linkProgram(prog); gl.useProgram(prog);

// two triangles = one full-screen quad
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER,
  new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
const p = gl.getAttribLocation(prog, 'p');
gl.enableVertexAttribArray(p);
gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);

const uRes = gl.getUniformLocation(prog, 'u_res');
const uTime = gl.getUniformLocation(prog, 'u_time');

(function loop(t) {
  gl.uniform2f(uRes, gl.canvas.width, gl.canvas.height);
  gl.uniform1f(uTime, t * 0.001);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  requestAnimationFrame(loop);
})(0);
```

That's a pulsing glow. Everything interesting after this happens inside `main()` — you never touch the plumbing again.

## glsl functions worth stealing

You don't need a math degree, just a handful of functions. These four do most of the heavy lifting on the projector.

```glsl
vec2 uv = gl_FragCoord.xy / u_res;
uv = fract(uv * 4.0);                    // tile: repeat into a 4x4 grid
float r = length(uv - 0.5);              // radial fields, rings, blobs
float a = atan(uv.y - 0.5, uv.x - 0.5);  // polar angle -> spirals, spokes
float edge = smoothstep(0.3, 0.31, r);   // clean anti-aliased edges, not step()
```

Add `sin`/`cos` of `u_time` anywhere to make it breathe. `fract` for tiling, `smoothstep` instead of `step` so nothing aliases, `length` for anything round, `atan(y,x)` when you want to think in circles. That's the whole starter kit.

## feed it the camera

A WebGL texture can be sourced straight from a `<video>` element — including a live camera. Push a new frame each tick, sample it in the shader, done.

```js
const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
// video frames aren't power-of-two: clamp + linear, no mipmaps, or it samples black
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
// per frame, after the video is playing:
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
```

```glsl
uniform sampler2D u_cam;
vec3 cam = texture(u_cam, uv).rgb;   // now you're doing per-pixel video
```

From there it's a playground: Sobel edge-detect, displace the UVs through noise, threshold on luminance so only the bright bits show through, or dump the camera's motion into a reaction-diffusion sim. That last one — camera into a feedback sim — is where a shader stops being a picture and starts being a system.

No install, no build step, no three.js. Just a quad and a string of GLSL.

→ see it live in the instrument: [/qualia](/qualia)
→ audio-reactive visuals in the lab: [/lab/cymatics](/lab/cymatics)
→ if you want the same thing but even lazier, [Hydra](https://hydra.video) hides all of the above
→ camera pipelines and pose data: [MediaPipe](https://ai.google.dev/edge/mediapipe)
→ source & more experiments: [github.com/randbrown](https://github.com/randbrown)
