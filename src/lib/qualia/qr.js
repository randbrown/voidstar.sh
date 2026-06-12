// QR rendering — a thin wrapper over the `qrcode` lib (CDN ESM, lazy-loaded),
// styled to the voidstar palette. Used by the Entanglement host modal so the
// audience can scan to join. Kept tiny + dependency-isolated.

const QRCODE_URL = 'https://esm.sh/qrcode@1.5.4';

let _lib = null;
async function lib() {
  if (!_lib) _lib = (await import(/* @vite-ignore */ QRCODE_URL)).default;
  return _lib;
}

/**
 * Render `text` as a QR code into `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {number} [size]  pixel width/height
 */
export async function renderQR(canvas, text, size = 320) {
  const QR = await lib();
  // Pull the active theme's colors so the QR matches whatever skin is live.
  const cs = getComputedStyle(document.documentElement);
  const dark  = cs.getPropertyValue('--text').trim()    || '#e9e6ff';
  const light = cs.getPropertyValue('--viz-bg').trim()   || '#05050d';
  await QR.toCanvas(canvas, text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark, light },   // --text on --viz-bg (theme-aware)
  });
}
