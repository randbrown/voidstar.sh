// syzygy — audio ⇄ video alignment lab. UI + orchestration.
//
// Everything runs client-side: file metadata is sniffed instantly (meta.js),
// the alignment/timeline UI works before any engine exists, and ffmpeg.wasm
// (engine.js) only loads when the user hits render. plan.js decides the
// cheapest quality-preserving pipeline; this module just drives it and keeps
// the human informed.

import { sniffMediaInfo } from './meta.js';
import { computeTimeline, computeGaps, buildPlan, EPS, fmtSec } from './plan.js';
import {
  loadEngine, terminateEngine, stageInput, execStep, probe, pickAudioStream,
  summarizeVideo, summarizeAudio, nearestKeyframe,
} from './engine.js';
import { estimateOffsetBySound } from './sound-align.js';

// ── tiny DOM helper ─────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

const fmtBytes = (n) => n > 1.2e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1.2e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;

function fmtDur(s) {
  if (!Number.isFinite(s)) return '?:??';
  const sign = s < 0 ? '-' : '';
  s = Math.abs(s);
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(1).padStart(4, '0');
  return `${sign}${m}:${sec}`;
}

function fmtClock(epochMs) {
  const d = new Date(epochMs);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// ── state ───────────────────────────────────────────────────────────────
const state = {
  video: null, // { file, url, dur, w, h, clock: {epochMs, source}|null, el }
  audio: null, // { file, url, dur, clock, el }
  align: 'zero',        // 'zero' | 'meta' | 'sound' | 'manual'
  manualOffset: 0,      // s (manual mode)
  adjust: 0,            // s fine nudge on top of zero/meta/sound
  sound: null,          // { offset, z, quality, refined, cappedS } from sound-align
  soundBusy: false,
  soundError: null,
  trimStart: false,
  trimEnd: false,
  keepVideoAudio: false, // fill video-only spans with the video's own audio
  pad: {
    lead: { mode: 'adjacent', time: 0, file: null },
    tail: { mode: 'adjacent', time: 0, file: null },
  },
  audioMode: 'auto',    // 'auto' | 'transcode' | 'copy'
  videoMode: 'auto',    // 'auto' (lossless, keyframe-snap trims) | 'reencode'
  crf: 17,
  preset: 'veryfast',
  testStart: null,      // s into the output; null = auto (start·mid·end sampler)
  testLen: 4,           // s per test slice
  running: false,
  cancelled: false,
  result: null,         // { url, name, size, notes, strategy }
};

/** Effective audio offset (s) on the video's timeline, or null if unknowable. */
function effectiveOffset() {
  if (state.align === 'manual') return state.manualOffset;
  if (state.align === 'zero') return 0 + state.adjust;
  if (state.align === 'sound') {
    return state.sound ? state.sound.offset + state.adjust : null;
  }
  if (state.video?.clock && state.audio?.clock) {
    return (state.audio.clock.epochMs - state.video.clock.epochMs) / 1000 + state.adjust;
  }
  return null;
}

/** Preview timeline from element-sniffed durations (probe refines at render). */
function previewTimeline() {
  const off = effectiveOffset();
  if (!state.video || !state.audio || off === null) return null;
  if (!Number.isFinite(state.video.dur) || !Number.isFinite(state.audio.dur)) return null;
  try {
    return computeTimeline({
      videoDur: state.video.dur, audioDur: state.audio.dur, offset: off,
      trimStart: state.trimStart, trimEnd: state.trimEnd,
    });
  } catch {
    return null; // disjoint window — surfaced by update()
  }
}

// ── init ────────────────────────────────────────────────────────────────
const ui = {};

/** @param {HTMLElement} root */
export function initSyzygy(root) {
  root.append(
    buildSources(),
    buildAlignment(),
    buildWindowOpts(),
    ui.timelineSection = h('section', { class: 'sz-sect', hidden: '' },
      h('h3', {}, 'timeline'),
      ui.timeline = h('div', { class: 'sz-timeline' }),
      ui.timelineSummary = h('div', { class: 'sz-tl-summary' }),
    ),
    buildOutputOpts(),
    buildRender(),
    ui.resultSection = h('section', { class: 'sz-sect', hidden: '' },
      h('h3', {}, 'result'),
      ui.resultBox = h('div', {}),
    ),
  );
  update();
}

// ── sources ─────────────────────────────────────────────────────────────
function buildSources() {
  return h('section', { class: 'sz-sect' },
    h('h3', {}, 'sources'),
    h('div', { class: 'sz-sources' },
      buildDrop('video'),
      buildDrop('audio'),
    ),
  );
}

function buildDrop(kind) {
  const accept = kind === 'video'
    ? 'video/*,.mp4,.mov,.m4v,.webm,.mkv'
    : 'audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus';
  const input = h('input', { type: 'file', accept, hidden: '' });
  input.addEventListener('change', () => { if (input.files[0]) setFile(kind, input.files[0]); input.value = ''; });
  const zone = h('div', { class: 'sz-drop', tabindex: '0', role: 'button',
    'aria-label': `choose ${kind} file` });
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('sz-dropping'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('sz-dropping'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('sz-dropping');
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(kind, f);
  });
  ui[`${kind}Zone`] = zone;
  return h('div', { class: 'sz-drop-wrap' }, zone, input);
}

async function setFile(kind, file) {
  const prev = state[kind];
  if (prev?.url) URL.revokeObjectURL(prev.url);
  const url = URL.createObjectURL(file);
  const el = document.createElement(kind);
  el.preload = 'metadata';
  el.muted = true;
  el.src = url;
  const entry = { file, url, dur: NaN, sniffDur: null, w: 0, h: 0, clock: null, el };
  state[kind] = entry;
  state.result = null;
  state.sound = null; // any sound match belonged to the previous file pair
  state.soundError = null;
  update();

  // The element is the fast path for duration; the byte-sniffer (below) is
  // the fallback when the browser can't parse the codec or the container
  // lacks a duration (MediaRecorder webm, exotic codecs).
  el.addEventListener('loadedmetadata', () => {
    if (state[kind] !== entry) return;
    entry.dur = Number.isFinite(el.duration) ? el.duration : (entry.sniffDur ?? NaN);
    if (kind === 'video') { entry.w = el.videoWidth; entry.h = el.videoHeight; }
    update();
  });
  el.addEventListener('error', () => {
    if (state[kind] !== entry) return;
    if (!Number.isFinite(entry.dur) && entry.sniffDur) entry.dur = entry.sniffDur;
    update();
  });

  try {
    const info = await sniffMediaInfo(file);
    if (state[kind] === entry && info) {
      entry.clock = info.clock;
      entry.sniffDur = info.durationS;
      if (!Number.isFinite(entry.dur) && info.durationS) entry.dur = info.durationS;
      update();
    }
  } catch { /* metadata is optional */ }
}

function renderZone(kind) {
  const zone = ui[`${kind}Zone`];
  const s = state[kind];
  zone.replaceChildren();
  if (!s) {
    zone.append(
      h('div', { class: 'sz-drop-icon' }, kind === 'video' ? '▣' : '∿'),
      h('div', { class: 'sz-drop-label' }, `drop ${kind} here`),
      h('div', { class: 'sz-drop-hint' }, kind === 'video' ? 'mp4 · mov · webm · mkv' : 'mp3 · wav · m4a · flac'),
    );
    return;
  }
  zone.classList.add('sz-has-file');
  const lines = [
    h('div', { class: 'sz-file-name' }, s.file.name),
    h('div', { class: 'sz-file-meta' },
      `${fmtBytes(s.file.size)} · ${Number.isFinite(s.dur) ? fmtDur(s.dur) : 'reading…'}`
      + (kind === 'video' && s.w ? ` · ${s.w}×${s.h}` : '')),
  ];
  lines.push(s.clock
    ? h('div', { class: 'sz-file-clock', title: s.clock.source }, `⏱ ${fmtClock(s.clock.epochMs)}`)
    : h('div', { class: 'sz-file-clock sz-dim' }, '⏱ no capture time in file'));
  const x = h('button', { class: 'sz-x', 'aria-label': `clear ${kind}` }, '×');
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state[kind]?.url) URL.revokeObjectURL(state[kind].url);
    state[kind] = null;
    state.result = null;
    state.sound = null;
    state.soundError = null;
    update();
  });
  zone.append(...lines, x);
}

// ── alignment ───────────────────────────────────────────────────────────
function buildAlignment() {
  const radio = (value, label, descr) => {
    const r = h('input', { type: 'radio', name: 'sz-align', value });
    r.addEventListener('change', () => { state.align = value; update(); });
    ui[`align_${value}`] = r;
    return h('label', { class: 'sz-radio' }, r, h('span', {}, label), h('small', {}, descr));
  };
  ui.manualInput = h('input', { class: 'sz-num', type: 'number', step: '0.001', value: '0', 'data-sz': 'manual-offset' });
  ui.manualInput.addEventListener('input', () => {
    state.manualOffset = Number(ui.manualInput.value) || 0;
    update({ keepFocus: true });
  });
  ui.adjustReadout = h('span', { class: 'sz-adj-readout' }, '0.000s');
  const nudge = (ms) => {
    const b = h('button', { class: 'sz-btn sz-btn-xs' }, `${ms > 0 ? '+' : ''}${Math.abs(ms) >= 1000 ? `${ms / 1000}s` : `${ms}ms`}`);
    b.addEventListener('click', () => {
      if (state.align === 'manual') {
        state.manualOffset = Math.round((state.manualOffset + ms / 1000) * 1000) / 1000;
      } else {
        state.adjust = Math.round((state.adjust + ms / 1000) * 1000) / 1000;
      }
      update();
    });
    return b;
  };
  const zero = h('button', { class: 'sz-btn sz-btn-xs sz-dim' }, 'reset');
  zero.addEventListener('click', () => {
    if (state.align === 'manual') state.manualOffset = 0; else state.adjust = 0;
    update();
  });

  return h('section', { class: 'sz-sect' },
    h('h3', {}, 'alignment'),
    h('div', { class: 'sz-radios' },
      radio('zero', 'together at 0:00', 'both start at the same instant'),
      radio('meta', 'universal clock', 'align by each file’s capture time'),
      radio('sound', 'matching sound', 'correlate transients with the video’s own audio'),
      radio('manual', 'manual', 'type the offset yourself'),
    ),
    ui.metaInfo = h('div', { class: 'sz-meta-info' }),
    ui.soundStatus = h('div', { class: 'sz-sound-status', hidden: '' }),
    ui.soundResult = h('div', { class: 'sz-sound-result' }),
    ui.manualRow = h('div', { class: 'sz-row', hidden: '' },
      h('span', { class: 'sz-lbl' }, 'audio starts at'),
      ui.manualInput, h('span', { class: 'sz-dim' }, 's on the video timeline (negative = audio first)'),
    ),
    h('div', { class: 'sz-row' },
      h('span', { class: 'sz-lbl' }, 'nudge'),
      nudge(-1000), nudge(-100), nudge(-10), nudge(10), nudge(100), nudge(1000), zero,
      ui.adjustReadout,
    ),
    ui.offsetReadout = h('div', { class: 'sz-offset-readout' }),
  );
}

// ── sound alignment (transient correlation) ─────────────────────────────
function setSoundStatus(msg, frac) {
  ui.soundStatus.hidden = false;
  ui.soundStatus.textContent = frac != null ? `${msg} ${Math.round(frac * 100)}%` : msg;
}

/** Correlate the replacement audio against the video's own soundtrack. */
async function analyzeSound() {
  if (state.soundBusy || state.running || !state.video || !state.audio) return;
  state.soundBusy = true;
  state.sound = null;
  state.soundError = null;
  update();
  try {
    const ff = await loadEngine(setSoundStatus);
    const vin = await stageInput(ff, state.video.file, 'sv');
    const ain = await stageInput(ff, state.audio.file, 'sa');
    try {
      let vd = state.video.dur, ad = state.audio.dur;
      if (!(vd > 0)) vd = summarizeVideo(await probe(ff, vin.path), vin.path, NaN).duration;
      if (!(ad > 0)) ad = summarizeAudio(await probe(ff, ain.path), ain.path, NaN).duration;
      if (!(vd > 0) || !(ad > 0)) throw new Error('could not determine stream durations');
      state.sound = await estimateOffsetBySound(ff, vin.path, ain.path, {
        videoDur: vd, audioDur: ad, onStatus: setSoundStatus,
      });
    } finally {
      await vin.cleanup();
      await ain.cleanup();
    }
  } catch (err) {
    if (/RuntimeError|memory access|unreachable|table index/.test(String(err))) terminateEngine();
    state.soundError = err.message?.split('\n')[0] || String(err);
  }
  state.soundBusy = false;
  ui.soundStatus.hidden = true;
  update();
}

function renderSoundResult() {
  ui.soundResult.replaceChildren();
  if (state.soundBusy) return; // the status line is talking
  const again = (label) => {
    const b = h('button', { class: 'sz-btn sz-btn-xs' }, label);
    b.addEventListener('click', () => analyzeSound());
    return b;
  };
  if (state.sound) {
    const s = state.sound;
    ui.soundResult.append(h('div', { class: `sz-sound-hit sz-q-${s.quality}` },
      `♫ matched: audio starts ${s.offset >= 0 ? '+' : ''}${s.offset.toFixed(3)}s on the video timeline · correlation ${s.quality} (${s.z}σ)${s.refined ? '' : ' · coarse only'}`,
      s.cappedS ? h('small', { class: 'sz-dim' }, ` · analyzed the first ${Math.round(s.cappedS / 60)} min`) : null,
      ' ', again('re-analyze'),
    ));
  } else if (state.soundError) {
    ui.soundResult.append(h('div', { class: 'sz-err' }, `♫ ${state.soundError} `, again('retry')));
  }
}

// ── window / trims / pads ───────────────────────────────────────────────
function buildWindowOpts() {
  const checkbox = (key, label, descr) => {
    const c = h('input', { type: 'checkbox', 'data-sz': key });
    c.addEventListener('change', () => { state[key] = c.checked; update(); });
    ui[`${key}Box`] = c;
    return h('label', { class: 'sz-check' }, c, h('span', {}, label), h('small', {}, descr));
  };
  return h('section', { class: 'sz-sect' },
    h('h3', {}, 'output window'),
    h('div', { class: 'sz-checks' },
      checkbox('trimStart', 'trim start', 'start at the later of the two — drop the un-overlapped head'),
      checkbox('trimEnd', 'trim end', 'end at the earlier of the two — drop the un-overlapped tail'),
      checkbox('keepVideoAudio', 'keep original audio', 'where the new audio doesn’t reach, keep the video’s own sound instead of silence'),
    ),
    h('p', { class: 'sz-note' },
      'unchecked, the output keeps the longer side: silence under extra video (unless keeping original audio), a still frame under extra audio.'),
    ui.padPickers = h('div', { class: 'sz-pads' }),
  );
}

function renderPadPicker(side, padDur) {
  const p = state.pad[side];
  const label = side === 'lead' ? 'opening still' : 'closing still';
  const sel = h('select', { class: 'sz-select' },
    h('option', { value: 'adjacent' }, side === 'lead' ? 'first video frame (default)' : 'last video frame (default)'),
    h('option', { value: 'time' }, 'frame at video time…'),
    h('option', { value: 'image' }, 'uploaded image…'),
  );
  sel.value = p.mode;
  sel.addEventListener('change', () => { p.mode = sel.value; update(); });

  const kids = [
    h('div', { class: 'sz-pad-head' },
      h('span', { class: 'sz-lbl' }, label),
      h('span', { class: 'sz-pad-dur' }, `${fmtSec(padDur)}s of still`)),
    sel,
  ];
  if (p.mode === 'time') {
    const t = h('input', { class: 'sz-num', type: 'number', min: '0', step: '0.1', value: String(p.time || 0) });
    t.addEventListener('input', () => { p.time = Math.max(0, Number(t.value) || 0); updatePadThumb(side); });
    kids.push(h('div', { class: 'sz-row' }, t, h('span', { class: 'sz-dim' }, 's into the video')));
  }
  if (p.mode === 'image') {
    const fi = h('input', { type: 'file', accept: 'image/*', hidden: '' });
    fi.addEventListener('change', () => { if (fi.files[0]) { p.file = fi.files[0]; update(); } });
    const pick = h('button', { class: 'sz-btn' }, p.file ? p.file.name : 'choose image…');
    pick.addEventListener('click', () => fi.click());
    kids.push(h('div', { class: 'sz-row' }, pick, fi));
  }
  const thumb = h('canvas', { class: 'sz-pad-thumb', width: '160', height: '90' });
  ui[`padThumb_${side}`] = thumb;
  kids.push(thumb);
  const box = h('div', { class: 'sz-pad' }, ...kids);
  queueMicrotask(() => updatePadThumb(side));
  return box;
}

/** Paint the pad preview from the (already loaded) hidden <video>, or the image. */
let seekChain = Promise.resolve(); // both thumbs share one <video>; serialize seeks
async function updatePadThumb(side) {
  const canvas = ui[`padThumb_${side}`];
  if (!canvas || !state.video) return;
  const ctx = canvas.getContext('2d');
  const p = state.pad[side];
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    if (p.mode === 'image' && p.file) {
      const bmp = await createImageBitmap(p.file);
      drawContain(ctx, bmp, canvas);
      bmp.close?.();
      return;
    }
    if (!Number.isFinite(state.video.dur)) return;
    const t = p.mode === 'time' ? Math.min(p.time || 0, state.video.dur)
      : side === 'lead' ? 0 : Math.max(0, state.video.dur - 0.05);
    seekChain = seekChain.then(async () => {
      const vid = state.video?.el;
      if (!vid) return;
      await seekVideo(vid, t);
      drawContain(ctx, vid, canvas, vid.videoWidth, vid.videoHeight);
    }).catch(() => { /* preview only */ });
    await seekChain;
  } catch { /* preview only */ }
}

function drawContain(ctx, src, canvas, sw, sh) {
  const w = sw || src.width, hgt = sh || src.height;
  if (!w || !hgt) return;
  const sc = Math.min(canvas.width / w, canvas.height / hgt);
  const dw = w * sc, dh = hgt * sc;
  ctx.drawImage(src, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
}

function seekVideo(vid, t) {
  return new Promise((res, rej) => {
    if (Math.abs(vid.currentTime - t) < 0.01 && vid.readyState >= 2) return res();
    const done = () => { cleanup(); res(); };
    const fail = () => { cleanup(); rej(new Error('seek failed')); };
    const cleanup = () => { vid.removeEventListener('seeked', done); vid.removeEventListener('error', fail); };
    vid.addEventListener('seeked', done);
    vid.addEventListener('error', fail);
    vid.currentTime = t;
    setTimeout(fail, 4000);
  });
}

// ── output options ──────────────────────────────────────────────────────
function buildOutputOpts() {
  ui.audioModeSel = h('select', { class: 'sz-select' },
    h('option', { value: 'auto' }, 'auto — copy when lossless-safe, else aac 320k'),
    h('option', { value: 'transcode' }, 'always transcode (aac 320k / vorbis q7)'),
    h('option', { value: 'copy' }, 'stream-copy when possible (incl. mp3-in-mp4)'),
  );
  ui.audioModeSel.addEventListener('change', () => { state.audioMode = ui.audioModeSel.value; update(); });
  ui.videoModeSel = h('select', { class: 'sz-select' },
    h('option', { value: 'auto' }, 'preserve — stream-copy, snap trims to keyframes'),
    h('option', { value: 'reencode' }, 'exact — re-encode (frame-accurate trims, slow)'),
  );
  ui.videoModeSel.addEventListener('change', () => { state.videoMode = ui.videoModeSel.value; update(); });
  ui.crfInput = h('input', { class: 'sz-num', type: 'number', min: '0', max: '35', value: String(state.crf) });
  ui.crfInput.addEventListener('input', () => { state.crf = Math.min(35, Math.max(0, Number(ui.crfInput.value) || 17)); });
  ui.presetSel = h('select', { class: 'sz-select' },
    ...['ultrafast', 'veryfast', 'fast', 'medium'].map((p) => h('option', { value: p }, p)));
  ui.presetSel.value = state.preset;
  ui.presetSel.addEventListener('change', () => { state.preset = ui.presetSel.value; });

  return h('section', { class: 'sz-sect' },
    h('h3', {}, 'fidelity'),
    h('div', { class: 'sz-grid2' },
      h('label', { class: 'sz-field' }, h('span', { class: 'sz-lbl' }, 'video'), ui.videoModeSel),
      h('label', { class: 'sz-field' }, h('span', { class: 'sz-lbl' }, 'audio'), ui.audioModeSel),
    ),
    h('details', { class: 'sz-advanced' },
      h('summary', {}, 're-encode quality (only used when encoding happens)'),
      h('div', { class: 'sz-row' },
        h('span', { class: 'sz-lbl' }, 'crf'), ui.crfInput,
        h('span', { class: 'sz-lbl' }, 'preset'), ui.presetSel,
        h('span', { class: 'sz-dim' }, 'crf 17 ≈ visually lossless · lower = better/bigger'),
      ),
    ),
    ui.planPreview = h('div', { class: 'sz-plan' }),
  );
}

// ── render section ──────────────────────────────────────────────────────
function buildRender() {
  ui.renderBtn = h('button', { class: 'sz-btn sz-btn-primary sz-render' }, 'render');
  ui.renderBtn.addEventListener('click', () => run('full'));
  ui.testBtn = h('button', { class: 'sz-btn', 'data-sz': 'test' }, 'sync check');
  ui.testBtn.addEventListener('click', () => run('test'));
  ui.cancelBtn = h('button', { class: 'sz-btn', hidden: '' }, 'cancel');
  ui.cancelBtn.addEventListener('click', () => {
    state.cancelled = true;
    terminateEngine();
  });
  ui.testStartInput = h('input', {
    class: 'sz-num sz-num-s', type: 'number', min: '0', step: '0.1',
    placeholder: 'auto', 'data-sz': 'test-start',
  });
  ui.testStartInput.addEventListener('input', () => {
    const v = ui.testStartInput.value.trim();
    state.testStart = v === '' ? null : Math.max(0, Number(v) || 0);
  });
  ui.testLenInput = h('input', {
    class: 'sz-num sz-num-s', type: 'number', min: '1', max: '30', step: '1',
    value: String(state.testLen), 'data-sz': 'test-len',
  });
  ui.testLenInput.addEventListener('input', () => {
    state.testLen = Math.min(30, Math.max(1, Number(ui.testLenInput.value) || 4));
  });
  ui.status = h('div', { class: 'sz-status' });
  ui.progressWrap = h('div', { class: 'sz-progress', hidden: '' }, ui.progressBar = h('div', { class: 'sz-progress-bar' }));
  ui.logPre = h('pre', {});
  return h('section', { class: 'sz-sect' },
    h('div', { class: 'sz-row' },
      ui.renderBtn, ui.testBtn,
      h('span', { class: 'sz-dim' }, 'at'), ui.testStartInput,
      h('span', { class: 'sz-dim' }, 's ·'), ui.testLenInput,
      h('span', { class: 'sz-dim' }, 's/slice'),
      ui.cancelBtn),
    h('p', { class: 'sz-note' },
      'sync check renders a fast low-res draft: slices from the start, middle, and end of the overlap stitched together — drift shows up as sync that drifts across the clip. type a start time for a single slice instead.'),
    ui.status,
    ui.progressWrap,
    h('details', { class: 'sz-log' }, h('summary', {}, 'engine log'), ui.logPre),
  );
}

/**
 * Test windows [T, len] in output time. Auto mode samples the start, middle,
 * and end of the audio↔video overlap (drift is invisible at a single point);
 * a short overlap collapses to one slice; a typed start makes one slice there.
 */
function testWindows(t, L, startAt) {
  if (startAt != null) {
    const T = Math.min(Math.max(0, startAt), Math.max(0, t.duration - 1));
    return [[T, Math.min(L, t.duration - T)]];
  }
  const ovS = Math.max(t.audioDelay, t.padLead);
  const ovE = Math.min(t.audioDelay + t.audioUsed, t.padLead + t.videoUsed);
  const s = ovE > ovS ? Math.max(0, ovS) : 0;
  const e = ovE > ovS ? Math.min(t.duration, ovE) : t.duration;
  const dur = e - s;
  if (dur <= L * 2.5) return [[s, Math.min(dur, L * 2.5)]];
  return [
    [s, L],
    [s + dur / 2 - L / 2, L],
    [e - L, L],
  ];
}

function setStatus(msg, kind = '') {
  ui.status.textContent = msg;
  ui.status.dataset.kind = kind;
}

function setProgress(frac) {
  if (frac === null) { ui.progressWrap.hidden = true; return; }
  ui.progressWrap.hidden = false;
  ui.progressBar.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}

const MAX_LOG = 400;
let logLines = [];
function pushLog(line) {
  logLines.push(line);
  if (logLines.length > MAX_LOG) logLines = logLines.slice(-MAX_LOG);
  ui.logPre.textContent = logLines.join('\n');
}

// ── update (refresh dynamic UI from state) ──────────────────────────────
function update(o = {}) {
  renderZone('video');
  renderZone('audio');

  // alignment
  ui[`align_${state.align}`].checked = true;
  const haveClocks = !!(state.video?.clock && state.audio?.clock);
  const haveBoth = !!(state.video && state.audio);
  ui.align_meta.disabled = !haveClocks;
  ui.align_meta.closest('.sz-radio').classList.toggle('sz-disabled', !haveClocks);
  ui.align_sound.disabled = !haveBoth;
  ui.align_sound.closest('.sz-radio').classList.toggle('sz-disabled', !haveBoth);
  if (state.align === 'sound' && !haveBoth) { state.align = 'zero'; ui.align_zero.checked = true; }
  // selecting "matching sound" kicks the analysis off automatically
  if (state.align === 'sound' && haveBoth && !state.sound && !state.soundBusy && !state.soundError) {
    queueMicrotask(() => analyzeSound());
  }
  renderSoundResult();
  ui.metaInfo.replaceChildren();
  if (state.video || state.audio) {
    if (!haveClocks && state.align === 'meta') { state.align = 'zero'; ui.align_zero.checked = true; }
    if (haveClocks) {
      const d = (state.audio.clock.epochMs - state.video.clock.epochMs) / 1000;
      ui.metaInfo.append(h('div', {},
        `clocks: audio ${d >= 0 ? 'starts' : 'started'} ${fmtDur(Math.abs(d))} ${d >= 0 ? 'after' : 'before'} the video · sources: ${state.video.clock.source} ⇄ ${state.audio.clock.source}`));
      ui.metaInfo.append(h('div', { class: 'sz-dim' },
        'device clocks drift and timezones lie — nudge below if it lands off.'));
    } else if (state.video && state.audio) {
      ui.metaInfo.append(h('div', { class: 'sz-dim' }, 'universal clock needs a capture time in both files.'));
    }
  }
  ui.manualRow.hidden = state.align !== 'manual';
  if (!o.keepFocus) ui.manualInput.value = String(state.manualOffset);
  ui.adjustReadout.textContent = state.align === 'manual'
    ? `offset ${state.manualOffset.toFixed(3)}s`
    : `adjust ${state.adjust >= 0 ? '+' : ''}${state.adjust.toFixed(3)}s`;

  const off = effectiveOffset();
  ui.offsetReadout.textContent = off === null
    ? ''
    : `→ audio placed at ${off >= 0 ? '+' : ''}${off.toFixed(3)}s on the video timeline`;

  // timeline + pads + plan preview
  const t = previewTimeline();
  const ready = !!(state.video && state.audio);
  ui.timelineSection.hidden = !ready;
  ui.padPickers.replaceChildren();
  if (t) {
    renderTimeline(t);
    if (t.padLead > EPS) ui.padPickers.append(renderPadPicker('lead', t.padLead));
    if (t.padTail > EPS) ui.padPickers.append(renderPadPicker('tail', t.padTail));
  } else if (ready && off !== null && Number.isFinite(state.video.dur) && Number.isFinite(state.audio.dur)) {
    ui.timeline.replaceChildren(h('div', { class: 'sz-err' }, 'these trims leave no output — the files don’t overlap at this offset.'));
    ui.timelineSummary.textContent = '';
  }
  renderPlanPreview(t);

  // render button
  ui.renderBtn.disabled = !t || state.running || state.soundBusy;
  ui.testBtn.disabled = ui.renderBtn.disabled;
  ui.cancelBtn.hidden = !state.running;
  ui.renderBtn.textContent = state.running ? 'rendering…' : 'render';

  // result
  ui.resultSection.hidden = !state.result;
  if (state.result) renderResult();
}

function renderTimeline(t) {
  const off = effectiveOffset();
  const vd = state.video.dur, ad = state.audio.dur;
  const lo = Math.min(0, off, t.start);
  const hi = Math.max(vd, off + ad, t.end);
  const span = hi - lo || 1;
  const pos = (x) => `${((x - lo) / span * 100).toFixed(2)}%`;
  const width = (a, b) => `${(Math.max(0, b - a) / span * 100).toFixed(2)}%`;

  const row = (label, segs) => h('div', { class: 'sz-tl-row' },
    h('span', { class: 'sz-tl-label' }, label),
    h('div', { class: 'sz-tl-track' }, ...segs));

  const clip = (a, b) => [Math.max(a, t.start), Math.min(b, t.end)];
  const seg = (cls, a, b, title) => h('div', {
    class: `sz-tl-seg ${cls}`, title,
    style: `left:${pos(a)};width:${width(a, b)}`,
  });

  const vSegs = [seg('sz-tl-video sz-tl-off', 0, vd, 'video (unused part dims)')];
  const [vi, vo] = clip(0, vd);
  if (vo > vi) vSegs.push(seg('sz-tl-video', vi, vo, 'video in output'));
  const aSegs = [seg('sz-tl-audio sz-tl-off', off, off + ad, 'audio (unused part dims)')];
  const [ai, ao] = clip(off, off + ad);
  if (ao > ai) aSegs.push(seg('sz-tl-audio', ai, ao, 'audio in output'));

  const oSegs = [seg('sz-tl-out', t.start, t.end, 'output window')];
  if (t.padLead > EPS) oSegs.push(seg('sz-tl-pad', t.start, t.start + t.padLead, 'still-frame pad'));
  if (t.padTail > EPS) oSegs.push(seg('sz-tl-pad', t.end - t.padTail, t.end, 'still-frame pad'));
  const gaps = computeGaps(t);
  if (state.keepVideoAudio) {
    if (gaps.lead > EPS) oSegs.push(seg('sz-tl-fill', t.videoIn, t.videoIn + gaps.lead, 'video’s original audio'));
    if (gaps.tail > EPS) oSegs.push(seg('sz-tl-fill', t.videoOut - gaps.tail, t.videoOut, 'video’s original audio'));
  }

  ui.timeline.replaceChildren(
    row('video', vSegs),
    row('audio', aSegs),
    row('output', oSegs),
  );
  const bits = [`output ${fmtDur(t.duration)}`];
  if (t.padLead > EPS) bits.push(`opening still ${fmtDur(t.padLead)}`);
  if (t.padTail > EPS) bits.push(`closing still ${fmtDur(t.padTail)}`);
  if (t.videoCutStart || t.videoCutEnd) bits.push('video trimmed');
  if (t.audioIn > EPS || t.audioOut < state.audio.dur - EPS) bits.push('audio trimmed');
  if (t.audioDelay > EPS) bits.push(`audio enters at ${fmtDur(t.audioDelay)}`);
  if (gaps.lead > EPS || gaps.tail > EPS) {
    const fills = [gaps.lead > EPS ? fmtDur(gaps.lead) : null, gaps.tail > EPS ? fmtDur(gaps.tail) : null]
      .filter(Boolean).join(' + ');
    bits.push(state.keepVideoAudio ? `original audio fills ${fills}` : `silence under ${fills} of video`);
  } else if (state.keepVideoAudio) {
    bits.push('no video-only span to fill at this alignment');
  }
  ui.timelineSummary.textContent = bits.join(' · ');
}

function renderPlanPreview(t) {
  ui.planPreview.replaceChildren();
  if (!t) return;
  const msgs = [];
  const pads = t.padLead > EPS || t.padTail > EPS;
  if (state.videoMode === 'reencode') {
    msgs.push('video will be re-encoded (exact mode) — slow in-browser, visually faithful.');
  } else if (t.videoCutStart) {
    msgs.push('start trim: snapped to the nearest keyframe so the video can stay stream-copied; audio follows the snap, sync is kept. switch video to "exact" for a frame-accurate cut.');
  } else if (pads) {
    msgs.push('video stays stream-copied; only the still pads are encoded (h264 sources — others fall back to a re-encode).');
  } else {
    msgs.push('video is stream-copied untouched — bit-identical to the source.');
  }
  ui.planPreview.append(h('p', { class: 'sz-note' }, `plan: ${msgs.join(' ')}`));
}

// ── the run ─────────────────────────────────────────────────────────────
async function run(mode = 'full') {
  if (state.running) return;
  const isTest = mode === 'test';
  state.running = true;
  state.cancelled = false;
  state.result = null;
  logLines = [];
  ui.logPre.textContent = '';
  update();

  const cleanups = [];
  const tempFiles = new Set();
  let ff = null;
  try {
    ff = await loadEngine((msg, frac) => { setStatus(msg); setProgress(frac ?? null); });
    setProgress(null);

    // stage inputs
    setStatus('staging files…');
    const vin = await stageInput(ff, state.video.file, 'vin');
    cleanups.push(vin.cleanup);
    const ain = await stageInput(ff, state.audio.file, 'ain');
    cleanups.push(ain.cleanup);

    // probe (authoritative durations/codec data)
    setStatus('probing streams…');
    const vProbe = await probe(ff, vin.path);
    const video = summarizeVideo(vProbe, vin.path, state.video.dur);
    if (!state.video.clock && video.epochMs) state.video.clock = { epochMs: video.epochMs, source: 'container creation_time' };
    const aProbe = await probe(ff, ain.path);
    const audio = summarizeAudio(aProbe, ain.path, state.audio.dur);
    const videoDur = video.duration, audioDur = audio.duration;
    if (!(videoDur > 0) || !(audioDur > 0)) throw new Error('could not determine stream durations');

    const off = effectiveOffset();
    if (off === null) throw new Error('alignment offset is unknown');

    let t = computeTimeline({
      videoDur, audioDur, offset: off,
      trimStart: state.trimStart, trimEnd: state.trimEnd,
    });

    // lossless start trim: snap to a keyframe and let the audio follow
    // (skipped for tests — they re-encode their slices anyway)
    let startIsKeyframe = false;
    if (!isTest && t.videoCutStart && state.videoMode !== 'reencode') {
      setStatus('finding the nearest keyframe…');
      const kf = await nearestKeyframe(ff, vin.path, t.videoIn);
      if (kf !== null) {
        if (Math.abs(kf - t.videoIn) > EPS) {
          pushLog(`[syzygy] start trim snapped ${fmtSec(t.videoIn)}s → keyframe ${fmtSec(kf)}s (audio follows, sync kept)`);
          t = computeTimeline({
            videoDur, audioDur, offset: off,
            trimStart: state.trimStart, trimEnd: state.trimEnd,
            startOverride: kf,
          });
        }
        startIsKeyframe = true;
      } else {
        pushLog('[syzygy] no keyframe found near the trim — falling back to exact re-encode');
      }
    }

    // stage user pad images if selected
    const padOpts = {};
    for (const side of ['lead', 'tail']) {
      const p = state.pad[side];
      const key = side === 'lead' ? 'Lead' : 'Tail';
      if (p.mode === 'image' && p.file) {
        const st = await stageInput(ff, p.file, `pimg-${side}`);
        cleanups.push(st.cleanup);
        padOpts[`pad${key}Image`] = st.path;
      } else if (p.mode === 'time') {
        padOpts[`pad${key}Time`] = p.time || 0;
      }
    }

    const opts = {
      videoMode: state.videoMode === 'reencode' ? 'reencode' : 'auto',
      startIsKeyframe,
      audioMode: state.audioMode,
      keepVideoAudio: state.keepVideoAudio,
      videoHasAudio: !!pickAudioStream(vProbe),
      crf: state.crf, preset: state.preset,
      ...padOpts,
    };
    const base = state.video.file.name.replace(/\.[^.]+$/, '');

    if (isTest) {
      // draft sampler: re-encode each slice fast+small, stitch by stream copy
      const windows = testWindows(t, state.testLen, state.testStart);
      const testOpts = {
        ...opts, videoMode: 'reencode', startIsKeyframe: false,
        crf: 23, preset: 'ultrafast', previewHeight: 480,
      };
      const desc = windows.length > 1
        ? 'start · middle · end of the overlap'
        : `output ${fmtDur(windows[0][0])} → ${fmtDur(windows[0][0] + windows[0][1])}`;
      pushLog(`[syzygy] sync check: ${desc}`);
      const sliceFiles = [];
      let testPlan = null;
      for (let i = 0; i < windows.length; i++) {
        const [T, L] = windows[i];
        setStatus(`test slice ${i + 1}/${windows.length}…`);
        const tSlice = computeTimeline({
          videoDur, audioDur, offset: off,
          startOverride: t.start + T, endOverride: t.start + T + L,
        });
        testPlan = buildPlan({ t: tSlice, video, audio, audioDur, opts: testOpts });
        const sliceBlob = await executePlan(ff, testPlan, tempFiles);
        const name = `tslice-${i}.mp4`;
        await ff.writeFile(name, new Uint8Array(await sliceBlob.arrayBuffer()));
        tempFiles.add(name);
        sliceFiles.push(name);
      }
      let outBlob;
      if (sliceFiles.length === 1) {
        outBlob = new Blob([await ff.readFile(sliceFiles[0])], { type: 'video/mp4' });
      } else {
        await ff.writeFile('tconcat.txt', sliceFiles.map((f) => `file '${f}'`).join('\n') + '\n');
        tempFiles.add('tconcat.txt');
        setStatus('stitching slices…');
        await execStep(ff, ['-f', 'concat', '-safe', '0', '-i', 'tconcat.txt',
          '-c', 'copy', '-movflags', '+faststart', '-y', 'test.mp4'], { onLog: pushLog });
        tempFiles.add('test.mp4');
        outBlob = new Blob([await ff.readFile('test.mp4')], { type: 'video/mp4' });
      }
      state.result = {
        url: URL.createObjectURL(outBlob),
        name: `${base}.syzygy-test.mp4`,
        size: outBlob.size,
        mime: 'video/mp4',
        strategy: testPlan.strategy,
        notes: testPlan.notes,
        isTest: true,
        testDesc: desc,
      };
      setStatus('sync check done — the full render is unaffected', 'ok');
      setProgress(null);
      return;
    }

    let plan = buildPlan({ t, video, audio, audioDur, opts });
    plan.notes.forEach((n) => pushLog(`[syzygy] ${n}`));

    let outBlob = await executePlan(ff, plan, tempFiles);

    // verify the concat fast path; fall back to a full re-encode on anomaly
    if (plan.verify && outBlob) {
      setStatus('verifying…');
      const check = await probe(ff, plan.output).catch(() => null);
      const gotDur = Number(check?.format?.duration || 0);
      const tol = Math.max(0.75, plan.verify.duration * 0.03);
      if (!(Math.abs(gotDur - plan.verify.duration) <= tol)) {
        pushLog(`[syzygy] concat verify failed (${gotDur.toFixed(2)}s vs ${plan.verify.duration.toFixed(2)}s expected) — re-encoding instead`);
        await cleanupTemp(ff, tempFiles);
        plan = buildPlan({ t, video, audio, audioDur, opts: { ...opts, videoMode: 'reencode' } });
        outBlob = await executePlan(ff, plan, tempFiles);
      }
    }

    state.result = {
      url: URL.createObjectURL(outBlob),
      name: `${base}.syzygy.${plan.container.ext}`,
      size: outBlob.size,
      mime: plan.container.ext === 'webm' ? 'video/webm' : 'video/mp4',
      strategy: plan.strategy,
      notes: plan.notes,
    };
    setStatus('done', 'ok');
    setProgress(null);
  } catch (err) {
    // A wasm RuntimeError means the engine instance is corrupted — throw it
    // away so the next render boots a fresh core instead of failing forever.
    const wasmDead = /RuntimeError|memory access|unreachable|table index/.test(String(err));
    if (wasmDead) terminateEngine();
    if (state.cancelled) {
      setStatus('cancelled', 'err');
    } else {
      console.error('[syzygy]', err);
      setStatus(`failed: ${err.message?.split('\n')[0] || err}${wasmDead ? ' (engine reset — try again)' : ''}`, 'err');
      pushLog(String(err.message || err));
      document.querySelector('.sz-log')?.setAttribute('open', '');
    }
    setProgress(null);
    if (wasmDead) ff = null;
  } finally {
    if (ff && !state.cancelled) {
      await cleanupTemp(ff, tempFiles);
      for (const c of cleanups) await c();
    }
    state.running = false;
    update();
  }
}

async function executePlan(ff, plan, tempFiles) {
  const execSteps = plan.steps.filter((s) => s.kind === 'exec').length;
  let execDone = 0;
  for (const step of plan.steps) {
    if (state.cancelled) throw new Error('cancelled');
    if (step.kind === 'write') {
      await ff.writeFile(step.path, step.text);
      tempFiles.add(step.path);
      continue;
    }
    execDone++;
    setStatus(`${step.label} (${execDone}/${execSteps})`);
    setProgress(step.long ? 0 : null);
    const hooks = step.long ? {
      onLog: pushLog,
      onProgress: ({ progress, time }) => {
        if (Number.isFinite(progress) && progress > 0 && progress <= 1.05) setProgress(progress);
        else if (Number.isFinite(time) && time > 0) setStatus(`${step.label} (${execDone}/${execSteps}) — ${fmtDur(time / 1e6)} rendered`);
      },
    } : { onLog: pushLog };
    try {
      await execStep(ff, step.args, hooks);
    } catch (err) {
      if (state.cancelled) throw err;
      if (step.fallbackArgs) {
        pushLog(`[syzygy] ${step.label}: primary attempt failed, trying fallback`);
        await execStep(ff, step.fallbackArgs, hooks);
      } else {
        throw err;
      }
    }
    // remember intermediates for cleanup (everything the step wrote)
    const out = step.args[step.args.length - 1];
    if (out && !out.startsWith('-')) tempFiles.add(out);
  }
  const data = await ff.readFile(plan.output);
  tempFiles.add(plan.output);
  return new Blob([data], { type: plan.container.ext === 'webm' ? 'video/webm' : 'video/mp4' });
}

async function cleanupTemp(ff, tempFiles) {
  for (const f of tempFiles) {
    try { await ff.deleteFile(f); } catch { /* gone already */ }
  }
  tempFiles.clear();
}

function renderResult() {
  const r = state.result;
  ui.resultBox.replaceChildren(
    ...(r.isTest ? [h('div', { class: 'sz-test-badge' },
      `⧗ draft sync check — ${r.testDesc} · ≤480p ultrafast · listen for sync drifting between slices. the full render keeps full quality.`)] : []),
    h('video', { class: 'sz-preview', controls: '', src: r.url }),
    h('div', { class: 'sz-row' },
      h('a', { class: 'sz-btn sz-btn-primary', href: r.url, download: r.name }, `download ${r.name}`),
      h('span', { class: 'sz-dim' }, `${fmtBytes(r.size)} · ${r.isTest ? 'draft test clip' : r.strategy === 'direct' ? 'video untouched' : r.strategy === 'concat' ? 'video untouched + encoded stills' : 're-encoded'}`),
    ),
  );
}
