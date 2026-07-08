// Annotation canvas for drawing on images/PDFs — forked from
// setlist/annotation.js and extended for mind:
//   - keyed by attachment id (":page" suffix reserved for PDFs)
//   - stylus pressure: pen strokes record per-point pressure from real pens
//     (pointerType 'pen') and render variable-width segments
//   - shape tools: rect + ellipse alongside pen/highlighter/text/arrow
// Tools share one color palette and size scale (the toolbar's pickers).

import { getAnnotationByKey, putAnnotation, annotationKey } from './store.js';

export async function loadAnnotation(attachmentId, page = 0) {
  return getAnnotationByKey(annotationKey(attachmentId, page));
}

async function saveAnnotationRec(attachmentId, page, strokes, aspect) {
  await putAnnotation({
    key: annotationKey(attachmentId, page),
    attachmentId, page,
    strokes,
    aspect: aspect || null,
  });
}

// Text typography is deterministic and width-relative: coordinates are
// normalized to the canvas box, so the font must scale with that box or
// text drifts between devices. (See setlist/annotation.js for history.)
const ANN_TEXT_FONT = "'JetBrains Mono', ui-monospace, monospace";
function annTextFontPx(stroke, canvas) {
  return (stroke.size * canvas.width) / 200; // stored size in width/200 units
}

const TEXT_SIZE_BY_WIDTH = { 2: 8, 4: 14, 8: 22 };
function textSizeForWidth(w) {
  return TEXT_SIZE_BY_WIDTH[w] || Math.round(w * 3.5);
}

function strokeWidthAt(stroke, i) {
  // Variable width for pressure-recorded pen points; flat otherwise.
  const p = stroke.points?.[i]?.p;
  return p ? Math.max(0.5, stroke.size * (0.4 + p * 1.2)) : stroke.size;
}

export function drawStrokeOnCanvas(ctx, canvas, stroke) {
  const W = canvas.width, H = canvas.height;

  if (stroke.type === 'text') {
    ctx.font = `${annTextFontPx(stroke, canvas)}px ${ANN_TEXT_FONT}`;
    ctx.fillStyle = stroke.color;
    ctx.fillText(stroke.text, stroke.x * W, stroke.y * H);
    return;
  }

  if ((stroke.type === 'rect' || stroke.type === 'ellipse') && stroke.points?.length >= 2) {
    const a = stroke.points[0];
    const b = stroke.points[stroke.points.length - 1];
    const x = Math.min(a.x, b.x) * W, y = Math.min(a.y, b.y) * H;
    const w = Math.abs(b.x - a.x) * W, h = Math.abs(b.y - a.y) * H;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    if (stroke.type === 'rect') ctx.strokeRect(x, y, w, h);
    else { ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
    return;
  }

  if (stroke.type === 'arrow' && stroke.points.length >= 2) {
    const pts = stroke.points;
    const start = pts[0];
    const end = pts[pts.length - 1];
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.moveTo(start.x * W, start.y * H);
    ctx.lineTo(end.x * W, end.y * H);
    ctx.stroke();

    const angle = Math.atan2((end.y - start.y) * H, (end.x - start.x) * W);
    const headLen = stroke.size * 4;
    ctx.beginPath();
    ctx.moveTo(end.x * W, end.y * H);
    ctx.lineTo(end.x * W - headLen * Math.cos(angle - Math.PI / 6),
               end.y * H - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(end.x * W, end.y * H);
    ctx.lineTo(end.x * W - headLen * Math.cos(angle + Math.PI / 6),
               end.y * H - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
    return;
  }

  if (!stroke.points || stroke.points.length < 2) return;

  ctx.strokeStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.type === 'highlighter') {
    ctx.beginPath();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = stroke.size * 3;
    ctx.moveTo(stroke.points[0].x * W, stroke.points[0].y * H);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x * W, stroke.points[i].y * H);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  const hasPressure = stroke.points.some(p => p.p);
  if (!hasPressure) {
    ctx.beginPath();
    ctx.lineWidth = stroke.size;
    ctx.moveTo(stroke.points[0].x * W, stroke.points[0].y * H);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x * W, stroke.points[i].y * H);
    }
    ctx.stroke();
    return;
  }

  // Pressure pen: per-segment width (cheap and looks right at note scale).
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1], b = stroke.points[i];
    ctx.beginPath();
    ctx.lineWidth = (strokeWidthAt(stroke, i - 1) + strokeWidthAt(stroke, i)) / 2;
    ctx.moveTo(a.x * W, a.y * H);
    ctx.lineTo(b.x * W, b.y * H);
    ctx.stroke();
  }
}

export function renderReadonlyAnnotations(canvas, strokes) {
  const ctx = canvas.getContext('2d');
  function redraw() {
    const wrap = canvas.parentElement;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) drawStrokeOnCanvas(ctx, canvas, s);
  }
  const ro = new ResizeObserver(redraw);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  redraw();
  return { redraw, destroy: () => ro.disconnect() };
}

export function initAnnotationCanvas(canvas, attachmentId, toolbar, { page = 0, onSaved = null } = {}) {
  const ctx = canvas.getContext('2d');
  const ac = new AbortController();
  const { signal } = ac;
  let strokes = [];
  let currentStroke = null;
  let tool = 'pen';
  let color = toolbar.querySelector('.mn-ann-color')?.value || '#ff5e7e';
  let lineWidth = parseInt(toolbar.querySelector('.mn-ann-size')?.value) || 4;
  let undoStack = [];
  let selectedIndex = -1;
  let selDrag = null;
  let pendingText = null;
  let longPressTimer = null;
  let longPressStart = null;
  let dirty = false;
  const LONG_PRESS_MS = 500;

  // Two-finger scroll: one finger inks, a second means "scroll" (partial ink
  // rolled back). See setlist/annotation.js for the full rationale.
  const scroller = canvas.closest('.mn-annotation-wrap');
  const activePointers = new Map();
  let panGesture = false;

  function resize() {
    const wrap = canvas.parentElement;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    redraw();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) drawStrokeOnCanvas(ctx, canvas, stroke);
    if (selectedIndex >= 0 && strokes[selectedIndex]) {
      const b = strokeBBox(strokes[selectedIndex]);
      if (b) {
        ctx.save();
        ctx.strokeStyle = '#4ea1ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        if (strokes[selectedIndex].type === 'text') {
          ctx.setLineDash([]);
          ctx.fillStyle = '#4ea1ff';
          ctx.fillRect(b.x + b.w - 5, b.y + b.h - 5, 10, 10);
        }
        ctx.restore();
      }
    }
  }

  const HANDLE_HIT_PX = 20;
  function onResizeHandle(pos) {
    const s = selectedIndex >= 0 ? strokes[selectedIndex] : null;
    if (!s || s.type !== 'text') return false;
    const b = strokeBBox(s);
    if (!b) return false;
    const px = pos.x * canvas.width;
    const py = pos.y * canvas.height;
    return Math.abs(px - (b.x + b.w)) <= HANDLE_HIT_PX && Math.abs(py - (b.y + b.h)) <= HANDLE_HIT_PX;
  }

  function strokeBBox(stroke) {
    if (stroke.type === 'text') {
      const fontPx = annTextFontPx(stroke, canvas);
      ctx.font = `${fontPx}px ${ANN_TEXT_FONT}`;
      const w = ctx.measureText(stroke.text || '').width;
      const x = stroke.x * canvas.width;
      const y = stroke.y * canvas.height;
      return { x: x - 4, y: y - fontPx, w: w + 8, h: fontPx + 8 };
    }
    const pts = stroke.points;
    if (!pts || !pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const stroked = stroke.type === 'highlighter' ? stroke.size * 3 : stroke.size;
    const pad = stroked / 2 + 8;
    return {
      x: minX * canvas.width - pad,
      y: minY * canvas.height - pad,
      w: (maxX - minX) * canvas.width + pad * 2,
      h: (maxY - minY) * canvas.height + pad * 2,
    };
  }

  function hitTest(pos) {
    const px = pos.x * canvas.width;
    const py = pos.y * canvas.height;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const b = strokeBBox(strokes[i]);
      if (!b) continue;
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return i;
    }
    return -1;
  }

  function cloneStroke(s) {
    return { ...s, points: s.points ? s.points.map(p => ({ ...p })) : undefined };
  }

  function applyTranslate(stroke, orig, dx, dy) {
    if (stroke.type === 'text') {
      stroke.x = orig.x + dx;
      stroke.y = orig.y + dy;
    } else if (orig.points) {
      stroke.points = orig.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
    }
  }

  function clearSelection() {
    if (selectedIndex < 0) return;
    selectedIndex = -1;
    selDrag = null;
    updateSelMenu();
    redraw();
  }

  function cancelLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
    return {
      x: (touch.clientX - rect.left) / rect.width,
      y: (touch.clientY - rect.top) / rect.height,
    };
  }

  function markDirty() { dirty = true; scheduleAutosave(); }

  // Autosave: annotations persist without a save button (quick-annotate UX);
  // debounced so a long sketch doesn't write every stroke.
  let saveTimer = 0;
  function scheduleAutosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1200);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!dirty) return;
    dirty = false;
    const aspect = canvas.height ? canvas.width / canvas.height : null;
    await saveAnnotationRec(attachmentId, page, strokes, aspect);
    onSaved?.();
  }

  function startStroke(e) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!panGesture && activePointers.size >= 2) {
      panGesture = true;
      cancelStroke();
      return;
    }
    if (panGesture) return;
    if (tool === 'pan') return;
    e.preventDefault();
    const pos = getPos(e);

    if (tool === 'select') {
      if (onResizeHandle(pos)) {
        selDrag = { startPos: pos, orig: cloneStroke(strokes[selectedIndex]), moved: false, resize: true };
        return;
      }
      const idx = hitTest(pos);
      selectedIndex = idx;
      selDrag = idx >= 0
        ? { startPos: pos, orig: cloneStroke(strokes[idx]), moved: false }
        : null;
      redraw();
      updateSelMenu();
      return;
    }

    if (tool === 'text') {
      // Arm only — prompt opens after the tap ENDS (Android pointer-capture
      // wedge; see setlist/annotation.js).
      pendingText = pos;
      return;
    }

    if (tool === 'eraser') {
      const threshold = 0.03;
      const before = strokes.length;
      strokes = strokes.filter(s => {
        if (s.type === 'text') {
          return Math.abs(s.x - pos.x) > threshold || Math.abs(s.y - pos.y) > threshold;
        }
        if (!s.points) return true;
        return !s.points.some(p =>
          Math.abs(p.x - pos.x) < threshold && Math.abs(p.y - pos.y) < threshold
        );
      });
      if (strokes.length !== before) { undoStack = []; markDirty(); }
      redraw();
      return;
    }

    const point = { ...pos };
    // Real pens report pressure; touch/mouse report a constant (0.5/0) that
    // would just add noise, so only record it for pointerType 'pen'.
    if (e.pointerType === 'pen' && e.pressure > 0 && tool === 'pen') point.p = e.pressure;
    currentStroke = {
      type: tool,
      color,
      size: lineWidth,
      points: [point],
    };

    longPressStart = pos;
    cancelLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const idx = hitTest(pos);
      if (idx < 0) return;
      currentStroke = null;
      setTool('select');
      selectedIndex = idx;
      selDrag = { startPos: pos, orig: cloneStroke(strokes[idx]), moved: false };
      redraw();
      updateSelMenu();
      try { navigator.vibrate?.(15); } catch {}
    }, LONG_PRESS_MS);
  }

  function moveStroke(e) {
    const tracked = activePointers.get(e.pointerId);
    if (tracked) {
      const dx = e.clientX - tracked.x;
      const dy = e.clientY - tracked.y;
      tracked.x = e.clientX;
      tracked.y = e.clientY;
      if (panGesture) {
        if (scroller) {
          scroller.scrollTop -= dy / activePointers.size;
          scroller.scrollLeft -= dx / activePointers.size;
        }
        return;
      }
    }
    if (tool === 'select') {
      if (!selDrag || selectedIndex < 0) return;
      e.preventDefault();
      const pos = getPos(e);
      if (selDrag.resize) {
        const ax = selDrag.orig.x * canvas.width;
        const ay = selDrag.orig.y * canvas.height;
        const d0 = Math.hypot(selDrag.startPos.x * canvas.width - ax, selDrag.startPos.y * canvas.height - ay);
        const d1 = Math.hypot(pos.x * canvas.width - ax, pos.y * canvas.height - ay);
        if (d0 > 4) {
          strokes[selectedIndex].size = Math.min(48, Math.max(1, selDrag.orig.size * (d1 / d0)));
          selDrag.moved = true;
          redraw();
          updateSelMenu();
        }
        return;
      }
      const dx = pos.x - selDrag.startPos.x;
      const dy = pos.y - selDrag.startPos.y;
      if (Math.abs(dx) > 0.004 || Math.abs(dy) > 0.004) selDrag.moved = true;
      applyTranslate(strokes[selectedIndex], selDrag.orig, dx, dy);
      redraw();
      updateSelMenu();
      return;
    }
    if (tool === 'text') {
      if (pendingText) {
        const pos = getPos(e);
        if (Math.hypot(pos.x - pendingText.x, pos.y - pendingText.y) > 0.02) pendingText = null;
      }
      return;
    }
    if (!currentStroke) return;
    e.preventDefault();
    const pos = getPos(e);
    if (longPressTimer && longPressStart &&
        Math.hypot(pos.x - longPressStart.x, pos.y - longPressStart.y) > 0.02) {
      cancelLongPress();
    }
    const point = { ...pos };
    if (e.pointerType === 'pen' && e.pressure > 0 && currentStroke.type === 'pen') point.p = e.pressure;
    // Shapes only need endpoints: keep [start, current] instead of a trail.
    if (currentStroke.type === 'rect' || currentStroke.type === 'ellipse' || currentStroke.type === 'arrow') {
      currentStroke.points = [currentStroke.points[0], point];
    } else {
      currentStroke.points.push(point);
    }
    redraw();
    drawStrokeOnCanvas(ctx, canvas, currentStroke);
  }

  function endStroke(e) {
    activePointers.delete(e.pointerId);
    if (panGesture) {
      if (activePointers.size === 0) panGesture = false;
      return;
    }
    cancelLongPress();
    if (tool === 'text') {
      const at = pendingText;
      pendingText = null;
      if (!at || e.type !== 'pointerup') return;
      e.preventDefault();
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      setTimeout(() => {
        const text = prompt('Annotation text:');
        if (!text) return;
        strokes.push({ type: 'text', text, x: at.x, y: at.y, color, size: textSizeForWidth(lineWidth) });
        undoStack = [];
        redraw();
        markDirty();
      }, 0);
      return;
    }
    if (tool === 'select') {
      if (selDrag?.moved) { undoStack = []; markDirty(); }
      selDrag = null;
      return;
    }
    if (!currentStroke) return;
    e.preventDefault();
    if (currentStroke.points.length >= 2) {
      strokes.push(currentStroke);
      undoStack = [];
      markDirty();
    }
    currentStroke = null;
    redraw();
  }

  function cancelStroke(e) {
    if (e) {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) panGesture = false;
    }
    cancelLongPress();
    pendingText = null;
    currentStroke = null;
    if (selDrag && selectedIndex >= 0 && selDrag.orig) {
      strokes[selectedIndex] = cloneStroke(selDrag.orig);
    }
    selDrag = null;
    redraw();
    updateSelMenu();
  }

  canvas.addEventListener('pointerdown', startStroke, { signal });
  canvas.addEventListener('pointermove', moveStroke, { signal });
  canvas.addEventListener('pointerup', endStroke, { signal });
  canvas.addEventListener('pointerleave', endStroke, { signal });
  canvas.addEventListener('pointercancel', cancelStroke, { signal });
  canvas.style.touchAction = 'none';

  function setTool(name) {
    tool = name;
    toolbar.querySelectorAll('.mn-ann-tool').forEach(t => {
      t.classList.toggle('mn-btn-primary', t.dataset.tool === name);
    });
    if (name === 'pan') {
      canvas.style.pointerEvents = 'none';
      canvas.style.cursor = 'default';
    } else {
      canvas.style.pointerEvents = '';
      canvas.style.cursor = name === 'select' ? 'move' : 'crosshair';
    }
    if (name !== 'select') clearSelection();
  }
  toolbar.querySelectorAll('.mn-ann-tool').forEach(b => {
    b.addEventListener('click', () => setTool(b.dataset.tool), { signal });
  });
  toolbar.querySelector('[data-tool="pen"]')?.classList.add('mn-btn-primary');

  const colorInput = toolbar.querySelector('.mn-ann-color');
  function setColor(c) {
    color = c;
    if (colorInput) colorInput.value = c;
    if (tool === 'select' && selectedIndex >= 0) {
      strokes[selectedIndex].color = c;
      undoStack = [];
      redraw();
      markDirty();
    }
  }
  if (colorInput) colorInput.addEventListener('input', (e) => setColor(e.target.value), { signal });
  // Quick palette swatches share the same state as the picker.
  toolbar.querySelectorAll('.mn-ann-swatch').forEach(b => {
    b.addEventListener('click', () => setColor(b.dataset.color), { signal });
  });

  const sizeSelect = toolbar.querySelector('.mn-ann-size');
  if (sizeSelect) sizeSelect.addEventListener('change', (e) => {
    lineWidth = parseInt(e.target.value);
    if (tool === 'select' && selectedIndex >= 0) {
      strokes[selectedIndex].size = strokes[selectedIndex].type === 'text'
        ? textSizeForWidth(lineWidth)
        : lineWidth;
      undoStack = [];
      redraw();
      updateSelMenu();
      markDirty();
    }
  }, { signal });

  // ── Floating selection menu ──
  const selWrap = canvas.parentElement;
  const selMenu = document.createElement('div');
  selMenu.className = 'mn-ann-selmenu';
  selMenu.style.display = 'none';
  const makeSelBtn = (cls, label) => {
    const b = document.createElement('button');
    b.className = `mn-btn ${cls}`;
    b.textContent = label;
    return b;
  };
  const selEditBtn = makeSelBtn('mn-btn-xs', 'edit text');
  const selDelBtn = makeSelBtn('mn-btn-xs mn-btn-danger', 'delete');
  const selCloseBtn = makeSelBtn('mn-btn-xs mn-btn-ghost', '×');
  selCloseBtn.title = 'Deselect';
  selMenu.append(selEditBtn, selDelBtn, selCloseBtn);
  if (selWrap) selWrap.appendChild(selMenu);

  function updateSelMenu() {
    const s = selectedIndex >= 0 ? strokes[selectedIndex] : null;
    const b = s ? strokeBBox(s) : null;
    if (!s || !b) { selMenu.style.display = 'none'; return; }
    selEditBtn.style.display = s.type === 'text' ? '' : 'none';
    selMenu.style.display = 'flex';
    const maxLeft = Math.max(2, canvas.width - selMenu.offsetWidth - 2);
    selMenu.style.left = Math.min(Math.max(2, b.x), maxLeft) + 'px';
    selMenu.style.top = Math.max(2, b.y - selMenu.offsetHeight - 6) + 'px';
  }

  selEditBtn.addEventListener('click', () => {
    if (selectedIndex < 0) return;
    const s = strokes[selectedIndex];
    if (s.type !== 'text') return;
    const text = prompt('Edit annotation text:', s.text);
    if (text === null) return;
    if (text.trim() === '') {
      strokes.splice(selectedIndex, 1);
      selectedIndex = -1;
    } else {
      s.text = text;
    }
    undoStack = [];
    redraw();
    updateSelMenu();
    markDirty();
  }, { signal });

  selDelBtn.addEventListener('click', () => {
    if (selectedIndex < 0) return;
    strokes.splice(selectedIndex, 1);
    selectedIndex = -1;
    selDrag = null;
    undoStack = [];
    redraw();
    updateSelMenu();
    markDirty();
  }, { signal });

  selCloseBtn.addEventListener('click', () => clearSelection(), { signal });

  toolbar.querySelector('#mn-ann-undo')?.addEventListener('click', () => {
    if (strokes.length) {
      undoStack.push(strokes.pop());
      redraw();
      markDirty();
    }
  }, { signal });

  toolbar.querySelector('#mn-ann-redo')?.addEventListener('click', () => {
    if (undoStack.length) {
      strokes.push(undoStack.pop());
      redraw();
      markDirty();
    }
  }, { signal });

  toolbar.querySelector('#mn-ann-clear')?.addEventListener('click', () => {
    if (strokes.length && confirm('Clear all annotations?')) {
      undoStack = [...strokes];
      strokes = [];
      redraw();
      markDirty();
    }
  }, { signal });

  loadAnnotation(attachmentId, page).then(data => {
    if (data?.strokes) {
      strokes = data.strokes;
      redraw();
    }
  });

  window.addEventListener('resize', resize, { signal });
  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  resize();

  return {
    resize,
    redraw,
    flush: saveNow,
    destroy() { saveNow(); ac.abort(); ro.disconnect(); cancelLongPress(); selMenu.remove(); },
    getStrokes() { return strokes; },
  };
}

// Composite the base image + strokes into a PNG Blob (flatten/export).
export function renderAnnotatedImageBlob(imageBitmap, strokes, { maxWidth = 2560 } = {}) {
  const scale = Math.min(1, maxWidth / imageBitmap.width);
  const c = document.createElement('canvas');
  c.width = Math.round(imageBitmap.width * scale);
  c.height = Math.round(imageBitmap.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(imageBitmap, 0, 0, c.width, c.height);
  for (const s of strokes) drawStrokeOnCanvas(ctx, c, s);
  return new Promise((resolve, reject) => {
    c.toBlob(b => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
  });
}
