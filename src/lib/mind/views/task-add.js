// The task quick-add row, shared by the home TODO card and the tasks view
// (they had drifted copies of the same handler).
//
// Two things this row has to get right, both of them past bugs:
//
//   1. **Enter always does something visible.** It used to `await armReminder()`
//      — which asks for notification permission — BEFORE re-rendering. A
//      permission prompt that sits unanswered (or a quiet-UI browser that never
//      resolves it) left the await pending forever: the task was already saved,
//      but nothing on screen changed, so Enter looked dead. Hitting Enter again
//      minted another copy each time, and they all appeared at once on the next
//      re-render. Now the row saves, clears, re-renders and refocuses
//      immediately; arming the reminder rides along un-awaited.
//   2. **The "when" parse is visible before you commit it.** parseCapture pulls
//      a time expression OUT of the text ("call mom tomorrow 9am" → a task
//      "call mom" with a 9am reminder). That is the feature, but silently
//      deleting words is alarming when it misfires, so the hint line below the
//      box shows exactly what will be created while you type.

import * as store from '../store.js';
import { parseCapture } from '../capture.js';
import { armReminder } from '../reminders.js';
import { attachBlobsToTask, imagePicker, imagesFromEvent, pendingLabel } from './task-attach.js';
import { el, esc, btn } from '../ui.js';

function whenLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * Build the add row.
 *
 * @param {object} opts
 *   placeholder — input placeholder
 *   ensureList  — async () => tasklist the new task belongs to
 *   onAdded     — called after the task lands (re-render); the caller decides
 *                 where focus goes afterwards (see `focus`)
 * @returns {{el: HTMLElement, focus: function}}
 */
export function taskAddRow({ placeholder = 'add a task…', ensureList, onAdded }) {
  const wrap = el('div', 'mn-todo-add');
  const row = el('div', 'mn-todo-addrow');
  const input = el('input', 'mn-input');
  input.type = 'text';
  input.placeholder = placeholder;
  row.appendChild(input);

  // Screenshots staged before the task exists: paste/pick now, they attach to
  // the task Enter creates.
  let pending = [];
  const picker = imagePicker(async (files) => { pending.push(...files); drawHint(); });
  const camBtn = btn('&#128247;', 'mn-btn-ghost mn-task-attach', () => picker.click());
  camBtn.title = 'attach a screenshot to this task (or just paste one here)';
  row.appendChild(camBtn);
  row.appendChild(picker);
  wrap.appendChild(row);

  const hint = el('div', 'mn-todo-addhint');
  wrap.appendChild(hint);

  function drawHint() {
    const raw = input.value.trim();
    const bits = [];
    if (raw) {
      const { text, remindAt } = parseCapture(raw);
      // Only worth showing when the parse CHANGES the line — otherwise it's
      // noise under every keystroke.
      if (remindAt) {
        bits.push(`&#9200; ${esc(whenLabel(remindAt))}`);
        if ((text || raw) !== raw) bits.push(`task: &ldquo;${esc(text || raw)}&rdquo;`);
      }
    }
    if (pending.length) bits.push(pendingLabel(pending.length));
    hint.innerHTML = bits.join(' &middot; ');
    hint.hidden = !bits.length;
  }
  drawHint();

  input.addEventListener('input', drawHint);

  // Paste a screenshot straight into the box (the common capture flow: snip,
  // Ctrl+V, type what's wrong with it, Enter). Text pastes fall through.
  input.addEventListener('paste', (e) => {
    const imgs = imagesFromEvent(e);
    if (!imgs.length) return;
    e.preventDefault();
    pending.push(...imgs);
    drawHint();
  });

  let busy = false;
  async function submit() {
    if (busy) return;
    const raw = input.value.trim();
    const imgs = pending;
    if (!raw && !imgs.length) return;
    busy = true;
    // Clear FIRST: the row is about to be re-rendered anyway, and an input that
    // empties the instant you hit Enter is the feedback that was missing.
    input.value = '';
    pending = [];
    drawHint();
    try {
      const { text, remindAt } = parseCapture(raw);
      const tl = await ensureList();
      const task = store.createTask(tl.id, text || raw || 'screenshot', {
        remindAt, remindStatus: remindAt ? 'scheduled' : '',
      });
      await store.putTaskRaw(task);
      // Un-awaited on purpose — see the header note. Enter is still the user
      // gesture the permission prompt needs; we just don't block the UI on the
      // answer.
      if (remindAt) armReminder(task).catch(() => {});
      if (imgs.length) await attachBlobsToTask(task, imgs);
    } finally {
      busy = false;
    }
    onAdded?.();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
  });

  return { el: wrap, focus: () => input.focus() };
}
