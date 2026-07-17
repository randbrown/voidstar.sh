// Note editor view — title/rename, ProseMirror body with autosave,
// attachment strip, tags.

import * as store from '../store.js';
import { createEditor } from '../editor/setup.js';
import { firstLine } from '../editor/markdown.js';
import { healBodyAttachmentRefs } from '../attach-heal.js';
import { addAttachmentFromBlob, getObjectUrl, formatSize, formatDuration } from '../attachments.js';
import { createVoiceCapture, recordingSupported, getStoredMicId, storeMicId } from '../voice-capture.js';
import { ensureTaskIds, syncNoteTasks, backlinksTo } from '../tasks-sync.js';
import { pushPendingAttachments } from '../attachments-drive.js';
import { mountAnnotationOverlay } from '../annotation.js';
import { pickSketchPaper, createSketchAttachment } from '../sketch.js';
import { query } from '../search.js';
import { listOngoingNotes, fileNoteInto } from '../ongoing-actions.js';
import { isSupported as speechSupported } from '../voice.js';
import { applySink } from '../audio-out.js';
import { processPendingOcr } from '../ocr.js';
import { wirePicker } from '../../qualia/devices.js';
import { navigate, refresh } from '../app.js';
import { listNoteVersions, isConnected as driveConnected } from '../gdrive-sync.js';
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

  // Self-heal dead inline image references before the editor binds to the body.
  // A trashed/duplicate attachment can leave the body pointing at bytes that
  // only exist on the origin device (its blob outlives the tombstone locally),
  // so the picture shows here but dies on every other device. Repoint to the
  // live survivor of the same image; the corrected body then syncs everywhere.
  try {
    const noteAtts = (await store.getAllAttachmentsRaw()).filter((a) => a.noteId === note.id);
    const healed = healBodyAttachmentRefs(note.body, noteAtts);
    if (healed.changed) {
      note = { ...note, body: healed.body };
      await store.putNote(note);
    }
  } catch (e) { console.warn('[mind] attach-heal:', e.message); }

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
      await flushPending();
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
    const patch = { folderId: folderSel.value };
    // Moving to root blanks a fill-field — tombstone it or the sync merge
    // refills the old folder from another device's copy and the move reverts.
    if (!folderSel.value) patch.clearedFields = { ...(note.clearedFields || {}), folderId: Date.now() };
    note = { ...note, ...patch };
    await save(patch);
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
        const tags = note.tags.filter(x => x !== t);
        const patch = { tags };
        // Removing the last tag blanks a fill-field — tombstone it so the
        // sync merge can't resurrect the tag from an older copy.
        if (!tags.length) patch.clearedFields = { ...(note.clearedFields || {}), tags: Date.now() };
        note = { ...note, ...patch };
        await save(patch);
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

  // The record's updatedAt as of this session's last load/write. A background
  // sync (focus pull, auto-push cycle) imports remote changes straight into
  // IDB while this editor holds its own snapshot — every save() rebases on
  // the live record so a stale snapshot can never silently overwrite an edit
  // that arrived from another device.
  let lastKnownUpdatedAt = note.updatedAt;

  // Task-marker ids that belong to OTHER notes — a checkbox pasted in from
  // one of them must be re-stamped, not steal the source's record (see
  // ensureTaskIds). Computed once per mount; cheap at task-store scale.
  const foreignTaskIds = new Set(
    (await store.getAllTasks())
      .filter(t => t.sourceNoteId && t.sourceNoteId !== note.id)
      .map(t => t.id),
  );

  async function save(patch = {}) {
    // Stamp any new checkboxes with stable ids first, so the serialized body
    // carries the markers and the task records key off them.
    if (editor) ensureTaskIds(editor.view, foreignTaskIds);
    let body = editor ? editor.getMarkdown() : note.body;

    // Rebase: if the stored record advanced past what this session last
    // wrote, another device's edit landed via sync while the note was open.
    const current = await store.getNote(note.id);
    if (current && !current.deletedAt && current.updatedAt > lastKnownUpdatedAt) {
      const remoteBody = current.body || '';
      const sessionBase = note.body || '';
      if (remoteBody !== sessionBase) {
        if (editor && body === sessionBase) {
          // Nothing typed since the import — adopt the remote body outright.
          editor.setMarkdown(remoteBody);
          body = remoteBody;
        } else if (remoteBody !== body) {
          // Genuine fork: this save wins LWW, so preserve the incoming body
          // as a conflict copy (same shape the sync merge mints) instead of
          // silently discarding another device's edit.
          const when = new Date(current.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
          const ts = Date.now();
          await store.putNoteRaw({
            ...current,
            id: crypto.randomUUID(),
            title: `Conflicted copy of ${current.title} (another device, ${when})`,
            autoTitle: false,
            conflictOf: current.id,
            createdAt: ts,
            updatedAt: ts,
          });
        }
      }
      // Adopt the newer metadata (title/tags/folder/pin/…) except fields this
      // save explicitly patches — the session snapshot must not clobber them.
      note = { ...current };
    }

    const stamp = Date.now();
    note = { ...note, ...patch, body, updatedAt: stamp };
    await store.putNoteRaw(note);
    lastKnownUpdatedAt = stamp;
    await syncNoteTasks(note);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save().catch(e => console.warn('[mind] autosave:', e.message)), AUTOSAVE_MS);
  }

  // Returns the in-flight save so callers that must order against it (trash,
  // route cleanup) can await — an unawaited flush racing a trashNote used to
  // be able to resurrect the note.
  function flushPending() {
    if (!saveTimer) return Promise.resolve();
    clearTimeout(saveTimer);
    saveTimer = 0;
    return save().catch(() => {});
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
    onWikiLink: () => openLinkPicker(),   // "[[": keyboard wikilink trigger
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
  // Capture-then-file: append this note's content to another note (ongoing
  // notes offered first), move its attachments/tasks along, trash this note.
  const mergeBtn = btn('&#8618; merge into&hellip;', 'mn-btn-ghost mn-ed-merge', () => openMergePicker());
  mergeBtn.title = 'append this note’s content to another note, then trash this one';
  edToolbar.appendChild(mergeBtn);
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
      let cur = editor.scrollToMatch(0); // jump straight to the first match

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
  const micPicker = wirePicker({
    select: micSel,
    kind: 'audioinput',
    persist: false, // mind owns its own storage key
    alwaysShow: true,
    getCurrentId: () => getStoredMicId(),
    onChoose: async (id) => { storeMicId(id); if (recording) await restartForNewMic(); return id; },
  });
  micPicker.populate();
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
    if (recording) await finishRecording();
    else await startRecording();
  }

  // Stop the current session and persist it: insert the transcript and/or keep
  // the audio as an attachment, per the toggles.
  async function finishRecording() {
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
  }

  async function startRecording() {
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
      // Permission granted → real device labels available; refresh the picker.
      micPicker.populate(getStoredMicId() || undefined);
    } catch (e) {
      liveLine.textContent = `mic error: ${e.message}`;
    }
  }

  // Switch the live recording to a newly-picked mic. Commit the segment
  // captured so far (transcript inserted, audio kept) so nothing is lost, then
  // start a fresh session on the new device.
  async function restartForNewMic() {
    if (!recording || !capture) return;
    try { await finishRecording(); } catch {}
    await startRecording();
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
  // Opened by the 🔗 button OR by typing "[[" in the editor (the wikilink
  // input rule — see editor/setup.js), so linking never leaves the keyboard:
  // [[, type to filter, Enter takes the top hit, Esc cancels.
  function openLinkPicker() {
    const overlay = el('div', 'mn-modal-overlay');
    const box = el('div', 'mn-modal');
    box.appendChild(el('div', 'mn-modal-title', 'link to note'));
    const input = el('input', 'mn-input');
    input.type = 'search';
    input.placeholder = 'search notes… (Enter = top hit)';
    box.appendChild(input);
    const list = el('div', 'mn-linklist');
    box.appendChild(list);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    const pick = (h) => {
      overlay.remove();
      editor.insertLink(h.title, `#note/${h.id}`);
      scheduleSave();
      editor.focus();
    };

    let seq = 0;
    let topHit = null;
    const draw = async () => {
      const mySeq = ++seq;
      const hits = (await query(input.value.trim(), { type: 'note' }))
        .filter(h => h.id !== note.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 12);
      if (mySeq !== seq) return;
      topHit = hits[0] || null;
      list.innerHTML = '';
      for (const h of hits) {
        const row = btn(esc(h.title), 'mn-btn-ghost mn-linkrow', () => pick(h));
        list.appendChild(row);
      }
      if (!hits.length) list.appendChild(el('div', 'mn-dim', 'no matches'));
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { overlay.remove(); editor?.focus(); }
      else if (e.key === 'Enter' && topHit) { e.preventDefault(); pick(topHit); }
    });
    draw();
    input.focus();
  }
  const linkBtn = btn('&#128279;', 'mn-btn-icon', openLinkPicker);
  linkBtn.title = 'link to another note (or type [[ in the note)';
  actions.insertBefore(linkBtn, pinBtn);

  // Merge-into picker: choose the note this one's content gets filed into.
  // Empty query lists ongoing (#ongoing) notes — the usual targets — and
  // falls back to recent notes; typing searches everything. The pending
  // autosave is flushed BEFORE filing so the merged text is what's on screen,
  // and nothing re-arms a save afterwards (a post-trash save would resurrect
  // the note — same ordering rule as the delete button).
  function openMergePicker() {
    const overlay = el('div', 'mn-modal-overlay');
    const box = el('div', 'mn-modal');
    box.appendChild(el('div', 'mn-modal-title', 'merge into note'));
    const input = el('input', 'mn-input');
    input.type = 'search';
    input.placeholder = 'search notes… (Enter = top hit)';
    box.appendChild(input);
    const list = el('div', 'mn-linklist');
    box.appendChild(list);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    const pick = (h) => {
      overlay.remove();
      confirmBox(`Add this note's content to "${h.title}" and move this note to trash? (restorable for 30 days)`, async () => {
        try {
          await flushPending();
          await fileNoteInto(note.id, h.id);
          navigate(`#note/${h.id}`);
        } catch (e) { alert(`merge failed: ${e.message}`); }
      });
    };

    let seq = 0;
    let topHit = null;
    const draw = async () => {
      const mySeq = ++seq;
      const q = input.value.trim();
      let hits;
      if (!q) {
        const ongoing = (await listOngoingNotes()).filter(n => n.id !== note.id);
        hits = ongoing.length
          ? ongoing.slice(0, 12).map(n => ({ id: n.id, title: n.title, ongoing: true }))
          : (await query('', { type: 'note' }))
            .filter(h => h.id !== note.id)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 12);
      } else {
        hits = (await query(q, { type: 'note' }))
          .filter(h => h.id !== note.id)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 12);
      }
      if (mySeq !== seq) return;
      topHit = hits[0] || null;
      list.innerHTML = '';
      for (const h of hits) {
        const row = btn(`${esc(h.title)}${h.ongoing ? ' <span class="mn-dim">#ongoing</span>' : ''}`,
          'mn-btn-ghost mn-linkrow', () => pick(h));
        list.appendChild(row);
      }
      if (!hits.length) list.appendChild(el('div', 'mn-dim', 'no matches'));
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.remove();
      else if (e.key === 'Enter' && topHit) { e.preventDefault(); pick(topHit); }
    });
    draw();
    input.focus();
  }

  // ── Per-note version history (Drive shard revisions) ──
  // Every push that touched this note's shard left a Drive revision; the
  // modal walks them newest→oldest and lists the DISTINCT past bodies.
  // Restore just sets the editor to the old text (one undo step, autosaves
  // through the normal rebase-on-save path) — nothing destructive.
  if (driveConnected()) {
    const histBtn = btn('&#9201;', 'mn-btn-icon', () => {
      const overlay = el('div', 'mn-modal-overlay');
      const box = el('div', 'mn-modal mn-modal-wide');
      box.appendChild(el('div', 'mn-modal-title', 'version history (from Drive revisions)'));
      const status = el('div', 'mn-dim', 'scanning revisions…');
      box.appendChild(status);
      const list = el('div', 'mn-linklist');
      box.appendChild(list);
      overlay.appendChild(box);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);

      listNoteVersions(note.id, {
        onProgress: (done, total) => { status.textContent = `scanning revisions… ${done}/${total}`; },
      }).then((versions) => {
        const current = editor ? editor.getMarkdown() : note.body;
        status.textContent = versions.length
          ? 'distinct past versions of this note — restore sets the editor to that text (undoable):'
          : 'no past versions on Drive yet (revisions appear after syncs that changed this note).';
        for (const v of versions) {
          const row = el('div', 'mn-history-row');
          const when = v.modifiedTime ? new Date(v.modifiedTime).toLocaleString() : '?';
          const isCurrent = (v.body || '') === (current || '');
          const head = el('div', 'mn-history-head');
          head.appendChild(el('span', 'mn-history-when', `${esc(when)}${isCurrent ? ' <span class="mn-dim">(current)</span>' : ''}`));
          const snippet = el('div', 'mn-history-snippet');
          snippet.textContent = (v.body || '').slice(0, 120) || '(empty)';
          const rowActions = el('div', 'mn-history-actions');
          const viewBtn = btn('view', 'mn-btn-ghost mn-btn-sm', () => {
            let pre = row.querySelector('pre');
            if (pre) { pre.remove(); return; }
            pre = el('pre', 'mn-history-body');
            pre.textContent = v.body || '(empty)';
            row.appendChild(pre);
          });
          rowActions.appendChild(viewBtn);
          if (!isCurrent) {
            rowActions.appendChild(btn('restore', 'mn-btn-ghost mn-btn-sm', () => {
              confirmBox('Set the note to this version? (Undo with Ctrl-Z / the undo button.)', () => {
                overlay.remove();
                editor.setMarkdown(v.body || '');
                scheduleSave();
                editor.focus();
              });
            }));
          }
          head.appendChild(rowActions);
          row.appendChild(head);
          row.appendChild(snippet);
          list.appendChild(row);
        }
      }).catch((e) => { status.textContent = `history unavailable: ${e.message}`; });
    });
    histBtn.title = 'version history — past versions of this note from Drive revisions';
    actions.insertBefore(histBtn, pinBtn);
  }

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
    // Blank-page drawing: a generated paper attachment opened straight in the
    // annotation canvas (route change flushes the pending body autosave).
    const sketchBtn = btn('&#9998; sketch', 'mn-btn-ghost', () => {
      pickSketchPaper(async (paper) => {
        const att = await createSketchAttachment(note.id, paper);
        editor.insertImage(att.id, att.name || 'sketch');
        scheduleSave();
        pushPendingAttachments(); // no-op until Drive is connected
        navigate(`#note/${note.id}/annotate/${att.id}`);
      });
    });
    sketchBtn.title = 'draw on a blank page (pen, shapes, text)';
    strip.appendChild(sketchBtn);
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
        // Drop its inline image from the body too, else the reference goes dead
        // (renders here off the lingering local blob, "unavailable" elsewhere).
        if (editor?.removeImage(a.id)) scheduleSave();
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
    await flushPending();
    editor?.destroy();
  };

  // A brand-new empty note drops you straight into writing.
  if (!note.body) editor.focus();
}
