// Scan worker — runs the scan-cloud.js pipeline (parse → sample → level →
// annotate) off the main thread for the Scan quale. A 6 MB Polycam GLB with a
// 4096² texture takes a few hundred ms to decode + sample; doing that on the
// main thread would hitch the render loop and the Strudel cyclist.
//
// Protocol (main ⇄ worker):
//   → { id, bytes: ArrayBuffer|null, count }   bytes=null → procedural monolith
//   ← { id, cloud }                            typed arrays transferred
//   ← { id, error }

import { loadScan } from './scan-cloud.js';

// Base-colour textures are decoded at ≤1024² — plenty for per-point colour
// and a quarter of the memory of a 4096² RGBA bitmap.
const MAX_TEX = 1024;

async function decodeImage(bytes, mime) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const k = Math.min(1, MAX_TEX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

self.onmessage = async (e) => {
  const { id, bytes, count } = e.data || {};
  try {
    const cloud = await loadScan(bytes || null, count, { decodeImage });
    self.postMessage({ id, cloud }, [
      cloud.positions.buffer, cloud.colors.buffer, cloud.normals.buffer,
      cloud.dist.buffer, cloud.fig.buffer, cloud.rand.buffer,
    ]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
