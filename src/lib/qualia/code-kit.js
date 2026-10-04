// `kit` — bank names for the bundled sample collections, so a pattern doesn't
// have to remember the `<bank><genre>` prefixes.
//
//   s("bd sd").bank(kit.sig.metal)          // 'sigmetal' — the signature pack
//   s("bd sd").bank(kit.r0.lofi)            // 'r0lofi'   — real recordings (needs network)
//   s("bd*2 sd").bank(kit.ab('metal'))      // '<sigmetal v0metal r0metal>' — A/B per cycle
//   s("bd hh sd hh").bank(kit.tour())       // every genre in turn, active collection
//   kit.ls()  /  kit.ls('metal')  /  kit.ls('r0')   // cheatsheet table in the console
//
// The plain genre (`.bank("metal")`) plays whichever collection is active in
// the sequencer; kit.<bank>.<genre> pins one. Registration lives in
// strudel-hydra.js (registerSharedSamples); see docs/samples.md.

/** The voice contract every bundled pack fills (public/samples/README.md). */
export const KIT_VOICES = ['bd', 'sd', 'rim', 'hh', 'oh', 'lt', 'mt', 'ht', 'rd', 'cr'];

/**
 * @param {{ collections: Array<{id:string, bank:string, remote?:boolean}>,
 *           genres: string[], active: () => string,
 *           genreDescs?: Record<string, string> }} env
 */
export function makeKit({ collections, genres, active, genreDescs = {} }) {
  const byRef = (ref) => collections.find((c) => c.bank === ref || c.id === ref);
  const kit = {
    /** Genre names, in picker order. */
    genres: [...genres],
    /** The ten voice names every pack has: s("bd sd rim hh …"). */
    voices: [...KIT_VOICES],
    /** [{ id, bank, remote }] — remote packs stream from the network. */
    collections: collections.map(({ id, bank, remote }) => ({ id, bank, remote: !!remote })),
    /** Active collection id (the one plain .bank("<genre>") plays). */
    active: () => active(),
    /** Bank name for a genre in a collection (bank token or id; default: the
     *  plain, active-collection name). Unknown genre → '' with a warning. */
    bank: (genre, collection) => {
      if (!genres.includes(genre)) {
        console.warn(`[qualia] kit: unknown genre "${genre}" — try one of: ${genres.join(', ')}`);
        return '';
      }
      if (collection === undefined) return genre;
      const c = byRef(collection);
      if (!c) {
        console.warn(`[qualia] kit: unknown collection "${collection}" — try one of: ${collections.map((x) => x.bank).join(', ')}`);
        return genre;
      }
      return c.bank + genre;
    },
    /** One genre across every collection, a collection per cycle: '<sigmetal v0metal r0metal>'.
     *  Pass false to leave out the remote (network) collection. */
    ab: (genre, withRemote = true) => {
      const list = collections.filter((c) => withRemote || !c.remote).map((c) => kit.bank(genre, c.bank));
      return `<${list.join(' ')}>`;
    },
    /** Every genre in turn, a genre per cycle: '<voidstar lofi …>' (active
     *  collection), or pinned to one collection: kit.tour('sig'). */
    tour: (collection) => `<${genres.map((g) => kit.bank(g, collection)).join(' ')}>`,
    /** Every bank name with what it is, as rows { bank, genre, collection, about }
     *  — also printed as a console table. Filter by genre ('metal') or
     *  collection ('r0' / 'real_0'); 'active' rows are the plain genre names. */
    ls: (filter) => {
      const f = filter === undefined ? '' : String(filter).trim().toLowerCase();
      const rows = [];
      for (const g of genres) {
        const about = genreDescs[g] || '';
        rows.push({ bank: g, genre: g, collection: `active (${active()})`, about });
        for (const c of collections) {
          rows.push({ bank: c.bank + g, genre: g, collection: c.id, about: c.remote ? `${about} [needs network]` : about });
        }
      }
      const hit = (r) => !f || r.genre === f || r.collection === f || r.bank === f
        || collections.some((c) => c.bank === f && r.collection === c.id)
        || (f === 'active' && r.bank === r.genre);
      const out = rows.filter(hit);
      if (!out.length) console.warn(`[qualia] kit.ls: nothing matches "${filter}" — try a genre (${genres.join(', ')}) or a collection (${collections.map((c) => c.bank).join(', ')}, active)`);
      else (console.table || console.log)(out);
      return out;
    },
  };
  // kit.sig.metal, kit.v0.dub, kit.r0.jazz, …
  for (const c of collections) {
    kit[c.bank] = Object.fromEntries(genres.map((g) => [g, c.bank + g]));
  }
  return kit;
}
