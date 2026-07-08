// Voice capture — MediaRecorder (keep the original audio) + Web Speech
// (live transcript) running on the SAME mic stream where the platform
// allows it. If recognition dies while the recorder holds the mic (an
// Android contention mode), capture degrades gracefully to record-only;
// the audio is kept and can be re-transcribed by the Whisper phase later.

import { openMicStream } from '../qualia/devices.js';
import { createDictation, isSupported as speechSupported } from './voice.js';

export const MIC_KEY = 'voidstar.mind.micId';

export function getStoredMicId() {
  try { return localStorage.getItem(MIC_KEY) || ''; } catch { return ''; }
}
export function storeMicId(id) {
  try { localStorage.setItem(MIC_KEY, id || ''); } catch {}
}

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4', // Safari
    'audio/ogg;codecs=opus',
  ];
  for (const t of candidates) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch {}
  }
  return '';
}

export const recordingSupported = () => typeof MediaRecorder !== 'undefined';

// createVoiceCapture: one recording session.
//   opts.record      — keep audio (MediaRecorder)
//   opts.transcribe  — live transcript (Web Speech)
//   opts.onInterim(text), opts.onFinal(text), opts.onError(msg), opts.onState(s)
// start() → begins; stop() → Promise<{ audioBlob, mimeType, durationSec, transcript, speechFailed }>
export function createVoiceCapture(opts = {}) {
  const { record = true, transcribe = true, onInterim, onFinal, onError, onState } = opts;

  let stream = null;
  let recorder = null;
  let chunks = [];
  let dictation = null;
  let startedAt = 0;
  let finals = [];
  let speechFailed = false;

  async function start() {
    startedAt = Date.now();
    finals = [];
    chunks = [];
    speechFailed = false;

    if (record) {
      stream = await openMicStream(getStoredMicId() || null, {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      });
      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.start(1000); // timesliced so a tab kill loses ≤1s
    }

    if (transcribe && speechSupported()) {
      dictation = createDictation({
        onInterim,
        onFinal: (t) => { finals.push(t); onFinal?.(t); },
        onState,
        onError: (err) => {
          // Recognition failing while the recorder runs = contention.
          // Keep recording; flag it so the UI can say "transcript off".
          speechFailed = true;
          onError?.(err);
        },
      });
      dictation.start();
    } else if (transcribe) {
      speechFailed = true;
      onError?.('speech recognition unavailable — recording audio only');
    }
  }

  async function stop() {
    dictation?.stop();

    let audioBlob = null;
    let mimeType = '';
    if (recorder && recorder.state !== 'inactive') {
      await new Promise((res) => {
        recorder.onstop = res;
        try { recorder.stop(); } catch { res(); }
      });
    }
    if (chunks.length) {
      mimeType = recorder?.mimeType || chunks[0].type || 'audio/webm';
      audioBlob = new Blob(chunks, { type: mimeType });
      const durationSec = (Date.now() - startedAt) / 1000;
      // webm blobs from MediaRecorder carry no duration header; patch it so
      // <audio> scrubbing works. fix-webm-duration is already a repo dep.
      if (mimeType.includes('webm')) {
        try {
          const { default: fixWebmDuration } = await import('fix-webm-duration');
          audioBlob = await fixWebmDuration(audioBlob, durationSec * 1000, { logger: false });
        } catch {}
      }
    }
    stream?.getTracks().forEach(t => t.stop());
    stream = null;

    return {
      audioBlob,
      mimeType,
      durationSec: (Date.now() - startedAt) / 1000,
      transcript: finals.join(' ').trim(),
      speechFailed,
    };
  }

  return { start, stop };
}
