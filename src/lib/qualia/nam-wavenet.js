// NAM WaveNet parsing + weight packing (main thread).
//
// Turns a `.nam` file's JSON into the flat, pre-packed form the WASM kernel
// (wasm/nam-wavenet.c) consumes. Nothing here touches the audio thread: the
// worklet only places these buffers in the module's memory and builds the plan.
//
// Two config schemas exist in the wild and both are handled:
//
//   classic (NAM ≤ 0.6, the overwhelming majority of shared captures)
//     { input_size, condition_size, channels, head_size, kernel_size,
//       dilations[], activation:"Tanh", gated, head_bias }
//
//   extended (NAM 0.7+) — per-layer kernel sizes and activations, a bottleneck,
//     an explicit Conv1D head, plus optional FiLM/grouped/gated machinery
//     { input_size, condition_size, channels, bottleneck, kernel_sizes[],
//       dilations[], activation:[{type,…}], head:{out_channels,kernel_size,bias},
//       layer1x1:{active}, head1x1:{active}, gating_mode[], … }
//
// Anything in the extended schema we don't implement is REFUSED by name rather
// than ignored — silently dropping a FiLM block or a grouped conv would load
// "fine" and sound wrong, which is the worst possible failure for a rig.
//
// The final guard is arithmetic: after parsing, the weight cursor must land
// exactly on weights.length. Any mis-modelled field shifts every subsequent
// weight, so an exact landing is strong evidence the layout is right.

const pad4 = (n) => (n + 3) & ~3;

// NAM activation names → the kernel's ACT_* codes. Fasttanh is NAM's own cheap
// tanh approximation, so it maps onto the real thing.
const ACT = {
  tanh: 0, fasttanh: 0, relu: 1, leakyrelu: 2, sigmoid: 3, elu: 4,
  silu: 5, swish: 5, identity: 6, linear: 6,
};

function actOf(a) {
  const name = String((a && typeof a === 'object' ? a.type : a) || 'Tanh').toLowerCase();
  const code = ACT[name];
  if (code === undefined) return { err: `activation "${name}" not supported` };
  const slope = (a && typeof a === 'object' && a.negative_slope != null) ? +a.negative_slope : 0.01;
  return { code, slope };
}

// Every optional extended-schema block we do not implement, checked by name so
// the refusal can say which one stopped it.
function unsupported(la) {
  const filmy = ['conv_pre_film', 'conv_post_film', 'input_mixin_pre_film', 'input_mixin_post_film',
                 'activation_pre_film', 'activation_post_film', 'layer1x1_post_film', 'head1x1_post_film'];
  for (const key of filmy) if (la[key]?.active) return `FiLM block "${key}"`;
  if (la.head1x1?.active) return 'per-layer head1x1';
  if (la.slimmable != null) return 'per-layer slimmable config';
  for (const key of ['groups_input', 'groups_input_mixin']) {
    if (la[key] != null && la[key] !== 1) return `grouped conv (${key}=${la[key]})`;
  }
  if (la.layer1x1?.groups != null && la.layer1x1.groups !== 1) return `grouped layer1x1 (groups=${la.layer1x1.groups})`;
  if (Array.isArray(la.gating_mode) && la.gating_mode.some((g) => g && g !== 'none')) return 'per-layer gating_mode';
  if (Array.isArray(la.secondary_activation) && la.secondary_activation.some((s) => s != null)) return 'secondary_activation';
  return null;
}

// Normalise either schema into one shape the packer can walk blindly.
function normaliseArray(la, idx) {
  const bad = unsupported(la);
  if (bad) return { err: `${bad} is not supported (layer array ${idx})` };

  const C = la.channels | 0;
  const IN = la.input_size | 0;
  const COND = la.condition_size | 0;
  const dil = la.dilations || [];
  if (!(C > 0) || !(IN > 0) || !(COND > 0) || !dil.length) return { err: `layer array ${idx}: bad shape` };

  const extended = Array.isArray(la.kernel_sizes) || la.head != null || la.bottleneck != null;
  const gated = !!la.gated;
  // Classic gated layers emit 2x channels from the conv; extended files carry an
  // explicit bottleneck instead (equal to channels in every capture seen so far).
  const B = extended ? ((la.bottleneck ?? C) | 0) : (gated ? 2 * C : C);
  if (gated && C % 4 !== 0) return { err: `gated layers need channels divisible by 4 (got ${C})` };

  const ks = Array.isArray(la.kernel_sizes)
    ? la.kernel_sizes.map((k) => k | 0)
    : dil.map(() => (la.kernel_size | 0));
  if (ks.length !== dil.length || ks.some((k) => !(k > 0))) return { err: `layer array ${idx}: kernel/dilation mismatch` };

  // Classic files describe the head as head_size/head_bias on the array; extended
  // files give a full Conv1D. Both land on the same {out,k,bias} triple.
  const head = la.head
    ? { out: la.head.out_channels | 0, k: la.head.kernel_size | 0, bias: !!la.head.bias }
    : { out: (la.head_size ?? 1) | 0, k: 1, bias: !!la.head_bias };
  if (!(head.out > 0) || !(head.k > 0)) return { err: `layer array ${idx}: bad head` };

  const acts = [];
  for (let i = 0; i < dil.length; i++) {
    const a = actOf(Array.isArray(la.activation) ? la.activation[i] : la.activation);
    if (a.err) return { err: `layer array ${idx}: ${a.err}` };
    acts.push(a);
  }
  // layer1x1 is always present classically; extended files can switch it off, in
  // which case z feeds the residual directly. Its INPUT width is the bottleneck
  // for extended files, but plain `channels` classically — a gated classic layer
  // emits 2*channels from the conv and the 1x1 only sees the value half.
  const one = extended ? !!(la.layer1x1?.active) : true;
  const oneIn = extended ? B : C;
  return { C, B, IN, COND, gated, ks, dil, head, acts, one, oneIn };
}

// Read `n` weights and pack them into `dst` through `place(i) -> index`.
function take(w, cur, n) {
  const end = cur.p + n;
  if (end > w.length) { cur.over = true; return null; }
  const out = w.subarray(cur.p, end);
  cur.p = end;
  return out;
}

// Parse one WaveNet model (already unwrapped from any container).
export function parseWaveNet(model) {
  const cfg = model?.config;
  if (!cfg || !Array.isArray(cfg.layers) || !cfg.layers.length) return { ok: false, reason: 'NAM WaveNet: no layer arrays' };
  if (cfg.head != null) return { ok: false, reason: 'NAM WaveNet: a top-level head is not supported' };
  if (!Array.isArray(model.weights)) return { ok: false, reason: 'NAM WaveNet: missing weights' };

  const norm = [];
  for (let i = 0; i < cfg.layers.length; i++) {
    const n = normaliseArray(cfg.layers[i], i);
    if (n.err) return { ok: false, reason: `NAM WaveNet: ${n.err}` };
    norm.push(n);
  }
  // Chained arrays: array i reads array i-1's layer output, and its head
  // accumulator is seeded by array i-1's head output, so the shapes must line up.
  for (let i = 1; i < norm.length; i++) {
    if (norm[i].IN !== norm[i - 1].C) return { ok: false, reason: `NAM WaveNet: layer array ${i} input ${norm[i].IN} != previous channels ${norm[i - 1].C}` };
    if (norm[i - 1].head.out !== norm[i].C) return { ok: false, reason: `NAM WaveNet: layer array ${i - 1} head ${norm[i - 1].head.out} != next channels ${norm[i].C}` };
  }
  if (norm[norm.length - 1].head.out !== 1) return { ok: false, reason: 'NAM WaveNet: final head must produce 1 channel' };

  const w = Float32Array.from(model.weights);
  const cur = { p: 0, over: false };
  const arrays = [];

  for (const a of norm) {
    const Cp = pad4(a.C), Bp = pad4(a.B);

    // rechannel [C][IN] -> [IN][Cp]
    const rechRaw = take(w, cur, a.C * a.IN);
    if (!rechRaw) break;
    const rech = new Float32Array(a.IN * Cp);
    for (let o = 0; o < a.C; o++) for (let i = 0; i < a.IN; i++) rech[i * Cp + o] = rechRaw[o * a.IN + i];

    const layers = [];
    for (let li = 0; li < a.dil.length; li++) {
      const k = a.ks[li], d = a.dil[li];

      // dilated conv [B][C][k] -> [kk][C rows of stride Cp][Bp]
      const convRaw = take(w, cur, a.B * a.C * k);
      if (!convRaw) break;
      const cw = new Float32Array(k * Cp * Bp);
      for (let o = 0; o < a.B; o++) {
        for (let i = 0; i < a.C; i++) {
          const src = o * a.C * k + i * k;
          for (let kk = 0; kk < k; kk++) cw[kk * Cp * Bp + i * Bp + o] = convRaw[src + kk];
        }
      }
      const cbRaw = take(w, cur, a.B);
      if (!cbRaw) break;
      const cb = new Float32Array(Bp); cb.set(cbRaw);

      // input mixin [B][COND] -> [COND][Bp]
      const mixRaw = take(w, cur, a.B * a.COND);
      if (!mixRaw) break;
      const mw = new Float32Array(a.COND * Bp);
      for (let o = 0; o < a.B; o++) for (let i = 0; i < a.COND; i++) mw[i * Bp + o] = mixRaw[o * a.COND + i];

      // layer 1x1 [C][oneIn] -> [oneIn][Cp], plus bias. The buffer is padded out
      // to B rows so the kernel can walk all B inputs unconditionally — the extra
      // rows are zero, and gating has already zeroed z past `channels`.
      let ow = null, ob = null;
      if (a.one) {
        const oneRaw = take(w, cur, a.C * a.oneIn);
        if (!oneRaw) break;
        ow = new Float32Array(a.B * Cp);
        for (let o = 0; o < a.C; o++) for (let i = 0; i < a.oneIn; i++) ow[i * Cp + o] = oneRaw[o * a.oneIn + i];
        const obRaw = take(w, cur, a.C);
        if (!obRaw) break;
        ob = new Float32Array(Cp); ob.set(obRaw);
      }
      layers.push({ k, d, rf: (k - 1) * d, cw, cb, mw, ow, ob, act: a.acts[li].code, slope: a.acts[li].slope });
    }
    if (cur.over) break;

    // head Conv1D [out][C][hk] -> [kk][C rows of stride Cp][HOUTp]
    const HOUTp = pad4(a.head.out);
    const headRaw = take(w, cur, a.head.out * a.C * a.head.k);
    if (!headRaw) break;
    const hw = new Float32Array(a.head.k * Cp * HOUTp);
    for (let o = 0; o < a.head.out; o++) {
      for (let i = 0; i < a.C; i++) {
        const src = o * a.C * a.head.k + i * a.head.k;
        for (let kk = 0; kk < a.head.k; kk++) hw[kk * Cp * HOUTp + i * HOUTp + o] = headRaw[src + kk];
      }
    }
    const hb = new Float32Array(HOUTp);
    if (a.head.bias) {
      const hbRaw = take(w, cur, a.head.out);
      if (!hbRaw) break;
      hb.set(hbRaw);
    }
    arrays.push({ C: a.C, Cp, B: a.B, Bp, IN: a.IN, COND: a.COND, gated: a.gated ? 1 : 0,
                  hk: a.head.k, hout: a.head.out, houtp: HOUTp, rech, layers, hw, hb });
  }

  if (cur.over) return { ok: false, reason: `NAM WaveNet: weights too short (${w.length}, ran out mid-model)` };
  const headScaleRaw = take(w, cur, 1);
  if (!headScaleRaw) return { ok: false, reason: 'NAM WaveNet: missing head_scale' };
  if (cur.p !== w.length) {
    return { ok: false, reason: `NAM WaveNet: weight count mismatch (used ${cur.p} of ${w.length}) — unrecognised variant` };
  }

  return {
    ok: true, type: 'wavenet', arrays, headScale: headScaleRaw[0],
    sampleRate: +model.sample_rate || 48000,
    // NAM stores the capture's measured output loudness; the rig uses it to trim
    // captures to a common level instead of every amp jumping in volume.
    loudnessDb: Number.isFinite(model?.metadata?.loudness) ? +model.metadata.loudness : null,
    receptiveField: arrays.reduce((s, a) => s + a.layers.reduce((t, l) => t + l.rf, 0), 0),
  };
}

// Unwrap NAM 0.7's container architectures. A SlimmableContainer holds several
// submodels of increasing width, each valid up to its `max_value` input level —
// a CPU optimisation for quiet passages. They are separately parameterised (not
// nested slices), so switching between them mid-stream would step the output;
// with the WASM kernel we can afford the widest one, which is also the only one
// valid across the whole input range.
export function unwrapContainer(json) {
  const arch = String(json?.architecture || '');
  const subs = json?.config?.submodels;
  if (!Array.isArray(subs) || !subs.length) return { model: json, arch, picked: null };
  let best = subs[0], bestV = -Infinity;
  for (const s of subs) {
    const v = Number.isFinite(+s?.max_value) ? +s.max_value : 0;
    if (v > bestV) { bestV = v; best = s; }
  }
  const inner = best?.model || {};
  // Containers keep the useful metadata at the top level.
  const merged = { ...inner, metadata: inner.metadata || json.metadata, sample_rate: inner.sample_rate || json.sample_rate };
  return { model: merged, arch: String(merged.architecture || ''), picked: { of: subs.length, maxValue: bestV, container: arch } };
}
