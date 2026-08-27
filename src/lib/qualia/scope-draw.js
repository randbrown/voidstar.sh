// scope-draw.js — shared canvas helpers for the little audio oscilloscopes and
// waveform strips scattered across the instrument (the rig IN/OUT scopes in
// looper.js, the deck panel's realtime scope + overall-waveform scrubber).
//
// Pure drawing/DSP-on-a-buffer helpers — no audio-graph, no DOM ownership, no
// per-call allocation beyond what the caller passes in. Kept deliberately small
// so both the rig and the deck read as one instrument.

/**
 * Trace a byte time-domain buffer (an AnalyserNode's `getByteTimeDomainData`)
 * as a horizontal oscilloscope path into 2d context `g`, spanning width `W`
 * around vertical centre `mid`. Leaves the path open (the caller sets
 * strokeStyle/lineWidth and calls `stroke()`), and returns the peak |amplitude|
 * seen (0..~1) so the caller can colour on clip / show a dB readout.
 *
 * `gain` is a VISUAL magnifier only (the rig scopes run short, so they zoom the
 * trace); pass 1 for a true-scale display.
 */
export function traceWave(g, buf, n, W, mid, gain = 1) {
  let peak = 0;
  const k = mid * 0.92 * (gain || 1);
  const H = mid * 2;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const v = (buf[i] - 128) / 128;
    const a = v < 0 ? -v : v; if (a > peak) peak = a;
    const x = (i / (n - 1)) * W;
    let y = mid - v * k;
    if (y < 0) y = 0; else if (y > H) y = H;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  return peak;
}

/** Faint idle sine so a scope still looks alive when its source is silent. */
export function idleTrace(g, W, mid) {
  const t = performance.now() / 1000;
  g.beginPath();
  for (let i = 0; i <= 96; i++) {
    const x = (i / 96) * W;
    const y = mid - Math.sin(i * 0.18 + t * 1.1) * mid * 0.12;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.strokeStyle = 'rgba(148,163,184,0.26)';
  g.stroke();
}

/**
 * Min/max peaks over channel 0 of an AudioBuffer, at fixed resolution `bins`.
 * The overall-waveform display samples these down to pixel columns at draw
 * time, so this is computed ONCE per track (a single O(n) pass over the PCM),
 * cached by the caller, and never re-walked on resize. Returns
 * `{ min, max }` Float32Arrays of length `bins` (or null for an empty buffer).
 */
export function computePeaks(buffer, bins = 2048) {
  if (!buffer || !buffer.length) return null;
  const data = buffer.getChannelData(0);
  const n = data.length;
  const b = Math.max(1, Math.min(bins | 0 || 2048, n));
  const min = new Float32Array(b), max = new Float32Array(b);
  const per = n / b;
  for (let i = 0; i < b; i++) {
    const s = Math.floor(i * per);
    const e = Math.min(n, Math.floor((i + 1) * per));
    let lo = 1, hi = -1;
    for (let j = s; j < e; j++) { const v = data[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (e <= s) { lo = 0; hi = 0; }
    min[i] = lo; max[i] = hi;
  }
  return { min, max };
}
