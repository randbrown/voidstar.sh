// Colour parsing / theme arc for `palette`, bank naming for `kit`:
//   node scripts/check-qualia-palette-kit.mjs

import { parseCssColor, rgbToHex, hslToRgb, makePalette, PALETTE_TOKENS } from '../src/lib/qualia/code-palette.js';
import { makeKit, KIT_VOICES } from '../src/lib/qualia/code-kit.js';
import { COLLECTIONS, GENRES, GENRE_DESCS } from '../src/lib/qualia/samples-manifest.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nparseCssColor');
check('#rrggbb', eq(parseCssColor('#38D8FF'), [56, 216, 255, 1]));
check('#rgb', eq(parseCssColor('#f0a'), [255, 0, 170, 1]));
check('#rrggbbaa', eq(parseCssColor('#ff000080'), [255, 0, 0, 128 / 255]));
check('rgb(a, b, c)', eq(parseCssColor('rgb(1, 2, 3)'), [1, 2, 3, 1]));
check('rgba(a, b, c, .5)', eq(parseCssColor('rgba(1, 2, 3, 0.5)'), [1, 2, 3, 0.5]));
check('rgb(a b c / 50%)', eq(parseCssColor('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5]));
check('color(srgb …) (color-mix result)', eq(parseCssColor('color(srgb 1 0.5 0)'), [255, 128, 0, 1]));
check('garbage → null', parseCssColor('chartreuse-ish') === null && parseCssColor('') === null);

console.log('\nhex / hsl');
check('rgbToHex opaque', rgbToHex([56, 216, 255, 1]) === '#38d8ff');
check('rgbToHex translucent keeps alpha', rgbToHex([255, 0, 0, 0.5]) === '#ff000080');
check('hsl red', eq(hslToRgb(0, 100, 50), [255, 0, 0]));
check('hsl wraps hue', eq(hslToRgb(360 + 120, 100, 50), [0, 255, 0]));

console.log('\npalette');
const vars = { '--accent': '#38d8ff', '--cyan': 'rgb(108, 140, 255)', '--pink': 'color(srgb 0.83 0.36 1)',
  '--green': '#5cffb0', '--amber': '#ffb347', '--text': '#e8f1f6' };
let hueBase = 185;
const p = makePalette({
  color: (t) => vars[t] || '',
  knobs: () => ({ hue: (t) => hueBase + t * 155, sat: 78, light: 58 }),
});
check('named getter → hex', p.accent === '#38d8ff');
check('rgb() token normalised', p.cyan === '#6c8cff', p.cyan);
check('color-mix token normalised', /^#[0-9a-f]{6}$/.test(p.pink), p.pink);
check('missing token → white', p.dim === '#ffffff');
check('reads live (theme change)', (() => { const a = p.accent; vars['--accent'] = '#ff0000'; const b = p.accent; vars['--accent'] = '#38d8ff'; return a !== b && b === '#ff0000'; })());
check('every token is a getter', Object.keys(PALETTE_TOKENS).every((k) => typeof p[k] === 'string'));
check('cycle() = 5 accents', p.cycle() === '<#38d8ff #6c8cff ' + p.pink + ' #5cffb0 #ffb347>', p.cycle());
check('cycle(n) = n arc stops', p.cycle(4).slice(1, -1).split(' ').length === 4);
check('cycle([names])', p.cycle(['accent', '#00ff00']) === '<#38d8ff #00ff00>');
check('arc ends', p.arc(0) === rgbToHex(hslToRgb(185, 78, 58)) && p.arc(1) === rgbToHex(hslToRgb(340, 78, 58)));
check('arc clamps', p.arc(5) === p.arc(1) && p.arc('x') === p.arc(0));
check('arcs(1)', p.arcs(1).length === 1);
check('rgb() 0..1', eq(p.rgb('accent'), [+(56 / 255).toFixed(4), +(216 / 255).toFixed(4), 1]));
check('get(--token) / get(css)', p.get('--amber') === '#ffb347' && p.get('rgb(0,0,255)') === '#0000ff');
check('cycle tokens are single mini words', !/[(),]/.test(p.cycle()));

console.log('\nkit');
const kit = makeKit({ collections: COLLECTIONS, genres: GENRES, active: () => 'signature' });
check('kit.sig.metal', kit.sig.metal === 'sigmetal');
check('kit.v0 / kit.r0', kit.v0.lofi === 'v0lofi' && kit.r0.jazz === 'r0jazz');
check('every collection × genre', COLLECTIONS.every((c) => GENRES.every((g) => kit[c.bank][g] === c.bank + g)));
check('ab()', kit.ab('metal') === '<' + COLLECTIONS.map((c) => c.bank + 'metal').join(' ') + '>', kit.ab('metal'));
check('ab(genre, false) drops remote', !kit.ab('metal', false).includes('r0'));
check('tour()', kit.tour() === `<${GENRES.join(' ')}>`);
check('tour(bank)', kit.tour('sig') === `<${GENRES.map((g) => 'sig' + g).join(' ')}>`);
check('bank(genre, id)', kit.bank('dub', 'voidstar_0') === 'v0dub');
const warn = console.warn; console.warn = () => {};
check('bank(unknown) → ""', kit.bank('polka') === '');
console.warn = warn;
check('voices', eq(kit.voices, KIT_VOICES) && kit.voices.length === 10);
check('active()', kit.active() === 'signature');
const tbl = console.table; console.table = () => {};
const kd = makeKit({ collections: COLLECTIONS, genres: GENRES, active: () => 'signature', genreDescs: GENRE_DESCS });
check('every genre has a description', GENRES.every((g) => GENRE_DESCS[g]));
check('ls() = plain + every collection × genre', kd.ls().length === GENRES.length * (COLLECTIONS.length + 1));
check('ls() rows name real banks', kd.ls().every((r) => r.bank === r.genre || COLLECTIONS.some((c) => r.bank === c.bank + r.genre)));
check('ls(genre)', kd.ls('metal').length === COLLECTIONS.length + 1 && kd.ls('metal').every((r) => r.genre === 'metal'));
check('ls(bank token) = ls(collection id)', kd.ls('r0').length === GENRES.length && kd.ls('real_0').length === GENRES.length);
check('ls(active)', kd.ls('active').every((r) => r.bank === r.genre) && kd.ls('active').length === GENRES.length);
check('ls() flags the network collection', kd.ls('r0').every((r) => r.about.includes('needs network')));
console.warn = () => {};
check('ls(unknown) → []', kd.ls('polka').length === 0);
console.warn = warn; console.table = tbl;

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
