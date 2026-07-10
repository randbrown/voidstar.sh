// Settings — export/import (incl. document import + single-doc markdown export),
// snapshots, storage info, audio, OCR, and Google Drive sign-in + sync.

import * as store from '../store.js';
import { buildExportZip, buildNotesMarkdownDoc, downloadBlob, stamp } from '../export.js';
import { openImportDocModal } from './import-doc-modal.js';
import { navigate, refresh, getDockPos, setDockPos, DOCK_POSITIONS } from '../app.js';
import { el, esc, btn, topBar, confirmBox, timeAgo } from '../ui.js';

export async function renderSettings(root) {
  root.appendChild(topBar('settings', '#home'));

  // ── UI ──
  const uiCard = el('div', 'mn-card');
  uiCard.appendChild(el('div', 'mn-card-title', 'interface'));
  uiCard.appendChild(el('div', 'mn-note-meta', 'menu position (this device only):'));
  const posRow = el('div', 'mn-actions');
  const drawPos = () => {
    posRow.innerHTML = '';
    for (const p of DOCK_POSITIONS) {
      posRow.appendChild(btn(p, getDockPos() === p ? 'mn-btn-primary' : '', () => {
        setDockPos(p);
        drawPos();
      }));
    }
  };
  drawPos();
  uiCard.appendChild(posRow);
  root.appendChild(uiCard);

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
  row.appendChild(btn('export .md (doc)', '', async (e) => {
    e.target.disabled = true;
    try {
      const md = await buildNotesMarkdownDoc();
      downloadBlob(new Blob([md], { type: 'text/markdown' }), `mind-doc-${stamp()}.md`);
    } finally { e.target.disabled = false; }
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
  row.appendChild(btn('import document…', '', () => openImportDocModal()));
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

  // ── Audio devices ──
  const { wireSpeakerPicker, sinkSelectable } = await import('../audio-out.js');
  const audioCard = el('div', 'mn-card');
  audioCard.appendChild(el('div', 'mn-card-title', 'audio'));
  audioCard.appendChild(el('div', 'mn-note-meta',
    'mic is picked in the note editor’s voice bar. speaker below routes voice-note playback (useful with a bluetooth music rig connected).'));
  const spkSel = el('select', 'mn-select');
  await wireSpeakerPicker(spkSel);
  if (!sinkSelectable()) {
    audioCard.appendChild(el('div', 'mn-note-meta mn-dim', 'speaker selection is not supported in this browser (Safari/iOS use the system output).'));
  } else {
    audioCard.appendChild(spkSel);
  }
  root.appendChild(audioCard);

  // ── OCR status ──
  const { processPendingOcr } = await import('../ocr.js');
  const pendingOcr = (await store.getPendingOcrAttachments?.() ?? []).length;
  const ocrCard = el('div', 'mn-card');
  ocrCard.appendChild(el('div', 'mn-card-title', 'image text (ocr)'));
  ocrCard.appendChild(el('div', 'mn-note-meta',
    `images are text-recognized in the background so screenshots become searchable. ${pendingOcr ? `${pendingOcr} pending.` : 'queue is clear.'}`));
  if (pendingOcr) {
    ocrCard.appendChild(btn('process now', '', () => { processPendingOcr(); refresh(); }));
  }
  root.appendChild(ocrCard);

  // ── Google Drive sync ──
  const gd = await import('../gdrive-sync.js');
  const { pushPendingAttachments } = await import('../attachments-drive.js');
  const syncCard = el('div', 'mn-card');
  syncCard.appendChild(el('div', 'mn-card-title', 'google drive sync'));
  syncCard.appendChild(el('div', 'mn-note-meta',
    'sync your notes across devices through YOUR Google Drive (drive.file scope — the app only touches files it creates). data file + attachments folder + rotating history live at your Drive root.'));

  const statusLine = el('div', 'mn-note-meta');
  const drawStatus = () => {
    const state = gd.hasClientId()
      ? (gd.needsReconnect() ? 'signed out — reconnect' : (gd.isSyncEnabled() ? 'connected' : 'not connected'))
      : 'sign-in not configured';
    const via = !gd.usingAppClientId() && gd.getClientIdOverride() ? ' · own client id' : '';
    statusLine.innerHTML = `status: ${state}${via} · last sync: ${gd.formatLastBackup()}`;
  };
  drawStatus();
  syncCard.appendChild(statusLine);

  const actRow = el('div', 'mn-actions');
  actRow.appendChild(btn('sign in with Google &amp; sync', 'mn-btn-primary', async (e) => {
    if (!gd.hasClientId()) {
      alert('Google sign-in isn’t configured on this deployment. Set your own OAuth client id under “advanced” below.');
      return;
    }
    e.target.disabled = true;
    try {
      await gd.ensureDriveAccess();
      const client = await gd.initGdriveSync({ interactive: true });
      gd.setSyncClient(client);
      await store.putSnapshot('pre-sync');
      const res = await gd.pullMergePushCycle(client,
        () => store.exportAll(), (m) => store.importAll(m), { historyForce: true });
      await pushPendingAttachments();
      alert(res.conflicts
        ? `synced — ${res.conflicts} conflicted cop${res.conflicts === 1 ? 'y' : 'ies'} created (amber badge in the list)`
        : 'synced.');
      refresh();
    } catch (err) {
      alert(`sync failed: ${err.message}`);
    } finally { e.target.disabled = false; }
  }));
  actRow.appendChild(btn('disconnect', '', () => {
    gd.disconnect();
    gd.setSyncClient(null);
    drawStatus();
  }));
  syncCard.appendChild(actRow);

  const devRow = el('div', 'mn-actions');
  const devInput = el('input', 'mn-input');
  devInput.type = 'text';
  devInput.placeholder = 'device name (for conflict copies)';
  devInput.value = gd.getDeviceName();
  devInput.addEventListener('change', () => gd.setDeviceName(devInput.value.trim()));
  devRow.appendChild(devInput);
  syncCard.appendChild(devRow);

  // Advanced: override the app-owned OAuth client id with your own (self-host).
  const adv = el('details', 'mn-advanced');
  adv.appendChild(el('summary', '', 'advanced: use your own OAuth client id'));
  adv.appendChild(el('div', 'mn-note-meta',
    'optional. leave empty to use this site’s sign-in. a self-hosted copy can set its own Google Cloud OAuth client id here.'));
  const cidRow = el('div', 'mn-actions');
  const cidInput = el('input', 'mn-input');
  cidInput.type = 'text';
  cidInput.placeholder = 'OAuth client id (…apps.googleusercontent.com)';
  cidInput.style.flex = '1 1 16rem';
  cidInput.value = gd.getClientIdOverride();
  cidRow.appendChild(cidInput);
  cidRow.appendChild(btn('save', '', () => {
    gd.setClientId(cidInput.value.trim());
    refresh();
  }));
  adv.appendChild(cidRow);
  syncCard.appendChild(adv);

  root.appendChild(syncCard);

  const about = el('div', 'mn-note-meta mn-dim');
  about.style.marginTop = '1rem';
  about.innerHTML = 'mind — local-first notes. all data lives in this browser (IndexedDB).';
  root.appendChild(about);
}
