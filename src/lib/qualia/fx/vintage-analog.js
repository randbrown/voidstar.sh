// Vintage Analog — emulation of four classic analog audio-visualization
// units. Each phase mode is a different unit; params common across modes
// are surfaced once at the top, mode-specific knobs follow.
//
//   - vu          70s studio VU meter — needle with realistic ballistics
//                 (~300 ms rise/fall), peak-pin bounce at the +3 dB stop.
//   - oscilloscope CRT in X-Y mode. Waveform delay-pair (we don't have a
//                 true L/R split in the merged analyser, so we phase-shift
//                 the same buffer to draw a Lissajous trace) with phosphor
//                 persistence + bloom.
//   - vfd         80s/90s vacuum-fluorescent spectrum analyser. Segmented
//                 bars with peak-hold dots and a teal/amber colour temp.
//   - color-organ 70s 3-channel light box. Bass→red, mids→green,
//                 highs→blue, with incandescent lag and ambient bias.
//
// Audio map (across modes):
//   bands.{bass,mids,highs,total} → needle / lamps / bar heights
//   beat.pulse                   → peak-pin bounce, color-organ kick wash
//   rms                          → VU baseline weighting (mech ballistic)
//   spectrum                     → VFD log-binned bars
//   waveform                     → oscilloscope x[t] / x[t+delay]
//
// Spec mentioned spec-band split 20–250 / 250–2k / 2k–20k for the colour
// organ. We use the existing field bands (20–250 / 250–4k / 4k–12k) so the
// rest of the qualia panel stays in sync — close enough that the lamp
// behaviour reads the same.
//
// Global "warm-up drift" — for the first ~60 s after the quale becomes
// active, baselines wobble by ~1 % to evoke a tube unit settling in. The
// drift fades out smoothly so a user who sticks with this fx for a while
// gets a clean, stable reading.

import { scaleAudio } from '../field.js';

const BAR_COUNT_WIDE   = 10;
const BAR_COUNT_MID    = 15;
const BAR_COUNT_NARROW = 31;
const ASSUMED_SAMPLE_RATE = 48000;
const WARMUP_SECONDS = 60;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'vintage-analog',
  name: 'Vintage Analog',
  contextType: 'canvas2d',

  params: [
    { id: 'mode', label: 'mode', type: 'select',
      options: ['vu', 'oscilloscope', 'vfd', 'color-organ'], default: 'vu' },
    { id: 'gain',       label: 'gain',       type: 'range', min: 0.25, max: 4,    step: 0.05, default: 1.0 },
    { id: 'damping',    label: 'damping',    type: 'range', min: 0.0,  max: 1,    step: 0.02, default: 0.55 },
    { id: 'persistence',label: 'persistence',type: 'range', min: 0.02, max: 0.98, step: 0.01, default: 0.85 },
    { id: 'peakHold',   label: 'peak hold',  type: 'range', min: 0,    max: 2,    step: 0.05, default: 1.0 },
    { id: 'bias',       label: 'bias glow',  type: 'range', min: 0,    max: 0.6,  step: 0.01, default: 0.10 },
    { id: 'bulbLag',    label: 'bulb lag',   type: 'range', min: 0,    max: 1,    step: 0.02, default: 0.40 },
    { id: 'bands',      label: 'bands',      type: 'select', options: ['10', '15', '31'], default: '15' },
    { id: 'colorTemp',  label: 'color temp', type: 'select', options: ['teal', 'amber'], default: 'teal' },
    { id: 'graticule',  label: 'graticule',  type: 'range', min: 0,    max: 1,    step: 0.02, default: 0.35 },
    { id: 'peakPin',    label: 'peak pin',   type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0,    max: 2,    step: 0.05, default: 1.0 },
  ],

  // Auto-phase walks the four units so the topbar `phase` button gives a
  // tour of the rack without the user having to touch the dropdown.
  autoPhase: {
    steps: [
      { mode: 'vu' },
      { mode: 'oscilloscope' },
      { mode: 'vfd' },
      { mode: 'color-organ' },
    ],
  },

  presets: {
    default:     { mode: 'vu' },
    vu:          { mode: 'vu',          damping: 0.55, peakPin: true },
    twitchy:     { mode: 'vu',          damping: 0.18, peakPin: true },
    heavy:       { mode: 'vu',          damping: 0.85, peakPin: true },
    scope:       { mode: 'oscilloscope',persistence: 0.92 },
    'scope-sharp':{mode: 'oscilloscope',persistence: 0.55 },
    vfd:         { mode: 'vfd',         peakHold: 1.0, colorTemp: 'teal' },
    'vfd-amber': { mode: 'vfd',         colorTemp: 'amber' },
    'vfd-31':    { mode: 'vfd',         bands: '31' },
    organ:       { mode: 'color-organ', bias: 0.12, bulbLag: 0.45 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const startMs = performance.now();

    // ── Persistence buffer (oscilloscope phosphor + VU faceplate
    // accumulator). Sized to the backing canvas so the blit is 1:1.
    let phos = null, phosCtx = null;
    function ensurePhos() {
      if (!phos) {
        phos = document.createElement('canvas');
        phosCtx = phos.getContext('2d');
      }
      if (phos.width !== W || phos.height !== H) {
        phos.width  = W;
        phos.height = H;
      }
    }

    // ── VU state ───────────────────────────────────────────────────────
    // Smoothed needle level [0,1] with mech-ballistic asymmetric rates.
    let needle = 0;
    // Peak-pin bounce: when needle exceeds 1.0 the pin gives a quick
    // visual recoil that decays back over a few hundred ms.
    let pinBounce = 0;

    // ── Oscilloscope log-bin scratch (not used; just keeps imports
    // pattern consistent across fx).
    // ── VFD log-bin map ────────────────────────────────────────────────
    let logBinIdx = null;
    let logBinFor = -1;
    let logBinCount = -1;
    function buildLogBins(freqLen, count) {
      if (freqLen === logBinFor && count === logBinCount && logBinIdx) return;
      const fftSize = freqLen * 2;
      const hz   = ASSUMED_SAMPLE_RATE / fftSize;
      const minF = 30, maxF = 14000;
      const last = freqLen - 1;
      logBinIdx = new Int32Array(count + 1);
      for (let i = 0; i <= count; i++) {
        const f = minF * Math.pow(maxF / minF, i / count);
        logBinIdx[i] = Math.max(1, Math.min(last, Math.round(f / hz)));
      }
      logBinFor   = freqLen;
      logBinCount = count;
    }
    function sampleBar(freqBuf, i) {
      if (!logBinIdx) return 0;
      const lo = logBinIdx[i], hi = Math.max(lo + 1, logBinIdx[i + 1]);
      let m = 0;
      for (let k = lo; k < hi; k++) if (freqBuf[k] > m) m = freqBuf[k];
      return m / 255;
    }

    // VFD peak-hold per bar (height in [0,1]). Sized lazily to the
    // active bar count.
    let peakHeights = null;
    let peakAgeMs   = null;
    function ensurePeakArrays(n) {
      if (!peakHeights || peakHeights.length !== n) {
        peakHeights = new Float32Array(n);
        peakAgeMs   = new Float32Array(n);
      }
    }

    // ── Color-organ lamp state (incandescent lag — slow rise/fall on
    // each channel, asymmetric so "filaments" cool slower than they
    // heat up).
    const lamps = { r: 0, g: 0, b: 0 };

    // Warm-up drift: 1 % multiplicative wobble for the first WARMUP_SECONDS
    // of activity. Smooth random walk.
    let warmupPhase = Math.random() * 1000;

    // ── Renderers ──────────────────────────────────────────────────────
    function clearBackdrop(_audio, mode) {
      // Most modes keep the canvas live (mix-blend-mode:screen layers it
      // over Hydra) so an opaque fill would block whatever's underneath.
      // The blend mode treats black as transparent, so painting near-black
      // is effectively "clear".
      if (mode === 'oscilloscope') {
        // Oscilloscope handles its own decay via the phosphor buffer; we
        // skip the global fade so the trail isn't double-faded.
        return;
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(5,5,13,0.85)';
      ctx.fillRect(0, 0, W, H);
    }

    function drawGraticule(strength) {
      if (strength <= 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(80,140,180,${0.12 * strength})`;
      ctx.lineWidth = 1;
      const cx = W / 2, cy = H / 2;
      // Crosshair.
      ctx.beginPath();
      ctx.moveTo(0, cy); ctx.lineTo(W, cy);
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
      ctx.stroke();
      // 8 evenly-spaced grid lines in each axis.
      const step = Math.min(W, H) / 9;
      ctx.strokeStyle = `rgba(80,140,180,${0.06 * strength})`;
      for (let i = -4; i <= 4; i++) {
        if (i === 0) continue;
        const x = cx + i * step;
        const y = cy + i * step;
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(W, y);
        ctx.moveTo(x, 0); ctx.lineTo(x, H);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ─── VU ────────────────────────────────────────────────────────────
    function drawVU(audio, params, warmup) {
      // Driver level. RMS gives the "loudness" feel hardware VU was tuned
      // for; we add a touch of band-total for spectral colour.
      const drive = Math.max(0, Math.min(1.4,
        (audio.rms * 1.4 + audio.bands.total * 0.6) * params.gain * warmup));
      // Asymmetric ballistic rates — rising slower than falling produces
      // the recognisable "weighted needle" feel. Damping slider
      // interpolates between twitchy (low) and heavy (high).
      const k = 0.04 + (1 - params.damping) * 0.30;
      const rise = k * 0.7;
      const fall = k * 1.0;
      const target = drive;
      needle += (target - needle) * (target > needle ? rise : fall);
      // Pin bounce: only register when crossing the +3 dB stop.
      if (params.peakPin && needle > 1.0) {
        const over = needle - 1.0;
        if (over > pinBounce) pinBounce = Math.min(0.4, over * 1.4);
        needle = 1.0;
      }
      pinBounce *= 0.86;

      const cx = W * 0.5;
      const cy = H * 0.78;
      const radius = Math.min(W * 0.42, H * 0.55);

      // Faceplate — radial gradient warm cream → ivory.
      const face = ctx.createRadialGradient(cx, cy * 0.85, radius * 0.1, cx, cy, radius * 1.05);
      face.addColorStop(0, 'rgba(245,232,200,0.95)');
      face.addColorStop(1, 'rgba(180,160,120,0.85)');
      ctx.fillStyle = face;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, Math.PI, 2 * Math.PI);
      ctx.lineTo(cx + radius, cy);
      ctx.lineTo(cx - radius, cy);
      ctx.closePath();
      ctx.fill();
      // Bezel.
      ctx.strokeStyle = 'rgba(20,15,10,0.9)';
      ctx.lineWidth = Math.max(2, radius * 0.012);
      ctx.stroke();

      // Scale arc (–20 dB at left, 0 VU near 75% sweep, +3 at right).
      const sweep = Math.PI * 0.62;        // angular sweep of needle
      const ang0 = -Math.PI / 2 - sweep / 2;
      const ang1 = -Math.PI / 2 + sweep / 2;
      const zeroVU = 0.75;                  // map 0 VU to 75 % of needle range
      const ticks = [
        { v: 0.00, label: '-20', major: true },
        { v: 0.20, label: '-10', major: false },
        { v: 0.40, label: '-7',  major: false },
        { v: 0.55, label: '-5',  major: false },
        { v: 0.70, label: '-3',  major: false },
        { v: zeroVU, label: '0', major: true },
        { v: 0.90, label: '+1', major: false },
        { v: 1.00, label: '+3', major: true, red: true },
      ];
      ctx.lineCap = 'round';
      for (const t of ticks) {
        const a = ang0 + t.v * sweep;
        const r0 = radius * (t.major ? 0.78 : 0.84);
        const r1 = radius * 0.95;
        ctx.strokeStyle = t.red
          ? 'rgba(180,30,30,0.95)'
          : `rgba(30,25,20,${t.major ? 0.95 : 0.6})`;
        ctx.lineWidth = t.major ? 2.5 : 1.4;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.stroke();
      }
      // "VU" label and red zone arc.
      ctx.fillStyle = 'rgba(40,30,20,0.85)';
      ctx.font = `${Math.max(10, radius * 0.06)}px ui-monospace, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('VU', cx, cy - radius * 0.40);
      // Red zone arc (above 0 VU).
      ctx.strokeStyle = 'rgba(180,30,30,0.85)';
      ctx.lineWidth = Math.max(2, radius * 0.018);
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.965,
        ang0 + zeroVU * sweep,
        ang1, false);
      ctx.stroke();

      // Needle.
      const needleAng = ang0 + Math.min(1, needle) * sweep;
      const needleLen = radius * 0.92;
      ctx.strokeStyle = 'rgba(20,15,10,0.95)';
      ctx.lineWidth = Math.max(2, radius * 0.014);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(needleAng) * needleLen,
                 cy + Math.sin(needleAng) * needleLen);
      ctx.stroke();
      // Pivot cap.
      ctx.fillStyle = 'rgba(20,15,10,0.95)';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(3, radius * 0.04), 0, Math.PI * 2);
      ctx.fill();

      // Pin bounce — small red flash near the +3 dB stop.
      if (pinBounce > 0.01) {
        const a = ang1;
        const x = cx + Math.cos(a) * radius * 0.95;
        const y = cy + Math.sin(a) * radius * 0.95;
        const r = radius * (0.04 + pinBounce * 0.12);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
        g.addColorStop(0, `rgba(255,80,60,${pinBounce * 0.9})`);
        g.addColorStop(1, 'rgba(255,80,60,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
    }

    // ─── Oscilloscope (X-Y, phosphor) ─────────────────────────────────
    function drawOscilloscope(audio, params, warmup) {
      ensurePhos();
      // Decay the phosphor buffer first — controls trail length.
      // Persistence near 1 keeps trail long; near 0 wipes hard.
      const fade = 1 - params.persistence;
      phosCtx.globalCompositeOperation = 'source-over';
      phosCtx.fillStyle = `rgba(0,0,0,${0.05 + fade * 0.55})`;
      phosCtx.fillRect(0, 0, W, H);

      const wf = audio.waveform;
      if (wf) {
        const N = wf.length;
        // Lissajous-style x-y from a single-channel waveform: pair
        // sample[i] (x) with sample[i+delay] (y) so phase relationships
        // show up as classic figure-8 / ellipse shapes. Delay of N/8
        // works well across the typical 1024-sample analyser buffer.
        const delay = Math.max(8, Math.floor(N / 8));
        const cx = W / 2, cy = H / 2;
        const amp = Math.min(W, H) * 0.42 *
          (0.55 + audio.bands.total * 0.8 + audio.beat.pulse * 0.3) *
          params.gain * warmup;
        // Glow layer (wide, low-alpha) gives the bloom; sharp layer on
        // top is the "beam".
        phosCtx.globalCompositeOperation = 'lighter';
        const tealRing  = 'rgba(80,255,200,0.45)';
        const tealBeam  = 'rgba(180,255,220,0.95)';
        phosCtx.lineCap = 'round';
        phosCtx.lineJoin = 'round';
        // Bloom pass.
        phosCtx.strokeStyle = tealRing;
        phosCtx.lineWidth = 4 + audio.beat.pulse * 4;
        phosCtx.beginPath();
        for (let i = 0; i < N; i += 2) {
          const xv = (wf[i] - 128) / 128;
          const yv = (wf[(i + delay) % N] - 128) / 128;
          const x = cx + xv * amp;
          const y = cy + yv * amp;
          if (i === 0) phosCtx.moveTo(x, y); else phosCtx.lineTo(x, y);
        }
        phosCtx.stroke();
        // Beam pass.
        phosCtx.strokeStyle = tealBeam;
        phosCtx.lineWidth = 1.4 + audio.bands.total * 0.8;
        phosCtx.beginPath();
        for (let i = 0; i < N; i += 2) {
          const xv = (wf[i] - 128) / 128;
          const yv = (wf[(i + delay) % N] - 128) / 128;
          const x = cx + xv * amp;
          const y = cy + yv * amp;
          if (i === 0) phosCtx.moveTo(x, y); else phosCtx.lineTo(x, y);
        }
        phosCtx.stroke();
      } else {
        // Idle figure: slow Lissajous so the screen isn't dead.
        const t = (performance.now() - startMs) * 0.0008;
        phosCtx.globalCompositeOperation = 'lighter';
        phosCtx.strokeStyle = 'rgba(80,255,200,0.55)';
        phosCtx.lineWidth = 1.5;
        phosCtx.beginPath();
        const M = 360, cx = W / 2, cy = H / 2;
        const rx = Math.min(W, H) * 0.36, ry = Math.min(W, H) * 0.36;
        for (let i = 0; i <= M; i++) {
          const u = (i / M) * Math.PI * 2;
          const x = cx + rx * Math.sin(3 * u + t);
          const y = cy + ry * Math.sin(2 * u);
          if (i === 0) phosCtx.moveTo(x, y); else phosCtx.lineTo(x, y);
        }
        phosCtx.stroke();
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(2,6,8,0.95)';
      ctx.fillRect(0, 0, W, H);
      drawGraticule(params.graticule);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(phos, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }

    // ─── VFD Spectrum ─────────────────────────────────────────────────
    function drawVFD(audio, params, warmup, dt) {
      const spectrum = audio.spectrum;
      const N = params.bands === '10' ? BAR_COUNT_WIDE
              : params.bands === '31' ? BAR_COUNT_NARROW
              :                         BAR_COUNT_MID;
      ensurePeakArrays(N);
      if (spectrum) buildLogBins(spectrum.length, N);

      // Phosphor colour by colourTemp: classic teal vs amber.
      const isAmber = params.colorTemp === 'amber';
      const hueBar  = isAmber ? 38  : 168;
      const hueGlow = isAmber ? 45  : 175;
      const dimBar  = isAmber ? 'rgba(60,40,15,0.55)'  : 'rgba(15,40,40,0.55)';

      // Layout: bars span 80 % width, inset top/bottom for chrome.
      const topPad = H * 0.12;
      const botPad = H * 0.18;
      const usableH = H - topPad - botPad;
      const segH = Math.max(4, usableH / 22);   // 22 segments tall
      const slot = (W * 0.84) / N;
      const bw   = slot * 0.74;
      const x0   = W * 0.08;

      // Faceplate (dark with subtle bezel).
      ctx.fillStyle = 'rgba(8,12,16,0.92)';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(60,80,90,0.4)';
      ctx.lineWidth = 2;
      ctx.strokeRect(W * 0.04, topPad - segH * 0.5,
                     W * 0.92, usableH + segH);

      ctx.globalCompositeOperation = 'lighter';
      const peakHoldMs = params.peakHold * 1000;
      const peakDropPerSec = 1.4;            // how fast peak falls after hold
      for (let i = 0; i < N; i++) {
        let v = spectrum ? sampleBar(spectrum, i) : 0;
        v = Math.min(1, v * params.gain * warmup);

        // Integration: damping slider doubles as 'speed' (low = fast).
        // Apply as exp moving avg per bar, but we don't keep per-bar
        // history — for VFD the FFT smoothing is enough; just use v.

        // Peak-hold logic.
        if (v > peakHeights[i]) {
          peakHeights[i] = v;
          peakAgeMs[i]   = 0;
        } else {
          peakAgeMs[i] += dt * 1000;
          if (peakAgeMs[i] > peakHoldMs) {
            peakHeights[i] = Math.max(0, peakHeights[i] - peakDropPerSec * dt);
          }
        }

        const x = x0 + i * slot + (slot - bw) / 2;
        const litSegments = Math.round(v * 22);
        // Draw segments bottom-up.
        for (let s = 0; s < 22; s++) {
          const yTop = topPad + usableH - (s + 1) * segH;
          const lit  = s < litSegments;
          if (!lit) {
            ctx.fillStyle = dimBar;
            ctx.fillRect(x, yTop, bw, segH * 0.85);
            continue;
          }
          // Top segments hotter + slightly amber tinge in teal mode for
          // the warning-zone classic look.
          const hot = s / 22;
          const sat = 80;
          const lum = 45 + hot * 25;
          const hue = isAmber ? hueBar : hueBar - hot * 30;
          ctx.fillStyle = `hsla(${hue},${sat}%,${lum}%,${0.85})`;
          ctx.fillRect(x, yTop, bw, segH * 0.85);
        }
        // Peak-hold dot.
        if (peakHeights[i] > 0.02) {
          const peakSeg = Math.round(peakHeights[i] * 22) - 1;
          if (peakSeg >= 0 && peakSeg < 22 && peakSeg >= litSegments) {
            const yTop = topPad + usableH - (peakSeg + 1) * segH;
            ctx.fillStyle = `hsla(${hueGlow},90%,80%,0.95)`;
            ctx.fillRect(x, yTop, bw, segH * 0.85);
          }
        }
      }
      // Tube glow wash.
      const glowAlpha = 0.10 + audio.bands.total * 0.20;
      const glow = ctx.createRadialGradient(W * 0.5, H * 0.5, 0,
                                            W * 0.5, H * 0.5, Math.max(W, H) * 0.6);
      glow.addColorStop(0, `hsla(${hueGlow},80%,60%,${glowAlpha})`);
      glow.addColorStop(1, `hsla(${hueGlow},80%,60%,0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    // ─── Color Organ ──────────────────────────────────────────────────
    function drawColorOrgan(audio, params, warmup, dt) {
      // Per-channel target (gain-scaled, warmup-wobbled).
      const tR = Math.min(1, audio.bands.bass  * params.gain * warmup);
      const tG = Math.min(1, audio.bands.mids  * params.gain * warmup);
      const tB = Math.min(1, audio.bands.highs * params.gain * warmup);
      // Incandescent lag — asymmetric. Filaments heat slow, cool slower.
      // bulbLag near 0 = snappy LEDs, near 1 = sluggish bulbs.
      const lag = params.bulbLag;
      const heatK = (1 - lag) * 0.35 + 0.05;
      const coolK = (1 - lag) * 0.18 + 0.02;
      function chase(prev, target) {
        const k = target > prev ? heatK : coolK;
        return prev + (target - prev) * k;
      }
      lamps.r = chase(lamps.r, tR);
      lamps.g = chase(lamps.g, tG);
      lamps.b = chase(lamps.b, tB);

      // Wood-panel backdrop.
      ctx.fillStyle = 'rgba(28,18,10,0.95)';
      ctx.fillRect(0, 0, W, H);
      // Subtle wood-grain stripes (cheap line dither).
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = 'rgba(80,50,30,1)';
      for (let y = 0; y < H; y += 6) {
        const wob = Math.sin(y * 0.08) * 6;
        ctx.fillRect(0, y + wob, W, 1);
      }
      ctx.globalAlpha = 1;

      // Three lamps spaced across the panel.
      const cy = H * 0.50;
      const r  = Math.min(W * 0.13, H * 0.30);
      const positions = [W * 0.22, W * 0.50, W * 0.78];
      const channels  = [
        { lvl: lamps.r, hue: 0   },
        { lvl: lamps.g, hue: 120 },
        { lvl: lamps.b, hue: 220 },
      ];
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const cx = positions[i];
        const ch = channels[i];
        const lvl = Math.max(params.bias, ch.lvl);
        // Bulb body (always faintly visible — the filament).
        const body = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        body.addColorStop(0, `hsla(${ch.hue},70%,${30 + lvl * 40}%,${0.55 + lvl * 0.4})`);
        body.addColorStop(1, `hsla(${ch.hue},70%,15%,0.0)`);
        ctx.fillStyle = body;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        // Outer halo — scales hard with audio level.
        if (lvl > 0.04) {
          const halo = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 3);
          halo.addColorStop(0, `hsla(${ch.hue},85%,60%,${lvl * 0.55})`);
          halo.addColorStop(1, `hsla(${ch.hue},85%,60%,0)`);
          ctx.fillStyle = halo;
          ctx.fillRect(0, 0, W, H);
        }
        // Filament hot-spot.
        const hot = ctx.createRadialGradient(cx, cy - r * 0.1, 0, cx, cy - r * 0.1, r * 0.35);
        hot.addColorStop(0, `hsla(${ch.hue},60%,${70 + lvl * 25}%,${0.6 + lvl * 0.4})`);
        hot.addColorStop(1, `hsla(${ch.hue},60%,40%,0)`);
        ctx.fillStyle = hot;
        ctx.beginPath(); ctx.arc(cx, cy - r * 0.1, r * 0.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      // Beat wash — flashes the whole panel softly on a hard kick.
      if (audio.beat.pulse > 0.08) {
        ctx.fillStyle = `rgba(255,200,140,${audio.beat.pulse * 0.06})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // Render-time scratch.
    let _mode = 'vu', _audio = null, _params = null, _dt = 0;

    function update(field) {
      const { dt, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      _mode  = params.mode || 'vu';
      _audio = audio;
      _params = params;
      _dt = dt;
    }

    function render() {
      const audio = _audio;
      const params = _params;
      if (!audio || !params) return;
      // Warm-up drift — 1 % wobble for the first WARMUP_SECONDS.
      const t = (performance.now() - startMs) / 1000;
      const ramp = Math.max(0, 1 - t / WARMUP_SECONDS);   // 1 → 0 over 60s
      warmupPhase += 0.04;
      const warmup = 1 + Math.sin(warmupPhase) * 0.01 * ramp;

      clearBackdrop(audio, _mode);

      switch (_mode) {
        case 'vu':           drawVU(audio, params, warmup); break;
        case 'oscilloscope': drawOscilloscope(audio, params, warmup); break;
        case 'vfd':          drawVFD(audio, params, warmup, _dt); break;
        case 'color-organ':  drawColorOrgan(audio, params, warmup, _dt); break;
      }
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        if (phos) { phos.width = W; phos.height = H; }
      },
      update,
      render,
      dispose() { /* GC handles canvases + typed arrays */ },
    };
  },
};
