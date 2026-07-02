// Auto-levels ("✦ enhance") for scanned/photographed chart images.
//
// Hand-drawn charts arrive as photos or scans: gray pencil on off-white
// paper, uneven exposure, JPEG artifacts from Drive's thumbnail rasterizer.
// The dark-charts look is a pure CSS invert, which PRESERVES that poor
// contrast — light-gray strokes on a medium-gray ground. This module
// normalizes each chart's tonal range before display: a luminance histogram
// finds the ink point and the paper lobe, a levels stretch pins them to true
// black and true white, and a midtone gamma pulls faint strokes toward the
// ink end. Self-calibrating on purpose — an already-clean chart maps to a
// near-identity curve, so it's safe to run on everything; that uniformity
// across a folder of mixed-quality scans is the point.
//
// Only cached blobs can be processed: a live drive.google.com <img> is
// cross-origin without CORS headers, so a canvas that draws it is tainted.
// Callers must fall back to the raw URL whenever this returns null.

const ENHANCE_KEY = 'voidstar.setlist.chartEnhance';

export function chartEnhanceEnabled() {
  try { return localStorage.getItem(ENHANCE_KEY) !== '0'; } catch { return true; }
}

export function setChartEnhanceEnabled(on) {
  try { localStorage.setItem(ENHANCE_KEY, on ? '1' : '0'); } catch {}
}

// Cap the pixel pass: Drive thumbnails are w2000, but a direct-linked photo
// can be 12MP+. Downscaling preserves aspect, which is all the annotation
// invariant needs — strokes are normalized to the box, not to pixels.
const MAX_DIM = 3000;

// Enhance an image blob → object URL of the auto-leveled version (caller
// revokes), or null when it can't or shouldn't be processed (not an image,
// decode failure, or a near-flat image with no tonal structure to recover) —
// the caller renders the original blob instead.
export async function enhanceChartBlob(blob) {
  if (!blob || !/^image\//.test(blob.type || '')) return null;
  let bmp = null;
  try {
    bmp = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;
    const lut = buildLevelsLut(d);
    if (!lut) return null;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
    ctx.putImageData(imageData, 0, 0);
    // JPEG keeps a photo-sized result small and fast to encode; alpha-capable
    // sources re-encode as PNG so a transparent background survives.
    const outType = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const out = await new Promise((res) => canvas.toBlob(res, outType, 0.92));
    return out ? URL.createObjectURL(out) : null;
  } catch {
    return null;
  } finally {
    try { bmp?.close?.(); } catch {}
  }
}

// Build the 256-entry levels curve from the image's luminance histogram, or
// null when there's no tonal structure worth stretching (blank page, solid
// color, mostly-transparent line art). Two document polarities, handled
// symmetrically by pinning the DOMINANT lobe — the "ground" the ink sits
// on — to its extreme:
//   - paper scans (bright ground): the whole paper lobe maps to pure white,
//     the darkest-percentile ink to black, and a >1 gamma pulls faint gray
//     strokes toward black;
//   - native-dark charts (dark ground): the background lobe maps to pure
//     black and a <1 gamma pulls faint bright strokes toward white.
function buildLevelsLut(d) {
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue; // transparent pixels aren't tone
    hist[(d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8]++;
    count++;
  }
  if (!count) return null;
  const percentile = (p) => {
    const target = count * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  let peak = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[peak]) peak = v;

  const brightGround = peak >= 128;
  let lo, hi, gamma;
  if (brightGround) {
    lo = percentile(0.01);
    hi = lobeEdge(hist, peak, -1);
    gamma = 1.6;
  } else {
    hi = percentile(0.99);
    lo = lobeEdge(hist, peak, +1);
    gamma = 1 / 1.6;
  }
  // Less than this and the "chart" is tonal noise (a blank page's paper
  // texture) — stretching would amplify mush, so leave it alone.
  if (hi - lo < 24) return null;

  const lut = new Uint8ClampedArray(256);
  const range = hi - lo;
  for (let v = 0; v < 256; v++) {
    const x = Math.min(1, Math.max(0, (v - lo) / range));
    lut[v] = Math.round(Math.pow(x, gamma) * 255);
  }
  return lut;
}

// Walk from the histogram's dominant peak toward `dir` until the count drops
// below 20% of the peak — the edge of the ground lobe (paper or dark
// background). Everything past that edge pins to the extreme, which is what
// turns "almost-white paper" into actual white. Bounded so a broad, noisy
// histogram can't walk the edge into the strokes.
function lobeEdge(hist, peak, dir) {
  const floor = hist[peak] * 0.2;
  let edge = peak;
  for (let n = 0; n < 80; n++) {
    const next = edge + dir;
    if (next < 0 || next > 255 || hist[next] <= floor) break;
    edge = next;
  }
  return edge;
}
