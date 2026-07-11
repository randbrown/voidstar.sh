// Conflict merge tool — resolve a "Conflicted copy of …" note against the live
// note it forked from. Shows a hunk-by-hunk diff and lets you pick, per change,
// whether to keep the current version, take the copy's lines, or keep both;
// then writes the merged body onto the live note and trashes the copy.
//
// Opened by tapping the amber "conflict" badge on a note card (home.js), or the
// "resolve conflicts" button in Settings → data.

import { el, esc, btn, confirmBox } from '../ui.js';
import * as store from '../store.js';
import { diffBlocks, applyMerge, bodiesDiffer } from '../merge.js';
import { refresh } from '../app.js';

// Find every live conflicted copy (a note with conflictOf set), newest first.
export async function listConflicts() {
  const notes = await store.getAllNotes();
  return notes
    .filter((n) => !n.deletedAt && n.conflictOf)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// Resolve one copy. `copyId` is the conflicted copy's id (what the badge sits
// on). Falls back to a chooser when opened without a specific copy.
export async function openConflictModal(copyId) {
  const copies = await listConflicts();
  if (!copies.length) { alert('no conflicts to resolve.'); return; }

  let copy = copyId ? copies.find((c) => c.id === copyId) : null;
  if (!copy) {
    if (copies.length === 1) copy = copies[0];
    else return openConflictChooser(copies);
  }
  const base = await store.getNote(copy.conflictOf);
  renderMergeModal(base, copy, copies.length);
}

// When several conflicts exist and none was targeted, list them to pick one.
async function openConflictChooser(copies) {
  const overlay = el('div', 'mn-modal-overlay');
  const box = el('div', 'mn-modal');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  box.appendChild(el('div', 'mn-modal-title', `${copies.length} conflicts to resolve`));
  box.appendChild(el('div', 'mn-note-meta', 'pick one to review and merge.'));
  const listEl = el('div', 'mn-conflict-picklist');
  for (const c of copies) {
    const base = await store.getNote(c.conflictOf);
    const r = btn(
      `<span class="mn-conflict-pickname">${esc((base && !base.deletedAt) ? base.title : c.title)}</span>`,
      'mn-btn-ghost mn-conflict-pickrow',
      () => { overlay.remove(); renderMergeModal(base, c, copies.length); },
    );
    listEl.appendChild(r);
  }
  box.appendChild(listEl);
  const row = el('div', 'mn-modal-row');
  row.appendChild(btn('close', '', () => overlay.remove()));
  box.appendChild(row);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function renderMergeModal(base, copy, remaining) {
  const overlay = el('div', 'mn-modal-overlay');
  const boxEl = el('div', 'mn-modal mn-modal-wide');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // The live note may have been deleted on this device since the copy was made.
  const baseGone = !base || base.deletedAt;

  boxEl.appendChild(el('div', 'mn-modal-title', 'resolve conflict'));
  boxEl.appendChild(el('div', 'mn-note-meta', baseGone
    ? 'the original note is gone — keep this copy as its own note, or discard it.'
    : `two versions of “${esc(base.title)}” diverged. choose which lines to keep, then merge.`));

  if (baseGone) {
    renderOrphanCopy(overlay, boxEl, copy);
    overlay.appendChild(boxEl);
    document.body.appendChild(overlay);
    return;
  }

  const blocks = diffBlocks(base.body, copy.body);
  const changeIdx = blocks.map((b, i) => (b.type === 'change' ? i : -1)).filter((i) => i >= 0);
  const choices = {}; // blockIndex → 'base' | 'copy' | 'both'
  const redraws = []; // per-hunk toggle repaint fns (so bulk pickers restyle in place)

  if (!bodiesDiffer(base.body, copy.body)) {
    // Identical bodies (e.g. only titles/tags forked) — nothing to merge, just
    // clear the copy.
    boxEl.appendChild(el('div', 'mn-note-meta mn-dim', 'the two bodies are identical — you can safely discard the copy.'));
  }

  const diffWrap = el('div', 'mn-diff');
  blocks.forEach((blk, idx) => {
    if (blk.type === 'same') {
      // Collapse long context runs so the diff stays scannable on a phone.
      const lines = blk.base;
      const show = lines.length > 6 ? [...lines.slice(0, 2), '⋯', ...lines.slice(-2)] : lines;
      for (const ln of show) diffWrap.appendChild(el('div', 'mn-diff-ctx', ln === '⋯' ? '⋯' : esc(ln) || '&nbsp;'));
      return;
    }
    const hunk = el('div', 'mn-diff-hunk');
    const baseCol = el('div', 'mn-diff-side mn-diff-base');
    baseCol.appendChild(el('div', 'mn-diff-label', 'current'));
    for (const ln of blk.base) baseCol.appendChild(el('div', 'mn-diff-line mn-diff-del', esc(ln) || '&nbsp;'));
    if (!blk.base.length) baseCol.appendChild(el('div', 'mn-diff-line mn-dim', '(nothing)'));
    const copyCol = el('div', 'mn-diff-side mn-diff-copy');
    copyCol.appendChild(el('div', 'mn-diff-label', 'copy'));
    for (const ln of blk.copy) copyCol.appendChild(el('div', 'mn-diff-line mn-diff-add', esc(ln) || '&nbsp;'));
    if (!blk.copy.length) copyCol.appendChild(el('div', 'mn-diff-line mn-dim', '(nothing)'));
    hunk.append(baseCol, copyCol);

    const toggle = el('div', 'mn-diff-toggle');
    const opts = [['base', 'keep current'], ['copy', 'use copy'], ['both', 'keep both']];
    const drawToggle = () => {
      toggle.innerHTML = '';
      for (const [val, label] of opts) {
        const on = (choices[idx] || 'base') === val;
        toggle.appendChild(btn(label, `mn-btn-ghost mn-diff-choice ${on ? 'mn-diff-choice-on' : ''}`, () => {
          choices[idx] = val; drawToggle();
        }));
      }
    };
    drawToggle();
    redraws.push(drawToggle);
    hunk.appendChild(toggle);
    diffWrap.appendChild(hunk);
  });
  boxEl.appendChild(diffWrap);

  // Bulk pickers for a fast "take all of one side" — restyle the toggles in
  // place so the current selection state is never thrown away.
  const bulk = el('div', 'mn-actions');
  const setAll = (val) => { for (const i of changeIdx) choices[i] = val; redraws.forEach((fn) => fn()); };
  if (changeIdx.length > 1) {
    bulk.append(
      btn('all: current', 'mn-btn-ghost', () => setAll('base')),
      btn('all: copy', 'mn-btn-ghost', () => setAll('copy')),
      btn('all: both', 'mn-btn-ghost', () => setAll('both')),
    );
    boxEl.appendChild(bulk);
  }

  const footer = el('div', 'mn-modal-row');
  footer.appendChild(btn('cancel', '', () => overlay.remove()));
  footer.appendChild(btn('discard copy', 'mn-btn-ghost', () => {
    confirmBox('Discard this conflicted copy? The current note is unchanged.', async () => {
      await store.trashNote(copy);
      overlay.remove();
      afterResolve(remaining - 1);
    });
  }));
  footer.appendChild(btn('merge & resolve', 'mn-btn-primary', async () => {
    const mergedBody = applyMerge(blocks, (i) => choices[i]);
    await store.putNote({ ...base, body: mergedBody });
    await store.trashNote(copy);
    overlay.remove();
    afterResolve(remaining - 1);
  }));
  boxEl.appendChild(footer);

  overlay.appendChild(boxEl);
  document.body.appendChild(overlay);
}

// The base note is gone: offer to keep the copy standalone (clear its conflict
// flag) or discard it.
function renderOrphanCopy(overlay, boxEl, copy) {
  const preview = el('div', 'mn-diff');
  for (const ln of String(copy.body || '').split('\n').slice(0, 40)) {
    preview.appendChild(el('div', 'mn-diff-ctx', esc(ln) || '&nbsp;'));
  }
  boxEl.appendChild(preview);
  const footer = el('div', 'mn-modal-row');
  footer.appendChild(btn('cancel', '', () => overlay.remove()));
  footer.appendChild(btn('discard copy', 'mn-btn-ghost', () => {
    confirmBox('Discard this copy?', async () => { await store.trashNote(copy); overlay.remove(); afterResolve(0); });
  }));
  footer.appendChild(btn('keep as note', 'mn-btn-primary', async () => {
    const title = copy.title.replace(/^Conflicted copy of\s+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    await store.putNote({ ...copy, conflictOf: '', title: title || copy.title });
    overlay.remove();
    afterResolve(0);
  }));
  boxEl.appendChild(footer);
}

function afterResolve(remaining) {
  if (remaining > 0) openConflictModal();
  else refresh();
}
