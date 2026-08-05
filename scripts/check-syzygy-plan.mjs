// Node smoke test for the syzygy lab's planning + metadata modules.
// plan.js is pure data-in/data-out and meta.js reads Blobs (node's Blob
// works), so we exercise the real timeline math, strategy ladder, ffmpeg
// arg builders, and the binary datetime sniffers. Run via `npm run check`.

import {
  computeTimeline, computeGaps, chooseStrategy, chooseContainer, planAudio, buildPlan, fmtSec, EPS,
} from '../src/lib/syzygy/plan.js';
import { sniffMediaInfo, sniffWav, sniffMp3 } from '../src/lib/syzygy/meta.js';
import { parseProbeSections, summarizeVideo, streamRotation } from '../src/lib/syzygy/engine.js';
import { correlatePcm, MIN_COARSE_Z, MIN_PEAK_RATIO } from '../src/lib/syzygy/correlate.js';
import { serializeSettings, applySettings, fileKeyOf, pairKey, jobKeyOf, pcmKeyOf, f32ToI16, i16ToF32 } from '../src/lib/syzygy/persist.js';
import { segmentWindows, buildAssemblePlan } from '../src/lib/syzygy/plan.js';
import { shellQuote, planToScript } from '../src/lib/syzygy/export-cmd.js';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const H264 = {
  path: 'v.mp4', codec: 'h264', width: 1920, height: 1080, pixFmt: 'yuv420p',
  profile: 'High', level: 40, fps: '30000/1001', timescale: 15360, sar: '1:1', rotation: 0,
};
const MP3 = { path: 'a.mp3', codec: 'mp3', sampleRate: 44100 };

// ── timeline math ───────────────────────────────────────────────────────
{
  // default union, audio starts 5s in and outlasts the video by 10s
  const t = computeTimeline({ videoDur: 60, audioDur: 65, offset: 5 });
  check('union keeps the earlier start', near(t.start, 0));
  check('union keeps the later end', near(t.end, 70));
  check('tail pad covers the audio overhang', near(t.padTail, 10) && near(t.padLead, 0));
  check('audio delayed to its clock position', near(t.audioDelay, 5));
  check('no video cut in union mode', !t.videoCutStart && !t.videoCutEnd);
}
{
  // negative offset (audio started before the video)
  const t = computeTimeline({ videoDur: 60, audioDur: 65, offset: -10 });
  check('lead pad covers early audio', near(t.padLead, 10) && near(t.start, -10));
  check('audio plays from its first sample', near(t.audioIn, 0) && near(t.audioDelay, 0));
  check('video ends the union (audio ends at 55)', near(t.end, 60) && near(t.padTail, 0));
}
{
  // trim both ends down to the overlap
  const t = computeTimeline({ videoDur: 60, audioDur: 30, offset: 10, trimStart: true, trimEnd: true });
  check('trimmed window is the overlap', near(t.start, 10) && near(t.end, 40));
  check('start trim cuts into the video', t.videoCutStart && t.videoCutEnd);
  check('no pads when trimmed to overlap', near(t.padLead, 0) && near(t.padTail, 0));
  check('audio used in full', near(t.audioIn, 0) && near(t.audioOut, 30));
}
{
  // keyframe snap override shifts the cut and keeps audio in sync
  const t = computeTimeline({ videoDur: 60, audioDur: 30, offset: 10, trimStart: true, startOverride: 9.5 });
  check('override moves the window start', near(t.start, 9.5));
  check('audio in-point follows the snap', near(t.audioIn, 0) && near(t.audioDelay, 0.5));
}
{
  let threw = false;
  try { computeTimeline({ videoDur: 10, audioDur: 5, offset: 20, trimStart: true, trimEnd: true }); }
  catch { threw = true; }
  check('disjoint trim window throws', threw);
}

// ── strategy ladder ─────────────────────────────────────────────────────
{
  const t = computeTimeline({ videoDur: 60, audioDur: 60, offset: 0 });
  check('aligned equal-length → direct', chooseStrategy(t, H264) === 'direct');
  const tPad = computeTimeline({ videoDur: 60, audioDur: 70, offset: 0 });
  check('h264 + pads → concat', chooseStrategy(tPad, H264) === 'concat');
  check('vp9 + pads → reencode', chooseStrategy(tPad, { ...H264, codec: 'vp9' }) === 'reencode');
  check('rotated + pads → reencode', chooseStrategy(tPad, { ...H264, rotation: 90 }) === 'reencode');
  const tCut = computeTimeline({ videoDur: 60, audioDur: 30, offset: 10, trimStart: true });
  check('exact start cut → reencode', chooseStrategy(tCut, H264) === 'reencode');
  check('keyframe-snapped start cut → direct', chooseStrategy(tCut, H264, { startIsKeyframe: true }) === 'direct');
  const tEnd = computeTimeline({ videoDur: 60, audioDur: 30, offset: 0, trimEnd: true });
  check('end-only cut stays direct (via -t)', chooseStrategy(tEnd, H264) === 'direct');
  check('forced reencode wins', chooseStrategy(t, H264, { videoMode: 'reencode' }) === 'reencode');
}
{
  check('vp8 direct stays webm', chooseContainer('direct', { ...H264, codec: 'vp8' }).ext === 'webm');
  check('h264 goes to mp4', chooseContainer('direct', H264).ext === 'mp4');
  check('reencode always lands in mp4', chooseContainer('reencode', { ...H264, codec: 'vp9' }).ext === 'mp4');
}

// ── audio planning ──────────────────────────────────────────────────────
{
  const t = computeTimeline({ videoDur: 60, audioDur: 60, offset: 0 });
  const aac = planAudio({ t, audio: { path: 'a.m4a', codec: 'aac' }, audioDur: 60, family: 'aac', mode: 'auto' });
  check('aligned aac auto-copies', aac.copied && aac.codecArgs.includes('copy'));
  const mp3auto = planAudio({ t, audio: MP3, audioDur: 60, family: 'aac', mode: 'auto' });
  check('mp3 transcodes by default', !mp3auto.copied && mp3auto.codecArgs.includes('aac'));
  const mp3copy = planAudio({ t, audio: MP3, audioDur: 60, family: 'aac', mode: 'copy' });
  check('mp3 copy honored when asked', mp3copy.copied);
  const t2 = computeTimeline({ videoDur: 60, audioDur: 65, offset: 5, trimEnd: true });
  const delayed = planAudio({ t: t2, audio: { path: 'a.m4a', codec: 'aac' }, audioDur: 65, family: 'aac', mode: 'copy' });
  check('delay forbids copy', !delayed.copied);
  check('delay lands in adelay ms', delayed.filters.some((f) => f === 'adelay=5000:all=1'));
  check('overhang is trimmed', delayed.filters.some((f) => f.startsWith('atrim=start=0:end=55')));
  const weird = planAudio({ t, audio: { path: 'a.wav', codec: 'pcm_s16le', sampleRate: 192000 }, audioDur: 60, family: 'aac', mode: 'auto' });
  check('unsupported rate resamples to 48k', weird.codecArgs.join(' ').includes('-ar 48000'));
}

// ── plan building ───────────────────────────────────────────────────────
{
  // direct: equal, aligned
  const t = computeTimeline({ videoDur: 60, audioDur: 60, offset: 0 });
  const plan = buildPlan({ t, video: { ...H264, epochMs: Date.UTC(2026, 0, 2, 3, 4, 5) }, audio: MP3, audioDur: 60, opts: {} });
  check('direct plan is one exec', plan.strategy === 'direct' && plan.steps.length === 1);
  const args = plan.steps[0].args;
  check('direct copies video', args.join(' ').includes('-c:v copy'));
  check('direct sets faststart', args.join(' ').includes('-movflags +faststart'));
  check('direct stamps creation_time', args.some((a) => a.startsWith('creation_time=2026-01-02T03:04:05')));
  check('direct clamps duration', args.join(' ').includes('-t 60'));
}
{
  // concat: audio longer on both sides, no trims
  const t = computeTimeline({ videoDur: 60, audioDur: 80, offset: -5 });
  const plan = buildPlan({ t, video: H264, audio: MP3, audioDur: 80, opts: {} });
  check('pads both sides → concat', plan.strategy === 'concat');
  const labels = plan.steps.map((s) => s.label).join(' | ');
  check('concat extracts both frames', labels.includes('first frame') && labels.includes('last frame'));
  const list = plan.steps.find((s) => s.kind === 'write');
  check('concat list orders lead/mid/tail',
    list && list.text === "file 'pad-lead.mp4'\nfile 'mid.mp4'\nfile 'pad-tail.mp4'\n");
  const pad = plan.steps.find((s) => s.label.startsWith('encode lead pad'));
  check('pad matches source profile/level', pad.args.join(' ').includes('-profile:v high')
    && pad.args.join(' ').includes('-level 4'));
  check('pad matches source timescale', pad.args.join(' ').includes('-video_track_timescale 15360'));
  const final = plan.steps[plan.steps.length - 1];
  check('final concat stream-copies video', final.args.join(' ').includes('-c:v copy'));
  check('concat plan carries a verify target', plan.verify && near(plan.verify.duration, 80));
  check('lead pad duration is 5s', pad.args.join(' ').includes('-t 5'));
}
{
  // reencode: exact start trim + tail pad
  const t = computeTimeline({ videoDur: 60, audioDur: 80, offset: 10, trimStart: true });
  const plan = buildPlan({ t, video: H264, audio: MP3, audioDur: 80, opts: { crf: 18, preset: 'fast' } });
  check('cut + pad → reencode', plan.strategy === 'reencode');
  const exec = plan.steps.find((s) => s.label.includes('re-encode'));
  const joined = exec.args.join(' ');
  check('reencode uses x264 with requested quality', joined.includes('libx264') && joined.includes('-crf 18') && joined.includes('-preset fast'));
  check('reencode seeks the input for a far-in trim', joined.includes('-ss 10')
    && joined.includes('trim=start=0:end=50'));
  check('reencode concats video + tail pad', joined.includes('concat=n=2:v=1:a=0'));
  check('reencode window duration', joined.includes('-t 80'));
}
{
  // audio entirely outside the trimmed window → silent track
  const t = computeTimeline({ videoDur: 10, audioDur: 5, offset: 30, trimEnd: true });
  const plan = buildPlan({ t, video: H264, audio: MP3, audioDur: 5, opts: {} });
  const joined = plan.steps[plan.steps.length - 1].args.join(' ');
  check('non-overlapping audio → anullsrc', joined.includes('anullsrc'));
}
{
  check('fmtSec trims to ms and avoids -0', fmtSec(1 / 3) === '0.333' && fmtSec(-0.0001) === '0' && fmtSec(60) === '60');
  check('EPS is small', EPS < 0.01);
}

// ── metadata sniffing ───────────────────────────────────────────────────
function u32be(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u32le(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
const A = (s) => [...s].map((c) => c.charCodeAt(0));

{
  // minimal mp4: ftyp + moov(mvhd v0), 5s at timescale 1000
  const when = Date.UTC(2026, 5, 7, 12, 30, 15) / 1000 + 2082844800;
  const mvhd = [...u32be(8 + 4 + 4 + 20), ...A('mvhd'), 0, 0, 0, 0, ...u32be(when), ...u32be(when), ...u32be(1000), ...u32be(5000)];
  const moov = [...u32be(8 + mvhd.length), ...A('moov'), ...mvhd];
  const ftyp = [...u32be(16), ...A('ftyp'), ...A('isom'), ...u32be(0)];
  const blob = new Blob([new Uint8Array([...ftyp, ...moov])]);
  const r = await sniffMediaInfo(blob);
  check('mp4 mvhd creation_time sniffed', r && r.clock && r.clock.epochMs === Date.UTC(2026, 5, 7, 12, 30, 15));
  check('mp4 source labeled UTC', r && r.clock && r.clock.source.includes('UTC'));
  check('mp4 mvhd duration sniffed', r && near(r.durationS, 5));
}
{
  // minimal BWF wav: fmt (44.1k stereo 16-bit) + data + bext with TimeReference
  const sr = 44100;
  const fmt = [...A('fmt '), ...u32le(16), ...u32le(0x00020001).slice(0, 4), ...u32le(sr), ...u32le(sr * 4), 4, 0, 16, 0];
  const data = [...A('data'), ...u32le(sr * 4 * 2)]; // declares 2s of samples
  const bextData = new Uint8Array(610);
  bextData.set(A('2026-06-07'), 320);
  bextData.set(A('10:00:00'), 330);
  const timeRef = sr * (10 * 3600 + 0 * 60 + 0) + sr / 2; // 10:00:00.5 since midnight
  new DataView(bextData.buffer).setUint32(338, timeRef, true);
  const bext = [...A('bext'), ...u32le(610), ...bextData];
  const body = [...A('WAVE'), ...fmt, ...bext, ...data];
  const wav = new Blob([new Uint8Array([...A('RIFF'), ...u32le(body.length), ...body])]);
  const r = await sniffWav(wav);
  const expect = new Date(2026, 5, 7, 10, 0, 0, 500).getTime();
  check('wav bext TimeReference sniffed sample-accurately', r && r.clock && r.clock.epochMs === expect);
  check('wav source mentions TimeReference', r && r.clock && r.clock.source.includes('TimeReference'));
  check('wav data/byteRate duration sniffed', r && near(r.durationS, 2));
}
{
  // ID3v2.4 TDRC
  const text = [3, ...A('2026-06-07T09:15:30')];
  const frame = [...A('TDRC'), 0, 0, (text.length >> 7) & 127, text.length & 127, 0, 0, ...text];
  const size = frame.length;
  const tag = [...A('ID3'), 4, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127, ...frame];
  const r = await sniffMp3(new Blob([new Uint8Array(tag)]));
  check('mp3 TDRC sniffed', r && r.clock && r.clock.epochMs === new Date(2026, 5, 7, 9, 15, 30).getTime());
}
{
  const r = await sniffMediaInfo(new Blob([new Uint8Array(64)]));
  check('unknown bytes sniff to null', r === null);
}

// ── ffprobe default-writer parsing (the wasm core ignores -print_format) ──
{
  const lines = [
    '[STREAM]', 'index=0', 'codec_name=vp8', 'codec_type=video',
    'width=640', 'height=360', 'pix_fmt=yuv420p', 'level=-99',
    'r_frame_rate=1000/1', 'avg_frame_rate=1000/1', 'time_base=1/1000',
    'duration=N/A', 'DISPOSITION:attached_pic=0',
    '[SIDE_DATA]', 'side_data_type=Display Matrix', 'rotation=-90', '[/SIDE_DATA]',
    'TAG:DURATION=00:00:05.973000000', '[/STREAM]',
    '[FORMAT]', 'format_name=matroska,webm', 'duration=5.973000',
    'TAG:ENCODER=Lavf61.1.100', '[/FORMAT]',
  ];
  const info = parseProbeSections(lines);
  check('sections → streams + format', info.streams.length === 1 && info.format.format_name === 'matroska,webm');
  check('numeric coercion on stream fields', info.streams[0].width === 640 && info.streams[0].level === -99);
  check('side data rotation parsed', streamRotation(info.streams[0]) === 90);
  const v = summarizeVideo(info, 'v.webm', 99);
  check('absurd matroska fps sanitized', v.fps === '30/1');
  check('duration falls back to format', near(v.duration, 5.973));
  check('N/A fields dropped', !('duration' in info.streams[0]));
}

// ── direct concat (no full-file remux) ──────────────────────────────────
{
  const H264A = { ...H264, srcAudio: { codec: 'aac', sampleRate: 48000, channels: 2, layoutOk: true } };
  const t = computeTimeline({ videoDur: 60, audioDur: 70, offset: 0 }); // tail pad
  const plan = buildPlan({ t, video: H264A, audio: MP3, audioDur: 70, opts: {} });
  check('direct-concat engages for clean [v,a] sources', plan.concatDirect === true);
  check('direct-concat skips the video-only remux', !plan.steps.some((x) => x.label.includes('lossless remux')));
  const list = plan.steps.find((x) => x.kind === 'write');
  check('direct-concat list references the source itself', list.text.includes("file 'v.mp4'"));
  const pad = plan.steps.find((x) => x.label.startsWith('encode tail pad'));
  const pj = pad.args.join(' ');
  check('direct-concat pads carry matching silent audio',
    pj.includes('anullsrc=r=48000:cl=stereo') && pj.includes('-c:a aac') && pj.includes('-shortest'));
  check('direct-concat still maps only concat video', plan.steps[plan.steps.length - 1].args.join(' ').includes('-map 0:v:0'));

  const mid = buildPlan({ t, video: H264A, audio: MP3, audioDur: 70, opts: { forceMidConcat: true } });
  check('forceMidConcat restores the remux path', !mid.concatDirect
    && mid.steps.some((x) => x.label.includes('lossless remux')));
  const extraTracks = buildPlan({ t, video: { ...H264A, srcAudio: { ...H264A.srcAudio, layoutOk: false } }, audio: MP3, audioDur: 70, opts: {} });
  check('extra/reordered tracks fall back to the remux path', !extraTracks.concatDirect);
  const opus = buildPlan({ t, video: { ...H264A, srcAudio: { ...H264A.srcAudio, codec: 'opus' } }, audio: MP3, audioDur: 70, opts: {} });
  check('unencodable silent codec falls back to the remux path', !opus.concatDirect);
  const noAud = buildPlan({ t, video: { ...H264A, srcAudio: null }, audio: MP3, audioDur: 70, opts: {} });
  check('audioless video falls back to the remux path', !noAud.concatDirect);
}

// ── test windows (endOverride + draft downscale) ────────────────────────
{
  // a sub-window override behaves like a fully-specified timeline
  const t = computeTimeline({ videoDur: 300, audioDur: 300, offset: 0, startOverride: 120, endOverride: 126 });
  check('window override sets the span', near(t.start, 120) && near(t.duration, 6));
  check('window override cuts video + audio alike',
    near(t.videoIn, 120) && near(t.videoOut, 126) && near(t.audioIn, 120) && near(t.audioOut, 126));
  // window reaching past the video picks up the tail pad, faithfully
  const t2 = computeTimeline({ videoDur: 300, audioDur: 320, offset: 0, startOverride: 297, endOverride: 305 });
  check('test window includes real pads', near(t2.padTail, 5) && near(t2.videoUsed, 3));
  // draft mode: forced reencode + downscale after the concat
  const plan = buildPlan({ t, video: H264, audio: MP3, audioDur: 300,
    opts: { videoMode: 'reencode', crf: 23, preset: 'ultrafast', previewHeight: 480 } });
  const joined = plan.steps[plan.steps.length - 1].args.join(' ');
  check('draft render downscales once', joined.includes('scale=-2:480'));
  check('draft render is fast/small', joined.includes('-preset ultrafast') && joined.includes('-crf 23'));
  const small = buildPlan({ t, video: { ...H264, width: 640, height: 360 }, audio: MP3, audioDur: 300,
    opts: { videoMode: 'reencode', previewHeight: 480 } });
  check('no upscale for small sources', !small.steps[small.steps.length - 1].args.join(' ').includes('scale=-2'));
}

// ── video-only gaps + "keep original audio" ─────────────────────────────
{
  // audio sits inside a longer video → gaps on both edges
  const t = computeTimeline({ videoDur: 60, audioDur: 30, offset: 10 });
  const g = computeGaps(t);
  check('gaps flank an audio island', near(g.lead, 10) && near(g.tail, 20));
  // audio longer on both sides → pads, no gaps
  const g2 = computeGaps(computeTimeline({ videoDur: 60, audioDur: 80, offset: -5 }));
  check('pads mean no gaps', g2.lead === 0 && g2.tail === 0);
  // audio entirely after the trimmed window → the whole video is a gap
  const g3 = computeGaps(computeTimeline({ videoDur: 10, audioDur: 5, offset: 30, trimEnd: true }));
  check('non-overlapping audio makes the video one big gap', near(g3.lead + g3.tail, 10));
}
{
  // direct + fill: graph splices video-audio around the replacement
  const t = computeTimeline({ videoDur: 60, audioDur: 30, offset: 10 });
  const plan = buildPlan({ t, video: H264, audio: { ...MP3, channels: 2 }, audioDur: 30,
    opts: { keepVideoAudio: true, videoHasAudio: true } });
  const joined = plan.steps[0].args.join(' ');
  check('fill stays direct (video still copied)', plan.strategy === 'direct' && joined.includes('-c:v copy'));
  const fc = plan.steps[0].args[plan.steps[0].args.indexOf('-filter_complex') + 1];
  check('fill trims the lead from the video track', fc.includes('[0:a:0]atrim=start=0:end=10'));
  // the tail reads from a DEDICATED input seeked to its start (no
  // decode-and-discard of the whole file), so its atrim is relative
  check('fill tail uses the seeked extra input', fc.includes('[2:a:0]atrim=start=0:end=20'));
  check('fill tail input is seeked', plan.steps[0].args.join(' ').includes('-ss 40 -i v.mp4'));
  check('fill places the replacement between', fc.includes('[1:a:0]atrim=start=0:end=30'));
  check('fill concats three segments', fc.includes('concat=n=3:v=0:a=1'));
  check('fill has seam fades', fc.includes('afade=t=in') && fc.includes('afade=t=out'));
  check('fill maps the graph audio', joined.includes('-map [aout]'));
  check('fill notes the spans', plan.notes.some((n) => n.includes("original audio")));
}
{
  // fill + copy request: copy must give way to transcode
  const t = computeTimeline({ videoDur: 60, audioDur: 30, offset: 10 });
  const plan = buildPlan({ t, video: H264, audio: { path: 'a.m4a', codec: 'aac', channels: 2 }, audioDur: 30,
    opts: { keepVideoAudio: true, videoHasAudio: true, audioMode: 'copy' } });
  check('fill overrides audio copy', !plan.audioCopied
    && plan.steps[0].args.join(' ').includes('-c:a aac'));
}
{
  // fill requested but the video has no audio → silence, with a note
  const t = computeTimeline({ videoDur: 60, audioDur: 30, offset: 10 });
  const plan = buildPlan({ t, video: H264, audio: MP3, audioDur: 30,
    opts: { keepVideoAudio: true, videoHasAudio: false } });
  check('no video audio → graceful silence note', plan.notes.some((n) => n.includes('no audio track')));
  check('no video audio → no filter_complex', !plan.steps[0].args.includes('-filter_complex'));
}
{
  // concat strategy + fill: original video rides along as an extra input
  const t = computeTimeline({ videoDur: 60, audioDur: 80, offset: 10 });
  const g = computeGaps(t);
  check('tail pad + lead gap coexist', near(g.lead, 10) && g.tail === 0 && near(t.padTail, 30));
  const plan = buildPlan({ t, video: H264, audio: { ...MP3, channels: 2 }, audioDur: 80,
    opts: { keepVideoAudio: true, videoHasAudio: true } });
  check('still concat with fill', plan.strategy === 'concat');
  const final = plan.steps[plan.steps.length - 1];
  const vIn = final.args.filter((a) => a === 'v.mp4').length;
  check('video file added as the audio source input', vIn === 1);
  const fc = final.args[final.args.indexOf('-filter_complex') + 1];
  check('concat-fill pulls video audio from input 2', fc.includes('[2:a:0]atrim=start=0:end=10'));
}

// ── transient correlation (the "matching sound" mode) ───────────────────
// Two mono PCM tracks sharing a click train at a known offset, each with its
// own independent noise bed — the shape of a camera mic vs a field recorder.
{
  const lcg = (seed) => () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  function makeTrack(rate, dur, clickTimes, noiseSeed, noiseAmp) {
    const rnd = lcg(noiseSeed);
    const pcm = new Float32Array(Math.round(rate * dur));
    for (let i = 0; i < pcm.length; i++) pcm[i] = (rnd() * 2 - 1) * noiseAmp;
    const burst = Math.round(rate * 0.03);
    const crnd = lcg(1234);
    for (const t of clickTimes) {
      const at = Math.round(t * rate);
      for (let j = 0; j < burst && at + j < pcm.length; j++) {
        pcm[at + j] += (crnd() * 2 - 1) * 0.8 * (1 - j / burst);
      }
    }
    return pcm;
  }
  const clicks = [0.9, 2.2, 4.8, 7.1, 9.4, 12.0, 15.3, 18.8, 22.6, 26.1];

  // audio started 3.217s BEFORE the video → offset −3.217 (clicks land later in the audio)
  {
    const ref = makeTrack(2000, 30, clicks, 11, 0.05);
    const sig = makeTrack(2000, 36, clicks.map((t) => t + 3.217), 77, 0.05);
    const r = correlatePcm(ref, sig, 2000, { envRate: 50 });
    check('coarse lag recovered (negative offset)', Math.abs(r.lagSec - -3.217) < 0.03, `got ${r.lagSec}`);
    check('coarse match passes both gates', r.z >= MIN_COARSE_Z && r.ratio >= MIN_PEAK_RATIO, `z=${r.z} ratio=${r.ratio}`);
  }
  // audio started 5.5s AFTER the video → offset +5.5
  {
    const ref = makeTrack(2000, 30, clicks, 11, 0.05);
    const sig = makeTrack(2000, 20, clicks.map((t) => t - 5.5).filter((t) => t > 0.1), 77, 0.05);
    const r = correlatePcm(ref, sig, 2000, { envRate: 50 });
    check('coarse lag recovered (positive offset)', Math.abs(r.lagSec - 5.5) < 0.03, `got ${r.lagSec}`);
  }
  // refine stage: high rate, small lag, restricted search
  {
    const fine = [0.5, 1.4, 2.9, 4.2, 5.8, 7.3, 8.8];
    const ref = makeTrack(8000, 10, fine, 11, 0.05);
    const sig = makeTrack(8000, 10, fine.map((t) => t + 0.113), 77, 0.05);
    const r = correlatePcm(ref, sig, 8000, { envRate: 250, minLagSec: -2.5, maxLagSec: 2.5 });
    check('refine lag within a few ms', Math.abs(r.lagSec - -0.113) < 0.008, `got ${r.lagSec}`);
  }
  // unrelated audio must not fake a match (the peak-ratio gate catches the
  // chance coincidences that MAD-z alone over-trusts on sparse envelopes)
  {
    const ref = makeTrack(2000, 30, clicks, 11, 0.3);
    const sig = makeTrack(2000, 30, [1.1, 3.7, 6.2, 9.9, 14.4, 19.1, 24.8], 77, 0.3);
    const r = correlatePcm(ref, sig, 2000, { envRate: 50 });
    check('unrelated tracks fail the combined gate',
      !(r.z >= MIN_COARSE_Z && r.ratio >= MIN_PEAK_RATIO), `z=${r.z} ratio=${r.ratio}`);
  }
  // silence never divides by zero
  {
    const r = correlatePcm(new Float32Array(2000 * 5), new Float32Array(2000 * 5), 2000, { envRate: 50 });
    check('silent tracks yield zero confidence', r.z === 0 || r.z < MIN_COARSE_Z);
  }
}

// ── segmented (checkpointable) re-encode ────────────────────────────────
{
  const t = computeTimeline({ videoDur: 400, audioDur: 400, offset: 0 });
  const wins = segmentWindows(t, 60);
  check('segments cover the window seamlessly', wins.length === 7
    && near(wins[0][0], t.start) && near(wins[wins.length - 1][1], t.end)
    && wins.every((w, i) => i === 0 || near(w[0], wins[i - 1][1])));
  const lens = wins.map(([a, b]) => b - a);
  check('segments are near-equal (no sliver tail)',
    Math.max(...lens) - Math.min(...lens) < 0.001);
  check('short windows make one segment', segmentWindows(computeTimeline({ videoDur: 50, audioDur: 50, offset: 0 }), 60).length === 1);

  // a mid-timeline segment: video-only, seeked input, no audio anywhere
  const tSeg = computeTimeline({ videoDur: 400, audioDur: 400, offset: 0, startOverride: wins[3][0], endOverride: wins[3][1] });
  const segPlan = buildPlan({ t: tSeg, video: H264, audio: MP3, audioDur: 400,
    opts: { videoMode: 'reencode', videoOnly: true, crf: 17 } });
  const segJoined = segPlan.steps[segPlan.steps.length - 1].args.join(' ');
  check('segment renders video-only', segJoined.includes('-an') && !segJoined.includes('a.mp3')
    && !segJoined.includes('aac'));
  check('segment seeks instead of decoding from zero', segJoined.includes(`-ss ${fmtSec(wins[3][0])}`));

  // the stitch pass: concat copy + one full-length audio pass
  const asm = buildAssemblePlan({ t, video: H264, audio: MP3, audioDur: 400, opts: {} });
  const aj = asm.steps[0].args.join(' ');
  check('assemble stream-copies the stitched video', aj.includes('-f concat') && aj.includes('-c:v copy'));
  check('assemble encodes audio once, full length', aj.includes('-c:a aac') && aj.includes('-t 400'));
  check('assemble carries a verify target', asm.verify && near(asm.verify.duration, 400));
  const asmFill = buildAssemblePlan({
    t: computeTimeline({ videoDur: 400, audioDur: 200, offset: 100 }),
    video: H264, audio: { ...MP3, channels: 2 }, audioDur: 200,
    opts: { keepVideoAudio: true, videoHasAudio: true },
  });
  check('assemble honors keep-original-audio', asmFill.steps[0].args.join(' ').includes('[2:a:0]atrim='));
}
{
  const base = { v: { name: 'a', size: 1, lastModified: 2 }, start: '0', end: '400', crf: 17, preset: 'veryfast', segLen: 60, n: 7 };
  check('job key is stable', jobKeyOf(base) === jobKeyOf(JSON.parse(JSON.stringify(base))));
  check('job key tracks settings', jobKeyOf(base) !== jobKeyOf({ ...base, crf: 18 })
    && jobKeyOf(base) !== jobKeyOf({ ...base, end: '399' }));
}

// ── decoded-audio cache packing ─────────────────────────────────────────
{
  // the decode was s16 (÷32768), so pack→unpack must be bit-exact
  const src = new Float32Array([0, 1 / 32768, -1 / 32768, 12345 / 32768, -32768 / 32768, 32767 / 32768]);
  const round = i16ToF32(f32ToI16(src));
  check('pcm pack/unpack is lossless for s16-derived floats',
    round.length === src.length && round.every((v, i) => v === src[i]));
  const clip = f32ToI16(new Float32Array([1.5, -1.5]));
  check('pcm pack clamps out-of-range', clip[0] === 32767 && clip[1] === -32768);
  const k = { name: 'v.mp4', size: 9, lastModified: 3 };
  check('pcm keys separate params and files',
    pcmKeyOf(k, { rate: 2000, t: 60 }) !== pcmKeyOf(k, { rate: 8000, t: 60 })
    && pcmKeyOf(k, { rate: 2000, t: 60 }) !== pcmKeyOf({ ...k, size: 10 }, { rate: 2000, t: 60 })
    && pcmKeyOf(k, { rate: 2000, t: 60 }) === pcmKeyOf({ ...k }, { rate: 2000, t: 60 }));
}

// ── ffmpeg script export ────────────────────────────────────────────────
{
  check('plain args pass unquoted', shellQuote('-c:v') === '-c:v' && shellQuote('out.mp4') === 'out.mp4');
  check('spaces and quotes get shell-safe quoting',
    shellQuote('my gig.mp4') === "'my gig.mp4'"
    && shellQuote("it's.mp4") === "'it'\\''s.mp4'");
  const t = computeTimeline({ videoDur: 60, audioDur: 70, offset: 0 });
  const plan = buildPlan({
    t,
    video: { ...H264, path: 'my gig video.mp4', srcAudio: { codec: 'aac', sampleRate: 48000, channels: 2, layoutOk: true } },
    audio: { ...MP3, path: 'board mix.mp3' },
    audioDur: 70, opts: {},
  });
  const script = planToScript(plan, { outName: 'my gig video.syzygy.mp4', header: ['test header'] });
  check('script is bash with strict mode', script.startsWith('#!/usr/bin/env bash') && script.includes('set -euo pipefail'));
  check('script quotes the real filenames', script.includes("'my gig video.mp4'") && script.includes("'board mix.mp3'"));
  check('script renames the final output', script.includes("'my gig video.syzygy.mp4'") && !/ffmpeg[^\n]* out\.mp4/.test(script));
  check('write steps become heredocs', script.includes("cat > concat.txt <<'SYZYGY_EOF'"));
  check('script cleans intermediates', /rm -f .*pad-tail\.mp4/.test(script) && /rm -f .*concat\.txt/.test(script));
  check('script carries strategy + notes as comments', script.includes('# strategy: concat (direct concat)') && script.includes('# test header'));
}

// ── session persistence (pure serialize/apply parts) ────────────────────
{
  const mkState = () => ({
    align: 'sound', manualOffset: -1.35, adjust: 0.02, trimStart: true, trimEnd: false,
    keepVideoAudio: true, audioMode: 'copy', videoMode: 'reencode', crf: 20, preset: 'fast',
    testStart: 12, testLen: 8,
    pad: { lead: { mode: 'time', time: 3.5, file: null }, tail: { mode: 'image', time: 0, file: null } },
  });
  const src = mkState();
  const saved = JSON.parse(JSON.stringify(serializeSettings(src)));
  const dst = { pad: { lead: {}, tail: {} } };
  check('settings survive a JSON round-trip', applySettings(dst, saved) === true
    && dst.align === 'sound' && dst.manualOffset === -1.35 && dst.trimStart && dst.keepVideoAudio
    && dst.audioMode === 'copy' && dst.crf === 20 && dst.preset === 'fast'
    && dst.testStart === 12 && dst.pad.lead.mode === 'time' && near(dst.pad.lead.time, 3.5));
  check('persisted image pad without its file degrades to adjacent', dst.pad.tail.mode === 'adjacent');
  const hostile = { v: 1, align: 'evil', audioMode: 'x', videoMode: 'x', preset: 'x',
    crf: 9999, manualOffset: 'NaN?', testLen: -5, pad: { lead: { mode: 'x' } } };
  const d2 = { pad: { lead: {}, tail: {} } };
  applySettings(d2, hostile);
  check('hostile stored values are clamped to safe defaults',
    d2.align === 'zero' && d2.audioMode === 'auto' && d2.videoMode === 'auto'
    && d2.preset === 'veryfast' && d2.crf === 35 && d2.manualOffset === 0
    && d2.testLen === 1 && d2.pad.lead.mode === 'adjacent');
  check('wrong version is rejected', applySettings(d2, { v: 99 }) === false
    && applySettings(d2, null) === false);
  const f1 = { name: 'a.mp4', size: 10, lastModified: 111 };
  const f2 = { name: 'b.wav', size: 20, lastModified: 222 };
  check('pair key is order-sensitive and identity-complete',
    pairKey(f1, f2) !== pairKey(f2, f1)
    && pairKey(f1, f2) === pairKey({ ...f1 }, { ...f2 })
    && pairKey(f1, f2) !== pairKey({ ...f1, size: 11 }, f2));
  check('fileKeyOf extracts identity', (() => {
    const k = fileKeyOf({ name: 'x', size: 5, lastModified: 9, extra: true });
    return k.name === 'x' && k.size === 5 && k.lastModified === 9 && !('extra' in k);
  })());
}

if (failures) {
  console.error(`\ncheck-syzygy-plan: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-syzygy-plan: all good');
