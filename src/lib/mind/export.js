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

// ── Single-document markdown export ──
// One readable .md where each note is a heading with its date + tags inline,
// round-trip-parseable by import-doc.js. Mirrors the notes/*.md tree above but
// concatenated into a single file with metadata comments for lossless re-import.

export const DOC_HEADING_LEVEL = 2; // '##' — matches the import default

function isoDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// One note as a doc block: heading with a human-visible date, a lossless
// `<!-- mind … -->` metadata comment (parsed back by import-doc.js), then body.
export function noteToDocBlock(note, opts = {}) {
  const { headingLevel = DOC_HEADING_LEVEL, includeComment = true, includeIds = true } = opts;
  const iso = isoDay(note.createdAt);
  const hashes = '#'.repeat(Math.min(6, Math.max(1, headingLevel)));
  const parts = [`${hashes} ${note.title || 'untitled'}${iso ? ` — ${iso}` : ''}`];
  if (includeComment) {
    const bits = [];
    if (iso) bits.push(`date=${iso}`);
    if (note.tags?.length) bits.push(`tags=${note.tags.join(',')}`);
    if (note.meta?.daily) bits.push(`daily=${note.meta.daily}`);
    if (includeIds && note.id) bits.push(`id=${note.id}`);
    if (bits.length) parts.push(`<!-- mind ${bits.join(' ')} -->`);
  }
  parts.push('');
  parts.push((note.body || '').trim());
  return `${parts.join('\n').trimEnd()}\n`;
}

// Pure builder (node-testable): an array of notes → the single-doc string.
export function buildDocFromNotes(notes, opts = {}) {
  const { order = 'newest-first', includeComment = true } = opts;
  const live = notes.filter((n) => !n.deletedAt);
  live.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // newest first
  if (order === 'oldest-first') live.reverse();
  const header = includeComment
    ? `<!-- mind-export v=1 order=${order} count=${live.length} -->\n# mind notes — ${isoDay(Date.now())}\n\n`
    : `# mind notes — ${isoDay(Date.now())}\n\n`;
  return header + live.map((n) => noteToDocBlock(n, opts)).join('\n');
}

// Store-backed export, optionally scoped to a folder (incl. subfolders) or tag.
export async function buildNotesMarkdownDoc(opts = {}) {
  const { folderId = '', tag = '' } = opts;
  let notes = await store.getAllNotes();
  if (folderId) {
    const folders = await store.getAllFolders();
    const scope = store.folderScope(folders, folderId);
    notes = notes.filter((n) => scope.has(n.folderId));
  }
  if (tag) {
    const t = tag.replace(/^#/, '').trim().toLowerCase();
    notes = notes.filter((n) => (n.tags || []).includes(t));
  }
  return buildDocFromNotes(notes, opts);
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
