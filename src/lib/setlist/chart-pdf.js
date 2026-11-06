// Multi-page PDF charts → one tall PNG. Every chart surface (song page,
// annotation editor, perform mode, enhance, the AI chart read) renders a
// single flat image whose natural aspect locks the stage box that annotation
// strokes are normalized against — so instead of teaching each of them about
// pages, a PDF is rasterized once at cache time with its pages stacked
// top-to-bottom. Drive's thumbnail renderer (what the worker used to serve)
// only ever drew page 1.

import { openPdf } from '../mind/pdf.js';

const MAX_PAGES = 12;
const TARGET_WIDTH = 1600;
// Stay inside every browser's canvas limits: iOS Safari caps total area at
// ~16.7M px, Chromium caps either side at 32767 px.
const MAX_AREA = 16_000_000;
const MAX_SIDE = 32_000;

export function isPdfBlob(blob) {
  return /^application\/pdf/.test(blob?.type || '');
}

// Rasterize a PDF blob's pages (up to MAX_PAGES) stacked vertically into one
// PNG. Resolves { blob, pages, totalPages, aspect, firstPageAspect } — the
// stack's and first page's width/height let callers migrate annotations
// drawn against a page-1-only render.
export async function rasterizePdfStack(pdfBlob) {
  const doc = await openPdf(pdfBlob);
  try {
    const totalPages = doc.numPages;
    const count = Math.min(totalPages, MAX_PAGES);
    const pages = [];
    for (let i = 1; i <= count; i++) pages.push(await doc.getPage(i));
    const sizes = pages.map(p => p.getViewport({ scale: 1 }));
    // Every page renders at one shared output width; heights follow each
    // page's own aspect (mixed portrait/landscape still stacks cleanly).
    const unitHeight = sizes.reduce((h, v) => h + v.height / v.width, 0);
    const width = Math.min(
      TARGET_WIDTH,
      Math.floor(Math.sqrt(MAX_AREA / unitHeight)),
      Math.floor(MAX_SIDE / unitHeight),
    );
    const heights = sizes.map(v => Math.round(width * v.height / v.width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = heights.reduce((a, b) => a + b, 0);
    const ctx = canvas.getContext('2d');
    // Each page renders on its own canvas, then composites in: pdf.js fills
    // the WHOLE target canvas with white before drawing, so rendering
    // straight into the stack would wipe the pages above.
    const pageCanvas = document.createElement('canvas');
    let y = 0;
    for (let i = 0; i < count; i++) {
      const viewport = pages[i].getViewport({ scale: width / sizes[i].width });
      pageCanvas.width = width;
      pageCanvas.height = heights[i];
      await pages[i].render({ canvasContext: pageCanvas.getContext('2d'), viewport }).promise;
      ctx.drawImage(pageCanvas, 0, y);
      y += heights[i];
    }
    pageCanvas.width = pageCanvas.height = 0; // release the backing store
    const blob = await new Promise((res, rej) =>
      canvas.toBlob(b => (b ? res(b) : rej(new Error('PDF rasterize failed'))), 'image/png'));
    return {
      blob,
      pages: count,
      totalPages,
      aspect: canvas.width / canvas.height,
      firstPageAspect: sizes[0].width / sizes[0].height,
    };
  } finally {
    doc.loadingTask.destroy();
  }
}
