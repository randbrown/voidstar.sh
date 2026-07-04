// Liner Notes — the set's info card, as a quale. Four "transmissions" the
// performer can park on screen (or let auto-phase / auto-cycle rotate
// through): what live coding is, the languages qualia speaks, a scan-to-
// entangle QR, and the voidstar.sh QR. Typewriter text over a drifting
// starfield with CRT scanlines; the QR is the artistic voidstar render
// (portal finders + void* chip) from qr.js.
//
// Audio: highs speed the typing (declared modulator), beats flash the
// heading underline + cursor, bass breathes the star glow. All decoration —
// the QR itself never animates beyond a ≤2% breath, so it stays scannable
// from the back of the room.
//
// Entangle URL: an fx only reads `field`, so this reads the PRINTED code —
// the ?room= override or the pinned performance code (entangle-protocol) —
// the same code the performer's flyers carry. If no code is saved it falls
// back to the site URL (open ⊛ entangle and "save this code" to advertise
// joins from here).

import { scaleAudio } from '../field.js';
import { getPinnedRoom, readRoomFromQuery, buildJoinUrl } from '../entangle-protocol.js';

const PAGES = ['livecoding', 'languages', 'entangle', 'signal'];

const PALETTES = {
  voidblue: { text: '#e8ecf8', dim: '#8f97b8', accent: '#22d3ee', accent2: '#66f0ff', code: '#9be8ff' },
  violet:   { text: '#e9e6ff', dim: '#9b96c4', accent: '#8b5cf6', accent2: '#f472b6', code: '#c4b5fd' },
  phosphor: { text: '#dcffe8', dim: '#7da58c', accent: '#6ee7a0', accent2: '#a7f3d0', code: '#86efac' },
  amber:    { text: '#fdf3df', dim: '#b3a17c', accent: '#fbbf24', accent2: '#fb923c', code: '#fcd34d' },
};

// Content rows: k=kind — 'body' | 'code' | 'lang' (name + desc) | 'gap'.
const CONTENT = {
  livecoding: {
    kicker: '⊛ transmission 01 · live coding',
    h1: 'the code is the instrument',
    rows: [
      { k: 'body', t: 'everything you hear & see is being written' },
      { k: 'body', t: 'as code — live, on this machine, right now.' },
      { k: 'gap' },
      { k: 'body', t: 'patterns loop. edits land on the next cycle.' },
      { k: 'body', t: 'the crashes and typos are part of the show.' },
      { k: 'gap' },
      { k: 'code', t: 'note("c2 eb2 g2 bb2").slow(4).room(.6)' },
      { k: 'gap' },
      { k: 'body', t: 'TOPLAP manifesto: show us your screens.' },
    ],
    qr: false,
  },
  languages: {
    kicker: '⊛ transmission 02 · the languages',
    h1: 'qualia speaks three tongues',
    rows: [
      { k: 'lang', t: 'strudel', d: 'patterns → sound · TidalCycles, in the browser' },
      { k: 'code', t: 's("bd ~ sd ~").bank("tr909").fast(2)' },
      { k: 'gap' },
      { k: 'lang', t: 'hydra', d: 'video synthesis · pixels fed back on themselves' },
      { k: 'code', t: 'osc(10, .1, .8).kaleid(4).out()' },
      { k: 'gap' },
      { k: 'lang', t: 'qualia', d: 'web audio + webgl · the field binding them' },
      { k: 'code', t: 'qualia.setParam("galaxy", "bloom", .8)' },
    ],
    qr: false,
  },
  entangle: {
    kicker: '⊛ transmission 03 · entanglement',
    h1: 'bend the field',
    rows: [
      { k: 'body', t: 'scan to join — your phone becomes a sensor.' },
      { k: 'body', t: 'your motion feeds the visuals. no app, no login.' },
      { k: 'body', t: 'your camera never leaves your phone.' },
    ],
    qr: true,
  },
  signal: {
    kicker: '⊛ transmission 04 · the signal',
    h1: 'voidstar.sh',
    rows: [
      { k: 'body', t: 'the whole instrument lives at this address —' },
      { k: 'body', t: 'open it, play it, break it. code it.' },
    ],
    qr: true,
  },
};

const NUM_STARS = 140;

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'liner_notes',
  name: 'Liner Notes',
  contextType: 'canvas2d',

  params: [
    { id: 'page', label: 'page', type: 'select',
      options: ['livecoding', 'languages', 'entangle', 'signal'], default: 'livecoding' },
    { id: 'qrTarget', label: 'qr target', type: 'select',
      options: ['auto', 'entangle', 'qualia', 'custom'], default: 'auto' },
    { id: 'customUrl', label: 'custom url', type: 'text',
      placeholder: 'https://…', default: '' },
    { id: 'footer', label: 'footer', type: 'text',
      placeholder: 'voidstar.sh — what it’s like', default: '' },
    { id: 'typeSpeed', label: 'type speed', type: 'range',
      min: 0.2, max: 4, step: 0.1, default: 1.4,
      modulators: [{ source: 'audio.highs', mode: 'mul', amount: 0.5 }] },
    { id: 'qrSize', label: 'qr size', type: 'range',
      min: 0.30, max: 0.75, step: 0.01, default: 0.48 },
    { id: 'palette', label: 'palette', type: 'select',
      options: ['voidblue', 'violet', 'phosphor', 'amber'], default: 'voidblue' },
    { id: 'reactivity', label: 'reactivity', type: 'range',
      min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  // In the auto-phase / auto-cycle rotation this walks the four transmissions
  // — so with cycle running, the QR card periodically surfaces on its own.
  autoPhase: {
    steps: [
      { page: 'livecoding' },
      { page: 'languages' },
      { page: 'entangle' },
      { page: 'signal' },
    ],
  },

  presets: {
    default:       { page: 'livecoding', qrTarget: 'auto', customUrl: '', footer: '', typeSpeed: 1.4, qrSize: 0.48, palette: 'voidblue', reactivity: 1.0 },
    entangle_card: { page: 'entangle', qrTarget: 'entangle', qrSize: 0.58 },
    site_card:     { page: 'signal', qrTarget: 'qualia', qrSize: 0.58 },
    manifesto:     { page: 'livecoding', typeSpeed: 0.8, palette: 'phosphor' },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // Starfield — normalized coords, re-projected per frame.
    const stars = new Float32Array(NUM_STARS * 4);   // x, y, depth, twinkle-phase
    for (let i = 0; i < NUM_STARS; i++) {
      stars[i * 4]     = Math.random();
      stars[i * 4 + 1] = Math.random();
      stars[i * 4 + 2] = 0.3 + Math.random() * 0.7;
      stars[i * 4 + 3] = Math.random() * Math.PI * 2;
    }

    // Scanline pattern — rebuilt on resize, blitted with low alpha.
    let scanPat = null;
    function buildScanlines() {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 4;
      const x = c.getContext('2d');
      x.fillStyle = '#000';
      x.fillRect(0, 0, 8, 2);
      scanPat = ctx.createPattern(c, 'repeat');
    }
    buildScanlines();

    // Typewriter state — page-scoped elapsed "characters typed".
    let typed = 0;
    let lastPage = null;

    // ── QR cache — regenerated when url / size-bucket / palette changes. ────
    const qr = { key: '', canvas: null, pending: null, failed: false, url: '' };
    let urlCheckAt = 0;      // recheck the pinned code every couple seconds
    let resolvedUrl = '';
    let resolvedNote = '';

    function resolveUrl(params) {
      const target = params.qrTarget;
      if (target === 'custom' && params.customUrl) return { url: params.customUrl.trim(), note: '' };
      const site = `${location.origin}/qualia`;
      if (target === 'qualia') return { url: site, note: '' };
      // 'entangle' and 'auto': the printed performance code, if one exists.
      const room = readRoomFromQuery() || getPinnedRoom();
      if (room) return { url: buildJoinUrl(room), note: `code · ${room}` };
      return {
        url: site,
        note: target === 'entangle' ? 'no saved code — open ⊛ entangle & save one' : '',
      };
    }

    function ensureQR(pal, params) {
      const px = Math.max(160, Math.round(Math.min(W, H) * params.qrSize / 64) * 64);
      const key = `${resolvedUrl}|${px}|${params.palette}`;
      if (key === qr.key || !resolvedUrl) return;
      qr.key = key;
      qr.pending = key;
      qr.failed = false;
      import('../qr.js')
        .then(m => m.artisticQRCanvas(resolvedUrl, px / 2, {
          dark: pal.text, light: '#05050d', accent: pal.accent,
        }))
        .then(c => { if (qr.pending === key) { qr.canvas = c; qr.url = resolvedUrl; qr.pending = null; } })
        .catch(() => { if (qr.pending === key) { qr.failed = true; qr.pending = null; } });
    }

    const scratch = {
      time: 0, bass: 0, highs: 0, beatPulse: 0, midsPulse: 0, beatActive: false,
      page: 'livecoding', palette: 'voidblue', footer: '', typed: 0,
      qrFrac: 0.48, note: '',
    };

    function update(field) {
      const params = field.params;
      const audio = scaleAudio(field.audio, params.reactivity);

      const page = PAGES.includes(params.page) ? params.page : 'livecoding';
      if (page !== lastPage) { lastPage = page; typed = 0; }

      // Characters per second — typeSpeed is already highs-modulated.
      typed += field.dt * 26 * Math.max(0.05, params.typeSpeed);

      scratch.time       = field.time;
      scratch.bass       = audio.bands.bass;
      scratch.highs      = audio.bands.highs;
      scratch.beatPulse  = audio.beat.pulse;
      scratch.midsPulse  = audio.mids.pulse;
      scratch.beatActive = audio.beat.active;
      scratch.page       = page;
      scratch.palette    = PALETTES[params.palette] ? params.palette : 'voidblue';
      scratch.footer     = (params.footer || '').trim();
      scratch.typed      = typed;
      scratch.qrFrac     = params.qrSize;

      // QR upkeep — cheap string compare per frame; real work only on change.
      if (CONTENT[page].qr) {
        if (field.time > urlCheckAt) {
          urlCheckAt = field.time + 2;
          const r = resolveUrl(params);
          resolvedUrl = r.url; resolvedNote = r.note;
        }
        scratch.note = resolvedNote;
        ensureQR(PALETTES[scratch.palette], params);
      }
    }

    function render() {
      const pal = PALETTES[scratch.palette];
      const t = scratch.time;
      const m = Math.min(W, H);

      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);

      // ── Starfield ────────────────────────────────────────────────────────
      const twAmp = 0.45 + scratch.highs * 0.55;
      ctx.fillStyle = pal.text;
      for (let i = 0; i < NUM_STARS; i++) {
        const z = stars[i * 4 + 2];
        const x = ((stars[i * 4] + t * 0.004 * z) % 1) * W;
        const y = stars[i * 4 + 1] * H;
        const tw = 0.5 + 0.5 * Math.sin(t * 1.3 + stars[i * 4 + 3]);
        ctx.globalAlpha = (0.08 + 0.30 * tw * twAmp) * z;
        const r = z * (1.2 + scratch.bass * 1.4) * (m / 1080);
        ctx.fillRect(x, y, r, r);
      }
      ctx.globalAlpha = 1;

      const page = CONTENT[scratch.page];
      const cx = W / 2;
      const fs = m / 1080;                  // font scale vs a 1080 short side
      const mono = (px, wt = 400) =>
        `${wt} ${Math.round(px)}px "JetBrains Mono", "Cascadia Code", "Fira Code", "Menlo", "Consolas", monospace`;

      // Vertical layout: measure content height first, then centre it.
      const hasQR = page.qr;
      const qrPx = hasQR ? Math.round(m * scratch.qrFrac) : 0;
      const lineH = Math.round(44 * fs);
      const rowH = (r) => r.k === 'gap' ? lineH * 0.5 : r.k === 'lang' ? lineH * 1.15 : lineH;
      let contentH = 120 * fs + 86 * fs;    // kicker + h1 blocks
      for (const r of page.rows) contentH += rowH(r);
      if (hasQR) contentH += qrPx + 90 * fs;
      // Min top margin clears the topbar on short viewports (zen hides it,
      // but the card should read correctly with chrome up too).
      let y = Math.max(H * 0.12, (H - contentH) / 2);

      // Kicker chip — flickers a touch on snares.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = mono(26 * fs, 600);
      ctx.fillStyle = pal.accent;
      ctx.globalAlpha = 0.75 + scratch.midsPulse * 0.25;
      ctx.fillText(page.kicker.toUpperCase(), cx, y + 26 * fs);
      ctx.globalAlpha = 1;
      y += 74 * fs;

      // Heading + beat-pulsed underline glow.
      ctx.font = mono(64 * fs, 700);
      ctx.fillStyle = pal.text;
      ctx.shadowColor = pal.accent;
      ctx.shadowBlur = (10 + scratch.beatPulse * 26 + scratch.bass * 8) * fs;
      ctx.fillText(page.h1, cx, y + 60 * fs);
      ctx.shadowBlur = 0;
      const uw = (ctx.measureText(page.h1).width * (0.55 + scratch.beatPulse * 0.45));
      ctx.strokeStyle = pal.accent2;
      ctx.globalAlpha = 0.5 + scratch.beatPulse * 0.5;
      ctx.lineWidth = Math.max(1.5, 3 * fs);
      ctx.beginPath();
      ctx.moveTo(cx - uw / 2, y + 82 * fs);
      ctx.lineTo(cx + uw / 2, y + 82 * fs);
      ctx.stroke();
      ctx.globalAlpha = 1;
      y += 132 * fs;

      // ── Rows, typewriter-revealed in reading order ───────────────────────
      let budget = scratch.typed;
      const cursorOn = (Math.floor(t * 2.4) % 2 === 0) || scratch.beatActive;
      for (const r of page.rows) {
        if (r.k === 'gap') { y += rowH(r); continue; }
        const text = r.k === 'lang' ? `${r.t} — ${r.d}` : r.t;
        if (budget <= 0) break;
        const shown = budget >= text.length ? text : text.slice(0, Math.floor(budget));
        const typing = budget < text.length;
        if (r.k === 'code') {
          ctx.font = mono(30 * fs, 500);
          ctx.fillStyle = pal.code;
          const w = ctx.measureText(text).width;
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = pal.accent;
          ctx.fillRect(cx - w / 2 - 18 * fs, y - 2 * fs, w + 36 * fs, lineH * 0.92);
          ctx.globalAlpha = 1;
          ctx.fillStyle = pal.code;
          ctx.fillText(shown + (typing && cursorOn ? '▮' : ''), cx, y + 28 * fs);
        } else if (r.k === 'lang') {
          ctx.font = mono(34 * fs, 700);
          const nameW = ctx.measureText(r.t).width;
          ctx.font = mono(28 * fs, 400);
          const descShown = shown.length > r.t.length ? shown.slice(r.t.length) : '';
          const descW = ctx.measureText(` — ${r.d}`).width;
          const x0 = cx - (nameW + descW) / 2;
          ctx.font = mono(34 * fs, 700);
          ctx.textAlign = 'left';
          ctx.fillStyle = pal.accent2;
          ctx.fillText(shown.slice(0, Math.min(shown.length, r.t.length)), x0, y + 30 * fs);
          if (descShown) {
            ctx.font = mono(28 * fs, 400);
            ctx.fillStyle = pal.dim;
            ctx.fillText(descShown + (typing && cursorOn ? '▮' : ''), x0 + nameW, y + 30 * fs);
          }
          ctx.textAlign = 'center';
        } else {
          ctx.font = mono(32 * fs, 400);
          ctx.fillStyle = pal.text;
          ctx.fillText(shown + (typing && cursorOn ? '▮' : ''), cx, y + 28 * fs);
        }
        budget -= text.length;
        y += rowH(r);
      }

      // ── QR block ─────────────────────────────────────────────────────────
      if (hasQR) {
        y += 24 * fs;
        const breathe = 1 + scratch.beatPulse * 0.015;   // ≤2% — stays scannable
        const size = qrPx * breathe;
        const qx = cx - size / 2, qy = y;
        if (qr.canvas) {
          ctx.save();
          ctx.shadowColor = pal.accent;
          ctx.shadowBlur = (18 + scratch.bass * 30) * fs;
          ctx.drawImage(qr.canvas, qx, qy, size, size);
          ctx.restore();
        } else {
          // Loading / offline — dashed portal ring + the raw URL, so the
          // card still works with no CDN reachable.
          ctx.strokeStyle = pal.accent;
          ctx.lineWidth = 3 * fs;
          ctx.setLineDash([12 * fs, 10 * fs]);
          ctx.beginPath();
          ctx.arc(cx, qy + qrPx / 2, qrPx * 0.42, t * 0.8, t * 0.8 + Math.PI * 1.7);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = mono(30 * fs, 500);
          ctx.fillStyle = pal.text;
          ctx.fillText(qr.failed ? (qr.url || resolvedUrl) : 'summoning code…', cx, qy + qrPx / 2 + 10 * fs);
        }
        y += qrPx + 52 * fs;
        ctx.font = mono(28 * fs, 500);
        ctx.fillStyle = pal.accent;
        ctx.fillText(resolvedUrl.replace(/^https?:\/\//, ''), cx, y);
        if (scratch.note) {
          y += 34 * fs;
          ctx.font = mono(22 * fs, 400);
          ctx.fillStyle = pal.dim;
          ctx.fillText(scratch.note, cx, y);
        }
      }

      // Footer.
      ctx.font = mono(24 * fs, 400);
      ctx.fillStyle = pal.dim;
      ctx.globalAlpha = 0.85;
      ctx.fillText(scratch.footer || 'voidstar.sh — what it’s like', cx, H - Math.max(28 * fs, m * 0.035));
      ctx.globalAlpha = 1;

      // ── CRT scanlines, slow vertical roll ────────────────────────────────
      if (scanPat) {
        ctx.globalAlpha = 0.10;
        ctx.fillStyle = scanPat;
        ctx.save();
        ctx.translate(0, (t * 8) % 4);
        ctx.fillRect(0, -4, W, H + 8);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; buildScanlines(); qr.key = ''; },
      update,
      render,
      dispose() { qr.canvas = null; qr.pending = null; },
    };
  },
};
