// Next/prev walking context for the note editor — "the list I opened this
// note from", as last rendered on home: same order, same folder scope, same
// search/filter/sort. Home re-writes it on every list render; the editor walks
// it with ‹ › buttons. sessionStorage (not a module variable) so the context
// survives a reload mid-walk, and (not localStorage) so it stays per-tab and
// dies with the session instead of syncing anywhere.
//
// The list is a SNAPSHOT: walking notes whose order depends on updatedAt
// ("recently edited") doesn't reshuffle underfoot as autosaves bump the very
// notes being read. A note opened from elsewhere (palette, backlink, task
// link) simply isn't in the snapshot and shows no nav — that's the contract:
// prev/next means "in the list", not "in the whole corpus".

const KEY = 'voidstar.mind.noteNav';

// ids: ordered note ids as displayed; q: the search text active when the list
// rendered, carried along so each stop keeps its match highlighting.
export function setNoteNav(ids, q = '') {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ids, q }));
  } catch { /* storage full/unavailable — nav buttons just won't show */ }
}

export function getNoteNav() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const { ids, q } = JSON.parse(raw);
    return Array.isArray(ids) && ids.length ? { ids, q: q || '' } : null;
  } catch {
    return null;
  }
}
