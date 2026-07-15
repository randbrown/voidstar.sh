// Import-a-document modal: paste / upload / pick-from-Drive a markdown or
// plain-text document, split it into notes with a live preview, then commit.
// Opened from Settings → data → "import document…".

import { el, esc, btn, confirmBox } from '../ui.js';
import { parseDocIntoNotes, parseBatchIntoNotes, markDuplicates, commitDocImport } from '../import-doc.js';
import { pickerAvailable } from '../gdrive-picker.js';
import * as store from '../store.js';
import { navigate } from '../app.js';

const PREVIEW_CAP = 100;

// Local calendar day of an epoch-ms stamp, for the preview date badge.
function isoDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// One-line plain-text snippet of a note body (no prosemirror dependency).
function snippet(body) {
  const s = String(body || '')
    .replace(/<!--[^>]*-->/g, '')
    .replace(/[#>*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

export async function openImportDocModal() {
  const [notes, folders] = await Promise.all([store.getAllNotes(), store.getAllFolders()]);

  const overlay = el('div', 'mn-modal-overlay');
  const box = el('div', 'mn-modal mn-modal-wide');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  box.appendChild(el('div', 'mn-modal-title', 'import document'));
  box.appendChild(el('div', 'mn-note-meta',
    'split one document into notes. dated section headers become each note’s date. best source: Google Docs → File → Download → Markdown (.md).'));

  // Batch state: docs picked via "pick multiple from Drive…" ([{name,text,
  // modifiedMs,createdMs}]). When set, the preview comes from the batch, not
  // the textarea.
  let batchDocs = null;
  // Real metadata of the current single-source doc when it came from Drive or a
  // file upload (0/'' = unknown, e.g. paste): last-edit time drives newer-than
  // detection + the note's updatedAt, created time a whole-doc note's
  // createdAt, and the filename titles a whole-doc note.
  let srcModified = 0;
  let srcCreated = 0;
  let srcName = '';

  // ── Source ──
  const paste = el('textarea', 'mn-input mn-doc-paste');
  paste.placeholder = 'paste your document here, or choose a file / pick from Drive below…';
  box.appendChild(paste);

  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.md,.markdown,.txt,text/markdown,text/plain';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (f) {
      clearBatch(false);
      srcModified = f.lastModified || 0;
      srcCreated = 0; // browsers don't expose a file's creation time
      srcName = f.name || '';
      paste.value = await f.text();
      schedule();
    }
    fileInput.value = '';
  });

  const srcRow = el('div', 'mn-actions');
  srcRow.appendChild(fileInput);
  srcRow.appendChild(btn('choose file…', 'mn-btn-ghost', () => fileInput.click()));
  if (pickerAvailable()) {
    const pickBtn = btn('pick from Drive…', 'mn-btn-ghost', async () => {
      pickBtn.disabled = true;
      const prev = pickBtn.textContent;
      pickBtn.textContent = 'opening Drive…';
      try {
        const { importFromDrive } = await import('../gdrive-picker.js');
        const res = await importFromDrive();
        if (res) {
          clearBatch(false);
          srcModified = res.modifiedMs || 0;
          srcCreated = res.createdMs || 0;
          srcName = res.name || '';
          paste.value = res.text;
          schedule();
        }
      } catch (e) {
        alert(`Drive import failed: ${e.message}`);
      } finally { pickBtn.disabled = false; pickBtn.textContent = prev; }
    });
    srcRow.appendChild(pickBtn);

    const batchBtn = btn('pick multiple from Drive…', 'mn-btn-ghost', async () => {
      batchBtn.disabled = true;
      const prev = batchBtn.textContent;
      batchBtn.textContent = 'opening Drive…';
      try {
        const { importDocsFromDrive } = await import('../gdrive-picker.js');
        const docs = await importDocsFromDrive();
        if (docs && docs.length) { batchDocs = docs; paste.value = ''; syncBatchBar(); schedule(); }
      } catch (e) {
        alert(`Drive import failed: ${e.message}`);
      } finally { batchBtn.disabled = false; batchBtn.textContent = prev; }
    });
    srcRow.appendChild(batchBtn);
  }
  box.appendChild(srcRow);

  // ── Batch bar (shown only once multiple Drive docs are loaded) ──
  const batchBar = el('div', 'mn-import-batchbar');
  batchBar.style.display = 'none';
  const batchInfo = el('span', 'mn-import-batchinfo');
  const combineWrap = el('label', 'mn-import-check');
  const combineCb = el('input'); combineCb.type = 'checkbox';
  combineWrap.appendChild(combineCb);
  combineWrap.appendChild(document.createTextNode(' combine whole batch into one note'));
  const clearBatchBtn = btn('clear', 'mn-btn-ghost', () => { clearBatch(true); });
  batchBar.append(batchInfo, combineWrap, clearBatchBtn);
  box.appendChild(batchBar);

  // Reflect the current batch in the UI: show the bar + hide the textarea while a
  // batch is loaded, restore the textarea otherwise.
  function syncBatchBar() {
    const on = !!(batchDocs && batchDocs.length);
    batchBar.style.display = on ? '' : 'none';
    paste.style.display = on ? 'none' : '';
    if (on) batchInfo.textContent = `${batchDocs.length} document${batchDocs.length === 1 ? '' : 's'} loaded from Drive`;
  }

  // Drop the loaded batch and return to single-source mode.
  function clearBatch(rerender) {
    batchDocs = null;
    combineCb.checked = false;
    syncBatchBar();
    if (rerender) { levelVisibility(); schedule(); }
  }

  // ── Options ──
  const opts = el('div', 'mn-import-opts');

  const modeSel = el('select', 'mn-select');
  for (const [v, l] of [['auto', 'split: auto'], ['headings', 'split: headings'], ['dates', 'split: date lines'], ['single', 'split: none (one note)']]) {
    const o = el('option'); o.value = v; o.textContent = l; modeSel.appendChild(o);
  }
  const levelSel = el('select', 'mn-select');
  for (const [v, l] of [['auto', 'level: auto'], ['1', 'level: #'], ['2', 'level: ##'], ['3', 'level: ###']]) {
    const o = el('option'); o.value = v; o.textContent = l; levelSel.appendChild(o);
  }
  const folderSel = el('select', 'mn-select');
  {
    const none = el('option'); none.value = ''; none.textContent = 'folder: (none)'; folderSel.appendChild(none);
    for (const f of folders.slice().sort((a, b) => store.folderPath(folders, a.id).localeCompare(store.folderPath(folders, b.id)))) {
      const o = el('option'); o.value = f.id; o.textContent = `folder: ${store.folderPath(folders, f.id)}`; folderSel.appendChild(o);
    }
    const nw = el('option'); nw.value = '__new__'; nw.textContent = 'folder: new…'; folderSel.appendChild(nw);
  }
  const newFolderInput = el('input', 'mn-input');
  newFolderInput.type = 'text';
  newFolderInput.placeholder = 'new folder name';
  newFolderInput.style.display = 'none';
  folderSel.addEventListener('change', () => {
    newFolderInput.style.display = folderSel.value === '__new__' ? '' : 'none';
    schedule(); // target folder changes which existing notes a title can match
  });

  const tagInput = el('input', 'mn-input');
  tagInput.type = 'text';
  tagInput.placeholder = 'tag all (optional)';

  const preambleWrap = el('label', 'mn-import-check');
  const preambleCb = el('input'); preambleCb.type = 'checkbox'; preambleCb.checked = true;
  preambleWrap.appendChild(preambleCb); preambleWrap.appendChild(document.createTextNode(' keep intro'));

  const dailyWrap = el('label', 'mn-import-check');
  const dailyCb = el('input'); dailyCb.type = 'checkbox'; dailyCb.checked = true;
  dailyWrap.appendChild(dailyCb); dailyWrap.appendChild(document.createTextNode(' date-only → daily note'));

  // Filesystem-style upsert: a note with the same title in the target folder (or
  // the same daily date) is refreshed in place instead of duplicated, so
  // re-importing the same Doc updates rather than piles up.
  const upsertWrap = el('label', 'mn-import-check');
  const upsertCb = el('input'); upsertCb.type = 'checkbox'; upsertCb.checked = true;
  upsertWrap.appendChild(upsertCb); upsertWrap.appendChild(document.createTextNode(' update matching notes'));

  opts.append(modeSel, levelSel, folderSel, newFolderInput, tagInput, preambleWrap, dailyWrap, upsertWrap);
  box.appendChild(opts);

  // When the whole batch is being merged into one note, the per-document split
  // controls don't apply — grey them out so it's clear they're bypassed.
  const combineActive = () => !!(batchDocs && batchDocs.length && combineCb.checked);
  const levelVisibility = () => {
    const merged = combineActive();
    modeSel.disabled = merged;
    levelSel.disabled = merged;
    levelSel.style.display = (modeSel.value === 'dates' || modeSel.value === 'single') ? 'none' : '';
  };
  levelVisibility();
  for (const ctrl of [modeSel, levelSel, preambleCb, dailyCb, combineCb, upsertCb]) {
    ctrl.addEventListener('change', () => { levelVisibility(); schedule(); });
  }

  // ── Preview + footer ──
  const summary = el('div', 'mn-import-summary');
  const list = el('div', 'mn-import-list');
  box.appendChild(summary);
  box.appendChild(list);

  const footer = el('div', 'mn-modal-row');
  const cancel = btn('cancel', '', () => overlay.remove());
  const importBtn = btn('import', 'mn-btn-primary', () => doImport());
  footer.append(cancel, importBtn);
  box.appendChild(footer);

  let parsed = { sections: [] };

  function currentOpts() {
    return {
      mode: modeSel.value,
      headingLevel: levelSel.value,
      keepPreamble: preambleCb.checked,
      markDailies: dailyCb.checked,
    };
  }

  // Target folder id for title matching. A brand-new folder (or none chosen)
  // holds no existing notes, so `undefined` disables title matching there.
  function matchFolderId() {
    return folderSel.value === '__new__' ? undefined : folderSel.value;
  }

  function updateCount() {
    const n = parsed.sections.filter((s) => !s.skip).length;
    const upd = parsed.sections.filter((s) => !s.skip && s.upsertId).length;
    const label = upd && upd < n ? `import ${n} (${upd} update${upd === 1 ? '' : 's'})`
      : upd && upd === n ? `update ${n} note${n === 1 ? '' : 's'}`
      : n ? `import ${n} note${n === 1 ? '' : 's'}` : 'import';
    importBtn.textContent = label;
    importBtn.disabled = n === 0;
  }

  // Build `parsed` from whichever source is active (a loaded Drive batch, else
  // the textarea), then annotate duplicate/upsert state against existing notes.
  function computeParsed() {
    if (batchDocs && batchDocs.length) {
      return parseBatchIntoNotes(batchDocs, { ...currentOpts(), combine: combineCb.checked });
    }
    if (!paste.value.trim()) return null;
    const p = parseDocIntoNotes(paste.value, { ...currentOpts(), sourceName: srcName });
    for (const s of p.sections) {
      if (srcModified) s.srcModified = srcModified;
      if (srcCreated) s.srcCreated = srcCreated;
    }
    return p;
  }

  function render() {
    const p = computeParsed();
    if (!p) {
      parsed = { sections: [], stats: { total: 0 }, warnings: [] };
      summary.textContent = 'paste or choose a document above.';
      list.innerHTML = '';
      updateCount();
      return;
    }
    parsed = p;
    markDuplicates(parsed.sections, notes, { matchByTitle: upsertCb.checked, folderId: matchFolderId() });

    const { stats, mode, headingLevel, warnings } = parsed;
    const modeLabel = mode === 'combine' ? 'one note (whole batch)'
      : mode === 'batch' ? 'split per settings'
      : mode === 'headings' ? `headings${headingLevel ? `(${'#'.repeat(headingLevel)})` : ''}`
      : mode === 'export' ? 'mind export' : mode === 'single' ? 'one note (no split)' : 'date lines';
    const updates = parsed.sections.filter((s) => s.upsertId).length;
    const newerN = parsed.sections.filter((s) => s.newerExists).length;
    const docHead = batchDocs && batchDocs.length ? `<b>${batchDocs.length}</b> doc${batchDocs.length === 1 ? '' : 's'} → ` : '';
    summary.innerHTML = `${docHead}<b>${stats.total}</b> note${stats.total === 1 ? '' : 's'} · ${stats.dated} dated · ${stats.dateless} dateless`
      + `${updates ? ` · <b>${updates}</b> update${updates === 1 ? '' : 's'}` : ''} · ${esc(modeLabel)}`;
    for (const w of warnings) summary.innerHTML += `<div class="mn-import-warn">⚠ ${esc(w)}</div>`;
    if (newerN) summary.innerHTML += `<div class="mn-import-warn">⚠ ${newerN} note${newerN === 1 ? '' : 's'} in mind look newer than the import — left unchecked so fresher edits aren’t overwritten.</div>`;

    list.innerHTML = '';
    parsed.sections.slice(0, PREVIEW_CAP).forEach((s) => {
      const row = el('div', 'mn-import-row');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !s.skip;
      cb.addEventListener('change', () => { s.skip = !cb.checked; updateCount(); });
      const main = el('div', 'mn-import-rowmain');
      const titleLine = el('div', 'mn-import-rowtitle');
      titleLine.appendChild(el('span', 'mn-import-rowname', esc(s.title)));
      if (s.dateIso) titleLine.appendChild(el('span', `mn-date-badge${s.isDaily ? ' mn-date-badge-daily' : ''}`, esc(s.dateIso)));
      else if (s.wholeDoc && s.srcCreated) titleLine.appendChild(el('span', 'mn-date-badge', esc(isoDay(s.srcCreated)))); // the createdAt it will adopt
      if (s.dup) {
        const isUpdate = s.dup.kind === 'id' || s.dup.kind === 'path';
        titleLine.appendChild(el('span', 'mn-import-badge mn-import-badge-dup', isUpdate ? 'update' : 'duplicate'));
      }
      if (s.newerExists) titleLine.appendChild(el('span', 'mn-import-badge mn-import-badge-newer', 'mind is newer'));
      if (s.dailyCollision) titleLine.appendChild(el('span', 'mn-import-badge', 'daily exists'));
      main.appendChild(titleLine);
      const snip = snippet(s.body);
      if (snip) main.appendChild(el('div', 'mn-import-rowsnippet', esc(snip)));
      row.append(cb, main);
      list.appendChild(row);
    });
    if (parsed.sections.length > PREVIEW_CAP) {
      list.appendChild(el('div', 'mn-dim', `…and ${parsed.sections.length - PREVIEW_CAP} more (all will be imported)`));
    }
    updateCount();
  }

  let _t = 0;
  function schedule() { clearTimeout(_t); _t = setTimeout(render, 200); }
  paste.addEventListener('input', () => { srcModified = 0; srcCreated = 0; srcName = ''; schedule(); }); // manual edit ⇒ source metadata no longer applies
  tagInput.addEventListener('input', () => {}); // tag doesn't affect preview

  async function doImport() {
    const active = parsed.sections.filter((s) => !s.skip);
    const toCreate = active.length;
    if (!toCreate) return;
    const updates = active.filter((s) => s.upsertId).length;
    const news = toCreate - updates;
    const verb = updates && !news ? `Update ${updates} note${updates === 1 ? '' : 's'}`
      : updates ? `Import ${news} new + update ${updates} note${updates === 1 ? '' : 's'}`
      : `Create ${toCreate} note${toCreate === 1 ? '' : 's'}`;
    confirmBox(`${verb}? A safety snapshot is taken first (undo in Settings → snapshots).`, async () => {
      importBtn.disabled = true;
      try {
        const res = await commitDocImport(parsed.sections, {
          folderId: folderSel.value === '__new__' ? '' : folderSel.value,
          newFolderName: folderSel.value === '__new__' ? newFolderInput.value.trim() : '',
          tag: tagInput.value.trim(),
          skipDuplicates: true,
        });
        overlay.remove();
        alert(`imported ${res.created} note${res.created === 1 ? '' : 's'}. undo via Settings → snapshots (pre-doc-import).`);
        navigate('#home');
      } catch (e) {
        alert(`import failed: ${e.message}`);
        importBtn.disabled = false;
      }
    });
  }

  render();
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  paste.focus();
}
