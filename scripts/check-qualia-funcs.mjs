// Keeps the funcs-tab / qualia.help() reference honest with the code API:
//   node scripts/check-qualia-funcs.mjs
//
// Source-text scan (code-api.js isn't node-importable — see
// check-qualia-edo.mjs). Asserts that:
//   1. every Strudel pattern function code-api.js registers via define()
//      (quale, qset, edo, jitune, …) has its own entry, named exactly, with
//      an example that calls it;
//   2. every top-level `qualia.*` member shows up in at least one example,
//      so searching its name always lands on runnable code;
//   3. every entry carries a doc, an example and a click-to-copy insert.

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/lib/qualia/code-api.js', import.meta.url), 'utf8');
const funcs = JSON.parse(readFileSync(new URL('../src/data/qualia-functions.json', import.meta.url), 'utf8'));

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

section('every entry is complete');
for (const f of funcs) {
  check(`${f.name}: doc + example + insert`, !!(f.doc && f.example && f.insert));
}

section('registered pattern functions (define) → own entry with example');
const defined = [...src.matchAll(/^\s*define\('([A-Za-z_$][\w$]*)'/gm)].map(m => m[1]);
check('found the define() registrations', defined.length >= 10, `${defined.length} found`);
for (const name of defined) {
  const f = funcs.find(e => e.name === name);
  check(`${name}() has an entry`, !!f);
  if (f) check(`${name}() example calls it`, new RegExp(`(^|[^\\w$.])\\.?${esc(name)}\\(`, 'm').test(f.example || ''));
}

section('top-level qualia.* members → appear in an example');
const start = src.indexOf('\n  const api = {');
const end = src.indexOf('\n  };', start);
check('found the api object', start > 0 && end > start);
const keys = [...new Set(
  [...src.slice(start, end).matchAll(/^ {4}([A-Za-z_$][\w$]*):/gm)].map(m => m[1]),
)];
const examples = funcs.map(f => f.example || '').join('\n');
for (const k of keys) {
  check(`qualia.${k}`, new RegExp(`qualia\\.${esc(k)}\\b`).test(examples));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
