// mp3-encode.js — WAV → MP3 via ffmpeg.wasm, for the optional MP3 rig stem.
//
// WAV export needs none of this (it's a pure-JS PCM write), so MP3 is the only
// stem path that reaches for the network: the heavy ffmpeg core (~31 MB) is
// lazy-loaded from CDN on first use, per the repo rule for heavy third-party
// libs (same core the syzygy lab uses, but a separate self-contained loader so
// qualia stays decoupled from that app). Single-thread core is deliberate — the
// multithreaded build needs SharedArrayBuffer / COOP-COEP headers we don't
// serve. Callers must handle load failure (offline) by falling back to WAV.

const CORE_VERSION = '0.12.10';
const CORE_BASES = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];

let ffmpeg = null;
let loadPromise = null;

async function loadEngine(onStatus) {
  if (ffmpeg) return ffmpeg;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    onStatus?.('loading mp3 encoder…');
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import('@ffmpeg/ffmpeg'),
      import('@ffmpeg/util'),
    ]);
    let lastErr = null;
    // Two rounds over the CDN list — a big fetch dying mid-stream on a flaky
    // link deserves a second shot before giving up.
    for (const base of [...CORE_BASES, ...CORE_BASES]) {
      try {
        onStatus?.('fetching mp3 encoder (~31 MB, one-time)…');
        const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript');
        const wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm', true);
        const ff = new FFmpeg();
        await ff.load({ coreURL, wasmURL });
        ffmpeg = ff;
        return ff;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`could not load the mp3 encoder — ${lastErr?.message || lastErr}`);
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

/**
 * Encode a WAV byte buffer to MP3.
 * @param {Uint8Array} wavBytes         a complete .wav file
 * @param {{ bitrate?: string, onStatus?: (msg: string) => void }} [opts]
 * @returns {Promise<Uint8Array>}       the .mp3 file bytes
 */
export async function wavToMp3(wavBytes, opts = {}) {
  const bitrate = opts.bitrate || '320k';
  const ff = await loadEngine(opts.onStatus);
  opts.onStatus?.('encoding mp3…');
  const IN = 'stem-in.wav';
  const OUT = 'stem-out.mp3';
  await ff.writeFile(IN, wavBytes);
  await ff.exec(['-i', IN, '-c:a', 'libmp3lame', '-b:a', bitrate, OUT]);
  const data = await ff.readFile(OUT);   // Uint8Array
  try { await ff.deleteFile(IN); await ff.deleteFile(OUT); } catch { /* MEMFS cleanup best-effort */ }
  if (!data || !data.length) throw new Error('mp3 encode produced no output');
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Whether MP3 encoding has already been loaded this session (no network needed). */
export function isMp3EngineReady() { return !!ffmpeg; }
