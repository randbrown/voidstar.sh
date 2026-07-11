// Smoke tests for the mind attachment-reference self-heal — pure functions
// only (no IndexedDB), so they run under plain node:
//   node scripts/check-mind-attach-heal.mjs
//
// Covers: the reported duplicate-and-trash case, name/kind matching, the
// sole-spare-image fallback, and the guards that refuse to guess ambiguously.

import { healBodyAttachmentRefs, bodyAttachmentRefs } from '../src/lib/mind/attach-heal.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const img = (id, name, deletedAt = 0) => ({ id, name, kind: 'image', deletedAt });

// ── (a) the reported case: body → trashed dup, live survivor same name ──
section('(a) repoint dead ref to live same-name survivor');
{
  const body = 'notes\n\n![image.png](mn-attach://DEAD)\n\nmore';
  const atts = [
    img('LIVE', 'image.png', 0),
    img('DEAD', 'image.png', 1720000000000),
  ];
  const r = healBodyAttachmentRefs(body, atts);
  check('changed', r.changed === true);
  check('body now points at LIVE', r.body.includes('mn-attach://LIVE') && !r.body.includes('mn-attach://DEAD'));
  check('one repoint DEAD→LIVE', r.repoints.length === 1 && r.repoints[0].from === 'DEAD' && r.repoints[0].to === 'LIVE');
}

// ── (b) missing record (purged) → sole-spare-image fallback ──
section('(b) purged dead ref, single spare live image → repoint');
{
  const body = '![](mn-attach://GONE)';
  const atts = [img('LIVE', 'image.png', 0)]; // GONE has no record at all
  const r = healBodyAttachmentRefs(body, atts);
  check('changed', r.changed === true, JSON.stringify(r.repoints));
  check('points at LIVE', r.body === '![](mn-attach://LIVE)');
}

// ── (c) healthy reference is left untouched ──
section('(c) live reference untouched');
{
  const body = '![image.png](mn-attach://LIVE)';
  const r = healBodyAttachmentRefs(body, [img('LIVE', 'image.png', 0)]);
  check('unchanged', r.changed === false && r.body === body);
}

// ── (d) ambiguity guard: two live same-name images, one dead ref → no guess ──
section('(d) ambiguous same-name candidates → no repoint');
{
  const body = '![image.png](mn-attach://DEAD)';
  const atts = [
    img('LIVE1', 'image.png', 0),
    img('LIVE2', 'image.png', 0),
    img('DEAD', 'image.png', 1),
  ];
  const r = healBodyAttachmentRefs(body, atts);
  // Two dead-name matches AND two spare images → both paths ambiguous.
  check('unchanged (ambiguous)', r.changed === false, JSON.stringify(r.repoints));
}

// ── (e) never steal a live binary already referenced elsewhere ──
section('(e) live target already in use is not stolen');
{
  const body = '![image.png](mn-attach://LIVE)\n![image.png](mn-attach://DEAD)';
  const atts = [
    img('LIVE', 'image.png', 0),
    img('DEAD', 'image.png', 1),
  ];
  const r = healBodyAttachmentRefs(body, atts);
  // LIVE is claimed by the first ref; DEAD has no free survivor → leave it.
  check('unchanged (only survivor already claimed)', r.changed === false, JSON.stringify(r.repoints));
}

// ── (f) prefix-safety: repointing a short id never rewrites a longer one that
//        shares its prefix and appears elsewhere in the body ──
section('(f) id prefix safety on replace');
{
  const body = '![a.png](mn-attach://AB)\n![b.png](mn-attach://ABCDEF)';
  const atts = [
    img('AB', 'a.png', 1),        // dead → should repoint to LIVE_A
    img('LIVE_A', 'a.png', 0),    // its live survivor
    img('ABCDEF', 'b.png', 0),    // healthy ref sharing the "AB" prefix
  ];
  const r = healBodyAttachmentRefs(body, atts);
  check('AB repointed to LIVE_A', r.body.includes('mn-attach://LIVE_A'));
  check('no bare AB ref remains', !/mn-attach:\/\/AB(?![\w-])/.test(r.body));
  check('ABCDEF ref untouched (exactly once, uncorrupted)', (r.body.match(/mn-attach:\/\/ABCDEF(?![\w-])/g) || []).length === 1);
}

// ── (g) two independent dead refs each repoint to their own survivor ──
section('(g) two dead refs, two distinct survivors by name');
{
  const body = '![a.png](mn-attach://DA)\n![b.png](mn-attach://DB)';
  const atts = [
    img('DA', 'a.png', 1), img('LA', 'a.png', 0),
    img('DB', 'b.png', 1), img('LB', 'b.png', 0),
  ];
  const r = healBodyAttachmentRefs(body, atts);
  check('both repointed', r.body.includes('mn-attach://LA') && r.body.includes('mn-attach://LB'));
  check('no dead ids remain', !r.body.includes('mn-attach://DA') && !r.body.includes('mn-attach://DB'));
}

// ── (h) bodyAttachmentRefs extracts distinct ids in order ──
section('(h) ref extraction');
{
  const ids = bodyAttachmentRefs('![](mn-attach://x) ![](mn-attach://y) ![](mn-attach://x)');
  check('distinct, ordered', ids.length === 2 && ids[0] === 'x' && ids[1] === 'y', JSON.stringify(ids));
  check('empty body → []', bodyAttachmentRefs('').length === 0);
}

console.log(`\n${failed ? `FAILED ${failed}` : 'all attach-heal checks passed'}`);
process.exit(failed ? 1 : 0);
