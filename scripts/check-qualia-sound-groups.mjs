// Bank vs sample split for the Strudel sounds tab:
//   node scripts/check-qualia-sound-groups.mjs

import { groupSounds, filterGroups, bankMatches, SOUND_VIEWS } from '../src/lib/qualia/sound-groups.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const S = (name, count = 1, extra = {}) => ({ name, type: 'sample', count, ...extra });
const list = [
  S('rolandtr909_bd', 3), S('rolandtr909_sd'), S('rolandtr909_hh'), S('rolandtr909_zap'),
  S('tr909_bd', 3, { aliasOf: 'rolandtr909_bd' }), S('tr909_sd', 1, { aliasOf: 'rolandtr909_sd' }),
  S('balafon_hard', 6), S('balafon_soft', 6), S('ocarina_small_stacc', 13), S('piano', 29), S('bd', 8),
  S('sigmetal_bd'), S('sigmetal_sd'), S('metal', 10),
  S('voidstar'),
  S('lonely_bd'),
  { name: 'sawtooth', type: 'synth', count: 0 }, { name: 'gm_piano', type: 'soundfont', count: 0 },
  { name: 'mystery', type: 'other', count: 0 },
];
const custom = new Map([['sigmetal', { collection: 'signature', genre: 'metal', about: 'Tight metal' }], ['voidstar', { genre: 'voidstar' }]]);
const g = groupSounds(list, custom);
const bank = (n) => g.banks.find((b) => b.name === n);

check('drum machine is a bank', !!bank('rolandtr909'));
check('bank voices in kit order', bank('rolandtr909').voices.map((v) => v.voice).join(' ') === 'bd sd hh zap', bank('rolandtr909').voices.map((v) => v.voice).join(' '));
check('voice keeps full name + count', bank('rolandtr909').voices[0].name === 'rolandtr909_bd' && bank('rolandtr909').voices[0].count === 3);
check('alias bank folds into its target', !bank('tr909') && bank('rolandtr909').aka.join() === 'tr909');
check('underscored plain samples stay samples', ['balafon_hard', 'balafon_soft', 'ocarina_small_stacc'].every((n) => g.samples.some((s) => s.name === n)));
check('no underscore → sample', g.samples.some((s) => s.name === 'piano') && g.samples.some((s) => s.name === 'bd'));
check('custom bank carries info', bank('sigmetal')?.info?.genre === 'metal');
check('sample "metal" is not the metal bank', g.samples.some((s) => s.name === 'metal'));
check('one drum voice alone is not a bank', !bank('lonely') && g.samples.some((s) => s.name === 'lonely_bd'));
check('custom name with no voices is not a bank', !bank('voidstar') && g.samples.some((s) => s.name === 'voidstar'));
check('bank sounds leave the samples list', !g.samples.some((s) => s.name.startsWith('rolandtr909_') || s.name.startsWith('tr909_')));
check('synths / soundfonts / other', g.synths[0]?.name === 'sawtooth' && g.soundfonts[0]?.name === 'gm_piano' && g.other[0]?.name === 'mystery');
check('every view present', SOUND_VIEWS.every((k) => Array.isArray(g[k])));

check('search by bank name', filterGroups(g, '909').banks.length === 1);
check('search by alias', bankMatches(bank('rolandtr909'), 'tr909'));
check('search by voice', filterGroups(g, 'zap').banks.map((b) => b.name).join() === 'rolandtr909');
check('search by custom info', filterGroups(g, 'tight').banks.map((b) => b.name).join() === 'sigmetal');
check('search filters samples', filterGroups(g, 'bala').samples.length === 2);
check('empty query is a no-op', filterGroups(g, '') === g);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
