// Fuzzy title matching for auto-linking songs to Spotify tracks and Google Drive charts.

const ARTICLES = /^(the|a|an)\s+/i;
const PARENS = /\s*\([^)]*\)\s*/g;
const FEAT = /\s*(feat\.?|ft\.?|featuring)\s+.*/i;
const PUNCTUATION = /[''"".,!?&\-–—:;/\\]/g;
const MULTI_SPACE = /\s{2,}/g;

function normalize(title) {
  return (title || '')
    .toLowerCase()
    .replace(PARENS, ' ')
    .replace(FEAT, '')
    .replace(ARTICLES, '')
    .replace(PUNCTUATION, ' ')
    .replace(MULTI_SPACE, ' ')
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
 */
export function matchScore(titleA, titleB) {
  const a = normalize(titleA);
  const b = normalize(titleB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Substring containment is a strong signal ("Sweet Home" ⊂ "Sweet Home
  // Alabama"), but only when the contained title is substantial. Guard against
  // a tiny fragment (e.g. a mis-parsed one-letter "T" from "T-R-O-U-B-L-E"),
  // which is a substring of nearly every title and would otherwise score 0.9
  // for almost every song, hijacking their chart match.
  const shorter = a.length <= b.length ? a : b;
  if (shorter.length >= 4 && (a.includes(b) || b.includes(a))) return 0.9;
  const maxLen = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Find the best match for a song title in a list of candidates.
 * @param {string} songTitle
 * @param {Array<{title: string, [key: string]: any}>} candidates
 * @param {number} threshold - minimum score to consider a match (default 0.7)
 * @returns {{match: object, score: number} | null}
 */
export function findBestMatch(songTitle, candidates, threshold = 0.7) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = matchScore(songTitle, c.title);
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
 * @returns {{match: object, score: number} | null}
 */
export function findBestMatchWithArtist(songTitle, songArtist, candidates, threshold = 0.7) {
  const scored = [];
  for (const c of candidates) {
    const titleScore = matchScore(songTitle, c.title);
    if (titleScore < threshold) continue;
    let artistBonus = 0;
    if (songArtist && c.artist) {
      const artistScore = matchScore(songArtist, c.artist);
      if (artistScore >= 0.7) artistBonus = 0.15 * artistScore;
    }
    scored.push({ match: c, score: titleScore + artistBonus });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
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
