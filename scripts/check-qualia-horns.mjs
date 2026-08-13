// Smoke tests for the metal-horns 🤘 gesture math (src/lib/qualia/horns.js):
//   node scripts/check-qualia-horns.mjs
//
// Only horns.js is imported — it's the pure half (classifier + debounce);
// the worker/reaction wiring is exercised in the browser. Synthetic hands
// are built in MediaPipe HandLandmarker geometry: 21 normalized landmarks,
// wrist 0, fingers MCP→PIP→DIP→TIP.

import { isHornsHand, createHornsDetector } from '../src/lib/qualia/horns.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// Build a synthetic hand: wrist at (0.5, 0.9), middle MCP 0.25 up (the hand
// size the classifier normalizes by), each finger's PIP 0.35 from the wrist,
// tips at 0.50 (extended) or 0.28 (curled — folded back toward the palm).
// The classifier only measures wrist-relative distances, so putting every
// joint on one vertical line is geometrically honest.
function mkHand({ index = 'curl', middle = 'curl', ring = 'curl', pinky = 'curl' } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.9, z: 0 }));
  const up = (d) => ({ x: 0.5, y: 0.9 - d, z: 0 });
  lm[9] = up(0.25);                       // middle MCP — hand size anchor
  const finger = (pip, tip, state) => {
    lm[pip] = up(0.35);
    lm[tip] = up(state === 'ext' ? 0.50 : 0.28);
  };
  finger(6, 8, index);
  finger(10, 12, middle);
  finger(14, 16, ring);
  finger(18, 20, pinky);
  return lm;
}

section('isHornsHand — geometric classification');
check('horns 🤘 (index + pinky out, middle + ring curled)',
  isHornsHand(mkHand({ index: 'ext', pinky: 'ext' })));
check('fist is not horns', !isHornsHand(mkHand()));
check('open palm is not horns',
  !isHornsHand(mkHand({ index: 'ext', middle: 'ext', ring: 'ext', pinky: 'ext' })));
check('victory ✌ is not horns',
  !isHornsHand(mkHand({ index: 'ext', middle: 'ext' })));
check('pointing ☝ is not horns', !isHornsHand(mkHand({ index: 'ext' })));
check('pinky alone is not horns', !isHornsHand(mkHand({ pinky: 'ext' })));
check('junk shapes are not horns',
  !isHornsHand(null) && !isHornsHand([]) && !isHornsHand(mkHand().slice(0, 10)));
check('degenerate hand (all points coincident) is not horns', (() => {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  return !isHornsHand(lm);
})());

section('createHornsDetector — hold, debounce, re-arm');
{
  const horns = [mkHand({ index: 'ext', pinky: 'ext' })];
  const none = [];
  // ~7.5 fps hand cadence (worker runs hands every 2nd pose tick at 15 fps).
  const d = createHornsDetector({ holdMs: 250, rearmMs: 600, refractoryMs: 1000, missGraceMs: 300 });
  check('no fire on first sighting', d.update(horns, 0).fired === false);
  check('no fire before holdMs', d.update(horns, 133).fired === false);
  const held = d.update(horns, 266);
  check('fires once the hold lands', held.fired === true && held.count === 1);
  check('active while held', d.active() === true);
  check('no refire while still held',
    d.update(horns, 400).fired === false && d.update(horns, 533).fired === false);
  check('release clears active', (d.update(none, 933), d.active() === false));
  const back = createHornsDetector({ holdMs: 250, rearmMs: 600, refractoryMs: 1000, missGraceMs: 300 });
  check('single-frame flicker never fires',
    back.update(horns, 0).fired === false && back.update(none, 400).fired === false
    && back.count() === 0);
  // Miss grace: one dropped detection inside the window doesn't reset the hold.
  const g = createHornsDetector({ holdMs: 250, rearmMs: 600, refractoryMs: 1000, missGraceMs: 300 });
  g.update(horns, 0); g.update(none, 133); // dropped frame
  check('a dropped frame inside missGraceMs keeps the hold',
    g.update(horns, 266).fired === true);
  // Full cycle: fire → release past rearmMs → fresh hold → second fire.
  const c = createHornsDetector({ holdMs: 250, rearmMs: 600, refractoryMs: 1000, missGraceMs: 300 });
  c.update(horns, 0); c.update(horns, 133); c.update(horns, 266);
  check('first fire lands', c.count() === 1);
  c.update(none, 400); c.update(none, 1100); // released ≥ rearmMs
  c.update(horns, 1200); c.update(horns, 1333);
  const again = c.update(horns, 1466);
  check('re-arms after release and fires again', again.fired === true && again.count === 2);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
