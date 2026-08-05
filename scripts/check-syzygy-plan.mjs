// Node smoke test for the syzygy lab's planning + metadata modules.
// plan.js is pure data-in/data-out and meta.js reads Blobs (node's Blob
// works), so we exercise the real timeline math, strategy ladder, ffmpeg
// arg builders, and the binary datetime sniffers. Run via `npm run check`.

import {
  computeTimeline, chooseStrategy, chooseContainer, planAudio, buildPlan, fmtSec, EPS,
} from '../src/lib/syzygy/plan.js';
import { sniffMediaInfo, sniffWav, sniffMp3 } from '../src/lib/syzygy/meta.js';
import { parseProbeSections, summarizeVideo, streamRotation } from '../src/lib/syzygy/engine.js';

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
  check('reencode trims the video segment', joined.includes('trim=start=10:end=60'));
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

if (failures) {
  console.error(`\ncheck-syzygy-plan: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-syzygy-plan: all good');
