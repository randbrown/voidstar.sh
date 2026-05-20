// Append an industry-standard SMPTE timecode track to an MP4 produced by
// Chrome's MediaRecorder, and stamp the real wall-clock capture time into
// the movie / track / media headers. This is what lets a qualia-lab
// recording drop onto a Reaper / Resolve / Premiere / FCP timeline at the
// right place: the NLE reads the embedded start timecode and the
// creation_time and lines the clip up against any other source captured
// at the same moment.
//
// Two things get written:
//
//  1. creation_time / modification_time — MediaRecorder leaves every
//     mvhd / tkhd / mdhd at the 1904 epoch zero. We overwrite them with
//     the actual capture wall-clock (seconds since 1904-01-01 UTC, the
//     MP4 epoch). NLEs surface this as the clip's "media created" date.
//
//  2. A `tmcd` timecode track — the QuickTime/ISO timecode media that
//     every professional NLE reads natively. It carries a single 4-byte
//     sample: the frame number of the recording's first frame. We set
//     that to TIME-OF-DAY — frames since local midnight — so the
//     recording's timecode is wall-clock time of day and any other
//     device rolling at the same instant shares the same TC. Non-drop,
//     24-hour-wrap, at the capture frame rate (30 fps viewport / 60 fps
//     tab capture).
//
// Why a separate track and not just metadata: tmcd is the de-facto
// interchange format for start timecode in .mp4 / .mov, written by
// ffmpeg's `-timecode` and read by Resolve, Premiere, FCP, Avid and
// Reaper's video import. A `udta` comment string is not.
//
// ── How the surgery stays safe ──────────────────────────────────────────
// Chrome's MediaRecorder emits a FRAGMENTED MP4: `ftyp`, then `moov`
// (with `mvex`, and tracks whose `stbl` is empty), then a long run of
// `moof`+`mdat` fragment pairs. We:
//
//   • build a new, fully self-contained `trak` (the timecode track keeps
//     all of its one sample in the initial-movie `stbl` — it never
//     appears in a fragment, which is legal ISOBMFF);
//   • insert that trak into `moov` and add a matching `trex` to `mvex`;
//   • append a tiny `mdat` at the very end of the file holding the
//     4-byte timecode sample, and point the track's `co64` at it.
//
// Growing `moov` shifts every byte after it. That is safe ONLY because
// Chrome's fragments are addressed relative to their own `moof`
// (`tfhd` default-base-is-moof, flag 0x020000) — so a constant shift of
// the whole fragment run doesn't move anything relative to anything.
// Before touching the file we scan for the hazards that WOULD break
// under a shift — a `tfhd` with an absolute base-data-offset, an `mfra`
// random-access index, `saio` auxiliary offsets — and if any are found
// we bail and return the input untouched. A non-fragmented input (no
// `mvex`) is handled by patching its existing `stco`/`co64` chunk
// offsets by the moov growth instead.
//
// Anything unexpected → return the original blob. A recording that
// merely lacks a timecode track is fine; a corrupted one is not.

// Seconds between the MP4 epoch (1904-01-01 00:00:00 UTC) and the Unix
// epoch (1970-01-01). MP4 header times are u32/u64 seconds since 1904.
const MP4_EPOCH_OFFSET = 2082844800;

// ── little-endian-free byte builders ───────────────────────────────────
// Every multi-byte field in ISOBMFF is big-endian.
function u8b(...vals) { return new Uint8Array(vals); }
function u16(n) {
  return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
}
function u32(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function u64(n) {
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return new Uint8Array([
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
  ]);
}
function fourcc(s) {
  return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
}
/** UTF-8, NUL-terminated — the ISOBMFF `hdlr` name string format. */
function cstr(s) {
  const t = new TextEncoder().encode(s);
  const out = new Uint8Array(t.length + 1);
  out.set(t);
  return out;
}
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
/** A plain box: size(4) + type(4) + payload. */
function box(type, ...payload) {
  const body = concat(payload);
  return concat([u32(body.length + 8), fourcc(type), body]);
}
/** A full box: size(4) + type(4) + version(1) + flags(3) + payload. */
function fullbox(type, version, flags, ...payload) {
  return box(type, u8b(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...payload);
}

// 3x3 video transform matrix, identity (16.16 / 2.30 fixed point).
const IDENTITY_MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

// ── box parsing (one level, non-recursive) ─────────────────────────────
function boxLen(dv, p, end) {
  const s = dv.getUint32(p);
  if (s === 1) {
    const hi = dv.getUint32(p + 8);
    const lo = dv.getUint32(p + 12);
    return hi * 0x100000000 + lo;
  }
  if (s === 0) return end - p;          // box runs to end-of-parent
  return s;
}
function boxType(u8, p) {
  return String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
}
/** List the immediate child boxes in [start, end). */
function listBoxes(dv, u8, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    const size = boxLen(dv, p, end);
    if (!size || size < 8 || p + size > end) break;
    out.push({ type: boxType(u8, p), pos: p, size, end: p + size });
    p += size;
  }
  return out;
}
function findBox(boxes, type) {
  return boxes.find(b => b.type === type) || null;
}

/**
 * Build the timecode `trak` box.
 *
 * @param {object} a
 * @param {number} a.trackId        track_ID for the new track
 * @param {number} a.movieTimescale mvhd timescale (for tkhd duration)
 * @param {number} a.durationMs     recording duration, ms
 * @param {number} a.fps            timecode frame rate (integer, non-drop)
 * @param {number} a.mp4Time        capture time, seconds since 1904 epoch
 * @param {number} a.frameNumber    timecode value — frames since midnight
 * @param {number} a.sampleOffset   absolute file offset of the 4-byte sample
 */
function buildTimecodeTrak(a) {
  const movieDur = Math.max(0, Math.round(a.durationMs * a.movieTimescale / 1000));
  const mediaDur = Math.max(1, Math.round(a.durationMs * a.fps / 1000));

  // tkhd — track_enabled | in_movie | in_preview (0x7). Volume 0 (non-audio),
  // width/height 0 (non-visual). Identity matrix.
  const tkhd = fullbox('tkhd', 0, 0x000007,
    u32(a.mp4Time), u32(a.mp4Time),       // creation, modification
    u32(a.trackId), u32(0),               // track_ID, reserved
    u32(movieDur),                        // duration (movie timescale)
    u32(0), u32(0),                       // reserved
    u16(0), u16(0),                       // layer, alternate_group
    u16(0), u16(0),                       // volume, reserved
    IDENTITY_MATRIX,
    u32(0), u32(0));                      // width, height (16.16)

  // mdhd — media timescale IS the frame rate, so one frame = one tick.
  // Language 0x55C4 = 'und' (undetermined).
  const mdhd = fullbox('mdhd', 0, 0,
    u32(a.mp4Time), u32(a.mp4Time),       // creation, modification
    u32(a.fps),                           // timescale
    u32(mediaDur),                        // duration (frames)
    u16(0x55C4), u16(0));                 // language, pre_defined

  const hdlr = fullbox('hdlr', 0, 0,
    u32(0),                               // pre_defined
    fourcc('tmcd'),                       // handler_type
    u32(0), u32(0), u32(0),               // reserved
    cstr('VoidStar Timecode'));

  // ── minf for a timecode media ──
  // gmhd (base media header) carries gmin + a tmcd-container holding tcmi.
  const gmin = fullbox('gmin', 0, 0,
    u16(0x0040),                          // graphics mode (copy)
    u16(0x8000), u16(0x8000), u16(0x8000),// opcolor
    u16(0),                               // balance
    u16(0));                              // reserved
  const tcmi = fullbox('tcmi', 0, 0,
    u16(0), u16(0),                       // text font, text face
    u16(12), u16(0),                      // text size, reserved
    u16(0xffff), u16(0xffff), u16(0xffff),// text color (white)
    u16(0), u16(0), u16(0),               // background color (black)
    u8b(0));                              // font name — empty pascal string
  const gmhd = box('gmhd', gmin, box('tmcd', tcmi));

  // dinf/dref — one self-contained data reference (flag 1 = data is in
  // this file, no URL string).
  const dref = fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1));
  const dinf = box('dinf', dref);

  // stsd → tmcd sample entry. Layout after the 8-byte SampleEntry header
  // (6 reserved + 2 data_reference_index): reserved(4), flags(4),
  // timescale(4), frame_duration(4), number_of_frames(1), reserved(1).
  // flags 0x0002 = 24-hour max (wrap at 24:00:00:00) — required because
  // our value is a time-of-day. Drop-frame bit stays 0: integer fps.
  const tmcdEntry = box('tmcd',
    new Uint8Array(6),                    // reserved
    u16(1),                               // data_reference_index
    u32(0),                               // reserved
    u32(0x00000002),                      // timecode flags: 24-hour max
    u32(a.fps),                           // timescale
    u32(1),                               // frame duration
    u8b(a.fps & 0xff, 0));                // number_of_frames, reserved

  const stsd = fullbox('stsd', 0, 0, u32(1), tmcdEntry);
  const stts = fullbox('stts', 0, 0, u32(1), u32(1), u32(mediaDur));
  const stsc = fullbox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));
  // stsz with a non-zero default sample size → no per-sample table.
  const stsz = fullbox('stsz', 0, 0, u32(4), u32(1));
  // co64 (64-bit) not stco — recordings can exceed 4 GB.
  const co64 = fullbox('co64', 0, 0, u32(1), u64(a.sampleOffset));
  const stbl = box('stbl', stsd, stts, stsc, stsz, co64);

  const minf = box('minf', gmhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  return box('trak', tkhd, mdia);
}

/** trex giving fragment defaults for the new track (it never fragments,
 *  so the values are unused — presence just satisfies strict parsers
 *  that expect a trex per track when `mvex` is present). */
function buildTrex(trackId) {
  return fullbox('trex', 0, 0,
    u32(trackId),                         // track_ID
    u32(1),                               // default_sample_description_index
    u32(0), u32(0), u32(0));              // default duration / size / flags
}

/** Overwrite creation_time + modification_time of an mvhd/tkhd/mdhd box,
 *  handling both version 0 (32-bit) and version 1 (64-bit) layouts. */
function stampTimes(dv, u8, b, mp4Time) {
  const version = u8[b.pos + 8];
  const f = b.pos + 12;                   // past size(4)+type(4)+ver/flags(4)
  if (version === 1) {
    dv.setUint32(f, Math.floor(mp4Time / 0x100000000));
    dv.setUint32(f + 4, mp4Time >>> 0);
    dv.setUint32(f + 8, Math.floor(mp4Time / 0x100000000));
    dv.setUint32(f + 12, mp4Time >>> 0);
  } else {
    dv.setUint32(f, mp4Time >>> 0);
    dv.setUint32(f + 4, mp4Time >>> 0);
  }
}

/** Read a tkhd's track_ID (version-aware). */
function readTrackId(dv, u8, tkhd) {
  const version = u8[tkhd.pos + 8];
  const f = tkhd.pos + 12;
  return version === 1 ? dv.getUint32(f + 16) : dv.getUint32(f + 8);
}

/**
 * Detect fragment-offset hazards that a moov-size change would corrupt.
 * Returns true → caller must NOT shift the file. Chrome's MediaRecorder
 * never trips this; the check is a guard against other encoders.
 */
function hasShiftHazards(dv, u8, topBoxes) {
  // mfra: random-access index with absolute moof offsets.
  if (findBox(topBoxes, 'mfra')) return true;
  // Inspect the first moof's first traf: an absolute tfhd base-data-offset
  // (flag 0x000001) or any saio means fragment data isn't moof-relative.
  const moof = findBox(topBoxes, 'moof');
  if (moof) {
    const moofKids = listBoxes(dv, u8, moof.pos + 8, moof.end);
    const traf = findBox(moofKids, 'traf');
    if (traf) {
      const trafKids = listBoxes(dv, u8, traf.pos + 8, traf.end);
      if (findBox(trafKids, 'saio')) return true;
      const tfhd = findBox(trafKids, 'tfhd');
      if (tfhd) {
        const flags = dv.getUint32(tfhd.pos + 8) & 0x00ffffff;
        if (flags & 0x000001) return true;     // base-data-offset-present
      }
    }
  }
  return false;
}

/**
 * Append a SMPTE timecode track + stamp wall-clock times into an MP4 blob.
 *
 * @param {Blob}   blob              MP4 blob (already duration-fixed)
 * @param {object} opts
 * @param {number} opts.durationMs   recording duration in milliseconds
 * @param {number} opts.fps          capture frame rate (e.g. 30 or 60)
 * @param {Date}   opts.startDate    wall-clock time of the first frame
 * @returns {Promise<Blob>} new blob, same MIME type — or the input
 *          unchanged if the file shape is anything we don't expect.
 */
export async function addTimecodeTrack(blob, { durationMs, fps, startDate }) {
  try {
    if (!blob || !startDate || !(fps > 0)) return blob;
    const buf = await blob.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    if (u8.byteLength < 16) return blob;

    const topBoxes = listBoxes(dv, u8, 0, u8.byteLength);
    const moov = findBox(topBoxes, 'moov');
    if (!moov) {
      console.warn('[mp4-timecode] no moov box — skipping');
      return blob;
    }

    const moovKids = listBoxes(dv, u8, moov.pos + 8, moov.end);
    const mvhd = findBox(moovKids, 'mvhd');
    if (!mvhd) {
      console.warn('[mp4-timecode] no mvhd box — skipping');
      return blob;
    }
    const mvex = findBox(moovKids, 'mvex');

    // A fragmented file is only safe to shift if its fragments are
    // moof-relative. A non-fragmented file (no mvex) is handled below by
    // patching its existing chunk offsets instead.
    if (mvex && hasShiftHazards(dv, u8, topBoxes)) {
      console.warn('[mp4-timecode] fragments use absolute offsets — skipping to avoid corruption');
      return blob;
    }

    // ── movie timescale + version ──
    const mvhdVer = u8[mvhd.pos + 8];
    const movieTimescale = mvhdVer === 1
      ? dv.getUint32(mvhd.pos + 12 + 16)
      : dv.getUint32(mvhd.pos + 12 + 8);
    if (!(movieTimescale > 0)) {
      console.warn('[mp4-timecode] bad movie timescale — skipping');
      return blob;
    }

    // ── pick the new track_ID from mvhd.next_track_ID (last 4 bytes) ──
    let nextTrackId = dv.getUint32(mvhd.end - 4);
    const existingTraks = moovKids.filter(b => b.type === 'trak');
    if (!nextTrackId || nextTrackId === 0xffffffff) {
      // next_track_ID unusable — derive max(existing track_ID)+1.
      let maxId = 0;
      for (const trak of existingTraks) {
        const tkhd = findBox(listBoxes(dv, u8, trak.pos + 8, trak.end), 'tkhd');
        if (tkhd) maxId = Math.max(maxId, readTrackId(dv, u8, tkhd));
      }
      nextTrackId = maxId + 1;
    }
    const newTrackId = nextTrackId;

    // ── wall-clock → MP4 time + time-of-day frame number ──
    const mp4Time = Math.floor(startDate.getTime() / 1000) + MP4_EPOCH_OFFSET;
    const secsSinceMidnight =
      startDate.getHours() * 3600 +
      startDate.getMinutes() * 60 +
      startDate.getSeconds() +
      startDate.getMilliseconds() / 1000;
    const framesPerDay = Math.round(fps) * 86400;
    let frameNumber = Math.round(secsSinceMidnight * Math.round(fps));
    frameNumber = ((frameNumber % framesPerDay) + framesPerDay) % framesPerDay;

    // ── stamp creation/modification times into mvhd + every trak ──
    stampTimes(dv, u8, mvhd, mp4Time);
    for (const trak of existingTraks) {
      const trakKids = listBoxes(dv, u8, trak.pos + 8, trak.end);
      const tkhd = findBox(trakKids, 'tkhd');
      if (tkhd) stampTimes(dv, u8, tkhd, mp4Time);
      const mdia = findBox(trakKids, 'mdia');
      if (mdia) {
        const mdhd = findBox(listBoxes(dv, u8, mdia.pos + 8, mdia.end), 'mdhd');
        if (mdhd) stampTimes(dv, u8, mdhd, mp4Time);
      }
    }

    // ── size the new boxes, then compute the moov growth ──
    // buildTimecodeTrak's length is independent of the co64 VALUE, so a
    // throwaway build with offset 0 gives us the exact growth up front.
    const trex = mvex ? buildTrex(newTrackId) : null;
    const probeTrak = buildTimecodeTrak({
      trackId: newTrackId, movieTimescale, durationMs, fps,
      mp4Time, frameNumber, sampleOffset: 0,
    });
    const moovGrowth = probeTrak.length + (trex ? trex.length : 0);

    // The 4-byte timecode sample lives in an `mdat` appended after every
    // existing byte. Final layout: [..moov(grown)..][..fragments..][mdat].
    const sampleOffset = u8.byteLength + moovGrowth + 8;   // +8 = mdat header
    const newTrak = buildTimecodeTrak({
      trackId: newTrackId, movieTimescale, durationMs, fps,
      mp4Time, frameNumber, sampleOffset,
    });

    // ── bump mvhd.next_track_ID ──
    dv.setUint32(mvhd.end - 4, newTrackId + 1);

    // ── non-fragmented input: shift existing chunk offsets ──
    // Every stco/co64 entry that points past moov moves by moovGrowth.
    // (Fragmented inputs have empty stbl, so this loop is a no-op there.)
    if (!mvex) {
      for (const trak of existingTraks) {
        const trakKids = listBoxes(dv, u8, trak.pos + 8, trak.end);
        const mdia = findBox(trakKids, 'mdia');
        if (!mdia) continue;
        const minf = findBox(listBoxes(dv, u8, mdia.pos + 8, mdia.end), 'minf');
        if (!minf) continue;
        const stbl = findBox(listBoxes(dv, u8, minf.pos + 8, minf.end), 'stbl');
        if (!stbl) continue;
        const stblKids = listBoxes(dv, u8, stbl.pos + 8, stbl.end);
        const stco = findBox(stblKids, 'stco');
        if (stco) {
          const count = dv.getUint32(stco.pos + 12);
          for (let i = 0; i < count; i++) {
            const at = stco.pos + 16 + i * 4;
            const v = dv.getUint32(at);
            if (v > moov.pos) dv.setUint32(at, v + moovGrowth);
          }
        }
        const co64 = findBox(stblKids, 'co64');
        if (co64) {
          const count = dv.getUint32(co64.pos + 12);
          for (let i = 0; i < count; i++) {
            const at = co64.pos + 16 + i * 8;
            const hi = dv.getUint32(at), lo = dv.getUint32(at + 4);
            const v = hi * 0x100000000 + lo;
            if (v > moov.pos) {
              const nv = v + moovGrowth;
              dv.setUint32(at, Math.floor(nv / 0x100000000));
              dv.setUint32(at + 4, nv >>> 0);
            }
          }
        }
      }
    }

    // ── rebuild moov: insert newTrak before mvex (or at end), grow mvex ──
    const moovPayloadStart = moov.pos + 8;
    let newMoovPayload;
    if (mvex) {
      // mvex with the extra trex appended inside it.
      const grownMvex = concat([
        u32(mvex.size + trex.length), fourcc('mvex'),
        u8.subarray(mvex.pos + 8, mvex.end),
        trex,
      ]);
      newMoovPayload = concat([
        u8.subarray(moovPayloadStart, mvex.pos),   // mvhd + existing traks
        newTrak,
        grownMvex,
        u8.subarray(mvex.end, moov.end),           // udta / anything trailing
      ]);
    } else {
      newMoovPayload = concat([
        u8.subarray(moovPayloadStart, moov.end),
        newTrak,
      ]);
    }
    const newMoov = concat([u32(newMoovPayload.length + 8), fourcc('moov'), newMoovPayload]);

    // ── the timecode sample, in its own mdat at end of file ──
    const tcMdat = concat([u32(12), fourcc('mdat'), u32(frameNumber)]);

    const out = concat([
      u8.subarray(0, moov.pos),         // ftyp (and anything before moov)
      newMoov,
      u8.subarray(moov.end),            // every moof+mdat fragment, shifted
      tcMdat,
    ]);

    console.log(
      `[mp4-timecode] track ${newTrackId} added · ${fps}fps non-drop · ` +
      `start ${tcString(frameNumber, fps)} · ${out.length} bytes`
    );
    return new Blob([out], { type: blob.type });
  } catch (err) {
    console.warn('[mp4-timecode] failed, saving without timecode:', err);
    return blob;
  }
}

/** Frame number → HH:MM:SS:FF, for the diagnostic log line. */
function tcString(frame, fps) {
  const f = Math.round(fps);
  const ff = frame % f;
  const totalSec = Math.floor(frame / f);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600) % 24;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}
