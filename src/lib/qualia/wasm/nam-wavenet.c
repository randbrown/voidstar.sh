// nam-wavenet.c — NAM (Neural Amp Modeler) WaveNet inference kernel, wasm32 + SIMD128.
//
// Build: src/lib/qualia/wasm/build.sh  →  public/wasm/nam-wavenet.wasm (committed).
//
// This is the "WASM core" the neural amp has always wanted: scalar JS tops out
// around 100% of one core for a standard NAM WaveNet at 48 kHz, which the audio
// thread cannot afford. The same graph here runs ~4x faster.
//
// Division of labour: JS (neural-amp-model.js) owns ALL parsing, validation and
// weight packing. It writes a flat plan + pre-packed weights into this module's
// linear memory and calls nam_process(). This file walks the plan and does
// nothing else — no allocation, no libc, no control flow that depends on audio.
//
// Weight packing contract (JS side must match exactly). Every matrix is stored
// [in][outPadded] so the inner loop splats a scalar input and accumulates whole
// v128 lanes of outputs — no horizontal reductions anywhere. Channel counts are
// padded up to a multiple of 4 (Cp/Bp); padding lanes hold zero weights, and the
// activation explicitly re-zeroes padded outputs so a nonzero-at-zero activation
// (Sigmoid) can't leak garbage into a following stage.
//
// Buffers are time-major, channel-contiguous: sample n of a C-channel signal is
// at buf[n*Cp .. n*Cp+C). Layer history lives in the same buffer, ahead of the
// block: buf[0 .. rf*Cp) is the previous block's tail, carried by nam_process.

#include <wasm_simd128.h>

// The arena starts at the linker's heap base; JS reads the exported global and
// lays every buffer out relative to it. All plan "offsets" are float indices.
extern unsigned char __heap_base;

#define ARENA ((float *)&__heap_base)
#define IARENA ((int *)&__heap_base)

// ---------------------------------------------------------------------------
// vector math
// ---------------------------------------------------------------------------

// expf on 4 lanes: 2^k * poly(r), k = round(x/ln2), r = x - k*ln2. Max relative
// error ~1e-7 over the range activations care about; inputs are clamped so the
// ldexp bit-stuffing can't overflow the exponent field on a runaway sample.
static inline v128_t vexp(v128_t x) {
  const v128_t lo = wasm_f32x4_splat(-88.0f), hi = wasm_f32x4_splat(88.0f);
  x = wasm_f32x4_pmin(hi, wasm_f32x4_pmax(lo, x));
  const v128_t inv_ln2 = wasm_f32x4_splat(1.44269504088896341f);
  v128_t kf = wasm_f32x4_nearest(wasm_f32x4_mul(x, inv_ln2));
  // r = x - k*ln2, split ln2 hi/lo for accuracy
  v128_t r = wasm_f32x4_sub(x, wasm_f32x4_mul(kf, wasm_f32x4_splat(0.693359375f)));
  r = wasm_f32x4_add(r, wasm_f32x4_mul(kf, wasm_f32x4_splat(2.12194440e-4f)));
  // degree-5 minimax poly for e^r on [-ln2/2, ln2/2]
  v128_t p = wasm_f32x4_splat(1.9875691500e-4f);
  p = wasm_f32x4_add(wasm_f32x4_mul(p, r), wasm_f32x4_splat(1.3981999507e-3f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, r), wasm_f32x4_splat(8.3334519073e-3f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, r), wasm_f32x4_splat(4.1665795894e-2f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, r), wasm_f32x4_splat(1.6666665459e-1f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, r), wasm_f32x4_splat(5.0000001201e-1f));
  v128_t r2 = wasm_f32x4_mul(r, r);
  p = wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(p, r2), r), wasm_f32x4_splat(1.0f));
  // 2^k by stuffing the IEEE-754 exponent
  v128_t k = wasm_i32x4_trunc_sat_f32x4(kf);
  v128_t pow2 = wasm_i32x4_shl(wasm_i32x4_add(k, wasm_i32x4_splat(127)), 23);
  return wasm_f32x4_mul(p, pow2);
}

static inline v128_t vsigmoid(v128_t x) {
  return wasm_f32x4_div(wasm_f32x4_splat(1.0f),
                        wasm_f32x4_add(wasm_f32x4_splat(1.0f), vexp(wasm_f32x4_neg(x))));
}

// tanh(x) = 2*sigmoid(2x) - 1
static inline v128_t vtanh(v128_t x) {
  v128_t s = vsigmoid(wasm_f32x4_add(x, x));
  return wasm_f32x4_sub(wasm_f32x4_add(s, s), wasm_f32x4_splat(1.0f));
}

// y[0..OP) += W[in][out] * x[0..I)   — W packed [i][OP], OP a multiple of 4.
static inline void matvec_acc(float *y, const float *W, const float *x, int I, int OP) {
  for (int o = 0; o < OP; o += 4) {
    v128_t a = wasm_v128_load(y + o);
    const float *w = W + o;
    for (int i = 0; i < I; i++)
      a = wasm_f32x4_add(a, wasm_f32x4_mul(wasm_f32x4_splat(x[i]), wasm_v128_load(w + i * OP)));
    wasm_v128_store(y + o, a);
  }
}

// ---------------------------------------------------------------------------
// activations — applied over padded lanes, then padding forced back to zero
// ---------------------------------------------------------------------------

#define ACT_TANH 0
#define ACT_RELU 1
#define ACT_LEAKY 2
#define ACT_SIGMOID 3
#define ACT_ELU 4
#define ACT_SILU 5
#define ACT_IDENTITY 6

static inline void activate(float *z, int B, int Bp, int type, float slope) {
  const v128_t zero = wasm_f32x4_splat(0.0f);
  for (int o = 0; o < Bp; o += 4) {
    v128_t v = wasm_v128_load(z + o);
    switch (type) {
      case ACT_TANH: v = vtanh(v); break;
      case ACT_RELU: v = wasm_f32x4_pmax(zero, v); break;
      case ACT_LEAKY: {
        v128_t neg = wasm_f32x4_mul(v, wasm_f32x4_splat(slope));
        v = wasm_v128_bitselect(v, neg, wasm_f32x4_gt(v, zero));
        break;
      }
      case ACT_SIGMOID: v = vsigmoid(v); break;
      case ACT_ELU: {
        v128_t e = wasm_f32x4_sub(vexp(v), wasm_f32x4_splat(1.0f));
        v = wasm_v128_bitselect(v, e, wasm_f32x4_gt(v, zero));
        break;
      }
      case ACT_SILU: v = wasm_f32x4_mul(v, vsigmoid(v)); break;
      default: break;
    }
    wasm_v128_store(z + o, v);
  }
  for (int o = B; o < Bp; o++) z[o] = 0.0f;   // keep padding inert
}

// ---------------------------------------------------------------------------
// plan walking
// ---------------------------------------------------------------------------
//
// header:  [0] nArrays  [1] headScaleOff  [2] condOff  [3] outOff
// array:   C Cp B Bp IN COND nLayers HK HOUT HOUTp gated
//          arrInOff arrInStride rechOff hwOff hbOff headAccOff headOutOff
//          sigAOff sigBOff zOff arrOutOff
//          prevHeadOutOff   (-1 for the first array → accumulator starts at zero)
// layer:   k d rf cwOff cbOff mwOff owOff obOff bufOff actType slopeOff
//          (owOff < 0 → layer1x1 inactive, z is added to the residual directly)

#define AH 4          // header words
#define AW 23         // words per layer array
#define LW 11         // words per layer

__attribute__((export_name("nam_process")))
void nam_process(int planOff, int N) {
  const int *P = IARENA + planOff;
  float *M = ARENA;
  const int nArrays = P[0];
  const float headScale = M[P[1]];
  const float *cond = M + P[2];
  float *out = M + P[3];

  const int *ap = P + AH;
  int lastHeadOut = -1, lastHOUTp = 4;

  for (int a = 0; a < nArrays; a++) {
    const int C = ap[0], Cp = ap[1], B = ap[2], Bp = ap[3];
    const int IN = ap[4], COND = ap[5], nL = ap[6];
    const int HK = ap[7], HOUTp = ap[9], gated = ap[10];
    const float *arrIn = M + ap[11];
    const int arrInStride = ap[12];
    const float *rech = M + ap[13];
    const float *hw = M + ap[14];
    const float *hb = M + ap[15];
    float *headAcc = M + ap[16];
    float *headOut = M + ap[17];
    float *sig = M + ap[18];
    float *nxt = M + ap[19];
    float *z = M + ap[20];
    float *arrOut = M + ap[21];
    const int prevHead = ap[22];

    // rechannel: IN -> C, no bias. The source is the raw condition for the first
    // array and the previous array's (padded) layer output for the rest, so the
    // per-sample stride comes from the plan rather than from IN.
    for (int n = 0; n < N; n++) {
      float *s = sig + n * Cp;
      for (int c = 0; c < Cp; c++) s[c] = 0.0f;
      matvec_acc(s, rech, arrIn + n * arrInStride, IN, Cp);
    }

    // Head accumulator: history for the head conv already sits at [0, hoff) —
    // every buffer is rewound at the END of a block (see below) so the carry uses
    // the N that actually ran, and a changed render quantum can't desync it.
    const int hoff = (HK - 1) * Cp;
    if (prevHead < 0) {
      for (int i = 0; i < N * Cp; i++) headAcc[hoff + i] = 0.0f;
    } else {
      const float *ph = M + prevHead;
      for (int n = 0; n < N; n++) {
        float *d = headAcc + hoff + n * Cp;
        const float *s = ph + n * lastHOUTp;
        for (int c = 0; c < Cp; c++) d[c] = (c < C) ? s[c] : 0.0f;
      }
    }

    const int *lp = ap + AW;
    for (int l = 0; l < nL; l++) {
      const int k = lp[0], d = lp[1], rf = lp[2];
      const float *cw = M + lp[3];
      const float *cb = M + lp[4];
      const float *mw = M + lp[5];
      const int owOff = lp[6];
      const float *ow = M + (owOff < 0 ? 0 : owOff);
      const float *ob = M + lp[7];
      float *buf = M + lp[8];
      const int actType = lp[9];
      const float slope = M[lp[10]];

      // history is already at [0, rf*Cp) — append this block's input behind it
      for (int i = 0; i < N * Cp; i++) buf[rf * Cp + i] = sig[i];

      // bias + condition mix-in
      for (int n = 0; n < N; n++) {
        float *zz = z + n * Bp;
        for (int o = 0; o < Bp; o++) zz[o] = cb[o];
        matvec_acc(zz, mw, cond + n * COND, COND, Bp);
      }
      // dilated conv: one rank-update per kernel tap across the whole block
      for (int kk = 0; kk < k; kk++) {
        const float *Wk = cw + kk * Cp * Bp;
        const int off = (rf - (k - 1 - kk) * d) * Cp;
        for (int n = 0; n < N; n++)
          matvec_acc(z + n * Bp, Wk, buf + off + n * Cp, C, Bp);
      }

      for (int n = 0; n < N; n++) {
        float *zz = z + n * Bp;
        activate(zz, B, Bp, actType, slope);
        if (gated) {
          // z = act(z[:C]) * sigmoid(z[C:2C]); the top half is the value path.
          for (int o = 0; o < C; o += 4) {
            v128_t g = vsigmoid(wasm_v128_load(zz + C + o));
            wasm_v128_store(zz + o, wasm_f32x4_mul(wasm_v128_load(zz + o), g));
          }
          for (int o = C; o < Bp; o++) zz[o] = 0.0f;
        }
        // head accumulator takes the first C channels of z
        float *ha = headAcc + hoff + n * Cp;
        for (int c = 0; c < Cp; c += 4)
          wasm_v128_store(ha + c, wasm_f32x4_add(wasm_v128_load(ha + c), wasm_v128_load(zz + c)));
        // residual: out = in + 1x1(z)
        float *nn = nxt + n * Cp;
        const float *ss = sig + n * Cp;
        if (owOff < 0) {                    // layer1x1 inactive
          for (int c = 0; c < Cp; c++) nn[c] = ss[c] + zz[c];
        } else {
          for (int c = 0; c < Cp; c++) nn[c] = ob[c];
          matvec_acc(nn, ow, zz, B, Cp);
          for (int c = 0; c < Cp; c += 4)
            wasm_v128_store(nn + c, wasm_f32x4_add(wasm_v128_load(nn + c), wasm_v128_load(ss + c)));
        }
      }
      // rewind: the newest rf samples become the next block's history
      for (int i = 0; i < rf * Cp; i++) buf[i] = buf[N * Cp + i];

      float *t = sig; sig = nxt; nxt = t;
      lp += LW;
    }

    // this array's head: Conv1D(C -> HOUT, kernel HK, dilation 1) over headAcc
    for (int n = 0; n < N; n++) {
      float *y = headOut + n * HOUTp;
      for (int o = 0; o < HOUTp; o++) y[o] = hb[o];
      for (int kk = 0; kk < HK; kk++)
        matvec_acc(y, hw + kk * Cp * HOUTp, headAcc + (n + kk) * Cp, C, HOUTp);
    }
    // rewind the head accumulator the same way, after the head has read it
    for (int i = 0; i < hoff; i++) headAcc[i] = headAcc[N * Cp + i];
    // the next array reads this one's layer output
    for (int i = 0; i < N * Cp; i++) arrOut[i] = sig[i];

    lastHeadOut = ap[17];
    lastHOUTp = HOUTp;
    ap += AW + nL * LW;
  }

  if (lastHeadOut < 0) {                 // empty plan — emit silence, never read wild
    for (int n = 0; n < N; n++) out[n] = 0.0f;
    return;
  }
  const float *y = M + lastHeadOut;
  for (int n = 0; n < N; n++) out[n] = y[n * lastHOUTp] * headScale;
}

// Report where JS may start laying out buffers.
__attribute__((export_name("nam_heap_base")))
int nam_heap_base(void) { return (int)(&__heap_base); }

// Plan-layout version. The .wasm is a plain static asset, so the service
// worker's stale-while-revalidate can briefly pair a cached kernel with newer
// JS; the worklet refuses to run unless this matches NAM_ABI in the loader.
// BUMP THIS whenever the plan encoding above changes.
__attribute__((export_name("nam_abi")))
int nam_abi(void) { return 1; }
