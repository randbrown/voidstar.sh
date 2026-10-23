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
// New text strokes default to a condensed face (`font: 'narrow'`) — roughly
// 40% more characters per line than the mono at the same height, which is
// what a phone-width chart needs for real stage notes. Weight 600 is pinned
// and shipped by setlist.astro's Google Fonts import, same determinism rule
// as above. Strokes without a `font` field predate this and keep the mono,
// so existing annotations render exactly as authored.
const ANN_TEXT_FONT_NARROW = "'Roboto Condensed', 'Arial Narrow', sans-serif";
function annTextFont(stroke, px) {
  return stroke.font === 'narrow'
    ? `600 ${px}px ${ANN_TEXT_FONT_NARROW}`
    : `${px}px ${ANN_TEXT_FONT}`;
}
// Line pitch for multi-line text, as a multiple of the font size.
const ANN_TEXT_LINE_HEIGHT = 1.15;
function annTextLines(stroke) {
  return String(stroke.text || '').split('\n');
}
function annTextFontPx(stroke, canvas) {
  return (stroke.size * canvas.width) / 200; // stored size in width/200 units
}

// A canvas only draws a web font once it has loaded, and nothing in the DOM
// uses the narrow face — so the first paint would fall back to a wider font
// and never repaint. Resolves once it's ready (immediately if already).
let narrowFontReady = null;
function whenNarrowFontReady() {
  if (!narrowFontReady) {
    narrowFontReady = (document.fonts?.load
      ? document.fonts.load(`600 20px ${ANN_TEXT_FONT_NARROW}`)
      : Promise.resolve()
    ).catch(() => {});
  }
  return narrowFontReady;
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

// Size a CSS-stretched canvas's backing store to the device pixel ratio and
// return the logical (CSS-px) box every stroke is normalized against. At 1×
// on a ~3.5-DPR phone the ink — small condensed text especially — renders
// soft. Stroke math stays in CSS px through the context transform, so pen
// widths look exactly as before. The ratio is capped by total pixel area so
// a tall stacked-PDF chart can't exceed mobile canvas limits (it degrades
// toward the old 1× rather than failing to draw).
const MAX_CANVAS_PX = 16e6;
const MAX_CANVAS_SIDE = 16384;
export function fitCanvasToBox(canvas, ctx, rect) {
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const dpr = Math.max(1, Math.min(
    window.devicePixelRatio || 1, 3,
    Math.sqrt(MAX_CANVAS_PX / (w * h)),
    MAX_CANVAS_SIDE / Math.max(w, h),
  ));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
  return { width: rect.width, height: rect.height };
}

export function drawStrokeOnCanvas(ctx, canvas, stroke) {
  if (stroke.type === 'text') {
    // (x, y) is the FIRST line's baseline-left; later lines stack below it.
    const px = annTextFontPx(stroke, canvas);
    ctx.font = annTextFont(stroke, px);
    ctx.fillStyle = stroke.color;
    const x = stroke.x * canvas.width;
    const y = stroke.y * canvas.height;
    annTextLines(stroke).forEach((line, i) => {
      ctx.fillText(line, x, y + i * px * ANN_TEXT_LINE_HEIGHT);
    });
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
    const box = fitCanvasToBox(canvas, ctx, wrap.getBoundingClientRect());
    ctx.clearRect(0, 0, box.width, box.height);
    for (const s of strokes) {
      drawStrokeOnCanvas(ctx, box, s);
    }
  }
  const ro = new ResizeObserver(redraw);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  redraw();
  if (strokes.some(s => s.font === 'narrow')) whenNarrowFontReady().then(redraw);
  return { redraw, destroy: () => ro.disconnect() };
}

// Multi-line text entry for text annotations. window.prompt() is a
// single-line field everywhere (Android's has no newline key at all), so this
// is a small in-page sheet with a <textarea>: the keyboard's Enter key types
// a newline, and Add/Save commits. Pinned to the top of the viewport so the
// on-screen keyboard never covers it. Resolves the text, '' when Delete is
// tapped (callers already treat empty text as "remove the element"), or null
// on cancel.
function openTextSheet({ initial = '', title = 'Text', confirmLabel = 'Add', canDelete = false, color, narrow = true } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'sl-ann-textsheet-backdrop';
    const sheet = document.createElement('div');
    sheet.className = 'sl-ann-textsheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', title);
    const ta = document.createElement('textarea');
    ta.className = 'sl-ann-textsheet-input';
    ta.rows = 4;
    ta.value = initial;
    ta.placeholder = 'Annotation text — Enter for a new line';
    ta.setAttribute('enterkeyhint', 'enter');
    ta.autocapitalize = 'sentences';
    // Preview in the face the stroke will render with; the ink color reads
    // poorly on the sheet background, so only the font carries over.
    if (narrow) ta.style.fontFamily = ANN_TEXT_FONT_NARROW;
    if (color) ta.style.caretColor = color;
    const row = document.createElement('div');
    row.className = 'sl-ann-textsheet-actions';
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `sl-btn sl-btn-sm ${cls}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      // Plain Enter is a newline; Ctrl/Cmd+Enter commits on a hardware keyboard.
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(ta.value); }
    };
    document.addEventListener('keydown', onKey, true);
    row.append(mk('cancel', 'sl-btn-ghost', () => finish(null)));
    if (canDelete) row.append(mk('delete', 'sl-btn-danger', () => finish('')));
    row.append(mk(confirmLabel, 'sl-btn-primary', () => finish(ta.value)));
    sheet.append(ta, row);
    backdrop.append(sheet);
    // Tap outside the sheet = cancel. (pointerdown on the sheet itself must
    // not bubble into this.)
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) finish(null); });
    document.body.appendChild(backdrop);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

// Pen mode ("pen draws, finger edits") is a per-device preference: it turns
// itself on the first time a stylus touches the canvas, and the overflow
// menu's toggle turns it off/on again.
const STYLUS_MODE_KEY = 'sl-ann-stylus-mode';
function readStylusMode() {
  try { return localStorage.getItem(STYLUS_MODE_KEY); } catch { return null; }
}
function writeStylusMode(on) {
  try { localStorage.setItem(STYLUS_MODE_KEY, on ? '1' : '0'); } catch {}
}

// onUndoable(msg, undo): optional view hook for a transient "msg · undo"
// toast after a destructive tap (delete). Without it deletes still land on
// the undo history, just without the toast.
// onNotice(msg): optional passive status toast.
export function initAnnotationCanvas(canvas, songId, toolbar, { startBlank = false, onUndoable = null, onNotice = null } = {}) {
  const ctx = canvas.getContext('2d');
  // Logical (CSS-px) size of the drawing box — strokes normalize against
  // this, not the DPR-scaled backing store (see fitCanvasToBox).
  let box = { width: canvas.width, height: canvas.height };
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
  // Undo history: deep snapshots of `strokes` taken before every committed
  // mutation (ink, text, move, resize, recolor, delete, clear), so ↶ can
  // restore any of them, not only a freshly drawn stroke. Capped; stroke
  // arrays are small.
  let undoHistory = [];
  const UNDO_LIMIT = 60;
  // Unsaved-changes flag: set by every committed mutation, cleared by save.
  // The view layer reads it (isDirty) to auto-save when the editor is left
  // by an accidental back gesture / navigation instead of the Save button.
  let dirty = false;
  let selectedIndex = -1;
  let selDrag = null;
  // Drawing tool a long-press hijacked into select mode (null when the user
  // picked select from the toolbar themselves). Handed back when the
  // selection session ends — see endSelectSession.
  let selReturnTool = null;
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

  // ── Pen mode ("pen draws, finger edits") ──
  // The GoodNotes/Notability split: with a stylus in play, the pen is
  // always the active tool, and a finger never inks. One finger on an
  // element selects/drags it (no long-press, no tool switch), and one
  // finger on empty space scrolls. While the pen is down, touches are
  // ignored outright, which is palm rejection.
  let stylusMode = readStylusMode() === '1';
  let penDown = false;
  const fingerEdits = (e) => stylusMode && e.pointerType === 'touch';

  // ── Pinch to resize the selection ──
  // When the first finger landed ON the selected element, a second finger
  // scales it instead of scrolling. That's text size for text, and geometry
  // about the bbox center for ink. Anywhere else, two fingers still scroll.
  let pinch = null;

  function resize() {
    const wrap = canvas.parentElement;
    if (!wrap) return;
    box = fitCanvasToBox(canvas, ctx, wrap.getBoundingClientRect());
    redraw();
  }

  function redraw() {
    ctx.clearRect(0, 0, box.width, box.height);
    for (const stroke of strokes) {
      drawStrokeOnCanvas(ctx, box, stroke);
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
    const px = pos.x * box.width;
    const py = pos.y * box.height;
    return Math.abs(px - (b.x + b.w)) <= HANDLE_HIT_PX && Math.abs(py - (b.y + b.h)) <= HANDLE_HIT_PX;
  }

  // Bounding box of a stroke in canvas pixels (used for select/hit-test).
  function strokeBBox(stroke) {
    if (stroke.type === 'text') {
      const fontPx = annTextFontPx(stroke, box);
      ctx.font = annTextFont(stroke, fontPx);
      const lines = annTextLines(stroke);
      const w = Math.max(...lines.map(l => ctx.measureText(l).width));
      const x = stroke.x * box.width;
      const y = stroke.y * box.height;
      const extra = (lines.length - 1) * fontPx * ANN_TEXT_LINE_HEIGHT;
      return { x: x - 4, y: y - fontPx, w: w + 8, h: fontPx + extra + 8 };
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
      x: minX * box.width - pad,
      y: minY * box.height - pad,
      w: (maxX - minX) * box.width + pad * 2,
      h: (maxY - minY) * box.height + pad * 2,
    };
  }

  // Topmost (last-drawn) stroke whose bbox contains the normalized point.
  function hitTest(pos) {
    const px = pos.x * box.width;
    const py = pos.y * box.height;
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

  const snapshot = () => strokes.map(cloneStroke);
  // Record the pre-mutation state (or a snapshot captured earlier, e.g. at
  // the start of a drag). Returns it so a toast can check it's still the
  // newest entry before undoing.
  function checkpoint(snap = snapshot()) {
    undoHistory.push(snap);
    if (undoHistory.length > UNDO_LIMIT) undoHistory.shift();
    dirty = true;
    return snap;
  }
  function undo() {
    if (!undoHistory.length) return;
    clearSelection();
    endSelectSession();
    strokes = undoHistory.pop();
    dirty = true;
    redraw();
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

  // Scale a stroke by k relative to a pristine copy: text grows its font
  // (same 1..48 clamp as the corner handle), ink scales about its bbox
  // center. Normalized x and y scale by the same k, which is uniform in
  // pixels too, so shapes don't skew.
  function applyScale(stroke, base, k) {
    if (stroke.type === 'text') {
      stroke.size = Math.min(48, Math.max(1, base.size * k));
      return;
    }
    if (!base.points?.length) return;
    k = Math.min(5, Math.max(0.2, k));
    const xs = base.points.map(p => p.x);
    const ys = base.points.map(p => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    stroke.points = base.points.map(p => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
  }

  function clearSelection() {
    if (selectedIndex < 0) return;
    selectedIndex = -1;
    selDrag = null;
    updateSelMenu();
    redraw();
  }

  // A long-press flips the active drawing tool into select mode without the
  // user ever touching the toolbar (see startStroke). When that selection
  // session ends — delete, the × button, or a tap on empty canvas — hand the
  // original tool back. Without this the editor is silently left in select
  // mode, where taps only hit-test and nothing draws: "I deleted one
  // annotation and now I can't create any more."
  function endSelectSession() {
    const back = selReturnTool;
    selReturnTool = null;
    if (back && tool === 'select') setTool(back);
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
    if (e.pointerType === 'pen') {
      penDown = true;
      // First stylus contact on this device turns pen mode on (unless the
      // user has explicitly switched it off before).
      if (!stylusMode && readStylusMode() === null) {
        setStylusMode(true);
        onNotice?.('pen mode on: pen draws, finger scrolls & moves (⋯ to turn off)');
      }
    } else if (penDown && e.pointerType === 'touch') {
      return; // palm rejection: no finger input while the pen is down
    }
    // A new primary pointer means every finger has lifted, so anything still
    // tracked is a stray whose pointerup/pointercancel the browser never
    // delivered (mobile Chrome drops a captured touch stream without either
    // when a native dialog opens mid-gesture — e.g. the selection menu's
    // edit-text prompt while a second finger rests on the canvas). Trusting
    // strays bricks the editor: the map never empties, every later touch
    // counts as a second finger, and panGesture latches on forever — no tool
    // can ink again until the editor is rebuilt. Reset instead.
    if (e.isPrimary) {
      activePointers.clear();
      panGesture = false;
    }
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!panGesture && !pinch && activePointers.size === 2 && tool === 'select' &&
        selDrag && !selDrag.resize && selectedIndex >= 0) {
      // First finger is holding the selection → this is a pinch on it.
      const [a, b] = [...activePointers.values()];
      pinch = {
        d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
        base: cloneStroke(strokes[selectedIndex]),
      };
      return;
    }
    if (pinch) return; // a third finger during a pinch is ignored
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

    if (fingerEdits(e)) {
      // Pen mode: a finger never inks. On an element it grabs it right away
      // (the long-press session, minus the wait); on empty space it scrolls.
      const onHandle = tool === 'select' && onResizeHandle(pos);
      const idx = onHandle ? selectedIndex : hitTest(pos);
      if (idx >= 0) {
        if (tool !== 'select') { selReturnTool = tool; setTool('select'); }
        selectedIndex = idx;
        selDrag = { startPos: pos, orig: cloneStroke(strokes[idx]), before: snapshot(), moved: false, resize: onHandle };
        redraw();
        updateSelMenu();
        return;
      }
      if (tool === 'select' && selectedIndex >= 0) { clearSelection(); endSelectSession(); }
      panGesture = true;
      return;
    }
    // Pen mode: the pen always inks. If a finger grabbed something (a
    // hijacked select session), the pen landing off that selection ends the
    // session and draws straight away instead of spending the touch on a
    // deselect.
    if (stylusMode && e.pointerType === 'pen' && tool === 'select' && selReturnTool &&
        !onResizeHandle(pos) && hitTest(pos) !== selectedIndex) {
      clearSelection();
      endSelectSession();
    }

    if (tool === 'select') {
      // The resize handle of an already-selected text element wins over
      // hit-testing — it sits outside the glyphs, so hitTest alone would
      // read the grab as a deselect.
      if (onResizeHandle(pos)) {
        selDrag = { startPos: pos, orig: cloneStroke(strokes[selectedIndex]), before: snapshot(), moved: false, resize: true };
        return;
      }
      const idx = hitTest(pos);
      selectedIndex = idx;
      selDrag = idx >= 0
        ? { startPos: pos, orig: cloneStroke(strokes[idx]), before: snapshot(), moved: false }
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
      const snap = snapshot();
      strokes = strokes.filter(s => {
        if (s.type === 'text') {
          return Math.abs(s.x - pos.x) > threshold || Math.abs(s.y - pos.y) > threshold;
        }
        if (!s.points) return true;
        return !s.points.some(p =>
          Math.abs(p.x - pos.x) < threshold && Math.abs(p.y - pos.y) < threshold
        );
      });
      if (strokes.length !== before) checkpoint(snap);
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
      selReturnTool = tool;
      setTool('select');
      selectedIndex = idx;
      selDrag = { startPos: pos, orig: cloneStroke(strokes[idx]), before: snapshot(), moved: false };
      redraw();
      updateSelMenu();
      try { navigator.vibrate?.(15); } catch {}
    }, LONG_PRESS_MS);
  }

  function moveStroke(e) {
    // Keep every tracked finger's last position current, so the moment a
    // second finger lands the scroll deltas start from here (no jump).
    const tracked = activePointers.get(e.pointerId);
    // Untracked = hovering (mouse, S Pen hover) or a palm-rejected touch:
    // neither may drive a stroke or a selection drag.
    if (!tracked) return;
    {
      const dx = e.clientX - tracked.x;
      const dy = e.clientY - tracked.y;
      tracked.x = e.clientX;
      tracked.y = e.clientY;
      if (pinch) {
        if (activePointers.size >= 2 && selectedIndex >= 0) {
          const [a, b] = [...activePointers.values()];
          const k = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0;
          applyScale(strokes[selectedIndex], pinch.base, k);
          if (selDrag) selDrag.moved = true;
          redraw();
          updateSelMenu();
        }
        return;
      }
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
        const ax = selDrag.orig.x * box.width;
        const ay = selDrag.orig.y * box.height;
        const d0 = Math.hypot(selDrag.startPos.x * box.width - ax, selDrag.startPos.y * box.height - ay);
        const d1 = Math.hypot(pos.x * box.width - ax, pos.y * box.height - ay);
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
    drawStrokeOnCanvas(ctx, box, currentStroke);
  }

  function endStroke(e) {
    if (e.pointerType === 'pen' && e.type !== 'pointerleave') penDown = false;
    // Hover leaving the canvas, or a palm-rejected touch lifting — neither
    // started anything, so neither may end the live gesture.
    if (!activePointers.delete(e.pointerId)) return;
    if (pinch) {
      if (activePointers.size === 0) {
        pinch = null;
        if (selDrag?.moved) checkpoint(selDrag.before);
        selDrag = null;
      }
      return;
    }
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
      // Tapping an existing text element with the text tool edits it rather
      // than stacking a new one on top — no detour through select mode.
      const hit = hitTest(at);
      if (hit >= 0 && strokes[hit].type === 'text') {
        setTimeout(() => editTextStroke(hit), 0);
        return;
      }
      setTimeout(async () => {
        const text = await openTextSheet({ color });
        if (!text || !text.trim()) return;
        checkpoint();
        strokes.push({ type: 'text', text, font: 'narrow', x: at.x, y: at.y, color, size: textSizeForWidth(lineWidth) });
        redraw();
      }, 0);
      return;
    }
    if (tool === 'select') {
      if (selDrag?.moved) checkpoint(selDrag.before);
      selDrag = null;
      // A tap that landed on empty canvas (deselect) closes a long-press
      // selection session — give the hijacked drawing tool back.
      if (selectedIndex < 0) endSelectSession();
      return;
    }
    if (!currentStroke) return;
    e.preventDefault();
    if (currentStroke.points.length >= 2) {
      checkpoint();
      strokes.push(currentStroke);
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
      if (e.pointerType === 'pen') penDown = false;
      if (!activePointers.delete(e.pointerId)) return; // untracked: nothing live
      if (activePointers.size === 0) panGesture = false;
    }
    pinch = null;
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
    // An explicit toolbar pick is the user's own choice — it must stick, not
    // get overridden by a pending long-press-session restore.
    b.addEventListener('click', () => { selReturnTool = null; setTool(b.dataset.tool); }, { signal });
  });
  toolbar.querySelector('[data-tool="pen"]')?.classList.add('sl-btn-primary');

  const colorInput = toolbar.querySelector('.sl-ann-color');
  // The picker fires `input` continuously while dragging; one undo entry
  // per pick (closed by `change`), not one per intermediate hue.
  let recolorSnap = null;
  if (colorInput) colorInput.addEventListener('input', (e) => {
    color = e.target.value;
    // While an element is selected, the color picker recolors it in place.
    if (tool === 'select' && selectedIndex >= 0) {
      if (!recolorSnap) recolorSnap = checkpoint();
      strokes[selectedIndex].color = color;
      redraw();
    }
  }, { signal });
  if (colorInput) colorInput.addEventListener('change', () => { recolorSnap = null; }, { signal });

  const sizeSelect = toolbar.querySelector('.sl-ann-size');
  if (sizeSelect) sizeSelect.addEventListener('change', (e) => {
    lineWidth = parseInt(e.target.value);
    if (tool === 'select' && selectedIndex >= 0) {
      checkpoint();
      // Text sizes live on the mapped-up scale (see textSizeForWidth) —
      // assigning the raw pen width here would shrink a selected text
      // stroke back to the old illegible default.
      strokes[selectedIndex].size = strokes[selectedIndex].type === 'text'
        ? textSizeForWidth(lineWidth)
        : lineWidth;
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
  // Step resize: the corner handle is a fiddly target under a fingertip, so
  // text also gets one-tap smaller/bigger steps (±15%, same 1..48 clamp).
  const selShrinkBtn = makeSelBtn('sl-btn-xs', 'A−');
  selShrinkBtn.title = 'Smaller text';
  const selGrowBtn = makeSelBtn('sl-btn-xs', 'A+');
  selGrowBtn.title = 'Bigger text';
  const selDelBtn = makeSelBtn('sl-btn-xs sl-btn-danger', 'delete');
  const selCloseBtn = makeSelBtn('sl-btn-xs sl-btn-ghost', '×');
  selCloseBtn.title = 'Deselect';
  selMenu.append(selEditBtn, selShrinkBtn, selGrowBtn, selDelBtn, selCloseBtn);
  if (selWrap) selWrap.appendChild(selMenu);

  function updateSelMenu() {
    const s = selectedIndex >= 0 ? strokes[selectedIndex] : null;
    const b = s ? strokeBBox(s) : null;
    if (!s || !b) { selMenu.style.display = 'none'; return; }
    const isText = s.type === 'text';
    selEditBtn.style.display = isText ? '' : 'none';
    selShrinkBtn.style.display = isText ? '' : 'none';
    selGrowBtn.style.display = isText ? '' : 'none';
    selMenu.style.display = 'flex';
    const maxLeft = Math.max(2, box.width - selMenu.offsetWidth - 2);
    selMenu.style.left = Math.min(Math.max(2, b.x), maxLeft) + 'px';
    // Above the selection; flip below when the element sits too close to the
    // top — clamping would park the menu on top of the element (and the
    // finger that just tapped it), begging for accidental delete taps.
    const yAbove = b.y - selMenu.offsetHeight - 6;
    const top = yAbove >= 2
      ? yAbove
      : Math.min(b.y + b.h + 6, box.height - selMenu.offsetHeight - 2);
    selMenu.style.top = Math.max(2, top) + 'px';
  }

  // Edit a text element in the multi-line sheet; emptying it (or Delete)
  // removes the element. Shared by the selection menu and text-tool taps.
  async function editTextStroke(idx) {
    const s = strokes[idx];
    if (!s || s.type !== 'text') return;
    const text = await openTextSheet({
      initial: s.text, title: 'Edit text', confirmLabel: 'Save', canDelete: true,
      color: s.color, narrow: s.font === 'narrow',
    });
    if (text === null || strokes[idx] !== s || text === s.text) return;
    const snap = checkpoint();
    if (text.trim() === '') {
      strokes.splice(idx, 1);
      if (selectedIndex === idx) selectedIndex = -1;
      else if (selectedIndex > idx) selectedIndex--;
      offerUndo('text deleted', snap);
    } else {
      s.text = text;
    }
    redraw();
    updateSelMenu();
    // Emptying the text deleted the element — that ends the session.
    if (selectedIndex < 0) endSelectSession();
  }

  selEditBtn.addEventListener('click', () => {
    if (selectedIndex >= 0) editTextStroke(selectedIndex);
  }, { signal });

  const stepTextSize = (f) => {
    const s = selectedIndex >= 0 ? strokes[selectedIndex] : null;
    if (!s || s.type !== 'text') return;
    checkpoint();
    s.size = Math.min(48, Math.max(1, s.size * f));
    redraw();
    updateSelMenu();
  };
  selShrinkBtn.addEventListener('click', () => stepTextSize(1 / 1.15), { signal });
  selGrowBtn.addEventListener('click', () => stepTextSize(1.15), { signal });

  selDelBtn.addEventListener('click', () => {
    if (selectedIndex < 0) return;
    const snap = checkpoint();
    const kind = strokes[selectedIndex].type === 'text' ? 'text' : 'ink';
    strokes.splice(selectedIndex, 1);
    selectedIndex = -1;
    selDrag = null;
    offerUndo(`${kind} deleted`, snap);
    redraw();
    updateSelMenu();
    endSelectSession();
  }, { signal });

  selCloseBtn.addEventListener('click', () => { clearSelection(); endSelectSession(); }, { signal });

  // Toast-driven undo for destructive taps. It only fires while `snap` is
  // still the newest history entry — once anything else has been done, the
  // toast's undo would revert that instead, so it becomes a no-op (↶ still
  // walks back through everything).
  function offerUndo(msg, snap) {
    onUndoable?.(msg, () => {
      if (undoHistory[undoHistory.length - 1] === snap) undo();
    });
  }

  toolbar.querySelector('#sl-ann-undo')?.addEventListener('click', undo, { signal });

  toolbar.querySelector('#sl-ann-clear')?.addEventListener('click', () => {
    if (strokes.length && confirm('Clear all annotations? (↶ undo restores them)')) {
      clearSelection();
      endSelectSession();
      checkpoint();
      strokes = [];
      redraw();
    }
  }, { signal });

  // Pen mode toggle (lives in the view's overflow menu). Its label shows
  // the current state.
  const stylusToggle = toolbar.querySelector('#sl-ann-stylus');
  function syncStylusToggle() {
    if (!stylusToggle) return;
    stylusToggle.textContent = stylusMode ? '✓ pen mode: finger scrolls' : 'pen mode: off';
    stylusToggle.setAttribute('aria-pressed', stylusMode ? 'true' : 'false');
  }
  // Persists the choice — only on a real decision (first stylus contact or
  // a toggle tap). Never at init: a stored '0' means "the user turned it
  // off" and suppresses the auto-enable.
  function setStylusMode(on) {
    stylusMode = on;
    writeStylusMode(on);
    syncStylusToggle();
  }
  syncStylusToggle();
  if (stylusToggle) {
    stylusToggle.addEventListener('click', () => {
      setStylusMode(!stylusMode);
      onNotice?.(stylusMode
        ? 'pen mode on: pen draws, finger scrolls & moves'
        : 'pen mode off: finger draws, two fingers scroll');
    }, { signal });
  }

  // Shared by the Save button and the view layer's auto-save (accidental
  // back gesture / navigation with unsaved ink — see renderAnnotation).
  async function persist() {
    const aspect = box.height ? box.width / box.height : null;
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
  // New text defaults to the narrow face — warm it up so the first text
  // drop (and any loaded narrow text) paints in it, not a fallback.
  whenNarrowFontReady().then(() => { if (!signal.aborted) { redraw(); updateSelMenu(); } });

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
      undoHistory = []; // snapshots would carry the old normalization
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
