// Builds the text content for a generated chart doc — either a real draft
// from web-scraped chord data (sync.js fetchWebChartData) or, when nothing
// usable was found online, a structured template to fill in by hand.
//
// Layout follows the working Nashville-number chart convention, modelled on
// the hand charts these replace: title and artist up top with the key and
// time signature in the corner ("Bb  4/4") and the tempo under it, section
// headers, one number per bar, "-" for minor, "b7"-style accidentals, NC for
// no-chord. The corner shorthand is one of the header shapes the chart-key
// parser reads (client and worker both — scripts/check-chart-key.mjs), so
// "read chart" still fills key/BPM from a doc this module generated.
//
// Three rules keep the page readable on a stand:
//   - NO CAPO. A chart is numbered from the song's real key; a capo position
//     is a guitarist's fingering choice, not chart data, and numbering capo
//     SHAPES against the real key is how a chart ends up a semitone flat.
//   - NUMBERS ONLY. No number→chord legend, no chord names echoed under the
//     numbers. A number chart that keeps translating itself back into chords
//     is the habit this format exists to break.
//   - EXCEPT WHERE A CHORD NEEDS THE EYE. Chord names appear under a section
//     only for the chords a number doesn't make obvious — a borrowed chord, a
//     secondary dominant, a modulated section — which is exactly where the
//     attention should go.

const NOTE_PC = {
  'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4,
  'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9,
  'A#': 10, 'Bb': 10, 'B': 11,
};
const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_MAJORS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb']);
// How a chart spells a key it wasn't handed by name — flats everywhere the
// flat is the working spelling, F# being the one key nobody writes as Gb.
const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Interval from the tonic → NNS degree, numbered off the major scale (the
// working convention even for minor-key charts: the minor tonic is 1-, and
// the borrowed chords come out as b3 / b6 / b7).
const DEGREE_BY_INTERVAL = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'];
const SEMITONE_BY_DEGREE = {
  '1': 0, 'b2': 1, '#1': 1, '2': 2, 'b3': 3, '#2': 3, '3': 4, 'b4': 4, '4': 5,
  '#4': 6, 'b5': 6, '5': 7, '#5': 8, 'b6': 8, '6': 9, '#6': 10, 'b7': 10, '7': 11,
};
// The six workhorse degrees of each tonality — the "obvious" set that stays
// pure numbers on the page. Everything else is what oddChordLine spells out.
const LEGEND_DEGREES = {
  major: [[0, '1', ''], [2, '2', '-'], [4, '3', '-'], [5, '4', ''], [7, '5', ''], [9, '6', '-']],
  minor: [[0, '1', '-'], [3, 'b3', ''], [5, '4', '-'], [7, '5', '-'], [8, 'b6', ''], [10, 'b7', '']],
};
const QUALITY_SUFFIX = { '-': 'm', '°': 'dim', '+': 'aug' };

function parseKeyName(key) {
  const m = (key || '').trim().match(/^([A-G][b#]?)\s*(m|min|minor)?\b/i);
  if (!m) return null;
  const root = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  if (NOTE_PC[root] == null) return null;
  return { root, tonicPc: NOTE_PC[root], minor: !!m[2] };
}

function keyNames(k) {
  return (k.root.includes('b') || FLAT_MAJORS.has(k.root)) ? NAMES_FLAT : NAMES_SHARP;
}

// The note a degree names, spelled the way a chart writes it: the degree's own
// accidental wins (the b7 of C is Bb, never A#; the #4 is F#, never Gb), and a
// natural degree follows the key's own spelling.
function degreeNote(k, label) {
  const table = label.startsWith('b') ? NAMES_FLAT : label.startsWith('#') ? NAMES_SHARP : keyNames(k);
  return table[(k.tonicPc + SEMITONE_BY_DEGREE[label]) % 12];
}

function keyDegrees(k) {
  return k.minor ? LEGEND_DEGREES.minor : LEGEND_DEGREES.major;
}

function transposeKeyName(key, semitones) {
  const k = parseKeyName(key);
  if (!k) return '';
  if (!semitones) return k.root + (k.minor ? 'm' : '');
  return KEY_NAMES[(k.tonicPc + semitones + 1200) % 12] + (k.minor ? 'm' : '');
}

// "1=A  2-=Bm  3-=C#m  4=D  5=E  6-=F#m" — the number→chord decoder ring for
// a key. Deliberately NOT printed on the chart (see the format rules up top);
// it's the definition of "the obvious six", which is what oddChordLine
// measures a section against, and it stays exported for anything that wants
// to show the mapping on screen rather than on the page.
export function chordLegend(key) {
  const k = parseKeyName(key);
  if (!k) return '';
  return keyDegrees(k)
    .map(([, label, qual]) => `${label}${qual}=${degreeNote(k, label)}${qual === '-' ? 'm' : ''}`)
    .join('  ');
}

// ── Nashville tokens ──
// A bar entry as it's written on a chart: a degree head ("1", "b7", "#4"), an
// optional quality ("-", "°", "(7)", "sus4", "maj7") and an optional slash
// bass ("1/3"). Everything here works on the NUMBERS — no chord-symbol
// parsing, because by this point the numbers are the chart.

const DEGREE_TOKEN_RE = /^([b#]?[1-7])([^/]*)(?:\/([b#]?[1-7]))?$/;

function parseDegreeToken(token) {
  const t = String(token ?? '').trim();
  if (!t || /^N\.?C\.?$/i.test(t)) return null;
  const m = t.match(DEGREE_TOKEN_RE);
  if (!m || SEMITONE_BY_DEGREE[m[1]] == null) return null;
  const quality = m[2] || '';
  const prefix = quality.startsWith('-') ? '-'
    : quality.startsWith('°') ? '°'
      : quality.startsWith('+') ? '+' : '';
  return { degree: m[1], quality, prefix, bass: m[3] || '' };
}

// Re-number a token by `semitones` — the de-capo fixup (see soundingNumbers).
// Quality and slash bass ride along untouched.
export function shiftDegreeToken(token, semitones) {
  const d = parseDegreeToken(token);
  if (!d || !semitones) return token;
  const shift = (deg) => DEGREE_BY_INTERVAL[(SEMITONE_BY_DEGREE[deg] + semitones + 1200) % 12];
  return shift(d.degree) + d.quality + (d.bass ? `/${shift(d.bass)}` : '');
}

// "Only spell what the legend can't." One line under a section naming the
// chords that fall outside the key's six workhorse degrees — a borrowed
// chord, a secondary dominant ("2" major where the legend has 2-), or a whole
// modulated section, where every bar lands here and the spelling is the point.
// Diatonic sections get nothing, which is how a number chart is supposed to
// read.
export function oddChordLine(tokens, key) {
  const k = parseKeyName(key);
  if (!k) return '';
  const legend = new Set(keyDegrees(k).map(([, label, qual]) => label + qual));
  const seen = new Set();
  const out = [];
  for (const raw of tokens) {
    const d = parseDegreeToken(raw);
    if (!d) continue;
    const sig = d.degree + d.prefix;
    if (legend.has(sig) || seen.has(sig)) continue;
    seen.add(sig);
    out.push(`${sig}=${degreeNote(k, d.degree)}${QUALITY_SUFFIX[d.prefix] || ''}`);
  }
  return out.length ? `  (${out.join('  ')})` : '';
}

// Title and artist lead — they're what you scan for when flipping between
// songs — then the key/time corner and the tempo, the way a hand chart writes
// them. A phone reads this in a narrow column, so the corner stacks under the
// title instead of sitting out to its left.
function headerLines(song, { key, bpm, time, feel } = {}) {
  const lines = [(song.title || 'UNTITLED').toUpperCase()];
  if (song.artist) lines.push(song.artist);
  lines.push('');
  const corner = [key, time || '4/4'].filter(Boolean).join('  ');
  lines.push(bpm ? `${corner}   \u2669= ${bpm}` : corner);
  if (feel) lines.push(`Feel: ${feel}`);
  lines.push('');
  return lines;
}

function sameKey(a, b) {
  const ka = parseKeyName(a);
  const kb = parseKeyName(b);
  if (!ka || !kb) return false;
  return ka.tonicPc === kb.tonicPc && ka.minor === kb.minor;
}

// The numbers, in the song's real key, out of a /web/chart-data payload.
//
// A chord sheet is written for the fingers, so a sheet with a CAPO is in capo
// SHAPES — C shapes at fret 1 for a song in Db. Numbering those shapes
// against the song's real key comes out a semitone flat (a plain 2- chart
// reads "b2-"), which is the one way a number chart can actively lie. The
// worker de-capoes at the source now and says so (`decapoed`); this is the
// fallback for a worker deploy that predates it, done on the numbers alone.
//
// Which frame the source's key is in is answerable without guessing:
// `keyInferred` false means the source STATED the recording's key (sounding,
// so the numbers are what's a capo low), true means it was read off the
// written shapes (so the numbers already agree and it's the key name that
// needs the capo added).
function soundingNumbers(data) {
  const sections = (data.sections || []).map(s => ({
    name: s.name,
    lines: (s.lines || []).map(line => line.map(c => c.nns)),
  }));
  const capo = Math.min(11, Math.max(0, Math.round(Number(data.capo) || 0)));
  let key = data.key || '';
  if (capo && !data.decapoed) {
    if (data.keyInferred) key = transposeKeyName(key, capo) || key;
    else for (const s of sections) s.lines = s.lines.map(l => l.map(t => shiftDegreeToken(t, capo)));
  }
  return { key, capo, sections };
}

// Chart draft from web chord data ({key, capo, keyInferred, decapoed,
// sections:[{name, lines:[[{chord,nns}]]}]}, see the worker's
// /web/chart-data). `extra` carries metadata derived from music APIs
// (sync.js fetchSongMeta): bpm/time fill gaps outright; a derived recording
// key never overrides the chord source's key (the numbers were computed
// against it) — a mismatch becomes a check-me note instead.
// Sections that repeat earlier changes are referenced by name instead of
// restated, the way hand charts do ("·Chorus").
export function buildChartText(song, data, extra = {}) {
  const chart = soundingNumbers(data);
  const key = chart.key || song.key || extra.key || '';
  const lines = headerLines(song, {
    key,
    bpm: song.bpm || extra.bpm,
    time: extra.time,
  });

  const seen = new Map(); // number signature → section name it first appeared under
  let unnamed = 0;
  for (const section of chart.sections) {
    unnamed += section.name ? 0 : 1;
    const name = (section.name || (unnamed === 1 ? 'SONG' : `PART ${unnamed}`)).toUpperCase();
    const nnsLines = section.lines.map(line => line.join('  '));
    const sig = nnsLines.join('|');
    if (seen.has(sig)) {
      const firstName = seen.get(sig);
      lines.push(name === firstName ? `${name}  (repeat)` : `${name}  (same as ${firstName})`);
      lines.push('');
      continue;
    }
    seen.set(sig, name);
    lines.push(name);
    lines.push(...nnsLines);
    const odd = oddChordLine(section.lines.flat(), key);
    if (odd) lines.push(odd);
    lines.push('');
  }

  lines.push(`— drafted from ${data.source} (${data.sourceUrl})`);
  if (chart.capo) {
    lines.push(`— source sheet is written with a capo at fret ${chart.capo}; numbers are the sounding key`);
  }
  if (data.keyInferred) lines.push(`— key of ${key} was inferred from the chords; double-check it`);
  if (extra.key && key && !sameKey(extra.key, key)) {
    lines.push(`— audio analysis hears the recording in ${extra.key}; chart is numbered from ${key} — check which is right`);
  }
  lines.push('— numbers are a starting point: check bars, splits, and pushes by ear.');
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
    // Split bars ("1 4") carry two chords in one entry, so flatten before
    // looking for the ones the legend can't decode.
    const odd = oddChordLine(section.bars.flatMap(b => String(b).split(/\s+/)), key);
    if (odd) lines.push(odd);
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
