// Background OCR for image attachments — tesseract.js, loaded lazily from
// CDN via a script tag (same pattern as setlist's GIS loader: no bundler
// coupling, nothing in the shell path, ~zero cost until the first image).
// The queue drains attachments with ocrStatus 'pending' one at a time at
// idle priority; extracted text lands on the attachment record, which makes
// it searchable and (in the sync phase) rides the JSON so other devices
// never re-OCR the same image.

import * as store from './store.js';
import { invalidateIndex } from './search.js';

const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js';

let _tesseractPromise = null;
let _workerPromise = null;
let _draining = false;
let _current = '';
let _lastError = '';
let _onProgress = null;

// Optional UI hook: fn({remaining, current}) or fn(null) when idle.
export function onOcrProgress(fn) { _onProgress = fn; }

// Live drain state for the status panel (no queue kick).
export function ocrRunState() { return { draining: _draining, current: _current, lastError: _lastError }; }

// A snapshot of the OCR queue for the status panel: counts by state, plus how
// many "pending" items are only waiting on their image binary to arrive from
// Drive (nothing this device can do until a sync/lazy-fetch lands them — which
// is the usual reason a big "N pending" number sits still).
export async function ocrStatusReport() {
  const atts = await store.getAllAttachments();
  const ocrable = atts.filter((a) => a.kind === 'image' || a.kind === 'pdf');
  const counts = { total: ocrable.length, pending: 0, done: 0, failed: 0, skipped: 0, waiting: 0, ready: 0 };
  const blobIds = new Set(await store.getBlobIds());
  for (const a of ocrable) {
    const st = a.ocrStatus || 'pending';
    if (st === 'done' || st === 'failed' || st === 'skipped') counts[st]++;
    else {
      counts.pending++;
      if (blobIds.has(a.id)) counts.ready++; else counts.waiting++;
    }
  }
  return { counts, ...ocrRunState() };
}

// Re-queue every failed attachment (user "retry failed" action), then kick.
export async function retryFailedOcr() {
  const atts = await store.getAllAttachments();
  const failed = atts.filter((a) => a.ocrStatus === 'failed');
  for (const a of failed) await store.patchAttachment(a, { ocrStatus: 'pending' });
  if (failed.length) processPendingOcr();
  return failed.length;
}

function loadTesseract() {
  if (_tesseractPromise) return _tesseractPromise;
  _tesseractPromise = new Promise((resolve, reject) => {
    if (globalThis.Tesseract) { resolve(globalThis.Tesseract); return; }
    const s = document.createElement('script');
    s.src = TESSERACT_SRC;
    s.async = true;
    s.onload = () => globalThis.Tesseract ? resolve(globalThis.Tesseract) : reject(new Error('tesseract load failed'));
    s.onerror = () => { _tesseractPromise = null; reject(new Error('tesseract CDN unreachable')); };
    document.head.appendChild(s);
  });
  return _tesseractPromise;
}

async function getWorker() {
  if (_workerPromise) return _workerPromise;
  _workerPromise = (async () => {
    const T = await loadTesseract();
    return T.createWorker('eng');
  })();
  // A failed load (offline, CDN blocked) must not poison every later attempt.
  _workerPromise.catch(() => { _workerPromise = null; });
  return _workerPromise;
}

const idle = () => new Promise((res) =>
  'requestIdleCallback' in window ? requestIdleCallback(res, { timeout: 4000 }) : setTimeout(res, 250));

// Kick the queue. Safe to call any time (init, after inserting an image,
// after a sync pull) — a single drain runs at once.
export async function processPendingOcr() {
  if (_draining) return;
  const pending = await store.getPendingOcrAttachments();
  if (!pending.length) return;
  _draining = true;
  try {
    let queue = pending;
    while (queue.length) {
      const att = queue[0];
      _current = att.name || '';
      _onProgress?.({ remaining: queue.length, current: att.name });
      await idle();
      try {
        const blob = await store.getBlob(att.id);
        if (!blob) {
          // Binary not on this device (yet) — leave pending; the device
          // that has it (or a later fetch) will OCR it.
          queue = queue.slice(1);
          continue;
        }
        const text = att.kind === 'pdf'
          ? await extractPdfTextOrOcr(blob)
          : await ocrImageBlob(blob);
        const fresh = await store.getAttachment(att.id);
        if (fresh && !fresh.deletedAt) {
          await store.patchAttachment(fresh, { ocrText: text, ocrStatus: 'done' });
          invalidateIndex();
        }
      } catch (e) {
        _lastError = e.message || String(e);
        console.warn('[mind] ocr failed:', att.id, e.message);
        const fresh = await store.getAttachment(att.id);
        if (fresh) await store.patchAttachment(fresh, { ocrStatus: 'failed' });
      }
      queue = (await store.getPendingOcrAttachments());
    }
  } finally {
    _draining = false;
    _current = '';
    _onProgress?.(null);
  }
}

async function ocrImageBlob(blob) {
  const worker = await getWorker();
  const { data } = await worker.recognize(blob);
  return (data?.text || '').trim();
}

// PDFs: a real text layer beats OCR (exact + instant), so read it first;
// only a scanned PDF (no text layer) pays for rasterize + tesseract, capped
// at OCR_MAX_PAGES so a huge scan can't wedge a phone.
async function extractPdfTextOrOcr(blob) {
  const { extractPdfText, rasterizePdfPage, pdfPageCount, OCR_MAX_PAGES } = await import('./pdf.js');
  const text = await extractPdfText(blob).catch(() => '');
  // Any real text layer wins; scanned PDFs yield nothing but whitespace.
  if (/\w/.test(text)) return text;

  const pages = Math.min(await pdfPageCount(blob), OCR_MAX_PAGES);
  const parts = [];
  for (let i = 1; i <= pages; i++) {
    const { blob: png } = await rasterizePdfPage(blob, i);
    parts.push(await ocrImageBlob(png));
  }
  return parts.join('\n').trim();
}

// Re-queue a failed/skipped attachment (e.g. user retry from the UI).
export async function requeueOcr(att) {
  await store.patchAttachment(att, { ocrStatus: 'pending' });
  processPendingOcr();
}
