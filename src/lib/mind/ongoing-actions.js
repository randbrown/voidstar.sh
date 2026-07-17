// Ongoing notes — store-coupled actions over the pure core (ongoing.js).
//
// addEntryToNote is the ONE body-append path: it re-reads the record
// immediately before writing, so a quick capture can't clobber an edit that
// a background sync just imported underneath it (the same reason the editor
// rebases on save). The window between read and write is a few ms of local
// IDB work; a genuinely simultaneous fork on another device still resolves
// through the normal LWW + conflict-copy machinery — and an append lost that
// way survives intact inside the conflict copy.
//
// fileNoteInto is the capture-then-file flow: the idea is ALREADY durable as
// its own note before filing starts, so if anything below throws the capture
// survives as a regular note instead of vanishing.

import * as store from './store.js';
import { syncNoteTasks } from './tasks-sync.js';
import { isOngoing, ongoingPrefs, composeEntry, insertIntoBody, mergeText } from './ongoing.js';

// Live ongoing notes, most recently touched first (the order the chips and
// palette entries show them in).
export async function listOngoingNotes() {
  const all = await store.getAllNotes();
  return all.filter(isOngoing).sort((a, b) => b.updatedAt - a.updatedAt);
}

// Persist the quick-add sheet's toggles onto the note. No-op (and no
// updatedAt churn) when nothing changed.
export async function setOngoingPrefs(noteId, { position, stamp }) {
  const note = await store.getNote(noteId);
  if (!note || note.deletedAt) return null;
  const cur = ongoingPrefs(note);
  if (cur.position === position && cur.stamp === !!stamp) return note;
  const updated = {
    ...note,
    meta: { ...(note.meta || {}), ongoing: { position, stamp: stamp ? 1 : 0 } },
  };
  await store.putNote(updated);
  return updated;
}

// Append/prepend an entry to a note's body per its prefs (overridable).
// Re-reads the record right before the write — see the module comment.
export async function addEntryToNote(noteId, text, { position, stamp, ts = Date.now() } = {}) {
  const note = await store.getNote(noteId);
  if (!note || note.deletedAt) throw new Error('target note not found');
  const prefs = ongoingPrefs(note);
  const entry = composeEntry(text, { stamp: stamp ?? prefs.stamp, ts });
  if (!entry) return note;
  const updated = { ...note, body: insertIntoBody(note.body, entry, position ?? prefs.position) };
  await store.putNote(updated);
  // The entry may carry task checkboxes (a merged note's `<!--t:id-->` lines);
  // reconcile records now instead of waiting for the target's next editor save.
  await syncNoteTasks(updated);
  return updated;
}

// File one note's content into another: entry text lands in the target (date
// stamp, when the target wants one, uses the FRAGMENT's creation time — when
// the idea was captured, not when it was filed), attachments and note-sourced
// tasks move along, and the emptied fragment goes to trash (30-day restore).
export async function fileNoteInto(fragmentId, targetId) {
  if (fragmentId === targetId) throw new Error('cannot merge a note into itself');
  const fragment = await store.getNote(fragmentId);
  if (!fragment || fragment.deletedAt) throw new Error('source note not found');
  const target = await store.getNote(targetId);
  if (!target || target.deletedAt) throw new Error('target note not found');

  const text = mergeText(fragment);
  if (!text) throw new Error('nothing to merge — the note is empty');

  // Re-point note-sourced task records BEFORE the markers land in the target
  // body: syncNoteTasks then reconciles the same records in place. Left
  // pointing at the fragment, the target's next editor save would treat the
  // markers as foreign and re-stamp them — minting duplicate records and
  // orphaning any reminders on the originals.
  for (const t of await store.getTasksForNote(fragment.id)) {
    await store.putTask({ ...t, sourceNoteId: target.id });
  }
  // Attachments follow so inline mn-attach:// images keep resolving (and their
  // binaries aren't tombstoned with the fragment).
  for (const a of await store.getAttachmentsForNote(fragment.id)) {
    await store.putAttachment({ ...a, noteId: target.id });
  }

  const updated = await addEntryToNote(targetId, text, { ts: fragment.createdAt || Date.now() });
  await store.trashNote(fragment);
  return updated;
}
