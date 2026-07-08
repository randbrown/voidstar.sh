// Attachment handling — create records from Blobs/Files, probe dimensions,
// downscale oversized images, and serve object URLs for rendering.

import * as store from './store.js';

// Insert-time cap for image dimensions. Screenshots off a 4K/retina display
// are routinely 5–8k px wide; notes never need more than this, and every
// byte rides IDB + Drive + OCR. JPEG/PNG keep their type; everything else
// re-encodes to PNG.
const MAX_IMAGE_DIM = 2560;

function extFor(mime) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
  };
  return map[mime] || '';
}

function kindOf(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'file';
}

async function probeImage(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close();
    return dims;
  } catch { return { width: 0, height: 0 }; }
}

async function downscaleImage(blob, dims) {
  const { width, height } = dims;
  if (Math.max(width, height) <= MAX_IMAGE_DIM) return { blob, dims };
  const scale = MAX_IMAGE_DIM / Math.max(width, height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  try {
    const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const type = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const out = await new Promise((res) => canvas.toBlob(res, type, 0.92));
    if (!out) return { blob, dims };
    return { blob: out, dims: { width: w, height: h } };
  } catch { return { blob, dims }; }
}

async function probeAudioDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    const cleanup = (sec) => { URL.revokeObjectURL(url); resolve(sec); };
    audio.onloadedmetadata = () => cleanup(isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => cleanup(0);
    audio.src = url;
  });
}

// Create an attachment (record + local blob) for a note. Returns the record.
export async function addAttachmentFromBlob(noteId, blob, name = '') {
  const mimeType = blob.type || 'application/octet-stream';
  const kind = kindOf(mimeType);
  let dims = { width: 0, height: 0 };
  let durationSec = 0;
  let stored = blob;

  if (kind === 'image') {
    dims = await probeImage(blob);
    ({ blob: stored, dims } = await downscaleImage(blob, dims));
  } else if (kind === 'audio') {
    durationSec = await probeAudioDuration(blob);
  }

  // Unnamed inserts (clipboard screenshots, recordings) get a sortable
  // timestamp filename: "20260708-143207-image.png".
  const fallbackName = `${store.fileStamp()}-${kind}${extFor(stored.type || mimeType)}`;
  const att = store.createAttachment(noteId, {
    kind, name: name || blob.name || fallbackName, mimeType: stored.type || mimeType, size: stored.size,
  }, { width: dims.width, height: dims.height, durationSec: Math.round(durationSec) });

  await store.putBlob(att.id, stored);
  await store.putAttachmentRaw(att);
  return att;
}

// Object-URL cache. URLs live for the session; revokeObjectUrls() frees them
// wholesale on route change so long sessions don't leak every image viewed.
const _urlCache = new Map();

export async function getObjectUrl(attachmentId) {
  if (_urlCache.has(attachmentId)) return _urlCache.get(attachmentId);
  const blob = await store.getBlob(attachmentId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  _urlCache.set(attachmentId, url);
  return url;
}

export function revokeObjectUrls() {
  for (const url of _urlCache.values()) URL.revokeObjectURL(url);
  _urlCache.clear();
}

// Trash an attachment: tombstone the record (propagates via sync); the local
// blob stays until the tombstone expires so restore-from-trash still works.
export async function trashAttachment(att) {
  await store.trashAttachment(att);
}

export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
