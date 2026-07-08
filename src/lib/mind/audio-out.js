// Speaker (audio output) selection — so voice notes play through the right
// device even with a Bluetooth music rig connected. Chrome/Edge only:
// setSinkId is unsupported on Safari/iOS, where the picker hides itself.

const SPEAKER_KEY = 'voidstar.mind.speakerId';

export const sinkSelectable = () =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export function getStoredSpeakerId() {
  try { return localStorage.getItem(SPEAKER_KEY) || ''; } catch { return ''; }
}
export function storeSpeakerId(id) {
  try { localStorage.setItem(SPEAKER_KEY, id || ''); } catch {}
}

// Apply the chosen output device to a media element (no-op when unset or
// unsupported). Call on every <audio> the app creates.
export async function applySink(mediaEl) {
  const id = getStoredSpeakerId();
  if (!id || !sinkSelectable()) return;
  try { await mediaEl.setSinkId(id); } catch {}
}

// Populate a <select> with audio outputs. Labels need mic permission to be
// visible (browser rule); the picker shows generic names until then.
export async function wireSpeakerPicker(select) {
  if (!select) return;
  if (!sinkSelectable() || !navigator.mediaDevices?.enumerateDevices) {
    select.style.display = 'none';
    return;
  }
  async function populate() {
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices())
        .filter(d => d.kind === 'audiooutput');
      if (outs.length <= 1) { select.style.display = 'none'; return; }
      const current = getStoredSpeakerId();
      select.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'default speaker';
      select.appendChild(def);
      outs.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `speaker ${i + 1}`;
        if (d.deviceId === current) o.selected = true;
        select.appendChild(o);
      });
      select.style.display = '';
    } catch { select.style.display = 'none'; }
  }
  select.addEventListener('change', () => storeSpeakerId(select.value));
  navigator.mediaDevices.addEventListener?.('devicechange', populate);
  await populate();
}
