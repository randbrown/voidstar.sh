// Web Speech API dictation wrapper.
// Works on Chrome (desktop + Android) and Safari (iOS 14.5+).

const SpeechRecognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const isSupported = () => !!SpeechRecognition;

export function createDictation(onResult, onError) {
  if (!SpeechRecognition) {
    return {
      start() { onError('Speech recognition not supported in this browser'); },
      stop() {},
      get isListening() { return false; },
    };
  }

  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = false;
  rec.lang = 'en-US';
  let listening = false;

  rec.onresult = (e) => {
    const text = e.results[e.results.length - 1][0].transcript;
    listening = false;
    onResult(text.trim());
  };

  rec.onend = () => { listening = false; };

  rec.onerror = (e) => {
    listening = false;
    if (e.error !== 'aborted') onError(e.error);
  };

  return {
    start() {
      if (listening) return;
      try { rec.start(); listening = true; }
      catch { onError('Could not start speech recognition'); }
    },
    stop() {
      if (!listening) return;
      rec.stop();
      listening = false;
    },
    get isListening() { return listening; },
  };
}
