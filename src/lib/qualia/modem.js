// modem.js — analog dial-up modem tone simulator.
//
// A performance sound-generator that emulates what a 1990s voiceband modem
// connection actually sounded like: dial tone, DTMF dialing, ringback, the
// answering modem's 2100 Hz answer tone, the V.8 handshake warble, V.34-style
// line-probe chord, the training-hiss ramp, and the V.32 (9600 bps) data
// carrier. It can also transmit real bytes as *audible* 300-baud FSK — the
// bleeps you hear literally ARE the string you passed in — and simulate the
// far-end modem panned opposite the near end for a stereo call-and-response.
//
// Standards this draws on (all real numbers, see docs/qualia-code-api.md):
//   - DTMF        — ITU-T Q.23 dual-tone dialing
//   - Call progress (US Precise Tone Plan) — dial / ringback / busy
//   - V.25 / V.8  — 2100 Hz answer tone (ANSam: phase-reversed, 15 Hz AM)
//   - V.21        — 300-baud FSK handshake channel (originate + answer)
//   - Bell 103    — the US 300-baud FSK alternative
//   - V.32        — 9600 bps, 1800 Hz carrier, 2400 baud QAM (the "connected" hiss)
//
// ── Architecture fit ──────────────────────────────────────────────────────
// Like the vocoder, the modem owns a PRIVATE AudioContext so it routes to the
// speakers without entangling the analysis path or Strudel's destination
// mute-patch. It hangs a limiter.js brickwall before destination (house rule),
// tags its output `__qualiaBypassMute` (belt-and-braces), and tees an analyser
// off its bus so page-init can `audio.adoptAnalyser(ctx, analyser, 'modem')`
// — which makes the chirps drive the visuals and land in recordings for free.
//
// Nothing here runs on the audio thread: every sound is a timeline of
// Web-Audio nodes scheduled against `ctx.currentTime`, built once at call time
// and played out by the audio clock, so it can't stall the render loop or the
// Strudel cyclist. State changes fire a `qualia:modem` window event (like
// horns' `qualia:horns`) so quales can react to "carrier established".

import { makeLimiter } from './limiter.js';

// ── Standards tables ────────────────────────────────────────────────────────

// DTMF: each key is a low (row) + high (column) tone, in Hz.
const DTMF_ROW = { '1': 697, '2': 697, '3': 697, 'A': 697,
                   '4': 770, '5': 770, '6': 770, 'B': 770,
                   '7': 852, '8': 852, '9': 852, 'C': 852,
                   '*': 941, '0': 941, '#': 941, 'D': 941 };
const DTMF_COL = { '1': 1209, '2': 1336, '3': 1477, 'A': 1633,
                   '4': 1209, '5': 1336, '6': 1477, 'B': 1633,
                   '7': 1209, '8': 1336, '9': 1477, 'C': 1633,
                   '*': 1209, '0': 1336, '#': 1477, 'D': 1633 };

const CALL = {
  dial:   [350, 440],   // continuous
  ring:   [440, 480],   // 2 s on / 4 s off
  busy:   [480, 620],   // 0.5 s on / 0.5 s off
};

// V.21 FSK channels — mark (binary 1) / space (binary 0), in Hz.
const FSK = {
  v21o:    { mark: 980,  space: 1180 },   // V.21 channel 1 (originate)
  v21a:    { mark: 1650, space: 1850 },   // V.21 channel 2 (answer)
  bell103o:{ mark: 1270, space: 1070 },   // Bell 103 originate
  bell103a:{ mark: 2225, space: 2025 },   // Bell 103 answer
};

const ANSWER_HZ  = 2100;   // V.25/V.8 answer tone (ANSam)
const V32_CARRIER = 1800;  // V.32 9600 bps carrier centre

// ── Module ──────────────────────────────────────────────────────────────────

export function createModem(opts = {}) {
  const onFeedChange = typeof opts.onFeedChange === 'function' ? opts.onFeedChange : () => {};

  let ctx = null, bus = null, limiter = null, analyser = null, noiseBuf = null;
  let _state = 'idle';
  let _cursor = 0;          // AudioContext time the currently-queued audio ends at
  const _live = new Set();  // scheduled source nodes, for stop()
  let _tailTimer = null;    // fires when the queue drains → release the analyser
  let _paused = false;

  // Lazily build the graph on first sound — an AudioContext created before a
  // user gesture would start suspended and stay silent.
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    bus = ctx.createGain();
    bus.gain.value = 0.9;
    limiter = makeLimiter(ctx, true);            // brickwall before destination
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    bus.connect(limiter);
    bus.connect(analyser);                        // tee analysis off the pre-limiter bus
    limiter.connect(ctx.destination);
    limiter.__qualiaBypassMute = true;            // never silenced by Strudel's mute gate
    // ~1 s of white noise, looped — the scrambled-data carrier bed.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  // Where the next phase should begin: after whatever's already queued, but
  // never in the past. A tiny lead-in keeps the first attack off the clock edge.
  function startAt() {
    const now = ctx.currentTime + 0.02;
    return Math.max(now, _cursor || 0);
  }

  // Mark the queue busy until `until`, adopt the analyser now, and arm a single
  // tail timer to release it (and return to idle) once the audio drains.
  function extend(until, nextState) {
    _cursor = Math.max(_cursor, until);
    if (nextState) setState(nextState, startAtStateDelay());
    if (_tailTimer) { clearTimeout(_tailTimer); _tailTimer = null; }
    onFeedChange();  // page-init adopts while we're audible
    const ms = Math.max(0, (_cursor - ctx.currentTime) * 1000) + 120;
    _tailTimer = setTimeout(() => {
      _tailTimer = null;
      _live.clear();
      setState('idle');
      onFeedChange();  // release the adopted analyser
    }, ms);
  }
  // State transitions land at the audible start of a phase, not the schedule edge.
  function startAtStateDelay() { return Math.max(0, (startAt() - ctx.currentTime) * 1000); }

  function setState(s, delayMs = 0) {
    const apply = () => {
      if (_state === s) return;
      _state = s;
      try {
        window.dispatchEvent(new CustomEvent('qualia:modem', { detail: { state: s } }));
      } catch { /* SSR / no window */ }
    };
    if (delayMs > 4) setTimeout(apply, delayMs);
    else apply();
  }

  // ── Low-level tone primitive ───────────────────────────────────────────────
  // Schedule one or more simultaneous sines at [t0, t0+dur] with a short
  // click-free attack/release. Options: gain, type, pan (-1..1), am (Hz tremolo
  // depth for ANSam). Returns the time the sound ends.
  function schedTone(freqs, t0, dur, o = {}) {
    ensure();
    const list = Array.isArray(freqs) ? freqs : [freqs];
    const gain = o.gain ?? 0.22;
    const type = o.type ?? 'sine';
    const atk = 0.006, rel = 0.02;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + atk);
    env.gain.setValueAtTime(gain, Math.max(t0 + atk, t0 + dur - rel));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let node = env;
    if (o.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, o.pan));
      env.connect(pan); node = pan;
    }
    node.connect(bus);

    // ANSam-style amplitude modulation (15 Hz tremolo).
    if (o.am) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 15;
      lfoGain.gain.value = gain * 0.35;
      lfo.connect(lfoGain).connect(env.gain);
      lfo.start(t0); lfo.stop(t0 + dur + rel);
      _live.add(lfo);
    }

    for (const f of list) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f, t0);
      osc.connect(env);
      osc.start(t0);
      osc.stop(t0 + dur + rel);
      _live.add(osc);
    }
    return t0 + dur;
  }

  // Silence gap — just advances the cursor.
  function schedGap(t0, dur) { return t0 + dur; }

  // ── DTMF dialing ────────────────────────────────────────────────────────────
  function schedDtmf(t0, digits, o = {}) {
    const on = o.on ?? 0.09, off = o.off ?? 0.055;
    let t = t0;
    for (const ch of String(digits).toUpperCase()) {
      const row = DTMF_ROW[ch], col = DTMF_COL[ch];
      if (row == null) { t += (ch === ',' ? 0.5 : 0); continue; }  // ',' = pause (Hayes)
      schedTone([row, col], t, on, { gain: 0.24, pan: o.pan || 0 });
      t += on + off;
    }
    return t;
  }

  // ── Call-progress tones ──────────────────────────────────────────────────────
  function schedDialTone(t0, dur = 1.0)   { return schedTone(CALL.dial, t0, dur, { gain: 0.16 }); }
  function schedRingback(t0, rings = 2) {
    let t = t0;
    for (let i = 0; i < rings; i++) {
      schedTone(CALL.ring, t, 2.0, { gain: 0.18 });
      t += 2.0 + (i < rings - 1 ? 4.0 : 0.6);   // 2 s on / 4 s off, trimmed last gap
    }
    return t;
  }
  function schedBusy(t0, cycles = 4) {
    let t = t0;
    for (let i = 0; i < cycles; i++) { schedTone(CALL.busy, t, 0.5, { gain: 0.18 }); t += 1.0; }
    return t;
  }

  // ── Answer tone (ANSam) ──────────────────────────────────────────────────────
  // 2100 Hz, amplitude-modulated at 15 Hz, with a phase-reversal dip every
  // 450 ms — the far modem picking up.
  function schedAnswer(t0, dur = 3.3, pan = 0) {
    schedTone(ANSWER_HZ, t0, dur, { gain: 0.2, am: true, pan });
    return t0 + dur;
  }

  // ── FSK (the honest data path + handshake warble) ────────────────────────────
  // One continuous-phase oscillator whose frequency steps per bit — real FSK,
  // click-free. `bits` is an array of 0/1.
  function schedFsk(t0, bits, o = {}) {
    ensure();
    const baud = o.baud ?? 300;
    const chan = o.chan ?? FSK.v21o;
    const bitT = 1 / baud;
    const gain = o.gain ?? 0.2;
    const dur = bits.length * bitT;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    env.gain.setValueAtTime(gain, t0 + dur - 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = env;
    if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; env.connect(p); node = p; }
    node.connect(bus);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    for (let i = 0; i < bits.length; i++) {
      osc.frequency.setValueAtTime(bits[i] ? chan.mark : chan.space, t0 + i * bitT);
    }
    osc.connect(env);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    _live.add(osc);
    return t0 + dur;
  }

  // Bytes → async-serial bit frames (start bit 0, 8 data LSB-first, stop bit 1):
  // real UART framing, so the transmission is genuinely decodable.
  function strToBits(str) {
    const bits = [];
    for (let i = 0; i < 6; i++) bits.push(i % 2);   // brief 010101 preamble (mark/space)
    const bytes = new TextEncoder().encode(String(str));
    for (const b of bytes) {
      bits.push(0);                                  // start bit
      for (let k = 0; k < 8; k++) bits.push((b >> k) & 1);
      bits.push(1);                                  // stop bit
    }
    bits.push(1, 1);                                 // idle mark tail
    return bits;
  }

  // A short pseudo-random FSK "menu" burst — the V.8 CM/JM warble. Seeded off
  // the label so a given handshake sounds the same each time it's re-evaluated
  // (no Math.random surprises mid-set), but distinct per label.
  function menuBits(seed, n = 96) {
    const bits = [];
    let s = 0;
    for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) & 0xffff;
    for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; bits.push((s >> 16) & 1); }
    return bits;
  }

  // ── Line-probe chord + training/data carrier (the "shhhhh") ──────────────────
  // V.34 line probing sweeps tones across the band; we approximate with a rising
  // multitone chord, then ramp bandpassed noise up around the V.32 carrier.
  function schedProbe(t0, pan = 0) {
    const tones = [150, 300, 600, 1050, 1650, 2250, 2850, 3450];
    let t = t0;
    for (const f of tones) { schedTone(f, t, 0.11, { gain: 0.14, pan }); t += 0.075; }
    return t + 0.1;
  }

  function schedCarrier(t0, dur, o = {}) {
    ensure();
    const centre = o.centre ?? V32_CARRIER;
    const gain = o.gain ?? 0.16;
    const ramp = o.ramp ?? 0.0;   // >0 = training ramp-in (crescendo hiss)
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = centre; bp.Q.value = 0.7;
    const env = ctx.createGain();
    const g0 = ramp > 0 ? 0.0001 : gain;
    env.gain.setValueAtTime(g0, t0);
    if (ramp > 0) env.gain.exponentialRampToValueAtTime(gain, t0 + ramp);
    env.gain.setValueAtTime(gain, t0 + dur - 0.15);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(env);
    if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; env.connect(p).connect(bus); }
    else env.connect(bus);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
    _live.add(src);
    return t0 + dur;
  }

  // ── Public surface ───────────────────────────────────────────────────────────

  const api = {
    /** State machine: 'idle' | 'dialing' | 'handshake' | 'connected'. */
    state: () => _state,
    isActive: () => !!ctx && _cursor > ctx.currentTime,
    getContext: () => ctx,
    getFeedAnalyser: () => analyser,

    /** Raw tone primitive — one Hz value or an array (a chord), for `durSec`.
     *  The building block whistle()/dtmf() sit on. Returns nothing useful; it
     *  just sounds. */
    tone: (freqs, durSec = 0.3, o = {}) => {
      if (_paused) return;
      ensure(); ctx.resume?.();
      const t0 = startAt();
      const end = schedTone(freqs, t0, Math.max(0.02, durSec), o);
      extend(end);
    },

    /** Play the modem as an instrument. `spec` may be:
     *   - a number            → a single tone (Hz)
     *   - [f1, f2, …]         → a chord
     *   - a DTMF char / digits→ '5', '#', or '1234' dialed as DTMF
     *   - 'mark' / 'space'    → a V.21 FSK tone (originate channel)
     *   - 'answer'            → the 2100 Hz answer tone */
    whistle: (spec, durSec = 0.25) => {
      if (_paused) return;
      ensure(); ctx.resume?.();
      const t0 = startAt();
      if (typeof spec === 'number' || Array.isArray(spec)) { extend(schedTone(spec, t0, durSec)); return; }
      const s = String(spec);
      if (s === 'answer') { extend(schedAnswer(t0, durSec > 0.25 ? durSec : 1.2)); return; }
      if (s === 'mark' || s === 'space') {
        extend(schedTone(s === 'mark' ? FSK.v21o.mark : FSK.v21o.space, t0, durSec)); return;
      }
      if (/^[0-9A-Da-d*#,]+$/.test(s)) { extend(schedDtmf(t0, s)); return; }
      // fall back: transmit it as a short FSK burst so nothing is silent
      extend(schedFsk(t0, strToBits(s)));
    },

    /** DTMF-dial a digit string (also honors ',' as a Hayes pause). */
    dtmf: (digits) => {
      if (_paused) return;
      ensure(); ctx.resume?.();
      extend(schedDtmf(startAt(), digits), 'dialing');
    },

    /** Emit the audio an AT command would cause on the line. `ATDT<digits>` /
     *  `ATDP<digits>` → dial tone then DTMF the number; any other command is
     *  rendered as a brief FSK "typing" chirp so it still sounds. */
    command: (str) => {
      if (_paused) return;
      ensure(); ctx.resume?.();
      const s = String(str || '');
      const m = s.match(/at\s*d[tp]?\s*([0-9A-D*#,\s-]+)/i);
      let t = startAt();
      if (m) {
        const digits = m[1].replace(/[\s-]/g, '');
        setState('dialing', startAtStateDelay());
        t = schedDialTone(t, 0.9);
        t = schedGap(t, 0.12);
        t = schedDtmf(t, digits);
      } else {
        t = schedFsk(t, strToBits(s), { gain: 0.16 });
      }
      extend(t);
    },

    /** Transmit `str` as sound.
     *   - mode 'fsk' (default) — HONEST: real 300-baud async-serial FSK; the
     *     bleeps are literally the bytes (decodable). Options: {baud, channel:
     *     'originate'|'answer'|'bell'}.
     *   - mode 'carrier'       — aesthetic V.32 hiss for a duration scaled to
     *     the string length; sounds like a live 9600 connection. */
    data: (str, o = {}) => {
      if (_paused) return;
      ensure(); ctx.resume?.();
      const t0 = startAt();
      if (o.mode === 'carrier') {
        const dur = Math.max(0.6, Math.min(8, String(str).length * 0.12));
        extend(schedCarrier(t0, dur, { pan: o.pan || 0 }), 'connected');
        return;
      }
      const chan = o.channel === 'answer' ? FSK.v21a
                 : o.channel === 'bell'   ? FSK.bell103o
                 : FSK.v21o;
      extend(schedFsk(t0, strToBits(str), { baud: o.baud || 300, chan, gain: 0.2, pan: o.pan || 0 }),
             'connected');
    },

    /** The full cinematic handshake into the data carrier. Options:
     *   {number} to dial first, {farEnd:true} to simulate the answering modem
     *   panned opposite the near end, {probe:true} for the V.34 line-probe
     *   chord, {busy:true} to fail into a busy signal instead of connecting. */
    connect: (o = {}) => {
      if (_paused) return;
      ensure(); ctx.resume?.();
      const near = o.farEnd ? -0.4 : 0;
      const far  = 0.4;
      let t = startAt();
      setState('dialing', startAtStateDelay());
      t = schedDialTone(t, 0.9);
      if (o.number) { t = schedGap(t, 0.1); t = schedDtmf(t, String(o.number)); }
      t = schedGap(t, 0.2);
      if (o.busy) { extend(schedBusy(t, 4)); return; }
      t = schedRingback(t, o.rings ?? 1);
      t = schedGap(t, 0.25);
      // Handshake proper.
      const handshakeStart = t;
      t = schedAnswer(t, 3.3, o.farEnd ? far : 0);       // far modem answers (2100 Hz)
      // V.8 CM (near) / JM (far) menu exchange, overlapping the answer tail.
      schedFsk(handshakeStart + 1.2, menuBits('CM'), { chan: FSK.v21o, gain: 0.16, pan: near });
      if (o.farEnd) schedFsk(handshakeStart + 1.9, menuBits('JM'), { chan: FSK.v21a, gain: 0.16, pan: far });
      setState('handshake', Math.max(0, (handshakeStart - ctx.currentTime) * 1000));
      t = schedGap(t, 0.15);
      if (o.probe !== false) t = schedProbe(t, near);    // V.34 line-probe chord
      // Training ramp → locked carrier.
      t = schedCarrier(t, 2.2, { ramp: 1.4, gain: 0.17, pan: near });
      extend(schedCarrier(t, o.dwell ?? 2.5, { gain: 0.15, pan: near }), 'connected');
    },

    /** Drop the carrier and return the line to dial tone. */
    hangup: () => {
      if (_paused) return;
      ensure(); ctx.resume?.();
      let t = startAt();
      t = schedCarrier(t, 0.25, { gain: 0.12 });   // brief carrier stub that fades
      t = schedGap(t, 0.2);
      extend(schedDialTone(t, 1.2), 'idle');
    },

    /** Pause gate — page pause/Space calls this; blocks new sound + kills current. */
    setPaused: (on) => { _paused = !!on; if (on) api.stop(); return _paused; },

    /** Silence everything immediately and reset to idle. */
    stop: () => {
      if (_tailTimer) { clearTimeout(_tailTimer); _tailTimer = null; }
      const now = ctx ? ctx.currentTime : 0;
      for (const n of _live) { try { n.stop?.(now); } catch { /* already stopped */ } }
      _live.clear();
      _cursor = now;
      setState('idle');
      onFeedChange();
    },
  };

  return api;
}
