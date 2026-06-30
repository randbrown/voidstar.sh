// Annotation canvas for drawing on top of chart PDFs/documents.
// Supports pen, highlighter, text, arrow, eraser, and pan (scroll) tools.
// Persists strokes per-song in IndexedDB via the shared store connection.

import { _openDb } from './store.js';

const ANNOTATIONS_STORE = 'annotations';

export async function loadAnnotation(songId) {
  const db = await _openDb();
  const tx = db.transaction(ANNOTATIONS_STORE, 'readonly');
  const store = tx.objectStore(ANNOTATIONS_STORE);
  return new Promise((resolve) => {
    const req = store.get(songId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function saveAnnotation(songId, strokes, aspect) {
  const db = await _openDb();
  const tx = db.transaction(ANNOTATIONS_STORE, 'readwrite');
  const store = tx.objectStore(ANNOTATIONS_STORE);
  // Persist the authoring canvas aspect ratio so other views (perform mode)
  // can reproduce the same box shape and keep strokes lined up with the chart.
  store.put({ songId, strokes, aspect: aspect || null, updatedAt: Date.now() });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export function drawStrokeOnCanvas(ctx, canvas, stroke) {
  if (stroke.type === 'text') {
    ctx.font = `${stroke.size * 4}px var(--font-mono), monospace`;
    ctx.fillStyle = stroke.color;
    ctx.fillText(stroke.text, stroke.x * canvas.width, stroke.y * canvas.height);
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
    ctx.moveTo(start.x * canvas.width, start.y * canvas.height);
    ctx.lineTo(end.x * canvas.width, end.y * canvas.height);
    ctx.stroke();

    const angle = Math.atan2(
      (end.y - start.y) * canvas.height,
      (end.x - start.x) * canvas.width
    );
    const headLen = stroke.size * 4;
    ctx.beginPath();
    ctx.moveTo(end.x * canvas.width, end.y * canvas.height);
    ctx.lineTo(
      end.x * canvas.width - headLen * Math.cos(angle - Math.PI / 6),
      end.y * canvas.height - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.moveTo(end.x * canvas.width, end.y * canvas.height);
    ctx.lineTo(
      end.x * canvas.width - headLen * Math.cos(angle + Math.PI / 6),
      end.y * canvas.height - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.stroke();
    return;
  }

  if (!stroke.points || stroke.points.length < 2) return;

  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.type === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = stroke.size * 3;
  }

  ctx.moveTo(stroke.points[0].x * canvas.width, stroke.points[0].y * canvas.height);
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i].x * canvas.width, stroke.points[i].y * canvas.height);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
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
    for (const s of strokes) {
      drawStrokeOnCanvas(ctx, canvas, s);
    }
  }
  const ro = new ResizeObserver(redraw);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  redraw();
  return { redraw, destroy: () => ro.disconnect() };
}

export function initAnnotationCanvas(canvas, songId, toolbar) {
  const ctx = canvas.getContext('2d');
  const ac = new AbortController();
  const { signal } = ac;
  let strokes = [];
  let currentStroke = null;
  let tool = 'pen';
  let color = '#ff5e7e';
  let lineWidth = 4;
  let undoStack = [];
  let selectedIndex = -1;
  let selDrag = null;
  let longPressTimer = null;
  let longPressStart = null;
  const LONG_PRESS_MS = 500;

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
    for (const stroke of strokes) {
      drawStrokeOnCanvas(ctx, canvas, stroke);
    }
    if (selectedIndex >= 0 && strokes[selectedIndex]) {
      const b = strokeBBox(strokes[selectedIndex]);
      if (b) {
        ctx.save();
        ctx.strokeStyle = '#4ea1ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.restore();
      }
    }
  }

  // Bounding box of a stroke in canvas pixels (used for select/hit-test).
  function strokeBBox(stroke) {
    if (stroke.type === 'text') {
      const fontPx = stroke.size * 4;
      ctx.font = `${fontPx}px var(--font-mono), monospace`;
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

  // Topmost (last-drawn) stroke whose bbox contains the normalized point.
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
    return { ...s, points: s.points ? s.points.map(p => ({ x: p.x, y: p.y })) : undefined };
  }

  // Translate a stroke by a normalized delta, relative to a pristine copy.
  function applyTranslate(stroke, orig, dx, dy) {
    if (stroke.type === 'text') {
      stroke.x = orig.x + dx;
      stroke.y = orig.y + dy;
    } else if (orig.points) {
      stroke.points = orig.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
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

  function startStroke(e) {
    if (tool === 'pan') return;
    e.preventDefault();
    const pos = getPos(e);

    if (tool === 'select') {
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
      const text = prompt('Annotation text:');
      if (!text) return;
      strokes.push({ type: 'text', text, x: pos.x, y: pos.y, color, size: lineWidth });
      undoStack = [];
      redraw();
      return;
    }

    if (tool === 'eraser') {
      const threshold = 0.03;
      strokes = strokes.filter(s => {
        if (s.type === 'text') {
          return Math.abs(s.x - pos.x) > threshold || Math.abs(s.y - pos.y) > threshold;
        }
        if (!s.points) return true;
        return !s.points.some(p =>
          Math.abs(p.x - pos.x) < threshold && Math.abs(p.y - pos.y) < threshold
        );
      });
      undoStack = [];
      redraw();
      return;
    }

    currentStroke = {
      type: tool,
      color,
      size: lineWidth,
      points: [pos],
    };

    // Long-press over an existing element grabs it and drops into select mode,
    // so you can move/edit/delete without first switching to the select tool.
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
    if (tool === 'select') {
      if (!selDrag || selectedIndex < 0) return;
      e.preventDefault();
      const pos = getPos(e);
      const dx = pos.x - selDrag.startPos.x;
      const dy = pos.y - selDrag.startPos.y;
      if (Math.abs(dx) > 0.004 || Math.abs(dy) > 0.004) selDrag.moved = true;
      applyTranslate(strokes[selectedIndex], selDrag.orig, dx, dy);
      redraw();
      updateSelMenu();
      return;
    }
    if (!currentStroke) return;
    e.preventDefault();
    const pos = getPos(e);
    // Real drawing motion means it's a stroke, not a long-press — disarm.
    if (longPressTimer && longPressStart &&
        Math.hypot(pos.x - longPressStart.x, pos.y - longPressStart.y) > 0.02) {
      cancelLongPress();
    }
    currentStroke.points.push(pos);
    redraw();
    drawStrokeOnCanvas(ctx, canvas, currentStroke);
  }

  function endStroke(e) {
    cancelLongPress();
    if (tool === 'select') {
      if (selDrag?.moved) undoStack = [];
      selDrag = null;
      return;
    }
    if (!currentStroke) return;
    e.preventDefault();
    if (currentStroke.points.length >= 2) {
      strokes.push(currentStroke);
      undoStack = [];
    }
    currentStroke = null;
    redraw();
  }

  canvas.addEventListener('pointerdown', startStroke, { signal });
  canvas.addEventListener('pointermove', moveStroke, { signal });
  canvas.addEventListener('pointerup', endStroke, { signal });
  canvas.addEventListener('pointerleave', endStroke, { signal });
  canvas.style.touchAction = 'none';

  // Toolbar wiring
  function setTool(name) {
    tool = name;
    toolbar.querySelectorAll('.sl-ann-tool').forEach(t => {
      t.classList.toggle('sl-btn-primary', t.dataset.tool === name);
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
  toolbar.querySelectorAll('.sl-ann-tool').forEach(b => {
    b.addEventListener('click', () => setTool(b.dataset.tool), { signal });
  });
  toolbar.querySelector('[data-tool="pen"]')?.classList.add('sl-btn-primary');

  const colorInput = toolbar.querySelector('.sl-ann-color');
  if (colorInput) colorInput.addEventListener('input', (e) => {
    color = e.target.value;
    // While an element is selected, the color picker recolors it in place.
    if (tool === 'select' && selectedIndex >= 0) {
      strokes[selectedIndex].color = color;
      undoStack = [];
      redraw();
    }
  }, { signal });

  const sizeSelect = toolbar.querySelector('.sl-ann-size');
  if (sizeSelect) sizeSelect.addEventListener('change', (e) => {
    lineWidth = parseInt(e.target.value);
    if (tool === 'select' && selectedIndex >= 0) {
      strokes[selectedIndex].size = lineWidth;
      undoStack = [];
      redraw();
      updateSelMenu();
    }
  }, { signal });

  // ── Floating selection menu (edit / delete the selected element) ──
  const selWrap = canvas.parentElement;
  const selMenu = document.createElement('div');
  selMenu.className = 'sl-ann-selmenu';
  selMenu.style.display = 'none';
  const makeSelBtn = (cls, label) => {
    const b = document.createElement('button');
    b.className = `sl-btn ${cls}`;
    b.textContent = label;
    return b;
  };
  const selEditBtn = makeSelBtn('sl-btn-xs', 'edit text');
  const selDelBtn = makeSelBtn('sl-btn-xs sl-btn-danger', 'delete');
  const selCloseBtn = makeSelBtn('sl-btn-xs sl-btn-ghost', '×');
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
  }, { signal });

  selDelBtn.addEventListener('click', () => {
    if (selectedIndex < 0) return;
    strokes.splice(selectedIndex, 1);
    selectedIndex = -1;
    selDrag = null;
    undoStack = [];
    redraw();
    updateSelMenu();
  }, { signal });

  selCloseBtn.addEventListener('click', () => clearSelection(), { signal });

  toolbar.querySelector('#sl-ann-undo')?.addEventListener('click', () => {
    if (strokes.length) {
      undoStack.push(strokes.pop());
      redraw();
    }
  }, { signal });

  toolbar.querySelector('#sl-ann-clear')?.addEventListener('click', () => {
    if (strokes.length && confirm('Clear all annotations?')) {
      undoStack = [...strokes];
      strokes = [];
      redraw();
    }
  }, { signal });

  toolbar.querySelector('#sl-ann-save')?.addEventListener('click', async () => {
    const aspect = canvas.height ? canvas.width / canvas.height : null;
    await saveAnnotation(songId, strokes, aspect);
    const saveBtn = toolbar.querySelector('#sl-ann-save');
    if (saveBtn) {
      saveBtn.textContent = 'Saved!';
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
    }
  }, { signal });

  loadAnnotation(songId).then(data => {
    if (data?.strokes) {
      strokes = data.strokes;
      redraw();
    }
  });

  window.addEventListener('resize', resize, { signal });
  resize();

  return {
    resize,
    redraw,
    destroy() { ac.abort(); cancelLongPress(); selMenu.remove(); },
    getStrokes() { return strokes; },
  };
}
