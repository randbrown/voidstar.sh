// Parse a song's key out of chart text. Nashville charts carry the key in
// the header ("Key: A", "Key of G", or just "Bb" alone in the top corner),
// and the app already holds that text whenever it renders or offline-caches a
// Google-Doc chart — so an empty song.key can be filled for free, no extra
// worker round-trip. The worker's extractFromText (drive/file/:id/meta) keeps
// its own copy of these patterns; keep the two in step.

// "Key: A" / "Key = Bb" / "Key - F#m" / "Key of G" / "KEY G". The lookahead
// rejects a letter that's just the start of a word ("Key of Grace").
const KEY_LABELED_RE = /\bkey\s*(?:of\b)?\s*[:=\-–—]?\s*([A-G][b♭#♯]?)\s*(m\b|min\b|minor\b|maj\b|major\b)?(?![a-z])/i;
// A header line that IS the key and nothing else: "Bb", "C#m", "A major".
const KEY_BARE_LINE_RE = /^\s*([A-G][b♭#♯]?)\s*(m|min|minor|maj|major)?\s*$/im;

// Only the top of the chart counts as "the header" — a lyric line further
// down that happens to start with "key of C" shouldn't win.
const HEADER_LINES = 30;

export function extractKeyFromChartText(text) {
  if (!text) return '';
  const header = text.split('\n').slice(0, HEADER_LINES).join('\n');
  for (const re of [KEY_LABELED_RE, KEY_BARE_LINE_RE]) {
    const m = header.match(re);
    if (!m) continue;
    const root = m[1][0].toUpperCase() + (m[1][1] ? (/[#♯]/.test(m[1][1]) ? '#' : 'b') : '');
    const minor = /^m(?:in(?:or)?)?$/i.test((m[2] || '').trim());
    return root + (minor ? 'm' : '');
  }
  return '';
}
