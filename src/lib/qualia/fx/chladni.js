// Chladni — port of cymatics' wave-field family. Five modes share the same
// particle system / audio modulation:
//   - chladni       Square plate ψ = sin(mπx)·sin(nπy) + sin(nπx)·sin(mπy)
//   - radial        Circular plate cos(mπr)·cos(nθ)
//   - interference  Multi-source wave interference (audio-driven sources)
//   - lissajous     Stereo-time waveform x[t] vs x[t+delay] (waveform-driven)
//   - field         Low-res heatmap of ψ
//
// All modes read state through `field` only — no globals. UI is generated
// from the params schema by core/ui.js, so adding/renaming params doesn't
// touch the page.

import { scaleAudio } from '../field.js';

const PI = Math.PI;
const MAX_PARTICLES = 6000;
const PARTICLE_MODES = new Set(['chladni', 'radial', 'interference']);

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'chladni',
  name: 'Chladni',
  contextType: 'canvas2d',

  params: [
    { id: 'mode', label: 'mode', type: 'select',
      options: ['chladni', 'radial', 'interference', 'lissajous', 'field'], default: 'chladni' },
    { id: 'm',         label: 'm',          type: 'range', min: 1,    max: 14,   step: 0.1,   default: 3.0 },
    { id: 'n',         label: 'n',          type: 'range', min: 1,    max: 14,   step: 0.1,   default: 5.0 },
    { id: 'count',     label: 'particles',  type: 'range', min: 500,  max: 6000, step: 100,   default: 3000 },
    { id: 'pull',      label: 'pull',       type: 'range', min: 0,    max: 2,    step: 0.02,  default: 0.85 },
    { id: 'jitter',    label: 'jitter',     type: 'range', min: 0,    max: 2,    step: 0.02,  default: 0.6 },
    { id: 'lockMN',    label: 'lock m/n',   type: 'toggle', default: true },
    { id: 'symmetry',  label: '4-way symm', type: 'toggle', default: true },
    { id: 'trails',    label: 'trails',     type: 'toggle', default: false },
    { id: 'reactivity',label: 'reactivity', type: 'range', min: 0,    max: 2,    step: 0.05, default: 1.0 },
  ],

  presets: {
    default:      { mode: 'chladni', m: 3.0, n: 5.0, lockMN: true, symmetry: true, trails: false, reactivity: 1.0 },
    chladni:      { mode: 'chladni', m: 3.0, n: 5.0 },
    high:         { mode: 'chladni', m: 8.0, n: 11.0 },
    radial:       { mode: 'radial', m: 4.0, n: 5.0 },
    interference: { mode: 'interference' },
    lissajous:    { mode: 'lissajous' },
    heatmap:      { mode: 'field' },
    drift:        { mode: 'chladni', m: 2.0, n: 3.0, jitter: 0.9, trails: true },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const px  = new Float32Array(MAX_PARTICLES);
    const py  = new Float32Array(MAX_PARTICLES);
    const pvx = new Float32Array(MAX_PARTICLES);
    const pvy = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      px[i] = Math.random();
      py[i] = Math.random();
      pvx[i] = pvy[i] = 0;
    }

    let mNow = 3.0, nNow = 5.0;
    let _sourcesCache = null;

    // ── Wave fields ─────────────────────────────────────────────────────────
    function fieldChladni(x, y, m, n) {
      const mPI = m * PI, nPI = n * PI;
      const sxm = Math.sin(mPI * x), sym = Math.sin(mPI * y);
      const sxn = Math.sin(nPI * x), syn = Math.sin(nPI * y);
      const psi = sxm * syn + sxn * sym;
      const gx  = mPI * Math.cos(mPI * x) * syn + nPI * Math.cos(nPI * x) * sym;
      const gy  = nPI * sxm * Math.cos(nPI * y) + mPI * sxn * Math.cos(mPI * y);
      return [psi, gx, gy];
    }
    function fieldRadial(x, y, m, n) {
      const dx = x - 0.5, dy = y - 0.5;
      const r2 = dx * dx + dy * dy;
      const r  = Math.sqrt(r2);
      if (r < 1e-4) return [0, 0, 0];
      const theta = Math.atan2(dy, dx);
      const mEff = m * 0.6, nEff = Math.max(1, Math.floor(n));
      const a = mEff * PI * r * 2;
      const cosa = Math.cos(a), sina = Math.sin(a);
      const cosnt = Math.cos(nEff * theta), sinnt = Math.sin(nEff * theta);
      const psi = cosa * cosnt;
      const dpsi_dr = -2 * mEff * PI * sina * cosnt;
      const dpsi_dtheta = -nEff * cosa * sinnt;
      const gx = dpsi_dr * (dx / r) + dpsi_dtheta * (-dy / r2);
      const gy = dpsi_dr * (dy / r) + dpsi_dtheta * ( dx / r2);
      return [psi, gx, gy];
    }
    function getSources(time, audio) {
      const t = time * 0.12;
      const audioOn = !!audio.spectrum;
      const f1 = 4 + (audioOn ? audio.bands.bass  * 18 : 4 * Math.sin(t * 0.7));
      const f2 = 4 + (audioOn ? audio.bands.mids  * 18 : 4 * Math.sin(t * 1.1));
      const f3 = 4 + (audioOn ? audio.bands.highs * 18 : 4 * Math.sin(t * 1.5));
      const r = 0.32;
      return [
        { x: 0.5 + r * Math.cos(t),         y: 0.5 + r * Math.sin(t),         f: f1 },
        { x: 0.5 + r * Math.cos(t + 2.094), y: 0.5 + r * Math.sin(t + 2.094), f: f2 },
        { x: 0.5 + r * Math.cos(t + 4.188), y: 0.5 + r * Math.sin(t + 4.188), f: f3 },
      ];
    }
    function fieldInterference(x, y) {
      const sources = _sourcesCache;
      if (!sources) return [0, 0, 0];
      let psi = 0, gx = 0, gy = 0;
      for (let i = 0; i < sources.length; i++) {
        const s = sources[i];
        const ddx = x - s.x, ddy = y - s.y;
        const d   = Math.sqrt(ddx * ddx + ddy * ddy) + 1e-4;
        const k   = s.f * 2 * PI;
        psi += Math.cos(k * d);
        const sn = Math.sin(k * d);
        gx  += -k * sn * (ddx / d);
        gy  += -k * sn * (ddy / d);
      }
      return [psi, gx, gy];
    }
    function evalField(mode, x, y) {
      switch (mode) {
        case 'chladni':      return fieldChladni(x, y, mNow, nNow);
        case 'radial':       return fieldRadial(x, y, mNow, nNow);
        case 'interference': return fieldInterference(x, y);
        default:             return fieldChladni(x, y, mNow, nNow);
      }
    }

    // ── Particle update ─────────────────────────────────────────────────────
    function updateParticles(dt, mode, audio, params) {
      const audioOn = !!audio.spectrum;
      const frac = Math.min(dt * 60, 1.5);
      const damping = Math.pow(0.86, frac);
      const pull    = params.pull * 0.0009 * frac;
      const jitterAmt = (params.jitter * 0.0024
                        + (audioOn ? audio.bands.total * 0.004 + audio.beat.pulse * 0.012 : 0)) * frac;
      const audioBoost = audioOn ? (1 + audio.bands.total * 1.4 + audio.beat.pulse * 0.8) : 1;
      const N = Math.min(MAX_PARTICLES, params.count | 0);
      for (let i = 0; i < N; i++) {
        const x = px[i], y = py[i];
        const [psi, gx, gy] = evalField(mode, x, y);
        pvx[i] -= pull * psi * gx * audioBoost;
        pvy[i] -= pull * psi * gy * audioBoost;
        const j = jitterAmt * (0.4 + Math.abs(psi));
        pvx[i] += (Math.random() - 0.5) * j;
        pvy[i] += (Math.random() - 0.5) * j;
        pvx[i] *= damping;
        pvy[i] *= damping;
        let nx = x + pvx[i], ny = y + pvy[i];
        if (nx < 0)      { nx = -nx;     pvx[i] = -pvx[i] * 0.5; }
        else if (nx > 1) { nx = 2 - nx;  pvx[i] = -pvx[i] * 0.5; }
        if (ny < 0)      { ny = -ny;     pvy[i] = -pvy[i] * 0.5; }
        else if (ny > 1) { ny = 2 - ny;  pvy[i] = -pvy[i] * 0.5; }
        px[i] = nx; py[i] = ny;
      }
    }

    // ── Renderers ───────────────────────────────────────────────────────────
    function drawParticles(audio, params) {
      ctx.globalCompositeOperation = 'lighter';
      const audioOn = !!audio.spectrum;
      const hueBase = 250 + (audioOn ? audio.bands.mids * 60 + audio.beat.pulse * 30 : 0);
      const hueSpread = 90;
      const baseAlpha = 0.45 + (audioOn ? audio.bands.total * 0.35 : 0);
      const r = 0.9 + (audioOn ? audio.beat.pulse * 0.8 : 0);
      const N = Math.min(MAX_PARTICLES, params.count | 0);
      for (let i = 0; i < N; i++) {
        const speed = Math.min(0.06, Math.hypot(pvx[i], pvy[i]));
        const t = speed / 0.06;
        const hue = hueBase + t * hueSpread + (i & 31) * 1.5;
        const a   = baseAlpha * (0.45 + t * 0.7);
        ctx.fillStyle = `hsla(${hue},85%,${55 + t * 25}%,${a})`;
        if (params.symmetry) {
          const cx = W * 0.5, cy = H * 0.5;
          const ox = (px[i] - 0.5) * W * 0.5;
          const oy = (py[i] - 0.5) * H * 0.5;
          ctx.fillRect(cx + ox - r, cy + oy - r, r * 2, r * 2);
          ctx.fillRect(cx - ox - r, cy + oy - r, r * 2, r * 2);
          ctx.fillRect(cx + ox - r, cy - oy - r, r * 2, r * 2);
          ctx.fillRect(cx - ox - r, cy - oy - r, r * 2, r * 2);
        } else {
          ctx.fillRect(px[i] * W - r, py[i] * H - r, r * 2, r * 2);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawLissajous(audio, time) {
      const audioOn = !!audio.spectrum && !!audio.waveform;
      ctx.globalCompositeOperation = 'lighter';
      if (!audioOn) {
        // Idle: slowly-rotating Lissajous so the screen isn't dead.
        const t = time * 0.5;
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = `hsla(270,80%,65%,0.6)`;
        ctx.beginPath();
        const N = 720;
        const cx = W / 2, cy = H / 2;
        const rx = Math.min(W, H) * 0.38;
        const ry = Math.min(W, H) * 0.38;
        for (let i = 0; i <= N; i++) {
          const u = (i / N) * Math.PI * 2;
          const x = cx + rx * Math.sin(3 * u + t);
          const y = cy + ry * Math.sin(2 * u);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        return;
      }
      const time_ = audio.waveform;
      const N    = time_.length;
      const cx   = W / 2, cy = H / 2;
      const amp  = Math.min(W, H) * 0.42 * (0.5 + audio.bands.total * 1.6 + audio.beat.pulse * 0.5);
      const delay= Math.max(8, Math.floor(N / 8));
      const traces = [
        { hue: 270, off: -0.012, width: 2.2, alpha: 0.55 },
        { hue: 195, off:  0.000, width: 1.4, alpha: 0.80 },
        { hue: 330, off:  0.012, width: 2.2, alpha: 0.55 },
      ];
      for (const tr of traces) {
        ctx.strokeStyle = `hsla(${tr.hue + audio.bands.highs * 20},85%,65%,${tr.alpha})`;
        ctx.lineWidth = tr.width;
        ctx.beginPath();
        for (let i = 0; i < N; i += 2) {
          const xv = (time_[i] - 128) / 128;
          const yv = (time_[(i + delay) % N] - 128) / 128;
          const x = cx + xv * amp + tr.off * W;
          const y = cy + yv * amp;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    let fieldBuf = null, fieldBufCtx = null, fieldBufW = 0, fieldBufH = 0;
    function ensureFieldBuf() {
      const targetW = 128;
      const targetH = Math.max(36, Math.round(targetW * (H / W)));
      if (!fieldBuf) {
        fieldBuf = document.createElement('canvas');
        fieldBufCtx = fieldBuf.getContext('2d');
      }
      if (fieldBuf.width !== targetW || fieldBuf.height !== targetH) {
        fieldBuf.width = targetW;
        fieldBuf.height = targetH;
        fieldBufW = targetW; fieldBufH = targetH;
      }
    }
    function drawField(mode, audio) {
      ensureFieldBuf();
      const img = fieldBufCtx.createImageData(fieldBufW, fieldBufH);
      const data = img.data;
      const audioOn = !!audio.spectrum;
      const hueBase = audioOn ? 250 + audio.bands.mids * 80 : 250;
      const energy  = audioOn ? audio.bands.total : 0.4;
      for (let j = 0; j < fieldBufH; j++) {
        const y = (j + 0.5) / fieldBufH;
        for (let i = 0; i < fieldBufW; i++) {
          const x = (i + 0.5) / fieldBufW;
          const [psi] = evalField(mode === 'field' ? 'chladni' : mode, x, y);
          const v = Math.max(-1, Math.min(1, psi * 0.5));
          const sign = v < 0 ? 1 : 0;
          const mag  = Math.abs(v);
          const hue  = (hueBase + (sign ? 60 : -50) + mag * 30) % 360;
          const lum  = 4 + mag * (35 + energy * 25);
          const [rr, gg, bb] = hslToRgb(hue / 360, 0.85, lum / 100);
          const idx = (j * fieldBufW + i) * 4;
          data[idx] = rr; data[idx + 1] = gg; data[idx + 2] = bb; data[idx + 3] = 255;
        }
      }
      fieldBufCtx.putImageData(img, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(fieldBuf, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    function hslToRgb(h, s, l) {
      let r, g, b;
      if (s === 0) { r = g = b = l; }
      else {
        const hue2rgb = (p, q, t) => {
          if (t < 0) t += 1; if (t > 1) t -= 1;
          if (t < 1/6) return p + (q - p) * 6 * t;
          if (t < 1/2) return q;
          if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
          return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
      }
      return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    }

    // Render-time scratch.
    let _mode = 'chladni', _params = null, _audio = null, _time = 0;

    function update(field) {
      const { dt, time, params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      const audioOn = !!audio.spectrum;
      _mode = params.mode || 'chladni';
      _params = params; _audio = audio; _time = time;

      // Soft chase on m,n (only meaningful for chladni/radial).
      let mTarget, nTarget;
      if (params.lockMN || !audioOn) {
        mTarget = params.m; nTarget = params.n;
      } else {
        mTarget = params.m + audio.bands.bass * 6 + audio.beat.pulse * 1.5;
        nTarget = params.n + audio.bands.mids * 6;
      }
      const k = Math.min(1, dt * 1.6);
      mNow += (mTarget - mNow) * k;
      nNow += (nTarget - nNow) * k;

      if (_mode === 'interference') _sourcesCache = getSources(time, audio);
      if (PARTICLE_MODES.has(_mode)) updateParticles(dt, _mode, audio, params);
    }

    function render() {
      const audio = _audio || { spectrum: null, bands: { bass: 0, mids: 0, highs: 0, total: 0 }, beat: { active: false, pulse: 0 } };
      const params = _params || {};
      // Background fade — trails keeps long history.
      const baseFade = params.trails ? 0.05 : 0.18;
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
        case 'chladni':
        case 'radial':
        case 'interference':
          drawParticles(audio, params);
          break;
        case 'lissajous':
          drawLissajous(audio, _time);
          break;
        case 'field':
          drawField(_mode, audio);
          break;
      }
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* GC handles typed arrays */ },
    };
  },
};
