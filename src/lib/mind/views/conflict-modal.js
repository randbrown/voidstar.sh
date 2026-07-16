// Conflict merge tool — resolve a "Conflicted copy of …" note against the live
// note it forked from. Shows a hunk-by-hunk diff (each hunk with a plain-English
// summary of what differs) and lets you pick, per change, which side's lines to
// keep; then writes the merged body onto the live note and trashes the copy.
// Identical or whitespace-only forks are called out, with discard as the
// resolution.
//
// Opened by tapping the amber "conflict" badge on a note card (home.js), or the
// "resolve conflicts" button in Settings → data.

import { el, esc, btn, confirmBox } from '../ui.js';
import * as store from '../store.js';
import { diffBlocks, applyMerge, blockIsInvisible, describeChange } from '../merge.js';
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

  if (baseGone) {
    boxEl.appendChild(el('div', 'mn-note-meta', 'the original note is gone — keep this copy as its own note, or discard it.'));
    renderOrphanCopy(overlay, boxEl, copy);
    overlay.appendChild(boxEl);
    document.body.appendChild(overlay);
    return;
  }

  boxEl.appendChild(el('div', 'mn-note-meta',
    `“${esc(base.title)}” was edited in two places at once, so both versions were kept:`));

  // Name the two sides once, in the same colors the hunks use below. The
  // copy's title carries where/when the losing version came from.
  const copySrc = (copy.title.match(/\(([^()]+)\)\s*$/) || [])[1];
  const legend = el('div', 'mn-conflict-legend');
  const legendRow = (chipCls, chip, text) => {
    const r = el('div', 'mn-conflict-legend-row');
    r.appendChild(el('span', `mn-conflict-chip ${chipCls}`, chip));
    r.appendChild(el('span', '', text));
    return r;
  };
  legend.appendChild(legendRow('mn-diff-del', 'current', 'the note as it is on this device right now.'));
  legend.appendChild(legendRow('mn-diff-add', 'copy', `the other version${copySrc ? ` (from ${esc(copySrc)})` : ''}, saved aside so it wasn’t lost.`));
  boxEl.appendChild(legend);

  const blocks = diffBlocks(base.body, copy.body);
  const changeBlocks = blocks.filter((b) => b.type === 'change');
  const changeIdx = blocks.map((b, i) => (b.type === 'change' ? i : -1)).filter((i) => i >= 0);
  const choices = {}; // blockIndex → 'base' | 'copy' | 'both'
  const redraws = []; // per-hunk toggle repaint fns (so bulk pickers restyle in place)

  // Identical bodies (e.g. only titles/tags forked) — nothing to merge, just
  // clear the copy. Say so instead of showing an empty diff and a merge button.
  const identical = !changeBlocks.length;
  if (identical) {
    boxEl.appendChild(el('div', 'mn-conflict-banner',
      'good news: both versions have exactly the same text — there is nothing to merge. discard the copy to clear the conflict; the note itself won’t change.'));
  } else if (changeBlocks.every(blockIsInvisible)) {
    boxEl.appendChild(el('div', 'mn-conflict-banner',
      'the two versions differ only by blank lines or spacing — the visible text is identical, so discarding the copy loses nothing.'));
  }
  if (!identical) {
    boxEl.appendChild(el('div', 'mn-conflict-hint',
      'each box below is one difference. pick what to keep for each, then “merge & resolve” writes the result to the note and removes the copy.'));
  }

  const diffWrap = el('div', 'mn-diff');
  // Blank / whitespace-only lines get a visible placeholder — an empty
  // highlighted bar looks like a rendering glitch, not a difference.
  const diffLine = (ln, cls) => (ln.trim()
    ? el('div', `mn-diff-line ${cls}`, esc(ln))
    : el('div', `mn-diff-line ${cls} mn-diff-blankline`, '(blank line)'));
  blocks.forEach((blk, idx) => {
    if (blk.type === 'same') {
      // Collapse long context runs so the diff stays scannable on a phone.
      const lines = blk.base;
      const show = lines.length > 6 ? [...lines.slice(0, 2), '⋯', ...lines.slice(-2)] : lines;
      for (const ln of show) diffWrap.appendChild(el('div', 'mn-diff-ctx', ln === '⋯' ? '⋯' : esc(ln) || '&nbsp;'));
      return;
    }
    const hunk = el('div', 'mn-diff-hunk');
    hunk.appendChild(el('div', 'mn-diff-summary', esc(describeChange(blk))));
    const baseCol = el('div', 'mn-diff-side mn-diff-base');
    baseCol.appendChild(el('div', 'mn-diff-label', 'current'));
    for (const ln of blk.base) baseCol.appendChild(diffLine(ln, 'mn-diff-del'));
    if (!blk.base.length) baseCol.appendChild(el('div', 'mn-diff-line mn-dim', '(nothing on this side)'));
    const copyCol = el('div', 'mn-diff-side mn-diff-copy');
    copyCol.appendChild(el('div', 'mn-diff-label', 'copy'));
    for (const ln of blk.copy) copyCol.appendChild(diffLine(ln, 'mn-diff-add'));
    if (!blk.copy.length) copyCol.appendChild(el('div', 'mn-diff-line mn-dim', '(nothing on this side)'));
    hunk.append(baseCol, copyCol);

    // Choices in plain words. When one side is empty, "keep both" is redundant
    // (it equals the non-empty side) so it's dropped, and the two remaining
    // options say what actually happens instead of naming sides.
    const one = (blk.base.length || blk.copy.length) === 1;
    const opts = !blk.base.length
      ? [['base', one ? 'leave it out' : 'leave them out'], ['copy', one ? 'add it' : 'add them']]
      : !blk.copy.length
        ? [['base', one ? 'keep it' : 'keep them'], ['copy', one ? 'remove it' : 'remove them']]
        : [['base', 'keep current'], ['copy', 'use copy'], ['both', 'keep both']];
    const toggle = el('div', 'mn-diff-toggle');
    const drawToggle = () => {
      toggle.innerHTML = '';
      // A bulk "all: both" can land on a hunk that doesn't offer 'both'; it
      // merges as the non-empty side there, so highlight that option.
      let cur = choices[idx] || 'base';
      if (cur === 'both' && (!blk.base.length || !blk.copy.length)) cur = blk.base.length ? 'base' : 'copy';
      for (const [val, label] of opts) {
        const on = cur === val;
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
  const discard = () => {
    confirmBox(identical
      ? 'Discard the identical copy? The note stays exactly as it is.'
      : 'Discard this conflicted copy? The current note is kept as-is and the copy’s differences are thrown away.', async () => {
      await store.trashNote(copy);
      overlay.remove();
      afterResolve(remaining - 1);
    });
  };
  // Identical bodies: discarding IS the resolution — no merge button to
  // second-guess (merging would be a no-op that only bumps updatedAt).
  footer.appendChild(btn('discard copy', identical ? 'mn-btn-primary' : 'mn-btn-ghost', discard));
  if (!identical) {
    footer.appendChild(btn('merge & resolve', 'mn-btn-primary', async () => {
      const mergedBody = applyMerge(blocks, (i) => choices[i]);
      await store.putNote({ ...base, body: mergedBody });
      await store.trashNote(copy);
      overlay.remove();
      afterResolve(remaining - 1);
    }));
  }
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
