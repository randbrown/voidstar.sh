// Text — text video synthesis. One string treated as a light source: it
// breathes with the beat, sways or spins, and feeds back on itself through a
// zoom/twist trail buffer — the classic video-synth feedback tunnel, with a
// word in the middle instead of an oscillator.
//
// Built to be pattern-driven from Strudel: the `text` param is a first-class
// param id, so `qset("text", "<VOID STAR ...>")` (or the `qtext(...)` sugar
// lane, code-api.js) swaps the word per event while feedback smears the
// previous one into the trail. Underscores render as spaces so multi-word
// phrases survive mini-notation tokenization: `qtext("<one_more_time>")`.
//
// Audio: beat pulse punches the scale (manual, sharp), bass breathes the
// declared `size` modulator, highs lift `glow` — all scaled by the
// `reactivity` master. Idle-alive: wobble sway + the feedback drift keep the
// frame moving with audio off.
//
// Perf: hot path is allocation-free — one scratch-canvas copy + one
// transformed decay blit + one fillText per frame; text metrics and the font
// string are re-computed only when text/size/viewport change. maxDpr 1.25
// keeps the two fullscreen blits cheap on hi-DPI.

import { scaleAudio } from '../field.js';

const PALETTES = {
  voidblue: { text: '#e8ecf8', accent: '#22d3ee' },
  violet:   { text: '#e9e6ff', accent: '#8b5cf6' },
  phosphor: { text: '#dcffe8', accent: '#6ee7a0' },
  amber:    { text: '#fdf3df', accent: '#fbbf24' },
  mono:     { text: '#ffffff', accent: '#d6d6d6' },
  nightcall:{ text: '#f2f4fa', accent: '#ff2b33' },
};

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'text',
  name: 'Text',
  contextType: 'canvas2d',
  maxDpr: 1.25,

  params: [
    { id: 'text', label: 'text', type: 'text',
      placeholder: 'text… (_ = space)', default: 'voidstar' },
    { id: 'size', label: 'size', type: 'range',
      min: 0.04, max: 0.6, step: 0.01, default: 0.18,
      modulators: [{ source: 'audio.bass', mode: 'mul', amount: 0.35 }] },
    { id: 'pulse', label: 'beat pulse', type: 'range',
      min: 0, max: 1, step: 0.05, default: 0.5 },
    { id: 'spin', label: 'spin', type: 'range',
      min: -0.5, max: 0.5, step: 0.01, default: 0 },
    { id: 'wobble', label: 'wobble', type: 'range',
      min: 0, max: 1, step: 0.05, default: 0.2 },
    { id: 'feedback', label: 'feedback', type: 'range',
      min: 0, max: 0.97, step: 0.01, default: 0.88 },
    { id: 'tunnel', label: 'tunnel', type: 'range',
      min: -1, max: 1, step: 0.05, default: 0.3 },
    { id: 'twist', label: 'twist', type: 'range',
      min: -1, max: 1, step: 0.05, default: 0.12 },
    { id: 'glow', label: 'glow', type: 'range',
      min: 0, max: 1, step: 0.05, default: 0.6,
      modulators: [{ source: 'audio.highs', mode: 'add', amount: 0.3 }] },
    { id: 'palette', label: 'palette', type: 'select',
      options: ['voidblue', 'violet', 'phosphor', 'amber', 'mono', 'nightcall'],
      default: 'voidblue' },
    { id: 'reactivity', label: 'reactivity', type: 'range',
      min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // Palette axis for auto-phase / qphase lanes; also what a colliding
  // qset('palette') claims over.
  autoPhase: {
    steps: [
      { palette: 'voidblue' }, { palette: 'violet' }, { palette: 'phosphor' },
      { palette: 'amber' }, { palette: 'nightcall' }, { palette: 'mono' },
    ],
  },

  presets: {
    default:     { text: 'voidstar', size: 0.18, pulse: 0.5, spin: 0, wobble: 0.2, feedback: 0.88, tunnel: 0.3, twist: 0.12, glow: 0.6, palette: 'voidblue', reactivity: 1.0 },
    strobe_word: { pulse: 1, feedback: 0.25, tunnel: 0, twist: 0, wobble: 0.05, size: 0.3 },
    tunnel:      { feedback: 0.94, tunnel: 0.8, twist: 0.35, size: 0.14, glow: 0.7 },
    orbit:       { spin: 0.25, feedback: 0.9, tunnel: -0.4, twist: -0.2, wobble: 0 },
    billboard:   { feedback: 0.5, tunnel: 0.1, twist: 0, wobble: 0.08, size: 0.34, glow: 0.8 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // Feedback ping-pong buffer — previous frame is copied here, then decayed
    // back onto the cleared main canvas under a zoom/twist transform.
    const scratch = document.createElement('canvas');
    scratch.width = W; scratch.height = H;
    let sctx = scratch.getContext('2d');

    // Text metrics cache — measure only when text / px / viewport change.
    let metricsKey = '';
    let shownText = '';
    let fontStr = '';
    let fitScale = 1;
    let spinPhase = 0;

    const s = {
      dt: 0, time: 0, bass: 0, beatPulse: 0,
      text: '', size: 0.18, pulse: 0.5, spin: 0, wobble: 0.2,
      feedback: 0.88, tunnel: 0.3, twist: 0.12, glow: 0.6,
      palette: 'voidblue',
    };

    function update(field) {
      const p = field.params;
      const audio = scaleAudio(field.audio, p.reactivity);
      s.dt        = field.dt;
      s.time      = field.time;
      s.bass      = audio.bands.bass;
      s.beatPulse = audio.beat.pulse;
      s.text      = String(p.text ?? '');
      s.size      = p.size;
      s.pulse     = p.pulse;
      s.spin      = p.spin;
      s.wobble    = p.wobble;
      s.feedback  = p.feedback;
      s.tunnel    = p.tunnel;
      s.twist     = p.twist;
      s.glow      = p.glow;
      s.palette   = PALETTES[p.palette] ? p.palette : 'voidblue';
      spinPhase  += s.spin * Math.PI * 2 * field.dt;
    }

    function ensureMetrics(px) {
      const key = `${s.text}|${px}|${W}`;
      if (key === metricsKey) return;
      metricsKey = key;
      shownText = s.text.replace(/_/g, ' ').trim();
      fontStr = `700 ${px}px "JetBrains Mono", "Cascadia Code", "Menlo", "Consolas", monospace`;
      if (!shownText) { fitScale = 1; return; }
      ctx.font = fontStr;
      const w = ctx.measureText(shownText).width;
      fitScale = w > 0 ? Math.min(1, (W * 0.92) / w) : 1;
    }

    function render() {
      if (!W || !H) return;   // pre-first-resize frame: nothing to draw into
      const pal = PALETTES[s.palette];
      const m = Math.min(W, H);

      // 1. Previous frame → scratch ('copy' skips the implicit clear).
      sctx.globalCompositeOperation = 'copy';
      sctx.drawImage(canvas, 0, 0);

      // 2. Clear to void, then decay the trail back under zoom + twist.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);
      if (s.feedback > 0.005) {
        // dt-scaled so the tunnel/twist rates are wall-clock-true at any fps.
        const z = 1 + s.tunnel * 0.5 * s.dt;
        const r = s.twist * 0.35 * s.dt;
        ctx.save();
        ctx.globalAlpha = s.feedback;
        ctx.translate(W / 2, H / 2);
        ctx.scale(z, z);
        ctx.rotate(r);
        ctx.translate(-W / 2, -H / 2);
        ctx.drawImage(scratch, 0, 0);
        ctx.restore();
      }

      // 3. The glyph itself.
      const px = Math.max(8, Math.round(m * s.size));
      ensureMetrics(px);
      if (!shownText) return;
      const beatScale = 1 + s.beatPulse * s.pulse * 0.35;
      const rot = s.wobble * 0.22 * Math.sin(s.time * 0.9) + spinPhase;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(rot);
      ctx.scale(fitScale * beatScale, fitScale * beatScale);
      ctx.font = fontStr;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = pal.accent;
      ctx.shadowBlur = s.glow * (14 + s.bass * 46) * (m / 1080);
      ctx.fillStyle = pal.text;
      ctx.fillText(shownText, 0, 0);
      ctx.restore();
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        scratch.width = w; scratch.height = h;
        sctx = scratch.getContext('2d');
        metricsKey = '';
      },
      update,
      render,
      dispose() { /* scratch is GC'd with the instance; no GPU handles */ },
    };
  },
};
