// Browser-side Evernote import: turn parseEnex() output into notes + attachments.
// The pure parsing / ENML→markdown lives in enex.js (node-testable); this file
// does the IndexedDB writes (attachment blobs via attachments.js, note upserts)
// and is therefore browser-only.

import * as store from './store.js';
import { addAttachmentFromBlob } from './attachments.js';
import { parseEnex, MEDIA_SENTINEL_PREFIX } from './enex.js';

// Parse one or more .enex file texts into a combined note list.
// files: [{ name, text }] → { notes, warnings, stats }.
export function parseEnexFiles(files) {
  const notes = [];
  const warnings = [];
  for (const f of files) {
    try {
      const res = parseEnex(f.text, {});
      for (const w of res.warnings) warnings.push(`${f.name}: ${w}`);
      for (const n of res.notes) notes.push(n);
    } catch (e) {
      warnings.push(`${f.name}: parse failed — ${e.message}`);
    }
  }
  const resources = notes.reduce((sum, n) => sum + n.resources.length, 0);
  return { notes, warnings, stats: { notes: notes.length, resources } };
}

// Content fingerprint that ignores image markup (so re-importing the same notes,
// whose stored bodies carry real attachment ids, still dedups against the
// sentinel-carrying candidates).
function fingerprint(title, body) {
  const b = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  return `${String(title || '').trim().toLowerCase()}\n${b}`;
}

const SENTINEL_RE = new RegExp(`mn-attach://${MEDIA_SENTINEL_PREFIX}([a-f0-9]+)`, 'g');

/**
 * Snapshot, then create notes + attachments for the parsed ENEX notes. Chunked
 * so the UI stays responsive. Preserves each note's Evernote created/updated.
 *
 * opts: { folderId, newFolderName, parentId, tag, skipDuplicates, onProgress }
 * @returns {Promise<{created:number, folderId:string, snapshotTs:number}>}
 */
export async function commitEnexImport(notes, opts = {}) {
  const {
    folderId = '', newFolderName = '', parentId = '', tag = '', skipDuplicates = true, onProgress,
  } = opts;

  const snapshotTs = await store.putSnapshot('pre-enex-import');

  let targetFolder = folderId;
  if (newFolderName) {
    const f = store.createFolder(newFolderName.trim(), parentId);
    await store.putFolder(f);
    targetFolder = f.id;
  }

  const seen = skipDuplicates
    ? new Set((await store.getAllNotes()).map(n => fingerprint(n.title, n.body)))
    : null;

  const extraTag = tag ? tag.replace(/^#/, '').trim().toLowerCase() : '';
  const total = notes.length;
  let created = 0;

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    try {
      if (seen) {
        const fp = fingerprint(n.title, n.body);
        if (seen.has(fp)) { if (onProgress) onProgress(i + 1, total); continue; }
        seen.add(fp);
      }

      const tags = [];
      for (const t of n.tags || []) {
        const tt = String(t).replace(/^#/, '').trim().toLowerCase();
        if (tt && !tags.includes(tt)) tags.push(tt);
      }
      if (extraTag && !tags.includes(extraTag)) tags.push(extraTag);

      const note = store.createNote({
        title: n.title || store.autoTitleNow(n.createdAt),
        autoTitle: !n.title,
        body: n.body,
        folderId: targetFolder,
        tags,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      });

      // Every resource becomes an attachment on the note; images additionally
      // map their MD5 → the new attachment id so the inline sentinel resolves.
      const hashToId = new Map();
      for (const r of n.resources || []) {
        try {
          const blob = new Blob([r.bytes], { type: r.mime || 'application/octet-stream' });
          const att = await addAttachmentFromBlob(note.id, blob, r.fileName || '');
          if (r.hash) hashToId.set(r.hash, att.id);
        } catch (e) {
          console.warn('[enex] attachment failed:', e.message);
        }
        r.bytes = null; // release memory as we advance
      }

      note.body = note.body
        .replace(SENTINEL_RE, (_m, hash) => (hashToId.has(hash) ? `mn-attach://${hashToId.get(hash)}` : ''))
        .replace(/!\[[^\]]*\]\(\)/g, '')       // drop image markdown left by an unmatched sentinel
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      await store.putNoteRaw(note);
      created++;
    } catch (e) {
      console.warn('[enex] note import failed:', e.message);
    }
    if (onProgress) onProgress(i + 1, total);
    if (i % 25 === 24) await new Promise((r) => setTimeout(r, 0)); // yield to paint
  }

  return { created, folderId: targetFolder, snapshotTs };
}
