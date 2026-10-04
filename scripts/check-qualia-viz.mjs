// Sizing rules for the `viz` widget-options helper:
//   node scripts/check-qualia-viz.mjs

import { vizOptions, makeViz, HEIGHTS, MAX_PIXEL_RATIO } from '../src/lib/qualia/viz-opts.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const win = { width: 1400, height: 700, dpr: 3 };
const v = (...a) => vizOptions(a, win);
// Stand-in for a mini-notated "tall": anything with queryArc.
const pat = (value) => ({ queryArc: () => [{ value }] });

const d = v();
check('default = full width', d.width === 1400, d.width);
check('default = 1/7 height', d.height === 100, d.height);
check('pixelRatio capped', d.pixelRatio === MAX_PIXEL_RATIO, d.pixelRatio);
check('pixelRatio never below 1', vizOptions([], { width: 10, height: 10, dpr: 0.5 }).pixelRatio === 1);
check('preset name', v('tall').height === 175);
check('preset name, any case', v(' Half ').height === 350);
check('every preset resolves', Object.keys(HEIGHTS).every((k) => v(k).height === Math.round(700 * HEIGHTS[k])));
check('fraction', v(0.25).height === 175);
check('1 = full height', v(1).height === 700);
check('pixels', v(120).height === 120);
check('numeric string', v('0.5').height === 350);
check('unknown name → default', v('huge').height === 100);
check('zero / negative → default', v(0).height === 100 && v(-3).height === 100);
check('mini-notated preset (Pattern)', v(pat('tall')).height === 175);
const o = v({ height: 0.5, width: 0.5, thickness: 2 });
check('object height', o.height === 350);
check('object width fraction', o.width === 700);
check('extra options pass through', o.thickness === 2);
check('height + overrides', v('thin', { smear: 0.5 }).height === 50 && v('thin', { smear: 0.5 }).smear === 0.5);
check('object height beats positional', v('thin', { height: 'tall' }).height === 175);
check('patterned object height', v({ height: pat('half') }).height === 350);
check('explicit pixelRatio wins', v({ pixelRatio: 1 }).pixelRatio === 1);
const viz = makeViz(() => win);
check('viz() wrapper', viz().height === 100);
check('viz.tall()', viz.tall().height === 175);
check('viz.thin({…}) merges', viz.thin({ thickness: 1 }).thickness === 1);
let w = 800;
const live = makeViz(() => ({ width: w, height: 700 }));
const first = live().width; w = 1000;
check('reads the window on every call', first === 800 && live().width === 1000);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
