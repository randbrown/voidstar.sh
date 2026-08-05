// syzygy — capture-datetime + duration sniffing, straight off the file bytes.
//
// The "universal clock" alignment mode needs each file's wall-clock capture
// time. We parse it ourselves (async range reads over the Blob — no ffmpeg,
// no full-file read) so the alignment UI is instant; the 31MB wasm engine
// only loads when the user actually renders. The same walk yields a duration
// (mvhd / wav data-chunk math) — the UI's fallback when the <video>/<audio>
// element can't report one (codec the browser lacks, missing webm duration).
//
// Sources, best-first:
//   mp4/mov/m4a — moov/mvhd creation_time (spec: UTC seconds since 1904).
//   wav         — BWF `bext`: OriginationDate/Time, plus TimeReference
//                 (sample count since midnight → sub-second precision).
//                 Falls back to LIST/INFO ICRD (date only).
//   mp3         — ID3v2.4 TDRC, or ID3v2.3 TYER+TDAT+TIME.
//
// Timezone reality check: mvhd is UTC by spec (phones mostly comply), while
// bext/ID3 are unzoned — we read them as LOCAL time, the convention field
// recorders follow. Device clocks also simply drift. The UI shows both
// timestamps with their sources and offers a nudge; this module just reports
// what's in the file. Runs in browser and node (node's Blob works fine —
// the check script feeds synthetic files).

/** Seconds between the MP4 epoch (1904-01-01 UTC) and the Unix epoch. */
const MP4_EPOCH_OFFSET = 2082844800;

/** @param {Blob} blob @param {number} off @param {number} len */
async function readBytes(blob, off, len) {
  const end = Math.min(blob.size, off + len);
  if (off >= end) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(off, end).arrayBuffer());
}

function ascii(bytes, start, len) {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function fourcc(bytes, off) {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

/** Reject obviously-bogus timestamps (unset fields, 1904/1970 zeros). */
function saneEpoch(ms) {
  return ms > Date.UTC(1980, 0, 1) && ms < Date.UTC(2200, 0, 1) ? ms : null;
}

// ── mp4 / mov / m4a ─────────────────────────────────────────────────────

/**
 * Walk top-level boxes to moov, then moov's children to mvhd.
 * @param {Blob} blob
 * @returns {Promise<?{clock:?{epochMs:number, source:string}, durationS:?number}>}
 */
export async function sniffMp4(blob) {
  let pos = 0;
  for (let guard = 0; guard < 64 && pos + 8 <= blob.size; guard++) {
    const head = await readBytes(blob, pos, 16);
    if (head.length < 8) return null;
    const dv = new DataView(head.buffer);
    let size = dv.getUint32(0);
    const type = fourcc(head, 4);
    let headerLen = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = dv.getUint32(8) * 0x100000000 + dv.getUint32(12);
      headerLen = 16;
    } else if (size === 0) {
      size = blob.size - pos; // box runs to EOF
    }
    if (size < headerLen) return null;
    if (type === 'moov') {
      const body = await readBytes(blob, pos + headerLen, Math.min(size - headerLen, 1 << 20));
      return parseMoov(body);
    }
    pos += size;
  }
  return null;
}

function parseMoov(body) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let p = 0;
  while (p + 8 <= body.length) {
    let size = dv.getUint32(p);
    const type = fourcc(body, p + 4);
    let headerLen = 8;
    if (size === 1) {
      if (p + 16 > body.length) return null;
      size = dv.getUint32(p + 8) * 0x100000000 + dv.getUint32(p + 12);
      headerLen = 16;
    } else if (size === 0) {
      size = body.length - p;
    }
    if (size < headerLen) return null;
    if (type === 'mvhd' && p + headerLen + 20 <= body.length) {
      const version = body[p + headerLen];
      const base = p + headerLen + 4; // skip version+flags
      let creation, timescale, duration;
      if (version === 1) {
        creation = dv.getUint32(base) * 0x100000000 + dv.getUint32(base + 4);
        timescale = dv.getUint32(base + 16);
        duration = dv.getUint32(base + 20) * 0x100000000 + dv.getUint32(base + 24);
      } else {
        creation = dv.getUint32(base);
        timescale = dv.getUint32(base + 8);
        duration = dv.getUint32(base + 12);
      }
      const epochMs = saneEpoch((creation - MP4_EPOCH_OFFSET) * 1000);
      const durationS = timescale > 0 && duration > 0 && duration !== 0xffffffff
        ? duration / timescale : null;
      return {
        clock: epochMs ? { epochMs, source: 'mp4 creation_time (UTC)' } : null,
        durationS,
      };
    }
    p += size;
  }
  return null;
}

// ── wav (RIFF / BWF) ────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})[-:._](\d{2})[-:._](\d{2})/;
const TIME_RE = /^(\d{2})[-:._](\d{2})[-:._](\d{2})/;

/**
 * @param {Blob} blob
 * @returns {Promise<?{clock:?{epochMs:number, source:string}, durationS:?number}>}
 */
export async function sniffWav(blob) {
  const head = await readBytes(blob, 0, 12);
  if (head.length < 12 || fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'WAVE') return null;

  let pos = 12;
  let sampleRate = 0;
  let byteRate = 0;
  let dataSize = 0;
  let bext = null;
  let icrd = null;
  for (let guard = 0; guard < 256 && pos + 8 <= blob.size; guard++) {
    const ch = await readBytes(blob, pos, 8);
    if (ch.length < 8) break;
    const id = fourcc(ch, 0);
    const size = new DataView(ch.buffer).getUint32(4, true);
    const dataOff = pos + 8;
    if (id === 'fmt ') {
      const fmt = await readBytes(blob, dataOff, 16);
      if (fmt.length >= 12) {
        const fdv = new DataView(fmt.buffer);
        sampleRate = fdv.getUint32(4, true);
        byteRate = fdv.getUint32(8, true);
      }
    } else if (id === 'data') {
      dataSize = size || Math.max(0, blob.size - dataOff);
    } else if (id === 'bext') {
      const b = await readBytes(blob, dataOff, Math.min(size, 610));
      if (b.length >= 346) {
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        bext = {
          date: ascii(b, 320, 10),
          time: ascii(b, 330, 8),
          timeRef: dv.getUint32(338, true) + dv.getUint32(342, true) * 0x100000000,
        };
      }
    } else if (id === 'LIST') {
      const l = await readBytes(blob, dataOff, Math.min(size, 4096));
      if (l.length >= 4 && fourcc(l, 0) === 'INFO') {
        let q = 4;
        const ldv = new DataView(l.buffer, l.byteOffset, l.byteLength);
        while (q + 8 <= l.length) {
          const sid = fourcc(l, q);
          const ssz = ldv.getUint32(q + 4, true);
          if (sid === 'ICRD') { icrd = ascii(l, q + 8, Math.min(ssz, 32)); break; }
          q += 8 + ssz + (ssz & 1);
        }
      }
    }
    pos = dataOff + size + (size & 1);
  }

  const durationS = byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
  let clock = null;
  if (bext) {
    const dm = DATE_RE.exec(bext.date);
    if (dm) {
      const midnight = new Date(+dm[1], +dm[2] - 1, +dm[3]); // local, per BWF convention
      if (bext.timeRef > 0 && sampleRate > 0) {
        const epochMs = saneEpoch(midnight.getTime() + (bext.timeRef / sampleRate) * 1000);
        if (epochMs) clock = { epochMs, source: 'wav bext TimeReference (sample-accurate, local)' };
      }
      if (!clock) {
        const tm = TIME_RE.exec(bext.time);
        if (tm) {
          const epochMs = saneEpoch(new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], +tm[3]).getTime());
          if (epochMs) clock = { epochMs, source: 'wav bext origination date/time (local)' };
        }
      }
      if (!clock) {
        const epochMs = saneEpoch(midnight.getTime());
        if (epochMs) clock = { epochMs, source: 'wav bext origination date (midnight — imprecise)' };
      }
    }
  }
  if (!clock && icrd) {
    const t = Date.parse(icrd);
    const epochMs = saneEpoch(Number.isNaN(t) ? 0 : t);
    if (epochMs) clock = { epochMs, source: 'wav INFO ICRD (imprecise)' };
  }
  return { clock, durationS };
}

// ── mp3 (ID3v2) ─────────────────────────────────────────────────────────

function syncsafe(b, off) {
  return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f);
}

function decodeText(bytes) {
  if (!bytes.length) return '';
  const enc = bytes[0];
  const body = bytes.subarray(1);
  try {
    if (enc === 1) return new TextDecoder('utf-16').decode(body).replace(/\0+$/, '');
    if (enc === 2) return new TextDecoder('utf-16be').decode(body).replace(/\0+$/, '');
    if (enc === 3) return new TextDecoder('utf-8').decode(body).replace(/\0+$/, '');
    return new TextDecoder('latin1').decode(body).replace(/\0+$/, '');
  } catch {
    return ascii(bytes, 1, bytes.length - 1);
  }
}

/**
 * @param {Blob} blob
 * @returns {Promise<?{clock:?{epochMs:number, source:string}, durationS:?number}>}
 */
export async function sniffMp3(blob) {
  const head = await readBytes(blob, 0, 10);
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return null;
  const major = head[3];
  const tagSize = syncsafe(head, 6);
  const tag = await readBytes(blob, 10, Math.min(tagSize, 1 << 20));

  const frames = {};
  let p = 0;
  while (p + 10 <= tag.length) {
    const id = fourcc(tag, p);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding reached
    const size = major >= 4
      ? syncsafe(tag, p + 4)
      : new DataView(tag.buffer, tag.byteOffset).getUint32(p + 4);
    if (size <= 0 || p + 10 + size > tag.length) break;
    if (['TDRC', 'TYER', 'TDAT', 'TIME'].includes(id)) {
      frames[id] = decodeText(tag.subarray(p + 10, p + 10 + size));
    }
    p += 10 + size;
  }

  let clock = null;
  if (frames.TDRC) {
    // "yyyy-MM-ddTHH:mm:ss", possibly truncated at any level.
    const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?)?)?/.exec(frames.TDRC);
    if (m && m[3]) {
      const epochMs = saneEpoch(new Date(+m[1], +(m[2] || 1) - 1, +(m[3] || 1), +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime());
      if (epochMs) clock = { epochMs, source: m[4] ? 'mp3 ID3 TDRC (local)' : 'mp3 ID3 TDRC (date only — imprecise)' };
    }
  }
  if (!clock && frames.TYER && /^\d{4}$/.test(frames.TYER) && frames.TDAT && /^\d{4}$/.test(frames.TDAT)) {
    const dd = +frames.TDAT.slice(0, 2);
    const mm = +frames.TDAT.slice(2, 4);
    const hh = frames.TIME && /^\d{4}$/.test(frames.TIME) ? +frames.TIME.slice(0, 2) : 0;
    const mi = frames.TIME && /^\d{4}$/.test(frames.TIME) ? +frames.TIME.slice(2, 4) : 0;
    const epochMs = saneEpoch(new Date(+frames.TYER, mm - 1, dd, hh, mi).getTime());
    if (epochMs) clock = { epochMs, source: frames.TIME ? 'mp3 ID3 TYER/TDAT/TIME (local)' : 'mp3 ID3 TYER/TDAT (date only — imprecise)' };
  }
  return clock ? { clock, durationS: null } : null;
}

// ── dispatcher ──────────────────────────────────────────────────────────

/**
 * Sniff a media file's capture datetime + duration by magic bytes
 * (extension-agnostic).
 * @param {Blob} blob
 * @returns {Promise<?{clock:?{epochMs:number, source:string}, durationS:?number}>}
 */
export async function sniffMediaInfo(blob) {
  const head = await readBytes(blob, 0, 12);
  if (head.length >= 12) {
    if (fourcc(head, 4) === 'ftyp' || fourcc(head, 4) === 'moov' || fourcc(head, 4) === 'mdat') {
      return sniffMp4(blob);
    }
    if (fourcc(head, 0) === 'RIFF' && fourcc(head, 8) === 'WAVE') return sniffWav(blob);
    if (ascii(head, 0, 3) === 'ID3') return sniffMp3(blob);
  }
  return null;
}
