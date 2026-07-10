// Import-from-Evernote modal: choose one or more .enex exports, preview the
// notes/attachments, then commit with a progress readout. Opened from
// Settings → data → "import Evernote (.enex)…".

import { el, esc, btn, confirmBox } from '../ui.js';
import * as store from '../store.js';
import { navigate } from '../app.js';
import { parseEnexFiles, commitEnexImport } from '../enex-import.js';

const PREVIEW_CAP = 100;

function snippet(body) {
  const s = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<!--[^>]*-->/g, '')
    .replace(/[#>*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

export async function openImportEnexModal() {
  const folders = await store.getAllFolders();

  const overlay = el('div', 'mn-modal-overlay');
  const box = el('div', 'mn-modal mn-modal-wide');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  box.appendChild(el('div', 'mn-modal-title', 'import from Evernote'));
  box.appendChild(el('div', 'mn-note-meta',
    'choose one or more Evernote .enex exports (in Evernote: select a notebook → File → Export → ENEX). each notebook is usually one .enex — import very large ones one at a time. created/updated dates, tags, checkboxes and images are preserved; a safety snapshot is taken first.'));

  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.enex,application/xml,text/xml';
  fileInput.multiple = true;
  fileInput.style.display = 'none';

  const srcRow = el('div', 'mn-actions');
  srcRow.appendChild(fileInput);
  srcRow.appendChild(btn('choose .enex file(s)…', 'mn-btn-ghost', () => fileInput.click()));
  box.appendChild(srcRow);

  // ── Folder + tag options ──
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
  folderSel.addEventListener('change', () => { newFolderInput.style.display = folderSel.value === '__new__' ? '' : 'none'; });

  const tagInput = el('input', 'mn-input');
  tagInput.type = 'text';
  tagInput.placeholder = 'tag all (optional)';

  const opts = el('div', 'mn-import-opts');
  opts.append(folderSel, newFolderInput, tagInput);
  box.appendChild(opts);

  const summary = el('div', 'mn-import-summary', 'no files chosen yet.');
  const list = el('div', 'mn-import-list');
  const progress = el('div', 'mn-note-meta');
  progress.style.display = 'none';
  box.append(summary, list, progress);

  const footer = el('div', 'mn-modal-row');
  const cancel = btn('cancel', '', () => overlay.remove());
  const importBtn = btn('import', 'mn-btn-primary', () => doImport());
  importBtn.disabled = true;
  footer.append(cancel, importBtn);
  box.appendChild(footer);

  let parsed = { notes: [], warnings: [], stats: { notes: 0, resources: 0 } };

  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (!files.length) return;
    summary.textContent = 'reading…';
    list.innerHTML = '';
    importBtn.disabled = true;
    try {
      const texts = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
      parsed = parseEnexFiles(texts);
    } catch (e) {
      summary.textContent = `read failed: ${e.message}`;
      return;
    }
    renderSummary();
  });

  function renderSummary() {
    const { stats, warnings, notes } = parsed;
    summary.innerHTML = `<b>${stats.notes}</b> note${stats.notes === 1 ? '' : 's'} · ${stats.resources} attachment${stats.resources === 1 ? '' : 's'}`;
    for (const w of warnings) summary.innerHTML += `<div class="mn-import-warn">⚠ ${esc(w)}</div>`;

    list.innerHTML = '';
    notes.slice(0, PREVIEW_CAP).forEach((n) => {
      const row = el('div', 'mn-import-row');
      const main = el('div', 'mn-import-rowmain');
      const titleLine = el('div', 'mn-import-rowtitle');
      titleLine.appendChild(el('span', 'mn-import-rowname', esc(n.title || '(untitled)')));
      if (n.createdAt) titleLine.appendChild(el('span', 'mn-date-badge', esc(new Date(n.createdAt).toISOString().slice(0, 10))));
      if (n.resources.length) titleLine.appendChild(el('span', 'mn-import-badge', `${n.resources.length} file${n.resources.length === 1 ? '' : 's'}`));
      main.appendChild(titleLine);
      const snip = snippet(n.body);
      if (snip) main.appendChild(el('div', 'mn-import-rowsnippet', esc(snip)));
      row.appendChild(main);
      list.appendChild(row);
    });
    if (notes.length > PREVIEW_CAP) {
      list.appendChild(el('div', 'mn-dim', `…and ${notes.length - PREVIEW_CAP} more (all will be imported)`));
    }

    importBtn.textContent = stats.notes ? `import ${stats.notes} note${stats.notes === 1 ? '' : 's'}` : 'import';
    importBtn.disabled = stats.notes === 0;
  }

  async function doImport() {
    if (!parsed.notes.length) return;
    confirmBox(`Import ${parsed.notes.length} note${parsed.notes.length === 1 ? '' : 's'}? A safety snapshot is taken first (undo in Settings → snapshots).`, async () => {
      importBtn.disabled = true;
      cancel.disabled = true;
      progress.style.display = '';
      progress.textContent = 'importing…';
      try {
        const res = await commitEnexImport(parsed.notes, {
          folderId: folderSel.value === '__new__' ? '' : folderSel.value,
          newFolderName: folderSel.value === '__new__' ? newFolderInput.value.trim() : '',
          tag: tagInput.value.trim(),
          skipDuplicates: true,
          onProgress: (done, totalN) => { progress.textContent = `importing… ${done}/${totalN}`; },
        });
        overlay.remove();
        alert(`imported ${res.created} note${res.created === 1 ? '' : 's'}. undo via Settings → snapshots (pre-enex-import).`);
        navigate('#home');
      } catch (e) {
        alert(`import failed: ${e.message}`);
        importBtn.disabled = false;
        cancel.disabled = false;
      }
    });
  }

  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
