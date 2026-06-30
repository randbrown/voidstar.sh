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

async function saveAnnotation(songId, strokes) {
  const db = await _openDb();
  const tx = db.transaction(ANNOTATIONS_STORE, 'readwrite');
  const store = tx.objectStore(ANNOTATIONS_STORE);
  store.put({ songId, strokes, updatedAt: Date.now() });
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
  }

  function moveStroke(e) {
    if (!currentStroke) return;
    e.preventDefault();
    const pos = getPos(e);
    currentStroke.points.push(pos);
    redraw();
    drawStrokeOnCanvas(ctx, canvas, currentStroke);
  }

  function endStroke(e) {
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
  toolbar.querySelectorAll('.sl-ann-tool').forEach(b => {
    b.addEventListener('click', () => {
      toolbar.querySelectorAll('.sl-ann-tool').forEach(t => t.classList.remove('sl-btn-primary'));
      b.classList.add('sl-btn-primary');
      tool = b.dataset.tool;
      if (tool === 'pan') {
        canvas.style.pointerEvents = 'none';
        canvas.style.cursor = 'default';
      } else {
        canvas.style.pointerEvents = '';
        canvas.style.cursor = 'crosshair';
      }
    }, { signal });
  });
  toolbar.querySelector('[data-tool="pen"]')?.classList.add('sl-btn-primary');

  const colorInput = toolbar.querySelector('.sl-ann-color');
  if (colorInput) colorInput.addEventListener('input', (e) => { color = e.target.value; }, { signal });

  const sizeSelect = toolbar.querySelector('.sl-ann-size');
  if (sizeSelect) sizeSelect.addEventListener('change', (e) => { lineWidth = parseInt(e.target.value); }, { signal });

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
    await saveAnnotation(songId, strokes);
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
    destroy() { ac.abort(); },
    getStrokes() { return strokes; },
  };
}
