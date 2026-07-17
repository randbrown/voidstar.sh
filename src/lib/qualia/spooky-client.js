// Spooky — the phone controller client. Runs on /lab/spooky (the performer's
// own phone; the join QR carries the room + control token in the URL
// fragment). Loads NONE of the viz engine — like the entangle client, it's a
// thin control surface over the relay.
//
// The pad mirrors the DOIO KB16 keymap's action surface (same action ids —
// one shared dispatch map on the host, so keystrokes / MIDI / spooky never
// drift), organized into thumb-sized tabs:
//   RIG   — freeze stack, drives, strip toggles, rig/delay/reverb sliders
//   LOOP  — looper transport + grab, vox mute, pause
//   SEQ   — strudel/sequencer transport, tempo, live drum pads (tap to play;
//           arm ⏺ write to also quantize the hit into the pattern grid)
//   QUALE — visual navigation: quale/phase steps, camera, blackout
//
// Everything is best-effort: a dropped leader or rejected token must never
// hard-crash the page.

import { createTransport } from './entangle-transport-cf.js';
import { SYNC_APP_ID, ST, readControlFromHash } from './sync-protocol.js';

const SLIDER_DEBOUNCE_MS = 40;

const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };

export async function initSpookyClient(root) {
  const { room, key } = readControlFromHash();
  const statusEl = root.querySelector('[data-status]');
  const tabsEl = root.querySelector('[data-tabs]');
  const bodyEl = root.querySelector('[data-body]');
  const setStatus = (msg, kind = '') => { if (statusEl) { statusEl.textContent = msg; statusEl.dataset.kind = kind; } };

  if (!room || !key) {
    setStatus('This link is missing the room or control token — re-scan the spooky QR from the sync panel.', 'err');
    return;
  }

  setStatus('Reaching across the void…');
  let transport;
  try {
    transport = await createTransport({ appId: SYNC_APP_ID, room, role: 'participant' });
  } catch (err) {
    console.error('[spooky] transport failed', err);
    setStatus('Could not connect. Check your network and reload.', 'err');
    return;
  }

  // ── Connection / auth handshake ───────────────────────────────────────────
  let welcomed = false, denied = false;
  const hello = () => { if (denied) return; try { transport.send(ST.CHELLO, { k: key }); } catch {} };
  const connectTimer = setTimeout(() => {
    if (!welcomed && !denied) setStatus("Couldn't reach the leader — is the sync room open? Reload to retry.", 'err');
  }, 20000);
  // Re-announce on EVERY peer (re)appearance — a leader page reload wipes its
  // authenticated-controllers set, and only a fresh chello re-authorizes us.
  transport.onPeer(() => hello());
  transport.onLeave(() => { if (welcomed) setStatus('Leader vanished — waiting for it to return…', 'err'); });
  hello();

  transport.on(ST.CWELC, (m) => {
    if (!m || typeof m !== 'object') return;
    if (!m.ok) {
      denied = true;
      clearTimeout(connectTimer);
      setStatus('Control token rejected — grab a fresh QR from the sync panel.', 'err');
      return;
    }
    if (!welcomed) {
      welcomed = true;
      clearTimeout(connectTimer);
      setStatus('⌁ spooky action engaged', 'ok');
      render();
    } else {
      setStatus('⌁ spooky action engaged', 'ok');
    }
  });

  // ── Host state (drives lit buttons + drum pads) ───────────────────────────
  let state = {
    cps: null, strudelPlaying: false, seqPlaying: false, loopPlaying: false,
    recording: false, freezeDepth: 0, quale: '', voices: [], grid: null,
  };
  transport.on(ST.CSTATE, (s) => {
    if (!s || typeof s !== 'object') return;
    const voicesChanged = JSON.stringify(s.voices || []) !== JSON.stringify(state.voices || []);
    state = { ...state, ...s };
    if (voicesChanged) renderBody();     // pad grid shape changed → rebuild
    else reflect();                       // just repaint lit states / readouts
  });
  transport.on(ST.CLOCK, (b) => {
    if (b && b.cps > 0) { state.cps = b.cps; state.strudelPlaying = !!b.playing; reflect(); }
  });

  window.addEventListener('pagehide', () => { try { transport.send(ST.SBYE, 1); } catch {} });

  // ── Send helpers ──────────────────────────────────────────────────────────
  const act = (a) => { buzz(); try { transport.send(ST.CTL, { k: key, a }); } catch {} };
  const sliderTimers = new Map();
  const slide = (s, v) => {
    clearTimeout(sliderTimers.get(s));
    sliderTimers.set(s, setTimeout(() => { try { transport.send(ST.CTL, { k: key, s, v }); } catch {} }, SLIDER_DEBOUNCE_MS));
  };
  const tap = (voice) => {
    buzz(12);
    try { transport.send(ST.CTL, { k: key, hit: voice, w: writeArmed ? 1 : 0 }); } catch {}
  };

  // ── UI ────────────────────────────────────────────────────────────────────
  let tab = 'rig';
  let writeArmed = false;
  const TABS = [
    { id: 'rig',   label: '⚡ rig' },
    { id: 'loop',  label: '◉ loop' },
    { id: 'seq',   label: '▦ seq' },
    { id: 'quale', label: '✦ quale' },
  ];

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function padBtn(label, action, opts = {}) {
    const b = el('button', 'sp-pad' + (opts.cls ? ` ${opts.cls}` : ''), label);
    if (opts.sub) { b.textContent = ''; b.append(el('span', 'sp-pad-main', label), el('span', 'sp-pad-sub', opts.sub)); }
    b.addEventListener('click', () => act(action));
    if (opts.lit) b.dataset.lit = opts.lit;   // reflect() keys off this
    return b;
  }
  function sliderRow(label, id, min, max, step, start, fmt = (v) => (+v).toFixed(2)) {
    const wrap = el('div', 'sp-slider');
    const labRow = el('div', 'sp-slabel');
    const val = el('span', 'sp-sval', fmt(start));
    labRow.append(el('span', null, label), val);
    const input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = start;
    input.addEventListener('input', () => {
      val.textContent = fmt(input.value);
      slide(id, parseFloat(input.value));
    });
    wrap.append(labRow, input);
    return wrap;
  }
  function grid(cols, ...children) {
    const g = el('div', 'sp-grid');
    g.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    g.append(...children);
    return g;
  }

  function render() {
    if (!tabsEl || !bodyEl) return;
    tabsEl.innerHTML = '';
    for (const t of TABS) {
      const b = el('button', 'sp-tab' + (tab === t.id ? ' on' : ''), t.label);
      b.addEventListener('click', () => { tab = t.id; buzz(); render(); });
      tabsEl.appendChild(b);
    }
    renderBody();
  }

  function renderBody() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';

    if (tab === 'rig') {
      bodyEl.append(
        el('h3', 'sp-h', 'freeze stack'),
        grid(2,
          padBtn('❄ frz', 'freeze', { lit: 'freeze', sub: 'grab + layer' }),
          padBtn('pop', 'freezePop', { sub: 'release top' })),
        grid(2,
          padBtn('re-grab', 'freezeRegrab', { sub: 'replace top' }),
          padBtn('clear', 'freezeClear', { cls: 'warn', sub: 'drop stack' })),
        el('h3', 'sp-h', 'drives & strip'),
        grid(3,
          padBtn('earth', 'earth', { sub: 'drive' }),
          padBtn('metal', 'metal', { sub: 'zone' }),
          padBtn('tuner', 'tuner', { sub: 'toggle' }),
          padBtn('delay', 'delayToggle', { sub: 'on / off' }),
          padBtn('reverb', 'reverbToggle', { sub: 'on / off' }),
          padBtn('⏸ pause', 'pause', { cls: 'warn', sub: 'all audio' })),
        el('h3', 'sp-h', 'levels'),
        sliderRow('rig master', 'rig.level', 0, 1.5, 0.01, 1),
        sliderRow('delay mix', 'delay.mix', 0, 1, 0.01, 0.3),
        sliderRow('reverb mix', 'reverb.mix', 0, 1, 0.01, 0.3),
        el('div', 'sp-note', 'sliders send absolute values — like MIDI CC knobs'),
      );
    } else if (tab === 'loop') {
      bodyEl.append(
        el('h3', 'sp-h', 'looper transport'),
        grid(2,
          padBtn('▶ ■ loop', 'loopPlayStop', { lit: 'loop', sub: 'play / stop' }),
          padBtn('⧉ grab', 'grab', { sub: 'retro-loop' })),
        grid(2,
          padBtn('⏺ rec', 'recStart', { lit: 'rec', sub: 'start' }),
          padBtn('⏹ rec', 'recStop', { sub: 'stop' })),
        el('h3', 'sp-h', 'vox / transport'),
        grid(2,
          padBtn('vox', 'voxMute', { sub: 'mute / live' }),
          padBtn('⏸ pause', 'pause', { cls: 'warn', sub: 'all audio' })),
      );
    } else if (tab === 'seq') {
      const cpsWrap = el('div', 'sp-cps');
      cpsWrap.append(el('span', 'sp-cps-label', 'cps'), el('b', 'sp-cps-val', '—'));
      const cpsSlider = document.createElement('input');
      cpsSlider.type = 'range'; cpsSlider.min = '0.2'; cpsSlider.max = '2'; cpsSlider.step = '0.01';
      cpsSlider.value = String(state.cps || 0.5);
      cpsSlider.dataset.cps = '1';
      cpsSlider.addEventListener('input', () => {
        slide('cps', parseFloat(cpsSlider.value));
        const v = bodyEl.querySelector('.sp-cps-val');
        if (v) v.textContent = (+cpsSlider.value).toFixed(2);
      });

      const writeBtn = el('button', 'sp-pad sp-write', '⏺ write taps into pattern');
      writeBtn.classList.toggle('armed', writeArmed);
      writeBtn.addEventListener('click', () => {
        writeArmed = !writeArmed;
        writeBtn.classList.toggle('armed', writeArmed);
        buzz(15);
      });

      const padsGrid = el('div', 'sp-drums');
      const voices = state.voices || [];
      if (!voices.length) {
        padsGrid.append(el('div', 'sp-empty', 'no pattern pads yet — open the sequencer on the rig'));
      } else {
        for (const v of voices) {
          const d = el('button', 'sp-drum', v.voice);
          if (v.mute) d.classList.add('muted');
          // pointerdown, not click — a drum pad has to fire on touch, not release.
          d.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(v.voice); d.classList.add('hit'); });
          d.addEventListener('pointerup',   () => d.classList.remove('hit'));
          d.addEventListener('pointerleave',() => d.classList.remove('hit'));
          padsGrid.appendChild(d);
        }
      }

      bodyEl.append(
        el('h3', 'sp-h', 'transport'),
        grid(2,
          padBtn('strudel', 'strudelPlayStop', { lit: 'strudel', sub: 'play / stop' }),
          padBtn('seq', 'seqPlayStop', { lit: 'seq', sub: 'play / stop' })),
        el('h3', 'sp-h', 'tempo'),
        cpsWrap, cpsSlider,
        el('h3', 'sp-h', 'drum pads'),
        writeBtn,
        padsGrid,
        el('div', 'sp-note', writeArmed
          ? 'taps sound AND land on the nearest grid cell while the sequencer plays'
          : 'taps just sound — arm ⏺ write to record them into the pattern'),
      );
    } else if (tab === 'quale') {
      bodyEl.append(
        el('h3', 'sp-h', 'now showing'),
        el('div', 'sp-quale-name', state.quale || '—'),
        el('h3', 'sp-h', 'navigate'),
        grid(2,
          padBtn('◀ quale', 'qualePrev', { sub: 'previous visual' }),
          padBtn('quale ▶', 'qualeNext', { sub: 'next visual' }),
          padBtn('◀ phase', 'phasePrev', { sub: 'step back' }),
          padBtn('phase ▶', 'phaseNext', { sub: 'step forward' })),
        el('h3', 'sp-h', 'stage'),
        grid(3,
          padBtn('cam ▶', 'camNext', { sub: 'next device' }),
          padBtn('⏸ pause', 'pause', { cls: 'warn', sub: 'all audio' }),
          padBtn('☾ dark', 'blackout', { cls: 'warn', sub: 'blackout' })),
      );
    }
    reflect();
  }

  // Repaint lit states + readouts from the latest host state (no rebuild).
  function reflect() {
    if (!bodyEl) return;
    for (const b of bodyEl.querySelectorAll('[data-lit]')) {
      const kind = b.dataset.lit;
      const on = kind === 'strudel' ? state.strudelPlaying
        : kind === 'seq'    ? state.seqPlaying
        : kind === 'loop'   ? state.loopPlaying
        : kind === 'rec'    ? state.recording
        : kind === 'freeze' ? state.freezeDepth > 0
        : false;
      b.classList.toggle('lit', !!on);
      if (kind === 'freeze') {
        const d = state.freezeDepth | 0;
        const label = d > 1 ? `❄ frz${'²³⁴⁵⁶⁷⁸⁹'[Math.min(d, 9) - 2] || `×${d}`}` : '❄ frz';
        // Pads with a sub-label keep it — only the main span changes.
        const main = b.querySelector('.sp-pad-main');
        if (main) main.textContent = label; else b.textContent = label;
      }
    }
    const cpsVal = bodyEl.querySelector('.sp-cps-val');
    if (cpsVal && state.cps) cpsVal.textContent = (+state.cps).toFixed(2);
    const cpsSlider = bodyEl.querySelector('[data-cps]');
    if (cpsSlider && state.cps && document.activeElement !== cpsSlider) cpsSlider.value = String(state.cps);
    const qn = bodyEl.querySelector('.sp-quale-name');
    if (qn) qn.textContent = state.quale || '—';
  }

  render();
}
