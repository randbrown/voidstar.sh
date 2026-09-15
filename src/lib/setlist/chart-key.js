// Parse a song's key (and tempo) out of chart text. Nashville charts carry
// both in the header — "Key: A", "Key of G", a bare "Bb" in the top corner, or
// the working-musician shorthand that pairs the key with the time signature
// ("D | 4/4", "Bb 3/4") — and the app already holds that text whenever it
// renders or offline-caches a Google-Doc chart, so an empty song.key can be
// filled for free, no extra worker round-trip. The same parsing also cleans up
// what the vision model reports for a scanned chart, where the answer often
// comes back as the raw corner marking ("D|4/4") rather than a bare key.
//
// The worker's extractFromText / normalizeChartRead (drive/file/:id/meta,
// /ai/chart-read) keep their own copy of these patterns — the two are checked
// against one shared table by scripts/check-chart-key.mjs; keep them in step.

// "Key: A" / "Key = Bb" / "Key - F#m" / "Key of G" / "KEY G". The lookahead
// rejects a letter that's just the start of a word ("Key of Grace").
const KEY_LABELED_RE = /\bkey\s*(?:of\b)?\s*[:=\-–—]?\s*([A-G][b♭#♯]?)\s*(m\b|min\b|minor\b|maj\b|major\b)?(?![a-z])/i;
// The top-corner shorthand: the key, then the time signature — "D|4/4",
// "D 4/4", "Bb - 3/4", "Gm | 6/8". This is how a hand-written chart states the
// key most of the time, and it matches neither of the other two patterns. The
// denominator is restricted to real note values so a date or a bar count
// ("9/5", "5/7") can't mint a key out of a nearby letter.
const KEY_WITH_TIME_RE = /(?:^|[\s([|])([A-G][b♭#♯]?)\s*(m|min|minor|maj|major)?\s*[|/\\\-–—:,]?\s*(?:1[0-6]|[1-9])\s*\/\s*(?:1|2|4|8|16)(?![\d/])/m;
// A header line that IS the key and nothing else: "Bb", "C#m", "A major".
const KEY_BARE_LINE_RE = /^\s*([A-G][b♭#♯]?)\s*(m|min|minor|maj|major)?\s*$/im;
// A key on its own, possibly carrying a label or trailing junk — for a single
// value someone (or a vision model) hands us, not for scanning a page.
// "D|4/4" → D, "Dm7" → Dm, "F# minor" → F#m, "Dixieland" → nothing.
const KEY_VALUE_RE = /\b([A-G][b♭#♯]?)\s*(m(?:in(?:or)?)?|maj(?:or)?)?(?![a-z])/i;
// The ways a model says "there wasn't one" — none of which is a key.
const NO_VALUE_RE = /^(?:n\/?a|none|no key|not written|not specified|unknown|unclear|[-–—?])$/i;

// Tempo, in the shapes a chart actually writes it: the quarter-note glyph
// ("♩ = 126", the hand-written default), its typed stand-in ("q=126"), or a
// spelled-out label.
const TEMPO_NOTE_RE = /[♩♪\u{1D15F}\u{1D160}]\s*[=≈]\s*(\d{2,3})(?!\d)/u;
const TEMPO_Q_RE = /\bq\s*[=≈]\s*(\d{2,3})(?!\d)/i;
const TEMPO_LABELED_RE = /\b(?:tempo|bpm)\s*[:=]?\s*(\d{2,3})(?!\d)/i;
const TEMPO_SUFFIX_RE = /\b(\d{2,3})\s*bpm\b/i;

// Only the top of the chart counts as "the header" — a lyric line further
// down that happens to start with "key of C" shouldn't win.
const HEADER_LINES = 30;

function keyFromMatch(m) {
  if (!m) return '';
  const root = m[1][0].toUpperCase() + (m[1][1] ? (/[#♯]/.test(m[1][1]) ? '#' : 'b') : '');
  const minor = /^m(?:in(?:or)?)?$/i.test((m[2] || '').trim());
  return root + (minor ? 'm' : '');
}

function chartHeader(text) {
  return (text || '').split('\n').slice(0, HEADER_LINES).join('\n');
}

export function extractKeyFromChartText(text) {
  if (!text) return '';
  const header = chartHeader(text);
  // Most explicit first: a labeled key beats the corner shorthand, which beats
  // a letter sitting alone on a line.
  for (const re of [KEY_LABELED_RE, KEY_WITH_TIME_RE, KEY_BARE_LINE_RE]) {
    const key = keyFromMatch(header.match(re));
    if (key) return key;
  }
  return '';
}

/**
 * Normalize a single value that is supposed to BE a key — a vision model's
 * answer, a pasted field — into "D" / "Bbm" / "" form. Forgiving on purpose:
 * models hand back what the page literally says ("D|4/4", "Key of D",
 * "D major"), and dropping all of that on the floor is how a chart with the
 * key written right on it ends up at "no key".
 * @param {string} value
 * @returns {string} normalized key, or '' when there isn't one in there
 */
export function normalizeKeyName(value) {
  const s = String(value ?? '').trim();
  // "N/A" would otherwise hand back its own A as the key.
  if (!s || NO_VALUE_RE.test(s)) return '';
  return keyFromMatch(s.match(KEY_LABELED_RE)) || keyFromMatch(s.match(KEY_VALUE_RE));
}

/**
 * Tempo from a chart header, as a plain bpm number (0 = not written).
 * Bounded to something a band could actually count.
 */
export function extractTempoFromChartText(text) {
  if (!text) return 0;
  const header = chartHeader(text);
  for (const re of [TEMPO_NOTE_RE, TEMPO_Q_RE, TEMPO_LABELED_RE, TEMPO_SUFFIX_RE]) {
    const m = header.match(re);
    if (!m) continue;
    const bpm = parseInt(m[1], 10);
    if (bpm >= 30 && bpm <= 300) return bpm;
  }
  return 0;
}
