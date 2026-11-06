// Scan worker — runs the scan-cloud.js pipeline (parse → sample → level →
// annotate) off the main thread for the Scan quale. A 6 MB Polycam GLB with a
// 4096² texture takes a few hundred ms to decode + sample; doing that on the
// main thread would hitch the render loop and the Strudel cyclist.
//
// Protocol (main ⇄ worker):
//   → { id, bytes: ArrayBuffer|null, procedural?, count, orient }
//        bytes=null → the named procedural cloud, or the monolith
//   ← { id, cloud }                            typed arrays transferred
//   ← { id, error }
//
// Draco-compressed GLBs pull in three's Draco decoder (~340 KB) on first use.

import { loadScan } from './scan-cloud.js';
// three's glTF-only Draco decoder, emitted as static assets and fetched only
// when a Draco-compressed GLB shows up (NASA's 3D library uses it throughout).
import dracoWrapperUrl from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import dracoWasmUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';

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

let dracoPromise = null;
function loadDraco() {
  dracoPromise ||= (async () => {
    const [js, wasmBinary] = await Promise.all([
      fetch(dracoWrapperUrl).then(r => r.text()),
      fetch(dracoWasmUrl).then(r => r.arrayBuffer()),
    ]);
    // The wrapper is a classic script defining DracoDecoderModule, and this
    // is a module worker (no importScripts) — evaluate it in a function scope.
    const factory = new Function(`${js}\nreturn DracoDecoderModule;`)();
    // Stays wrapped all the way out: the Emscripten module is a thenable, so
    // resolving or returning it bare would make the promise chase it forever.
    return await new Promise((resolve) => {
      factory({ wasmBinary, onModuleLoaded: (d) => resolve({ draco: d }) });
    });
  })();
  dracoPromise.catch(() => { dracoPromise = null; });
  return dracoPromise;
}

self.onmessage = async (e) => {
  const { id, bytes, procedural, count, orient } = e.data || {};
  try {
    const cloud = await loadScan(bytes || null, count, { decodeImage, loadDraco, orient, procedural });
    self.postMessage({ id, cloud }, [
      cloud.positions.buffer, cloud.colors.buffer, cloud.normals.buffer,
      cloud.dist.buffer, cloud.fig.buffer, cloud.rand.buffer,
    ]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
