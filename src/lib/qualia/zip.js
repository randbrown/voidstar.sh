// Dependency-free ZIP — store-only (no compression). Enough to bundle a qualem
// JSON alongside its loop .wav files, cab/amp captures, and video clips into one
// portable .qualem.zip, and to read one back. Loops/IRs/audio are already
// compressed-ish PCM/JSON that gain little from DEFLATE, so "store" keeps the
// code tiny and the writer fast (no inflate/deflate to ship).

const LOCAL_SIG   = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG    = 0x06054b50;
const UTF8_FLAG   = 0x0800;            // bit 11 — filename is UTF-8

// ── CRC32 (table-based) ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const toBytes = (d) => typeof d === 'string' ? new TextEncoder().encode(d)
  : d instanceof Uint8Array ? d
  : new Uint8Array(d);

/**
 * Build a store-only ZIP blob.
 * @param {Array<{name: string, data: Uint8Array|ArrayBuffer|string}>} files
 * @returns {Blob}
 */
export function zipStore(files) {
  const parts = [];                    // body byte-chunks, in order
  const central = [];                  // central-directory records
  let offset = 0;

  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    const data = toBytes(f.data);
    const crc = crc32(data);
    const n = data.length;

    // Local file header
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, LOCAL_SIG, true);
    lh.setUint16(4, 20, true);         // version needed
    lh.setUint16(6, UTF8_FLAG, true);
    lh.setUint16(8, 0, true);          // method: store
    lh.setUint16(10, 0, true);         // mod time
    lh.setUint16(12, 0x21, true);      // mod date = 1980-01-01
    lh.setUint32(14, crc, true);
    lh.setUint32(18, n, true);         // compressed size
    lh.setUint32(22, n, true);         // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);         // extra length
    parts.push(new Uint8Array(lh.buffer), nameBytes, data);

    // Central directory record (filled after we know the local offset)
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, CENTRAL_SIG, true);
    ch.setUint16(4, 20, true);         // version made by
    ch.setUint16(6, 20, true);         // version needed
    ch.setUint16(8, UTF8_FLAG, true);
    ch.setUint16(10, 0, true);         // method
    ch.setUint16(12, 0, true);         // time
    ch.setUint16(14, 0x21, true);      // date
    ch.setUint32(16, crc, true);
    ch.setUint32(20, n, true);
    ch.setUint32(24, n, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true);         // extra
    ch.setUint16(32, 0, true);         // comment
    ch.setUint16(34, 0, true);         // disk #
    ch.setUint16(36, 0, true);         // internal attrs
    ch.setUint32(38, 0, true);         // external attrs
    ch.setUint32(42, offset, true);    // local header offset
    central.push({ head: new Uint8Array(ch.buffer), name: nameBytes });

    offset += 30 + nameBytes.length + n;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { parts.push(c.head, c.name); cdSize += c.head.length + c.name.length; }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, EOCD_SIG, true);
  eocd.setUint16(4, 0, true);          // disk #
  eocd.setUint16(6, 0, true);          // disk w/ CD
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);         // comment length
  parts.push(new Uint8Array(eocd.buffer));

  return new Blob(parts, { type: 'application/zip' });
}

/**
 * Read a store-only ZIP. Entries compressed with anything other than "store"
 * are skipped (we ship no inflate). Returns name → bytes.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Map<string, Uint8Array>}
 */
export function unzip(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = new Map();

  // Locate EOCD by scanning back for its signature (comment is empty here, but
  // scan a window anyway for robustness).
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 0x10000; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);          // central directory offset

  const dec = new TextDecoder();
  for (let e = 0; e < count && p + 46 <= u8.length; e++) {
    if (dv.getUint32(p, true) !== CENTRAL_SIG) break;
    const method  = dv.getUint16(p + 10, true);
    const compSz  = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen  = dv.getUint16(p + 32, true);
    const lho     = dv.getUint32(p + 42, true);
    const name    = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    // Resolve the data start via the local header (its name/extra lengths can
    // differ from the central record).
    if (dv.getUint32(lho, true) === LOCAL_SIG && method === 0) {
      const lNameLen  = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const dataStart = lho + 30 + lNameLen + lExtraLen;
      out.set(name, u8.subarray(dataStart, dataStart + compSz));
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
