// Text-paste parser for setlists received via text message.
// Handles the real-world format:
//   The Grey Eagle 6/14          ← optional header line(s): setlist/venue + date
//   Set 1:
//   1  should've been a cowboy  C
//   2  crazy (Patsy Cline cover)
//   3  don't rock the jukebox   S
//
// …and the dashier variant a bandmate texts:
//   Catoosa Fest - 9/5/2026 - Boot Scootin Boogie Nights
//   Chattahoochee - M
//   Sold - SM>              ← SM = two singers; trailing ">" = segue into…
//   >Queen of my double wide trailer - M   ← …this song (leading ">")
//   Two dozen roses - M - G ← trailing key after the vocalist code
//
// All parsing is deliberately local + rule-based (no model call). Header
// detection is a small signal stack — see the comment on parseTextList.

const SET_HEADER_RE = /^set\s*(\d+)\s*:?\s*$/i;
const LINE_RE = /^\s*(\d+)\s*[.)\t\s]+\s*(.+)$/;
// Bare trailing vocalist code, no dash ("don't rock the jukebox  S").
// 1–2 capitals (optionally &/+//-joined: "S&M") — never 3+, so a title
// ending in an all-caps word ("Party In The USA") keeps its last word.
const TRAILING_VOCALIST_RE = /\s+([A-Z](?:\s*[&+/]\s*[A-Z]{1,2})+|[A-Z]{1,2})\s*$/;
// A dash-separated trailing code segment can be a vocalist code…
const VOC_CODE_RE = /^[A-Z]{1,2}(?:\s*[&+/]\s*[A-Z]{1,2})*$/;
// …or a key ("G", "C#", "Bbm", "F#m"). A bare capital letter matches both;
// assignment order decides (first code = vocalist, later key-shaped = key).
const KEY_TOKEN_RE = /^[A-G][#♯b♭]?m?$/;

function titleCase(str) {
  return str.replace(/\w\S*/g, (w) =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
}

// ── Header (setlist/venue/date) detection ──

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Words that read as "this line names a place or an event, not a song".
// A song title *can* contain these, but only leading lines are ever tested,
// so the blast radius of a false positive is the first line of a paste.
const VENUE_WORDS = /\b(setlist|set\s?list|gig|show|live\s+at|bar|grill|saloon|tavern|brewery|brewing|taproom|hall|club|lounge|cafe|café|theater|theatre|ballroom|amphitheater|amphitheatre|pavilion|lodge|pub|inn|winery|distillery|opry|arena|fest|festival|fairgrounds|coffeehouse|listening\s+room)\b/i;

function pad2(n) { return String(n).padStart(2, '0'); }

function toIso(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

// Find a date anywhere in the line. Returns {iso, index, length} or null.
// A missing year assumes the current year (setlists are pasted around the
// gig, not archived), two-digit years assume 20xx.
function extractDate(str) {
  const nowYear = new Date().getFullYear();
  let m = str.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const iso = toIso(+m[1], +m[2], +m[3]);
    if (iso) return { iso, index: m.index, length: m[0].length };
  }
  m = str.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/) ||
      str.match(/\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : nowYear;
    const iso = toIso(y, +m[1], +m[2]);
    if (iso) return { iso, index: m.index, length: m[0].length };
  }
  m = str.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i);
  if (m) {
    const iso = toIso(m[3] ? +m[3] : nowYear, MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
    if (iso) return { iso, index: m.index, length: m[0].length };
  }
  return null;
}

// Classify one leading line as possible setlist metadata.
// Returns { name, venue, gigDate, strong } — strong means the line carries a
// positive signal (date, venue-ish word, "@") on its own; weak candidates
// need corroboration from context (see parseTextList).
function parseHeaderLine(line) {
  const out = { name: '', venue: '', gigDate: '', strong: false };
  let rest = line;

  const d = extractDate(rest);
  if (d) {
    out.gigDate = d.iso;
    out.strong = true;
    rest = (rest.slice(0, d.index) + rest.slice(d.index + d.length)).trim();
  }
  // Strip separator debris the date removal may have exposed — doubled-up
  // separators mid-line ("Catoosa Fest -  - Boot Scootin Boogie Nights"
  // after the 9/5/2026 came out), then anything left at the edges.
  rest = rest.replace(/\s*[-–—|·,:]\s*[-–—|·,:]\s*/g, ' - ');
  rest = rest.replace(/^[\s\-–—,|·:]+|[\s\-–—,|·:]+$/g, '').trim();

  const atSplit = rest.match(/^(.*\S)\s*(?:@|\bat\b)\s+(\S.*)$/i);
  if (atSplit && rest.includes('@')) {
    // "@" is unambiguous ("nightjar @ the odditorium"); a bare " at " is only
    // trusted when the line already carries another signal.
    out.strong = true;
    out.name = rest;
    out.venue = atSplit[2].trim();
  } else if (VENUE_WORDS.test(rest)) {
    out.strong = true;
    out.name = rest;
    // A dash-segmented header ("Catoosa Fest - Boot Scootin Boogie Nights")
    // has the venue-ish segment as the venue; the full line stays the name.
    const segs = rest.split(/\s+[-–—]\s+|\s*[|·]\s*/).map((s) => s.trim()).filter(Boolean);
    const venueSeg = segs.length > 1 ? segs.find((s) => VENUE_WORDS.test(s)) : null;
    if (venueSeg) {
      out.venue = venueSeg;
    } else {
      out.venue = /\b(setlist|set\s?list|gig|show)\b/i.test(rest)
        ? rest.replace(/\b(setlist|set\s?list|gig|show)\b/gi, '').replace(/^[\s\-–—,|·:]+|[\s\-–—,|·:]+$/g, '').trim()
        : rest;
    }
    if (atSplit) out.venue = atSplit[2].trim();
  } else {
    out.name = rest;
  }
  return out;
}

// ── Trailing vocalist / key codes ──

// Pull trailing performance codes off a song line: dash-separated vocalist
// code and/or key ("Two dozen roses - M - G", "Fishin in the Dark - M - C#",
// "From this moment on - S&SM"), else the bare trailing code with no dash
// ("don't rock the jukebox  S", "Sold SM"). Collected segments assign
// left-to-right: the first vocalist-shaped one is the vocalist, a later
// key-shaped one is the key — so "M - G" reads vocalist M, key G, while a
// lone "- G" stays a vocalist (the long-standing single-letter convention).
function extractTrailingCodes(text) {
  let title = text;
  let vocalist = '';
  let key = '';

  const segs = [];
  for (;;) {
    // Only the final dash segment can match (the capture can't span a dash),
    // so this peels codes off the end one at a time.
    const m = title.match(/\s+[-–—]\s+([^-–—]+?)\s*$/);
    if (!m) break;
    const seg = m[1].trim();
    if (!VOC_CODE_RE.test(seg) && !KEY_TOKEN_RE.test(seg)) break;
    segs.unshift(seg);
    title = title.slice(0, m.index).trim();
  }
  for (const seg of segs) {
    if (!vocalist && VOC_CODE_RE.test(seg)) { vocalist = seg.replace(/\s+/g, ''); continue; }
    if (!key && KEY_TOKEN_RE.test(seg)) { key = seg; }
  }
  if (!vocalist && !segs.length) {
    const m = title.match(TRAILING_VOCALIST_RE);
    if (m) {
      vocalist = m[1].replace(/\s+/g, '');
      title = title.slice(0, -m[0].length).trim();
    }
  }
  return { title, vocalist, key };
}

// ── Per-song artist / cover extraction ──

// Trailing parentheticals that are performance notes, never an artist.
const NON_ARTIST_PAREN = /^(acoustic|live|instrumental|reprise|slow|fast|solo|duet|encore|maybe|optional|new|original|orig|wip|tbd|request|requested|medley|partial|short|extended|jam|w\/.*|with\s.*|no\s.*|drop\s+[a-g].*|capo\s*\d*|key\s+of\s+.*|in\s+[a-g][#b♯♭]?m?|x\s*\d+)$/i;

// Right side of a spaced dash that is a note, not an artist.
const NON_ARTIST_DASH = /^(key\s+of\b|capo\b|in\s+[a-g][#b♯♭]?m?$|acoustic$|slow|fast|maybe|optional|encore|x\s*\d+$)/i;

// Pull an explicit artist and/or cover marker off a song line.
// Recognized shapes, checked in order:
//   "Title (Artist cover)" / "Title (cover of Artist)" → artist + cover
//   "Title (cover)"                                    → cover, no artist
//   "Title (by Artist)"                                → artist
//   "Title (Artist)"    — 1–4 words, no digits, not a performance note
//   "Title - Artist"    — spaced hyphen/en/em dash, right side not a note
function extractArtist(text) {
  let title = text;
  let artist = '';
  let cover = false;

  const paren = title.match(/\(([^()]*)\)\s*$/);
  if (paren) {
    const inner = paren[1].trim();
    const coverM = inner.match(/^(?:(.*?)\s+)?cover(?:\s+of\s+(.+))?$/i);
    const byM = inner.match(/^by\s+(.+)$/i);
    if (coverM) {
      cover = true;
      artist = (coverM[2] || coverM[1] || '').trim();
      title = title.slice(0, paren.index).trim();
    } else if (byM) {
      artist = byM[1].trim();
      title = title.slice(0, paren.index).trim();
    } else if (
      inner && !NON_ARTIST_PAREN.test(inner) && !/\d/.test(inner) &&
      inner.split(/\s+/).length <= 4 && title.slice(0, paren.index).trim()
    ) {
      artist = inner;
      title = title.slice(0, paren.index).trim();
    }
  }

  if (!artist && !cover) {
    const dash = title.match(/^(.+\S)\s+[-–—]\s+(\S.+)$/);
    if (dash && !NON_ARTIST_DASH.test(dash[2]) && !/\d{3,}/.test(dash[2])) {
      title = dash[1].trim();
      artist = dash[2].trim();
    }
  }

  return { title, artist: artist ? titleCase(artist) : '', cover };
}

/**
 * Parse a text setlist into structured data.
 *
 * Header heuristic (all local, no model): the first one or two non-empty
 * lines are treated as setlist/venue metadata instead of songs when they
 * carry a positive signal — a date, a venue-ish word (bar/hall/brewery/…,
 * or "setlist"/"gig"/"show"), or an "@". Two weaker corroborations also
 * promote a signal-less first line: it is set off from the songs by a blank
 * line, or the very next line is date-dominant ("Moose Lodge"\n"June 14").
 * A first line with none of that is just a song — paste a bare song list and
 * nothing is swallowed. A line carrying song-only shapes (a leading/trailing
 * ">" segue marker or a trailing vocalist/key code) is never a header, so a
 * headerless paste whose first song mentions a bar stays a song.
 *
 * Segues: a trailing ">" on a line and/or a leading ">" on the next line
 * mark the two songs as transitioned-between (the first bleeds into the
 * second, no break) — normalized onto the FIRST song as segueNext.
 *
 * @param {string} text - raw pasted text
 * @param {{defaultArtist?: string}} [opts] - defaultArtist is applied to
 *   every song with no explicit artist that isn't marked as a cover (for
 *   pasting an originals set: type your band name once).
 * @returns {{
 *   meta: {name: string, venue: string, gigDate: string},
 *   sets: Array<{name: string, songs: Array<{title: string, vocalist: string, artist: string, cover: boolean, key: string, segueNext: boolean}>}>
 * }}
 */
export function parseTextList(text, opts = {}) {
  const defaultArtist = (opts.defaultArtist || '').trim();
  const rawLines = text.split(/\r?\n/);
  const meta = { name: '', venue: '', gigDate: '' };

  // ── Header scan over leading lines ──
  let start = 0;
  let headerCount = 0;
  const trimmed = rawLines.map((l) => l.trim());
  const looksLikeSongLine = (l) =>
    SET_HEADER_RE.test(l) || LINE_RE.test(l) || /^>|>$/.test(l) ||
    !!extractTrailingCodes(l).vocalist || !!extractTrailingCodes(l).key;
  for (let i = 0; i < rawLines.length && headerCount < 2; i++) {
    const line = trimmed[i];
    if (!line) { start = i + 1; continue; }
    if (looksLikeSongLine(line)) break;
    const h = parseHeaderLine(line);
    let accept = h.strong;
    if (!accept && headerCount === 0) {
      const restNonEmpty = trimmed.slice(i + 1).filter(Boolean);
      // Weak signal A: first line set off from ≥2 song lines by a blank line.
      const blankAfter = trimmed[i + 1] === '' && restNonEmpty.length >= 2;
      // Weak signal B: the next line is date-dominant ("Moose Lodge" \n "June 14").
      const next = restNonEmpty[0] ? parseHeaderLine(restNonEmpty[0]) : null;
      const nextIsDate = !!(next && next.gigDate && next.name.split(/\s+/).filter(Boolean).length <= 2);
      accept = blankAfter || nextIsDate;
    }
    if (!accept) break;
    if (h.name && !meta.name) meta.name = h.name;
    if (h.venue && !meta.venue) meta.venue = h.venue;
    if (h.gigDate && !meta.gigDate) meta.gigDate = h.gigDate;
    headerCount++;
    start = i + 1;
  }

  // ── Song lines ──
  const body = rawLines.slice(start);
  // Leading digits are track numbers only when the paste is mostly a
  // numbered list — otherwise an unnumbered "9 To 5" loses its 9.
  const songLines = body.map((l) => l.trim()).filter((l) => l && !SET_HEADER_RE.test(l));
  const numberedCount = songLines.filter((l) => LINE_RE.test(l)).length;
  const stripNumbers = numberedCount >= 2 && numberedCount >= songLines.length * 0.6;

  const sets = [];
  let currentSet = { name: 'Set 1', songs: [] };
  // Fold the two segue notations onto one flag: a trailing ">" on song A
  // and/or a leading ">" on song B both mean A bleeds into B — either alone
  // is enough, and the marker lives on A as segueNext.
  const finalizeSet = (set) => {
    for (let i = 0; i < set.songs.length; i++) {
      const s = set.songs[i];
      if (i < set.songs.length - 1 && set.songs[i + 1]._segueFromPrev) s.segueNext = true;
      delete s._segueFromPrev;
    }
    return set;
  };

  for (const raw of body) {
    let line = raw.trim();
    if (!line) continue;

    const setMatch = line.match(SET_HEADER_RE);
    if (setMatch) {
      if (currentSet.songs.length > 0) sets.push(finalizeSet(currentSet));
      currentSet = { name: `Set ${setMatch[1]}`, songs: [] };
      continue;
    }

    // Segue markers come off first — the trailing ">" sits after the codes
    // ("Sold - SM>"), the leading one before the number/title.
    let segueFromPrev = false;
    let segueNext = false;
    if (/^>+/.test(line)) { segueFromPrev = true; line = line.replace(/^>+\s*/, ''); }
    if (/>+$/.test(line)) { segueNext = true; line = line.replace(/\s*>+$/, ''); }

    const lineMatch = stripNumbers ? line.match(LINE_RE) : null;
    const songText = lineMatch ? lineMatch[2].trim() : line;
    if (!songText) continue;

    const codes = extractTrailingCodes(songText);
    const ex = extractArtist(codes.title);
    const title = titleCase(ex.title);
    let artist = ex.artist;
    if (!artist && !ex.cover && defaultArtist) artist = defaultArtist;
    currentSet.songs.push({
      title, vocalist: codes.vocalist, artist, cover: ex.cover,
      key: codes.key, segueNext, _segueFromPrev: segueFromPrev,
    });
  }

  if (currentSet.songs.length > 0) sets.push(finalizeSet(currentSet));
  return { meta, sets };
}

export function isSpotifyUrl(text) {
  return /open\.spotify\.com\/(playlist|track)\//.test(text.trim());
}

/**
 * Detect if text is a Spotify URL and extract the type/id.
 * @param {string} text
 * @returns {{type: string, id: string} | null}
 */
export function parseSpotifyInput(text) {
  const m = text.trim().match(/open\.spotify\.com\/(playlist|track)\/([a-zA-Z0-9]+)/);
  return m ? { type: m[1], id: m[2] } : null;
}
