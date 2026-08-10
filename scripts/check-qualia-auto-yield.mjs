// Smoke tests for the auto-mode gating in the random-pattern generator:
//   node scripts/check-qualia-auto-yield.mjs
//
// `quale()` and auto-cycle drive the same knob, as do `qphase()` and
// auto-phase. randomPattern() parks (comments out) the lane whose timer is
// already running so a fresh roll never ships two masters for one control —
// see the note in patterns.js and the auto-yield half in code-api.js.
//
// Covers: the gate in all four on/off combinations, that a parked lane really
// is inert (commented, not merely absent), that parking never breaks the
// emitted JS, and that the teaching payload (header comment + one API nugget)
// survives even when both lanes are parked.
//
// The code-api half (the lane callbacks that switch the timers off) isn't
// reachable from node — code-api.js pulls in strudel-reference.js, whose JSON
// imports only resolve under Vite. It's exercised in the browser instead.

import { randomPattern, activeLanes, LANE_NAMES } from '../src/lib/qualia/patterns.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const ROLLS = 200;
const COMBOS = [
  { cycle: false, phase: false },
  { cycle: true,  phase: false },
  { cycle: false, phase: true  },
  { cycle: true,  phase: true  },
];

// A lane is LIVE when its call opens a line, PARKED when the same call sits
// behind a `//`. Anchoring on the line start is what distinguishes the two.
const live   = (fn, code) => new RegExp(`^\\s*${fn}\\(`, 'm').test(code);
const parked = (fn, code) => new RegExp(`^\\s*// ${fn}\\(.*parked`, 'm').test(code);

section('lane gating × auto modes');
for (const modes of COMBOS) {
  const label = `cycle:${modes.cycle ? 'on ' : 'off'} phase:${modes.phase ? 'on ' : 'off'}`;
  let bad = null;
  for (let i = 0; i < ROLLS && !bad; i++) {
    const code = randomPattern(modes);
    const want = {
      qualeLive:   !modes.cycle, qualeParked: modes.cycle,
      phaseLive:   !modes.phase, phaseParked: modes.phase,
    };
    const got = {
      qualeLive:   live('quale', code),   qualeParked: parked('quale', code),
      phaseLive:   live('qphase', code),  phaseParked: parked('qphase', code),
    };
    for (const k of Object.keys(want)) {
      if (want[k] !== got[k]) { bad = `${k}: want ${want[k]}, got ${got[k]}\n${code}`; break; }
    }
  }
  check(`${label} → right lanes live, right lanes parked (${ROLLS} rolls)`, !bad, bad);
}

section('emitted code stays valid');
for (const modes of COMBOS) {
  const label = `cycle:${modes.cycle ? 'on ' : 'off'} phase:${modes.phase ? 'on ' : 'off'}`;
  let bad = null;
  for (let i = 0; i < ROLLS && !bad; i++) {
    const code = randomPattern(modes);
    // Parse-only: every identifier in the pattern is a Strudel global that
    // doesn't exist here, so we must never CALL this — `new Function` compiles
    // the body and stops, which is exactly the syntax check we want.
    try { new Function(code); } catch (e) { bad = `${e.message}\n${code}`; }
  }
  check(`${label} → parses as JS (${ROLLS} rolls)`, !bad, bad);
}

section('teaching payload survives parking');
{
  const both = randomPattern({ cycle: true, phase: true });
  check('header comment kept', /silent qualia lanes/.test(both), both);
  check('one live API nugget remains',
    /^\s*(qset|qglitch|qcall)\(/m.test(both), both);
  check('parked lines say why they are off',
    (both.match(/parked — auto-(cycle|phase) is on/g) || []).length === 2, both);
}

section('default arg = ungated');
{
  // Callers with no view of the page state (and every pre-existing call site)
  // must keep getting the full pattern.
  const bare = randomPattern();
  check('no args → both lanes live', live('quale', bare) && live('qphase', bare), bare);
}

section('activeLanes — what the panel chip reports');
{
  const lanes = (code) => activeLanes(code).join(',');

  check('finds every lane name', lanes(
    'stack(quale("a"), qset("h", x), qpreset("p"), qphase("1"), qglitch("mosh","on"), qtext("t"), qcall(f,"1"), s("bd").qtrig(g))')
    === LANE_NAMES.join(','));

  check('a parked lane does not count',
    lanes('stack(\n  // quale("<a b>").slow(16),  // parked — auto-cycle is on\n  qphase("1"),\n)') === 'qphase');
  check('a block-commented lane does not count',
    lanes('/* quale("a") */ qphase("1")') === 'qphase');
  check('a lane name inside a string does not count',
    lanes('s("quale") .note("qphase")') === '');
  check('an escaped quote does not swallow the rest of the buffer',
    lanes('s("a\\"b"), quale("c")') === 'quale');
  check('template literals are stripped too',
    lanes('s(`quale(`), qphase("1")') === 'qphase');

  check('qualia.quale() is imperative, not a lane', lanes('qualia.quale("chaos")') === '');
  check('a lookalike identifier does not count', lanes('myquale("a"), xqset("b", 1)') === '');
  check('qtrig only counts when chained', lanes('qtrig(f, "1")') === '');
  check('chained qtrig counts', lanes('s("bd*4").qtrig(() => qualia.phase())') === 'qtrig');
  check('whitespace before the paren is fine', lanes('quale ("a")') === 'quale');
  check('division is not read as a comment', lanes('n(a / b), quale("c")') === 'quale');

  check('empty / junk input is safe',
    lanes('') === '' && lanes(null) === '' && lanes(undefined) === '');
}

section('activeLanes agrees with what the roller emitted');
for (const modes of COMBOS) {
  const label = `cycle:${modes.cycle ? 'on ' : 'off'} phase:${modes.phase ? 'on ' : 'off'}`;
  let bad = null;
  for (let i = 0; i < ROLLS && !bad; i++) {
    const code = randomPattern(modes);
    const got = activeLanes(code);
    if (got.includes('quale') === !!modes.cycle) bad = `quale: ${got}\n${code}`;
    else if (got.includes('qphase') === !!modes.phase) bad = `qphase: ${got}\n${code}`;
    else if (!got.some(l => ['qset', 'qglitch', 'qcall'].includes(l))) bad = `no nugget: ${got}\n${code}`;
  }
  check(`${label} → chip lists exactly the live lanes (${ROLLS} rolls)`, !bad, bad);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
