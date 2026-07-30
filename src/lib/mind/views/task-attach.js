// Screenshots on TODO items — the attachment surface shared by the home TODO
// card and the tasks view.
//
// A task-owned attachment is an ordinary attachment record with `taskId` set
// instead of `noteId` (store.js), so it inherits the whole existing pipeline for
// free: local blob storage, the OCR queue (a screenshot's text becomes
// searchable), serial Drive binary upload + lazy download on other devices,
// tombstones/trash, and the annotation canvas — tapping a thumbnail opens
// `#task/<id>/annotate/<attId>`, the same markup tools a note's images get.
//
// Capture paths, in the order people reach for them: paste (Ctrl+V a screenshot
// straight into the add box or onto an existing row), drop a file on the card,
// or the 📷 button's file picker.

import * as store from '../store.js';
import { addTaskAttachmentFromBlob, getObjectUrl } from '../attachments.js';
import { processPendingOcr } from '../ocr.js';
import { pushPendingAttachments } from '../attachments-drive.js';
import { navigate } from '../app.js';
import { el, btn, confirmBox } from '../ui.js';

// Images only: a TODO item wants a screenshot, not an audio recording (those
// belong to notes, which have the player UI).
export const isImageFile = (f) => !!f && typeof f.type === 'string' && f.type.startsWith('image/');

// Pull image files out of a paste/drop event. Returns [] when there are none,
// so the caller can let a normal text paste through untouched.
export function imagesFromEvent(e) {
  const dt = e.clipboardData || e.dataTransfer;
  if (!dt) return [];
  const files = dt.files?.length ? [...dt.files] : [...(dt.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile());
  return files.filter(isImageFile);
}

// Hidden <input type=file> factory — one per surface, appended by the caller.
export function imagePicker(onFiles) {
  const input = el('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])].filter(isImageFile);
    input.value = '';
    if (files.length) await onFiles(files);
  });
  return input;
}

// Attach blobs to a task: store them, queue OCR, nudge the Drive upload queue.
export async function attachBlobsToTask(task, blobs) {
  const out = [];
  for (const b of blobs) out.push(await addTaskAttachmentFromBlob(task.id, b, b.name || ''));
  if (out.some((a) => a.ocrStatus === 'pending')) processPendingOcr(); // background
  pushPendingAttachments(); // no-op until Drive is connected
  return out;
}

// The 📷 button + its hidden picker, as one element to drop in a task row.
export function taskAttachButton(task, onChange) {
  const wrap = el('span', 'mn-task-attachwrap');
  const picker = imagePicker(async (files) => {
    await attachBlobsToTask(task, files);
    onChange?.();
  });
  const b = btn('&#128247;', 'mn-btn-ghost mn-task-attach', (e) => {
    e.stopPropagation();
    picker.click();
  });
  b.title = 'attach a screenshot (or paste one onto this task)';
  wrap.appendChild(b);
  wrap.appendChild(picker);
  return wrap;
}

// A row of thumbnails for one task. `atts` are that task's attachments (the
// caller loads them in bulk — one store read per render, not one per row).
export async function taskThumbs(task, atts, onChange) {
  if (!atts.length) return null;
  const strip = el('div', 'mn-task-thumbs');
  for (const a of atts) {
    const cell = el('span', 'mn-task-thumbcell');
    const img = el('img', 'mn-task-thumb');
    const url = await getObjectUrl(a.id);
    if (url) img.src = url;
    else cell.classList.add('mn-task-thumb-missing');
    img.alt = a.name || 'screenshot';
    img.title = url ? 'open & annotate' : 'not on this device yet — syncing';
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      if (url) navigate(`#task/${task.id}/annotate/${a.id}`);
    });
    cell.appendChild(img);
    const rm = btn('&times;', 'mn-attach-x mn-task-thumb-x', (e) => {
      e.stopPropagation();
      confirmBox('Remove this screenshot from the task?', async () => {
        await store.trashAttachment(a);
        onChange?.();
      });
    });
    rm.title = 'remove';
    cell.appendChild(rm);
    strip.appendChild(cell);
  }
  return strip;
}

// Group every task-owned attachment by task id — one pass, for a view that
// renders many rows.
export function groupTaskAttachments(attachments) {
  const byTask = new Map();
  for (const a of attachments || []) {
    if (!a.taskId || a.deletedAt) continue;
    if (!byTask.has(a.taskId)) byTask.set(a.taskId, []);
    byTask.get(a.taskId).push(a);
  }
  for (const list of byTask.values()) list.sort((x, y) => x.createdAt - y.createdAt);
  return byTask;
}

// Paste-to-attach on an existing task row: Ctrl+V with a screenshot in the
// clipboard while the row is focused/hovered attaches it right there.
export function wirePasteOnRow(row, task, onChange) {
  row.tabIndex = 0; // focusable, so a paste can be aimed at one row
  row.addEventListener('paste', async (e) => {
    const imgs = imagesFromEvent(e);
    if (!imgs.length) return;
    e.preventDefault();
    await attachBlobsToTask(task, imgs);
    onChange?.();
  });
}

// Drop a screenshot anywhere on a task row.
export function wireDropOnRow(row, task, onChange) {
  const over = (e) => {
    if (!imagesFromEvent(e).length && !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    row.classList.add('mn-task-dropping');
  };
  row.addEventListener('dragover', over);
  row.addEventListener('dragleave', () => row.classList.remove('mn-task-dropping'));
  row.addEventListener('drop', async (e) => {
    const imgs = imagesFromEvent(e);
    row.classList.remove('mn-task-dropping');
    if (!imgs.length) return;
    e.preventDefault();
    await attachBlobsToTask(task, imgs);
    onChange?.();
  });
}

// Small label for the pending-images chip in the add row.
export const pendingLabel = (n) => `&#128206; ${n} image${n === 1 ? '' : 's'} attached`;
