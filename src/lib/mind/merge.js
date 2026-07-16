// Line-level diff/merge core for resolving "Conflicted copy" notes.
//
// When two devices edit the same note body concurrently, the sync layer keeps
// the last-writer as the live note and preserves the loser as a "Conflicted
// copy of …" note (see shard.js mergeNotes). This module turns those two bodies
// into a block diff so the merge UI (views/conflict-modal.js) can let the user
// pick, hunk by hunk, which side's lines survive.
//
// diffLines / diffBlocks / applyMerge are PURE (string in, string out) so they
// unit-test under plain node — see scripts/check-mind-merge.mjs.

// Longest-common-subsequence diff over lines → a flat op list:
//   { t: 'same'|'del'|'add', line }   ('del' = only in a, 'add' = only in b)
export function diffLines(aLines, bLines) {
  const n = aLines.length;
  const m = bLines.length;
  // dp[i][j] = LCS length of aLines[i:] and bLines[j:]. One row longer/wider so
  // the base cases (empty suffix → 0) need no special-casing.
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { ops.push({ t: 'same', line: aLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', line: aLines[i] }); i++; }
    else { ops.push({ t: 'add', line: bLines[j] }); j++; }
  }
  while (i < n) ops.push({ t: 'del', line: aLines[i++] });
  while (j < m) ops.push({ t: 'add', line: bLines[j++] });
  return ops;
}

// Group the op stream into contiguous blocks the UI can render/choose:
//   { type: 'same',   base:[…], copy:[…] }  — identical on both sides (context)
//   { type: 'change', base:[…], copy:[…] }  — diverged run (either side may be
//                                             empty for a pure add/delete)
export function diffBlocks(baseBody, copyBody) {
  const a = String(baseBody ?? '').split('\n');
  const b = String(copyBody ?? '').split('\n');
  const blocks = [];
  let cur = null;
  for (const op of diffLines(a, b)) {
    const type = op.t === 'same' ? 'same' : 'change';
    if (!cur || cur.type !== type) { cur = { type, base: [], copy: [] }; blocks.push(cur); }
    if (op.t === 'same') { cur.base.push(op.line); cur.copy.push(op.line); }
    else if (op.t === 'del') cur.base.push(op.line);
    else cur.copy.push(op.line);
  }
  return blocks;
}

// Rebuild a body from per-change-block choices. `choiceFor(blockIndex)` returns
// 'base' (keep current, the default), 'copy' (take the conflicted copy), or
// 'both' (concatenate current then copy). 'same' blocks are always kept.
export function applyMerge(blocks, choiceFor) {
  const pick = typeof choiceFor === 'function' ? choiceFor : (i) => choiceFor?.[i];
  const out = [];
  blocks.forEach((blk, idx) => {
    if (blk.type === 'same') { out.push(...blk.base); return; }
    const c = pick(idx) || 'base';
    if (c === 'copy') out.push(...blk.copy);
    else if (c === 'both') out.push(...blk.base, ...blk.copy);
    else out.push(...blk.base);
  });
  return out.join('\n');
}

// True when the two bodies differ at all (cheap guard before opening the tool).
export function bodiesDiffer(baseBody, copyBody) {
  return String(baseBody ?? '') !== String(copyBody ?? '');
}

// Whitespace-collapsed view of a run of lines, for detecting changes that are
// invisible in the rendered note (blank lines, trailing spaces, tab↔space).
function visibleText(lines) {
  return lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// True for a change block whose two sides show the same visible text — the
// difference is only blank lines or whitespace. The merge UI names these
// explicitly; an empty highlighted bar otherwise reads as "identical".
export function blockIsInvisible(blk) {
  return visibleText(blk.base) === visibleText(blk.copy);
}

// Plain-English one-liner for a change block ("the copy has 1 blank line extra
// here"), so the merge UI can say what a hunk means instead of relying on diff
// colors alone.
export function describeChange(blk) {
  const count = (arr) => {
    const blank = arr.length && arr.every((l) => !l.trim());
    return `${arr.length} ${blank ? 'blank ' : ''}line${arr.length === 1 ? '' : 's'}`;
  };
  if (!blk.base.length) return `the copy has ${count(blk.copy)} extra here`;
  if (!blk.copy.length) return `the copy is missing ${count(blk.base)} here`;
  if (blockIsInvisible(blk)) return 'these lines differ only in blank lines or spacing — the visible text is the same';
  return blk.base.length === 1 && blk.copy.length === 1
    ? 'this line differs between the two versions'
    : 'these lines differ between the two versions';
}
