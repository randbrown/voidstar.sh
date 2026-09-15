// Fuzzy title matching for auto-linking songs to Spotify tracks and Google Drive charts.

const ARTICLES = /^(the|a|an)\s+/i;
const PARENS = /\s*\([^)]*\)\s*/g;
const FEAT = /\s*(feat\.?|ft\.?|featuring)\s+.*/i;
// Straight AND curly quotes: a setlist pasted from Messages carries the curly
// forms ("Boot Scootin’ Boogie") while the library usually holds the straight
// or omitted form, and the mismatch used to knock an otherwise identical title
// off the exact/normalized rungs and down into fuzzy guessing.
const PUNCTUATION = /[''‘’""“”.,!?&\-–—:;/\\]/g;
// Zero-width junk that rides along with copy/paste (BOM, ZWSP/ZWNJ/ZWJ, word
// joiner) — invisible on screen, but enough to make two identical titles
// compare unequal.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const WHITESPACE = /\s+/g;

// Comparison key for “the same title, typed differently”: case, invisible
// characters and runs of whitespace (a double space, a stray tab) are never
// what makes two songs different.
export function titleKey(title) {
  return (title || '').replace(INVISIBLE, '').toLowerCase().replace(WHITESPACE, ' ').trim();
}

function normalize(title) {
  return (title || '')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .replace(PARENS, ' ')
    .replace(FEAT, '')
    .replace(ARTICLES, '')
    .replace(PUNCTUATION, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Score how well two titles match. Returns 0–1 (1 = exact match).
 *
 * `containment: false` drops the substring shortcut below, leaving pure edit
 * distance — for callers that must not let a SHORTER stored title swallow a
 * longer one ("Goodbye" claiming "Goodbye Earl"). See findLibrarySongMatch.
 */
export function matchScore(titleA, titleB, { containment = true } = {}) {
  const a = normalize(titleA);
  const b = normalize(titleB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Substring containment is a strong signal for a partial/extended title
  // ("Sweet Home" ⊂ "Sweet Home Alabama"), but only when the shorter title is
  // substantial AND covers a meaningful share of the longer one. Without the
  // coverage floor, a short generic word that merely sits inside a long,
  // unrelated title scores 0.9 and hijacks the match — e.g. "Up!" inside
  // "Ain't Goin Down Til The Sun Comes Up", or a mis-parsed one-letter "T"
  // from "T-R-O-U-B-L-E" (a substring of nearly every title).
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (containment && shorter.length >= 4 && shorter.length / longer.length >= 0.5 &&
      (a.includes(b) || b.includes(a))) {
    return 0.9;
  }
  const maxLen = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Find the best match for a song title in a list of candidates.
 * @param {string} songTitle
 * @param {Array<{title: string, [key: string]: any}>} candidates
 * @param {number} threshold - minimum score to consider a match (default 0.7)
 * @param {{containment?: boolean}} [opts] - passed through to matchScore
 * @returns {{match: object, score: number} | null}
 */
export function findBestMatch(songTitle, candidates, threshold = 0.7, opts = {}) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = matchScore(songTitle, c.title, opts);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= threshold ? { match: best, score: bestScore } : null;
}

/**
 * Cross-reference matching: when multiple candidates share a similar title score,
 * use artist from a secondary source to disambiguate.
 * @param {string} songTitle
 * @param {string} songArtist - known artist (from Drive or manual entry)
 * @param {Array<{title: string, artist?: string}>} candidates
 * @param {number} threshold
 * @param {{containment?: boolean}} [opts] - passed through to matchScore for
 *   the TITLE comparison only; artist agreement always scores the normal way.
 * @returns {{match: object, score: number} | null}
 */
export function findBestMatchWithArtist(songTitle, songArtist, candidates, threshold = 0.7, opts = {}) {
  const scored = [];
  for (const c of candidates) {
    const titleScore = matchScore(songTitle, c.title, opts);
    if (titleScore < threshold) continue;
    // Artist agreement adjusts the score in BOTH directions: a matching
    // artist boosts near-title matches, and a clearly different artist sinks
    // the candidate below the acceptance bar — "Bye Bye Bye" (*NSYNC) must
    // never auto-link a song the user has down as Jo Dee Messina's "Bye-Bye",
    // however well the titles overlap. The penalty only blocks auto-linking
    // (matching is fill-empty everywhere); it can't unlink anything.
    let artistAdj = 0;
    if (songArtist && c.artist) {
      const artistScore = matchScore(songArtist, c.artist);
      if (artistScore >= 0.7) artistAdj = 0.15 * artistScore;
      else if (artistScore < 0.4) artistAdj = -0.35;
    }
    const score = titleScore + artistAdj;
    if (score < threshold) continue;
    scored.push({ match: c, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

/**
 * Find the library song a pasted/imported title refers to — forgiving on
 * purpose, because titles arrive via text message: "Heads carolina" means the
 * library's "Heads Carolina, Tails California", and stray punctuation must
 * not mint a duplicate song. Escalates through: exact title → normalized
 * (punctuation/articles/parens-insensitive) → word-boundary partial title →
 * fuzzy score — strictly in that order, so a library song whose title matches
 * the paste always wins over any guess, however good the guess scores. A clear
 * artist disagreement blocks reuse at every rung past exact (a wrong merge is
 * worse than a duplicate), and an ambiguous partial (two candidates it can't
 * split) returns null for the same reason.
 *
 * @param {string} title - pasted title
 * @param {string} artist - pasted artist ('' = unknown)
 * @param {Array<{title: string, artist?: string}>} songs - library songs
 * @returns {{song: object, how: 'exact'|'normalized'|'partial'|'fuzzy'} | null}
 */
export function findLibrarySongMatch(title, artist, songs, { threshold = 0.8 } = {}) {
  const key = titleKey(title);
  if (!key) return null;
  // Exact first, across the WHOLE library — nothing below may pre-empt it.
  let song = songs.find((s) => titleKey(s.title) === key);
  if (song) return { song, how: 'exact' };

  const artistOk = (s) => {
    if (!artist || !s.artist) return true;
    return matchScore(artist, s.artist) >= 0.4;
  };

  const n = normalize(title);
  if (!n) return null;
  song = songs.find((s) => normalize(s.title) === n && artistOk(s));
  if (song) return { song, how: 'normalized' };

  // Word-boundary partial: one title is a leading chunk of the other
  // ("heads carolina" ⊂ "heads carolina tails california"). The shorter side
  // must be ≥ 2 words and ≥ 6 chars — a one-word prefix ("Breathe" vs
  // "Breathe In Breathe Out") is a different song, not a shorthand.
  const prefixHits = [];
  for (const s of songs) {
    const t = normalize(s.title);
    if (!t || t === n) continue;
    const [shorter, longer] = n.length <= t.length ? [n, t] : [t, n];
    if (shorter.length < 6 || !shorter.includes(' ')) continue;
    if (!longer.startsWith(shorter) || longer[shorter.length] !== ' ') continue;
    if (!artistOk(s)) continue;
    prefixHits.push(s);
  }
  if (prefixHits.length) {
    prefixHits.sort((a, b) => matchScore(title, b.title) - matchScore(title, a.title));
    if (prefixHits.length === 1 ||
        matchScore(title, prefixHits[0].title) - matchScore(title, prefixHits[1].title) > 0.05) {
      return { song: prefixHits[0], how: 'partial' };
    }
    return null; // ambiguous — let the import create a song rather than guess
  }

  // Fuzzy is edit-distance only (containment off). matchScore's substring
  // shortcut scores any containment 0.9 — well past this rung's bar — which
  // let a SHORTER library title swallow a longer pasted one: "Goodbye Earl"
  // landed on a library "Goodbye", and no "Goodbye Earl" was ever created.
  // Genuine shorthand ("Heads carolina") is the partial rung's job, where the
  // word-boundary rules can tell it apart from a different song.
  const best = findBestMatchWithArtist(title, artist || '', songs, threshold, { containment: false });
  if (best) return { song: best.match, how: 'fuzzy' };
  return null;
}

/**
 * Parse a Google Drive filename into title and artist.
 * Handles formats like: "06. Two Dozen Roses - Shenandoah" or "Song Title - Artist.pdf"
 */
export function parseDriveFilename(name) {
  let clean = name.replace(/\.(pdf|docx?|txt|gdoc)$/i, '').trim();
  clean = clean.replace(/^\d+\.\s*/, '');
  // Split "Title - Artist" only on a dash flanked by whitespace. Requiring the
  // surrounding spaces keeps hyphenated or spelled-out titles intact — e.g.
  // "T-R-O-U-B-L-E - Travis Tritt" must parse to title "T-R-O-U-B-L-E", not "T"
  // (a bare /\s*[-–—]\s*/ splits on every internal hyphen).
  const parts = clean.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { title: parts[0].trim(), artist: parts.slice(1).join(' - ').trim() };
  }
  return { title: clean, artist: '' };
}
