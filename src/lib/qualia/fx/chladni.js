// Chladni — port of cymatics' chladni mode. Particles drift to nodal lines
// of a square-plate Chladni field ψ(x,y) = sin(mπx)·sin(nπy) + sin(nπx)·sin(mπy).
//
// Validates the Canvas2D path of the qualia harness against an existing
// reference (cymatics:691–945). Same particle buffer shape, same gradient
// descent, same kaleidoscope symmetry option.

const PI = Math.PI;
const MAX_PARTICLES = 6000;

/** @type {import('../types.js').QualiaFXModule} */
export default {
  id: 'chladni',
  name: 'Chladni',
  contextType: 'canvas2d',

  params: [
    { id: 'm',         label: 'm',          type: 'range', min: 1,    max: 14,   step: 0.1,   default: 3.0 },
    { id: 'n',         label: 'n',          type: 'range', min: 1,    max: 14,   step: 0.1,   default: 5.0 },
    { id: 'count',     label: 'particles',  type: 'range', min: 500,  max: 6000, step: 100,   default: 3000 },
    { id: 'pull',      label: 'pull',       type: 'range', min: 0,    max: 2,    step: 0.02,  default: 0.85 },
    { id: 'jitter',    label: 'jitter',     type: 'range', min: 0,    max: 2,    step: 0.02,  default: 0.6 },
    { id: 'lockMN',    label: 'lock m/n',   type: 'toggle', default: true },
    { id: 'symmetry',  label: '4-way symm', type: 'toggle', default: true },
    { id: 'trails',    label: 'trails',     type: 'toggle', default: false },
  ],

  presets: {
    default: { m: 3.0, n: 5.0, lockMN: true, symmetry: true, trails: false },
    high:    { m: 8.0, n: 11.0 },
    drift:   { m: 2.0, n: 3.0, jitter: 0.9, trails: true },
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

    // Smoothed m, n that chase audio (or stay locked to sliders).
    let mNow = 3.0, nNow = 5.0;

    function fieldChladni(x, y, m, n) {
      const mPI = m * PI, nPI = n * PI;
      const sxm = Math.sin(mPI * x), sym = Math.sin(mPI * y);
      const sxn = Math.sin(nPI * x), syn = Math.sin(nPI * y);
      const psi = sxm * syn + sxn * sym;
      const gx  = mPI * Math.cos(mPI * x) * syn + nPI * Math.cos(nPI * x) * sym;
      const gy  = nPI * sxm * Math.cos(nPI * y) + mPI * sxn * Math.cos(mPI * y);
      return [psi, gx, gy];
    }

    function update(field) {
      const { dt, audio, params } = field;
      const audioOn = !!audio.spectrum;

      // Soft chase on m,n.
      let mTarget, nTarget;
      if (params.lockMN || !audioOn) {
        mTarget = params.m;
        nTarget = params.n;
      } else {
        mTarget = params.m + audio.bands.bass * 6 + audio.beat.pulse * 1.5;
        nTarget = params.n + audio.bands.mids * 6;
      }
      const k = Math.min(1, dt * 1.6);
      mNow += (mTarget - mNow) * k;
      nNow += (nTarget - nNow) * k;

      const frac = Math.min(dt * 60, 1.5);
      const damping = Math.pow(0.86, frac);
      const pull    = params.pull * 0.0009 * frac;
      const jitterAmt = (params.jitter * 0.0024
                        + (audioOn ? audio.bands.total * 0.004 + audio.beat.pulse * 0.012 : 0)) * frac;
      const audioBoost = audioOn ? (1 + audio.bands.total * 1.4 + audio.beat.pulse * 0.8) : 1;

      const N = Math.min(MAX_PARTICLES, params.count | 0);
      for (let i = 0; i < N; i++) {
        const x = px[i], y = py[i];
        const [psi, gx, gy] = fieldChladni(x, y, mNow, nNow);
        // Gradient descent on ψ² ⇒ step ∝ -ψ ∇ψ.
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
        px[i] = nx;
        py[i] = ny;
      }

      // Stash the resolved values for render() so we don't read field there.
      _audioOn = audioOn;
      _bass    = audio.bands.bass;
      _mids    = audio.bands.mids;
      _total   = audio.bands.total;
      _beatP   = audio.beat.pulse;
      _count   = N;
      _trails  = !!params.trails;
      _symm    = !!params.symmetry;
    }

    // Render-time scratch — populated in update(), consumed in render().
    let _audioOn = false, _bass = 0, _mids = 0, _total = 0, _beatP = 0;
    let _count = 3000, _trails = false, _symm = true;

    function render() {
      // Background fade — trails mode keeps long history.
      const baseFade = _trails ? 0.05 : 0.18;
      const fade = _audioOn ? baseFade * (0.85 + _bass * 0.5) : baseFade;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(5,5,13,${fade})`;
      ctx.fillRect(0, 0, W, H);

      // Subtle beat flash.
      if (_beatP > 0.08) {
        ctx.fillStyle = `rgba(139,92,246,${_beatP * 0.05})`;
        ctx.fillRect(0, 0, W, H);
      }

      // Particles.
      ctx.globalCompositeOperation = 'lighter';
      const hueBase = 250 + (_audioOn ? _mids * 60 + _beatP * 30 : 0);
      const hueSpread = 90;
      const baseAlpha = 0.45 + (_audioOn ? _total * 0.35 : 0);
      const r = 0.9 + (_audioOn ? _beatP * 0.8 : 0);

      for (let i = 0; i < _count; i++) {
        const speed = Math.min(0.06, Math.hypot(pvx[i], pvy[i]));
        const t = speed / 0.06;
        const hue = hueBase + t * hueSpread + (i & 31) * 1.5;
        const a   = baseAlpha * (0.45 + t * 0.7);
        ctx.fillStyle = `hsla(${hue},85%,${55 + t * 25}%,${a})`;

        if (_symm) {
          const x = px[i], y = py[i];
          const cx = W * 0.5, cy = H * 0.5;
          const ox = (x - 0.5) * W * 0.5;
          const oy = (y - 0.5) * H * 0.5;
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

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() { /* GC handles the typed arrays */ },
    };
  },
};
