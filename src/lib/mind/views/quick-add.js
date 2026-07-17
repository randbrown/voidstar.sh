// Quick-add sheet — one-tap capture into an ongoing note (home chips,
// palette "Add to:" entries). Capture-then-file: the typed text is committed
// as its OWN note first (durable immediately), then filed into the target —
// if filing throws, the idea survives as a regular note instead of vanishing.

import * as store from '../store.js';
import { ongoingPrefs } from '../ongoing.js';
import { setOngoingPrefs, fileNoteInto } from '../ongoing-actions.js';
import { navigate, refresh } from '../app.js';
import { el, esc, btn } from '../ui.js';

export async function openQuickAdd(noteId) {
  const note = await store.getNote(noteId);
  if (!note || note.deletedAt) return;
  const prefs = ongoingPrefs(note);

  const overlay = el('div', 'mn-modal-overlay');
  const box = el('div', 'mn-modal');
  box.appendChild(el('div', 'mn-modal-title', `add to &ldquo;${esc(note.title)}&rdquo;`));

  const text = el('textarea', 'mn-input mn-quickadd-text');
  text.placeholder = 'capture… (Ctrl+Enter to add)';
  box.appendChild(text);

  // Per-note prefs, editable in place and persisted on commit.
  const opts = el('div', 'mn-quickadd-opts');
  const posSel = el('select', 'mn-select');
  for (const [v, label] of [['top', 'add to top'], ['bottom', 'add to end']]) {
    const o = el('option', '', label); o.value = v; posSel.appendChild(o);
  }
  posSel.value = prefs.position;
  opts.appendChild(posSel);
  const stampLab = el('label', 'mn-quickadd-toggle');
  const stampCb = el('input');
  stampCb.type = 'checkbox';
  stampCb.checked = prefs.stamp;
  stampLab.appendChild(stampCb);
  stampLab.appendChild(el('span', '', 'date stamp'));
  opts.appendChild(stampLab);
  box.appendChild(opts);

  const row = el('div', 'mn-modal-row');
  const cancel = btn('cancel', '', () => overlay.remove());
  const openBtn = btn('open note', 'mn-btn-ghost', () => commit(true));
  openBtn.title = 'open the full note (adds the text first if you typed any)';
  const addBtn = btn('add', 'mn-btn-primary', () => commit(false));
  row.appendChild(cancel);
  row.appendChild(openBtn);
  row.appendChild(addBtn);
  box.appendChild(row);

  // "open note" doubles as "add & open" once there's text — make that legible.
  const syncOpenLabel = () => { openBtn.innerHTML = text.value.trim() ? 'add &amp; open' : 'open note'; };
  text.addEventListener('input', syncOpenLabel);

  let committing = false;
  async function commit(thenOpen) {
    if (committing) return;
    committing = true;
    addBtn.disabled = openBtn.disabled = true;
    try {
      await setOngoingPrefs(note.id, { position: posSel.value, stamp: stampCb.checked });
      const raw = text.value.trim();
      if (raw) {
        // Durable capture first: the fragment note exists before filing starts.
        const fragment = store.createNote({
          folderId: note.folderId || '',
          title: await store.uniqueAutoTitle(),
          body: text.value.replace(/\s+$/, ''),
        });
        await store.putNoteRaw(fragment);
        await fileNoteInto(fragment.id, note.id);
      }
      overlay.remove();
      const view = location.hash.replace(/^#/, '').split('/')[0] || 'home';
      if (thenOpen) navigate(`#note/${note.id}`);
      // Refresh the list under the closed sheet so the entry shows up. Only
      // on home — refreshing an open editor would tear down its session.
      else if (view === 'home') refresh();
    } catch (e) {
      committing = false;
      addBtn.disabled = openBtn.disabled = false;
      alert(`add failed: ${e.message}\n(the text was kept as its own note)`);
    }
  }

  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(false); }
    if (e.key === 'Escape') overlay.remove();
  });

  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  text.focus();
}
