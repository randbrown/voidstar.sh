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
let _onProgress = null;

// Optional UI hook: fn({remaining, current}) or fn(null) when idle.
export function onOcrProgress(fn) { _onProgress = fn; }

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
        const worker = await getWorker();
        const { data } = await worker.recognize(blob);
        const text = (data?.text || '').trim();
        const fresh = await store.getAttachment(att.id);
        if (fresh && !fresh.deletedAt) {
          await store.patchAttachment(fresh, { ocrText: text, ocrStatus: 'done' });
          invalidateIndex();
        }
      } catch (e) {
        console.warn('[mind] ocr failed:', att.id, e.message);
        const fresh = await store.getAttachment(att.id);
        if (fresh) await store.patchAttachment(fresh, { ocrStatus: 'failed' });
      }
      queue = (await store.getPendingOcrAttachments());
    }
  } finally {
    _draining = false;
    _onProgress?.(null);
  }
}

// Re-queue a failed/skipped attachment (e.g. user retry from the UI).
export async function requeueOcr(att) {
  await store.patchAttachment(att, { ocrStatus: 'pending' });
  processPendingOcr();
}
