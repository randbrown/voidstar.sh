// Guards the qualia canvas "void" against the drift that made the voidstar
// stage read purplish:
//   node scripts/check-qualia-void.mjs
//
// History: the fx layer hardcoded #05050d as "the page bg" in ~20 places. That
// was the old --void; when the voidstar theme was retuned to true-black
// #010104, the fx layer kept the stale value, so the canvas (which screen-blends
// over Hydra) read blue-black instead of the site's black. We retired the
// literal in favor of the VOID constant in src/lib/qualia/field.js.
//
// This locks that down:
//   (a) VOID (field.js) still equals the voidstar theme's --void (themes.css),
//       so retuning one without the other fails CI instead of drifting silently.
//   (b) the retired #05050d never creeps back into the qualia engine.
//   (c) the Null quale stays truly empty (clearRect, no color fill).

import { readFileSync, readdirSync } from 'node:fs';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── (a) VOID === voidstar --void ──────────────────────────────────────────
const field = readFileSync('src/lib/qualia/field.js', 'utf8');
const css = readFileSync('src/styles/themes.css', 'utf8');

const voidConst = field.match(/export\s+const\s+VOID\s*=\s*'(#[0-9a-fA-F]{6})'/)?.[1]?.toLowerCase();
// Scope to the :root block (the voidstar defaults) — everything before the
// first [data-theme=...] override selector.
const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('[data-theme'));
const themeVoid = rootBlock.match(/--void:\s*(#[0-9a-fA-F]{6})/)?.[1]?.toLowerCase();

check('field.js exports a VOID hex', !!voidConst, 'export const VOID = "#rrggbb" not found');
check('themes.css :root defines --void', !!themeVoid, '--void not found in :root');
check('VOID matches the voidstar --void', voidConst && voidConst === themeVoid,
      `VOID=${voidConst} vs --void=${themeVoid}`);

// ── (b) the retired #05050d must not return to the qualia engine ───────────
function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const offenders = jsFiles('src/lib/qualia').filter(f => /#05050d/i.test(readFileSync(f, 'utf8')));
check('no legacy #05050d in src/lib/qualia', offenders.length === 0, offenders.join(', '));

// ── (c) Null quale stays empty (clearRect, no color fill) ──────────────────
const nullFx = readFileSync('src/lib/qualia/fx/null.js', 'utf8');
check('Null quale clears to transparent', /clearRect\s*\(/.test(nullFx));
check('Null quale does not fill a color', !/fillRect\s*\(/.test(nullFx) && !/fillStyle/.test(nullFx));

console.log(failed ? `\ncheck-qualia-void: ${failed} FAILED` : '\ncheck-qualia-void: all good');
process.exit(failed ? 1 : 0);
