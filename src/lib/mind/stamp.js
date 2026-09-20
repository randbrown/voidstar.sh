// Datetime stamps — pure core (no DOM, no IndexedDB), tested by
// scripts/check-mind-stamp.mjs.
//
// One button in the editor toolbar drops "now" into the body as plain text.
// The formats are hand-rolled rather than `toLocaleString`-derived on purpose:
// a note written on the phone and read on the laptop must show the SAME
// string, and a sortable `2026-09-20 14:32` stays sortable wherever it lands.
// (The `long` format spells out English month/day names for the same reason —
// locale-dependent output would drift between devices sharing one note.)

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const p2 = (n) => String(n).padStart(2, '0');

// 12-hour clock with an am/pm suffix — "2:32 pm", "12:05 am".
function clock12(d) {
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${p2(d.getMinutes())} ${h < 12 ? 'am' : 'pm'}`;
}

// key → { label, hint (shown in the picker), fmt }. `key` is what's persisted,
// so renaming one silently resets a device's preference — add, don't rename.
export const STAMP_FORMATS = [
  {
    key: 'datetime',
    label: 'date + time',
    fmt: (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
  },
  {
    key: 'date',
    label: 'date only',
    fmt: (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
  },
  {
    key: 'time',
    label: 'time only',
    fmt: (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`,
  },
  {
    key: 'long',
    label: 'long form',
    fmt: (d) => `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${clock12(d)}`,
  },
];

export const DEFAULT_STAMP_FORMAT = 'datetime';

export function stampFormat(key) {
  return STAMP_FORMATS.find(f => f.key === key)
    || STAMP_FORMATS.find(f => f.key === DEFAULT_STAMP_FORMAT);
}

// The stamp string itself. `ts` is injectable so tests stay deterministic.
export function formatStamp(ts = Date.now(), key = DEFAULT_STAMP_FORMAT) {
  return stampFormat(key).fmt(new Date(ts));
}

// What actually gets inserted at the cursor, as { lead, text, bold, trail }:
// plain `lead`, then `text` (bold when `bold`), then plain `trail`.
//
// Shape follows the caret. Mid-sentence the stamp is just a timestamp, so it
// only earns a separating space. On a line of its own it's a heading for what
// comes next, so it's bold (matching the #ongoing entry stamp) and gets an
// em-dash lead-in when there's already text after the caret.
//
// The bold is reported as a flag rather than baked in as `**…**` on purpose:
// literal asterisks typed into the document serialize back out escaped
// (`\*\*2026-09-20\*\*`), so the caller applies a real `strong` mark instead.
// `before`/`after` are the text either side of the caret in the same block.
export function stampInsertion(ts, key, { before = '', after = '' } = {}) {
  const text = formatStamp(ts, key);
  if (before.trim()) return { lead: before.endsWith(' ') ? '' : ' ', text, bold: false, trail: '' };
  return { lead: '', text, bold: true, trail: after.trim() ? ' \u2014 ' : ' ' };
}
