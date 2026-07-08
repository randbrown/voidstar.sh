// On-device Whisper re-transcription — transformers.js loaded from CDN at
// first use (same lazy-CDN pattern as tesseract: nothing in the shell,
// works in any browser, no keys, audio never leaves the device). Model is
// whisper-tiny.en quantized (~40 MB, cached by the browser after the first
// download). This is the fallback/upgrade path for recordings whose live
// Web Speech transcript was missing (Android contention, Firefox) or bad.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/+esm';
const MODEL = 'onnx-community/whisper-tiny.en';

let _pipePromise = null;

export const whisperSupported = () =>
  typeof WebAssembly !== 'undefined' && typeof AudioContext !== 'undefined';

async function getPipe(onProgress) {
  if (!_pipePromise) {
    _pipePromise = (async () => {
      const { pipeline } = await import(/* @vite-ignore */ TRANSFORMERS_URL);
      return pipeline('automatic-speech-recognition', MODEL, {
        dtype: 'q8',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            onProgress?.(`model ${Math.round((p.loaded / p.total) * 100)}%`);
          }
        },
      });
    })();
    // A failed load (offline, CDN blocked) must not poison later attempts.
    _pipePromise.catch(() => { _pipePromise = null; });
  }
  return _pipePromise;
}

// Whisper wants 16 kHz mono Float32 PCM.
async function decodeTo16kMono(blob) {
  const ac = new AudioContext();
  let buf;
  try {
    buf = await ac.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ac.close().catch(() => {});
  }
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// Transcribe an audio Blob. onProgress gets short status strings for the UI.
export async function transcribeBlob(blob, onProgress) {
  onProgress?.('decoding…');
  const pcm = await decodeTo16kMono(blob);
  onProgress?.('loading model…');
  const asr = await getPipe(onProgress);
  onProgress?.('transcribing…');
  const out = await asr(pcm, { chunk_length_s: 30, stride_length_s: 5 });
  return (out?.text || '').trim();
}
