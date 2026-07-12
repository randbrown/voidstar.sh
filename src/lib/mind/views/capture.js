// Voice-capture view (`#capture/voice/note` and `#capture/voice/task`) — the
// target of the installed-PWA app-shortcuts ("voice note" / "voice todo").
// Launched by a user gesture (tapping the shortcut), so it tries to start
// capture immediately, shows a big live transcript, and on "done" commits a
// note or a task (running the shared capture parse so "buy milk tomorrow 9am"
// also sets a reminder).
//
// It uses the SAME robust path as the in-note voice bar (`voice-capture.js`):
// a MediaRecorder keeps the audio while Web Speech provides a live transcript.
// That matters because installed standalone PWAs on Android frequently can't
// run live Web Speech — the earlier version used dictation ONLY and swallowed
// every error, so a failed session looked like "the mic is dead" with nothing
// captured. Now the audio is always kept and, if the live transcript is empty,
// transcribed on-device with Whisper on finish, so the words are never lost.

import * as store from '../store.js';
import { navigate, refresh } from '../app.js';
import { currentFolderId } from './home.js';
import { createVoiceCapture, recordingSupported, getStoredMicId, storeMicId } from '../voice-capture.js';
import { isSupported as speechSupported } from '../voice.js';
import { wirePicker } from '../../qualia/devices.js';
import { addAttachmentFromBlob } from '../attachments.js';
import { pushPendingAttachments } from '../attachments-drive.js';
import { parseCapture } from '../capture.js';
import { armReminder } from '../reminders.js';
import { el, btn, topBar } from '../ui.js';

export async function renderCapture(root, mode, target) {
  // `mode` is reserved ('voice'); `target` is 'note' | 'task'.
  const isTask = target === 'task';
  root.appendChild(topBar(isTask ? 'voice todo' : 'voice note', '#home'));

  const canRecord = recordingSupported();
  const canTranscribe = speechSupported();

  if (!canRecord && !canTranscribe) {
    const warn = el('div', 'mn-empty',
      'voice capture isn’t supported in this browser. Open a note and type instead.');
    root.appendChild(warn);
    root.appendChild(btn('new note', 'mn-btn-primary', () => navigate('#home')));
    return;
  }

  const wrap = el('div', 'mn-capture');
  const live = el('div', 'mn-capture-live');
  live.textContent = 'starting…';
  wrap.appendChild(live);

  const statusLine = el('div', 'mn-capture-status', '');
  wrap.appendChild(statusLine);

  const hint = el('div', 'mn-capture-hint',
    isTask ? 'speak a task — e.g. “pick up prescription after 5pm”' : 'speak your note');
  wrap.appendChild(hint);

  // Inline mic picker — pick the input right here rather than navigating to
  // settings. Shown only when there's more than one mic (nothing to choose
  // otherwise); switching mid-recording restarts on the new device.
  const micSel = el('select', 'mn-select mn-mic-sel');
  const micRow = el('div', 'mn-capture-microw');
  micRow.appendChild(micSel);
  wrap.appendChild(micRow);

  // Mic toggle (tap-to-talk / stop) sits alongside done/cancel so a blocked
  // auto-start is always one tap from recovery.
  const micBtn = btn('&#127908; talk', 'mn-btn-primary mn-capture-mic');
  const finishBtn = btn('done', 'mn-btn-primary mn-capture-done');
  const cancelBtn = btn('cancel', 'mn-btn-ghost');
  const row = el('div', 'mn-capture-actions');
  row.appendChild(micBtn);
  row.appendChild(finishBtn);
  row.appendChild(cancelBtn);
  wrap.appendChild(row);
  root.appendChild(wrap);

  let finalText = '';
  let interim = '';
  let recording = false;
  let done = false;
  let capture = null;
  let speechFailed = false;
  let micPicker = null;

  const paint = () => {
    const shown = (finalText + ' ' + interim).trim();
    live.textContent = shown || (recording ? 'listening…' : 'tap the mic to talk');
  };
  const setStatus = (msg) => { statusLine.textContent = msg || ''; };

  async function startCapture() {
    if (recording || done) return;
    speechFailed = false;
    setStatus('');
    capture = createVoiceCapture({
      record: canRecord,
      transcribe: canTranscribe,
      onInterim: (t) => { interim = t; paint(); },
      onFinal: (t) => { finalText = (finalText + ' ' + t).trim(); interim = ''; paint(); },
      onError: (err) => {
        speechFailed = true;
        // Live transcription failing is survivable when we're still recording
        // audio (Whisper transcribes it on finish); only a hard mic denial is
        // worth alarming about.
        if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
          setStatus(canRecord
            ? 'live transcript off — recording audio, will transcribe on “done”'
            : 'microphone blocked — allow mic access, then tap the mic');
        }
      },
      onState: () => {},
    });
    try {
      await capture.start();
      recording = true;
      micBtn.innerHTML = '&#9209; stop';
      micBtn.classList.add('mn-recording');
      paint();
      // Permission is granted now, so device labels are available — refresh the
      // picker so real mic names (and any second mic) show up.
      micPicker?.populate(getStoredMicId() || undefined);
    } catch (e) {
      recording = false;
      capture = null;
      micBtn.innerHTML = '&#127908; talk';
      micBtn.classList.remove('mn-recording');
      live.textContent = 'tap the mic to talk';
      setStatus(`mic error: ${e.message} — check microphone permission`);
    }
  }

  async function stopCapture() {
    if (!recording || !capture) return null;
    recording = false;
    micBtn.disabled = true;
    let result = null;
    try { result = await capture.stop(); } catch {}
    capture = null;
    micBtn.disabled = false;
    micBtn.innerHTML = '&#127908; talk';
    micBtn.classList.remove('mn-recording');
    return result;
  }

  micBtn.addEventListener('click', async () => {
    if (recording) { await stopCapture(); paint(); }
    else { await startCapture(); }
  });

  // Restart capture on the freshly-picked device (accumulated transcript is
  // kept in view state; only the tiny pre-switch audio segment is dropped).
  async function restartForNewMic() {
    if (!recording || !capture) return;
    try { await capture.stop(); } catch {}
    capture = null;
    recording = false;
    micBtn.classList.remove('mn-recording');
    await startCapture();
  }

  micPicker = wirePicker({
    select: micSel,
    kind: 'audioinput',
    persist: false, // mind owns its own storage key (voidstar.mind.micId)
    getCurrentId: () => getStoredMicId(),
    onChoose: async (id) => { storeMicId(id); await restartForNewMic(); return id; },
  });
  micPicker.populate(getStoredMicId() || undefined);

  async function commit() {
    if (done) return;
    const result = recording ? await stopCapture() : null;

    const liveTranscript = (finalText + ' ' + interim).trim();
    let text = liveTranscript || (result?.transcript || '').trim();
    const audioBlob = result?.audioBlob || null;
    const durationSec = result?.durationSec || 0;
    const fromLive = !!liveTranscript;

    // No live transcript but we have audio → transcribe on-device with Whisper
    // so the spoken words aren't lost (the common Android-standalone case).
    if (!text && audioBlob) {
      setStatus('transcribing…');
      try {
        const { transcribeBlob, whisperSupported } = await import('../whisper.js');
        if (whisperSupported()) text = (await transcribeBlob(audioBlob, setStatus)).trim();
      } catch { /* fall through to audio-only handling */ }
      setStatus('');
    }

    if (!text && !audioBlob) {
      setStatus(speechFailed
        ? 'no speech captured — check mic permission and tap the mic to retry'
        : 'nothing captured yet — tap the mic and speak');
      return; // stay on the page so the capture isn't thrown away
    }

    done = true;
    const folderId = currentFolderId();

    if (isTask) {
      if (text) {
        const { text: taskText, remindAt } = parseCapture(text);
        const tl = await store.ensureFolderTasklist(folderId);
        const task = store.createTask(tl.id, taskText || text, {
          remindAt, remindStatus: remindAt ? 'scheduled' : '',
        });
        await store.putTaskRaw(task);
        if (remindAt) await armReminder(task); // requests permission in this gesture
        navigate(`#tasks/${tl.id}`);
        refresh();
      } else {
        // A task can't hold audio — rather than lose the recording, keep it as a
        // voice note and land the user there.
        const note = store.createNote({ folderId });
        await putNoteWithAudio(note, audioBlob, '', durationSec, false);
        navigate(`#note/${note.id}`);
      }
      return;
    }

    const note = store.createNote({ folderId, body: text });
    await putNoteWithAudio(note, audioBlob, text, durationSec, fromLive);
    navigate(`#note/${note.id}`);
  }

  // Persist a note and, when audio was kept, attach it with whatever transcript
  // we ended up with (source labeled so a later re-transcribe knows the origin).
  async function putNoteWithAudio(note, audioBlob, text, durationSec, fromLive) {
    await store.putNoteRaw(note);
    if (!audioBlob) return;
    const att = await addAttachmentFromBlob(note.id, audioBlob, `${store.fileStamp()}-voice`);
    const fresh = await store.getAttachment(att.id);
    await store.patchAttachment(fresh, {
      transcript: text || '',
      transcriptSource: text ? (fromLive ? 'webspeech' : 'whisper') : '',
      durationSec: Math.round(durationSec),
    });
    pushPendingAttachments();
  }

  function cancel() {
    if (done) return;
    done = true;
    if (capture) { try { capture.stop(); } catch {} }
    navigate('#home');
  }

  finishBtn.addEventListener('click', commit);
  cancelBtn.addEventListener('click', cancel);

  // Teardown if the user navigates away mid-capture.
  root._mnCleanup = async () => {
    done = true;
    if (capture) { try { await capture.stop(); } catch {} }
  };

  // Best-effort auto-start — the shortcut tap is the launch gesture. If the
  // platform blocks an ungestured start, the mic button recovers it on a tap.
  startCapture();
}
