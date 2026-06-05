// Looper waveform renderer — Reaper-style "take in lanes".
//
// The recorded take is drawn as min/max peaks wrapped into horizontal lanes,
// where each lane is `metacycle` Strudel cycles wide. A take that occupies more
// cycles than one metacycle wraps onto successive lanes (top → bottom), so a
// long pedal-steel phrase stays on-screen instead of scrolling off. A playhead
// sweeps each lane left→right and wraps to the next, following loop playback.
//
// The buffer maps linearly onto the loop's playback span: buffer-fraction
// p ∈ [0,1] ↔ playback-cycle p·cycles. Both the waveform and the playhead use
// that one mapping, so stretching the loop (×2 / ÷2 cycles) visually stretches
// the take across more/fewer lanes — matching how it now plays slower/faster.

export function createLooperRenderer({ canvas, getTrack, getPlayhead, getLayout }) {
  const ctx2d = canvas.getContext('2d');
  let peaks = null, peaksBuffer = null;
  let rafId = null, dpr = 1;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    canvas.width  = Math.max(1, Math.round(r.width  * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    paintOnce();
  }

  // Min/max peaks over the whole buffer at a fixed resolution; sampled per-lane
  // at draw time. Recomputed only when the buffer changes.
  function ensurePeaks(buffer) {
    if (peaks && peaksBuffer === buffer) return peaks;
    const data = buffer.getChannelData(0);
    const n = data.length;
    const bins = Math.max(256, Math.min(4096, n));
    const min = new Float32Array(bins), max = new Float32Array(bins);
    const per = n / bins;
    for (let i = 0; i < bins; i++) {
      const s = Math.floor(i * per);
      const e = Math.min(n, Math.floor((i + 1) * per));
      let lo = 1, hi = -1;
      for (let j = s; j < e; j++) { const v = data[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (e <= s) { lo = 0; hi = 0; }
      min[i] = lo; max[i] = hi;
    }
    peaks = { min, max }; peaksBuffer = buffer;
    return peaks;
  }

  function drawEmpty(W, H) {
    ctx2d.fillStyle = 'rgba(148,163,184,0.55)';
    ctx2d.font = `${12 * dpr}px ui-monospace, monospace`;
    ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle';
    ctx2d.fillText('no loop yet — click ● to record', W / 2, H / 2);
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx2d.clearRect(0, 0, W, H);
    const track = getTrack?.();
    if (!track || !track.buffer) { drawEmpty(W, H); return; }

    const layout = getLayout?.() || {};
    const metacycle = layout.metacycle > 0 ? layout.metacycle : 1;
    const cycles = layout.cycles > 0 ? layout.cycles : (track.cycles || metacycle);
    const lanes = Math.max(1, Math.ceil(cycles / metacycle - 1e-6));
    const laneH = H / lanes;
    const P = ensurePeaks(track.buffer);
    const cols = Math.max(1, Math.round(W));

    for (let L = 0; L < lanes; L++) {
      const a = Math.min(1, (L * metacycle) / cycles);
      const b = Math.min(1, ((L + 1) * metacycle) / cycles);
      const y0 = L * laneH;
      const mid = y0 + laneH * 0.5;
      const amp = laneH * 0.45;

      ctx2d.fillStyle = 'rgba(255,255,255,0.035)';
      ctx2d.fillRect(0, y0 + 1, W, laneH - 2);
      // Per-cycle gridlines within the lane (a metacycle holds `metacycle` cycles).
      ctx2d.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx2d.lineWidth = 1;
      for (let c = 0; c <= metacycle; c++) {
        const gx = Math.round((c / metacycle) * W) + 0.5;
        ctx2d.beginPath(); ctx2d.moveTo(gx, y0 + 1); ctx2d.lineTo(gx, y0 + laneH - 1); ctx2d.stroke();
      }
      // Centre line.
      ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx2d.beginPath(); ctx2d.moveTo(0, mid); ctx2d.lineTo(W, mid); ctx2d.stroke();

      if (b <= a) continue;
      // Waveform — alternate accent per lane so wraps read at a glance.
      ctx2d.strokeStyle = (L % 2) ? 'rgba(34,211,238,0.85)' : 'rgba(139,92,246,0.85)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (let x = 0; x < cols; x++) {
        const frac = a + (b - a) * (x / cols);
        const bi = Math.min(P.min.length - 1, Math.floor(frac * P.min.length));
        const lo = P.min[bi], hi = P.max[bi];
        const px = x + 0.5;
        ctx2d.moveTo(px, mid - hi * amp);
        ctx2d.lineTo(px, mid - lo * amp);
      }
      ctx2d.stroke();
    }

    const ph = getPlayhead?.();
    if (ph != null) {
      const playCycle = Math.max(0, Math.min(cycles, ph * cycles));
      const L = Math.min(lanes - 1, Math.floor(playCycle / metacycle));
      const xin = (playCycle - L * metacycle) / metacycle;
      const x = Math.round(xin * W) + 0.5;
      ctx2d.strokeStyle = 'rgba(244,114,182,0.95)';
      ctx2d.lineWidth = 2 * dpr;
      ctx2d.beginPath();
      ctx2d.moveTo(x, L * laneH);
      ctx2d.lineTo(x, (L + 1) * laneH);
      ctx2d.stroke();
      ctx2d.lineWidth = 1;
    }
  }

  function paintOnce() { try { draw(); } catch (e) { console.warn('[qualia] looper draw failed:', e); } }

  function loop() {
    draw();
    rafId = requestAnimationFrame(loop);
  }
  function start() { if (rafId == null) rafId = requestAnimationFrame(loop); }
  function stop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    paintOnce();   // final repaint clears the moving playhead
  }
  // Drop the cached peaks so the next paint rebuilds them for a new take.
  function invalidate() { peaks = null; peaksBuffer = null; paintOnce(); }

  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  resize();

  return { start, stop, invalidate, paintOnce, resize, dispose: () => { stop(); ro?.disconnect(); } };
}
