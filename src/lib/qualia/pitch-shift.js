// Granular pitch shifter — native Web Audio nodes, no worklet.
//
// Two delay lines whose delay time is swept by a looping ramp buffer; the
// sweep slope resamples the signal (= pitch shift), and the periodic delay
// reset is masked by crossfading the two grains with a looping Hann window.
// Because the ramp and window are equal-length looping AudioBuffers the two
// grains stay phase-locked for free, and the pitch ratio is set just by
// scaling the ramp depth — so a moving harmony retunes with no re-sync.
//
//   output(t) = input(t − D(t)),  D(t) = baseDelay + Δ·ramp(t),  ramp 0→1
//   ⇒ playback rate = 1 − D′ = 1 − Δ/Tg  ⇒  Δ = (1 − r)·Tg  for ratio r.
//
// Quality is "granular": a mild warble on sustained notes and no formant
// preservation (large shifts colour the timbre). Good enough for harmony
// layers sitting under a dry lead — a PSOLA worklet is the planned upgrade,
// and this module's {input,output,setRatio,dispose} shape is the seam for it.

const GRAIN = 0.060;   // grain period (s) — latency ≈ this; smaller = warblier

function rampBuffer(ctx, len) {
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = i / (len - 1);          // 0 → 1 sawtooth
  return b;
}
function windowBuffer(ctx, len) {
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const s = Math.sin(Math.PI * i / (len - 1));
    d[i] = s * s;                          // Hann — 0 at the seam, two sum to 1
  }
  return b;
}

/**
 * @param {AudioContext} ctx
 * @param {number} grainSize  grain period in seconds
 * @returns {{ input:GainNode, output:GainNode, setRatio:(r:number)=>void, dispose:()=>void }}
 */
export function createGranularShifter(ctx, grainSize = GRAIN) {
  const Lg = Math.max(2, Math.round(grainSize * ctx.sampleRate));
  const Tg = Lg / ctx.sampleRate;
  const ramp = rampBuffer(ctx, Lg);
  const win  = windowBuffer(ctx, Lg);

  const input  = ctx.createGain();
  const output = ctx.createGain();

  // baseDelay covers the largest sweep: |r−1| ≤ 1 → |Δ| ≤ Tg, so delayTime
  // stays within [0, 2·Tg].
  const baseDelay = Tg;

  const grains = [];
  for (let g = 0; g < 2; g++) {
    const delay = ctx.createDelay(2 * Tg + 0.05);
    delay.delayTime.value = baseDelay;
    const fade  = ctx.createGain(); fade.gain.value = 0;
    const depth = ctx.createGain(); depth.gain.value = 0;   // Δ — set by setRatio

    const rampSrc = ctx.createBufferSource();
    rampSrc.buffer = ramp; rampSrc.loop = true;
    rampSrc.connect(depth);
    depth.connect(delay.delayTime);          // delayTime = baseDelay + Δ·ramp

    const winSrc = ctx.createBufferSource();
    winSrc.buffer = win; winSrc.loop = true;
    winSrc.connect(fade.gain);               // fade.gain = window 0..1

    input.connect(delay);
    delay.connect(fade);
    fade.connect(output);

    grains.push({ delay, fade, depth, rampSrc, winSrc });
  }

  // Start grain 0, then grain 1 half a grain later so the windows interleave
  // (one is at full while the other crosses its delay-reset seam).
  const t0 = ctx.currentTime + 0.03;
  grains[0].rampSrc.start(t0);
  grains[0].winSrc.start(t0);
  grains[1].rampSrc.start(t0 + Tg / 2);
  grains[1].winSrc.start(t0 + Tg / 2);

  let disposed = false;

  return {
    input,
    output,
    // r = output pitch ÷ input pitch. 1 = bypass (a constant baseDelay).
    setRatio(r) {
      if (disposed) return;
      const delta = (1 - r) * Tg;            // signed sweep depth
      const t = ctx.currentTime;
      for (const gr of grains) {
        try {
          gr.depth.gain.cancelScheduledValues(t);
          gr.depth.gain.linearRampToValueAtTime(delta, t + 0.02);
        } catch {}
      }
    },
    dispose() {
      disposed = true;
      for (const gr of grains) {
        try { gr.rampSrc.stop(); } catch {}
        try { gr.winSrc.stop(); } catch {}
        for (const n of [gr.delay, gr.fade, gr.depth, gr.rampSrc, gr.winSrc]) {
          try { n.disconnect(); } catch {}
        }
      }
      try { input.disconnect(); } catch {}
      try { output.disconnect(); } catch {}
    },
  };
}
