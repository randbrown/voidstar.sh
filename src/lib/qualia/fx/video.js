// Video — user-supplied clip (or the live camera) as the visualizer. Plays
// one or more sources (file uploads, direct mp4/webm URLs, or the camera
// feed) into a WebGL2 texture, then runs an audio-reactive glitch fragment
// shader (RGB split, chromatic aberration, displacement, hue shift,
// scanlines, posterize, pixelate, noise) on top.
//
// Source handling:
//   - URL sources: <video> with crossOrigin='anonymous'. Servers that send
//     Access-Control-Allow-Origin can be glitched; ones that don't taint
//     the canvas. We detect the taint (texImage throws SECURITY_ERR) and
//     fall back to a DOM-positioned <video> behind the canvas, so the clip
//     still plays but the glitch FX silently disable themselves with a
//     warning on the offending playlist row.
//   - File sources: URL.createObjectURL on the File. Always canvas-safe.
//   - Camera source: the live feed shared via video.js (getVideoEl). We do
//     NOT own its lifecycle — the user turns the camera on through the topbar
//     pose-source select (or any pose-using quale); this quale just samples
//     whatever stream is flowing. A camera MediaStream is same-origin so it
//     never taints, and the selfie mirror (getMirror) is folded into the
//     shader so the glitched feed matches the rest of the app's orientation.
//     Because the element is shared, the camera source skips every
//     playback-owning write (src / loop / rate / volume) and the dispose
//     teardown — those belong to whoever started the camera.
//
// Playlist persistence: URL + camera entries are saved to localStorage. File
// entries can't be — File objects are unrecoverable across page loads — so
// they fall off on reload. We surface this in the empty-state hint.
//
// Audio map (declarative — see `modulators` on params):
//   audio.bass        → rgbSplit, displace
//   audio.mids        → hueShift
//   audio.highs       → noise
//   audio.beatPulse   → chroma, displace
// Hard-kick advance (same detector as page-init.js) optionally triggers
// the next playlist item when `advance === 'on-kick'`.
//
// YouTube is explicitly not supported — cross-origin iframes can't be
// read into a texture, and proxy-downloading is ToS-grey. To play a YT
// clip, download it externally and upload the file.

import {
  compileProgram, makeFullscreenTri, FULLSCREEN_VERT,
  makeUniformGetter, uploadAudioUniforms,
} from '../webgl.js';
import { scaleAudio } from '../field.js';
import { getVideoEl, getMirror } from '../video.js';


const PLAYLIST_KEY = 'voidstar.qualia.fx.video.playlist';

// First-ever-load seed. Only applied when the localStorage key is *absent*
// (never written), so a user who removes all entries and reloads doesn't
// have their cleared list re-populated. All entries are CORS-friendly
// direct-mp4 links so the glitch shader can actually read them.
const DEFAULT_URLS = [
  { src: 'https://assets.mixkit.co/videos/106/106-720.mp4',   name: 'mixkit · 106' },
  { src: 'https://assets.mixkit.co/videos/17978/17978-720.mp4', name: 'mixkit · 17978' },
  { src: 'https://assets.mixkit.co/videos/45404/45404-720.mp4', name: 'mixkit · 45404' },
  { src: 'https://assets.mixkit.co/videos/25352/25352-720.mp4', name: 'mixkit · 25352' },
];

// Hard-kick detection thresholds — duplicate of the ones in page-init.js so
// 'advance: on-kick' fires on the same beats the page-level glitch buttons do.
// If these drift out of sync the user experience drifts; keep in lockstep.
const KICK_PULSE_THRESH = 0.95;
const KICK_FLOOR        = 0.70;
const KICK_RATIO        = 0.92;
const KICK_DOMINANCE    = 1.15;
const KICK_PEAK_HALF_S  = 6;
const KICK_COOLDOWN_MS  = 1500; // tighter than page-init's 10s — this is per-fx advance, not screen flares

const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform sampler2D uVideo;
uniform vec2  uResolution;     // canvas backing-buffer size (px)
uniform vec2  uVideoSize;      // intrinsic video size (px)
uniform float uTime;
uniform int   uFit;            // 0 cover, 1 contain
uniform float uFlipX;          // 1 = mirror horizontally (camera selfie feed)
uniform float uMix;            // [0,1] blend video vs backdrop
uniform float uPanX;           // screen-space pan (negative = shift video right)
uniform float uPanY;
uniform float uRotation;       // radians
uniform float uZoom;           // 1.0 = identity; >1 = zoom in
uniform float uRgbSplit;
uniform float uChroma;
uniform float uDisplace;
uniform float uHueShift;
uniform float uNoise;
uniform float uScanlines;
uniform float uPosterize;      // 0 = off, > 0 = strength (levels = mix(32,3,p))
uniform float uPixelate;       // 0 = off, 1 = chunky

uniform vec4  uBands;          // (bass, mids, highs, total)
uniform vec2  uBeat;           // (active, pulse)
uniform vec2  uMids;
uniform vec2  uHighs;
uniform float uRms;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// RGB↔HSV — standard Sam Hocevar branchless.
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Map screen-uv (0..1, y-up after the fullscreen vert flip) to the
// video-space uv, honoring fit=cover/contain so the clip is centered and
// aspect-correct. Pixels outside the clip area get a clamped sample
// (we mask them to bg in main()).
vec2 fitUv(vec2 uv, out float inside) {
  vec2 srcAspect = uVideoSize;
  if (srcAspect.x < 1.0 || srcAspect.y < 1.0) { inside = 1.0; return uv; }
  float canvasAr = uResolution.x / max(uResolution.y, 1.0);
  float videoAr  = srcAspect.x   / max(srcAspect.y, 1.0);
  vec2 scale = vec2(1.0);
  if (uFit == 0) {
    // cover — fill the canvas by cropping the longer axis of the source.
    // When videoAr > canvasAr the video is "wider" than the canvas slot,
    // so we crop sides → texture X range is narrower than [0,1] (scaled
    // by canvasAr/videoAr). Symmetric for the videoAr < canvasAr case.
    if (videoAr > canvasAr) scale.x = canvasAr / videoAr;
    else                    scale.y = videoAr / canvasAr;
    vec2 centered = (uv - 0.5) * scale + 0.5;
    inside = 1.0;
    return centered;
  } else {
    // contain — fit the whole video inside; letterbox bars outside.
    // When videoAr > canvasAr the source is wider so we span its full X
    // and shrink Y by videoAr/canvasAr (and centering creates Y bars).
    if (videoAr > canvasAr) scale.y = canvasAr / videoAr;
    else                    scale.x = videoAr / canvasAr;
    vec2 centered = (uv - 0.5) / scale + 0.5;
    // pixels outside [0,1] are the letterbox area
    inside = (centered.x >= 0.0 && centered.x <= 1.0 &&
              centered.y >= 0.0 && centered.y <= 1.0) ? 1.0 : 0.0;
    return centered;
  }
}

void main() {
  vec2 uv = vUv;
  // Y-flip — HTMLVideoElement uploads scan top-down; texture coords are
  // bottom-up by convention. UNPACK_FLIP_Y_WEBGL would handle this but we
  // can't always set it in the same gl state, so flip in the shader.
  uv.y = 1.0 - uv.y;

  // Selfie mirror for the camera source — flip X so the glitched feed reads
  // the same way the rest of the app's camera preview does. Aspect-independent
  // (a pure X flip), so it sits ahead of the view transform without fuss.
  if (uFlipX > 0.5) uv.x = 1.0 - uv.x;

  // View transform — rotate, zoom, pan around frame center (0.5, 0.5).
  // Done in uv-space, so the order is "inverse" of what you'd apply to
  // points: divide by zoom (shrink the visible window → zoom-in), rotate,
  // then translate by negative pan (sample to the left → texture shifts
  // right onscreen, "background follows you" feel).
  {
    vec2 q = uv - 0.5;
    float c = cos(uRotation), s = sin(uRotation);
    q = mat2(c, -s, s, c) * q;
    q /= max(uZoom, 0.001);
    uv = q + 0.5 - vec2(uPanX, -uPanY);
  }

  // Pixelate (quantise lookup uv) — applied AFTER the view transform so the
  // pixel grid sticks to the video, not the screen. With zoom this gives a
  // satisfying "blocks zoom too" feel matching a hardware downsample.
  if (uPixelate > 0.001) {
    float chunks = mix(uResolution.x, 24.0, clamp(uPixelate, 0.0, 1.0));
    vec2 cells = max(vec2(4.0), vec2(chunks, chunks * uResolution.y / max(uResolution.x, 1.0)));
    uv = (floor(uv * cells) + 0.5) / cells;
  }

  // Sinusoidal displacement — drives jelly/datamosh feel. Audio-reactive
  // amplitude via uDisplace which already bakes beatPulse modulation.
  if (uDisplace > 0.001) {
    float t = uTime;
    vec2 d = vec2(
      sin(uv.y * 14.0 + t * 1.3) * 0.5 + sin(uv.y * 41.0 + t * 0.6) * 0.5,
      cos(uv.x * 11.0 + t * 0.9)
    );
    uv += d * uDisplace * 0.04;
  }

  float inside = 1.0;
  vec2 src = fitUv(uv, inside);
  // Clamp lookup so cover-mode wraparound doesn't pull garbage from a
  // tiled sample (textures are CLAMP_TO_EDGE-bound but the math above
  // can produce negative uvs from heavy displacement).
  src = clamp(src, vec2(0.0), vec2(1.0));

  // Per-channel offset for chromatic aberration — radial from center.
  vec2 center = vec2(0.5);
  vec2 dir    = normalize(src - center + 1e-5);
  float radial = length(src - center);
  vec2 abOff  = dir * uChroma * 0.02 * radial;

  // RGB split offset — fixed-direction horizontal split, audio-reactive.
  vec2 rgbOff = vec2(uRgbSplit, 0.0) * 0.018;

  vec3 col;
  col.r = texture(uVideo, src - abOff - rgbOff).r;
  col.g = texture(uVideo, src                  ).g;
  col.b = texture(uVideo, src + abOff + rgbOff).b;

  // Hue shift.
  if (uHueShift > 0.001) {
    vec3 hsv = rgb2hsv(col);
    hsv.x = fract(hsv.x + uHueShift);
    col = hsv2rgb(hsv);
  }

  // Posterize — fewer levels with stronger param.
  if (uPosterize > 0.001) {
    float levels = mix(32.0, 3.0, clamp(uPosterize, 0.0, 1.0));
    col = floor(col * levels) / levels;
  }

  // Scanlines.
  if (uScanlines > 0.001) {
    float s = sin(uv.y * uResolution.y * 3.14159);
    col *= mix(1.0, 0.65 + 0.35 * s * s, uScanlines);
  }

  // Noise — highs-driven static.
  if (uNoise > 0.001) {
    float n = hash(uv * uResolution + uTime * 60.0);
    col += (n - 0.5) * uNoise * 0.6;
  }

  // Backdrop where there's nothing to show (contain letterbox bars).
  vec3 bg = vec3(0.02, 0.02, 0.05);
  col = mix(bg, col, inside);

  // Final mix vs full backdrop — lets the user fade the video out without
  // having to mute / remove sources.
  col = mix(bg, col, clamp(uMix, 0.0, 1.0));

  outColor = vec4(col, 1.0);
}
`;

/** Read the persisted playlist; only URL + camera entries survive across
 *  reloads (a File can't be re-hydrated; a camera carries no src so it round-
 *  trips as a bare marker). Seeds DEFAULT_URLS the first time the key is
 *  missing so newcomers don't land on an empty list. */
function loadPlaylist() {
  const stored = localStorage.getItem(PLAYLIST_KEY);
  if (stored === null) {
    return DEFAULT_URLS.map(e => ({ kind: 'url', src: e.src, name: e.name }));
  }
  try {
    const raw = JSON.parse(stored);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(e => e && (
        (e.kind === 'url' && typeof e.src === 'string') || e.kind === 'camera'
      ))
      .map(e => e.kind === 'camera'
        ? { kind: 'camera', src: '', name: e.name || 'camera' }
        : { kind: 'url', src: e.src, name: e.name || e.src });
  } catch {
    return [];
  }
}

function savePlaylist(entries) {
  const persistable = entries
    .filter(e => e.kind === 'url' || e.kind === 'camera')
    .map(e => e.kind === 'camera'
      ? { kind: 'camera', name: e.name }
      : { kind: 'url', src: e.src, name: e.name });
  try { localStorage.setItem(PLAYLIST_KEY, JSON.stringify(persistable)); } catch {}
}

function shortName(src) {
  try {
    const u = new URL(src);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || u.hostname;
  } catch {
    return src;
  }
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'video',
  name: 'Video',
  contextType: 'webgl2',
  // Most clips top out at 1080p — there's nothing for DPR>1 to add but
  // wasted fragment work on retina displays.
  maxDpr: 1.0,

  // Preset is a real param so autoPhase can address it via setParam — each
  // phase step just sets `preset: <name>` and the qfx applies the named
  // factory snapshot in update(). The dropdown also lets users browse
  // looks manually without digging into the phase button.
  params: [
    { id: 'preset',       label: 'preset',       type: 'select', options: ['default', 'vhs', 'datamosh', 'cinema', 'crush', 'follow'], default: 'default' },
    { id: 'fit',          label: 'fit',          type: 'select', options: ['cover', 'contain'], default: 'cover' },
    { id: 'playbackRate', label: 'playback',     type: 'range',  min: 0.25, max: 2.5, step: 0.05, default: 1.0 },
    { id: 'volume',       label: 'volume',       type: 'range',  min: 0, max: 1, step: 0.02, default: 0 },
    { id: 'loop',         label: 'loop track',   type: 'toggle', default: true },
    { id: 'advance',      label: 'advance',      type: 'select', options: ['loop', 'next', 'random', 'on-kick'], default: 'loop' },
    { id: 'mix',          label: 'mix',          type: 'range',  min: 0, max: 1, step: 0.02, default: 1.0 },

    // Pose-driven view transform — feel: the background follows the body.
    // pose channels are signed [-1,+1] so a base of 0 / 1 + 'add' modulator
    // lands a neutral pose on identity (no offset / no rotation / 1× zoom).
    { id: 'panX',         label: 'pan x',        type: 'range',  min: -0.5, max: 0.5, step: 0.01, default: 0.0,
      modulators: [{ source: 'pose.head.x', mode: 'add', amount: 0.20 }] },
    { id: 'panY',         label: 'pan y',        type: 'range',  min: -0.5, max: 0.5, step: 0.01, default: 0.0,
      modulators: [{ source: 'pose.head.y', mode: 'add', amount: 0.20 }] },
    { id: 'rotation',     label: 'rotation',     type: 'range',  min: -1.5, max: 1.5, step: 0.02, default: 0.0,
      modulators: [{ source: 'pose.shoulderRoll', mode: 'add', amount: 0.50 }] },
    { id: 'zoom',         label: 'zoom',         type: 'range',  min: 0.25, max: 2.5, step: 0.02, default: 1.0,
      modulators: [{ source: 'pose.shoulderSpan', mode: 'add', amount: 0.30 }] },

    { id: 'rgbSplit',     label: 'rgb split',    type: 'range',  min: 0, max: 1, step: 0.02, default: 0.0,
      modulators: [{ source: 'audio.bass', mode: 'add', amount: 0.30 }] },
    { id: 'chroma',       label: 'chromatic',    type: 'range',  min: 0, max: 1, step: 0.02, default: 0.0,
      modulators: [{ source: 'audio.beatPulse', mode: 'add', amount: 0.40 }] },
    // Displace is pose-driven (wristSpread) per request — wide arms = jelly.
    // Signed wristSpread is fine; the shader uses the magnitude direction
    // as a sinusoid phase so negative reads as a flipped flow, still glitchy.
    { id: 'displace',     label: 'displace',     type: 'range',  min: 0, max: 1, step: 0.02, default: 0.0,
      modulators: [{ source: 'pose.wristSpread', mode: 'add', amount: 0.50 }] },
    { id: 'hueShift',     label: 'hue shift',    type: 'range',  min: 0, max: 1, step: 0.01, default: 0.0,
      modulators: [{ source: 'audio.mids', mode: 'add', amount: 0.25 }] },
    { id: 'noise',        label: 'noise',        type: 'range',  min: 0, max: 1, step: 0.02, default: 0.0,
      modulators: [{ source: 'audio.highs', mode: 'add', amount: 0.30 }] },
    { id: 'scanlines',    label: 'scanlines',    type: 'range',  min: 0, max: 1, step: 0.02, default: 0.0 },
    // Minimal audio reactivity on posterize/pixelate per request — dial weight
    // up if you want stronger response, but the spec amount stays subtle.
    { id: 'posterize',    label: 'posterize',    type: 'range',  min: 0, max: 1, step: 0.02, default: 0.0,
      modulators: [{ source: 'audio.beatPulse', mode: 'add', amount: 0.08 }] },
    { id: 'pixelate',     label: 'pixelate',     type: 'range',  min: 0, max: 1, step: 0.02, default: 0.0,
      modulators: [{ source: 'audio.highs', mode: 'add', amount: 0.08 }] },
    { id: 'reactivity',   label: 'reactivity',   type: 'range',  min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // autoPhase walks the preset dropdown — one knob to control all the looks.
  // Each step just flips the `preset` select; the qfx's update() loop sees
  // the change and applies the full preset via opts.applyPreset.
  autoPhase: {
    steps: [
      { preset: 'default' },
      { preset: 'vhs' },
      { preset: 'datamosh' },
      { preset: 'cinema' },
      { preset: 'crush' },
      { preset: 'follow' },
    ],
  },

  // Presets reset ALL non-source params including the pose transform — so
  // a 'cinema' preset is a true clean slate. The 'follow' preset is the
  // pose-following showcase: zero glitch, pure body-driven view transform.
  presets: {
    default:  { fit: 'cover', playbackRate: 1.0, volume: 0, loop: true, advance: 'loop', mix: 1.0,
                panX: 0, panY: 0, rotation: 0, zoom: 1.0,
                rgbSplit: 0.1, chroma: 0.1, displace: 0.0, hueShift: 0.0, noise: 0.0,
                scanlines: 0.1, posterize: 0.0, pixelate: 0.0, reactivity: 1.0 },
    vhs:      { panX: 0, panY: 0, rotation: 0, zoom: 1.0,
                rgbSplit: 0.0, chroma: 0.0, displace: 0.0, hueShift: 0.05,
                noise: 0.4, scanlines: 0.6, posterize: 0.3, pixelate: 0.0, mix: 1.0 },
    datamosh: { panX: 0, panY: 0, rotation: 0, zoom: 1.0,
                rgbSplit: 0.4, chroma: 0.6, displace: 0.7, hueShift: 0.0,
                noise: 0.2, scanlines: 0.0, posterize: 0.0, pixelate: 0.0, mix: 0.95 },
    cinema:   { panX: 0, panY: 0, rotation: 0, zoom: 1.0,
                rgbSplit: 0.0, chroma: 0.0, displace: 0.0, hueShift: 0.0,
                noise: 0.0, scanlines: 0.0, posterize: 0.0, pixelate: 0.0, mix: 1.0 },
    crush:    { panX: 0, panY: 0, rotation: 0, zoom: 1.0,
                rgbSplit: 0.0, chroma: 0.2, displace: 0.0, hueShift: 0.1,
                noise: 0.0, scanlines: 0.0, posterize: 0.7, pixelate: 0.4, mix: 1.0 },
    follow:   { panX: 0, panY: 0, rotation: 0, zoom: 1.0,
                rgbSplit: 0.0, chroma: 0.0, displace: 0.0, hueShift: 0.0,
                noise: 0.0, scanlines: 0.0, posterize: 0.0, pixelate: 0.0, mix: 1.0 },
  },

  async create(canvas, { gl, paramsContainer, applyPreset }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);
    const tex  = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Seed with a single dark pixel so the very first frames before
    // anything's loaded sample legitimately instead of warning.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([5, 5, 13, 255]));

    let W = canvas.width, H = canvas.height;

    // Two video elements for gapless transitions — we 'preload' the next
    // one in the background while the current one is playing.
    function makeVideoEl() {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.playsInline = true;
      v.muted       = true;       // muted by default; volume param unmutes
      v.preload     = 'auto';
      v.loop        = true;       // toggled per-track from params
      // Hidden but in-DOM — Safari needs the element in the document for
      // texImage2D to work reliably with media streams.
      v.style.cssText = 'position:absolute;left:-10000px;top:-10000px;width:2px;height:2px;opacity:0;pointer-events:none;';
      document.body.appendChild(v);
      return v;
    }
    const vidA = makeVideoEl();
    const vidB = makeVideoEl();
    let activeVid = vidA;

    /** @type {{kind:'url'|'file'|'camera', src:string, name:string, file?:File, tainted?:boolean, error?:string}[]} */
    const playlist = loadPlaylist();
    let cursor = 0;
    // True while the active source is the live camera — we then sample the
    // shared element from video.js instead of our own vidA/vidB, and skip
    // every lifecycle write that would belong to the camera's real owner.
    let usingCamera = false;
    // Camera readiness for the source-row badge. Tracked so we only re-render
    // the list on a transition (it's cheap, but not per-frame cheap).
    let cameraLive = false;
    let lastCamReady = null;
    /** The element the texture is uploaded from this frame. */
    function sourceEl() { return usingCamera ? getVideoEl() : activeVid; }

    // DOM-fallback overlay for tainted (CORS-blocked) URLs — when a clip
    // refuses cross-origin reads we can't upload it to the texture, so we
    // composite the <video> element behind the canvas with the qualia host
    // as its container.
    const fallbackVid = document.createElement('video');
    fallbackVid.crossOrigin = 'anonymous';
    fallbackVid.playsInline = true;
    fallbackVid.muted       = true;
    fallbackVid.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;display:none;pointer-events:none;';
    canvas.parentElement?.appendChild(fallbackVid);
    let fallbackActive = false;
    function showFallback(src, fit) {
      fallbackActive = true;
      fallbackVid.style.objectFit = fit === 'contain' ? 'contain' : 'cover';
      if (fallbackVid.src !== src) fallbackVid.src = src;
      fallbackVid.style.display = '';
      fallbackVid.play().catch(() => {});
    }
    function hideFallback() {
      if (!fallbackActive) return;
      fallbackActive = false;
      fallbackVid.pause();
      fallbackVid.removeAttribute('src');
      fallbackVid.load();
      fallbackVid.style.display = 'none';
    }

    // ── Playlist editor UI ───────────────────────────────────────────────
    // Mounted INTO the same paramsContainer the auto-panel uses, but we
    // append AFTER the auto-panel renders, so it sits at the bottom (or
    // wherever the user expects "extra fx UI" to live). The wrapper is
    // tagged so destroy() can clean it up.
    const panel = document.createElement('div');
    panel.className = 'qp-video-panel';
    panel.style.cssText = 'grid-column: 1 / -1; display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.35rem; padding-top: 0.45rem; border-top: 1px dashed var(--border);';

    const heading = document.createElement('div');
    heading.style.cssText = 'font-size: 0.65rem; color: var(--muted); letter-spacing: 0.06em; text-transform: lowercase;';
    heading.textContent = 'sources';
    panel.appendChild(heading);

    // URL add row
    const urlRow = document.createElement('div');
    urlRow.style.cssText = 'display: flex; gap: 0.3rem; align-items: center;';
    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.placeholder = 'paste video URL (mp4, webm, …)';
    urlInput.style.cssText = 'flex: 1; min-width: 0; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: var(--font-mono); font-size: 0.7rem; padding: 0.15rem 0.4rem;';
    const urlAddBtn = document.createElement('button');
    urlAddBtn.type = 'button';
    urlAddBtn.className = 'qp-toggle';
    urlAddBtn.textContent = 'add';
    urlRow.append(urlInput, urlAddBtn);
    panel.appendChild(urlRow);

    // File add row
    const fileRow = document.createElement('label');
    fileRow.style.cssText = 'display: flex; gap: 0.3rem; align-items: center; font-size: 0.65rem; color: var(--muted);';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'video/*';
    fileInput.style.cssText = 'flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 0.65rem; color: var(--muted);';
    fileRow.append(document.createTextNode('upload'), fileInput);
    panel.appendChild(fileRow);

    // Camera-as-source row — adds (or jumps to) the live camera feed so the
    // glitch shader runs on the camera instead of a clip. The camera itself is
    // turned on elsewhere (topbar pose-source); this just routes it in.
    const camRow = document.createElement('div');
    camRow.style.cssText = 'display: flex; gap: 0.3rem; align-items: center;';
    const camAddBtn = document.createElement('button');
    camAddBtn.type = 'button';
    camAddBtn.className = 'qp-toggle';
    camAddBtn.textContent = '＋ use camera';
    camAddBtn.title = 'Glitch the live camera. Turn the camera on via the topbar pose-source select.';
    camRow.append(camAddBtn);
    panel.appendChild(camRow);

    // The actual list rendered as a tight vertical stack.
    const listEl = document.createElement('div');
    listEl.style.cssText = 'display: flex; flex-direction: column; gap: 0.18rem; max-height: 9rem; overflow-y: auto;';
    panel.appendChild(listEl);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size: 0.6rem; color: var(--muted); line-height: 1.4;';
    hint.innerHTML =
      'URLs need CORS (<code>Access-Control-Allow-Origin: *</code>) to be glitched. ' +
      '<strong>assets.mixkit.co</strong> is reliable (see the seeded defaults). ' +
      'Other hosts vary — test a URL by adding it; rows that block CORS get a ' +
      '<em>no-cors</em> badge and still play via DOM fallback (no glitch FX). ' +
      'YouTube is not supported. Uploads are session-only — URLs + camera persist. ' +
      'The camera source glitches the live feed (turn the camera on via the ' +
      'topbar pose-source).';
    panel.appendChild(hint);

    paramsContainer?.appendChild(panel);

    // Surface a one-off error/info message inside the source list rather
    // than alert()-spamming on every CORS hiccup.
    function renderList() {
      listEl.innerHTML = '';
      if (playlist.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size: 0.62rem; color: var(--muted); padding: 0.4rem 0;';
        empty.textContent = '— no sources yet —';
        listEl.appendChild(empty);
        return;
      }
      playlist.forEach((entry, idx) => {
        const row = document.createElement('div');
        const isActive = idx === cursor;
        row.style.cssText = `display: flex; gap: 0.3rem; align-items: center; font-size: 0.66rem; color: ${isActive ? 'var(--text)' : 'var(--muted)'}; padding: 0.15rem 0.25rem; border-radius: 3px; ${isActive ? 'background: var(--surface-2);' : ''}`;

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'qp-toggle';
        playBtn.textContent = isActive ? '●' : '▶';
        playBtn.title = isActive ? 'currently playing' : 'play this source';
        playBtn.style.padding = '0 0.4rem';
        playBtn.addEventListener('click', () => setCursor(idx));

        const name = document.createElement('span');
        name.style.cssText = 'flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono);';
        name.textContent = entry.name + (entry.kind === 'file' ? '  (file)' : '');
        name.title = entry.kind === 'url' ? entry.src : entry.name;

        // Camera rows show a live/off badge so it's obvious whether the feed
        // is actually flowing (the camera is enabled outside this quale).
        if (entry.kind === 'camera') {
          const badge = document.createElement('span');
          const live = isActive && cameraLive;
          badge.textContent = live ? 'live' : 'off';
          badge.title = live
            ? 'Camera feed is live and being glitched.'
            : 'Camera is off — enable it via the topbar pose-source select.';
          badge.style.cssText = `font-size: 0.55rem; padding: 0 0.3rem; border-radius: 3px; ${
            live
              ? 'color: var(--green); border: 1px solid rgba(74,222,128,0.4);'
              : 'color: var(--muted); border: 1px solid var(--border);'
          }`;
          row.appendChild(badge);
        }

        if (entry.tainted) {
          const warn = document.createElement('span');
          warn.textContent = 'no-cors';
          warn.title = 'Server did not send Access-Control-Allow-Origin — video plays but glitch FX are disabled.';
          warn.style.cssText = 'font-size: 0.55rem; color: var(--pink); padding: 0 0.3rem; border: 1px solid rgba(236,72,153,0.4); border-radius: 3px;';
          row.appendChild(warn);
        }
        if (entry.error) {
          const errEl = document.createElement('span');
          errEl.textContent = 'err';
          errEl.title = entry.error;
          errEl.style.cssText = 'font-size: 0.55rem; color: var(--pink); padding: 0 0.3rem; border: 1px solid rgba(236,72,153,0.4); border-radius: 3px;';
          row.appendChild(errEl);
        }

        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'qp-toggle';
        rmBtn.textContent = '✕';
        rmBtn.title = 'remove from list';
        rmBtn.style.padding = '0 0.4rem';
        rmBtn.addEventListener('click', () => removeAt(idx));

        row.append(playBtn, name);
        row.appendChild(rmBtn);
        listEl.appendChild(row);
      });
    }

    function addEntry(entry) {
      playlist.push(entry);
      savePlaylist(playlist);
      // If this is the first entry, start playing it automatically.
      if (playlist.length === 1) setCursor(0);
      else renderList();
    }
    function removeAt(idx) {
      const entry = playlist[idx];
      if (entry?.kind === 'file' && entry.src.startsWith('blob:')) {
        try { URL.revokeObjectURL(entry.src); } catch {}
      }
      playlist.splice(idx, 1);
      savePlaylist(playlist);
      if (playlist.length === 0) {
        cursor = 0;
        usingCamera = false;
        activeVid.pause();
        try { activeVid.removeAttribute('src'); activeVid.load(); } catch {}
        hideFallback();
      } else {
        if (cursor >= playlist.length) cursor = 0;
        else if (idx < cursor) cursor--;
        loadCurrent();
      }
      renderList();
    }
    function setCursor(idx) {
      if (idx < 0 || idx >= playlist.length) return;
      cursor = idx;
      // Bootstrap flag — any explicit setCursor() means we've now loaded a
      // source, so update()'s first-tick bootstrap shouldn't reload it.
      initialLoaded = true;
      loadCurrent();
      renderList();
    }
    function loadCurrent() {
      const entry = playlist[cursor];
      if (!entry) return;
      hideFallback();
      entry.tainted = false;
      entry.error = undefined;
      // Camera source: don't touch src/loop/rate/volume — we don't own the
      // element. Pause our own clip elements so they're not decoding in the
      // background, and let render() sample getVideoEl() instead.
      if (entry.kind === 'camera') {
        usingCamera = true;
        lastCamReady = null;
        try { vidA.pause(); } catch {}
        try { vidB.pause(); } catch {}
        return;
      }
      usingCamera = false;
      activeVid.loop = !!(currentParams.loop && currentParams.advance === 'loop');
      activeVid.playbackRate = currentParams.playbackRate || 1;
      activeVid.muted = (currentParams.volume || 0) <= 0;
      activeVid.volume = Math.max(0, Math.min(1, currentParams.volume || 0));
      try {
        activeVid.src = entry.src;
        activeVid.play().catch((err) => {
          // Autoplay rejection on a brand-new gesture-free context is harmless
          // — the user will click 'play' on the row or the source will fire on
          // the next user interaction.
          if (err?.name !== 'NotAllowedError') {
            entry.error = err?.message || String(err);
            renderList();
          }
        });
      } catch (err) {
        entry.error = err?.message || String(err);
        renderList();
      }
    }

    function advanceNext() {
      if (playlist.length === 0) return;
      const mode = currentParams.advance;
      if (mode === 'loop') {
        // single-track loop — the <video loop> attr handles this; nothing to do.
        return;
      }
      let nextIdx = cursor;
      if (mode === 'random' && playlist.length > 1) {
        do { nextIdx = Math.floor(Math.random() * playlist.length); }
        while (nextIdx === cursor);
      } else {
        nextIdx = (cursor + 1) % playlist.length;
      }
      setCursor(nextIdx);
    }

    // Wire UI events
    urlAddBtn.addEventListener('click', () => {
      const v = urlInput.value.trim();
      if (!v) return;
      addEntry({ kind: 'url', src: v, name: shortName(v) });
      urlInput.value = '';
    });
    urlInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); urlAddBtn.click(); }
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const src = URL.createObjectURL(f);
      addEntry({ kind: 'file', src, name: f.name, file: f });
      fileInput.value = '';
    });
    camAddBtn.addEventListener('click', () => {
      // One camera entry is enough — jump to the existing one if present,
      // otherwise add it and switch to it immediately ("use camera" = now).
      const existing = playlist.findIndex(e => e.kind === 'camera');
      if (existing >= 0) { setCursor(existing); return; }
      playlist.push({ kind: 'camera', src: '', name: 'camera' });
      savePlaylist(playlist);
      setCursor(playlist.length - 1);
    });

    // Auto-advance when a track ends (only fires when video.loop is false).
    function onEnded() {
      if (currentParams.advance === 'on-kick' || currentParams.advance === 'loop') {
        // on-kick: we handle advance in update(); loop should have <video loop>
        // set, so this branch shouldn't fire — defensive only.
        return;
      }
      advanceNext();
    }
    activeVid.addEventListener('ended', onEnded);

    renderList();
    if (playlist.length > 0) {
      // We need the params object before loadCurrent() can configure the
      // element, so defer the initial load to the first update() tick.
    }

    // ── Scratch state read by render() and updated by update() ──────────
    const currentParams = {
      preset: 'default',
      fit: 'cover', loop: true, advance: 'loop', playbackRate: 1, volume: 0,
      mix: 1, panX: 0, panY: 0, rotation: 0, zoom: 1.0,
      rgbSplit: 0, chroma: 0, displace: 0, hueShift: 0, noise: 0,
      scanlines: 0, posterize: 0, pixelate: 0,
    };
    // Preset tracking — when this changes between frames, apply the named
    // preset via the core's full-panel applyPreset machinery so every slider
    // moves in lockstep. Seeded from the *resolved* params on first update().
    let lastPreset = null;
    const scratch = {
      time: 0,
      ready: false,
      videoSize: [1, 1],
    };
    let initialLoaded = false;
    let needsTextureUpdate = false;
    let kickPeak = 0;
    let kickLastFireMs = 0;

    function update(field) {
      const { params, time, dt } = field;
      const audio = scaleAudio(field.audio, params.reactivity);

      // Preset change detection — `preset` is a real param so autoPhase can
      // address it via setParam. When it flips, run the full preset apply
      // path (sliders + field.params + persistence) and bail before reading
      // the rest of the params — they'll be re-read on the next tick after
      // applyPreset has overwritten them.
      if (lastPreset !== params.preset) {
        const prev = lastPreset;
        lastPreset = params.preset;
        // Skip the first-frame "change" — initial null → 'default' would
        // re-apply factory defaults and clobber any persisted user tweaks.
        if (prev !== null && typeof applyPreset === 'function') {
          applyPreset(params.preset);
          // Don't return — we still want playback-affecting params applied
          // this tick. The slider positions will catch up on the next
          // frame's resolveParams pass.
        }
      }

      currentParams.preset       = params.preset;
      currentParams.fit          = params.fit;
      currentParams.loop         = !!params.loop;
      currentParams.advance      = params.advance;
      currentParams.playbackRate = params.playbackRate;
      currentParams.volume       = params.volume;
      currentParams.mix          = params.mix;
      currentParams.panX         = params.panX;
      currentParams.panY         = params.panY;
      currentParams.rotation     = params.rotation;
      currentParams.zoom         = params.zoom;
      currentParams.rgbSplit     = params.rgbSplit;
      currentParams.chroma       = params.chroma;
      currentParams.displace     = params.displace;
      currentParams.hueShift     = params.hueShift;
      currentParams.noise        = params.noise;
      currentParams.scanlines    = params.scanlines;
      currentParams.posterize    = params.posterize;
      currentParams.pixelate     = params.pixelate;
      scratch.time = time;

      // Apply playback-affecting params live (cheap idempotent writes) — but
      // never on the camera, whose element we don't own.
      if (!usingCamera) {
        activeVid.loop = currentParams.loop && currentParams.advance === 'loop';
        activeVid.playbackRate = currentParams.playbackRate;
        activeVid.muted = currentParams.volume <= 0;
        activeVid.volume = Math.max(0, Math.min(1, currentParams.volume));
      }
      if (fallbackActive) {
        fallbackVid.playbackRate = currentParams.playbackRate;
        fallbackVid.muted = currentParams.volume <= 0;
        fallbackVid.volume = Math.max(0, Math.min(1, currentParams.volume));
        fallbackVid.style.objectFit = currentParams.fit === 'contain' ? 'contain' : 'cover';
      }

      // First-ever update() — kick off whichever source is at cursor.
      if (!initialLoaded && playlist.length > 0) {
        initialLoaded = true;
        loadCurrent();
      }

      // Hard-kick detection (same shape as the page-level detector). Used
      // for 'advance: on-kick'.
      const halfLife = KICK_PEAK_HALF_S;
      const decay = Math.pow(0.5, dt / halfLife);
      kickPeak = Math.max(audio.bands.bass, kickPeak * decay);
      const nowMs = performance.now();
      const dominance = audio.bands.bass / Math.max(0.01, Math.max(audio.bands.mids, audio.bands.highs));
      const cooledDown = (nowMs - kickLastFireMs) >= KICK_COOLDOWN_MS;
      const isHardKick =
        audio.beat.active &&
        audio.beat.pulse >= KICK_PULSE_THRESH &&
        audio.bands.bass >= KICK_FLOOR &&
        audio.bands.bass >= kickPeak * KICK_RATIO &&
        dominance >= KICK_DOMINANCE &&
        cooledDown;
      if (isHardKick && currentParams.advance === 'on-kick' && playlist.length > 1) {
        kickLastFireMs = nowMs;
        advanceNext();
      }

      // Texture upload — guard against tainted-canvas exceptions on a
      // CORS-blocked URL. Only attempt when the source has actual frames
      // (readyState ≥ 2 = HAVE_CURRENT_DATA). For the camera we read the
      // shared element; it may be absent/empty until the user turns it on.
      const entry = playlist[cursor];
      const el = sourceEl();
      const elReady = !!el && el.readyState >= 2 && el.videoWidth > 0;
      scratch.ready = usingCamera
        ? elReady
        : (!!entry && !entry.tainted && elReady);
      if (scratch.ready) {
        scratch.videoSize[0] = el.videoWidth;
        scratch.videoSize[1] = el.videoHeight;
        needsTextureUpdate = true;
      } else {
        needsTextureUpdate = false;
      }

      // Camera live/off badge — re-render the source list only on transition.
      if (usingCamera) {
        cameraLive = scratch.ready;
        if (cameraLive !== lastCamReady) { lastCamReady = cameraLive; renderList(); }
      }
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (needsTextureUpdate) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceEl());
        } catch (err) {
          // SecurityError → tainted canvas. Only clips can taint (a camera
          // MediaStream is same-origin); mark the current entry and fall back
          // to a DOM-positioned <video> behind the canvas so it at least plays.
          const entry = playlist[cursor];
          if (!usingCamera && entry && !entry.tainted) {
            entry.tainted = true;
            renderList();
            showFallback(entry.src, currentParams.fit);
            // Keep our shader-side <video> in sync with the fallback so volume / rate stay applied.
            try { activeVid.pause(); } catch {}
          }
          needsTextureUpdate = false;
        }
      }

      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(U('uVideo'), 0);
      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform2f(U('uVideoSize'), scratch.videoSize[0], scratch.videoSize[1]);
      gl.uniform1f(U('uTime'), scratch.time);
      gl.uniform1i(U('uFit'), currentParams.fit === 'contain' ? 1 : 0);
      // Mirror only the camera feed (and only when the app's selfie mirror is
      // on) so the glitched live image faces the same way as everywhere else.
      gl.uniform1f(U('uFlipX'), (usingCamera && getMirror()) ? 1.0 : 0.0);
      gl.uniform1f(U('uMix'), fallbackActive ? 0 : currentParams.mix);
      // View transform — applied to the texture, not the canvas. Still
      // active under fallback would be nice but the DOM-video can't be
      // CSS-transformed easily with pose values updating each frame; keep
      // it shader-only for now.
      const fxScale = fallbackActive ? 0 : 1;
      gl.uniform1f(U('uPanX'),     currentParams.panX     * fxScale);
      gl.uniform1f(U('uPanY'),     currentParams.panY     * fxScale);
      gl.uniform1f(U('uRotation'), currentParams.rotation * fxScale);
      // Zoom can't be zeroed under fallback (would map all pixels to texel 0).
      // Hold it at identity instead.
      gl.uniform1f(U('uZoom'),     fallbackActive ? 1.0 : currentParams.zoom);
      gl.uniform1f(U('uRgbSplit'),  currentParams.rgbSplit  * fxScale);
      gl.uniform1f(U('uChroma'),    currentParams.chroma    * fxScale);
      gl.uniform1f(U('uDisplace'),  currentParams.displace  * fxScale);
      gl.uniform1f(U('uHueShift'),  currentParams.hueShift  * fxScale);
      gl.uniform1f(U('uNoise'),     currentParams.noise     * fxScale);
      gl.uniform1f(U('uScanlines'), currentParams.scanlines * fxScale);
      gl.uniform1f(U('uPosterize'), currentParams.posterize * fxScale);
      gl.uniform1f(U('uPixelate'),  currentParams.pixelate  * fxScale);
      // Audio uniforms (uBands, uBeat, etc) — leave at zero when no audio frame.
      // Cheap to skip; the shader doesn't actually read these for anything yet
      // beyond the standard bundle, but uploading keeps future glsl tweaks
      // wired without a JS round-trip.
      // No-op: omitting uploadAudioUniforms keeps uniforms at their default
      // zero values, which is what we want when audio is off.

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() {
        try { activeVid.pause(); } catch {}
        try { vidA.pause(); vidA.removeAttribute('src'); vidA.load(); vidA.remove(); } catch {}
        try { vidB.pause(); vidB.removeAttribute('src'); vidB.load(); vidB.remove(); } catch {}
        try { fallbackVid.pause(); fallbackVid.removeAttribute('src'); fallbackVid.load(); fallbackVid.remove(); } catch {}
        // Revoke any blob URLs we created so the browser releases them.
        for (const entry of playlist) {
          if (entry.kind === 'file' && entry.src.startsWith('blob:')) {
            try { URL.revokeObjectURL(entry.src); } catch {}
          }
        }
        try { panel.remove(); } catch {}
        gl.deleteTexture(tex);
        gl.deleteProgram(prog);
        gl.deleteVertexArray(vao);
      },
    };
  },
};
