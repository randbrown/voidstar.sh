// Horizon — the long-arc page, plus the setter sheet and the editor banner.
// All the DOM for the feature lives here; the rules live in ../horizon.js
// (pure, tested by scripts/check-mind-horizon.mjs).
//
// The page reads as one arc: what's RIPE (hand these back now), what's still
// GROWING (by year), what's on SOMEDAY, and the SETTLED record of what you
// thought and when.

import * as store from '../store.js';
import { markdownToText } from '../editor/markdown.js';
import {
  HORIZON_KINDS, HORIZON_SPANS, DEFAULT_KIND, kindOf, addMonths,
  horizonOf, isRipe, isSomeday, plantMeta, settleMeta, pushOutMeta, clearHorizonMeta,
  groupHorizon, byYear, horizonCounts, horizonDate, horizonLabel,
} from '../horizon.js';
import { navigate, refresh } from '../app.js';
import { el, esc, btn, topBar, emptyState, confirmBox } from '../ui.js';

const SETTLED_OPEN_KEY = 'voidstar.mind.horizonSettledOpen';

// ── shared bits ──────────────────────────────────────────────────────────

// Save a new `meta` onto a note. Re-reads the record first so a horizon set
// from the editor patches ONLY meta onto the live note — the caller's snapshot
// may be a keystroke behind the body being typed, and writing it back whole
// would undo that keystroke.
//
// `empty` means the horizon was the last thing in meta. An empty object is a
// blank NOTE_FILL_FIELDS value, so without the tombstone the sync merge refills
// it from an older copy and the note un-clears itself on the next cycle (the
// same trap as folderId and tags).
async function writeMeta(note, meta, { empty = false } = {}) {
  const current = (await store.getNote(note.id)) || note;
  const next = { ...current, meta };
  if (empty) store.markCleared(next, 'meta');
  await store.putNote(next);
}

// ── the setter sheet ─────────────────────────────────────────────────────

// Plant / re-date / clear a note's horizon. `onDone` re-renders the caller.
export function horizonSheet(note, onDone = () => {}) {
  const existing = horizonOf(note);
  let kind = existing?.kind || DEFAULT_KIND;
  let at = existing?.at || 0;
  let span = existing ? '' : '1y';
  if (!existing) at = addMonths(Date.now(), 12);

  const overlay = el('div', 'mn-modal-overlay');
  const box = el('div', 'mn-modal');
  box.appendChild(el('div', 'mn-modal-title', 'horizon'));
  box.appendChild(el('div', 'mn-choice-msg',
    'Hand this note back to yourself later. Nothing is due and nothing will '
    + 'notify you — it just surfaces on the horizon page when the date arrives.'));

  // What kind of thing is this?
  box.appendChild(el('label', 'mn-remind-label', 'this note is a'));
  const kindRow = el('div', 'mn-chips mn-horizon-chiprow');
  const drawKinds = () => {
    kindRow.innerHTML = '';
    for (const k of HORIZON_KINDS) {
      const c = btn(`${k.glyph} ${esc(k.label)}`, `mn-chip ${kind === k.key ? 'mn-chip-on' : ''}`, () => {
        kind = k.key;
        drawKinds();
      });
      c.title = k.hint;
      kindRow.appendChild(c);
    }
  };
  drawKinds();
  box.appendChild(kindRow);

  // When should it come back?
  box.appendChild(el('label', 'mn-remind-label', 'hand it back in'));
  const spanRow = el('div', 'mn-chips mn-horizon-chiprow');
  const dateInput = el('input', 'mn-input');
  dateInput.type = 'date';
  const preview = el('div', 'mn-remind-help');

  // One redraw for the whole "when" block — the span chips, the exact-day
  // input and the plain-English preview are three views of the same `at`.
  const drawWhen = () => {
    spanRow.innerHTML = '';
    for (const s of HORIZON_SPANS) {
      const c = btn(esc(s.label), `mn-chip ${span === s.key ? 'mn-chip-on' : ''}`, () => {
        span = s.key;
        at = s.months ? addMonths(Date.now(), s.months) : 0;
        drawWhen();
      });
      spanRow.appendChild(c);
    }
    dateInput.value = at ? horizonDate(at) : '';
    preview.innerHTML = at
      ? `Comes back <b>${esc(horizonDate(at))}</b> — ${esc(horizonLabel({ at }, Date.now()))}.`
      : 'No date: it waits under <b>someday</b> until you go looking.';
  };
  box.appendChild(spanRow);

  box.appendChild(el('label', 'mn-remind-label', 'or pick the exact day'));
  // A date input's value parsed as a string is UTC midnight, which lands on the
  // day before in western timezones — build it locally and mid-morning so
  // "2027-03-20" ripens ON the 20th wherever you are.
  dateInput.addEventListener('change', () => {
    const v = dateInput.value;
    if (!v) { at = 0; span = 'someday'; drawWhen(); return; }
    const [y, m, d] = v.split('-').map(Number);
    at = new Date(y, m - 1, d, 9, 0, 0, 0).getTime();
    span = '';
    drawWhen();
  });
  box.appendChild(dateInput);
  box.appendChild(preview);
  drawWhen();

  const row = el('div', 'mn-modal-row');
  if (existing) {
    row.appendChild(btn('remove', 'mn-btn-ghost', async () => {
      overlay.remove();
      const { meta, empty } = clearHorizonMeta(note);
      await writeMeta(note, meta, { empty });
      onDone();
    }));
  }
  row.appendChild(btn('cancel', '', () => overlay.remove()));
  row.appendChild(btn(existing ? 'update' : 'plant', 'mn-btn-primary', async () => {
    overlay.remove();
    await writeMeta(note, plantMeta(note, { kind, at }));
    onDone();
  }));
  box.appendChild(row);

  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}

// ── the editor banner ────────────────────────────────────────────────────

// The strip shown at the top of a planted note (mirrors the daily-note claim):
// what it is, when it comes back, and the one-tap ways to close it out or push
// it further. Returns null when the note isn't planted. `onChange(meta)` lets
// the editor route the write through its own rebasing save().
export function horizonBanner(note, { onChange, onEdit } = {}) {
  const h = horizonOf(note);
  if (!h) return null;
  const now = Date.now();
  const ripe = isRipe(h, now);
  const k = kindOf(h.kind);

  const bar = el('div', `mn-horizon-claim ${ripe ? 'mn-horizon-ripe' : ''} ${h.settledAt ? 'mn-horizon-done' : ''}`);
  const when = h.settledAt
    ? `settled ${horizonDate(h.settledAt)}`
    : isSomeday(h)
      ? 'someday'
      : `${horizonDate(h.at)} · ${horizonLabel(h, now)}`;
  bar.appendChild(el('span', 'mn-horizon-claim-label',
    `&#128301; <b>${esc(k.label)}</b> · ${esc(when)} `
    + `<span class="mn-dim">(planted ${esc(horizonDate(h.plantedAt))})</span>`));

  if (!h.settledAt) {
    const settle = btn('settle', 'mn-btn-ghost', () => onChange?.(settleMeta(note)));
    settle.title = 'close this one out — it moves to the settled arc';
    bar.appendChild(settle);
    if (ripe) {
      const push = btn('+1 year', 'mn-btn-ghost', () => onChange?.(pushOutMeta(note, 12)));
      push.title = 'not resolved yet — come back to it in a year';
      bar.appendChild(push);
    }
  } else {
    const reopen = btn('reopen', 'mn-btn-ghost', () => onChange?.(pushOutMeta(note, 12)));
    reopen.title = 'put it back on the horizon, a year out';
    bar.appendChild(reopen);
  }
  const edit = btn('edit', 'mn-btn-ghost', () => onEdit?.());
  edit.title = 'change the kind or the date';
  bar.appendChild(edit);
  return bar;
}

// ── the page ─────────────────────────────────────────────────────────────

function snippetOf(note) {
  const text = markdownToText(note.body || '').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function entryRow({ note, horizon: h }, now) {
  const row = el('div', 'mn-horizon-row');
  const k = kindOf(h.kind);

  const head = el('div', 'mn-horizon-head');
  head.appendChild(el('span', 'mn-horizon-glyph', esc(k.glyph)));
  const title = btn(esc(note.title || '(untitled)'), 'mn-btn-ghost mn-horizon-title',
    () => navigate(`#note/${note.id}`));
  head.appendChild(title);
  row.appendChild(head);

  const snip = snippetOf(note);
  if (snip) row.appendChild(el('div', 'mn-horizon-snippet', esc(snip)));

  const meta = el('div', 'mn-horizon-meta');
  const when = h.settledAt
    ? `settled ${horizonDate(h.settledAt)}`
    : isSomeday(h) ? 'someday' : `${horizonDate(h.at)} · ${horizonLabel(h, now)}`;
  meta.appendChild(el('span', 'mn-horizon-when', `${esc(k.label)} · ${esc(when)}`));
  meta.appendChild(el('span', 'mn-dim', `planted ${esc(horizonDate(h.plantedAt))}`));
  row.appendChild(meta);

  const acts = el('div', 'mn-horizon-acts');
  if (!h.settledAt) {
    acts.appendChild(btn('settle', 'mn-chip', async () => {
      await writeMeta(note, settleMeta(note));
      refresh();
    }));
    acts.appendChild(btn('+1 year', 'mn-chip', async () => {
      await writeMeta(note, pushOutMeta(note, 12));
      refresh();
    }));
  } else {
    acts.appendChild(btn('reopen', 'mn-chip', async () => {
      await writeMeta(note, pushOutMeta(note, 12));
      refresh();
    }));
  }
  acts.appendChild(btn('edit', 'mn-chip', () => horizonSheet(note, refresh)));
  acts.appendChild(btn('remove', 'mn-chip mn-chip-danger', () => {
    confirmBox(`Take "${note.title}" off the horizon?\n\nThe note itself is untouched.`, async () => {
      const { meta, empty } = clearHorizonMeta(note);
      await writeMeta(note, meta, { empty });
      refresh();
    });
  }));
  row.appendChild(acts);
  return row;
}

function band(title, hint, entries, now) {
  const wrap = el('div', 'mn-horizon-band');
  const head = el('div', 'mn-horizon-bandhead');
  head.appendChild(el('span', 'mn-horizon-bandtitle', `${esc(title)} <span class="mn-dim">(${entries.length})</span>`));
  if (hint) head.appendChild(el('span', 'mn-horizon-bandhint', esc(hint)));
  wrap.appendChild(head);
  for (const e of entries) wrap.appendChild(entryRow(e, now));
  return wrap;
}

export async function renderHorizon(root) {
  root.appendChild(topBar('horizon', '#home'));

  const now = Date.now();
  const notes = await store.getAllNotes();
  const g = groupHorizon(notes, now);
  const total = g.ripe.length + g.growing.length + g.someday.length + g.settled.length;

  if (!total) {
    root.appendChild(el('div', 'mn-horizon-lead',
      'The horizon is the long view: a question, a prediction or an idea you '
      + 'want handed back months or years from now. Open any note and tap '
      + '<b>&#128301; horizon</b> to plant one.'));
    root.appendChild(emptyState('nothing planted yet.'));
    return;
  }

  root.appendChild(el('div', 'mn-horizon-lead',
    'Questions, predictions and ideas you asked your future self to look at '
    + 'again. Nothing here is due; nothing notifies you.'));

  if (g.ripe.length) {
    root.appendChild(band('ripe', 'the date arrived — read it, then settle or push it out', g.ripe, now));
  }
  if (g.growing.length) {
    const wrap = el('div', 'mn-horizon-band');
    const head = el('div', 'mn-horizon-bandhead');
    head.appendChild(el('span', 'mn-horizon-bandtitle', `growing <span class="mn-dim">(${g.growing.length})</span>`));
    head.appendChild(el('span', 'mn-horizon-bandhint', 'still out ahead'));
    wrap.appendChild(head);
    for (const { year, entries } of byYear(g.growing)) {
      wrap.appendChild(el('div', 'mn-horizon-year', String(year)));
      for (const e of entries) wrap.appendChild(entryRow(e, now));
    }
    root.appendChild(wrap);
  }
  if (g.someday.length) {
    root.appendChild(band('someday', 'no date — they wait here until you come looking', g.someday, now));
  }

  if (g.settled.length) {
    // The record of what you thought and when — worth keeping, not worth
    // scrolling past every visit. Collapsed by default, per device.
    let open = localStorage.getItem(SETTLED_OPEN_KEY) === '1';
    const wrap = el('div', 'mn-horizon-band');
    const draw = () => {
      wrap.innerHTML = '';
      const t = btn(`settled <span class="mn-dim">(${g.settled.length})</span> ${open ? '&#9662;' : '&#9656;'}`,
        'mn-chip mn-tags-toggle', () => {
          open = !open;
          localStorage.setItem(SETTLED_OPEN_KEY, open ? '1' : '0');
          draw();
        });
      wrap.appendChild(t);
      if (open) for (const e of g.settled) wrap.appendChild(entryRow(e, now));
    };
    draw();
    root.appendChild(wrap);
  }
}

// Counts for the home chip — kept here so home doesn't need the pure core too.
export async function countHorizon() {
  return horizonCounts(await store.getAllNotes());
}
