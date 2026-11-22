// Session health readout for the diagnostics card — the "is it getting worse
// over the set?" numbers, so a slowdown can be watched from inside qualia
// instead of guessed at. Everything here is read on a 1 s timer and ONLY while
// the diag card is open; collapsed, it costs one PerformanceObserver callback
// per long task and nothing else.
//
//   heap      JS heap in use (Chrome's performance.memory), with the change
//             since the readout first ran. A steady climb across a set = leak.
//   dom       element count. Should sit flat; a climb = panels/widgets stacking.
//   jank      main-thread time lost to long tasks (>50 ms) over the last 10 s,
//             and how many. This is the "mouse lag / Strudel stutter" number.
//   audio     live AudioContexts · their sample rates · worst output latency.
//             More than one rate (e.g. 44.1k + 48k) means Chrome is resampling
//             some contexts to the interface — set the UMC and macOS to one
//             rate (Audio MIDI Setup) and reload.
//   glitches  render underruns, where Chrome exposes them (AudioContext
//             playbackStats; absent on most builds → row reads "n/a").
import { listContexts } from './audio-unlock.js';

const JANK_WINDOW_MS = 10_000;

export function createPerfHealth({ isOpen, els, extraContexts = () => [] }) {
  const longTasks = [];   // [endMs, durationMs]
  let observer = null;
  try {
    if (typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(e.startTime + e.duration, e.duration);
        // Bounded even if the card is never opened.
        if (longTasks.length > 512) longTasks.splice(0, longTasks.length - 512);
      });
      observer.observe({ type: 'longtask', buffered: false });
    }
  } catch { observer = null; }

  let heap0 = 0, timer = 0;
  const set = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };

  function contexts() {
    const all = new Set(listContexts());
    for (const c of extraContexts()) if (c) all.add(c);
    return Array.from(all).filter((c) => c && c.state !== 'closed');
  }

  function sample() {
    const now = performance.now();
    const mem = performance.memory;
    if (mem && mem.usedJSHeapSize) {
      const mb = mem.usedJSHeapSize / 1048576;
      if (!heap0) heap0 = mb;
      const d = mb - heap0;
      set(els.heap, `${mb.toFixed(0)} MB (${d >= 0 ? '+' : ''}${d.toFixed(0)})`);
    } else set(els.heap, 'n/a');

    set(els.dom, String(document.getElementsByTagName('*').length));

    if (observer) {
      let ms = 0, n = 0;
      const cutoff = now - JANK_WINDOW_MS;
      let drop = 0;
      while (drop < longTasks.length && longTasks[drop] < cutoff) drop += 2;
      if (drop) longTasks.splice(0, drop);
      for (let i = 0; i < longTasks.length; i += 2) { ms += longTasks[i + 1]; n++; }
      set(els.jank, `${Math.round(ms)} ms · ${n} long / 10s`);
    } else set(els.jank, 'n/a');

    const ctxs = contexts();
    const rates = new Map();
    let worst = 0, glitches = 0, haveStats = false, suspended = 0;
    for (const c of ctxs) {
      const r = c.sampleRate;
      rates.set(r, (rates.get(r) || 0) + 1);
      const lat = (Number(c.baseLatency) || 0) + (Number(c.outputLatency) || 0);
      if (lat > worst) worst = lat;
      if (c.state === 'suspended') suspended++;
      const st = c.playbackStats;
      if (st && typeof st.underrunEvents === 'number') { haveStats = true; glitches += st.underrunEvents; }
    }
    const rateTxt = Array.from(rates).map(([r, k]) => `${(r / 1000).toFixed(r % 1000 ? 1 : 0)}k${k > 1 ? `×${k}` : ''}`).join(' ');
    set(els.audio, ctxs.length
      ? `${ctxs.length} ctx · ${rateTxt} · ${(worst * 1000).toFixed(0)} ms${suspended ? ` · ${suspended} susp` : ''}`
      : 'none');
    if (els.audio) els.audio.classList.toggle('warn', rates.size > 1);
    set(els.glitch, haveStats ? String(glitches) : 'n/a');
  }

  function tick() {
    if (isOpen()) sample();
  }
  timer = setInterval(tick, 1000);

  return {
    sample,
    dispose() {
      clearInterval(timer); timer = 0;
      try { observer?.disconnect(); } catch {}
    },
  };
}
