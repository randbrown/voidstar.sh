// Export the whole dataset as a zip: canonical data.json plus a readable
// notes/*.md tree and the raw attachment binaries. Uses qualia/zip.js
// (dependency-free store-only zip).

import { zipStore } from '../qualia/zip.js';
import * as store from './store.js';

function slug(s) {
  return (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

export async function buildExportZip() {
  const data = await store.exportAll();
  const files = [{ name: 'data.json', data: JSON.stringify(data, null, 2) }];

  for (const n of data.notes) {
    if (n.deletedAt) continue;
    const front = `# ${n.title}\n\n`;
    files.push({
      name: `notes/${slug(n.title)}-${n.id.slice(0, 8)}.md`,
      data: front + (n.body || ''),
    });
  }

  for (const a of data.attachments) {
    if (a.deletedAt) continue;
    const blob = await store.getBlob(a.id);
    if (!blob) continue;
    const buf = new Uint8Array(await blob.arrayBuffer());
    const ext = (a.name && a.name.includes('.')) ? '' : guessExt(a.mimeType);
    files.push({ name: `attachments/${a.id.slice(0, 8)}-${slug(a.name) || a.kind}${ext}`, data: buf });
  }

  return zipStore(files);
}

function guessExt(mime) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
  };
  return map[mime] || '';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
