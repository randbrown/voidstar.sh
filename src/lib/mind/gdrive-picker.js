// In-app Google Drive Picker for the document importer. Lets the user select
// one of their existing Google Docs (or a text file) and returns its text so
// the import modal can split it into notes.
//
// Auth model: the app already holds a GIS OAuth token with the drive.file
// scope. The Picker is a trusted Google surface that can show ALL of the user's
// files; picking one grants this app drive.file access to exactly that file —
// so we can export its text without any broad, review-gated scope.

import { GOOGLE_PICKER_API_KEY, googleAppId, hasPickerKey } from '../qualia/google-config.js';
import { ensureDriveAccess, getDriveToken } from './gdrive-sync.js';

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

let _pickerLoaded = false;

function loadPickerApi() {
  if (_pickerLoaded && window.google?.picker) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const loadPicker = () => window.gapi.load('picker', {
      callback: () => { _pickerLoaded = true; resolve(); },
      onerror: () => reject(new Error('Failed to load Google Picker')),
    });
    if (window.gapi?.load) { loadPicker(); return; }
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = loadPicker;
    s.onerror = () => reject(new Error('Failed to load the Google API script'));
    document.head.appendChild(s);
  });
}

export function pickerAvailable() { return hasPickerKey(); }

// Open the Picker; resolves with { id, name, mimeType } of the chosen file, or
// null if the user cancelled. MUST be called from within a user gesture.
export async function pickDriveDoc() {
  if (!hasPickerKey()) throw new Error('Drive Picker is not configured.');
  // Acquire the OAuth token inside the gesture before loading the Picker
  // (mobile popup rule — an async hop first means a blocked popup).
  await ensureDriveAccess();
  const token = await getDriveToken({ interactive: true });
  if (!token) throw new Error('Google Drive not connected.');
  await loadPickerApi();

  return new Promise((resolve, reject) => {
    try {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(false)
        .setMimeTypes(`${GOOGLE_DOC_MIME},text/plain,text/markdown`);
      const builder = new google.picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(GOOGLE_PICKER_API_KEY)
        .addView(view)
        .setCallback((data) => {
          const action = data[google.picker.Response.ACTION];
          if (action === google.picker.Action.PICKED) {
            const doc = data[google.picker.Response.DOCUMENTS][0];
            resolve({
              id: doc[google.picker.Document.ID],
              name: doc[google.picker.Document.NAME],
              mimeType: doc[google.picker.Document.MIME_TYPE],
            });
          } else if (action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        });
      const appId = googleAppId();
      if (appId) builder.setAppId(appId);
      builder.build().setVisible(true);
    } catch (e) {
      reject(e);
    }
  });
}

// Fetch the picked file's text. A Google Doc is exported to markdown (headings
// become `#`, ideal for the splitter), falling back to plain text; a real text
// file downloads directly.
export async function fetchDriveDocText(file) {
  const token = await getDriveToken({ interactive: false }) || await getDriveToken({ interactive: true });
  if (!token) throw new Error('Google Drive not connected.');
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  if (file.mimeType === GOOGLE_DOC_MIME) {
    for (const mt of ['text/markdown', 'text/plain']) {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(mt)}`,
        auth);
      if (res.ok) return res.text();
      if (res.status !== 400) throw new Error(`Drive export failed: ${res.status}`);
    }
    throw new Error('Could not export the Google Doc as text.');
  }

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, auth);
  if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
  return res.text();
}

// One-call convenience: pick + fetch. Returns { text, name } or null (cancel).
export async function importFromDrive() {
  const file = await pickDriveDoc();
  if (!file) return null;
  const text = await fetchDriveDocText(file);
  return { text, name: file.name };
}

// Multi-select picker for Evernote .enex exports. No mime filter — .enex uploads
// to Drive with inconsistent types (octet-stream / xml) — so all files are
// shown and the user selects their export(s). Resolves with an array of
// { id, name, mimeType } or null on cancel. MUST be called from a user gesture.
export async function pickDriveEnex() {
  if (!hasPickerKey()) throw new Error('Drive Picker is not configured.');
  await ensureDriveAccess();
  const token = await getDriveToken({ interactive: true });
  if (!token) throw new Error('Google Drive not connected.');
  await loadPickerApi();

  return new Promise((resolve, reject) => {
    try {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);
      const builder = new google.picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(GOOGLE_PICKER_API_KEY)
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .addView(view)
        .setCallback((data) => {
          const action = data[google.picker.Response.ACTION];
          if (action === google.picker.Action.PICKED) {
            const docs = data[google.picker.Response.DOCUMENTS] || [];
            resolve(docs.map((d) => ({
              id: d[google.picker.Document.ID],
              name: d[google.picker.Document.NAME],
              mimeType: d[google.picker.Document.MIME_TYPE],
            })));
          } else if (action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        });
      const appId = googleAppId();
      if (appId) builder.setAppId(appId);
      builder.build().setVisible(true);
    } catch (e) {
      reject(e);
    }
  });
}

// Download the picked files' raw text (a .enex is UTF-8 XML → the alt=media
// branch of fetchDriveDocText). Returns [{ name, text }]; failures are skipped
// with a warning rather than aborting the whole batch.
export async function importEnexFromDrive() {
  const files = await pickDriveEnex();
  if (!files || !files.length) return null;
  const out = [];
  for (const f of files) {
    try { out.push({ name: f.name, text: await fetchDriveDocText(f) }); }
    catch (e) { console.warn('[enex] Drive fetch failed:', f.name, e.message); }
  }
  return out;
}
