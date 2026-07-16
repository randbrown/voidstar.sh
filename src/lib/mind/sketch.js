// Sketch — freehand drawing starting from a blank page (no photo needed).
//
// A sketch adds NOTHING to the data model: it's an ordinary image attachment
// whose base PNG is generated blank paper, and the drawing lives in the same
// annotation record every image uses (strokes stay editable forever, ride
// sync, and render on thumbnails/inline images via the existing overlays).
// The annotate view is the drawing surface — pen with stylus pressure,
// highlighter, arrow, rect, ellipse, text, eraser, select — all reused as-is.

import * as store from './store.js';
import { pushPendingAttachments } from './attachments-drive.js';
import { navigate } from './app.js';
import { el, esc, btn } from './ui.js';

// Fixed hexes on purpose, same reasoning as the annotate palette: the paper
// is baked into the PNG, so a sketch looks identical on every device/theme.
// Two papers because one palette ink is always invisible on any paper
// (white-on-light / black-on-dark) — the chooser makes that an explicit pick.
export const SKETCH_PAPERS = [
  { id: 'dark', label: 'dark paper', color: '#15151b' },
  { id: 'light', label: 'light paper', color: '#f6f4ec' },
];

// Portrait page, under the attachment downscale cap (MAX_IMAGE_DIM 2560).
const SKETCH_W = 1200;
const SKETCH_H = 1600;

const PAPER_KEY = 'voidstar.mind.sketchPaper';

// Blank page → PNG blob → ordinary image attachment on the note. OCR is
// skipped: the base bytes stay blank forever (the drawing lives in the
// annotation record), so there's never any text for tesseract to find.
export async function createSketchAttachment(noteId, paperColor) {
  const c = document.createElement('canvas');
  c.width = SKETCH_W;
  c.height = SKETCH_H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = paperColor;
  ctx.fillRect(0, 0, SKETCH_W, SKETCH_H);
  const blob = await new Promise((res, rej) =>
    c.toBlob(b => (b ? res(b) : rej(new Error('sketch page export failed'))), 'image/png'));
  const att = store.createAttachment(noteId, {
    kind: 'image',
    name: `${store.fileStamp()}-sketch.png`,
    mimeType: 'image/png',
    size: blob.size,
  }, { width: SKETCH_W, height: SKETCH_H, ocrStatus: 'skipped' });
  await store.putBlob(att.id, blob);
  await store.putAttachmentRaw(att);
  return att;
}

// One-tap paper chooser (the last choice is highlighted). Runs onPick(color)
// after the modal closes; dismiss = no sketch.
export function pickSketchPaper(onPick) {
  const overlay = el('div', 'mn-modal-overlay');
  const box = el('div', 'mn-modal');
  box.appendChild(el('div', 'mn-modal-title', 'new sketch'));
  const row = el('div', 'mn-sketch-papers');
  const last = localStorage.getItem(PAPER_KEY) || SKETCH_PAPERS[0].id;
  for (const p of SKETCH_PAPERS) {
    const b = el('button', `mn-btn mn-sketch-paper ${p.id === last ? 'mn-btn-primary' : ''}`);
    const sw = el('span', 'mn-sketch-swatch');
    sw.style.background = p.color;
    b.appendChild(sw);
    b.appendChild(el('span', '', esc(p.label)));
    b.addEventListener('click', () => {
      overlay.remove();
      localStorage.setItem(PAPER_KEY, p.id);
      Promise.resolve(onPick(p.color)).catch(e => alert(`sketch failed: ${e.message}`));
    });
    row.appendChild(b);
  }
  box.appendChild(row);
  const cancelRow = el('div', 'mn-modal-row');
  cancelRow.appendChild(btn('cancel', '', () => overlay.remove()));
  box.appendChild(cancelRow);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// Start-from-nothing flow (home header, command palette): create a fresh note
// in `folderId` with the sketch inline in its body, then drop straight into
// the drawing canvas. The annotate view's back/done buttons land on the note.
export function startSketchNote(folderId = '') {
  pickSketchPaper(async (paper) => {
    const note = store.createNote({ folderId, title: await store.uniqueAutoTitle() });
    const att = await createSketchAttachment(note.id, paper);
    note.body = `![${att.name}](mn-attach://${att.id})\n`;
    await store.putNoteRaw(note);
    pushPendingAttachments(); // no-op until Drive is connected
    navigate(`#note/${note.id}/annotate/${att.id}`);
  });
}
