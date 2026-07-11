// Smoke tests for the mind conflict merge core (pure diff/merge, no IndexedDB):
//   node scripts/check-mind-merge.mjs
//
// Covers: identical bodies, pure add/delete, mixed change blocks, and the
// per-hunk base/copy/both choices that applyMerge stitches back together.

import { diffLines, diffBlocks, applyMerge, bodiesDiffer } from '../src/lib/mind/merge.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const merge = (a, b, choices) => applyMerge(diffBlocks(a, b), choices);

// ── (a) identical bodies ──
section('(a) identical bodies');
{
  const body = 'line one\nline two\nline three';
  const blocks = diffBlocks(body, body);
  check('one same-block', blocks.length === 1 && blocks[0].type === 'same');
  check('bodiesDiffer = false', bodiesDiffer(body, body) === false);
  check('merge is a no-op', merge(body, body, {}) === body);
}

// ── (b) pure addition (copy adds a trailing line) ──
section('(b) copy adds a line');
{
  const base = 'a\nb';
  const copy = 'a\nb\nc';
  const blocks = diffBlocks(base, copy);
  const change = blocks.filter((x) => x.type === 'change');
  check('one change block', change.length === 1);
  check('change is copy-only', change[0].base.length === 0 && change[0].copy.join() === 'c');
  check('default (base) drops the add', merge(base, copy, {}) === 'a\nb');
  // The change block is the 2nd block (index 1): same[a,b] then change[+c].
  check('choose copy keeps the add', merge(base, copy, { 1: 'copy' }) === 'a\nb\nc');
  check('choose both == copy here', merge(base, copy, { 1: 'both' }) === 'a\nb\nc');
}

// ── (c) pure deletion (copy removed a line) ──
section('(c) copy removed a line');
{
  const base = 'a\nb\nc';
  const copy = 'a\nc';
  check('default keeps base line', merge(base, copy, {}) === 'a\nb\nc');
  check('choose copy removes it', merge(base, copy, { 1: 'copy' }) === 'a\nc');
}

// ── (d) a real divergence, choose per hunk ──
section('(d) mixed change, per-hunk choice');
{
  const base = 'title\nshared\nMINE mine mine\nfooter';
  const copy = 'title\nshared\nTHEIRS theirs\nfooter';
  const blocks = diffBlocks(base, copy);
  const changeIdx = blocks.map((b, i) => (b.type === 'change' ? i : -1)).filter((i) => i >= 0);
  check('exactly one change hunk', changeIdx.length === 1, String(changeIdx.length));
  const i = changeIdx[0];
  check('keep current', merge(base, copy, { [i]: 'base' }) === base);
  check('use copy', merge(base, copy, { [i]: 'copy' }) === copy);
  check('keep both (current then copy)',
    merge(base, copy, { [i]: 'both' }) === 'title\nshared\nMINE mine mine\nTHEIRS theirs\nfooter');
}

// ── (e) diffLines op stream sanity ──
section('(e) diffLines ops');
{
  const ops = diffLines(['x', 'y'], ['x', 'z', 'y']);
  check('same/add/same', ops.map((o) => o.t).join(',') === 'same,add,same', ops.map((o) => o.t).join(','));
  check('added line is z', ops[1].line === 'z');
}

// ── (f) applyMerge accepts a function selector ──
section('(f) function selector');
{
  const base = 'a\nMINE\nz';
  const copy = 'a\nYOURS\nz';
  const blocks = diffBlocks(base, copy);
  check('function selector picks copy', applyMerge(blocks, () => 'copy') === copy);
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
