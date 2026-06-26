// Minimal WAV codec — encode/decode raw PCM channels with no AudioContext.
//
// Used by the qualem .zip bundle: looper loops live in IndexedDB as
// Float32Array PCM, and we round-trip them through standard .wav files so a
// bundle is portable (and the loops are openable in any DAW). We write 32-bit
// IEEE float so a loop survives the round-trip bit-exact; the decoder also reads
// 16-bit PCM so hand-dropped .wav files import fine too.

/**
 * Encode channels of Float32 PCM into a 32-bit-float WAV (interleaved).
 * @param {Float32Array[]} channels  one Float32Array per channel (equal length)
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWav(channels, sampleRate = 48000) {
  const numCh = Math.max(1, channels.length);
  const frames = channels[0]?.length || 0;
  const bytesPerSample = 4;                       // IEEE float32
  const blockAlign = numCh * bytesPerSample;
  const dataLen = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const wStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

  wStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  wStr(8, 'WAVE');
  wStr(12, 'fmt ');
  dv.setUint32(16, 16, true);                     // fmt chunk size
  dv.setUint16(20, 3, true);                      // format = 3 (IEEE float)
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);// byte rate
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bytesPerSample * 8, true);     // bits per sample
  wStr(36, 'data');
  dv.setUint32(40, dataLen, true);

  let off = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numCh; c++) {
      dv.setFloat32(off, channels[c][f] || 0, true);
      off += 4;
    }
  }
  return new Uint8Array(buf);
}

/**
 * Decode a WAV (32-bit float or 16-bit PCM) into raw channels.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{ sampleRate: number, channels: Float32Array[] }|null}
 */
export function decodeWav(input) {
  const ab = input instanceof Uint8Array ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input;
  const dv = new DataView(ab);
  if (dv.byteLength < 44) return null;
  const rStr = (off, len) => { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i)); return s; };
  if (rStr(0, 4) !== 'RIFF' || rStr(8, 4) !== 'WAVE') return null;

  // Walk chunks to find fmt + data (some encoders insert extra chunks).
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = rStr(off, 4);
    const sz = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(body, true),
        numCh:  dv.getUint16(body + 2, true),
        rate:   dv.getUint32(body + 4, true),
        bits:   dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOff = body; dataLen = Math.min(sz, dv.byteLength - body);
    }
    off = body + sz + (sz & 1);                   // chunks are word-aligned
  }
  if (!fmt || dataOff < 0) return null;

  const numCh = Math.max(1, fmt.numCh);
  const bytesPerSample = Math.max(1, fmt.bits >> 3);
  const blockAlign = numCh * bytesPerSample;
  const frames = Math.floor(dataLen / blockAlign);
  const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
  const isFloat = fmt.format === 3;

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numCh; c++) {
      const p = dataOff + f * blockAlign + c * bytesPerSample;
      let v;
      if (isFloat && fmt.bits === 32) v = dv.getFloat32(p, true);
      else if (fmt.bits === 16)       v = dv.getInt16(p, true) / 32768;
      else if (fmt.bits === 32)       v = dv.getInt32(p, true) / 2147483648;
      else if (fmt.bits === 8)        v = (dv.getUint8(p) - 128) / 128;
      else                            v = 0;
      channels[c][f] = v;
    }
  }
  return { sampleRate: fmt.rate || 48000, channels };
}
