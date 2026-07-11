// Attachment binary sync: metadata rides the main JSON file (gdrive-sync);
// the bytes live as individual files in the "attachments" subfolder of the
// voidstar_mind Drive folder. Upload is a serial queue keyed off driveFileId === '' in
// the metadata (queue state therefore survives tab death and syncs); other
// devices lazy-download a blob the first time they render the attachment.

import * as store from './store.js';
import { getSyncClient, onSyncState } from './gdrive-sync.js';
import { setBlobFetcher, retryMissingImages } from './attachments.js';
import { processPendingOcr } from './ocr.js';

let _uploading = false;

// Upload every local blob whose attachment has no driveFileId yet, and trash
// the Drive file of any tombstoned attachment that still has one. Serial on
// purpose (mobile upstream + Drive rate limits).
export async function pushPendingAttachments() {
  const client = getSyncClient();
  if (_uploading || !client) return;
  _uploading = true;
  try {
    const atts = await store.getAllAttachmentsRaw();
    for (const att of atts) {
      if (att.deletedAt && att.driveFileId) {
        await client.trashAttachmentFile(att.driveFileId);
        const fresh = await store.getAttachment(att.id);
        if (fresh) await store.patchAttachment(fresh, { driveFileId: '' });
        continue;
      }
      if (att.deletedAt || att.driveFileId) continue;
      const blob = await store.getBlob(att.id);
      if (!blob) continue; // binary lives on another device; it will upload from there
      try {
        const fileId = await client.uploadAttachment(att, blob);
        const fresh = await store.getAttachment(att.id);
        if (fresh) await store.patchAttachment(fresh, { driveFileId: fileId });
      } catch (e) {
        console.warn('[mind-sync] attachment upload failed:', att.id, e.message);
        break; // likely offline/token — retry on the next cycle
      }
    }
  } finally {
    _uploading = false;
  }
}

// Re-resolve any images stuck on "unavailable on this device" whenever a push
// cycle completes (their binary may have just become fetchable) or the tab
// comes back online — so a note left open fills in without a manual reopen.
export function wireImageRetry() {
  onSyncState((s) => { if (s === 'synced') retryMissingImages(); });
  if (typeof window !== 'undefined') window.addEventListener('online', retryMissingImages);
}

// Wire the lazy-download path: attachments.getObjectUrl calls this when a
// blob isn't local. Silent put — a downloaded binary must not schedule a push.
export function wireLazyBlobFetch() {
  setBlobFetcher(async (attachmentId) => {
    const client = getSyncClient();
    if (!client) return null;
    const att = await store.getAttachment(attachmentId);
    if (!att?.driveFileId) return null;
    try {
      const blob = await client.downloadAttachment(att.driveFileId);
      await store.putBlob(attachmentId, blob);
      // A freshly-arrived image may still be OCR-pending on this device
      // (e.g. the origin device died before its queue drained).
      if (att.kind === 'image' && att.ocrStatus === 'pending') processPendingOcr();
      return blob;
    } catch (e) {
      console.warn('[mind-sync] attachment download failed:', attachmentId, e.message);
      return null;
    }
  });
}
