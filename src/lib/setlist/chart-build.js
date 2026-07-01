// Builds the text content for a generated chart doc — either a real draft
// from web-scraped chord data (sync.js fetchWebChartData) or, when nothing
// usable was found online, a structured template to fill in by hand.
//
// Layout follows the working Nashville-number chart convention (key and time
// signature up top, title + artist, underlined-style section headers, one
// number per bar, "-" for minor, "b7"-style accidentals, NC for no-chord).
// The header lines ("Key: A   Time: 4/4   BPM: 156") deliberately match what
// the worker's chart scraper (extractFromText) reads back out of a Google
// Doc, so "scrape" keeps working on docs this module generated.

const NOTE_PC = {
  'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4,
  'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9,
  'A#': 10, 'Bb': 10, 'B': 11,
};
const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_MAJORS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb']);

function parseKeyName(key) {
  const m = (key || '').trim().match(/^([A-G][b#]?)\s*(m|min|minor)?\b/i);
  if (!m) return null;
  const root = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  if (NOTE_PC[root] == null) return null;
  return { root, tonicPc: NOTE_PC[root], minor: !!m[2] };
}

// "1=A  2-=Bm  3-=C#m  4=D  5=E  6-=F#m" — the number→chord decoder ring for
// the chart's key, so a sub (or future you) can translate at a glance.
export function chordLegend(key) {
  const k = parseKeyName(key);
  if (!k) return '';
  const names = (k.root.includes('b') || FLAT_MAJORS.has(k.root)) ? NAMES_FLAT : NAMES_SHARP;
  // [interval, degree label, quality suffix] — major keys get the six workhorse
  // degrees; minor keys are numbered off the minor tonic (1- b3 4- 5- b6 b7).
  const degrees = k.minor
    ? [[0, '1', '-'], [3, 'b3', ''], [5, '4', '-'], [7, '5', '-'], [8, 'b6', ''], [10, 'b7', '']]
    : [[0, '1', ''], [2, '2', '-'], [4, '3', '-'], [5, '4', ''], [7, '5', ''], [9, '6', '-']];
  return degrees
    .map(([interval, label, qual]) => {
      const note = names[(k.tonicPc + interval) % 12];
      return `${label}${qual}=${note}${qual === '-' ? 'm' : ''}`;
    })
    .join('  ');
}

function headerLines(song, { key, capo, bpm, time } = {}) {
  const title = (song.title || 'UNTITLED').toUpperCase();
  const artist = song.artist || '';
  const meta = [];
  if (key) meta.push(`Key: ${key}`);
  meta.push(`Time: ${time || '4/4'}`);
  if (bpm) meta.push(`BPM: ${bpm}`);
  if (capo) meta.push(`Capo: ${capo}`);

  const lines = [meta.join('   '), '', title];
  if (artist) lines.push(artist);
  const legend = key ? chordLegend(key) : '';
  if (legend) lines.push('', `(${legend})`);
  lines.push('');
  return lines;
}

// Chart draft from web chord data ({key, capo, sections:[{name, lines:[[{chord,nns}]]}]},
// see the worker's /web/chart-data). Sections that repeat earlier changes are
// referenced by name instead of restated, the way hand charts do ("·Chorus").
export function buildChartText(song, data) {
  const key = data.key || song.key || '';
  const lines = headerLines(song, {
    key,
    capo: data.capo || song.capo,
    bpm: song.bpm,
  });

  const seen = new Map(); // chord signature → section name it first appeared under
  let unnamed = 0;
  for (const section of data.sections) {
    unnamed += section.name ? 0 : 1;
    const name = (section.name || (unnamed === 1 ? 'SONG' : `PART ${unnamed}`)).toUpperCase();
    const nnsLines = section.lines.map(line => line.map(c => c.nns).join('  '));
    const sig = nnsLines.join('|');
    if (seen.has(sig)) {
      const firstName = seen.get(sig);
      lines.push(name === firstName ? `${name}  (repeat)` : `${name}  (same as ${firstName})`);
      lines.push('');
      continue;
    }
    seen.set(sig, name);
    lines.push(name);
    section.lines.forEach((line, i) => {
      lines.push(nnsLines[i]);
      lines.push(`  (${line.map(c => c.chord).join('  ')})`);
    });
    lines.push('');
  }

  lines.push(`— drafted from ${data.source} (${data.sourceUrl})`);
  if (data.keyInferred) lines.push(`— key of ${key} was inferred from the chords; double-check it`);
  lines.push('— numbers are a starting point: check bars, splits, and pushes by ear,');
  lines.push('  then delete the chord-name lines once the numbers are confirmed.');
  return lines.join('\n');
}

// Template chart when the web turned up nothing — same header + legend, with
// the standard section skeleton ready to fill in.
export function buildTemplateChartText(song) {
  const lines = headerLines(song, { key: song.key, capo: song.capo, bpm: song.bpm });
  for (const name of ['INTRO', 'VERSE 1', 'CHORUS', 'VERSE 2', 'CHORUS', 'SOLO', 'BRIDGE', 'CHORUS', 'OUTRO']) {
    lines.push(name, '', '');
  }
  lines.push('— no chart or chord source found online; fill in the numbers.');
  return lines.join('\n');
}
