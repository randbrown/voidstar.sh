// Smoke tests for live-coding mode (qualia.code / livecode):
//   node scripts/check-qualia-code-mode.mjs
//
// Covers code-mode.js on its own, with fake controls: entering switches only
// what's on and echoes exactly those calls; exiting restores in reverse order
// (timers last); a control changed while in code mode is kept, not clobbered;
// the snapshot survives a "reload" (a fresh instance over the same storage);
// double enter / double exit are no-ops. The code-api wiring (which controls,
// which qualia.* calls) runs in the browser.

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { createCodeMode } = await import('../src/lib/qualia/code-mode.js');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

function rig(initial) {
  const state = { ...initial };
  const writes = [];
  const ctl = (key, off, expr) => ({
    key, label: key, off,
    get: () => state[key],
    set: (v) => { state[key] = v; writes.push(key); },
    expr,
  });
  const controls = [
    ctl('autoCycle', 0, (v) => `qualia.autoCycle(${v})`),
    ctl('mosh', 'off', (v) => `qualia.glitch('mosh', '${v}')`),
    ctl('sparks', false, (v) => `qualia.overlay('sparks', ${v})`),
    ctl('quale', 'null', (v) => `qualia.quale('${v}')`),
  ];
  const shown = [];
  const changes = [];
  const make = () => createCodeMode({ controls, show: (l) => shown.push(l), onChange: (on) => changes.push(on) });
  return { state, writes, shown, changes, make };
}

section('enter strips only what is on');
{
  store.clear();
  const r = rig({ autoCycle: 30, mosh: 'flip', sparks: false, quale: 'fractal' });
  const cm = r.make();
  check('starts inactive', !cm.isActive());
  cm.set(true);
  check('active after enter', cm.isActive());
  check('everything at its off value', r.state.autoCycle === 0 && r.state.mosh === 'off' && r.state.sparks === false && r.state.quale === 'null');
  check('sparks (already off) not written', !r.writes.includes('sparks'));
  check('timers first, quale last', r.writes[0] === 'autoCycle' && r.writes.at(-1) === 'quale', r.writes.join());
  const lines = r.shown[0];
  check('echo block lists the header + 3 calls', lines.length === 4, JSON.stringify(lines));
  check('echo has the exact calls', lines.includes("qualia.glitch('mosh', 'off')") && lines.includes("qualia.quale('null')") && lines.includes('qualia.autoCycle(0)'));
  check('onChange(true)', r.changes[0] === true);

  r.writes.length = 0;
  cm.set(true);
  check('second enter is a no-op', r.writes.length === 0 && r.shown.length === 1);

  cm.set(false);
  check('inactive after exit', !cm.isActive());
  check('restored', r.state.autoCycle === 30 && r.state.mosh === 'flip' && r.state.quale === 'fractal' && r.state.sparks === false);
  check('quale first, timers last on exit', r.writes[0] === 'quale' && r.writes.at(-1) === 'autoCycle', r.writes.join());
  check('exit echo lists the restore calls', r.shown[1].includes("qualia.quale('fractal')") && r.shown[1].includes('qualia.autoCycle(30)'));
  check('storage cleared', store.size === 0);
  check('second exit is a no-op', cm.set(false) === false && r.shown.length === 2);
}

section('changes made in code mode are kept');
{
  store.clear();
  const r = rig({ autoCycle: 30, mosh: 'on', sparks: true, quale: 'fractal' });
  const cm = r.make();
  cm.set(true);
  r.state.quale = 'galaxy';     // the performer picked a quale from Strudel
  r.state.mosh = 'blip';        // and toggled a post by hand
  cm.set(false);
  check('quale kept', r.state.quale === 'galaxy');
  check('post kept', r.state.mosh === 'blip');
  check('untouched ones restored', r.state.autoCycle === 30 && r.state.sparks === true);
  const last = r.shown.at(-1);
  check('exit notes what it kept', last.some((l) => l.startsWith('// kept') && l.includes('quale') && l.includes('mosh')), JSON.stringify(last));
}

section('already bare');
{
  store.clear();
  const r = rig({ autoCycle: 0, mosh: 'off', sparks: false, quale: 'null' });
  const cm = r.make();
  cm.set(true);
  check('nothing written', r.writes.length === 0);
  check('echo says so', r.shown[0].some((l) => l.startsWith('// already bare')));
  cm.set(false);
  check('exit restores nothing', r.writes.length === 0 && r.shown[1].some((l) => l.startsWith('// nothing')));
}

section('survives a reload');
{
  store.clear();
  const r = rig({ autoCycle: 45, mosh: 'off', sparks: true, quale: 'chladni' });
  r.make().set(true);
  const after = r.make();       // fresh instance, same storage
  check('still active after reload', after.isActive());
  check('snapshot readable', after.snapshot()?.quale === 'chladni');
  after.toggle();
  check('restores after reload', r.state.quale === 'chladni' && r.state.autoCycle === 45 && r.state.sparks === true);
  check('snapshot null after exit', after.snapshot() === null);
}

section('a throwing control does not break the rest');
{
  store.clear();
  const r = rig({ autoCycle: 30, mosh: 'on', sparks: true, quale: 'fractal' });
  const cm = createCodeMode({
    controls: [
      { key: 'bad', label: 'bad', off: false, get: () => true, set: () => { throw new Error('nope'); }, expr: () => 'x' },
      { key: 'quale', label: 'quale', off: 'null', get: () => r.state.quale, set: (v) => { r.state.quale = v; }, expr: (v) => `qualia.quale('${v}')` },
    ],
  });
  const warn = console.warn; console.warn = () => {};
  cm.set(true);
  console.warn = warn;
  check('later controls still switched', r.state.quale === 'null');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall code-mode checks passed');
process.exit(failed ? 1 : 0);
