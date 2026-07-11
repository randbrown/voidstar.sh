// Note editor view — title/rename, ProseMirror body with autosave,
// attachment strip, tags.

import * as store from '../store.js';
import { createEditor } from '../editor/setup.js';
import { firstLine } from '../editor/markdown.js';
import { addAttachmentFromBlob, getObjectUrl, formatSize, formatDuration } from '../attachments.js';
import { createVoiceCapture, recordingSupported, getStoredMicId, storeMicId } from '../voice-capture.js';
import { ensureTaskIds, syncNoteTasks, backlinksTo } from '../tasks-sync.js';
import { pushPendingAttachments } from '../attachments-drive.js';
import { mountAnnotationOverlay } from '../annotation.js';
import { query } from '../search.js';
import { isSupported as speechSupported } from '../voice.js';
import { applySink } from '../audio-out.js';
import { processPendingOcr } from '../ocr.js';
import { wirePicker } from '../../qualia/devices.js';
import { navigate, refresh } from '../app.js';
import { el, esc, btn, topBar, textPrompt, confirmBox, timeAgo } from '../ui.js';

const KEEP_AUDIO_KEY = 'voidstar.mind.voice.keepAudio';
const KEEP_TEXT_KEY = 'voidstar.mind.voice.keepTranscript';

const AUTOSAVE_MS = 800;

export async function renderEditor(root, noteId, { highlight = '' } = {}) {
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
      // Tombstone its attachments and note-sourced tasks too.
      for (const a of await store.getAttachmentsForNote(note.id)) await store.trashAttachment(a);
      for (const t of await store.getTasksForNote(note.id)) await store.trashTask(t);
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
  // The body as it was when this note was opened — the target of "discard
  // changes" (exit without keeping the edits made this session).
  const openBody = note.body;

  const mount = el('div', 'mn-editor-mount');
  root.appendChild(mount);

  let saveTimer = 0;
  let editor = null;

  function syncHistoryButtons() {
    if (!editor) return;
    undoBtn.disabled = !editor.canUndo();
    redoBtn.disabled = !editor.canRedo();
  }

  async function save(patch = {}) {
    // Stamp any new checkboxes with stable ids first, so the serialized body
    // carries the markers and the task records key off them.
    if (editor) ensureTaskIds(editor.view);
    const body = editor ? editor.getMarkdown() : note.body;
    note = { ...note, ...patch, body };
    await store.putNote(note);
    await syncNoteTasks(note);
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
    let anyOcrable = false;
    for (const file of files) {
      const att = await addAttachmentFromBlob(note.id, file, file.name);
      if (att.kind === 'image') editor.insertImage(att.id, att.name || 'image');
      if (att.ocrStatus === 'pending') anyOcrable = true;
    }
    scheduleSave();
    await drawAttachments();
    if (anyOcrable) processPendingOcr(); // background — text becomes searchable when done
    pushPendingAttachments(); // no-op until Drive is connected
  }

  // Set when a search highlight is active — auto-cleared on the first edit.
  // detachSearchKey only unbinds the Esc listener (used on route teardown, which
  // must NOT touch location.hash — the next view may carry its own ?q=).
  let clearSearchHighlight = null;
  let detachSearchKey = null;

  editor = createEditor(mount, {
    markdown: note.body,
    onChange: () => { scheduleSave(); syncHistoryButtons(); if (clearSearchHighlight) clearSearchHighlight(); },
    onFiles: handleFiles,
    placeholder: 'write…',
  });

  // ── Editor action bar: undo / redo / discard-changes ──
  // Autosave means work is never silently lost, but a phone has no easy
  // Ctrl-Z — so surface undo/redo as buttons, plus a "discard" that restores
  // the note to how it was when opened (the "exit without saving" escape).
  const edToolbar = el('div', 'mn-editor-toolbar');
  const undoBtn = btn('&#8630;', 'mn-btn-icon mn-ed-histbtn', () => { editor.undo(); syncHistoryButtons(); });
  undoBtn.title = 'undo (Ctrl+Z)';
  const redoBtn = btn('&#8631;', 'mn-btn-icon mn-ed-histbtn', () => { editor.redo(); syncHistoryButtons(); });
  redoBtn.title = 'redo (Ctrl+Shift+Z)';
  edToolbar.appendChild(undoBtn);
  edToolbar.appendChild(redoBtn);
  edToolbar.appendChild(el('span', 'mn-editor-toolbar-spacer'));
  const discardBtn = btn('&#8617; discard', 'mn-btn-ghost mn-ed-discard', () => {
    if (editor.getMarkdown() === openBody) { navigate('#home'); return; }
    confirmBox('Discard the changes made to this note since you opened it, and exit?', async () => {
      editor.setMarkdown(openBody);
      await save();          // persist the restored body before leaving
      navigate('#home');
    });
  });
  discardBtn.title = 'restore the note to how it was when you opened it';
  edToolbar.appendChild(discardBtn);
  root.insertBefore(edToolbar, mount);
  syncHistoryButtons();

  // ── Search-match highlighting (opened from a search result with ?q=) ──
  // Highlight every match, scroll to the first, and float a small matches bar
  // (prev/next + ✕). Dismiss via the ✕, Esc, or the first edit; dismissing also
  // strips ?q= so a refresh / back-forward doesn't re-highlight.
  if (highlight) {
    const count = editor.setHighlight(highlight);
    if (count) {
      editor.scrollToFirstMatch();
      let cur = 0;

      const bar = el('div', 'mn-matchbar');
      const label = el('span', 'mn-matchbar-count');
      const drawLabel = () => { label.textContent = `${cur + 1} / ${count}`; };
      const go = (dir) => { cur = editor.scrollToMatch(cur + dir); drawLabel(); };
      drawLabel();
      bar.appendChild(el('span', 'mn-matchbar-icon', '&#128269;'));
      bar.appendChild(label);
      const prev = btn('&#8593;', 'mn-btn-icon', () => go(-1)); prev.title = 'previous match';
      const next = btn('&#8595;', 'mn-btn-icon', () => go(1)); next.title = 'next match';
      const close = btn('&times;', 'mn-btn-icon', () => clearSearchHighlight?.());
      close.title = 'clear highlights (Esc)';
      if (count > 1) { bar.appendChild(prev); bar.appendChild(next); }
      bar.appendChild(close);
      root.appendChild(bar);

      const onKey = (e) => { if (e.key === 'Escape') clearSearchHighlight?.(); };
      document.addEventListener('keydown', onKey);
      detachSearchKey = () => { document.removeEventListener('keydown', onKey); detachSearchKey = null; };

      clearSearchHighlight = () => {
        clearSearchHighlight = null;
        editor.clearHighlight();
        bar.remove();
        detachSearchKey?.();
        const base = location.hash.split('?')[0];
        if (location.hash !== base) history.replaceState(null, '', location.pathname + base);
      };
    }
  }

  // ── Voice capture bar ──
  // Live dictation (Web Speech) + optional original-audio keep (MediaRecorder)
  // on the same mic. Toggle prefs persist across sessions.
  let capture = null;
  let recording = false;

  const voiceBar = el('div', 'mn-voicebar');
  voiceBar.style.display = 'none';

  const micSel = el('select', 'mn-select mn-mic-sel');
  wirePicker({
    select: micSel,
    kind: 'audioinput',
    persist: false, // mind owns its own storage key
    alwaysShow: true,
    getCurrentId: () => getStoredMicId(),
    onChoose: async (id) => { storeMicId(id); return id; },
  }).populate();
  voiceBar.appendChild(micSel);

  const mkToggle = (key, label, dflt) => {
    const lab = el('label', 'mn-voice-toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = (localStorage.getItem(key) ?? (dflt ? '1' : '0')) === '1';
    cb.addEventListener('change', () => localStorage.setItem(key, cb.checked ? '1' : '0'));
    lab.appendChild(cb);
    lab.appendChild(el('span', '', label));
    return { lab, cb };
  };
  const keepAudio = mkToggle(KEEP_AUDIO_KEY, 'keep audio', true);
  const keepText = mkToggle(KEEP_TEXT_KEY, 'insert transcript', true);
  voiceBar.appendChild(keepAudio.lab);
  voiceBar.appendChild(keepText.lab);

  const recBtn = btn('&#9679; record', 'mn-btn-primary mn-rec-btn', () => toggleRecord());
  voiceBar.appendChild(recBtn);
  const liveLine = el('div', 'mn-voice-live');
  voiceBar.appendChild(liveLine);

  async function toggleRecord() {
    if (recording) {
      recBtn.disabled = true;
      const { audioBlob, transcript, durationSec, speechFailed } = await capture.stop();
      recording = false;
      recBtn.disabled = false;
      recBtn.innerHTML = '&#9679; record';
      recBtn.classList.remove('mn-recording');
      liveLine.textContent = '';

      if (keepText.cb.checked && transcript) {
        editor.insertText((transcript.endsWith(' ') ? transcript : transcript + ' '));
        scheduleSave();
      }
      if (keepAudio.cb.checked && audioBlob) {
        const att = await addAttachmentFromBlob(note.id, audioBlob, `${store.fileStamp()}-voice`);
        const fresh = await store.getAttachment(att.id);
        await store.patchAttachment(fresh, {
          transcript: transcript || '',
          transcriptSource: transcript ? 'webspeech' : '',
          durationSec: Math.round(durationSec),
        });
        await drawAttachments();
        pushPendingAttachments();
      }
      if (speechFailed && keepAudio.cb.checked && audioBlob) {
        liveLine.textContent = 'transcript unavailable — audio kept (re-transcribe coming later)';
      } else if (speechFailed && !audioBlob) {
        liveLine.textContent = 'voice capture failed — check mic permissions';
      }
      return;
    }

    capture = createVoiceCapture({
      record: keepAudio.cb.checked && recordingSupported(),
      transcribe: speechSupported(),
      onInterim: (t) => { liveLine.textContent = t; },
      onFinal: () => {},
      onError: () => {},
    });
    try {
      await capture.start();
      recording = true;
      recBtn.innerHTML = '&#9632; stop';
      recBtn.classList.add('mn-recording');
      liveLine.textContent = speechSupported() ? 'listening…' : 'recording (no live transcript on this browser)';
    } catch (e) {
      liveLine.textContent = `mic error: ${e.message}`;
    }
  }

  root.appendChild(voiceBar);

  // Mic toggle lives in the topbar so voice capture is one tap from anywhere.
  const micBtn = btn('&#127908;', 'mn-btn-icon', () => {
    const open = voiceBar.style.display !== 'none';
    voiceBar.style.display = open ? 'none' : 'flex';
  });
  micBtn.title = 'voice note';
  actions.insertBefore(micBtn, pinBtn);

  // Link-to-note picker: search-as-you-type over all notes, insert a
  // [title](#note/id) link at the cursor. Id-based, so renames never break it.
  const linkBtn = btn('&#128279;', 'mn-btn-icon', () => {
    const overlay = el('div', 'mn-modal-overlay');
    const box = el('div', 'mn-modal');
    box.appendChild(el('div', 'mn-modal-title', 'link to note'));
    const input = el('input', 'mn-input');
    input.type = 'search';
    input.placeholder = 'search notes…';
    box.appendChild(input);
    const list = el('div', 'mn-linklist');
    box.appendChild(list);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    let seq = 0;
    const draw = async () => {
      const mySeq = ++seq;
      const hits = (await query(input.value.trim(), { type: 'note' }))
        .filter(h => h.id !== note.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 12);
      if (mySeq !== seq) return;
      list.innerHTML = '';
      for (const h of hits) {
        const row = btn(esc(h.title), 'mn-btn-ghost mn-linkrow', () => {
          overlay.remove();
          editor.insertLink(h.title, `#note/${h.id}`);
          scheduleSave();
          editor.focus();
        });
        list.appendChild(row);
      }
      if (!hits.length) list.appendChild(el('div', 'mn-dim', 'no matches'));
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });
    draw();
    input.focus();
  });
  linkBtn.title = 'link to another note';
  actions.insertBefore(linkBtn, pinBtn);

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
      const thumbWrap = el('div', 'mn-attach-thumbwrap');
      const img = el('img', 'mn-attach-thumb');
      const url = await getObjectUrl(a.id);
      if (url) img.src = url;
      img.alt = a.name || 'image';
      img.title = 'annotate';
      // Tap a thumbnail → the annotation canvas (quick-annotate on the go).
      img.style.cursor = 'pointer';
      img.addEventListener('click', () => navigate(`#note/${note.id}/annotate/${a.id}`));
      thumbWrap.appendChild(img);
      // Show saved annotations right on the thumbnail too.
      if (url) {
        const mountThumb = () => mountAnnotationOverlay(thumbWrap, a.id).catch(() => {});
        if (img.complete && img.naturalWidth) mountThumb();
        else img.addEventListener('load', mountThumb, { once: true });
      }
      chip.appendChild(thumbWrap);
      if (a.ocrStatus === 'pending') chip.appendChild(el('span', 'mn-attach-label mn-dim', 'ocr…'));
    } else if (a.kind === 'audio') {
      const audio = el('audio');
      audio.controls = true;
      const url = await getObjectUrl(a.id);
      if (url) audio.src = url;
      applySink(audio); // route playback to the chosen speaker
      chip.appendChild(audio);
      if (a.durationSec) chip.appendChild(el('span', 'mn-attach-label', formatDuration(a.durationSec)));
      if (a.transcript) {
        const ins = btn('&#128172; insert', 'mn-btn-ghost', () => {
          editor.insertText(a.transcript.endsWith(' ') ? a.transcript : a.transcript + ' ');
          scheduleSave();
        });
        ins.title = a.transcript.slice(0, 400);
        chip.appendChild(ins);
      }
      // On-device Whisper: transcribe (or redo) from the kept audio.
      const wBtn = btn(a.transcript ? 're-transcribe' : 'transcribe', 'mn-btn-ghost', async () => {
        wBtn.disabled = true;
        try {
          const { transcribeBlob, whisperSupported } = await import('../whisper.js');
          if (!whisperSupported()) throw new Error('not supported in this browser');
          const blob = await store.getBlob(a.id);
          if (!blob) throw new Error('audio not on this device');
          const text = await transcribeBlob(blob, (s) => { wBtn.textContent = s; });
          const fresh = await store.getAttachment(a.id);
          await store.patchAttachment(fresh, { transcript: text, transcriptSource: 'whisper' });
          await drawAttachments();
        } catch (e) {
          wBtn.textContent = 'failed';
          wBtn.title = e.message;
          setTimeout(() => { wBtn.textContent = 're-transcribe'; wBtn.disabled = false; }, 2000);
        }
      });
      wBtn.title = 'transcribe on-device with Whisper (~40 MB model, first use only)';
      chip.appendChild(wBtn);
    } else if (a.kind === 'pdf') {
      const open = btn(`&#128196; ${esc(a.name || 'pdf')}`, 'mn-btn-ghost', () =>
        navigate(`#note/${note.id}/annotate/${a.id}`));
      open.title = 'view & annotate pdf';
      chip.appendChild(open);
      if (a.ocrStatus === 'pending') chip.appendChild(el('span', 'mn-attach-label mn-dim', 'text…'));
      chip.appendChild(el('span', 'mn-dim', formatSize(a.size)));
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

  // ── Backlinks panel: notes that link here ──
  const backs = await backlinksTo(note.id);
  if (backs.length) {
    const panel = el('div', 'mn-backlinks');
    panel.appendChild(el('div', 'mn-section-label', `linked from (${backs.length})`));
    for (const b of backs) {
      const row = btn(esc(b.title), 'mn-btn-ghost mn-linkrow', () => navigate(`#note/${b.id}`));
      panel.appendChild(row);
    }
    root.appendChild(panel);
  }

  // Flush the pending autosave when the route changes or the tab hides —
  // a kill mid-edit must not lose the last keystrokes.
  const onHide = () => { if (document.visibilityState === 'hidden') flushPending(); };
  document.addEventListener('visibilitychange', onHide);
  root._mnCleanup = async () => {
    document.removeEventListener('visibilitychange', onHide);
    detachSearchKey?.(); // drop the Esc listener without touching the URL
    // Never leave the mic open across a route change.
    if (recording && capture) { try { await capture.stop(); } catch {} }
    flushPending();
    editor?.destroy();
  };

  // A brand-new empty note drops you straight into writing.
  if (!note.body) editor.focus();
}
