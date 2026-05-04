// Spectrum — port of the spectrum-pose lab visualisers as a single quale
// with a `mode` select (mirrors chladni's pattern). Five modes:
//   - bars         Log-spaced frequency bars rising from the bottom + faint mirror.
//   - radial       Same bins arranged as spokes around a breathing centre ring.
//   - waterfall    Scrolling spectrogram (tall buffer, blitted each frame).
//   - oscilloscope Three offset waveform traces (waveform-driven).
//   - nebula       Soft blobs at bass / mids / highs centres + roving peak speck.
//
// All modes read field.audio.spectrum / field.audio.waveform — each is a
// Uint8Array sized to the merged analyser's bin count. Sample rate is
// assumed 48 kHz (the realistic floor for both mic and Strudel ctxs);
// log-bin indexing tolerates drift to 44.1k without visible distortion.
//
// Audio map (across all modes):
//   bands.{bass,mids,highs} → colour energy + breathing
//   beat.pulse              → background flash overlay (page-init paints
//                             this; we just need to stay legible under it)
//   highs                   → hue micro-shift on bars / radial / oscilloscope

import { scaleAudio } from '../field.js';

const BAR_COUNT = 96;
const ASSUMED_SAMPLE_RATE = 48000;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'spectrum',
  name: 'Spectrum',
  contextType: 'canvas2d',

  params: [
    { id: 'mode', label: 'mode', type: 'select',
      options: ['bars', 'radial', 'waterfall', 'oscilloscope', 'nebula'], default: 'bars' },
    { id: 'fade',       label: 'background fade', type: 'range', min: 0.02, max: 0.50, step: 0.01, default: 0.18 },
    { id: 'reactivity', label: 'reactivity',      type: 'range', min: 0,    max: 2,    step: 0.05, default: 1.0 },
  ],

  // Auto cycles the modes — the topbar auto button surfaces all five
  // looks (mirrors chladni's pattern).
  autoCycle: {
    steps: [
      { mode: 'bars' },
      { mode: 'radial' },
      { mode: 'waterfall' },
      { mode: 'oscilloscope' },
      { mode: 'nebula' },
    ],
  },

  presets: {
    default:     { mode: 'bars',         fade: 0.18, reactivity: 1.0 },
    bars:        { mode: 'bars' },
    radial:      { mode: 'radial' },
    waterfall:   { mode: 'waterfall',    fade: 0.30 },
    oscilloscope:{ mode: 'oscilloscope' },
    nebula:      { mode: 'nebula',       fade: 0.10 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // Log-bin index map, recomputed when spectrum length (bin count) changes.
    let logBinIdx     = null;
    let logBinFor     = -1;       // freqBuf length we last built bins for
    function buildLogBins(freqLen) {
      if (freqLen === logBinFor && logBinIdx) return;
      const fftSize = freqLen * 2;
      const hz   = ASSUMED_SAMPLE_RATE / fftSize;
      const minF = 30, maxF = 14000;
      const last = freqLen - 1;
      logBinIdx = new Int32Array(BAR_COUNT + 1);
      for (let i = 0; i <= BAR_COUNT; i++) {
        const f = minF * Math.pow(maxF / minF, i / BAR_COUNT);
        logBinIdx[i] = Math.max(1, Math.min(last, Math.round(f / hz)));
      }
      logBinFor = freqLen;
    }
    function sampleBar(freqBuf, i) {
      if (!logBinIdx) return 0;
      const lo = logBinIdx[i], hi = Math.max(lo + 1, logBinIdx[i + 1]);
      let m = 0;
      for (let k = lo; k < hi; k++) if (freqBuf[k] > m) m = freqBuf[k];
      return m / 255;
    }

    // Waterfall offscreen buffer — sized to the canvas backing buffer so
    // the blit is 1:1. Re-allocated on resize.
    let waterCanvas = null, waterCtx = null;
    function ensureWaterfall() {
      if (!waterCanvas) {
        waterCanvas = document.createElement('canvas');
        waterCtx    = waterCanvas.getContext('2d');
      }
      if (waterCanvas.width !== W || waterCanvas.height !== H) {
        waterCanvas.width  = W;
        waterCanvas.height = H;
      }
    }

    // ── Renderers ─────────────────────────────────────────────────────────
    function drawBars(audio) {
      const spectrum = audio.spectrum;
      if (!spectrum) return;
      buildLogBins(spectrum.length);
      const slot = W / BAR_COUNT;
      const bw   = Math.max(1, slot * 0.72);
      const baseY = H;
      const hueShift = audio.bands.highs * 20;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < BAR_COUNT; i++) {
        const v = sampleBar(spectrum, i);
        if (v < 0.015) continue;
        const x = i * slot + (slot - bw) / 2;
        const h = Math.min(1, v) * H * 0.55;
        const frac = i / BAR_COUNT;
        const hue  = 260 + frac * 160 + hueShift;
        const grad = ctx.createLinearGradient(0, baseY, 0, baseY - h);
        grad.addColorStop(0, `hsla(${hue},80%,55%,0.05)`);
        grad.addColorStop(1, `hsla(${hue},85%,65%,0.65)`);
        ctx.fillStyle = grad;
        ctx.fillRect(x, baseY - h, bw, h);
      }
      // Faint top mirror.
      ctx.globalAlpha = 0.25;
      for (let i = 0; i < BAR_COUNT; i++) {
        const v = sampleBar(spectrum, i);
        if (v < 0.015) continue;
        const x = i * slot + (slot - bw) / 2;
        const h = Math.min(1, v) * H * 0.35;
        const frac = i / BAR_COUNT;
        const hue  = 260 + frac * 160 + hueShift;
        ctx.fillStyle = `hsla(${hue},80%,65%,0.45)`;
        ctx.fillRect(x, 0, bw, h);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawRadial(audio) {
      const spectrum = audio.spectrum;
      if (!spectrum) return;
      buildLogBins(spectrum.length);
      const cx = W / 2, cy = H / 2;
      const r0 = Math.min(W, H) * 0.18;
      const rMax = Math.min(W, H) * 0.42;
      const hueShift = audio.bands.highs * 20;
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      const lineW = Math.max(1.2, (Math.PI * 2 * r0 / BAR_COUNT) * 0.55);
      for (let i = 0; i < BAR_COUNT; i++) {
        const v = sampleBar(spectrum, i);
        if (v < 0.015) continue;
        const ang = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
        const len = Math.min(1, v) * (rMax - r0);
        const x1 = cx + Math.cos(ang) * r0;
        const y1 = cy + Math.sin(ang) * r0;
        const x2 = cx + Math.cos(ang) * (r0 + len);
        const y2 = cy + Math.sin(ang) * (r0 + len);
        const hue = 260 + (i / BAR_COUNT) * 160 + hueShift;
        ctx.strokeStyle = `hsla(${hue},85%,62%,0.7)`;
        ctx.lineWidth = lineW;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      // Inner breathing ring driven by total + beat.
      const breath = 1 + audio.bands.total * 0.6 + audio.beat.pulse * 0.2;
      ctx.strokeStyle = `rgba(139,92,246,${0.08 + audio.bands.bass * 0.25})`;
      ctx.lineWidth = 2 + audio.bands.bass * 6;
      ctx.beginPath(); ctx.arc(cx, cy, r0 * breath, 0, Math.PI * 2); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawWaterfall(audio) {
      const spectrum = audio.spectrum;
      if (!spectrum) return;
      buildLogBins(spectrum.length);
      ensureWaterfall();
      // Shift existing buffer down by 1 px, clear top row, paint new spectrum.
      waterCtx.globalCompositeOperation = 'copy';
      waterCtx.drawImage(waterCanvas, 0, 1);
      waterCtx.globalCompositeOperation = 'source-over';
      waterCtx.clearRect(0, 0, W, 1);
      for (let i = 0; i < BAR_COUNT; i++) {
        const v = sampleBar(spectrum, i);
        if (v < 0.03) continue;
        const x0 = Math.floor((i / BAR_COUNT) * W);
        const x1 = Math.floor(((i + 1) / BAR_COUNT) * W);
        const hue = 260 + (i / BAR_COUNT) * 160;
        const l   = 18 + Math.min(1, v) * 22;   // 18–40%
        const a   = Math.min(0.55, v * 0.8);
        waterCtx.fillStyle = `hsla(${hue},75%,${l}%,${a})`;
        waterCtx.fillRect(x0, 0, x1 - x0, 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.55;
      ctx.drawImage(waterCanvas, 0, 0);
      ctx.globalAlpha = 1;
    }

    function drawOscilloscope(audio) {
      const wf = audio.waveform;
      if (!wf) return;
      const midY = H / 2;
      const N = wf.length;
      const amp = (H * 0.35) * (0.4 + audio.bands.total * 1.2 + audio.beat.pulse * 0.5);
      const hueShift = audio.bands.highs * 20;
      ctx.globalCompositeOperation = 'lighter';
      const traces = [
        { hue: 270, off: -0.012, width: 2.4, alpha: 0.55 },
        { hue: 195, off:  0.000, width: 1.6, alpha: 0.75 },
        { hue: 330, off:  0.012, width: 2.4, alpha: 0.55 },
      ];
      for (const tr of traces) {
        ctx.strokeStyle = `hsla(${tr.hue + hueShift},85%,65%,${tr.alpha})`;
        ctx.lineWidth = tr.width;
        ctx.beginPath();
        for (let i = 0; i < N; i += 2) {
          const x = (i / (N - 1)) * W;
          const v = (wf[i] - 128) / 128;
          const y = midY + v * amp + tr.off * H;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawNebula(audio) {
      const spectrum = audio.spectrum;
      ctx.globalCompositeOperation = 'lighter';
      // Bass blob, bottom-centre.
      if (audio.bands.bass > 0.02) {
        const r = Math.min(W, H) * (0.18 + audio.bands.bass * 0.35);
        const g = ctx.createRadialGradient(W * 0.5, H * 0.72, 0, W * 0.5, H * 0.72, r);
        g.addColorStop(0, `rgba(139,92,246,${0.35 * audio.bands.bass})`);
        g.addColorStop(1, 'rgba(139,92,246,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      // Mids blob, left-centre.
      if (audio.bands.mids > 0.02) {
        const r = Math.min(W, H) * (0.16 + audio.bands.mids * 0.30);
        const g = ctx.createRadialGradient(W * 0.28, H * 0.42, 0, W * 0.28, H * 0.42, r);
        g.addColorStop(0, `rgba(34,211,238,${0.32 * audio.bands.mids})`);
        g.addColorStop(1, 'rgba(34,211,238,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      // Highs blob, top-right.
      if (audio.bands.highs > 0.02) {
        const r = Math.min(W, H) * (0.12 + audio.bands.highs * 0.28);
        const g = ctx.createRadialGradient(W * 0.75, H * 0.28, 0, W * 0.75, H * 0.28, r);
        g.addColorStop(0, `rgba(244,114,182,${0.35 * audio.bands.highs})`);
        g.addColorStop(1, 'rgba(244,114,182,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      // Roving peak speck.
      if (spectrum) {
        buildLogBins(spectrum.length);
        let peak = 0, peakBin = 0;
        for (let i = 0; i < BAR_COUNT; i++) {
          const v = sampleBar(spectrum, i);
          if (v > peak) { peak = v; peakBin = i; }
        }
        if (peak > 0.25) {
          const x = ((peakBin + 0.5) / BAR_COUNT) * W;
          const y = H * (0.25 + Math.sin(performance.now() * 0.0003) * 0.15);
          const r = 6 + peak * 14;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
          g.addColorStop(0, `rgba(251,191,36,${peak * 0.55})`);
          g.addColorStop(1, 'rgba(251,191,36,0)');
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // Render-time scratch.
    let _mode = 'bars', _audio = null, _params = null;

    function update(field) {
      const { params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      _mode   = params.mode || 'bars';
      _audio  = audio;
      _params = params;
    }

    function render() {
      const audio = _audio;
      const params = _params;
      if (!audio || !params) return;
      // Background fade. Bass slightly opens trails up. Waterfall mode uses
      // its own internal buffer, so the main canvas can clear faster.
      const baseFade = _mode === 'waterfall'
        ? Math.max(params.fade, 0.30)
        : params.fade;
      const fade = audio.spectrum ? baseFade * (0.85 + audio.bands.bass * 0.5) : baseFade;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(5,5,13,${fade})`;
      ctx.fillRect(0, 0, W, H);
      // Beat flash.
      if (audio.beat.pulse > 0.08) {
        ctx.fillStyle = `rgba(139,92,246,${audio.beat.pulse * 0.05})`;
        ctx.fillRect(0, 0, W, H);
      }
      switch (_mode) {
        case 'bars':         drawBars(audio); break;
        case 'radial':       drawRadial(audio); break;
        case 'waterfall':    drawWaterfall(audio); break;
        case 'oscilloscope': drawOscilloscope(audio); break;
        case 'nebula':       drawNebula(audio); break;
      }
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        // Force waterfall buffer to re-allocate at the new size.
        if (waterCanvas) { waterCanvas.width = W; waterCanvas.height = H; }
      },
      update,
      render,
      dispose() { /* GC handles typed arrays */ },
    };
  },
};
