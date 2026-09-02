// Build (or refresh) a real Spotify playlist from a setlist — the write-side
// counterpart to the read-only reference-playlist machinery in sync.js.
// Everything runs as the signed-in user (PKCE token from spotify-auth.js):
// since the Feb 2026 API migration a client-credentials token can't touch
// playlist contents at all, and creating one on the user's account needs
// their consent (the playlist-modify scopes) anyway. No worker involved.
//
// Which songs go in, in what order, and what's reported as left out is the
// pure module spotify-export-core.js; this file is only the HTTP.

import { getSpotifyUserToken, isSpotifyConnected, hasSpotifyScope } from './spotify-auth.js';
import { collectSetlistTrackUris, exportPlaylistName, exportPlaylistDescription } from './spotify-export-core.js';

const API = 'https://api.spotify.com/v1';

async function spotifyCall(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.error?.message || ''; } catch {}
    const err = new Error(`Spotify rejected ${method} ${path} (${res.status}${msg ? `: ${msg}` : ''})`);
    err.status = res.status;
    throw err;
  }
  try { return await res.json(); } catch { return null; }
}

// The Feb 2026 migration renamed the playlist-contents path /tracks → /items
// for reads, and which name writes answer to varies by app quota mode (the
// same reason sync.js parses both `item` and `track`). Probe /items first to
// match the read path, fall back to /tracks when Spotify doesn't serve the
// path (404/405 — anything else, e.g. a 403 or 429, is a real answer that
// the other path can't fix), and remember what worked.
let _writeSuffix = null;
async function writeContents(token, playlistId, method, body) {
  const candidates = _writeSuffix ? [_writeSuffix] : ['items', 'tracks'];
  let lastErr = null;
  for (const suffix of candidates) {
    try {
      const out = await spotifyCall(token, method, `/playlists/${playlistId}/${suffix}`, body);
      _writeSuffix = suffix;
      return out;
    } catch (e) {
      lastErr = e;
      if (e.status !== 404 && e.status !== 405) throw e;
    }
  }
  throw lastErr; // 404 on both paths — the playlist itself is gone
}

// Create a private playlist from the setlist's linked songs, or make the
// previously-exported one (existingPlaylistId) match the setlist again — the
// first write batch replaces the contents, so removals and re-orders on the
// setlist propagate. A recorded playlist that no longer exists (404) is
// quietly rebuilt as a fresh one.
//
// Throws user-readable errors; `needsConnect` / `needsReauth` on the error
// mark the two auth cases the UI can do something about (send to Settings /
// re-run the login for the modify scopes).
export async function exportSetlistToSpotify(setlist, songs, { existingPlaylistId = '', onProgress } = {}) {
  const { uris, skipped, duplicates, guessCount } = collectSetlistTrackUris(setlist, songs);
  if (!uris.length) {
    throw new Error('No song on this setlist has a Spotify track link yet — run auto-link, or the library tools\' spotify quick-link.');
  }

  const token = await getSpotifyUserToken();
  if (!token) {
    const e = new Error(isSpotifyConnected()
      ? 'The saved Spotify session could not refresh — disconnect and reconnect in Settings → spotify account.'
      : 'Building a playlist needs your Spotify account — connect it in Settings → spotify account.');
    e.needsConnect = true;
    throw e;
  }
  if (!hasSpotifyScope('playlist-modify-private')) {
    const e = new Error('The connected Spotify session predates playlist building, so it can\'t create playlists yet — reconnect to grant it.');
    e.needsReauth = true;
    throw e;
  }

  const name = exportPlaylistName(setlist);
  const description = exportPlaylistDescription(setlist);
  let playlistId = existingPlaylistId;
  let created = false;
  let url = playlistId ? `https://open.spotify.com/playlist/${playlistId}` : '';

  if (playlistId) {
    onProgress?.('updating the exported playlist…');
    try {
      await writeContents(token, playlistId, 'PUT', { uris: uris.slice(0, 100) });
      for (let i = 100; i < uris.length; i += 100) {
        onProgress?.(`adding tracks ${Math.min(i + 100, uris.length)}/${uris.length}…`);
        await writeContents(token, playlistId, 'POST', { uris: uris.slice(i, i + 100) });
      }
      // Keep the playlist's name/description following the setlist —
      // best-effort, the contents are the point.
      try { await spotifyCall(token, 'PUT', `/playlists/${playlistId}`, { name, description }); } catch {}
    } catch (e) {
      if (e.status !== 404) throw e;
      playlistId = '';
    }
  }

  if (!playlistId) {
    onProgress?.('creating the playlist…');
    const me = await spotifyCall(token, 'GET', '/me');
    const pl = await spotifyCall(token, 'POST', `/users/${encodeURIComponent(me.id)}/playlists`, {
      name, description, public: false,
    });
    playlistId = pl.id;
    created = true;
    url = pl?.external_urls?.spotify || `https://open.spotify.com/playlist/${playlistId}`;
    for (let i = 0; i < uris.length; i += 100) {
      onProgress?.(`adding tracks ${Math.min(i + 100, uris.length)}/${uris.length}…`);
      await writeContents(token, playlistId, 'POST', { uris: uris.slice(i, i + 100) });
    }
  }

  return { playlistId, url, name, created, trackCount: uris.length, skipped, duplicates, guessCount };
}
