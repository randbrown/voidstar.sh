// QR rendering — a thin wrapper over the `qrcode` lib (CDN ESM, lazy-loaded),
// styled to the voidstar palette. Used by the Entanglement host modal so the
// audience can scan to join — both the on-screen preview (renderQR) and the
// downloadable / printable performance code (qrToDataURL). Kept tiny +
// dependency-isolated.

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

/**
 * Render `text` as a PNG data URL — for downloading or dropping into a printed
 * flyer. Defaults to high-contrast dark-on-white (NOT theme-aware): a near-black
 * code on a white quiet zone is the most reliable thing for a phone camera to
 * scan off paper, regardless of whatever skin is live on screen. Rendered large
 * (1024px) so it stays crisp when scaled up on a printout.
 * @param {string} text
 * @param {number} [size]  pixel width/height of the PNG
 * @param {{dark?:string, light?:string}} [colors]
 * @returns {Promise<string>} a `data:image/png;base64,…` URL
 */
export async function qrToDataURL(text, size = 1024, { dark = '#0a0a1a', light = '#ffffff' } = {}) {
  const QR = await lib();
  return QR.toDataURL(text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark, light },
  });
}
