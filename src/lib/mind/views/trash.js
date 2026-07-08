// Trash — tombstoned notes; restore or purge. Tombstones auto-purge after
// TRASH_TTL_MS (see store.purgeExpiredTombstones).

import * as store from '../store.js';
import { markdownToText } from '../editor/markdown.js';
import { refresh } from '../app.js';
import { el, esc, btn, topBar, emptyState, confirmBox, timeAgo } from '../ui.js';

export async function renderTrash(root) {
  root.appendChild(topBar('trash', '#settings'));

  const all = await store.getAllNotesRaw();
  const trashed = all.filter(n => n.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);

  if (!trashed.length) {
    root.appendChild(emptyState('trash is empty. deleted notes stay here for 30 days.'));
    return;
  }

  root.appendChild(el('div', 'mn-note-meta', 'deleted notes purge automatically after 30 days.'));

  for (const n of trashed) {
    const card = el('div', 'mn-card');
    const row = el('div', 'mn-card-titlerow');
    row.appendChild(el('span', 'mn-card-title', esc(n.title)));
    row.appendChild(el('span', 'mn-card-time', `deleted ${timeAgo(n.deletedAt)}`));
    card.appendChild(row);
    const snippet = markdownToText(n.body).slice(0, 120);
    if (snippet) card.appendChild(el('div', 'mn-card-snippet', esc(snippet)));

    const actions = el('div', 'mn-actions');
    actions.appendChild(btn('restore', '', async () => {
      await store.restoreNote(n);
      for (const a of (await store.getAllAttachmentsRaw()).filter(a => a.noteId === n.id && a.deletedAt)) {
        await store.putAttachmentRaw({ ...a, deletedAt: 0, updatedAt: Date.now() });
      }
      refresh();
    }));
    actions.appendChild(btn('delete forever', 'mn-btn-danger', () => {
      confirmBox('Permanently delete this note and its attachments?', async () => {
        for (const a of (await store.getAllAttachmentsRaw()).filter(a => a.noteId === n.id)) {
          await store.purgeAttachment(a.id);
          await store.deleteBlob(a.id);
        }
        await store.purgeNote(n.id);
        refresh();
      });
    }));
    card.appendChild(actions);
    root.appendChild(card);
  }
}
