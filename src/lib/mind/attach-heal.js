// Reconcile a note body's inline `mn-attach://` image references against the
// note's attachment records.
//
// A note can end up with the body pointing at an attachment that was trashed
// (or replaced by a re-encoded/duplicate copy) while a live attachment for the
// same image survives. On the device that made the edit the trashed blob still
// lingers in IndexedDB (blobs outlive the tombstone until the 30-day purge), so
// the picture keeps rendering there and the breakage is invisible — but every
// other device only has the live attachment's bytes, so the inline image dies
// with "image unavailable on this device". This repoints such a dead reference
// to the live survivor when the match is unambiguous.
//
// PURE: no DOM, no IndexedDB. Tested by scripts/check-mind-attach-heal.mjs.

const REF_RE = /mn-attach:\/\/([^\s)"'\]]+)/g;

// Distinct attachment ids referenced by the body, in first-seen order.
export function bodyAttachmentRefs(body) {
  const ids = [];
  for (const m of String(body || '').matchAll(REF_RE)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Repoint dead inline `mn-attach://` references to a live replacement.
 *
 * @param {string} body  note markdown (canonical body)
 * @param {Array<{id:string,name?:string,kind?:string,deletedAt?:number}>} attachments
 *        ALL records for the note (live AND trashed), so a dead reference's
 *        name/kind is still recoverable for matching.
 * @returns {{ body:string, changed:boolean, repoints:Array<{from:string,to:string}> }}
 */
export function healBodyAttachmentRefs(body, attachments = []) {
  const refs = bodyAttachmentRefs(body);
  if (!refs.length) return { body, changed: false, repoints: [] };

  const byId = new Map(attachments.map((a) => [a.id, a]));
  const live = attachments.filter((a) => !a.deletedAt);

  const isDead = (id) => {
    const a = byId.get(id);
    return !a || !!a.deletedAt;
  };

  // A live attachment already spoken for by a healthy reference is never a
  // candidate — we must not point two inline images at the same binary.
  const claimed = new Set(refs.filter((id) => !isDead(id)));
  const deadRefs = refs.filter(isDead);

  // Dead refs eligible for the sole-spare-image fallback: a trashed image, or a
  // ref whose record was already purged (kind unknown, so it may be an image).
  // The fallback only fires when exactly one such ref exists, so an ambiguous
  // many-to-many never guesses.
  const imageCandidateCount = deadRefs.filter((id) => {
    const a = byId.get(id);
    return !a || a.kind === 'image';
  }).length;

  const repoints = [];
  for (const deadId of deadRefs) {
    const dead = byId.get(deadId); // undefined if the record was already purged
    let target = null;

    if (dead) {
      // Exact same-image match: same kind AND same filename, still unclaimed.
      const matches = live.filter(
        (a) => a.kind === dead.kind && a.name === dead.name && !claimed.has(a.id),
      );
      if (matches.length === 1) target = matches[0];
    }

    // Fallback (images only): a single dead image/unknown reference paired with a
    // single unclaimed live image is unambiguous even when names don't line up.
    if (!target && (!dead || dead.kind === 'image') && imageCandidateCount === 1) {
      const spares = live.filter((a) => a.kind === 'image' && !claimed.has(a.id));
      if (spares.length === 1) target = spares[0];
    }

    if (target) {
      claimed.add(target.id);
      repoints.push({ from: deadId, to: target.id });
    }
  }

  if (!repoints.length) return { body, changed: false, repoints: [] };

  let out = body;
  for (const { from, to } of repoints) {
    // The (?![\w-]) guard stops a shorter id from matching inside a longer one.
    out = out.replace(new RegExp(`mn-attach://${escapeRe(from)}(?![\\w-])`, 'g'), `mn-attach://${to}`);
  }
  return { body: out, changed: true, repoints };
}
