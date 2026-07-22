// Tether — the phone remote-control client. Runs on /lab/tether (the
// performer's own phone; the join QR carries the room + control token in the
// URL fragment). Loads NONE of the viz engine — like the entangle client,
// it's a thin RC transceiver over the relay.
//
// The pad mirrors the DOIO KB16 keymap's action surface (same action ids —
// one shared dispatch map on the host, so keystrokes / MIDI / tether never
// drift), organized into thumb-sized tabs:
//   RIG   — freeze stack, drives, strip toggles, rig/delay/reverb sliders
//   LOOP  — looper transport + grab, vox mute, pause
//   SEQ   — strudel/sequencer transport, tempo, live drum pads (tap to play;
//           arm ⏺ write to also quantize the hit into the pattern grid),
//           undo/redo/clear over the pattern edits
//   QUALE — visual navigation: quale/phase steps, auto-cycle/phase/walk
//           toggles, the set clock (τ + reset), camera, blackout
//
// Everything is best-effort: a dropped leader or rejected token must never
// hard-crash the page.

import { createTransport } from './entangle-transport-cf.js';
import { SYNC_APP_ID, ST, readControlFromHash } from './sync-protocol.js';

const SLIDER_DEBOUNCE_MS = 40;
// Press-and-hold duration for the deliberate-confirmation chips (slider ↺
// resets, the ⏻ re-arm). Module scope, NOT inside initTetherClient: the ⏻
// chip is wired before the no-creds early return, so a function-scoped const
// after that return would never initialize on an unlinked launch (TDZ throw
// on the first tap).
const HOLD_RESET_MS = 400;
// Pairing memory — the room + control token from the last scanned QR. This is
// what lets tether run as an INSTALLED app: a home-screen launch starts at the
// bare /lab/tether (no URL fragment), and reconnects from here. A newly
// scanned QR always overwrites it (fresh room = rotated token).
const CREDS_KEY = 'voidstar.tether.creds';
// Pre-rename pairing memory — phones paired while the page was still called
// "spooky" keep their room without a re-scan.
const LEGACY_CREDS_KEY = 'voidstar.spooky.creds';

const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };

export async function initTetherClient(root) {
  let { room, key } = readControlFromHash();
  if (room && key) {
    try { localStorage.setItem(CREDS_KEY, JSON.stringify({ room, key })); } catch {}
  } else {
    try {
      const c = JSON.parse(localStorage.getItem(CREDS_KEY) || localStorage.getItem(LEGACY_CREDS_KEY));
      if (c?.room && c?.key) ({ room, key } = c);
    } catch {}
  }
  const statusEl = root.querySelector('[data-status]');
  const tabsEl = root.querySelector('[data-tabs]');
  const bodyEl = root.querySelector('[data-body]');
  // The pill is a fixed one-liner ("livecoding station transceiver …") — the
  // full text also lands in title for the rare viewport that ellipsizes it.
  const setStatus = (msg, kind = '') => {
    if (statusEl) { statusEl.textContent = msg; statusEl.title = msg; statusEl.dataset.kind = kind; }
  };
  // Longer guidance goes UNDER the pill, not in it (the pill never wraps).
  // Pre-connection only — the first render() wipes bodyEl.
  const setHint = (msg) => {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    if (msg) bodyEl.append(el('div', 'sp-note', msg));
  };

  // ── Screen wake lock — a stage remote must not dim mid-set ────────────────
  // The OS releases the lock whenever the page hides; re-request on every
  // return to visible. Best-effort everywhere (iOS < 16.4 has no API).
  const holdAwake = async () => {
    try { await navigator.wakeLock?.request('screen'); } catch {}
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') holdAwake();
  });
  holdAwake();

  // ── ⏻ deactivate ("pocket lock") ──────────────────────────────────────────
  // Tap the chip in the status row to deactivate the whole pad: the send
  // helpers go inert and the UI dims (CSS also kills pointer events, so
  // nothing even flashes). Re-arming takes a deliberate ~0.4 s hold — same
  // fill-sweep idiom as the slider ↺ chips — because a pocket can tap but
  // can't hold steady. Not persisted: a fresh launch always starts live.
  let padsLive = true;
  const holdBtn = root.querySelector('[data-hold]');
  const holdNote = root.querySelector('[data-holdnote]');
  const setPadsLive = (on) => {
    padsLive = on;
    root.classList.toggle('deactivated', !on);
    if (holdBtn) {
      holdBtn.textContent = on ? '⏻ live' : '⏻ held';
      holdBtn.title = on ? 'tap to deactivate the pad' : 'hold to re-arm';
      holdBtn.classList.toggle('off', !on);
    }
    if (holdNote) holdNote.hidden = on;
    buzz(on ? 20 : 10);
  };
  if (holdBtn) {
    let armT = null;
    const cancelArm = () => { clearTimeout(armT); armT = null; holdBtn.classList.remove('holding'); };
    holdBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (padsLive) { setPadsLive(false); return; }   // locking is instant
      try { holdBtn.setPointerCapture(e.pointerId); } catch {}
      holdBtn.classList.add('holding');
      armT = setTimeout(() => { cancelArm(); setPadsLive(true); }, HOLD_RESET_MS);
    });
    holdBtn.addEventListener('pointerup', cancelArm);
    holdBtn.addEventListener('pointercancel', cancelArm);
  }

  // Browser-tab fullscreen toggle. Hidden when running as the installed app
  // (display-mode fullscreen/standalone) — there's no chrome to shed there.
  const fsBtn = document.createElement('button');
  fsBtn.className = 'sp-fs';
  fsBtn.title = 'fullscreen';
  fsBtn.textContent = '⛶';
  fsBtn.addEventListener('click', () => {
    buzz();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  });
  document.body.appendChild(fsBtn);

  // "Install app" chip — Chrome fires beforeinstallprompt only in a browser
  // tab when the app isn't installed yet, so the chip is the one-tap path to
  // the home-screen install (manifest-tether.webmanifest — tether is its own
  // PWA). The installed app never sees the event, so the chip never shows
  // there; iOS Safari has no such event and keeps its manual share-sheet path.
  let installEvt = null;
  const installBtn = document.createElement('button');
  installBtn.className = 'sp-install';
  installBtn.textContent = '⤓ install app';
  installBtn.style.display = 'none';
  installBtn.addEventListener('click', () => {
    buzz();
    const evt = installEvt;
    installEvt = null;
    installBtn.style.display = 'none';
    try { evt?.prompt?.(); } catch {}
  });
  document.body.appendChild(installBtn);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();   // suppress Chrome's mini-infobar; the chip owns the moment
    installEvt = e;
    installBtn.style.display = '';
  });
  window.addEventListener('appinstalled', () => {
    installEvt = null;
    installBtn.style.display = 'none';
  });

  if (!room || !key) {
    setStatus('livecoding station transceiver (unlinked)', 'err');
    setHint('no room / control token yet — scan the tether QR from the rig’s ⌁ sync panel; once paired, this page remembers the room');
    return;
  }

  setStatus('livecoding station transceiver (linking…)');
  let transport;
  try {
    transport = await createTransport({ appId: SYNC_APP_ID, room, role: 'participant' });
  } catch (err) {
    console.error('[tether] transport failed', err);
    setStatus('livecoding station transceiver (offline)', 'err');
    setHint('could not connect — check your network and reload');
    return;
  }

  // ── Connection / auth handshake ───────────────────────────────────────────
  let welcomed = false, denied = false;
  const hello = () => { if (denied) return; try { transport.send(ST.CHELLO, { k: key }); } catch {} };
  const connectTimer = setTimeout(() => {
    if (!welcomed && !denied) {
      setStatus('livecoding station transceiver (no leader)', 'err');
      setHint('couldn’t reach the leader — is the sync room open on the rig? reload to retry');
    }
  }, 20000);
  // Re-announce on EVERY peer (re)appearance — a leader page reload wipes its
  // authenticated-controllers set, and only a fresh chello re-authorizes us.
  transport.onPeer(() => hello());
  transport.onLeave(() => { if (welcomed) setStatus('livecoding station transceiver (link lost)', 'err'); });
  hello();

  transport.on(ST.CWELC, (m) => {
    if (!m || typeof m !== 'object') return;
    if (!m.ok) {
      denied = true;
      clearTimeout(connectTimer);
      setStatus('livecoding station transceiver (link denied)', 'err');
      setHint('control token rejected — grab a fresh tether QR from the rig’s ⌁ sync panel');
      return;
    }
    if (!welcomed) {
      welcomed = true;
      clearTimeout(connectTimer);
      setStatus('livecoding station transceiver link active', 'ok');
      render();
    } else {
      setStatus('livecoding station transceiver link active', 'ok');
    }
  });

  // ── Host state (drives lit buttons + drum pads) ───────────────────────────
  let state = {
    cps: null, strudelPlaying: false, seqPlaying: false, loopPlaying: false,
    recording: false, freezeDepth: 0, quale: '', voices: [], grid: null,
    tapUndoDepth: 0, tapRedoDepth: 0,
    walkOn: false, autoCycleOn: false, autoPhaseOn: false,
    earthOn: false, metalOn: false, delayOn: false, reverbOn: false,
    tunerOn: false, paused: false, voxMuted: false, blackoutOn: false,
    tau: null, horizonMin: 0,
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
  // Every outbound control rides one of these three, so the ⏻ deactivate
  // guard here locks the entire pad at the source (no relay traffic).
  const act = (a) => { if (!padsLive) return; buzz(); try { transport.send(ST.CTL, { k: key, a }); } catch {} };
  const sliderTimers = new Map();
  const slide = (s, v) => {
    if (!padsLive) return;
    clearTimeout(sliderTimers.get(s));
    sliderTimers.set(s, setTimeout(() => { try { transport.send(ST.CTL, { k: key, s, v }); } catch {} }, SLIDER_DEBOUNCE_MS));
  };
  const tap = (voice) => {
    if (!padsLive) return;
    buzz(12);
    try { transport.send(ST.CTL, { k: key, hit: voice, w: writeArmed ? 1 : 0 }); } catch {}
    // Optimistic history depth — a written tap is undoable (and clears redo)
    // the moment it lands; the next cstate snapshot corrects any miss.
    if (writeArmed && state.seqPlaying) {
      state.tapUndoDepth += 1;
      state.tapRedoDepth = 0;
      reflect();
    }
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
    // Optimistic toggle — flip the local guess so the pad lights on tap; the
    // host's cstate echo (~120 ms) corrects any miss.
    if (opts.flip) b.addEventListener('click', () => { state[opts.flip] = !state[opts.flip]; reflect(); });
    return b;
  }
  // Hold-to-reset chip — press and hold ~0.4 s (HOLD_RESET_MS) to snap a
  // slider back to its default; the fill sweep is the confirmation, lifting
  // early cancels. Replaced the old double-tap: a deliberate hold on a
  // separate target can't be grazed mid-set the way a tap on the slider
  // itself could.
  function holdReset(title, onReset) {
    const b = el('button', 'sp-reset', '↺');
    b.title = title;
    let t = null;
    const cancel = () => { clearTimeout(t); t = null; b.classList.remove('holding'); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // Capture so a drifting finger keeps the hold (pointerup still cancels).
      try { b.setPointerCapture(e.pointerId); } catch {}
      b.classList.add('holding');
      t = setTimeout(() => {
        t = null;
        b.classList.remove('holding');
        onReset();
        buzz(20);
      }, HOLD_RESET_MS);
    });
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointercancel', cancel);
    return b;
  }
  function sliderRow(label, id, min, max, step, start, fmt = (v) => (+v).toFixed(2)) {
    const wrap = el('div', 'sp-slider');
    const labRow = el('div', 'sp-slabel');
    const val = el('span', 'sp-sval', fmt(start));
    const input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = start;
    input.addEventListener('input', () => {
      val.textContent = fmt(input.value);
      slide(id, parseFloat(input.value));
    });
    const reset = holdReset(`hold to reset ${label}`, () => {
      input.value = String(start);
      val.textContent = fmt(start);
      slide(id, +start);
    });
    const right = el('span', 'sp-srow-right');
    right.append(reset, val);
    labRow.append(el('span', null, label), right);
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
          padBtn('earth', 'earth', { sub: 'drive', lit: 'earth', flip: 'earthOn' }),
          padBtn('metal', 'metal', { sub: 'zone', lit: 'metal', flip: 'metalOn' }),
          padBtn('tuner', 'tuner', { sub: 'toggle', lit: 'tuner', flip: 'tunerOn' }),
          padBtn('delay', 'delayToggle', { sub: 'on / off', lit: 'delay', flip: 'delayOn' }),
          padBtn('reverb', 'reverbToggle', { sub: 'on / off', lit: 'reverb', flip: 'reverbOn' }),
          padBtn('⏸ pause', 'pause', { cls: 'warn', sub: 'all audio', lit: 'pause', flip: 'paused' })),
        el('h3', 'sp-h', 'levels'),
        // 0–2 matches the rig's real range (RIG_LEVEL_MAX): >1.0 is boost into
        // the rig limiter, which the leader force-engages while boosted.
        sliderRow('rig master', 'rig.level', 0, 2, 0.01, 1),
        sliderRow('delay mix', 'delay.mix', 0, 1, 0.01, 0.3),
        sliderRow('reverb mix', 'reverb.mix', 0, 1, 0.01, 0.3),
        el('div', 'sp-note', 'sliders send absolute values, like MIDI CC knobs — hold a ↺ to snap one back to default'),
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
          padBtn('vox', 'voxMute', { sub: 'mute / live', lit: 'vox', flip: 'voxMuted' }),
          padBtn('⏸ pause', 'pause', { cls: 'warn', sub: 'all audio', lit: 'pause', flip: 'paused' })),
      );
    } else if (tab === 'seq') {
      const cpsSlider = document.createElement('input');
      cpsSlider.type = 'range'; cpsSlider.min = '0.2'; cpsSlider.max = '2'; cpsSlider.step = '0.01';
      cpsSlider.value = String(state.cps || 0.5);
      cpsSlider.dataset.cps = '1';
      cpsSlider.addEventListener('input', () => {
        slide('cps', parseFloat(cpsSlider.value));
        const v = bodyEl.querySelector('.sp-cps-val');
        if (v) v.textContent = (+cpsSlider.value).toFixed(2);
      });
      const cpsWrap = el('div', 'sp-cps');
      const cpsRight = el('span', 'sp-srow-right');
      cpsRight.append(
        holdReset('hold to reset tempo', () => {
          cpsSlider.value = '0.5';
          slide('cps', 0.5);
          const v = bodyEl.querySelector('.sp-cps-val');
          if (v) v.textContent = '0.50';
        }),
        el('b', 'sp-cps-val', '—'));
      cpsWrap.append(el('span', 'sp-cps-label', 'cps'), cpsRight);

      const writeBtn = el('button', 'sp-pad sp-write', '⏺ write taps into pattern');
      writeBtn.classList.toggle('armed', writeArmed);
      writeBtn.addEventListener('click', () => {
        writeArmed = !writeArmed;
        writeBtn.classList.toggle('armed', writeArmed);
        buzz(15);
      });

      // Undo / redo / clear for the pattern — reflect() greys undo/redo out
      // from the host-reported history depths; taps here adjust the local
      // guess so the buttons react before the next cstate snapshot arrives.
      const undoBtn = padBtn('↶ undo', 'seqUndo', { sub: 'last edit' });
      const redoBtn = padBtn('redo ↷', 'seqRedo', { sub: 're-apply' });
      const clearBtn = padBtn('✕ clear', 'seqClear', { cls: 'warn', sub: 'wipe pattern' });
      undoBtn.dataset.hist = 'undo';
      redoBtn.dataset.hist = 'redo';
      undoBtn.addEventListener('click', () => {
        if (state.tapUndoDepth > 0) { state.tapUndoDepth -= 1; state.tapRedoDepth += 1; reflect(); }
      });
      redoBtn.addEventListener('click', () => {
        if (state.tapRedoDepth > 0) { state.tapRedoDepth -= 1; state.tapUndoDepth += 1; reflect(); }
      });
      clearBtn.addEventListener('click', () => {
        // A wipe is one undoable edit (the host no-ops on an empty grid and
        // the next snapshot corrects the guess).
        state.tapUndoDepth += 1; state.tapRedoDepth = 0; reflect();
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
        grid(3, undoBtn, redoBtn, clearBtn),
        padsGrid,
        el('div', 'sp-note', writeArmed
          ? 'taps sound AND land on the nearest grid cell while the sequencer plays'
          : 'taps just sound — arm ⏺ write to record them into the pattern'),
      );
    } else if (tab === 'quale') {
      // τ — the set clock. Snapshot-fed (1 Hz), close enough for pacing a set.
      const tauRow = el('div', 'sp-cps');
      tauRow.append(el('span', 'sp-cps-label', 'set clock'), el('b', 'sp-tau', '—'));
      const tauReset = padBtn('↺ reset τ', 'chronReset', { cls: 'warn', sub: 'restart set clock' });
      tauReset.addEventListener('click', () => { state.tau = 0; reflect(); });

      bodyEl.append(
        el('h3', 'sp-h', 'now showing'),
        el('div', 'sp-quale-name', state.quale || '—'),
        el('h3', 'sp-h', 'navigate'),
        grid(2,
          padBtn('◀ quale', 'qualePrev', { sub: 'previous visual' }),
          padBtn('quale ▶', 'qualeNext', { sub: 'next visual' }),
          padBtn('◀ phase', 'phasePrev', { sub: 'step back' }),
          padBtn('phase ▶', 'phaseNext', { sub: 'step forward' })),
        el('h3', 'sp-h', 'auto'),
        grid(3,
          padBtn('cycle', 'cycleAuto', { lit: 'cycleAuto', flip: 'autoCycleOn', sub: 'auto quale' }),
          padBtn('phase', 'phaseAuto', { lit: 'phaseAuto', flip: 'autoPhaseOn', sub: 'auto phase' }),
          padBtn('walk', 'walk', { lit: 'walk', flip: 'walkOn', sub: 'cam drift' })),
        el('h3', 'sp-h', 'set clock'),
        tauRow,
        grid(1, tauReset),
        el('h3', 'sp-h', 'stage'),
        grid(3,
          padBtn('cam ▶', 'camNext', { sub: 'next device' }),
          padBtn('⏸ pause', 'pause', { cls: 'warn', sub: 'all audio', lit: 'pause', flip: 'paused' }),
          padBtn('☾ dark', 'blackout', { cls: 'warn', sub: 'blackout', lit: 'blackout', flip: 'blackoutOn' })),
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
        : kind === 'seq'       ? state.seqPlaying
        : kind === 'loop'      ? state.loopPlaying
        : kind === 'rec'       ? state.recording
        : kind === 'freeze'    ? state.freezeDepth > 0
        : kind === 'walk'      ? state.walkOn
        : kind === 'cycleAuto' ? state.autoCycleOn
        : kind === 'phaseAuto' ? state.autoPhaseOn
        : kind === 'earth'     ? state.earthOn
        : kind === 'metal'     ? state.metalOn
        : kind === 'tuner'     ? state.tunerOn
        : kind === 'delay'     ? state.delayOn
        : kind === 'reverb'    ? state.reverbOn
        : kind === 'pause'     ? state.paused
        : kind === 'vox'       ? state.voxMuted
        : kind === 'blackout'  ? state.blackoutOn
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
    for (const b of bodyEl.querySelectorAll('[data-hist]')) {
      b.disabled = b.dataset.hist === 'undo' ? !(state.tapUndoDepth > 0) : !(state.tapRedoDepth > 0);
    }
    const tauEl = bodyEl.querySelector('.sp-tau');
    if (tauEl) {
      const s = state.tau;
      const fmt = (sec) => {
        const m = Math.floor(sec / 60);
        return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
          : m > 0 ? `${m}m` : `${Math.floor(sec)}s`;
      };
      tauEl.textContent = (s == null) ? 'τ —'
        : `τ ${fmt(s)}${state.horizonMin > 0 ? ` / ${state.horizonMin}m` : ''}`;
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
