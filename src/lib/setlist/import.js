// Text-paste parser for setlists received via text message.
// Handles the real-world format:
//   Set 1:
//   1  should've been a cowboy  C
//   2  don't rock the jukebox   S

const SET_HEADER_RE = /^set\s*(\d+)\s*:?\s*$/i;
const LINE_RE = /^\s*(\d+)\s*[.)\t\s]+\s*(.+)$/;
const TRAILING_VOCALIST_RE = /\s+([A-Z])\s*$/;

function titleCase(str) {
  return str.replace(/\w\S*/g, (w) =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
}

/**
 * Parse a text setlist into structured data.
 * @param {string} text - raw pasted text
 * @returns {{ sets: Array<{name: string, songs: Array<{title: string, vocalist: string}>}> }}
 */
export function parseTextList(text) {
  const lines = text.split(/\r?\n/);
  const sets = [];
  let currentSet = { name: 'Set 1', songs: [] };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const setMatch = line.match(SET_HEADER_RE);
    if (setMatch) {
      if (currentSet.songs.length > 0) sets.push(currentSet);
      currentSet = { name: `Set ${setMatch[1]}`, songs: [] };
      continue;
    }

    const lineMatch = line.match(LINE_RE);
    const songText = lineMatch ? lineMatch[2].trim() : line;
    if (!songText) continue;

    let title = songText;
    let vocalist = '';
    const vocMatch = title.match(TRAILING_VOCALIST_RE);
    if (vocMatch) {
      vocalist = vocMatch[1];
      title = title.slice(0, -vocMatch[0].length).trim();
    }

    title = titleCase(title);
    currentSet.songs.push({ title, vocalist });
  }

  if (currentSet.songs.length > 0) sets.push(currentSet);
  return { sets };
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
