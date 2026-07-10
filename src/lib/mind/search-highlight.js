// Search-match highlighting — shared between the list view (inject <mark> into
// escaped card text) and the note editor (a ProseMirror decoration plugin,
// which uses matchRanges() directly). Token semantics mirror search.js
// query(): lowercase, whitespace-split, substring AND-match.

import { esc } from './ui.js';

/** Split a raw query into lowercased substring tokens (mirrors search.js). */
export function tokenize(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Character ranges [start, end) in `text` matched by any token, merged so
 * overlapping/adjacent hits don't nest. Case-insensitive. Used by both the
 * list highlighter and the editor decoration plugin.
 */
export function matchRanges(text, tokens) {
  text = String(text ?? '');
  if (!tokens || !tokens.length || !text) return [];
  const lower = text.toLowerCase();
  const ranges = [];
  for (const tok of tokens) {
    if (!tok) continue;
    let i = 0;
    while ((i = lower.indexOf(tok, i)) !== -1) {
      ranges.push([i, i + tok.length]);
      i += tok.length;
    }
  }
  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * HTML-escape `text` and wrap every token match in <mark class="mn-hit">.
 * Segments are escaped individually so the <mark> tags are the only markup and
 * offsets are computed on the raw text (escaping never shifts them).
 */
export function markText(text, tokens) {
  text = String(text ?? '');
  const ranges = matchRanges(text, tokens);
  if (!ranges.length) return esc(text);
  let out = '';
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s > pos) out += esc(text.slice(pos, s));
    out += `<mark class="mn-hit">${esc(text.slice(s, e))}</mark>`;
    pos = e;
  }
  if (pos < text.length) out += esc(text.slice(pos));
  return out;
}

/**
 * A snippet centered on the first match, with the matches highlighted. Returns
 * escaped HTML (safe for innerHTML). With no tokens/match it falls back to the
 * head of the string (the old preview behavior). `…` marks a trimmed edge.
 */
export function snippetHighlighted(text, tokens, { max = 160, pad = 40 } = {}) {
  text = String(text ?? '');
  if (!tokens || !tokens.length) {
    return esc(text.slice(0, max)) + (text.length > max ? '…' : '');
  }
  const lower = text.toLowerCase();
  let first = -1;
  for (const tok of tokens) {
    const i = lower.indexOf(tok);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  if (first === -1) {
    return esc(text.slice(0, max)) + (text.length > max ? '…' : '');
  }
  const start = Math.max(0, first - pad);
  const end = start + max;
  const slice = text.slice(start, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + markText(slice, tokens) + suffix;
}
