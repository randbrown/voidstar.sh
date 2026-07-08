// Settings — export/import, snapshots, storage info. Drive sync arrives in
// a later phase; the section is stubbed so the layout is stable.

import * as store from '../store.js';
import { buildExportZip, downloadBlob, stamp } from '../export.js';
import { navigate, refresh } from '../app.js';
import { el, esc, btn, topBar, confirmBox, timeAgo } from '../ui.js';

export async function renderSettings(root) {
  root.appendChild(topBar('settings', '#home'));

  // ── Data ──
  const dataCard = el('div', 'mn-card');
  dataCard.appendChild(el('div', 'mn-card-title', 'data'));

  const [notes, tasks, atts] = await Promise.all([
    store.getAllNotes(), store.getAllTasks(), store.getAllAttachments(),
  ]);
  const info = el('div', 'mn-note-meta',
    `${notes.length} notes · ${tasks.length} tasks · ${atts.length} attachments`);
  dataCard.appendChild(info);
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) {
      dataCard.appendChild(el('div', 'mn-note-meta',
        `local storage: ${(est.usage / 1024 / 1024).toFixed(1)} MB used`));
    }
  } catch {}

  const row = el('div', 'mn-actions');
  row.appendChild(btn('export .zip', '', async (e) => {
    e.target.disabled = true;
    try {
      const zip = await buildExportZip();
      downloadBlob(new Blob([zip], { type: 'application/zip' }), `mind-export-${stamp()}.zip`);
    } finally { e.target.disabled = false; }
  }));
  row.appendChild(btn('export .json', '', async () => {
    const data = await store.exportAll();
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      `mind-data-${stamp()}.json`);
  }));

  const importInput = el('input');
  importInput.type = 'file';
  importInput.accept = '.json,application/json';
  importInput.style.display = 'none';
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'mind') throw new Error('not a mind export file');
      await store.putSnapshot('pre-import');
      await store.importAll(data);
      alert('import merged.');
      navigate('#home');
    } catch (err) {
      alert(`import failed: ${err.message}`);
    }
    importInput.value = '';
  });
  row.appendChild(importInput);
  row.appendChild(btn('import .json', '', () => importInput.click()));
  row.appendChild(btn('trash', '', () => navigate('#trash')));
  dataCard.appendChild(row);
  root.appendChild(dataCard);

  // ── Snapshots ──
  const snapCard = el('div', 'mn-card');
  snapCard.appendChild(el('div', 'mn-card-title', 'snapshots'));
  snapCard.appendChild(el('div', 'mn-note-meta',
    'automatic safety copies taken before imports and restores.'));
  const snaps = await store.listSnapshots();
  if (!snaps.length) {
    snapCard.appendChild(el('div', 'mn-note-meta mn-dim', 'none yet.'));
  }
  for (const s of snaps.slice(0, 10)) {
    const r = el('div', 'mn-todo-row');
    r.appendChild(el('span', 'mn-task-text', `${esc(s.label || 'snapshot')} <span class="mn-dim">${timeAgo(s.ts)}</span>`));
    r.appendChild(btn('restore', 'mn-btn-ghost', () => {
      confirmBox('Replace current data with this snapshot? (a pre-undo snapshot is taken first)', async () => {
        await store.restoreSnapshot(s.ts);
        refresh();
      });
    }));
    snapCard.appendChild(r);
  }
  root.appendChild(snapCard);

  // ── Sync (stub until the Drive phase lands) ──
  const syncCard = el('div', 'mn-card');
  syncCard.appendChild(el('div', 'mn-card-title', 'google drive sync'));
  syncCard.appendChild(el('div', 'mn-note-meta',
    'cross-device sync via your own Google Drive is coming next. everything stays local until then — use export/import to move data meanwhile.'));
  root.appendChild(syncCard);

  const about = el('div', 'mn-note-meta mn-dim');
  about.style.marginTop = '1rem';
  about.innerHTML = 'mind — local-first notes. all data lives in this browser (IndexedDB).';
  root.appendChild(about);
}
