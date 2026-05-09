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
  { scale: 'cosmic',   style: 'concrete',   text: 'one' },
  { scale: 'flock',    style: 'fieldlines', text: 'system of individual elements' },
  { scale: 'galaxy',   style: 'fieldlines', text: 'complex phenomena' },
  { scale: 'earth',    style: 'concrete',   text: 'dynamical independence' },
  { scale: 'higgs',    style: 'fieldlines', text: 'emergent fields' },
  { scale: 'cell',     style: 'fieldlines', text: 'integrate over many degrees of freedom of underlying elements' },
  { scale: 'higgs',    style: 'shatter',    text: 'beyond the range of validity' },
  { scale: 'higgs',    style: 'concrete',   text: 'effective field theory' },
  { scale: 'atom',     style: 'fieldlines', text: 'black body spectrum' },
  { scale: 'planck',   style: 'shatter',    text: 'ultraviolet catastrophe' },
  { scale: 'atom',     style: 'concrete',   text: 'a more true description' },
  { scale: 'molecule', style: 'fieldlines', text: 'emergent from deeper theories' },
  { scale: 'atom',     style: 'concrete',   text: 'more fundamental to reality' },
  { scale: 'bird',     style: 'shatter',    text: 'methodological reductionism' },
  { scale: 'atom',     style: 'orbital',    text: 'elementary particles' },
  { scale: 'planck',   style: 'shatter',    text: 'course graining something even deeper' },
  { scale: 'beneath',  style: 'shatter',    text: 'hidden beneath the ir' },
  { scale: 'beneath',  style: 'concrete',   text: 'nature does not exist under this scale' },
  { scale: 'beneath',  style: 'shatter',    text: 'parameters that cannot be modelled' },
  { scale: 'beyond',   style: 'shatter',    text: 'not accessible in this universe' },
  { scale: 'planck',   style: 'shatter',    text: 'mysteries beyond the uv' },
  { scale: 'cosmic',   style: 'fieldlines', text: 'whole emergence' },
  { scale: 'cosmic',   style: 'concrete',   text: 'antireductionism' },
  { scale: 'beyond',   style: 'concrete',   text: 'voidstar' },
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
