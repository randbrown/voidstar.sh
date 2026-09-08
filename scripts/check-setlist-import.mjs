// Node smoke test for the setlist text-import parser and the forgiving
// library-song matcher — pure functions only (no IndexedDB), so they run
// under plain node:  node scripts/check-setlist-import.mjs
//
// Covers the real-world "Catoosa Fest" paste shape: dashed header line with
// name + date, "Title - CODE" vocalist codes, two-singer codes (SM, S&SM),
// trailing keys ("- M - G", "- M - C#"), and ">" segue transition markers —
// plus the older numbered/bare-code formats staying intact, and the
// partial/punctuation-forgiving matching of pasted titles to library songs.

import { parseTextList } from '../src/lib/setlist/import.js';
import { findLibrarySongMatch } from '../src/lib/setlist/match.js';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); failures++; }
}

// ── The motivating paste (abridged from the real text message) ──

const CATOOSA = `Catoosa Fest - 9/5/2026 - Boot Scootin Boogie Nights

Chattahoochee - M
Whose bed have your boots been under - S
Sold - SM>
>Queen of my double wide trailer - M
Dust on the Bottle - SM
Two dozen roses - M - G
Heads carolina - S
Pickup man - M>
>Should've been a cowboy - M
From this moment on - S&SM
Fishin in the Dark - M - C#
Friends in Low places - SM`;

const cat = parseTextList(CATOOSA);
const catSongs = cat.sets[0]?.songs || [];
const byTitle = (t) => catSongs.find((s) => s.title.toLowerCase() === t.toLowerCase());

check('header: date parsed from dashed header', cat.meta.gigDate === '2026-09-05');
check('header: venue-ish segment becomes the venue', cat.meta.venue === 'Catoosa Fest');
check('header: full line (minus date) is the name',
  cat.meta.name === 'Catoosa Fest - Boot Scootin Boogie Nights');
check('header line not swallowed as a song', !byTitle('Catoosa Fest - Boot Scootin Boogie Nights'));
check('all 12 songs parsed', catSongs.length === 12);

check('dash vocalist code: single letter', byTitle('Chattahoochee')?.vocalist === 'M');
check('dash vocalist code leaves no dash debris in the title',
  !!byTitle('Whose Bed Have Your Boots Been Under') && byTitle('Whose Bed Have Your Boots Been Under').vocalist === 'S');
check('two-singer code SM parsed whole', byTitle('Sold')?.vocalist === 'SM');
check('compound code S&SM parsed whole', byTitle('From This Moment On')?.vocalist === 'S&SM');
check('vocalist code + key: "M - G" → vocalist M', byTitle('Two Dozen Roses')?.vocalist === 'M');
check('vocalist code + key: "M - G" → key G', byTitle('Two Dozen Roses')?.key === 'G');
check('vocalist code + accidental key: "M - C#"',
  byTitle('Fishin In The Dark')?.vocalist === 'M' && byTitle('Fishin In The Dark')?.key === 'C#');
check('a code is never mistaken for a dash artist', byTitle('Two Dozen Roses')?.artist === '');

check('trailing ">" marks the segue on the outgoing song', byTitle('Sold')?.segueNext === true);
check('leading ">" on the next line also lands on the outgoing song',
  byTitle('Pickup Man')?.segueNext === true);
check('the incoming song itself is not marked', byTitle("Should've Been A Cowboy")?.segueNext === false);
check('unmarked songs carry no segue', byTitle('Dust On The Bottle')?.segueNext === false);
check('">" stripped from titles', !catSongs.some((s) => s.title.includes('>')));
check('no _segueFromPrev leaks into the result', !catSongs.some((s) => '_segueFromPrev' in s));

// ── Headerless paste loses nothing ──

const bare = parseTextList('Chattahoochee - M\nWhose bed have your boots been under - S');
check('headerless: first line stays a song', bare.sets[0].songs.length === 2);
check('headerless: no meta invented', bare.meta.name === '' && bare.meta.gigDate === '');

// ── The older formats still parse ──

const OLD = `The Grey Eagle 6/14
Set 1:
1  should've been a cowboy  C
2  crazy (Patsy Cline cover)
3  don't rock the jukebox   S`;
const old = parseTextList(OLD);
// No venue-ish word on the line, so it parses as the name — the import's
// apply step falls back to the name when no separate venue was found.
check('classic header: name (venue falls back to it on apply)',
  old.meta.name === 'The Grey Eagle' && old.meta.venue === '');
check('classic header: date (year assumed current)', /-06-14$/.test(old.meta.gigDate));
check('numbered lines stripped', old.sets[0].songs[0].title === "Should've Been A Cowboy");
check('bare trailing vocalist code', old.sets[0].songs[2].vocalist === 'S');
check('cover parenthetical still parsed',
  old.sets[0].songs[1].artist === 'Patsy Cline' && old.sets[0].songs[1].cover === true);

const usa = parseTextList('Party In The USA\nNine To Five');
check('a title ending in a 3+ letter all-caps word keeps it',
  usa.sets[0].songs[0].title === 'Party In The Usa');

const dashArtist = parseTextList('Crazy - Patsy Cline');
check('spaced-dash artist still parses',
  dashArtist.sets[0].songs[0].title === 'Crazy' && dashArtist.sets[0].songs[0].artist === 'Patsy Cline');

// ── findLibrarySongMatch — forgiving library reuse on import ──

const LIB = [
  { title: 'Heads Carolina, Tails California', artist: 'Jo Dee Messina' },
  { title: "Why'd You Come In Here Lookin' Like That?", artist: 'Dolly Parton' },
  { title: 'Neon Moon', artist: 'Brooks & Dunn' },
  { title: 'Breathe In Breathe Out', artist: 'Life Is Good' },
  { title: 'Chattahoochee', artist: 'Alan Jackson' },
  { title: 'Sweet Home Alabama', artist: 'Lynyrd Skynyrd' },
];

check('exact title matches', findLibrarySongMatch('Neon Moon', '', LIB)?.how === 'exact');
check('punctuation-insensitive match',
  findLibrarySongMatch('Whyd you come in here lookin like that', '', LIB)?.song.title === "Why'd You Come In Here Lookin' Like That?");
check('partial title reuses the full-titled library song',
  findLibrarySongMatch('Heads carolina', '', LIB)?.song.title === 'Heads Carolina, Tails California');
check('partial match is reported as such',
  findLibrarySongMatch('Heads carolina', '', LIB)?.how === 'partial');
check('a clear artist disagreement blocks partial reuse',
  findLibrarySongMatch('Heads carolina', 'Metallica', LIB) === null);
check('a one-word prefix is a different song, not a shorthand',
  findLibrarySongMatch('Breathe', '', LIB) === null);
check('small typos still match',
  findLibrarySongMatch('Chatahoochee', '', LIB)?.song.title === 'Chattahoochee');
check('an unrelated title matches nothing',
  findLibrarySongMatch('Copperhead Road', '', LIB) === null);
check('two-word prefix works ("Sweet Home" → Alabama)',
  findLibrarySongMatch('Sweet Home', '', LIB)?.song.title === 'Sweet Home Alabama');
check('an ambiguous partial refuses to guess',
  findLibrarySongMatch('Sweet Home', '',
    [...LIB, { title: 'Sweet Home Chicago', artist: 'Robert Johnson' }]) === null);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nsetlist import checks passed');
