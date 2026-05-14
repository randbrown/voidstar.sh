// Patch the moov-atom duration fields of an MP4 blob produced by
// Chrome's MediaRecorder. Chrome writes fragmented MP4 with the moov
// atom up front and never goes back to fill in the actual duration —
// the result is a file that Android's stock Photos / Gallery shows as
// "0:00 unknown" and refuses to play, even though the underlying h264
// samples are perfectly fine.
//
// The fix is a few uint32 / uint64 writes: locate moov.mvhd, every
// trak/tkhd, every trak/mdia/mdhd, and (for fMP4) mvex/mehd, then
// stamp the actual duration in each box's own timescale. After the
// patch, Photos shows the correct duration and plays the file.
//
// Returns a NEW Blob — the original buffer is mutated in place so we
// re-wrap it. The mime type is preserved.

const HEADER_LEN_32 = 8;        // size (u32) + type (4 chars)
const FULL_BOX_PRE  = 4;        // version (u8) + flags (3 bytes)

/**
 * @param {Blob} blob       MP4 blob from MediaRecorder
 * @param {number} durationMs Actual recording duration in milliseconds
 * @returns {Promise<Blob>} Patched blob with the same MIME type
 */
export async function fixMp4Duration(blob, durationMs) {
  const buf = await blob.arrayBuffer();
  const u8  = new Uint8Array(buf);
  const dv  = new DataView(buf);
  if (u8.byteLength < 8) return blob;

  // ── Box parsing helpers ───────────────────────────────────────────────
  function readType(p) {
    return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
  }
  function getBoxSize(p) {
    const s = dv.getUint32(p);
    if (s === 1) {
      // 64-bit largesize follows. Practically MediaRecorder doesn't emit
      // largesize for the metadata boxes we care about, but handle it
      // so we don't run off into garbage if the body uses it.
      const hi = dv.getUint32(p + 8);
      const lo = dv.getUint32(p + 12);
      return hi * 0x100000000 + lo;
    }
    return s;
  }
  function findBox(parentStart, parentEnd, name) {
    let p = parentStart;
    while (p + 8 <= parentEnd) {
      const size = getBoxSize(p);
      if (!size || size > parentEnd - p) return null;
      if (readType(p + 4) === name) return { pos: p, size, end: p + size };
      p += size;
    }
    return null;
  }
  function findAllBoxes(parentStart, parentEnd, name) {
    const out = [];
    let p = parentStart;
    while (p + 8 <= parentEnd) {
      const size = getBoxSize(p);
      if (!size || size > parentEnd - p) break;
      if (readType(p + 4) === name) out.push({ pos: p, size, end: p + size });
      p += size;
    }
    return out;
  }
  function writeUint64(pos, value) {
    const hi = Math.floor(value / 0x100000000);
    const lo = value - hi * 0x100000000;
    dv.setUint32(pos, hi);
    dv.setUint32(pos + 4, lo);
  }

  // ── Locate moov ───────────────────────────────────────────────────────
  const moov = findBox(0, u8.byteLength, 'moov');
  if (!moov) return blob;
  const moovInner = moov.pos + HEADER_LEN_32;

  // ── mvhd → write global duration in its own timescale ────────────────
  // mvhd offsets (after 8-byte header + 4-byte version/flags):
  //   v0: creation(4) modification(4) timescale(4) duration(4)
  //   v1: creation(8) modification(8) timescale(4) duration(8)
  const mvhd = findBox(moovInner, moov.end, 'mvhd');
  let globalTimescale = 1000;
  if (mvhd) {
    const fullHdr = mvhd.pos + HEADER_LEN_32 + FULL_BOX_PRE;
    const version = u8[mvhd.pos + HEADER_LEN_32];
    if (version === 1) {
      globalTimescale = dv.getUint32(fullHdr + 16);
      const durTs = Math.round(durationMs * globalTimescale / 1000);
      writeUint64(fullHdr + 20, durTs);
    } else {
      globalTimescale = dv.getUint32(fullHdr + 8);
      const durTs = Math.round(durationMs * globalTimescale / 1000);
      dv.setUint32(fullHdr + 12, Math.min(0xFFFFFFFF, durTs));
    }
  }
  const movieDurTs = Math.round(durationMs * globalTimescale / 1000);

  // ── trak[] → tkhd (movie timescale) + mdia/mdhd (media timescale) ────
  // tkhd offsets:
  //   v0: creation(4) modification(4) trackID(4) reserved(4) duration(4)
  //   v1: creation(8) modification(8) trackID(4) reserved(4) duration(8)
  // mdhd offsets are like mvhd above.
  for (const trak of findAllBoxes(moovInner, moov.end, 'trak')) {
    const tkhd = findBox(trak.pos + HEADER_LEN_32, trak.end, 'tkhd');
    if (tkhd) {
      const fullHdr = tkhd.pos + HEADER_LEN_32 + FULL_BOX_PRE;
      const version = u8[tkhd.pos + HEADER_LEN_32];
      if (version === 1) writeUint64(fullHdr + 24, movieDurTs);
      else dv.setUint32(fullHdr + 16, Math.min(0xFFFFFFFF, movieDurTs));
    }
    const mdia = findBox(trak.pos + HEADER_LEN_32, trak.end, 'mdia');
    if (!mdia) continue;
    const mdhd = findBox(mdia.pos + HEADER_LEN_32, mdia.end, 'mdhd');
    if (!mdhd) continue;
    const fullHdr = mdhd.pos + HEADER_LEN_32 + FULL_BOX_PRE;
    const version = u8[mdhd.pos + HEADER_LEN_32];
    if (version === 1) {
      const mediaTs = dv.getUint32(fullHdr + 16);
      writeUint64(fullHdr + 20, Math.round(durationMs * mediaTs / 1000));
    } else {
      const mediaTs = dv.getUint32(fullHdr + 8);
      dv.setUint32(fullHdr + 12,
        Math.min(0xFFFFFFFF, Math.round(durationMs * mediaTs / 1000)));
    }
  }

  // ── mvex/mehd (fragmented MP4 fragment duration) ─────────────────────
  // mehd offsets:
  //   v0: fragment_duration(4)
  //   v1: fragment_duration(8)
  const mvex = findBox(moovInner, moov.end, 'mvex');
  if (mvex) {
    const mehd = findBox(mvex.pos + HEADER_LEN_32, mvex.end, 'mehd');
    if (mehd) {
      const fullHdr = mehd.pos + HEADER_LEN_32 + FULL_BOX_PRE;
      const version = u8[mehd.pos + HEADER_LEN_32];
      if (version === 1) writeUint64(fullHdr, movieDurTs);
      else dv.setUint32(fullHdr, Math.min(0xFFFFFFFF, movieDurTs));
    }
  }

  return new Blob([buf], { type: blob.type });
}
