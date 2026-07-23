// Annotation canvas for drawing on top of chart PDFs/documents.
// Supports pen, highlighter, text, arrow, eraser, and pan (scroll) tools.
// Persists strokes per-song in IndexedDB via the shared store connection.

import { getAnnotation, putAnnotation } from './store.js';

export async function loadAnnotation(songId) {
  return getAnnotation(songId);
}

// Persists via store.js's put() (not a raw transaction) so saving an
// annotation fires the shared _onWrite hook and queues a Drive backup push,
// same as editing a song or note.
async function saveAnnotation(songId, strokes, aspect) {
  // Persist the authoring canvas aspect ratio so other views (perform mode)
  // can reproduce the same box shape and keep strokes lined up with the chart.
  await putAnnotation({ songId, strokes, aspect: aspect || null });
}

// Text-annotation typography is deterministic and width-relative on purpose:
// stroke coordinates are normalized to the canvas box, so the font must scale
// with that same box or the text's footprint drifts relative to the chart
// between devices. The stack is also pinned — a var(--font-mono) inside a
// canvas font is invalid CSS and gets silently ignored, which is what left
// text annotations stuck at the canvas default 10px sans-serif regardless of
// the chosen size.
const ANN_TEXT_FONT = "'JetBrains Mono', ui-monospace, monospace";
function annTextFontPx(stroke, canvas) {
  return (stroke.size * canvas.width) / 200; // stored size in width/200 units
}

// The Fine/Medium/Thick select doubles as pen width and text size, but a
// 4-unit pen line and a 4-unit font live at very different scales: as a font,
// "Medium" rendered ≈2% of chart width — dwarfed by the chart's own
// 3.4%-of-width body type and illegible on a phone. New text strokes map the
// shared widths up so Medium lands ≈7% of width (twice the chart body text —
// the band hand-written stage notes actually occupy), Fine sits near body
// size, and Thick matches a big scrawled key-change callout. The mapped value
// is stored per stroke, so text authored before this mapping keeps the size
// it was drawn at.
const TEXT_SIZE_BY_WIDTH = { 2: 8, 4: 14, 8: 22 };
function textSizeForWidth(w) {
  return TEXT_SIZE_BY_WIDTH[w] || Math.round(w * 3.5);
}

export function drawStrokeOnCanvas(ctx, canvas, stroke) {
  if (stroke.type === 'text') {
    ctx.font = `${annTextFontPx(stroke, canvas)}px ${ANN_TEXT_FONT}`;
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

export function initAnnotationCanvas(canvas, songId, toolbar, { startBlank = false } = {}) {
  const ctx = canvas.getContext('2d');
  const ac = new AbortController();
  const { signal } = ac;
  let strokes = [];
  let currentStroke = null;
  let tool = 'pen';
  // The toolbar's controls are the source of truth for the starting color
  // and size — scratch-chart mode presets a dark paper ink there, and this
  // keeps the drawn stroke honest to what the pickers show.
  let color = toolbar.querySelector('.sl-ann-color')?.value || '#ff5e7e';
  let lineWidth = parseInt(toolbar.querySelector('.sl-ann-size')?.value) || 4;
  let undoStack = [];
  // Unsaved-changes flag: set by every committed mutation, cleared by save.
  // The view layer reads it (isDirty) to auto-save when the editor is left
  // by an accidental back gesture / navigation instead of the Save button.
  let dirty = false;
  let selectedIndex = -1;
  let selDrag = null;
  let pendingText = null;
  let longPressTimer = null;
  let longPressStart = null;
  const LONG_PRESS_MS = 500;

  // ── Two-finger scroll (mobile) ──
  // The canvas spans the whole chart with touch-action:none, so with a
  // drawing tool active no single-finger touch can ever scroll a long
  // document. Standard mobile annotation UX applies: one finger inks, a
  // second finger means "scroll" — any half-drawn ink from the first finger
  // is discarded and the gesture pans the scroll viewport until every
  // finger lifts. The 🖐 pan tool stays for one-finger (momentum) scrolling.
  const scroller = canvas.closest('.sl-annotation-wrap');
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
        if (strokes[selectedIndex].type === 'text') {
          // Resize handle: drag the bottom-right corner to scale the text.
          ctx.setLineDash([]);
          ctx.fillStyle = '#4ea1ff';
          ctx.fillRect(b.x + b.w - 5, b.y + b.h - 5, 10, 10);
        }
        ctx.restore();
      }
    }
  }

  // Generous touch target around the selection box's bottom-right corner.
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

  // Bounding box of a stroke in canvas pixels (used for select/hit-test).
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
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!panGesture && activePointers.size >= 2) {
      // Second finger down = scroll intent. The first finger's partial
      // stroke (or armed text tap / selection drag) is rolled back, not
      // committed — it was the start of this scroll, not ink.
      panGesture = true;
      cancelStroke();
      return;
    }
    if (panGesture) return;
    if (tool === 'pan') return;
    e.preventDefault();
    const pos = getPos(e);

    if (tool === 'select') {
      // The resize handle of an already-selected text element wins over
      // hit-testing — it sits outside the glyphs, so hitTest alone would
      // read the grab as a deselect.
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
      // Arm only — the prompt opens after the tap ENDS (see endStroke).
      // Opening a modal inside pointerdown wedges Android Chrome: the dialog
      // interrupts the touch sequence before pointerup, the canvas keeps its
      // implicit pointer capture, and every later tap — even on toolbar
      // buttons — routes back into this handler and re-prompts, with Save
      // unreachable.
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
      if (strokes.length !== before) { undoStack = []; dirty = true; }
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
    // Keep every tracked finger's last position current, so the moment a
    // second finger lands the scroll deltas start from here (no jump).
    const tracked = activePointers.get(e.pointerId);
    if (tracked) {
      const dx = e.clientX - tracked.x;
      const dy = e.clientY - tracked.y;
      tracked.x = e.clientX;
      tracked.y = e.clientY;
      if (panGesture) {
        // Each finger contributes its share of the centroid's movement, so
        // two fingers moving together scroll at finger speed.
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
        // Scale the text around its anchor (baseline-left): size follows the
        // handle's distance from the anchor relative to where the drag began.
        const ax = selDrag.orig.x * canvas.width;
        const ay = selDrag.orig.y * canvas.height;
        const d0 = Math.hypot(selDrag.startPos.x * canvas.width - ax, selDrag.startPos.y * canvas.height - ay);
        const d1 = Math.hypot(pos.x * canvas.width - ax, pos.y * canvas.height - ay);
        if (d0 > 4) {
          // Cap at 24% of chart width — room for a huge scrawled key change
          // (the mapped "Thick" is 11%) without an accidental screen-filler.
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
      // A drag isn't a text tap — disarm so pointerup doesn't prompt.
      if (pendingText) {
        const pos = getPos(e);
        if (Math.hypot(pos.x - pendingText.x, pos.y - pendingText.y) > 0.02) pendingText = null;
      }
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
    activePointers.delete(e.pointerId);
    if (panGesture) {
      // The gesture stays a scroll until every finger lifts — a lingering
      // finger must not turn back into ink mid-drag.
      if (activePointers.size === 0) panGesture = false;
      return;
    }
    cancelLongPress();
    if (tool === 'text') {
      const at = pendingText;
      pendingText = null;
      // Only a real tap-release prompts — pointerleave (finger slid off the
      // canvas) just disarms.
      if (!at || e.type !== 'pointerup') return;
      e.preventDefault();
      // Let go of the touch's implicit capture and let the gesture fully
      // finish before the modal opens — see the pointerdown comment.
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      setTimeout(() => {
        const text = prompt('Annotation text:');
        if (!text) return;
        strokes.push({ type: 'text', text, x: at.x, y: at.y, color, size: textSizeForWidth(lineWidth) });
        undoStack = [];
        dirty = true;
        redraw();
      }, 0);
      return;
    }
    if (tool === 'select') {
      if (selDrag?.moved) { undoStack = []; dirty = true; }
      selDrag = null;
      return;
    }
    if (!currentStroke) return;
    e.preventDefault();
    if (currentStroke.points.length >= 2) {
      strokes.push(currentStroke);
      undoStack = [];
      dirty = true;
    }
    currentStroke = null;
    redraw();
  }

  // The browser can abort a gesture mid-stroke (notification shade, incoming
  // modal, palm rejection). Reset without committing — a half-drawn stroke or
  // an armed text tap must not leak into the next gesture — and put a dragged
  // selection back where it started. Also called (without an event) when a
  // second finger turns the gesture into a scroll.
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
      dirty = true;
      redraw();
    }
  }, { signal });

  const sizeSelect = toolbar.querySelector('.sl-ann-size');
  if (sizeSelect) sizeSelect.addEventListener('change', (e) => {
    lineWidth = parseInt(e.target.value);
    if (tool === 'select' && selectedIndex >= 0) {
      // Text sizes live on the mapped-up scale (see textSizeForWidth) —
      // assigning the raw pen width here would shrink a selected text
      // stroke back to the old illegible default.
      strokes[selectedIndex].size = strokes[selectedIndex].type === 'text'
        ? textSizeForWidth(lineWidth)
        : lineWidth;
      undoStack = [];
      dirty = true;
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
    dirty = true;
    redraw();
    updateSelMenu();
  }, { signal });

  selDelBtn.addEventListener('click', () => {
    if (selectedIndex < 0) return;
    strokes.splice(selectedIndex, 1);
    selectedIndex = -1;
    selDrag = null;
    undoStack = [];
    dirty = true;
    redraw();
    updateSelMenu();
  }, { signal });

  selCloseBtn.addEventListener('click', () => clearSelection(), { signal });

  toolbar.querySelector('#sl-ann-undo')?.addEventListener('click', () => {
    if (strokes.length) {
      undoStack.push(strokes.pop());
      dirty = true;
      redraw();
    }
  }, { signal });

  toolbar.querySelector('#sl-ann-clear')?.addEventListener('click', () => {
    if (strokes.length && confirm('Clear all annotations?')) {
      undoStack = [...strokes];
      strokes = [];
      dirty = true;
      redraw();
    }
  }, { signal });

  // Shared by the Save button and the view layer's auto-save (accidental
  // back gesture / navigation with unsaved ink — see renderAnnotation).
  async function persist() {
    const aspect = canvas.height ? canvas.width / canvas.height : null;
    await saveAnnotation(songId, strokes, aspect);
    dirty = false;
  }

  toolbar.querySelector('#sl-ann-save')?.addEventListener('click', async () => {
    await persist();
    const saveBtn = toolbar.querySelector('#sl-ann-save');
    if (saveBtn) {
      saveBtn.textContent = 'Saved!';
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
    }
  }, { signal });

  // startBlank: an explicit from-scratch chart over a song that already has
  // chart-aligned annotations begins empty — loading them onto the blank
  // page would show fragments normalized against a different box shape.
  // (Saving still writes this song's single annotation record; the caller
  // confirms that overwrite before routing here.)
  if (!startBlank) loadAnnotation(songId).then(data => {
    if (data?.strokes) {
      strokes = data.strokes;
      redraw();
    }
  });

  window.addEventListener('resize', resize, { signal });
  // Also track the box itself: its aspect-ratio can change without a window
  // resize (e.g. the chart image loads and re-shapes the stage to its natural
  // aspect), and the drawing canvas must re-fit so strokes stay aligned.
  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  resize();

  return {
    resize,
    redraw,
    destroy() { ac.abort(); ro.disconnect(); cancelLongPress(); selMenu.remove(); },
    getStrokes() { return strokes; },
    isDirty() { return dirty; },
    save: persist,
    // Rescale every stroke's normalized y by `f`. Used when the scratch
    // page grows taller ("+ page"): y is normalized to box height, so a
    // taller box would stretch existing ink downward unless y compresses
    // by oldHeight/newHeight. x (and text size, which is width-relative)
    // are untouched — width doesn't change.
    scaleStrokeYs(f) {
      clearSelection();
      for (const s of strokes) {
        if (s.type === 'text') s.y *= f;
        else if (s.points) for (const p of s.points) p.y *= f;
      }
      undoStack = []; // popped strokes would carry the old normalization
      dirty = true;
      redraw();
    },
  };
}

// Render strokes onto an offscreen paper page and return a PNG Blob — the
// scratch-chart export. WYSIWYG with the authoring surface: same paper
// color, same stroke math. Text sizes are width-relative and follow the
// export width on their own; pen/highlighter/arrow widths are absolute
// canvas pixels, so they scale by exportWidth/sourceWidth to keep the
// authored ink weight.
export function renderStrokesToPngBlob(strokes, { aspect, sourceWidth, width = 1700, background = '#f4f1e8' }) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.max(1, Math.round(width / (aspect || 8.5 / 11)));
  const ctx = c.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, c.width, c.height);
  const k = sourceWidth ? width / sourceWidth : 1;
  for (const s of strokes) {
    drawStrokeOnCanvas(ctx, c, s.type === 'text' ? s : { ...s, size: s.size * k });
  }
  return new Promise((resolve, reject) => {
    c.toBlob(b => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
  });
}
