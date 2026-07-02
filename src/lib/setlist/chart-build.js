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

function headerLines(song, { key, capo, bpm, time, feel } = {}) {
  const title = (song.title || 'UNTITLED').toUpperCase();
  const artist = song.artist || '';
  const meta = [];
  if (key) meta.push(`Key: ${key}`);
  meta.push(`Time: ${time || '4/4'}`);
  if (bpm) meta.push(`BPM: ${bpm}`);
  if (capo) meta.push(`Capo: ${capo}`);

  // Title and artist lead — they're what you scan for when flipping between
  // songs — then key/tempo/feel and the legend as one compact block. (The
  // worker's chart scraper reads Key:/BPM: from the first lines either way.)
  const lines = [title];
  if (artist) lines.push(artist);
  lines.push('', meta.join('   '));
  if (feel) lines.push(`Feel: ${feel}`);
  const legend = key ? chordLegend(key) : '';
  if (legend) lines.push(`(${legend})`);
  lines.push('');
  return lines;
}

function sameKey(a, b) {
  const ka = parseKeyName(a);
  const kb = parseKeyName(b);
  if (!ka || !kb) return false;
  return ka.tonicPc === kb.tonicPc && ka.minor === kb.minor;
}

// Chart draft from web chord data ({key, capo, sections:[{name, lines:[[{chord,nns}]]}]},
// see the worker's /web/chart-data). `extra` carries metadata derived from
// music APIs (sync.js fetchSongMeta): bpm/time fill gaps outright; a derived
// recording key never overrides the chord source's key (the numbers were
// computed against it) — a mismatch becomes a check-me note instead.
// Sections that repeat earlier changes are referenced by name instead of
// restated, the way hand charts do ("·Chorus").
export function buildChartText(song, data, extra = {}) {
  const key = data.key || song.key || extra.key || '';
  const lines = headerLines(song, {
    key,
    capo: data.capo || song.capo,
    bpm: song.bpm || extra.bpm,
    time: extra.time,
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
  if (extra.key && key && !sameKey(extra.key, key)) {
    lines.push(`— audio analysis hears the recording in ${extra.key}; chart is numbered from ${key} — check which is right`);
  }
  lines.push('— numbers are a starting point: check bars, splits, and pushes by ear,');
  lines.push('  then delete the chord-name lines once the numbers are confirmed.');
  return lines.join('\n');
}

// Chart drafted by an LLM with web grounding (sync.js fetchAiChart — worker
// /ai/chart). Unlike the chord-scrape data, this knows actual bar counts, so
// it renders like a hand chart: one number per bar, four bars per line,
// section comments in parens, chart-level notes at the bottom. Repeated
// sections with identical bars are referenced by name instead of restated.
export function buildAiChartText(song, data, extra = {}) {
  const key = data.key || song.key || extra.key || '';
  const lines = headerLines(song, {
    key,
    capo: data.capo || song.capo,
    bpm: data.bpm || song.bpm || extra.bpm,
    time: data.time || extra.time,
    feel: data.feel,
  });

  const seen = new Map(); // bars signature → section name it first appeared under
  for (const section of data.sections) {
    const name = section.name.toUpperCase();
    const comment = section.comment ? `  (${section.comment})` : '';
    const sig = `${section.bars.join('|')}#${section.comment}`;
    if (seen.has(sig)) {
      const firstName = seen.get(sig);
      lines.push(name === firstName ? `${name}  (repeat)` : `${name}  (same as ${firstName})`);
      lines.push('');
      continue;
    }
    seen.set(sig, name);
    lines.push(name + comment);
    for (let i = 0; i < section.bars.length; i += 4) {
      lines.push(section.bars.slice(i, i + 4).join('   '));
    }
    lines.push('');
  }

  if (data.notes?.length) {
    lines.push('NOTES');
    for (const note of data.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push(`— drafted by ${data.provider === 'claude' ? 'Claude' : 'Gemini'} (${data.model}) with web grounding; confidence ${Math.round((data.confidence || 0) * 100)}%`);
  if (extra.key && key && !sameKey(extra.key, key)) {
    lines.push(`— audio analysis hears the recording in ${extra.key}; chart says ${key} — check which is right`);
  }
  for (const src of data.sources || []) lines.push(`  ${src}`);
  lines.push('— verify numbers, bars, and pushes against the recording before the gig.');
  return lines.join('\n');
}

// Template chart when the web turned up nothing — same header + legend, with
// the standard section skeleton ready to fill in. `extra` (fetchSongMeta)
// still supplies key/BPM/time here, so even a template opens with the song's
// real numbers derived from audio analysis.
export function buildTemplateChartText(song, extra = {}) {
  const key = song.key || extra.key || '';
  const lines = headerLines(song, {
    key,
    capo: song.capo,
    bpm: song.bpm || extra.bpm,
    time: extra.time,
  });
  for (const name of ['INTRO', 'VERSE 1', 'CHORUS', 'VERSE 2', 'CHORUS', 'SOLO', 'BRIDGE', 'CHORUS', 'OUTRO']) {
    lines.push(name, '', '');
  }
  if (!song.key && extra.key) lines.push('— key/BPM from audio analysis of the recording; verify by ear.');
  lines.push('— no chord source found online; fill in the numbers.');
  return lines.join('\n');
}
