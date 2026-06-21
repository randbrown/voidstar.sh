// Looper waveform renderer — Reaper-style "take in lanes".
//
// The loop region is drawn as min/max peaks wrapped into horizontal lanes,
// where each lane is `grid` Strudel cycles wide (the per-track "cycles" control).
// A take whose `length` spans more cycles than one grid wraps onto successive
// lanes (top → bottom), so a long pedal-steel phrase stays on-screen instead of
// scrolling off. A playhead sweeps each lane left→right and wraps to the next,
// following loop playback.
//
// Two draw paths:
//   • static   — a recorded loop region [startFrame,endFrame] of an AudioBuffer
//                (the region slides live with the nudge offset).
//   • live     — while recording: min/max peak bins accumulated so far, wrapped
//                into lanes with a record-head at the current input position.
//
// Both map a musical position (cycles) → lane + x via the same grid width, so
// stretching the loop visually stretches the take across more/fewer lanes.

export function createLooperRenderer({ canvas, getView, getRecordView }) {
  const ctx2d = canvas.getContext('2d');
  let peaks = null, peaksKey = '';
  let rafId = null, dpr = 1;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    canvas.width  = Math.max(1, Math.round(r.width  * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    paintOnce();
  }

  // Min/max peaks over a buffer region [startFrame,endFrame), at fixed
  // resolution; sampled per-lane at draw time. Cached by region identity.
  function ensurePeaks(buffer, startFrame, endFrame) {
    const key = `${startFrame}:${endFrame}:${buffer.length}`;
    if (peaks && peaksKey === key && peaks.buffer === buffer) return peaks;
    const data = buffer.getChannelData(0);
    const n = Math.max(1, endFrame - startFrame);
    const bins = Math.max(256, Math.min(4096, n));
    const min = new Float32Array(bins), max = new Float32Array(bins);
    const per = n / bins;
    for (let i = 0; i < bins; i++) {
      const s = startFrame + Math.floor(i * per);
      const e = Math.min(endFrame, startFrame + Math.floor((i + 1) * per));
      let lo = 1, hi = -1;
      for (let j = s; j < e; j++) { const v = data[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (e <= s) { lo = 0; hi = 0; }
      min[i] = lo; max[i] = hi;
    }
    peaks = { min, max, buffer }; peaksKey = key;
    return peaks;
  }

  function laneBg(L, laneH, W) {
    const y0 = L * laneH;
    ctx2d.fillStyle = 'rgba(255,255,255,0.035)';
    ctx2d.fillRect(0, y0 + 1, W, laneH - 2);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx2d.beginPath(); ctx2d.moveTo(0, y0 + laneH * 0.5); ctx2d.lineTo(W, y0 + laneH * 0.5); ctx2d.stroke();
  }

  function drawHead(cyclePos, grid, lanes, laneH, W, colour) {
    const L = Math.min(lanes - 1, Math.floor(cyclePos / grid));
    const x = Math.round(((cyclePos - L * grid) / grid) * W) + 0.5;
    ctx2d.strokeStyle = colour;
    ctx2d.lineWidth = 2 * dpr;
    ctx2d.beginPath(); ctx2d.moveTo(x, L * laneH); ctx2d.lineTo(x, (L + 1) * laneH); ctx2d.stroke();
    ctx2d.lineWidth = 1;
  }

  function drawEmpty(W, H) {
    ctx2d.fillStyle = 'rgba(148,163,184,0.55)';
    ctx2d.font = `${12 * dpr}px ui-monospace, monospace`;
    ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle';
    ctx2d.fillText('no loop yet — click ● to record', W / 2, H / 2);
  }

  function drawStatic(view, W, H) {
    const grid = view.grid > 0 ? view.grid : 1;
    const length = view.length > 0 ? view.length : grid;
    const lanes = Math.max(1, Math.ceil(length / grid - 1e-6));
    const laneH = H / lanes;
    const P = ensurePeaks(view.buffer, view.startFrame, view.endFrame);
    const cols = Math.max(1, Math.round(W));

    for (let L = 0; L < lanes; L++) {
      const a = Math.min(1, (L * grid) / length);
      const b = Math.min(1, ((L + 1) * grid) / length);
      const y0 = L * laneH, mid = y0 + laneH * 0.5, amp = laneH * 0.45;
      laneBg(L, laneH, W);
      if (b <= a) continue;
      ctx2d.strokeStyle = (L % 2) ? 'rgba(34,211,238,0.85)' : 'rgba(139,92,246,0.85)';
      ctx2d.beginPath();
      for (let x = 0; x < cols; x++) {
        const frac = a + (b - a) * (x / cols);
        const bi = Math.min(P.min.length - 1, Math.floor(frac * P.min.length));
        const px = x + 0.5;
        ctx2d.moveTo(px, mid - P.max[bi] * amp);
        ctx2d.lineTo(px, mid - P.min[bi] * amp);
      }
      ctx2d.stroke();
    }
    if (view.playhead01 != null) {
      drawHead(Math.max(0, Math.min(length, view.playhead01 * length)), grid, lanes, laneH, W, 'rgba(244,114,182,0.95)');
    }
  }

  function drawLive(rv, W, H) {
    const grid = rv.grid > 0 ? rv.grid : 1;
    const sr = rv.sampleRate || 48000;
    const cyclesPerBin = (rv.binSamples / sr) * (rv.cps > 0 ? rv.cps : 0.5);
    const head = Math.max(0, rv.headCycle || 0);
    const lanes = Math.max(1, Math.ceil((head + 1e-3) / grid));
    const laneH = H / lanes;
    for (let L = 0; L < lanes; L++) laneBg(L, laneH, W);

    // Draw each peak bin at/after the musical IN at its lane+x.
    for (let i = rv.inBin; i < rv.bins; i++) {
      const cycle = (i - rv.inBin) * cyclesPerBin;
      if (cycle < 0 || cycle > lanes * grid) continue;
      const L = Math.min(lanes - 1, Math.floor(cycle / grid));
      const x = Math.round(((cycle - L * grid) / grid) * W) + 0.5;
      const y0 = L * laneH, mid = y0 + laneH * 0.5, amp = laneH * 0.45;
      ctx2d.strokeStyle = (L % 2) ? 'rgba(34,211,238,0.7)' : 'rgba(139,92,246,0.7)';
      ctx2d.beginPath();
      ctx2d.moveTo(x, mid - rv.max[i] * amp);
      ctx2d.lineTo(x, mid - rv.min[i] * amp);
      ctx2d.stroke();
    }
    // Bright red record-head at the current input position.
    drawHead(head, grid, lanes, laneH, W, 'rgba(248,113,113,0.98)');
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx2d.clearRect(0, 0, W, H);
    const rv = getRecordView?.();
    if (rv && rv.recording) { drawLive(rv, W, H); return; }
    const view = getView?.();
    if (view && view.buffer) { drawStatic(view, W, H); return; }
    drawEmpty(W, H);
  }

  function paintOnce() { try { draw(); } catch (e) { console.warn('[qualia] looper draw failed:', e); } }

  function loop() { draw(); rafId = requestAnimationFrame(loop); }
  function start() { if (rafId == null) rafId = requestAnimationFrame(loop); }
  function stop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    paintOnce();   // final repaint clears the moving playhead
  }
  function invalidate() { peaks = null; peaksKey = ''; paintOnce(); }

  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  resize();

  return { start, stop, invalidate, paintOnce, resize, dispose: () => { stop(); ro?.disconnect(); } };
}
