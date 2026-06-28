// Mic/camera enumeration + persistence + hot-swap pickers.
//
// Same idea as cymatics:1556–1779,1788–1819. Generalised so the page just
// passes in <select> elements and start/stop callbacks; the module wires up
// the change handler, devicechange listener, and localStorage.

const NS = 'voidstar.qualia';

function lsKey(kind) { return `${NS}.${kind}Id`; }

export function getStoredDeviceId(kind) {
  try { return localStorage.getItem(lsKey(kind)); } catch { return null; }
}
export function storeDeviceId(kind, id) {
  if (!id) return;
  try { localStorage.setItem(lsKey(kind), id); } catch {}
}

/**
 * getUserMedia for a microphone, with a stale-device fallback ladder: try the
 * requested deviceId exactly, then fall back to any default — so an unplugged or
 * renamed stored device can't block startup for a returning user. Only retries
 * on OverconstrainedError / NotFoundError (a real permission denial fails fast).
 * Throws the last error if every attempt fails.
 *
 * Callers pass their own base constraints (audio.js wants stereo; the vocoder
 * wants a low-latency hint), so the ladder is shared but the capture profile
 * stays per-caller.
 *
 * @param {string|undefined|null} deviceId
 * @param {MediaTrackConstraints} base  base audio constraints
 * @returns {Promise<MediaStream>}
 */
export async function openMicStream(deviceId, base) {
  const attempts = deviceId
    ? [{ ...base, deviceId: { exact: deviceId } }, { ...base }]
    : [{ ...base }];
  let stream = null, lastErr = null;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      break;
    } catch (err) {
      lastErr = err;
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') break;
    }
  }
  if (!stream) throw lastErr || new Error('getUserMedia failed');
  return stream;
}

/**
 * Wire a device <select> for one kind ('audioinput' | 'videoinput').
 * `onChoose(deviceId)` should restart the relevant pipeline. The picker
 * starts hidden and only shows when ≥2 devices of that kind exist.
 *
 * Extra options, for callers like the vocoder that need a second,
 * independent picker:
 *   storeKind     — localStorage kind used to persist the choice; defaults
 *                   to 'mic'/'cam' derived from `kind`. Ignored when
 *                   persist is false.
 *   persist       — when false, the picker writes nothing to localStorage;
 *                   the caller owns persistence (e.g. its own config blob).
 *   leadingOption — { value, label } synthetic first entry that is not a
 *                   real device (e.g. the vocoder's "same as main mic").
 *                   Selected when the current id is null or equals its value.
 *   alwaysShow    — keep the <select> visible even with ≤1 real device.
 */
export function wirePicker({ select, kind, onChoose, onError, getCurrentId,
                             storeKind, leadingOption = null,
                             alwaysShow = false, persist = true }) {
  if (!select) return { populate: () => {}, hide: () => {} };
  const persistKind = storeKind || (kind === 'audioinput' ? 'mic' : 'cam');

  async function populate(activeId) {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const matching = all.filter(d => d.kind === kind);
      if (!alwaysShow && matching.length <= 1) { select.style.display = 'none'; return; }
      const current = activeId ?? (getCurrentId ? getCurrentId() : null);
      select.innerHTML = '';
      if (leadingOption) {
        const opt = document.createElement('option');
        opt.value = leadingOption.value;
        opt.textContent = leadingOption.label;
        if (current == null || current === leadingOption.value) opt.selected = true;
        select.appendChild(opt);
      }
      matching.forEach((dev, i) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        const labelHint = kind === 'audioinput' ? 'Mic' : 'Camera';
        opt.textContent = dev.label || `${labelHint} ${i + 1}`;
        if (dev.deviceId === current) opt.selected = true;
        select.appendChild(opt);
      });
      select.style.display = '';
    } catch {
      select.style.display = 'none';
    }
  }

  select.addEventListener('change', async () => {
    const id = select.value;
    try {
      const chosen = await onChoose(id);
      if (persist && chosen) storeDeviceId(persistKind, chosen);
      await populate(chosen ?? id);
    } catch (err) {
      if (onError) onError(err);
      else alert(`Could not switch ${kind === 'audioinput' ? 'microphone' : 'camera'}: ${err.message || err}`);
    }
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      // Repopulate if at least one device-of-kind is currently in use.
      if (getCurrentId && getCurrentId()) populate();
      else if (select.options.length) populate();
    });
  }

  return { populate, hide: () => { select.style.display = 'none'; } };
}
