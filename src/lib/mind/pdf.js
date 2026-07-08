// PDF support — pdfjs-dist, dynamically imported so the (large) library
// never rides the app shell; it loads the first time a PDF is opened or
// OCR'd. Pages rasterize to PNG blobs that feed the annotation stage and
// the OCR queue.

let _pdfjsPromise = null;

async function getPdfjs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = (async () => {
      // Legacy build on purpose: the modern build requires bleeding-edge JS
      // (Map.getOrInsertComputed etc.) that Safari/Firefox/older Chromium
      // lack; legacy ships its own polyfills in both main and worker.
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc =
        new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();
      return pdfjs;
    })();
    _pdfjsPromise.catch(() => { _pdfjsPromise = null; });
  }
  return _pdfjsPromise;
}

async function openDoc(blob) {
  const pdfjs = await getPdfjs();
  return pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
}

export async function pdfPageCount(blob) {
  const doc = await openDoc(blob);
  const n = doc.numPages;
  doc.loadingTask.destroy();
  return n;
}

// Rasterize one page (1-based) to {blob, width, height}.
export async function rasterizePdfPage(blob, pageNum, { maxWidth = 1600 } = {}) {
  const doc = await openDoc(blob);
  try {
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, maxWidth / base.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const png = await new Promise((res, rej) =>
      canvas.toBlob(b => (b ? res(b) : rej(new Error('PDF rasterize failed'))), 'image/png'));
    return { blob: png, width: canvas.width, height: canvas.height };
  } finally {
    doc.loadingTask.destroy();
  }
}

// Session cache of rendered pages (attachmentId:page → object URL + dims),
// so paging back and forth doesn't re-render.
const _pageCache = new Map();

export async function getPdfPageUrl(attachmentId, blob, pageNum) {
  const key = `${attachmentId}:${pageNum}`;
  if (_pageCache.has(key)) return _pageCache.get(key);
  const { blob: png, width, height } = await rasterizePdfPage(blob, pageNum);
  const entry = { url: URL.createObjectURL(png), width, height };
  _pageCache.set(key, entry);
  return entry;
}

export function clearPdfPageCache() {
  for (const { url } of _pageCache.values()) URL.revokeObjectURL(url);
  _pageCache.clear();
}

// Extract text for OCR/search. PDFs with a real text layer don't need OCR at
// all — read it directly (fast, exact). Scanned PDFs (no text layer) fall
// back to rasterize + tesseract per page, capped so a 300-page scan can't
// wedge a phone.
export const OCR_MAX_PAGES = 20;

export async function extractPdfText(blob) {
  const doc = await openDoc(blob);
  try {
    let out = [];
    const pages = Math.min(doc.numPages, 200);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out.push(content.items.map(it => it.str).join(' '));
    }
    return out.join('\n').trim();
  } finally {
    doc.loadingTask.destroy();
  }
}
