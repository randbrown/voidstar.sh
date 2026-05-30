// Slurmcore — the first audio-EFFECTING quale. Where every other fx only
// *reads* field.audio to drive visuals, slurmcore *produces* audio: it taps
// the live lab signal (mic / mix / a dropped file), chops it into rhythmic,
// stuttering, pitched repetitions — the "Slurms" of the meme microgenre —
// and routes the result back out the speakers while folding it into the lab's
// reactivity + recording pipeline. On top sits a deep-fried / compressed
// glitch visual: posterized, pixelated, chromatic, scanlined.
//
// Audio architecture (the novel part — see src/lib/qualia/README.md for why
// the rest of the harness is otherwise read-only):
//   - We own a PRIVATE AudioContext (like sequencer / vocoder) so we stay out
//     of the Strudel mute-patch and Tone master.
//   - Graph:  input → inputGain ─┬─▶ [slurm-chop worklet | fallback gate] ─▶ wetGain ─┐
//                                └────────────────────────────────────────▶ dryGain ─┴▶ outBus
//             outBus ─▶ muteGate(__qualiaBypassMute) ─▶ ctx.destination   (you hear it)
//             outBus ─▶ analyser  ──▶ opts.audioFx.adoptAnalyser('slurmcore')
//                                       (reactivity + recordable mix tap)
//   - A sample-accurate lookahead scheduler (AudioContext clock, NOT rAF)
//     posts grid triggers to the worklet. Beat-synced via field.audio.beat.
//   - Engagement is gated behind a toggle: a browser AudioContext needs a user
//     gesture, and an fx grabbing the mic / making sound unprompted would be
//     surprising. Until engaged, slurmcore is visual-only.
//
// Teardown is the highest-risk path: dispose()/disengage MUST releaseAnalyser,
// clear the scheduler, disconnect nodes and close the ctx, or the recordable
// mix keeps a dead tap and AudioContexts leak across fx swaps.

import {
  compileProgram, makeFullscreenTri, FULLSCREEN_VERT, makeUniformGetter,
} from '../webgl.js';
import { scaleAudio } from '../field.js';

// Vite emits the worklet as a standalone asset and hands back its URL — the
// processor loads over the network into the AudioWorklet global scope.
import slurmWorkletUrl from '../worklets/slurm-chop.js?url';
// Default deep-fry subject — an in-repo, copyright-safe asset. In a plain .js
// module Vite resolves this to a URL string; .astro's image integration would
// hand back { src } instead, so tolerate both.
import logoAsset from '../../../assets/art/logos_alpha/voidstar_logo_0.png';

const DEFAULT_SUBJECT_URL = (logoAsset && logoAsset.src) ? logoAsset.src : logoAsset;

// addModule() is per-AudioContext; memoise so we never double-load and so a
// failed load is remembered (→ fallback gate) for the life of the ctx.
const moduleLoads = new WeakMap();
function ensureWorkletModule(ctx) {
  if (moduleLoads.has(ctx)) return moduleLoads.get(ctx);
  let p;
  if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
    p = Promise.resolve(false);
  } else {
    p = ctx.audioWorklet.addModule(slurmWorkletUrl)
      .then(() => true)
      .catch((err) => {
        console.warn('[qualia] slurm-chop worklet failed to load — using gate fallback:', err);
        return false;
      });
  }
  moduleLoads.set(ctx, p);
  return p;
}

const FRAG = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUv;
out vec4 outColor;

uniform sampler2D uSubject;
uniform sampler2D uText;
uniform vec2  uResolution;
uniform vec2  uSubjectSize;
uniform vec2  uTextSize;
uniform float uTime;
uniform float uPixelate;
uniform float uDisplace;
uniform float uRgbSplit;
uniform float uChroma;
uniform float uHueShift;
uniform float uPosterize;
uniform float uScanlines;
uniform float uNoise;
uniform float uTextJitter;   // beat-driven chromatic split of the wordmark
uniform float uZoomPunch;    // beat-driven zoom-in
uniform float uBass;         // tints the wordmark

float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
vec3 rgb2hsv(vec3 c){
  vec4 K=vec4(0.,-1./3.,2./3.,-1.);
  vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));
  vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));
  float d=q.x-min(q.w,q.y); float e=1e-10;
  return vec3(abs(q.z+(q.w-q.y)/(6.*d+e)), d/(q.x+e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K=vec4(1.,2./3.,1./3.,3.);
  vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www);
  return c.z*mix(K.xxx, clamp(p-K.xxx,0.,1.), c.y);
}
// Contain-fit a normalized uv into a source of the given intrinsic size,
// reporting whether the sample lands inside the source rect.
vec2 containUv(vec2 uv, vec2 srcSize, out float inside){
  float canvasAr = uResolution.x/max(uResolution.y,1.);
  float ar       = srcSize.x/max(srcSize.y,1.);
  vec2 scale = vec2(1.);
  if (ar > canvasAr) scale.y = canvasAr/ar; else scale.x = ar/canvasAr;
  vec2 c = (uv-0.5)/scale + 0.5;
  inside = (c.x>=0.&&c.x<=1.&&c.y>=0.&&c.y<=1.) ? 1.0 : 0.0;
  return c;
}

void main(){
  vec2 uv = vUv;
  uv.y = 1.0 - uv.y;                     // textures scan top-down

  // Beat zoom-punch around center.
  { vec2 q = uv-0.5; q /= max(1.0 + uZoomPunch, 0.001); uv = q + 0.5; }

  // Pixelate (chunky downsample) — the JPEG-block / deep-fry staple.
  if (uPixelate > 0.001){
    float chunks = mix(uResolution.x, 16.0, clamp(uPixelate,0.,1.));
    vec2 cells = max(vec2(6.0), vec2(chunks, chunks*uResolution.y/max(uResolution.x,1.)));
    uv = (floor(uv*cells)+0.5)/cells;
  }
  // Sinusoidal displacement (datamosh wobble).
  if (uDisplace > 0.001){
    float t=uTime;
    vec2 d = vec2(sin(uv.y*16.0+t*1.7)*0.5 + sin(uv.y*43.0+t*0.7)*0.5,
                  cos(uv.x*12.0+t*1.1));
    uv += d*uDisplace*0.05;
  }

  // Subject with chromatic aberration + horizontal RGB split.
  float insS;
  vec2 sUv = clamp(containUv(uv, uSubjectSize, insS), 0.0, 1.0);
  vec2 dir = normalize(sUv-0.5+1e-5);
  float rad = length(sUv-0.5);
  vec2 abOff  = dir*uChroma*0.03*rad;
  vec2 rgbOff = vec2(uRgbSplit,0.0)*0.03;
  vec3 col;
  col.r = texture(uSubject, clamp(sUv-abOff-rgbOff,0.,1.)).r;
  col.g = texture(uSubject, sUv).g;
  col.b = texture(uSubject, clamp(sUv+abOff+rgbOff,0.,1.)).b;
  col *= insS;

  // "SLURMS" wordmark, chromatically jittered, screen-blended on top.
  float insT;
  vec2 tUv = containUv(uv, uTextSize, insT);
  vec2 j = vec2(uTextJitter*0.04, 0.0);
  float tr = texture(uText, clamp(tUv - j, 0., 1.)).r;
  float tg = texture(uText, clamp(tUv,      0., 1.)).r;
  float tb = texture(uText, clamp(tUv + j, 0., 1.)).r;
  vec3 tint = mix(vec3(0.25,1.0,0.35), vec3(1.0,0.2,0.85), clamp(uBass,0.,1.));
  vec3 textCol = vec3(tr,tg,tb) * insT * tint;
  col = 1.0 - (1.0-col)*(1.0-textCol);

  // Deep-fry post: hue shift, posterize, over-saturate, scanlines, noise.
  if (uHueShift > 0.001){ vec3 h=rgb2hsv(col); h.x=fract(h.x+uHueShift); col=hsv2rgb(h); }
  if (uPosterize > 0.001){ float levels=mix(32.0,3.0,clamp(uPosterize,0.,1.)); col=floor(col*levels)/levels; }
  { float lum=dot(col,vec3(0.299,0.587,0.114)); col=clamp(mix(vec3(lum),col,1.0+uPosterize*1.2),0.0,1.0); }
  if (uScanlines > 0.001){ float s=sin(uv.y*uResolution.y*3.14159); col*=mix(1.0,0.6+0.4*s*s,uScanlines); }
  if (uNoise > 0.001){ float nz=hash(uv*uResolution+uTime*60.0); col+=(nz-0.5)*uNoise*0.7; }

  // Faint floor near the page bg (#05050d) so screen-blend reads cleanly.
  outColor = vec4(col + vec3(0.02,0.02,0.05), 1.0);
}
`;

// Bake a "SLURMS" wordmark into a white-on-black texture (red channel is the
// mask the shader reads). Baked once — its resolution is independent of the
// canvas, so resize doesn't touch it.
function bakeTextTexture(gl) {
  const w = 1024, h = 320;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, w, h);
  cx.fillStyle = '#fff';
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.font = `900 200px "JetBrains Mono", ui-monospace, monospace`;
  cx.fillText('SLURMS', w / 2, h / 2 + 8);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  return { tex, w, h };
}

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'slurmcore',
  name: 'Slurmcore',
  contextType: 'webgl2',

  params: [
    { id: 'source',   label: 'source',   type: 'select', options: ['mic', 'mix', 'file'], default: 'mic' },
    { id: 'sync',     label: 'sync',      type: 'select', options: ['beat', 'internal'],   default: 'beat' },
    { id: 'engage',   label: 'engage',    type: 'toggle', default: false },
    { id: 'chopRate', label: 'chop rate', type: 'range',  min: 0.5, max: 16, step: 0.5, default: 4 },
    { id: 'stutter',  label: 'stutter',   type: 'range',  min: 0, max: 1, step: 0.05, default: 0.45,
      modulators: [{ source: 'audio.beatPulse', mode: 'add', amount: 0.0 }] },
    { id: 'pitch',    label: 'pitch',     type: 'range',  min: -12, max: 12, step: 1, default: 0 },
    { id: 'slurmMix', label: 'slurm mix', type: 'range',  min: 0, max: 1, step: 0.05, default: 0.85 },
    { id: 'gate',     label: 'gate',      type: 'range',  min: 0, max: 0.3, step: 0.01, default: 0.04 },
    { id: 'fry',      label: 'deep fry',  type: 'range',  min: 0, max: 1, step: 0.05, default: 0.6,
      modulators: [{ source: 'audio.beatPulse', mode: 'add', amount: 0.0 }] },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  presets: {
    default:    { source: 'mic', sync: 'beat', engage: false, chopRate: 4,  stutter: 0.45, pitch: 0,  slurmMix: 0.85, gate: 0.04, fry: 0.6, reactivity: 1.0 },
    glitchcore: { sync: 'internal', chopRate: 12, stutter: 0.8, pitch: 5, slurmMix: 1.0, gate: 0.02, fry: 1.0 },
    chill:      { chopRate: 2, stutter: 0.2, pitch: -3, slurmMix: 0.5, gate: 0.06, fry: 0.3 },
  },

  async create(canvas, { gl, paramsContainer, audioFx }) {
    const prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    const vao  = makeFullscreenTri(gl);
    const U    = makeUniformGetter(gl, prog);

    // ── Subject texture (deep-fry image) ─────────────────────────────────
    const subjectTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, subjectTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([8, 8, 18, 255]));
    const subjectSize = [1, 1];
    let pendingSubjectImg = null;   // <img> awaiting upload in render()
    let subjectObjectUrl  = null;   // blob: url to revoke

    function loadSubject(url, isBlob) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { pendingSubjectImg = img; };
      img.onerror = () => { setStatus('subject image failed to load'); };
      img.src = url;
      if (isBlob) {
        if (subjectObjectUrl) { try { URL.revokeObjectURL(subjectObjectUrl); } catch {} }
        subjectObjectUrl = url;
      }
    }
    if (DEFAULT_SUBJECT_URL) loadSubject(DEFAULT_SUBJECT_URL, false);

    const text = bakeTextTexture(gl);

    let W = canvas.width, H = canvas.height;

    // ── Scratch read by render(), written by update() ────────────────────
    const scratch = {
      time: 0,
      pixelate: 0, displace: 0, rgbSplit: 0, chroma: 0, hueShift: 0,
      posterize: 0, scanlines: 0, noise: 0, textJitter: 0, zoomPunch: 0, bass: 0,
    };

    // ── Audio engine state ───────────────────────────────────────────────
    // Shared control block read by the lookahead scheduler each wake.
    const audioCtl = {
      mode: 'beat', chopRate: 4, stutter: 0.45, pitch: 0, gate: 0.04,
      beatPeriod: 0.5, snap: false,
    };
    const eng = {
      ctx: null, engaged: false, engaging: false,
      inputGain: null, wetGain: null, dryGain: null, outBus: null,
      muteGate: null, analyser: null, worklet: null, fallbackGate: null,
      inputSrc: null, currentSource: null, lastStream: null,
      fileAB: null, fileBuffer: null,
      slurmMix: 0.85,
      schedTimer: 0, nextNoteTime: 0,
    };

    // Beat tracking for sync:'beat'.
    let lastBeatTime = 0;

    // ── Status line + file/image controls (mounted into the param panel) ──
    const panel = document.createElement('div');
    panel.className = 'qp-slurmcore-panel';
    panel.style.cssText = 'grid-column: 1 / -1; display:flex; flex-direction:column; gap:0.35rem; margin-top:0.35rem; padding-top:0.45rem; border-top:1px dashed var(--border);';

    const status = document.createElement('div');
    status.style.cssText = 'font-size:0.62rem; color:var(--muted); line-height:1.4;';
    function setStatus(msg) { status.textContent = msg; }
    setStatus('not engaged — flip “engage” to start chopping the live signal.');

    const audioRow = document.createElement('label');
    audioRow.style.cssText = 'display:flex; gap:0.3rem; align-items:center; font-size:0.65rem; color:var(--muted);';
    const audioInput = document.createElement('input');
    audioInput.type = 'file';
    audioInput.accept = 'audio/*';
    audioInput.style.cssText = 'flex:1; min-width:0; font-family:var(--font-mono); font-size:0.65rem; color:var(--muted);';
    audioRow.append(document.createTextNode('slurm file'), audioInput);

    const imageRow = document.createElement('label');
    imageRow.style.cssText = 'display:flex; gap:0.3rem; align-items:center; font-size:0.65rem; color:var(--muted);';
    const imageInput = document.createElement('input');
    imageInput.type = 'file';
    imageInput.accept = 'image/*';
    imageInput.style.cssText = 'flex:1; min-width:0; font-family:var(--font-mono); font-size:0.65rem; color:var(--muted);';
    imageRow.append(document.createTextNode('fry image'), imageInput);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:0.58rem; color:var(--muted); line-height:1.4;';
    hint.innerHTML =
      '<strong>mic</strong> chops your live input (enable audio mode mic/all first). ' +
      '<strong>mix</strong> chops the engines too — mute their panels or you’ll hear them doubled. ' +
      '<strong>file</strong> chops a dropped track. Use headphones on mic/mix to avoid feedback. ' +
      'The chopped output is what gets recorded.';

    panel.append(status, audioRow, imageRow, hint);
    paramsContainer?.appendChild(panel);

    audioInput.addEventListener('change', () => {
      const f = audioInput.files && audioInput.files[0];
      if (!f) return;
      f.arrayBuffer().then((ab) => {
        eng.fileAB = ab;
        eng.fileBuffer = null;
        setStatus(`loaded “${f.name}” — set source to “file” and engage.`);
        if (eng.engaged && eng.currentSource === 'file') setSource('file');
      }).catch(() => setStatus('could not read audio file'));
    });
    imageInput.addEventListener('change', () => {
      const f = imageInput.files && imageInput.files[0];
      if (!f) return;
      loadSubject(URL.createObjectURL(f), true);
    });

    // ── Lookahead scheduler — runs on the AudioContext clock ──────────────
    function scheduleTick() {
      const ctx = eng.ctx;
      if (!ctx || !eng.engaged) return;
      const sr = ctx.sampleRate;
      let period = audioCtl.mode === 'beat'
        ? Math.max(0.03, audioCtl.beatPeriod * 0.5)        // eighth-notes
        : 1 / Math.max(0.5, audioCtl.chopRate);
      if (audioCtl.snap) { eng.nextNoteTime = ctx.currentTime + 0.04; audioCtl.snap = false; }
      if (eng.nextNoteTime < ctx.currentTime) eng.nextNoteTime = ctx.currentTime + 0.02;

      const repeats = 1 + Math.round(audioCtl.stutter * 7);
      const rate    = Math.pow(2, audioCtl.pitch / 12);
      while (eng.nextNoteTime < ctx.currentTime + 0.12) {
        const t = eng.nextNoteTime;
        const grainFrames = Math.max(64, Math.floor(period * sr / repeats));
        if (eng.worklet) {
          eng.worklet.port.postMessage({
            type: 'trigger', frame: Math.round(t * sr), grainFrames, rate, gate: audioCtl.gate,
          });
        } else if (eng.fallbackGate) {
          // No worklet — schedule a rhythmic amplitude gate (chop without
          // grain-repeat or pitch). Param automation honours the lookahead.
          const g = eng.fallbackGate.gain;
          const onDur = Math.max(0.01, period * (1 - audioCtl.stutter * 0.6));
          try {
            g.setValueAtTime(0.0001, t);
            g.linearRampToValueAtTime(1, t + 0.004);
            g.setValueAtTime(1, t + onDur);
            g.linearRampToValueAtTime(0.0001, t + onDur + 0.01);
          } catch {}
        }
        eng.nextNoteTime += period;
      }
    }

    // ── Input source wiring ───────────────────────────────────────────────
    function detachInput() {
      if (eng.inputSrc) {
        try { eng.inputSrc.disconnect(); } catch {}
        if (typeof eng.inputSrc.stop === 'function') { try { eng.inputSrc.stop(); } catch {} }
      }
      eng.inputSrc = null;
      eng.lastStream = null;
    }

    function setSource(source) {
      const ctx = eng.ctx;
      if (!ctx) return;
      detachInput();
      eng.currentSource = source;
      if (source === 'mic' || source === 'mix') {
        const stream = source === 'mic'
          ? audioFx?.getMicStream?.()
          : audioFx?.getRecordableStream?.();
        if (!stream) {
          setStatus(source === 'mic'
            ? 'no mic — set audio mode to “mic” or “all”, then re-pick source.'
            : 'no live engines — start Strudel / sequencer, then re-pick source.');
          return;
        }
        try {
          eng.inputSrc = ctx.createMediaStreamSource(stream);
          eng.inputSrc.connect(eng.inputGain);
          eng.lastStream = stream;
          setStatus(`chopping ${source} — ${eng.worklet ? 'worklet' : 'gate fallback'} active.`);
        } catch (err) {
          setStatus('could not tap the live stream: ' + (err?.message || err));
        }
      } else if (source === 'file') {
        if (eng.fileBuffer) {
          startFileSource();
        } else if (eng.fileAB) {
          // decodeAudioData detaches the buffer — slice a copy.
          ctx.decodeAudioData(eng.fileAB.slice(0))
            .then((buf) => { eng.fileBuffer = buf; if (eng.currentSource === 'file') startFileSource(); })
            .catch(() => setStatus('could not decode that audio file'));
          setStatus('decoding file…');
        } else {
          setStatus('no file loaded — use the “slurm file” picker above.');
        }
      }
    }

    function startFileSource() {
      const ctx = eng.ctx;
      if (!ctx || !eng.fileBuffer) return;
      const src = ctx.createBufferSource();
      src.buffer = eng.fileBuffer;
      src.loop = true;
      src.connect(eng.inputGain);
      try { src.start(); } catch {}
      eng.inputSrc = src;
      setStatus(`chopping file — ${eng.worklet ? 'worklet' : 'gate fallback'} active.`);
    }

    function applyMix() {
      if (!eng.engaged) return;
      const wet = eng.slurmMix, dry = 1 - eng.slurmMix;
      if (eng.wetGain) eng.wetGain.gain.value = wet;
      if (eng.dryGain) eng.dryGain.gain.value = dry;
    }

    // ── Engage / disengage ────────────────────────────────────────────────
    async function engage(source) {
      if (eng.engaged || eng.engaging) return;
      if (!audioFx || typeof audioFx.adoptAnalyser !== 'function') {
        setStatus('audio-fx bridge unavailable in this build — visuals only.');
        return;
      }
      eng.engaging = true;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC();
        eng.ctx = ctx;
        try { await ctx.resume(); } catch {}

        eng.inputGain = ctx.createGain();
        eng.wetGain   = ctx.createGain();
        eng.dryGain   = ctx.createGain();
        eng.outBus    = ctx.createGain();
        eng.muteGate  = ctx.createGain();
        eng.muteGate.__qualiaBypassMute = true; // stay live through Strudel mute
        eng.analyser  = ctx.createAnalyser();
        eng.analyser.fftSize = 1024;
        eng.analyser.smoothingTimeConstant = 0.40;

        // Dry passthrough + bus routing.
        eng.inputGain.connect(eng.dryGain).connect(eng.outBus);
        eng.wetGain.connect(eng.outBus);
        eng.outBus.connect(eng.muteGate).connect(ctx.destination);
        eng.outBus.connect(eng.analyser);

        // Wet path: worklet if it loads, else a scheduled gain gate.
        const ok = await ensureWorkletModule(ctx);
        if (eng.ctx !== ctx) return; // disengaged while loading
        if (ok) {
          try {
            eng.worklet = new AudioWorkletNode(ctx, 'slurm-chop', { numberOfInputs: 1, numberOfOutputs: 1 });
            eng.inputGain.connect(eng.worklet).connect(eng.wetGain);
          } catch (err) {
            console.warn('[qualia] slurm-chop node init failed — gate fallback:', err);
            eng.worklet = null;
          }
        }
        if (!eng.worklet) {
          eng.fallbackGate = ctx.createGain();
          eng.fallbackGate.gain.value = 0.0001;
          eng.inputGain.connect(eng.fallbackGate).connect(eng.wetGain);
        }

        eng.engaged = true;
        applyMix();
        audioFx.adoptAnalyser(ctx, eng.analyser);
        setSource(source);

        eng.nextNoteTime = ctx.currentTime + 0.1;
        eng.schedTimer = setInterval(scheduleTick, 25);
      } catch (err) {
        console.warn('[qualia] slurmcore engage failed:', err);
        setStatus('engage failed: ' + (err?.message || err));
        await disengage();
      } finally {
        eng.engaging = false;
      }
    }

    async function disengage() {
      if (eng.schedTimer) { clearInterval(eng.schedTimer); eng.schedTimer = 0; }
      try { audioFx?.releaseAnalyser?.(); } catch {}
      detachInput();
      for (const n of [eng.worklet, eng.fallbackGate, eng.wetGain, eng.dryGain, eng.outBus, eng.muteGate, eng.analyser, eng.inputGain]) {
        if (n) { try { n.disconnect(); } catch {} }
      }
      const ctx = eng.ctx;
      eng.worklet = eng.fallbackGate = eng.wetGain = eng.dryGain = null;
      eng.outBus = eng.muteGate = eng.analyser = eng.inputGain = null;
      eng.ctx = null; eng.engaged = false; eng.currentSource = null;
      if (ctx) { try { await ctx.close(); } catch {} }
      setStatus('not engaged — flip “engage” to start chopping the live signal.');
    }

    function update(field) {
      const p = field.params;
      const audio = scaleAudio(field.audio, p.reactivity);
      scratch.time = field.time;

      // Engage gating.
      if (p.engage && !eng.engaged && !eng.engaging) {
        engage(p.source);
      } else if (!p.engage && (eng.engaged || eng.engaging)) {
        disengage();
      }

      // Live control while engaged.
      if (eng.engaged) {
        if (p.source !== eng.currentSource) {
          setSource(p.source);
        } else if ((p.source === 'mic' || p.source === 'mix') && !eng.inputSrc) {
          // Stream may have come online after engage (user enabled the mic).
          const s = p.source === 'mic' ? audioFx?.getMicStream?.() : audioFx?.getRecordableStream?.();
          if (s && s !== eng.lastStream) setSource(p.source);
        }
        eng.slurmMix = p.slurmMix;
        applyMix();
        audioCtl.mode     = p.sync;
        audioCtl.chopRate = p.chopRate;
        audioCtl.stutter  = p.stutter;
        audioCtl.pitch    = p.pitch;
        audioCtl.gate     = p.gate;

        // Beat-sync: track interval between kicks, snap the grid phase.
        if (audio.beat.active) {
          const dtb = field.time - lastBeatTime;
          lastBeatTime = field.time;
          if (dtb > 0.2 && dtb < 2.0) {
            audioCtl.beatPeriod += (dtb - audioCtl.beatPeriod) * 0.3;
          }
          if (audioCtl.mode === 'beat') audioCtl.snap = true;
        }
      }

      // ── Visuals: fold the `fry` param + audio into deep-fry strengths ──
      // Beat pulse drives an extra fry kick + text jitter + zoom punch; with
      // audio off, a slow time shimmer keeps it alive (README idle rule).
      const fry   = Math.min(1.5, p.fry + audio.beat.pulse * 0.4);
      const idle  = 0.5 + 0.5 * Math.sin(field.time * 0.7);
      const ambient = eng.engaged ? 0 : 0.12 * idle; // gentle motion when not engaged
      scratch.pixelate  = Math.min(1, fry * 0.7 + audio.bands.highs * 0.2);
      scratch.displace  = Math.min(1, fry * 0.5 + ambient + audio.bands.bass * 0.3);
      scratch.rgbSplit  = Math.min(1, fry * 0.6 + audio.bands.bass * 0.4);
      scratch.chroma    = Math.min(1, fry * 0.7 + audio.beat.pulse * 0.4);
      scratch.hueShift  = (fry * 0.15 + field.time * 0.02 + audio.bands.mids * 0.2) % 1;
      scratch.posterize = Math.min(1, fry * 0.9);
      scratch.scanlines = Math.min(1, fry * 0.5);
      scratch.noise     = Math.min(1, fry * 0.5 + audio.bands.highs * 0.3);
      scratch.textJitter = Math.min(1, audio.beat.pulse * 0.9 + ambient);
      scratch.zoomPunch  = audio.beat.pulse * 0.06 + ambient * 0.05;
      scratch.bass       = audio.bands.bass;
    }

    function render() {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (pendingSubjectImg) {
        gl.bindTexture(gl.TEXTURE_2D, subjectTex);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pendingSubjectImg);
          subjectSize[0] = pendingSubjectImg.naturalWidth  || 1;
          subjectSize[1] = pendingSubjectImg.naturalHeight || 1;
        } catch {}
        pendingSubjectImg = null;
      }

      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, subjectTex);
      gl.uniform1i(U('uSubject'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, text.tex);
      gl.uniform1i(U('uText'), 1);

      gl.uniform2f(U('uResolution'), W, H);
      gl.uniform2f(U('uSubjectSize'), subjectSize[0], subjectSize[1]);
      gl.uniform2f(U('uTextSize'), text.w, text.h);
      gl.uniform1f(U('uTime'), scratch.time);
      gl.uniform1f(U('uPixelate'),  scratch.pixelate);
      gl.uniform1f(U('uDisplace'),  scratch.displace);
      gl.uniform1f(U('uRgbSplit'),  scratch.rgbSplit);
      gl.uniform1f(U('uChroma'),    scratch.chroma);
      gl.uniform1f(U('uHueShift'),  scratch.hueShift);
      gl.uniform1f(U('uPosterize'), scratch.posterize);
      gl.uniform1f(U('uScanlines'), scratch.scanlines);
      gl.uniform1f(U('uNoise'),     scratch.noise);
      gl.uniform1f(U('uTextJitter'), scratch.textJitter);
      gl.uniform1f(U('uZoomPunch'),  scratch.zoomPunch);
      gl.uniform1f(U('uBass'),       scratch.bass);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() {
        // Audio teardown first — releasing the analyser + closing the ctx is
        // the leak-critical path across fx swaps.
        disengage();
        try { panel.remove(); } catch {}
        if (subjectObjectUrl) { try { URL.revokeObjectURL(subjectObjectUrl); } catch {} }
        gl.deleteTexture(subjectTex);
        gl.deleteTexture(text.tex);
        gl.deleteProgram(prog);
        gl.deleteVertexArray(vao);
      },
    };
  },
};
