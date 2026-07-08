// Note editor view — title/rename, ProseMirror body with autosave,
// attachment strip, tags.

import * as store from '../store.js';
import { createEditor } from '../editor/setup.js';
import { firstLine } from '../editor/markdown.js';
import { addAttachmentFromBlob, getObjectUrl, formatSize, formatDuration } from '../attachments.js';
import { navigate, refresh } from '../app.js';
import { el, esc, btn, topBar, textPrompt, confirmBox, timeAgo } from '../ui.js';

const AUTOSAVE_MS = 800;

export async function renderEditor(root, noteId) {
  let note = await store.getNote(noteId);
  if (!note || note.deletedAt) {
    root.appendChild(topBar('note not found', '#home'));
    return;
  }

  // ── Top bar ──
  const titleSpan = el('span', 'mn-topbar-title mn-title-clickable', esc(note.title));
  titleSpan.title = 'rename';
  titleSpan.addEventListener('click', () => {
    // Rename default: for auto-titled notes offer the first body line; a
    // hand-named note offers its current name. User can type anything.
    const prefill = note.autoTitle ? (firstLine(note.body) || note.title) : note.title;
    textPrompt({
      title: 'rename note',
      value: prefill,
      placeholder: 'note title',
      onOk: async (v) => {
        if (!v) return;
        note = { ...note, title: v, autoTitle: false };
        await save({ title: v, autoTitle: false });
        titleSpan.innerHTML = esc(v);
      },
    });
  });

  const pinBtn = btn(note.pinned ? '&#9733;' : '&#9734;', 'mn-btn-icon', async () => {
    note = { ...note, pinned: !note.pinned };
    await save({ pinned: note.pinned });
    pinBtn.innerHTML = note.pinned ? '&#9733;' : '&#9734;';
  });
  pinBtn.title = 'pin to top';

  const delBtn = btn('&#128465;', 'mn-btn-icon mn-btn-danger', () => {
    confirmBox('Move this note to trash?', async () => {
      flushPending();
      await store.trashNote(note);
      // Tombstone its attachments too so their blobs eventually purge.
      for (const a of await store.getAttachmentsForNote(note.id)) await store.trashAttachment(a);
      navigate('#home');
    });
  });
  delBtn.title = 'move to trash';

  const bar = el('div', 'mn-topbar');
  bar.appendChild(btn('&larr;', 'mn-btn-icon', () => navigate('#home')));
  bar.appendChild(titleSpan);
  const actions = el('div', 'mn-actions');
  actions.appendChild(pinBtn);
  actions.appendChild(delBtn);
  bar.appendChild(actions);
  root.appendChild(bar);

  const metaRow = el('div', 'mn-note-meta mn-note-metarow');
  metaRow.appendChild(el('span', '', `created ${timeAgo(note.createdAt)} · edited ${timeAgo(note.updatedAt)}`));
  // Folder picker — move the note anywhere in the hierarchy.
  const folders = await store.getAllFolders();
  const folderSel = el('select', 'mn-select mn-folder-sel');
  const rootOpt = el('option', '', '&#128193; (root)');
  rootOpt.value = '';
  folderSel.appendChild(rootOpt);
  const sorted = folders
    .map(f => ({ f, path: store.folderPath(folders, f.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const { f, path } of sorted) {
    const o = el('option', '', `&#128193; ${esc(path)}`);
    o.value = f.id;
    folderSel.appendChild(o);
  }
  folderSel.value = note.folderId || '';
  folderSel.addEventListener('change', async () => {
    note = { ...note, folderId: folderSel.value };
    await save({ folderId: folderSel.value });
  });
  metaRow.appendChild(folderSel);
  root.appendChild(metaRow);

  // ── Tags ──
  const tagRow = el('div', 'mn-tagrow');
  const drawTags = () => {
    tagRow.innerHTML = '';
    for (const t of note.tags || []) {
      const chip = el('span', 'mn-chip mn-chip-on', `#${esc(t)} <span class="mn-chip-x">&times;</span>`);
      chip.querySelector('.mn-chip-x').addEventListener('click', async () => {
        note = { ...note, tags: note.tags.filter(x => x !== t) };
        await save({ tags: note.tags });
        drawTags();
      });
      tagRow.appendChild(chip);
    }
    const add = btn('+ tag', 'mn-chip', () => {
      textPrompt({
        title: 'add tag', placeholder: 'tag',
        onOk: async (v) => {
          const tag = v.replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
          if (!tag || note.tags.includes(tag)) return;
          note = { ...note, tags: [...note.tags, tag] };
          await save({ tags: note.tags });
          drawTags();
        },
      });
    });
    tagRow.appendChild(add);
  };
  drawTags();
  root.appendChild(tagRow);

  // ── Body editor with autosave ──
  const mount = el('div', 'mn-editor-mount');
  root.appendChild(mount);

  let saveTimer = 0;
  let editor = null;

  async function save(patch = {}) {
    const body = editor ? editor.getMarkdown() : note.body;
    note = { ...note, ...patch, body };
    await store.putNote(note);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save().catch(e => console.warn('[mind] autosave:', e.message)), AUTOSAVE_MS);
  }

  function flushPending() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    save().catch(() => {});
  }

  async function handleFiles(files) {
    for (const file of files) {
      const att = await addAttachmentFromBlob(note.id, file, file.name);
      if (att.kind === 'image') editor.insertImage(att.id, att.name || 'image');
    }
    scheduleSave();
    await drawAttachments();
  }

  editor = createEditor(mount, {
    markdown: note.body,
    onChange: scheduleSave,
    onFiles: handleFiles,
    placeholder: 'write…',
  });

  // ── Attachment strip ──
  const strip = el('div', 'mn-attach-strip');
  root.appendChild(strip);

  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    if (fileInput.files?.length) await handleFiles([...fileInput.files]);
    fileInput.value = '';
  });
  root.appendChild(fileInput);

  async function drawAttachments() {
    strip.innerHTML = '';
    const atts = await store.getAttachmentsForNote(note.id);
    for (const a of atts) strip.appendChild(await attachmentChip(a));
    strip.appendChild(btn('+ attach', 'mn-btn-ghost', () => fileInput.click()));
  }

  async function attachmentChip(a) {
    const chip = el('div', 'mn-attach');
    if (a.kind === 'image') {
      const img = el('img', 'mn-attach-thumb');
      const url = await getObjectUrl(a.id);
      if (url) img.src = url;
      img.alt = a.name || 'image';
      chip.appendChild(img);
    } else if (a.kind === 'audio') {
      const audio = el('audio');
      audio.controls = true;
      const url = await getObjectUrl(a.id);
      if (url) audio.src = url;
      chip.appendChild(audio);
      if (a.durationSec) chip.appendChild(el('span', 'mn-attach-label', formatDuration(a.durationSec)));
    } else {
      chip.appendChild(el('span', 'mn-attach-label',
        `&#128206; ${esc(a.name || a.kind)} <span class="mn-dim">${formatSize(a.size)}</span>`));
    }
    const rm = btn('&times;', 'mn-attach-x', () => {
      confirmBox('Remove this attachment?', async () => {
        await store.trashAttachment(a);
        await drawAttachments();
      });
    });
    chip.appendChild(rm);
    return chip;
  }

  await drawAttachments();

  // Flush the pending autosave when the route changes or the tab hides —
  // a kill mid-edit must not lose the last keystrokes.
  const onHide = () => { if (document.visibilityState === 'hidden') flushPending(); };
  document.addEventListener('visibilitychange', onHide);
  root._mnCleanup = () => {
    document.removeEventListener('visibilitychange', onHide);
    flushPending();
    editor?.destroy();
  };

  // A brand-new empty note drops you straight into writing.
  if (!note.body) editor.focus();
}
