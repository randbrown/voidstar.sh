// Crawler code footholds — the words of the Strudel editor as places to stand.
//
// Rybin's reel works because the page is real DOM text: every foot grips a
// word. Our stage is pixels, but the live-code editor IS real DOM text, so
// while it's on screen and not being typed in, this module hands the crawler
// the client rects of the words CodeMirror is showing. The overlay converts
// them to device px and the sim grips them like the logo rect (crawler.js
// `holds`).
//
// Cost: one pass over the visible .cm-line nodes every SCAN_MS (not every
// frame), a Range rect per word, capped at MAX_HOLDS. Nothing is written to
// CodeMirror's DOM — it owns that subtree and rebuilds anything it doesn't
// recognise (see strudel-hydra.js injectStrudelTransparency), so all of the
// highlighting happens on the overlay's canvases instead.
//
// Disengaged (scan returns null) while the editor is hidden, scrolled to
// nothing, or FOCUSED: typing never has a spider walking across it.

export const CODE_MAX_HOLDS = 512;
const SCAN_MS = 200;
// Identifier-ish runs: s, bd, fast, 2, #fff, ~ — the "words" of a pattern.
// Punctuation (quotes, dots, brackets) splits them, so s("bd sd") is s/bd/sd.
const WORD = /[\p{L}\p{N}_#~]+/gu;

/**
 * @param {{ getMount: () => Element|null, isOpen?: () => boolean }} deps
 * @returns {{ scan: (now?: number) => CodeHolds|null }}
 *
 * CodeHolds = {
 *   n, rect: Float32Array(4·n) client-px x,y,w,h, text: string[],
 *   clip: {left, top, right, bottom} client px (the visible editor area),
 *   fontPx, fontFamily, version (bumps on every rescan),
 * }
 */
export function createCodeFootholds({ getMount, isOpen = () => true } = {}) {
  const holds = {
    n: 0, rect: new Float32Array(CODE_MAX_HOLDS * 4), text: new Array(CODE_MAX_HOLDS).fill(''),
    clip: { left: 0, top: 0, right: 0, bottom: 0 }, fontPx: 14, fontFamily: 'monospace', version: 0,
  };
  let lastScan = -1e9, lastResult = null;
  const range = typeof document !== 'undefined' ? document.createRange() : null;

  function editorParts() {
    const mount = getMount?.();
    if (!mount || !isOpen()) return null;
    const ed = mount.querySelector('strudel-editor');
    if (!ed) return null;
    const root = ed.shadowRoot || ed;
    const scroller = root.querySelector('.cm-scroller');
    const content = root.querySelector('.cm-content');
    if (!scroller || !content) return null;
    return { mount, ed, root, scroller, content };
  }

  /** True while the caret is in the editor (typing). Buttons in the panel
   *  header (▶, ■, sliders) sit outside the mount, so they don't count. */
  function editing(p) {
    const ae = document.activeElement;
    return !!ae && p.mount.contains(ae);
  }

  function scanNow(p) {
    const mr = p.mount.getBoundingClientRect();
    const sr = p.scroller.getBoundingClientRect();
    const left = Math.max(mr.left, sr.left), top = Math.max(mr.top, sr.top);
    const right = Math.min(mr.right, sr.right), bottom = Math.min(mr.bottom, sr.bottom);
    if (right - left < 8 || bottom - top < 8) return null;
    const clip = holds.clip;
    clip.left = left; clip.top = top; clip.right = right; clip.bottom = bottom;
    const cs = getComputedStyle(p.content);
    holds.fontPx = parseFloat(cs.fontSize) || 14;
    holds.fontFamily = cs.fontFamily || 'monospace';
    let n = 0;
    const R = holds.rect;
    const lines = p.content.querySelectorAll('.cm-line');
    for (let li = 0; li < lines.length && n < CODE_MAX_HOLDS; li++) {
      const line = lines[li];
      const lr = line.getBoundingClientRect();
      if (lr.bottom < top) continue;
      if (lr.top > bottom) break;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && n < CODE_MAX_HOLDS; node = walker.nextNode()) {
        const s = node.nodeValue;
        if (!s) continue;
        WORD.lastIndex = 0;
        let m;
        while ((m = WORD.exec(s)) && n < CODE_MAX_HOLDS) {
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const r = range.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          if (r.right < left || r.left > right || r.bottom < top || r.top > bottom) continue;
          const k = n * 4;
          R[k] = r.left; R[k + 1] = r.top; R[k + 2] = r.width; R[k + 3] = r.height;
          holds.text[n] = m[0];
          n++;
        }
      }
    }
    holds.n = n;
    holds.version++;
    return n > 0 ? holds : null;
  }

  function scan(now = performance.now()) {
    if (!range) return null;
    const p = editorParts();
    if (!p || editing(p)) { lastResult = null; lastScan = -1e9; return null; }
    if (now - lastScan >= SCAN_MS) {
      lastScan = now;
      try { lastResult = scanNow(p); } catch { lastResult = null; }
    }
    return lastResult;
  }

  return { scan };
}
