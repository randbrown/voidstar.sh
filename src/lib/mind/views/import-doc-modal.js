// Import-a-document modal: paste / upload / pick-from-Drive a markdown or
// plain-text document, split it into notes with a live preview, then commit.
// Opened from Settings → data → "import document…".

import { el, esc, btn, confirmBox } from '../ui.js';
import { parseDocIntoNotes, markDuplicates, commitDocImport } from '../import-doc.js';
import { pickerAvailable } from '../gdrive-picker.js';
import * as store from '../store.js';
import { navigate } from '../app.js';

const PREVIEW_CAP = 100;

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
    if (f) { paste.value = await f.text(); schedule(); }
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
        if (res) { paste.value = res.text; schedule(); }
      } catch (e) {
        alert(`Drive import failed: ${e.message}`);
      } finally { pickBtn.disabled = false; pickBtn.textContent = prev; }
    });
    srcRow.appendChild(pickBtn);
  }
  box.appendChild(srcRow);

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

  opts.append(modeSel, levelSel, folderSel, newFolderInput, tagInput, preambleWrap, dailyWrap);
  box.appendChild(opts);

  const levelVisibility = () => { levelSel.style.display = (modeSel.value === 'dates' || modeSel.value === 'single') ? 'none' : ''; };
  levelVisibility();
  for (const ctrl of [modeSel, levelSel, preambleCb, dailyCb]) {
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

  function updateCount() {
    const n = parsed.sections.filter((s) => !s.skip).length;
    importBtn.textContent = n ? `import ${n} note${n === 1 ? '' : 's'}` : 'import';
    importBtn.disabled = n === 0;
  }

  function render() {
    const text = paste.value;
    if (!text.trim()) {
      parsed = { sections: [], stats: { total: 0 }, warnings: [] };
      summary.textContent = 'paste or choose a document above.';
      list.innerHTML = '';
      updateCount();
      return;
    }
    parsed = parseDocIntoNotes(text, currentOpts());
    markDuplicates(parsed.sections, notes);

    const { stats, mode, headingLevel, warnings } = parsed;
    const modeLabel = mode === 'headings' ? `headings${headingLevel ? `(${'#'.repeat(headingLevel)})` : ''}`
      : mode === 'export' ? 'mind export' : mode === 'single' ? 'one note (no split)' : 'date lines';
    summary.innerHTML = `<b>${stats.total}</b> note${stats.total === 1 ? '' : 's'} · ${stats.dated} dated · ${stats.dateless} dateless · ${esc(modeLabel)}`;
    for (const w of warnings) summary.innerHTML += `<div class="mn-import-warn">⚠ ${esc(w)}</div>`;

    list.innerHTML = '';
    parsed.sections.slice(0, PREVIEW_CAP).forEach((s) => {
      const row = el('div', 'mn-import-row');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !s.skip;
      cb.addEventListener('change', () => { s.skip = !cb.checked; updateCount(); });
      const main = el('div', 'mn-import-rowmain');
      const titleLine = el('div', 'mn-import-rowtitle');
      titleLine.appendChild(el('span', 'mn-import-rowname', esc(s.title)));
      if (s.dateIso) titleLine.appendChild(el('span', `mn-date-badge${s.isDaily ? ' mn-date-badge-daily' : ''}`, esc(s.dateIso)));
      if (s.dup) titleLine.appendChild(el('span', 'mn-import-badge mn-import-badge-dup', s.dup.kind === 'id' ? 'update' : 'duplicate'));
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
  paste.addEventListener('input', schedule);
  tagInput.addEventListener('input', () => {}); // tag doesn't affect preview
  folderSel.addEventListener('change', () => {});

  async function doImport() {
    const toCreate = parsed.sections.filter((s) => !s.skip).length;
    if (!toCreate) return;
    confirmBox(`Create ${toCreate} note${toCreate === 1 ? '' : 's'}? A safety snapshot is taken first (undo in Settings → snapshots).`, async () => {
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
