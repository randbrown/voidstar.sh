// Annotate view — stylus/touch/mouse markup over an image attachment.
// Tools share one palette + size scale; strokes autosave as you draw.

import * as store from '../store.js';
import { getObjectUrl, addAttachmentFromBlob } from '../attachments.js';
import { initAnnotationCanvas, renderAnnotatedImageBlob } from '../annotation.js';
import { navigate } from '../app.js';
import { el, esc, btn } from '../ui.js';

// Fixed hexes on purpose: canvas strokes can't resolve CSS vars, and the
// palette must look identical on every device/theme.
const PALETTE = ['#ff5e7e', '#4ea1ff', '#7cf2a5', '#ffc65e', '#ffffff', '#111111'];

export async function renderAnnotate(root, noteId, attId, startPage = 0) {
  const att = await store.getAttachment(attId);
  if (!att || att.deletedAt) {
    root.appendChild(el('div', 'mn-error', 'attachment not found'));
    return;
  }

  // PDFs annotate one rasterized page at a time (strokes keyed attId:page).
  const isPdf = att.kind === 'pdf';
  let pageCount = 1;
  let page = startPage;
  let pageInfo = null; // {url, width, height} for the current pdf page
  let url = null;

  if (isPdf) {
    const blob = await store.getBlob(att.id);
    if (!blob) {
      root.appendChild(el('div', 'mn-error', 'pdf data not on this device'));
      return;
    }
    const pdf = await import('../pdf.js');
    pageCount = await pdf.pdfPageCount(blob);
    page = Math.min(Math.max(0, page), pageCount - 1);
    pageInfo = await pdf.getPdfPageUrl(att.id, blob, page + 1);
    url = pageInfo.url;
  } else {
    url = await getObjectUrl(att.id);
    if (!url) {
      root.appendChild(el('div', 'mn-error', 'image data not on this device'));
      return;
    }
  }

  const bar = el('div', 'mn-topbar');
  bar.appendChild(btn('&larr;', 'mn-btn-icon', () => navigate(`#note/${noteId}`)));
  bar.appendChild(el('span', 'mn-topbar-title',
    esc(att.name || 'annotate') + (isPdf ? ` <span class="mn-dim">p${page + 1}/${pageCount}</span>` : '')));
  const actions = el('div', 'mn-actions');

  if (isPdf && pageCount > 1) {
    const goPage = async (p) => {
      if (p < 0 || p >= pageCount) return;
      await ctl.flush();
      ctl.destroy();
      root._mnCleanup = null;
      root.innerHTML = '';
      await renderAnnotate(root, noteId, attId, p);
    };
    const prev = btn('&larr; pg', '', () => goPage(page - 1));
    const next = btn('pg &rarr;', '', () => goPage(page + 1));
    prev.disabled = page === 0;
    next.disabled = page === pageCount - 1;
    actions.appendChild(prev);
    actions.appendChild(next);
  }

  const flattenBtn = btn('flatten &rarr; copy', '', async () => {
    // Bake strokes into a NEW image attachment on the same note; the
    // original and its editable strokes stay untouched. For PDFs the
    // current rasterized page is the base.
    flattenBtn.disabled = true;
    try {
      const base = isPdf
        ? await (await fetch(url)).blob()
        : await store.getBlob(att.id);
      const bmp = await createImageBitmap(base);
      const out = await renderAnnotatedImageBlob(bmp, ctl.getStrokes());
      bmp.close();
      await addAttachmentFromBlob(noteId, out, `${store.fileStamp()}-annotated.png`);
      flattenBtn.innerHTML = 'copied &#10003;';
      setTimeout(() => { flattenBtn.innerHTML = 'flatten &rarr; copy'; flattenBtn.disabled = false; }, 1500);
    } catch (e) {
      alert(`flatten failed: ${e.message}`);
      flattenBtn.disabled = false;
    }
  });
  actions.appendChild(flattenBtn);
  actions.appendChild(btn('done', 'mn-btn-primary', () => navigate(`#note/${noteId}`)));
  bar.appendChild(actions);
  root.appendChild(bar);

  // ── Toolbar ──
  const toolbar = el('div', 'mn-ann-toolbar');
  const tools = [
    ['pen', '&#9998;'], ['highlighter', '&#9645;'], ['arrow', '&#8599;'],
    ['rect', '&#9634;'], ['ellipse', '&#9675;'], ['text', 'T'],
    ['eraser', '&#9003;'], ['select', '&#10548;'], ['pan', '&#9995;'],
  ];
  const toolRow = el('div', 'mn-ann-row');
  for (const [t, icon] of tools) {
    const b = el('button', 'mn-btn mn-btn-xs mn-ann-tool', icon);
    b.dataset.tool = t;
    b.title = t;
    toolRow.appendChild(b);
  }
  toolbar.appendChild(toolRow);

  const styleRow = el('div', 'mn-ann-row');
  for (const c of PALETTE) {
    const sw = el('button', 'mn-ann-swatch');
    sw.dataset.color = c;
    sw.style.background = c;
    sw.title = c;
    styleRow.appendChild(sw);
  }
  const colorInput = el('input', 'mn-ann-color');
  colorInput.type = 'color';
  colorInput.value = PALETTE[0];
  styleRow.appendChild(colorInput);
  const sizeSel = el('select', 'mn-select mn-ann-size');
  for (const [v, label] of [[2, 'fine'], [4, 'medium'], [8, 'thick']]) {
    const o = el('option', '', label); o.value = v; sizeSel.appendChild(o);
  }
  sizeSel.value = '4';
  styleRow.appendChild(sizeSel);
  styleRow.appendChild(el('button', 'mn-btn mn-btn-xs', '&#8630;')).id = 'mn-ann-undo';
  styleRow.appendChild(el('button', 'mn-btn mn-btn-xs', '&#8631;')).id = 'mn-ann-redo';
  const clearBtn = el('button', 'mn-btn mn-btn-xs mn-btn-danger', 'clear');
  clearBtn.id = 'mn-ann-clear';
  styleRow.appendChild(clearBtn);
  toolbar.appendChild(styleRow);
  root.appendChild(toolbar);

  // ── Stage: image + drawing canvas ──
  const wrap = el('div', 'mn-annotation-wrap');
  const stage = el('div', 'mn-annotation-stage');
  const w = isPdf ? pageInfo.width : att.width;
  const h = isPdf ? pageInfo.height : att.height;
  if (w && h) stage.style.aspectRatio = `${w} / ${h}`;
  const img = el('img', 'mn-annotation-img');
  img.src = url;
  img.alt = att.name || '';
  const canvas = el('canvas', 'mn-annotation-canvas');
  stage.appendChild(img);
  stage.appendChild(canvas);
  wrap.appendChild(stage);
  root.appendChild(wrap);

  // If dims weren't probed (old records), fix the aspect once the image loads.
  if (!w || !h) {
    img.addEventListener('load', () => {
      stage.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      ctl.resize();
    }, { once: true });
  }

  const ctl = initAnnotationCanvas(canvas, att.id, toolbar, { page });
  root._mnCleanup = () => ctl.destroy();
}
