---
title: "Your First Fragment Shader: Real-Time GPU Art in the Browser"
description: "WebGL lets you run code on thousands of GPU cores simultaneously. Here's how to get from a blank canvas to a live, animated GLSL shader — no three.js required."
pubDate: 2026-02-14
tags: ["webgl", "glsl", "shaders", "generative", "gpu"]
---

Canvas2D runs on one CPU core. WebGL runs on thousands of GPU cores simultaneously.

For particle systems with 10k particles, Canvas2D is fine. For ray-marched volumetric fog, fluid simulations, or anything that needs per-pixel math at 60fps, you need WebGL — specifically, a fragment shader.

## The minimal WebGL setup

A fragment shader is a program that runs once per pixel, in parallel, across the entire canvas. It receives the pixel's coordinates and outputs a color. That's it.

The boilerplate to get a full-screen shader running:

```js
const canvas = document.querySelector('canvas');
const gl = canvas.getContext('webgl2');

// Vertex shader: just fills the screen with two triangles
const vert = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0, 1); }`;

// Fragment shader: your art goes here
const frag = `#version 300 es
precision highp float;
uniform vec2 u_res;   // canvas resolution
uniform float u_time; // seconds since start
out vec4 color;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  color = vec4(uv, 0.5 + 0.5 * sin(u_time), 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
gl.linkProgram(prog);
gl.useProgram(prog);

// Full-screen quad (two triangles)
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

const loc = gl.getAttribLocation(prog, 'a_pos');
gl.enableVertexAttribArray(loc);
gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

const uRes  = gl.getUniformLocation(prog, 'u_res');
const uTime = gl.getUniformLocation(prog, 'u_time');

function frame(t) {
  gl.uniform2f(uRes, canvas.width, canvas.height);
  gl.uniform1f(uTime, t / 1000);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

That's it. The `frag` string is where all your art lives.

## GLSL functions worth knowing

**`fract(x)`** — the fractional part. `fract(uv * 10.0)` tiles your UV space into a 10×10 grid. Useful for patterns.

**`smoothstep(edge0, edge1, x)`** — smooth interpolation between 0 and 1. Use it instead of `step()` to avoid aliased hard edges.

**`length(v)`** — Euclidean distance. `length(uv - 0.5)` is the distance from the center — foundation of radial effects.

**`atan(y, x)`** — angle from the origin. Combined with `length()` you have polar coordinates, which unlock spiral and wave patterns.

**`sin()` / `cos()` with time** — animate anything. `sin(uv.x * 20.0 + u_time * 2.0)` makes a scrolling sine wave.

## Bringing in camera data

A WebGL texture can be sourced directly from a `<video>` element — including a live camera feed:

```js
const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);

function updateCameraTexture(video) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
}
```

Upload the camera frame once per animation tick, then sample it in the fragment shader with `texture(u_camera, uv)`. From there you can:

- Edge-detect the camera feed (`Sobel kernel` in the shader)
- Displacement-map the camera through a noise field
- Use camera luminance as a threshold for revealing/hiding a generative layer underneath
- Feed it into a reaction-diffusion simulation as initial conditions

The fluid simulation in the lab does a version of this: camera motion drives dye injection into the fluid, so your movements leave colored wake trails.

→ [Open the WebGL Shader demo in the Lab](/lab)
→ [Source on GitHub](https://github.com/randbrown)
