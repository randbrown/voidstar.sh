// syzygy — timeline math + ffmpeg command planning.
//
// Pure module: no DOM, no ffmpeg, no I/O — everything here is data-in /
// data-out so `scripts/check-syzygy-plan.mjs` can exercise it in node.
//
// The job: given a video track, a replacement audio track, and an alignment
// offset, decide the output window, what needs padding/trimming, and build
// the cheapest ffmpeg.wasm plan that PRESERVES SOURCE QUALITY:
//
//   direct   — video stream-copied untouched, only the audio is new.
//   concat   — video stream-copied; still-image pad segments are encoded to
//              match the source's codec parameters and concatenated around it.
//              (Verified after the run; falls back to reencode on anomaly.)
//   reencode — full high-quality re-encode. Last resort: exact in-video trims,
//              non-h264 sources that need pads, or rotated sources with pads.
//
// End trims never force a re-encode: `-t` on a stream-copied output cuts at
// packet granularity (a decodable GOP prefix), which is within a frame or two.
// Start trims CAN stay lossless when the app snaps them to a keyframe first
// (see `startIsKeyframe`); "exact" start trims re-encode.

/** Timing slop (s) under which we treat a cut/pad as nonexistent. */
export const EPS = 0.0015;

/** Pixel formats the wasm x264 (8-bit) can reproduce for pad segments. */
export const PAD_OK_PIX_FMTS = ['yuv420p', 'yuvj420p', 'yuv422p', 'yuv444p'];

/** Sample rates the native AAC encoder accepts (else we resample to 48k). */
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Format seconds for an ffmpeg arg: ms precision, no exponent notation. */
export function fmtSec(n) {
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * Compute the output window and every derived cut/pad from the alignment.
 *
 * Coordinates: the video's own timeline (video starts at 0). The audio file
 * occupies [offset, offset+audioDur] — `offset` may be negative (audio starts
 * before the video).
 *
 * @param {object} o
 * @param {number} o.videoDur   video duration (s)
 * @param {number} o.audioDur   audio duration (s)
 * @param {number} o.offset     audio start relative to video start (s)
 * @param {boolean} [o.trimStart]  true → output starts at the LATER start
 * @param {boolean} [o.trimEnd]    true → output ends at the EARLIER end
 * @param {number} [o.startOverride]  replace the computed start (keyframe snap)
 * @returns {{
 *   start:number, end:number, duration:number,
 *   padLead:number, padTail:number,
 *   videoIn:number, videoOut:number, videoUsed:number,
 *   videoCutStart:boolean, videoCutEnd:boolean,
 *   audioIn:number, audioOut:number, audioUsed:number, audioDelay:number,
 * }}
 */
export function computeTimeline({ videoDur, audioDur, offset, trimStart = false, trimEnd = false, startOverride }) {
  if (!(videoDur > 0) || !(audioDur > 0)) throw new Error('need positive durations');
  const aStart = offset;
  const aEnd = offset + audioDur;
  let start = trimStart ? Math.max(0, aStart) : Math.min(0, aStart);
  if (startOverride !== undefined) start = startOverride;
  const end = trimEnd ? Math.min(videoDur, aEnd) : Math.max(videoDur, aEnd);
  if (!(end - start > EPS)) throw new Error('empty output: trims/offset leave no overlap');

  const duration = end - start;
  const videoIn = Math.min(Math.max(start, 0), videoDur);
  const videoOut = Math.min(Math.max(end, 0), videoDur);
  const videoUsed = Math.max(0, videoOut - videoIn);
  const padLead = Math.min(duration, Math.max(0, -start));
  const padTail = Math.max(0, end - Math.max(start, videoDur));
  const audioIn = Math.min(Math.max(start - aStart, 0), audioDur);
  const audioOut = Math.min(Math.max(end - aStart, 0), audioDur);
  const audioUsed = Math.max(0, audioOut - audioIn);
  const audioDelay = Math.min(duration, Math.max(0, aStart - start));

  return {
    start, end, duration,
    padLead, padTail,
    videoIn, videoOut, videoUsed,
    videoCutStart: videoUsed > 0 && videoIn > EPS,
    videoCutEnd: videoUsed > 0 && videoOut < videoDur - EPS,
    audioIn, audioOut, audioUsed, audioDelay,
  };
}

/**
 * @typedef {object} VideoInfo   (from ffprobe, see engine.js)
 * @property {string} path       staged input path in the wasm FS
 * @property {string} codec      codec_name (h264, hevc, vp9, …)
 * @property {number} width
 * @property {number} height
 * @property {string} pixFmt
 * @property {string} [profile]
 * @property {number} [level]
 * @property {string} fps        rational string, e.g. "30000/1001"
 * @property {number} [timescale]   mp4 track timescale (from time_base)
 * @property {string} [sar]      sample aspect ratio "n:m"
 * @property {number} rotation   display rotation (0/90/180/270)
 * @property {object} [color]    {range, space, primaries, transfer}
 * @property {number} [epochMs]  wall-clock capture time
 *
 * @typedef {object} AudioInfo
 * @property {string} path
 * @property {string} codec      codec_name (mp3, aac, pcm_s16le, opus, …)
 * @property {number} [sampleRate]
 */

/**
 * Pick the cheapest strategy that satisfies the timeline.
 * @param {ReturnType<typeof computeTimeline>} t
 * @param {VideoInfo} video
 * @param {{videoMode?:'auto'|'reencode', startIsKeyframe?:boolean}} [opts]
 * @returns {'direct'|'concat'|'reencode'}
 */
export function chooseStrategy(t, video, opts = {}) {
  if (opts.videoMode === 'reencode') return 'reencode';
  const needsPads = t.padLead > EPS || t.padTail > EPS;
  const startOk = !t.videoCutStart || opts.startIsKeyframe === true;
  if (!needsPads && startOk) return 'direct';
  if (needsPads && startOk
      && video.codec === 'h264'
      && PAD_OK_PIX_FMTS.includes(video.pixFmt)
      && !video.rotation) return 'concat';
  return 'reencode';
}

/**
 * Output container/codec family. vp8/vp9 stay in webm (vp8 can't live in mp4,
 * vp9-in-mp4 breaks Safari); everything else muxes to mp4.
 * @param {'direct'|'concat'|'reencode'} strategy
 * @param {VideoInfo} video
 */
export function chooseContainer(strategy, video) {
  if (strategy !== 'reencode' && (video.codec === 'vp8' || video.codec === 'vp9')) {
    // vorbis, not opus: the wasm core's libopus crashes (memory OOB); libvorbis
    // is solid and universally supported in webm. Opus/vorbis SOURCES still
    // stream-copy fine — no encoder involved.
    return { ext: 'webm', audioFamily: 'vorbis' };
  }
  return { ext: 'mp4', audioFamily: 'aac' };
}

/**
 * Decide the output audio codec args.
 * Copy is only offered when the audio needs no cutting and no leading
 * silence (a trailing shortfall or `-t` end cut is copy-safe).
 * @param {object} o
 * @param {ReturnType<typeof computeTimeline>} o.t
 * @param {AudioInfo} o.audio
 * @param {number} o.audioDur   probed duration of the audio file
 * @param {'aac'|'vorbis'} o.family
 * @param {'auto'|'transcode'|'copy'} o.mode
 * @param {number} [o.bitrateK]  transcode bitrate (kbps)
 * @returns {{codecArgs:string[], filters:string[], copied:boolean}}
 */
export function planAudio({ t, audio, audioDur, family, mode = 'auto', bitrateK }) {
  const untouchedStart = t.audioIn <= EPS && t.audioDelay <= EPS;
  const copyable = family === 'aac'
    ? ['aac', 'mp3'].includes(audio.codec)
    : ['opus', 'vorbis'].includes(audio.codec);
  // auto only copies the container-native codec; mp3-in-mp4 needs an explicit ask.
  const autoCopy = family === 'aac' ? audio.codec === 'aac' : copyable;
  const wantCopy = mode === 'copy' ? copyable : (mode === 'auto' && autoCopy);

  if (wantCopy && untouchedStart) {
    return { codecArgs: ['-c:a', 'copy'], filters: [], copied: true };
  }

  const filters = [];
  if (t.audioIn > EPS || t.audioOut < audioDur - EPS) {
    filters.push(`atrim=start=${fmtSec(t.audioIn)}:end=${fmtSec(t.audioOut)}`, 'asetpts=PTS-STARTPTS');
  }
  if (t.audioDelay > EPS) filters.push(`adelay=${Math.round(t.audioDelay * 1000)}:all=1`);
  filters.push('apad'); // -t on the output clamps the silence

  // vorbis in QUALITY mode: managed-bitrate mode rejects rate/channel combos
  // it dislikes (e.g. 256k mono fails encoder setup); -q:a 7 ≈ 224k stereo
  // and scales safely with channels/rates.
  const codecArgs = family === 'vorbis'
    ? ['-c:a', 'libvorbis', '-q:a', '7']
    : ['-c:a', 'aac', '-b:a', `${bitrateK || 320}k`];
  if (family === 'aac' && audio.sampleRate && !AAC_RATES.includes(audio.sampleRate)) {
    codecArgs.push('-ar', '48000');
  }
  return { codecArgs, filters, copied: false };
}

/** Map an ffprobe h264 profile string onto an x264 -profile:v value. */
export function x264Profile(profile) {
  const p = (profile || '').toLowerCase();
  if (p.includes('baseline')) return 'baseline';
  if (p.includes('4:4:4')) return 'high444';
  if (p.includes('4:2:2')) return 'high422';
  if (p.includes('high')) return 'high';
  if (p.includes('main')) return 'main';
  return null;
}

/** Pass through the source's color signaling when known. */
function colorArgs(video) {
  const c = video.color || {};
  const known = (v) => v && v !== 'unknown' && v !== 'unspecified';
  const args = [];
  if (known(c.range)) args.push('-color_range', c.range);
  if (known(c.space)) args.push('-colorspace', c.space);
  if (known(c.primaries)) args.push('-color_primaries', c.primaries);
  if (known(c.transfer)) args.push('-color_trc', c.transfer);
  return args;
}

/** setsar value from a probed "n:m" SAR ("0:1"/missing → square). */
function sarValue(sar) {
  const m = /^(\d+):(\d+)$/.exec(sar || '');
  if (!m || m[1] === '0' || m[2] === '0') return '1';
  return `${m[1]}/${m[2]}`;
}

/** Approximate frames/sec from a rational fps string (for pad rounding). */
export function fpsNumber(fps) {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(fps || '');
  if (!m) return 30;
  const n = Number(m[1]) / Number(m[2] || 1);
  return n > 0 && n < 1000 ? n : 30;
}

/** creation_time metadata for the output = source epoch shifted to the window start. */
function metadataArgs(video, t) {
  if (!video.epochMs) return [];
  const iso = new Date(video.epochMs + Math.round(t.start * 1000)).toISOString();
  return ['-metadata', `creation_time=${iso}`];
}

/**
 * The scale/letterbox chain that conforms an arbitrary pad image to the
 * video raster. `pixFmt` may be null to leave the format to the encoder.
 */
function padConform(video, pixFmt, fps) {
  const { width: w, height: h } = video;
  const parts = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `setsar=${sarValue(video.sar)}`,
    `fps=${fps}`,
  ];
  if (pixFmt) parts.push(`format=${pixFmt}`);
  return parts.join(',');
}

/**
 * @typedef {{kind:'exec', label:string, args:string[], fallbackArgs?:string[], long?:boolean}
 *         | {kind:'write', label:string, path:string, text:string}} PlanStep
 * @typedef {{strategy:string, container:{ext:string,audioFamily:string}, output:string,
 *            steps:PlanStep[], verify?:{path:string, duration:number}, audioCopied:boolean,
 *            notes:string[]}} Plan
 */

/**
 * Build the full step list for a run.
 *
 * @param {object} o
 * @param {ReturnType<typeof computeTimeline>} o.t
 * @param {VideoInfo} o.video
 * @param {AudioInfo} o.audio
 * @param {number} o.audioDur
 * @param {object} o.opts
 * @param {'auto'|'reencode'} [o.opts.videoMode]
 * @param {boolean} [o.opts.startIsKeyframe]
 * @param {'auto'|'transcode'|'copy'} [o.opts.audioMode]
 * @param {number} [o.opts.audioBitrateK]
 * @param {number} [o.opts.crf]
 * @param {string} [o.opts.preset]
 * @param {?string} [o.opts.padLeadImage]  staged path of a user pad image
 * @param {?string} [o.opts.padTailImage]
 * @param {?number} [o.opts.padLeadTime]   pick the lead pad frame from this video time
 * @param {?number} [o.opts.padTailTime]
 * @returns {Plan}
 */
export function buildPlan({ t, video, audio, audioDur, opts = {} }) {
  const strategy = chooseStrategy(t, video, opts);
  const container = chooseContainer(strategy, video);
  const output = `out.${container.ext}`;
  const notes = [];
  const steps = [];

  // Pads shorter than half a frame are noise — drop them.
  const frameDur = 1 / fpsNumber(video.fps);
  const padLead = t.padLead >= frameDur / 2 ? t.padLead : 0;
  const padTail = t.padTail >= frameDur / 2 ? t.padTail : 0;

  const aud = planAudio({
    t, audio, audioDur,
    family: container.audioFamily,
    mode: opts.audioMode || 'auto',
    bitrateK: opts.audioBitrateK,
  });
  if (aud.copied) notes.push(`audio stream-copied (${audio.codec})`);

  // Audio input + mapping, shared by every strategy. When no audio overlaps
  // the window, feed digital silence instead of the file.
  const silent = t.audioUsed <= EPS;
  const audioInput = silent
    ? ['-f', 'lavfi', '-t', fmtSec(t.duration), '-i', 'anullsrc=r=48000:cl=stereo']
    : ['-i', audio.path];
  const silentCodec = container.audioFamily === 'vorbis'
    ? ['-c:a', 'libvorbis', '-q:a', '1']
    : ['-c:a', 'aac', '-b:a', '128k'];
  const audioCodecArgs = silent ? silentCodec : aud.codecArgs;
  const audioFilters = silent ? [] : aud.filters;
  if (silent) notes.push('no audio overlaps the output window — silent track');

  const muxArgs = container.ext === 'mp4' ? ['-movflags', '+faststart'] : [];
  const meta = metadataArgs(video, t);

  // ── still frames for pads ────────────────────────────────────────────
  // Default is the adjacent frame (first/last used frame of the video); a
  // user image or an arbitrary video time can override per side.
  function padImageSteps(side, need) {
    if (!need) return null;
    const userImg = side === 'lead' ? opts.padLeadImage : opts.padTailImage;
    if (userImg) return { path: userImg };
    const pickTime = side === 'lead' ? opts.padLeadTime : opts.padTailTime;
    const png = `pad-${side}.png`;
    if (pickTime != null) {
      steps.push({
        kind: 'exec', label: `extract ${side} pad frame @ ${fmtSec(pickTime)}s`,
        args: ['-ss', fmtSec(pickTime), '-i', video.path, '-an', '-frames:v', '1', '-y', png],
      });
    } else if (side === 'lead') {
      steps.push({
        kind: 'exec', label: 'extract first frame',
        args: ['-ss', fmtSec(t.videoIn), '-i', video.path, '-an', '-frames:v', '1', '-y', png],
      });
    } else {
      steps.push({
        kind: 'exec', label: 'extract last frame',
        // -sseof lands near the end and -update keeps overwriting until EOF;
        // fall back to a plain seek for demuxers that can't seek from EOF.
        args: ['-sseof', '-1', '-i', video.path, '-an', '-update', '1', '-y', png],
        fallbackArgs: ['-ss', fmtSec(Math.max(0, t.videoOut - 0.2)), '-i', video.path, '-an', '-frames:v', '1', '-y', png],
      });
    }
    return { path: png };
  }

  const leadImg = padImageSteps('lead', padLead > 0);
  const tailImg = padImageSteps('tail', padTail > 0);

  // ── strategy: direct ─────────────────────────────────────────────────
  if (strategy === 'direct') {
    const seek = t.videoIn > EPS ? ['-ss', fmtSec(t.videoIn)] : [];
    const args = [
      ...seek, '-i', video.path,
      ...audioInput,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy',
      ...(container.ext === 'mp4' && video.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
      ...(audioFilters.length ? ['-af', audioFilters.join(',')] : []),
      ...audioCodecArgs,
      '-t', fmtSec(t.duration),
      ...muxArgs, ...meta, '-y', output,
    ];
    steps.push({ kind: 'exec', label: 'remux with new audio (video untouched)', args, long: true });
    notes.push('video stream-copied — bit-identical to the source');
    return { strategy, container, output, steps, audioCopied: aud.copied, notes };
  }

  // ── strategy: concat ─────────────────────────────────────────────────
  if (strategy === 'concat') {
    const ts = video.timescale && video.timescale > 0 ? String(video.timescale) : '90000';
    const profile = x264Profile(video.profile);
    // yuvj420p is deprecated as an encoder input; encode 420 + full-range flag.
    const padPix = video.pixFmt === 'yuvj420p' ? 'yuv420p' : video.pixFmt;
    const col = colorArgs(video);

    function padEncode(side, img, dur) {
      steps.push({
        kind: 'exec', label: `encode ${side} pad (${fmtSec(dur)}s still)`,
        args: [
          '-loop', '1', '-framerate', video.fps, '-t', fmtSec(dur), '-i', img,
          '-vf', padConform(video, padPix, video.fps),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-tune', 'stillimage',
          ...(profile ? ['-profile:v', profile] : []),
          ...(video.level && video.level > 0 ? ['-level', String(video.level / 10)] : []),
          ...col,
          '-video_track_timescale', ts,
          '-an', '-y', `pad-${side}.mp4`,
        ],
        long: true,
      });
    }
    if (padLead > 0) padEncode('lead', leadImg.path, padLead);
    if (padTail > 0) padEncode('tail', tailImg.path, padTail);

    // Strip the source down to its video stream so every concat entry has an
    // identical stream layout. Pure remux — no quality change.
    const seek = t.videoIn > EPS ? ['-ss', fmtSec(t.videoIn)] : [];
    steps.push({
      kind: 'exec', label: 'stage video stream (lossless remux)',
      args: [...seek, '-i', video.path, '-map', '0:v:0', '-c', 'copy',
        '-video_track_timescale', ts, '-y', 'mid.mp4'],
    });

    const listLines = [];
    if (padLead > 0) listLines.push("file 'pad-lead.mp4'");
    listLines.push("file 'mid.mp4'");
    if (padTail > 0) listLines.push("file 'pad-tail.mp4'");
    steps.push({ kind: 'write', label: 'write concat list', path: 'concat.txt', text: listLines.join('\n') + '\n' });

    steps.push({
      kind: 'exec', label: 'concatenate + mux with new audio',
      args: [
        '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
        ...audioInput,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy',
        ...(audioFilters.length ? ['-af', audioFilters.join(',')] : []),
        ...audioCodecArgs,
        '-t', fmtSec(t.duration),
        ...muxArgs, ...meta, '-y', output,
      ],
      long: true,
    });
    notes.push('video stream-copied; only the still pads are encoded');
    return {
      strategy, container, output, steps, audioCopied: aud.copied, notes,
      verify: { path: output, duration: t.duration },
    };
  }

  // ── strategy: reencode ───────────────────────────────────────────────
  // Rotation is baked in (pads must match the displayed orientation).
  const rot = video.rotation || 0;
  const disp = rot === 90 || rot === 270
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height };
  const rotFilter = rot === 90 ? 'transpose=clock,'
    : rot === 270 ? 'transpose=cclock,'
    : rot === 180 ? 'hflip,vflip,'
    : '';

  const inputs = [];
  const segLabels = [];
  let idx = 0;
  if (padLead > 0) {
    inputs.push('-loop', '1', '-framerate', video.fps, '-t', fmtSec(padLead), '-i', leadImg.path);
    segLabels.push({ idx: idx++, kind: 'pad' });
  }
  let vidIdx = -1;
  if (t.videoUsed > EPS) {
    inputs.push('-i', video.path);
    vidIdx = idx;
    segLabels.push({ idx: idx++, kind: 'video' });
  }
  if (padTail > 0) {
    inputs.push('-loop', '1', '-framerate', video.fps, '-t', fmtSec(padTail), '-i', tailImg.path);
    segLabels.push({ idx: idx++, kind: 'pad' });
  }
  const aIdx = idx;

  const dispVideo = { ...video, width: disp.width, height: disp.height };
  const chains = [];
  const segRefs = [];
  for (let s = 0; s < segLabels.length; s++) {
    const seg = segLabels[s];
    const ref = `[s${s}]`;
    if (seg.kind === 'pad') {
      chains.push(`[${seg.idx}:v]${padConform(dispVideo, 'yuv420p', video.fps)}${ref}`);
    } else {
      chains.push(
        `[${seg.idx}:v]trim=start=${fmtSec(t.videoIn)}:end=${fmtSec(t.videoOut)},`
        + `setpts=PTS-STARTPTS,${rotFilter}fps=${video.fps},setsar=${sarValue(video.sar)},format=yuv420p${ref}`,
      );
    }
    segRefs.push(ref);
  }
  chains.push(`${segRefs.join('')}concat=n=${segRefs.length}:v=1:a=0[vout]`);
  if (!silent && audioFilters.length) {
    chains.push(`[${aIdx}:a]${audioFilters.join(',')}[aout]`);
  }
  const audioMap = !silent && audioFilters.length ? '[aout]' : `${aIdx}:a:0`;

  steps.push({
    kind: 'exec', label: 'render (full re-encode)',
    args: [
      ...inputs, ...audioInput,
      '-filter_complex', chains.join(';'),
      '-map', '[vout]', '-map', audioMap,
      '-c:v', 'libx264', '-preset', opts.preset || 'veryfast', '-crf', String(opts.crf ?? 17),
      '-pix_fmt', 'yuv420p',
      ...colorArgs(video),
      ...audioCodecArgs,
      '-t', fmtSec(t.duration),
      ...muxArgs, ...meta, '-y', output,
    ],
    long: true,
  });
  notes.push(`full re-encode (x264 crf ${opts.crf ?? 17} ${opts.preset || 'veryfast'}) — slow in-browser but visually faithful`);
  return { strategy, container, output, steps, audioCopied: aud.copied, notes };
}
