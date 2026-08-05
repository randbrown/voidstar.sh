// syzygy — ffmpeg.wasm lifecycle + probing.
//
// The npm packages (@ffmpeg/ffmpeg, @ffmpeg/util) are tiny wrappers — small
// enough to bundle, like fix-webm-duration. The heavy part (the ~31MB
// single-thread @ffmpeg/core wasm) is lazy-loaded from CDN at first render,
// per the repo rule for heavy third-party libs. Single-thread core is the
// deliberate choice: the multithreaded build needs SharedArrayBuffer, which
// needs COOP/COEP headers we don't serve (they'd constrain every other page
// sharing the origin). Slower, but works on a static host everywhere.
//
// Inputs are mounted via WORKERFS when possible (zero-copy reads straight
// from the File), falling back to a MEMFS write. Outputs land in MEMFS.

/** Core build that matches the bundled wrapper AND includes ffprobe. */
const CORE_VERSION = '0.12.10';
const CORE_BASES = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];

let ffmpeg = null;      // live FFmpeg instance (single-use engine, reused)
let loadPromise = null;

/**
 * Load (or return) the engine.
 * @param {(msg:string, frac?:number)=>void} [onStatus]  load progress
 */
export async function loadEngine(onStatus) {
  if (ffmpeg) return ffmpeg;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    onStatus?.('loading ffmpeg wrapper…');
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import('@ffmpeg/ffmpeg'),
      import('@ffmpeg/util'),
    ]);
    // Dev/offline override: point at a locally served core
    // (localStorage['syzygy-core-base'] = 'http://localhost:8080/core').
    let bases = CORE_BASES;
    try {
      const o = localStorage.getItem('syzygy-core-base');
      if (o) bases = [o, ...CORE_BASES];
    } catch { /* storage may be blocked */ }

    let lastErr = null;
    for (const base of bases) {
      try {
        onStatus?.(`fetching ffmpeg core (~31 MB, one-time)…`, 0);
        const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript');
        const wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm', true,
          (e) => { if (e.total > 0) onStatus?.(`fetching ffmpeg core (~31 MB, one-time)…`, e.received / e.total); });
        const ff = new FFmpeg();
        onStatus?.('booting engine…');
        await ff.load({ coreURL, wasmURL });
        ffmpeg = ff;
        onStatus?.('engine ready');
        return ff;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`could not load the ffmpeg core from any CDN — ${lastErr?.message || lastErr}`);
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

/** Hard-stop a run. The worker dies; the next render boots a fresh engine. */
export function terminateEngine() {
  try { ffmpeg?.terminate(); } catch { /* already gone */ }
  ffmpeg = null;
}

/**
 * Stage an input File into the wasm FS. WORKERFS mounts read lazily from the
 * Blob (no copy — the only sane path for GB-scale video); MEMFS is the
 * fallback. Returns { path, cleanup }.
 * @param {import('@ffmpeg/ffmpeg').FFmpeg} ff
 * @param {File} file
 * @param {string} tag  short unique dir/file tag, e.g. 'vin'
 */
export async function stageInput(ff, file, tag) {
  const dir = `/${tag}`;
  try {
    await ff.createDir(dir);
    await ff.mount('WORKERFS', { files: [file] }, dir);
    return {
      path: `${dir}/${file.name}`,
      cleanup: async () => {
        try { await ff.unmount(dir); await ff.deleteDir(dir); } catch { /* best-effort */ }
      },
    };
  } catch {
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const path = `${tag}.${ext}`;
    await ff.writeFile(path, new Uint8Array(await file.arrayBuffer()));
    return {
      path,
      cleanup: async () => { try { await ff.deleteFile(path); } catch { /* best-effort */ } },
    };
  }
}

/**
 * Run one ffmpeg invocation; throws with the log tail on a non-zero exit.
 * @param {import('@ffmpeg/ffmpeg').FFmpeg} ff
 * @param {string[]} args
 * @param {{onLog?:(line:string)=>void, onProgress?:(p:{progress:number,time:number})=>void}} [hooks]
 */
export async function execStep(ff, args, hooks = {}) {
  const logs = [];
  const logCb = (e) => { logs.push(e.message); hooks.onLog?.(e.message); };
  const progCb = (e) => hooks.onProgress?.(e);
  ff.on('log', logCb);
  if (hooks.onProgress) ff.on('progress', progCb);
  try {
    const ret = await ff.exec(args);
    if (ret !== 0) {
      const tail = logs.slice(-25).join('\n');
      throw new Error(`ffmpeg exited with code ${ret}\n${tail}`);
    }
  } finally {
    ff.off('log', logCb);
    if (hooks.onProgress) ff.off('progress', progCb);
  }
}

/** Fields we want as numbers (the default writer emits everything as text). */
const NUMERIC_FIELDS = new Set(['width', 'height', 'level', 'sample_rate', 'index', 'rotation']);

/**
 * Run ffprobe and collect its stdout. The wasm core's ffprobe ignores
 * `-print_format`/`-o` and its return code is unreliable (-1 on success), so
 * we always request the DEFAULT writer's `key=value` sections and judge
 * success by whether parseable content arrived.
 * @param {import('@ffmpeg/ffmpeg').FFmpeg} ff
 * @param {string[]} args
 * @returns {Promise<string[]>} stdout lines
 */
async function ffprobeLines(ff, args) {
  const lines = [];
  const cb = (e) => { if (e.type === 'stdout') lines.push(e.message); };
  ff.on('log', cb);
  try {
    await ff.ffprobe(args);
  } catch (err) {
    if (!lines.length) throw err;
  } finally {
    ff.off('log', cb);
  }
  return lines;
}

/**
 * Parse the default-writer output ([STREAM]…[/STREAM], [FORMAT]…[/FORMAT],
 * nested [SIDE_DATA]) into the same shape ffprobe's JSON writer produces —
 * the summarizers below don't care which path filled it.
 * @param {string[]} lines
 */
export function parseProbeSections(lines) {
  const info = { streams: [], format: {} };
  let stream = null;
  let sideData = null;
  const target = () => sideData || stream || info.format;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '[STREAM]') { stream = { disposition: {}, tags: {} }; continue; }
    if (line === '[/STREAM]') { if (stream) info.streams.push(stream); stream = null; continue; }
    if (line === '[FORMAT]') { info.format = { tags: {} }; continue; }
    if (line === '[/FORMAT]') continue;
    if (line === '[SIDE_DATA]') { sideData = {}; continue; }
    if (line === '[/SIDE_DATA]') {
      if (stream && sideData) (stream.side_data_list ||= []).push(sideData);
      sideData = null;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const val = line.slice(eq + 1);
    if (val === 'N/A') continue;
    const t = target();
    if (key.startsWith('TAG:')) (t.tags ||= {})[key.slice(4)] = val;
    else if (key.startsWith('DISPOSITION:')) (t.disposition ||= {})[key.slice(12)] = Number(val);
    else t[key] = NUMERIC_FIELDS.has(key) ? Number(val) : val;
  }
  return info;
}

/**
 * ffprobe a staged path → { format, streams }. Falls back to scraping the
 * `ffmpeg -i` banner if this core lacks ffprobe entirely.
 * @param {import('@ffmpeg/ffmpeg').FFmpeg} ff
 * @param {string} path
 */
export async function probe(ff, path) {
  try {
    const lines = await ffprobeLines(ff, ['-v', 'error', '-show_format', '-show_streams', path]);
    const info = parseProbeSections(lines);
    if (!info.streams.length) throw new Error('ffprobe returned no streams');
    return info;
  } catch (err) {
    return probeViaBanner(ff, path, err);
  }
}

/** Last-resort probe: parse the human banner `ffmpeg -i` prints. */
async function probeViaBanner(ff, path, cause) {
  const logs = [];
  const logCb = (e) => logs.push(e.message);
  ff.on('log', logCb);
  try {
    await ff.exec(['-hide_banner', '-i', path]); // exits non-zero by design
  } catch { /* expected: "At least one output file must be specified" */ }
  ff.off('log', logCb);
  const text = logs.join('\n');
  if (!/Duration|Stream/.test(text)) {
    throw new Error(`could not probe ${path}: ${cause?.message || cause}`);
  }

  const streams = [];
  const durM = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const duration = durM ? String(+durM[1] * 3600 + +durM[2] * 60 + +durM[3]) : undefined;
  const vM = /Stream #\d+:\d+[^\n]*?: Video: (\w+)(?: \(([^)]*)\))?[^\n]*?, (\w+[^,\n]*?)(?:\(([^)]*)\))?, (\d+)x(\d+)[^\n]*/.exec(text);
  if (vM) {
    const fpsM = /(\d+(?:\.\d+)?)\s*fps/.exec(text);
    streams.push({
      codec_type: 'video', codec_name: vM[1], profile: vM[2],
      pix_fmt: vM[3].trim(), width: +vM[5], height: +vM[6],
      r_frame_rate: fpsM ? `${Math.round(+fpsM[1] * 1000)}/1000` : '30/1',
      avg_frame_rate: fpsM ? `${Math.round(+fpsM[1] * 1000)}/1000` : '30/1',
      duration,
    });
  }
  const aM = /Stream #\d+:\d+[^\n]*?: Audio: (\w+)[^\n]*?, (\d+) Hz/.exec(text);
  if (aM) {
    streams.push({ codec_type: 'audio', codec_name: aM[1], sample_rate: aM[2], duration });
  }
  const ctM = /creation_time\s*:\s*([\d\-T:.Z ]+)/.exec(text);
  return {
    format: { duration, tags: ctM ? { creation_time: ctM[1].trim() } : {} },
    streams,
  };
}

/** First video stream that isn't cover art. */
export function pickVideoStream(info) {
  return (info.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) || null;
}

/** First audio stream. */
export function pickAudioStream(info) {
  return (info.streams || []).find((s) => s.codec_type === 'audio') || null;
}

/** Display rotation (0/90/180/270) from side data or the legacy rotate tag. */
export function streamRotation(stream) {
  let r = null;
  const sd = (stream?.side_data_list || []).find((d) => d.rotation !== undefined);
  if (sd) r = -Number(sd.rotation); // side data is CCW; display rotation is CW
  else if (stream?.tags?.rotate !== undefined) r = Number(stream.tags.rotate);
  if (r === null || Number.isNaN(r)) return 0;
  return ((Math.round(r / 90) * 90) % 360 + 360) % 360;
}

/**
 * Condense a probe into the VideoInfo shape plan.js consumes.
 * @param {object} info  probe JSON
 * @param {string} path  staged path
 * @param {number} fallbackDur  duration from the <video> element, if probing lacks one
 */
export function summarizeVideo(info, path, fallbackDur) {
  const s = pickVideoStream(info);
  if (!s) throw new Error('no video stream found in the video file');
  let fps = (s.avg_frame_rate && s.avg_frame_rate !== '0/0' ? s.avg_frame_rate : s.r_frame_rate) || '30/1';
  // Containers with a ms timebase (matroska/MediaRecorder) report absurd
  // rates like 1000/1 — fall back to a sane default rather than rendering
  // thousand-fps pad segments.
  const fpsM = /^(\d+)(?:\/(\d+))?$/.exec(fps);
  const fpsN = fpsM ? Number(fpsM[1]) / Number(fpsM[2] || 1) : NaN;
  if (!(fpsN > 0) || fpsN > 240) fps = '30/1';
  const tbM = /^1\/(\d+)$/.exec(s.time_base || '');
  const creation = s.tags?.creation_time || info.format?.tags?.creation_time;
  const epochMs = creation ? Date.parse(creation) : NaN;
  return {
    path,
    codec: s.codec_name,
    width: s.width, height: s.height,
    pixFmt: s.pix_fmt || 'yuv420p',
    profile: s.profile,
    level: typeof s.level === 'number' ? s.level : undefined,
    fps,
    timescale: tbM ? Number(tbM[1]) : undefined,
    sar: s.sample_aspect_ratio,
    rotation: streamRotation(s),
    color: {
      range: s.color_range, space: s.color_space,
      primaries: s.color_primaries, transfer: s.color_transfer,
    },
    epochMs: Number.isNaN(epochMs) ? undefined : epochMs,
    duration: Number(s.duration || info.format?.duration || fallbackDur) || fallbackDur,
  };
}

/** Condense a probe into the AudioInfo shape plan.js consumes. */
export function summarizeAudio(info, path, fallbackDur) {
  const s = pickAudioStream(info);
  if (!s) throw new Error('no audio stream found in the audio file');
  return {
    path,
    codec: s.codec_name,
    sampleRate: Number(s.sample_rate) || undefined,
    duration: Number(s.duration || info.format?.duration || fallbackDur) || fallbackDur,
  };
}

/**
 * Decode a file's first audio stream to mono PCM for analysis.
 * s16le keeps the wasm FS footprint half of f32; converted to Float32 here.
 * @param {import('@ffmpeg/ffmpeg').FFmpeg} ff
 * @param {string} path   staged input
 * @param {{rate:number, ss?:number, t?:number}} o
 * @returns {Promise<Float32Array>}
 */
export async function decodeAudioRaw(ff, path, { rate, ss, t }) {
  const out = `dec-${Math.random().toString(36).slice(2, 8)}.raw`;
  const args = [
    ...(ss ? ['-ss', String(Math.round(ss * 1000) / 1000)] : []),
    ...(t ? ['-t', String(Math.round(t * 1000) / 1000)] : []),
    '-i', path,
    '-map', '0:a:0', '-ac', '1', '-ar', String(rate),
    '-f', 's16le', '-v', 'error', '-y', out,
  ];
  try {
    await execStep(ff, args);
  } catch (err) {
    if (/matches no streams/.test(String(err))) {
      throw new Error('this file has no audio track to match against');
    }
    throw err;
  }
  const raw = await ff.readFile(out);
  await ff.deleteFile(out).catch(() => {});
  const i16 = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

/**
 * Find the keyframe nearest `target` (s) on the video stream, scanning a
 * ±window with ffprobe read_intervals. Returns the keyframe time or null.
 * Used to snap a start trim so the video can stay stream-copied.
 */
export async function nearestKeyframe(ff, path, target, window = 15) {
  const from = Math.max(0, target - window);
  try {
    const lines = await ffprobeLines(ff, [
      '-v', 'error', '-select_streams', 'v:0',
      '-read_intervals', `${from}%${target + window}`,
      '-show_packets', path,
    ]);
    let best = null;
    let pts = NaN;
    let key = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (line === '[PACKET]') { pts = NaN; key = false; continue; }
      if (line === '[/PACKET]') {
        if (key && !Number.isNaN(pts)
            && (best === null || Math.abs(pts - target) < Math.abs(best - target))) best = pts;
        continue;
      }
      if (line.startsWith('pts_time=') || (Number.isNaN(pts) && line.startsWith('dts_time='))) {
        const v = Number(line.split('=')[1]);
        if (!Number.isNaN(v)) pts = v;
      } else if (line.startsWith('flags=')) {
        key = line.includes('K');
      }
    }
    return best;
  } catch {
    return null;
  }
}
