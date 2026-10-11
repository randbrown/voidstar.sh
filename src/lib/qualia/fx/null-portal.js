// Null Portal — a hologram pane you open with your hands. The pose tracker's
// fingertip landmarks (index + thumb, both hands) become the four corners of
// a glowing quad; the live camera frame is perspective-warped INTO the quad
// and re-printed through a stylized treatment (CMYK-poster halftone by
// default). Pinch your fingers together and the portal collapses to a bright
// seam; pull them apart and it opens; cross your hands and it folds into a
// bowtie — the geometry is a true bilinear patch, so the degenerate shapes
// are features, not bugs.
//
// Looks (the `look` select — what's printed inside the pane):
//   hologram — 3-tone riso/CMYK halftone poster of the feed (the canon look)
//   edges    — Sobel wireframe, CRT/vector style, over a near-void fill
//   ascii    — glyph-ramp terminal render of the feed
//   crush    — chunky pixelate + posterize
//   thermal  — luma → void/cyan/gold heat ramp
//   window   — pure void inside the pane: the fx canvas screen-blends over
//              Hydra (z:1), so the portal becomes a live window onto whatever
//              Hydra is running. Live-code the other side of the portal.
//   clean    — the plain feed, lightly graded
// `sample` picks the mapping: 'frame' squeezes a centred window of the
// displayed frame into the pane (the reel look) — `crop` sets its size as a
// fraction of the screen (1 = the whole screen, the default);
// 'lens' makes the pane a see-through window onto what's behind it, `zoom`
// magnifying (>1) or widening (<1) the view about the pane centre. `background` is the rest of the screen: the dimmed live
// feed, or void (near-black → effectively transparent over Hydra).
// `grip` picks the hand geometry: 'edges' = fingertips are the corners (the
// reel gesture, pane bounded by finger spread); 'corners' = each hand's
// thumb+index V is a picture-frame corner and the pane spans the two apexes
// with its edges running along the finger rays — open panes far beyond
// finger length; 'auto' flips between them on hand orientation: two
// matching L's (index up, thumbs in) hold the edge grip, and turning ONE
// hand 90° (thumb down, index across — a director's frame) flips to the
// corner grip so the pane spans the diagonal between the hands.
// `shape` 'rect' rebuilds whatever the grip produced as a true rectangle
// whose angle is steadied (adaptive smoothing: small tremors are eaten,
// deliberate turns follow quickly) and pulled level near horizontal by
// `level`; in the corner grip the angle is the average of all four finger
// rays (mod 90°) rather than per-ray intersections. 'free' keeps the raw
// bilinear quad (bowties, skews). `lean` tilts the pane forward/back with
// the hands: the hand-plane pitch (wrist / index / pinky base in 3D, from the
// hand model's z) keystones the pane — top edge leaning away shrinks.
//
// Tracking: `wantsHands: true` below makes the page keep the 21-point
// HandLandmarker armed while this quale is active (same model the horns 🤘
// toggle uses), so field.pose.hands carries REAL fingertip positions —
// that's what makes the pane react to individual fingers. The pose model's
// own hand points (raw 19-22) are rigid body-model estimates that only
// follow the wrist, so they serve as the fallback tier (~15 fps,
// pre-smoothed) when the hand model has no fresh result — hands run in
// their own worker every pose tick (up to ~15 fps), with pose-guided wrist
// crops for far/dark hands (hand-worker.js), best-effort (a failed CDN
// fetch → pose tips carry on). Corners map
// through lmToCanvas so they ride where the preview/skeleton shows them.
// No hands → the portal eases into a slow idle drift; camera off → it prints
// a palette test card so the quale stays alive (README idle rule).
//
// Audio map: beat.pulse → border-glow flash + chroma fringe (glow modulator);
//   bass → halftone grain breathes (dots modulator); highs.pulse → hologram
//   instability/static (flicker modulator); all scaled by `reactivity`.
//
// Camera lifecycle is NOT owned here (house rule): the topbar pose-source
// select owns it; this quale reads the shared <video> via getVideoEl().

import { compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter, uploadAudioUniforms, bakeTextTex } from '../webgl.js';
import { scaleAudio } from '../field.js';
import { getVideoEl, getRotation, getMirror, lmToCanvas } from '../video.js';

// Raw MediaPipe pose indices for the fingertip corners (see pose.js LM map —
// these four aren't named joints, but .raw carries the full 33-point array).
const LM_L_INDEX = 19, LM_R_INDEX = 20, LM_L_THUMB = 21, LM_R_THUMB = 22;
// HandLandmarker per-hand indices (wrist 0 … thumb tip 4 … index tip 8).
// The MCP (base) joints anchor the finger RAYS the corner-frame grip needs.
const HAND_WRIST = 0, HAND_THUMB_TIP = 4, HAND_INDEX_TIP = 8;
const HAND_THUMB_MCP = 2, HAND_INDEX_MCP = 5, HAND_PINKY_MCP = 17;
// `level` 1 → the pane angle is pulled flat within ±LEVEL_SNAP*2 of level.
const LEVEL_SNAP = 0.14;   // rad (~8°)
// Lean: deadzone (a natural L is rarely dead-flat to the lens), max tilt,
// and keystone strength (how much the far edge shrinks per unit sin(tilt)).
const LEAN_DEAD = 0.10, LEAN_MAX = 1.0, LEAN_KEYSTONE = 0.45;
// Hand results older than this are stale (hands run up to ~15 fps, slower
// when the hand worker is busy with crops) — fall back to
// the pose-model fingertips rather than pinning corners to a dead frame.
const HANDS_FRESH_MS = 450;

// Glyph ramp for the ascii look, light → dense. Baked to a one-row atlas.
const GLYPHS = ' .:-~=+*#%@';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform sampler2D uVideo;
uniform sampler2D uGlyphs;     // ascii ramp atlas, one row of glyphs
uniform sampler2D uHint;       // "camera off" hint text (bakeTextTex, y-flipped upload)
uniform vec2  uResolution;     // canvas backing-buffer px
uniform float uTime;
uniform float uCamReady;       // 1 = video frames are flowing
uniform mat3  uCamMat;         // canvas-px (y-down) → video-uv (y-down) affine
uniform vec2  uC0, uC1, uC2, uC3; // quad corners TL,TR,BR,BL — canvas px, y-down
uniform vec2  uQuadSpan;       // avg quad width/height in px (dot/cell density)
uniform float uPortalAlpha;    // presence-driven pane opacity
uniform int   uLook;           // 0 holo 1 edges 2 ascii 3 crush 4 thermal 5 window 6 clean
uniform int   uSample;         // 0 frame, 1 lens
uniform int   uBackground;     // 0 camera, 1 void
uniform float uDots;           // halftone cell size, px
uniform float uGlow;           // border glow intensity
uniform float uFlicker;        // hologram instability amount
uniform float uZoom;           // lens-mode magnification
uniform vec4  uFrameWin;       // frame-mode source window: x0, y0, w, h (canvas px)
uniform vec3  uPaper, uInkA, uInkB, uEdge; // palette: paper, mid ink, dark ink, glow

uniform vec4  uBands;          // (bass, mids, highs, total)
uniform vec2  uBeat;           // (active, pulse)
uniform vec2  uMids;
uniform vec2  uHighs;
uniform float uRms;

const int NGLYPHS = ${GLYPHS.length};
const vec3 VOIDC = vec3(0.004, 0.004, 0.016);   // #010104 — field.js VOID

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }

// Sample the camera through the display mapping (mirror/rotation/cover-fit
// baked into uCamMat on the CPU). p is canvas px, y-down.
vec3 cam(vec2 p) {
  vec2 uv = (uCamMat * vec3(p, 1.0)).xy;
  return texture(uVideo, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
}

// Inverse bilinear — where does canvas point p sit inside the quad
// a(TL) b(TR) c(BR) d(BL)? Returns (u,v) in [0,1]^2, or (-1,-1) outside.
// Coordinates arrive pre-scaled to ~unit range so the fp32 discriminant
// stays clean at 2880px backing buffers. (After iq's invBilinear.)
float uFromV(float v, vec2 e, vec2 f, vec2 g, vec2 h) {
  float denX = e.x + g.x * v, denY = e.y + g.y * v;
  return abs(denX) > abs(denY) ? (h.x - f.x * v) / denX
                               : (h.y - f.y * v) / denY;
}
vec2 invBilinear(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 e = b - a, f = d - a, g = a - b + c - d, h = p - a;
  float k2 = cross2(g, f);
  float k1 = cross2(e, f) + cross2(h, g);
  float k0 = cross2(h, e);
  if (abs(k2) < 1e-5) {                      // (near-)parallelogram: linear in v
    if (abs(k1) < 1e-7) return vec2(-1.0);
    float v = -k0 / k1;
    float u = uFromV(v, e, f, g, h);
    return (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) ? vec2(u, v) : vec2(-1.0);
  }
  float w = k1 * k1 - 4.0 * k0 * k2;
  if (w < 0.0) return vec2(-1.0);
  w = sqrt(w);
  float ik2 = 0.5 / k2;
  float v = (-k1 - w) * ik2;
  float u = uFromV(v, e, f, g, h);
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) {
    v = (-k1 + w) * ik2;
    u = uFromV(v, e, f, g, h);
  }
  return (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) ? vec2(u, v) : vec2(-1.0);
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// Portal-content sample: portal-uv → the canvas-px point whose camera sample
// fills that spot. 'frame' squeezes the whole displayed frame into the pane;
// 'lens' looks straight through it, slightly magnified about the pane centre.
// Lens mode maps uv through the quad's FORWARD bilinear patch (the inverse
// of invBilinear) rather than using the fragment position, so offset and
// cell-quantized taps (Sobel, ascii/crush cells, chroma fringe) sample the
// world correctly in both modes; px is kept for signature stability only.
// (cen, not "centroid" — that's a reserved word in GLSL ES 3.00.)
vec3 content(vec2 uv, vec2 px, vec2 cen) {
  vec2 p;
  if (uSample == 0) {
    p = uFrameWin.xy + uv * uFrameWin.zw;
  } else {
    vec2 q = mix(mix(uC0, uC1, uv.x), mix(uC3, uC2, uv.x), uv.y);
    p = cen + (q - cen) / max(uZoom, 0.05);
  }
  return cam(p);
}

// Test card for camera-off: palette bars + drift + static, so the pane is
// alive before the feed exists.
vec3 testcard(vec2 uv) {
  float bar = floor(fract(uv.x * 0.999 + uTime * 0.02) * 5.0);
  vec3 col = bar < 1.0 ? uPaper : bar < 2.0 ? uInkA : bar < 3.0 ? uInkB
           : bar < 4.0 ? uPaper * 0.4 : VOIDC * 3.0;
  float sweep = exp(-40.0 * abs(fract(uTime * 0.13) - uv.y));
  col += uEdge * sweep * 0.5;
  col += (hash(floor(uv * uQuadSpan / 3.0) + floor(uTime * 20.0)) - 0.5) * 0.18;
  return col;
}

// Circular-dot halftone. g is dot-grid coords (1 unit = 1 cell), v = ink
// coverage 0..1. Returns ink mask with a little analytic AA.
float halftone(vec2 g, float v) {
  vec2 f = fract(g) - 0.5;
  float r = sqrt(clamp(v, 0.0, 1.0)) * 0.72;
  return smoothstep(r, r - 0.16, length(f));
}
vec2 rot2(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

void main() {
  // Canvas-px space, y-down, top-left origin — the same space lmToCanvas
  // (and therefore the quad corners) lives in.
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uResolution;

  // ── Background ─────────────────────────────────────────────────────────
  vec3 bg = VOIDC;
  if (uBackground == 0 && uCamReady > 0.5) {
    // Dimmed cool grade — transfigure, don't televise. Slight edge falloff
    // keeps the frame from reading as raw video.
    vec3 c = cam(px);
    float l = luma(c);
    bg = c * vec3(0.30, 0.34, 0.44) + vec3(0.0, 0.008, 0.03) * (1.0 - l);
    vec2 n = px / uResolution - 0.5;
    bg *= 1.0 - 0.55 * dot(n, n) * 2.2;
    bg = max(bg, VOIDC);
  }

  // ── Portal interior ────────────────────────────────────────────────────
  // Solve in a ~unit space so fp32 survives the quadratic at high DPR.
  float S = 1.0 / max(uResolution.y, 1.0);
  vec2 uv = invBilinear(px * S, uC0 * S, uC1 * S, uC2 * S, uC3 * S);
  vec2 cen = (uC0 + uC1 + uC2 + uC3) * 0.25;

  vec3 col = bg;
  if (uv.x >= 0.0 && uPortalAlpha > 0.003) {
    // Feather the pane edge ~1.5px so the rim doesn't shimmer.
    float edgePx = min(min(uv.x, 1.0 - uv.x) * uQuadSpan.x,
                       min(uv.y, 1.0 - uv.y) * uQuadSpan.y);
    float mask = smoothstep(0.0, 1.5, edgePx);

    // Hologram instability: horizontal tape jitter + a slow scan sweep +
    // brightness dropouts, all scaled by flicker (+ highs static below).
    float inst = uFlicker * (0.55 + 0.45 * uHighs.y * 2.0);
    vec2 juv = uv;
    float row = floor(uv.y * uQuadSpan.y / 3.0);
    juv.x += (hash(vec2(row, floor(uTime * 24.0))) - 0.5) * 0.012 * inst;

    vec3 fill = vec3(0.0);
    if (uLook == 5) {
      // window — void inside the pane; screen-blend makes it a live Hydra
      // window. Keep a whisper of paper so the pane still reads as glass.
      fill = vec3(0.0);
      fill += uEdge * 0.03 * (0.5 + 0.5 * sin(uv.y * 40.0 + uTime * 1.7));
    } else if (uCamReady < 0.5) {
      fill = testcard(juv);
    } else if (uLook == 0) {
      // hologram — 3-tone CMYK-poster halftone (paper / mid ink / dark ink)
      // with rotated screens, printed in pane space so the dots ride the
      // pane like ink on held glass.
      vec2 qp = juv * uQuadSpan / max(uDots, 2.0);
      float L = luma(content(juv, px, cen));
      // Beat chroma fringe: the dark plate samples slightly offset.
      vec2 boff = vec2(uBeat.y * 2.5 / max(uQuadSpan.x, 1.0), 0.0);
      float Ld = luma(content(juv + boff, px, cen));
      float cInk = halftone(rot2(qp, 0.26), smoothstep(0.88, 0.30, L));
      float mInk = halftone(rot2(qp, 1.31), smoothstep(0.45, 0.06, Ld));
      fill = uPaper;
      fill = mix(fill, uInkA, cInk);
      fill = mix(fill, uInkB, mInk);
      float scan = 0.92 + 0.08 * sin(juv.y * uQuadSpan.y * 1.6);
      fill *= scan;
    } else if (uLook == 1) {
      // edges — Sobel wireframe over a near-void pane (Hydra bleeds inside).
      vec2 e = vec2(1.6) / max(uQuadSpan, vec2(8.0)) * clamp(uDots / 7.0, 0.6, 2.0);
      float tl = luma(content(juv + vec2(-e.x, -e.y), px, cen));
      float tc = luma(content(juv + vec2( 0.0, -e.y), px, cen));
      float tr = luma(content(juv + vec2( e.x, -e.y), px, cen));
      float ml = luma(content(juv + vec2(-e.x,  0.0), px, cen));
      float mr = luma(content(juv + vec2( e.x,  0.0), px, cen));
      float bl = luma(content(juv + vec2(-e.x,  e.y), px, cen));
      float bc = luma(content(juv + vec2( 0.0,  e.y), px, cen));
      float br = luma(content(juv + vec2( e.x,  e.y), px, cen));
      float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
      float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
      float mag = clamp(length(vec2(gx, gy)) * 1.4, 0.0, 1.0);
      fill = vec3(0.010, 0.012, 0.030);
      fill += uInkA * smoothstep(0.12, 0.65, mag);
      fill += uEdge * smoothstep(0.55, 0.95, mag) * 0.7;
    } else if (uLook == 2) {
      // ascii — glyph-ramp terminal print of the feed.
      float cellPx = max(6.0, uDots * 1.9);
      vec2 qp = juv * uQuadSpan;
      vec2 cell = floor(qp / cellPx);
      vec2 cuv = (cell + 0.5) * cellPx / max(uQuadSpan, vec2(8.0));
      float L = luma(content(clamp(cuv, 0.0, 1.0), px, cen));
      float gi = floor(clamp(L, 0.0, 1.0) * float(NGLYPHS - 1) + 0.5);
      vec2 g = fract(qp / cellPx);
      float m = texture(uGlyphs, vec2((gi + g.x) / float(NGLYPHS), g.y)).r;
      fill = vec3(0.006, 0.010, 0.018);
      fill += uEdge * m * (0.35 + 0.85 * L);
    } else if (uLook == 3) {
      // crush — chunky pixelate + posterize (video-quale math, pane-local).
      float cellPx = max(3.0, uDots * 1.6);
      vec2 cells = max(uQuadSpan / cellPx, vec2(2.0));
      vec2 cuv = (floor(juv * cells) + 0.5) / cells;
      vec3 c = content(cuv, px, cen);
      c = floor(c * 5.0) / 5.0;
      fill = c * mix(vec3(1.0), uInkA * 1.6, 0.18) + uInkB * 0.05;
    } else if (uLook == 4) {
      // thermal — luma → void/blue/cyan/gold/white heat ramp.
      float L = luma(content(juv, px, cen));
      vec3 r1 = mix(vec3(0.01, 0.02, 0.09), vec3(0.05, 0.16, 0.55), smoothstep(0.00, 0.30, L));
      vec3 r2 = mix(r1, vec3(0.00, 0.83, 1.00), smoothstep(0.25, 0.55, L));
      vec3 r3 = mix(r2, vec3(1.00, 0.82, 0.35), smoothstep(0.50, 0.80, L));
      fill = mix(r3, vec3(1.0), smoothstep(0.80, 0.97, L));
    } else {
      // clean — the plain feed with a light cool grade + beat rgb fringe.
      vec2 boff = vec2(uBeat.y * 2.0 / max(uQuadSpan.x, 1.0), 0.0);
      fill.r = content(juv + boff, px, cen).r;
      vec3 gb = content(juv, px, cen);
      fill.g = gb.g; fill.b = gb.b;
      fill = fill * 0.96 + vec3(0.0, 0.01, 0.03);
    }

    // Sweep + dropouts + static — shared instability pass (skip for window).
    if (uLook != 5) {
      float sweep = exp(-30.0 * abs(fract(uTime * 0.11) - uv.y));
      fill += uEdge * sweep * 0.25 * inst;
      float drop = 1.0 - 0.30 * inst * step(0.92, hash(vec2(floor(uTime * 13.0), row * 0.02)));
      fill *= drop;
      fill += (hash(uv * uQuadSpan + floor(uTime * 47.0)) - 0.5) * 0.10 * inst;
    }

    float a = uPortalAlpha * mask * (uLook == 5 ? 1.0 : 0.93);
    col = mix(col, fill, a);
  }

  // ── Border glow — hot core + soft bloom along the four edges ───────────
  float d = sdSegment(px, uC0, uC1);
  d = min(d, sdSegment(px, uC1, uC2));
  d = min(d, sdSegment(px, uC2, uC3));
  d = min(d, sdSegment(px, uC3, uC0));
  float core  = exp(-d * d / 7.0);
  float bloom = exp(-d / 14.0);
  float flash = 0.75 + 0.7 * uBeat.y + 0.2 * uBands.x;
  vec3 glowCol = uEdge * (core * 1.25 + bloom * 0.40) + vec3(1.0) * core * core * 0.35;
  col += glowCol * uGlow * flash * max(uPortalAlpha, 0.25);

  // ── Camera-off hint (baked text; bakeTextTex uploads y-flipped) ────────
  if (uCamReady < 0.5) {
    vec2 hpx = vec2(560.0, 40.0) * (uResolution.y / 1080.0);
    vec2 hp = (px - vec2(uResolution.x * 0.5, uResolution.y * 0.86) + hpx * 0.5) / hpx;
    if (hp.x >= 0.0 && hp.x <= 1.0 && hp.y >= 0.0 && hp.y <= 1.0) {
      float m = texture(uHint, vec2(hp.x, 1.0 - hp.y)).r;
      col += vec3(0.55, 0.62, 0.72) * m * 0.85;
    }
  }

  outColor = vec4(col, 1.0);
}
`;

// Palette table: paper (bright field), inkA (mid plate), inkB (dark plate),
// edge (border glow). riso matches the reference reel; the rest re-ink the
// same press into voidstar canon families.
const PALETTES = {
  riso:     { paper: [0.93, 0.86, 0.24], inkA: [0.13, 0.83, 0.90], inkB: [0.90, 0.18, 0.72], edge: [1.00, 0.33, 0.85] },
  voidglow: { paper: [0.62, 0.92, 1.00], inkA: [0.05, 0.28, 0.80], inkB: [0.01, 0.02, 0.10], edge: [0.00, 0.83, 1.00] },
  gold:     { paper: [1.00, 0.82, 0.35], inkA: [0.85, 0.34, 0.10], inkB: [0.16, 0.04, 0.22], edge: [1.00, 0.82, 0.40] },
  phosphor: { paper: [0.78, 1.00, 0.86], inkA: [0.16, 0.72, 0.40], inkB: [0.01, 0.09, 0.04], edge: [0.51, 1.00, 0.80] },
};
const PALETTE_NAMES = Object.keys(PALETTES);
const LOOKS = ['hologram', 'edges', 'ascii', 'crush', 'thermal', 'window', 'clean'];

// Bake the ascii glyph ramp to a one-row atlas texture (white on black, .r
// is the mask). Kept local — bakeTextTex bakes one centered string; we need
// a fixed-pitch strip.
function bakeGlyphAtlas(gl) {
  const cw = 28, ch = 44;
  const c = document.createElement('canvas');
  c.width = cw * GLYPHS.length; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  ctx.font = `700 34px "JetBrains Mono", "Menlo", "Consolas", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < GLYPHS.length; i++) {
    ctx.fillText(GLYPHS[i], i * cw + cw / 2, ch / 2 + 2);
  }
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'null_portal',
  name: 'Null Portal',
  contextType: 'webgl2',
  maxDpr: 1.0,   // camera texture + per-pixel quad solve — same cap as Video
  wantsHands: true,   // page arms the 21-pt HandLandmarker while active

  params: [
    { id: 'look',       label: 'look',       type: 'select', options: LOOKS, default: 'hologram' },
    { id: 'sample',     label: 'sample',     type: 'select', options: ['frame', 'lens'], default: 'lens' },
    // Hand grip → pane geometry. 'edges': fingertips ARE the four corners
    // (index+thumb per hand — the reel gesture). 'corners': each hand's
    // thumb+index V is a picture-frame CORNER; the pane spans the two apexes
    // with edges running along the finger rays, so it opens far beyond
    // finger length. 'auto' flips on hand orientation (opposed V's =
    // corners). Corner grip needs the 21-pt hand model (armed while this
    // quale is active); without it the pane stays in edge grip.
    // Frame sample: size of the centred screen window squeezed into the
    // pane (1 = the whole screen, hands and all). Lens sample: magnification.
    { id: 'crop',       label: 'crop',       type: 'range', min: 0.15, max: 1, step: 0.05, default: 1 },
    { id: 'zoom',       label: 'zoom',       type: 'range', min: 0.5, max: 2, step: 0.05, default: 1 },
    { id: 'grip',       label: 'grip',       type: 'select', options: ['auto', 'edges', 'corners'], default: 'auto' },
    // 'rect': a true rectangle with a steadied, level-snapped angle.
    // 'free': the raw bilinear quad (bowties, skews, folds).
    { id: 'shape',      label: 'shape',      type: 'select', options: ['rect', 'free'], default: 'rect' },
    // Pull toward level near horizontal (0 = off) — rect shape only.
    { id: 'level',      label: 'level',      type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
    // Forward/back hand lean → pane tilt (keystone). 0 = off.
    { id: 'lean',       label: 'lean',       type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
    { id: 'background', label: 'background', type: 'select', options: ['camera', 'void'], default: 'camera' },
    { id: 'palette',    label: 'palette',    type: 'select', options: PALETTE_NAMES, default: 'riso' },
    // Halftone cell / ascii cell / crush block size, px. Bass makes the
    // grain breathe.
    { id: 'dots',       label: 'grain',      type: 'range', min: 3, max: 20, step: 0.5, default: 7,
      modulators: [{ source: 'audio.bass', mode: 'mul', amount: 0.20 }] },
    { id: 'glow',       label: 'glow',       type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.8,
      modulators: [{ source: 'audio.beatPulse', mode: 'add', amount: 0.40 }] },
    { id: 'flicker',    label: 'flicker',    type: 'range', min: 0, max: 1, step: 0.02, default: 0.35,
      modulators: [{ source: 'audio.highsPulse', mode: 'add', amount: 0.25 }] },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks the looks — each step re-inks the pane into a coherent
  // look + palette + background so one knob tours the whole quale.
  autoPhase: {
    steps: [
      { look: 'hologram', palette: 'riso',     background: 'camera', sample: 'frame' },
      { look: 'edges',    palette: 'voidglow', background: 'void',   sample: 'frame' },
      { look: 'ascii',    palette: 'phosphor', background: 'void',   sample: 'frame' },
      { look: 'thermal',  palette: 'gold',     background: 'camera', sample: 'lens' },
      { look: 'crush',    palette: 'riso',     background: 'camera', sample: 'lens' },
      { look: 'window',   palette: 'voidglow', background: 'camera', sample: 'frame' },
    ],
  },

  presets: {
    default:   { look: 'hologram', sample: 'lens',  background: 'camera', palette: 'riso',     crop: 1, zoom: 1, grip: 'auto', shape: 'rect', level: 0.5, lean: 1.0, dots: 7,  glow: 0.8,  flicker: 0.35, reactivity: 1.0 },
    blueprint: { look: 'edges',    sample: 'frame', background: 'void',   palette: 'voidglow', dots: 6,  glow: 1.0,  flicker: 0.20 },
    terminal:  { look: 'ascii',    sample: 'frame', background: 'void',   palette: 'phosphor', dots: 9,  glow: 0.6,  flicker: 0.45 },
    heatpane:  { look: 'thermal',  sample: 'lens',  background: 'camera', palette: 'gold',     dots: 7,  glow: 0.7,  flicker: 0.25 },
    hydra_gate: { look: 'window',   sample: 'frame', background: 'camera', palette: 'voidglow', dots: 7,  glow: 1.1,  flicker: 0.30 },
    crush:     { look: 'crush',    sample: 'lens',  background: 'camera', palette: 'riso',     dots: 12, glow: 0.75, flicker: 0.30 },
  },

  create(canvas, { gl }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    let W = canvas.width, H = canvas.height;

    // Camera texture, seeded 1×1 dark so pre-feed samples are legitimate
    // (same pattern as the Video quale).
    const camTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, camTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([5, 5, 13, 255]));
    gl.bindTexture(gl.TEXTURE_2D, null);

    const glyphTex = bakeGlyphAtlas(gl);
    const hintTex  = bakeTextTex(gl, 'camera off — set pose source to "camera"', 560, 40, 20);

    // Corner state — TL,TR,BR,BL as flat [x0,y0, x1,y1, ...] px. `cur` is
    // the smoothed render state, `tgt` the per-frame target. Pre-allocated;
    // the hot path never allocates.
    const cur = new Float32Array(8);
    const tgt = new Float32Array(8);
    const cyc = new Float32Array(8);   // corner-frame cycle scratch
    const isect = [0, 0];
    let seeded = false;
    let cornersHeld = false;   // grip hysteresis state (auto mode)
    // Smoothed per-side tracking presence (0..1): L drives TL/BL, R TR/BR.
    let presL = 0, presR = 0;
    let leanS = 0;   // smoothed pane tilt (rad, + = top edge away)
    const camMat = new Float32Array(9);

    const scratch = {
      look: 0, sample: 0, background: 0,
      dots: 7, glow: 0.8, flicker: 0.35, zoom: 1,
      paper: PALETTES.riso.paper, inkA: PALETTES.riso.inkA,
      inkB: PALETTES.riso.inkB, edge: PALETTES.riso.edge,
      portalAlpha: 0, spanW: 100, spanH: 40, time: 0, bass: 0,
      winX: 0, winY: 0, winW: 1, winH: 1,
    };
    let audioRef = null;

    // Set target corner i (0 TL, 1 TR, 2 BR, 3 BL) from a normalized
    // camera-frame landmark, through the preview transform.
    function setCorner(arr, i, lmx, lmy) {
      const [x, y] = lmToCanvas(lmx, lmy, W, H);
      arr[i * 2] = x; arr[i * 2 + 1] = y;
    }

    // Idle drift — a slow breathing parallelogram, so the portal stays alive
    // with nobody (or no camera) in frame. Writes all 8 slots of `arr`.
    function idleCorners(arr, t, bass) {
      const cx = W * (0.5 + 0.06 * Math.sin(t * 0.13));
      const cy = H * (0.42 + 0.05 * Math.sin(t * 0.09 + 1.7));
      const th = 0.12 * Math.sin(t * 0.07);
      const hw = W * (0.165 + 0.02 * Math.sin(t * 0.21) + 0.035 * bass);
      const hh = H * (0.058 + 0.012 * Math.sin(t * 0.17 + 0.8));
      writeRect(arr, cx, cy, Math.cos(th), Math.sin(th), hw, hh);
    }

    // Rectangle centred on (cx,cy), unit axis u=(ux,uy) (v = u rotated +90°,
    // pointing screen-down at θ=0), half-extents hw/hh (signed — a negative
    // extent flips the pane). Writes TL,TR,BR,BL.
    function writeRect(arr, cx, cy, ux, uy, hw, hh) {
      const ax = ux * hw, ay = uy * hw;
      const bx = -uy * hh, by = ux * hh;
      arr[0] = cx - ax - bx; arr[1] = cy - ay - by;   // TL
      arr[2] = cx + ax - bx; arr[3] = cy + ay - by;   // TR
      arr[4] = cx + ax + bx; arr[5] = cy + ay + by;   // BR
      arr[6] = cx - ax + bx; arr[7] = cy - ay + by;   // BL
    }

    function wrapA(a, period) { return a - period * Math.round(a / period); }

    // Steadied pane angle. Adaptive one-pole: the rate grows with the error,
    // so detector tremor (a degree or two) barely moves the pane while a
    // deliberate twist catches up in a few frames. `period` is the angle's
    // symmetry (π: a left→right edge; π/2: a frame's axes) — a change of
    // period (grip flip) or a hands-free gap reseeds. Then the level pull:
    // inside ±2·dz of flat the angle is scaled toward 0 (quadratic, so it
    // sits dead level near horizontal and stays continuous at the edge).
    let angS = 0, angPeriod = 0;
    function steadyAngle(raw, period, dt, level) {
      if (period !== angPeriod) { angS = wrapA(raw, period); angPeriod = period; }
      const d = wrapA(raw - angS, period);
      angS = wrapA(angS + d * Math.min(1, dt * (2.5 + 40 * Math.abs(d))), period);
      const dz = level * LEVEL_SNAP;
      return dz > 1e-4 ? angS * Math.min(1, Math.abs(angS) / (2 * dz)) : angS;
    }

    // Edge grip → rectangle: centre = quad centroid, angle = left-side
    // midpoint → right-side midpoint (raise one hand to tilt), extents =
    // the quad's mean spans projected on the steadied axes (signed, so
    // index-below-thumb still flips the pane).
    function rectifyEdges(dt, level) {
      const lx = (tgt[0] + tgt[6]) / 2, ly = (tgt[1] + tgt[7]) / 2;
      const rx = (tgt[2] + tgt[4]) / 2, ry = (tgt[3] + tgt[5]) / 2;
      const tx = (tgt[0] + tgt[2]) / 2, ty = (tgt[1] + tgt[3]) / 2;
      const bx = (tgt[6] + tgt[4]) / 2, by = (tgt[7] + tgt[5]) / 2;
      const th = steadyAngle(Math.atan2(ry - ly, rx - lx), Math.PI, dt, level);
      const ux = Math.cos(th), uy = Math.sin(th);
      const hw = ((rx - lx) * ux + (ry - ly) * uy) / 2;
      const hh = ((bx - tx) * -uy + (by - ty) * ux) / 2;
      writeRect(tgt, (lx + rx) / 2, (ly + ry) / 2, ux, uy, hw, hh);
    }

    // Hand-plane pitch (rad) about the pane's horizontal axis: + = the top
    // edge leans AWAY from the camera. Plane = wrist / index MCP / pinky
    // MCP in 3D camera px (z is frame-width-relative, like x); its normal,
    // flipped to face the lens, is mapped to screen through lmToCanvas
    // (mirror/rotation) and read against the pane's down axis (dvx,dvy).
    // NaN when the hand has no usable depth.
    function handLean(lm, vw, vh, dvx, dvy) {
      const w = lm[HAND_WRIST], a = lm[HAND_INDEX_MCP], b = lm[HAND_PINKY_MCP];
      if (!(Number.isFinite(w.z) && Number.isFinite(a.z) && Number.isFinite(b.z))) return NaN;
      const ax = (a.x - w.x) * vw, ay = (a.y - w.y) * vh, az = (a.z - w.z) * vw;
      const bx = (b.x - w.x) * vw, by = (b.y - w.y) * vh, bz = (b.z - w.z) * vw;
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-6) return NaN;
      if (nz > 0) { nx = -nx; ny = -ny; nz = -nz; }   // smaller z = nearer
      nx /= nl; ny /= nl; nz /= nl;
      const nxy = Math.hypot(nx, ny);
      if (nxy < 1e-6) return 0;
      const [x0, y0] = lmToCanvas(0.5, 0.5, W, H);
      const [x1, y1] = lmToCanvas(0.5 + nx * 0.1, 0.5 + ny * 0.1, W, H);
      const sl = Math.hypot(x1 - x0, y1 - y0) || 1;
      const sv = ((x1 - x0) * dvx + (y1 - y0) * dvy) / sl * nxy;
      return Math.atan2(-sv, -nz);
    }

    // Keystone tgt by tilt phi (+ = top away): the far edge narrows, the
    // near edge widens, and the height foreshortens by cos(phi). Works on
    // any quad (axes from its mean edges), so 'free' shape tilts too.
    function applyLean(phi) {
      const cx = (tgt[0] + tgt[2] + tgt[4] + tgt[6]) / 4;
      const cy = (tgt[1] + tgt[3] + tgt[5] + tgt[7]) / 4;
      let ux = (tgt[2] - tgt[0]) + (tgt[4] - tgt[6]);
      let uy = (tgt[3] - tgt[1]) + (tgt[5] - tgt[7]);
      const ul = Math.hypot(ux, uy);
      if (ul < 1e-3) return;
      ux /= ul; uy /= ul;
      const vx = -uy, vy = ux;
      const s = Math.sin(phi) * LEAN_KEYSTONE, c = Math.cos(phi);
      for (let i = 0; i < 4; i++) {
        const rx = tgt[i * 2] - cx, ry = tgt[i * 2 + 1] - cy;
        const wu = (rx * ux + ry * uy) * (i < 2 ? 1 - s : 1 + s);
        const hv = (rx * vx + ry * vy) * c;
        tgt[i * 2] = cx + ux * wu + vx * hv;
        tgt[i * 2 + 1] = cy + uy * wu + vy * hv;
      }
    }

    // Intersect line P+t·d with line Q+s·e into isect. False when parallel.
    function lineIntersect(px_, py_, dx, dy, qx, qy, ex, ey) {
      const det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-6) return false;
      const t = ((qx - px_) * ey - (qy - py_) * ex) / det;
      isect[0] = px_ + t * dx; isect[1] = py_ + t * dy;
      return true;
    }

    // Corner-frame grip: each hand's thumb+index V is a picture-frame
    // corner. Apex = index ray × thumb ray per hand; the other two pane
    // corners are the CROSS-hand ray intersections, so the edges run along
    // the fingers and the pane spans the apex diagonal — far beyond finger
    // length. Near-parallel rays or intersections flying off fall back to
    // the axis-aligned rectangle on the apex diagonal. All in screen px
    // (post-lmToCanvas) so the frame is what the audience actually sees.
    function cornerFrameTargets(liX, liY, ltX, ltY, libX, libY, ltbX, ltbY,
                                riX, riY, rtX, rtY, ribX, ribY, rtbX, rtbY,
                                rect, dt, level) {
      const [litx, lity] = lmToCanvas(liX, liY, W, H);
      const [libx, liby] = lmToCanvas(libX, libY, W, H);
      const [lttx, ltty] = lmToCanvas(ltX, ltY, W, H);
      const [ltbx, ltby] = lmToCanvas(ltbX, ltbY, W, H);
      const [ritx, rity] = lmToCanvas(riX, riY, W, H);
      const [ribx, riby] = lmToCanvas(ribX, ribY, W, H);
      const [rttx, rtty] = lmToCanvas(rtX, rtY, W, H);
      const [rtbx, rtby] = lmToCanvas(rtbX, rtbY, W, H);
      // Finger ray directions, base (MCP) → tip.
      const lidx = litx - libx, lidy = lity - liby;
      const ltdx = lttx - ltbx, ltdy = ltty - ltby;
      let ridx = ritx - ribx, ridy = rity - riby;
      let rtdx = rttx - rtbx, rtdy = rtty - rtby;
      // Apex per hand; the web midpoint when the rays are near-parallel.
      // The det threshold alone can't catch a RELAXED hand (thumb almost
      // parallel to index): the intersection exists but lands thousands of
      // px offscreen, so clamp any apex that flies further than a fraction
      // of the screen from the physical web — an apex is a hand feature and
      // can never legitimately be far from the hand.
      const apexFar = Math.hypot(W, H) * 0.25;
      const lwx = (libx + ltbx) / 2, lwy = (liby + ltby) / 2;
      const rwx = (ribx + rtbx) / 2, rwy = (riby + rtby) / 2;
      let ax = lwx, ay = lwy, bx = rwx, by = rwy;
      if (lineIntersect(libx, liby, lidx, lidy, ltbx, ltby, ltdx, ltdy) &&
          Math.hypot(isect[0] - lwx, isect[1] - lwy) < apexFar) {
        ax = isect[0]; ay = isect[1];
      }
      if (lineIntersect(ribx, riby, ridx, ridy, rtbx, rtby, rtdx, rtdy) &&
          Math.hypot(isect[0] - rwx, isect[1] - rwy) < apexFar) {
        bx = isect[0]; by = isect[1];
      }
      if (rect) {
        // Rectangle on the apex diagonal. Its angle is the length-weighted
        // mean of all four finger rays mod 90° (averaged as 4θ) — far
        // steadier than letting each noisy ray place a corner.
        let C = 0, S = 0;
        const acc = (dx, dy) => {
          const a = 4 * Math.atan2(dy, dx), w = Math.hypot(dx, dy);
          C += w * Math.cos(a); S += w * Math.sin(a);
        };
        acc(lidx, lidy); acc(ltdx, ltdy); acc(ridx, ridy); acc(rtdx, rtdy);
        const th = steadyAngle(Math.atan2(S, C) / 4, Math.PI / 2, dt, level);
        const ux = Math.cos(th), uy = Math.sin(th);
        const dx = bx - ax, dy = by - ay;
        const du = dx * ux + dy * uy, dv = dx * -uy + dy * ux;
        cyc[0] = ax;            cyc[1] = ay;
        cyc[2] = ax + ux * du;  cyc[3] = ay + uy * du;
        cyc[4] = bx;            cyc[5] = by;
        cyc[6] = ax - uy * dv;  cyc[7] = ay + ux * dv;
        orderCycle();
        return;
      }
      // Cross-hand corners: each L ray meets the R ray most perpendicular
      // to it. A 180°-turned V pairs index × thumb; a real director's frame
      // (left L + right hand turned 90°, mirror-image hands) pairs index ×
      // index and thumb × thumb — swap the R rays so one code path serves.
      const nli = Math.hypot(lidx, lidy) || 1;
      const cIdx = Math.abs(lidx * ridx + lidy * ridy) / (nli * (Math.hypot(ridx, ridy) || 1));
      const cThb = Math.abs(lidx * rtdx + lidy * rtdy) / (nli * (Math.hypot(rtdx, rtdy) || 1));
      if (cIdx < cThb) {
        const tx = ridx, ty = ridy;
        ridx = rtdx; ridy = rtdy; rtdx = tx; rtdy = ty;
      }
      const far = Math.hypot(W, H) * 1.6;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      let p1x, p1y, p2x, p2y;
      if (lineIntersect(ax, ay, lidx, lidy, bx, by, rtdx, rtdy) &&
          Math.hypot(isect[0] - mx, isect[1] - my) < far) {
        p1x = isect[0]; p1y = isect[1];
      } else { p1x = ax; p1y = by; }
      if (lineIntersect(ax, ay, ltdx, ltdy, bx, by, ridx, ridy) &&
          Math.hypot(isect[0] - mx, isect[1] - my) < far) {
        p2x = isect[0]; p2y = isect[1];
      } else { p2x = bx; p2y = ay; }
      // Cycle A → P1 → B → P2 (neighbors share an edge line). Rotate the
      // cycle so the top-left-most corner leads and the top edge runs
      // left→right — 'frame' content stays upright whichever hand owns
      // which corner, and either hand can be either corner.
      cyc[0] = ax;  cyc[1] = ay;  cyc[2] = p1x; cyc[3] = p1y;
      cyc[4] = bx;  cyc[5] = by;  cyc[6] = p2x; cyc[7] = p2y;
      orderCycle();
    }

    // Write the cyc corner cycle into tgt as TL,TR,BR,BL (see above).
    function orderCycle() {
      let i0 = 0, bestS = Infinity;
      for (let i = 0; i < 4; i++) {
        const ss = cyc[i * 2] + cyc[i * 2 + 1];
        if (ss < bestS) { bestS = ss; i0 = i; }
      }
      const fwd = cyc[((i0 + 1) & 3) * 2] >= cyc[((i0 + 3) & 3) * 2];
      for (let i = 0; i < 4; i++) {
        const src = fwd ? (i0 + i) & 3 : (i0 - i + 4) & 3;
        tgt[i * 2] = cyc[src * 2]; tgt[i * 2 + 1] = cyc[src * 2 + 1];
      }
    }

    function update(field) {
      const { dt, time, pose, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      audioRef = audio;

      scratch.time    = time;
      scratch.look    = Math.max(0, LOOKS.indexOf(params.look));
      scratch.sample  = params.sample === 'lens' ? 1 : 0;
      scratch.background = params.background === 'void' ? 1 : 0;
      scratch.dots    = params.dots;
      scratch.glow    = params.glow;
      scratch.flicker = params.flicker;
      scratch.bass    = audio.bands.bass;
      const pal = PALETTES[params.palette] || PALETTES.riso;
      scratch.paper = pal.paper; scratch.inkA = pal.inkA;
      scratch.inkB = pal.inkB;   scratch.edge = pal.edge;

      // ── Corner targets ──────────────────────────────────────────────────
      // Pose-model fingertips first (15 fps, pre-smoothed, lingered)…
      const person = pose.people[0];
      const raw = person && person.raw;
      let gotL = false, gotR = false;
      let handsL = false, handsR = false;       // side came from the hand model
      let liX = 0, liY = 0, ltX = 0, ltY = 0;   // left index / thumb tips (cam-frame)
      let riX = 0, riY = 0, rtX = 0, rtY = 0;
      // Finger BASE joints (MCPs) — only the hand model provides these; they
      // anchor the rays the corner-frame grip needs.
      let libX = 0, libY = 0, ltbX = 0, ltbY = 0;
      let ribX = 0, ribY = 0, rtbX = 0, rtbY = 0;
      let lmL = null, lmR = null;   // per-side hand-model landmarks (lean)
      if (raw && raw.length >= 33) {
        const li = raw[LM_L_INDEX], lt = raw[LM_L_THUMB];
        const ri = raw[LM_R_INDEX], rt = raw[LM_R_THUMB];
        if (li && (li.visibility ?? 0) > 0.25) {
          gotL = true;
          liX = li.x; liY = li.y;
          const tOk = lt && (lt.visibility ?? 0) > 0.2;
          ltX = tOk ? lt.x : li.x; ltY = tOk ? lt.y : li.y + 0.08;
        }
        if (ri && (ri.visibility ?? 0) > 0.25) {
          gotR = true;
          riX = ri.x; riY = ri.y;
          const tOk = rt && (rt.visibility ?? 0) > 0.2;
          rtX = tOk ? rt.x : ri.x; rtY = tOk ? rt.y : ri.y + 0.08;
        }
      }

      // …refined by the 21-point HandLandmarker when gesture detection
      // (horns 🤘) has it running and the result is fresh. Hands are matched
      // to a body side by nearest pose wrist, falling back to frame-x.
      const hands = pose.hands;
      if (hands && Array.isArray(hands.landmarks) && hands.landmarks.length &&
          performance.now() - (hands.t || 0) < HANDS_FRESH_MS) {
        const wl = person && person.wrists && person.wrists.l;
        const wr = person && person.wrists && person.wrists.r;
        // Hands are RAW camera coords while people[] (the fallback tier and
        // the wrist matcher below) are pose-scaled about the frame centre —
        // apply the same transform so both tiers land in one space.
        const ps = pose.poseScale || 1;
        const sc = (v) => 0.5 + (v - 0.5) * ps;
        for (let i = 0; i < hands.landmarks.length && i < 2; i++) {
          const lm = hands.landmarks[i];
          if (!lm || lm.length < 21) continue;
          const wx = sc(lm[HAND_WRIST].x), wy = sc(lm[HAND_WRIST].y);
          let isLeft;
          if (wl && wr && (wl.visibility ?? 0) > 0.2 && (wr.visibility ?? 0) > 0.2) {
            const dl = (wx - wl.x) ** 2 + (wy - wl.y) ** 2;
            const dr = (wx - wr.x) ** 2 + (wy - wr.y) ** 2;
            isLeft = dl <= dr;
          } else {
            isLeft = wx >= 0.5;   // camera-frame is mirrored on screen
          }
          if (isLeft) {
            gotL = true; handsL = true; lmL = lm;
            liX = sc(lm[HAND_INDEX_TIP].x); liY = sc(lm[HAND_INDEX_TIP].y);
            ltX = sc(lm[HAND_THUMB_TIP].x); ltY = sc(lm[HAND_THUMB_TIP].y);
            libX = sc(lm[HAND_INDEX_MCP].x); libY = sc(lm[HAND_INDEX_MCP].y);
            ltbX = sc(lm[HAND_THUMB_MCP].x); ltbY = sc(lm[HAND_THUMB_MCP].y);
          } else {
            gotR = true; handsR = true; lmR = lm;
            riX = sc(lm[HAND_INDEX_TIP].x); riY = sc(lm[HAND_INDEX_TIP].y);
            rtX = sc(lm[HAND_THUMB_TIP].x); rtY = sc(lm[HAND_THUMB_TIP].y);
            ribX = sc(lm[HAND_INDEX_MCP].x); ribY = sc(lm[HAND_INDEX_MCP].y);
            rtbX = sc(lm[HAND_THUMB_MCP].x); rtbY = sc(lm[HAND_THUMB_MCP].y);
          }
        }
      }

      // Presence envelopes — ease in/out so a lost hand never snaps the pane.
      const kp = Math.min(1, dt * 3.5);
      presL += ((gotL ? 1 : 0) - presL) * kp;
      presR += ((gotR ? 1 : 0) - presR) * kp;

      // ── Grip: edge pinch vs corner frame ────────────────────────────────
      // Picture-frame corners when EITHER the thumb→index orientations are
      // opposed (two V's pointed at each other, a 180° turn) OR the index
      // fingers cross at roughly a right angle (one hand turned 90°: thumb
      // down, index across — the director's frame). Two matching L's
      // (indices parallel) and the reel pinch (thumb→index vectors
      // parallel) stay edges. Auto flips with hysteresis so a half-rotated
      // hand doesn't flap between grips mid-move. Corner grip needs finger
      // rays, i.e. both sides from the hand model.
      const haveRays = handsL && handsR;
      if (params.grip === 'edges') cornersHeld = false;
      else if (params.grip === 'corners') cornersHeld = true;
      else if (haveRays) {
        const vlx = liX - ltX, vly = liY - ltY;
        const vrx = riX - rtX, vry = riY - rtY;
        const nl = Math.hypot(vlx, vly), nr = Math.hypot(vrx, vry);
        // Index rays (MCP → tip) — aspect-corrected so 'perpendicular'
        // means perpendicular on screen-shaped pixels, not unit squares.
        const v = getVideoEl();
        const asp = v && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 16 / 9;
        const ilx = (liX - libX) * asp, ily = liY - libY;
        const irx = (riX - ribX) * asp, iry = riY - ribY;
        const il = Math.hypot(ilx, ily), ir = Math.hypot(irx, iry);
        if (nl > 1e-4 && nr > 1e-4 && il > 1e-4 && ir > 1e-4) {
          const d = (vlx * vrx + vly * vry) / (nl * nr);
          const ci = Math.abs(ilx * irx + ily * iry) / (il * ir);
          if (d < -0.35 || ci < 0.4) cornersHeld = true;
          else if (d > -0.05 && ci > 0.7) cornersHeld = false;
        }
      }

      // Targets: tracked corners where we have them, idle drift where not.
      // (idle fills tgt first; tracked sides overwrite their two corners.)
      idleCorners(tgt, time, scratch.bass);
      const rect = params.shape !== 'free';
      const level = params.level ?? 0.5;
      if (!(gotL || gotR)) angPeriod = 0;   // hands gone → reseed the angle
      if (cornersHeld && haveRays) {
        cornerFrameTargets(liX, liY, ltX, ltY, libX, libY, ltbX, ltbY,
                           riX, riY, rtX, rtY, ribX, ribY, rtbX, rtbY,
                           rect, dt, level);
      } else {
      if (gotL) { setCorner(tgt, 0, liX, liY); setCorner(tgt, 3, ltX, ltY); }
      if (gotR) { setCorner(tgt, 1, riX, riY); setCorner(tgt, 2, rtX, rtY); }
      // With the default selfie mirror, lmToCanvas puts the performer's
      // left hand on screen-LEFT (mirror behavior), so tracked corners are
      // already ordered left→right. With mirror off the sides land reversed;
      // swap them so u still grows left→right and the pane isn't permanently
      // inside-out. Deliberate vertical crossings (index below thumb) still
      // fold into the bowtie either way.
      if (gotL && gotR && tgt[0] > tgt[2]) {
        for (let i = 0; i < 4; i++) {
          const a = i, b = i === 0 ? 1 : i === 1 ? 0 : i === 2 ? 3 : 2;
          if (a < b) {
            const ax = tgt[a * 2], ay = tgt[a * 2 + 1];
            tgt[a * 2] = tgt[b * 2]; tgt[a * 2 + 1] = tgt[b * 2 + 1];
            tgt[b * 2] = ax; tgt[b * 2 + 1] = ay;
          }
        }
      }
      if (rect && (gotL || gotR)) rectifyEdges(dt, level);
      }

      // Lean: mean hand-plane pitch of the hand-model hands, deadzoned,
      // gained, clamped, then smoothed (z is the noisiest axis the hand
      // model gives) — eases back to flat when no hand carries depth.
      let leanT = 0;
      const leanGain = params.lean ?? 1;
      if (leanGain > 0 && (lmL || lmR)) {
        const dvx0 = (tgt[6] - tgt[0]) + (tgt[4] - tgt[2]);
        const dvy0 = (tgt[7] - tgt[1]) + (tgt[5] - tgt[3]);
        const dl = Math.hypot(dvx0, dvy0) || 1;
        const v = getVideoEl();
        const vw = v && v.videoWidth > 0 ? v.videoWidth : 16;
        const vh = v && v.videoHeight > 0 ? v.videoHeight : 9;
        let sum = 0, n = 0;
        for (const lm of [lmL, lmR]) {
          if (!lm) continue;
          const a = handLean(lm, vw, vh, dvx0 / dl, dvy0 / dl);
          if (Number.isFinite(a)) { sum += a; n++; }
        }
        if (n) {
          const a = sum / n;
          const m = Math.max(0, Math.abs(a) - LEAN_DEAD) * leanGain;
          leanT = Math.sign(a) * Math.min(LEAN_MAX, m);
        }
      }
      leanS += (leanT - leanS) * Math.min(1, dt * 4);
      if (Math.abs(leanS) > 1e-3) applyLean(leanS);

      // Smooth toward targets — quick enough to ride a hand sweep, slow
      // enough to eat the 15 fps detector cadence. Seed directly on the
      // first frame so the pane doesn't fly in from (0,0).
      if (!seeded) { cur.set(tgt); seeded = true; }
      const k = Math.min(1, dt * 9.0);
      for (let i = 0; i < 8; i++) cur[i] += (tgt[i] - cur[i]) * k;

      // Pane opacity: ghostly while idle, solid while hands drive it.
      const pres = Math.max(presL, presR) * 0.4 + Math.min(presL, presR) * 0.6;
      scratch.portalAlpha = 0.45 + 0.55 * pres;

      // Average spans for dot/cell density (px), clamped so a collapsed
      // pane never divides by ~0.
      const eTop = Math.hypot(cur[2] - cur[0], cur[3] - cur[1]);
      const eBot = Math.hypot(cur[4] - cur[6], cur[5] - cur[7]);
      const eL   = Math.hypot(cur[6] - cur[0], cur[7] - cur[1]);
      const eR   = Math.hypot(cur[4] - cur[2], cur[5] - cur[3]);
      scratch.spanW = Math.max(8, (eTop + eBot) * 0.5);
      scratch.spanH = Math.max(8, (eL + eR) * 0.5);

      // Frame-sample source window: `crop` of the screen, centred (1 = the
      // whole screen squeezed into the pane, the original reel look).
      const crop = params.crop ?? 1;
      const fw = W * crop, fh = H * crop;
      scratch.winX = (W - fw) / 2; scratch.winY = (H - fh) / 2;
      scratch.winW = fw; scratch.winH = fh;
      scratch.zoom = params.zoom ?? 1;
    }

    // Canvas-px (y-down) → video-uv (y-down) affine, honoring the preview's
    // mirror + rotation + cover fit — the inverse of camera.js's
    // drawFittedFrame. Column-major mat3.
    function computeCamMat(vw, vh) {
      const rot = getRotation();
      const mirror = getMirror();
      const rotated = rot === 90 || rot === 270;
      const ew = rotated ? vh : vw, eh = rotated ? vw : vh;
      const s = Math.max(W / ew, H / eh);   // cover
      // R(-rot) in y-down screen space; rot is 0/90/180/270.
      const c = rot === 0 ? 1 : rot === 180 ? -1 : 0;
      const sn = rot === 90 ? -1 : rot === 270 ? 1 : 0;   // sin(-rot)
      const mx = mirror ? -1 : 1;
      // v = vc + (1/s)·R(-rot)·M·(p - center); uv = v / (vw, vh)
      const a11 = (c * mx) / s,  a12 = -sn / s;
      const a21 = (sn * mx) / s, a22 = c / s;
      const cx = W / 2, cy = H / 2;
      const tx = vw / 2 - a11 * cx - a12 * cy;
      const ty = vh / 2 - a21 * cx - a22 * cy;
      camMat[0] = a11 / vw; camMat[1] = a21 / vh; camMat[2] = 0;
      camMat[3] = a12 / vw; camMat[4] = a22 / vh; camMat[5] = 0;
      camMat[6] = tx / vw;  camMat[7] = ty / vh;  camMat[8] = 1;
    }

    function render() {
      const video = getVideoEl();
      const ready = !!(video && video.readyState >= 2 && video.videoWidth > 0);

      gl.viewport(0, 0, W, H);
      gl.clearColor(0.004, 0.004, 0.016, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, camTex);
      if (ready) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        } catch { /* transient decode hiccup — keep last frame */ }
        computeCamMat(video.videoWidth, video.videoHeight);
      }
      gl.uniform1i(U('uVideo'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, glyphTex);
      gl.uniform1i(U('uGlyphs'), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, hintTex);
      gl.uniform1i(U('uHint'), 2);

      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform1f(U('uTime'), scratch.time);
      gl.uniform1f(U('uCamReady'), ready ? 1 : 0);
      gl.uniformMatrix3fv(U('uCamMat'), false, camMat);
      gl.uniform2f(U('uC0'), cur[0], cur[1]);
      gl.uniform2f(U('uC1'), cur[2], cur[3]);
      gl.uniform2f(U('uC2'), cur[4], cur[5]);
      gl.uniform2f(U('uC3'), cur[6], cur[7]);
      gl.uniform2f(U('uQuadSpan'), scratch.spanW, scratch.spanH);
      gl.uniform1f(U('uPortalAlpha'), scratch.portalAlpha);
      gl.uniform1i(U('uLook'), scratch.look);
      gl.uniform1i(U('uSample'), scratch.sample);
      gl.uniform1i(U('uBackground'), scratch.background);
      gl.uniform1f(U('uDots'), scratch.dots);
      gl.uniform1f(U('uGlow'), scratch.glow);
      gl.uniform1f(U('uFlicker'), scratch.flicker);
      gl.uniform1f(U('uZoom'), scratch.zoom);
      gl.uniform4f(U('uFrameWin'), scratch.winX, scratch.winY, scratch.winW, scratch.winH);
      gl.uniform3f(U('uPaper'), scratch.paper[0], scratch.paper[1], scratch.paper[2]);
      gl.uniform3f(U('uInkA'),  scratch.inkA[0],  scratch.inkA[1],  scratch.inkA[2]);
      gl.uniform3f(U('uInkB'),  scratch.inkB[0],  scratch.inkB[1],  scratch.inkB[2]);
      gl.uniform3f(U('uEdge'),  scratch.edge[0],  scratch.edge[1],  scratch.edge[2]);
      if (audioRef) uploadAudioUniforms(gl, U, audioRef);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        seeded = false;   // re-seed corners into the new pixel space
      },
      update,
      render,
      dispose() {
        gl.deleteTexture(camTex);
        gl.deleteTexture(glyphTex);
        gl.deleteTexture(hintTex);
        gl.deleteProgram(prog);
        gl.deleteVertexArray(vao);
      },
    };
  },
};
