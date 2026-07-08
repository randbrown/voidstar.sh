// Continuous Web Speech dictation — forked from setlist/voice.js and tuned
// for note-taking: continuous + interim results, with a restart loop
// (Android Chrome kills recognition sessions after ~60s of speech and on
// every silence gap) and final-result dedupe across restarts.

const SpeechRecognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const isSupported = () => !!SpeechRecognition;

export function createDictation({ onFinal, onInterim, onError, onState } = {}) {
  if (!SpeechRecognition) {
    return {
      start() { onError?.('speech recognition not supported in this browser'); },
      stop() {},
      get isListening() { return false; },
    };
  }

  let rec = null;
  let wanted = false;   // user intent — the restart loop runs while true
  let listening = false;
  let lastFinal = '';
  let lastFinalAt = 0;

  function build() {
    rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript;
        if (r.isFinal) {
          const t = text.trim();
          // Android restarts occasionally re-emit the last final — drop
          // exact repeats that arrive within a couple of seconds.
          if (t && !(t === lastFinal && Date.now() - lastFinalAt < 2500)) {
            lastFinal = t;
            lastFinalAt = Date.now();
            onFinal?.(t);
          }
        } else {
          interim += text;
        }
      }
      onInterim?.(interim.trim());
    };

    rec.onend = () => {
      listening = false;
      onInterim?.('');
      if (wanted) {
        // Session died but the user didn't stop — restart (small delay:
        // an immediate start() right inside onend throws on Chrome).
        setTimeout(() => {
          if (!wanted) return;
          try { rec.start(); listening = true; onState?.('listening'); }
          catch { /* next onend retries */ }
        }, 250);
      } else {
        onState?.('idle');
      }
    };

    rec.onerror = (e) => {
      listening = false;
      if (e.error === 'aborted' || e.error === 'no-speech') return; // restart loop handles it
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed'
          || e.error === 'audio-capture') {
        // Fatal: mic denied or another consumer (e.g. MediaRecorder on some
        // Android builds) owns the input. Stop wanting — the caller falls
        // back to record-only.
        wanted = false;
        onState?.('idle');
      }
      onError?.(e.error);
    };
  }

  return {
    start() {
      if (listening) return;
      wanted = true;
      lastFinal = '';
      if (!rec) build();
      try { rec.start(); listening = true; onState?.('listening'); }
      catch { onError?.('could not start speech recognition'); }
    },
    stop() {
      wanted = false;
      if (!rec) return;
      try { rec.stop(); } catch {}
      listening = false;
    },
    get isListening() { return listening; },
  };
}
