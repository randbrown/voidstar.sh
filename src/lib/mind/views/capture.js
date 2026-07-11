// Voice-capture view (`#capture/voice/note` and `#capture/voice/task`) — the
// target of the installed-PWA app-shortcuts ("voice note" / "voice todo").
// Launched by a user gesture (tapping the shortcut), so it starts dictation
// immediately, shows a big live transcript, and on stop commits a note or a
// task (running the shared capture parse so "buy milk tomorrow 9am" also sets a
// reminder). Reuses the existing Web Speech dictation in voice.js.

import * as store from '../store.js';
import { navigate, refresh } from '../app.js';
import { currentFolderId } from './home.js';
import { createDictation, isSupported } from '../voice.js';
import { parseCapture } from '../capture.js';
import { armReminder } from '../reminders.js';
import { el, btn, topBar } from '../ui.js';

export async function renderCapture(root, mode, target) {
  // `mode` is reserved ('voice'); `target` is 'note' | 'task'.
  const isTask = target === 'task';
  root.appendChild(topBar(isTask ? 'voice todo' : 'voice note', '#home'));

  if (!isSupported()) {
    const warn = el('div', 'mn-empty',
      'voice dictation isn’t supported in this browser. Open a note and type instead.');
    root.appendChild(warn);
    root.appendChild(btn('new note', 'mn-btn-primary', () => navigate('#home')));
    return;
  }

  const wrap = el('div', 'mn-capture');
  const live = el('div', 'mn-capture-live');
  live.textContent = 'listening…';
  wrap.appendChild(live);

  const hint = el('div', 'mn-capture-hint',
    isTask ? 'speak a task — e.g. “pick up prescription after 5pm”' : 'speak your note');
  wrap.appendChild(hint);

  const finishBtn = btn('done', 'mn-btn-primary mn-capture-done');
  const cancelBtn = btn('cancel', 'mn-btn-ghost');
  const row = el('div', 'mn-capture-actions');
  row.appendChild(finishBtn);
  row.appendChild(cancelBtn);
  wrap.appendChild(row);
  root.appendChild(wrap);

  // Accumulate finalized chunks; show them plus the live interim tail.
  let finalText = '';
  let interim = '';
  let done = false;

  const paint = () => {
    const shown = (finalText + ' ' + interim).trim();
    live.textContent = shown || 'listening…';
  };

  const dictation = createDictation({
    onFinal: (t) => { finalText = (finalText + ' ' + t).trim(); interim = ''; paint(); },
    onInterim: (t) => { interim = t; paint(); },
    onError: () => { /* restart loop / record-only handled in voice.js */ },
    onState: () => {},
  });

  async function commit() {
    if (done) return;
    done = true;
    dictation.stop();
    const raw = (finalText + ' ' + interim).trim();
    if (!raw) { navigate('#home'); return; }

    const folderId = currentFolderId();
    if (isTask) {
      const { text, remindAt } = parseCapture(raw);
      const tl = await store.ensureFolderTasklist(folderId);
      const task = store.createTask(tl.id, text || raw, {
        remindAt,
        remindStatus: remindAt ? 'scheduled' : '',
      });
      await store.putTaskRaw(task);
      if (remindAt) await armReminder(task); // requests permission in this gesture
      // Land on the task list so the new item (and its reminder badge) is visible.
      navigate(`#tasks/${tl.id}`);
      refresh();
    } else {
      const note = store.createNote({ folderId, body: raw });
      await store.putNoteRaw(note);
      navigate(`#note/${note.id}`);
    }
  }

  function cancel() {
    if (done) return;
    done = true;
    dictation.stop();
    navigate('#home');
  }

  finishBtn.addEventListener('click', commit);
  cancelBtn.addEventListener('click', cancel);

  // Teardown if the user navigates away mid-capture.
  root._mnCleanup = async () => { done = true; try { dictation.stop(); } catch {} };

  dictation.start();
}
