// Antireductionism — built-in lyric stream.
//
// Each entry is { scale, style, text }. The FX module advances through this
// list at the configured tempo / beat rate. The `scale` field is the
// stratum id the line belongs to (camera focuses there in 'auto-focus'
// mode); `style` is the visual treatment ('concrete' | 'shatter' |
// 'fieldlines' | 'orbital'). 'auto' is reserved for the user-facing
// param value — the FX maps 'auto' onto each line's tagged style.
//
// The lyric set deliberately walks the scale axis from cosmic web down to
// the Planck cutoff and out the far side ("beyond"), threading the song's
// thesis: reality is stratified into dynamically independent regimes; you
// can't flatten one onto another.

/** @typedef {{ scale: string, style: string, text: string }} LyricLine */

/** @type {LyricLine[]} */
export const BUILTIN_LYRICS = [
  { scale: 'cosmic',   style: 'concrete',   text: 'reality stratifies' },
  { scale: 'cosmic',   style: 'shatter',    text: 'no single law' },
  { scale: 'cosmic',   style: 'fieldlines', text: 'from web to dust to nothing' },
  { scale: 'galaxy',   style: 'concrete',   text: 'arms wind in flat curves' },
  { scale: 'galaxy',   style: 'fieldlines', text: 'omega goes as one over r' },
  { scale: 'solar',    style: 'orbital',    text: 'a star and her rings' },
  { scale: 'solar',    style: 'concrete',   text: 'each keeping its distance' },
  { scale: 'earth',    style: 'concrete',   text: 'continents, clouds, weather' },
  { scale: 'earth',    style: 'shatter',    text: 'separate dynamics' },
  { scale: 'flock',    style: 'fieldlines', text: 'starlings carve the sky' },
  { scale: 'flock',    style: 'orbital',    text: 'cohesion, separation, alignment' },
  { scale: 'bird',     style: 'concrete',   text: 'one body, turning' },
  { scale: 'bird',     style: 'shatter',    text: 'feathers, hollow bone' },
  { scale: 'cell',     style: 'orbital',    text: 'organelles in solution' },
  { scale: 'cell',     style: 'shatter',    text: 'life is not a pile of atoms' },
  { scale: 'molecule', style: 'concrete',   text: 'bonds, jewel-bright' },
  { scale: 'molecule', style: 'orbital',    text: 'valence and geometry' },
  { scale: 'atom',     style: 'orbital',    text: 'probability cloud' },
  { scale: 'atom',     style: 'shatter',    text: 'uncertainty' },
  { scale: 'higgs',    style: 'fieldlines', text: 'fields, not particles' },
  { scale: 'higgs',    style: 'concrete',   text: 'excitations of nothing' },
  { scale: 'planck',   style: 'shatter',    text: 'ultraviolet catastrophe' },
  { scale: 'planck',   style: 'concrete',   text: 'foam beneath the cutoff' },
  { scale: 'beyond',   style: 'concrete',   text: 'nature does not exist under this scale' },
  { scale: 'beyond',   style: 'shatter',    text: 'silence' },
];

/** Parse a custom lyric block. One line per entry; optional `[scale]`
 *  or `[scale style]` prefix tag. Lines with no recognisable tag fall back
 *  to scale='cosmic', style='concrete'. Empty lines are skipped. */
export function parseCustomLyrics(blob, validScales, validStyles) {
  if (!blob || typeof blob !== 'string') return [];
  const out = [];
  const scales = new Set(validScales);
  const styles = new Set(validStyles);
  for (const raw of blob.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let scale = 'cosmic';
    let style = 'concrete';
    let text = line;
    const m = line.match(/^\[\s*([\w-]+)(?:\s+([\w-]+))?\s*\]\s*(.*)$/);
    if (m) {
      const a = m[1]?.toLowerCase();
      const b = m[2]?.toLowerCase();
      if (a && scales.has(a)) scale = a;
      else if (a && styles.has(a)) style = a;
      if (b && scales.has(b)) scale = b;
      else if (b && styles.has(b)) style = b;
      text = m[3] || '';
    }
    if (!text) continue;
    out.push({ scale, style, text });
  }
  return out;
}
